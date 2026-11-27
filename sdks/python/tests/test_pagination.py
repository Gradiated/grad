"""Pagination safety: a server that repeats ``next_cursor`` or returns empty pages cannot loop the SDK.

Regression for the round-3 host OOM, where a fake endpoint that always returned the same
``next_cursor`` made an unguarded pager buffer pages until the kernel killed it.
"""

from __future__ import annotations

import asyncio
import copy
import unittest
from typing import Any

from _fakes import FakeSender, fixture, json_reply, make_async_client, make_client

import grad
from grad import PaginationLoopError

RUNS_PAGE = fixture("python-runs-page.json")
RECORDS_PAGE = fixture("python-dataset-records-page.json")
METRICS_PAGE = fixture("python-metrics-page.json")
CKPTS_PAGE = fixture("python-checkpoints-page.json")


def with_cursor(page: dict[str, Any], cursor: str | None) -> dict[str, Any]:
    out = copy.deepcopy(page)
    out["next_cursor"] = cursor
    return out


def looping(page: dict[str, Any]) -> dict[str, Any]:
    """A page that always points at the same cursor (the fake repeats it at most MAX_REQUESTS times)."""
    return with_cursor(page, "cur_same")


class SyncPaginationTests(unittest.TestCase):
    def test_list_raises_on_repeated_cursor_after_yielding_pages(self) -> None:
        client, sender, _ = make_client({"GET /v1/runs": json_reply(looping(RUNS_PAGE))})
        seen = []
        with self.assertRaises(PaginationLoopError) as ctx:
            for run in client.runs.list():
                seen.append(run)
        self.assertIsInstance(ctx.exception, grad.GradError)
        self.assertEqual(ctx.exception.cursor, "cur_same")
        self.assertEqual(ctx.exception.code, "pagination_loop")
        self.assertIn("cur_same", str(ctx.exception))
        # First page (cursor=None), then cur_same once; the repeat is refused before a third request.
        self.assertEqual(len(sender.sent), 2)
        self.assertEqual(len(seen), 2 * len(RUNS_PAGE["data"]))

    def test_cursor_cycle_across_pages_is_detected(self) -> None:
        pages = [with_cursor(RUNS_PAGE, "a"), with_cursor(RUNS_PAGE, "b"), with_cursor(RUNS_PAGE, "a")]
        client, sender, _ = make_client({"GET /v1/runs": [json_reply(p) for p in pages]})
        with self.assertRaises(PaginationLoopError):
            list(client.runs.list())
        self.assertEqual(len(sender.sent), 3)

    def test_empty_page_with_cursor_ends_the_walk(self) -> None:
        empty = {"data": [], "next_cursor": "cur_more"}
        client, sender, _ = make_client({"GET /v1/runs": [json_reply(with_cursor(RUNS_PAGE, "c1")), json_reply(empty)]})
        page = client.runs.list()
        items = list(page)
        self.assertEqual(len(items), len(RUNS_PAGE["data"]))
        self.assertEqual(len(sender.sent), 2)
        last = list(page.iter_pages())[-1]
        self.assertFalse(last.has_more)

    def test_next_page_is_repeatable_on_the_same_page(self) -> None:
        client, sender, _ = make_client({"GET /v1/runs": [json_reply(with_cursor(RUNS_PAGE, "c1")), json_reply(with_cursor(RUNS_PAGE, None))]})
        page = client.runs.list()
        self.assertIsNotNone(page.next_page())
        self.assertIsNotNone(page.next_page())  # asking the same page twice is not a loop

    def test_dataset_records_and_metrics_raise_on_repeated_cursor(self) -> None:
        client, sender, _ = make_client(
            {
                "GET /v1/datasets/support/records": json_reply(looping(RECORDS_PAGE)),
                "GET /v1/runs/run_x/metrics": json_reply(looping(METRICS_PAGE)),
            }
        )
        with self.assertRaises(PaginationLoopError):
            list(client.datasets.records("support"))
        with self.assertRaises(PaginationLoopError):
            list(client.runs.metrics("run_x"))
        self.assertEqual(len(sender.sent), 4)

    def test_collect_all_helpers_raise_instead_of_buffering_forever(self) -> None:
        run_id = "run_x"
        client, sender, _ = make_client({f"GET /v1/runs/{run_id}/checkpoints": json_reply(looping(CKPTS_PAGE))})
        with self.assertRaises(PaginationLoopError):
            client.runs.checkpoints(run_id)
        self.assertEqual(len(sender.sent), 2)

    def test_collect_all_is_bounded_even_with_fresh_cursors(self) -> None:
        counter = iter(range(10_000))

        def handler(request: Any) -> Any:
            return json_reply(with_cursor(RUNS_PAGE, f"c{next(counter)}"))

        client, sender, _ = make_client(handler=handler)
        with self.assertRaises(PaginationLoopError) as ctx:
            client.runs.list().to_list(max_items=5)
        self.assertIn("more than 5 items", str(ctx.exception))
        self.assertLessEqual(len(sender.sent), 6)

    def test_page_without_fetcher_stops(self) -> None:
        page = grad.Page([1, 2], "cur")
        self.assertTrue(page.has_more)
        self.assertIsNone(page.next_page())
        self.assertEqual(page.to_list(), [1, 2])

    def test_fakes_are_finite(self) -> None:
        sender = FakeSender({"GET /x": json_reply({})})
        self.assertGreater(sender.MAX_REQUESTS, 0)
        client, sender, _ = make_client({"GET /v1/runs": json_reply(looping(RUNS_PAGE))})
        sender.MAX_REQUESTS = 1
        with self.assertRaises(AssertionError):
            list(client.runs.list())


class AsyncPaginationTests(unittest.TestCase):
    def test_async_list_raises_on_repeated_cursor(self) -> None:
        async def main() -> int:
            client, sender, _ = make_async_client({"GET /v1/runs": json_reply(looping(RUNS_PAGE))})
            async with client:
                count = 0
                with self.assertRaises(PaginationLoopError):
                    async for _ in client.runs.list():
                        count += 1
                self.assertEqual(len(sender.sent), 2)
                return count

        self.assertEqual(asyncio.run(main()), 2 * len(RUNS_PAGE["data"]))

    def test_async_collect_records_metrics_and_empty_page(self) -> None:
        run_id = "run_x"

        async def main() -> None:
            client, sender, _ = make_async_client(
                {
                    f"GET /v1/runs/{run_id}/checkpoints": json_reply(looping(CKPTS_PAGE)),
                    "GET /v1/datasets/support/records": json_reply(looping(RECORDS_PAGE)),
                    f"GET /v1/runs/{run_id}/metrics": json_reply(looping(METRICS_PAGE)),
                    "GET /v1/evals": [json_reply(with_cursor(fixture("python-eval-results-page.json"), "e1")), json_reply({"data": [], "next_cursor": "e2"})],
                }
            )
            async with client:
                with self.assertRaises(PaginationLoopError):
                    await client.runs.checkpoints(run_id)
                with self.assertRaises(PaginationLoopError):
                    [r async for r in client.datasets.records("support")]
                with self.assertRaises(PaginationLoopError):
                    [m async for m in client.runs.metrics(run_id)]
                before = len(sender.sent)
                page = await client.evals.list()
                pages = [p async for p in page.iter_pages()]
                self.assertEqual(len(pages), 2)
                self.assertFalse(pages[-1].has_more)
                self.assertEqual(len(sender.sent) - before, 2)
                with self.assertRaises(PaginationLoopError):
                    await grad.AsyncPager(lambda: _bounded_first(client)).to_list(max_items=1)

        asyncio.run(main())


async def _bounded_first(client: Any) -> Any:
    counter = iter(range(100))

    async def fetch(cursor: str | None) -> Any:
        return grad.AsyncPage([1, 2], f"c{next(counter)}", fetch)

    return await fetch(None)


if __name__ == "__main__":
    unittest.main()
