//! Server-Sent Events: a small spec-compliant parser and the run metrics
//! stream (`GET /v1/runs/{id}/metrics` with `Accept: text/event-stream`).
//!
//! The server sends `metric` events (id = metric `seq`) and one final
//! `status` event carrying the terminal Run. When the connection drops before
//! that, the stream reconnects with `Last-Event-ID` and exponential backoff.

use reqwest::Method;
use std::time::Duration;

use crate::error::{Error, Result};
use crate::models::{MetricPoint, Run};
use crate::transport::{Deadline, Req, Transport};
use crate::util;

/// One parsed SSE event.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct SseEvent {
    pub event: String,
    pub data: String,
    pub id: Option<String>,
    pub retry: Option<u64>,
}

/// Incremental SSE parser (feed bytes, pull events).
#[derive(Debug, Default)]
pub struct SseParser {
    buf: Vec<u8>,
    event: String,
    data: Vec<String>,
    id: Option<String>,
    retry: Option<u64>,
    has_fields: bool,
}

impl SseParser {
    pub fn new() -> Self {
        Self::default()
    }

    /// Feed bytes; returns the events completed by them.
    pub fn feed(&mut self, chunk: &[u8]) -> Vec<SseEvent> {
        self.buf.extend_from_slice(chunk);
        let mut out = Vec::new();
        while let Some(pos) = self.buf.iter().position(|b| *b == b'\n' || *b == b'\r') {
            // A lone trailing '\r' may be the first half of "\r\n": wait for more bytes.
            if self.buf[pos] == b'\r' && pos + 1 == self.buf.len() {
                break;
            }
            let line: Vec<u8> = self.buf[..pos].to_vec();
            let skip = if self.buf[pos] == b'\r' && self.buf.get(pos + 1) == Some(&b'\n') {
                2
            } else {
                1
            };
            self.buf.drain(..pos + skip);
            let line = String::from_utf8_lossy(&line).into_owned();
            if let Some(ev) = self.line(&line) {
                out.push(ev);
            }
        }
        out
    }

    fn line(&mut self, line: &str) -> Option<SseEvent> {
        if line.is_empty() {
            if !self.has_fields {
                return None;
            }
            let ev = SseEvent {
                event: if self.event.is_empty() {
                    "message".into()
                } else {
                    std::mem::take(&mut self.event)
                },
                data: std::mem::take(&mut self.data).join("\n"),
                id: self.id.clone(),
                retry: self.retry.take(),
            };
            self.has_fields = false;
            return Some(ev);
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = match line.find(':') {
            Some(i) => {
                let v = &line[i + 1..];
                (&line[..i], v.strip_prefix(' ').unwrap_or(v))
            }
            None => (line, ""),
        };
        match field {
            "event" => {
                self.event = value.to_string();
                self.has_fields = true;
            }
            "data" => {
                self.data.push(value.to_string());
                self.has_fields = true;
            }
            "id" => {
                if !value.contains('\0') {
                    self.id = Some(value.to_string());
                }
            }
            "retry" => {
                if let Ok(ms) = value.parse() {
                    self.retry = Some(ms);
                }
            }
            _ => {}
        }
        None
    }
}

/// An item of the metrics stream.
#[derive(Debug, Clone, PartialEq)]
pub enum MetricEvent {
    /// One training-step metric point.
    Metric(Box<MetricPoint>),
    /// The run reached a terminal state; the stream ends after this.
    Finished(Box<Run>),
}

/// Live metrics of one run. Call [`MetricStream::next`] until it returns `None`.
pub struct MetricStream {
    transport: Transport,
    run_id: String,
    last_event_id: Option<String>,
    resp: Option<reqwest::Response>,
    parser: SseParser,
    pending: std::collections::VecDeque<MetricEvent>,
    done: bool,
    failures: u32,
    max_reconnects: u32,
    reconnect_base: Duration,
}

impl MetricStream {
    pub(crate) fn new(transport: Transport, run_id: String, last_event_id: Option<String>) -> Self {
        MetricStream {
            transport,
            run_id,
            last_event_id,
            resp: None,
            parser: SseParser::new(),
            pending: std::collections::VecDeque::new(),
            done: false,
            failures: 0,
            max_reconnects: 8,
            reconnect_base: Duration::from_millis(500),
        }
    }

    /// How many consecutive failed reconnects to tolerate (default 8).
    pub fn max_reconnects(mut self, n: u32) -> Self {
        self.max_reconnects = n;
        self
    }

    /// Base delay of the reconnect backoff (default 500 ms).
    pub fn reconnect_base(mut self, d: Duration) -> Self {
        self.reconnect_base = d;
        self
    }

    /// The last metric `seq` received (sent as `Last-Event-ID` on reconnect).
    pub fn last_event_id(&self) -> Option<&str> {
        self.last_event_id.as_deref()
    }

    async fn connect(&mut self) -> Result<()> {
        let mut req = Req::new(
            Method::GET,
            format!("/v1/runs/{}/metrics", util::encode_segment(&self.run_id)),
        );
        req.accept = Some("text/event-stream");
        req.deadline = Deadline::Streaming;
        if let Some(id) = &self.last_event_id {
            req.headers.push(("last-event-id".into(), id.clone()));
        }
        let resp = self.transport.send(&req).await?;
        let ctype = resp
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
            .to_string();
        if !ctype.starts_with("text/event-stream") {
            return Err(Error::Decode {
                method: "GET".into(),
                url: resp.url().to_string(),
                message: format!(
                    "expected a text/event-stream response, got '{}' (a proxy may be buffering the stream)",
                    ctype
                ),
            });
        }
        self.parser = SseParser::new();
        self.resp = Some(resp);
        Ok(())
    }

    /// Next metric or the final status; `None` once the run finished.
    pub async fn next(&mut self) -> Option<Result<MetricEvent>> {
        loop {
            if let Some(ev) = self.pending.pop_front() {
                if matches!(ev, MetricEvent::Finished(_)) {
                    self.pending.clear();
                    self.done = true;
                    self.resp = None;
                }
                return Some(Ok(ev));
            }
            if self.done {
                return None;
            }
            if self.resp.is_none() {
                if let Err(e) = self.connect().await {
                    if e.is_transient() && self.failures < self.max_reconnects {
                        let delay = util::backoff(
                            self.failures,
                            self.reconnect_base,
                            Duration::from_secs(10),
                        );
                        self.failures += 1;
                        tokio::time::sleep(delay).await;
                        continue;
                    }
                    self.done = true;
                    return Some(Err(e));
                }
            }
            let resp = self.resp.as_mut().expect("connected");
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    for ev in self.parser.feed(&bytes) {
                        if let Some(id) = &ev.id {
                            self.last_event_id = Some(id.clone());
                        }
                        match ev.event.as_str() {
                            "metric" => match serde_json::from_str::<MetricPoint>(&ev.data) {
                                Ok(p) => {
                                    self.failures = 0;
                                    self.pending.push_back(MetricEvent::Metric(Box::new(p)));
                                }
                                Err(e) => {
                                    self.done = true;
                                    return Some(Err(Error::Decode {
                                        method: "GET".into(),
                                        url: format!("/v1/runs/{}/metrics", self.run_id),
                                        message: format!("invalid metric event: {}", e),
                                    }));
                                }
                            },
                            "status" => match serde_json::from_str::<Run>(&ev.data) {
                                Ok(run) => {
                                    self.pending.push_back(MetricEvent::Finished(Box::new(run)))
                                }
                                Err(e) => {
                                    self.done = true;
                                    return Some(Err(Error::Decode {
                                        method: "GET".into(),
                                        url: format!("/v1/runs/{}/metrics", self.run_id),
                                        message: format!("invalid status event: {}", e),
                                    }));
                                }
                            },
                            _ => {}
                        }
                    }
                }
                Ok(None) | Err(_) => {
                    // Stream ended before the status event: reconnect and resume.
                    self.resp = None;
                    if self.failures >= self.max_reconnects {
                        self.done = true;
                        return Some(Err(Error::Connection {
                            method: "GET".into(),
                            url: format!(
                                "{}/v1/runs/{}/metrics",
                                self.transport.base_url, self.run_id
                            ),
                            cause: format!(
                                "metrics stream dropped {} times in a row",
                                self.failures
                            ),
                        }));
                    }
                    let delay =
                        util::backoff(self.failures, self.reconnect_base, Duration::from_secs(10));
                    self.failures += 1;
                    tokio::time::sleep(delay).await;
                }
            }
        }
    }
}
