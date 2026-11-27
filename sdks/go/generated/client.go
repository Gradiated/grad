// Code generated from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.

package generated

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// APIError represents an RFC 7807 problem+json response from grad-server.
type APIError struct {
	Status    int    `json:"status"`
	Code      string `json:"code"`
	Title     string `json:"title"`
	Detail    string `json:"detail"`
	RequestID string `json:"request_id"`
}

func (e *APIError) Error() string {
	return fmt.Sprintf("[%d] %s: %s", e.Status, e.Code, e.Detail)
}

// Client is the generated low-level wire client for grad-server.
type Client struct {
	BaseURL    string
	APIKey     string
	HTTPClient *http.Client
}

// NewClient creates a generated wire client with a 30s default timeout.
func NewClient(baseURL, apiKey string, httpClient *http.Client) *Client {
	if httpClient == nil {
		httpClient = &http.Client{Timeout: 30 * time.Second}
	}
	return &Client{
		BaseURL:    strings.TrimRight(baseURL, "/"),
		APIKey:     apiKey,
		HTTPClient: httpClient,
	}
}

func (c *Client) send(ctx context.Context, method, routePath string, body any, query map[string]string) ([]byte, http.Header, int, error) {
	fullURL := c.BaseURL + routePath
	if len(query) > 0 {
		vals := url.Values{}
		for k, v := range query {
			if v != "" {
				vals.Set(k, v)
			}
		}
		if encoded := vals.Encode(); encoded != "" {
			fullURL += "?" + encoded
		}
	}

	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, nil, 0, err
		}
		reader = bytes.NewReader(raw)
	}

	req, err := http.NewRequestWithContext(ctx, method, fullURL, reader)
	if err != nil {
		return nil, nil, 0, err
	}
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	resp, err := c.HTTPClient.Do(req)
	if err != nil {
		return nil, nil, 0, err
	}
	defer resp.Body.Close()

	payload, err := io.ReadAll(resp.Body)
	if err != nil {
		return nil, nil, resp.StatusCode, err
	}

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		apiErr := &APIError{Status: resp.StatusCode, Code: "api_error", Detail: string(payload)}
		_ = json.Unmarshal(payload, apiErr)
		if apiErr.Status == 0 {
			apiErr.Status = resp.StatusCode
		}
		return nil, resp.Header, resp.StatusCode, apiErr
	}

	return payload, resp.Header, resp.StatusCode, nil
}

func (c *Client) doJSON(ctx context.Context, method, routePath string, body any, query map[string]string) (map[string]any, error) {
	payload, _, status, err := c.send(ctx, method, routePath, body, query)
	if err != nil {
		return nil, err
	}
	if status == http.StatusNoContent || status == http.StatusResetContent || len(bytes.TrimSpace(payload)) == 0 {
		return map[string]any{}, nil
	}
	var out map[string]any
	if err := json.Unmarshal(payload, &out); err != nil {
		return nil, err
	}
	return out, nil
}

func (c *Client) doBytes(ctx context.Context, method, routePath string, body any, query map[string]string) ([]byte, http.Header, error) {
	payload, headers, _, err := c.send(ctx, method, routePath, body, query)
	return payload, headers, err
}

// CancelEval: Cancel a queued, running or awaiting_scores evaluation
func (c *Client) CancelEval(ctx context.Context, id string) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/evals/%s/cancel", url.PathEscape(id)), nil, nil)
}

// CancelRun: Cancel a training run (a running attempt is stopped and billed)
func (c *Client) CancelRun(ctx context.Context, id string) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/runs/%s/cancel", url.PathEscape(id)), nil, nil)
}

// ClaimEnvTask: Long-poll for the next task assigned to a `grad env serve` worker
func (c *Client) ClaimEnvTask(ctx context.Context, name string, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/env-workers/%s/claim", url.PathEscape(name)), body, nil)
}

// ClaimTrainerJob: Claim the next queued train or import job (trainer:worker)
func (c *Client) ClaimTrainerJob(ctx context.Context, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", "/v1/trainer-jobs/claim", body, nil)
}

// CompleteEnvTask: Submit scored trajectory output for an environment task
func (c *Client) CompleteEnvTask(ctx context.Context, id string, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/env-workers/tasks/%s/complete", url.PathEscape(id)), body, nil)
}

// CompleteTrainerJob: Finish a job attempt: publish its artifact, bill it, release the lease
func (c *Client) CompleteTrainerJob(ctx context.Context, id string, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/trainer-jobs/%s/complete", url.PathEscape(id)), body, nil)
}

// CreateApiKey: Create a scoped workspace API key (trainer worker keys are platform config, not keys)
func (c *Client) CreateApiKey(ctx context.Context, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", "/v1/keys", body, nil)
}

// CreateDataset: Create an empty dataset
func (c *Client) CreateDataset(ctx context.Context, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", "/v1/datasets", body, nil)
}

// CreateDatasetImport: Import an uploaded file or a Hugging Face dataset into a dataset (async job)
func (c *Client) CreateDatasetImport(ctx context.Context, name string, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/datasets/%s/imports", url.PathEscape(name)), body, nil)
}

// CreateEmbeddings: Generate embeddings from a deployed embedding artifact
func (c *Client) CreateEmbeddings(ctx context.Context, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", "/v1/embeddings", body, nil)
}

// CreateEval: Queue an evaluation across models on a pinned dataset version (executed by the server)
func (c *Client) CreateEval(ctx context.Context, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", "/v1/evals", body, nil)
}

// CreateRun: Create and enqueue a training run (pins the dataset version)
func (c *Client) CreateRun(ctx context.Context, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", "/v1/runs", body, nil)
}

// CreateTrainerUpload: Get an upload URL for a checkpoint or artifact bundle
func (c *Client) CreateTrainerUpload(ctx context.Context, id string, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/trainer-jobs/%s/uploads", url.PathEscape(id)), body, nil)
}

// CreateUpload: Get an upload URL for a file to import (PUT the bytes, then create an import)
func (c *Client) CreateUpload(ctx context.Context, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", "/v1/uploads", body, nil)
}

// DeployArtifact: Deploy or update an artifact under a stable model name
func (c *Client) DeployArtifact(ctx context.Context, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", "/v1/deployments", body, nil)
}

// DispatchEnvTask: Dispatch an evaluation or rollout task to a connected `grad env serve` worker
func (c *Client) DispatchEnvTask(ctx context.Context, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", "/v1/env-workers/tasks", body, nil)
}

// DownloadArtifact: Download an artifact bundle (.grad.tar.gz); verify X-Artifact-Sha256
func (c *Client) DownloadArtifact(ctx context.Context, id string) ([]byte, http.Header, error) {
	return c.doBytes(ctx, "GET", fmt.Sprintf("/v1/artifacts/%s/download", url.PathEscape(id)), nil, nil)
}

// DownloadTrainerDataset: Stream the pinned dataset version of a claimed train job as JSONL
func (c *Client) DownloadTrainerDataset(ctx context.Context, id string, query map[string]string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", fmt.Sprintf("/v1/trainer-jobs/%s/dataset", url.PathEscape(id)), nil, query)
}

// GetArtifact: Get an artifact by id or name@latest
func (c *Client) GetArtifact(ctx context.Context, id string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", fmt.Sprintf("/v1/artifacts/%s", url.PathEscape(id)), nil, nil)
}

// GetDataset: Get a dataset by name
func (c *Client) GetDataset(ctx context.Context, name string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", fmt.Sprintf("/v1/datasets/%s", url.PathEscape(name)), nil, nil)
}

// GetDeployment: Get deployment status and feedback summary
func (c *Client) GetDeployment(ctx context.Context, name string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", fmt.Sprintf("/v1/deployments/%s", url.PathEscape(name)), nil, nil)
}

// GetEnvTask: Inspect an environment task and its result
func (c *Client) GetEnvTask(ctx context.Context, id string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", fmt.Sprintf("/v1/env-workers/tasks/%s", url.PathEscape(id)), nil, nil)
}

// GetEval: Get an evaluation run by ID
func (c *Client) GetEval(ctx context.Context, id string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", fmt.Sprintf("/v1/evals/%s", url.PathEscape(id)), nil, nil)
}

// GetImport: Get a dataset import job
func (c *Client) GetImport(ctx context.Context, id string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", fmt.Sprintf("/v1/imports/%s", url.PathEscape(id)), nil, nil)
}

// GetRun: Get a training run
func (c *Client) GetRun(ctx context.Context, id string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", fmt.Sprintf("/v1/runs/%s", url.PathEscape(id)), nil, nil)
}

// GetTrainerQueueStats: Queue depth for autoscaling: queued plus running jobs (trainer:worker)
func (c *Client) GetTrainerQueueStats(ctx context.Context) (map[string]any, error) {
	return c.doJSON(ctx, "GET", "/v1/trainer-jobs/queue", nil, nil)
}

// HeartbeatTrainerJob: Renew the job lease; reports whether the worker should stop
func (c *Client) HeartbeatTrainerJob(ctx context.Context, id string, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/trainer-jobs/%s/heartbeat", url.PathEscape(id)), body, nil)
}

// ListApiKeys: List workspace API keys
func (c *Client) ListApiKeys(ctx context.Context, query map[string]string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", "/v1/keys", nil, query)
}

// ListArtifacts: List immutable artifacts (newest first)
func (c *Client) ListArtifacts(ctx context.Context, query map[string]string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", "/v1/artifacts", nil, query)
}

// ListDatasetRecords: Read records of a dataset version
func (c *Client) ListDatasetRecords(ctx context.Context, name string, query map[string]string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", fmt.Sprintf("/v1/datasets/%s/records", url.PathEscape(name)), nil, query)
}

// ListDatasets: List datasets (newest first)
func (c *Client) ListDatasets(ctx context.Context, query map[string]string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", "/v1/datasets", nil, query)
}

// ListDeployments: List deployments
func (c *Client) ListDeployments(ctx context.Context, query map[string]string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", "/v1/deployments", nil, query)
}

// ListEvalFailures: List failing task records from an evaluation run for mining
func (c *Client) ListEvalFailures(ctx context.Context, id string, query map[string]string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", fmt.Sprintf("/v1/evals/%s/failures", url.PathEscape(id)), nil, query)
}

// ListEvalOutputs: Page through generated model outputs (filter by model or by a code scorer that still needs a score)
func (c *Client) ListEvalOutputs(ctx context.Context, id string, query map[string]string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", fmt.Sprintf("/v1/evals/%s/outputs", url.PathEscape(id)), nil, query)
}

// ListEvalResults: Per-task, per-model results of a completed evaluation
func (c *Client) ListEvalResults(ctx context.Context, id string, query map[string]string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", fmt.Sprintf("/v1/evals/%s/results", url.PathEscape(id)), nil, query)
}

// ListEvals: List evaluation runs
func (c *Client) ListEvals(ctx context.Context, query map[string]string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", "/v1/evals", nil, query)
}

// ListImports: List dataset import jobs (newest first)
func (c *Client) ListImports(ctx context.Context, query map[string]string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", "/v1/imports", nil, query)
}

// ListModels: List trainable base models (the server catalog and price source)
func (c *Client) ListModels(ctx context.Context) (map[string]any, error) {
	return c.doJSON(ctx, "GET", "/v1/models", nil, nil)
}

// ListRunCheckpoints: List unexpired checkpoints of a run (best and final never expire)
func (c *Client) ListRunCheckpoints(ctx context.Context, id string, query map[string]string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", fmt.Sprintf("/v1/runs/%s/checkpoints", url.PathEscape(id)), nil, query)
}

// ListRunMetrics: Training step metrics as JSON pages, or a live SSE stream
func (c *Client) ListRunMetrics(ctx context.Context, id string, query map[string]string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", fmt.Sprintf("/v1/runs/%s/metrics", url.PathEscape(id)), nil, query)
}

// ListRuns: List training runs (newest first)
func (c *Client) ListRuns(ctx context.Context, query map[string]string) (map[string]any, error) {
	return c.doJSON(ctx, "GET", "/v1/runs", nil, query)
}

// PlanEval: Estimate tasks, model/judge calls, and cost before running an eval
func (c *Client) PlanEval(ctx context.Context, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", "/v1/evals/plan", body, nil)
}

// PlanRun: Dry-run a training recipe at zero cost
func (c *Client) PlanRun(ctx context.Context, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", "/v1/runs/plan", body, nil)
}

// PostEvalScores: Post scores computed by local (SDK-side) code scorers; the eval completes when none are missing
func (c *Client) PostEvalScores(ctx context.Context, id string, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/evals/%s/scores", url.PathEscape(id)), body, nil)
}

// PostImportRecords: Append a batch of parsed records to an import job
func (c *Client) PostImportRecords(ctx context.Context, id string, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/trainer-jobs/%s/records", url.PathEscape(id)), body, nil)
}

// PromoteCheckpoint: Copy an exportable checkpoint into a new immutable artifact
func (c *Client) PromoteCheckpoint(ctx context.Context, id string, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/checkpoints/%s/promote", url.PathEscape(id)), body, nil)
}

// PushDatasetRecords: Append records as a new dataset version (creates the dataset if needed)
func (c *Client) PushDatasetRecords(ctx context.Context, name string, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/datasets/%s/records", url.PathEscape(name)), body, nil)
}

// RecordFeedback: Record deduplicated outcome scores and gold corrections
func (c *Client) RecordFeedback(ctx context.Context, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", "/v1/feedback", body, nil)
}

// RegisterEnvWorker: Register or heartbeat an outbound `grad env serve` worker
func (c *Client) RegisterEnvWorker(ctx context.Context, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", "/v1/env-workers/register", body, nil)
}

// RegisterTrainerCheckpoint: Register an uploaded checkpoint bundle
func (c *Client) RegisterTrainerCheckpoint(ctx context.Context, id string, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/trainer-jobs/%s/checkpoints", url.PathEscape(id)), body, nil)
}

// RenderDataset: Preview chat-template rendering and loss masks (estimated token counts)
func (c *Client) RenderDataset(ctx context.Context, name string, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/datasets/%s/render", url.PathEscape(name)), body, nil)
}

// ReportTrainerProgress: Report one training step's metrics
func (c *Client) ReportTrainerProgress(ctx context.Context, id string, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/trainer-jobs/%s/progress", url.PathEscape(id)), body, nil)
}

// ResumeRun: Resume a stopped, failed or cancelled run from its latest checkpoint
func (c *Client) ResumeRun(ctx context.Context, id string, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/runs/%s/resume", url.PathEscape(id)), body, nil)
}

// RevokeApiKey: Revoke a workspace API key
func (c *Client) RevokeApiKey(ctx context.Context, id string) (map[string]any, error) {
	return c.doJSON(ctx, "DELETE", fmt.Sprintf("/v1/keys/%s", url.PathEscape(id)), nil, nil)
}

// RollbackDeployment: Roll a deployment back to its previous artifact
func (c *Client) RollbackDeployment(ctx context.Context, name string) (map[string]any, error) {
	return c.doJSON(ctx, "POST", fmt.Sprintf("/v1/deployments/%s/rollback", url.PathEscape(name)), nil, nil)
}

// RouteRequest: Ask a deployed model router which model to call
func (c *Client) RouteRequest(ctx context.Context, body any) (map[string]any, error) {
	return c.doJSON(ctx, "POST", "/v1/route", body, nil)
}
