"""The provider contract: every source provider passes the same tests against its fixture
(tests/fixtures/providers/), served through its documented request/response shapes."""

from __future__ import annotations

import contextlib
import io
import ipaddress
import logging
import unittest
from datetime import timedelta
from typing import Any

from fixtures.provider_server import FakeProviderServer
from fixtures.providers import FIXTURES
from fixtures.providers.base import NOW

from grad_trainer.errors import PaginationLoopError, SourceAuthError
from grad_trainer.providers import PROVIDERS, SyncEngine, build_provider
from grad_trainer.providers.http import EgressPolicy
from grad_trainer.records import RESET_RECORD, is_score_update, merge_records
from grad_trainer.recipes.data import extract_pairs, record_messages

LOOPBACK = EgressPolicy(allow=(ipaddress.ip_network("127.0.0.0/8"),))
LATER = NOW + timedelta(hours=1)


class ProviderContract:
    fixture_cls: Any = None

    def setUp(self) -> None:
        self.fx = self.fixture_cls()
        self.sleeps: list[float] = []
        self.server = None
        if self.fx.http:
            self.server = FakeProviderServer(self.fx).__enter__()
            self.addCleanup(self.server.__exit__)  # type: ignore[union-attr]
        for i in range(5):
            self.fx.add_trace(i, NOW - timedelta(hours=2) + timedelta(minutes=i))

    # -- helpers ------------------------------------------------------------------------

    def provider(self, secret: str | None = None) -> Any:
        source = {"provider": self.fx.name, "project": self.fx.project, "secret": self.fx.secret if secret is None else secret}
        if self.server:
            source["host"] = self.server.url
        provider = build_provider(source, pull=None if self.fx.http else self.fx.pull, policy=LOOPBACK, sleep=self.sleeps.append)
        provider.page_size = 2  # several pages for a handful of traces
        return provider

    def sync(self, watermark: Any = None, *, now: Any = NOW, full: bool = False, secret: str | None = None) -> tuple[list[dict], Any]:
        batches: list[list[dict]] = []
        engine = SyncEngine(self.provider(secret), emit_batch=batches.append, batch_size=3, now=lambda: now)
        result = engine.run(watermark, full=full)
        return [r for b in batches for r in b], result

    def trace_ids(self, records: list[dict]) -> list[str]:
        return sorted(r["id"] for r in records if not is_score_update(r))

    def all_ids(self) -> list[str]:
        return sorted(self.fx.trace_id(i) for i in range(5))

    def require_http(self) -> None:
        if not self.fx.http:
            self.skipTest("reads through the worker's job-scoped endpoint; transport tested in test_worker_protocol")

    # -- contract -----------------------------------------------------------------------

    def test_paginates_to_the_end(self) -> None:
        records, result = self.sync()
        self.assertEqual(self.trace_ids(records), self.all_ids())
        self.assertEqual(result.records, len(records))
        self.assertTrue(all(r["messages"][0]["role"] == "user" and r["messages"][-1]["role"] == "assistant" for r in records))
        self.assertEqual(set(result.watermark), {"traces", "scores"})

    def test_incremental_sync_fetches_only_new_traces(self) -> None:
        _, first = self.sync()
        self.fx.add_trace(5, NOW + timedelta(minutes=5))
        self.fx.add_trace(6, NOW + timedelta(minutes=6))
        records, second = self.sync(first.watermark, now=LATER)
        self.assertEqual(self.trace_ids(records), [self.fx.trace_id(5), self.fx.trace_id(6)])
        again, _ = self.sync(second.watermark, now=LATER)  # re-syncing the same window adds nothing
        self.assertEqual(again, [])

    def test_late_score_on_an_old_trace_changes_the_merged_record(self) -> None:
        first, wm = self.sync()
        self.fx.add_score(self.fx.trace_id(0), "resolved", 1.0, NOW + timedelta(minutes=20))
        second, wm2 = self.sync(wm.watermark, now=LATER)
        merged = {r["id"]: r for r in merge_records(first + second)}
        self.assertEqual(merged[self.fx.trace_id(0)]["scores"], {"resolved": 1.0})
        self.assertEqual(len(merged), 5)
        self.assertNotIn("scores", merged[self.fx.trace_id(1)])
        third, _ = self.sync(wm2.watermark, now=LATER + timedelta(minutes=30))
        self.assertEqual(third, [], "an already synced score is not emitted again")

    def test_full_rebuild_reads_everything_again(self) -> None:
        _, first = self.sync()
        self.fx.add_score(self.fx.trace_id(2), "resolved", 1.0, NOW + timedelta(minutes=20))
        records, result = self.sync(first.watermark, now=LATER, full=True)
        self.assertEqual(records[0], RESET_RECORD, "a rebuild starts with the reset marker")
        merged = {r["id"]: r for r in merge_records([{"id": "stale", "messages": [{"role": "user", "content": "x"}]}, *records])}
        self.assertEqual(sorted(merged), self.all_ids())
        self.assertEqual(merged[self.fx.trace_id(2)]["scores"], {"resolved": 1.0})
        self.assertTrue(result.watermark["traces"])

    def test_retries_429_and_5xx(self) -> None:
        self.require_http()
        self.server.fail_next = [429, 503, 502]  # type: ignore[union-attr]
        records, _ = self.sync()
        self.assertEqual(self.trace_ids(records), self.all_ids())
        self.assertEqual(self.sleeps[0], 0.0, "Retry-After: 0 is honoured")
        self.assertEqual(len([s for s in self.sleeps if s < 30]), len(self.sleeps))

    def test_repeated_cursor_raises_a_typed_error(self) -> None:
        self.fx.stuck = True
        with self.assertRaises(PaginationLoopError):
            self.sync()

    def test_auth_failure_is_typed(self) -> None:
        self.require_http()
        wrong = self.fx.secret[:-4] + "XXXX"
        with self.assertRaises(SourceAuthError) as caught:
            self.sync(secret=wrong)
        self.assertNotIn(wrong, str(caught.exception))

    def test_secret_is_never_logged_or_emitted(self) -> None:
        self.require_http()
        output = io.StringIO()
        handler = logging.StreamHandler(output)
        root = logging.getLogger()
        root.addHandler(handler)
        old_level = root.level
        root.setLevel(logging.DEBUG)
        self.addCleanup(root.removeHandler, handler)
        self.addCleanup(root.setLevel, old_level)
        texts: list[str] = []
        with contextlib.redirect_stderr(output), contextlib.redirect_stdout(output):
            self.server.fail_next = [503]  # type: ignore[union-attr]
            records, result = self.sync()
            texts += [repr(records), repr(result), repr(self.provider()), repr(self.provider().spec), repr(self.provider().http)]
            for _ in range(2):
                self.server.fail_next = [500] * 5  # type: ignore[union-attr]
                try:
                    self.sync()
                except Exception as exc:  # noqa: BLE001 - the message is what we check
                    texts.append(f"{exc!r} {exc}")
            try:
                self.sync(secret=self.fx.secret + "x")
            except SourceAuthError as exc:
                texts.append(f"{exc!r} {exc}")
        texts.append(output.getvalue())
        blob = "\n".join(texts)
        for part in {self.fx.secret, *self.fx.secret.split(":")}:
            self.assertNotIn(part, blob)
        self.assertNotIn("you_sent", blob, "response bodies never reach error messages")

    def test_late_correction_trains_sft_on_the_fix_and_pairs_dpo(self) -> None:
        # docs: integrations/langsmith.mdx, braintrust.mdx and recipes/sft.mdx "Turn production
        # misses into your next dataset": the fix is the SFT target, and the DPO chosen side.
        first, wm = self.sync()
        fix = "Open Billing > Invoices and click Download."
        try:
            self.fx.add_correction(self.fx.trace_id(1), fix, NOW + timedelta(minutes=20))
        except NotImplementedError:
            self.skipTest(f"{self.fx.name} has no corrections")
        second, _ = self.sync(wm.watermark, now=LATER)
        record = {r["id"]: r for r in merge_records(first + second)}[self.fx.trace_id(1)]
        self.assertEqual(record["expected_output"], fix)
        sft = record_messages(record)
        self.assertEqual(sft, [{"role": "user", "content": "question 1"}, {"role": "assistant", "content": fix}])
        pairs, dropped = extract_pairs([record])
        self.assertEqual(dropped, 0)
        self.assertEqual(
            pairs,
            [([{"role": "user", "content": "question 1"}], [{"role": "assistant", "content": fix}], [{"role": "assistant", "content": "answer 1"}], self.fx.trace_id(1))],
        )

    def test_metadata_mapping(self) -> None:
        records, _ = self.sync()
        record = next(r for r in records if r["id"] == self.fx.trace_id(3))
        meta = record["metadata"]
        self.assertEqual(meta["source"], self.fx.name)
        self.assertEqual({k: meta.get(k) for k in self.fx.metadata_keys}, self.fx.expected_metadata(3))
        self.assertTrue(record.get("timestamp"))


for _fixture in FIXTURES:
    _name = f"{_fixture.__name__.removesuffix('Fixture')}ContractTests"
    globals()[_name] = type(_name, (ProviderContract, unittest.TestCase), {"fixture_cls": _fixture})


class RegistryTests(unittest.TestCase):
    def test_every_provider_has_a_contract_fixture(self) -> None:
        self.assertEqual({f.name for f in FIXTURES}, set(PROVIDERS))


if __name__ == "__main__":
    unittest.main()
