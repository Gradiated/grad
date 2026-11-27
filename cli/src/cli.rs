//! Command-line definitions (clap derive). Every command and flag has help text.

use clap::{Args, Parser, Subcommand};
use std::path::PathBuf;

pub const EXIT_CODES: &str = "\
Exit codes:
  0    success
  1    error (network, server, timeout, checksum, local I/O)
  2    usage error (bad flags or arguments, invalid local file, bad config)
  3    authentication or permission error (401/403)
  4    not found (404)
  5    conflict or validation error (409/422)
  6    capability unavailable on this server (deploy_unavailable, inference_unavailable)
  7    run, eval or import finished unsuccessfully (failed, cancelled; runs also stopped_budget)
  130  interrupted (Ctrl-C); a started run keeps going on the server";

const MAIN_AFTER: &str = "\
Configuration (highest precedence first):
  --api-key / --base-url flags
  --profile NAME or GRADIATED_PROFILE (a profile saved by `grad login`)
  GRADIATED_API_KEY / GRADIATED_BASE_URL environment variables
  the 'default' profile in $XDG_CONFIG_HOME/gradiated/config.json
  https://api.gradiated.com

Pass --json to any command for one machine-readable envelope on stdout
({\"ok\": true, \"data\": ...}); errors are {\"ok\": false, \"error\": {...}} on stderr.

Quickstart:
  grad login
  grad import ./support_traces.jsonl --dataset support-prod
  grad train --dataset support-prod --name support-router --recipe router --dry-run
  grad train --dataset support-prod --name support-router --recipe router --wait
  grad deploy support-router@latest
";

#[derive(Parser, Debug)]
#[command(
    name = "grad",
    version,
    about = "Train, evaluate and deploy models on Gradiated (Cloud or self-hosted)",
    after_help = format!("{}\n{}", MAIN_AFTER, EXIT_CODES),
    disable_help_subcommand = false
)]
pub struct Cli {
    #[command(flatten)]
    pub global: Global,

    #[command(subcommand)]
    pub command: Command,
}

#[derive(Args, Debug, Clone, Default)]
pub struct Global {
    /// API base URL (default: GRADIATED_BASE_URL, the profile, then https://api.gradiated.com)
    #[arg(
        long,
        global = true,
        value_name = "URL",
        help_heading = "Global options"
    )]
    pub base_url: Option<String>,

    /// API key; prefer `grad login` or GRADIATED_API_KEY (flags are visible in `ps`)
    #[arg(
        long,
        global = true,
        value_name = "KEY",
        help_heading = "Global options"
    )]
    pub api_key: Option<String>,

    /// Use a profile saved by `grad login` (wins over GRADIATED_* env vars)
    #[arg(
        long,
        global = true,
        env = "GRADIATED_PROFILE",
        value_name = "NAME",
        hide_env_values = true,
        help_heading = "Global options"
    )]
    pub profile: Option<String>,

    /// Print one JSON envelope on stdout (errors as JSON on stderr)
    #[arg(long, global = true, help_heading = "Global options")]
    pub json: bool,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Save an API key for this machine (validated against the server)
    #[command(after_help = "\
Examples:
  grad login                                   # prompts for the key
  grad login --api-key \"$KEY\"
  echo \"$KEY\" | grad login --api-key-stdin
  grad login --base-url http://127.0.0.1:8787 --profile local

The key is written to $XDG_CONFIG_HOME/gradiated/config.json (mode 0600).")]
    Login(LoginArgs),

    /// Remove a saved profile's API key
    Logout,

    /// Show how the CLI is configured (base URL, key source, profile)
    Config {
        #[command(subcommand)]
        action: ConfigCmd,
    },

    /// List trainable base models
    Models {
        #[command(subcommand)]
        action: ModelsCmd,
    },

    /// Create, push, inspect and import datasets
    Datasets {
        #[command(subcommand)]
        action: DatasetsCmd,
    },

    /// Upload a trace export (JSONL, JSON or Parquet) and import it into a dataset
    #[command(after_help = "\
Examples:
  grad import ./support_traces.jsonl --dataset support-prod
  grad import ./traces.parquet --format otel --dataset support-prod --json

--format takes a file format (auto, jsonl, json, parquet) or a parser
(grad_trajectories, openai_chat, gradiated, otel, langfuse, posthog,
braintrust, langsmith). The file is streamed, never loaded into memory.
Imports run on a trainer worker; the command waits for it unless --no-wait.")]
    Import(ImportArgs),

    /// Inspect dataset import jobs
    Imports {
        #[command(subcommand)]
        action: ImportsCmd,
    },

    /// Preview chat-template rendering and loss masks
    Render(RenderArgs),

    /// Plan (--dry-run) or start a training run
    #[command(after_help = "\
Examples:
  grad train --dataset support-prod --name support-router --recipe router --dry-run
  grad train --dataset support-prod --name support-router --recipe router --wait
  grad train --dataset ticket-triage --name ticket-triage --recipe decision-model --wait
  grad train -f recipe.yaml --dry-run
  grad train -f recipe.yaml --set lr_scale=0.5 --wait

-f takes the flat YAML written by `grad runs inspect RUN --yaml`; flags override it.
--wait streams live metrics and prints the eval report and the deploy command.")]
    Train(TrainArgs),

    /// Inspect and control training runs
    Runs {
        #[command(subcommand)]
        action: RunsCmd,
    },

    /// Run an evaluation (or plan it with --dry-run); see subcommands for results
    #[command(
        args_conflicts_with_subcommands = true,
        subcommand_negates_reqs = true,
        after_help = "\
Examples:
  grad eval --name sql-baseline --models qwen/qwen3-8b,sql-agent@latest \\
    --dataset sql-eval-holdout --rubric ./rubric.yaml --samples 4 --temperature 0.7 \\
    --baseline qwen/qwen3-8b --wait
  grad eval plan --models a,b --dataset holdout
  grad eval failures eval_01J... --model sql-agent@latest

--rubric takes a YAML/JSON list of rubric items (regex, validator, judge).
Code scorers run in your process: use the Python SDK for those."
    )]
    Eval(EvalTop),

    /// List, inspect and download immutable artifacts
    Artifacts {
        #[command(subcommand)]
        action: ArtifactsCmd,
    },

    /// Deploy an artifact behind a stable model name (Gradiated Cloud)
    #[command(after_help = "\
Examples:
  grad deploy support-router@latest
  grad deploy fast-diff-merge@2026-11-26-1 --name fast-diff-merge

Self-hosted servers have no hosted serving and exit with code 6; download the
artifact with `grad artifacts download NAME@latest --output DIR` and serve it
on vLLM or SGLang instead.")]
    Deploy(DeployArgs),

    /// Inspect and roll back deployments
    Deployments {
        #[command(subcommand)]
        action: DeploymentsCmd,
    },

    /// Ask a deployed router which model should answer a prompt
    Route(RouteArgs),

    /// Embed text with a deployed embedding artifact
    Embed {
        /// Deployed embedding model name
        #[arg(long)]
        model: String,
        /// Text to embed (repeat for several)
        #[arg(required = true)]
        input: Vec<String>,
    },

    /// Manage scoped workspace API keys
    Keys {
        #[command(subcommand)]
        action: KeysCmd,
    },

    /// Run a local grad stack with Docker Compose
    Local {
        #[command(subcommand)]
        action: LocalCmd,
    },
}

#[derive(Args, Debug)]
pub struct LoginArgs {
    /// Read the API key from the first line of stdin (or pass --api-key)
    #[arg(long)]
    pub api_key_stdin: bool,

    /// Save without checking the key against the server
    #[arg(long)]
    pub no_verify: bool,
}

#[derive(Subcommand, Debug)]
pub enum ConfigCmd {
    /// Print the resolved configuration (the key is masked)
    Show,
    /// Print the config file path
    Path,
}

#[derive(Subcommand, Debug)]
pub enum ModelsCmd {
    /// List the server's model catalog
    List {
        /// Only models that support this recipe
        #[arg(long, value_name = "RECIPE")]
        recipe: Option<String>,
    },
}

#[derive(Subcommand, Debug)]
pub enum DatasetsCmd {
    /// List datasets
    List {
        #[command(flatten)]
        page: PageArgs,
    },
    /// Show one dataset
    Get {
        /// Dataset name
        name: String,
    },
    /// Create an empty dataset
    Create {
        /// Dataset name
        name: String,
    },
    /// Push a JSONL file of records (streamed in batches; each batch appends a version)
    #[command(after_help = "Example:\n  grad datasets push support-sft ./train.jsonl")]
    Push {
        /// Dataset name (created if missing)
        name: String,
        /// JSONL file, one record per line
        file: PathBuf,
        /// Records per request
        #[arg(long, default_value_t = 1000)]
        batch_size: usize,
    },
    /// Print records of a dataset version
    Records {
        /// Dataset name
        name: String,
        /// Dataset version (default: latest)
        #[arg(long)]
        version: Option<u64>,
        #[command(flatten)]
        page: PageArgs,
    },
    /// Import a Hugging Face dataset (local files: `grad import`)
    Import {
        #[command(subcommand)]
        source: DatasetImportCmd,
    },
}

#[derive(Subcommand, Debug)]
pub enum DatasetImportCmd {
    /// Import a Hugging Face dataset (pulled by the trainer worker)
    #[command(after_help = "\
Example:
  grad datasets import hf HuggingFaceH4/ultrachat_200k --split train_sft --limit 2000 --name ultrachat")]
    Hf {
        /// Hugging Face repo (owner/name)
        repo: String,
        /// Target dataset name (default: the repo name)
        #[arg(long)]
        name: Option<String>,
        /// Split to import
        #[arg(long)]
        split: Option<String>,
        /// Dataset config/subset
        #[arg(long)]
        config: Option<String>,
        /// Git revision
        #[arg(long)]
        revision: Option<String>,
        /// Import at most this many rows
        #[arg(long)]
        limit: Option<i64>,
        /// Map a field to a column, e.g. --column prompt=question (repeatable)
        #[arg(long = "column", value_name = "FIELD=COLUMN")]
        columns: Vec<String>,
        #[command(flatten)]
        wait: ImportWaitArgs,
    },
}

#[derive(Args, Debug, Clone)]
pub struct ImportWaitArgs {
    /// Return as soon as the import job is queued
    #[arg(long)]
    pub no_wait: bool,
    /// Give up waiting after this many seconds (the job keeps running)
    #[arg(long, value_name = "SECS", default_value_t = 3600)]
    pub timeout: u64,
}

#[derive(Args, Debug)]
pub struct ImportArgs {
    /// File to upload (JSONL, JSON or Parquet)
    pub file: PathBuf,
    /// Target dataset (created if missing)
    #[arg(long)]
    pub dataset: String,
    /// File format (auto, jsonl, json, parquet) or parser name (otel, langfuse, ...)
    #[arg(long)]
    pub format: Option<String>,
    /// Parser name, when --format is the file format
    #[arg(long)]
    pub connector: Option<String>,
    #[command(flatten)]
    pub wait: ImportWaitArgs,
}

#[derive(Subcommand, Debug)]
pub enum ImportsCmd {
    /// List import jobs
    List {
        #[command(flatten)]
        page: PageArgs,
    },
    /// Show one import job
    Status {
        /// Import job id
        id: String,
    },
    /// Wait for an import job to finish
    Wait {
        /// Import job id
        id: String,
        /// Give up after this many seconds
        #[arg(long, value_name = "SECS", default_value_t = 3600)]
        timeout: u64,
    },
}

#[derive(Args, Debug)]
pub struct RenderArgs {
    /// Dataset name
    pub name: String,
    /// Base model whose chat template is used (default: server default)
    #[arg(long)]
    pub model: Option<String>,
    /// Which assistant turns are trained
    #[arg(long, value_parser = ["last", "all_assistant"])]
    pub train_on: Option<String>,
    /// Thinking mode
    #[arg(long, value_parser = ["auto", "on", "off"])]
    pub thinking: Option<String>,
    /// Records to render (1-20)
    #[arg(long, default_value_t = 3)]
    pub limit: i64,
}

#[derive(Args, Debug, Default)]
pub struct TrainArgs {
    /// Run config YAML (as written by `grad runs inspect RUN --yaml`)
    #[arg(short = 'f', long = "file", value_name = "FILE")]
    pub file: Option<PathBuf>,
    /// Dataset to train on
    #[arg(long)]
    pub dataset: Option<String>,
    /// Run name (also the artifact name)
    #[arg(long)]
    pub name: Option<String>,
    /// Recipe: sft, dpo, router, decision-model, cartridge, embedding
    #[arg(long)]
    pub recipe: Option<String>,
    /// Base model (default: the recipe's default)
    #[arg(long)]
    pub model: Option<String>,
    /// Router candidate models, comma-separated (default: discovered from the data)
    #[arg(long, value_delimiter = ',')]
    pub models: Option<Vec<String>>,
    /// Learning rate: "auto" or a number
    #[arg(long)]
    pub lr: Option<String>,
    /// Multiplier on the auto learning rate
    #[arg(long)]
    pub lr_scale: Option<f64>,
    /// Passes over the training split
    #[arg(long)]
    pub epochs: Option<u32>,
    /// Examples per optimizer step
    #[arg(long)]
    pub batch_size: Option<u32>,
    /// LoRA rank
    #[arg(long)]
    pub adapter_rank: Option<u32>,
    /// Which assistant turns are trained
    #[arg(long, value_parser = ["last", "all_assistant"])]
    pub train_on: Option<String>,
    /// Thinking mode for the chat template
    #[arg(long, value_parser = ["auto", "on", "off"])]
    pub thinking: Option<String>,
    /// DPO beta
    #[arg(long)]
    pub beta: Option<f64>,
    /// Router: largest acceptable quality drop vs. the fallback
    #[arg(long)]
    pub max_quality_drop: Option<f64>,
    /// Cartridge: file with the document to compress
    #[arg(long, value_name = "FILE")]
    pub context_file: Option<PathBuf>,
    /// Cartridge: number of trained prefix tokens
    #[arg(long)]
    pub num_tokens: Option<u32>,
    /// Held-out split strategy
    #[arg(long, value_parser = ["by_session", "by_group", "random"])]
    pub split: Option<String>,
    /// Fraction of records held out for eval
    #[arg(long)]
    pub eval_fraction: Option<f64>,
    /// Stop the run (status stopped_budget) once it has cost this much
    #[arg(long, value_name = "USD")]
    pub max_cost_usd: Option<f64>,
    /// Idempotency-Key: rerunning with the same key returns the run it created
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
    /// Set any recipe parameter, e.g. --set warmup=0.05 (repeatable)
    #[arg(long = "set", value_name = "KEY=VALUE")]
    pub set: Vec<String>,
    /// Only plan: resolve defaults and estimate cost ($0)
    #[arg(long)]
    pub dry_run: bool,
    /// Wait for the run, streaming live metrics
    #[arg(long)]
    pub wait: bool,
    /// Give up waiting after this many seconds (the run keeps going)
    #[arg(long, value_name = "SECS", default_value_t = 86_400)]
    pub timeout: u64,
}

#[derive(Subcommand, Debug)]
pub enum RunsCmd {
    /// List runs (newest first)
    List {
        #[command(flatten)]
        page: PageArgs,
    },
    /// Show a run; --yaml prints a config you can re-run with `grad train -f`
    #[command(
        after_help = "Example:\n  grad runs inspect run_01J9X --yaml > recipe.yaml\n  grad train -f recipe.yaml --dry-run"
    )]
    Inspect {
        /// Run id or run name
        run: String,
        /// Print the resolved run config as `grad train -f` YAML
        #[arg(long)]
        yaml: bool,
    },
    /// Print step metrics; --follow streams them live
    Logs {
        /// Run id or run name
        run: String,
        /// Stream new metrics until the run finishes
        #[arg(long, short = 'f')]
        follow: bool,
        /// Only steps after this one
        #[arg(long)]
        after_step: Option<i64>,
    },
    /// Wait for a run to finish
    Wait {
        /// Run id or run name
        run: String,
        /// Give up after this many seconds
        #[arg(long, value_name = "SECS", default_value_t = 86_400)]
        timeout: u64,
    },
    /// Cancel a run (a running attempt is stopped and billed)
    Cancel {
        /// Run id or run name
        run: String,
    },
    /// Resume a stopped, failed or cancelled run from its latest checkpoint
    Resume {
        /// Run id or run name
        run: String,
        /// New cost cap (needed to resume a stopped_budget run)
        #[arg(long, value_name = "USD")]
        max_cost_usd: Option<f64>,
        /// Wait for the resumed run, streaming metrics
        #[arg(long)]
        wait: bool,
    },
    /// List a run's checkpoints
    Checkpoints {
        /// Run id or run name
        run: String,
    },
    /// Promote a checkpoint into a new immutable artifact
    Promote {
        /// Checkpoint id
        checkpoint: String,
        /// Artifact name (default: the run name)
        #[arg(long)]
        name: Option<String>,
    },
}

#[derive(Args, Debug)]
pub struct EvalTop {
    #[command(subcommand)]
    pub action: Option<EvalCmd>,
    #[command(flatten)]
    pub run: EvalRunArgs,
}

#[derive(Args, Debug, Clone, Default)]
pub struct EvalRunArgs {
    /// Eval name
    #[arg(long)]
    pub name: Option<String>,
    /// Models to compare, comma-separated (catalog ids or NAME@VERSION artifacts)
    #[arg(long, value_delimiter = ',', required = true)]
    pub models: Vec<String>,
    /// Dataset of held-out tasks
    #[arg(long, required = true)]
    pub dataset: Option<String>,
    /// Pin a dataset version
    #[arg(long)]
    pub dataset_version: Option<i64>,
    /// Rubric file: YAML/JSON list of items (regex, validator, judge)
    #[arg(long, value_name = "FILE")]
    pub rubric: Option<PathBuf>,
    /// Model to report deltas against
    #[arg(long)]
    pub baseline: Option<String>,
    /// Samples per task
    #[arg(long)]
    pub samples: Option<i64>,
    /// Sampling temperature
    #[arg(long)]
    pub temperature: Option<f64>,
    /// Max new tokens per sample
    #[arg(long)]
    pub max_tokens: Option<i64>,
    /// Evaluate at most this many tasks
    #[arg(long)]
    pub limit: Option<i64>,
    /// Score at or above which a task passes
    #[arg(long)]
    pub pass_threshold: Option<f64>,
    /// Only estimate calls and cost
    #[arg(long)]
    pub dry_run: bool,
    /// Wait for the eval and print the summary table
    #[arg(long)]
    pub wait: bool,
    /// Give up waiting after this many seconds
    #[arg(long, value_name = "SECS", default_value_t = 86_400)]
    pub timeout: u64,
    /// Idempotency-Key: rerunning with the same key returns the eval it created
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum EvalCmd {
    /// Estimate tasks, model/judge calls and cost
    Plan(EvalRunArgs),
    /// Show an eval and its summary
    Status {
        /// Eval id
        id: String,
    },
    /// List evals
    List {
        #[command(flatten)]
        page: PageArgs,
    },
    /// Wait for an eval to finish
    Wait {
        /// Eval id
        id: String,
        /// Give up after this many seconds
        #[arg(long, value_name = "SECS", default_value_t = 86_400)]
        timeout: u64,
    },
    /// Per-task results
    Results {
        /// Eval id
        id: String,
        /// Only this model
        #[arg(long)]
        model: Option<String>,
        #[command(flatten)]
        page: PageArgs,
    },
    /// Failing tasks, for mining into a new dataset
    Failures {
        /// Eval id
        id: String,
        /// Only this model
        #[arg(long)]
        model: Option<String>,
        /// Score below which a task counts as failed (default: the eval's pass threshold)
        #[arg(long)]
        threshold: Option<f64>,
        #[command(flatten)]
        page: PageArgs,
    },
    /// Cancel a queued or running eval
    Cancel {
        /// Eval id
        id: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum ArtifactsCmd {
    /// List artifacts (newest first)
    List {
        /// Only artifacts with this name
        #[arg(long)]
        name: Option<String>,
        #[command(flatten)]
        page: PageArgs,
    },
    /// Show an artifact (id, NAME@VERSION or NAME@latest)
    Inspect {
        /// Artifact reference
        reference: String,
    },
    /// Download, verify and extract an artifact into a PEFT directory
    #[command(after_help = "\
Examples:
  grad artifacts download fast-diff-merge@latest --output ./fast-diff-merge
  vllm serve Qwen/Qwen3-8B --enable-lora --lora-modules fast-diff-merge=./fast-diff-merge
  grad artifacts download fast-diff-merge@latest --archive ./fast-diff-merge.grad.tar.gz

The bundle's SHA-256 is verified while streaming, and every file is checked
against the bundle manifest before the directory is moved into place.")]
    Download {
        /// Artifact reference (id, NAME@VERSION or NAME@latest)
        reference: String,
        /// Extract into this directory (must be new or empty unless --force)
        #[arg(long, short = 'o', value_name = "DIR")]
        output: Option<PathBuf>,
        /// Also (or only) keep the verified .grad.tar.gz here
        #[arg(long, visible_alias = "out", value_name = "FILE")]
        archive: Option<PathBuf>,
        /// Replace an existing output directory or archive
        #[arg(long)]
        force: bool,
    },
}

#[derive(Args, Debug)]
pub struct DeployArgs {
    /// Artifact reference (id, NAME@VERSION or NAME@latest)
    pub artifact: String,
    /// Deployment name (default: the artifact name)
    #[arg(long)]
    pub name: Option<String>,
    /// Fallback model for routers
    #[arg(long)]
    pub fallback: Option<String>,
    /// Fraction of router traffic explored (0.0-0.5)
    #[arg(long)]
    pub explore_rate: Option<f64>,
    /// Idempotency-Key: rerunning with the same key replays the first deploy
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum DeploymentsCmd {
    /// List deployments
    List {
        #[command(flatten)]
        page: PageArgs,
    },
    /// Show a deployment and its feedback summary
    Status {
        /// Deployment name
        name: String,
    },
    /// Roll back to the previous artifact
    Rollback {
        /// Deployment name
        name: String,
    },
}

#[derive(Args, Debug)]
pub struct RouteArgs {
    /// Deployed router name
    #[arg(long)]
    pub deployment: String,
    /// User prompt
    #[arg(
        long,
        conflicts_with = "messages",
        required_unless_present = "messages"
    )]
    pub prompt: Option<String>,
    /// JSON file with a list of chat messages
    #[arg(long, value_name = "FILE")]
    pub messages: Option<PathBuf>,
    /// Session id for sticky routing and feedback
    #[arg(long)]
    pub session_id: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum KeysCmd {
    /// List workspace API keys
    List {
        #[command(flatten)]
        page: PageArgs,
    },
    /// Create a scoped key (the secret is shown once)
    #[command(after_help = "\
Examples:
  grad keys create --name ci-nightly --scopes datasets:write,runs:write,artifacts:read
  grad keys create --name inference-cd --scopes artifacts:read

Scopes: admin, datasets:read, datasets:write, runs:read, runs:write,
artifacts:read, artifacts:write, deployments:write, feedback:write")]
    Create {
        /// Key name
        #[arg(long)]
        name: String,
        /// Comma-separated scopes
        #[arg(long, value_delimiter = ',', required = true)]
        scopes: Vec<String>,
    },
    /// Revoke a key
    Revoke {
        /// Key id
        id: String,
    },
}

#[derive(Args, Debug, Clone)]
pub struct ComposeArgs {
    /// Compose file to use instead of the one built into grad; repeat it to
    /// add override files (GRAD_COMPOSE_FILE takes a ':'-separated list)
    #[arg(
        long,
        short = 'f',
        env = "GRAD_COMPOSE_FILE",
        value_name = "FILE",
        value_delimiter = ':'
    )]
    pub file: Vec<PathBuf>,
    /// Compose project name
    #[arg(long, env = "COMPOSE_PROJECT_NAME", default_value = "grad-local")]
    pub project_name: String,
}

#[derive(Subcommand, Debug)]
pub enum LocalCmd {
    /// Start the API, Postgres and a trainer worker on 127.0.0.1
    #[command(after_help = "\
Examples:
  grad local up
  grad local up --gpu
  grad local up --build          # build images from a source checkout

First run generates an admin key and a trainer key and saves them in the
'local' profile, so the local server runs with authentication on.")]
    Up {
        #[command(flatten)]
        compose: ComposeArgs,
        /// Add the CUDA trainer worker (needs the NVIDIA Container Toolkit)
        #[arg(long)]
        gpu: bool,
        /// Build images from this source checkout instead of pulling them
        #[arg(long)]
        build: bool,
        /// Loopback port for the API
        #[arg(long, env = "GRAD_PORT", default_value_t = 8787)]
        port: u16,
        /// Do not wait for the API to become healthy
        #[arg(long)]
        no_wait: bool,
        /// Seconds to wait for the API to become healthy
        #[arg(long, value_name = "SECS", default_value_t = 180)]
        timeout: u64,
    },
    /// Stop the stack (keeps data unless --volumes)
    Down {
        #[command(flatten)]
        compose: ComposeArgs,
        /// Also delete the database and stored artifacts
        #[arg(long, short = 'v')]
        volumes: bool,
    },
    /// Show container status and API health
    Status {
        #[command(flatten)]
        compose: ComposeArgs,
    },
    /// Print container logs
    Logs {
        #[command(flatten)]
        compose: ComposeArgs,
        /// Only this service (grad-server, grad-trainer, postgres)
        service: Option<String>,
        /// Follow log output
        #[arg(long)]
        follow: bool,
        /// Lines from the end of each log
        #[arg(long, default_value = "200")]
        tail: String,
    },
    /// Delete all local data and keys, then start fresh with `grad local up`
    Reset {
        #[command(flatten)]
        compose: ComposeArgs,
        /// Do not ask for confirmation
        #[arg(long, short = 'y')]
        yes: bool,
    },
}

#[derive(Args, Debug, Clone, Default)]
pub struct PageArgs {
    /// Maximum items
    #[arg(long)]
    pub limit: Option<u32>,
    /// Cursor from a previous page (`next_cursor`)
    #[arg(long)]
    pub cursor: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use clap::CommandFactory;

    fn walk(cmd: &clap::Command, path: &str, missing: &mut Vec<String>) {
        for arg in cmd.get_arguments() {
            if arg.is_hide_set() || matches!(arg.get_id().as_str(), "help" | "version") {
                continue;
            }
            if arg.get_help().is_none() {
                missing.push(format!("{} --{}", path, arg.get_id()));
            }
        }
        for sub in cmd.get_subcommands() {
            if sub.is_hide_set() || sub.get_name() == "help" {
                continue;
            }
            let p = format!("{} {}", path, sub.get_name());
            if sub.get_about().is_none() {
                missing.push(p.clone());
            }
            walk(sub, &p, missing);
        }
    }

    #[test]
    fn every_command_and_flag_has_help() {
        let cmd = Cli::command();
        cmd.clone().debug_assert();
        let mut missing = Vec::new();
        walk(&cmd, "grad", &mut missing);
        assert!(missing.is_empty(), "missing help: {:#?}", missing);
    }
}
