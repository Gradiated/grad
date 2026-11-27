//! `grad eval` and its subcommands.

use grad_sdk::{
    EvalRubricItem, EvalRubricItemKind, EvalRun, EvalStatus, PlanEvalRequest, PlanEvalResponse,
    WaitOptions,
};
use serde_json::Value;
use std::path::Path;
use std::time::Duration;

use super::{in_range, on_interrupt, page, Ctx};
use crate::cli::{EvalCmd, EvalRunArgs, EvalTop};
use crate::output::{num, opt, pct, thousands, usd, when, CliError, CliResult, Out};

/// Load a YAML/JSON rubric: a list of items, or `{items: [...]}` / `{rubric: [...]}`.
pub fn load_rubric(path: &Path) -> CliResult<Vec<EvalRubricItem>> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| CliError::usage(format!("--rubric {}: {}", path.display(), e)))?;
    let v: serde_norway::Value = serde_norway::from_str(&raw).map_err(|e| {
        CliError::usage(format!(
            "--rubric {}: invalid YAML/JSON: {}",
            path.display(),
            e
        ))
    })?;
    let v: Value = serde_json::to_value(v).map_err(|e| CliError::usage(e.to_string()))?;
    let items = match v {
        Value::Array(a) => Value::Array(a),
        Value::Object(mut m) => m
            .remove("items")
            .or_else(|| m.remove("rubric"))
            .ok_or_else(|| {
                CliError::usage(format!(
                    "--rubric {}: expected a list of rubric items",
                    path.display()
                ))
            })?,
        _ => {
            return Err(CliError::usage(format!(
                "--rubric {}: expected a list of rubric items",
                path.display()
            )))
        }
    };
    let items: Vec<EvalRubricItem> = serde_json::from_value(items)
        .map_err(|e| CliError::usage(format!("--rubric {}: {}", path.display(), e)))?;
    for it in &items {
        match &it.kind {
            EvalRubricItemKind::Regex | EvalRubricItemKind::Validator | EvalRubricItemKind::Judge => {}
            EvalRubricItemKind::Code => {
                return Err(CliError::usage(format!(
                    "--rubric {}: '{}' is a code scorer; code scorers run in your process, so use the Python SDK (client.evals.create(rubric=Rubric([...])))",
                    path.display(),
                    it.name
                )))
            }
            other => {
                return Err(CliError::usage(format!(
                    "--rubric {}: item '{}' has unknown kind '{}' (expected regex, validator or judge)",
                    path.display(),
                    it.name,
                    other
                )))
            }
        }
    }
    Ok(items)
}

pub fn build_request(a: &EvalRunArgs) -> CliResult<PlanEvalRequest> {
    let models: Vec<String> = a
        .models
        .iter()
        .map(|m| m.trim().to_string())
        .filter(|m| !m.is_empty())
        .collect();
    if models.is_empty() {
        return Err(CliError::usage("--models needs at least one model"));
    }
    let rubric = match &a.rubric {
        Some(p) => Some(load_rubric(p)?),
        None => None,
    };
    Ok(PlanEvalRequest {
        name: a.name.clone(),
        models,
        baseline: a.baseline.clone(),
        dataset: a
            .dataset
            .clone()
            .ok_or_else(|| CliError::usage("--dataset is required"))?,
        dataset_version: a.dataset_version,
        rubric,
        samples: a.samples,
        temperature: in_range(a.temperature, "--temperature", 0.0, 2.0)?,
        max_tokens: a.max_tokens,
        limit: a.limit,
        pass_threshold: in_range(a.pass_threshold, "--pass-threshold", 0.0, 1.0)?,
    })
}

fn print_plan(out: &Out, p: &PlanEvalResponse) {
    out.line(format!("Eval plan (dataset version {})", p.dataset_version));
    out.kv(&[
        ("tasks", thousands(p.estimated_tasks)),
        ("model calls", thousands(p.estimated_model_calls)),
        ("judge calls", thousands(p.estimated_judge_calls)),
        ("est. cost", usd(p.estimated_cost_usd)),
        ("pass threshold", num(p.pass_threshold)),
        (
            "judges",
            if p.judge_models.is_empty() {
                "-".into()
            } else {
                p.judge_models.join(", ")
            },
        ),
    ]);
    for w in &p.warnings {
        out.line(format!("  ! {}", w));
    }
}

fn print_summary(out: &Out, ev: &EvalRun) {
    out.line(format!(
        "Eval {} ({}): {}  · {} samples/task · threshold {} · cost {}",
        ev.name,
        ev.id,
        ev.status,
        ev.samples,
        num(ev.pass_threshold),
        usd(ev.total_cost_usd)
    ));
    if ev.summary.is_empty() {
        if ev.status == EvalStatus::AwaitingScores {
            out.line(format!(
                "  waiting for {} local scores from the SDK process that created this eval",
                ev.progress.pending_local_scores
            ));
        } else {
            out.line(format!(
                "  {} of {} outputs generated",
                ev.progress.generated, ev.progress.total_outputs
            ));
        }
        return;
    }
    out.table(
        &[
            "model",
            "overall",
            "95% ci",
            "vs baseline",
            "pass@k",
            "tasks",
            "errors",
            "$/1k tasks",
        ],
        ev.summary
            .iter()
            .map(|s| {
                let vs = s
                    .vs_baseline
                    .as_ref()
                    .map(|b| format!("{:+.1}%", b.delta * 100.0))
                    .unwrap_or_else(|| "-".into());
                let pass = s
                    .pass_at_k
                    .iter()
                    .map(|(k, v)| format!("{}={}", k, pct(*v)))
                    .collect::<Vec<_>>()
                    .join(" ");
                vec![
                    s.model.clone(),
                    pct(s.overall),
                    format!("[{}, {}]", pct(s.ci_low), pct(s.ci_high)),
                    vs,
                    if pass.is_empty() { "-".into() } else { pass },
                    s.tasks.to_string(),
                    s.errors.to_string(),
                    opt(&s.cost_per_1k_tasks_usd.map(usd)),
                ]
            })
            .collect(),
    );
}

pub(crate) async fn wait_eval(
    ctx: &Ctx,
    c: &grad_sdk::Client,
    id: &str,
    timeout: u64,
) -> CliResult<EvalRun> {
    on_interrupt(format!(
        "stopped waiting; eval {} keeps running (`grad eval status {}`)",
        id, id
    ));
    let json_mode = ctx.out.json;
    let mut last = String::new();
    let opts = WaitOptions::default().timeout(Duration::from_secs(timeout));
    let ev = c
        .evals()
        .wait(id, &opts, |e| {
            let line = format!(
                "  {}: {}/{} outputs, {} local scores pending",
                e.status,
                e.progress.generated,
                e.progress.total_outputs,
                e.progress.pending_local_scores
            );
            if !json_mode && line != last {
                eprintln!("{}", line);
                last = line;
            }
        })
        .await?;
    Ok(ev)
}

pub async fn eval(ctx: &Ctx, top: EvalTop) -> CliResult {
    let out = &ctx.out;
    match top.action {
        None => {
            let a = top.run;
            let req = build_request(&a)?;
            let c = ctx.client()?;
            if a.dry_run {
                let plan = c.evals().plan(&req).await?;
                print_plan(out, &plan);
                return out.done(&plan);
            }
            let ev = c.evals().create(&req, a.idempotency_key.as_deref()).await?;
            if !a.wait {
                out.line(format!(
                    "✓ Queued eval {} ({} models)",
                    ev.id,
                    ev.models.len()
                ));
                out.line(format!("  Check it with: grad eval status {}", ev.id));
                return out.done(&ev);
            }
            out.note(format!("Eval {} queued; waiting for results", ev.id));
            let ev = wait_eval(ctx, &c, &ev.id, a.timeout).await?;
            print_summary(out, &ev);
            out.done(&ev)
        }
        Some(cmd) => {
            let c = ctx.client()?;
            match cmd {
                EvalCmd::Plan(a) => {
                    let plan = c.evals().plan(&build_request(&a)?).await?;
                    print_plan(out, &plan);
                    out.done(&plan)
                }
                EvalCmd::Status { id } => {
                    let ev = c.evals().get(&id).await?;
                    print_summary(out, &ev);
                    out.done(&ev)
                }
                EvalCmd::List { page: p } => {
                    let res = c.evals().list(&page(&p)).await?;
                    out.table(
                        &["id", "name", "status", "models", "cost", "created"],
                        res.data
                            .iter()
                            .map(|e| {
                                vec![
                                    e.id.clone(),
                                    e.name.clone(),
                                    e.status.to_string(),
                                    e.models.join(","),
                                    usd(e.total_cost_usd),
                                    when(&e.created_at),
                                ]
                            })
                            .collect(),
                    );
                    out.done(&res)
                }
                EvalCmd::Wait { id, timeout } => {
                    let ev = wait_eval(ctx, &c, &id, timeout).await?;
                    print_summary(out, &ev);
                    out.done(&ev)
                }
                EvalCmd::Results { id, model, page: p } => {
                    let res = c.evals().results(&id, model.as_deref(), &page(&p)).await?;
                    out.table(
                        &["task", "model", "score", "passed"],
                        res.data
                            .iter()
                            .map(|r| {
                                vec![
                                    r.task_id.clone(),
                                    r.model.clone(),
                                    num(r.score),
                                    r.passed.to_string(),
                                ]
                            })
                            .collect(),
                    );
                    out.done(&res)
                }
                EvalCmd::Failures {
                    id,
                    model,
                    threshold,
                    page: p,
                } => {
                    let threshold = in_range(threshold, "--threshold", 0.0, 1.0)?;
                    let res = c
                        .evals()
                        .failures(&id, model.as_deref(), threshold, &page(&p))
                        .await?;
                    out.table(
                        &["task", "model", "score", "judge"],
                        res.data
                            .iter()
                            .map(|r| {
                                vec![
                                    r.task_id.clone(),
                                    r.model.clone(),
                                    num(r.score),
                                    opt(&r.judge_model),
                                ]
                            })
                            .collect(),
                    );
                    out.done(&res)
                }
                EvalCmd::Cancel { id } => {
                    let ev = c.evals().cancel(&id).await?;
                    out.line(format!("✓ Eval {} is {}", ev.id, ev.status));
                    out.done(&ev)
                }
            }
        }
    }
}
