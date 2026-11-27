#!/usr/bin/env node
/**
 * Re-captures the shared wire fixtures from a live stack (tests/harness/stack.ts
 * with the reference worker), so SDK unit tests replay real server shapes.
 *
 *   node tests/fixtures/wire/capture.mjs        # needs `pnpm -C server/api install`
 *
 * Deployment/route/feedback bodies need Cloud serving and a deployable artifact;
 * they are captured from a second `--cloud --worker torch` stack only when
 * GRAD_TRAINER_PYTHON points at the trainer venv, otherwise kept as committed.
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const apiDir = path.join(repo, "server", "api");

const bootStack = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn(path.join(apiDir, "node_modules", ".bin", "tsx"), ["../../tests/harness/stack.ts", ...args], {
      cwd: apiDir,
      stdio: ["pipe", "pipe", "inherit"],
    });
    const lines = createInterface({ input: child.stdout });
    lines.once("line", (line) => resolve({ child, info: JSON.parse(line) }));
    child.once("exit", (code) => reject(new Error(`stack exited ${code}`)));
  });

const write = (name, value) => {
  const text = typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path.join(here, name), text);
  console.log(`wrote ${name}`);
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const main = async () => {
  const { child, info } = await bootStack(["--worker", "reference"]);
  const base = info.base_url;
  const auth = { authorization: `Bearer ${info.api_key}` };
  const call = async (method, p, body, headers = {}) => {
    const res = await fetch(`${base}${p}`, {
      method,
      headers: { ...auth, ...(body ? { "content-type": "application/json" } : {}), ...headers },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, headers: Object.fromEntries(res.headers), text, json: text ? JSON.parse(text) : undefined };
  };
  const ok = async (method, p, body) => {
    const r = await call(method, p, body);
    if (r.status >= 300) throw new Error(`${method} ${p} -> ${r.status} ${r.text}`);
    return r.json;
  };
  const problem = async (name, method, p, body, headers) => {
    const r = await call(method, p, body, headers);
    write(`problem-${name}.json`, {
      status: r.status,
      headers: { "content-type": r.headers["content-type"], "x-request-id": r.headers["x-request-id"] },
      body: r.json,
    });
  };

  try {
    write("models.json", await ok("GET", "/v1/models"));
    write("dataset-created.json", await ok("POST", "/v1/datasets", { name: "support-prod", metadata: { team: "support" } }));
    const records = [
      { session_id: "s1", messages: [{ role: "user", content: "Reset my password?" }, { role: "assistant", content: "Settings -> Security." }], scores: { resolved: 1 } },
      { session_id: "s2", messages: [{ role: "user", content: "Where is invoice #9941?" }, { role: "assistant", content: "Billing -> Invoices." }], metadata: { model: "qwen/qwen3-8b" } },
      { session_id: "s3", messages: [{ role: "user", content: "Cancel my plan" }, { role: "assistant", content: "Billing -> Plan -> Cancel." }] },
    ];
    write("dataset.json", await ok("POST", "/v1/datasets/support-prod/records", { records }));
    await ok("POST", "/v1/datasets", { name: "support-eval" });
    await ok("POST", "/v1/datasets/support-eval/records", { records });
    const page1 = await ok("GET", "/v1/datasets?limit=1");
    write("datasets-page-1.json", page1);
    write("datasets-page-2.json", await ok("GET", `/v1/datasets?limit=1&cursor=${encodeURIComponent(page1.next_cursor)}`));
    write("dataset-records-page.json", await ok("GET", "/v1/datasets/support-prod/records?limit=2"));

    const jsonl = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
    const sha256 = createHash("sha256").update(jsonl).digest("hex");
    const ticket = await ok("POST", "/v1/uploads", { purpose: "dataset_import", filename: "traces.jsonl", size_bytes: Buffer.byteLength(jsonl), sha256 });
    write("upload-ticket.json", ticket);
    const put = await fetch(new URL(ticket.url, base), { method: "PUT", headers: ticket.headers, body: jsonl });
    if (!put.ok) throw new Error(`upload PUT ${put.status} ${await put.text()}`);
    const job = await ok("POST", "/v1/datasets/support-prod/imports", { source: { kind: "upload", upload_id: ticket.upload_id, format: "jsonl" } });
    write("import-job-queued.json", job);
    let imported = job;
    for (let i = 0; i < 200 && !["completed", "failed"].includes(imported.status); i += 1) {
      await sleep(200);
      imported = await ok("GET", `/v1/imports/${job.id}`);
    }
    write("import-job-completed.json", imported);

    const runBody = { dataset: "support-prod", name: "support-sft", recipe: { kind: "sft", model: "test/tiny-qwen3", batch_size: 1 }, max_cost_usd: 5 };
    write("plan-run.json", await ok("POST", "/v1/runs/plan", runBody));
    const run = await ok("POST", "/v1/runs", runBody);
    write("run-queued.json", run);
    let done = run;
    for (let i = 0; i < 300 && !["completed", "failed", "cancelled", "stopped_budget"].includes(done.status); i += 1) {
      await sleep(200);
      done = await ok("GET", `/v1/runs/${run.id}`);
    }
    write("run-completed.json", done);
    write("metrics-page.json", await ok("GET", `/v1/runs/${run.id}/metrics`));
    const sse = await fetch(`${base}/v1/runs/${run.id}/metrics`, { headers: { ...auth, accept: "text/event-stream" } });
    write("metrics.sse", await sse.text());
    write("checkpoints.json", await ok("GET", `/v1/runs/${run.id}/checkpoints`));
    write("runs-page.json", await ok("GET", "/v1/runs"));
    write("artifact.json", await ok("GET", `/v1/artifacts/${done.artifact_id}`));
    write("artifacts-page.json", await ok("GET", "/v1/artifacts?name=support-sft"));

    const evalBody = {
      name: "support-eval",
      models: ["test/tiny-qwen3", "qwen/qwen3-8b"],
      baseline: "qwen/qwen3-8b",
      dataset: "support-eval",
      rubric: [
        { name: "non_empty", kind: "validator", validator: "non_empty", weight: 1 },
        { name: "mentions_menu", kind: "code", runtime: "local", weight: 1 },
      ],
      samples: 1,
    };
    write("plan-eval.json", await ok("POST", "/v1/evals/plan", evalBody));
    const ev = await ok("POST", "/v1/evals", evalBody);
    let waiting = ev;
    for (let i = 0; i < 200 && !["awaiting_scores", "completed", "failed"].includes(waiting.status); i += 1) {
      await sleep(200);
      waiting = await ok("GET", `/v1/evals/${ev.id}`);
    }
    write("eval-awaiting-scores.json", waiting);
    const outputs = await ok("GET", `/v1/evals/${ev.id}/outputs?missing_scorer=mentions_menu`);
    write("eval-outputs.json", outputs);
    const scored = await ok("POST", `/v1/evals/${ev.id}/scores`, {
      scores: outputs.data.map((o, i) => ({ output_id: o.id, scorer: "mentions_menu", score: i % 2 })),
    });
    write("eval-scores-response.json", scored);
    let completed = waiting;
    for (let i = 0; i < 200 && !["completed", "failed"].includes(completed.status); i += 1) {
      await sleep(200);
      completed = await ok("GET", `/v1/evals/${ev.id}`);
    }
    write("eval-completed.json", completed);
    write("eval-results.json", await ok("GET", `/v1/evals/${ev.id}/results`));
    write("eval-failures.json", await ok("GET", `/v1/evals/${ev.id}/failures?threshold=0.5`));

    write("api-key-created.json", await ok("POST", "/v1/keys", { name: "ci", scopes: ["runs:read"] }));
    write("api-keys-page.json", await ok("GET", "/v1/keys"));

    await problem("not-found", "GET", "/v1/runs/run_missing");
    await problem("validation", "POST", "/v1/runs", { dataset: "support-prod", name: "Bad Name!", recipe: { kind: "sft", batch_size: -1 } });
    await problem("unauthorized", "GET", "/v1/runs", undefined, { authorization: "Bearer wrong" });
    await problem("deploy-unavailable", "POST", "/v1/deployments", { artifact: done.artifact_id });
    await problem("conflict", "POST", "/v1/datasets", { name: "support-prod" });
  } finally {
    child.stdin.end();
    child.kill("SIGTERM");
  }
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
