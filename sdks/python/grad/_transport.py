"""Request policy shared by every grad-sdk call: auth, retries, redirects and error mapping.

HTTP itself is ``httpx`` (pooling, proxies, streaming). This module adds the policy:

* Retries (``max_retries``, default 2) use exponential backoff with jitter and honour
  ``Retry-After``. GET/HEAD/PUT/DELETE, and every request that carries an
  ``Idempotency-Key``, are retried on 408/429/500/502/503/504 and on connection
  failures. The generated client sends a fresh UUIDv4 key with every POST the server
  accepts one for (or the caller's ``idempotency_key=``) and reuses it across retries,
  so the server replays the first response instead of starting (and billing) a second
  run. A keyed request that gets 409 with ``Retry-After`` (the first attempt still
  running) is retried too. Other POSTs are retried only on 429 and when the
  connection failed before anything was sent.
* Redirects are never followed: grad-server does not redirect, so any 3xx raises
  :class:`grad.UnexpectedRedirectError` and the credentials stay with the API origin.
* Every request carries ``User-Agent: grad-python/<version>`` and an
  ``x-request-id`` (kept across retries); errors quote the id the server echoed.
"""

from __future__ import annotations

import json
import random
import time
import urllib.parse
import uuid
from collections.abc import Callable, Iterator, Mapping
from dataclasses import dataclass
from typing import IO, Any

import httpx

from ._config import ResolvedConfig
from ._errors import (
    APIConnectionError,
    APITimeoutError,
    GradAPIError,
    InvalidResponseError,
    error_from_response,
    parse_retry_after,
)
from ._version import __version__

USER_AGENT = f"grad-python/{__version__}"
IDEMPOTENT_METHODS = frozenset({"GET", "HEAD", "PUT", "DELETE", "OPTIONS"})
RETRY_STATUSES = frozenset({408, 429, 500, 502, 503, 504})
# Failures before any byte of the request left: retrying is safe for every method.
NOT_SENT = (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)
_CHUNK = 64 * 1024


@dataclass
class Clock:
    """Time source for retries and waits; tests inject a fake one."""

    monotonic: Callable[[], float] = time.monotonic
    sleep: Callable[[float], None] = time.sleep
    random: Callable[[], float] = random.random


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


def new_idempotency_key() -> str:
    """A UUIDv4 for the ``Idempotency-Key`` header (one per logical call)."""
    return str(uuid.uuid4())


def quote_path_param(value: Any, name: str) -> str:
    """Percent-encode one path segment; reject empty, ``.`` and ``..`` values."""
    text = str(value)
    if text in ("", ".", ".."):
        raise ValueError(f"Invalid {name} {value!r}: path parameters must be non-empty and not '.' or '..'.")
    return urllib.parse.quote(text, safe="@")


def _is_json(headers: Mapping[str, str]) -> bool:
    ctype = headers.get("content-type", "")
    return not ctype or "json" in ctype


def _new_request_id() -> str:
    return f"req_{uuid.uuid4().hex}"


def _chunks(fileobj: IO[bytes]) -> Iterator[bytes]:
    while block := fileobj.read(_CHUNK):
        yield block


class Transport:
    """The policy layer over one pooled ``httpx.Client``."""

    def __init__(
        self,
        config: ResolvedConfig,
        *,
        timeout: float = 60.0,
        retry: RetryPolicy | None = None,
        clock: Clock | None = None,
        http_transport: httpx.BaseTransport | None = None,
        default_headers: Mapping[str, str] | None = None,
    ) -> None:
        self.config = config
        self.base_url = config.base_url
        self.timeout = timeout
        self.retry = retry or RetryPolicy()
        self.clock = clock or Clock()
        self._default_headers = dict(default_headers or {})
        # Idle connections close after 4 s, below the 5 s keep-alive of grad-server (Node),
        # so a pooled connection is never reused just as the server closes it.
        self.http = httpx.Client(
            transport=http_transport,
            follow_redirects=False,
            limits=httpx.Limits(keepalive_expiry=4.0),
        )

    def close(self) -> None:
        """Close pooled connections."""
        self.http.close()

    def url(self, path: str, query: Mapping[str, Any] | None = None) -> str:
        """Absolute URL for an API path (or pass an absolute URL through)."""
        base = path if path.startswith(("http://", "https://")) else f"{self.base_url}{path}"
        encoded = encode_query(query)
        if not encoded:
            return base
        return f"{base}{'&' if '?' in base else '?'}{encoded}"

    def _headers(self, *, accept: str, content_type: str | None, extra: Mapping[str, str] | None, auth: bool) -> dict[str, str]:
        out = {"User-Agent": USER_AGENT, "Accept": accept, "Accept-Encoding": "identity", "x-request-id": _new_request_id()}
        out.update(self._default_headers)
        if content_type:
            out["Content-Type"] = content_type
        if auth and self.config.api_key:
            out["Authorization"] = f"Bearer {self.config.api_key}"
        if extra:
            out.update(extra)
        return out

    def _retry_status(self, method: str, status: int, attempt: int, *, keyed: bool, retry_after: float | None) -> bool:
        if attempt >= self.retry.max_retries:
            return False
        if status == 409:
            # The first attempt with this Idempotency-Key is still running server-side.
            return keyed and retry_after is not None
        if status not in RETRY_STATUSES:
            return False
        return keyed or method in IDEMPOTENT_METHODS or status == 429

    def _retry_failure(self, method: str, exc: httpx.TransportError, attempt: int, *, keyed: bool) -> bool:
        if attempt >= self.retry.max_retries:
            return False
        return isinstance(exc, NOT_SENT) or keyed or method in IDEMPOTENT_METHODS

    def _backoff(self, attempt: int, retry_after: float | None) -> float:
        if retry_after is not None:
            return min(retry_after, self.retry.max_retry_after)
        base: float = min(self.retry.max_backoff, self.retry.initial_backoff * (2.0**attempt))
        return base * (0.5 + self.clock.random() / 2)

    def connection_error(self, method: str, url: str, exc: BaseException) -> APIConnectionError:
        """The typed error for a network failure of ``method url``."""
        where = f"{method} {url}"
        if isinstance(exc, httpx.TimeoutException):
            return APITimeoutError(
                f"Request timed out ({where}): no response within the timeout. Pass timeout= to Grad(...) for slower networks.",
                method=method,
                url=url,
                cause=exc,
            )
        return APIConnectionError(
            f"Cannot reach grad-server at {self.base_url} ({where}): {type(exc).__name__}: {exc}. Check GRADIATED_BASE_URL "
            "(or Grad(base_url=...)); for a local stack run `grad local up`.",
            method=method,
            url=url,
            cause=exc,
        )

    def _api_error(self, method: str, url: str, resp: httpx.Response, body: bytes) -> GradAPIError:
        if 300 <= resp.status_code < 400:
            target = resp.headers.get("location", "")
            detail = (
                f"Refusing to follow HTTP {resp.status_code} to {target or 'an unknown location'}: grad-server never redirects, "
                "and the SDK does not send your API key anywhere else. Set base_url to the final URL."
            )
            body = json.dumps({"code": "unexpected_redirect", "title": "Unexpected redirect", "detail": detail}).encode()
        hint = None
        if resp.status_code == 401 and not self.config.api_key:
            hint = "No API key was sent: set GRADIATED_API_KEY, pass Grad(api_key=...), or run `grad login`."
        return error_from_response(status=resp.status_code, headers=resp.headers, body=body, method=method, url=url, hint=hint)

    def _execute(self, method: str, url: str, *, headers: dict[str, str], timeout: float, body: bytes | None = None, fileobj: IO[bytes] | None = None) -> httpx.Response:
        """Send with retries; return the streaming 2xx response (the caller reads or closes it)."""
        keyed = any(name.lower() == "idempotency-key" for name in headers)
        start = fileobj.tell() if fileobj is not None and fileobj.seekable() else None
        attempt = 0
        while True:
            content: bytes | Iterator[bytes] | None = body
            if fileobj is not None:
                if start is not None:
                    fileobj.seek(start)
                content = _chunks(fileobj)
            replayable = fileobj is None or start is not None
            request = self.http.build_request(method, url, headers=headers, content=content, timeout=httpx.Timeout(timeout))
            try:
                resp = self.http.send(request, stream=True)
            except httpx.TransportError as exc:
                if replayable and self._retry_failure(method, exc, attempt, keyed=keyed):
                    self.clock.sleep(self._backoff(attempt, None))
                    attempt += 1
                    continue
                raise self.connection_error(method, url, exc) from exc
            if resp.is_success:
                return resp
            try:
                data = resp.read()
            except httpx.TransportError:
                data = b""
            finally:
                resp.close()
            retry_after = parse_retry_after(resp.headers.get("retry-after"))
            if replayable and self._retry_status(method, resp.status_code, attempt, keyed=keyed, retry_after=retry_after):
                self.clock.sleep(self._backoff(attempt, retry_after))
                attempt += 1
                continue
            raise self._api_error(method, url, resp, data)

    def _read(self, method: str, url: str, resp: httpx.Response) -> bytes:
        try:
            return resp.read()
        except httpx.TransportError as exc:
            raise self.connection_error(method, url, exc) from exc
        finally:
            resp.close()

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
        hdrs = self._headers(accept="application/json", content_type="application/json" if body is not None else None, extra=headers, auth=True)
        resp = self._execute(method, url, headers=hdrs, timeout=timeout or self.timeout, body=body)
        data = self._read(method, url, resp)
        if not data.strip() or resp.status_code in (204, 205):
            return None
        if not _is_json(resp.headers):
            return data
        try:
            return json.loads(data.decode("utf-8"))
        except ValueError:
            snippet = " ".join(data.decode("utf-8", errors="replace").split())[:200]
            raise InvalidResponseError(
                f"Expected JSON from {method} {url} (HTTP {resp.status_code}, content-type "
                f"{resp.headers.get('content-type', 'unknown')!r}) but got: {snippet!r}. Is base_url pointing at grad-server?",
                method=method,
                url=url,
                status=resp.status_code,
                request_id=resp.headers.get("x-request-id"),
            ) from None

    def stream(
        self,
        method: str,
        path: str,
        *,
        query: Mapping[str, Any] | None = None,
        accept: str = "application/octet-stream",
        headers: Mapping[str, str] | None = None,
        timeout: float | None = None,
    ) -> httpx.Response:
        """Open a streaming response (2xx only). The caller must read or close it."""
        url = self.url(path, query)
        hdrs = self._headers(accept=accept, content_type=None, extra=headers, auth=True)
        return self._execute(method, url, headers=hdrs, timeout=timeout or self.timeout)

    def upload(
        self,
        url: str,
        fileobj: IO[bytes],
        *,
        length: int,
        headers: Mapping[str, str] | None = None,
        method: str = "PUT",
        timeout: float | None = None,
    ) -> None:
        """Stream a file to a (pre)signed upload URL. No API key is sent: the URL is the credential."""
        target = self.url(url)
        hdrs = self._headers(accept="*/*", content_type="application/octet-stream", extra=headers, auth=False)
        hdrs["Content-Length"] = str(length)
        self._read(method, target, self._execute(method, target, headers=hdrs, timeout=timeout or self.timeout, fileobj=fileobj))


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
