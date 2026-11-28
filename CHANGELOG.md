# Changelog

All notable changes to `grad` are recorded here. Every package in the repo (server, trainer,
Helm chart, the four SDKs and the CLI) shares one version, and the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). `grad` uses
[Semantic Versioning](https://semver.org/); until 1.0, a minor release may break the API.

## Unreleased

### Added

- **Evals on `grad local up --dev-models`**: the stack also starts `grad-dev-inference` (the trainer
  image's `grad-dev-inference` command, compose profile `dev-models`), a CPU OpenAI-compatible
  `/v1/chat/completions` endpoint, and points the API's and the eval worker's inference and judge
  URLs at it, so `grad eval` works with no extra flags instead of answering `501
  inference_unavailable`. It serves `test/tiny-qwen3` and `test/tiny-qwen3-teacher` by catalog id,
  LoRA and merged artifacts trained on them by artifact id (read from grad-server with the `local`
  profile's key and checked against `X-Grad-Workspace`), and `test/tiny-judge`, a deterministic
  judge that scores the word-overlap F1 with the reference answer. Endpoints exported in your shell
  still win. `grad local up` says so; `tests/compose/smoke.sh` now evals the trained artifact with a
  validator and the judge and checks the report in the CLI, the Python SDK and the web console
  (`server/ui/test/live/evals.test.tsx`), and drops its fake OpenAI server.
- `scripts/check-docs-snippets.py --local` runs the docs' blocks (with and without `--cloud`)
  against a running `grad local up --dev-models` stack, with catalog models mapped to the dev
  models and judges to `test/tiny-judge`.
- **One Grafana dashboard for production, "grad / Training platform"** (`deploy/grafana/grad.json`,
  also the Helm chart's and `grad local up --observability`'s), with sections for the overview,
  queue and scheduling, runs and jobs, workers and GPUs, evals, sources, billing (Cloud), auth,
  API and SSE, dependencies and Loki logs, and variables for the Prometheus and Loki data
  sources, the namespace and the worker pool. It replaces the Overview, Training and Evals &
  Sources dashboards.
- Metrics: `grad_http_errors_total{code}` (every problem+json response), `grad_job_failures_total`
  by kind, recipe and `error_code`, `grad_worker_auth_total{mode,result}`,
  `grad_token_reviews_total`, `grad_token_review_duration_seconds`, `grad_token_reviews_in_flight`,
  `grad_auth_cache_lookups_total`, `grad_billing_checks_total`, `grad_price_list_age_seconds`,
  `grad_eval_inference_errors_total{target,reason}` (with `capacity_unavailable`),
  `grad_source_sync_lag_seconds`, `grad_maintenance_last_tick_timestamp_seconds`, and the
  workers' `grad_trainer_checkpoints_total{reason,result}`. The PodMonitor labels worker series
  with their `pool`.
- Alerts (`metrics.prometheusRule.enabled`): `GradJobFailureRateHigh`, `GradUsagePushLagging`,
  `GradTokenReviewSaturated`, `GradDatabaseErrors`, `GradStorageErrors`,
  `GradMaintenanceStalled`, and `GradNoWorkersForQueuedJobs` for eval workers too.
- `EvalRun.waiting_reason` (`capacity_unavailable` | `rate_limited` | `inference_unavailable` |
  null): a running eval whose model calls are waiting for a cold serving pool, a full eval lane
  or a down endpoint says so. Eval workers wait out `503 capacity_unavailable` and 429s in place,
  honouring `Retry-After`, for up to `GRAD_EVAL_CAPACITY_WAIT_SECONDS` (default 720) per call
  without spending an attempt.
- `GRAD_EXTRA_MODELS_JSON` entries take an optional `serving_id`; on Gradiated Cloud evals call
  the gateway with each model's canonical-case id (`Qwen/Qwen3-8B`).

### Changed

- Fewer settings: `USAGE_FLUSH_TOKENS`/`USAGE_FLUSH_SECONDS` (1M tokens / 5 minutes),
  `WAITING_FOR_COMPUTE_SECONDS` (30), `SOURCE_VERSION_INTERVAL_SECONDS` (900),
  `SOURCE_VERSION_MAX_RECORDS` (100k) and `GRAD_CLOUD_JWT_AUDIENCE` (`training`) are now fixed,
  and the deprecated unprefixed `INFERENCE_*`/`JUDGE_*` names are no longer read (use
  `GRAD_INFERENCE_*`/`GRAD_JUDGE_*`). The API container no longer gets `GRAD_JUDGE_BASE_URL`
  (only eval workers use it), and the Helm chart sets `GRAD_WORKER_AUTOSCALING` from
  `keda.enabled`. A test checks that SELF_HOSTING.md and CLOUD_MODE.md list every variable the
  server and eval workers read, with the code's defaults.
- Every alert in the chart's PrometheusRule is `severity: warning` (`GradApiErrorRateHigh` was
  `critical`, and now needs more than 0.1 requests/s).
- Logs: every component writes JSON lines to stdout (warnings and errors too) with `time`,
  `level`, `component` and the ids that apply (`request_id`, `job_id`, `run_id`, `attempt`,
  `worker_id`, `workspace_id`); errors carry `error_type` and `stack`, and credentials are
  masked. The trainer's logs are JSON now (they were `[grad-trainer]` text on stderr) and
  cover each phase, checkpoint and attempt outcome.

### Fixed

- The internal listener (`INTERNAL_PORT`) starts when either of its route groups is configured:
  Gradiated Cloud's routes (`AUTH_MODE=cloud`) no longer need lease worker auth and an
  orchestrator key. Each group is mounted only when configured (otherwise 404), and startup fails
  only when neither is. Helm: `api.internalPort` serves it on the ClusterIP Service
  `<fullname>-internal` (never the Ingress), with `networkPolicy.internalIngressFrom`.
- Cloud usage export: a row billing ingest refuses for good (422/409) is parked
  (`grad_usage.parked_code`, `parked_at`) instead of holding back every later row; the rest export
  at once. `grad_usage_parked_rows` and the `GradUsageRowsParked` warning alert flag parked rows,
  which are never deleted and are retried by hand (docs/CLOUD_MODE.md). Transient failures still
  retry forever.
- Gradiated Cloud evals: `recipe.evals` (checkpoint evals during training) is refused with
  `422 checkpoint_evals_unsupported_on_cloud` at plan and create, since Cloud serves only
  published artifacts. A 404 from the product's eval-versions call is `422
  artifact_not_servable` (was a retried 503); the call gets 10 minutes (the product copies the
  bundle) and retries 5xx. The `gradiated` source answers `501 source_unavailable` ("coming
  soon") unless `GRAD_CLOUD_TRACES_ENABLED=true`, instead of failing at sync time.
- Failure modes, chaos round 2 (each with a test in `server/api/test/chaos-*.test.ts`; summary
  in docs/ARCHITECTURE.md "Failure modes"):
  - A Postgres connection black-holed by a failover now fails within 35 s and is never reused;
    the SSE hub pings its LISTEN connection. Boot-time migrations no longer hit the 30 s
    statement timeout.
  - Object storage outages answer `503 storage_unavailable` (was 500); long downloads are no
    longer aborted at 120 s.
  - One failing scheduled source no longer stops every schedule; up to 1,000 sources start per
    tick.
  - An inference outage during an eval waits and resumes instead of storing error outputs and
    zero judge scores; a rotated worker token never fails an eval.
  - Cloud: a product-DB failover keeps recently answered API keys working for up to 5 min; the
    JWKS refresh never blocks a request and a rotated key verifies at once; a replica booted
    during a price-list outage answers `503 billing_unavailable`, not `422 unknown_model`; one
    balance check per workspace at a time.
  - A TokenReview outage no longer expires every Kubernetes worker's lease (reviews are good
    for 15 min while the API server is down, never past the token's `exp`).
  - A GPU worker takes the runs no smaller GPU fits first, so big runs are not starved;
    `MAX_PREEMPTIONS` counts only reclaims in a row that saved no checkpoint; a reclaimed
    worker hands back when its grace ends mid-save.
  - An artifact delete or the orphan sweep never removes a bundle a new release of the same
    bytes references; a pin racing a delete answers 404 (was 500); promoting a checkpoint whose
    blob just expired answers 404. A restarted trainer removes job directories a killed one left.

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
