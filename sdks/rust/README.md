# grad-sdk (Rust)

Rust SDK for the Gradiated training platform: push datasets, preview and launch fine-tuning runs,
follow them as typed events, evaluate models, and download or upload artifacts. Async on tokio
(`reqwest` with rustls); the crate is `grad-sdk`, imported as `grad`. The `grad` CLI is built on it.

```sh
cargo add grad-sdk serde_json
cargo add tokio --features macros,rt-multi-thread
grad local up --dev-models        # a server on this machine with tiny CPU test models (brew install gradiated/tap/grad)
export GRADIATED_PROFILE=local    # or GRADIATED_BASE_URL + GRADIATED_API_KEY for your own server
```

## Quickstart

```rust,no_run
use grad::{Client, DownloadOptions, PlanRunRequest, RecipeKind, RecipeSpec, WaitOptions};
use serde_json::json;

#[tokio::main]
async fn main() -> grad::Result<()> {
    let client = Client::new(); // GRADIATED_PROFILE, else GRADIATED_API_KEY and GRADIATED_BASE_URL, else `grad login`
    client.datasets().push("sql-quickstart", &[
        json!({"messages": [{"role": "user", "content": "Count active users."}, {"role": "assistant", "content": "SELECT count(*) FROM users WHERE active;"}]}),
        json!({"messages": [{"role": "user", "content": "Revenue by plan."}, {"role": "assistant", "content": "SELECT plan, sum(amount_usd) FROM invoices GROUP BY plan;"}]}),
    ]).await?;
    let recipe = RecipeSpec::new(RecipeKind::Sft).model("test/tiny-qwen3"); // a dev model; on a GPU server e.g. "qwen/qwen3-8b"
    let req = PlanRunRequest::new("sql-quickstart", "sql-helper", recipe).max_cost_usd(5.0);
    let plan = client.runs().plan(&req).await?; // $0 preview: defaults, warnings, cost
    println!("~${:.4} for {} steps, {} warnings", plan.estimated_cost_usd, plan.estimated_steps, plan.warnings.len());
    let run = client.runs().create(&req, None).await?;
    let run = client.runs().wait(&run.id, &WaitOptions::default()).await?;
    println!("{} {}", run.status, run.artifact_id.clone().unwrap_or_default()); // completed sql-helper@2026-11-28-1
    let dir = DownloadOptions::extract("./sql-helper"); // the PEFT adapter, verified against its SHA-256
    client.artifacts().download("sql-helper@latest", &dir).await?;
    Ok(())
}
```

`cargo test` compiles this block (the README is the crate's documentation); the CLI's live suite
runs the same flow against a real server. `test/tiny-qwen3` has random weights, so its adapter is
for trying the workflow; the same code on a GPU server with a real base model trains a real one.

## Following a run

`client.runs().events(id, true)` is a `RunEventStream` of typed `RunEvent`s (phase, metric,
checkpoint, attempt, warning, log, completed). It reconnects with `Last-Event-ID` behind the
scenes, never repeats an event and ends after `completed`; `wait_with_events` waits with a
callback. Without `follow` it pages the events stored so far.

```rust,no_run
# async fn f(client: &grad::Client) -> grad::Result<()> {
let mut events = client.runs().events("run_123", true);
while let Some(ev) = events.next().await {
    match ev? {
        grad::RunEvent::Metric(m) => println!("step {} loss {}", m.step, m.metric.loss),
        grad::RunEvent::Attempt(a) => println!("{}", a.message),
        _ => {}
    }
}
# Ok(()) }
```

## Configuration, retries and errors

The same precedence as every SDK and the CLI: builder arguments, the selected profile
(`GRADIATED_PROFILE`), `GRADIATED_API_KEY`/`GRADIATED_BASE_URL`, the `default` profile written by
`grad login`, then `https://api.gradiated.com`. A key saved in a profile is only sent to that
profile's server. Requests time out after 60 s per attempt (downloads, uploads and event streams
only have connect and read-idle timeouts) and retry twice with backoff and jitter: GET, PUT and
DELETE on 408, 429 and 5xx, and every public POST too, because it carries one `Idempotency-Key`
across its retries. A `Retry-After` above 60 s, and a `429 queue_limit`, return at once.

Every call returns `grad::Result<T>`; `grad::Error` has one variant per problem
(`Authentication`, `PermissionDenied`, `NotFound`, `Conflict`, `Validation`, `RateLimit`,
`QueueLimit`, `FeatureUnavailable`, `InferenceUnavailable`, `Server`, `Connection`, `Timeout`,
...), each carrying the server's `code`, `detail` and `request_id`.
