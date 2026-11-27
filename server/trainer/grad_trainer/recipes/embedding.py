"""Embeddings: full fine-tune of a small encoder (bge-small class) with InfoNCE.

Each query is scored against every positive in the batch plus every explicit negative in the
batch (in-batch negatives); identical texts are not counted as negatives of each other.
``losses.InfoNCE(temp=0.05)`` is cross-entropy over cosine similarities / ``temp``. Pooling is
``mean`` (default, over non-padding tokens) or ``cls``, and vectors are L2-normalized.

Held-out retrieval ranks every eval query against the corpus of all eval positives and
negatives: ``recall_at_1/5/10`` (top-10 hit rate is the selection metric) and MRR. The report
includes the same metrics for the starting encoder. With no held-out pairs they are null.

The artifact is a standard transformers model directory (``config.json``,
``model.safetensors``, tokenizer files) plus sentence-transformers pooling files
(``modules.json``, ``1_Pooling/config.json``) and ``grad_embedding.json``.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F

from ..backends import torch_common as tc
from ..backends.torch_task import TorchTask
from ..config import TrainSpec
from ..errors import RecipeConfigError, RecipeDataError
from ..trainer import EvalResult
from .base import RecipeRunner

POOLING = ("mean", "cls")
RECALL_KS = (1, 5, 10)


def pooling_name(params: dict[str, Any]) -> str:
    pool = params.get("pool", params.get("pooling", "mean"))
    if isinstance(pool, dict):
        pool = pool.get("kind", pool.get("type", "mean"))
    pool = str(pool).lower()
    if pool not in POOLING:
        raise RecipeConfigError(f"Unsupported pooling '{pool}'; use one of {list(POOLING)}.")
    return pool


def info_nce(query: torch.Tensor, docs: torch.Tensor, positives: list[int], same: torch.Tensor, temp: float) -> torch.Tensor:
    """Per-query InfoNCE. ``same[i, j]`` masks docs identical to query i's positive (except j == positive)."""
    logits = query @ docs.T / temp
    target = torch.tensor(positives, device=query.device)
    keep = ~same
    keep[torch.arange(len(positives)), target] = True
    logits = logits.masked_fill(~keep, float("-inf"))
    return F.cross_entropy(logits, target, reduction="none")


class EmbeddingTask(TorchTask):
    kind = "embedding"
    artifact_format = "encoder_safetensors"
    metric_name = "recall_at_10"
    metric_mode = "max"

    def __init__(self, spec: TrainSpec, train: list[dict[str, Any]], held_out: list[dict[str, Any]], workdir: Path) -> None:
        super().__init__(spec, workdir)
        if spec.adapter.get("kind", "encoder_full") != "encoder_full":
            raise RecipeConfigError("EmbeddingRecipe trains all encoder weights (adapter kind 'encoder_full').")
        params = spec.params
        loss = params.get("loss") if isinstance(params.get("loss"), dict) else {}
        self.temp = float(loss.get("temp", params.get("temp", 0.05)))
        if self.temp <= 0:
            raise RecipeConfigError("InfoNCE temp must be positive.")
        self.pooling = pooling_name(params)
        self.resolved = self.resolve(spec.model, "encoder")
        self.tokenizer = tc.load_tokenizer(self.resolved)
        from transformers import AutoModel

        # Full fine-tuning keeps fp32 master weights (bf16 weights would round away small
        # updates); CUDA forwards run under bf16 autocast.
        self.model = AutoModel.from_pretrained(str(self.resolved.path), dtype=torch.float32).to(self.device)
        self.max_len = min(
            spec.max_seq_len or 512,
            int(getattr(self.model.config, "max_position_embeddings", 512)),
            int(getattr(self.tokenizer, "model_max_length", 512) or 512),
        )
        self.dropped = 0
        self.train = self._pairs(train)
        self.held_out = self._pairs(held_out)
        if not self.train:
            raise RecipeDataError("EmbeddingRecipe needs records with non-empty 'query' and 'positive'.")
        self.model.train()
        self.init_optimizer(self.model)
        self.pad_id = int(self.tokenizer.pad_token_id)
        self.baseline: dict[str, Any] | None = self._retrieval() if self.held_out else None

    def _tok(self, text: str) -> list[int]:
        return list(self.tokenizer(text, truncation=True, max_length=self.max_len)["input_ids"])

    def _pairs(self, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for rec in records:
            query, positive = rec.get("query"), rec.get("positive")
            if not isinstance(query, str) or not isinstance(positive, str) or not query.strip() or not positive.strip():
                self.dropped += 1
                continue
            negatives = [n for n in rec.get("negatives") or [] if isinstance(n, str) and n.strip() and n != positive]
            out.append(
                {
                    "query": self._tok(query),
                    "positive_text": positive,
                    "positive": self._tok(positive),
                    "negative_texts": negatives,
                    "negatives": [self._tok(n) for n in negatives],
                }
            )
        return out

    def encode(self, sequences: list[list[int]], *, grad: bool) -> torch.Tensor:
        outs = []
        for chunk in tc.chunk_by_tokens(range(len(sequences)), [len(s) for s in sequences], self.spec.micro_batch_tokens):
            ids, mask = tc.padded_batch([sequences[i] for i in chunk], self.pad_id, self.device)
            with torch.set_grad_enabled(grad), tc.autocast(self.device):
                hidden = self.model(input_ids=ids, attention_mask=mask).last_hidden_state.float()
                if self.pooling == "cls":
                    pooled = hidden[:, 0]
                else:
                    m = mask[..., None].float()
                    pooled = (hidden * m).sum(1) / m.sum(1).clamp(min=1.0)
                outs.append(F.normalize(pooled, dim=-1))
        return torch.cat(outs)

    def num_train_items(self) -> int:
        return len(self.train)

    def item_tokens(self, index: int) -> int:
        p = self.train[index]
        return len(p["query"]) + len(p["positive"]) + sum(len(n) for n in p["negatives"])

    def accumulate(self, indices: list[int]) -> dict[str, float]:
        # In-batch negatives need the whole batch in one graph.
        pairs = [self.train[i] for i in indices]
        doc_texts = [p["positive_text"] for p in pairs] + [n for p in pairs for n in p["negative_texts"]]
        doc_ids = [p["positive"] for p in pairs] + [n for p in pairs for n in p["negatives"]]
        q = self.encode([p["query"] for p in pairs], grad=True)
        d = self.encode(doc_ids, grad=True)
        same = torch.tensor(
            [[doc == p["positive_text"] for doc in doc_texts] for p in pairs], dtype=torch.bool, device=self.device
        )
        losses = info_nce(q, d, list(range(len(pairs))), same, self.temp)
        loss = losses.mean()
        loss.backward()
        return {"loss": float(loss.detach())}

    def _retrieval(self) -> dict[str, Any]:
        corpus_texts: list[str] = []
        corpus_ids: list[list[int]] = []
        index: dict[str, int] = {}
        for p in self.held_out:
            for text, ids in [(p["positive_text"], p["positive"])] + list(zip(p["negative_texts"], p["negatives"])):
                if text not in index:
                    index[text] = len(corpus_texts)
                    corpus_texts.append(text)
                    corpus_ids.append(ids)
        was_training = self.model.training
        self.model.eval()
        with torch.no_grad():
            q = self.encode([p["query"] for p in self.held_out], grad=False)
            d = self.encode(corpus_ids, grad=False)
        self.model.train(was_training)
        scores = q @ d.T
        target = torch.tensor([index[p["positive_text"]] for p in self.held_out], device=self.device)
        target_score = scores.gather(1, target[:, None])
        ranks = (scores > target_score).sum(1) + 1  # ties count in the query's favour
        metrics: dict[str, Any] = {f"recall_at_{k}": float((ranks <= k).float().mean()) for k in RECALL_KS}
        metrics["mrr"] = float((1.0 / ranks.float()).mean())
        metrics["corpus_size"] = len(corpus_texts)
        return metrics

    def evaluate(self) -> EvalResult | None:
        if not self.held_out:
            return None
        metrics = self._retrieval()
        return EvalResult(score=metrics.pop("recall_at_10"), metrics=metrics)

    def export(self, directory: Path) -> None:
        directory.mkdir(parents=True, exist_ok=True)
        self.model.save_pretrained(str(directory), safe_serialization=True)
        self.tokenizer.save_pretrained(str(directory))
        dim = int(self.model.config.hidden_size)
        (directory / "grad_embedding.json").write_text(
            json.dumps(
                {"pooling": self.pooling, "normalize": True, "dimensions": dim, "max_seq_length": self.max_len, "temp": self.temp},
                indent=2,
                sort_keys=True,
            )
        )
        (directory / "modules.json").write_text(
            json.dumps(
                [
                    {"idx": 0, "name": "0", "path": "", "type": "sentence_transformers.models.Transformer"},
                    {"idx": 1, "name": "1", "path": "1_Pooling", "type": "sentence_transformers.models.Pooling"},
                    {"idx": 2, "name": "2", "path": "2_Normalize", "type": "sentence_transformers.models.Normalize"},
                ],
                indent=2,
            )
        )
        (directory / "1_Pooling").mkdir(exist_ok=True)
        (directory / "1_Pooling" / "config.json").write_text(
            json.dumps(
                {
                    "word_embedding_dimension": dim,
                    "pooling_mode_cls_token": self.pooling == "cls",
                    "pooling_mode_mean_tokens": self.pooling == "mean",
                    "pooling_mode_max_tokens": False,
                    "pooling_mode_mean_sqrt_len_tokens": False,
                },
                indent=2,
            )
        )
        (directory / "2_Normalize").mkdir(exist_ok=True)
        (directory / "2_Normalize" / ".keep").write_text("")

    def manifest(self) -> dict[str, Any]:
        from ..models import describe_model

        return {
            **describe_model(self.resolved),
            "template_revision": self.resolved.template_revision,
            "adapter": {"kind": "encoder_full"},
            "pooling": self.pooling,
            "normalize": True,
            "dimensions": int(self.model.config.hidden_size),
            "loss": {"kind": "infonce", "temp": self.temp},
            "versions": tc.library_versions(),
            "deployable": True,
        }

    def final_report(self) -> dict[str, Any]:
        metrics = self._retrieval() if self.held_out else None
        report: dict[str, Any] = {f"recall_at_{k}": None for k in RECALL_KS}
        report.update({"mrr": None})
        if metrics:
            report.update({k: v for k, v in metrics.items() if k != "corpus_size"})
            report["corpus_size"] = metrics["corpus_size"]
        report.update(
            {
                "baseline": self.baseline,
                "temp": self.temp,
                "pooling": self.pooling,
                "train_pairs": len(self.train),
                "eval_pairs": len(self.held_out),
                "dropped_records": self.dropped,
                "warnings": [] if metrics else ["No held-out pairs: retrieval metrics are null."],
            }
        )
        return report


class EmbeddingRunner(RecipeRunner):
    kind = "embedding"

    def build_task(self, spec, train, held_out, workdir, base):  # type: ignore[no-untyped-def]
        return EmbeddingTask(spec, train, held_out, workdir)
