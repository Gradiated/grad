# Self-Hosting Guide

Self-hosted `grad` needs only **PostgreSQL** and **S3-compatible object storage** (or a local directory for a single replica). Hosted serving (`deploy`, `/v1/route`, `/v1/embeddings`) is a Gradiated Cloud feature: on a self-hosted server those endpoints return `501 deploy_unavailable`; download artifacts and serve them on vLLM or SGLang instead.

## Local development (`grad local up`)

Start PostgreSQL, `grad-server` and a CPU `grad-trainer` worker:

```bash
grad local up
# Or with NVIDIA GPU acceleration:
grad local up --gpu
```

The API listens on `http://127.0.0.1:8787` (published on loopback only). The compose stack runs with `AUTH_MODE=none` for local development; the server logs a warning on every start because every request is then a platform admin.

```bash
export GRADIATED_BASE_URL=http://127.0.0.1:8787
grad models list
```

To run the local stack with authentication, set the bootstrap admin hash and a trainer key before `grad local up`:

```bash
export GRAD_AUTH_MODE=api_key
export GRAD_ADMIN_API_KEY_HASH=$(printf '%s' "$MY_ADMIN_KEY" | sha256sum | awk '{print $1}')
export GRAD_TRAINER_API_KEY=$(openssl rand -hex 32)   # shared by grad-server and grad-trainer
```

## Server configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Bind a non-loopback `HOST` explicitly (containers set `0.0.0.0`). |
| `AUTH_MODE` | `api_key` | `api_key` requires `ADMIN_API_KEY_HASH` (the server refuses to start without it). `none` must be set explicitly and is for development only. `cloud` delegates to Gradiated Cloud. |
| `ADMIN_API_KEY_HASH` | none | SHA-256 hex of the bootstrap admin key; use it to mint workspace keys with `POST /v1/keys`. |
| `TRAINER_API_KEY` or `TRAINER_API_KEY_HASH` | none | The platform trainer-worker key. Worker keys are not workspace keys: `admin` never implies `trainer:worker`, and `/v1/keys` cannot mint it. |
| `DATABASE_URL` | none (in-memory) | Migrations run at boot, versioned in `grad_schema_migrations` under an advisory lock, so several replicas can start at once. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` | none (local `STORAGE_DIR`) | Workers and SDKs upload and download through presigned URLs. Objects are written once under unique keys and never overwritten. |
| `STORAGE_DIR`, `BLOB_SIGNING_SECRET` | `.grad-data`, random | Local storage uses HMAC-signed `/blobs/*` URLs proxied by the server. Set the secret when replicas share a volume. |
| `DEPLOY_MODE` | `disabled` | `disabled` or `cloud`. The old `local` mode was removed. |
| `BILLING_MODE` | `noop` | `cloud` sends per-attempt usage (`run-usage:{run}:{attempt}`) from a retried outbox. |
| `INFERENCE_BASE_URL`, `INFERENCE_API_KEY` | none | OpenAI-compatible endpoint used by evals (your vLLM/SGLang with LoRA modules named by artifact id). Without it `POST /v1/evals` returns `501 inference_unavailable`. |
| `JUDGE_BASE_URL`, `JUDGE_API_KEY` | inference endpoint | Endpoint for `Judge` rubric items (`GRAD_JUDGE_BASE_URL` is accepted as an alias). |
| `GRAD_EXTRA_MODELS_JSON` | none | JSON array adding or overriding catalog models (the single price source for billing). |
| `MAX_ATTEMPTS` | `3` | Lease expiries tolerated before a job fails. |

## Production Kubernetes (Helm)

1. Create the secrets (`grad-postgres` with `database-url`; `grad-auth` with `admin-api-key-hash` and `trainer-api-key`, which both the API and the trainer read):
   ```bash
   ADMIN_HASH=$(printf '%s' "$MY_ADMIN_KEY" | sha256sum | awk '{print $1}')
   kubectl create secret generic grad-postgres --from-literal=database-url="postgres://..."
   kubectl create secret generic grad-auth \
     --from-literal=admin-api-key-hash="$ADMIN_HASH" \
     --from-literal=trainer-api-key="$(openssl rand -hex 32)"
   ```
2. Install the chart:
   ```bash
   helm upgrade --install grad server/helm/grad \
     --namespace grad --create-namespace \
     --set storage.s3Bucket=my-grad-artifacts \
     --set api.authMode=api_key \
     --set api.deployMode=disabled
   ```
3. Optional KEDA GPU scale-to-zero and air-gapped judge:
   ```bash
   helm upgrade --install grad server/helm/grad \
     --set keda.enabled=true \
     --set judge.baseUrl=https://vllm.internal.example.com/v1
   ```
   The KEDA query counts queued **and running** jobs, so a scale-down never strands a run mid-training. Trainers drain on SIGTERM: the current attempt is released (`abandoned`), billed and requeued, and resumes from its latest checkpoint.
4. Serve trained artifacts on vLLM or SGLang by downloading the verified `.grad.tar.gz` bundle:
   ```bash
   grad artifacts download support-sft@latest --out ./support-sft.grad.tar.gz
   ```

## Retention

Checkpoints expire after the recipe's `checkpoint_ttl_days` (30 by default); the best and final checkpoints of every finished run never expire. Expired checkpoints and unused uploads are deleted by the server's maintenance loop. Promoting a checkpoint copies it into a new immutable artifact.
