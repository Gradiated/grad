"""Test doubles: a scripted fake HTTP transport, a fake clock and wire fixtures.

``FakeSender`` is an ``httpx`` transport, so every test exercises the real request policy
(auth headers, retries, redirects, error mapping) and httpx itself, without sockets.
"""

from __future__ import annotations

import io
import json
import sys
import urllib.parse
from collections.abc import Callable, Iterator
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import httpx

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from grad import Grad  # noqa: E402
from grad._transport import Clock  # noqa: E402

WIRE = HERE.parents[2] / "tests" / "fixtures" / "wire"


def fixture(name: str) -> Any:
    """Load ``tests/fixtures/wire/<name>`` (JSON, or text for ``.sse``)."""
    path = WIRE / name
    text = path.read_text(encoding="utf-8")
    return text if path.suffix == ".sse" else json.loads(text)


class FakeClock(Clock):
    """Deterministic time: ``sleep`` advances ``now`` and is recorded."""

    def __init__(self) -> None:
        self.now = 1000.0
        self.sleeps: list[float] = []
        super().__init__(monotonic=lambda: self.now, sleep=self._sleep, random=lambda: 0.5)

    def _sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


@dataclass
class Reply:
    """A scripted response. ``chunks`` streams a body; ``error`` raises mid-body."""

    status: int = 200
    body: Any = None
    headers: dict[str, str] = field(default_factory=dict)
    chunks: list[bytes] | None = None
    error: BaseException | None = None

    def payload(self) -> bytes:
        if self.chunks is not None:
            return b"".join(self.chunks)
        if isinstance(self.body, bytes):
            return self.body
        if isinstance(self.body, str):
            return self.body.encode()
        if self.body is None:
            return b""
        return json.dumps(self.body).encode()

    def all_headers(self) -> dict[str, str]:
        out = {k.lower(): v for k, v in self.headers.items()}
        if "content-type" not in out and self.body is not None and not isinstance(self.body, (bytes, str)):
            out["content-type"] = "application/json" if self.status < 400 else "application/problem+json"
        return out


def json_reply(body: Any, status: int = 200, **headers: str) -> Reply:
    """A JSON response."""
    return Reply(status=status, body=body, headers=dict(headers))


def problem(status: int, code: str, detail: str = "boom", **headers: str) -> Reply:
    """A problem+json error response."""
    body = {"type": f"https://gradiated.com/problems/{code}", "title": code.replace("_", " "), "status": status, "detail": detail, "code": code, "request_id": "req_body"}
    return Reply(status=status, body=body, headers={"content-type": "application/problem+json", "x-request-id": "req_hdr", **headers})


def fixture_reply(name: str) -> Reply:
    """Replay a captured response (``python-problem-*.json`` hold status/headers/body)."""
    data = fixture(name)
    if isinstance(data, dict) and {"status", "body", "headers"} <= set(data):
        return Reply(status=data["status"], body=data["body"], headers=dict(data["headers"]))
    return json_reply(data)


class _Body(httpx.SyncByteStream):
    """A response body that yields ``chunks`` and then (optionally) fails mid-stream."""

    def __init__(self, chunks: list[bytes], error: BaseException | None) -> None:
        self.chunks = chunks
        self.error = error
        self.closed = False

    def __iter__(self) -> Iterator[bytes]:
        for chunk in self.chunks:
            if chunk:
                yield chunk
        if isinstance(self.error, httpx.TransportError):
            raise self.error
        if self.error is not None:  # a socket error mid-body, as httpx reports it
            raise httpx.ReadError(f"{type(self.error).__name__}: {self.error}")

    def close(self) -> None:
        self.closed = True


@dataclass
class Sent:
    """A request the fake received (body decoded)."""

    method: str
    url: str
    headers: dict[str, str]
    body: bytes | None

    @property
    def path(self) -> str:
        return urllib.parse.urlsplit(self.url).path

    @property
    def query(self) -> dict[str, list[str]]:
        return urllib.parse.parse_qs(urllib.parse.urlsplit(self.url).query)

    @property
    def json(self) -> Any:
        return json.loads(self.body) if self.body else None

    def header(self, name: str) -> str | None:
        for k, v in self.headers.items():
            if k.lower() == name.lower():
                return v
        return None


Handler = Callable[[Sent], "Reply | BaseException"]


class FakeSender(httpx.BaseTransport):
    """Answers requests from routes (``"GET /v1/runs/x"`` -> replies, used in order) or a handler."""

    # Every fake is finite: a client that keeps requesting past this is looping, so fail the test.
    MAX_REQUESTS = 2000

    def __init__(self, routes: dict[str, Any] | None = None, handler: Handler | None = None) -> None:
        self.routes: dict[str, list[Any]] = {}
        for key, value in (routes or {}).items():
            self.add(key, value)
        self.handler = handler
        self.sent: list[Sent] = []
        self.bodies: list[_Body] = []
        self.closed = False

    def add(self, key: str, value: Any) -> None:
        """Queue replies for ``"METHOD /path"`` (a list queues several; the last repeats)."""
        items = value if isinstance(value, list) else [value]
        self.routes.setdefault(key, []).extend(items)

    def handle_request(self, request: httpx.Request) -> httpx.Response:
        if len(self.sent) >= self.MAX_REQUESTS:
            raise AssertionError(f"client sent more than {self.MAX_REQUESTS} requests (last: {request.method} {request.url}); it is looping")
        body = request.read()
        sent = Sent(request.method, str(request.url), dict(request.headers), body or None)
        self.sent.append(sent)
        if self.handler is not None:
            outcome = self.handler(sent)
        else:
            key = f"{request.method} {sent.path}"
            queue = self.routes.get(key)
            if not queue:
                raise AssertionError(f"unexpected request {key} (known: {sorted(self.routes)})")
            outcome = queue.pop(0) if len(queue) > 1 else queue[0]
            if callable(outcome) and not isinstance(outcome, Reply):
                outcome = outcome(sent)
        if isinstance(outcome, BaseException):
            if isinstance(outcome, httpx.RequestError):
                outcome.request = request
            raise outcome
        reply = outcome if isinstance(outcome, Reply) else json_reply(outcome)
        stream = _Body(list(reply.chunks) if reply.chunks is not None else [reply.payload()], reply.error)
        self.bodies.append(stream)
        return httpx.Response(reply.status, headers=reply.all_headers(), stream=stream, request=request)

    def close(self) -> None:
        self.closed = True

    def paths(self) -> list[str]:
        return [f"{s.method} {s.path}" for s in self.sent]


BASE = "https://api.test"


def make_client(routes: dict[str, Any] | None = None, *, handler: Handler | None = None, **kwargs: Any) -> tuple[Grad, FakeSender, FakeClock]:
    """A ``Grad`` wired to a fake sender and clock."""
    sender = FakeSender(routes, handler)
    clock = FakeClock()
    kwargs.setdefault("api_key", "grad_test_key")
    kwargs.setdefault("base_url", BASE)
    client = Grad(_http_transport=sender, _clock=clock, _env={}, **kwargs)
    return client, sender, clock


def refused() -> httpx.ConnectError:
    """A connect failure (the request was never sent)."""
    return httpx.ConnectError("[Errno 111] Connection refused")


def reset(phase: str = "receive") -> httpx.TransportError:
    """A failure after (part of) the request was sent."""
    return httpx.WriteError("[Errno 104] Connection reset by peer") if phase == "send" else httpx.ReadError("[Errno 104] Connection reset by peer")


def timed_out() -> httpx.ReadTimeout:
    """A read timeout."""
    return httpx.ReadTimeout("timed out")


def bundle_bytes(files: dict[str, bytes], *, manifest_extra: dict[str, Any] | None = None, raw_entries: list[Any] | None = None) -> bytes:
    """Build a ``.grad.tar.gz`` like the trainer does (manifest with per-file SHA-256)."""
    import hashlib
    import tarfile

    manifest = {"schema": "grad.artifact/1", "files": {n: hashlib.sha256(b).hexdigest() for n, b in files.items()}, **(manifest_extra or {})}
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tf:
        entries = {"manifest.json": json.dumps(manifest).encode(), **files}
        for name, content in sorted(entries.items()):
            info = tarfile.TarInfo(name)
            info.size = len(content)
            tf.addfile(info, io.BytesIO(content))
        for entry in raw_entries or []:
            info, content = entry
            tf.addfile(info, io.BytesIO(content) if content is not None else None)
    return buf.getvalue()
