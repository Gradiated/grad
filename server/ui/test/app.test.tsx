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

/** A thinned curve (GET /v1/runs/{id}/metrics?max_points=): train loss each step, an eval every other. */
const curve = (runId: string, scale: number) => ({
  run_id: runId,
  status: "completed",
  data: [1, 2, 3, 4].map((step) => ({ seq: step, attempt: 1, step, loss: scale / step, tokens: step * 10, cost_usd: 0, timestamp: "t", ...(step % 2 === 0 ? { eval_loss: scale / step + 0.1, eval_metrics: { accuracy: 0.5 + step / 10 } } : {}) })),
  next_cursor: null,
  tail_cursor: "c4",
});

/** A list answered like grad-server: `status` (comma-separated), `q` (name substring or id) and `dataset` filter it. */
const listed =
  (items: Record<string, unknown>[]) =>
  ({ url }: { url: URL }) => {
    const status = url.searchParams.get("status")?.split(",");
    const q = url.searchParams.get("q")?.toLowerCase();
    const dataset = url.searchParams.get("dataset");
    const data = items.filter(
      (i) => (!status || status.includes(String(i.status))) && (!q || String(i.name).toLowerCase().includes(q) || i.id === q) && (!dataset || i.dataset === dataset),
    );
    return json({ data, next_cursor: null });
  };

const routes = (extra: Record<string, unknown> = {}) => ({
  "GET /v1/runs": listed([QUEUED, RUN, FAILED]),
  "GET /v1/runs/counts": { total: 1302, by_status: { queued: 1, running: 0, completed: 1000, failed: 300, cancelled: 1, stopped_budget: 0, stopped_balance: 0 } },
  [`GET /v1/runs/${RUN_ID}`]: RUN,
  "GET /v1/runs/run_q1": QUEUED,
  [`GET /v1/runs/${RUN_ID}/metrics`]: ({ url }: { url: URL }) => (url.searchParams.has("max_points") ? json(curve(RUN_ID, 1)) : sse(fixtureText("metrics.sse"))),
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
  "GET /v1/imports": listed([
    { id: "imp_1", workspace_id: "ws_e2e", dataset: "support", status: "completed", source: {}, connector: "langfuse", attempt: 1, imported_count: 120, dropped_count: 2, detected_scores: [], drop_reasons: ["no assistant turn"], dataset_version: 1, error: null, created_at: "2026-11-27T13:00:00Z", updated_at: "2026-11-27T13:00:00Z" },
    { id: "imp_9", workspace_id: "ws_e2e", dataset: "other", status: "completed", source: {}, connector: "jsonl", attempt: 1, imported_count: 999, dropped_count: 0, detected_scores: [], drop_reasons: [], dataset_version: 1, error: null, created_at: "2026-11-27T14:00:00Z", updated_at: "2026-11-27T14:00:00Z" },
  ]),
  "POST /v1/sources/src_1/sync": { id: "imp_2", workspace_id: "ws_e2e", dataset: "support", status: "queued", source: {}, connector: "langfuse", attempt: 0, imported_count: 0, dropped_count: 0, detected_scores: [], drop_reasons: [], dataset_version: null, error: null, created_at: "t", updated_at: "t" },
  "GET /v1/evals": listed([EVAL]),
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
  vi.restoreAllMocks();
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
  it("lists runs with status, phase, recipe, model, dataset and cost; the server filters by status and text", async () => {
    const { container, server } = await boot();
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
    expect(server.calls.some((c) => c.path === "/v1/runs?limit=50&status=failed")).toBe(true);
    await click(byText(container, ".segmented button", "Stopped"));
    await waitFor(() => expect(server.calls.some((c) => c.path.includes("status=cancelled%2Cstopped_budget%2Cstopped_balance"))).toBe(true));
    await click(byText(container, ".segmented button", "All"));
    await type(container.querySelector("input[type=search]"), "router");
    await waitFor(() => expect(container.querySelectorAll("tbody tr").length).toBe(1));
    expect(location.search).toBe("?q=router");
    // A tab change is a history entry (Back undoes it); typing in the filter is not.
    history.back();
    await waitFor(() => expect(location.search).toBe("?status=stopped"));
    expect(server.calls.some((c) => c.path === "/v1/runs?limit=50&q=router")).toBe(true);
    await type(container.querySelector("input[type=search]"), "zzz");
    await waitFor(() => expect(container.textContent).toContain("No runs match"));
  });

  it("ticks runs to compare from the list, with the server's count on each tab", async () => {
    const { container, server } = await boot();
    await waitFor(() => expect(byText(container, ".segmented button", "Failed")?.textContent).toBe("Failed300"));
    expect(byText(container, ".segmented button", "All")?.textContent).toBe("All1,302");
    expect(byText(container, ".segmented button", "Stopped")?.textContent).toBe("Stopped1");
    await type(container.querySelector("input[type=search]"), "support");
    await waitFor(() => expect(server.calls.some((c) => c.path === "/v1/runs/counts?q=support")).toBe(true));
    await type(container.querySelector("input[type=search]"), "");
    await waitFor(() => expect(container.querySelectorAll("tbody tr").length).toBe(3));

    const compare = () => byText(container, ".toolbar .btn", "Compare");
    expect(compare()?.hasAttribute("disabled")).toBe(true);
    // Ticking a box doesn't open the row.
    await click(container.querySelector('input[aria-label="Compare support-sft"]'));
    expect(location.pathname).toBe("/");
    expect(compare()?.textContent).toBe("Compare 1");
    await click(container.querySelector('input[aria-label="Compare broken-dpo"]'));
    expect(container.querySelectorAll("tr.picked").length).toBe(2);
    await click(compare());
    await waitFor(() => expect(location.pathname).toBe("/runs/compare"));
    expect(new URLSearchParams(location.search).get("ids")).toBe(`${RUN_ID},run_f1`);
  });

  it("compares runs: one metric overlaid, the results, the settings that differ, and runs that failed to load", async () => {
    const config = RUN.resolved_config as Record<string, unknown>;
    const server = fakeServer(
      routes({
        "GET /v1/runs/run_f1": { ...FAILED, resolved_config: { ...config, lr: 0.5 } },
        "GET /v1/runs/run_f1/metrics": curve("run_f1", 2),
      }),
    );
    const { container } = await boot(server, `/runs/compare?ids=${RUN_ID},run_f1,run_gone`);
    await waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Compare 3 runs"));
    await waitFor(() => expect(charts.created.at(-1)?.series).toEqual(["step", "support-sft", "broken-dpo"]));
    expect(server.calls.some((c) => c.path === `/v1/runs/${RUN_ID}/metrics?max_points=1000`)).toBe(true);
    expect(charts.created.at(-1)?.data[0]).toEqual([1, 2, 3, 4]);
    expect(container.textContent).toContain("Couldn't load run_gone");
    const results = byText(container, ".card", "Results");
    expect(byText(results as HTMLElement, "tr", "Final train loss")?.textContent).toContain("0.25");
    expect(byText(results as HTMLElement, "tr", "Final eval accuracy")?.textContent).toContain("0.9");
    const settings = byText(container, ".card", "Settings") as HTMLElement;
    expect(settings.textContent).toContain("1 of");
    expect([...settings.querySelectorAll("tbody th")].map((th) => th.textContent)).toEqual(["lr"]);
    expect(settings.querySelector("td.changed")?.textContent).toBe("0.5");
    await click(settings.querySelector("input[type=checkbox]"));
    await waitFor(() => expect(settings.querySelectorAll("tbody th").length).toBeGreaterThan(5));
    expect(location.search).toContain("config=all");

    const select = container.querySelector<HTMLSelectElement>("#compare-metric");
    expect([...(select?.options ?? [])].map((o) => o.value)).toEqual(["loss", "eval_loss", "eval.accuracy", "cost_usd"]);
    await act(async () => {
      if (!select) return;
      select.value = "eval.accuracy";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await waitFor(() => expect(container.querySelector(".chart-card h2")?.textContent).toBe("Eval accuracy"));
    expect(new URLSearchParams(location.search).get("metric")).toBe("eval.accuracy");
    // The axis is the steps that have the metric: evals at steps 2 and 4.
    expect(charts.created.at(-1)?.data[0]).toEqual([2, 4]);

    await click(container.querySelector('button[aria-label="Remove broken-dpo from the comparison"]'));
    await waitFor(() => expect(new URLSearchParams(location.search).get("ids")).toBe(`${RUN_ID},run_gone`));
    await click(byText(container, ".banner button", "Remove"));
    await waitFor(() => expect(container.textContent).toContain("Pick two or more runs"));
  });

  it("opens a row in this tab, or a new one with Cmd/Ctrl or the middle button; its title is a real link", async () => {
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    const { container } = await boot();
    await waitFor(() => expect(container.querySelectorAll("tbody tr").length).toBe(3));
    const row = byText(container, "tbody tr", "broken-dpo") as HTMLElement;
    expect(row.querySelector("a.row-title")?.getAttribute("href")).toBe("/runs/run_f1");
    await act(async () => {
      row.querySelector("td:nth-child(3)")?.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      row.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 }));
    });
    expect(opened.mock.calls).toEqual([
      ["/runs/run_f1", "_blank", "noopener"],
      ["/runs/run_f1", "_blank", "noopener"],
    ]);
    expect(location.pathname).toBe("/");
    await click(row.querySelector("td:nth-child(3)"));
    expect(location.pathname).toBe("/runs/run_f1");
  });

  it("keeps showing loaded runs when a refresh fails, and says so; says when the browser is offline", async () => {
    let down = false;
    const server = fakeServer(routes({ "GET /v1/runs": ({ url }: { url: URL }) => (down && url.searchParams.get("limit") === "50" ? problem(503, "unavailable", "database unreachable") : json({ data: [RUN], next_cursor: null })) }));
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { container } = await boot(server);
      await waitFor(() => expect(byText(container, "tbody tr", "support-sft")).toBeTruthy());
      down = true;
      await act(async () => {
        await vi.advanceTimersByTimeAsync(11_000);
      });
      await waitFor(() => expect(container.textContent).toContain("Couldn't refresh: database unreachable"));
      expect(byText(container, "tbody tr", "support-sft")).toBeTruthy();
      await act(async () => {
        Object.defineProperty(navigator, "onLine", { value: false, configurable: true });
        dispatchEvent(new Event("offline"));
      });
      expect(container.querySelector(".offline")?.textContent).toContain("You're offline");
      await act(async () => {
        Object.defineProperty(navigator, "onLine", { value: true, configurable: true });
        dispatchEvent(new Event("online"));
      });
      expect(container.querySelector(".offline")).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("says which scope a key lacks, without a Retry that can't help", async () => {
    const { container } = await boot(fakeServer(routes({ "GET /v1/datasets": () => problem(403, "forbidden", "This endpoint requires the 'datasets:read' scope.") })), "/datasets");
    await waitFor(() => expect(container.textContent).toContain("requires the 'datasets:read' scope. Sign in with a key that has it"));
    expect(byText(container, "button", "Retry")).toBeUndefined();
    expect(container.textContent).not.toContain("No datasets yet");
  });

  it("focuses the filter with / and clears it with Escape", async () => {
    const { container } = await boot();
    await waitFor(() => expect(container.querySelectorAll("tbody tr").length).toBe(3));
    const input = container.querySelector<HTMLInputElement>("input[type=search]");
    await act(async () => {
      document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "/", bubbles: true }));
    });
    expect(document.activeElement).toBe(input);
    await type(input, "router");
    await act(async () => {
      input?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await waitFor(() => expect(location.search).toBe(""));
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
    const server = fakeServer(routes({ "GET /v1/runs": ({ url }: { url: URL }) => (fail && url.searchParams.get("limit") === "50" ? problem(503, "unavailable", "listing failed") : json({ data: [RUN], next_cursor: null })) }));
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
    // The cap sits on the cost tile's sub-line, so the value itself never truncates.
    const cost = [...container.querySelectorAll(".stat")].find((el) => el.querySelector(".stat-label")?.textContent === "Cost");
    expect(cost?.querySelector(".stat-value")?.textContent).toBe("$0.0114");
    expect(cost?.querySelector(".stat-hint")?.textContent).toBe("of $5.00 cap");
    expect(container.querySelector("pre.code")?.textContent).toContain("model: test/tiny-qwen3");
    expect(container.querySelector("pre.code")?.textContent).toContain("checkpoint_every_steps: 1");
    expect(container.querySelectorAll(".table tbody tr").length).toBeGreaterThanOrEqual(3);
    expect(document.title).toBe("support-sft · grad");
    // No /events on this server: the page fell back to the metrics stream.
    expect(server.calls.some((c) => c.path.startsWith(`/v1/runs/${RUN_ID}/events`))).toBe(true);
    expect(server.calls.some((c) => c.path.startsWith(`/v1/runs/${RUN_ID}/metrics`))).toBe(true);
    expect(byText(container, "button", "Resume")).toBeUndefined();
    expect(byText(container, "button", "Cancel")).toBeUndefined();
  });

  it("ends a stopped_balance run: resumable, not cancellable, not live", async () => {
    const broke = { ...FAILED, id: "run_b1", name: "broke", status: "stopped_balance", error: "The workspace ran out of balance." };
    const { container } = await boot(fakeServer(routes({ "GET /v1/runs/run_b1": broke, "GET /v1/runs/:id/events": () => sse(""), "GET /v1/runs/:id/checkpoints": { data: [], next_cursor: null } })), "/runs/run_b1");
    await waitFor(() => expect(container.textContent).toContain("Ended out of balance"));
    expect(container.textContent).toContain("Resume it once the balance is topped up");
    expect(container.querySelector(".status-badge, .badge")?.textContent).toContain("out of balance");
    expect(byText(container, ".page-header button", "Resume")).toBeTruthy();
    expect(byText(container, ".page-header button", "Cancel")).toBeUndefined();
    expect(container.querySelector(".led")).toBeNull();
  });

  it("renders the newest 100 events and pages older ones in on demand", async () => {
    const events = Array.from({ length: 250 }, (_, i) => `event: warning\ndata: ${JSON.stringify({ seq: i + 1, attempt: 1, timestamp: "2026-11-27T13:00:00Z", step: i, message: `note ${i}` })}\nid: ${i + 1}\n\n`).join("");
    const { container } = await boot(fakeServer(routes({ [`GET /v1/runs/${RUN_ID}/events`]: () => sse(events) })), `/runs/${RUN_ID}`);
    await waitFor(() => expect(container.querySelectorAll(".timeline li").length).toBe(101));
    expect(container.querySelector(".timeline li .t-detail")?.textContent).toBe("note 249");
    await click(byText(container, ".timeline button", "Show 150 older of 150"));
    await waitFor(() => expect(container.querySelectorAll(".timeline li").length).toBe(250));
  });

  it("shows connecting, not live, while the event stream is down", async () => {
    const { container } = await boot(fakeServer(routes({ "GET /v1/runs/run_q1/events": () => problem(503, "unavailable") })), "/runs/run_q1");
    await waitFor(() => expect(container.querySelector(".led")?.textContent).toBe("connecting"));
    expect(container.querySelector(".led")?.className).toContain("connecting");
  });

  it("pages through a run's checkpoints", async () => {
    const page1 = fixture<{ data: Record<string, unknown>[] }>("checkpoints.json");
    const old = { ...page1.data[0], id: "ckpt_old", step: 1, best: false, final: false };
    const server = fakeServer(
      routes({ [`GET /v1/runs/${RUN_ID}/checkpoints`]: ({ url }: { url: URL }) => (url.searchParams.get("cursor") === "k2" ? json({ data: [old], next_cursor: null }) : json({ ...page1, next_cursor: "k2" })) }),
    );
    const { container } = await boot(server, `/runs/${RUN_ID}`);
    await waitFor(() => expect(byText(container, "button", "Older checkpoints")).toBeTruthy());
    expect(byText(container, ".card-title", "Checkpoints")?.textContent).toContain("+");
    const before = byText(container, ".card", "Checkpoints")?.querySelectorAll("tbody tr").length ?? 0;
    await click(byText(container, "button", "Older checkpoints"));
    await waitFor(() => expect(byText(container, ".card", "Checkpoints")?.querySelectorAll("tbody tr").length).toBe(before + 1));
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
    const opener = byText(container, "button", "Promote") as HTMLButtonElement;
    opener.focus();
    await click(opener);
    // The field has focus and keeps it while typing: each keystroke re-renders the page.
    const field = container.querySelector<HTMLInputElement>("#promote-name");
    expect(document.activeElement).toBe(field);
    for (const value of ["m", "my", "my-"]) {
      await type(field, value);
      expect(document.activeElement).toBe(field);
    }
    await type(field, "my-model");
    await click(byText(container, ".dialog button", "Promote"));
    await waitFor(() => expect(container.textContent).toContain("Promoted to my-model@2026-11-27-2"));
    expect(promoted[0]).toMatch(/^\/v1\/checkpoints\/ckpt_\w+\/promote \{"name":"my-model"\}$/);
  });

  it("traps Tab in a destructive dialog, focuses Cancel first, and returns focus to its opener", async () => {
    const { container } = await boot(fakeServer(routes({ "GET /v1/runs/run_q1/events": () => sse("") })), "/runs/run_q1");
    await waitFor(() => expect(byText(container, ".page-header button", "Cancel")).toBeTruthy());
    const opener = byText(container, ".page-header button", "Cancel") as HTMLButtonElement;
    opener.focus();
    await click(opener);
    const buttons = [...container.querySelectorAll<HTMLButtonElement>(".dialog button")];
    expect(document.activeElement?.textContent).toBe("Cancel");
    buttons.at(-1)?.focus();
    await act(async () => {
      dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
    });
    expect(document.activeElement).toBe(buttons[0]);
    await act(async () => {
      dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(container.querySelector(".dialog")).toBeNull();
    expect(document.activeElement).toBe(opener);
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
    // The server filters imports by dataset: another dataset's import never shows.
    expect(text).not.toContain("999 imported");
    expect(server.calls.some((c) => c.path.startsWith("/v1/imports?") && c.path.includes("dataset=support"))).toBe(true);
    expect(container.querySelector("select#version")).toBeTruthy();
    await click(byText(container, "button", "Sync"));
    await click(byText(container, ".dialog button", "Sync"));
    await waitFor(() => expect(posted).toEqual(["sync"]));
    await waitFor(() => expect(container.textContent).toContain("Sync queued: imp_2"));
  });

  it("picks among thousands of versions with a number field, not thousands of options", async () => {
    const many = { ...DATASET, version: 8760 };
    const { container } = await boot(fakeServer(routes({ "GET /v1/datasets/support": many })), "/datasets/support");
    await waitFor(() => expect(container.querySelector("input#version")).toBeTruthy());
    expect(container.querySelectorAll("option").length).toBe(0);
    await type(container.querySelector("input#version"), "12");
    await waitFor(() => expect(location.search).toBe("?version=12"));
    await type(container.querySelector("input#version"), "99999");
    expect(location.search).toBe("?version=12");
  });

  it("clamps a long record message and expands it in place", async () => {
    const long = `${"word ".repeat(600)}END`;
    const records = { data: [{ id: "rec_long", messages: [{ role: "user", content: long }] }], next_cursor: null };
    const { container } = await boot(fakeServer(routes({ "GET /v1/datasets/support/records": records })), "/datasets/support");
    await waitFor(() => expect(byText(container, ".msg button", "Show all 3,003 characters")).toBeTruthy());
    expect(container.querySelector(".msg .content")?.textContent).toHaveLength(1_001);
    await click(byText(container, ".msg button", "Show all"));
    expect(container.querySelector(".msg .content")?.textContent).toContain("END");
    expect(byText(container, ".msg button", "Show less")?.getAttribute("aria-expanded")).toBe("true");
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

  it("shows pools and the queue on the health page from in-flight jobs only", async () => {
    const { container, server } = await boot(undefined, "/health");
    await waitFor(() => expect(container.textContent).toContain("scaling up"));
    // Small, status-filtered pages: never a walk over every finished job.
    const lists = server.calls.filter((c) => /^\/v1\/(runs|imports|evals)\?/.test(c.path)).map((c) => c.path);
    expect(lists.length).toBeGreaterThan(0);
    expect(lists.filter((p) => p !== "/v1/runs?limit=1").every((p) => p.includes("status=") && !p.includes("cursor="))).toBe(true);
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

describe("artifacts", () => {
  const TRAINED = fixture<Record<string, unknown>>("artifact.json");
  const UPLOADED = {
    ...TRAINED,
    id: "sql-lora@2026-11-28-1",
    name: "sql-lora",
    version: "2026-11-28-1",
    run_id: null,
    format: "peft_lora",
    size_bytes: 84_000_000,
    provenance: { source: "upload", run_id: null, uploader: "key_admin", uri: null },
    pins: [{ artifact_id: "sql-lora@2026-11-28-1", holder: "inference:version:7b1c", reason: "acme/sql v3", created_at: "2026-11-28T01:00:00Z" }],
  };
  const IMPORTED = {
    ...TRAINED,
    id: "hub-lora@2026-11-28-1",
    name: "hub-lora",
    version: "2026-11-28-1",
    run_id: null,
    format: "peft_lora",
    provenance: { source: "import", run_id: null, uploader: null, uri: `hf://acme/hub-lora@${"a".repeat(40)}` },
  };
  const artifactRoutes = (extra: Record<string, unknown> = {}) =>
    routes({
      "GET /v1/artifacts": listed([UPLOADED, IMPORTED, TRAINED]),
      "GET /v1/artifacts/:id": ({ url }: { url: URL }) => json([UPLOADED, IMPORTED, TRAINED].find((a) => url.pathname.endsWith(`/${encodeURIComponent(String(a.id))}`)) ?? TRAINED),
      ...extra,
    });

  it("lists name@version, format, base model, provenance, size, created and pins; the server filters by name", async () => {
    const { container } = await boot(fakeServer(artifactRoutes()), "/runs");
    await waitFor(() => expect(byText(container, ".nav-item", "Artifacts")).toBeTruthy());
    await click(byText(container, ".nav-item", "Artifacts"));
    await waitFor(() => expect(container.querySelectorAll("tbody tr.clickable").length).toBe(3));
    const row = (name: string) => byText(container, "tbody tr", name)?.textContent ?? "";
    expect(row("sql-lora@2026-11-28-1")).toMatch(/peft_lora.*test\/tiny-qwen3.*upload.*key_admin.*80\.1 MB.*pinned/);
    expect(row("hub-lora@")).toContain(`hf://acme/hub-lora@${"a".repeat(40)}`);
    expect(row("support-sft@")).toContain(String(TRAINED.run_id));
    // The run link opens the run, not the artifact.
    await click(byText(container, "tbody tr a", String(TRAINED.run_id)));
    expect(location.pathname).toBe(`/runs/${String(TRAINED.run_id)}`);
    navigate("/artifacts");
    await waitFor(() => expect(container.querySelectorAll("tbody tr.clickable").length).toBe(3));
    await type(container.querySelector('input[aria-label="Filter artifacts"]'), "hub");
    await waitFor(() => expect(container.querySelectorAll("tbody tr.clickable").length).toBe(1));
    await type(container.querySelector('input[aria-label="Filter artifacts"]'), "nothing-matches");
    await waitFor(() => expect(container.textContent).toContain("No artifacts match"));
  });

  it("shows an empty state", async () => {
    const { container } = await boot(fakeServer(artifactRoutes({ "GET /v1/artifacts": { data: [], next_cursor: null } })), "/artifacts");
    await waitFor(() => expect(container.textContent).toContain("No artifacts yet"));
  });

  it("opens an artifact with its manifest, provenance and pins, and downloads it through a presigned URL", async () => {
    const opened: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (this: HTMLAnchorElement) {
      opened.push(this.href);
    });
    const server = fakeServer(
      artifactRoutes({
        "GET /v1/artifacts/:id/download-url": { url: "https://bucket.s3.example/artifacts/b?X-Amz-Signature=sig", expires_at: "2026-11-28T02:00:00Z", sha256: "ab".repeat(32), size_bytes: 84_000_000, filename: "sql-lora-2026-11-28-1.grad.tar.gz" },
      }),
    );
    const { container } = await boot(server, "/artifacts");
    await waitFor(() => expect(byText(container, "tbody tr", "sql-lora@")).toBeTruthy());
    await click(byText(container, "tbody tr", "sql-lora@"));
    await waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("sql-lora@2026-11-28-1"));
    expect(location.pathname).toBe("/artifacts/sql-lora%402026-11-28-1");
    const text = container.textContent ?? "";
    expect(text).toContain("inference:version:7b1c");
    expect(text).toContain("acme/sql v3");
    expect(text).toContain("key_admin");
    expect(container.querySelector("pre.code")?.textContent).toContain('"schema": "grad.artifact/1"');
    expect(text).toContain("grad artifacts download sql-lora@2026-11-28-1 --output ./sql-lora");
    await click(byText(container, ".page-header button", "Download"));
    await waitFor(() => expect(opened).toEqual(["https://bucket.s3.example/artifacts/b?X-Amz-Signature=sig"]));
    expect(server.calls.some((c) => c.path === "/v1/artifacts/sql-lora%402026-11-28-1/download-url")).toBe(true);
  });

  it("deletes after confirmation; a pinned artifact shows the server's 409 naming its holders", async () => {
    const deleted: string[] = [];
    const server = fakeServer(
      artifactRoutes({
        "DELETE /v1/artifacts/:id": ({ url }: { url: URL }) => {
          if (url.pathname.includes("sql-lora")) return problem(409, "artifact_pinned", "Artifact 'sql-lora@2026-11-28-1' is pinned by inference:version:7b1c (acme/sql v3), so it can't be deleted. Unpublish it there first (that removes the pin).");
          deleted.push(url.pathname);
          return new Response(null, { status: 204 });
        },
      }),
    );
    const { container } = await boot(server, "/artifacts/sql-lora%402026-11-28-1");
    await waitFor(() => expect(byText(container, ".page-header button", "Delete")).toBeTruthy());
    await click(byText(container, ".page-header button", "Delete"));
    expect(container.querySelector(".dialog")?.textContent).toContain("It is pinned by inference:version:7b1c");
    await click(byText(container, ".dialog button", "Delete"));
    await waitFor(() => expect(container.querySelector(".dialog")?.textContent).toContain("is pinned by inference:version:7b1c (acme/sql v3), so it can't be deleted"));
    expect(location.pathname).toBe("/artifacts/sql-lora%402026-11-28-1");
    await click(byText(container, ".dialog button", "Cancel"));
    expect(container.querySelector(".dialog")).toBeNull();

    navigate(`/artifacts/${encodeURIComponent(String(IMPORTED.id))}`);
    await waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("hub-lora@2026-11-28-1"));
    expect(container.textContent).toContain("Not pinned");
    await click(byText(container, ".page-header button", "Delete"));
    await click(byText(container, ".dialog button", "Delete"));
    await waitFor(() => expect(location.pathname).toBe("/artifacts"));
    expect(deleted).toEqual(["/v1/artifacts/hub-lora%402026-11-28-1"]);
    await waitFor(() => expect(container.textContent).toContain("Deleted hub-lora@2026-11-28-1"));
  });

  it("shows the API error for a missing artifact and a failed download", async () => {
    const { container } = await boot(
      fakeServer(
        artifactRoutes({
          "GET /v1/artifacts/:id/download-url": () => problem(503, "storage_unavailable", "Object storage is unreachable."),
          "GET /v1/artifacts/:id": ({ url }: { url: URL }) => (url.pathname.includes("missing") ? problem(404, "artifact_not_found", "No artifact missing@1.") : json(TRAINED)),
        }),
      ),
      "/artifacts/missing%401",
    );
    await waitFor(() => expect(container.textContent).toContain("No artifact missing@1."));
    navigate(`/artifacts/${encodeURIComponent(String(TRAINED.id))}`);
    await waitFor(() => expect(byText(container, ".page-header button", "Download")).toBeTruthy());
    await click(byText(container, ".page-header button", "Download"));
    await waitFor(() => expect(container.textContent).toContain("Object storage is unreachable."));
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
