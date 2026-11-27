# grad-trainer

The [grad](https://github.com/Gradiated/grad) training worker. It pulls jobs from a [`gradiated/grad-server`](https://hub.docker.com/r/gradiated/grad-server) API (fine-tuning runs, evals, dataset imports and source syncs), trains with PyTorch, checkpoints, and uploads the trained adapters. On SIGTERM it saves a checkpoint and hands the attempt back, and another worker resumes it.

- Source: https://github.com/Gradiated/grad (`server/trainer`)
- Docs: https://gradiated.com/docs/training/ and the [self-hosting guide](https://github.com/Gradiated/grad/blob/main/docs/SELF_HOSTING.md)
- License: MIT
- Mirror: `ghcr.io/gradiated/grad-trainer` (same images and tags)

## Usage

**Locally**, the `grad` CLI starts Postgres, the server and this worker with Docker Compose:

```bash
cargo install --locked --git https://github.com/Gradiated/grad grad-cli
grad local up                  # CPU trainer
grad local up --gpu            # add the CUDA trainer (NVIDIA Container Toolkit)
grad local up --dev-models     # tiny test models that train in seconds (try-it-out only)
```

**Compose**: `grad local up` writes the compose file it uses to `$XDG_DATA_HOME/gradiated/local/docker-compose.yml`; [`server/docker-compose.yml`](https://github.com/Gradiated/grad/blob/main/server/docker-compose.yml) builds the same stack from a checkout.

**Kubernetes**: the Helm chart in [`server/helm/grad`](https://github.com/Gradiated/grad/tree/main/server/helm/grad) runs a GPU `train` pool (the `-gpu` image) and a CPU `import` pool (the plain image), with optional KEDA scale-to-zero.

## Tags

| Tag | What |
| --- | --- |
| `X.Y.Z`, `X.Y.Z-gpu` | A release, CPU or CUDA |
| `latest`, `latest-gpu` | The newest stable release (prereleases don't move them) |
| `main`, `main-gpu` | The newest commit on `main` |
| `sha-<7>`, `sha-<7>-gpu` | One commit on `main`, by its short SHA |

The CPU image is built for linux/amd64 and linux/arm64, the CUDA image for linux/amd64. Every image carries an SBOM and a provenance attestation. The worker runs as UID 10001.

## Environment

| Variable | Default | Notes |
| --- | --- | --- |
| `GRAD_SERVER_URL` | `http://127.0.0.1:8787` | The grad-server URL, e.g. `http://grad-server:8787`. |
| `TRAINER_API_KEY` | required | The worker key the server was given. |
| `GRAD_WORKER_ID` | hostname and PID | A name prefix for this worker. Each process appends a random suffix, so a restarted worker takes a new attempt instead of re-entering its old one. |
| `GRAD_WORKER_KINDS` | `train,import` | Job kinds to claim; `import` jobs are the only ones that carry workspace secrets. |
| `GRAD_POLL_INTERVAL_S` | `1.0` | Seconds between polls for work. |
| `GRAD_WORKER_METRICS_PORT` | off | Serve Prometheus worker metrics on this port. |
| `GRAD_RECLAIM_GRACE_SECONDS` | `25` | Time to save a checkpoint after SIGTERM. |
| `GRAD_TERMINATION_NOTICE` | off | `aws` polls EC2 instance metadata for a termination notice. |
| `GRAD_MODELS_MIRROR` | none | A directory or `s3://` prefix holding base weights, for air-gapped installs. |
| `GRAD_SOURCES_EGRESS_ALLOW` | none | CIDRs a source sync or logger may reach on private addresses. |
| `GRAD_DEV_MODELS` | off | `1` builds the tiny `test/*` models on first use. |
| `HF_HOME` | `/home/grad/.cache/huggingface` | The Hugging Face cache; mount a volume to keep base weights. |
