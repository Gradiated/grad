import type { Context } from "hono";
import type { SSEStreamingApi } from "hono/streaming";

import { ApiError } from "../errors.js";
import type { AppEnv } from "./helpers.js";

type StreamBody = (stream: SSEStreamingApi) => Promise<void>;

/**
 * Caps the event streams one API key holds open on this replica: each one polls
 * Postgres for as long as it stays open, so an unbounded number per key is a
 * cheap way to load the database for every tenant. `reserve(c, body)` answers
 * 429 `too_many_streams` at the cap, else returns `body` holding a slot until it ends.
 */
export const createSseLimits = (perKey: number) => {
  const open = new Map<string, number>();

  return (c: Context<AppEnv>, body: StreamBody): StreamBody => {
    const principal = c.get("principal");
    const key = `${principal.workspaceId}\u0000${principal.actor}`;
    const count = open.get(key) ?? 0;
    if (count >= perKey) {
      throw new ApiError(
        429,
        "too_many_streams",
        "Too many open streams",
        `This API key already has ${perKey} event streams open; close one, or poll the JSON page (tail_cursor) instead.`,
      );
    }
    open.set(key, count + 1);

    return async (stream) => {
      try {
        await body(stream);
      } finally {
        const left = (open.get(key) ?? 1) - 1;
        if (left > 0) open.set(key, left);
        else open.delete(key);
      }
    };
  };
};
