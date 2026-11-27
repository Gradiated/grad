import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/app.js";
import { createApi } from "../src/lib/api.js";
import { navigate } from "../src/lib/router.js";
import { followRun } from "../src/lib/stream.js";
import { presets } from "../src/pages/usage.js";
import type { RunEvent } from "../src/lib/events.js";
// happy-dom has no canvas: stand in for uPlot and record what the charts draw.
type ChartOpts = { series: { label?: string }[]; hooks: { setCursor: ((u: unknown) => void)[] }; axes: { values: (u: unknown, ticks: number[]) => string[] }[] };
const charts = vi.hoisted(() => ({ created: [] as { series: string[]; data: unknown[]; opts: ChartOpts }[] }));
vi.mock("uplot", () => ({
  default: class {
    series: string[];
    constructor(opts: ChartOpts, data: unknown[]) {
      this.series = opts.series.map((s) => s.label ?? "");
      charts.created.push({ series: this.series, data, opts });
    }
    setData(data: unknown[]) {
      const c = charts.created.find((x) => x.series === this.series);
      if (c) c.data = data;
    }
    setSize() {}
    destroy() {}
  },
}));

import { byText, click, fakeServer, fixture, fixtureText, json, mount, problem, sse, type, waitFor, type Mounted } from "./helpers.js";

const RUN = fixture<Record<string, unknown>>("run.json");
const RUN_ID = RUN.id as string;
const QUEUED = { ...RUN, id: "run_q1", name: "router-queued", status: "queued", current_step: 0, workers_online: 0, autoscaling: true, queue_position: 2, queue_message: "Queued behind 2 runs", created_at: new Date(Date.now() - 90_000).toISOString(), finished_at: null };
const FAILED = { ...RUN, id: "run_f1", name: "broken-dpo", recipe_kind: "dpo", status: "failed", error: "CUDA out of memory" };

const DATASET = fixture("dataset.json");
const EVAL = {
  id: "eval_1",
  workspace_id: "ws_e2e",
  name: "support-compare",
  status: "completed",
  mode: "eval",
  models: ["test/tiny-qwen3", "support-sft@1"],
  baseline: "test/tiny-qwen3",
  task_source: { kind: "dataset", dataset: "support", version: 1 },
  rubric: [],
  samples: 1,
  temperature: 0,
  max_tokens: 64,
  pass_threshold: 0.5,
  judge_models: ["judge/m"],
  local_scorers: [],
  progress: { total_outputs: 20, generated: 20, pending_local_scores: 0 },
  summary: [
    { model: "test/tiny-qwen3", overall: 0.61, ci_low: 0.5, ci_high: 0.7, pass_at_k: { "1": 0.6 }, vs_baseline: null, tasks: 10, errors: 0, tokens_per_task: 120, cost_per_1k_tasks_usd: 0.4 },
    { model: "support-sft@1", overall: 0.82, ci_low: 0.74, ci_high: 0.9, pass_at_k: { "1": 0.8 }, vs_baseline: { delta: 0.21, ci_low: 0.1, ci_high: 0.3 }, tasks: 10, errors: 1, tokens_per_task: 110, cost_per_1k_tasks_usd: 0.3 },
  ],
  total_cost_usd: 0.02,
  scored_dataset_version: null,
  error: null,
  created_at: "2026-11-27T13:00:00Z",
  updated_at: "2026-11-27T13:01:00Z",
  completed_at: "2026-11-27T13:01:00Z",
};

const routes = (extra: Record<string, unknown> = {}) => ({
  "GET /v1/runs": { data: [QUEUED, RUN, FAILED], next_cursor: null },
  [`GET /v1/runs/${RUN_ID}`]: RUN,
  "GET /v1/runs/run_q1": QUEUED,
  [`GET /v1/runs/${RUN_ID}/metrics`]: () => sse(fixtureText("metrics.sse")),
  [`GET /v1/runs/${RUN_ID}/checkpoints`]: fixture("checkpoints.json"),
  "GET /v1/artifacts/:id": fixture("artifact.json"),
  "GET /v1/datasets": { data: [DATASET], next_cursor: null },
  "GET /v1/datasets/support": DATASET,
  "GET /v1/datasets/support/records": fixture("records.json"),
  "GET /v1/sources": {
    data: [
      {
        id: "src_1",
        workspace_id: "ws_e2e",
        dataset: "support",
        provider: { kind: "langfuse", host: "https://lf", secret: "lf", project: "prod-traces", filters: {} },
        schedule: "1h",
        next_sync_at: null,
        last_synced_at: "2026-11-27T13:00:00Z",
        last_sync: { import_id: "imp_1", status: "failed", full: false, dataset_version: null, error: "401 from Langfuse", created_at: "2026-11-27T13:00:00Z", finished_at: "2026-11-27T13:00:01Z" },
        created_at: "2026-11-27T12:00:00Z",
        updated_at: "2026-11-27T13:00:00Z",
      },
    ],
    next_cursor: null,
  },
  "GET /v1/imports": {
    data: [{ id: "imp_1", workspace_id: "ws_e2e", dataset: "support", status: "completed", source: {}, connector: "langfuse", attempt: 1, imported_count: 120, dropped_count: 2, detected_scores: [], drop_reasons: ["no assistant turn"], dataset_version: 1, error: null, created_at: "2026-11-27T13:00:00Z", updated_at: "2026-11-27T13:00:00Z" }],
    next_cursor: null,
  },
  "POST /v1/sources/src_1/sync": { id: "imp_2", workspace_id: "ws_e2e", dataset: "support", status: "queued", source: {}, connector: "langfuse", attempt: 0, imported_count: 0, dropped_count: 0, detected_scores: [], drop_reasons: [], dataset_version: null, error: null, created_at: "t", updated_at: "t" },
  "GET /v1/evals": { data: [EVAL], next_cursor: null },
  "GET /v1/evals/eval_1": EVAL,
  "GET /v1/evals/eval_1/failures": { data: [{ task_id: "rec_0001", model: "support-sft@1", score: 0.2, passed: false, sample_scores: [0.2], judge_model: "judge/m", record: { id: "rec_0001", messages: [{ role: "user", content: "Where is my invoice?" }] } }], next_cursor: null },
  "GET /v1/usage": fixture("usage.json"),
  "GET /v1/usage/summary": fixture("usage-summary.json"),
  ...extra,
});

let app: Mounted | undefined;
beforeEach(() => {
  charts.created.length = 0;
  sessionStorage.clear();
  history.replaceState(null, "", "/");
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => (String(input).endsWith("/health/ready") ? json({ status: "ready" }) : problem(404, "route_not_found")));
});
afterEach(() => {
  app?.unmount();
  app = undefined;
  vi.unstubAllGlobals();
});

const boot = async (server = fakeServer(routes()), path = "/") => {
  history.replaceState(null, "", path);
  app = await mount(<App fetch={server.fetch} />);
  return { server, container: app.container };
};

describe("auth", () => {
  it("needs no login when the server has auth disabled", async () => {
    const { container, server } = await boot();
    await waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Runs"));
    expect(container.textContent).toContain("no auth (local)");
    expect(server.calls[0]?.auth).toBeNull();
  });

  it("shows the login page on 401, keeps a pasted key in sessionStorage only, and signs out", async () => {
    const server = fakeServer(routes(), { key: "grad_live_key_123456" });
    const { container } = await boot(server);
    await waitFor(() => expect(container.textContent).toContain("Sign in to grad"));
    await type(container.querySelector("#api-key"), "grad_wrong");
    await click(container.querySelector("button[type=submit]"));
    await waitFor(() => expect(container.textContent).toContain("rejected that key"));
    await type(container.querySelector("#api-key"), "grad_live_key_123456");
    await click(container.querySelector("button[type=submit]"));
    await waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Runs"));
    expect(sessionStorage.getItem("grad.api_key")).toBe("grad_live_key_123456");
    expect(localStorage.length).toBe(0);
    expect(document.cookie).toBe("");
    expect(server.calls.at(-1)?.auth).toBe("Bearer grad_live_key_123456");
    await click(container.querySelector("[aria-label='Sign out']"));
    await waitFor(() => expect(container.textContent).toContain("Sign in to grad"));
    expect(sessionStorage.getItem("grad.api_key")).toBeNull();
  });

  it("signs in from a `grad ui` #key= handoff and clears the fragment", async () => {
    const server = fakeServer(routes(), { key: "grad_handoff_key_9999" });
    const { container } = await boot(server, "/runs#key=grad_handoff_key_9999");
    await waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Runs"));
    expect(location.hash).toBe("");
    expect(container.textContent).toContain("grad_hand…9999");
  });

  it("returns to the login page when a later request is rejected", async () => {
    let revoked = false;
    const server = fakeServer(routes({ "GET /v1/datasets": () => (revoked ? problem(401, "unauthorized") : undefined) }), { key: "grad_k_0000000000" });
    sessionStorage.setItem("grad.api_key", "grad_k_0000000000");
    const { container } = await boot(server);
    await waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Runs"));
    revoked = true;
    navigate("/datasets");
    await waitFor(() => expect(container.textContent).toContain("Your session ended"));
  });

  it("reports an unreachable server", async () => {
    const down = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    app = await mount(<App fetch={down} />);
    await waitFor(() => expect(app?.container.textContent).toContain("Cannot reach grad-server"), 5000);
  });
});

describe("runs", () => {
  it("lists runs with status, phase, recipe, model, dataset and cost; filters by status and text", async () => {
    const { container } = await boot();
    await waitFor(() => expect(container.querySelectorAll("tbody tr").length).toBe(3));
    const text = container.textContent ?? "";
    expect(text).toContain("support-sft");
    expect(text).toContain("test/tiny-qwen3");
    expect(text).toContain("$0.0114of $5.00");
    expect(text).toContain("sft · support v1");
    expect(byText(container, "tbody tr", "router-queued")?.textContent).toContain("Queued");
    await click(byText(container, ".segmented button", "Failed"));
    await waitFor(() => expect(container.querySelectorAll("tbody tr").length).toBe(1));
    expect(location.search).toBe("?status=failed");
    await click(byText(container, ".segmented button", "All"));
    await type(container.querySelector("input[type=search]"), "router");
    await waitFor(() => expect(container.querySelectorAll("tbody tr").length).toBe(1));
    await type(container.querySelector("input[type=search]"), "zzz");
    await waitFor(() => expect(container.textContent).toContain("No runs match"));
  });

  it("loads older pages", async () => {
    const server = fakeServer(
      routes({
        "GET /v1/runs": ({ url }: { url: URL }) => (url.searchParams.get("cursor") === "c2" ? json({ data: [{ ...RUN, id: "run_old", name: "ancient" }], next_cursor: null }) : json({ data: [RUN], next_cursor: "c2" })),
      }),
    );
    const { container } = await boot(server);
    await waitFor(() => expect(byText(container, "button", "Load older runs")).toBeTruthy());
    await click(byText(container, "button", "Load older runs"));
    await waitFor(() => expect(container.textContent).toContain("ancient"));
    expect(byText(container, "button", "Load older runs")).toBeUndefined();
  });

  it("draws the cost cap once the spend nears it", async () => {
    const near = { ...RUN, cost_usd: 4.2, updated_at: "2099-01-01T00:00:00Z" };
    const { container } = await boot(fakeServer(routes({ [`GET /v1/runs/${RUN_ID}`]: near })), `/runs/${RUN_ID}`);
    await waitFor(() => expect(container.textContent).toContain("Checkpoints"));
    await waitFor(() => expect(charts.created.some((c) => c.series.includes("cap"))).toBe(true));
  });

  it("shows a queued run's wait instead of empty charts", async () => {
    const { container } = await boot(fakeServer(routes({ "GET /v1/runs/run_q1/events": () => sse("") })), "/runs/run_q1");
    await waitFor(() => expect(container.textContent).toContain("Waiting for the first step"));
    const text = container.textContent ?? "";
    expect(text).toContain("queued for");
    expect(text).toContain("Queued behind 2 runs");
    expect(container.querySelectorAll(".chart").length).toBe(0);
  });

  it("retries a failed page load", async () => {
    let fail = true;
    const server = fakeServer(routes({ "GET /v1/runs": ({ url }: { url: URL }) => (fail && url.searchParams.get("limit") === "100" ? problem(400, "bad_request", "listing failed") : json({ data: [RUN], next_cursor: null })) }));
    const { container } = await boot(server);
    await waitFor(() => expect(container.textContent).toContain("listing failed"));
    fail = false;
    await click(byText(container, "button", "Retry"));
    await waitFor(() => expect(byText(container, "tbody tr", "support-sft")).toBeTruthy());
  });

  it("switches between the dark and light themes and remembers the choice", async () => {
    localStorage.clear();
    const { container } = await boot();
    await waitFor(() => expect(container.querySelector("[aria-label='Switch to the light theme']")).toBeTruthy());
    await click(container.querySelector("[aria-label='Switch to the light theme']"));
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(localStorage.getItem("grad-theme")).toBe("light");
    await click(container.querySelector("[aria-label='Switch to the dark theme']"));
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("grad-theme")).toBe("dark");
  });

  it("shows an empty state", async () => {
    const { container } = await boot(fakeServer(routes({ "GET /v1/runs": { data: [], next_cursor: null } })));
    await waitFor(() => expect(container.textContent).toContain("No runs yet"));
  });

  it("opens a run and renders its header, charts, checkpoints, report, artifact, config and timeline", async () => {
    const { container, server } = await boot();
    await waitFor(() => expect(byText(container, "tbody tr", "support-sft")).toBeTruthy());
    await click(byText(container, "tbody tr", "support-sft"));
    await waitFor(() => expect(container.textContent).toContain("Checkpoints"));
    expect(location.pathname).toBe(`/runs/${RUN_ID}`);
    await waitFor(() => expect(container.textContent).toContain("Completed"));
    await waitFor(() => expect(container.querySelectorAll(".timeline li").length).toBeGreaterThan(0));
    await waitFor(() => expect(container.textContent).toContain("support-sft@2026-11-27-1"));
    const text = container.textContent ?? "";
    expect(text).toContain("Attempt 1 / 10");
    expect(text).toContain("Step 3 / 3");
    expect(text).toContain("Eval report");
    expect(text).toContain("Reference test backend");
    expect(text).toContain("grad artifacts download support-sft@2026-11-27-1 --output ./support-sft");
    expect(text).toContain("of $5.00 cap");
    expect(text).toMatch(/Loss/);
    const loss = charts.created.find((c) => c.series.includes("train"));
    expect(loss?.series).toEqual(["step", "raw", "train", "eval"]);
    expect(loss?.data[0]).toEqual([1, 2, 3]);
    // Hovering reads out the step and the smoothed values, not the faint raw series.
    const cursor = { cursor: { idx: 1 as number | null }, data: loss?.data };
    act(() => loss?.opts.hooks.setCursor[0]?.(cursor));
    const readout = container.querySelector(".chart-readout");
    expect(readout?.textContent).toMatch(/^step 2train [\d.]+/);
    expect(readout?.textContent).not.toContain("raw");
    cursor.cursor.idx = null;
    act(() => loss?.opts.hooks.setCursor[0]?.(cursor));
    expect(readout?.textContent).toBe("");
    expect(loss?.opts.axes[0]?.values(cursor, [1000, 1.5])).toEqual(["1,000", ""]);
    expect(loss?.opts.axes[1]?.values(cursor, [0.5])).toEqual(["0.5"]);
    // $0.01 of a $5 cap: the cap line would flatten the cost line, so the legend states the share instead.
    expect(charts.created.some((c) => c.series.includes("cap"))).toBe(false);
    expect(text).toContain("0% of cap");
    expect(container.querySelector("pre.code")?.textContent).toContain("model: test/tiny-qwen3");
    expect(container.querySelector("pre.code")?.textContent).toContain("checkpoint_every_steps: 1");
    expect(container.querySelectorAll(".table tbody tr").length).toBeGreaterThanOrEqual(3);
    // No /events on this server: the page fell back to the metrics stream.
    expect(server.calls.some((c) => c.path.startsWith(`/v1/runs/${RUN_ID}/events`))).toBe(true);
    expect(server.calls.some((c) => c.path.startsWith(`/v1/runs/${RUN_ID}/metrics`))).toBe(true);
    expect(byText(container, "button", "Resume")).toBeUndefined();
    expect(byText(container, "button", "Cancel")).toBeUndefined();
  });

  it("promotes a checkpoint", async () => {
    const promoted: string[] = [];
    const server = fakeServer(
      routes({
        "POST /v1/checkpoints/:id/promote": ({ url, body }: { url: URL; body?: string }) => {
          promoted.push(`${url.pathname} ${body}`);
          return json({ ...fixture<Record<string, unknown>>("artifact.json"), name: "my-model", version: "2026-11-27-2" });
        },
      }),
    );
    const { container } = await boot(server, `/runs/${RUN_ID}`);
    await waitFor(() => expect(byText(container, "button", "Promote")).toBeTruthy());
    await click(byText(container, "button", "Promote"));
    await type(container.querySelector("#promote-name"), "my-model");
    await click(byText(container, ".dialog button", "Promote"));
    await waitFor(() => expect(container.textContent).toContain("Promoted to my-model@2026-11-27-2"));
    expect(promoted[0]).toMatch(/^\/v1\/checkpoints\/ckpt_\w+\/promote \{"name":"my-model"\}$/);
  });

  it("cancels an active run and resumes a failed one with a new cap", async () => {
    const posted: string[] = [];
    const server = fakeServer(
      routes({
        "GET /v1/runs/run_f1": FAILED,
        "GET /v1/runs/:id/metrics": () => sse(""),
        "GET /v1/runs/:id/checkpoints": { data: [], next_cursor: null },
        "POST /v1/runs/:id/cancel": ({ url }: { url: URL }) => (posted.push(url.pathname), json({ ...QUEUED, status: "cancelled" })),
        "POST /v1/runs/:id/resume": ({ url, body }: { url: URL; body?: string }) => (posted.push(`${url.pathname} ${body}`), json({ ...FAILED, status: "queued" })),
      }),
    );
    const { container } = await boot(server, "/runs/run_q1");
    await waitFor(() => expect(container.textContent).toContain("Starting a worker"));
    expect(container.textContent).toContain("Queued behind 2 runs");
    expect(container.textContent).toContain("No checkpoints yet");
    await click(byText(container, ".page-header button", "Cancel"));
    await click(byText(container, ".dialog button", "Cancel run"));
    await waitFor(() => expect(posted).toContain("/v1/runs/run_q1/cancel"));

    navigate("/runs/run_f1");
    await waitFor(() => expect(container.textContent).toContain("CUDA out of memory"));
    await click(byText(container, ".page-header button", "Resume"));
    await type(container.querySelector("#resume-cap"), "12");
    await click(byText(container, ".dialog button", "Resume"));
    await waitFor(() => expect(posted.some((p) => p === '/v1/runs/run_f1/resume {"max_cost_usd":12}')).toBe(true));
  });

  it("shows the API error for a missing run", async () => {
    const { container } = await boot(fakeServer(routes({ "GET /v1/runs/:id": () => problem(404, "run_not_found", "No run run_zzz.") })), "/runs/run_zzz");
    await waitFor(() => expect(container.textContent).toContain("No run run_zzz."));
  });
});

describe("datasets, evals, usage, health", () => {
  it("lists datasets and shows versions, merged records with scores, sources with errors, and imports", async () => {
    const posted: string[] = [];
    const job = routes()["POST /v1/sources/src_1/sync"];
    const server = fakeServer(routes({ "POST /v1/sources/src_1/sync": () => (posted.push("sync"), json(job)) }));
    const { container } = await boot(server, "/datasets");
    await waitFor(() => expect(byText(container, "tbody tr", "support")).toBeTruthy());
    await click(byText(container, "tbody tr", "support"));
    await waitFor(() => expect(container.textContent).toContain("401 from Langfuse"));
    await waitFor(() => expect(container.querySelectorAll(".record .msg").length).toBeGreaterThan(0));
    const text = container.textContent ?? "";
    expect(text).toContain("prod-traces");
    expect(text).toContain("120 imported · 2 dropped");
    expect(container.querySelector("select#version")).toBeTruthy();
    await click(byText(container, "button", "Sync"));
    await click(byText(container, ".dialog button", "Sync"));
    await waitFor(() => expect(posted).toEqual(["sync"]));
    await waitFor(() => expect(container.textContent).toContain("Sync queued: imp_2"));
  });

  it("shows eval summaries with CIs, deltas and failures", async () => {
    const { container } = await boot(undefined, "/evals");
    await waitFor(() => expect(byText(container, "tbody tr", "support-compare")).toBeTruthy());
    await click(byText(container, "tbody tr", "support-compare"));
    await waitFor(() => expect(container.textContent).toContain("Where is my invoice?"));
    const text = container.textContent ?? "";
    expect(text).toContain("+0.21");
    expect(text).toContain("0.74–0.9");
    expect(text).toContain("pass@1");
    expect(container.querySelectorAll(".ci").length).toBe(2);
  });

  it("summarises usage for a period and regroups it", async () => {
    const { container, server } = await boot(undefined, "/usage");
    await waitFor(() => expect(container.textContent).toContain("support-router-labels"));
    const text = container.textContent ?? "";
    for (const want of ["$0.0134", "4 billed rows", "Training", "Labeling", "2026-11-27", "support-sft", "Top evals"]) expect(text).toContain(want);
    await waitFor(() => expect(byText(container, ".card", "Billed rows")?.querySelectorAll("tbody tr").length).toBe(3));
    const asked = () => server.calls.filter((c) => c.path.startsWith("/v1/usage")).map((c) => c.path);
    expect(asked().some((p) => /^\/v1\/usage\/summary\?from=\d{4}-\d{2}-01&to=\d{4}-\d{2}-\d{2}&group_by=day$/.test(p))).toBe(true);

    await click(byText(container, "button", /^Model$/));
    await waitFor(() => expect(asked().some((p) => p.includes("group_by=model"))).toBe(true));
    expect(location.search).toContain("by=model");

    await type(container.querySelector("#usage-from"), "2026-10-01");
    await waitFor(() => expect(asked().some((p) => p === "/v1/usage?limit=25&from=2026-10-01&to=2026-11-30")).toBe(true));
    expect(container.textContent).toContain("Custom");
    await click(byText(container, "button", /^Last month$/));
    const last = presets()["last-month"];
    expect(location.search).toBe(`?by=model&from=${last.from}&to=${last.to}`);
    expect(container.textContent).not.toContain("Custom");
  });

  it("pages through older billed rows", async () => {
    const rows = fixture<{ data: Record<string, unknown>[] }>("usage.json");
    const server = fakeServer(
      routes({
        "GET /v1/usage": ({ url }: { url: URL }) =>
          url.searchParams.get("cursor") === "u2" ? json({ data: [{ ...rows.data[0], id: "use_old", ref_name: "ancient-run" }], next_cursor: null }) : json({ ...rows, next_cursor: "u2" }),
      }),
    );
    const { container } = await boot(server, "/usage");
    await waitFor(() => expect(byText(container, "button", "Show older rows")).toBeTruthy());
    await click(byText(container, "button", "Show older rows"));
    await waitFor(() => expect(container.textContent).toContain("ancient-run"));
    expect(byText(container, ".card", "Billed rows")?.querySelectorAll("tbody tr").length).toBe(4);
    expect(byText(container, "button", "Show older rows")).toBeUndefined();
  });

  it("shows pools and the queue on the health page", async () => {
    const { container } = await boot(undefined, "/health");
    await waitFor(() => expect(container.textContent).toContain("scaling up"));
    expect(container.textContent).toContain("router-queued");
    expect(container.textContent).toContain("database reachable");
    expect(container.textContent).toContain("ready");
    expect(container.textContent).toContain("Queued behind 2 runs");
  });

  it("renders a not-found page for unknown routes", async () => {
    const { container } = await boot(undefined, "/nope");
    await waitFor(() => expect(container.textContent).toContain("Nothing here"));
  });
});

describe("followRun", () => {
  it("resumes with Last-Event-ID after a dropped stream and stops at the final event", async () => {
    let calls = 0;
    const seen: (string | null)[] = [];
    const server = fakeServer({
      "GET /v1/runs/run_1/events": ({ headers }: { headers: Headers }) => {
        seen.push(headers.get("last-event-id"));
        calls += 1;
        if (calls === 1) return sse('event: phase\nid: 1\ndata: {"seq":1,"attempt":1,"phase":"training","step":0,"timestamp":"t"}\n\n');
        if (calls === 2) return problem(503, "database_unavailable");
        return sse(`event: completed\ndata: ${JSON.stringify({ type: "completed", seq: 1, attempt: 1, timestamp: "t", status: "completed", run: RUN })}\n\n`);
      },
    });
    const batches: RunEvent[][] = [];
    await followRun(createApi("http://x", undefined, server.fetch), "run_1", (b) => batches.push(b), new AbortController().signal, { sleep: async () => undefined, flushMs: 1 });
    expect(seen).toEqual([null, "1", "1"]);
    expect(batches.flat().map((e) => e.type)).toEqual(["phase", "completed"]);
  });

  it("gives up on client errors and stops when aborted", async () => {
    const server = fakeServer({ "GET /v1/runs/run_1/events": () => problem(403, "forbidden") });
    await expect(followRun(createApi("http://x", undefined, server.fetch), "run_1", () => undefined, new AbortController().signal)).rejects.toMatchObject({ status: 403 });
    const ctrl = new AbortController();
    ctrl.abort();
    await followRun(createApi("http://x", undefined, server.fetch), "run_1", () => undefined, ctrl.signal);
  });
});
