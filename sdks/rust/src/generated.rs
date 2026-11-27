// AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.

use serde_json::Value;
use std::fmt;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct ApiError {
    pub status: u16,
    pub code: String,
    pub title: String,
    pub detail: String,
    pub request_id: String,
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "[{}] {}: {}", self.status, self.code, self.detail)
    }
}

impl std::error::Error for ApiError {}

fn encode_path_segment(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char);
            }
            _ => {
                out.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    out
}

#[derive(Debug, Clone)]
pub struct GeneratedClient {
    base_url: String,
    api_key: Option<String>,
    http: reqwest::Client,
}

impl GeneratedClient {
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .timeout(Duration::from_secs(60))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self::with_http_client(base_url, api_key, http)
    }

    pub fn with_http_client(
        base_url: impl Into<String>,
        api_key: Option<String>,
        http: reqwest::Client,
    ) -> Self {
        Self {
            base_url: base_url.into().trim_end_matches('/').to_string(),
            api_key,
            http,
        }
    }

    async fn execute(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
        query: &[(&str, String)],
    ) -> Result<reqwest::Response, ApiError> {
        let url = format!("{}{}", self.base_url, path);
        let mut req = self.http.request(method, &url);
        if let Some(ref key) = self.api_key {
            req = req.bearer_auth(key);
        }
        if !query.is_empty() {
            req = req.query(query);
        }
        if let Some(payload) = body {
            req = req.json(payload);
        }
        let resp = req.send().await.map_err(|err| ApiError {
            status: 0,
            code: "network_error".to_string(),
            title: "Network error".to_string(),
            detail: err.to_string(),
            request_id: String::new(),
        })?;

        if !resp.status().is_success() {
            let status = resp.status().as_u16();
            let text = resp.text().await.unwrap_or_default();
            if let Ok(problem) = serde_json::from_str::<Value>(&text) {
                return Err(ApiError {
                    status,
                    code: problem
                        .get("code")
                        .and_then(|v| v.as_str())
                        .unwrap_or("api_error")
                        .to_string(),
                    title: problem
                        .get("title")
                        .and_then(|v| v.as_str())
                        .unwrap_or("API Error")
                        .to_string(),
                    detail: problem
                        .get("detail")
                        .and_then(|v| v.as_str())
                        .unwrap_or(&text)
                        .to_string(),
                    request_id: problem
                        .get("request_id")
                        .and_then(|v| v.as_str())
                        .unwrap_or("")
                        .to_string(),
                });
            }
            return Err(ApiError {
                status,
                code: "api_error".to_string(),
                title: "API Error".to_string(),
                detail: text,
                request_id: String::new(),
            });
        }

        Ok(resp)
    }

    async fn send_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
        query: &[(&str, String)],
    ) -> Result<Value, ApiError> {
        let resp = self.execute(method, path, body, query).await?;
        let status = resp.status().as_u16();
        if status == 204 || status == 205 {
            return Ok(Value::Object(serde_json::Map::new()));
        }
        let text = resp.text().await.map_err(|err| ApiError {
            status: 0,
            code: "decode_error".to_string(),
            title: "Failed reading response".to_string(),
            detail: err.to_string(),
            request_id: String::new(),
        })?;
        if text.trim().is_empty() {
            return Ok(Value::Object(serde_json::Map::new()));
        }
        serde_json::from_str::<Value>(&text).map_err(|err| ApiError {
            status: 0,
            code: "decode_error".to_string(),
            title: "Invalid JSON response".to_string(),
            detail: err.to_string(),
            request_id: String::new(),
        })
    }

    async fn send_bytes(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<&Value>,
        query: &[(&str, String)],
    ) -> Result<(Vec<u8>, Option<String>), ApiError> {
        let resp = self.execute(method, path, body, query).await?;
        let sha = resp
            .headers()
            .get("x-artifact-sha256")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let bytes = resp.bytes().await.map_err(|err| ApiError {
            status: 0,
            code: "decode_error".to_string(),
            title: "Failed reading binary response".to_string(),
            detail: err.to_string(),
            request_id: String::new(),
        })?;
        Ok((bytes.to_vec(), sha))
    }

    /// Cancel a queued, running or awaiting_scores evaluation
    pub async fn cancel_eval(&self, id: &str) -> Result<Value, ApiError> {
        let path = format!("/v1/evals/{}/cancel", encode_path_segment(id));
        self.send_json(reqwest::Method::POST, &path, None, &[]).await
    }

    /// Cancel a training run (a running attempt is stopped and billed)
    pub async fn cancel_run(&self, id: &str) -> Result<Value, ApiError> {
        let path = format!("/v1/runs/{}/cancel", encode_path_segment(id));
        self.send_json(reqwest::Method::POST, &path, None, &[]).await
    }

    /// Long-poll for the next task assigned to a `grad env serve` worker
    pub async fn claim_env_task(&self, name: &str, body: &Value) -> Result<Value, ApiError> {
        let path = format!("/v1/env-workers/{}/claim", encode_path_segment(name));
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Claim the next queued train or import job (trainer:worker)
    pub async fn claim_trainer_job(&self, body: &Value) -> Result<Value, ApiError> {
        let path = "/v1/trainer-jobs/claim".to_string();
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Submit scored trajectory output for an environment task
    pub async fn complete_env_task(&self, id: &str, body: &Value) -> Result<Value, ApiError> {
        let path = format!("/v1/env-workers/tasks/{}/complete", encode_path_segment(id));
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Finish a job attempt: publish its artifact, bill it, release the lease
    pub async fn complete_trainer_job(&self, id: &str, body: &Value) -> Result<Value, ApiError> {
        let path = format!("/v1/trainer-jobs/{}/complete", encode_path_segment(id));
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Create a scoped workspace API key (trainer worker keys are platform config, not keys)
    pub async fn create_api_key(&self, body: &Value) -> Result<Value, ApiError> {
        let path = "/v1/keys".to_string();
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Create an empty dataset
    pub async fn create_dataset(&self, body: &Value) -> Result<Value, ApiError> {
        let path = "/v1/datasets".to_string();
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Import an uploaded file or a Hugging Face dataset into a dataset (async job)
    pub async fn create_dataset_import(&self, name: &str, body: &Value) -> Result<Value, ApiError> {
        let path = format!("/v1/datasets/{}/imports", encode_path_segment(name));
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Generate embeddings from a deployed embedding artifact
    pub async fn create_embeddings(&self, body: &Value) -> Result<Value, ApiError> {
        let path = "/v1/embeddings".to_string();
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Queue an evaluation across models on a pinned dataset version (executed by the server)
    pub async fn create_eval(&self, body: &Value) -> Result<Value, ApiError> {
        let path = "/v1/evals".to_string();
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Create and enqueue a training run (pins the dataset version)
    pub async fn create_run(&self, body: &Value) -> Result<Value, ApiError> {
        let path = "/v1/runs".to_string();
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Get an upload URL for a checkpoint or artifact bundle
    pub async fn create_trainer_upload(&self, id: &str, body: &Value) -> Result<Value, ApiError> {
        let path = format!("/v1/trainer-jobs/{}/uploads", encode_path_segment(id));
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Get an upload URL for a file to import (PUT the bytes, then create an import)
    pub async fn create_upload(&self, body: &Value) -> Result<Value, ApiError> {
        let path = "/v1/uploads".to_string();
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Deploy or update an artifact under a stable model name
    pub async fn deploy_artifact(&self, body: &Value) -> Result<Value, ApiError> {
        let path = "/v1/deployments".to_string();
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Dispatch an evaluation or rollout task to a connected `grad env serve` worker
    pub async fn dispatch_env_task(&self, body: &Value) -> Result<Value, ApiError> {
        let path = "/v1/env-workers/tasks".to_string();
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Download an artifact bundle (.grad.tar.gz); verify X-Artifact-Sha256
    pub async fn download_artifact(&self, id: &str) -> Result<(Vec<u8>, Option<String>), ApiError> {
        let path = format!("/v1/artifacts/{}/download", encode_path_segment(id));
        self.send_bytes(reqwest::Method::GET, &path, None, &[]).await
    }

    /// Stream the pinned dataset version of a claimed train job as JSONL
    pub async fn download_trainer_dataset(&self, id: &str, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let path = format!("/v1/trainer-jobs/{}/dataset", encode_path_segment(id));
        self.send_json(reqwest::Method::GET, &path, None, query).await
    }

    /// Get an artifact by id or name@latest
    pub async fn get_artifact(&self, id: &str) -> Result<Value, ApiError> {
        let path = format!("/v1/artifacts/{}", encode_path_segment(id));
        self.send_json(reqwest::Method::GET, &path, None, &[]).await
    }

    /// Get a dataset by name
    pub async fn get_dataset(&self, name: &str) -> Result<Value, ApiError> {
        let path = format!("/v1/datasets/{}", encode_path_segment(name));
        self.send_json(reqwest::Method::GET, &path, None, &[]).await
    }

    /// Get deployment status and feedback summary
    pub async fn get_deployment(&self, name: &str) -> Result<Value, ApiError> {
        let path = format!("/v1/deployments/{}", encode_path_segment(name));
        self.send_json(reqwest::Method::GET, &path, None, &[]).await
    }

    /// Inspect an environment task and its result
    pub async fn get_env_task(&self, id: &str) -> Result<Value, ApiError> {
        let path = format!("/v1/env-workers/tasks/{}", encode_path_segment(id));
        self.send_json(reqwest::Method::GET, &path, None, &[]).await
    }

    /// Get an evaluation run by ID
    pub async fn get_eval(&self, id: &str) -> Result<Value, ApiError> {
        let path = format!("/v1/evals/{}", encode_path_segment(id));
        self.send_json(reqwest::Method::GET, &path, None, &[]).await
    }

    /// Get a dataset import job
    pub async fn get_import(&self, id: &str) -> Result<Value, ApiError> {
        let path = format!("/v1/imports/{}", encode_path_segment(id));
        self.send_json(reqwest::Method::GET, &path, None, &[]).await
    }

    /// Get a training run
    pub async fn get_run(&self, id: &str) -> Result<Value, ApiError> {
        let path = format!("/v1/runs/{}", encode_path_segment(id));
        self.send_json(reqwest::Method::GET, &path, None, &[]).await
    }

    /// Queue depth for autoscaling: queued plus running jobs (trainer:worker)
    pub async fn get_trainer_queue_stats(&self) -> Result<Value, ApiError> {
        let path = "/v1/trainer-jobs/queue".to_string();
        self.send_json(reqwest::Method::GET, &path, None, &[]).await
    }

    /// Renew the job lease; reports whether the worker should stop
    pub async fn heartbeat_trainer_job(&self, id: &str, body: &Value) -> Result<Value, ApiError> {
        let path = format!("/v1/trainer-jobs/{}/heartbeat", encode_path_segment(id));
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// List workspace API keys
    pub async fn list_api_keys(&self, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let path = "/v1/keys".to_string();
        self.send_json(reqwest::Method::GET, &path, None, query).await
    }

    /// List immutable artifacts (newest first)
    pub async fn list_artifacts(&self, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let path = "/v1/artifacts".to_string();
        self.send_json(reqwest::Method::GET, &path, None, query).await
    }

    /// Read records of a dataset version
    pub async fn list_dataset_records(&self, name: &str, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let path = format!("/v1/datasets/{}/records", encode_path_segment(name));
        self.send_json(reqwest::Method::GET, &path, None, query).await
    }

    /// List datasets (newest first)
    pub async fn list_datasets(&self, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let path = "/v1/datasets".to_string();
        self.send_json(reqwest::Method::GET, &path, None, query).await
    }

    /// List deployments
    pub async fn list_deployments(&self, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let path = "/v1/deployments".to_string();
        self.send_json(reqwest::Method::GET, &path, None, query).await
    }

    /// List failing task records from an evaluation run for mining
    pub async fn list_eval_failures(&self, id: &str, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let path = format!("/v1/evals/{}/failures", encode_path_segment(id));
        self.send_json(reqwest::Method::GET, &path, None, query).await
    }

    /// Page through generated model outputs (filter by model or by a code scorer that still needs a score)
    pub async fn list_eval_outputs(&self, id: &str, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let path = format!("/v1/evals/{}/outputs", encode_path_segment(id));
        self.send_json(reqwest::Method::GET, &path, None, query).await
    }

    /// Per-task, per-model results of a completed evaluation
    pub async fn list_eval_results(&self, id: &str, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let path = format!("/v1/evals/{}/results", encode_path_segment(id));
        self.send_json(reqwest::Method::GET, &path, None, query).await
    }

    /// List evaluation runs
    pub async fn list_evals(&self, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let path = "/v1/evals".to_string();
        self.send_json(reqwest::Method::GET, &path, None, query).await
    }

    /// List dataset import jobs (newest first)
    pub async fn list_imports(&self, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let path = "/v1/imports".to_string();
        self.send_json(reqwest::Method::GET, &path, None, query).await
    }

    /// List trainable base models (the server catalog and price source)
    pub async fn list_models(&self) -> Result<Value, ApiError> {
        let path = "/v1/models".to_string();
        self.send_json(reqwest::Method::GET, &path, None, &[]).await
    }

    /// List unexpired checkpoints of a run (best and final never expire)
    pub async fn list_run_checkpoints(&self, id: &str, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let path = format!("/v1/runs/{}/checkpoints", encode_path_segment(id));
        self.send_json(reqwest::Method::GET, &path, None, query).await
    }

    /// Training step metrics as JSON pages, or a live SSE stream
    pub async fn list_run_metrics(&self, id: &str, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let path = format!("/v1/runs/{}/metrics", encode_path_segment(id));
        self.send_json(reqwest::Method::GET, &path, None, query).await
    }

    /// List training runs (newest first)
    pub async fn list_runs(&self, query: &[(&str, String)]) -> Result<Value, ApiError> {
        let path = "/v1/runs".to_string();
        self.send_json(reqwest::Method::GET, &path, None, query).await
    }

    /// Estimate tasks, model/judge calls, and cost before running an eval
    pub async fn plan_eval(&self, body: &Value) -> Result<Value, ApiError> {
        let path = "/v1/evals/plan".to_string();
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Dry-run a training recipe at zero cost
    pub async fn plan_run(&self, body: &Value) -> Result<Value, ApiError> {
        let path = "/v1/runs/plan".to_string();
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Post scores computed by local (SDK-side) code scorers; the eval completes when none are missing
    pub async fn post_eval_scores(&self, id: &str, body: &Value) -> Result<Value, ApiError> {
        let path = format!("/v1/evals/{}/scores", encode_path_segment(id));
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Append a batch of parsed records to an import job
    pub async fn post_import_records(&self, id: &str, body: &Value) -> Result<Value, ApiError> {
        let path = format!("/v1/trainer-jobs/{}/records", encode_path_segment(id));
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Copy an exportable checkpoint into a new immutable artifact
    pub async fn promote_checkpoint(&self, id: &str, body: Option<&Value>) -> Result<Value, ApiError> {
        let path = format!("/v1/checkpoints/{}/promote", encode_path_segment(id));
        self.send_json(reqwest::Method::POST, &path, body, &[]).await
    }

    /// Append records as a new dataset version (creates the dataset if needed)
    pub async fn push_dataset_records(&self, name: &str, body: &Value) -> Result<Value, ApiError> {
        let path = format!("/v1/datasets/{}/records", encode_path_segment(name));
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Record deduplicated outcome scores and gold corrections
    pub async fn record_feedback(&self, body: &Value) -> Result<Value, ApiError> {
        let path = "/v1/feedback".to_string();
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Register or heartbeat an outbound `grad env serve` worker
    pub async fn register_env_worker(&self, body: &Value) -> Result<Value, ApiError> {
        let path = "/v1/env-workers/register".to_string();
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Register an uploaded checkpoint bundle
    pub async fn register_trainer_checkpoint(&self, id: &str, body: &Value) -> Result<Value, ApiError> {
        let path = format!("/v1/trainer-jobs/{}/checkpoints", encode_path_segment(id));
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Preview chat-template rendering and loss masks (estimated token counts)
    pub async fn render_dataset(&self, name: &str, body: &Value) -> Result<Value, ApiError> {
        let path = format!("/v1/datasets/{}/render", encode_path_segment(name));
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Report one training step's metrics
    pub async fn report_trainer_progress(&self, id: &str, body: &Value) -> Result<Value, ApiError> {
        let path = format!("/v1/trainer-jobs/{}/progress", encode_path_segment(id));
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }

    /// Resume a stopped, failed or cancelled run from its latest checkpoint
    pub async fn resume_run(&self, id: &str, body: Option<&Value>) -> Result<Value, ApiError> {
        let path = format!("/v1/runs/{}/resume", encode_path_segment(id));
        self.send_json(reqwest::Method::POST, &path, body, &[]).await
    }

    /// Revoke a workspace API key
    pub async fn revoke_api_key(&self, id: &str) -> Result<Value, ApiError> {
        let path = format!("/v1/keys/{}", encode_path_segment(id));
        self.send_json(reqwest::Method::DELETE, &path, None, &[]).await
    }

    /// Roll a deployment back to its previous artifact
    pub async fn rollback_deployment(&self, name: &str) -> Result<Value, ApiError> {
        let path = format!("/v1/deployments/{}/rollback", encode_path_segment(name));
        self.send_json(reqwest::Method::POST, &path, None, &[]).await
    }

    /// Ask a deployed model router which model to call
    pub async fn route_request(&self, body: &Value) -> Result<Value, ApiError> {
        let path = "/v1/route".to_string();
        self.send_json(reqwest::Method::POST, &path, Some(body), &[]).await
    }
}
