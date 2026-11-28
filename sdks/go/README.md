# grad (Go)

Go SDK for the Gradiated training platform. Standard library only;
Go 1.24+ (iterators).

```sh
go get github.com/Gradiated/grad/sdks/go
grad local up --dev-models        # a server on this machine with tiny CPU test models (brew install gradiated/tap/grad)
export GRADIATED_PROFILE=local    # or GRADIATED_BASE_URL + GRADIATED_API_KEY for your own server
```

## Quickstart

```go
package main

import (
	"context"
	"fmt"
	"log"

	grad "github.com/Gradiated/grad/sdks/go"
)

func main() {
	ctx := context.Background()
	client := grad.NewClient() // GRADIATED_PROFILE, else GRADIATED_API_KEY and GRADIATED_BASE_URL, else `grad login`
	dataset, err := client.Datasets.Push(ctx, "sql-quickstart", []grad.Trajectory{
		{Messages: []grad.Message{{Role: "user", Content: "Count active users."}, {Role: "assistant", Content: "SELECT count(*) FROM users WHERE active;"}}},
		{Messages: []grad.Message{{Role: "user", Content: "Revenue by plan."}, {Role: "assistant", Content: "SELECT plan, sum(amount_usd) FROM invoices GROUP BY plan;"}}},
	})
	if err != nil {
		log.Fatal(err)
	}
	params := grad.RunParams{Dataset: dataset, Name: "sql-helper", MaxCostUSD: 5,
		Recipe: grad.SFTRecipe{Common: grad.Common{Model: "test/tiny-qwen3"}}} // a dev model; on a GPU server e.g. "qwen/qwen3-8b"
	plan, err := client.Runs.Plan(ctx, params) // $0 preview: defaults, warnings, cost
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(plan)
	run, err := client.Runs.Create(ctx, params).Wait(ctx)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(run.Status, *run.ArtifactID) // completed sql-helper@2026-11-28-1
	if _, err := run.Download(ctx, "./sql-helper.grad.tar.gz"); err != nil { // the bundle, verified against its SHA-256
		log.Fatal(err)
	}
}
```

This runs in about 10 seconds on `grad local up --dev-models`; `live_test.go`
(`TestLiveSelfHosted/README_quickstart_verbatim`) builds and runs this block verbatim against a real server.
`test/tiny-qwen3` has random weights, so its adapter is for trying the workflow; the same code on
a GPU server with a real base model trains a real adapter. The bundle is a `.tar.gz` of the PEFT
adapter and its manifest; `run.Download(ctx, "./sql-helper", grad.Extract())` writes the verified
files instead (every file checked against the manifest's SHA-256), a directory vLLM and SGLang load.

Against a self-hosted server:
`grad.NewClient(grad.WithBaseURL("https://grad.internal.example"), grad.WithAPIKey(key))`.

`live_test.go` runs this flow (and evals, keys, downloads, artifact uploads) against a
real `grad-server` started by `tests/harness/stack.ts`; `example_test.go`
compiles every Go snippet of the public docs.

## Surface

- Services: `client.Datasets`, `Imports`, `Runs`, `Checkpoints`, `Artifacts`
  (`Get`, `List`, `Download`, `Delete`, `Upload`, `FromHF`, `WaitImport`),
  `Evals`, `Keys`, `Models`. `client.API` is the generated client (one method
  per operation).
- `c.Artifacts.Upload(ctx, "./my-lora", grad.UploadParams{Base: "qwen/qwen3-8b"})`
  and `c.Artifacts.FromHF(ctx, "hf://owner/name@rev", grad.FromHFParams{...})`
  return an `*ArtifactImport`; its `Wait(ctx)` returns the `*Artifact`, or a
  `*grad.ArtifactImportFailedError` (`Code` `invalid_artifact`, `Status` 422)
  naming the file that failed validation.
- Serving, inference and feedback are not part of the SDK: Gradiated Cloud
  publishes artifacts as model versions, and scores go to your observability tool.
- Recipes implement `grad.Recipe`: `SFTRecipe`, `DPORecipe`, `RouterRecipe`,
  `DecisionModelRecipe`, `CartridgeRecipe`, `EmbeddingRecipe`, `DistillRecipe`,
  `RewardModelRecipe` and `RawRecipe`.
  Shared settings live in the embedded `grad.Common`
  (`grad.DPORecipe{Common: grad.Common{Model: sft.Artifact.Ref()}, Beta: 0.3}`).
- `RunParams.IdempotencyKey`, `EvalParams.IdempotencyKey`,
  `UploadParams.IdempotencyKey` and `FromHFParams.IdempotencyKey` make a
  retried create return the first result.
- Waiting: `Wait(ctx, opts...)` on runs, imports and evals, with
  `WithWaitTimeout`, `WithOnStatus` (status or phase changes), `WithOnMetric`,
  `WithOnEvent` (follows the run's event stream), `WithRubric`.
- `run.Events(ctx, grad.EventsOptions{Follow: true})` (or
  `c.Runs.Events(ctx, id, ...)`) is an `iter.Seq2[grad.RunEvent, error]` of
  typed lifecycle events: switch on `ev.Type` (`grad.EventPhase`,
  `EventMetric`, `EventCheckpoint`, `EventAttempt`, `EventWarning`, `EventLog`,
  `EventCompleted`). Reconnects with `Last-Event-ID` are invisible; the
  iterator ends after `completed`.
- Lists are `iter.Seq2[T, error]`; `grad.Collect` drains one. A repeated cursor
  ends the listing with `grad.ErrPaginationLoop`.
- `run.Metrics(ctx, true)` streams Server-Sent Events and reconnects with
  `Last-Event-ID`; `Artifacts.Download` streams to disk and verifies SHA-256
  (`grad.ErrChecksumMismatch`).

## Errors

Every error unwraps to `*grad.GradError` (`Status`, `Code`, `RequestID`); use
`errors.As` with `*grad.NotFoundError`, `*grad.ValidationError`,
`*grad.RateLimitError`, `*grad.ArtifactImportFailedError`, `*grad.RunFailedError`
and friends. Requests retry twice on 408/429/5xx with jittered backoff
honouring `Retry-After`, except a 429 `queue_limit` (the workspace's queued-jobs cap), which
returns `*grad.QueueLimitError` at once; every POST carries one `Idempotency-Key` (a UUIDv4, or
`generated.WithIdempotencyKey` on `client.API` calls) across its retries, so the server replays the
first response instead of running it twice. Redirects that leave the API origin
are refused.

## Development

```sh
go vet ./...
go test -cover ./...   # live tests skip without server/api/node_modules, or with -short
```
