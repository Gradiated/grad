"""Shared retry-policy fixture (tests/fixtures/wire/retries.json), replayed by every SDK."""

from __future__ import annotations

import unittest
from typing import Any

from _fakes import Reply, fixture, json_reply, make_client

import grad

CASES = fixture("retries.json")["cases"]
ROUTES = {"GET": "GET /v1/datasets", "POST": "POST /v1/datasets", "DELETE": "DELETE /v1/secrets/s"}
SUCCESS = {"GET": {"data": [], "next_cursor": None}, "POST": fixture("dataset.json"), "DELETE": None}


def reply(method: str, spec: dict[str, Any]) -> Reply:
    if spec["status"] < 300:
        return json_reply(SUCCESS[method], spec["status"]) if SUCCESS[method] is not None else Reply(spec["status"])
    return Reply(spec["status"], spec.get("body"), dict(spec.get("headers") or {}))


class RetryConformance(unittest.TestCase):
    def test_cases(self) -> None:
        for case in CASES:
            with self.subTest(case["name"]):
                method, expect = case["method"], case["expect"]
                client, sender, clock = make_client({ROUTES[method]: [reply(method, r) for r in case["responses"]]})
                call = {
                    "GET": lambda: client.datasets.list().data,
                    "POST": lambda: client.datasets.create("d"),
                    "DELETE": lambda: client.secrets.delete("s"),
                }[method]
                if expect["error"] is None:
                    call()
                else:
                    with self.assertRaises(grad.GradAPIError) as ctx:
                        call()
                    self.assertEqual(type(ctx.exception).__name__, expect["error"])
                self.assertEqual(len(sender.sent), expect["attempts"])
                if "sleeps_ms" in expect:
                    self.assertEqual([round(s * 1000) for s in clock.sleeps], expect["sleeps_ms"])
                if method == "POST":
                    keys = {s.header("Idempotency-Key") for s in sender.sent}
                    self.assertEqual(len(keys), 1)
                    self.assertTrue(next(iter(keys)))


if __name__ == "__main__":
    unittest.main()
