"""The stdlib HTTP pools against a real local HTTP/1.1 server (keep-alive, chunked, streams,
timeouts, connection failures, proxies) for both the blocking and the asyncio pool."""

from __future__ import annotations

import asyncio
import io
import json
import socket
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import _fakes  # noqa: F401

import grad
from grad._http import AsyncConnectionPool, ConnectionPool, LineSplitter, Request, TransportFailure, _proxy_for, same_origin


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server: _Server

    def log_message(self, *args: object) -> None:
        pass

    def _send(self, status: int, body: bytes, headers: dict[str, str] | None = None) -> None:
        self.send_response(status)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _record(self) -> None:
        self.server.peers.append(self.client_address[1])
        self.server.paths.append(self.path)
        self.server.headers.append(dict(self.headers))

    def do_GET(self) -> None:  # noqa: N802
        self._record()
        if self.path.endswith("/json"):
            self._send(200, b'{"ok": true}', {"Content-Type": "application/json", "x-request-id": "req_srv"})
        elif self.path.endswith("/chunked"):
            self.send_response(200)
            self.send_header("Transfer-Encoding", "chunked")
            self.send_header("Content-Type", "text/event-stream")
            self.end_headers()
            for part in (b"event: metric\nid: 1\ndata: {\"step\": 1}\n\n", b": ping\r\n\r\n", b"event: status\rdata: {}\r\r"):
                self.wfile.write(f"{len(part):x}\r\n".encode() + part + b"\r\n")
                self.wfile.flush()
                time.sleep(0.01)
            self.wfile.write(b"0\r\n\r\n")
        elif self.path.endswith("/close"):
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Connection", "close")
            self.end_headers()
            self.wfile.write(b'{"closed": 1}')
            self.close_connection = True
        elif self.path.endswith("/slow"):
            time.sleep(0.5)
            self._send(200, b"{}")
        elif self.path.endswith("/redirect"):
            self._send(302, b"", {"Location": "/json"})
        elif self.path.endswith("/empty"):
            self.send_response(204)
            self.end_headers()
        else:
            self._send(404, b'{"code":"route_not_found","detail":"no"}', {"Content-Type": "application/problem+json"})

    def do_PUT(self) -> None:  # noqa: N802
        self._record()
        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length)
        self._send(200, json.dumps({"len": len(data)}).encode(), {"Content-Type": "application/json"})

    def do_POST(self) -> None:  # noqa: N802
        self._record()
        length = int(self.headers.get("Content-Length", "0"))
        data = self.rfile.read(length)
        self.send_response_only(100)
        self.end_headers()
        self._send(200, data, {"Content-Type": "application/json"})


class _Server(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self) -> None:
        super().__init__(("127.0.0.1", 0), _Handler)
        self.peers: list[int] = []
        self.paths: list[str] = []
        self.headers: list[dict[str, str]] = []


class LocalServer(unittest.TestCase):
    server: _Server
    base: str

    @classmethod
    def setUpClass(cls) -> None:
        cls.server = _Server()
        cls.base = f"http://127.0.0.1:{cls.server.server_address[1]}"
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.server.shutdown()
        cls.server.server_close()

    def setUp(self) -> None:
        self.server.peers.clear()
        self.server.paths.clear()
        self.server.headers.clear()


def _closed_port() -> int:
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = int(sock.getsockname()[1])
    sock.close()
    return port


class SyncPoolTests(LocalServer):
    def test_keep_alive_reuses_one_connection(self) -> None:
        pool = ConnectionPool(proxies={})
        for _ in range(3):
            resp = pool.send(Request("GET", f"{self.base}/json"), timeout=5)
            self.assertEqual(resp.read(), b'{"ok": true}')
            self.assertEqual(resp.headers["x-request-id"], "req_srv")
        self.assertEqual(len(set(self.server.peers)), 1)
        pool.close()

    def test_idle_connections_expire(self) -> None:
        now = [0.0]
        pool = ConnectionPool(proxies={}, idle_timeout=4.0, clock=lambda: now[0])
        pool.send(Request("GET", f"{self.base}/json"), timeout=5).read()
        now[0] = 10.0
        pool.send(Request("GET", f"{self.base}/json"), timeout=5).read()
        self.assertEqual(len(set(self.server.peers)), 2)

    def test_connection_close_and_abandoned_bodies_are_not_reused(self) -> None:
        pool = ConnectionPool(proxies={})
        pool.send(Request("GET", f"{self.base}/close"), timeout=5).read()
        resp = pool.send(Request("GET", f"{self.base}/json"), timeout=5)
        resp.close()
        pool.send(Request("GET", f"{self.base}/json"), timeout=5).read()
        self.assertEqual(len(set(self.server.peers)), 3)

    def test_chunked_streaming_lines(self) -> None:
        pool = ConnectionPool(proxies={})
        with pool.send(Request("GET", f"{self.base}/chunked"), timeout=5) as resp:
            lines = list(resp.iter_lines())
        self.assertEqual(lines, ["event: metric", "id: 1", 'data: {"step": 1}', "", ": ping", "", "event: status", "data: {}", ""])

    def test_put_streams_a_file_and_post_skips_100_continue(self) -> None:
        pool = ConnectionPool(proxies={})
        resp = pool.send(Request("PUT", f"{self.base}/up", {}, io.BytesIO(b"x" * 200_000), 200_000), timeout=5)
        self.assertEqual(json.loads(resp.read()), {"len": 200_000})
        resp = pool.send(Request("POST", f"{self.base}/echo", {"Content-Type": "application/json"}, b'{"a":1}'), timeout=5)
        self.assertEqual(resp.read(), b'{"a":1}')
        self.assertEqual(self.server.headers[-1].get("Host"), f"127.0.0.1:{self.server.server_address[1]}")

    def test_timeouts_and_refused_connections(self) -> None:
        pool = ConnectionPool(proxies={})
        with self.assertRaises(TransportFailure) as ctx:
            pool.send(Request("GET", f"{self.base}/slow"), timeout=0.1)
        self.assertTrue(ctx.exception.timeout)
        self.assertEqual(ctx.exception.phase, "receive")
        with self.assertRaises(TransportFailure) as ctx:
            pool.send(Request("GET", f"http://127.0.0.1:{_closed_port()}/json"), timeout=1)
        self.assertEqual(ctx.exception.phase, "connect")

    def test_http_proxy_uses_absolute_uri(self) -> None:
        pool = ConnectionPool(proxies={"http": f"http://user:pw@127.0.0.1:{self.server.server_address[1]}"})
        resp = pool.send(Request("GET", "http://upstream.example/json"), timeout=5)
        self.assertEqual(resp.read(), b'{"ok": true}')
        self.assertEqual(self.server.paths[-1], "http://upstream.example/json")
        self.assertTrue(self.server.headers[-1]["Proxy-Authorization"].startswith("Basic "))

    def test_proxy_selection(self) -> None:
        self.assertIsNone(_proxy_for("https://a.example/x", {}))
        proxy = _proxy_for("https://a.example/x", {"https": "proxy.corp:3128"})
        assert proxy is not None
        self.assertEqual((proxy.host, proxy.port, proxy.auth), ("proxy.corp", 3128, None))
        self.assertIsNone(_proxy_for("https://a.example/x", {"https": "http://"}))
        self.assertTrue(same_origin("https://a.example/x", "https://A.example:443/y"))
        self.assertFalse(same_origin("https://a.example/x", "http://a.example/x"))

    def test_transport_end_to_end_over_sockets(self) -> None:
        client = grad.Grad(base_url=self.base, api_key="k", _env={})
        self.assertEqual(client.wire._t.request("GET", "/json"), {"ok": True})
        self.assertIsNone(client.wire._t.request("GET", "/empty"))
        self.assertEqual(client.wire._t.request("GET", "/redirect"), {"ok": True})
        with self.assertRaises(grad.NotFoundError):
            client.wire._t.request("GET", "/missing")
        client.close()


class LineSplitterTests(unittest.TestCase):
    def test_cr_lf_split_across_chunks(self) -> None:
        splitter = LineSplitter()
        self.assertEqual(splitter.feed(b"a\r"), ["a"])
        self.assertEqual(splitter.feed(b"\nb\n"), ["b"])
        self.assertEqual(splitter.feed(b"c"), [])
        self.assertEqual(splitter.flush(), ["c"])
        self.assertEqual(splitter.flush(), [])


class AsyncPoolTests(LocalServer):
    def test_async_pool(self) -> None:
        async def main() -> None:
            pool = AsyncConnectionPool(proxies={})
            for _ in range(3):
                resp = await pool.send(Request("GET", f"{self.base}/json"), timeout=5)
                self.assertEqual(await resp.read(), b'{"ok": true}')
            self.assertEqual(len(set(self.server.peers)), 1)
            resp = await pool.send(Request("GET", f"{self.base}/chunked"), timeout=5)
            lines = [line async for line in resp.aiter_lines()]
            self.assertEqual(lines[:3], ["event: metric", "id: 1", 'data: {"step": 1}'])
            resp = await pool.send(Request("GET", f"{self.base}/close"), timeout=5)
            self.assertEqual(await resp.read(), b'{"closed": 1}')
            resp = await pool.send(Request("PUT", f"{self.base}/up", {}, io.BytesIO(b"y" * 100_000), 100_000), timeout=5)
            self.assertEqual(json.loads(await resp.read()), {"len": 100_000})
            resp = await pool.send(Request("POST", f"{self.base}/echo", {}, b'{"b":2}'), timeout=5)
            self.assertEqual(await resp.read(), b'{"b":2}')
            resp = await pool.send(Request("GET", f"{self.base}/empty"), timeout=5)
            self.assertEqual(await resp.read(), b"")
            resp = await pool.send(Request("GET", f"{self.base}/json"), timeout=5)
            await resp.aclose()
            with self.assertRaises(TransportFailure) as ctx:
                await pool.send(Request("GET", f"{self.base}/slow"), timeout=0.1)
            self.assertTrue(ctx.exception.timeout)
            with self.assertRaises(TransportFailure) as ctx:
                await pool.send(Request("GET", f"http://127.0.0.1:{_closed_port()}/x"), timeout=1)
            self.assertEqual(ctx.exception.phase, "connect")
            proxied = AsyncConnectionPool(proxies={"http": f"http://u:p@127.0.0.1:{self.server.server_address[1]}"})
            resp = await proxied.send(Request("GET", "http://upstream.example/json"), timeout=5)
            self.assertEqual(await resp.read(), b'{"ok": true}')
            self.assertEqual(self.server.paths[-1], "http://upstream.example/json")
            await proxied.aclose()
            await pool.aclose()

        asyncio.run(main())

    def test_async_client_over_sockets_and_concurrency(self) -> None:
        async def main() -> None:
            async with grad.AsyncGrad(base_url=self.base, api_key="k", _env={}) as client:
                results = await asyncio.gather(*(client.wire._t.request("GET", "/json") for _ in range(20)))
                self.assertEqual(results, [{"ok": True}] * 20)
                self.assertEqual(await client.wire._t.request("GET", "/redirect"), {"ok": True})
                with self.assertRaises(grad.NotFoundError):
                    await client.wire._t.request("GET", "/nope")
                # A slow request does not block others: no thread pool is involved.
                slow = asyncio.create_task(client.wire._t.request("GET", "/slow"))
                fast = await client.wire._t.request("GET", "/json")
                self.assertEqual(fast, {"ok": True})
                self.assertFalse(slow.done())
                slow.cancel()

        asyncio.run(main())


if __name__ == "__main__":
    unittest.main()
