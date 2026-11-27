"""End to end on real code paths: server/api process + TrainerWorker + the torch recipes.

Imports a JSONL upload through the connectors, trains SFT on a tiny local Qwen3, downloads the
artifact through the public API, verifies its checksum and loads it with peft.
"""

from __future__ import annotations

import hashlib
import json
import unittest
import urllib.parse

from fixtures.live_server import LiveServer, http, http_json
from fixtures.tiny_models import QWEN_ID, ensure_tiny_models, torch_available

from grad_trainer.bundles import extract_bundle
from grad_trainer.worker import TrainerWorker

@unittest.skipUnless(torch_available(), "torch, transformers and peft are not installed")
class RealRecipeEndToEndTest(unittest.TestCase):
    def setUp(self) -> None:
        self.models = ensure_tiny_models()
        self.server = LiveServer(self)
        self.base = self.server.base
        self.worker = TrainerWorker(
            server_url=self.base,
            worker_id="real-e2e",
            workdir=self.server.dir / "work",
            heartbeat_interval_s=0.5,
        )

    def url(self, path: str) -> str:
        return f"{self.base}{path}"

    def import_jsonl(self, dataset: str, lines: list[str]) -> dict:
        body = ("\n".join(lines) + "\n").encode()
        ticket = http_json(
            self.url("/v1/uploads"),
            "POST",
            {
                "purpose": "dataset_import",
                "filename": "traces.jsonl",
                "size_bytes": len(body),
                "sha256": hashlib.sha256(body).hexdigest(),
            },
        )
        target = ticket["url"] if ticket["url"].startswith("http") else self.url(ticket["url"])
        http(target, "PUT", data=body, headers=ticket["headers"])
        job = http_json(
            self.url(f"/v1/datasets/{dataset}/imports"),
            "POST",
            {"source": {"kind": "upload", "upload_id": ticket["upload_id"]}},
        )
        self.assertIsNotNone(self.worker.run_once(), "worker found no import job")
        return http_json(self.url(f"/v1/imports/{job['id']}"))

    def test_import_then_sft_produces_a_peft_loadable_artifact(self) -> None:
        try:
            self._run()
        except Exception:
            print(self.server.log_tail())
            raise

    def _run(self) -> None:
        good = [
            json.dumps(
                {
                    "session_id": f"s{i}",
                    "messages": [
                        {"role": "user", "content": f"What is {i} plus {i}?"},
                        {"role": "assistant", "content": f"{i + i}"},
                    ],
                }
            )
            for i in range(12)
        ]
        http_json(self.url("/v1/datasets"), "POST", {"name": "math"})
        imported = self.import_jsonl("math", [*good, "{not json"])
        self.assertEqual(imported["status"], "completed", imported)
        self.assertEqual(imported["imported_count"], 12)
        self.assertEqual(imported["dropped_count"], 1)
        self.assertEqual(len(imported["drop_reasons"]), 1)
        self.assertIn("invalid JSON", imported["drop_reasons"][0])

        run = http_json(
            self.url("/v1/runs"),
            "POST",
            {
                "dataset": "math",
                "name": "math-sft",
                "recipe": {"kind": "sft", "model": QWEN_ID, "batch_size": 2, "epochs": 1},
            },
        )
        self.assertIsNotNone(self.worker.run_once(), "worker found no training job")

        run = http_json(self.url(f"/v1/runs/{run['id']}"))
        self.assertEqual(run["status"], "completed", run)
        self.assertGreater(run["tokens_processed"], 0)
        self.assertGreater(run["cost_usd"], 0)

        artifact_id = urllib.parse.quote(run["artifact_id"], safe="")
        artifact = http_json(self.url(f"/v1/artifacts/{artifact_id}"))
        self.assertEqual(artifact["format"], "peft_lora")
        _, blob, _ = http(self.url(f"/v1/artifacts/{artifact_id}/download"))
        self.assertEqual(hashlib.sha256(blob).hexdigest(), artifact["sha256"])

        bundle = self.server.dir / "artifact.grad.tar.gz"
        bundle.write_bytes(blob)
        out = self.server.dir / "artifact"
        manifest = extract_bundle(bundle, out)
        self.assertEqual(manifest["format"], "peft_lora")
        self.assertTrue((out / "adapter_config.json").is_file())

        import torch
        from peft import PeftModel
        from transformers import AutoModelForCausalLM

        base = AutoModelForCausalLM.from_pretrained(self.models[QWEN_ID])
        ids = torch.tensor([[1, 2, 3, 4]])
        with torch.no_grad():
            before = base(ids).logits.clone()
        tuned = PeftModel.from_pretrained(base, str(out))
        with torch.no_grad():
            after = tuned(ids).logits
        self.assertEqual(before.shape, after.shape)
        self.assertFalse(torch.allclose(before, after), "the trained adapter must change the logits")


if __name__ == "__main__":
    unittest.main()
