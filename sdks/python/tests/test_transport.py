"""Transport policy: auth, user agent, request ids, retries, redirects, timeouts, error mapping."""

from __future__ import annotations

import asyncio
import json
import unittest

from _fakes import BASE, FakeSender, Reply, fixture_reply, json_reply, make_async_client, make_client, problem, refused, reset, timed_out

import grad
from grad._errors import error_from_response, parse_retry_after
from grad._transport import USER_AGENT, encode_query, quote_path_param


class RequestShapeTests(unittest.TestCase):
    def test_headers_auth_user_agent_and_request_id(self) -> None:
        client, sender, _ = make_client({"GET /v1/models": json_reply({"data": []})})
        client.models.list()
        sent = sender.sent[0]
        self.assertEqual(sent.header("Authorization"), "Bearer grad_test_key")
        self.assertEqual(sent.header("User-Agent"), USER_AGENT)
        self.assertTrue(USER_AGENT.startswith("grad-python/"))
        self.assertTrue((sent.header("x-request-id") or "").startswith("req_"))
        self.assertEqual(sent.header("Accept"), "application/json")

    def test_no_auth_header_without_key(self) -> None:
        client, sender, _ = make_client({"GET /v1/models": json_reply({"data": []})}, api_key="", base_url="https://grad.internal")
        client.models.list()
        self.assertIsNone(sender.sent[0].header("Authorization"))

    def test_default_headers_and_json_body(self) -> None:
        client, sender, _ = make_client({"POST /v1/datasets": json_reply({"id": "ds", "name": "x"}, 201)}, default_headers={"X-Team": "ml"})
        client.datasets.create("x", metadata={"a": 1})
        sent = sender.sent[0]
        self.assertEqual(sent.header("X-Team"), "ml")
        self.assertEqual(sent.header("Content-Type"), "application/json")
        self.assertEqual(sent.json, {"name": "x", "metadata": {"a": 1}})

    def test_query_encoding(self) -> None:
        self.assertEqual(encode_query({"a": True, "b": False, "c": None, "d": [1, 2], "e": "x y"}), "a=true&b=false&d=1&d=2&e=x+y")
        self.assertEqual(encode_query(None), "")

    def test_path_params_are_quoted_and_dot_segments_rejected(self) -> None:
        self.assertEqual(quote_path_param("a/b c", "id"), "a%2Fb%20c")
        self.assertEqual(quote_path_param("sql@latest", "id"), "sql@latest")
        for bad in ("", ".", ".."):
            with self.assertRaises(ValueError):
                quote_path_param(bad, "id")
        client, sender, _ = make_client({"GET /v1/artifacts/a%2Fb@latest": json_reply(grad_fixture("python-artifact.json"))})
        client.wire.get_artifact("a/b@latest")
        self.assertIn("/v1/artifacts/a%2Fb@latest", sender.sent[0].url)


def grad_fixture(name: str) -> object:
    from _fakes import fixture

    return fixture(name)


class ErrorMappingTests(unittest.TestCase):
    def check(self, reply: Reply, cls: type[Exception], code: str) -> grad.GradAPIError:
        client, _, _ = make_client({"GET /v1/runs/x": reply}, max_retries=0)
        with self.assertRaises(cls) as ctx:
            client.runs.get("x")
        err = ctx.exception
        assert isinstance(err, grad.GradAPIError)
        self.assertEqual(err.code, code)
        self.assertIn("GET https://api.test/v1/runs/x", str(err))
        return err

    def test_status_classes(self) -> None:
        cases = [
            (400, grad.BadRequestError),
            (401, grad.AuthenticationError),
            (403, grad.PermissionDeniedError),
            (404, grad.NotFoundError),
            (409, grad.ConflictError),
            (413, grad.PayloadTooLargeError),
            (422, grad.ValidationError),
            (429, grad.RateLimitError),
            (500, grad.ServerError),
            (503, grad.ServerError),
            (501, grad.FeatureUnavailableError),
            (418, grad.GradAPIError),
        ]
        for status, cls in cases:
            with self.subTest(status=status):
                err = self.check(problem(status, f"c{status}"), cls, f"c{status}")
                self.assertEqual(err.status, status)
                self.assertIsInstance(err, grad.GradError)

    def test_request_id_prefers_header(self) -> None:
        err = self.check(problem(404, "run_not_found"), grad.NotFoundError, "run_not_found")
        self.assertEqual(err.request_id, "req_hdr")
        self.assertIn("request_id=req_hdr", str(err))

    def test_code_based_501_classes_from_fixture(self) -> None:
        client, _, _ = make_client({"POST /v1/deployments": fixture_reply("python-problem-501-deploy.json")})
        with self.assertRaises(grad.DeployUnavailableError) as ctx:
            client.deploy("sql@latest")
        self.assertIn("vLLM", ctx.exception.detail)
        self.assertIsInstance(ctx.exception, grad.FeatureUnavailableError)
        err = error_from_response(status=501, headers={}, body=b'{"code":"inference_unavailable","detail":"no INFERENCE_BASE_URL"}', method="POST", url="u")
        self.assertIsInstance(err, grad.InferenceUnavailableError)

    def test_validation_field_errors_from_fixture(self) -> None:
        client, _, _ = make_client({"POST /v1/runs/plan": fixture_reply("python-problem-422.json")})
        with self.assertRaises(grad.ValidationError) as ctx:
            client.runs.plan("support", name="ok", recipe={"kind": "sft"})
        paths = [e.path for e in ctx.exception.errors]
        self.assertEqual(paths, ["name", "recipe.lr"])
        err = error_from_response(status=422, headers={}, body=b'{"detail":"x","errors":[{"path":["a",0],"message":"bad"},{"field":"b","detail":"worse"}]}', method="POST", url="u")
        self.assertEqual([(e.path, e.message) for e in err.errors], [("a.0", "bad"), ("b", "worse")])

    def test_401_hints(self) -> None:
        client, _, _ = make_client({"GET /v1/runs/x": fixture_reply("python-problem-401.json")})
        with self.assertRaises(grad.AuthenticationError) as ctx:
            client.runs.get("x")
        self.assertIn("grad login", str(ctx.exception))
        client, _, _ = make_client({"GET /v1/runs/x": problem(401, "unauthorized")}, api_key="", base_url="http://localhost:8787")
        with self.assertRaises(grad.AuthenticationError) as ctx:
            client.runs.get("x")
        self.assertIn("No API key was sent", str(ctx.exception))

    def test_odd_bodies(self) -> None:
        for body, ctype in ((b'["oops"]', "application/json"), (b"null", "application/json"), (b"<html>Bad gateway</html>", "text/html"), (b"", "")):
            with self.subTest(body=body):
                err = self.check(Reply(status=502, body=body, headers={"content-type": ctype}), grad.ServerError, "http_502")
                self.assertEqual(err.status, 502)
        err = self.check(Reply(status=502, body=b"<html>Bad gateway</html>"), grad.ServerError, "http_502")
        self.assertIn("Bad gateway", err.detail)
        err = error_from_response(status=500, headers={}, body=b'{"status": null, "detail": 5}', method="GET", url="u")
        self.assertEqual(err.status, 500)

    def test_invalid_json_success_body(self) -> None:
        client, _, _ = make_client({"GET /v1/runs/x": Reply(200, b"{not json", {"content-type": "application/json"})})
        with self.assertRaises(grad.InvalidResponseError) as ctx:
            client.wire.get_run("x")
        self.assertIn("Is base_url pointing at grad-server", str(ctx.exception))

    def test_non_json_success_body_is_returned_raw(self) -> None:
        client, _, _ = make_client({"GET /v1/models": Reply(200, b"plain", {"content-type": "text/plain"})})
        self.assertEqual(client.wire.list_models(), b"plain")

    def test_empty_success_body(self) -> None:
        client, _, _ = make_client({"GET /v1/models": Reply(204, b"")})
        self.assertIsNone(client.wire.list_models())

    def test_retry_after_parsing(self) -> None:
        self.assertEqual(parse_retry_after("3"), 3.0)
        self.assertEqual(parse_retry_after("-1"), 0.0)
        self.assertIsNone(parse_retry_after(None))
        self.assertIsNone(parse_retry_after("soon"))
        self.assertAlmostEqual(parse_retry_after("Wed, 21 Oct 2015 07:28:10 GMT", now=1445412480.0) or 0, 10.0, places=3)
        err = error_from_response(status=429, headers={"retry-after": "7"}, body=b"{}", method="GET", url="u")
        assert isinstance(err, grad.RateLimitError)
        self.assertEqual(err.retry_after, 7.0)


class RetryTests(unittest.TestCase):
    def test_get_retries_5xx_with_backoff_then_succeeds(self) -> None:
        client, sender, clock = make_client({"GET /v1/models": [problem(503, "busy"), problem(502, "bad"), json_reply({"data": []})]})
        self.assertEqual(client.models.list(), [])
        self.assertEqual(len(sender.sent), 3)
        self.assertEqual(clock.sleeps, [0.375, 0.75])  # 0.5*2^n * (0.5 + 0.5/2)
        ids = {s.header("x-request-id") for s in sender.sent}
        self.assertEqual(len(ids), 1, "a logical request keeps its id across retries")

    def test_retries_exhausted(self) -> None:
        client, sender, _ = make_client({"GET /v1/models": problem(500, "boom")})
        with self.assertRaises(grad.ServerError):
            client.models.list()
        self.assertEqual(len(sender.sent), 3)

    def test_max_retries_zero(self) -> None:
        client, sender, _ = make_client({"GET /v1/models": problem(503, "busy")}, max_retries=0)
        with self.assertRaises(grad.ServerError):
            client.models.list()
        self.assertEqual(len(sender.sent), 1)

    def test_retry_after_is_honoured(self) -> None:
        client, _, clock = make_client({"GET /v1/models": [problem(429, "slow", **{"retry-after": "4"}), json_reply({"data": []})]})
        client.models.list()
        self.assertEqual(clock.sleeps, [4.0])
        client, _, clock = make_client({"GET /v1/models": [problem(503, "slow", **{"retry-after": "9999"}), json_reply({"data": []})]})
        client.models.list()
        self.assertEqual(clock.sleeps, [60.0])

    def test_client_errors_are_not_retried(self) -> None:
        for status in (400, 401, 403, 404, 409, 422):
            client, sender, _ = make_client({"GET /v1/runs/x": problem(status, "nope")})
            with self.assertRaises(grad.GradAPIError):
                client.runs.get("x")
            self.assertEqual(len(sender.sent), 1, status)

    def test_post_not_retried_on_5xx_or_after_send(self) -> None:
        run = grad_fixture("python-run-queued.json")
        client, sender, _ = make_client({"POST /v1/runs": [problem(503, "busy"), json_reply(run, 202)]})
        with self.assertRaises(grad.ServerError):
            client.runs.create("support", name="a", recipe={"kind": "sft"})
        self.assertEqual(len(sender.sent), 1)
        client, sender, _ = make_client({"POST /v1/runs": [reset("receive"), json_reply(run, 202)]})
        with self.assertRaises(grad.APIConnectionError):
            client.runs.create("support", name="a", recipe={"kind": "sft"})
        self.assertEqual(len(sender.sent), 1, "a POST that may have been processed is never replayed")

    def test_post_retried_on_429_and_connect_failure(self) -> None:
        run = grad_fixture("python-run-queued.json")
        client, sender, _ = make_client({"POST /v1/runs": [problem(429, "slow"), refused(), json_reply(run, 202)]})
        created = client.runs.create("support", name="a", recipe={"kind": "sft"})
        self.assertEqual(created.id, run["id"])  # type: ignore[index]
        self.assertEqual(len(sender.sent), 3)

    def test_post_retried_when_stale_keepalive_fails_on_send(self) -> None:
        run = grad_fixture("python-run-queued.json")
        client, sender, _ = make_client({"POST /v1/runs": [reset("send", reused=True), json_reply(run, 202)]})
        client.runs.create("support", name="a", recipe={"kind": "sft"})
        self.assertEqual(len(sender.sent), 2)
        client, sender, _ = make_client({"POST /v1/runs": [reset("send", reused=False), json_reply(run, 202)]})
        with self.assertRaises(grad.APIConnectionError):
            client.runs.create("support", name="a", recipe={"kind": "sft"})

    def test_connection_errors_and_timeouts(self) -> None:
        client, sender, _ = make_client({"GET /v1/models": refused()})
        with self.assertRaises(grad.APIConnectionError) as ctx:
            client.models.list()
        self.assertEqual(len(sender.sent), 3)
        self.assertIn("Cannot reach grad-server at https://api.test", str(ctx.exception))
        self.assertIn("GRADIATED_BASE_URL", str(ctx.exception))
        self.assertNotIsInstance(ctx.exception, grad.APITimeoutError)
        client, sender, _ = make_client({"GET /v1/models": [timed_out(), json_reply({"data": []})]})
        self.assertEqual(client.models.list(), [])
        client, _, _ = make_client({"GET /v1/models": timed_out()}, max_retries=0)
        with self.assertRaises(grad.APITimeoutError) as tctx:
            client.models.list()
        self.assertIsInstance(tctx.exception, TimeoutError)
        self.assertIsInstance(tctx.exception, grad.APIConnectionError)

    def test_body_read_failure_is_a_connection_error(self) -> None:
        client, _, _ = make_client({"GET /v1/models": Reply(200, chunks=[b'{"da'], error=ConnectionResetError("reset"))})
        with self.assertRaises(grad.APIConnectionError):
            client.models.list()


class RedirectTests(unittest.TestCase):
    def test_cross_origin_redirect_is_refused_without_sending_credentials(self) -> None:
        client, sender, _ = make_client({"GET /v1/runs": Reply(302, b"", {"location": "http://evil.example/v1/runs"})})
        with self.assertRaises(grad.UnexpectedRedirectError) as ctx:
            client.wire.list_runs()
        self.assertEqual(len(sender.sent), 1)
        self.assertEqual(ctx.exception.location, "http://evil.example/v1/runs")
        self.assertIn("another origin", str(ctx.exception))
        self.assertTrue(all("evil" not in s.url for s in sender.sent))

    def test_scheme_downgrade_is_refused(self) -> None:
        client, sender, _ = make_client({"GET /v1/runs": Reply(301, b"", {"location": "http://api.test/v1/runs"})})
        with self.assertRaises(grad.UnexpectedRedirectError):
            client.wire.list_runs()
        self.assertEqual(len(sender.sent), 1)

    def test_post_redirect_is_never_replayed_as_get(self) -> None:
        for status in (301, 302, 303, 307, 308):
            client, sender, _ = make_client({"POST /v1/runs": Reply(status, b"", {"location": "/v1/runs-elsewhere"})})
            with self.assertRaises(grad.UnexpectedRedirectError) as ctx:
                client.runs.create("support", name="a", recipe={"kind": "sft"})
            self.assertEqual(sender.paths(), ["POST /v1/runs"], status)
            self.assertIn("never replayed", str(ctx.exception))

    def test_same_origin_get_redirect_is_followed(self) -> None:
        page = {"data": [], "next_cursor": None}
        client, sender, _ = make_client({"GET /v1/runs": Reply(307, b"", {"location": "/v1/runs/"}), "GET /v1/runs/": json_reply(page)})
        self.assertEqual(client.wire.list_runs(), page)
        self.assertEqual(sender.paths(), ["GET /v1/runs", "GET /v1/runs/"])
        self.assertEqual(sender.sent[1].header("Authorization"), "Bearer grad_test_key")

    def test_redirect_loop_stops(self) -> None:
        client, sender, _ = make_client({"GET /v1/runs": Reply(302, b"", {"location": "/v1/runs"})})
        with self.assertRaises(grad.UnexpectedRedirectError):
            client.wire.list_runs()
        self.assertEqual(len(sender.sent), 6)


class UploadTests(unittest.TestCase):
    def test_upload_sends_no_credentials_and_resolves_relative_urls(self) -> None:
        import io

        client, sender, _ = make_client({"PUT /blobs/uploads/u1": json_reply({"upload_id": "u1"})})
        result = client._transport.upload("/blobs/uploads/u1?sig=x", io.BytesIO(b"abc"), length=3, headers={"Content-Type": "application/octet-stream"})
        self.assertEqual(result, {"upload_id": "u1"})
        sent = sender.sent[0]
        self.assertIsNone(sent.header("Authorization"))
        self.assertEqual(sent.url, f"{BASE}/blobs/uploads/u1?sig=x")
        self.assertEqual(sent.body, b"abc")
        self.assertEqual(sent.header("Content-Length"), "3")

    def test_upload_retries_rewind_the_file(self) -> None:
        import io

        client, sender, _ = make_client({"PUT /blobs/uploads/u1": [problem(503, "busy"), Reply(200, b"", {})]})
        self.assertIsNone(client._transport.upload("https://s3.example/blobs/uploads/u1", io.BytesIO(b"abc"), length=3))
        self.assertEqual([s.body for s in sender.sent], [b"abc", b"abc"])

    def test_upload_non_json_reply(self) -> None:
        import io

        client, _, _ = make_client({"PUT /x": Reply(200, b"not json", {"content-type": "application/json"})})
        self.assertIsNone(client._transport.upload("/x", io.BytesIO(b"a"), length=1))


class AsyncTransportTests(unittest.TestCase):
    def test_async_retries_redirects_and_errors(self) -> None:
        async def main() -> None:
            client, sender, clock = make_async_client({"GET /v1/models": [problem(503, "busy"), json_reply({"data": []})]})
            self.assertEqual(await client.models.list(), [])
            self.assertEqual(clock.sleeps, [0.375])
            client, sender, _ = make_async_client({"GET /v1/runs": Reply(302, b"", {"location": "https://evil.example/"})})
            with self.assertRaises(grad.UnexpectedRedirectError):
                await client.wire.list_runs()
            client, sender, _ = make_async_client({"GET /v1/runs": Reply(302, b"", {"location": "/v1/runs/"}), "GET /v1/runs/": json_reply({"data": []})})
            self.assertEqual(await client.wire.list_runs(), {"data": []})
            client, sender, _ = make_async_client({"POST /v1/runs": reset("receive")})
            with self.assertRaises(grad.APIConnectionError):
                await client.wire.create_run({"dataset": "d", "name": "n", "recipe": {"kind": "sft"}})
            self.assertEqual(len(sender.sent), 1)
            client, sender, _ = make_async_client({"GET /v1/runs/x": problem(404, "run_not_found")})
            with self.assertRaises(grad.NotFoundError):
                await client.runs.get("x")
            client, _, _ = make_async_client({"GET /v1/models": Reply(200, b"<html>", {"content-type": "application/json"})})
            with self.assertRaises(grad.InvalidResponseError):
                await client.wire.list_models()
            client, _, _ = make_async_client({"GET /v1/models": Reply(200, b"txt", {"content-type": "text/plain"})})
            self.assertEqual(await client.wire.list_models(), b"txt")
            client, _, _ = make_async_client({"GET /v1/models": Reply(200, chunks=[b"{"], error=ConnectionResetError())})
            with self.assertRaises(grad.APIConnectionError):
                await client.wire.list_models()
            client, sender, _ = make_async_client({"PUT /u": [problem(500, "x"), json_reply({"ok": True})]})
            import io

            self.assertEqual(await client._transport.upload("/u", io.BytesIO(b"z"), length=1), {"ok": True})
            client, _, _ = make_async_client({"PUT /u": Reply(200, b"nope", {"content-type": "application/json"})})
            self.assertIsNone(await client._transport.upload("/u", io.BytesIO(b"z"), length=1))
            client, _, _ = make_async_client({"GET /v1/models": refused()}, max_retries=0)
            with self.assertRaises(grad.APIConnectionError):
                await client.models.list()
            await client.aclose()

        asyncio.run(main())


class SenderContractTests(unittest.TestCase):
    def test_fake_sender_reports_unknown_routes(self) -> None:
        with self.assertRaises(AssertionError):
            FakeSender().send.__call__  # noqa: B018
            client, _, _ = make_client({})
            client.models.list()

    def test_json_body_rejects_nan(self) -> None:
        client, _, _ = make_client({"POST /v1/feedback": json_reply({})})
        with self.assertRaises(ValueError):
            client.wire.record_feedback({"events": [{"idempotency_key": "k", "score": float("nan")}]})
        self.assertEqual(json.dumps({"a": 1}), '{"a": 1}')


if __name__ == "__main__":
    unittest.main()
