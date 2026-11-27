#!/usr/bin/env python3
"""Load test for source syncs: a busy fake Langfuse synced into a dataset on the real stack.

    GRAD_TRAINER_PYTHON=/path/to/python scripts/load/sources.py \\
        [--rate 300] [--duration 600] [--score-every 10] [--version-interval 300] [--json out.json]

It starts tests/harness/stack.ts (grad-server, a reference trainer worker, SeaweedFS) on its
own ``gradr8-load-pg-<pid>`` Postgres, plus a fake Langfuse that generates ``--rate`` traces a
second for ``--duration`` seconds (about 1 KB of conversation each) and a score for every
``--score-every``-th trace that arrives ``--score-delay`` (30-120) s after it. A source syncs it every minute
(``* * * * *``). Every 5 s it samples the sync lag (the provider's newest trace minus the
synced trace watermark) and the server's and worker's CPU and RSS. At the end it syncs once
more by hand once the last scores have arrived (which commits the waiting parts), then reports S3 objects and bytes, the
Postgres rows added (dataset parts, job events, usage, jobs), the versions made, the time to
read the latest version, and checks that every trace and score landed exactly once.

``--check`` exits non-zero unless the lag after each sync stayed under the sync interval and
nothing was lost or duplicated (sdks/python/tests/test_live_sources_load.py runs a 30 s version
in CI).
"""

from __future__ import annotations

import argparse
import bisect
import json
import math
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO / "sdks" / "python" / "tests"))
from _stack import Stack  # noqa: E402

SECRET = "pk-lf-load:sk-lf-load-0123456789"
WORDS = ("invoice billing refund account export month download plan seat upgrade card receipt "
         "tax address team admin usage limit quota error retry support ticket order").split()


def text(i: int, n: int = 80) -> str:
    """About 500 bytes of words that vary with ``i`` (so parts compress like real chats)."""
    return " ".join(WORDS[(i * 2654435761 + k * 40503) % 7919 % len(WORDS)] for k in range(n))


def iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def epoch(value: str | None) -> float | None:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() if value else None


class FakeLangfuse:
    """Traces ``i`` start at ``t0 + i / rate``; trace ``i`` with ``i % score_every == 0`` gets a
    score 30-120 s later. Everything is computed from the index, so nothing is stored."""

    def __init__(self, rate: float, duration: float, score_every: int, delay: tuple[float, float] = (30, 120)) -> None:
        self.rate, self.total = rate, int(rate * duration)
        self.t0 = time.time()
        self.score_every = score_every
        spread = int(delay[1] - delay[0]) + 1
        scores = [(self.t0 + i / rate + delay[0] + (i * 7919) % spread, i) for i in range(0, self.total, score_every)]
        scores.sort()
        self.score_at = [s for s, _ in scores]
        self.score_trace = [i for _, i in scores]
        self.requests = 0
        handler = self._handler()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def available(self, now: float | None = None) -> int:
        """Traces started by ``now``."""
        return min(self.total, max(0, math.floor(((now or time.time()) - self.t0) * self.rate) + 1))

    def newest(self) -> float:
        return self.t0 + (self.available() - 1) / self.rate

    def scores_due(self, now: float | None = None) -> int:
        return bisect.bisect_right(self.score_at, now or time.time())

    def trace(self, i: int) -> dict[str, Any]:
        at = iso(self.t0 + i / self.rate)
        return {
            "id": f"obs-{i}", "traceId": f"tr-{i}", "startTime": at, "endTime": at, "type": "SPAN",
            "name": "answer", "traceName": "answer", "environment": "production", "version": "v1",
            "userId": f"user-{i % 97}", "sessionId": f"sess-{i // 4}", "isRootObservation": True,
            "input": json.dumps([{"role": "user", "content": f"Where is invoice #{i}? {text(i)}"}]),
            "output": json.dumps({"role": "assistant", "content": f"Invoice #{i}: {text(i + 1)}"}),
            "metadata": {"model": "acme/support"}, "tags": ["prod"], "release": "support@1",
        }  # fmt: skip

    def score(self, k: int) -> dict[str, Any]:
        i, at = self.score_trace[k], iso(self.score_at[k])
        return {
            "id": f"score-{i}", "name": "resolved", "dataType": "NUMERIC", "value": float(i % 3 == 0),
            "timestamp": at, "createdAt": at, "updatedAt": at, "subject": {"kind": "trace", "id": f"tr-{i}"},
        }  # fmt: skip

    def _handler(self) -> type[BaseHTTPRequestHandler]:
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_: Any) -> None:
                pass

            def do_GET(self) -> None:  # noqa: N802
                fake.requests += 1
                url = urllib.parse.urlsplit(self.path)
                q = {k: v[0] for k, v in urllib.parse.parse_qs(url.query).items()}
                limit, cursor = int(q.get("limit", 50)), int(q.get("cursor") or 0)
                now = time.time()
                if url.path == "/api/public/v2/observations":
                    lo = max(0, math.ceil(((epoch(q.get("fromStartTime")) or fake.t0) - fake.t0) * fake.rate))
                    hi = fake.available(now)
                    if q.get("toStartTime"):
                        hi = min(hi, math.ceil((epoch(q["toStartTime"]) - fake.t0) * fake.rate))  # type: ignore[operator]
                    start = max(lo, cursor)
                    rows = [fake.trace(i) for i in range(start, min(hi, start + limit))]
                    nxt = start + limit
                elif url.path == "/api/public/v3/scores":
                    lo = bisect.bisect_left(fake.score_at, epoch(q.get("fromTimestamp")) or 0)
                    hi = fake.scores_due(now)
                    start = max(lo, cursor)
                    rows = [fake.score(k) for k in range(start, min(hi, start + min(limit, 100)))]
                    nxt = start + min(limit, 100)
                else:
                    self.send_response(404)
                    self.end_headers()
                    return
                body = json.dumps({"data": rows, "meta": {"limit": limit, **({"cursor": str(nxt)} if nxt < hi else {})}}).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        return Handler


class Api:
    def __init__(self, base: str, key: str) -> None:
        self.base, self.key = base, key

    def call(self, path: str, body: Any = None, method: str | None = None) -> Any:
        data = None if body is None else json.dumps(body).encode()
        req = urllib.request.Request(f"{self.base}{path}", data=data, method=method or ("POST" if data else "GET"))
        req.add_header("Authorization", f"Bearer {self.key}")
        if data:
            req.add_header("Content-Type", "application/json")
        with urllib.request.urlopen(req, timeout=120) as resp:
            raw = resp.read()
            return json.loads(raw) if raw else None


class Postgres:
    """A throwaway Postgres 17 container the stack uses (``--database-url``), so we can count rows."""

    def __init__(self) -> None:
        self.name = f"gradr8-load-pg-{os.getpid()}"
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True)
        subprocess.run(
            ["docker", "run", "-d", "--name", self.name, "-e", "POSTGRES_PASSWORD=grad", "-e", "POSTGRES_DB=grad",
             "-p", "127.0.0.1::5432", "postgres:17-alpine"],
            check=True, capture_output=True,
        )  # fmt: skip
        port = subprocess.run(["docker", "port", self.name, "5432/tcp"], check=True, capture_output=True, text=True).stdout
        self.url = f"postgres://postgres:grad@127.0.0.1:{port.strip().rsplit(':', 1)[-1]}/grad"
        for _ in range(120):
            if subprocess.run(["docker", "exec", self.name, "pg_isready", "-U", "postgres"], capture_output=True).returncode == 0:
                time.sleep(1)
                return
            time.sleep(0.5)
        raise RuntimeError("postgres did not start")

    def query(self, sql: str) -> list[list[str]]:
        out = subprocess.run(
            ["docker", "exec", self.name, "psql", "-U", "postgres", "-d", "grad", "-At", "-F", "\t", "-c", sql],
            check=True, capture_output=True, text=True,
        ).stdout  # fmt: skip
        return [line.split("\t") for line in out.splitlines() if line]

    def counts(self) -> dict[str, int]:
        tables = ("grad_dataset_parts", "grad_job_events", "grad_usage", "grad_jobs")
        rows = self.query(" UNION ALL ".join(f"SELECT '{t}', count(*) FROM {t}" for t in tables))
        return {t: int(n) for t, n in rows}

    def close(self) -> None:
        subprocess.run(["docker", "rm", "-f", self.name], capture_output=True)


def proc_stats(pid: int) -> tuple[float, int]:
    """(CPU seconds, RSS bytes) of ``pid``."""
    fields = Path(f"/proc/{pid}/stat").read_text().rsplit(")", 1)[1].split()
    ticks = os.sysconf("SC_CLK_TCK")
    cpu = (int(fields[11]) + int(fields[12])) / ticks
    rss = next(int(line.split()[1]) * 1024 for line in Path(f"/proc/{pid}/status").read_text().splitlines() if line.startswith("VmRSS:"))
    return cpu, rss


def descendant_pid(root: int, needle: str) -> int | None:
    """The first process under ``root`` whose command line contains ``needle``."""
    children: dict[int, list[int]] = {}
    commands: dict[int, str] = {}
    for stat in Path("/proc").glob("[0-9]*/stat"):
        try:
            ppid = int(stat.read_text().rsplit(")", 1)[1].split()[1])
            commands[int(stat.parent.name)] = (stat.parent / "cmdline").read_bytes().replace(b"\0", b" ").decode(errors="replace")
        except (OSError, ValueError, IndexError):
            continue
        children.setdefault(ppid, []).append(int(stat.parent.name))
    todo = list(children.get(root, []))
    while todo:
        pid = todo.pop(0)
        if needle in commands.get(pid, ""):
            return pid
        todo += children.get(pid, [])
    return None


def s3_usage(s3: dict[str, str]) -> tuple[int, int] | None:
    """(objects, bytes) in the stack's bucket, or None without the aws CLI."""
    if not shutil.which("aws"):
        return None
    env = {**os.environ, "AWS_ACCESS_KEY_ID": s3["accessKeyId"], "AWS_SECRET_ACCESS_KEY": s3["secretAccessKey"], "AWS_DEFAULT_REGION": s3["region"]}
    out = subprocess.run(
        ["aws", "s3", "ls", f"s3://{s3['bucket']}", "--recursive", "--summarize", "--endpoint-url", s3["endpoint"]],
        capture_output=True, text=True, env=env, check=True,
    ).stdout  # fmt: skip
    objects = next((int(line.split(":")[1]) for line in out.splitlines() if "Total Objects" in line), 0)
    size = next((int(line.split(":")[1]) for line in out.splitlines() if "Total Size" in line), 0)
    return objects, size


def run(args: argparse.Namespace) -> dict[str, Any]:
    pg = Postgres()
    env_keys = {
        # Langfuse Pro's limit (the class default is Hobby's 30 requests a minute).
        "GRAD_SOURCES_LANGFUSE_REQUESTS_PER_MINUTE": "1000",
    }
    old = {k: os.environ.get(k) for k in env_keys}
    os.environ.update(env_keys)
    stack = None
    try:
        stack = Stack(worker="reference", database_url=pg.url)
        api = Api(stack.base_url, stack.api_key)
        before = pg.counts()
        s3_before = s3_usage(stack.info["s3"])
        server_pid = int(stack.info["replicas"][0]["pid"])
        worker_pid = descendant_pid(stack.proc.pid, "grad_trainer.worker")
        assert worker_pid, "no trainer worker"
        cpu0 = {"api": proc_stats(server_pid)[0], "worker": proc_stats(worker_pid)[0]}

        fake = FakeLangfuse(args.rate, args.duration, args.score_every, tuple(args.score_delay))
        api.call("/v1/secrets", {"name": "lf-load", "value": SECRET, "allowed_hosts": [fake.url]})
        source = api.call(
            "/v1/datasets/load/sources",
            {
                "provider": {"kind": "langfuse", "host": fake.url, "secret": "lf-load"},
                "schedule": None if args.manual_every else "* * * * *",
                "version_interval": args.version_interval,
            },
        )
        samples: list[float] = []  # sync lag every sample
        lag_after: list[float] = []  # sync lag when a sync stored a new watermark
        rss = {"api": 0, "worker": 0}
        prev_wm, last_manual = None, 0.0
        end = fake.t0 + args.duration
        # Keep syncing until the last scores have arrived, then sync once more by hand.
        settle = end + args.score_delay[1] + 5
        while time.time() < settle:
            now = time.time()
            if args.manual_every and now - last_manual >= args.manual_every:
                api.call(f"/v1/sources/{source['id']}/sync", {})
                last_manual = now
            rows = pg.query(f"SELECT watermark->>'traces' FROM grad_sources WHERE id = '{source['id']}' AND watermark IS NOT NULL")
            wm = epoch(rows[0][0]) if rows and rows[0] and rows[0][0] else None
            if wm is not None:
                lag = max(0.0, fake.newest() - wm)
                if now <= end:
                    samples.append(lag)
                if wm != prev_wm and now <= end + args.sample_every:
                    lag_after.append(lag)
                prev_wm = wm
            for name, pid in (("api", server_pid), ("worker", worker_pid)):
                rss[name] = max(rss[name], proc_stats(pid)[1])
            time.sleep(args.sample_every)

        t_wait = time.time()
        while True:
            job = api.call(f"/v1/sources/{source['id']}/sync", {})
            if epoch(job["created_at"]) >= settle:  # type: ignore[operator]
                break
            time.sleep(2)
        while job["status"] in ("queued", "running"):
            time.sleep(1)
            job = api.call(f"/v1/imports/{job['id']}")
        final_sync_s = time.time() - t_wait
        cpu = {"api": proc_stats(server_pid)[0] - cpu0["api"], "worker": proc_stats(worker_pid)[0] - cpu0["worker"]}

        dataset = api.call("/v1/datasets/load")
        started = time.time()
        ids: set[str] = set()
        dupes = scored = 0
        cursor = None
        while True:
            page = api.call("/v1/datasets/load/records?limit=1000" + (f"&cursor={urllib.parse.quote(cursor)}" if cursor else ""))
            for record in page["data"]:
                dupes += record["id"] in ids
                ids.add(record["id"])
                scored += bool(record.get("scores"))
            cursor = page.get("next_cursor")
            if not cursor:
                break
        read_s = time.time() - started
        after = pg.counts()
        s3_after = s3_usage(stack.info["s3"])
        jobs = dict(pg.query("SELECT status, count(*) FROM grad_jobs WHERE kind = 'import' GROUP BY status"))
        lag_after.sort()
        report = {
            "rate": args.rate,
            "duration_s": args.duration,
            "traces_generated": fake.available(end),
            "scores_generated": fake.scores_due(),
            "provider_requests": fake.requests,
            "syncs": sum(int(n) for n in jobs.values()),
            "failed_syncs": sum(int(n) for st, n in jobs.items() if st != "completed"),
            "dataset_versions": dataset["version"],
            "records_read": len(ids),
            "duplicates": dupes,
            "records_with_scores": scored,
            "lag_after_sync_s": {
                "max": round(lag_after[-1], 1) if lag_after else None,
                "median": round(lag_after[len(lag_after) // 2], 1) if lag_after else None,
            },
            "lag_max_s": round(max(samples), 1) if samples else None,
            "final_sync_s": round(final_sync_s, 1),
            "cpu_s": {k: round(v, 1) for k, v in cpu.items()},
            "rss_max_mb": {k: round(v / 2**20) for k, v in rss.items()},
            "s3_objects_added": s3_after[0] - s3_before[0] if s3_after and s3_before else None,
            "s3_bytes_added": s3_after[1] - s3_before[1] if s3_after and s3_before else None,
            "pg_rows_added": {k: after[k] - before.get(k, 0) for k in after},
            "read_latest_version_s": round(read_s, 2),
        }
        return report
    finally:
        if stack is not None:
            stack.close()
        pg.close()
        for k, v in old.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--rate", type=float, default=300.0, help="traces per second")
    parser.add_argument("--duration", type=float, default=600.0, help="seconds of traffic")
    parser.add_argument("--score-every", type=int, default=10)
    parser.add_argument("--score-delay", type=float, nargs=2, default=(30.0, 120.0), metavar=("MIN", "MAX"), help="seconds after its trace a score arrives")
    parser.add_argument("--version-interval", type=int, default=300)
    parser.add_argument("--sample-every", type=float, default=5.0)
    parser.add_argument("--manual-every", type=float, default=0.0, help="sync by hand every N s instead of the schedule")
    parser.add_argument("--sync-interval", type=float, default=60.0, help="what --check holds the lag after a sync to")
    parser.add_argument("--json", type=Path, help="write the report here too")
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    report = run(args)
    text = json.dumps(report, indent=2)
    print(text)
    if args.json:
        args.json.write_text(text + "\n")
    if args.check:
        problems = []
        if report["failed_syncs"]:
            problems.append(f"{report['failed_syncs']} syncs failed")
        if report["records_read"] != report["traces_generated"] or report["duplicates"]:
            problems.append(f"read {report['records_read']} records ({report['duplicates']} duplicates) of {report['traces_generated']}")
        if report["records_with_scores"] != report["scores_generated"]:
            problems.append(f"{report['records_with_scores']} scored records of {report['scores_generated']} scores")
        lag = report["lag_after_sync_s"]["max"]
        if lag is not None and lag >= args.sync_interval:
            problems.append(f"lag after a sync reached {lag}s (interval {args.sync_interval}s)")
        if problems:
            print("FAIL: " + "; ".join(problems), file=sys.stderr)
            return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
