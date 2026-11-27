# Artifact bundle formats

Every grad training run produces one artifact bundle: a `.grad.tar.gz` file holding the trained weights, the config needed to serve them, and a manifest. This document specifies the bundle envelope (`grad.artifact/1`) and the six formats inside it, so a serving stack can load any artifact without reading the trainer's code.

- JSON Schemas: [`spec/artifacts/`](../spec/artifacts/). [`manifest.schema.json`](../spec/artifacts/manifest.schema.json) covers `manifest.json`, and `<format>.schema.json` covers each format's config file. The trainer checks every bundle it writes against them (`grad_trainer/artifact_formats.py`) and refuses to upload one that fails.
- Reference loaders: the Python blocks marked `# loader: <name>` below are the reference loaders. `server/trainer/tests/test_artifact_formats.py` runs them exactly as written. They use only the files this document lists, plus `torch`, `transformers`, `peft` and `safetensors`. They never import the trainer. The tests compare their outputs with the trainer's own inference code for every recipe.

| `format` | Recipe (`recipe_kind`) | Config file | Needs the base model | Gradiated Cloud v0 |
| --- | --- | --- | --- | --- |
| [`peft_lora`](#peft_lora) | `sft`, `dpo` | `adapter_config.json` | yes | deploy |
| [`merged_safetensors`](#merged_safetensors) | `sft` with `merge_on_export` | `config.json` | no | download only |
| [`cartridge`](#cartridge) | `cartridge` | `cartridge.safetensors` header | yes | deploy |
| [`encoder_safetensors`](#encoder_safetensors) | `embedding` | `grad_embedding.json` | no | deploy |
| [`router_bundle`](#router_bundle) | `router` | `router_config.json` | yes | deploy |
| [`decision_bundle`](#decision_bundle) | `decision` | `decision_config.json` | yes | deploy |
| [`reference`](#reference-test-only) | any | none | no | never (test double) |

## Versioning

- `schema: "grad.artifact/1"` versions the envelope: the tar layout, `manifest.json` and checksums.
- `format_version` (an integer, currently `1` for every format) versions one format's files and config.
- Additive changes keep the version: a new optional config field, a new informational manifest field, or a new file a loader can ignore.
- Any change an existing loader would misread bumps `format_version`. That covers renamed or removed fields or files, changed tensor names, dtypes or shapes, and changed input rendering or calibration math.
- Readers must reject a `format_version` they don't know. The trainer only ever writes the current version of each format.

## The bundle: `grad.artifact/1`

A bundle is a gzip-compressed tar of regular files. `manifest.json` sits at the root, and `eval_report.json` is there when the run produced an evaluation report. Every other file is payload, at the paths the format sections give. Bundles are reproducible: the same inputs give the same bytes, because entries are sorted, `mtime` is 0, uid and gid are 0, and owner names are empty.

Read bundles with a hardened reader. grad's own reader (`server/trainer/grad_trainer/bundles.py`) follows these rules:

- Accept regular files only. Reject symlinks, hard links, devices and directories as entries.
- Accept only relative POSIX paths: no leading `/`, no `.` or `..` segments, no empty segments, no `\` and no NUL.
- Reject duplicate entries. Cap the member count (1024) and the declared and actually-read bytes. The largest bundles are merged 32B checkpoints of about 64 GB.
- Check every payload file against `manifest.files`. A missing file, an undeclared file or a checksum mismatch fails the whole bundle.
- When `eval_report.json` is present, its SHA-256 must equal `eval_report_sha256`. When `eval_report_sha256` is set, the file must be present.

Checksums give integrity, not authenticity. The API reports each artifact's bundle `sha256` and `size_bytes`; check both after downloading.

### `manifest.json`

The stable fields are below. [`manifest.schema.json`](../spec/artifacts/manifest.schema.json) requires them and enforces, per format, the files and `recipe_kind` values a bundle must have.

| Field | Type | Meaning |
| --- | --- | --- |
| `schema` | `"grad.artifact/1"` | Envelope version. |
| `kind` | `"final"` \| `"checkpoint"` | `final` is a run's exported artifact. `checkpoint` is an intermediate checkpoint, which may later be promoted to an artifact. |
| `step` | integer | Checkpoints only: the optimizer step. |
| `format` | string | One of the formats in the table above. |
| `format_version` | integer | Version of that format (see [Versioning](#versioning)). |
| `recipe_kind` | string | `sft`, `dpo`, `router`, `decision`, `cartridge` or `embedding`. |
| `base_model` | string | The grad catalog id the run trained on, such as `qwen/qwen3-8b`. |
| `base_model_repo` | string | The Hugging Face repo (or local path) to load the base weights from, such as `Qwen/Qwen3-8B`. Only `reference` bundles have `null`. |
| `base_model_revision` | string \| null | The 40-hex Hugging Face commit of those weights. It is `null` when the trainer loaded weights from a path or mirror with no revision marker (`.grad_revision`). Cloud serving requires it to equal the pool's revision, so it refuses `null`. |
| `deployable` | boolean | `false` only for `reference` bundles, which hold no trained weights. Which formats Cloud serves is in the table above, not here. |
| `created_by` | `{"name": "grad-trainer", "version": "0.2.0"}` | The trainer version that wrote the bundle. |
| `files` | object | Maps each payload path to its lowercase hex SHA-256. It never lists `manifest.json` or `eval_report.json`. |
| `eval_report_sha256` | string | SHA-256 of `eval_report.json`, when the bundle has one. |

Every other field is informational training metadata, which may change without a version bump. Examples are `lr`, `seed`, `select`, `selected_step`, `steps_completed`, `tokens_total`, `status`, `template_revision`, `thinking`, `train_on`, `adapter`, `versions` (torch, transformers and peft) and per-recipe summaries such as `candidates` or `questions`. Serving must take its runtime config from the format's config file, not from these fields.

grad-server stores the final bundle's manifest as the artifact's `manifest` and adds `run_id`, `attempt`, `dataset`, `dataset_version` and `resolved_config`. For a promoted checkpoint, the API manifest is the checkpoint's training metadata instead. Either way, the `manifest.json` inside the bundle is authoritative.

### `eval_report.json`

`eval_report.json` holds the held-out evaluation report, which the API serves as the artifact's `eval_report`. It has `metric_name`, `selected_step`, `best_step`, `final_step`, `train_records`, `eval_records` and `warnings`, plus the recipe's metrics: `eval_loss` for SFT, `preference_accuracy` for DPO, `pareto_summary` for the router, per-question `heads` for decision models, `recall_at_k` and `mrr` for embeddings, and `eval_kl` for cartridges. Serving doesn't need it. It is there to show users and to gate promotion.

### Checkpoint bundles

A checkpoint bundle (`kind: "checkpoint"`) has the same format files as a final bundle, exported at that step, plus `trainer_state/`. That directory holds the training weights, optimizer state and loop state used to resume a run, and loaders ignore it. Calibration happens once, at the end of a run. A router or decision checkpoint therefore has `calibrated: false`, `temperature` 1.0 and, for a router, `threshold: null`, so it never offloads.

### Opening a bundle

```python
# loader: common
import hashlib
import json
import tarfile
from pathlib import Path

FORMAT_VERSIONS = {
    "peft_lora": 1,
    "merged_safetensors": 1,
    "cartridge": 1,
    "encoder_safetensors": 1,
    "router_bundle": 1,
    "decision_bundle": 1,
}
RESERVED = {"manifest.json", "eval_report.json"}


def open_bundle(bundle_path, dest):
    """Extract a .grad.tar.gz into a new directory, verify it and return its manifest."""
    dest = Path(dest)
    dest.mkdir(parents=True)
    with tarfile.open(bundle_path, "r:gz") as tar:
        for member in tar:
            if not member.isfile():
                raise ValueError(f"{member.name} is not a regular file")
        tar.extractall(dest, filter="data")  # also refuses absolute paths and '..'
    manifest = read_manifest(dest)
    on_disk = {p.relative_to(dest).as_posix() for p in dest.rglob("*") if p.is_file()}
    if on_disk - RESERVED != set(manifest["files"]):
        raise ValueError("the bundle's files don't match manifest.json")
    expected = dict(manifest["files"])
    if ("eval_report.json" in on_disk) != ("eval_report_sha256" in manifest):
        raise ValueError("eval_report.json and eval_report_sha256 must come together")
    if "eval_report_sha256" in manifest:
        expected["eval_report.json"] = manifest["eval_report_sha256"]
    for name, sha256 in expected.items():
        with open(dest / name, "rb") as fh:
            if hashlib.file_digest(fh, "sha256").hexdigest() != sha256:
                raise ValueError(f"checksum mismatch for {name}")
    return manifest


def read_manifest(bundle_dir):
    manifest = json.loads((Path(bundle_dir) / "manifest.json").read_text())
    if manifest.get("schema") != "grad.artifact/1":
        raise ValueError(f"unsupported bundle schema {manifest.get('schema')!r}")
    if FORMAT_VERSIONS.get(manifest["format"]) != manifest["format_version"]:
        raise ValueError(f"unsupported format {manifest['format']} v{manifest['format_version']}")
    return manifest


def load_base(config, dtype):
    """The base causal LM and its tokenizer, pinned to the revision the run trained on."""
    from transformers import AutoModelForCausalLM, AutoTokenizer

    pin = {"revision": config["base_model_revision"]} if config["base_model_revision"] else {}
    tokenizer = AutoTokenizer.from_pretrained(config["base_model_repo"], **pin)
    model = AutoModelForCausalLM.from_pretrained(config["base_model_repo"], dtype=dtype, **pin)
    return tokenizer, model.eval()
```

The loaders below take the extracted directory (`dest`). `load_base` accepts the manifest or any config file that carries `base_model_repo` and `base_model_revision`.

## Prompts and chat templates

The causal-LM formats (`peft_lora`, `cartridge`, `router_bundle` and `decision_bundle`) were trained on prompts rendered with the base model's chat template. For Qwen3, grad's pinned renderer (`template_revision: "qwen3@3"`) reproduces the Hugging Face Qwen3 `chat_template` byte for byte, and a test checks this. Serving therefore renders with the base model's tokenizer (`apply_chat_template`) and tokenizes the result with `add_special_tokens=False`. `thinking` and `preserve_thinking` in the manifest record how the run handled reasoning:

- `thinking: "off"` trains answers behind the empty `<think>\n\n</think>\n\n` block, which is what Qwen3's generation prompt contains with `enable_thinking=False`.
- `preserve_thinking: true` kept the reasoning of earlier assistant turns, which the stock template drops. Serve such an artifact with conversations whose earlier reasoning is removed, or accept a small train/serve mismatch.

## `peft_lora`

A standard [PEFT](https://github.com/huggingface/peft) LoRA adapter for the base causal LM. It is what vLLM, SGLang and Gradiated Cloud's LoRA pools load.

Files:

| File | Contents |
| --- | --- |
| `adapter_config.json` | The PEFT config ([`peft_lora.schema.json`](../spec/artifacts/peft_lora.schema.json)). |
| `adapter_model.safetensors` | The LoRA weights. |

Tensors in `adapter_model.safetensors`, for every layer `i` and every target module:

| Name | Dtype | Shape |
| --- | --- | --- |
| `base_model.model.model.layers.{i}.self_attn.{q,k,v,o}_proj.lora_A.weight` | F32 | `[r, in_features]` |
| `base_model.model.model.layers.{i}.self_attn.{q,k,v,o}_proj.lora_B.weight` | F32 | `[out_features, r]` |
| `base_model.model.model.layers.{i}.mlp.{gate,up,down}_proj.lora_{A,B}.weight` | F32 | same pattern |

The weights stay F32 even when the base model trains in BF16, because PEFT keeps adapter weights in full precision. Serving may cast them to the base dtype.

Runtime config, from `adapter_config.json`:

- `r` is the rank (default 32) and `lora_alpha` is alpha (default 32). The update is `B @ A * lora_alpha / r`: no rsLoRA, no DoRA, `bias: "none"`, `lora_dropout: 0`.
- `target_modules` defaults to all seven projections: `q_proj`, `k_proj`, `v_proj`, `o_proj`, `gate_proj`, `up_proj` and `down_proj`.
- `base_model_name_or_path` equals the manifest's `base_model_repo`, and `revision` equals `base_model_revision`.
- `task_type` is `"CAUSAL_LM"` and `peft_type` is `"LORA"`. PEFT also writes its other keys, at their defaults.

```python
# loader: peft_lora
import torch
from peft import PeftModel


def load_lora(bundle_dir, dtype=torch.bfloat16):
    """The base model with the adapter applied, and the base tokenizer (with its chat template)."""
    tokenizer, base = load_base(read_manifest(bundle_dir), dtype)
    return tokenizer, PeftModel.from_pretrained(base, str(bundle_dir)).eval()
```

The adapter is also ready for vLLM or SGLang as is:

```bash
vllm serve Qwen/Qwen3-8B --revision <base_model_revision> --enable-lora --max-lora-rank 32 \
  --lora-modules fast-diff-merge=./fast-diff-merge
```

SFT and DPO runs can continue from a `peft_lora` artifact. The new run loads this adapter onto the same `base_model_repo` with the same rank and alpha.

## `merged_safetensors`

The LoRA merged into the base weights: a standalone Hugging Face causal LM for download. Cloud does not serve it. Use `peft_lora` for that.

| File | Contents |
| --- | --- |
| `config.json` | transformers model config ([`merged_safetensors.schema.json`](../spec/artifacts/merged_safetensors.schema.json)). |
| `generation_config.json` | Generation defaults from the base model. |
| `model.safetensors`, or `model-0000k-of-0000n.safetensors` plus `model.safetensors.index.json` | All weights, with the base model's tensor names (`model.embed_tokens.weight`, `model.layers.{i}...`, `lm_head.weight`). Shards are at most 5 GB. The dtype is the base config's dtype (BF16 for Qwen3), or F32 when the config declares none. |
| `tokenizer.json`, `tokenizer_config.json`, `chat_template.jinja` | The base tokenizer and chat template. |

```python
# loader: merged_safetensors
import torch
from transformers import AutoModelForCausalLM, AutoTokenizer


def load_merged(bundle_dir, dtype=torch.bfloat16):
    tokenizer = AutoTokenizer.from_pretrained(bundle_dir)
    return tokenizer, AutoModelForCausalLM.from_pretrained(bundle_dir, dtype=dtype).eval()
```

`vllm serve ./merged-dir` serves it the same way.

## `cartridge`

A Context Cartridge is `K` learned input embeddings. At inference they replace `K` reserved slot tokens at the start of the system prompt. After prefill the cartridge is ordinary KV cache: a learned, cacheable prefix that stands in for a long context. The file format is `gradiated.cartridge/1`, the same one Gradiated Cloud's cartridge upload accepts.

| File | Contents |
| --- | --- |
| `cartridge.safetensors` | Two tensors plus text metadata. [`cartridge.schema.json`](../spec/artifacts/cartridge.schema.json) validates its safetensors header. |

| Tensor | Dtype | Shape |
| --- | --- | --- |
| `embeddings` | BF16 | `[K, hidden_size]` |
| `slot_token_ids` | I64 | `[K]`, every entry the slot token's id |

Safetensors metadata (all values are strings):

| Key | Example | Meaning |
| --- | --- | --- |
| `format` | `gradiated.cartridge/1` | File format. |
| `placement` | `system_prompt_start` | The only placement. |
| `separator` | `"\n\n"` | Text between the slot tokens and the original system prompt (at most 64 characters). |
| `slot_token` | `<|vision_pad|>` | A reserved special token that tokenizes to exactly one id. It is the first of `<|vision_pad|>`, `<|image_pad|>`, `<|video_pad|>` and `<|fim_pad|>` that the tokenizer has, unless the run set `slot_token`. |
| `num_tokens` | `"256"` | `K`. |
| `hidden_size` | `"4096"` | The base model's embedding width. |
| `base_model` | `Qwen/Qwen3-8B` | The base repo (also `base_model_repo` in the manifest). |

Serving a cartridge:

1. Build the system message as `slot_token * K + separator + <original system prompt>`. With no system message, insert one with the content `slot_token * K + separator`.
2. Render with the chat template, `add_generation_prompt=True` and `enable_thinking = (manifest["thinking"] != "off")`, as the run did.
3. If the rendered prompt holds the slot token anywhere else (more than `K` times in all), refuse the request. Look up the token embeddings, and at the `K` slot positions use `embeddings` instead, cast to the model dtype. Generated tokens are never replaced, even when the model emits the slot token.
4. Run the model on `inputs_embeds`. The resulting KV cache for the prefix can be reused across requests.

```python
# loader: cartridge
import torch
from safetensors import safe_open


class Cartridge:
    def __init__(self, bundle_dir, dtype=torch.bfloat16):
        bundle_dir = Path(bundle_dir)
        manifest = read_manifest(bundle_dir)
        with safe_open(str(bundle_dir / "cartridge.safetensors"), "pt") as fh:
            self.meta = fh.metadata()
            self.embeddings = fh.get_tensor("embeddings")
            self.slot_id = int(fh.get_tensor("slot_token_ids")[0])
        self.enable_thinking = manifest["thinking"] != "off"
        self.tokenizer, self.model = load_base(manifest, dtype)

    def input_ids(self, messages):
        """Prompt token ids with the K slot tokens at the start of the system prompt."""
        slots = self.meta["slot_token"] * int(self.meta["num_tokens"]) + self.meta["separator"]
        if messages and messages[0]["role"] == "system":
            messages = [{"role": "system", "content": slots + messages[0]["content"]}, *messages[1:]]
        else:
            messages = [{"role": "system", "content": slots}, *messages]
        text = self.tokenizer.apply_chat_template(
            messages, tokenize=False, add_generation_prompt=True, enable_thinking=self.enable_thinking
        )
        ids = self.tokenizer(text, add_special_tokens=False)["input_ids"]
        if ids.count(self.slot_id) != len(self.embeddings):
            raise ValueError("the prompt itself contains the cartridge slot token")
        return ids

    @torch.no_grad()
    def inputs_embeds(self, ids):
        """Token embeddings of ``ids``, with the cartridge at the first K slot tokens."""
        ids = torch.tensor([ids], device=self.model.device)
        embeds = self.model.get_input_embeddings()(ids)
        slots = (ids[0] == self.slot_id).nonzero()[: len(self.embeddings), 0]
        embeds[0, slots] = self.embeddings.to(embeds.device, embeds.dtype)
        return embeds

    @torch.no_grad()
    def logits(self, ids):
        """Next-token logits at every position of ``ids`` (prompt ids, optionally plus a continuation)."""
        return self.model(inputs_embeds=self.inputs_embeds(ids)).logits[0]

    @torch.no_grad()
    def generate(self, messages, max_new_tokens=256):
        embeds = self.inputs_embeds(self.input_ids(messages))
        mask = torch.ones(embeds.shape[:2], dtype=torch.long, device=embeds.device)
        out = self.model.generate(
            inputs_embeds=embeds, attention_mask=mask, max_new_tokens=max_new_tokens, do_sample=False
        )
        return self.tokenizer.decode(out[0], skip_special_tokens=True)
```

The manifest also records `slot_token_id`, `teacher`, `loss` and `max_new_tokens`. These are informational.

## `encoder_safetensors`

A fully fine-tuned encoder (`bge-small` class). The bundle is a complete transformers model directory, so it doesn't need the base model.

| File | Contents |
| --- | --- |
| `config.json`, `model.safetensors` | The encoder (for example `BertModel`), all weights F32, with standard transformers names. |
| `tokenizer.json`, `tokenizer_config.json` | The tokenizer. |
| `grad_embedding.json` | Runtime config ([`encoder_safetensors.schema.json`](../spec/artifacts/encoder_safetensors.schema.json)). |
| `modules.json`, `sentence_bert_config.json`, `1_Pooling/config.json`, `2_Normalize/.keep` | The sentence-transformers layout of the same pooling and normalization. Informational: the reference loader below doesn't read them, and CI doesn't run sentence-transformers. |

Runtime config, from `grad_embedding.json`:

- `pooling` is `"mean"` (the mean of the last hidden states over non-padding tokens) or `"cls"` (the first token's last hidden state).
- `normalize` is always `true`: vectors are L2-normalized, so the dot product is the cosine similarity.
- `dimensions` is the embedding width (the encoder's `hidden_size`).
- `max_seq_length` is where inputs are cut. Tokenize with the tokenizer's special tokens (`[CLS] … [SEP]`) and truncate on the right.
- Queries and documents use the same encoder with no instruction prefix.
- `temp` is the InfoNCE temperature used in training. It is informational.
- The config also carries `base_model`, `base_model_repo` and `base_model_revision`.

```python
# loader: encoder_safetensors
import torch
import torch.nn.functional as F
from transformers import AutoModel, AutoTokenizer


class Encoder:
    def __init__(self, bundle_dir, dtype=torch.float32):
        self.config = json.loads((Path(bundle_dir) / "grad_embedding.json").read_text())
        self.tokenizer = AutoTokenizer.from_pretrained(bundle_dir)
        self.model = AutoModel.from_pretrained(bundle_dir, dtype=dtype).eval()

    @torch.no_grad()
    def embed(self, texts):
        """L2-normalized embeddings, one row per text."""
        batch = self.tokenizer(
            texts, padding=True, truncation=True, max_length=self.config["max_seq_length"], return_tensors="pt"
        ).to(self.model.device)
        hidden = self.model(**batch).last_hidden_state.float()
        if self.config["pooling"] == "cls":
            pooled = hidden[:, 0]
        else:
            mask = batch["attention_mask"][..., None].float()
            pooled = (hidden * mask).sum(1) / mask.sum(1).clamp(min=1.0)
        return F.normalize(pooled, dim=-1)
```

## Router and decision backbones

`router_bundle` and `decision_bundle` share one backbone: the base causal LM, with a LoRA adapter when `adapter.kind` is `"lora"` or frozen when it is `"frozen_head"`. The feature is the final hidden state of the prompt's last token, taken from the base transformer's `last_hidden_state` (after the final norm, before the LM head). Small float32 linear heads map that feature to scores. Both configs carry the backbone fields:

| Field | Meaning |
| --- | --- |
| `adapter` | `{"kind": "lora", "rank", "alpha", "target_modules"}` or `{"kind": "frozen_head"}`. With `lora`, the bundle also has `adapter_config.json` and `adapter_model.safetensors`, exactly as in [`peft_lora`](#peft_lora). |
| `base_model`, `base_model_repo`, `base_model_revision` | The base model to load. |
| `chat_template_kwargs` | `{"add_generation_prompt": true, "enable_thinking": true}`: arguments for `apply_chat_template`. The prompt ends with the assistant generation header `<|im_start|>assistant\n`. |
| `truncation_side` | `"left"`: when the rendered prompt is longer than `max_seq_len` tokens, keep the last `max_seq_len`. The generation header carries the pooled state. |
| `max_seq_len` | The token limit described above. |
| `pooling` | `"last_token"`. |
| `hidden_size` | The width of the feature. |
| `head_file` | The safetensors file holding the heads. |
| `template_revision`, `thinking`, `train_on`, `preserve_thinking`, `versions`, `input_format` | Informational (see [Prompts and chat templates](#prompts-and-chat-templates)). |

```python
# loader: backbone
import torch
from peft import PeftModel


def load_backbone(bundle_dir, config, dtype):
    """The base model's tokenizer and transformer (LoRA applied when the bundle has one), without the LM head."""
    tokenizer, model = load_base(config, dtype)
    if config["adapter"]["kind"] == "lora":
        model = PeftModel.from_pretrained(model, str(bundle_dir)).eval().get_base_model()
    return tokenizer, model.get_decoder()


def prompt_ids(tokenizer, config, messages):
    text = tokenizer.apply_chat_template(messages, tokenize=False, **config["chat_template_kwargs"])
    ids = tokenizer(text, add_special_tokens=False)["input_ids"]
    return ids[-config["max_seq_len"] :]


@torch.no_grad()
def pooled_state(tokenizer, backbone, config, messages):
    """The float32 feature the heads read: the last prompt token's final hidden state."""
    ids = torch.tensor([prompt_ids(tokenizer, config, messages)], device=backbone.device)
    return backbone(input_ids=ids).last_hidden_state[0, -1].float().cpu()
```

## `router_bundle`

A router predicts each candidate model's chance of a good answer for a prompt. It then sends the prompt to the cheapest candidate predicted to succeed, and otherwise to the fallback model.

| File | Contents |
| --- | --- |
| `router_config.json` | Runtime config ([`router_bundle.schema.json`](../spec/artifacts/router_bundle.schema.json)). |
| `router_head.safetensors` | `weight` F32 `[C, hidden_size]` and `bias` F32 `[C]`. Row `i` scores `candidates[i]`. |
| `adapter_config.json`, `adapter_model.safetensors` | Only when `adapter.kind` is `"lora"`. |

Runtime config, from `router_config.json`, in addition to the backbone fields:

| Field | Meaning |
| --- | --- |
| `candidates` | Candidate model ids as they appeared in the training data, lowercased (at least two). Serving maps them to its own model names. |
| `fallback_model` | The model used when no cheaper candidate qualifies. It is one of `candidates`. |
| `route_order` | The other candidates, cheapest first by `pricing`. Without prices they are in candidate order. |
| `pricing` | USD per request for each candidate (from the run's `pricing` or the logs' `metrics.cost_usd`), or `null` when some candidate had no price. |
| `threshold` | The calibrated success probability a candidate needs. `null` means never offload: always use `fallback_model`. |
| `temperature` | Calibration temperature, fitted on a held-out fold. |
| `calibrated` | `false` when no held-out data was available (`temperature` 1.0), and in checkpoints. |
| `max_quality_drop` | The quality-drop budget the threshold was chosen for. It is informational, and so is `rule`. |

Routing a request:

1. Take the conversation up to and including the last non-assistant turn, dropping any trailing assistant turns.
2. Compute the feature `h` as in [Router and decision backbones](#router-and-decision-backbones), then `logits = weight @ h + bias`.
3. Compute `p[c] = sigmoid(logits[c] / temperature)`.
4. Route to the first model in `route_order` with `p >= threshold`, or to `fallback_model` if none qualifies or `threshold` is `null`.

```python
# loader: router_bundle
import torch
from safetensors.torch import load_file


class Router:
    def __init__(self, bundle_dir, dtype=torch.bfloat16):
        bundle_dir = Path(bundle_dir)
        self.config = json.loads((bundle_dir / "router_config.json").read_text())
        self.tokenizer, self.backbone = load_backbone(bundle_dir, self.config, dtype)
        head = load_file(str(bundle_dir / self.config["head_file"]))
        self.weight, self.bias = head["weight"].double(), head["bias"].double()

    def probabilities(self, messages):
        """Calibrated probability of a good answer, per candidate."""
        h = pooled_state(self.tokenizer, self.backbone, self.config, messages).double()
        probs = torch.sigmoid((self.weight @ h + self.bias) / self.config["temperature"])
        return dict(zip(self.config["candidates"], probs.tolist()))

    def route(self, messages):
        threshold = self.config["threshold"]
        if threshold is not None:
            probs = self.probabilities(messages)
            for model in self.config["route_order"]:
                if probs[model] >= threshold:
                    return model
        return self.config["fallback_model"]
```

## `decision_bundle`

A decision model answers a fixed set of questions about a state, with one head per question on the shared backbone.

| File | Contents |
| --- | --- |
| `decision_config.json` | Runtime config ([`decision_bundle.schema.json`](../spec/artifacts/decision_bundle.schema.json)). |
| `decision_head.safetensors` | The heads (all F32), named by question (see below). |
| `adapter_config.json`, `adapter_model.safetensors` | Only when `adapter.kind` is `"lora"`. |

`questions` maps each question name (no `.` allowed) to `{"type", "options"}`. The head tensors depend on the type. `n` is the number of options, `H` is `hidden_size` and `T` is `temperatures[name]`.

| `type` | `options` | Tensors | Output |
| --- | --- | --- | --- |
| `choice` | at least 2 labels | `{name}.weight [n, H]`, `{name}.bias [n]` | `softmax((W h + b) / T)` over `options`. The answer is the most likely option. |
| `noul` | `[]` | `{name}.weight [1, H]`, `{name}.bias [1]` | `p = sigmoid((W h + b) / T)`, the probability of yes. The answer is `p >= 0.5`. |
| `score` | at least 2 ordered levels, lowest first | `{name}.score.weight [1, H]`, `{name}.thresholds [n-1]` (no bias) | An ordinal head. `P(y > k) = sigmoid((w·h + thresholds[k]) / T)`. `P(y = k) = max(0, P(y > k-1) - P(y > k))`, with `P(y > -1) = 1` and `P(y > n-1) = 0`, renormalized to sum to 1. The answer is the most likely level. |

The other fields are `temperatures` (one per question, fitted on a held-out fold), `calibrated` (`false` when they were not fitted), and the backbone fields. `losses` and `input_format` are informational.

Input: the decision model reads a state as one user message. A string state is used as is. Any other state is JSON with sorted keys: `json.dumps(state, sort_keys=True, ensure_ascii=False)`, with the default separators `", "` and `": "`. A chat transcript (`messages`) is used as is, with trailing assistant turns dropped. The prompt is rendered as described in [Router and decision backbones](#router-and-decision-backbones).

```python
# loader: decision_bundle
import torch
from safetensors.torch import load_file


class DecisionModel:
    def __init__(self, bundle_dir, dtype=torch.bfloat16):
        bundle_dir = Path(bundle_dir)
        self.config = json.loads((bundle_dir / "decision_config.json").read_text())
        self.tokenizer, self.backbone = load_backbone(bundle_dir, self.config, dtype)
        self.heads = {k: v.double() for k, v in load_file(str(bundle_dir / self.config["head_file"])).items()}

    @staticmethod
    def state_messages(state):
        text = state if isinstance(state, str) else json.dumps(state, sort_keys=True, ensure_ascii=False)
        return [{"role": "user", "content": text}]

    def probabilities(self, messages):
        """Per question: the probability of each option (choice, score), or [P(yes)] (noul)."""
        h = pooled_state(self.tokenizer, self.backbone, self.config, messages).double()
        out = {}
        for name, question in self.config["questions"].items():
            t = self.config["temperatures"][name]
            if question["type"] == "score":
                above = torch.sigmoid((self.heads[f"{name}.score.weight"] @ h + self.heads[f"{name}.thresholds"]) / t)
                cumulative = torch.cat([torch.ones(1, dtype=above.dtype), above, torch.zeros(1, dtype=above.dtype)])
                probs = (cumulative[:-1] - cumulative[1:]).clamp(min=0)
                probs = probs / probs.sum()
            else:
                z = (self.heads[f"{name}.weight"] @ h + self.heads[f"{name}.bias"]) / t
                probs = torch.sigmoid(z) if question["type"] == "noul" else torch.softmax(z, dim=0)
            out[name] = probs.tolist()
        return out

    def answers(self, messages):
        out = {}
        for name, probs in self.probabilities(messages).items():
            question = self.config["questions"][name]
            if question["type"] == "noul":
                out[name] = probs[0] >= 0.5
            else:
                out[name] = question["options"][max(range(len(probs)), key=probs.__getitem__)]
        return out
```

## `reference` (test only)

The trainer's stdlib test backend (`GRAD_TRAINER_BACKEND=reference`) writes `reference_model.json`: a bag-of-words logistic model that does not touch the base model. Its manifest has `deployable: false` and `base_model_repo: null`. Serving must refuse it.
