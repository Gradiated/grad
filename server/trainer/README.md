# grad-trainer

Training runtime for `grad-server`: the six v0 recipes on torch + transformers + peft, the
`.grad.tar.gz` artifact bundle format, the import runner and the Tier-1 trace connectors.

| Recipe      | Trains                                                          | Artifact (`format`)                                                         |
| ----------- | --------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `sft`       | LoRA on a causal LM, assistant-only thinking-aware loss, packed | PEFT adapter (`peft_lora`), or merged safetensors (`merged_safetensors`)    |
| `dpo`       | LoRA, sigmoid DPO against the base with the adapter disabled    | PEFT adapter (`peft_lora`)                                                  |
| `router`    | LoRA backbone + per-candidate success head on recorded scores   | adapter + `router_head.safetensors` + `router_config.json` (`router_bundle`) |
| `decision`  | LoRA (or frozen) backbone + one head per question               | adapter + `decision_head.safetensors` + `decision_config.json`              |
| `cartridge` | Input embeddings distilled from the model reading the context   | `cartridge.safetensors`, `gradiated.cartridge/1` (`cartridge`)              |
| `embedding` | Full encoder fine-tune with in-batch-negative InfoNCE           | transformers + sentence-transformers directory (`encoder_safetensors`)      |

Each module docstring in `grad_trainer/recipes/` describes the data it accepts, the loss and
the eval report. All recipes share one loop (`grad_trainer/trainer.py`) for batching, LR
schedule (warmup, then linear/cosine decay to zero), real-token metering, the budget stop,
checkpoints with full resumable state, resume and best-checkpoint selection.

## Worker seam

```python
from grad_trainer.recipes import get_recipe_runner
from grad_trainer import import_runner
from grad_trainer.runner_types import Budget, ResumeState, RunCallbacks

out = get_recipe_runner(kind).run(config, records, budget=Budget(max_cost_usd, price), callbacks=RunCallbacks(on_step, on_checkpoint), resume=ResumeState(step, dir) | None, workdir=path)
summary = import_runner.run(source, connector, emit_batch=post_records, workdir=path)
```

- `RunOutput.tokens_processed` counts tokens metered during this call; metrics carry the
  run's cumulative `tokens` and `cost_usd` (a resume continues the checkpoint's meter).
  Training tokens are tokenizer tokens of every training sequence forwarded (DPO counts
  chosen + rejected; the cartridge teacher's prompts and answers are metered once per call).
  Held-out evaluation is not metered.
- `on_checkpoint(step, eval_score, checkpoint_dir, metadata)`: the directory holds the
  artifact files plus `trainer_state/` and is valid only during the call. Bundle it with
  `bundles.bundle_directory(checkpoint_dir, out, manifest=metadata["manifest"])`. To resume,
  `bundles.extract_bundle(downloaded, dir)` and pass `ResumeState(step, dir)`.
- The final artifact is `bundles.bundle_directory(out.artifact_dir, path, manifest=out.manifest, eval_report=out.eval_report)`.

## Models

Catalog ids map to Hugging Face repos (`qwen/qwen3-8b` -> `Qwen/Qwen3-8B`, ...). Override with
`GRAD_MODEL_PATHS='{"qwen/qwen3-8b": "/models/qwen3-8b"}'` or point `GRAD_MODELS_MIRROR` at a
directory or `s3://bucket/prefix` holding `<id>/` or `<repo>/` (air-gapped installs; S3 objects
are cached in `GRAD_MODELS_CACHE`). With `HF_HUB_OFFLINE=1` or `GRAD_OFFLINE=1` the trainer
never downloads and fails with `model_unavailable` instead. `gradiated/linden-1` weights are
not public and must be provided this way.

Other settings: `GRAD_TRAINER_DEVICE` (default `cuda` when available), `GRAD_TORCH_THREADS`.
v0 trains on one device; LoRA on 32B in bf16 needs an 80 GB GPU.

`GRAD_TRAINER_BACKEND=reference` selects a stdlib-only **test double** that runs the same loop
over a hashed bag-of-words model. Its artifacts are `format: reference`, `deployable: false`.

## Install and test

```bash
cd server/trainer
python3 -m venv .venv && . .venv/bin/activate
pip install -r requirements-cpu.lock -r requirements-dev.txt   # CPU torch; use requirements-gpu.lock on CUDA hosts
PYTHONPATH=. python -m coverage run -m unittest discover -s tests && python -m coverage report
```

The suite trains every recipe on tiny randomly initialised models built locally (no network);
it takes about 20 seconds on 4 CPU threads. `tests/test_torch_*.py` and the parity checks
skip when torch is not installed, so `PYTHONPATH=server/trainer python3 -m unittest discover -s server/trainer/tests`
still runs the stdlib tests anywhere. The split-parity test also runs `planner.ts` when
`server/api/node_modules` is installed.

Regenerate the locks after changing `requirements.txt`:

```bash
uv pip compile requirements.txt --python-version 3.12 --python-platform x86_64-manylinux_2_28 --no-header --annotation-style line -o requirements-gpu.lock
uv pip compile requirements.txt --python-version 3.13 --python-platform x86_64-manylinux_2_28 --no-header --annotation-style line --override requirements-cpu-override.txt --index-url https://download.pytorch.org/whl/cpu --extra-index-url https://pypi.org/simple --index-strategy unsafe-best-match --emit-index-url -o requirements-cpu.lock
```

`docker build --target gpu` (default) builds the CUDA 13 image; `--target cpu` the CPU one.
Both run as uid 10001.
