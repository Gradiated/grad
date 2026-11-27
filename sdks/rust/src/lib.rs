//! Idiomatic Rust SDK wrapping the OpenAPI-generated `GeneratedClient`.

pub mod generated;

use serde::{de::DeserializeOwned, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::fmt;
use std::time::Duration;

pub use generated::{ApiError, ErrorKind, GeneratedClient};

/// Converts a typed generated response into the JSON value this facade returns.
fn value<T: Serialize>(result: Result<T, ApiError>) -> Result<Value, ApiError> {
    result.and_then(|v| {
        serde_json::to_value(v)
            .map_err(|e| ApiError::local(ErrorKind::Decode, "decode_error", e.to_string()))
    })
}

/// Parses a JSON request body into the generated request type.
fn typed<T: DeserializeOwned>(body: Value) -> Result<T, ApiError> {
    serde_json::from_value(body)
        .map_err(|e| ApiError::local(ErrorKind::InvalidRequest, "invalid_request", e.to_string()))
}

#[derive(Clone)]
pub struct GradClient {
    pub wire: GeneratedClient,
}

impl fmt::Debug for GradClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GradClient")
            .field("wire", &"[REDACTED]")
            .finish()
    }
}

pub mod recipes {
    use serde_json::{json, Value};

    pub fn sft(model: Option<&str>) -> Value {
        let mut obj = json!({ "kind": "sft" });
        if let Some(m) = model {
            obj["model"] = json!(m);
        }
        obj
    }

    pub fn dpo(model: Option<&str>, beta: f64) -> Value {
        let mut obj = json!({ "kind": "dpo", "beta": beta });
        if let Some(m) = model {
            obj["model"] = json!(m);
        }
        obj
    }

    pub fn router(models: Vec<&str>, max_quality_drop: f64) -> Value {
        json!({ "kind": "router", "models": models, "max_quality_drop": max_quality_drop })
    }

    pub fn decision(model: Option<&str>) -> Value {
        let mut obj = json!({ "kind": "decision" });
        if let Some(m) = model {
            obj["model"] = json!(m);
        }
        obj
    }

    pub fn cartridge(model: Option<&str>, context_text: Option<&str>, num_tokens: u32) -> Value {
        let mut obj = json!({ "kind": "cartridge", "num_tokens": num_tokens });
        if let Some(m) = model {
            obj["model"] = json!(m);
        }
        if let Some(ctx) = context_text {
            obj["context_text"] = json!(ctx);
        }
        obj
    }

    pub fn embedding(model: Option<&str>, temp: f64) -> Value {
        let mut obj = json!({ "kind": "embedding", "temp": temp });
        if let Some(m) = model {
            obj["model"] = json!(m);
        }
        obj
    }
}

impl GradClient {
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Self {
        Self {
            wire: GeneratedClient::new(base_url, api_key),
        }
    }

    pub fn from_env() -> Self {
        let base_url =
            std::env::var("GRAD_BASE_URL").unwrap_or_else(|_| "http://127.0.0.1:8080".to_string());
        let api_key = std::env::var("GRAD_API_KEY").ok();
        Self::new(base_url, api_key)
    }

    pub async fn list_models(&self) -> Result<Value, ApiError> {
        value(self.wire.list_models().await)
    }

    pub async fn list_datasets(&self) -> Result<Value, ApiError> {
        value(self.wire.list_datasets(None).await)
    }

    pub async fn push_dataset(&self, name: &str, records: Vec<Value>) -> Result<Value, ApiError> {
        let body = json!({ "records": records });
        value(self.wire.push_dataset_records(name, &typed(body)?).await)
    }

    pub async fn render_dataset(&self, name: &str, body: &Value) -> Result<Value, ApiError> {
        value(self.wire.render_dataset(name, &typed(body.clone())?).await)
    }

    pub async fn plan_run(
        &self,
        dataset: &str,
        name: &str,
        recipe: Value,
        max_cost_usd: Option<f64>,
    ) -> Result<Value, ApiError> {
        let mut body = json!({ "dataset": dataset, "name": name, "recipe": recipe });
        if let Some(cap) = max_cost_usd {
            body["max_cost_usd"] = json!(cap);
        }
        value(self.wire.plan_run(&typed(body)?).await)
    }

    pub async fn create_run(
        &self,
        dataset: &str,
        name: &str,
        recipe: Value,
        max_cost_usd: Option<f64>,
    ) -> Result<Value, ApiError> {
        let mut body = json!({ "dataset": dataset, "name": name, "recipe": recipe });
        if let Some(cap) = max_cost_usd {
            body["max_cost_usd"] = json!(cap);
        }
        value(self.wire.create_run(&typed(body)?).await)
    }

    pub async fn list_runs(&self) -> Result<Value, ApiError> {
        value(self.wire.list_runs(None).await)
    }

    pub async fn get_run(&self, id: &str) -> Result<Value, ApiError> {
        value(self.wire.get_run(id).await)
    }

    pub async fn list_run_metrics(&self, id: &str, after_step: i64) -> Result<Value, ApiError> {
        let params = generated::ListRunMetricsParams {
            after_step: Some(after_step),
            ..Default::default()
        };
        value(self.wire.list_run_metrics(id, Some(&params)).await)
    }

    pub async fn cancel_run(&self, id: &str) -> Result<Value, ApiError> {
        value(self.wire.cancel_run(id).await)
    }

    pub async fn resume_run(&self, id: &str, max_cost_usd: Option<f64>) -> Result<Value, ApiError> {
        let body = match max_cost_usd {
            Some(cap) => json!({ "max_cost_usd": cap }),
            None => json!({}),
        };
        value(self.wire.resume_run(id, Some(&typed(body)?)).await)
    }

    pub async fn wait_run(
        &self,
        id: &str,
        poll_interval: Duration,
        timeout: Duration,
    ) -> Result<Value, ApiError> {
        let interval = poll_interval.max(Duration::from_millis(50));
        let deadline = std::time::Instant::now() + timeout;
        loop {
            let run = self.get_run(id).await?;
            let status = run.get("status").and_then(|v| v.as_str()).unwrap_or("");
            if matches!(status, "completed" | "failed" | "cancelled" | "stopped_budget") {
                return Ok(run);
            }
            if std::time::Instant::now() >= deadline {
                return Err(ApiError::local(
                    ErrorKind::Timeout,
                    "timeout",
                    format!("Timed out waiting for run '{}'.", id),
                ));
            }
            tokio::time::sleep(interval).await;
        }
    }

    pub async fn list_artifacts(&self, name: Option<&str>) -> Result<Value, ApiError> {
        let params = generated::ListArtifactsParams {
            name: name.map(|n| n.to_string()),
            ..Default::default()
        };
        value(self.wire.list_artifacts(Some(&params)).await)
    }

    pub async fn get_artifact(&self, reference: &str) -> Result<Value, ApiError> {
        value(self.wire.get_artifact(reference).await)
    }

    pub async fn download_artifact(&self, reference: &str) -> Result<Vec<u8>, ApiError> {
        let response = self.wire.download_artifact(reference).await?;
        let expected_sha = response.header("x-artifact-sha256").map(|s| s.to_string());
        let bytes = response.bytes().await?;
        let expected = expected_sha
            .map(|s| s.trim().to_ascii_lowercase())
            .filter(|s| s.len() == 64 && s.chars().all(|c| c.is_ascii_hexdigit()))
            .ok_or_else(|| {
                ApiError::local(
                    ErrorKind::Decode,
                    "missing_checksum",
                    "Artifact download missing valid X-Artifact-Sha256 header.",
                )
            })?;

        let mut hasher = Sha256::new();
        hasher.update(&bytes);
        let actual = hex::encode(hasher.finalize());
        if actual != expected {
            return Err(ApiError::local(
                ErrorKind::Decode,
                "checksum_mismatch",
                format!("expected {}, got {}", expected, actual),
            ));
        }
        Ok(bytes)
    }

    pub async fn deploy(
        &self,
        artifact: &str,
        name: Option<&str>,
        fallback: Option<&str>,
        explore_rate: f64,
    ) -> Result<Value, ApiError> {
        let mut body = json!({ "artifact": artifact, "explore_rate": explore_rate });
        if let Some(n) = name {
            body["name"] = json!(n);
        }
        if let Some(fb) = fallback {
            body["fallback"] = json!(fb);
        }
        value(self.wire.deploy_artifact(&typed(body)?).await)
    }

    pub async fn list_deployments(&self) -> Result<Value, ApiError> {
        value(self.wire.list_deployments(None).await)
    }

    pub async fn get_deployment(&self, name: &str) -> Result<Value, ApiError> {
        value(self.wire.get_deployment(name).await)
    }

    pub async fn route(
        &self,
        deployment: &str,
        messages: Vec<Value>,
        session_id: Option<&str>,
    ) -> Result<Value, ApiError> {
        let mut body = json!({ "deployment": deployment, "messages": messages });
        if let Some(sid) = session_id {
            body["session_id"] = json!(sid);
        }
        value(self.wire.route_request(&typed(body)?).await)
    }

    pub async fn embed(&self, model: &str, input: Vec<String>) -> Result<Value, ApiError> {
        let body = json!({ "model": model, "input": input });
        value(self.wire.create_embeddings(&typed(body)?).await)
    }

    pub async fn record_feedback(&self, events: Vec<Value>) -> Result<Value, ApiError> {
        let body = json!({ "events": events });
        value(self.wire.record_feedback(&typed(body)?).await)
    }

    pub async fn plan_eval(&self, body: &Value) -> Result<Value, ApiError> {
        value(self.wire.plan_eval(&typed(body.clone())?).await)
    }

    pub async fn create_eval(&self, body: &Value) -> Result<Value, ApiError> {
        value(self.wire.create_eval(&typed(body.clone())?).await)
    }

    pub async fn list_eval_failures(
        &self,
        eval_id: &str,
        model: Option<&str>,
        threshold: f64,
    ) -> Result<Value, ApiError> {
        let params = generated::ListEvalFailuresParams {
            threshold: Some(threshold),
            model: model.map(|m| m.to_string()),
            ..Default::default()
        };
        value(self.wire.list_eval_failures(eval_id, Some(&params)).await)
    }

    pub async fn create_api_key(&self, name: &str, scopes: Vec<String>) -> Result<Value, ApiError> {
        let body = json!({ "name": name, "scopes": scopes });
        value(self.wire.create_api_key(&typed(body)?).await)
    }

    pub async fn list_api_keys(&self) -> Result<Value, ApiError> {
        value(self.wire.list_api_keys(None).await)
    }

    pub async fn revoke_api_key(&self, id: &str) -> Result<Value, ApiError> {
        value(self.wire.revoke_api_key(id).await)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;

    #[test]
    fn debug_redacts_api_key() {
        let client = GradClient::new("http://127.0.0.1:8080", Some("grad_super_secret".into()));
        let dbg = format!("{:?}", client);
        assert!(!dbg.contains("grad_super_secret"));
        assert!(dbg.contains("REDACTED"));
    }

    #[tokio::test]
    async fn downloads_artifact_and_verifies_sha256_fail_closed() {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();

        let payload = b"rust-artifact-bytes";
        let mut hasher = Sha256::new();
        hasher.update(payload);
        let expected_sha = hex::encode(hasher.finalize()).to_uppercase();

        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.unwrap();
            let mut buf = [0u8; 1024];
            let _ = socket.read(&mut buf).await;
            let resp = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nX-Artifact-Sha256: {}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                expected_sha,
                payload.len()
            );
            socket.write_all(resp.as_bytes()).await.unwrap();
            socket.write_all(payload).await.unwrap();
        });

        let client = GradClient::new(format!("http://{}", addr), Some("grad_rs".to_string()));
        let bytes = client.download_artifact("demo@latest").await.unwrap();
        assert_eq!(bytes, payload);
        server.await.unwrap();
    }
}
