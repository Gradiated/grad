"""Human-readable renderings: run plans, eval plans, eval summaries, render previews and usage."""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from typing import Any


def _num(value: Any) -> str:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return str(value)
    if isinstance(value, int):
        return f"{value:,}"
    if value != 0 and (abs(value) < 1e-3 or abs(value) >= 1e6):
        return f"{value:.2e}"
    return f"{value:g}"


def _tokens(n: Any) -> str:
    if not isinstance(n, (int, float)):
        return str(n)
    if n >= 1_000_000:
        return f"{n / 1_000_000:.1f}M"
    if n >= 10_000:
        return f"{n / 1_000:.0f}k"
    return f"{int(n):,}"


def _usd(value: Any) -> str:
    if not isinstance(value, (int, float)):
        return "—"
    return f"${value:,.2f}" if value >= 0.01 or value == 0 else f"${value:.4f}"


def _duration(seconds: Any) -> str:
    if not isinstance(seconds, (int, float)):
        return "—"
    if seconds < 90:
        return f"{seconds:.0f}s"
    if seconds < 90 * 60:
        return f"{seconds / 60:.0f} min"
    return f"{seconds / 3600:.1f} h"


def _adapter(adapter: Mapping[str, Any] | None) -> str:
    if not adapter:
        return "—"
    kind = adapter.get("kind")
    if kind == "lora":
        text = f"LoRA(rank={adapter.get('rank', 32)}, alpha={adapter.get('alpha', 32)})"
        return text + " · merge_on_export" if adapter.get("merge_on_export") else text
    if kind == "prefix_kv":
        return f"PrefixKV(num_tokens={adapter.get('num_tokens', 256)})"
    if kind == "encoder_full":
        return "full encoder"
    return str(kind)


def format_plan(plan: Any, max_cost_usd: float | None = None) -> str:
    """The ``runs.plan(...)`` readout: resolved defaults, split, estimate and warnings."""
    cfg: Mapping[str, Any] = plan.resolved_config or {}
    split: Mapping[str, Any] = cfg.get("split") or {}
    strategy = {"by_session": "BySession", "by_group": "ByGroup", "random": "Random"}.get(str(split.get("strategy")), str(split.get("strategy")))
    thinking = cfg.get("thinking")
    thinking_text = "on" if thinking is True else "off" if thinking is False else str(thinking)
    lines = [
        f"Dataset     {cfg.get('dataset')} v{plan.dataset_version} ({_num(plan.usable_records)} of {_num(plan.total_records)} records usable)",
        f"Split       {strategy}({split.get('eval_fraction')}, seed={split.get('seed')}): "
        f"{_num(split.get('train_records', 0))} train / {_num(split.get('eval_records', 0))} eval",
        f"Recipe      {cfg.get('recipe_kind')} · model {cfg.get('model')} · {_adapter(cfg.get('adapter'))}",
        f"Template    {cfg.get('template_revision')} (pinned) · thinking={thinking_text} · train_on={cfg.get('train_on')} "
        f"({plan.trained_token_fraction:.0%} of tokens trained)",
        f"Optimizer   AdamW(lr={_num(cfg.get('lr'))}, betas=(0.9, 0.95), grad_clip=1.0) · {cfg.get('lr_source')}",
        f"Schedule    {cfg.get('schedule')}, warmup {_num(cfg.get('warmup'))} · batch {cfg.get('batch_size')} · "
        f"{cfg.get('epochs')} epoch(s) -> {_num(plan.estimated_steps)} steps",
        f"Checkpoints every {cfg.get('checkpoint_every_steps')} steps · keep {cfg.get('select')} · ttl {cfg.get('checkpoint_ttl_days')}d",
    ]
    params = cfg.get("recipe_params") or {}
    shown = {k: v for k, v in params.items() if k not in ("context_text",)}
    if "context_text" in params:
        shown["context_text"] = f"<{len(str(params['context_text'])):,} chars>"
    if shown:
        lines.append("Params      " + ", ".join(f"{k}={v}" for k, v in shown.items()))
    estimate = f"Estimate    ~{_tokens(plan.estimated_tokens)} tokens (~{_usd(plan.estimated_cost_usd)} at {_usd(plan.price_per_million_tokens)}/M)"
    if max_cost_usd is not None:
        estimate += f" · cap max_cost_usd={_num(max_cost_usd)}"
    lines.append(estimate)
    parts = getattr(plan, "cost_breakdown", None)
    if parts:
        lines.append(
            f"Breakdown   train ~{_usd(parts.get('train_usd', 0))} · teacher ~{_usd(parts.get('teacher_usd', 0))} · "
            f"evals ~{_usd(parts.get('eval_usd', 0))} (held-out evals during training aren't billed)"
        )
    gpu = getattr(plan, "min_gpu_memory_gb", None)
    lines.append(
        f"Duration    ~{_duration(getattr(plan, 'estimated_duration_s', None))} on one GPU"
        + (f" · needs {_num(gpu)} GB of GPU memory" if gpu is not None else "")
    )
    teacher = getattr(plan, "teacher", None)
    if teacher:
        lines.append(
            f"Teacher     {teacher.get('model')}: ~{_tokens(teacher.get('estimated_tokens', 0))} tokens, "
            f"~{_usd(teacher.get('estimated_cost_usd', 0))} at {_usd(teacher.get('price_per_million_tokens', 0))}/M (included above)"
        )
    labeling = getattr(plan, "labeling", None)
    if labeling:
        lines.append(
            f"Labeling    {_num(labeling.get('estimated_model_calls', 0))} model · {_num(labeling.get('estimated_judge_calls', 0))} judge calls, "
            f"~{_usd(labeling.get('estimated_cost_usd', 0))} (billed as an eval, included above)"
        )
    lines.append(f"Warnings    {len(plan.warnings)}")
    lines.extend(f"  ! {w}" for w in plan.warnings)
    return "\n".join(lines)


def format_eval_plan(plan: Any) -> str:
    """The ``evals.plan(...)`` readout."""
    lines = [
        f"Tasks       {_num(plan.estimated_tasks)} (dataset v{plan.dataset_version})",
        f"Calls       {_num(plan.estimated_model_calls)} model · {_num(plan.estimated_judge_calls)} judge",
        f"Judges      {', '.join(plan.judge_models) or 'none'}",
        f"Local       {', '.join(plan.local_scorers) or 'none'} (run in this process)",
        f"Pass        score >= {plan.pass_threshold}",
        f"Estimate    ~{_usd(plan.estimated_cost_usd)}",
        f"Warnings    {len(plan.warnings)}",
    ]
    lines.extend(f"  ! {w}" for w in plan.warnings)
    return "\n".join(lines)


def _pct(value: Any) -> str:
    return f"{value * 100:.1f}%" if isinstance(value, (int, float)) else "—"


def _table(headers: Sequence[str], rows: Sequence[Sequence[str]], right: set[int]) -> str:
    widths = [max(len(h), *(len(r[i]) for r in rows)) if rows else len(h) for i, h in enumerate(headers)]

    def line(cells: Sequence[str]) -> str:
        return "  ".join(c.rjust(widths[i]) if i in right else c.ljust(widths[i]) for i, c in enumerate(cells)).rstrip()

    return "\n".join([line(headers), *(line(r) for r in rows)])


def format_eval_summary(ev: Any) -> str:
    """The side-by-side eval summary table."""
    summary = list(ev.summary or [])

    def k_of(key: str) -> int | None:
        digits = "".join(ch for ch in str(key).rsplit("@", 1)[-1] if ch.isdigit())
        return int(digits) if digits else None

    def pass_at(s: Any, k: int) -> Any:
        for key, value in (s.pass_at_k or {}).items():
            if k_of(key) == k:
                return value
        return None

    ks = sorted({k for s in summary for key in (s.pass_at_k or {}) if (k := k_of(key)) is not None} or {1})
    headers = ["Model", "overall (95% CI)", *[f"pass@{k}" for k in ks], "vs baseline", "tokens/task", "cost/1k tasks", "errors"]
    rows = []
    for s in summary:
        vs = s.vs_baseline
        if vs:
            vs_text = f"{vs['delta'] * 100:+.1f} ({vs['ci_low'] * 100:+.1f}–{vs['ci_high'] * 100:+.1f})"
        else:
            vs_text = "—"
        rows.append(
            [
                s.model,
                f"{_pct(s.overall)} ({s.ci_low * 100:.1f}–{s.ci_high * 100:.1f})",
                *[_pct(pass_at(s, k)) for k in ks],
                vs_text,
                f"{s.tokens_per_task:,.0f}",
                _usd(s.cost_per_1k_tasks_usd),
                str(s.errors),
            ]
        )
    source = ev.task_source or {}
    head = (
        f"{ev.name} · {ev.status} · {len(summary)} model(s) · samples={ev.samples} · temperature={ev.temperature}"
        f" · {source.get('dataset', '?')} v{source.get('version', '?')}"
    )
    if not rows:
        return head + "\n(no summary yet: wait() for the eval to complete)"
    return head + "\n\n" + _table(headers, rows, right=set(range(1, len(headers))))


def format_render(preview: Any) -> str:
    """Token spans per record, trained spans in ``[[...]]``."""
    lines = [f"{preview.dataset} · {preview.model} · template {preview.template_revision} · token counts {preview.token_counts}"]
    for ex in preview.examples:
        lines.append("")
        lines.append(f"record {ex.get('record_id')}: {ex.get('trained_tokens')}/{ex.get('total_tokens')} tokens trained ({ex.get('trained_fraction', 0):.0%})")
        text = "".join(f"[[{span['text']}]]" if span.get("trained") else str(span.get("text", "")) for span in ex.get("spans", []))
        lines.append(text)
    return "\n".join(lines)


def _when(ts: Any) -> str:
    text = str(ts or "")
    return f"{text[:10]} {text[11:16]}" if len(text) >= 16 and text[10:11] == "T" else text or "—"


def format_usage_summary(summary: Any) -> str:
    """Totals, the kind breakdown, the top runs and evals, and the groups of a usage summary."""
    head = (
        f"Usage from {_when(summary.from_)} to {_when(summary.to)} UTC: {_usd(summary.cost_usd)}"
        f" · {_tokens(summary.tokens)} tokens · {summary.records:,} billed rows"
    )
    parts = [head]
    if summary.by_kind:
        rows = [[k.kind or "—", _usd(k.cost_usd), _tokens(k.tokens)] for k in summary.by_kind]
        parts.append(_table(["kind", "cost", "tokens"], rows, right={1, 2}))
    for title, refs in (("Top runs", summary.top_runs), ("Top evals", summary.top_evals)):
        if refs:
            rows = [[r.name or "—", r.id or "—", r.kind or "—", _usd(r.cost_usd), _tokens(r.tokens)] for r in refs]
            parts.append(f"{title}\n" + _table(["name", "id", "kind", "cost", "tokens"], rows, right={3, 4}))
    if summary.group_by:
        rows = [[g.key or "—", _usd(g.cost_usd), _tokens(g.tokens), f"{g.records:,}"] for g in summary.groups]
        parts.append(f"By {summary.group_by}\n" + _table([summary.group_by, "cost", "tokens", "rows"], rows, right={1, 2, 3}))
    if summary.records == 0:
        parts.append("(nothing billed in this period)")
    return "\n\n".join(parts)
