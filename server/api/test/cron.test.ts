import { describe, expect, it } from "vitest";

import { CronError, parseCron } from "../src/cron.js";

const at = (iso: string): Date => new Date(iso);
const next = (expr: string, after: string): string =>
  parseCron(expr).next(at(after)).toISOString();

describe("parseCron", () => {
  it("computes the next minute strictly after the given time", () => {
    expect(next("*/15 * * * *", "2026-11-27T10:07:30Z")).toBe(
      "2026-11-27T10:15:00.000Z",
    );
    expect(next("*/15 * * * *", "2026-11-27T10:15:00Z")).toBe(
      "2026-11-27T10:30:00.000Z",
    );
    expect(next("0 * * * *", "2026-11-27T23:59:00Z")).toBe(
      "2026-11-28T00:00:00.000Z",
    );
    expect(next("5/20 * * * *", "2026-11-27T10:26:00Z")).toBe(
      "2026-11-27T10:45:00.000Z",
    );
  });

  it("handles ranges, lists, months and the year boundary", () => {
    expect(next("30 9-17/4 * * *", "2026-11-27T13:31:00Z")).toBe(
      "2026-11-27T17:30:00.000Z",
    );
    expect(next("0 0 1 1,7 *", "2026-11-27T00:00:00Z")).toBe(
      "2027-01-01T00:00:00.000Z",
    );
    expect(next("0 12 29 2 *", "2026-03-01T00:00:00Z")).toBe(
      "2028-02-29T12:00:00.000Z",
    );
  });

  it("matches either day field when both are restricted", () => {
    // 2026-11-27 is a Friday; Sunday (0 or 7) is the 29th, the 1st is a Tuesday.
    expect(next("0 8 * * 7", "2026-11-27T09:00:00Z")).toBe(
      "2026-11-29T08:00:00.000Z",
    );
    expect(next("0 8 1 * 0", "2026-11-27T09:00:00Z")).toBe(
      "2026-11-29T08:00:00.000Z",
    );
    expect(next("0 8 1 * 3", "2026-11-29T09:00:00Z")).toBe(
      "2026-12-01T08:00:00.000Z",
    );
  });

  it("matches both day fields when either starts with *, as Vixie cron does", () => {
    // 2026-12-01 is a Tuesday; the first Monday on an odd date after it is 2026-12-07.
    expect(next("0 0 */2 * 1", "2026-11-30T12:00:00Z")).toBe(
      "2026-12-07T00:00:00.000Z",
    );
  });

  it("normalises whitespace", () => {
    expect(parseCron("  */5   *  * * * ").expression).toBe("*/5 * * * *");
  });

  it("rejects malformed and impossible schedules with typed errors", () => {
    for (const bad of [
      "* * * *",
      "60 * * * *",
      "* 24 * * *",
      "* * 0 * *",
      "* * * 13 *",
      "* * * * 8",
      "*/0 * * * *",
      "5-1 * * * *",
      "@hourly",
      "a * * * *",
    ]) {
      expect(() => parseCron(bad), bad).toThrow(CronError);
    }

    // Refused when parsed (a create answers 422), not after years of search.
    expect(() => parseCron("0 0 30 2 *")).toThrow(/never fires/);
    expect(() => parseCron("0 0 31 4,6,9,11 *")).toThrow(/never fires/);
    expect(next("0 0 30,31 2,3 *", "2026-01-01T00:00:00Z")).toBe(
      "2026-03-30T00:00:00.000Z",
    );
  });

  it("has minute resolution: a seconds field is rejected, so nothing fires more than once a minute", () => {
    expect(() => parseCron("*/10 * * * * *")).toThrow(CronError);
    expect(next("* * * * *", "2026-11-27T10:07:59Z")).toBe(
      "2026-11-27T10:08:00.000Z",
    );
  });
});
