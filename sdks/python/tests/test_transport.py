"""Transport policy: auth, user agent, request ids, retries, redirects, timeouts, error mapping."""

from __future__ import annotations

import json
import unittest

from _fakes import BASE, Reply, fixture_reply, json_reply, make_client, problem, refused, reset, timed_out

import grad
from grad._errors import error_from_response, parse_retry_after
from grad._transport import USER_AGENT, encode_query, quote_path_param


class RequestShapeTests(unittest.TestCase):
    def test_headers_auth_user_agent_and_request_id(self) -> None:
        client, sender, _ = make_client({"GET /v1/base-models": json_reply({"data": []})})
        client.models.list()
        sent = sender.sent[0]
        self.assertEqual(sent.header("Authorization"), "Bearer grad_test_key")
        self.assertEqual(sent.header("User-Agent"), USER_AGENT)
        self.assertTrue(USER_AGENT.startswith("grad-python/"))
        self.assertTrue((sent.header("x-request-id") or "").startswith("req_"))
        self.assertEqual(sent.header("Accept"), "application/json")

    def test_no_auth_header_without_key(self) -> None:
        client, sender, _ = make_client({"GET /v1/base-models": json_reply({"data": []})}, api_key="", base_url="https://grad.internal")
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

    def test_code_based_501_classes(self) -> None:
        err = error_from_response(status=501, headers={}, body=b'{"code":"inference_unavailable","detail":"no INFERENCE_BASE_URL"}', method="POST", url="u")
        self.assertIsInstance(err, grad.InferenceUnavailableError)

    def test_cloud_bare_404_says_cloud_training_is_not_available(self) -> None:
        cloud = "https://api.gradiated.com/v1/datasets"
        err = error_from_response(status=404, headers={}, body=b"", method="GET", url=cloud)
        self.assertIsInstance(err, grad.FeatureUnavailableError)
        self.assertEqual((err.status, err.code), (404, "cloud_training_unavailable"))
        self.assertIn("grad local up", str(err))
        # A real problem body, or any other server, stays a plain NotFoundError.
        err = error_from_response(status=404, headers={}, body=b'{"code":"dataset_not_found"}', method="GET", url=cloud)
        self.assertIsInstance(err, grad.NotFoundError)
        err = error_from_response(status=404, headers={}, body=b"", method="GET", url="https://grad.example.com/v1/datasets")
        self.assertIsInstance(err, grad.NotFoundError)

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
        client, _, _ = make_client({"GET /v1/runs/x": problem(401, "unauthorized")}, api_key="", base_url="http://localhost:18787")
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
        client, _, _ = make_client({"GET /v1/base-models": Reply(200, b"plain", {"content-type": "text/plain"})})
        self.assertEqual(client.wire.list_base_models(), b"plain")

    def test_empty_success_body(self) -> None:
        client, _, _ = make_client({"GET /v1/base-models": Reply(204, b"")})
        self.assertIsNone(client.wire.list_base_models())

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
        client, sender, clock = make_client({"GET /v1/base-models": [problem(503, "busy"), problem(502, "bad"), json_reply({"data": []})]})
        self.assertEqual(client.models.list(), [])
        self.assertEqual(len(sender.sent), 3)
        self.assertEqual(clock.sleeps, [0.375, 0.75])  # 0.5*2^n * (0.5 + 0.5/2)
        ids = {s.header("x-request-id") for s in sender.sent}
        self.assertEqual(len(ids), 1, "a logical request keeps its id across retries")

    def test_retries_exhausted(self) -> None:
        client, sender, _ = make_client({"GET /v1/base-models": problem(500, "boom")})
        with self.assertRaises(grad.ServerError):
            client.models.list()
        self.assertEqual(len(sender.sent), 3)

    def test_max_retries_zero(self) -> None:
        client, sender, _ = make_client({"GET /v1/base-models": problem(503, "busy")}, max_retries=0)
        with self.assertRaises(grad.ServerError):
            client.models.list()
        self.assertEqual(len(sender.sent), 1)

    def test_retry_after_is_honoured(self) -> None:
        client, _, clock = make_client({"GET /v1/base-models": [problem(429, "slow", **{"retry-after": "4"}), json_reply({"data": []})]})
        client.models.list()
        self.assertEqual(clock.sleeps, [4.0])
        client, sender, clock = make_client({"GET /v1/base-models": [problem(503, "slow", **{"retry-after": "9999"}), json_reply({"data": []})]})
        with self.assertRaises(grad.ServerError) as ctx:
            client.models.list()
        self.assertEqual((clock.sleeps, len(sender.sent), ctx.exception.retry_after), ([], 1, 9999.0), "a wait over 60 s raises at once")

    def test_client_errors_are_not_retried(self) -> None:
        for status in (400, 401, 403, 404, 409, 422):
            client, sender, _ = make_client({"GET /v1/runs/x": problem(status, "nope")})
            with self.assertRaises(grad.GradAPIError):
                client.runs.get("x")
            self.assertEqual(len(sender.sent), 1, status)

    def test_keyed_post_retried_on_5xx_and_after_send_with_one_key(self) -> None:
        run = grad_fixture("python-run-queued.json")
        client, sender, _ = make_client({"POST /v1/runs": [problem(503, "busy"), reset("receive"), json_reply(run, 202)]})
        created = client.runs.create("support", name="a", recipe={"kind": "sft"})
        self.assertEqual(created.id, run["id"])  # type: ignore[index]
        keys = {s.header("Idempotency-Key") for s in sender.sent}
        self.assertEqual(len(sender.sent), 3)
        self.assertEqual(len(keys), 1, "every retry reuses the logical call's key")
        self.assertRegex(keys.pop() or "", r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
        client, sender, _ = make_client({"POST /v1/runs": [json_reply(run, 202), json_reply(run, 202)]})
        client.wire.create_run({"dataset": "d", "name": "n", "recipe": {"kind": "sft"}})
        client.wire.create_run({"dataset": "d", "name": "n", "recipe": {"kind": "sft"}}, idempotency_key="mine")
        first, second = (s.header("Idempotency-Key") for s in sender.sent)
        self.assertNotEqual(first, "mine")
        self.assertEqual(second, "mine")

    def test_keyed_post_retries_409_in_progress_only_with_retry_after(self) -> None:
        run = grad_fixture("python-run-queued.json")
        busy = problem(409, "idempotency_in_progress", **{"retry-after": "1"})
        client, sender, clock = make_client({"POST /v1/runs": [busy, json_reply(run, 202, **{"idempotent-replayed": "true"})]})
        client.runs.create("support", name="a", recipe={"kind": "sft"})
        self.assertEqual(len(sender.sent), 2)
        self.assertEqual(clock.sleeps, [1.0])
        client, sender, _ = make_client({"POST /v1/runs": [problem(409, "run_exists"), json_reply(run, 202)]})
        with self.assertRaises(grad.ConflictError):
            client.runs.create("support", name="a", recipe={"kind": "sft"})
        self.assertEqual(len(sender.sent), 1)
        client, sender, _ = make_client({"GET /v1/runs/x": [busy, json_reply(run)]})
        with self.assertRaises(grad.ConflictError):
            client.runs.get("x")
        self.assertEqual(len(sender.sent), 1, "only keyed requests treat 409 as in progress")

    def test_unkeyed_post_retried_only_on_429_and_before_sending(self) -> None:
        # Every public POST carries a key; the rule still guards raw transport calls.
        def post(client: grad.Grad) -> object:
            return client._transport.request("POST", "/v1/raw", json_body={})

        client, sender, _ = make_client({"POST /v1/raw": [problem(503, "busy"), json_reply({"id": "t"})]})
        with self.assertRaises(grad.ServerError):
            post(client)
        self.assertEqual(len(sender.sent), 1)
        self.assertIsNone(sender.sent[0].header("Idempotency-Key"))
        for failure in (reset("receive"), reset("send")):
            client, sender, _ = make_client({"POST /v1/raw": [failure, json_reply({"id": "t"})]})
            with self.assertRaises(grad.APIConnectionError):
                post(client)
            self.assertEqual(len(sender.sent), 1, "an unkeyed POST that may have been processed is never replayed")
        client, sender, _ = make_client({"POST /v1/raw": [problem(429, "slow"), refused(), json_reply({"id": "t"})]})
        self.assertEqual(post(client), {"id": "t"})
        self.assertEqual(len(sender.sent), 3)

    def test_queue_limit_is_never_retried(self) -> None:
        # 429 queue_limit is the workspace's queued-jobs cap, not rate limiting:
        # retrying can't succeed until queued jobs start, so it raises at once.
        run = grad_fixture("python-run-queued.json")
        full = problem(429, "queue_limit")
        for route, call in (
            ("POST /v1/runs", lambda c: c.runs.create("support", name="a", recipe={"kind": "sft"})),
            ("POST /v1/raw", lambda c: c._transport.request("POST", "/v1/raw", json_body={})),
            ("GET /v1/runs/x", lambda c: c.runs.get("x")),
        ):
            with self.subTest(route=route):
                client, sender, clock = make_client({route: [full, json_reply(run, 202)]})
                with self.assertRaises(grad.QueueLimitError) as ctx:
                    call(client)
                self.assertEqual(len(sender.sent), 1)
                self.assertEqual(clock.sleeps, [])
                self.assertIsInstance(ctx.exception, grad.RateLimitError)
                self.assertEqual((ctx.exception.status, ctx.exception.code), (429, "queue_limit"))
        client, sender, _ = make_client({"POST /v1/runs": [problem(429, "rate_limited"), json_reply(run, 202)]})
        client.runs.create("support", name="a", recipe={"kind": "sft"})
        self.assertEqual(len(sender.sent), 2, "other 429s are still retried")

    def test_connection_errors_and_timeouts(self) -> None:
        client, sender, _ = make_client({"GET /v1/base-models": refused()})
        with self.assertRaises(grad.APIConnectionError) as ctx:
            client.models.list()
        self.assertEqual(len(sender.sent), 3)
        self.assertIn("Cannot reach grad-server at https://api.test", str(ctx.exception))
        self.assertIn("GRADIATED_BASE_URL", str(ctx.exception))
        self.assertNotIsInstance(ctx.exception, grad.APITimeoutError)
        client, sender, _ = make_client({"GET /v1/base-models": [timed_out(), json_reply({"data": []})]})
        self.assertEqual(client.models.list(), [])
        client, _, _ = make_client({"GET /v1/base-models": timed_out()}, max_retries=0)
        with self.assertRaises(grad.APITimeoutError) as tctx:
            client.models.list()
        self.assertIsInstance(tctx.exception, TimeoutError)
        self.assertIsInstance(tctx.exception, grad.APIConnectionError)

    def test_body_read_failure_is_a_connection_error(self) -> None:
        client, _, _ = make_client({"GET /v1/base-models": Reply(200, chunks=[b'{"da'], error=ConnectionResetError("reset"))})
        with self.assertRaises(grad.APIConnectionError):
            client.models.list()


class RedirectTests(unittest.TestCase):
    def test_no_redirect_is_followed_and_credentials_stay_home(self) -> None:
        for method, status, location in (("GET", 302, "http://evil.example/v1/runs"), ("GET", 307, "/v1/runs/"), ("POST", 303, "/elsewhere")):
            with self.subTest(method=method, status=status):
                client, sender, _ = make_client({f"{method} /v1/runs": Reply(status, b"", {"location": location})})
                with self.assertRaises(grad.UnexpectedRedirectError) as ctx:
                    client.wire.list_runs() if method == "GET" else client.runs.create("support", name="a", recipe={"kind": "sft"})
                self.assertEqual(sender.paths(), [f"{method} /v1/runs"])
                self.assertEqual(ctx.exception.location, location)
                self.assertIn("never redirects", str(ctx.exception))


class UploadTests(unittest.TestCase):
    def test_upload_sends_no_credentials_and_resolves_relative_urls(self) -> None:
        import io

        client, sender, _ = make_client({"PUT /blobs/uploads/u1": json_reply({"upload_id": "u1"})})
        client._transport.upload("/blobs/uploads/u1?sig=x", io.BytesIO(b"abc"), length=3, headers={"Content-Type": "application/octet-stream"})
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

    def test_upload_failure_is_typed(self) -> None:
        import io

        client, _, _ = make_client({"PUT /x": problem(403, "signature_expired")})
        with self.assertRaises(grad.PermissionDeniedError):
            client._transport.upload("/x", io.BytesIO(b"a"), length=1)


class SenderContractTests(unittest.TestCase):
    def test_fake_sender_reports_unknown_routes(self) -> None:
        client, _, _ = make_client({})
        with self.assertRaises(AssertionError):
            client.models.list()

    def test_json_body_rejects_nan(self) -> None:
        client, _, _ = make_client({"POST /v1/runs/plan": json_reply({})})
        with self.assertRaises(ValueError):
            client.wire.plan_run({"dataset": "d", "name": "n", "recipe": {"kind": "sft", "lr": float("nan")}})
        self.assertEqual(json.dumps({"a": 1}), '{"a": 1}')


if __name__ == "__main__":
    unittest.main()
