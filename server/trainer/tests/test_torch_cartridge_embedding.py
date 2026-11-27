"""Cartridge (context distillation into input embeddings) and embedding recipes (torch)."""

from __future__ import annotations

import json
import math

from helpers import BERT_ID, QWEN_ID, QWEN_TEACHER_ID, Recorder, TorchCase, run_recipe

from grad_trainer.errors import RecipeConfigError, RecipeDataError

CONTEXT = "To rotate an API key open Settings then API Keys and click Regenerate. Refunds take five days."
PROMPTS = [{"id": f"c{i}", "messages": [{"role": "user", "content": f"How do I rotate my API key {i}?"}]} for i in range(10)]
PROMPTS.append({"id": "sys", "messages": [{"role": "system", "content": "Be brief."}, {"role": "user", "content": "Refunds?"}, {"role": "assistant", "content": "ignored"}]})
CARTRIDGE = {
    "model": QWEN_ID,
    "batch_size": 4,
    "epochs": 3,
    "lr": 1e-2,
    "warmup": 0.0,
    "adapter": {"kind": "prefix_kv", "num_tokens": 8},
    "split": {"eval_fraction": 0.3, "seed": 4},
    "recipe_params": {"context_text": CONTEXT, "max_new_tokens": 6},
}


class CartridgeTests(TorchCase):
    def test_exports_cartridge_format_with_model_shapes(self) -> None:
        from safetensors import safe_open
        from transformers import AutoTokenizer

        import torch

        from fixtures.tiny_models import ensure_tiny_models

        rec = Recorder(self.tmpdir())
        out = run_recipe("cartridge", CARTRIDGE, PROMPTS, self.tmpdir(), recorder=rec)
        self.assertEqual((out.status, out.artifact_format), ("completed", "cartridge"))
        path = out.artifact_dir / "cartridge.safetensors"
        with safe_open(str(path), "pt") as fh:
            meta = fh.metadata()
            self.assertEqual(sorted(fh.keys()), ["embeddings", "slot_token_ids"])
            embeddings = fh.get_tensor("embeddings")
            slots = fh.get_tensor("slot_token_ids").tolist()
        self.assertEqual(meta["format"], "gradiated.cartridge/1")
        self.assertEqual((tuple(embeddings.shape), embeddings.dtype), ((8, 32), torch.bfloat16))
        self.assertEqual((meta["placement"], meta["separator"]), ("system_prompt_start", "\n\n"))
        tok = AutoTokenizer.from_pretrained(str(ensure_tiny_models()[QWEN_ID]))
        slot_text = meta["slot_token"] * 8
        self.assertEqual(tok(slot_text, add_special_tokens=False)["input_ids"], slots)
        self.assertEqual(out.manifest["slot_token"], "<|vision_pad|>")

        # Tokens: teacher prompts + answers are metered before training starts.
        self.assertGreater(rec.metrics[0]["tokens"], 0)
        self.assertLess(rec.metrics[-1]["loss"], rec.metrics[0]["loss"])
        report = out.eval_report
        self.assertIsNotNone(report["eval_kl"])
        self.assertIsNotNone(report["no_context_kl"])
        self.assertEqual((report["num_tokens"], report["hidden_size"], report["teacher"]), (8, 32, QWEN_ID))

    def test_larger_teacher_and_budget_before_preparation(self) -> None:
        out = run_recipe(
            "cartridge", {**CARTRIDGE, "epochs": 1, "recipe_params": {**CARTRIDGE["recipe_params"], "teacher": QWEN_TEACHER_ID}},
            PROMPTS, self.tmpdir(),
        )
        self.assertEqual(out.manifest["teacher"], QWEN_TEACHER_ID)
        stopped = run_recipe("cartridge", CARTRIDGE, PROMPTS, self.tmpdir(), max_cost_usd=1e-9)
        self.assertEqual((stopped.status, stopped.tokens_processed), ("stopped_budget", 0))
        self.assertIsNone(stopped.eval_report["eval_kl"])

    def test_topk_kl_math(self) -> None:
        import torch

        from grad_trainer.recipes.cartridge import topk_kl

        student = torch.log(torch.tensor([[0.5, 0.25, 0.25]]))
        teacher_ids = torch.tensor([[0, 1]])
        teacher_logp = torch.log(torch.tensor([[0.6, 0.2]]))  # renormalized to 0.75 / 0.25
        expected = 0.75 * math.log(0.75 / 0.5) + 0.25 * math.log(0.25 / 0.25)
        self.assertAlmostEqual(float(topk_kl(student, teacher_ids, teacher_logp)[0]), expected, places=6)

    def test_config_errors(self) -> None:
        params = CARTRIDGE["recipe_params"]
        cases = [
            ({"recipe_params": {}}, "non-empty context"),
            ({"recipe_params": {**params, "teacher": BERT_ID}}, "causal_lm model"),
            ({"adapter": {"kind": "prefix_kv", "num_tokens": 4096}}, "context length"),
            ({"recipe_params": {**params, "slot_token": "<nope>"}}, "slot token"),
            ({"recipe_params": {**params, "max_new_tokens": 0}}, "positive"),
        ]
        for change, message in cases:
            with self.subTest(message), self.assertRaisesRegex(RecipeConfigError, message):
                run_recipe("cartridge", {**CARTRIDGE, **change}, PROMPTS, self.tmpdir())
        with self.assertRaisesRegex(RecipeDataError, "prompts"):
            run_recipe("cartridge", CARTRIDGE, [{"messages": [{"role": "assistant", "content": "a"}]}], self.tmpdir())
        with self.assertRaisesRegex(RecipeDataError, "slot token"):
            run_recipe("cartridge", CARTRIDGE, [{"messages": [{"role": "user", "content": "<|vision_pad|>"}]}], self.tmpdir())


TRIPLETS = [
    {"id": f"e{i}", "query": f"rotate api key {i}", "positive": f"open settings api keys regenerate {i}", "negatives": [f"create api key new {i}"]}
    for i in range(30)
] + [{"id": "bad", "query": "", "positive": "x"}, {"id": "dup", "query": "rotate api key 0", "positive": "open settings api keys regenerate 0"}]
EMBEDDING = {"model": BERT_ID, "batch_size": 8, "epochs": 2, "lr": 1e-3, "warmup": 0.0, "split": {"eval_fraction": 0.3, "seed": 1}}


class EmbeddingTests(TorchCase):
    def test_full_finetune_with_recall_report_and_loadable_encoder(self) -> None:
        import torch
        from transformers import AutoModel

        from fixtures.tiny_models import ensure_tiny_models

        out = run_recipe("embedding", EMBEDDING, TRIPLETS, self.tmpdir())
        self.assertEqual((out.status, out.artifact_format), ("completed", "encoder_safetensors"))
        report = out.eval_report
        for key in ("recall_at_1", "recall_at_5", "recall_at_10", "mrr"):
            self.assertTrue(0.0 <= report[key] <= 1.0, key)
        self.assertGreaterEqual(report["recall_at_10"], report["baseline"]["recall_at_10"])
        self.assertEqual(report["dropped_records"], 1)
        self.assertEqual(out.manifest["dimensions"], 32)
        pooling = json.loads((out.artifact_dir / "1_Pooling" / "config.json").read_text())
        self.assertTrue(pooling["pooling_mode_mean_tokens"])
        trained = AutoModel.from_pretrained(str(out.artifact_dir)).eval()
        base = AutoModel.from_pretrained(str(ensure_tiny_models()[BERT_ID])).eval()
        ids = torch.tensor([[2, 10, 11, 3]])
        with torch.no_grad():
            delta = (trained(input_ids=ids).last_hidden_state - base(input_ids=ids).last_hidden_state).abs().max()
        self.assertGreater(float(delta), 1e-4)

    def test_info_nce_masks_duplicate_documents(self) -> None:
        import torch
        import torch.nn.functional as F

        from grad_trainer.recipes.embedding import info_nce

        q = F.normalize(torch.tensor([[1.0, 0.0], [0.0, 1.0]]), dim=-1)
        d = F.normalize(torch.tensor([[1.0, 0.0], [0.0, 1.0], [1.0, 0.0]]), dim=-1)
        same = torch.tensor([[True, False, True], [False, True, False]])  # doc 2 duplicates query 0's positive
        loss = info_nce(q, d, [0, 1], same, 1.0)
        self.assertAlmostEqual(float(loss[0]), math.log(1 + math.exp(-1)), places=5)
        self.assertAlmostEqual(float(loss[1]), math.log(1 + 2 * math.exp(-1)), places=5)

    def test_cls_pooling_null_eval_and_errors(self) -> None:
        out = run_recipe(
            "embedding", {**EMBEDDING, "epochs": 1, "split": {"eval_fraction": 0.0}, "recipe_params": {"pool": {"kind": "cls"}, "temp": 0.03}},
            TRIPLETS, self.tmpdir(),
        )
        self.assertIsNone(out.eval_report["recall_at_10"])
        self.assertIsNone(out.eval_report["baseline"])
        self.assertEqual(out.manifest["pooling"], "cls")
        self.assertEqual(out.manifest["loss"], {"kind": "infonce", "temp": 0.03})
        for change, message in (
            ({"recipe_params": {"pool": "max"}}, "pooling"),
            ({"recipe_params": {"temp": 0}}, "temp"),
            ({"adapter": {"kind": "lora"}}, "encoder_full"),
            ({"model": QWEN_ID}, "encoder model"),
        ):
            with self.subTest(message), self.assertRaisesRegex(RecipeConfigError, message):
                run_recipe("embedding", {**EMBEDDING, **change}, TRIPLETS, self.tmpdir())
        with self.assertRaisesRegex(RecipeDataError, "query"):
            run_recipe("embedding", EMBEDDING, [{"query": "q"}], self.tmpdir())
