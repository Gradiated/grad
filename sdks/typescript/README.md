# @gradiated/grad

TypeScript SDK for the Gradiated training and serving platform: import traces,
train routers and fine-tunes, deploy, route, and record feedback. ESM with
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
const decision = await grad.route("support-router", {
  messages: [{ role: "user", content: "Where is invoice #9941?" }],
});
await decision.recordFeedback({ score: 1.0 });
```

Against a self-hosted server pass the URL explicitly:
`new Grad({ baseURL: "https://grad.internal.example", apiKey })`.

The same flow, nearly verbatim, runs in `test/live/*.live.test.ts` against a
real `grad-server` started by `tests/harness/stack.ts`.

## What is in the box

| Area | API |
| --- | --- |
| Datasets | `grad.datasets.create/get/list/push/records/render/fromHf`, `dataset.importFile(path).wait()` |
| Runs | `grad.runs.plan/create/get/list/cancel/resume`, `run.wait()`, `run.metrics({ follow: true })` (SSE with reconnect), `run.checkpoints()`, `checkpoint.promote()` |
| Recipes | `recipes.sft/dpo/router/decisionModel/cartridge/embedding/distill/rewardModel`, `rollouts`, `adapters`, `splits`, `Context` |
| Artifacts | `grad.artifacts.get/list/stream`, `artifact.download(dest)` (streams to disk, verifies SHA-256) |
| Serving | `grad.deployments.create/get/list/rollback`, `grad.route()`, `decision.recordFeedback()`, `grad.feedback.record()`, `grad.embeddings.create()` |
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
`RateLimitError`, `ServerError`, `DeployUnavailableError`; waits throw
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
