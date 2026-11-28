// Plans each case on stdin ({cases: [{request, records}]}) with planner.ts planRun() against the
// dev-model catalog of `grad local up --dev-models` (used by test_plan_parity.py).
import { readFileSync } from "node:fs";

const root = process.argv[2];
const { planRun } = await import(`${root}/server/api/src/planner.ts`);
const { createModelCatalog } = await import(`${root}/server/api/src/catalog.ts`);
const { PlanRunRequestSchema } = await import(`${root}/server/api/src/contracts/runs.ts`);

const compose = readFileSync(`${root}/cli/assets/dev-models.yml`, "utf8");
// GRAD_EXTRA_MODELS_JSON: the first JSON array in the file (GRAD_JUDGE_MODELS_JSON follows it).
const start = compose.indexOf("[{");
const extras = compose.slice(start, compose.indexOf("}]", start) + 2).replace(/\n\s*/g, "");
const catalog = createModelCatalog(extras);
const { cases } = JSON.parse(readFileSync(0, "utf8"));

const plans = cases.map((c: { request: unknown; records: unknown[] }) =>
  planRun(PlanRunRequestSchema.parse(c.request), c.records, { catalog, datasetVersion: 1, baseArtifact: null, labeling: null }),
);
process.stdout.write(JSON.stringify(plans));
