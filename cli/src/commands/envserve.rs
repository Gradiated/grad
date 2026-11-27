//! `grad env serve`: delegates to the Python SDK's `serve_environment`.

use serde_json::json;

use super::{on_interrupt, Ctx};
use crate::cli::EnvCmd;
use crate::output::{CliError, CliResult, EXIT_INTERRUPTED, EXIT_USAGE};

/// Python launcher. Accepts an Environment instance, an Environment subclass
/// (instantiated with no arguments) or a zero-argument factory.
pub const SERVE_SCRIPT: &str = r#"
import importlib, inspect, json, os, sys
try:
    import grad
    from grad import serve_environment
except ImportError as exc:
    sys.stderr.write("grad env serve needs the Python SDK in %s (pip install grad-sdk, or pass --python): %s\n" % (sys.executable, exc))
    sys.exit(86)
cfg = json.loads(os.environ["GRAD_ENV_SERVE"])
sys.path.insert(0, os.getcwd())
try:
    mod = importlib.import_module(cfg["module"])
except ImportError as exc:
    sys.stderr.write("cannot import module %r: %s\n" % (cfg["module"], exc))
    sys.exit(87)
try:
    obj = getattr(mod, cfg["attr"])
except AttributeError:
    sys.stderr.write("module %r has no attribute %r\n" % (cfg["module"], cfg["attr"]))
    sys.exit(87)
Environment = getattr(grad, "Environment", None)
if isinstance(obj, type):
    obj = obj()
elif Environment is not None and isinstance(obj, Environment):
    pass
elif callable(obj) and not hasattr(obj, "setup"):
    obj = obj()
if Environment is not None and not isinstance(obj, Environment) and not hasattr(obj, "evaluate"):
    sys.stderr.write("%s:%s is not a grad.Environment (got %s)\n" % (cfg["module"], cfg["attr"], type(obj).__name__))
    sys.exit(87)
kwargs = {
    "name": cfg["name"],
    "base_url": os.environ["GRADIATED_BASE_URL"],
    "api_key": os.environ.get("GRADIATED_API_KEY") or None,
    "concurrency": cfg["concurrency"],
    "max_tasks": cfg["max_tasks"],
    "wait_ms": cfg["wait_ms"],
    "worker_id": cfg["worker_id"],
}
params = inspect.signature(serve_environment).parameters
if not any(p.kind == p.VAR_KEYWORD for p in params.values()):
    kwargs = {k: v for k, v in kwargs.items() if k in params}
kwargs = {k: v for k, v in kwargs.items() if v is not None or k == "api_key"}
try:
    serve_environment(obj, **kwargs)
except KeyboardInterrupt:
    sys.exit(130)
"#;

fn is_ident(seg: &str) -> bool {
    let mut chars = seg.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {
            chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        _ => false,
    }
}

/// Split `module.path:attribute`, rejecting anything that is not a dotted identifier.
pub fn parse_target(target: &str) -> CliResult<(String, String)> {
    let (module, attr) = target.split_once(':').ok_or_else(|| {
        CliError::usage(format!(
            "target must be MODULE:ATTRIBUTE (e.g. my_env:env), got '{}'",
            target
        ))
    })?;
    if module.is_empty() || !module.split('.').all(is_ident) || !is_ident(attr) {
        return Err(CliError::usage(format!(
            "invalid Python target '{}': use MODULE:ATTRIBUTE with identifiers only (e.g. my_pkg.envs:support_env)",
            target
        )));
    }
    Ok((module.to_string(), attr.to_string()))
}

pub async fn env(ctx: &Ctx, action: EnvCmd) -> CliResult {
    match action {
        EnvCmd::Check { .. } => Err(CliError::new(
            EXIT_USAGE,
            "not_available",
            "`grad env check` is not available in v0",
        )),
        EnvCmd::Serve {
            target,
            name,
            concurrency,
            max_tasks,
            wait_ms,
            worker_id,
            python,
        } => {
            let (module, attr) = parse_target(&target)?;
            if name.trim().is_empty() {
                return Err(CliError::usage("--name must not be empty"));
            }
            if concurrency == 0 {
                return Err(CliError::usage("--concurrency must be at least 1"));
            }
            if max_tasks == Some(0) {
                return Err(CliError::usage("--max-tasks must be at least 1"));
            }
            let c = ctx.client()?;
            let rc = c.resolved_config();
            let cfg = json!({
                "module": module, "attr": attr, "name": name, "concurrency": concurrency,
                "max_tasks": max_tasks, "wait_ms": wait_ms, "worker_id": worker_id,
            });
            ctx.out.note(format!(
                "Serving {} as environment '{}' to {} (concurrency {}); Ctrl-C to stop",
                target, name, rc.base_url, concurrency
            ));
            on_interrupt(format!("stopped serving environment '{}'", name));
            let mut cmd = tokio::process::Command::new(&python);
            cmd.arg("-c")
                .arg(SERVE_SCRIPT)
                .env("GRAD_ENV_SERVE", cfg.to_string())
                .env("GRADIATED_BASE_URL", &rc.base_url)
                .kill_on_drop(true);
            match &rc.api_key {
                Some(k) => {
                    cmd.env("GRADIATED_API_KEY", k);
                }
                None => {
                    cmd.env_remove("GRADIATED_API_KEY");
                }
            }
            let status = cmd.status().await.map_err(|e| {
                CliError::usage(format!("could not start '{}': {}", python, e)).hint(
                    "Install Python 3 and `pip install grad-sdk`, or pass --python /path/to/python",
                )
            })?;
            match status.code() {
                Some(0) => ctx
                    .out
                    .done(&json!({ "environment": name, "status": "stopped" })),
                Some(86) => Err(CliError::usage(
                    "the Python SDK is not installed for this interpreter",
                )
                .hint("pip install grad-sdk, or pass --python")),
                Some(87) => Err(CliError::usage(format!("could not load {}", target))),
                Some(130) => Err(CliError::interrupted(format!(
                    "stopped serving environment '{}'",
                    name
                ))),
                None => Err(CliError::new(
                    EXIT_INTERRUPTED,
                    "interrupted",
                    "the environment worker was stopped by a signal",
                )),
                Some(code) => Err(CliError::general(
                    "env_worker_failed",
                    format!("the environment worker exited with code {}", code),
                )),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn targets_are_strict() {
        assert_eq!(
            parse_target("my_pkg.env:repo_env").unwrap(),
            ("my_pkg.env".to_string(), "repo_env".to_string())
        );
        for bad in [
            "123:456",
            "a..b:c",
            ".a:b",
            "os; import sys:x",
            "no_colon",
            "a:",
            ":b",
            "a:b.c",
        ] {
            assert!(parse_target(bad).is_err(), "{}", bad);
        }
    }
}
