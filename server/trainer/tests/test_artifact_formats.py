"""Bundles match docs/ARTIFACT_FORMATS.md: schema-valid, and the doc's own reference loaders
(run from its ``# loader:`` code blocks) reproduce the trainer's outputs on the tiny models."""

from __future__ import annotations

import json
import re
import shutil
import struct
from pathlib import Path
from typing import Any

from helpers import BERT_ID, QWEN_ID, Recorder, TempDirCase, TorchCase

from grad_trainer import __version__
from grad_trainer import artifact_formats as formats
from grad_trainer.bundles import bundle_directory

REPO = Path(__file__).resolve().parents[3]
DOC = REPO / "docs" / "ARTIFACT_FORMATS.md"
LOADER_BLOCK = re.compile(r"```python\n# loader: (\S+)\n(.*?)```", re.S)
TOKENIZER = {"tokenizer.json", "tokenizer_config.json"}
LORA = {"adapter_config.json", "adapter_model.safetensors"}
#: The payload files each format section of the doc lists, for these tiny runs.
DOCUMENTED_FILES = {
    "peft_lora": LORA,
    "merged_safetensors": {"config.json", "generation_config.json", "model.safetensors", "chat_template.jinja"} | TOKENIZER,
    "cartridge": {"cartridge.safetensors"},
    "encoder_safetensors": {
        "config.json",
        "model.safetensors",
        "grad_embedding.json",
        "modules.json",
        "sentence_bert_config.json",
        "1_Pooling/config.json",
        "2_Normalize/.keep",
    }
    | TOKENIZER,
    "router_bundle": {"router_config.json", "router_head.safetensors"} | LORA,
    "decision_bundle": {"decision_config.json", "decision_head.safetensors"} | LORA,
}


def loaders(*names: str) -> dict[str, Any]:
    """Exec the doc's ``common`` block plus ``names`` into one namespace."""
    blocks = dict(LOADER_BLOCK.findall(DOC.read_text()))
    namespace: dict[str, Any] = {"__name__": "artifact_formats_doc"}
    for name in ("common", *names):
        code = blocks[name]
        assert "grad_trainer" not in code, f"loader '{name}' must not use trainer internals"
        exec(compile(code, f"{DOC.name}#{name}", "exec"), namespace)
    return namespace


def manifest_for(**extra: Any) -> dict[str, Any]:
    return {
        "kind": "final",
        "format": "peft_lora",
        "recipe_kind": "sft",
        "base_model": "qwen/qwen3-0.6b",
        "base_model_repo": "Qwen/Qwen3-0.6B",
        "base_model_revision": None,
        "deployable": True,
        **extra,
    }


def write_safetensors(path: Path, header: dict[str, Any]) -> None:
    raw = json.dumps(header).encode()
    path.write_bytes(struct.pack("<Q", len(raw)) + raw)


class SchemaTests(TempDirCase):
    def lora_dir(self, **config: Any) -> Path:
        src = self.tmpdir()
        base = {
            "peft_type": "LORA",
            "task_type": "CAUSAL_LM",
            "r": 32,
            "lora_alpha": 32,
            "target_modules": ["q_proj"],
            "base_model_name_or_path": "Qwen/Qwen3-0.6B",
            "revision": None,
            "bias": "none",
        }
        (src / "adapter_config.json").write_text(json.dumps({**base, **config}))
        (src / "adapter_model.safetensors").write_bytes(b"w")
        return src

    def test_schemas_are_valid_and_spec_points_at_them(self) -> None:
        names = sorted(p.name for p in formats.SCHEMA_DIR.glob("*.schema.json"))
        self.assertEqual(names, sorted(["manifest.schema.json", *(f"{f}.schema.json" for f in formats.CONFIG_FILES)]))
        for name in names:
            formats._validator(name.removesuffix(".schema.json"))  # check_schema raises on an invalid schema
        self.assertEqual(sorted(p.name for p in (REPO / "spec" / "artifacts").iterdir()), names)
        self.assertEqual(set(formats.FORMAT_VERSIONS) - {"reference"}, set(formats.CONFIG_FILES))

    def test_bundle_directory_stamps_versions_and_validates(self) -> None:
        info = bundle_directory(self.lora_dir(), self.tmpdir() / "a.grad.tar.gz", manifest=manifest_for())
        self.assertEqual(info.manifest["format_version"], 1)
        self.assertEqual(info.manifest["created_by"], {"name": "grad-trainer", "version": __version__})
        self.assertEqual(sorted(info.manifest["files"]), sorted(LORA))

        bad = [
            (manifest_for(recipe_kind="router"), "manifest.json .*recipe_kind"),
            ({k: v for k, v in manifest_for().items() if k != "base_model_revision"}, "'base_model_revision' is a required"),
            (manifest_for(kind="checkpoint"), "'step' is a required"),
            (manifest_for(format="cartridge", recipe_kind="cartridge"), "files: 'cartridge.safetensors' is a required"),
            (manifest_for(base_model_repo=None), "base_model_repo: None is not of type 'string'"),
        ]
        for manifest, message in bad:
            with self.subTest(message), self.assertRaisesRegex(ValueError, message):
                bundle_directory(self.lora_dir(), self.tmpdir() / "b", manifest=manifest)
        with self.assertRaisesRegex(ValueError, "adapter_config.json does not match peft_lora.schema.json at r"):
            bundle_directory(self.lora_dir(r=0), self.tmpdir() / "c", manifest=manifest_for())

    def test_reference_bundles_and_reserved_file_names(self) -> None:
        src = self.tmpdir()
        (src / "reference_model.json").write_text("{}")
        ref = manifest_for(format="reference", deployable=False, base_model_repo=None)
        self.assertEqual(bundle_directory(src, self.tmpdir() / "r", manifest=ref).manifest["format_version"], 1)
        with self.assertRaisesRegex(ValueError, "deployable"):
            bundle_directory(src, self.tmpdir() / "s", manifest={**ref, "deployable": True})
        stamped = {**ref, "schema": "grad.artifact/1", "format_version": 1, "created_by": {"name": "grad-trainer", "version": "1"}}
        files = {"reference_model.json": "0" * 64, "trainer_state/best/weights.safetensors": "1" * 64}
        formats.check("manifest", {**stamped, "files": files}, "manifest.json")
        for name in ("manifest.json", "eval_report.json", "a/../b", "./a", "/abs", "a//b", "a/", "a\\b"):
            with self.subTest(name), self.assertRaisesRegex(ValueError, "at files: .* should not be valid"):
                formats.check("manifest", {**stamped, "files": {**files, name: "0" * 64}}, "manifest.json")

    def test_heads_and_adapters_named_by_the_config_must_be_in_the_bundle(self) -> None:
        src = self.tmpdir()
        config = {
            "format": "router_bundle", "format_version": 1, "candidates": ["a", "b"], "route_order": ["a"],
            "fallback_model": "b", "pricing": None, "threshold": None, "temperature": 1.0, "calibrated": False,
            "max_quality_drop": 0.02, "head_file": "router_head.safetensors", "adapter": {"kind": "lora", "rank": 4, "alpha": 8, "target_modules": ["q_proj"]},
            "pooling": "last_token", "hidden_size": 32, "max_seq_len": 512, "truncation_side": "left",
            "chat_template_kwargs": {"add_generation_prompt": True, "enable_thinking": True}, "template_revision": "qwen3@3",
            "base_model": "qwen/qwen3-0.6b", "base_model_repo": "Qwen/Qwen3-0.6B", "base_model_revision": None,
        }
        (src / "router_config.json").write_text(json.dumps(config))
        (src / "router_head.safetensors").write_bytes(b"h")
        manifest = manifest_for(format="router_bundle", recipe_kind="router")
        with self.assertRaisesRegex(ValueError, r"router_bundle bundle is missing \['adapter_config.json'"):
            bundle_directory(src, self.tmpdir() / "a", manifest=manifest)
        (src / "router_config.json").write_text(json.dumps({**config, "adapter": {"kind": "frozen_head"}}))
        bundle_directory(src, self.tmpdir() / "b", manifest=manifest)

    def test_safetensors_headers(self) -> None:
        path = self.tmpdir() / "x.safetensors"
        path.write_bytes(struct.pack("<Q", 0))
        with self.assertRaisesRegex(ValueError, "header length"):
            formats.safetensors_header(path)
        write_safetensors(path, [])  # type: ignore[arg-type]
        with self.assertRaisesRegex(ValueError, "invalid safetensors header"):
            formats.safetensors_header(path)
        header = {
            "__metadata__": {"format": "gradiated.cartridge/1", "placement": "system_prompt_start", "separator": "\n\n",
                             "base_model": "Qwen/Qwen3-0.6B", "num_tokens": "8", "hidden_size": "32", "slot_token": "<|vision_pad|>"},
            "embeddings": {"dtype": "F32", "shape": [8, 32], "data_offsets": [0, 1024]},
            "slot_token_ids": {"dtype": "I64", "shape": [8], "data_offsets": [1024, 1088]},
        }
        write_safetensors(path, header)
        with self.assertRaisesRegex(ValueError, "at embeddings/dtype: 'BF16' was expected"):
            formats.check("cartridge", formats.safetensors_header(path), path.name)


class RecipeBundleTests(TorchCase):
    """For each recipe: export, bundle like the worker, open with the doc's loader, compare."""

    def run_captured(self, kind: str, config: dict[str, Any], records: list[dict[str, Any]], recorder: Recorder | None = None):
        from grad_trainer.recipes import get_recipe_runner
        from grad_trainer.runner_types import Budget

        runner = get_recipe_runner(kind)
        built: list[Any] = []
        build = runner.build_task
        runner.build_task = lambda *a: built.append(build(*a)) or built[-1]  # type: ignore[method-assign]
        out = runner.run(
            config, records, budget=Budget(None, 1.0), workdir=self.tmpdir(),
            callbacks=recorder.callbacks() if recorder else None,
        )
        return out, built[0]

    def bundle(self, out: Any, ns: dict[str, Any]) -> tuple[Path, dict[str, Any]]:
        """Bundle the export exactly as the worker does, then open it with the doc's reader."""
        path = self.tmpdir() / "artifact.grad.tar.gz"
        bundle_directory(out.artifact_dir, path, manifest={**out.manifest, "format": out.artifact_format}, eval_report=out.eval_report)
        dest = self.tmpdir() / "bundle"
        manifest = ns["open_bundle"](path, dest)
        self.assertEqual((manifest["kind"], manifest["format"], manifest["format_version"]), ("final", out.artifact_format, 1))
        # The loader gets only the documented files.
        self.assertEqual(set(manifest["files"]), DOCUMENTED_FILES[out.artifact_format])
        documented = self.tmpdir() / "documented"
        for name in [*manifest["files"], "manifest.json"]:
            (documented / name).parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(dest / name, documented / name)
        return documented, manifest

    def assertClose(self, a: Any, b: Any, tol: float = 1e-4) -> None:
        import torch

        self.assertLess(float((torch.as_tensor(a, dtype=torch.float64) - torch.as_tensor(b, dtype=torch.float64)).abs().max()), tol)

    def test_peft_lora_from_sft_and_dpo(self) -> None:
        import torch
        from test_torch_dpo import CONFIG as DPO, PAIRS

        ns = loaders("peft_lora")
        sft = {"model": QWEN_ID, "batch_size": 4, "epochs": 1, "lr": 1e-2, "adapter": {"kind": "lora", "rank": 4, "alpha": 8}}
        chats = [{"messages": [{"role": "user", "content": f"hi {i}"}, {"role": "assistant", "content": f"hello {i}"}]} for i in range(8)]
        ids = torch.tensor([[1, 5, 9, 30, 2]])
        for kind, config, records in [("sft", sft, chats), ("dpo", DPO, PAIRS)]:
            with self.subTest(kind):
                out, task = self.run_captured(kind, config, records)
                bundle_dir, manifest = self.bundle(out, ns)
                self.assertEqual(manifest["recipe_kind"], kind)
                tokenizer, model = ns["load_lora"](bundle_dir, dtype=torch.float32)
                self.assertIn("<|im_start|>", tokenizer.apply_chat_template([{"role": "user", "content": "x"}], tokenize=False))
                task.model.eval()
                with torch.no_grad():
                    self.assertClose(model(input_ids=ids).logits, task.model(input_ids=ids).logits)

    def test_merged_safetensors(self) -> None:
        import torch

        ns = loaders("merged_safetensors")
        config = {"model": QWEN_ID, "batch_size": 4, "epochs": 1, "lr": 1e-2, "adapter": {"kind": "lora", "rank": 4, "alpha": 8, "merge_on_export": True}}
        records = [{"messages": [{"role": "user", "content": f"hi {i}"}, {"role": "assistant", "content": f"yo {i}"}]} for i in range(8)]
        out, task = self.run_captured("sft", config, records)
        bundle_dir, _ = self.bundle(out, ns)
        _, model = ns["load_merged"](bundle_dir, dtype=torch.float32)
        ids = torch.tensor([[1, 5, 9, 30, 2]])
        with torch.no_grad():
            self.assertClose(model(input_ids=ids).logits, task.lm.eval()(input_ids=ids).logits)

    def test_encoder_safetensors(self) -> None:
        import torch
        from test_torch_cartridge_embedding import EMBEDDING, TRIPLETS

        ns = loaders("encoder_safetensors")
        for pooling in ("mean", "cls"):
            with self.subTest(pooling):
                out, task = self.run_captured("embedding", {**EMBEDDING, "epochs": 1, "recipe_params": {"pool": pooling}}, TRIPLETS)
                bundle_dir, _ = self.bundle(out, ns)
                encoder = ns["Encoder"](bundle_dir)
                self.assertEqual(encoder.config["pooling"], pooling)
                texts = [p["positive_text"] for p in task.held_out] + ["a much longer text " * 40]
                task.model.eval()
                with torch.no_grad():
                    expected = task.encode([task._tok(t) for t in texts], grad=False)
                self.assertClose(encoder.embed(texts), expected)

    def test_cartridge(self) -> None:
        import torch
        from test_torch_cartridge_embedding import CARTRIDGE, PROMPTS

        from grad_trainer.recipes.cartridge import topk_kl
        from grad_trainer.recipes.data import prompt_messages

        ns = loaders("cartridge")
        out, task = self.run_captured("cartridge", {**CARTRIDGE, "epochs": 1}, PROMPTS)
        bundle_dir, manifest = self.bundle(out, ns)
        self.assertEqual(manifest["base_model_repo"], task.resolved.repo)
        cartridge = ns["Cartridge"](bundle_dir, dtype=torch.float32)
        # The trainer's student path, with the cartridge rounded to its stored bf16 values.
        task.cartridge.data = task.cartridge.data.to(torch.bfloat16).float()
        records = [r for r in PROMPTS if r["id"] == "sys"] + PROMPTS[:2]
        for rec, item in zip(records, task._prompts(records)):
            ids = cartridge.input_ids(prompt_messages(rec))
            self.assertEqual(ids, item["student"])
            item.update(next(i for i in task.train + task.held_out if i["student"] == item["student"]))
            start = len(ids) - 1
            logits = cartridge.logits(ids + item["response"])[start : start + len(item["response"])]
            kl = topk_kl(logits, item["top_ids"], item["top_logp"]).mean()
            self.assertClose(kl, task._kl_batch([item], "student", grad=False)[0])
        self.assertIsInstance(cartridge.generate(prompt_messages(PROMPTS[0]), max_new_tokens=3), str)
        with self.assertRaisesRegex(ValueError, "slot token"):
            cartridge.input_ids([{"role": "user", "content": "say " + cartridge.meta["slot_token"]}])

    def test_router_bundle_and_its_checkpoints(self) -> None:
        import torch
        from test_torch_router import CONFIG, observations

        from grad_trainer.metrics import sigmoid
        from grad_trainer.recipes.router import route

        ns = loaders("backbone", "router_bundle")
        recorder = Recorder(self.tmpdir())
        out, task = self.run_captured("router", {**CONFIG, "epochs": 2, "recipe_params": {**CONFIG["recipe_params"], "pricing": {"cheap/m": 1.0, "strong/m": 5.0}}}, observations(), recorder)
        bundle_dir, _ = self.bundle(out, ns)
        router = ns["Router"](bundle_dir, dtype=torch.float32)
        self.assertEqual(router.config["pricing"], {"cheap/m": 1.0, "strong/m": 5.0})
        self.assertTrue(router.config["calibrated"])
        records = [r for r in observations() if r["metadata"]["model"] == "cheap/m"][:12]
        temperature, threshold = task.calibration["temperature"], task.calibration["threshold"]
        from grad_trainer.recipes.data import prompt_messages
        from grad_trainer.recipes.router import prompt_key

        for rec in records:
            messages = prompt_messages(rec)
            ids = task.encode_prompt(messages, prompt_key(rec), task.max_len)
            self.assertEqual(ns["prompt_ids"](router.tokenizer, router.config, messages), ids)
            logits = task._logits([{"ids": ids}])[0]
            expected = {m: sigmoid(z / temperature) for m, z in zip(task.candidates, logits)}
            probs = router.probabilities(messages)
            self.assertClose(list(probs.values()), list(expected.values()))
            if threshold is None or all(abs(probs[m] - threshold) > 1e-4 for m in task.order):
                self.assertEqual(router.route(messages), route(expected, task.order, task.fallback, threshold if threshold is not None else 2.0))

        # A checkpoint bundled as the worker does: uncalibrated, never offloads.
        step, _, directory, metadata = recorder.checkpoints[0]
        path = self.tmpdir() / "ckpt.grad.tar.gz"
        bundle_directory(directory, path, manifest={**metadata["manifest"], "kind": "checkpoint", "step": step, "format": "router_bundle"})
        dest = self.tmpdir() / "ckpt"
        manifest = ns["open_bundle"](path, dest)
        self.assertEqual((manifest["kind"], manifest["step"]), ("checkpoint", step))
        self.assertTrue(any(name.startswith("trainer_state/") for name in manifest["files"]))
        checkpoint = ns["Router"](dest, dtype=torch.float32)
        self.assertEqual((checkpoint.config["threshold"], checkpoint.config["calibrated"]), (None, False))
        self.assertEqual(checkpoint.route(prompt_messages(records[0])), task.fallback)

    def test_decision_bundle(self) -> None:
        import torch
        from test_torch_decision import CONFIG, records

        ns = loaders("backbone", "decision_bundle")
        data = records()
        out, task = self.run_captured("decision", CONFIG, data)
        bundle_dir, _ = self.bundle(out, ns)
        model = ns["DecisionModel"](bundle_dir, dtype=torch.float32)
        self.assertTrue(model.config["calibrated"])
        self.assertEqual({q["type"] for q in model.config["questions"].values()}, {"choice", "noul", "score"})
        for index, rec in enumerate(data[:6]):
            messages = model.state_messages(rec["state"])
            from grad_trainer.recipes.decision import state_text

            self.assertEqual(messages, state_text(rec, index))
            ids = task.encode_prompt(messages, rec["id"], task.max_len)
            logits = task._head_logits([{"ids": ids}])
            probs = model.probabilities(messages)
            answers = model.answers(messages)
            for name, question in task.questions.items():
                expected = task._probs(name, logits[name][0], task.temperatures[name])
                self.assertClose(probs[name], expected)
                if question["type"] == "noul":
                    self.assertEqual(answers[name], expected[0] >= 0.5)
                else:
                    self.assertEqual(answers[name], question["options"][max(range(len(expected)), key=expected.__getitem__)])

    def test_open_bundle_rejects_tampering_and_unknown_versions(self) -> None:
        import tarfile

        ns = loaders()
        src = self.tmpdir()
        (src / "reference_model.json").write_text("{}")
        ref = manifest_for(format="reference", deployable=False, base_model_repo=None)
        path = self.tmpdir() / "ref.grad.tar.gz"
        bundle_directory(src, path, manifest=ref, eval_report={"eval_loss": None})
        with self.assertRaisesRegex(ValueError, "unsupported format reference"):
            ns["open_bundle"](path, self.tmpdir() / "a")
        # Retar with a modified payload: the checksum no longer matches.
        unpacked = self.tmpdir() / "u"
        with tarfile.open(path) as tar:
            tar.extractall(unpacked, filter="data")
        manifest = json.loads((unpacked / "manifest.json").read_text())
        manifest["format"] = "peft_lora"
        (unpacked / "manifest.json").write_text(json.dumps(manifest))
        (unpacked / "reference_model.json").write_text('{"x": 1}')
        tampered = self.tmpdir() / "t.grad.tar.gz"
        with tarfile.open(tampered, "w:gz") as tar:
            for p in sorted(unpacked.iterdir()):
                tar.add(p, p.name)
        with self.assertRaisesRegex(ValueError, "checksum mismatch for reference_model.json"):
            ns["open_bundle"](tampered, self.tmpdir() / "b")
