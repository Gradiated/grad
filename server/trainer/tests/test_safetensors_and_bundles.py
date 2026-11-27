"""Tests for gradiated.cartridge/1 safetensors binary format and .grad.tar.gz bundles."""

from __future__ import annotations

import unittest

from grad_trainer.bundles import build_artifact_bundle, read_artifact_bundle
from grad_trainer.safetensors_io import (
    decode_safetensors,
    encode_cartridge_safetensors,
)


class SafetensorsAndBundleTests(unittest.TestCase):
    def test_cartridge_safetensors_roundtrip(self) -> None:
        num_tokens, hidden = 16, 8
        embs = [float(i) * 0.01 for i in range(num_tokens * hidden)]
        slots = list(range(151646, 151646 + num_tokens))
        raw = encode_cartridge_safetensors(
            embeddings=embs,
            num_tokens=num_tokens,
            hidden_size=hidden,
            base_model="qwen/qwen3-8b",
            slot_token_ids=slots,
        )

        meta, tensors = decode_safetensors(raw)
        self.assertEqual(meta["format"], "gradiated.cartridge/1")
        self.assertEqual(meta["placement"], "system_prompt_start")
        self.assertEqual(meta["separator"], "\n\n")
        self.assertEqual(meta["base_model"], "qwen/qwen3-8b")
        self.assertEqual(tensors["embeddings"].shape, (num_tokens, hidden))
        self.assertEqual(tensors["slot_token_ids"].shape, (num_tokens,))
        self.assertEqual(list(tensors["slot_token_ids"].values), slots)

    def test_artifact_bundle_checksum_verification(self) -> None:
        bundle = build_artifact_bundle(
            manifest={"recipe": "sft", "base_model": "qwen/qwen3-8b"},
            eval_report={"eval_loss": 0.42},
            files={"weights.bin": b"hello-weights"},
        )
        manifest, files = read_artifact_bundle(bundle)
        self.assertEqual(manifest["schema"], "grad.artifact/1")
        self.assertEqual(files["weights.bin"], b"hello-weights")
        self.assertIn("eval_report.json", files)

    def test_rejects_malformed_safetensors_and_oversized_bundles(self) -> None:
        from grad_trainer.safetensors_io import encode_safetensors, TensorSpec
        import json, struct

        bad_header = json.dumps(
            {"x": {"dtype": "BAD", "shape": [1], "data_offsets": [0, 4]}}
        ).encode("utf-8")
        with self.assertRaises(ValueError):
            decode_safetensors(struct.pack("<Q", len(bad_header)) + bad_header + b"1234")

        bundle = build_artifact_bundle(
            manifest={"recipe": "sft"},
            files={"big.bin": b"a" * 1024},
        )
        with self.assertRaisesRegex(ValueError, "uncompressed limit"):
            read_artifact_bundle(bundle, max_uncompressed_bytes=128)


if __name__ == "__main__":
    unittest.main()
