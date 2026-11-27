//! `grad models`, `grad datasets`, `grad import`, `grad imports`, `grad render`.

use grad_sdk::{
    recipes, Client, FilterDatasetRequest, HfColumnMapping, ImportFileOptions, ImportJob,
    ImportSource, ImportSourceKind, PushOptions, RenderDatasetRequest, ScoreDatasetRequest,
    WaitOptions,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;

use super::eval::{load_rubric, wait_eval};
use super::{more_hint, on_interrupt, page, Ctx};
use crate::cli::{
    DatasetImportCmd, DatasetsCmd, ImportArgs, ImportWaitArgs, ImportsCmd, ModelsCmd, RenderArgs,
};
use crate::output::{join, thousands, usd, when, CliError, CliResult, Out};

/// `resolved>=0.8` -> ("resolved", ">=0.8"); the server validates the condition.
fn score_condition(spec: &str) -> CliResult<(String, Value)> {
    let at = spec
        .find(['>', '<', '=', '!'])
        .filter(|&i| i > 0)
        .ok_or_else(|| {
            CliError::usage(format!(
                "--score expects NAME<OP>VALUE such as resolved>=0.8, got '{}'",
                spec
            ))
        })?;
    Ok((
        spec[..at].trim().to_string(),
        Value::from(spec[at..].trim()),
    ))
}

/// `KEY=VALUE`; true/false and numbers match as such.
fn metadata_match(spec: &str) -> CliResult<(String, Value)> {
    let (k, v) = spec
        .split_once('=')
        .ok_or_else(|| CliError::usage(format!("--metadata expects KEY=VALUE, got '{}'", spec)))?;
    let value = serde_json::from_str::<Value>(v)
        .ok()
        .filter(|x| x.is_number() || x.is_boolean())
        .unwrap_or_else(|| Value::from(v));
    Ok((k.trim().to_string(), value))
}

pub async fn models(ctx: &Ctx, action: ModelsCmd) -> CliResult {
    let c = ctx.client()?;
    let ModelsCmd::List { recipe } = action;
    let mut models = c.models().list().await?;
    if let Some(r) = recipe {
        let kind = recipes::parse_kind(&r).ok_or_else(|| {
            CliError::usage(format!(
                "unknown recipe '{}'; expected one of {}",
                r,
                recipes::RECIPE_NAMES
            ))
        })?;
        models.retain(|m| m.recipes.contains(&kind));
    }
    ctx.out.table(
        &[
            "id",
            "family",
            "adapters",
            "recipes",
            "context",
            "$/1M tokens",
        ],
        models
            .iter()
            .map(|m| {
                vec![
                    m.id.clone(),
                    m.family.to_string(),
                    join(&m.adapters),
                    join(&m.recipes),
                    thousands(m.max_context_tokens),
                    format!("{:.2}", m.price_per_million_tokens_usd),
                ]
            })
            .collect(),
    );
    ctx.out.done(&models)
}

pub async fn render(ctx: &Ctx, a: RenderArgs) -> CliResult {
    let c = ctx.client()?;
    if !(1..=20).contains(&a.limit) {
        return Err(CliError::usage("--limit must be between 1 and 20"));
    }
    let res = c
        .datasets()
        .render(
            &a.name,
            &RenderDatasetRequest {
                model: a.model.clone(),
                train_on: a.train_on.as_deref().map(Into::into),
                thinking: a.thinking.as_deref().map(Into::into),
                preserve_thinking: None,
                limit: Some(a.limit),
            },
        )
        .await?;
    let out = &ctx.out;
    out.line(format!(
        "Dataset {} rendered with {} (template {}, token counts {})",
        res.dataset, res.model, res.template_revision, res.token_counts
    ));
    for ex in &res.examples {
        out.line("");
        out.line(format!(
            "── record {}: {} tokens, {} trained ({:.0}%)",
            ex.record_id,
            ex.total_tokens,
            ex.trained_tokens,
            ex.trained_fraction * 100.0
        ));
        for span in &ex.spans {
            let marker = if span.trained { "TRAIN" } else { "     " };
            for (i, line) in span.text.lines().enumerate() {
                out.line(format!(
                    "{} │ {}",
                    if i == 0 { marker } else { "     " },
                    line
                ));
            }
        }
    }
    out.done(&res)
}

fn print_dataset(out: &Out, d: &grad_sdk::Dataset) {
    out.kv(&[
        ("name", d.name.clone()),
        ("version", d.version.to_string()),
        ("records", thousands(d.record_count)),
        ("updated", when(&d.updated_at)),
    ]);
}

pub async fn datasets(ctx: &Ctx, action: DatasetsCmd) -> CliResult {
    let out = &ctx.out;
    match action {
        DatasetsCmd::List { page: p } => {
            let c = ctx.client()?;
            let res = c.datasets().list(&page(&p)).await?;
            out.table(
                &["name", "version", "records", "updated"],
                res.data
                    .iter()
                    .map(|d| {
                        vec![
                            d.name.clone(),
                            d.version.to_string(),
                            thousands(d.record_count),
                            when(&d.updated_at),
                        ]
                    })
                    .collect(),
            );
            more_hint(
                out,
                "/v1/datasets",
                &p,
                res.data.len(),
                res.next_cursor.as_deref(),
            )?;
            out.done(&res)
        }
        DatasetsCmd::Get { name } => {
            let c = ctx.client()?;
            let d = c.datasets().get(&name).await?;
            print_dataset(out, &d);
            out.done(&d)
        }
        DatasetsCmd::Create { name } => {
            let c = ctx.client()?;
            let d = c.datasets().create(&name, None).await?;
            out.line(format!("✓ Created dataset {}", d.name));
            out.done(&d)
        }
        DatasetsCmd::Push {
            name,
            file,
            batch_size,
        } => {
            let c = ctx.client()?;
            if batch_size == 0 || batch_size > 50_000 {
                return Err(CliError::usage("--batch-size must be between 1 and 50000"));
            }
            let opts = PushOptions {
                batch_records: batch_size,
                ..Default::default()
            };
            let json_mode = out.json;
            let d = c
                .datasets()
                .push_file(&name, &file, &opts, |p| {
                    if !json_mode {
                        eprintln!(
                            "  pushed {} records ({} batches)",
                            thousands(p.records_sent as i64),
                            p.batches_sent
                        );
                    }
                })
                .await?;
            out.line(format!(
                "✓ Dataset {}: {} records (version {})",
                d.name,
                thousands(d.record_count),
                d.version
            ));
            out.done(&d)
        }
        DatasetsCmd::Records {
            name,
            version,
            page: p,
        } => {
            let c = ctx.client()?;
            let res = c.datasets().records(&name, version, &page(&p)).await?;
            if !out.json {
                for r in &res.data {
                    out.line(serde_json::to_string(r).unwrap_or_default());
                }
                out.note(format!(
                    "{} of {} records (version {})",
                    res.data.len(),
                    thousands(res.total),
                    res.version
                ));
            }
            more_hint(
                out,
                &format!("/v1/datasets/{}/records", name),
                &p,
                res.data.len(),
                res.next_cursor.as_deref(),
            )?;
            out.done(&res)
        }
        DatasetsCmd::Score {
            name,
            rubric,
            version,
            job_name,
            limit,
            wait,
            timeout,
            idempotency_key,
        } => {
            let req = ScoreDatasetRequest {
                rubric: load_rubric(&rubric)?,
                version,
                name: job_name,
                limit,
            };
            let c = ctx.client()?;
            let job = c
                .datasets()
                .score(&name, &req, idempotency_key.as_deref())
                .await?;
            if !wait {
                out.line(format!(
                    "✓ Queued scoring job {} for dataset {}",
                    job.id, name
                ));
                out.line(format!("  Check it with: grad eval status {}", job.id));
                return out.done(&job);
            }
            let job = wait_eval(ctx, &c, &job.id, timeout).await?;
            let d = c.datasets().get(&name).await?;
            out.line(format!(
                "✓ Scored dataset {}: scores in version {} · cost {}",
                d.name,
                job.scored_dataset_version.unwrap_or(d.version),
                usd(job.total_cost_usd)
            ));
            out.done(&job)
        }
        DatasetsCmd::Filter {
            name,
            scores,
            metadata,
            created_after,
            created_before,
            ids,
            version,
            view,
        } => {
            let scores = scores
                .iter()
                .map(|s| score_condition(s))
                .collect::<CliResult<BTreeMap<_, _>>>()?;
            let metadata = metadata
                .iter()
                .map(|s| metadata_match(s))
                .collect::<CliResult<BTreeMap<_, _>>>()?;
            let req = FilterDatasetRequest {
                scores: (!scores.is_empty()).then_some(scores),
                metadata: (!metadata.is_empty()).then_some(metadata),
                created_after: created_after.map(Value::from),
                created_before: created_before.map(Value::from),
                ids: (!ids.is_empty()).then_some(ids),
                version,
                name: view,
            };
            let c = ctx.client()?;
            let d = c.datasets().filter(&name, &req).await?;
            out.line(format!(
                "✓ View {}: {} records",
                d.name,
                thousands(d.record_count)
            ));
            out.done(&d)
        }
        DatasetsCmd::Import { source } => match source {
            DatasetImportCmd::Hf {
                repo,
                name,
                split,
                config,
                revision,
                limit,
                columns,
                wait,
            } => {
                let c = ctx.client()?;
                let mut cols = HfColumnMapping::default();
                for spec in &columns {
                    let (k, v) = spec.split_once('=').ok_or_else(|| {
                        CliError::usage(format!("--column expects FIELD=COLUMN, got '{}'", spec))
                    })?;
                    cols.set(k.trim(), v.trim().to_string())
                        .map_err(CliError::usage)?;
                }
                let name = name.unwrap_or_else(|| {
                    repo.rsplit('/')
                        .next()
                        .unwrap_or(&repo)
                        .to_ascii_lowercase()
                });
                let job = c
                    .datasets()
                    .import_hf(
                        &name,
                        ImportSource {
                            kind: ImportSourceKind::Hf,
                            repo: Some(repo.clone()),
                            split,
                            config,
                            revision,
                            columns: if cols.is_empty() { None } else { Some(cols) },
                            limit,
                            ..Default::default()
                        },
                        None,
                    )
                    .await?;
                out.note(format!(
                    "Importing {} into dataset {} (job {})",
                    repo, name, job.id
                ));
                finish_import(ctx, &c, job, &wait).await
            }
            DatasetImportCmd::Benchmark {
                benchmark,
                limit,
                name,
                wait,
            } => {
                let c = ctx.client()?;
                let name = name.unwrap_or_else(|| match limit {
                    Some(n) => format!("{}-{}", benchmark, n),
                    None => benchmark.clone(),
                });
                let job = c
                    .datasets()
                    .import_benchmark(&name, &benchmark, limit)
                    .await?;
                out.note(format!(
                    "Importing benchmark {} into dataset {} (job {})",
                    benchmark, name, job.id
                ));
                finish_import(ctx, &c, job, &wait).await
            }
        },
    }
}

const FILE_FORMATS: [&str; 4] = ["auto", "jsonl", "json", "parquet"];

/// Split the documented `--format` (file format or parser) into the two API fields.
pub fn split_format(
    format: Option<String>,
    connector: Option<String>,
) -> CliResult<(Option<String>, Option<String>)> {
    match format {
        None => Ok((None, connector)),
        Some(f) => {
            let f = f.trim().to_ascii_lowercase().replace('-', "_");
            if FILE_FORMATS.contains(&f.as_str()) {
                Ok((Some(f), connector))
            } else if connector.is_some() {
                Err(CliError::usage(format!(
                    "--format {} is a parser name; drop --connector or pass a file format (auto, jsonl, json, parquet)",
                    f
                )))
            } else {
                Ok((None, Some(f)))
            }
        }
    }
}

pub async fn import(ctx: &Ctx, a: ImportArgs) -> CliResult {
    let c = ctx.client()?;
    let (format, connector) = split_format(a.format, a.connector)?;
    let size = std::fs::metadata(&a.file)
        .map_err(|e| CliError::usage(format!("{}: {}", a.file.display(), e)))?
        .len();
    ctx.out.note(format!(
        "Uploading {} ({} bytes) to dataset {}",
        a.file.display(),
        thousands(size as i64),
        a.dataset
    ));
    let job = c
        .datasets()
        .import_file(
            &a.dataset,
            &a.file,
            &ImportFileOptions { format, connector },
        )
        .await?;
    finish_import(ctx, &c, job, &a.wait).await
}

async fn finish_import(ctx: &Ctx, c: &Client, job: ImportJob, wait: &ImportWaitArgs) -> CliResult {
    let out = &ctx.out;
    if wait.no_wait {
        out.line(format!("✓ Queued import {} into {}", job.id, job.dataset));
        out.line(format!("  Check it with: grad imports status {}", job.id));
        return out.done(&job);
    }
    on_interrupt(format!(
        "stopped waiting; import {} keeps running (check it with `grad imports status {}`)",
        job.id, job.id
    ));
    let opts = WaitOptions::default().timeout(Duration::from_secs(wait.timeout));
    let done = c.imports().wait(&job.id, &opts).await?;
    print_import(out, &done);
    out.done(&done)
}

fn print_import(out: &Out, j: &ImportJob) {
    let scores = if j.detected_scores.is_empty() {
        String::new()
    } else {
        format!(", scores: {}", j.detected_scores.join(", "))
    };
    out.line(format!(
        "✓ Dataset {}: imported {} records, dropped {} (version {}, parser {}{})",
        j.dataset,
        thousands(j.imported_count),
        thousands(j.dropped_count),
        j.dataset_version
            .map(|v| v.to_string())
            .unwrap_or_else(|| "-".into()),
        j.connector,
        scores
    ));
    for r in j.drop_reasons.iter().take(10) {
        out.line(format!("  dropped: {}", r));
    }
    if j.drop_reasons.len() > 10 {
        out.line(format!(
            "  ... {} more drop reasons (see --json)",
            j.drop_reasons.len() - 10
        ));
    }
}

pub async fn imports(ctx: &Ctx, action: ImportsCmd) -> CliResult {
    let c = ctx.client()?;
    let out = &ctx.out;
    match action {
        ImportsCmd::List { page: p } => {
            let res = c.imports().list(&page(&p)).await?;
            out.table(
                &["id", "dataset", "status", "imported", "dropped", "created"],
                res.data
                    .iter()
                    .map(|j| {
                        vec![
                            j.id.clone(),
                            j.dataset.clone(),
                            j.status.to_string(),
                            thousands(j.imported_count),
                            thousands(j.dropped_count),
                            when(&j.created_at),
                        ]
                    })
                    .collect(),
            );
            out.done(&res)
        }
        ImportsCmd::Status { id } => {
            let j = c.imports().get(&id).await?;
            out.kv(&[
                ("id", j.id.clone()),
                ("dataset", j.dataset.clone()),
                ("status", j.status.to_string()),
                ("imported", thousands(j.imported_count)),
                ("dropped", thousands(j.dropped_count)),
                ("error", j.error.clone().unwrap_or_else(|| "-".into())),
            ]);
            out.done(&j)
        }
        ImportsCmd::Wait { id, timeout } => {
            let opts = WaitOptions::default().timeout(Duration::from_secs(timeout));
            let j = c.imports().wait(&id, &opts).await?;
            print_import(out, &j);
            out.done(&j)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn format_flag_maps_to_format_or_connector() {
        assert_eq!(split_format(None, None).unwrap(), (None, None));
        assert_eq!(
            split_format(Some("JSONL".into()), None).unwrap(),
            (Some("jsonl".into()), None)
        );
        assert_eq!(
            split_format(Some("otel".into()), None).unwrap(),
            (None, Some("otel".into()))
        );
        assert_eq!(
            split_format(Some("parquet".into()), Some("otel".into())).unwrap(),
            (Some("parquet".into()), Some("otel".into()))
        );
        assert!(split_format(Some("otel".into()), Some("langfuse".into())).is_err());
        assert_eq!(
            split_format(Some("openai-chat".into()), None).unwrap(),
            (None, Some("openai_chat".into()))
        );
    }
}
