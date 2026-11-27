import type { Context } from "hono";
import type { SSEStreamingApi } from "hono/streaming";
import { describe, expect, it } from "vitest";

import { ApiError } from "../src/errors.js";
import type { AppEnv } from "../src/routes/helpers.js";
import { createSseLimits } from "../src/routes/sse-limits.js";

const ctx = (workspaceId: string, actor: string) =>
  ({
    get: () => ({ workspaceId, actor }),
  }) as unknown as Context<AppEnv>;
const stream = {} as SSEStreamingApi;

describe("SSE stream limits (r8 P2-12)", () => {
  it("caps open streams per key and frees a slot when a stream ends, even on error", async () => {
    const reserve = createSseLimits(2);
    let finish!: () => void;
    const open = new Promise<void>((r) => (finish = r));
    const first = reserve(ctx("ws_a", "key_1"), () => open)(stream);
    const second = reserve(ctx("ws_a", "key_1"), async () => {
      throw new Error("db down");
    });
    expect(() => reserve(ctx("ws_a", "key_1"), async () => {})).toThrow(
      ApiError,
    );
    // Other keys and workspaces have their own budget.
    await reserve(ctx("ws_a", "key_2"), async () => {})(stream);
    await reserve(ctx("ws_b", "key_1"), async () => {})(stream);

    await expect(second(stream)).rejects.toThrow("db down");
    const third = reserve(ctx("ws_a", "key_1"), async () => {});
    try {
      reserve(ctx("ws_a", "key_1"), async () => {});
      expect.unreachable();
    } catch (e) {
      expect((e as ApiError).status).toBe(429);
      expect((e as ApiError).code).toBe("too_many_streams");
    }
    finish();
    await first;
    await third(stream);
    await reserve(ctx("ws_a", "key_1"), async () => {})(stream);
  });
});
