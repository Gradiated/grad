"""grad-dev-inference: the CPU OpenAI-compatible service of ``grad local up --dev-models`` (torch)."""

from __future__ import annotations

import json
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

from fixtures.tiny_models import build_tiny_loras, ensure_tiny_models
from helpers import QWEN_ID, TorchCase

from grad_trainer import dev_inference
from grad_trainer.bundles import bundle_directory

REPO = Path(__file__).resolve().parents[3]
KEY = "grad_local_test_key"


def judge_prompt(response: str, reference: str | None) -> list[dict[str, Any]]:
    """The layout of grad's judge prompt (server/api/src/services/evals/scoring.ts buildJudgeMessages)."""
    content = "\n\n".join(
        [
            "Criteria:\nIs it right?",
            "Conversation:\nuser: Reset my password",
            f"Response:\n{response}",
            f"Reference answer:\n{reference if reference is not None else '(none)'}",
        ]
    )
    return [{"role": "system", "content": "You are an evaluation judge."}, {"role": "user", "content": content}]


class JudgeTests(unittest.TestCase):
    def test_scores_word_overlap_with_the_reference(self) -> None:
        self.assertEqual(dev_inference.judge_score(judge_prompt("Open Settings, then Security.", "open settings then security")), 1.0)
        self.assertEqual(dev_inference.judge_score(judge_prompt("Open Settings", "Open Settings then Security")), 0.6667)
        self.assertEqual(dev_inference.judge_score(judge_prompt("bananas", "Open Settings")), 0.0)
        # The response may itself contain a "Reference answer:" section: the last one is the reference.
        tricky = "Settings\n\nReference answer:\nOpen"
        self.assertEqual(dev_inference.judge_score(judge_prompt(tricky, "Open Settings")), 0.6667)

    def test_without_a_reference_any_answer_passes(self) -> None:
        self.assertEqual(dev_inference.judge_score(judge_prompt("anything", None)), 1.0)
        self.assertEqual(dev_inference.judge_score(judge_prompt("  ", None)), 0.0)

    def test_refuses_a_prompt_that_is_not_a_judge_prompt(self) -> None:
        with self.assertRaises(dev_inference.InferenceRequestError) as ctx:
            dev_inference.judge_score([{"role": "user", "content": "hello"}])
        self.assertEqual(ctx.exception.status, 400)

    def test_matches_the_judge_prompt_the_eval_worker_sends(self) -> None:
        scoring = (REPO / "server" / "api" / "src" / "services" / "evals" / "scoring.ts").read_text()
        for line in ("`Response:\\n${", "`Reference answer:\\n${input.reference ?? \"(none)\"}`", '.join("\\n\\n")'):
            self.assertIn(line, scoring)


class FakeGradServer:
    """GET /v1/artifacts/{id} and /download, as grad-server answers them (with the bearer key)."""

    def __init__(self) -> None:
        self.artifacts: dict[str, tuple[dict[str, Any], bytes]] = {}
        self.downloads: list[str] = []
        self.status: int | None = None
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:  # noqa: N802
                if fake.status or self.headers.get("Authorization") != f"Bearer {KEY}":
                    status = fake.status or 401
                    return self._send(status, json.dumps({"code": f"http_{status}", "detail": "refused"}).encode())
                parts = urllib.parse.unquote(self.path).split("/")
                found = fake.artifacts.get(parts[3])
                if not found:
                    return self._send(404, b'{"code": "not_found", "detail": "no artifact"}')
                if len(parts) > 4 and parts[4] == "download":
                    fake.downloads.append(parts[3])
                    return self._send(200, found[1])
                self._send(200, json.dumps(found[0]).encode())

            def _send(self, status: int, body: bytes) -> None:
                self.send_response(status)
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args: Any) -> None:
                pass

        import urllib.parse

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def add(self, ref: str, directory: Path, fmt: str, *, workspace: str = "default", base: str = QWEN_ID, sha: str | None = None) -> None:
        info = bundle_directory(directory, directory.parent / f"{ref.replace('@', '-')}.grad.tar.gz", manifest={"format": fmt}, validate=False)
        meta = {"id": ref, "workspace_id": workspace, "format": fmt, "base_model": base, "sha256": sha or info.sha256}
        self.artifacts[ref] = (meta, info.path.read_bytes())

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()


class ServiceTests(TorchCase):
    @classmethod
    def setUpClass(cls) -> None:
        super().setUpClass()
        import shutil
        import tempfile

        root = Path(tempfile.mkdtemp(prefix="grad-dev-inference-"))
        cls.addClassCleanup(shutil.rmtree, root, True)
        cls.grad = FakeGradServer()
        cls.addClassCleanup(cls.grad.close)
        lora = Path(build_tiny_loras(root)["lora"])
        cls.grad.add("sft@1", lora, "peft_lora")
        cls.grad.add("other@1", lora, "peft_lora", workspace="ws_other")
        cls.grad.add("router@1", lora, "router_bundle")
        cls.grad.add("big@1", lora, "peft_lora", base="qwen/qwen3-8b")
        cls.grad.add("tampered@1", lora, "peft_lora", sha="0" * 64)
        merged = root / "merged"
        shutil.copytree(ensure_tiny_models()[QWEN_ID], merged)
        cls.grad.add("merged@1", merged, "merged_safetensors")
        env = {"GRAD_SERVER_URL": cls.grad.url, "GRADIATED_API_KEY": KEY, "GRAD_DEV_INFERENCE_PORT": "0", "GRAD_DEV_INFERENCE_CACHE": "2"}
        cls.server = dev_inference.server_from_env(env)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        cls.addClassCleanup(cls.server.server_close)
        cls.addClassCleanup(cls.server.shutdown)
        cls.url = f"http://127.0.0.1:{cls.server.server_address[1]}"

    def call(self, path: str, body: Any = None, *, workspace: str | None = "default", raw: bytes | None = None) -> tuple[int, dict[str, Any]]:
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        headers = {"Content-Type": "application/json", **({dev_inference.WORKSPACE_HEADER: workspace} if workspace else {})}
        req = urllib.request.Request(self.url + path, data=data, headers=headers, method="POST" if data is not None else "GET")
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return resp.status, json.loads(resp.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def chat(self, model: str, **kwargs: Any) -> tuple[int, dict[str, Any]]:
        workspace = kwargs.pop("workspace", "default")
        body = {"model": model, "messages": [{"role": "user", "content": "Reset my password"}], "temperature": 0, "max_tokens": 1024, **kwargs}
        return self.call("/v1/chat/completions", body, workspace=workspace)

    def test_serves_the_dev_model_deterministically_at_temperature_zero(self) -> None:
        status, out = self.chat(QWEN_ID)
        self.assertEqual(status, 200, out)
        self.assertEqual(out["object"], "chat.completion")
        self.assertEqual(out["model"], QWEN_ID)
        choice = out["choices"][0]
        self.assertEqual(choice["message"]["role"], "assistant")
        self.assertIn(choice["finish_reason"], ("stop", "length"))
        usage = out["usage"]
        self.assertGreater(usage["prompt_tokens"], 0)
        self.assertLessEqual(usage["completion_tokens"], 64)  # GRAD_DEV_INFERENCE_MAX_TOKENS caps max_tokens=1024
        self.assertEqual(usage["total_tokens"], usage["prompt_tokens"] + usage["completion_tokens"])
        self.assertEqual(self.chat(QWEN_ID.upper())[1]["choices"][0]["message"], choice["message"])

    def test_samples_at_a_temperature_and_keeps_a_long_prompt_within_the_context(self) -> None:
        long = [{"role": "user", "content": "Open Settings and choose Reset Password. " * 200}]
        status, out = self.call("/v1/chat/completions", {"model": QWEN_ID, "messages": long, "temperature": 0.8, "seed": 3, "max_tokens": 8})
        self.assertEqual(status, 200, out)
        self.assertLessEqual(out["usage"]["prompt_tokens"], dev_inference.CONTEXT_TOKENS - 8)
        self.assertLessEqual(out["usage"]["completion_tokens"], 8)

    def test_serves_tools_conversations(self) -> None:
        tools = [{"type": "function", "function": {"name": "lookup", "parameters": {"type": "object"}}}]
        status, out = self.chat(QWEN_ID, tools=tools, max_tokens=4)
        self.assertEqual(status, 200, out)

    def test_serves_a_lora_artifact_by_id_and_downloads_it_once(self) -> None:
        before = self.grad.downloads.count("sft@1")
        for _ in range(2):
            status, out = self.chat("sft@1", max_tokens=4)
            self.assertEqual(status, 200, out)
            self.assertEqual(out["model"], "sft@1")
        self.assertLessEqual(self.grad.downloads.count("sft@1") - before, 1)

    def test_serves_a_merged_artifact(self) -> None:
        status, out = self.chat("merged@1", max_tokens=4)
        self.assertEqual(status, 200, out)

    def test_refuses_artifacts_it_cannot_or_must_not_serve(self) -> None:
        cases = {
            "other@1": (404, "model_not_found"),  # another workspace's artifact
            "router@1": (400, "model_not_supported"),
            "big@1": (404, "model_not_found"),  # not trained on a dev model
            "missing@1": (404, "model_not_found"),
            "tampered@1": (502, "artifact_corrupt"),
            "qwen/qwen3-8b": (404, "model_not_found"),
            "test/tiny-bert": (404, "model_not_found"),
        }
        for model, (status, code) in cases.items():
            got, out = self.chat(model, max_tokens=2)
            self.assertEqual((got, out["error"]["code"]), (status, code), model)
        self.assertIn("GRAD_INFERENCE_BASE_URL", self.chat("qwen/qwen3-8b")[1]["error"]["message"])

    def test_grad_server_refusals_and_outages(self) -> None:
        for upstream, (status, code) in {401: (403, "upstream_auth"), 422: (400, "invalid_request"), 503: (503, "upstream_unavailable")}.items():
            self.grad.status = upstream
            try:
                got, out = self.chat(f"fresh{upstream}@1", max_tokens=2)
            finally:
                self.grad.status = None
            self.assertEqual((got, out["error"]["code"]), (status, code), upstream)

    def test_judge_replies_with_a_parseable_score(self) -> None:
        body = {"model": dev_inference.JUDGE_ID, "messages": judge_prompt("Open Settings", "Open Settings"), "temperature": 0}
        status, out = self.call("/v1/chat/completions", body)
        self.assertEqual(status, 200, out)
        self.assertEqual(json.loads(out["choices"][0]["message"]["content"]), {"score": 1.0})
        self.assertGreater(out["usage"]["prompt_tokens"], 0)

    def test_routes_and_bad_requests(self) -> None:
        self.assertEqual(self.call("/health"), (200, {"status": "ok"}))
        status, models = self.call("/v1/models")
        self.assertEqual(status, 200)
        self.assertEqual([m["id"] for m in models["data"]], [QWEN_ID, "test/tiny-qwen3-teacher", dev_inference.JUDGE_ID])
        self.assertEqual(self.call("/nope")[0], 404)
        self.assertEqual(self.call("/v1/completions", {"model": QWEN_ID, "prompt": "hi"})[0], 404)
        bad = [
            {"messages": [{"role": "user", "content": "x"}]},
            {"model": QWEN_ID, "messages": []},
            {"model": QWEN_ID, "messages": ["x"]},
            {"model": QWEN_ID, "messages": [{"role": "user", "content": "x"}], "stream": True},
            {"model": QWEN_ID, "messages": [{"role": "robot", "content": "x"}]},
            {"model": QWEN_ID, "messages": [{"role": "user", "content": "x"}], "max_tokens": "many"},
            [1, 2],
        ]
        for body in bad:
            status, out = self.call("/v1/chat/completions", body)
            self.assertEqual(status, 400, body)
            self.assertEqual(out["error"]["type"], "invalid_request_error")
        self.assertEqual(self.call("/v1/chat/completions", raw=b"{not json")[0], 400)


if __name__ == "__main__":
    unittest.main()
