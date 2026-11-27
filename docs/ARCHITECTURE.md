# Architecture

`grad` is a standalone, self-hostable training and serving platform designed around one authoritative OpenAPI 3.1 contract (`spec/openapi.yaml`) and strict self-hosted / Cloud parity.

## Components

1. **Control Plane (`server/api/`)**: TypeScript + Hono (`@hono/zod-openapi`), PostgreSQL + S3 (or local filesystem). Zero Valkey, ClickHouse, or Temporal dependencies in self-hosted mode.
   - Modular SRP routes under `server/api/src/routes/`: models/keys, datasets, runs/checkpoints/trainer-jobs, artifacts/deployments/route/embeddings/feedback, standalone evals, and outbound `grad env serve` worker hub.
   - Pluggable narrow adapters (`adapters.ts`, `adapters-cloud.ts`) for Auth, Billing, and Deploy (`ART-01` + `SERV-03`).
2. **Training Runtime & Connectors (`server/trainer/`)**: Python `grad-trainer` implementing all 6 v0 recipes (`sft`, `dpo`, `router`, `decision`, `cartridge`, `embedding`), `gradiated.cartridge/1` safetensors export, deterministic SHA-256 `.grad.tar.gz` bundles, and 7 Tier-1 trace connectors (`grad_trajectories`, `gradiated`, `otel`, `langfuse`, `posthog`, `braintrust`, `langsmith`).
3. **OpenAPI 3.1 Codegen (`scripts/generate-sdks.mjs`)**: Deterministic generator emitting zero-drift wire clients for TypeScript, Python, Go, and Rust (`--check` enforced in CI).
4. **4 Idiomatic SDKs (`sdks/{python,typescript,go,rust}`)**: Thin façades over the generated clients with fail-closed SHA-256 artifact verification.
5. **Rust CLI (`cli/`)**: Single binary `grad` built on `grad-sdk`.
6. **Packaging (`server/docker-compose.yml`, `server/helm/grad/`)**: Local Docker Compose stack (`grad local up`) and production Kubernetes Helm chart with optional KEDA scale-to-zero and air-gapped model/judge overrides.

## Locked v0 Scope
- **6 v0 Recipes:** `sft`, `dpo`, `router`, `decision`, `cartridge`, `embedding` (forward-compatible typed contracts retained for Wave 2 `distill`, `reward`, `grpo`).
- **Parameter-Efficient LLMs Only:** `LoRA`, `PrefixKV`, `FrozenHead` (no `adapters.Full()` for LLMs; `EmbeddingRecipe` trains the 33M `baai/bge-small-en-v1.5` encoder internally).
- **Single-Command Deploy:** `deploy()` / `grad deploy` with 1-command rollback (`previous_artifact_id`).
- **Local/CI Environments First:** Users serve local environments outbound via `grad env serve` with zero inbound ports.
