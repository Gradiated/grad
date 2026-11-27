//! Command implementations.

pub mod auth;
pub mod data;
pub mod eval;
pub mod serve;
pub mod sources;
pub mod train;
pub mod ui;

use grad_sdk::{Client, CursorTrail, Error as SdkError, ListParams, Run};
use std::sync::Mutex;

use crate::cli::{Global, PageArgs};
use crate::output::{CliError, CliResult, Out};

static INTERRUPT: Mutex<Option<String>> = Mutex::new(None);

/// Set what to tell the user if they press Ctrl-C now.
pub fn on_interrupt(msg: impl Into<String>) {
    if let Ok(mut g) = INTERRUPT.lock() {
        *g = Some(msg.into());
    }
}

pub fn interrupt_message() -> Option<String> {
    INTERRUPT.lock().ok().and_then(|g| g.clone())
}

/// Shared command context.
pub struct Ctx {
    pub global: Global,
    pub out: Out,
}

impl Ctx {
    pub fn new(global: Global, out: Out) -> Self {
        Ctx { global, out }
    }

    /// Build an API client from flags, env and the config file.
    pub fn client(&self) -> CliResult<Client> {
        let mut b = Client::builder();
        if let Some(u) = &self.global.base_url {
            b = b.base_url(u);
        }
        if let Some(k) = &self.global.api_key {
            b = b.api_key(k);
        }
        if let Some(p) = &self.global.profile {
            b = b.profile(p);
        }
        // Test-only knob: shortens retry backoff in the CLI suite.
        if let Some(ms) = std::env::var("GRAD_RETRY_BASE_MS")
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
        {
            b = b.retry_base_delay(std::time::Duration::from_millis(ms));
        }
        b.build().map_err(CliError::from)
    }
}

pub fn page(p: &PageArgs) -> ListParams {
    ListParams {
        limit: p.limit,
        cursor: p.cursor.clone(),
    }
}

/// Print the `--cursor` hint for the next page of a single-page listing.
/// Fails with `pagination_loop` when the server echoed the cursor it was sent
/// (following the hint would loop) and prints nothing after an empty page.
pub fn more_hint(
    out: &Out,
    path: &str,
    p: &PageArgs,
    items: usize,
    next: Option<&str>,
) -> CliResult<()> {
    let mut trail = CursorTrail::new(path);
    if let Some(n) = trail.advance(p.cursor.as_deref(), items, next)? {
        out.note(format!("more: --cursor {}", n));
    }
    Ok(())
}

/// Resolve a run id or a run name to a run.
pub async fn resolve_run(c: &Client, run: &str) -> CliResult<Run> {
    match c.runs().get(run).await {
        Ok(r) => Ok(r),
        Err(SdkError::NotFound(b)) => {
            if run.starts_with("run_") {
                return Err(SdkError::NotFound(b).into());
            }
            match c.runs().find_by_name(run).await? {
                Some(r) => Ok(r),
                None => Err(CliError::new(
                    crate::output::EXIT_NOT_FOUND,
                    "run_not_found",
                    format!("no run with id or name '{}'", run),
                )
                .hint("List runs with `grad runs list`.")),
            }
        }
        Err(e) => Err(e.into()),
    }
}

/// Resolve a run id or name for a command that changes the run (cancel, resume).
///
/// A name never silently picks one of several runs: it must match exactly one
/// run that `eligible` accepts (or, when none is eligible, exactly one run), unless
/// `latest` asks for the newest. Otherwise the command fails and lists the ids.
pub async fn resolve_run_to_change(
    c: &Client,
    run: &str,
    latest: bool,
    verb: &str,
    eligible: impl Fn(&Run) -> bool,
) -> CliResult<Run> {
    if run.starts_with("run_") {
        return Ok(c.runs().get(run).await?);
    }
    let named: Vec<Run> = c
        .runs()
        .list_all()
        .await?
        .into_iter()
        .filter(|r| r.name == run)
        .collect();
    if named.is_empty() {
        return resolve_run(c, run).await;
    }
    let active: Vec<&Run> = named.iter().filter(|r| eligible(r)).collect();
    let pool: Vec<&Run> = if active.is_empty() {
        named.iter().collect()
    } else {
        active
    };
    if pool.len() == 1 || latest {
        return Ok(pool[0].clone());
    }
    let ids = pool
        .iter()
        .map(|r| format!("{} ({}, created {})", r.id, r.status, r.created_at))
        .collect::<Vec<_>>()
        .join(", ");
    Err(CliError::new(
        crate::output::EXIT_CONFLICT,
        "ambiguous_run_name",
        format!("{} runs are named '{}': {}", pool.len(), run, ids),
    )
    .hint(format!(
        "Pass a run id (`grad runs {} {}`), or --latest for the newest.",
        verb, pool[0].id
    )))
}

/// Validate a positive, finite float flag.
pub fn positive(v: Option<f64>, flag: &str) -> CliResult<Option<f64>> {
    match v {
        Some(x) if !x.is_finite() || x <= 0.0 => Err(CliError::usage(format!(
            "{} must be a number greater than 0 (got {})",
            flag, x
        ))),
        other => Ok(other),
    }
}

/// Validate a float in [lo, hi].
pub fn in_range(v: Option<f64>, flag: &str, lo: f64, hi: f64) -> CliResult<Option<f64>> {
    match v {
        Some(x) if !x.is_finite() || x < lo || x > hi => Err(CliError::usage(format!(
            "{} must be between {} and {} (got {})",
            flag, lo, hi, x
        ))),
        other => Ok(other),
    }
}
