//! `grad ui`: open grad-server's web UI in a browser, signed in.
//!
//! The profile's API key rides in a one-time `#key=` URL fragment: browsers
//! never send fragments to the server, and the page moves the key into
//! sessionStorage and strips it from the address bar on load. The key is never
//! printed; `--no-open` prints the URL without it.

use serde_json::json;
use std::process::Stdio;

use crate::cli::UiArgs;
use crate::commands::Ctx;
use crate::output::{CliError, CliResult};

/// Percent-encodes everything outside RFC 3986's unreserved set.
fn encode(s: &str) -> String {
    s.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{:02X}", b),
        })
        .collect()
}

/// The page URL for `base` (optionally a run's page), without the key.
pub fn page_url(base: &str, run: Option<&str>) -> String {
    let root = base.trim_end_matches('/');
    match run {
        Some(id) => format!("{}/runs/{}", root, encode(id)),
        None => format!("{}/", root),
    }
}

/// The URL handed to the browser: the page plus a one-time `#key=` fragment.
pub fn handoff_url(page: &str, key: Option<&str>) -> String {
    match key {
        Some(k) if !k.is_empty() => format!("{}#key={}", page, encode(k)),
        _ => page.to_string(),
    }
}

/// `$BROWSER` (a command, run without a shell), else the platform opener.
fn opener() -> (String, Vec<String>) {
    if let Some(b) = std::env::var("BROWSER")
        .ok()
        .filter(|b| !b.trim().is_empty())
    {
        let mut parts = b.split_whitespace().map(String::from);
        let cmd = parts.next().unwrap_or_default();
        return (cmd, parts.collect());
    }
    if cfg!(target_os = "macos") {
        ("open".into(), vec![])
    } else if cfg!(windows) {
        (
            "rundll32".into(),
            vec!["url.dll,FileProtocolHandler".into()],
        )
    } else {
        ("xdg-open".into(), vec![])
    }
}

fn open_browser(url: &str) -> Result<(), String> {
    let (cmd, args) = opener();
    let status = std::process::Command::new(&cmd)
        .args(&args)
        .arg(url)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map_err(|e| format!("{}: {}", cmd, e))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{} exited with {}", cmd, status))
    }
}

pub fn ui(ctx: &Ctx, args: UiArgs) -> CliResult {
    let client = ctx.client()?;
    let cfg = client.resolved_config();
    let page = page_url(&cfg.base_url, args.run.as_deref());
    let key = cfg.api_key.as_deref();
    let out = &ctx.out;

    if args.no_open {
        out.line(&page);
        if key.is_some() {
            out.note("Sign in with your API key, or run `grad ui` without --no-open to open it signed in.");
        }
        return out.done(&json!({ "url": page, "opened": false }));
    }

    open_browser(&handoff_url(&page, key)).map_err(|e| {
        CliError::general(
            "browser_unavailable",
            format!("could not open a browser ({})", e),
        )
        .hint(format!(
            "Open {} yourself and paste an API key, or set BROWSER to your browser command.",
            page
        ))
    })?;
    out.line(format!("Opened {}", page));
    if key.is_some() {
        out.note("Signed in with this profile's key for that browser tab only.");
    }
    out.done(&json!({ "url": page, "opened": true }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_page_and_handoff_urls() {
        assert_eq!(
            page_url("http://127.0.0.1:8787", None),
            "http://127.0.0.1:8787/"
        );
        assert_eq!(
            page_url("http://h:1/", Some("run_1")),
            "http://h:1/runs/run_1"
        );
        assert_eq!(
            page_url("http://h", Some("a b/c")),
            "http://h/runs/a%20b%2Fc"
        );
        assert_eq!(
            handoff_url("http://h/", Some("grad_ab+c")),
            "http://h/#key=grad_ab%2Bc"
        );
        assert_eq!(handoff_url("http://h/", Some("")), "http://h/");
        assert_eq!(handoff_url("http://h/", None), "http://h/");
    }
}
