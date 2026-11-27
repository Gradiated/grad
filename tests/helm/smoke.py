"""Checks for tests/helm/smoke.sh against an installed grad chart (stdlib only).

1. The API is ready behind its Service and the migrations Job ran once.
2. A reference-backend `train` worker claims and completes a run, the `import`
   worker never claims it, and force-deleting both API pods mid-run (one at a
   time) neither fails the run nor costs it an attempt.
3. The worker NetworkPolicy lets workers reach S3 but not the database.
"""

from __future__ import annotations

import argparse
import json
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def kubectl(*args: str, ns: str) -> str:
    return subprocess.run(["kubectl", "-n", ns, *args], check=True, capture_output=True, text=True).stdout


class Api:
    """HTTP over `kubectl port-forward svc/...`, reconnecting when its pod dies."""

    def __init__(self, ns: str, service: str, key: str) -> None:
        self.ns, self.service, self.key = ns, service, key
        self.proc: subprocess.Popen[bytes] | None = None
        self.port = 0

    def _forward(self) -> None:
        self.close()
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            self.port = s.getsockname()[1]
        self.proc = subprocess.Popen(
            ["kubectl", "-n", self.ns, "port-forward", f"svc/{self.service}", f"{self.port}:8787"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )
        time.sleep(1.5)

    def close(self) -> None:
        if self.proc is not None:
            self.proc.terminate()
            self.proc.wait()
            self.proc = None

    def call(self, method: str, path: str, body: object | None = None, *, timeout: float = 120) -> dict:
        deadline = time.monotonic() + timeout
        while True:
            if self.proc is None or self.proc.poll() is not None:
                self._forward()
            req = urllib.request.Request(
                f"http://127.0.0.1:{self.port}{path}",
                method=method,
                data=None if body is None else json.dumps(body).encode(),
                headers={"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"},
            )
            try:
                with urllib.request.urlopen(req, timeout=10) as resp:
                    return json.loads(resp.read() or b"{}")
            except urllib.error.HTTPError as exc:
                if exc.code < 500:
                    raise SystemExit(f"{method} {path}: HTTP {exc.code} {exc.read().decode()[:500]}")
                err: Exception = exc
            except (urllib.error.URLError, ConnectionError, TimeoutError) as exc:
                err = exc
            if time.monotonic() > deadline:
                raise SystemExit(f"{method} {path}: {err}")
            self._forward()


def check(cond: bool, what: str) -> None:
    if not cond:
        raise SystemExit(f"FAIL: {what}")
    print(f"ok: {what}")


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--namespace", required=True)
    p.add_argument("--release", required=True)
    p.add_argument("--admin-key", required=True)
    a = p.parse_args()
    ns, full = a.namespace, f"{a.release}-grad"

    api = Api(ns, f"{full}-api", a.admin_key)
    try:
        check(api.call("GET", "/health/ready").get("status") == "ready", "API ready behind its Service")

        expected = len(list((ROOT / "server/api/migrations").glob("[0-9][0-9][0-9][0-9]_*.sql")))
        rows = kubectl("exec", "deploy/postgres", "--", "psql", "-U", "grad", "-d", "grad", "-tAc",
                       "SELECT count(*) FROM grad_schema_migrations", ns=ns).strip()
        check(rows == str(expected), f"migrations Job applied all {expected} migrations")
        env = json.loads(kubectl("get", "deploy", f"{full}-api", "-o",
                                 "jsonpath={.spec.template.spec.containers[0].env}", ns=ns))
        check({"name": "MIGRATE_ON_BOOT", "value": "false"} in env, "API replicas do not migrate at boot")

        records = [
            {"messages": [{"role": "user", "content": f"q{i}"}, {"role": "assistant", "content": f"a{i}"}]}
            for i in range(200)
        ]
        api.call("POST", "/v1/datasets/kind-smoke/records", {"records": records})
        run = api.call("POST", "/v1/runs", {
            "dataset": "kind-smoke", "name": "kind-smoke",
            "recipe": {"kind": "sft", "model": "qwen/qwen3-0.6b", "batch_size": 1, "epochs": 3},
        })
        rid = run["id"]

        deadline = time.monotonic() + 180
        while (run := api.call("GET", f"/v1/runs/{rid}"))["status"] == "queued" or not run.get("current_step"):
            if time.monotonic() > deadline or run["status"] not in ("queued", "running"):
                raise SystemExit(f"FAIL: run did not start: {run['status']} {run.get('error')}")
            time.sleep(0.5)
        check(run["status"] == "running", f"train worker claimed {rid} (step {run['current_step']})")

        pods = kubectl("get", "pods", "-l", "app.kubernetes.io/component=api", "-o", "name", ns=ns).split()
        check(len(pods) == 2, "two API replicas")
        for pod in pods:
            kubectl("delete", pod, "--grace-period=0", "--force", "--wait=false", ns=ns)
            step = api.call("GET", f"/v1/runs/{rid}")["current_step"]
            print(f"  killed {pod} at step {step}")
            subprocess.run(["kubectl", "-n", ns, "rollout", "status", f"deploy/{full}-api", "--timeout=180s"],
                           check=True, stdout=subprocess.DEVNULL)

        deadline = time.monotonic() + 600
        while (run := api.call("GET", f"/v1/runs/{rid}"))["status"] in ("queued", "running"):
            if time.monotonic() > deadline:
                raise SystemExit("FAIL: run did not finish within 10 minutes")
            time.sleep(1)
        check(run["status"] == "completed", f"run completed after both API pods were killed ({run.get('error')})")
        check(run["attempt"] == 1, "on its first attempt (the lease survived)")
        check(bool(run["artifact_id"]), f"artifact {run['artifact_id']} exported to S3")

        train_logs = kubectl("logs", f"deploy/{full}-worker-train", ns=ns)
        import_logs = kubectl("logs", f"deploy/{full}-worker-import", ns=ns)
        check(rid in train_logs and "(train)" in train_logs, "the train worker ran it")
        check(rid not in import_logs and "(import)" in import_logs, "the import worker (kinds: import) never claimed it")

        probe = ("import socket,sys\ntry: socket.create_connection((sys.argv[1], int(sys.argv[2])), timeout=3).close(); print('open')\n"
                 "except OSError: print('blocked')")
        reach = {t: kubectl("exec", f"deploy/{full}-worker-import", "--", "python", "-c", probe, *t.split(":"), ns=ns).strip()
                 for t in ("postgres:5432", "seaweedfs:8333")}
        check(reach == {"postgres:5432": "blocked", "seaweedfs:8333": "open"}, f"worker NetworkPolicy egress allowlist {reach}")
    finally:
        api.close()


if __name__ == "__main__":
    sys.exit(main())
