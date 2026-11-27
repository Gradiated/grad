# grad (Go)

Go SDK for the Gradiated training and serving platform. Standard library only;
Go 1.24+ (iterators).

```sh
go get github.com/Gradiated/grad/sdks/go
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
	// GRADIATED_API_KEY and GRADIATED_BASE_URL, else the profile `grad login` wrote.
	client := grad.NewClient()

	dataset, err := client.Datasets.Create(ctx, "support-prod")
	if err != nil {
		log.Fatal(err)
	}
	if _, err := dataset.ImportFile(ctx, "./support_traces.jsonl").Wait(ctx); err != nil {
		log.Fatal(err)
	}

	run, err := client.Runs.Create(ctx, grad.RunParams{
		Dataset: dataset,
		Name:    "support-router",
		Recipe:  grad.RouterRecipe{},
	}).Wait(ctx, grad.WithOnMetric(func(m grad.MetricPoint) { fmt.Println(m.Step, m.Loss) }))
	if err != nil {
		log.Fatal(err)
	}

	// The PEFT LoRA, verified against its SHA-256, for vLLM or SGLang.
	if _, err := run.Download(ctx, "./support-router"); err != nil {
		log.Fatal(err)
	}
}
```

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
honouring `Retry-After`; every POST carries one `Idempotency-Key` (a UUIDv4, or
`generated.WithIdempotencyKey` on `client.API` calls) across its retries, so the server replays the
first response instead of running it twice. Redirects that leave the API origin
are refused.

## Development

```sh
go vet ./...
go test -cover ./...   # live tests skip without server/api/node_modules, or with -short
```
