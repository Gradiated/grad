//! `grad eval` and its subcommands.

use grad_sdk::{EvalPlan, EvalRequest, EvalRun, EvalStatus, RubricItem, WaitOptions};
use serde_json::{json, Value};
use std::path::Path;
use std::time::Duration;

use super::{in_range, on_interrupt, page, positive, Ctx};
use crate::cli::{EvalCmd, EvalRunArgs, EvalTop};
use crate::output::{num, opt, pct, thousands, usd, when, CliError, CliResult, Out};

/// Load a YAML/JSON rubric: a list of items, or `{items: [...]}` / `{rubric: [...]}`.
pub fn load_rubric(path: &Path) -> CliResult<Vec<RubricItem>> {
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
    let items: Vec<RubricItem> = serde_json::from_value(items)
        .map_err(|e| CliError::usage(format!("--rubric {}: {}", path.display(), e)))?;
    for it in &items {
        match it.kind.as_str() {
            "regex" | "validator" | "judge" => {}
            "code" => {
                return Err(CliError::usage(format!(
                    "--rubric {}: '{}' is a code scorer; code scorers run on your machine, so define the rubric in a .py file (rubric = Rubric([...])) and pass that instead",
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

pub fn build_request(a: &EvalRunArgs) -> CliResult<EvalRequest> {
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
    Ok(EvalRequest {
        name: a.name.clone(),
        models,
        baseline: a.baseline.clone(),
        dataset: a.dataset.clone(),
        dataset_version: a.dataset_version,
        rubric,
        samples: a.samples,
        temperature: in_range(a.temperature, "--temperature", 0.0, 2.0)?,
        max_tokens: a.max_tokens,
        limit: a.limit,
        pass_threshold: in_range(a.pass_threshold, "--pass-threshold", 0.0, 1.0)?,
        max_cost_usd: positive(a.max_cost_usd, "--max-cost-usd")?,
    })
}

fn print_plan(out: &Out, p: &EvalPlan) {
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
                let vs = match &s.vs_baseline {
                    Some(Value::Object(m)) => m
                        .get("delta")
                        .and_then(Value::as_f64)
                        .map(|d| format!("{:+.1}%", d * 100.0))
                        .unwrap_or_else(|| "-".into()),
                    Some(Value::Number(n)) => format!("{:+.1}%", n.as_f64().unwrap_or(0.0) * 100.0),
                    _ => "-".into(),
                };
                let pass = s
                    .pass_at_k
                    .iter()
                    .map(|(k, v)| {
                        format!(
                            "{}={}",
                            k,
                            v.as_f64().map(pct).unwrap_or_else(|| v.to_string())
                        )
                    })
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

async fn wait_eval(ctx: &Ctx, c: &grad_sdk::Client, id: &str, timeout: u64) -> CliResult<EvalRun> {
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

/// Run a Python rubric through the Python SDK (code scorers execute locally).
async fn eval_python(ctx: &Ctx, a: &EvalRunArgs) -> CliResult {
    let c = ctx.client()?;
    let rc = c.resolved_config();
    let script = r#"
import json, os, runpy, sys
try:
    from grad import Grad
except ImportError as exc:
    sys.stderr.write("grad eval --rubric FILE.py needs the Python SDK in %s (pip install grad-sdk, or pass --python): %s\n" % (sys.executable, exc))
    sys.exit(86)
args = json.loads(os.environ["GRAD_EVAL_ARGS"])
ns = runpy.run_path(args.pop("rubric_path"))
rubric = ns.get("rubric")
if rubric is None:
    sys.stderr.write("the rubric file must define a top-level `rubric = Rubric([...])`\n")
    sys.exit(2)
wait = args.pop("wait")
client = Grad(base_url=os.environ["GRADIATED_BASE_URL"], api_key=os.environ.get("GRADIATED_API_KEY") or None)
kwargs = {k: v for k, v in args.items() if v is not None}
ev = client.evals.create(rubric=rubric, **kwargs)
if wait:
    ev = ev.wait()
data = dict(ev) if isinstance(ev, dict) else getattr(ev, "__dict__", {"repr": repr(ev)})
print(json.dumps(data, default=str))
"#;
    let path = a.rubric.as_ref().expect("python rubric path");
    let args = json!({
        "rubric_path": path,
        "wait": a.wait,
        "name": a.name,
        "models": a.models,
        "dataset": a.dataset,
        "baseline": a.baseline,
        "samples": a.samples,
        "temperature": a.temperature,
        "max_tokens": a.max_tokens,
        "limit": a.limit,
        "pass_threshold": a.pass_threshold,
        "max_cost_usd": a.max_cost_usd,
    });
    let mut cmd = tokio::process::Command::new(&a.python);
    cmd.arg("-c")
        .arg(script)
        .env("GRAD_EVAL_ARGS", args.to_string())
        .env("GRADIATED_BASE_URL", &rc.base_url)
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true);
    match &rc.api_key {
        Some(k) => {
            cmd.env("GRADIATED_API_KEY", k);
        }
        None => {
            cmd.env_remove("GRADIATED_API_KEY");
        }
    }
    let output = cmd.output().await.map_err(|e| {
        CliError::usage(format!("could not run '{}': {}", a.python, e))
            .hint("Install Python 3 with `pip install grad-sdk`, or pass --python /path/to/python")
    })?;
    match output.status.code() {
        Some(0) => {}
        Some(86) => {
            return Err(
                CliError::usage("the Python SDK is not installed for this interpreter")
                    .hint("pip install grad-sdk"),
            )
        }
        code => {
            return Err(CliError::general(
                "python_eval_failed",
                format!(
                    "the Python rubric eval exited with {}",
                    code.map(|c| c.to_string())
                        .unwrap_or_else(|| "a signal".into())
                ),
            ))
        }
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let last = text
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .unwrap_or("{}");
    let data: Value = serde_json::from_str(last).unwrap_or(Value::Null);
    if let Ok(ev) = serde_json::from_value::<EvalRun>(data.clone()) {
        if !ev.id.is_empty() {
            print_summary(&ctx.out, &ev);
            if matches!(ev.status, EvalStatus::Failed | EvalStatus::Cancelled) {
                return Err(grad_sdk::Error::EvalFailed(Box::new(ev)).into());
            }
        }
    }
    ctx.out.done(&data)
}

pub async fn eval(ctx: &Ctx, top: EvalTop) -> CliResult {
    let out = &ctx.out;
    match top.action {
        None => {
            let a = top.run;
            if a.rubric
                .as_ref()
                .is_some_and(|p| p.extension().is_some_and(|e| e == "py"))
            {
                if a.dry_run {
                    return Err(CliError::usage(
                        "--dry-run with a Python rubric: plan it with the Python SDK (client.evals.plan) or use a YAML rubric",
                    ));
                }
                return eval_python(ctx, &a).await;
            }
            let req = build_request(&a)?;
            let c = ctx.client()?;
            if a.dry_run {
                let plan = c.evals().plan(&req).await?;
                print_plan(out, &plan);
                return out.done(&plan);
            }
            let ev = c.evals().create(&req).await?;
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
                    if a.rubric
                        .as_ref()
                        .is_some_and(|p| p.extension().is_some_and(|e| e == "py"))
                    {
                        return Err(CliError::usage(
                            "plan Python rubrics with the Python SDK (client.evals.plan)",
                        ));
                    }
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
