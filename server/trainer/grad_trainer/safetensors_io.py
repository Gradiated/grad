"""Strict pure-Python safetensors codec (no torch) and ``gradiated.cartridge/1`` helpers.

The decoder follows the reference implementation's rules: integer offsets only, tensors
sorted by offset must tile the data section exactly (no overlap, holes or trailing bytes),
duplicate JSON keys are rejected, and the header is bounded. The encoder pads the header with
spaces to an 8-byte boundary, as the reference writer does.
"""

from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass
from pathlib import Path
from typing import Any, BinaryIO, Sequence

CARTRIDGE_FORMAT = "gradiated.cartridge/1"
MAX_HEADER_BYTES = 10 * 1024 * 1024

# dtype -> (struct format char or None for bf16, item size)
DTYPE_INFO: dict[str, tuple[str | None, int]] = {
    "F32": ("f", 4),
    "F16": ("e", 2),
    "BF16": (None, 2),
    "I64": ("q", 8),
    "I32": ("i", 4),
}


@dataclass(frozen=True)
class TensorSpec:
    name: str
    dtype: str
    shape: tuple[int, ...]
    values: tuple[float | int, ...]


def _is_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def _bf16_pack(values: Sequence[float]) -> bytes:
    out = bytearray()
    for v in values:
        (bits,) = struct.unpack("<I", struct.pack("<f", float(v)))
        if (bits & 0x7F800000) == 0x7F800000 and bits & 0x007FFFFF:
            rounded = 0x7FC0  # NaN
        else:
            rounded = (bits + 0x7FFF + ((bits >> 16) & 1)) >> 16  # round to nearest even
        out += struct.pack("<H", rounded & 0xFFFF)
    return bytes(out)


def _bf16_unpack(raw: bytes) -> tuple[float, ...]:
    halves = struct.unpack(f"<{len(raw) // 2}H", raw)
    return tuple(struct.unpack("<f", struct.pack("<I", h << 16))[0] for h in halves)


def _pack(dtype: str, values: Sequence[float | int]) -> bytes:
    fmt, _ = DTYPE_INFO[dtype]
    if fmt is None:
        return _bf16_pack([float(v) for v in values])
    return struct.pack(f"<{len(values)}{fmt}", *values)


def _unpack(dtype: str, raw: bytes, count: int) -> tuple[float | int, ...]:
    fmt, _ = DTYPE_INFO[dtype]
    if fmt is None:
        return _bf16_unpack(raw)
    return struct.unpack(f"<{count}{fmt}", raw)


def encode_safetensors(tensors: Sequence[TensorSpec], metadata: dict[str, str] | None = None) -> bytes:
    header: dict[str, object] = {}
    if metadata:
        header["__metadata__"] = {str(k): str(v) for k, v in metadata.items()}
    payload: list[bytes] = []
    offset = 0
    for tensor in tensors:
        if tensor.name == "__metadata__" or not tensor.name:
            raise ValueError(f"Invalid tensor name {tensor.name!r}.")
        if tensor.name in header:
            raise ValueError(f"Duplicate tensor name '{tensor.name}'.")
        if tensor.dtype not in DTYPE_INFO:
            raise ValueError(f"Unsupported safetensors dtype: {tensor.dtype}")
        if any(not _is_int(d) or d < 0 for d in tensor.shape):
            raise ValueError(f"Invalid shape in {tensor.name}: {tensor.shape}")
        count = math.prod(tensor.shape)
        if len(tensor.values) != count:
            raise ValueError(f"Tensor '{tensor.name}' value count {len(tensor.values)} != shape product {count}")
        raw = _pack(tensor.dtype, tensor.values)
        header[tensor.name] = {"dtype": tensor.dtype, "shape": list(tensor.shape), "data_offsets": [offset, offset + len(raw)]}
        payload.append(raw)
        offset += len(raw)
    header_bytes = json.dumps(header, separators=(",", ":"), sort_keys=True).encode("utf-8")
    header_bytes += b" " * (-len(header_bytes) % 8)
    return struct.pack("<Q", len(header_bytes)) + header_bytes + b"".join(payload)


def _no_duplicates(pairs: list[tuple[str, Any]]) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for key, value in pairs:
        if key in out:
            raise ValueError(f"Duplicate key '{key}' in safetensors header.")
        out[key] = value
    return out


def parse_header(raw_header: bytes, data_len: int) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    """Validate a safetensors JSON header against a data section of ``data_len`` bytes."""
    try:
        header = json.loads(raw_header.decode("utf-8"), object_pairs_hook=_no_duplicates)
    except ValueError as exc:
        raise ValueError(f"Invalid safetensors JSON header: {exc}") from exc
    if not isinstance(header, dict):
        raise ValueError("Safetensors header must be a JSON object.")
    raw_meta = header.pop("__metadata__", {})
    if not isinstance(raw_meta, dict) or any(not isinstance(v, str) for v in raw_meta.values()):
        raise ValueError("__metadata__ must be an object of strings.")

    spans: list[tuple[int, int, str]] = []
    for name, info in header.items():
        if not isinstance(info, dict):
            raise ValueError(f"Malformed tensor metadata for '{name}'.")
        dtype = info.get("dtype")
        if dtype not in DTYPE_INFO:
            raise ValueError(f"Unsupported safetensors dtype '{dtype}' for tensor '{name}'.")
        shape = info.get("shape")
        if not isinstance(shape, list) or any(not _is_int(d) or d < 0 for d in shape):
            raise ValueError(f"Invalid shape for tensor '{name}': {shape!r}")
        offsets = info.get("data_offsets")
        if not isinstance(offsets, list) or len(offsets) != 2 or not all(_is_int(o) for o in offsets):
            raise ValueError(f"Invalid data_offsets for tensor '{name}'.")
        start, end = offsets
        if start < 0 or end < start or end > data_len:
            raise ValueError(f"Out-of-bounds data_offsets for tensor '{name}'.")
        if end - start != math.prod(shape) * DTYPE_INFO[dtype][1]:
            raise ValueError(f"Tensor '{name}' byte length does not match shape {shape} and dtype {dtype}.")
        spans.append((start, end, name))

    cursor = 0
    for start, end, name in sorted(spans):
        if start != cursor:
            raise ValueError(f"Tensor '{name}' overlaps another tensor or leaves a hole in the data.")
        cursor = end
    if cursor != data_len:
        raise ValueError("Safetensors data section has bytes not covered by any tensor.")
    return dict(raw_meta), header


def _read_prefix(data: bytes) -> int:
    if len(data) < 8:
        raise ValueError("Invalid safetensors payload: shorter than 8 bytes.")
    (header_len,) = struct.unpack("<Q", data[:8])
    if header_len > MAX_HEADER_BYTES or 8 + header_len > len(data):
        raise ValueError("Invalid safetensors header length.")
    return header_len


def decode_safetensors(data: bytes) -> tuple[dict[str, str], dict[str, TensorSpec]]:
    header_len = _read_prefix(data)
    body = data[8 + header_len :]
    metadata, header = parse_header(data[8 : 8 + header_len], len(body))
    tensors: dict[str, TensorSpec] = {}
    for name, info in header.items():
        start, end = info["data_offsets"]
        count = math.prod(info["shape"])
        tensors[name] = TensorSpec(name, info["dtype"], tuple(info["shape"]), _unpack(info["dtype"], body[start:end], count))
    return metadata, tensors


def inspect_safetensors(path: Path) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    """Validate a file's header without reading the tensor data into memory."""
    with open(path, "rb") as fh:
        return _inspect_stream(fh, Path(path).stat().st_size)


def _inspect_stream(fh: BinaryIO, size: int) -> tuple[dict[str, str], dict[str, dict[str, Any]]]:
    prefix = fh.read(8)
    if len(prefix) < 8:
        raise ValueError("Invalid safetensors payload: shorter than 8 bytes.")
    (header_len,) = struct.unpack("<Q", prefix)
    if header_len > MAX_HEADER_BYTES or 8 + header_len > size:
        raise ValueError("Invalid safetensors header length.")
    return parse_header(fh.read(header_len), size - 8 - header_len)


def encode_cartridge_safetensors(
    *,
    embeddings: Sequence[float],
    num_tokens: int,
    hidden_size: int,
    base_model: str,
    slot_token_ids: Sequence[int] | None = None,
    separator: str = "\n\n",
    dtype: str = "BF16",
) -> bytes:
    """Encode a ``gradiated.cartridge/1`` file (docs/CARTRIDGE_SERVING_PLAN.md)."""
    tensors = [TensorSpec("embeddings", dtype, (num_tokens, hidden_size), tuple(float(v) for v in embeddings))]
    if slot_token_ids is not None:
        tensors.append(TensorSpec("slot_token_ids", "I64", (num_tokens,), tuple(int(i) for i in slot_token_ids)))
    metadata = {
        "format": CARTRIDGE_FORMAT,
        "base_model": base_model,
        "placement": "system_prompt_start",
        "separator": separator,
        "num_tokens": str(num_tokens),
        "hidden_size": str(hidden_size),
    }
    return encode_safetensors(tensors, metadata=metadata)


def validate_cartridge(
    metadata: dict[str, str],
    header: dict[str, dict[str, Any]],
    *,
    hidden_size: int | None = None,
    max_context: int | None = None,
) -> int:
    """Check a cartridge header (names, dtypes, shapes, metadata). Returns K."""
    if metadata.get("format") != CARTRIDGE_FORMAT or metadata.get("placement") != "system_prompt_start":
        raise ValueError("Not a gradiated.cartridge/1 file.")
    emb = header.get("embeddings")
    if not emb or emb["dtype"] not in ("BF16", "F32") or len(emb["shape"]) != 2:
        raise ValueError("Cartridge needs a 2-D bf16 'embeddings' tensor.")
    k, width = emb["shape"]
    if k < 1 or (max_context is not None and k >= max_context):
        raise ValueError(f"Cartridge has {k} tokens; it must be between 1 and the context length.")
    if hidden_size is not None and width != hidden_size:
        raise ValueError(f"Cartridge hidden size {width} != model hidden size {hidden_size}.")
    slots = header.get("slot_token_ids")
    if slots is not None and (slots["dtype"] != "I64" or slots["shape"] != [k]):
        raise ValueError("slot_token_ids must be int64 with shape [K].")
    if set(header) - {"embeddings", "slot_token_ids"}:
        raise ValueError("Cartridge contains unexpected tensors.")
    return int(k)
