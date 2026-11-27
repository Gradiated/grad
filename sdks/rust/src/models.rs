//! Request and response models: the generated OpenAPI models (`crate::generated`)
//! plus the few helpers and façade-only types the SDK adds on top.

use serde::{Deserialize, Serialize};
use serde_json::Value;

pub use crate::generated::*;

/// One locally computed score for `POST /v1/evals/{id}/scores`.
pub type LocalScore = PostEvalScoresRequestScoresItem;

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
