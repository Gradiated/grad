import { describe, expect, it } from "vitest";

import { createDbAnchoredClock, leaseGraceCutoff } from "../src/clock.js";

describe("clock", () => {
  it("follows the database clock on the monotonic clock (lease times agree across skewed replicas)", async () => {
    let mono = 50;
    let wall = 1_000_000;
    const clock = createDbAnchoredClock(
      () => mono,
      () => wall,
    );
    expect(clock.now().getTime()).toBe(1_000_000);
    // The DB is 5 s ahead; the round trip takes 10 ms.
    await clock.sync(async () => {
      mono += 10;
      return new Date(wall + 5_000 + 5);
    });
    expect(clock.now().getTime()).toBe(1_005_005 + 5);
    mono += 1_000;
    expect(clock.now().getTime()).toBe(1_006_010);
    // r8 A8: the host clock steps +10 min after the sync; leases don't move.
    wall += 600_000;
    expect(clock.now().getTime()).toBe(1_006_010);
  });

  it("reaps a lease one heartbeat interval (lease/3) after it expires", () => {
    expect(leaseGraceCutoff(new Date("2026-11-27T12:01:00Z"), 180)).toBe(
      "2026-11-27T12:00:00.000Z",
    );
  });
});
