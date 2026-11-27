mod format;

use clap::{Parser, Subcommand};
use format::{print_value, write_bytes_atomic};
use grad_sdk::{recipes, GradClient};
use serde_json::{json, Value};
use std::fs;
use std::path::PathBuf;
use std::process::{Command, ExitCode};
use std::time::Duration;

#[derive(Parser)]
#[command(name = "grad", version, about = "Gradiated training & serving CLI")]
struct Cli {
    /// grad-server base URL
    #[arg(long, env = "GRAD_BASE_URL", default_value = "http://127.0.0.1:8080")]
    base_url: String,

    /// Bearer API key
    #[arg(long, env = "GRAD_API_KEY")]
    api_key: Option<String>,

    /// Emit raw JSON output
    #[arg(long, global = true)]
    json: bool,

    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// List trainable base models
    Models {
        #[command(subcommand)]
        action: ModelsCmd,
    },
    /// Manage datasets
    Datasets {
        #[command(subcommand)]
        action: DatasetsCmd,
    },
    /// Plan or start a training run
    Train {
        #[arg(long)]
        dataset: String,
        #[arg(long)]
        name: String,
        #[arg(long, default_value = "sft")]
        recipe: String,
        #[arg(long)]
        model: Option<String>,
        #[arg(long)]
        models: Option<String>,
        #[arg(long, default_value_t = 256)]
        num_tokens: u32,
        #[arg(long)]
        max_cost_usd: Option<f64>,
        #[arg(long)]
        dry_run: bool,
        #[arg(long)]
        wait: bool,
        #[arg(long, default_value_t = 3600)]
        timeout_secs: u64,
    },
    /// Inspect and control training runs
    Runs {
        #[command(subcommand)]
        action: RunsCmd,
    },
    /// Run standalone evaluations and mine failures
    Eval {
        #[command(subcommand)]
        action: EvalCmd,
    },
    /// List, inspect, and download immutable artifacts
    Artifacts {
        #[command(subcommand)]
        action: ArtifactsCmd,
    },
    /// Deploy an artifact under a stable model name
    Deploy {
        artifact: String,
        #[arg(long)]
        name: Option<String>,
        #[arg(long)]
        fallback: Option<String>,
        #[arg(long, default_value_t = 0.0)]
        explore_rate: f64,
    },
    /// Inspect deployments
    Deployments {
        #[command(subcommand)]
        action: DeploymentsCmd,
    },
    /// Route a prompt via a deployed model router
    Route {
        #[arg(long)]
        deployment: String,
        #[arg(long)]
        prompt: String,
        #[arg(long)]
        session_id: Option<String>,
    },
    /// Manage scoped API keys
    Keys {
        #[command(subcommand)]
        action: KeysCmd,
    },
    /// Serve a local Python Environment to grad-server via outbound polling
    Env {
        #[command(subcommand)]
        action: EnvCmd,
    },
    /// Manage the local Docker Compose stack
    Local {
        #[arg(short = 'f', long, env = "GRAD_COMPOSE_FILE", default_value = "server/docker-compose.yml")]
        file: PathBuf,
        #[command(subcommand)]
        action: LocalCmd,
    },
}

#[derive(Subcommand)]
enum ModelsCmd {
    List,
}

#[derive(Subcommand)]
enum DatasetsCmd {
    List,
    Push {
        name: String,
        file: PathBuf,
    },
    Render {
        name: String,
        #[arg(long, default_value = "qwen/qwen3-8b")]
        model: String,
        #[arg(long, default_value = "last")]
        train_on: String,
        #[arg(long, default_value = "auto")]
        thinking: String,
        #[arg(long, default_value_t = 3)]
        limit: u32,
    },
}

#[derive(Subcommand)]
enum RunsCmd {
    List,
    Inspect {
        id: String,
        #[arg(long)]
        yaml: bool,
    },
    Logs {
        id: String,
        #[arg(long, default_value_t = -1)]
        after_step: i64,
    },
    Cancel {
        id: String,
    },
    Resume {
        id: String,
        #[arg(long)]
        max_cost_usd: Option<f64>,
    },
}

#[derive(Subcommand)]
enum EvalCmd {
    Plan {
        #[arg(long)]
        dataset: String,
        #[arg(long)]
        models: String,
        #[arg(long)]
        baseline: Option<String>,
        #[arg(long, default_value_t = 1)]
        samples: u32,
    },
    Run {
        #[arg(long, default_value = "cli-eval")]
        name: String,
        #[arg(long)]
        dataset: String,
        #[arg(long)]
        models: String,
        #[arg(long)]
        baseline: Option<String>,
        #[arg(long, default_value_t = 1)]
        samples: u32,
    },
    Failures {
        id: String,
        #[arg(long)]
        model: Option<String>,
        #[arg(long, default_value_t = 0.8)]
        threshold: f64,
    },
}

#[derive(Subcommand)]
enum ArtifactsCmd {
    List {
        #[arg(long)]
        name: Option<String>,
    },
    Inspect {
        reference: String,
    },
    Download {
        reference: String,
        #[arg(long)]
        out: PathBuf,
    },
}

#[derive(Subcommand)]
enum DeploymentsCmd {
    List,
    Status { name: String },
}

#[derive(Subcommand)]
enum KeysCmd {
    List,
    Create {
        #[arg(long)]
        name: String,
        #[arg(long)]
        scopes: String,
    },
    Revoke {
        id: String,
    },
}

#[derive(Subcommand)]
enum EnvCmd {
    Serve {
        /// Python module:attribute target (e.g. my_env:env)
        target: String,
        #[arg(long)]
        name: String,
        #[arg(long, default_value_t = 4)]
        concurrency: u32,
        #[arg(long)]
        max_tasks: Option<u32>,
        #[arg(long, env = "GRAD_PYTHON", default_value = "python3")]
        python: String,
    },
}

#[derive(Subcommand)]
enum LocalCmd {
    Up {
        #[arg(long)]
        gpu: bool,
    },
    Down,
    Status,
}

fn validate_positive_finite(val: f64, flag: &str) -> Result<f64, String> {
    if !val.is_finite() || val <= 0.0 {
        return Err(format!("{} must be a finite number > 0, got {}.", flag, val));
    }
    Ok(val)
}

fn validate_explore_rate(val: f64) -> Result<f64, String> {
    if !val.is_finite() || !(0.0..=0.5).contains(&val) {
        return Err(format!("--explore-rate must be between 0.0 and 0.5, got {}.", val));
    }
    Ok(val)
}

fn is_python_ident(seg: &str) -> bool {
    let mut chars = seg.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphabetic() || first == '_' => {
            chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        }
        _ => false,
    }
}

fn validate_python_target(target: &str) -> Result<(&str, &str), String> {
    let (module, attr) = target
        .split_once(':')
        .ok_or_else(|| "Target must have the form '<module>:<attribute>'.".to_string())?;
    let valid_mod = !module.is_empty() && module.split('.').all(is_python_ident);
    let valid_attr = is_python_ident(attr);
    if !valid_mod || !valid_attr {
        return Err(format!("Invalid Python module:attribute target '{}'.", target));
    }
    Ok((module, attr))
}

fn read_jsonl_records(path: &PathBuf) -> Result<Vec<Value>, String> {
    let raw = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read '{}': {}", path.display(), e))?;
    let mut records = Vec::new();
    for (idx, line) in raw.lines().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let val: Value = serde_json::from_str(trimmed)
            .map_err(|e| format!("Invalid JSON on line {}: {}", idx + 1, e))?;
        records.push(val);
    }
    if records.is_empty() {
        return Err(format!("No records found in '{}'.", path.display()));
    }
    Ok(records)
}

fn build_recipe_spec(
    recipe: &str,
    model: Option<&str>,
    models: Option<&str>,
    num_tokens: u32,
) -> Result<Value, String> {
    match recipe {
        "sft" => Ok(recipes::sft(model)),
        "dpo" => Ok(recipes::dpo(model, 0.1)),
        "router" => {
            let list: Vec<&str> = match models {
                Some(csv) => csv
                    .split(',')
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect(),
                None => vec!["qwen/qwen3-8b", "qwen/qwen3-32b"],
            };
            Ok(recipes::router(list, 0.02))
        }
        "decision" => Ok(recipes::decision(model)),
        "cartridge" => Ok(recipes::cartridge(model, None, num_tokens)),
        "embedding" => Ok(recipes::embedding(model, 0.05)),
        other => Err(format!(
            "Unsupported recipe '{}'. Supported v0 recipes: sft, dpo, router, decision, cartridge, embedding.",
            other
        )),
    }
}

async fn run(cli: Cli) -> Result<(), String> {
    let client = GradClient::new(&cli.base_url, cli.api_key.clone());

    match cli.command {
        Commands::Models {
            action: ModelsCmd::List,
        } => {
            let res = client.list_models().await.map_err(|e| e.to_string())?;
            print_value(&res, false)
        }
        Commands::Datasets { action } => match action {
            DatasetsCmd::List => {
                let res = client.list_datasets().await.map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
            DatasetsCmd::Push { name, file } => {
                let records = read_jsonl_records(&file)?;
                let res = client
                    .push_dataset(&name, records)
                    .await
                    .map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
            DatasetsCmd::Render {
                name,
                model,
                train_on,
                thinking,
                limit,
            } => {
                let body = json!({
                    "model": model,
                    "train_on": train_on,
                    "thinking": thinking,
                    "limit": limit,
                });
                let res = client
                    .render_dataset(&name, &body)
                    .await
                    .map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
        },
        Commands::Train {
            dataset,
            name,
            recipe,
            model,
            models,
            num_tokens,
            max_cost_usd,
            dry_run,
            wait,
            timeout_secs,
        } => {
            let cap = match max_cost_usd {
                Some(v) => Some(validate_positive_finite(v, "--max-cost-usd")?),
                None => None,
            };
            let spec = build_recipe_spec(
                &recipe,
                model.as_deref(),
                models.as_deref(),
                num_tokens,
            )?;
            if dry_run {
                let plan = client
                    .plan_run(&dataset, &name, spec, cap)
                    .await
                    .map_err(|e| e.to_string())?;
                return print_value(&plan, false);
            }
            let created = client
                .create_run(&dataset, &name, spec, cap)
                .await
                .map_err(|e| e.to_string())?;
            if wait {
                let run_id = created
                    .get("id")
                    .and_then(|v| v.as_str())
                    .ok_or_else(|| "Server response missing run id.".to_string())?;
                let finished = client
                    .wait_run(run_id, Duration::from_millis(250), Duration::from_secs(timeout_secs))
                    .await
                    .map_err(|e| e.to_string())?;
                print_value(&finished, false)?;
                let status = finished.get("status").and_then(|v| v.as_str()).unwrap_or("");
                if matches!(status, "failed" | "cancelled") {
                    return Err(format!("Run '{}' terminated with status '{}'.", run_id, status));
                }
                return Ok(());
            }
            print_value(&created, false)
        }
        Commands::Runs { action } => match action {
            RunsCmd::List => {
                let res = client.list_runs().await.map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
            RunsCmd::Inspect { id, yaml } => {
                let res = client.get_run(&id).await.map_err(|e| e.to_string())?;
                print_value(&res, yaml && !cli.json)
            }
            RunsCmd::Logs { id, after_step } => {
                let res = client
                    .list_run_metrics(&id, after_step)
                    .await
                    .map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
            RunsCmd::Cancel { id } => {
                let res = client.cancel_run(&id).await.map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
            RunsCmd::Resume { id, max_cost_usd } => {
                let cap = match max_cost_usd {
                    Some(v) => Some(validate_positive_finite(v, "--max-cost-usd")?),
                    None => None,
                };
                let res = client
                    .resume_run(&id, cap)
                    .await
                    .map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
        },
        Commands::Eval { action } => match action {
            EvalCmd::Plan {
                dataset,
                models,
                baseline,
                samples,
            } => {
                let model_list: Vec<&str> = models
                    .split(',')
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect();
                let mut body = json!({
                    "dataset": dataset,
                    "models": model_list,
                    "samples": samples,
                });
                if let Some(b) = baseline {
                    body["baseline"] = json!(b);
                }
                let res = client.plan_eval(&body).await.map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
            EvalCmd::Run {
                name,
                dataset,
                models,
                baseline,
                samples,
            } => {
                let model_list: Vec<&str> = models
                    .split(',')
                    .map(|s| s.trim())
                    .filter(|s| !s.is_empty())
                    .collect();
                let mut body = json!({
                    "name": name,
                    "dataset": dataset,
                    "models": model_list,
                    "samples": samples,
                });
                if let Some(b) = baseline {
                    body["baseline"] = json!(b);
                }
                let res = client.create_eval(&body).await.map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
            EvalCmd::Failures {
                id,
                model,
                threshold,
            } => {
                if !threshold.is_finite() || !(0.0..=1.0).contains(&threshold) {
                    return Err("--threshold must be in [0.0, 1.0].".to_string());
                }
                let res = client
                    .list_eval_failures(&id, model.as_deref(), threshold)
                    .await
                    .map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
        },
        Commands::Artifacts { action } => match action {
            ArtifactsCmd::List { name } => {
                let res = client
                    .list_artifacts(name.as_deref())
                    .await
                    .map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
            ArtifactsCmd::Inspect { reference } => {
                let res = client
                    .get_artifact(&reference)
                    .await
                    .map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
            ArtifactsCmd::Download { reference, out } => {
                let bytes = client
                    .download_artifact(&reference)
                    .await
                    .map_err(|e| e.to_string())?;
                write_bytes_atomic(&out, &bytes)?;
                print_value(
                    &json!({
                        "artifact": reference,
                        "path": out.display().to_string(),
                        "bytes": bytes.len(),
                    }),
                    false,
                )
            }
        },
        Commands::Deploy {
            artifact,
            name,
            fallback,
            explore_rate,
        } => {
            let rate = validate_explore_rate(explore_rate)?;
            let res = client
                .deploy(&artifact, name.as_deref(), fallback.as_deref(), rate)
                .await
                .map_err(|e| e.to_string())?;
            print_value(&res, false)
        }
        Commands::Deployments { action } => match action {
            DeploymentsCmd::List => {
                let res = client.list_deployments().await.map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
            DeploymentsCmd::Status { name } => {
                let res = client
                    .get_deployment(&name)
                    .await
                    .map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
        },
        Commands::Route {
            deployment,
            prompt,
            session_id,
        } => {
            let messages = vec![json!({ "role": "user", "content": prompt })];
            let res = client
                .route(&deployment, messages, session_id.as_deref())
                .await
                .map_err(|e| e.to_string())?;
            print_value(&res, false)
        }
        Commands::Keys { action } => match action {
            KeysCmd::List => {
                let res = client.list_api_keys().await.map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
            KeysCmd::Create { name, scopes } => {
                let parsed: Vec<String> = scopes
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect();
                let res = client
                    .create_api_key(&name, parsed)
                    .await
                    .map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
            KeysCmd::Revoke { id } => {
                let res = client
                    .revoke_api_key(&id)
                    .await
                    .map_err(|e| e.to_string())?;
                print_value(&res, false)
            }
        },
        Commands::Env {
            action:
                EnvCmd::Serve {
                    target,
                    name,
                    concurrency,
                    max_tasks,
                    python,
                },
        } => {
            if concurrency < 1 {
                return Err("--concurrency must be >= 1.".to_string());
            }
            if matches!(max_tasks, Some(0)) {
                return Err("--max-tasks must be >= 1.".to_string());
            }
            let (module, attr) = validate_python_target(&target)?;
            let script = r#"
import importlib, os, sys
from grad import serve_environment
mod = importlib.import_module(sys.argv[1])
env = getattr(mod, sys.argv[2])
if callable(env) and not hasattr(env, 'setup'):
    env = env()
max_tasks = int(sys.argv[5]) if sys.argv[5] else None
serve_environment(
    env,
    name=sys.argv[3],
    base_url=os.environ['GRAD_BASE_URL'],
    api_key=os.environ.get('GRAD_API_KEY'),
    concurrency=int(sys.argv[4]),
    max_tasks=max_tasks,
)
"#;
            let mut cmd = Command::new(&python);
            cmd.arg("-c")
                .arg(script)
                .arg(module)
                .arg(attr)
                .arg(&name)
                .arg(concurrency.to_string())
                .arg(max_tasks.map(|n| n.to_string()).unwrap_or_default())
                .env("GRAD_BASE_URL", &cli.base_url);
            if let Some(ref key) = cli.api_key {
                cmd.env("GRAD_API_KEY", key);
            }
            let status = cmd
                .status()
                .map_err(|e| format!("Failed to start '{}' env worker: {}", python, e))?;
            if !status.success() {
                return Err(format!("Environment worker exited with status {}", status));
            }
            Ok(())
        }
        Commands::Local { file, action } => {
            if !file.exists() {
                return Err(format!(
                    "Compose file '{}' not found. Pass --file <path>.",
                    file.display()
                ));
            }
            let mut cmd = Command::new("docker");
            cmd.arg("compose").arg("-f").arg(&file);
            match action {
                LocalCmd::Up { gpu } => {
                    if gpu {
                        cmd.arg("--profile").arg("gpu");
                    }
                    cmd.arg("up").arg("-d");
                }
                LocalCmd::Down => {
                    cmd.arg("down");
                }
                LocalCmd::Status => {
                    cmd.arg("ps");
                }
            }
            let status = cmd
                .status()
                .map_err(|e| format!("Failed to invoke docker compose: {}", e))?;
            if !status.success() {
                return Err(format!("docker compose exited with status {}", status));
            }
            Ok(())
        }
    }
}

#[tokio::main]
async fn main() -> ExitCode {
    let cli = Cli::parse();
    match run(cli).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(msg) => {
            eprintln!("error: {}", msg);
            ExitCode::FAILURE
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_python_env_targets_strictly() {
        assert_eq!(
            validate_python_target("my_pkg.env:repo_env").unwrap(),
            ("my_pkg.env", "repo_env")
        );
        assert!(validate_python_target("123:456").is_err());
        assert!(validate_python_target("a..b:c").is_err());
        assert!(validate_python_target(".a:b").is_err());
        assert!(validate_python_target("os; import sys:x").is_err());
        assert!(validate_python_target("no_colon").is_err());
    }

    #[test]
    fn validates_float_flags_and_yaml_output() {
        assert!(validate_positive_finite(f64::NAN, "--max-cost-usd").is_err());
        assert!(validate_positive_finite(-1.0, "--max-cost-usd").is_err());
        assert!(validate_explore_rate(0.8).is_err());
        assert!(validate_explore_rate(0.1).is_ok());
        let yaml = format::value_to_yaml(&json!({"recipe_kind": "sft", "steps": 5}));
        assert!(yaml.contains("recipe_kind: sft"));
        assert!(yaml.contains("steps: 5"));
    }

    #[test]
    fn builds_all_six_v0_recipe_specs() {
        for kind in ["sft", "dpo", "router", "decision", "cartridge", "embedding"] {
            let spec = build_recipe_spec(kind, None, None, 128).unwrap();
            assert_eq!(spec["kind"], kind);
        }
        assert!(build_recipe_spec("unknown", None, None, 128).is_err());
    }
}
