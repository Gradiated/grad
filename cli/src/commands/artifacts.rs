//! `grad artifacts`: list, inspect, download, upload, import and delete.

use std::time::Duration;

use grad_sdk::{
    Artifact, ArtifactFilter, ArtifactHfOptions, ArtifactImport, ArtifactUploadOptions,
    DownloadOptions, WaitOptions,
};

use super::{page, Ctx};
use crate::cli::{ArtifactsCmd, ImportWaitArgs};
use crate::output::{bytes, thousands, when, CliError, CliResult, Out};

/// `run run_…`, `upload by key_…` or `import hf://owner/name@<commit>`.
fn provenance(a: &Artifact) -> String {
    let p = &a.provenance;
    let detail = match p.source.as_str() {
        "run" => p.run_id.clone(),
        "upload" => p.uploader.as_ref().map(|u| format!("by {}", u)),
        _ => p.uri.clone(),
    };
    match detail {
        Some(d) => format!("{} {}", p.source, d),
        None => p.source.to_string(),
    }
}

fn print_artifact(out: &Out, a: &Artifact) {
    let mut rows = vec![("artifact", a.reference())];
    if a.id != a.reference() {
        rows.push(("id", a.id.clone()));
    }
    rows.extend([
        ("format", a.format.to_string()),
        ("base model", a.base_model.clone()),
        ("recipe", a.recipe_kind.to_string()),
        ("source", provenance(a)),
        (
            "size",
            format!(
                "{} ({} bytes)",
                bytes(a.size_bytes),
                thousands(a.size_bytes)
            ),
        ),
        ("sha256", a.sha256.clone()),
        ("created", when(&a.created_at)),
    ]);
    out.kv(&rows);
}

pub async fn artifacts(ctx: &Ctx, action: ArtifactsCmd) -> CliResult {
    let c = ctx.client()?;
    let out = &ctx.out;
    match action {
        ArtifactsCmd::List {
            name,
            search,
            page: p,
        } => {
            let res = c
                .artifacts()
                .list(&ArtifactFilter { name, search }, &page(&p))
                .await?;
            out.table(
                &["artifact", "format", "base model", "size", "created"],
                res.data
                    .iter()
                    .map(|a| {
                        vec![
                            a.reference(),
                            a.format.to_string(),
                            a.base_model.clone(),
                            bytes(a.size_bytes),
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
            url: true,
            ..
        } => {
            let link = c.artifacts().download_url(&reference).await?;
            out.line(&link.url);
            out.note(format!(
                "Valid until {}; verify sha256 {}",
                link.expires_at, link.sha256
            ));
            out.done(&link)
        }
        ArtifactsCmd::Download {
            reference,
            output,
            archive,
            force,
            ..
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
                    "✓ Verified {} ({} bytes, sha256 {}) and extracted it to {} ({} file{} checked against its manifest)",
                    reference,
                    thousands(res.size_bytes as i64),
                    &res.sha256[..12],
                    dir.display(),
                    res.files.len(),
                    if res.files.len() == 1 { "" } else { "s" }
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
                    thousands(res.size_bytes as i64)
                ));
            }
            out.done(&res)
        }
        ArtifactsCmd::Upload { path, import } => {
            out.note(format!("Uploading {}", path.display()));
            let job = c
                .artifacts()
                .upload(
                    &path,
                    &ArtifactUploadOptions {
                        base: import.base.clone(),
                        format: Some(import.format.clone()),
                        name: import.name.clone(),
                        idempotency_key: import.idempotency_key.clone(),
                    },
                )
                .await?;
            finish_import(ctx, &c, job, &import.wait).await
        }
        ArtifactsCmd::Import {
            uri,
            import,
            secret,
        } => {
            let job = c
                .artifacts()
                .from_hf(
                    &uri,
                    &ArtifactHfOptions {
                        base: import.base.clone(),
                        format: Some(import.format.clone()),
                        name: import.name.clone(),
                        revision: None,
                        secret,
                        idempotency_key: import.idempotency_key.clone(),
                    },
                )
                .await?;
            finish_import(ctx, &c, job, &import.wait).await
        }
        ArtifactsCmd::ImportStatus { id } => {
            let j = c.artifacts().get_import(&id).await?;
            out.kv(&[
                ("id", j.id.clone()),
                ("name", j.name.clone()),
                ("status", j.status.to_string()),
                ("base model", j.base_model.clone()),
                ("format", j.format.to_string()),
                (
                    "artifact",
                    j.artifact_id.clone().unwrap_or_else(|| "-".into()),
                ),
                ("error", j.error.clone().unwrap_or_else(|| "-".into())),
            ]);
            out.done(&j)
        }
        ArtifactsCmd::Delete { reference } => {
            c.artifacts().delete(&reference).await?;
            out.line(format!("✓ Deleted artifact {}", reference));
            out.done(&serde_json::json!({ "deleted": reference }))
        }
    }
}

async fn finish_import(
    ctx: &Ctx,
    c: &grad_sdk::Client,
    job: ArtifactImport,
    wait: &ImportWaitArgs,
) -> CliResult {
    let out = &ctx.out;
    if wait.no_wait {
        out.line(format!(
            "✓ Queued artifact import {} ({})",
            job.id, job.name
        ));
        out.line(format!(
            "  Check it with: grad artifacts import-status {}",
            job.id
        ));
        return out.done(&job);
    }
    out.note(format!("Validating {} ({})", job.name, job.id));
    let opts = WaitOptions::default().timeout(Duration::from_secs(wait.timeout));
    let a = c.artifacts().wait_import(&job.id, &opts).await?;
    out.line(format!("✓ Registered artifact {}", a.reference()));
    print_artifact(out, &a);
    out.done(&a)
}
