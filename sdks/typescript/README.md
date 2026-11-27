# @gradiated/grad

TypeScript SDK for the Gradiated training platform: import traces, train
routers and fine-tunes, evaluate them, and deploy to Gradiated Cloud. ESM with
types, Node 20+. Browser-safe except the file helpers (`importFile`,
`download`, `Context.fromFile`), which load `node:fs` lazily.

```sh
npm install @gradiated/grad
```

## Quickstart

```ts
import { Grad, recipes } from "@gradiated/grad";

// GRADIATED_API_KEY and GRADIATED_BASE_URL, else the profile `grad login` wrote.
const grad = new Grad();

const dataset = await grad.datasets.create("support-prod");
await dataset.importFile("./support_traces.jsonl").wait();

const run = await grad.runs
  .create({ dataset, name: "support-router", recipe: recipes.router() })
  .wait({ onMetric: (m) => console.log(m.step, m.loss) });

await run.deploy(); // Cloud; a self-hosted server raises DeployUnavailableError
await grad.deployments.rollback("support-router"); // back to the previous artifact
```

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
| Artifacts | `grad.artifacts.get/list/stream`, `artifact.download(dest)` (streams to disk, verifies SHA-256) |
| Deploy (Cloud) | `grad.deploy()` / `run.deploy()` / `artifact.deploy()` (= `grad.deployments.create`), `grad.deployments.get/list/rollback` |
| Evals | `grad.evals.plan/create/get/list`, `ev.wait()` (runs local scorers), `ev.summaryTable()`, `ev.failures().toDataset()`; `Rubric`, `Scorer`, `Judge`, `validators` |
| Keys, models | `grad.keys.create/list/revoke`, `grad.models.list()` |
| Low level | `grad.api`: one typed method per OpenAPI operation |

List calls return a `Paginator`: `await` it for the first page, `for await`
it for every item, or `.all()` (bounded, 100,000 items by default). A server
that repeats a cursor stops the listing with `PaginationLoopError`.

## Errors, retries, timeouts

Every error extends `GradError` (`status`, `code`, `requestId`). HTTP errors
map to `BadRequestError`, `AuthenticationError`, `PermissionDeniedError`,
`NotFoundError`, `ConflictError`, `ValidationError` (`fieldErrors`),
`RateLimitError`, `ServerError`, `DeployUnavailableError`,
`InferenceUnavailableError`; waits throw
`RunFailedError`, `EvalFailedError`, `ImportFailedError` or
`WaitTimeoutError`. Requests retry twice on 408/429/5xx with jittered
backoff that honours `Retry-After`; every POST carries one `Idempotency-Key`
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
