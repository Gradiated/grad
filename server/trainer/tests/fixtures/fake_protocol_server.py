"""In-process fake of the grad-server trainer-job protocol for worker tests."""

from __future__ import annotations

import json
import re
import threading
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

PROTOCOL = "grad.trainer-protocol/1"
JOB_RE = re.compile(r"^/v1/trainer-jobs/([^/]+)/([a-z]+)$")


@dataclass
class Recorded:
    method: str
    path: str
    headers: dict[str, str]
    body: bytes

    def json(self) -> Any:
        return json.loads(self.body) if self.body else None


@dataclass
class FakeProtocolServer:
    """Scriptable fake. ``jobs`` are handed out by claim in order; every request
    is recorded. Knobs: ``fail_next[action]`` status codes returned before a
    real answer (0: close the connection without a response, as when the ack
    of a committed request is lost), ``progress_reply`` / ``heartbeat_reply`` callables, ``api_key``
    (401 when the bearer differs), ``upload_origin`` (absolute ticket URLs on
    another server), ``blobs`` served on GET, ``redirect_claim_to``."""

    api_key: str | None = None
    jobs: list[dict[str, Any]] = field(default_factory=list)
    blobs: dict[str, bytes] = field(default_factory=dict)
    fail_next: dict[str, list[int]] = field(default_factory=dict)
    progress_reply: Callable[[int], dict[str, Any]] | None = None
    heartbeat_reply: Callable[[int], tuple[int, dict[str, Any]]] | None = None
    checkpoint_status: int = 201
    upload_origin: str | None = None
    redirect_claim_to: str | None = None
    requests: list[Recorded] = field(default_factory=list)
    uploads: dict[str, bytes] = field(default_factory=dict)

    def __post_init__(self) -> None:
        self._lock = threading.Lock()
        self._uploads_issued = 0
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                return

            def _send(
                self,
                status: int,
                payload: Any = None,
                raw: bytes | None = None,
                headers: dict[str, str] | None = None,
            ) -> None:
                body = (
                    raw
                    if raw is not None
                    else (b"" if payload is None else json.dumps(payload).encode())
                )
                self.send_response(status)
                ctype = (
                    "application/octet-stream"
                    if raw is not None
                    else (
                        "application/problem+json"
                        if status >= 400
                        else "application/json"
                    )
                )
                self.send_header("Content-Type", ctype)
                self.send_header("Content-Length", str(len(body)))
                for k, v in (headers or {}).items():
                    self.send_header(k, v)
                self.end_headers()
                self.wfile.write(body)

            def _handle(self) -> None:
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                rec = Recorded(
                    self.command,
                    self.path,
                    {k.lower(): v for k, v in self.headers.items()},
                    body,
                )
                with server._lock:
                    server.requests.append(rec)
                status, payload, raw, headers = server.dispatch(rec)
                if status == 0:
                    self.close_connection = True
                    return
                self._send(status, payload, raw, headers)

            do_GET = do_POST = do_PUT = _handle

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.base_url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self) -> "FakeProtocolServer":
        self._thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    # -- helpers for assertions ------------------------------------------------

    def calls(self, action: str) -> list[Recorded]:
        out = []
        for r in self.requests:
            m = JOB_RE.match(r.path.split("?")[0])
            name = m.group(2) if m else r.path.split("?")[0].rsplit("/", 1)[-1]
            if name == action:
                out.append(r)
        return out

    def bodies(self, action: str) -> list[Any]:
        return [r.json() for r in self.calls(action) if r.method == "POST"]

    # -- routing -------------------------------------------------------------------

    def _problem(self, status: int, code: str) -> tuple[int, Any, None, None]:
        return (
            status,
            {
                "type": "about:blank",
                "title": code,
                "status": status,
                "detail": code,
                "code": code,
                "request_id": "req_test",
            },
            None,
            None,
        )

    def dispatch(
        self, rec: Recorded
    ) -> tuple[int, Any, bytes | None, dict[str, str] | None]:
        path = rec.path.split("?")[0]
        if rec.method == "GET":
            if path in self.blobs:
                return 200, None, self.blobs[path], None
            return self._problem(404, "not_found")
        if rec.method == "PUT" and path.startswith("/blobs/uploads/"):
            upload_id = path.rsplit("/", 1)[-1]
            if int(rec.headers.get("content-length", "-1")) != len(rec.body):
                return self._problem(400, "bad_length")
            self.uploads[upload_id] = rec.body
            return 200, {"ok": True}, None, None

        if (
            self.api_key is not None
            and rec.headers.get("authorization") != f"Bearer {self.api_key}"
        ):
            return self._problem(401, "unauthorized")

        if path == "/v1/trainer-jobs/claim":
            action, job_id = "claim", None
        else:
            m = JOB_RE.match(path)
            if not m:
                return self._problem(404, "route_not_found")
            job_id, action = m.group(1), m.group(2)

        pending = self.fail_next.get(action)
        if pending:
            status = pending.pop(0)
            return (0, None, None, None) if status == 0 else self._problem(status, "injected")

        if action == "claim":
            if self.redirect_claim_to:
                return 302, None, b"", {"Location": self.redirect_claim_to}
            job = self.jobs.pop(0) if self.jobs else None
            return 200, {"protocol": PROTOCOL, "job": job}, None, None
        if action == "heartbeat":
            n = len(self.calls("heartbeat"))
            if self.heartbeat_reply:
                status, payload = self.heartbeat_reply(n)
                if status >= 400:
                    return self._problem(status, "lease_lost")
                return status, payload, None, None
            return (
                200,
                {
                    "status": "running",
                    "should_stop": False,
                    "stop_reason": None,
                    "lease_expires_at": "2026-11-27T12:00:00Z",
                },
                None,
                None,
            )
        if action == "progress":
            n = len(self.calls("progress"))
            reply = self.progress_reply(n) if self.progress_reply else {}
            return (
                200,
                {
                    "status": "running",
                    "should_stop": False,
                    "stop_reason": None,
                    "cost_usd": 0,
                    **reply,
                },
                None,
                None,
            )
        if action == "uploads":
            self._uploads_issued += 1
            upload_id = f"upl_{self._uploads_issued}"
            url = f"/blobs/uploads/{upload_id}?exp=1&sig=x"
            if self.upload_origin:
                url = f"{self.upload_origin}{url}"
            return (
                201,
                {
                    "upload_id": upload_id,
                    "method": "PUT",
                    "url": url,
                    "headers": {"x-amz-checksum-sha256": "abc"},
                    "expires_at": "2026-11-27T13:00:00Z",
                },
                None,
                None,
            )
        if action == "checkpoints":
            if self.checkpoint_status >= 400:
                return self._problem(self.checkpoint_status, "checkpoint_conflict")
            return 201, {"id": "ckpt_1"}, None, None
        if action == "records":
            records = (rec.json() or {}).get("records", [])
            return (
                200,
                {"accepted": len(records), "rejected": 0, "errors": []},
                None,
                None,
            )
        if action == "complete":
            body = rec.json() or {}
            return (
                200,
                {
                    "job_id": job_id,
                    "kind": "train",
                    "status": body.get("status"),
                    "run": None,
                    "artifact": None,
                    "import": None,
                },
                None,
                None,
            )
        return self._problem(404, "route_not_found")
