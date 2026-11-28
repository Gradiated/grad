import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import type { DatasetRecord } from "../src/contracts.js";
import { splitForRecipe, splitRecords } from "../src/planner.js";

// Golden files shared with the trainer's tests (server/trainer/tests): both
// sides replay the same inputs and must produce the same output.
const fixture = <T>(name: string): T =>
  JSON.parse(
    readFileSync(
      new URL(`../../trainer/tests/fixtures/${name}`, import.meta.url),
      "utf8",
    ),
  ) as T;

describe("trainer parity", () => {
  it("splits records like grad_trainer.splits", () => {
    const cases = fixture<
      Array<{
        kind?: "router";
        records: DatasetRecord[];
        options: Parameters<typeof splitRecords>[1];
      }>
    >("split_parity_records.json");
    const expected = fixture<Array<{ train: number[]; eval: number[] }>>(
      "split_parity_expected.json",
    );

    const actual = cases.map((c) => {
      const split = c.kind
        ? splitForRecipe(c.kind, c.records, c.options)
        : splitRecords(c.records, c.options);
      const index = (r: DatasetRecord) => c.records.indexOf(r);

      return { train: split.train.map(index), eval: split.eval.map(index) };
    });

    expect(actual).toEqual(expected);
  });
});
