//! Typed errors for every SDK call.
//!
//! API failures are mapped from the server's problem+json body
//! (`{type,title,status,code,detail,request_id,errors?}`) and the
//! `x-request-id` header. Every variant can report a status (0 when no HTTP
//! response was received), a machine-readable `code`, a human message and the
//! request id, so callers can match on the variant or on [`Error::code`].

use serde_json::Value;
use std::fmt;
use std::path::PathBuf;
use std::time::Duration;

#[cfg(test)]
use crate::models::RunStatus;
use crate::models::{EvalRun, ImportJob, Run};

/// Details of an HTTP error response from grad-server.
#[derive(Debug, Clone, PartialEq)]
pub struct ApiErrorBody {
    /// HTTP status code.
    pub status: u16,
    /// Machine-readable problem code (`run_not_found`, `deploy_unavailable`, ...).
    pub code: String,
    /// Short problem title.
    pub title: String,
    /// Human-readable detail from the server (its hint on how to fix it).
    pub detail: String,
    /// Server request id (problem body `request_id` or the `x-request-id` header).
    pub request_id: Option<String>,
    /// Field-level validation errors, when the server sent them (422).
    pub errors: Option<Value>,
    /// HTTP method of the failed request.
    pub method: String,
    /// Full URL of the failed request.
    pub url: String,
    /// `Retry-After` in seconds, when the server sent one.
    pub retry_after: Option<Duration>,
}

impl fmt::Display for ApiErrorBody {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{} {}: {} {}",
            self.method, self.url, self.status, self.code
        )?;
        if !self.detail.is_empty() {
            write!(f, ": {}", self.detail)?;
        }
        if let Some(errors) = &self.errors {
            if let Some(list) = errors.as_array() {
                for item in list.iter().take(10) {
                    let path = item
                        .get("path")
                        .map(|p| match p {
                            Value::Array(parts) => parts
                                .iter()
                                .map(|x| match x {
                                    Value::String(s) => s.clone(),
                                    other => other.to_string(),
                                })
                                .collect::<Vec<_>>()
                                .join("."),
                            Value::String(s) => s.clone(),
                            other => other.to_string(),
                        })
                        .unwrap_or_default();
                    let msg = item
                        .get("message")
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    write!(f, "\n  - {}: {}", path, msg)?;
                }
            }
        }
        if let Some(id) = &self.request_id {
            write!(f, " (request_id {})", id)?;
        }
        Ok(())
    }
}

/// Every error the SDK returns.
#[derive(Debug)]
#[non_exhaustive]
pub enum Error {
    /// 401: missing, invalid or revoked API key.
    Authentication(Box<ApiErrorBody>),
    /// 403: the key lacks the scope the endpoint needs.
    PermissionDenied(Box<ApiErrorBody>),
    /// 404: the resource does not exist in this workspace.
    NotFound(Box<ApiErrorBody>),
    /// 409: the request conflicts with the resource's current state.
    Conflict(Box<ApiErrorBody>),
    /// 400/413/422: the request failed validation (see `errors` for fields).
    Validation(Box<ApiErrorBody>),
    /// 429: rate limited (already retried with backoff).
    RateLimit(Box<ApiErrorBody>),
    /// 501 `deploy_unavailable`: hosted serving is not configured on this server.
    DeployUnavailable(Box<ApiErrorBody>),
    /// 501 `inference_unavailable`: no inference endpoint is configured for evals.
    InferenceUnavailable(Box<ApiErrorBody>),
    /// Any other 501: a capability this server has not configured
    /// (`secrets_unavailable`: no `GRAD_SECRETS_KEY`; `source_unavailable`: the
    /// `gradiated` source on a self-hosted server).
    FeatureUnavailable(Box<ApiErrorBody>),
    /// 5xx (already retried for idempotent requests).
    Server(Box<ApiErrorBody>),
    /// Any other non-success status.
    Api(Box<ApiErrorBody>),
    /// The server could not be reached (DNS, connection refused, TLS, reset).
    Connection {
        method: String,
        url: String,
        cause: String,
    },
    /// The request timed out.
    Timeout {
        method: String,
        url: String,
        after: Option<Duration>,
    },
    /// The server answered with a body the SDK could not decode.
    Decode {
        method: String,
        url: String,
        message: String,
    },
    /// The server redirected somewhere the SDK refuses to follow with credentials.
    Redirect {
        method: String,
        from: String,
        to: String,
        reason: String,
    },
    /// A downloaded artifact did not match its declared SHA-256 or size.
    Checksum {
        what: String,
        expected: String,
        actual: String,
    },
    /// An artifact bundle failed the safety checks during extraction.
    UnsafeArchive(String),
    /// A run reached a terminal status other than `completed`.
    RunFailed(Box<Run>),
    /// An evaluation reached `failed` or `cancelled`.
    EvalFailed(Box<EvalRun>),
    /// A dataset import job failed.
    ImportFailed(Box<ImportJob>),
    /// `wait` gave up before the resource reached a terminal state.
    WaitTimeout {
        what: String,
        id: String,
        status: String,
        after: Duration,
    },
    /// The server handed back a cursor this listing already followed; paging
    /// stopped instead of looping forever.
    PaginationLoop { path: String, cursor: String },
    /// A collect-all listing exceeded its page budget; paging stopped instead
    /// of buffering an unbounded result.
    PaginationLimit { path: String, pages: usize },
    /// Invalid client configuration (base URL, config file, missing key).
    Config(String),
    /// Invalid argument passed to an SDK call.
    InvalidInput(String),
    /// Local file-system failure.
    Io {
        path: PathBuf,
        source: std::io::Error,
    },
}

impl Error {
    /// The API error body, for HTTP status errors.
    pub fn api(&self) -> Option<&ApiErrorBody> {
        match self {
            Error::Authentication(b)
            | Error::PermissionDenied(b)
            | Error::NotFound(b)
            | Error::Conflict(b)
            | Error::Validation(b)
            | Error::RateLimit(b)
            | Error::DeployUnavailable(b)
            | Error::InferenceUnavailable(b)
            | Error::FeatureUnavailable(b)
            | Error::Server(b)
            | Error::Api(b) => Some(b.as_ref()),
            _ => None,
        }
    }

    /// HTTP status, or 0 when no response was received.
    pub fn status(&self) -> u16 {
        self.api().map(|b| b.status).unwrap_or(0)
    }

    /// Machine-readable error code.
    pub fn code(&self) -> String {
        if let Some(b) = self.api() {
            return b.code.clone();
        }
        match self {
            Error::Connection { .. } => "connection_error".into(),
            Error::Timeout { .. } => "timeout".into(),
            Error::Decode { .. } => "decode_error".into(),
            Error::Redirect { .. } => "redirect_refused".into(),
            Error::Checksum { .. } => "checksum_mismatch".into(),
            Error::UnsafeArchive(_) => "unsafe_archive".into(),
            Error::RunFailed(run) => format!("run_{}", run.status.as_str()),
            Error::EvalFailed(ev) => format!("eval_{}", ev.status.as_str()),
            Error::ImportFailed(_) => "import_failed".into(),
            Error::WaitTimeout { .. } => "wait_timeout".into(),
            Error::PaginationLoop { .. } => "pagination_loop".into(),
            Error::PaginationLimit { .. } => "pagination_limit".into(),
            Error::Config(_) => "config_error".into(),
            Error::InvalidInput(_) => "invalid_input".into(),
            Error::Io { .. } => "io_error".into(),
            _ => "error".into(),
        }
    }

    /// Server request id, when the server sent one.
    pub fn request_id(&self) -> Option<&str> {
        self.api().and_then(|b| b.request_id.as_deref())
    }

    /// Whether retrying the same request later could succeed.
    pub fn is_transient(&self) -> bool {
        match self {
            Error::Connection { .. } | Error::Timeout { .. } => true,
            Error::RateLimit(_) | Error::Server(_) => true,
            Error::Api(b) => b.status == 408,
            _ => false,
        }
    }

    pub(crate) fn io(path: impl Into<PathBuf>, source: std::io::Error) -> Self {
        Error::Io {
            path: path.into(),
            source,
        }
    }

    /// Map a non-success response to the typed variant.
    pub(crate) fn from_status(body: ApiErrorBody) -> Self {
        let body = Box::new(body);
        match (body.status, body.code.as_str()) {
            (_, "deploy_unavailable") => Error::DeployUnavailable(body),
            (_, "inference_unavailable") => Error::InferenceUnavailable(body),
            (401, _) => Error::Authentication(body),
            (403, _) => Error::PermissionDenied(body),
            (404, _) => Error::NotFound(body),
            (409, _) => Error::Conflict(body),
            (400 | 413 | 422, _) => Error::Validation(body),
            (429, _) => Error::RateLimit(body),
            (501, _) => Error::FeatureUnavailable(body),
            (s, _) if s >= 500 => Error::Server(body),
            _ => Error::Api(body),
        }
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::Authentication(b)
            | Error::PermissionDenied(b)
            | Error::NotFound(b)
            | Error::Conflict(b)
            | Error::Validation(b)
            | Error::RateLimit(b)
            | Error::DeployUnavailable(b)
            | Error::InferenceUnavailable(b)
            | Error::FeatureUnavailable(b)
            | Error::Server(b)
            | Error::Api(b) => b.fmt(f),
            Error::Connection { method, url, cause } => write!(
                f,
                "could not reach {} ({} {}): {}",
                origin_of(url),
                method,
                path_of(url),
                cause
            ),
            Error::Timeout { method, url, after } => match after {
                Some(d) => write!(f, "{} {} timed out after {:.0?}", method, url, d),
                None => write!(f, "{} {} timed out", method, url),
            },
            Error::Decode {
                method,
                url,
                message,
            } => write!(f, "{} {}: invalid response body: {}", method, url, message),
            Error::Redirect {
                method,
                from,
                to,
                reason,
            } => write!(
                f,
                "{} {} redirected to {}; refusing to follow ({})",
                method, from, to, reason
            ),
            Error::Checksum {
                what,
                expected,
                actual,
            } => write!(
                f,
                "{} failed verification: expected {}, got {}",
                what, expected, actual
            ),
            Error::UnsafeArchive(msg) => write!(f, "refusing to extract artifact bundle: {}", msg),
            Error::RunFailed(run) => {
                write!(
                    f,
                    "run {} ({}) ended with status {}",
                    run.id,
                    run.name,
                    run.status.as_str()
                )?;
                if let Some(err) = &run.error {
                    write!(f, ": {}", err)?;
                }
                Ok(())
            }
            Error::EvalFailed(ev) => {
                write!(
                    f,
                    "eval {} ({}) ended with status {}",
                    ev.id,
                    ev.name,
                    ev.status.as_str()
                )?;
                if let Some(err) = &ev.error {
                    write!(f, ": {}", err)?;
                }
                Ok(())
            }
            Error::ImportFailed(job) => {
                write!(f, "import {} into dataset {} failed", job.id, job.dataset)?;
                if let Some(err) = &job.error {
                    write!(f, ": {}", err)?;
                }
                Ok(())
            }
            Error::WaitTimeout {
                what,
                id,
                status,
                after,
            } => write!(
                f,
                "gave up waiting for {} {} after {:.0?} (still {}); it keeps going on the server",
                what, id, after, status
            ),
            Error::PaginationLoop { path, cursor } => write!(
                f,
                "GET {} repeated cursor {:?}; stopped paging to avoid an endless loop (server pagination bug)",
                path, cursor
            ),
            Error::PaginationLimit { path, pages } => write!(
                f,
                "GET {} still had more results after {} pages; stopped paging (narrow the listing or page with --cursor)",
                path, pages
            ),
            Error::Config(msg) => write!(f, "{}", msg),
            Error::InvalidInput(msg) => write!(f, "{}", msg),
            Error::Io { path, source } => write!(f, "{}: {}", path.display(), source),
        }
    }
}

impl std::error::Error for Error {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Error::Io { source, .. } => Some(source),
            _ => None,
        }
    }
}

fn origin_of(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(u) => u.origin().ascii_serialization(),
        Err(_) => url.to_string(),
    }
}

fn path_of(url: &str) -> String {
    match reqwest::Url::parse(url) {
        Ok(u) => u.path().to_string(),
        Err(_) => url.to_string(),
    }
}

/// Convenience alias.
pub type Result<T, E = Error> = std::result::Result<T, E>;

#[cfg(test)]
mod tests {
    use super::*;

    fn body(status: u16, code: &str) -> ApiErrorBody {
        ApiErrorBody {
            status,
            code: code.into(),
            title: "t".into(),
            detail: "d".into(),
            request_id: None,
            errors: Some(
                serde_json::json!([{"path": ["recipe", "lr"], "message": "bad"}, {"path": "x", "message": "y"}]),
            ),
            method: "POST".into(),
            url: "http://h/v1/x".into(),
            retry_after: None,
        }
    }

    #[test]
    fn status_mapping_and_codes() {
        let cases = [
            (401, "unauthorized", "unauthorized"),
            (403, "x", "x"),
            (404, "x", "x"),
            (409, "x", "x"),
            (413, "payload_too_large", "payload_too_large"),
            (429, "rate_limited", "rate_limited"),
            (501, "deploy_unavailable", "deploy_unavailable"),
            (501, "inference_unavailable", "inference_unavailable"),
            (501, "secrets_unavailable", "secrets_unavailable"),
            (502, "x", "x"),
            (418, "teapot", "teapot"),
        ];
        for (s, c, want) in cases {
            let e = Error::from_status(body(s, c));
            assert_eq!(e.code(), want);
            assert_eq!(e.status(), s);
            assert!(e.to_string().contains("recipe.lr: bad"), "{}", e);
        }
        assert!(matches!(
            Error::from_status(body(413, "x")),
            Error::Validation(_)
        ));
        assert!(matches!(Error::from_status(body(418, "x")), Error::Api(_)));
        assert!(matches!(
            Error::from_status(body(501, "source_unavailable")),
            Error::FeatureUnavailable(_)
        ));
        assert!(Error::from_status(body(408, "x")).is_transient());
        assert!(!Error::from_status(body(404, "x")).is_transient());
    }

    #[test]
    fn local_errors_display_and_codes() {
        let run = Run {
            id: "run_1".into(),
            name: "n".into(),
            status: RunStatus::StoppedBudget,
            error: Some("cap".into()),
            ..Default::default()
        };
        let ev = EvalRun {
            id: "e".into(),
            status: crate::models::EvalStatus::Cancelled,
            ..Default::default()
        };
        let job = ImportJob {
            id: "imp".into(),
            dataset: "d".into(),
            error: Some("bad file".into()),
            ..Default::default()
        };
        let cases: Vec<(Error, &str, &str)> = vec![
            (
                Error::Timeout {
                    method: "GET".into(),
                    url: "u".into(),
                    after: None,
                },
                "timeout",
                "timed out",
            ),
            (
                Error::Decode {
                    method: "GET".into(),
                    url: "u".into(),
                    message: "m".into(),
                },
                "decode_error",
                "invalid response",
            ),
            (
                Error::Redirect {
                    method: "GET".into(),
                    from: "a".into(),
                    to: "b".into(),
                    reason: "r".into(),
                },
                "redirect_refused",
                "refusing",
            ),
            (
                Error::Checksum {
                    what: "w".into(),
                    expected: "e".into(),
                    actual: "a".into(),
                },
                "checksum_mismatch",
                "expected e",
            ),
            (
                Error::UnsafeArchive("x".into()),
                "unsafe_archive",
                "refusing to extract",
            ),
            (Error::RunFailed(Box::new(run)), "run_stopped_budget", "cap"),
            (
                Error::EvalFailed(Box::new(ev)),
                "eval_cancelled",
                "cancelled",
            ),
            (
                Error::ImportFailed(Box::new(job)),
                "import_failed",
                "bad file",
            ),
            (
                Error::WaitTimeout {
                    what: "run".into(),
                    id: "r".into(),
                    status: "running".into(),
                    after: Duration::from_secs(1),
                },
                "wait_timeout",
                "keeps going",
            ),
            (Error::Config("c".into()), "config_error", "c"),
            (Error::InvalidInput("i".into()), "invalid_input", "i"),
            (
                Error::io("/p", std::io::Error::other("boom")),
                "io_error",
                "/p: boom",
            ),
            (
                Error::Connection {
                    method: "GET".into(),
                    url: "http://h:1/v1/m".into(),
                    cause: "refused".into(),
                },
                "connection_error",
                "could not reach http://h:1 (GET /v1/m): refused",
            ),
        ];
        for (e, code, text) in cases {
            assert_eq!(e.code(), code);
            assert!(e.to_string().contains(text), "{} !~ {}", e, text);
            assert_eq!(e.status(), 0);
            assert!(e.request_id().is_none());
        }
        assert!(std::error::Error::source(&Error::io("/p", std::io::Error::other("x"))).is_some());
    }
}
