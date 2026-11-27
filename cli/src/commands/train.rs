//! `grad train` and `grad runs`.

use grad_sdk::{
    Artifact, Client, Error as SdkError, EvalReport, MetricEvent, MetricPoint, MetricsQuery,
    PlanRunRequest, PlanRunResponse, Run, RunStatus, WaitOptions,
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
}

impl Live {
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
    };
    let opts = WaitOptions::default().timeout(timeout);
    let res = c
        .runs()
        .wait_with_metrics(&run.id, &opts, |m| live.metric(m))
        .await;
    live.end();
    res
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
                out.line(format!("  Next: grad deploy {}", a.reference()));
                out.line(format!(
                    "    or: grad artifacts download {} --output ./{}",
                    a.reference(),
                    a.name
                ));
            }
        }
        None => {
            if let Some(id) = &run.artifact_id {
                out.line(format!("✓ Exported artifact {}", id));
                out.line(format!("  Next: grad deploy {}", id));
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
            let r = resolve_run(&c, &run).await?;
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
            let r = resolve_run(&c, &run).await?;
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
        RunsCmd::Wait { run, timeout } | RunsCmd::Watch { run, timeout } => {
            let r = resolve_run(&c, &run).await?;
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
            let r = resolve_run(&c, &run).await?;
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
