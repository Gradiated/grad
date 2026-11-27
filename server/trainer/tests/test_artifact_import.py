"""Artifact imports (``grad artifacts upload`` / ``import``): validation against the format spec
and the base model's config.json, the HF Hub download (against a local fake hub) and the worker."""

from __future__ import annotations

import io
import json
import shutil
import tarfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from unittest import mock

from fixtures.fake_protocol_server import FakeProtocolServer
from helpers import BERT_ID, QWEN_ID, TempDirCase, TorchCase

from grad_trainer import artifact_import
from grad_trainer.artifact_import import InvalidArtifact
from grad_trainer.bundles import extract_bundle
from grad_trainer.errors import SourceUnavailableError
from grad_trainer.worker import ProtocolClient, TrainerWorker

COMMIT = "c" * 40


def tar_of(directory: Path, out: Path, *, prefix: str = "") -> Path:
    with tarfile.open(out, "w:gz") as tar:
        for path in sorted(directory.rglob("*")):
            if path.is_file():
                tar.add(path, arcname=prefix + path.relative_to(directory).as_posix())
    return out


class FakeHub:
    """A minimal Hugging Face Hub: model info by revision and file resolves (one redirect)."""

    def __init__(self, files: dict[str, bytes], *, token: str | None = None) -> None:
        self.files, self.token, self.seen_auth = files, token, []
        hub = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args: Any) -> None:
                pass

            def do_GET(self) -> None:
                hub.seen_auth.append((self.path, self.headers.get("Authorization")))
                if hub.token and self.headers.get("Authorization") != f"Bearer {hub.token}" and not self.path.startswith("/cdn/"):
                    return self.reply(401, b"{}")
                if self.path.startswith("/api/models/acme/lora/revision/"):
                    body = {"sha": COMMIT, "siblings": [{"rfilename": n} for n in [*hub.files, "README.md"]]}
                    return self.reply(200, json.dumps(body).encode())
                prefix = f"/acme/lora/resolve/{COMMIT}/"
                if self.path.startswith(prefix):
                    # The Hub redirects file downloads to its CDN (here the same host, /cdn/).
                    self.send_response(302)
                    self.send_header("Location", f"/cdn/{self.path[len(prefix):]}")
                    self.end_headers()
                    return None
                if self.path.startswith("/cdn/") and self.path[5:] in hub.files:
                    return self.reply(200, hub.files[self.path[5:]])
                return self.reply(404, b"{}")

            def reply(self, status: int, body: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


class ArtifactImportTests(TorchCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        import tempfile

        from peft import LoraConfig, get_peft_model
        from transformers import AutoModelForCausalLM

        from fixtures.tiny_models import ensure_tiny_models

        cls.root = Path(tempfile.mkdtemp(prefix="grad-artifact-import-"))
        cls.addClassCleanup(shutil.rmtree, cls.root, True)
        base = AutoModelForCausalLM.from_pretrained(str(ensure_tiny_models()[QWEN_ID]))
        model = get_peft_model(base, LoraConfig(r=4, lora_alpha=8, target_modules=["q_proj", "v_proj", "down_proj"], task_type="CAUSAL_LM"))
        cls.lora = cls.root / "lora"
        model.save_pretrained(str(cls.lora))
        config = json.loads((cls.lora / "adapter_config.json").read_text())
        config["base_model_name_or_path"] = QWEN_ID  # a user's adapter names the base by its id or repo
        (cls.lora / "adapter_config.json").write_text(json.dumps(config))
        (cls.lora / "README.md").write_text("trained elsewhere")

    def copy(self) -> Path:
        out = self.tmpdir() / "lora"
        shutil.copytree(self.lora, out)
        return out

    def spec(self, source: dict[str, Any], fmt: str = "peft_lora", base: str = QWEN_ID) -> dict[str, Any]:
        return {
            "id": "imp_1",
            "name": "my-lora",
            "format": fmt,
            "base_model": base,
            "provenance": {"source": "upload", "run_id": None, "uploader": "key_1", "uri": None},
            "source": source,
        }

    def upload(self, directory: Path, **kw: Any) -> Any:
        archive = tar_of(directory, self.tmpdir() / "up.tar.gz", **kw)
        work = self.tmpdir()
        return artifact_import.run(
            self.spec({"kind": "upload", "download_url": "u"}),
            workdir=work,
            download=lambda _url, dest: shutil.copyfile(archive, dest),
        )

    def invalid(self, directory: Path) -> str:
        with self.assertRaises(InvalidArtifact) as ctx:
            self.upload(directory)
        return str(ctx.exception)

    def test_a_valid_upload_becomes_a_format_version_2_bundle(self) -> None:
        info = self.upload(self.lora, prefix="./my-lora/")
        manifest = info.manifest
        self.assertEqual((manifest["format"], manifest["format_version"], manifest["kind"]), ("peft_lora", 2, "final"))
        self.assertEqual(manifest["recipe_kind"], "sft")
        self.assertEqual(manifest["provenance"], {"source": "upload", "uploader": "key_1"})
        self.assertEqual(manifest["adapter"], {"kind": "lora", "rank": 4, "alpha": 8, "target_modules": ["down_proj", "q_proj", "v_proj"]})
        self.assertEqual(sorted(manifest["files"]), ["adapter_config.json", "adapter_model.safetensors"])  # README dropped
        out = self.tmpdir() / "x"
        extract_bundle(info.path, out)
        config = json.loads((out / "adapter_config.json").read_text())
        # Normalized to what serving and continued training load.
        self.assertEqual(config["base_model_name_or_path"], manifest["base_model_repo"])
        self.assertEqual(config["revision"], manifest["base_model_revision"])

        # Continued training loads it like a trained adapter.
        from transformers import AutoModelForCausalLM

        from grad_trainer.backends.torch_common import load_lora
        from grad_trainer.models import resolve_model

        resolved = resolve_model(QWEN_ID)
        model, settings = load_lora(AutoModelForCausalLM.from_pretrained(str(resolved.path)), out, {"kind": "lora", "rank": 4, "alpha": 8}, resolved)
        self.assertEqual(settings["target_modules"], ["down_proj", "q_proj", "v_proj"])
        self.assertTrue(any(p.requires_grad for p in model.parameters()))

    def test_invalid_loras_name_the_file_and_the_problem(self) -> None:
        def mutate(change: Any) -> Path:
            lora = self.copy()
            config = json.loads((lora / "adapter_config.json").read_text())
            change(lora, config)
            (lora / "adapter_config.json").write_text(json.dumps(config))
            return lora

        cases: list[tuple[str, str, Any]] = [
            ("adapter_config.json: base_model_name_or_path is 'Qwen/Qwen3-8B', expected", "", lambda _l, c: c.update(base_model_name_or_path="Qwen/Qwen3-8B")),
            ("adapter_config.json: target module 'c_attn' is not a linear layer of test/tiny-qwen3", "q_proj", lambda _l, c: c.update(target_modules=["c_attn"])),
            ("adapter_config.json: target_modules must be a list", "", lambda _l, c: c.update(target_modules=".*proj")),
            ("adapter_config.json: use_dora", "", lambda _l, c: c.update(use_dora=True)),
            # r=8 in the config, r=4 in the tensors.
            ("adapter_model.safetensors: base_model.model.model.layers.0.", "has shape [4, ", lambda _l, c: c.update(r=8)),
            ("adapter_model.safetensors: base_model.model.model.layers.0.mlp.down_proj", "not one of the target modules", lambda _l, c: c.update(target_modules=["q_proj", "v_proj"])),
            ("adapter_model.bin: pickle weights are refused", "safe_serialization", lambda l, _c: (l / "adapter_model.safetensors").rename(l / "adapter_model.bin")),
        ]
        for want, contains, change in cases:
            with self.subTest(want=want):
                message = self.invalid(mutate(change))
                self.assertTrue(message.startswith(want), message)
                self.assertIn(contains, message)
        with mock.patch("grad_trainer.models._revision_from_path", return_value="d" * 40):
            message = self.invalid(mutate(lambda _l, c: c.update(revision="abc")))
        self.assertTrue(message.startswith(f"adapter_config.json: revision is 'abc', but test/tiny-qwen3 is pinned to {'d' * 40}"), message)
        missing = self.copy()
        (missing / "adapter_config.json").unlink()
        self.assertEqual(self.invalid(missing), "adapter_config.json: missing")

    def test_a_truncated_safetensors_and_a_non_tar_upload_are_refused(self) -> None:
        lora = self.copy()
        weights = lora / "adapter_model.safetensors"
        weights.write_bytes(weights.read_bytes()[:-16])
        self.assertIn("adapter_model.safetensors: tensor", self.invalid(lora))
        work = self.tmpdir()
        with self.assertRaises(InvalidArtifact) as ctx:
            artifact_import.run(
                self.spec({"kind": "upload", "download_url": "u"}),
                workdir=work,
                download=lambda _u, dest: dest.write_bytes(b"not a tar"),
            )
        self.assertTrue(str(ctx.exception).startswith("upload: not a tar"))
        # A link inside the archive is refused.
        link_tar = self.tmpdir() / "link.tar"
        with tarfile.open(link_tar, "w") as tar:
            info = tarfile.TarInfo("adapter_config.json")
            info.type = tarfile.SYMTYPE
            info.linkname = "/etc/passwd"
            tar.addfile(info)
        with self.assertRaises(InvalidArtifact) as ctx:
            artifact_import.extract_upload(link_tar, self.tmpdir() / "out")
        self.assertIn("links", str(ctx.exception))

    def test_formats_must_fit_their_base(self) -> None:
        # A LoRA on an encoder base: not a decoder layout.
        with self.assertRaises(InvalidArtifact) as ctx:
            archive = tar_of(self.lora, self.tmpdir() / "a.tar.gz")
            artifact_import.run(
                self.spec({"kind": "upload", "download_url": "u"}, base=BERT_ID),
                workdir=self.tmpdir(),
                download=lambda _u, dest: shutil.copyfile(archive, dest),
            )
        self.assertIn("base_model_name_or_path", str(ctx.exception))
        # A cartridge whose width isn't the base's hidden size.
        import torch
        from safetensors.torch import save_file

        cart = self.tmpdir() / "cart"
        cart.mkdir()
        meta = {
            "format": "gradiated.cartridge/1",
            "placement": "system_prompt_start",
            "separator": "\n\n",
            "slot_token": "<|vision_pad|>",
            "num_tokens": "4",
            "hidden_size": "7",
            "base_model": QWEN_ID,
        }
        save_file({"embeddings": torch.zeros(4, 7, dtype=torch.bfloat16), "slot_token_ids": torch.zeros(4, dtype=torch.int64)}, str(cart / "cartridge.safetensors"), metadata=meta)
        archive = tar_of(cart, self.tmpdir() / "c.tar.gz")
        with self.assertRaises(InvalidArtifact) as ctx:
            artifact_import.run(
                self.spec({"kind": "upload", "download_url": "u"}, fmt="cartridge"),
                workdir=self.tmpdir(),
                download=lambda _u, dest: shutil.copyfile(archive, dest),
            )
        self.assertRegex(str(ctx.exception), r"^cartridge.safetensors: hidden size is 7, but test/tiny-qwen3 has hidden_size \d+")

    def run_dir(self, directory: Path, fmt: str, base: str = QWEN_ID) -> Any:
        archive = tar_of(directory, self.tmpdir() / "a.tar.gz")
        return artifact_import.run(
            self.spec({"kind": "upload", "download_url": "u"}, fmt=fmt, base=base),
            workdir=self.tmpdir(),
            download=lambda _u, dest: shutil.copyfile(archive, dest),
        )

    def test_merged_encoder_and_router_uploads(self) -> None:
        import torch
        from safetensors.torch import save_file

        from fixtures.tiny_models import ensure_tiny_models

        paths = ensure_tiny_models()
        # A merged model is the base layout itself: config, weights and tokenizer.
        merged = self.run_dir(paths[QWEN_ID], "merged_safetensors")
        self.assertEqual(merged.manifest["recipe_kind"], "sft")
        self.assertIn("model.safetensors", merged.manifest["files"])
        # An encoder: the tiny BERT plus grad_embedding.json.
        encoder = self.tmpdir() / "enc"
        shutil.copytree(paths[BERT_ID], encoder)
        hidden = json.loads((encoder / "config.json").read_text())["hidden_size"]
        embedding = {"format": "encoder_safetensors", "format_version": 2, "pooling": "mean", "normalize": True, "dimensions": hidden, "max_seq_length": 64, "base_model": BERT_ID}
        (encoder / "grad_embedding.json").write_text(json.dumps(embedding))
        info = self.run_dir(encoder, "encoder_safetensors", base=BERT_ID)
        self.assertEqual(info.manifest["recipe_kind"], "embedding")
        (encoder / "grad_embedding.json").write_text(json.dumps({**embedding, "dimensions": hidden + 1}))
        with self.assertRaises(InvalidArtifact) as ctx:
            self.run_dir(encoder, "encoder_safetensors", base=BERT_ID)
        self.assertTrue(str(ctx.exception).startswith("grad_embedding.json: hidden size"), ctx.exception)
        # A frozen-head router whose head width is the base's hidden size.
        width = json.loads((paths[QWEN_ID] / "config.json").read_text())["hidden_size"]
        router = self.tmpdir() / "router"
        router.mkdir()
        config = {
            "format": "router_bundle", "format_version": 2, "candidates": ["a", "b"], "route_order": ["a"],
            "fallback_model": "b", "pricing": None, "threshold": None, "temperature": 1.0, "calibrated": False,
            "max_quality_drop": 0.02, "head_file": "router_head.safetensors", "adapter": {"kind": "frozen_head"},
            "pooling": "last_token", "hidden_size": width, "max_seq_len": 512, "truncation_side": "left",
            "chat_template_kwargs": {"add_generation_prompt": True, "enable_thinking": True}, "template_revision": "qwen3@3",
            "base_model": QWEN_ID, "base_model_repo": QWEN_ID, "base_model_revision": None,
        }
        (router / "router_config.json").write_text(json.dumps(config))
        save_file({"weight": torch.zeros(2, width), "bias": torch.zeros(2)}, str(router / "router_head.safetensors"))
        self.assertEqual(self.run_dir(router, "router_bundle").manifest["adapter"], {"kind": "frozen_head"})
        save_file({"weight": torch.zeros(2, width + 1), "bias": torch.zeros(2)}, str(router / "router_head.safetensors"))
        with self.assertRaises(InvalidArtifact) as ctx:
            self.run_dir(router, "router_bundle")
        self.assertTrue(str(ctx.exception).startswith("router_head.safetensors: weight has width"), ctx.exception)

    def test_a_hub_base_fetches_only_its_config(self) -> None:
        from grad_trainer import models

        snapshot = self.tmpdir() / "snapshots" / ("e" * 40)
        snapshot.mkdir(parents=True)
        (snapshot / "config.json").write_text('{"model_type": "qwen3"}')
        with mock.patch.dict("os.environ", {"GRAD_MODEL_PATHS": "{}", "GRAD_MODELS_MIRROR": ""}), mock.patch(
            "huggingface_hub.hf_hub_download", return_value=str(snapshot / "config.json")
        ) as fetch:
            resolved, config = models.resolve_config("qwen/qwen3-8b")
        fetch.assert_called_once_with("Qwen/Qwen3-8B", "config.json", local_files_only=mock.ANY)
        self.assertEqual((resolved.repo, resolved.revision, config["model_type"]), ("Qwen/Qwen3-8B", "e" * 40, "qwen3"))

    def test_hf_import_pins_the_commit_and_sends_only_the_workspace_token(self) -> None:
        files = {p.name: p.read_bytes() for p in self.lora.iterdir()}
        hub = FakeHub(files, token="hf_workspace")
        self.addCleanup(hub.close)
        spec = self.spec({"kind": "hf", "repo": "acme/lora", "revision": "main", "token": "hf_workspace"})
        with mock.patch.dict("os.environ", {"HF_ENDPOINT": hub.url, "GRAD_OFFLINE": "", "HF_HUB_OFFLINE": "", "TRANSFORMERS_OFFLINE": "", "HF_TOKEN": "hf_worker_login"}):
            info = artifact_import.run(spec, workdir=self.tmpdir(), download=lambda *_: None)
            self.assertEqual(info.manifest["provenance"], {"source": "import", "uri": f"hf://acme/lora@{COMMIT}"})
            self.assertEqual(sorted(info.manifest["files"]), ["adapter_config.json", "adapter_model.safetensors"])
            self.assertTrue(all(auth in (None, "Bearer hf_workspace") for _, auth in hub.seen_auth))
            self.assertNotIn("README.md", [p.split("/")[-1] for p, _ in hub.seen_auth])
            # Gated without a token: a clear source error, never the worker's own login.
            with self.assertRaises(SourceUnavailableError) as ctx:
                artifact_import.run(self.spec({"kind": "hf", "repo": "acme/lora"}), workdir=self.tmpdir(), download=lambda *_: None)
            self.assertIn("HTTP 401", str(ctx.exception))
            self.assertIn("check the repo id; if it exists it is gated or private", str(ctx.exception))
            with self.assertRaises(SourceUnavailableError):
                artifact_import.hf_snapshot("../etc", None, None, self.tmpdir(), ("*",))
        with mock.patch.dict("os.environ", {"HF_ENDPOINT": hub.url, "GRAD_OFFLINE": "1"}), self.assertRaises(SourceUnavailableError) as ctx:
            artifact_import.run(spec, workdir=self.tmpdir(), download=lambda *_: None)
        self.assertIn("offline", str(ctx.exception))

    def test_the_worker_validates_bundles_uploads_and_completes(self) -> None:
        archive = tar_of(self.lora, self.tmpdir() / "up.tar.gz").read_bytes()
        broken = self.copy()
        (broken / "adapter_config.json").write_text("{not json")
        broken_archive = tar_of(broken, self.tmpdir() / "bad.tar.gz").read_bytes()

        def job(job_id: str, url: str) -> dict[str, Any]:
            return {
                "id": job_id,
                "kind": "import",
                "attempt": 1,
                "lease_seconds": 60,
                "lease_expires_at": "2026-11-27T12:01:00Z",
                "run": None,
                "import": None,
                "artifact_import": self.spec({"kind": "upload", "download_url": url, "sha256": "x"}),
                "price_per_million_tokens": None,
                "max_cost_usd": None,
                "dataset": None,
                "resume": None,
                "base": None,
            }

        with FakeProtocolServer(api_key="k", jobs=[job("imp_1", "/blobs/good"), job("imp_2", "/blobs/bad")]) as srv:
            srv.blobs["/blobs/good"] = archive
            srv.blobs["/blobs/bad"] = broken_archive
            worker = TrainerWorker(
                server_url=srv.base_url,
                worker_id="w1",
                workdir=str(self.tmpdir()),
                client=ProtocolClient(srv.base_url, "k", retry_base_s=0.01, retry_cap_s=0.02),
                recipes=["sft"],
            )
            self.assertEqual(worker.run_once()["status"], "completed")
            [upload] = srv.bodies("uploads")
            self.assertEqual(upload["kind"], "artifact")
            done = srv.bodies("complete")[0]
            self.assertEqual((done["status"], done["format"]), ("completed", "peft_lora"))
            self.assertEqual(done["manifest"]["provenance"]["source"], "upload")
            bundle = self.tmpdir() / "b.grad.tar.gz"
            bundle.write_bytes(srv.uploads[done["upload_id"]])
            extract_bundle(bundle, self.tmpdir() / "x")
            worker.run_once()
            failed = srv.bodies("complete")[1]
            self.assertEqual((failed["status"], failed["error_code"]), ("failed", "invalid_artifact"))
            self.assertTrue(failed["error"].startswith("adapter_config.json: not valid JSON"), failed["error"])


class ExtractUploadTests(TempDirCase):
    def test_strips_one_top_level_directory_and_drops_directory_entries(self) -> None:
        archive = self.tmpdir() / "a.tar"
        with tarfile.open(archive, "w") as tar:
            for name, data in (("lora/", None), ("lora/adapter_config.json", b"{}"), ("lora/sub/x", b"x")):
                info = tarfile.TarInfo(name)
                if data is None:
                    info.type = tarfile.DIRTYPE
                    tar.addfile(info)
                else:
                    info.size = len(data)
                    tar.addfile(info, io.BytesIO(data))
        out = self.tmpdir() / "out"
        artifact_import.extract_upload(archive, out)
        self.assertEqual(sorted(p.relative_to(out).as_posix() for p in out.rglob("*") if p.is_file()), ["adapter_config.json", "sub/x"])
        with tarfile.open(archive := self.tmpdir() / "b.tar", "w") as tar:
            info = tarfile.TarInfo("../escape")
            info.size = 1
            tar.addfile(info, io.BytesIO(b"x"))
        with self.assertRaises(InvalidArtifact) as ctx:
            artifact_import.extract_upload(archive, self.tmpdir() / "o2")
        self.assertIn("unsafe path", str(ctx.exception))
        with self.assertRaises(InvalidArtifact):
            artifact_import.run({"format": "onnx", "source": {}}, workdir=self.tmpdir(), download=lambda *_: None)
