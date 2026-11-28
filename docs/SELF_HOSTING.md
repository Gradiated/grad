# Self-Hosting Guide

Self-hosted `grad` needs only **PostgreSQL 17** and **S3-compatible object storage**: AWS S3, SeaweedFS, MinIO, Cloudflare R2 or another store with the S3 API. There is no local-disk mode; `grad local up` runs SeaweedFS, so a laptop stack stores data the same way production does. Hosted serving (publishing an artifact as a model version, routing, embeddings) is a Gradiated Cloud feature with its own API; grad-server has no serving endpoints. Self-hosted, download artifacts and serve them on vLLM or SGLang.

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
# Add tiny test models, to try training and evals end to end on a laptop in seconds:
grad local up --dev-models
```

`--dev-models` registers `test/tiny-qwen3`, `test/tiny-qwen3-teacher` and `test/tiny-bert` in the catalog and sets `GRAD_DEV_MODELS=1` on the CPU trainer, which builds their randomly initialised weights on first use (a few seconds, no download) into its Hugging Face cache volume. Every recipe runs on them (`grad train --model test/tiny-qwen3 ...`), but they learn nothing useful: it is a try-it-out mode, and their artifacts carry `test_only: true` in the manifest.

`--dev-models` also starts `grad-dev-inference` (the compose profile `dev-models`; the trainer image's `grad-dev-inference` command), a CPU OpenAI-compatible `/v1/chat/completions` endpoint, and points the API's and the eval worker's `GRAD_INFERENCE_BASE_URL` and `GRAD_JUDGE_BASE_URL` at it, so evals, `dataset.score()` with judges and distillation's teacher answers work with no extra flags. It serves the names the eval worker sends (see [Eval workers](#eval-workers)):

- `test/tiny-qwen3` and `test/tiny-qwen3-teacher`, by catalog id;
- `peft_lora` and `merged_safetensors` artifacts trained on them, by artifact id (`name@version`): it downloads each from grad-server with the `local` profile's key, checks its sha256 and that the artifact belongs to the call's `X-Grad-Workspace`, and loads it on first use (the four most recent stay loaded);
- `test/tiny-judge`, a judge registered with `GRAD_JUDGE_MODELS_JSON`: it replies `{"score": x}`, where `x` is the word-overlap F1 of the judged response with the task's reference answer (1 for any non-empty response when there is none). It is deterministic and reads nothing else.

Anything else (a catalog model such as `qwen/qwen3-8b`, a router or encoder artifact, a checkpoint id from recipe `evals=`) is refused with `404 model_not_found` or `400 model_not_supported`, which the eval records as that output's error. It generates one completion at a time (the eval worker runs `EVAL_CONCURRENCY=2` here), at most `GRAD_DEV_INFERENCE_MAX_TOKENS` (64) new tokens, and keeps a prompt's last tokens that fit the dev models' 512-token context; the outputs of random weights are noise, so the scores check the pipeline, not a model. It is not published on a host port. To eval against your own server instead, export `GRAD_INFERENCE_BASE_URL` (and `GRAD_JUDGE_BASE_URL`, `GRAD_JUDGE_MODELS_JSON`) before `grad local up --dev-models`: what your shell sets wins.

```bash
printf -- '- name: overlap\n  kind: judge\n  model: test/tiny-judge\n' > rubric.yaml
grad eval --name sft-vs-base --models support-sft@latest,test/tiny-qwen3 --dataset support-prod \
  --rubric rubric.yaml --limit 20 --baseline test/tiny-qwen3 --wait
```

### Images

The images are public on Docker Hub, so pulling them needs no login:

| Image | Platforms | Tags |
| --- | --- | --- |
| [`docker.io/gradiated/grad-server`](https://hub.docker.com/r/gradiated/grad-server) | linux/amd64, linux/arm64 | `X.Y.Z`, `latest`, `main`, `sha-<7>` |
| [`docker.io/gradiated/grad-trainer`](https://hub.docker.com/r/gradiated/grad-trainer) (CPU) | linux/amd64, linux/arm64 | `X.Y.Z`, `latest`, `main`, `sha-<7>` |
| [`docker.io/gradiated/grad-trainer`](https://hub.docker.com/r/gradiated/grad-trainer) (CUDA) | linux/amd64 | `X.Y.Z-gpu`, `latest-gpu`, `main-gpu`, `sha-<7>-gpu` |

To pull from your own registry mirror, set `GRAD_SERVER_IMAGE` / `GRAD_TRAINER_IMAGE` / `GRAD_TRAINER_GPU_IMAGE` for `grad local up`, or `api.image.repository` and `workerDefaults.image.repository` in the Helm values.

Every push to `main` that touches the server or trainer publishes `main` and `sha-<7>` (the commit's short SHA); the CUDA image is rebuilt on `main` only when the trainer changes. Each release publishes `X.Y.Z` and moves `latest` (prereleases don't). Every image carries an SBOM and a provenance attestation.

`grad local up` pulls the images first, so a moving tag like `main` stays current. A `grad` binary from a release (or `cargo install grad-cli`) pulls the images tagged with its own version; one built from a checkout pulls `main`. `--image-tag TAG` overrides that. If the pull is refused or the tag doesn't exist and you run `grad local up` inside a grad checkout, it builds the images from the checkout instead, as `--build` does, and says so; elsewhere the error names the tags that exist and suggests `--build` from a checkout.

The API and web UI listen on `http://127.0.0.1:18787` (published on loopback only). Before starting, `grad local up` checks every port it publishes: a busy default moves to a free port in 18790-18809 and one line says so (`18787 is in use (by another process); serving the API on 127.0.0.1:18790`), while a busy port you chose (`--port`, `GRAD_PORT`, `GRAD_GRAFANA_PORT`, `GRAD_PROMETHEUS_PORT`) fails with exit 2 and how to see what holds it (`lsof -i :PORT` or `ss -ltnp`). The ports of a stack that is already running are its own, not a clash. The choice is saved (`ports.json` beside the embedded compose file), so later runs keep the same URLs, and the `local` profile's `base_url` follows it, so the CLI, the SDKs and `grad ui` do too. The URLs on this page are the defaults; `grad local status` prints the real ones. Authentication is on: the first run generates an admin key, a trainer key and the key that encrypts workspace secrets (`GRAD_SECRETS_KEY`), and saves them in the `local` profile of the `grad` config file (`grad config path`); the server only receives the admin key's SHA-256. `grad local up` waits for `/health/ready` and prints the next steps:

```bash
export GRADIATED_PROFILE=local
grad models list
```

`grad local status` shows container status, API health and the API, web UI, Grafana and Prometheus URLs, `grad local logs [SERVICE] [--follow]` prints logs, `grad local down [--volumes]` stops the stack, and `grad local reset` deletes the local data and keys so the next `grad local up` starts fresh. Pass `--file` (or `GRAD_COMPOSE_FILE`) to use your own compose file; repeat `--file` (or separate the paths with `:`) to layer overrides on top, as `docker compose -f` does. `GRAD_SERVER_IMAGE` / `GRAD_TRAINER_IMAGE` / `GRAD_TRAINER_GPU_IMAGE` override the images (then `grad local up` doesn't pull first), and `GRAD_POSTGRES_MEMORY` / `GRAD_S3_MEMORY` / `GRAD_SERVER_MEMORY` / `GRAD_TRAINER_MEMORY` / `GRAD_EVAL_WORKER_MEMORY` / `GRAD_DEV_INFERENCE_MEMORY` (default `1g` / `512m` / `1g` / `8g` / `512m` / `1g`) cap the containers' memory. Data lives in named volumes (Postgres, the S3 store and the trainer's Hugging Face cache), so it survives `grad local down` and is deleted by `grad local down --volumes`.

The stack is set up like the Helm chart. The `migrate` service runs `node dist/main.js migrate` (the chart's migrations Job) and exits; `grad-server` waits for it and starts with `MIGRATE_ON_BOOT=false`. `grad-server` gets the same `S3_*` variables as on Kubernetes. The workers have no S3 credentials: they move bytes through presigned URLs, as in production. SeaweedFS's only S3 key is generated by the first `grad local up` and saved in the `local` profile with the other keys; the store refuses to start without it. Its S3 API is published on `127.0.0.1:18786` (`GRAD_S3_PORT`; probed and remembered like the API port), because `grad import` and the SDKs PUT files to presigned URLs from your machine. `grad-server` signs those upload tickets for that address (`S3_PUBLIC_ENDPOINT`), while the workers use `http://seaweedfs:8333` inside the compose network.

The CPU trainer trains the dev models (`--dev-models`) and encoders in seconds to minutes. A base model sized for a GPU (`min_gpu_memory_gb` above 4, such as `qwen/qwen3-8b`) would download in full and crawl, so while only CPU workers are online, `runs.plan` and `grad train` warn and suggest `--gpu` or a dev model. The trainer also runs imports and source syncs. To sync from a provider on your own machine (a local Langfuse on port 3000, say), add the source with `--host http://host.docker.internal:3000` and allow the Docker bridge before starting the stack: `GRAD_SOURCES_EGRESS_ALLOW=172.16.0.0/12 grad local up` (the egress guard otherwise refuses private addresses). The provider must listen on more than loopback.

`tests/compose/smoke.sh` boots the stack with `grad local up --build --dev-models`, runs the quickstarts (including the README's router on `examples/support_traces.jsonl`) through the CLI and the Python SDK, evals the trained artifact against the base model with a validator and `test/tiny-judge` on `grad-dev-inference`, and checks the report in the CLI, the Python SDK and (with `GRAD_SMOKE_UI=1`) the web console; CI runs it on every push.

Running `server/docker-compose.yml` directly with `docker compose` defaults to `AUTH_MODE=none` for development; the server logs a warning on every start because every request is then a platform admin. It needs the S3 store's keys first, which `grad local up` otherwise generates; without them SeaweedFS exits ("no S3 keys: set GRAD_S3_ACCESS_KEY and GRAD_S3_SECRET_KEY") and grad-server never starts:

```bash
export GRAD_S3_ACCESS_KEY=$(openssl rand -hex 16) GRAD_S3_SECRET_KEY=$(openssl rand -hex 32)
```

To enable authentication there, set the bootstrap admin hash and a trainer key first:

```bash
export GRAD_AUTH_MODE=api_key
export GRAD_ADMIN_API_KEY_HASH=$(printf '%s' "$MY_ADMIN_KEY" | sha256sum | awk '{print $1}')
export GRAD_TRAINER_API_KEY=$(openssl rand -hex 32)   # shared by grad-server and grad-trainer
export GRAD_SECRETS_KEY=$(openssl rand -base64 32)    # encrypts workspace secrets; keep it with the data
```

## Web UI

`grad-server` serves a web UI at `/` for watching training, much like the Temporal UI for workflows: `http://127.0.0.1:18787/` after `grad local up` (which prints the URL; `grad local status` shows it later), `<base_url>/` from the harness (`ui_url`), and the API Service or ingress in Kubernetes. Run `grad ui` to open it with your CLI profile's key filled in, one click from signed in (`grad ui RUN_ID` opens one run).

What it shows (read-mostly):

- **Runs**: every run with its status, phase, recipe, model, dataset version, cost against its cap and age, filterable by status (each tab with its count) and by name or id. Tick 2 to 10 runs and choose **Compare**: one metric of every run overlaid by step (train or eval loss, each eval metric, learning rate, grad norm, throughput or cost, with smoothing), their final metrics, tokens, cost and time side by side, and the resolved settings that differ. The page's URL (`/runs/compare?ids=...`) keeps the selection, metric and smoothing, so it can be shared. Each run's curve is one request (`GET /v1/runs/{id}/metrics?max_points=1000`), however long the run.
- **Run detail**: a header with status, phase and attempt N/M; a lifecycle strip (queued, starting, training, uploading, done) with interruption and "waiting for a worker" notices; live loss and eval-loss, learning-rate, throughput and cost-versus-cap charts; checkpoints with a **Promote** button; the event timeline (phases, attempts, interruptions, resumes, warnings, checkpoints); the eval report for the run's recipe; the artifact with a download button and the `grad artifacts download` command; the resolved config as YAML; **Cancel** and **Resume** (optionally with a new cost cap).
- **Artifacts**: every artifact as `name@version` with its format, base model, provenance (the run that trained it, the uploader, or the Hub revision it was imported from), size, age and whether a holder pins it, filterable by name. An artifact's page shows its details, provenance, pins (holder and reason) and manifest, a **Download** button (a short-lived presigned URL from `GET /v1/artifacts/{id}/download-url`, straight from storage) and **Delete**, which a pinned artifact refuses with the server's `409 artifact_pinned` naming its holders.
- **Datasets**: every dataset, filterable by name; per dataset its versions, a record preview with merged scores (a long message expands in place), sources with their schedule, last sync status and last error plus a **Sync** button, and recent imports.
- **Evals**: summary tables with scores, 95% CIs, pass@k, the delta against the baseline, and failures.
- **Usage**: a date range (presets or from/to, UTC) with the total cost and tokens, a breakdown by kind (training, evals, dataset scoring, labeling, teacher answers), groups by day, week, month, model, recipe or kind, the top runs and evals, and the period's newest billed rows.
- **Health**: server readiness, the training and import worker pools (busy workers, `workers_online` while a run waits, autoscaling from zero) and the queue. It reads only queued and running jobs (up to 100 of each, shown as "100+" beyond), however many have finished.

It is dark by default, in the Gradiated palette; the sun/moon button in the sidebar switches to the light theme (remembered per browser). It updates live from the run events stream; the header says "connecting" while the stream reconnects.

Every list pages through the server 50 rows at a time (**Load more**), and its status tab and filter box are API filters (`status`, `q`, `dataset`) kept in the URL, so a link or a reload shows the same view and a filter covers every row, not just the loaded ones. `/` focuses the filter and Escape clears it. A row opens with a click, or in a new tab with Cmd/Ctrl- or middle-click. A run's event timeline shows the newest 100 events and pages older ones in. When a refresh fails the page keeps what it loaded and says so, and an offline browser gets a banner.

How it works and what it can reach:

- It is a static build (`server/ui`, Vite + React + uPlot, about 130 KB gzipped, plus 120 KB of self-hosted OFL fonts: Inter, Instrument Sans and JetBrains Mono) baked into the image and served from memory: hashed `/assets/*` files are cached forever, `index.html` is revalidated, and any other browser navigation outside `/v1`, `/health/*` and `/metrics` returns `index.html`. Unknown `/v1` paths still answer with problem+json 404s.
- It calls only the public `/v1` API, with the viewer's API key, so a key sees exactly what it could see through the SDKs. It adds no endpoints.
- With `AUTH_MODE=none` there is no login. With `api_key`, paste a key on the login page; it is kept in that tab's `sessionStorage` only (never `localStorage` or cookies, so there is no CSRF surface) and is forgotten when the tab closes. `grad ui` hands the profile's key over once in a `#key=` URL fragment, which browsers never send to the server; the page removes it from the address bar and shows the sign-in form filled in with it (masked, `grad_abcd…wxyz`), so one click signs you in. A link can carry anyone's key, so it never signs a tab in on its own, and a tab that is already signed in keeps its key and ignores a `#key=` link: a link can't silently switch you into someone else's workspace.
- Every UI response carries a strict Content-Security-Policy (`default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self'; manifest-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`, nothing inline), `X-Frame-Options: DENY`, `nosniff` and `Referrer-Policy: no-referrer`.
- `UI_ENABLED=false` turns it off (it is off by default with `AUTH_MODE=cloud`); Helm sets it from `ui.enabled` (default `true`). The UI needs no extra exposure: keep the server on loopback or behind your ingress as before.

To work on it, run the API (for example `grad local up` or the harness) and `pnpm -C server/ui dev`, which proxies `/v1` to `GRAD_API` (default `http://127.0.0.1:18787`, the `grad local up` default). `pnpm -C server/ui check` runs the typecheck and component tests; `pnpm -C server/ui build` writes `server/ui/dist`, which a source checkout's `grad-server` serves too. `pnpm -C server/ui storybook` opens every component and page state (training, waiting for a GPU, interrupted, failed, empty, loading, error) against a fake server built from the test fixtures; CI runs `build-storybook`.

## Server configuration

| Variable | Default | Notes |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `8787` | Bind a non-loopback `HOST` explicitly (containers set `0.0.0.0`). |
| `AUTH_MODE` | `api_key` | `api_key` requires `ADMIN_API_KEY_HASH` (the server refuses to start without it). `none` must be set explicitly and is for development only; it refuses a non-loopback `HOST` unless `AUTH_MODE_NONE_ALLOW_REMOTE=true` (set by `server/docker-compose.yml`, whose port is published on loopback only). In `none` mode the server also refuses requests whose `Host` is a public DNS name (`403 host_not_allowed`, against DNS rebinding) and cross-site browser requests from origins outside `GRAD_CORS_ORIGINS` (`403 cross_site_request`), so a web page you visit can't drive it; loopback, IP-literal, single-label (compose service) and `.local`/`.internal`/`.svc` names work. `cloud` delegates to Gradiated Cloud. |
| `AUTH_MODE_NONE_ALLOW_REMOTE` | `false` | `true` lets `AUTH_MODE=none` listen on a non-loopback `HOST` (with a startup warning); only for a network nobody untrusted can reach, such as a compose network published on loopback. |
| `ADMIN_API_KEY_HASH` | none | SHA-256 hex of the bootstrap admin key; use it to mint workspace keys with `POST /v1/keys`. |
| `TRAINER_API_KEY` or `TRAINER_API_KEY_HASH` | none | The platform trainer-worker key (every job kind), for `GRAD_WORKER_AUTH=static`. Worker keys are not workspace keys: `admin` never implies `trainer:worker`, and `/v1/keys` cannot mint it. |
| `TRAINER_KEYS_JSON` | none | Static worker keys scoped by job kind: `[{"label": "gpu", "sha256": "<hex>", "kinds": ["train"]}, ...]`. See [Worker authentication](#worker-authentication). |
| `GRAD_WORKER_AUTH` | `static` | How workers authenticate: a comma-separated list of `static`, `kubernetes`, `lease`, tried in order. |
| `GRAD_WORKER_K8S_SERVICE_ACCOUNTS` | none | `kubernetes` mode: service account to job kinds, `{"grad/grad-train-worker": ["train"], "grad/grad-import-worker": ["import"]}`. Required with `kubernetes`. |
| `GRAD_ORCHESTRATOR_KEYS_JSON` | none | `lease` mode: who may mint lease tokens, `[{"label": "gpu-fleet", "sha256": "<hex>", "kinds": ["train"]}]`. Accepted only on `INTERNAL_PORT`. |
| `INTERNAL_PORT` | off | Serve the internal routes on this port only, never on `PORT`. Each group is mounted only when configured (otherwise 404): lease-token minting and revocation (`lease` in `GRAD_WORKER_AUTH` plus `GRAD_ORCHESTRATOR_KEYS_JSON`) and Gradiated Cloud's routes (`AUTH_MODE=cloud`, [CLOUD_MODE.md](CLOUD_MODE.md#the-internal-listener)). Refused at startup when neither is configured. Helm: `api.internalPort`. |
| `DATABASE_URL` | required | PostgreSQL 17 connection string (on AWS, Amazon RDS or Aurora for PostgreSQL 17). Migrations run at boot, versioned in `grad_schema_migrations` under an advisory lock, so several replicas can start at once; they run on their own connection with no statement timeout, so a long one, or a replica waiting for another's, never fails the boot. Requests wait at most 5 s for a connection, a statement at most 30 s (35 s on the client, which also covers a failover that left a dead connection without a reset), and the API answers 503 `database_unavailable` with `Retry-After: 1` meanwhile. |
| `PGSSLROOTCERT` | none | A PEM CA bundle: every Postgres connection then verifies the server certificate and hostname against it (`verify-full`), whatever `ssl*` parameters the URL carries. See [Postgres TLS](#postgres-tls). |
| `MIGRATE_ON_BOOT` | `true` | `false` skips them and refuses to start while any is pending; run `node dist/main.js migrate` first (the Helm chart's migrations Job does). |
| `S3_BUCKET` | required | The bucket for datasets, checkpoints and artifacts. Workers and SDKs upload and download through presigned URLs. Objects are written once under unique keys and never overwritten. Credentials come from the AWS SDK's default chain (`AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`, EKS Pod Identity, IRSA, an instance role). |
| `S3_REGION`, `S3_ENDPOINT` | AWS default, AWS S3 | `S3_ENDPOINT` points at another S3-compatible store (SeaweedFS, MinIO, R2); path-style addressing is used then. |
| `S3_PUBLIC_ENDPOINT` | `S3_ENDPOINT` | The address SDK clients reach the store at, when it differs from the server's and workers' (`grad local up`: `http://127.0.0.1:18786`). Upload tickets (`POST /v1/uploads`) and artifact download URLs (`GET /v1/artifacts/{id}/download-url`: the web UI's Download button, `grad artifacts download --url`) are signed for it; workers' URLs use `S3_ENDPOINT`. |
| `BILLING_MODE` | `noop` | `cloud` checks balances with Gradiated Cloud (a run of an exhausted workspace stops, resumable) and pushes the usage ledger to it; `AUTH_MODE=cloud` and the other `GRAD_CLOUD_*` settings are in [CLOUD_MODE.md](CLOUD_MODE.md). Self-hosted, `GET /v1/usage` lists the ledger (filter by `from`/`to`, `run_id`, `eval_id`, `kind`) and `GET /v1/usage/summary` totals a period (`grad usage`, `grad usage list`). |
| `GRAD_INFERENCE_BASE_URL` | none | The OpenAI-compatible endpoint the [eval workers](#eval-workers) call. grad-server never calls it: it only checks that it is set, so without it `POST /v1/evals` (and router labelling, distillation's teacher answers, `dataset.score()` with judges) returns `501 inference_unavailable`. Set the same URL on the API and the eval workers; the keys go to the eval workers only. |
| `GRAD_JUDGE_BASE_URL` | inference endpoint | Eval workers only: the endpoint for `Judge` rubric items. grad-server ignores it; judges are allowed when `GRAD_INFERENCE_BASE_URL` is set on it. |
| `GRAD_INFERENCE_API_KEY`, `GRAD_JUDGE_API_KEY` | none | Eval workers only; grad-server ignores them (with a startup warning), so keys stay off the API. |
| `GRAD_EXTRA_MODELS_JSON` | none | JSON array adding or overriding catalog models (the single price source for billing). Ids are matched case-insensitively; an optional `serving_id` is the exact id Gradiated Cloud's gateway serves the model under (default: its `hf_repo`, else its id as written). |
| `GRAD_JUDGE_MODELS_JSON` | none | JSON array of extra judge models with prices, e.g. `[{"id": "anthropic/claude-sonnet-5-5", "price_per_million_tokens_usd": 3}]`. A `Judge` must name a catalog model, one of these, or an artifact of the eval's workspace (priced at its base model); anything else is `422 unknown_judge_model`, so every judge call is billed. |
| `DEFAULT_WORKSPACE_ID` | `local` | The workspace of the admin key and of `AUTH_MODE=none` requests (the Helm chart sets `default`). |
| `GRAD_SECRETS_KEY` / `GRAD_SECRETS_KEYS_OLD` | none | 32 random bytes, base64: encrypts workspace secrets (provider keys, HF tokens). `GRAD_SECRETS_KEYS_OLD` (comma-separated) still decrypts secrets sealed under earlier keys, for rotation. Without a key (and without `GRAD_SECRETS_KMS_KEY_ID`) the secrets endpoints answer 501. |
| `MAX_ATTEMPTS` | `10` | Attempts that may end without a result (a lost worker, a worker error, out of GPU memory) before a job fails. |
| `MAX_PREEMPTIONS` | `20` | Attempts in a row that may end because the worker's compute was reclaimed (SIGTERM or a termination notice). They don't count toward `MAX_ATTEMPTS`, and a reclaimed attempt that made progress starts the count again (a run's checkpoint, or an eval's outputs, which the next attempt resumes from; an import restarts from scratch, so its reclaims always count), so a long run on busy or spot GPUs keeps going as long as it makes progress. |
| `GRAD_MAX_RUNNING_PER_WORKSPACE_TRAIN`, `GRAD_MAX_RUNNING_PER_WORKSPACE_IMPORT`, `GRAD_MAX_RUNNING_PER_WORKSPACE_EVAL` | `8` each | Jobs of that kind one workspace may run at once. Past it, the workspace's next jobs stay queued (its runs say "Queued: workspace concurrency limit (8 running)") while other workspaces' jobs go on. See [Queue fairness](#queue-fairness). |
| `GRAD_MAX_QUEUED_PER_WORKSPACE` | `500` | Queued jobs (runs, imports and evals together) one workspace may have. Past it, creating a run, import or eval answers `429 queue_limit` (the SDKs raise `QueueLimitError` and don't retry it); source syncs are exempt (one per source at a time). |
| `GRAD_WORKER_AUTOSCALING` | `false` | Train workers scale from zero (KEDA): a waiting run says a worker is starting instead of waiting for one. The Helm chart sets it when `keda.enabled` and an enabled worker pool takes `train` jobs; `api.workerAutoscaling` overrides it. |
| `SOURCE_SYNC_INTERVAL_SECONDS` | `60` | A source starts at most one sync per this many seconds. |
| `MAINTENANCE_INTERVAL_MS` | `15000` | How often each replica runs the maintenance tick (lease expiry, requeues, retention, usage push, gauges). |
| `SHUTDOWN_DRAIN_SECONDS` | `0` | On SIGTERM, `/health/ready` answers 503 for this long while the server keeps serving, so load balancers stop routing to it before it closes (Helm: `api.shutdownDrainSeconds`, 5). |
| `JOB_EVENT_RETENTION_DAYS` | `90` | Days job events (training metrics) are kept; older ones are deleted by the maintenance tick. |
| `ORPHAN_BLOB_DAYS` | `7` | Days a job blob that nothing references (a checkpoint a crashed worker uploaded but never registered, a staged import part whose delete was interrupted) is kept before the maintenance tick deletes it. |
| `SSE_POLL_MS` | `2000` | Run event streams (`/v1/runs/{id}/events` over SSE) share one reader per replica: it fetches new events when Postgres notifies it (LISTEN on a connection of its own, NOTIFY from triggers on `grad_job_events` and `grad_jobs`) and re-reads every followed run this often in case a notification was missed. Behind a transaction-pooling PgBouncer notifications never arrive, so streams lag by up to this interval; give grad-server a direct or session-mode connection. |
| `METRICS_ENABLED` | `true` | Serve Prometheus metrics at `/metrics` and the queue depth at `/metrics/queue` (see [Monitoring](#monitoring)). |
| `METRICS_PORT` | the API port | Serve them on this port instead, so they stay off the public listener. |
| `METRICS_TOKEN` | none | Require `Authorization: Bearer <token>` on both. |
| `METRICS_WORKSPACE_LABEL` | `false` | Add `grad_workspace_jobs{workspace}`. Only for installs with a handful of workspaces. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | none (tracing off) | Export OpenTelemetry traces over OTLP/HTTP. The standard `OTEL_*` variables apply (`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME`, `OTEL_TRACES_SAMPLER`, `OTEL_TRACES_SAMPLER_ARG`, `OTEL_SDK_DISABLED`). |
| `UI_ENABLED` | `true` (`false` with `AUTH_MODE=cloud`) | Serve the [web UI](#web-ui) at `/`. |
| `GRAD_CORS_ORIGINS` | none (CORS off) | Browser origins allowed to call `/v1` cross-origin, comma-separated (`https://console.example.com`; `http` only for localhost). Bearer tokens only, no cookies. Browser uploads also need a CORS rule on the bucket ([CLOUD_MODE.md](CLOUD_MODE.md#browsers-the-console)). |
| `GRAD_SECRETS_KMS_KEY_ID` | none | An AWS KMS key: workspace secrets use envelope encryption under it instead of `GRAD_SECRETS_KEY`, and values sealed by a local key (kept in `GRAD_SECRETS_KEYS_OLD`) move onto KMS in the background ([CLOUD_MODE.md](CLOUD_MODE.md#secrets-on-kms)). |
| `UI_DIR` | the image's `/app/ui`, else `server/ui/dist` | A built `server/ui` directory to serve. |

### Queue fairness

Runs, imports and evals share one queue in Postgres. When a worker claims, the server picks, among the workspaces below their running cap for that job kind, the one with the fewest running jobs of the kind (ties go to the workspace whose next job is older), then that workspace's oldest queued job the worker can run. A workspace that queues 50 runs therefore doesn't hold up another's 2: with 4 workers, both of the small workspace's runs start in the first round. A claim is one transaction under a per-kind advisory lock with `FOR UPDATE SKIP LOCKED` on the row, so caps hold across every API replica and worker; with 10,000 queued jobs over 100 workspaces it takes about 5 ms. Claims of a kind run one at a time (about 50 a second across all replicas), but a poll that would claim nothing (every queued job capped, or too big for the worker) is answered without the lock, so idle workers polling every second never queue on it.

GPU workers send their GPU memory with each claim (`nvidia-smi`, or `GRAD_WORKER_GPU`), and get only runs whose plan's `min_gpu_memory_gb` fits; CPU workers aren't filtered. A GPU worker first takes the runs that no smaller online GPU fits (fair share among those), and only then any other run, so small runs can't starve a big one off the big GPUs. A run no online worker can fit stays queued and says why ("Waiting for a GPU with ≥46 GB; online workers have 24 GB"), and `grad_jobs_unfit` counts such runs. Every queued run carries `queue_position` (about how many runs start before it, counting other workspaces' fair share) and `queue_message`, which `grad train`, the TUI and the web UI show.

### Worker authentication

Workers (`grad-trainer` and the eval worker) send a bearer token with every worker-protocol request (`/v1/trainer-jobs/*`). They read it from `GRAD_WORKER_TOKEN`, else from the file named by `GRAD_WORKER_TOKEN_FILE`, else `TRAINER_API_KEY`. The file is re-read on every request (and once more after a 401), so a rotated token takes effect without a restart. Workers never log the token. A worker token is not a workspace key: it grants only the `trainer:worker` scope for some job kinds, and `admin` never implies it.

grad-server checks the token with each authenticator in `GRAD_WORKER_AUTH`, in order, and the first one that recognises it wins. When one cannot decide (the Kubernetes API is unreachable) and no other matches, the request fails with `503 worker_auth_unavailable`, never with a match or a 401.

| Mode | The token | Use it for |
| --- | --- | --- |
| `static` (default) | A key whose SHA-256 is in `TRAINER_KEYS_JSON` (its `kinds`) or is `TRAINER_API_KEY(_HASH)` (every kind). Every configured hash is compared in constant time. | `grad local up`, docker compose, a few VMs. The keys never expire: to rotate one, add the new hash, restart the workers with the new key, then remove the old hash. |
| `kubernetes` | The pod's projected service-account token with audience `grad`. grad-server sends it to the TokenReview API using its own in-cluster credentials and maps the reviewed `system:serviceaccount:<namespace>:<name>` to kinds through `GRAD_WORKER_K8S_SERVICE_ACCOUNTS`. | Helm (the chart's default). There is nothing to store or rotate: a token lives an hour and the kubelet refreshes the file. |
| `lease` | `gradwt_` plus 256 random bits, minted by an orchestrator for one host and lease. It is bound to that host and limited to some kinds and a GPU size, and it expires with the lease. | A system that lends hosts to grad for a while, such as Gradiated Cloud's GPU fleet operator. |

**kubernetes.** A token is sent for review only when it is shaped like a JWT whose (unverified) claims name audience `grad`, a mapped service account as `sub`, and an `exp` in the future. Static keys, lease tokens, expired tokens and JWTs meant for anything else never leave grad-server. At most 8 reviews per replica are in flight at once; past that a request gets `503 worker_auth_unavailable` (workers retry), so a flood of forged tokens costs the Kubernetes API little. A token the review rejects (another audience, an unmapped account, a user that is not a service account) gets a 401. A successful review is reused for 60 seconds at most and never after the token's `exp`, so a deleted worker pod's token stops working within 60 seconds. Concurrent requests with one token share a single review. While reviews fail (the API server is down, or reviews are saturated), a token that passed review in the last 15 minutes keeps working until its `exp`, so a control-plane blip doesn't expire every running job's lease; a token never reviewed gets the 503. grad-server needs RBAC to create `tokenreviews.authentication.k8s.io` and nothing else; the chart's ClusterRole grants exactly that. Anyone who can create pods or `serviceaccounts/token` in the release namespace can obtain a worker token, so keep that permission to the people who run grad.

**lease.** The orchestrator calls grad-server's internal listener (`INTERNAL_PORT`; off by default, never the public port) with a key from `GRAD_ORCHESTRATOR_KEYS_JSON`. Workspace and worker keys are refused there. The listener binds the same `HOST` as the API, so firewall the port so that only the orchestrator can reach it: the Helm chart's API Service and Ingress never expose it. Set `api.internalPort` to serve it on the ClusterIP Service `<fullname>-internal`; with `networkPolicy.enabled`, only `networkPolicy.internalIngressFrom` peers can reach it.

```http
POST /internal/v1/worker-tokens
Authorization: Bearer <orchestrator key>
{"host_id": "gpu-host-17", "lease_id": "lease-8c1f", "kinds": ["train"], "gpu_memory_gb": 80, "expires_at": "2026-11-28T06:00:00Z"}

201 {"token": "gradwt_...", "host_id": "gpu-host-17", "lease_id": "lease-8c1f", "kinds": ["train"], "gpu_memory_gb": 80, "expires_at": "2026-11-28T06:00:00.000Z"}

DELETE /internal/v1/worker-tokens/lease-8c1f
200 {"lease_id": "lease-8c1f", "revoked": 1}
```

The token is returned once; grad-server stores only its SHA-256 (`grad_worker_tokens`). `host_id` allows letters, digits, `.`, `_` and `-`. `kinds` must be within the orchestrator key's `kinds` (else `403 job_kind_forbidden`). `expires_at` must be in the future and at most 7 days ahead. To extend a lease, mint a new token for the same lease and write it to the worker's `GRAD_WORKER_TOKEN_FILE`. An orchestrator can revoke only tokens it minted, and revoking is idempotent. A token's leases belong to its orchestrator, host and lease together: a token another orchestrator minted for the same `lease_id`, or one for another host, cannot touch them. On every request grad-server checks the following:

- The token has not expired and has not been revoked (else 401).
- The claim asks only for the token's kinds (`403 job_kind_forbidden`).
- The claim's `worker_id` is the `host_id`, or the `host_id` followed by `-` and an alphanumeric suffix of up to 32 characters (`403 worker_host_mismatch`). Start the trainer with `GRAD_WORKER_ID=<host_id>`; it appends a random `-<6 hex>` for each process.
- The GPU memory the claim reports is no more than `gpu_memory_gb` (`403 gpu_memory_exceeds_token`). Claims are filtered as if the worker had at most that much, including a claim that reports no GPU.

Lease tokens are looked up on every request (they are never cached), so revocation takes effect at once. Revoke after the worker has drained. A revoked token's next request gets a 401 and the worker stops (an eval worker leaves the eval to its lease, never fails it); any lease it still held expires and its job is requeued, which counts toward `MAX_ATTEMPTS`. Draining first (SIGTERM the worker) hands the job back as a preemption instead. The maintenance tick deletes expired tokens.

### Postgres TLS

Set `PGSSLROOTCERT` to a PEM CA bundle and every Postgres connection (`DATABASE_URL`, the `migrate` command, and `GRAD_CLOUD_AUTH_DATABASE_URL` in Cloud mode) verifies the server like libpq's `sslmode=verify-full`: the certificate must chain to the bundle and name the URL's host (an IP address host must be among the certificate's IP addresses). The bundle replaces any `ssl*` parameters in the URL, including a stale `sslmode=no-verify`; a client certificate (`sslcert`, `sslkey`) still applies. With a bundle the connection string must be a `postgres://` URL.

Without `PGSSLROOTCERT`, the URL decides, as node-postgres reads it: `sslmode=verify-full&sslrootcert=/path/ca.pem` verifies too; `sslmode=require` (or `verify-full` without `sslrootcert`) verifies against Node's built-in public CAs, which do not include the RDS CAs; `sslmode=no-verify` encrypts without checking the certificate. Only grad-server connects to Postgres: workers and the Python trainer never do.

Amazon RDS and Aurora certificates chain to the public [RDS global bundle](https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem) (every region's root CAs, about 170 KB). Use the instance or cluster endpoint (`<name>.<id>.<region>.rds.amazonaws.com`) as the host: a CNAME of your own is not on the certificate. With the Helm chart, give the bundle as `database.caBundle`, a ConfigMap you create or the PEM itself:

```bash
curl -fsSLo global-bundle.pem https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem
kubectl -n grad create configmap rds-ca --from-file=ca.pem=global-bundle.pem
helm upgrade --install grad server/helm/grad --namespace grad \
  --set database.caBundle.configMap.name=rds-ca   # or: --set-file database.caBundle.pem=global-bundle.pem
```

The chart mounts it read-only at `/etc/grad/postgres-ca/ca.pem` in the API pods and the migrations Job and sets `PGSSLROOTCERT`. `database.caBundle.configMap.key` names another key in your ConfigMap (default `ca.pem`). An inline `pem` becomes the ConfigMap `<release>-grad-postgres-ca`, created like the Secret before the migrations Job runs (so it also works where the Job is an Argo CD PreSync hook); a ConfigMap of your own must exist before the install or upgrade that names it. Set `sslmode=verify-full` in the URL as well, so that a missing bundle fails closed instead of skipping the check.

### Object storage

Every upload is a presigned PUT whose signature binds `Content-Length` and `x-amz-checksum-sha256`, so the store refuses any other length or body. To commit an upload, grad-server HEADs the object and checks its SHA-256 itself: it uses the checksum the store reports, or else streams and hashes the object. So even a backend that ignored the checksum header could not commit the wrong bytes. Server writes use `If-None-Match: *`, so an object is never overwritten.

When the store is unreachable, times out or answers 5xx (after the S3 client's 3 attempts), the API answers 503 `storage_unavailable` with `Retry-After: 1`. Each request has a 120 s bound; a streamed read (an artifact download, hashing an upload) is bound by it until the response starts and then between two chunks, so a long download on a slow link finishes and a stalled one ends.

These checks have been verified on two backends:

- **SeaweedFS 4.47** enforces all of them. The server's storage contract suite and the live stacks run on it every time (`server/api/test/storage-contract.test.ts`), and so do `grad local up` and the kind smoke test.
- **MinIO** passed the same suite while it was the CI backend.

AWS S3 documents the same behaviour. grad uses no multipart uploads, range GETs or bucket lifecycle rules; promoting a checkpoint is one server-side CopyObject (every object is under the 5 GB single-PUT cap).

The bucket's prefixes:

| Prefix | Holds | Lifetime |
| --- | --- | --- |
| `artifacts/<workspace>/<sha256>` | Released artifact bundles (trained, promoted, uploaded or imported), content-addressed | Until the artifact is deleted; never while it is pinned |
| `ws/<workspace>/jobs/<job>/<attempt>/<sha256>` | Checkpoint bundles and staged import parts | Checkpoint retention; unreferenced blobs after `ORPHAN_BLOB_DAYS` |
| `ws/<workspace>/datasets/...` | Dataset parts (`.jsonl.gz`) | Kept |
| `uploads/<workspace>/<sha256>` | Staged dataset files and artifact uploads | 7 days |

Serving needs only `artifacts/`: a read-only role scoped to that prefix can load every released artifact, and checkpoints are never servable until promoted. Every object there carries a full-object SHA-256 checksum equal to the artifact's recorded `sha256` (the worker's PUT is signed with `x-amz-checksum-sha256`, and a promote's CopyObject uses `ChecksumAlgorithm=SHA256`; there are no multipart uploads), so a reader gets it from a `HEAD` with `ChecksumMode=ENABLED` without hashing the bundle. The maintenance tick deletes staged files under `uploads/` after 7 days, and job blobs and released bundles that no record references (a pinned artifact always has its record). Releases with identical bytes share one bundle, so every delete of a bundle (an artifact delete, the orphaned-blob sweep) re-checks its references under a per-key Postgres advisory lock that release creation also takes: a promote, upload or trained release landing on a bundle that is being deleted either keeps it or finds it gone and copies or uploads it again, never a record without its bundle.

### Artifact uploads and imports

`grad artifacts upload` and `grad artifacts import hf://...` create import jobs that the CPU `import` worker pool runs, like dataset imports (see [docs/ARTIFACT_FORMATS.md](ARTIFACT_FORMATS.md#uploads-and-imports) for the checks). The worker needs the base model's `config.json`, which it finds the way a training run finds the weights (`GRAD_MODEL_PATHS`, `GRAD_MODELS_MIRROR`, or the Hugging Face Hub), but it fetches only `config.json`. Hugging Face imports download from `HF_ENDPOINT` (default `https://huggingface.co`) with the workspace's token or none, never the worker's own login, and are refused in offline mode (`HF_HUB_OFFLINE` / `GRAD_OFFLINE`). Uploads go to the bucket through `S3_PUBLIC_ENDPOINT` like dataset files and are capped at 5 GB.

### Artifact pins

A pin keeps a released artifact alive for a holder, such as a model version Gradiated Cloud published. `POST /v1/artifacts/{id}/pins` (`{"holder": "...", "reason": "..."}`) and `DELETE /v1/artifacts/{id}/pins/{holder}` need the `artifacts:pin` scope (only `admin` implies it); they are internal endpoints, left out of the SDKs. Pins reference the artifact with `ON DELETE RESTRICT`, so nothing deletes a pinned artifact's record: `DELETE /v1/artifacts/{id}` answers `409 artifact_pinned` naming the holders (every artifact read lists them in `pins`), and retention, the orphaned-blob sweep and any future workspace cleanup can't remove it either.

## Eval workers

Evals, `dataset.score()`, router labelling, distillation's teacher answers and recipe checkpoint evals are `eval` jobs on the job queue. grad-server creates them, prices and bills what they generate, aggregates them and serves the results; it makes no model or judge calls, so a deploy or restart of the API never interrupts an eval. They run on eval workers, a second entrypoint of the `grad-server` image:

```bash
node dist/main.js worker --kinds eval
```

An eval worker claims eval jobs over the same worker protocol as the trainer workers, with a lease it renews by heartbeat. It downloads the eval's pinned dataset version to its temporary directory (`/tmp`, an `emptyDir` in Helm; as much disk as the version's uncompressed JSONL, removed when the attempt ends), reads it a page at a time through the same merge as grad-server (so memory stays at about 250 MB for a million records, whatever the eval's `limit`), generates and scores each (task, model, sample) against the endpoints below with the built-in validators, regexes (in a sandboxed thread with a timeout) and judges, and posts the outputs in batches. Each output is stored once per (eval, model, task, sample), so a re-sent batch is a no-op, and grad-server prices it at the prices resolved when the eval was planned and bills the attempt as it goes. Code scorers still run in the SDK (`awaiting_scores`), unchanged. On SIGTERM the worker posts what is in flight and hands the eval back (counted toward `MAX_PREEMPTIONS`); a worker that dies loses its lease, and the next attempt resumes after the outputs already stored. Cancelling an eval stops its worker at the next batch, and the outputs in flight are still billed.

| Variable | Default | Notes |
| --- | --- | --- |
| `GRAD_SERVER_URL` | `http://127.0.0.1:8787` | The API. |
| `GRAD_WORKER_TOKEN` / `GRAD_WORKER_TOKEN_FILE` | none | The worker's bearer token, or a file holding it (re-read on every request, for rotation); else `TRAINER_API_KEY`. |
| `TRAINER_API_KEY` | none | A worker key that may claim `eval` jobs (the platform key, or a `TRAINER_KEYS_JSON` key whose `kinds` include `eval`). Eval jobs carry no workspace secrets. |
| `GRAD_INFERENCE_BASE_URL`, `GRAD_INFERENCE_API_KEY` | none | OpenAI-compatible endpoint for the models under eval (your vLLM/SGLang with LoRA modules named by artifact id). Every call carries `X-Grad-Workspace: <workspace id>`: artifact ids are unique only per workspace, so an endpoint shared by several workspaces must serve and bill by (workspace, model). Without it the worker still runs validators, regexes and code scorers, and says so at startup. |
| `GRAD_JUDGE_BASE_URL`, `GRAD_JUDGE_API_KEY` | inference endpoint | Endpoint for `Judge` rubric items. `grad local up` passes all four from your shell; with `--dev-models`, unset base URLs default to `grad-dev-inference` ([Local development](#local-development-grad-local-up)). |
| `EVAL_CONCURRENCY` | `8` | Model calls in flight per worker. |
| `GRAD_EVAL_CAPACITY_WAIT_SECONDS` | `720` | How long one model call waits in place for capacity (`503 capacity_unavailable`) or a rate limit (429 past the client's retries), honouring `Retry-After`, before the eval fails. The wait keeps the lease and spends no attempt; the eval shows `waiting_reason`. |
| `GRAD_WORKER_ID` | hostname | Shown in leases and logs; a per-process suffix is appended. |
| `GRAD_LEASE_SECONDS` / `GRAD_POLL_INTERVAL_S` | `180` / `1` | Lease length (heartbeats every third of it) and the idle poll interval. |

`grad_eval_outputs_total` and `grad_eval_judge_calls_total` stay on grad-server's `/metrics`: each batch reports its model and judge calls, so eval workers need no scrape. On the API, `GRAD_INFERENCE_API_KEY`, `GRAD_JUDGE_API_KEY` and `EVAL_CONCURRENCY` are ignored with a startup warning.

## Production Kubernetes (Helm)

The chart (`server/helm/grad`) runs two or more API replicas, a migrations Job and two pull-based worker pools. It needs your own Postgres and an S3-compatible bucket; the chart refuses to render without `storage.s3Bucket`, because replicas and workers share artifacts through presigned S3 URLs.

1. Create one Secret and name it in `secrets.existingSecret` with `secrets.create=false` (or leave `secrets.create=true` and pass `secrets.databaseUrl`: the chart then creates `<release>-grad` and generates the keys you leave empty, reading them back on every upgrade with Helm's `lookup`; Argo CD and `helm template | kubectl apply` can't, and would generate new keys on every sync, leaving workspace secrets sealed with the old `secrets-key` unreadable, so use `secrets.create=false` there). Pods read only the keys they need, `database-url` is required, and so is `admin-api-key-hash` with the default `api.authMode=api_key` (without it the API pods crash-loop); every other key is optional. With `secrets.create=true` the chart generates the admin key (`admin-api-key`, read it with `kubectl -n grad get secret <release>-grad -o jsonpath='{.data.admin-api-key}' | base64 -d`), static worker keys and `metrics-token`:

   | Key | Used by | Purpose |
   | --- | --- | --- |
   | `database-url` | API, migrations Job | PostgreSQL 17 connection string |
   | `admin-api-key-hash` | API | SHA-256 hex of the bootstrap admin key (`AUTH_MODE=api_key`) |
   | `trainer-api-key` | API, workers | `workers.auth=static` only: the platform worker key (`workerDefaults.apiKeySecretKey`, or per worker `workers.<name>.apiKeySecretKey`) |
   | `orchestrator-keys-json` | API | `workers.auth` with `lease` only: `GRAD_ORCHESTRATOR_KEYS_JSON`, who may mint lease tokens, `[{"label": "gpu-fleet", "sha256": "<hex>", "kinds": ["train"]}]` |
   | `trainer-keys-json` | API | `workers.auth=static` only: `TRAINER_KEYS_JSON`, per-pool worker keys scoped by job kind, `[{"label": "gpu", "sha256": "<hex>", "kinds": ["train"]}, ...]`. Store each pool's plaintext key under its own Secret key and point `workers.<name>.apiKeySecretKey` at it, so GPU pods can never claim imports or see workspace secrets. |
   | `secrets-key` | API | `GRAD_SECRETS_KEY`: 32 random bytes, base64, encrypting workspace secrets |
   | `inference-api-key`, `judge-api-key` | eval workers | Keys for `evals.inferenceBaseUrl` and `evals.judgeBaseUrl` |
   | `metrics-token` | API, Prometheus, KEDA | Bearer token for `/metrics` and `/metrics/queue` with `metrics.requireToken=true` |
   | `cloud-service-token`, `cloud-auth-database-url` | API | Cloud modes only |
   | `cloud-gateway-token` | eval workers | Cloud only |
   | `admin-api-key`, `worker-<pool>-api-key` | none (generated with `secrets.create=true`, for you to read) | The bootstrap admin key and static worker keys |
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
     --set secrets.create=false --set secrets.existingSecret=grad \
     --set storage.s3Bucket=my-grad-artifacts \
     --set evals.inferenceBaseUrl=https://vllm.internal.example.com/v1
   ```
   `values.schema.json` checks every value's name and type, so a misspelt or retired key fails the install instead of being ignored. Set `storage.s3Endpoint` for SeaweedFS, MinIO, R2 or another S3-compatible store (path-style addressing is used then), and `storage.s3PublicEndpoint` when SDK clients outside the cluster reach that store at another address (they PUT `grad import` files to presigned URLs). Give the API access to the bucket through its ServiceAccount (`serviceAccount.annotations`; EKS Pod Identity needs none) or the static keys above.
3. What gets installed:
   - **Migrations** run once per install and upgrade in a `pre-install,pre-upgrade` hook Job (`node dist/main.js migrate`; Argo CD runs it as a PreSync hook). The API replicas start with `MIGRATE_ON_BOOT=false` and refuse to serve a database with pending migrations. `migrations.enabled=false` makes every replica migrate at boot instead, under an advisory lock.
   - **API**: `api.replicaCount` (2) replicas with liveness, readiness and startup probes, a PodDisruptionBudget and resource requests and limits. Each replica holds at most 10 pooled Postgres connections plus one for LISTEN (the migrations Job one more), so give Postgres `max_connections` of at least 11 × replicas plus headroom (one more replica during an upgrade). Upgrades start a new replica before stopping an old one (`maxUnavailable: 0`), and replicas prefer different nodes and zones. On SIGTERM a replica fails readiness and keeps serving for `api.shutdownDrainSeconds` (5 s; behind a load balancer that registers pod IPs itself, such as an AWS ALB with IP targets, set its deregistration delay) while its endpoint is removed, then ends its SSE streams (clients resume on another replica with `Last-Event-ID`) and gives open requests 5 s. One replica at the default 1 CPU served 250 workers posting a metric a second plus 1,000 live event streams (write to client p95 0.35 s); 5,000 streams on one replica took seconds, so add replicas before a replica's CPU stays near its limit (clients spread over them and resume on any). `api.autoscaling.enabled=true` adds a HorizontalPodAutoscaler on CPU (`targetCPUUtilizationPercentage`, 70) from `api.replicaCount` up to `api.autoscaling.maxReplicas` (6; needs metrics-server); size `max_connections` for the maximum. Extra settings (for example `GRAD_EXTRA_MODELS_JSON` or `MAX_ATTEMPTS`) go in `api.env`; `api.queue` sets the per-workspace caps (`maxRunningPerWorkspace.{train,import,eval}`, `maxQueuedPerWorkspace`).
   - **Worker authentication** (`workers.auth`, see [Worker authentication](#worker-authentication)): with `kubernetes`, the default, each pool runs as its own ServiceAccount (`<release>-train-worker`, `<release>-import-worker`) and mounts a projected token for audience `grad` that lasts 3600 s, at `/var/run/secrets/grad/worker/token` (`GRAD_WORKER_TOKEN_FILE`). The pods get no Kubernetes API token. grad-server maps each account to its pool's `kinds` (`GRAD_WORKER_K8S_SERVICE_ACCOUNTS`) and may only create TokenReviews (a ClusterRole and binding). With `static`, the chart generates one key per pool, scoped to the pool's kinds (`TRAINER_KEYS_JSON`), and all pools share the `workerServiceAccount`. `workers.auth` also takes a list, tried in order (`GRAD_WORKER_AUTH`): the chart's own pools use `kubernetes` when it is listed, else `static`. Add `lease` for GPU hosts outside the cluster, e.g. `--set 'workers.auth={kubernetes,lease}' --set api.internalPort=8788 --set-file secrets.orchestratorKeysJson=orchestrator-keys.json` (or the Secret key `orchestrator-keys-json` with `secrets.existingSecret`); the chart refuses `lease` without `api.internalPort` or the orchestrator keys. With `networkPolicy.enabled`, put the orchestrator in `networkPolicy.internalIngressFrom` and the leased hosts in `networkPolicy.apiIngressFrom`.
   - **Training priority**: pools with `lowPriority: true` (`workers.train` by default) run under the PriorityClass `trainingPriorityClass.name` (default `<release>-training-low`). Its value is -10, below the default priority of 0, and its `preemptionPolicy` is `Never`. So when the cluster is full, your own workloads (inference, say) preempt training, and training never preempts anything. A preempted worker gets SIGTERM, saves a checkpoint and its run resumes on another worker. PriorityClasses are cluster-scoped: with several releases, create it in one (`trainingPriorityClass.create=false` and the same `name` in the others). Set `trainingPriorityClass.enabled=false` to run training at the default priority.
   - **Workers**: `workers.train` claims only `train` jobs and requests `gpuCount` GPUs (`nodeSelector`/`tolerations` place it); `workers.import` is a small CPU pool for `import` jobs, which are file imports and source syncs, the only jobs that carry workspace secrets such as provider keys and HF tokens, and `eval` jobs. Each trainer container sets `GRAD_WORKER_KINDS` from `kinds`; a pool whose `kinds` include `eval` also runs a `grad-eval-worker` container (the `grad-server` image, `node dist/main.js worker --kinds eval`) with the pool's worker key, `evals.inferenceBaseUrl`/`evals.judgeBaseUrl`, their Secret keys, `evals.concurrency` and `evals.workerResources`. A GPU pool refuses kind `eval`, and the release notes warn when no pool runs evals. Workers drain on SIGTERM: if the next step and a checkpoint fit in `GRAD_RECLAIM_GRACE_SECONDS` (25), the worker saves a checkpoint of the current step first (a save still uploading when the grace ends is dropped); then the attempt is billed, handed back and requeued at once, and a new worker resumes from that checkpoint. A pool with `gpuCount` above 0 upgrades one pod at a time, stopping the old worker before starting its replacement (`maxSurge: 0`), so an upgrade needs no spare GPU. On Kubernetes a node termination handler delivers that SIGTERM; on a plain EC2 host, `GRAD_TERMINATION_NOTICE=aws` makes the worker poll the instance metadata (IMDSv2) for a termination notice and treat it like SIGTERM (the chart's network policy blocks the metadata endpoint). To sync from an observability tool on a private address, set `workers.import.env.GRAD_SOURCES_EGRESS_ALLOW` (CIDRs) and allow it in `networkPolicy.workerEgress`; recipe `loggers=` (W&B, MLflow) go through the same guard on the train workers, so a private MLflow server needs `workers.train.env.GRAD_SOURCES_EGRESS_ALLOW`. A source sync stops after `GRAD_SOURCES_SYNC_MAX_SECONDS` (default 3600) and every provider response after 120 s of wall-clock time, so a slow host can't hold an import worker. `models.mirror` sets `GRAD_MODELS_MIRROR` (a directory or `s3://` prefix holding `<mirror>/<model id>/`) for air-gapped installs. Workers keep downloaded weights in `/home/grad/.cache`, an `emptyDir` by default, so a new worker pod (every KEDA scale-up from zero) downloads its base again: Qwen3-8B is 16 GB, 142 s from the Hugging Face Hub measured on a 1-GPU cloud VM, against 0.3 s from the cache. Set `models.cache` to a volume that outlives pods, such as a node-local `hostPath` writable by uid 10001, to keep them; workers sharing it download each model once (the Hub's and the `s3://` mirror's downloads take a file lock, and a mirror copy cut short is finished, not loaded).
4. Optional:
   - `keda.enabled=true` (KEDA installed in the cluster) adds a ScaledObject per worker. It scales on the open jobs of that worker's kinds, queued **and running**, so a scale-down never strands a running job. `keda.workers.train.minReplicaCount=0` scales GPUs to zero. See [KEDA](#keda) for its two trigger modes; neither needs database credentials.
   - `networkPolicy.enabled=true` lets only this release's workers and `networkPolicy.apiIngressFrom` peers reach the API (and only `networkPolicy.internalIngressFrom` peers reach `api.internalPort`), and limits worker egress to DNS, the API and `networkPolicy.workerEgress` (default: HTTPS to public addresses only, never private ranges, CGNAT or link-local metadata endpoints). Add your S3 endpoint there if it is private, and an in-cluster inference or judge endpoint to `networkPolicy.inferenceEgress`.
   - `database.caBundle` (a ConfigMap or inline PEM) makes the API and the migrations Job verify Postgres's certificate and hostname (`verify-full`); for RDS, the AWS global bundle. See [Postgres TLS](#postgres-tls).
   - `ingress.enabled=true` exposes the API and the [web UI](#web-ui), which share the `/` path on the API Service; `ui.enabled=false` serves only the API. Run event streams (`/v1/runs/{id}/events` with `Accept: text/event-stream`) send `X-Accel-Buffering: no` and a ping every 15 s, so they get through ingress-nginx's response buffering and its 60 s read timeout unchanged.
5. Serve trained artifacts on vLLM or SGLang by downloading the verified `.grad.tar.gz` bundle:
   ```bash
   grad artifacts download support-sft@latest --output ./support-sft
   # Keep the verified bundle too (or only the bundle, without --output):
   grad artifacts download support-sft@latest --output ./support-sft --archive ./support-sft.grad.tar.gz
   ```
   `--output` extracts a PEFT directory (`adapter_config.json`, `adapter_model.safetensors`) after checking the bundle's SHA-256 and every file against its manifest.

`tests/helm/smoke.sh` installs the chart on a kind cluster with throwaway Postgres (TLS only, with a certificate from a throwaway CA given as `database.caBundle`) and SeaweedFS (`server/helm/grad/ci/kind-values.yaml`) and checks a run end to end, including API pods being killed mid-run, an upgrade and an uninstall. The migrate command must fail there without the bundle and under a hostname the certificate lacks. It also checks worker authentication by service account: each pool's token claims only its own kinds, a token for another audience or an unmapped account is refused, grad-server may only create TokenReviews, and the train pool runs under the training PriorityClass. CI runs it on every push.

## Monitoring

grad-server exports Prometheus metrics with a `grad_` prefix at `/metrics`. They answer:

- **Queue and scheduling:** open jobs per kind (train, import, sync, eval) and state, the oldest claimable job, the wait for a first claim, fair-share waits and jobs held by a workspace's running cap, `429 queue_limit` rejections, and runs no online GPU fits.
- **Runs and jobs:** jobs finished by kind, recipe and status, failures by `error_code` (`attempts_exhausted`, `preemptions_exhausted`, `invalid_artifact`, `source_unavailable`, `job_error`), durations, attempts, requeues by reason (`compute_reclaimed` preemptions, `lease_lost` lease expiries, `worker_error`, `oom`), emergency checkpoints, and fencing rejections (`grad_http_errors_total{code="lease_lost"}`).
- **Workers:** workers online and their phase per kind, heartbeats, tokens/s, GPU utilisation and memory (from heartbeats), and checkpoint bytes and upload time.
- **Evals:** model outputs and judge calls, and failed calls by reason (`rate_limited`, `capacity_unavailable`, `timeout`, `unreachable`, `server_error`, `rejected`, `malformed`).
- **Sources:** syncs, records and score updates by provider, sync lag, consecutive failures and paused sources.
- **Billing (Cloud mode):** usage push lag, backlog and failures, balance checks by op and result, and the price list's age.
- **Auth:** worker-protocol requests by auth mode and result, Kubernetes TokenReviews by result (with `saturated` past the in-flight cap), their latency and in-flight count, credential-cache hits, Cloud API-key lookups, and every error response by problem `code` (`auth_unavailable`, `worker_auth_unavailable`, ...).
- **API and dependencies:** requests and latency by route template, requests in flight, SSE streams and the event hub, the Postgres pool, query latency and errors, object storage latency and errors by operation, maintenance steps and the last maintenance tick, plus the default process metrics. [METRICS.md](METRICS.md) lists every grad-server metric with its labels; it is generated from the code (`pnpm -C server/api metrics:docs`). Trainer workers serve their own on `GRAD_WORKER_METRICS_PORT`: `grad_trainer_phase{phase}`, `grad_trainer_steps`, `grad_trainer_step_duration_seconds`, `grad_trainer_tokens_per_second`, `grad_trainer_gpu_utilization_ratio{gpu}`, `grad_trainer_gpu_memory_used_bytes{gpu}`, `grad_trainer_checkpoints{reason,result}`, `grad_trainer_checkpoint_duration_seconds`, `grad_trainer_upload_bytes{kind}`, `grad_trainer_upload_duration_seconds{kind}`, `grad_trainer_setup_duration_seconds{step}` (a train job's setup up to its first step: dataset, resume, base_artifact, model_download, model_load, tokenize, adapter, reference, first_step and total) and `grad_trainer_jobs{kind,status}`. The same setup breakdown is a log event on the run ("Ready to train in 41.2 s: model download 20.1 s, ..."), and grad-server times every run phase in `grad_run_phase_duration_seconds{phase}` whether or not workers are scraped. Labels never carry run, dataset or workspace ids. Gauges read from Postgres are sampled by the maintenance tick every 15 seconds, so a scrape never queries the database, and they are the same on every replica: aggregate them with `max`.

Each worker with `GRAD_WORKER_METRICS_PORT` set serves its own metrics (`grad_trainer_*`: phase, step time, tokens/s, GPU utilisation and memory per GPU from NVML, checkpoints saved or failed by reason, checkpoint and upload times, jobs finished). Workers also send their phase, tokens/s and GPU memory in every heartbeat, so the server's `grad_worker_*` gauges cover pools Prometheus can't scrape. For deeper GPU health (SM occupancy, temperatures, XID errors) run NVIDIA's dcgm-exporter on GPU nodes; grad doesn't duplicate it. The eval worker has no metrics port: its call counts reach grad-server with every batch of outputs.

### Locally

`grad local up --observability` adds Prometheus (`127.0.0.1:18789`, 512 MB, 7 days of data) and Grafana (`127.0.0.1:18788`, 768 MB) with the dashboard provisioned, and prints the Grafana URL. The local stack has no Loki, so the dashboard's Logs section stays empty; `grad local logs` shows the same JSON lines. Anyone on the machine can view; sign in as `admin` (password `GRAD_GRAFANA_PASSWORD`, default `admin`) to edit. `GRAD_PROMETHEUS_PORT`, `GRAD_GRAFANA_PORT`, `GRAD_PROMETHEUS_MEMORY` and `GRAD_GRAFANA_MEMORY` change the defaults. `grad local down` stops them too.

### Kubernetes

The chart serves `/metrics` on a separate `metrics` port of the API Service (`metrics.port`, 9464) and sets `GRAD_WORKER_METRICS_PORT` on workers (`metrics.workerPort`, 9465; `0` turns it off). With prometheus-operator (kube-prometheus-stack):

```yaml
metrics:
  requireToken: true # the chart generates `metrics-token` (or set secrets.metricsToken); monitors and KEDA send it
  serviceMonitor: { enabled: true, labels: { release: kube-prometheus-stack } }
  podMonitor: { enabled: true, labels: { release: kube-prometheus-stack } }
  prometheusRule: { enabled: true, labels: { release: kube-prometheus-stack } }
  grafanaDashboards: { enabled: true }
```

With `networkPolicy.enabled`, `metrics.allowFrom` says who may reach the metrics ports.

### Dashboards

[`deploy/grafana/grad.json`](../deploy/grafana/grad.json) ("grad / Training platform", generated by `node deploy/grafana/generate.mjs`) has one section per question: **Overview** (5xx ratio, p95 latency, waiting and running jobs, the oldest waiting job, workers online, the job failure ratio, the maintenance tick's age), **Queue & scheduling**, **Runs & jobs**, **Workers & GPUs**, **Evals**, **Sources**, **Billing & usage** (Cloud only), **Auth & security**, **API & SSE**, **Dependencies** (Postgres, S3, maintenance, process) and **Logs** (Loki). Its variables are the Prometheus and Loki data sources (`${DS_PROMETHEUS}`, `${DS_LOKI}`, so it imports into any Grafana), the namespace and the worker pool (the PodMonitor labels worker series with `pool`). The Logs section reads the `grad-server`, `grad-eval-worker`, `grad-trainer` and `migrate` containers' streams by their `namespace` and `container` labels, which the usual collectors (Grafana Alloy, Promtail) set. `metrics.grafanaDashboards.enabled` loads it as a ConfigMap labelled `grafana_dashboard: "1"` for the Grafana sidecar, and `grad local up --observability` provisions the same file. A test checks that every query names a metric and label grad exports and honours the namespace variable.

### Alerts

`metrics.prometheusRule.enabled` adds a PrometheusRule. Every alert is `severity: warning`; none is meant to page.

| Alert | Fires when | Setting |
| --- | --- | --- |
| `GradApiErrorRateHigh` | More than 5% of API requests return 5xx over 5 minutes (at more than 0.1 requests/s) | `error5xxRatio` |
| `GradJobQueuedTooLong` | The oldest claimable job of a kind has waited over 30 minutes, for 5 minutes (the queue is stuck) | `oldestQueuedSeconds` |
| `GradRunSetupSlow` | Runs take over 10 minutes (p90 over an hour) from claim to their first training step, for 30 minutes | `runSetupSeconds` |
| `GradNoWorkersForQueuedJobs` | Train, import or eval jobs are queued and no worker of that kind has been online for 15 minutes | |
| `GradJobFailureRateHigh` | More than 25% of a kind's jobs failed over 30 minutes, with at least 3 failures | `failureRatio`, `failureMinJobs` |
| `GradUsagePushLagging` | Cloud: usage hasn't reached billing for over 30 minutes, for 10 minutes | `usagePushLagSeconds` |
| `GradUsageRowsParked` | Cloud: billing ingest refused a usage row for good (422/409) and it was parked ([retry by hand](CLOUD_MODE.md#parked-usage-rows)) | |
| `GradUsageFlushLagging` | A running attempt has written no usage row for over 15 minutes, for 10 minutes | `usageFlushLagSeconds` |
| `GradTokenReviewSaturated` | Worker tokens keep being refused because 8 TokenReviews are in flight | |
| `GradDatabaseErrors` | More than 5% of Postgres queries fail over 5 minutes | `dbErrorRatio` |
| `GradStorageErrors` | Object storage operations keep failing | |
| `GradMaintenanceStalled` | The maintenance loop hasn't finished a tick for over 5 minutes, for 5 minutes | |
| `GradSourcePaused` | A source was paused after repeated sync failures | |

`tests/helm/alerts.sh` renders the rules, checks them with `promtool` and runs their unit tests (`tests/helm/alerts.test.yml`: series in, alerts and summaries out); CI runs it on every push.

### Runbook

Each alert's `runbook_url` points at its entry here, at the chart's release tag. `kubectl` lines assume the release `grad` in namespace `grad`; every 5xx log line carries `request_id` and `trace_id`, and every job's lines carry `job_id`.

#### GradApiErrorRateHigh
More than 5% of API requests return 5xx. `kubectl -n grad logs -l app.kubernetes.io/component=api --since=15m | grep '"level":"error"'` shows the cause: `database_unavailable` (see [GradDatabaseErrors](#graddatabaseerrors)), `storage_unavailable` (see [GradStorageErrors](#gradstorageerrors)), `auth_unavailable` (Cloud: the auth view), `storage_object_missing` (the bucket lost objects the database names, or was restored from a copy older than the database: see [Backup and restore](#backup-and-restore)), or `internal_error` with a stack (a bug: report it with the `request_id`). If one replica alone fails (`sum by (pod)` on `grad_http_requests_total`), delete that pod.

#### GradJobQueuedTooLong
The oldest claimable job of a kind has waited 30 minutes. Check that the kind's pool has running pods (`kubectl -n grad get pods -l app.kubernetes.io/component=worker`), that KEDA scaled it (`kubectl -n grad get scaledobject`), and, for `train`, that a GPU node fits the run (`grad_jobs_unfit` counts runs that need more GPU memory than any online worker has). Jobs held only by their workspace's running cap don't count here.

#### GradRunSetupSlow
Claimed GPUs sit idle for over 10 minutes per run before training starts: the worker is downloading or loading the base model, downloading the dataset, or tokenizing. Each run's events carry a log line `Ready to train in N s: model download ..., loading the weights ..., tokenizing ...` naming the slow step, and scraped workers export `grad_trainer_setup_duration_seconds{step}`. Model downloads are the usual cause: with the default `emptyDir` model cache every new worker pod downloads its base again (Qwen3-8B is 16 GB); set `models.cache` to a node-local `hostPath` (or point `models.mirror` at an `s3://` copy in the GPUs' region). Weight loads from a slow network disk with a cold page cache are the next (Qwen3-8B took 138 s at about 120 MB/s on a cloud VM's boot disk).

#### GradNoWorkersForQueuedJobs
Jobs of a kind are queued and no worker of that kind has been online for 15 minutes. The pool is at zero, or its pods can't start or authenticate: `kubectl -n grad describe pod` (image pull, GPU quota, PriorityClass preemption) and `grad_worker_auth_total{result!="ok"}` (worker token refused: the ServiceAccount mapping with `workers.auth=kubernetes`, or the pool's key with `static`).

#### GradJobFailureRateHigh
More than 25% of a kind's jobs failed in 30 minutes. `grad_job_failures_total` by `error_code` says why: `attempts_exhausted` (workers keep crashing: their logs by `job_id`, often OOM), `preemptions_exhausted` (preempted with no checkpoint saved in a row: raise `GRAD_RECLAIM_GRACE_SECONDS` or checkpoint more often), `invalid_artifact`, `source_unavailable` (a provider or its key) or `job_error` (the job's own error, shown on the run).

#### GradUsagePushLagging
Cloud: usage hasn't reached billing for 30 minutes. Rows stay in grad's ledger and nothing is lost. `grad_usage_export_failures_total` and the API logs ("usage export") name the billing ingest's error; a long open transaction anywhere on the Postgres cluster also holds the export back (`pg_stat_activity` where `xact_start` is old).

#### GradUsageRowsParked
Cloud: billing refused a usage row for good (422/409) and it was parked; the rest keep exporting. Fix the cause (usually a price list mismatch), then retry the parked rows by hand ([Parked usage rows](CLOUD_MODE.md#parked-usage-rows)).

#### GradUsageFlushLagging
A running attempt has written no usage row for 15 minutes: its worker stopped reporting progress (hung, or partitioned from the API: its lease then expires and the job requeues), or billing writes fail (`grad_maintenance_step_errors_total`, API logs).

#### GradTokenReviewSaturated
Worker tokens are refused because 8 TokenReviews are in flight. The Kubernetes API is slow (`grad_token_review_duration_seconds`) or something floods grad-server with tokens. Workers retry, and tokens reviewed in the last 15 minutes keep working.

#### GradDatabaseErrors
More than 5% of Postgres queries fail. Check the database (failover, connections against `max_connections`, disk, CPU) and the API logs ("postgres connection lost"). Requests get `503 database_unavailable` with `Retry-After: 1` and clients retry; leases survive an outage shorter than a third of their length.

#### GradStorageErrors
Object storage operations of one `op` keep failing. Check the bucket, the API's credentials (IRSA / Pod Identity, or the static keys) and KMS grants; `kubectl -n grad logs` names the S3 error code. Uploads and downloads get `503 storage_unavailable` and retry; nothing is half-written.

#### GradMaintenanceStalled
No replica finished a maintenance tick for 5 minutes, so lease expiry, requeues, retention, usage export and the queue gauges KEDA reads are stale. Usually the database (see [GradDatabaseErrors](#graddatabaseerrors)); otherwise restart the API pods one at a time.

#### GradSourcePaused
A source was paused after 10 failed syncs in a row. `grad sources list` shows its error; fix the provider key (`grad secrets set NAME` resumes its sources) or run `grad sources sync ID`.

### KEDA

`keda.trigger` picks one of two modes:

- `prometheus` (the default) scales each pool on `grad_jobs_open` for its kinds from your Prometheus; set `keda.prometheus.serverAddress` (for example `http://prometheus-operated.monitoring.svc:9090`) and, if your series aren't labelled the prometheus-operator way, `keda.prometheus.selector`.
- `metrics-api` for clusters without Prometheus: KEDA polls grad-server's `/metrics/queue?kinds=...` directly (JSON with `open`, `queued`, `waiting_for_compute` and `running`).

Queued jobs that wait on their own workspace's running cap don't count as open (they are `grad_jobs_over_workspace_limit`), so one workspace's backlog can't scale the pool past what it may run.

With `metrics.requireToken`, `metrics-api` sends `metrics-token` to grad-server, and `prometheus` queries your Prometheus (whose ServiceMonitor sends the token). Neither needs database credentials.

### Tracing and logs

Tracing is off unless `OTEL_EXPORTER_OTLP_ENDPOINT` (or `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`) is set. grad-server then exports spans for HTTP requests, Postgres queries and storage operations, and passes a W3C `traceparent` to the worker in the job payload, so one trace links a run's creation, claim, training and completion.

Every component logs one JSON object per line to stdout: `time`, `level` (`info`, `warn`, `error`), `component` (`api`, `eval-worker`, `migrate`, `trainer`) and `msg`, plus `request_id`, `trace_id`, `job_id`, `run_id`, `attempt`, `worker_id` and `workspace_id` where they apply (ids belong in logs, never in metric labels). Errors carry `error`, `error_type` and `stack`. The trainer logs each claim, phase change, checkpoint (step, reason, size, upload time), reclaim and termination notice, OOM retry, lease loss and the attempt's outcome, and routes library warnings (transformers, peft) through the same format. API keys, lease tokens, bearer tokens and presigned-URL signatures are masked if one ever reaches a log line, and import workers also mask the provider keys and Hugging Face tokens their job carries.

## Backup and restore

grad keeps state in two places, and both must be backed up together: **Postgres** (runs, jobs, datasets' versions and parts index, artifacts and pins, evals, the usage ledger, API key hashes and encrypted workspace secrets) and **the bucket** (dataset parts, checkpoints, artifact bundles, uploads). Also keep the Secret's `secrets-key` (`GRAD_SECRETS_KEY`; without it workspace secrets can't be decrypted) and `admin-api-key-hash`, or the KMS key with `GRAD_SECRETS_KMS_KEY_ID`.

**Order: Postgres first, then the bucket.** grad writes an object before the row that references it commits, never overwrites an object (keys are content-addressed), and deletes the row before the object. So a bucket copy started after a database snapshot finished holds every object the snapshot references, except objects deleted in between: checkpoints that expired (a running run keeps three), artifacts deleted with `grad artifacts delete`, purged workspaces and unused uploads. Bucket versioning closes that gap: keep noncurrent versions longer than your copy takes (a lifecycle rule expiring them after 7 days is plenty) and restore the objects as of the snapshot's time. A bucket copy older than the database is not consistent: rows would name objects it never had. Objects the snapshot doesn't reference (written after it) are harmless; the orphan sweep deletes them after `ORPHAN_BLOB_DAYS` (7).

Both copies can be taken live. With managed Postgres, use its snapshots or point-in-time recovery and S3 versioning or replication; elsewhere:

```bash
pg_dump -Fc "$DATABASE_URL" > grad.dump                      # 1. the database (a consistent snapshot)
aws s3 sync s3://my-grad-artifacts s3://my-grad-backup/latest  # 2. then the bucket
```

To restore, stop grad, restore the database, then the bucket, then start it again:

```bash
kubectl -n grad scale deploy -l app.kubernetes.io/instance=grad --replicas 0
pg_restore --no-owner --exit-on-error -d "$DATABASE_URL" grad.dump   # into an empty database
aws s3 sync s3://my-grad-backup/latest s3://my-grad-artifacts
helm upgrade grad server/helm/grad --namespace grad --reuse-values  # migrates an older backup, restores the replica counts
```

What a restore to time T guarantees:

- Everything committed before T is back: datasets, artifacts (each still matches its SHA-256), evals, keys, secrets and the usage ledger.
- Work after T is lost: runs created or finished after T, newer checkpoints and releases. Their objects stay in the bucket until the orphan sweep deletes them.
- A job that was running at T still names its old lease. The lease expires (lease + lease/3), the job requeues as the next attempt and resumes from its latest checkpoint before T. Usage chains per attempt, so nothing is billed twice in grad's ledger.
- Cloud: usage rows already exported after T are exported again with the same `event_id`, which billing counts as duplicates. A replayed attempt that billing refuses as a conflict is parked ([GradUsageRowsParked](#gradusagerowsparked)), never dropped.

## Retention

While a run trains it keeps its last three checkpoints and its best by eval score; older ones expire as soon as a newer one registers. The kept ones expire after the recipe's `checkpoint_ttl_days` (30 by default), except that the best and final checkpoints of every finished run never expire. Expired checkpoints and unused uploads are deleted by the server's maintenance loop. Promoting a checkpoint copies it into a new immutable artifact under `artifacts/`. Released artifacts never expire; `grad artifacts delete NAME@VERSION` deletes one and its bundle, unless it is [pinned](#artifact-pins).
