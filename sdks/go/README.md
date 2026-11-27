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

	// Cloud; a self-hosted server returns *grad.DeployUnavailableError.
	if _, err := run.Deploy(ctx); err != nil {
		log.Fatal(err)
	}
	decision, err := client.Route(ctx, "support-router", grad.RouteInput{
		Messages: []grad.Message{{Role: "user", Content: "Where is invoice #9941?"}},
	})
	if err != nil {
		log.Fatal(err)
	}
	_ = decision.RecordFeedback(ctx, grad.Feedback{Score: 1.0})
}
```

Against a self-hosted server:
`grad.NewClient(grad.WithBaseURL("https://grad.internal.example"), grad.WithAPIKey(key))`.

`live_test.go` runs this flow (and evals, keys, downloads, rollback) against a
real `grad-server` started by `tests/harness/stack.ts`; `example_test.go`
compiles every Go snippet of the public docs.

## Surface

- Services: `client.Datasets`, `Imports`, `Runs`, `Checkpoints`, `Artifacts`,
  `Deployments`, `Feedback`, `Embeddings`, `Evals`, `Keys`, `Models`, plus
  `client.Route`. `client.API` is the generated client (one method per operation).
- Recipes implement `grad.Recipe`: `SFTRecipe`, `DPORecipe`, `RouterRecipe`,
  `DecisionModelRecipe`, `CartridgeRecipe`, `EmbeddingRecipe`, `DistillRecipe`,
  `RewardModelRecipe`, `GRPORecipe`, `RawRecipe`.
- Waiting: `Wait(ctx, opts...)` on runs, imports and evals, with
  `WithWaitTimeout`, `WithOnStatus`, `WithOnMetric`, `WithRubric`.
- Lists are `iter.Seq2[T, error]`; `grad.Collect` drains one. A repeated cursor
  ends the listing with `grad.ErrPaginationLoop`.
- `run.Metrics(ctx, true)` streams Server-Sent Events and reconnects with
  `Last-Event-ID`; `Artifacts.Download` streams to disk and verifies SHA-256
  (`grad.ErrChecksumMismatch`).

## Errors

Every error unwraps to `*grad.GradError` (`Status`, `Code`, `RequestID`); use
`errors.As` with `*grad.NotFoundError`, `*grad.ValidationError`,
`*grad.RateLimitError`, `*grad.DeployUnavailableError`, `*grad.RunFailedError`
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
