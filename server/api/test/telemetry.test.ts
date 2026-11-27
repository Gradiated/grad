import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { API_VERSION, createMetricsApp } from "../src/app.js";
import {
  ObjectExistsError,
  ObjectNotFoundError,
  type ObjectStore,
} from "../src/storage/types.js";
import { describeMetrics, LABELS, metrics } from "../src/telemetry/metrics.js";
import { instrumentObjectStore } from "../src/telemetry/storage.js";
import {
  currentTraceparent,
  tracingEnabled,
} from "../src/telemetry/tracing.js";
import { makeTestApp, type TestApp } from "./fixtures/app.js";
import { createSftRun, FakeWorker } from "./fixtures/worker.js";

interface Sample {
  name: string;
  labels: Record<string, string>;
  value: number;
}

/** Parses Prometheus text exposition into samples. */
const parseExposition = (text: string): Sample[] =>
  text
    .split("\n")
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      const m = /^([a-zA-Z_:][a-zA-Z0-9_:]*)(?:\{(.*)\})? (\S+)$/.exec(line);
      if (!m) throw new Error(`unparsable sample: ${line}`);
      const labels: Record<string, string> = {};
      for (const pair of (m[2] ?? "").matchAll(/(\w+)="((?:[^"\\]|\\.)*)"/g)) {
        labels[pair[1] as string] = pair[2] as string;
      }

      return { name: m[1] as string, labels, value: Number(m[3]) };
    });

const scrape = async (t: TestApp, token?: string) => {
  const res = await t.request("/metrics", { token: token ?? null });
  expect(res.status).toBe(200);
  expect(res.headers.get("content-type")).toContain("text/plain");

  return parseExposition(await res.text());
};

const value = (samples: Sample[], name: string, labels: object = {}) =>
  samples
    .filter(
      (s) =>
        s.name === name &&
        Object.entries(labels).every(([k, v]) => s.labels[k] === v),
    )
    .reduce((sum, s) => sum + s.value, 0);

/** Label values that would make series grow with ids. */
const ID_LIKE =
  /^(?:run|ds|imp|eval|src|req|key|ckpt|art|rec|job|up|ws)_[A-Za-z0-9]|[0-9a-f]{8}-[0-9a-f]{4}-|[0-9a-f]{24,}/;

describe("Prometheus metrics", () => {
  let t: TestApp;
  let worker: FakeWorker;

  beforeEach(async () => {
    t = await makeTestApp();
    worker = new FakeWorker(t);
  });
  afterEach(async () => {
    await t.close();
  });

  /** One run end to end, a 404, a bad request and a maintenance tick. */
  const exercise = async () => {
    const run = await createSftRun(t);
    await t.services.maintenance.tick();
    const queued = await scrape(t);
    expect(
      value(queued, "grad_jobs", { kind: "train", status: "queued" }),
    ).toBe(1);
    expect(value(queued, "grad_jobs_open", { kind: "train" })).toBe(1);

    const job = await worker.claim();
    expect(job?.run?.id).toBe(run.id);
    await worker.call(`/v1/trainer-jobs/${job!.id}/heartbeat`, {
      ...worker.ref(job!),
      stats: {
        phase: "training",
        tokens_per_second: 1500,
        gpu_memory_used_bytes: 2e9,
        gpu_utilization: 0.5,
      },
    });
    await worker.progress(job!, 1, 400_000);
    await worker.progress(job!, 2, 900_000);
    await worker.checkpoint(job!, 2, "ckpt-2", {
      format: "peft_lora",
      metadata: { emergency: true, upload_seconds: 2.5 },
    });
    await t.services.maintenance.tick();
    const running = await scrape(t);
    await worker.complete(
      job!,
      { status: "completed", tokens_processed: 1_000_000 },
      "artifact",
    );
    await t.json(`/v1/runs/${run.id}`);
    await t.json("/v1/runs/run_doesnotexist");
    await t.json("/v1/no/such/route");
    await t.services.maintenance.tick();

    return { run, running, done: await scrape(t) };
  };

  it("exports queue, worker, training and HTTP metrics with low-cardinality labels", async () => {
    const { running, done } = await exercise();

    expect(
      value(running, "grad_jobs", { kind: "train", status: "running" }),
    ).toBe(1);
    expect(value(running, "grad_workers_online", { kind: "train" })).toBe(1);
    expect(
      value(running, "grad_worker_phase", { kind: "train", phase: "training" }),
    ).toBe(1);
    expect(
      value(running, "grad_worker_tokens_per_second", { kind: "train" }),
    ).toBe(1500);
    expect(
      value(running, "grad_worker_gpu_memory_used_bytes", { kind: "train" }),
    ).toBe(2e9);
    expect(
      value(running, "grad_worker_gpu_utilization_ratio", { kind: "train" }),
    ).toBe(0.5);

    expect(value(done, "grad_jobs", { kind: "train" })).toBe(0);
    expect(value(done, "grad_workers_online", { kind: "train" })).toBe(0);
    expect(
      value(done, "grad_job_attempts_total", { kind: "train" }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      value(done, "grad_worker_heartbeats_total", { kind: "train" }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      value(done, "grad_job_claim_latency_seconds_count", { kind: "train" }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      value(done, "grad_job_duration_seconds_count", {
        kind: "train",
        recipe_kind: "sft",
        status: "completed",
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      value(done, "grad_training_tokens_total", {
        recipe_kind: "sft",
        model_family: "tiny",
      }),
    ).toBeGreaterThanOrEqual(900_000);
    expect(
      value(done, "grad_billed_tokens_total", { kind: "run" }),
    ).toBeGreaterThanOrEqual(1_000_000);
    expect(
      value(done, "grad_checkpoints_total", {
        recipe_kind: "sft",
        reason: "emergency",
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      value(done, "grad_checkpoint_upload_bytes_total", { recipe_kind: "sft" }),
    ).toBeGreaterThanOrEqual(6);
    expect(
      value(done, "grad_checkpoint_upload_duration_seconds_sum", {
        recipe_kind: "sft",
      }),
    ).toBeGreaterThanOrEqual(2.5);
    expect(
      value(done, "grad_dataset_part_bytes_total", { form: "uncompressed" }),
    ).toBeGreaterThan(0);
    expect(
      value(done, "grad_maintenance_step_duration_seconds_count", {
        step: "expire_jobs",
      }),
    ).toBeGreaterThanOrEqual(3);
    expect(value(done, "grad_db_query_duration_seconds_count")).toBeGreaterThan(
      0,
    );
    expect(
      value(done, "grad_db_pool_connections", { state: "idle" }),
    ).toBeGreaterThanOrEqual(0);
    expect(value(done, "grad_build_info", { version: API_VERSION })).toBe(1);
    expect(value(done, "process_cpu_user_seconds_total")).toBeGreaterThan(0);

    // Route templates, never raw paths.
    expect(
      value(done, "grad_http_requests_total", {
        route: "/v1/runs/:id",
        method: "GET",
        status_class: "2xx",
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      value(done, "grad_http_requests_total", {
        route: "/v1/runs/:id",
        status_class: "4xx",
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      value(done, "grad_http_requests_total", {
        route: "unmatched",
        status_class: "4xx",
      }),
    ).toBeGreaterThanOrEqual(1);
    expect(
      value(done, "grad_http_request_duration_seconds_count", {
        route: "/v1/trainer-jobs/:id/progress",
      }),
    ).toBeGreaterThanOrEqual(2);
  });

  it("never labels a series with an id (cardinality guard)", async () => {
    await exercise();
    const allowed = new Set<string>(LABELS);
    const samples = (await scrape(t)).filter((s) => s.name.startsWith("grad_"));
    expect(samples.length).toBeGreaterThan(50);
    for (const s of samples) {
      for (const [label, v] of Object.entries(s.labels)) {
        if (label === "le") continue;
        expect(allowed.has(label), `${s.name} label ${label}`).toBe(true);
        expect(label === "workspace" ? s.name : "").toBe(
          label === "workspace" ? "grad_workspace_jobs" : "",
        );
        expect(ID_LIKE.test(v), `${s.name}{${label}="${v}"}`).toBe(false);
      }
    }
    for (const m of await describeMetrics()) {
      for (const label of m.labels) {
        expect(allowed.has(label), `${m.name} declares ${label}`).toBe(true);
      }
    }
    // A second identical round adds no series: labels don't grow with runs.
    const before = new Set(
      samples.map((s) => `${s.name}${JSON.stringify(s.labels)}`),
    );
    await exercise();
    const after = (await scrape(t))
      .filter((s) => s.name.startsWith("grad_"))
      .map((s) => `${s.name}${JSON.stringify(s.labels)}`)
      .filter((k) => !before.has(k));
    expect(after).toEqual([]);
  });

  it("serves queue depth for KEDA's metrics-api trigger", async () => {
    await createSftRun(t);
    const first = await t.json<Record<string, unknown>>(
      "/metrics/queue?kinds=train",
      { token: null },
    );
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({ open: 1, queued: 1, running: 0 });
    expect(first.body.sampled_at).toEqual(expect.any(String));
    await worker.claim();
    await t.services.maintenance.tick();
    expect(
      (await t.json("/metrics/queue?kinds=train", { token: null })).body,
    ).toMatchObject({
      open: 1,
      queued: 0,
      running: 1,
    });
    expect(
      (await t.json("/metrics/queue?kinds=import", { token: null })).body,
    ).toMatchObject({ open: 0 });
  });

  it("counts a lost lease as a requeue", async () => {
    await createSftRun(t);
    const job = await worker.claim();
    expect(job).not.toBeNull();
    t.clock.advanceSeconds(3600);
    await t.services.maintenance.tick();
    expect(
      value(await scrape(t), "grad_job_requeues_total", {
        kind: "train",
        reason: "lease_lost",
      }),
    ).toBeGreaterThanOrEqual(1);
  });

  it("ignores unknown heartbeat phases instead of failing the heartbeat", async () => {
    await createSftRun(t);
    const job = await worker.claim();
    const hb = await worker.call(`/v1/trainer-jobs/${job!.id}/heartbeat`, {
      ...worker.ref(job!),
      stats: { phase: "x".repeat(40) },
    });
    expect(hb.status).toBe(200);
    await t.services.maintenance.tick();
    expect(
      value(await scrape(t), "grad_worker_phase", { phase: "other" }),
    ).toBe(1);
  });

  it("reports sources, paused sources and consecutive failures by provider", async () => {
    await t.json("/v1/datasets/traces/records", {
      body: { records: [{ messages: [{ role: "user", content: "hi" }] }] },
    });
    const dataset = await t.deps.store.datasets.get("ws_a", "traces");
    const source = await t.deps.store.sources.create({
      workspaceId: "ws_a",
      datasetId: dataset!.id,
      provider: "langfuse",
      host: null,
      secretName: null,
      project: null,
      filters: {},
      schedule: null,
      nextSyncAt: null,
    });
    await t.deps.store.sources.update(source.id, {
      status: "paused",
      consecutive_failures: 10,
    });
    await t.services.maintenance.tick();
    const samples = await scrape(t);
    expect(value(samples, "grad_sources", { provider: "langfuse" })).toBe(1);
    expect(
      value(samples, "grad_sources_paused", { provider: "langfuse" }),
    ).toBe(1);
    expect(
      value(samples, "grad_source_consecutive_failures", {
        provider: "langfuse",
      }),
    ).toBe(10);
  });

  it("leaves tracing off by default", async () => {
    expect(tracingEnabled()).toBe(false);
    expect(currentTraceparent()).toBeNull();
    await createSftRun(t);
    const job = await worker.claim();
    expect((job as unknown as { traceparent: unknown }).traceparent).toBeNull();
  });
});

describe("metrics endpoint settings", () => {
  it("requires the bearer token when METRICS_TOKEN is set", async () => {
    const t = await makeTestApp({
      settings: {
        maxAttempts: 3,
        evalConcurrency: 1,
        metrics: { enabled: true, token: "scrape-secret" },
      },
    });
    try {
      expect((await t.request("/metrics", { token: null })).status).toBe(401);
      expect((await t.request("/metrics", { token: "wrong" })).status).toBe(
        401,
      );
      expect((await t.request("/metrics/queue", { token: null })).status).toBe(
        401,
      );
      expect(
        (await t.request("/metrics", { token: "scrape-secret" })).status,
      ).toBe(200);
    } finally {
      await t.close();
    }
  });

  it("is absent when disabled or moved to METRICS_PORT", async () => {
    for (const metricsSettings of [
      { enabled: false },
      { enabled: true, separatePort: true },
    ]) {
      const t = await makeTestApp({
        settings: {
          maxAttempts: 3,
          evalConcurrency: 1,
          metrics: metricsSettings,
        },
      });
      try {
        expect((await t.request("/metrics", { token: null })).status).toBe(404);
        if (metricsSettings.enabled) {
          const separate = createMetricsApp(t.deps, t.services);
          expect((await separate.request("/metrics")).status).toBe(200);
          expect((await separate.request("/v1/runs")).status).toBe(404);
        }
      } finally {
        await t.close();
      }
    }
  });

  it("adds a workspace label only on grad_workspace_jobs, and only when asked", async () => {
    const t = await makeTestApp({
      settings: {
        maxAttempts: 3,
        evalConcurrency: 1,
        metrics: { enabled: true, workspaceLabel: true },
      },
    });
    try {
      await createSftRun(t);
      await t.services.maintenance.tick();
      const samples = await scrape(t);
      expect(
        value(samples, "grad_workspace_jobs", {
          workspace: "ws_a",
          kind: "train",
          status: "queued",
        }),
      ).toBe(1);
    } finally {
      await t.close();
    }
  });
});

describe("instrumented object storage", () => {
  const fake = (fail: Error | null): ObjectStore =>
    ({
      kind: "local",
      put: async () => {
        if (fail) throw fail;
        return { key: "k", sha256: "s", sizeBytes: 1 };
      },
      get: async () => {
        throw new ObjectNotFoundError("k");
      },
    }) as unknown as ObjectStore;

  const errors = async (op: string) =>
    (await metrics.storageErrors.get()).values.find((v) => {
      const labels = v.labels as Record<string, unknown>;
      return labels.op === op && labels.backend === "local";
    })?.value ?? 0;

  it("times every call and counts only unexpected failures", async () => {
    const before = await errors("put");
    const ok = instrumentObjectStore(fake(null));
    await ok.put("k", new Uint8Array());
    await expect(ok.get("k")).rejects.toBeInstanceOf(ObjectNotFoundError);
    expect(await errors("get")).toBe(0);
    await expect(
      instrumentObjectStore(fake(new ObjectExistsError("k"))).put(
        "k",
        new Uint8Array(),
      ),
    ).rejects.toBeInstanceOf(ObjectExistsError);
    expect(await errors("put")).toBe(before);
    await expect(
      instrumentObjectStore(fake(new Error("boom"))).put("k", new Uint8Array()),
    ).rejects.toThrow("boom");
    expect(await errors("put")).toBe(before + 1);
    const timed = (await metrics.storageDuration.get()).values.find(
      (v) =>
        v.metricName?.endsWith("_count") &&
        (v.labels as Record<string, unknown>).op === "put",
    );
    expect(timed?.value).toBeGreaterThanOrEqual(3);
  });
});
