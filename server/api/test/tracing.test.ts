import {
  AlwaysOffSampler,
  AlwaysOnSampler,
  InMemorySpanExporter,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
} from "@opentelemetry/sdk-trace";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  samplerFromEnv,
  startTracing,
  stopTracing,
  tracingEnabled,
} from "../src/telemetry/tracing.js";
import { makeTestApp, TRAINER_KEY } from "./fixtures/app.js";
import { createSftRun, FakeWorker } from "./fixtures/worker.js";

const sdk = {
  AlwaysOnSampler,
  AlwaysOffSampler,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
};

describe("samplerFromEnv", () => {
  it("reads OTEL_TRACES_SAMPLER and its ratio argument", () => {
    expect(samplerFromEnv({}, sdk)).toBeInstanceOf(ParentBasedSampler);
    expect(
      samplerFromEnv({ OTEL_TRACES_SAMPLER: "always_off" }, sdk),
    ).toBeInstanceOf(AlwaysOffSampler);
    expect(
      samplerFromEnv(
        { OTEL_TRACES_SAMPLER: "traceidratio", OTEL_TRACES_SAMPLER_ARG: "0.1" },
        sdk,
      ).toString(),
    ).toContain("0.1");
    expect(
      samplerFromEnv({ OTEL_TRACES_SAMPLER: "parentbased_traceidratio" }, sdk),
    ).toBeInstanceOf(ParentBasedSampler);
    expect(
      samplerFromEnv({ OTEL_TRACES_SAMPLER: "bogus" }, sdk),
    ).toBeInstanceOf(ParentBasedSampler);
  });
});

describe("OpenTelemetry tracing", () => {
  const exporter = new InMemorySpanExporter();

  beforeAll(async () => {
    expect(await startTracing({})).toBe(false);
    expect(
      await startTracing({ OTEL_SDK_DISABLED: "true" }, { exporter }),
    ).toBe(false);
    expect(await startTracing({}, { exporter, version: "test" })).toBe(true);
  });
  afterAll(async () => {
    await stopTracing();
    expect(tracingEnabled()).toBe(false);
  });

  it("links create, claim and the worker's requests in one trace", async () => {
    const t = await makeTestApp();
    try {
      const run = await createSftRun(t);
      const job = (await new FakeWorker(t).claim()) as unknown as {
        id: string;
        attempt: number;
        traceparent: string | null;
      };
      expect(job.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/);
      const traceId = job.traceparent?.split("-")[1];

      const hb = await t.json(`/v1/trainer-jobs/${job.id}/heartbeat`, {
        token: TRAINER_KEY,
        headers: { traceparent: job.traceparent as string },
        body: { worker_id: "worker-1", attempt: job.attempt },
      });
      expect(hb.status).toBe(200);

      const spans = exporter.getFinishedSpans();
      const named = (name: string) =>
        spans.filter(
          (s) => s.name === name && s.spanContext().traceId === traceId,
        );
      expect(named("POST /v1/runs")).toHaveLength(1);
      expect(named("grad.job.claim")).toHaveLength(1);
      expect(named("POST /v1/trainer-jobs/:id/heartbeat")).toHaveLength(1);
      expect(named("db.query").length).toBeGreaterThan(0);
      const create = named("POST /v1/runs")[0];
      expect(create?.attributes["http.response.status_code"]).toBe(202);
      expect(create?.attributes["http.route"]).toBe("/v1/runs");
      expect(run.id).toEqual(expect.any(String));
    } finally {
      await t.close();
    }
  });
});
