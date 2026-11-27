"""Training-loop semantics (budget, cancel, checkpoints, resume, best selection) without torch.

Uses a scripted fake task for exact control, plus the stdlib reference backend end to end.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from unittest import mock

from helpers import Recorder, TempDirCase, run_recipe

from grad_trainer.config import parse_train_spec
from grad_trainer.errors import BackendUnavailableError, RecipeDataError, ResumeMismatchError
from grad_trainer.recipes import backend_name, get_recipe_runner
from grad_trainer.runner_types import Budget, ResumeState
from grad_trainer.trainer import EvalResult, TrainingLoop, default_checkpoint_every, epoch_order


class FakeTask:
    kind = "sft"
    artifact_format = "fake"
    metric_name = "eval_loss"
    metric_mode = "min"

    def __init__(self, n: int = 8, scores: list[float] | None = None, eval_data: bool = True) -> None:
        self.warnings: list[str] = []
        self.n = n
        self.scores = list(scores or [])
        self.eval_data = eval_data
        self.weights = 0  # number of steps applied
        self.seen: list[list[int]] = []
        self.loaded: list[int] = []

    def num_train_items(self) -> int:
        return self.n

    def item_tokens(self, index: int) -> int:
        return 10 + index

    def train_step(self, indices: list[int], lr: float) -> dict[str, float]:
        self.seen.append(indices)
        self.weights += 1
        return {"loss": 1.0 / self.weights, "grad_norm": 0.5}

    def evaluate(self) -> EvalResult | None:
        if not self.eval_data:
            return None
        score = self.scores.pop(0) if self.scores else 0.0
        return EvalResult(score=score, metrics={"extra": 1})

    def save_weights(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        (directory / "w.json").write_text(json.dumps(self.weights))

    def load_weights(self, directory: Path) -> None:
        self.weights = json.loads((directory / "w.json").read_text())
        self.loaded.append(self.weights)

    def save_state(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)

    def load_state(self, directory: Path) -> None:
        pass

    def export(self, directory: Path) -> None:
        (directory / "weights.txt").write_text(str(self.weights))

    def manifest(self) -> dict:
        return {"fake": True}

    def final_report(self) -> dict:
        return {}


def loop(task, workdir, *, budget=None, recorder=None, resume=None, **config):
    spec = parse_train_spec("sft", {"batch_size": 2, "epochs": 2, "lr": 0.1, "warmup": 0.0, **config})
    return TrainingLoop(
        task, spec, budget=budget or Budget(None, 1e6), callbacks=recorder.callbacks() if recorder else None,
        resume=resume, workdir=workdir, checkpoint_metadata={"manifest": {"recipe": "sft"}},
    )


class LoopTests(TempDirCase):
    def test_best_selection_restores_weights_but_never_the_meter(self) -> None:
        task = FakeTask(scores=[3.0, 1.0, 2.0, 1.0, 5.0, 4.0, 6.0, 7.0])
        rec = Recorder(self.tmpdir())
        result = loop(task, self.tmpdir(), recorder=rec, eval_every_steps=1, checkpoint_every_steps=3).run()
        self.assertEqual((result.status, result.step, result.best_step, result.selected_step), ("completed", 8, 4, 4))
        self.assertEqual(task.loaded, [4])  # best weights reloaded; ties go to the later step
        self.assertEqual(result.tokens_total, rec.metrics[-1]["tokens"])
        self.assertEqual(result.tokens_total, 2 * sum(10 + i for i in range(8)))  # 2 epochs, every item twice
        tokens = [m["tokens"] for m in rec.metrics]
        self.assertEqual(tokens, sorted(tokens))
        self.assertEqual([c[0] for c in rec.checkpoints], [3, 6, 8])
        self.assertEqual(rec.checkpoints[0][1], 2.0)
        self.assertEqual(rec.metrics[0]["eval_metrics"], {"eval_loss": 3.0, "extra": 1})
        meta = rec.checkpoints[-1][3]
        self.assertEqual((meta["manifest"]["format"], meta["manifest"]["checkpoint_step"], meta["metric_mode"]), ("fake", 8, "min"))
        self.assertTrue((rec.checkpoints[-1][2] / "trainer_state" / "best" / "w.json").is_file())
        self.assertEqual(rec.metrics[0]["lr"], 0.1)
        self.assertAlmostEqual(rec.metrics[-1]["lr"], 0.1 / 8)

    def test_data_order_is_a_deterministic_function_of_seed_and_epoch(self) -> None:
        a, b = FakeTask(), FakeTask()
        loop(a, self.tmpdir()).run()
        loop(b, self.tmpdir()).run()
        self.assertEqual(a.seen, b.seen)
        self.assertEqual(sorted(i for batch in a.seen[:4] for i in batch), list(range(8)))
        self.assertNotEqual(epoch_order(8, 42, 0), epoch_order(8, 42, 1))
        self.assertEqual(default_checkpoint_every(1000), 20)
        self.assertEqual(default_checkpoint_every(5), 1)

    def test_budget_stops_before_the_step_that_would_exceed_it(self) -> None:
        rec = Recorder(self.tmpdir())
        # $1 per token; cap $60 covers the first two steps' tokens but not the third.
        task = FakeTask()
        order = epoch_order(8, 42, 0)
        first_two = sum(10 + i for i in order[:4])
        result = loop(task, self.tmpdir(), budget=Budget(first_two + 5, 1e6), recorder=rec, checkpoint_every_steps=100).run()
        self.assertEqual((result.status, result.step, result.tokens_total), ("stopped_budget", 2, first_two))
        self.assertEqual([c[0] for c in rec.checkpoints], [2])  # final checkpoint at the stop
        self.assertLessEqual(rec.metrics[-1]["cost_usd"], first_two + 5)

    def test_budget_smaller_than_one_step(self) -> None:
        rec = Recorder(self.tmpdir())
        result = loop(FakeTask(), self.tmpdir(), budget=Budget(0.000001, 1.0), recorder=rec).run()
        self.assertEqual((result.status, result.step, rec.checkpoints), ("stopped_budget", 0, []))
        self.assertIn("untrained", result.warnings[0])

    def test_cancel_writes_a_final_checkpoint(self) -> None:
        rec = Recorder(self.tmpdir(), stop_after=3)
        result = loop(FakeTask(), self.tmpdir(), recorder=rec, checkpoint_every_steps=100).run()
        self.assertEqual((result.status, result.step), ("cancelled", 3))
        self.assertEqual([c[0] for c in rec.checkpoints], [3])

    def test_no_eval_data_reports_null_and_selects_last(self) -> None:
        result = loop(FakeTask(eval_data=False), self.tmpdir()).run()
        self.assertEqual((result.select, result.selected_step, result.last_eval), ("last", 8, None))
        self.assertIn("No held-out examples", result.warnings[0])

    def test_resuming_a_budget_stop_without_more_budget_completes_immediately(self) -> None:
        rec = Recorder(self.tmpdir())
        budget = Budget(60, 1e6)
        first = loop(FakeTask(), self.tmpdir(), budget=budget, recorder=rec, checkpoint_every_steps=100).run()
        self.assertEqual(first.status, "stopped_budget")
        step, _, ckpt, _ = rec.checkpoints[-1]
        again = Recorder(self.tmpdir())
        second = loop(FakeTask(), self.tmpdir(), budget=budget, recorder=again, resume=ResumeState(step, ckpt)).run()
        self.assertEqual((second.status, second.step, second.tokens_total - second.tokens_at_start), ("stopped_budget", step, 0))
        self.assertEqual((again.metrics, again.checkpoints), ([], []))
        more = loop(FakeTask(), self.tmpdir(), budget=Budget(None, 1e6), resume=ResumeState(step, ckpt)).run()
        self.assertEqual((more.status, more.step), ("completed", 8))

    def test_resume_mismatch_errors(self) -> None:
        rec = Recorder(self.tmpdir(), stop_after=2)
        loop(FakeTask(), self.tmpdir(), recorder=rec).run()
        ckpt = rec.checkpoints[-1][2]
        with self.assertRaisesRegex(ResumeMismatchError, "different run configuration"):
            loop(FakeTask(), self.tmpdir(), resume=ResumeState(2, ckpt), batch_size=4).run()
        with self.assertRaisesRegex(ResumeMismatchError, "different run configuration"):
            loop(FakeTask(n=9), self.tmpdir(), resume=ResumeState(2, ckpt)).run()
        with self.assertRaisesRegex(ResumeMismatchError, "resume asked for step 5"):
            loop(FakeTask(), self.tmpdir(), resume=ResumeState(5, ckpt)).run()
        with self.assertRaisesRegex(ResumeMismatchError, "no readable"):
            loop(FakeTask(), self.tmpdir(), resume=ResumeState(2, self.tmpdir())).run()


RECORDS = [{"id": f"r{i}", "messages": [{"role": "user", "content": f"q {i}"}, {"role": "assistant", "content": f"answer {i % 3}"}]} for i in range(40)]
CONFIG = {"model": "qwen/qwen3-8b", "batch_size": 4, "epochs": 2, "lr": 0.05, "checkpoint_every_steps": 3, "split": {"eval_fraction": 0.2}}


class RecordShapeTests(TempDirCase):
    def test_message_helpers(self) -> None:
        from grad_trainer.recipes.data import as_messages, common_prefix, prompt_messages, record_messages

        self.assertEqual(as_messages({"content": "x"}, "assistant"), [{"role": "assistant", "content": "x"}])
        self.assertEqual(as_messages({"messages": ["a"]}, "user"), [{"role": "user", "content": "a"}])
        self.assertEqual(as_messages(None, "user"), [])
        with self.assertRaises(RecipeDataError):
            as_messages({"weird": 1}, "user")
        with self.assertRaises(RecipeDataError):
            as_messages(3, "user")
        traj = {"schema": "grad.trajectory/1", "input": {"messages": [{"role": "user", "content": "q"}]}, "output": {"turns": ["a"]}}
        self.assertEqual([m["role"] for m in record_messages(traj)], ["user", "assistant"])
        self.assertEqual(prompt_messages(traj), [{"role": "user", "content": "q"}])
        self.assertEqual(record_messages({"prompt": "q", "expected_output": {"content": "a"}})[1]["content"], "a")
        self.assertEqual(record_messages({"prompt": "q", "expected_output": 3}), [{"role": "user", "content": "q"}])
        chat = {"messages": [{"role": "user", "content": "q"}, {"role": "assistant", "content": "a"}]}
        self.assertEqual(prompt_messages(chat), [{"role": "user", "content": "q"}])
        self.assertEqual(prompt_messages({"prompt": [{"role": "user", "content": "p"}]})[0]["content"], "p")
        self.assertEqual(common_prefix([{"a": 1}, {"b": 2}], [{"a": 1}, {"c": 3}]), 1)


class ReferenceBackendTests(TempDirCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {"GRAD_TRAINER_BACKEND": "reference"})
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_artifacts_are_marked_reference_and_not_deployable(self) -> None:
        out = run_recipe("sft", CONFIG, RECORDS, self.tmpdir())
        self.assertEqual((out.status, out.artifact_format), ("completed", "reference"))
        self.assertEqual((out.manifest["format"], out.manifest["deployable"], out.manifest["backend"]), ("reference", False, "reference"))
        self.assertTrue((out.artifact_dir / "reference_model.json").is_file())
        self.assertIn("not deployable", out.eval_report["warnings"][0])
        for kind in ("dpo", "router", "decision", "cartridge", "embedding"):
            self.assertEqual(run_recipe(kind, {**CONFIG, "epochs": 1}, RECORDS, self.tmpdir()).artifact_format, "reference")
        with self.assertRaises(RecipeDataError):
            run_recipe("sft", CONFIG, [{"id": "x"}], self.tmpdir())

    def test_resume_equals_uninterrupted_run(self) -> None:
        full = run_recipe("sft", CONFIG, RECORDS, self.tmpdir(), price=1.0)
        rec = Recorder(self.tmpdir(), stop_after=5)
        first = run_recipe("sft", CONFIG, RECORDS, self.tmpdir(), recorder=rec)
        self.assertEqual(first.status, "cancelled")
        step, _, ckpt, _ = rec.checkpoints[-1]
        second = run_recipe("sft", CONFIG, RECORDS, self.tmpdir(), resume=ResumeState(step, ckpt))
        self.assertEqual(second.status, "completed")
        self.assertEqual((full.artifact_dir / "reference_model.json").read_text(), (second.artifact_dir / "reference_model.json").read_text())
        self.assertEqual(first.tokens_processed + second.tokens_processed, full.tokens_processed)
        self.assertEqual(second.manifest["tokens_total"], full.manifest["tokens_total"])
        self.assertEqual(second.eval_report, {**full.eval_report})

    def test_runner_registry(self) -> None:
        self.assertEqual(backend_name(), "reference")
        with self.assertRaisesRegex(ValueError, "Unsupported recipe kind 'grpo'"):
            get_recipe_runner("grpo")
        with mock.patch.dict(os.environ, {"GRAD_TRAINER_BACKEND": "jax"}):
            with self.assertRaises(BackendUnavailableError):
                get_recipe_runner("sft")
        with mock.patch.dict(os.environ, {"GRAD_TRAINER_BACKEND": ""}):
            self.assertEqual(backend_name(), "torch")
            missing = ImportError("No module named 'torch'", name="torch")
            with mock.patch("importlib.import_module", side_effect=missing):
                with self.assertRaisesRegex(BackendUnavailableError, "needs torch"):
                    get_recipe_runner("sft")
            with mock.patch("importlib.import_module", side_effect=ImportError("bug", name="grad_trainer.x")):
                with self.assertRaisesRegex(ImportError, "bug"):
                    get_recipe_runner("sft")
