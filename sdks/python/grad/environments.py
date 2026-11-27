"""Environments and the outbound ``serve_environment`` worker (``grad env serve``).

An :class:`Environment` hands out one *handle* per rollout, so parallel attempts never
share mutable state::

    class TicketEnv(Environment[Store]):
        def setup(self, task: Task, rollout_id: str) -> Store: ...
        def step(self, handle: Store, action: Action) -> Observation: ...
        def evaluate(self, handle: Store, trajectory: Trajectory) -> float | dict[str, float]: ...
        def teardown(self, handle: Store) -> None: ...

``serve_environment(env, name=..., policy=...)`` connects outbound to grad-server (no
inbound ports), long-polls for tasks, runs up to ``concurrency`` rollouts in parallel,
and posts each scored trajectory. The *policy* produces the model's turns: pass
:class:`ChatCompletionsPolicy` (any OpenAI-compatible endpoint; it calls the task's
``model_id``) or your own function. There is no default policy: the worker refuses to
start without one rather than invent answers.

Environment-backed training and evals (``GRPORecipe(env=...)``) arrive in Wave 2; the
worker protocol and these classes are usable today with ``client.environments.dispatch``.
"""

from __future__ import annotations

import concurrent.futures
import inspect
import json
import logging
import math
import os
import random
import signal
import socket
import threading
import typing
import uuid
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass, field
from typing import TYPE_CHECKING, Any, Generic, TypeVar

from ._config import ResolvedConfig, normalize_base_url
from ._errors import (
    APIConnectionError,
    AuthenticationError,
    ConflictError,
    GradAPIError,
    NotAvailableInV0Error,
    NotFoundError,
    PermissionDeniedError,
    RateLimitError,
    ServerError,
)
from ._transport import Clock, RetryPolicy, SyncTransport
from .records import Task, Trajectory
from .rubrics import Rubric, Scorer, coerce_rubric

if TYPE_CHECKING:
    from .client import Grad

__all__ = [
    "Action",
    "ChatCompletionsPolicy",
    "Environment",
    "Observation",
    "RemoteEnvironment",
    "StepOutcome",
    "ToolCall",
    "ToolsEnvironment",
    "environments",
    "serve_environment",
]

H = TypeVar("H")
log = logging.getLogger("grad.environments")
_TRANSIENT = (APIConnectionError, ServerError, RateLimitError)


@dataclass(frozen=True)
class ToolCall:
    """One tool call the model made (``arguments`` already JSON-decoded)."""

    name: str
    arguments: dict[str, Any] = field(default_factory=dict)
    id: str | None = None


@dataclass(frozen=True)
class Action:
    """The model's turn: its text and any tool calls."""

    text: str = ""
    tool_calls: list[ToolCall] = field(default_factory=list)
    message: dict[str, Any] = field(default_factory=dict)

    @classmethod
    def from_message(cls, message: Mapping[str, Any]) -> Action:
        """Parse an OpenAI-format assistant message."""
        calls = []
        for raw in message.get("tool_calls") or []:
            fn = raw.get("function") or {}
            args = fn.get("arguments", {})
            if isinstance(args, str):
                try:
                    args = json.loads(args) if args.strip() else {}
                except ValueError:
                    args = {"_raw": args}
            calls.append(ToolCall(name=str(fn.get("name", "")), arguments=dict(args) if isinstance(args, Mapping) else {"_raw": args}, id=raw.get("id")))
        content = message.get("content")
        return cls(text=content if isinstance(content, str) else "", tool_calls=calls, message=dict(message))


@dataclass
class Observation:
    """What the environment returns after a step.

    ``text`` is shown to the model as the next (untrained) turn; set ``messages`` to
    control the exact turns (e.g. ``tool`` results with ``tool_call_id``). ``done`` ends
    the rollout.
    """

    text: str = ""
    done: bool = False
    reward: float | None = None
    info: dict[str, Any] = field(default_factory=dict)
    messages: list[dict[str, Any]] | None = None


class StepOutcome(Observation):
    """Alias of :class:`Observation` (0.1 SDK name; ``observation`` is ``text``)."""

    def __init__(self, observation: str = "", done: bool = False, reward: float | None = None, info: dict[str, Any] | None = None) -> None:
        super().__init__(text=observation, done=done, reward=reward, info=dict(info or {}))

    @property
    def observation(self) -> str:
        """The observation text."""
        return self.text


class Environment(Generic[H]):
    """Base class for environments. Override ``setup``/``step``/``evaluate``/``teardown``.

    The default is a single-turn environment: the model answers once and the answer is
    scored by ``rubric`` (``Scorer``/``StatefulScorer``/validators, run in this process).
    One instance serves many rollouts concurrently, so keep per-rollout state in the
    handle ``setup`` returns.
    """

    max_turns: int = 1
    system_prompt: str | None = None

    def __init__(self, rubric: Any = None, *, max_turns: int | None = None, system_prompt: str | None = None) -> None:
        self.rubric: Rubric | None = None if rubric is None else coerce_rubric(rubric)
        if max_turns is not None:
            if max_turns < 1:
                raise ValueError("max_turns must be at least 1.")
            self.max_turns = max_turns
        if system_prompt is not None:
            self.system_prompt = system_prompt

    def tools(self) -> list[dict[str, Any]] | None:
        """OpenAI tool definitions offered to the model (``None`` for none)."""
        return None

    def setup(self, task: Task, rollout_id: str) -> H:
        """Prepare one rollout and return its handle (default: no state)."""
        return None  # type: ignore[return-value]

    def step(self, handle: H, action: Action) -> Observation:
        """React to the model's turn. Default: the first answer ends the rollout."""
        return Observation(done=True)

    def evaluate(self, handle: H, trajectory: Trajectory) -> float | Mapping[str, float]:
        """Score the finished rollout: a float, or named scores combined by the rubric weights."""
        if self.rubric is None:
            raise NotImplementedError(
                f"{type(self).__name__} has no rubric and does not override evaluate(); "
                "pass rubric=Rubric([...]) or implement evaluate(handle, trajectory)."
            )
        return self.rubric.score_local(trajectory, handle)

    def teardown(self, handle: H) -> None:
        """Release the rollout's resources (always called, even after errors)."""
        return None


def _json_type(annotation: Any) -> dict[str, Any]:
    origin = typing.get_origin(annotation)
    if annotation in (inspect.Parameter.empty, Any):
        return {}
    if annotation is str:
        return {"type": "string"}
    if annotation is bool:
        return {"type": "boolean"}
    if annotation is int:
        return {"type": "integer"}
    if annotation is float:
        return {"type": "number"}
    if origin in (list, Sequence) or annotation is list:
        args = typing.get_args(annotation)
        return {"type": "array", "items": _json_type(args[0]) if args else {}}
    if origin in (dict, Mapping) or annotation is dict:
        return {"type": "object"}
    if origin is typing.Literal:
        return {"enum": list(typing.get_args(annotation))}
    members = [a for a in typing.get_args(annotation) if a is not type(None)]
    if len(members) == 1:
        return _json_type(members[0])
    return {}


def tool_schema(fn: Callable[..., Any]) -> dict[str, Any]:
    """An OpenAI ``function`` tool definition from a typed Python function and its docstring."""
    sig = inspect.signature(fn)
    hints = typing.get_type_hints(fn)
    props: dict[str, Any] = {}
    required = []
    for name, param in sig.parameters.items():
        if param.kind in (param.VAR_POSITIONAL, param.VAR_KEYWORD):
            continue
        props[name] = _json_type(hints.get(name, param.annotation))
        if param.default is inspect.Parameter.empty:
            required.append(name)
    doc = inspect.getdoc(fn) or ""
    return {
        "type": "function",
        "function": {
            "name": fn.__name__,
            "description": doc.split("\n\n")[0],
            "parameters": {"type": "object", "properties": props, "required": required},
        },
    }


class ToolsEnvironment(Environment[None]):
    """Multi-turn tool use: the model calls your Python functions until it answers in text.

    Each function's signature and docstring become its JSON schema. Tool exceptions are
    returned to the model as an error result. ``requirements`` are checked against the
    locally installed packages when the worker starts.
    """

    def __init__(
        self,
        tools: Sequence[Callable[..., Any]],
        *,
        tasks: Any = None,
        rubric: Any = None,
        max_turns: int | None = None,
        system_prompt: str | None = None,
        requirements: Sequence[str] | None = None,
    ) -> None:
        super().__init__(rubric, max_turns=max_turns if max_turns is not None else (10 if tools else 1), system_prompt=system_prompt)
        self.functions = {fn.__name__: fn for fn in tools}
        if len(self.functions) != len(tools):
            raise ValueError("Tool function names must be unique.")
        self.tasks = tasks
        self.requirements = [str(r) for r in (requirements or [])]
        self._schemas = [tool_schema(fn) for fn in tools]

    def check_requirements(self) -> None:
        """Raise when a declared requirement is not installed."""
        Scorer("tools", fn=lambda _t: 0.0, requirements=self.requirements).check_requirements()

    def tools(self) -> list[dict[str, Any]] | None:
        """The tool definitions."""
        return list(self._schemas) or None

    def step(self, handle: None, action: Action) -> Observation:
        """Run each requested tool; the rollout ends on a turn without tool calls."""
        if not action.tool_calls:
            return Observation(done=True)
        messages = []
        for call in action.tool_calls:
            fn = self.functions.get(call.name)
            if fn is None:
                content = json.dumps({"error": f"unknown tool {call.name!r}; available: {sorted(self.functions)}"})
            else:
                try:
                    result = fn(**call.arguments)
                    content = result if isinstance(result, str) else json.dumps(result, default=str)
                except Exception as exc:  # the model sees the failure and can retry
                    content = json.dumps({"error": f"{type(exc).__name__}: {exc}"})
            msg: dict[str, Any] = {"role": "tool", "content": content, "train": False}
            if call.id:
                msg["tool_call_id"] = call.id
            messages.append(msg)
        return Observation(text="\n".join(m["content"] for m in messages), done=False, messages=messages)


@dataclass(frozen=True)
class RemoteEnvironment:
    """An environment served from your machines by ``grad env serve --name <name>`` (for GRPO, Wave 2)."""

    name: str
    timeout_s: int = 120


def _unavailable(name: str) -> Callable[..., Any]:
    def factory(*args: Any, **kwargs: Any) -> Any:
        raise NotAvailableInV0Error(
            f"environments.{name}",
            "managed sandboxes (Harbor, MCP, Docker Compose, Gymnasium, verifiers Hub) arrive in Wave 2.",
            alternative="Write an Environment subclass and run it with serve_environment / `grad env serve`.",
        )

    return factory


class environments:
    """Environment constructors (``environments.Tools``, ``environments.Remote``, ...)."""

    Tools = ToolsEnvironment
    Remote = RemoteEnvironment
    Harbor = staticmethod(_unavailable("Harbor"))
    MCP = staticmethod(_unavailable("MCP"))
    DockerCompose = staticmethod(_unavailable("DockerCompose"))
    from_gym = staticmethod(_unavailable("from_gym"))
    from_verifiers = staticmethod(_unavailable("from_verifiers"))


class ChatCompletionsPolicy:
    """Produces the model's turns by calling an OpenAI-compatible ``/chat/completions`` endpoint.

    It calls the ``model_id`` each dispatched task names (override with ``model=``), sends
    the environment's tools, and returns the assistant message. Failures raise, so the task
    is reported as errored instead of scored.
    """

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        *,
        model: str | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        timeout: float = 120.0,
        max_retries: int = 2,
    ) -> None:
        config = ResolvedConfig(base_url=normalize_base_url(base_url), api_key=api_key or None, profile="policy")
        self._transport = SyncTransport(config, timeout=timeout, retry=RetryPolicy(max_retries=max_retries))
        self.model = model
        self.temperature = temperature
        self.max_tokens = max_tokens

    def __call__(self, messages: list[dict[str, Any]], *, tools: list[dict[str, Any]] | None = None, model: str | None = None, task: Task | None = None) -> dict[str, Any]:
        """Return the next assistant message for ``messages``."""
        chosen = self.model or model
        if not chosen:
            raise ValueError("No model to call: the task has no model_id and ChatCompletionsPolicy(model=) is unset.")
        body: dict[str, Any] = {"model": chosen, "messages": [{k: v for k, v in m.items() if k != "train"} for m in messages]}
        if tools:
            body["tools"] = tools
        if self.temperature is not None:
            body["temperature"] = self.temperature
        if self.max_tokens is not None:
            body["max_tokens"] = self.max_tokens
        data = self._transport.request("POST", "/chat/completions", json_body=body)
        try:
            message = data["choices"][0]["message"]
        except (KeyError, IndexError, TypeError):
            raise ValueError(f"Malformed chat completion from {self._transport.base_url}: {str(data)[:200]}") from None
        return {"role": "assistant", "content": message.get("content") or "", **({"tool_calls": message["tool_calls"]} if message.get("tool_calls") else {})}

    def close(self) -> None:
        """Close pooled connections."""
        self._transport.close()


Policy = Callable[..., Any]


def _instantiate(env: Any) -> Environment[Any]:
    if isinstance(env, Environment):
        return env
    if isinstance(env, type) and issubclass(env, Environment):
        return env()
    if callable(env):
        built = env()
        if isinstance(built, Environment):
            return built
        raise TypeError(f"Environment factory returned {type(built).__name__}, not an Environment.")
    raise TypeError(f"serve_environment needs an Environment instance, subclass or factory; got {type(env).__name__}.")


def _assistant_message(reply: Any) -> dict[str, Any]:
    if isinstance(reply, str):
        return {"role": "assistant", "content": reply}
    if isinstance(reply, Mapping):
        msg = dict(reply)
        msg.setdefault("role", "assistant")
        if msg["role"] != "assistant":
            raise ValueError(f"The policy must return an assistant message, got role {msg['role']!r}.")
        return msg
    raise TypeError(f"The policy must return a string or an assistant message dict, got {type(reply).__name__}.")


def _scores(raw: Any, rubric: Rubric | None) -> tuple[float, dict[str, float]]:
    def finite(value: Any, name: str) -> float:
        if isinstance(value, bool):
            return 1.0 if value else 0.0
        if not isinstance(value, (int, float)) or not math.isfinite(value):
            raise TypeError(f"evaluate() returned a non-finite or non-numeric score for {name!r}: {value!r}")
        return float(value)

    if isinstance(raw, Mapping):
        scores = {str(k): finite(v, str(k)) for k, v in raw.items()}
        if not scores:
            raise ValueError("evaluate() returned no scores.")
        names = {i.name for i in rubric.items} if rubric is not None else set()
        overall = rubric.overall(scores) if rubric is not None and names <= set(scores) else sum(scores.values()) / len(scores)
        return overall, scores
    value = finite(raw, "score")
    return value, {"score": value}


class _Worker:
    def __init__(
        self,
        env: Environment[Any],
        *,
        name: str,
        policy: Policy,
        client: Grad,
        worker_id: str,
        concurrency: int,
        wait_ms: int,
        heartbeat_s: float,
        max_tasks: int | None,
        stop: threading.Event,
        drain_timeout_s: float,
        max_backoff_s: float,
        clock: Clock,
    ) -> None:
        self.env = env
        self.name = name
        self.policy = policy
        self.client = client
        self.wire = client.wire
        self.worker_id = worker_id
        self.concurrency = concurrency
        self.wait_ms = wait_ms
        self.heartbeat_s = heartbeat_s
        self.max_tasks = max_tasks
        self.stop = stop
        self.drain_timeout_s = drain_timeout_s
        self.max_backoff_s = max_backoff_s
        self.clock = clock
        self.processed = 0
        self.fatal: BaseException | None = None
        self._lock = threading.Lock()
        self._inflight: dict[str, concurrent.futures.Future[None]] = {}
        self._abandoned: set[str] = set()

    # -- registration -------------------------------------------------------------------

    def register(self) -> None:
        self.wire.register_env_worker({"name": self.name, "worker_id": self.worker_id, "concurrency": self.concurrency})

    def heartbeat_loop(self) -> None:
        while not self.stop.wait(self.heartbeat_s):
            try:
                self.register()
            except (AuthenticationError, PermissionDeniedError) as exc:
                self.fatal = exc
                self.stop.set()
            except Exception as exc:  # transient: the next beat retries
                log.warning("env worker heartbeat failed: %s", exc)

    # -- tasks ----------------------------------------------------------------------------

    def rollout(self, envelope: Mapping[str, Any]) -> dict[str, Any]:
        task_id = str(envelope["id"])
        task = Task.from_dict(envelope.get("task") or {}, id=task_id)
        model_id = envelope.get("model_id")
        timeout_s = float(envelope.get("timeout_s") or 120)
        deadline = self.clock.monotonic() + timeout_s
        messages: list[dict[str, Any]] = []
        system = envelope.get("system_prompt") or self.env.system_prompt
        if system:
            messages.append({"role": "system", "content": system})
        messages.extend(task.prompt_messages())
        handle: Any = None
        ready = False
        try:
            handle = self.env.setup(task, task_id)
            ready = True
            tools = self.env.tools()
            max_turns = task.max_turns or self.env.max_turns
            for _ in range(max(1, max_turns)):
                if self.clock.monotonic() > deadline:
                    raise TimeoutError(f"rollout exceeded the task timeout of {timeout_s:g}s")
                reply = self.policy(list(messages), tools=tools, model=model_id, task=task)
                msg = _assistant_message(reply)
                messages.append(msg)
                obs = self.env.step(handle, Action.from_message(msg))
                if not isinstance(obs, Observation):
                    raise TypeError(f"step() must return an Observation, got {type(obs).__name__}.")
                if obs.done:
                    break  # the episode is over: the trajectory ends on the model's last turn
                if obs.messages:
                    messages.extend(dict(m) for m in obs.messages)
                elif obs.text:
                    messages.append({"role": "user", "content": obs.text, "train": False})
            traj = Trajectory(messages=messages, metadata=dict(task.metadata), expected_output=task.expected_output, id=task_id)
            score, scores = _scores(self.env.evaluate(handle, traj), self.env.rubric)
            return {"worker_id": self.worker_id, "score": score, "scores": scores, "trajectory": {"messages": messages}}
        except Exception as exc:
            log.warning("env task %s failed: %s: %s", task_id, type(exc).__name__, exc)
            return {
                "worker_id": self.worker_id,
                "score": None,
                "scores": {},
                "error": f"{type(exc).__name__}: {exc}"[:4000],
                "trajectory": {"messages": messages},
            }
        finally:
            if ready:
                try:
                    self.env.teardown(handle)
                except Exception as exc:
                    log.warning("env teardown for task %s failed: %s", task_id, exc)

    def complete(self, task_id: str, payload: Mapping[str, Any]) -> bool:
        delay = 0.5
        for attempt in range(6):
            try:
                self.wire.complete_env_task(task_id, dict(payload))
                return True
            except (ConflictError, NotFoundError) as exc:
                log.warning("env task %s result not accepted (%s); it probably timed out server-side", task_id, exc.code)
                return False
            except (AuthenticationError, PermissionDeniedError) as exc:
                self.fatal = exc
                self.stop.set()
                return False
            except _TRANSIENT as exc:
                if attempt == 5:
                    log.error("giving up posting env task %s: %s", task_id, exc)
                    return False
                self.clock.sleep(delay)
                delay = min(self.max_backoff_s, delay * 2)
        return False  # pragma: no cover

    def run_task(self, envelope: Mapping[str, Any]) -> None:
        task_id = str(envelope["id"])
        payload = self.rollout(envelope)
        with self._lock:
            if task_id in self._abandoned:
                return
        if self.complete(task_id, payload):
            with self._lock:
                self.processed += 1

    # -- main loop -----------------------------------------------------------------------

    def _backoff_wait(self, delay: float) -> float:
        self.stop.wait(delay * (0.5 + random.random() / 2))
        return min(self.max_backoff_s, delay * 2)

    def serve(self) -> int:
        delay = 0.5
        while True:
            try:
                self.register()
                break
            except (AuthenticationError, PermissionDeniedError):
                raise
            except (*_TRANSIENT, GradAPIError) as exc:
                if isinstance(exc, GradAPIError) and not isinstance(exc, (ServerError, RateLimitError)):
                    raise
                log.warning("cannot register env worker yet: %s", exc)
                if self.stop.is_set():
                    return 0
                delay = self._backoff_wait(delay)

        beat = threading.Thread(target=self.heartbeat_loop, name="grad-env-heartbeat", daemon=True)
        beat.start()
        slots = threading.Semaphore(self.concurrency)
        pool = concurrent.futures.ThreadPoolExecutor(self.concurrency, thread_name_prefix="grad-env")
        claimed = 0
        delay = 0.5
        try:
            while not self.stop.is_set() and (self.max_tasks is None or claimed < self.max_tasks):
                if not slots.acquire(timeout=0.25):
                    continue
                started = self.clock.monotonic()
                try:
                    resp = self.wire.claim_env_task(
                        self.name,
                        {"worker_id": self.worker_id, "wait_ms": self.wait_ms},
                        timeout=self.wait_ms / 1000 + 30,
                    )
                except (AuthenticationError, PermissionDeniedError) as exc:
                    slots.release()
                    self.fatal = exc
                    break
                except NotFoundError:
                    slots.release()
                    try:
                        self.register()
                    except Exception as exc:
                        log.warning("re-register failed: %s", exc)
                    delay = self._backoff_wait(delay)
                    continue
                except (*_TRANSIENT, GradAPIError) as exc:
                    slots.release()
                    log.warning("claim failed: %s", exc)
                    delay = self._backoff_wait(delay)
                    continue
                delay = 0.5
                envelope = (resp or {}).get("task")
                if not envelope:
                    slots.release()
                    if self.clock.monotonic() - started < min(1.0, self.wait_ms / 1000 / 2):
                        self.stop.wait(0.25)  # the server answered early: don't spin
                    continue
                claimed += 1
                task_id = str(envelope["id"])
                future = pool.submit(self.run_task, envelope)
                with self._lock:
                    self._inflight[task_id] = future

                def done(_f: concurrent.futures.Future[None], tid: str = task_id) -> None:
                    with self._lock:
                        self._inflight.pop(tid, None)
                    slots.release()

                future.add_done_callback(done)
        finally:
            self.stop.set()
            self.drain(pool)
            beat.join(timeout=1.0)
        if self.fatal is not None:
            raise self.fatal
        return self.processed

    def drain(self, pool: concurrent.futures.ThreadPoolExecutor) -> None:
        with self._lock:
            pending = list(self._inflight.items())
        if pending:
            concurrent.futures.wait([f for _, f in pending], timeout=self.drain_timeout_s)
        with self._lock:
            left = [tid for tid, f in self._inflight.items() if not f.done()]
            self._abandoned.update(left)
        for tid in left:
            self.complete(tid, {"worker_id": self.worker_id, "score": None, "scores": {}, "error": "worker shut down before the rollout finished"})
        pool.shutdown(wait=False, cancel_futures=True)


def serve_environment(
    env: Any,
    *,
    name: str,
    policy: Policy | None,
    client: Grad | None = None,
    base_url: str | None = None,
    api_key: str | None = None,
    concurrency: int = 4,
    worker_id: str | None = None,
    wait_ms: int = 20_000,
    heartbeat_s: float = 20.0,
    max_tasks: int | None = None,
    stop_event: threading.Event | None = None,
    drain_timeout_s: float = 30.0,
    handle_signals: bool = True,
    max_backoff_s: float = 30.0,
) -> int:
    """Serve ``env`` to grad-server as worker pool ``name`` until stopped; returns tasks completed.

    Args:
        env: An :class:`Environment` instance, subclass (instantiated once) or factory.
        name: The environment name tasks are dispatched to.
        policy: Produces the model's turns: :class:`ChatCompletionsPolicy` or a function
            ``policy(messages, *, tools, model, task) -> str | assistant message``. Required.
        client: A configured :class:`grad.Grad` (default: built from ``base_url``/``api_key``
            and the usual environment variables).
        concurrency: Rollouts run in parallel (each gets its own ``setup`` handle).
        wait_ms: Long-poll duration of each claim.
        max_tasks: Stop after claiming this many tasks (for tests and batch jobs).
        stop_event: Set it to stop gracefully (in-flight rollouts drain).
        drain_timeout_s: On stop/SIGTERM, how long in-flight rollouts may finish; the rest
            are reported as errors so the server does not wait for their timeout.
        handle_signals: Install SIGTERM/SIGINT handlers (main thread only) for graceful drain.

    Transient network and server errors are retried with backoff; an invalid or revoked
    key (401/403) stops the worker with :class:`grad.AuthenticationError`.
    """
    if not isinstance(name, str) or not name.strip():
        raise ValueError("serve_environment needs name= (the environment name tasks are dispatched to).")
    if policy is None:
        raise ValueError(
            "serve_environment needs policy=: the function (or ChatCompletionsPolicy(base_url=..., api_key=...)) that "
            "produces the model's turns for each task's model_id. The worker never fabricates answers."
        )
    if not callable(policy):
        raise TypeError("policy must be callable: policy(messages, *, tools, model, task) -> str | dict.")
    if not 1 <= concurrency <= 512:
        raise ValueError("concurrency must be between 1 and 512.")
    environment = _instantiate(env)
    if isinstance(environment, ToolsEnvironment):
        environment.check_requirements()
    if environment.rubric is not None:
        environment.rubric.check_requirements()
    if client is None:
        from .client import Grad

        client = Grad(api_key=api_key, base_url=base_url)
    stop = stop_event or threading.Event()
    worker = _Worker(
        environment,
        name=name,
        policy=policy,
        client=client,
        worker_id=worker_id or f"env-{socket.gethostname()}-{os.getpid()}-{uuid.uuid4().hex[:6]}",
        concurrency=concurrency,
        wait_ms=wait_ms,
        heartbeat_s=heartbeat_s,
        max_tasks=max_tasks,
        stop=stop,
        drain_timeout_s=drain_timeout_s,
        max_backoff_s=max_backoff_s,
        clock=client._transport.clock,
    )
    previous: dict[signal.Signals, Any] = {}
    if handle_signals and threading.current_thread() is threading.main_thread():

        def on_signal(signum: int, _frame: Any) -> None:
            log.info("signal %s: draining environment worker", signum)
            stop.set()

        for sig in (signal.SIGTERM, signal.SIGINT):
            previous[sig] = signal.signal(sig, on_signal)
    try:
        return worker.serve()
    finally:
        for sig, handler in previous.items():
            signal.signal(sig, handler)
