//! Full-screen follower for a training run (`grad train --wait`, `grad runs watch`).
//!
//! [`Model`] folds the run, its lifecycle events and its checkpoints into
//! view state; [`draw`] renders it (pure, snapshot-tested with `TestBackend`);
//! [`follow`] owns the terminal.
//!
//! Look: a calm, mostly monochrome screen in the spirit of bottom and gitui.
//! Text uses the terminal's own foreground on its own background; secondary
//! text is dimmed (never greyed by RGB), so light and dark themes both work.
//! One accent (cyan) marks what is moving (spinner, progress, train loss),
//! magenta the eval series; green, yellow and red only carry state (done,
//! attention, failure). `NO_COLOR` drops the colours.

use std::collections::{HashSet, VecDeque};
use std::io::{IsTerminal, Stdout};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::{cursor, execute, terminal};
use grad_sdk::{
    Checkpoint, Client, Error as SdkError, ListParams, MetricPoint, Run, RunEvent as SdkEvent,
    RunStatus,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Flex, Layout, Margin, Rect};
use ratatui::style::{Color, Modifier, Style};
use ratatui::symbols::Marker;
use ratatui::text::{Line, Span};
use ratatui::widgets::{
    Axis, Block, BorderType, Borders, Chart, Clear, Dataset, GraphType, Padding, Paragraph,
    Sparkline,
};
use ratatui::{Frame, Terminal};
use tokio::sync::mpsc::{unbounded_channel, UnboundedSender};

use crate::commands::train::{fmt_duration, parse_ts};
use crate::output::{compact, num, pct, thousands, usd, CliError};

use wire::{AttemptKind, Gpu, Phase, RunEvent};

// ---------------------------------------------------------------- palette

const ACCENT: Color = Color::Cyan;
const EVAL: Color = Color::Magenta;
const GOOD: Color = Color::Green;
const WARN: Color = Color::Yellow;
const BAD: Color = Color::Red;
const SPINNER: [&str; 8] = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧"];

fn no_color() -> bool {
    static NO: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
    *NO.get_or_init(|| std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty()))
}

fn fg(c: Color) -> Style {
    if no_color() {
        Style::new()
    } else {
        Style::new().fg(c)
    }
}

fn dim() -> Style {
    Style::new().add_modifier(Modifier::DIM)
}

fn bold() -> Style {
    Style::new().add_modifier(Modifier::BOLD)
}

#[derive(Debug, Clone, Copy, PartialEq)]
enum Tone {
    Plain,
    Quiet,
    Good,
    Warn,
    Bad,
}

impl Tone {
    fn style(self) -> Style {
        match self {
            Tone::Plain => Style::new(),
            Tone::Quiet => dim(),
            Tone::Good => fg(GOOD),
            Tone::Warn => fg(WARN),
            Tone::Bad => fg(BAD),
        }
    }
}

// ---------------------------------------------------------------- wire

/// The run lifecycle events of `GET /v1/runs/{id}/events`, in the shapes
/// agreed with the lifecycle work (review/r5-coordination.md: `phase`,
/// `metric`, `checkpoint`, `attempt`, `warning`, `log`, `completed`).
///
/// The driver reads them from the SDK's `runs().events(id, true)` (from the
/// first event, so attaching mid-run backfills the whole history) and
/// converts each with [`RunEvent::from_sdk`]; the render tests replay a
/// recording of the events endpoint.
pub(crate) mod wire {
    use grad_sdk::{MetricPoint, Run};
    use serde::Deserialize;

    #[derive(Debug, Clone, Default, PartialEq, Deserialize)]
    #[serde(default)]
    pub struct Meta {
        pub seq: i64,
        pub attempt: i64,
        pub timestamp: String,
    }

    /// `queued` .. `completing`; training, evaluating and checkpointing repeat.
    #[derive(Debug, Clone, PartialEq, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum Phase {
        Queued,
        WaitingForCompute,
        Starting,
        LoadingModel,
        Training,
        Evaluating,
        Checkpointing,
        Uploading,
        Completing,
        #[serde(other)]
        Other,
    }

    #[derive(Debug, Clone, PartialEq, Deserialize)]
    pub struct Gpu {
        pub name: String,
        #[serde(default)]
        pub memory_gb: f64,
    }

    #[derive(Debug, Clone, PartialEq, Deserialize)]
    #[serde(rename_all = "snake_case")]
    pub enum AttemptKind {
        Started,
        Interrupted,
        GaveUp,
        #[serde(other)]
        Other,
    }

    #[derive(Debug, Clone, PartialEq, Deserialize)]
    #[serde(tag = "type", rename_all = "snake_case")]
    pub enum RunEvent {
        Phase {
            #[serde(flatten)]
            meta: Meta,
            phase: Phase,
            #[serde(default)]
            workers_online: Option<i64>,
            #[serde(default)]
            autoscaling: Option<bool>,
            /// queued/waiting_for_compute: why the run waits ("Queued behind 3 runs").
            #[serde(default)]
            message: Option<String>,
            #[serde(default)]
            gpu: Option<Gpu>,
        },
        Metric {
            #[serde(flatten)]
            meta: Meta,
            metric: MetricPoint,
        },
        Checkpoint {
            #[serde(flatten)]
            meta: Meta,
            step: i64,
        },
        Attempt {
            #[serde(flatten)]
            meta: Meta,
            event: AttemptKind,
            #[serde(default)]
            step: Option<i64>,
            #[serde(default)]
            resume_step: Option<i64>,
            #[serde(default)]
            max_attempts: i64,
            #[serde(default)]
            message: String,
        },
        Warning {
            #[serde(flatten)]
            meta: Meta,
            message: String,
        },
        Log {
            #[serde(flatten)]
            meta: Meta,
            message: String,
        },
        Completed {
            #[serde(flatten)]
            meta: Meta,
            run: Box<Run>,
        },
        #[serde(other)]
        Unknown,
    }

    impl RunEvent {
        pub fn meta(&self) -> Option<&Meta> {
            match self {
                RunEvent::Phase { meta, .. }
                | RunEvent::Metric { meta, .. }
                | RunEvent::Checkpoint { meta, .. }
                | RunEvent::Attempt { meta, .. }
                | RunEvent::Warning { meta, .. }
                | RunEvent::Log { meta, .. }
                | RunEvent::Completed { meta, .. } => Some(meta),
                RunEvent::Unknown => None,
            }
        }

        /// The SDK's event in these shapes (the same wire JSON).
        pub fn from_sdk(ev: &grad_sdk::RunEvent) -> Option<RunEvent> {
            serde_json::to_value(ev)
                .ok()
                .and_then(|v| serde_json::from_value(v).ok())
        }

        /// A polled run's latest point as a `metric` event.
        pub fn metric(p: MetricPoint) -> RunEvent {
            let meta = Meta {
                seq: p.seq,
                attempt: p.attempt,
                timestamp: p.timestamp.clone(),
            };
            RunEvent::Metric { meta, metric: p }
        }
    }
}

// ---------------------------------------------------------------- model

/// One chart sample; the full metric point is kept only for the latest step.
#[derive(Debug, Clone, Copy)]
struct Sample {
    step: i64,
    loss: f64,
    eval: Option<f64>,
    lr: Option<f64>,
}

#[derive(Debug, Clone)]
struct LogLine {
    at: i64,
    tone: Tone,
    text: String,
}

#[derive(Debug, Clone, PartialEq)]
enum Link {
    Live,
    Down(String),
    Polling,
}

/// What a key press asks the driver to do.
#[derive(Debug, PartialEq)]
pub enum Action {
    None,
    Detach,
    Cancel,
}

/// The server's lifecycle phase, once it reports one.
#[derive(Debug, Clone)]
struct Life {
    phase: Phase,
    since: i64,
    workers_online: Option<i64>,
    autoscaling: Option<bool>,
    /// Why a queued run waits, from its phase event (the polled run's is live).
    message: Option<String>,
    gpu: Option<Gpu>,
}

/// What a queued phase event carries besides the phase.
type QueueInfo = (Option<i64>, Option<bool>, Option<String>, Option<Gpu>);

/// What the phase line shows.
#[derive(Debug, Clone, PartialEq)]
struct PhaseView {
    /// Stable per phase: a new key restarts the "for" clock and logs the label.
    key: &'static str,
    label: String,
    /// Secondary text after the label, e.g. where a new attempt resumes.
    note: Option<String>,
    tone: Tone,
}

/// Samples kept before thinning every other one (the chart downsamples to its width).
const MAX_SAMPLES: usize = 200_000;
const MAX_LOG: usize = 500;

/// View state of one followed run.
pub struct Model {
    run: Run,
    samples: Vec<Sample>,
    checkpoints: Vec<Checkpoint>,
    log: VecDeque<LogLine>,
    seen_seq: i64,
    /// Lifecycle events folded so far (polled phases apply only before the first).
    seen_events: u64,
    /// (epoch ms, step, tokens) of recent points in the current attempt.
    window: VecDeque<(i64, i64, i64)>,
    tok_per_sec: Option<f64>,
    /// Set once the server reports phases; until then the phase is derived.
    life: Option<Life>,
    phase_key: &'static str,
    phase_since: i64,
    /// (attempt, step it resumes from; None = from scratch) after an interruption.
    resume: Option<(i64, Option<i64>)>,
    /// The highest attempt whose interruption is in the log.
    logged_attempt: i64,
    /// The highest attempt whose "Training" is in the log.
    trained_attempt: i64,
    warnings: HashSet<String>,
    started: i64,
    now: i64,
    tick: usize,
    link: Link,
    notice: Option<(Tone, String)>,
    /// A checkpoint was written: the driver refetches the list.
    pub checkpoints_stale: bool,
    pub show_logs: bool,
    pub help: bool,
    pub confirm: bool,
}

impl Model {
    pub fn new(run: Run, now: i64) -> Self {
        let started = parse_ts(&run.created_at).unwrap_or(now);
        let mut m = Model {
            samples: Vec::new(),
            checkpoints: Vec::new(),
            log: VecDeque::new(),
            seen_seq: 0,
            seen_events: 0,
            window: VecDeque::new(),
            tok_per_sec: None,
            life: None,
            phase_key: "queued",
            phase_since: started,
            resume: None,
            logged_attempt: 0,
            trained_attempt: 0,
            warnings: HashSet::new(),
            started,
            now,
            tick: 0,
            link: Link::Live,
            notice: None,
            checkpoints_stale: false,
            show_logs: false,
            help: false,
            confirm: false,
            run,
        };
        m.push_log(started, Tone::Quiet, "Run created".into());
        if m.run.status.is_terminal() {
            let text = m.status_text();
            m.push_log(now, m.status_tone(), text);
        }
        // The server's phase and when it began, until the event history
        // (replayed from the first event) takes over. The chart fills from
        // that history too, not from the run's latest point.
        m.life = life_of(&m.run);
        let v = m.phase();
        m.phase_key = v.key;
        m.phase_since = m.life.as_ref().map_or(now, |l| l.since);
        m
    }

    /// Advance the clock and spinner.
    pub fn tick(&mut self, now: i64) {
        self.now = now;
        self.tick = self.tick.wrapping_add(1);
        self.sync_phase();
    }

    fn push_log(&mut self, at: i64, tone: Tone, text: String) {
        if self.log.len() == MAX_LOG {
            self.log.pop_front();
        }
        self.log.push_back(LogLine { at, tone, text });
    }

    fn warn_once(&mut self, at: i64, text: String) {
        if self.warnings.insert(text.clone()) {
            self.push_log(at, Tone::Warn, text);
        }
    }

    /// Restart the phase clock on a new phase and log the ones worth a line.
    fn sync_phase(&mut self) {
        let v = self.phase();
        if v.key == self.phase_key {
            return;
        }
        self.phase_key = v.key;
        self.phase_since = self.life.as_ref().map_or(self.now, |l| l.since);
        let worth = match v.key {
            "waiting" | "starting" | "loading" | "uploading" => true,
            "training" => self.trained_attempt < self.run.attempt.max(1),
            _ => false,
        };
        if v.key == "training" {
            self.trained_attempt = self.run.attempt.max(1);
        }
        if worth {
            let at = self.phase_since;
            self.push_log(at, Tone::Quiet, v.label);
        }
    }

    fn status_tone(&self) -> Tone {
        match self.run.status {
            RunStatus::Completed => Tone::Good,
            RunStatus::Failed => Tone::Bad,
            RunStatus::Cancelled | RunStatus::StoppedBudget | RunStatus::StoppedBalance => {
                Tone::Warn
            }
            _ => Tone::Plain,
        }
    }

    fn status_text(&self) -> String {
        let r = &self.run;
        match &r.status {
            RunStatus::Queued => "Queued".into(),
            RunStatus::Running => format!("Running, attempt {}", attempt_of(r)),
            RunStatus::Completed => "Run completed".into(),
            RunStatus::Failed => format!(
                "Run failed{}",
                r.error
                    .as_deref()
                    .map(|e| format!(": {}", e))
                    .unwrap_or_default()
            ),
            RunStatus::Cancelled => "Run cancelled".into(),
            RunStatus::StoppedBudget => {
                format!("Stopped at the cost cap ({} spent)", usd(r.cost_usd))
            }
            RunStatus::StoppedBalance => {
                format!("Stopped: out of balance ({} spent)", usd(r.cost_usd))
            }
            RunStatus::Other(s) => format!("Status {}", s),
        }
    }

    /// Latest checkpoint at or before `step` (where an attempt resumes from).
    fn resume_step(&self, step: i64) -> Option<i64> {
        self.checkpoints
            .iter()
            .map(|c| c.step)
            .filter(|s| *s <= step)
            .max()
    }

    /// Move to attempt `n`. Servers without lifecycle events don't say why
    /// the last attempt ended, so the log says only where the next resumes.
    fn new_attempt(&mut self, n: i64) {
        if n <= self.run.attempt {
            return;
        }
        let old = self.run.attempt;
        if self.life.is_none() && self.logged_attempt < old {
            let at = self.run.current_step;
            let from = self.resume_step(at);
            self.resume = Some((n, from));
            let next = match from {
                Some(s) => format!("resumes from step {}", thousands(s)),
                None => "starts from step 0".into(),
            };
            self.push_log(
                self.now,
                Tone::Warn,
                format!(
                    "Attempt {} was interrupted at step {}; attempt {} {}",
                    old,
                    thousands(at),
                    n,
                    next
                ),
            );
        }
        self.logged_attempt = self.logged_attempt.max(old);
        self.run.attempt = n;
        self.window.clear();
        self.tok_per_sec = None;
    }

    fn set_phase(&mut self, phase: Phase, at: i64, ev: Option<QueueInfo>) {
        // Evaluating and checkpointing interrupt training briefly, and
        // waiting_for_compute only says a queued run is still unclaimed:
        // one clock for each family.
        let family = |a: &Phase, b: &Phase| {
            let train = |p: &Phase| {
                matches!(
                    p,
                    Phase::Training | Phase::Evaluating | Phase::Checkpointing
                )
            };
            let queue = |p: &Phase| matches!(p, Phase::Queued | Phase::WaitingForCompute);
            (train(a) && train(b)) || (queue(a) && queue(b))
        };
        let prev = self.life.take();
        let same = prev.as_ref().is_some_and(|l| l.phase == phase);
        let since = prev
            .as_ref()
            .filter(|l| same || family(&l.phase, &phase))
            .map_or(at, |l| l.since);
        let (workers_online, autoscaling, message, gpu) = match ev {
            Some(x) => x,
            None => (None, None, None, prev.filter(|_| same).and_then(|l| l.gpu)),
        };
        self.life = Some(Life {
            phase,
            since,
            workers_online,
            autoscaling,
            message,
            gpu,
        });
    }

    /// Fold a fresh run object (from polling or the final status).
    pub fn apply_run(&mut self, r: Run) {
        if r.attempt > self.run.attempt {
            self.new_attempt(r.attempt);
        }
        let changed = r.status != self.run.status;
        let streamed_step = self
            .samples
            .last()
            .map(|s| s.step)
            .filter(|_| r.attempt == self.run.attempt);
        let (cost, tokens) = (self.run.cost_usd, self.run.tokens_processed);
        if self.seen_events == 0 {
            if let Some(l) = life_of(&r) {
                let gpu = self.life.take().and_then(|o| o.gpu);
                self.life = Some(Life { gpu, ..l });
            }
        }
        self.run = r;
        if let Some(s) = streamed_step {
            self.run.current_step = self.run.current_step.max(s);
        }
        if !self.run.status.is_terminal() {
            self.run.cost_usd = self.run.cost_usd.max(cost);
            self.run.tokens_processed = self.run.tokens_processed.max(tokens);
        }
        if changed && self.run.status.is_terminal() {
            let text = self.status_text();
            self.push_log(self.now, self.status_tone(), text);
            let warnings = self
                .run
                .eval_report
                .as_ref()
                .map(|r| r.warnings.clone())
                .unwrap_or_default();
            for w in warnings {
                self.warn_once(self.now, w);
            }
        }
        self.sync_phase();
    }

    /// Fold one metric point (duplicates by `seq` are ignored).
    pub fn apply_metric(&mut self, m: MetricPoint) {
        if m.seq <= self.seen_seq {
            return;
        }
        self.seen_seq = m.seq;
        if m.attempt > self.run.attempt {
            self.new_attempt(m.attempt);
        }
        if self.run.status == RunStatus::Queued {
            self.run.status = RunStatus::Running;
        }
        // A step means training has begun, whatever the worker reported.
        let before = self.life.as_ref().is_some_and(|l| {
            matches!(
                l.phase,
                Phase::Queued | Phase::WaitingForCompute | Phase::Starting | Phase::LoadingModel
            )
        });
        if before {
            let at = parse_ts(&m.timestamp).unwrap_or(self.now);
            self.set_phase(Phase::Training, at, None);
        }
        // A resumed attempt replays steps after its checkpoint: drop the overlap.
        if self.samples.last().is_some_and(|s| m.step <= s.step) {
            self.samples.retain(|s| s.step < m.step);
        }
        self.samples.push(Sample {
            step: m.step,
            loss: m.loss,
            eval: eval_loss(&m),
            lr: m.lr,
        });
        if self.samples.len() > MAX_SAMPLES {
            let mut i = 0;
            self.samples.retain(|s| {
                i += 1;
                i % 2 == 0 || s.eval.is_some()
            });
        }
        if let Some(ms) = ts_ms(&m.timestamp) {
            if self.window.len() == 30 {
                self.window.pop_front();
            }
            self.window.push_back((ms, m.step, m.tokens));
        }
        self.tok_per_sec = m.tokens_per_sec.or_else(|| self.rate(|w| w.2));
        if eval_loss(&m).is_some() || m.eval_metrics.is_some() {
            self.checkpoints_stale = true;
        }
        if has_recipe_metrics(&m) {
            let text = eval_line(&m);
            self.push_log(self.now, Tone::Plain, text);
        }
        self.run.current_step = m.step;
        self.run.cost_usd = self.run.cost_usd.max(m.cost_usd);
        self.run.tokens_processed = self.run.tokens_processed.max(m.tokens);
        self.run.latest_metric = Some(m);
        self.sync_phase();
    }

    /// Fold one lifecycle event.
    pub fn apply_event(&mut self, ev: RunEvent) {
        if !matches!(ev, RunEvent::Unknown) {
            self.seen_events += 1;
        }
        let at = ev
            .meta()
            .and_then(|m| parse_ts(&m.timestamp))
            .unwrap_or(self.now);
        match ev {
            RunEvent::Phase {
                meta,
                phase,
                workers_online,
                autoscaling,
                message,
                gpu,
            } => {
                if meta.attempt > self.run.attempt {
                    self.new_attempt(meta.attempt);
                }
                if self.run.status == RunStatus::Queued
                    && !matches!(phase, Phase::Queued | Phase::WaitingForCompute)
                {
                    self.run.status = RunStatus::Running;
                }
                self.set_phase(phase, at, Some((workers_online, autoscaling, message, gpu)));
            }
            RunEvent::Attempt {
                meta,
                event,
                step,
                resume_step,
                max_attempts,
                message,
            } => {
                if max_attempts > 0 {
                    self.run.max_attempts = max_attempts;
                }
                let n = meta.attempt;
                match event {
                    AttemptKind::Interrupted | AttemptKind::GaveUp => {
                        if let Some(s) = step {
                            self.run.current_step = self.run.current_step.max(s);
                        }
                        let gave_up = event == AttemptKind::GaveUp;
                        if !gave_up {
                            self.resume = Some((n + 1, resume_step));
                        }
                        if n > self.logged_attempt || gave_up {
                            self.logged_attempt = self.logged_attempt.max(n);
                            let tone = if gave_up { Tone::Bad } else { Tone::Warn };
                            self.push_log(at, tone, sentence(&message));
                        }
                    }
                    _ => {
                        if n > self.run.attempt {
                            self.new_attempt(n);
                        }
                        if n > 1 {
                            if resume_step.is_some() || self.resume.is_none_or(|r| r.0 != n) {
                                self.resume = Some((n, resume_step));
                            }
                            self.push_log(at, Tone::Plain, sentence(&message));
                        }
                    }
                }
            }
            RunEvent::Warning { message, .. } => self.warn_once(at, message),
            RunEvent::Log { message, .. } => self.push_log(at, Tone::Quiet, sentence(&message)),
            RunEvent::Checkpoint { .. } => self.checkpoints_stale = true,
            RunEvent::Metric { metric, .. } => self.apply_metric(metric),
            RunEvent::Completed { run, .. } => self.apply_run(*run),
            RunEvent::Unknown => {}
        }
        self.sync_phase();
    }

    /// Replace the checkpoint list (the panel shows it; the log doesn't repeat it).
    pub fn apply_checkpoints(&mut self, mut list: Vec<Checkpoint>) {
        list.sort_by_key(|c| (c.step, c.attempt));
        self.checkpoints = list;
    }

    /// The stream or poller reports the connection state (`None` = healthy).
    pub fn link(&mut self, err: Option<String>) {
        match (err, &self.link) {
            (None, Link::Down(_)) => {
                self.push_log(self.now, Tone::Good, "Reconnected".into());
                self.link = Link::Live;
            }
            (Some(e), Link::Live) => {
                self.push_log(
                    self.now,
                    Tone::Warn,
                    format!("Connection lost ({}); reconnecting", e),
                );
                self.link = Link::Down(e);
            }
            (Some(e), Link::Down(_)) => self.link = Link::Down(e),
            _ => {}
        }
    }

    /// The live stream is unavailable (e.g. a buffering proxy): poll instead.
    pub fn polling(&mut self) {
        self.push_log(
            self.now,
            Tone::Warn,
            "Live stream unavailable (a proxy may buffer it); polling every few seconds".into(),
        );
        self.link = Link::Polling;
    }

    pub fn notice(&mut self, bad: bool, text: String) {
        let tone = if bad { Tone::Bad } else { Tone::Warn };
        self.push_log(self.now, tone, text.clone());
        self.notice = Some((tone, text));
    }

    /// Handle a key press.
    pub fn key(&mut self, code: KeyCode, mods: KeyModifiers) -> Action {
        let ctrl_c = mods.contains(KeyModifiers::CONTROL) && code == KeyCode::Char('c');
        if ctrl_c {
            return Action::Detach;
        }
        if self.confirm {
            match code {
                KeyCode::Char('y') | KeyCode::Char('Y') => {
                    self.confirm = false;
                    return Action::Cancel;
                }
                KeyCode::Char('n') | KeyCode::Char('N') | KeyCode::Esc | KeyCode::Char('q') => {
                    self.confirm = false
                }
                _ => {}
            }
            return Action::None;
        }
        if self.help {
            if matches!(
                code,
                KeyCode::Char('?') | KeyCode::Esc | KeyCode::Char('q') | KeyCode::Enter
            ) {
                self.help = false;
            }
            return Action::None;
        }
        match code {
            KeyCode::Char('q') | KeyCode::Esc => Action::Detach,
            KeyCode::Char('c') if !self.run.status.is_terminal() => {
                self.confirm = true;
                Action::None
            }
            KeyCode::Char('l') => {
                self.show_logs = !self.show_logs;
                Action::None
            }
            KeyCode::Char('?') | KeyCode::Char('h') => {
                self.help = true;
                Action::None
            }
            _ => Action::None,
        }
    }

    /// Steps (or tokens, via `pick`) per second over the recent window.
    fn rate(&self, pick: impl Fn(&(i64, i64, i64)) -> i64) -> Option<f64> {
        let (a, b) = (self.window.front()?, self.window.back()?);
        let dt = (b.0 - a.0) as f64 / 1000.0;
        let dv = (pick(b) - pick(a)) as f64;
        (dt >= 1.0 && dv > 0.0).then(|| dv / dt)
    }

    fn eta(&self) -> Option<i64> {
        let left = self.run.total_steps - self.run.current_step;
        if left <= 0 || self.run.status != RunStatus::Running {
            return None;
        }
        self.rate(|w| w.1).map(|r| (left as f64 / r).ceil() as i64)
    }

    fn best_eval(&self) -> Option<(i64, f64)> {
        self.samples
            .iter()
            .filter_map(|s| s.eval.map(|e| (s.step, e)))
            .min_by(|a, b| a.1.total_cmp(&b.1))
    }

    /// The server's pinned best checkpoint, or (mid-run, before it pins one)
    /// the best score so far by the metric's direction in the metadata.
    fn best_checkpoint(&self) -> Option<&str> {
        if let Some(c) = self.checkpoints.iter().find(|c| c.best) {
            return Some(&c.id);
        }
        let min =
            |c: &Checkpoint| c.metadata.get("metric_mode").and_then(|v| v.as_str()) == Some("min");
        self.checkpoints
            .iter()
            .filter_map(|c| c.eval_score.map(|s| (c, if min(c) { -s } else { s })))
            .max_by(|a, b| a.1.total_cmp(&b.1))
            .map(|(c, _)| c.id.as_str())
    }

    /// The checkpoints' selection metric, for the panel's column head.
    fn score_name(&self) -> String {
        self.checkpoints
            .iter()
            .find_map(|c| c.metadata.get("metric_name").and_then(|v| v.as_str()))
            .map(|s| s.replace('_', " "))
            .unwrap_or_else(|| "score".into())
    }

    /// Has the current attempt streamed a step yet?
    fn attempt_points(&self) -> bool {
        self.run
            .latest_metric
            .as_ref()
            .is_some_and(|m| m.attempt == self.run.attempt)
    }

    /// Where the current attempt resumes, while it hasn't trained yet.
    fn resume_note(&self) -> Option<String> {
        let (n, from) = self.resume?;
        if n != self.run.attempt || self.attempt_points() {
            return None;
        }
        Some(match from {
            Some(s) => format!("resuming from step {}", thousands(s)),
            None => "starting again from step 0".into(),
        })
    }

    /// A queued run's label: the server's reason (queue position, a workspace
    /// cap, a GPU nobody has), live from the polled run when the server
    /// reports one, else from the phase event; else who is online.
    fn queue_label(&self, l: &Life) -> String {
        let live = self.run.status == RunStatus::Queued && self.run.queue_position.is_some();
        let message = if live {
            self.run.queue_message.as_ref()
        } else {
            l.message.as_ref()
        };
        message.cloned().unwrap_or_else(|| {
            // Until the server's ~30 s waiting_for_compute check, an idle worker may be
            // about to claim the run: "0 online" would only alarm.
            if l.phase == Phase::Queued && l.autoscaling != Some(true) {
                "Queued".into()
            } else {
                waiting_label(l.workers_online, l.autoscaling)
            }
        })
    }

    fn phase(&self) -> PhaseView {
        let v = |key, label: &str, tone| PhaseView {
            key,
            label: label.to_string(),
            note: None,
            tone,
        };
        let r = &self.run;
        let done = match &r.status {
            RunStatus::Completed => Some(v("completed", "Completed", Tone::Good)),
            RunStatus::Failed => Some(v("failed", "Failed", Tone::Bad)),
            RunStatus::Cancelled => Some(v("cancelled", "Cancelled", Tone::Warn)),
            RunStatus::StoppedBudget => Some(v("stopped", "Stopped at the cost cap", Tone::Warn)),
            RunStatus::StoppedBalance => Some(v("stopped", "Stopped: out of balance", Tone::Warn)),
            RunStatus::Other(s) => Some(v("other", &s.replace('_', " "), Tone::Plain)),
            RunStatus::Queued | RunStatus::Running => None,
        };
        if let Some(d) = done {
            return d;
        }
        let mut view = match &self.life {
            Some(l) => match &l.phase {
                Phase::Queued => v("queued", &self.queue_label(l), Tone::Plain),
                Phase::WaitingForCompute => v("waiting", &self.queue_label(l), Tone::Plain),
                Phase::Starting => v("starting", &starting_label(l.gpu.as_ref()), Tone::Plain),
                Phase::LoadingModel => v("loading", "Loading the model", Tone::Plain),
                Phase::Training => v("training", "Training", Tone::Plain),
                Phase::Evaluating => v("evaluating", "Evaluating", Tone::Plain),
                Phase::Checkpointing => v("checkpointing", "Saving a checkpoint", Tone::Plain),
                Phase::Uploading => v("uploading", "Uploading the artifact", Tone::Plain),
                Phase::Completing => v("completing", "Finishing up", Tone::Plain),
                Phase::Other => v("other", "Working", Tone::Plain),
            },
            // Servers without phases: the status and the stream tell enough.
            None if r.status == RunStatus::Queued => v("queued", "Queued", Tone::Plain),
            None if !self.attempt_points() => v("starting", "Starting", Tone::Plain),
            None => v("training", "Training", Tone::Plain),
        };
        if let Some(n) = self.resume_note() {
            view.note = Some(n);
            view.tone = Tone::Warn;
        }
        view
    }
}

/// The phase a run object reports (`phase`, `phase_since`, queue details).
fn life_of(r: &Run) -> Option<Life> {
    let phase: Phase = serde_json::to_value(r.phase.as_ref()?)
        .ok()
        .and_then(|v| serde_json::from_value(v).ok())?;
    let since = parse_ts(r.phase_since.as_deref()?)?;
    Some(Life {
        phase,
        since,
        workers_online: r.workers_online,
        autoscaling: r.autoscaling,
        message: r.queue_message.clone(),
        gpu: None,
    })
}

/// `3/10`, or just `12` once reclaimed GPUs (which don't count) pass the cap.
fn attempt_of(r: &Run) -> String {
    if r.attempt <= r.max_attempts {
        format!("{}/{}", r.attempt, r.max_attempts)
    } else {
        r.attempt.to_string()
    }
}

/// "Waiting for a worker (0 online)".
fn waiting_label(workers: Option<i64>, autoscaling: Option<bool>) -> String {
    match workers {
        None => "Waiting for a worker".into(),
        Some(0) if autoscaling == Some(true) => "Waiting for a worker (one is starting)".into(),
        Some(0) => "Waiting for a worker (none online)".into(),
        Some(n) => format!("Waiting for a worker ({} online, all busy)", n),
    }
}

fn starting_label(gpu: Option<&Gpu>) -> String {
    match gpu {
        Some(g) if g.memory_gb > 0.0 => format!("Starting on {} ({:.0} GB)", g.name, g.memory_gb),
        Some(g) => format!("Starting on {}", g.name),
        None => "Starting".into(),
    }
}

/// Capitalise a server message for the log.
fn sentence(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().chain(c).collect(),
        None => String::new(),
    }
}

/// The point's held-out loss (top level or in `eval_metrics`).
fn eval_loss(m: &MetricPoint) -> Option<f64> {
    m.eval_loss.or_else(|| {
        m.eval_metrics
            .as_ref()
            .and_then(|e| e.get("eval_loss").copied().flatten())
    })
}

/// An eval step with metrics beyond the loss the chart already shows.
fn has_recipe_metrics(m: &MetricPoint) -> bool {
    m.eval_metrics
        .iter()
        .flatten()
        .any(|(k, v)| k != "eval_loss" && v.is_some())
}

/// `Eval at step N · loss x · <recipe metrics>` for an eval step.
fn eval_line(m: &MetricPoint) -> String {
    let mut parts = vec![format!("Eval at step {}", thousands(m.step))];
    if let Some(l) = eval_loss(m) {
        parts.push(format!("loss {}", num(l)));
    }
    let metrics = m.eval_metrics.iter().flatten();
    for (k, v) in metrics {
        let Some(v) = *v else { continue };
        let shown = match k.as_str() {
            "eval_loss" => continue,
            "offload_rate" => format!("offload {}", pct(v)),
            "cost_savings_pct" => format!("saving {}", pct(v)),
            "quality_drop" => format!("quality drop {}", num(v)),
            "accuracy" => format!("accuracy {}", pct(v)),
            "preference_accuracy" => format!("pref. accuracy {}", pct(v)),
            "ece" => format!("ECE {}", num(v)),
            "mrr" => format!("MRR {}", num(v)),
            "eval_kl" => format!("KL {}", num(v)),
            k if k.starts_with("recall_at_") => {
                format!("recall@{} {}", &k["recall_at_".len()..], pct(v))
            }
            k => format!("{} {}", k.replace('_', " "), num(v)),
        };
        parts.push(shown);
    }
    parts.join(" · ")
}

/// RFC 3339 UTC timestamp -> epoch milliseconds (fraction optional).
fn ts_ms(ts: &str) -> Option<i64> {
    let secs = parse_ts(ts)?;
    let frac = ts
        .get(19..)
        .and_then(|r| r.strip_prefix('.'))
        .map(|r| {
            r.chars()
                .take_while(char::is_ascii_digit)
                .collect::<String>()
        })
        .unwrap_or_default();
    let ms = format!("{:0<3}", &frac[..frac.len().min(3)])
        .parse::<i64>()
        .unwrap_or(0);
    Some(secs * 1000 + ms)
}

/// `12:05` / `1:02:05` clock offset.
fn clock(s: i64) -> String {
    let s = s.max(0);
    if s >= 3600 {
        format!("{}:{:02}:{:02}", s / 3600, (s % 3600) / 60, s % 60)
    } else {
        format!("{:02}:{:02}", s / 60, s % 60)
    }
}

// ---------------------------------------------------------------- render

/// Render the whole screen.
pub fn draw(f: &mut Frame, m: &Model) {
    let area = f.area();
    if area.width >= 80 && area.height >= 24 {
        wide(f, area, m);
    } else {
        compact_view(f, area, m);
    }
    if m.help {
        help(f, area, m);
    } else if m.confirm {
        confirm(f, area, m);
    }
}

fn sep() -> Span<'static> {
    Span::styled("  ·  ", dim())
}

/// Left and right content on one row; the right side wins when both don't fit.
fn row(f: &mut Frame, area: Rect, left: Line, right: Line) {
    let rw = (right.width() as u16).min(area.width);
    let [l, r] = Layout::horizontal([Constraint::Min(0), Constraint::Length(rw)]).areas(area);
    f.render_widget(Paragraph::new(left), l);
    f.render_widget(Paragraph::new(right), r);
}

/// `label value` with a dimmed label.
fn kv(label: &str, value: String) -> Vec<Span<'static>> {
    vec![Span::styled(format!("{} ", label), dim()), Span::raw(value)]
}

fn elapsed(m: &Model) -> i64 {
    let r = &m.run;
    let end = r
        .finished_at
        .as_deref()
        .and_then(parse_ts)
        .filter(|_| r.status.is_terminal())
        .unwrap_or(m.now);
    (end - m.started).max(0)
}

fn title(m: &Model) -> Line<'static> {
    Line::from(vec![
        Span::styled(m.run.name.clone(), bold()),
        Span::raw("  "),
        Span::styled(m.run.id.clone(), dim()),
    ])
}

fn config_spans(m: &Model, labelled: bool) -> Vec<Span<'static>> {
    let r = &m.run;
    let data = format!("{}@{}", r.dataset_name, r.dataset_version);
    if !labelled {
        return vec![
            Span::raw(r.recipe_kind.to_string()),
            sep(),
            Span::raw(r.resolved_config.model.clone()),
            sep(),
            Span::raw(data),
        ];
    }
    let mut s = kv("recipe", r.recipe_kind.to_string());
    s.push(Span::raw("   "));
    s.extend(kv("model", r.resolved_config.model.clone()));
    s.push(Span::raw("   "));
    s.extend(kv("dataset", data));
    s
}

fn header(f: &mut Frame, a: Rect, b: Rect, m: &Model) {
    let started = Line::from(kv(
        "started",
        format!("{} UTC", crate::output::when(&m.run.created_at)),
    ));
    row(f, a, title(m), started);
    let el = Line::from(kv("elapsed", fmt_duration(elapsed(m))));
    row(f, b, Line::from(config_spans(m, true)), el);
}

/// `⠼ Training  for 10s  ·  resuming from step 640`, and `attempt 2/10`.
fn phase_line(m: &Model) -> (Line<'static>, Line<'static>) {
    let v = m.phase();
    let icon = match m.run.status {
        RunStatus::Completed => Span::styled("✓", fg(GOOD)),
        RunStatus::Failed => Span::styled("✗", fg(BAD)),
        RunStatus::Cancelled | RunStatus::StoppedBudget | RunStatus::StoppedBalance => {
            Span::styled("■", fg(WARN))
        }
        _ => Span::styled(
            SPINNER[m.tick % SPINNER.len()],
            if v.tone == Tone::Plain {
                fg(ACCENT)
            } else {
                v.tone.style()
            },
        ),
    };
    let label_style = match v.tone {
        Tone::Plain | Tone::Warn => bold(),
        t => t.style().add_modifier(Modifier::BOLD),
    };
    let mut left = vec![icon, Span::raw(" "), Span::styled(v.label, label_style)];
    if !m.run.status.is_terminal() {
        left.push(Span::styled(
            format!("  for {}", fmt_duration((m.now - m.phase_since).max(0))),
            dim(),
        ));
    }
    if let Some(n) = v.note {
        left.push(sep());
        left.push(Span::styled(n, fg(WARN)));
    }
    if let (RunStatus::Failed, Some(e)) = (&m.run.status, &m.run.error) {
        left.push(sep());
        left.push(Span::styled(e.clone(), fg(BAD)));
    }
    let attempt = if m.run.attempt > 0 {
        Line::from(vec![
            Span::styled("attempt ", dim()),
            Span::styled(
                attempt_of(&m.run),
                if m.run.attempt > 1 {
                    fg(WARN)
                } else {
                    Style::new()
                },
            ),
        ])
    } else {
        Line::default()
    };
    (Line::from(left), attempt)
}

/// `━━━━━───` of `width` cells.
fn bar(ratio: f64, width: usize, fill: Style) -> Vec<Span<'static>> {
    let n = ((ratio.clamp(0.0, 1.0) * width as f64).round() as usize).min(width);
    vec![
        Span::styled("━".repeat(n), fill),
        Span::styled("─".repeat(width - n), dim()),
    ]
}

struct Gauge {
    label: &'static str,
    value: String,
    ratio: Option<f64>,
    fill: Style,
    suffix: Vec<Span<'static>>,
}

fn width_of(spans: &[Span]) -> usize {
    spans.iter().map(Span::width).sum()
}

/// Throughput and ETA: `256k tok/s  ·  ETA 4m10s`.
fn pace(m: &Model) -> Vec<Span<'static>> {
    let mut out = Vec::new();
    if let Some(t) = m.tok_per_sec.filter(|_| m.run.status == RunStatus::Running) {
        out.push(Span::raw(compact(t.round() as i64)));
        out.push(Span::styled(" tok/s", dim()));
    }
    if let Some(e) = m.eta() {
        if !out.is_empty() {
            out.push(sep());
        }
        out.push(Span::styled("ETA ", dim()));
        out.push(Span::raw(fmt_duration(e)));
    }
    out
}

fn tokens(m: &Model) -> Vec<Span<'static>> {
    vec![
        Span::raw(compact(m.run.tokens_processed)),
        Span::styled(" tokens", dim()),
    ]
}

/// The step and cost lines, label/value/bar/percent columns aligned:
/// `step  640 / 1,062   ━━━━━━━──────   60%   256k tok/s  ·  ETA 4s`.
/// Without `suffixes` (compact layout) the pace and tokens are left out.
fn gauges(m: &Model, width: u16, suffixes: bool) -> [Line<'static>; 2] {
    let r = &m.run;
    let step = Gauge {
        label: "step",
        value: format!(
            "{} / {}",
            thousands(r.current_step),
            thousands(r.total_steps)
        ),
        ratio: (r.total_steps > 0).then(|| r.current_step as f64 / r.total_steps as f64),
        fill: if r.status == RunStatus::Completed {
            fg(GOOD)
        } else {
            fg(ACCENT)
        },
        suffix: if suffixes { pace(m) } else { Vec::new() },
    };
    let cap = r.max_cost_usd.filter(|c| *c > 0.0);
    let near = cap.is_some_and(|c| r.cost_usd >= 0.9 * c);
    let cost = Gauge {
        label: "cost",
        value: match cap {
            Some(c) => format!("{} / {}", usd(r.cost_usd), usd(c)),
            None => format!("{}  no cap", usd(r.cost_usd)),
        },
        ratio: cap.map(|c| r.cost_usd / c),
        fill: if near { fg(WARN) } else { Style::new() },
        suffix: if suffixes { tokens(m) } else { Vec::new() },
    };
    let vw = step.value.len().max(cost.value.len()) + 3;
    let sw = width_of(&step.suffix).max(width_of(&cost.suffix));
    let fixed = 6 + vw + 6 + if sw > 0 { 3 + sw } else { 0 };
    let bw = (width as usize).saturating_sub(fixed).min(56);
    [step, cost].map(|g| {
        let mut spans = vec![
            Span::styled(format!("{:<6}", g.label), dim()),
            Span::raw(format!("{:<vw$}", g.value, vw = vw)),
        ];
        match g.ratio.filter(|_| bw >= 6) {
            Some(x) => {
                spans.extend(bar(x, bw, g.fill));
                spans.push(Span::styled(
                    format!("{:>5.0}%", (x * 100.0).clamp(0.0, 100.0).floor()),
                    dim(),
                ));
            }
            None if !g.suffix.is_empty() => spans.push(Span::raw(" ".repeat(bw + 6))),
            None => {}
        }
        if !g.suffix.is_empty() {
            spans.push(Span::raw("   "));
            spans.extend(g.suffix);
        }
        Line::from(spans)
    })
}

fn panel(title: &str) -> Block<'static> {
    Block::default()
        .borders(Borders::ALL)
        .border_type(BorderType::Rounded)
        .border_style(dim())
        .title(Span::styled(format!(" {} ", title), bold()))
        .padding(Padding::horizontal(1))
}

fn wide(f: &mut Frame, area: Rect, m: &Model) {
    let area = area.inner(Margin::new(1, 0));
    let [head, cfg, _, phase, _, step, cost, _, body, foot] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(8),
        Constraint::Length(1),
    ])
    .areas(area);
    header(f, head, cfg, m);
    let (p, a) = phase_line(m);
    row(f, phase, p, a);
    let [g1, g2] = gauges(m, step.width, true);
    f.render_widget(Paragraph::new(g1), step);
    f.render_widget(Paragraph::new(g2), cost);
    if m.show_logs {
        events(f, body, m, "Events");
    } else {
        let panels_h = (body.height / 3).clamp(5, 10);
        let [chart, panels] =
            Layout::vertical([Constraint::Min(6), Constraint::Length(panels_h)]).areas(body);
        loss_panel(f, chart, m);
        let [ck, _, ev] = Layout::horizontal([
            Constraint::Length(34),
            Constraint::Length(1),
            Constraint::Min(20),
        ])
        .areas(panels);
        checkpoints(f, ck, m);
        events(f, ev, m, "Events");
    }
    footer(f, foot, m, false);
}

fn compact_view(f: &mut Frame, area: Rect, m: &Model) {
    let [head, cfg, phase, step, cost, pace_a, loss, rule, rest, foot] = Layout::vertical([
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Length(1),
        Constraint::Min(0),
        Constraint::Length(1),
    ])
    .areas(area);
    f.render_widget(Paragraph::new(title(m)), head);
    f.render_widget(Paragraph::new(Line::from(config_spans(m, false))), cfg);
    let (mut p, a) = phase_line(m);
    if !a.spans.is_empty() {
        p.spans.push(sep());
        p.spans.extend(a.spans);
    }
    f.render_widget(Paragraph::new(p), phase);
    let [g1, g2] = gauges(m, step.width, false);
    f.render_widget(Paragraph::new(g1), step);
    f.render_widget(Paragraph::new(g2), cost);
    let mut stats = pace(m);
    if !stats.is_empty() {
        stats.push(sep());
    }
    stats.extend(tokens(m));
    stats.insert(0, Span::raw(" ".repeat(6)));
    f.render_widget(Paragraph::new(Line::from(stats)), pace_a);
    // loss  0.412  best 0.455 @ 640  ▇▆▅▄▃▂▁
    let mut spans = vec![Span::styled(format!("{:<6}", "loss"), dim())];
    if let Some(s) = m.samples.last() {
        spans.push(Span::styled(num(s.loss), fg(ACCENT)));
    }
    if let Some((step, e)) = m.best_eval() {
        spans.push(Span::styled("  best ", dim()));
        spans.push(Span::styled(num(e), fg(EVAL)));
        spans.push(Span::styled(format!(" @ {}", thousands(step)), dim()));
    }
    let used = width_of(&spans) as u16 + 2;
    let [txt, spark] =
        Layout::horizontal([Constraint::Length(used), Constraint::Min(0)]).areas(loss);
    f.render_widget(Paragraph::new(Line::from(spans)), txt);
    let data = series(m.samples.iter().map(|s| s.loss), spark.width as usize);
    f.render_widget(Sparkline::default().data(&data).style(fg(ACCENT)), spark);
    if rest.height >= 1 {
        f.render_widget(
            Paragraph::new(Span::styled("─".repeat(rule.width as usize), dim())),
            rule,
        );
        log_lines(f, rest, m);
    }
    footer(f, foot, m, true);
}

/// The empty chart says what the run is doing: "Waiting for a GPU (2
/// workers online, all busy)…", "Loading the model…" (from the lifecycle
/// phase and its queue details), or how it ended before a first step.
fn empty_chart_message(m: &Model) -> String {
    let v = m.phase();
    if m.run.status.is_terminal() {
        return format!("{} before the first training step", v.label);
    }
    match v.key {
        "training" | "evaluating" | "checkpointing" => {
            "Training: waiting for the first step…".into()
        }
        _ => format!("{}…", v.label.trim_end_matches('…')),
    }
}

/// `(step, y)` points cut to `columns` buckets over steps `0..=x1`: each
/// bucket keeps its lowest and highest point, in step order, so spikes and
/// dips survive and the curve spans the whole run.
fn min_max_buckets(
    points: impl Iterator<Item = (i64, f64)>,
    x1: f64,
    columns: usize,
) -> Vec<(f64, f64)> {
    let columns = columns.max(1);
    // Per column: its lowest and its highest (step, y).
    type Extremes = ((i64, f64), (i64, f64));
    let mut buckets: Vec<Option<Extremes>> = vec![None; columns];
    for (step, y) in points.filter(|p| p.1.is_finite()) {
        let i = ((step as f64 / x1.max(1.0)) * columns as f64) as usize;
        let b = &mut buckets[i.min(columns - 1)];
        *b = Some(match *b {
            None => ((step, y), (step, y)),
            Some((lo, hi)) => (
                if y < lo.1 { (step, y) } else { lo },
                if y > hi.1 { (step, y) } else { hi },
            ),
        });
    }
    let mut out = Vec::new();
    for (lo, hi) in buckets.into_iter().flatten() {
        let (a, b) = if lo.0 <= hi.0 { (lo, hi) } else { (hi, lo) };
        out.push((a.0 as f64, a.1));
        if b != a {
            out.push((b.0 as f64, b.1));
        }
    }
    out
}

/// Y bounds for the loss chart: the 1st to 99th percentile of the values
/// once there are 100 or more (all of them below that), padded 8%.
fn y_bounds(values: impl Iterator<Item = f64>) -> (f64, f64) {
    let mut v: Vec<f64> = values.filter(|x| x.is_finite()).collect();
    if v.is_empty() {
        return (0.0, 1.0);
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let (lo, hi) = if v.len() >= 100 {
        let at = |q: f64| v[((v.len() - 1) as f64 * q).round() as usize];
        (at(0.01), at(0.99))
    } else {
        (v[0], v[v.len() - 1])
    };
    let pad = ((hi - lo) * 0.08).max(1e-6);
    ((lo - pad).max(0.0_f64.min(lo)), hi + pad)
}

/// Values scaled to 8..=100 for a sparkline (so the lowest still shows as
/// `▁`), resampled to `width` buckets.
fn series(values: impl Iterator<Item = f64>, width: usize) -> Vec<u64> {
    let v: Vec<f64> = values.filter(|x| x.is_finite()).collect();
    if v.is_empty() || width == 0 {
        return Vec::new();
    }
    let n = v.len().min(width);
    let means: Vec<f64> = (0..n)
        .map(|i| {
            let c = &v[i * v.len() / n..((i + 1) * v.len() / n).max(i * v.len() / n + 1)];
            c.iter().sum::<f64>() / c.len() as f64
        })
        .collect();
    let (lo, hi) = means
        .iter()
        .fold((f64::MAX, f64::MIN), |(a, b), x| (a.min(*x), b.max(*x)));
    let span = (hi - lo).max(f64::EPSILON);
    means
        .iter()
        .map(|x| 8 + ((x - lo) / span * 92.0).round() as u64)
        .collect()
}

/// `━ train 0.6194   ━ eval 0.6195   ● best 0.6195 @ 640`.
fn legend(m: &Model) -> Line<'static> {
    let mut l = Vec::new();
    let mut item = |mark: Span<'static>, name: &str, value: String| {
        l.push(Span::raw(if l.is_empty() { " " } else { "   " }));
        l.push(mark);
        l.push(Span::styled(format!(" {} ", name), dim()));
        l.push(Span::raw(value));
    };
    if let Some(s) = m.samples.last() {
        item(Span::styled("━", fg(ACCENT)), "train", num(s.loss));
    }
    if let Some(e) = m.samples.iter().rev().find_map(|s| s.eval) {
        item(Span::styled("━", fg(EVAL)), "eval", num(e));
    }
    if let Some((step, e)) = m.best_eval() {
        item(
            Span::styled("●", fg(GOOD)),
            "best",
            format!("{} @ {}", num(e), thousands(step)),
        );
    }
    if !l.is_empty() {
        l.push(Span::raw(" "));
    }
    Line::from(l).right_aligned()
}

/// The loss panel: a braille chart without axis lines (dim tick labels on
/// the left and below), the lr as a sparkline on the panel's last row.
fn loss_panel(f: &mut Frame, area: Rect, m: &Model) {
    let block = panel("Loss").title(legend(m));
    let inner = block.inner(area);
    f.render_widget(block, area);
    if m.samples.is_empty() {
        let msg = empty_chart_message(m);
        let [_, mid, _] = Layout::vertical([
            Constraint::Fill(1),
            Constraint::Length(1),
            Constraint::Fill(1),
        ])
        .areas(inner);
        f.render_widget(Paragraph::new(msg).style(dim()).centered(), mid);
        return;
    }
    let lrs: Vec<f64> = m.samples.iter().filter_map(|s| s.lr).collect();
    let extra = 1 + u16::from(!lrs.is_empty());
    if inner.height < extra + 2 || inner.width < 12 {
        return;
    }
    let [plot_rows, x_row, lr_row] = Layout::vertical([
        Constraint::Min(2),
        Constraint::Length(1),
        Constraint::Length(extra - 1),
    ])
    .areas(inner);

    // X is always the whole run (0..total_steps); each series is cut to the
    // plot's braille columns with a min and a max per column, so 1,700 or
    // 100k steps draw as the same full curve.
    let x0 = 0.0;
    let last_step = m.samples.last().map(|s| s.step).unwrap_or(1);
    let x1 = m.run.total_steps.max(last_step).max(1) as f64;
    let columns = inner.width.saturating_sub(8).max(10) as usize * 2;
    let train = min_max_buckets(m.samples.iter().map(|s| (s.step, s.loss)), x1, columns);
    let eval: Vec<(f64, f64)> = m
        .samples
        .iter()
        .filter_map(|s| s.eval.map(|e| (s.step as f64, e)))
        .collect();
    let best: Vec<(f64, f64)> = m
        .best_eval()
        .map(|(s, e)| vec![(s as f64, e)])
        .unwrap_or_default();
    // Y scales to the whole visible series, robust to a few spikes: they're
    // drawn on the edge they cross, in the attention colour.
    let (lo, hi) = y_bounds(
        m.samples
            .iter()
            .map(|s| s.loss)
            .chain(eval.iter().map(|p| p.1)),
    );
    type Points = Vec<(f64, f64)>;
    let clip = |pts: &[(f64, f64)]| -> (Points, Points) {
        let mut out = Vec::new();
        let inside = pts
            .iter()
            .map(|&(x, y)| {
                if y > hi || y < lo {
                    out.push((x, y.clamp(lo, hi)));
                }
                (x, y.clamp(lo, hi))
            })
            .collect();
        (inside, out)
    };
    let (train, mut clipped) = clip(&train);
    let (eval, eval_clipped) = clip(&eval);
    clipped.extend(eval_clipped);

    // Y tick labels: top, middle (when there's room) and bottom.
    let mut ticks = vec![(0, hi), (plot_rows.height - 1, lo)];
    if plot_rows.height >= 5 {
        ticks.push((plot_rows.height / 2, (hi + lo) / 2.0));
    }
    let labels: Vec<(u16, String)> = ticks
        .into_iter()
        .map(|(r, y)| (r, num(round3(y))))
        .collect();
    let lw = labels.iter().map(|l| l.1.len() as u16).max().unwrap_or(0);
    let lw = lw.min(inner.width / 4);
    let [ycol, plot] =
        Layout::horizontal([Constraint::Length(lw + 1), Constraint::Min(1)]).areas(plot_rows);
    for (r, l) in labels {
        let at = Rect::new(ycol.x, ycol.y + r, lw, 1);
        f.render_widget(Paragraph::new(Span::styled(l, dim())).right_aligned(), at);
    }

    let mut sets = vec![Dataset::default()
        .marker(Marker::Braille)
        .graph_type(GraphType::Line)
        .style(fg(ACCENT))
        .data(&train)];
    if !clipped.is_empty() {
        sets.push(
            Dataset::default()
                .marker(Marker::Dot)
                .graph_type(GraphType::Scatter)
                .style(fg(WARN))
                .data(&clipped),
        );
    }
    if !eval.is_empty() {
        sets.push(
            Dataset::default()
                .marker(Marker::Braille)
                .graph_type(GraphType::Line)
                .style(fg(EVAL))
                .data(&eval),
        );
        sets.push(
            Dataset::default()
                .marker(Marker::Dot)
                .graph_type(GraphType::Scatter)
                .style(fg(GOOD).add_modifier(Modifier::BOLD))
                .data(&best),
        );
    }
    let chart = Chart::new(sets)
        .legend_position(None)
        .x_axis(Axis::default().bounds([x0, x1]))
        .y_axis(Axis::default().bounds([lo, hi]));
    f.render_widget(chart, plot);

    // X tick labels under the plot: first and last step, "step" between.
    let xl = Rect::new(plot.x, x_row.y, plot.width, 1);
    let [a, b, c] = Layout::horizontal([
        Constraint::Fill(1),
        Constraint::Length(4),
        Constraint::Fill(1),
    ])
    .areas(xl);
    f.render_widget(Paragraph::new(Span::styled(thousands(x0 as i64), dim())), a);
    f.render_widget(Paragraph::new(Span::styled("step", dim())), b);
    f.render_widget(
        Paragraph::new(Span::styled(thousands(x1 as i64), dim())).right_aligned(),
        c,
    );

    // lr: a sparkline over the steps run so far, its latest value after it.
    if let Some(last) = lrs.last().copied() {
        f.render_widget(
            Paragraph::new(Span::styled("lr", dim())).right_aligned(),
            Rect::new(ycol.x, lr_row.y, lw, 1),
        );
        let frac = ((last_step as f64 - x0) / (x1 - x0).max(1.0)).clamp(0.0, 1.0);
        let value = format!(" {}", num(last));
        let sw = ((plot.width as f64 * frac).round() as u16)
            .max(1)
            .min(plot.width.saturating_sub(value.len() as u16));
        let data = series(lrs.into_iter(), sw as usize);
        let spark = Rect::new(plot.x, lr_row.y, data.len() as u16, 1);
        f.render_widget(Sparkline::default().data(&data).style(dim()), spark);
        let val = Rect::new(spark.right(), lr_row.y, value.len() as u16, 1).intersection(lr_row);
        f.render_widget(Paragraph::new(Span::styled(value, dim())), val);
    }
}

fn round3(x: f64) -> f64 {
    if x == 0.0 {
        return 0.0;
    }
    let mag = 10f64.powi(2 - x.abs().log10().floor() as i32);
    (x * mag).round() / mag
}

fn checkpoints(f: &mut Frame, area: Rect, m: &Model) {
    let block = panel("Checkpoints");
    let rows = block.inner(area).height as usize;
    let mut lines = vec![Line::styled(
        format!("{:>7}  {}", "step", m.score_name()),
        dim(),
    )];
    if m.checkpoints.is_empty() {
        lines.push(Line::styled("   none yet", dim()));
    }
    let skip = m.checkpoints.len().saturating_sub(rows.saturating_sub(1));
    let best = m.best_checkpoint();
    for c in m.checkpoints.iter().skip(skip) {
        let is_best = best == Some(c.id.as_str());
        let mut spans = vec![
            Span::styled(format!("{:>7}", thousands(c.step)), dim()),
            Span::raw("  "),
            Span::styled(
                format!("{:<9}", c.eval_score.map(num).unwrap_or_else(|| "-".into())),
                if is_best { bold() } else { Style::new() },
            ),
        ];
        if is_best {
            spans.push(Span::styled("● best", fg(GOOD)));
        } else if c.r#final {
            spans.push(Span::styled("final", dim()));
        }
        lines.push(Line::from(spans));
    }
    f.render_widget(Paragraph::new(lines).block(block), area);
}

/// Split `text` into rows of at most `width` chars, breaking at spaces.
fn wrap(text: &str, width: usize) -> Vec<String> {
    let width = width.max(1);
    let mut rows: Vec<String> = Vec::new();
    let mut cur = String::new();
    for word in text.split(' ') {
        let (len, wl) = (cur.chars().count(), word.chars().count());
        if len > 0 && len + 1 + wl > width {
            rows.push(std::mem::take(&mut cur));
        }
        if !cur.is_empty() {
            cur.push(' ');
        }
        cur.push_str(word);
        while cur.chars().count() > width {
            rows.push(cur.chars().take(width).collect());
            cur = cur.chars().skip(width).collect();
        }
    }
    rows.push(cur);
    rows
}

/// One log entry as rows: `  00:12  text`, continuation rows indented.
fn log_rows(m: &Model, l: &LogLine, width: usize) -> Vec<Line<'static>> {
    const GUTTER: usize = 8;
    wrap(&l.text, width.saturating_sub(GUTTER))
        .into_iter()
        .enumerate()
        .map(|(i, row)| {
            let lead = if i == 0 {
                format!("{:>6}  ", clock(l.at - m.started))
            } else {
                " ".repeat(GUTTER)
            };
            Line::from(vec![
                Span::styled(lead, dim()),
                Span::styled(row, l.tone.style()),
            ])
        })
        .collect()
}

/// The newest log entries that fit in `area`, oldest first.
fn log_lines(f: &mut Frame, area: Rect, m: &Model) {
    let (n, w) = (area.height as usize, area.width as usize);
    let mut rows: Vec<Line> = Vec::new();
    for l in m.log.iter().rev() {
        if rows.len() >= n {
            break;
        }
        let mut entry = log_rows(m, l, w);
        entry.extend(rows);
        rows = entry;
    }
    let skip = rows.len().saturating_sub(n);
    f.render_widget(Paragraph::new(rows.split_off(skip)), area);
}

fn events(f: &mut Frame, area: Rect, m: &Model, title: &str) {
    let block = panel(title);
    let inner = block.inner(area);
    f.render_widget(block, area);
    log_lines(f, inner, m);
}

fn footer(f: &mut Frame, area: Rect, m: &Model, short: bool) {
    let key = |k: &'static str, what: &'static str| {
        vec![
            Span::styled(k, bold()),
            Span::styled(format!(" {}  ", what), dim()),
        ]
    };
    let mut left: Vec<Span> = Vec::new();
    left.extend(key("q", "detach"));
    if !m.run.status.is_terminal() {
        left.extend(key("c", "cancel"));
    }
    left.extend(key("l", if m.show_logs { "chart" } else { "logs" }));
    left.extend(key("?", "help"));
    if let Some((tone, text)) = &m.notice {
        left.push(Span::raw(" "));
        left.push(Span::styled(text.clone(), tone.style()));
    }
    let right = match &m.link {
        _ if m.run.status.is_terminal() => Vec::new(),
        Link::Live => vec![Span::styled("● ", fg(GOOD)), Span::styled("live", dim())],
        Link::Polling => vec![Span::styled("● ", fg(WARN)), Span::styled("polling", dim())],
        Link::Down(_) => vec![
            Span::styled("● ", fg(WARN)),
            Span::styled("reconnecting", dim()),
        ],
    };
    if short {
        f.render_widget(Paragraph::new(Line::from(left)), area);
    } else {
        row(f, area, Line::from(left), Line::from(right));
    }
}

fn modal(f: &mut Frame, area: Rect, w: u16, h: u16) -> Rect {
    let [v] = Layout::vertical([Constraint::Length(h.min(area.height))])
        .flex(Flex::Center)
        .areas(area);
    let [r] = Layout::horizontal([Constraint::Length(w.min(area.width))])
        .flex(Flex::Center)
        .areas(v);
    f.render_widget(Clear, r);
    r
}

fn help(f: &mut Frame, area: Rect, m: &Model) {
    let r = modal(f, area, 58, 11);
    let k = |key: &'static str, what: &'static str| {
        Line::from(vec![
            Span::styled(format!("{:<10}", key), bold()),
            Span::raw(what),
        ])
    };
    let lines = vec![
        k("q  Ctrl-C", "detach; the run keeps going on the server"),
        k("c", "cancel the run (asks first)"),
        k("l", "show or hide the full event log"),
        k("?", "show or hide this help"),
        Line::raw(""),
        Line::styled("Reattach any time with", dim()),
        Line::from(Span::styled(
            format!("  grad runs watch {}", m.run.id),
            fg(ACCENT),
        )),
    ];
    f.render_widget(Paragraph::new(lines).block(panel("Keys")), r);
}

fn confirm(f: &mut Frame, area: Rect, m: &Model) {
    let r = modal(f, area, 58, 7);
    let lines = vec![
        Line::from(vec![
            Span::raw("Cancel "),
            Span::styled(m.run.name.clone(), bold()),
            Span::raw("?"),
        ]),
        Line::styled(
            "The current attempt stops; the steps it ran are billed.",
            dim(),
        ),
        Line::raw(""),
        Line::from(vec![
            Span::styled("y", bold()),
            Span::styled(" cancel the run    ", dim()),
            Span::styled("n", bold()),
            Span::styled(" keep it running", dim()),
        ]),
    ];
    let block = panel("Cancel run").border_style(fg(WARN));
    f.render_widget(Paragraph::new(lines).block(block), r);
}

// ---------------------------------------------------------------- driver

/// How following ended.
pub enum Outcome {
    /// The run reached a terminal status.
    Finished(Run),
    /// The user pressed `q` or Ctrl-C; the run keeps going.
    Detached(Run),
    /// `--timeout` elapsed first.
    TimedOut(Run),
}

/// Use the TUI: stdout and stdin are terminals, no --json/--plain, and the
/// terminal reports a usable size.
pub fn enabled(json: bool, plain: bool) -> bool {
    !json
        && !plain
        && std::io::stdout().is_terminal()
        && std::io::stdin().is_terminal()
        && std::env::var("TERM").map_or(true, |t| t != "dumb")
        && terminal::size().is_ok_and(|(w, h)| w >= 20 && h >= 6)
}

static ACTIVE: AtomicBool = AtomicBool::new(false);

fn restore() {
    if ACTIVE.swap(false, Ordering::SeqCst) {
        let _ = terminal::disable_raw_mode();
        let _ = execute!(
            std::io::stdout(),
            terminal::LeaveAlternateScreen,
            cursor::Show
        );
    }
}

/// Owns raw mode + the alternate screen; restores both on drop and on panic.
struct Term {
    t: Terminal<CrosstermBackend<Stdout>>,
}

impl Term {
    fn enter() -> std::io::Result<Term> {
        static HOOK: Once = Once::new();
        HOOK.call_once(|| {
            let prev = std::panic::take_hook();
            std::panic::set_hook(Box::new(move |info| {
                restore();
                prev(info);
            }));
        });
        terminal::enable_raw_mode()?;
        ACTIVE.store(true, Ordering::SeqCst);
        execute!(
            std::io::stdout(),
            terminal::EnterAlternateScreen,
            cursor::Hide
        )?;
        let t = Terminal::new(CrosstermBackend::new(std::io::stdout()))?;
        Ok(Term { t })
    }

    /// One frame inside a synchronized update, so terminals (and tmux) paint
    /// it at once; ratatui only writes the cells that changed.
    fn draw(&mut self, m: &Model) -> std::io::Result<()> {
        execute!(self.t.backend_mut(), terminal::BeginSynchronizedUpdate)?;
        let r = self.t.draw(|f| draw(f, m)).map(|_| ());
        execute!(self.t.backend_mut(), terminal::EndSynchronizedUpdate)?;
        r
    }
}

impl Drop for Term {
    fn drop(&mut self) {
        restore();
    }
}

enum Msg {
    Event(Box<RunEvent>),
    Run(Box<Run>),
    Checkpoints(Vec<Checkpoint>),
    Link(Option<String>),
    Polling,
    Fatal(Box<SdkError>),
    Input(Event),
    Cancelled(Box<Result<Run, SdkError>>),
}

fn fatal(e: &SdkError) -> bool {
    matches!(
        e,
        SdkError::Authentication(_) | SdkError::PermissionDenied(_) | SdkError::NotFound(_)
    )
}

/// The run's lifecycle events over SSE, from the first one (so attaching
/// mid-run backfills phases and every metric point), then live; reconnects
/// resume after the last event id, so nothing repeats or goes missing.
async fn pump_stream(c: Client, id: String, tx: UnboundedSender<Msg>, polling: Arc<AtomicBool>) {
    let mut last: Option<String> = None;
    let mut failures: u32 = 0;
    loop {
        let mut s = c
            .runs()
            .events(&id, true)
            .max_reconnects(1)
            .reconnect_base(Duration::from_millis(250));
        if let Some(l) = &last {
            s = s.after(l.clone());
        }
        let mut linked = false;
        loop {
            match s.next().await {
                Some(Ok(ev)) => {
                    failures = 0;
                    if let Some(l) = s.last_event_id() {
                        last = Some(l.to_string());
                    }
                    if !linked {
                        linked = true;
                        let _ = tx.send(Msg::Link(None));
                    }
                    let done = matches!(ev, SdkEvent::Completed(_));
                    if let Some(w) = RunEvent::from_sdk(&ev) {
                        let _ = tx.send(Msg::Event(Box::new(w)));
                    }
                    if done {
                        return;
                    }
                }
                Some(Err(e)) => {
                    if let Some(l) = s.last_event_id() {
                        last = Some(l.to_string());
                    }
                    if fatal(&e) {
                        let _ = tx.send(Msg::Fatal(Box::new(e)));
                        return;
                    }
                    if matches!(e, SdkError::Decode { .. }) {
                        polling.store(true, Ordering::SeqCst);
                        let _ = tx.send(Msg::Polling);
                        return;
                    }
                    let _ = tx.send(Msg::Link(Some(short_err(&e))));
                    break;
                }
                None => return,
            }
        }
        failures = (failures + 1).min(5);
        tokio::time::sleep(Duration::from_millis(500 << failures)).await;
        if tx.is_closed() {
            return;
        }
    }
}

fn short_err(e: &SdkError) -> String {
    match e {
        SdkError::Connection { .. } => "connection dropped".into(),
        SdkError::Timeout { .. } => "timed out".into(),
        other => {
            let s = other.to_string();
            s.chars().take(60).collect()
        }
    }
}

async fn fetch_checkpoints(c: &Client, id: &str, tx: &UnboundedSender<Msg>) {
    let p = ListParams {
        limit: Some(100),
        cursor: None,
    };
    if let Ok(page) = c.runs().checkpoints(id, &p).await {
        let _ = tx.send(Msg::Checkpoints(page.data));
    }
}

/// Polls the run (status, attempt, cost) and its checkpoints.
async fn pump_poll(c: Client, id: String, tx: UnboundedSender<Msg>, polling: Arc<AtomicBool>) {
    let mut i: u64 = 0;
    loop {
        let mut queued = false;
        match c.runs().get(&id).await {
            Ok(r) => {
                queued = r.status == RunStatus::Queued;
                if polling.load(Ordering::SeqCst) {
                    if let Some(p) = &r.latest_metric {
                        let _ = tx.send(Msg::Event(Box::new(RunEvent::metric(p.clone()))));
                    }
                }
                let terminal = r.status.is_terminal();
                let refresh = i % 3 == 0 || terminal;
                if tx.send(Msg::Run(Box::new(r))).is_err() {
                    return;
                }
                let _ = tx.send(Msg::Link(None));
                if refresh && !queued {
                    fetch_checkpoints(&c, &id, &tx).await;
                }
                if terminal {
                    return;
                }
            }
            Err(e) if fatal(&e) => {
                let _ = tx.send(Msg::Fatal(Box::new(e)));
                return;
            }
            Err(e) => {
                if tx.send(Msg::Link(Some(short_err(&e)))).is_err() {
                    return;
                }
            }
        }
        i += 1;
        tokio::time::sleep(Duration::from_secs(if queued { 2 } else { 4 })).await;
    }
}

fn now_epoch() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Follow `run` full-screen until it finishes, the user detaches, or `timeout`.
pub async fn follow(c: &Client, run: &Run, timeout: Duration) -> Result<Outcome, CliError> {
    let mut term = Term::enter()?;
    let (tx, mut rx) = unbounded_channel::<Msg>();
    let polling = Arc::new(AtomicBool::new(false));
    let tasks = [
        tokio::spawn(pump_stream(
            c.clone(),
            run.id.clone(),
            tx.clone(),
            polling.clone(),
        )),
        tokio::spawn(pump_poll(c.clone(), run.id.clone(), tx.clone(), polling)),
    ];
    let stop = Arc::new(AtomicBool::new(false));
    let input = {
        let (tx, stop) = (tx.clone(), stop.clone());
        std::thread::spawn(move || {
            while !stop.load(Ordering::SeqCst) {
                if let Ok(true) = event::poll(Duration::from_millis(100)) {
                    match event::read() {
                        Ok(ev) => {
                            if tx.send(Msg::Input(ev)).is_err() {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
            }
        })
    };
    let mut model = Model::new(run.clone(), now_epoch());
    let mut ticker = tokio::time::interval(Duration::from_millis(200));
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let deadline = Instant::now() + timeout;
    let mut terminal_seen: Option<Instant> = None;
    let mut fetched = Instant::now();
    let result = loop {
        if let Err(e) = term.draw(&model) {
            break Err(CliError::from(e));
        }
        let first = tokio::select! {
            _ = ticker.tick() => None,
            msg = rx.recv() => msg,
        };
        model.tick(now_epoch());
        if Instant::now() >= deadline {
            break Ok(Outcome::TimedOut(model.run.clone()));
        }
        if terminal_seen.is_some_and(|t| t.elapsed() >= Duration::from_secs(3)) {
            break Ok(Outcome::Finished(model.run.clone()));
        }
        let mut next = first;
        let mut out = None;
        while let Some(msg) = next.take() {
            match msg {
                Msg::Event(ev) => {
                    let done = matches!(*ev, RunEvent::Completed { .. });
                    model.apply_event(*ev);
                    if done {
                        out = Some(Ok(Outcome::Finished(model.run.clone())));
                    }
                }
                Msg::Run(r) => {
                    if r.status.is_terminal() && terminal_seen.is_none() {
                        terminal_seen = Some(Instant::now());
                    }
                    model.apply_run(*r);
                }
                Msg::Checkpoints(list) => model.apply_checkpoints(list),
                Msg::Link(e) => {
                    if model.link != Link::Polling {
                        model.link(e)
                    }
                }
                Msg::Polling => model.polling(),
                Msg::Fatal(e) => out = Some(Err(CliError::from(*e))),
                Msg::Cancelled(r) => match *r {
                    Ok(_) => model.notice(
                        false,
                        "Cancel requested; waiting for the worker to stop".into(),
                    ),
                    Err(e) => model.notice(true, format!("Cancel failed: {}", e)),
                },
                Msg::Input(Event::Key(k)) if k.kind != KeyEventKind::Release => {
                    match model.key(k.code, k.modifiers) {
                        Action::Detach => out = Some(Ok(Outcome::Detached(model.run.clone()))),
                        Action::Cancel => {
                            model.notice(false, "Cancelling…".into());
                            let (c, id, tx) = (c.clone(), model.run.id.clone(), tx.clone());
                            tokio::spawn(async move {
                                let _ =
                                    tx.send(Msg::Cancelled(Box::new(c.runs().cancel(&id).await)));
                            });
                        }
                        Action::None => {}
                    }
                }
                Msg::Input(_) => {}
            }
            if out.is_some() {
                break;
            }
            next = rx.try_recv().ok();
        }
        if let Some(o) = out {
            let _ = term.draw(&model);
            break o;
        }
        // New checkpoints: refetch the list (best flags, scores), at most every 2 s.
        if model.checkpoints_stale && fetched.elapsed() >= Duration::from_secs(2) {
            model.checkpoints_stale = false;
            fetched = Instant::now();
            let (c, id, tx) = (c.clone(), model.run.id.clone(), tx.clone());
            tokio::spawn(async move { fetch_checkpoints(&c, &id, &tx).await });
        }
    };
    stop.store(true, Ordering::SeqCst);
    for t in &tasks {
        t.abort();
    }
    let _ = input.join();
    drop(term);
    result
}

#[cfg(test)]
mod tests;
