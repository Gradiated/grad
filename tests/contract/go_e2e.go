// Cross-language Go SDK E2E contract check against live grad-server.
package main

import (
	"context"
	"fmt"
	"os"

	grad "github.com/Gradiated/grad/sdks/go"
)

func mustFloat64(m map[string]any, key string) float64 {
	v, ok := m[key].(float64)
	if !ok {
		panic(fmt.Errorf("expected float64 for %q in %#v", key, m))
	}
	return v
}

func mustString(m map[string]any, key string) string {
	v, ok := m[key].(string)
	if !ok || v == "" {
		panic(fmt.Errorf("expected non-empty string for %q in %#v", key, m))
	}
	return v
}

func main() {
	baseURL := os.Getenv("GRAD_BASE_URL")
	artifactRef := os.Getenv("GRAD_ARTIFACT_REF")
	deploymentName := os.Getenv("GRAD_DEPLOYMENT_NAME")
	if baseURL == "" || artifactRef == "" || deploymentName == "" {
		panic("GRAD_BASE_URL, GRAD_ARTIFACT_REF, and GRAD_DEPLOYMENT_NAME must be set")
	}

	ctx := context.Background()
	client := grad.New(baseURL)

	ds, err := client.PushDataset(ctx, "go-contract-ds", []map[string]any{
		{
			"session_id": "go_1",
			"messages": []map[string]any{
				{"role": "user", "content": "Where is my invoice?"},
				{"role": "assistant", "content": "Billing -> Invoices."},
			},
		},
	})
	if err != nil {
		panic(fmt.Errorf("PushDataset: %w", err))
	}
	if int(mustFloat64(ds, "record_count")) != 1 {
		panic(fmt.Errorf("unexpected record_count: %#v", ds))
	}

	plan, err := client.PlanRun(ctx, "go-contract-ds", "go-sft", grad.SFTRecipe("qwen/qwen3-8b"), nil)
	if err != nil {
		panic(fmt.Errorf("PlanRun: %w", err))
	}
	if mustFloat64(plan, "estimated_steps") < 1 {
		panic(fmt.Errorf("expected estimated_steps >= 1: %#v", plan))
	}

	bytes, err := client.DownloadArtifact(ctx, artifactRef)
	if err != nil {
		panic(fmt.Errorf("DownloadArtifact: %w", err))
	}
	if len(bytes) < 20 {
		panic("downloaded artifact too small")
	}

	routed, err := client.Route(ctx, deploymentName, []map[string]any{
		{"role": "user", "content": "Reset password?"},
	}, "go_sess_1")
	if err != nil {
		panic(fmt.Errorf("Route: %w", err))
	}
	_ = mustString(routed, "model")

	fb, err := client.RecordFeedback(ctx, []map[string]any{
		{
			"inference_id":    mustString(routed, "inference_id"),
			"deployment_name": deploymentName,
			"idempotency_key": "go_contract_fb_1",
			"score":           1.0,
		},
	})
	if err != nil {
		panic(fmt.Errorf("RecordFeedback: %w", err))
	}
	if int(mustFloat64(fb, "accepted")) != 1 {
		panic(fmt.Errorf("expected feedback accepted == 1: %#v", fb))
	}

	fmt.Println("[go-e2e] PASS")
}
