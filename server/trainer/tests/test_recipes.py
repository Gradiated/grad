"""End-to-end tests for all 6 v0 recipes, checkpoint save/resume, and budget stop."""

from __future__ import annotations

import json
import unittest

from grad_trainer.bundles import read_artifact_bundle
from grad_trainer.recipes import RunCallbacks, get_recipe_runner
from grad_trainer.safetensors_io import decode_safetensors
from grad_trainer.trainer import CpuReferenceBackend, Trainer, TrainingExample


class RecipeTests(unittest.TestCase):
    def test_trainer_loss_decreases_and_checkpoint_resumes_identically(self) -> None:
        batch = [
            TrainingExample(text="reset password account settings", target=1.0, tokens=32),
            TrainingExample(text="delete billing subscription now", target=0.0, tokens=32),
        ]
        t1 = Trainer(model="qwen/qwen3-8b", backend=CpuReferenceBackend(dim=32))
        first = t1.forward_backward(batch, lr=0.2)
        t1.optim_step(0.2)
        for _ in range(8):
            res = t1.forward_backward(batch, lr=0.2)
            t1.optim_step(0.2)
        self.assertLess(res.loss, first.loss)

        saved = t1.save_state()
        t2 = Trainer(model="qwen/qwen3-8b", backend=CpuReferenceBackend(dim=32))
        t2.resume_state(saved)
        self.assertEqual(t2.step, t1.step)
        self.assertEqual(t2.tokens_processed, t1.tokens_processed)
        self.assertEqual(
            t2.backend.predict("reset password"),
            t1.backend.predict("reset password"),
        )

    def test_all_six_v0_recipes(self) -> None:
        # 1. SFT
        sft_records = [
            {
                "id": f"sft_{i}",
                "session_id": f"sess_{i}",
                "messages": [
                    {"role": "user", "content": f"How do I reset password #{i}?"},
                    {"role": "assistant", "content": "Click Settings -> Reset Password."},
                ],
            }
            for i in range(12)
        ]
        checkpoints: list[int] = []
        sft_out = get_recipe_runner("sft").run(
            {
                "name": "support-sft",
                "model": "qwen/qwen3-8b",
                "batch_size": 4,
                "epochs": 2,
                "lr": 5e-3,
                "checkpoint_every_steps": 2,
                "split": {"strategy": "by_session", "eval_fraction": 0.2, "seed": 42},
            },
            sft_records,
            callbacks=RunCallbacks(
                on_checkpoint=lambda step, _score, _b, _m: checkpoints.append(step)
            ),
        )
        self.assertEqual(sft_out.status, "completed")
        self.assertEqual(sft_out.artifact_format, "peft_lora")
        self.assertGreater(len(checkpoints), 0)
        manifest, files = read_artifact_bundle(sft_out.artifact_bytes)
        self.assertIn("adapter_model.safetensors", files)
        self.assertEqual(manifest["recipe"], "sft")

        # 2. DPO
        dpo_records = [
            {
                "id": f"dpo_{i}",
                "session_id": f"ds_{i}",
                "prompt": f"Explain billing invoice #{i}",
                "chosen": "Here is a concise breakdown of your invoice line items.",
                "rejected": "Read the docs yourself.",
            }
            for i in range(10)
        ]
        dpo_out = get_recipe_runner("dpo").run(
            {
                "name": "tone-dpo",
                "model": "qwen/qwen3-8b",
                "batch_size": 4,
                "epochs": 2,
                "lr": 1e-2,
                "recipe_params": {"beta": 0.1},
            },
            dpo_records,
        )
        self.assertEqual(dpo_out.artifact_format, "peft_lora")
        self.assertIn("preference_accuracy", dpo_out.eval_report)

        # 3. Router (temperature calibration + Pareto threshold solver)
        router_records = [
            {
                "id": f"rt_{i}",
                "session_id": f"rs_{i}",
                "messages": [
                    {
                        "role": "user",
                        "content": "simple faq" if i % 2 == 0 else "complex distributed lock proof " * 10,
                    }
                ],
                "scores": {
                    "qwen/qwen3-8b": 0.96 if i % 2 == 0 else 0.40,
                    "qwen/qwen3-32b": 0.96,
                },
            }
            for i in range(20)
        ]
        router_out = get_recipe_runner("router").run(
            {
                "name": "support-router",
                "model": "qwen/qwen3-0.6b",
                "batch_size": 4,
                "epochs": 2,
                "lr": 1e-2,
                "recipe_params": {
                    "models": ["qwen/qwen3-8b", "qwen/qwen3-32b"],
                    "max_quality_drop": 0.05,
                },
            },
            router_records,
        )
        self.assertEqual(router_out.artifact_format, "router_bundle")
        r_manifest, r_files = read_artifact_bundle(router_out.artifact_bytes)
        rcfg = json.loads(r_files["router_config.json"].decode("utf-8"))
        self.assertIn("threshold", rcfg)
        self.assertIn("temperature", rcfg)
        self.assertEqual(r_manifest["router_config"]["fallback_model"], "qwen/qwen3-32b")

        # 4. Decision model
        dec_records = [
            {
                "id": f"dec_{i}",
                "session_id": f"decs_{i}",
                "state": {"retries": i % 3, "tool_errors": i % 2},
                "questions": {"should_escalate": {"kind": "choice", "options": ["yes", "no"]}},
                "scores": {"should_escalate": 1.0 if i % 2 == 1 else 0.0},
            }
            for i in range(12)
        ]
        dec_out = get_recipe_runner("decision").run(
            {
                "name": "escalation-dec",
                "model": "gradiated/linden-1",
                "batch_size": 4,
                "epochs": 2,
                "lr": 1e-2,
            },
            dec_records,
        )
        self.assertEqual(dec_out.artifact_format, "decision_bundle")
        self.assertIn("ece", dec_out.eval_report)

        # 5. Cartridge (gradiated.cartridge/1)
        cart_out = get_recipe_runner("cartridge").run(
            {
                "name": "handbook-cart",
                "model": "qwen/qwen3-8b",
                "batch_size": 4,
                "epochs": 1,
                "lr": 1e-2,
                "adapter": {"kind": "prefix_kv", "num_tokens": 32},
                "recipe_params": {"context_text": "Refunds allowed within 30 days."},
            },
            sft_records[:6],
        )
        self.assertEqual(cart_out.artifact_format, "cartridge")
        _, c_files = read_artifact_bundle(cart_out.artifact_bytes)
        c_meta, c_tensors = decode_safetensors(c_files["cartridge.safetensors"])
        self.assertEqual(c_meta["format"], "gradiated.cartridge/1")
        self.assertEqual(c_tensors["embeddings"].shape, (32, 64))

        # 6. Embedding (InfoNCE + mean pooling)
        emb_records = [
            {
                "id": f"emb_{i}",
                "query": f"reset password step {i}",
                "positive": f"go to account security reset password {i}",
            }
            for i in range(10)
        ]
        emb_out = get_recipe_runner("embedding").run(
            {
                "name": "docs-embed",
                "model": "baai/bge-small-en-v1.5",
                "batch_size": 4,
                "epochs": 2,
                "lr": 1e-2,
                "recipe_params": {"temp": 0.05},
            },
            emb_records,
        )
        self.assertEqual(emb_out.artifact_format, "encoder_safetensors")
        self.assertIn("recall_at_1", emb_out.eval_report)

    def test_budget_stop_exits_gracefully(self) -> None:
        records = [
            {
                "id": f"r_{i}",
                "messages": [
                    {"role": "user", "content": "hello " * 100},
                    {"role": "assistant", "content": "world " * 100},
                ],
            }
            for i in range(10)
        ]
        out = get_recipe_runner("sft").run(
            {
                "name": "budget-sft",
                "model": "qwen/qwen3-8b",
                "batch_size": 1,
                "epochs": 3,
                "lr": 5e-4,
            },
            records,
            max_cost_usd=0.00001,
        )
        self.assertEqual(out.status, "stopped_budget")
        self.assertLess(len(out.metrics), 20)

    def test_cancellation_stops_outer_epoch_loop_immediately(self) -> None:
        records = [
            {
                "id": f"c_{i}",
                "messages": [
                    {"role": "user", "content": f"q {i}"},
                    {"role": "assistant", "content": f"a {i}"},
                ],
            }
            for i in range(6)
        ]
        out = get_recipe_runner("sft").run(
            {
                "name": "cancel-sft",
                "model": "qwen/qwen3-8b",
                "batch_size": 2,
                "epochs": 5,
                "lr": 5e-4,
            },
            records,
            callbacks=RunCallbacks(on_step=lambda _metric: True),
        )
        self.assertEqual(out.status, "cancelled")
        self.assertEqual(len(out.metrics), 1)


if __name__ == "__main__":
    unittest.main()
