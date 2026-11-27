// Human-readable renderings, matching the Python and Go SDKs and the CLI.
import type { PlanRunResponse } from "./generated/models.js";

const int = (n: number): string => Math.round(n).toLocaleString("en-US");

const num = (v: number): string =>
  v !== 0 && (Math.abs(v) < 1e-3 || Math.abs(v) >= 1e6) ? v.toExponential(2) : String(Number(v.toPrecision(6)));

const tokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${(n / 1_000).toFixed(0)}k` : int(n);

const usd = (v: number): string =>
  v >= 0.01 || v === 0
    ? `$${v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${v.toFixed(4)}`;

const duration = (s: number): string =>
  s < 90 ? `${s.toFixed(0)}s` : s < 90 * 60 ? `${(s / 60).toFixed(0)} min` : `${(s / 3600).toFixed(1)} h`;

const adapter = (a: Record<string, unknown> | undefined): string => {
  switch (a?.kind) {
    case "lora":
      return `LoRA(rank=${a.rank ?? 32}, alpha=${a.alpha ?? 32})${a.mergeOnExport ? " · merge_on_export" : ""}`;
    case "prefix_kv":
      return `PrefixKV(num_tokens=${a.numTokens ?? 256})`;
    case "encoder_full":
      return "full encoder";
    default:
      return a ? String(a.kind) : "—";
  }
};

const params = (p: Record<string, unknown> | null | undefined): string =>
  Object.keys(p ?? {})
    .sort()
    .map((k) => {
      const v = p![k];
      if (k === "context_text" && typeof v === "string") return `${k}=<${int(v.length)} chars>`;
      if (typeof v === "string") return `${k}=${v}`;
      if (typeof v === "number") return `${k}=${num(v)}`;
      return `${k}=${JSON.stringify(v)}`;
    })
    .join(", ");

const STRATEGIES: Record<string, string> = { by_session: "BySession", by_group: "ByGroup", random: "Random" };

/** The `runs.plan(...)` readout: resolved defaults, split, estimate and warnings. */
export const formatPlan = (plan: PlanRunResponse): string => {
  const cfg = plan.resolvedConfig;
  const split = cfg.split;
  const lines = [
    `Dataset     ${cfg.dataset} v${plan.datasetVersion} (${int(plan.usableRecords)} of ${int(plan.totalRecords)} records usable)`,
    `Split       ${STRATEGIES[split.strategy] ?? split.strategy}(${split.evalFraction}, seed=${split.seed}): ${int(split.trainRecords)} train / ${int(split.evalRecords)} eval`,
    `Recipe      ${cfg.recipeKind} · model ${cfg.model} · ${adapter(cfg.adapter as Record<string, unknown> | undefined)}`,
    `Template    ${cfg.templateRevision} (pinned) · thinking=${cfg.thinking} · train_on=${cfg.trainOn} (${Math.round(plan.trainedTokenFraction * 100)}% of tokens trained)`,
    `Optimizer   AdamW(lr=${num(cfg.lr)}, betas=(0.9, 0.95), grad_clip=1.0) · ${cfg.lrSource}`,
    `Schedule    ${cfg.schedule}, warmup ${num(cfg.warmup)} · batch ${cfg.batchSize} · ${cfg.epochs} epoch(s) -> ${int(plan.estimatedSteps)} steps`,
    `Checkpoints every ${cfg.checkpointEverySteps} steps · keep ${cfg.select} · ttl ${cfg.checkpointTtlDays}d`,
  ];
  const shown = params(cfg.recipeParams as Record<string, unknown> | null | undefined);
  if (shown) lines.push(`Params      ${shown}`);
  lines.push(`Estimate    ~${tokens(plan.estimatedTokens)} tokens (~${usd(plan.estimatedCostUsd)} at ${usd(plan.pricePerMillionTokens)}/M)`);
  const b = plan.costBreakdown;
  if (b) {
    lines.push(
      `Breakdown   train ~${usd(b.trainUsd)} · teacher ~${usd(b.teacherUsd)} · evals ~${usd(b.evalUsd)} (held-out evals during training aren't billed)`,
    );
  }
  const gpu = plan.minGpuMemoryGb;
  lines.push(`Duration    ~${duration(plan.estimatedDurationS)} on one GPU${gpu != null ? ` · needs ${num(gpu)} GB of GPU memory` : ""}`);
  const t = plan.teacher;
  if (t) {
    lines.push(
      `Teacher     ${t.model}: ~${tokens(t.estimatedTokens)} tokens, ~${usd(t.estimatedCostUsd)} at ${usd(t.pricePerMillionTokens)}/M (included above)`,
    );
  }
  const l = plan.labeling;
  if (l) {
    lines.push(
      `Labeling    ${int(l.estimatedModelCalls)} model · ${int(l.estimatedJudgeCalls)} judge calls, ~${usd(l.estimatedCostUsd)} (billed as an eval, included above)`,
    );
  }
  lines.push(`Warnings    ${plan.warnings.length}`, ...plan.warnings.map((w) => `  ! ${w}`));
  return lines.join("\n");
};
