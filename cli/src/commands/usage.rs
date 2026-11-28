//! `grad usage` (a summary for a period) and `grad usage list` (the billed rows).

use grad_sdk::{
    Client, UsageBound, UsageGroupBy, UsageKind, UsageQuery, UsageSummary, UsageSummaryQuery,
};

use super::{more_hint, resolve_run, Ctx};
use crate::cli::{UsageCmd, UsageListArgs, UsagePeriodArgs, UsageSummaryArgs, UsageTop};
use crate::output::{thousands, usd, when, CliError, CliResult, Out, EXIT_NOT_FOUND};

pub async fn usage(ctx: &Ctx, a: UsageTop) -> CliResult {
    match a.action {
        Some(UsageCmd::List(l)) => list(ctx, l).await,
        None => summary(ctx, a.summary).await,
    }
}

/// `--from`/`--to`, checked before any request.
fn period(p: &UsagePeriodArgs) -> CliResult<(Option<UsageBound>, Option<UsageBound>)> {
    let check = |flag: &str, v: &Option<String>| {
        v.as_deref()
            .map(|s| {
                UsageBound::parse(s).map_err(|_| {
                    CliError::usage(format!(
                        "{} '{}' is not a date (YYYY-MM-DD) or an ISO 8601 timestamp",
                        flag, s
                    ))
                    .hint("e.g. --from 2026-11-01 --to 2026-11-30, or --to 2026-11-15T12:00:00Z")
                })
            })
            .transpose()
    };
    Ok((check("--from", &p.from)?, check("--to", &p.to)?))
}

async fn summary(ctx: &Ctx, a: UsageSummaryArgs) -> CliResult {
    let out = &ctx.out;
    let (from, to) = period(&a.period)?;
    let c = ctx.client()?;
    let q = UsageSummaryQuery {
        from,
        to,
        group_by: a.by.as_deref().map(UsageGroupBy::from),
    };
    let s = c.usage().summary(&q).await?;
    print_summary(out, &s);
    out.done(&s)
}

fn print_summary(out: &Out, s: &UsageSummary) {
    out.line(format!(
        "Usage {} to {} UTC: {} · {} tokens · {} billed rows",
        when(&s.from),
        when(&s.to),
        usd(s.cost_usd),
        thousands(s.tokens),
        thousands(s.records)
    ));
    if s.records == 0 {
        out.line("Nothing billed in this period.");
        return;
    }
    if let Some(by) = &s.group_by {
        out.line("");
        out.table(
            &[by.as_str(), "cost", "tokens", "rows"],
            s.groups
                .iter()
                .map(|g| {
                    vec![
                        g.key.clone().unwrap_or_else(|| "-".into()),
                        usd(g.cost_usd),
                        thousands(g.tokens),
                        thousands(g.records),
                    ]
                })
                .collect(),
        );
        return;
    }
    out.line("");
    out.table(
        &["kind", "cost", "tokens", "rows"],
        s.by_kind
            .iter()
            .map(|k| {
                vec![
                    k.kind.to_string(),
                    usd(k.cost_usd),
                    thousands(k.tokens),
                    thousands(k.records),
                ]
            })
            .collect(),
    );
    for (title, refs) in [("Top runs", &s.top_runs), ("Top evals", &s.top_evals)] {
        if refs.is_empty() {
            continue;
        }
        out.line("");
        out.line(title);
        out.table(
            &["name", "id", "kind", "cost", "tokens"],
            refs.iter()
                .map(|r| {
                    vec![
                        r.name.clone().unwrap_or_else(|| "-".into()),
                        r.id.clone(),
                        r.kind.to_string(),
                        usd(r.cost_usd),
                        thousands(r.tokens),
                    ]
                })
                .collect(),
        );
    }
}

async fn list(ctx: &Ctx, a: UsageListArgs) -> CliResult {
    let out = &ctx.out;
    let (from, to) = period(&a.period)?;
    let c = ctx.client()?;
    // An id is a filter as is; a name resolves to the newest run with it.
    let run_id = match &a.run {
        Some(r) if r.starts_with("run_") => Some(r.clone()),
        Some(r) => Some(resolve_run(&c, out, r).await?.id),
        None => None,
    };
    let eval_id = match &a.eval {
        Some(e) => Some(resolve_eval(&c, out, e).await?),
        None => None,
    };
    let q = UsageQuery {
        from,
        to,
        run_id,
        eval_id,
        kind: a.kind.as_deref().map(UsageKind::from),
        limit: a.page.limit,
        cursor: a.page.cursor.clone(),
    };
    let res = c.usage().list(&q).await?;
    out.table(
        &["time", "kind", "run/eval", "attempt", "tokens", "cost"],
        res.data
            .iter()
            .map(|u| {
                vec![
                    when(&u.created_at),
                    u.kind.to_string(),
                    match &u.ref_name {
                        Some(name) => format!("{} ({})", name, u.ref_id),
                        None => u.ref_id.clone(),
                    },
                    u.attempt.to_string(),
                    thousands(u.tokens),
                    usd(u.cost_usd),
                ]
            })
            .collect(),
    );
    more_hint(
        out,
        "/v1/usage",
        &a.page,
        res.data.len(),
        res.next_cursor.as_deref(),
    )?;
    out.done(&res)
}

/// An eval id, or the newest eval with this name (saying so when several share it).
async fn resolve_eval(c: &Client, out: &Out, arg: &str) -> CliResult<String> {
    if arg.starts_with("eval_") {
        return Ok(arg.to_string());
    }
    let named: Vec<String> = c
        .evals()
        .list_all(&Default::default())
        .await?
        .into_iter()
        .filter(|e| e.name == arg)
        .map(|e| e.id)
        .collect();
    let Some(newest) = named.first() else {
        return Err(CliError::new(
            EXIT_NOT_FOUND,
            "eval_not_found",
            format!("no eval with id or name '{}'", arg),
        )
        .hint("List evals with `grad eval list`."));
    };
    if named.len() > 1 {
        out.warn(format!(
            "{} evals match '{}'; showing the newest ({}). Pass an eval id to choose.",
            named.len(),
            arg,
            newest
        ));
    }
    Ok(newest.clone())
}
