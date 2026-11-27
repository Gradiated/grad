#!/usr/bin/env python3
"""Run the Python and CLI code blocks of the v0 training docs against a live local stack.

    python3 scripts/check-docs-snippets.py --docs ../workspace/product/website/src/docs/training
    python3 scripts/check-docs-snippets.py --docs DOCS --cloud      # deploy/route/embed blocks
    python3 scripts/check-docs-snippets.py --docs DOCS --list       # show blocks, run nothing
    python3 scripts/check-docs-snippets.py --docs DOCS --offline    # skip the Hugging Face blocks

It starts tests/harness/stack.ts (reference worker; with --cloud the fake Cloud API and
the torch worker, since reference artifacts can't be deployed), extracts every ```python
and ```bash block from the v0 pages, and runs each one in a scratch directory with
GRADIATED_BASE_URL/GRADIATED_API_KEY pointing at the stack. Placeholders are filled from
the fixture maps below (files, seed datasets and artifacts, model and host rewrites).
Blocks that can't run self-contained are listed in SKIP with a reason. Hugging Face
imports run online (with a small `limit` injected) unless --offline. Blocks that load a
downloaded artifact with torch run in --cloud mode under GRAD_TRAINER_PYTHON. Stdlib + the
Python SDK only (PYTHONPATH=sdks/python is set for the blocks; the SDK needs httpx).
"""

from __future__ import annotations

import argparse
import json
import os
import re
import select
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
API_DIR = REPO / "server" / "api"
sys.path.insert(0, str(REPO / "sdks" / "python"))

# Pages describing Wave 2 features: not run.
WAVE2 = {
    "environments.mdx", "custom-loops.mdx", "advanced-objectives.mdx", "recipes/rl-agents.mdx",
    "recipes/traces-to-environments.mdx",
}

CLOUD_SERVING = "Gradiated Cloud serving (coming soon); grad-server never deploys"

# (page, text in the block, reason). The first match wins.
SKIP = [
    ("", "git clone", "clones the repository"),
    ("", "pip install", "installs a package"),
    ("", "npm install", "installs a package"),
    ("", "go get ", "installs a package"),
    ("", "cargo add", "installs a package"),
    ("", "cargo install", "installs the CLI"),
    ("", "localhost:8000", "calls the artifact served on your own vLLM"),
    ("", "from openai import", "needs the openai package and the Gradiated inference gateway"),
    ("", "/v1/chat/completions", "Gradiated inference gateway, not grad-server"),
    ("", "/v1/systemone", "Gradiated inference gateway, not grad-server"),
    ("", "typesafe_sdk", "needs the SystemOne SDK and the Gradiated inference gateway"),
    ("", ".deploy(", CLOUD_SERVING),
    ("", "grad deploy", CLOUD_SERVING),
    ("", "grad deployments", CLOUD_SERVING),
    ("", "deployments.", CLOUD_SERVING),
    ("", "from router_bundle import", "needs the reference loader saved from the artifact format spec"),
    ("", "from sentence_transformers import", "needs sentence-transformers"),
    ("", "vllm serve", "needs a GPU and vLLM"),
    ("", "sglang.launch_server", "needs a GPU and SGLang"),
    ("", "grad local up", "starts Docker Compose (the harness is already a local stack)"),
    ("", "helm upgrade", "needs a Kubernetes cluster"),
    ("", "kubectl ", "needs a Kubernetes cluster"),
    ("", "langfuse.create_score", "Langfuse SDK and account"),
    ("", "from langfuse", "Langfuse SDK and account"),
    ("", "/api/public/scores", "Langfuse API and account"),
    ("", "from langsmith", "LangSmith SDK and account"),
    ("", "from phoenix", "Phoenix SDK and server"),
    ("", "opentelemetry", "Phoenix SDK and server"),
    ("", "from posthog", "PostHog SDK and project"),
    ("", "posthog.capture", "PostHog SDK and project"),
    ("self-hosting.mdx", "grad --profile local ui", "opens a browser on the `grad local up` profile (cli/tests/cli.rs covers grad ui)"),
]
# Hugging Face downloads: run online (the default), skipped with --offline.
HF = ("from_hf(", "import hf ", "from_benchmark(", "import benchmark ")
HF_LIMIT = 40
ONLINE_LIMITS = f"""
import grad._resources as _gr
for _m in ("from_hf", "from_benchmark"):
    def _limited(self, *a, _orig=getattr(_gr.Datasets, _m), **k):
        if k.get("limit") is None:
            k["limit"] = {HF_LIMIT}
        return _orig(self, *a, **k)
    setattr(_gr.Datasets, _m, _limited)
"""
# Blocks that load a downloaded artifact with torch: they run under the trainer's Python
# (GRAD_TRAINER_PYTHON) in --cloud mode, after the prelude binds the names they use.
TORCH = {
    ("recipes/reward-models.mdx", "from peft import"): (
        "sql-verifier", 'run = next(r for r in client.runs.list().data if r.name == "sql-verifier" and r.status == "completed")\n'),
}

# Blocks that need hosted serving (deploy, route, embeddings) or a real adapter (continued training,
# evaluating an artifact; reference-worker artifacts can't be served): only run with --cloud.
CLOUD = re.compile(
    r"\.deploy\(|grad deploy|grad route|grad embed|client\.route\(|deployments\.|embeddings\.create|grad deployments"
    r"|model=\w+\.artifact|model=sft_art|--model [\w-]+@|models=\[[^\]]*@|--models \S*@"
    r"|sources add gradiated|sources\.Gradiated"
    r"|\.download\("  # the SDKs check that a download is a servable adapter, which reference artifacts aren't
)

MODELS = {"{{SONNET_MODEL}}": "anthropic/claude-sonnet-5-5", "{{OPUS_MODEL}}": "anthropic/claude-opus-5-5", "{{GPT_MODEL}}": "openai/gpt-6.1-sol"}
# --cloud trains real (tiny) adapters with the torch worker, so catalog models map to the harness's tiny ones.
TINY = {"baai/bge-small-en-v1.5": "test/tiny-bert", "gradiated/linden-1": "test/tiny-qwen3"}
# ... including the recipes' default models, for blocks that don't pass `model=`.
TINY_DEFAULTS = """
import grad.recipes as _r
for _name, _model in {"SFTRecipe": "test/tiny-qwen3", "DPORecipe": "test/tiny-qwen3", "RouterRecipe": "test/tiny-qwen3",
                      "DecisionModelRecipe": "test/tiny-qwen3", "CartridgeRecipe": "test/tiny-qwen3", "EmbeddingRecipe": "test/tiny-bert",
                      "DistillRecipe": "test/tiny-qwen3", "RewardModelRecipe": "test/tiny-qwen3"}.items():
    _cls = getattr(_r, _name)
    def _init(self, *a, _orig=_cls.__init__, _model=_model, **k):
        _orig(self, *a, **k)
        if self.model is None:
            self.model = _model
    _cls.__init__ = _init
"""
HOSTS = ("https://api.gradiated.com", "https://grad.internal.example")
# The server's default secret hosts, plus the fake Langfuse (a secret only goes to its allowed hosts).
PUBLIC_SECRET_HOSTS = ["cloud.langfuse.com", "us.cloud.langfuse.com", "api.smith.langchain.com", "api.braintrust.dev", "us.posthog.com",
                       "eu.posthog.com", "app.phoenix.arize.com", "huggingface.co", "api.wandb.ai"]

CHAT = [
    {"session_id": f"s{i}", "messages": [{"role": "user", "content": f"Count active users from day {i}."},
                                         {"role": "assistant", "content": f"SELECT count(*) FROM users WHERE day = {i};"}],
     "scores": {"resolved": 1.0 if i % 3 else 0.5, "tests_passed": 1.0 if i % 3 else 0.0}}
    for i in range(24)
]
ROUTER = [
    {"session_id": f"s{i}", "messages": [{"role": "user", "content": f"{'hard SQL join' if i % 2 else 'say hello'} {i}"}],
     "scores": {"qwen/qwen3-8b": 0.0 if i % 2 else 1.0, "qwen/qwen3-32b": 1.0}, "metrics": {"cost_usd": 0.001}}
    for i in range(40)
]
DPO = [{"prompt": f"Fix ticket {i}", "chosen": f"Sure, ticket {i} is fixed.", "rejected": "No."} for i in range(24)]
_Q = {"category": {"type": "choice", "instructions": "Choose the department.", "criteria": {"billing": "Charges", "other": "Else"}},
      "urgent": {"type": "noul", "instructions": "Is it urgent?"}}
DECISION = [{"state": {"ticket": f"ticket {i}"}, "questions": _Q, "expected_output": {"category": "billing" if i % 2 else "other", "urgent": float(i % 2)}}
            for i in range(24)]
TRIPLETS = [{"query": f"how do I do thing {i}?", "positive": f"Do thing {i} in Settings.", "negatives": [f"Thing {i + 1} is elsewhere."]} for i in range(24)]
OTEL = [
    {"trace_id": f"t{i}", "attributes": {"gen_ai.request.model": "qwen/qwen3-8b", "gen_ai.prompt.0.role": "user", "gen_ai.prompt.0.content": f"Where is invoice {i}?",
                                        "gen_ai.completion.0.role": "assistant", "gen_ai.completion.0.content": f"Invoice {i} is in Billing."}}
    for i in range(12)
]
PROMPTS = [{"messages": [{"role": "user", "content": f"What does endpoint {i} return?"}]} for i in range(12)]

def _jsonl(rows: list[dict]) -> str:
    return "".join(json.dumps(r) + "\n" for r in rows)

# Files the blocks read, created in the scratch directory.
FILES = {
    "support_traces.jsonl": _jsonl(ROUTER), "train.jsonl": _jsonl(CHAT), "traces.jsonl": _jsonl(ROUTER),
    "api-docs-bundle.md": "# API docs\n\nGET /v1/users returns the users.\n" * 20,
    "context.md": "# Context\n\nThe refund window is 30 days.\n" * 20,
    # Writing Parquet needs pyarrow, so `traces.parquet` is rewritten to the same OTel rows as JSONL.
    "traces.otel.jsonl": _jsonl(OTEL),
}
ALIASES = {"traces.parquet": "traces.otel.jsonl", "grad_...": "$GRADIATED_API_KEY"}

# Seed datasets (created on first use when a block reads them).
DATASETS = {
    **{n: CHAT for n in ("support-sft", "support-gold", "diff-merge-prod", "diff-merge-gold", "diff-merge-clean", "my-sft",
                         "sql-eval-holdout", "sql-staging-sample", "sql-sft", "eval", "clean")},
    **{n: ROUTER for n in ("support-prod", "support-traces")},
    **{n: DPO for n in ("support-preferences", "diff-merge-preferences", "prefs", "sql-preferences")},
    "ticket-triage": DECISION, "docs-retrieval-triplets": TRIPLETS, "api-docs-qa-prompts": PROMPTS, "api-docs-corpus": PROMPTS,
    "support-prompts": PROMPTS,
}
# Seed artifacts: name -> (recipe, dataset), trained on first use.
ARTIFACTS = {
    "fast-diff-merge": ("sft", "diff-merge-gold"), "sql-agent": ("sft", "sql-eval-holdout"),
    "support-responder-sft": ("sft", "support-gold"), "support-router": ("router", "support-prod"),
    "ticket-triage": ("decision-model", "ticket-triage"), "docs-embedder": ("embedding", "docs-retrieval-triplets"),
    "api-docs-cartridge": ("cartridge", "api-docs-qa-prompts"), "support-4b-distilled": ("distill", "support-prompts"),
    "sql-verifier": ("reward", "sql-preferences"), "support-sft": ("sft", "support-sft"),
}
DATASET_REFS = re.compile(r"""datasets\.get\(["']([a-z0-9._-]+)|\bdataset=["']([a-z0-9._-]+)|EvalSpec\(["']([a-z0-9._-]+)|--dataset[ =]([a-z0-9._-]+)|^\s*dataset: ([a-z0-9._-]+)|grad render ([a-z0-9._-]+)|/v1/datasets/([a-z0-9._-]+)/""", re.M)
ARTIFACT_REFS = re.compile(r"\b([a-z0-9][a-z0-9-]*)@(?:latest|20\d\d-\d\d-\d\d-\d+)")
DATED_REFS = re.compile(r"\b([a-z0-9][a-z0-9-]*)@(20\d\d-\d\d-\d\d-\d+)")
RUN_IDS = re.compile(r"\brun_01[0-9A-Z]+\b")
RUN_NAMES = re.compile(r"\bgrad runs (?:logs|wait|inspect|checkpoints) ([a-z][a-z0-9-]+)")
KEY_IDS = re.compile(r"\bkey_[0-9a-f]{16,}\b")
# Sources: every provider key is the harness's fake Langfuse key, every Langfuse host the fake Langfuse,
# and the docs' placeholder source id a source seeded on first use.
SECRET_REFS = re.compile(r"""secrets\.get\(["']([a-z0-9._-]+)|--secret[ =]([a-z0-9._-]+)""")
SOURCE_IDS = re.compile(r"\bsrc_01[0-9A-Z]+\b")
LANGFUSE_HOSTS = ("https://us.cloud.langfuse.com", "https://cloud.langfuse.com")
# Integration pages filter a dataset a source synced: support-prod also gets these traces
# through a real sync from the fake Langfuse (scored, tagged with a version).
SYNCED_TRACES = [
    {"id": f"docs-tr-{i}", "timestamp": "2026-11-01T00:00:00Z", "input": f"Where is invoice {i}?", "output": f"Invoice {i} is in Billing.",
     "sessionId": f"docs-s{i}", "version": "v42" if i % 2 else "v41"}
    for i in range(8)
]
SYNCED_SCORES = [
    {"id": f"docs-sc-{i}", "traceId": f"docs-tr-{i}", "name": "resolved", "dataType": "NUMERIC", "value": 1.0 if i % 4 else 0.0,
     "timestamp": "2026-11-01T00:01:00Z"}
    for i in range(8)
]


def blocks(docs: Path) -> list[dict]:
    """Every python/bash block of the v0 pages, in page order."""
    out = []
    for path in sorted(docs.rglob("*.mdx")):
        page = path.relative_to(docs).as_posix()
        if page in WAVE2:
            continue
        lines = path.read_text().split("\n")
        i = 0
        while i < len(lines):
            m = re.match(r"^```(python|bash|sh|shell|yaml)\s*$", lines[i])
            if m:
                j = next(k for k in range(i + 1, len(lines)) if lines[k].startswith("```"))
                code = "\n".join(lines[i + 1 : j]) + "\n"
                if m.group(1) == "yaml":  # a `# name.yaml` block is a file the next blocks read
                    name = re.match(r"# ([\w.-]+\.ya?ml)\n", code)
                    if name:
                        out.append({"page": page, "line": i + 1, "lang": "file", "name": name.group(1), "code": code})
                    if page == "self-hosting.mdx":  # Helm values: rendered against the chart
                        out.append({"page": page, "line": i + 1, "lang": "helm", "code": code, "torch": None, "hf": False, "cloud": False,
                                    "skip": None if shutil.which("helm") else "needs helm"})
                    i = j + 1
                    continue
                lang = "python" if m.group(1) == "python" else "bash"
                skip = next((r for p, text, r in SKIP if page.startswith(p) and text in code), None)
                torch = next((v for (p, text), v in TORCH.items() if page.startswith(p) and text in code), None)
                out.append({"page": page, "line": i + 1, "lang": lang, "code": code, "skip": skip, "torch": torch,
                            "hf": any(t in code for t in HF), "cloud": bool(torch) or bool(CLOUD.search(code))})
                i = j
            i += 1
    return out


class Stack:
    """tests/harness/stack.ts, stopped by closing its stdin."""

    def __init__(self, cloud: bool, worker: str, log: Path, online: bool = True) -> None:
        args = [str(API_DIR / "node_modules" / ".bin" / "tsx"), "../../tests/harness/stack.ts", "--worker", worker]
        args += (["--cloud"] if cloud else []) + (["--online"] if online else [])
        self.log = open(log, "wb")
        self.proc = subprocess.Popen(args, cwd=API_DIR, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=self.log)
        buf, deadline = b"", time.monotonic() + 300
        while b"\n" not in buf:
            if self.proc.poll() is not None or time.monotonic() > deadline:
                raise SystemExit(f"stack did not start; see {log}")
            if select.select([self.proc.stdout], [], [], 0.5)[0]:
                buf += os.read(self.proc.stdout.fileno(), 65536)
        self.info = json.loads(buf.split(b"\n", 1)[0])

    def close(self) -> None:
        self.proc.stdin.close()
        try:
            self.proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            self.proc.kill()
        self.log.close()


class Runner:
    def __init__(self, base_url: str, api_key: str, cloud: bool, grad_bin: str, work: Path, timeout: int, info: dict | None = None) -> None:
        from grad import Grad

        self.client = Grad(api_key=api_key, base_url=base_url)
        self.langfuse_url = (info or {}).get("langfuse_url")
        self.provider_key = (info or {}).get("langfuse_secret") or "pk-lf-docs:sk-lf-docs"
        self.source_id: str | None = None
        self.base_url, self.cloud, self.work, self.timeout = base_url, cloud, work, timeout
        self.run_id: str | None = None
        bindir = str(Path(grad_bin).resolve().parent)
        self.env = {
            **os.environ, "GRADIATED_BASE_URL": base_url, "GRADIATED_API_KEY": api_key, "XDG_CONFIG_HOME": str(work / ".config"),
            "PYTHONPATH": str(REPO / "sdks" / "python"), "MY_ADMIN_KEY": api_key, "PATH": f"{bindir}{os.pathsep}{os.environ['PATH']}",
        }
        for name, text in FILES.items():
            (work / name).write_text(text)
        # The `local` profile `grad local up` writes, for blocks that `export GRADIATED_PROFILE=local`.
        config = work / ".config" / "gradiated" / "config.json"
        config.parent.mkdir(parents=True, exist_ok=True)
        config.write_text(json.dumps({"profiles": {"local": {"base_url": base_url, "api_key": api_key}}}))
        config.chmod(0o600)
        self.synced: set[str] = set()
        self.helm_base: str | None = None

    def model(self, model: str) -> str:
        if not self.cloud:
            return model
        return TINY.get(model, "test/tiny-qwen3" if model.startswith("qwen/") else model)

    def rewrite(self, code: str, n: int) -> str:
        for k, v in MODELS.items():
            code = code.replace(k, v)
        for host in HOSTS:
            code = code.replace(host, self.base_url)
        for k, v in ALIASES.items():
            code = code.replace(k, v)
        if self.langfuse_url:
            for host in LANGFUSE_HOSTS:
                code = code.replace(host, self.langfuse_url)
            # Secrets go only to their allowed hosts: the fake Langfuse is one.
            hosts = "".join(f" --allowed-host {h}" for h in [self.langfuse_url, *PUBLIC_SECRET_HOSTS])
            code = re.sub(r"(grad secrets set [a-z0-9._-]+)", lambda m: m.group(1) + hosts, code)
        if self.source_id:
            code = SOURCE_IDS.sub(self.source_id, code)
        for name in {m[0] for m in DATED_REFS.findall(code)}:  # the k-th oldest dated ref -> the k-th oldest seed version
            dated = sorted({v for nm, v in DATED_REFS.findall(code) if nm == name})
            refs = self.versions(name) if name in ARTIFACTS else []
            for v, ref in zip(dated, refs):
                code = re.sub(rf"\b{re.escape(name)}@{v}\b", ref, code)
        code = re.sub(r"(@)20\d\d-\d\d-\d\d-\d+", r"\1latest", code)
        if self.run_id:
            code = RUN_IDS.sub(self.run_id, code)
        if KEY_IDS.search(code):  # a placeholder key id: revoke a fresh key instead
            code = KEY_IDS.sub(self.client.keys.create(name=f"docs-key-{n}", scopes=["artifacts:read"]).key.id, code)
        if self.cloud:  # the model a recipe trains becomes a tiny one; router/eval candidates stay catalog models
            code = re.sub(r"""((?:\bmodel=|\bmodel: |--model )["']?)(qwen/qwen3-[0-9.]+b|baai/bge-small-en-v1\.5|gradiated/linden-1)""",
                          lambda m: m.group(1) + self.model(m.group(2)), code)
            code = re.sub(r"""((?:\bteacher=|\bteacher: )["']?)qwen/qwen3-[0-9.]+b""", r"\1test/tiny-qwen3-teacher", code)
            code = re.sub(r"^(grad train (?!.*(?:--model|-f )).*?)( --wait| --dry-run|$)",
                          lambda m: f"{m.group(1)} --model {'test/tiny-bert' if '--recipe embedding' in m.group(1) else 'test/tiny-qwen3'}{m.group(2)}",
                          code, flags=re.M)
        if "--limit" not in code:  # Hugging Face imports read only the first rows
            code = re.sub(r"\bgrad datasets import (hf|benchmark) ", rf"grad datasets import \1 --limit {HF_LIMIT} ", code)
        # A block that creates a dataset (or saves a filtered view) gets a fresh name so it never collides with an earlier block.
        views = re.findall(r"""\bname=["']([a-z0-9._-]+)["']""", code) if ".filter(" in code else []
        for name in set(re.findall(r"""datasets\.create\(["']([a-z0-9._-]+)""", code)) | set(views):
            code = re.sub(rf"(?<![\w-]){re.escape(name)}(?![\w-])", f"{name}-b{n}", code)
        return code

    def dataset(self, name: str) -> None:
        from grad import NotFoundError

        try:
            self.client.datasets.get(name)
        except NotFoundError:
            if name in DATASETS:
                self.client.datasets.push(name, DATASETS[name])

    def versions(self, name: str) -> list[str]:
        return [a.ref for a in self.client.artifacts.list(name=name, limit=50).data][::-1]  # oldest first

    def artifact(self, name: str, count: int = 1) -> None:
        from grad import recipes as r

        if len(self.versions(name)) >= count:
            return
        kind, ds = ARTIFACTS[name]
        self.dataset(ds)
        recipe = {
            "sft": lambda: r.SFTRecipe(model=self.model("qwen/qwen3-8b")),
            "router": lambda: r.RouterRecipe(model=self.model("qwen/qwen3-0.6b")),
            "decision-model": lambda: r.DecisionModelRecipe(model=self.model("gradiated/linden-1")),
            "embedding": lambda: r.EmbeddingRecipe(model=self.model("baai/bge-small-en-v1.5")),
            "cartridge": lambda: r.CartridgeRecipe(model=self.model("qwen/qwen3-8b"), context=__import__("grad").Context.from_text(FILES["context.md"])),
            "distill": lambda: r.DistillRecipe(model=self.model("qwen/qwen3-4b"), teacher="test/tiny-qwen3-teacher" if self.cloud else "qwen/qwen3-14b"),
            "reward": lambda: r.RewardModelRecipe(model=self.model("qwen/qwen3-8b")),
        }[kind]()
        run = self.client.runs.create(dataset=ds, name=name, recipe=recipe).wait(timeout=900)
        self.run_id = self.run_id or run.id
        self.artifact(name, count)

    def seed(self, code: str) -> None:
        for m in DATASET_REFS.finditer(code):
            self.dataset(next(g for g in m.groups() if g))
        for name in set(ARTIFACT_REFS.findall(code)):
            if name in ARTIFACTS and not re.search(rf"""name=["']{name}["']|--name {name}\b|^name: {name}$""", code, re.M):
                self.artifact(name, max(1, len({v for nm, v in DATED_REFS.findall(code) if nm == name})))
        if RUN_IDS.search(code) and not self.run_id:
            self.artifact("fast-diff-merge")
        for name in set(RUN_NAMES.findall(code)):
            if name in ARTIFACTS:
                self.artifact(name)
        for m in SECRET_REFS.finditer(code):
            self.secret(next(g for g in m.groups() if g))
        if SOURCE_IDS.search(code) and not self.source_id:
            from grad import sources

            self.dataset("support-prod")
            self.secret("langfuse-prod")
            host = self.langfuse_url or LANGFUSE_HOSTS[-1]
            self.source_id = self.client.sources.create("support-prod", sources.Langfuse(host=host, secret="langfuse-prod")).id

    def cwd(self, n: int) -> Path:
        """A fresh directory per block (downloads never collide), with the shared files linked in."""
        d = self.work / f"block-{n}"
        d.mkdir(exist_ok=True)
        for f in self.work.iterdir():
            if f.is_file() and not (d / f.name).exists():
                (d / f.name).symlink_to(f)
        return d

    def sync(self, name: str) -> None:
        """Fill dataset `name` through a real source sync from the fake Langfuse (once)."""
        from grad import sources

        if name in self.synced or not self.langfuse_url:
            return
        import urllib.request

        for path, rows in (("traces", SYNCED_TRACES), ("scores", SYNCED_SCORES)):
            req = urllib.request.Request(f"{self.langfuse_url}/_control/{path}", data=json.dumps(rows).encode(),
                                         headers={"Content-Type": "application/json"}, method="POST")
            urllib.request.urlopen(req, timeout=30).close()
        self.dataset(name)
        self.secret("langfuse-prod")
        source = self.client.sources.create(name, sources.Langfuse(host=self.langfuse_url, secret="langfuse-prod"))
        source.sync().wait(timeout=300)
        self.synced.add(name)

    def secret(self, name: str) -> None:
        from grad import NotFoundError

        try:
            self.client.secrets.get(name)
        except NotFoundError:
            hosts = [self.langfuse_url, *PUBLIC_SECRET_HOSTS] if self.langfuse_url else None
            self.client.secrets.set(name, self.provider_key, allowed_hosts=hosts)

    def helm(self, block: dict, n: int) -> tuple[bool, str]:
        """`helm template` the chart with the page's first values block plus this one (an overlay)."""
        files = []
        for k, code in enumerate(dict.fromkeys([self.helm_base or block["code"], block["code"]])):
            f = self.cwd(n) / f"values-{k}.yaml"
            f.write_text(code)
            files += ["-f", str(f)]
        self.helm_base = self.helm_base or block["code"]
        p = subprocess.run(["helm", "template", "grad", str(REPO / "server" / "helm" / "grad"), *files], capture_output=True, text=True, timeout=120)
        return p.returncode == 0, p.stderr.strip()[-1500:]

    def run(self, block: dict, n: int) -> tuple[bool, str]:
        if block["lang"] == "helm":
            return self.helm(block, n)
        self.seed(block["code"])
        if block["page"].startswith("integrations/") and re.search(r"\.filter\(|datasets\.records|\.records\(", block["code"]):
            for name in {next(g for g in m.groups() if g) for m in DATASET_REFS.finditer(block["code"])}:
                self.sync(name)
        python = sys.executable
        if block["torch"]:
            name, prelude = block["torch"]
            self.artifact(name)
            python = os.environ.get("GRAD_TRAINER_PYTHON", sys.executable)
        code = self.rewrite(block["code"], n)
        env = self.env
        if re.search(r"^\s*export GRADIATED_PROFILE=", code, re.M):  # only the profile may point the block at the stack
            env = {k: v for k, v in env.items() if k not in ("GRADIATED_BASE_URL", "GRADIATED_API_KEY")}
        if block["lang"] == "python":
            if block["torch"]:
                code = prelude + code
            if "client." in code and "client = " not in code:
                code = "from grad import Grad\nclient = Grad()\n" + code
            if block["hf"]:
                code = ONLINE_LIMITS + code
            if self.cloud:
                code = TINY_DEFAULTS + code
            if block["torch"]:
                # The SDK's own dependencies (httpx) come from this interpreter, after the trainer's packages.
                import sysconfig

                code = f"import sys\nsys.path.append({sysconfig.get_paths()['purelib']!r})\n" + code
            cmd = [python, "-c", code]
        else:
            code = re.sub(r"^grad login$", 'grad login --api-key "$GRADIATED_API_KEY"', code, flags=re.M)
            cmd = ["bash", "-euo", "pipefail", "-c", code]
        try:
            # `grad secrets set NAME` reads the value from stdin.
            stdin = {"input": self.provider_key + "\n"} if "grad secrets set" in code else {"stdin": subprocess.DEVNULL}
            p = subprocess.run(cmd, cwd=self.cwd(n), env=env, capture_output=True, text=True, timeout=self.timeout, **stdin)
        except subprocess.TimeoutExpired:
            return False, f"timed out after {self.timeout}s"
        return p.returncode == 0, (p.stderr or p.stdout).strip()[-1500:]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--docs", required=True, type=Path, help="product/website/src/docs/training in the docs repo")
    ap.add_argument("--cloud", action="store_true", help="run the deploy/route/embed blocks (fake Cloud API, torch worker)")
    ap.add_argument("--base-url", help="use a running stack instead of starting one (with --api-key)")
    ap.add_argument("--api-key", default="")
    ap.add_argument("--grad-bin", default=shutil.which("grad") or str(Path(os.environ.get("CARGO_TARGET_DIR", REPO / "target")) / "debug" / "grad"))
    ap.add_argument("--only", help="run only pages whose path contains this")
    ap.add_argument("--timeout", type=int, default=900, help="seconds per block")
    ap.add_argument("--list", action="store_true", help="list the blocks and exit")
    ap.add_argument("--offline", action="store_true", help="skip the blocks that download from Hugging Face")
    args = ap.parse_args()

    found = [b for b in blocks(args.docs) if not args.only or args.only in b["page"]]
    if args.list:
        for b in found:
            if b["lang"] == "file":
                continue
            skip = b["skip"] or ("needs network access to Hugging Face" if b["hf"] and args.offline else None)
            tag = f"skip: {skip}" if skip else ("cloud" if b["cloud"] else "run")
            print(f"{b['page']}:{b['line']} {b['lang']} [{tag}]")
        return 0
    if not Path(args.grad_bin).exists():
        raise SystemExit(f"grad binary not found at {args.grad_bin} (build it with `cargo build -p grad-cli` or pass --grad-bin)")

    work = Path(tempfile.mkdtemp(prefix="grad-docs-"))
    stack = None
    if not args.base_url:
        worker = "torch" if args.cloud else "reference"
        stack = Stack(args.cloud, worker, work / "stack.log", online=not args.offline)
        args.base_url, args.api_key = stack.info["base_url"], stack.info["api_key"]
    results = {"pass": 0, "fail": 0, "skip": 0}
    try:
        runner = Runner(args.base_url, args.api_key, args.cloud, args.grad_bin, work, args.timeout, stack.info if stack else None)
        for n, b in enumerate(found):
            if b["lang"] == "file":
                (work / b["name"]).write_text(runner.rewrite(b["code"], n))
                continue
            where = f"{b['page']}:{b['line']} ({b['lang']})"
            reason = b["skip"] or ("needs network access to Hugging Face (--offline)" if b["hf"] and args.offline else None)
            reason = reason or (None if b["cloud"] == args.cloud else ("needs --cloud" if b["cloud"] else "runs without --cloud"))
            if reason:
                results["skip"] += 1
                print(f"SKIP {where}: {reason}", flush=True)
                continue
            try:
                ok, out = runner.run(b, n)
            except Exception as exc:  # a seed failure is a failure of this block
                ok, out = False, f"fixture setup failed: {exc!r}"
            results["pass" if ok else "fail"] += 1
            print(f"{'PASS' if ok else 'FAIL'} {where}", flush=True)
            if not ok:
                print("  " + out.replace("\n", "\n  "), flush=True)
    finally:
        if stack:
            stack.close()
        if results["fail"]:
            print(f"scratch directory and stack log kept in {work}")
        else:
            shutil.rmtree(work, ignore_errors=True)
    print(f"\n{results['pass']} passed, {results['fail']} failed, {results['skip']} skipped")
    return 1 if results["fail"] else 0


if __name__ == "__main__":
    sys.exit(main())
