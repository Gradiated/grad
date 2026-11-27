//! `grad`: the Gradiated command-line interface.
#![allow(clippy::result_large_err)]

mod cli;
mod commands;
mod local;
mod output;
mod trainfile;

use clap::Parser;
use std::process::ExitCode;

use cli::{Cli, Command};
use commands::Ctx;
use output::{print_error, CliError, CliResult, Out};

async fn dispatch(cli: Cli, ctx: &Ctx) -> CliResult {
    use commands::*;
    match cli.command {
        Command::Login(a) => auth::login(ctx, a).await,
        Command::Logout => auth::logout(ctx),
        Command::Config { action } => auth::config(ctx, action),
        Command::Models { action } => data::models(ctx, action).await,
        Command::Datasets { action } => data::datasets(ctx, action).await,
        Command::Import(a) => data::import(ctx, a).await,
        Command::Imports { action } => data::imports(ctx, action).await,
        Command::Render(a) => data::render(ctx, a).await,
        Command::Train(a) => train::train(ctx, a).await,
        Command::Runs { action } => train::runs(ctx, action).await,
        Command::Eval(a) => eval::eval(ctx, a).await,
        Command::Artifacts { action } => serve::artifacts(ctx, action).await,
        Command::Deploy(a) => serve::deploy(ctx, a).await,
        Command::Deployments { action } => serve::deployments(ctx, action).await,
        Command::Rollback { name } => serve::rollback(ctx, &name).await,
        Command::Route(a) => serve::route(ctx, a).await,
        Command::Embed { model, input } => serve::embed(ctx, &model, input).await,
        Command::Keys { action } => auth::keys(ctx, action).await,
        Command::Env { action } => envserve::env(ctx, action).await,
        Command::Local { action } => local::local(ctx, action).await,
        Command::Secrets { .. } => Err(not_in_v0(
            "grad secrets",
            "the server stores no third-party credentials in v0 (they arrive with observability sources)",
            "Keep provider keys in your own environment, export traces with them, then load the file with `grad import FILE --dataset NAME`.",
        )),
        Command::Sources { .. } => Err(not_in_v0(
            "grad sources",
            "syncing traces from Langfuse or other observability tools is post-v0",
            "Export the traces to a file (Langfuse, LangSmith, OpenTelemetry/OpenInference, OpenAI or Anthropic logs) and load it with `grad import FILE --dataset NAME`; the format is detected for you.",
        )),
    }
}

fn not_in_v0(cmd: &str, why: &str, hint: &str) -> CliError {
    CliError::new(
        output::EXIT_USAGE,
        "not_available",
        format!("`{cmd}` is not available in v0: {why}."),
    )
    .hint(hint)
}

#[tokio::main]
async fn main() -> ExitCode {
    let argv: Vec<String> = std::env::args().collect();
    let json_requested = argv.iter().any(|a| a == "--json");
    let cli = match Cli::try_parse_from(&argv) {
        Ok(c) => c,
        Err(e) => {
            use clap::error::ErrorKind;
            if matches!(
                e.kind(),
                ErrorKind::DisplayHelp
                    | ErrorKind::DisplayVersion
                    | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
            ) {
                let _ = e.print();
                let code = if matches!(
                    e.kind(),
                    ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand
                ) {
                    output::EXIT_USAGE
                } else {
                    0
                };
                return ExitCode::from(code as u8);
            }
            if json_requested {
                let msg = e.render().to_string();
                let first = msg
                    .lines()
                    .next()
                    .unwrap_or("")
                    .trim_start_matches("error: ")
                    .to_string();
                print_error(
                    &CliError::usage(first).hint("Run with --help for usage."),
                    true,
                );
                return ExitCode::from(output::EXIT_USAGE as u8);
            }
            let _ = e.print();
            return ExitCode::from(output::EXIT_USAGE as u8);
        }
    };
    let json = cli.global.json;
    let ctx = Ctx::new(cli.global.clone(), Out::new(json));
    let result = tokio::select! {
        r = dispatch(cli, &ctx) => r,
        _ = tokio::signal::ctrl_c() => {
            let msg = commands::interrupt_message().unwrap_or_else(|| "interrupted".into());
            Err(CliError::interrupted(msg))
        }
    };
    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            print_error(&e, json);
            ExitCode::from(e.exit.clamp(0, 255) as u8)
        }
    }
}
