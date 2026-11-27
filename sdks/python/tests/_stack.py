"""Starts tests/harness/stack.ts (the shared live stack) for the live integration tests.

Live tests skip cleanly when ``server/api/node_modules`` is missing (run
``pnpm -C server/api install --frozen-lockfile`` once) or ``GRAD_SKIP_LIVE=1`` is set.
"""

from __future__ import annotations

import json
import os
import select
import subprocess
import time
from pathlib import Path
from typing import Any

REPO = Path(__file__).resolve().parents[3]
API_DIR = REPO / "server" / "api"
TSX = API_DIR / "node_modules" / ".bin" / "tsx"
HARNESS = REPO / "tests" / "harness" / "stack.ts"


def live_skip_reason(worker: str = "none") -> str | None:
    """Why live tests cannot run here, or ``None``."""
    if os.environ.get("GRAD_SKIP_LIVE") == "1":
        return "GRAD_SKIP_LIVE=1"
    if not TSX.exists():
        return f"{TSX} missing (run `pnpm -C server/api install --frozen-lockfile`)"
    if not HARNESS.exists():
        return f"{HARNESS} missing"
    if worker == "torch":
        python = os.environ.get("GRAD_TRAINER_PYTHON")
        if not python or not Path(python).exists():
            return "GRAD_TRAINER_PYTHON (a Python with torch, transformers and peft) is not set"
    return None


class Stack:
    """A running harness stack; ``info`` is its JSON line (base_url, api_key, ...)."""

    def __init__(self, *, cloud: bool = False, worker: str = "none", auth: str = "api_key", timeout: float = 240.0) -> None:
        args = [str(TSX), str(HARNESS), "--worker", worker, "--auth", auth]
        if cloud:
            args.append("--cloud")
        env = dict(os.environ)
        env.setdefault("TMPDIR", os.environ.get("TMPDIR", "/tmp"))
        self.log_path = Path(env["TMPDIR"]) / f"grad-py-stack-{os.getpid()}-{int(time.time() * 1000)}.log"
        self._log = open(self.log_path, "wb")
        self.proc = subprocess.Popen(
            args,
            cwd=API_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=self._log,
            env=env,
        )
        self.info: dict[str, Any] = self._read_info(timeout)

    def _read_info(self, timeout: float) -> dict[str, Any]:
        assert self.proc.stdout is not None
        deadline = time.monotonic() + timeout
        buf = b""
        while time.monotonic() < deadline:
            if self.proc.poll() is not None:
                break
            ready, _, _ = select.select([self.proc.stdout], [], [], 0.5)
            if ready:
                chunk = os.read(self.proc.stdout.fileno(), 65536)
                if not chunk:
                    break
                buf += chunk
                if b"\n" in buf:
                    return json.loads(buf.split(b"\n", 1)[0])
        self.close()
        raise RuntimeError(f"live stack did not start; log: {self.log_path}\n{self.log_path.read_text(errors='replace')[-3000:]}")

    @property
    def base_url(self) -> str:
        """grad-server URL."""
        return str(self.info["base_url"])

    @property
    def api_key(self) -> str:
        """Admin API key."""
        return str(self.info["api_key"])

    def close(self) -> None:
        """Stop the stack (closing stdin makes the harness tear everything down)."""
        if self.proc.poll() is None:
            try:
                assert self.proc.stdin is not None
                self.proc.stdin.close()
            except OSError:
                pass
            try:
                self.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.proc.terminate()
                try:
                    self.proc.wait(timeout=15)
                except subprocess.TimeoutExpired:
                    self.proc.kill()
        self._log.close()
