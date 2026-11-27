// Package grad is the Go SDK for the Gradiated training and serving platform.
//
// Create a client; it reads GRADIATED_API_KEY and GRADIATED_BASE_URL, then the
// profile `grad login` wrote to $XDG_CONFIG_HOME/gradiated/config.json, and
// defaults to https://api.gradiated.com:
//
//	ctx := context.Background()
//	client := grad.NewClient()
//	dataset, _ := client.Datasets.Create(ctx, "support-prod")
//	dataset.ImportFile(ctx, "./support_traces.jsonl").Wait(ctx)
//
//	run, err := client.Runs.Create(ctx, grad.RunParams{
//		Dataset: dataset,
//		Name:    "support-router",
//		Recipe:  grad.RouterRecipe{},
//	}).Wait(ctx)
//	if err != nil {
//		log.Fatal(err)
//	}
//	_, _ = run.Download(ctx, "./support-router")
//
// Every error unwraps to *GradError (status, code, request id); match specific
// cases with errors.As and types such as *NotFoundError, *ValidationError,
// *RateLimitError, *RunFailedError, *ArtifactImportFailedError or
// *ChecksumMismatchError. Idempotent requests are retried twice on 408, 429
// and 5xx with jittered backoff honouring Retry-After; POSTs only on 429 or
// when the connection never opened. A 429 queue_limit (the workspace's
// queued-jobs cap) is never retried: it returns *QueueLimitError. Redirects that leave the API origin are
// refused so the API key is never sent elsewhere.
//
// The generated package (github.com/Gradiated/grad/sdks/go/generated), exposed
// as Client.API, has one typed method per OpenAPI operation.
package grad
