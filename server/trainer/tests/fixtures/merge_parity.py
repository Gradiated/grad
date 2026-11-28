"""Writes merge_parity.json (parts of records -> merge_records()); run it after changing the merge rule."""
import json
import random
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / "tests")]
from grad_trainer.records import merge_records  # noqa: E402
from test_merged_dataset import stream  # noqa: E402


def rec(i, text, **kw):
    r = {"id": i, "messages": [{"role": "user", "content": f"q {text}"}, {"role": "assistant", "content": f"a {text}"}]}
    r.update(kw)
    return r


def up(i, scores=None, expected=None):
    r = {"id": i, "metadata": {"score_update": True}}
    if scores is not None:
        r["scores"] = scores
    if expected is not None:
        r["expected_output"] = expected
    return r


def ruled(i, text, rule, **kw):
    return rec(i, text, metadata={"score_filter": rule, "source": "s"}, **kw)


RESET = {"metadata": {"dataset_reset": True}}
anon = {"messages": [{"role": "user", "content": "anon"}]}

cases = [
  ("unfiltered scores survive a filtered re-send", [[rec("x", "1", scores={"q": 1})], [ruled("x", "2", {"has_feedback": True})]]),
  ("an update to an unfiltered record counts for a later filtered re-send", [[rec("x", "1"), rec("y", "1")], [up("x", {"q": 0.9}), up("y", {"q": 0.1})], [ruled("x", "2", {"min_score": 0.5}), ruled("y", "2", {"min_score": 0.5})]]),
  ("an unfiltered correction counts for has_feedback", [[rec("x", "1", expected_output="fixed")], [ruled("x", "2", {"has_feedback": True})]]),
  ("an early update before any filtered record", [[up("x", {"q": 0.9}), up("y", {"q": 0.1})], [ruled("x", "1", {"min_score": {"q": 0.5}}), ruled("y", "1", {"min_score": {"q": 0.5}})]]),
  ("an early update applies after the first content (it wins over its scores)", [[up("x", {"q": 0.9})], [rec("x", "1", scores={"q": 0.1})], [ruled("x", "2", {"min_score": 0.5})]]),
  ("filtered, then unfiltered, then filtered again keeps every score", [[ruled("x", "1", {"min_score": 0.5}, scores={"q": 0.2})], [rec("x", "2")], [up("x", {"q": 0.8})], [ruled("x", "3", {"min_score": 0.5})]]),
  ("a later low score fails a filtered record", [[rec("x", "1", scores={"q": 0.9})], [ruled("x", "2", {"min_score": 0.5})], [up("x", {"q": 0.2})]]),
  ("a reset forgets the scores before it", [[rec("x", "1", scores={"q": 0.9})], [RESET, ruled("x", "2", {"has_feedback": True}), rec("z", "1")]]),
  ("unfiltered content after a filtered one drops the rule", [[ruled("x", "1", {"has_feedback": True})], [rec("x", "2")], [anon]]),
  ("updates for ids that never arrive, anonymous records and plain records pass through", [[rec("a", "1"), anon, up("ghost", {"q": 1})], [rec("b", "1", scores={}), up("a", {"q": 0.3}, "corr")], [rec("a", "2", scores={"r": 1})]]),
  ("named minimums need every name", [[rec("x", "1", scores={"q": 0.9}), rec("y", "1", scores={"q": 0.9, "r": 0.7})], [ruled("x", "2", {"min_score": {"q": 0.5, "r": 0.5}}), ruled("y", "2", {"min_score": {"q": 0.5, "r": 0.5}})]]),
]

for seed in (1, 2):
    recs = stream(random.Random(seed), 200)
    cases.append((f"a random stream of updates, re-sends, filters and resets (seed {seed})", [recs[i:i + 40] for i in range(0, 200, 40)]))
out = []
for name, parts in cases:
    flat = [r for p in parts for r in p]
    out.append({"name": name, "parts": parts, "merged": merge_records(json.loads(json.dumps(flat)))})
Path(__file__).with_name("merge_parity.json").write_text("[\n" + ",\n".join(json.dumps(c) for c in out) + "\n]\n")
