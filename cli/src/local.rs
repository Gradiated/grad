//! `grad local up/down/status/logs/reset`: a Docker Compose stack on loopback.
//!
//! By default the compose file embedded in this binary is written to
//! `$XDG_DATA_HOME/gradiated/local/docker-compose.yml` and uses published
//! images, so it works from any directory. `--build` (or `--file`) uses a
//! source checkout's `server/docker-compose.yml` instead. The first `up`
//! generates an admin key and a trainer key and stores them in the `local`
//! profile; the server only ever sees the admin key's SHA-256.

use grad_sdk::Client;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::cli::{ComposeArgs, LocalCmd};
use crate::commands::auth::save_profile;
use crate::commands::{on_interrupt, Ctx};
use crate::output::{CliError, CliResult, EXIT_AUTH};

pub const EMBEDDED_COMPOSE: &str = include_str!("../assets/docker-compose.yml");
pub const LOCAL_PROFILE: &str = "local";

fn data_dir() -> CliResult<PathBuf> {
    if let Some(x) = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|p| p.is_absolute())
    {
        return Ok(x.join("gradiated").join("local"));
    }
    let home = std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .ok_or_else(|| {
            CliError::usage("cannot find a data directory: set HOME or XDG_DATA_HOME")
        })?;
    Ok(PathBuf::from(home)
        .join(".local")
        .join("share")
        .join("gradiated")
        .join("local"))
}

/// Write the embedded compose file and return its path.
pub fn write_embedded() -> CliResult<PathBuf> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| CliError::general("io_error", format!("{}: {}", dir.display(), e)))?;
    let path = dir.join("docker-compose.yml");
    let body = EMBEDDED_COMPOSE.replace("__GRAD_VERSION__", env!("CARGO_PKG_VERSION"));
    std::fs::write(&path, body)
        .map_err(|e| CliError::general("io_error", format!("{}: {}", path.display(), e)))?;
    Ok(path)
}

/// Find `server/docker-compose.yml` in this directory or a parent.
fn find_source_compose(start: &Path) -> Option<PathBuf> {
    let mut dir = Some(start);
    while let Some(d) = dir {
        let candidate = d.join("server").join("docker-compose.yml");
        if candidate.is_file() {
            return Some(candidate);
        }
        dir = d.parent();
    }
    None
}

fn compose_files(args: &ComposeArgs, build: bool) -> CliResult<Vec<PathBuf>> {
    if !args.file.is_empty() {
        if let Some(f) = args.file.iter().find(|f| !f.is_file()) {
            return Err(CliError::usage(format!(
                "compose file {} not found",
                f.display()
            )));
        }
        return Ok(args.file.clone());
    }
    if build {
        let cwd = std::env::current_dir()?;
        return find_source_compose(&cwd).map(|f| vec![f]).ok_or_else(|| {
            CliError::usage("--build needs a source checkout: run it inside the grad repository or pass --file path/to/server/docker-compose.yml")
        });
    }
    Ok(vec![write_embedded()?])
}

fn docker_bin() -> String {
    std::env::var("GRAD_DOCKER")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "docker".into())
}

fn compose(args: &ComposeArgs, files: &[PathBuf]) -> tokio::process::Command {
    let mut cmd = tokio::process::Command::new(docker_bin());
    cmd.arg("compose").arg("-p").arg(&args.project_name);
    for f in files {
        cmd.arg("-f").arg(f);
    }
    cmd
}

async fn run(ctx: &Ctx, mut cmd: tokio::process::Command, what: &str) -> CliResult {
    if ctx.out.json {
        // Keep stdout for the JSON envelope.
        cmd.stdout(Stdio::null());
    }
    let status = cmd.status().await.map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CliError::general("docker_not_found", format!("'{}' not found", docker_bin()))
                .hint("Install Docker with the Compose plugin (https://docs.docker.com/compose/install/), or set GRAD_DOCKER")
        } else {
            CliError::general("docker_failed", format!("could not run docker: {}", e))
        }
    })?;
    if !status.success() {
        return Err(CliError::general(
            "docker_failed",
            format!("`docker compose {}` failed ({})", what, status),
        ));
    }
    Ok(())
}

fn new_key(prefix: &str) -> String {
    let mut buf = [0u8; 24];
    getrandom::getrandom(&mut buf).expect("OS random number generator unavailable");
    format!("{}{}", prefix, hex::encode(buf))
}

struct LocalKeys {
    admin: String,
    trainer: String,
    created: bool,
}

fn ensure_keys(profile: &str, base_url: &str) -> CliResult<LocalKeys> {
    let mut out = None;
    save_profile(profile, |p| {
        let admin = p.api_key.clone().filter(|k| !k.is_empty());
        let trainer = p
            .extra
            .get("trainer_key")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|k| !k.is_empty());
        let created = admin.is_none() || trainer.is_none();
        let admin = admin.unwrap_or_else(|| new_key("grad_local_"));
        let trainer = trainer.unwrap_or_else(|| new_key("grad_trainer_"));
        p.api_key = Some(admin.clone());
        p.base_url = Some(base_url.to_string());
        p.extra.insert("trainer_key".into(), json!(trainer));
        out = Some(LocalKeys {
            admin,
            trainer,
            created,
        });
    })?;
    Ok(out.expect("profile callback ran"))
}

fn profile_of(ctx: &Ctx) -> String {
    ctx.global
        .profile
        .clone()
        .filter(|p| !p.is_empty())
        .unwrap_or_else(|| LOCAL_PROFILE.into())
}

async fn wait_healthy(ctx: &Ctx, base_url: &str, timeout: Duration) -> CliResult {
    let client = Client::builder()
        .ignore_env(true)
        .ignore_config_file(true)
        .base_url(base_url)
        .timeout(Duration::from_secs(5))
        .max_retries(0)
        .build()?;
    let start = Instant::now();
    let mut said = false;
    loop {
        match client.health().await {
            Ok(_) => return Ok(()),
            Err(e) => {
                if start.elapsed() >= timeout {
                    return Err(CliError::general(
                        "local_not_ready",
                        format!(
                            "grad-server at {} did not become ready within {:?}: {}",
                            base_url, timeout, e
                        ),
                    )
                    .hint("Check the logs with `grad local logs grad-server`."));
                }
                if !said {
                    ctx.out
                        .note(format!("  waiting for {} to become ready...", base_url));
                    said = true;
                }
            }
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
}

pub async fn local(ctx: &Ctx, action: LocalCmd) -> CliResult {
    let out = &ctx.out;
    match action {
        LocalCmd::Up {
            compose: args,
            gpu,
            build,
            port,
            no_wait,
            timeout,
        } => {
            let files = compose_files(&args, build)?;
            let base_url = format!("http://127.0.0.1:{}", port);
            let profile = profile_of(ctx);
            let keys = ensure_keys(&profile, &base_url)?;
            if keys.created {
                out.note(format!(
                    "Generated an admin key and a trainer key (saved in profile '{}')",
                    profile
                ));
            }
            out.note(format!(
                "Starting grad on {} ({})",
                base_url,
                files
                    .iter()
                    .map(|f| f.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            let mut cmd = compose(&args, &files);
            if gpu {
                cmd.arg("--profile").arg("gpu");
            }
            cmd.arg("up").arg("-d");
            if build {
                cmd.arg("--build");
            }
            cmd.env("GRAD_AUTH_MODE", "api_key")
                .env(
                    "GRAD_ADMIN_API_KEY_HASH",
                    grad_sdk::sha256_hex(keys.admin.as_bytes()),
                )
                .env("GRAD_TRAINER_API_KEY", &keys.trainer)
                .env("GRAD_PORT", port.to_string());
            on_interrupt("stopped waiting; the containers keep starting (`grad local status`)");
            run(ctx, cmd, "up").await.map_err(|e| {
                if e.code == "docker_failed" {
                    e.hint(format!(
                        "If port {} is taken, pick another with --port; see `grad local logs` for container errors.",
                        port
                    ))
                } else {
                    e
                }
            })?;
            if !no_wait {
                wait_healthy(ctx, &base_url, Duration::from_secs(timeout)).await?;
                let client = Client::builder()
                    .ignore_env(true)
                    .ignore_config_file(true)
                    .base_url(&base_url)
                    .api_key(&keys.admin)
                    .max_retries(1)
                    .build()?;
                if let Err(
                    e @ (grad_sdk::Error::Authentication(_) | grad_sdk::Error::PermissionDenied(_)),
                ) = client.models().list().await
                {
                    let mut err = CliError::from(e);
                    err.exit = EXIT_AUTH;
                    return Err(err.hint(
                        "A stack started with other keys is still running. Run `grad local reset` to start fresh.",
                    ));
                }
            }
            out.line(format!(
                "✓ grad is running at {} (profile '{}')",
                base_url, profile
            ));
            out.line("  Next:");
            out.line(format!("    grad --profile {} models list", profile));
            out.line(format!(
                "    export GRADIATED_PROFILE={}   # use the local stack by default in this shell",
                profile
            ));
            out.line("    grad local down             # stop it (add --volumes to delete data)");
            out.done(&json!({
                "base_url": base_url,
                "profile": profile,
                "compose_files": files,
                "project": args.project_name,
                "keys_created": keys.created,
                "healthy": !no_wait,
            }))
        }
        LocalCmd::Down {
            compose: args,
            volumes,
        } => {
            let files = compose_files(&args, false)?;
            let mut cmd = compose(&args, &files);
            cmd.arg("down");
            if volumes {
                cmd.arg("--volumes");
            }
            run(ctx, cmd, "down").await?;
            out.line(if volumes {
                "✓ Stopped grad and deleted its data"
            } else {
                "✓ Stopped grad (data kept; `grad local down --volumes` deletes it)"
            });
            out.done(&json!({ "project": args.project_name, "volumes_removed": volumes }))
        }
        LocalCmd::Status { compose: args } => {
            let files = compose_files(&args, false)?;
            let mut cmd = compose(&args, &files);
            cmd.arg("ps");
            run(ctx, cmd, "ps").await?;
            let base_url = grad_sdk::ConfigFile::default_path()
                .and_then(|p| grad_sdk::ConfigFile::load(&p).ok())
                .and_then(|f| {
                    f.profiles
                        .get(&profile_of(ctx))
                        .and_then(|p| p.base_url.clone())
                })
                .unwrap_or_else(|| "http://127.0.0.1:8787".into());
            let client = Client::builder()
                .ignore_env(true)
                .ignore_config_file(true)
                .base_url(&base_url)
                .timeout(Duration::from_secs(3))
                .max_retries(0)
                .build()?;
            let healthy = client.health().await.is_ok();
            out.line(format!(
                "API {}: {}",
                base_url,
                if healthy { "ready" } else { "not reachable" }
            ));
            out.done(&json!({ "base_url": base_url, "healthy": healthy }))
        }
        LocalCmd::Logs {
            compose: args,
            service,
            follow,
            tail,
        } => {
            let files = compose_files(&args, false)?;
            let mut cmd = compose(&args, &files);
            cmd.arg("logs").arg("--tail").arg(&tail);
            if follow {
                cmd.arg("--follow");
            }
            if let Some(s) = &service {
                cmd.arg(s);
            }
            on_interrupt("stopped following logs");
            run(ctx, cmd, "logs").await?;
            out.done(&json!({ "project": args.project_name }))
        }
        LocalCmd::Reset { compose: args, yes } => {
            if !yes {
                use std::io::IsTerminal;
                if !std::io::stdin().is_terminal() {
                    return Err(CliError::usage(
                        "`grad local reset` deletes all local data; pass --yes to confirm",
                    ));
                }
                eprint!("Delete the local database, artifacts and keys? [y/N] ");
                let mut answer = String::new();
                std::io::stdin().read_line(&mut answer)?;
                if !matches!(answer.trim(), "y" | "Y" | "yes") {
                    return Err(CliError::usage("aborted"));
                }
            }
            let files = compose_files(&args, false)?;
            let mut cmd = compose(&args, &files);
            cmd.arg("down").arg("--volumes").arg("--remove-orphans");
            run(ctx, cmd, "down").await?;
            let profile = profile_of(ctx);
            save_profile(&profile, |p| {
                p.api_key = None;
                p.extra.remove("trainer_key");
            })?;
            out.line("✓ Deleted the local stack's data and keys; `grad local up` starts fresh");
            out.done(&json!({ "project": args.project_name, "profile": profile }))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_compose_is_loopback_only_and_versioned() {
        assert!(EMBEDDED_COMPOSE.contains("127.0.0.1:${GRAD_PORT:-8787}:8787"));
        assert!(
            !EMBEDDED_COMPOSE.contains("build:"),
            "published images only"
        );
        assert!(EMBEDDED_COMPOSE.contains("__GRAD_VERSION__"));
        // Postgres is not published at all.
        let pg = EMBEDDED_COMPOSE.split("grad-server:").next().unwrap();
        assert!(!pg.contains("ports:"));
        let k = new_key("grad_local_");
        assert!(k.starts_with("grad_local_") && k.len() == "grad_local_".len() + 48);
    }

    #[test]
    fn finds_a_source_checkout_upwards() {
        let root = std::env::var_os("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("grad-local-find-{}", std::process::id()));
        std::fs::create_dir_all(root.join("server")).unwrap();
        std::fs::create_dir_all(root.join("a/b")).unwrap();
        std::fs::write(root.join("server/docker-compose.yml"), "name: x\n").unwrap();
        assert_eq!(
            find_source_compose(&root.join("a/b")),
            Some(root.join("server/docker-compose.yml"))
        );
        let _ = std::fs::remove_dir_all(&root);
    }
}
