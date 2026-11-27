"""Strict safetensors codec and gradiated.cartridge/1 helpers."""

from __future__ import annotations

import json
import struct
import unittest

from helpers import TempDirCase

from grad_trainer.safetensors_io import (
    TensorSpec,
    decode_safetensors,
    encode_cartridge_safetensors,
    encode_safetensors,
    inspect_safetensors,
    validate_cartridge,
)


def raw(header: dict, body: bytes, header_bytes: bytes | None = None) -> bytes:
    hb = header_bytes if header_bytes is not None else json.dumps(header).encode()
    return struct.pack("<Q", len(hb)) + hb + body


class CodecTests(TempDirCase):
    def test_roundtrip_all_dtypes_and_alignment(self) -> None:
        tensors = [
            TensorSpec("a", "F32", (2, 2), (1.0, -2.5, 3.0, 0.0)),
            TensorSpec("b", "I64", (3,), (1, -2, 2**40)),
            TensorSpec("c", "BF16", (3,), (1.0, -0.5, 3.140625)),
            TensorSpec("d", "F16", (1,), (0.5,)),
            TensorSpec("e", "I32", (0,), ()),
        ]
        data = encode_safetensors(tensors, metadata={"k": "v"})
        (header_len,) = struct.unpack("<Q", data[:8])
        self.assertEqual(header_len % 8, 0)
        meta, decoded = decode_safetensors(data)
        self.assertEqual(meta, {"k": "v"})
        for t in tensors:
            self.assertEqual(decoded[t.name].values, t.values)
            self.assertEqual(decoded[t.name].shape, t.shape)

    def test_bf16_rounds_to_nearest_even_and_keeps_nan(self) -> None:
        _, out = decode_safetensors(encode_safetensors([TensorSpec("x", "BF16", (2,), (1.00390625, float("nan")))]))
        self.assertEqual(out["x"].values[0], 1.0)
        self.assertNotEqual(out["x"].values[1], out["x"].values[1])

    def test_encoder_rejects_bad_tensors(self) -> None:
        for tensors in (
            [TensorSpec("x", "BAD", (1,), (1,))],
            [TensorSpec("x", "F32", (-1,), ())],
            [TensorSpec("x", "F32", (True,), (1.0,))],
            [TensorSpec("x", "F32", (2,), (1.0,))],
            [TensorSpec("x", "F32", (1,), (1.0,)), TensorSpec("x", "F32", (1,), (1.0,))],
            [TensorSpec("__metadata__", "F32", (1,), (1.0,))],
        ):
            with self.subTest(tensors=tensors), self.assertRaises(ValueError):
                encode_safetensors(tensors)

    def test_decoder_rejects_malformed_files(self) -> None:
        ok = {"dtype": "F32", "shape": [1], "data_offsets": [0, 4]}
        four = b"\0\0\0\0"
        cases = {
            "short": b"1234",
            "header too long": struct.pack("<Q", 10**9) + b"{}",
            "not json": raw({}, b"", b"{nope"),
            "not object": raw({}, b"", b"[1]"),
            "duplicate key": raw({}, four, b'{"x":' + json.dumps(ok).encode() + b',"x":' + json.dumps(ok).encode() + b"}"),
            "bad metadata": raw({"__metadata__": {"a": 1}, "x": ok}, four),
            "bad info": raw({"x": 3}, four),
            "bad dtype": raw({"x": {**ok, "dtype": "BAD"}}, four),
            "bool shape": raw({"x": {**ok, "shape": [True]}}, four),
            "neg shape": raw({"x": {**ok, "shape": [-1]}}, four),
            "float offsets": raw({"x": {**ok, "data_offsets": [0.0, 4]}}, four),
            "string offsets": raw({"x": {**ok, "data_offsets": [0, "4"]}}, four),
            "reversed": raw({"x": {**ok, "data_offsets": [4, 0]}}, four),
            "out of range": raw({"x": {**ok, "data_offsets": [0, 8]}}, four),
            "size mismatch": raw({"x": {**ok, "shape": [2]}}, four),
            "overlap": raw({"x": ok, "y": ok}, four),
            "hole": raw({"x": {**ok, "data_offsets": [4, 8]}}, four + four),
            "trailing bytes": raw({"x": ok}, four + b"extra"),
        }
        for name, data in cases.items():
            with self.subTest(name), self.assertRaises(ValueError):
                decode_safetensors(data)

    def test_inspect_reads_header_only_and_matches_torch_writer(self) -> None:
        path = self.tmpdir() / "x.safetensors"
        path.write_bytes(encode_safetensors([TensorSpec("w", "F32", (2,), (1.0, 2.0))], {"m": "1"}))
        meta, header = inspect_safetensors(path)
        self.assertEqual(meta, {"m": "1"})
        self.assertEqual(header["w"]["shape"], [2])
        bad = self.tmpdir() / "bad.safetensors"
        bad.write_bytes(b"123")
        with self.assertRaises(ValueError):
            inspect_safetensors(bad)
        bad.write_bytes(struct.pack("<Q", 100) + b"{}")
        with self.assertRaises(ValueError):
            inspect_safetensors(bad)
        try:
            import torch
            from safetensors.torch import load_file, save_file
        except ImportError:
            return
        theirs = self.tmpdir() / "t.safetensors"
        save_file({"a": torch.ones(2, 3), "b": torch.arange(4)}, str(theirs), metadata={"x": "y"})
        meta, tensors = decode_safetensors(theirs.read_bytes())
        self.assertEqual(tensors["a"].values, (1.0,) * 6)
        self.assertEqual(tensors["b"].values, (0, 1, 2, 3))
        ours = self.tmpdir() / "o.safetensors"
        ours.write_bytes(encode_safetensors([TensorSpec("c", "BF16", (2,), (0.5, -1.0))]))
        self.assertEqual(load_file(str(ours))["c"].float().tolist(), [0.5, -1.0])


class CartridgeFormatTests(unittest.TestCase):
    def test_cartridge_roundtrip_and_validation(self) -> None:
        data = encode_cartridge_safetensors(
            embeddings=[0.25] * 32, num_tokens=4, hidden_size=8, base_model="Qwen/Qwen3-8B", slot_token_ids=[7] * 4
        )
        meta, tensors = decode_safetensors(data)
        self.assertEqual(meta["format"], "gradiated.cartridge/1")
        self.assertEqual(tensors["embeddings"].dtype, "BF16")
        header = {n: {"dtype": t.dtype, "shape": list(t.shape)} for n, t in tensors.items()}
        self.assertEqual(validate_cartridge(meta, header, hidden_size=8, max_context=16), 4)
        with self.assertRaisesRegex(ValueError, "hidden size"):
            validate_cartridge(meta, header, hidden_size=16)
        with self.assertRaisesRegex(ValueError, "context length"):
            validate_cartridge(meta, header, max_context=4)
        with self.assertRaises(ValueError):
            validate_cartridge({**meta, "format": "x"}, header)
        with self.assertRaises(ValueError):
            validate_cartridge(meta, {**header, "slot_token_ids": {"dtype": "I32", "shape": [4]}})
        with self.assertRaises(ValueError):
            validate_cartridge(meta, {**header, "extra": {"dtype": "F32", "shape": [1]}})
        with self.assertRaises(ValueError):
            validate_cartridge(meta, {"embeddings": {"dtype": "I64", "shape": [4, 8]}})


if __name__ == "__main__":
    unittest.main()
