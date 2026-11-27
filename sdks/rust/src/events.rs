//! Run lifecycle events (`GET /v1/runs/{id}/events`): a typed [`RunEvent`]
//! enum tagged by the wire `type`, and [`RunEventStream`], which streams them
//! live over Server-Sent Events (reconnecting with `Last-Event-ID`, never
//! repeating an event) or pages the recorded ones.
//!
//! [`RunEvent`] is hand-written rather than generated: serde's internally
//! tagged enum gives `match ev { RunEvent::Phase(p) => .. }`, which the
//! generator's merged structs can't.

use reqwest::Method;
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::Duration;

use crate::error::{Error, Result};
use crate::models::{
    ArtifactFormat, InterruptionReason, MetricPoint, Run, RunInterruption, RunPhase, RunStatus,
};
use crate::sse::SseParser;
use crate::transport::{Deadline, Req, Transport};
use crate::util;

/// The fields every run event carries.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct EventMeta {
    pub run_id: String,
    /// Position in the run's event sequence (the SSE id; `completed` repeats the last one).
    pub seq: i64,
    pub attempt: i64,
    pub timestamp: String,
}

/// The claiming worker's GPU (on the `starting` phase).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct GpuInfo {
    pub name: String,
    pub memory_gb: f64,
}

/// A run entered a lifecycle phase.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct PhaseEvent {
    #[serde(flatten)]
    pub meta: EventMeta,
    pub phase: RunPhase,
    /// Training step when the phase began.
    pub step: i64,
    /// queued/waiting_for_compute: workers of this kind holding a lease (all busy).
    pub workers_online: Option<i64>,
    /// queued/waiting_for_compute: workers scale from zero, so one is starting.
    pub autoscaling: Option<bool>,
    /// starting: the worker's GPU (never its id or host).
    pub gpu: Option<GpuInfo>,
}

/// One training step's metrics.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RunMetricEvent {
    #[serde(flatten)]
    pub meta: EventMeta,
    pub step: i64,
    pub metric: MetricPoint,
}

/// A checkpoint was saved.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CheckpointEvent {
    #[serde(flatten)]
    pub meta: EventMeta,
    pub step: i64,
    pub checkpoint_id: String,
    pub eval_score: Option<f64>,
    pub format: Option<ArtifactFormat>,
}

/// What happened to an attempt.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AttemptKind {
    /// A worker claimed the attempt (`resume_step`: the checkpoint it resumes from).
    #[default]
    Started,
    /// The attempt ended without a result at `step` (`resume_step`: where the next resumes).
    Interrupted,
    /// No attempts left; the run failed.
    GaveUp,
    /// A kind this SDK version does not know.
    #[serde(other)]
    Other,
}

/// An attempt started, was interrupted, or the run gave up.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct AttemptEvent {
    #[serde(flatten)]
    pub meta: EventMeta,
    pub event: AttemptKind,
    pub reason: Option<InterruptionReason>,
    pub step: Option<i64>,
    pub resume_step: Option<i64>,
    pub max_attempts: i64,
    /// A ready-made line, e.g. "attempt 1 interrupted at step 120: the GPU was reclaimed; resuming from step 120 on a new worker".
    pub message: String,
}

/// A warning or log line.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct MessageEvent {
    #[serde(flatten)]
    pub meta: EventMeta,
    pub step: Option<i64>,
    pub message: String,
}

/// The run reached a terminal status; always the last event.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct CompletedEvent {
    #[serde(flatten)]
    pub meta: EventMeta,
    pub status: RunStatus,
    pub run: Run,
}

/// One lifecycle event of a run, tagged by its wire `type`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum RunEvent {
    Phase(PhaseEvent),
    Metric(RunMetricEvent),
    Checkpoint(CheckpointEvent),
    Attempt(AttemptEvent),
    Warning(MessageEvent),
    Log(MessageEvent),
    Completed(Box<CompletedEvent>),
    /// A type this SDK version does not know (skipped by [`RunEventStream`]).
    #[serde(other)]
    Unknown,
}

impl RunEvent {
    /// The fields every event has (`None` for [`RunEvent::Unknown`]).
    pub fn meta(&self) -> Option<&EventMeta> {
        Some(match self {
            RunEvent::Phase(e) => &e.meta,
            RunEvent::Metric(e) => &e.meta,
            RunEvent::Checkpoint(e) => &e.meta,
            RunEvent::Attempt(e) => &e.meta,
            RunEvent::Warning(e) | RunEvent::Log(e) => &e.meta,
            RunEvent::Completed(e) => &e.meta,
            RunEvent::Unknown => return None,
        })
    }

    /// The event's sequence number (0 for unknown events).
    pub fn seq(&self) -> i64 {
        self.meta().map_or(0, |m| m.seq)
    }

    /// The wire `type`.
    pub fn type_name(&self) -> &'static str {
        match self {
            RunEvent::Phase(_) => "phase",
            RunEvent::Metric(_) => "metric",
            RunEvent::Checkpoint(_) => "checkpoint",
            RunEvent::Attempt(_) => "attempt",
            RunEvent::Warning(_) => "warning",
            RunEvent::Log(_) => "log",
            RunEvent::Completed(_) => "completed",
            RunEvent::Unknown => "unknown",
        }
    }

    /// Applies this event to a run snapshot: phase, status, last interruption,
    /// or the final run on `completed`.
    pub fn apply(&self, run: &mut Run) {
        match self {
            RunEvent::Completed(done) => *run = done.run.clone(),
            RunEvent::Phase(p) => {
                run.phase = Some(p.phase.clone());
                run.phase_since = Some(p.meta.timestamp.clone());
                if !run.status.is_terminal() {
                    run.status =
                        if matches!(p.phase, RunPhase::Queued | RunPhase::WaitingForCompute) {
                            RunStatus::Queued
                        } else {
                            RunStatus::Running
                        };
                }
            }
            RunEvent::Attempt(a) if a.event == AttemptKind::Interrupted => {
                if let Some(reason) = &a.reason {
                    run.last_interruption = Some(RunInterruption {
                        attempt: a.meta.attempt,
                        reason: reason.clone(),
                        step: a.step.unwrap_or(0),
                        resume_step: a.resume_step,
                        at: a.meta.timestamp.clone(),
                        message: a.message.clone(),
                    });
                }
            }
            _ => {}
        }
    }
}

/// A JSON page of run events.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct RunEventsPage {
    pub run_id: String,
    pub status: RunStatus,
    pub data: Vec<RunEvent>,
    pub next_cursor: Option<String>,
    pub tail_cursor: String,
}

/// A run's events. Call [`RunEventStream::next`] until it returns `None`.
pub struct RunEventStream {
    transport: Transport,
    run_id: String,
    follow: bool,
    limit: Option<i64>,
    last_event_id: Option<String>,
    last_seq: i64,
    cursor: Option<String>,
    seen_cursors: std::collections::HashSet<String>,
    resp: Option<reqwest::Response>,
    parser: SseParser,
    pending: VecDeque<RunEvent>,
    done: bool,
    failures: u32,
    max_reconnects: u32,
    reconnect_base: Duration,
}

impl RunEventStream {
    pub(crate) fn new(transport: Transport, run_id: String, follow: bool) -> Self {
        RunEventStream {
            transport,
            run_id,
            follow,
            limit: None,
            last_event_id: None,
            last_seq: 0,
            cursor: None,
            seen_cursors: Default::default(),
            resp: None,
            parser: SseParser::new(),
            pending: VecDeque::new(),
            done: false,
            failures: 0,
            max_reconnects: 8,
            reconnect_base: Duration::from_millis(500),
        }
    }

    /// Page size of the JSON pages (without follow).
    pub fn limit(mut self, n: i64) -> Self {
        self.limit = Some(n);
        self
    }

    /// Resume after this event id (a `seq`).
    pub fn after(mut self, last_event_id: impl Into<String>) -> Self {
        let id = last_event_id.into();
        self.last_seq = id.parse().unwrap_or(0);
        self.last_event_id = Some(id);
        self
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

    /// The last event id received (sent as `Last-Event-ID` on reconnect).
    pub fn last_event_id(&self) -> Option<&str> {
        self.last_event_id.as_deref()
    }

    fn path(&self) -> String {
        format!("/v1/runs/{}/events", util::encode_segment(&self.run_id))
    }

    async fn connect(&mut self) -> Result<()> {
        let mut req = Req::new(Method::GET, self.path());
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

    async fn next_page(&mut self) -> Result<()> {
        let req = Req::get(self.path())
            .opt_param("cursor", self.cursor.clone())
            .opt_param("limit", self.limit);
        let page: RunEventsPage = self.transport.json(req).await?;
        self.pending.extend(
            page.data
                .into_iter()
                .filter(|e| !matches!(e, RunEvent::Unknown)),
        );
        match page.next_cursor.filter(|c| !c.is_empty()) {
            Some(next) if !self.pending.is_empty() => {
                if !self.seen_cursors.insert(next.clone()) {
                    return Err(Error::PaginationLoop {
                        path: self.path(),
                        cursor: next,
                    });
                }
                self.cursor = Some(next);
            }
            _ => self.done = true,
        }
        Ok(())
    }

    /// The events as a [`futures_core::Stream`], for `StreamExt` combinators
    /// (`while let Some(ev) = stream.next().await`, `take_while`, `select`).
    pub fn into_stream(self) -> impl futures_core::Stream<Item = Result<RunEvent>> + Send {
        EventsStream {
            state: Some(self),
            next: None,
        }
    }

    /// The next event; `None` after `completed` (or the last page without follow).
    pub async fn next(&mut self) -> Option<Result<RunEvent>> {
        loop {
            if let Some(ev) = self.pending.pop_front() {
                if matches!(ev, RunEvent::Completed(_)) {
                    self.pending.clear();
                    self.done = true;
                    self.resp = None;
                }
                return Some(Ok(ev));
            }
            if self.done {
                return None;
            }
            if !self.follow {
                if let Err(e) = self.next_page().await {
                    self.done = true;
                    return Some(Err(e));
                }
                continue;
            }
            if self.resp.is_none() {
                if let Err(e) = self.connect().await {
                    if e.is_transient() && self.failures < self.max_reconnects {
                        self.backoff().await;
                        continue;
                    }
                    self.done = true;
                    return Some(Err(e));
                }
            }
            let resp = self.resp.as_mut().expect("connected");
            match resp.chunk().await {
                Ok(Some(bytes)) => {
                    for sse in self.parser.feed(&bytes) {
                        let ev = match serde_json::from_str::<RunEvent>(&sse.data) {
                            Ok(RunEvent::Unknown) => continue,
                            Ok(ev) => ev,
                            Err(_) if sse.event != "completed" && !is_known(&sse.event) => continue,
                            Err(e) => {
                                self.done = true;
                                return Some(Err(Error::Decode {
                                    method: "GET".into(),
                                    url: self.path(),
                                    message: format!("invalid {} event: {}", sse.event, e),
                                }));
                            }
                        };
                        self.failures = 0;
                        if !matches!(ev, RunEvent::Completed(_)) {
                            if let Some(id) = &sse.id {
                                self.last_event_id = Some(id.clone());
                            }
                            if ev.seq() <= self.last_seq {
                                continue;
                            }
                            self.last_seq = ev.seq();
                        }
                        self.pending.push_back(ev);
                    }
                }
                Ok(None) | Err(_) => {
                    // Closed before `completed`: reconnect and resume.
                    self.resp = None;
                    if self.failures >= self.max_reconnects {
                        self.done = true;
                        return Some(Err(Error::Connection {
                            method: "GET".into(),
                            url: format!("{}{}", self.transport.base_url, self.path()),
                            cause: format!(
                                "events stream dropped {} times in a row",
                                self.failures
                            ),
                        }));
                    }
                    self.backoff().await;
                }
            }
        }
    }

    async fn backoff(&mut self) {
        let delay = util::backoff(self.failures, self.reconnect_base, Duration::from_secs(10));
        self.failures += 1;
        tokio::time::sleep(delay).await;
    }
}

fn is_known(event: &str) -> bool {
    matches!(
        event,
        "phase" | "metric" | "checkpoint" | "attempt" | "warning" | "log"
    )
}

type NextFuture = std::pin::Pin<
    Box<dyn std::future::Future<Output = (RunEventStream, Option<Result<RunEvent>>)> + Send>,
>;

/// [`RunEventStream::into_stream`]: one `next()` in flight at a time.
struct EventsStream {
    state: Option<RunEventStream>,
    next: Option<NextFuture>,
}

impl futures_core::Stream for EventsStream {
    type Item = Result<RunEvent>;

    fn poll_next(
        mut self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        if self.next.is_none() {
            let Some(mut events) = self.state.take() else {
                return std::task::Poll::Ready(None);
            };
            self.next = Some(Box::pin(async move {
                let ev = events.next().await;
                (events, ev)
            }));
        }
        let fut = self.next.as_mut().expect("a pending next()");
        match fut.as_mut().poll(cx) {
            std::task::Poll::Pending => std::task::Poll::Pending,
            std::task::Poll::Ready((events, ev)) => {
                self.next = None;
                if ev.is_some() {
                    self.state = Some(events);
                }
                std::task::Poll::Ready(ev)
            }
        }
    }
}
