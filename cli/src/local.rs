//! `grad local up/down/status/logs/reset`: a Docker Compose stack on loopback.
//!
//! By default the compose file embedded in this binary is written to
//! `$XDG_DATA_HOME/gradiated/local/docker-compose.yml` and uses published
//! images, so it works from any directory. `--build` (or `--file`) uses a
//! source checkout's `server/docker-compose.yml` instead. The published images
//! are public on Docker Hub (`docker.io/gradiated/*`, mirrored on GHCR) and
//! pulled without a login; their tag defaults to
//! [`DEFAULT_IMAGE_TAG`] (`--image-tag` overrides it). The first `up`
//! generates an admin key, a trainer key and the workspace-secrets key and
//! stores them in the `local` profile; the server only ever sees the admin
//! key's SHA-256.

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
/// The `--dev-models` override: tiny test models in the catalog and the trainer.
pub const DEV_MODELS_COMPOSE: &str = include_str!("../assets/dev-models.yml");
/// The Grafana dashboards (deploy/grafana) the embedded compose file mounts.
const DASHBOARDS: [(&str, &str); 3] = [
    (
        "overview.json",
        include_str!("../assets/grafana/overview.json"),
    ),
    (
        "training.json",
        include_str!("../assets/grafana/training.json"),
    ),
    (
        "evals-sources.json",
        include_str!("../assets/grafana/evals-sources.json"),
    ),
];
pub const LOCAL_PROFILE: &str = "local";
/// Image tag baked in at build time (see build.rs): the version for a release
/// binary, `main` for a build from a checkout.
pub const DEFAULT_IMAGE_TAG: &str = env!("GRAD_DEFAULT_IMAGE_TAG");
/// Image overrides honoured by the embedded compose file.
const IMAGE_OVERRIDES: [&str; 3] = [
    "GRAD_SERVER_IMAGE",
    "GRAD_TRAINER_IMAGE",
    "GRAD_TRAINER_GPU_IMAGE",
];

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

/// A Docker tag: `[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}`. It is pasted into the
/// compose file, so anything else is refused.
fn valid_tag(tag: &str) -> bool {
    let mut chars = tag.chars();
    tag.len() <= 128
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_alphanumeric() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))
}

/// Write the embedded compose file with images tagged `tag` and return its path.
pub fn write_embedded(tag: &str) -> CliResult<PathBuf> {
    if !valid_tag(tag) {
        return Err(CliError::usage(format!(
            "invalid image tag {:?}: use main, sha-<7 hex>, or a version like 0.3.0",
            tag
        )));
    }
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| CliError::general("io_error", format!("{}: {}", dir.display(), e)))?;
    let path = dir.join("docker-compose.yml");
    let body = EMBEDDED_COMPOSE.replace("__GRAD_VERSION__", tag);
    std::fs::write(&path, body)
        .map_err(|e| CliError::general("io_error", format!("{}: {}", path.display(), e)))?;
    let grafana = dir.join("grafana");
    std::fs::create_dir_all(&grafana)
        .map_err(|e| CliError::general("io_error", format!("{}: {}", grafana.display(), e)))?;
    for (name, body) in DASHBOARDS {
        let file = grafana.join(name);
        std::fs::write(&file, body)
            .map_err(|e| CliError::general("io_error", format!("{}: {}", file.display(), e)))?;
    }
    Ok(path)
}

/// Write the `--dev-models` override next to the embedded compose file.
fn write_dev_models_override() -> CliResult<PathBuf> {
    let dir = data_dir()?;
    std::fs::create_dir_all(&dir)
        .map_err(|e| CliError::general("io_error", format!("{}: {}", dir.display(), e)))?;
    let path = dir.join("dev-models.yml");
    std::fs::write(&path, DEV_MODELS_COMPOSE)
        .map_err(|e| CliError::general("io_error", format!("{}: {}", path.display(), e)))?;
    Ok(path)
}

/// When the published images can't be pulled, a source checkout can build them:
/// its compose file, if `up` used the embedded one and runs inside a checkout.
fn build_fallback(err: &CliError, args: &ComposeArgs, cwd: &Path) -> Option<PathBuf> {
    let unpullable = err.code == "image_pull_denied" || err.code == "image_not_found";
    if unpullable && args.file.is_empty() {
        find_source_compose(cwd)
    } else {
        None
    }
}

/// The hint for a failed `docker compose up`: name the port only when it is taken.
fn up_failed_hint(port: u16) -> String {
    if std::net::TcpListener::bind(("127.0.0.1", port)).is_err() {
        format!(
            "Port {} is in use (maybe by another stack): pick another with --port, or stop it with `grad local down`.",
            port
        )
    } else {
        "See the docker output above, and `grad local logs` for container errors.".into()
    }
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

fn compose_files(args: &ComposeArgs, build: bool, tag: &str) -> CliResult<Vec<PathBuf>> {
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
    Ok(vec![write_embedded(tag)?])
}

/// A port from the environment (what compose publishes), else `default`.
fn env_port(name: &str, default: u16) -> u16 {
    std::env::var(name)
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(default)
}

fn docker_bin() -> String {
    std::env::var("GRAD_DOCKER")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "docker".into())
}

/// Compose profiles an `up` (and its pull) enables.
fn profiles(cmd: &mut tokio::process::Command, gpu: bool, observability: bool) {
    if gpu {
        cmd.arg("--profile").arg("gpu");
    }
    if observability {
        cmd.arg("--profile").arg("observability");
    }
}

/// `compose` with every profile on: down, ps and logs reach the GPU worker and
/// the observability services too.
fn compose_all(args: &ComposeArgs, files: &[PathBuf]) -> tokio::process::Command {
    let mut cmd = compose(args, files);
    cmd.arg("--profile").arg("*");
    cmd
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

/// `up` pulls first only for the embedded compose file with the default images:
/// with `--build`, `--file` or an image override the user manages the images.
fn pulls_published_images(args: &ComposeArgs, build: bool) -> bool {
    !build
        && args.file.is_empty()
        && IMAGE_OVERRIDES
            .iter()
            .all(|v| std::env::var_os(v).is_none_or(|x| x.is_empty()))
}

/// Why a `docker compose pull` failed, from its output.
#[derive(Debug, PartialEq, Eq)]
enum PullFailure {
    /// The registry refused us: the packages are private (or a bad login).
    Denied,
    /// No image with that tag.
    NotFound,
    /// Anything else (offline, registry down): try the images already here.
    Other,
}

fn classify_pull_failure(output: &str) -> PullFailure {
    let o = output.to_ascii_lowercase();
    if o.contains("manifest unknown") || (o.contains("manifest for") && o.contains("not found")) {
        PullFailure::NotFound
    } else if o.contains("denied") || o.contains("unauthorized") || o.contains("forbidden") {
        PullFailure::Denied
    } else {
        PullFailure::Other
    }
}

/// `docker compose pull`, so a moving tag like `main` is fresh and a refused
/// pull gets a clear error instead of a failed `up`. Output is passed through.
async fn pull_images(
    ctx: &Ctx,
    args: &ComposeArgs,
    files: &[PathBuf],
    (gpu, observability): (bool, bool),
    tag: &str,
) -> CliResult {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut cmd = compose(args, files);
    profiles(&mut cmd, gpu, observability);
    cmd.arg("pull")
        .stdin(Stdio::null())
        .stdout(if ctx.out.json {
            Stdio::null()
        } else {
            Stdio::inherit()
        })
        .stderr(Stdio::piped());
    ctx.out
        .note(format!("Pulling docker.io/gradiated images tagged {}", tag));
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            CliError::general("docker_not_found", format!("'{}' not found", docker_bin()))
                .hint("Install Docker with the Compose plugin (https://docs.docker.com/compose/install/), or set GRAD_DOCKER")
        } else {
            CliError::general("docker_failed", format!("could not run docker: {}", e))
        }
    })?;
    let mut output = String::new();
    if let Some(stderr) = child.stderr.take() {
        let mut lines = BufReader::new(stderr).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if !ctx.out.json {
                eprintln!("{}", line);
            }
            output.push_str(&line);
            output.push('\n');
        }
    }
    let status = child
        .wait()
        .await
        .map_err(|e| CliError::general("docker_failed", format!("could not run docker: {}", e)))?;
    if status.success() {
        return Ok(());
    }
    match classify_pull_failure(&output) {
        PullFailure::Denied => Err(CliError::general(
            "image_pull_denied",
            format!(
                "the registry refused to serve the grad images tagged {}",
                tag
            ),
        )
        .hint(
            "The images are public on Docker Hub, so this is usually a stale or wrong login: run \
             `docker logout` (or `docker login`) and retry, point GRAD_SERVER_IMAGE / \
             GRAD_TRAINER_IMAGE at the ghcr.io/gradiated mirror, or build them from a grad \
             checkout with `grad local up --build`.",
        )),
        PullFailure::NotFound => Err(CliError::general(
            "image_not_found",
            format!("no grad images are tagged {}", tag),
        )
        .hint(
            "Tags are main, sha-<7 hex> (each commit on main) and X.Y.Z (releases); pick one with \
             --image-tag, or build from a grad checkout with `grad local up --build`.",
        )),
        PullFailure::Other => {
            ctx.out.note(
                "Could not pull the images (see above); starting with the images already on this machine",
            );
            Ok(())
        }
    }
}

fn new_key(prefix: &str) -> String {
    let mut buf = [0u8; 24];
    getrandom::getrandom(&mut buf).expect("OS random number generator unavailable");
    format!("{}{}", prefix, hex::encode(buf))
}

struct LocalKeys {
    admin: String,
    trainer: String,
    /// GRAD_SECRETS_KEY: 32 random bytes, base64 (encrypts workspace secrets).
    secrets: String,
    created: bool,
}

fn new_secrets_key() -> String {
    use base64::Engine;
    let mut buf = [0u8; 32];
    getrandom::getrandom(&mut buf).expect("OS random number generator unavailable");
    base64::engine::general_purpose::STANDARD.encode(buf)
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
        let secrets = p
            .extra
            .get("secrets_key")
            .and_then(|v| v.as_str())
            .map(str::to_string)
            .filter(|k| !k.is_empty());
        let created = admin.is_none() || trainer.is_none();
        let admin = admin.unwrap_or_else(|| new_key("grad_local_"));
        let trainer = trainer.unwrap_or_else(|| new_key("grad_trainer_"));
        let secrets = secrets.unwrap_or_else(new_secrets_key);
        p.api_key = Some(admin.clone());
        p.base_url = Some(base_url.to_string());
        p.extra.insert("trainer_key".into(), json!(trainer));
        p.extra.insert("secrets_key".into(), json!(secrets));
        out = Some(LocalKeys {
            admin,
            trainer,
            secrets,
            created,
        });
    })?;
    Ok(out.expect("profile callback ran"))
}

/// The profile `grad local up` and `reset` write: always `local`, whatever
/// `--profile` or GRADIATED_PROFILE selects, so they never rewrite another
/// profile's key or URL. They refuse when the selected profile, or `local`
/// itself, points at a server that isn't on this machine.
fn local_profile(ctx: &Ctx) -> CliResult<&'static str> {
    let path = crate::commands::auth::config_path()?;
    let file = grad_sdk::ConfigFile::load(&path)?;
    let selected = ctx
        .global
        .profile
        .as_deref()
        .map(str::trim)
        .filter(|p| !p.is_empty());
    for name in selected.into_iter().chain([LOCAL_PROFILE]) {
        let url = file.profiles.get(name).and_then(|p| p.base_url.as_deref());
        if let Some(url) = url.filter(|u| !grad_sdk::config::is_loopback(u)) {
            return Err(CliError::usage(format!(
                "profile '{}' points at {}, not a local stack; `grad local` only writes the '{}' profile, for a server on this machine",
                name, url, LOCAL_PROFILE
            ))
            .hint(if name == LOCAL_PROFILE {
                "Point the 'local' profile back at this machine (`grad login --profile local --base-url http://127.0.0.1:8787`) or remove it (`grad --profile local logout`)."
            } else {
                "Unset GRADIATED_PROFILE or pass --profile local."
            }));
        }
    }
    if let Some(name) = selected.filter(|n| *n != LOCAL_PROFILE) {
        ctx.out.note(format!(
            "grad local uses the '{}' profile, not '{}'",
            LOCAL_PROFILE, name
        ));
    }
    Ok(LOCAL_PROFILE)
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
            observability,
            mut build,
            dev_models,
            image_tag,
            port,
            no_wait,
            timeout,
        } => {
            let tag = image_tag.as_deref().unwrap_or(DEFAULT_IMAGE_TAG);
            let overrides = if dev_models {
                vec![write_dev_models_override()?]
            } else {
                vec![]
            };
            let mut files = compose_files(&args, build, tag)?;
            files.extend(overrides.iter().cloned());
            let base_url = format!("http://127.0.0.1:{}", port);
            let profile = local_profile(ctx)?;
            let keys = ensure_keys(profile, &base_url)?;
            out.note(format!(
                "Starting grad on {} ({})",
                base_url,
                files
                    .iter()
                    .map(|f| f.display().to_string())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
            on_interrupt("stopped waiting; the containers keep starting (`grad local status`)");
            if pulls_published_images(&args, build) {
                if let Err(e) = pull_images(ctx, &args, &files, (gpu, observability), tag).await {
                    let cwd = std::env::current_dir()?;
                    let fallback = image_tag
                        .is_none()
                        .then(|| build_fallback(&e, &args, &cwd))
                        .flatten();
                    let Some(source) = fallback else {
                        return Err(e);
                    };
                    out.note(format!(
                        "{}; building them from this checkout instead ({}, like --build)",
                        e.message,
                        source.display()
                    ));
                    build = true;
                    files = std::iter::once(source).chain(overrides).collect();
                }
            }
            let mut cmd = compose(&args, &files);
            profiles(&mut cmd, gpu, observability);
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
                .env("GRAD_SECRETS_KEY", &keys.secrets)
                .env("GRAD_PORT", port.to_string());
            run(ctx, cmd, "up").await.map_err(|e| {
                if e.code == "docker_failed" {
                    e.hint(up_failed_hint(port))
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
            if keys.created {
                out.line(format!(
                    "  Generated an admin key and a trainer key (saved in profile '{}')",
                    profile
                ));
            }
            if dev_models {
                out.line(
                    "  Dev models: test/tiny-qwen3, test/tiny-qwen3-teacher, test/tiny-bert (random tiny weights; \
                     artifacts are test-only), e.g. grad train --model test/tiny-qwen3 ...",
                );
            }
            out.line(format!(
                "  Web UI: {}/  (grad --profile {} ui opens it signed in)",
                base_url, profile
            ));
            let grafana_url = observability
                .then(|| format!("http://127.0.0.1:{}/", env_port("GRAD_GRAFANA_PORT", 3000)));
            if let Some(url) = &grafana_url {
                out.line(format!(
                    "  Grafana: {}  (dashboards in the grad folder; Prometheus: http://127.0.0.1:{}/)",
                    url,
                    env_port("GRAD_PROMETHEUS_PORT", 9090)
                ));
            }
            out.line("  Next:");
            out.line(format!("    grad --profile {} models list", profile));
            out.line(format!(
                "    export GRADIATED_PROFILE={}   # use the local stack by default in this shell",
                profile
            ));
            out.line("    grad local down             # stop it (add --volumes to delete data)");
            out.done(&json!({
                "base_url": base_url,
                "ui_url": format!("{}/", base_url),
                "grafana_url": grafana_url,
                "profile": profile,
                "compose_files": files,
                "project": args.project_name,
                "keys_created": keys.created,
                "dev_models": dev_models,
                "built": build,
                "healthy": !no_wait,
            }))
        }
        LocalCmd::Down {
            compose: args,
            volumes,
        } => {
            let files = compose_files(&args, false, DEFAULT_IMAGE_TAG)?;
            let mut cmd = compose_all(&args, &files);
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
            let files = compose_files(&args, false, DEFAULT_IMAGE_TAG)?;
            let mut cmd = compose_all(&args, &files);
            cmd.arg("ps");
            run(ctx, cmd, "ps").await?;
            let base_url = grad_sdk::ConfigFile::default_path()
                .and_then(|p| grad_sdk::ConfigFile::load(&p).ok())
                .and_then(|f| {
                    f.profiles
                        .get(LOCAL_PROFILE)
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
            let files = compose_files(&args, false, DEFAULT_IMAGE_TAG)?;
            let mut cmd = compose_all(&args, &files);
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
            let profile = local_profile(ctx)?;
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
            let files = compose_files(&args, false, DEFAULT_IMAGE_TAG)?;
            let mut cmd = compose_all(&args, &files);
            cmd.arg("down").arg("--volumes").arg("--remove-orphans");
            run(ctx, cmd, "down").await?;
            save_profile(profile, |p| {
                p.api_key = None;
                p.extra.remove("trainer_key");
                p.extra.remove("secrets_key");
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
    fn image_tags() {
        assert!(!DEFAULT_IMAGE_TAG.is_empty() && valid_tag(DEFAULT_IMAGE_TAG));
        for ok in ["main", "sha-abc1234", "0.3.0", "0.3.0-rc.1", "_x"] {
            assert!(valid_tag(ok), "{ok}");
        }
        for bad in [
            "",
            "-x",
            ".x",
            "a b",
            "a\nb",
            "a:b",
            "a/b",
            &"x".repeat(129),
        ] {
            assert!(!valid_tag(bad), "{bad:?}");
        }
    }

    #[test]
    fn classifies_pull_failures() {
        use PullFailure::*;
        for (out, want) in [
            ("Error response from daemon: Head \"https://ghcr.io/v2/gradiated/grad-server/manifests/main\": unauthorized", Denied),
            ("grad-server Error response from daemon: denied", Denied),
            ("Error response from daemon: pull access denied for gradiated/grad-server, repository does not exist or may require 'docker login'", Denied),
            ("Error response from daemon: manifest unknown", NotFound),
            ("Error response from daemon: manifest for docker.io/gradiated/grad-server:9.9.9 not found: manifest unknown", NotFound),
            ("dial tcp: lookup registry-1.docker.io: no such host", Other),
        ] {
            assert_eq!(classify_pull_failure(out), want, "{out}");
        }
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

    #[test]
    fn unpullable_images_fall_back_to_a_checkout_build() {
        let root = std::env::var_os("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("grad-local-fallback-{}", std::process::id()));
        std::fs::create_dir_all(root.join("server")).unwrap();
        std::fs::write(root.join("server/docker-compose.yml"), "name: x\n").unwrap();
        let embedded = ComposeArgs {
            file: vec![],
            project_name: "grad-local".into(),
        };
        let source = Some(root.join("server/docker-compose.yml"));
        for code in ["image_pull_denied", "image_not_found"] {
            let err = CliError::general(code, "no images");
            assert_eq!(build_fallback(&err, &embedded, &root), source, "{code}");
        }
        let docker = CliError::general("docker_failed", "boom");
        assert_eq!(build_fallback(&docker, &embedded, &root), None);
        let own_file = ComposeArgs {
            file: vec![root.join("server/docker-compose.yml")],
            ..embedded
        };
        let denied = CliError::general("image_pull_denied", "no images");
        assert_eq!(build_fallback(&denied, &own_file, &root), None);
        let _ = std::fs::remove_dir_all(&root);
    }

    #[test]
    fn up_failure_names_the_port_only_when_it_is_taken() {
        let taken = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = taken.local_addr().unwrap().port();
        assert!(up_failed_hint(port).contains(&format!("Port {} is in use", port)));
        drop(taken);
        assert!(up_failed_hint(port).contains("docker output above"));
    }

    #[test]
    fn dev_models_override_registers_the_tiny_models() {
        // The folded (`>-`) YAML value: its lines joined by spaces must be the JSON catalog.
        let json: String = DEV_MODELS_COMPOSE
            .split("GRAD_EXTRA_MODELS_JSON: >-")
            .nth(1)
            .unwrap()
            .lines()
            .take_while(|l| !l.trim_start().starts_with("grad-trainer:"))
            .map(str::trim)
            .collect::<Vec<_>>()
            .join(" ");
        let models: Vec<serde_json::Value> = serde_json::from_str(&json).unwrap();
        let ids: Vec<&str> = models.iter().map(|m| m["id"].as_str().unwrap()).collect();
        assert_eq!(
            ids,
            [
                "test/tiny-qwen3",
                "test/tiny-qwen3-teacher",
                "test/tiny-bert"
            ]
        );
        assert!(DEV_MODELS_COMPOSE.contains("GRAD_DEV_MODELS: \"1\""));
    }
}
