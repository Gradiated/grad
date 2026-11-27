"""Stdlib HTTP/1.1 connection pools: a blocking one (``http.client``) and an asyncio one.

This layer only moves bytes: it never follows redirects, never retries and never
interprets status codes. :mod:`grad._transport` adds those policies on top. Failures
are reported as :class:`TransportFailure` with the phase they happened in, so the
retry policy can tell "never sent" (safe to retry any method) from "maybe processed".

Both pools keep connections alive and drop idle ones after ``idle_timeout`` seconds,
which is below the 5 s keep-alive timeout of Node's HTTP server (grad-server), so a
pooled connection is never reused just as the server closes it. ``HTTP(S)_PROXY`` /
``NO_PROXY`` are honoured (CONNECT tunnels for HTTPS).
"""

from __future__ import annotations

import asyncio
import base64
import http.client
import socket
import ssl
import threading
import time
import urllib.parse
import urllib.request
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from typing import IO, Any, Callable, Literal, Protocol

Phase = Literal["connect", "send", "receive"]

_CHUNK = 64 * 1024
_MAX_LINE = 64 * 1024
_MAX_HEADERS = 200


class TransportFailure(Exception):
    """A network-level failure. ``phase`` says how far the request got."""

    def __init__(self, cause: BaseException, *, phase: Phase, reused: bool = False) -> None:
        super().__init__(f"{type(cause).__name__}: {cause}" if str(cause) else type(cause).__name__)
        self.cause = cause
        self.phase = phase
        self.reused = reused
        self.timeout = isinstance(cause, (TimeoutError, socket.timeout, asyncio.TimeoutError))


@dataclass
class Request:
    """One HTTP request. ``body`` is bytes or a binary file object of ``body_length`` bytes."""

    method: str
    url: str
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes | IO[bytes] | None = None
    body_length: int | None = None


def _origin(url: str) -> tuple[str, str, int]:
    parts = urllib.parse.urlsplit(url)
    scheme = parts.scheme.lower()
    port = parts.port or (443 if scheme == "https" else 80)
    return scheme, (parts.hostname or "").lower(), port


def same_origin(a: str, b: str) -> bool:
    """True when two absolute URLs share scheme, host and port."""
    return _origin(a) == _origin(b)


def _target(url: str) -> str:
    parts = urllib.parse.urlsplit(url)
    path = parts.path or "/"
    return f"{path}?{parts.query}" if parts.query else path


def _host_header(url: str) -> str:
    scheme, host, port = _origin(url)
    shown = f"[{host}]" if ":" in host else host
    return shown if port == (443 if scheme == "https" else 80) else f"{shown}:{port}"


@dataclass(frozen=True)
class _Proxy:
    host: str
    port: int
    auth: str | None


def _proxy_for(url: str, proxies: dict[str, str] | None) -> _Proxy | None:
    scheme, host, _ = _origin(url)
    table = urllib.request.getproxies() if proxies is None else proxies
    raw = table.get(scheme)
    if not raw:
        return None
    if proxies is None and urllib.request.proxy_bypass(host):
        return None
    if "://" not in raw:
        raw = f"http://{raw}"
    parts = urllib.parse.urlsplit(raw)
    if not parts.hostname:
        return None
    auth = None
    if parts.username:
        user = urllib.parse.unquote(parts.username)
        password = urllib.parse.unquote(parts.password or "")
        auth = "Basic " + base64.b64encode(f"{user}:{password}".encode()).decode()
    return _Proxy(parts.hostname, parts.port or 8080, auth)


def _merge_headers(items: list[tuple[str, str]]) -> dict[str, str]:
    out: dict[str, str] = {}
    for key, value in items:
        lower = key.lower()
        out[lower] = f"{out[lower]}, {value}" if lower in out else value
    return out


# --------------------------------------------------------------------------------------
# Blocking pool (http.client)
# --------------------------------------------------------------------------------------


class Response:
    """A blocking response. Read it fully or call :meth:`close`; usable as a context manager."""

    def __init__(
        self,
        status: int,
        reason: str,
        headers: dict[str, str],
        raw: Any,
        release: Callable[[bool], None] | None = None,
        url: str = "",
    ) -> None:
        self.status = status
        self.reason = reason
        self.headers = headers
        self.url = url
        self._raw = raw
        self._release = release
        self._done = False

    def read(self) -> bytes:
        """Read the whole body and release the connection."""
        try:
            data = self._raw.read() if self._raw is not None else b""
        except (OSError, http.client.HTTPException) as exc:
            self._finish(reusable=False)
            raise TransportFailure(exc, phase="receive") from exc
        self._finish(reusable=True)
        return bytes(data)

    def iter_bytes(self, chunk_size: int = _CHUNK) -> Iterator[bytes]:
        """Yield the body in chunks; the connection is released at the end."""
        try:
            while True:
                try:
                    chunk = self._raw.read1(chunk_size) if self._raw is not None else b""
                except (OSError, http.client.HTTPException) as exc:
                    raise TransportFailure(exc, phase="receive") from exc
                if not chunk:
                    self._finish(reusable=True)
                    return
                yield bytes(chunk)
        finally:
            if not self._done:
                self._finish(reusable=False)

    def iter_lines(self) -> Iterator[str]:
        """Yield decoded lines (``\\n``, ``\\r\\n`` or ``\\r`` terminated) as they arrive."""
        splitter = LineSplitter()
        for chunk in self.iter_bytes(4096):
            yield from splitter.feed(chunk)
        yield from splitter.flush()

    def close(self) -> None:
        """Abandon the body; the connection is closed rather than reused."""
        if not self._done:
            self._finish(reusable=False)

    def _finish(self, *, reusable: bool) -> None:
        if self._done:
            return
        self._done = True
        if self._release is not None:
            self._release(reusable)

    def __enter__(self) -> Response:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class SyncSender(Protocol):
    """What :class:`grad._transport.SyncTransport` needs from an HTTP layer (fakes in tests)."""

    def send(self, request: Request, *, timeout: float) -> Response: ...

    def close(self) -> None: ...


@dataclass
class _Idle:
    conn: http.client.HTTPConnection
    since: float


class ConnectionPool:
    """Thread-safe keep-alive pool of ``http.client`` connections keyed by origin."""

    def __init__(
        self,
        *,
        ssl_context: ssl.SSLContext | None = None,
        proxies: dict[str, str] | None = None,
        max_idle_per_origin: int = 8,
        idle_timeout: float = 4.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ssl = ssl_context or ssl.create_default_context()
        self._proxies = proxies
        self._max_idle = max_idle_per_origin
        self._idle_timeout = idle_timeout
        self._clock = clock
        self._lock = threading.Lock()
        self._idle: dict[tuple[str, str, int], list[_Idle]] = {}
        self._closed = False

    def _new_connection(self, url: str, timeout: float) -> http.client.HTTPConnection:
        scheme, host, port = _origin(url)
        proxy = _proxy_for(url, self._proxies)
        conn: http.client.HTTPConnection
        if scheme == "https":
            if proxy:
                conn = http.client.HTTPSConnection(proxy.host, proxy.port, timeout=timeout, context=self._ssl)
                conn.set_tunnel(host, port, headers={"Proxy-Authorization": proxy.auth} if proxy.auth else None)
            else:
                conn = http.client.HTTPSConnection(host, port, timeout=timeout, context=self._ssl)
        else:
            conn = http.client.HTTPConnection(proxy.host if proxy else host, proxy.port if proxy else port, timeout=timeout)
        conn._grad_proxy = proxy  # type: ignore[attr-defined]
        return conn

    def _acquire(self, url: str, timeout: float) -> tuple[http.client.HTTPConnection, bool]:
        key = _origin(url)
        now = self._clock()
        with self._lock:
            idle = self._idle.get(key, [])
            while idle:
                entry = idle.pop()
                if now - entry.since <= self._idle_timeout and entry.conn.sock is not None:
                    return entry.conn, True
                entry.conn.close()
        return self._new_connection(url, timeout), False

    def _release(self, url: str, conn: http.client.HTTPConnection, reusable: bool) -> None:
        if not reusable or self._closed:
            conn.close()
            return
        key = _origin(url)
        with self._lock:
            idle = self._idle.setdefault(key, [])
            if len(idle) >= self._max_idle:
                conn.close()
                return
            idle.append(_Idle(conn, self._clock()))

    def send(self, request: Request, *, timeout: float) -> Response:
        """Send ``request`` and return the response once its headers arrived."""
        conn, reused = self._acquire(request.url, timeout)
        proxy = getattr(conn, "_grad_proxy", None)
        absolute = proxy is not None and request.url.lower().startswith("http://")
        headers = dict(request.headers)
        headers.setdefault("Host", _host_header(request.url))
        if absolute and proxy is not None and proxy.auth:
            headers["Proxy-Authorization"] = proxy.auth
        body = request.body
        if body is not None and "Content-Length" not in headers:
            headers["Content-Length"] = str(len(body) if isinstance(body, (bytes, bytearray)) else request.body_length or 0)
        try:
            conn.timeout = timeout
            if conn.sock is None:
                conn.connect()
            else:
                conn.sock.settimeout(timeout)
        except (OSError, http.client.HTTPException) as exc:
            conn.close()
            raise TransportFailure(exc, phase="connect", reused=reused) from exc
        try:
            conn.putrequest(
                request.method,
                request.url if absolute else _target(request.url),
                skip_host=True,
                skip_accept_encoding=True,
            )
            for key, value in headers.items():
                conn.putheader(key, value)
            conn.endheaders()
            if isinstance(body, (bytes, bytearray)):
                conn.send(bytes(body))
            elif body is not None:
                while True:
                    block = body.read(_CHUNK)
                    if not block:
                        break
                    conn.send(block)
        except (OSError, http.client.HTTPException) as exc:
            conn.close()
            raise TransportFailure(exc, phase="send", reused=reused) from exc
        try:
            raw = conn.getresponse()
        except (OSError, http.client.HTTPException) as exc:
            conn.close()
            raise TransportFailure(exc, phase="receive", reused=reused) from exc

        def release(reusable: bool) -> None:
            self._release(request.url, conn, reusable and not raw.will_close)

        return Response(
            raw.status,
            raw.reason,
            _merge_headers(list(raw.getheaders())),
            raw,
            release,
            request.url,
        )

    def close(self) -> None:
        """Close every idle connection; in-flight responses close on release."""
        with self._lock:
            self._closed = True
            for idle in self._idle.values():
                for entry in idle:
                    entry.conn.close()
            self._idle.clear()


# --------------------------------------------------------------------------------------
# asyncio pool
# --------------------------------------------------------------------------------------


class LineSplitter:
    """Incremental splitter for ``\\n``, ``\\r\\n`` and ``\\r`` line endings (SSE framing)."""

    def __init__(self) -> None:
        self._buf = b""
        self._pending_cr = False

    def feed(self, chunk: bytes) -> list[str]:
        """Add bytes; return the complete lines they finish."""
        data = self._buf + chunk
        if self._pending_cr and data.startswith(b"\n"):
            data = data[1:]
        self._pending_cr = False
        lines: list[str] = []
        start = 0
        i = 0
        n = len(data)
        while i < n:
            ch = data[i]
            if ch == 0x0A or ch == 0x0D:
                lines.append(data[start:i].decode("utf-8", errors="replace"))
                if ch == 0x0D:
                    if i + 1 < n and data[i + 1] == 0x0A:
                        i += 1
                    elif i + 1 == n:
                        self._pending_cr = True
                start = i + 1
            i += 1
        self._buf = data[start:]
        if len(self._buf) > 16 * 1024 * 1024:
            raise ValueError("Line longer than 16 MiB in event stream.")
        return lines

    def flush(self) -> list[str]:
        """Return the trailing unterminated line, if any."""
        rest, self._buf = self._buf, b""
        return [rest.decode("utf-8", errors="replace")] if rest else []


class _AsyncConn:
    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter, proxy: _Proxy | None) -> None:
        self.reader = reader
        self.writer = writer
        self.proxy = proxy
        self.since = 0.0

    def close(self) -> None:
        try:
            self.writer.close()
        except Exception:  # pragma: no cover - best effort on already-broken transports
            pass

    @property
    def alive(self) -> bool:
        return not self.writer.is_closing() and not self.reader.at_eof()


class AsyncResponse:
    """An asyncio response. Read it fully or call :meth:`aclose`; usable with ``async with``."""

    def __init__(
        self,
        status: int,
        reason: str,
        headers: dict[str, str],
        conn: _AsyncConn | None,
        *,
        framing: tuple[str, int],
        timeout: float,
        release: Callable[[bool], None] | None = None,
        url: str = "",
        body: bytes | None = None,
    ) -> None:
        self.status = status
        self.reason = reason
        self.headers = headers
        self.url = url
        self._conn = conn
        self._framing = framing
        self._timeout = timeout
        self._release = release
        self._done = False
        self._preloaded = body

    async def _read_some(self, n: int) -> bytes:
        assert self._conn is not None
        return await asyncio.wait_for(self._conn.reader.read(n), self._timeout)

    async def _chunks(self, chunk_size: int) -> AsyncIterator[bytes]:
        if self._preloaded is not None:
            if self._preloaded:
                yield self._preloaded
            return
        kind, remaining = self._framing
        if kind == "none":
            return
        if kind == "length":
            while remaining > 0:
                data = await self._read_some(min(chunk_size, remaining))
                if not data:
                    raise ConnectionError("Connection closed before the full body was received.")
                remaining -= len(data)
                yield data
            return
        if kind == "chunked":
            assert self._conn is not None
            reader = self._conn.reader
            while True:
                size_line = await asyncio.wait_for(reader.readline(), self._timeout)
                if not size_line:
                    raise ConnectionError("Connection closed inside a chunked body.")
                size = int(size_line.split(b";", 1)[0].strip() or b"0", 16)
                if size == 0:
                    while True:  # trailers
                        trailer = await asyncio.wait_for(reader.readline(), self._timeout)
                        if trailer in (b"\r\n", b"\n", b""):
                            return
                left = size
                while left > 0:
                    data = await self._read_some(min(chunk_size, left))
                    if not data:
                        raise ConnectionError("Connection closed inside a chunk.")
                    left -= len(data)
                    yield data
                await asyncio.wait_for(reader.readexactly(2), self._timeout)
        # read until EOF
        while True:
            data = await self._read_some(chunk_size)
            if not data:
                return
            yield data

    async def aiter_bytes(self, chunk_size: int = _CHUNK) -> AsyncIterator[bytes]:
        """Yield the body in chunks; the connection is released at the end."""
        try:
            async for chunk in self._chunks(chunk_size):
                yield chunk
            self._finish(reusable=self._framing[0] != "eof")
        except (OSError, asyncio.TimeoutError, asyncio.IncompleteReadError, ValueError) as exc:
            self._finish(reusable=False)
            raise TransportFailure(exc, phase="receive") from exc
        finally:
            if not self._done:
                self._finish(reusable=False)

    async def read(self) -> bytes:
        """Read the whole body and release the connection."""
        parts = [chunk async for chunk in self.aiter_bytes()]
        return b"".join(parts)

    async def aiter_lines(self) -> AsyncIterator[str]:
        """Yield decoded lines as they arrive (for Server-Sent Events)."""
        splitter = LineSplitter()
        async for chunk in self.aiter_bytes(4096):
            for line in splitter.feed(chunk):
                yield line
        for line in splitter.flush():
            yield line

    async def aclose(self) -> None:
        """Abandon the body; the connection is closed rather than reused."""
        if not self._done:
            self._finish(reusable=False)

    def _finish(self, *, reusable: bool) -> None:
        if self._done:
            return
        self._done = True
        if self._release is not None:
            self._release(reusable)

    async def __aenter__(self) -> AsyncResponse:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()


class AsyncSender(Protocol):
    """What :class:`grad._transport.AsyncTransport` needs from an HTTP layer (fakes in tests)."""

    async def send(self, request: Request, *, timeout: float) -> AsyncResponse: ...

    async def aclose(self) -> None: ...


async def _read_head(reader: asyncio.StreamReader, timeout: float) -> tuple[int, str, dict[str, str]]:
    while True:
        line = await asyncio.wait_for(reader.readline(), timeout)
        if not line:
            raise ConnectionError("Server closed the connection without a response.")
        if len(line) > _MAX_LINE:
            raise ValueError("Status line too long.")
        parts = line.decode("latin-1").rstrip("\r\n").split(" ", 2)
        if len(parts) < 2 or not parts[0].startswith("HTTP/"):
            raise ValueError(f"Malformed status line: {line[:80]!r}")
        status = int(parts[1])
        reason = parts[2] if len(parts) > 2 else ""
        items: list[tuple[str, str]] = []
        while True:
            hline = await asyncio.wait_for(reader.readline(), timeout)
            if hline in (b"\r\n", b"\n"):
                break
            if not hline:
                raise ConnectionError("Connection closed inside response headers.")
            if len(hline) > _MAX_LINE or len(items) >= _MAX_HEADERS:
                raise ValueError("Response headers too large.")
            name, _, value = hline.decode("latin-1").partition(":")
            items.append((name.strip(), value.strip()))
        if 100 <= status < 200 and status != 101:
            continue  # skip 100 Continue / 103 Early Hints
        return status, reason, _merge_headers(items)


class AsyncConnectionPool:
    """Keep-alive pool of asyncio stream connections keyed by origin (one per event loop)."""

    def __init__(
        self,
        *,
        ssl_context: ssl.SSLContext | None = None,
        proxies: dict[str, str] | None = None,
        max_idle_per_origin: int = 8,
        idle_timeout: float = 4.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ssl = ssl_context or ssl.create_default_context()
        self._proxies = proxies
        self._max_idle = max_idle_per_origin
        self._idle_timeout = idle_timeout
        self._clock = clock
        self._idle: dict[tuple[str, str, int], list[_AsyncConn]] = {}
        self._closed = False

    async def _open(self, url: str, timeout: float) -> _AsyncConn:
        scheme, host, port = _origin(url)
        proxy = _proxy_for(url, self._proxies)
        if proxy is None:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port, ssl=self._ssl if scheme == "https" else None),
                timeout,
            )
            return _AsyncConn(reader, writer, None)
        reader, writer = await asyncio.wait_for(asyncio.open_connection(proxy.host, proxy.port), timeout)
        if scheme == "http":
            return _AsyncConn(reader, writer, proxy)
        connect = f"CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n"
        if proxy.auth:
            connect += f"Proxy-Authorization: {proxy.auth}\r\n"
        writer.write((connect + "\r\n").encode("latin-1"))
        await writer.drain()
        status, _, _ = await _read_head(reader, timeout)
        if status != 200:
            writer.close()
            raise ConnectionError(f"Proxy refused CONNECT {host}:{port} with HTTP {status}.")
        await asyncio.wait_for(writer.start_tls(self._ssl, server_hostname=host), timeout)
        return _AsyncConn(reader, writer, None)

    def _acquire_idle(self, url: str) -> _AsyncConn | None:
        now = self._clock()
        idle = self._idle.get(_origin(url), [])
        while idle:
            conn = idle.pop()
            if now - conn.since <= self._idle_timeout and conn.alive:
                return conn
            conn.close()
        return None

    def _release(self, url: str, conn: _AsyncConn, reusable: bool) -> None:
        if not reusable or self._closed:
            conn.close()
            return
        idle = self._idle.setdefault(_origin(url), [])
        if len(idle) >= self._max_idle:
            conn.close()
            return
        conn.since = self._clock()
        idle.append(conn)

    async def send(self, request: Request, *, timeout: float) -> AsyncResponse:
        """Send ``request`` and return the response once its headers arrived."""
        conn = self._acquire_idle(request.url)
        reused = conn is not None
        if conn is None:
            try:
                conn = await self._open(request.url, timeout)
            except (OSError, asyncio.TimeoutError, ValueError, ssl.SSLError) as exc:
                raise TransportFailure(exc, phase="connect") from exc
        absolute = conn.proxy is not None
        headers = dict(request.headers)
        headers.setdefault("Host", _host_header(request.url))
        if absolute and conn.proxy is not None and conn.proxy.auth:
            headers["Proxy-Authorization"] = conn.proxy.auth
        body = request.body
        if body is not None and "Content-Length" not in headers:
            headers["Content-Length"] = str(len(body) if isinstance(body, (bytes, bytearray)) else request.body_length or 0)
        target = request.url if absolute else _target(request.url)
        head = f"{request.method} {target} HTTP/1.1\r\n" + "".join(f"{k}: {v}\r\n" for k, v in headers.items()) + "\r\n"
        try:
            conn.writer.write(head.encode("latin-1"))
            if isinstance(body, (bytes, bytearray)):
                conn.writer.write(bytes(body))
            elif body is not None:
                while True:
                    block = await asyncio.to_thread(body.read, _CHUNK)
                    if not block:
                        break
                    conn.writer.write(block)
                    await asyncio.wait_for(conn.writer.drain(), timeout)
            await asyncio.wait_for(conn.writer.drain(), timeout)
        except (OSError, asyncio.TimeoutError) as exc:
            conn.close()
            raise TransportFailure(exc, phase="send", reused=reused) from exc
        try:
            status, reason, resp_headers = await _read_head(conn.reader, timeout)
        except (OSError, asyncio.TimeoutError, ValueError, asyncio.IncompleteReadError) as exc:
            conn.close()
            raise TransportFailure(exc, phase="receive", reused=reused) from exc

        framing: tuple[str, int]
        if request.method == "HEAD" or status in (204, 304):
            framing = ("none", 0)
        elif "chunked" in resp_headers.get("transfer-encoding", "").lower():
            framing = ("chunked", 0)
        elif "content-length" in resp_headers:
            try:
                framing = ("length", int(resp_headers["content-length"]))
            except ValueError:
                conn.close()
                raise TransportFailure(ValueError("Invalid Content-Length header."), phase="receive") from None
        else:
            framing = ("eof", 0)
        keep = "close" not in resp_headers.get("connection", "").lower() and framing[0] != "eof"
        final = conn

        def release(reusable: bool) -> None:
            self._release(request.url, final, reusable and keep)

        return AsyncResponse(
            status,
            reason,
            resp_headers,
            conn,
            framing=framing,
            timeout=timeout,
            release=release,
            url=request.url,
        )

    async def aclose(self) -> None:
        """Close every idle connection."""
        self._closed = True
        for idle in self._idle.values():
            for conn in idle:
                conn.close()
        self._idle.clear()
