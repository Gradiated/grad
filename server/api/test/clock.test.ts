import { describe, expect, it } from "vitest";

import { createDbAnchoredClock, leaseGraceCutoff } from "../src/clock.js";

describe("clock", () => {
  it("anchors the host clock to the database clock (lease times agree across skewed replicas)", async () => {
    let host = 1_000_000;
    const clock = createDbAnchoredClock(() => host);
    expect(clock.now().getTime()).toBe(1_000_000);
    // The DB is 5 s ahead; the round trip takes 10 ms.
    await clock.sync(async () => {
      host += 10;
      return new Date(1_000_000 + 5_000 + 5);
    });
    expect(clock.now().getTime()).toBe(host + 5_000);
    host += 1_000;
    expect(clock.now().getTime()).toBe(host + 5_000);
  });

  it("reaps a lease one heartbeat interval (lease/3) after it expires", () => {
    expect(leaseGraceCutoff(new Date("2026-11-27T12:01:00Z"), 180)).toBe(
      "2026-11-27T12:00:00.000Z",
    );
  });
});
