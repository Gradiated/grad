use serde::de::DeserializeOwned;
use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// Version reported in the User-Agent header.
pub const SDK_VERSION: &str = "__SDK_VERSION__";
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
        let idempotent = matches!(method_name.as_str(), "GET" | "HEAD" | "PUT" | "DELETE" | "OPTIONS");
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
                let retryable = matches!(status, 408 | 429 | 500 | 502 | 503 | 504) && (idempotent || status == 429);
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
