//! Usage reporting: period bounds and the queries of `client.usage()`.

use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::{Error, Result};
use crate::generated::{UsageGroupBy, UsageKind};

/// A usage period bound, in UTC: a date `"2026-11-01"` (as `to`, it covers
/// that whole day), an ISO 8601 timestamp (UTC when it names no offset), or
/// a [`SystemTime`] (an instant; exclusive as `to`).
///
/// `From<&str>` and `From<String>` pass the text through (the server checks
/// it); [`UsageBound::parse`] checks it first.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageBound(String);

impl UsageBound {
    /// Checks `value` is a calendar date `YYYY-MM-DD` or an ISO 8601 timestamp.
    pub fn parse(value: &str) -> Result<Self> {
        if is_usage_bound(value) {
            Ok(Self(value.to_string()))
        } else {
            Err(Error::InvalidInput(format!(
                "'{}' is not a date (YYYY-MM-DD) or an ISO 8601 timestamp, e.g. 2026-11-01 or 2026-11-01T09:30:00Z",
                value
            )))
        }
    }

    /// The wire value.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl From<&str> for UsageBound {
    fn from(s: &str) -> Self {
        Self(s.to_string())
    }
}

impl From<String> for UsageBound {
    fn from(s: String) -> Self {
        Self(s)
    }
}

impl From<SystemTime> for UsageBound {
    fn from(t: SystemTime) -> Self {
        Self(rfc3339(t))
    }
}

/// Filters of `GET /v1/usage` (`client.usage().list(...)`).
#[derive(Debug, Clone, Default)]
pub struct UsageQuery {
    pub from: Option<UsageBound>,
    pub to: Option<UsageBound>,
    /// A run: its training and the evals it started (labeling, teacher answers, checkpoint evals).
    pub run_id: Option<String>,
    pub eval_id: Option<String>,
    pub kind: Option<UsageKind>,
    pub limit: Option<u32>,
    pub cursor: Option<String>,
}

impl UsageQuery {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn from(mut self, v: impl Into<UsageBound>) -> Self {
        self.from = Some(v.into());
        self
    }
    pub fn to(mut self, v: impl Into<UsageBound>) -> Self {
        self.to = Some(v.into());
        self
    }
    pub fn run(mut self, id: impl Into<String>) -> Self {
        self.run_id = Some(id.into());
        self
    }
    pub fn eval(mut self, id: impl Into<String>) -> Self {
        self.eval_id = Some(id.into());
        self
    }
    pub fn kind(mut self, kind: UsageKind) -> Self {
        self.kind = Some(kind);
        self
    }
    pub fn limit(mut self, n: u32) -> Self {
        self.limit = Some(n);
        self
    }
    pub fn cursor(mut self, c: impl Into<String>) -> Self {
        self.cursor = Some(c.into());
        self
    }

    /// The query without `limit` and `cursor` (a collect-all walk sets them).
    pub(crate) fn filters(&self) -> Vec<(String, String)> {
        let mut q = period(&self.from, &self.to);
        let mut push = |k: &str, v: &Option<String>| {
            if let Some(v) = v {
                q.push((k.into(), v.clone()));
            }
        };
        push("run_id", &self.run_id);
        push("eval_id", &self.eval_id);
        push("kind", &self.kind.as_ref().map(|k| k.as_str().to_string()));
        q
    }

    pub(crate) fn query(&self) -> Vec<(String, String)> {
        let mut q = Vec::new();
        if let Some(l) = self.limit {
            q.push(("limit".into(), l.to_string()));
        }
        if let Some(c) = &self.cursor {
            q.push(("cursor".into(), c.clone()));
        }
        q.extend(self.filters());
        q
    }
}

/// Query of `GET /v1/usage/summary` (`client.usage().summary(...)`); no
/// bounds is the current UTC month.
#[derive(Debug, Clone, Default)]
pub struct UsageSummaryQuery {
    pub from: Option<UsageBound>,
    pub to: Option<UsageBound>,
    pub group_by: Option<UsageGroupBy>,
}

impl UsageSummaryQuery {
    pub fn new() -> Self {
        Self::default()
    }
    pub fn from(mut self, v: impl Into<UsageBound>) -> Self {
        self.from = Some(v.into());
        self
    }
    pub fn to(mut self, v: impl Into<UsageBound>) -> Self {
        self.to = Some(v.into());
        self
    }
    pub fn group_by(mut self, by: UsageGroupBy) -> Self {
        self.group_by = Some(by);
        self
    }

    pub(crate) fn query(&self) -> Vec<(String, String)> {
        let mut q = period(&self.from, &self.to);
        if let Some(g) = &self.group_by {
            q.push(("group_by".into(), g.as_str().to_string()));
        }
        q
    }
}

fn period(from: &Option<UsageBound>, to: &Option<UsageBound>) -> Vec<(String, String)> {
    [("from", from), ("to", to)]
        .into_iter()
        .filter_map(|(k, v)| v.as_ref().map(|b| (k.to_string(), b.0.clone())))
        .collect()
}

fn digits(s: &str) -> Option<u32> {
    if s.is_empty() || !s.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    s.parse().ok()
}

fn is_calendar_date(s: &str) -> bool {
    let p: Vec<&str> = s.split('-').collect();
    let [y, m, d] = &p[..] else { return false };
    let (Some(y), Some(m), Some(d)) = (digits(y), digits(m), digits(d)) else {
        return false;
    };
    if p[0].len() != 4 || p[1].len() != 2 || p[2].len() != 2 || !(1..=12).contains(&m) {
        return false;
    }
    let leap = (y % 4 == 0 && y % 100 != 0) || y % 400 == 0;
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    d >= 1 && d <= days[(m - 1) as usize]
}

/// `HH:MM[:SS[.fraction]]`, then `Z`, `±HH:MM`, `±HHMM` or nothing.
fn is_time(s: &str) -> bool {
    let (clock, zone) = match s.find(['Z', 'z', '+', '-']) {
        Some(i) => s.split_at(i),
        None => (s, ""),
    };
    let zone_ok = match zone.as_bytes().first() {
        None => true,
        Some(b'Z' | b'z') => zone.len() == 1,
        Some(_) => {
            let z = zone[1..].replace(':', "");
            z.len() == 4
                && digits(&z[..2]).is_some_and(|h| h <= 23)
                && digits(&z[2..]).is_some_and(|m| m <= 59)
        }
    };
    let (hms, frac) = clock.split_once('.').unwrap_or((clock, ""));
    let parts: Vec<&str> = hms.split(':').collect();
    let limits = [23, 59, 59];
    let hms_ok = (2..=3).contains(&parts.len())
        && parts
            .iter()
            .zip(limits)
            .all(|(p, max)| p.len() == 2 && digits(p).is_some_and(|v| v <= max));
    let frac_ok = (frac.is_empty() && !clock.contains('.'))
        || (parts.len() == 3 && (1..=9).contains(&frac.len()) && digits(frac).is_some());
    zone_ok && hms_ok && frac_ok
}

/// True for `YYYY-MM-DD` or an ISO 8601 timestamp (what `GET /v1/usage` accepts).
pub fn is_usage_bound(value: &str) -> bool {
    match value.split_once(['T', 't']) {
        Some((date, time)) => is_calendar_date(date) && is_time(time),
        None => is_calendar_date(value),
    }
}

/// `t` as `YYYY-MM-DDTHH:MM:SS[.fraction]Z`.
fn rfc3339(t: SystemTime) -> String {
    let (secs, nanos) = match t.duration_since(UNIX_EPOCH) {
        Ok(d) => (d.as_secs() as i64, d.subsec_nanos()),
        Err(e) => {
            let d = e.duration();
            let (s, n) = (d.as_secs() as i64, d.subsec_nanos());
            if n == 0 {
                (-s, 0)
            } else {
                (-s - 1, 1_000_000_000 - n)
            }
        }
    };
    let (days, rem) = (secs.div_euclid(86_400), secs.rem_euclid(86_400));
    // Civil date from days since 1970-01-01 (Howard Hinnant's algorithm).
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    let frac = if nanos == 0 {
        String::new()
    } else {
        format!(".{:09}", nanos).trim_end_matches('0').to_string()
    };
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}{}Z",
        y,
        m,
        d,
        rem / 3600,
        rem % 3600 / 60,
        rem % 60,
        frac
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[test]
    fn bounds_accept_dates_and_timestamps_only() {
        for ok in [
            "2026-11-01",
            "2024-02-29",
            "2026-11-01T09:30",
            "2026-11-01T09:30:00Z",
            "2026-11-01t09:30:00.123456789+02:00",
            "2026-11-01T09:30:00-0500",
        ] {
            assert!(is_usage_bound(ok), "{ok}");
            assert_eq!(UsageBound::parse(ok).unwrap().as_str(), ok);
        }
        for bad in [
            "",
            "2026-02-29",
            "2026-13-01",
            "2026-1-01",
            "11/01/2026",
            "yesterday",
            "2026-11-01T",
            "2026-11-01T25:00",
            "2026-11-01T09:30:00.Z",
            "2026-11-01T09:30.5",
            "2026-11-01T09:30:00+2",
            "2026-11-01T09:30:00ZZ",
        ] {
            assert!(!is_usage_bound(bad), "{bad}");
        }
        let err = UsageBound::parse("2026-02-30").unwrap_err().to_string();
        assert!(err.contains("not a date (YYYY-MM-DD)"), "{err}");
    }

    #[test]
    fn system_times_format_as_utc_timestamps() {
        let at = |s: u64, n: u32| UsageBound::from(UNIX_EPOCH + Duration::new(s, n)).0;
        assert_eq!(at(0, 0), "1970-01-01T00:00:00Z");
        assert_eq!(at(1_793_491_200, 0), "2026-11-01T00:00:00Z");
        assert_eq!(at(1_709_208_000, 500_000_000), "2024-02-29T12:00:00.5Z");
        assert_eq!(
            UsageBound::from(UNIX_EPOCH - Duration::from_millis(1)).0,
            "1969-12-31T23:59:59.999Z"
        );
    }

    #[test]
    fn queries_carry_only_what_is_set() {
        let q = UsageQuery::new()
            .from("2026-11-01")
            .to(String::from("2026-11-30"))
            .run("run_1")
            .eval("eval_1")
            .kind(UsageKind::Labeling)
            .limit(5)
            .cursor("c1");
        let pairs: Vec<String> = q
            .query()
            .into_iter()
            .map(|(k, v)| format!("{k}={v}"))
            .collect();
        assert_eq!(
            pairs,
            [
                "limit=5",
                "cursor=c1",
                "from=2026-11-01",
                "to=2026-11-30",
                "run_id=run_1",
                "eval_id=eval_1",
                "kind=labeling"
            ]
        );
        assert!(UsageQuery::new().query().is_empty());
        let s = UsageSummaryQuery::new()
            .to("2026-11-30")
            .group_by(UsageGroupBy::Week);
        assert_eq!(
            s.query(),
            vec![
                ("to".into(), "2026-11-30".into()),
                ("group_by".into(), "week".into())
            ]
        );
    }
}
