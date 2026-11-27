# Self-Hosting Guide

Self-hosted `grad` needs only **PostgreSQL** and **S3-compatible object storage** (or a local directory for a single replica). Hosted serving (`deploy`, `/v1/route`, `/v1/embeddings`) is a Gradiated Cloud feature: on a self-hosted server those endpoints return `501 deploy_unavailable`; download artifacts and serve them on vLLM or SGLang instead.

## Local development (`grad local up`)

`grad local up` starts PostgreSQL, `grad-server` and a CPU `grad-trainer` worker from published images. The compose file is built into the `grad` binary, so it works from any directory:

```bash
grad local up
# Or with NVIDIA GPU acceleration:
grad local up --gpu
# Pull a specific build (see the tags below):
grad local up --image-tag sha-abc1234
# Build the images from a source checkout (uses server/docker-compose.yml):
grad local up --build
```

### Images

The images are public on GitHub Container Registry, so pulling them needs no login:

| Image | Platforms | Tags |
| --- | --- | --- |
| `ghcr.io/gradiated/grad-server` | linux/amd64, linux/arm64 | `X.Y.Z`, `latest`, `main`, `sha-<7>` |
| `ghcr.io/gradiated/grad-trainer` (CPU) | linux/amd64, linux/arm64 | `X.Y.Z`, `latest`, `main`, `sha-<7>` |
| `ghcr.io/gradiated/grad-trainer` (CUDA) | linux/amd64 | `X.Y.Z-gpu`, `latest-gpu`, `main-gpu`, `sha-<7>-gpu` |

Every push to `main` that touches the server or trainer publishes `main` and `sha-<7>` (the commit's short SHA); the CUDA image is rebuilt on `main` only when the trainer changes. Each release publishes `X.Y.Z` and moves `latest` (prereleases don't). Every image carries an SBOM and a provenance attestation.

`grad local up` pulls the images first, so a moving tag like `main` stays current. A `grad` binary from a release (or `cargo install grad-cli`) pulls the images tagged with its own version; one built from a checkout pulls `main`. `--image-tag TAG` overrides that. If GHCR refuses the pull, the error says so: the packages may still be private, so either `docker login ghcr.io -u <github-user>` with a token that has `read:packages`, or build the images with `grad local up --build` in a checkout.

The API listens on `http://127.0.0.1:8787` (published on loopback only; change it with `--port` or `GRAD_PORT`). Authentication is on: the first run generates an admin key, a trainer key and the key that encrypts workspace secrets (`GRAD_SECRETS_KEY`), and saves them in the `local` profile of the `grad` config file (`grad config path`); the server only receives the admin key's SHA-256. `grad local up` waits for `/health/ready` and prints the next steps:

```bash
export GRADIATED_PROFILE=local
grad models list
```

`grad local status` shows container status and API health, `grad local logs [SERVICE] [--follow]` prints logs, `grad local down [--volumes]` stops the stack, and `grad local reset` deletes the local data and keys so the next `grad local up` starts fresh. Pass `--file` (or `GRAD_COMPOSE_FILE`) to use your own compose file; repeat `--file` (or separate the paths with `:`) to layer overrides on top, as `docker compose -f` does. `GRAD_SERVER_IMAGE` / `GRAD_TRAINER_IMAGE` / `GRAD_TRAINER_GPU_IMAGE` override the images (then `grad local up` doesn't pull first), and `GRAD_POSTGRES_MEMORY` / `GRAD_SERVER_MEMORY` / `GRAD_TRAINER_MEMORY` (default `1g` / `1g` / `8g`) cap the containers' memory. Data lives in named volumes (Postgres, artifacts and the trainer's Hugging Face cache), so it survives `grad local down` and is deleted by `grad local down --volumes`.

`tests/compose/smoke.sh` boots the stack with `grad local up --build` and runs the quickstart through the CLI and the Python SDK; CI runs it on every push.

Running `server/docker-compose.yml` directly with `docker compose` defaults to `AUTH_MODE=none` for development; the server logs a warning on every start because every request is then a platform admin. To enable authentication there, set the bootstrap admin hash and a trainer key first:

```bash
export GRAD_AUTH_MODE=api_key
export GRAD_ADMIN_API_KEY_HASH=$(printf '%s' "$MY_ADMIN_KEY" | sha256sum | awk '{print $1}')
export GRAD_TRAINER_API_KEY=$(openssl rand -hex 32)   # shared by grad-server and grad-trainer
export GRAD_SECRETS_KEY=$(openssl rand -base64 32)    # encrypts workspace secrets; keep it with the data
```

## Server configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Bind a non-loopback `HOST` explicitly (containers set `0.0.0.0`). |
| `AUTH_MODE` | `api_key` | `api_key` requires `ADMIN_API_KEY_HASH` (the server refuses to start without it). `none` must be set explicitly and is for development only. `cloud` delegates to Gradiated Cloud. |
| `ADMIN_API_KEY_HASH` | none | SHA-256 hex of the bootstrap admin key; use it to mint workspace keys with `POST /v1/keys`. |
| `TRAINER_API_KEY` or `TRAINER_API_KEY_HASH` | none | The platform trainer-worker key. Worker keys are not workspace keys: `admin` never implies `trainer:worker`, and `/v1/keys` cannot mint it. |
| `DATABASE_URL` | required | Postgres connection string. Migrations run at boot, versioned in `grad_schema_migrations` under an advisory lock, so several replicas can start at once. |
| `MIGRATE_ON_BOOT` | `true` | `false` skips them and refuses to start while any is pending; run `node dist/main.js migrate` first (the Helm chart's migrations Job does). |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` | none (local `STORAGE_DIR`) | Workers and SDKs upload and download through presigned URLs. Objects are written once under unique keys and never overwritten. |
| `STORAGE_DIR`, `BLOB_SIGNING_SECRET` | `.grad-data`, random | Local storage uses HMAC-signed `/blobs/*` URLs proxied by the server. Set the secret when replicas share a volume. |
| `BILLING_MODE` | `noop` | `cloud` checks balances with Gradiated Cloud (a run of an exhausted workspace stops, resumable) and exports the usage ledger to it from Cloud's cursor. Self-hosted, `GET /v1/usage` lists the ledger. |
| `INFERENCE_BASE_URL`, `INFERENCE_API_KEY` | none | OpenAI-compatible endpoint used by evals (your vLLM/SGLang with LoRA modules named by artifact id). Without it `POST /v1/evals` returns `501 inference_unavailable`. |
| `JUDGE_BASE_URL`, `JUDGE_API_KEY` | inference endpoint | Endpoint for `Judge` rubric items (`GRAD_JUDGE_BASE_URL` is accepted as an alias). |
| `GRAD_EXTRA_MODELS_JSON` | none | JSON array adding or overriding catalog models (the single price source for billing). |
| `MAX_ATTEMPTS` | `10` | Attempts that may end without a result (lease expired, or abandoned by a preempted worker) before a job fails. |
| `USAGE_FLUSH_TOKENS` / `USAGE_FLUSH_SECONDS` | `1000000` / `300` | A running attempt appends a usage row (GET /v1/usage) whenever this many tokens or seconds are unbilled, at each checkpoint, and when it ends. A worker killed outright is billed up to its last progress report. |
| `JOB_EVENT_RETENTION_DAYS` | `90` | Days job events (training metrics) are kept; older ones are deleted by the maintenance tick. |

## Production Kubernetes (Helm)

The chart (`server/helm/grad`) runs two or more API replicas, a migrations Job and two pull-based worker pools. It needs your own Postgres and an S3-compatible bucket; the chart refuses to render without `storage.s3Bucket`, because replicas and workers share artifacts through presigned S3 URLs.

1. Create one Secret (`secret.name`, default `grad`). Pods read only the keys they need, and every key except `database-url` is optional:

   | Key | Used by | Purpose |
   | --- | --- | --- |
   | `database-url` | API, migrations Job, KEDA | Postgres connection string |
   | `admin-api-key-hash` | API | SHA-256 hex of the bootstrap admin key (`AUTH_MODE=api_key`) |
   | `trainer-api-key` | API, workers | The platform worker key (`workerDefaults.apiKeySecretKey`, or per worker `workers.<name>.apiKeySecretKey`) |
   | `trainer-keys-json` | API | `TRAINER_KEYS_JSON`: per-pool worker keys scoped by job kind, `[{"label": "gpu", "sha256": "<hex>", "kinds": ["train"]}, ...]`. Store each pool's plaintext key under its own Secret key and point `workers.<name>.apiKeySecretKey` at it, so GPU pods can never claim imports or see workspace secrets. |
   | `secrets-key` | API | `GRAD_SECRETS_KEY`: 32 random bytes, base64, encrypting workspace secrets |
   | `inference-api-key`, `judge-api-key` | API | Keys for `evals.inferenceBaseUrl` and `evals.judgeBaseUrl` |
   | `cloud-service-token` | API | Cloud modes only |
   | `aws-access-key-id`, `aws-secret-access-key` | API | Static S3 keys (MinIO). Leave them out with EKS Pod Identity or IRSA. |

   ```bash
   kubectl create namespace grad
   kubectl -n grad create secret generic grad \
     --from-literal=database-url="postgres://..." \
     --from-literal=admin-api-key-hash="$(printf '%s' "$MY_ADMIN_KEY" | sha256sum | awk '{print $1}')" \
     --from-literal=trainer-api-key="$(openssl rand -hex 32)" \
     --from-literal=secrets-key="$(openssl rand -base64 32)"
   ```
   With External Secrets, sync the same keys into that Secret; no credential ever goes into values.
2. Install the chart:
   ```bash
   helm upgrade --install grad server/helm/grad --namespace grad \
     --set storage.s3Bucket=my-grad-artifacts \
     --set evals.inferenceBaseUrl=https://vllm.internal.example.com/v1
   ```
   Set `storage.s3Endpoint` for MinIO, R2 or another S3-compatible store (path-style addressing is used then). Give the API access to the bucket through its ServiceAccount (`serviceAccount.annotations`; EKS Pod Identity needs none) or the static keys above.
3. What gets installed:
   - **Migrations** run once per install and upgrade in a `pre-install,pre-upgrade` hook Job (`node dist/main.js migrate`; Argo CD runs it as a PreSync hook). The API replicas start with `MIGRATE_ON_BOOT=false` and refuse to serve a database with pending migrations. `migrations.enabled=false` makes every replica migrate at boot instead, under an advisory lock.
   - **API**: `api.replicaCount` (2) replicas with liveness, readiness and startup probes, a PodDisruptionBudget and resource requests and limits. Extra settings (for example `GRAD_EXTRA_MODELS_JSON` or `MAX_ATTEMPTS`) go in `api.env`.
   - **Workers**: `workers.train` claims only `train` jobs and requests `gpuCount` GPUs (`nodeSelector`/`tolerations` place it); `workers.import` is a small CPU pool that claims only `import` jobs, which are file imports and source syncs, the only jobs that carry workspace secrets such as provider keys and HF tokens. Each sets `GRAD_WORKER_KINDS` from `kinds`. Workers drain on SIGTERM within `terminationGracePeriodSeconds`: the current attempt is released, billed, requeued and resumed from its latest checkpoint. To sync from an observability tool on a private address, set `workers.import.env.GRAD_SOURCES_EGRESS_ALLOW` (CIDRs) and allow it in `networkPolicy.workerEgress`. `models.mirror` sets `GRAD_MODELS_MIRROR` (a directory or `s3://` prefix holding `<mirror>/<model id>/`) for air-gapped installs.
4. Optional:
   - `keda.enabled=true` (KEDA installed in the cluster) adds a ScaledObject per worker. Its query counts the open jobs of that worker's kinds, queued **and running**, so a scale-down never strands a running job. `keda.workers.train.minReplicaCount=0` scales GPUs to zero.
   - `networkPolicy.enabled=true` lets only this release's workers and `networkPolicy.apiIngressFrom` peers reach the API, and limits worker egress to DNS, the API and `networkPolicy.workerEgress` (default: HTTPS to public addresses only, never private ranges, CGNAT or link-local metadata endpoints). Add your S3 endpoint there if it is private.
   - `ingress.enabled=true` exposes the API.
5. Serve trained artifacts on vLLM or SGLang by downloading the verified `.grad.tar.gz` bundle:
   ```bash
   grad artifacts download support-sft@latest --output ./support-sft
   # Keep the verified bundle too (or only the bundle, without --output):
   grad artifacts download support-sft@latest --output ./support-sft --archive ./support-sft.grad.tar.gz
   ```
   `--output` extracts a PEFT directory (`adapter_config.json`, `adapter_model.safetensors`) after checking the bundle's SHA-256 and every file against its manifest.

`tests/helm/smoke.sh` installs the chart on a kind cluster with throwaway Postgres and MinIO (`server/helm/grad/ci/kind-values.yaml`) and checks a run end to end, including API pods being killed mid-run, an upgrade and an uninstall. CI runs it on every push.

## Retention

Checkpoints expire after the recipe's `checkpoint_ttl_days` (30 by default); the best and final checkpoints of every finished run never expire. Expired checkpoints and unused uploads are deleted by the server's maintenance loop. Promoting a checkpoint copies it into a new immutable artifact.
