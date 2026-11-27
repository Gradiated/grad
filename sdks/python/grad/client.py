"""Idiomatic Grad and AsyncGrad clients wrapping the generated OpenAPI wire client."""

from __future__ import annotations

import asyncio
import hashlib
import os
import re
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Sequence

from ._generated import AsyncGeneratedApiClient, GeneratedApiClient, GradApiError
from .recipes import coerce_recipe
from .rubrics import coerce_rubric
from .types import coerce_record

_HEX64_RE = re.compile(r"^[0-9a-f]{64}$")


@dataclass
class EvalFailures:
    """Failure slice returned by evals.failures(...) with one-call .to_dataset(...)."""

    eval_id: str
    items: list[dict[str, Any]]
    _client: "Grad"

    def to_dataset(self, name: str, *, metadata: dict[str, Any] | None = None) -> dict[str, Any]:
        records = [item["record"] for item in self.items if isinstance(item.get("record"), dict)]
        if not records:
            raise ValueError(f"Eval '{self.eval_id}' has zero failing records to export.")
        return self._client.datasets.push(
            name,
            records,
            metadata={"mined_from_eval": self.eval_id, **(metadata or {})},
        )


class _ModelsAPI:
    def __init__(self, wire: GeneratedApiClient) -> None:
        self._wire = wire

    def list(self) -> list[dict[str, Any]]:
        return list(self._wire.list_models().get("data", []))


class _DatasetsAPI:
    def __init__(self, wire: GeneratedApiClient) -> None:
        self._wire = wire

    def list(self) -> list[dict[str, Any]]:
        return list(self._wire.list_datasets().get("data", []))

    def get(self, name: str) -> dict[str, Any]:
        return self._wire.get_dataset(name)

    def push(
        self,
        name: str,
        records: Sequence[Any],
        *,
        metadata: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"records": [coerce_record(r) for r in records]}
        if metadata is not None:
            body["metadata"] = metadata
        return self._wire.push_dataset_records(name, body)

    def records(self, name: str, *, limit: int = 100, offset: int = 0) -> dict[str, Any]:
        return self._wire.list_dataset_records(name, limit=limit, offset=offset)

    def render(
        self,
        name: str,
        *,
        model: str = "qwen/qwen3-8b",
        train_on: str = "last",
        thinking: str = "auto",
        preserve_thinking: bool = False,
        limit: int = 3,
    ) -> dict[str, Any]:
        return self._wire.render_dataset(
            name,
            {
                "model": model,
                "train_on": train_on,
                "thinking": thinking,
                "preserve_thinking": preserve_thinking,
                "limit": limit,
            },
        )


class _RunsAPI:
    def __init__(self, wire: GeneratedApiClient) -> None:
        self._wire = wire

    def plan(
        self,
        dataset: str,
        *,
        name: str,
        recipe: Any,
        split: dict[str, Any] | None = None,
        max_cost_usd: float | None = None,
        rubric: Any | None = None,
    ) -> dict[str, Any]:
        # Dry-run any local Python scorer on a sample record before hitting the server.
        if rubric is not None:
            coerced = coerce_rubric(rubric)
            sample_slice = self._wire.list_dataset_records(dataset, limit=1, offset=0)
            sample_rows = sample_slice.get("data") or []
            if sample_rows:
                coerced.dry_run(sample_rows[0])

        body: dict[str, Any] = {
            "dataset": dataset,
            "name": name,
            "recipe": coerce_recipe(recipe),
        }
        if split is not None:
            body["split"] = split
        if max_cost_usd is not None:
            body["max_cost_usd"] = max_cost_usd
        return self._wire.plan_run(body)

    def create(
        self,
        dataset: str,
        *,
        name: str,
        recipe: Any,
        split: dict[str, Any] | None = None,
        max_cost_usd: float | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "dataset": dataset,
            "name": name,
            "recipe": coerce_recipe(recipe),
        }
        if split is not None:
            body["split"] = split
        if max_cost_usd is not None:
            body["max_cost_usd"] = max_cost_usd
        return self._wire.create_run(body)

    def list(self) -> list[dict[str, Any]]:
        return list(self._wire.list_runs().get("data", []))

    def get(self, run_id: str) -> dict[str, Any]:
        return self._wire.get_run(run_id)

    def metrics(self, run_id: str, *, after_step: int = -1) -> dict[str, Any]:
        return self._wire.list_run_metrics(run_id, after_step=after_step)

    def cancel(self, run_id: str) -> dict[str, Any]:
        return self._wire.cancel_run(run_id)

    def resume(self, run_id: str, *, max_cost_usd: float | None = None) -> dict[str, Any]:
        body = {"max_cost_usd": max_cost_usd} if max_cost_usd is not None else {}
        return self._wire.resume_run(run_id, body)

    def checkpoints(self, run_id: str) -> list[dict[str, Any]]:
        return list(self._wire.list_run_checkpoints(run_id).get("data", []))

    def wait(
        self, run_id: str, *, poll_s: float = 0.5, timeout_s: float = 3600.0
    ) -> dict[str, Any]:
        deadline = time.monotonic() + timeout_s
        while True:
            run = self.get(run_id)
            if run.get("status") in ("completed", "failed", "cancelled", "stopped_budget"):
                return run
            if time.monotonic() >= deadline:
                raise TimeoutError(f"Timed out waiting for run '{run_id}'.")
            time.sleep(poll_s)


class _CheckpointsAPI:
    def __init__(self, wire: GeneratedApiClient) -> None:
        self._wire = wire

    def promote(self, checkpoint_id: str, *, name: str | None = None) -> dict[str, Any]:
        body = {"name": name} if name is not None else {}
        return self._wire.promote_checkpoint(checkpoint_id, body)


class _ArtifactsAPI:
    def __init__(self, wire: GeneratedApiClient) -> None:
        self._wire = wire

    def list(self, *, name: str | None = None) -> list[dict[str, Any]]:
        return list(self._wire.list_artifacts(name=name).get("data", []))

    def get(self, reference: str) -> dict[str, Any]:
        return self._wire.get_artifact(reference)

    def download(
        self,
        reference: str,
        *,
        dest_path: str | Path | None = None,
        verify_checksum: bool = True,
    ) -> bytes:
        data, headers = self._wire.download_artifact(reference)
        expected_sha = headers.get("x-artifact-sha256", "").strip().lower()
        if verify_checksum:
            if not _HEX64_RE.match(expected_sha):
                raise ValueError(
                    "Artifact download missing valid X-Artifact-Sha256 header."
                )
            actual_sha = hashlib.sha256(data).hexdigest()
            if actual_sha != expected_sha:
                raise ValueError(
                    f"Artifact SHA-256 mismatch: expected {expected_sha}, got {actual_sha}."
                )
        if dest_path is not None:
            target = Path(dest_path)
            target.parent.mkdir(parents=True, exist_ok=True)
            fd, tmp_name = tempfile.mkstemp(dir=target.parent, prefix=".grad-dl-")
            try:
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                os.replace(tmp_name, target)
            except Exception:
                try:
                    os.unlink(tmp_name)
                except OSError:
                    pass
                raise
        return data


class _DeploymentsAPI:
    def __init__(self, wire: GeneratedApiClient) -> None:
        self._wire = wire

    def list(self) -> list[dict[str, Any]]:
        return list(self._wire.list_deployments().get("data", []))

    def get(self, name: str) -> dict[str, Any]:
        return self._wire.get_deployment(name)


class _EmbeddingsAPI:
    def __init__(self, wire: GeneratedApiClient) -> None:
        self._wire = wire

    def create(self, *, model: str, input: str | Sequence[str]) -> dict[str, Any]:
        payload_input: str | list[str] = (
            input if isinstance(input, str) else list(input)
        )
        return self._wire.create_embeddings({"model": model, "input": payload_input})


class _FeedbackAPI:
    def __init__(self, wire: GeneratedApiClient) -> None:
        self._wire = wire

    def record(
        self,
        *,
        idempotency_key: str,
        inference_id: str | None = None,
        session_id: str | None = None,
        deployment_name: str | None = None,
        score: float | None = None,
        expected_output: Any = None,
        metrics: dict[str, float] | None = None,
    ) -> dict[str, Any]:
        event: dict[str, Any] = {"idempotency_key": idempotency_key}
        if inference_id is not None:
            event["inference_id"] = inference_id
        if session_id is not None:
            event["session_id"] = session_id
        if deployment_name is not None:
            event["deployment_name"] = deployment_name
        if score is not None:
            event["score"] = score
        if expected_output is not None:
            event["expected_output"] = expected_output
        if metrics is not None:
            event["metrics"] = metrics
        return self._wire.record_feedback({"events": [event]})


class _EvalsAPI:
    def __init__(self, wire: GeneratedApiClient, parent: "Grad") -> None:
        self._wire = wire
        self._parent = parent

    def _build_body(
        self,
        *,
        models: Sequence[str],
        name: str = "eval-run",
        baseline: str | None = None,
        dataset: str | None = None,
        env: Any | None = None,
        tasks: Sequence[Any] | None = None,
        benchmarks: Sequence[dict[str, Any]] | None = None,
        rubric: Any | None = None,
        samples: int = 1,
        pass_threshold: float = 0.8,
        max_cost_usd: float | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {
            "name": name,
            "models": list(models),
            "samples": samples,
            "pass_threshold": pass_threshold,
        }
        if baseline is not None:
            body["baseline"] = baseline
        if dataset is not None:
            body["dataset"] = dataset
        if env is not None:
            body["env_name"] = env.name if hasattr(env, "name") else str(env)
        if tasks is not None:
            body["tasks"] = [coerce_record(t) for t in tasks]
        if benchmarks is not None:
            body["benchmarks"] = list(benchmarks)
        if rubric is not None:
            body["rubric"] = coerce_rubric(rubric).to_wire_items()
        if max_cost_usd is not None:
            body["max_cost_usd"] = max_cost_usd
        return body

    def plan(self, **kwargs: Any) -> dict[str, Any]:
        return self._wire.plan_eval(self._build_body(**kwargs))

    def create(self, **kwargs: Any) -> dict[str, Any]:
        return self._wire.create_eval(self._build_body(**kwargs))

    def list(self) -> list[dict[str, Any]]:
        return list(self._wire.list_evals().get("data", []))

    def get(self, eval_id: str) -> dict[str, Any]:
        return self._wire.get_eval(eval_id)

    def failures(
        self,
        eval_id: str,
        *,
        model: str | None = None,
        threshold: float = 0.8,
    ) -> EvalFailures:
        resp = self._wire.list_eval_failures(
            eval_id, model=model, threshold=threshold
        )
        return EvalFailures(
            eval_id=eval_id,
            items=list(resp.get("data", [])),
            _client=self._parent,
        )


class _KeysAPI:
    def __init__(self, wire: GeneratedApiClient) -> None:
        self._wire = wire

    def create(self, *, name: str, scopes: Sequence[str]) -> dict[str, Any]:
        return self._wire.create_api_key({"name": name, "scopes": list(scopes)})

    def list(self) -> list[dict[str, Any]]:
        return list(self._wire.list_api_keys().get("data", []))

    def revoke(self, key_id: str) -> dict[str, Any]:
        return self._wire.revoke_api_key(key_id)


class Grad:
    """Synchronous Gradiated SDK client."""

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout_s: float = 30.0,
    ) -> None:
        resolved_url = base_url or os.environ.get(
            "GRAD_BASE_URL", "http://127.0.0.1:8080"
        )
        resolved_key = api_key if api_key is not None else os.environ.get("GRAD_API_KEY")
        self.wire = GeneratedApiClient(
            base_url=resolved_url, api_key=resolved_key, timeout_s=timeout_s
        )
        self.models = _ModelsAPI(self.wire)
        self.datasets = _DatasetsAPI(self.wire)
        self.runs = _RunsAPI(self.wire)
        self.checkpoints = _CheckpointsAPI(self.wire)
        self.artifacts = _ArtifactsAPI(self.wire)
        self.deployments = _DeploymentsAPI(self.wire)
        self.embeddings = _EmbeddingsAPI(self.wire)
        self.feedback = _FeedbackAPI(self.wire)
        self.evals = _EvalsAPI(self.wire, self)
        self.keys = _KeysAPI(self.wire)

    def deploy(
        self,
        artifact: str,
        *,
        name: str | None = None,
        fallback: str | None = None,
        explore_rate: float = 0.0,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"artifact": artifact, "explore_rate": explore_rate}
        if name is not None:
            body["name"] = name
        if fallback is not None:
            body["fallback"] = fallback
        return self.wire.deploy_artifact(body)

    def route(
        self,
        deployment: str,
        messages: Sequence[dict[str, Any]],
        *,
        session_id: str | None = None,
        tools: Sequence[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"deployment": deployment, "messages": list(messages)}
        if session_id is not None:
            body["session_id"] = session_id
        if tools is not None:
            body["tools"] = list(tools)
        return self.wire.route_request(body)


class _AsyncNamespaceProxy:
    """Async façade delegating ergonomic methods onto asyncio.to_thread."""

    def __init__(self, target: Any) -> None:
        self._target = target

    def __getattr__(self, name: str) -> Any:
        attr = getattr(self._target, name)
        if not callable(attr):
            return attr

        async def _wrapped(*args: Any, **kwargs: Any) -> Any:
            return await asyncio.to_thread(attr, *args, **kwargs)

        return _wrapped


class AsyncGrad:
    """Async Gradiated SDK client with full ergonomic parity to Grad."""

    def __init__(
        self,
        *,
        base_url: str | None = None,
        api_key: str | None = None,
        timeout_s: float = 30.0,
    ) -> None:
        self._sync = Grad(base_url=base_url, api_key=api_key, timeout_s=timeout_s)
        self.wire = AsyncGeneratedApiClient(
            base_url=self._sync.wire.base_url,
            api_key=self._sync.wire.api_key,
            timeout_s=timeout_s,
        )
        self.models = _AsyncNamespaceProxy(self._sync.models)
        self.datasets = _AsyncNamespaceProxy(self._sync.datasets)
        self.runs = _AsyncNamespaceProxy(self._sync.runs)
        self.checkpoints = _AsyncNamespaceProxy(self._sync.checkpoints)
        self.artifacts = _AsyncNamespaceProxy(self._sync.artifacts)
        self.deployments = _AsyncNamespaceProxy(self._sync.deployments)
        self.embeddings = _AsyncNamespaceProxy(self._sync.embeddings)
        self.feedback = _AsyncNamespaceProxy(self._sync.feedback)
        self.evals = _AsyncNamespaceProxy(self._sync.evals)
        self.keys = _AsyncNamespaceProxy(self._sync.keys)

    async def deploy(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.deploy, *args, **kwargs)

    async def route(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.route, *args, **kwargs)


__all__ = ["AsyncGrad", "EvalFailures", "Grad", "GradApiError"]
