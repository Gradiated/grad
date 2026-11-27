// Prints planner.ts splitRecords() results for split_parity_records.json (used by test_splits.py).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const plannerPath = process.argv[2];
const { splitRecords } = await import(plannerPath);
const cases = JSON.parse(readFileSync(join(here, "split_parity_records.json"), "utf8"));

const out = cases.map((c: { records: Record<string, unknown>[]; options: Record<string, unknown> }) => {
  const { train, eval: evalSet } = splitRecords(c.records, c.options);
  const index = (r: unknown) => c.records.indexOf(r as Record<string, unknown>);
  return { train: train.map(index), eval: evalSet.map(index) };
});
process.stdout.write(JSON.stringify(out));
