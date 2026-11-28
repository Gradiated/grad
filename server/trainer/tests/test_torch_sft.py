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
    "eval_every_steps": 3,
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

    def test_merge_on_export_too_large_to_upload_fails_before_training(self) -> None:
        from unittest import mock

        from grad_trainer.errors import RecipeConfigError

        config = {**CONFIG, "adapter": {**CONFIG["adapter"], "merge_on_export": True}}
        rec = Recorder(self.tmpdir())
        with mock.patch("grad_trainer.bundles.MAX_UPLOAD_BYTES", 1000):
            with self.assertRaisesRegex(RecipeConfigError, "merge_on_export=false"):
                run_recipe("sft", config, RECORDS, self.tmpdir(), recorder=rec)
        self.assertEqual(rec.metrics, [])

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


class GradientCheckpointingTests(TorchCase):
    """Regression: checkpointing was a silent no-op because the model stayed in eval mode,
    so default Qwen3-8B SFT ran out of memory on an 80 GB GPU (r6 GPU run)."""

    def test_apply_lora_with_checkpointing_trains_with_checkpointing_active(self) -> None:
        from grad_trainer.backends.torch_common import apply_lora

        model = apply_lora(load_base(), {"kind": "lora", "rank": 4, "alpha": 8}, gradient_checkpointing=True)
        self.assertTrue(model.training)
        base = model.get_base_model()
        self.assertTrue(base.is_activation_checkpointing)
        self.assertTrue(all(m.training for m in base.modules() if hasattr(m, "gradient_checkpointing")))


class MemoryTests(TorchCase):
    """r6 GPU run: chunked CE, varlen packing, micro-batch sizing and OOM classification."""

    def test_chunked_cross_entropy_matches_full_logits_with_gradients(self) -> None:
        import torch
        import torch.nn.functional as F

        from grad_trainer.backends import torch_common as tc

        torch.manual_seed(0)
        head = torch.nn.Linear(8, 50, bias=False)
        h = torch.randn(11, 8, requires_grad=True)
        targets = torch.randint(0, 50, (11,))
        full = F.cross_entropy(head(h).float(), targets, reduction="none")
        full.sum().backward()
        want_h, want_w = h.grad.clone(), head.weight.grad.clone()
        h.grad, head.weight.grad = None, None
        losses, correct = tc.chunked_cross_entropy(head, h, targets, chunk=3)
        losses.sum().backward()
        self.assertTrue(torch.allclose(losses, full, atol=1e-6))
        self.assertTrue(torch.allclose(h.grad, want_h, atol=1e-6))
        self.assertTrue(torch.allclose(head.weight.grad, want_w, atol=1e-6))
        self.assertEqual(correct.tolist(), (head(h).argmax(-1) == targets).tolist())
        empty, right = tc.chunked_cross_entropy(head, h[:0], targets[:0])
        self.assertEqual((empty.shape, right.shape), ((0,), (0,)))

    def test_varlen_packing_matches_the_dense_block_mask(self) -> None:
        import torch
        from transformers import AutoModelForCausalLM

        from fixtures.tiny_models import ensure_tiny_models
        from grad_trainer.backends import torch_common as tc

        path = str(ensure_tiny_models()[QWEN_ID])
        dense = AutoModelForCausalLM.from_pretrained(path, dtype=torch.float32, attn_implementation="sdpa")
        varlen = AutoModelForCausalLM.from_pretrained(path, dtype=torch.float32, attn_implementation=tc.VARLEN_ATTENTION)
        examples = [((5, 9, 12, 40, 7), (False, False, True, True, True)), ((8, 3, 3, 21), (False, True, True, True)), ((4, 6, 8), (False, True, True))]
        rows = [[0, 1], [2]]
        a = tc.collate_packed(rows, examples, 0, torch.device("cpu"))
        b = tc.collate_packed(rows, examples, 0, torch.device("cpu"), varlen=True)
        self.assertIsNone(b.attention_mask)
        self.assertEqual((b.input_ids.shape, b.cu_seqlens.tolist(), b.max_seqlen, b.tokens), ((1, 12), [0, 5, 9, 12], 5, a.tokens))
        la, sa, _ = tc.packed_token_losses(dense, a)
        lb, sb, _ = tc.packed_token_losses(varlen, b)
        la.sum().backward()
        lb.sum().backward()
        self.assertEqual(sa.tolist(), sb.tolist())
        self.assertTrue(torch.allclose(la, lb, atol=1e-5))
        ga = dense.model.layers[0].self_attn.q_proj.weight.grad
        gb = varlen.model.layers[0].self_attn.q_proj.weight.grad
        self.assertTrue(torch.allclose(ga, gb, atol=1e-5))
        # Unpacked calls (no cu_seqlens) fall back to SDPA.
        with torch.no_grad():
            ids = torch.tensor([[5, 9, 12, 40]])
            self.assertTrue(torch.allclose(dense(ids).logits, varlen(ids).logits, atol=1e-5))
        self.assertFalse(tc.use_varlen(torch.device("cpu")))  # CPU tests keep the dense path

    def test_default_micro_batch_tokens_scale_with_model_size(self) -> None:
        from unittest import mock

        from grad_trainer.backends import torch_common as tc

        for params, expected in ((0.6e9, 16384), (8.2e9, 16384), (14.8e9, 16384), (20e9, 8192), (32.8e9, 4096)):
            with mock.patch.object(tc, "parameter_count", return_value=int(params)):
                self.assertEqual(tc.default_micro_batch_tokens(None), expected, params)

    def test_out_of_memory_raises_a_typed_error_with_model_and_micro_batch(self) -> None:
        from unittest import mock

        import torch

        from grad_trainer.backends import torch_common as tc
        from grad_trainer.errors import GPUOutOfMemoryError

        def oom(*_args, **_kwargs):
            raise torch.OutOfMemoryError("CUDA out of memory. Tried to allocate 9.27 GiB")

        with mock.patch.object(tc, "packed_token_losses", oom):
            with self.assertRaises(GPUOutOfMemoryError) as caught:
                run_recipe("sft", {**CONFIG, "epochs": 1}, RECORDS, self.tmpdir())
        err = caught.exception
        self.assertEqual((err.model, err.micro_batch_tokens, err.gpu, err.code), (QWEN_ID, 16384, "CPU", "gpu_out_of_memory"))
        self.assertIn(f"Out of GPU memory training {QWEN_ID} with micro_batch_tokens=16384", str(err))
        with mock.patch.object(tc, "packed_token_losses", oom):
            with self.assertRaises(GPUOutOfMemoryError) as caught:
                run_recipe("sft", {**CONFIG, "epochs": 1, "micro_batch_tokens": 4096}, RECORDS, self.tmpdir())
        self.assertEqual(caught.exception.micro_batch_tokens, 4096)


class SnapshotCheckpointTests(TorchCase):
    def test_a_snapshot_writes_the_same_checkpoint_as_the_live_weights_and_stays_frozen(self) -> None:
        import torch
        from safetensors.torch import load_file

        from grad_trainer.config import parse_train_spec
        from grad_trainer.recipes.sft import SFTTask

        spec = parse_train_spec("sft", {**CONFIG, "max_seq_len": 64})
        task = SFTTask(spec, RECORDS[:8], [], self.tmpdir())
        task.train_step(list(range(4)), 1e-2)
        snap = task.snapshot()
        live = self.tmpdir()
        task.export(live)
        task.save_weights(live / "weights")
        task.save_state(live / "state")
        task.train_step(list(range(4, 8)), 1e-2)  # training moves on before the snapshot is written
        written = self.tmpdir()
        task.write_snapshot(snap, written, written / "weights", written / "state")
        for rel in ("adapter_model.safetensors", "weights/weights.safetensors"):
            a, b = load_file(str(live / rel)), load_file(str(written / rel))
            self.assertEqual(set(a), set(b))
            for key in a:
                self.assertTrue(torch.equal(a[key], b[key]), (rel, key))
        self.assertEqual((written / "adapter_config.json").read_text(), (live / "adapter_config.json").read_text())
        a = torch.load(live / "state" / "state.pt", weights_only=True)["optimizer"]["state"]
        b = torch.load(written / "state" / "state.pt", weights_only=True)["optimizer"]["state"]
        self.assertTrue(all(torch.equal(a[k]["exp_avg"], b[k]["exp_avg"]) for k in a))
