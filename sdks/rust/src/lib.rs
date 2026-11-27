//! Rust SDK for the Gradiated `grad` training and serving platform.
//!
//! ```no_run
//! # async fn demo() -> grad_sdk::Result<()> {
//! use grad_sdk::{Client, PlanRunRequest, RecipeKind, RecipeSpec};
//!
//! // Reads GRADIATED_API_KEY / GRADIATED_BASE_URL, then the `grad login` config file.
//! let client = Client::new();
//! let plan = client
//!     .runs()
//!     .plan(&PlanRunRequest::new("support-prod", "support-router", RecipeSpec::new(RecipeKind::Router)))
//!     .await?;
//! println!("~${:.2} for {} steps", plan.estimated_cost_usd, plan.estimated_steps);
//! # Ok(()) }
//! ```
//!
//! Resources hang off [`Client`]: [`Client::datasets`], [`Client::runs`],
//! [`Client::artifacts`], [`Client::deployments`], [`Client::evals`], ...
//! Every call returns [`Result`] with a typed [`Error`]. The request and
//! response models are generated from `spec/openapi.yaml` (`generated`).
//!
//! A run's lifecycle streams as typed [`RunEvent`]s (phase, metric,
//! checkpoint, attempt, warning, log, completed): `client.runs().events(id,
//! true)` returns a [`RunEventStream`] whose `next().await` reconnects with
//! `Last-Event-ID` invisibly and ends after `completed`; `wait_with_events`
//! waits with a callback.

pub mod config;
pub mod download;
pub mod error;
pub mod events;
#[rustfmt::skip]
pub mod generated;
pub mod models;
pub mod recipes;
mod resources;
pub mod sse;
mod transport;
mod util;

use std::time::Duration;

pub use config::{ConfigFile, ConfigInputs, Profile, ResolvedConfig, Source as ConfigSource};
pub use download::{DownloadOptions, DownloadedArtifact, ExtractLimits};
pub use error::{ApiErrorBody, Error, Result};
pub use events::{
    AttemptEvent, AttemptKind, CheckpointEvent, CompletedEvent, EventMeta, GpuInfo, MessageEvent,
    PhaseEvent, RunEvent, RunEventStream, RunEventsPage, RunMetricEvent,
};
pub use models::*;
pub use resources::*;
pub use sse::{MetricEvent, MetricStream, SseEvent, SseParser};
pub use util::sha256_hex;

/// Default total timeout of one JSON request.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
/// Default number of retries for retryable failures.
pub const DEFAULT_MAX_RETRIES: u32 = 2;

/// Client for the grad API. Cheap to clone; clones share one connection pool.
#[derive(Clone)]
pub struct Client {
    transport: transport::Transport,
    resolved: ResolvedConfig,
}

impl std::fmt::Debug for Client {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Client")
            .field("base_url", &self.transport.base_url)
            .field(
                "api_key",
                &self.transport.api_key.as_ref().map(|_| "[REDACTED]"),
            )
            .field("timeout", &self.transport.timeout)
            .field("max_retries", &self.transport.max_retries)
            .finish()
    }
}

impl Default for Client {
    fn default() -> Self {
        Self::new()
    }
}

/// Builder for [`Client`] with eager validation.
#[derive(Debug, Clone, Default)]
pub struct ClientBuilder {
    inputs: ConfigInputs,
    timeout: Option<Duration>,
    connect_timeout: Option<Duration>,
    read_timeout: Option<Duration>,
    max_retries: Option<u32>,
    retry_base: Option<Duration>,
}

impl ClientBuilder {
    /// Base URL (default: env `GRADIATED_BASE_URL`, then config file, then `https://api.gradiated.com`).
    pub fn base_url(mut self, url: impl Into<String>) -> Self {
        self.inputs.base_url = Some(url.into());
        self
    }

    /// API key (default: env `GRADIATED_API_KEY`, then config file).
    pub fn api_key(mut self, key: impl Into<String>) -> Self {
        self.inputs.api_key = Some(key.into());
        self
    }

    /// Use a named profile from the config file (wins over the environment).
    pub fn profile(mut self, name: impl Into<String>) -> Self {
        self.inputs.profile = Some(name.into());
        self
    }

    /// Read the config file from `path` instead of the default location.
    pub fn config_path(mut self, path: impl Into<std::path::PathBuf>) -> Self {
        self.inputs.config_path = Some(path.into());
        self
    }

    /// Ignore `GRADIATED_*` environment variables.
    pub fn ignore_env(mut self, yes: bool) -> Self {
        self.inputs.ignore_env = yes;
        self
    }

    /// Ignore the config file.
    pub fn ignore_config_file(mut self, yes: bool) -> Self {
        self.inputs.ignore_file = yes;
        self
    }

    /// Total timeout of one JSON request (default 60 s). Downloads and SSE are not bounded by it.
    pub fn timeout(mut self, d: Duration) -> Self {
        self.timeout = Some(d);
        self
    }

    /// TCP/TLS connect timeout (default 10 s).
    pub fn connect_timeout(mut self, d: Duration) -> Self {
        self.connect_timeout = Some(d);
        self
    }

    /// Maximum idle time between reads of a response body (default 120 s).
    pub fn read_timeout(mut self, d: Duration) -> Self {
        self.read_timeout = Some(d);
        self
    }

    /// Retries for retryable failures (default 2).
    pub fn max_retries(mut self, n: u32) -> Self {
        self.max_retries = Some(n);
        self
    }

    /// Base delay of the retry backoff (default 500 ms).
    pub fn retry_base_delay(mut self, d: Duration) -> Self {
        self.retry_base = Some(d);
        self
    }

    /// Resolve configuration and build the client.
    pub fn build(self) -> Result<Client> {
        let resolved = config::resolve(&self.inputs)?;
        let base = config::validate_base_url(&resolved.base_url)?;
        let http = transport::build_http(
            self.connect_timeout.unwrap_or(Duration::from_secs(10)),
            self.read_timeout.unwrap_or(Duration::from_secs(120)),
        );
        Ok(Client {
            transport: transport::Transport {
                http,
                base: Some(base),
                base_url: resolved.base_url.clone(),
                api_key: resolved.api_key.clone(),
                timeout: self.timeout.unwrap_or(DEFAULT_TIMEOUT),
                max_retries: self.max_retries.unwrap_or(DEFAULT_MAX_RETRIES),
                retry_base: self.retry_base.unwrap_or(Duration::from_millis(500)),
                deferred: None,
                auth_hint: resolved.note.clone(),
                no_auth: resolved.api_key.is_none()
                    && resolved.api_key_source == ConfigSource::Argument,
            },
            resolved,
        })
    }
}

impl Client {
    /// A client configured from the environment and the config file.
    ///
    /// Configuration problems (a malformed config file, an invalid
    /// `GRADIATED_BASE_URL`) are reported by the first request; use
    /// [`Client::builder`] to get them eagerly.
    pub fn new() -> Self {
        match Client::builder().build() {
            Ok(c) => c,
            Err(e) => Client::broken(e.to_string()),
        }
    }

    /// A builder for explicit configuration.
    pub fn builder() -> ClientBuilder {
        ClientBuilder::default()
    }

    fn broken(msg: String) -> Self {
        Client {
            transport: transport::Transport {
                http: transport::build_http(Duration::from_secs(10), Duration::from_secs(120)),
                base: None,
                base_url: config::DEFAULT_BASE_URL.into(),
                api_key: None,
                timeout: DEFAULT_TIMEOUT,
                max_retries: DEFAULT_MAX_RETRIES,
                retry_base: Duration::from_millis(500),
                deferred: Some(msg),
                auth_hint: None,
                no_auth: false,
            },
            resolved: ResolvedConfig {
                base_url: config::DEFAULT_BASE_URL.into(),
                base_url_source: ConfigSource::Default,
                api_key: None,
                api_key_source: ConfigSource::Unset,
                profile: config::DEFAULT_PROFILE.into(),
                config_path: None,
                note: None,
            },
        }
    }

    /// Use this API key.
    pub fn with_api_key(mut self, key: impl Into<String>) -> Self {
        let key = key.into();
        self.transport.api_key = Some(key.clone());
        self.transport.auth_hint = None;
        self.resolved.api_key = Some(key);
        self.resolved.api_key_source = ConfigSource::Argument;
        self
    }

    /// Use this base URL.
    pub fn with_base_url(mut self, url: impl Into<String>) -> Self {
        let url = config::normalize_base_url(&url.into());
        match config::validate_base_url(&url) {
            Ok(base) => {
                // A key that came from a profile stays bound to that profile's server.
                if let ConfigSource::Profile(_) = self.resolved.api_key_source {
                    if url != self.resolved.base_url {
                        self.transport.api_key = None;
                        self.resolved.api_key = None;
                        self.resolved.api_key_source = ConfigSource::Unset;
                    }
                }
                if self
                    .transport
                    .deferred
                    .as_deref()
                    .is_some_and(|m| m.contains("base URL"))
                {
                    self.transport.deferred = None;
                }
                self.transport.base = Some(base);
            }
            Err(e) => self.transport.deferred = Some(e.to_string()),
        }
        self.transport.base_url = url.clone();
        self.resolved.base_url = url;
        self.resolved.base_url_source = ConfigSource::Argument;
        self
    }

    /// Total timeout of one JSON request.
    pub fn with_timeout(mut self, d: Duration) -> Self {
        self.transport.timeout = d;
        self
    }

    /// Retries for retryable failures.
    pub fn with_max_retries(mut self, n: u32) -> Self {
        self.transport.max_retries = n;
        self
    }

    /// The base URL requests go to.
    pub fn base_url(&self) -> &str {
        &self.transport.base_url
    }

    /// Whether an API key is configured.
    pub fn has_api_key(&self) -> bool {
        self.transport.api_key.is_some()
    }

    /// How the configuration was resolved (sources, profile, config path).
    pub fn resolved_config(&self) -> &ResolvedConfig {
        &self.resolved
    }

    pub(crate) fn t(&self) -> &transport::Transport {
        &self.transport
    }

    /// `GET /health/ready`: whether the server and its database are ready.
    pub async fn health(&self) -> Result<serde_json::Value> {
        let mut req = transport::Req::get("/health/ready");
        req.auth = false;
        self.transport.json(req).await
    }

    pub fn models(&self) -> Models<'_> {
        Models { c: self }
    }
    pub fn keys(&self) -> Keys<'_> {
        Keys { c: self }
    }
    pub fn datasets(&self) -> Datasets<'_> {
        Datasets { c: self }
    }
    pub fn imports(&self) -> Imports<'_> {
        Imports { c: self }
    }
    pub fn runs(&self) -> Runs<'_> {
        Runs { c: self }
    }
    pub fn checkpoints(&self) -> Checkpoints<'_> {
        Checkpoints { c: self }
    }
    pub fn artifacts(&self) -> Artifacts<'_> {
        Artifacts { c: self }
    }
    pub fn deployments(&self) -> Deployments<'_> {
        Deployments { c: self }
    }
    pub fn evals(&self) -> Evals<'_> {
        Evals { c: self }
    }
    /// Billed usage records (`GET /v1/usage`).
    pub fn usage(&self) -> UsageLedger<'_> {
        UsageLedger { c: self }
    }
    /// Workspace secrets (provider keys, HF tokens); values are write-only.
    pub fn secrets(&self) -> Secrets<'_> {
        Secrets { c: self }
    }
    /// Observability sources that sync traces and feedback into datasets.
    pub fn sources(&self) -> Sources<'_> {
        Sources { c: self }
    }
}

pub(crate) fn enc(e: serde_json::Error) -> Error {
    Error::InvalidInput(format!("could not encode request: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_never_prints_the_key() {
        let c = Client::builder()
            .ignore_env(true)
            .ignore_config_file(true)
            .base_url("http://127.0.0.1:1")
            .api_key("grad_super_secret")
            .build()
            .unwrap();
        let dbg = format!("{:?} {:?}", c, c.resolved_config());
        assert!(!dbg.contains("grad_super_secret"), "{}", dbg);
        assert!(dbg.contains("REDACTED"));
    }

    #[test]
    fn new_defers_configuration_errors() {
        let c = Client::new().with_base_url("not a url");
        assert!(c.transport.deferred.is_some());
        let c = c.with_base_url("http://127.0.0.1:9");
        assert!(c.transport.deferred.is_none());
        assert_eq!(c.base_url(), "http://127.0.0.1:9");
    }
}
