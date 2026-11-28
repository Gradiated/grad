# grad-sdk (Python)

The Python SDK for the Gradiated training platform: push datasets, preview and launch managed
fine-tuning runs, evaluate models, download PEFT adapters, and upload or import weights trained elsewhere.

- Python 3.11+, one dependency (`httpx`); a blocking `Grad` client (from asyncio, call it via `asyncio.to_thread`).
- Typed objects with a `.raw` escape hatch, `py.typed`, typed errors, retries with backoff.
- Works against a self-hosted `grad-server`, and Gradiated Cloud once it opens.

```bash
pip install grad-sdk
export GRADIATED_API_KEY=grad_...
# Self-hosted server: export GRADIATED_BASE_URL=http://localhost:18787
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

# Download the PEFT LoRA and serve it with vLLM or SGLang.
run.artifact.download("./sql-helper-bundle.grad.tar.gz", format="bundle")
```

`run.artifact.download("./sql-helper")` (the default `format="peft"`) extracts a verified PEFT
directory (`adapter_config.json` + `adapter_model.safetensors`) that `vllm serve <base>
--enable-lora --lora-modules sql-helper=./sql-helper` loads directly.

Weights trained elsewhere become artifacts too: `client.artifacts.upload("./my-lora",
base="qwen/qwen3-8b").wait()` uploads a directory (tarred) or a `.tar.gz`, and
`client.artifacts.from_hf("hf://acme/support-lora@main", base="qwen/qwen3-8b").wait()` imports a
Hugging Face repo at a pinned commit. An import worker checks the files against the artifact
format spec and the base model; a failure raises `grad.ArtifactImportFailedError` (`code`
`invalid_artifact`, `status` 422) naming the file. The result is a normal `Artifact` (with
`provenance.source` `upload` or `import`) that you can download, evaluate or pass as `model=`.
`artifact.delete()` deletes one (a `ConflictError` while a published Cloud model version pins it).

## Following a run

`run.wait()` blocks until the run ends. In a terminal it draws one live line on stderr (phase,
step/total, loss, ETA, cost against `max_cost_usd`; "Waiting for a GPU (0 workers online) — 2m 10s"
while queued), with interruptions and warnings printed above it as they happen:

```text
⚠ attempt 1 interrupted at step 120: the GPU was reclaimed; resuming from step 120 on a new worker
Training  attempt 2  180/400 [█████       ] 45%  loss 0.412  ETA 3m 20s  $0.42/$5.00
```

In Jupyter it is a small display updated in place, with a loss sparkline. It is silent when
nothing is watching (not a TTY, `CI`, `TERM=dumb`); `wait(progress=False)` or `GRAD_NO_PROGRESS=1`
turns it off, `progress=True` forces it.

Every lifecycle event is typed. Iterate them (a plain sync iterator; reconnects with
`Last-Event-ID` are invisible), or pass a callback:

```python
import grad

for ev in run.events(follow=True):            # stops after the CompletedEvent
    if isinstance(ev, grad.PhaseEvent):
        print(ev.phase, ev.workers_online, ev.gpu)
    elif isinstance(ev, grad.MetricEvent):
        print(ev.step, ev.metric.loss)
    elif isinstance(ev, grad.AttemptEvent):     # started | interrupted | gave_up
        print(ev.message)

run.wait(on_event=lambda ev: print(ev.type, ev.seq), progress=False)
```

Events are `PhaseEvent`, `MetricEvent`, `CheckpointEvent`, `AttemptEvent`, `WarningEvent`,
`LogEvent` and `CompletedEvent` (the final `run`), each with `type`, `run_id`, `seq`, `attempt` and
`timestamp`. `run.events()` without `follow` returns the events stored so far. The run itself
carries `phase`, `phase_since`, `last_interruption`, and `workers_online`/`autoscaling` while queued.

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
(422, with field `errors`), `RateLimitError` (429; its subclass `QueueLimitError` is the
workspace's queued-jobs cap, raised at once and never retried), `InferenceUnavailableError` and
`FeatureUnavailableError` (501), `ServerError` (5xx). Network failures raise
`APIConnectionError` / `APITimeoutError`; `wait()` raises `RunFailedError` (code `run_failed`,
`run_cancelled` or `run_stopped_budget`: anything but `completed`), `EvalFailedError`,
`ImportFailedError`, `ArtifactImportFailedError` or `WaitTimeoutError`; a list endpoint that repeats its cursor raises
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

`runs.create`, `evals.create` and the artifact uploads and imports send a fresh `Idempotency-Key` per call (reused by
its retries); pass `idempotency_key=` to make a retry from another process return the first call's
result instead of starting a second run.

## Development

```bash
PYTHONPATH=sdks/python python3 -m unittest discover -s sdks/python/tests
```

Unit tests use a scripted fake `httpx` transport and the shared wire fixtures in `tests/fixtures/wire`.
`test_live.py` runs these snippets against `tests/harness/stack.ts`; it skips unless
`server/api/node_modules` exists (`pnpm -C server/api install --frozen-lockfile`), and the
torch-worker tests (continued training, artifact uploads) also need `GRAD_TRAINER_PYTHON` (a Python with torch, transformers and peft). The
transport in `grad/_generated/client.py` is generated from `spec/openapi.yaml` by
`node scripts/generate-sdks.mjs`.
