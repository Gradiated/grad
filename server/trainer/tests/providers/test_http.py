"""The shared HTTP client: scheme and egress checks, pinned connections, redirects, caps, pacing."""

from __future__ import annotations

import ipaddress
import socket
import threading
import time
import unittest
from typing import Any

from fixtures.provider_server import FakeProviderServer, Req

from grad_trainer.errors import SourceAPIChangedError, SourceHostBlockedError, SourceUnreachableError
from grad_trainer.providers.http import EgressPolicy, HttpClient

LOOPBACK = EgressPolicy(allow=(ipaddress.ip_network("127.0.0.0/8"),))


class Echo:
    """A fixture that answers every path with a canned (status, body, headers)."""

    def __init__(self) -> None:
        self.replies: dict[str, tuple[int, Any, dict[str, str]]] = {}

    def authorized(self, req: Req) -> bool:
        return True

    def respond(self, req: Req) -> tuple[int, Any, dict[str, str]]:
        return self.replies.get(req.path, (200, {"path": req.path, "auth": req.headers.get("authorization")}, {}))


def resolver(*ips: str) -> Any:
    return lambda host, port: list(ips)


class _DripServer:
    """Sends a response one byte every 0.2 s (headers too, with ``headers_first``)."""

    def __init__(self, headers_first: bool) -> None:
        self.headers_first = headers_first
        self.stop = threading.Event()
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(4)
        self.sock.settimeout(0.2)

    def __enter__(self) -> str:
        threading.Thread(target=self._serve, daemon=True).start()
        return f"http://127.0.0.1:{self.sock.getsockname()[1]}"

    def __exit__(self, *exc: object) -> None:
        self.stop.set()
        self.sock.close()

    def _serve(self) -> None:
        while not self.stop.is_set():
            try:
                conn, _ = self.sock.accept()
            except OSError:
                continue
            body = b"{}" + b" " * 40
            head = b"HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n" % len(body)
            try:
                conn.recv(65536)
                if not self.headers_first:
                    conn.sendall(head)
                for byte in (head if self.headers_first else b"") + body:
                    if self.stop.wait(0.2):
                        break
                    conn.sendall(bytes([byte]))
            except OSError:
                pass
            finally:
                conn.close()


class EgressTests(unittest.TestCase):
    def test_blocked_addresses(self) -> None:
        policy = EgressPolicy()
        for ip in ("169.254.169.254", "10.0.0.5", "172.16.1.1", "192.168.1.1", "127.0.0.1", "100.100.100.200",
                   "::1", "fd00:ec2::254", "::ffff:169.254.169.254", "224.0.0.1", "0.0.0.0",
                   # r8 P2-23: NAT64 and IPv4-compatible forms of blocked IPv4 addresses
                   "64:ff9b::a9fe:a9fe", "64:ff9b::7f00:1", "64:ff9b::a00:5", "::7f00:1", "::a9fe:a9fe", "::"):  # fmt: skip
            self.assertFalse(policy.allowed(ipaddress.ip_address(ip)), ip)
        for ip in ("93.184.216.34", "64:ff9b::5db8:d822", "2606:2800:220:1::1"):
            self.assertTrue(policy.allowed(ipaddress.ip_address(ip)), ip)

    def test_allow_and_deny_lists(self) -> None:
        policy = EgressPolicy.from_env({"GRAD_SOURCES_EGRESS_ALLOW": "10.40.0.0/16, 127.0.0.1/32", "GRAD_SOURCES_EGRESS_DENY": "10.40.9.0/24,93.184.216.0/24"})
        self.assertTrue(policy.allowed(ipaddress.ip_address("10.40.1.2")))
        self.assertFalse(policy.allowed(ipaddress.ip_address("10.40.9.2")), "deny wins")
        self.assertFalse(policy.allowed(ipaddress.ip_address("93.184.216.34")), "deny applies to public addresses too")
        self.assertTrue(policy.allows_plain_http(ipaddress.ip_address("10.40.1.2")))
        self.assertFalse(EgressPolicy().allows_plain_http(ipaddress.ip_address("93.184.216.34")))
        self.assertEqual(EgressPolicy.from_env({}), EgressPolicy())

    def test_scheme_credentials_and_resolution_are_checked(self) -> None:
        for url in ("ftp://example.com", "file:///etc/passwd", "example.com", "https://user:pw@example.com"):
            with self.assertRaises(SourceHostBlockedError):
                HttpClient(url)
        metadata = HttpClient("https://metadata.example", resolve=resolver("169.254.169.254"))
        with self.assertRaisesRegex(SourceHostBlockedError, "blocked address"):
            metadata.get("/")
        rebinding = HttpClient("https://mixed.example", resolve=resolver("93.184.216.34", "10.0.0.1"))
        with self.assertRaisesRegex(SourceHostBlockedError, "10.0.0.1"):
            rebinding.get("/")
        plain = HttpClient("http://public.example", resolve=resolver("93.184.216.34"))
        with self.assertRaisesRegex(SourceHostBlockedError, "must use https"):
            plain.get("/")

        def fail(host: str, port: int) -> list[str]:
            raise OSError("no such host")

        with self.assertRaises(SourceUnreachableError):
            HttpClient("https://nowhere.example", resolve=fail).get("/")

    def test_loopback_needs_an_allowlist(self) -> None:
        with FakeProviderServer(Echo()) as server:
            with self.assertRaises(SourceHostBlockedError):
                HttpClient(server.url, policy=EgressPolicy()).get("/x")
            self.assertEqual(HttpClient(server.url, policy=LOOPBACK).get("/x")["path"], "/x")


class ClientTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = Echo()
        self.server = FakeProviderServer(self.fixture).__enter__()
        self.addCleanup(self.server.__exit__)
        self.sleeps: list[float] = []

    def client(self, **kw: Any) -> HttpClient:
        return HttpClient(self.server.url + "/base", headers={"Authorization": "Bearer s3cret-token"}, policy=LOOPBACK, sleep=self.sleeps.append, **kw)

    def test_base_path_query_and_json_body(self) -> None:
        body = self.client().post("/q", {"a": 1}, limit=2, skip=None, ids=["x", "y"])
        self.assertEqual(body["path"], "/base/q")
        req = self.server.requests[-1]
        self.assertEqual((req.body, req.query), ({"a": 1}, {"limit": ["2"], "ids": ["x", "y"]}))

    def test_same_origin_redirect_keeps_auth_and_cross_origin_drops_it(self) -> None:
        self.fixture.replies["/base/r"] = (302, {}, {"Location": "/base/final"})
        self.assertEqual(self.client().get("/r"), {"path": "/base/final", "auth": "Bearer s3cret-token"})
        with FakeProviderServer(Echo()) as other:
            self.fixture.replies["/base/away"] = (307, {}, {"Location": other.url + "/elsewhere"})
            self.assertEqual(self.client().get("/away"), {"path": "/elsewhere", "auth": None})
            self.fixture.replies["/base/post"] = (303, {}, {"Location": other.url + "/after"})
            self.assertEqual(self.client().post("/post", {"x": 1})["path"], "/after")
            self.assertEqual(other.requests[-1].method, "GET")

    def test_redirects_are_rechecked_and_bounded(self) -> None:
        self.fixture.replies["/base/meta"] = (302, {}, {"Location": "http://169.254.169.254/latest/meta-data"})
        with self.assertRaises(SourceHostBlockedError):
            self.client().get("/meta")
        self.fixture.replies["/base/loop"] = (302, {}, {"Location": "/base/loop"})
        with self.assertRaisesRegex(SourceUnreachableError, "redirected more than"):
            self.client().get("/loop")

    def test_status_errors_are_typed_and_never_echo_bodies(self) -> None:
        self.fixture.replies["/base/gone"] = (404, {"detail": "secret detail"}, {})
        with self.assertRaisesRegex(SourceAPIChangedError, "HTTP 404") as caught:
            self.client().get("/gone")
        self.assertNotIn("secret detail", str(caught.exception))
        self.fixture.replies["/base/down"] = (503, {}, {})
        with self.assertRaisesRegex(SourceUnreachableError, "kept failing with HTTP 503"):
            self.client(max_attempts=2).get("/down")
        self.fixture.replies["/base/null"] = (200, None, {})
        self.assertIsNone(self.client().get("/null"))

    def test_non_json_and_oversized_responses(self) -> None:
        self.fixture.replies["/base/big"] = (200, "x" * 5000, {})
        with self.assertRaisesRegex(SourceAPIChangedError, "more than 1000 bytes"):
            self.client(max_response_bytes=1000).get("/big")
        from grad_trainer.providers.http import Response

        with self.assertRaisesRegex(SourceAPIChangedError, "expected JSON"):
            Response(200, {}, b"<html>").json()

    def test_a_dripping_host_hits_the_wall_clock_deadline(self) -> None:
        # r8 P1-6: one byte every 0.2 s resets every per-read timeout; the deadline still holds,
        # whether the host drips the headers or the body.
        for headers_first in (True, False):
            with self.subTest(headers_first=headers_first), _DripServer(headers_first) as url:
                client = HttpClient(url, policy=LOOPBACK, response_timeout_s=1.0, read_timeout_s=0.5, max_attempts=1)
                start = time.monotonic()
                with self.assertRaisesRegex(SourceUnreachableError, "took longer than 1s"):
                    client.get("/")
                self.assertLess(time.monotonic() - start, 2.5)

    def test_no_request_after_the_sync_deadline(self) -> None:
        client = self.client(clock=lambda: 100.0)
        client.deadline = 99.0
        with self.assertRaisesRegex(SourceUnreachableError, "ran out of time"):
            client.get("/x")

    def test_connection_errors_retry_then_raise(self) -> None:
        self.server.__exit__()
        with self.assertRaisesRegex(SourceUnreachableError, "failed after 3 attempts"):
            self.client(max_attempts=3).get("/x")
        self.assertEqual(len(self.sleeps), 2)

    def test_retry_after_forms_and_pacing(self) -> None:
        client = self.client(requests_per_minute=60, clock=lambda: 100.0)
        self.assertEqual(client._backoff(1, "7"), 7.0)
        self.assertEqual(client._backoff(1, "9999"), 120.0)
        self.assertEqual(client._backoff(1, "Wed, 21 Oct 2015 07:28:00 GMT"), 0.0)
        self.assertLessEqual(client._backoff(3, "soon"), 2.0)
        client.get("/a")
        client.get("/b")
        self.assertEqual(self.sleeps, [1.0])
        # Two streams share the client: each request reserves the next slot.
        import threading

        self.sleeps.clear()
        threads = [threading.Thread(target=client.get, args=(f"/{i}",)) for i in range(3)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(sorted(self.sleeps), [2.0, 3.0, 4.0])

    def test_redact(self) -> None:
        client = HttpClient("https://x.example", headers={"x-api-key": "abcd1234"}, secrets=("pk:sk-long", "pk", "sk-long"))
        self.assertEqual(client.redact("abcd1234 pk:sk-long sk-long pk"), "*** *** *** pk")
        self.assertNotIn("abcd1234", repr(client))


if __name__ == "__main__":
    unittest.main()
