// Code generated from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.

package generated

import (
	"context"
	"net/url"
)

// Client is the generated low-level client: one typed method per OpenAPI operation.
type Client struct {
	T *Transport
}

// NewClient wraps a Transport.
func NewClient(t *Transport) *Client { return &Client{T: t} }

// CancelEval calls POST /v1/evals/{id}/cancel.
//
// Cancel a queued, running or awaiting_scores evaluation.
func (c *Client) CancelEval(ctx context.Context, id string, opts ...RequestOption) (*EvalRun, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/evals/" + p0 + "/cancel"}
	var out EvalRun
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// CancelRun calls POST /v1/runs/{id}/cancel.
//
// Cancel a training run (a running attempt is stopped and billed).
func (c *Client) CancelRun(ctx context.Context, id string, opts ...RequestOption) (*Run, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/runs/" + p0 + "/cancel"}
	var out Run
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ClaimEnvTask calls POST /v1/env-workers/{name}/claim.
//
// Long-poll for the next task assigned to a `grad env serve` worker.
func (c *Client) ClaimEnvTask(ctx context.Context, name string, body *ClaimEnvTaskRequest, opts ...RequestOption) (*ClaimEnvTaskResponse, error) {
	p0, err := EscapePathParam("name", name)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "ClaimEnvTask: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/env-workers/" + p0 + "/claim", Body: body}
	var out ClaimEnvTaskResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ClaimTrainerJob calls POST /v1/trainer-jobs/claim.
//
// Claim the next queued train or import job (trainer:worker).
func (c *Client) ClaimTrainerJob(ctx context.Context, body *ClaimJobRequest, opts ...RequestOption) (*ClaimJobResponse, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "ClaimTrainerJob: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/trainer-jobs/claim", Body: body}
	var out ClaimJobResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// CompleteEnvTask calls POST /v1/env-workers/tasks/{id}/complete.
//
// Submit scored trajectory output for an environment task.
func (c *Client) CompleteEnvTask(ctx context.Context, id string, body *EnvTaskResult, opts ...RequestOption) (map[string]any, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "CompleteEnvTask: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/env-workers/tasks/" + p0 + "/complete", Body: body}
	var out map[string]any
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return out, nil
}

// CompleteTrainerJob calls POST /v1/trainer-jobs/{id}/complete.
//
// Finish a job attempt: publish its artifact, bill it, release the lease.
func (c *Client) CompleteTrainerJob(ctx context.Context, id string, body *CompleteTrainerJobRequest, opts ...RequestOption) (*CompleteTrainerJobResponse, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "CompleteTrainerJob: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/trainer-jobs/" + p0 + "/complete", Body: body}
	var out CompleteTrainerJobResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateAPIKey calls POST /v1/keys.
//
// Create a scoped workspace API key (trainer worker keys are platform config, not keys).
func (c *Client) CreateAPIKey(ctx context.Context, body *CreateAPIKeyRequest, opts ...RequestOption) (*CreatedAPIKey, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "CreateAPIKey: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/keys", Body: body}
	var out CreatedAPIKey
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateDataset calls POST /v1/datasets.
//
// Create an empty dataset.
func (c *Client) CreateDataset(ctx context.Context, body *CreateDatasetRequest, opts ...RequestOption) (*Dataset, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "CreateDataset: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/datasets", Body: body}
	var out Dataset
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateDatasetImport calls POST /v1/datasets/{name}/imports.
//
// Import an uploaded file or a Hugging Face dataset into a dataset (async job).
func (c *Client) CreateDatasetImport(ctx context.Context, name string, body *CreateImportRequest, opts ...RequestOption) (*ImportJob, error) {
	p0, err := EscapePathParam("name", name)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "CreateDatasetImport: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/datasets/" + p0 + "/imports", Body: body}
	var out ImportJob
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateEmbeddings calls POST /v1/embeddings.
//
// Generate embeddings from a deployed embedding artifact.
func (c *Client) CreateEmbeddings(ctx context.Context, body *EmbedRequest, opts ...RequestOption) (*EmbedResponse, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "CreateEmbeddings: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/embeddings", Body: body}
	var out EmbedResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateEval calls POST /v1/evals.
//
// Queue an evaluation across models on a pinned dataset version (executed by the server).
func (c *Client) CreateEval(ctx context.Context, body *PlanEvalRequest, opts ...RequestOption) (*EvalRun, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "CreateEval: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/evals", Body: body}
	var out EvalRun
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateRun calls POST /v1/runs.
//
// Create and enqueue a training run (pins the dataset version).
func (c *Client) CreateRun(ctx context.Context, body *PlanRunRequest, opts ...RequestOption) (*Run, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "CreateRun: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/runs", Body: body}
	var out Run
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateTrainerUpload calls POST /v1/trainer-jobs/{id}/uploads.
//
// Get an upload URL for a checkpoint or artifact bundle.
func (c *Client) CreateTrainerUpload(ctx context.Context, id string, body *TrainerUploadRequest, opts ...RequestOption) (*UploadTicket, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "CreateTrainerUpload: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/trainer-jobs/" + p0 + "/uploads", Body: body}
	var out UploadTicket
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateUpload calls POST /v1/uploads.
//
// Get an upload URL for a file to import (PUT the bytes, then create an import).
func (c *Client) CreateUpload(ctx context.Context, body *CreateUploadRequest, opts ...RequestOption) (*UploadTicket, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "CreateUpload: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/uploads", Body: body}
	var out UploadTicket
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeployArtifact calls POST /v1/deployments.
//
// Deploy or update an artifact under a stable model name.
func (c *Client) DeployArtifact(ctx context.Context, body *DeployArtifactRequest, opts ...RequestOption) (*Deployment, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "DeployArtifact: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/deployments", Body: body}
	var out Deployment
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// DispatchEnvTask calls POST /v1/env-workers/tasks.
//
// Dispatch an evaluation or rollout task to a connected `grad env serve` worker.
func (c *Client) DispatchEnvTask(ctx context.Context, body *EnvTaskDispatch, opts ...RequestOption) (*DispatchEnvTaskResponse, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "DispatchEnvTask: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/env-workers/tasks", Body: body}
	var out DispatchEnvTaskResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// DownloadArtifact calls GET /v1/artifacts/{id}/download.
//
// Download an artifact bundle (.grad.tar.gz); verify X-Artifact-Sha256.
func (c *Client) DownloadArtifact(ctx context.Context, id string, opts ...RequestOption) (*StreamResponse, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/artifacts/" + p0 + "/download", Accept: "application/octet-stream"}
	return c.T.DoStream(ctx, spec, opts...)
}

// DownloadTrainerDataset calls GET /v1/trainer-jobs/{id}/dataset.
//
// Stream the pinned dataset version of a claimed train job as JSONL.
func (c *Client) DownloadTrainerDataset(ctx context.Context, id string, params DownloadTrainerDatasetParams, opts ...RequestOption) (*StreamResponse, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	q.Add("attempt", FormatScalar(params.Attempt))
	spec := RequestSpec{Method: "GET", Path: "/v1/trainer-jobs/" + p0 + "/dataset", Query: q, Accept: "application/x-ndjson"}
	return c.T.DoStream(ctx, spec, opts...)
}

// GetArtifact calls GET /v1/artifacts/{id}.
//
// Get an artifact by id or name@latest.
func (c *Client) GetArtifact(ctx context.Context, id string, opts ...RequestOption) (*Artifact, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/artifacts/" + p0}
	var out Artifact
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetDataset calls GET /v1/datasets/{name}.
//
// Get a dataset by name.
func (c *Client) GetDataset(ctx context.Context, name string, opts ...RequestOption) (*Dataset, error) {
	p0, err := EscapePathParam("name", name)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/datasets/" + p0}
	var out Dataset
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetDeployment calls GET /v1/deployments/{name}.
//
// Get deployment status and feedback summary.
func (c *Client) GetDeployment(ctx context.Context, name string, opts ...RequestOption) (*DeploymentStatus, error) {
	p0, err := EscapePathParam("name", name)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/deployments/" + p0}
	var out DeploymentStatus
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetEnvTask calls GET /v1/env-workers/tasks/{id}.
//
// Inspect an environment task and its result.
func (c *Client) GetEnvTask(ctx context.Context, id string, opts ...RequestOption) (map[string]any, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/env-workers/tasks/" + p0}
	var out map[string]any
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return out, nil
}

// GetEval calls GET /v1/evals/{id}.
//
// Get an evaluation run by ID.
func (c *Client) GetEval(ctx context.Context, id string, opts ...RequestOption) (*EvalRun, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/evals/" + p0}
	var out EvalRun
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetImport calls GET /v1/imports/{id}.
//
// Get a dataset import job.
func (c *Client) GetImport(ctx context.Context, id string, opts ...RequestOption) (*ImportJob, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/imports/" + p0}
	var out ImportJob
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetRun calls GET /v1/runs/{id}.
//
// Get a training run.
func (c *Client) GetRun(ctx context.Context, id string, opts ...RequestOption) (*Run, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/runs/" + p0}
	var out Run
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetTrainerQueueStats calls GET /v1/trainer-jobs/queue.
//
// Queue depth for autoscaling: queued plus running jobs (trainer:worker).
func (c *Client) GetTrainerQueueStats(ctx context.Context, opts ...RequestOption) (*TrainerQueueStats, error) {
	spec := RequestSpec{Method: "GET", Path: "/v1/trainer-jobs/queue"}
	var out TrainerQueueStats
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// HeartbeatTrainerJob calls POST /v1/trainer-jobs/{id}/heartbeat.
//
// Renew the job lease; reports whether the worker should stop.
func (c *Client) HeartbeatTrainerJob(ctx context.Context, id string, body *TrainerHeartbeatRequest, opts ...RequestOption) (*TrainerHeartbeatResponse, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "HeartbeatTrainerJob: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/trainer-jobs/" + p0 + "/heartbeat", Body: body}
	var out TrainerHeartbeatResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListAPIKeys calls GET /v1/keys.
//
// List workspace API keys.
func (c *Client) ListAPIKeys(ctx context.Context, params *ListAPIKeysParams, opts ...RequestOption) (*ListAPIKeysResponse, error) {
	q := url.Values{}
	if params != nil {
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/keys", Query: q}
	var out ListAPIKeysResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListArtifacts calls GET /v1/artifacts.
//
// List immutable artifacts (newest first).
func (c *Client) ListArtifacts(ctx context.Context, params *ListArtifactsParams, opts ...RequestOption) (*ListArtifactsResponse, error) {
	q := url.Values{}
	if params != nil {
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
		if params.Name != nil {
			q.Add("name", FormatScalar(*params.Name))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/artifacts", Query: q}
	var out ListArtifactsResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListDatasetRecords calls GET /v1/datasets/{name}/records.
//
// Read records of a dataset version.
func (c *Client) ListDatasetRecords(ctx context.Context, name string, params *ListDatasetRecordsParams, opts ...RequestOption) (*DatasetRecordsPage, error) {
	p0, err := EscapePathParam("name", name)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	if params != nil {
		if params.Version != nil {
			q.Add("version", FormatScalar(*params.Version))
		}
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/datasets/" + p0 + "/records", Query: q}
	var out DatasetRecordsPage
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListDatasets calls GET /v1/datasets.
//
// List datasets (newest first).
func (c *Client) ListDatasets(ctx context.Context, params *ListDatasetsParams, opts ...RequestOption) (*ListDatasetsResponse, error) {
	q := url.Values{}
	if params != nil {
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/datasets", Query: q}
	var out ListDatasetsResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListDeployments calls GET /v1/deployments.
//
// List deployments.
func (c *Client) ListDeployments(ctx context.Context, params *ListDeploymentsParams, opts ...RequestOption) (*ListDeploymentsResponse, error) {
	q := url.Values{}
	if params != nil {
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/deployments", Query: q}
	var out ListDeploymentsResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListEvalFailures calls GET /v1/evals/{id}/failures.
//
// List failing task records from an evaluation run for mining.
func (c *Client) ListEvalFailures(ctx context.Context, id string, params *ListEvalFailuresParams, opts ...RequestOption) (*ListEvalFailuresResponse, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	if params != nil {
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
		if params.Model != nil {
			q.Add("model", FormatScalar(*params.Model))
		}
		if params.Threshold != nil {
			q.Add("threshold", FormatScalar(*params.Threshold))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/evals/" + p0 + "/failures", Query: q}
	var out ListEvalFailuresResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListEvalOutputs calls GET /v1/evals/{id}/outputs.
//
// Page through generated model outputs (filter by model or by a code scorer that still needs a score).
func (c *Client) ListEvalOutputs(ctx context.Context, id string, params *ListEvalOutputsParams, opts ...RequestOption) (*ListEvalOutputsResponse, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	if params != nil {
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
		if params.Model != nil {
			q.Add("model", FormatScalar(*params.Model))
		}
		if params.MissingScorer != nil {
			q.Add("missing_scorer", FormatScalar(*params.MissingScorer))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/evals/" + p0 + "/outputs", Query: q}
	var out ListEvalOutputsResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListEvalResults calls GET /v1/evals/{id}/results.
//
// Per-task, per-model results of a completed evaluation.
func (c *Client) ListEvalResults(ctx context.Context, id string, params *ListEvalResultsParams, opts ...RequestOption) (*ListEvalResultsResponse, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	if params != nil {
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
		if params.Model != nil {
			q.Add("model", FormatScalar(*params.Model))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/evals/" + p0 + "/results", Query: q}
	var out ListEvalResultsResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListEvals calls GET /v1/evals.
//
// List evaluation runs.
func (c *Client) ListEvals(ctx context.Context, params *ListEvalsParams, opts ...RequestOption) (*ListEvalsResponse, error) {
	q := url.Values{}
	if params != nil {
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/evals", Query: q}
	var out ListEvalsResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListImports calls GET /v1/imports.
//
// List dataset import jobs (newest first).
func (c *Client) ListImports(ctx context.Context, params *ListImportsParams, opts ...RequestOption) (*ListImportsResponse, error) {
	q := url.Values{}
	if params != nil {
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/imports", Query: q}
	var out ListImportsResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListModels calls GET /v1/models.
//
// List trainable base models (the server catalog and price source).
func (c *Client) ListModels(ctx context.Context, opts ...RequestOption) (*ListModelsResponse, error) {
	spec := RequestSpec{Method: "GET", Path: "/v1/models"}
	var out ListModelsResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListRunCheckpoints calls GET /v1/runs/{id}/checkpoints.
//
// List unexpired checkpoints of a run (best and final never expire).
func (c *Client) ListRunCheckpoints(ctx context.Context, id string, params *ListRunCheckpointsParams, opts ...RequestOption) (*ListRunCheckpointsResponse, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	if params != nil {
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/runs/" + p0 + "/checkpoints", Query: q}
	var out ListRunCheckpointsResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListRunMetrics calls GET /v1/runs/{id}/metrics.
//
// Training step metrics as JSON pages, or a live SSE stream.
func (c *Client) ListRunMetrics(ctx context.Context, id string, params *ListRunMetricsParams, opts ...RequestOption) (*MetricsPage, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	if params != nil {
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
		if params.AfterStep != nil {
			q.Add("after_step", FormatScalar(*params.AfterStep))
		}
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/runs/" + p0 + "/metrics", Query: q}
	var out MetricsPage
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListRunMetricsStream opens GET /v1/runs/{id}/metrics as a Server-Sent Events stream (resume with WithLastEventID).
func (c *Client) ListRunMetricsStream(ctx context.Context, id string, params *ListRunMetricsParams, opts ...RequestOption) (*SSEStream, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	if params != nil {
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
		if params.AfterStep != nil {
			q.Add("after_step", FormatScalar(*params.AfterStep))
		}
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/runs/" + p0 + "/metrics", Query: q}
	return c.T.DoSSE(ctx, spec, opts...)
}

// ListRuns calls GET /v1/runs.
//
// List training runs (newest first).
func (c *Client) ListRuns(ctx context.Context, params *ListRunsParams, opts ...RequestOption) (*ListRunsResponse, error) {
	q := url.Values{}
	if params != nil {
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/runs", Query: q}
	var out ListRunsResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// PlanEval calls POST /v1/evals/plan.
//
// Estimate tasks, model/judge calls, and cost before running an eval.
func (c *Client) PlanEval(ctx context.Context, body *PlanEvalRequest, opts ...RequestOption) (*PlanEvalResponse, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "PlanEval: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/evals/plan", Body: body}
	var out PlanEvalResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// PlanRun calls POST /v1/runs/plan.
//
// Dry-run a training recipe at zero cost.
func (c *Client) PlanRun(ctx context.Context, body *PlanRunRequest, opts ...RequestOption) (*PlanRunResponse, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "PlanRun: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/runs/plan", Body: body}
	var out PlanRunResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// PostEvalScores calls POST /v1/evals/{id}/scores.
//
// Post scores computed by local (SDK-side) code scorers; the eval completes when none are missing.
func (c *Client) PostEvalScores(ctx context.Context, id string, body *PostEvalScoresRequest, opts ...RequestOption) (*PostEvalScoresResponse, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "PostEvalScores: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/evals/" + p0 + "/scores", Body: body}
	var out PostEvalScoresResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// PostImportRecords calls POST /v1/trainer-jobs/{id}/records.
//
// Append a batch of parsed records to an import job.
func (c *Client) PostImportRecords(ctx context.Context, id string, body *PostImportRecordsRequest, opts ...RequestOption) (*PostImportRecordsResponse, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "PostImportRecords: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/trainer-jobs/" + p0 + "/records", Body: body}
	var out PostImportRecordsResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// PromoteCheckpoint calls POST /v1/checkpoints/{id}/promote.
//
// Copy an exportable checkpoint into a new immutable artifact.
func (c *Client) PromoteCheckpoint(ctx context.Context, id string, body *PromoteCheckpointRequest, opts ...RequestOption) (*Artifact, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/checkpoints/" + p0 + "/promote", Body: body}
	var out Artifact
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// PushDatasetRecords calls POST /v1/datasets/{name}/records.
//
// Append records as a new dataset version (creates the dataset if needed).
func (c *Client) PushDatasetRecords(ctx context.Context, name string, body *PushDatasetRequest, opts ...RequestOption) (*Dataset, error) {
	p0, err := EscapePathParam("name", name)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "PushDatasetRecords: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/datasets/" + p0 + "/records", Body: body}
	var out Dataset
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// RecordFeedback calls POST /v1/feedback.
//
// Record deduplicated outcome scores and gold corrections.
func (c *Client) RecordFeedback(ctx context.Context, body *RecordFeedbackRequest, opts ...RequestOption) (*RecordFeedbackResponse, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "RecordFeedback: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/feedback", Body: body}
	var out RecordFeedbackResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// RegisterEnvWorker calls POST /v1/env-workers/register.
//
// Register or heartbeat an outbound `grad env serve` worker.
func (c *Client) RegisterEnvWorker(ctx context.Context, body *EnvWorkerRegister, opts ...RequestOption) (*RegisterEnvWorkerResponse, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "RegisterEnvWorker: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/env-workers/register", Body: body}
	var out RegisterEnvWorkerResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// RegisterTrainerCheckpoint calls POST /v1/trainer-jobs/{id}/checkpoints.
//
// Register an uploaded checkpoint bundle.
func (c *Client) RegisterTrainerCheckpoint(ctx context.Context, id string, body *RegisterTrainerCheckpointRequest, opts ...RequestOption) (*Checkpoint, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "RegisterTrainerCheckpoint: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/trainer-jobs/" + p0 + "/checkpoints", Body: body}
	var out Checkpoint
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// RenderDataset calls POST /v1/datasets/{name}/render.
//
// Preview chat-template rendering and loss masks (estimated token counts).
func (c *Client) RenderDataset(ctx context.Context, name string, body *RenderDatasetRequest, opts ...RequestOption) (*RenderDatasetResponse, error) {
	p0, err := EscapePathParam("name", name)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "RenderDataset: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/datasets/" + p0 + "/render", Body: body}
	var out RenderDatasetResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ReportTrainerProgress calls POST /v1/trainer-jobs/{id}/progress.
//
// Report one training step's metrics.
func (c *Client) ReportTrainerProgress(ctx context.Context, id string, body *ReportTrainerProgressRequest, opts ...RequestOption) (*ReportTrainerProgressResponse, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "ReportTrainerProgress: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/trainer-jobs/" + p0 + "/progress", Body: body}
	var out ReportTrainerProgressResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ResumeRun calls POST /v1/runs/{id}/resume.
//
// Resume a stopped, failed or cancelled run from its latest checkpoint.
func (c *Client) ResumeRun(ctx context.Context, id string, body *ResumeRunRequest, opts ...RequestOption) (*Run, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/runs/" + p0 + "/resume", Body: body}
	var out Run
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// RevokeAPIKey calls DELETE /v1/keys/{id}.
//
// Revoke a workspace API key.
func (c *Client) RevokeAPIKey(ctx context.Context, id string, opts ...RequestOption) (*APIKey, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "DELETE", Path: "/v1/keys/" + p0}
	var out APIKey
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// RollbackDeployment calls POST /v1/deployments/{name}/rollback.
//
// Roll a deployment back to its previous artifact.
func (c *Client) RollbackDeployment(ctx context.Context, name string, opts ...RequestOption) (*Deployment, error) {
	p0, err := EscapePathParam("name", name)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/deployments/" + p0 + "/rollback"}
	var out Deployment
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// RouteRequest calls POST /v1/route.
//
// Ask a deployed model router which model to call.
func (c *Client) RouteRequest(ctx context.Context, body *RouteRequest, opts ...RequestOption) (*RouteResponse, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "RouteRequest: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/route", Body: body}
	var out RouteResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}
