"""Model router: predict each candidate model's quality on a prompt, then route to the cheapest
candidate that is predicted to succeed.

Training data are recorded per-model scores in ``[0, 1]``, in either shape:

- one record per (prompt, model) response: ``metadata.model`` names the model and
  ``scores[rubric]`` (or the record's only score) is its quality; records for the same prompt
  are joined by ``group_id`` or, without one, by the exact prompt;
- one record per prompt with ``scores`` keyed by candidate model id.

Records without scores are an error: the trainer never invents labels. Replaying prompts
against other models or judging them needs the inference service, which the trainer
doesn't have.

The router is a LoRA'd backbone (``qwen/qwen3-0.6b`` by default) with a linear head giving one
success logit per candidate, trained with masked BCE on the observed scores. The held-out
split is divided into two folds by group: the *selection* fold picks the best checkpoint,
fits a temperature and picks the routing threshold; the *report* fold, never used for any
choice, gives ``pareto_summary`` (quality drop with a 95% bootstrap CI, offload rate, cost
savings, ECE).
"""

from __future__ import annotations

import json
import math
from pathlib import Path
from typing import Any

import torch
import torch.nn.functional as F

from ..backends.torch_common import chunk_by_tokens
from ..config import TrainSpec
from ..errors import RecipeConfigError, RecipeDataError
from ..artifact_formats import FORMAT_VERSIONS
from ..metrics import binary_nll, bootstrap_ci, expected_calibration_error, fit_temperature, sigmoid
from ..splits import two_folds
from ..trainer import EvalResult
from .base import RecipeRunner
from .classifier import PooledLMTask
from .data import prompt_key, prompt_messages, record_id, with_prompt_groups

NEVER = math.inf


def _rubric(params: dict[str, Any]) -> str | None:
    rubric = params.get("rubric")
    if rubric is None or isinstance(rubric, str):
        return rubric
    raise RecipeConfigError(
        "RouterRecipe rubric must name a score already on your records. Judges, rubrics and "
        "replaying prompts against other models need the inference service; score the dataset "
        "first (dataset.score(judge)) and pass the score name."
    )


def collect_groups(
    records: list[dict[str, Any]], candidates: list[str] | None, rubric: str | None
) -> tuple[list[dict[str, Any]], list[str], int]:
    """Join observations into prompt groups: {key, prompt, scores{model: q}, costs{model: usd}}."""
    groups: dict[str, dict[str, Any]] = {}
    unscored = 0
    wanted = set(candidates) if candidates else None
    for index, rec in enumerate(records):
        prompt = prompt_messages(rec)
        if not prompt:
            unscored += 1
            continue
        scores = rec.get("scores") or {}
        metadata = rec.get("metadata") or {}
        model = metadata.get("model")
        observed: dict[str, float] = {}
        if model:
            if rubric is not None:
                value = scores.get(rubric)
            elif len(scores) == 1:
                value = next(iter(scores.values()))
            elif scores:
                raise RecipeConfigError(
                    f"Record '{record_id(rec, index)}' has several scores {sorted(scores)}; pass rubric=<score name>."
                )
            else:
                value = None
            if value is not None:
                observed[str(model).strip().lower()] = value
        else:
            observed = {str(k).strip().lower(): v for k, v in scores.items()}
        if wanted is not None:
            observed = {m: v for m, v in observed.items() if m in wanted}
        if not observed:
            unscored += 1
            continue
        group = groups.setdefault(prompt_key(rec), {"key": prompt_key(rec), "prompt": prompt, "obs": {}, "cost": {}})
        for m, v in observed.items():
            if isinstance(v, bool) or not isinstance(v, (int, float)) or not 0.0 <= v <= 1.0:
                raise RecipeDataError(
                    f"Record '{record_id(rec, index)}': router scores must be numbers in [0, 1], got {v!r} for {m}."
                )
            group["obs"].setdefault(m, []).append(float(v))
        cost = (rec.get("metrics") or {}).get("cost_usd")
        if model and isinstance(cost, (int, float)):
            group["cost"].setdefault(str(model).strip().lower(), []).append(float(cost))

    out = []
    for group in groups.values():
        out.append(
            {
                "key": group["key"],
                "prompt": group["prompt"],
                "scores": {m: sum(v) / len(v) for m, v in group["obs"].items()},
                "costs": {m: sum(v) / len(v) for m, v in group["cost"].items()},
            }
        )
    seen = sorted({m for g in out for m in g["scores"]})
    return out, (list(candidates) if candidates else seen), unscored


def route(probs: dict[str, float], order: list[str], fallback: str, threshold: float) -> str:
    for model in order:
        if probs[model] >= threshold:
            return model
    return fallback


def evaluate_policy(
    rows: list[tuple[dict[str, float], dict[str, float]]],
    order: list[str],
    fallback: str,
    threshold: float,
    costs: dict[str, float] | None,
) -> dict[str, Any]:
    """Routing metrics on complete rows of (calibrated probs, observed scores)."""
    deltas, routed_q, fallback_q, offloaded, routed_cost = [], [], [], 0, 0.0
    for probs, scores in rows:
        chosen = route(probs, order, fallback, threshold)
        routed_q.append(scores[chosen])
        fallback_q.append(scores[fallback])
        deltas.append(scores[fallback] - scores[chosen])
        offloaded += int(chosen != fallback)
        if costs:
            routed_cost += costs[chosen]
    n = len(rows)
    savings = None
    if costs and costs[fallback] > 0:
        savings = 1.0 - (routed_cost / n) / costs[fallback]
    return {
        "routed_quality": sum(routed_q) / n,
        "fallback_quality": sum(fallback_q) / n,
        "quality_drop": sum(deltas) / n,
        "offload_rate": offloaded / n,
        "cost_savings_pct": savings,
        "deltas": deltas,
    }


def choose_threshold(
    rows: list[tuple[dict[str, float], dict[str, float]]],
    order: list[str],
    fallback: str,
    max_quality_drop: float,
    costs: dict[str, float] | None,
) -> float:
    """Most savings (or offload, without prices) with quality drop <= target; ties -> higher."""
    if not rows:
        return NEVER
    candidates = sorted({p[m] for p, _ in rows for m in order} | {NEVER}, reverse=True)
    best, best_value = NEVER, 0.0
    for threshold in candidates:
        result = evaluate_policy(rows, order, fallback, threshold, costs)
        if result["quality_drop"] > max_quality_drop + 1e-12:
            continue
        value = result["cost_savings_pct"] if costs else result["offload_rate"]
        if value is not None and value > best_value + 1e-12:
            best, best_value = threshold, value
    return best


class RouterTask(PooledLMTask):
    kind = "router"
    artifact_format = "router_bundle"
    metric_name = "eval_loss"
    metric_mode = "min"
    head_file = "router_head.safetensors"

    def __init__(self, spec: TrainSpec, train: list[dict[str, Any]], held_out: list[dict[str, Any]], workdir: Path) -> None:
        params = spec.params
        rubric = _rubric(params)
        given = [str(m).strip().lower() for m in params.get("models") or []] or None
        train_groups, candidates, unscored_train = collect_groups(train, given, rubric)
        eval_groups, _, unscored_eval = collect_groups(held_out, candidates, rubric)
        if not train_groups:
            raise RecipeDataError(
                "RouterRecipe needs recorded per-model scores (scores keyed by model id, or "
                "metadata.model + a score per response); none of the training records have any."
            )
        if len(candidates) < 2:
            raise RecipeDataError(
                f"RouterRecipe needs scores for at least two candidate models; found {candidates}. "
                "Replaying prompts against other models is not available in the trainer."
            )
        super().__init__(spec, workdir)
        self.candidates = candidates
        self.unscored = unscored_train + unscored_eval
        if self.unscored:
            self.warnings.append(f"{self.unscored} records had no usable scores and were skipped.")
        self.max_quality_drop = float(params.get("max_quality_drop", 0.02))
        self.costs = self._costs(params.get("pricing"), train_groups + eval_groups)
        self.fallback = self._fallback(params.get("fallback"), train_groups)
        others = [m for m in candidates if m != self.fallback]
        self.order = sorted(others, key=lambda m: self.costs[m]) if self.costs else others

        self.train = [self._encode(g) for g in train_groups]
        keys = [g["key"] for g in eval_groups]
        select, report = two_folds([self._encode(g) for g in eval_groups], keys, spec.split.seed)
        self.select_fold, self.report_fold = select, report
        self.build_backbone(torch.nn.Linear(self.hidden_size, len(candidates)))
        self.calibration: dict[str, Any] = {"threshold": None, "temperature": 1.0, "calibrated": False}

    def _costs(self, pricing: Any, groups: list[dict[str, Any]]) -> dict[str, float] | None:
        costs: dict[str, float] = {}
        if isinstance(pricing, dict):
            costs = {str(k).strip().lower(): float(v) for k, v in pricing.items()}
        for model in self.candidates:
            if model not in costs:
                seen = [g["costs"][model] for g in groups if model in g["costs"]]
                if seen:
                    costs[model] = sum(seen) / len(seen)
        if all(m in costs for m in self.candidates):
            return {m: costs[m] for m in self.candidates}
        self.warnings.append(
            "No price for every candidate (pass pricing= or log metrics.cost_usd): cost_savings_pct is null "
            "and the threshold maximizes offload rate."
        )
        return None

    def _fallback(self, requested: Any, groups: list[dict[str, Any]]) -> str:
        if requested:
            name = str(requested).strip().lower()
            if name not in self.candidates:
                raise RecipeConfigError(f"fallback '{name}' is not one of the candidates {self.candidates}.")
            return name

        def mean_quality(m: str) -> float:
            seen = [g["scores"][m] for g in groups if m in g["scores"]]
            return sum(seen) / len(seen) if seen else -1.0

        return max(self.candidates, key=lambda m: (mean_quality(m), m))

    def _encode(self, group: dict[str, Any]) -> dict[str, Any]:
        ids = self.encode_prompt(group["prompt"], group["key"], self.max_len)
        target = torch.tensor([group["scores"].get(m, 0.0) for m in self.candidates])
        observed = torch.tensor([m in group["scores"] for m in self.candidates])
        return {"ids": ids, "target": target, "observed": observed, "scores": group["scores"]}

    def num_train_items(self) -> int:
        return len(self.train)

    def item_tokens(self, index: int) -> int:
        return len(self.train[index]["ids"])

    def _batch_loss(self, items: list[dict[str, Any]], n: int, *, grad: bool) -> tuple[torch.Tensor, torch.Tensor]:
        logits = self.heads(self.pooled([it["ids"] for it in items], grad=grad))
        target = torch.stack([it["target"] for it in items]).to(self.device)
        observed = torch.stack([it["observed"] for it in items]).to(self.device).float()
        per = F.binary_cross_entropy_with_logits(logits, target, reduction="none") * observed
        per_group = per.sum(1) / observed.sum(1).clamp(min=1)
        return per_group.sum() / n, logits

    def accumulate(self, indices: list[int]) -> dict[str, float]:
        lengths = [len(it["ids"]) for it in self.train]
        total = 0.0
        for chunk in chunk_by_tokens(indices, lengths, self.micro_batch_tokens):
            loss, _ = self._batch_loss([self.train[i] for i in chunk], len(indices), grad=True)
            loss.backward()
            total += float(loss.detach())
        return {"loss": total}

    def _logits(self, items: list[dict[str, Any]]) -> list[list[float]]:
        out: list[list[float]] = []
        with torch.no_grad():
            for start in range(0, len(items), 32):
                part = items[start : start + 32]
                out.extend(self.heads(self.pooled([it["ids"] for it in part], grad=False)).cpu().tolist())
        return out

    def _fold_loss(self, items: list[dict[str, Any]]) -> float:
        with torch.no_grad():
            total = 0.0
            for start in range(0, len(items), 32):
                loss, _ = self._batch_loss(items[start : start + 32], len(items), grad=False)
                total += float(loss)
        return total

    def evaluate(self) -> EvalResult | None:
        if not self.select_fold:
            return None
        return EvalResult(score=self._fold_loss(self.select_fold), metrics={})

    def _calibrated_rows(self, items: list[dict[str, Any]], temperature: float) -> list[tuple[dict[str, float], dict[str, float]]]:
        rows = []
        for logits, item in zip(self._logits(items), items):
            probs = {m: sigmoid(z / temperature) for m, z in zip(self.candidates, logits)}
            rows.append((probs, item["scores"]))
        return rows

    def final_report(self) -> dict[str, Any]:
        warnings: list[str] = []
        temperature = 1.0
        if self.select_fold:
            pairs = [
                (z, item["scores"][m])
                for logits, item in zip(self._logits(self.select_fold), self.select_fold)
                for m, z in zip(self.candidates, logits)
                if m in item["scores"]
            ]
            temperature = fit_temperature(lambda t: binary_nll([p[0] for p in pairs], [p[1] for p in pairs], t))
        complete = lambda rows: [r for r in rows if all(m in r[1] for m in self.candidates)]  # noqa: E731
        select_rows = complete(self._calibrated_rows(self.select_fold, temperature))
        threshold = choose_threshold(select_rows, self.order, self.fallback, self.max_quality_drop, self.costs)
        if not select_rows:
            warnings.append("No held-out prompts with scores for every candidate: the router never offloads.")
        self.calibration = {
            "threshold": None if threshold == NEVER else threshold,
            "temperature": temperature,
            "calibrated": bool(self.select_fold),
        }

        report_rows_all = self._calibrated_rows(self.report_fold, temperature)
        report_rows = complete(report_rows_all)
        summary: dict[str, Any] = {
            "target_max_drop": self.max_quality_drop,
            "routed_quality": None,
            "quality_drop": None,
            "quality_drop_ci95": None,
            "offload_rate": None,
            "cost_savings_pct": None,
            "ece": None,
            "threshold": self.calibration["threshold"],
            "temperature": temperature,
        }
        fallback_quality = None
        if report_rows:
            result = evaluate_policy(report_rows, self.order, self.fallback, threshold, self.costs)
            ci = bootstrap_ci(result.pop("deltas"), seed=self.spec.seed)
            fallback_quality = result.pop("fallback_quality")
            summary.update(result)
            summary["quality_drop_ci95"] = list(ci) if ci else None
            if summary["quality_drop"] > self.max_quality_drop + 1e-9:
                warnings.append(
                    f"On the {len(report_rows)} held-out report prompts the router loses {summary['quality_drop']:.3g} quality, "
                    f"more than max_quality_drop={self.max_quality_drop:g}: the threshold was chosen on {len(select_rows)} other "
                    "prompts and doesn't hold yet. Train on more scored prompts before relying on it."
                )
        else:
            warnings.append("The report fold has no prompts scored for every candidate: pareto_summary is null.")
        observed = [(p[m], s[m]) for p, s in report_rows_all for m in self.candidates if m in s]
        summary["ece"] = expected_calibration_error([o[0] for o in observed], [o[1] for o in observed])
        return {
            "eval_examples": len(report_rows),
            "selection_examples": len(self.select_fold),
            "candidates": self.candidates,
            "fallback_model": self.fallback,
            "fallback_quality": fallback_quality,
            "routes_any_traffic": threshold != NEVER,
            "eval_loss": self._fold_loss(self.report_fold) if self.report_fold else None,
            "pareto_summary": summary,
            "warnings": warnings,
        }

    def router_config(self) -> dict[str, Any]:
        return {
            "format": self.artifact_format,
            "format_version": FORMAT_VERSIONS[self.artifact_format],
            "candidates": self.candidates,
            "route_order": self.order,
            "fallback_model": self.fallback,
            "pricing": self.costs,
            "max_quality_drop": self.max_quality_drop,
            "rule": "route to the first model in route_order whose calibrated success probability "
            "sigmoid(logit / temperature) >= threshold, else fallback_model; threshold null = never offload",
            **self.calibration,
            **self.backbone_manifest(),
            "head_file": self.head_file,
        }

    def export(self, directory: Path, params: dict[str, Any] | None = None) -> None:
        self.export_backbone(directory, params)
        (directory / "router_config.json").write_text(json.dumps(self.router_config(), indent=2, sort_keys=True))

    def manifest(self) -> dict[str, Any]:
        return {**self.backbone_manifest(), "candidates": self.candidates, "fallback_model": self.fallback}


class RouterRunner(RecipeRunner):
    kind = "router"

    def split_strategy(self, spec: TrainSpec) -> str:
        return "by_group" if spec.split.strategy == "by_session" else spec.split.strategy

    def prepare_records(self, spec: TrainSpec, records: list[dict[str, Any]]) -> list[dict[str, Any]]:
        # Responses to the same prompt from different models must land on the same side.
        return with_prompt_groups(records)

    def build_task(self, spec, train, held_out, workdir, base):  # type: ignore[no-untyped-def]
        return RouterTask(spec, train, held_out, workdir)
