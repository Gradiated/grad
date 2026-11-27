//! `grad artifacts`, `grad deploy`, `grad deployments`, `grad rollback`, `grad route`, `grad embed`.

use grad_sdk::{Artifact, ChatMessage, DeployRequest, DownloadOptions, RouteRequest};
use serde_json::json;

use super::{in_range, page, Ctx};
use crate::cli::{ArtifactsCmd, DeployArgs, DeploymentsCmd, RouteArgs};
use crate::output::{num, opt, thousands, when, CliError, CliResult, Out};

fn print_artifact(out: &Out, a: &Artifact) {
    out.kv(&[
        ("artifact", a.reference()),
        ("id", a.id.clone()),
        ("format", opt(&a.format)),
        ("base model", a.base_model.clone()),
        ("recipe", a.recipe_kind.to_string()),
        ("run", opt(&a.run_id)),
        ("size", format!("{} bytes", thousands(a.size_bytes))),
        ("sha256", a.sha256.clone()),
        ("created", when(&a.created_at)),
    ]);
}

pub async fn artifacts(ctx: &Ctx, action: ArtifactsCmd) -> CliResult {
    let c = ctx.client()?;
    let out = &ctx.out;
    match action {
        ArtifactsCmd::List { name, page: p } => {
            let res = c.artifacts().list(name.as_deref(), &page(&p)).await?;
            out.table(
                &["artifact", "id", "format", "base model", "size", "created"],
                res.data
                    .iter()
                    .map(|a| {
                        vec![
                            a.reference(),
                            a.id.clone(),
                            opt(&a.format),
                            a.base_model.clone(),
                            thousands(a.size_bytes),
                            when(&a.created_at),
                        ]
                    })
                    .collect(),
            );
            out.done(&res)
        }
        ArtifactsCmd::Inspect { reference } => {
            let a = c.artifacts().get(&reference).await?;
            print_artifact(out, &a);
            out.done(&a)
        }
        ArtifactsCmd::Download {
            reference,
            output,
            archive,
            force,
        } => {
            if output.is_none() && archive.is_none() {
                return Err(CliError::usage(
                    "pass --output DIR (extracted PEFT directory) and/or --archive FILE",
                ));
            }
            let opts = DownloadOptions {
                extract_to: output.clone(),
                archive_to: archive.clone(),
                overwrite: force,
                limits: Default::default(),
            };
            out.note(format!("Downloading {}", reference));
            let res = c.artifacts().download(&reference, &opts).await?;
            if let Some(dir) = &res.directory {
                out.line(format!(
                    "✓ Verified {} ({} bytes, sha256 {}) and extracted {} files to {}",
                    reference,
                    thousands(res.size_bytes),
                    &res.sha256[..12],
                    res.files.len(),
                    dir.display()
                ));
                let fmt = res
                    .manifest
                    .get("format")
                    .and_then(|v| v.as_str())
                    .unwrap_or("");
                let peft = fmt == "peft_lora"
                    || (fmt.is_empty() && res.files.contains_key("adapter_config.json"));
                if peft {
                    let base = res
                        .manifest
                        .get("base_model_ref")
                        .or_else(|| res.manifest.get("base_model"))
                        .and_then(|v| v.as_str())
                        .unwrap_or("<base-model>");
                    let name = reference.split('@').next().unwrap_or("adapter");
                    out.line(format!(
                        "  Serve it: vllm serve {} --enable-lora --lora-modules {}={}",
                        base,
                        name,
                        dir.display()
                    ));
                }
            }
            if let Some(a) = &res.archive {
                out.line(format!(
                    "✓ Saved verified bundle to {} ({} bytes)",
                    a.display(),
                    thousands(res.size_bytes)
                ));
            }
            out.done(&res)
        }
    }
}

pub async fn deploy(ctx: &Ctx, a: DeployArgs) -> CliResult {
    let c = ctx.client()?;
    let rate = in_range(a.explore_rate, "--explore-rate", 0.0, 0.5)?;
    let d = c
        .deployments()
        .create(&DeployRequest {
            artifact: a.artifact.clone(),
            name: a.name,
            fallback: a.fallback,
            explore_rate: rate,
        })
        .await?;
    let out = &ctx.out;
    out.line(format!(
        "✓ Deployed {} as {} ({})",
        a.artifact, d.model_id, d.status
    ));
    if let Some(prev) = &d.previous_artifact_id {
        out.line(format!(
            "  Previous artifact {}; roll back with: grad rollback {}",
            prev, d.name
        ));
    }
    out.line(format!(
        "  Call it with model=\"{}\" through the OpenAI-compatible gateway.",
        d.model_id
    ));
    out.done(&d)
}

pub async fn rollback(ctx: &Ctx, name: &str) -> CliResult {
    let c = ctx.client()?;
    let d = c.deployments().rollback(name).await?;
    ctx.out.line(format!(
        "✓ Rolled {} back to artifact {}",
        d.name, d.active_artifact_id
    ));
    ctx.out.done(&d)
}

pub async fn deployments(ctx: &Ctx, action: DeploymentsCmd) -> CliResult {
    let c = ctx.client()?;
    let out = &ctx.out;
    match action {
        DeploymentsCmd::List { page: p } => {
            let res = c.deployments().list(&page(&p)).await?;
            out.table(
                &["name", "model", "active artifact", "status", "updated"],
                res.data
                    .iter()
                    .map(|d| {
                        vec![
                            d.name.clone(),
                            d.model_id.clone(),
                            d.active_artifact_id.clone(),
                            d.status.clone(),
                            when(&d.updated_at),
                        ]
                    })
                    .collect(),
            );
            out.done(&res)
        }
        DeploymentsCmd::Status { name } => {
            let s = c.deployments().get(&name).await?;
            let d = &s.deployment;
            out.kv(&[
                ("Model", d.model_id.clone()),
                ("Active", d.active_artifact_id.clone()),
                ("Previous", opt(&d.previous_artifact_id)),
                ("Status", d.status.clone()),
                ("Fallback", opt(&d.fallback_model)),
                ("Explore", num(d.explore_rate)),
            ]);
            out.line("");
            out.line("  Feedback");
            out.line(format!(
                "    Events        : {}",
                thousands(s.feedback_count)
            ));
            out.line(format!(
                "    Average score : {}",
                s.average_score
                    .map(|x| format!("{:.1}%", x * 100.0))
                    .unwrap_or_else(|| "-".into())
            ));
            out.done(&s)
        }
        DeploymentsCmd::Rollback { name } => rollback(ctx, &name).await,
    }
}

pub async fn route(ctx: &Ctx, a: RouteArgs) -> CliResult {
    let c = ctx.client()?;
    let messages: Vec<ChatMessage> = match (&a.prompt, &a.messages) {
        (Some(p), _) => vec![ChatMessage::user(p.clone())],
        (None, Some(path)) => {
            let raw = std::fs::read_to_string(path)
                .map_err(|e| CliError::usage(format!("--messages {}: {}", path.display(), e)))?;
            serde_json::from_str(&raw).map_err(|e| {
                CliError::usage(format!(
                    "--messages {}: expected a JSON list of {{role, content}}: {}",
                    path.display(),
                    e
                ))
            })?
        }
        (None, None) => return Err(CliError::usage("pass --prompt or --messages")),
    };
    let d = c
        .route(&RouteRequest {
            deployment: a.deployment,
            messages,
            tools: None,
            session_id: a.session_id,
        })
        .await?;
    ctx.out.line(format!(
        "{}  (confidence {}, {}inference {})",
        d.model,
        num(d.confidence),
        if d.is_exploration {
            "exploration, "
        } else {
            ""
        },
        d.inference_id
    ));
    ctx.out.done(&d)
}

pub async fn embed(ctx: &Ctx, model: &str, input: Vec<String>) -> CliResult {
    let c = ctx.client()?;
    let res = c.embeddings(model, input).await?;
    for e in &res.data {
        let head: Vec<String> = e.embedding.iter().take(4).map(|x| num(*x)).collect();
        ctx.out.line(format!(
            "[{}] dim {}: [{}, ...]",
            e.index,
            e.embedding.len(),
            head.join(", ")
        ));
    }
    ctx.out.done(&json!(res))
}
