"""Pure-Python safetensors writer/reader supporting gradiated.cartridge/1."""

from __future__ import annotations

import json
import math
import struct
from dataclasses import dataclass
from typing import Sequence

DTYPE_INFO: dict[str, tuple[str, int]] = {
    "F32": ("<f", 4),
    "I64": ("<q", 8),
}

MAX_HEADER_BYTES = 10 * 1024 * 1024


@dataclass(frozen=True)
class TensorSpec:
    name: str
    dtype: str
    shape: tuple[int, ...]
    values: tuple[float | int, ...]


def encode_safetensors(
    tensors: Sequence[TensorSpec],
    metadata: dict[str, str] | None = None,
) -> bytes:
    """Encode tensors + optional __metadata__ into valid Hugging Face safetensors bytes."""
    header: dict[str, object] = {}
    if metadata:
        header["__metadata__"] = {str(k): str(v) for k, v in metadata.items()}

    payload_parts: list[bytes] = []
    offset = 0
    for tensor in tensors:
        if tensor.dtype not in DTYPE_INFO:
            raise ValueError(f"Unsupported safetensors dtype: {tensor.dtype}")
        fmt_char, _item_size = DTYPE_INFO[tensor.dtype]
        if any(not isinstance(d, int) or d < 0 for d in tensor.shape):
            raise ValueError(f"Invalid shape in {tensor.name}: {tensor.shape}")
        expected_count = math.prod(tensor.shape) if tensor.shape else 1
        if len(tensor.values) != expected_count:
            raise ValueError(
                f"Tensor '{tensor.name}' value count {len(tensor.values)} != shape product {expected_count}"
            )

        raw = struct.pack(f"<{expected_count}{fmt_char[1]}", *tensor.values)
        end = offset + len(raw)
        header[tensor.name] = {
            "dtype": tensor.dtype,
            "shape": list(tensor.shape),
            "data_offsets": [offset, end],
        }
        payload_parts.append(raw)
        offset = end

    header_bytes = json.dumps(header, separators=(",", ":"), sort_keys=True).encode(
        "utf-8"
    )
    return struct.pack("<Q", len(header_bytes)) + header_bytes + b"".join(payload_parts)


def decode_safetensors(data: bytes) -> tuple[dict[str, str], dict[str, TensorSpec]]:
    """Decode safetensors bytes back into (__metadata__, tensors) with strict validation."""
    if len(data) < 8:
        raise ValueError("Invalid safetensors payload: shorter than 8 bytes.")
    (header_len,) = struct.unpack("<Q", data[:8])
    if header_len > MAX_HEADER_BYTES or 8 + header_len > len(data):
        raise ValueError("Invalid safetensors header length.")

    try:
        header = json.loads(data[8 : 8 + header_len].decode("utf-8"))
    except Exception as exc:
        raise ValueError(f"Invalid safetensors JSON header: {exc}") from exc
    if not isinstance(header, dict):
        raise ValueError("Safetensors header must be a JSON object.")

    raw_meta = header.pop("__metadata__", {})
    metadata = {str(k): str(v) for k, v in raw_meta.items()} if isinstance(raw_meta, dict) else {}
    body = data[8 + header_len :]

    tensors: dict[str, TensorSpec] = {}
    for name, info in header.items():
        if not isinstance(info, dict):
            raise ValueError(f"Malformed tensor metadata for '{name}'.")
        dtype = str(info.get("dtype", ""))
        if dtype not in DTYPE_INFO:
            raise ValueError(f"Unsupported safetensors dtype '{dtype}' for tensor '{name}'.")
        raw_shape = info.get("shape")
        if not isinstance(raw_shape, list) or any(
            not isinstance(d, int) or isinstance(d, bool) or d < 0 for d in raw_shape
        ):
            raise ValueError(f"Invalid shape for tensor '{name}': {raw_shape!r}")
        shape = tuple(raw_shape)

        offsets = info.get("data_offsets")
        if not isinstance(offsets, list) or len(offsets) != 2:
            raise ValueError(f"Invalid data_offsets for tensor '{name}'.")
        start, end = int(offsets[0]), int(offsets[1])
        if start < 0 or end > len(body) or end < start:
            raise ValueError(f"Out-of-bounds data_offsets for tensor '{name}'.")

        fmt_char, item_size = DTYPE_INFO[dtype]
        byte_len = end - start
        if byte_len % item_size != 0:
            raise ValueError(
                f"Misaligned byte length {byte_len} for dtype {dtype} in tensor '{name}'."
            )
        count = byte_len // item_size
        expected = math.prod(shape) if shape else 1
        if count != expected:
            raise ValueError(
                f"Tensor '{name}' element count {count} does not match shape {shape} ({expected})."
            )

        values = struct.unpack(f"<{count}{fmt_char[1]}", body[start:end])
        tensors[name] = TensorSpec(name=name, dtype=dtype, shape=shape, values=values)

    return metadata, tensors


def encode_cartridge_safetensors(
    *,
    embeddings: Sequence[float],
    num_tokens: int,
    hidden_size: int,
    base_model: str,
    slot_token_ids: Sequence[int] | None = None,
    separator: str = "\n\n",
) -> bytes:
    """Encode a gradiated.cartridge/1 safetensors file matching docs/CARTRIDGE_SERVING_PLAN.md."""
    tensors = [
        TensorSpec(
            name="embeddings",
            dtype="F32",
            shape=(num_tokens, hidden_size),
            values=tuple(float(v) for v in embeddings),
        )
    ]
    if slot_token_ids is not None:
        tensors.append(
            TensorSpec(
                name="slot_token_ids",
                dtype="I64",
                shape=(num_tokens,),
                values=tuple(int(i) for i in slot_token_ids),
            )
        )

    metadata = {
        "format": "gradiated.cartridge/1",
        "base_model": base_model,
        "placement": "system_prompt_start",
        "separator": separator,
        "num_tokens": str(num_tokens),
        "hidden_size": str(hidden_size),
    }
    return encode_safetensors(tensors, metadata=metadata)
