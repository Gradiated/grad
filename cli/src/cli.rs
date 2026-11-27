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
  6    capability unavailable on this server (inference_unavailable, secrets_unavailable)
  7    run, eval or import finished unsuccessfully (failed, cancelled; runs also stopped_budget, stopped_balance)
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
  grad artifacts download support-router@latest --output ./support-router
";

#[derive(Parser, Debug)]
#[command(
    name = "grad",
    version,
    about = "Train, evaluate and download models on Gradiated (Cloud or self-hosted)",
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

    /// Follow runs with plain lines instead of the full-screen view
    #[arg(
        long,
        global = true,
        env = "GRAD_NO_TUI",
        value_parser = clap::builder::FalseyValueParser::new(),
        help_heading = "Global options"
    )]
    pub plain: bool,
}

#[derive(Subcommand, Debug)]
pub enum Command {
    /// Save an API key for this machine (validated against the server)
    #[command(after_help = "\
Examples:
  grad login                                   # prompts for the key
  grad login --api-key \"$KEY\"
  echo \"$KEY\" | grad login --api-key-stdin
  grad login --base-url http://127.0.0.1:18787 --profile local

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

    /// List, inspect, download, upload, import and delete immutable artifacts
    Artifacts {
        #[command(subcommand)]
        action: ArtifactsCmd,
    },

    /// Manage scoped workspace API keys
    Keys {
        #[command(subcommand)]
        action: KeysCmd,
    },

    /// Billed usage: totals, kinds and top runs and evals for a period, or `list` for the rows
    #[command(
        args_conflicts_with_subcommands = true,
        after_help = "\
Examples:
  grad usage                                   # this UTC month
  grad usage --from 2026-11-01 --to 2026-11-15
  grad usage --by day
  grad usage --by model --from 2026-10-01 --json
  grad usage list --run support-sft
  grad usage list --kind eval --from 2026-11-01 --limit 20

Periods are UTC. --from is inclusive; --to YYYY-MM-DD covers that whole day, and
an ISO 8601 timestamp (2026-11-01T09:30:00Z) is exclusive. The default period is
the current calendar month. Kinds: training (runs), eval, scoring
(datasets score), labeling (a router run's labeling eval) and teacher (an
off-policy distill run's teacher answers)."
    )]
    Usage(UsageTop),

    /// Store provider keys and tokens as write-only workspace secrets
    #[command(after_help = "\
Examples:
  grad secrets set langfuse-prod            # paste the value, then Ctrl-D
  printf '%s' \"$LANGFUSE_KEYS\" | grad secrets set langfuse-prod
  printf '%s' \"$KEYS\" | grad secrets set langfuse-self --allowed-host langfuse.internal:3000
  grad secrets list
  grad secrets delete langfuse-prod

Values are read from stdin, encrypted at rest and never returned. The server
sends a secret only to its allowed hosts: by default the public provider hosts;
a secret for a self-hosted tool names its host with --allowed-host.")]
    Secrets {
        #[command(subcommand)]
        action: SecretsCmd,
    },

    /// Sync traces and feedback from an observability tool into a dataset
    #[command(after_help = "\
Examples:
  grad sources add langfuse --dataset support-prod \\
    --host https://cloud.langfuse.com --secret langfuse-prod --schedule \"*/15 * * * *\"
  grad sources add gradiated --dataset support-prod --schedule \"0 * * * *\"
  grad sources list
  grad sources sync src_01J9X --wait
  grad sources sync src_01J9X --full     # rebuild the dataset as a new version

Providers: langfuse, langsmith, braintrust, posthog, phoenix, gradiated (Cloud).
braintrust and posthog need --project.

A source feeds exactly one dataset; a dataset can have several sources.
Deleting the dataset deletes its sources. A source starts at most one sync a
minute (schedules have minute resolution). A failed sync shows in the status
and last error columns of `grad sources list` and backs the schedule off
(twice the interval per failure, at most an hour); after 10 failures in a row
the source is paused. `grad sources sync ID` or `grad secrets set NAME` (a new
key) resumes it.")]
    Sources {
        #[command(subcommand)]
        action: SourcesCmd,
    },

    /// Open the web UI in a browser, signed in with this profile's key
    #[command(after_help = "\
Examples:
  grad ui                         # runs list on the configured server
  grad ui run_01J9X               # one run's page
  grad --profile local ui         # the stack from `grad local up`
  grad ui --no-open               # print the URL (without the key)

The key is handed over once in the URL fragment, which browsers never send to
the server; the page keeps it in that tab's sessionStorage only. BROWSER
overrides the browser command.")]
    Ui(UiArgs),

    /// Run a local grad stack with Docker Compose
    Local {
        #[command(subcommand)]
        action: LocalCmd,
    },
}

#[derive(Args, Debug)]
pub struct UiArgs {
    /// Open this run's page instead of the runs list
    #[arg(value_name = "RUN_ID")]
    pub run: Option<String>,

    /// Print the URL instead of opening a browser
    #[arg(long)]
    pub no_open: bool,
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
    /// Score each record's own answer with a rubric (billed like an eval); the scores become the next version
    #[command(after_help = "\
Records that already have every score are skipped. Rubric files hold regex, validator and judge
items (code scorers need an SDK). Example:
  grad datasets score support-prod --rubric ./judge.yaml --wait")]
    Score {
        /// Dataset name
        name: String,
        /// Rubric file: YAML/JSON list of items (regex, validator, judge)
        #[arg(long, value_name = "FILE")]
        rubric: PathBuf,
        /// Dataset version to score (default: latest)
        #[arg(long)]
        version: Option<i64>,
        /// Scoring job name (default: <dataset>-score)
        #[arg(long = "job-name")]
        job_name: Option<String>,
        /// Score at most this many records
        #[arg(long)]
        limit: Option<i64>,
        /// Wait until the scores are in the dataset
        #[arg(long)]
        wait: bool,
        /// Give up waiting after this many seconds
        #[arg(long, value_name = "SECS", default_value_t = 86_400)]
        timeout: u64,
        /// Idempotency-Key: rerunning with the same key returns the job it created
        #[arg(long, value_name = "KEY")]
        idempotency_key: Option<String>,
    },
    /// Save a filtered view of a dataset (server-side; re-running costs nothing)
    #[command(after_help = "\
Example:
  grad datasets filter support-prod --score 'resolved>=0.8' --created-after 2026-11-01")]
    Filter {
        /// Dataset name
        name: String,
        /// Score condition NAME<OP>VALUE with OP one of >=, <=, >, <, ==, != (repeatable)
        #[arg(long = "score", value_name = "COND")]
        scores: Vec<String>,
        /// Exact metadata match KEY=VALUE (repeatable)
        #[arg(long = "metadata", value_name = "KEY=VALUE")]
        metadata: Vec<String>,
        /// Records whose timestamp is at or after this time (RFC 3339 or YYYY-MM-DD)
        #[arg(long)]
        created_after: Option<String>,
        /// Records whose timestamp is before this time
        #[arg(long)]
        created_before: Option<String>,
        /// Keep only these record ids, comma-separated
        #[arg(long, value_delimiter = ',')]
        ids: Vec<String>,
        /// Source version (default: latest)
        #[arg(long)]
        version: Option<i64>,
        /// View name (default: <dataset>-f-<hash of the filter>)
        #[arg(long)]
        view: Option<String>,
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
        /// Workspace secret holding a Hugging Face token (gated or private datasets)
        #[arg(long, value_name = "NAME")]
        secret: Option<String>,
        #[command(flatten)]
        wait: ImportWaitArgs,
    },
    /// Import a built-in benchmark at a pinned revision (evals on it default to its answer check)
    #[command(after_help = "\
Benchmarks: gsm8k, mmlu, mmlu_pro, arc_challenge. Example:
  grad datasets import benchmark gsm8k --limit 200")]
    Benchmark {
        /// gsm8k, mmlu, mmlu_pro or arc_challenge
        benchmark: String,
        /// Import the first N problems (the same ones every time)
        #[arg(long)]
        limit: Option<i64>,
        /// Target dataset name (default: <benchmark>-<limit>, or <benchmark>)
        #[arg(long)]
        name: Option<String>,
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
#[command(allow_negative_numbers = true)]
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
    /// Recipe: sft, dpo, router, decision-model, cartridge, embedding, distill, reward-model
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
    /// Cartridge: file with the document to compress (distill: a document only the teacher reads)
    #[arg(long, value_name = "FILE")]
    pub context_file: Option<PathBuf>,
    /// Distill and cartridge: the model to learn from (distill off-policy also takes NAME@VERSION)
    #[arg(long)]
    pub teacher: Option<String>,
    /// Distill: on-policy (the student writes, the teacher scores) or off-policy (train on the teacher's answers)
    #[arg(long, value_parser = ["on-policy", "off-policy"])]
    pub rollout: Option<String>,
    /// Distill: longest answer per prompt (on-policy default: sized from your records)
    #[arg(long, requires = "rollout")]
    pub max_new_tokens: Option<u32>,
    /// Reward model: a score name in [0, 1] on your records to also train pointwise
    #[arg(long, value_name = "SCORE", conflicts_with = "rubric")]
    pub score: Option<String>,
    /// Router, decision, reward: a score name already on your records (`resolved`),
    /// or a YAML/JSON rubric file (judges and validators; see `grad eval --rubric`)
    #[arg(long, value_name = "NAME|FILE")]
    pub rubric: Option<String>,
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
    /// Follow a run live: full-screen on a terminal, plain lines otherwise
    #[command(after_help = "\
Keys: q detach (the run keeps going), c cancel, l event log, ? help.
Use --plain or GRAD_NO_TUI=1 for line output.")]
    Watch {
        /// Run id or run name
        run: String,
        /// Give up after this many seconds
        #[arg(long, value_name = "SECS", default_value_t = 86_400)]
        timeout: u64,
    },
    /// Print a run's lifecycle events (phases, metrics, checkpoints, attempts, warnings); --follow streams them
    Events {
        /// Run id or run name
        run: String,
        /// Stream new events until the run finishes
        #[arg(long, short = 'f')]
        follow: bool,
        /// Events per page (without --follow)
        #[arg(long)]
        limit: Option<i64>,
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
        /// Run id or run name (a name must match one queued or running run)
        run: String,
        /// When several active runs share the name, cancel the newest
        #[arg(long)]
        latest: bool,
    },
    /// Resume a stopped, failed or cancelled run from its latest checkpoint
    Resume {
        /// Run id or run name (a name must match one resumable run)
        run: String,
        /// When several resumable runs share the name, resume the newest
        #[arg(long)]
        latest: bool,
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
pub struct UsageTop {
    #[command(subcommand)]
    pub action: Option<UsageCmd>,
    #[command(flatten)]
    pub summary: UsageSummaryArgs,
}

#[derive(Args, Debug, Clone, Default)]
pub struct UsagePeriodArgs {
    /// Start of the period, inclusive (UTC): YYYY-MM-DD or an ISO 8601 timestamp
    #[arg(long, value_name = "DATE")]
    pub from: Option<String>,
    /// End of the period (UTC): YYYY-MM-DD covers that whole day; a timestamp is exclusive
    #[arg(long, value_name = "DATE")]
    pub to: Option<String>,
}

#[derive(Args, Debug, Clone, Default)]
pub struct UsageSummaryArgs {
    #[command(flatten)]
    pub period: UsagePeriodArgs,
    /// Print one table grouped this way
    #[arg(long, value_parser = ["day", "week", "month", "model", "recipe", "kind"])]
    pub by: Option<String>,
}

#[derive(Subcommand, Debug)]
pub enum UsageCmd {
    /// List billed rows, newest first: one per billed increment of a run or eval attempt
    #[command(after_help = "\
Examples:
  grad usage list
  grad usage list --run support-sft --from 2026-11-01
  grad usage list --eval eval_01J... --json
  grad usage list --kind labeling --limit 50

--run takes a run id or name and also lists the evals the run started
(labeling, teacher answers, checkpoint evals). A name several runs or evals
share resolves to the newest, with a warning saying how many matched.")]
    List(UsageListArgs),
}

#[derive(Args, Debug, Clone, Default)]
pub struct UsageListArgs {
    #[command(flatten)]
    pub period: UsagePeriodArgs,
    /// Only this run's usage: a run id or name
    #[arg(long)]
    pub run: Option<String>,
    /// Only this eval's usage: an eval id or name
    #[arg(long)]
    pub eval: Option<String>,
    /// Only this kind
    #[arg(long, value_parser = ["training", "eval", "scoring", "labeling", "teacher"])]
    pub kind: Option<String>,
    #[command(flatten)]
    pub page: PageArgs,
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
  grad artifacts download fast-diff-merge@latest --url    # a presigned URL, valid 15 minutes

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
        /// Print a presigned URL of the bundle (valid 15 minutes) instead of downloading
        #[arg(long, conflicts_with_all = ["output", "archive", "force"])]
        url: bool,
    },
    /// Register local weights as an artifact (validated against the format spec)
    #[command(after_help = "\
Examples:
  grad artifacts upload ./my-lora --base qwen/qwen3-8b
  grad artifacts upload ./cartridge.safetensors --base qwen/qwen3-8b --format cartridge --name support-kb

PATH is a directory (tarred), a single file or a .tar.gz. An import worker
checks the files against docs/ARTIFACT_FORMATS.md and the base model's
config.json; for a PEFT LoRA that is adapter_config.json, the base model and
revision, the target modules and every tensor shape. A failure names the file
and exits with code 5. The result is a normal artifact: download it, evaluate
it, or continue training from it with --model NAME@VERSION.")]
    Upload {
        /// Directory, file or .tar.gz with the artifact's files
        path: PathBuf,
        #[command(flatten)]
        import: ArtifactImportArgs,
    },
    /// Import weights from the Hugging Face Hub (hf://owner/name[@revision])
    #[command(after_help = "\
Examples:
  grad artifacts import hf://acme/support-lora --base qwen/qwen3-8b
  grad artifacts import hf://acme/support-lora@v2 --base qwen/qwen3-8b --secret hf-token

The same checks as `grad artifacts upload`; the artifact pins the commit the
revision resolved to (its provenance uri).")]
    Import {
        /// hf://owner/name or hf://owner/name@revision
        uri: String,
        #[command(flatten)]
        import: ArtifactImportArgs,
        /// Workspace secret holding an HF token (gated or private repos)
        #[arg(long)]
        secret: Option<String>,
    },
    /// Delete an artifact and its bundle (refused while a published model version pins it)
    Delete {
        /// Artifact reference (NAME@VERSION or NAME@latest)
        reference: String,
    },
}

#[derive(Args, Debug)]
pub struct ArtifactImportArgs {
    /// The catalog base model the weights were trained on (`grad models`)
    #[arg(long)]
    pub base: String,
    /// peft_lora, merged_safetensors, cartridge, encoder_safetensors, router_bundle, decision_bundle or reward_bundle
    #[arg(long, default_value = "peft_lora")]
    pub format: String,
    /// Artifact name (default: the directory, file or repo name)
    #[arg(long)]
    pub name: Option<String>,
    /// Idempotency-Key: rerunning with the same key replays the first import
    #[arg(long, value_name = "KEY")]
    pub idempotency_key: Option<String>,
    #[command(flatten)]
    pub wait: ImportWaitArgs,
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
artifacts:read, artifacts:write, artifacts:pin, secrets:read, secrets:write,
sources:read, sources:write, deployments:write")]
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

#[derive(Subcommand, Debug)]
pub enum SecretsCmd {
    /// Create or replace a secret; the value is read from stdin
    Set {
        /// Secret name (lowercase letters, digits, '.', '_', '-')
        name: String,
        /// A host the server may send the secret to (repeatable; default: the
        /// public provider hosts). Replacing a secret replaces its hosts.
        #[arg(long = "allowed-host", value_name = "HOST")]
        allowed_hosts: Vec<String>,
    },
    /// List secret names (values are never shown)
    List {
        #[command(flatten)]
        page: PageArgs,
    },
    /// Delete a secret (fails while a source uses it)
    Delete {
        /// Secret name
        name: String,
    },
}

#[derive(Subcommand, Debug)]
pub enum SourcesCmd {
    /// Connect a provider to a dataset
    Add {
        /// langfuse, langsmith, braintrust, posthog, phoenix or gradiated
        provider: String,
        /// Dataset to sync into (created if missing); a source feeds one dataset
        #[arg(long)]
        dataset: String,
        /// Provider API host (default: the provider's public host)
        #[arg(long)]
        host: Option<String>,
        /// Workspace secret holding the provider key (`grad secrets set NAME`)
        #[arg(long, value_name = "NAME")]
        secret: Option<String>,
        /// Provider project (required for braintrust and posthog)
        #[arg(long)]
        project: Option<String>,
        /// Five-field UTC cron (at most once a minute); without it the source syncs only on request
        #[arg(long, value_name = "CRON")]
        schedule: Option<String>,
        /// Filter KEY=VALUE (VALUE may be JSON; repeatable): tags, environment, model,
        /// version, release, name, user_id, session_id, metadata, from, to, has_feedback,
        /// min_score (langsmith also filter)
        #[arg(long = "filter", value_name = "KEY=VALUE")]
        filters: Vec<String>,
        #[command(flatten)]
        limits: SourceLimitArgs,
        /// Reuse this key when retrying, so the source is created once
        #[arg(long, value_name = "KEY")]
        idempotency_key: Option<String>,
    },
    /// Show a source: its effective filters, sampling, caps and last sync
    Show {
        /// Source id
        id: String,
    },
    /// Change a source's filters, sampling, caps or schedule (from its next sync)
    Update {
        /// Source id
        id: String,
        /// Replace the filters with these KEY=VALUE pairs (repeatable)
        #[arg(
            long = "filter",
            value_name = "KEY=VALUE",
            conflicts_with = "clear_filters"
        )]
        filters: Vec<String>,
        /// Remove every filter
        #[arg(long)]
        clear_filters: bool,
        /// Five-field UTC cron (at most once a minute)
        #[arg(long, value_name = "CRON", conflicts_with = "no_schedule")]
        schedule: Option<String>,
        /// Sync only on request from now on
        #[arg(long)]
        no_schedule: bool,
        #[command(flatten)]
        limits: SourceLimitArgs,
    },
    /// List sources with their status and last error
    List {
        /// Only this dataset's sources
        #[arg(long)]
        dataset: Option<String>,
        #[command(flatten)]
        page: PageArgs,
    },
    /// Sync a source now (returns the running sync if one is in progress; resumes a paused source)
    Sync {
        /// Source id
        id: String,
        /// Rebuild the dataset from the provider as a new version
        #[arg(long)]
        full: bool,
        /// Wait for the sync to finish
        #[arg(long)]
        wait: bool,
        /// Give up waiting after this many seconds (the sync keeps running)
        #[arg(long, value_name = "SECS", default_value_t = 3600)]
        timeout: u64,
    },
    /// Disconnect a source (its dataset and versions stay)
    Remove {
        /// Source id
        id: String,
    },
}

/// A source's sampling and record caps (`grad sources add` / `update`).
#[derive(Args, Debug, Clone, Default)]
pub struct SourceLimitArgs {
    /// Sync this share of traces, in (0, 1], chosen by trace id (re-syncs keep the same sample)
    #[arg(long, value_name = "RATE")]
    pub sample_rate: Option<f64>,
    /// At most N new traces per sync (`update`: 0 removes the cap)
    #[arg(long, value_name = "N")]
    pub max_records_per_sync: Option<u64>,
    /// At most N new traces per UTC day (`update`: 0 removes the cap)
    #[arg(long, value_name = "N")]
    pub max_records_per_day: Option<u64>,
    /// Seconds between the dataset versions scheduled syncs commit (default 900; 0: every sync)
    #[arg(long, value_name = "SECS")]
    pub version_interval: Option<u64>,
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
  grad local up --observability  # plus Prometheus and Grafana dashboards
  grad local up --build          # build images from a source checkout
  grad local up --dev-models     # tiny test models: train end to end on a laptop in seconds

First run generates an admin key, a trainer key and the workspace-secrets
key and saves them in the 'local' profile, so the local server runs with
authentication on.

Ports: the API and web UI on 127.0.0.1:18787, Grafana on 18788 and Prometheus
on 18789. A busy one moves to a free port in 18790-18809 (one line says so);
the choice is saved, so later runs keep the same URLs, and the 'local'
profile follows it. `grad local status` prints the real URLs.")]
    Up {
        #[command(flatten)]
        compose: ComposeArgs,
        /// Add the CUDA trainer worker (needs the NVIDIA Container Toolkit)
        #[arg(long)]
        gpu: bool,
        /// Add Prometheus and Grafana with the grad dashboards (loopback only;
        /// GRAD_GRAFANA_PORT, default 18788, and GRAD_PROMETHEUS_PORT, default 18789)
        #[arg(long)]
        observability: bool,
        /// Build images from this source checkout instead of pulling them
        #[arg(long)]
        build: bool,
        /// Also register tiny, randomly initialised test models (test/tiny-qwen3,
        /// test/tiny-qwen3-teacher, test/tiny-bert) that train in seconds on a CPU.
        /// For trying the workflow only: their artifacts are marked test_only
        #[arg(long)]
        dev_models: bool,
        /// Tag of the published images to pull (default: this binary's version for a
        /// release build, `main` for a source build; see SELF_HOSTING.md)
        #[arg(long, value_name = "TAG", conflicts_with = "build")]
        image_tag: Option<String>,
        /// Loopback port for the API and web UI (default 18787, or the port the
        /// last `up` chose; a busy default falls back to a free port, a busy
        /// --port fails)
        #[arg(long, env = "GRAD_PORT")]
        port: Option<u16>,
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
    /// Show container status, API health and the API, UI, Grafana and Prometheus URLs
    Status {
        #[command(flatten)]
        compose: ComposeArgs,
    },
    /// Print container logs
    Logs {
        #[command(flatten)]
        compose: ComposeArgs,
        /// Only this service (grad-server, grad-eval-worker, grad-trainer, postgres)
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
