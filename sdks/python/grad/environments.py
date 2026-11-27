"""Environment primitives and outbound `grad env serve` worker loop."""

from __future__ import annotations

import os
import socket
import threading
import time
from dataclasses import dataclass, field
from typing import Any, Callable, Sequence

from ._generated import GeneratedApiClient


@dataclass
class StepOutcome:
    observation: str
    done: bool = False
    reward: float | None = None
    info: dict[str, Any] = field(default_factory=dict)


class Environment:
    """User-defined environment executed locally via `grad env serve`."""

    def setup(self, task: dict[str, Any]) -> str:
        return str(task.get("prompt") or "")

    def step(self, action: str) -> StepOutcome:
        return StepOutcome(observation=action, done=True)

    def evaluate(self) -> float | tuple[float, dict[str, float]]:
        return 1.0, {"score": 1.0}

    def teardown(self) -> None:
        return None


class ToolsEnvironment(Environment):
    """Multi-turn tool-calling environment dispatching named Python callables."""

    def __init__(self, tools: Sequence[Callable[..., Any]]) -> None:
        self.tools = {fn.__name__: fn for fn in tools}
        self._last_output = ""

    def step(self, action: str) -> StepOutcome:
        self._last_output = action
        return StepOutcome(observation=action, done=True)


@dataclass(frozen=True)
class RemoteEnvironment:
    """Reference to an environment served remotely via `grad env serve --name <name>`."""

    name: str
    timeout_s: int = 120


class environments:
    """Namespace for environment helpers."""

    Tools = ToolsEnvironment
    Remote = RemoteEnvironment


def _normalize_eval_result(raw: Any) -> tuple[float, dict[str, float]]:
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        val = float(raw)
        return val, {"score": val}
    if isinstance(raw, tuple) and len(raw) == 2:
        score, scores = raw
        if isinstance(score, bool) or not isinstance(score, (int, float)):
            raise TypeError(f"evaluate() score must be float, got {type(score).__name__}")
        if not isinstance(scores, dict):
            raise TypeError(f"evaluate() scores must be dict, got {type(scores).__name__}")
        return float(score), {str(k): float(v) for k, v in scores.items()}
    raise TypeError(
        "Environment.evaluate() must return a float or (float, dict[str, float])."
    )


def serve_environment(
    env: Environment,
    *,
    name: str,
    base_url: str,
    api_key: str | None = None,
    worker_id: str | None = None,
    concurrency: int = 4,
    wait_ms: int = 5000,
    heartbeat_s: float = 20.0,
    max_tasks: int | None = None,
    stop_event: threading.Event | None = None,
    agent_fn: Callable[[str, dict[str, Any]], str] | None = None,
) -> int:
    """Outbound worker loop for `grad env serve` — zero inbound ports, background heartbeats."""
    if not name or not name.strip():
        raise ValueError("Environment worker name must be non-empty.")

    client = GeneratedApiClient(
        base_url=base_url,
        api_key=api_key,
        timeout_s=max(30.0, wait_ms / 1000.0 + 10.0),
    )
    wid = worker_id or f"env-{socket.gethostname()}-{os.getpid()}"
    client.register_env_worker(
        {"name": name, "worker_id": wid, "concurrency": concurrency}
    )

    done_event = stop_event or threading.Event()
    hb_stop = threading.Event()

    def _heartbeat_loop() -> None:
        while not hb_stop.wait(timeout=max(1.0, heartbeat_s)):
            if done_event.is_set():
                break
            try:
                client.register_env_worker(
                    {"name": name, "worker_id": wid, "concurrency": concurrency}
                )
            except Exception:
                pass

    hb_thread = threading.Thread(target=_heartbeat_loop, daemon=True)
    hb_thread.start()

    processed = 0
    try:
        while not done_event.is_set() and (max_tasks is None or processed < max_tasks):
            claimed = client.claim_env_task(
                name, {"worker_id": wid, "wait_ms": wait_ms}
            )
            task_envelope = claimed.get("task")
            if not task_envelope:
                if max_tasks is not None:
                    time.sleep(0.05)
                continue

            task_id = str(task_envelope["id"])
            task_data = dict(task_envelope.get("task") or {})
            messages: list[dict[str, Any]] = []
            error_msg: str | None = None
            score: float = 0.0
            scores: dict[str, float] = {}

            try:
                obs = env.setup(task_data)
                messages.append({"role": "user", "content": obs})
                max_turns = max(1, int(task_data.get("max_turns", 1)))
                for _ in range(max_turns):
                    action = (
                        agent_fn(obs, task_envelope)
                        if agent_fn is not None
                        else str(task_data.get("expected_output") or "done")
                    )
                    messages.append({"role": "assistant", "content": action})
                    outcome = env.step(action)
                    if outcome.done:
                        break
                    obs = outcome.observation
                    messages.append(
                        {"role": "tool", "content": obs, "train": False}
                    )
                score, scores = _normalize_eval_result(env.evaluate())
            except Exception as exc:
                error_msg = str(exc)[:4000]
                score = 0.0
                scores = {}
            finally:
                try:
                    env.teardown()
                except Exception:
                    pass

            result_payload: dict[str, Any] = {
                "worker_id": wid,
                "score": score,
                "scores": scores,
                "trajectory": {"messages": messages},
            }
            if error_msg is not None:
                result_payload["error"] = error_msg

            client.complete_env_task(task_id, result_payload)
            processed += 1
    except KeyboardInterrupt:
        pass
    finally:
        hb_stop.set()
        hb_thread.join(timeout=1.0)

    return processed
