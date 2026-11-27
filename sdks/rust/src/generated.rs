// AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.
#![allow(clippy::all, clippy::pedantic, dead_code, unused_imports, non_camel_case_types)]

use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Version reported in the User-Agent header.
pub const SDK_VERSION: &str = "0.1.0";
/// Default per-attempt timeout (headers, and the body for JSON calls).
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(60);
/// Default retry budget.
pub const DEFAULT_MAX_RETRIES: u32 = 2;
/// Default idle timeout for streaming bodies.
pub const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(120);
/// Longest Retry-After the transport waits for before giving up.
pub const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);
const MAX_REDIRECTS: u32 = 5;

/// Classification of an [`ApiError`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorKind {
    /// 400
    BadRequest,
    /// 401
    Authentication,
    /// 403
    PermissionDenied,
    /// 404
    NotFound,
    /// 409
    Conflict,
    /// 422 (see `field_errors`)
    Validation,
    /// 429
    RateLimit,
    /// 5xx
    Server,
    /// 501 `deploy_unavailable`
    DeployUnavailable,
    /// 501 `inference_unavailable`
    InferenceUnavailable,
    /// Any other non-2xx status
    Api,
    /// No response: DNS, refused, reset, TLS
    Connection,
    /// The per-request timeout elapsed, or a stream went idle
    Timeout,
    /// A redirect would leave the API origin or change a non-GET request
    Redirect,
    /// A 2xx body could not be decoded
    Decode,
    /// The request could not be built (bad path parameter, unencodable body)
    InvalidRequest,
}

/// One field-level validation failure from a 422 response.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FieldError {
    pub field: String,
    pub message: String,
}

/// Every error the generated client returns. `status` is 0 when no response was received.
#[derive(Debug, Clone)]
pub struct ApiError {
    pub kind: ErrorKind,
    pub status: u16,
    pub code: String,
    pub title: String,
    pub detail: String,
    pub request_id: String,
    pub method: String,
    pub url: String,
    pub message: String,
    pub field_errors: Vec<FieldError>,
    pub retry_after: Option<Duration>,
}

impl ApiError {
    /// An error that never reached the server.
    pub fn local(kind: ErrorKind, code: &str, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            kind,
            status: 0,
            code: code.to_string(),
            title: String::new(),
            detail: message.clone(),
            request_id: String::new(),
            method: String::new(),
            url: String::new(),
            message,
            field_errors: Vec::new(),
            retry_after: None,
        }
    }

    pub fn is_not_found(&self) -> bool {
        self.kind == ErrorKind::NotFound
    }

    pub fn is_retryable(&self) -> bool {
        matches!(self.status, 408 | 429 | 500 | 502 | 503 | 504)
            || matches!(self.kind, ErrorKind::Connection | ErrorKind::Timeout)
    }

    /// Builds the typed error for a non-2xx response; tolerant of any body shape.
    pub fn from_response(
        status: u16,
        headers: &reqwest::header::HeaderMap,
        body: &str,
        method: &str,
        url: &str,
        api_key_configured: bool,
    ) -> Self {
        let parsed: Option<Value> = serde_json::from_str(body).ok();
        let problem = parsed.as_ref().and_then(|v| v.as_object());
        let field = |key: &str| -> Option<String> {
            problem
                .and_then(|p| p.get(key))
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
        };
        let code = field("code").unwrap_or_else(|| format!("http_{status}"));
        let title = field("title").unwrap_or_else(|| format!("HTTP {status}"));
        let detail = field("detail").or_else(|| field("message")).unwrap_or_else(|| {
            if problem.is_some() {
                String::new()
            } else {
                body.trim().chars().take(500).collect()
            }
        });
        let request_id = headers
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string())
            .or_else(|| field("request_id"))
            .unwrap_or_default();
        let kind = if code == "deploy_unavailable" {
            ErrorKind::DeployUnavailable
        } else if code == "inference_unavailable" {
            ErrorKind::InferenceUnavailable
        } else {
            match status {
                400 => ErrorKind::BadRequest,
                401 => ErrorKind::Authentication,
                403 => ErrorKind::PermissionDenied,
                404 => ErrorKind::NotFound,
                409 => ErrorKind::Conflict,
                422 => ErrorKind::Validation,
                429 => ErrorKind::RateLimit,
                s if s >= 500 => ErrorKind::Server,
                _ => ErrorKind::Api,
            }
        };
        let mut message = format!("{method} {url} returned {status} {code}");
        if !detail.is_empty() {
            message.push_str(": ");
            message.push_str(&detail);
        }
        if status == 401 && !api_key_configured {
            message.push_str(" No API key is configured: set GRADIATED_API_KEY, pass an api key, or run `grad login`.");
        }
        if !request_id.is_empty() {
            message.push_str(&format!(" (request_id {request_id})"));
        }
        let field_errors = if status == 422 {
            parse_field_errors(problem, &detail)
        } else {
            Vec::new()
        };
        Self {
            kind,
            status,
            code,
            title,
            detail,
            request_id,
            method: method.to_string(),
            url: url.to_string(),
            message,
            field_errors,
            retry_after: parse_retry_after(headers),
        }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for ApiError {}

fn parse_field_errors(problem: Option<&serde_json::Map<String, Value>>, detail: &str) -> Vec<FieldError> {
    if let Some(items) = problem.and_then(|p| p.get("errors")).and_then(|v| v.as_array()) {
        return items
            .iter()
            .filter_map(|item| item.as_object())
            .map(|item| FieldError {
                field: item.get("field").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                message: item
                    .get("message")
                    .or_else(|| item.get("detail"))
                    .and_then(|v| v.as_str())
                    .unwrap_or("")
                    .to_string(),
            })
            .collect();
    }
    detail
        .split("; ")
        .filter_map(|part| {
            let (field, message) = part.split_once(": ")?;
            if field.is_empty() || !field.chars().all(|c| c.is_ascii_alphanumeric() || "_.[]-".contains(c)) {
                return None;
            }
            Some(FieldError { field: field.to_string(), message: message.to_string() })
        })
        .collect()
}

/// Reads Retry-After-Ms or Retry-After (seconds; HTTP dates are treated as absent).
pub fn parse_retry_after(headers: &reqwest::header::HeaderMap) -> Option<Duration> {
    if let Some(ms) = headers.get("retry-after-ms").and_then(|v| v.to_str().ok()) {
        if let Ok(v) = ms.trim().parse::<f64>() {
            if v >= 0.0 {
                return Some(Duration::from_secs_f64(v / 1000.0));
            }
        }
    }
    let raw = headers.get("retry-after")?.to_str().ok()?.trim().to_string();
    raw.parse::<f64>().ok().filter(|v| *v >= 0.0).map(Duration::from_secs_f64)
}

/// Percent-encodes one path segment; rejects empty, `.` and `..`.
pub fn encode_path_segment(name: &str, input: &str) -> Result<String, ApiError> {
    if input.is_empty() || input == "." || input == ".." {
        return Err(ApiError::local(
            ErrorKind::InvalidRequest,
            "invalid_path_parameter",
            format!("path parameter '{name}' must be a non-empty value other than '.' or '..'"),
        ));
    }
    let mut out = String::with_capacity(input.len());
    for byte in input.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(byte as char),
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    Ok(out)
}

/// Renders a query or header value (booleans as `true`/`false`).
pub trait QueryValue {
    fn query_value(&self) -> String;
}

impl QueryValue for String {
    fn query_value(&self) -> String {
        self.clone()
    }
}
impl QueryValue for &str {
    fn query_value(&self) -> String {
        (*self).to_string()
    }
}
impl QueryValue for bool {
    fn query_value(&self) -> String {
        self.to_string()
    }
}
impl QueryValue for i64 {
    fn query_value(&self) -> String {
        self.to_string()
    }
}
impl QueryValue for f64 {
    fn query_value(&self) -> String {
        self.to_string()
    }
}
impl QueryValue for Value {
    fn query_value(&self) -> String {
        match self {
            Value::String(s) => s.clone(),
            other => other.to_string(),
        }
    }
}

static JITTER_STATE: AtomicU64 = AtomicU64::new(0);

fn jitter() -> f64 {
    let mut x = JITTER_STATE.load(Ordering::Relaxed);
    if x == 0 {
        x = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos() as u64).unwrap_or(0x9E37_79B9) | 1;
    }
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    JITTER_STATE.store(x, Ordering::Relaxed);
    (x >> 11) as f64 / (1u64 << 53) as f64
}

/// A random UUIDv4 for the Idempotency-Key header.
pub fn new_idempotency_key() -> String {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).expect("reading random bytes for an Idempotency-Key");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    let hex: String = b.iter().map(|x| format!("{x:02x}")).collect();
    format!("{}-{}-{}-{}-{}", &hex[0..8], &hex[8..12], &hex[12..16], &hex[16..20], &hex[20..32])
}

/// Exponential backoff (0.5 s, 1 s, 2 s, ... capped at 8 s) scaled into [50%, 100%].
pub fn backoff(attempt: u32) -> Duration {
    let base = (500.0 * 2f64.powi(attempt as i32)).min(8000.0);
    Duration::from_millis((base * (0.5 + jitter() * 0.5)) as u64)
}

fn origin_of(url: &reqwest::Url) -> String {
    format!("{}://{}", url.scheme(), url.host_str().unwrap_or(""))
        + &url.port().map(|p| format!(":{p}")).unwrap_or_default()
}

/// A successful streaming response. Read it with [`StreamResponse::chunk`].
pub struct StreamResponse {
    pub status: u16,
    pub headers: reqwest::header::HeaderMap,
    pub request_id: String,
    pub url: String,
    response: reqwest::Response,
    idle: Duration,
    method: String,
}

impl fmt::Debug for StreamResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("StreamResponse").field("status", &self.status).field("url", &self.url).finish()
    }
}

impl StreamResponse {
    /// A response header as a string.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.get(name).and_then(|v| v.to_str().ok())
    }

    /// The next body chunk (`None` at the end); an idle stream fails with `ErrorKind::Timeout`.
    pub async fn chunk(&mut self) -> Result<Option<Vec<u8>>, ApiError> {
        match tokio::time::timeout(self.idle, self.response.chunk()).await {
            Err(_) => Err(ApiError {
                kind: ErrorKind::Timeout,
                code: "timeout".into(),
                message: format!("{} {}: the stream sent nothing for {:?}", self.method, self.url, self.idle),
                ..ApiError::local(ErrorKind::Timeout, "timeout", "")
            }),
            Ok(Err(err)) => Err(ApiError {
                message: format!("{} {}: the stream broke: {err}", self.method, self.url),
                ..ApiError::local(ErrorKind::Connection, "connection_error", err.to_string())
            }),
            Ok(Ok(chunk)) => Ok(chunk.map(|b| b.to_vec())),
        }
    }

    /// Reads the whole body into memory (avoid for large artifacts; stream with `chunk`).
    pub async fn bytes(mut self) -> Result<Vec<u8>, ApiError> {
        let mut out = Vec::new();
        while let Some(chunk) = self.chunk().await? {
            out.extend_from_slice(&chunk);
        }
        Ok(out)
    }
}

/// One Server-Sent Event.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
    pub id: Option<String>,
    pub retry: Option<Duration>,
}

/// Events from one SSE connection: `while let Some(e) = stream.next_event().await? { ... }`.
#[derive(Debug)]
pub struct SseStream {
    response: StreamResponse,
    buffer: Vec<u8>,
    last_id: Option<String>,
    done: bool,
}

impl SseStream {
    /// The id of the last event received (send it as `Last-Event-ID` to resume).
    pub fn last_event_id(&self) -> Option<&str> {
        self.last_id.as_deref()
    }

    pub async fn next_event(&mut self) -> Result<Option<SseEvent>, ApiError> {
        let mut event = String::new();
        let mut data: Vec<String> = Vec::new();
        let mut retry = None;
        loop {
            let newline = self.buffer.iter().position(|b| *b == b'\n');
            let line = match newline {
                Some(pos) => {
                    let mut line: Vec<u8> = self.buffer.drain(..=pos).collect();
                    line.pop();
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    String::from_utf8_lossy(&line).into_owned()
                }
                None if self.done => {
                    if self.buffer.is_empty() {
                        return Ok(None);
                    }
                    String::from_utf8_lossy(&std::mem::take(&mut self.buffer)).into_owned()
                }
                None => {
                    match self.response.chunk().await? {
                        Some(chunk) => self.buffer.extend_from_slice(&chunk),
                        None => self.done = true,
                    }
                    continue;
                }
            };
            if line.is_empty() {
                if !data.is_empty() || !event.is_empty() {
                    return Ok(Some(SseEvent {
                        event: if event.is_empty() { "message".into() } else { event },
                        data: data.join("\n"),
                        id: self.last_id.clone(),
                        retry,
                    }));
                }
                continue;
            }
            if line.starts_with(':') {
                continue;
            }
            let (field, value) = match line.split_once(':') {
                Some((f, v)) => (f.to_string(), v.strip_prefix(' ').unwrap_or(v).to_string()),
                None => (line.clone(), String::new()),
            };
            match field.as_str() {
                "event" => event = value,
                "data" => data.push(value),
                "id" if !value.contains('\0') => self.last_id = Some(value),
                "retry" => retry = value.parse::<u64>().ok().map(Duration::from_millis),
                _ => {}
            }
        }
    }
}

/// Low-level transport: retries with backoff and Retry-After, same-origin-only redirects, per-attempt timeouts.
#[derive(Clone)]
pub struct GeneratedClient {
    base_url: String,
    origin: String,
    api_key: Option<String>,
    http: reqwest::Client,
    timeout: Duration,
    idle_timeout: Duration,
    max_retries: u32,
    user_agent: String,
}

impl fmt::Debug for GeneratedClient {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("GeneratedClient")
            .field("base_url", &self.base_url)
            .field("api_key", &self.api_key.as_ref().map(|_| "<redacted>"))
            .field("timeout", &self.timeout)
            .field("max_retries", &self.max_retries)
            .finish()
    }
}

impl GeneratedClient {
    /// A client with redirects disabled at the HTTP layer (the transport applies its own same-origin policy).
    pub fn new(base_url: impl Into<String>, api_key: Option<String>) -> Self {
        let http = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .expect("building the reqwest client (TLS backend unavailable?)");
        Self::with_http_client(base_url, api_key, http)
    }

    /// Uses a caller-provided reqwest client. It must not follow redirects (`Policy::none()`),
    /// otherwise reqwest's own redirect handling runs before the same-origin check.
    pub fn with_http_client(base_url: impl Into<String>, api_key: Option<String>, http: reqwest::Client) -> Self {
        let base_url = base_url.into().trim_end_matches('/').to_string();
        let origin = reqwest::Url::parse(&base_url).map(|u| origin_of(&u)).unwrap_or_default();
        Self {
            base_url,
            origin,
            api_key: api_key.filter(|k| !k.is_empty()),
            http,
            timeout: DEFAULT_TIMEOUT,
            idle_timeout: DEFAULT_IDLE_TIMEOUT,
            max_retries: DEFAULT_MAX_RETRIES,
            user_agent: format!("grad-rust/{SDK_VERSION}"),
        }
    }

    pub fn with_timeout(mut self, timeout: Duration) -> Self {
        self.timeout = timeout;
        self
    }

    pub fn with_idle_timeout(mut self, idle: Duration) -> Self {
        self.idle_timeout = idle;
        self
    }

    pub fn with_max_retries(mut self, retries: u32) -> Self {
        self.max_retries = retries;
        self
    }

    pub fn with_user_agent(mut self, user_agent: impl Into<String>) -> Self {
        self.user_agent = user_agent.into();
        self
    }

    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    async fn send(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
        headers: &[(&str, String)],
        body: Option<Vec<u8>>,
        accept: &str,
        streaming: bool,
    ) -> Result<(reqwest::Response, String), ApiError> {
        if self.origin.is_empty() {
            return Err(ApiError::local(
                ErrorKind::InvalidRequest,
                "invalid_base_url",
                format!("invalid base URL '{}': it must be an absolute http(s) URL", self.base_url),
            ));
        }
        let method_name = method.as_str().to_string();
        // A request with an Idempotency-Key (one per call, reused by every retry) retries like a GET.
        let keyed = headers.iter().any(|(name, _)| name.eq_ignore_ascii_case("idempotency-key"));
        let idempotent = keyed || matches!(method_name.as_str(), "GET" | "HEAD" | "PUT" | "DELETE" | "OPTIONS");
        let mut url = reqwest::Url::parse(&format!("{}{}", self.base_url, path)).map_err(|e| {
            ApiError::local(ErrorKind::InvalidRequest, "invalid_request", format!("{method_name} {path}: {e}"))
        })?;
        if !query.is_empty() {
            url.query_pairs_mut().extend_pairs(query.iter().map(|(k, v)| (*k, v.as_str())));
        }
        let mut redirects = 0;
        let mut attempt: u32 = 0;
        loop {
            let mut req = self
                .http
                .request(method.clone(), url.clone())
                .header(reqwest::header::USER_AGENT, &self.user_agent)
                .header(reqwest::header::ACCEPT, accept);
            if let Some(key) = &self.api_key {
                req = req.bearer_auth(key);
            }
            for (name, value) in headers {
                req = req.header(*name, value);
            }
            if let Some(payload) = &body {
                req = req.header(reqwest::header::CONTENT_TYPE, "application/json").body(payload.clone());
            }
            let url_text = url.to_string();
            let sent = tokio::time::timeout(self.timeout, req.send()).await;
            let resp = match sent {
                Err(_) => {
                    let err = ApiError {
                        method: method_name.clone(),
                        url: url_text.clone(),
                        ..ApiError::local(
                            ErrorKind::Timeout,
                            "timeout",
                            format!("{method_name} {url_text} timed out after {:?}", self.timeout),
                        )
                    };
                    if attempt < self.max_retries && idempotent {
                        tokio::time::sleep(backoff(attempt)).await;
                        attempt += 1;
                        continue;
                    }
                    return Err(err);
                }
                Ok(Err(e)) => {
                    let never_sent = e.is_connect();
                    let err = ApiError {
                        method: method_name.clone(),
                        url: url_text.clone(),
                        ..ApiError::local(
                            ErrorKind::Connection,
                            "connection_error",
                            format!(
                                "{method_name} {url_text} failed: could not reach {} ({e}). Is the server running? Check GRADIATED_BASE_URL.",
                                self.origin
                            ),
                        )
                    };
                    if attempt < self.max_retries && (idempotent || never_sent) {
                        tokio::time::sleep(backoff(attempt)).await;
                        attempt += 1;
                        continue;
                    }
                    return Err(err);
                }
                Ok(Ok(resp)) => resp,
            };
            let status = resp.status().as_u16();
            if (300..400).contains(&status) && status != 304 {
                let target = resp
                    .headers()
                    .get(reqwest::header::LOCATION)
                    .and_then(|v| v.to_str().ok())
                    .and_then(|loc| url.join(loc).ok());
                if let Some(next) = &target {
                    if origin_of(next) == self.origin && matches!(method_name.as_str(), "GET" | "HEAD") && redirects < MAX_REDIRECTS {
                        redirects += 1;
                        url = next.clone();
                        continue;
                    }
                }
                let where_to = target.map(|t| t.to_string()).unwrap_or_else(|| "an unknown location".into());
                return Err(ApiError {
                    status,
                    method: method_name.clone(),
                    url: url_text.clone(),
                    ..ApiError::local(
                        ErrorKind::Redirect,
                        "redirect_refused",
                        format!(
                            "{method_name} {url_text} was redirected ({status}) to {where_to}; refusing to follow a redirect that leaves {} or changes a {method_name} request, so credentials are never sent elsewhere. Point GRADIATED_BASE_URL at the final URL.",
                            self.origin
                        ),
                    )
                });
            }
            if !(200..300).contains(&status) {
                let resp_headers = resp.headers().clone();
                let text = tokio::time::timeout(self.timeout, resp.text()).await.ok().and_then(|r| r.ok()).unwrap_or_default();
                let err = ApiError::from_response(status, &resp_headers, &text, &method_name, &url_text, self.api_key.is_some());
                // 409 + Retry-After on a keyed request: the first attempt is still running server-side.
                let in_progress = status == 409 && keyed && err.retry_after.is_some();
                let retryable = (matches!(status, 408 | 429 | 500 | 502 | 503 | 504) && (idempotent || status == 429)) || in_progress;
                if retryable && attempt < self.max_retries {
                    let delay = err.retry_after.unwrap_or_else(|| backoff(attempt));
                    if delay <= MAX_RETRY_AFTER {
                        tokio::time::sleep(delay).await;
                        attempt += 1;
                        continue;
                    }
                }
                return Err(err);
            }
            let _ = streaming;
            return Ok((resp, url_text));
        }
    }

    fn encode_body<B: Serialize + ?Sized>(&self, method: &str, path: &str, body: Option<&B>) -> Result<Option<Vec<u8>>, ApiError> {
        body.map(|b| {
            serde_json::to_vec(b).map_err(|e| {
                ApiError::local(ErrorKind::InvalidRequest, "invalid_request", format!("{method} {path}: encoding the request body: {e}"))
            })
        })
        .transpose()
    }

    /// Sends a JSON request and decodes the response (empty bodies decode as JSON `null`).
    pub async fn request_json<T: DeserializeOwned, B: Serialize + ?Sized>(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
        headers: &[(&str, String)],
        body: Option<&B>,
    ) -> Result<T, ApiError> {
        let method_name = method.as_str().to_string();
        let payload = self.encode_body(&method_name, path, body)?;
        let (resp, url) = self.send(method, path, query, headers, payload, "application/json", false).await?;
        let status = resp.status().as_u16();
        let request_id = resp.headers().get("x-request-id").and_then(|v| v.to_str().ok()).unwrap_or("").to_string();
        let text = match tokio::time::timeout(self.timeout, resp.text()).await {
            Err(_) => {
                return Err(ApiError {
                    url: url.clone(),
                    ..ApiError::local(ErrorKind::Timeout, "timeout", format!("{method_name} {url} timed out reading the response body"))
                })
            }
            Ok(Err(e)) => {
                return Err(ApiError::local(
                    ErrorKind::Connection,
                    "connection_error",
                    format!("{method_name} {url} failed while reading the response: {e}"),
                ))
            }
            Ok(Ok(text)) => text,
        };
        let source = if text.trim().is_empty() { "null" } else { text.as_str() };
        serde_json::from_str::<T>(source).map_err(|e| ApiError {
            status,
            request_id,
            url: url.clone(),
            ..ApiError::local(
                ErrorKind::Decode,
                "invalid_json",
                format!("{method_name} {url} returned {status} with a body that does not decode: {e}"),
            )
        })
    }

    /// Sends a request and returns the streaming body; the timeout covers only the headers.
    pub async fn request_stream<B: Serialize + ?Sized>(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
        headers: &[(&str, String)],
        body: Option<&B>,
        accept: &str,
    ) -> Result<StreamResponse, ApiError> {
        let method_name = method.as_str().to_string();
        let payload = self.encode_body(&method_name, path, body)?;
        let (resp, url) = self.send(method, path, query, headers, payload, accept, true).await?;
        Ok(StreamResponse {
            status: resp.status().as_u16(),
            headers: resp.headers().clone(),
            request_id: resp.headers().get("x-request-id").and_then(|v| v.to_str().ok()).unwrap_or("").to_string(),
            url,
            response: resp,
            idle: self.idle_timeout,
            method: method_name,
        })
    }

    /// Opens a Server-Sent Events stream, resuming after `last_event_id` when given.
    pub async fn request_sse(
        &self,
        method: reqwest::Method,
        path: &str,
        query: &[(&str, String)],
        last_event_id: Option<&str>,
    ) -> Result<SseStream, ApiError> {
        let mut headers: Vec<(&str, String)> = Vec::new();
        if let Some(id) = last_event_id {
            headers.push(("last-event-id", id.to_string()));
        }
        let response = self.request_stream::<()>(method, path, query, &headers, None, "text/event-stream").await?;
        Ok(SseStream { response, buffer: Vec::new(), last_id: last_event_id.map(|s| s.to_string()), done: false })
    }
}

/// Request and response models generated from `components.schemas`.
pub mod models {
    use serde::{Deserialize, Serialize};
    use serde_json::Value;
    use std::collections::BTreeMap;

    /// A union of object shapes: set the fields of exactly one variant.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct AdapterSpec {
        pub kind: AdapterSpecKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub rank: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub alpha: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub merge_on_export: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub num_tokens: Option<i64>,
    }

    /// Allowed values of `AdapterSpecKind` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum AdapterSpecKind {
        /// `"lora"`
        Lora,
        /// `"prefix_kv"`
        PrefixKv,
        /// `"frozen_head"`
        FrozenHead,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for AdapterSpecKind {
        fn default() -> Self {
            Self::Lora
        }
    }

    impl AdapterSpecKind {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Lora => "lora",
                Self::PrefixKv => "prefix_kv",
                Self::FrozenHead => "frozen_head",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for AdapterSpecKind {
        fn from(s: &str) -> Self {
            match s {
                "lora" => Self::Lora,
                "prefix_kv" => Self::PrefixKv,
                "frozen_head" => Self::FrozenHead,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for AdapterSpecKind {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for AdapterSpecKind {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for AdapterSpecKind {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `ApiKey`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ApiKey {
        pub id: String,
        pub workspace_id: String,
        pub name: String,
        pub prefix: String,
        pub scopes: Vec<ApiKeyScope>,
        pub created_at: String,
        #[serde(default)]
        pub revoked_at: Option<String>,
    }

    /// Allowed values of `ApiKeyScope` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ApiKeyScope {
        /// `"admin"`
        Admin,
        /// `"datasets:read"`
        DatasetsRead,
        /// `"datasets:write"`
        DatasetsWrite,
        /// `"runs:read"`
        RunsRead,
        /// `"runs:write"`
        RunsWrite,
        /// `"artifacts:read"`
        ArtifactsRead,
        /// `"artifacts:write"`
        ArtifactsWrite,
        /// `"deployments:write"`
        DeploymentsWrite,
        /// `"feedback:write"`
        FeedbackWrite,
        /// `"env:serve"`
        EnvServe,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for ApiKeyScope {
        fn default() -> Self {
            Self::Admin
        }
    }

    impl ApiKeyScope {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Admin => "admin",
                Self::DatasetsRead => "datasets:read",
                Self::DatasetsWrite => "datasets:write",
                Self::RunsRead => "runs:read",
                Self::RunsWrite => "runs:write",
                Self::ArtifactsRead => "artifacts:read",
                Self::ArtifactsWrite => "artifacts:write",
                Self::DeploymentsWrite => "deployments:write",
                Self::FeedbackWrite => "feedback:write",
                Self::EnvServe => "env:serve",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for ApiKeyScope {
        fn from(s: &str) -> Self {
            match s {
                "admin" => Self::Admin,
                "datasets:read" => Self::DatasetsRead,
                "datasets:write" => Self::DatasetsWrite,
                "runs:read" => Self::RunsRead,
                "runs:write" => Self::RunsWrite,
                "artifacts:read" => Self::ArtifactsRead,
                "artifacts:write" => Self::ArtifactsWrite,
                "deployments:write" => Self::DeploymentsWrite,
                "feedback:write" => Self::FeedbackWrite,
                "env:serve" => Self::EnvServe,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for ApiKeyScope {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for ApiKeyScope {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for ApiKeyScope {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `Artifact`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct Artifact {
        pub id: String,
        pub workspace_id: String,
        pub name: String,
        pub version: String,
        #[serde(default)]
        pub run_id: Option<String>,
        #[serde(default)]
        pub checkpoint_id: Option<String>,
        pub base_model: String,
        pub recipe_kind: RecipeKind,
        #[serde(default)]
        pub format: Option<ArtifactFormat>,
        pub sha256: String,
        pub size_bytes: i64,
        pub manifest: BTreeMap<String, Value>,
        #[serde(default)]
        pub eval_report: Option<EvalReport>,
        pub created_at: String,
    }

    /// Artifact format when this checkpoint is exportable (promotable); null for training state only.
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ArtifactFormat {
        /// `"peft_lora"`
        PeftLora,
        /// `"merged_safetensors"`
        MergedSafetensors,
        /// `"prefix_kv"`
        PrefixKv,
        /// `"cartridge"`
        Cartridge,
        /// `"encoder_safetensors"`
        EncoderSafetensors,
        /// `"router_bundle"`
        RouterBundle,
        /// `"decision_bundle"`
        DecisionBundle,
        /// `"reference"`
        Reference,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for ArtifactFormat {
        fn default() -> Self {
            Self::PeftLora
        }
    }

    impl ArtifactFormat {
        pub fn as_str(&self) -> &str {
            match self {
                Self::PeftLora => "peft_lora",
                Self::MergedSafetensors => "merged_safetensors",
                Self::PrefixKv => "prefix_kv",
                Self::Cartridge => "cartridge",
                Self::EncoderSafetensors => "encoder_safetensors",
                Self::RouterBundle => "router_bundle",
                Self::DecisionBundle => "decision_bundle",
                Self::Reference => "reference",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for ArtifactFormat {
        fn from(s: &str) -> Self {
            match s {
                "peft_lora" => Self::PeftLora,
                "merged_safetensors" => Self::MergedSafetensors,
                "prefix_kv" => Self::PrefixKv,
                "cartridge" => Self::Cartridge,
                "encoder_safetensors" => Self::EncoderSafetensors,
                "router_bundle" => Self::RouterBundle,
                "decision_bundle" => Self::DecisionBundle,
                "reference" => Self::Reference,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for ArtifactFormat {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for ArtifactFormat {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for ArtifactFormat {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Continued training: the artifact whose adapter the run starts from (recipe.model was an artifact reference).
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct BaseArtifact {
        pub id: String,
        pub recipe_kind: RecipeKind,
        pub format: BaseArtifactFormat,
        pub sha256: String,
    }

    /// Allowed values of `BaseArtifactFormat` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum BaseArtifactFormat {
        /// `"peft_lora"`
        PeftLora,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for BaseArtifactFormat {
        fn default() -> Self {
            Self::PeftLora
        }
    }

    impl BaseArtifactFormat {
        pub fn as_str(&self) -> &str {
            match self {
                Self::PeftLora => "peft_lora",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for BaseArtifactFormat {
        fn from(s: &str) -> Self {
            match s {
                "peft_lora" => Self::PeftLora,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for BaseArtifactFormat {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for BaseArtifactFormat {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for BaseArtifactFormat {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `ChatMessage`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ChatMessage {
        pub role: ChatMessageRole,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub content: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub tool_calls: Option<Vec<BTreeMap<String, Value>>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub tool_call_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub train: Option<bool>,
        /// Members not declared in the schema (round-tripped verbatim).
        #[serde(flatten)]
        pub additional_properties: BTreeMap<String, Value>,
    }

    /// Allowed values of `ChatMessageRole` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ChatMessageRole {
        /// `"system"`
        System,
        /// `"user"`
        User,
        /// `"assistant"`
        Assistant,
        /// `"tool"`
        Tool,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for ChatMessageRole {
        fn default() -> Self {
            Self::System
        }
    }

    impl ChatMessageRole {
        pub fn as_str(&self) -> &str {
            match self {
                Self::System => "system",
                Self::User => "user",
                Self::Assistant => "assistant",
                Self::Tool => "tool",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for ChatMessageRole {
        fn from(s: &str) -> Self {
            match s {
                "system" => Self::System,
                "user" => Self::User,
                "assistant" => Self::Assistant,
                "tool" => Self::Tool,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for ChatMessageRole {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for ChatMessageRole {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for ChatMessageRole {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `Checkpoint`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct Checkpoint {
        pub id: String,
        pub workspace_id: String,
        pub run_id: String,
        pub attempt: i64,
        pub step: i64,
        #[serde(default)]
        pub eval_score: Option<f64>,
        #[serde(default)]
        pub format: Option<ArtifactFormat>,
        pub sha256: String,
        pub size_bytes: i64,
        pub metadata: BTreeMap<String, Value>,
        pub best: bool,
        pub r#final: bool,
        #[serde(default)]
        pub expires_at: Option<String>,
        pub created_at: String,
    }

    /// Generated from the OpenAPI schema `CreateApiKeyRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct CreateApiKeyRequest {
        pub name: String,
        pub scopes: Vec<ApiKeyScope>,
    }

    /// Generated from the OpenAPI schema `CreateDatasetRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct CreateDatasetRequest {
        pub name: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub metadata: Option<BTreeMap<String, Value>>,
    }

    /// Generated from the OpenAPI schema `CreateImportRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct CreateImportRequest {
        pub source: ImportSource,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub connector: Option<CreateImportRequestConnector>,
    }

    /// Allowed values of `CreateImportRequestConnector` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum CreateImportRequestConnector {
        /// `"auto"`
        Auto,
        /// `"grad_trajectories"`
        GradTrajectories,
        /// `"openai_chat"`
        OpenaiChat,
        /// `"gradiated"`
        Gradiated,
        /// `"otel"`
        Otel,
        /// `"langfuse"`
        Langfuse,
        /// `"posthog"`
        Posthog,
        /// `"braintrust"`
        Braintrust,
        /// `"langsmith"`
        Langsmith,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for CreateImportRequestConnector {
        fn default() -> Self {
            Self::Auto
        }
    }

    impl CreateImportRequestConnector {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Auto => "auto",
                Self::GradTrajectories => "grad_trajectories",
                Self::OpenaiChat => "openai_chat",
                Self::Gradiated => "gradiated",
                Self::Otel => "otel",
                Self::Langfuse => "langfuse",
                Self::Posthog => "posthog",
                Self::Braintrust => "braintrust",
                Self::Langsmith => "langsmith",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for CreateImportRequestConnector {
        fn from(s: &str) -> Self {
            match s {
                "auto" => Self::Auto,
                "grad_trajectories" => Self::GradTrajectories,
                "openai_chat" => Self::OpenaiChat,
                "gradiated" => Self::Gradiated,
                "otel" => Self::Otel,
                "langfuse" => Self::Langfuse,
                "posthog" => Self::Posthog,
                "braintrust" => Self::Braintrust,
                "langsmith" => Self::Langsmith,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for CreateImportRequestConnector {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for CreateImportRequestConnector {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for CreateImportRequestConnector {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `CreateUploadRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct CreateUploadRequest {
        pub purpose: CreateUploadRequestPurpose,
        pub filename: String,
        pub size_bytes: i64,
        pub sha256: String,
    }

    /// Allowed values of `CreateUploadRequestPurpose` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum CreateUploadRequestPurpose {
        /// `"dataset_import"`
        DatasetImport,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for CreateUploadRequestPurpose {
        fn default() -> Self {
            Self::DatasetImport
        }
    }

    impl CreateUploadRequestPurpose {
        pub fn as_str(&self) -> &str {
            match self {
                Self::DatasetImport => "dataset_import",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for CreateUploadRequestPurpose {
        fn from(s: &str) -> Self {
            match s {
                "dataset_import" => Self::DatasetImport,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for CreateUploadRequestPurpose {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for CreateUploadRequestPurpose {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for CreateUploadRequestPurpose {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `CreatedApiKey`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct CreatedApiKey {
        pub key: ApiKey,
        pub secret: String,
    }

    /// Generated from the OpenAPI schema `Dataset`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
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
    pub struct DatasetRecord {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub schema: Option<DatasetRecordSchema>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub group_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub role: Option<DatasetRecordRole>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub source: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub timestamp: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub messages: Option<Vec<ChatMessage>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub tools: Option<Vec<BTreeMap<String, Value>>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub input: Option<TrajectoryInput>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub output: Option<TrajectoryOutput>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub prompt: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub completion: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub chosen: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub rejected: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub query: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub positive: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub negatives: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub state: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub questions: Option<BTreeMap<String, Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub expected_output: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub scores: Option<BTreeMap<String, f64>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub metrics: Option<BTreeMap<String, f64>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub metadata: Option<BTreeMap<String, Value>>,
    }

    /// Allowed values of `DatasetRecordRole` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum DatasetRecordRole {
        /// `"chosen"`
        Chosen,
        /// `"rejected"`
        Rejected,
        /// `"anchor"`
        Anchor,
        /// `"positive"`
        Positive,
        /// `"negative"`
        Negative,
        /// `"desirable"`
        Desirable,
        /// `"undesirable"`
        Undesirable,
        /// `"rollout"`
        Rollout,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for DatasetRecordRole {
        fn default() -> Self {
            Self::Chosen
        }
    }

    impl DatasetRecordRole {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Chosen => "chosen",
                Self::Rejected => "rejected",
                Self::Anchor => "anchor",
                Self::Positive => "positive",
                Self::Negative => "negative",
                Self::Desirable => "desirable",
                Self::Undesirable => "undesirable",
                Self::Rollout => "rollout",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for DatasetRecordRole {
        fn from(s: &str) -> Self {
            match s {
                "chosen" => Self::Chosen,
                "rejected" => Self::Rejected,
                "anchor" => Self::Anchor,
                "positive" => Self::Positive,
                "negative" => Self::Negative,
                "desirable" => Self::Desirable,
                "undesirable" => Self::Undesirable,
                "rollout" => Self::Rollout,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for DatasetRecordRole {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for DatasetRecordRole {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for DatasetRecordRole {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `DatasetRecordSchema` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum DatasetRecordSchema {
        /// `"grad.trajectory/1"`
        GradTrajectory1,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for DatasetRecordSchema {
        fn default() -> Self {
            Self::GradTrajectory1
        }
    }

    impl DatasetRecordSchema {
        pub fn as_str(&self) -> &str {
            match self {
                Self::GradTrajectory1 => "grad.trajectory/1",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for DatasetRecordSchema {
        fn from(s: &str) -> Self {
            match s {
                "grad.trajectory/1" => Self::GradTrajectory1,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for DatasetRecordSchema {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for DatasetRecordSchema {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for DatasetRecordSchema {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `DatasetRecordsPage`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct DatasetRecordsPage {
        pub dataset: String,
        pub version: i64,
        pub total: i64,
        pub data: Vec<DatasetRecord>,
        /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
        #[serde(default)]
        pub next_cursor: Option<String>,
    }

    /// Generated from the OpenAPI schema `DecisionHeadReport`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct DecisionHeadReport {
        pub r#type: DecisionHeadReportType,
        pub examples: i64,
        #[serde(default)]
        pub accuracy: Option<f64>,
        #[serde(default)]
        pub ece: Option<f64>,
        pub temperature: f64,
        /// Written by: noul heads.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub brier: Option<f64>,
        /// Written by: score heads.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub mae: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub macro_f1: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub per_option: Option<BTreeMap<String, DecisionHeadReportPerOptionValue>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub confusion_matrix: Option<DecisionHeadReportConfusionMatrix>,
        /// Members not declared in the schema (round-tripped verbatim).
        #[serde(flatten)]
        pub additional_properties: BTreeMap<String, Value>,
    }

    /// Generated from the OpenAPI schema `DecisionHeadReportConfusionMatrix`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct DecisionHeadReportConfusionMatrix {
        pub labels: Vec<String>,
        pub matrix: Vec<Vec<i64>>,
    }

    /// Generated from the OpenAPI schema `DecisionHeadReportPerOptionValue`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct DecisionHeadReportPerOptionValue {
        #[serde(default)]
        pub precision: Option<f64>,
        #[serde(default)]
        pub recall: Option<f64>,
        #[serde(default)]
        pub f1: Option<f64>,
        pub support: i64,
    }

    /// Allowed values of `DecisionHeadReportType` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum DecisionHeadReportType {
        /// `"choice"`
        Choice,
        /// `"noul"`
        Noul,
        /// `"score"`
        Score,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for DecisionHeadReportType {
        fn default() -> Self {
            Self::Choice
        }
    }

    impl DecisionHeadReportType {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Choice => "choice",
                Self::Noul => "noul",
                Self::Score => "score",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for DecisionHeadReportType {
        fn from(s: &str) -> Self {
            match s {
                "choice" => Self::Choice,
                "noul" => Self::Noul,
                "score" => Self::Score,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for DecisionHeadReportType {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for DecisionHeadReportType {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for DecisionHeadReportType {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `DeployArtifactRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct DeployArtifactRequest {
        pub artifact: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub fallback: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub explore_rate: Option<f64>,
    }

    /// Generated from the OpenAPI schema `Deployment`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct Deployment {
        pub id: String,
        pub workspace_id: String,
        pub name: String,
        pub model_id: String,
        pub active_artifact_id: String,
        #[serde(default)]
        pub previous_artifact_id: Option<String>,
        #[serde(default)]
        pub fallback_model: Option<String>,
        pub explore_rate: f64,
        pub status: DeploymentStatusType,
        pub created_at: String,
        pub updated_at: String,
    }

    /// Generated from the OpenAPI schema `DeploymentStatus`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct DeploymentStatus {
        pub deployment: Deployment,
        pub feedback_count: i64,
        #[serde(default)]
        pub average_score: Option<f64>,
    }

    /// Allowed values of `DeploymentStatusType` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum DeploymentStatusType {
        /// `"active"`
        Active,
        /// `"disabled"`
        Disabled,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for DeploymentStatusType {
        fn default() -> Self {
            Self::Active
        }
    }

    impl DeploymentStatusType {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Active => "active",
                Self::Disabled => "disabled",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for DeploymentStatusType {
        fn from(s: &str) -> Self {
            match s {
                "active" => Self::Active,
                "disabled" => Self::Disabled,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for DeploymentStatusType {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for DeploymentStatusType {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for DeploymentStatusType {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `EmbedRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EmbedRequest {
        /// Name of a deployed embedding artifact.
        pub model: String,
        pub input: Value,
    }

    /// Generated from the OpenAPI schema `EmbedResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EmbedResponse {
        pub model: String,
        pub data: Vec<EmbedResponseDataItem>,
        pub usage: EmbedResponseUsage,
    }

    /// Generated from the OpenAPI schema `EmbedResponseDataItem`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EmbedResponseDataItem {
        pub index: i64,
        pub embedding: Vec<f64>,
    }

    /// Generated from the OpenAPI schema `EmbedResponseUsage`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EmbedResponseUsage {
        pub prompt_tokens: i64,
        pub total_tokens: i64,
    }

    /// Generated from the OpenAPI schema `EvalModelSummary`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EvalModelSummary {
        pub model: String,
        pub overall: f64,
        pub ci_low: f64,
        pub ci_high: f64,
        pub pass_at_k: BTreeMap<String, f64>,
        #[serde(default)]
        pub vs_baseline: Option<EvalModelSummaryVsBaseline>,
        pub tasks: i64,
        pub errors: i64,
        pub tokens_per_task: f64,
        #[serde(default)]
        pub cost_per_1k_tasks_usd: Option<f64>,
    }

    /// Generated from the OpenAPI schema `EvalModelSummaryVsBaseline`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EvalModelSummaryVsBaseline {
        pub delta: f64,
        pub ci_low: f64,
        pub ci_high: f64,
    }

    /// Generated from the OpenAPI schema `EvalOutput`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EvalOutput {
        pub id: String,
        pub eval_id: String,
        pub task_id: String,
        pub model: String,
        pub sample_index: i64,
        pub input: Vec<ChatMessage>,
        #[serde(default)]
        pub output: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub expected_output: Option<Value>,
        pub record: DatasetRecord,
        pub scores: BTreeMap<String, f64>,
        #[serde(default)]
        pub error: Option<String>,
        pub usage: EvalOutputUsage,
    }

    /// Generated from the OpenAPI schema `EvalOutputUsage`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EvalOutputUsage {
        pub prompt_tokens: i64,
        pub completion_tokens: i64,
    }

    /// Generated from the OpenAPI schema `EvalReport`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EvalReport {
        /// Selection metric: eval_loss (sft, router, decision), preference_accuracy (dpo), eval_kl (cartridge), recall_at_10 (embedding).
        pub metric_name: String,
        pub selected_step: i64,
        #[serde(default)]
        pub best_step: Option<i64>,
        pub final_step: i64,
        pub train_records: i64,
        pub eval_records: i64,
        pub warnings: Vec<String>,
        /// Written by: sft, dpo, router, decision.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub eval_loss: Option<f64>,
        /// Written by: sft.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub eval_token_accuracy: Option<f64>,
        /// Written by: sft.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub trained_token_fraction: Option<f64>,
        /// Written by: sft.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub train_examples: Option<i64>,
        /// Written by: sft, router, decision.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub eval_examples: Option<i64>,
        /// Written by: router, decision.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub selection_examples: Option<i64>,
        /// Written by: sft, dpo.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub truncated: Option<i64>,
        /// Written by: dpo.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub preference_accuracy: Option<f64>,
        /// Written by: dpo.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub reward_margin: Option<f64>,
        /// Written by: dpo.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub beta: Option<f64>,
        /// Written by: dpo, embedding.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub train_pairs: Option<i64>,
        /// Written by: dpo, embedding.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub eval_pairs: Option<i64>,
        /// Written by: dpo, embedding.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub dropped_records: Option<i64>,
        /// Written by: cartridge.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub eval_kl: Option<f64>,
        /// Written by: cartridge.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub no_context_kl: Option<f64>,
        /// Written by: cartridge.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub kl_reduction: Option<f64>,
        /// Written by: cartridge.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub num_tokens: Option<i64>,
        /// Written by: cartridge.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub teacher: Option<String>,
        /// Written by: router.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub candidates: Option<Vec<String>>,
        /// Written by: router.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub fallback_model: Option<String>,
        /// Written by: router.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub fallback_quality: Option<f64>,
        /// Written by: router.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub routes_any_traffic: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub pareto_summary: Option<RouterParetoSummary>,
        /// Written by: decision.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub ece: Option<f64>,
        /// Written by: decision (one entry per question).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub heads: Option<BTreeMap<String, DecisionHeadReport>>,
        /// Written by: embedding.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub recall_at_1: Option<f64>,
        /// Written by: embedding.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub recall_at_5: Option<f64>,
        /// Written by: embedding.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub recall_at_10: Option<f64>,
        /// Written by: embedding.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub mrr: Option<f64>,
        /// Written by: embedding.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub corpus_size: Option<i64>,
        /// Retrieval metrics of the untrained base encoder. Written by: embedding.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub baseline: Option<EvalReportBaseline>,
        /// Members not declared in the schema (round-tripped verbatim).
        #[serde(flatten)]
        pub additional_properties: BTreeMap<String, Value>,
    }

    /// Retrieval metrics of the untrained base encoder. Written by: embedding.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EvalReportBaseline {
        #[serde(default)]
        pub recall_at_1: Option<f64>,
        #[serde(default)]
        pub recall_at_5: Option<f64>,
        #[serde(default)]
        pub recall_at_10: Option<f64>,
        #[serde(default)]
        pub mrr: Option<f64>,
        /// Members not declared in the schema (round-tripped verbatim).
        #[serde(flatten)]
        pub additional_properties: BTreeMap<String, Value>,
    }

    /// Generated from the OpenAPI schema `EvalRubricItem`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EvalRubricItem {
        pub name: String,
        pub kind: EvalRubricItemKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub weight: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub pattern: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub flags: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub validator: Option<EvalRubricItemValidator>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub prompt: Option<String>,
        /// Code scorers always run in the SDK process (`local`); the eval waits in `awaiting_scores` until the SDK posts their scores.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub runtime: Option<EvalRubricItemRuntime>,
    }

    /// Allowed values of `EvalRubricItemKind` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum EvalRubricItemKind {
        /// `"regex"`
        Regex,
        /// `"validator"`
        Validator,
        /// `"code"`
        Code,
        /// `"judge"`
        Judge,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for EvalRubricItemKind {
        fn default() -> Self {
            Self::Regex
        }
    }

    impl EvalRubricItemKind {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Regex => "regex",
                Self::Validator => "validator",
                Self::Code => "code",
                Self::Judge => "judge",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for EvalRubricItemKind {
        fn from(s: &str) -> Self {
            match s {
                "regex" => Self::Regex,
                "validator" => Self::Validator,
                "code" => Self::Code,
                "judge" => Self::Judge,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for EvalRubricItemKind {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for EvalRubricItemKind {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for EvalRubricItemKind {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Code scorers always run in the SDK process (`local`); the eval waits in `awaiting_scores` until the SDK posts their scores.
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum EvalRubricItemRuntime {
        /// `"local"`
        Local,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for EvalRubricItemRuntime {
        fn default() -> Self {
            Self::Local
        }
    }

    impl EvalRubricItemRuntime {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Local => "local",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for EvalRubricItemRuntime {
        fn from(s: &str) -> Self {
            match s {
                "local" => Self::Local,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for EvalRubricItemRuntime {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for EvalRubricItemRuntime {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for EvalRubricItemRuntime {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `EvalRubricItemValidator` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum EvalRubricItemValidator {
        /// `"json"`
        Json,
        /// `"non_empty"`
        NonEmpty,
        /// `"exact_match"`
        ExactMatch,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for EvalRubricItemValidator {
        fn default() -> Self {
            Self::Json
        }
    }

    impl EvalRubricItemValidator {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Json => "json",
                Self::NonEmpty => "non_empty",
                Self::ExactMatch => "exact_match",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for EvalRubricItemValidator {
        fn from(s: &str) -> Self {
            match s {
                "json" => Self::Json,
                "non_empty" => Self::NonEmpty,
                "exact_match" => Self::ExactMatch,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for EvalRubricItemValidator {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for EvalRubricItemValidator {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for EvalRubricItemValidator {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `EvalRun`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EvalRun {
        pub id: String,
        pub workspace_id: String,
        pub name: String,
        pub status: EvalStatus,
        pub models: Vec<String>,
        #[serde(default)]
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
        #[serde(default)]
        pub error: Option<String>,
        pub created_at: String,
        pub updated_at: String,
        #[serde(default)]
        pub completed_at: Option<String>,
    }

    /// Generated from the OpenAPI schema `EvalRunProgress`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EvalRunProgress {
        pub total_outputs: i64,
        pub generated: i64,
        pub pending_local_scores: i64,
    }

    /// Generated from the OpenAPI schema `EvalRunTaskSource`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EvalRunTaskSource {
        pub kind: EvalRunTaskSourceKind,
        pub dataset: String,
        pub version: i64,
    }

    /// Allowed values of `EvalRunTaskSourceKind` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum EvalRunTaskSourceKind {
        /// `"dataset"`
        Dataset,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for EvalRunTaskSourceKind {
        fn default() -> Self {
            Self::Dataset
        }
    }

    impl EvalRunTaskSourceKind {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Dataset => "dataset",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for EvalRunTaskSourceKind {
        fn from(s: &str) -> Self {
            match s {
                "dataset" => Self::Dataset,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for EvalRunTaskSourceKind {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for EvalRunTaskSourceKind {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for EvalRunTaskSourceKind {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `EvalStatus` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum EvalStatus {
        /// `"queued"`
        Queued,
        /// `"running"`
        Running,
        /// `"awaiting_scores"`
        AwaitingScores,
        /// `"completed"`
        Completed,
        /// `"failed"`
        Failed,
        /// `"cancelled"`
        Cancelled,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for EvalStatus {
        fn default() -> Self {
            Self::Queued
        }
    }

    impl EvalStatus {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Queued => "queued",
                Self::Running => "running",
                Self::AwaitingScores => "awaiting_scores",
                Self::Completed => "completed",
                Self::Failed => "failed",
                Self::Cancelled => "cancelled",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for EvalStatus {
        fn from(s: &str) -> Self {
            match s {
                "queued" => Self::Queued,
                "running" => Self::Running,
                "awaiting_scores" => Self::AwaitingScores,
                "completed" => Self::Completed,
                "failed" => Self::Failed,
                "cancelled" => Self::Cancelled,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for EvalStatus {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for EvalStatus {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for EvalStatus {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `EvalTaskOutcome`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct EvalTaskOutcome {
        pub task_id: String,
        pub model: String,
        pub score: f64,
        pub passed: bool,
        pub sample_scores: Vec<f64>,
        #[serde(default)]
        pub judge_model: Option<String>,
        pub record: DatasetRecord,
    }

    /// Generated from the OpenAPI schema `FeedbackEventInput`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct FeedbackEventInput {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub inference_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub session_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub deployment_name: Option<String>,
        pub idempotency_key: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub score: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub expected_output: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub metrics: Option<BTreeMap<String, f64>>,
    }

    /// Generated from the OpenAPI schema `FeedbackRecord`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct FeedbackRecord {
        pub id: String,
        pub workspace_id: String,
        #[serde(default)]
        pub inference_id: Option<String>,
        #[serde(default)]
        pub session_id: Option<String>,
        #[serde(default)]
        pub deployment_name: Option<String>,
        pub idempotency_key: String,
        #[serde(default)]
        pub score: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub expected_output: Option<Value>,
        pub metrics: BTreeMap<String, f64>,
        pub created_at: String,
    }

    /// Generated from the OpenAPI schema `HfColumnMapping`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct HfColumnMapping {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub messages: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub prompt: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub completion: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub chosen: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub rejected: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub answer: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub query: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub positive: Option<String>,
    }

    /// Generated from the OpenAPI schema `ImportJob`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
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
        #[serde(default)]
        pub dataset_version: Option<i64>,
        #[serde(default)]
        pub error: Option<String>,
        pub created_at: String,
        pub updated_at: String,
    }

    /// Allowed values of `ImportJobConnector` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ImportJobConnector {
        /// `"auto"`
        Auto,
        /// `"grad_trajectories"`
        GradTrajectories,
        /// `"openai_chat"`
        OpenaiChat,
        /// `"gradiated"`
        Gradiated,
        /// `"otel"`
        Otel,
        /// `"langfuse"`
        Langfuse,
        /// `"posthog"`
        Posthog,
        /// `"braintrust"`
        Braintrust,
        /// `"langsmith"`
        Langsmith,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for ImportJobConnector {
        fn default() -> Self {
            Self::Auto
        }
    }

    impl ImportJobConnector {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Auto => "auto",
                Self::GradTrajectories => "grad_trajectories",
                Self::OpenaiChat => "openai_chat",
                Self::Gradiated => "gradiated",
                Self::Otel => "otel",
                Self::Langfuse => "langfuse",
                Self::Posthog => "posthog",
                Self::Braintrust => "braintrust",
                Self::Langsmith => "langsmith",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for ImportJobConnector {
        fn from(s: &str) -> Self {
            match s {
                "auto" => Self::Auto,
                "grad_trajectories" => Self::GradTrajectories,
                "openai_chat" => Self::OpenaiChat,
                "gradiated" => Self::Gradiated,
                "otel" => Self::Otel,
                "langfuse" => Self::Langfuse,
                "posthog" => Self::Posthog,
                "braintrust" => Self::Braintrust,
                "langsmith" => Self::Langsmith,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for ImportJobConnector {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for ImportJobConnector {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for ImportJobConnector {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// A union of object shapes: set the fields of exactly one variant.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ImportSource {
        pub kind: ImportSourceKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub upload_id: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub format: Option<ImportSourceFormat>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub repo: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub split: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub config: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub revision: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub columns: Option<HfColumnMapping>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub limit: Option<i64>,
    }

    /// Allowed values of `ImportSourceFormat` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ImportSourceFormat {
        /// `"auto"`
        Auto,
        /// `"jsonl"`
        Jsonl,
        /// `"json"`
        Json,
        /// `"parquet"`
        Parquet,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for ImportSourceFormat {
        fn default() -> Self {
            Self::Auto
        }
    }

    impl ImportSourceFormat {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Auto => "auto",
                Self::Jsonl => "jsonl",
                Self::Json => "json",
                Self::Parquet => "parquet",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for ImportSourceFormat {
        fn from(s: &str) -> Self {
            match s {
                "auto" => Self::Auto,
                "jsonl" => Self::Jsonl,
                "json" => Self::Json,
                "parquet" => Self::Parquet,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for ImportSourceFormat {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for ImportSourceFormat {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for ImportSourceFormat {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `ImportSourceKind` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ImportSourceKind {
        /// `"upload"`
        Upload,
        /// `"hf"`
        Hf,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for ImportSourceKind {
        fn default() -> Self {
            Self::Upload
        }
    }

    impl ImportSourceKind {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Upload => "upload",
                Self::Hf => "hf",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for ImportSourceKind {
        fn from(s: &str) -> Self {
            match s {
                "upload" => Self::Upload,
                "hf" => Self::Hf,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for ImportSourceKind {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for ImportSourceKind {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for ImportSourceKind {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `ImportStatus` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ImportStatus {
        /// `"queued"`
        Queued,
        /// `"running"`
        Running,
        /// `"completed"`
        Completed,
        /// `"failed"`
        Failed,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for ImportStatus {
        fn default() -> Self {
            Self::Queued
        }
    }

    impl ImportStatus {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Queued => "queued",
                Self::Running => "running",
                Self::Completed => "completed",
                Self::Failed => "failed",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for ImportStatus {
        fn from(s: &str) -> Self {
            match s {
                "queued" => Self::Queued,
                "running" => Self::Running,
                "completed" => Self::Completed,
                "failed" => Self::Failed,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for ImportStatus {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for ImportStatus {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for ImportStatus {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Query and header parameters of `list_api_keys`.
    #[derive(Debug, Clone, PartialEq, Default)]
    pub struct ListApiKeysParams {
        /// Page size (default 50). Values above 200 are clamped to 200.
        pub limit: Option<i64>,
        pub cursor: Option<String>,
    }

    /// Generated from the OpenAPI schema `ListApiKeysResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ListApiKeysResponse {
        pub data: Vec<ApiKey>,
        /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
        #[serde(default)]
        pub next_cursor: Option<String>,
    }

    /// Query and header parameters of `list_artifacts`.
    #[derive(Debug, Clone, PartialEq, Default)]
    pub struct ListArtifactsParams {
        /// Page size (default 50). Values above 200 are clamped to 200.
        pub limit: Option<i64>,
        pub cursor: Option<String>,
        pub name: Option<String>,
    }

    /// Generated from the OpenAPI schema `ListArtifactsResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ListArtifactsResponse {
        pub data: Vec<Artifact>,
        /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
        #[serde(default)]
        pub next_cursor: Option<String>,
    }

    /// Query and header parameters of `list_dataset_records`.
    #[derive(Debug, Clone, PartialEq, Default)]
    pub struct ListDatasetRecordsParams {
        pub version: Option<i64>,
        /// Page size (default 100). Values above 1000 are clamped to 1000.
        pub limit: Option<i64>,
        pub cursor: Option<String>,
    }

    /// Query and header parameters of `list_datasets`.
    #[derive(Debug, Clone, PartialEq, Default)]
    pub struct ListDatasetsParams {
        /// Page size (default 50). Values above 200 are clamped to 200.
        pub limit: Option<i64>,
        pub cursor: Option<String>,
    }

    /// Generated from the OpenAPI schema `ListDatasetsResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ListDatasetsResponse {
        pub data: Vec<Dataset>,
        /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
        #[serde(default)]
        pub next_cursor: Option<String>,
    }

    /// Query and header parameters of `list_deployments`.
    #[derive(Debug, Clone, PartialEq, Default)]
    pub struct ListDeploymentsParams {
        /// Page size (default 50). Values above 200 are clamped to 200.
        pub limit: Option<i64>,
        pub cursor: Option<String>,
    }

    /// Generated from the OpenAPI schema `ListDeploymentsResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ListDeploymentsResponse {
        pub data: Vec<Deployment>,
        /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
        #[serde(default)]
        pub next_cursor: Option<String>,
    }

    /// Query and header parameters of `list_eval_failures`.
    #[derive(Debug, Clone, PartialEq, Default)]
    pub struct ListEvalFailuresParams {
        /// Page size (default 50). Values above 200 are clamped to 200.
        pub limit: Option<i64>,
        pub cursor: Option<String>,
        pub model: Option<String>,
        pub threshold: Option<f64>,
    }

    /// Generated from the OpenAPI schema `ListEvalFailuresResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ListEvalFailuresResponse {
        pub eval_id: String,
        pub data: Vec<EvalTaskOutcome>,
        /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
        #[serde(default)]
        pub next_cursor: Option<String>,
    }

    /// Query and header parameters of `list_eval_outputs`.
    #[derive(Debug, Clone, PartialEq, Default)]
    pub struct ListEvalOutputsParams {
        /// Page size (default 50). Values above 200 are clamped to 200.
        pub limit: Option<i64>,
        pub cursor: Option<String>,
        pub model: Option<String>,
        pub missing_scorer: Option<String>,
    }

    /// Generated from the OpenAPI schema `ListEvalOutputsResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ListEvalOutputsResponse {
        pub data: Vec<EvalOutput>,
        /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
        #[serde(default)]
        pub next_cursor: Option<String>,
    }

    /// Query and header parameters of `list_eval_results`.
    #[derive(Debug, Clone, PartialEq, Default)]
    pub struct ListEvalResultsParams {
        /// Page size (default 50). Values above 200 are clamped to 200.
        pub limit: Option<i64>,
        pub cursor: Option<String>,
        pub model: Option<String>,
    }

    /// Generated from the OpenAPI schema `ListEvalResultsResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ListEvalResultsResponse {
        pub data: Vec<EvalTaskOutcome>,
        /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
        #[serde(default)]
        pub next_cursor: Option<String>,
    }

    /// Query and header parameters of `list_evals`.
    #[derive(Debug, Clone, PartialEq, Default)]
    pub struct ListEvalsParams {
        /// Page size (default 50). Values above 200 are clamped to 200.
        pub limit: Option<i64>,
        pub cursor: Option<String>,
    }

    /// Generated from the OpenAPI schema `ListEvalsResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ListEvalsResponse {
        pub data: Vec<EvalRun>,
        /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
        #[serde(default)]
        pub next_cursor: Option<String>,
    }

    /// Query and header parameters of `list_imports`.
    #[derive(Debug, Clone, PartialEq, Default)]
    pub struct ListImportsParams {
        /// Page size (default 50). Values above 200 are clamped to 200.
        pub limit: Option<i64>,
        pub cursor: Option<String>,
    }

    /// Generated from the OpenAPI schema `ListImportsResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ListImportsResponse {
        pub data: Vec<ImportJob>,
        /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
        #[serde(default)]
        pub next_cursor: Option<String>,
    }

    /// Generated from the OpenAPI schema `ListModelsResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ListModelsResponse {
        pub data: Vec<TrainableModel>,
    }

    /// Query and header parameters of `list_run_checkpoints`.
    #[derive(Debug, Clone, PartialEq, Default)]
    pub struct ListRunCheckpointsParams {
        /// Page size (default 50). Values above 200 are clamped to 200.
        pub limit: Option<i64>,
        pub cursor: Option<String>,
    }

    /// Generated from the OpenAPI schema `ListRunCheckpointsResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ListRunCheckpointsResponse {
        pub data: Vec<Checkpoint>,
        /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
        #[serde(default)]
        pub next_cursor: Option<String>,
    }

    /// Query and header parameters of `list_run_metrics`.
    #[derive(Debug, Clone, PartialEq, Default)]
    pub struct ListRunMetricsParams {
        pub cursor: Option<String>,
        pub after_step: Option<i64>,
        /// Page size (default 1000). Values above 5000 are clamped to 5000.
        pub limit: Option<i64>,
    }

    /// Query and header parameters of `list_runs`.
    #[derive(Debug, Clone, PartialEq, Default)]
    pub struct ListRunsParams {
        /// Page size (default 50). Values above 200 are clamped to 200.
        pub limit: Option<i64>,
        pub cursor: Option<String>,
    }

    /// Generated from the OpenAPI schema `ListRunsResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ListRunsResponse {
        pub data: Vec<Run>,
        /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
        #[serde(default)]
        pub next_cursor: Option<String>,
    }

    /// A union of object shapes: set the fields of exactly one variant.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct LossSpec {
        pub kind: LossSpecKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub reduction: Option<LossSpecReduction>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub beta: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub temp: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub top_k: Option<i64>,
    }

    /// Allowed values of `LossSpecKind` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum LossSpecKind {
        /// `"cross_entropy"`
        CrossEntropy,
        /// `"dpo"`
        Dpo,
        /// `"infonce"`
        Infonce,
        /// `"top_k_kl_distill"`
        TopKKlDistill,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for LossSpecKind {
        fn default() -> Self {
            Self::CrossEntropy
        }
    }

    impl LossSpecKind {
        pub fn as_str(&self) -> &str {
            match self {
                Self::CrossEntropy => "cross_entropy",
                Self::Dpo => "dpo",
                Self::Infonce => "infonce",
                Self::TopKKlDistill => "top_k_kl_distill",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for LossSpecKind {
        fn from(s: &str) -> Self {
            match s {
                "cross_entropy" => Self::CrossEntropy,
                "dpo" => Self::Dpo,
                "infonce" => Self::Infonce,
                "top_k_kl_distill" => Self::TopKKlDistill,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for LossSpecKind {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for LossSpecKind {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for LossSpecKind {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `LossSpecReduction` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum LossSpecReduction {
        /// `"per_example"`
        PerExample,
        /// `"per_token"`
        PerToken,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for LossSpecReduction {
        fn default() -> Self {
            Self::PerExample
        }
    }

    impl LossSpecReduction {
        pub fn as_str(&self) -> &str {
            match self {
                Self::PerExample => "per_example",
                Self::PerToken => "per_token",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for LossSpecReduction {
        fn from(s: &str) -> Self {
            match s {
                "per_example" => Self::PerExample,
                "per_token" => Self::PerToken,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for LossSpecReduction {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for LossSpecReduction {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for LossSpecReduction {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `MetricPoint`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct MetricPoint {
        pub seq: i64,
        pub attempt: i64,
        pub step: i64,
        pub loss: f64,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub eval_loss: Option<f64>,
        /// Held-out metrics of an eval step by name (including the recipe's selection metric, eval_report.metric_name); absent on steps without an eval.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub eval_metrics: Option<BTreeMap<String, f64>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub grad_norm: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub lr: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
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
    pub struct MetricsPage {
        pub run_id: String,
        pub status: RunStatus,
        pub data: Vec<MetricPoint>,
        /// Pass back as `cursor` for the next page; null on the last page (every list endpoint).
        #[serde(default)]
        pub next_cursor: Option<String>,
        /// Cursor after the newest point returned so far; pass it back as `cursor` to poll for points written later (tailing a running run).
        pub tail_cursor: String,
    }

    /// Generated from the OpenAPI schema `OptimizerSpec`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct OptimizerSpec {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub kind: Option<OptimizerSpecKind>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub betas: Option<Vec<Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub weight_decay: Option<f64>,
        /// Max global gradient norm; 0 disables clipping.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub grad_clip: Option<f64>,
    }

    /// Allowed values of `OptimizerSpecKind` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum OptimizerSpecKind {
        /// `"adamw"`
        Adamw,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for OptimizerSpecKind {
        fn default() -> Self {
            Self::Adamw
        }
    }

    impl OptimizerSpecKind {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Adamw => "adamw",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for OptimizerSpecKind {
        fn from(s: &str) -> Self {
            match s {
                "adamw" => Self::Adamw,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for OptimizerSpecKind {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for OptimizerSpecKind {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for OptimizerSpecKind {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `PlanEvalRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct PlanEvalRequest {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub name: Option<String>,
        pub models: Vec<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub baseline: Option<String>,
        pub dataset: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub dataset_version: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub rubric: Option<Vec<EvalRubricItem>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub samples: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub temperature: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub max_tokens: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub limit: Option<i64>,
        /// Defaults to 1.0 when every rubric item is binary (regex/validator) and 0.5 otherwise.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub pass_threshold: Option<f64>,
    }

    /// Generated from the OpenAPI schema `PlanEvalResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
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

    /// Allowed values of `PlanEvalResponseTaskSourceKind` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum PlanEvalResponseTaskSourceKind {
        /// `"dataset"`
        Dataset,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for PlanEvalResponseTaskSourceKind {
        fn default() -> Self {
            Self::Dataset
        }
    }

    impl PlanEvalResponseTaskSourceKind {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Dataset => "dataset",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for PlanEvalResponseTaskSourceKind {
        fn from(s: &str) -> Self {
            match s {
                "dataset" => Self::Dataset,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for PlanEvalResponseTaskSourceKind {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for PlanEvalResponseTaskSourceKind {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for PlanEvalResponseTaskSourceKind {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `PlanRunRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct PlanRunRequest {
        pub dataset: String,
        pub name: String,
        pub recipe: RecipeSpec,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub split: Option<SplitSpec>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub max_cost_usd: Option<f64>,
    }

    /// Generated from the OpenAPI schema `PlanRunResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
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
        #[serde(default)]
        pub labeling: Option<PlanRunResponseLabeling>,
        pub warnings: Vec<String>,
    }

    /// Router runs with a Judge/validator rubric: the labeling eval that replays prompts against the candidates (billed as an eval, included in estimated_cost_usd).
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct PlanRunResponseLabeling {
        pub estimated_model_calls: i64,
        pub estimated_judge_calls: i64,
        pub estimated_cost_usd: f64,
    }

    /// Generated from the OpenAPI schema `PoolingSpec`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct PoolingSpec {
        pub kind: PoolingSpecKind,
    }

    /// Allowed values of `PoolingSpecKind` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum PoolingSpecKind {
        /// `"mean"`
        Mean,
        /// `"cls"`
        Cls,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for PoolingSpecKind {
        fn default() -> Self {
            Self::Mean
        }
    }

    impl PoolingSpecKind {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Mean => "mean",
                Self::Cls => "cls",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for PoolingSpecKind {
        fn from(s: &str) -> Self {
            match s {
                "mean" => Self::Mean,
                "cls" => Self::Cls,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for PoolingSpecKind {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for PoolingSpecKind {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for PoolingSpecKind {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `PostEvalScoresRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct PostEvalScoresRequest {
        pub scores: Vec<PostEvalScoresRequestScoresItem>,
    }

    /// Generated from the OpenAPI schema `PostEvalScoresRequestScoresItem`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct PostEvalScoresRequestScoresItem {
        pub output_id: String,
        pub scorer: String,
        pub score: f64,
    }

    /// Generated from the OpenAPI schema `PostEvalScoresResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct PostEvalScoresResponse {
        pub accepted: i64,
        pub status: EvalStatus,
        pub pending_local_scores: i64,
    }

    /// Generated from the OpenAPI schema `PromoteCheckpointRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct PromoteCheckpointRequest {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub name: Option<String>,
    }

    /// Generated from the OpenAPI schema `PushDatasetRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct PushDatasetRequest {
        pub records: Vec<DatasetRecord>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub metadata: Option<BTreeMap<String, Value>>,
    }

    /// Allowed values of `RecipeKind` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum RecipeKind {
        /// `"sft"`
        Sft,
        /// `"dpo"`
        Dpo,
        /// `"router"`
        Router,
        /// `"decision"`
        Decision,
        /// `"cartridge"`
        Cartridge,
        /// `"embedding"`
        Embedding,
        /// `"distill"`
        Distill,
        /// `"reward"`
        Reward,
        /// `"grpo"`
        Grpo,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for RecipeKind {
        fn default() -> Self {
            Self::Sft
        }
    }

    impl RecipeKind {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Sft => "sft",
                Self::Dpo => "dpo",
                Self::Router => "router",
                Self::Decision => "decision",
                Self::Cartridge => "cartridge",
                Self::Embedding => "embedding",
                Self::Distill => "distill",
                Self::Reward => "reward",
                Self::Grpo => "grpo",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for RecipeKind {
        fn from(s: &str) -> Self {
            match s {
                "sft" => Self::Sft,
                "dpo" => Self::Dpo,
                "router" => Self::Router,
                "decision" => Self::Decision,
                "cartridge" => Self::Cartridge,
                "embedding" => Self::Embedding,
                "distill" => Self::Distill,
                "reward" => Self::Reward,
                "grpo" => Self::Grpo,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for RecipeKind {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for RecipeKind {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for RecipeKind {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `RecipeSpec`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct RecipeSpec {
        pub kind: RecipeKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub adapter: Option<AdapterSpec>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub lr: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub lr_scale: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub batch_size: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub epochs: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub schedule: Option<RecipeSpecSchedule>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub warmup: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub train_on: Option<RecipeSpecTrainOn>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub thinking: Option<RecipeSpecThinking>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub preserve_thinking: Option<bool>,
        /// Default per_example.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub reduction: Option<RecipeSpecReduction>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub select: Option<RecipeSpecSelect>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub checkpoint_ttl_days: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub beta: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub models: Option<Vec<String>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub max_quality_drop: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub context_text: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub context_uri: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub num_tokens: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub temp: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub teacher: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub env_name: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub group_size: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub optimizer: Option<OptimizerSpec>,
        /// Optimizer steps between held-out evaluations; auto = every 10% of steps (the checkpoint interval).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub eval_every: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub loss: Option<LossSpec>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub pool: Option<PoolingSpec>,
        /// RouterRecipe: a score name on your records (scores[rubric]), or Judge/validator items: the server then replays each prompt against recipe.models and scores the answers in a labeling eval before training.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub rubric: Option<Value>,
        /// RouterRecipe: USD per request for each candidate; overrides metrics.cost_usd on your records.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub pricing: Option<BTreeMap<String, f64>>,
        /// RouterRecipe: the candidate that gets every request the router does not offload (default: the best-scoring candidate).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub fallback: Option<String>,
        /// CartridgeRecipe: teacher answer length per prompt during distillation (default 256).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub max_new_tokens: Option<i64>,
        /// CartridgeRecipe: a reserved token that marks where the cartridge goes (default: the first reserved token that tokenizes atomically).
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub slot_token: Option<String>,
    }

    /// Default per_example.
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum RecipeSpecReduction {
        /// `"per_example"`
        PerExample,
        /// `"per_token"`
        PerToken,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for RecipeSpecReduction {
        fn default() -> Self {
            Self::PerExample
        }
    }

    impl RecipeSpecReduction {
        pub fn as_str(&self) -> &str {
            match self {
                Self::PerExample => "per_example",
                Self::PerToken => "per_token",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for RecipeSpecReduction {
        fn from(s: &str) -> Self {
            match s {
                "per_example" => Self::PerExample,
                "per_token" => Self::PerToken,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for RecipeSpecReduction {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for RecipeSpecReduction {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for RecipeSpecReduction {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `RecipeSpecSchedule` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum RecipeSpecSchedule {
        /// `"linear"`
        Linear,
        /// `"cosine"`
        Cosine,
        /// `"constant"`
        Constant,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for RecipeSpecSchedule {
        fn default() -> Self {
            Self::Linear
        }
    }

    impl RecipeSpecSchedule {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Linear => "linear",
                Self::Cosine => "cosine",
                Self::Constant => "constant",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for RecipeSpecSchedule {
        fn from(s: &str) -> Self {
            match s {
                "linear" => Self::Linear,
                "cosine" => Self::Cosine,
                "constant" => Self::Constant,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for RecipeSpecSchedule {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for RecipeSpecSchedule {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for RecipeSpecSchedule {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `RecipeSpecSelect` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum RecipeSpecSelect {
        /// `"best"`
        Best,
        /// `"last"`
        Last,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for RecipeSpecSelect {
        fn default() -> Self {
            Self::Best
        }
    }

    impl RecipeSpecSelect {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Best => "best",
                Self::Last => "last",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for RecipeSpecSelect {
        fn from(s: &str) -> Self {
            match s {
                "best" => Self::Best,
                "last" => Self::Last,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for RecipeSpecSelect {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for RecipeSpecSelect {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for RecipeSpecSelect {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `RecipeSpecThinking` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum RecipeSpecThinking {
        /// `"auto"`
        Auto,
        /// `"on"`
        On,
        /// `"off"`
        Off,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for RecipeSpecThinking {
        fn default() -> Self {
            Self::Auto
        }
    }

    impl RecipeSpecThinking {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Auto => "auto",
                Self::On => "on",
                Self::Off => "off",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for RecipeSpecThinking {
        fn from(s: &str) -> Self {
            match s {
                "auto" => Self::Auto,
                "on" => Self::On,
                "off" => Self::Off,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for RecipeSpecThinking {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for RecipeSpecThinking {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for RecipeSpecThinking {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `RecipeSpecTrainOn` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum RecipeSpecTrainOn {
        /// `"last"`
        Last,
        /// `"all_assistant"`
        AllAssistant,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for RecipeSpecTrainOn {
        fn default() -> Self {
            Self::Last
        }
    }

    impl RecipeSpecTrainOn {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Last => "last",
                Self::AllAssistant => "all_assistant",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for RecipeSpecTrainOn {
        fn from(s: &str) -> Self {
            match s {
                "last" => Self::Last,
                "all_assistant" => Self::AllAssistant,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for RecipeSpecTrainOn {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for RecipeSpecTrainOn {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for RecipeSpecTrainOn {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `RecordFeedbackRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct RecordFeedbackRequest {
        pub events: Vec<FeedbackEventInput>,
    }

    /// Generated from the OpenAPI schema `RecordFeedbackResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct RecordFeedbackResponse {
        pub accepted: i64,
        pub deduplicated: i64,
        pub records: Vec<FeedbackRecord>,
    }

    /// Generated from the OpenAPI schema `RenderDatasetRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct RenderDatasetRequest {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub train_on: Option<RenderDatasetRequestTrainOn>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub thinking: Option<RenderDatasetRequestThinking>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub preserve_thinking: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub limit: Option<i64>,
    }

    /// Allowed values of `RenderDatasetRequestThinking` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum RenderDatasetRequestThinking {
        /// `"auto"`
        Auto,
        /// `"on"`
        On,
        /// `"off"`
        Off,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for RenderDatasetRequestThinking {
        fn default() -> Self {
            Self::Auto
        }
    }

    impl RenderDatasetRequestThinking {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Auto => "auto",
                Self::On => "on",
                Self::Off => "off",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for RenderDatasetRequestThinking {
        fn from(s: &str) -> Self {
            match s {
                "auto" => Self::Auto,
                "on" => Self::On,
                "off" => Self::Off,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for RenderDatasetRequestThinking {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for RenderDatasetRequestThinking {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for RenderDatasetRequestThinking {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `RenderDatasetRequestTrainOn` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum RenderDatasetRequestTrainOn {
        /// `"last"`
        Last,
        /// `"all_assistant"`
        AllAssistant,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for RenderDatasetRequestTrainOn {
        fn default() -> Self {
            Self::Last
        }
    }

    impl RenderDatasetRequestTrainOn {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Last => "last",
                Self::AllAssistant => "all_assistant",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for RenderDatasetRequestTrainOn {
        fn from(s: &str) -> Self {
            match s {
                "last" => Self::Last,
                "all_assistant" => Self::AllAssistant,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for RenderDatasetRequestTrainOn {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for RenderDatasetRequestTrainOn {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for RenderDatasetRequestTrainOn {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `RenderDatasetResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
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
    pub struct RenderDatasetResponseExamplesItemSpansItem {
        pub text: String,
        pub trained: bool,
        pub tokens: i64,
    }

    /// Token counts (total, trained and per span) are estimates (about 4 characters per token); the trainer tokenizes with the model's pinned tokenizer, and the run's metrics report the exact tokens.
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum RenderDatasetResponseTokenCounts {
        /// `"estimated"`
        Estimated,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for RenderDatasetResponseTokenCounts {
        fn default() -> Self {
            Self::Estimated
        }
    }

    impl RenderDatasetResponseTokenCounts {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Estimated => "estimated",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for RenderDatasetResponseTokenCounts {
        fn from(s: &str) -> Self {
            match s {
                "estimated" => Self::Estimated,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for RenderDatasetResponseTokenCounts {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for RenderDatasetResponseTokenCounts {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for RenderDatasetResponseTokenCounts {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `ResolvedRunConfig`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
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
        #[serde(default)]
        pub label_eval_id: Option<String>,
        #[serde(default)]
        pub base_artifact: Option<BaseArtifact>,
        pub recipe_params: BTreeMap<String, Value>,
    }

    /// A union of object shapes: set the fields of exactly one variant.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ResolvedRunConfigAdapter {
        pub kind: ResolvedRunConfigAdapterKind,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub rank: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub alpha: Option<i64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub merge_on_export: Option<bool>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub num_tokens: Option<i64>,
    }

    /// Allowed values of `ResolvedRunConfigAdapterKind` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ResolvedRunConfigAdapterKind {
        /// `"lora"`
        Lora,
        /// `"prefix_kv"`
        PrefixKv,
        /// `"frozen_head"`
        FrozenHead,
        /// `"encoder_full"`
        EncoderFull,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for ResolvedRunConfigAdapterKind {
        fn default() -> Self {
            Self::Lora
        }
    }

    impl ResolvedRunConfigAdapterKind {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Lora => "lora",
                Self::PrefixKv => "prefix_kv",
                Self::FrozenHead => "frozen_head",
                Self::EncoderFull => "encoder_full",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for ResolvedRunConfigAdapterKind {
        fn from(s: &str) -> Self {
            match s {
                "lora" => Self::Lora,
                "prefix_kv" => Self::PrefixKv,
                "frozen_head" => Self::FrozenHead,
                "encoder_full" => Self::EncoderFull,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for ResolvedRunConfigAdapterKind {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for ResolvedRunConfigAdapterKind {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for ResolvedRunConfigAdapterKind {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `ResolvedRunConfigReduction` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ResolvedRunConfigReduction {
        /// `"per_example"`
        PerExample,
        /// `"per_token"`
        PerToken,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for ResolvedRunConfigReduction {
        fn default() -> Self {
            Self::PerExample
        }
    }

    impl ResolvedRunConfigReduction {
        pub fn as_str(&self) -> &str {
            match self {
                Self::PerExample => "per_example",
                Self::PerToken => "per_token",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for ResolvedRunConfigReduction {
        fn from(s: &str) -> Self {
            match s {
                "per_example" => Self::PerExample,
                "per_token" => Self::PerToken,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for ResolvedRunConfigReduction {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for ResolvedRunConfigReduction {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for ResolvedRunConfigReduction {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `ResolvedRunConfigSchedule` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ResolvedRunConfigSchedule {
        /// `"linear"`
        Linear,
        /// `"cosine"`
        Cosine,
        /// `"constant"`
        Constant,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for ResolvedRunConfigSchedule {
        fn default() -> Self {
            Self::Linear
        }
    }

    impl ResolvedRunConfigSchedule {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Linear => "linear",
                Self::Cosine => "cosine",
                Self::Constant => "constant",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for ResolvedRunConfigSchedule {
        fn from(s: &str) -> Self {
            match s {
                "linear" => Self::Linear,
                "cosine" => Self::Cosine,
                "constant" => Self::Constant,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for ResolvedRunConfigSchedule {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for ResolvedRunConfigSchedule {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for ResolvedRunConfigSchedule {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `ResolvedRunConfigSelect` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ResolvedRunConfigSelect {
        /// `"best"`
        Best,
        /// `"last"`
        Last,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for ResolvedRunConfigSelect {
        fn default() -> Self {
            Self::Best
        }
    }

    impl ResolvedRunConfigSelect {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Best => "best",
                Self::Last => "last",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for ResolvedRunConfigSelect {
        fn from(s: &str) -> Self {
            match s {
                "best" => Self::Best,
                "last" => Self::Last,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for ResolvedRunConfigSelect {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for ResolvedRunConfigSelect {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for ResolvedRunConfigSelect {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `ResolvedRunConfigSplit`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ResolvedRunConfigSplit {
        pub strategy: ResolvedRunConfigSplitStrategy,
        pub eval_fraction: f64,
        pub seed: i64,
        pub train_records: i64,
        pub eval_records: i64,
    }

    /// Allowed values of `ResolvedRunConfigSplitStrategy` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ResolvedRunConfigSplitStrategy {
        /// `"by_session"`
        BySession,
        /// `"by_group"`
        ByGroup,
        /// `"random"`
        Random,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for ResolvedRunConfigSplitStrategy {
        fn default() -> Self {
            Self::BySession
        }
    }

    impl ResolvedRunConfigSplitStrategy {
        pub fn as_str(&self) -> &str {
            match self {
                Self::BySession => "by_session",
                Self::ByGroup => "by_group",
                Self::Random => "random",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for ResolvedRunConfigSplitStrategy {
        fn from(s: &str) -> Self {
            match s {
                "by_session" => Self::BySession,
                "by_group" => Self::ByGroup,
                "random" => Self::Random,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for ResolvedRunConfigSplitStrategy {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for ResolvedRunConfigSplitStrategy {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for ResolvedRunConfigSplitStrategy {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `ResolvedRunConfigThinking` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ResolvedRunConfigThinking {
        /// `"auto"`
        Auto,
        /// `"on"`
        On,
        /// `"off"`
        Off,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for ResolvedRunConfigThinking {
        fn default() -> Self {
            Self::Auto
        }
    }

    impl ResolvedRunConfigThinking {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Auto => "auto",
                Self::On => "on",
                Self::Off => "off",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for ResolvedRunConfigThinking {
        fn from(s: &str) -> Self {
            match s {
                "auto" => Self::Auto,
                "on" => Self::On,
                "off" => Self::Off,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for ResolvedRunConfigThinking {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for ResolvedRunConfigThinking {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for ResolvedRunConfigThinking {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `ResolvedRunConfigTrainOn` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum ResolvedRunConfigTrainOn {
        /// `"last"`
        Last,
        /// `"all_assistant"`
        AllAssistant,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for ResolvedRunConfigTrainOn {
        fn default() -> Self {
            Self::Last
        }
    }

    impl ResolvedRunConfigTrainOn {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Last => "last",
                Self::AllAssistant => "all_assistant",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for ResolvedRunConfigTrainOn {
        fn from(s: &str) -> Self {
            match s {
                "last" => Self::Last,
                "all_assistant" => Self::AllAssistant,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for ResolvedRunConfigTrainOn {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for ResolvedRunConfigTrainOn {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for ResolvedRunConfigTrainOn {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `ResumeRunRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct ResumeRunRequest {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub max_cost_usd: Option<f64>,
    }

    /// Generated from the OpenAPI schema `RouteRequest`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct RouteRequest {
        pub deployment: String,
        pub messages: Vec<ChatMessage>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub tools: Option<Vec<BTreeMap<String, Value>>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub session_id: Option<String>,
    }

    /// Generated from the OpenAPI schema `RouteResponse`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
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
    pub struct RouterParetoSummary {
        pub target_max_drop: f64,
        #[serde(default)]
        pub routed_quality: Option<f64>,
        #[serde(default)]
        pub quality_drop: Option<f64>,
        /// 95% bootstrap interval [low, high].
        #[serde(default)]
        pub quality_drop_ci95: Option<Vec<f64>>,
        #[serde(default)]
        pub offload_rate: Option<f64>,
        #[serde(default)]
        pub cost_savings_pct: Option<f64>,
        #[serde(default)]
        pub ece: Option<f64>,
        #[serde(default)]
        pub threshold: Option<f64>,
        pub temperature: f64,
        /// Members not declared in the schema (round-tripped verbatim).
        #[serde(flatten)]
        pub additional_properties: BTreeMap<String, Value>,
    }

    /// Generated from the OpenAPI schema `Run`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
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
        #[serde(default)]
        pub max_cost_usd: Option<f64>,
        pub price_per_million_tokens: f64,
        pub tokens_processed: i64,
        pub cost_usd: f64,
        pub current_step: i64,
        pub total_steps: i64,
        pub attempt: i64,
        pub max_attempts: i64,
        #[serde(default)]
        pub latest_metric: Option<MetricPoint>,
        #[serde(default)]
        pub eval_report: Option<EvalReport>,
        #[serde(default)]
        pub artifact_id: Option<String>,
        #[serde(default)]
        pub error: Option<String>,
        pub created_at: String,
        pub updated_at: String,
        #[serde(default)]
        pub finished_at: Option<String>,
    }

    /// Allowed values of `RunStatus` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum RunStatus {
        /// `"queued"`
        Queued,
        /// `"running"`
        Running,
        /// `"completed"`
        Completed,
        /// `"failed"`
        Failed,
        /// `"cancelled"`
        Cancelled,
        /// `"stopped_budget"`
        StoppedBudget,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for RunStatus {
        fn default() -> Self {
            Self::Queued
        }
    }

    impl RunStatus {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Queued => "queued",
                Self::Running => "running",
                Self::Completed => "completed",
                Self::Failed => "failed",
                Self::Cancelled => "cancelled",
                Self::StoppedBudget => "stopped_budget",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for RunStatus {
        fn from(s: &str) -> Self {
            match s {
                "queued" => Self::Queued,
                "running" => Self::Running,
                "completed" => Self::Completed,
                "failed" => Self::Failed,
                "cancelled" => Self::Cancelled,
                "stopped_budget" => Self::StoppedBudget,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for RunStatus {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for RunStatus {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for RunStatus {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `SplitSpec`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct SplitSpec {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub strategy: Option<SplitSpecStrategy>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub eval_fraction: Option<f64>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub seed: Option<i64>,
    }

    /// Allowed values of `SplitSpecStrategy` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum SplitSpecStrategy {
        /// `"by_session"`
        BySession,
        /// `"by_group"`
        ByGroup,
        /// `"random"`
        Random,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for SplitSpecStrategy {
        fn default() -> Self {
            Self::BySession
        }
    }

    impl SplitSpecStrategy {
        pub fn as_str(&self) -> &str {
            match self {
                Self::BySession => "by_session",
                Self::ByGroup => "by_group",
                Self::Random => "random",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for SplitSpecStrategy {
        fn from(s: &str) -> Self {
            match s {
                "by_session" => Self::BySession,
                "by_group" => Self::ByGroup,
                "random" => Self::Random,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for SplitSpecStrategy {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for SplitSpecStrategy {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for SplitSpecStrategy {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `TrainableModel`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct TrainableModel {
        pub id: String,
        #[serde(default)]
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

    /// Allowed values of `TrainableModelAdaptersItem` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum TrainableModelAdaptersItem {
        /// `"lora"`
        Lora,
        /// `"prefix_kv"`
        PrefixKv,
        /// `"frozen_head"`
        FrozenHead,
        /// `"encoder_full"`
        EncoderFull,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for TrainableModelAdaptersItem {
        fn default() -> Self {
            Self::Lora
        }
    }

    impl TrainableModelAdaptersItem {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Lora => "lora",
                Self::PrefixKv => "prefix_kv",
                Self::FrozenHead => "frozen_head",
                Self::EncoderFull => "encoder_full",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for TrainableModelAdaptersItem {
        fn from(s: &str) -> Self {
            match s {
                "lora" => Self::Lora,
                "prefix_kv" => Self::PrefixKv,
                "frozen_head" => Self::FrozenHead,
                "encoder_full" => Self::EncoderFull,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for TrainableModelAdaptersItem {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for TrainableModelAdaptersItem {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for TrainableModelAdaptersItem {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Allowed values of `TrainableModelFamily` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum TrainableModelFamily {
        /// `"llm"`
        Llm,
        /// `"encoder"`
        Encoder,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for TrainableModelFamily {
        fn default() -> Self {
            Self::Llm
        }
    }

    impl TrainableModelFamily {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Llm => "llm",
                Self::Encoder => "encoder",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for TrainableModelFamily {
        fn from(s: &str) -> Self {
            match s {
                "llm" => Self::Llm,
                "encoder" => Self::Encoder,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for TrainableModelFamily {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for TrainableModelFamily {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for TrainableModelFamily {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }

    /// Generated from the OpenAPI schema `TrajectoryInput`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct TrajectoryInput {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub messages: Option<Vec<ChatMessage>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub tools: Option<Vec<BTreeMap<String, Value>>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub media: Option<Vec<BTreeMap<String, Value>>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub features: Option<BTreeMap<String, Value>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub payload: Option<Value>,
        /// Members not declared in the schema (round-tripped verbatim).
        #[serde(flatten)]
        pub additional_properties: BTreeMap<String, Value>,
    }

    /// Generated from the OpenAPI schema `TrajectoryOutput`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct TrajectoryOutput {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub turns: Option<Vec<ChatMessage>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        pub payload: Option<Value>,
        /// Members not declared in the schema (round-tripped verbatim).
        #[serde(flatten)]
        pub additional_properties: BTreeMap<String, Value>,
    }

    /// Generated from the OpenAPI schema `UploadTicket`.
    #[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
    pub struct UploadTicket {
        pub upload_id: String,
        pub method: UploadTicketMethod,
        /// Absolute presigned URL, or a path relative to the API base URL (local storage).
        pub url: String,
        pub headers: BTreeMap<String, String>,
        pub expires_at: String,
    }

    /// Allowed values of `UploadTicketMethod` (unknown values from newer servers are kept in `Other`).
    #[derive(Debug, Clone, PartialEq, Eq, Hash)]
    pub enum UploadTicketMethod {
        /// `"PUT"`
        Put,
        /// A value this SDK version does not know.
        Other(String),
    }

    impl Default for UploadTicketMethod {
        fn default() -> Self {
            Self::Put
        }
    }

    impl UploadTicketMethod {
        pub fn as_str(&self) -> &str {
            match self {
                Self::Put => "PUT",
                Self::Other(s) => s.as_str(),
            }
        }
    }

    impl From<&str> for UploadTicketMethod {
        fn from(s: &str) -> Self {
            match s {
                "PUT" => Self::Put,
                other => Self::Other(other.to_string()),
            }
        }
    }

    impl std::fmt::Display for UploadTicketMethod {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            f.write_str(self.as_str())
        }
    }

    impl Serialize for UploadTicketMethod {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            serializer.serialize_str(self.as_str())
        }
    }

    impl<'de> Deserialize<'de> for UploadTicketMethod {
        fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
            let s = String::deserialize(deserializer)?;
            Ok(Self::from(s.as_str()))
        }
    }
}

pub use models::*;

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

impl GeneratedClient {
    /// Cancel a queued, running or awaiting_scores evaluation
    ///
    /// `POST /v1/evals/{id}/cancel`
    pub async fn cancel_eval(&self, id: &str, idempotency_key: Option<&str>) -> Result<EvalRun, ApiError> {
        let path = format!("/v1/evals/{}/cancel", encode_path_segment("id", id)?);
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, None::<&()>).await
    }

    /// Cancel a training run (a running attempt is stopped and billed)
    ///
    /// `POST /v1/runs/{id}/cancel`
    pub async fn cancel_run(&self, id: &str, idempotency_key: Option<&str>) -> Result<Run, ApiError> {
        let path = format!("/v1/runs/{}/cancel", encode_path_segment("id", id)?);
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, None::<&()>).await
    }

    /// Create a scoped workspace API key (trainer worker keys are platform config, not keys)
    ///
    /// `POST /v1/keys`
    pub async fn create_api_key(&self, body: &CreateApiKeyRequest, idempotency_key: Option<&str>) -> Result<CreatedApiKey, ApiError> {
        let path = "/v1/keys".to_string();
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }

    /// Create an empty dataset
    ///
    /// `POST /v1/datasets`
    pub async fn create_dataset(&self, body: &CreateDatasetRequest, idempotency_key: Option<&str>) -> Result<Dataset, ApiError> {
        let path = "/v1/datasets".to_string();
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }

    /// Import an uploaded file or a Hugging Face dataset into a dataset (async job)
    ///
    /// `POST /v1/datasets/{name}/imports`
    pub async fn create_dataset_import(&self, name: &str, body: &CreateImportRequest, idempotency_key: Option<&str>) -> Result<ImportJob, ApiError> {
        let path = format!("/v1/datasets/{}/imports", encode_path_segment("name", name)?);
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }

    /// Generate embeddings from a deployed embedding artifact
    ///
    /// `POST /v1/embeddings`
    pub async fn create_embeddings(&self, body: &EmbedRequest, idempotency_key: Option<&str>) -> Result<EmbedResponse, ApiError> {
        let path = "/v1/embeddings".to_string();
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }

    /// Queue an evaluation across models on a pinned dataset version (executed by the server)
    ///
    /// `POST /v1/evals`
    pub async fn create_eval(&self, body: &PlanEvalRequest, idempotency_key: Option<&str>) -> Result<EvalRun, ApiError> {
        let path = "/v1/evals".to_string();
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }

    /// Create and enqueue a training run (pins the dataset version)
    ///
    /// `POST /v1/runs`
    pub async fn create_run(&self, body: &PlanRunRequest, idempotency_key: Option<&str>) -> Result<Run, ApiError> {
        let path = "/v1/runs".to_string();
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }

    /// Get an upload URL for a file to import (PUT the bytes, then create an import)
    ///
    /// `POST /v1/uploads`
    pub async fn create_upload(&self, body: &CreateUploadRequest, idempotency_key: Option<&str>) -> Result<UploadTicket, ApiError> {
        let path = "/v1/uploads".to_string();
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }

    /// Deploy or update an artifact under a stable model name
    ///
    /// `POST /v1/deployments`
    pub async fn deploy_artifact(&self, body: &DeployArtifactRequest, idempotency_key: Option<&str>) -> Result<Deployment, ApiError> {
        let path = "/v1/deployments".to_string();
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }

    /// Download an artifact bundle (.grad.tar.gz); verify X-Artifact-Sha256
    ///
    /// `GET /v1/artifacts/{id}/download`
    pub async fn download_artifact(&self, id: &str) -> Result<StreamResponse, ApiError> {
        let path = format!("/v1/artifacts/{}/download", encode_path_segment("id", id)?);
        self.request_stream(reqwest::Method::GET, &path, &[], &[], None::<&()>, "application/octet-stream").await
    }

    /// Get an artifact by id or name@latest
    ///
    /// `GET /v1/artifacts/{id}`
    pub async fn get_artifact(&self, id: &str) -> Result<Artifact, ApiError> {
        let path = format!("/v1/artifacts/{}", encode_path_segment("id", id)?);
        self.request_json(reqwest::Method::GET, &path, &[], &[], None::<&()>).await
    }

    /// Get a dataset by name
    ///
    /// `GET /v1/datasets/{name}`
    pub async fn get_dataset(&self, name: &str) -> Result<Dataset, ApiError> {
        let path = format!("/v1/datasets/{}", encode_path_segment("name", name)?);
        self.request_json(reqwest::Method::GET, &path, &[], &[], None::<&()>).await
    }

    /// Get deployment status and feedback summary
    ///
    /// `GET /v1/deployments/{name}`
    pub async fn get_deployment(&self, name: &str) -> Result<DeploymentStatus, ApiError> {
        let path = format!("/v1/deployments/{}", encode_path_segment("name", name)?);
        self.request_json(reqwest::Method::GET, &path, &[], &[], None::<&()>).await
    }

    /// Get an evaluation run by ID
    ///
    /// `GET /v1/evals/{id}`
    pub async fn get_eval(&self, id: &str) -> Result<EvalRun, ApiError> {
        let path = format!("/v1/evals/{}", encode_path_segment("id", id)?);
        self.request_json(reqwest::Method::GET, &path, &[], &[], None::<&()>).await
    }

    /// Get a dataset import job
    ///
    /// `GET /v1/imports/{id}`
    pub async fn get_import(&self, id: &str) -> Result<ImportJob, ApiError> {
        let path = format!("/v1/imports/{}", encode_path_segment("id", id)?);
        self.request_json(reqwest::Method::GET, &path, &[], &[], None::<&()>).await
    }

    /// Get a training run
    ///
    /// `GET /v1/runs/{id}`
    pub async fn get_run(&self, id: &str) -> Result<Run, ApiError> {
        let path = format!("/v1/runs/{}", encode_path_segment("id", id)?);
        self.request_json(reqwest::Method::GET, &path, &[], &[], None::<&()>).await
    }

    /// List workspace API keys
    ///
    /// `GET /v1/keys`
    pub async fn list_api_keys(&self, params: Option<&ListApiKeysParams>) -> Result<ListApiKeysResponse, ApiError> {
        let path = "/v1/keys".to_string();
        let default_params = ListApiKeysParams::default();
        let params = params.unwrap_or(&default_params);
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &params.limit {
            query.push(("limit", v.query_value()));
        }
        if let Some(v) = &params.cursor {
            query.push(("cursor", v.query_value()));
        }
        self.request_json(reqwest::Method::GET, &path, &query, &[], None::<&()>).await
    }

    /// List immutable artifacts (newest first)
    ///
    /// `GET /v1/artifacts`
    pub async fn list_artifacts(&self, params: Option<&ListArtifactsParams>) -> Result<ListArtifactsResponse, ApiError> {
        let path = "/v1/artifacts".to_string();
        let default_params = ListArtifactsParams::default();
        let params = params.unwrap_or(&default_params);
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &params.limit {
            query.push(("limit", v.query_value()));
        }
        if let Some(v) = &params.cursor {
            query.push(("cursor", v.query_value()));
        }
        if let Some(v) = &params.name {
            query.push(("name", v.query_value()));
        }
        self.request_json(reqwest::Method::GET, &path, &query, &[], None::<&()>).await
    }

    /// Read records of a dataset version
    ///
    /// `GET /v1/datasets/{name}/records`
    pub async fn list_dataset_records(&self, name: &str, params: Option<&ListDatasetRecordsParams>) -> Result<DatasetRecordsPage, ApiError> {
        let path = format!("/v1/datasets/{}/records", encode_path_segment("name", name)?);
        let default_params = ListDatasetRecordsParams::default();
        let params = params.unwrap_or(&default_params);
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &params.version {
            query.push(("version", v.query_value()));
        }
        if let Some(v) = &params.limit {
            query.push(("limit", v.query_value()));
        }
        if let Some(v) = &params.cursor {
            query.push(("cursor", v.query_value()));
        }
        self.request_json(reqwest::Method::GET, &path, &query, &[], None::<&()>).await
    }

    /// List datasets (newest first)
    ///
    /// `GET /v1/datasets`
    pub async fn list_datasets(&self, params: Option<&ListDatasetsParams>) -> Result<ListDatasetsResponse, ApiError> {
        let path = "/v1/datasets".to_string();
        let default_params = ListDatasetsParams::default();
        let params = params.unwrap_or(&default_params);
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &params.limit {
            query.push(("limit", v.query_value()));
        }
        if let Some(v) = &params.cursor {
            query.push(("cursor", v.query_value()));
        }
        self.request_json(reqwest::Method::GET, &path, &query, &[], None::<&()>).await
    }

    /// List deployments
    ///
    /// `GET /v1/deployments`
    pub async fn list_deployments(&self, params: Option<&ListDeploymentsParams>) -> Result<ListDeploymentsResponse, ApiError> {
        let path = "/v1/deployments".to_string();
        let default_params = ListDeploymentsParams::default();
        let params = params.unwrap_or(&default_params);
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &params.limit {
            query.push(("limit", v.query_value()));
        }
        if let Some(v) = &params.cursor {
            query.push(("cursor", v.query_value()));
        }
        self.request_json(reqwest::Method::GET, &path, &query, &[], None::<&()>).await
    }

    /// List failing task records from an evaluation run for mining
    ///
    /// `GET /v1/evals/{id}/failures`
    pub async fn list_eval_failures(&self, id: &str, params: Option<&ListEvalFailuresParams>) -> Result<ListEvalFailuresResponse, ApiError> {
        let path = format!("/v1/evals/{}/failures", encode_path_segment("id", id)?);
        let default_params = ListEvalFailuresParams::default();
        let params = params.unwrap_or(&default_params);
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &params.limit {
            query.push(("limit", v.query_value()));
        }
        if let Some(v) = &params.cursor {
            query.push(("cursor", v.query_value()));
        }
        if let Some(v) = &params.model {
            query.push(("model", v.query_value()));
        }
        if let Some(v) = &params.threshold {
            query.push(("threshold", v.query_value()));
        }
        self.request_json(reqwest::Method::GET, &path, &query, &[], None::<&()>).await
    }

    /// Page through generated model outputs (filter by model or by a code scorer that still needs a score)
    ///
    /// `GET /v1/evals/{id}/outputs`
    pub async fn list_eval_outputs(&self, id: &str, params: Option<&ListEvalOutputsParams>) -> Result<ListEvalOutputsResponse, ApiError> {
        let path = format!("/v1/evals/{}/outputs", encode_path_segment("id", id)?);
        let default_params = ListEvalOutputsParams::default();
        let params = params.unwrap_or(&default_params);
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &params.limit {
            query.push(("limit", v.query_value()));
        }
        if let Some(v) = &params.cursor {
            query.push(("cursor", v.query_value()));
        }
        if let Some(v) = &params.model {
            query.push(("model", v.query_value()));
        }
        if let Some(v) = &params.missing_scorer {
            query.push(("missing_scorer", v.query_value()));
        }
        self.request_json(reqwest::Method::GET, &path, &query, &[], None::<&()>).await
    }

    /// Per-task, per-model results of a completed evaluation
    ///
    /// `GET /v1/evals/{id}/results`
    pub async fn list_eval_results(&self, id: &str, params: Option<&ListEvalResultsParams>) -> Result<ListEvalResultsResponse, ApiError> {
        let path = format!("/v1/evals/{}/results", encode_path_segment("id", id)?);
        let default_params = ListEvalResultsParams::default();
        let params = params.unwrap_or(&default_params);
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &params.limit {
            query.push(("limit", v.query_value()));
        }
        if let Some(v) = &params.cursor {
            query.push(("cursor", v.query_value()));
        }
        if let Some(v) = &params.model {
            query.push(("model", v.query_value()));
        }
        self.request_json(reqwest::Method::GET, &path, &query, &[], None::<&()>).await
    }

    /// List evaluation runs
    ///
    /// `GET /v1/evals`
    pub async fn list_evals(&self, params: Option<&ListEvalsParams>) -> Result<ListEvalsResponse, ApiError> {
        let path = "/v1/evals".to_string();
        let default_params = ListEvalsParams::default();
        let params = params.unwrap_or(&default_params);
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &params.limit {
            query.push(("limit", v.query_value()));
        }
        if let Some(v) = &params.cursor {
            query.push(("cursor", v.query_value()));
        }
        self.request_json(reqwest::Method::GET, &path, &query, &[], None::<&()>).await
    }

    /// List dataset import jobs (newest first)
    ///
    /// `GET /v1/imports`
    pub async fn list_imports(&self, params: Option<&ListImportsParams>) -> Result<ListImportsResponse, ApiError> {
        let path = "/v1/imports".to_string();
        let default_params = ListImportsParams::default();
        let params = params.unwrap_or(&default_params);
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &params.limit {
            query.push(("limit", v.query_value()));
        }
        if let Some(v) = &params.cursor {
            query.push(("cursor", v.query_value()));
        }
        self.request_json(reqwest::Method::GET, &path, &query, &[], None::<&()>).await
    }

    /// List trainable base models (the server catalog and price source)
    ///
    /// `GET /v1/models`
    pub async fn list_models(&self) -> Result<ListModelsResponse, ApiError> {
        let path = "/v1/models".to_string();
        self.request_json(reqwest::Method::GET, &path, &[], &[], None::<&()>).await
    }

    /// List unexpired checkpoints of a run (best and final never expire)
    ///
    /// `GET /v1/runs/{id}/checkpoints`
    pub async fn list_run_checkpoints(&self, id: &str, params: Option<&ListRunCheckpointsParams>) -> Result<ListRunCheckpointsResponse, ApiError> {
        let path = format!("/v1/runs/{}/checkpoints", encode_path_segment("id", id)?);
        let default_params = ListRunCheckpointsParams::default();
        let params = params.unwrap_or(&default_params);
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &params.limit {
            query.push(("limit", v.query_value()));
        }
        if let Some(v) = &params.cursor {
            query.push(("cursor", v.query_value()));
        }
        self.request_json(reqwest::Method::GET, &path, &query, &[], None::<&()>).await
    }

    /// Training step metrics as JSON pages, or a live SSE stream
    ///
    /// `GET /v1/runs/{id}/metrics`
    pub async fn list_run_metrics(&self, id: &str, params: Option<&ListRunMetricsParams>) -> Result<MetricsPage, ApiError> {
        let path = format!("/v1/runs/{}/metrics", encode_path_segment("id", id)?);
        let default_params = ListRunMetricsParams::default();
        let params = params.unwrap_or(&default_params);
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &params.cursor {
            query.push(("cursor", v.query_value()));
        }
        if let Some(v) = &params.after_step {
            query.push(("after_step", v.query_value()));
        }
        if let Some(v) = &params.limit {
            query.push(("limit", v.query_value()));
        }
        self.request_json(reqwest::Method::GET, &path, &query, &[], None::<&()>).await
    }

    /// Training step metrics as JSON pages, or a live SSE stream (Server-Sent Events; resume with `last_event_id`)
    pub async fn list_run_metrics_stream(&self, id: &str, params: Option<&ListRunMetricsParams>, last_event_id: Option<&str>) -> Result<SseStream, ApiError> {
        let path = format!("/v1/runs/{}/metrics", encode_path_segment("id", id)?);
        let default_params = ListRunMetricsParams::default();
        let params = params.unwrap_or(&default_params);
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &params.cursor {
            query.push(("cursor", v.query_value()));
        }
        if let Some(v) = &params.after_step {
            query.push(("after_step", v.query_value()));
        }
        if let Some(v) = &params.limit {
            query.push(("limit", v.query_value()));
        }
        self.request_sse(reqwest::Method::GET, &path, &query, last_event_id).await
    }

    /// List training runs (newest first)
    ///
    /// `GET /v1/runs`
    pub async fn list_runs(&self, params: Option<&ListRunsParams>) -> Result<ListRunsResponse, ApiError> {
        let path = "/v1/runs".to_string();
        let default_params = ListRunsParams::default();
        let params = params.unwrap_or(&default_params);
        let mut query: Vec<(&str, String)> = Vec::new();
        if let Some(v) = &params.limit {
            query.push(("limit", v.query_value()));
        }
        if let Some(v) = &params.cursor {
            query.push(("cursor", v.query_value()));
        }
        self.request_json(reqwest::Method::GET, &path, &query, &[], None::<&()>).await
    }

    /// Estimate tasks, model/judge calls, and cost before running an eval
    ///
    /// `POST /v1/evals/plan`
    pub async fn plan_eval(&self, body: &PlanEvalRequest, idempotency_key: Option<&str>) -> Result<PlanEvalResponse, ApiError> {
        let path = "/v1/evals/plan".to_string();
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }

    /// Dry-run a training recipe at zero cost
    ///
    /// `POST /v1/runs/plan`
    pub async fn plan_run(&self, body: &PlanRunRequest, idempotency_key: Option<&str>) -> Result<PlanRunResponse, ApiError> {
        let path = "/v1/runs/plan".to_string();
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }

    /// Post scores computed by local (SDK-side) code scorers; the eval completes when none are missing
    ///
    /// `POST /v1/evals/{id}/scores`
    pub async fn post_eval_scores(&self, id: &str, body: &PostEvalScoresRequest, idempotency_key: Option<&str>) -> Result<PostEvalScoresResponse, ApiError> {
        let path = format!("/v1/evals/{}/scores", encode_path_segment("id", id)?);
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }

    /// Copy an exportable checkpoint into a new immutable artifact
    ///
    /// `POST /v1/checkpoints/{id}/promote`
    pub async fn promote_checkpoint(&self, id: &str, body: Option<&PromoteCheckpointRequest>, idempotency_key: Option<&str>) -> Result<Artifact, ApiError> {
        let path = format!("/v1/checkpoints/{}/promote", encode_path_segment("id", id)?);
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, body).await
    }

    /// Append records as a new dataset version (creates the dataset if needed)
    ///
    /// `POST /v1/datasets/{name}/records`
    pub async fn push_dataset_records(&self, name: &str, body: &PushDatasetRequest, idempotency_key: Option<&str>) -> Result<Dataset, ApiError> {
        let path = format!("/v1/datasets/{}/records", encode_path_segment("name", name)?);
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }

    /// Record deduplicated outcome scores and gold corrections
    ///
    /// `POST /v1/feedback`
    pub async fn record_feedback(&self, body: &RecordFeedbackRequest, idempotency_key: Option<&str>) -> Result<RecordFeedbackResponse, ApiError> {
        let path = "/v1/feedback".to_string();
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }

    /// Preview chat-template rendering and loss masks (estimated token counts)
    ///
    /// `POST /v1/datasets/{name}/render`
    pub async fn render_dataset(&self, name: &str, body: &RenderDatasetRequest, idempotency_key: Option<&str>) -> Result<RenderDatasetResponse, ApiError> {
        let path = format!("/v1/datasets/{}/render", encode_path_segment("name", name)?);
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }

    /// Resume a stopped, failed or cancelled run from its latest checkpoint
    ///
    /// `POST /v1/runs/{id}/resume`
    pub async fn resume_run(&self, id: &str, body: Option<&ResumeRunRequest>, idempotency_key: Option<&str>) -> Result<Run, ApiError> {
        let path = format!("/v1/runs/{}/resume", encode_path_segment("id", id)?);
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, body).await
    }

    /// Revoke a workspace API key
    ///
    /// `DELETE /v1/keys/{id}`
    pub async fn revoke_api_key(&self, id: &str) -> Result<ApiKey, ApiError> {
        let path = format!("/v1/keys/{}", encode_path_segment("id", id)?);
        self.request_json(reqwest::Method::DELETE, &path, &[], &[], None::<&()>).await
    }

    /// Roll a deployment back to its previous artifact
    ///
    /// `POST /v1/deployments/{name}/rollback`
    pub async fn rollback_deployment(&self, name: &str, idempotency_key: Option<&str>) -> Result<Deployment, ApiError> {
        let path = format!("/v1/deployments/{}/rollback", encode_path_segment("name", name)?);
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, None::<&()>).await
    }

    /// Ask a deployed model router which model to call
    ///
    /// `POST /v1/route`
    pub async fn route_request(&self, body: &RouteRequest, idempotency_key: Option<&str>) -> Result<RouteResponse, ApiError> {
        let path = "/v1/route".to_string();
        let headers: Vec<(&str, String)> = vec![("Idempotency-Key", idempotency_key.map(str::to_string).unwrap_or_else(new_idempotency_key))];
        self.request_json(reqwest::Method::POST, &path, &[], &headers, Some(body)).await
    }
}
