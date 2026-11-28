//! Request and response models: the generated OpenAPI models (`crate::generated`)
//! plus the few helpers and façade-only types the SDK adds on top.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::generated::*;

/// One locally computed score for `POST /v1/evals/{id}/scores`.
pub type LocalScore = PostEvalScoresRequestScoresItem;

impl RunStatus {
    /// `completed`, `failed`, `cancelled`, `stopped_budget` or `stopped_balance`.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            RunStatus::Completed
                | RunStatus::Failed
                | RunStatus::Cancelled
                | RunStatus::StoppedBudget
                | RunStatus::StoppedBalance
        )
    }
}

impl EvalStatus {
    /// `completed`, `failed` or `cancelled`.
    pub fn is_terminal(&self) -> bool {
        matches!(
            self,
            EvalStatus::Completed | EvalStatus::Failed | EvalStatus::Cancelled
        )
    }
}

impl ImportStatus {
    /// `completed` or `failed`.
    pub fn is_terminal(&self) -> bool {
        matches!(self, ImportStatus::Completed | ImportStatus::Failed)
    }
}

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

/// List filters on the wire: `status` comma-separated, absent when empty, then the set options.
fn filter_query(status: Vec<&str>, opts: &[(&str, &Option<String>)]) -> Vec<(String, String)> {
    let mut q = Vec::new();
    if !status.is_empty() {
        q.push(("status".into(), status.join(",")));
    }
    for (k, v) in opts {
        if let Some(v) = v {
            q.push(((*k).into(), v.clone()));
        }
    }
    q
}

/// Filters of [`Runs::list`](crate::Runs::list); the default lists every run.
#[derive(Debug, Clone, Default)]
pub struct RunFilter {
    /// Only runs in these statuses.
    pub status: Vec<RunStatus>,
    /// Only runs whose name contains this (any case), or whose id is exactly this.
    pub search: Option<String>,
}

impl RunFilter {
    pub(crate) fn query(&self) -> Vec<(String, String)> {
        let status = self.status.iter().map(RunStatus::as_str).collect();
        filter_query(status, &[("q", &self.search)])
    }
}

/// Filters of [`Evals::list`](crate::Evals::list); the default lists every eval.
#[derive(Debug, Clone, Default)]
pub struct EvalFilter {
    /// Only evals in these statuses.
    pub status: Vec<EvalStatus>,
    /// Only evals whose name contains this (any case), or whose id is exactly this.
    pub search: Option<String>,
}

impl EvalFilter {
    pub(crate) fn query(&self) -> Vec<(String, String)> {
        let status = self.status.iter().map(EvalStatus::as_str).collect();
        filter_query(status, &[("q", &self.search)])
    }
}

/// Filters of [`Imports::list`](crate::Imports::list); the default lists every import job.
#[derive(Debug, Clone, Default)]
pub struct ImportFilter {
    /// Only jobs in these statuses.
    pub status: Vec<ImportStatus>,
    /// Only jobs importing into this dataset.
    pub dataset: Option<String>,
}

impl ImportFilter {
    pub(crate) fn query(&self) -> Vec<(String, String)> {
        let status = self.status.iter().map(ImportStatus::as_str).collect();
        filter_query(status, &[("dataset", &self.dataset)])
    }
}

/// Filters of [`Artifacts::list`](crate::Artifacts::list); the default lists every artifact.
#[derive(Debug, Clone, Default)]
pub struct ArtifactFilter {
    /// Only this name's versions.
    pub name: Option<String>,
    /// Only artifacts whose name contains this (any case), or whose id is exactly this.
    pub search: Option<String>,
}

impl ArtifactFilter {
    pub(crate) fn query(&self) -> Vec<(String, String)> {
        filter_query(vec![], &[("name", &self.name), ("q", &self.search)])
    }
}

/// Query for `GET /v1/runs/{id}/metrics`.
#[derive(Debug, Clone, Default)]
pub struct MetricsQuery {
    pub cursor: Option<String>,
    pub after_step: Option<i64>,
    pub limit: Option<u32>,
}

/// A newly created key; `secret` is shown once and never printed by `Debug`.
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

impl HfColumnMapping {
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
        self == &HfColumnMapping::default()
    }
}

impl RecipeSpec {
    /// A recipe of `kind` with every parameter at its server default.
    pub fn new(kind: RecipeKind) -> Self {
        RecipeSpec {
            kind,
            ..Default::default()
        }
    }

    /// Set the base model: a catalog id, or an artifact (`name@version`) to keep training.
    pub fn model(mut self, model: impl Into<String>) -> Self {
        self.model = Some(model.into());
        self
    }
}

impl PlanRunRequest {
    /// Train `recipe` on `dataset` as run `name`.
    pub fn new(dataset: impl Into<String>, name: impl Into<String>, recipe: RecipeSpec) -> Self {
        PlanRunRequest {
            dataset: dataset.into(),
            name: name.into(),
            recipe,
            ..Default::default()
        }
    }

    /// Cap the run's spend (it stops with `stopped_budget` and keeps a checkpoint).
    pub fn max_cost_usd(mut self, cap: f64) -> Self {
        self.max_cost_usd = Some(cap);
        self
    }
}

impl EvalReport {
    /// The value of the selection metric (`metric_name`).
    pub fn metric(&self) -> Option<f64> {
        match self.metric_name.as_str() {
            "eval_loss" => self.eval_loss,
            "preference_accuracy" => self.preference_accuracy,
            "eval_kl" => self.eval_kl,
            "recall_at_10" => self.recall_at_10,
            _ => None,
        }
    }
}

impl Artifact {
    /// `name@version`.
    pub fn reference(&self) -> String {
        format!("{}@{}", self.name, self.version)
    }
}

impl ChatMessage {
    pub fn user(content: impl Into<String>) -> Self {
        ChatMessage {
            role: ChatMessageRole::User,
            content: Some(Value::String(content.into())),
            ..Default::default()
        }
    }
}

/// A workspace secret: its name and metadata, never its value. Pass it (or a
/// plain name) as a provider's or `from_hf`'s secret.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SecretRef {
    pub name: String,
    pub workspace_id: String,
    /// The only hosts the server sends this secret to.
    pub allowed_hosts: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl SecretRef {
    /// A reference by name, without asking the server.
    pub fn named(name: impl Into<String>) -> Self {
        SecretRef {
            name: name.into(),
            ..Default::default()
        }
    }
}

/// Anything that names a secret: a [`SecretRef`] or the name itself.
pub trait SecretName {
    fn secret_name(&self) -> String;
}

impl SecretName for SecretRef {
    fn secret_name(&self) -> String {
        self.name.clone()
    }
}

impl SecretName for &SecretRef {
    fn secret_name(&self) -> String {
        self.name.clone()
    }
}

impl SecretName for &str {
    fn secret_name(&self) -> String {
        (*self).to_string()
    }
}

impl SecretName for String {
    fn secret_name(&self) -> String {
        self.clone()
    }
}

/// An observability provider and how to reach it (`SourceProvider` on the wire).
///
/// ```
/// use grad::{SecretRef, SourceProvider};
/// let p = SourceProvider::langfuse()
///     .host("https://cloud.langfuse.com")
///     .secret(SecretRef::named("langfuse-prod"));
/// assert_eq!(p.kind, "langfuse");
/// ```
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SourceProvider {
    /// `langfuse`, `langsmith`, `braintrust`, `posthog`, `phoenix` or `gradiated`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub host: Option<String>,
    /// The name of the workspace secret holding the provider key.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    /// Required for braintrust (project id or name) and posthog (numeric id).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project: Option<String>,
    #[serde(skip_serializing_if = "serde_json::Map::is_empty")]
    pub filters: serde_json::Map<String, Value>,
}

impl SourceProvider {
    /// A provider of any `kind` (the server answers 422 `source_provider_unsupported` for unknown ones).
    pub fn new(kind: impl Into<String>) -> Self {
        SourceProvider {
            kind: kind.into(),
            ..Default::default()
        }
    }

    /// Langfuse traces and scores; the secret is `PUBLIC_KEY:SECRET_KEY`.
    pub fn langfuse() -> Self {
        Self::new("langfuse")
    }

    /// LangSmith runs and feedback, including corrections.
    pub fn langsmith() -> Self {
        Self::new("langsmith")
    }

    /// Braintrust project logs, scores and `expected` answers (needs `project`).
    pub fn braintrust() -> Self {
        Self::new("braintrust")
    }

    /// PostHog LLM analytics events and survey feedback (needs `project`).
    pub fn posthog() -> Self {
        Self::new("posthog")
    }

    /// Arize Phoenix spans and annotations (needs `host`).
    pub fn phoenix() -> Self {
        Self::new("phoenix")
    }

    /// Gradiated Cloud gateway traces and feedback (Cloud only; no host or secret).
    pub fn gradiated() -> Self {
        Self::new("gradiated")
    }

    pub fn host(mut self, host: impl Into<String>) -> Self {
        self.host = Some(host.into());
        self
    }

    pub fn secret(mut self, secret: impl SecretName) -> Self {
        self.secret = Some(secret.secret_name());
        self
    }

    pub fn project(mut self, project: impl Into<String>) -> Self {
        self.project = Some(project.into());
        self
    }

    /// One filter (`.filter("tags", json!(["prod"]))`). Every provider takes `tags`,
    /// `environment`, `model`, `version`, `release`, `name`, `user_id`, `session_id`,
    /// `metadata`, `from`/`to`, `has_feedback` and `min_score` (LangSmith also `filter`);
    /// the server answers 422 `source_filter_unsupported` for any other key.
    pub fn filter(mut self, key: impl Into<String>, value: impl Into<Value>) -> Self {
        self.filters.insert(key.into(), value.into());
        self
    }

    /// `gradiated`: only these served models.
    pub fn models<S: Into<String>>(self, models: impl IntoIterator<Item = S>) -> Self {
        self.list_filter("models", models)
    }

    /// `gradiated`: only these tasks.
    pub fn tasks<S: Into<String>>(self, tasks: impl IntoIterator<Item = S>) -> Self {
        self.list_filter("tasks", tasks)
    }

    /// `gradiated`: only these served versions.
    pub fn versions<S: Into<String>>(self, versions: impl IntoIterator<Item = S>) -> Self {
        self.list_filter("versions", versions)
    }

    fn list_filter<S: Into<String>>(self, key: &str, items: impl IntoIterator<Item = S>) -> Self {
        let values: Vec<Value> = items.into_iter().map(|s| Value::String(s.into())).collect();
        if values.is_empty() {
            self
        } else {
            self.filter(key, Value::Array(values))
        }
    }
}

/// The most recent sync of a [`Source`].
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct SourceSync {
    pub import_id: String,
    pub status: ImportStatus,
    pub full: bool,
    pub dataset_version: Option<i64>,
    pub error: Option<String>,
    pub created_at: String,
    pub finished_at: Option<String>,
}

/// An observability provider synced into a dataset; each sync adds a dataset version.
///
/// A source feeds exactly one dataset; a dataset can have several sources, and deleting the
/// dataset deletes them. A source starts at most one sync a minute.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct Source {
    pub id: String,
    pub workspace_id: String,
    pub dataset: String,
    pub provider: SourceProvider,
    pub schedule: Option<String>,
    /// The share of traces synced (1: all), chosen by a hash of the trace id.
    #[serde(default = "all_traces")]
    pub sample_rate: f64,
    /// Caps on new traces taken per sync and per UTC day (None: no cap).
    pub max_records_per_sync: Option<u64>,
    pub max_records_per_day: Option<u64>,
    /// New traces synced so far this UTC day (what `max_records_per_day` counts).
    pub records_today: u64,
    /// Seconds between the dataset versions scheduled syncs commit (0: every sync).
    pub version_interval: u64,
    /// Records scheduled syncs fetched that wait for the next dataset version.
    pub pending_records: u64,
    /// Null without a schedule or while paused; backs off after failed syncs.
    pub next_sync_at: Option<String>,
    /// `active`, or `paused` after 10 failed syncs in a row (a manual sync or a new value for
    /// its secret resumes it).
    pub status: String,
    pub paused_reason: Option<String>,
    /// The last failed sync's error (provider keys redacted); cleared by a successful sync.
    pub last_error: Option<String>,
    pub last_error_at: Option<String>,
    /// Failed syncs since the last successful one.
    pub consecutive_failures: u32,
    /// A full sync asked for while another ran; it starts when that one ends.
    pub pending_full: bool,
    pub last_synced_at: Option<String>,
    pub last_sync: Option<SourceSync>,
    pub created_at: String,
    pub updated_at: String,
}

fn all_traces() -> f64 {
    1.0
}

impl Source {
    /// The effective filters, as the server validated them (single values as lists).
    pub fn filters(&self) -> &serde_json::Map<String, Value> {
        &self.provider.filters
    }
}

/// Schedule, sampling and record caps for [`Sources::create_with`].
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SourceOptions {
    /// Five-field UTC cron (at most once a minute); None syncs only on request.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<String>,
    /// Your own key, to retry the call without connecting a second source (not sent in the body).
    #[serde(skip)]
    pub idempotency_key: Option<String>,
    /// The share of traces to sync, in (0, 1], chosen by a hash of the trace id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<f64>,
    /// At most this many new traces per sync. Feedback on synced traces always lands.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_records_per_sync: Option<u64>,
    /// At most this many new traces per UTC day.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_records_per_day: Option<u64>,
    /// Seconds between scheduled syncs' dataset versions (None: 900; 0: every sync).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_interval: Option<u64>,
}

/// A change to a source from its next sync ([`Sources::update`]): `None` keeps a field,
/// `Some(None)` clears the schedule or a cap. `filters` replaces them all (an empty map
/// clears them).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
pub struct SourceUpdate {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub filters: Option<serde_json::Map<String, Value>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub schedule: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sample_rate: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_records_per_sync: Option<Option<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_records_per_day: Option<Option<u64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub version_interval: Option<u64>,
}
