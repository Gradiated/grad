"""Tiny randomly initialised models and tokenizers built locally (no network) for tests.

- ``tiny-qwen3``: a 2-layer Qwen3 causal LM with a byte-level BPE tokenizer that has the
  Qwen3 special tokens and the upstream Qwen3 chat template.
- ``tiny-bert``: a 2-layer BERT encoder with a WordPiece tokenizer.

Models are built once per process into ``$TMPDIR/grad-trainer-fixtures-<pid>`` and registered
through ``GRAD_MODEL_PATHS`` under the ids ``test/tiny-qwen3`` and ``test/tiny-bert``.
"""

from __future__ import annotations

import atexit
import json
import os
import shutil
import tempfile
from pathlib import Path

FIXTURES = Path(__file__).resolve().parent
QWEN3_TEMPLATE = (FIXTURES / "qwen3_chat_template.jinja").read_text()
QWEN_ID = "test/tiny-qwen3"
QWEN_TEACHER_ID = "test/tiny-qwen3-teacher"
BERT_ID = "test/tiny-bert"

QWEN_SPECIALS = ["<|endoftext|>", "<|im_start|>", "<|im_end|>", "<|vision_pad|>", "<|fim_pad|>"]
QWEN_ADDED = ["<think>", "</think>", "<tool_call>", "</tool_call>", "<tool_response>", "</tool_response>"]

CORPUS = [
    "How do I reset my password? Open Settings and choose Reset Password.",
    "The quick brown fox jumps over the lazy dog.",
    "Billing invoices are sent monthly. Refunds take five days.",
    "system user assistant tool call response think answer question",
    "Merge this diff into the original file and return the merged code.",
    "SELECT name FROM users WHERE id = 1; translate hello bonjour",
    '{"name": "get_weather", "arguments": {"city": "Paris"}} weather sunny rain',
    "To rotate an API key open Settings then API Keys and click Regenerate.",
    "Charges payments broken urgent today wait ticket category effort",
    "0 1 2 3 4 5 6 7 8 9 # Tools functions XML tags signatures provided",
]

_root: Path | None = None


def _build_qwen(directory: Path, seed: int, layers: int = 2, hidden: int = 32) -> None:
    import torch
    from tokenizers import AddedToken, Tokenizer, decoders, models, pre_tokenizers, trainers
    from transformers import PreTrainedTokenizerFast, Qwen3Config, Qwen3ForCausalLM

    tok = Tokenizer(models.BPE())
    tok.pre_tokenizer = pre_tokenizers.ByteLevel(add_prefix_space=False)
    tok.decoder = decoders.ByteLevel()
    trainer = trainers.BpeTrainer(
        vocab_size=512,
        special_tokens=QWEN_SPECIALS,
        initial_alphabet=pre_tokenizers.ByteLevel.alphabet(),
        show_progress=False,
    )
    tok.train_from_iterator(CORPUS * 10, trainer)
    tok.add_tokens([AddedToken(t, special=False, normalized=False) for t in QWEN_ADDED])
    fast = PreTrainedTokenizerFast(
        tokenizer_object=tok,
        eos_token="<|im_end|>",
        pad_token="<|endoftext|>",
        chat_template=QWEN3_TEMPLATE,
    )
    fast.model_max_length = 512
    fast.save_pretrained(str(directory))

    torch.manual_seed(seed)
    config = Qwen3Config(
        vocab_size=len(fast),
        hidden_size=hidden,
        intermediate_size=hidden * 2,
        num_hidden_layers=layers,
        num_attention_heads=4,
        num_key_value_heads=2,
        head_dim=hidden // 4,
        max_position_embeddings=512,
        tie_word_embeddings=False,
        eos_token_id=fast.convert_tokens_to_ids("<|im_end|>"),
        pad_token_id=fast.pad_token_id,
        bos_token_id=fast.convert_tokens_to_ids("<|endoftext|>"),
    )
    Qwen3ForCausalLM(config).save_pretrained(str(directory))


def _build_bert(directory: Path, seed: int) -> None:
    import torch
    from tokenizers import Tokenizer, models, normalizers, pre_tokenizers, processors, trainers
    from transformers import BertConfig, BertModel, PreTrainedTokenizerFast

    specials = ["[PAD]", "[UNK]", "[CLS]", "[SEP]", "[MASK]"]
    tok = Tokenizer(models.WordPiece(unk_token="[UNK]"))
    tok.normalizer = normalizers.BertNormalizer(lowercase=True)
    tok.pre_tokenizer = pre_tokenizers.BertPreTokenizer()
    tok.train_from_iterator(
        CORPUS * 10, trainers.WordPieceTrainer(vocab_size=400, special_tokens=specials, show_progress=False)
    )
    cls_id, sep_id = tok.token_to_id("[CLS]"), tok.token_to_id("[SEP]")
    tok.post_processor = processors.TemplateProcessing(
        single="[CLS] $A [SEP]", pair="[CLS] $A [SEP] $B [SEP]", special_tokens=[("[CLS]", cls_id), ("[SEP]", sep_id)]
    )
    fast = PreTrainedTokenizerFast(
        tokenizer_object=tok, unk_token="[UNK]", pad_token="[PAD]", cls_token="[CLS]", sep_token="[SEP]", mask_token="[MASK]"
    )
    fast.model_max_length = 128
    fast.save_pretrained(str(directory))
    torch.manual_seed(seed)
    config = BertConfig(
        vocab_size=len(fast),
        hidden_size=32,
        num_hidden_layers=2,
        num_attention_heads=4,
        intermediate_size=64,
        max_position_embeddings=128,
        pad_token_id=fast.pad_token_id,
    )
    BertModel(config).save_pretrained(str(directory))


def ensure_tiny_models() -> dict[str, Path]:
    """Build the tiny models once and register them in GRAD_MODEL_PATHS."""
    global _root
    if _root is None:
        import torch

        torch.set_num_threads(int(os.environ.get("GRAD_TEST_THREADS", "4")))
        _root = Path(tempfile.mkdtemp(prefix=f"grad-trainer-fixtures-{os.getpid()}-"))
        atexit.register(shutil.rmtree, _root, True)
        _build_qwen(_root / "tiny-qwen3", seed=1)
        _build_qwen(_root / "tiny-qwen3-teacher", seed=2)
        _build_bert(_root / "tiny-bert", seed=3)
    paths = {
        QWEN_ID: _root / "tiny-qwen3",
        QWEN_TEACHER_ID: _root / "tiny-qwen3-teacher",
        BERT_ID: _root / "tiny-bert",
    }
    os.environ["GRAD_MODEL_PATHS"] = json.dumps({k: str(v) for k, v in paths.items()})
    os.environ["GRAD_OFFLINE"] = "1"
    return paths


def torch_available() -> bool:
    try:
        import peft  # noqa: F401
        import torch  # noqa: F401
        import transformers  # noqa: F401
    except ImportError:
        return False
    return True
