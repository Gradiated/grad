"""Tiny, randomly initialised test models for trying grad on a laptop (``GRAD_DEV_MODELS=1``).

``grad local up --dev-models`` registers them in the server catalog and sets
``GRAD_DEV_MODELS=1`` on the trainer, which builds their weights locally on first use (no
network, a few seconds on a CPU) under ``$GRAD_DEV_MODELS_DIR`` (default
``$HF_HOME/grad-dev-models``). They learn nothing useful: artifacts trained on them carry
``test_only: true`` in their manifest. The trainer's tests build the same models.

- ``test/tiny-qwen3`` and ``test/tiny-qwen3-teacher``: 2-layer Qwen3 causal LMs with a
  byte-level BPE tokenizer that has the Qwen3 special tokens and the upstream chat template.
- ``test/tiny-bert``: a 2-layer BERT encoder with a WordPiece tokenizer.
"""

from __future__ import annotations

import os
import shutil
import tempfile
from pathlib import Path

QWEN_ID = "test/tiny-qwen3"
QWEN_TEACHER_ID = "test/tiny-qwen3-teacher"
BERT_ID = "test/tiny-bert"
QWEN3_TEMPLATE = (Path(__file__).resolve().parent / "qwen3_chat_template.jinja").read_text()

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



def build_qwen(directory: Path, seed: int, layers: int = 2, hidden: int = 32) -> None:
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


def build_bert(directory: Path, seed: int) -> None:
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


#: Model id -> (builder, seed). Seeds match the trainer's test fixtures.
DEV_MODELS = {
    QWEN_ID: (build_qwen, 1),
    QWEN_TEACHER_ID: (build_qwen, 2),
    BERT_ID: (build_bert, 3),
}


def enabled() -> bool:
    return os.environ.get("GRAD_DEV_MODELS", "").strip().lower() in ("1", "true", "yes")


def models_dir() -> Path:
    explicit = os.environ.get("GRAD_DEV_MODELS_DIR", "").strip()
    if explicit:
        return Path(explicit).expanduser()
    hf_home = os.environ.get("HF_HOME", "").strip()
    base = Path(hf_home).expanduser() if hf_home else Path.home() / ".cache" / "huggingface"
    return base / "grad-dev-models"


def ensure(model_id: str) -> Path:
    """The directory holding ``model_id``'s weights, built on first use (atomically)."""
    builder, seed = DEV_MODELS[model_id]
    target = models_dir() / model_id
    if (target / "config.json").is_file():
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = Path(tempfile.mkdtemp(prefix=".building-", dir=target.parent))
    try:
        builder(tmp, seed=seed)
        try:
            tmp.rename(target)
        except OSError:
            if not (target / "config.json").is_file():
                raise
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    return target
