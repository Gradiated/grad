"""Recipes, specs and records serialise to exactly what the RecipeSpec / DatasetRecord contract accepts."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

import _fakes  # noqa: F401

import grad
from grad import Context, PreferencePair, Record, Task, Trajectory, Triplet, adapters, losses, optim, pooling, splits
from grad._generated.client import SCHEMA_FIELDS
from grad.recipes import (
    CartridgeRecipe,
    DecisionModelRecipe,
    DistillRecipe,
    DPORecipe,
    EmbeddingRecipe,
    GRPORecipe,
    OffPolicy,
    OnPolicy,
    RewardModelRecipe,
    RouterRecipe,
    SFTRecipe,
    coerce_recipe,
    recipe_fields,
)
from grad.records import MAX_CONTEXT_CHARS, coerce_record

RECIPE_FIELDS = SCHEMA_FIELDS["RecipeSpec"]
RECORD_FIELDS = SCHEMA_FIELDS["DatasetRecord"]


class RecipeTests(unittest.TestCase):
    def assert_contract(self, spec: dict) -> None:
        self.assertTrue(set(spec) <= RECIPE_FIELDS, set(spec) - RECIPE_FIELDS)
        if "adapter" in spec:
            self.assertTrue(set(spec["adapter"]) <= {"kind", "rank", "alpha", "merge_on_export", "num_tokens"})

    def test_only_set_fields_are_sent(self) -> None:
        self.assertEqual(SFTRecipe().to_spec(), {"kind": "sft"})
        spec = SFTRecipe(model="qwen/qwen3-8b", lr=1e-4, lr_scale=2.0, batch_size=64, epochs=2, schedule="cosine", warmup=0.1, train_on="all_assistant", thinking="off", preserve_thinking=True, reduction="per_token", select="last", checkpoint_ttl_days=7).to_spec()
        self.assert_contract(spec)
        self.assertEqual(spec["thinking"], "off")
        self.assertEqual(spec["lr"], 1e-4)
        self.assertEqual(SFTRecipe(thinking="on").to_spec()["thinking"], "on")
        self.assertEqual(SFTRecipe(thinking=True).to_spec()["thinking"], "on")  # the server takes only auto/on/off
        self.assertEqual(SFTRecipe(thinking="auto").to_spec()["thinking"], "auto")

    def test_sft_merge_on_export_and_adapter(self) -> None:
        spec = SFTRecipe(merge_on_export=True).to_spec()
        self.assertEqual(spec["adapter"], {"kind": "lora", "rank": 32, "alpha": 32, "merge_on_export": True})
        spec = SFTRecipe(adapter=adapters.LoRA(rank=64), merge_on_export=False).to_spec()
        self.assertEqual(spec["adapter"]["rank"], 64)
        self.assertFalse(spec["adapter"]["merge_on_export"])
        self.assertEqual(SFTRecipe(adapter=adapters.LoRA(rank=8, merge_on_export=True)).to_spec()["adapter"]["merge_on_export"], True)
        with self.assertRaises(ValueError):
            SFTRecipe(adapter=adapters.PrefixKV(), merge_on_export=True)
        self.assertEqual(SFTRecipe(loss=losses.CrossEntropy("per_token")).to_spec()["reduction"], "per_token")
        with self.assertRaises(ValueError):
            SFTRecipe(loss=losses.CrossEntropy("per_token"), reduction="per_example")
        with self.assertRaises(grad.NotAvailableInV0Error):
            SFTRecipe(loss=losses.DPO())

    def test_dpo_loss(self) -> None:
        self.assertEqual(DPORecipe(loss=losses.DPO(beta=0.3)).to_spec(), {"kind": "dpo", "beta": 0.3})
        self.assertEqual(DPORecipe(beta=0.2).to_spec()["beta"], 0.2)
        self.assertEqual(DPORecipe(loss={"kind": "dpo", "beta": 0.4}).to_spec()["beta"], 0.4)
        with self.assertRaises(ValueError):
            DPORecipe(loss=losses.DPO(beta=0.3), beta=0.2)
        with self.assertRaises(ValueError):
            DPORecipe(beta=-1)
        with self.assertRaises(grad.NotAvailableInV0Error):
            DPORecipe(loss=losses.InfoNCE())

        class SimPO(losses.CustomLoss):
            pass

        with self.assertRaises(grad.NotAvailableInV0Error):
            DPORecipe(loss=SimPO())  # type: ignore[arg-type]

    def test_router(self) -> None:
        self.assertEqual(RouterRecipe().to_spec(), {"kind": "router"})
        artifact = grad.Artifact.from_api({"id": "x@1", "name": "x", "version": "1"})
        spec = RouterRecipe(model="qwen/qwen3-0.6b", models=["qwen/qwen3-8b", artifact], max_quality_drop=0.05).to_spec()
        self.assertEqual(spec, {"kind": "router", "model": "qwen/qwen3-0.6b", "models": ["qwen/qwen3-8b", "x@1"], "max_quality_drop": 0.05})
        self.assert_contract(spec)
        labelled = RouterRecipe(rubric="resolved", pricing={"cheap/m": 0.001, "strong/m": 1}, fallback="strong/m").to_spec()
        self.assertEqual(labelled, {"kind": "router", "rubric": "resolved", "pricing": {"cheap/m": 0.001, "strong/m": 1.0}, "fallback": "strong/m"})
        self.assert_contract(labelled)
        judged = RouterRecipe(models=["a/b", "c/d"], rubric=grad.Judge(model="m/judge", name="resolved", prompt="Solved?")).to_spec()
        self.assertEqual(judged["rubric"], [{"name": "resolved", "kind": "judge", "model": "m/judge", "prompt": "Solved?", "weight": 1.0}])
        self.assert_contract(judged)
        with self.assertRaises(ValueError):
            RouterRecipe(rubric=grad.Judge(model="m", name="resolved"))
        with self.assertRaises(grad.NotAvailableInV0Error) as ctx:
            RouterRecipe(models=["a/b", "c/d"], rubric=grad.Scorer("x", fn=lambda t: 1.0))
        self.assertIn("sandbox", str(ctx.exception))
        with self.assertRaises(ValueError):
            RouterRecipe(pricing={"a/b": -1})
        with self.assertRaises(ValueError):
            RouterRecipe(models=["one"])
        with self.assertRaises(ValueError):
            RouterRecipe(max_quality_drop=0.9)

    def test_decision_split_goes_to_the_run(self) -> None:
        recipe = DecisionModelRecipe(model="gradiated/linden-1", split=splits.BySession(eval_fraction=0.15))
        spec, split = coerce_recipe(recipe)
        self.assertEqual(spec, {"kind": "decision", "model": "gradiated/linden-1"})
        self.assertEqual(split, {"strategy": "by_session", "eval_fraction": 0.15})
        with self.assertRaises(grad.NotAvailableInV0Error):
            DecisionModelRecipe(loss=losses.CrossEntropy())

    def test_cartridge_context(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            doc = Path(tmp) / "docs.md"
            doc.write_text("# API\nUse keys.")
            spec = CartridgeRecipe(model="qwen/qwen3-8b", context=Context.from_file(doc), num_tokens=512, teacher="qwen/qwen3-32b").to_spec()
        self.assertEqual(spec, {"kind": "cartridge", "model": "qwen/qwen3-8b", "context_text": "# API\nUse keys.", "num_tokens": 512, "teacher": "qwen/qwen3-32b"})
        self.assertEqual(CartridgeRecipe(context=Context.from_uri("s3://b/k")).to_spec()["context_uri"], "s3://b/k")
        self.assertEqual(CartridgeRecipe(context="inline text").to_spec()["context_text"], "inline text")
        self.assertEqual(CartridgeRecipe(context=Context.from_text("t"), loss=losses.TopKKLDistill(top_k=20)).to_spec()["kind"], "cartridge")
        with self.assertRaises(ValueError):
            CartridgeRecipe()
        with self.assertRaises(TypeError):
            CartridgeRecipe(context=5)  # type: ignore[arg-type]
        tuned = CartridgeRecipe(context="t", loss=losses.TopKKLDistill(top_k=32), max_new_tokens=64).to_spec()
        self.assertEqual((tuned["loss"], tuned["max_new_tokens"]), ({"kind": "top_k_kl_distill", "top_k": 32}, 64))
        self.assert_contract(tuned)
        with self.assertRaises(grad.NotAvailableInV0Error):
            CartridgeRecipe(context="t", loss=losses.InfoNCE())
        with self.assertRaises(ValueError):
            CartridgeRecipe(context="t", num_tokens=8)

    def test_context_validation(self) -> None:
        with self.assertRaises(ValueError):
            Context()
        with self.assertRaises(ValueError):
            Context(text="a", uri="s3://x")
        with self.assertRaises(ValueError):
            Context.from_text("   ")
        with self.assertRaises(ValueError):
            Context.from_uri("not-a-uri")
        with self.assertRaises(ValueError):
            Context.from_text("x" * (MAX_CONTEXT_CHARS + 1))

    def test_embedding(self) -> None:
        self.assertEqual(EmbeddingRecipe(pool=pooling.Mean(), loss=losses.InfoNCE(temp=0.03)).to_spec(), {"kind": "embedding", "temp": 0.03})
        self.assertEqual(EmbeddingRecipe(temp=0.1).to_spec()["temp"], 0.1)
        self.assertEqual(EmbeddingRecipe(pool=pooling.CLS()).to_spec(), {"kind": "embedding", "pool": {"kind": "cls"}})
        with self.assertRaises(grad.NotAvailableInV0Error):
            EmbeddingRecipe(pool=pooling.LastToken())
        with self.assertRaises(grad.NotAvailableInV0Error):
            EmbeddingRecipe(loss=losses.DPO())
        with self.assertRaises(ValueError):
            EmbeddingRecipe(loss=losses.InfoNCE(temp=0.03), temp=0.05)
        with self.assertRaises(ValueError):
            EmbeddingRecipe(temp=0)

    def test_optimizer(self) -> None:
        self.assertEqual(SFTRecipe(optimizer=optim.AdamW(lr=5e-4)).to_spec()["lr"], 5e-4)
        self.assertNotIn("lr", SFTRecipe(optimizer=optim.AdamW()).to_spec())
        self.assertEqual(SFTRecipe(optimizer={"kind": "adamw", "lr": 1e-3}).to_spec()["lr"], 1e-3)
        tuned = SFTRecipe(optimizer=optim.AdamW(betas=(0.8, 0.9), weight_decay=0.01, grad_clip=0.5), eval_every=25).to_spec()
        self.assertEqual(tuned["optimizer"], {"kind": "adamw", "betas": [0.8, 0.9], "weight_decay": 0.01, "grad_clip": 0.5})
        self.assertEqual(tuned["eval_every"], 25)
        self.assert_contract(tuned)
        self.assertNotIn("eval_every", SFTRecipe(eval_every="auto").to_spec())
        with self.assertRaises(ValueError):
            SFTRecipe(eval_every=0)
        with self.assertRaises(grad.NotAvailableInV0Error):
            SFTRecipe(optimizer={"kind": "sgd"})
        with self.assertRaises(ValueError):
            SFTRecipe(lr=1e-3, optimizer=optim.AdamW(lr=5e-4))
        with self.assertRaises(ValueError):
            optim.AdamW(lr=-1)
        with self.assertRaises(grad.NotAvailableInV0Error):
            optim.AdamW(param_groups=[1])
        with self.assertRaises(grad.NotAvailableInV0Error):
            optim.ParamGroup()
        with self.assertRaises(grad.NotAvailableInV0Error):
            optim.WeightAnchor()
        defaults = optim.AdamW()
        self.assertEqual((defaults.betas, defaults.weight_decay, defaults.grad_clip), ((0.9, 0.95), 0.0, 1.0))

    def test_unsupported_common_settings(self) -> None:
        with self.assertRaises(TypeError):
            SFTRecipe(evals=[{"name": "ifeval"}])  # type: ignore[call-arg]
        self.assertEqual(SFTRecipe(eval_every="auto").to_spec(), {"kind": "sft"})
        with self.assertRaises(ValueError):
            SFTRecipe(thinking="high")
        with self.assertRaises(ValueError):
            SFTRecipe(thinking="maybe")  # type: ignore[arg-type]

    def test_grpo_is_typed_but_refuses_to_submit(self) -> None:
        recipe = GRPORecipe(model="qwen/qwen3-4b", rubric=grad.Rubric([grad.Judge(model="m")]), group_size=16, kl_coef=0.01, max_staleness=1, advantage=grad.advantages.GroupStd())
        with self.assertRaises(grad.NotAvailableInV0Error) as ctx:
            coerce_recipe(recipe)
        self.assertIn("Wave 2", str(ctx.exception))
        self.assertEqual(GRPORecipe().max_new_tokens, "auto")
        self.assertEqual(GRPORecipe().temperature, 1.0)

    def test_distill_recipe_wire_fields(self) -> None:
        on = DistillRecipe(model="qwen/qwen3-4b", teacher="qwen/qwen3-32b", rollout=OnPolicy(max_new_tokens=128), loss=losses.TopKKLDistill(top_k=16), context=Context.from_text("x"))
        self.assertEqual(
            on.to_spec(),
            {
                "kind": "distill",
                "model": "qwen/qwen3-4b",
                "teacher": "qwen/qwen3-32b",
                "rollout": {"kind": "on_policy", "max_new_tokens": 128},
                "loss": {"kind": "top_k_kl_distill", "top_k": 16},
                "context_text": "x",
            },
        )
        art = grad.Artifact.from_api({"id": "big@1", "name": "big", "version": "1"})
        off = DistillRecipe(teacher=art, rollout=OffPolicy(max_new_tokens=64), loss=losses.CrossEntropy())
        self.assertEqual(off.to_spec(), {"kind": "distill", "teacher": "big@1", "rollout": {"kind": "off_policy", "max_new_tokens": 64}, "loss": {"kind": "cross_entropy"}})
        self.assertEqual(DistillRecipe(teacher="t", rollout=OnPolicy()).to_spec()["rollout"], {"kind": "on_policy"})
        self.assertEqual(DistillRecipe(teacher="t", rollout={"kind": "off_policy"}).to_spec()["rollout"], {"kind": "off_policy"})
        self.assertEqual(DistillRecipe(teacher="t", context="doc").to_spec()["context_text"], "doc")
        with self.assertRaises(ValueError):
            DistillRecipe()
        for bad in (
            lambda: DistillRecipe(teacher="t", rollout={"kind": "x"}),
            lambda: DistillRecipe(teacher="t", rollout=OffPolicy(), context="doc"),
            lambda: OnPolicy(max_new_tokens=0),
            lambda: OffPolicy(max_new_tokens=True),  # type: ignore[arg-type]
        ):
            with self.assertRaises(ValueError):
                bad()
        with self.assertRaises(grad.NotAvailableInV0Error):
            DistillRecipe(teacher="t", loss=losses.CrossEntropy())
        with self.assertRaises(grad.NotAvailableInV0Error):
            DistillRecipe(teacher="t", rollout=OffPolicy(), loss=losses.TopKKLDistill())
        with self.assertRaises(TypeError):
            DistillRecipe(teacher="t", context=3)  # type: ignore[arg-type]
        self.assertIn("teacher", recipe_fields(DistillRecipe))

    def test_reward_model_recipe_wire_fields(self) -> None:
        self.assertEqual(RewardModelRecipe().to_spec(), {"kind": "reward"})
        self.assertEqual(
            RewardModelRecipe(model="qwen/qwen3-8b", adapter=adapters.LoRA(rank=8), rubric="resolved").to_spec(),
            {"kind": "reward", "model": "qwen/qwen3-8b", "adapter": {"kind": "lora", "rank": 8, "alpha": 32, "merge_on_export": False}, "rubric": "resolved"},
        )
        with self.assertRaises(grad.NotAvailableInV0Error):
            RewardModelRecipe(rubric=grad.Judge(model="m"))  # type: ignore[arg-type]

    def test_dict_recipes_are_checked_against_the_contract(self) -> None:
        spec, split = coerce_recipe({"kind": "sft", "lr": 1e-4, "split": splits.Random(0.2, seed=1), "adapter": adapters.LoRA(rank=8)})
        self.assertEqual(spec["adapter"]["rank"], 8)
        self.assertEqual(split, {"strategy": "random", "eval_fraction": 0.2, "seed": 1})
        with self.assertRaises(ValueError) as ctx:
            coerce_recipe({"kind": "sft", "lerning_rate": 1})
        self.assertIn("lerning_rate", str(ctx.exception))
        with self.assertRaises(ValueError) as ctx:
            coerce_recipe({"kind": "sft", "lr_scal": 1})
        self.assertIn("did you mean 'lr_scale'", str(ctx.exception))
        with self.assertRaises(ValueError):
            coerce_recipe({"model": "x"})
        with self.assertRaises(grad.NotAvailableInV0Error):
            coerce_recipe({"kind": "grpo"})
        with self.assertRaises(TypeError):
            coerce_recipe("sft")
        art = grad.Artifact.from_api({"id": "a@1", "name": "a", "version": "1"})
        self.assertEqual(coerce_recipe({"kind": "dpo", "model": art})[0]["model"], "a@1")
        self.assertEqual(DPORecipe(model=art).to_spec()["model"], "a@1")


class SpecTests(unittest.TestCase):
    def test_adapters(self) -> None:
        self.assertEqual(adapters.PrefixKV(512).to_dict(), {"kind": "prefix_kv", "num_tokens": 512})
        self.assertEqual(adapters.FrozenHead().to_dict(), {"kind": "frozen_head"})
        for bad in (lambda: adapters.LoRA(rank=0), lambda: adapters.LoRA(alpha=1000), lambda: adapters.PrefixKV(8)):
            with self.assertRaises(ValueError):
                bad()
        with self.assertRaises(grad.NotAvailableInV0Error):
            adapters.Full()

    def test_losses_and_splits(self) -> None:
        self.assertEqual(losses.GRPO(mask_ratio=(0.5, 2.0)).to_dict(), {"kind": "grpo", "clip_low": 0.2, "clip_high": 0.28, "mask_ratio": [0.5, 2.0]})
        self.assertEqual(losses.CISPO().kind, "cispo")
        self.assertEqual(losses.BCEWithLogits(head="gate").head, "gate")
        self.assertEqual(losses.OrdinalBCE().kind, "ordinal_bce")
        self.assertEqual(losses.TopKKLDistill().top_k, 32)
        for bad in (lambda: losses.DPO(beta=0), lambda: losses.InfoNCE(temp=0), lambda: losses.TopKKLDistill(0), lambda: splits.BySession(0.9)):
            with self.assertRaises(ValueError):
                bad()
        self.assertEqual(splits.ByGroup().to_dict(), {"strategy": "by_group"})
        self.assertEqual(grad.advantages.RLOO().kind, "rloo")
        self.assertEqual(grad.advantages.GroupMean().kind, "group_mean")
        self.assertEqual(grad.loggers.MLflow(experiment="e").options["experiment"], "e")

    def test_unavailable_namespaces(self) -> None:
        for ns in (grad.mergers, grad.sources, grad.heads):
            with self.assertRaises(grad.NotAvailableInV0Error):
                ns.Anything  # noqa: B018
            with self.assertRaises(grad.NotAvailableInV0Error):
                ns()
            self.assertIn("not available", repr(ns))
        with self.assertRaises(AttributeError):
            grad.mergers.__wrapped__  # noqa: B018


class RecordTests(unittest.TestCase):
    def test_trajectory_round_trip_and_views(self) -> None:
        traj = Trajectory.from_messages(
            [{"role": "system", "content": "s"}, {"role": "user", "content": "q"}, {"role": "assistant", "content": [{"type": "text", "text": "a"}, "b"]}],
            session_id="s1",
            scores={"x": 1},
            metrics={"latency_ms": 3},
            metadata={"m": 1},
            expected_output="ab",
            tools=[{"type": "function"}],
        )
        traj.scores["tests_passed"] = 1.0
        traj.append_env_tokens("obs").with_targets(scores={"y": 0.5}, expected_output="z")
        data = traj.to_dict()
        self.assertTrue(set(data) <= RECORD_FIELDS)
        self.assertEqual(data["messages"][-1], {"role": "tool", "content": "obs", "train": False})
        self.assertEqual(data["expected_output"], "z")
        clean = Trajectory.from_messages([{"role": "user", "content": "q"}, {"role": "assistant", "content": [{"type": "text", "text": "a"}, "b"]}])
        self.assertEqual(clean.text, "ab")
        self.assertEqual(clean.output.text, "ab")
        self.assertEqual(clean.input.messages, [{"role": "user", "content": "q"}])
        self.assertEqual(Trajectory().text, "")
        self.assertEqual(Trajectory(messages=[{"role": "assistant", "content": None}]).text, "")
        self.assertEqual(Trajectory(messages=[{"role": "assistant", "content": 5}]).text, "5")

    def test_from_record_shapes(self) -> None:
        traj = Trajectory.from_record({"input": {"messages": [{"role": "user", "content": "q"}]}, "output": {"turns": [{"role": "assistant", "content": "a"}]}, "scores": {"s": 1}})
        self.assertEqual(traj.text, "a")
        self.assertEqual(Trajectory.from_record({"prompt": "q", "completion": "a"}).text, "a")
        self.assertEqual(Trajectory.from_record({"prompt": [{"role": "user", "content": "q"}], "completion": [{"role": "assistant", "content": "c"}]}).text, "c")

    def test_record_types(self) -> None:
        self.assertEqual(Record(state={"t": 1}, questions={"q": {}}, expected_output={"q": 1}).to_dict(), {"state": {"t": 1}, "questions": {"q": {}}, "expected_output": {"q": 1}})
        pair = PreferencePair(prompt="p", chosen="c", rejected="r", group_id="g", session_id="s", metadata={"a": 1}).to_dict()
        self.assertEqual(pair["group_id"], "g")
        trip = Triplet(query="q", positive="p", negatives=["n"], session_id="s", metadata={}).to_dict()
        self.assertEqual(trip["negatives"], ["n"])
        self.assertEqual(Triplet(query="q", positive="p").to_dict(), {"query": "q", "positive": "p"})
        for obj in (pair, trip):
            self.assertTrue(set(obj) <= RECORD_FIELDS)

    def test_task(self) -> None:
        task = Task.from_dict({"prompt": "2+2?", "answer": "4", "seed": {"orders": {}}, "metadata": {"m": 1}, "max_turns": 3, "id": "t1"})
        self.assertEqual((task.expected, task.max_turns, task.id), ("4", 3, "t1"))
        self.assertEqual(task.prompt_messages(), [{"role": "user", "content": "2+2?"}])
        self.assertEqual(Task.from_dict({"prompt": [{"role": "user", "content": "x"}]}).prompt_messages(), [{"role": "user", "content": "x"}])
        self.assertEqual(task.to_dict(), {"prompt": "2+2?", "expected_output": "4", "metadata": {"m": 1, "seed": {"orders": {}}}})
        self.assertEqual(Task(messages=[{"role": "user", "content": "y"}]).to_dict(), {"messages": [{"role": "user", "content": "y"}]})

    def test_coerce_record(self) -> None:
        self.assertEqual(coerce_record({"a": 1}), {"a": 1})
        self.assertEqual(coerce_record(Record(prompt="p")), {"prompt": "p"})
        with self.assertRaises(TypeError) as ctx:
            coerce_record("./train.jsonl")
        self.assertIn("pass its path", str(ctx.exception))
        json.dumps(coerce_record(Trajectory.from_messages([{"role": "user", "content": "x"}])))


if __name__ == "__main__":
    unittest.main()
