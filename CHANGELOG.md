# Changelog

All notable changes to `grad` are recorded here. Every package in the repo (server, trainer,
Helm chart, the four SDKs and the CLI) shares one version, and the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). `grad` uses
[Semantic Versioning](https://semver.org/); until 1.0, a minor release may break the API.

## Unreleased

### Changed

- `grad local up` publishes the API and web UI on `127.0.0.1:18787`, Grafana on `18788` and
  Prometheus on `18789` (was `8787`, `3000` and `9090`). Before starting it probes each port:
  a busy default moves to a free port in 18790-18809 and one line says so; a busy port set
  with `--port` or `GRAD_*_PORT` fails with exit 2 (`port_in_use`) and how to see its owner.
  A running stack's own ports are not a clash. The choice is saved, so later runs keep the
  same URLs, the `local` profile follows it, and `grad local status` prints the API, UI,
  Grafana and Prometheus URLs. The Helm NOTES port-forward to `18787` too.

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
