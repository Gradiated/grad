/**
 * TypeScript SDK E2E contract check executed against a live grad-server instance.
 * Invoked by tests/contract/run_e2e.py with GRAD_BASE_URL and GRAD_ARTIFACT_REF set.
 */
import assert from "node:assert/strict";

import { Grad, recipes } from "../../sdks/typescript/dist/index.js";

const baseUrl = process.env.GRAD_BASE_URL;
const artifactRef = process.env.GRAD_ARTIFACT_REF;
const deploymentName = process.env.GRAD_DEPLOYMENT_NAME;

assert.ok(baseUrl, "GRAD_BASE_URL must be set");
assert.ok(artifactRef, "GRAD_ARTIFACT_REF must be set");
assert.ok(deploymentName, "GRAD_DEPLOYMENT_NAME must be set");

const client = new Grad({ baseUrl });

const models = await client.models.list();
assert.ok(Array.isArray(models) && models.length >= 6);

const pushed = await client.datasets.push("ts-contract-ds", [
  {
    session_id: "ts_1",
    messages: [
      { role: "user", content: "How do I update my billing card?" },
      { role: "assistant", content: "Open Billing -> Payment Methods." },
    ],
  },
]);
assert.equal(pushed.record_count, 1);

const plan = await client.runs.plan({
  dataset: "ts-contract-ds",
  name: "ts-contract-sft",
  recipe: recipes.sft({ model: "qwen/qwen3-8b" }),
  max_cost_usd: 2.0,
});
assert.ok(Number(plan.estimated_steps) >= 1);

const bytes = await client.artifacts.download(artifactRef);
assert.ok(bytes.byteLength > 20, "downloaded artifact archive should be non-empty");

const routed = await client.route({
  deployment: deploymentName,
  messages: [{ role: "user", content: "Reset password?" }],
  session_id: "ts_sess_1",
});
assert.ok(typeof routed.model === "string" && routed.model.length > 0);

const fb = await client.feedback.record([
  {
    inference_id: String(routed.inference_id),
    deployment_name: deploymentName,
    idempotency_key: "ts_contract_fb_1",
    score: 1.0,
  },
]);
assert.equal(fb.accepted, 1);

console.log("[ts-e2e] PASS");
