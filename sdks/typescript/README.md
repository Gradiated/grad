# @gradiated/grad

TypeScript SDK for the Gradiated training platform: import traces, train
routers and fine-tunes, evaluate them, and download or upload artifacts. ESM with
types, Node 20+. Browser-safe except the file helpers (`importFile`,
`download`, `Context.fromFile`), which load `node:fs` lazily.

```sh
npm install @gradiated/grad
grad local up --dev-models        # a server on this machine with tiny CPU test models (brew install gradiated/tap/grad)
export GRADIATED_PROFILE=local    # or GRADIATED_BASE_URL + GRADIATED_API_KEY for your own server
```

## Quickstart

```ts
import { Grad, recipes } from "@gradiated/grad";

const grad = new Grad(); // GRADIATED_PROFILE, else GRADIATED_API_KEY and GRADIATED_BASE_URL, else `grad login`
const dataset = await grad.datasets.push("sql-quickstart", [
  { messages: [{ role: "user", content: "Count active users." }, { role: "assistant", content: "SELECT count(*) FROM users WHERE active;" }] },
  { messages: [{ role: "user", content: "Revenue by plan." }, { role: "assistant", content: "SELECT plan, sum(amount_usd) FROM invoices GROUP BY plan;" }] },
]);
const recipe = recipes.sft({ model: "test/tiny-qwen3" }); // a dev model; on a GPU server e.g. "qwen/qwen3-8b"
console.log(await grad.runs.plan({ dataset, name: "sql-helper", recipe })); // $0 preview: defaults, warnings, cost
const run = await grad.runs.create({ dataset, name: "sql-helper", recipe, maxCostUsd: 5 }).wait();
console.log(run.status, run.artifactId); // completed sql-helper@2026-11-28-1
await run.download("./sql-helper.grad.tar.gz"); // the bundle, verified against its SHA-256
```

This runs in about 10 seconds on `grad local up --dev-models`; the live suite runs this block
verbatim against a real server (`test/live/self-hosted.live.test.ts`, "README quickstart").
`test/tiny-qwen3` has random weights, so its adapter is for trying the workflow; the same code on
a GPU server with a real base model trains a real adapter. The bundle is a `.tar.gz` of the PEFT
adapter (`adapter_config.json`, `adapter_model.safetensors`) and its manifest;
`run.download("./sql-helper", { extract: true })` writes the verified files instead (each checked
against the manifest's SHA-256), a directory vLLM and SGLang load.

Weights trained elsewhere become artifacts too:
`await grad.artifacts.upload("./my-lora", { base: "qwen/qwen3-8b" }).wait()` checks them against
the format spec and the base model.

Follow a run's lifecycle as typed events (narrow on `ev.type`; reconnects are
invisible, the stream ends after `completed`):

```ts
for await (const ev of grad.runs.events(run.id, { follow: true })) {
  if (ev.type === "phase") console.log(ev.phase, ev.workersOnline ?? "");
  else if (ev.type === "metric") console.log(ev.step, ev.metric?.loss);
  else if (ev.type === "attempt") console.log(ev.message); // "attempt 1 interrupted at step 120: the GPU was reclaimed; resuming from step 120 on a new worker"
}
// or: await run.wait({ onEvent: (ev) => ..., onStatus: (status, run) => console.log(status, run.phase) })
```

Self-hosted servers do not serve models: `artifact.download(dest)` and serve
the bundle yourself (vLLM, SGLang). Production feedback reaches training
through your observability tool and `grad sources`, not through this SDK.

Against a self-hosted server pass the URL explicitly:
`new Grad({ baseURL: "https://grad.internal.example", apiKey })`.

The same flow, nearly verbatim, runs in `test/live/*.live.test.ts` against a
real `grad-server` started by `tests/harness/stack.ts`.

## What is in the box

| Area | API |
| --- | --- |
| Datasets | `grad.datasets.create/get/list/push/records/render/fromHf`, `dataset.importFile(path).wait()` |
| Runs | `grad.runs.plan/create/get/list/cancel/resume`, `run.wait({ onEvent, onMetric, onStatus })`, `run.events({ follow: true })` (typed lifecycle events: phase, metric, checkpoint, attempt, warning, log, completed), `run.metrics({ follow: true })` (SSE with reconnect), `run.checkpoints()`, `checkpoint.promote()` |
| Recipes | `recipes.sft/dpo/router/decisionModel/cartridge/embedding/distill/rewardModel`, `rollouts`, `adapters`, `splits`, `Context` |
| Artifacts | `grad.artifacts.get/list/stream/delete`, `artifact.download(dest)` (streams to disk, verifies SHA-256), `grad.artifacts.upload(path, { base }).wait()` and `grad.artifacts.fromHf("hf://owner/name@rev", { base }).wait()` (an `ArtifactImportFailedError`, `code` `invalid_artifact` and `status` 422, names the file that failed validation), `artifact.provenance` |
| Evals | `grad.evals.plan/create/get/list`, `ev.wait()` (runs local scorers), `ev.summaryTable()`, `(await ev.failures()).toDataset(name)`; `Rubric`, `Scorer`, `Judge`, `validators` |
| Keys, models | `grad.keys.create/list/revoke`, `grad.models.list()` |
| Low level | `grad.api`: one typed method per OpenAPI operation |

List calls return a `Paginator`: `await` it for the first page, `for await`
it for every item, or `.all()` (bounded, 100,000 items by default). A server
that repeats a cursor stops the listing with `PaginationLoopError`.

## Errors, retries, timeouts

Every error extends `GradError` (`status`, `code`, `requestId`). HTTP errors
map to `BadRequestError`, `AuthenticationError`, `PermissionDeniedError`,
`NotFoundError`, `ConflictError`, `ValidationError` (`fieldErrors`),
`RateLimitError`, `ServerError`, `FeatureUnavailableError` (501, never retried) and its
`InferenceUnavailableError`; waits throw
`RunFailedError`, `EvalFailedError`, `ImportFailedError`, `ArtifactImportFailedError` or
`WaitTimeoutError`. Requests retry twice on 408/429/5xx with jittered
backoff that honours `Retry-After`, except a 429 `queue_limit` (the workspace's
queued-jobs cap), which throws `QueueLimitError` (a `RateLimitError`) at once; every POST carries one `Idempotency-Key`
(a UUIDv4, or `{ idempotencyKey }`) across its retries, so the server replays
the first response instead of running it twice. Redirects that leave the API
origin are refused, so the key is never sent elsewhere. `timeoutMs` (default
60 s) bounds each attempt; downloads and SSE streams use an idle timeout
instead. Every call accepts `{ signal }` to abort.

## Development

```sh
pnpm install --frozen-lockfile
pnpm check        # tsc + unit tests with coverage (>= 90% lines)
pnpm test:live    # needs `pnpm -C ../../server/api install`; skips otherwise
pnpm build
```

`src/generated/` is written by `node scripts/generate-sdks.mjs` from
`spec/openapi.yaml`; do not edit it by hand.
