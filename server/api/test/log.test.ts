import { afterEach, describe, expect, it, vi } from "vitest";

import {
  log,
  redactSecrets,
  setLogComponent,
  withLogContext,
} from "../src/telemetry/log.js";

const capture = () => {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});

  return {
    lines: () =>
      spy.mock.calls.map(
        (c) => JSON.parse(String(c[0])) as Record<string, unknown>,
      ),
  };
};

describe("structured logs", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setLogComponent("api");
  });

  it("writes one JSON object per line to stdout with level, component and the ambient ids", () => {
    const out = capture();
    const errors = vi.spyOn(console, "error");
    withLogContext({ request_id: "req_1", workspace_id: "ws_a" }, () =>
      withLogContext({ job_id: "run_1", attempt: 2 }, () =>
        log("warn", "slow request", { route: "/v1/runs/:id" }),
      ),
    );
    setLogComponent("eval-worker");
    log("error", "outside a request");

    const [first, second] = out.lines();
    expect(first).toMatchObject({
      level: "warn",
      component: "api",
      msg: "slow request",
      request_id: "req_1",
      workspace_id: "ws_a",
      job_id: "run_1",
      attempt: 2,
      route: "/v1/runs/:id",
    });
    expect(Date.parse(String(first?.time))).toBeGreaterThan(0);
    expect(second).toMatchObject({ level: "error", component: "eval-worker" });
    expect(second).not.toHaveProperty("request_id");
    // Every level goes to stdout.
    expect(errors).not.toHaveBeenCalled();
  });

  it("logs an Error with its message, type and stack", () => {
    const out = capture();
    log("error", "maintenance step failed", {
      step: "expire_jobs",
      error: new TypeError("boom"),
    });
    log("warn", "plain", { error: "just text" });
    const [first, second] = out.lines();
    expect(first).toMatchObject({
      error: "boom",
      error_type: "TypeError",
      step: "expire_jobs",
    });
    expect(String(first?.stack)).toContain("log.test.ts");
    expect(second).toMatchObject({ error: "just text" });
    expect(second).not.toHaveProperty("stack");
  });

  it("masks credentials that slip into a line", () => {
    const key = `grad_${"ab".repeat(24)}`;
    const lease = `gradwt_${"A1b2".repeat(11)}`;
    const text = redactSecrets(
      `Bearer ${key} PUT https://s3/x?X-Amz-Credential=AKIA%2F1&X-Amz-Signature=deadbeef ${lease} sk-abcdefghijklmnopqrstuv`,
    );
    for (const secret of [
      key,
      "AKIA%2F1",
      "deadbeef",
      lease,
      "sk-abcdefghijklmnop",
    ])
      expect(text).not.toContain(secret);
    // Metric and table names are not credentials.
    expect(
      redactSecrets(
        "grad_job_oldest_queued_age_seconds grad_schema_migrations",
      ),
    ).toBe("grad_job_oldest_queued_age_seconds grad_schema_migrations");

    const out = capture();
    log("error", `upload failed: ${key}`, {
      url: `https://s3/x?X-Amz-Signature=cafe`,
    });
    const written = JSON.stringify(out.lines());
    expect(written).not.toContain(key);
    expect(written).not.toContain("cafe");
  });
});
