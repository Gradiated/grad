"""A tiny OpenAI-compatible inference service for ``grad local up --dev-models`` (CPU, try-it-out only).

It serves ``POST /v1/chat/completions`` to the eval worker under the names grad's evals use
(docs/SELF_HOSTING.md, "Eval workers"):

- the dev models (``test/tiny-qwen3``, ``test/tiny-qwen3-teacher``) by catalog id;
- artifacts trained on them (``peft_lora`` and ``merged_safetensors``) by artifact id
  (``name@version``), downloaded from grad-server with ``GRADIATED_API_KEY`` and checked
  against the call's ``X-Grad-Workspace``;
- ``test/tiny-judge``: a deterministic judge that replies ``{"score": x}``, the word-overlap F1
  of the judged response with the reference answer (1 for any non-empty response when there is
  no reference). It reads nothing else: a pipeline check, not a quality signal.

The models are random tiny weights, so their answers are noise. Models load on first use (an
LRU of ``GRAD_DEV_INFERENCE_CACHE`` entries, default 4) and generate one request at a time.
Completions stop after ``GRAD_DEV_INFERENCE_MAX_TOKENS`` (default 64) new tokens; the prompt
keeps its last tokens that fit the models' 512-token context.
"""

from __future__ import annotations

import json
import os
import re
import tempfile
import threading
import time
import urllib.parse
import uuid
from collections import OrderedDict
from dataclasses import dataclass
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable

from . import dev_models, logs
from .bundles import _sha256_file, extract_bundle
from .errors import TrainerError
from .templates import message_text

JUDGE_ID = "test/tiny-judge"
#: Dev models that generate text (test/tiny-bert is an encoder).
CHAT_MODELS = tuple(m for m in dev_models.DEV_MODELS if m != dev_models.BERT_ID)
SERVABLE_FORMATS = ("peft_lora", "merged_safetensors")
CONTEXT_TOKENS = 512
WORKSPACE_HEADER = "X-Grad-Workspace"
_WORDS = re.compile(r"\w+")


class InferenceRequestError(Exception):
    """A request the service refuses: an OpenAI-style error with an HTTP status."""

    def __init__(self, status: int, code: str, message: str) -> None:
        super().__init__(message)
        self.status = status
        self.code = code


# --- the judge -------------------------------------------------------------------


def _judged(prompt: str) -> tuple[str, str] | None:
    """(response, reference) from grad's judge prompt: ``...Response:\n<r>\n\nReference answer:\n<ref>``."""
    start, ref = prompt.find("Response:\n"), prompt.rfind("\n\nReference answer:\n")
    if start < 0 or ref < start:
        return None
    return prompt[start + len("Response:\n") : ref], prompt[ref + len("\n\nReference answer:\n") :].strip()


def judge_score(messages: list[dict[str, Any]]) -> float:
    """Word-overlap F1 of the judge prompt's ``Response`` with its ``Reference answer``."""
    prompt = next((message_text(m.get("content")) for m in reversed(messages) if m.get("role") == "user"), "")
    judged = _judged(prompt)
    if judged is None:
        raise InferenceRequestError(
            400, "invalid_request", f"{JUDGE_ID} judges grad's judge prompts: the last user message has no 'Response:' and 'Reference answer:' sections."
        )
    response, reference = judged
    got = [w.lower() for w in _WORDS.findall(response)]
    if not reference or reference == "(none)":
        return 1.0 if got else 0.0
    want = [w.lower() for w in _WORDS.findall(reference)]
    common = sum(min(got.count(w), want.count(w)) for w in set(got))
    if not common:
        return 0.0
    precision, recall = common / len(got), common / len(want)
    return round(2 * precision * recall / (precision + recall), 4)


# --- models ----------------------------------------------------------------------


@dataclass
class LoadedModel:
    model: Any
    tokenizer: Any


def _load_base(model_id: str) -> tuple[Any, Any]:
    from transformers import AutoModelForCausalLM, AutoTokenizer

    from .models import resolve_model

    path = resolve_model(model_id).path
    tokenizer = AutoTokenizer.from_pretrained(str(path))
    return AutoModelForCausalLM.from_pretrained(str(path)), tokenizer


def _need_chat_model(model_id: str, what: str) -> None:
    if model_id.strip().lower() not in CHAT_MODELS:
        raise InferenceRequestError(
            404,
            "model_not_found",
            f"{what} is not served here: the dev inference service serves {', '.join(CHAT_MODELS)}, {JUDGE_ID} and "
            "LoRA or merged artifacts trained on them. For other models, point GRAD_INFERENCE_BASE_URL at your own "
            "OpenAI-compatible server (vLLM, SGLang) before `grad local up`.",
        )


class ModelStore:
    """Loads dev models and artifacts on first use and keeps the most recent few."""

    def __init__(self, fetch_json: Callable[[str], dict[str, Any]], download: Callable[[str, Path], None], capacity: int = 4) -> None:
        self.fetch_json = fetch_json
        self.download = download
        self.capacity = max(1, capacity)
        self._cache: OrderedDict[tuple[str, str], LoadedModel] = OrderedDict()

    def get(self, model_id: str, workspace: str | None) -> LoadedModel:
        """Callers hold the service lock: loading and generating are serialised."""
        # Artifact ids are unique per workspace only; catalog ids are lowercase.
        ref = model_id.strip()
        key = (workspace or "", ref) if "@" in ref else ("", ref.lower())
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        loaded = self._load_artifact(ref, workspace) if "@" in ref else self._load_dev_model(key[1])
        self._cache[key] = loaded
        while len(self._cache) > self.capacity:
            self._cache.popitem(last=False)
        return loaded

    def _load_dev_model(self, model_id: str) -> LoadedModel:
        _need_chat_model(model_id, f"Model '{model_id}'")
        model, tokenizer = _load_base(model_id)
        logs.log("info", "loaded dev model", model=model_id)
        return LoadedModel(model.eval(), tokenizer)

    def _load_artifact(self, ref: str, workspace: str | None) -> LoadedModel:
        path = f"/v1/artifacts/{urllib.parse.quote(ref, safe='@')}"
        artifact = self.fetch_json(path)
        if workspace and artifact.get("workspace_id") != workspace:
            raise InferenceRequestError(404, "model_not_found", f"Artifact '{ref}' is not in workspace '{workspace}'.")
        fmt, base = str(artifact.get("format")), str(artifact.get("base_model", ""))
        if fmt not in SERVABLE_FORMATS:
            raise InferenceRequestError(
                400,
                "model_not_supported",
                f"Artifact '{ref}' has format '{fmt}'; the dev inference service serves {' and '.join(SERVABLE_FORMATS)}.",
            )
        _need_chat_model(base, f"Artifact '{ref}' (base model '{base}')")
        with tempfile.TemporaryDirectory(prefix="grad-dev-inference-") as tmp:
            bundle = Path(tmp) / "artifact.grad.tar.gz"
            self.download(f"{path}/download", bundle)
            if _sha256_file(bundle) != artifact.get("sha256"):
                raise InferenceRequestError(502, "artifact_corrupt", f"Artifact '{ref}' failed its sha256 check.")
            files = Path(tmp) / "files"
            extract_bundle(bundle, files)
            model, tokenizer = _load_base(base)
            if fmt == "peft_lora":
                from peft import PeftModel

                model = PeftModel.from_pretrained(model, str(files))
            else:
                from transformers import AutoModelForCausalLM

                model = AutoModelForCausalLM.from_pretrained(str(files))
        logs.log("info", "loaded artifact", artifact=ref, format=fmt, base_model=base)
        return LoadedModel(model.eval(), tokenizer)


# --- generation ------------------------------------------------------------------


def generate(
    loaded: LoadedModel,
    messages: list[dict[str, Any]],
    *,
    tools: list[dict[str, Any]] | None,
    max_tokens: int,
    temperature: float,
    seed: int = 0,
) -> tuple[str, int, int, str]:
    """(text, prompt tokens, completion tokens, finish reason) for one chat completion."""
    import torch

    from .templates import render_chat

    rendered = render_chat(messages, tools=tools or None, add_generation_prompt=True)
    tok = loaded.tokenizer
    ids = tok.encode(rendered.text, add_special_tokens=False)[-(CONTEXT_TOKENS - max_tokens) :]
    input_ids = torch.tensor([ids], dtype=torch.long)
    sampling = {"do_sample": True, "temperature": temperature, "top_k": 0, "top_p": 1.0} if temperature > 0 else {"do_sample": False}
    torch.manual_seed(seed)
    with torch.no_grad():
        out = loaded.model.generate(
            input_ids=input_ids,
            attention_mask=torch.ones_like(input_ids),
            max_new_tokens=max_tokens,
            eos_token_id=tok.eos_token_id,
            pad_token_id=tok.pad_token_id,
            **sampling,
        )
    new = out[0, len(ids) :].tolist()
    stopped = tok.eos_token_id in new
    if stopped:
        new = new[: new.index(tok.eos_token_id)]
    return tok.decode(new, skip_special_tokens=True), len(ids), len(new) + int(stopped), "stop" if stopped else "length"


# --- HTTP ------------------------------------------------------------------------


class Service:
    def __init__(self, store: ModelStore, max_tokens: int = 64) -> None:
        self.store = store
        self.max_tokens = max(1, min(max_tokens, CONTEXT_TOKENS // 2))
        self.lock = threading.Lock()

    def chat(self, body: dict[str, Any], workspace: str | None) -> dict[str, Any]:
        model_id, messages = body.get("model"), body.get("messages")
        if not isinstance(model_id, str) or not model_id.strip():
            raise InferenceRequestError(400, "invalid_request", "'model' is required.")
        if not isinstance(messages, list) or not messages or not all(isinstance(m, dict) for m in messages):
            raise InferenceRequestError(400, "invalid_request", "'messages' must be a non-empty list of messages.")
        if model_id.strip().lower() == JUDGE_ID:
            text = json.dumps({"score": judge_score(messages)})
            prompt_words = sum(len(message_text(m.get("content")).split()) for m in messages)
            usage, finish = (prompt_words, 1), "stop"
        else:
            requested = body.get("max_tokens") or body.get("max_completion_tokens") or self.max_tokens
            temperature = body.get("temperature")
            tools = body.get("tools") if isinstance(body.get("tools"), list) else None
            try:
                with self.lock:
                    loaded = self.store.get(model_id, workspace)
                    text, p, c, finish = generate(
                        loaded,
                        messages,
                        tools=tools,
                        max_tokens=max(1, min(int(requested), self.max_tokens)),
                        temperature=float(temperature) if isinstance(temperature, (int, float)) else 0.0,
                        seed=int(body["seed"]) if isinstance(body.get("seed"), int) else 0,
                    )
            except TrainerError as exc:  # an unrenderable conversation, a model that won't resolve
                raise InferenceRequestError(400, "invalid_request", str(exc)) from exc
            usage = (p, c)
        return {
            "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": model_id,
            "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": finish}],
            "usage": {"prompt_tokens": usage[0], "completion_tokens": usage[1], "total_tokens": usage[0] + usage[1]},
        }


def _upstream_error(exc: Exception) -> InferenceRequestError:
    """grad-server's answer to an artifact lookup, as this service's error."""
    from .worker import ServerError

    if isinstance(exc, ServerError):
        if exc.status == 404:
            return InferenceRequestError(404, "model_not_found", f"grad-server has no such artifact: {exc.detail}")
        if exc.status in (401, 403):
            return InferenceRequestError(
                403, "upstream_auth", f"grad-server refused the dev inference service's key (GRADIATED_API_KEY): {exc.detail}"
            )
        if not exc.transient:
            return InferenceRequestError(400, "invalid_request", exc.detail)
    return InferenceRequestError(503, "upstream_unavailable", f"grad-server is unavailable: {exc}")


def make_handler(service: Service) -> type[BaseHTTPRequestHandler]:
    from .worker import ServerError, ServerUnreachable

    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def _send(self, status: int, payload: dict[str, Any]) -> None:
            body = json.dumps(payload).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _error(self, err: InferenceRequestError) -> None:
            kind = "invalid_request_error" if err.status < 500 else "server_error"
            self._send(err.status, {"error": {"message": str(err), "type": kind, "code": err.code}})

        def do_GET(self) -> None:  # noqa: N802
            if self.path in ("/health", "/v1/health"):
                self._send(200, {"status": "ok"})
            elif self.path == "/v1/models":
                ids = [*CHAT_MODELS, JUDGE_ID]
                self._send(200, {"object": "list", "data": [{"id": i, "object": "model", "owned_by": "grad"} for i in ids]})
            else:
                self._error(InferenceRequestError(404, "not_found", f"No route GET {self.path}."))

        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/v1/chat/completions":
                self._error(InferenceRequestError(404, "not_found", f"No route POST {self.path}; this service serves /v1/chat/completions."))
                return
            try:
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length) or b"null")
                if not isinstance(body, dict):
                    raise InferenceRequestError(400, "invalid_request", "The body must be a JSON object.")
                if body.get("stream"):
                    raise InferenceRequestError(400, "invalid_request", "stream=true is not supported.")
                self._send(200, service.chat(body, self.headers.get(WORKSPACE_HEADER) or None))
            except InferenceRequestError as exc:
                self._error(exc)
            except ValueError as exc:
                self._error(InferenceRequestError(400, "invalid_request", f"Invalid request: {exc}"))
            except (ServerError, ServerUnreachable) as exc:
                self._error(_upstream_error(exc))
            except Exception as exc:  # pragma: no cover - logged, answered as a server error
                logs.log("error", "chat completion failed", exc=True)
                self._error(InferenceRequestError(500, "internal_error", f"{type(exc).__name__}: {exc}"))

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            pass

    return Handler


def server_from_env(env: dict[str, str] | None = None) -> ThreadingHTTPServer:
    from .worker import ProtocolClient

    env = dict(os.environ if env is None else env)
    client = ProtocolClient(env.get("GRAD_SERVER_URL", "http://127.0.0.1:8787"), env.get("GRADIATED_API_KEY") or None)
    store = ModelStore(client.get_json, client.download, capacity=int(env.get("GRAD_DEV_INFERENCE_CACHE", "4")))
    service = Service(store, max_tokens=int(env.get("GRAD_DEV_INFERENCE_MAX_TOKENS", "64")))
    host, port = env.get("GRAD_DEV_INFERENCE_HOST", "127.0.0.1"), int(env.get("GRAD_DEV_INFERENCE_PORT", "8000"))
    server = ThreadingHTTPServer((host, port), make_handler(service))
    server.daemon_threads = True
    return server


def main() -> None:  # pragma: no cover - the container entrypoint
    import signal

    logs.install()
    threads = os.environ.get("GRAD_TORCH_THREADS", "").strip()
    if threads:
        import torch

        torch.set_num_threads(int(threads))
    server = server_from_env()
    signal.signal(signal.SIGTERM, lambda *_: threading.Thread(target=server.shutdown, daemon=True).start())
    logs.log("info", "grad-dev-inference listening", address=f"{server.server_address[0]}:{server.server_address[1]}")
    server.serve_forever()


if __name__ == "__main__":  # pragma: no cover
    main()
