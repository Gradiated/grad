"""The one HTTP client every provider uses: egress checks, timeouts, retries, pacing, redaction.

Source hosts are user-supplied, so every request

- must be ``https`` (``http`` only to loopback or an allowlisted network, for tests and
  in-cluster self-hosted tools);
- resolves the host once, refuses blocked addresses (private, loopback, link-local and cloud
  metadata, CGNAT, multicast, reserved, IPv4-mapped forms of those) and connects to the vetted
  IP, with SNI and ``Host`` set to the hostname, so DNS rebinding can't swap the address;
- re-checks every redirect hop and never sends the provider credentials to another origin;
- caps the connect time, the time of every socket read, the wall-clock time and bytes per
  response (a watchdog closes the connection at the deadline, so a host that drips a byte at a
  time can't hold a worker), an optional overall ``deadline`` (a sync's wall-clock cap), and
  retries 429/5xx and connection errors with backoff, honouring ``Retry-After``.

Error messages name the method, host and path, never a response body or a secret.
The egress policy is a hook: pass ``EgressPolicy(allow=..., deny=...)``, or set
``GRAD_SOURCES_EGRESS_ALLOW`` / ``GRAD_SOURCES_EGRESS_DENY`` (comma-separated CIDRs).
"""

from __future__ import annotations

import email.utils
import http.client
import ipaddress
import json
import os
import random
import socket
import ssl
import threading
import time
import urllib.parse
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable, Mapping

from ..errors import SourceAPIChangedError, SourceAuthError, SourceHostBlockedError, SourceUnreachableError

IPAddress = ipaddress.IPv4Address | ipaddress.IPv6Address
Network = ipaddress.IPv4Network | ipaddress.IPv6Network

RETRY_STATUSES = frozenset({408, 429, 500, 502, 503, 504})
MAX_REDIRECTS = 3
MAX_RETRY_AFTER_S = 120.0


def _networks(value: str | Iterable[str] | None) -> tuple[Network, ...]:
    if not value:
        return ()
    items = value.split(",") if isinstance(value, str) else value
    return tuple(ipaddress.ip_network(v.strip(), strict=False) for v in items if v.strip())


_EMBEDS_IPV4 = (ipaddress.IPv6Network("64:ff9b::/96"), ipaddress.IPv6Network("::/96"))


@dataclass(frozen=True)
class EgressPolicy:
    """Which addresses a source may reach. ``deny`` wins over ``allow``; anything not
    allowlisted must be a public (global) unicast address."""

    allow: tuple[Network, ...] = ()
    deny: tuple[Network, ...] = ()

    @classmethod
    def from_env(cls, env: Mapping[str, str] = os.environ) -> "EgressPolicy":
        return cls(_networks(env.get("GRAD_SOURCES_EGRESS_ALLOW")), _networks(env.get("GRAD_SOURCES_EGRESS_DENY")))

    def allowed(self, ip: IPAddress) -> bool:
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
            ip = ip.ipv4_mapped
        elif isinstance(ip, ipaddress.IPv6Address) and any(ip in net for net in _EMBEDS_IPV4):
            # NAT64 (64:ff9b::a9fe:a9fe reaches 169.254.169.254 through DNS64/NAT64) and
            # IPv4-compatible addresses: judge the IPv4 address they carry.
            ip = ipaddress.IPv4Address(int(ip) & 0xFFFF_FFFF)
        if any(ip in net for net in self.deny):
            return False
        if any(ip in net for net in self.allow):
            return True
        return ip.is_global and not ip.is_multicast

    def allows_plain_http(self, ip: IPAddress) -> bool:
        return ip.is_loopback or any(ip in net for net in self.allow)


@dataclass
class Response:
    status: int
    headers: dict[str, str]
    body: bytes

    def json(self) -> Any:
        try:
            return json.loads(self.body or b"null")
        except ValueError:
            raise SourceAPIChangedError(f"expected JSON, got {len(self.body)} bytes of something else") from None


class _PinnedHTTPConnection(http.client.HTTPConnection):
    def __init__(self, host: str, port: int | None, ip: str, timeout: float) -> None:
        super().__init__(host, port, timeout=timeout)
        self._ip = ip

    def connect(self) -> None:
        self.sock = socket.create_connection((self._ip, self.port), self.timeout)


class _PinnedHTTPSConnection(http.client.HTTPSConnection):
    def __init__(self, host: str, port: int | None, ip: str, timeout: float) -> None:
        super().__init__(host, port, timeout=timeout, context=ssl.create_default_context())
        self._ip = ip

    def connect(self) -> None:
        sock = socket.create_connection((self._ip, self.port), self.timeout)
        self.sock = sock  # the watchdog can cut a dripped TLS handshake too
        self.sock = self._context.wrap_socket(sock, server_hostname=self.host)


@dataclass
class HttpClient:
    base_url: str
    headers: dict[str, str] = field(default_factory=dict, repr=False)
    secrets: tuple[str, ...] = field(default=(), repr=False)
    policy: EgressPolicy = field(default_factory=EgressPolicy.from_env)
    requests_per_minute: float | None = None
    connect_timeout_s: float = 10.0
    read_timeout_s: float = 30.0
    response_timeout_s: float = 120.0
    # Absolute ``clock()`` time after which no request starts or continues (a sync's cap).
    deadline: float | None = None
    max_response_bytes: int = 64 * 1024 * 1024
    max_attempts: int = 5
    sleep: Callable[[float], None] = time.sleep
    clock: Callable[[], float] = time.monotonic
    resolve: Callable[[str, int], list[str]] | None = None
    _last_request: float | None = field(default=None, init=False, repr=False)
    # The trace and score streams share one client (and one requests_per_minute).
    _pace_lock: threading.Lock = field(default_factory=threading.Lock, init=False, repr=False)

    def __post_init__(self) -> None:
        self.base = self._check_url(self.base_url)
        self.base_path = self.base.path.rstrip("/")

    # -- public ----------------------------------------------------------------------

    def request(
        self, method: str, path: str, *, params: Mapping[str, Any] | None = None, body: Any = None, check_status: bool = True
    ) -> Response:
        """One request with retries. ``check_status=False`` returns any final response (the
        caller reads ``status``) instead of raising for 4xx/5xx; nothing is retried then."""
        query = urllib.parse.urlencode({k: v for k, v in (params or {}).items() if v is not None}, doseq=True)
        target = f"{self.base_path}{path}" + (f"?{query}" if query else "")
        payload = None if body is None else json.dumps(body).encode()
        where = f"{method} {self.base.hostname}{self.base_path}{path}"
        for attempt in range(1, self.max_attempts + 1):
            self._pace()
            if self.deadline is not None and self.clock() >= self.deadline:
                raise SourceUnreachableError(f"{where}: the sync ran out of time (its wall-clock cap)")
            try:
                resp = self._follow(method, self.base, target, payload)
            except (OSError, http.client.HTTPException) as exc:
                if attempt == self.max_attempts:
                    raise SourceUnreachableError(self.redact(f"{where} failed after {attempt} attempts: {type(exc).__name__}: {exc}")) from None
                self.sleep(self._backoff(attempt, None))
                continue
            if not check_status:
                return resp
            if resp.status in RETRY_STATUSES and attempt < self.max_attempts:
                self.sleep(self._backoff(attempt, resp.headers.get("retry-after")))
                continue
            if resp.status in (401, 403):
                raise SourceAuthError(f"{where} was rejected with HTTP {resp.status}: check the source's secret and its read permissions")
            if resp.status in RETRY_STATUSES:
                raise SourceUnreachableError(f"{where} kept failing with HTTP {resp.status} after {attempt} attempts")
            if resp.status >= 300:
                raise SourceAPIChangedError(f"{where} returned HTTP {resp.status}: check the source's host and project, or the provider changed its API")
            return resp
        raise AssertionError("unreachable")  # pragma: no cover

    def get(self, path: str, **params: Any) -> Any:
        return self.request("GET", path, params=params).json()

    def post(self, path: str, body: Any, **params: Any) -> Any:
        return self.request("POST", path, params=params, body=body).json()

    def redact(self, text: str) -> str:
        for secret in (*self.secrets, *self.headers.values()):
            if secret and len(secret) >= 4:
                text = text.replace(secret, "***")
        return text

    # -- internals -------------------------------------------------------------------

    def _check_url(self, url: str) -> urllib.parse.SplitResult:
        parts = urllib.parse.urlsplit(url)
        if parts.scheme not in ("https", "http") or not parts.hostname:
            raise SourceHostBlockedError(f"source host must be an https:// URL, got {parts.scheme or 'no'} scheme")
        if parts.username or parts.password:
            raise SourceHostBlockedError("source host must not contain credentials; store them in the secret")
        return parts

    def _vetted_ip(self, parts: urllib.parse.SplitResult) -> str:
        host, port = str(parts.hostname), parts.port or (443 if parts.scheme == "https" else 80)
        try:
            ips = self.resolve(host, port) if self.resolve else sorted({i[4][0] for i in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)})
        except OSError as exc:
            raise SourceUnreachableError(f"can't resolve source host {host}: {exc}") from None
        addrs = [ipaddress.ip_address(ip.split("%")[0]) for ip in ips]
        blocked = [str(ip) for ip in addrs if not self.policy.allowed(ip)]
        if blocked or not addrs:
            raise SourceHostBlockedError(
                f"source host {host} resolves to a blocked address ({', '.join(blocked) or 'none'}); "
                "private, loopback, link-local and metadata addresses need GRAD_SOURCES_EGRESS_ALLOW"
            )
        if parts.scheme == "http" and not all(self.policy.allows_plain_http(ip) for ip in addrs):
            raise SourceHostBlockedError(f"source host {host} must use https")
        return str(addrs[0])

    def _follow(self, method: str, parts: urllib.parse.SplitResult, target: str, payload: bytes | None) -> Response:
        headers = {"Accept": "application/json", "User-Agent": "grad-trainer", **self.headers}
        for _ in range(MAX_REDIRECTS + 1):
            resp = self._send(method, parts, target, payload, headers)
            location = resp.headers.get("location")
            if resp.status not in (301, 302, 303, 307, 308) or not location:
                return resp
            nxt = self._check_url(urllib.parse.urljoin(f"{parts.scheme}://{parts.netloc}{target}", location))
            if (nxt.scheme, nxt.netloc) != (parts.scheme, parts.netloc):
                headers = {k: v for k, v in headers.items() if k not in self.headers}  # never leak credentials
            if resp.status == 303 or (resp.status in (301, 302) and method != "GET"):
                method, payload = "GET", None
            parts, target = nxt, nxt.path + (f"?{nxt.query}" if nxt.query else "")
        raise SourceUnreachableError(f"{self.base.hostname} redirected more than {MAX_REDIRECTS} times")

    def _send(self, method: str, parts: urllib.parse.SplitResult, target: str, payload: bytes | None, headers: dict[str, str]) -> Response:
        ip = self._vetted_ip(parts)
        cls = _PinnedHTTPSConnection if parts.scheme == "https" else _PinnedHTTPConnection
        conn = cls(str(parts.hostname), parts.port, ip, self.connect_timeout_s)
        budget = self.response_timeout_s
        if self.deadline is not None:
            budget = min(budget, max(0.0, self.deadline - self.clock()))
        # The watchdog bounds the whole exchange (connect, TLS, headers, body) in wall-clock
        # time: per-read timeouts alone reset on every byte a slow host drips.
        expired = threading.Event()

        def abort() -> None:
            expired.set()
            sock = conn.sock
            if sock is not None:
                try:
                    # socket.socket.shutdown, not SSLSocket.shutdown: the latter drops the SSL
                    # object under the reading thread, which then raises ValueError, not OSError.
                    socket.socket.shutdown(sock, socket.SHUT_RDWR)
                except OSError:
                    pass

        watchdog = threading.Timer(budget, abort)
        watchdog.daemon = True
        watchdog.start()
        too_slow = f"{parts.hostname} took longer than {budget:.0f}s for one page"
        try:
            send = dict(headers)
            if payload is not None:
                send["Content-Type"] = "application/json"
            conn.request(method, target or "/", body=payload, headers=send)
            if conn.sock is not None:
                conn.sock.settimeout(self.read_timeout_s)
            raw = conn.getresponse()
            chunks, size = [], 0
            while chunk := raw.read1(64 * 1024):
                size += len(chunk)
                if size > self.max_response_bytes:
                    raise SourceAPIChangedError(f"{parts.hostname} sent more than {self.max_response_bytes} bytes in one page")
                chunks.append(chunk)
            if expired.is_set():
                raise SourceUnreachableError(too_slow)
            return Response(raw.status, {k.lower(): v for k, v in raw.getheaders()}, b"".join(chunks))
        except (OSError, http.client.HTTPException):
            if expired.is_set():
                raise SourceUnreachableError(too_slow) from None
            raise
        finally:
            watchdog.cancel()
            conn.close()

    def _pace(self) -> None:
        if not self.requests_per_minute:
            return
        with self._pace_lock:  # reserve the next slot, then wait for it outside the lock
            now = self.clock()
            slot = now if self._last_request is None else max(now, self._last_request + 60.0 / self.requests_per_minute)
            self._last_request = slot
        if slot > now:
            self.sleep(slot - now)

    def _backoff(self, attempt: int, retry_after: str | None) -> float:
        if retry_after:
            try:
                return min(MAX_RETRY_AFTER_S, max(0.0, float(retry_after)))
            except ValueError:
                try:
                    when = email.utils.parsedate_to_datetime(retry_after).timestamp()
                except (TypeError, ValueError):
                    when = None
                if when is not None:
                    return min(MAX_RETRY_AFTER_S, max(0.0, when - time.time()))
        return min(30.0, 0.5 * 2 ** (attempt - 1)) * (0.5 + random.random() / 2)
