# Changelog

All notable changes to `grad` are recorded here. Every package in the repo (server, trainer,
Helm chart, the four SDKs and the CLI) shares one version, and the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). `grad` uses
[Semantic Versioning](https://semver.org/); until 1.0, a minor release may break the API.

## Unreleased

- **Server at scale** (measured with 1k workspaces, 100k runs, 10M job events, a 1M-record dataset, 200
  workers and 5,000 event streams): every open run event stream leaked memory until the API ran out (upstream
  `@hono/node-server` bug, now 2.1.11); run plans, eval plans and dataset filters no longer load a whole dataset
  version (a plan on more than 100k records is estimated from a spread sample and says so); a push, import or
  source sync indexes only the new parts instead of the whole dataset, and parts are (de)compressed off the event
  loop; idle workers polling a queue they can't take from no longer contend on the claim lock or the database
  pool; the waiting-for-compute and job-event retention sweeps keep up with 100k queued runs and thousands of
  events a second; each run event is serialized once for all its streams; migration 0011 adds the indexes that
  workspace purges and `GET /v1/usage?run_id=` were missing, and the usage reports skip Postgres JIT.
- **SDKs: one name per verb.** `sources.delete` (Python, TS), `Sources.Delete` (Go) and `sources().delete` (Rust)
  replace `remove`, which stays as a deprecated alias (it shipped in 0.2.0-alpha.7); `grad sources delete` is the
  CLI verb and `remove` its alias. **Breaking (Go):** `Runs.Resume(ctx, id, grad.ResumeOptions{MaxCostUSD: 10})`
  and `run.Resume(ctx, grad.ResumeOptions{})` take an options struct instead of a required cap. **Breaking
  (Rust):** `runs().create`, `evals().create`, `datasets().score` and `artifacts().create_import` take
  `&CreateOptions { idempotency_key }` instead of a positional key; `sources().create_with` reads the key from
  `SourceOptions::idempotency_key`, and `sources().create` no longer takes one.
- **SDKs: scores and counts.** TypeScript `evals.postScores(id, scores)` and Go `Evals.PostScores` post scores for
  an `awaiting_scores` eval, as Python and Rust do; all four send 1,000 per request and return `accepted` summed
  over the requests (Python returned the last request's count, Rust sent everything in one request). `runs.counts`
  (Python, TS), `Runs.Counts` (Go), `runs().counts` (Rust) and `grad runs counts [--search]` read
  `GET /v1/runs/counts`. The Rust SDK prints a run plan with `println!("{plan}")`, like the other SDKs.
- **CLI:** `grad secrets get NAME` shows a secret's metadata (never its value); `grad artifacts import-status ID`
  shows an artifact import queued with `--no-wait`. The Homebrew formula installs the bash, zsh and fish
  completions.

- **Run comparison reads.** `GET /v1/runs/{id}/metrics?max_points=N` returns a run's whole curve in one page, thinned
  to at most N points spaced evenly back from the newest (eval points thinned separately, so a sparse eval curve
  survives) and without the steps a resumed attempt replayed. A 100,000-point run answers in about 300 ms.
  `GET /v1/runs/counts` (`countRuns` / `count_runs` / `CountRuns`) counts the workspace's runs per status, narrowed by
  `q` like the list; migration `0012` adds the index it reads (100,000 runs: 14 ms).
- **Breaking: `GET /v1/runs/{id}/metrics` is JSON pages only.** Its Server-Sent Events mode is gone (every SDK and
  the CLI already follow metric points on `GET /v1/runs/{id}/events`); the generated
  `listRunMetricsStream` / `ListRunMetricsStream` / `list_run_metrics_stream` are removed.
- **Spec: no whole-component nulls.** A nullable use of a named schema (`latest_metric`, `last_sync`, a
  checkpoint's `format`, ...) marked the component itself nullable, so the typed SDKs read
  `MetricPoint | null` inside metrics pages and events and an optional `format` on every artifact; the
  trainer-callback responses had an `allOf` with null that no null value matched. The null now sits at
  each nullable field (`anyOf: [$ref, null]`). `MetricsPage.data`, `MetricEvent.metric`,
  `Artifact.format` and `ArtifactImport.format` are non-null in all four SDKs (Go drops the pointers,
  Rust the `Option`).
- **Evals:** a transient failure (storage, the database) while handing a claimed eval to its worker requeues the eval at
  once, spending the attempt, as runs and imports already did; before, the eval stayed leased until its lease expired.

- Docs: `spec/openapi.yaml` describes the fields of `Run`, `PlanRunRequest`, `Checkpoint`, `Artifact`, `Dataset`,
  `EvalRun`, `PlanEvalRequest`, `ImportJob`, `ApiKey`, `Source` and `UsageRecord` (descriptions only, no wire
  change), so the generated [API reference](https://gradiated.com/docs/reference/training-api/) and the SDKs' doc
  comments explain them. A problem's `type` URL (`https://gradiated.com/problems/<code>`) now opens that code's entry
  in [Errors](https://gradiated.com/docs/training/errors/). `scripts/check-docs-snippets.py --api-examples` sends
  every request body the API reference shows to a live stack (`--capture` records each endpoint's response for it),
  and fenced blocks with a title are checked too. `grad --help` has examples for `runs events`, `runs resume`,
  `runs promote`, `eval failures`, `secrets set`, `sources add` and `sources update`.

- **List filters.** `GET /v1/runs` takes `status` (comma-separated, e.g. `queued,running`) and `q`
  (a case-insensitive name substring, or an exact id); `GET /v1/evals` takes `status`;
  `GET /v1/imports` takes `status` and `dataset`; `GET /v1/datasets` and `GET /v1/artifacts` take
  `q`. Filters keep the same newest-first cursor. Every SDK's generated client has them.
- **SDKs and CLI: list filters.** `runs.list(status=["failed", "cancelled"], search="sft")`,
  `evals.list(status=)`, `imports.list(status=, dataset=)`, `datasets.list(search=)` and
  `artifacts.list(search=)` in Python (TS takes the same options object; Rust takes `RunFilter`,
  `EvalFilter`, `ImportFilter` and `ArtifactFilter`, and `datasets().list(search, page)`). **Breaking
  (Go):** `Runs.List`, `Evals.List`, `Imports.List`, `Datasets.List` and `Artifacts.List` take an
  options struct (`grad.RunListOptions{Status: ..., Search: ...}`; `Artifacts.List(ctx, name)` is
  now `grad.ArtifactListOptions{Name: name}`). **Breaking (Rust):** those lists and their
  `list_all` take the filter. The CLI has `grad runs list --status failed,cancelled --search sft`,
  `grad eval list --status`, `grad imports list --status --dataset`, and `--search` on
  `grad datasets list` and `grad artifacts list`. Resolving a run by name (`grad runs get NAME`,
  Rust `find_by_name`) asks the server for matching names instead of walking every run.
- **SDKs: uploads of any size.** The TypeScript SDK sent presigned uploads under the 60 s
  per-attempt timeout, so an upload slower than that (a few GB of weights) failed; uploads now have
  no per-attempt deadline (an `AbortSignal` still cancels them). It also read the whole file into
  memory first (Node's fetch buffers a Blob body, even from `openAsBlob`): a 2 GiB upload peaked at
  2.1 GiB RSS, now 99 MiB, streamed from disk through `node:http(s)` with its Content-Length. With a `fetch` option
  (a proxy wrapper), the upload goes through that fetch as a stream of the file; before, it sent the text
  `[object Object]`. The Go SDK now retries an upload
  (dropped connection, 5xx), rewinding the file each time.
- **SDKs: one retry rule everywhere**, pinned by `tests/fixtures/wire/retries.json`, which every
  SDK replays: a `Retry-After` above 60 s raises the typed error at once in every SDK (Python and
  Rust used to sleep 60 s and retry). Python's `retry_after` is on every API error, not only 429.
  The Rust SDK closes idle connections after 4 s, below grad-server's keep-alive, as Python does.
- Go: `Evals.Results` and `Evals.Outputs` (and on `*Eval`), as the other SDKs have, and
  `Download(ctx, dir, grad.Extract())` (also on `Run.Download`) writes the bundle's verified files
  into a new directory, as Python, Rust and the CLI do: regular files with safe paths only, each
  checked against manifest.json, and nothing left behind on failure. TypeScript has the same as
  `download(dest, { extract: true })` (streamed, no tar dependency).
- TypeScript: a CRLF split across two SSE chunks no longer splits an event.
- Rust: collect-all helpers where the other SDKs iterate every page: `imports().list_all()`,
  `artifacts().list_all(name)`, `runs().checkpoints_all(id)`, `evals().results_all`,
  `failures_all` and `outputs_all` (bounded like every `list_all`).
- SDK READMEs: one quickstart per SDK (push two records, plan, train `test/tiny-qwen3`,
  download) that runs on `grad local up --dev-models` in about 10 s; each SDK's test suite runs it
  verbatim (Python, TypeScript and Go live suites; the Rust README is the crate docs, so `cargo
  test` compiles it). The Rust SDK has a README.
- `grad local up` says the first pull is about 3 GB, not 600 MB.
- `grad completion bash|zsh|fish|elvish|powershell` prints a shell completion script.
- CLI: every command that shows one thing answers to `get` (`grad runs get`, `artifacts get`,
  `eval get`, `imports get`, `sources get`, besides `inspect`/`status`/`show`), and `grad sources
  delete` works like `remove`.
- **SDKs: one live stream per run.** `metrics(follow=True)` (Python, TypeScript, Go) and
  `grad runs logs --follow` now read the metric events of the run's event stream
  (`GET /v1/runs/{id}/events`), the stream `wait()` already follows, instead of a second SSE
  connection to `/v1/runs/{id}/metrics`. The Rust SDK drops `runs().stream_metrics` and
  `wait_with_metrics`: use `runs().events(id, true)` and match `RunEvent::Metric`, or
  `wait_with_events`.

## [0.2.0-alpha.7] - 2026-11-28

No migrations. The last fixes from the launch review:

- **Gradiated Cloud training isn't live yet.** `api.gradiated.com` doesn't serve grad's `/v1` API
  until its routing lands, and its bare 404 read like a missing resource. All four SDKs and the
  CLI now turn a 404 without a problem `code` from `api.gradiated.com` into a feature-unavailable
  error (`cloud_training_unavailable`, CLI exit 6): "Gradiated Cloud training isn't available
  yet; run `grad local up` or point at your server with --base-url or GRADIATED_BASE_URL." The
  default base URL is unchanged. The README quickstart and `grad --help` start a server of your
  own (`grad local up`, the Docker Hub images, Helm) and say Cloud is coming soon.
- **A run is never billed past its `max_cost_usd`.** The step that carries a run past its cap was
  billed in full; it is now billed only up to the cap. The stop, the resume check and the run's
  `tokens_processed` and `cost_usd` are unchanged.
- **A transient error while a claimed run or import is built** (storage, KMS, a database
  timeout) requeues the job, spending the attempt, and answers the claim with a 5xx so the
  worker backs off; it used to fail the job for good. An error about the job itself (its dataset
  version, labeling eval, starting artifact, source or secret gone) still fails it at once.
- docs/CLOUD_MODE.md uses placeholder hosts (`https://cloud.example.internal`) instead of
  Gradiated's in-cluster Services and routes; the settings and paths grad calls are unchanged.
- Cloud: a cached API key stops working at its own `expires_at`, not up to 5 s later.
- **Gradiated Cloud usage export:** when billing refuses more than 20 single rows in a tick without
  naming an `event_id` (an envelope or contract break, not bad rows), the export stops narrowing,
  parks nothing, logs an error and backs off like an ingest outage
  (`grad_usage_export_failures_total`), instead of parking every row.
- **Gradiated Cloud:** the public `DELETE /v1/artifacts/{id}/pins/{holder}` answers 403
  `pin_managed_by_cloud` for `inference:` holders (a published model version's pin), so a
  workspace admin can no longer unpin a live version's artifact and delete it. Only Cloud's
  internal routes remove those pins; self-hosted servers are unchanged.
- Cloud: a deleted workspace's purge no longer stalls on a dataset that only evals use. A pass
  deleted it while a remaining eval (past the pass's 500-row page, or still running) referenced
  it, so the pass failed on `grad_evals_dataset_id_fkey`, rolled back and failed the same way
  every minute; the dataset now waits for its evals like it waits for its runs.
- An artifact upload whose archive is cut off (`EOFError` or `zlib.error` mid-stream) fails at once
  with `invalid_artifact` ("upload: the archive is truncated or corrupt"); it used to crash the
  import worker, retry until `max_attempts` and fail as "abandoned by its worker".
- A checkpoint eval that finishes while its run is still training no longer deadlocks the run's
  progress writes (alpha.5's event-ordering lock took the run's rows in the opposite order from
  every other run write; Postgres aborted one side with `deadlock detected`, a 500 the worker
  retried).
- `grad train --wait | head` and other pipes whose reader leaves early no longer panic the CLI
  with exit code 101; `grad` ignores the closed pipe and exits as it would have (so
  `grad ... | grep -q` still passes under `set -o pipefail`).
- The web console no longer renders a blank page in a browser whose locale Intl rejects
  (Chromium on Linux with `LANG` unset reports `en-US@posix`); it falls back to en-US. The
  Datasets empty state points at `grad import FILE --dataset NAME` (it named
  `grad datasets import`, which only takes Hugging Face datasets), and the Health page says
  evals run on eval workers.

## [0.2.0-alpha.6] - 2026-11-28

No migrations. Fixes from the production end-to-end test of alpha.5, Postgres certificate
verification and a console Artifacts page:

- **Postgres verify-full.** Set `PGSSLROOTCERT` (Helm: `database.caBundle`, a ConfigMap or
  inline PEM, mounted into the API pods and the migrations Job) and every Postgres connection
  verifies the server certificate and hostname against that bundle whatever `ssl*` parameters
  the URL carries (a stale `sslmode=no-verify` included). For RDS, use the AWS global bundle;
  see docs/SELF_HOSTING.md "Postgres TLS". An IP-address host is checked against the
  certificate's IP addresses (node-postgres alone checked it against `localhost`).
- **Helm:** `GRAD_WORKER_AUTOSCALING` is set only when `keda.enabled` and an enabled pool takes
  `train` jobs (`api.workerAutoscaling` overrides it), so a queued run without one says "Waiting
  for a worker (none online)", not "Starting a worker (autoscaling)".
- **Cloud evals before the gateway's eval lane** answer `501 inference_unavailable` with
  "Evals aren't available on Gradiated Cloud yet"; `recipe.evals` on Cloud is always `422
  checkpoint_evals_unsupported_on_cloud`.
- **Web console: an Artifacts page** (`/artifacts`): every artifact as name@version with its
  format, base model, provenance, size, age and pins; an artifact's page shows its manifest,
  provenance and pins, downloads it and deletes it after a confirmation (a pinned one shows the
  `409 artifact_pinned` holders).
- **Artifacts list their pins.** Every `Artifact` (list, get, a run's artifact, import results,
  the internal resolve and pin responses) carries `pins` (`holder`, `reason`, `created_at`;
  `[]` when unpinned), in all four SDKs.
- The trainer logs Hugging Face Hub warnings once, as JSON (no raw stderr duplicate).

## [0.2.0-alpha.5] - 2026-11-28

Upgrading runs migration 0010 (`node dist/main.js migrate`, or the Helm chart's Job); an alpha.4
database (0001 to 0009) upgrades in place. Breaking and behaviour changes, mostly for operators:

- **Removed settings.** `USAGE_FLUSH_TOKENS`, `USAGE_FLUSH_SECONDS`,
  `WAITING_FOR_COMPUTE_SECONDS`, `SOURCE_VERSION_INTERVAL_SECONDS`,
  `SOURCE_VERSION_MAX_RECORDS` and `GRAD_CLOUD_JWT_AUDIENCE` are no longer read; their values
  are fixed at the old defaults (1M tokens / 5 minutes, 30 s, 900 s, 100k, `training`). The
  deprecated unprefixed `INFERENCE_*`/`JUDGE_*` names are gone too: set
  `GRAD_INFERENCE_*`/`GRAD_JUDGE_*`. The API container no longer gets `GRAD_JUDGE_BASE_URL`
  (only eval workers use it).
- **`503 capacity_unavailable` is waited out, not failed.** An eval whose model has no capacity
  (a cold serving pool) or whose lane is full (429 past the client's retries) waits in place,
  honouring `Retry-After`, for up to `GRAD_EVAL_CAPACITY_WAIT_SECONDS` (default 720) per call,
  keeping its lease and spending no attempt. `EvalRun.waiting_reason` says why
  (`capacity_unavailable` | `rate_limited` | `inference_unavailable`). An inference outage no
  longer stores error outputs and zero judge scores.
- **Cloud refuses checkpoint evals.** A run with `recipe.evals` answers `422
  checkpoint_evals_unsupported_on_cloud` at plan and create, since Cloud serves only published
  artifacts: evaluate `run.artifact` after training.
- **Parked usage rows (Cloud).** A usage row billing refuses for good (422/409) is parked
  (`grad_usage.parked_code`, `parked_at`) instead of holding back every later row. Parked rows
  are never deleted and never retried by themselves; docs/CLOUD_MODE.md says how to retry
  them. Transient failures still retry forever.
- **Rust SDK:** `datasets().import_hf` and `artifacts().import_hf` are `from_hf`, as in the
  other SDKs, and `import_hf_with_secret` is gone (set `ImportSource.secret`).
- **JSON request bodies are capped at 32 MiB** (was 64), `413 payload_too_large`, and a replica
  handles at most two bodies over 1 MiB at once (the rest wait). The SDKs push 8-16 MiB batches.
- **`AUTH_MODE=none` checks Host and Origin.** A public DNS name in `Host` is `403
  host_not_allowed` (DNS rebinding), and a cross-site browser request from an origin outside
  `GRAD_CORS_ORIGINS` is `403 cross_site_request`. Loopback, IP literals, single-label names
  (compose services), `.local`/`.internal`/`.svc` names and link navigations still work.
- Every alert in the chart's PrometheusRule is `severity: warning` (`GradApiErrorRateHigh` was
  `critical`), and the trainer logs JSON lines on stdout instead of `[grad-trainer]` text on
  stderr.

### Security

- Artifact uploads: sparse tar members are refused and a tar holds at most 1,024 entries and
  10 GiB uncompressed (a 242-byte upload could write 93 GB). A router, decision or reward
  bundle's `head_file` must be the format's own head file, JSON configs are at most 16 MiB, and
  `*` in a format pattern no longer crosses `/`, so `sub/model.safetensors` is dropped, not kept
  unchecked. A malformed upload is the tenant's `422 invalid_artifact`, not a retried job.
- Hugging Face imports: at most 1,024 files of the format and one hour; a redirect that leaves
  http(s) or downgrades https is refused, the token is dropped on any scheme or host change,
  and proxy variables are ignored. `revision` must be a branch, tag or commit name.
- Cloud console and service JWTs whose `exp` is more than an hour ahead are refused.
- Web UI: a `#key=` link never replaces the key of a tab that is already signed in.
- The TypeScript SDK's errors redact a presigned URL's query, as Rust and Go do.
- hono 4.13.17 and @hono/node-server 2.1.6 (moderate advisories; none reproduced against
  grad's routes). The trainer image's build context has a `.dockerignore`.

### Reliability

Chaos round 2; each has a test in `server/api/test/chaos-*.test.ts`, and docs/ARCHITECTURE.md
"Failure modes" has the table.

- A Postgres connection black-holed by a failover fails within 35 s and is never reused; the
  SSE hub pings its LISTEN connection. Boot-time migrations no longer hit the 30 s statement
  timeout.
- Object storage outages answer `503 storage_unavailable` (was 500); long downloads are no
  longer aborted at 120 s.
- One failing scheduled source no longer stops every schedule; up to 1,000 sources start per
  tick.
- A TokenReview outage no longer expires every Kubernetes worker's lease: a review is good for
  15 min while the API server is down, never past the token's `exp`. A rotated worker token
  never fails an eval.
- A GPU worker takes the runs no smaller GPU fits first, so big runs aren't starved.
  `MAX_PREEMPTIONS` counts only reclaims in a row that saved no checkpoint, and a reclaimed
  worker hands back when its grace ends mid-save.
- An artifact delete or the orphan sweep never removes a bundle a new release of the same bytes
  references; a pin racing a delete answers 404 (was 500), as does promoting a checkpoint whose
  blob just expired. A workspace purge no longer stops at its first 500 pinned objects. A
  restarted trainer removes the job directories a killed one left.
- A resumed run that ends again has one best and one final checkpoint (it listed two of each).
- A live event stream (SSE, so `wait(onMetric=...)` and `grad runs watch`) no longer skips an
  event that drew its seq before another of the run's events but committed after it (a run's
  last metric, typically): a job's events now commit in seq order.

### Developer experience

- **Evals on `grad local up --dev-models`**: the stack also starts `grad-dev-inference`, a CPU
  OpenAI-compatible endpoint, and points the API's and eval worker's inference and judge URLs
  at it, so `grad eval` works with no flags (was `501 inference_unavailable`). It serves
  `test/tiny-qwen3`, `test/tiny-qwen3-teacher`, LoRA and merged artifacts trained on them, and
  `test/tiny-judge`, a deterministic word-overlap judge. URLs exported in your shell still win.
  `tests/compose/smoke.sh` evals the trained artifact with a judge and checks the report in the
  CLI, the Python SDK and the web UI.
- `scripts/check-docs-snippets.py --local` runs the docs' blocks against that stack, and
  `--compile` type-checks their TypeScript, Go and Rust blocks (56 were never checked; the
  README's Rust quickstart didn't compile).
- TypeScript and Go raise `FeatureUnavailableError` for any 501, like Python and Rust (it was
  a `ServerError`, which reads as "try again later"). TypeScript has `artifacts.waitImport(id)`
  and prints a readable plan from `console.log(plan)`; Python's `artifacts.download_url` is
  typed `ArtifactDownloadUrl`.
- CLI: a run says "Queued", then "Waiting for a worker (none online | N online, all busy)",
  instead of "Waiting for a GPU (0 workers online)" while a worker is about to claim it. Errors
  lead with the server's words, `grad train` sums up the selected checkpoint in one line, and
  `grad artifacts list` prints readable sizes. `grad local up` and `down` print a few lines, not
  compose's progress.
- `runs.plan` and `runs.create` warn when only CPU workers are online for a GPU-sized model. A
  router whose report fold misses `max_quality_drop` says so.
- `grad local up` can sync from a provider on the same machine (`GRAD_SOURCES_EGRESS_ALLOW`,
  `host.docker.internal`).
- A presigned artifact download is saved as `<name>-<version>.grad.tar.gz`, not its sha256.
- Resuming a run you just cancelled says to retry in a few seconds.
- A test checks that SELF_HOSTING.md and CLOUD_MODE.md list every setting the server and eval
  workers read, with the code's defaults. The Helm chart sets `GRAD_WORKER_AUTOSCALING` from
  `keda.enabled`.
- Releases: a registry that rejects an upload no longer holds back the GitHub Release and
  Homebrew, and a pushed `v*` tag publishes with no approval step.

### Observability

- **One Grafana dashboard, "grad / Training platform"** (`deploy/grafana/grad.json`, also the
  Helm chart's and `grad local up --observability`'s): overview, queue and scheduling, runs and
  jobs, workers and GPUs, evals, sources, billing, auth, API and SSE, dependencies and Loki
  logs. It replaces the Overview, Training and Evals & Sources dashboards.
- Metrics: `grad_http_errors_total{code}`, `grad_job_failures_total` by kind, recipe and
  `error_code`, `grad_worker_auth_total`, `grad_token_reviews_total`,
  `grad_token_review_duration_seconds`, `grad_token_reviews_in_flight`,
  `grad_auth_cache_lookups_total`, `grad_billing_checks_total`, `grad_price_list_age_seconds`,
  `grad_eval_inference_errors_total{target,reason}` (refused calls count even when an eval
  stores no output), `grad_source_sync_lag_seconds`,
  `grad_maintenance_last_tick_timestamp_seconds`, `grad_usage_parked_rows` and the workers'
  `grad_trainer_checkpoints_total`. Worker series carry their `pool`. docs/METRICS.md lists
  them all.
- Alerts (`metrics.prometheusRule.enabled`, all warnings): `GradJobFailureRateHigh`,
  `GradUsagePushLagging`, `GradUsageRowsParked`, `GradTokenReviewSaturated`,
  `GradDatabaseErrors`, `GradStorageErrors`, `GradMaintenanceStalled`, and
  `GradNoWorkersForQueuedJobs` for eval workers too. `GradApiErrorRateHigh` needs more than 0.1
  requests/s.
- Logs: every component writes JSON lines to stdout with `time`, `level`, `component` and the
  ids that apply (`request_id`, `job_id`, `run_id`, `attempt`, `worker_id`, `workspace_id`);
  errors carry `error_type` and `stack`, and credentials are masked.

### Cloud

- The internal listener (`INTERNAL_PORT`) starts when either of its route groups is configured:
  Cloud's routes (`AUTH_MODE=cloud`) no longer need lease worker auth and an orchestrator key.
  A group that isn't configured is 404. Helm's `api.internalPort` serves it on the ClusterIP
  Service `<fullname>-internal` (never the Ingress), with `networkPolicy.internalIngressFrom`.
- Evals: a 404 from the product's eval-versions call is `422 artifact_not_servable` (was a
  retried 503); the call gets 10 minutes (the product copies the bundle) and retries 5xx. Evals
  call the gateway with each model's canonical-case id (`Qwen/Qwen3-8B`);
  `GRAD_EXTRA_MODELS_JSON` entries take an optional `serving_id`.
- The `gradiated` source answers `501 source_unavailable` ("coming soon") unless
  `GRAD_CLOUD_TRACES_ENABLED=true`, instead of failing at sync time.
- A product-DB failover keeps recently answered API keys working for up to 5 min; the JWKS
  refresh never blocks a request and a rotated key verifies at once. A replica booted during a
  price-list outage answers `503 billing_unavailable`, not `422 unknown_model`, and a heartbeat
  checks one balance per workspace at a time.

## [0.2.0-alpha.4] - 2026-11-27

Upgrading runs migrations 0002 to 0009 (`node dist/main.js migrate`, or the Helm chart's Job).
Breaking changes are marked; most affect operators, not SDK code.

### Added

- **One artifact registry for trained, uploaded and imported weights.** `grad artifacts upload
  PATH --base MODEL` uploads an adapter, merged model, encoder or router bundle trained
  elsewhere; `grad artifacts import hf://owner/name[@revision] --base MODEL` imports one from
  the Hugging Face Hub at a pinned commit. An import worker checks the files against
  docs/ARTIFACT_FORMATS.md and the base model's `config.json` (a failed check is `422
  invalid_artifact` naming the file, CLI exit 5) and releases an ordinary `name@YYYY-MM-DD-n`
  artifact to download, evaluate or continue training from. Every SDK has `artifacts.upload`
  and the Hub import (`from_hf` / `fromHf` / `FromHF` / `import_hf`).
- Every artifact has `provenance` (the run, the uploader key, or the `hf://` URI and commit).
  `grad artifacts delete NAME@VERSION` (`artifact.delete()`) deletes one; an artifact Gradiated
  Cloud has pinned for a model version is never deleted (`409 artifact_pinned`).
- **Worker authentication modes** (`GRAD_WORKER_AUTH`): static keys (`TRAINER_KEYS_JSON`, the
  default), Kubernetes service-account tokens checked with the TokenReview API, or lease
  tokens an orchestrator mints on `INTERNAL_PORT` (`POST /internal/v1/worker-tokens`), bound
  to a host, job kinds, a GPU size and an expiry. Workers read `GRAD_WORKER_TOKEN` or
  `GRAD_WORKER_TOKEN_FILE` on every request, so tokens rotate without a restart.
- **Gradiated Cloud adapters** ([docs/CLOUD_MODE.md](docs/CLOUD_MODE.md)): `AUTH_MODE=cloud`
  (API keys from the product's auth view, console JWTs against its JWKS), `BILLING_MODE=cloud`
  (Cloud's price list, balances and usage events), evals through the Gradiated gateway,
  workspace suspend and delete hooks, artifact pins and resolve for serving, and workspace
  secrets sealed with AWS KMS (`GRAD_SECRETS_KMS_KEY_ID`). Self-hosted servers are unchanged.
- **A fair queue.** A claim goes to the workspace with the fewest running jobs of its kind,
  then to that workspace's oldest job, so one workspace's backlog no longer holds up another.
  A workspace runs at most `GRAD_MAX_RUNNING_PER_WORKSPACE_{TRAIN,IMPORT,EVAL}` (8) jobs of a
  kind and queues at most `GRAD_MAX_QUEUED_PER_WORKSPACE` (500); past that, creating a job
  answers `429 queue_limit`, which every SDK raises at once as `QueueLimitError` instead of
  retrying. Workers only get runs whose `min_gpu_memory_gb` fits their GPU. Runs carry
  `queue_position` and `queue_message`, and the CLI, TUI and web UI say why a run waits
  ("Queued behind 3 runs", "Waiting for a GPU with ≥46 GB; ...").
- **Usage reports.** `grad usage` prints a period's cost and tokens by kind (training, eval,
  scoring, labeling, teacher) with the top runs and evals; `--by day|week|month|model|recipe|kind`
  groups it and `--from`/`--to` set the period. `GET /v1/usage/summary`, `usage.summary(...)` in
  every SDK, and a usage page in the web UI. The old listing is `grad usage list`.
- **Source controls.** Filters are checked per provider (`422 source_filter_unsupported` or
  `source_filter_invalid`) and sent to the provider's API where it supports them.
  `sample_rate`, `max_records_per_sync` and `max_records_per_day` cap what a source brings in,
  `version_interval` (default 15 min) makes a busy source commit fewer dataset versions, and
  `grad sources update` (`PATCH /v1/sources/{id}`) changes any of them from the next sync.
- Browser clients: `GRAD_CORS_ORIGINS` allows listed origins on `/v1`, and `grad artifacts
  download REF --url` (`GET /v1/artifacts/{id}/download-url`) prints a presigned download.
- A maintenance sweep deletes job blobs no artifact or dataset part references once they are
  `ORPHAN_BLOB_DAYS` (7) old.
- Homebrew: `brew install gradiated/tap/grad`. The release workflow updates the formula.

### Changed

- **The web UI is restyled** in the Gradiated brand: dark by default with a light theme, a
  phase stepper and live indicator on runs, smoothed loss and throughput charts with a hover
  readout, a cost cap line once spend nears it, and a runs table that fits at 1024 px.
  Storybook renders every component and page state (`pnpm -C server/ui storybook`).
- **Evals run on eval workers, not in grad-server.** Evals, `dataset.score()`, router labelling,
  distillation's teacher answers and checkpoint evals are `eval` jobs claimed by `node
  dist/main.js worker --kinds eval` (the grad-server image; Helm's `import` pool runs one, and
  `grad local up` adds `grad-eval-worker`). Restarting the API no longer interrupts an eval.
  **Breaking (operators):** `GRAD_INFERENCE_API_KEY`, `GRAD_JUDGE_API_KEY` and
  `EVAL_CONCURRENCY` move to the eval workers, and `EVAL_EXECUTOR` is gone.
- **Helm defaults to `workers.auth=kubernetes`**: one ServiceAccount per pool and no worker
  keys (`workers.auth=static` keeps the generated keys). Training pods run under a low
  PriorityClass (`<release>-training-low`), so your own workloads preempt them.
- **Storage is S3-compatible only.** **Breaking:** `S3_BUCKET` is required, and local-disk
  mode (`STORAGE_DIR`, `BLOB_SIGNING_SECRET`, the `/blobs/*` routes) is gone. `grad local up`
  runs SeaweedFS (S3 on `127.0.0.1:18786`) and migrates with a one-shot `migrate` service.
  Data in an old local stack's `grad-storage` volume is not migrated: push datasets again.
  `S3_PUBLIC_ENDPOINT` (Helm `storage.s3PublicEndpoint`) signs client uploads for another host.
- `grad local up` publishes the API and web UI on `127.0.0.1:18787`, Grafana on `18788` and
  Prometheus on `18789` (were `8787`, `3000` and `9090`). It moves a busy default port to a
  free one and says so, remembers the choice, and `grad local status` prints the URLs.
- Released artifacts live under `artifacts/<workspace>/<sha256>`, the one prefix serving reads;
  checkpoints stay under their job. Manifests are format_version 2 (they add `provenance`);
  readers accept 1 and 2.
- Event streams share one reader per API replica (LISTEN on `grad_job_events`) instead of
  polling Postgres per stream: with 1,000 streams, about 40 queries a second instead of
  2,000, and under 0.1 s from write to client.
- Import workers upload dataset parts (gzip JSONL, up to 50k records or 64 MB) straight to
  storage; grad-server never carries the records. Reading a large synced dataset is about ten
  times faster (180k records: 71 s to 6 s).
- Source syncs use each API's largest page, fetch traces and scores side by side, and re-read
  the last hour of feedback for edits every 15 minutes (Phoenix: 7 days) instead of a week
  every minute. `GRAD_SOURCES_<PROVIDER>_REQUESTS_PER_MINUTE` raises a provider's rate.
- **Breaking:** a `UsageRecord`'s `kind` is the usage kind (`training` replaces `run`; evals
  are `eval`, `scoring`, `labeling` or `teacher`). Rust `client.usage().list` takes a
  `UsageQuery`.
- **Breaking (Cloud operators only):** `CLOUD_INTERNAL_API_URL`'s `/auth/verify` and
  `billing/usage/cursor` calls and `USAGE_EXPORT_LAG_SECONDS` are gone.
- The default `batch_size` is a quarter of the training examples (at least 8) when that is
  under 128, so a small dataset takes several optimizer steps. `runs.plan` adds
  `cost_breakdown` (training, teacher and eval), and its estimate includes `recipe.evals`.
- npm: until 1.0 every release, alpha included, gets the `latest` dist-tag, so `npm i
  @gradiated/grad` installs the newest one (it was stuck on alpha.1).

### Removed

- **The deploy surface.** grad-server drops the `/v1/deployments`, `/v1/route`,
  `/v1/embeddings` and `/v1/feedback` stubs; the SDKs and CLI drop `deploy()`, `deployments`,
  `grad deploy` and `DeployUnavailableError`. On Gradiated Cloud you publish an artifact as a
  model version through the Models API; self-hosted, download it and serve it yourself.
- The trainer protocol's `POST /v1/trainer-jobs/{id}/records`: imports upload parts instead.

### Fixed

- Plans estimate what runs bill: each base model's tokenizer density (the dev models' was off
  by 2.3x), both sides of every DPO and reward pair, and whole batches per epoch.
- A second run under a queued or running run's name warns in the plan and on create
  (`run.warnings`); CLI commands given a shared name pick the newest and say so.
- `grad runs watch` and a re-attached `grad train --wait` show the whole run from its first
  event, and the empty chart says what the run is waiting for.
- A Postgres restart, failover or killed backend no longer crashes grad-server: the request
  answers `503 database_unavailable` and the pool drops the dead connection.
- Concurrent identical pushes and promotes no longer make duplicate versions or releases
  (migration 0002), and `record_count` counts a record pushed or synced again once.
- A retried eval cancel or run resume returns the current state instead of 409, and
  `dataset.score` honours `Idempotency-Key`, so a retry after a lost response starts nothing new.
- A restarted worker container takes a new, billed attempt instead of its old lease.
- An eval's or import's final status commits with its bill; a database blip during an eval is
  retried in place instead of waiting out the lease; an eval worker waiting on the regex
  sandbox no longer exits mid-eval.
- Leases follow the database clock on a monotonic clock, so a host clock step no longer
  requeues healthy jobs.
- A source sync that fails waits for its in-flight provider requests before returning.
- Databases created by an earlier release get the usage-report indexes (migration 0009); they
  had been added to 0001 after it shipped.

### Security

- Kubernetes worker auth only sends JWTs that name audience `grad`, a mapped service account
  and a future expiry to TokenReview, at most 8 at a time per replica, so a flood of tokens on
  the public port can't turn into unbounded Kubernetes API calls.
- A lease token is bound to its orchestrator and host as well as its lease id, and a replayed
  `/complete` answers only the credential that closed the attempt (others get `409
  lease_lost`).
- Train and eval dataset streams are served only to the credential holding the job's lease.

## [0.2.0-alpha.3] - 2026-11-27

### Changed

- npm publishes with trusted publishing (OIDC); this is the first crates.io release of `grad-sdk`
  and `grad-cli`. The Go module tag step accepts a tag pushed by hand.
- The images are published to Docker Hub as `docker.io/gradiated/grad-server` and
  `docker.io/gradiated/grad-trainer`, with the same tags mirrored on GHCR. `grad local up`, the
  embedded compose file and the Helm chart default to Docker Hub.

## [0.2.0-alpha.2] - 2026-11-27

### Security

- The trainer image installs from hash-pinned locks resolved from PyPI only (CPU torch is
  pinned to its one wheel on the PyTorch index), with `pip install --require-hashes`.
- Source syncs have wall-clock limits: 120 s per provider response however slowly a host
  sends it, and `GRAD_SOURCES_SYNC_MAX_SECONDS` (default 3600) per sync.
- Recipe `loggers=` (W&B, MLflow) go through the source egress guard: https only, no private
  or metadata addresses unless `GRAD_SOURCES_EGRESS_ALLOW` lists them, every redirect hop
  re-checked and the tracker key never sent to another origin.
- The egress guard judges the IPv4 address inside NAT64 (`64:ff9b::/96`) and
  IPv4-compatible IPv6 addresses, so `64:ff9b::a9fe:a9fe` can't reach a metadata endpoint.
- Worker errors shown on runs and imports no longer quote presigned URL query strings or
  object-storage response bodies.
- Hugging Face imports accept only Hub ids (no `.`/`..` segments, never a path that exists on
  the worker) and use the workspace's token or none, never the worker's own Hugging Face login.
- A job's model id can't name a directory outside `GRAD_MODELS_MIRROR`.
- The Python SDK names a downloaded bundle from the artifact's base name only, like the
  TypeScript and Go SDKs.
- `AUTH_MODE=none` refuses a non-loopback `HOST` unless `AUTH_MODE_NONE_ALLOW_REMOTE=true`
  (`server/docker-compose.yml` sets it; its port is published on loopback only).
- A regex rubric item that times out runs at most once per eval; the eval's other outputs
  score it 0 without queueing behind it on the replica's shared regex worker.
- One API key can hold at most 20 run event or metric streams open per replica (429
  `too_many_streams`).

### Changed

- The Rust SDK is imported as `grad` (`use grad::Client`); it is still published as `grad-sdk`
  on crates.io, where `grad` is taken.

- The eval endpoint settings are `GRAD_INFERENCE_BASE_URL`, `GRAD_INFERENCE_API_KEY`,
  `GRAD_JUDGE_BASE_URL` and `GRAD_JUDGE_API_KEY` everywhere (server, compose, Helm, docs).
  The unprefixed `INFERENCE_*` / `JUDGE_*` names still work and log a deprecation warning.
- A run stopped because the workspace ran out of balance (Cloud) is `stopped_balance`;
  `stopped_budget` means the run's own cap and resumes only with a higher one.

### Fixed

- `grad local up` and `grad local reset` only ever write the `local` profile. They used to
  overwrite whichever profile `--profile` or `GRADIATED_PROFILE` selected, and now refuse
  when that profile (or `local` itself) points at a server that isn't on this machine.
- `grad runs inspect --yaml` round-trips: zero values (`warmup: 0`) are kept, a
  continued-training run names its starting artifact as `model`, and `optimizer`,
  `eval_every` and `loggers` are exported, so `grad train -f` plans the same config.
- The train/eval split holds out a group whenever the dataset has two or more: small
  datasets no longer train with an empty eval side (which also made reward-model runs fall
  back to `eval_loss`).

## [0.2.0-alpha.1] - 2026-11-27

First public release.

### Added

- `grad-server`: datasets, runs, checkpoints, artifacts, evals and API keys on PostgreSQL and
  S3-compatible storage, described by one OpenAPI 3.1 contract (`spec/openapi.yaml`).
- `grad-trainer`: eight recipes (SFT, DPO, router, decision model, cartridge, embedding,
  distillation and reward model) with
  calibrated defaults, cost plans before compute, hard spend caps, checkpoints and resume.
- SDKs for Python (`grad-sdk`), TypeScript (`@gradiated/grad`), Go
  (`github.com/Gradiated/grad/sdks/go`) and Rust (`grad-sdk`), with transports generated from
  the spec.
- The `grad` CLI, including `grad local up` for a local stack.
- Public container images on GHCR (`grad-server`, `grad-trainer`, `grad-trainer:*-gpu`),
  published as `main` and `sha-<7>` on every push to `main` and as `X.Y.Z`/`latest` on
  release. `grad local up` pulls its own version (or `main` from a source build);
  `--image-tag` picks another.
- A Helm chart with KEDA scale-to-zero for GPU trainers and air-gapped overrides.

### Changed

- `grad` is now licensed under MIT (it was Apache-2.0). Every package's license metadata says
  `MIT`.
