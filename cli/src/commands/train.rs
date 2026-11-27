//! `grad train` and `grad runs`.

use grad_sdk::{
    Artifact, AttemptKind, Client, Error as SdkError, EvalReport, MetricEvent, MetricPoint,
    MetricsQuery, PhaseEvent, PlanRunRequest, PlanRunResponse, Run, RunEvent, RunPhase, RunStatus,
};
use serde_json::{json, Value};
use std::io::Write;
use std::time::{Duration, Instant};

use super::{
    in_range, more_hint, on_interrupt, page, positive, resolve_run, resolve_run_to_change, Ctx,
};
use crate::cli::{RunsCmd, TrainArgs};
use crate::output::{compact, num, opt, pct, thousands, usd, when, CliError, CliResult, Out};
use crate::trainfile::{self, RunFile};
use crate::tui;

/// Merge `-f FILE` with flags (flags win) into a typed request.
pub fn build_request(a: &TrainArgs) -> CliResult<PlanRunRequest> {
    let mut rf = match &a.file {
        Some(p) => trainfile::parse(p)?,
        None => RunFile::default(),
    };
    if a.dataset.is_some() {
        rf.dataset = a.dataset.clone();
    }
    if a.name.is_some() {
        rf.name = a.name.clone();
    }
    if a.recipe.is_some() {
        rf.recipe = a.recipe.clone();
    }
    if let Some(c) = positive(a.max_cost_usd, "--max-cost-usd")? {
        rf.max_cost_usd = Some(c);
    }
    let p = &mut rf.params;
    let mut set = |k: &str, v: Option<Value>| {
        if let Some(v) = v {
            p.insert(k.to_string(), v);
        }
    };
    set("model", a.model.clone().map(Value::String));
    set(
        "models",
        a.models.clone().map(|m| {
            json!(m
                .into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect::<Vec<_>>())
        }),
    );
    if let Some(lr) = &a.lr {
        let v = if lr == "auto" {
            json!("auto")
        } else {
            let x: f64 = lr.parse().map_err(|_| {
                CliError::usage(format!("--lr must be \"auto\" or a number, got '{}'", lr))
            })?;
            positive(Some(x), "--lr")?;
            json!(x)
        };
        set("lr", Some(v));
    }
    set(
        "lr_scale",
        positive(a.lr_scale, "--lr-scale")?.map(|x| json!(x)),
    );
    set("epochs", a.epochs.map(|x| json!(x)));
    set("batch_size", a.batch_size.map(|x| json!(x)));
    set("train_on", a.train_on.clone().map(Value::String));
    set("thinking", a.thinking.clone().map(Value::String));
    set("beta", positive(a.beta, "--beta")?.map(|x| json!(x)));
    set(
        "max_quality_drop",
        in_range(a.max_quality_drop, "--max-quality-drop", 0.0, 1.0)?.map(|x| json!(x)),
    );
    set("num_tokens", a.num_tokens.map(|x| json!(x)));
    set("teacher", a.teacher.clone().map(Value::String));
    set(
        "rollout",
        a.rollout.as_ref().map(|r| {
            let mut v = json!({"kind": r.replace('-', "_")});
            if let Some(n) = a.max_new_tokens {
                v["max_new_tokens"] = json!(n);
            }
            v
        }),
    );
    set("rubric", a.score.clone().map(Value::String));
    if let Some(r) = &a.rubric {
        let path = std::path::Path::new(r);
        let v = if path.is_file() {
            serde_json::to_value(super::eval::load_rubric(path)?)
                .map_err(|e| CliError::usage(e.to_string()))?
        } else {
            Value::String(r.clone())
        };
        set("rubric", Some(v));
    }
    if let Some(path) = &a.context_file {
        let text = std::fs::read_to_string(path)
            .map_err(|e| CliError::usage(format!("--context-file {}: {}", path.display(), e)))?;
        set("context_text", Some(Value::String(text)));
    }
    if let Some(rank) = a.adapter_rank {
        let mut adapter = p
            .get("adapter")
            .cloned()
            .filter(|v| v.get("kind").and_then(Value::as_str) == Some("lora"))
            .unwrap_or_else(|| json!({"kind": "lora"}));
        adapter["rank"] = json!(rank);
        p.insert("adapter".into(), adapter);
    }
    for s in &a.set {
        let (k, v) = trainfile::parse_set(s)?;
        p.insert(k, v);
    }
    if a.split.is_some() || a.eval_fraction.is_some() {
        let mut split = rf.split.take().unwrap_or_else(|| json!({}));
        if let Some(s) = &a.split {
            split["strategy"] = json!(s);
        }
        if let Some(f) = in_range(a.eval_fraction, "--eval-fraction", 0.0, 0.9)? {
            split["eval_fraction"] = json!(f);
        }
        rf.split = Some(split);
    }
    trainfile::build_request(rf)
}

fn print_plan(out: &Out, req: &PlanRunRequest, plan: &PlanRunResponse) {
    let rc = &plan.resolved_config;
    out.line(format!(
        "Plan for {} ({} on {}, dataset {} v{})",
        req.name, rc.recipe_kind, rc.model, req.dataset, plan.dataset_version
    ));
    let mut rows = vec![
        (
            "records",
            format!(
                "{} usable of {}",
                thousands(plan.usable_records),
                thousands(plan.total_records)
            ),
        ),
        (
            "split",
            format!(
                "{} train / {} eval ({}, {:.0}% held out)",
                thousands(rc.split.train_records),
                thousands(rc.split.eval_records),
                rc.split.strategy,
                rc.split.eval_fraction * 100.0
            ),
        ),
        (
            "steps",
            format!(
                "{} (batch {}, {} epoch{})",
                thousands(plan.estimated_steps),
                rc.batch_size,
                rc.epochs,
                if rc.epochs == 1 { "" } else { "s" }
            ),
        ),
        ("lr", format!("{} ({})", num(rc.lr), rc.lr_source)),
        (
            "tokens",
            format!(
                "~{} ({} trained)",
                compact(plan.estimated_tokens),
                pct(plan.trained_token_fraction)
            ),
        ),
        (
            "est. cost",
            format!(
                "{} at {}/1M tokens{}",
                usd(plan.estimated_cost_usd),
                usd(plan.price_per_million_tokens),
                req.max_cost_usd
                    .map(|c| format!(" (cap {})", usd(c)))
                    .unwrap_or_default()
            ),
        ),
        (
            "breakdown",
            format!(
                "train {} · teacher {} · evals {} (held-out evals during training aren't billed)",
                usd(plan.cost_breakdown.train_usd),
                usd(plan.cost_breakdown.teacher_usd),
                usd(plan.cost_breakdown.eval_usd)
            ),
        ),
        (
            "duration",
            format!(
                "~{} on one GPU{}",
                fmt_duration(plan.estimated_duration_s),
                plan.min_gpu_memory_gb
                    .map(|gb| format!(" (needs {} GB of GPU memory)", num(gb)))
                    .unwrap_or_default()
            ),
        ),
    ];
    if let Ok(adapter) = serde_json::to_value(&rc.adapter) {
        rows.push(("adapter", compact_json(&adapter)));
    }
    if let Some(t) = &plan.teacher {
        rows.push((
            "teacher",
            format!(
                "{}: ~{} tokens, {} at {}/1M (included above)",
                t.model,
                compact(t.estimated_tokens),
                usd(t.estimated_cost_usd),
                usd(t.price_per_million_tokens)
            ),
        ));
    }
    if let Some(l) = &plan.labeling {
        rows.push((
            "labeling",
            format!(
                "{} model + {} judge calls, {} (billed as an eval, included above)",
                thousands(l.estimated_model_calls),
                thousands(l.estimated_judge_calls),
                usd(l.estimated_cost_usd)
            ),
        ));
    }
    for (k, v) in rows {
        out.line(format!("  {:<10}: {}", k, v));
    }
    if !plan.warnings.is_empty() {
        out.line("  warnings:");
        for w in &plan.warnings {
            out.line(format!("    - {}", w));
        }
    }
    out.line("  Start it by re-running without --dry-run (add --wait to follow it).");
}

fn compact_json(v: &Value) -> String {
    match v {
        Value::Object(m) => m
            .iter()
            .map(|(k, v)| {
                format!(
                    "{}={}",
                    k,
                    match v {
                        Value::String(s) => s.clone(),
                        other => other.to_string(),
                    }
                )
            })
            .collect::<Vec<_>>()
            .join(", "),
        other => other.to_string(),
    }
}

pub async fn train(ctx: &Ctx, a: TrainArgs) -> CliResult {
    let req = build_request(&a)?;
    let c = ctx.client()?;
    let out = &ctx.out;
    if a.dry_run {
        let plan = c.runs().plan(&req).await?;
        print_plan(out, &req, &plan);
        return out.done(&plan);
    }
    if a.wait && !out.json {
        match c.datasets().get(&req.dataset).await {
            Ok(d) => out.line(format!(
                "✓ Dataset {}: {} records (version {})",
                d.name,
                thousands(d.record_count),
                d.version
            )),
            Err(SdkError::NotFound(_)) => {}
            Err(e) => return Err(e.into()),
        }
    }
    let run = c.runs().create(&req, a.idempotency_key.as_deref()).await?;
    // The plan's warnings (e.g. "run X is already running"); --wait shows them as events.
    if !a.wait || out.json {
        for w in run.warnings.iter().flatten() {
            out.warn(w.clone());
        }
    }
    if !a.wait {
        out.line(format!(
            "✓ Started run {} ({} on {}, {} steps)",
            run.id, run.recipe_kind, run.resolved_config.model, run.total_steps
        ));
        out.line(format!("  Follow it: grad runs logs {} --follow", run.id));
        return out.done(&run);
    }
    let finished = follow_run(ctx, &c, &run, Duration::from_secs(a.timeout)).await?;
    let artifact = report_finished(ctx, &c, &finished).await;
    out.done(&json!({ "run": finished, "artifact": artifact }))
}

struct Live {
    tty: bool,
    json: bool,
    last_print: Option<Instant>,
    total: i64,
    open_line: bool,
    /// While queued for compute: the phase event and when it began (epoch seconds).
    waiting: Option<(PhaseEvent, Option<i64>)>,
    /// The last phase line printed, so repeats stay quiet.
    last_phase: Option<(i64, RunPhase)>,
}

/// Epoch seconds now (for "waiting since" readouts).
fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// "Waiting for a GPU (0 workers online)" or, with scale-from-zero, "Starting a GPU worker (autoscaling)".
pub(crate) fn waiting_line(p: &PhaseEvent, waited: Option<i64>) -> String {
    let what = if p.autoscaling == Some(true) && p.workers_online.unwrap_or(0) == 0 {
        "Starting a GPU worker (autoscaling)…".to_string()
    } else {
        let n = p.workers_online.unwrap_or(0);
        format!(
            "Waiting for a GPU ({} worker{} online{})",
            n,
            if n == 1 { "" } else { "s" },
            if n > 0 { ", all busy" } else { "" }
        )
    };
    match waited {
        Some(s) => format!("  {} — {}", what, fmt_wait(s)),
        None => format!("  {}", what),
    }
}

fn fmt_wait(s: i64) -> String {
    if s < 60 {
        format!("{}s", s)
    } else if s < 3600 {
        format!("{}m {:02}s", s / 60, s % 60)
    } else {
        format!("{}h {:02}m", s / 3600, (s % 3600) / 60)
    }
}

/// The plain-text line for a lifecycle event, if it gets one.
pub(crate) fn event_line(ev: &RunEvent) -> Option<String> {
    match ev {
        RunEvent::Phase(p) => match p.phase {
            RunPhase::Starting => Some(match &p.gpu {
                Some(g) => format!("  ▸ Starting on {} ({:.0} GB)", g.name, g.memory_gb),
                None => "  ▸ Starting".to_string(),
            }),
            RunPhase::LoadingModel => Some("  ▸ Loading the model".into()),
            RunPhase::Training => Some("  ▸ Training".into()),
            RunPhase::Uploading => Some("  ▸ Uploading the artifact".into()),
            RunPhase::Completing => Some("  ▸ Completing".into()),
            _ => None,
        },
        RunEvent::Attempt(a) => match a.event {
            AttemptKind::Started if a.meta.attempt > 1 => Some(format!("  ▸ {}", a.message)),
            AttemptKind::Interrupted | AttemptKind::GaveUp => Some(format!("⚠ {}", a.message)),
            _ => None,
        },
        RunEvent::Warning(w) => Some(format!("⚠ {}", w.message)),
        RunEvent::Log(l) => Some(format!("  · {}", l.message)),
        _ => None,
    }
}

impl Live {
    fn clear(&mut self) {
        if self.open_line {
            print!("\r\x1b[2K");
            let _ = std::io::stdout().flush();
            self.open_line = false;
        }
    }

    fn print(&mut self, line: &str) {
        self.clear();
        println!("{}", line);
    }

    /// Redraw the in-place waiting line (TTY only).
    fn tick(&mut self) {
        if self.json || !self.tty {
            return;
        }
        if let Some((p, since)) = &self.waiting {
            let line = waiting_line(p, since.map(|s| (now_secs() - s).max(0)));
            print!("\r\x1b[2K{}", line);
            let _ = std::io::stdout().flush();
            self.open_line = true;
        }
    }

    fn event(&mut self, ev: &RunEvent) {
        if self.json {
            return;
        }
        if let RunEvent::Metric(m) = ev {
            self.metric(&m.metric);
            return;
        }
        if let RunEvent::Phase(p) = ev {
            if matches!(p.phase, RunPhase::Queued | RunPhase::WaitingForCompute) {
                let since = parse_ts(&p.meta.timestamp);
                let changed = self.waiting.as_ref().is_none_or(|(w, _)| {
                    w.workers_online != p.workers_online || w.autoscaling != p.autoscaling
                });
                self.waiting = Some((p.clone(), since));
                if self.tty {
                    self.tick();
                } else if changed {
                    println!(
                        "{}",
                        waiting_line(p, since.map(|s| (now_secs() - s).max(0)))
                    );
                }
                return;
            }
            if self.waiting.take().is_some() {
                self.clear();
            }
            // Training resumes after every eval and checkpoint: say it once per attempt.
            let key = (p.meta.attempt, p.phase.clone());
            if p.phase == RunPhase::Training && self.last_phase.as_ref() == Some(&key) {
                return;
            }
            if let Some(line) = event_line(ev) {
                self.last_phase = Some(key);
                self.print(&line);
            }
            return;
        }
        if let Some(line) = event_line(ev) {
            self.print(&line);
        }
    }

    fn metric(&mut self, m: &MetricPoint) {
        if self.json {
            return;
        }
        let line = format!(
            "  step {:>5}/{:<5} loss {:<8} {}{}tokens {:<7} {}",
            m.step,
            self.total,
            num(m.loss),
            m.eval_loss
                .map(|x| format!("eval {:<8} ", num(x)))
                .unwrap_or_default(),
            m.lr.map(|x| format!("lr {:<7} ", num(x)))
                .unwrap_or_default(),
            compact(m.tokens),
            usd(m.cost_usd)
        );
        if self.tty {
            print!("\r\x1b[2K{}", line);
            let _ = std::io::stdout().flush();
            self.open_line = true;
        } else {
            let every = (self.total / 10).max(1);
            let due = self
                .last_print
                .is_none_or(|t| t.elapsed() >= Duration::from_secs(5));
            if due || m.step % every == 0 || m.step == self.total || m.eval_loss.is_some() {
                println!("{}", line);
                self.last_print = Some(Instant::now());
            }
        }
    }

    fn end(&mut self) {
        self.waiting = None;
        if self.open_line {
            println!();
            self.open_line = false;
        }
    }
}

/// Follow a run until it finishes: the full-screen view on a terminal, metric
/// lines otherwise. Returns the terminal run or a typed error.
async fn follow_run(ctx: &Ctx, c: &Client, run: &Run, timeout: Duration) -> CliResult<Run> {
    let res = if tui::enabled(ctx.out.json, ctx.global.plain) {
        match tui::follow(c, run, timeout).await? {
            tui::Outcome::Finished(r) if r.status == RunStatus::Completed => Ok(r),
            tui::Outcome::Finished(r) => Err(SdkError::RunFailed(Box::new(r))),
            tui::Outcome::Detached(r) => {
                return Err(CliError::interrupted(format!(
                    "detached; run {} keeps going on the server",
                    r.id
                ))
                .hint(format!(
                    "Reattach with `grad runs watch {}`; stop it with `grad runs cancel {}`",
                    r.id, r.id
                )))
            }
            tui::Outcome::TimedOut(r) => Err(SdkError::WaitTimeout {
                what: "run".into(),
                id: r.id.clone(),
                status: r.status.to_string(),
                after: timeout,
            }),
        }
    } else {
        follow_lines(ctx, c, run, timeout).await
    };
    match res {
        Ok(r) => Ok(r),
        Err(SdkError::RunFailed(r)) => {
            let mut err = CliError::from(SdkError::RunFailed(r.clone()));
            err.hint = Some(match r.status {
                RunStatus::StoppedBudget => format!(
                    "The run hit its cost cap ({} spent). Raise it and continue: grad runs resume {} --max-cost-usd <USD>",
                    usd(r.cost_usd),
                    r.id
                ),
                RunStatus::StoppedBalance => format!(
                    "The workspace ran out of balance ({} spent). Top up, then continue: grad runs resume {}",
                    usd(r.cost_usd),
                    r.id
                ),
                RunStatus::Cancelled => format!("Resume it with: grad runs resume {}", r.id),
                _ => format!(
                    "Inspect it with `grad runs inspect {}`; resume from the last checkpoint with `grad runs resume {}`",
                    r.id, r.id
                ),
            });
            Err(err)
        }
        Err(e) => Err(e.into()),
    }
}

/// The plain readout: one line per metric (rewritten in place on a TTY).
async fn follow_lines(
    ctx: &Ctx,
    c: &Client,
    run: &Run,
    timeout: Duration,
) -> Result<Run, SdkError> {
    let out = &ctx.out;
    on_interrupt(format!(
        "stopped following; run {} keeps going on the server (`grad runs logs {} --follow` to watch, `grad runs cancel {}` to stop)",
        run.id, run.id, run.id
    ));
    let split = &run.resolved_config.split;
    if split.train_records + split.eval_records > 0 {
        out.line(format!(
            "✓ Split: {} train / {} eval ({})",
            thousands(split.train_records),
            thousands(split.eval_records),
            split.strategy.as_str().replace('_', " ")
        ));
    }
    out.line(format!(
        "  Run {}: {} on {}, {} steps",
        run.id, run.recipe_kind, run.resolved_config.model, run.total_steps
    ));
    let mut live = Live {
        tty: out.tty,
        json: out.json,
        last_print: None,
        total: run.total_steps,
        open_line: false,
        waiting: None,
        last_phase: None,
    };
    let res = follow_events(c, &run.id, timeout, &mut live).await;
    live.end();
    res
}

/// Follow the run's event stream into `live` until `completed` (ticking the
/// waiting line once a second on a TTY); the terminal run, or a typed error.
async fn follow_events(
    c: &Client,
    id: &str,
    timeout: Duration,
    live: &mut Live,
) -> Result<Run, SdkError> {
    let started = Instant::now();
    let mut stream = c.runs().events(id, true);
    let mut ticker = tokio::time::interval(Duration::from_secs(1));
    let deadline = tokio::time::sleep(timeout);
    tokio::pin!(deadline);
    loop {
        // One read stays in flight across ticks, so the ticker never cancels it.
        let next = stream.next();
        tokio::pin!(next);
        let ev = loop {
            tokio::select! {
                ev = &mut next => break ev,
                _ = ticker.tick() => live.tick(),
                _ = &mut deadline => {
                    let status = c.runs().get(id).await.map(|r| r.status.as_str().to_string());
                    return Err(SdkError::WaitTimeout {
                        what: "run".into(),
                        id: id.into(),
                        status: status.unwrap_or_else(|_| "unknown".into()),
                        after: started.elapsed(),
                    });
                }
            }
        };
        match ev {
            Some(Ok(RunEvent::Completed(done))) => {
                return if done.run.status == RunStatus::Completed {
                    Ok(done.run)
                } else {
                    Err(SdkError::RunFailed(Box::new(done.run)))
                };
            }
            Some(Ok(ev)) => live.event(&ev),
            Some(Err(e)) => return Err(e),
            // The stream ends only after `completed` or an error; re-read to be sure.
            None => {
                let run = c.runs().get(id).await?;
                return match run.status {
                    RunStatus::Completed => Ok(run),
                    _ => Err(SdkError::RunFailed(Box::new(run))),
                };
            }
        }
    }
}

/// Print the trained/eval/artifact readout; returns the artifact when there is one.
async fn report_finished(ctx: &Ctx, c: &Client, run: &Run) -> Option<Artifact> {
    let out = &ctx.out;
    let secs = elapsed_secs(&run.created_at, run.finished_at.as_deref());
    out.line(format!(
        "✓ Trained {} {} in {} (~{} tokens, {})",
        run.resolved_config.model,
        run.recipe_kind,
        secs.map(fmt_duration).unwrap_or_else(|| "-".into()),
        compact(run.tokens_processed),
        usd(run.cost_usd)
    ));
    if let Some(report) = &run.eval_report {
        print_report(out, report);
        if serde_json::to_value(report)
            .ok()
            .and_then(|v| v.get("routes_any_traffic").and_then(Value::as_bool))
            == Some(false)
        {
            out.line(
                "! The router routes no traffic: every request goes to the fallback model. \
                 Add records, or raise --max-quality-drop.",
            );
        }
    }
    let artifact = match &run.artifact_id {
        Some(id) => c.artifacts().get(id).await.ok(),
        None => None,
    };
    match &artifact {
        Some(a) => {
            out.line(format!("✓ Exported artifact {}", a.reference()));
            if a.format.as_ref().map(|f| f.as_str()) == Some("reference") {
                out.line("  This is a reference-backend test artifact; it cannot be deployed.");
            } else {
                out.line(format!(
                    "  Next: grad artifacts download {} --output ./{}",
                    a.reference(),
                    a.name
                ));
                out.line(format!(
                    "    or: grad deploy {}   # Gradiated Cloud",
                    a.reference()
                ));
            }
        }
        None => {
            if let Some(id) = &run.artifact_id {
                out.line(format!("✓ Exported artifact {}", id));
                out.line(format!(
                    "  Next: grad artifacts download {} --output ./{}",
                    id, run.name
                ));
            }
        }
    }
    artifact
}

fn print_report(out: &Out, report: &EvalReport) {
    let Ok(Value::Object(m)) = serde_json::to_value(report) else {
        return;
    };
    let mut scalars: Vec<(String, String)> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();
    for (k, v) in &m {
        match v {
            Value::Number(n) => {
                let f = n.as_f64().unwrap_or(0.0);
                let shown = if n.is_i64() || n.is_u64() {
                    thousands(f as i64)
                } else {
                    num(f)
                };
                scalars.push((k.replace('_', " "), shown));
            }
            Value::String(s) => scalars.push((k.replace('_', " "), s.clone())),
            Value::Bool(b) => scalars.push((k.replace('_', " "), b.to_string())),
            Value::Array(a) if k == "warnings" => warnings.extend(a.iter().map(|w| {
                w.as_str()
                    .map(str::to_string)
                    .unwrap_or_else(|| w.to_string())
            })),
            Value::Object(inner) => {
                for (ik, iv) in inner {
                    if let Some(f) = iv.as_f64() {
                        scalars.push((
                            format!("{} {}", k.replace('_', " "), ik.replace('_', " ")),
                            num(f),
                        ));
                    }
                }
            }
            _ => {}
        }
    }
    if scalars.is_empty() && warnings.is_empty() {
        return;
    }
    out.line("");
    out.line("  Eval report:");
    let w = scalars
        .iter()
        .map(|(k, _)| k.chars().count())
        .max()
        .unwrap_or(0);
    for (k, v) in &scalars {
        out.line(format!("    {:<w$} : {}", k, v, w = w));
    }
    for warning in &warnings {
        out.line(format!("    ! {}", warning));
    }
    out.line("");
}

pub(crate) fn parse_ts(ts: &str) -> Option<i64> {
    // RFC 3339 "YYYY-MM-DDTHH:MM:SS(.sss)Z" -> seconds since epoch (UTC only).
    let b = ts.as_bytes();
    if b.len() < 19 {
        return None;
    }
    let n = |r: std::ops::Range<usize>| ts.get(r)?.parse::<i64>().ok();
    let (y, mo, d, h, mi, s) = (
        n(0..4)?,
        n(5..7)?,
        n(8..10)?,
        n(11..13)?,
        n(14..16)?,
        n(17..19)?,
    );
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + h * 3600 + mi * 60 + s)
}

fn elapsed_secs(start: &str, end: Option<&str>) -> Option<i64> {
    let s = parse_ts(start)?;
    let e = parse_ts(end?)?;
    Some((e - s).max(0))
}

pub(crate) fn fmt_duration(s: i64) -> String {
    if s < 60 {
        format!("{}s", s)
    } else if s < 3600 {
        format!("{}m{:02}s", s / 60, s % 60)
    } else {
        format!("{}h{:02}m", s / 3600, (s % 3600) / 60)
    }
}

const EVENT_HEADERS: [&str; 4] = ["seq", "attempt", "type", "detail"];

/// One `grad runs events` row: seq, attempt, type and a one-line summary.
fn event_row(ev: &RunEvent) -> Vec<String> {
    let detail = match ev {
        RunEvent::Phase(p) => match p.phase {
            RunPhase::Queued | RunPhase::WaitingForCompute => {
                format!(
                    "{}: {}",
                    p.phase.as_str(),
                    waiting_line(p, None).trim_start()
                )
            }
            _ => match &p.gpu {
                Some(g) => format!("{} on {} ({:.0} GB)", p.phase.as_str(), g.name, g.memory_gb),
                None => format!("{} at step {}", p.phase.as_str(), p.step),
            },
        },
        RunEvent::Metric(m) => format!(
            "step {} loss {}{}",
            m.step,
            num(m.metric.loss),
            m.metric
                .eval_loss
                .map(|x| format!(" eval {}", num(x)))
                .unwrap_or_default()
        ),
        RunEvent::Checkpoint(k) => format!(
            "step {} {}{}",
            k.step,
            k.checkpoint_id,
            k.eval_score
                .map(|x| format!(" score {}", num(x)))
                .unwrap_or_default()
        ),
        RunEvent::Attempt(a) => a.message.clone(),
        RunEvent::Warning(w) => w.message.clone(),
        RunEvent::Log(l) => l.message.clone(),
        RunEvent::Completed(d) => d.status.as_str().to_string(),
        RunEvent::Unknown => String::new(),
    };
    let meta = ev.meta().cloned().unwrap_or_default();
    vec![
        meta.seq.to_string(),
        meta.attempt.to_string(),
        ev.type_name().to_string(),
        detail,
    ]
}

fn run_rows(runs: &[Run]) -> Vec<Vec<String>> {
    runs.iter()
        .map(|r| {
            vec![
                r.id.clone(),
                r.name.clone(),
                r.recipe_kind.to_string(),
                r.status.to_string(),
                format!("{}/{}", r.current_step, r.total_steps),
                usd(r.cost_usd),
                when(&r.created_at),
            ]
        })
        .collect()
}

fn print_run(out: &Out, r: &Run) {
    out.kv(&[
        ("id", r.id.clone()),
        ("name", r.name.clone()),
        ("status", r.status.to_string()),
        ("recipe", r.recipe_kind.to_string()),
        ("model", r.resolved_config.model.clone()),
        (
            "dataset",
            format!("{} v{}", r.dataset_name, r.dataset_version),
        ),
        (
            "progress",
            format!(
                "step {}/{} (attempt {}/{})",
                r.current_step, r.total_steps, r.attempt, r.max_attempts
            ),
        ),
        ("tokens", thousands(r.tokens_processed)),
        (
            "cost",
            format!(
                "{}{}",
                usd(r.cost_usd),
                r.max_cost_usd
                    .map(|c| format!(" of {} cap", usd(c)))
                    .unwrap_or_default()
            ),
        ),
        ("artifact", opt(&r.artifact_id)),
        ("error", opt(&r.error)),
        ("created", when(&r.created_at)),
        (
            "finished",
            r.finished_at
                .as_deref()
                .map(when)
                .unwrap_or_else(|| "-".into()),
        ),
    ]);
    if let Some(rep) = &r.eval_report {
        print_report(out, rep);
    }
}

fn metric_rows(points: &[MetricPoint]) -> Vec<Vec<String>> {
    points
        .iter()
        .map(|m| {
            vec![
                m.step.to_string(),
                num(m.loss),
                m.eval_loss.map(num).unwrap_or_else(|| "-".into()),
                eval_metrics_cell(m),
                m.lr.map(num).unwrap_or_else(|| "-".into()),
                compact(m.tokens),
                usd(m.cost_usd),
            ]
        })
        .collect()
}

/// `name=value` pairs of an eval step's metrics, or `-` between evals.
fn eval_metrics_cell(m: &MetricPoint) -> String {
    let cell = m
        .eval_metrics
        .iter()
        .flatten()
        .filter_map(|(k, v)| v.map(|v| format!("{}={}", k, num(v))))
        .collect::<Vec<_>>()
        .join(",");
    if cell.is_empty() {
        "-".into()
    } else {
        cell
    }
}

const METRIC_HEADERS: [&str; 7] = [
    "step",
    "loss",
    "eval_loss",
    "eval_metrics",
    "lr",
    "tokens",
    "cost",
];

pub async fn runs(ctx: &Ctx, action: RunsCmd) -> CliResult {
    let c = ctx.client()?;
    let out = &ctx.out;
    match action {
        RunsCmd::List { page: p } => {
            let res = c.runs().list(&page(&p)).await?;
            out.table(
                &["id", "name", "recipe", "status", "step", "cost", "created"],
                run_rows(&res.data),
            );
            more_hint(
                out,
                "/v1/runs",
                &p,
                res.data.len(),
                res.next_cursor.as_deref(),
            )?;
            out.done(&res)
        }
        RunsCmd::Inspect { run, yaml } => {
            let r = resolve_run(&c, out, &run).await?;
            if yaml {
                let text = trainfile::export(&r)?;
                if out.json {
                    return out.done(&json!({ "yaml": text, "run_id": r.id }));
                }
                print!("{}", text);
                return Ok(());
            }
            print_run(out, &r);
            out.done(&r)
        }
        RunsCmd::Logs {
            run,
            follow,
            after_step,
        } => {
            let r = resolve_run(&c, out, &run).await?;
            if !follow {
                let pg = c
                    .runs()
                    .metrics(
                        &r.id,
                        &MetricsQuery {
                            after_step,
                            ..Default::default()
                        },
                    )
                    .await?;
                out.table(&METRIC_HEADERS, metric_rows(&pg.data));
                out.note(format!("run {} is {}", r.id, pg.status));
                return out.done(&pg);
            }
            on_interrupt(format!("stopped following run {}", r.id));
            let mut stream = c.runs().stream_metrics(&r.id, None);
            let mut collected = Vec::new();
            if !out.json {
                out.line(METRIC_HEADERS.map(|h| h.to_uppercase()).join("  "));
            }
            while let Some(ev) = stream.next().await {
                match ev? {
                    MetricEvent::Metric(m) => {
                        if after_step.is_some_and(|a| m.step <= a) {
                            continue;
                        }
                        if !out.json {
                            out.line(metric_rows(std::slice::from_ref(&m))[0].join("  "));
                        }
                        collected.push(*m);
                    }
                    MetricEvent::Finished(run) => {
                        out.note(format!("run {} {}", run.id, run.status));
                        return out.done(&json!({ "run": run, "metrics": collected }));
                    }
                }
            }
            out.done(&json!({ "metrics": collected }))
        }
        RunsCmd::Events { run, follow, limit } => {
            // An id needs no lookup; a name resolves to the newest run with it.
            let id = if run.starts_with("run_") {
                run
            } else {
                resolve_run(&c, out, &run).await?.id
            };
            if follow {
                on_interrupt(format!("stopped following run {}", id));
            }
            let mut stream = c.runs().events(&id, follow);
            if let Some(n) = in_range(limit.map(|n| n as f64), "--limit", 1.0, 5000.0)? {
                stream = stream.limit(n as i64);
            }
            let mut collected = Vec::new();
            if !out.json {
                out.line(EVENT_HEADERS.map(|h| h.to_uppercase()).join("  "));
            }
            while let Some(ev) = stream.next().await {
                let ev = ev?;
                if !out.json {
                    out.line(event_row(&ev).join("  "));
                }
                collected.push(ev);
            }
            out.done(&json!({ "run_id": id, "events": collected }))
        }
        RunsCmd::Wait { run, timeout } | RunsCmd::Watch { run, timeout } => {
            let r = resolve_run(&c, out, &run).await?;
            if r.status.is_terminal() {
                if r.status != RunStatus::Completed {
                    return Err(SdkError::RunFailed(Box::new(r)).into());
                }
                let art = report_finished(ctx, &c, &r).await;
                return out.done(&json!({ "run": r, "artifact": art }));
            }
            let finished = follow_run(ctx, &c, &r, Duration::from_secs(timeout)).await?;
            let art = report_finished(ctx, &c, &finished).await;
            out.done(&json!({ "run": finished, "artifact": art }))
        }
        RunsCmd::Cancel { run, latest } => {
            let r = resolve_run_to_change(&c, &run, latest, "cancel", |r| !r.status.is_terminal())
                .await?;
            let r = c.runs().cancel(&r.id).await?;
            out.line(format!("✓ Run {} is {}", r.id, r.status));
            out.done(&r)
        }
        RunsCmd::Resume {
            run,
            latest,
            max_cost_usd,
            wait,
        } => {
            let cap = positive(max_cost_usd, "--max-cost-usd")?;
            let r = resolve_run_to_change(&c, &run, latest, "resume", |r| {
                r.status.is_terminal() && r.status != RunStatus::Completed
            })
            .await?;
            let r = c.runs().resume(&r.id, cap).await?;
            // The next claim starts a new attempt; `attempt` is still the last one.
            out.line(format!(
                "✓ Resumed run {} ({}; next attempt {})",
                r.id,
                r.status,
                r.attempt + 1
            ));
            if !wait {
                return out.done(&r);
            }
            let finished = follow_run(ctx, &c, &r, Duration::from_secs(86_400)).await?;
            let art = report_finished(ctx, &c, &finished).await;
            out.done(&json!({ "run": finished, "artifact": art }))
        }
        RunsCmd::Checkpoints { run } => {
            let r = resolve_run(&c, out, &run).await?;
            let res = c.runs().checkpoints(&r.id, &Default::default()).await?;
            out.table(
                &[
                    "id",
                    "step",
                    "eval_score",
                    "best",
                    "final",
                    "format",
                    "expires",
                ],
                res.data
                    .iter()
                    .map(|k| {
                        vec![
                            k.id.clone(),
                            k.step.to_string(),
                            k.eval_score.map(num).unwrap_or_else(|| "-".into()),
                            if k.best { "yes".into() } else { "".into() },
                            if k.r#final { "yes".into() } else { "".into() },
                            opt(&k.format),
                            k.expires_at
                                .as_deref()
                                .map(when)
                                .unwrap_or_else(|| "never".into()),
                        ]
                    })
                    .collect(),
            );
            out.done(&res)
        }
        RunsCmd::Promote { checkpoint, name } => {
            let a = c
                .checkpoints()
                .promote(&checkpoint, name.as_deref())
                .await?;
            out.line(format!(
                "✓ Promoted {} to artifact {}",
                checkpoint,
                a.reference()
            ));
            out.line(format!("  Next: grad deploy {}", a.reference()));
            out.done(&a)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eval_metrics_cell_lists_set_metrics() {
        let mut m = MetricPoint::default();
        assert_eq!(eval_metrics_cell(&m), "-");
        m.eval_metrics = Some(
            [
                ("eval_loss".to_string(), Some(0.5)),
                ("x".to_string(), None),
            ]
            .into_iter()
            .collect(),
        );
        assert_eq!(eval_metrics_cell(&m), format!("eval_loss={}", num(0.5)));
    }

    #[test]
    fn waiting_and_event_lines() {
        let mut p = PhaseEvent {
            phase: RunPhase::WaitingForCompute,
            workers_online: Some(0),
            autoscaling: Some(false),
            ..Default::default()
        };
        assert_eq!(
            waiting_line(&p, Some(130)),
            "  Waiting for a GPU (0 workers online) — 2m 10s"
        );
        p.workers_online = Some(1);
        assert_eq!(
            waiting_line(&p, None),
            "  Waiting for a GPU (1 worker online, all busy)"
        );
        p.workers_online = Some(0);
        p.autoscaling = Some(true);
        assert_eq!(
            waiting_line(&p, Some(5)),
            "  Starting a GPU worker (autoscaling)… — 5s"
        );
        assert_eq!(fmt_wait(3 * 3600 + 120), "3h 02m");
        let attempt = |kind: AttemptKind, attempt: i64| {
            RunEvent::Attempt(grad_sdk::AttemptEvent {
                meta: grad_sdk::EventMeta {
                    attempt,
                    ..Default::default()
                },
                event: kind,
                message: "m".into(),
                ..Default::default()
            })
        };
        assert_eq!(
            event_line(&attempt(AttemptKind::Interrupted, 1)).unwrap(),
            "⚠ m"
        );
        assert_eq!(event_line(&attempt(AttemptKind::GaveUp, 3)).unwrap(), "⚠ m");
        assert_eq!(
            event_line(&attempt(AttemptKind::Started, 2)).unwrap(),
            "  ▸ m"
        );
        assert!(event_line(&attempt(AttemptKind::Started, 1)).is_none());
        for (phase, line) in [
            (RunPhase::Starting, "  ▸ Starting"),
            (RunPhase::LoadingModel, "  ▸ Loading the model"),
            (RunPhase::Uploading, "  ▸ Uploading the artifact"),
            (RunPhase::Completing, "  ▸ Completing"),
        ] {
            let ev = RunEvent::Phase(PhaseEvent {
                phase,
                ..Default::default()
            });
            assert_eq!(event_line(&ev).unwrap(), line);
        }
        let quiet = RunEvent::Phase(PhaseEvent {
            phase: RunPhase::Evaluating,
            ..Default::default()
        });
        assert!(event_line(&quiet).is_none());
        let mut live = Live {
            tty: true,
            json: false,
            last_print: None,
            total: 2,
            open_line: false,
            waiting: None,
            last_phase: None,
        };
        live.event(&RunEvent::Phase(p.clone()));
        assert!(live.waiting.is_some() && live.open_line);
        live.tick();
        live.event(&RunEvent::Phase(PhaseEvent {
            phase: RunPhase::Training,
            ..Default::default()
        }));
        assert!(live.waiting.is_none());
        live.event(&RunEvent::Phase(PhaseEvent {
            phase: RunPhase::Training,
            ..Default::default()
        }));
        live.event(&RunEvent::Log(grad_sdk::MessageEvent {
            message: "x".into(),
            ..Default::default()
        }));
        live.end();
    }

    #[test]
    fn timestamps_and_durations() {
        assert_eq!(parse_ts("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(
            parse_ts("2026-11-27T00:00:42.123Z").unwrap()
                - parse_ts("2026-11-27T00:00:00Z").unwrap(),
            42
        );
        assert_eq!(parse_ts("2000-03-01T00:00:00Z"), Some(951_868_800));
        assert_eq!(parse_ts("bad"), None);
        assert_eq!(
            elapsed_secs("2026-11-27T00:00:00Z", Some("2026-11-27T00:01:05Z")),
            Some(65)
        );
        assert_eq!(elapsed_secs("2026-11-27T00:00:00Z", None), None);
        assert_eq!(fmt_duration(42), "42s");
        assert_eq!(fmt_duration(65), "1m05s");
        assert_eq!(fmt_duration(3720), "1h02m");
    }

    #[test]
    fn flags_override_the_run_file() {
        let a = TrainArgs {
            dataset: Some("d".into()),
            name: Some("n".into()),
            recipe: Some("router".into()),
            models: Some(vec!["a".into(), " b ".into()]),
            lr: Some("0.001".into()),
            adapter_rank: Some(16),
            thinking: Some("off".into()),
            split: Some("random".into()),
            eval_fraction: Some(0.2),
            set: vec!["warmup=0.1".into()],
            max_cost_usd: Some(3.0),
            ..Default::default()
        };
        let req = build_request(&a).unwrap();
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(v["recipe"]["models"], json!(["a", "b"]));
        assert_eq!(v["recipe"]["lr"], json!(0.001));
        assert_eq!(v["recipe"]["adapter"], json!({"kind": "lora", "rank": 16}));
        assert_eq!(
            v["recipe"]["thinking"],
            json!("off"),
            "the server takes auto/on/off"
        );
        assert_eq!(v["recipe"]["warmup"], json!(0.1));
        assert_eq!(
            v["split"],
            json!({"strategy": "random", "eval_fraction": 0.2})
        );
        assert_eq!(v["max_cost_usd"], json!(3.0));
        // --rubric takes a score name, or a rubric file (as grad eval does).
        let named = TrainArgs {
            rubric: Some("resolved".into()),
            ..TrainArgs {
                dataset: a.dataset.clone(),
                name: a.name.clone(),
                recipe: a.recipe.clone(),
                ..Default::default()
            }
        };
        assert_eq!(
            serde_json::to_value(build_request(&named).unwrap()).unwrap()["recipe"]["rubric"],
            json!("resolved")
        );
        let file =
            std::env::temp_dir().join(format!("grad-train-rubric-{}.yaml", std::process::id()));
        std::fs::write(
            &file,
            "- name: ok\n  kind: validator\n  validator: non_empty\n",
        )
        .unwrap();
        let filed = TrainArgs {
            rubric: Some(file.display().to_string()),
            ..TrainArgs {
                dataset: a.dataset.clone(),
                name: a.name.clone(),
                recipe: a.recipe.clone(),
                ..Default::default()
            }
        };
        let v = serde_json::to_value(build_request(&filed).unwrap()).unwrap();
        let _ = std::fs::remove_file(&file);
        assert_eq!(
            v["recipe"]["rubric"][0]["validator"],
            json!("non_empty"),
            "{}",
            v
        );
        let bad = TrainArgs {
            lr: Some("fast".into()),
            ..a
        };
        assert!(build_request(&bad).is_err());
        let neg = TrainArgs {
            dataset: Some("d".into()),
            name: Some("n".into()),
            recipe: Some("sft".into()),
            max_cost_usd: Some(-1.0),
            ..Default::default()
        };
        assert!(build_request(&neg)
            .unwrap_err()
            .message
            .contains("--max-cost-usd"));
    }
}
