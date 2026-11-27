"""Decision model: one head per question on a shared LLM backbone (LoRA or frozen).

Records carry ``state`` (text or JSON; a chat ``messages`` transcript also works),
``questions`` (``{name: {type: choice|noul|score, criteria}}``) and ``expected_output``
(``{name: answer}``). Only ``state``/``messages`` reach the model, so labels can't leak.

Losses by question type: cross-entropy (``choice``), BCE with logits (``noul``) and ordinal
BCE over ``K-1`` cumulative thresholds sharing one score (``score``, CORAL-style), so
confusing the extremes costs more than confusing neighbours. Temperatures are fitted per head
on the selection fold of the held-out split; metrics (per-option precision/recall/F1,
confusion matrices, binned ECE) come from the separate report fold, and are null with a
warning when it is empty.
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F

from ..config import TrainSpec
from ..errors import RecipeDataError
from ..artifact_formats import FORMAT_VERSIONS
from ..metrics import expected_calibration_error, fit_temperature, per_class_report, sigmoid, softmax
from ..backends.torch_common import chunk_by_tokens
from ..splits import two_folds
from ..trainer import EvalResult
from .base import RecipeRunner
from .classifier import PooledLMTask
from .data import record_id


def parse_questions(records: list[dict[str, Any]]) -> dict[str, dict[str, Any]]:
    """Union of question schemas across records; conflicting definitions are an error."""
    questions: dict[str, dict[str, Any]] = {}
    for index, rec in enumerate(records):
        for name, raw in (rec.get("questions") or {}).items():
            if not name or "." in name:
                raise RecipeDataError(f"Question name {name!r} must be non-empty and contain no '.'.")
            if not isinstance(raw, dict):
                raise RecipeDataError(f"Record '{record_id(rec, index)}': question '{name}' must be an object.")
            kind = str(raw.get("type", raw.get("kind", ""))).lower()
            criteria = raw.get("criteria")
            if kind == "choice":
                options = list(criteria) if isinstance(criteria, (dict, list)) else []
                if len(options) < 2:
                    raise RecipeDataError(f"Choice question '{name}' needs at least two criteria.")
            elif kind == "score":
                options = [str(c) for c in criteria] if isinstance(criteria, list) else []
                if len(options) < 2:
                    raise RecipeDataError(f"Score question '{name}' needs an ordered list of at least two criteria.")
            elif kind == "noul":
                options = []
            else:
                raise RecipeDataError(f"Question '{name}' has unknown type '{kind}' (choice, noul or score).")
            spec = {"type": kind, "options": [str(o) for o in options]}
            if questions.setdefault(name, spec) != spec:
                raise RecipeDataError(f"Question '{name}' is defined differently across records.")
    if not questions:
        raise RecipeDataError("DecisionModelRecipe needs records with 'questions'.")
    return questions


def encode_answer(question: dict[str, Any], answer: Any, name: str) -> float | int | None:
    if answer is None:
        return None
    kind = question["type"]
    if kind == "noul":
        if isinstance(answer, bool):
            return float(answer)
        if isinstance(answer, (int, float)) and 0.0 <= float(answer) <= 1.0:
            return float(answer)
        raise RecipeDataError(f"Answer for noul question '{name}' must be in [0, 1], got {answer!r}.")
    options = question["options"]
    if kind == "score" and isinstance(answer, int) and not isinstance(answer, bool) and 0 <= answer < len(options):
        return answer
    if str(answer) in options:
        return options.index(str(answer))
    raise RecipeDataError(f"Answer {answer!r} for question '{name}' is not one of {options}.")


def state_text(rec: dict[str, Any], index: int) -> list[dict[str, Any]]:
    state = rec.get("state")
    if state is not None:
        text = state if isinstance(state, str) else json.dumps(state, sort_keys=True, ensure_ascii=False)
        return [{"role": "user", "content": text}]
    if isinstance(rec.get("messages"), list) and rec["messages"]:
        return [dict(m) for m in rec["messages"]]
    raise RecipeDataError(f"Record '{record_id(rec, index)}' has no 'state' or 'messages' for the decision model.")


class OrdinalHead(torch.nn.Module):
    def __init__(self, hidden: int, levels: int) -> None:
        super().__init__()
        self.score = torch.nn.Linear(hidden, 1, bias=False)
        self.thresholds = torch.nn.Parameter(torch.linspace(1.0, -1.0, levels - 1))

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.score(x) + self.thresholds  # logits of P(y > k), k = 0..K-2


def ordinal_probs(logits: list[float], temperature: float) -> list[float]:
    above = [sigmoid(z / temperature) for z in logits]
    cumulative = [1.0] + above + [0.0]
    probs = [max(0.0, cumulative[k] - cumulative[k + 1]) for k in range(len(above) + 1)]
    total = sum(probs) or 1.0
    return [p / total for p in probs]


class DecisionTask(PooledLMTask):
    kind = "decision"
    artifact_format = "decision_bundle"
    metric_name = "eval_loss"
    metric_mode = "min"
    head_file = "decision_head.safetensors"

    def __init__(self, spec: TrainSpec, train: list[dict[str, Any]], held_out: list[dict[str, Any]], workdir: Path) -> None:
        self.questions = parse_questions(train + held_out)
        super().__init__(spec, workdir)
        self.skipped = 0
        self.train = self._encode_all(train)
        if not self.train:
            raise RecipeDataError("DecisionModelRecipe needs training records with expected_output answers.")
        held = self._encode_all(held_out)
        self.select_fold, self.report_fold = two_folds(held, [h["key"] for h in held], spec.split.seed)
        if self.skipped:
            self.warnings.append(f"{self.skipped} records had no answers for any question and were skipped.")
        heads = torch.nn.ModuleDict()
        for name, q in self.questions.items():
            if q["type"] == "choice":
                heads[name] = torch.nn.Linear(self.hidden_size, len(q["options"]))
            elif q["type"] == "noul":
                heads[name] = torch.nn.Linear(self.hidden_size, 1)
            else:
                heads[name] = OrdinalHead(self.hidden_size, len(q["options"]))
        self.build_backbone(heads)
        self.temperatures = {name: 1.0 for name in self.questions}
        self.calibrated = False

    def _encode_all(self, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        out = []
        for index, rec in enumerate(records):
            expected = rec.get("expected_output") or {}
            if not isinstance(expected, dict):
                raise RecipeDataError(f"Record '{record_id(rec, index)}': expected_output must map question -> answer.")
            answers = {
                name: encode_answer(q, expected.get(name), name) for name, q in self.questions.items()
            }
            answers = {k: v for k, v in answers.items() if v is not None}
            if not answers:
                self.skipped += 1
                continue
            rid = record_id(rec, index)
            key = str(rec["session_id"]) if rec.get("session_id") is not None else rid
            out.append({"ids": self.encode_prompt(state_text(rec, index), rid, self.max_len), "answers": answers, "key": key})
        return out

    def num_train_items(self) -> int:
        return len(self.train)

    def item_tokens(self, index: int) -> int:
        return len(self.train[index]["ids"])

    def _head_loss(self, name: str, logits: torch.Tensor, answers: list[Any]) -> torch.Tensor:
        q = self.questions[name]
        if q["type"] == "choice":
            return F.cross_entropy(logits, torch.tensor(answers, device=self.device), reduction="none")
        if q["type"] == "noul":
            return F.binary_cross_entropy_with_logits(
                logits[:, 0], torch.tensor(answers, dtype=torch.float32, device=self.device), reduction="none"
            )
        levels = torch.arange(logits.shape[1], device=self.device)[None]
        targets = (torch.tensor(answers, device=self.device)[:, None] > levels).float()
        return F.binary_cross_entropy_with_logits(logits, targets, reduction="none").mean(1)

    def _loss(self, items: list[dict[str, Any]], n: int, *, grad: bool) -> torch.Tensor:
        features = self.pooled([it["ids"] for it in items], grad=grad)
        total = torch.zeros((), device=self.device)
        for name, head in self.heads.items():
            rows = [i for i, it in enumerate(items) if name in it["answers"]]
            if not rows:
                continue
            logits = head(features[rows])
            total = total + self._head_loss(name, logits, [items[i]["answers"][name] for i in rows]).sum()
        return total / n

    def accumulate(self, indices: list[int]) -> dict[str, float]:
        lengths = [len(it["ids"]) for it in self.train]
        total = 0.0
        for chunk in chunk_by_tokens(indices, lengths, self.micro_batch_tokens):
            loss = self._loss([self.train[i] for i in chunk], len(indices), grad=True)
            loss.backward()
            total += float(loss.detach())
        return {"loss": total}

    def _fold_loss(self, items: list[dict[str, Any]]) -> float:
        with torch.no_grad():
            return sum(float(self._loss(items[s : s + 32], len(items), grad=False)) for s in range(0, len(items), 32))

    def evaluate(self) -> EvalResult | None:
        if not self.select_fold:
            return None
        return EvalResult(score=self._fold_loss(self.select_fold), metrics={})

    def _head_logits(self, items: list[dict[str, Any]]) -> dict[str, list[list[float]]]:
        out: dict[str, list[list[float]]] = {name: [] for name in self.questions}
        with torch.no_grad():
            for start in range(0, len(items), 32):
                features = self.pooled([it["ids"] for it in items[start : start + 32]], grad=False)
                for name, head in self.heads.items():
                    out[name].extend(head(features).cpu().tolist())
        return out

    def _probs(self, name: str, logits: list[float], temperature: float) -> list[float]:
        kind = self.questions[name]["type"]
        if kind == "choice":
            return softmax(logits, temperature)
        if kind == "noul":
            return [sigmoid(logits[0] / temperature)]
        return ordinal_probs(logits, temperature)

    def _fit_temperatures(self) -> None:
        logits = self._head_logits(self.select_fold)
        for name in self.questions:
            rows = [(z, it["answers"][name]) for z, it in zip(logits[name], self.select_fold) if name in it["answers"]]
            if not rows:
                continue

            def nll(t: float, name: str = name, rows: list[Any] = rows) -> float:
                total = 0.0
                for z, y in rows:
                    probs = self._probs(name, z, t)
                    if self.questions[name]["type"] == "noul":
                        p = min(1 - 1e-7, max(1e-7, probs[0]))
                        total -= y * math.log(p) + (1 - y) * math.log(1 - p)
                    else:
                        total -= math.log(max(probs[int(y)], 1e-12))
                return total / len(rows)

            self.temperatures[name] = fit_temperature(nll)

    def _head_report(self, name: str, logits: list[list[float]]) -> dict[str, Any] | None:
        q = self.questions[name]
        rows = [(z, it["answers"][name]) for z, it in zip(logits, self.report_fold) if name in it["answers"]]
        if not rows:
            return None
        t = self.temperatures[name]
        if q["type"] == "noul":
            probs = [self._probs(name, z, t)[0] for z, _ in rows]
            labels = [float(y) for _, y in rows]
            return {
                "type": "noul",
                "examples": len(rows),
                "accuracy": sum((p >= 0.5) == (y >= 0.5) for p, y in zip(probs, labels)) / len(rows),
                "brier": sum((p - y) ** 2 for p, y in zip(probs, labels)) / len(rows),
                "ece": expected_calibration_error(probs, labels),
                "temperature": t,
            }
        options = q["options"]
        dists = [self._probs(name, z, t) for z, _ in rows]
        preds = [max(range(len(d)), key=d.__getitem__) for d in dists]
        truth = [int(y) for _, y in rows]
        report = per_class_report([options[y] for y in truth], [options[p] for p in preds], options)
        report.update(
            {
                "type": q["type"],
                "examples": len(rows),
                "ece": expected_calibration_error(
                    [max(d) for d in dists], [float(p == y) for p, y in zip(preds, truth)]
                ),
                "temperature": t,
            }
        )
        if q["type"] == "score":
            report["mae"] = sum(abs(p - y) for p, y in zip(preds, truth)) / len(rows)
        return report

    def final_report(self) -> dict[str, Any]:
        warnings: list[str] = []
        if self.select_fold:
            self._fit_temperatures()
            self.calibrated = True
        else:
            warnings.append("No held-out selection fold: temperatures were not calibrated (1.0).")
        heads: dict[str, Any] = {}
        if self.report_fold:
            logits = self._head_logits(self.report_fold)
            heads = {name: self._head_report(name, logits[name]) for name in self.questions}
        else:
            warnings.append("The held-out report fold is empty: decision metrics are null.")
        eces = [h["ece"] for h in heads.values() if h and h.get("ece") is not None]
        return {
            "eval_examples": len(self.report_fold),
            "selection_examples": len(self.select_fold),
            "eval_loss": self._fold_loss(self.report_fold) if self.report_fold else None,
            "ece": sum(eces) / len(eces) if eces else None,
            "heads": heads or {name: None for name in self.questions},
            "warnings": warnings,
        }

    def decision_config(self) -> dict[str, Any]:
        return {
            "format": self.artifact_format,
            "format_version": FORMAT_VERSIONS[self.artifact_format],
            "questions": self.questions,
            "temperatures": self.temperatures,
            "calibrated": self.calibrated,
            "losses": {
                name: {"choice": "cross_entropy", "noul": "bce_with_logits", "score": "ordinal_bce"}[q["type"]]
                for name, q in self.questions.items()
            },
            "input_format": "state as text (JSON objects with sorted keys) in one user message",
            **self.backbone_manifest(),
            "head_file": self.head_file,
        }

    def export(self, directory: Path, params: dict[str, Any] | None = None) -> None:
        self.export_backbone(directory, params)
        (directory / "decision_config.json").write_text(json.dumps(self.decision_config(), indent=2, sort_keys=True))

    def manifest(self) -> dict[str, Any]:
        return {**self.backbone_manifest(), "questions": self.questions}


class DecisionRunner(RecipeRunner):
    kind = "decision"

    def build_task(self, spec, train, held_out, workdir, base):  # type: ignore[no-untyped-def]
        return DecisionTask(spec, train, held_out, workdir)
