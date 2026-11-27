import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  APIUserAbortError,
  Artifact,
  Checkpoint,
  ChecksumMismatchError,
  GradError,
  GradUsageError,
  NotFoundError,
  recipes,
  Run,
  RunFailedError,
  RunPlan,
  splits,
  WaitTimeoutError,
} from "../src/index.js";
import { FakeServer, json, makeGrad, problemFixture, wire } from "./helpers.js";

const completed = wire<Record<string, unknown> & { id: string; artifact_id: string }>("run-completed.json");
const queued = wire<Record<string, unknown> & { id: string }>("run-queued.json");
const RUN = `/v1/runs/${completed.id}`;
const artifactPath = `/v1/artifacts/${encodeURIComponent(completed.artifact_id)}`;
const withStatus = (status: string, extra: Record<string, unknown> = {}) => ({ ...completed, status, ...extra });
const scratch = () => mkdtempSync(path.join(process.env.TMPDIR ?? tmpdir(), "grad-runs-"));

describe("runs", () => {
  it("plans, creates and waits with chained .wait(), loading the artifact", async () => {
    const server = new FakeServer()
      .on("POST", "/v1/runs/plan", json(wire("plan-run.json")))
      .on("POST", "/v1/runs", json(queued, 202))
      .on("GET", RUN, json(withStatus("queued")), json(withStatus("running")), json(withStatus("running")), json(completed))
      .on("GET", artifactPath, json(wire("artifact.json")));
    const { grad, clock } = makeGrad(server);
    const dataset = { name: "support-prod" };
    const recipe = recipes.sft({ model: "test/tiny-qwen3", batchSize: 1, mergeOnExport: true });

    const plan = await grad.runs.plan({ dataset, name: "support-sft", recipe, split: splits.bySession({ evalFraction: 0.1 }), maxCostUsd: 5 });
    expect(plan).toBeInstanceOf(RunPlan);
    expect(plan.resolvedRecipe).toBe(plan.resolvedConfig);
    expect(plan.estimatedSteps).toBeGreaterThan(0);
    expect(server.lastBody("POST", "/v1/runs/plan")).toEqual({
      dataset: "support-prod",
      name: "support-sft",
      recipe: { kind: "sft", model: "test/tiny-qwen3", batch_size: 1, adapter: { kind: "lora", merge_on_export: true } },
      split: { strategy: "by_session", eval_fraction: 0.1 },
      max_cost_usd: 5,
    });

    const statuses: string[] = [];
    const run = await grad.runs.create({ dataset: "support-prod", name: "support-sft", recipe, maxCostUsd: 5 }).wait({ onStatus: (s) => void statuses.push(s) });
    expect(run).toBeInstanceOf(Run);
    expect(run.status).toBe("completed");
    expect(run.artifact).toBeInstanceOf(Artifact);
    expect(run.artifact.id).toBe(completed.artifact_id);
    expect(statuses).toEqual(["queued", "running", "completed"]);
    expect(clock.sleeps).toEqual([500, 750, 1125]);
    expect(run.toJSON().artifact?.id).toBe(completed.artifact_id);

    const created = await grad.runs.create({ dataset: "support-prod", name: "x", recipe: { kind: "sft" } });
    expect(created.status).toBe("queued");
    await expect(grad.runs.create({ dataset: "d", name: "", recipe: { kind: "sft" } })).rejects.toBeInstanceOf(GradUsageError);
  });

  it("surfaces the plan's warnings on the created run and console.warn", async () => {
    const dup = "run support-sft is already running (run_abc); this starts a second one.";
    const server = new FakeServer()
      .on("POST", "/v1/runs", json({ ...queued, warnings: [dup] }, 202), json(queued, 202))
      .on("POST", "/v1/runs/plan", json(wire("plan-run.json")));
    const { grad } = makeGrad(server);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const run = await grad.runs.create({ dataset: "support", name: "support-sft", recipe: { kind: "sft" } });
      expect(run.warnings).toEqual([dup]);
      expect(warn).toHaveBeenCalledWith(`grad: ${dup}`);
      warn.mockClear();
      await grad.runs.create({ dataset: "support", name: "other", recipe: { kind: "sft" } });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
    const plan = await grad.runs.plan({ dataset: "support", name: "x", recipe: { kind: "sft" } });
    expect(plan.costBreakdown.trainUsd).toBe(0.0002);
  });

  it("backs off to 5 s, rides out transient errors and stops on real ones", async () => {
    const running = json(withStatus("running"));
    const server = new FakeServer().on("GET", RUN, running, running, json({}, 503), running, running, running, running, running, running, running, running, json(completed));
    server.on("GET", artifactPath, json(wire("artifact.json")));
    const { grad, clock } = makeGrad(server, { maxRetries: 0 });
    const run = await grad.runs.wait(completed.id);
    expect(run.status).toBe("completed");
    expect(clock.sleeps.slice(-3)).toEqual([5000, 5000, 5000]);
    expect(Math.max(...clock.sleeps)).toBe(5000);

    const broken = new FakeServer().on("GET", RUN, json(withStatus("running")), problemFixture("not-found"));
    await expect(makeGrad(broken).grad.runs.wait(completed.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it.each([
    ["failed", "OOM in step 3"],
    ["cancelled", null],
    ["stopped_budget", null],
  ])("throws RunFailedError for %s", async (status, error) => {
    const server = new FakeServer().on("GET", RUN, json(withStatus(status, { error, artifact_id: null })));
    const e = await makeGrad(server).grad.runs.wait(completed.id).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RunFailedError);
    expect(e).toBeInstanceOf(GradError);
    expect((e as RunFailedError).run.status).toBe(status);
    expect((e as RunFailedError).code).toBe(`run_${status}`);
    if (error) expect((e as Error).message).toContain(error);
    if (status === "stopped_budget") expect((e as Error).message).toContain("maxCostUsd");
  });

  it("refuses a completed run without an artifact", async () => {
    const server = new FakeServer().on("GET", RUN, json(withStatus("completed", { artifact_id: null })));
    await expect(makeGrad(server).grad.runs.wait(completed.id)).rejects.toThrow(/without an artifact/);
  });

  it("gives up after the 24 h default when no timeout is given", async () => {
    const server = new FakeServer().on("GET", RUN, json(withStatus("running")));
    const { grad } = makeGrad(server);
    const hour = 3600 * 1000;
    await expect(
      grad.runs.wait(completed.id, { pollIntervalMs: hour, maxPollIntervalMs: hour }),
    ).rejects.toBeInstanceOf(WaitTimeoutError);
    expect(server.callsTo("GET", RUN).length).toBeLessThanOrEqual(26);
  });

  it("times out and aborts without leaking abort listeners", async () => {
    const server = new FakeServer().on("GET", RUN, json(withStatus("running")));
    const { grad } = makeGrad(server);
    await expect(grad.runs.wait(completed.id, { timeoutMs: 3000 })).rejects.toBeInstanceOf(WaitTimeoutError);

    const warnings = vi.spyOn(process, "emitWarning");
    const controller = new AbortController();
    const add = vi.spyOn(controller.signal, "addEventListener");
    const remove = vi.spyOn(controller.signal, "removeEventListener");
    const real = new FakeServer().on("GET", RUN, json(withStatus("running")));
    let polls = 0;
    const { grad: realGrad } = makeGrad(real, {
      sleep: async () => {
        polls += 1;
        if (polls === 60) controller.abort();
      },
    });
    await expect(realGrad.runs.wait(completed.id, { signal: controller.signal })).rejects.toBeInstanceOf(APIUserAbortError);
    expect(polls).toBe(60);
    expect(add.mock.calls.length).toBe(remove.mock.calls.length);
    expect(warnings).not.toHaveBeenCalledWith(expect.stringContaining("MaxListenersExceeded"), expect.anything());
    warnings.mockRestore();

    const before = new AbortController();
    before.abort();
    await expect(realGrad.runs.wait(completed.id, { signal: before.signal })).rejects.toBeInstanceOf(APIUserAbortError);
  });

  it("streams metrics over SSE, reconnecting with Last-Event-ID until the status event", async () => {
    const sse = wire<string>("metrics.sse");
    const blocks = sse.split("\n\n").filter(Boolean);
    const firstHalf = `${blocks.slice(0, 3).join("\n\n")}\n\n`;
    const rest = `${blocks.slice(3).join("\n\n")}\n\n`;
    const stream = (text: string) => new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
    const server = new FakeServer()
      .on("GET", `${RUN}/metrics`, stream(firstHalf), json({}, 502), stream(rest))
      .on("GET", RUN, json(withStatus("running")))
      .on("GET", artifactPath, json(wire("artifact.json")));
    const { grad, clock } = makeGrad(server, { maxRetries: 0 });
    const run = await grad.runs.get(completed.id);
    const steps: number[] = [];
    for await (const m of run.metrics({ follow: true })) steps.push(m.step);
    expect(run.status).toBe("completed");
    expect(steps).toEqual([...Array(steps.length).keys()].map((i) => i + 1));
    const metricCalls = server.callsTo("GET", `${RUN}/metrics`);
    expect(metricCalls).toHaveLength(3);
    expect(metricCalls[0]?.headers.has("last-event-id")).toBe(false);
    expect(metricCalls[1]?.headers.get("last-event-id")).toBe("3");
    expect(metricCalls[2]?.headers.get("last-event-id")).toBe("3");
    expect(clock.sleeps).toEqual([500, 1000]);
  });

  it("follows metrics for docs-style `for await` and pages JSON metrics", async () => {
    const server = new FakeServer()
      .on("GET", `${RUN}/metrics`, (call) =>
        call.headers.get("accept") === "text/event-stream"
          ? new Response(wire<string>("metrics.sse"), { status: 200 })
          : call.url.searchParams.get("cursor")
            ? json({ ...wire<Record<string, unknown>>("metrics-page.json"), data: [null], next_cursor: null })
            : json({ ...wire<Record<string, unknown>>("metrics-page.json"), next_cursor: "c2" }),
      )
      .on("GET", RUN, json(withStatus("running")));
    const { grad } = makeGrad(server);
    const run = await grad.runs.get(completed.id);
    const live = [];
    for await (const m of run.metrics({ follow: true, afterStep: 2 })) live.push(m.step);
    expect(live[0]).toBe(3);
    expect(run.status).toBe("completed");
    const paged = [];
    for await (const m of grad.runs.metrics(completed.id, { afterStep: 0 })) paged.push(m);
    expect(paged.length).toBe(wire<{ data: unknown[] }>("metrics-page.json").data.length);
    expect(paged[0]).toHaveProperty("gradNorm");
    expect(server.callsTo("GET", `${RUN}/metrics`).at(-2)?.url.search).toBe("?after_step=0");

    const failing = new FakeServer().on("GET", `${RUN}/metrics`, problemFixture("not-found"));
    const r2 = await makeGrad(failing).grad.runs.metrics(completed.id, { follow: true }).next().catch((x: unknown) => x);
    expect(r2).toBeInstanceOf(NotFoundError);
  });

  it("times out a metric-following wait", async () => {
    const hang = new FakeServer().on("GET", `${RUN}/events`, (call) => new Promise<Response>((_r, reject) => {
      const signal = (call as unknown as { signal?: AbortSignal }).signal;
      void signal;
      setTimeout(() => reject(Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNRESET" } })), 5);
    })).on("GET", RUN, json(withStatus("running")));
    const { grad } = makeGrad(hang, { maxRetries: 0, sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 5))) });
    const run = await grad.runs.get(completed.id);
    await expect(run.wait({ onMetric: () => undefined, timeoutMs: 50 })).rejects.toBeInstanceOf(WaitTimeoutError);
  });

  it("lists, cancels, resumes and lists checkpoints; promotes a checkpoint", async () => {
    const ckpts = wire<{ data: Array<{ id: string }> }>("checkpoints.json");
    const server = new FakeServer()
      .on("GET", "/v1/runs", json(wire("runs-page.json")))
      .on("POST", `${RUN}/cancel`, json(withStatus("cancelled")))
      .on("POST", `${RUN}/resume`, json(withStatus("queued")))
      .on("GET", `${RUN}/checkpoints`, json({ ...ckpts, next_cursor: "c2" }), json({ data: [], next_cursor: null }))
      .on("POST", `/v1/checkpoints/${ckpts.data[0]?.id}/promote`, json(wire("artifact.json"), 201))
      .on("GET", RUN, json(withStatus("running")));
    const { grad } = makeGrad(server);
    expect((await grad.runs.list({ limit: 5 })).data[0]).toBeInstanceOf(Run);
    expect((await grad.runs.cancel(completed.id)).status).toBe("cancelled");
    const resumed = await grad.runs.resume(completed.id, { maxCostUsd: 10 });
    expect(resumed.status).toBe("queued");
    expect(server.lastBody("POST", `${RUN}/resume`)).toEqual({ max_cost_usd: 10 });
    const run = await grad.runs.get(completed.id);
    await run.resume();
    expect(server.lastBody("POST", `${RUN}/resume`)).toEqual({});
    await run.cancel();
    expect(run.status).toBe("cancelled");
    await run.refresh();
    expect(run.status).toBe("running");

    const list = await grad.runs.checkpoints(completed.id);
    expect(list).toHaveLength(ckpts.data.length);
    expect(list[0]).toBeInstanceOf(Checkpoint);
    const promoted = await list[0]!.promote({ name: "keep-me" });
    expect(promoted).toBeInstanceOf(Artifact);
    expect(server.lastBody("POST", `/v1/checkpoints/${ckpts.data[0]?.id}/promote`)).toEqual({ name: "keep-me" });
    await grad.checkpoints.promote(ckpts.data[0]!.id);
    expect(server.lastBody("POST", `/v1/checkpoints/${ckpts.data[0]?.id}/promote`)).toEqual({});
    expect(list[0]!.toJSON().id).toBe(ckpts.data[0]?.id);
  });

  it("refuses to deploy or download a run with no artifact", async () => {
    const server = new FakeServer().on("GET", RUN, json(withStatus("running", { artifact_id: null })));
    const run = await makeGrad(server).grad.runs.get(completed.id);
    await expect(run.deploy()).rejects.toThrow(/no artifact to deploy/);
    await expect(run.download("x")).rejects.toThrow(/no artifact to download/);
  });
});

describe("artifact downloads", () => {
  const bundle = new Uint8Array(Array.from({ length: 70_000 }, (_, i) => i % 251));
  const sha = createHash("sha256").update(bundle).digest("hex");
  const download = (headers: Record<string, string>, body: Uint8Array = bundle) =>
    new FakeServer().on(
      "GET",
      `${artifactPath}/download`,
      new Response(body as BodyInit, { status: 200, headers: { "content-type": "application/octet-stream", "content-length": String(body.byteLength), ...headers } }),
    );
  const leftovers = (dir: string) => readdirSync(dir).filter((f) => f.includes(".grad-dl-"));

  it("streams to a file and to a directory using the server's file name, verifying SHA-256", async () => {
    const server = download({ "x-artifact-sha256": sha.toUpperCase(), "content-disposition": 'attachment; filename="support-sft-2026-11-27-1.grad.tar.gz"' });
    server.on("GET", artifactPath, json(wire("artifact.json")));
    const { grad } = makeGrad(server);
    const dir = scratch();
    const file = path.join(dir, "nested", "bundle.tgz");
    const result = await grad.artifacts.download(completed.artifact_id, file);
    expect(result).toEqual({ path: file, sha256: sha, sizeBytes: bundle.byteLength });
    expect(new Uint8Array(readFileSync(file))).toEqual(bundle);
    const intoDir = await grad.artifacts.download({ name: "support-sft", version: "2026-11-27-1" }, `${dir}/`);
    expect(intoDir.path).toBe(path.join(dir, "support-sft-2026-11-27-1.grad.tar.gz"));
    const art = await grad.artifacts.get(completed.artifact_id);
    expect((await art.download(dir)).path).toBe(path.join(dir, "support-sft-2026-11-27-1.grad.tar.gz"));
    expect(leftovers(dir)).toEqual([]);
    const stream = await art.stream();
    expect(stream.sha256).toBe(sha);
    expect(stream.sizeBytes).toBe(bundle.byteLength);
    expect(stream.filename).toBe("support-sft-2026-11-27-1.grad.tar.gz");
    await stream.response.cancel();
  });

  it("fails closed on a checksum mismatch and leaves no file behind", async () => {
    const tampered = bundle.slice();
    tampered[10] = (tampered[10] ?? 0) ^ 0xff;
    const { grad } = makeGrad(download({ "x-artifact-sha256": sha }, tampered));
    const dir = scratch();
    const target = path.join(dir, "bundle.tgz");
    const e = await grad.artifacts.download(completed.artifact_id, target).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ChecksumMismatchError);
    expect((e as ChecksumMismatchError).expected).toBe(sha);
    expect(existsSync(target)).toBe(false);
    expect(leftovers(dir)).toEqual([]);
  });

  it.each([[{}], [{ "x-artifact-sha256": "abc123" }], [{ "x-artifact-sha256": "z".repeat(64) }]])("refuses unverifiable downloads (%j)", async (headers) => {
    const { grad } = makeGrad(download(headers));
    const dir = scratch();
    await expect(grad.artifacts.download(completed.artifact_id, path.join(dir, "b"))).rejects.toThrow(/X-Artifact-Sha256/);
    expect(readdirSync(dir)).toEqual([]);
    const ok = await grad.artifacts.download(completed.artifact_id, path.join(dir, "b"), { verifyChecksum: false });
    expect(ok.sizeBytes).toBe(bundle.byteLength);
  });

  it("downloads the artifact of a waited run", async () => {
    const server = download({ "x-artifact-sha256": sha }).on("GET", RUN, json(completed));
    const run = await makeGrad(server).grad.runs.get(completed.id);
    const dir = scratch();
    writeFileSync(path.join(dir, "keep.txt"), "x");
    const out = await run.download(path.join(dir, "out.tgz"));
    expect(out.sha256).toBe(sha);
  });
});
