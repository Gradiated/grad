"""Splits (parity with planner.ts), statistics, config parsing, LR schedule and model resolution."""

from __future__ import annotations

import json
import os
import random
import shutil
import subprocess
import sys
import types
import unittest
from pathlib import Path
from unittest import mock

from helpers import TempDirCase

from grad_trainer.config import lr_multiplier, parse_train_spec
from grad_trainer.errors import ModelUnavailableError, RecipeConfigError
from grad_trainer.metrics import (
    binary_nll,
    bootstrap_ci,
    expected_calibration_error,
    fit_temperature,
    per_class_report,
    sigmoid,
    softmax,
)
from grad_trainer.models import is_offline, resolve_model
from grad_trainer.splits import split_records, two_folds

FIXTURES = Path(__file__).resolve().parent / "fixtures"
REPO = Path(__file__).resolve().parents[3]


class SplitParityTests(unittest.TestCase):
    def _python(self):
        cases = json.loads((FIXTURES / "split_parity_records.json").read_text())
        out = []
        for case in cases:
            train, held = split_records(case["records"], **case["options"])
            ids = {id(r): i for i, r in enumerate(case["records"])}
            out.append({"train": [ids[id(r)] for r in train], "eval": [ids[id(r)] for r in held]})
        return out

    def test_matches_golden_from_planner_ts(self) -> None:
        expected = json.loads((FIXTURES / "split_parity_expected.json").read_text())
        self.assertEqual(self._python(), expected)

    def test_matches_live_planner_ts_when_node_modules_exist(self) -> None:
        tsx = REPO / "server" / "api" / "node_modules" / ".bin" / "tsx"
        if not tsx.exists():
            self.skipTest("server/api node_modules not installed")
        result = subprocess.run(
            [str(tsx), str(FIXTURES / "split_parity.mts"), str(REPO / "server" / "api" / "src" / "planner.ts")],
            cwd=REPO / "server" / "api", capture_output=True, text=True, timeout=120, check=True,
        )
        self.assertEqual(json.loads(result.stdout), self._python())

    def test_two_or_more_groups_always_hold_one_out(self) -> None:
        # r8: 12 reward pairs at eval_fraction 0.1 trained with no eval side ~29% of the time.
        for seed in range(200):
            train, held = split_records([{"id": f"p{i}"} for i in range(12)], strategy="by_group", eval_fraction=0.1, seed=seed)
            self.assertTrue(train and held, seed)
        grouped = [{"id": f"r{i}", "session_id": f"g{i % 2}"} for i in range(6)]
        _, held = split_records(grouped, eval_fraction=0.01, seed=3)
        self.assertEqual((len(held), len({r["session_id"] for r in held})), (3, 1))
        _, held = split_records([{"id": f"r{i}", "session_id": "only"} for i in range(6)], eval_fraction=0.01, seed=3)
        self.assertEqual(held, [])
        self.assertEqual(split_records([], eval_fraction=0.1), ([], []))

    def test_empty_session_id_falls_back_to_record_id_and_two_folds(self) -> None:
        recs = [{"id": f"r{i}", "session_id": ""} for i in range(20)]
        train, held = split_records(recs, eval_fraction=0.5, seed=3)
        by_id, by_id_held = split_records([{"id": f"r{i}"} for i in range(20)], eval_fraction=0.5, seed=3)
        self.assertEqual([r["id"] for r in train], [r["id"] for r in by_id])
        self.assertEqual([r["id"] for r in held], [r["id"] for r in by_id_held])
        self.assertTrue(train and held)  # keyed per record, so both sides are populated
        a, b = two_folds(list(range(10)), [str(i) for i in range(10)], 0)
        self.assertEqual(sorted(a + b), list(range(10)))
        a, b = two_folds([1], ["x"], 0)
        self.assertEqual((a, b), ([1], []))


class MetricsTests(unittest.TestCase):
    def test_ece_hand_computed(self) -> None:
        probs = [0.1, 0.4, 0.45, 0.8, 1.0, 0.0]
        labels = [0, 1, 0, 1, 1, 0]
        self.assertAlmostEqual(expected_calibration_error(probs, labels, bins=10), 1.35 / 6)
        # Right-inclusive edges: 0.2 and 0.3 belong to the bins ending at them.
        self.assertAlmostEqual(expected_calibration_error([0.2, 0.15], [1, 0], bins=10), 0.325)
        self.assertAlmostEqual(expected_calibration_error([0.3, 0.25], [1, 0], bins=10), 0.225)
        self.assertIsNone(expected_calibration_error([], []))
        self.assertAlmostEqual(expected_calibration_error([0.7] * 10, [1] * 7 + [0] * 3), 0.0)
        with self.assertRaises(ValueError):
            expected_calibration_error([0.1], [])

    def test_bootstrap_ci(self) -> None:
        self.assertEqual(bootstrap_ci([0.3] * 20), (0.3, 0.3))
        self.assertIsNone(bootstrap_ci([]))
        lo, hi = bootstrap_ci([0.0, 1.0] * 50, seed=1)
        self.assertLess(lo, 0.5)
        self.assertGreater(hi, 0.5)
        self.assertLess(hi - lo, 0.25)
        self.assertEqual(bootstrap_ci([0.0, 1.0] * 50, seed=1), (lo, hi))
        self.assertEqual(bootstrap_ci([1.0, 2.0, 3.0], statistic=max, resamples=200)[1], 3.0)

    def test_temperature_recovers_overconfidence(self) -> None:
        rng = random.Random(0)
        true = [rng.uniform(-3, 3) for _ in range(4000)]
        labels = [1.0 if rng.random() < sigmoid(z) else 0.0 for z in true]
        logits = [3.0 * z for z in true]
        t = fit_temperature(lambda temp: binary_nll(logits, labels, temp))
        self.assertAlmostEqual(t, 3.0, delta=0.4)
        self.assertEqual(fit_temperature(lambda temp: 1.0), 1.0)

    def test_softmax_sigmoid_and_per_class(self) -> None:
        self.assertAlmostEqual(sum(softmax([1.0, 2.0, 3.0], 0.5)), 1.0)
        self.assertAlmostEqual(sigmoid(-800.0), 0.0)
        report = per_class_report(["a", "a", "b", "c"], ["a", "b", "b", "b"], ["a", "b", "c"])
        self.assertEqual(report["accuracy"], 0.5)
        self.assertEqual(report["per_option"]["a"], {"precision": 1.0, "recall": 0.5, "f1": 2 / 3, "support": 2})
        self.assertEqual(report["per_option"]["b"]["precision"], 1 / 3)
        self.assertEqual(report["per_option"]["c"], {"precision": None, "recall": 0.0, "f1": 0.0, "support": 1})
        self.assertEqual(report["confusion_matrix"]["matrix"], [[1, 1, 0], [0, 1, 0], [0, 1, 0]])
        empty = per_class_report([], [], ["a"])
        self.assertIsNone(empty["accuracy"])
        self.assertIsNone(empty["macro_f1"])


class ConfigTests(unittest.TestCase):
    def test_defaults_and_auto_lr(self) -> None:
        spec = parse_train_spec("dpo", {"model": "qwen/qwen3-8b"})
        self.assertAlmostEqual(spec.lr, 2e-5)
        self.assertEqual(spec.optimizer.betas, (0.9, 0.95))
        self.assertEqual(spec.optimizer.weight_decay, 0.0)
        self.assertEqual(spec.split.eval_fraction, 0.1)
        self.assertEqual(parse_train_spec("router", {}).model, "qwen/qwen3-0.6b")
        self.assertEqual(parse_train_spec("router", {}).split.eval_fraction, 0.15)
        scaled = parse_train_spec("sft", {"batch_size": 32, "lr_scale": 2.0})
        self.assertAlmostEqual(scaled.lr, 5e-4 * 0.5 * 2.0)
        self.assertEqual(parse_train_spec("sft", {"lr": 1e-3}).lr, 1e-3)
        spec = parse_train_spec("sft", {"optimizer": {"kind": "adamw", "betas": [0.8, 0.9], "weight_decay": 0.1}})
        self.assertEqual(spec.optimizer.betas, (0.8, 0.9))

    def test_invalid_configs(self) -> None:
        for kind, config in [
            ("sft", {"batch_size": 0}),
            ("sft", {"batch_size": True}),
            ("sft", {"lr": -1}),
            ("sft", {"lr": 0.0}),
            ("sft", {"lr": "fast"}),
            ("sft", {"schedule": "step"}),
            ("sft", {"split": {"strategy": "x"}}),
            ("sft", {"split": {"eval_fraction": 0.9}}),
            ("sft", {"split": "x"}),
            ("sft", {"optimizer": {"kind": "sgd"}}),
            ("sft", {"optimizer": {"betas": [0.9]}}),
            ("sft", {"optimizer": "adamw"}),
            ("sft", {"max_seq_len": 2}),
            ("sft", {"lr": float("nan")}),
            ("grpo", {}),
        ]:
            with self.subTest(kind=kind, config=config), self.assertRaises(RecipeConfigError):
                parse_train_spec(kind, config)
        with self.assertRaises(RecipeConfigError):
            parse_train_spec("sft", [])  # type: ignore[arg-type]

    def test_lr_schedule(self) -> None:
        mult = [lr_multiplier(s, 100, schedule="linear", warmup=0.03) for s in range(100)]
        self.assertEqual(mult[:3], [1 / 3, 2 / 3, 1.0])
        self.assertAlmostEqual(mult[-1], 1 / 97)
        self.assertTrue(all(a >= b for a, b in zip(mult[2:], mult[3:])))
        self.assertEqual(lr_multiplier(100, 100, schedule="linear", warmup=0.03), 0.0)
        self.assertAlmostEqual(lr_multiplier(50, 100, schedule="cosine", warmup=0.0), 0.5)
        self.assertEqual(lr_multiplier(99, 100, schedule="constant", warmup=0.0), 1.0)
        self.assertEqual(lr_multiplier(0, 5, schedule="linear", warmup=0.03), 1.0)  # no warmup step
        self.assertEqual(lr_multiplier(0, 1, schedule="linear", warmup=0.5), 1.0)


class ModelResolutionTests(TempDirCase):
    def setUp(self) -> None:
        patcher = mock.patch.dict(os.environ, {}, clear=False)
        patcher.start()
        self.addCleanup(patcher.stop)
        for var in ("GRAD_MODEL_PATHS", "GRAD_MODELS_MIRROR", "HF_HUB_OFFLINE", "GRAD_OFFLINE", "TRANSFORMERS_OFFLINE", "GRAD_DEV_MODELS", "GRAD_DEV_MODELS_DIR"):
            os.environ.pop(var, None)

    def model_dir(self, model_type: str = "qwen3") -> Path:
        path = self.tmpdir()
        (path / "config.json").write_text(json.dumps({"model_type": model_type}))
        return path

    def test_model_paths_override(self) -> None:
        path = self.model_dir()
        os.environ["GRAD_MODEL_PATHS"] = json.dumps({"Qwen/Qwen3-8B": "unused", "qwen/qwen3-8b": str(path)})
        resolved = resolve_model("Qwen/Qwen3-8b")
        self.assertEqual((resolved.path, resolved.repo, resolved.source), (path, "Qwen/Qwen3-8B", "path"))
        enc = self.model_dir("bert")
        os.environ["GRAD_MODEL_PATHS"] = json.dumps({"my/encoder": str(enc)})
        self.assertEqual(resolve_model("my/encoder").family, "encoder")
        self.assertEqual(resolve_model("my/encoder").template_revision, "bge@1")
        os.environ["GRAD_MODEL_PATHS"] = json.dumps({"x/y": "/does/not/exist"})
        with self.assertRaisesRegex(ModelUnavailableError, "not a directory"):
            resolve_model("x/y")
        for bad in ("{nope", "[1]"):
            os.environ["GRAD_MODEL_PATHS"] = bad
            with self.assertRaises(ModelUnavailableError):
                resolve_model("x/y")

    def test_mirror_directory_by_id_or_repo(self) -> None:
        mirror = self.tmpdir()
        (mirror / "qwen" / "qwen3-0.6b").mkdir(parents=True)
        (mirror / "qwen" / "qwen3-0.6b" / "config.json").write_text("{}")
        (mirror / "BAAI" / "bge-small-en-v1.5").mkdir(parents=True)
        (mirror / "BAAI" / "bge-small-en-v1.5" / "config.json").write_text('{"model_type": "bert"}')
        os.environ["GRAD_MODELS_MIRROR"] = str(mirror)
        os.environ["GRAD_OFFLINE"] = "1"
        self.assertEqual(resolve_model("qwen/qwen3-0.6b").source, "mirror")
        self.assertEqual(resolve_model("baai/bge-small-en-v1.5").family, "encoder")
        with self.assertRaisesRegex(ModelUnavailableError, "offline"):
            resolve_model("qwen/qwen3-8b")
        # r8 P2-22: a model id never reaches outside the mirror.
        private = mirror.parent / f"{mirror.name}-private"
        private.mkdir()
        self.addCleanup(shutil.rmtree, private, True)
        (private / "config.json").write_text("{}")
        for model_id in (f"../{private.name}", f"x/../../{private.name}", str(private), "qwen//qwen3-0.6b"):
            with self.subTest(model_id=model_id), self.assertRaises(ModelUnavailableError):
                resolve_model(model_id)

    def test_dev_models_build_once_and_mark_artifacts_test_only(self) -> None:
        from grad_trainer import dev_models
        from grad_trainer.models import describe_model

        root = self.tmpdir()
        builds: list[int] = []

        def fake_build(directory: Path, seed: int) -> None:
            builds.append(seed)
            (directory / "config.json").write_text(json.dumps({"model_type": "bert" if seed == 3 else "qwen3"}))

        with mock.patch.dict(dev_models.DEV_MODELS, {k: (fake_build, s) for k, (_, s) in dev_models.DEV_MODELS.items()}):
            with self.assertRaisesRegex(ModelUnavailableError, "built-in catalog"):
                resolve_model("test/tiny-qwen3")  # off unless GRAD_DEV_MODELS=1
            os.environ.update({"GRAD_DEV_MODELS": "1", "GRAD_DEV_MODELS_DIR": str(root)})
            first = resolve_model("test/tiny-qwen3")
            self.assertEqual((first.path, first.source, first.family), (root / "test" / "tiny-qwen3", "dev", "causal_lm"))
            self.assertEqual(resolve_model("test/tiny-qwen3").path, first.path)
            self.assertEqual(resolve_model("test/tiny-bert").family, "encoder")
            self.assertEqual(builds, [1, 3], "each model is built once")
            self.assertEqual(sorted(p.name for p in (root / "test").iterdir()), ["tiny-bert", "tiny-qwen3"], "no temp dirs left")
            self.assertIs(describe_model(first)["test_only"], True)
            os.environ["GRAD_MODEL_PATHS"] = json.dumps({"test/tiny-qwen3": str(self.model_dir())})
            self.assertEqual(resolve_model("test/tiny-qwen3").source, "path", "explicit paths win")
            self.assertNotIn("test_only", describe_model(resolve_model("test/tiny-qwen3")))
        os.environ.pop("GRAD_DEV_MODELS_DIR")
        os.environ["HF_HOME"] = str(root / "hf")
        self.assertEqual(dev_models.models_dir(), root / "hf" / "grad-dev-models")

    def test_unknown_and_private_models_fail_clearly(self) -> None:
        with self.assertRaisesRegex(ModelUnavailableError, "not public"):
            resolve_model("gradiated/linden-1")
        with self.assertRaisesRegex(ModelUnavailableError, "built-in catalog"):
            resolve_model("someone/unknown")

    def test_hub_download_and_failures(self) -> None:
        try:
            import huggingface_hub
        except ImportError:
            self.skipTest("huggingface_hub not installed")
        snap = self.tmpdir() / "snapshots" / "abc123"
        snap.mkdir(parents=True)
        (snap / "config.json").write_text("{}")
        with mock.patch.object(huggingface_hub, "snapshot_download", return_value=str(snap)) as dl:
            resolved = resolve_model("qwen/qwen3-8b")
        self.assertEqual((resolved.repo, resolved.revision, resolved.source), ("Qwen/Qwen3-8B", "abc123", "hub"))
        self.assertFalse(dl.call_args.kwargs["local_files_only"])
        with mock.patch.object(huggingface_hub, "snapshot_download", side_effect=OSError("boom")):
            with self.assertRaisesRegex(ModelUnavailableError, "download from the Hugging Face Hub failed"):
                resolve_model("qwen/qwen3-8b")
        os.environ["HF_HUB_OFFLINE"] = "1"
        self.assertTrue(is_offline())
        with mock.patch.object(huggingface_hub, "snapshot_download", side_effect=OSError("missing")):
            with self.assertRaisesRegex(ModelUnavailableError, "offline mode"):
                resolve_model("qwen/qwen3-8b")

    def test_s3_mirror(self) -> None:
        objects = {"models/qwen/qwen3-4b/config.json": b"{}", "models/qwen/qwen3-4b/model.safetensors": b"w"}

        class FakeClient:
            def get_paginator(self, _name):
                return self

            def paginate(self, Bucket, Prefix):  # noqa: N803 - boto3 signature
                yield {"Contents": [{"Key": k, "Size": len(v)} for k, v in objects.items() if k.startswith(Prefix)]}

            def download_file(self, bucket, key, target):
                Path(target).write_bytes(objects[key])

        cache = self.tmpdir()
        os.environ.update({"GRAD_MODELS_MIRROR": "s3://bucket/models", "GRAD_MODELS_CACHE": str(cache), "GRAD_OFFLINE": "1"})
        fake = types.SimpleNamespace(client=lambda _name: FakeClient())
        with mock.patch.dict(sys.modules, {"boto3": fake}):
            resolved = resolve_model("qwen/qwen3-4b")
            self.assertEqual(resolved.path, cache / "qwen/qwen3-4b")
            self.assertEqual((resolved.path / "model.safetensors").read_bytes(), b"w")
            with self.assertRaisesRegex(ModelUnavailableError, "offline"):
                resolve_model("qwen/qwen3-14b")
        shutil.rmtree(cache)
        with mock.patch.dict(sys.modules, {"boto3": None}):
            with self.assertRaisesRegex(ModelUnavailableError, "boto3"):
                resolve_model("qwen/qwen3-4b")


if __name__ == "__main__":
    unittest.main()
