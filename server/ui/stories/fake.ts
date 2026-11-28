// A browser-side grad-server stand-in for stories: routes `METHOD /path` to
// wire JSON built from the component tests' fixtures (test/fixtures, captured
// from the harness), so stories render the same shapes the server sends.
import artifact from "../test/fixtures/artifact.json";
import checkpoints from "../test/fixtures/checkpoints.json";
import dataset from "../test/fixtures/dataset.json";
import records from "../test/fixtures/records.json";
import runFixture from "../test/fixtures/run.json";
import usage from "../test/fixtures/usage.json";
import usageSummary from "../test/fixtures/usage-summary.json";

type Wire = Record<string, unknown>;
export type Handler = (url: URL) => Response | Promise<Response>;
export type Routes = Record<string, Wire | Handler>;

export const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": status >= 400 ? "application/problem+json" : "application/json" } });

export const problem = (status: number, code: string, detail: string): Response => json({ type: `https://gradiated.com/problems/${code}`, title: code, status, detail, code, request_id: "req_story" }, status);

/** An event stream that sends `text` and stays open, like a live run. */
export const liveSse = (text: string): Response =>
  new Response(
    new ReadableStream({
      start: (c) => c.enqueue(new TextEncoder().encode(text)),
    }),
    { headers: { "content-type": "text/event-stream" } },
  );

export const never = (): Promise<Response> => new Promise(() => undefined);

export const fakeFetch = (routes: Routes): typeof fetch =>
  (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request ? input : new Request(String(input), init);
    const url = new URL(req.url);
    for (const [pattern, handler] of Object.entries(routes)) {
      const [method, path] = pattern.split(" ") as [string, string];
      if (method !== req.method || !new RegExp(`^${path.replace(/:[a-z_]+/g, "[^/]+")}$`).test(url.pathname)) continue;
      return typeof handler === "function" ? handler(url) : json(handler);
    }
    return problem(404, "route_not_found", `No route for ${req.method} ${url.pathname}`);
  }) as typeof fetch;

// ------------------------------------------------------------ synthetic runs

// Relative to now, so "5m ago" and phase clocks read the same whenever a story opens.
const NOW = Math.floor(Date.now() / 60_000) * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();

const rng = (seed: number) => () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};

export interface RunSpec {
  id: string;
  name: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled" | "stopped_budget";
  steps?: number;
  totalSteps?: number;
  recipe?: string;
  model?: string;
  dataset?: string;
  maxCost?: number | null;
  ageMin?: number;
  extra?: Wire;
}

const PRICE = 1.2;
const TOKENS_PER_STEP = 4096;

export const run = (spec: RunSpec): Wire => {
  const steps = spec.steps ?? 0;
  const created = NOW - (spec.ageMin ?? 30) * 60_000;
  const cost = (steps * TOKENS_PER_STEP * PRICE) / 1e6;
  const base = runFixture as Wire;
  return {
    ...base,
    id: spec.id,
    name: spec.name,
    status: spec.status,
    recipe_kind: spec.recipe ?? "sft",
    dataset_name: spec.dataset ?? "support-prod",
    dataset_version: 4,
    current_step: steps,
    total_steps: spec.totalSteps ?? 400,
    attempt: spec.status === "queued" ? 0 : 1,
    tokens_processed: steps * TOKENS_PER_STEP,
    cost_usd: Number(cost.toFixed(4)),
    max_cost_usd: spec.maxCost === undefined ? 10 : spec.maxCost,
    price_per_million_tokens: PRICE,
    created_at: iso(created),
    updated_at: iso(NOW - 20_000),
    finished_at: ["queued", "running"].includes(spec.status) ? null : iso(created + Math.max(steps, 1) * 2_500 + 60_000),
    error: null,
    artifact_id: spec.status === "completed" ? (base.artifact_id as string) : null,
    eval_report: spec.status === "completed" ? base.eval_report : null,
    latest_metric: null,
    resolved_config: { ...(base.resolved_config as Wire), model: spec.model ?? "qwen/qwen3-8b", name: spec.name, schedule: "cosine", checkpoint_every_steps: 50 },
    ...spec.extra,
  };
};

const sse = (event: string, data: unknown, id: number) => `event: ${event}\ndata: ${JSON.stringify(data)}\nid: ${id}\n\n`;

/** The `/events` stream of a run: phases, attempts, metrics every step, checkpoints every 50. */
export const runEvents = (r: Wire, opts: { steps: number; interruptAt?: number; resumeFrom?: number; final?: "completed" | "waiting" | "training" | "queued"; warning?: string }): string => {
  const random = rng(7);
  const out: string[] = [];
  let seq = 0;
  let t = Date.parse(String(r.created_at));
  const tick = (ms: number) => (t += ms);
  const emit = (event: string, data: Wire, attempt: number) => out.push(sse(event, { seq: ++seq, attempt, timestamp: iso(tick(1500)), ...data }, seq));
  const phase = (p: string, attempt: number, step: number, more: Wire = {}) => emit("phase", { phase: p, step, ...more }, attempt);
  const gpu = { name: "NVIDIA H100 80GB HBM3", memory_gb: 80 };

  phase("queued", 0, 0);
  if (opts.final === "queued") return out.join("");
  if (opts.final === "waiting") {
    phase("waiting_for_compute", 0, 0, { workers_online: 1, autoscaling: false, message: "Waiting for a GPU with ≥46 GB; online workers have 24 GB" });
    return out.join("");
  }
  const train = (attempt: number, from: number, to: number) => {
    emit("attempt", { event: "started", step: from, max_attempts: 10, message: `attempt ${attempt} started` }, attempt);
    phase("starting", attempt, from, { gpu });
    phase("loading_model", attempt, from, { gpu });
    phase("training", attempt, from, { gpu });
    if (opts.warning && attempt === 1) emit("warning", { step: from, message: opts.warning }, attempt);
    for (let step = from + 1; step <= to; step++) {
      const loss = 0.42 + 1.9 * Math.exp(-step / 90) + (random() - 0.5) * 0.08;
      const evalLoss = step % 25 === 0 ? 0.47 + 1.7 * Math.exp(-step / 100) : undefined;
      const metric = {
        step,
        epoch: Math.floor(step / 200),
        loss,
        lr: 2e-4 * (step < 20 ? step / 20 : 0.5 * (1 + Math.cos((Math.PI * (step - 20)) / 380))),
        tokens: step * TOKENS_PER_STEP,
        cost_usd: (step * TOKENS_PER_STEP * PRICE) / 1e6,
        tokens_per_sec: 21_000 + (random() - 0.5) * 6_000,
        grad_norm: 0.6,
        timestamp: iso(t),
        ...(evalLoss ? { eval_metrics: { eval_loss: evalLoss } } : {}),
      };
      emit("metric", { step, metric }, attempt);
      if (step % 50 === 0) emit("checkpoint", { step, checkpoint_id: `ckpt_${step}`, eval_score: evalLoss ?? null, format: "peft" }, attempt);
    }
  };
  const end = opts.interruptAt ?? opts.steps;
  train(1, 0, end);
  if (opts.interruptAt !== undefined) {
    const resume = opts.resumeFrom ?? 0;
    emit(
      "attempt",
      {
        event: "interrupted",
        reason: "preempted",
        step: opts.interruptAt,
        resume_step: resume,
        max_attempts: 10,
        message: `attempt 1 interrupted at step ${opts.interruptAt}: the GPU was reclaimed; resuming from step ${resume}`,
      },
      1,
    );
    phase("queued", 2, resume);
    train(2, resume, opts.steps);
  }
  if (opts.final === "completed") {
    phase("uploading", 1, opts.steps);
    phase("completing", 1, opts.steps);
    emit("completed", { run: r }, 1);
  } else if (!["queued", "running"].includes(String(r.status))) {
    // An ended run's stream closes with its final state, or the client would reconnect and replay it.
    emit("completed", { run: r }, 1);
  }
  return out.join("");
};

export const checkpointsFor = (r: Wire, steps: number): Wire => {
  const template = (checkpoints as { data: Wire[] }).data[0] as Wire;
  const data = Array.from({ length: Math.floor(steps / 50) }, (_, i) => {
    const step = (i + 1) * 50;
    return {
      ...template,
      id: `ckpt_${step}`,
      run_id: r.id,
      step,
      eval_score: 0.47 + 1.7 * Math.exp(-step / 100),
      format: "peft",
      size_bytes: 84_000_000,
      best: false,
      final: false,
      expires_at: iso(NOW + 29 * 86_400_000),
    };
  });
  const last = data[data.length - 1];
  if (last && r.status === "completed") Object.assign(last, { best: true, final: true, expires_at: null });
  return { data, next_cursor: null };
};

// ------------------------------------------------------------ workspace

export const RUNS = {
  finished: run({ id: "run_7f3a9c21d04e5b8a6c1e2f90", name: "support-sft", status: "completed", steps: 400, ageMin: 95 }),
  training: run({ id: "run_2b8e4d10a9c7f3e65d1b0a42", name: "support-sft-v2", status: "running", steps: 236, ageMin: 14, extra: { phase: "training", phase_since: iso(NOW - 9 * 60_000) } }),
  waiting: run({
    id: "run_9d1c7e3b5a2f8046e1c9b7d3",
    name: "support-sft-32b",
    status: "queued",
    model: "qwen/qwen3-32b",
    ageMin: 6,
    extra: { phase: "waiting_for_compute", phase_since: iso(NOW - 5 * 60_000), workers_online: 1, autoscaling: false, queue_position: 0, queue_message: "Waiting for a GPU with ≥46 GB; online workers have 24 GB" },
  }),
  interrupted: run({
    id: "run_4e6a2c8b1d9f7035b2e4c6a8",
    name: "router-distill",
    status: "running",
    recipe: "distill",
    steps: 288,
    ageMin: 41,
    extra: {
      attempt: 2,
      phase: "training",
      phase_since: iso(NOW - 6 * 60_000),
      last_interruption: { attempt: 1, reason: "preempted", step: 212, resume_step: 200, at: iso(NOW - 8 * 60_000), message: "the GPU was reclaimed" },
    },
  }),
  failed: run({
    id: "run_c3f5a7e9b1d2046886a4c2e0",
    name: "support-dpo",
    status: "failed",
    recipe: "dpo",
    steps: 12,
    ageMin: 180,
    extra: { error: "Out of GPU memory at step 12 (batch 16, 8,192 tokens): lower batch_size or max_tokens, or train qwen/qwen3-8b on an 80 GB GPU." },
  }),
  capped: run({ id: "run_e1b3d5f7a9c2486004e6a8c1", name: "support-sft-long", status: "stopped_budget", steps: 340, maxCost: 1.5, ageMin: 260 }),
  cancelled: run({ id: "run_a2c4e6f8b0d1357997b5d3f1", name: "support-sft-lr-sweep", status: "cancelled", steps: 64, ageMin: 300 }),
};

export const RUN_STREAMS: Record<string, string> = {
  [RUNS.finished.id as string]: runEvents(RUNS.finished, { steps: 400, final: "completed", warning: "1,204 records exceed max_tokens (8,192) and were truncated." }),
  [RUNS.training.id as string]: runEvents(RUNS.training, { steps: 236, final: "training" }),
  [RUNS.waiting.id as string]: runEvents(RUNS.waiting, { steps: 0, final: "waiting" }),
  [RUNS.interrupted.id as string]: runEvents(RUNS.interrupted, { steps: 288, interruptAt: 212, resumeFrom: 200, final: "training" }),
  [RUNS.failed.id as string]: runEvents(RUNS.failed, { steps: 12, final: "training" }),
  [RUNS.capped.id as string]: runEvents(RUNS.capped, { steps: 340, final: "training" }),
  [RUNS.cancelled.id as string]: runEvents(RUNS.cancelled, { steps: 64, final: "training" }),
};

const EVAL: Wire = {
  id: "eval_5a7c9e1b3d2f40688a6c4e20",
  workspace_id: "ws_demo",
  name: "support-compare",
  status: "completed",
  mode: "eval",
  models: ["qwen/qwen3-8b", "support-sft@2026-11-27-1"],
  baseline: "qwen/qwen3-8b",
  task_source: { kind: "dataset", dataset: "support-holdout", version: 2 },
  rubric: [],
  samples: 4,
  temperature: 0.7,
  max_tokens: 512,
  pass_threshold: 0.7,
  judge_models: ["anthropic/claude-sonnet-5-5"],
  local_scorers: [],
  progress: { total_outputs: 800, generated: 800, pending_local_scores: 0 },
  summary: [
    { model: "qwen/qwen3-8b", overall: 0.612, ci_low: 0.571, ci_high: 0.652, pass_at_k: { "pass@1": 0.58, "pass@4": 0.74 }, vs_baseline: null, tasks: 200, errors: 0, tokens_per_task: 412, cost_per_1k_tasks_usd: 0.49 },
    {
      model: "support-sft@2026-11-27-1",
      overall: 0.784,
      ci_low: 0.749,
      ci_high: 0.816,
      pass_at_k: { "pass@1": 0.76, "pass@4": 0.88 },
      vs_baseline: { delta: 0.172, ci_low: 0.121, ci_high: 0.224 },
      tasks: 200,
      errors: 2,
      tokens_per_task: 287,
      cost_per_1k_tasks_usd: 0.34,
    },
  ],
  total_cost_usd: 0.83,
  scored_dataset_version: null,
  error: null,
  created_at: iso(NOW - 50 * 60_000),
  updated_at: iso(NOW - 44 * 60_000),
  completed_at: iso(NOW - 44 * 60_000),
};

const RUNNING_EVAL: Wire = {
  ...EVAL,
  id: "eval_8c0e2a4b6d1f39577e9b1d3f",
  name: "router-vs-frontier",
  status: "running",
  models: ["router-distill@3", "openai/gpt-6.1", "anthropic/claude-sonnet-5-5"],
  summary: [],
  progress: { total_outputs: 1200, generated: 516, pending_local_scores: 0 },
  total_cost_usd: 1.42,
  created_at: iso(NOW - 4 * 60_000),
};

const SOURCE: Wire = {
  id: "src_1d3f5b7a9c2e48600a2c4e6b",
  workspace_id: "ws_demo",
  dataset: "support-prod",
  provider: { kind: "langfuse", host: "https://cloud.langfuse.com", secret: "langfuse-prod", project: "support-bot", filters: { tags: ["prod"] } },
  schedule: "*/30 * * * *",
  next_sync_at: iso(NOW + 21 * 60_000),
  last_synced_at: iso(NOW - 9 * 60_000),
  last_sync: { import_id: "imp_1", status: "completed", full: false, dataset_version: 4, error: null, created_at: iso(NOW - 9 * 60_000), finished_at: iso(NOW - 8 * 60_000) },
  created_at: iso(NOW - 3 * 86_400_000),
  updated_at: iso(NOW - 9 * 60_000),
};

const FAILING_SOURCE: Wire = {
  ...SOURCE,
  id: "src_6b8d0f2a4c1e37599d1f3b5a",
  provider: { kind: "posthog", host: "https://eu.posthog.com", secret: "posthog-key", project: "support-staging", filters: {} },
  schedule: null,
  next_sync_at: null,
  last_sync: {
    import_id: "imp_2",
    status: "failed",
    full: false,
    dataset_version: null,
    error: "401 from PostHog: the personal API key was revoked. Store a new key with grad secrets set posthog-key.",
    created_at: iso(NOW - 3_600_000),
    finished_at: iso(NOW - 3_590_000),
  },
};

const IMPORT: Wire = {
  id: "imp_3e5a7c9b1d0f24688c2a4e6d",
  workspace_id: "ws_demo",
  dataset: "support-prod",
  status: "completed",
  source: {},
  connector: "langfuse",
  attempt: 1,
  imported_count: 1_840,
  dropped_count: 12,
  detected_scores: ["resolved"],
  drop_reasons: ["no assistant turn (12)"],
  dataset_version: 4,
  error: null,
  created_at: iso(NOW - 9 * 60_000),
  updated_at: iso(NOW - 8 * 60_000),
};

const TRAINED_ARTIFACT: Wire = { ...(artifact as Wire), run_id: RUNS.finished.id, provenance: { source: "run", run_id: RUNS.finished.id, uploader: null, uri: null }, created_at: iso(NOW - 80 * 60_000) };

export const ARTIFACTS: Wire[] = [
  {
    ...TRAINED_ARTIFACT,
    id: "sql-lora@2026-11-27-2",
    name: "sql-lora",
    version: "2026-11-27-2",
    run_id: null,
    format: "peft_lora",
    base_model: "qwen/qwen3-8b",
    size_bytes: 84_000_000,
    provenance: { source: "upload", run_id: null, uploader: "key_7f3a9c21", uri: null },
    pins: [
      { artifact_id: "sql-lora@2026-11-27-2", holder: "inference:version:7b1c", reason: "acme/sql v3", created_at: iso(NOW - 20 * 60_000) },
      { artifact_id: "sql-lora@2026-11-27-2", holder: "inference:version:9d2e", reason: "acme/sql-eval (eval lane)", created_at: iso(NOW - 5 * 60_000) },
    ],
    created_at: iso(NOW - 26 * 60 * 60_000),
  },
  TRAINED_ARTIFACT,
  {
    ...TRAINED_ARTIFACT,
    id: "support-embedder@2026-11-26-1",
    name: "support-embedder",
    version: "2026-11-26-1",
    run_id: null,
    format: "encoder_safetensors",
    recipe_kind: "embedding",
    base_model: "BAAI/bge-small-en-v1.5",
    size_bytes: 133_500_000,
    provenance: { source: "import", run_id: null, uploader: null, uri: "hf://acme/support-embedder@4f0c1b2a9d8e7f6a5b4c3d2e1f0a9b8c7d6e5f4a" },
    created_at: iso(NOW - 2 * 86_400_000),
  },
];

const DATASETS = ["support-prod", "support-holdout", "router-labels", "sql-quickstart"].map((name, i) => ({
  ...(dataset as Wire),
  id: `ds_${i}a8c2e4f6b1d3057`,
  name,
  version: 4 - i,
  record_count: [18_420, 200, 5_312, 300][i],
  updated_at: iso(NOW - (i + 1) * 3_600_000),
}));

/** A list answered like grad-server: `status`, `q` (name substring or id) and `dataset` filter it. */
const listed = (items: Wire[]) => (url: URL) => {
  const status = url.searchParams.get("status")?.split(",");
  const q = url.searchParams.get("q")?.toLowerCase();
  const ds = url.searchParams.get("dataset");
  const limit = Number(url.searchParams.get("limit") ?? 50);
  const data = items.filter((i) => (!status || status.includes(String(i.status))) && (!q || String(i.name).toLowerCase().includes(q) || i.id === q) && (!ds || i.dataset === ds));
  return json({ data: data.slice(0, limit), next_cursor: null });
};

/** A run's metric points from its event stream, as `GET /v1/runs/{id}/metrics?max_points=` answers (replayed steps dropped). */
const curveOf = (stream: string): Wire[] => {
  const points: Wire[] = [];
  for (const block of stream.split("\n\n")) {
    if (!block.startsWith("event: metric")) continue;
    const ev = JSON.parse(block.split("\n")[1]?.slice(6) ?? "{}") as { seq: number; attempt: number; step: number; metric: Wire };
    while (points.length > 0 && Number(points[points.length - 1]?.step) >= ev.step) points.pop();
    points.push({ ...ev.metric, seq: ev.seq, attempt: ev.attempt });
  }
  return points;
};

export const workspace = (over: Routes = {}): Routes => {
  const allRuns = Object.values(RUNS);
  const byStatus = Object.fromEntries(["queued", "running", "completed", "failed", "cancelled", "stopped_budget", "stopped_balance"].map((st) => [st, allRuns.filter((r) => r.status === st).length]));
  return {
    "GET /v1/runs": listed(allRuns as Wire[]),
    "GET /v1/runs/counts": { total: allRuns.length, by_status: byStatus },
    ...Object.fromEntries(allRuns.map((r) => [`GET /v1/runs/${r.id}/metrics`, { run_id: r.id, status: r.status, data: curveOf(RUN_STREAMS[r.id as string] ?? ""), next_cursor: null, tail_cursor: "c" }])),
    ...Object.fromEntries(allRuns.map((r) => [`GET /v1/runs/${r.id}`, r])),
    ...Object.fromEntries(
      allRuns.map((r) => [
        `GET /v1/runs/${r.id}/events`,
        (() =>
          r.status === "completed" || r.status === "failed" || r.status === "cancelled" || r.status === "stopped_budget"
            ? new Response(RUN_STREAMS[r.id as string], { headers: { "content-type": "text/event-stream" } })
            : liveSse(RUN_STREAMS[r.id as string] ?? "")) as Handler,
      ]),
    ),
    ...Object.fromEntries(allRuns.map((r) => [`GET /v1/runs/${r.id}/checkpoints`, checkpointsFor(r, Number(r.current_step))])),
    "GET /v1/artifacts": listed(ARTIFACTS as Wire[]),
    "GET /v1/artifacts/:id": (url) => json(ARTIFACTS.find((a) => url.pathname.endsWith(`/${encodeURIComponent(String(a.id))}`)) ?? TRAINED_ARTIFACT),
    "GET /v1/artifacts/:id/download-url": (url) => json({ url: `${location.origin}/story-download${url.pathname}`, expires_at: iso(NOW + 15 * 60_000), sha256: TRAINED_ARTIFACT.sha256, size_bytes: 84_000_000, filename: "artifact.grad.tar.gz" }),
    "DELETE /v1/artifacts/:id": (url) =>
      ARTIFACTS.find((a) => url.pathname.endsWith(`/${encodeURIComponent(String(a.id))}`) && (a.pins as unknown[]).length > 0)
        ? problem(409, "artifact_pinned", "Artifact 'sql-lora@2026-11-27-2' is pinned by inference:version:7b1c (acme/sql v3), inference:version:9d2e (acme/sql-eval (eval lane)), so it can't be deleted. Unpublish it there first (that removes the pin).")
        : new Response(null, { status: 204 }),
    "GET /v1/datasets": listed(DATASETS as Wire[]),
    "GET /v1/datasets/:name": (url) => json(DATASETS.find((d) => url.pathname.endsWith(`/${d.name}`)) ?? DATASETS[0]),
    "GET /v1/datasets/:name/records": records as Wire,
    "GET /v1/sources": { data: [SOURCE, FAILING_SOURCE], next_cursor: null },
    "GET /v1/imports": listed([IMPORT] as Wire[]),
    "GET /v1/evals": listed([RUNNING_EVAL, EVAL] as Wire[]),
    [`GET /v1/evals/${EVAL.id}`]: EVAL,
    [`GET /v1/evals/${RUNNING_EVAL.id}`]: RUNNING_EVAL,
    [`GET /v1/evals/${EVAL.id}/failures`]: {
      data: [
        {
          task_id: "rec_0042",
          model: "support-sft@2026-11-27-1",
          score: 0.25,
          passed: false,
          sample_scores: [0.25, 0.5, 0, 0.25],
          judge_model: "anthropic/claude-sonnet-5-5",
          record: {
            id: "rec_0042",
            messages: [
              { role: "user", content: "My invoice shows the wrong VAT number. Can you reissue it?" },
              { role: "assistant", content: "I can't change invoices. Please contact billing." },
            ],
          },
        },
      ],
      next_cursor: null,
    },
    "GET /v1/usage": usage as Wire,
    "GET /v1/usage/summary": usageSummary as Wire,
    "GET /health/ready": { status: "ready" },
    ...over,
  };
};

export const STORY_NOW = NOW;
