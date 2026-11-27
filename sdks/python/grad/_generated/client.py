# AUTO-GENERATED from spec/openapi.yaml by scripts/generate-sdks.mjs. DO NOT EDIT.
"""Generated low-level wire clients for the Gradiated Training & Serving API."""

from __future__ import annotations

import asyncio
import json
import urllib.error
import urllib.parse
import urllib.request
from typing import Any


class GradApiError(RuntimeError):
    """RFC 7807 problem+json error raised by grad-server."""

    def __init__(
        self,
        *,
        status: int,
        code: str = "api_error",
        title: str = "API Error",
        detail: str = "",
        request_id: str = "",
    ) -> None:
        super().__init__(f"[{status}] {code}: {detail or title}")
        self.status = status
        self.code = code
        self.title = title
        self.detail = detail
        self.request_id = request_id


class GeneratedApiClient:
    """Synchronous stdlib HTTP client generated from spec/openapi.yaml."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        timeout_s: float = 30.0,
    ) -> None:
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme not in ("http", "https"):
            raise ValueError(f"Unsupported base_url scheme: {parsed.scheme!r}")
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.timeout_s = timeout_s

    def _build_url(self, route_path: str, query: dict[str, Any] | None) -> str:
        url = f"{self.base_url}{route_path}"
        if query:
            filtered = {k: str(v) for k, v in query.items() if v is not None}
            if filtered:
                url = f"{url}?{urllib.parse.urlencode(filtered)}"
        return url

    def _send(
        self,
        method: str,
        route_path: str,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
    ) -> tuple[bytes, dict[str, str], int]:
        headers: dict[str, str] = {}
        if self.api_key:
            headers["Authorization"] = f"Bearer {self.api_key}"
        data: bytes | None = None
        if body is not None:
            headers["Content-Type"] = "application/json"
            data = json.dumps(body).encode("utf-8")

        req = urllib.request.Request(
            self._build_url(route_path, query),
            data=data,
            headers=headers,
            method=method,
        )
        try:
            with urllib.request.urlopen(req, timeout=self.timeout_s) as resp:
                resp_headers = {k.lower(): v for k, v in resp.headers.items()}
                return resp.read(), resp_headers, int(resp.status)
        except urllib.error.HTTPError as exc:
            with exc:
                raw = exc.read().decode("utf-8", errors="replace")
            try:
                problem = json.loads(raw)
            except Exception:
                problem = {"status": exc.code, "detail": raw}
            raise GradApiError(
                status=int(problem.get("status", exc.code)),
                code=str(problem.get("code", "api_error")),
                title=str(problem.get("title", "API Error")),
                detail=str(problem.get("detail", raw)),
                request_id=str(problem.get("request_id", "")),
            ) from exc

    def _request_json(
        self,
        method: str,
        route_path: str,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        raw, _, status = self._send(method, route_path, body=body, query=query)
        if status in (204, 205) or not raw.strip():
            return {}
        return json.loads(raw.decode("utf-8"))

    def _request_bytes(
        self,
        method: str,
        route_path: str,
        body: dict[str, Any] | None = None,
        query: dict[str, Any] | None = None,
    ) -> tuple[bytes, dict[str, str]]:
        raw, headers, _ = self._send(method, route_path, body=body, query=query)
        return raw, headers

    def cancel_eval(self, id: str) -> dict[str, Any]:
        """Cancel a queued, running or awaiting_scores evaluation"""
        _query = None
        return self._request_json("POST", f"/v1/evals/{urllib.parse.quote(id, safe='')}/cancel", body=None, query=_query)

    def cancel_run(self, id: str) -> dict[str, Any]:
        """Cancel a training run (a running attempt is stopped and billed)"""
        _query = None
        return self._request_json("POST", f"/v1/runs/{urllib.parse.quote(id, safe='')}/cancel", body=None, query=_query)

    def claim_env_task(self, name: str, body: dict[str, Any]) -> dict[str, Any]:
        """Long-poll for the next task assigned to a `grad env serve` worker"""
        _query = None
        return self._request_json("POST", f"/v1/env-workers/{urllib.parse.quote(name, safe='')}/claim", body=body, query=_query)

    def claim_trainer_job(self, body: dict[str, Any]) -> dict[str, Any]:
        """Claim the next queued train or import job (trainer:worker)"""
        _query = None
        return self._request_json("POST", f"/v1/trainer-jobs/claim", body=body, query=_query)

    def complete_env_task(self, id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Submit scored trajectory output for an environment task"""
        _query = None
        return self._request_json("POST", f"/v1/env-workers/tasks/{urllib.parse.quote(id, safe='')}/complete", body=body, query=_query)

    def complete_trainer_job(self, id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Finish a job attempt: publish its artifact, bill it, release the lease"""
        _query = None
        return self._request_json("POST", f"/v1/trainer-jobs/{urllib.parse.quote(id, safe='')}/complete", body=body, query=_query)

    def create_api_key(self, body: dict[str, Any]) -> dict[str, Any]:
        """Create a scoped workspace API key (trainer worker keys are platform config, not keys)"""
        _query = None
        return self._request_json("POST", f"/v1/keys", body=body, query=_query)

    def create_dataset(self, body: dict[str, Any]) -> dict[str, Any]:
        """Create an empty dataset"""
        _query = None
        return self._request_json("POST", f"/v1/datasets", body=body, query=_query)

    def create_dataset_import(self, name: str, body: dict[str, Any]) -> dict[str, Any]:
        """Import an uploaded file or a Hugging Face dataset into a dataset (async job)"""
        _query = None
        return self._request_json("POST", f"/v1/datasets/{urllib.parse.quote(name, safe='')}/imports", body=body, query=_query)

    def create_embeddings(self, body: dict[str, Any]) -> dict[str, Any]:
        """Generate embeddings from a deployed embedding artifact"""
        _query = None
        return self._request_json("POST", f"/v1/embeddings", body=body, query=_query)

    def create_eval(self, body: dict[str, Any]) -> dict[str, Any]:
        """Queue an evaluation across models on a pinned dataset version (executed by the server)"""
        _query = None
        return self._request_json("POST", f"/v1/evals", body=body, query=_query)

    def create_run(self, body: dict[str, Any]) -> dict[str, Any]:
        """Create and enqueue a training run (pins the dataset version)"""
        _query = None
        return self._request_json("POST", f"/v1/runs", body=body, query=_query)

    def create_trainer_upload(self, id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Get an upload URL for a checkpoint or artifact bundle"""
        _query = None
        return self._request_json("POST", f"/v1/trainer-jobs/{urllib.parse.quote(id, safe='')}/uploads", body=body, query=_query)

    def create_upload(self, body: dict[str, Any]) -> dict[str, Any]:
        """Get an upload URL for a file to import (PUT the bytes, then create an import)"""
        _query = None
        return self._request_json("POST", f"/v1/uploads", body=body, query=_query)

    def deploy_artifact(self, body: dict[str, Any]) -> dict[str, Any]:
        """Deploy or update an artifact under a stable model name"""
        _query = None
        return self._request_json("POST", f"/v1/deployments", body=body, query=_query)

    def dispatch_env_task(self, body: dict[str, Any]) -> dict[str, Any]:
        """Dispatch an evaluation or rollout task to a connected `grad env serve` worker"""
        _query = None
        return self._request_json("POST", f"/v1/env-workers/tasks", body=body, query=_query)

    def download_artifact(self, id: str) -> tuple[bytes, dict[str, str]]:
        """Download an artifact bundle (.grad.tar.gz); verify X-Artifact-Sha256"""
        _query = None
        return self._request_bytes("GET", f"/v1/artifacts/{urllib.parse.quote(id, safe='')}/download", body=None, query=_query)

    def download_trainer_dataset(self, id: str, *, attempt: Any = None) -> dict[str, Any]:
        """Stream the pinned dataset version of a claimed train job as JSONL"""
        _query = {"attempt": attempt}
        return self._request_json("GET", f"/v1/trainer-jobs/{urllib.parse.quote(id, safe='')}/dataset", body=None, query=_query)

    def get_artifact(self, id: str) -> dict[str, Any]:
        """Get an artifact by id or name@latest"""
        _query = None
        return self._request_json("GET", f"/v1/artifacts/{urllib.parse.quote(id, safe='')}", body=None, query=_query)

    def get_dataset(self, name: str) -> dict[str, Any]:
        """Get a dataset by name"""
        _query = None
        return self._request_json("GET", f"/v1/datasets/{urllib.parse.quote(name, safe='')}", body=None, query=_query)

    def get_deployment(self, name: str) -> dict[str, Any]:
        """Get deployment status and feedback summary"""
        _query = None
        return self._request_json("GET", f"/v1/deployments/{urllib.parse.quote(name, safe='')}", body=None, query=_query)

    def get_env_task(self, id: str) -> dict[str, Any]:
        """Inspect an environment task and its result"""
        _query = None
        return self._request_json("GET", f"/v1/env-workers/tasks/{urllib.parse.quote(id, safe='')}", body=None, query=_query)

    def get_eval(self, id: str) -> dict[str, Any]:
        """Get an evaluation run by ID"""
        _query = None
        return self._request_json("GET", f"/v1/evals/{urllib.parse.quote(id, safe='')}", body=None, query=_query)

    def get_import(self, id: str) -> dict[str, Any]:
        """Get a dataset import job"""
        _query = None
        return self._request_json("GET", f"/v1/imports/{urllib.parse.quote(id, safe='')}", body=None, query=_query)

    def get_run(self, id: str) -> dict[str, Any]:
        """Get a training run"""
        _query = None
        return self._request_json("GET", f"/v1/runs/{urllib.parse.quote(id, safe='')}", body=None, query=_query)

    def get_trainer_queue_stats(self) -> dict[str, Any]:
        """Queue depth for autoscaling: queued plus running jobs (trainer:worker)"""
        _query = None
        return self._request_json("GET", f"/v1/trainer-jobs/queue", body=None, query=_query)

    def heartbeat_trainer_job(self, id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Renew the job lease; reports whether the worker should stop"""
        _query = None
        return self._request_json("POST", f"/v1/trainer-jobs/{urllib.parse.quote(id, safe='')}/heartbeat", body=body, query=_query)

    def list_api_keys(self, *, limit: Any = None, cursor: Any = None) -> dict[str, Any]:
        """List workspace API keys"""
        _query = {"limit": limit, "cursor": cursor}
        return self._request_json("GET", f"/v1/keys", body=None, query=_query)

    def list_artifacts(self, *, limit: Any = None, cursor: Any = None, name: Any = None) -> dict[str, Any]:
        """List immutable artifacts (newest first)"""
        _query = {"limit": limit, "cursor": cursor, "name": name}
        return self._request_json("GET", f"/v1/artifacts", body=None, query=_query)

    def list_dataset_records(self, name: str, *, version: Any = None, limit: Any = None, cursor: Any = None) -> dict[str, Any]:
        """Read records of a dataset version"""
        _query = {"version": version, "limit": limit, "cursor": cursor}
        return self._request_json("GET", f"/v1/datasets/{urllib.parse.quote(name, safe='')}/records", body=None, query=_query)

    def list_datasets(self, *, limit: Any = None, cursor: Any = None) -> dict[str, Any]:
        """List datasets (newest first)"""
        _query = {"limit": limit, "cursor": cursor}
        return self._request_json("GET", f"/v1/datasets", body=None, query=_query)

    def list_deployments(self, *, limit: Any = None, cursor: Any = None) -> dict[str, Any]:
        """List deployments"""
        _query = {"limit": limit, "cursor": cursor}
        return self._request_json("GET", f"/v1/deployments", body=None, query=_query)

    def list_eval_failures(self, id: str, *, limit: Any = None, cursor: Any = None, model: Any = None, threshold: Any = None) -> dict[str, Any]:
        """List failing task records from an evaluation run for mining"""
        _query = {"limit": limit, "cursor": cursor, "model": model, "threshold": threshold}
        return self._request_json("GET", f"/v1/evals/{urllib.parse.quote(id, safe='')}/failures", body=None, query=_query)

    def list_eval_outputs(self, id: str, *, limit: Any = None, cursor: Any = None, model: Any = None, missing_scorer: Any = None) -> dict[str, Any]:
        """Page through generated model outputs (filter by model or by a code scorer that still needs a score)"""
        _query = {"limit": limit, "cursor": cursor, "model": model, "missing_scorer": missing_scorer}
        return self._request_json("GET", f"/v1/evals/{urllib.parse.quote(id, safe='')}/outputs", body=None, query=_query)

    def list_eval_results(self, id: str, *, limit: Any = None, cursor: Any = None, model: Any = None) -> dict[str, Any]:
        """Per-task, per-model results of a completed evaluation"""
        _query = {"limit": limit, "cursor": cursor, "model": model}
        return self._request_json("GET", f"/v1/evals/{urllib.parse.quote(id, safe='')}/results", body=None, query=_query)

    def list_evals(self, *, limit: Any = None, cursor: Any = None) -> dict[str, Any]:
        """List evaluation runs"""
        _query = {"limit": limit, "cursor": cursor}
        return self._request_json("GET", f"/v1/evals", body=None, query=_query)

    def list_imports(self, *, limit: Any = None, cursor: Any = None) -> dict[str, Any]:
        """List dataset import jobs (newest first)"""
        _query = {"limit": limit, "cursor": cursor}
        return self._request_json("GET", f"/v1/imports", body=None, query=_query)

    def list_models(self) -> dict[str, Any]:
        """List trainable base models (the server catalog and price source)"""
        _query = None
        return self._request_json("GET", f"/v1/models", body=None, query=_query)

    def list_run_checkpoints(self, id: str, *, limit: Any = None, cursor: Any = None) -> dict[str, Any]:
        """List unexpired checkpoints of a run (best and final never expire)"""
        _query = {"limit": limit, "cursor": cursor}
        return self._request_json("GET", f"/v1/runs/{urllib.parse.quote(id, safe='')}/checkpoints", body=None, query=_query)

    def list_run_metrics(self, id: str, *, cursor: Any = None, after_step: Any = None, limit: Any = None) -> dict[str, Any]:
        """Training step metrics as JSON pages, or a live SSE stream"""
        _query = {"cursor": cursor, "after_step": after_step, "limit": limit}
        return self._request_json("GET", f"/v1/runs/{urllib.parse.quote(id, safe='')}/metrics", body=None, query=_query)

    def list_runs(self, *, limit: Any = None, cursor: Any = None) -> dict[str, Any]:
        """List training runs (newest first)"""
        _query = {"limit": limit, "cursor": cursor}
        return self._request_json("GET", f"/v1/runs", body=None, query=_query)

    def plan_eval(self, body: dict[str, Any]) -> dict[str, Any]:
        """Estimate tasks, model/judge calls, and cost before running an eval"""
        _query = None
        return self._request_json("POST", f"/v1/evals/plan", body=body, query=_query)

    def plan_run(self, body: dict[str, Any]) -> dict[str, Any]:
        """Dry-run a training recipe at zero cost"""
        _query = None
        return self._request_json("POST", f"/v1/runs/plan", body=body, query=_query)

    def post_eval_scores(self, id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Post scores computed by local (SDK-side) code scorers; the eval completes when none are missing"""
        _query = None
        return self._request_json("POST", f"/v1/evals/{urllib.parse.quote(id, safe='')}/scores", body=body, query=_query)

    def post_import_records(self, id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Append a batch of parsed records to an import job"""
        _query = None
        return self._request_json("POST", f"/v1/trainer-jobs/{urllib.parse.quote(id, safe='')}/records", body=body, query=_query)

    def promote_checkpoint(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """Copy an exportable checkpoint into a new immutable artifact"""
        _query = None
        return self._request_json("POST", f"/v1/checkpoints/{urllib.parse.quote(id, safe='')}/promote", body=body, query=_query)

    def push_dataset_records(self, name: str, body: dict[str, Any]) -> dict[str, Any]:
        """Append records as a new dataset version (creates the dataset if needed)"""
        _query = None
        return self._request_json("POST", f"/v1/datasets/{urllib.parse.quote(name, safe='')}/records", body=body, query=_query)

    def record_feedback(self, body: dict[str, Any]) -> dict[str, Any]:
        """Record deduplicated outcome scores and gold corrections"""
        _query = None
        return self._request_json("POST", f"/v1/feedback", body=body, query=_query)

    def register_env_worker(self, body: dict[str, Any]) -> dict[str, Any]:
        """Register or heartbeat an outbound `grad env serve` worker"""
        _query = None
        return self._request_json("POST", f"/v1/env-workers/register", body=body, query=_query)

    def register_trainer_checkpoint(self, id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Register an uploaded checkpoint bundle"""
        _query = None
        return self._request_json("POST", f"/v1/trainer-jobs/{urllib.parse.quote(id, safe='')}/checkpoints", body=body, query=_query)

    def render_dataset(self, name: str, body: dict[str, Any]) -> dict[str, Any]:
        """Preview chat-template rendering and loss masks (estimated token counts)"""
        _query = None
        return self._request_json("POST", f"/v1/datasets/{urllib.parse.quote(name, safe='')}/render", body=body, query=_query)

    def report_trainer_progress(self, id: str, body: dict[str, Any]) -> dict[str, Any]:
        """Report one training step's metrics"""
        _query = None
        return self._request_json("POST", f"/v1/trainer-jobs/{urllib.parse.quote(id, safe='')}/progress", body=body, query=_query)

    def resume_run(self, id: str, body: dict[str, Any] | None = None) -> dict[str, Any]:
        """Resume a stopped, failed or cancelled run from its latest checkpoint"""
        _query = None
        return self._request_json("POST", f"/v1/runs/{urllib.parse.quote(id, safe='')}/resume", body=body, query=_query)

    def revoke_api_key(self, id: str) -> dict[str, Any]:
        """Revoke a workspace API key"""
        _query = None
        return self._request_json("DELETE", f"/v1/keys/{urllib.parse.quote(id, safe='')}", body=None, query=_query)

    def rollback_deployment(self, name: str) -> dict[str, Any]:
        """Roll a deployment back to its previous artifact"""
        _query = None
        return self._request_json("POST", f"/v1/deployments/{urllib.parse.quote(name, safe='')}/rollback", body=None, query=_query)

    def route_request(self, body: dict[str, Any]) -> dict[str, Any]:
        """Ask a deployed model router which model to call"""
        _query = None
        return self._request_json("POST", f"/v1/route", body=body, query=_query)


class AsyncGeneratedApiClient:
    """Async wrapper over GeneratedApiClient using asyncio.to_thread."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None = None,
        timeout_s: float = 30.0,
    ) -> None:
        self._sync = GeneratedApiClient(
            base_url=base_url, api_key=api_key, timeout_s=timeout_s
        )

    async def cancel_eval(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.cancel_eval, *args, **kwargs)

    async def cancel_run(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.cancel_run, *args, **kwargs)

    async def claim_env_task(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.claim_env_task, *args, **kwargs)

    async def claim_trainer_job(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.claim_trainer_job, *args, **kwargs)

    async def complete_env_task(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.complete_env_task, *args, **kwargs)

    async def complete_trainer_job(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.complete_trainer_job, *args, **kwargs)

    async def create_api_key(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.create_api_key, *args, **kwargs)

    async def create_dataset(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.create_dataset, *args, **kwargs)

    async def create_dataset_import(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.create_dataset_import, *args, **kwargs)

    async def create_embeddings(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.create_embeddings, *args, **kwargs)

    async def create_eval(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.create_eval, *args, **kwargs)

    async def create_run(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.create_run, *args, **kwargs)

    async def create_trainer_upload(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.create_trainer_upload, *args, **kwargs)

    async def create_upload(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.create_upload, *args, **kwargs)

    async def deploy_artifact(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.deploy_artifact, *args, **kwargs)

    async def dispatch_env_task(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.dispatch_env_task, *args, **kwargs)

    async def download_artifact(self, *args: Any, **kwargs: Any) -> tuple[bytes, dict[str, str]]:
        return await asyncio.to_thread(self._sync.download_artifact, *args, **kwargs)

    async def download_trainer_dataset(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.download_trainer_dataset, *args, **kwargs)

    async def get_artifact(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_artifact, *args, **kwargs)

    async def get_dataset(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_dataset, *args, **kwargs)

    async def get_deployment(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_deployment, *args, **kwargs)

    async def get_env_task(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_env_task, *args, **kwargs)

    async def get_eval(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_eval, *args, **kwargs)

    async def get_import(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_import, *args, **kwargs)

    async def get_run(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_run, *args, **kwargs)

    async def get_trainer_queue_stats(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.get_trainer_queue_stats, *args, **kwargs)

    async def heartbeat_trainer_job(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.heartbeat_trainer_job, *args, **kwargs)

    async def list_api_keys(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.list_api_keys, *args, **kwargs)

    async def list_artifacts(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.list_artifacts, *args, **kwargs)

    async def list_dataset_records(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.list_dataset_records, *args, **kwargs)

    async def list_datasets(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.list_datasets, *args, **kwargs)

    async def list_deployments(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.list_deployments, *args, **kwargs)

    async def list_eval_failures(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.list_eval_failures, *args, **kwargs)

    async def list_eval_outputs(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.list_eval_outputs, *args, **kwargs)

    async def list_eval_results(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.list_eval_results, *args, **kwargs)

    async def list_evals(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.list_evals, *args, **kwargs)

    async def list_imports(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.list_imports, *args, **kwargs)

    async def list_models(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.list_models, *args, **kwargs)

    async def list_run_checkpoints(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.list_run_checkpoints, *args, **kwargs)

    async def list_run_metrics(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.list_run_metrics, *args, **kwargs)

    async def list_runs(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.list_runs, *args, **kwargs)

    async def plan_eval(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.plan_eval, *args, **kwargs)

    async def plan_run(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.plan_run, *args, **kwargs)

    async def post_eval_scores(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.post_eval_scores, *args, **kwargs)

    async def post_import_records(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.post_import_records, *args, **kwargs)

    async def promote_checkpoint(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.promote_checkpoint, *args, **kwargs)

    async def push_dataset_records(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.push_dataset_records, *args, **kwargs)

    async def record_feedback(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.record_feedback, *args, **kwargs)

    async def register_env_worker(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.register_env_worker, *args, **kwargs)

    async def register_trainer_checkpoint(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.register_trainer_checkpoint, *args, **kwargs)

    async def render_dataset(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.render_dataset, *args, **kwargs)

    async def report_trainer_progress(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.report_trainer_progress, *args, **kwargs)

    async def resume_run(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.resume_run, *args, **kwargs)

    async def revoke_api_key(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.revoke_api_key, *args, **kwargs)

    async def rollback_deployment(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.rollback_deployment, *args, **kwargs)

    async def route_request(self, *args: Any, **kwargs: Any) -> dict[str, Any]:
        return await asyncio.to_thread(self._sync.route_request, *args, **kwargs)
