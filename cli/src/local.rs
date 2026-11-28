//! `grad local up/down/status/logs/reset`: a Docker Compose stack on loopback.
//!
//! By default the compose file embedded in this binary is written to
//! `$XDG_DATA_HOME/gradiated/local/docker-compose.yml` and uses published
//! images, so it works from any directory. `--build` (or `--file`) uses a
//! source checkout's `server/docker-compose.yml` instead. The published images
//! are public on Docker Hub (`docker.io/gradiated/*`) and
//! pulled without a login; their tag defaults to
//! [`DEFAULT_IMAGE_TAG`] (`--image-tag` overrides it). The first `up`
//! generates an admin key, a trainer key, the workspace-secrets key and the
//! key of the stack's S3 store (SeaweedFS) and stores them in the `local`
//! profile; the server only ever sees the admin key's SHA-256.

use grad_sdk::Client;
use serde_json::json;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::{Duration, Instant};

use crate::cli::{ComposeArgs, LocalCmd};
use crate::commands::auth::save_profile;
use crate::commands::{on_interrupt, Ctx};
use crate::output::{CliError, CliResult, EXIT_AUTH, EXIT_USAGE};

pub const EMBEDDED_COMPOSE: &str = include_str!("../assets/docker-compose.yml");
/// The `--dev-models` override: tiny test models in the catalog and the trainer.
pub const DEV_MODELS_COMPOSE: &str = include_str!("../assets/dev-models.yml");
/// The Grafana dashboards (deploy/grafana) the embedded compose file mounts.
const DASHBOARDS: [(&str, &str); 1] = [("grad.json", include_str!("../assets/grafana/grad.json"))];
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
    // Dashboards an older CLI wrote would still be provisioned: remove them.
    if let Ok(entries) = std::fs::read_dir(&grafana) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if name.ends_with(".json") && !DASHBOARDS.iter().any(|(n, _)| *n == name) {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
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

/// The loopback host ports the stack publishes. The first `up` probes them and
/// saves its choice in `ports.json` (per compose project) beside the compose
/// file, so the next `up` keeps the same URLs and `status` prints them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
struct Ports {
    api: u16,
    grafana: u16,
    prometheus: u16,
    /// SeaweedFS's S3 API: the CLI and SDKs PUT files to presigned URLs on it.
    #[serde(default = "default_s3_port")]
    s3: u16,
    /// Whether the last `up` started Grafana and Prometheus.
    #[serde(default)]
    observability: bool,
}

/// An unpopular block below the Linux ephemeral range (32768+), so neither
/// common dev tools nor outbound connections take these.
const DEFAULT_PORTS: Ports = Ports {
    api: 18787,
    grafana: 18788,
    prometheus: 18789,
    s3: 18786,
    observability: false,
};

fn default_s3_port() -> u16 {
    DEFAULT_PORTS.s3
}
/// Where a busy default (or saved) port falls back to: the 20 ports after the block.
const FALLBACK_PORTS: std::ops::RangeInclusive<u16> = 18790..=18809;

fn ports_path() -> CliResult<PathBuf> {
    Ok(data_dir()?.join("ports.json"))
}

type PortsFile = std::collections::BTreeMap<String, Ports>;

fn load_ports_file() -> PortsFile {
    ports_path()
        .ok()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

/// The ports the last `up` of this compose project chose, if any.
fn saved_ports(project: &str) -> Option<Ports> {
    load_ports_file().get(project).copied()
}

fn save_ports(project: &str, ports: Ports) -> CliResult {
    let path = ports_path()?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| CliError::general("io_error", format!("{}: {}", dir.display(), e)))?;
    }
    let mut file = load_ports_file();
    file.insert(project.to_string(), ports);
    let body = serde_json::to_string_pretty(&file).expect("ports serialize");
    std::fs::write(&path, body)
        .map_err(|e| CliError::general("io_error", format!("{}: {}", path.display(), e)))
}

/// True when nothing listens on 127.0.0.1:`port` (we can bind it briefly).
fn port_free(port: u16) -> bool {
    std::net::TcpListener::bind(("127.0.0.1", port)).is_ok()
}

/// A port the user pinned with an environment variable, if set.
fn env_port(name: &str) -> CliResult<Option<u16>> {
    match std::env::var(name) {
        Ok(v) if !v.trim().is_empty() => v.trim().parse().map(Some).map_err(|_| {
            CliError::usage(format!("{}={:?} is not a port number (1-65535)", name, v))
        }),
        _ => Ok(None),
    }
}

/// One service's host port. A pinned port (`--port`, `GRAD_*_PORT`; `how`
/// names it) must be free or ours; otherwise `want` (the saved or default
/// port) if it is, else the first free port in `fallback` that no other
/// service took. `ours` are the ports this compose project already publishes.
fn pick_port(
    service: &str,
    want: u16,
    pinned: Option<&str>,
    fallback: impl IntoIterator<Item = u16>,
    ours: &[u16],
    taken: &[u16],
) -> CliResult<u16> {
    let usable = |p: u16| !taken.contains(&p) && (ours.contains(&p) || port_free(p));
    if usable(want) {
        return Ok(want);
    }
    let see =
        format!("See what is using it with `lsof -i :{want}` or `ss -ltnp 'sport = :{want}'`");
    if let Some(how) = pinned {
        return Err(CliError::new(
            EXIT_USAGE,
            "port_in_use",
            format!(
                "port {} ({}) is already in use on 127.0.0.1, so the {} can't be served there",
                want, how, service
            ),
        )
        .hint(format!(
            "{}; stop it, pick another port with {}, or unset it to let grad choose a free one.",
            see, how
        )));
    }
    let Some(port) = fallback.into_iter().find(|p| usable(*p)) else {
        return Err(CliError::new(
            EXIT_USAGE,
            "port_in_use",
            format!(
                "port {} is in use and no fallback port is free for the {}",
                want, service
            ),
        )
        .hint(format!("{}, or pick a free port yourself.", see)));
    };
    Ok(port)
}

/// The host ports this compose project's running containers publish (`docker
/// ps`), so a second `up` doesn't take its own stack for a clash. Empty when
/// docker can't say.
async fn own_ports(project: &str) -> Vec<u16> {
    let out = tokio::process::Command::new(docker_bin())
        .arg("ps")
        .arg("--filter")
        .arg(format!("label=com.docker.compose.project={}", project))
        .arg("--format")
        .arg("{{.Ports}}")
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .await;
    match out {
        Ok(o) if o.status.success() => parse_published(&String::from_utf8_lossy(&o.stdout)),
        _ => vec![],
    }
}

/// Host ports from `docker ps` Ports, e.g. `127.0.0.1:18787->8787/tcp, 9465/tcp`.
fn parse_published(ports: &str) -> Vec<u16> {
    ports
        .split([',', '\n'])
        .filter_map(|item| item.split_once("->"))
        .filter_map(|(host, _)| host.trim().rsplit_once(':')?.1.parse().ok())
        .collect()
}

/// Choose the host ports for an `up`: pinned ones as given, then the saved
/// ones, then the defaults, each moved to a free fallback port when busy (one
/// note line each). Grafana and Prometheus are probed only with observability.
fn choose_ports(
    ctx: &Ctx,
    pinned_api: Option<u16>,
    observability: bool,
    saved: Option<Ports>,
    ours: &[u16],
) -> CliResult<Ports> {
    let base = saved.unwrap_or(DEFAULT_PORTS);
    let grafana = env_port("GRAD_GRAFANA_PORT")?;
    let prometheus = env_port("GRAD_PROMETHEUS_PORT")?;
    let s3 = env_port("GRAD_S3_PORT")?;
    let mut chosen = Ports {
        api: pinned_api.unwrap_or(base.api),
        grafana: grafana.unwrap_or(base.grafana),
        prometheus: prometheus.unwrap_or(base.prometheus),
        s3: s3.unwrap_or(base.s3),
        observability,
    };
    let mut services = vec![
        (
            "API",
            &mut chosen.api,
            pinned_api.map(|_| "--port / GRAD_PORT"),
        ),
        ("S3 store", &mut chosen.s3, s3.map(|_| "GRAD_S3_PORT")),
    ];
    if observability {
        services.push((
            "Grafana",
            &mut chosen.grafana,
            grafana.map(|_| "GRAD_GRAFANA_PORT"),
        ));
        services.push((
            "Prometheus",
            &mut chosen.prometheus,
            prometheus.map(|_| "GRAD_PROMETHEUS_PORT"),
        ));
    }
    if [pinned_api, grafana, prometheus, s3].contains(&Some(0)) {
        return Err(CliError::usage(
            "port 0 is not a fixed port: pick one from 1 to 65535",
        ));
    }
    let mut taken = vec![];
    for (service, port, pinned) in services {
        let got = pick_port(service, *port, pinned, FALLBACK_PORTS, ours, &taken)?;
        if got != *port {
            ctx.out.note(format!(
                "{} is in use (by another process); serving the {} on 127.0.0.1:{}",
                port, service, got
            ));
            *port = got;
        }
        taken.push(got);
    }
    Ok(chosen)
}

/// The ports compose interpolates into the published `ports:`.
fn port_env(cmd: &mut tokio::process::Command, ports: Ports) {
    cmd.env("GRAD_PORT", ports.api.to_string())
        .env("GRAD_GRAFANA_PORT", ports.grafana.to_string())
        .env("GRAD_PROMETHEUS_PORT", ports.prometheus.to_string())
        .env("GRAD_S3_PORT", ports.s3.to_string());
}

fn url(port: u16) -> String {
    format!("http://127.0.0.1:{}", port)
}

fn docker_bin() -> String {
    std::env::var("GRAD_DOCKER")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "docker".into())
}

/// Compose profiles an `up` (and its pull) enables.
#[derive(Debug, Clone, Copy)]
struct Profiles {
    gpu: bool,
    observability: bool,
    /// grad-dev-inference, the CPU inference endpoint `--dev-models` evals call.
    dev_models: bool,
}

fn profiles(cmd: &mut tokio::process::Command, p: Profiles) {
    for (on, name) in [
        (p.gpu, "gpu"),
        (p.observability, "observability"),
        (p.dev_models, "dev-models"),
    ] {
        if on {
            cmd.arg("--profile").arg(name);
        }
    }
}

/// `compose` with every profile on: down, ps and logs reach the GPU worker and
/// the observability services too, with the ports the last `up` chose.
fn compose_all(args: &ComposeArgs, files: &[PathBuf]) -> tokio::process::Command {
    let mut cmd = compose(args, files);
    if let Some(ports) = saved_ports(&args.project_name) {
        port_env(&mut cmd, ports);
    }
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

async fn run(ctx: &Ctx, cmd: tokio::process::Command, what: &str) -> CliResult {
    run_with(ctx, cmd, what, false).await
}

/// `quiet`: compose's per-container progress lines are shown only if the command fails.
async fn run_with(
    ctx: &Ctx,
    mut cmd: tokio::process::Command,
    what: &str,
    quiet: bool,
) -> CliResult {
    if ctx.out.json {
        // Keep stdout for the JSON envelope.
        cmd.stdout(Stdio::null());
    }
    if quiet {
        let out = cmd.stdin(Stdio::null()).output().await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                CliError::general("docker_not_found", format!("'{}' not found", docker_bin()))
                    .hint("Install Docker with the Compose plugin (https://docs.docker.com/compose/install/), or set GRAD_DOCKER")
            } else {
                CliError::general("docker_failed", format!("could not run docker: {}", e))
            }
        })?;
        if out.status.success() {
            return Ok(());
        }
        if !ctx.out.json {
            eprint!("{}", String::from_utf8_lossy(&out.stdout));
            eprint!("{}", String::from_utf8_lossy(&out.stderr));
        }
        return Err(CliError::general(
            "docker_failed",
            format!("`docker compose {}` failed ({})", what, out.status),
        ));
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
    enabled: Profiles,
    tag: &str,
) -> CliResult {
    use tokio::io::{AsyncBufReadExt, BufReader};
    let mut cmd = compose(args, files);
    profiles(&mut cmd, enabled);
    // --quiet: compose's per-layer lines (dozens, since stderr isn't its TTY) bury the
    // summary; errors still come through on stderr.
    cmd.arg("pull")
        .arg("--quiet")
        .stdin(Stdio::null())
        .stdout(if ctx.out.json {
            Stdio::null()
        } else {
            Stdio::inherit()
        })
        .stderr(Stdio::piped());
    ctx.out.note(format!(
        "Pulling docker.io/gradiated images tagged {} (about 600 MB the first time)",
        tag
    ));
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
             `docker logout` (or `docker login`) and retry, or build them from a grad checkout \
             with `grad local up --build`.",
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
    /// GRAD_S3_ACCESS_KEY / GRAD_S3_SECRET_KEY: the S3 store's only identity.
    s3_access: String,
    s3_secret: String,
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
        let extra = |name: &str| {
            p.extra
                .get(name)
                .and_then(|v| v.as_str())
                .map(str::to_string)
                .filter(|k| !k.is_empty())
        };
        let trainer = extra("trainer_key");
        let secrets = extra("secrets_key");
        let s3_access = extra("s3_access_key");
        let s3_secret = extra("s3_secret_key");
        let created = admin.is_none() || trainer.is_none();
        let admin = admin.unwrap_or_else(|| new_key("grad_local_"));
        let trainer = trainer.unwrap_or_else(|| new_key("grad_trainer_"));
        let secrets = secrets.unwrap_or_else(new_secrets_key);
        let s3_access = s3_access.unwrap_or_else(|| new_key("grad").chars().take(20).collect());
        let s3_secret = s3_secret.unwrap_or_else(|| new_key(""));
        p.api_key = Some(admin.clone());
        p.base_url = Some(base_url.to_string());
        p.extra.insert("trainer_key".into(), json!(trainer));
        p.extra.insert("secrets_key".into(), json!(secrets));
        p.extra.insert("s3_access_key".into(), json!(s3_access));
        p.extra.insert("s3_secret_key".into(), json!(s3_secret));
        out = Some(LocalKeys {
            admin,
            trainer,
            secrets,
            s3_access,
            s3_secret,
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
                "Point the 'local' profile back at this machine (`grad login --profile local --base-url http://127.0.0.1:18787`) or remove it (`grad --profile local logout`)."
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
            let enabled = Profiles {
                gpu,
                observability,
                dev_models,
            };
            let overrides = if dev_models {
                vec![write_dev_models_override()?]
            } else {
                vec![]
            };
            let mut files = compose_files(&args, build, tag)?;
            files.extend(overrides.iter().cloned());
            let profile = local_profile(ctx)?;
            let ours = own_ports(&args.project_name).await;
            let saved = saved_ports(&args.project_name);
            let ports = choose_ports(ctx, port, observability, saved, &ours)?;
            let base_url = url(ports.api);
            // The profile's URL is what the CLI, every SDK and `grad ui` use.
            let keys = ensure_keys(profile, &base_url)?;
            save_ports(&args.project_name, ports)?;
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
                if let Err(e) = pull_images(ctx, &args, &files, enabled, tag).await {
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
            profiles(&mut cmd, enabled);
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
                .env("GRAD_S3_ACCESS_KEY", &keys.s3_access)
                .env("GRAD_S3_SECRET_KEY", &keys.s3_secret);
            if dev_models {
                // grad-dev-inference reads the artifacts it serves with the profile's key.
                cmd.env("GRAD_DEV_INFERENCE_API_KEY", &keys.admin);
            }
            port_env(&mut cmd, ports);
            ctx.out.note("Starting the containers");
            run_with(ctx, cmd, "up", !build).await.map_err(|e| {
                if e.code == "docker_failed" {
                    e.hint(
                        "See the docker output above, and `grad local logs` for container errors.",
                    )
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
                out.line(
                    "  Evals: a CPU endpoint serves the dev models, artifacts trained on them and the \
                     test/tiny-judge judge, e.g. grad eval --models NAME@latest,test/tiny-qwen3 ...",
                );
            }
            out.line(format!(
                "  Web UI: {}/  (grad --profile {} ui opens it signed in)",
                base_url, profile
            ));
            let grafana_url = observability.then(|| format!("{}/", url(ports.grafana)));
            let prometheus_url = observability.then(|| format!("{}/", url(ports.prometheus)));
            if let (Some(g), Some(p)) = (&grafana_url, &prometheus_url) {
                out.line(format!(
                    "  Grafana: {}  (dashboards in the grad folder; Prometheus: {})",
                    g, p
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
                "s3_url": url(ports.s3),
                "grafana_url": grafana_url,
                "prometheus_url": prometheus_url,
                "ports": ports,
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
            run_with(ctx, cmd, "down", true).await?;
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
            // The ports the last `up` chose; else the local profile's URL; else the defaults.
            let saved = saved_ports(&args.project_name);
            let base_url = saved
                .map(|p| url(p.api))
                .or_else(|| {
                    grad_sdk::ConfigFile::default_path()
                        .and_then(|p| grad_sdk::ConfigFile::load(&p).ok())
                        .and_then(|f| {
                            f.profiles
                                .get(LOCAL_PROFILE)
                                .and_then(|p| p.base_url.clone())
                        })
                })
                .unwrap_or_else(|| url(DEFAULT_PORTS.api));
            let client = Client::builder()
                .ignore_env(true)
                .ignore_config_file(true)
                .base_url(&base_url)
                .timeout(Duration::from_secs(3))
                .max_retries(0)
                .build()?;
            let healthy = client.health().await.is_ok();
            let ui_url = format!("{}/", base_url.trim_end_matches('/'));
            let obs = saved.filter(|p| p.observability);
            let grafana_url = obs.map(|p| format!("{}/", url(p.grafana)));
            let prometheus_url = obs.map(|p| format!("{}/", url(p.prometheus)));
            out.line(format!(
                "API:        {} ({})",
                base_url,
                if healthy { "ready" } else { "not reachable" }
            ));
            out.line(format!("Web UI:     {}", ui_url));
            if let (Some(g), Some(p)) = (&grafana_url, &prometheus_url) {
                out.line(format!("Grafana:    {}", g));
                out.line(format!("Prometheus: {}", p));
            }
            out.done(&json!({
                "base_url": base_url,
                "ui_url": ui_url,
                "grafana_url": grafana_url,
                "prometheus_url": prometheus_url,
                "healthy": healthy,
            }))
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
            run_with(ctx, cmd, "down", true).await?;
            save_profile(profile, |p| {
                p.api_key = None;
                p.extra.remove("trainer_key");
                p.extra.remove("secrets_key");
                p.extra.remove("s3_access_key");
                p.extra.remove("s3_secret_key");
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
        assert!(EMBEDDED_COMPOSE.contains("127.0.0.1:${GRAD_PORT:-18787}:8787"));
        assert!(EMBEDDED_COMPOSE.contains("127.0.0.1:${GRAD_GRAFANA_PORT:-18788}:3000"));
        assert!(EMBEDDED_COMPOSE.contains("127.0.0.1:${GRAD_PROMETHEUS_PORT:-18789}:9090"));
        assert!(
            !EMBEDDED_COMPOSE.contains("build:"),
            "published images only"
        );
        assert!(EMBEDDED_COMPOSE.contains("__GRAD_VERSION__"));
        // Postgres is not published at all; SeaweedFS's S3 API on loopback only.
        let pg = EMBEDDED_COMPOSE.split("\n  seaweedfs:").next().unwrap();
        assert!(!pg.contains("ports:"));
        assert!(EMBEDDED_COMPOSE.contains("127.0.0.1:${GRAD_S3_PORT:-18786}:8333"));
        assert!(EMBEDDED_COMPOSE
            .contains("S3_PUBLIC_ENDPOINT: \"http://127.0.0.1:${GRAD_S3_PORT:-18786}\""));
        // Migrations run once, before the API starts (the Helm Job).
        assert!(EMBEDDED_COMPOSE.contains("condition: service_completed_successfully"));
        assert!(EMBEDDED_COMPOSE.contains("MIGRATE_ON_BOOT: \"false\""));
        assert!(!EMBEDDED_COMPOSE.contains("STORAGE_DIR"));
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

    /// A port the OS just handed out, now free again.
    fn free_port() -> u16 {
        std::net::TcpListener::bind(("127.0.0.1", 0))
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }

    #[test]
    fn a_busy_port_falls_back_unless_pinned_or_ours() {
        let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let taken_port = listener.local_addr().unwrap().port();
        let spare = free_port();
        assert!(port_free(spare) && !port_free(taken_port));
        // Free: kept. Busy: the first usable fallback.
        assert_eq!(pick_port("API", spare, None, [], &[], &[]).unwrap(), spare);
        assert_eq!(
            pick_port("API", taken_port, None, [taken_port, spare], &[], &[]).unwrap(),
            spare
        );
        // Busy with our own stack: kept, pinned or not.
        assert_eq!(
            pick_port("API", taken_port, Some("--port"), [], &[taken_port], &[]).unwrap(),
            taken_port
        );
        // Another service already took the fallback: nothing left.
        let e = pick_port("Grafana", taken_port, None, [spare], &[], &[spare]).unwrap_err();
        assert_eq!((e.exit, e.code.as_str()), (2, "port_in_use"));
        // Pinned and busy: exit 2, naming the port and how to see its owner.
        let e = pick_port(
            "API",
            taken_port,
            Some("--port / GRAD_PORT"),
            [spare],
            &[],
            &[],
        )
        .unwrap_err();
        assert_eq!((e.exit, e.code.as_str()), (2, "port_in_use"));
        assert!(e
            .message
            .contains(&format!("port {} (--port / GRAD_PORT)", taken_port)));
        let hint = e.hint.unwrap();
        assert!(hint.contains(&format!("lsof -i :{}", taken_port)) && hint.contains("ss -ltnp"));
    }

    #[test]
    fn ports_saved_before_the_s3_store_get_its_default() {
        let old: Ports = serde_json::from_str(
            r#"{"api": 18790, "grafana": 18788, "prometheus": 18789, "observability": true}"#,
        )
        .unwrap();
        assert_eq!((old.api, old.s3), (18790, DEFAULT_PORTS.s3));
    }

    #[test]
    fn parses_published_ports_from_docker_ps() {
        assert_eq!(
            parse_published(
                "127.0.0.1:18787->8787/tcp\n\n127.0.0.1:18788->3000/tcp, 9465/tcp\n0.0.0.0:5432->5432/tcp, :::5432->5432/tcp\n"
            ),
            [18787, 18788, 5432, 5432]
        );
        assert!(parse_published("").is_empty());
    }

    #[test]
    fn dev_models_override_registers_the_tiny_models() {
        // The folded (`>-`) YAML value: its lines joined by spaces must be the JSON catalog.
        let json: String = DEV_MODELS_COMPOSE
            .split("GRAD_EXTRA_MODELS_JSON: >-")
            .nth(1)
            .unwrap()
            .lines()
            .take_while(|l| !l.trim_start().starts_with("GRAD_"))
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
        // Evals call grad-dev-inference unless the shell names an endpoint, and it judges with test/tiny-judge.
        let url = "\"${GRAD_INFERENCE_BASE_URL:-http://grad-dev-inference:8000/v1}\"";
        assert_eq!(DEV_MODELS_COMPOSE.matches(url).count(), 2);
        assert!(DEV_MODELS_COMPOSE
            .contains(r#"{"id":"test/tiny-judge","price_per_million_tokens_usd":1}"#));
        let service = EMBEDDED_COMPOSE
            .split("  grad-dev-inference:\n")
            .nth(1)
            .unwrap();
        assert!(service.starts_with("    profiles: [\"dev-models\"]\n"));
        assert!(service.contains("GRADIATED_API_KEY: \"${GRAD_DEV_INFERENCE_API_KEY:-}\""));
    }
}
