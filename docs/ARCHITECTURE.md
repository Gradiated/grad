# Architecture

`grad` is a standalone, self-hostable training and serving platform designed around one authoritative OpenAPI 3.1 contract (`spec/openapi.yaml`) and strict self-hosted / Cloud parity.

## Components

1. **Control Plane (`server/api/`)**: TypeScript + Hono (`@hono/zod-openapi`), PostgreSQL + S3 (or local filesystem). Zero Valkey, ClickHouse, or Temporal dependencies in self-hosted mode, and no in-process state that breaks with several API replicas.
   - **Routes** (`src/routes/`) are thin: user routes for datasets/imports/uploads, runs, checkpoints, artifacts, deployments/serving, evals and keys; `trainer-jobs.ts` is the worker protocol; `blobs.ts` serves HMAC-signed upload/download URLs when storage is the local filesystem. A global error handler renders every error (unknown route, malformed JSON, validation, thrown) as `application/problem+json` with a `request_id`. List endpoints share `?limit&cursor` → `{data, next_cursor}` keyset pagination.
   - **Services** (`src/services/`) own business rules and transactions: `runs.ts` (run lifecycle, leases, budgets, billing per attempt), `imports.ts`, `datasets.ts`, `uploads.ts`, `billing-outbox.ts`, `serving.ts`, `evals/` (in-server eval executor) and `maintenance.ts` (lease expiry, checkpoint/upload TTL GC, outbox drain).
   - **Store** (`src/store/`): per-resource repository interfaces (`types.ts`) implemented on Postgres (`postgres/`) and verified by `test/store-contract.test.ts`. Tests run on a real Postgres too: one schema per test file, emptied per test. `store.transaction()` gives atomic multi-repository writes; migrations are versioned (`grad_schema_migrations`) under an advisory lock.
   - **Storage** (`src/storage/`): immutable `ObjectStore` (local + S3) — every write targets a fresh key and never overwrites; S3 uploads/downloads use presigned URLs that enforce sha256 and `If-None-Match`.
   - **Adapters** (`adapters.ts`, `adapters-cloud.ts`) for Auth, Billing, Deploy and Serving. `DEPLOY_MODE=disabled` (self-hosted default) returns `501 deploy_unavailable`; `cloud` uses the Cloud internal API (tested against `test/fixtures/fake-cloud-api.ts`).
   - **Trainer protocol v1** (`/v1/trainer-jobs/*`, platform scope `trainer:worker`, never implied by `admin`): `claim` (train | import jobs; pinned dataset version, resume checkpoint, remaining budget), background `heartbeat`, `progress`, `uploads` (presigned or signed PUT), `checkpoints`, `records` (import batches), `complete` (one transaction: artifact + run + billing outbox; cost = tokens × catalog price). Leases expire into `attempt + 1` up to `MAX_ATTEMPTS`. KEDA autoscales workers from a Postgres query (queued + running jobs).
   - **Evals** run asynchronously in the server against an OpenAI-compatible endpoint (`INFERENCE_BASE_URL`, judges on `JUDGE_BASE_URL`); regex rubrics run in a worker thread with a hard timeout; Python function scorers run in the SDK (`awaiting_scores`). Nothing is simulated: without inference the API returns `501 inference_unavailable`.
2. **Training Runtime & Connectors (`server/trainer/`)**: Python `grad-trainer`. `grad_trainer/worker.py` is the protocol-v1 client (heartbeat thread, streaming bundle uploads, graceful SIGTERM, backoff, clear exit on a rejected key) and calls recipes through the seam types in `grad_trainer/runner_types.py`. Recipes implement all 6 v0 recipes (`sft`, `dpo`, `router`, `decision`, `cartridge`, `embedding`), `gradiated.cartridge/1` safetensors export, deterministic SHA-256 `.grad.tar.gz` bundles, and 7 Tier-1 trace connectors (`grad_trajectories`, `gradiated`, `otel`, `langfuse`, `posthog`, `braintrust`, `langsmith`).
3. **OpenAPI 3.1 Codegen (`scripts/generate-sdks.mjs`)**: Deterministic generator emitting zero-drift wire clients for TypeScript, Python, Go, and Rust (`--check` enforced in CI).
4. **4 Idiomatic SDKs (`sdks/{python,typescript,go,rust}`)**: Thin façades over the generated clients with fail-closed SHA-256 artifact verification.
5. **Rust CLI (`cli/`)**: Single binary `grad` built on `grad-sdk`.
6. **Packaging (`server/docker-compose.yml`, `server/helm/grad/`)**: Local Docker Compose stack (`grad local up`) and production Kubernetes Helm chart with optional KEDA scale-to-zero and air-gapped model/judge overrides.

## Locked v0 Scope
- **6 v0 Recipes:** `sft`, `dpo`, `router`, `decision`, `cartridge`, `embedding` (forward-compatible typed contracts retained for Wave 2 `distill`, `reward`, `grpo`).
- **Parameter-Efficient LLMs Only:** `LoRA`, `PrefixKV`, `FrozenHead` (no `adapters.Full()` for LLMs; `EmbeddingRecipe` trains the 33M `baai/bge-small-en-v1.5` encoder internally).
- **Single-Command Deploy:** `deploy()` / `grad deploy` with 1-command rollback (`previous_artifact_id`).
- **Environments are post-v0:** `grad env serve` (outbound environment workers) and environment evals return in Wave 2, rebuilt on the Postgres job queue.
