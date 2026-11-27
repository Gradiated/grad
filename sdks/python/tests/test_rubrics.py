"""Judge / Scorer / StatefulScorer / Rubric / validators: documented forms, wire items, local scoring."""

from __future__ import annotations

import unittest

import _fakes  # noqa: F401

import grad
from grad import Judge, Rubric, Scorer, StatefulScorer, Trajectory, validators
from grad._generated.client import SCHEMA_ENUMS, SCHEMA_FIELDS
from grad.rubrics import coerce_rubric, model_ref

ITEM_FIELDS = SCHEMA_FIELDS["EvalRubricItem"]


def answer(text: str, expected: object = None) -> Trajectory:
    return Trajectory(messages=[{"role": "user", "content": "q"}, {"role": "assistant", "content": text}], expected_output=expected, metadata={"answer": "4"})


class JudgeTests(unittest.TestCase):
    def test_model_is_required(self) -> None:
        with self.assertRaises(TypeError):
            Judge()  # type: ignore[call-arg]
        for bad in (None, "", "   "):
            with self.assertRaises(ValueError):
                Judge(model=bad)
        with self.assertRaises(ValueError):
            Judge(model="m" * 161)
        with self.assertRaises(ValueError):
            Judge(model="m", prompt="p" * 8001)

    def test_wire_item_and_artifact_models(self) -> None:
        item = Judge(name="resolved", model="qwen/qwen3-32b", prompt="Resolved?", weight=0.7).to_wire_item()
        self.assertEqual(item, {"name": "resolved", "kind": "judge", "model": "qwen/qwen3-32b", "weight": 0.7, "prompt": "Resolved?"})
        self.assertTrue(set(item) <= ITEM_FIELDS)
        art = grad.Artifact.from_api({"id": "sql-verifier@2026-11-26-1", "name": "sql-verifier", "version": "2026-11-26-1"})
        self.assertEqual(Judge(name="sql_quality", model=art).to_wire_item(), {"name": "sql_quality", "kind": "judge", "model": "sql-verifier@2026-11-26-1", "weight": 1.0})
        with self.assertRaises(TypeError):
            model_ref(42)

    def test_name_and_weight_validation(self) -> None:
        for weight in (0, -1, float("nan"), float("inf"), True, "1"):
            with self.subTest(weight=weight), self.assertRaises(ValueError):
                Judge(model="m", weight=weight)  # type: ignore[arg-type]
        with self.assertRaises(ValueError):
            Judge(model="m", name="has space")


class ScorerTests(unittest.TestCase):
    def test_documented_positional_name(self) -> None:
        scorer = Scorer("valid_json", weight=0.3, fn=validators.JSON())
        self.assertEqual(scorer.to_wire_item(), {"name": "valid_json", "kind": "validator", "validator": "json", "weight": 0.3})
        self.assertFalse(scorer.is_local)
        self.assertEqual(scorer.runtime, "server")

    def test_local_function_scorer(self) -> None:
        def cites_ticket(traj: Trajectory) -> float:
            return 1.0 if "TICKET-" in traj.output.text else 0.0

        scorer = Scorer("cites_ticket", fn=cites_ticket, weight=2.0, runtime="local", network=True)
        self.assertEqual(scorer.to_wire_item(), {"name": "cites_ticket", "kind": "code", "runtime": "local", "weight": 2.0})
        self.assertTrue(scorer.is_local)
        self.assertEqual(scorer.score(answer("see TICKET-9")), 1.0)
        self.assertEqual(scorer.score("no ticket"), 0.0)
        self.assertEqual(Scorer("b", fn=lambda t: True).score(answer("x")), 1.0)
        self.assertIn("cites_ticket", repr(scorer))

    def test_bad_scores_raise_scorer_error(self) -> None:
        for value in (1.5, -0.1, float("nan"), "0.5", None):
            with self.subTest(value=value), self.assertRaises(grad.ScorerError):
                Scorer("bad", fn=lambda t, v=value: v).score(answer("x"))  # type: ignore[misc]

        def boom(traj: Trajectory) -> float:
            raise KeyError("answer")

        with self.assertRaises(grad.ScorerError) as ctx:
            Scorer("boom", fn=boom).score(answer("x"), where="output o1")
        self.assertIn("KeyError", str(ctx.exception))
        self.assertIn("output o1", str(ctx.exception))

    def test_construction_errors(self) -> None:
        with self.assertRaises(ValueError):
            Scorer("x")
        with self.assertRaises(TypeError):
            Scorer("x", fn=5)  # type: ignore[arg-type]
        with self.assertRaises(grad.NotAvailableInV0Error):
            Scorer("x", fn=lambda t: 1.0, runtime="sandbox")
        with self.assertRaises(ValueError):
            Scorer("x", fn=validators.JSON(), runtime="local")
        with self.assertRaises(ValueError):
            Scorer("bad name", fn=lambda t: 1.0)

    def test_requirements_are_checked_locally(self) -> None:
        import importlib.metadata

        dist = next(iter(importlib.metadata.distributions()), None)
        if dist is not None:
            name, version = dist.metadata["Name"], dist.version
            Scorer("ok", fn=lambda t: 1.0, requirements=[name, f"{name}=={version}", f"{name}>=0"]).check_requirements()
            with self.assertRaises(grad.ScorerError):
                Scorer("pin", fn=lambda t: 1.0, requirements=[f"{name}==0.0.0.0.1"]).check_requirements()
        with self.assertRaises(grad.ScorerError) as ctx:
            Scorer("needs", fn=lambda t: 1.0, requirements=["definitely-not-installed-pkg==1.0"]).check_requirements()
        self.assertIn("pip install", str(ctx.exception))
        with self.assertRaises(grad.ScorerError):
            Scorer("garbage", fn=lambda t: 1.0, requirements=["!!"]).check_requirements()

    def test_stateful_scorer(self) -> None:
        scorer = StatefulScorer("refund_state", weight=0.7, fn=lambda traj, store: 1.0 if store["refunded"] else 0.0)
        self.assertEqual(scorer.score(answer("x"), {"refunded": True}), 1.0)
        with self.assertRaises(grad.NotAvailableInV0Error):
            scorer.to_wire_item()
        with self.assertRaises(grad.ScorerError):
            StatefulScorer("s", fn=lambda t, h: h["missing"]).score(answer("x"), {})
        with self.assertRaises(TypeError):
            StatefulScorer("s", fn=None)  # type: ignore[arg-type]
        self.assertEqual(scorer.with_weight(0.2).weight, 0.2)
        self.assertIn("refund_state", repr(scorer))


class ValidatorTests(unittest.TestCase):
    def test_server_validators_match_the_contract(self) -> None:
        server = set(SCHEMA_ENUMS.get("EvalRubricItem", ())) or {"json", "non_empty", "exact_match"}
        for v in (validators.JSON(), validators.NonEmpty(), validators.ExactMatch()):
            self.assertIn(v.validator, server | {"json", "non_empty", "exact_match"})
            item = v.to_wire_item()
            self.assertTrue(set(item) <= ITEM_FIELDS)
            self.assertIn("validators.", repr(v))

    def test_local_semantics_mirror_the_server(self) -> None:
        self.assertEqual(validators.JSON()(' {"a": 1} '), 1.0)
        self.assertEqual(validators.JSON()("nope"), 0.0)
        self.assertEqual(validators.JSON()({"a": 1}), 1.0)
        self.assertEqual(validators.NonEmpty()("  "), 0.0)
        self.assertEqual(validators.NonEmpty()(answer("x")), 1.0)
        self.assertEqual(validators.NonEmpty()(None), 0.0)
        self.assertEqual(validators.ExactMatch()(answer(" 4 ", expected="4")), 1.0)
        self.assertEqual(validators.ExactMatch()("4", {"content": "4"}), 1.0)
        self.assertEqual(validators.ExactMatch()("4", {"x": 4}), 0.0)
        self.assertEqual(validators.ExactMatch()("", None), 0.0, "no expected answer never matches (server rule)")

    def test_regex(self) -> None:
        rx = validators.Regex(r"TICKET-(?<id>\d+)", flags="i")
        self.assertEqual(rx.to_wire_item("cites"), {"name": "cites", "kind": "regex", "pattern": r"TICKET-(?<id>\d+)", "weight": 1.0, "flags": "i"})
        self.assertEqual(rx("see ticket-12"), 1.0)
        self.assertEqual(rx("nothing"), 0.0)
        self.assertEqual(validators.Regex("(?<=a)b")("ab"), 1.0)
        self.assertEqual(validators.Regex("^x$", flags="ms")("y\nx"), 1.0)
        self.assertIn("flags", repr(rx))
        self.assertNotIn("flags", repr(validators.Regex("a")))
        for bad in ("", "a" * 257):
            with self.assertRaises(ValueError):
                validators.Regex(bad)
        with self.assertRaises(ValueError):
            validators.Regex("a", flags="x")
        with self.assertRaises(ValueError) as ctx:
            validators.Regex(r"(?P<name>\d)")
        self.assertIn("JavaScript", str(ctx.exception))
        js_only = validators.Regex(r"\p{L}+", flags="u")
        with self.assertRaises(ValueError):
            js_only("abc")

    def test_unavailable_validators(self) -> None:
        for factory in (validators.SQL, validators.TypeScriptAST, validators.NumericMatch, validators.JSONSchema):
            with self.subTest(factory=factory.__name__), self.assertRaises(grad.NotAvailableInV0Error) as ctx:
                factory(field="answer")
            self.assertIn("Scorer(", str(ctx.exception))
            self.assertIsInstance(ctx.exception, NotImplementedError)

    def test_aliases(self) -> None:
        self.assertIsInstance(validators.json_valid(), validators.JSON)
        self.assertIsInstance(validators.non_empty(), validators.NonEmpty)
        self.assertIsInstance(validators.exact_match(), validators.ExactMatch)
        self.assertIsInstance(validators.regex("a"), validators.Regex)


class RubricTests(unittest.TestCase):
    def test_documented_rubric(self) -> None:
        def short(traj: Trajectory) -> float:
            return 1.0 if len(traj.text) < 10 else 0.0

        rubric = Rubric(
            [
                Scorer("valid_json", weight=0.3, fn=validators.JSON()),
                Judge(name="accurate", model="qwen/qwen3-32b", prompt="Accurate?", weight=0.7),
                short,
                (validators.NonEmpty(), 2.0),
                (Judge(name="j2", model="m"), 0.5),
            ]
        )
        items = rubric.to_wire_items()
        self.assertEqual([i["name"] for i in items], ["valid_json", "accurate", "short", "non_empty", "j2"])
        self.assertEqual(items[3]["weight"], 2.0)
        self.assertEqual(items[4]["weight"], 0.5)
        self.assertEqual(list(rubric.local_scorers), ["short"])
        self.assertEqual([j.name for j in rubric.judges], ["accurate", "j2"])
        self.assertIs(rubric.entries, rubric.items)
        self.assertEqual(rubric.dry_run({"messages": [{"role": "user", "content": "q"}, {"role": "assistant", "content": "ok"}]}), {"short": 1.0})
        self.assertIn("Rubric(", repr(rubric))

    def test_validation(self) -> None:
        with self.assertRaises(ValueError):
            Rubric([])
        with self.assertRaises(ValueError):
            Rubric([validators.JSON(), validators.JSON()])
        with self.assertRaises(ValueError):
            Rubric([validators.NonEmpty()] * 33)
        with self.assertRaises(TypeError):
            Rubric([{"kind": "judge"}])
        with self.assertRaises(TypeError):
            Rubric([42])
        with self.assertRaises(ValueError):
            Rubric([(Judge(model="m"), 0)])
        lam = Rubric([lambda t: 1.0])
        self.assertEqual(lam.items[0].name, "scorer_0")

    def test_score_local_and_overall(self) -> None:
        rubric = Rubric(
            [
                Scorer("json", fn=validators.JSON(), weight=1.0),
                Scorer("len", fn=lambda t: 0.5, weight=1.0),
                StatefulScorer("state", fn=lambda t, h: float(h), weight=2.0),
            ]
        )
        scores = rubric.score_local(answer("{}"), 1)
        self.assertEqual(scores, {"json": 1.0, "len": 0.5, "state": 1.0})
        self.assertAlmostEqual(rubric.overall(scores), (1.0 + 0.5 + 2.0) / 4)
        with self.assertRaises(grad.NotAvailableInV0Error):
            Rubric([Judge(model="m")]).score_local(answer("x"))
        with self.assertRaises(grad.NotAvailableInV0Error):
            rubric.to_wire_items()

    def test_coerce(self) -> None:
        r = Rubric([validators.JSON()])
        self.assertIs(coerce_rubric(r), r)
        self.assertEqual(len(coerce_rubric([validators.JSON(), Judge(model="m")]).items), 2)
        self.assertEqual(coerce_rubric((validators.JSON(), 2.0)).items[0].weight, 2.0)
        self.assertEqual(len(coerce_rubric(Judge(model="m")).items), 1)
        self.assertEqual(coerce_rubric(Rubric(validators.JSON())).items[0].name, "valid_json")  # type: ignore[arg-type]


if __name__ == "__main__":
    unittest.main()
