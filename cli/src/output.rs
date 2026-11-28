//! Output: human tables and lines by default, one JSON envelope with --json,
//! and the error type that maps failures to documented exit codes.

use grad_sdk::Error as SdkError;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{IsTerminal, Write};

pub const EXIT_ERROR: i32 = 1;
pub const EXIT_USAGE: i32 = 2;
pub const EXIT_AUTH: i32 = 3;
pub const EXIT_NOT_FOUND: i32 = 4;
pub const EXIT_CONFLICT: i32 = 5;
pub const EXIT_UNAVAILABLE: i32 = 6;
pub const EXIT_RUN_FAILED: i32 = 7;
pub const EXIT_INTERRUPTED: i32 = 130;

/// A CLI failure with its exit code and JSON error shape.
#[derive(Debug)]
pub struct CliError {
    pub exit: i32,
    pub code: String,
    pub message: String,
    pub status: Option<u16>,
    pub request_id: Option<String>,
    pub hint: Option<String>,
    /// Extra machine-readable context (e.g. the failed run).
    pub data: Option<Value>,
    /// For an API error, what a person reads first (the server's detail) and the
    /// request it came from; `message` keeps the full text for JSON and logs.
    pub human: Option<(String, String)>,
}

impl CliError {
    pub fn new(exit: i32, code: &str, message: impl Into<String>) -> Self {
        CliError {
            exit,
            code: code.to_string(),
            message: message.into(),
            status: None,
            request_id: None,
            hint: None,
            data: None,
            human: None,
        }
    }

    pub fn usage(message: impl Into<String>) -> Self {
        Self::new(EXIT_USAGE, "usage_error", message)
    }

    pub fn general(code: &str, message: impl Into<String>) -> Self {
        Self::new(EXIT_ERROR, code, message)
    }

    pub fn interrupted(message: impl Into<String>) -> Self {
        Self::new(EXIT_INTERRUPTED, "interrupted", message)
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    pub fn envelope(&self) -> Value {
        let mut err = json!({
            "code": self.code,
            "message": self.message,
            "exit_code": self.exit,
            "status": self.status,
            "request_id": self.request_id,
        });
        if let Some(h) = &self.hint {
            err["hint"] = json!(h);
        }
        if let Some(d) = &self.data {
            err["details"] = d.clone();
        }
        json!({ "ok": false, "error": err })
    }
}

impl From<SdkError> for CliError {
    fn from(e: SdkError) -> Self {
        let exit = match &e {
            SdkError::Authentication(_) | SdkError::PermissionDenied(_) => EXIT_AUTH,
            SdkError::NotFound(_) => EXIT_NOT_FOUND,
            SdkError::Conflict(_) | SdkError::Validation(_) => EXIT_CONFLICT,
            SdkError::InferenceUnavailable(_) | SdkError::FeatureUnavailable(_) => EXIT_UNAVAILABLE,
            // Files that break the format spec are a 422; a source that failed is a failed job.
            SdkError::ArtifactImportFailed(_) if e.status() == 422 => EXIT_CONFLICT,
            SdkError::ArtifactImportFailed(_) => EXIT_RUN_FAILED,
            SdkError::RunFailed(_) | SdkError::EvalFailed(_) | SdkError::ImportFailed(_) => {
                EXIT_RUN_FAILED
            }
            SdkError::Config(_) | SdkError::InvalidInput(_) => EXIT_USAGE,
            _ => EXIT_ERROR,
        };
        let hint = match &e {
            SdkError::InferenceUnavailable(b) if !b.detail.contains("INFERENCE_BASE_URL") => Some(
                "Evals need an OpenAI-compatible endpoint: set GRAD_INFERENCE_BASE_URL (and GRAD_INFERENCE_API_KEY) on the server.".to_string(),
            ),
            SdkError::PermissionDenied(_) => Some("Use a key with the scope this command needs (`grad keys create --scopes ...`).".to_string()),
            _ => None,
        };
        let data = match &e {
            SdkError::RunFailed(run) => serde_json::to_value(run).ok(),
            SdkError::EvalFailed(ev) => serde_json::to_value(ev).ok(),
            SdkError::ImportFailed(job) => serde_json::to_value(job).ok(),
            SdkError::ArtifactImportFailed(job) => serde_json::to_value(job).ok(),
            SdkError::Validation(b) => b.errors.clone().map(|e| json!({ "errors": e })),
            _ => None,
        };
        let message = e.to_string();
        let human = e.api().map(|b| {
            let head = format!("{} {}: {} {}", b.method, b.url, b.status, b.code);
            let mut text = message.strip_prefix(&head).unwrap_or(&message);
            text = text.strip_prefix(": ").unwrap_or(text);
            let mut context = format!("{} {} from {} {}", b.status, b.code, b.method, b.url);
            if let Some(id) = &b.request_id {
                text = text
                    .strip_suffix(&format!(" (request_id {})", id))
                    .unwrap_or(text);
                context.push_str(&format!(", request_id {}", id));
            }
            let text = if text.is_empty() {
                b.code.as_str()
            } else {
                text
            };
            (text.to_string(), context)
        });
        CliError {
            exit,
            code: e.code(),
            status: Some(e.status()).filter(|s| *s != 0),
            request_id: e.request_id().map(str::to_string),
            message,
            hint,
            data,
            human,
        }
    }
}

impl From<std::io::Error> for CliError {
    fn from(e: std::io::Error) -> Self {
        CliError::general("io_error", e.to_string())
    }
}

pub type CliResult<T = ()> = Result<T, CliError>;

/// Where human output goes; JSON mode collects one envelope.
pub struct Out {
    pub json: bool,
    pub tty: bool,
    /// Warnings for the JSON envelope (`warnings`); human mode prints them as they come.
    warnings: std::sync::Mutex<Vec<String>>,
}

/// Write to stdout and ignore errors: a reader that went away (`grad ... | grep -q`,
/// `grad train --wait | head`) must neither panic grad nor change its exit code.
pub fn stdout(args: std::fmt::Arguments) {
    let mut o = std::io::stdout().lock();
    let _ = o.write_fmt(args);
    let _ = o.flush();
}

impl Out {
    pub fn new(json: bool) -> Self {
        Out {
            json,
            tty: std::io::stdout().is_terminal(),
            warnings: std::sync::Mutex::new(Vec::new()),
        }
    }

    /// Print a human line on stdout (suppressed in JSON mode).
    pub fn line(&self, s: impl AsRef<str>) {
        if !self.json {
            let mut o = std::io::stdout().lock();
            let _ = writeln!(o, "{}", s.as_ref());
        }
    }

    /// Print a progress/status note on stderr (suppressed in JSON mode).
    pub fn note(&self, s: impl AsRef<str>) {
        if !self.json {
            eprintln!("{}", s.as_ref());
        }
    }

    /// A warning: on stderr now, or in the JSON envelope's `warnings`.
    pub fn warn(&self, s: impl Into<String>) {
        let s = s.into();
        if self.json {
            if let Ok(mut w) = self.warnings.lock() {
                w.push(s);
            }
        } else {
            eprintln!("warning: {}", s);
        }
    }

    /// Emit the success envelope (JSON mode) and return Ok.
    pub fn done<T: Serialize>(&self, data: &T) -> CliResult {
        if self.json {
            let mut v = json!({ "ok": true, "data": data });
            let warnings = self.warnings.lock().map(|w| w.clone()).unwrap_or_default();
            if !warnings.is_empty() {
                v["warnings"] = json!(warnings);
            }
            let mut o = std::io::stdout().lock();
            let _ = writeln!(
                o,
                "{}",
                serde_json::to_string_pretty(&v).unwrap_or_default()
            );
        }
        Ok(())
    }

    /// Print a table in human mode.
    pub fn table(&self, headers: &[&str], rows: Vec<Vec<String>>) {
        if self.json {
            return;
        }
        if rows.is_empty() {
            self.line("(none)");
            return;
        }
        let mut widths: Vec<usize> = headers.iter().map(|h| h.chars().count()).collect();
        for r in &rows {
            for (i, c) in r.iter().enumerate() {
                if i < widths.len() {
                    widths[i] = widths[i].max(c.chars().count());
                }
            }
        }
        let fmt_row = |cells: Vec<String>| -> String {
            let n = cells.len();
            cells
                .into_iter()
                .enumerate()
                .map(|(i, c)| {
                    if i + 1 == n {
                        c
                    } else {
                        let pad = widths[i].saturating_sub(c.chars().count());
                        format!("{}{}", c, " ".repeat(pad))
                    }
                })
                .collect::<Vec<_>>()
                .join("  ")
        };
        self.line(fmt_row(headers.iter().map(|h| h.to_uppercase()).collect()));
        for r in rows {
            self.line(fmt_row(r));
        }
    }

    /// Print `key  value` pairs aligned.
    pub fn kv(&self, pairs: &[(&str, String)]) {
        let w = pairs.iter().map(|(k, _)| k.len()).max().unwrap_or(0);
        for (k, v) in pairs {
            self.line(format!("{:<w$}  {}", k, v, w = w));
        }
    }
}

/// Print an error to stderr (JSON envelope in JSON mode).
pub fn print_error(e: &CliError, json_mode: bool) {
    if json_mode {
        eprintln!(
            "{}",
            serde_json::to_string_pretty(&e.envelope()).unwrap_or_default()
        );
        return;
    }
    match &e.human {
        Some((text, context)) => {
            eprintln!("error: {}", text);
            eprintln!("  ({})", context);
        }
        None => eprintln!("error: {}", e.message),
    }
    if let Some(h) = &e.hint {
        eprintln!("hint: {}", h);
    }
}

/// 4820 -> "4,820".
pub fn thousands(n: i64) -> String {
    let s = n.unsigned_abs().to_string();
    let mut out = String::from(if n < 0 { "-" } else { "" });
    for (i, c) in s.chars().enumerate() {
        if i > 0 && (s.len() - i).is_multiple_of(3) {
            out.push(',');
        }
        out.push(c);
    }
    out
}

/// 125_754 -> "123 KB" (binary units, as `ls -h` and `du -h` print them).
pub fn bytes(n: i64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    let mut v = n.max(0) as f64;
    let mut i = 0;
    while v >= 1024.0 && i < UNITS.len() - 1 {
        v /= 1024.0;
        i += 1;
    }
    if i == 0 || v >= 100.0 {
        format!("{:.0} {}", v, UNITS[i])
    } else {
        format!("{:.1} {}", v, UNITS[i])
    }
}

/// Comma-joined display values (enum lists such as scopes or adapters).
pub fn join<T: std::fmt::Display>(items: &[T]) -> String {
    items.iter().map(T::to_string).collect::<Vec<_>>().join(",")
}

/// 1_100_000 -> "1.1M".
pub fn compact(n: i64) -> String {
    let f = n as f64;
    if f >= 1e9 {
        format!("{:.1}B", f / 1e9)
    } else if f >= 1e6 {
        format!("{:.1}M", f / 1e6)
    } else if f >= 1e3 {
        format!("{:.1}k", f / 1e3)
    } else {
        n.to_string()
    }
}

pub fn usd(x: f64) -> String {
    if x != 0.0 && x.abs() < 0.01 {
        format!("${:.4}", x)
    } else {
        format!("${:.2}", x)
    }
}

pub fn pct(x: f64) -> String {
    format!("{:.1}%", x * 100.0)
}

pub fn opt<T: ToString>(v: &Option<T>) -> String {
    v.as_ref()
        .map(|x| x.to_string())
        .unwrap_or_else(|| "-".into())
}

/// Format a float compactly (`0.0005` -> `5.0e-4`, `1.2345` -> `1.234`).
pub fn num(x: f64) -> String {
    if x == 0.0 {
        "0".into()
    } else if x.abs() < 1e-3 || x.abs() >= 1e6 {
        format!("{:.1e}", x)
    } else {
        let s = format!("{:.4}", x);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

/// "2026-11-27T10:00:00.000Z" -> "2026-11-27 10:00".
pub fn when(ts: &str) -> String {
    if ts.len() >= 16 && ts.as_bytes().get(10) == Some(&b'T') {
        format!("{} {}", &ts[..10], &ts[11..16])
    } else if ts.is_empty() {
        "-".into()
    } else {
        ts.to_string()
    }
}

/// Mask a secret for display: `grad_abcd…wxyz`.
pub fn mask(key: &str) -> String {
    let chars: Vec<char> = key.chars().collect();
    if chars.len() <= 12 {
        return "****".into();
    }
    let head: String = chars[..8].iter().collect();
    let tail: String = chars[chars.len() - 4..].iter().collect();
    format!("{}…{}", head, tail)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_formats() {
        assert_eq!(thousands(4820), "4,820");
        assert_eq!(thousands(1234567), "1,234,567");
        assert_eq!(thousands(12), "12");
        assert_eq!(bytes(440), "440 B");
        assert_eq!(bytes(125_754), "123 KB");
        assert_eq!(bytes(4_277_107), "4.1 MB");
        assert_eq!(compact(1_100_000), "1.1M");
        assert_eq!(compact(950), "950");
        assert_eq!(compact(12_300), "12.3k");
        assert_eq!(compact(2_000_000_000), "2.0B");
        assert_eq!(usd(1.234), "$1.23");
        assert_eq!(usd(0.0012), "$0.0012");
        assert_eq!(pct(0.912), "91.2%");
        assert_eq!(num(0.0005), "5.0e-4");
        assert_eq!(num(1.23456), "1.2346");
        assert_eq!(num(2.0), "2");
        assert_eq!(num(0.0), "0");
        assert_eq!(when("2026-11-27T10:00:00.000Z"), "2026-11-27 10:00");
        assert_eq!(when(""), "-");
        assert_eq!(mask("grad_1234567890abcdef"), "grad_123…cdef");
        assert_eq!(mask("short"), "****");
        assert_eq!(opt(&Some(3)), "3");
        assert_eq!(opt::<u8>(&None), "-");
    }

    #[test]
    fn error_envelope_shape() {
        let mut e = CliError::usage("bad").hint("do x");
        e.data = Some(json!({"a": 1}));
        let env = e.envelope();
        assert_eq!(env["ok"], false);
        assert_eq!(env["error"]["code"], "usage_error");
        assert_eq!(env["error"]["exit_code"], 2);
        assert_eq!(env["error"]["hint"], "do x");
        assert_eq!(env["error"]["details"]["a"], 1);
        assert!(env["error"]["status"].is_null());
    }
}
