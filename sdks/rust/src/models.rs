//! Typed request and response models for the public `grad` API.
//!
//! Response structs deserialize leniently (`#[serde(default)]`) and keep any
//! field this SDK version does not know about in `extra`, so a newer server
//! never breaks an older client. Request structs skip unset optional fields
//! so server-side defaults keep applying.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $wire:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
        pub enum $name {
            $($variant,)+
            /// A value this SDK version does not know yet.
            #[default]
            Unknown,
            #[doc(hidden)]
            Other(String),
        }

        impl $name {
            /// The wire value.
            pub fn as_str(&self) -> &str {
                match self {
                    $($name::$variant => $wire,)+
                    $name::Unknown => "unknown",
                    $name::Other(s) => s.as_str(),
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl std::str::FromStr for $name {
            type Err = std::convert::Infallible;
            fn from_str(s: &str) -> Result<Self, Self::Err> {
                Ok(match s {
                    $($wire => $name::$variant,)+
                    other => $name::Other(other.to_string()),
                })
            }
        }

        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                let raw = Option::<String>::deserialize(d)?;
                Ok(match raw {
                    None => $name::Unknown,
                    Some(s) => s.parse().unwrap_or($name::Unknown),
                })
            }
        }
    };
}

string_enum!(
    /// Training run lifecycle status.
    RunStatus {
        Queued => "queued",
        Running => "running",
        Completed => "completed",
        Failed => "failed",
        Cancelled => "cancelled",
        StoppedBudget => "stopped_budget",
    }
);

impl RunStatus {
    /// `completed`, `failed`, `cancelled` or `stopped_budget`.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            RunStatus::Completed
                | RunStatus::Failed
                | RunStatus::Cancelled
                | RunStatus::StoppedBudget
        )
    }
}

string_enum!(
    /// Evaluation lifecycle status (`stopped_budget`: generation stopped at `max_cost_usd`).
    EvalStatus {
        Queued => "queued",
        Running => "running",
        AwaitingScores => "awaiting_scores",
        Completed => "completed",
        StoppedBudget => "stopped_budget",
        Failed => "failed",
        Cancelled => "cancelled",
    }
);

impl EvalStatus {
    /// `completed`, `stopped_budget`, `failed` or `cancelled`.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            EvalStatus::Completed
                | EvalStatus::StoppedBudget
                | EvalStatus::Failed
                | EvalStatus::Cancelled
        )
    }
}

string_enum!(
    /// Dataset import job status.
    ImportStatus {
        Queued => "queued",
        Running => "running",
        Completed => "completed",
        Failed => "failed",
    }
);

impl ImportStatus {
    /// `completed` or `failed`.
    pub fn is_terminal(&self) -> bool {
        matches!(self, ImportStatus::Completed | ImportStatus::Failed)
    }
}

string_enum!(
    /// Recipe kind.
    RecipeKind {
        Sft => "sft",
        Dpo => "dpo",
        Router => "router",
        Decision => "decision",
        Cartridge => "cartridge",
        Embedding => "embedding",
        Distill => "distill",
        Reward => "reward",
        Grpo => "grpo",
    }
);

/// A page of results with an opaque cursor for the next page.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Page<T> {
    #[serde(default = "Vec::new")]
    pub data: Vec<T>,
    #[serde(default)]
    pub next_cursor: Option<String>,
}

impl<T> Default for Page<T> {
    fn default() -> Self {
        Page {
            data: Vec::new(),
            next_cursor: None,
        }
    }
}

/// `limit`/`cursor` query for list endpoints.
#[derive(Debug, Clone, Default)]
pub struct ListParams {
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

impl ListParams {
    pub(crate) fn query(&self) -> Vec<(String, String)> {
        let mut q = Vec::new();
        if let Some(l) = self.limit {
            q.push(("limit".into(), l.to_string()));
        }
        if let Some(c) = &self.cursor {
            q.push(("cursor".into(), c.clone()));
        }
        q
    }
}

/// A trainable base model from the server catalog.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct TrainableModel {
    pub id: String,
    pub hf_repo: Option<String>,
    pub family: String,
    pub adapters: Vec<String>,
    pub recipes: Vec<RecipeKind>,
    pub default_for: Vec<RecipeKind>,
    pub price_per_million_tokens_usd: f64,
    pub max_context_tokens: u64,
    pub template_revision: String,
    pub calibrated_lrs: Map<String, Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A workspace API key (the secret is only returned once, at creation).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ApiKey {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub prefix: String,
    pub scopes: Vec<String>,
    pub created_at: String,
    pub revoked_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Response of `POST /v1/keys`.
#[derive(Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct CreatedApiKey {
    pub key: ApiKey,
    pub secret: String,
}

impl std::fmt::Debug for CreatedApiKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CreatedApiKey")
            .field("key", &self.key)
            .field("secret", &"[REDACTED]")
            .finish()
    }
}

/// A versioned dataset.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Dataset {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub version: u64,
    pub record_count: u64,
    pub metadata: Map<String, Value>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A page of dataset records.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct DatasetRecordsPage {
    pub dataset: String,
    pub version: u64,
    pub total: u64,
    pub data: Vec<Value>,
    pub next_cursor: Option<String>,
}

/// Body of `POST /v1/datasets/{name}/render`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RenderRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub train_on: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preserve_thinking: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// One rendered span of a chat-template preview.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RenderSpan {
    pub text: String,
    pub trained: bool,
    pub tokens: u64,
}

/// One rendered record.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RenderExample {
    pub record_id: String,
    pub template_revision: String,
    pub total_tokens: u64,
    pub trained_tokens: u64,
    pub trained_fraction: f64,
    pub spans: Vec<RenderSpan>,
}

/// Response of `POST /v1/datasets/{name}/render`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RenderDatasetResponse {
    pub dataset: String,
    pub model: String,
    pub template_revision: String,
    pub token_counts: String,
    pub examples: Vec<RenderExample>,
}

/// Upload ticket from `POST /v1/uploads`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct UploadTicket {
    pub upload_id: String,
    pub method: String,
    /// Absolute presigned URL, or a path relative to the API base URL.
    pub url: String,
    pub headers: std::collections::BTreeMap<String, String>,
    pub expires_at: String,
}

/// Column mapping for Hugging Face imports.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct HfColumns {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chosen: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejected: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub answer: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub positive: Option<String>,
}

impl HfColumns {
    /// Set a column by its mapping name (`messages`, `prompt`, ...).
    pub fn set(&mut self, key: &str, column: String) -> Result<(), String> {
        let slot = match key {
            "messages" => &mut self.messages,
            "prompt" => &mut self.prompt,
            "completion" => &mut self.completion,
            "chosen" => &mut self.chosen,
            "rejected" => &mut self.rejected,
            "answer" => &mut self.answer,
            "query" => &mut self.query,
            "positive" => &mut self.positive,
            other => {
                return Err(format!(
                    "unknown column mapping '{}' (expected messages, prompt, completion, chosen, rejected, answer, query or positive)",
                    other
                ))
            }
        };
        *slot = Some(column);
        Ok(())
    }

    pub fn is_empty(&self) -> bool {
        self == &HfColumns::default()
    }
}

/// Source of a dataset import.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ImportSource {
    /// A file uploaded with `POST /v1/uploads`.
    Upload {
        upload_id: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        format: Option<String>,
    },
    /// A Hugging Face dataset pulled by the trainer worker.
    Hf {
        repo: String,
        #[serde(skip_serializing_if = "Option::is_none")]
        split: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        config: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        revision: Option<String>,
        #[serde(skip_serializing_if = "Option::is_none")]
        columns: Option<HfColumns>,
        #[serde(skip_serializing_if = "Option::is_none")]
        limit: Option<u64>,
    },
}

/// Body of `POST /v1/datasets/{name}/imports`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CreateImportRequest {
    pub source: ImportSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connector: Option<String>,
}

/// An asynchronous dataset import job.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ImportJob {
    pub id: String,
    pub workspace_id: String,
    pub dataset: String,
    pub status: ImportStatus,
    pub source: Map<String, Value>,
    pub connector: String,
    pub attempt: u32,
    pub imported_count: u64,
    pub dropped_count: u64,
    pub detected_scores: Vec<String>,
    pub drop_reasons: Vec<String>,
    pub dataset_version: Option<u64>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Adapter configuration for a recipe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum AdapterSpec {
    Lora {
        #[serde(skip_serializing_if = "Option::is_none")]
        rank: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        alpha: Option<u32>,
        #[serde(skip_serializing_if = "Option::is_none")]
        merge_on_export: Option<bool>,
    },
    PrefixKv {
        #[serde(skip_serializing_if = "Option::is_none")]
        num_tokens: Option<u32>,
    },
    FrozenHead {},
    EncoderFull {},
}

/// A training recipe. Only set fields are sent; the server resolves the rest.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RecipeSpec {
    pub kind: RecipeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter: Option<AdapterSpec>,
    /// `"auto"` or a number.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lr: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lr_scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_size: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub epochs: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warmup: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub train_on: Option<String>,
    /// `"auto"`, `true` or `false`.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preserve_thinking: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reduction: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub select: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint_ttl_days: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beta: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_quality_drop: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temp: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teacher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub env_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_size: Option<u32>,
}

impl RecipeSpec {
    /// A recipe of `kind` with every parameter at its server default.
    pub fn new(kind: RecipeKind) -> Self {
        RecipeSpec {
            kind,
            ..Default::default()
        }
    }

    /// Set the base model.
    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }
}

/// Held-out split configuration.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct SplitSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_fraction: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<u64>,
}

/// Body of `POST /v1/runs/plan` and `POST /v1/runs`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RunRequest {
    pub dataset: String,
    pub name: String,
    pub recipe: RecipeSpec,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub split: Option<SplitSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_cost_usd: Option<f64>,
}

impl RunRequest {
    pub fn new(dataset: impl Into<String>, name: impl Into<String>, recipe: RecipeSpec) -> Self {
        RunRequest {
            dataset: dataset.into(),
            name: name.into(),
            recipe,
            split: None,
            max_cost_usd: None,
        }
    }

    pub fn max_cost_usd(mut self, cap: f64) -> Self {
        self.max_cost_usd = Some(cap);
        self
    }
}

/// Resolved held-out split of a run.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ResolvedSplit {
    pub strategy: String,
    pub eval_fraction: f64,
    pub seed: u64,
    pub train_records: u64,
    pub eval_records: u64,
}

/// Every default resolved by the server for a run.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct ResolvedRunConfig {
    pub rule_version: String,
    pub dataset: String,
    pub dataset_version: u64,
    pub name: String,
    pub recipe_kind: RecipeKind,
    pub model: String,
    pub template_revision: String,
    pub adapter: Value,
    pub lr: f64,
    pub lr_source: String,
    pub batch_size: u64,
    pub epochs: u64,
    pub schedule: String,
    pub warmup: f64,
    pub train_on: String,
    pub thinking: Value,
    pub preserve_thinking: bool,
    pub reduction: String,
    pub select: String,
    pub checkpoint_every_steps: u64,
    pub checkpoint_ttl_days: u64,
    pub split: ResolvedSplit,
    pub recipe_params: Map<String, Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Dry-run result of `POST /v1/runs/plan`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RunPlan {
    pub resolved_config: ResolvedRunConfig,
    pub dataset_version: u64,
    pub usable_records: u64,
    pub total_records: u64,
    pub estimated_steps: u64,
    pub estimated_tokens: u64,
    pub estimated_cost_usd: f64,
    pub price_per_million_tokens: f64,
    pub trained_token_fraction: f64,
    pub warnings: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One training-step metric point.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct MetricPoint {
    pub seq: u64,
    pub attempt: u32,
    pub step: u64,
    pub loss: f64,
    pub eval_loss: Option<f64>,
    pub eval_metric: Option<f64>,
    pub grad_norm: Option<f64>,
    pub lr: Option<f64>,
    pub tokens_per_sec: Option<f64>,
    pub tokens: u64,
    pub cost_usd: f64,
    pub timestamp: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A page of metrics from `GET /v1/runs/{id}/metrics`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct MetricsPage {
    pub run_id: String,
    pub status: RunStatus,
    pub data: Vec<MetricPoint>,
    pub next_cursor: Option<String>,
}

/// Query for `GET /v1/runs/{id}/metrics`.
#[derive(Debug, Clone, Default)]
pub struct MetricsQuery {
    pub cursor: Option<String>,
    pub after_step: Option<i64>,
    pub limit: Option<u32>,
}

/// A training run.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Run {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub dataset_id: String,
    pub dataset_name: String,
    pub dataset_version: u64,
    pub recipe_kind: RecipeKind,
    pub status: RunStatus,
    pub resolved_config: ResolvedRunConfig,
    pub max_cost_usd: Option<f64>,
    pub price_per_million_tokens: f64,
    pub tokens_processed: u64,
    pub cost_usd: f64,
    pub current_step: u64,
    pub total_steps: u64,
    pub attempt: u32,
    pub max_attempts: u32,
    pub latest_metric: Option<MetricPoint>,
    pub eval_report: Option<Value>,
    pub artifact_id: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A run checkpoint.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Checkpoint {
    pub id: String,
    pub workspace_id: String,
    pub run_id: String,
    pub attempt: u32,
    pub step: u64,
    pub eval_score: Option<f64>,
    pub format: Option<String>,
    pub sha256: String,
    pub size_bytes: u64,
    pub metadata: Map<String, Value>,
    pub best: bool,
    #[serde(rename = "final")]
    pub is_final: bool,
    pub expires_at: Option<String>,
    pub created_at: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// An immutable, versioned artifact.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Artifact {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub version: String,
    pub run_id: Option<String>,
    pub checkpoint_id: Option<String>,
    pub base_model: String,
    pub recipe_kind: RecipeKind,
    pub format: Option<String>,
    pub sha256: String,
    pub size_bytes: u64,
    pub manifest: Map<String, Value>,
    pub eval_report: Option<Value>,
    pub created_at: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl Artifact {
    /// `name@version`.
    pub fn reference(&self) -> String {
        format!("{}@{}", self.name, self.version)
    }
}

/// Body of `POST /v1/deployments`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct DeployRequest {
    /// Artifact id or `name@version` / `name@latest`.
    pub artifact: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explore_rate: Option<f64>,
}

/// A deployment behind a stable model name.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Deployment {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub model_id: String,
    pub active_artifact_id: String,
    pub previous_artifact_id: Option<String>,
    pub fallback_model: Option<String>,
    pub explore_rate: f64,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Response of `GET /v1/deployments/{name}`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct DeploymentStatus {
    pub deployment: Deployment,
    pub feedback_count: u64,
    pub average_score: Option<f64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// A chat message.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct ChatMessage {
    pub role: String,
    pub content: Value,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

impl ChatMessage {
    pub fn user(content: impl Into<String>) -> Self {
        ChatMessage {
            role: "user".into(),
            content: Value::String(content.into()),
            extra: Map::new(),
        }
    }
}

/// Body of `POST /v1/route`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RouteRequest {
    pub deployment: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// A routing decision.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct RouteDecision {
    pub inference_id: String,
    pub deployment: String,
    pub artifact_id: String,
    pub model: String,
    pub is_exploration: bool,
    pub confidence: f64,
    pub scores: Map<String, Value>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// One embedding.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Embedding {
    pub index: u64,
    pub embedding: Vec<f64>,
}

/// Response of `POST /v1/embeddings`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EmbeddingsResponse {
    pub model: String,
    pub data: Vec<Embedding>,
    pub usage: Map<String, Value>,
}

/// One outcome event for `POST /v1/feedback`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct FeedbackEvent {
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inference_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_output: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<Map<String, Value>>,
}

/// Response of `POST /v1/feedback`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct FeedbackResponse {
    pub accepted: u64,
    pub deduplicated: u64,
    pub records: Vec<Value>,
}

/// One rubric item of an evaluation.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct RubricItem {
    pub name: String,
    /// `regex`, `validator`, `code` or `judge`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flags: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validator: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<String>,
}

/// Body of `POST /v1/evals/plan` and `POST /v1/evals`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct EvalRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dataset: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dataset_version: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rubric: Option<Vec<RubricItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub samples: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pass_threshold: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_cost_usd: Option<f64>,
}

/// Response of `POST /v1/evals/plan`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EvalPlan {
    pub task_source_kind: String,
    pub dataset_version: u64,
    pub estimated_tasks: u64,
    pub estimated_model_calls: u64,
    pub estimated_judge_calls: u64,
    pub estimated_cost_usd: f64,
    pub judge_models: Vec<String>,
    pub local_scorers: Vec<String>,
    pub pass_threshold: f64,
    pub warnings: Vec<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Per-model summary of an evaluation.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EvalModelSummary {
    pub model: String,
    pub overall: f64,
    pub ci_low: f64,
    pub ci_high: f64,
    pub pass_at_k: Map<String, Value>,
    pub vs_baseline: Option<Value>,
    pub tasks: u64,
    pub errors: u64,
    pub tokens_per_task: f64,
    pub cost_per_1k_tasks_usd: Option<f64>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Progress counters of an evaluation.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EvalProgress {
    pub total_outputs: u64,
    pub generated: u64,
    pub pending_local_scores: u64,
}

/// An evaluation run.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EvalRun {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub status: EvalStatus,
    pub models: Vec<String>,
    pub baseline: Option<String>,
    pub task_source: Map<String, Value>,
    pub rubric: Vec<RubricItem>,
    pub samples: u32,
    pub temperature: f64,
    pub max_tokens: u32,
    pub pass_threshold: f64,
    pub judge_models: Vec<String>,
    pub local_scorers: Vec<String>,
    pub progress: EvalProgress,
    pub summary: Vec<EvalModelSummary>,
    pub total_cost_usd: f64,
    /// Spend cap; generation stops at it (`stopped_budget`).
    pub max_cost_usd: Option<f64>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
    #[serde(flatten)]
    pub extra: Map<String, Value>,
}

/// Per-task, per-model outcome of an evaluation.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EvalTaskOutcome {
    pub task_id: String,
    pub model: String,
    pub score: f64,
    pub passed: bool,
    pub sample_scores: Vec<f64>,
    pub judge_model: Option<String>,
    pub record: Value,
}

/// A generated output of an evaluation.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct EvalOutput {
    pub id: String,
    pub eval_id: String,
    pub task_id: String,
    pub model: String,
    pub sample_index: u32,
    pub input: Vec<Value>,
    pub output: Option<String>,
    pub expected_output: Option<Value>,
    pub record: Value,
    pub scores: Map<String, Value>,
    pub error: Option<String>,
    pub usage: Map<String, Value>,
}

/// One locally computed score for `POST /v1/evals/{id}/scores`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct LocalScore {
    pub output_id: String,
    pub scorer: String,
    pub score: f64,
}

/// Response of `POST /v1/evals/{id}/scores`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct PostScoresResponse {
    pub accepted: u64,
    pub status: EvalStatus,
    pub pending_local_scores: u64,
}

/// Body of `POST /v1/env-workers/tasks`.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
pub struct EnvTaskDispatch {
    pub env_name: String,
    pub task: Map<String, Value>,
    pub model_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub system_prompt: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timeout_s: Option<u32>,
}
