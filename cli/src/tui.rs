//! Full-screen follower for a training run (`grad train --wait`, `grad runs watch`).
//!
//! [`Model`] folds the run, its metric stream and its checkpoints into view
//! state; [`draw`] renders it (pure, snapshot-tested with `TestBackend`);
//! [`follow`] owns the terminal. Colour is a handful of named ANSI colours on
//! the terminal's own background, so the user's theme decides how they look
//! on light and dark terminals; secondary text is dimmed, never greyed by RGB.

use std::collections::VecDeque;
use std::io::{IsTerminal, Stdout};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Once};
use std::time::{Duration, Instant};

use crossterm::event::{self, Event, KeyCode, KeyEventKind, KeyModifiers};
use crossterm::{cursor, execute, terminal};
use grad_sdk::{
    Checkpoint, Client, Error as SdkError, ListParams, MetricEvent, MetricPoint, Run, RunStatus,
};
use ratatui::backend::CrosstermBackend;
use ratatui::layout::{Constraint, Flex, Layout, Rect};
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
    Good,
    Warn,
    Bad,
}

impl Tone {
    fn style(self) -> Style {
        match self {
            Tone::Plain => Style::new(),
            Tone::Good => fg(GOOD),
            Tone::Warn => fg(WARN),
            Tone::Bad => fg(BAD),
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

const MAX_SAMPLES: usize = 4000;
const MAX_LOG: usize = 500;

/// View state of one followed run.
pub struct Model {
    run: Run,
    samples: Vec<Sample>,
    checkpoints: Vec<Checkpoint>,
    log: VecDeque<LogLine>,
    seen_seq: i64,
    /// (epoch ms, step, tokens) of recent points in the current attempt.
    window: VecDeque<(i64, i64, i64)>,
    tok_per_sec: Option<f64>,
    phase_key: &'static str,
    phase_since: i64,
    started: i64,
    now: i64,
    tick: usize,
    link: Link,
    notice: Option<(Tone, String)>,
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
            window: VecDeque::new(),
            tok_per_sec: None,
            phase_key: "",
            phase_since: started,
            started,
            now,
            tick: 0,
            link: Link::Live,
            notice: None,
            show_logs: false,
            help: false,
            confirm: false,
            run,
        };
        m.push_log(started, Tone::Plain, "Run created".into());
        if m.run.status != RunStatus::Queued {
            m.push_log(now, Tone::Plain, m.status_text());
        }
        if let Some(p) = m.run.latest_metric.clone() {
            m.apply_metric(p);
        }
        m.phase_key = m.phase().0;
        if m.run.status != RunStatus::Queued {
            m.phase_since = now;
        }
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

    fn sync_phase(&mut self) {
        let key = self.phase().0;
        if key != self.phase_key {
            self.phase_key = key;
            self.phase_since = self.now;
        }
    }

    fn status_text(&self) -> String {
        let r = &self.run;
        match &r.status {
            RunStatus::Queued => "Queued".into(),
            RunStatus::Running => format!("Attempt {}/{} started", r.attempt, r.max_attempts),
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

    fn interrupted(&mut self, new_attempt: i64) {
        let old = self.run.attempt;
        let at = self.run.current_step;
        let from = match self.resume_step(at) {
            Some(s) => format!("resuming from step {}", thousands(s)),
            None => "restarting from step 0".into(),
        };
        self.push_log(
            self.now,
            Tone::Warn,
            format!(
                "Attempt {} interrupted at step {}; attempt {}/{} {}",
                old,
                thousands(at),
                new_attempt,
                self.run.max_attempts,
                from
            ),
        );
        self.run.attempt = new_attempt;
        self.window.clear();
    }

    /// Fold a fresh run object (from polling or the final status event).
    pub fn apply_run(&mut self, r: Run) {
        if r.attempt > self.run.attempt {
            self.interrupted(r.attempt);
        }
        let changed = r.status != self.run.status;
        let streamed_step = self
            .last_point_step()
            .filter(|_| r.attempt == self.run.attempt);
        let cost = self.run.cost_usd;
        let tokens = self.run.tokens_processed;
        self.run = r;
        if let Some(s) = streamed_step {
            self.run.current_step = self.run.current_step.max(s);
        }
        if !self.run.status.is_terminal() {
            self.run.cost_usd = self.run.cost_usd.max(cost);
            self.run.tokens_processed = self.run.tokens_processed.max(tokens);
        }
        // Requeues are told by the interruption line; the first queue by "Run created".
        if changed && self.run.status != RunStatus::Queued {
            let tone = match self.run.status {
                RunStatus::Completed => Tone::Good,
                RunStatus::Failed => Tone::Bad,
                RunStatus::Cancelled | RunStatus::StoppedBudget => Tone::Warn,
                _ => Tone::Plain,
            };
            let text = self.status_text();
            self.push_log(self.now, tone, text);
            if self.run.status.is_terminal() {
                if let Some(rep) = &self.run.eval_report {
                    for w in rep.warnings.clone() {
                        self.push_log(self.now, Tone::Warn, w);
                    }
                }
            }
        }
        self.sync_phase();
    }

    fn last_point_step(&self) -> Option<i64> {
        self.samples.last().map(|s| s.step)
    }

    /// Fold one streamed metric point (duplicates by `seq` are ignored).
    pub fn apply_metric(&mut self, m: MetricPoint) {
        if m.seq <= self.seen_seq {
            return;
        }
        self.seen_seq = m.seq;
        if m.attempt > self.run.attempt {
            self.interrupted(m.attempt);
        }
        if self.run.status == RunStatus::Queued {
            self.run.status = RunStatus::Running;
            let text = self.status_text();
            self.push_log(self.now, Tone::Plain, text);
        }
        // A resumed attempt replays steps after its checkpoint: drop the overlap.
        if self.last_point_step().is_some_and(|s| m.step <= s) {
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
        if m.eval_loss.is_some() || m.eval_metrics.is_some() {
            let text = eval_line(&m);
            self.push_log(self.now, Tone::Plain, text);
        }
        self.run.current_step = m.step;
        self.run.cost_usd = self.run.cost_usd.max(m.cost_usd);
        self.run.tokens_processed = self.run.tokens_processed.max(m.tokens);
        self.run.latest_metric = Some(m);
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

    fn attempt_points(&self) -> bool {
        self.run
            .latest_metric
            .as_ref()
            .is_some_and(|m| m.attempt == self.run.attempt)
    }

    /// (stable key, label, tone) of the current phase.
    fn phase(&self) -> (&'static str, String, Tone) {
        let r = &self.run;
        match &r.status {
            RunStatus::Completed => ("completed", "Completed".into(), Tone::Good),
            RunStatus::Failed => ("failed", "Failed".into(), Tone::Bad),
            RunStatus::Cancelled => ("cancelled", "Cancelled".into(), Tone::Warn),
            RunStatus::StoppedBudget => ("stopped", "Stopped at the cost cap".into(), Tone::Warn),
            RunStatus::Queued if r.attempt > 1 || !self.samples.is_empty() => (
                "requeued",
                "Requeued · waiting for a GPU".into(),
                Tone::Warn,
            ),
            RunStatus::Queued => ("queued", "Waiting for a GPU".into(), Tone::Plain),
            RunStatus::Running if !self.attempt_points() && r.attempt > 1 => (
                "resuming",
                match self.resume_step(r.current_step) {
                    Some(s) => format!("Resuming from step {}", thousands(s)),
                    None => "Restarting from step 0".into(),
                },
                Tone::Warn,
            ),
            RunStatus::Running if !self.attempt_points() => {
                ("starting", "Starting".into(), Tone::Plain)
            }
            RunStatus::Running => ("training", "Training".into(), Tone::Plain),
            RunStatus::Other(s) => ("other", s.replace('_', " "), Tone::Plain),
        }
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
    if area.width >= 80 && area.height >= 22 {
        wide(f, area, m);
    } else {
        narrow(f, area, m);
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

/// Left and right content on one row.
fn row(f: &mut Frame, area: Rect, left: Line, right: Line) {
    let rw = (right.width() as u16).min(area.width);
    let [l, r] = Layout::horizontal([Constraint::Min(0), Constraint::Length(rw)]).areas(area);
    f.render_widget(Paragraph::new(left), l);
    f.render_widget(Paragraph::new(right), r);
}

fn header_lines(m: &Model) -> (Line<'static>, Line<'static>, Line<'static>) {
    let r = &m.run;
    let title = Line::from(vec![
        Span::styled(r.name.clone(), bold()),
        Span::raw("  "),
        Span::styled(r.id.clone(), dim()),
    ]);
    let end = r
        .finished_at
        .as_deref()
        .and_then(parse_ts)
        .filter(|_| r.status.is_terminal())
        .unwrap_or(m.now);
    let started = Line::from(vec![
        Span::styled("started ", dim()),
        Span::raw(format!("{} UTC", crate::output::when(&r.created_at))),
        sep(),
        Span::raw(fmt_duration((end - m.started).max(0))),
    ]);
    let config = Line::from(vec![
        Span::styled(r.recipe_kind.to_string(), fg(ACCENT)),
        sep(),
        Span::raw(r.resolved_config.model.clone()),
        sep(),
        Span::raw(r.dataset_name.clone()),
        Span::styled(format!("@{}", r.dataset_version), dim()),
    ]);
    (title, started, config)
}

fn phase_line(m: &Model) -> (Line<'static>, Line<'static>) {
    let (_, label, tone) = m.phase();
    let icon = match m.run.status {
        RunStatus::Completed => Span::styled("✓", fg(GOOD)),
        RunStatus::Failed => Span::styled("✗", fg(BAD)),
        RunStatus::Cancelled | RunStatus::StoppedBudget => Span::styled("■", fg(WARN)),
        _ => Span::styled(
            SPINNER[m.tick % SPINNER.len()],
            if tone == Tone::Plain {
                fg(ACCENT)
            } else {
                tone.style()
            },
        ),
    };
    let mut left = vec![
        icon,
        Span::raw(" "),
        Span::styled(label, tone.style().add_modifier(Modifier::BOLD)),
    ];
    if !m.run.status.is_terminal() {
        left.push(Span::styled(
            format!("  for {}", fmt_duration((m.now - m.phase_since).max(0))),
            dim(),
        ));
    }
    if let (RunStatus::Failed, Some(e)) = (&m.run.status, &m.run.error) {
        left.push(Span::styled(format!("  {}", e), fg(BAD)));
    }
    let a = if m.run.attempt > 0 {
        Line::from(vec![
            Span::styled("attempt ", dim()),
            Span::styled(
                format!("{}/{}", m.run.attempt, m.run.max_attempts),
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
    (Line::from(left), a)
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
        fill: fg(ACCENT),
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
                spans.push(Span::raw(format!(
                    "{:>5.0}%",
                    (x * 100.0).clamp(0.0, 100.0).floor()
                )));
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
    let area = area.inner(ratatui::layout::Margin::new(1, 0));
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
    let (title, started, config) = header_lines(m);
    row(f, head, title, started);
    f.render_widget(Paragraph::new(config), cfg);
    let (p, a) = phase_line(m);
    row(f, phase, p, a);
    let [g1, g2] = gauges(m, step.width, true);
    f.render_widget(Paragraph::new(g1), step);
    f.render_widget(Paragraph::new(g2), cost);
    if m.show_logs {
        events(f, body, m, "Events (l to close)");
    } else {
        let panels_h = (body.height / 3).clamp(5, 10);
        let [chart_a, lr_a, panels] = Layout::vertical([
            Constraint::Min(5),
            Constraint::Length(1),
            Constraint::Length(panels_h),
        ])
        .areas(body);
        let plot = loss_chart(f, chart_a, m);
        lr_line(f, lr_a, m, plot);
        let [ck, ev] =
            Layout::horizontal([Constraint::Length(34), Constraint::Min(20)]).areas(panels);
        checkpoints(f, ck, m);
        events(f, ev, m, "Events");
    }
    footer(f, foot, m, false);
}

fn narrow(f: &mut Frame, area: Rect, m: &Model) {
    let [head, cfg, phase, step, cost, pace_a, loss, _, rest, foot] = Layout::vertical([
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
    let (title, _, config) = header_lines(m);
    f.render_widget(Paragraph::new(title), head);
    f.render_widget(Paragraph::new(config), cfg);
    let (mut p, a) = phase_line(m);
    p.spans.push(Span::raw("  "));
    p.spans.extend(a.spans);
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
    // loss  0.412  best eval 0.455  ▁▂▃▅▆▇
    let mut spans = vec![Span::styled(format!("{:<6}", "loss"), dim())];
    if let Some(s) = m.samples.last() {
        spans.push(Span::styled(num(s.loss), fg(ACCENT)));
    }
    if let Some((_, e)) = m.best_eval() {
        spans.push(Span::styled("  best eval ", dim()));
        spans.push(Span::styled(num(e), fg(EVAL)));
    }
    let used: usize = spans.iter().map(Span::width).sum::<usize>() + 2;
    let [txt, spark] =
        Layout::horizontal([Constraint::Length(used as u16), Constraint::Min(0)]).areas(loss);
    f.render_widget(Paragraph::new(Line::from(spans)), txt);
    let data = series(m.samples.iter().map(|s| s.loss), spark.width as usize);
    f.render_widget(Sparkline::default().data(&data).style(fg(ACCENT)), spark);
    if m.show_logs || rest.height >= 2 {
        log_lines(f, rest, m);
    }
    footer(f, foot, m, true);
}

/// Values scaled to 1..=100 for a sparkline, resampled to `width` buckets.
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
        .map(|x| 1 + ((x - lo) / span * 99.0).round() as u64)
        .collect()
}

/// Draws the loss chart; returns its plot columns (x, width) and x range so
/// the lr sparkline below can line up with it.
fn loss_chart(f: &mut Frame, area: Rect, m: &Model) -> Option<(u16, u16, f64, f64)> {
    let mut legend = Vec::new();
    if let Some(s) = m.samples.last() {
        legend.push(Span::raw(" "));
        legend.push(Span::styled("━ ", fg(ACCENT)));
        legend.push(Span::styled("train ", dim()));
        legend.push(Span::raw(num(s.loss)));
    }
    if let Some(e) = m.samples.iter().rev().find_map(|s| s.eval) {
        legend.push(Span::raw("   "));
        legend.push(Span::styled("━ ", fg(EVAL)));
        legend.push(Span::styled("eval ", dim()));
        legend.push(Span::raw(num(e)));
    }
    let best = m.best_eval();
    if let Some((step, e)) = best {
        legend.push(Span::raw("   "));
        legend.push(Span::styled("● ", fg(GOOD)));
        legend.push(Span::styled("best ", dim()));
        legend.push(Span::raw(format!("{} @ {}", num(e), thousands(step))));
    }
    if !legend.is_empty() {
        legend.push(Span::raw(" "));
    }
    let block = panel("Loss").title(Line::from(legend).right_aligned());
    if m.samples.is_empty() {
        let msg = if m.run.status == RunStatus::Queued {
            "The chart starts with the first training step."
        } else {
            "Waiting for the first step…"
        };
        let inner = block.inner(area);
        f.render_widget(block, area);
        let [_, mid, _] = Layout::vertical([
            Constraint::Fill(1),
            Constraint::Length(1),
            Constraint::Fill(1),
        ])
        .areas(inner);
        f.render_widget(Paragraph::new(msg).style(dim()).centered(), mid);
        return None;
    }
    let width = area.width.saturating_sub(12).max(10) as usize * 2;
    let stride = m.samples.len().div_ceil(width).max(1);
    let mut train: Vec<(f64, f64)> = m
        .samples
        .iter()
        .step_by(stride)
        .map(|s| (s.step as f64, s.loss))
        .collect();
    if let Some(s) = m.samples.last() {
        if train.last().map(|p| p.0) != Some(s.step as f64) {
            train.push((s.step as f64, s.loss));
        }
    }
    let eval: Vec<(f64, f64)> = m
        .samples
        .iter()
        .filter_map(|s| s.eval.map(|e| (s.step as f64, e)))
        .collect();
    let best_pt: Vec<(f64, f64)> = best.map(|(s, e)| vec![(s as f64, e)]).unwrap_or_default();
    let ys = train.iter().chain(eval.iter()).map(|p| p.1);
    let (lo, hi) = ys.fold((f64::MAX, f64::MIN), |(a, b), y| (a.min(y), b.max(y)));
    let pad = ((hi - lo) * 0.08).max(1e-6);
    let (lo, hi) = ((lo - pad).max(0.0_f64.min(lo)), hi + pad);
    let x0 = m.samples.first().map(|s| s.step).unwrap_or(0).min(0) as f64;
    let x1 = (m
        .run
        .total_steps
        .max(m.samples.last().map(|s| s.step).unwrap_or(1)))
    .max(1) as f64;
    let mut sets = vec![Dataset::default()
        .marker(Marker::Braille)
        .graph_type(GraphType::Line)
        .style(fg(ACCENT))
        .data(&train)];
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
                .data(&best_pt),
        );
    }
    let ylabels = [num(round3(lo)), num(round3(hi))];
    let inner = block.inner(area);
    let label_w = ylabels.iter().map(|l| l.len() as u16).max().unwrap_or(0);
    let plot_x = inner.x + label_w.min(inner.width / 3) + 1;
    let plot = (plot_x, inner.right().saturating_sub(plot_x), x0, x1);
    let chart = Chart::new(sets)
        .block(block)
        .legend_position(None)
        .x_axis(
            Axis::default()
                .bounds([x0, x1])
                .style(dim())
                .labels([thousands(x0 as i64), thousands(x1 as i64)]),
        )
        .y_axis(
            Axis::default()
                .bounds([lo, hi])
                .style(dim())
                .labels(ylabels),
        );
    f.render_widget(chart, area);
    Some(plot)
}

fn round3(x: f64) -> f64 {
    if x == 0.0 {
        return 0.0;
    }
    let mag = 10f64.powi(2 - x.abs().log10().floor() as i32);
    (x * mag).round() / mag
}

/// The learning rate as a sparkline under the chart's plot, spanning the
/// same steps.
fn lr_line(f: &mut Frame, area: Rect, m: &Model, plot: Option<(u16, u16, f64, f64)>) {
    let lrs: Vec<f64> = m.samples.iter().filter_map(|s| s.lr).collect();
    let (Some(last), Some((px, pw, x0, x1)), Some(s)) =
        (lrs.last().copied(), plot, m.samples.last())
    else {
        return;
    };
    let frac = ((s.step as f64 - x0) / (x1 - x0).max(1.0)).clamp(0.0, 1.0);
    let value = format!(" {}", num(last));
    let sw = ((pw as f64 * frac).round() as u16)
        .max(1)
        .min(pw.saturating_sub(value.len() as u16));
    let label = Rect::new(area.x, area.y, px.saturating_sub(area.x + 1), 1);
    f.render_widget(
        Paragraph::new(Span::styled("lr", dim())).right_aligned(),
        label,
    );
    let spark = Rect::new(px, area.y, sw, 1);
    let data = series(lrs.into_iter(), sw as usize);
    f.render_widget(Sparkline::default().data(&data).style(dim()), spark);
    let val = Rect::new(px + data.len() as u16, area.y, value.len() as u16, 1).intersection(area);
    f.render_widget(Paragraph::new(Span::styled(value, dim())), val);
}

fn checkpoints(f: &mut Frame, area: Rect, m: &Model) {
    let block = panel("Checkpoints");
    let rows = block.inner(area).height as usize;
    let mut lines = vec![Line::styled(
        format!("{:>7}  {:<9}", "step", "score"),
        dim(),
    )];
    if m.checkpoints.is_empty() {
        lines.push(Line::styled("   none yet", dim()));
    }
    let skip = m.checkpoints.len().saturating_sub(rows.saturating_sub(1));
    let best = m.best_checkpoint();
    for c in m.checkpoints.iter().skip(skip) {
        let mut spans = vec![
            Span::raw(format!("{:>7}", thousands(c.step))),
            Span::raw("  "),
            Span::raw(format!(
                "{:<9}",
                c.eval_score.map(num).unwrap_or_else(|| "-".into())
            )),
        ];
        if best == Some(c.id.as_str()) {
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

/// One log entry as rows: `  12:05  text`, continuation rows indented.
fn log_rows(m: &Model, l: &LogLine, width: usize) -> Vec<Line<'static>> {
    const GUTTER: usize = 9;
    wrap(&l.text, width.saturating_sub(GUTTER))
        .into_iter()
        .enumerate()
        .map(|(i, row)| {
            let lead = if i == 0 {
                format!("{:>7}  ", clock(l.at - m.started))
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
            Span::styled(format!(" {}   ", what), dim()),
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
    Metric(Box<MetricPoint>),
    Finished(Box<Run>),
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

/// The SSE stream, reconnecting with Last-Event-ID for as long as we follow.
async fn pump_stream(c: Client, id: String, tx: UnboundedSender<Msg>, polling: Arc<AtomicBool>) {
    let mut last: Option<String> = None;
    let mut failures: u32 = 0;
    loop {
        let mut s = c
            .runs()
            .stream_metrics(&id, last.clone())
            .max_reconnects(1)
            .reconnect_base(Duration::from_millis(250));
        loop {
            match s.next().await {
                Some(Ok(MetricEvent::Metric(p))) => {
                    failures = 0;
                    let _ = tx.send(Msg::Link(None));
                    let _ = tx.send(Msg::Metric(p));
                }
                Some(Ok(MetricEvent::Finished(r))) => {
                    let _ = tx.send(Msg::Finished(r));
                    return;
                }
                Some(Err(e)) => {
                    last = s.last_event_id().map(str::to_string).or(last);
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
                        let _ = tx.send(Msg::Metric(Box::new(p.clone())));
                    }
                }
                let terminal = r.status.is_terminal();
                let refresh = i % 3 == 0 || terminal;
                if tx.send(Msg::Run(Box::new(r))).is_err() {
                    return;
                }
                let _ = tx.send(Msg::Link(None));
                if refresh && !queued {
                    let p = ListParams {
                        limit: Some(100),
                        cursor: None,
                    };
                    if let Ok(page) = c.runs().checkpoints(&id, &p).await {
                        let _ = tx.send(Msg::Checkpoints(page.data));
                    }
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
                Msg::Metric(p) => model.apply_metric(*p),
                Msg::Run(r) => {
                    if r.status.is_terminal() && terminal_seen.is_none() {
                        terminal_seen = Some(Instant::now());
                    }
                    model.apply_run(*r);
                }
                Msg::Finished(r) => {
                    model.apply_run(*r);
                    out = Some(Ok(Outcome::Finished(model.run.clone())));
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
