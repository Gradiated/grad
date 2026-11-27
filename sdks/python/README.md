# grad-sdk (Python)

The Python SDK for the Gradiated training platform: push datasets, preview and launch managed
fine-tuning runs, evaluate models, download PEFT adapters and deploy them on Gradiated Cloud.

- Python 3.11+, one dependency (`httpx`); a blocking `Grad` client (from asyncio, call it via `asyncio.to_thread`).
- Typed objects with a `.raw` escape hatch, `py.typed`, typed errors, retries with backoff.
- Works against Gradiated Cloud or a self-hosted `grad-server`.

```bash
pip install grad-sdk
export GRADIATED_API_KEY=grad_...
# Self-hosted server: export GRADIATED_BASE_URL=http://localhost:8787
```

## Quickstart

```python
from grad import Grad
from grad.recipes import SFTRecipe

client = Grad()  # reads GRADIATED_API_KEY and GRADIATED_BASE_URL

dataset = client.datasets.push("sql-quickstart", [
    {"messages": [
        {"role": "user", "content": "Count active users from yesterday."},
        {"role": "assistant", "content": "SELECT count(*) FROM users WHERE active_at >= current_date - 1;"},
    ]},
    {"messages": [
        {"role": "user", "content": "Total revenue by plan this month."},
        {"role": "assistant", "content": "SELECT plan, sum(amount_usd) FROM invoices GROUP BY plan;"},
    ]},
])

recipe = SFTRecipe(model="qwen/qwen3-8b")

# $0 preview: resolved defaults, warnings, tokens and cost
print(client.runs.plan(dataset=dataset, name="sql-helper", recipe=recipe))

run = client.runs.create(dataset=dataset, name="sql-helper", recipe=recipe, max_cost_usd=5).wait()
print(run.status, run.artifact)

# Self-hosted: download the PEFT LoRA and serve it with vLLM or SGLang.
# Gradiated Cloud: run.deploy() serves it behind a stable name.
run.artifact.download("./sql-helper-bundle.grad.tar.gz", format="bundle")
```

`run.artifact.download("./sql-helper")` (the default `format="peft"`) extracts a verified PEFT
directory (`adapter_config.json` + `adapter_model.safetensors`) that `vllm serve <base>
--enable-lora --lora-modules sql-helper=./sql-helper` loads directly.

## Configuration

Every SDK and the CLI resolve configuration the same way (highest first):

1. explicit arguments: `Grad(api_key=..., base_url=...)`;
2. the selected profile: `Grad(profile=...)` or `GRADIATED_PROFILE` (e.g. `local` after `grad local up`);
3. `GRADIATED_API_KEY` / `GRADIATED_BASE_URL`;
4. the `default` profile in `$XDG_CONFIG_HOME/gradiated/config.json` (written by `grad login`);
5. `https://api.gradiated.com`.

A key saved in a profile is only sent to that profile's base URL, and a selected profile that
doesn't exist is an error. Without a key for a non-loopback server, `Grad()` raises
`GradConfigError` before sending anything (`api_key=""` talks to a server without
authentication). A trailing `/v1` on the base URL is dropped with a warning. Also: `timeout=`
(per request), `max_retries=` (default 2).

## Errors

Every error subclasses `grad.GradError`. HTTP errors are `grad.GradAPIError` subclasses carrying
`status`, `code`, `detail`, `request_id`, the method and URL: `AuthenticationError` (401),
`PermissionDeniedError` (403), `NotFoundError` (404), `ConflictError` (409), `ValidationError`
(422, with field `errors`), `RateLimitError` (429), `DeployUnavailableError` and
`InferenceUnavailableError` (501), `ServerError` (5xx). Network failures raise
`APIConnectionError` / `APITimeoutError`; `wait()` raises `RunFailedError` (code `run_failed`,
`run_cancelled` or `run_stopped_budget`: anything but `completed`), `EvalFailedError`,
`ImportFailedError` or `WaitTimeoutError`; a list endpoint that repeats its cursor raises
`PaginationLoopError` instead of looping. Features documented for later waves raise
`NotAvailableInV0Error` with an alternative.

## Continued training and idempotent calls

```python
from grad import Grad
from grad.recipes import DPORecipe, SFTRecipe

client = Grad()
sft = client.runs.create(dataset="sql-sft", name="sql-helper", recipe=SFTRecipe()).wait()
dpo = client.runs.create(dataset="sql-prefs", name="sql-helper", recipe=DPORecipe(model=sft.artifact),
                         idempotency_key="sql-helper-dpo-1").wait()
```

`runs.create`, `evals.create` and `deploy` send a fresh `Idempotency-Key` per call (reused by
its retries); pass `idempotency_key=` to make a retry from another process return the first call's
result instead of starting a second run.

## Development

```bash
PYTHONPATH=sdks/python python3 -m unittest discover -s sdks/python/tests
```

Unit tests use a scripted fake `httpx` transport and the shared wire fixtures in `tests/fixtures/wire`.
`test_live.py` runs these snippets against `tests/harness/stack.ts`; it skips unless
`server/api/node_modules` exists (`pnpm -C server/api install --frozen-lockfile`), and the Cloud
deploy flow also needs `GRAD_TRAINER_PYTHON` (a Python with torch, transformers and peft). The
transport in `grad/_generated/client.py` is generated from `spec/openapi.yaml` by
`node scripts/generate-sdks.mjs`.
