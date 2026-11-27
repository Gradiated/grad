//! Command implementations.

pub mod auth;
pub mod data;
pub mod envserve;
pub mod eval;
pub mod serve;
pub mod train;

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
        if let Some(t) = std::env::var("GRAD_TIMEOUT_SECS")
            .ok()
            .and_then(|v| v.parse::<f64>().ok())
        {
            b = b.timeout(std::time::Duration::from_secs_f64(t.max(0.1)));
        }
        if let Some(n) = std::env::var("GRAD_MAX_RETRIES")
            .ok()
            .and_then(|v| v.parse::<u32>().ok())
        {
            b = b.max_retries(n);
        }
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
