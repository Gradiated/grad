// Code generated from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.

package generated

import (
	"context"
	"net/url"
)

// ListAPIKeysLimitMax is the largest limit accepted by ListAPIKeys (the server clamps larger values).
const ListAPIKeysLimitMax = 200

// ListArtifactsLimitMax is the largest limit accepted by ListArtifacts (the server clamps larger values).
const ListArtifactsLimitMax = 200

// ListDatasetRecordsLimitMax is the largest limit accepted by ListDatasetRecords (the server clamps larger values).
const ListDatasetRecordsLimitMax = 1000

// ListDatasetsLimitMax is the largest limit accepted by ListDatasets (the server clamps larger values).
const ListDatasetsLimitMax = 200

// ListEvalFailuresLimitMax is the largest limit accepted by ListEvalFailures (the server clamps larger values).
const ListEvalFailuresLimitMax = 200

// ListEvalOutputsLimitMax is the largest limit accepted by ListEvalOutputs (the server clamps larger values).
const ListEvalOutputsLimitMax = 200

// ListEvalResultsLimitMax is the largest limit accepted by ListEvalResults (the server clamps larger values).
const ListEvalResultsLimitMax = 200

// ListEvalsLimitMax is the largest limit accepted by ListEvals (the server clamps larger values).
const ListEvalsLimitMax = 200

// ListImportsLimitMax is the largest limit accepted by ListImports (the server clamps larger values).
const ListImportsLimitMax = 200

// ListRunCheckpointsLimitMax is the largest limit accepted by ListRunCheckpoints (the server clamps larger values).
const ListRunCheckpointsLimitMax = 200

// ListRunEventsLimitMax is the largest limit accepted by ListRunEvents (the server clamps larger values).
const ListRunEventsLimitMax = 5000

// ListRunMetricsLimitMax is the largest limit accepted by ListRunMetrics (the server clamps larger values).
const ListRunMetricsLimitMax = 5000

// ListRunsLimitMax is the largest limit accepted by ListRuns (the server clamps larger values).
const ListRunsLimitMax = 200

// ListSecretsLimitMax is the largest limit accepted by ListSecrets (the server clamps larger values).
const ListSecretsLimitMax = 200

// ListSourcesLimitMax is the largest limit accepted by ListSources (the server clamps larger values).
const ListSourcesLimitMax = 200

// ListUsageLimitMax is the largest limit accepted by ListUsage (the server clamps larger values).
const ListUsageLimitMax = 200

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
	spec := RequestSpec{Method: "POST", Path: "/v1/evals/" + p0 + "/cancel", Idempotent: true}
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
	spec := RequestSpec{Method: "POST", Path: "/v1/runs/" + p0 + "/cancel", Idempotent: true}
	var out Run
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
	spec := RequestSpec{Method: "POST", Path: "/v1/keys", Body: body, Idempotent: true}
	var out CreatedAPIKey
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateArtifactImport calls POST /v1/artifact-imports.
//
// Register uploaded files or a Hugging Face repo as an artifact (async import job).
func (c *Client) CreateArtifactImport(ctx context.Context, body *CreateArtifactImportRequest, opts ...RequestOption) (*ArtifactImport, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "CreateArtifactImport: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/artifact-imports", Body: body, Idempotent: true}
	var out ArtifactImport
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
	spec := RequestSpec{Method: "POST", Path: "/v1/datasets", Body: body, Idempotent: true}
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
	spec := RequestSpec{Method: "POST", Path: "/v1/datasets/" + p0 + "/imports", Body: body, Idempotent: true}
	var out ImportJob
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateDatasetSource calls POST /v1/datasets/{name}/sources.
//
// Connect an observability provider to a dataset.
func (c *Client) CreateDatasetSource(ctx context.Context, name string, body *CreateSourceRequest, opts ...RequestOption) (*Source, error) {
	p0, err := EscapePathParam("name", name)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "CreateDatasetSource: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/datasets/" + p0 + "/sources", Body: body, Idempotent: true}
	var out Source
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
	spec := RequestSpec{Method: "POST", Path: "/v1/evals", Body: body, Idempotent: true}
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
	spec := RequestSpec{Method: "POST", Path: "/v1/runs", Body: body, Idempotent: true}
	var out Run
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// CreateUpload calls POST /v1/uploads.
//
// Get an upload URL for a file to import (PUT the bytes, then create a dataset or artifact import).
func (c *Client) CreateUpload(ctx context.Context, body *CreateUploadRequest, opts ...RequestOption) (*UploadTicket, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "CreateUpload: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/uploads", Body: body, Idempotent: true}
	var out UploadTicket
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// DeleteArtifact calls DELETE /v1/artifacts/{id}.
//
// Delete a released artifact and its bundle (409 artifact_pinned while a holder pins it).
func (c *Client) DeleteArtifact(ctx context.Context, id string, opts ...RequestOption) error {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return err
	}
	spec := RequestSpec{Method: "DELETE", Path: "/v1/artifacts/" + p0}
	return c.T.DoJSON(ctx, spec, nil, opts...)
}

// DeleteSecret calls DELETE /v1/secrets/{name}.
//
// Delete a secret (409 while a source uses it).
func (c *Client) DeleteSecret(ctx context.Context, name string, opts ...RequestOption) error {
	p0, err := EscapePathParam("name", name)
	if err != nil {
		return err
	}
	spec := RequestSpec{Method: "DELETE", Path: "/v1/secrets/" + p0}
	return c.T.DoJSON(ctx, spec, nil, opts...)
}

// DeleteSource calls DELETE /v1/sources/{id}.
//
// Remove a source (its dataset and versions stay).
func (c *Client) DeleteSource(ctx context.Context, id string, opts ...RequestOption) error {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return err
	}
	spec := RequestSpec{Method: "DELETE", Path: "/v1/sources/" + p0}
	return c.T.DoJSON(ctx, spec, nil, opts...)
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

// FilterDataset calls POST /v1/datasets/{name}/filter.
//
// Save a filtered view of a dataset version.
func (c *Client) FilterDataset(ctx context.Context, name string, body *FilterDatasetRequest, opts ...RequestOption) (*Dataset, error) {
	p0, err := EscapePathParam("name", name)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "FilterDataset: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/datasets/" + p0 + "/filter", Body: body, Idempotent: true}
	var out Dataset
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
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

// GetArtifactDownloadURL calls GET /v1/artifacts/{id}/download-url.
//
// A short-lived presigned URL of an artifact bundle (browsers download straight from storage).
func (c *Client) GetArtifactDownloadURL(ctx context.Context, id string, opts ...RequestOption) (*ArtifactDownloadURL, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/artifacts/" + p0 + "/download-url"}
	var out ArtifactDownloadURL
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetArtifactImport calls GET /v1/artifact-imports/{id}.
//
// Get an artifact import.
func (c *Client) GetArtifactImport(ctx context.Context, id string, opts ...RequestOption) (*ArtifactImport, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/artifact-imports/" + p0}
	var out ArtifactImport
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

// GetSecret calls GET /v1/secrets/{name}.
//
// Get a secret's metadata (never the value).
func (c *Client) GetSecret(ctx context.Context, name string, opts ...RequestOption) (*Secret, error) {
	p0, err := EscapePathParam("name", name)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/secrets/" + p0}
	var out Secret
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetSource calls GET /v1/sources/{id}.
//
// Get a source and its latest sync.
func (c *Client) GetSource(ctx context.Context, id string, opts ...RequestOption) (*Source, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/sources/" + p0}
	var out Source
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// GetUsageSummary calls GET /v1/usage/summary.
//
// Total cost and tokens over a period (default: this UTC month), by kind, the top runs and evals, and optional groups.
func (c *Client) GetUsageSummary(ctx context.Context, params *GetUsageSummaryParams, opts ...RequestOption) (*UsageSummary, error) {
	q := url.Values{}
	if params != nil {
		if params.From != nil {
			q.Add("from", FormatScalar(*params.From))
		}
		if params.To != nil {
			q.Add("to", FormatScalar(*params.To))
		}
		if params.GroupBy != nil {
			q.Add("group_by", FormatScalar(*params.GroupBy))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/usage/summary", Query: q}
	var out UsageSummary
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
		if params.Q != nil {
			q.Add("q", FormatScalar(*params.Q))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/artifacts", Query: q}
	var out ListArtifactsResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListBaseModels calls GET /v1/base-models.
//
// List trainable base models (the server catalog and price source).
func (c *Client) ListBaseModels(ctx context.Context, opts ...RequestOption) (*ListBaseModelsResponse, error) {
	spec := RequestSpec{Method: "GET", Path: "/v1/base-models"}
	var out ListBaseModelsResponse
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
		if params.Q != nil {
			q.Add("q", FormatScalar(*params.Q))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/datasets", Query: q}
	var out ListDatasetsResponse
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
		if params.Status != nil {
			q.Add("status", FormatScalar(*params.Status))
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
		if params.Status != nil {
			q.Add("status", FormatScalar(*params.Status))
		}
		if params.Dataset != nil {
			q.Add("dataset", FormatScalar(*params.Dataset))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/imports", Query: q}
	var out ListImportsResponse
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

// ListRunEvents calls GET /v1/runs/{id}/events.
//
// A run's lifecycle events (phases, metrics, checkpoints, attempts, warnings, logs).
func (c *Client) ListRunEvents(ctx context.Context, id string, params *ListRunEventsParams, opts ...RequestOption) (*RunEventsPage, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	if params != nil {
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/runs/" + p0 + "/events", Query: q}
	var out RunEventsPage
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListRunEventsStream opens GET /v1/runs/{id}/events as a Server-Sent Events stream (resume with WithLastEventID).
func (c *Client) ListRunEventsStream(ctx context.Context, id string, params *ListRunEventsParams, opts ...RequestOption) (*SSEStream, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	q := url.Values{}
	if params != nil {
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/runs/" + p0 + "/events", Query: q}
	return c.T.DoSSE(ctx, spec, opts...)
}

// ListRunMetrics calls GET /v1/runs/{id}/metrics.
//
// Training step metrics as JSON pages.
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
		if params.Status != nil {
			q.Add("status", FormatScalar(*params.Status))
		}
		if params.Q != nil {
			q.Add("q", FormatScalar(*params.Q))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/runs", Query: q}
	var out ListRunsResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListSecrets calls GET /v1/secrets.
//
// List workspace secrets (names and metadata only).
func (c *Client) ListSecrets(ctx context.Context, params *ListSecretsParams, opts ...RequestOption) (*ListSecretsResponse, error) {
	q := url.Values{}
	if params != nil {
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/secrets", Query: q}
	var out ListSecretsResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListSources calls GET /v1/sources.
//
// List sources (newest first), optionally for one dataset.
func (c *Client) ListSources(ctx context.Context, params *ListSourcesParams, opts ...RequestOption) (*ListSourcesResponse, error) {
	q := url.Values{}
	if params != nil {
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
		if params.Dataset != nil {
			q.Add("dataset", FormatScalar(*params.Dataset))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/sources", Query: q}
	var out ListSourcesResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// ListUsage calls GET /v1/usage.
//
// List billed usage, newest first (filter by period, run, eval or kind): one record per billed increment of a run or eval attempt.
func (c *Client) ListUsage(ctx context.Context, params *ListUsageParams, opts ...RequestOption) (*ListUsageResponse, error) {
	q := url.Values{}
	if params != nil {
		if params.Limit != nil {
			q.Add("limit", FormatScalar(*params.Limit))
		}
		if params.Cursor != nil {
			q.Add("cursor", FormatScalar(*params.Cursor))
		}
		if params.From != nil {
			q.Add("from", FormatScalar(*params.From))
		}
		if params.To != nil {
			q.Add("to", FormatScalar(*params.To))
		}
		if params.RunID != nil {
			q.Add("run_id", FormatScalar(*params.RunID))
		}
		if params.EvalID != nil {
			q.Add("eval_id", FormatScalar(*params.EvalID))
		}
		if params.Kind != nil {
			q.Add("kind", FormatScalar(*params.Kind))
		}
	}
	spec := RequestSpec{Method: "GET", Path: "/v1/usage", Query: q}
	var out ListUsageResponse
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
	spec := RequestSpec{Method: "POST", Path: "/v1/evals/plan", Body: body, Idempotent: true}
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
	spec := RequestSpec{Method: "POST", Path: "/v1/runs/plan", Body: body, Idempotent: true}
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
	spec := RequestSpec{Method: "POST", Path: "/v1/evals/" + p0 + "/scores", Body: body, Idempotent: true}
	var out PostEvalScoresResponse
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// PromoteCheckpoint calls POST /v1/checkpoints/{id}/promote.
//
// Release an exportable checkpoint as a named, versioned artifact (promoting it again under the same name returns that release).
func (c *Client) PromoteCheckpoint(ctx context.Context, id string, body *PromoteCheckpointRequest, opts ...RequestOption) (*Artifact, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/checkpoints/" + p0 + "/promote", Body: body, Idempotent: true}
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
	spec := RequestSpec{Method: "POST", Path: "/v1/datasets/" + p0 + "/records", Body: body, Idempotent: true}
	var out Dataset
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
	spec := RequestSpec{Method: "POST", Path: "/v1/datasets/" + p0 + "/render", Body: body, Idempotent: true}
	var out RenderDatasetResponse
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
	spec := RequestSpec{Method: "POST", Path: "/v1/runs/" + p0 + "/resume", Body: body, Idempotent: true}
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

// ScoreDataset calls POST /v1/datasets/{name}/score.
//
// Score a dataset's records with a rubric (async; the scores become the next version).
func (c *Client) ScoreDataset(ctx context.Context, name string, body *ScoreDatasetRequest, opts ...RequestOption) (*EvalRun, error) {
	p0, err := EscapePathParam("name", name)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "ScoreDataset: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/datasets/" + p0 + "/score", Body: body, Idempotent: true}
	var out EvalRun
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// SetSecret calls POST /v1/secrets.
//
// Create or replace a workspace secret (the value is write-only).
func (c *Client) SetSecret(ctx context.Context, body *SetSecretRequest, opts ...RequestOption) (*Secret, error) {
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "SetSecret: body is required"}
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/secrets", Body: body, Idempotent: true}
	var out Secret
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// SyncSource calls POST /v1/sources/{id}/sync.
//
// Sync now: queue an import of new traces and scores (returns the running one if a sync is in progress).
func (c *Client) SyncSource(ctx context.Context, id string, body *SyncSourceRequest, opts ...RequestOption) (*ImportJob, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	spec := RequestSpec{Method: "POST", Path: "/v1/sources/" + p0 + "/sync", Body: body, Idempotent: true}
	var out ImportJob
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}

// UpdateSource calls PATCH /v1/sources/{id}.
//
// Change a source's filters, sampling, record caps or schedule (from its next sync).
func (c *Client) UpdateSource(ctx context.Context, id string, body *UpdateSourceRequest, opts ...RequestOption) (*Source, error) {
	p0, err := EscapePathParam("id", id)
	if err != nil {
		return nil, err
	}
	if body == nil {
		return nil, &GradError{Code: "invalid_request", Message: "UpdateSource: body is required"}
	}
	spec := RequestSpec{Method: "PATCH", Path: "/v1/sources/" + p0, Body: body}
	var out Source
	if err := c.T.DoJSON(ctx, spec, &out, opts...); err != nil {
		return nil, err
	}
	return &out, nil
}
