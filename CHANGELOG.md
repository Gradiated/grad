# Changelog

All notable changes to `grad` are recorded here. Every package in the repo (server, trainer,
Helm chart, the four SDKs and the CLI) shares one version, and the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). `grad` uses
[Semantic Versioning](https://semver.org/); until 1.0, a minor release may break the API.

## Unreleased

### Changed

- **Usage reports.** `grad usage` prints a period's total cost and tokens, a breakdown by kind
  (training, eval, scoring, labeling, teacher) and the top runs and evals; `--by
  day|week|month|model|recipe|kind` prints one grouped table, and `--from`/`--to` set the period
  in UTC (default: the current calendar month; a date `--to` covers that whole day). The old
  row listing is `grad usage list`, with `--from`/`--to`, `--run`, `--eval`, `--kind` and
  readable columns. The API adds `GET /v1/usage/summary` and those filters on `GET /v1/usage`;
  every SDK has `usage.summary(...)` and a filtered `usage.list(...)` taking strings or native
  dates. **Breaking:** a `UsageRecord`'s `kind` is now the usage kind (`training` replaces
  `run`; evals are `eval`, `scoring`, `labeling` or `teacher`), and records carry `ref_name`
  and `run_id`. Rust `client.usage().list` takes a `UsageQuery`. The web UI's usage page has a
  date range, groups and the top runs and evals.

- **Storage is S3-compatible only.** grad-server always uses an S3 bucket (AWS S3, SeaweedFS,
  MinIO, R2 and similar): `S3_BUCKET` is required, and the local-disk mode (`STORAGE_DIR`,
  `BLOB_SIGNING_SECRET` and the server-proxied `/blobs/*` routes) is gone. `grad local up`
  runs SeaweedFS as the store, with a key it generates into the `local` profile and its S3
  API on `127.0.0.1:18786` (probed like the other ports), because the CLI and SDKs upload
  files to presigned URLs. Data in the old `grad-storage` volume is not migrated: re-push
  datasets after upgrading a local stack. `S3_PUBLIC_ENDPOINT` signs client upload tickets
  for an endpoint other than `S3_ENDPOINT` (the Helm value `storage.s3PublicEndpoint`).
- The compose stack migrates with a one-shot `migrate` service (`node dist/main.js
  migrate`, as the Helm Job runs it); grad-server waits for it and starts with
  `MIGRATE_ON_BOOT=false`.
- The `grad_storage_operation_*` metrics drop their `backend` label.
- `grad local up` publishes the API and web UI on `127.0.0.1:18787`, Grafana on `18788` and
  Prometheus on `18789` (was `8787`, `3000` and `9090`). Before starting it probes each port:
  a busy default moves to a free port in 18790-18809 and one line says so; a busy port set
  with `--port` or `GRAD_*_PORT` fails with exit 2 (`port_in_use`) and how to see its owner.
  A running stack's own ports are not a clash. The choice is saved, so later runs keep the
  same URLs, the `local` profile follows it, and `grad local status` prints the API, UI,
  Grafana and Prometheus URLs. The Helm NOTES port-forward to `18787` too.
- The default `batch_size` is a quarter of the training examples (at least 8) when that's
  under 128 (embedding keeps 128), so a 40-record run takes several optimizer steps; the
  few-steps warning names the count ("40 training examples at batch 128 is 1 step per epoch").
- `runs.plan` has `cost_breakdown` (`train_usd`, `teacher_usd`, `eval_usd`), and
  `estimated_cost_usd` includes `recipe.evals` on every checkpoint. `print(plan)`, Go's
  `fmt.Println(plan)` and `grad train --dry-run` show the breakdown.

### Fixed

- Plans estimate what runs bill: text tokens use each base model's tokenizer density (the dev
  models' was off by 2.3x), DPO and reward plans count both sides of every pair (they counted
  one), and steps are whole batches per epoch, so plan and run report the same step count.
- A second run under a queued or running run's name warns in the plan and on `runs.create`
  (`run.warnings` in every SDK; Python `warnings.warn`, TypeScript `console.warn`), and
  `grad train` prints it. CLI commands given a name several runs share show the newest and say
  so on stderr (`--json`: `warnings`).
- `grad runs watch` and a re-attached `grad train --wait` show the whole run: the view replays
  the event stream from its first event (it dropped every point before the run's latest), the
  phase clock starts at the server's `phase_since`, and the chart spans 0 to `total_steps` with
  min/max downsampling and a 1st-99th percentile y axis. Before the first step the chart says
  what the run is doing ("Waiting for a GPU (2 workers online, all busy)…"). The web UI's phase
  clock no longer restarts after each eval.

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
