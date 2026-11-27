import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createCloudTracesAdapter } from "../src/adapters-cloud.js";
import { ApiError } from "../src/errors.js";
import {
  startFakeCloudApi,
  type FakeCloudApi,
} from "./fixtures/fake-cloud-api.js";

describe("createCloudTracesAdapter (the gradiated source)", () => {
  let cloud: FakeCloudApi;

  beforeAll(async () => {
    cloud = await startFakeCloudApi();
    cloud.gatewayRecords.set("ws_a", [
      {
        type: "trace",
        trace_id: "t1",
        messages: [],
        metadata: { model: "acme/support" },
      },
      {
        type: "trace",
        trace_id: "t2",
        messages: [],
        metadata: { model: "acme/other" },
      },
      {
        type: "score",
        trace_id: "t1",
        name: "thumbs",
        value: 1,
        score_id: "s1",
      },
    ]);
    cloud.gatewayRecords.set("ws_b", [{ type: "trace", trace_id: "secret-b" }]);
  });

  afterAll(() => cloud.close());

  const adapter = () =>
    createCloudTracesAdapter({
      internalApiBaseUrl: cloud.url,
      serviceToken: cloud.serviceToken,
    });

  it("pages one workspace's gateway rows with the service token and an opaque cursor", async () => {
    const first = await adapter().pull({
      workspaceId: "ws_a",
      filter: { models: ["acme/support"] },
      cursor: null,
      limit: 2,
    });
    expect(first.records.map((r) => r.trace_id)).toEqual(["t1"]);
    expect(first.has_more).toBe(true);

    const second = await adapter().pull({
      workspaceId: "ws_a",
      filter: {},
      cursor: first.cursor,
      limit: 2,
    });
    expect(second.records).toEqual([
      {
        type: "score",
        trace_id: "t1",
        name: "thumbs",
        value: 1,
        score_id: "s1",
      },
    ]);
    expect(second.has_more).toBe(false);

    const call = cloud.callsTo("/api/internal/v1/training/traces:pull").at(-1);
    expect(call?.body).toEqual({
      workspace_id: "ws_a",
      filter: {},
      cursor: "2",
      limit: 2,
    });
  });

  it("maps Cloud failures to typed errors", async () => {
    cloud.failNext(1, 500, "/api/internal/v1/training/traces:pull");
    await expect(
      adapter().pull({
        workspaceId: "ws_a",
        filter: {},
        cursor: null,
        limit: 1,
      }),
    ).rejects.toMatchObject({ status: 502, code: "source_upstream_error" });

    cloud.respondOnce("/api/internal/v1/training/traces:pull", 200, {
      rows: [],
    });
    await expect(
      adapter().pull({
        workspaceId: "ws_a",
        filter: {},
        cursor: null,
        limit: 1,
      }),
    ).rejects.toMatchObject({
      status: 502,
      detail: expect.stringContaining("unexpected body"),
    });

    const unreachable = createCloudTracesAdapter({
      internalApiBaseUrl: "http://127.0.0.1:9",
      serviceToken: "t",
      timeoutMs: 500,
    });
    const error = await unreachable
      .pull({ workspaceId: "ws_a", filter: {}, cursor: null, limit: 1 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 503,
      code: "source_upstream_unavailable",
    });
  });
});
