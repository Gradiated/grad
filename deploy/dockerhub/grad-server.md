# grad-server

The [grad](https://github.com/Gradiated/grad) API server and web UI. grad turns your production traces into small models that do one job well: import traces and datasets, plan and run fine-tuning recipes (SFT, DPO, routers, reward models, embeddings, distillation), evaluate them and download the trained adapters. The server queues the work; [`gradiated/grad-trainer`](https://hub.docker.com/r/gradiated/grad-trainer) workers run it.

- Source: https://github.com/Gradiated/grad (`server/api`, `server/ui`)
- Docs: https://gradiated.com/docs/training/ and the [self-hosting guide](https://github.com/Gradiated/grad/blob/main/docs/SELF_HOSTING.md)
- License: MIT

## Usage

**Locally**, the `grad` CLI starts Postgres, this server on `127.0.0.1:18787` and a CPU trainer with Docker Compose, generates the keys and saves them in a `local` profile:

```bash
cargo install --locked --git https://github.com/Gradiated/grad grad-cli
grad local up                  # add --gpu for the CUDA trainer, --image-tag TAG for another build
export GRADIATED_PROFILE=local
grad models list
```

**Compose**: `grad local up` writes the compose file it uses to `$XDG_DATA_HOME/gradiated/local/docker-compose.yml`; [`server/docker-compose.yml`](https://github.com/Gradiated/grad/blob/main/server/docker-compose.yml) builds the same stack from a checkout.

**Kubernetes**: the Helm chart in [`server/helm/grad`](https://github.com/Gradiated/grad/tree/main/server/helm/grad) runs a migrations Job, two API replicas and GPU and CPU worker pools against your own Postgres and S3 bucket:

```bash
helm upgrade --install grad server/helm/grad --namespace grad --set storage.s3Bucket=my-grad-artifacts
```

## Tags

| Tag | What |
| --- | --- |
| `X.Y.Z` | A release (for example `0.2.0`) |
| `latest` | The newest stable release (prereleases don't move it) |
| `main` | The newest commit on `main` |
| `sha-<7>` | One commit on `main`, by its short SHA |

Images are built for linux/amd64 and linux/arm64 and carry an SBOM and a provenance attestation.

## Environment

The image listens on `0.0.0.0:8787` as the `node` user. The main settings (the [full list](https://github.com/Gradiated/grad/blob/main/docs/SELF_HOSTING.md#server-configuration)):

| Variable | Default | Notes |
| --- | --- | --- |
| `DATABASE_URL` | required | Postgres connection string; migrations run at boot unless `MIGRATE_ON_BOOT=false`. |
| `AUTH_MODE` | `api_key` | `api_key` requires `ADMIN_API_KEY_HASH`; `none` is for development on loopback only. |
| `ADMIN_API_KEY_HASH` | none | SHA-256 hex of the bootstrap admin key. |
| `TRAINER_API_KEY` | none | The key the trainer workers use. |
| `GRAD_SECRETS_KEY` | none | 32 random bytes, base64; encrypts workspace secrets. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT` | required, AWS default, AWS S3 | S3-compatible storage (AWS S3, SeaweedFS, MinIO, R2); workers and SDKs use presigned URLs. |
| `GRAD_INFERENCE_BASE_URL`, `GRAD_INFERENCE_API_KEY` | none | OpenAI-compatible endpoint for evals. |
| `GRAD_JUDGE_BASE_URL`, `GRAD_JUDGE_API_KEY` | the inference endpoint | Endpoint for judge rubric items. |
| `METRICS_ENABLED`, `METRICS_PORT`, `METRICS_TOKEN` | `true`, the API port, none | Prometheus metrics at `/metrics`. |
| `UI_ENABLED` | `true` | Serve the web UI at `/`. |
