# grad-trainer

Training runtime for `grad-server`: the eight v0 recipes on torch + transformers + peft, the
`.grad.tar.gz` artifact bundle format, the import runner, file formats (`grad_trainer/formats.py`)
and the observability source providers (`grad_trainer/providers/`, see its README).
Every artifact bundle format is specified in [`docs/ARTIFACT_FORMATS.md`](../../docs/ARTIFACT_FORMATS.md),
validated by `grad_trainer/artifact_formats.py` against the JSON Schemas in
`grad_trainer/artifact_schemas/` (linked as `spec/artifacts/`).

| Recipe      | Trains                                                          | Artifact (`format`)                                                         |
| ----------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `sft`       | LoRA on a causal LM, assistant-only thinking-aware loss, packed | PEFT adapter (`peft_lora`), or merged safetensors (`merged_safetensors`)    |
| `dpo`       | LoRA, sigmoid DPO against the base with the adapter disabled    | PEFT adapter (`peft_lora`)                                                  |
| `router`    | LoRA backbone + per-candidate success head on recorded scores   | adapter + `router_head.safetensors` + `router_config.json` (`router_bundle`) |
| `decision`  | LoRA (or frozen) backbone + one head per question               | adapter + `decision_head.safetensors` + `decision_config.json`              |
| `cartridge` | Input embeddings distilled from the model reading the context   | `cartridge.safetensors`, `gradiated.cartridge/1` (`cartridge`)              |
| `embedding` | Full encoder fine-tune with in-batch-negative InfoNCE           | transformers + sentence-transformers directory (`encoder_safetensors`)      |
| `distill`   | LoRA student: on-policy top-k KL to a local teacher, or SFT on its answers | PEFT adapter (`peft_lora`), or merged safetensors (`merged_safetensors`)    |
| `reward`    | LoRA (or frozen) backbone + scalar head, Bradley-Terry and pointwise | adapter + `reward_head.safetensors` + `reward_config.json` (`reward_bundle`) |

Each module docstring in `grad_trainer/recipes/` describes the data it accepts, the loss and
the eval report. `scripts/gpu-smoke/{distill,reward}.py` run the distillation and reward-model
recipes for a few steps on real Qwen3 weights on one GPU and print a JSON summary. All recipes share one loop (`grad_trainer/trainer.py`) for batching, LR
schedule (warmup, then linear/cosine decay to zero), real-token metering, the budget stop,
checkpoints with full resumable state, resume and best-checkpoint selection.

## Worker seam

```python
from grad_trainer.recipes import get_recipe_runner
from grad_trainer import import_runner
from grad_trainer.runner_types import Budget, ResumeState, RunCallbacks

out = get_recipe_runner(kind).run(config, records, budget=Budget(max_cost_usd, price), callbacks=RunCallbacks(on_step, on_checkpoint), resume=ResumeState(step, dir) | None, workdir=path)
summary = import_runner.run(source, connector, emit_batch=post_records, workdir=path, source_page=page_fn)
```

- Import `source` kinds: `file`, `hf` and `provider` (a source sync; `summary.watermark` is the
  watermark to store when the job completes). Records are dataset parts; the worker folds them
  into a `records.MergedDataset` (one record per id, score updates applied, exactly as
  `records.merge_records`) before training. It keeps the records in a JSONL file in the job
  directory and only a small head per record (id, split keys, scores, offset) in memory.
  SFT encodes records as it reads them, so it holds tokens (int32 ids and a bool mask), not
  raw records: measured on 100k SFT rows (50.7M tokens), 403 MiB for the data path where a
  fully loaded dataset with tuple tokens took 2.4 GiB. Budget about 1 KB of RAM per record
  plus 5 bytes per token, and the uncompressed dataset on disk. The other recipes build their
  examples (pairs, prompt groups) from the records first, so they peak near the raw size.

- `RunOutput.tokens_processed` counts tokens metered during this call; metrics carry the
  run's cumulative `tokens` and `cost_usd` (a resume continues the checkpoint's meter).
  Training tokens are tokenizer tokens of every training sequence forwarded (DPO counts
  chosen + rejected; the cartridge teacher's prompts and answers are metered once per call).
  Held-out evaluation is not metered.
- `on_checkpoint(step, eval_score, checkpoint_dir, metadata)`: the directory holds the
  artifact files plus `trainer_state/` and is valid only during the call. Bundle it with
  `bundles.bundle_directory(checkpoint_dir, out, manifest={**metadata["manifest"], "kind": "checkpoint", "step": step})`. To resume,
  `bundles.extract_bundle(downloaded, dir)` and pass `ResumeState(step, dir)`.
- The final artifact is `bundles.bundle_directory(out.artifact_dir, path, manifest=out.manifest, eval_report=out.eval_report)`.
  `bundle_directory` stamps `format_version` and `created_by`, and raises `ValueError` when the
  manifest or the format's config file breaks its schema; the worker then fails the job.

## Running the worker

`grad-trainer` (the image's command) polls `GRAD_SERVER_URL` with `TRAINER_API_KEY` and claims
the job kinds in `GRAD_WORKER_KINDS` (default `train,import`). Run GPU pools with `train` and a
CPU pool with `import`: imports and source syncs are the only jobs that carry workspace secrets.
Also: `GRAD_WORKER_ID` (a name prefix, default host-pid; every process appends a random suffix), `GRAD_LEASE_SECONDS` (180),
`GRAD_POLL_INTERVAL_S` (1.0), `GRAD_WORKDIR` (a temp dir; each job gets a locked directory in it,
and a restarted worker deletes the ones a killed worker left, so a crash loop can't fill the disk).

`GRAD_WORKER_METRICS_PORT` serves Prometheus metrics (`grad_trainer_*`: phase, step time,
tokens/s, GPU utilisation and memory, checkpoint and upload times) on that port. Every
heartbeat also carries the phase, tokens/s and GPU numbers, which grad-server aggregates into
its `grad_worker_*` gauges, so pools that can't be scraped still show up.

## Dev inference (`grad-dev-inference`)

`grad local up --dev-models` runs the image's `grad-dev-inference` command (`grad_trainer/dev_inference.py`):
a stdlib HTTP server with an OpenAI-compatible `POST /v1/chat/completions` for the local stack's evals. It
serves the dev models by catalog id, `peft_lora`/`merged_safetensors` artifacts trained on them by artifact
id (downloaded from `GRAD_SERVER_URL` with `GRADIATED_API_KEY`, checked against `X-Grad-Workspace`), and the
deterministic `test/tiny-judge`. CPU only, one completion at a time, models loaded on first use. Settings:
`GRAD_DEV_INFERENCE_HOST`/`_PORT` (`127.0.0.1`/`8000`), `GRAD_DEV_INFERENCE_CACHE` (loaded models, 4),
`GRAD_DEV_INFERENCE_MAX_TOKENS` (64). See docs/SELF_HOSTING.md, "Local development".

## Models

Catalog ids map to Hugging Face repos (`qwen/qwen3-8b` -> `Qwen/Qwen3-8B`, ...). Override with
`GRAD_MODEL_PATHS='{"qwen/qwen3-8b": "/models/qwen3-8b"}'` or point `GRAD_MODELS_MIRROR` at a
directory or `s3://bucket/prefix` holding `<id>/` or `<repo>/` (air-gapped installs; S3 objects
are cached in `GRAD_MODELS_CACHE`). With `HF_HUB_OFFLINE=1` or `GRAD_OFFLINE=1` the trainer
never downloads and fails with `model_unavailable` instead. `gradiated/linden-1` weights are
not public and must be provided this way.

Other settings: `GRAD_TRAINER_DEVICE` (default `cuda` when available), `GRAD_TORCH_THREADS`.
v0 trains on one device.

### GPU memory and throughput

Measured on one H100 80 GB at the SFT defaults (LoRA rank 32, batch 128, gradient
checkpointing, chunked cross-entropy, varlen packing, `micro_batch_tokens` by model size,
`PYTORCH_CUDA_ALLOC_CONF=expandable_segments:True`). Peak is torch's reserved memory; the
catalog's `min_gpu_memory_gb` adds headroom, and `runs.plan` refuses a run that needs more
than one 80 GB GPU. Tokens/s is the median SFT step rate; `server/api/src/gpu-profile.ts`
holds the same numbers for `estimated_duration_s`.

| Base | Peak reserved | `min_gpu_memory_gb` | SFT tokens/s | Load to first step |
| --- | --- | --- | --- | --- |
| Qwen3-0.6B | 4.7 GiB | 8 | 19,700 | 13 s |
| Qwen3-1.7B | 9.1 GiB | 12 | 13,700 | 17 s |
| Qwen3-4B | 16.7 GiB | 20 | 7,500 | 28 s |
| Qwen3-8B | 28.5 GiB (29.2 GiB on nvidia-smi over a full run) | 36 | 5,500 | 37 s |
| Qwen3-14B | 45.5 GiB (46.7 GiB over a full run) | 56 | 3,600 | 55 s |
| Qwen3-32B | 76.6 GiB | not trainable in v0 | 1,600 | 117 s |

Qwen3-32B leaves under 4 GB of an 80 GB GPU free even with 4,096-token micro-batches, so it is
an eval and judge model only. A held-out eval costs about 20 s at 8B (285 records), against
under 2 s of training pause for a checkpoint, which is why evals default to every 25% of the
run while checkpoints are taken every 10% of steps or 5 minutes.

`GRAD_TRAINER_BACKEND=reference` selects a stdlib-only **test double** that runs the same loop
over a hashed bag-of-words model. Its artifacts are `format: reference`, `deployable: false`.

## Install and test

```bash
cd server/trainer
python3 -m venv .venv && . .venv/bin/activate
pip install --require-hashes --no-deps -r requirements-cpu.lock   # CPU torch; use requirements-gpu.lock on CUDA hosts
pip install -r requirements-dev.txt
PYTHONPATH=. python -m coverage run -m unittest discover -s tests && python -m coverage report
```

The suite trains every recipe on tiny randomly initialised models built locally (no network);
it takes about 20 seconds on 4 CPU threads. `tests/test_torch_*.py` and the parity checks
skip when torch is not installed, so `PYTHONPATH=server/trainer python3 -m unittest discover -s server/trainer/tests`
still runs the other tests anywhere `jsonschema` is installed. The split-parity test also runs `planner.ts` when
`server/api/node_modules` is installed.

Both locks are hash-pinned and resolve from PyPI only; installs use `--require-hashes`, so
a package with the same name and version on another index can't be substituted. The one
exception, CPU torch, is pinned in `requirements-cpu-override.txt` to its exact x86_64 and
aarch64 wheels on download.pytorch.org (and hashed like the rest); the CPU lock is universal,
because the CPU image is built for linux/amd64 and linux/arm64. Regenerate the locks after changing
`requirements.txt`:

```bash
uv pip compile requirements.txt --python-version 3.12 --python-platform x86_64-manylinux_2_28 --no-header --annotation-style line --index-url https://pypi.org/simple --generate-hashes --emit-index-url -o requirements-gpu.lock
uv pip compile requirements.txt --universal --python-version 3.13 --no-header --annotation-style line --override requirements-cpu-override.txt --index-url https://pypi.org/simple --generate-hashes --emit-index-url -o requirements-cpu.lock
```

A torch upgrade also updates both wheel URLs in `requirements-cpu-override.txt`.

`docker build --target gpu` (default) builds the CUDA 13 image; `--target cpu` the CPU one.
Both run as uid 10001.
