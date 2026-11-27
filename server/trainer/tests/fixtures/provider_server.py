"""One small fake HTTP server for every provider fixture (tests/fixtures/providers/).

The fixture answers requests from its in-memory traces and scores; the server adds the shared
fault knobs: ``fail_next`` (statuses returned before the fixture sees a request; 429 carries
``Retry-After: 0``) and a 401 when the fixture rejects the credentials. Failure bodies echo the
request's credentials, so a client that logged or raised response bodies would leak them.
"""

from __future__ import annotations

import json
import threading
import urllib.parse
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


@dataclass
class Req:
    method: str
    path: str
    query: dict[str, list[str]]
    headers: dict[str, str]
    body: Any

    def arg(self, name: str, default: str | None = None) -> str | None:
        return (self.query.get(name) or [default])[0]


class FakeProviderServer:
    def __init__(self, fixture: Any) -> None:
        self.fixture = fixture
        self.fail_next: list[int] = []
        self.requests: list[Req] = []
        server = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                pass

            def _handle(self) -> None:
                parts = urllib.parse.urlsplit(self.path)
                length = int(self.headers.get("content-length") or 0)
                raw = self.rfile.read(length) if length else b""
                req = Req(
                    self.command,
                    parts.path,
                    urllib.parse.parse_qs(parts.query),
                    {k.lower(): v for k, v in self.headers.items()},
                    json.loads(raw) if raw else None,
                )
                server.requests.append(req)
                echo = {"error": "no", "you_sent": {k: v for k, v in req.headers.items() if k in ("authorization", "x-api-key")}}
                if server.fail_next:
                    status = server.fail_next.pop(0)
                    self._send(status, echo, {"Retry-After": "0"} if status == 429 else {})
                elif not server.fixture.authorized(req):
                    self._send(401, echo, {})
                else:
                    self._send(*server.fixture.respond(req))

            def _send(self, status: int, body: Any, headers: dict[str, str]) -> None:
                data = json.dumps(body).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                for key, value in headers.items():
                    self.send_header(key, value)
                self.end_headers()
                self.wfile.write(data)

            do_GET = do_POST = _handle

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self.thread = threading.Thread(target=self.httpd.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)

    def __enter__(self) -> "FakeProviderServer":
        self.thread.start()
        return self

    def __exit__(self, *_exc: Any) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def paths(self) -> list[str]:
        return [r.path for r in self.requests]
