import { describe, expect, it } from "vitest";

import type { EvalReport, MetricPoint, Run } from "@sdk/generated/models.js";

import { CODEC, convertKeys, isTerminalRun } from "../src/lib/api.js";
import { maskKey, sessionKeyStore, takeFragmentKey } from "../src/lib/auth.js";
import { nearestAt, smooth } from "../src/components/chart.js";
import { compareHref, configRows, flatten, labelsOf, lastOf, MAX_COMPARE, metricByKey, metricsOf, overlay, parseIds, runStyle } from "../src/lib/compare.js";
import { applyEvents, decodeEvent, emptyStream, foldCheckpoints, type RunEvent, type TimelineItem } from "../src/lib/events.js";
import { ago, bytes, compact, dateTime, duration, int, num, pct, plural, toYaml, usd } from "../src/lib/format.js";
import { guardLocale } from "../src/lib/locale.js";
import { renderReport } from "../src/lib/report.js";
import { match } from "../src/lib/router.js";
import { savedTheme } from "../src/lib/theme.js";
import { passLabel } from "../src/pages/evals.js";
import { importPool, poolState, trainPool } from "../src/pages/health.js";
import { countOf } from "../src/pages/runs.js";
import { defaultPeriod, presets } from "../src/pages/usage.js";
import { fixture, fixtureText } from "./helpers.js";

const run = (over: Record<string, unknown> = {}): Run => convertKeys(CODEC, "Run", { ...fixture<Record<string, unknown>>("run.json"), ...over }, "decode") as Run;

describe("auth", () => {
  it("takes a one-time #key= fragment into sessionStorage and strips it from the URL", () => {
    sessionStorage.clear();
    history.replaceState(null, "", "/runs/run_1?x=1#key=grad_secret_abc&tab=events");
    const store = sessionKeyStore();
    expect(takeFragmentKey(store)).toBe(true);
    expect(store.get()).toBe("grad_secret_abc");
    expect(sessionStorage.getItem("grad.api_key")).toBe("grad_secret_abc");
    expect(localStorage.length).toBe(0);
    expect(location.href).not.toContain("grad_secret_abc");
    expect(location.pathname + location.search + location.hash).toBe("/runs/run_1?x=1#tab=events");
    expect(takeFragmentKey(store)).toBe(false);
    history.replaceState(null, "", "/#key=");
    expect(takeFragmentKey(store)).toBe(false);
    // A link carrying another key never replaces the signed-in one (it is still stripped).
    history.replaceState(null, "", "/runs#key=grad_attacker_key");
    expect(takeFragmentKey(store)).toBe(false);
    expect(store.get()).toBe("grad_secret_abc");
    expect(location.href).not.toContain("grad_attacker_key");
    store.clear();
    expect(store.get()).toBeUndefined();
  });

  it("falls back to memory when storage throws, and masks keys", () => {
    const broken = { getItem: () => { throw new Error("denied"); }, setItem: () => { throw new Error("denied"); }, removeItem: () => { throw new Error("denied"); } } as unknown as Storage;
    const store = sessionKeyStore(broken);
    store.set("grad_k");
    expect(store.get()).toBe("grad_k");
    store.clear();
    expect(store.get()).toBeUndefined();
    expect(maskKey("grad_abcdefghijklmnop")).toBe("grad_abcd…mnop");
    expect(maskKey("short")).toBe("•••••");
  });
});

describe("format", () => {
  it("formats money, numbers, sizes and durations", () => {
    expect(plural(1, "step")).toBe("1 step");
    expect(dateTime("2026-11-28T23:30:05Z", { utc: true })).toBe("Nov 28, 23:30:05 UTC");
    expect(dateTime("2026-11-28T23:30:05Z")).toMatch(/^Nov (28|29), \d\d:30:05 (UTC|GMT[+-]?\d*|[A-Z]{2,5})$/);
    expect(plural(1000, "step")).toBe("1,000 steps");
    expect(usd(0)).toBe("$0.00");
    expect(usd(0.0034)).toBe("$0.0034");
    expect(usd(1234.5)).toBe("$1,234.50");
    expect(usd(null)).toBe("—");
    expect(int(12345)).toBe("12,345");
    expect(int(undefined)).toBe("—");
    expect(compact(950)).toBe("950");
    expect(compact(4_040_070)).toBe("4M");
    expect(compact(12_345)).toBe("12.3K");
    expect(compact(2.5e9)).toBe("2.5B");
    expect(compact(null)).toBe("—");
    expect(num(0.68954686)).toBe("0.6895");
    expect(num(0.0003333)).toBe("3.33e-4");
    expect(num(0)).toBe("0");
    expect(num(Number.NaN)).toBe("—");
    expect(pct(0.1234)).toBe("12.3%");
    expect(bytes(2788)).toBe("2.7 KB");
    expect(bytes(512)).toBe("512 B");
    expect(bytes(3 * 1024 ** 3)).toBe("3.0 GB");
    expect(duration(4_000)).toBe("4s");
    expect(duration(200_000)).toBe("3m 20s");
    expect(duration(2 * 3_600_000 + 5 * 60_000)).toBe("2h 5m");
    expect(duration(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
    expect(duration(-1)).toBe("—");
  });

  it("formats relative times", () => {
    const now = Date.parse("2026-11-27T12:00:00Z");
    expect(ago("2026-11-27T11:59:50Z", now)).toBe("just now");
    expect(ago("2026-11-27T11:55:00Z", now)).toBe("5m ago");
    expect(ago("2026-11-27T09:00:00Z", now)).toBe("3h ago");
    expect(ago("2026-11-25T12:00:00Z", now)).toBe("2d ago");
    expect(ago("2026-11-01T12:00:00Z", now)).toBe("Nov 1");
    expect(ago("2026-11-27T12:05:00Z", now)).toBe("in 5m");
    expect(ago(null, now)).toBe("—");
    expect(ago("garbage", now)).toBe("—");
  });

  it("emits readable YAML", () => {
    expect(toYaml({ lr: 0.001, model: "test/tiny-qwen3", adapter: { kind: "lora", rank: 32 }, betas: [0.9, 0.95], empty: {}, none: null, quoted: "yes", spaced: "a: b", params: { "my key": 1 }, list: [{ a: 1 }] })).toBe(
      [
        "lr: 0.001",
        "model: test/tiny-qwen3",
        "adapter:",
        "  kind: lora",
        "  rank: 32",
        "betas:",
        "- 0.9",
        "- 0.95",
        "empty: {}",
        "none: null",
        'quoted: "yes"',
        'spaced: "a: b"',
        "params:",
        '  "my key": 1',
        "list:",
        "- a: 1",
      ].join("\n"),
    );
    expect(toYaml([])).toBe("[]");
    expect(toYaml("plain")).toBe("plain");
  });
});

describe("router", () => {
  it("matches patterns and decodes params", () => {
    expect(match("/runs/:id", "/runs/run_1")).toEqual({ id: "run_1" });
    expect(match("/datasets/:name", "/datasets/a%2Fb")).toEqual({ name: "a/b" });
    expect(match("/runs/:id", "/runs")).toBeNull();
    expect(match("/runs/:id", "/evals/x")).toBeNull();
    expect(match("/runs/:id", "/runs/%E0%A4%A")).toBeNull();
  });
});

describe("run status", () => {
  it("treats every stopped status as terminal", () => {
    for (const status of ["completed", "failed", "cancelled", "stopped_budget", "stopped_balance"]) expect(isTerminalRun({ status } as Run)).toBe(true);
    for (const status of ["queued", "running"]) expect(isTerminalRun({ status } as Run)).toBe(false);
  });
});

const sseEvents = (text: string): { event: string; data: string }[] =>
  text
    .split("\n\n")
    .filter((b) => b.trim())
    .map((block) => {
      const lines = block.split("\n");
      return { event: lines.find((l) => l.startsWith("event: "))?.slice(7) ?? "message", data: lines.filter((l) => l.startsWith("data: ")).map((l) => l.slice(6)).join("\n") };
    });

describe("run events", () => {
  it("decodes the metrics stream (metric + status) into series and a completion", () => {
    const events = sseEvents(fixtureText("metrics.sse")).map((e) => decodeEvent(e.event, e.data)).filter((e): e is RunEvent => e !== null);
    expect(events.map((e) => e.type)).toEqual(["metric", "metric", "metric", "completed"]);
    const state = applyEvents(emptyStream(), events);
    expect(state.series.step).toEqual([1, 2, 3]);
    expect(state.series.evalLoss.every((v) => typeof v === "number")).toBe(true);
    expect(state.series.lr[0]).toBe(0.001);
    expect(state.final?.status).toBe("completed");
    expect(state.timeline.at(-1)).toMatchObject({ kind: "completed", title: "Completed" });
    expect(state.lastSeq).toBe(3);
    expect(applyEvents(state, [])).toBe(state);
  });

  it("decodes /events shapes and builds a calm timeline", () => {
    const base = { run_id: "run_1", timestamp: "2026-11-27T12:00:00Z" };
    const wire: [string, Record<string, unknown>][] = [
      ["phase", { ...base, seq: 1, attempt: 1, phase: "queued", step: 0, workers_online: null, autoscaling: null, queue_position: 4, message: "Queued behind 4 runs", gpu: null }],
      ["phase", { ...base, seq: 2, attempt: 1, phase: "waiting_for_compute", step: 0, workers_online: 2, autoscaling: false, gpu: null }],
      ["attempt", { ...base, seq: 3, attempt: 1, event: "started", reason: null, step: null, resume_step: null, max_attempts: 3, message: "" }],
      ["phase", { ...base, seq: 4, attempt: 1, phase: "starting", step: 0, workers_online: null, autoscaling: null, gpu: { name: "H100", memory_gb: 80 } }],
      ["phase", { ...base, seq: 5, attempt: 1, phase: "training", step: 0 }],
      ["metric", { ...base, seq: 6, attempt: 1, step: 10, metric: { seq: 6, attempt: 1, step: 10, loss: 2, tokens: 100, cost_usd: 0.1, timestamp: base.timestamp, eval_loss: 2.1 } }],
      ["phase", { ...base, seq: 7, attempt: 1, phase: "evaluating", step: 10 }],
      ["checkpoint", { ...base, seq: 8, attempt: 1, step: 10, checkpoint_id: "ckpt_1", eval_score: 2.1, format: "peft_lora" }],
      ["phase", { ...base, seq: 9, attempt: 1, phase: "training", step: 10 }],
      ["metric", { ...base, seq: 10, attempt: 1, step: 20, metric: { seq: 10, attempt: 1, step: 20, loss: 1.5, tokens: 200, cost_usd: 0.2, timestamp: base.timestamp } }],
      ["attempt", { ...base, seq: 11, attempt: 1, event: "interrupted", reason: "preempted", step: 20, resume_step: 10, max_attempts: 3, message: "attempt 1 interrupted at step 20 (preempted); resuming from step 10" }],
      ["attempt", { ...base, seq: 12, attempt: 2, event: "started", reason: null, step: null, resume_step: 10, max_attempts: 3, message: "" }],
      ["phase", { ...base, seq: 13, attempt: 2, phase: "training", step: 10 }],
      ["metric", { ...base, seq: 14, attempt: 2, step: 15, metric: { seq: 14, attempt: 2, step: 15, loss: 1.6, tokens: 250, cost_usd: 0.25, timestamp: base.timestamp } }],
      ["warning", { ...base, seq: 15, attempt: 2, step: null, message: "truncated 3 records" }],
      ["log", { ...base, seq: 16, attempt: 2, step: 15, message: "hello" }],
      ["attempt", { ...base, seq: 17, attempt: 2, event: "gave_up", reason: "oom", step: 15, resume_step: null, max_attempts: 3, message: "no attempts left" }],
      ["completed", { ...base, seq: 17, attempt: 2, status: "failed", run: { ...fixture<Record<string, unknown>>("run.json"), status: "failed", error: "out of memory" } }],
      ["mystery", { ...base, seq: 18 }],
    ];
    const events = wire.map(([n, d]) => decodeEvent(n, JSON.stringify(d)));
    expect(events.at(-1)).toBeNull();
    expect(decodeEvent("metric", "{not json")).toBeNull();
    expect(decodeEvent("metric", "null")).toBeNull();
    const state = applyEvents(emptyStream(), events.filter((e): e is RunEvent => e !== null));
    // The resumed attempt replays from step 10, so step 20 is dropped: x stays monotonic.
    expect(state.series.step).toEqual([10, 15]);
    expect(state.series.evalLoss).toEqual([2.1, null]);
    expect(state.gpu).toEqual({ name: "H100", memoryGb: 80 });
    expect(state.phase?.phase).toBe("training");
    expect(state.final?.status).toBe("failed");
    // The phase clock keeps training's start across evals and checkpoints.
    const at = (s: number) => ({ ...base, timestamp: `2026-11-27T12:00:${String(s).padStart(2, "0")}Z` });
    const clock = applyEvents(emptyStream(), [
      ["phase", { ...at(1), seq: 1, attempt: 1, phase: "training", step: 0 }],
      ["phase", { ...at(30), seq: 2, attempt: 1, phase: "evaluating", step: 10 }],
      ["phase", { ...at(40), seq: 3, attempt: 1, phase: "training", step: 10 }],
    ].map(([n, d]) => decodeEvent(n as string, JSON.stringify(d))).filter((e): e is RunEvent => e !== null));
    expect(clock.phase).toMatchObject({ phase: "training", since: "2026-11-27T12:00:01Z" });
    expect(state.timeline.map((t) => t.title)).toEqual([
      "Queued",
      "Waiting for compute",
      "Attempt 1 started",
      "Starting",
      "Training",
      "Checkpoint at step 10",
      "Attempt 1 interrupted (compute reclaimed)",
      "Attempt 2 resumed from step 10",
      "Training",
      "Warning",
      "Log",
      "Gave up",
      "Failed",
    ]);
    expect(state.timeline[0]?.detail).toBe("Queued behind 4 runs");
    expect(state.timeline[1]?.detail).toBe("2 workers online, all busy");
    expect(state.timeline[3]?.detail).toBe("H100 · 80 GB");
    expect(state.timeline[8]?.detail).toBe("from step 10");
    expect(state.timeline.at(-1)?.detail).toBe("out of memory");
    const autoscale = decodeEvent("phase", JSON.stringify({ ...base, seq: 1, attempt: 1, phase: "waiting_for_compute", step: 0, workers_online: 0, autoscaling: true }));
    expect(applyEvents(emptyStream(), [autoscale as RunEvent]).timeline[0]?.detail).toMatch(/autoscaling/);
  });
});

describe("eval reports", () => {
  const report = (over: Partial<EvalReport>): EvalReport => ({ metricName: "eval_loss", selectedStep: 3, bestStep: 3, finalStep: 3, trainRecords: 10, evalRecords: 2, warnings: [], ...over });

  it("renders the headline fields of each recipe", () => {
    expect(renderReport("sft", report({ evalLoss: 0.69, evalTokenAccuracy: 0.5 })).headline).toEqual([
      { label: "Eval loss", value: "0.69" },
      { label: "Token accuracy", value: "50.0%" },
    ]);
    const emb = renderReport("embedding", report({ recallAt1: 0.5, mrr: 0.6, baseline: { recallAt1: 0.4, recallAt5: null, recallAt10: null, mrr: 0.5 } }));
    expect(emb.headline).toEqual([
      { label: "Recall@1", value: "50.0%", hint: "base 40.0%" },
      { label: "MRR", value: "0.6", hint: "base 0.5" },
    ]);
    const router = renderReport("router", report({ fallbackModel: "big", routesAnyTraffic: true, paretoSummary: { targetMaxDrop: 0.02, routedQuality: 0.9, qualityDrop: 0.01, qualityDropCi95: null, offloadRate: 0.4, costSavingsPct: 35, ece: null, threshold: 0.5, temperature: 1 } }));
    expect(router.headline.map((r) => r.value)).toEqual(["big", "yes"]);
    expect(router.pareto.map((r) => r.value)).toEqual(["40.0%", "35%", "0.9", "0.01 (target ≤ 0.02)"]);
    const decision = renderReport("decision", report({ heads: { intent: { type: "choice", examples: 4, accuracy: 0.75, ece: null, temperature: 1, macroF1: 0.7 }, missing: null } }));
    expect(decision.heads).toEqual([
      { name: "intent", macroF1: 0.7, accuracy: 0.75 },
      { name: "missing", macroF1: null, accuracy: null },
    ]);
    expect(renderReport("grpo", report({ warnings: ["w"] })).warnings).toEqual(["w"]);
    expect(renderReport("dpo", report({ routesAnyTraffic: false, preferenceAccuracy: 0.8 })).details.find((d) => d.label === "Selection metric")?.value).toBe("eval_loss");
  });
});

describe("health and usage summaries", () => {
  const now = Date.parse("2026-11-27T14:00:00Z");
  it("derives pool state from queued runs and imports", () => {
    const queued = run({ status: "queued", created_at: "2026-11-27T13:50:00Z", workers_online: 1, autoscaling: false });
    const running = run({ status: "running" });
    const p = trainPool([queued, running, run()], now);
    expect(p).toMatchObject({ running: 1, queued: 1, online: 1, autoscaling: false, oldestQueuedMs: 600_000 });
    expect(poolState(p)).toEqual({ label: "backlog", tone: "amber" });
    expect(poolState(trainPool([run({ status: "queued", autoscaling: true })], now)).label).toBe("scaling up");
    expect(poolState(trainPool([run({ status: "queued" })], now)).label).toBe("no workers");
    expect(poolState(trainPool([running], now)).label).toBe("busy");
    expect(poolState(trainPool([], now))).toEqual({ label: "idle", tone: "green" });
    const imp = importPool([{ status: "queued", createdAt: "2026-11-27T13:59:00Z" }, { status: "running", createdAt: "x" }] as never, now);
    expect(imp).toMatchObject({ queued: 1, running: 1, oldestQueuedMs: 60_000 });
  });

  it("picks UTC usage periods as inclusive dates", () => {
    expect(defaultPeriod(Date.parse("2026-11-27T14:00:00Z"))).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(defaultPeriod(Date.parse("2024-02-10T00:00:00Z"))).toEqual({ from: "2024-02-01", to: "2024-02-29" });
    // 23:30 UTC on 31 December is still December, whatever the local zone.
    const p = presets(Date.parse("2026-12-31T23:30:00Z"));
    expect(p.month).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(p["last-month"]).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(p["7d"]).toEqual({ from: "2026-12-25", to: "2026-12-31" });
    expect(presets(Date.parse("2027-01-15T00:00:00Z"))["last-month"]).toEqual({ from: "2026-12-01", to: "2026-12-31" });
    expect(p["30d"].from).toBe("2026-12-02");
  });
});

describe("presentation helpers", () => {
  const item = (kind: TimelineItem["kind"], step: number): TimelineItem => ({ key: `${kind}:${step}`, kind, timestamp: `2026-11-27T13:00:${String(step).padStart(2, "0")}Z`, title: `${kind} ${step}`, step });

  it("folds three or more consecutive checkpoints into one timeline row", () => {
    const folded = foldCheckpoints([item("phase", 1), item("checkpoint", 2), item("checkpoint", 3), item("checkpoint", 4), item("warning", 5), item("checkpoint", 6), item("checkpoint", 7)]);
    expect(folded.map((t) => t.title)).toEqual(["phase 1", "3 checkpoints", "warning 5", "checkpoint 6", "checkpoint 7"]);
    expect(folded[1]).toMatchObject({ kind: "checkpoint", detail: "steps 2 to 4", step: 4, timestamp: "2026-11-27T13:00:04Z" });
    // Newest first, as the run page lists them.
    expect(foldCheckpoints([item("checkpoint", 9), item("checkpoint", 8), item("checkpoint", 7)])[0]).toMatchObject({ detail: "steps 7 to 9", timestamp: "2026-11-27T13:00:09Z" });
  });

  it("marks how a run ended in its timeline", () => {
    const ended = (status: Run["status"]) => applyEvents(emptyStream(), [{ type: "completed", status, run: run({ status, error: status === "failed" ? "boom" : null }), seq: 0, attempt: 1, timestamp: "2026-11-27T13:00:00Z" }]).timeline.at(-1);
    expect(ended("failed")).toMatchObject({ kind: "failure", title: "Failed", detail: "boom" });
    expect(ended("stopped_budget")).toMatchObject({ kind: "warning", title: "Stopped at the cost cap" });
    expect(ended("cancelled")).toMatchObject({ kind: "log", title: "Cancelled" });
  });

  it("grows metric columns in place, bumps rev, and is idempotent when React applies a batch twice", () => {
    const metric = (step: number): RunEvent => ({ type: "metric", seq: step, attempt: 1, timestamp: "", step, metric: { step, loss: step / 10, lr: 1e-4, costUsd: step, tokensPerSec: 1 } as never });
    const start = applyEvents(emptyStream(), [metric(1), metric(2)]);
    const batch = [metric(3), metric(4)];
    const once = applyEvents(start, batch);
    const twice = applyEvents(start, batch); // StrictMode runs the updater again on the same state
    expect(twice.series.step).toEqual([1, 2, 3, 4]);
    expect(twice.series.loss).toEqual([0.1, 0.2, 0.3, 0.4]);
    expect(once.series.step).toBe(start.series.step);
    expect(once.series.rev).toBe(start.series.rev + 1);
    // A batch without metrics keeps the same columns object.
    expect(applyEvents(once, [{ type: "log", seq: 9, attempt: 1, timestamp: "", step: null, message: "m" }]).series).toBe(once.series);
  });

  it("replays a million metric points in linear time", () => {
    let s = emptyStream();
    const t0 = performance.now();
    for (let i = 0; i < 1_000_000; i += 4000) {
      s = applyEvents(
        s,
        Array.from({ length: 4000 }, (_, j): RunEvent => ({ type: "metric", seq: i + j + 1, attempt: 1, timestamp: "", step: i + j + 1, metric: { step: i + j + 1, loss: 1, costUsd: 0 } as never })),
      );
    }
    expect(s.series.step.length).toBe(1_000_000);
    // Copying every column per batch took ~17 s here; in place it is well under 5.
    expect(performance.now() - t0).toBeLessThan(5_000);
  });

  it("smooths a series with a debiased moving average", () => {
    const out = smooth([1, null, 1, 3], 0.5);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeNull();
    expect(out[2]).toBeCloseTo(1);
    expect(out[3]).toBeCloseTo(1 + 2 * (0.5 / 0.875));
  });

  it("labels pass@k columns from either key form", () => {
    expect(passLabel("1")).toBe("pass@1");
    expect(passLabel("pass@4")).toBe("pass@4");
  });

  it("defaults to the dark theme when storage is empty or unavailable", () => {
    localStorage.removeItem("grad-theme");
    expect(savedTheme()).toBe("dark");
    localStorage.setItem("grad-theme", "light");
    expect(savedTheme()).toBe("light");
    localStorage.removeItem("grad-theme");
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = () => {
      throw new Error("denied");
    };
    try {
      expect(savedTheme()).toBe("dark");
    } finally {
      Storage.prototype.getItem = get;
    }
  });
});

describe("locale guard", () => {
  it("swaps a locale Intl rejects (Chromium's en-US@posix) for en-US, so uPlot's import can't blank the UI", () => {
    const posix = { language: "en-US@posix" };
    expect(() => new Intl.NumberFormat(posix.language)).toThrow(RangeError);
    guardLocale(posix);
    expect(posix.language).toBe("en-US");
    const german = { language: "de-DE" };
    guardLocale(german);
    expect(german.language).toBe("de-DE");
  });

  it("runs before anything imports uPlot", async () => {
    const { readFileSync } = await import("node:fs");
    const main = readFileSync(`${import.meta.dirname}/../src/main.tsx`, "utf8");
    expect(main.split("\n").find((l) => l.startsWith("import "))).toBe('import "./lib/locale.js";');
  });
});

describe("run comparison", () => {
  const point = (step: number, over: Partial<MetricPoint> = {}): MetricPoint => ({ seq: step, attempt: 1, step, loss: 1 / step, tokens: step, costUsd: step / 100, timestamp: "t", ...over }) as MetricPoint;

  it("reads ?ids= as distinct ids, at most ten, and writes it back", () => {
    expect(parseIds(" run_a,run_b,,run_a ")).toEqual(["run_a", "run_b"]);
    expect(parseIds(null)).toEqual([]);
    expect(parseIds(Array.from({ length: 14 }, (_, i) => `r${i}`).join(","))).toHaveLength(MAX_COMPARE);
    expect(compareHref(["run_a", "a/b"])).toBe("/runs/compare?ids=run_a,a%2Fb");
    // Five palette colours, then the same five dashed.
    expect([runStyle(0), runStyle(5)]).toEqual([
      { color: "--chart-1", dashed: false },
      { color: "--chart-1", dashed: true },
    ]);
  });

  it("offers the metrics some run logged, each eval metric after eval loss", () => {
    const a = [point(1, { lr: 0.1 }), point(2, { evalMetrics: { eval_loss: 0.5, accuracy: 0.7 } })];
    const b = [point(1, { evalMetrics: { bleu: 0.2 } })];
    expect(metricsOf([a, b]).map((m) => m.key)).toEqual(["loss", "eval_loss", "eval.accuracy", "eval.bleu", "lr", "cost_usd"]);
    expect(metricByKey("eval.accuracy").of(a[1] as MetricPoint)).toBe(0.7);
    expect(metricByKey("nope").key).toBe("loss");
    expect(lastOf(a, metricByKey("eval_loss"))).toBe(0.5);
    expect(lastOf(b, metricByKey("lr"))).toBeNull();
  });

  it("overlays runs logged at different steps on their union, smoothing each over its own points", () => {
    const loss = metricByKey("loss");
    const out = overlay(
      [
        { label: "a", points: [point(1), point(3)] },
        { label: "b", points: [point(2), point(3), point(4)] },
      ],
      loss,
      0,
    );
    expect(out.x).toEqual([1, 2, 3, 4]);
    expect(out.series.map((s) => s.values)).toEqual([
      [1, null, 1 / 3, null],
      [null, 1 / 2, 1 / 3, 1 / 4],
    ]);
    const smoothed = overlay([{ label: "a", points: [point(1, { loss: 1 }), point(2, { loss: 3 })] }], loss, 0.5);
    expect(smoothed.series[0]?.values).toEqual(smooth([1, 3], 0.5));
    // A sparse eval curve draws its points.
    expect(overlay([{ label: "a", points: [point(10, { evalLoss: 0.4 })] }], metricByKey("eval_loss"), 0).series[0]?.sparse).toBe(true);
  });

  it("reads a hovered step's nearest value only inside the series' range", () => {
    expect(nearestAt([1, null, null, 4, null], 1)).toBe(1);
    expect(nearestAt([1, null, null, 4, null], 2)).toBe(4);
    expect(nearestAt([1, null, null, 4, null], 4)).toBeNull();
  });

  it("names runs that share a name by id, and lists their settings with what differs", () => {
    const a = run({ id: "run_a", name: "sft" });
    const b = run({ id: "run_b", name: "sft", resolved_config: { ...(fixture<Record<string, unknown>>("run.json").resolved_config as object), lr: 0.5 } });
    expect(labelsOf([a, b])).toEqual(["sft (run_a)", "sft (run_b)"]);
    const rows = configRows([a, b]);
    expect(rows.filter((r) => r.differs).map((r) => r.key)).toEqual(["lr"]);
    expect(rows.find((r) => r.key === "name")).toBeUndefined();
    // Wire names, nested keys dotted.
    expect(rows.some((r) => r.key === "adapter.kind")).toBe(true);
    expect(flatten({ a: { b: 1 }, c: [1, 2], d: null })).toEqual([
      ["a.b", "1"],
      ["c", "[1,2]"],
      ["d", "—"],
    ]);
  });

  it("sums a status tab's counts", () => {
    const counts = { total: 9, byStatus: { queued: 1, running: 2, completed: 3, failed: 1, cancelled: 1, stoppedBudget: 1, stoppedBalance: 0 } };
    expect(countOf(counts, "all")).toBe(9);
    expect(countOf(counts, "active")).toBe(3);
    expect(countOf(counts, "stopped")).toBe(2);
    expect(countOf(undefined, "failed")).toBeUndefined();
  });
});
