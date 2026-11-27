//! `grad secrets` and `grad sources`.

use grad_sdk::{Client, Source, SourceOptions, SourceProvider, SourceUpdate, WaitOptions};
use serde_json::{json, Value};
use std::io::{IsTerminal, Read};
use std::time::Duration;

use super::data::print_import;
use super::{more_hint, on_interrupt, page, Ctx};
use crate::cli::{SecretsCmd, SourceLimitArgs, SourcesCmd};
use crate::output::{when, CliError, CliResult};

/// Secret values are small (the server caps them at 16 KiB).
const MAX_SECRET_BYTES: u64 = 16 * 1024;

/// The value piped on stdin with one trailing newline removed, or a no-echo
/// prompt in a terminal. Never printed.
fn read_secret(name: &str) -> CliResult<String> {
    let stdin = std::io::stdin();
    let value = if stdin.is_terminal() {
        rpassword::prompt_password(format!("Value for secret {}: ", name)).map_err(|e| {
            CliError::general("io_error", format!("could not read the value: {}", e))
        })?
    } else {
        let mut raw = String::new();
        stdin
            .lock()
            .take(MAX_SECRET_BYTES + 2)
            .read_to_string(&mut raw)
            .map_err(|e| CliError::general("io_error", format!("could not read stdin: {}", e)))?;
        strip_one_newline(raw)
    };
    if value.is_empty() {
        return Err(CliError::usage(format!(
            "no value for secret '{}': pipe it on stdin, e.g. printf '%s' \"$VALUE\" | grad secrets set {}",
            name, name
        )));
    }
    if value.len() as u64 > MAX_SECRET_BYTES {
        return Err(CliError::usage(format!(
            "secret values are limited to {} bytes",
            MAX_SECRET_BYTES
        )));
    }
    Ok(value)
}

fn strip_one_newline(mut s: String) -> String {
    if s.ends_with('\n') {
        s.pop();
        if s.ends_with('\r') {
            s.pop();
        }
    }
    s
}

pub async fn secrets(ctx: &Ctx, action: SecretsCmd) -> CliResult {
    let out = &ctx.out;
    match action {
        SecretsCmd::Set {
            name,
            allowed_hosts,
        } => {
            let value = read_secret(&name)?;
            let c = ctx.client()?;
            let s = if allowed_hosts.is_empty() {
                c.secrets().set(&name, &value).await?
            } else {
                let hosts: Vec<&str> = allowed_hosts.iter().map(String::as_str).collect();
                c.secrets().set_with_hosts(&name, &value, &hosts).await?
            };
            out.line(format!("✓ Saved secret {}", s.name));
            out.line(format!(
                "  Use it with: grad sources add PROVIDER --secret {} ...",
                s.name
            ));
            out.done(&s)
        }
        SecretsCmd::List { page: p } => {
            let c = ctx.client()?;
            let res = c.secrets().list(&page(&p)).await?;
            out.table(
                &["name", "allowed hosts", "created", "updated"],
                res.data
                    .iter()
                    .map(|s| {
                        vec![
                            s.name.clone(),
                            s.allowed_hosts.join(","),
                            when(&s.created_at),
                            when(&s.updated_at),
                        ]
                    })
                    .collect(),
            );
            more_hint(
                out,
                "/v1/secrets",
                &p,
                res.data.len(),
                res.next_cursor.as_deref(),
            )?;
            out.done(&res)
        }
        SecretsCmd::Delete { name } => {
            let c = ctx.client()?;
            c.secrets().delete(name.as_str()).await?;
            out.line(format!("✓ Deleted secret {}", name));
            out.done(&json!({ "name": name, "deleted": true }))
        }
    }
}

/// `KEY=VALUE`: VALUE is parsed as JSON when it is valid JSON, else kept as a string.
fn parse_filter(spec: &str) -> CliResult<(String, Value)> {
    let (k, v) = spec
        .split_once('=')
        .ok_or_else(|| CliError::usage(format!("--filter expects KEY=VALUE, got '{}'", spec)))?;
    let key = k.trim();
    if key.is_empty() {
        return Err(CliError::usage(format!("--filter has no key: '{}'", spec)));
    }
    let value = serde_json::from_str(v.trim()).unwrap_or_else(|_| Value::String(v.to_string()));
    Ok((key.to_string(), value))
}

fn parse_filters(specs: &[String]) -> CliResult<serde_json::Map<String, Value>> {
    specs.iter().map(|f| parse_filter(f)).collect()
}

/// The effective filters, sampling and caps in one line: `environment=["production"] · 10% · ≤100000/day`.
fn limits(s: &Source) -> String {
    let mut parts: Vec<String> = s
        .filters()
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect();
    if s.sample_rate < 1.0 {
        parts.push(format!("{}% sampled", s.sample_rate * 100.0));
    }
    if let Some(n) = s.max_records_per_sync {
        parts.push(format!("≤{}/sync", n));
    }
    if let Some(n) = s.max_records_per_day {
        parts.push(format!("≤{}/day", n));
    }
    if parts.is_empty() {
        "-".into()
    } else {
        parts.join(" · ")
    }
}

/// `--max-records-per-*` on `update`: 0 removes the cap.
fn cap(n: Option<u64>) -> Option<Option<u64>> {
    n.map(|n| (n > 0).then_some(n))
}

fn describe(s: &Source) -> String {
    let mut parts = vec![s.provider.kind.clone()];
    if let Some(h) = &s.provider.host {
        parts.push(h.clone());
    }
    if let Some(p) = &s.provider.project {
        parts.push(format!("project {}", p));
    }
    parts.join(" ")
}

/// `active`, `active (2 failed)` or `paused`.
fn status(s: &Source) -> String {
    match (s.status.as_str(), s.consecutive_failures) {
        ("paused", _) => "paused".into(),
        (_, 0) => "active".into(),
        (_, n) => format!("active ({} failed)", n),
    }
}

fn last_error(s: &Source) -> String {
    match &s.last_error {
        None => "-".into(),
        Some(e) if e.chars().count() > 60 => {
            format!("{}…", e.chars().take(59).collect::<String>())
        }
        Some(e) => e.clone(),
    }
}

fn last_sync(s: &Source) -> String {
    match &s.last_sync {
        None => "never".into(),
        Some(l) => match l.dataset_version {
            Some(v) => format!("{} (v{})", l.status, v),
            None => l.status.to_string(),
        },
    }
}

pub async fn sources(ctx: &Ctx, action: SourcesCmd) -> CliResult {
    let out = &ctx.out;
    match action {
        SourcesCmd::Add {
            provider,
            dataset,
            host,
            secret,
            project,
            schedule,
            filters,
            limits:
                SourceLimitArgs {
                    sample_rate,
                    max_records_per_sync,
                    max_records_per_day,
                },
            idempotency_key,
        } => {
            let mut p = SourceProvider::new(provider.trim().to_ascii_lowercase());
            p.host = host;
            p.secret = secret;
            p.project = project;
            p.filters = parse_filters(&filters)?;
            let opts = SourceOptions {
                schedule,
                sample_rate,
                max_records_per_sync,
                max_records_per_day,
            };
            let c = ctx.client()?;
            let s = c
                .sources()
                .create_with(&dataset, &p, &opts, idempotency_key.as_deref())
                .await?;
            out.line(format!(
                "✓ Added source {} ({}) to dataset {}",
                s.id,
                describe(&s),
                s.dataset
            ));
            match &s.schedule {
                Some(cron) => out.line(format!(
                    "  Syncs on \"{}\" (UTC); next at {}",
                    cron,
                    s.next_sync_at
                        .as_deref()
                        .map(when)
                        .unwrap_or_else(|| "-".into())
                )),
                None => out.line(format!("  Sync it with: grad sources sync {}", s.id)),
            }
            if limits(&s) != "-" {
                out.line(format!("  Filters: {}", limits(&s)));
            }
            out.done(&s)
        }
        SourcesCmd::Show { id } => {
            let c = ctx.client()?;
            let s = c.sources().get(&id).await?;
            let rows = [
                ("source", s.id.clone()),
                ("dataset", s.dataset.clone()),
                ("provider", describe(&s)),
                (
                    "schedule",
                    s.schedule.clone().unwrap_or_else(|| "on request".into()),
                ),
                (
                    "next sync",
                    s.next_sync_at
                        .as_deref()
                        .map(when)
                        .unwrap_or_else(|| "-".into()),
                ),
                ("status", status(&s)),
                ("filters", limits(&s)),
                (
                    "today",
                    match s.max_records_per_day {
                        Some(n) => format!("{} of {} new traces", s.records_today, n),
                        None => format!("{} new traces", s.records_today),
                    },
                ),
                ("last sync", last_sync(&s)),
                (
                    "last error",
                    s.last_error.clone().unwrap_or_else(|| "-".into()),
                ),
            ];
            for (k, v) in rows {
                out.line(format!("{:<11}{}", k, v));
            }
            out.done(&s)
        }
        SourcesCmd::Update {
            id,
            filters,
            clear_filters,
            schedule,
            no_schedule,
            limits:
                SourceLimitArgs {
                    sample_rate,
                    max_records_per_sync,
                    max_records_per_day,
                },
        } => {
            let change = SourceUpdate {
                filters: if clear_filters || !filters.is_empty() {
                    Some(parse_filters(&filters)?)
                } else {
                    None
                },
                schedule: if no_schedule {
                    Some(None)
                } else {
                    schedule.map(Some)
                },
                sample_rate,
                max_records_per_sync: cap(max_records_per_sync),
                max_records_per_day: cap(max_records_per_day),
            };
            if change == SourceUpdate::default() {
                return Err(CliError::usage(
                    "nothing to change: pass --filter, --clear-filters, --schedule, --no-schedule, --sample-rate or a --max-records-* cap",
                ));
            }
            let c = ctx.client()?;
            let s = c.sources().update(&id, &change).await?;
            out.line(format!("✓ Updated source {} (from its next sync)", s.id));
            out.line(format!("  Filters: {}", limits(&s)));
            out.line(format!(
                "  Traces already synced stay; rebuild with: grad sources sync {} --full",
                s.id
            ));
            out.done(&s)
        }
        SourcesCmd::List { dataset, page: p } => {
            let c = ctx.client()?;
            let res = c.sources().list(dataset.as_deref(), &page(&p)).await?;
            out.table(
                &[
                    "id",
                    "dataset",
                    "provider",
                    "schedule",
                    "status",
                    "filters",
                    "last sync",
                    "synced",
                    "last error",
                ],
                res.data
                    .iter()
                    .map(|s| {
                        vec![
                            s.id.clone(),
                            s.dataset.clone(),
                            describe(s),
                            s.schedule.clone().unwrap_or_else(|| "-".into()),
                            status(s),
                            limits(s),
                            last_sync(s),
                            s.last_synced_at
                                .as_deref()
                                .map(when)
                                .unwrap_or_else(|| "-".into()),
                            last_error(s),
                        ]
                    })
                    .collect(),
            );
            for s in res.data.iter().filter(|s| s.status == "paused") {
                out.line(format!(
                    "! {} is paused: {}",
                    s.id,
                    s.paused_reason
                        .as_deref()
                        .unwrap_or("too many failed syncs")
                ));
            }
            more_hint(
                out,
                "/v1/sources",
                &p,
                res.data.len(),
                res.next_cursor.as_deref(),
            )?;
            out.done(&res)
        }
        SourcesCmd::Sync {
            id,
            full,
            wait,
            timeout,
        } => {
            let c = ctx.client()?;
            let job = c.sources().sync(&id, full).await?;
            if !wait {
                match job.status.as_str() {
                    "queued" => out.line(format!(
                        "✓ {} sync {} of source {} into {}",
                        if full { "Full" } else { "Queued" },
                        job.id,
                        id,
                        job.dataset
                    )),
                    "running" => out.line(format!(
                        "✓ Sync {} of source {} is already running{}",
                        job.id,
                        id,
                        if full {
                            "; the full sync starts when it ends"
                        } else {
                            ""
                        }
                    )),
                    other => out.line(format!(
                        "! Sync {} of source {} started under a minute ago ({}); a source syncs at most once a minute, so try again shortly",
                        job.id, id, other
                    )),
                }
                out.line(format!("  Check it with: grad imports status {}", job.id));
                return out.done(&job);
            }
            wait_sync(ctx, &c, &job.id, timeout).await
        }
        SourcesCmd::Remove { id } => {
            let c = ctx.client()?;
            c.sources().remove(&id).await?;
            out.line(format!("✓ Removed source {} (the dataset stays)", id));
            out.done(&json!({ "id": id, "removed": true }))
        }
    }
}

async fn wait_sync(ctx: &Ctx, c: &Client, job_id: &str, timeout: u64) -> CliResult {
    on_interrupt(format!(
        "stopped waiting; sync {} keeps running (check it with `grad imports status {}`)",
        job_id, job_id
    ));
    let opts = WaitOptions::default().timeout(Duration::from_secs(timeout));
    let done = c.imports().wait(job_id, &opts).await?;
    print_import(&ctx.out, &done);
    ctx.out.done(&done)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn one_trailing_newline_is_stripped() {
        assert_eq!(strip_one_newline("pk:sk\n".into()), "pk:sk");
        assert_eq!(strip_one_newline("pk:sk\r\n".into()), "pk:sk");
        assert_eq!(strip_one_newline("a\n\n".into()), "a\n");
        assert_eq!(strip_one_newline("a".into()), "a");
    }

    #[test]
    fn filters_parse_json_or_strings() {
        assert_eq!(
            parse_filter("tags=[\"prod\"]").unwrap(),
            ("tags".into(), json!(["prod"]))
        );
        assert_eq!(
            parse_filter("event=$ai_generation").unwrap(),
            ("event".into(), json!("$ai_generation"))
        );
        assert_eq!(parse_filter("n=3").unwrap(), ("n".into(), json!(3)));
        assert!(parse_filter("novalue").is_err());
        assert!(parse_filter("=x").is_err());
    }
}
