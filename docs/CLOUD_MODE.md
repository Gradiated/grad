# Cloud mode

How grad-server runs as Gradiated Cloud's training plane. Everything here is
off unless `AUTH_MODE=cloud`, `BILLING_MODE=cloud` or one of the `GRAD_CLOUD_*`
settings is set; a self-hosted server never reads them. Cloud plugs in through
the adapters in `server/api/src/cloud/`; the Postgres queue, the pull workers
and the public API are the same code as self-hosted.

The product side of every contract below is implemented in the Gradiated
product repo; `server/api/test/fixtures/fake-cloud-api.ts` is a working fake of
all of it, used by the server tests and by `tests/harness/stack.ts --cloud`.

## Settings

| Setting | Needed for | What it is |
| --- | --- | --- |
| `AUTH_MODE=cloud` | auth | API keys from the product's auth view, console JWTs. `/v1/keys` is not used. |
| `GRAD_CLOUD_AUTH_DATABASE_URL` | `AUTH_MODE=cloud` | Read-only Postgres URL of the product database (role `grad_auth_reader`, `SELECT` on `auth_principals_v1` only). |
| `GRAD_CLOUD_JWKS_URL` | `AUTH_MODE=cloud` | The control plane's JWKS, e.g. `https://api.gradiated.com/api/auth/jwks`. |
| `GRAD_CLOUD_JWT_ISSUER` | `AUTH_MODE=cloud` | The tokens' `iss`, e.g. `https://api.gradiated.com`. |
| `GRAD_CLOUD_JWT_AUDIENCE` | | Default `training`. |
| `BILLING_MODE=cloud` | billing | Balance checks, usage push, the price list. |
| `GRAD_CLOUD_BILLING_URL` | `BILLING_MODE=cloud` | Billing's base URL on the product's internal listener, e.g. `http://api-training-internal.gradiated.svc:3005/api/internal/v1/billing` (`/check`, `/usage-events`). |
| `GRAD_CLOUD_PRICES_URL` | `BILLING_MODE=cloud` | The price list, e.g. `…/api/internal/v1/billing/prices?product=training`. |
| `CLOUD_SERVICE_TOKEN` | `BILLING_MODE=cloud`, gateway evals | grad's bearer for the product's internal listener (the product's `TRAINING_INTERNAL_TOKEN`). |
| `CLOUD_INTERNAL_API_URL` | gateway evals, the `gradiated` source | The product's internal listener, e.g. `http://api-training-internal.gradiated.svc:3005`. |
| `GRAD_CLOUD_GATEWAY_URL` | evals | The inference gateway's OpenAI-compatible base URL. On the API: evals are allowed (no `GRAD_INFERENCE_BASE_URL`; with `BILLING_MODE=cloud` that one is refused). On eval workers: where they call. |
| `GRAD_CLOUD_GATEWAY_TOKEN` | eval workers | The gateway service credential. Only eval workers hold it. |
| `INTERNAL_PORT` | workspace hooks, pins | The internal listener (ClusterIP only), also used by worker lease tokens. |
| `GRAD_WORKSPACE_PURGE_DELAY_SECONDS` | | Delay between a workspace delete and its purge (default 7 days). |
| `GRAD_CORS_ORIGINS` | the console | Comma-separated browser origins allowed on `/v1` (exact `https://host[:port]`; `http` only for localhost). Default: CORS off. |
| `GRAD_SECRETS_KMS_KEY_ID` | secrets | An AWS KMS key id, ARN or alias: workspace secrets use envelope encryption. Credentials and region come from the AWS chain (Pod Identity); `AWS_ENDPOINT_URL_KMS` overrides the endpoint. |

Plain `http://` Cloud URLs are allowed only to loopback and to in-cluster
Services (`*.svc`, `*.svc.cluster.local`); anything else must be `https://`.
In Helm these are the `cloud.*` values and the `cloud-auth-database-url`,
`cloud-service-token` and `cloud-gateway-token` keys of the grad Secret.

## Auth

`server/api/src/cloud/auth.ts`. A bearer token is, in order:

1. a worker credential (static key, Kubernetes service account or lease
   token, as self-hosted). A JWT whose `iss` is `GRAD_CLOUD_JWT_ISSUER` skips
   this step, so console requests never cause a TokenReview;
2. a JWT, verified locally against the JWKS;
3. otherwise a `grad_` API key, looked up in the auth view.

### API keys: `auth_principals_v1`

```sql
SELECT api_key_id::text, org_id::text, org_slug, workspace_id::text,
       user_id::text, actor, role, status, scopes, expires_at
  FROM auth_principals_v1 WHERE key_hash = $1   -- sha256(token), bytea
```

- No row, or `expires_at <= now()`: 401. `status <> 'active'` (organization
  suspended, workspace archived, creator no longer an active member): 403
  `workspace_suspended`.
- Answers are cached in-process by token hash: 5 s when found, 5 s when not
  (and for 403), at most 10,000 entries (least recently used goes). Revocation
  therefore takes effect within 5 s. There is no LISTEN/NOTIFY or Redis.
  Concurrent requests with the same key share one query.
- The view's pool: 4 connections per replica, 2 s connect and statement
  timeouts. The database unreachable (a failover, a network blip): each
  key's last answer, found or refused, stands in for up to 5 minutes, never
  past the key's own `expires_at`; a revocation made meanwhile applies on the
  first lookup after the view is back. A key with no answer in the last 5
  minutes: 503 `auth_unavailable` (auth fails closed). Lookups are counted on
  `grad_cloud_auth_lookups_total{result}` (`stale` when a last answer was
  reused).

### Console JWTs

Issued by the product (`POST /api/v1/workspaces/{ws}/training-tokens`, Better
Auth's jwt() plugin), sent as `Authorization: Bearer` (never cookies).

- Header: `alg` EdDSA, ES256 or RS256 (≥ 2048-bit), and the JWK's key type
  must be that algorithm's; `kid` required; `crit` refused.
- Claims: `iss` = `GRAD_CLOUD_JWT_ISSUER`, `aud` contains `training`, `exp`
  and `nbf` with 60 s of skew, `sub` = `user:<id>`, `ws` (the workspace),
  `org`, `role` (`admin` | `member`), optional `scopes` (narrowing). The
  product issues them for 10 minutes; an `exp` more than an hour ahead is
  refused (console and service tokens alike).
- The JWKS is fetched once, cached, re-fetched every 10 minutes in the
  background (a slow or failing JWKS never delays a request the cached keys
  can answer, and a failure keeps them) and on an unknown `kid` (at most once
  per 30 s, counted apart from the periodic refresh, so a key rotated in just
  after one verifies at once). If it can't be fetched and none is cached: 503
  `auth_unavailable`.
- `sub = service:<name>` tokens (below) are refused on the public API.

### Roles

| Role | grad scopes |
| --- | --- |
| `admin` | `admin` (every workspace scope) |
| `member` | `datasets:read/write`, `runs:read/write` (evals included), `artifacts:read/write`, `sources:read` |

Secrets, source writes and deploy are admin-only. A key's or token's non-empty
`scopes` are intersected with its role's.

## Billing

`server/api/src/cloud/billing.ts`, `prices.ts`, and the exporter in
`services/usage.ts`.

### Price list

`GET GRAD_CLOUD_PRICES_URL` (bearer `CLOUD_SERVICE_TOKEN`) →
`{price_version, skus: [{sku, unit, price_nano_usd_per_mtok}]}`, with an
`ETag`. grad fetches it at boot and from the maintenance tick every 5 minutes
with `If-None-Match`; a failure backs off (30 s, doubling to 5 min) and keeps
the last good list. After 24 h without a good answer, new runs and evals get
503 `billing_unavailable`. The list lives in each replica's memory: a replica
that boots while the endpoint is down has none, so its model lookups (plans,
creates, `/v1/base-models`) answer 503 `billing_unavailable` and it retries
every 30 s until it gets one. Running work is unaffected: runs bill at the
price they were created with.

- A model trains at `train:<catalog id>`; on Cloud only models with that SKU
  are offered (`/v1/base-models`), and plans and costs use its price.
- Judges and eval targets are estimated at `inference:<model>`; a judge
  without one is refused (422 `unknown_judge_model`).
- A run records the `price_version` it was created with, and its usage rows
  bill at that version and price whatever the list says later.

### Balance check and stop on balance

`POST {GRAD_CLOUD_BILLING_URL}/check {workspace_id, estimated_amount_nano_usd}`
→ `{allowed}` or `{allowed: false, reason: insufficient_balance | suspended}`.

- At run, eval and resume create: refused → 403 `billing_denied`; unknown
  workspace (404) is refused too; billing down → 503 `billing_unavailable`.
- At every heartbeat of a running run (estimate 0, cached 30 s per
  workspace): refused → `should_stop: insufficient_balance` → the run
  checkpoints and ends `stopped_balance`, resumable once the workspace can pay.
  A billing outage never stops running work. Each replica asks at most once
  per workspace at a time, so a slow billing service sees one call per
  workspace, not one per heartbeat.

### Usage push

Every `grad_usage` row grad bills (`billed_by = grad`: training) becomes one
usage event:

```json
{"event_id": "training:run-usage:<run_id>:<attempt>:<tokens_through>",
 "workspace_id": "…", "product": "training", "sku": "train:qwen/qwen3-8b",
 "quantity": 1048576, "amount_nano_usd": 2097152000, "price_version": "pv_…",
 "occurred_at": "…", "subject_id": "run_…", "tags": {"attempt": "1", "recipe_kind": "sft"}}
```

`amount_nano_usd = (quantity × price_nano_usd_per_mtok + 500000) / 1000000`
(integer, half up), the same formula billing checks. Events go in batches of
up to 500 to `POST {GRAD_CLOUD_BILLING_URL}/usage-events`; billing deduplicates
by `event_id`, so a replay is free.

- The exporter runs in the maintenance tick of every replica. Its cursor
  (`grad_usage_export`, a `(txid, seq)` pair) is locked `FOR UPDATE SKIP
  LOCKED`, so one replica pushes at a time, and it reads only rows from
  transactions older than every open one, so a late commit is never skipped.
  A transaction left open anywhere on the Postgres cluster therefore delays
  the export until it ends.
- Ingest down, or refusing a batch (422, 409): training goes on, the rows stay
  in the ledger, and the push retries with backoff (15 s doubling to 5 min).
  Nothing is dropped. Watch `grad_usage_export_lag_seconds` (age of the
  oldest unpushed row) and `grad_usage_export_pending_rows`;
  `grad_usage_export_failures_total` counts failed pushes. Starting runs
  against a balance that lags the backlog is the accepted risk (the balance
  check sees only pushed usage).

## Evals

Evals run on eval workers (`grad-server worker --kinds eval`). With
`GRAD_CLOUD_GATEWAY_URL` set they call the gateway:

```
POST {GRAD_CLOUD_GATEWAY_URL}/chat/completions
Authorization: Bearer <GRAD_CLOUD_GATEWAY_TOKEN>
X-Gradiated-Workspace: <workspace id>
X-Gradiated-Source: eval
X-Gradiated-Eval-Id: ev_…
```

- The gateway authorizes and bills the call as that workspace in its
  low-priority eval lane (its own rate limit, never autoscaling demand, shed
  first with 429). The worker retries 408, 425, 429 and 5xx six times with
  backoff from 1 s (at least the response's `Retry-After`, up to 60 s). If
  the gateway is still down after that (an outage, a full lane), the call
  waits and retries in place (2 s doubling to 30 s) while the worker keeps its
  lease: an outage is never stored as an output error or a zero judge score.
  After 10 minutes down the worker hands the attempt back (`abandoned`,
  counted against `MAX_ATTEMPTS`); the next attempt resumes after the outputs
  already stored, and an eval whose gateway stays down through every attempt
  fails with the outage as its error.
- Cold pools: a call that finds its model's pool at zero is held by the
  gateway while the pool wakes (up to 600 s, so the worker's gateway timeout
  is 660 s), then answered `503 capacity_unavailable` with `Retry-After: 30`.
  The worker never retries that inside the client: the call sleeps the
  `Retry-After` (at most 5 min) and tries again, keeping its lease and its
  attempt, for up to `GRAD_EVAL_CAPACITY_WAIT_SECONDS` (default 1800) in all.
  Meanwhile `GET /v1/evals/{id}` shows `waiting_reason: "capacity_unavailable"`
  (`"inference_unavailable"` during an outage) and the worker's heartbeat
  phase is `waiting_for_capacity`. Past the wait the eval fails once with
  `capacity_unavailable: …` as its error; no attempt is spent on it.
- Models: the gateway matches ids exactly, so grad sends each catalog
  model's canonical-case serving id: its `serving_id` in
  `GRAD_EXTRA_MODELS_JSON`, else its Hugging Face repo, else its id as
  configured (`qwen/qwen3-8b` is called as `Qwen/Qwen3-8B`; judges such as
  `anthropic/claude-sonnet-5-5` as `GRAD_JUDGE_MODELS_JSON` spells them, or
  lowercase when only the price list knows them). grad's own ids, price
  lookups and SKUs (`inference:qwen/qwen3-8b`) stay lowercase. An artifact target (`name@version`) is
  published as an eval-only Version when the eval is created:
  `POST {CLOUD_INTERNAL_API_URL}/api/internal/v1/training/eval-versions
  {workspace_id, artifact_id}` → `{model: "<org_slug>/<name>/<version>"}`,
  and the eval calls that name. 409/422 there → 422 `artifact_not_servable`;
  unreachable → 503 `inference_unavailable`.
- The gateway bills these tokens. grad records the eval's usage rows with
  `billed_by: gateway` (shown in `/v1/usage`) and never pushes them.

## The internal listener

The product calls grad on `INTERNAL_PORT` (never on the public port) with
**service JWTs** from the same key set as console tokens: `sub =
service:<name>`, `aud = training`, `ws` = the workspace in the path, and the
route's scope in `scopes`.

| Route | Scope | What it does |
| --- | --- | --- |
| `GET /internal/v1/workspaces/{ws}/state` | `workspaces:admin` | The workspace's state. |
| `PUT /internal/v1/workspaces/{ws}/state {state}` | `workspaces:admin` | `active`, `suspended` or `deleted`; idempotent. |
| `GET /internal/v1/workspaces/{ws}/artifacts/{id}` | `artifacts:pin` | Serving's resolve: `{artifact, object, download_url, expires_at}`: the artifact (format, `sha256`, `size_bytes`, base model, manifest, provenance); `object` = `{key, sha256, checksum_sha256, checksum_type: "FULL_OBJECT", size_bytes}`, the bundle's key under `artifacts/` and its full-object SHA-256 (hex, and base64 as S3 returns `x-amz-checksum-sha256` on a `ChecksumMode=ENABLED` HEAD or GET), equal to the recorded `sha256` and checked against the store on every resolve; and a presigned GET of the bundle valid 15 minutes. 404 when the workspace has no such release; 409 `artifact_not_servable` for a `reference` bundle, 409 `artifact_checksum_mismatch` when the stored object's checksum isn't the recorded one. |
| `PUT /internal/v1/workspaces/{ws}/artifacts/{id}/pins/{holder}` `{reason?}` | `artifacts:pin` | Pins it for `holder` (e.g. `inference:version:<task_versions.id>`): 201, or 200 when that holder already pinned it, with `{pin, artifact}`. A pinned artifact is never deleted (409 `artifact_pinned` on delete; retention, purges and sweeps skip it). |
| `DELETE /internal/v1/workspaces/{ws}/artifacts/{id}/pins/{holder}` | `artifacts:pin` | Removes the pin; 204, also when there was none. |

Workspace states (`services/workspaces.ts`, table `grad_workspace_states`; no
row is `active`):

- `suspended`: new jobs (runs, evals, imports, syncs) and resumes get 403
  `workspace_suspended`; queued runs become `stopped_balance`; running runs
  stop at their next heartbeat (checkpoint, `stopped_balance`); evals are
  cancelled; sources pause.
- `active`: jobs are accepted again; the sources the suspension paused resume;
  stopped runs wait for a resume.
- `deleted`: terminal (a later `active` is 409 `workspace_deleted`). Runs and
  evals are cancelled; after `GRAD_WORKSPACE_PURGE_DELAY_SECONDS` the
  maintenance tick purges in bounded passes, one workspace at a time across
  replicas: sources, secrets, keys, jobs (runs, evals, imports with their
  events and outputs), datasets, every artifact no holder pins, and the
  objects under `ws/<ws>/` and `artifacts/<ws>/` except pinned artifacts'
  bundles. Pinned artifacts and running jobs are retried hourly until gone.
  The usage ledger is kept.

## Secrets on KMS

With `GRAD_SECRETS_KMS_KEY_ID`, each secret value is sealed (AES-256-GCM, AAD
= workspace and name) under its own data key from KMS `GenerateDataKey`, with
the encryption context `{grad_workspace, grad_secret}`; only the wrapped data
key is stored (`grad_secrets.wrapped_key`, `key_id = kms:<key id>`).

- Rotation: KMS's automatic rotation needs nothing. To move to another key,
  change `GRAD_SECRETS_KMS_KEY_ID`; the maintenance tick re-wraps each data key
  with `ReEncrypt` (100 per tick), leaving the ciphertext alone.
- Migration from `GRAD_SECRETS_KEY`: keep the old key in
  `GRAD_SECRETS_KEYS_OLD` (or `GRAD_SECRETS_KEY`) while setting
  `GRAD_SECRETS_KMS_KEY_ID`; values stay readable, and the tick re-seals them
  onto KMS. Remove the local key once no `grad_secrets.key_id` is local.
- The server role needs `kms:GenerateDataKey`, `kms:Decrypt` and
  `kms:ReEncrypt*` on the key(s).

## Browsers (the console)

`GRAD_CORS_ORIGINS` allows the console's origin on `/v1`: requests may send
`Authorization`, `Content-Type`, `Idempotency-Key`, `Last-Event-ID` and
`X-Request-Id`, and read `x-request-id`, `Retry-After`, `X-Artifact-Sha256`
and `Content-Disposition`. No credentials mode (bearer tokens only). SSE
streams (`/v1/runs/{id}/events`) carry the same headers; read them with
`fetch`, since `EventSource` can't send `Authorization`.

Downloads: `GET /v1/artifacts/{id}/download-url` (`artifacts:read`) returns
`{url, expires_at, sha256, size_bytes, filename}`, a presigned GET valid 15
minutes, so a browser downloads the bundle from storage (`<a href>`) instead of
through the API; every SDK has it (`artifacts.downloadUrl`, `download_url`,
`DownloadURL`) and the CLI prints it with `grad artifacts download REF --url`.

Uploads go straight from the browser to S3 with the presigned PUT a ticket
returns, sending the ticket's `headers` (a browser drops `content-length`
and sets the same value itself). The bucket needs a CORS rule for the console origin:

```json
[{"AllowedOrigins": ["https://console.gradiated.com"],
  "AllowedMethods": ["PUT", "GET", "HEAD"],
  "AllowedHeaders": ["content-type", "content-length", "x-amz-checksum-sha256",
                     "x-amz-sdk-checksum-algorithm", "x-amz-tagging"],
  "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 600}]
```
