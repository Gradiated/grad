"""Request policy shared by every grad-sdk call: auth, retries, redirects and error mapping.

* Retries (``max_retries``, default 2) use exponential backoff with jitter and honour
  ``Retry-After``. GET/HEAD/PUT/DELETE are retried on 408/429/500/502/503/504 and on
  connection failures. POST is retried only on 429 and when the connection failed
  before the request was sent, because the API has no idempotency keys yet and a
  replayed ``POST /v1/runs`` would start (and bill) a second run.
* Redirects: same-origin redirects of GET/HEAD are followed (at most 5). Anything
  else, in particular a redirect to another origin or a scheme downgrade, raises
  :class:`grad.UnexpectedRedirectError` and the credentials are never sent there.
  Non-GET requests are never replayed as GET.
* Every request carries ``User-Agent: grad-python/<version>`` and an
  ``x-request-id`` (kept across retries); errors quote the id the server echoed.
"""

from __future__ import annotations

import asyncio
import json
import random
import time
import urllib.parse
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping
from dataclasses import dataclass
from typing import IO, Any

from ._config import ResolvedConfig
from ._errors import (
    APIConnectionError,
    APITimeoutError,
    GradAPIError,
    InvalidResponseError,
    error_from_response,
    parse_retry_after,
)
from ._http import (
    AsyncConnectionPool,
    AsyncResponse,
    AsyncSender,
    ConnectionPool,
    Request,
    Response,
    SyncSender,
    TransportFailure,
    same_origin,
)
from ._version import __version__

USER_AGENT = f"grad-python/{__version__}"
IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "PUT", "DELETE", "OPTIONS"})
RETRY_STATUSES = frozenset({408, 429, 500, 502, 503, 504})
MAX_REDIRECTS = 5


@dataclass
class Clock:
    """Time source for retries and waits; tests inject a fake one."""

    monotonic: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    random: Callable[[], float] = random.random
    async_sleep: Callable[[float], Awaitable[None]] = asyncio.sleep


@dataclass(frozen=True)
class RetryPolicy:
    """Retry tuning. ``max_retries`` counts retries after the first attempt."""

    max_retries: int = 2
    initial_backoff: float = 0.5
    max_backoff: float = 8.0
    max_retry_after: float = 60.0


def encode_query(query: Mapping[str, Any] | None) -> str:
    """Encode query params: ``None`` dropped, booleans as ``true``/``false``, lists repeated."""
    if not query:
        return ""
    pairs: list[tuple[str, str]] = []
    for key, value in query.items():
        if value is None:
            continue
        values = value if isinstance(value, (list, tuple)) else [value]
        for item in values:
            if isinstance(item, bool):
                pairs.append((key, "true" if item else "false"))
            else:
                pairs.append((key, str(item)))
    return urllib.parse.urlencode(pairs)


def quote_path_param(value: Any, name: str) -> str:
    """Percent-encode one path segment; reject empty, ``.`` and ``..`` values."""
    text = str(value)
    if text in ("", ".", ".."):
        raise ValueError(f"Invalid {name} {value!r}: path parameters must be non-empty and not '.' or '..'.")
    return urllib.parse.quote(text, safe="@")


def _is_json(headers: Mapping[str, str]) -> bool:
    ctype = headers.get("content-type", "")
    return not ctype or "json" in ctype


class _Base:
    def __init__(
        self,
        config: ResolvedConfig,
        *,
        timeout: float,
        retry: RetryPolicy,
        clock: Clock,
        default_headers: Mapping[str, str] | None,
    ) -> None:
        self.config = config
        self.base_url = config.base_url
        self.timeout = timeout
        self.retry = retry
        self.clock = clock
        self._default_headers = dict(default_headers or {})

    def url(self, path: str, query: Mapping[str, Any] | None = None) -> str:
        """Absolute URL for an API path (or pass an absolute URL through)."""
        base = path if path.startswith(("http://", "https://")) else f"{self.base_url}{path}"
        encoded = encode_query(query)
        if not encoded:
            return base
        return f"{base}{'&' if '?' in base else '?'}{encoded}"

    def headers(
        self,
        *,
        accept: str,
        content_type: str | None,
        extra: Mapping[str, str] | None,
        auth: bool,
        request_id: str,
    ) -> dict[str, str]:
        out = {"User-Agent": USER_AGENT, "Accept": accept, "Accept-Encoding": "identity", "x-request-id": request_id}
        out.update(self._default_headers)
        if content_type:
            out["Content-Type"] = content_type
        if auth and self.config.api_key:
            out["Authorization"] = f"Bearer {self.config.api_key}"
        if extra:
            out.update(extra)
        return out

    def should_retry_status(self, method: str, status: int, attempt: int) -> bool:
        if attempt >= self.retry.max_retries or status not in RETRY_STATUSES:
            return False
        return method in IDEMPOTENT_METHODS or status == 429

    def should_retry_failure(self, method: str, failure: TransportFailure, attempt: int, *, replayable: bool) -> bool:
        if attempt >= self.retry.max_retries or not replayable:
            return False
        if failure.phase == "connect":
            return True
        if method in IDEMPOTENT_METHODS:
            return True
        # A pooled keep-alive connection the server had already closed fails while we are
        # still writing: the request never reached the application, so it is safe to resend.
        return failure.reused and failure.phase == "send"

    def backoff(self, attempt: int, retry_after: float | None) -> float:
        if retry_after is not None:
            return min(retry_after, self.retry.max_retry_after)
        base: float = min(self.retry.max_backoff, self.retry.initial_backoff * (2.0**attempt))
        return base * (0.5 + self.clock.random() / 2)

    def connection_error(self, method: str, url: str, failure: TransportFailure) -> APIConnectionError:
        cause = failure.cause
        where = f"{method} {url}"
        if failure.timeout:
            return APITimeoutError(
                f"Request timed out ({where}): no response within the timeout. Pass timeout= to Grad(...) "
                "for slower networks.",
                method=method,
                url=url,
                cause=cause,
            )
        return APIConnectionError(
            f"Cannot reach grad-server at {self.base_url} ({where}): {failure}. Check GRADIATED_BASE_URL "
            "(or Grad(base_url=...)); for a local stack run `grad local up`.",
            method=method,
            url=url,
            cause=cause,
        )

    def api_error(self, method: str, url: str, status: int, headers: Mapping[str, str], body: bytes) -> GradAPIError:
        hint = None
        if status == 401 and not self.config.api_key:
            hint = "No API key was sent: set GRADIATED_API_KEY, pass Grad(api_key=...), or run `grad login`."
        return error_from_response(status=status, headers=headers, body=body, method=method, url=url, hint=hint)

    def redirect_error(self, method: str, url: str, status: int, headers: Mapping[str, str], target: str) -> GradAPIError:
        if not same_origin(url, target):
            why = (
                f"it points to another origin ({target}); the SDK never sends your API key to a different "
                "host or over a downgraded scheme. Set base_url to the final URL."
            )
        else:
            why = f"{method} requests are never replayed on a redirect (to {target}). Set base_url to the final URL."
        body = json.dumps({"code": "unexpected_redirect", "title": "Unexpected redirect", "detail": f"Refusing to follow HTTP {status}: {why}"})
        return error_from_response(status=status, headers=headers, body=body.encode(), method=method, url=url)

    def decode_json(self, method: str, url: str, status: int, headers: Mapping[str, str], body: bytes) -> Any:
        if status in (204, 205) or not body.strip():
            return None
        try:
            return json.loads(body.decode("utf-8"))
        except ValueError:
            snippet = " ".join(body.decode("utf-8", errors="replace").split())[:200]
            raise InvalidResponseError(
                f"Expected JSON from {method} {url} (HTTP {status}, content-type "
                f"{headers.get('content-type', 'unknown')!r}) but got: {snippet!r}. Is base_url pointing at grad-server?",
                method=method,
                url=url,
                status=status,
                request_id=headers.get("x-request-id"),
            ) from None


def _new_request_id() -> str:
    return f"req_{uuid.uuid4().hex}"


class SyncTransport(_Base):
    """Blocking transport used by :class:`grad.Grad`."""

    def __init__(
        self,
        config: ResolvedConfig,
        *,
        timeout: float = 60.0,
        retry: RetryPolicy | None = None,
        clock: Clock | None = None,
        sender: SyncSender | None = None,
        default_headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(config, timeout=timeout, retry=retry or RetryPolicy(), clock=clock or Clock(), default_headers=default_headers)
        self.sender: SyncSender = sender or ConnectionPool()

    def close(self) -> None:
        """Close pooled connections."""
        self.sender.close()

    def _execute(
        self,
        method: str,
        url: str,
        *,
        body: bytes | IO[bytes] | None,
        body_length: int | None,
        headers: dict[str, str],
        timeout: float,
    ) -> Response:
        attempt = 0
        hops = 0
        current = url
        start_pos = body.tell() if body is not None and not isinstance(body, bytes) and body.seekable() else None
        while True:
            if start_pos is not None and body is not None and not isinstance(body, bytes):
                body.seek(start_pos)
            replayable = body is None or isinstance(body, bytes) or start_pos is not None
            try:
                resp = self.sender.send(Request(method, current, headers, body, body_length), timeout=timeout)
            except TransportFailure as failure:
                if self.should_retry_failure(method, failure, attempt, replayable=replayable):
                    self.clock.sleep(self.backoff(attempt, None))
                    attempt += 1
                    continue
                raise self.connection_error(method, current, failure) from failure.cause
            status = resp.status
            if 300 <= status < 400 and status != 304 and "location" in resp.headers:
                target = urllib.parse.urljoin(current, resp.headers["location"])
                resp.close()
                if method in ("GET", "HEAD") and same_origin(current, target) and hops < MAX_REDIRECTS:
                    hops += 1
                    current = target
                    continue
                raise self.redirect_error(method, current, status, resp.headers, target)
            if 200 <= status < 300:
                return resp
            try:
                data = resp.read()
            except TransportFailure:
                data = b""
            if replayable and self.should_retry_status(method, status, attempt):
                self.clock.sleep(self.backoff(attempt, parse_retry_after(resp.headers.get("retry-after"))))
                attempt += 1
                continue
            raise self.api_error(method, current, status, resp.headers, data)

    def request(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        json_body: Any = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> Any:
        """Send a JSON request and return the decoded JSON body (``None`` when empty)."""
        url = self.url(path, query)
        body = None if json_body is None else json.dumps(json_body, separators=(",", ":"), allow_nan=False).encode()
        hdrs = self.headers(
            accept="application/json",
            content_type="application/json" if body is not None else None,
            extra=headers,
            auth=True,
            request_id=_new_request_id(),
        )
        resp = self._execute(method, url, body=body, body_length=None, headers=hdrs, timeout=timeout or self.timeout)
        try:
            data = resp.read()
        except TransportFailure as failure:
            raise self.connection_error(method, url, failure) from failure.cause
        if not _is_json(resp.headers) and data.strip():
            return data
        return self.decode_json(method, url, resp.status, resp.headers, data)

    def stream(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        accept: str = "application/octet-stream",
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> Response:
        """Open a streaming response (2xx only). The caller must read or close it."""
        url = self.url(path, query)
        hdrs = self.headers(accept=accept, content_type=None, extra=headers, auth=True, request_id=_new_request_id())
        return self._execute(method, url, body=None, body_length=None, headers=hdrs, timeout=timeout or self.timeout)

    def upload(
        self,
        url: str,
        fileobj: IO[bytes],
        *,
        length: int,
        headers: Mapping[str, str] | None = None,
        method: str = "PUT",
        timeout: float | None = None,
    ) -> Any:
        """Stream a file to a (pre)signed upload URL. No API key is sent: the URL is the credential."""
        target = self.url(url)
        hdrs = {"User-Agent": USER_AGENT, "Content-Type": "application/octet-stream", "x-request-id": _new_request_id()}
        hdrs.update(dict(headers or {}))
        hdrs["Content-Length"] = str(length)
        resp = self._execute(method, target, body=fileobj, body_length=length, headers=hdrs, timeout=timeout or self.timeout)
        data = resp.read()
        if _is_json(resp.headers) and data.strip():
            try:
                return json.loads(data.decode("utf-8"))
            except ValueError:
                return None
        return None


class AsyncTransport(_Base):
    """asyncio transport used by :class:`grad.AsyncGrad` (no threads for network I/O)."""

    def __init__(
        self,
        config: ResolvedConfig,
        *,
        timeout: float = 60.0,
        retry: RetryPolicy | None = None,
        clock: Clock | None = None,
        sender: AsyncSender | None = None,
        default_headers: Mapping[str, str] | None = None,
    ) -> None:
        super().__init__(config, timeout=timeout, retry=retry or RetryPolicy(), clock=clock or Clock(), default_headers=default_headers)
        self.sender: AsyncSender = sender or AsyncConnectionPool()

    async def aclose(self) -> None:
        """Close pooled connections."""
        await self.sender.aclose()

    async def _execute(
        self,
        method: str,
        url: str,
        *,
        body: bytes | IO[bytes] | None,
        body_length: int | None,
        headers: dict[str, str],
        timeout: float,
    ) -> AsyncResponse:
        attempt = 0
        hops = 0
        current = url
        start_pos = body.tell() if body is not None and not isinstance(body, bytes) and body.seekable() else None
        while True:
            if start_pos is not None and body is not None and not isinstance(body, bytes):
                body.seek(start_pos)
            replayable = body is None or isinstance(body, bytes) or start_pos is not None
            try:
                resp = await self.sender.send(Request(method, current, headers, body, body_length), timeout=timeout)
            except TransportFailure as failure:
                if self.should_retry_failure(method, failure, attempt, replayable=replayable):
                    await self.clock.async_sleep(self.backoff(attempt, None))
                    attempt += 1
                    continue
                raise self.connection_error(method, current, failure) from failure.cause
            status = resp.status
            if 300 <= status < 400 and status != 304 and "location" in resp.headers:
                target = urllib.parse.urljoin(current, resp.headers["location"])
                await resp.aclose()
                if method in ("GET", "HEAD") and same_origin(current, target) and hops < MAX_REDIRECTS:
                    hops += 1
                    current = target
                    continue
                raise self.redirect_error(method, current, status, resp.headers, target)
            if 200 <= status < 300:
                return resp
            try:
                data = await resp.read()
            except TransportFailure:
                data = b""
            if replayable and self.should_retry_status(method, status, attempt):
                await self.clock.async_sleep(self.backoff(attempt, parse_retry_after(resp.headers.get("retry-after"))))
                attempt += 1
                continue
            raise self.api_error(method, current, status, resp.headers, data)

    async def request(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        json_body: Any = None,
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> Any:
        """Send a JSON request and return the decoded JSON body (``None`` when empty)."""
        url = self.url(path, query)
        body = None if json_body is None else json.dumps(json_body, separators=(",", ":"), allow_nan=False).encode()
        hdrs = self.headers(
            accept="application/json",
            content_type="application/json" if body is not None else None,
            extra=headers,
            auth=True,
            request_id=_new_request_id(),
        )
        resp = await self._execute(method, url, body=body, body_length=None, headers=hdrs, timeout=timeout or self.timeout)
        try:
            data = await resp.read()
        except TransportFailure as failure:
            raise self.connection_error(method, url, failure) from failure.cause
        if not _is_json(resp.headers) and data.strip():
            return data
        return self.decode_json(method, url, resp.status, resp.headers, data)

    async def stream(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        accept: str = "application/octet-stream",
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> AsyncResponse:
        """Open a streaming response (2xx only). The caller must read or close it."""
        url = self.url(path, query)
        hdrs = self.headers(accept=accept, content_type=None, extra=headers, auth=True, request_id=_new_request_id())
        return await self._execute(method, url, body=None, body_length=None, headers=hdrs, timeout=timeout or self.timeout)

    async def upload(
        self,
        url: str,
        fileobj: IO[bytes],
        *,
        length: int,
        headers: Mapping[str, str] | None = None,
        method: str = "PUT",
        timeout: float | None = None,
    ) -> Any:
        """Stream a file to a (pre)signed upload URL. No API key is sent: the URL is the credential."""
        target = self.url(url)
        hdrs = {"User-Agent": USER_AGENT, "Content-Type": "application/octet-stream", "x-request-id": _new_request_id()}
        hdrs.update(dict(headers or {}))
        hdrs["Content-Length"] = str(length)
        resp = await self._execute(method, target, body=fileobj, body_length=length, headers=hdrs, timeout=timeout or self.timeout)
        data = await resp.read()
        if _is_json(resp.headers) and data.strip():
            try:
                return json.loads(data.decode("utf-8"))
            except ValueError:
                return None
        return None


# --------------------------------------------------------------------------------------
# Server-Sent Events
# --------------------------------------------------------------------------------------


@dataclass
class ServerSentEvent:
    """One dispatched SSE event."""

    event: str
    data: str
    id: str | None
    retry: int | None


class SSEDecoder:
    """Line-oriented SSE decoder following the WHATWG event-stream rules."""

    def __init__(self) -> None:
        self._event = ""
        self._data: list[str] = []
        self._id: str | None = None
        self._retry: int | None = None
        self.last_event_id: str | None = None

    def feed(self, line: str) -> ServerSentEvent | None:
        """Process one line; return an event when a blank line dispatches it."""
        if line == "":
            if not self._data and not self._event:
                self._retry = None
                return None
            event = ServerSentEvent(self._event or "message", "\n".join(self._data), self._id, self._retry)
            if self._id is not None:
                self.last_event_id = self._id
            self._event, self._data, self._retry = "", [], None
            return event
        if line.startswith(":"):
            return None
        name, sep, value = line.partition(":")
        if sep and value.startswith(" "):
            value = value[1:]
        if name == "event":
            self._event = value
        elif name == "data":
            self._data.append(value)
        elif name == "id":
            if "\x00" not in value:
                self._id = value
        elif name == "retry":
            if value.isdigit():
                self._retry = int(value)
        return None


def iter_sse(lines: Iterator[str], decoder: SSEDecoder | None = None) -> Iterator[ServerSentEvent]:
    """Decode an iterator of lines into events."""
    dec = decoder or SSEDecoder()
    for line in lines:
        event = dec.feed(line)
        if event is not None:
            yield event


async def aiter_sse(lines: AsyncIterator[str], decoder: SSEDecoder | None = None) -> AsyncIterator[ServerSentEvent]:
    """Decode an async iterator of lines into events."""
    dec = decoder or SSEDecoder()
    async for line in lines:
        event = dec.feed(line)
        if event is not None:
            yield event
