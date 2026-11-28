// AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.
//! Request and response models of the schemas the SDK uses (see `RUST_MODELS` in scripts/codegen/rust.mjs).
//! Structs decode leniently (missing fields take their defaults) and string enums keep unknown values in `Other`.
#![allow(clippy::all, clippy::pedantic)]

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::BTreeMap;

/// A string enum that keeps values from newer servers in `Other` (default: the first variant).
macro_rules! string_enum {
    ($(#[$meta:meta])* $name:ident { $first:ident => $first_wire:literal $(, $variant:ident => $wire:literal)* $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, PartialEq, Eq, Hash, Default)]
        pub enum $name {
            #[default]
            $first,
            $($variant,)*
            /// A value this SDK version does not know.
            Other(String),
        }

        impl $name {
            /// The wire value.
            pub fn as_str(&self) -> &str {
                match self {
                    Self::$first => $first_wire,
                    $(Self::$variant => $wire,)*
                    Self::Other(s) => s.as_str(),
                }
            }
        }

        impl From<&str> for $name {
            fn from(s: &str) -> Self {
                match s {
                    $first_wire => Self::$first,
                    $($wire => Self::$variant,)*
                    other => Self::Other(other.to_string()),
                }
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str(self.as_str())
            }
        }

        impl Serialize for $name {
            fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
                s.serialize_str(self.as_str())
            }
        }

        impl<'de> Deserialize<'de> for $name {
            fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
                Ok(Self::from(String::deserialize(d)?.as_str()))
            }
        }
    };
}

/// A union of object shapes: set the fields of exactly one variant.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AdapterSpec {
    pub kind: AdapterSpecKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rank: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alpha: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_on_export: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_tokens: Option<i64>,
}

string_enum! {
    /// Allowed values of `AdapterSpecKind`.
    AdapterSpecKind {
        Lora => "lora",
        PrefixKv => "prefix_kv",
        FrozenHead => "frozen_head",
    }
}

/// Generated from the OpenAPI schema `ApiKey`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ApiKey {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub prefix: String,
    pub scopes: Vec<ApiKeyScope>,
    pub created_at: String,
    pub revoked_at: Option<String>,
}

string_enum! {
    /// `x:write` implies `x:read`; `admin` implies every workspace scope. `artifacts:pin` (pin and unpin artifacts; Gradiated Cloud's publishing calls it) is implied by `admin` only. `deployments:write`, `feedback:write` and `env:serve` are Gradiated Cloud scopes: grad-server accepts them on a key but none of its endpoints checks them.
    ApiKeyScope {
        Admin => "admin",
        DatasetsRead => "datasets:read",
        DatasetsWrite => "datasets:write",
        RunsRead => "runs:read",
        RunsWrite => "runs:write",
        ArtifactsRead => "artifacts:read",
        ArtifactsWrite => "artifacts:write",
        ArtifactsPin => "artifacts:pin",
        SecretsRead => "secrets:read",
        SecretsWrite => "secrets:write",
        SourcesRead => "sources:read",
        SourcesWrite => "sources:write",
        DeploymentsWrite => "deployments:write",
        FeedbackWrite => "feedback:write",
        EnvServe => "env:serve",
    }
}

/// Generated from the OpenAPI schema `Artifact`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
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
    pub format: Option<ArtifactFormat>,
    pub sha256: String,
    pub size_bytes: i64,
    pub manifest: BTreeMap<String, Value>,
    pub provenance: ArtifactProvenance,
    pub eval_report: Option<EvalReport>,
    pub created_at: String,
}

/// Generated from the OpenAPI schema `ArtifactDownloadUrl`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ArtifactDownloadUrl {
    /// A presigned GET of the bundle (.grad.tar.gz) straight from storage; no Authorization header. Verify its SHA-256.
    pub url: String,
    pub expires_at: String,
    pub sha256: String,
    pub size_bytes: i64,
    pub filename: String,
}

string_enum! {
    /// Artifact format when this checkpoint is exportable (promotable); null for training state only.
    ArtifactFormat {
        PeftLora => "peft_lora",
        MergedSafetensors => "merged_safetensors",
        PrefixKv => "prefix_kv",
        Cartridge => "cartridge",
        EncoderSafetensors => "encoder_safetensors",
        RouterBundle => "router_bundle",
        DecisionBundle => "decision_bundle",
        RewardBundle => "reward_bundle",
        Reference => "reference",
    }
}

/// Generated from the OpenAPI schema `ArtifactImport`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ArtifactImport {
    pub id: String,
    pub workspace_id: String,
    pub status: ArtifactImportStatus,
    pub name: String,
    pub base_model: String,
    pub format: Option<ArtifactFormat>,
    pub source: ArtifactImportSourceType,
    /// The artifact (name@version) once the import completed.
    pub artifact_id: Option<String>,
    /// Why it failed. Validation failures name the file and the problem (`adapter_config.json: ...`).
    pub error: Option<String>,
    /// invalid_artifact (the files don't match the format spec or the base model), source_unavailable, or null.
    pub error_code: Option<String>,
    pub attempt: i64,
    pub created_at: String,
    pub updated_at: String,
}

/// A union of object shapes: set the fields of exactly one variant.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ArtifactImportSource {
    pub kind: ArtifactImportSourceKind,
    /// A tar (optionally gzip) of the artifact's files, uploaded with POST /v1/uploads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    /// Branch, tag or commit (default main). The import pins the commit it resolves.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    /// Name of a workspace secret holding a Hugging Face token, for gated or private repos.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

string_enum! {
    /// Allowed values of `ArtifactImportSourceKind`.
    ArtifactImportSourceKind {
        Upload => "upload",
        Hf => "hf",
    }
}

/// Generated from the OpenAPI schema `ArtifactImportSourceType`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ArtifactImportSourceType {
    pub kind: ArtifactImportSourceTypeKind,
    pub upload_id: Option<String>,
    pub repo: Option<String>,
    /// HF imports: the requested revision, then the pinned commit once imported.
    pub revision: Option<String>,
}

string_enum! {
    /// Allowed values of `ArtifactImportSourceTypeKind`.
    ArtifactImportSourceTypeKind {
        Upload => "upload",
        Hf => "hf",
    }
}

string_enum! {
    /// Allowed values of `ArtifactImportStatus`.
    ArtifactImportStatus {
        Queued => "queued",
        Running => "running",
        Completed => "completed",
        Failed => "failed",
    }
}

/// Generated from the OpenAPI schema `ArtifactProvenance`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ArtifactProvenance {
    /// run: trained by a grad run; upload: files uploaded with `grad artifacts upload`; import: pulled from the Hugging Face Hub with `grad artifacts import`.
    pub source: ArtifactProvenanceSource,
    /// source=run: the run that trained it.
    pub run_id: Option<String>,
    /// source=upload: the API key (principal) that uploaded it.
    pub uploader: Option<String>,
    /// source=import: `hf://owner/name@<40-hex commit>`, the pinned revision it was imported from.
    pub uri: Option<String>,
}

string_enum! {
    /// run: trained by a grad run; upload: files uploaded with `grad artifacts upload`; import: pulled from the Hugging Face Hub with `grad artifacts import`.
    ArtifactProvenanceSource {
        Run => "run",
        Upload => "upload",
        Import => "import",
    }
}

/// Continued training: the artifact whose adapter the run starts from (recipe.model was an artifact reference).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct BaseArtifact {
    pub id: String,
    pub recipe_kind: RecipeKind,
    pub format: BaseArtifactFormat,
    pub sha256: String,
}

string_enum! {
    /// Allowed values of `BaseArtifactFormat`.
    BaseArtifactFormat {
        PeftLora => "peft_lora",
    }
}

/// Generated from the OpenAPI schema `ChatMessage`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ChatMessage {
    pub role: ChatMessageRole,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub content: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_calls: Option<Vec<BTreeMap<String, Value>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub train: Option<bool>,
    /// Members not declared in the schema (round-tripped verbatim).
    #[serde(flatten)]
    pub additional_properties: BTreeMap<String, Value>,
}

string_enum! {
    /// Allowed values of `ChatMessageRole`.
    ChatMessageRole {
        System => "system",
        User => "user",
        Assistant => "assistant",
        Tool => "tool",
    }
}

/// Generated from the OpenAPI schema `Checkpoint`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Checkpoint {
    pub id: String,
    pub workspace_id: String,
    pub run_id: String,
    pub attempt: i64,
    pub step: i64,
    pub eval_score: Option<f64>,
    pub format: Option<ArtifactFormat>,
    pub sha256: String,
    pub size_bytes: i64,
    pub metadata: BTreeMap<String, Value>,
    pub best: bool,
    pub r#final: bool,
    pub expires_at: Option<String>,
    pub created_at: String,
}

/// Generated from the OpenAPI schema `CheckpointEvalResult`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CheckpointEvalResult {
    pub name: String,
    pub step: i64,
    pub checkpoint_id: String,
    pub eval_id: Option<String>,
    pub dataset: String,
    pub dataset_version: i64,
    pub status: CheckpointEvalResultStatus,
    /// The checkpoint's overall rubric score (null unless completed).
    pub score: Option<f64>,
    pub cost_usd: f64,
    pub error: Option<String>,
}

string_enum! {
    /// Allowed values of `CheckpointEvalResultStatus`.
    CheckpointEvalResultStatus {
        Completed => "completed",
        Failed => "failed",
        Cancelled => "cancelled",
    }
}

/// Generated from the OpenAPI schema `CreateArtifactImportRequest`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CreateArtifactImportRequest {
    pub source: ArtifactImportSource,
    /// The catalog base model (GET /v1/base-models) the files were trained on.
    pub base_model: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<ImportableArtifactFormat>,
    /// The artifact name (name@YYYY-MM-DD-n). Required for uploads; HF imports default to the repo's name.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Generated from the OpenAPI schema `CreateImportRequest`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CreateImportRequest {
    pub source: ImportSource,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub connector: Option<CreateImportRequestConnector>,
}

string_enum! {
    /// Allowed values of `CreateImportRequestConnector`.
    CreateImportRequestConnector {
        Auto => "auto",
        GradTrajectories => "grad_trajectories",
        OpenaiChat => "openai_chat",
        Gradiated => "gradiated",
        Otel => "otel",
        Langfuse => "langfuse",
        Posthog => "posthog",
        Braintrust => "braintrust",
        Langsmith => "langsmith",
    }
}

/// Generated from the OpenAPI schema `Dataset`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Dataset {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub version: i64,
    /// Records in the current version after merging: score updates fold into their records, and a full source sync restarts the count. A record pushed again with an id it already has counts again.
    pub record_count: i64,
    pub metadata: BTreeMap<String, Value>,
    pub created_at: String,
    pub updated_at: String,
}

/// Generated from the OpenAPI schema `DatasetRecord`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DatasetRecord {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schema: Option<DatasetRecordSchema>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub group_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub role: Option<DatasetRecordRole>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timestamp: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<Vec<ChatMessage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<BTreeMap<String, Value>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub input: Option<TrajectoryInput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output: Option<TrajectoryOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub completion: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chosen: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rejected: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub query: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub positive: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub negatives: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub state: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub questions: Option<BTreeMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_output: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scores: Option<BTreeMap<String, f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<BTreeMap<String, f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
}

string_enum! {
    /// Allowed values of `DatasetRecordRole`.
    DatasetRecordRole {
        Chosen => "chosen",
        Rejected => "rejected",
        Anchor => "anchor",
        Positive => "positive",
        Negative => "negative",
        Desirable => "desirable",
        Undesirable => "undesirable",
        Rollout => "rollout",
    }
}

string_enum! {
    /// Allowed values of `DatasetRecordSchema`.
    DatasetRecordSchema {
        GradTrajectory1 => "grad.trajectory/1",
    }
}

/// Generated from the OpenAPI schema `DatasetRecordsPage`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DatasetRecordsPage {
    pub dataset: String,
    pub version: i64,
    pub total: i64,
    pub data: Vec<DatasetRecord>,
    /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
    pub next_cursor: Option<String>,
}

/// Generated from the OpenAPI schema `DecisionHeadReport`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DecisionHeadReport {
    pub r#type: DecisionHeadReportType,
    pub examples: i64,
    pub accuracy: Option<f64>,
    pub ece: Option<f64>,
    pub temperature: f64,
    /// Written by: noul heads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub brier: Option<f64>,
    /// Written by: score heads.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mae: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub macro_f1: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub per_option: Option<BTreeMap<String, DecisionHeadReportPerOptionValue>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub confusion_matrix: Option<DecisionHeadReportConfusionMatrix>,
    /// Members not declared in the schema (round-tripped verbatim).
    #[serde(flatten)]
    pub additional_properties: BTreeMap<String, Value>,
}

/// Generated from the OpenAPI schema `DecisionHeadReportConfusionMatrix`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DecisionHeadReportConfusionMatrix {
    pub labels: Vec<String>,
    pub matrix: Vec<Vec<i64>>,
}

/// Generated from the OpenAPI schema `DecisionHeadReportPerOptionValue`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DecisionHeadReportPerOptionValue {
    pub precision: Option<f64>,
    pub recall: Option<f64>,
    pub f1: Option<f64>,
    pub support: i64,
}

string_enum! {
    /// Allowed values of `DecisionHeadReportType`.
    DecisionHeadReportType {
        Choice => "choice",
        Noul => "noul",
        Score => "score",
    }
}

string_enum! {
    /// `eval` generates outputs from `models`; `score` (`dataset.score()`) grades each record's own output (model `record`) and writes the scores to the dataset's next version.
    EvalMode {
        Eval => "eval",
        Score => "score",
    }
}

/// Generated from the OpenAPI schema `EvalModelSummary`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EvalModelSummary {
    pub model: String,
    pub overall: f64,
    pub ci_low: f64,
    pub ci_high: f64,
    pub pass_at_k: BTreeMap<String, f64>,
    pub vs_baseline: Option<EvalModelSummaryVsBaseline>,
    pub tasks: i64,
    pub errors: i64,
    pub tokens_per_task: f64,
    pub cost_per_1k_tasks_usd: Option<f64>,
}

/// Generated from the OpenAPI schema `EvalModelSummaryVsBaseline`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EvalModelSummaryVsBaseline {
    pub delta: f64,
    pub ci_low: f64,
    pub ci_high: f64,
}

/// Generated from the OpenAPI schema `EvalOutput`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EvalOutput {
    pub id: String,
    pub eval_id: String,
    pub task_id: String,
    pub model: String,
    pub sample_index: i64,
    pub input: Vec<ChatMessage>,
    pub output: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_output: Option<Value>,
    pub record: DatasetRecord,
    pub scores: BTreeMap<String, f64>,
    pub error: Option<String>,
    pub usage: EvalOutputUsage,
}

/// Generated from the OpenAPI schema `EvalOutputUsage`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EvalOutputUsage {
    pub prompt_tokens: i64,
    pub completion_tokens: i64,
}

/// Generated from the OpenAPI schema `EvalReport`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EvalReport {
    /// Selection metric: eval_loss (sft, router, decision, off-policy distill, pointwise-only reward), preference_accuracy (dpo, reward), eval_kl (cartridge, on-policy distill), recall_at_10 (embedding).
    pub metric_name: String,
    /// Direction of metric_name: min (lower is better: eval_loss, eval_kl) or max (higher is better: preference_accuracy, recall_at_10). best_step and the pinned best checkpoint follow it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metric_mode: Option<EvalReportMetricMode>,
    pub selected_step: i64,
    pub best_step: Option<i64>,
    pub final_step: i64,
    pub train_records: i64,
    pub eval_records: i64,
    pub warnings: Vec<String>,
    /// Written by: sft, dpo, router, decision, distill, reward.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_loss: Option<f64>,
    /// Written by: sft, distill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_token_accuracy: Option<f64>,
    /// Written by: sft.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trained_token_fraction: Option<f64>,
    /// Written by: sft, distill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub train_examples: Option<i64>,
    /// Written by: sft, router, decision, distill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_examples: Option<i64>,
    /// Written by: router, decision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_examples: Option<i64>,
    /// Written by: sft, dpo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<i64>,
    /// Share of held-out pairs whose chosen answer outscores the rejected one. Written by: dpo, reward.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preference_accuracy: Option<f64>,
    /// Written by: dpo, reward.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reward_margin: Option<f64>,
    /// Written by: dpo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beta: Option<f64>,
    /// Written by: dpo, embedding, reward.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub train_pairs: Option<i64>,
    /// Written by: dpo, embedding, reward.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_pairs: Option<i64>,
    /// Written by: dpo, embedding, reward.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped_records: Option<i64>,
    /// Written by: reward (pointwise).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub train_points: Option<i64>,
    /// Written by: reward (pointwise).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_points: Option<i64>,
    /// Mean squared error of sigmoid(reward) against the held-out scores. Written by: reward (pointwise).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pointwise_brier: Option<f64>,
    /// Written by: cartridge, distill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_kl: Option<f64>,
    /// Held-out KL of the untrained student to the teacher. Written by: distill (on-policy).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub base_kl: Option<f64>,
    /// Written by: cartridge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_context_kl: Option<f64>,
    /// Written by: cartridge, distill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kl_reduction: Option<f64>,
    /// Written by: cartridge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_tokens: Option<i64>,
    /// Written by: cartridge, distill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teacher: Option<String>,
    /// Written by: distill.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollout: Option<EvalReportRollout>,
    /// Written by: router.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub candidates: Option<Vec<String>>,
    /// Written by: router.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_model: Option<String>,
    /// Written by: router.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback_quality: Option<f64>,
    /// Written by: router.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub routes_any_traffic: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pareto_summary: Option<RouterParetoSummary>,
    /// Written by: decision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ece: Option<f64>,
    /// Written by: decision (one entry per question).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub heads: Option<BTreeMap<String, DecisionHeadReport>>,
    /// Written by: embedding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recall_at_1: Option<f64>,
    /// Written by: embedding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recall_at_5: Option<f64>,
    /// Written by: embedding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recall_at_10: Option<f64>,
    /// Written by: embedding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mrr: Option<f64>,
    /// Written by: embedding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub corpus_size: Option<i64>,
    /// Retrieval metrics of the untrained base encoder. Written by: embedding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<EvalReportBaseline>,
    /// Members not declared in the schema (round-tripped verbatim).
    #[serde(flatten)]
    pub additional_properties: BTreeMap<String, Value>,
}

/// Retrieval metrics of the untrained base encoder. Written by: embedding.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EvalReportBaseline {
    pub recall_at_1: Option<f64>,
    pub recall_at_5: Option<f64>,
    pub recall_at_10: Option<f64>,
    pub mrr: Option<f64>,
    /// Members not declared in the schema (round-tripped verbatim).
    #[serde(flatten)]
    pub additional_properties: BTreeMap<String, Value>,
}

string_enum! {
    /// Direction of metric_name: min (lower is better: eval_loss, eval_kl) or max (higher is better: preference_accuracy, recall_at_10). best_step and the pinned best checkpoint follow it.
    EvalReportMetricMode {
        Min => "min",
        Max => "max",
    }
}

string_enum! {
    /// Written by: distill.
    EvalReportRollout {
        OnPolicy => "on_policy",
        OffPolicy => "off_policy",
    }
}

/// Generated from the OpenAPI schema `EvalRubricItem`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EvalRubricItem {
    pub name: String,
    pub kind: EvalRubricItemKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pattern: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub flags: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub validator: Option<EvalRubricItemValidator>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub prompt: Option<String>,
    /// Code scorers always run in the SDK process (`local`); the eval waits in `awaiting_scores` until the SDK posts their scores.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runtime: Option<EvalRubricItemRuntime>,
}

string_enum! {
    /// Allowed values of `EvalRubricItemKind`.
    EvalRubricItemKind {
        Regex => "regex",
        Validator => "validator",
        Code => "code",
        Judge => "judge",
    }
}

string_enum! {
    /// Code scorers always run in the SDK process (`local`); the eval waits in `awaiting_scores` until the SDK posts their scores.
    EvalRubricItemRuntime {
        Local => "local",
    }
}

string_enum! {
    /// Allowed values of `EvalRubricItemValidator`.
    EvalRubricItemValidator {
        Json => "json",
        NonEmpty => "non_empty",
        ExactMatch => "exact_match",
        FinalNumber => "final_number",
        Choice => "choice",
    }
}

/// Generated from the OpenAPI schema `EvalRun`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EvalRun {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub status: EvalStatus,
    pub mode: EvalMode,
    pub models: Vec<String>,
    pub baseline: Option<String>,
    pub task_source: EvalRunTaskSource,
    pub rubric: Vec<EvalRubricItem>,
    pub samples: i64,
    pub temperature: f64,
    pub max_tokens: i64,
    pub pass_threshold: f64,
    pub judge_models: Vec<String>,
    pub local_scorers: Vec<String>,
    pub progress: EvalRunProgress,
    pub summary: Vec<EvalModelSummary>,
    pub total_cost_usd: f64,
    /// Scoring jobs: the dataset version holding the new scores (the source version when every record was already scored); null until completed.
    pub scored_dataset_version: Option<i64>,
    pub error: Option<String>,
    /// While running: the eval's model calls are waiting for capacity (a serving pool at zero that has not woken yet), for a rate limit (a full eval lane), or for an inference endpoint that is down. The worker keeps its lease and retries; this is not counted as a failed attempt. null otherwise.
    pub waiting_reason: Option<EvalRunWaitingReason>,
    pub created_at: String,
    pub updated_at: String,
    pub completed_at: Option<String>,
}

/// Generated from the OpenAPI schema `EvalRunProgress`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EvalRunProgress {
    pub total_outputs: i64,
    pub generated: i64,
    pub pending_local_scores: i64,
}

/// Generated from the OpenAPI schema `EvalRunTaskSource`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EvalRunTaskSource {
    pub kind: EvalRunTaskSourceKind,
    pub dataset: String,
    pub version: i64,
}

string_enum! {
    /// Allowed values of `EvalRunTaskSourceKind`.
    EvalRunTaskSourceKind {
        Dataset => "dataset",
    }
}

string_enum! {
    /// Allowed values of `EvalRunWaitingReason`.
    EvalRunWaitingReason {
        CapacityUnavailable => "capacity_unavailable",
        RateLimited => "rate_limited",
        InferenceUnavailable => "inference_unavailable",
    }
}

string_enum! {
    /// Allowed values of `EvalStatus`.
    EvalStatus {
        Queued => "queued",
        Running => "running",
        AwaitingScores => "awaiting_scores",
        Completed => "completed",
        Failed => "failed",
        Cancelled => "cancelled",
    }
}

/// Generated from the OpenAPI schema `EvalTaskOutcome`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EvalTaskOutcome {
    pub task_id: String,
    pub model: String,
    pub score: f64,
    pub passed: bool,
    pub sample_scores: Vec<f64>,
    pub judge_model: Option<String>,
    pub record: DatasetRecord,
}

/// Generated from the OpenAPI schema `FilterDatasetRequest`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FilterDatasetRequest {
    /// Conditions on stored scores, `{name: "<op><number>"}` with op one of >=, <=, >, <, ==, != (a bare number means ==). A record without the score does not match.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scores: Option<BTreeMap<String, Value>>,
    /// Exact matches on `metadata` fields.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<BTreeMap<String, Value>>,
    /// Records whose `timestamp` is at or after this time (a timestamp with offset, or a UTC date `YYYY-MM-DD`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_after: Option<Value>,
    /// Records whose `timestamp` is before this time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created_before: Option<Value>,
    /// Keep only these record ids (what the SDKs send for a filter function they ran locally).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ids: Option<Vec<String>>,
    /// Source version to filter (default: the current version).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    /// Name of the view. Default: `<dataset>-f-<hash of source, version and filter>`, so the same filter returns the same view.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

/// Generated from the OpenAPI schema `HfColumnMapping`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct HfColumnMapping {
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

/// Generated from the OpenAPI schema `ImportJob`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ImportJob {
    pub id: String,
    pub workspace_id: String,
    pub dataset: String,
    pub status: ImportStatus,
    pub source: BTreeMap<String, Value>,
    pub connector: ImportJobConnector,
    pub attempt: i64,
    /// Records this import added to the dataset (score updates for existing records add none).
    pub imported_count: i64,
    pub dropped_count: i64,
    pub detected_scores: Vec<String>,
    /// Why rows were dropped, one line per row (`line 12: invalid JSON`), capped at 100 entries.
    pub drop_reasons: Vec<String>,
    pub dataset_version: Option<i64>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

string_enum! {
    /// Allowed values of `ImportJobConnector`.
    ImportJobConnector {
        Auto => "auto",
        GradTrajectories => "grad_trajectories",
        OpenaiChat => "openai_chat",
        Gradiated => "gradiated",
        Otel => "otel",
        Langfuse => "langfuse",
        Posthog => "posthog",
        Braintrust => "braintrust",
        Langsmith => "langsmith",
    }
}

/// A union of object shapes: set the fields of exactly one variant.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ImportSource {
    pub kind: ImportSourceKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upload_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub format: Option<ImportSourceFormat>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub repo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub split: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub config: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub revision: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub columns: Option<HfColumnMapping>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    /// Name of a workspace secret holding a Hugging Face token, for gated or private datasets. The worker receives the token at claim time.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub benchmark: Option<ImportSourceBenchmark>,
}

string_enum! {
    /// Allowed values of `ImportSourceBenchmark`.
    ImportSourceBenchmark {
        Gsm8k => "gsm8k",
        Mmlu => "mmlu",
        MmluPro => "mmlu_pro",
        ArcChallenge => "arc_challenge",
    }
}

string_enum! {
    /// Allowed values of `ImportSourceFormat`.
    ImportSourceFormat {
        Auto => "auto",
        Jsonl => "jsonl",
        Json => "json",
        Parquet => "parquet",
    }
}

string_enum! {
    /// Allowed values of `ImportSourceKind`.
    ImportSourceKind {
        Upload => "upload",
        Hf => "hf",
        Benchmark => "benchmark",
    }
}

string_enum! {
    /// Allowed values of `ImportStatus`.
    ImportStatus {
        Queued => "queued",
        Running => "running",
        Completed => "completed",
        Failed => "failed",
    }
}

string_enum! {
    /// Allowed values of `ImportableArtifactFormat`.
    ImportableArtifactFormat {
        PeftLora => "peft_lora",
        MergedSafetensors => "merged_safetensors",
        Cartridge => "cartridge",
        EncoderSafetensors => "encoder_safetensors",
        RouterBundle => "router_bundle",
        DecisionBundle => "decision_bundle",
        RewardBundle => "reward_bundle",
    }
}

string_enum! {
    /// Why an attempt ended without a result: lease_lost (the worker was lost: it stopped heartbeating after a crash, kill or network failure), compute_reclaimed (the GPU was reclaimed; the worker saved a checkpoint when it had time and handed the run back), worker_error (the worker hit an unexpected error and handed the run back), oom (CUDA out of memory).
    InterruptionReason {
        LeaseLost => "lease_lost",
        ComputeReclaimed => "compute_reclaimed",
        WorkerError => "worker_error",
        Oom => "oom",
    }
}

/// A union of object shapes: set the fields of exactly one variant.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LoggerSpec {
    pub kind: LoggerSpecKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub entity: Option<String>,
    /// W&B server (default https://api.wandb.ai).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// Workspace secret holding the W&B API key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    /// Tracker run name (default: the grad run name).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tracking_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub experiment: Option<String>,
}

string_enum! {
    /// Allowed values of `LoggerSpecKind`.
    LoggerSpecKind {
        Wandb => "wandb",
        Mlflow => "mlflow",
    }
}

/// A union of object shapes: set the fields of exactly one variant.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct LossSpec {
    pub kind: LossSpecKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reduction: Option<LossSpecReduction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beta: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temp: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub top_k: Option<i64>,
}

string_enum! {
    /// Allowed values of `LossSpecKind`.
    LossSpecKind {
        CrossEntropy => "cross_entropy",
        Dpo => "dpo",
        Infonce => "infonce",
        TopKKlDistill => "top_k_kl_distill",
    }
}

string_enum! {
    /// Allowed values of `LossSpecReduction`.
    LossSpecReduction {
        PerExample => "per_example",
        PerToken => "per_token",
    }
}

/// Generated from the OpenAPI schema `MetricPoint`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MetricPoint {
    pub seq: i64,
    pub attempt: i64,
    pub step: i64,
    pub loss: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_loss: Option<f64>,
    /// Held-out metrics of an eval step by name (including the recipe's selection metric, eval_report.metric_name); absent on steps without an eval.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_metrics: Option<BTreeMap<String, Option<f64>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grad_norm: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lr: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_per_sec: Option<f64>,
    pub tokens: i64,
    pub cost_usd: f64,
    pub timestamp: String,
    /// Members not declared in the schema (round-tripped verbatim).
    #[serde(flatten)]
    pub additional_properties: BTreeMap<String, Value>,
}

/// Generated from the OpenAPI schema `MetricsPage`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MetricsPage {
    pub run_id: String,
    pub status: RunStatus,
    pub data: Vec<MetricPoint>,
    /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
    pub next_cursor: Option<String>,
    /// Cursor after the newest point returned so far; pass it back as `cursor` to poll for points written later (tailing a running run).
    pub tail_cursor: String,
}

/// Generated from the OpenAPI schema `OptimizerSpec`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct OptimizerSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<OptimizerSpecKind>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub betas: Option<Vec<Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub weight_decay: Option<f64>,
    /// Max global gradient norm; 0 disables clipping.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub grad_clip: Option<f64>,
}

string_enum! {
    /// Allowed values of `OptimizerSpecKind`.
    OptimizerSpecKind {
        Adamw => "adamw",
    }
}

/// estimated_cost_usd split by what bills it; the parts sum to it (to rounding).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PlanCostBreakdown {
    /// The base model's tokens on every training step: each record (or both sides of a preference pair) once per epoch, at price_per_million_tokens. Held-out evaluation during training is not billed.
    pub train_usd: f64,
    /// The teacher's tokens (on-policy distill), at its price.
    pub teacher_usd: f64,
    /// Evals the run starts, billed as evals: the labeling eval before training and recipe.evals on every checkpoint.
    pub eval_usd: f64,
}

/// Generated from the OpenAPI schema `PlanEvalRequest`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PlanEvalRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    pub models: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub baseline: Option<String>,
    pub dataset: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dataset_version: Option<i64>,
    /// Default: the dataset's own rubric (a benchmark's answer check), else a non_empty validator.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rubric: Option<Vec<EvalRubricItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub samples: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temperature: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    /// Defaults to 1.0 when every rubric item is binary (regex/validator) and 0.5 otherwise.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pass_threshold: Option<f64>,
}

/// Generated from the OpenAPI schema `PlanEvalResponse`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PlanEvalResponse {
    pub task_source_kind: PlanEvalResponseTaskSourceKind,
    pub dataset_version: i64,
    pub estimated_tasks: i64,
    pub estimated_model_calls: i64,
    pub estimated_judge_calls: i64,
    pub estimated_cost_usd: f64,
    pub judge_models: Vec<String>,
    pub local_scorers: Vec<String>,
    pub pass_threshold: f64,
    pub warnings: Vec<String>,
}

string_enum! {
    /// Allowed values of `PlanEvalResponseTaskSourceKind`.
    PlanEvalResponseTaskSourceKind {
        Dataset => "dataset",
    }
}

/// Generated from the OpenAPI schema `PlanRunRequest`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PlanRunRequest {
    pub dataset: String,
    pub name: String,
    pub recipe: RecipeSpec,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub split: Option<SplitSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_cost_usd: Option<f64>,
}

/// Generated from the OpenAPI schema `PlanRunResponse`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PlanRunResponse {
    pub resolved_config: ResolvedRunConfig,
    pub dataset_version: i64,
    pub usable_records: i64,
    pub total_records: i64,
    pub estimated_steps: i64,
    pub estimated_tokens: i64,
    /// Everything the run is expected to bill: training (and teacher) tokens, plus the evals it starts (labeling, recipe.evals). See cost_breakdown.
    pub estimated_cost_usd: f64,
    /// Wall-clock estimate in seconds on one H100 80 GB: model load and export, training at the measured tokens/s for this base and recipe, evaluations and checkpoints. Excludes queueing and any labeling eval.
    pub estimated_duration_s: i64,
    /// GPU memory (GB) this run needs: the base's min_gpu_memory_gb plus a teacher loaded beside it. Null when the base's requirement is unknown.
    pub min_gpu_memory_gb: Option<f64>,
    pub price_per_million_tokens: f64,
    pub trained_token_fraction: f64,
    /// The labeling eval that runs before training (billed as an eval, included in estimated_cost_usd): router runs with a Judge/validator rubric replay prompts against the candidates; off-policy distill runs have the teacher answer each prompt.
    pub labeling: Option<PlanRunResponseLabeling>,
    /// On-policy distill runs: the teacher's scoring tokens at the teacher's price (included in estimated_tokens as student-price tokens, and in estimated_cost_usd).
    pub teacher: Option<PlanRunResponseTeacher>,
    pub cost_breakdown: PlanCostBreakdown,
    pub warnings: Vec<String>,
}

/// The labeling eval that runs before training (billed as an eval, included in estimated_cost_usd): router runs with a Judge/validator rubric replay prompts against the candidates; off-policy distill runs have the teacher answer each prompt.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PlanRunResponseLabeling {
    pub estimated_model_calls: i64,
    pub estimated_judge_calls: i64,
    pub estimated_cost_usd: f64,
}

/// On-policy distill runs: the teacher's scoring tokens at the teacher's price (included in estimated_tokens as student-price tokens, and in estimated_cost_usd).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PlanRunResponseTeacher {
    pub model: String,
    pub price_per_million_tokens: f64,
    pub estimated_tokens: i64,
    pub estimated_cost_usd: f64,
}

/// Generated from the OpenAPI schema `PoolingSpec`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PoolingSpec {
    pub kind: PoolingSpecKind,
}

string_enum! {
    /// Allowed values of `PoolingSpecKind`.
    PoolingSpecKind {
        Mean => "mean",
        Cls => "cls",
    }
}

/// Generated from the OpenAPI schema `PostEvalScoresRequest`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PostEvalScoresRequest {
    pub scores: Vec<PostEvalScoresRequestScoresItem>,
}

/// Generated from the OpenAPI schema `PostEvalScoresRequestScoresItem`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PostEvalScoresRequestScoresItem {
    pub output_id: String,
    pub scorer: String,
    pub score: f64,
}

/// Generated from the OpenAPI schema `PostEvalScoresResponse`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PostEvalScoresResponse {
    pub accepted: i64,
    pub status: EvalStatus,
    pub pending_local_scores: i64,
}

/// Generated from the OpenAPI schema `RecipeEval`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RecipeEval {
    pub dataset: String,
    /// Dataset version (default: the current one, pinned at plan time).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    /// Judges, regexes and validators (default: the dataset's own rubric, such as a benchmark's answer check). Code scorers can't run during training.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rubric: Option<Vec<EvalRubricItem>>,
    /// Evaluate the first N tasks at each checkpoint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
    /// Name of this eval in the report (default: the dataset name).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
}

string_enum! {
    /// Allowed values of `RecipeKind`.
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
}

/// Generated from the OpenAPI schema `RecipeSpec`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RecipeSpec {
    pub kind: RecipeKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub adapter: Option<AdapterSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lr: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lr_scale: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub batch_size: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub epochs: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<RecipeSpecSchedule>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warmup: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub train_on: Option<RecipeSpecTrainOn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<RecipeSpecThinking>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preserve_thinking: Option<bool>,
    /// Default per_example.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reduction: Option<RecipeSpecReduction>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub select: Option<RecipeSpecSelect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint_ttl_days: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beta: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub models: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_quality_drop: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub context_text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temp: Option<f64>,
    /// CartridgeRecipe and DistillRecipe: the model to learn from. DistillRecipe also takes an artifact (name@version) with rollout off_policy.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teacher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rollout: Option<RolloutSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optimizer: Option<OptimizerSpec>,
    /// Optimizer steps between held-out evaluations; auto = every 25% of the run, at most every 20 steps; each eval step is also a checkpoint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_every: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loss: Option<LossSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool: Option<PoolingSpec>,
    /// RouterRecipe: a score name on your records (scores[rubric]), or Judge/validator items: the server then replays each prompt against recipe.models and scores the answers in a labeling eval before training. RewardModelRecipe: a score name in [0, 1] on records ending in an assistant turn, trained pointwise next to the chosen/rejected pairs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rubric: Option<Value>,
    /// RouterRecipe: USD per request for each candidate; overrides metrics.cost_usd on your records.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pricing: Option<BTreeMap<String, f64>>,
    /// RouterRecipe: the candidate that gets every request the router does not offload (default: the best-scoring candidate).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    /// CartridgeRecipe: teacher answer length per prompt during distillation (default 256).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_new_tokens: Option<i64>,
    /// CartridgeRecipe: a reserved token that marks where the cartridge goes (default: the first reserved token that tokenizes atomically).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot_token: Option<String>,
    /// Extra evals on each checkpoint during training (the eval executor, billed like any eval). Results are in run.checkpoint_evals, the run's checkpoint_eval events and eval_report.checkpoint_evals.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub evals: Option<Vec<RecipeEval>>,
    /// Experiment trackers that receive the run's metrics. A tracker that fails is reported and dropped; it never fails the run.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loggers: Option<Vec<LoggerSpec>>,
}

impl RecipeSpec {
    /// Every property name in the schema.
    pub const FIELDS: &'static [&'static str] = &["kind", "model", "adapter", "lr", "lr_scale", "batch_size", "epochs", "schedule", "warmup", "train_on", "thinking", "preserve_thinking", "reduction", "select", "checkpoint_ttl_days", "beta", "models", "max_quality_drop", "context_text", "num_tokens", "temp", "teacher", "rollout", "optimizer", "eval_every", "loss", "pool", "rubric", "pricing", "fallback", "max_new_tokens", "slot_token", "evals", "loggers"];
}

string_enum! {
    /// Default per_example.
    RecipeSpecReduction {
        PerExample => "per_example",
        PerToken => "per_token",
    }
}

string_enum! {
    /// Allowed values of `RecipeSpecSchedule`.
    RecipeSpecSchedule {
        Linear => "linear",
        Cosine => "cosine",
        Constant => "constant",
    }
}

string_enum! {
    /// Allowed values of `RecipeSpecSelect`.
    RecipeSpecSelect {
        Best => "best",
        Last => "last",
    }
}

string_enum! {
    /// Allowed values of `RecipeSpecThinking`.
    RecipeSpecThinking {
        Auto => "auto",
        On => "on",
        Off => "off",
    }
}

string_enum! {
    /// Allowed values of `RecipeSpecTrainOn`.
    RecipeSpecTrainOn {
        Last => "last",
        AllAssistant => "all_assistant",
    }
}

/// Generated from the OpenAPI schema `RenderDatasetRequest`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RenderDatasetRequest {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub train_on: Option<RenderDatasetRequestTrainOn>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thinking: Option<RenderDatasetRequestThinking>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preserve_thinking: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
}

string_enum! {
    /// Allowed values of `RenderDatasetRequestThinking`.
    RenderDatasetRequestThinking {
        Auto => "auto",
        On => "on",
        Off => "off",
    }
}

string_enum! {
    /// Allowed values of `RenderDatasetRequestTrainOn`.
    RenderDatasetRequestTrainOn {
        Last => "last",
        AllAssistant => "all_assistant",
    }
}

/// Generated from the OpenAPI schema `RenderDatasetResponse`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RenderDatasetResponse {
    pub dataset: String,
    pub model: String,
    pub template_revision: String,
    /// Token counts (total, trained and per span) are estimates (about 4 characters per token); the trainer tokenizes with the model's pinned tokenizer, and the run's metrics report the exact tokens.
    pub token_counts: RenderDatasetResponseTokenCounts,
    pub examples: Vec<RenderDatasetResponseExamplesItem>,
}

/// Generated from the OpenAPI schema `RenderDatasetResponseExamplesItem`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RenderDatasetResponseExamplesItem {
    pub record_id: String,
    pub template_revision: String,
    pub total_tokens: i64,
    pub trained_tokens: i64,
    pub trained_fraction: f64,
    pub spans: Vec<RenderDatasetResponseExamplesItemSpansItem>,
}

/// Generated from the OpenAPI schema `RenderDatasetResponseExamplesItemSpansItem`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RenderDatasetResponseExamplesItemSpansItem {
    pub text: String,
    pub trained: bool,
    pub tokens: i64,
}

string_enum! {
    /// Token counts (total, trained and per span) are estimates (about 4 characters per token); the trainer tokenizes with the model's pinned tokenizer, and the run's metrics report the exact tokens.
    RenderDatasetResponseTokenCounts {
        Estimated => "estimated",
    }
}

/// Generated from the OpenAPI schema `ResolvedRunConfig`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ResolvedRunConfig {
    pub rule_version: String,
    pub dataset: String,
    pub dataset_version: i64,
    pub name: String,
    pub recipe_kind: RecipeKind,
    pub model: String,
    pub template_revision: String,
    pub adapter: ResolvedRunConfigAdapter,
    pub lr: f64,
    pub lr_source: String,
    pub batch_size: i64,
    pub epochs: i64,
    pub schedule: ResolvedRunConfigSchedule,
    pub warmup: f64,
    pub train_on: ResolvedRunConfigTrainOn,
    pub thinking: ResolvedRunConfigThinking,
    pub preserve_thinking: bool,
    pub reduction: ResolvedRunConfigReduction,
    pub select: ResolvedRunConfigSelect,
    pub checkpoint_every_steps: i64,
    pub eval_every_steps: i64,
    pub optimizer: OptimizerSpec,
    pub checkpoint_ttl_days: i64,
    pub split: ResolvedRunConfigSplit,
    /// The labeling eval whose answers the run trains on: router runs with a Judge/validator rubric, and off-policy distill runs (the teacher's answers).
    pub label_eval_id: Option<String>,
    pub base_artifact: Option<BaseArtifact>,
    pub recipe_params: BTreeMap<String, Value>,
    /// recipe.evals, with the dataset version and rubric pinned.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub checkpoint_evals: Option<Vec<ResolvedRunConfigCheckpointEvalsItem>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loggers: Option<Vec<LoggerSpec>>,
}

/// A union of object shapes: set the fields of exactly one variant.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ResolvedRunConfigAdapter {
    pub kind: ResolvedRunConfigAdapterKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rank: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub alpha: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub merge_on_export: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_tokens: Option<i64>,
}

string_enum! {
    /// Allowed values of `ResolvedRunConfigAdapterKind`.
    ResolvedRunConfigAdapterKind {
        Lora => "lora",
        PrefixKv => "prefix_kv",
        FrozenHead => "frozen_head",
        EncoderFull => "encoder_full",
    }
}

/// Generated from the OpenAPI schema `ResolvedRunConfigCheckpointEvalsItem`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ResolvedRunConfigCheckpointEvalsItem {
    pub name: String,
    pub dataset: String,
    pub dataset_version: i64,
    pub rubric: Vec<EvalRubricItem>,
    pub limit: Option<i64>,
}

string_enum! {
    /// Allowed values of `ResolvedRunConfigReduction`.
    ResolvedRunConfigReduction {
        PerExample => "per_example",
        PerToken => "per_token",
    }
}

string_enum! {
    /// Allowed values of `ResolvedRunConfigSchedule`.
    ResolvedRunConfigSchedule {
        Linear => "linear",
        Cosine => "cosine",
        Constant => "constant",
    }
}

string_enum! {
    /// Allowed values of `ResolvedRunConfigSelect`.
    ResolvedRunConfigSelect {
        Best => "best",
        Last => "last",
    }
}

/// Generated from the OpenAPI schema `ResolvedRunConfigSplit`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ResolvedRunConfigSplit {
    pub strategy: ResolvedRunConfigSplitStrategy,
    pub eval_fraction: f64,
    pub seed: i64,
    pub train_records: i64,
    pub eval_records: i64,
}

string_enum! {
    /// Allowed values of `ResolvedRunConfigSplitStrategy`.
    ResolvedRunConfigSplitStrategy {
        BySession => "by_session",
        ByGroup => "by_group",
        Random => "random",
    }
}

string_enum! {
    /// Allowed values of `ResolvedRunConfigThinking`.
    ResolvedRunConfigThinking {
        Auto => "auto",
        On => "on",
        Off => "off",
    }
}

string_enum! {
    /// Allowed values of `ResolvedRunConfigTrainOn`.
    ResolvedRunConfigTrainOn {
        Last => "last",
        AllAssistant => "all_assistant",
    }
}

/// A union of object shapes: set the fields of exactly one variant.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RolloutSpec {
    pub kind: RolloutSpecKind,
    /// Length of each student answer; auto (default) sizes it from the assistant turns in your records (256 without any).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_new_tokens: Option<Value>,
}

string_enum! {
    /// Allowed values of `RolloutSpecKind`.
    RolloutSpecKind {
        OnPolicy => "on_policy",
        OffPolicy => "off_policy",
    }
}

/// Router quality vs. cost on the held-out report fold, against the fallback model. Values are null when no report prompt was scored for every candidate.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RouterParetoSummary {
    pub target_max_drop: f64,
    pub routed_quality: Option<f64>,
    pub quality_drop: Option<f64>,
    /// 95% bootstrap interval [low, high].
    pub quality_drop_ci95: Option<Vec<f64>>,
    pub offload_rate: Option<f64>,
    pub cost_savings_pct: Option<f64>,
    pub ece: Option<f64>,
    pub threshold: Option<f64>,
    pub temperature: f64,
    /// Members not declared in the schema (round-tripped verbatim).
    #[serde(flatten)]
    pub additional_properties: BTreeMap<String, Value>,
}

/// Generated from the OpenAPI schema `Run`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Run {
    pub id: String,
    pub workspace_id: String,
    pub name: String,
    pub dataset_id: String,
    pub dataset_name: String,
    pub dataset_version: i64,
    pub recipe_kind: RecipeKind,
    pub status: RunStatus,
    pub resolved_config: ResolvedRunConfig,
    pub max_cost_usd: Option<f64>,
    pub price_per_million_tokens: f64,
    pub tokens_processed: i64,
    pub cost_usd: f64,
    pub current_step: i64,
    pub total_steps: i64,
    /// Attempts started so far (every start on a worker counts, including ones whose GPU was reclaimed).
    pub attempt: i64,
    /// The run fails once this many attempts end without a result (lost worker, worker error, OOM). Attempts whose GPU was reclaimed don't count toward it.
    pub max_attempts: i64,
    pub phase: Option<RunPhase>,
    pub phase_since: Option<String>,
    pub last_interruption: Option<RunInterruption>,
    /// While queued: workers of this kind holding a lease (all busy). Null otherwise.
    pub workers_online: Option<i64>,
    /// While queued: true when workers scale from zero (KEDA), so a worker is starting. Null otherwise.
    pub autoscaling: Option<bool>,
    /// While queued for a worker: about how many runs start before this one. Claims are fair across workspaces (the workspace with the fewest running runs goes next), so this counts other workspaces' runs too. Approximate; null otherwise.
    pub queue_position: Option<i64>,
    /// While queued for a worker: why it waits, ready to show: "Queued behind 3 runs", "Queued: workspace concurrency limit (8 running)" (the workspace runs as many as it may at once), or "Waiting for a GPU with ≥46 GB; online workers have 24 GB". Null when it is next in line, and once it is claimed.
    pub queue_message: Option<String>,
    /// GPU memory (GB) the run needs (its plan's min_gpu_memory_gb): only workers with at least this much claim it. Null when unknown.
    pub min_gpu_memory_gb: Option<f64>,
    pub latest_metric: Option<MetricPoint>,
    pub eval_report: Option<EvalReport>,
    /// recipe.evals results, one per finished eval: a checkpoint (step) on a dataset.
    pub checkpoint_evals: Vec<CheckpointEvalResult>,
    pub artifact_id: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
    /// Only on the response that created the run (POST /v1/runs): the plan's warnings, such as another queued or running run with the same name. They're also the run's first warning events.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warnings: Option<Vec<String>>,
}

/// Generated from the OpenAPI schema `RunInterruption`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RunInterruption {
    pub attempt: i64,
    pub reason: InterruptionReason,
    pub step: i64,
    pub resume_step: Option<i64>,
    pub at: String,
    pub message: String,
}

string_enum! {
    /// Allowed values of `RunPhase`.
    RunPhase {
        Queued => "queued",
        WaitingForCompute => "waiting_for_compute",
        Starting => "starting",
        LoadingModel => "loading_model",
        Training => "training",
        Evaluating => "evaluating",
        Checkpointing => "checkpointing",
        Uploading => "uploading",
        Completing => "completing",
    }
}

string_enum! {
    /// stopped_budget: the run reached its max_cost_usd (resume with a higher cap). stopped_balance: the workspace ran out of balance on Cloud (top up, then resume; the cap is unchanged). Both keep their checkpoints.
    RunStatus {
        Queued => "queued",
        Running => "running",
        Completed => "completed",
        Failed => "failed",
        Cancelled => "cancelled",
        StoppedBudget => "stopped_budget",
        StoppedBalance => "stopped_balance",
    }
}

/// Generated from the OpenAPI schema `ScoreDatasetRequest`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct ScoreDatasetRequest {
    pub rubric: Vec<EvalRubricItem>,
    /// Dataset version to score (default: the current version).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version: Option<i64>,
    /// Name of the scoring job (default `<dataset>-score`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<i64>,
}

/// Generated from the OpenAPI schema `SplitSpec`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct SplitSpec {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub strategy: Option<SplitSpecStrategy>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_fraction: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub seed: Option<i64>,
}

string_enum! {
    /// Allowed values of `SplitSpecStrategy`.
    SplitSpecStrategy {
        BySession => "by_session",
        ByGroup => "by_group",
        Random => "random",
    }
}

/// Generated from the OpenAPI schema `TrainableModel`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TrainableModel {
    pub id: String,
    pub hf_repo: Option<String>,
    pub family: TrainableModelFamily,
    pub adapters: Vec<TrainableModelAdaptersItem>,
    pub recipes: Vec<RecipeKind>,
    pub default_for: Vec<RecipeKind>,
    pub price_per_million_tokens_usd: f64,
    pub max_context_tokens: i64,
    pub template_revision: String,
    pub calibrated_lrs: BTreeMap<String, f64>,
    /// GPU memory (GB) training this base needs at the recipe defaults, measured on an H100 80 GB. v0 trains on one GPU, and runs.plan refuses (422 model_exceeds_gpu_memory) a run that needs more than 80 GB. Null when unknown.
    pub min_gpu_memory_gb: Option<f64>,
}

string_enum! {
    /// Allowed values of `TrainableModelAdaptersItem`.
    TrainableModelAdaptersItem {
        Lora => "lora",
        PrefixKv => "prefix_kv",
        FrozenHead => "frozen_head",
        EncoderFull => "encoder_full",
    }
}

string_enum! {
    /// Allowed values of `TrainableModelFamily`.
    TrainableModelFamily {
        Llm => "llm",
        Encoder => "encoder",
    }
}

/// Generated from the OpenAPI schema `TrajectoryInput`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TrajectoryInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub messages: Option<Vec<ChatMessage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<BTreeMap<String, Value>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub media: Option<Vec<BTreeMap<String, Value>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub features: Option<BTreeMap<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    /// Members not declared in the schema (round-tripped verbatim).
    #[serde(flatten)]
    pub additional_properties: BTreeMap<String, Value>,
}

/// Generated from the OpenAPI schema `TrajectoryOutput`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct TrajectoryOutput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turns: Option<Vec<ChatMessage>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub payload: Option<Value>,
    /// Members not declared in the schema (round-tripped verbatim).
    #[serde(flatten)]
    pub additional_properties: BTreeMap<String, Value>,
}

/// Generated from the OpenAPI schema `UploadTicket`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UploadTicket {
    /// The file's sha256: uploads are content-addressed, so re-uploading the same bytes is harmless.
    pub upload_id: String,
    pub method: UploadTicketMethod,
    /// Presigned S3 PUT URL; send exactly `headers` (they bind the length and sha256).
    pub url: String,
    pub headers: BTreeMap<String, String>,
    pub expires_at: String,
}

string_enum! {
    /// Allowed values of `UploadTicketMethod`.
    UploadTicketMethod {
        Put => "PUT",
    }
}

/// Generated from the OpenAPI schema `UsageGroup`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UsageGroup {
    /// The group: a UTC day or week start (YYYY-MM-DD), a month (YYYY-MM), a model, a recipe or a kind. Null for usage with no recipe (plain evals, scoring).
    pub key: Option<String>,
    pub cost_usd: f64,
    pub tokens: i64,
    pub records: i64,
}

string_enum! {
    /// Allowed values of `UsageGroupBy`.
    UsageGroupBy {
        Day => "day",
        Week => "week",
        Month => "month",
        Model => "model",
        Recipe => "recipe",
        Kind => "kind",
    }
}

string_enum! {
    /// What the tokens paid for: `training` (a run's attempts), `eval` (evals, including a run's checkpoint evals), `scoring` (dataset.score), `labeling` (a router run's labeling eval) or `teacher` (an off-policy distill run's teacher answers).
    UsageKind {
        Training => "training",
        Eval => "eval",
        Scoring => "scoring",
        Labeling => "labeling",
        Teacher => "teacher",
    }
}

/// Generated from the OpenAPI schema `UsageKindTotal`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UsageKindTotal {
    pub kind: UsageKind,
    pub cost_usd: f64,
    pub tokens: i64,
    pub records: i64,
}

/// Generated from the OpenAPI schema `UsageRecord`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UsageRecord {
    pub id: String,
    pub kind: UsageKind,
    /// The run (kind `training`) or eval this usage belongs to.
    pub ref_id: String,
    pub ref_name: Option<String>,
    /// The run the usage was billed for: the run itself, or the run whose labeling, teacher or checkpoint eval it is.
    pub run_id: Option<String>,
    pub attempt: i64,
    /// The attempt's tokens this row starts after (usage is billed in increments while an attempt runs).
    pub tokens_from: i64,
    pub tokens_through: i64,
    pub tokens: i64,
    pub cost_usd: f64,
    pub price_version: String,
    /// Who bills this usage: `grad` (training, and evals on a self-hosted server) or `gateway` (on Gradiated Cloud, eval model and judge tokens are billed once by the inference gateway; shown here, not charged twice).
    pub billed_by: UsageRecordBilledBy,
    pub idempotency_key: String,
    pub created_at: String,
}

string_enum! {
    /// Who bills this usage: `grad` (training, and evals on a self-hosted server) or `gateway` (on Gradiated Cloud, eval model and judge tokens are billed once by the inference gateway; shown here, not charged twice).
    UsageRecordBilledBy {
        Grad => "grad",
        Gateway => "gateway",
    }
}

/// Generated from the OpenAPI schema `UsageRefTotal`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UsageRefTotal {
    pub id: String,
    pub name: Option<String>,
    pub kind: UsageKind,
    pub cost_usd: f64,
    pub tokens: i64,
}

/// Generated from the OpenAPI schema `UsageSummary`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct UsageSummary {
    /// Start of the period (inclusive).
    pub from: String,
    /// End of the period (exclusive).
    pub to: String,
    pub cost_usd: f64,
    pub tokens: i64,
    pub records: i64,
    /// One entry per kind with usage, costliest first.
    pub by_kind: Vec<UsageKindTotal>,
    /// The costliest runs' training in the period (up to 5).
    pub top_runs: Vec<UsageRefTotal>,
    /// The costliest evals, scoring, labeling and teacher jobs in the period (up to 5).
    pub top_evals: Vec<UsageRefTotal>,
    pub group_by: Option<UsageGroupBy>,
    /// With group_by: one entry per group with usage, oldest first for time groups and costliest first otherwise.
    pub groups: Vec<UsageGroup>,
}

/// Largest `limit` accepted by `list_api_keys` (the server clamps larger values).
pub const LIST_API_KEYS_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_artifacts` (the server clamps larger values).
pub const LIST_ARTIFACTS_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_dataset_records` (the server clamps larger values).
pub const LIST_DATASET_RECORDS_LIMIT_MAX: u32 = 1000;
/// Largest `limit` accepted by `list_datasets` (the server clamps larger values).
pub const LIST_DATASETS_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_eval_failures` (the server clamps larger values).
pub const LIST_EVAL_FAILURES_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_eval_outputs` (the server clamps larger values).
pub const LIST_EVAL_OUTPUTS_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_eval_results` (the server clamps larger values).
pub const LIST_EVAL_RESULTS_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_evals` (the server clamps larger values).
pub const LIST_EVALS_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_imports` (the server clamps larger values).
pub const LIST_IMPORTS_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_run_checkpoints` (the server clamps larger values).
pub const LIST_RUN_CHECKPOINTS_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_run_events` (the server clamps larger values).
pub const LIST_RUN_EVENTS_LIMIT_MAX: u32 = 5000;
/// Largest `limit` accepted by `list_run_metrics` (the server clamps larger values).
pub const LIST_RUN_METRICS_LIMIT_MAX: u32 = 5000;
/// Largest `limit` accepted by `list_runs` (the server clamps larger values).
pub const LIST_RUNS_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_secrets` (the server clamps larger values).
pub const LIST_SECRETS_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_sources` (the server clamps larger values).
pub const LIST_SOURCES_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_usage` (the server clamps larger values).
pub const LIST_USAGE_LIMIT_MAX: u32 = 200;
