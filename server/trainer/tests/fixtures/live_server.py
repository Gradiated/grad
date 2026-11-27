"""Start a real server/api process (in-memory store, local storage) for live worker tests."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path
from typing import Any

API_DIR = Path(__file__).resolve().parents[3] / "api"
TSX_BIN = API_DIR / "node_modules" / ".bin" / "tsx"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


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
    """A grad-server child process; ``base`` is its URL. Use as a context manager or via ``start``."""

    def __init__(self, case: unittest.TestCase, extra_models: list[dict[str, Any]], **env: str) -> None:
        if not TSX_BIN.exists():
            case.skipTest("server/api node_modules not installed")
        tmp = tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR"))
        case.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)
        self.log_path = self.dir / "server.log"
        port = free_port()
        self.base = f"http://127.0.0.1:{port}"
        full_env = {
            **os.environ,
            "PORT": str(port),
            "HOST": "127.0.0.1",
            "AUTH_MODE": "none",
            "DEPLOY_MODE": "disabled",
            "STORAGE_DIR": str(self.dir / "storage"),
            "GRAD_EXTRA_MODELS_JSON": json.dumps(extra_models),
            "EVAL_EXECUTOR": "false",
            **env,
        }
        with self.log_path.open("wb") as log:
            self.proc = subprocess.Popen(
                [str(TSX_BIN), "src/main.ts"],
                cwd=str(API_DIR),
                env=full_env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )
        case.addCleanup(self.proc.wait, 10)
        case.addCleanup(self.proc.terminate)
        self._wait_ready()

    def log_tail(self, chars: int = 4000) -> str:
        return self.log_path.read_text(errors="replace")[-chars:]

    def _wait_ready(self) -> None:
        deadline = time.time() + 30
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError(f"grad-server exited during startup:\n{self.log_tail()}")
            try:
                if http(f"{self.base}/health/ready")[0] == 200:
                    return
            except Exception:
                time.sleep(0.2)
        raise RuntimeError(f"grad-server did not become ready:\n{self.log_tail()}")
