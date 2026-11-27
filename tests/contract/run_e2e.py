#!/usr/bin/env python3
"""Full cross-language E2E contract suite against live grad-server + live grad-trainer.

Exercises:
1. Python SDK (exact docs quickstart + all 6 v0 recipes + cartridge safetensors + evals + failure mining + outbound serve_environment)
2. TypeScript SDK (built @gradiated/grad package)
3. Go SDK (sdks/go via `go run`)
4. Rust `grad` CLI binary (datasets push, train --dry-run, runs inspect --yaml, artifacts download, deployments status, route)
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "sdks" / "python"))
sys.path.insert(0, str(REPO_ROOT / "server" / "trainer"))

from grad import (  # noqa: E402
    CartridgeRecipe,
    Context,
    DPORecipe,
    DecisionModelRecipe,
    EmbeddingRecipe,
    Environment,
    Grad,
    RouterRecipe,
    SFTRecipe,
    StepOutcome,
    serve_environment,
    validators,
)
from grad_trainer.bundles import read_artifact_bundle  # noqa: E402
from grad_trainer.safetensors_io import decode_safetensors  # noqa: E402
from grad_trainer.worker import TrainerWorker  # noqa: E402


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return int(s.getsockname()[1])


def _wait_ready(base_url: str, timeout_s: float = 15.0) -> None:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"{base_url}/health/ready", timeout=2) as resp:
                if resp.status == 200:
                    return
        except Exception:
            time.sleep(0.15)
    raise RuntimeError(f"grad-server at {base_url} did not become ready")


class _EchoEnv(Environment):
    def setup(self, task: dict) -> str:
        return str(task["prompt"])

    def step(self, action: str) -> StepOutcome:
        return StepOutcome(observation=f"ok:{action}", done=True)

    def evaluate(self) -> tuple[float, dict[str, float]]:
        return 1.0, {"tests": 1.0}


def main() -> None:
    port = _free_port()
    base_url = f"http://127.0.0.1:{port}"
    tmp_dir = Path(tempfile.mkdtemp(prefix="grad-e2e-"))
    storage_dir = tmp_dir / "storage"
    api_dir = REPO_ROOT / "server" / "api"
    tsx_bin = api_dir / "node_modules" / ".bin" / "tsx"

    server_proc = subprocess.Popen(
        [str(tsx_bin), "src/main.ts"],
        cwd=str(api_dir),
        env={
            **os.environ,
            "PORT": str(port),
            "HOST": "127.0.0.1",
            "AUTH_MODE": "none",
            "DEPLOY_MODE": "local",
            "STORAGE_DIR": str(storage_dir),
        },
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        _wait_ready(base_url)
        client = Grad(base_url=base_url)
        worker = TrainerWorker(server_url=base_url, worker_id="e2e-trainer-0")

        # --- 1. Python SDK: Docs Quickstart + All 6 v0 Recipes ---
        support_records = [
            {
                "session_id": f"sess_{i}",
                "messages": [
                    {"role": "user", "content": f"How do I reset password #{i}?"},
                    {"role": "assistant", "content": '{"action":"reset_password"}'},
                ],
                "scores": {
                    "qwen/qwen3-8b": 0.96 if i % 2 == 0 else 0.45,
                    "qwen/qwen3-32b": 0.96,
                },
                "state": {"tier": "pro", "attempt": i},
                "questions": {"escalate": {"kind": "choice", "options": ["yes", "no"]}},
                "prompt": f"billing q {i}",
                "chosen": "Clear polite billing answer.",
                "rejected": "Rude answer.",
                "query": f"reset password {i}",
                "positive": f"account settings reset password {i}",
                "negatives": [f"unrelated shipping policy {i}"],
            }
            for i in range(10)
        ]
        ds = client.datasets.push("support", support_records)
        assert ds["record_count"] == 10

        recipe_cases = [
            ("support-sft", SFTRecipe(model="qwen/qwen3-8b", batch_size=4)),
            ("support-dpo", DPORecipe(model="qwen/qwen3-8b", batch_size=4, beta=0.1)),
            (
                "support-router",
                RouterRecipe(
                    models=["qwen/qwen3-8b", "qwen/qwen3-32b"],
                    max_quality_drop=0.05,
                    batch_size=4,
                ),
            ),
            ("support-decision", DecisionModelRecipe(batch_size=4)),
            (
                "support-cartridge",
                CartridgeRecipe(
                    model="qwen/qwen3-8b",
                    context=Context(text="Refunds are valid within 30 days."),
                    num_tokens=32,
                    batch_size=4,
                ),
            ),
            ("support-embed", EmbeddingRecipe(batch_size=4, temp=0.05)),
        ]

        run_ids: dict[str, str] = {}
        artifacts: dict[str, str] = {}
        for run_name, recipe in recipe_cases:
            plan = client.runs.plan(
                "support", name=run_name, recipe=recipe, max_cost_usd=5.0
            )
            assert plan["estimated_steps"] >= 1
            created = client.runs.create(
                "support", name=run_name, recipe=recipe, max_cost_usd=5.0
            )
            run_ids[run_name] = created["id"]
            completed = worker.run_once()
            assert completed is not None and completed["run"]["status"] == "completed"
            artifacts[run_name] = completed["artifact"]["id"]

        # Verify Cartridge binary format gradiated.cartridge/1 end-to-end!
        cart_archive = client.artifacts.download(
            artifacts["support-cartridge"], dest_path=tmp_dir / "cartridge.grad.tar.gz"
        )
        cart_manifest, cart_files = read_artifact_bundle(cart_archive)
        assert cart_manifest["cartridge_format"] == "gradiated.cartridge/1"
        st_meta, st_tensors = decode_safetensors(cart_files["cartridge.safetensors"])
        assert st_meta["format"] == "gradiated.cartridge/1"
        assert st_tensors["embeddings"].shape == (32, 64)

        # Deploy router, call /v1/route, verify idempotent feedback
        dep = client.deploy(
            artifacts["support-router"],
            fallback="qwen/qwen3-32b",
            explore_rate=0.05,
        )
        assert dep["status"] == "active"

        routed = client.route(
            "support-router",
            [{"role": "user", "content": "Reset my password?"}],
            session_id="py_sess_1",
        )
        fb1 = client.feedback.record(
            idempotency_key="py_fb_1",
            inference_id=routed["inference_id"],
            deployment_name="support-router",
            score=1.0,
        )
        fb2 = client.feedback.record(
            idempotency_key="py_fb_1",
            inference_id=routed["inference_id"],
            deployment_name="support-router",
            score=1.0,
        )
        assert fb1["accepted"] == 1 and fb2["deduplicated"] == 1

        # Standalone eval + failure mining into new dataset
        client.datasets.push(
            "eval-mix",
            [
                {
                    "messages": [
                        {"role": "user", "content": "q1"},
                        {"role": "assistant", "content": '{"ok":true}'},
                    ]
                },
                {
                    "messages": [
                        {"role": "user", "content": "q2"},
                        {"role": "assistant", "content": "not-json"},
                    ]
                },
            ],
        )
        ev_plan = client.evals.plan(
            models=["qwen/qwen3-8b", artifacts["support-sft"]],
            baseline="qwen/qwen3-8b",
            dataset="eval-mix",
            samples=2,
            rubric=validators.json_valid(),
        )
        assert ev_plan["estimated_model_calls"] == 8
        ev = client.evals.create(
            name="json-eval",
            models=["qwen/qwen3-8b", artifacts["support-sft"]],
            baseline="qwen/qwen3-8b",
            dataset="eval-mix",
            samples=2,
            rubric=validators.json_valid(),
        )
        mined = client.evals.failures(ev["id"], model=artifacts["support-sft"]).to_dataset(
            "hard-cases"
        )
        assert mined["record_count"] == 1

        # Live outbound `grad env serve` worker dispatch -> claim -> complete
        worker_done: list[int] = []
        worker_errors: list[BaseException] = []

        def run_env_worker() -> None:
            try:
                n = serve_environment(
                    _EchoEnv(),
                    name="e2e-env",
                    base_url=base_url,
                    worker_id="e2e-env-worker",
                    max_tasks=1,
                    wait_ms=2000,
                )
                worker_done.append(n)
            except BaseException as exc:
                worker_errors.append(exc)

        t = threading.Thread(target=run_env_worker, daemon=True)
        t.start()
        dispatched = client.environments.dispatch(
            "e2e-env", {"prompt": "fix failing test"}, model_id="qwen/qwen3-8b"
        )
        t.join(timeout=10.0)
        assert not t.is_alive(), "serve_environment thread timed out"
        if worker_errors:
            raise worker_errors[0]
        assert worker_done == [1]
        env_task = client.environments.get_task(dispatched["id"])
        assert env_task["status"] == "completed"
        assert env_task["result"]["score"] == 1.0
        print("[py-e2e] PASS (all 6 v0 recipes, cartridge/1, evals+mining, env-serve)")

        child_env = {
            **os.environ,
            "GRAD_BASE_URL": base_url,
            "GRAD_ARTIFACT_REF": artifacts["support-sft"],
            "GRAD_DEPLOYMENT_NAME": "support-router",
        }

        # --- 2. TypeScript SDK E2E ---
        subprocess.run(
            ["node", str(REPO_ROOT / "tests" / "contract" / "ts_e2e.mjs")],
            cwd=str(REPO_ROOT),
            env=child_env,
            timeout=60,
            check=True,
        )

        # --- 3. Go SDK E2E ---
        subprocess.run(
            ["go", "run", str(REPO_ROOT / "tests" / "contract" / "go_e2e.go")],
            cwd=str(REPO_ROOT / "sdks" / "go"),
            env=child_env,
            timeout=60,
            check=True,
        )

        # --- 4. Rust `grad` CLI E2E ---
        # Always (re)build: cargo is incremental, and a stale binary hides regressions.
        subprocess.run(
            ["cargo", "build", "--bin", "grad"],
            cwd=str(REPO_ROOT),
            timeout=600,
            check=True,
        )
        target_dir = Path(os.environ.get("CARGO_TARGET_DIR", REPO_ROOT / "target"))
        grad_bin = Path(os.environ.get("GRAD_BIN", target_dir / "debug" / "grad"))
        child_env = {
            **child_env,
            "GRADIATED_BASE_URL": base_url,
            "XDG_CONFIG_HOME": str(tmp_dir / "xdg"),
        }
        child_env.pop("GRADIATED_PROFILE", None)

        # Negative test: invalid Python target rejected cleanly by `grad env serve`
        bad_env = subprocess.run(
            [str(grad_bin), "env", "serve", "123:456", "--name", "bad-env"],
            env=child_env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=15,
        )
        assert bad_env.returncode != 0

        # Live Rust CLI `grad env serve` bridge test!
        env_mod = tmp_dir / "cli_env_fixture.py"
        env_mod.write_text(
            "from grad import Environment, StepOutcome\n"
            "class CliEnv(Environment):\n"
            "    def evaluate(self):\n"
            "        return 1.0, {'cli_bridge': 1.0}\n"
            "env = CliEnv()\n",
            encoding="utf-8",
        )
        cli_env_vars = {
            **child_env,
            "PYTHONPATH": f"{tmp_dir}:{REPO_ROOT / 'sdks' / 'python'}",
        }
        cli_env_proc = subprocess.Popen(
            [
                str(grad_bin),
                "env",
                "serve",
                "cli_env_fixture:env",
                "--name",
                "cli-bridge-env",
                "--max-tasks",
                "1",
            ],
            env=cli_env_vars,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        try:
            dispatched_cli = client.environments.dispatch(
                "cli-bridge-env", {"prompt": "cli bridge check"}, model_id="qwen/qwen3-8b"
            )
            cli_env_proc.wait(timeout=15)
            assert cli_env_proc.returncode == 0
            cli_task = client.environments.get_task(dispatched_cli["id"])
            assert cli_task["status"] == "completed"
            assert cli_task["result"]["score"] == 1.0
        finally:
            if cli_env_proc.poll() is None:
                cli_env_proc.terminate()
                cli_env_proc.wait(timeout=5)
            if cli_env_proc.stdout:
                cli_env_proc.stdout.close()
            if cli_env_proc.stderr:
                cli_env_proc.stderr.close()

        jsonl_path = tmp_dir / "cli_records.jsonl"
        jsonl_path.write_text(
            json.dumps(
                {
                    "session_id": "cli_1",
                    "messages": [
                        {"role": "user", "content": "Hello CLI"},
                        {"role": "assistant", "content": "Hello back"},
                    ],
                }
            )
            + "\n",
            encoding="utf-8",
        )
        subprocess.run(
            [str(grad_bin), "datasets", "push", "cli-ds", str(jsonl_path)],
            env=child_env,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        dry_out = subprocess.check_output(
            [
                str(grad_bin),
                "train",
                "--dataset",
                "cli-ds",
                "--name",
                "cli-sft",
                "--recipe",
                "sft",
                "--dry-run",
                "--json",
            ],
            env=child_env,
            text=True,
        )
        assert json.loads(dry_out)["data"]["estimated_steps"] >= 1

        yaml_out = subprocess.check_output(
            [str(grad_bin), "runs", "inspect", run_ids["support-sft"], "--yaml"],
            env=child_env,
            text=True,
        )
        assert "recipe: sft" in yaml_out

        cli_dl_path = tmp_dir / "cli-dl.grad.tar.gz"
        subprocess.run(
            [
                str(grad_bin),
                "artifacts",
                "download",
                artifacts["support-sft"],
                "--archive",
                str(cli_dl_path),
            ],
            env=child_env,
            check=True,
            stdout=subprocess.DEVNULL,
        )
        assert cli_dl_path.exists() and cli_dl_path.stat().st_size > 20

        route_out = subprocess.check_output(
            [
                str(grad_bin),
                "route",
                "--deployment",
                "support-router",
                "--prompt",
                "Reset password?",
                "--json",
            ],
            env=child_env,
            text=True,
        )
        assert "model" in json.loads(route_out)["data"]
        print("[cli-e2e] PASS")
        print("ALL CROSS-LANGUAGE CONTRACT E2E CHECKS PASSED!")
    finally:
        server_proc.terminate()
        try:
            server_proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            server_proc.kill()
            server_proc.wait(timeout=5)
        if server_proc.stdout:
            server_proc.stdout.close()
        if server_proc.stderr:
            server_proc.stderr.close()
        shutil.rmtree(tmp_dir, ignore_errors=True)


if __name__ == "__main__":
    main()
