# Changelog

All notable changes to `grad` are recorded here. Every package in the repo (server, trainer,
Helm chart, the four SDKs and the CLI) shares one version, and the format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). `grad` uses
[Semantic Versioning](https://semver.org/); until 1.0, a minor release may break the API.

## Unreleased

### Security

- The trainer image installs from hash-pinned locks resolved from PyPI only (CPU torch is
  pinned to its one wheel on the PyTorch index), with `pip install --require-hashes`.
- Source syncs have wall-clock limits: 120 s per provider response however slowly a host
  sends it, and `GRAD_SOURCES_SYNC_MAX_SECONDS` (default 3600) per sync.
- Recipe `loggers=` (W&B, MLflow) go through the source egress guard: https only, no private
  or metadata addresses unless `GRAD_SOURCES_EGRESS_ALLOW` lists them, every redirect hop
  re-checked and the tracker key never sent to another origin.

### Changed

- The eval endpoint settings are `GRAD_INFERENCE_BASE_URL`, `GRAD_INFERENCE_API_KEY`,
  `GRAD_JUDGE_BASE_URL` and `GRAD_JUDGE_API_KEY` everywhere (server, compose, Helm, docs).
  The unprefixed `INFERENCE_*` / `JUDGE_*` names still work and log a deprecation warning.
- A run stopped because the workspace ran out of balance (Cloud) is `stopped_balance`;
  `stopped_budget` means the run's own cap and resumes only with a higher one.

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
