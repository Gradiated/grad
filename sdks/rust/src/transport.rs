//! HTTP transport: auth, retries with backoff, redirect policy, timeouts and
//! problem+json error mapping.
//!
//! - Idempotent requests (GET/HEAD/PUT/DELETE) are retried on 408, 429, 500,
//!   502, 503, 504, timeouts and connection errors; POST only on 429 and on
//!   connection failures where the request never left the client.
//! - `Retry-After` (seconds) is honoured, capped at 60 s.
//! - Redirects are followed by hand: only same-origin GET/HEAD redirects are
//!   followed, so a bearer token never reaches another origin and a POST is
//!   never silently turned into a GET.
//! - JSON calls have a total per-request timeout; streaming downloads and SSE
//!   only have connect and read-idle timeouts.

use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, CONTENT_TYPE, LOCATION};
use reqwest::{Method, StatusCode, Url};
use serde::de::DeserializeOwned;
use serde_json::Value;
use std::path::PathBuf;
use std::time::Duration;

use crate::error::{ApiErrorBody, Error, Result};
use crate::util;

const MAX_REDIRECTS: usize = 5;
const MAX_RETRY_AFTER: Duration = Duration::from_secs(60);

/// Request body.
pub(crate) enum Body {
    None,
    Json(Value),
    /// Stream a file from disk (re-opened on every attempt).
    File {
        path: PathBuf,
        len: u64,
    },
}

/// Per-request timeout policy.
#[derive(Clone, Copy)]
pub(crate) enum Deadline {
    /// The client's default total timeout.
    Default,
    /// No total timeout (streaming); connect and read-idle timeouts still apply.
    Streaming,
}

/// One logical API request.
pub(crate) struct Req {
    pub method: Method,
    /// Path relative to the base URL (`/v1/...`), or an absolute URL when `absolute`.
    pub path: String,
    pub absolute: bool,
    pub query: Vec<(String, String)>,
    pub body: Body,
    pub accept: Option<&'static str>,
    pub headers: Vec<(String, String)>,
    pub deadline: Deadline,
    /// Send the bearer token (never for presigned upload URLs).
    pub auth: bool,
}

impl Req {
    pub fn new(method: Method, path: impl Into<String>) -> Self {
        Req {
            method,
            path: path.into(),
            absolute: false,
            query: Vec::new(),
            body: Body::None,
            accept: Some("application/json"),
            headers: Vec::new(),
            deadline: Deadline::Default,
            auth: true,
        }
    }

    pub fn get(path: impl Into<String>) -> Self {
        Self::new(Method::GET, path)
    }

    pub fn post(path: impl Into<String>) -> Self {
        Self::new(Method::POST, path)
    }

    pub fn json(mut self, body: Value) -> Self {
        self.body = Body::Json(body);
        self
    }

    pub fn query(mut self, q: Vec<(String, String)>) -> Self {
        self.query.extend(q);
        self
    }

    pub fn param(mut self, k: &str, v: impl ToString) -> Self {
        self.query.push((k.to_string(), v.to_string()));
        self
    }

    pub fn opt_param<T: ToString>(self, k: &str, v: Option<T>) -> Self {
        match v {
            Some(v) => self.param(k, v),
            None => self,
        }
    }
}

/// Transport settings.
#[derive(Clone)]
pub(crate) struct Transport {
    pub http: reqwest::Client,
    pub base: Option<Url>,
    pub base_url: String,
    pub api_key: Option<String>,
    pub timeout: Duration,
    pub max_retries: u32,
    pub retry_base: Duration,
    /// Configuration error surfaced on the first request (from `Client::new()`).
    pub deferred: Option<String>,
    /// Extra hint appended to 401 errors (why no key was sent).
    pub auth_hint: Option<String>,
}

pub(crate) fn build_http(connect_timeout: Duration, read_timeout: Duration) -> reqwest::Client {
    reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(connect_timeout)
        .read_timeout(read_timeout)
        .user_agent(concat!("grad-sdk-rust/", env!("CARGO_PKG_VERSION")))
        .build()
        .expect("reqwest client with rustls builds")
}

fn idempotent(m: &Method) -> bool {
    matches!(
        *m,
        Method::GET | Method::HEAD | Method::PUT | Method::DELETE
    )
}

fn retryable_status(m: &Method, s: StatusCode) -> bool {
    match s.as_u16() {
        429 => true,
        408 | 500 | 502 | 503 | 504 => idempotent(m),
        _ => false,
    }
}

fn same_origin(a: &Url, b: &Url) -> bool {
    a.scheme() == b.scheme()
        && a.host_str() == b.host_str()
        && a.port_or_known_default() == b.port_or_known_default()
}

/// Human cause of a transport error, innermost first ("Connection refused (os error 111)").
fn cause_of(err: &reqwest::Error) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut src: Option<&(dyn std::error::Error + 'static)> = std::error::Error::source(err);
    while let Some(s) = src {
        let msg = s.to_string();
        if !msg.is_empty() && !parts.iter().any(|p| p.contains(&msg)) {
            parts.push(msg);
        }
        src = s.source();
    }
    // The innermost cause is the most specific ("Connection refused (os error 111)",
    // "failed to lookup address information: ..."); hyper's wrappers add nothing.
    match parts.pop() {
        Some(inner) => {
            let outer = parts
                .iter()
                .find(|p| p.contains("dns error") || p.contains("invalid peer certificate"));
            match outer {
                Some(o) if !o.contains(&inner) => format!("{}: {}", o, inner),
                _ => inner,
            }
        }
        None => err.to_string(),
    }
}

impl Transport {
    pub fn url_for(&self, req: &Req) -> Result<Url> {
        if let Some(msg) = &self.deferred {
            return Err(Error::Config(msg.clone()));
        }
        if req.absolute {
            return Url::parse(&req.path).map_err(|e| Error::Decode {
                method: req.method.to_string(),
                url: req.path.clone(),
                message: format!("server returned an invalid URL: {}", e),
            });
        }
        let base = self
            .base
            .as_ref()
            .ok_or_else(|| Error::Config(format!("invalid base URL '{}'", self.base_url)))?;
        let joined = format!("{}{}", self.base_url, req.path);
        let mut url = Url::parse(&joined)
            .map_err(|e| Error::Config(format!("cannot build URL from '{}': {}", joined, e)))?;
        if url.origin() != base.origin() {
            return Err(Error::InvalidInput(format!(
                "path '{}' escapes the base URL",
                req.path
            )));
        }
        if !req.query.is_empty() {
            let mut pairs = url.query_pairs_mut();
            for (k, v) in &req.query {
                pairs.append_pair(k, v);
            }
        }
        Ok(url)
    }

    fn display_url(url: &Url) -> String {
        let mut u = url.clone();
        // Presigned URLs carry their credentials in the query string.
        if u.query()
            .is_some_and(|q| q.contains("sig=") || q.contains("Signature") || q.contains("X-Amz-"))
        {
            u.set_query(Some("<redacted>"));
        }
        u.to_string()
    }

    async fn build(
        &self,
        req: &Req,
        url: &Url,
        method: &Method,
    ) -> Result<reqwest::RequestBuilder> {
        let mut rb = self.http.request(method.clone(), url.clone());
        if req.auth {
            if let Some(key) = &self.api_key {
                let mut v = HeaderValue::from_str(&format!("Bearer {}", key)).map_err(|_| {
                    Error::Config(
                        "API key contains characters that are not valid in an HTTP header".into(),
                    )
                })?;
                v.set_sensitive(true);
                rb = rb.header(AUTHORIZATION, v);
            }
        }
        if let Some(accept) = req.accept {
            rb = rb.header(ACCEPT, accept);
        }
        for (k, v) in &req.headers {
            rb = rb.header(k.as_str(), v.as_str());
        }
        if let Deadline::Default = req.deadline {
            rb = rb.timeout(self.timeout);
        }
        match &req.body {
            Body::None => {}
            Body::Json(v) => {
                rb = rb.header(CONTENT_TYPE, "application/json").json(v);
            }
            Body::File { path, len } => {
                let file = tokio::fs::File::open(path)
                    .await
                    .map_err(|e| Error::io(path, e))?;
                let stream = tokio_util::io::ReaderStream::with_capacity(file, 256 * 1024);
                rb = rb
                    .header(reqwest::header::CONTENT_LENGTH, len.to_string())
                    .body(reqwest::Body::wrap_stream(stream));
            }
        }
        Ok(rb)
    }

    fn map_transport(&self, err: reqwest::Error, method: &Method, url: &Url) -> Error {
        let shown = Self::display_url(url);
        if err.is_timeout() {
            let after = match () {
                _ if err.is_connect() => None,
                _ => Some(self.timeout),
            };
            return Error::Timeout {
                method: method.to_string(),
                url: shown,
                after,
            };
        }
        if err.is_decode() || err.is_body() {
            return Error::Decode {
                method: method.to_string(),
                url: shown,
                message: cause_of(&err),
            };
        }
        let mut cause = cause_of(&err);
        if err.is_connect() {
            let host = url.host_str().unwrap_or("");
            if matches!(host, "127.0.0.1" | "localhost" | "::1" | "[::1]") {
                cause.push_str(". Is grad-server running? Start it with `grad local up`, or point GRADIATED_BASE_URL / --base-url at your server");
            } else {
                cause.push_str(
                    ". Check the base URL (GRADIATED_BASE_URL / --base-url) and your network",
                );
            }
        }
        Error::Connection {
            method: method.to_string(),
            url: shown,
            cause,
        }
    }

    async fn problem(&self, resp: reqwest::Response, method: &Method, url: &Url) -> Error {
        let status = resp.status().as_u16();
        let headers = resp.headers().clone();
        let header_rid = headers
            .get("x-request-id")
            .and_then(|v| v.to_str().ok())
            .map(str::to_string);
        let retry_after = parse_retry_after(&headers);
        let text = resp.text().await.unwrap_or_default();
        let parsed: Option<Value> = serde_json::from_str(&text).ok();
        let obj = parsed.as_ref().and_then(Value::as_object);
        let field = |k: &str| {
            obj.and_then(|o| o.get(k))
                .and_then(Value::as_str)
                .map(str::to_string)
        };
        let reason = StatusCode::from_u16(status)
            .ok()
            .and_then(|s| s.canonical_reason())
            .unwrap_or("error");
        let mut detail = field("detail").unwrap_or_else(|| {
            let t = text.trim();
            if t.is_empty() || obj.is_some() {
                reason.to_string()
            } else {
                t.chars().take(500).collect()
            }
        });
        if status == 401 {
            if self.api_key.is_none() {
                detail.push_str(" No API key was sent: set GRADIATED_API_KEY, pass --api-key, or run `grad login`.");
                if std::env::var_os("GRAD_API_KEY").is_some() {
                    detail.push_str(" (GRAD_API_KEY is set but no longer read; rename it to GRADIATED_API_KEY.)");
                }
            }
            if let Some(h) = &self.auth_hint {
                detail.push_str(&format!(" Note: {}.", h));
            }
        }
        let body = ApiErrorBody {
            status,
            code: field("code").unwrap_or_else(|| format!("http_{}", status)),
            title: field("title").unwrap_or_else(|| reason.to_string()),
            detail,
            request_id: field("request_id").or(header_rid),
            errors: obj.and_then(|o| o.get("errors")).cloned(),
            method: method.to_string(),
            url: Self::display_url(url),
            retry_after,
        };
        Error::from_status(body)
    }

    /// Send with retries and the redirect policy; returns a 2xx response.
    pub async fn send(&self, req: &Req) -> Result<reqwest::Response> {
        let mut url = self.url_for(req)?;
        let method = req.method.clone();
        let mut attempt: u32 = 0;
        let mut redirects = 0usize;
        loop {
            let rb = self.build(req, &url, &method).await?;
            let outcome = rb.send().await;
            let wait = match outcome {
                Ok(resp) => {
                    let status = resp.status();
                    if status.is_success() {
                        return Ok(resp);
                    }
                    if status.is_redirection() {
                        let target = resp
                            .headers()
                            .get(LOCATION)
                            .and_then(|v| v.to_str().ok())
                            .and_then(|loc| url.join(loc).ok());
                        let Some(target) = target else {
                            return Err(self.problem(resp, &method, &url).await);
                        };
                        let refuse = |reason: &str| Error::Redirect {
                            method: method.to_string(),
                            from: Self::display_url(&url),
                            to: Self::display_url(&target),
                            reason: reason.to_string(),
                        };
                        if !matches!(method, Method::GET | Method::HEAD) {
                            return Err(refuse("only GET and HEAD requests follow redirects"));
                        }
                        if !same_origin(&url, &target) {
                            return Err(refuse("cross-origin redirect; credentials are never sent to another origin"));
                        }
                        redirects += 1;
                        if redirects > MAX_REDIRECTS {
                            return Err(refuse("too many redirects"));
                        }
                        url = target;
                        continue;
                    }
                    let err = self.problem(resp, &method, &url).await;
                    if attempt < self.max_retries && retryable_status(&method, status) {
                        let ra = err.api().and_then(|b| b.retry_after);
                        Some(ra.map(|d| d.min(MAX_RETRY_AFTER)))
                    } else {
                        return Err(err);
                    }
                }
                Err(e) => {
                    let never_sent = e.is_connect();
                    let retry = attempt < self.max_retries
                        && (never_sent
                            || (idempotent(&method) && (e.is_timeout() || e.is_request())));
                    if retry {
                        Some(None)
                    } else {
                        return Err(self.map_transport(e, &method, &url));
                    }
                }
            };
            let delay = wait
                .flatten()
                .unwrap_or_else(|| util::backoff(attempt, self.retry_base, Duration::from_secs(8)));
            tokio::time::sleep(delay).await;
            attempt += 1;
        }
    }

    /// Send and decode a JSON response body (body-read failures of idempotent
    /// requests are retried like transport errors).
    pub async fn json<T: DeserializeOwned>(&self, req: Req) -> Result<T> {
        let method = req.method.clone();
        let mut attempt = 0u32;
        let (status, url, bytes) = loop {
            let resp = self.send(&req).await?;
            let url = Self::display_url(resp.url());
            let status = resp.status();
            match resp.bytes().await {
                Ok(b) => break (status, url, b),
                Err(e) => {
                    let err = if e.is_timeout() {
                        Error::Timeout {
                            method: method.to_string(),
                            url: url.clone(),
                            after: Some(self.timeout),
                        }
                    } else {
                        Error::Connection {
                            method: method.to_string(),
                            url: url.clone(),
                            cause: format!("the response body was cut off: {}", cause_of(&e)),
                        }
                    };
                    if idempotent(&method) && attempt < self.max_retries {
                        tokio::time::sleep(util::backoff(
                            attempt,
                            self.retry_base,
                            Duration::from_secs(8),
                        ))
                        .await;
                        attempt += 1;
                        continue;
                    }
                    return Err(err);
                }
            }
        };
        let slice: &[u8] =
            if bytes.iter().all(|b| b.is_ascii_whitespace()) || status == StatusCode::NO_CONTENT {
                b"{}"
            } else {
                &bytes
            };
        serde_json::from_slice(slice).map_err(|e| Error::Decode {
            method: method.to_string(),
            url,
            message: format!(
                "{} (body starts with {:?})",
                e,
                String::from_utf8_lossy(&bytes[..bytes.len().min(120)])
            ),
        })
    }
}

fn parse_retry_after(h: &HeaderMap) -> Option<Duration> {
    let v = h.get("retry-after")?.to_str().ok()?.trim().to_string();
    v.parse::<f64>()
        .ok()
        .filter(|s| s.is_finite() && *s >= 0.0)
        .map(Duration::from_secs_f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retry_rules_follow_the_contract() {
        assert!(retryable_status(
            &Method::GET,
            StatusCode::SERVICE_UNAVAILABLE
        ));
        assert!(retryable_status(&Method::DELETE, StatusCode::BAD_GATEWAY));
        assert!(!retryable_status(
            &Method::POST,
            StatusCode::SERVICE_UNAVAILABLE
        ));
        assert!(retryable_status(
            &Method::POST,
            StatusCode::TOO_MANY_REQUESTS
        ));
        assert!(!retryable_status(&Method::GET, StatusCode::NOT_FOUND));
    }

    #[test]
    fn origins_compare_scheme_host_and_port() {
        let a = Url::parse("http://h:8787/a").unwrap();
        assert!(same_origin(&a, &Url::parse("http://h:8787/b").unwrap()));
        assert!(!same_origin(&a, &Url::parse("https://h:8787/b").unwrap()));
        assert!(!same_origin(
            &a,
            &Url::parse("http://other:8787/b").unwrap()
        ));
        assert!(same_origin(
            &Url::parse("https://h/a").unwrap(),
            &Url::parse("https://h:443/b").unwrap()
        ));
    }

    #[test]
    fn presigned_queries_are_redacted() {
        let u = Url::parse("http://h/blobs/x?exp=1&sig=abc").unwrap();
        assert!(!Transport::display_url(&u).contains("abc"));
        let plain = Url::parse("http://h/v1/runs?limit=5").unwrap();
        assert!(Transport::display_url(&plain).contains("limit=5"));
    }

    #[test]
    fn retry_after_seconds() {
        let mut h = HeaderMap::new();
        h.insert("retry-after", HeaderValue::from_static("2"));
        assert_eq!(parse_retry_after(&h), Some(Duration::from_secs(2)));
        h.insert(
            "retry-after",
            HeaderValue::from_static("Wed, 21 Oct 2015 07:28:00 GMT"),
        );
        assert_eq!(parse_retry_after(&h), None);
    }
}
