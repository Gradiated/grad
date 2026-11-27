//! `grad login`, `grad logout`, `grad config`, `grad keys`.

use grad_sdk::config::{self, ConfigFile, Profile, DEFAULT_BASE_URL, DEFAULT_PROFILE};
use grad_sdk::{Client, Error as SdkError};
use serde_json::json;
use std::io::{BufRead, IsTerminal, Write};
use std::path::PathBuf;

use super::{page, Ctx};
use crate::cli::{ConfigCmd, KeysCmd, LoginArgs};
use crate::output::{mask, when, CliError, CliResult, EXIT_AUTH};

pub fn config_path() -> CliResult<PathBuf> {
    ConfigFile::default_path().ok_or_else(|| {
        CliError::usage("cannot find a config directory: set HOME or XDG_CONFIG_HOME")
    })
}

fn profile_name(ctx: &Ctx) -> String {
    ctx.global
        .profile
        .clone()
        .filter(|p| !p.trim().is_empty())
        .unwrap_or_else(|| DEFAULT_PROFILE.to_string())
}

fn read_key(args: &LoginArgs, ctx: &Ctx, base_url: &str) -> CliResult<String> {
    if let Some(k) = &ctx.global.api_key {
        return Ok(k.trim().to_string());
    }
    let stdin = std::io::stdin();
    if args.api_key_stdin || !stdin.is_terminal() {
        let mut line = String::new();
        stdin.lock().read_line(&mut line)?;
        return Ok(line.trim().to_string());
    }
    eprintln!("Logging in to {}", base_url);
    if base_url == DEFAULT_BASE_URL {
        eprintln!("Create an API key in the Gradiated console (Settings -> API keys).");
    }
    let _ = std::io::stderr().flush();
    let key = rpassword::prompt_password("API key: ")
        .map_err(|e| CliError::general("io_error", format!("could not read the key: {}", e)))?;
    Ok(key.trim().to_string())
}

pub async fn login(ctx: &Ctx, args: LoginArgs) -> CliResult {
    let path = config_path()?;
    let mut file = ConfigFile::load(&path)?;
    let name = profile_name(ctx);
    let existing = file.profiles.get(&name).cloned().unwrap_or_default();
    let base_url = config::normalize_base_url(
        &ctx.global
            .base_url
            .clone()
            .or_else(|| {
                std::env::var(config::ENV_BASE_URL)
                    .ok()
                    .filter(|s| !s.trim().is_empty())
            })
            .or(existing.base_url.clone())
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string()),
    );
    config::validate_base_url(&base_url)?;
    let key = read_key(&args, ctx, &base_url)?;
    if key.is_empty() {
        return Err(CliError::usage("no API key given").hint(
            "Pass --api-key KEY, pipe it with --api-key-stdin, or run `grad login` in a terminal.",
        ));
    }
    if key.chars().any(|c| c.is_control() || c == ' ') {
        return Err(CliError::usage(
            "the API key contains spaces or control characters",
        ));
    }
    let mut verified = false;
    if !args.no_verify {
        let client = Client::builder()
            .ignore_env(true)
            .ignore_config_file(true)
            .base_url(&base_url)
            .api_key(&key)
            .build()?;
        match client.models().list().await {
            Ok(_) => verified = true,
            Err(e @ (SdkError::Authentication(_) | SdkError::PermissionDenied(_))) => {
                let mut err = CliError::from(e);
                err.exit = EXIT_AUTH;
                err.message = format!("{} rejected the API key: {}", base_url, err.message);
                return Err(err.hint("Check the key, or create a new one; nothing was saved."));
            }
            Err(e) => {
                return Err(CliError::from(e).hint(
                    "Nothing was saved. Pass --no-verify to save the key without checking it.",
                ));
            }
        }
    }
    let mut profile = existing;
    profile.base_url = Some(base_url.clone());
    profile.api_key = Some(key.clone());
    file.profiles.insert(name.clone(), profile);
    file.save(&path)?;
    let out = &ctx.out;
    out.line(format!(
        "✓ Logged in to {} as profile '{}' (key {}{})",
        base_url,
        name,
        mask(&key),
        if verified { "" } else { ", not verified" }
    ));
    out.line(format!("  Saved to {}", path.display()));
    if std::env::var_os(config::ENV_API_KEY).is_some() && name == DEFAULT_PROFILE {
        out.note(
            "note: GRADIATED_API_KEY is set in this shell and takes precedence over the saved key.",
        );
    }
    if name != DEFAULT_PROFILE {
        out.line(format!(
            "  Use it with --profile {} or export GRADIATED_PROFILE={}",
            name, name
        ));
    }
    out.done(&json!({
        "profile": name,
        "base_url": base_url,
        "config_path": path,
        "verified": verified,
        "key": mask(&key),
    }))
}

pub fn logout(ctx: &Ctx) -> CliResult {
    let path = config_path()?;
    let mut file = ConfigFile::load(&path)?;
    let name = profile_name(ctx);
    let removed = match file.profiles.get_mut(&name) {
        Some(p) if p.api_key.is_some() => {
            p.api_key = None;
            true
        }
        _ => false,
    };
    if removed {
        let empty = file
            .profiles
            .get(&name)
            .map(|p| p.extra.is_empty() && p.api_key.is_none())
            .unwrap_or(true);
        if empty {
            file.profiles.remove(&name);
        }
        file.save(&path)?;
        ctx.out
            .line(format!("✓ Removed the saved key of profile '{}'", name));
    } else {
        ctx.out.line(format!("Profile '{}' has no saved key", name));
    }
    ctx.out
        .done(&json!({ "profile": name, "removed": removed }))
}

pub fn config(ctx: &Ctx, action: ConfigCmd) -> CliResult {
    match action {
        ConfigCmd::Path => {
            let p = config_path()?;
            ctx.out.line(p.display().to_string());
            ctx.out.done(&json!({ "config_path": p }))
        }
        ConfigCmd::Show => {
            let client = ctx.client()?;
            let r = client.resolved_config();
            let key = r.api_key.as_deref().map(mask);
            ctx.out.kv(&[
                (
                    "base_url",
                    format!("{}  ({})", r.base_url, r.base_url_source),
                ),
                (
                    "api_key",
                    match &key {
                        Some(k) => format!("{}  ({})", k, r.api_key_source),
                        None => "not set (run `grad login` or set GRADIATED_API_KEY)".into(),
                    },
                ),
                ("profile", r.profile.clone()),
                (
                    "config_file",
                    r.config_path
                        .as_ref()
                        .map(|p| p.display().to_string())
                        .unwrap_or_else(|| "-".into()),
                ),
            ]);
            if let Some(n) = &r.note {
                ctx.out.note(format!("note: {}", n));
            }
            ctx.out.done(&json!({
                "base_url": r.base_url,
                "base_url_source": r.base_url_source.to_string(),
                "api_key": key,
                "api_key_source": r.api_key_source.to_string(),
                "profile": r.profile,
                "config_path": r.config_path,
                "note": r.note,
            }))
        }
    }
}

pub async fn keys(ctx: &Ctx, action: KeysCmd) -> CliResult {
    let c = ctx.client()?;
    let out = &ctx.out;
    match action {
        KeysCmd::List { page: p } => {
            let res = c.keys().list(&page(&p)).await?;
            out.table(
                &["id", "name", "prefix", "scopes", "created", "revoked"],
                res.data
                    .iter()
                    .map(|k| {
                        vec![
                            k.id.clone(),
                            k.name.clone(),
                            k.prefix.clone(),
                            k.scopes.join(","),
                            when(&k.created_at),
                            k.revoked_at
                                .as_deref()
                                .map(when)
                                .unwrap_or_else(|| "-".into()),
                        ]
                    })
                    .collect(),
            );
            out.done(&res)
        }
        KeysCmd::Create { name, scopes } => {
            let scopes: Vec<String> = scopes
                .into_iter()
                .map(|s| s.trim().to_string())
                .filter(|s| !s.is_empty())
                .collect();
            let created = c.keys().create(&name, &scopes).await?;
            out.line(format!(
                "✓ Created key {} ({})",
                created.key.id,
                created.key.scopes.join(",")
            ));
            out.line("  Secret (shown once, store it now):");
            out.line(format!("  {}", created.secret));
            out.done(&json!({ "key": created.key, "secret": created.secret }))
        }
        KeysCmd::Revoke { id } => {
            let k = c.keys().revoke(&id).await?;
            out.line(format!("✓ Revoked key {}", k.id));
            out.done(&k)
        }
    }
}

/// Save a profile (used by `grad local up`).
pub fn save_profile(name: &str, f: impl FnOnce(&mut Profile)) -> CliResult<PathBuf> {
    let path = config_path()?;
    let mut file = ConfigFile::load(&path)?;
    let entry = file.profiles.entry(name.to_string()).or_default();
    f(entry);
    file.save(&path)?;
    Ok(path)
}
