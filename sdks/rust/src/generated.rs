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
    /// Allowed values of `ApiKeyScope`.
    ApiKeyScope {
        Admin => "admin",
        DatasetsRead => "datasets:read",
        DatasetsWrite => "datasets:write",
        RunsRead => "runs:read",
        RunsWrite => "runs:write",
        ArtifactsRead => "artifacts:read",
        ArtifactsWrite => "artifacts:write",
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
    pub eval_report: Option<EvalReport>,
    pub created_at: String,
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
        Reference => "reference",
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

/// Generated from the OpenAPI schema `DeployArtifactRequest`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DeployArtifactRequest {
    pub artifact: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fallback: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub explore_rate: Option<f64>,
}

/// Generated from the OpenAPI schema `Deployment`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
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
    pub status: DeploymentStatusType,
    pub created_at: String,
    pub updated_at: String,
}

/// Generated from the OpenAPI schema `DeploymentStatus`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct DeploymentStatus {
    pub deployment: Deployment,
    pub feedback_count: i64,
    pub average_score: Option<f64>,
}

string_enum! {
    /// Allowed values of `DeploymentStatusType`.
    DeploymentStatusType {
        Active => "active",
        Disabled => "disabled",
    }
}

/// Generated from the OpenAPI schema `EmbedResponse`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EmbedResponse {
    pub model: String,
    pub data: Vec<EmbedResponseDataItem>,
    pub usage: EmbedResponseUsage,
}

/// Generated from the OpenAPI schema `EmbedResponseDataItem`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EmbedResponseDataItem {
    pub index: i64,
    pub embedding: Vec<f64>,
}

/// Generated from the OpenAPI schema `EmbedResponseUsage`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EmbedResponseUsage {
    pub prompt_tokens: i64,
    pub total_tokens: i64,
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
    /// Selection metric: eval_loss (sft, router, decision), preference_accuracy (dpo), eval_kl (cartridge), recall_at_10 (embedding).
    pub metric_name: String,
    pub selected_step: i64,
    pub best_step: Option<i64>,
    pub final_step: i64,
    pub train_records: i64,
    pub eval_records: i64,
    pub warnings: Vec<String>,
    /// Written by: sft, dpo, router, decision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_loss: Option<f64>,
    /// Written by: sft.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_token_accuracy: Option<f64>,
    /// Written by: sft.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trained_token_fraction: Option<f64>,
    /// Written by: sft.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub train_examples: Option<i64>,
    /// Written by: sft, router, decision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_examples: Option<i64>,
    /// Written by: router, decision.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selection_examples: Option<i64>,
    /// Written by: sft, dpo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncated: Option<i64>,
    /// Written by: dpo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub preference_accuracy: Option<f64>,
    /// Written by: dpo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reward_margin: Option<f64>,
    /// Written by: dpo.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub beta: Option<f64>,
    /// Written by: dpo, embedding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub train_pairs: Option<i64>,
    /// Written by: dpo, embedding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_pairs: Option<i64>,
    /// Written by: dpo, embedding.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dropped_records: Option<i64>,
    /// Written by: cartridge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_kl: Option<f64>,
    /// Written by: cartridge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub no_context_kl: Option<f64>,
    /// Written by: cartridge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kl_reduction: Option<f64>,
    /// Written by: cartridge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_tokens: Option<i64>,
    /// Written by: cartridge.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teacher: Option<String>,
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
    pub error: Option<String>,
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

/// Generated from the OpenAPI schema `FeedbackEventInput`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FeedbackEventInput {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inference_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub deployment_name: Option<String>,
    pub idempotency_key: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_output: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metrics: Option<BTreeMap<String, f64>>,
}

/// Generated from the OpenAPI schema `FeedbackRecord`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct FeedbackRecord {
    pub id: String,
    pub workspace_id: String,
    pub inference_id: Option<String>,
    pub session_id: Option<String>,
    pub deployment_name: Option<String>,
    pub idempotency_key: String,
    pub score: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expected_output: Option<Value>,
    pub metrics: BTreeMap<String, f64>,
    pub created_at: String,
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
    pub estimated_cost_usd: f64,
    pub price_per_million_tokens: f64,
    pub trained_token_fraction: f64,
    /// Router runs with a Judge/validator rubric: the labeling eval that replays prompts against the candidates (billed as an eval, included in estimated_cost_usd).
    pub labeling: Option<PlanRunResponseLabeling>,
    pub warnings: Vec<String>,
}

/// Router runs with a Judge/validator rubric: the labeling eval that replays prompts against the candidates (billed as an eval, included in estimated_cost_usd).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PlanRunResponseLabeling {
    pub estimated_model_calls: i64,
    pub estimated_judge_calls: i64,
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
    pub context_uri: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub num_tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub temp: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub teacher: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub optimizer: Option<OptimizerSpec>,
    /// Optimizer steps between held-out evaluations; auto = every 10% of steps (the checkpoint interval).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub eval_every: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub loss: Option<LossSpec>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pool: Option<PoolingSpec>,
    /// RouterRecipe: a score name on your records (scores[rubric]), or Judge/validator items: the server then replays each prompt against recipe.models and scores the answers in a labeling eval before training.
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
}

impl RecipeSpec {
    /// Every property name in the schema.
    pub const FIELDS: &'static [&'static str] = &["kind", "model", "adapter", "lr", "lr_scale", "batch_size", "epochs", "schedule", "warmup", "train_on", "thinking", "preserve_thinking", "reduction", "select", "checkpoint_ttl_days", "beta", "models", "max_quality_drop", "context_text", "context_uri", "num_tokens", "temp", "teacher", "optimizer", "eval_every", "loss", "pool", "rubric", "pricing", "fallback", "max_new_tokens", "slot_token"];
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

/// Generated from the OpenAPI schema `RecordFeedbackResponse`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RecordFeedbackResponse {
    pub accepted: i64,
    pub deduplicated: i64,
    pub records: Vec<FeedbackRecord>,
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
    /// Router runs with a Judge/validator rubric: the labeling eval whose scored answers the router trains on.
    pub label_eval_id: Option<String>,
    pub base_artifact: Option<BaseArtifact>,
    pub recipe_params: BTreeMap<String, Value>,
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

/// Generated from the OpenAPI schema `RouteRequest`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RouteRequest {
    pub deployment: String,
    pub messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tools: Option<Vec<BTreeMap<String, Value>>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
}

/// Generated from the OpenAPI schema `RouteResponse`.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RouteResponse {
    pub inference_id: String,
    pub deployment: String,
    pub artifact_id: String,
    pub model: String,
    pub is_exploration: bool,
    pub confidence: f64,
    pub scores: BTreeMap<String, f64>,
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
    pub attempt: i64,
    pub max_attempts: i64,
    pub latest_metric: Option<MetricPoint>,
    pub eval_report: Option<EvalReport>,
    pub artifact_id: Option<String>,
    pub error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub finished_at: Option<String>,
}

string_enum! {
    /// Allowed values of `RunStatus`.
    RunStatus {
        Queued => "queued",
        Running => "running",
        Completed => "completed",
        Failed => "failed",
        Cancelled => "cancelled",
        StoppedBudget => "stopped_budget",
    }
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
    pub upload_id: String,
    pub method: UploadTicketMethod,
    /// Absolute presigned URL, or a path relative to the API base URL (local storage).
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

/// Largest `limit` accepted by `list_api_keys` (the server clamps larger values).
pub const LIST_API_KEYS_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_artifacts` (the server clamps larger values).
pub const LIST_ARTIFACTS_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_dataset_records` (the server clamps larger values).
pub const LIST_DATASET_RECORDS_LIMIT_MAX: u32 = 1000;
/// Largest `limit` accepted by `list_datasets` (the server clamps larger values).
pub const LIST_DATASETS_LIMIT_MAX: u32 = 200;
/// Largest `limit` accepted by `list_deployments` (the server clamps larger values).
pub const LIST_DEPLOYMENTS_LIMIT_MAX: u32 = 200;
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
/// Largest `limit` accepted by `list_run_metrics` (the server clamps larger values).
pub const LIST_RUN_METRICS_LIMIT_MAX: u32 = 5000;
/// Largest `limit` accepted by `list_runs` (the server clamps larger values).
pub const LIST_RUNS_LIMIT_MAX: u32 = 200;
