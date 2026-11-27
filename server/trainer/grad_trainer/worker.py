"""HTTP trainer worker daemon claiming runs from grad-server."""

from __future__ import annotations

import base64
import json
import os
import signal
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from typing import Any

from .recipes import RunCallbacks, get_recipe_runner


class TrainerHttpClient:
    """Minimal stdlib JSON HTTP client for grad-server trainer job endpoints."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        timeout_s: float = 30.0,
    ) -> None:
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme not in ("http", "https"):
            raise ValueError(
                f"Invalid grad-server URL scheme '{parsed.scheme}'; expected http or https."
            )
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout_s = timeout_s

    def post_json(self, path: str, payload: dict[str, Any]) -> dict[str, Any]:
        body = json.dumps(payload).encode("utf-8")
        headers = {"Content-Type": "application/json"}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(
            f"{self.base_url}{path}",
            data=body,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="replace")[:1000]
            raise RuntimeError(
                f"grad-server POST {path} failed with HTTP {exc.code}: {detail}"
            ) from exc


class TrainerWorker:
    """Claims queued runs from grad-server, executes recipes, and uploads artifacts."""

    def __init__(
        self,
        *,
        server_url: str,
        api_key: str | None = None,
        worker_id: str | None = None,
        lease_seconds: int = 180,
        poll_interval_s: float = 1.0,
    ) -> None:
        self.client = TrainerHttpClient(server_url, api_key=api_key)
        self.worker_id = worker_id or f"trainer-{socket.gethostname()}-{os.getpid()}"
        self.lease_seconds = lease_seconds
        self.poll_interval_s = poll_interval_s
        self._stop = False

    def run_once(self) -> dict[str, Any] | None:
        """Claim and execute at most one run. Returns completion response or None if idle."""
        claimed = self.client.post_json(
            "/v1/trainer-jobs/claim",
            {"worker_id": self.worker_id, "lease_seconds": self.lease_seconds},
        )
        run = claimed.get("run")
        if not run:
            return None

        run_id = str(run["id"])
        records = claimed.get("records") or []
        config = dict(run["resolved_config"])
        max_cost_usd = run.get("max_cost_usd")
        cancelled = False

        def on_step(metric: dict[str, Any]) -> bool:
            nonlocal cancelled
            resp = self.client.post_json(
                f"/v1/trainer-jobs/{run_id}/progress",
                {
                    "worker_id": self.worker_id,
                    "metric": metric,
                    "lease_seconds": self.lease_seconds,
                },
            )
            if resp.get("run", {}).get("status") == "cancelled":
                cancelled = True
            return bool(resp.get("should_stop")) or self._stop

        def on_checkpoint(
            step: int,
            eval_score: float | None,
            payload_bytes: bytes,
            metadata: dict[str, Any],
        ) -> None:
            if cancelled:
                return
            self.client.post_json(
                f"/v1/trainer-jobs/{run_id}/checkpoints",
                {
                    "worker_id": self.worker_id,
                    "step": step,
                    "eval_score": eval_score,
                    "payload_base64": base64.b64encode(payload_bytes).decode("ascii"),
                    "metadata": metadata,
                },
            )

        # Scope try/except strictly to recipe execution so /complete errors never double-POST.
        try:
            runner = get_recipe_runner(str(run["recipe_kind"]))
            output = runner.run(
                config,
                records,
                max_cost_usd=max_cost_usd,
                callbacks=RunCallbacks(on_step=on_step, on_checkpoint=on_checkpoint),
            )
        except Exception as exc:
            if not cancelled:
                try:
                    self.client.post_json(
                        f"/v1/trainer-jobs/{run_id}/complete",
                        {
                            "worker_id": self.worker_id,
                            "status": "failed",
                            "error": str(exc)[:4000],
                        },
                    )
                except Exception:
                    pass
            raise

        if cancelled or output.status == "cancelled":
            return {"run": run, "artifact": None, "cancelled": True}

        return self.client.post_json(
            f"/v1/trainer-jobs/{run_id}/complete",
            {
                "worker_id": self.worker_id,
                "status": output.status,
                "format": output.artifact_format,
                "artifact_base64": base64.b64encode(output.artifact_bytes).decode(
                    "ascii"
                ),
                "manifest": output.manifest,
                "eval_report": output.eval_report,
                "tokens_processed": output.tokens_processed,
                "cost_usd": output.cost_usd,
            },
        )

    def serve_forever(self) -> None:
        def _handle_signal(_signum: int, _frame: Any) -> None:
            self._stop = True

        signal.signal(signal.SIGTERM, _handle_signal)
        signal.signal(signal.SIGINT, _handle_signal)

        while not self._stop:
            try:
                result = self.run_once()
                if result is None:
                    time.sleep(self.poll_interval_s)
            except Exception as exc:
                print(f"[grad-trainer] job error: {exc}", flush=True)
                time.sleep(self.poll_interval_s)


def main() -> None:
    server_url = os.environ.get("GRAD_SERVER_URL", "http://127.0.0.1:8080")
    api_key = os.environ.get("GRAD_API_KEY")
    worker_id = os.environ.get("GRAD_WORKER_ID")
    poll_s = float(os.environ.get("GRAD_POLL_INTERVAL_S", "1.0"))
    worker = TrainerWorker(
        server_url=server_url,
        api_key=api_key,
        worker_id=worker_id,
        poll_interval_s=poll_s,
    )
    print(
        f"[grad-trainer] worker '{worker.worker_id}' polling {server_url}",
        flush=True,
    )
    worker.serve_forever()


if __name__ == "__main__":
    main()
