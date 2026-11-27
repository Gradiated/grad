"""SFT on a tiny real Qwen3: masking, packing, accumulation, export, resume and budget (torch)."""

from __future__ import annotations

import json
import math

from helpers import QWEN_ID, BERT_ID, Recorder, TorchCase, run_recipe

from grad_trainer.errors import RecipeConfigError, RecipeDataError
from grad_trainer.runner_types import ResumeState

RECORDS = [
    {
        "id": f"r{i}",
        "session_id": f"s{i}",
        "messages": [
            {"role": "system", "content": "Be brief."},
            {"role": "user", "content": f"How do I reset my password {i}?"},
            {"role": "assistant", "content": "<think>settings</think>Open Settings and choose Reset Password."},
        ],
    }
    for i in range(24)
] + [
    {"id": f"n{i}", "prompt": f"translate hello {i}", "expected_output": "bonjour"} for i in range(6)
]
CONFIG = {
    "model": QWEN_ID,
    "batch_size": 4,
    "epochs": 2,
    "lr": 5e-3,
    "warmup": 0.0,
    "checkpoint_every_steps": 3,
    "adapter": {"kind": "lora", "rank": 4, "alpha": 8},
    "split": {"eval_fraction": 0.2, "seed": 1},
}


def load_base():
    import torch
    from transformers import AutoModelForCausalLM

    from fixtures.tiny_models import ensure_tiny_models

    return AutoModelForCausalLM.from_pretrained(str(ensure_tiny_models()[QWEN_ID]), dtype=torch.float32).eval()


def adapter_weights(directory):
    from safetensors.torch import load_file

    return load_file(str(directory / "adapter_model.safetensors"))


class SFTTests(TorchCase):
    def test_trains_and_exports_a_loadable_peft_adapter(self) -> None:
        import torch
        from peft import PeftModel

        rec = Recorder(self.tmpdir())
        out = run_recipe("sft", CONFIG, RECORDS, self.tmpdir(), recorder=rec)
        self.assertEqual((out.status, out.artifact_format), ("completed", "peft_lora"))
        evals = [m["eval_metrics"]["eval_loss"] for m in rec.metrics if "eval_metrics" in m]
        self.assertLess(evals[-1], evals[0])
        self.assertLess(rec.metrics[-1]["loss"], rec.metrics[0]["loss"])
        self.assertEqual(out.eval_report["eval_loss"], min(evals))
        self.assertEqual(out.tokens_processed, rec.metrics[-1]["tokens"])

        config = json.loads((out.artifact_dir / "adapter_config.json").read_text())
        self.assertEqual((config["r"], config["lora_alpha"], config["peft_type"]), (4, 8, "LORA"))
        self.assertEqual(config["target_modules"], sorted(["q_proj", "k_proj", "v_proj", "o_proj", "gate_proj", "up_proj", "down_proj"]))
        self.assertEqual(config["task_type"], "CAUSAL_LM")
        weights = adapter_weights(out.artifact_dir)
        self.assertEqual(len(weights), 2 * 7 * 2)  # A and B, 7 modules, 2 layers
        a = weights["base_model.model.model.layers.0.self_attn.q_proj.lora_A.weight"]
        b = weights["base_model.model.model.layers.0.self_attn.q_proj.lora_B.weight"]
        self.assertEqual((tuple(a.shape), tuple(b.shape)), ((4, 32), (32, 4)))
        self.assertGreater(float(b.abs().sum()), 0.0)

        base = load_base()
        ids = torch.tensor([[1, 5, 9, 12, 40]])
        with torch.no_grad():
            before = base(input_ids=ids).logits
            after = PeftModel.from_pretrained(base, str(out.artifact_dir)).eval()(input_ids=ids).logits
        self.assertGreater(float((after - before).abs().max()), 1e-4)

        report = out.eval_report
        self.assertEqual((report["train_examples"], report["skipped_no_trained_tokens"]), (report["train_records"], 0))
        self.assertGreater(report["trained_token_fraction"], 0.1)
        self.assertEqual(out.manifest["packing"], "block_diagonal")
        self.assertEqual([c[0] for c in rec.checkpoints], [3, 6, 9, 12])
        promoted = rec.checkpoints[0][2]
        self.assertTrue((promoted / "adapter_config.json").is_file())
        self.assertTrue((promoted / "trainer_state" / "task" / "state.pt").is_file())

    def test_merge_on_export_matches_the_adapter(self) -> None:
        import torch
        from transformers import AutoModelForCausalLM

        config = {**CONFIG, "epochs": 1, "adapter": {**CONFIG["adapter"], "merge_on_export": True}}
        rec = Recorder(self.tmpdir())
        out = run_recipe("sft", config, RECORDS, self.tmpdir(), recorder=rec)
        self.assertEqual(out.artifact_format, "merged_safetensors")
        self.assertTrue((out.artifact_dir / "model.safetensors").is_file())
        self.assertTrue((out.artifact_dir / "tokenizer.json").is_file())
        merged = AutoModelForCausalLM.from_pretrained(str(out.artifact_dir)).eval()
        from peft import PeftModel

        adapter_dir = rec.checkpoints[-1][2]  # checkpoints stay PEFT adapters
        self.assertEqual(rec.checkpoints[-1][3]["manifest"]["format"], "peft_lora")
        peft_model = PeftModel.from_pretrained(load_base(), str(adapter_dir)).eval()
        ids = torch.tensor([[3, 7, 11, 2]])
        with torch.no_grad():
            self.assertLess(float((merged(input_ids=ids).logits - peft_model(input_ids=ids).logits).abs().max()), 1e-4)

    def test_packing_has_no_cross_example_attention(self) -> None:
        import torch

        from grad_trainer.backends import torch_common as tc

        lm = load_base()
        examples = [((5, 9, 12, 40, 7), (False, False, True, True, True)), ((8, 3, 3, 21), (False, True, True, True))]
        packed = tc.collate_packed([[0, 1]], examples, 0, torch.device("cpu"))
        self.assertEqual(packed.input_ids.shape, (1, 9))
        with torch.no_grad():
            losses, seg, _ = tc.packed_token_losses(lm, packed)
            singles = [tc.packed_token_losses(lm, tc.collate_packed([[i]], examples, 0, torch.device("cpu")))[0] for i in (0, 1)]
        self.assertEqual(seg.tolist(), [0, 0, 0, 1, 1, 1])
        self.assertTrue(torch.allclose(losses, torch.cat(singles), atol=1e-5))
        # Only next tokens inside trained spans are scored: 3 + 3 targets.
        self.assertEqual(len(losses), sum(sum(t[1:]) for _, t in examples))
        self.assertEqual(tc.pack_rows([5, 4, 3, 2], 7), [[0, 3], [1, 2]])
        self.assertEqual(tc.group_rows([[0], [1], [2]], [4, 4, 4], 8), [[[0], [1]], [[2]]])

    def test_gradient_accumulation_is_exact(self) -> None:
        import torch

        from grad_trainer.recipes.sft import SFTTask
        from grad_trainer.config import parse_train_spec

        grads = []
        for micro in (8, 100_000):
            spec = parse_train_spec("sft", {**CONFIG, "micro_batch_tokens": micro, "max_seq_len": 64})
            task = SFTTask(spec, RECORDS[:8], [], self.tmpdir())
            task.accumulate(list(range(8)))
            grads.append(torch.cat([p.grad.flatten() for p in task.params.values() if p.grad is not None]))
        self.assertTrue(torch.allclose(grads[0], grads[1], atol=1e-6))

    def test_per_token_reduction_and_truncation(self) -> None:
        out = run_recipe(
            "sft", {**CONFIG, "epochs": 1, "reduction": "per_token", "max_seq_len": 24}, RECORDS, self.tmpdir()
        )
        self.assertEqual(out.status, "completed")
        self.assertGreater(out.eval_report["truncated"], 0)
        self.assertTrue(any("truncated" in w for w in out.eval_report["warnings"]))

    def test_resume_continues_exactly(self) -> None:
        import torch

        full = run_recipe("sft", CONFIG, RECORDS, self.tmpdir())
        rec = Recorder(self.tmpdir(), stop_after=5)
        first = run_recipe("sft", CONFIG, RECORDS, self.tmpdir(), recorder=rec)
        self.assertEqual((first.status, rec.checkpoints[-1][0]), ("cancelled", 5))
        second = run_recipe("sft", CONFIG, RECORDS, self.tmpdir(), resume=ResumeState(5, rec.checkpoints[-1][2]))
        self.assertEqual(second.status, "completed")
        self.assertEqual(first.tokens_processed + second.tokens_processed, full.tokens_processed)
        a, b = adapter_weights(full.artifact_dir), adapter_weights(second.artifact_dir)
        for key in a:
            self.assertTrue(torch.allclose(a[key], b[key], atol=1e-6), key)
        self.assertEqual(full.eval_report["best_step"], second.eval_report["best_step"])

    def test_budget_meters_real_tokens_and_stops_with_a_checkpoint(self) -> None:
        unlimited = Recorder(self.tmpdir())
        run_recipe("sft", CONFIG, RECORDS, self.tmpdir(), recorder=unlimited, price=1e6)  # $1 per token
        cap = unlimited.metrics[2]["tokens"] + 1
        rec = Recorder(self.tmpdir())
        out = run_recipe("sft", CONFIG, RECORDS, self.tmpdir(), recorder=rec, price=1e6, max_cost_usd=cap)
        self.assertEqual(out.status, "stopped_budget")
        self.assertEqual(len(rec.metrics), 3)
        self.assertEqual(out.tokens_processed, unlimited.metrics[2]["tokens"])
        self.assertLessEqual(rec.metrics[-1]["cost_usd"], cap)
        self.assertEqual(rec.checkpoints[-1][0], 3)
        self.assertEqual(out.manifest["steps_completed"], 3)

        self.assertTrue(math.isclose(unlimited.metrics[-1]["cost_usd"], unlimited.metrics[-1]["tokens"]))

    def test_tokens_are_tokenizer_tokens_of_the_rendered_chat(self) -> None:
        from transformers import AutoTokenizer

        from fixtures.tiny_models import ensure_tiny_models
        from grad_trainer.recipes.data import record_messages
        from grad_trainer.splits import split_records

        tok = AutoTokenizer.from_pretrained(str(ensure_tiny_models()[QWEN_ID]))
        train, _ = split_records(RECORDS, eval_fraction=0.2, seed=1)
        expected = sum(
            len(tok(tok.apply_chat_template(record_messages(r), tokenize=False), add_special_tokens=False)["input_ids"])
            for r in train
        )
        out = run_recipe("sft", {**CONFIG, "epochs": 1, "batch_size": len(train)}, RECORDS, self.tmpdir())
        self.assertEqual(out.tokens_processed, expected)

    def test_seeded_runs_are_deterministic(self) -> None:
        a = run_recipe("sft", {**CONFIG, "epochs": 1}, RECORDS, self.tmpdir())
        b = run_recipe("sft", {**CONFIG, "epochs": 1}, RECORDS, self.tmpdir())
        self.assertEqual(
            (a.artifact_dir / "adapter_model.safetensors").read_bytes(),
            (b.artifact_dir / "adapter_model.safetensors").read_bytes(),
        )

    def test_no_eval_split_reports_null(self) -> None:
        out = run_recipe("sft", {**CONFIG, "epochs": 1, "split": {"eval_fraction": 0.0}}, RECORDS, self.tmpdir())
        self.assertIsNone(out.eval_report["eval_loss"])
        self.assertEqual(out.manifest["select"], "last")
        self.assertTrue(any("null" in w for w in out.eval_report["warnings"]))

    def test_data_and_config_errors(self) -> None:
        thinking_off = {**CONFIG, "thinking": "off"}
        with self.assertRaisesRegex(RecipeDataError, "r0"):
            run_recipe("sft", thinking_off, RECORDS, self.tmpdir())
        with self.assertRaisesRegex(RecipeDataError, "at least one training record"):
            run_recipe("sft", CONFIG, [{"id": "x", "messages": [{"role": "user", "content": "q"}]}, {"id": "y"}], self.tmpdir())
        with self.assertRaisesRegex(RecipeConfigError, "encoder model"):
            run_recipe("sft", {**CONFIG, "model": BERT_ID}, RECORDS, self.tmpdir())
        with self.assertRaisesRegex(RecipeConfigError, "not found"):
            run_recipe("sft", {**CONFIG, "adapter": {"kind": "lora", "target_modules": ["c_attn"]}}, RECORDS, self.tmpdir())
        with self.assertRaisesRegex(RecipeConfigError, "prefix_kv"):
            run_recipe("sft", {**CONFIG, "adapter": {"kind": "prefix_kv"}}, RECORDS, self.tmpdir())
