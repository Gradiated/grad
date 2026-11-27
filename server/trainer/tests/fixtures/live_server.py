"""Start the shared live stack (tests/harness/stack.ts, no worker, AUTH_MODE=none) for live worker tests."""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import unittest
import urllib.request
from pathlib import Path
from typing import Any

API_DIR = Path(__file__).resolve().parents[3] / "api"
TSX_BIN = API_DIR / "node_modules" / ".bin" / "tsx"
STACK = API_DIR.parents[1] / "tests" / "harness" / "stack.ts"


def http(
    url: str,
    method: str = "GET",
    payload: Any = None,
    *,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, bytes, dict[str, str]]:
    hdrs = dict(headers or {})
    if payload is not None:
        data = json.dumps(payload).encode()
        hdrs["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=hdrs, method=method)
    with urllib.request.urlopen(req, timeout=30) as resp:
        return resp.status, resp.read(), dict(resp.headers)


def http_json(url: str, method: str = "GET", payload: Any = None) -> Any:
    return json.loads(http(url, method, payload)[1])


class LiveServer:
    """A grad-server on its own Postgres; ``base`` is its URL and ``dir`` a scratch directory."""

    def __init__(self, case: unittest.TestCase, *extra_args: str) -> None:
        if not TSX_BIN.exists():
            case.skipTest("server/api node_modules not installed")
        tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        case.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.log_path = self.dir / "server.log"
        with self.log_path.open("wb") as log:
            self.proc = subprocess.Popen(
                [str(TSX_BIN), str(STACK), "--auth", "none", "--worker", "none", *extra_args],
                cwd=str(API_DIR),
                env={**os.environ, "EVAL_EXECUTOR": "false"},
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=log,
            )
        case.addCleanup(self.proc.stdout.close)  # type: ignore[union-attr]
        case.addCleanup(self.proc.wait, 30)
        case.addCleanup(self.proc.stdin.close)  # type: ignore[union-attr]
        line = self.proc.stdout.readline()  # type: ignore[union-attr]
        if not line:
            raise RuntimeError(f"live stack failed to start:\n{self.log_tail()}")
        self.info: dict[str, Any] = json.loads(line)
        self.base: str = self.info["base_url"]

    def log_tail(self, chars: int = 4000) -> str:
        return self.log_path.read_text(errors="replace")[-chars:]
