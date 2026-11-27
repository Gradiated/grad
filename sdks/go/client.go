// Package grad provides an idiomatic Go SDK wrapping the OpenAPI-generated wire client.
package grad

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// Option configures a Grad Client.
type Option func(*Client)

// WithAPIKey sets the Bearer API key.
func WithAPIKey(key string) Option {
	return func(c *Client) { c.Wire.APIKey = key }
}

// WithHTTPClient injects a custom *http.Client.
func WithHTTPClient(hc *http.Client) Option {
	return func(c *Client) {
		if hc != nil {
			c.Wire.HTTPClient = hc
		}
	}
}

// Client is the high-level Gradiated Go SDK client.
type Client struct {
	Wire *generated.Client
}

// New constructs a Client pointing at baseURL.
func New(baseURL string, opts ...Option) *Client {
	c := &Client{Wire: generated.NewClient(baseURL, "", nil)}
	for _, opt := range opts {
		if opt != nil {
			opt(c)
		}
	}
	return c
}

// ListModels returns the catalog of trainable models.
func (c *Client) ListModels(ctx context.Context) (map[string]any, error) {
	return c.Wire.ListModels(ctx)
}

// PushDataset uploads or appends records to a named dataset.
func (c *Client) PushDataset(ctx context.Context, name string, records []map[string]any) (map[string]any, error) {
	return c.Wire.PushDatasetRecords(ctx, name, map[string]any{"records": records})
}

// PlanRun dry-runs a training recipe and returns cost and step estimates.
func (c *Client) PlanRun(ctx context.Context, dataset, name string, recipe map[string]any, maxCostUSD *float64) (map[string]any, error) {
	body := map[string]any{"dataset": dataset, "name": name, "recipe": recipe}
	if maxCostUSD != nil {
		body["max_cost_usd"] = *maxCostUSD
	}
	return c.Wire.PlanRun(ctx, body)
}

// CreateRun enqueues a training run.
func (c *Client) CreateRun(ctx context.Context, dataset, name string, recipe map[string]any, maxCostUSD *float64) (map[string]any, error) {
	body := map[string]any{"dataset": dataset, "name": name, "recipe": recipe}
	if maxCostUSD != nil {
		body["max_cost_usd"] = *maxCostUSD
	}
	return c.Wire.CreateRun(ctx, body)
}

// GetRun returns run metadata and status.
func (c *Client) GetRun(ctx context.Context, runID string) (map[string]any, error) {
	return c.Wire.GetRun(ctx, runID)
}

// CancelRun requests cancellation of a run.
func (c *Client) CancelRun(ctx context.Context, runID string) (map[string]any, error) {
	return c.Wire.CancelRun(ctx, runID)
}

// ResumeRun re-queues a stopped, failed, or cancelled run.
func (c *Client) ResumeRun(ctx context.Context, runID string, maxCostUSD *float64) (map[string]any, error) {
	body := map[string]any{}
	if maxCostUSD != nil {
		body["max_cost_usd"] = *maxCostUSD
	}
	return c.Wire.ResumeRun(ctx, runID, body)
}

// WaitRun polls GetRun until the run reaches a terminal state or ctx is cancelled.
func (c *Client) WaitRun(ctx context.Context, runID string, pollInterval time.Duration) (map[string]any, error) {
	if pollInterval < 50*time.Millisecond {
		pollInterval = 500 * time.Millisecond
	}
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		run, err := c.Wire.GetRun(ctx, runID)
		if err != nil {
			return nil, err
		}
		if status, _ := run["status"].(string); status == "completed" || status == "failed" || status == "cancelled" || status == "stopped_budget" {
			return run, nil
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-ticker.C:
		}
	}
}

// ListRunMetrics retrieves training step metrics after afterStep.
func (c *Client) ListRunMetrics(ctx context.Context, runID string, afterStep int) (map[string]any, error) {
	return c.Wire.ListRunMetrics(ctx, runID, map[string]string{"after_step": strconv.Itoa(afterStep)})
}

// DownloadArtifact fetches an artifact archive and verifies X-Artifact-Sha256 (fail-closed).
func (c *Client) DownloadArtifact(ctx context.Context, reference string) ([]byte, error) {
	data, headers, err := c.Wire.DownloadArtifact(ctx, reference)
	if err != nil {
		return nil, err
	}
	expected := strings.TrimSpace(headers.Get("X-Artifact-Sha256"))
	if len(expected) != 64 {
		return nil, fmt.Errorf("artifact download missing valid X-Artifact-Sha256 header")
	}
	sum := sha256.Sum256(data)
	actual := hex.EncodeToString(sum[:])
	if !strings.EqualFold(expected, actual) {
		return nil, fmt.Errorf("artifact sha256 mismatch: expected %s, got %s", expected, actual)
	}
	return data, nil
}

// Deploy activates an artifact under a stable deployment name.
func (c *Client) Deploy(ctx context.Context, artifact, fallback string, exploreRate float64) (map[string]any, error) {
	body := map[string]any{"artifact": artifact, "explore_rate": exploreRate}
	if fallback != "" {
		body["fallback"] = fallback
	}
	return c.Wire.DeployArtifact(ctx, body)
}

// Route asks a deployed router which model to call.
func (c *Client) Route(ctx context.Context, deployment string, messages []map[string]any, sessionID string) (map[string]any, error) {
	body := map[string]any{"deployment": deployment, "messages": messages}
	if sessionID != "" {
		body["session_id"] = sessionID
	}
	return c.Wire.RouteRequest(ctx, body)
}

// Embed computes embeddings for one or more texts.
func (c *Client) Embed(ctx context.Context, model string, inputs []string) (map[string]any, error) {
	return c.Wire.CreateEmbeddings(ctx, map[string]any{"model": model, "input": inputs})
}

// RecordFeedback records deduplicated outcome feedback events.
func (c *Client) RecordFeedback(ctx context.Context, events []map[string]any) (map[string]any, error) {
	return c.Wire.RecordFeedback(ctx, map[string]any{"events": events})
}

// PlanEval estimates calls and cost before running an evaluation.
func (c *Client) PlanEval(ctx context.Context, req map[string]any) (map[string]any, error) {
	return c.Wire.PlanEval(ctx, req)
}

// CreateEval executes a standalone evaluation.
func (c *Client) CreateEval(ctx context.Context, req map[string]any) (map[string]any, error) {
	return c.Wire.CreateEval(ctx, req)
}

// ListEvalFailures retrieves failing task records for mining into a new dataset.
func (c *Client) ListEvalFailures(ctx context.Context, evalID, model string, threshold float64) (map[string]any, error) {
	q := map[string]string{"threshold": strconv.FormatFloat(threshold, 'f', -1, 64)}
	if model != "" {
		q["model"] = model
	}
	return c.Wire.ListEvalFailures(ctx, evalID, q)
}
