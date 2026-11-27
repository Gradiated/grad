"""Continued training: SFT then DPO (and SFT again) from the earlier run's LoRA artifact (torch)."""

from __future__ import annotations

from helpers import QWEN_ID, Recorder, TorchCase, run_recipe

from grad_trainer.errors import RecipeConfigError
from grad_trainer.runner_types import BaseArtifact

ADAPTER = {"kind": "lora", "rank": 4, "alpha": 8}
CHATS = [
    {"id": f"c{i}", "messages": [{"role": "user", "content": f"Merge diff {i}"}, {"role": "assistant", "content": "clean merged code"}]}
    for i in range(12)
]
PAIRS = [
    {"id": f"d{i}", "prompt": f"Merge diff {i}", "chosen": "clean merged code", "rejected": "truncated code error"}
    for i in range(12)
]
SFT = {"model": QWEN_ID, "batch_size": 4, "epochs": 2, "lr": 2e-2, "warmup": 0.0, "adapter": ADAPTER, "split": {"eval_fraction": 0.25, "seed": 3}}
DPO = {**SFT, "lr": 1e-2, "recipe_params": {"loss": {"kind": "dpo", "beta": 0.1}}, "base_artifact": {"id": "sft@1"}}


class ContinuedTrainingTests(TorchCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        import shutil
        import tempfile
        from pathlib import Path

        cls.root = Path(tempfile.mkdtemp(prefix="grad-continued-"))
        cls.addClassCleanup(shutil.rmtree, cls.root, True)
        (cls.root / "rec").mkdir()
        cls.sft_metrics = Recorder(cls.root / "rec")
        cls.sft = run_recipe("sft", SFT, CHATS, cls.root / "sft", recorder=cls.sft_metrics)
        cls.base = BaseArtifact(artifact_id="sft@1", directory=cls.sft.artifact_dir)

    def adapter_tensors(self, directory):  # type: ignore[no-untyped-def]
        from safetensors.torch import load_file

        return load_file(str(directory / "adapter_model.safetensors"))

    def test_dpo_starts_from_the_sft_adapter_and_uses_it_as_reference(self) -> None:
        import torch

        from grad_trainer.config import parse_train_spec
        from grad_trainer.recipes.dpo import DPOTask

        task = DPOTask(parse_train_spec("dpo", DPO), PAIRS[:4], [], self.tmpdir(), self.base)
        saved = self.adapter_tensors(self.base.directory)
        loaded = {n: p for n, p in task.model.named_parameters() if "lora_" in n}
        self.assertEqual(len(loaded), len(saved))
        self.assertTrue(any(float(t.abs().sum()) > 0 for n, t in saved.items() if "lora_B" in n))
        for name, tensor in saved.items():
            match = [p for n, p in loaded.items() if n.replace(".default", "") == name]
            self.assertEqual(len(match), 1, name)
            self.assertTrue(torch.equal(match[0].detach().cpu(), tensor), name)
            self.assertTrue(match[0].requires_grad)

        # The reference is the SFT model, not the bare base: it was scored with the adapter on.
        pair = task.train_pairs[0]
        with torch.no_grad(), task.model.disable_adapter():
            bare = task._sequence_logps([pair[0]]).item()
        sft_ref = task._ref_cache[("train", 0)][0]
        with torch.no_grad():
            self.assertAlmostEqual(task._sequence_logps([pair[0]]).item(), sft_ref, places=4)
        self.assertNotAlmostEqual(sft_ref, bare, places=3)

        out = run_recipe("dpo", DPO, PAIRS, self.tmpdir(), base=self.base)
        self.assertEqual(out.status, "completed")
        self.assertEqual((out.manifest["base_artifact"], out.manifest["reference_model"]), ("sft@1", "starting artifact sft@1"))
        trained = self.adapter_tensors(out.artifact_dir)
        self.assertEqual(set(trained), set(saved))
        self.assertTrue(any(not torch.equal(trained[n], saved[n]) for n in saved))

    def test_sft_continues_its_own_adapter(self) -> None:
        rec = Recorder(self.tmpdir())
        out = run_recipe("sft", {**SFT, "epochs": 1, "base_artifact": {"id": "sft@1"}}, CHATS, self.tmpdir(), base=self.base, recorder=rec)
        self.assertEqual((out.status, out.manifest["base_artifact"]), ("completed", "sft@1"))
        # Starting from the trained adapter, the first step's loss is where the first run ended.
        first, previous = rec.metrics[0]["loss"], self.sft_metrics.metrics
        self.assertLess(first, previous[0]["loss"] - 0.3)
        self.assertAlmostEqual(first, previous[-1]["loss"], delta=0.1)

    def test_mismatches_fail_before_training(self) -> None:
        with self.assertRaisesRegex(RecipeConfigError, "don't match"):
            run_recipe("dpo", {**DPO, "base_artifact": None}, PAIRS, self.tmpdir(), base=self.base)
        with self.assertRaisesRegex(RecipeConfigError, "'sft@2'"):
            run_recipe("dpo", {**DPO, "base_artifact": {"id": "sft@2"}}, PAIRS, self.tmpdir(), base=self.base)
        with self.assertRaisesRegex(RecipeConfigError, "rank 8"):
            run_recipe("dpo", {**DPO, "adapter": {"kind": "lora", "rank": 8, "alpha": 8}}, PAIRS, self.tmpdir(), base=self.base)
        with self.assertRaisesRegex(RecipeConfigError, "can't continue"):
            run_recipe("embedding", {"base_artifact": {"id": "sft@1"}}, [], self.tmpdir(), base=self.base)
        with self.assertRaisesRegex(RecipeConfigError, "base_artifact"):
            run_recipe("sft", {**SFT, "base_artifact": "sft@1"}, CHATS, self.tmpdir())
