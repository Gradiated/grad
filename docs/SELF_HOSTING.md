# Self-Hosting Guide

Self-hosted `grad` needs only **PostgreSQL 17** and **S3-compatible object storage**: AWS S3, SeaweedFS, MinIO, Cloudflare R2 or another store with the S3 API. There is no local-disk mode; `grad local up` runs SeaweedFS, so a laptop stack stores data the same way production does. Hosted serving (`deploy`, `/v1/route`, `/v1/embeddings`) is a Gradiated Cloud feature: on a self-hosted server those endpoints return `501 deploy_unavailable`; download artifacts and serve them on vLLM or SGLang instead.

## Local development (`grad local up`)

`grad local up` starts PostgreSQL 17, SeaweedFS (the S3 store), a one-shot `migrate` service, `grad-server`, a CPU `grad-trainer` worker and a `grad-eval-worker` from published images: one API, one trainer worker for training and imports, and one eval worker (the `grad-server` image, because the trainer image has no Node). The compose file is built into the `grad` binary, so it works from any directory:

```bash
grad local up
# Or with NVIDIA GPU acceleration:
grad local up --gpu
# Plus Prometheus and Grafana with the grad dashboards (see Monitoring):
grad local up --observability
# Pull a specific build (see the tags below):
grad local up --image-tag sha-abc1234
# Build the images from a source checkout (uses server/docker-compose.yml):
grad local up --build
# Add tiny test models, to try training end to end on a laptop in seconds:
grad local up --dev-models
```

`--dev-models` registers `test/tiny-qwen3`, `test/tiny-qwen3-teacher` and `test/tiny-bert` in the catalog and sets `GRAD_DEV_MODELS=1` on the CPU trainer, which builds their randomly initialised weights on first use (a few seconds, no download) into its Hugging Face cache volume. Every recipe runs on them (`grad train --model test/tiny-qwen3 ...`), but they learn nothing useful: it is a try-it-out mode, and their artifacts carry `test_only: true` in the manifest.

### Images

The images are public on Docker Hub, so pulling them needs no login:

| Image | Platforms | Tags |
| --- | --- | --- |
| [`docker.io/gradiated/grad-server`](https://hub.docker.com/r/gradiated/grad-server) | linux/amd64, linux/arm64 | `X.Y.Z`, `latest`, `main`, `sha-<7>` |
| [`docker.io/gradiated/grad-trainer`](https://hub.docker.com/r/gradiated/grad-trainer) (CPU) | linux/amd64, linux/arm64 | `X.Y.Z`, `latest`, `main`, `sha-<7>` |
| [`docker.io/gradiated/grad-trainer`](https://hub.docker.com/r/gradiated/grad-trainer) (CUDA) | linux/amd64 | `X.Y.Z-gpu`, `latest-gpu`, `main-gpu`, `sha-<7>-gpu` |

GitHub Container Registry mirrors every tag at `ghcr.io/gradiated/grad-server` and `ghcr.io/gradiated/grad-trainer` (the same build, so the same digests). To use the mirror, set `GRAD_SERVER_IMAGE` / `GRAD_TRAINER_IMAGE` / `GRAD_TRAINER_GPU_IMAGE` for `grad local up`, or `api.image.repository` and `workerDefaults.image.repository` in the Helm values.

Every push to `main` that touches the server or trainer publishes `main` and `sha-<7>` (the commit's short SHA); the CUDA image is rebuilt on `main` only when the trainer changes. Each release publishes `X.Y.Z` and moves `latest` (prereleases don't). Every image carries an SBOM and a provenance attestation.

`grad local up` pulls the images first, so a moving tag like `main` stays current. A `grad` binary from a release (or `cargo install grad-cli`) pulls the images tagged with its own version; one built from a checkout pulls `main`. `--image-tag TAG` overrides that. If the pull is refused or the tag doesn't exist and you run `grad local up` inside a grad checkout, it builds the images from the checkout instead, as `--build` does, and says so; elsewhere the error names the tags that exist and suggests `--build` from a checkout.

The API and web UI listen on `http://127.0.0.1:18787` (published on loopback only). Before starting, `grad local up` checks every port it publishes: a busy default moves to a free port in 18790-18809 and one line says so (`18787 is in use (by another process); serving the API on 127.0.0.1:18790`), while a busy port you chose (`--port`, `GRAD_PORT`, `GRAD_GRAFANA_PORT`, `GRAD_PROMETHEUS_PORT`) fails with exit 2 and how to see what holds it (`lsof -i :PORT` or `ss -ltnp`). The ports of a stack that is already running are its own, not a clash. The choice is saved (`ports.json` beside the embedded compose file), so later runs keep the same URLs, and the `local` profile's `base_url` follows it, so the CLI, the SDKs and `grad ui` do too. The URLs on this page are the defaults; `grad local status` prints the real ones. Authentication is on: the first run generates an admin key, a trainer key and the key that encrypts workspace secrets (`GRAD_SECRETS_KEY`), and saves them in the `local` profile of the `grad` config file (`grad config path`); the server only receives the admin key's SHA-256. `grad local up` waits for `/health/ready` and prints the next steps:

```bash
export GRADIATED_PROFILE=local
grad models list
```

`grad local status` shows container status, API health and the API, web UI, Grafana and Prometheus URLs, `grad local logs [SERVICE] [--follow]` prints logs, `grad local down [--volumes]` stops the stack, and `grad local reset` deletes the local data and keys so the next `grad local up` starts fresh. Pass `--file` (or `GRAD_COMPOSE_FILE`) to use your own compose file; repeat `--file` (or separate the paths with `:`) to layer overrides on top, as `docker compose -f` does. `GRAD_SERVER_IMAGE` / `GRAD_TRAINER_IMAGE` / `GRAD_TRAINER_GPU_IMAGE` override the images (then `grad local up` doesn't pull first), and `GRAD_POSTGRES_MEMORY` / `GRAD_S3_MEMORY` / `GRAD_SERVER_MEMORY` / `GRAD_TRAINER_MEMORY` (default `1g` / `512m` / `1g` / `8g`) cap the containers' memory. Data lives in named volumes (Postgres, the S3 store and the trainer's Hugging Face cache), so it survives `grad local down` and is deleted by `grad local down --volumes`.

The stack is set up like the Helm chart. The `migrate` service runs `node dist/main.js migrate` (the chart's migrations Job) and exits; `grad-server` waits for it and starts with `MIGRATE_ON_BOOT=false`. `grad-server` gets the same `S3_*` variables as on Kubernetes. The workers have no S3 credentials: they move bytes through presigned URLs, as in production. SeaweedFS's only S3 key is generated by the first `grad local up` and saved in the `local` profile with the other keys; the store refuses to start without it. Its S3 API is published on `127.0.0.1:18786` (`GRAD_S3_PORT`; probed and remembered like the API port), because `grad import` and the SDKs PUT files to presigned URLs from your machine. `grad-server` signs those upload tickets for that address (`S3_PUBLIC_ENDPOINT`), while the workers use `http://seaweedfs:8333` inside the compose network.

`tests/compose/smoke.sh` boots the stack with `grad local up --build --dev-models` and runs the quickstarts (including the README's router on `examples/support_traces.jsonl`) through the CLI and the Python SDK; CI runs it on every push.

Running `server/docker-compose.yml` directly with `docker compose` defaults to `AUTH_MODE=none` for development; the server logs a warning on every start because every request is then a platform admin. To enable authentication there, set the bootstrap admin hash and a trainer key first:

```bash
export GRAD_AUTH_MODE=api_key
export GRAD_ADMIN_API_KEY_HASH=$(printf '%s' "$MY_ADMIN_KEY" | sha256sum | awk '{print $1}')
export GRAD_TRAINER_API_KEY=$(openssl rand -hex 32)   # shared by grad-server and grad-trainer
export GRAD_SECRETS_KEY=$(openssl rand -base64 32)    # encrypts workspace secrets; keep it with the data
```

## Web UI

`grad-server` serves a web UI at `/` for watching training, much like the Temporal UI for workflows: `http://127.0.0.1:18787/` after `grad local up` (which prints the URL; `grad local status` shows it later), `<base_url>/` from the harness (`ui_url`), and the API Service or ingress in Kubernetes. Run `grad ui` to open it signed in with your CLI profile (`grad ui RUN_ID` opens one run).

What it shows (read-mostly):

- **Runs**: every run with its status, phase, recipe, model, dataset version, cost against its cap and age, filterable by status and name.
- **Run detail**: a header with status, phase and attempt N/M; a lifecycle strip (queued, starting, training, uploading, done) with interruption and "waiting for a worker" notices; live loss and eval-loss, learning-rate, throughput and cost-versus-cap charts; checkpoints with a **Promote** button; the event timeline (phases, attempts, interruptions, resumes, warnings, checkpoints); the eval report for the run's recipe; the artifact with a download button and the `grad artifacts download` command; the resolved config as YAML; **Cancel** and **Resume** (optionally with a new cost cap).
- **Datasets**: versions, a record preview with merged scores, sources with their schedule, last sync status and last error plus a **Sync** button, and recent imports.
- **Evals**: summary tables with scores, 95% CIs, pass@k, the delta against the baseline, and failures.
- **Usage**: a date range (presets or from/to, UTC) with the total cost and tokens, a breakdown by kind (training, evals, dataset scoring, labeling, teacher answers), groups by day, week, month, model, recipe or kind, the top runs and evals, and the period's newest billed rows.
- **Health**: server readiness, the training and import worker pools (busy workers, `workers_online` while a run waits, autoscaling from zero) and the queue.

It is dark by default, in the Gradiated palette; the sun/moon button in the sidebar switches to the light theme (remembered per browser). It updates live from the run events stream.

How it works and what it can reach:

- It is a static build (`server/ui`, Vite + React + uPlot, about 130 KB gzipped, plus 120 KB of self-hosted OFL fonts: Inter, Instrument Sans and JetBrains Mono) baked into the image and served from memory: hashed `/assets/*` files are cached forever, `index.html` is revalidated, and any other browser navigation outside `/v1`, `/health/*` and `/metrics` returns `index.html`. Unknown `/v1` paths still answer with problem+json 404s.
- It calls only the public `/v1` API, with the viewer's API key, so a key sees exactly what it could see through the SDKs. It adds no endpoints.
- With `AUTH_MODE=none` there is no login. With `api_key`, paste a key on the login page; it is kept in that tab's `sessionStorage` only (never `localStorage` or cookies, so there is no CSRF surface) and is forgotten when the tab closes. `grad ui` hands the profile's key over once in a `#key=` URL fragment, which browsers never send to the server; the page moves it into `sessionStorage` and removes it from the address bar.
- Every UI response carries a strict Content-Security-Policy (`default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'`, nothing inline), `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy: no-referrer`.
- `UI_ENABLED=false` turns it off (it is off by default with `AUTH_MODE=cloud`); Helm sets it from `ui.enabled` (default `true`). The UI needs no extra exposure: keep the server on loopback or behind your ingress as before.

To work on it, run the API (for example `grad local up` or the harness) and `pnpm -C server/ui dev`, which proxies `/v1` to `GRAD_API` (default `http://127.0.0.1:18787`, the `grad local up` default). `pnpm -C server/ui check` runs the typecheck and component tests; `pnpm -C server/ui build` writes `server/ui/dist`, which a source checkout's `grad-server` serves too. `pnpm -C server/ui storybook` opens every component and page state (training, waiting for a GPU, interrupted, failed, empty, loading, error) against a fake server built from the test fixtures; CI runs `build-storybook`.

## Server configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Bind a non-loopback `HOST` explicitly (containers set `0.0.0.0`). |
| `AUTH_MODE` | `api_key` | `api_key` requires `ADMIN_API_KEY_HASH` (the server refuses to start without it). `none` must be set explicitly and is for development only; it refuses a non-loopback `HOST` unless `AUTH_MODE_NONE_ALLOW_REMOTE=true` (set by `server/docker-compose.yml`, whose port is published on loopback only). `cloud` delegates to Gradiated Cloud. |
| `ADMIN_API_KEY_HASH` | none | SHA-256 hex of the bootstrap admin key; use it to mint workspace keys with `POST /v1/keys`. |
| `TRAINER_API_KEY` or `TRAINER_API_KEY_HASH` | none | The platform trainer-worker key (every job kind), for `GRAD_WORKER_AUTH=static`. Worker keys are not workspace keys: `admin` never implies `trainer:worker`, and `/v1/keys` cannot mint it. |
| `TRAINER_KEYS_JSON` | none | Static worker keys scoped by job kind: `[{"label": "gpu", "sha256": "<hex>", "kinds": ["train"]}, ...]`. See [Worker authentication](#worker-authentication). |
| `GRAD_WORKER_AUTH` | `static` | How workers authenticate: a comma-separated list of `static`, `kubernetes`, `lease`, tried in order. |
| `GRAD_WORKER_K8S_SERVICE_ACCOUNTS` | none | `kubernetes` mode: service account to job kinds, `{"grad/grad-train-worker": ["train"], "grad/grad-import-worker": ["import"]}`. Required with `kubernetes`. |
| `GRAD_ORCHESTRATOR_KEYS_JSON` | none | `lease` mode: who may mint lease tokens, `[{"label": "gpu-fleet", "sha256": "<hex>", "kinds": ["train"]}]`. Accepted only on `INTERNAL_PORT`. |
| `INTERNAL_PORT` | off | Serve the internal routes (lease-token minting and revocation) on this port only, never on `PORT`. Needs `lease` in `GRAD_WORKER_AUTH` and an orchestrator key. |
| `DATABASE_URL` | required | PostgreSQL 17 connection string (on AWS, Amazon RDS or Aurora for PostgreSQL 17). Migrations run at boot, versioned in `grad_schema_migrations` under an advisory lock, so several replicas can start at once. |
| `MIGRATE_ON_BOOT` | `true` | `false` skips them and refuses to start while any is pending; run `node dist/main.js migrate` first (the Helm chart's migrations Job does). |
| `S3_BUCKET` | required | The bucket for datasets, checkpoints and artifacts. Workers and SDKs upload and download through presigned URLs. Objects are written once under unique keys and never overwritten. Credentials come from the AWS SDK's default chain (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, EKS Pod Identity, IRSA, an instance role). |
| `S3_REGION`, `S3_ENDPOINT` | AWS default, AWS S3 | `S3_ENDPOINT` points at another S3-compatible store (SeaweedFS, MinIO, R2); path-style addressing is used then. |
| `S3_PUBLIC_ENDPOINT` | `S3_ENDPOINT` | The address SDK clients reach the store at, when it differs from the server's and workers' (`grad local up`: `http://127.0.0.1:18786`). Only file-upload tickets (`POST /v1/uploads`) are signed for it. |
| `BILLING_MODE` | `noop` | `cloud` checks balances with Gradiated Cloud (a run of an exhausted workspace stops, resumable) and exports the usage ledger to it from Cloud's cursor. Self-hosted, `GET /v1/usage` lists the ledger (filter by `from`/`to`, `run_id`, `eval_id`, `kind`) and `GET /v1/usage/summary` totals a period (`grad usage`, `grad usage list`). |
| `GRAD_INFERENCE_BASE_URL` | none | The OpenAI-compatible endpoint the [eval workers](#eval-workers) call. grad-server never calls it: it only checks that it is set, so without it `POST /v1/evals` (and router labelling, distillation's teacher answers, `dataset.score()` with judges) returns `501 inference_unavailable`. Set the same URL on the API and the eval workers; the keys go to the eval workers only. |
| `GRAD_JUDGE_BASE_URL` | inference endpoint | The endpoint for `Judge` rubric items (the same split). The unprefixed `INFERENCE_*` and `JUDGE_*` names still work, with a deprecation warning at startup. |
| `GRAD_EXTRA_MODELS_JSON` | none | JSON array adding or overriding catalog models (the single price source for billing). |
| `GRAD_JUDGE_MODELS_JSON` | none | JSON array of extra judge models with prices, e.g. `[{"id": "anthropic/claude-sonnet-5-5", "price_per_million_tokens_usd": 3}]`. A `Judge` must name a catalog model, one of these, or an artifact of the eval's workspace (priced at its base model); anything else is `422 unknown_judge_model`, so every judge call is billed. |
| `MAX_ATTEMPTS` | `10` | Attempts that may end without a result (a lost worker, a worker error, out of GPU memory) before a job fails. |
| `MAX_PREEMPTIONS` | `20` | Attempts that may end because the worker's compute was reclaimed (SIGTERM or a termination notice). They don't count toward `MAX_ATTEMPTS`. |
| `GRAD_MAX_RUNNING_PER_WORKSPACE_TRAIN`, `_IMPORT`, `_EVAL` | `8` each | Jobs of that kind one workspace may run at once. Past it, the workspace's next jobs stay queued (its runs say "Queued: workspace concurrency limit (8 running)") while other workspaces' jobs go on. See [Queue fairness](#queue-fairness). |
| `GRAD_MAX_QUEUED_PER_WORKSPACE` | `500` | Queued jobs (runs, imports and evals together) one workspace may have. Past it, creating a run, import or eval answers `429 queue_limit`; source syncs are exempt (one per source at a time). |
| `USAGE_FLUSH_TOKENS` / `USAGE_FLUSH_SECONDS` | `1000000` / `300` | A running attempt appends a usage row (GET /v1/usage) whenever this many tokens or seconds are unbilled, at each checkpoint, and when it ends. A worker killed outright is billed up to its last progress report. |
| `JOB_EVENT_RETENTION_DAYS` | `90` | Days job events (training metrics) are kept; older ones are deleted by the maintenance tick. |
| `ORPHAN_BLOB_DAYS` | `7` | Days a job blob that nothing references (a checkpoint a crashed worker uploaded but never registered, a staged import part whose delete was interrupted) is kept before the maintenance tick deletes it. |
| `SSE_POLL_MS` | `2000` | Run event streams (`/v1/runs/{id}/events` and `/metrics` over SSE) share one reader per replica: it fetches new events when Postgres notifies it (LISTEN on a connection of its own, NOTIFY from triggers on `grad_job_events` and `grad_jobs`) and re-reads every followed run this often in case a notification was missed. Behind a transaction-pooling PgBouncer notifications never arrive, so streams lag by up to this interval; give grad-server a direct or session-mode connection. |
| `METRICS_ENABLED` | `true` | Serve Prometheus metrics at `/metrics` and the queue depth at `/metrics/queue` (see [Monitoring](#monitoring)). |
| `METRICS_PORT` | the API port | Serve them on this port instead, so they stay off the public listener. |
| `METRICS_TOKEN` | none | Require `Authorization: Bearer <token>` on both. |
| `METRICS_WORKSPACE_LABEL` | `false` | Add `grad_workspace_jobs{workspace}`. Only for installs with a handful of workspaces. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none (tracing off) | Export OpenTelemetry traces over OTLP/HTTP. The standard `OTEL_*` variables apply (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_SDK_DISABLED`). |
| `UI_ENABLED` | `true` (`false` with `AUTH_MODE=cloud`) | Serve the [web UI](#web-ui) at `/`. |
| `UI_DIR` | the image's `/app/ui`, else `server/ui/dist` | A built `server/ui` directory to serve. |

### Queue fairness

Runs, imports and evals share one queue in Postgres. When a worker claims, the server picks, among the workspaces below their running cap for that job kind, the one with the fewest running jobs of the kind (ties go to the workspace whose next job is older), then that workspace's oldest queued job the worker can run. A workspace that queues 50 runs therefore doesn't hold up another's 2: with 4 workers, both of the small workspace's runs start in the first round. A claim is one transaction under a per-kind advisory lock with `FOR UPDATE SKIP LOCKED` on the row, so caps hold across every API replica and worker; with 10,000 queued jobs over 100 workspaces it takes about 5 ms.

GPU workers send their GPU memory with each claim (`nvidia-smi`, or `GRAD_WORKER_GPU`), and get only runs whose plan's `min_gpu_memory_gb` fits; CPU workers aren't filtered. A run no online worker can fit stays queued and says why ("Waiting for a GPU with ≥46 GB; online workers have 24 GB"), and `grad_jobs_unfit` counts such runs. Every queued run carries `queue_position` (about how many runs start before it, counting other workspaces' fair share) and `queue_message`, which `grad train`, the TUI and the web UI show.

### Worker authentication

Workers (`grad-trainer` and the eval worker) send a bearer token with every worker-protocol request (`/v1/trainer-jobs/*`). They read it from `GRAD_WORKER_TOKEN`, else from the file named by `GRAD_WORKER_TOKEN_FILE`, else `TRAINER_API_KEY`. The file is re-read on every request (and once more after a 401), so a rotated token takes effect without a restart. Workers never log the token. A worker token is not a workspace key: it grants only the `trainer:worker` scope for some job kinds, and `admin` never implies it.

grad-server checks the token with each authenticator in `GRAD_WORKER_AUTH`, in order, and the first one that recognises it wins. When one cannot decide (the Kubernetes API is unreachable) and no other matches, the request fails with `503 worker_auth_unavailable`, never with a match or a 401.

| Mode | The token | Use it for |
| --- | --- | --- |
| `static` (default) | A key whose SHA-256 is in `TRAINER_KEYS_JSON` (its `kinds`) or is `TRAINER_API_KEY(_HASH)` (every kind). Every configured hash is compared in constant time. | `grad local up`, docker compose, a few VMs. The keys never expire: to rotate one, add the new hash, restart the workers with the new key, then remove the old hash. |
| `kubernetes` | The pod's projected service-account token with audience `grad`. grad-server sends it to the TokenReview API using its own in-cluster credentials and maps the reviewed `system:serviceaccount:<namespace>:<name>` to kinds through `GRAD_WORKER_K8S_SERVICE_ACCOUNTS`. | Helm (the chart's default). There is nothing to store or rotate: a token lives an hour and the kubelet refreshes the file. |
| `lease` | `gradwt_` plus 256 random bits, minted by an orchestrator for one host and lease. It is bound to that host and limited to some kinds and a GPU size, and it expires with the lease. | A system that lends hosts to grad for a while, such as Gradiated Cloud's GPU fleet operator. |

**kubernetes.** Only tokens shaped like a JWT are sent for review, so static keys and lease tokens never leave grad-server. A token of another audience, an account that is not mapped, or a user that is not a service account gets a 401. A successful review is reused for 60 seconds at most, and never after the token's `exp`. grad-server needs RBAC to create `tokenreviews.authentication.k8s.io` and nothing else; the chart's ClusterRole grants exactly that.

**lease.** The orchestrator calls grad-server's internal listener (`INTERNAL_PORT`; off by default, never the public port) with a key from `GRAD_ORCHESTRATOR_KEYS_JSON`. Workspace and worker keys are refused there.

```http
POST /internal/v1/worker-tokens
Authorization: Bearer <orchestrator key>
{"host_id": "gpu-host-17", "lease_id": "lease-8c1f", "kinds": ["train"], "gpu_memory_gb": 80, "expires_at": "2026-11-28T06:00:00Z"}

201 {"token": "gradwt_...", "host_id": "gpu-host-17", "lease_id": "lease-8c1f", "kinds": ["train"], "gpu_memory_gb": 80, "expires_at": "2026-11-28T06:00:00.000Z"}

DELETE /internal/v1/worker-tokens/lease-8c1f
200 {"lease_id": "lease-8c1f", "revoked": 1}
```

The token is returned once; grad-server stores only its SHA-256 (`grad_worker_tokens`). `host_id` allows letters, digits, `.`, `_` and `-`. `kinds` must be within the orchestrator key's `kinds` (else `403 job_kind_forbidden`). `expires_at` must be in the future and at most 7 days ahead. To extend a lease, mint a new token for the same lease and write it to the worker's `GRAD_WORKER_TOKEN_FILE`. An orchestrator can revoke only tokens it minted, and revoking is idempotent. On every request grad-server checks the following:

- The token has not expired and has not been revoked (else 401).
- The claim asks only for the token's kinds (`403 job_kind_forbidden`).
- The claim's `worker_id` is the `host_id`, or the `host_id` followed by `-` and an alphanumeric suffix of up to 32 characters (`403 worker_host_mismatch`). Start the trainer with `GRAD_WORKER_ID=<host_id>`; it appends a random `-<6 hex>` for each process.
- The GPU memory the claim reports is no more than `gpu_memory_gb` (`403 gpu_memory_exceeds_token`). Claims are filtered as if the worker had at most that much, including a claim that reports no GPU.

Revoke after the worker has drained. A revoked token's next request gets a 401 and the worker stops; any lease it still held expires and its job is requeued. The maintenance tick deletes expired tokens.

### Object storage

Every upload is a presigned PUT whose signature binds `Content-Length` and `x-amz-checksum-sha256`, so the store refuses any other length or body. To commit an upload, grad-server HEADs the object and checks its SHA-256 itself: it uses the checksum the store reports, or else streams and hashes the object. So even a backend that ignored the checksum header could not commit the wrong bytes. Server writes use `If-None-Match: *`, so an object is never overwritten.

These checks have been verified on two backends:

- **SeaweedFS 4.47** enforces all of them. The server's storage contract suite and the live stacks run on it every time (`server/api/test/storage-contract.test.ts`), and so do `grad local up` and the kind smoke test.
- **MinIO** passed the same suite while it was the CI backend.

AWS S3 documents the same behaviour. grad uses no multipart uploads, range GETs, CopyObject or bucket lifecycle rules. The maintenance tick deletes staged import files under `uploads/` after 7 days, and job blobs that no record references.

## Eval workers

Evals, `dataset.score()`, router labelling, distillation's teacher answers and recipe checkpoint evals are `eval` jobs on the job queue. grad-server creates them, prices and bills what they generate, aggregates them and serves the results; it makes no model or judge calls, so a deploy or restart of the API never interrupts an eval. They run on eval workers, a second entrypoint of the `grad-server` image:

```bash
node dist/main.js worker --kinds eval
```

An eval worker claims eval jobs over the same worker protocol as the trainer workers, with a lease it renews by heartbeat. It downloads the eval's pinned dataset version, generates and scores each (task, model, sample) against the endpoints below with the built-in validators, regexes (in a sandboxed thread with a timeout) and judges, and posts the outputs in batches. Each output is stored once per (eval, model, task, sample), so a re-sent batch is a no-op, and grad-server prices it at the prices resolved when the eval was planned and bills the attempt as it goes. Code scorers still run in the SDK (`awaiting_scores`), unchanged. On SIGTERM the worker posts what is in flight and hands the eval back (counted toward `MAX_PREEMPTIONS`); a worker that dies loses its lease, and the next attempt resumes after the outputs already stored. Cancelling an eval stops its worker at the next batch, and the outputs in flight are still billed.

| Variable | Default | Notes |
| --- | --- | --- |
| `GRAD_SERVER_URL` | `http://127.0.0.1:8787` | The API. |
| `TRAINER_API_KEY` | none | A worker key that may claim `eval` jobs (the platform key, or a `TRAINER_KEYS_JSON` key whose `kinds` include `eval`). Eval jobs carry no workspace secrets. |
| `GRAD_INFERENCE_BASE_URL`, `GRAD_INFERENCE_API_KEY` | none | OpenAI-compatible endpoint for the models under eval (your vLLM/SGLang with LoRA modules named by artifact id). Every call carries `X-Grad-Workspace: <workspace id>`: artifact ids are unique only per workspace, so an endpoint shared by several workspaces must serve and bill by (workspace, model). Without it the worker still runs validators, regexes and code scorers, and says so at startup. |
| `GRAD_JUDGE_BASE_URL`, `GRAD_JUDGE_API_KEY` | inference endpoint | Endpoint for `Judge` rubric items. `grad local up` passes all four from your shell. |
| `EVAL_CONCURRENCY` | `8` | Model calls in flight per worker. |
| `GRAD_WORKER_ID` | hostname | Shown in leases and logs; a per-process suffix is appended. |
| `GRAD_LEASE_SECONDS` / `GRAD_POLL_INTERVAL_S` | `180` / `1` | Lease length (heartbeats every third of it) and the idle poll interval. |

`grad_eval_outputs_total` and `grad_eval_judge_calls_total` stay on grad-server's `/metrics`: each batch reports its model and judge calls, so eval workers need no scrape. On the API, `GRAD_INFERENCE_API_KEY`, `GRAD_JUDGE_API_KEY` and `EVAL_CONCURRENCY` are ignored with a startup warning.

## Production Kubernetes (Helm)

The chart (`server/helm/grad`) runs two or more API replicas, a migrations Job and two pull-based worker pools. It needs your own Postgres and an S3-compatible bucket; the chart refuses to render without `storage.s3Bucket`, because replicas and workers share artifacts through presigned S3 URLs.

1. Create one Secret (`secret.name`, default `grad`). Pods read only the keys they need, and every key except `database-url` is optional:

   | Key | Used by | Purpose |
   | --- | --- | --- |
   | `database-url` | API, migrations Job | PostgreSQL 17 connection string |
   | `admin-api-key-hash` | API | SHA-256 hex of the bootstrap admin key (`AUTH_MODE=api_key`) |
   | `trainer-api-key` | API, workers | `workers.auth=static` only: the platform worker key (`workerDefaults.apiKeySecretKey`, or per worker `workers.<name>.apiKeySecretKey`) |
   | `trainer-keys-json` | API | `workers.auth=static` only: `TRAINER_KEYS_JSON`, per-pool worker keys scoped by job kind, `[{"label": "gpu", "sha256": "<hex>", "kinds": ["train"]}, ...]`. Store each pool's plaintext key under its own Secret key and point `workers.<name>.apiKeySecretKey` at it, so GPU pods can never claim imports or see workspace secrets. |
   | `secrets-key` | API | `GRAD_SECRETS_KEY`: 32 random bytes, base64, encrypting workspace secrets |
   | `inference-api-key`, `judge-api-key` | eval workers | Keys for `evals.inferenceBaseUrl` and `evals.judgeBaseUrl` |
   | `metrics-token` | API, Prometheus, KEDA | Bearer token for `/metrics` and `/metrics/queue` with `metrics.requireToken=true` |
   | `cloud-service-token` | API | Cloud modes only |
   | `aws-access-key-id`, `aws-secret-access-key` | API | Static S3 keys (SeaweedFS, MinIO, R2). Leave them out with EKS Pod Identity or IRSA. |

   ```bash
   kubectl create namespace grad
   kubectl -n grad create secret generic grad \
     --from-literal=database-url="postgres://..." \
     --from-literal=admin-api-key-hash="$(printf '%s' "$MY_ADMIN_KEY" | sha256sum | awk '{print $1}')" \
     --from-literal=secrets-key="$(openssl rand -base64 32)"
   ```
   With External Secrets, sync the same keys into that Secret; no credential ever goes into values.
2. Install the chart:
   ```bash
   helm upgrade --install grad server/helm/grad --namespace grad \
     --set storage.s3Bucket=my-grad-artifacts \
     --set evals.inferenceBaseUrl=https://vllm.internal.example.com/v1
   ```
   Set `storage.s3Endpoint` for SeaweedFS, MinIO, R2 or another S3-compatible store (path-style addressing is used then), and `storage.s3PublicEndpoint` when SDK clients outside the cluster reach that store at another address (they PUT `grad import` files to presigned URLs). Give the API access to the bucket through its ServiceAccount (`serviceAccount.annotations`; EKS Pod Identity needs none) or the static keys above.
3. What gets installed:
   - **Migrations** run once per install and upgrade in a `pre-install,pre-upgrade` hook Job (`node dist/main.js migrate`; Argo CD runs it as a PreSync hook). The API replicas start with `MIGRATE_ON_BOOT=false` and refuse to serve a database with pending migrations. `migrations.enabled=false` makes every replica migrate at boot instead, under an advisory lock.
   - **API**: `api.replicaCount` (2) replicas with liveness, readiness and startup probes, a PodDisruptionBudget and resource requests and limits. Extra settings (for example `GRAD_EXTRA_MODELS_JSON` or `MAX_ATTEMPTS`) go in `api.env`; `api.queue` sets the per-workspace caps (`maxRunningPerWorkspace.{train,import,eval}`, `maxQueuedPerWorkspace`).
   - **Worker authentication** (`workers.auth`, see [Worker authentication](#worker-authentication)): with `kubernetes`, the default, each pool runs as its own ServiceAccount (`<release>-train-worker`, `<release>-import-worker`) and mounts a projected token for audience `grad` that lasts 3600 s, at `/var/run/secrets/grad/worker/token` (`GRAD_WORKER_TOKEN_FILE`). The pods get no Kubernetes API token. grad-server maps each account to its pool's `kinds` (`GRAD_WORKER_K8S_SERVICE_ACCOUNTS`) and may only create TokenReviews (a ClusterRole and binding). With `static`, the chart generates one key per pool, scoped to the pool's kinds (`TRAINER_KEYS_JSON`), and all pools share the `workerServiceAccount`.
   - **Training priority**: pools with `lowPriority: true` (`workers.train` by default) run under the PriorityClass `trainingPriorityClass.name` (default `<release>-training-low`). Its value is -10, below the default priority of 0, and its `preemptionPolicy` is `Never`. So when the cluster is full, your own workloads (inference, say) preempt training, and training never preempts anything. A preempted worker gets SIGTERM, saves a checkpoint and its run resumes on another worker. PriorityClasses are cluster-scoped: with several releases, create it in one (`trainingPriorityClass.create=false` and the same `name` in the others). Set `trainingPriorityClass.enabled=false` to run training at the default priority.
   - **Workers**: `workers.train` claims only `train` jobs and requests `gpuCount` GPUs (`nodeSelector`/`tolerations` place it); `workers.import` is a small CPU pool for `import` jobs, which are file imports and source syncs, the only jobs that carry workspace secrets such as provider keys and HF tokens, and `eval` jobs. Each trainer container sets `GRAD_WORKER_KINDS` from `kinds`; a pool whose `kinds` include `eval` also runs a `grad-eval-worker` container (the `grad-server` image, `node dist/main.js worker --kinds eval`) with the pool's worker key, `evals.inferenceBaseUrl`/`evals.judgeBaseUrl`, their Secret keys, `evals.concurrency` and `evals.workerResources`. A GPU pool refuses kind `eval`, and the release notes warn when no pool runs evals. Workers drain on SIGTERM: if the next step and a checkpoint fit in `GRAD_RECLAIM_GRACE_SECONDS` (25), the worker saves a checkpoint of the current step first; then the attempt is billed, handed back and requeued at once, and a new worker resumes from that checkpoint. On Kubernetes a node termination handler delivers that SIGTERM; on a plain EC2 host, `GRAD_TERMINATION_NOTICE=aws` makes the worker poll the instance metadata (IMDSv2) for a termination notice and treat it like SIGTERM (the chart's network policy blocks the metadata endpoint). To sync from an observability tool on a private address, set `workers.import.env.GRAD_SOURCES_EGRESS_ALLOW` (CIDRs) and allow it in `networkPolicy.workerEgress`; recipe `loggers=` (W&B, MLflow) go through the same guard on the train workers, so a private MLflow server needs `workers.train.env.GRAD_SOURCES_EGRESS_ALLOW`. A source sync stops after `GRAD_SOURCES_SYNC_MAX_SECONDS` (default 3600) and every provider response after 120 s of wall-clock time, so a slow host can't hold an import worker. `models.mirror` sets `GRAD_MODELS_MIRROR` (a directory or `s3://` prefix holding `<mirror>/<model id>/`) for air-gapped installs.
4. Optional:
   - `keda.enabled=true` (KEDA installed in the cluster) adds a ScaledObject per worker. It scales on the open jobs of that worker's kinds, queued **and running**, so a scale-down never strands a running job. `keda.workers.train.minReplicaCount=0` scales GPUs to zero. See [KEDA](#keda) for its two trigger modes; neither needs database credentials.
   - `networkPolicy.enabled=true` lets only this release's workers and `networkPolicy.apiIngressFrom` peers reach the API, and limits worker egress to DNS, the API and `networkPolicy.workerEgress` (default: HTTPS to public addresses only, never private ranges, CGNAT or link-local metadata endpoints). Add your S3 endpoint there if it is private, and an in-cluster inference or judge endpoint to `networkPolicy.inferenceEgress`.
   - `ingress.enabled=true` exposes the API and the [web UI](#web-ui), which share the `/` path on the API Service; `ui.enabled=false` serves only the API.
5. Serve trained artifacts on vLLM or SGLang by downloading the verified `.grad.tar.gz` bundle:
   ```bash
   grad artifacts download support-sft@latest --output ./support-sft
   # Keep the verified bundle too (or only the bundle, without --output):
   grad artifacts download support-sft@latest --output ./support-sft --archive ./support-sft.grad.tar.gz
   ```
   `--output` extracts a PEFT directory (`adapter_config.json`, `adapter_model.safetensors`) after checking the bundle's SHA-256 and every file against its manifest.

`tests/helm/smoke.sh` installs the chart on a kind cluster with throwaway Postgres and SeaweedFS (`server/helm/grad/ci/kind-values.yaml`) and checks a run end to end, including API pods being killed mid-run, an upgrade and an uninstall. It also checks worker authentication by service account: each pool's token claims only its own kinds, a token for another audience or an unmapped account is refused, grad-server may only create TokenReviews, and the train pool runs under the training PriorityClass. CI runs it on every push.

## Monitoring

grad-server exports Prometheus metrics with a `grad_` prefix at `/metrics`: HTTP requests and latency by route template, open jobs and the oldest queued job per kind (train, import, sync, eval), claim latency, job durations, attempts and requeues by reason, workers online with their phase, tokens/s and GPU memory, training tokens, billed tokens and cost, checkpoints and uploads, eval outputs and judge calls, source syncs, failures and pauses by provider, dataset bytes, import records, maintenance steps, usage-flush lag, the Postgres pool and storage operations, plus the default process metrics. [METRICS.md](METRICS.md) lists every metric with its labels; it is generated from the code (`pnpm -C server/api metrics:docs`). Labels never carry run, dataset or workspace ids. Gauges read from Postgres are sampled by the maintenance tick every 15 seconds, so a scrape never queries the database, and they are the same on every replica: aggregate them with `max`.

Each worker with `GRAD_WORKER_METRICS_PORT` set serves its own metrics (`grad_trainer_*`: phase, step time, tokens/s, GPU utilisation and memory, checkpoint and upload times). Workers also send their phase, tokens/s and GPU memory in every heartbeat, so the server's `grad_worker_*` gauges cover pools Prometheus can't scrape.

### Locally

`grad local up --observability` adds Prometheus (`127.0.0.1:18789`, 512 MB, 7 days of data) and Grafana (`127.0.0.1:18788`, 768 MB) with the three dashboards provisioned, and prints the Grafana URL. Anyone on the machine can view; sign in as `admin` (password `GRAD_GRAFANA_PASSWORD`, default `admin`) to edit. `GRAD_PROMETHEUS_PORT`, `GRAD_GRAFANA_PORT`, `GRAD_PROMETHEUS_MEMORY` and `GRAD_GRAFANA_MEMORY` change the defaults. `grad local down` stops them too.

### Kubernetes

The chart serves `/metrics` on a separate `metrics` port of the API Service (`metrics.port`, 9464) and sets `GRAD_WORKER_METRICS_PORT` on workers (`metrics.workerPort`, 9465; `0` turns it off). With prometheus-operator (kube-prometheus-stack):

```yaml
metrics:
  requireToken: true # the chart generates `metrics-token` (or set secret.metricsToken); monitors and KEDA send it
  serviceMonitor: { enabled: true, labels: { release: kube-prometheus-stack } }
  podMonitor: { enabled: true, labels: { release: kube-prometheus-stack } }
  prometheusRule: { enabled: true, labels: { release: kube-prometheus-stack } }
  grafanaDashboards: { enabled: true }
```

With `networkPolicy.enabled`, `metrics.allowFrom` says who may reach the metrics ports.

### Dashboards

[`deploy/grafana/`](../deploy/grafana) holds three dashboards, generated by `node deploy/grafana/generate.mjs`: **Overview** (API health, queue, workers, throughput, errors), **Training** (runs by status, durations, tokens/s, interruptions, checkpoints, GPU) and **Evals & Sources**. Each takes its data source as a `${DS_PROMETHEUS}` input, so it imports into any Grafana; `metrics.grafanaDashboards.enabled` loads them as ConfigMaps labelled `grafana_dashboard: "1"` for the Grafana sidecar. A test checks that every query names an exported metric and label.

### Alerts

`metrics.prometheusRule.enabled` adds a PrometheusRule:

| Alert | Fires when | Setting |
| --- | --- | --- |
| `GradApiErrorRateHigh` | More than 5% of API requests return 5xx over 5 minutes | `error5xxRatio` |
| `GradJobQueuedTooLong` | The oldest claimable job of a kind has waited 30 minutes | `oldestQueuedSeconds` |
| `GradNoWorkersForQueuedJobs` | Jobs are queued and no worker of their pool is online | |
| `GradSourcePaused` | A source was paused after repeated sync failures | |
| `GradUsageFlushLagging` | A running attempt has written no usage row for 15 minutes | `usageFlushLagSeconds` |

### KEDA

`keda.trigger` picks one of two modes:

- `prometheus` (the default) scales each pool on `grad_jobs_open` for its kinds from your Prometheus; set `keda.prometheus.serverAddress` (for example `http://prometheus-operated.monitoring.svc:9090`) and, if your series aren't labelled the prometheus-operator way, `keda.prometheus.selector`.
- `metrics-api` for clusters without Prometheus: KEDA polls grad-server's `/metrics/queue?kinds=...` directly (JSON with `open`, `queued`, `waiting_for_compute` and `running`).

Queued jobs that wait on their own workspace's running cap don't count as open (they are `grad_jobs_over_workspace_limit`), so one workspace's backlog can't scale the pool past what it may run.

Both send `metrics-token` when `metrics.requireToken` is on, and neither needs database credentials.

### Tracing and logs

Tracing is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set. grad-server then exports spans for HTTP requests, Postgres queries and storage operations, and passes a W3C `traceparent` to the worker in the job payload, so one trace links a run's creation, claim, training and completion. Logs are JSON lines carrying `request_id`, `trace_id` and `job_id` where they apply.

## Retention

Checkpoints expire after the recipe's `checkpoint_ttl_days` (30 by default); the best and final checkpoints of every finished run never expire. Expired checkpoints and unused uploads are deleted by the server's maintenance loop. Promoting a checkpoint copies it into a new immutable artifact.
