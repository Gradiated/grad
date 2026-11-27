"""asyncio resource namespaces of :class:`grad.AsyncGrad`. Same API as the blocking ones,
with coroutine methods; waits use ``asyncio.sleep`` and network I/O never blocks a thread."""

from __future__ import annotations

import builtins
import typing
import asyncio
import json
import os
import shutil
import tempfile
from collections.abc import AsyncIterator, Awaitable, Callable, Iterable, Mapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

from . import _helpers as h
from ._errors import (
    APIConnectionError,
    EvalFailedError,
    GradAPIError,
    ImportFailedError,
    NotAvailableInV0Error,
    NotFoundError,
    ValidationError,
    WaitTimeoutError,
)
from ._http import TransportFailure
from ._models import (
    ApiKey,
    AsyncArtifact,
    AsyncCheckpoint,
    AsyncDataset,
    AsyncDeployment,
    AsyncDeploymentStatus,
    AsyncEval,
    AsyncEvalFailures,
    AsyncImportJob,
    AsyncPage,
    CursorTrail,
    AsyncPager,
    AsyncRun,
    CreatedApiKey,
    Embeddings,
    EvalOutput,
    EvalPlan,
    EvalResult,
    FeedbackResult,
    MetricPoint,
    Model,
    Plan,
    RenderPreview,
    TERMINAL_EVAL_STATUSES,
    TERMINAL_IMPORT_STATUSES,
    TERMINAL_RUN_STATUSES,
)
from ._resources import MAX_SSE_RECONNECTS, SSE_READ_TIMEOUT, TRANSIENT, _eval_kwargs
from ._transport import SSEDecoder, aiter_sse, quote_path_param
from .rubrics import model_ref

if TYPE_CHECKING:
    from .client import AsyncGrad


class _AsyncResource:
    def __init__(self, client: AsyncGrad) -> None:
        self._client = client
        self._wire = client.wire

    @property
    def _clock(self) -> Any:
        return self._client._transport.clock

    def _deadline(self, timeout: float | None) -> float | None:
        return None if timeout is None else self._clock.monotonic() + timeout

    def _expired(self, deadline: float | None) -> bool:
        return deadline is not None and self._clock.monotonic() >= deadline

    async def _sleep(self, seconds: float, deadline: float | None) -> None:
        if deadline is not None:
            seconds = max(0.0, min(seconds, deadline - self._clock.monotonic()))
        await self._clock.async_sleep(seconds)

    def _pager(self, cls: Any, fetch: Callable[[str | None], Any]) -> AsyncPager[Any]:
        def first() -> Awaitable[AsyncPage[Any]]:
            trail = CursorTrail(f"list of {cls.__name__} objects")

            async def page(cursor: str | None) -> AsyncPage[Any]:
                data = await fetch(cursor)
                return AsyncPage(
                    [cls.from_api(item, self._client) for item in data.get("data") or []],
                    data.get("next_cursor"),
                    page,
                    trail=trail,
                )

            return page(None)

        return AsyncPager(first)


class AsyncModels(_AsyncResource):
    """``client.models``: the trainable base-model catalog."""

    async def list(self) -> list[Model]:
        """Every trainable base model."""
        return [Model.from_api(m, self._client) for m in (await self._wire.list_models()).get("data") or []]

    async def get(self, model_id: str) -> Model:
        """One catalog model; raises :class:`grad.NotFoundError` if absent."""
        for model in await self.list():
            if model.id == model_id:
                return model
        raise NotFoundError(
            status=404,
            code="model_not_found",
            title="Model not found",
            detail=f"Model {model_id!r} is not in this server's catalog (see client.models.list()).",
            request_id=None,
            method="GET",
            url=self._client._transport.url("/v1/models"),
        )


class AsyncDatasets(_AsyncResource):
    """``client.datasets`` (async)."""

    async def create(self, name: str, *, metadata: Mapping[str, Any] | None = None) -> AsyncDataset:
        """Create an empty dataset."""
        body: dict[str, Any] = {"name": h.check_slug(name, "dataset name")}
        if metadata is not None:
            body["metadata"] = dict(metadata)
        return AsyncDataset.from_api(await self._wire.create_dataset(body), self._client)

    async def get(self, name: Any) -> AsyncDataset:
        """A dataset by name."""
        return AsyncDataset.from_api(await self._wire.get_dataset(h.dataset_name(name)), self._client)

    def list(self, *, limit: int | None = None) -> AsyncPager[AsyncDataset]:
        """Datasets, newest first (``await`` for a page, ``async for`` for all)."""
        return self._pager(AsyncDataset, lambda cursor: self._wire.list_datasets(limit=limit, cursor=cursor))

    async def count(self, dataset: Any) -> int:
        """Record count of the latest version."""
        return (await self.get(dataset)).record_count

    async def push(
        self,
        name: str,
        records: Iterable[Any] | str | os.PathLike[str],
        *,
        metadata: Mapping[str, Any] | None = None,
        chunk_size: int = h.DEFAULT_CHUNK_RECORDS,
        connector: str = "auto",
        format: str = "auto",
        timeout: float | None = None,
    ) -> AsyncDataset:
        """Append records or a file (see :meth:`grad.Grad.datasets.push`)."""
        h.check_slug(name, "dataset name")
        if h.is_path_like(records):
            job = await self.import_file(name, records, connector=connector, format=format)  # type: ignore[arg-type]
            await job.wait(timeout=timeout)
            return await self.get(name)
        if isinstance(records, (str, bytes, Mapping)):
            raise TypeError(
                "push() takes a list/iterable of records or a path to a .jsonl/.json/.parquet file; "
                f"{records!r:.60} is neither (does the file exist?)."
            )
        result: AsyncDataset | None = None
        first = True
        for offset, chunk in h.chunk_records(typing.cast(Iterable[Any], records), max_records=chunk_size):
            body: dict[str, Any] = {"records": chunk}
            if metadata is not None and first:
                body["metadata"] = dict(metadata)
            try:
                result = AsyncDataset.from_api(await self._wire.push_dataset_records(name, body), self._client)
            except ValidationError as exc:
                raise h.renumber_validation(exc, offset, len(chunk)) from None
            first = False
        if result is None:
            raise ValueError("push() got no records; pass at least one record (or create an empty dataset with datasets.create).")
        return result

    async def import_file(self, name: str, path: str | os.PathLike[str], *, connector: str = "auto", format: str = "auto") -> AsyncImportJob:
        """Upload a local file and start a server-side import job."""
        file_path = Path(path).expanduser()
        h.check_slug(name, "dataset name")
        h.check_connector(connector)
        fmt = h.file_format(file_path, format)
        request = await asyncio.to_thread(h.upload_request, file_path)
        ticket = await self._wire.create_upload(request)
        with open(file_path, "rb") as fh:
            await self._client._transport.upload(
                ticket["url"],
                fh,
                length=file_path.stat().st_size,
                headers=ticket.get("headers") or {},
                method=ticket.get("method") or "PUT",
                timeout=max(self._client._transport.timeout, 300.0),
            )
        source = {"kind": "upload", "upload_id": ticket["upload_id"], "format": fmt}
        return AsyncImportJob.from_api(await self._wire.create_dataset_import(name, {"source": source, "connector": connector}), self._client)

    async def from_hf(
        self,
        repo: str,
        *,
        split: str = "train",
        config: str | None = None,
        subset: str | None = None,
        revision: str | None = None,
        columns: Mapping[str, str] | None = None,
        messages: str | None = None,
        prompt: str | None = None,
        completion: str | None = None,
        answer: str | None = None,
        chosen: str | None = None,
        rejected: str | None = None,
        query: str | None = None,
        positive: str | None = None,
        limit: int | None = None,
        name: str | None = None,
        connector: str = "auto",
        wait: bool = True,
        timeout: float | None = None,
    ) -> AsyncDataset:
        """Import a Hugging Face dataset server-side (see the blocking client)."""
        if subset is not None and config is not None and subset != config:
            raise ValueError("Pass either config= or subset= (they are the same setting).")
        cfg = config if config is not None else subset
        source = h.hf_source(
            repo,
            split=split,
            config=cfg,
            revision=revision,
            columns=columns,
            column_kwargs={
                "messages": messages,
                "prompt": prompt,
                "completion": completion,
                "answer": answer,
                "chosen": chosen,
                "rejected": rejected,
                "query": query,
                "positive": positive,
            },
            limit=limit,
        )
        ds_name = h.check_slug(name or h.hf_dataset_name(repo, split, cfg), "dataset name")
        job = AsyncImportJob.from_api(
            await self._wire.create_dataset_import(ds_name, {"source": source, "connector": h.check_connector(connector)}),
            self._client,
        )
        if wait:
            await job.wait(timeout=timeout)
        return await self.get(ds_name)

    async def records(self, name: Any, *, version: int | None = None, limit: int | None = None) -> AsyncIterator[dict[str, Any]]:
        """Iterate the records of a version (``async for``)."""
        ds = h.dataset_name(name)
        trail = CursorTrail(f"GET /v1/datasets/{ds}/records")
        cursor: str | None = None
        while True:
            page = await self._wire.list_dataset_records(ds, version=version, limit=limit, cursor=cursor)
            for record in typing.cast(builtins.list[dict[str, Any]], page.get("data") or []):
                yield record
            cursor = trail.follow(page.get("next_cursor"), page.get("data") or [])
            if cursor is None:
                return

    async def render(
        self,
        dataset: Any,
        *,
        model: Any = None,
        train_on: str | None = None,
        thinking: Any = None,
        preserve_thinking: bool | None = None,
        limit: int | None = None,
    ) -> RenderPreview:
        """Preview chat-template rendering and trained tokens."""
        body: dict[str, Any] = {}
        if model is not None:
            body["model"] = model_ref(model)
        if train_on is not None:
            body["train_on"] = train_on
        if thinking is not None:
            body["thinking"] = {"on": True, "off": False}.get(thinking, thinking) if isinstance(thinking, str) else thinking
        if preserve_thinking is not None:
            body["preserve_thinking"] = preserve_thinking
        if limit is not None:
            body["limit"] = limit
        return RenderPreview.from_api(await self._wire.render_dataset(h.dataset_name(dataset), body), self._client)


class AsyncImports(_AsyncResource):
    """``client.imports`` (async)."""

    async def get(self, import_id: str) -> AsyncImportJob:
        """An import job."""
        return AsyncImportJob.from_api(await self._wire.get_import(import_id), self._client)

    def list(self, *, limit: int | None = None) -> AsyncPager[AsyncImportJob]:
        """Import jobs, newest first."""
        return self._pager(AsyncImportJob, lambda cursor: self._wire.list_imports(limit=limit, cursor=cursor))

    async def wait(self, import_id: str, *, timeout: float | None = None, poll_interval: float = 0.5) -> AsyncImportJob:
        """Wait until the import finishes; :class:`grad.ImportFailedError` if it failed."""
        deadline = self._deadline(timeout)
        backoff = h.Backoff(poll_interval)
        while True:
            try:
                job: AsyncImportJob | None = await self.get(import_id)
            except TRANSIENT:
                job = None
            if job is not None and job.status in TERMINAL_IMPORT_STATUSES:
                if job.status == "failed":
                    raise ImportFailedError(f"Import {job.id} into '{job.dataset}' failed: {job.error}", resource=job, error=job.error)
                return job
            if self._expired(deadline):
                status = job.status if job is not None else "unknown"
                raise WaitTimeoutError(f"Import {import_id} is still {status} after {timeout}s (is a trainer worker running?).", resource=job)
            await self._sleep(backoff.next(), deadline)


class AsyncRuns(_AsyncResource):
    """``client.runs`` (async)."""

    async def plan(self, dataset: Any = None, *, name: str, recipe: Any, split: Any = None, max_cost_usd: float | None = None) -> Plan:
        """Dry-run a recipe at $0."""
        body = h.run_body(dataset=dataset, name=name, recipe=recipe, split=split, max_cost_usd=max_cost_usd)
        plan = Plan.from_api(await self._wire.plan_run(body), self._client)
        plan.max_cost_usd = max_cost_usd
        return plan

    async def create(self, dataset: Any = None, *, name: str, recipe: Any, split: Any = None, max_cost_usd: float | None = None) -> AsyncRun:
        """Create and enqueue a run; ``await run.wait()``."""
        body = h.run_body(dataset=dataset, name=name, recipe=recipe, split=split, max_cost_usd=max_cost_usd)
        return AsyncRun.from_api(await self._wire.create_run(body), self._client)

    async def get(self, run_id: str) -> AsyncRun:
        """A run by id."""
        return AsyncRun.from_api(await self._wire.get_run(run_id), self._client)

    def list(self, *, limit: int | None = None) -> AsyncPager[AsyncRun]:
        """Runs, newest first."""
        return self._pager(AsyncRun, lambda cursor: self._wire.list_runs(limit=limit, cursor=cursor))

    async def cancel(self, run_id: str) -> AsyncRun:
        """Cancel a queued or running run."""
        return AsyncRun.from_api(await self._wire.cancel_run(run_id), self._client)

    async def resume(self, run_id: str, *, max_cost_usd: float | None = None) -> AsyncRun:
        """Resume from the latest checkpoint."""
        body = {} if max_cost_usd is None else {"max_cost_usd": max_cost_usd}
        return AsyncRun.from_api(await self._wire.resume_run(run_id, body), self._client)

    async def checkpoints(self, run_id: str) -> builtins.list[AsyncCheckpoint]:
        """Unexpired checkpoints, oldest step first."""
        items = await self._pager(AsyncCheckpoint, lambda cursor: self._wire.list_run_checkpoints(run_id, cursor=cursor)).to_list()
        return sorted(items, key=lambda c: (c.step, c.attempt or 0))

    async def metrics(self, run_id: str, *, follow: bool = False, after_step: int | None = None) -> AsyncIterator[MetricPoint]:
        """Metric points (``async for``); ``follow=True`` streams live until the run finishes."""
        if follow:
            async for kind, event in self._follow(run_id, None):
                if kind == "metric" and (after_step is None or event.step > after_step):
                    yield event
            return
        trail = CursorTrail(f"GET /v1/runs/{run_id}/metrics")
        cursor: str | None = None
        while True:
            page = await self._wire.list_run_metrics(run_id, cursor=cursor, after_step=after_step)
            data = page.get("data") or []
            for point in data:
                yield MetricPoint.from_api(point, self._client)
            nxt = trail.follow(page.get("next_cursor"), data)
            if nxt is None:
                return
            cursor = nxt

    async def _follow(self, run_id: str, deadline: float | None) -> AsyncIterator[tuple[str, Any]]:
        last_seq: int | None = None
        failures = 0
        retry_ms = 1000
        path = f"/v1/runs/{quote_path_param(run_id, 'id')}/metrics"
        while True:
            headers = {"Last-Event-ID": str(last_seq)} if last_seq is not None else None
            try:
                resp = await self._client._transport.stream("GET", path, accept="text/event-stream", headers=headers, timeout=SSE_READ_TIMEOUT)
            except TRANSIENT as exc:
                failures += 1
                if failures > MAX_SSE_RECONNECTS:
                    raise exc
                if self._expired(deadline):
                    return
                await self._sleep(min(10.0, retry_ms / 1000 * failures), deadline)
                continue
            if "text/event-stream" not in resp.headers.get("content-type", ""):
                await resp.aclose()
                async for item in self._poll_follow(run_id, deadline, last_seq):
                    yield item
                return
            try:
                async for event in aiter_sse(self._lines_until(resp, deadline), SSEDecoder()):
                    if event.retry is not None:
                        retry_ms = event.retry
                    if event.event == "metric":
                        point = MetricPoint.from_api(json.loads(event.data), self._client)
                        seq = point.seq if point.seq is not None else (int(event.id) if event.id and event.id.isdigit() else None)
                        if seq is not None and last_seq is not None and seq <= last_seq:
                            continue
                        if seq is not None:
                            last_seq = seq
                        failures = 0
                        yield "metric", point
                    elif event.event == "status":
                        yield "status", AsyncRun.from_api(json.loads(event.data), self._client)
                        return
            except (TransportFailure, APIConnectionError):
                pass
            finally:
                await resp.aclose()
            if self._expired(deadline):
                return
            failures += 1
            if failures > MAX_SSE_RECONNECTS:
                raise APIConnectionError(
                    f"Lost the metrics stream for run {run_id} {failures} times in a row.",
                    method="GET",
                    url=self._client._transport.url(path),
                )
            await self._sleep(min(10.0, retry_ms / 1000 * failures), deadline)

    async def _lines_until(self, resp: Any, deadline: float | None) -> AsyncIterator[str]:
        async for line in resp.aiter_lines():
            yield line
            if self._expired(deadline):
                return

    async def _poll_follow(self, run_id: str, deadline: float | None, last_seq: int | None) -> AsyncIterator[tuple[str, Any]]:
        cursor: str | None = None
        backoff = h.Backoff()
        while True:
            try:
                page = await self._wire.list_run_metrics(run_id, cursor=cursor)
            except TRANSIENT:
                page = None
            if page is not None:
                data = page.get("data") or []
                for raw in data:
                    point = MetricPoint.from_api(raw, self._client)
                    if last_seq is None or (point.seq or 0) > last_seq:
                        last_seq = point.seq
                        yield "metric", point
                cursor = page.get("next_cursor") or cursor
                if data:
                    backoff.reset()
                elif page.get("status") in TERMINAL_RUN_STATUSES:
                    yield "status", await self.get(run_id)
                    return
            if self._expired(deadline):
                return
            await self._sleep(backoff.next(), deadline)

    async def wait(
        self,
        run_id: str,
        *,
        timeout: float | None = None,
        on_metric: Callable[[MetricPoint], Any] | None = None,
        on_status: Callable[[AsyncRun], Any] | None = None,
        raise_on_failure: bool = True,
        poll_interval: float = 0.5,
    ) -> AsyncRun:
        """Wait until the run reaches a terminal status (see the blocking ``wait``).

        Callbacks may be plain functions or coroutine functions.
        """
        deadline = self._deadline(timeout)
        run: AsyncRun | None = None
        last_status: str | None = None
        if on_metric is not None:
            async for kind, event in self._follow(run_id, deadline):
                if kind == "metric":
                    await _call(on_metric, event)
                else:
                    run = event
            if run is None or run.status not in TERMINAL_RUN_STATUSES:
                run = None
        backoff = h.Backoff(poll_interval)
        while run is None or run.status not in TERMINAL_RUN_STATUSES:
            try:
                run = await self.get(run_id)
            except TRANSIENT:
                pass
            if run is not None and run.status != last_status:
                last_status = run.status
                if on_status is not None:
                    await _call(on_status, run)
            if run is not None and run.status in TERMINAL_RUN_STATUSES:
                break
            if self._expired(deadline):
                raise WaitTimeoutError(
                    f"Run {run_id} is still {run.status if run else 'unknown'} after {timeout}s; it keeps running "
                    "server-side. Call wait() again, or cancel() it.",
                    resource=run,
                )
            await self._sleep(backoff.next(), deadline)
        if on_status is not None and run.status != last_status:
            await _call(on_status, run)
        if run.status == "failed" and raise_on_failure:
            from ._errors import RunFailedError

            raise RunFailedError(f"Run {run.id} ({run.name}) failed: {run.error or 'no error reported'}", resource=run, error=run.error)
        return run


async def _call(fn: Callable[[Any], Any], arg: Any) -> None:
    result = fn(arg)
    if asyncio.iscoroutine(result):
        await result


class AsyncCheckpoints(_AsyncResource):
    """``client.checkpoints`` (async)."""

    async def promote(self, checkpoint_id: str, *, name: str | None = None) -> AsyncArtifact:
        """Copy a checkpoint into a new immutable artifact."""
        body = {} if name is None else {"name": h.check_slug(name, "artifact name")}
        return AsyncArtifact.from_api(await self._wire.promote_checkpoint(checkpoint_id, body), self._client)


class AsyncArtifacts(_AsyncResource):
    """``client.artifacts`` (async)."""

    async def get(self, ref: Any) -> AsyncArtifact:
        """An artifact by ``name@version``, ``name@latest`` or id."""
        return AsyncArtifact.from_api(await self._wire.get_artifact(model_ref(ref)), self._client)

    def list(self, *, name: str | None = None, limit: int | None = None) -> AsyncPager[AsyncArtifact]:
        """Artifacts, newest first."""
        return self._pager(AsyncArtifact, lambda cursor: self._wire.list_artifacts(name=name, limit=limit, cursor=cursor))

    async def download(
        self,
        ref: Any,
        path: str | os.PathLike[str] = ".",
        *,
        format: str = "peft",
        overwrite: bool = False,
        timeout: float | None = None,
    ) -> Path:
        """Download and verify an artifact (see the blocking ``download``)."""
        art = await self.get(ref)
        filename = f"{art.name}-{art.version}.grad.tar.gz"
        plan = h.plan_download(path, fmt=format, filename=filename, overwrite=overwrite)
        resp = await self._wire.download_artifact(art.ref, timeout=timeout or max(self._client._transport.timeout, 120.0))
        writer = h.HashingWriter(plan.temp_dir, f".{art.name}.")
        url = resp.url
        try:
            try:
                async for chunk in resp.aiter_bytes():
                    writer.write(chunk)
            except TransportFailure as failure:
                raise self._client._transport.connection_error("GET", url, failure) from failure.cause
            digest = writer.finish()
            h.verify_digest(digest, h.expected_sha(resp.headers.get("x-artifact-sha256"), art.sha256, url), url)
            if plan.format == "bundle":
                h.finalize_file(writer.path, plan.target)
                return plan.target
            return await asyncio.to_thread(_extract, writer.path, plan, art.format, overwrite)
        except BaseException:
            writer.discard()
            raise
        finally:
            await resp.aclose()
            if writer.path.exists() and plan.format != "bundle":
                writer.discard()

    async def merge(self, *args: Any, **kwargs: Any) -> Any:
        """Not available in v0."""
        raise NotAvailableInV0Error("artifacts.merge()", "artifact merging is deferred past v0.")


def _extract(bundle: Path, plan: h.DownloadPlan, artifact_format: str | None, overwrite: bool) -> Path:
    staging = Path(tempfile.mkdtemp(dir=plan.temp_dir, prefix=f".{plan.target.name}.extract-"))
    try:
        h.safe_extract_bundle(bundle, staging)
        if plan.format == "peft":
            h.check_peft_dir(staging, artifact_format)
        h.finalize_dir(staging, plan.target, overwrite=overwrite)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return plan.target


def _artifact_ref(artifact: Any) -> str:
    if isinstance(artifact, AsyncRun):
        if not artifact.artifact_id:
            raise artifact._no_artifact()
        return artifact.artifact_id
    from ._resources import _artifact_ref as sync_ref

    return sync_ref(artifact)


class AsyncDeployments(_AsyncResource):
    """``client.deployments`` (async)."""

    async def create(self, artifact: Any, *, name: str | None = None, fallback: Any = None, explore_rate: float | None = None) -> AsyncDeployment:
        """Deploy (or update) an artifact under a stable name."""
        body: dict[str, Any] = {"artifact": _artifact_ref(artifact)}
        if name is not None:
            body["name"] = h.check_slug(name, "deployment name")
        if fallback is not None:
            body["fallback"] = model_ref(fallback)
        if explore_rate is not None:
            body["explore_rate"] = explore_rate
        return AsyncDeployment.from_api(await self._wire.deploy_artifact(body), self._client)

    async def get(self, name: str) -> AsyncDeploymentStatus:
        """A deployment with its feedback summary."""
        return AsyncDeploymentStatus.from_api(await self._wire.get_deployment(name), self._client)

    def list(self, *, limit: int | None = None) -> AsyncPager[AsyncDeployment]:
        """Deployments."""
        return self._pager(AsyncDeployment, lambda cursor: self._wire.list_deployments(limit=limit, cursor=cursor))

    async def rollback(self, name: str) -> AsyncDeployment:
        """Point a deployment back at its previous artifact."""
        return AsyncDeployment.from_api(await self._wire.rollback_deployment(name), self._client)


class AsyncEmbeddingsAPI(_AsyncResource):
    """``client.embeddings`` (async)."""

    async def create(self, *, model: str, input: str | Sequence[str]) -> Embeddings:
        """Embed one string or up to 256 strings."""
        payload: str | list[str] = input if isinstance(input, str) else list(input)
        return Embeddings.from_api(await self._wire.create_embeddings({"model": model, "input": payload}), self._client)


class AsyncFeedback(_AsyncResource):
    """``client.feedback`` (async)."""

    async def record(
        self,
        *,
        inference_id: str | None = None,
        session_id: str | None = None,
        deployment_name: str | None = None,
        score: float | None = None,
        expected_output: Any = None,
        metrics: Mapping[str, float] | None = None,
        idempotency_key: str | None = None,
    ) -> FeedbackResult:
        """Record one outcome."""
        event = h.feedback_event(
            inference_id=inference_id,
            session_id=session_id,
            deployment_name=deployment_name,
            score=score,
            expected_output=expected_output,
            metrics=metrics,
            idempotency_key=idempotency_key,
        )
        return FeedbackResult.from_api(await self._wire.record_feedback({"events": [event]}), self._client)

    async def record_many(self, events: Sequence[Mapping[str, Any]]) -> FeedbackResult:
        """Record up to 1000 events in one call."""
        built = [h.feedback_event(**{k: e.get(k) for k in ("inference_id", "session_id", "deployment_name", "score", "expected_output", "metrics", "idempotency_key")}) for e in events]
        return FeedbackResult.from_api(await self._wire.record_feedback({"events": built}), self._client)


class AsyncKeys(_AsyncResource):
    """``client.keys`` (async)."""

    async def create(self, *, name: str, scopes: Sequence[str]) -> CreatedApiKey:
        """Create a key; the returned ``secret`` is shown only once."""
        return CreatedApiKey.from_api(await self._wire.create_api_key({"name": h.check_slug(name, "key name"), "scopes": list(scopes)}), self._client)

    def list(self, *, limit: int | None = None) -> AsyncPager[ApiKey]:
        """Workspace keys."""
        return self._pager(ApiKey, lambda cursor: self._wire.list_api_keys(limit=limit, cursor=cursor))

    async def revoke(self, key_id: str) -> ApiKey:
        """Revoke a key."""
        return ApiKey.from_api(await self._wire.revoke_api_key(key_id), self._client)


class AsyncEvals(_AsyncResource):
    """``client.evals`` (async)."""

    async def plan(
        self,
        *,
        models: Sequence[Any],
        dataset: Any = None,
        rubric: Any = None,
        name: str | None = None,
        baseline: Any = None,
        samples: int | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        limit: int | None = None,
        pass_threshold: float | None = None,
        max_cost_usd: float | None = None,
        benchmarks: Sequence[Any] | None = None,
        env: Any = None,
        tasks: Sequence[Any] | None = None,
        dataset_version: int | None = None,
        max_turns: int | None = None,
        max_concurrency: int | None = None,
    ) -> EvalPlan:
        """Estimate tasks, model/judge calls and cost ($0)."""
        body, _ = h.eval_body(**_eval_kwargs(locals()))
        return EvalPlan.from_api(await self._wire.plan_eval(body), self._client)

    async def create(
        self,
        *,
        models: Sequence[Any],
        dataset: Any = None,
        rubric: Any = None,
        name: str | None = None,
        baseline: Any = None,
        samples: int | None = None,
        temperature: float | None = None,
        max_tokens: int | None = None,
        limit: int | None = None,
        pass_threshold: float | None = None,
        max_cost_usd: float | None = None,
        benchmarks: Sequence[Any] | None = None,
        env: Any = None,
        tasks: Sequence[Any] | None = None,
        dataset_version: int | None = None,
        max_turns: int | None = None,
        max_concurrency: int | None = None,
    ) -> AsyncEval:
        """Queue an eval; ``await ev.wait()`` also runs local scorers."""
        body, local = h.eval_body(**_eval_kwargs(locals()))
        if local is not None and local.local_scorers and dataset is not None:
            sample = None
            async for record in self._client.datasets.records(dataset, limit=1):
                sample = record
                break
            if sample is not None:
                local.dry_run(sample)
        ev = AsyncEval.from_api(await self._wire.create_eval(body), self._client)
        ev._local_rubric = local
        return ev

    async def get(self, eval_id: str) -> AsyncEval:
        """An eval by id."""
        return AsyncEval.from_api(await self._wire.get_eval(eval_id), self._client)

    def list(self, *, limit: int | None = None) -> AsyncPager[AsyncEval]:
        """Evals, newest first."""
        return self._pager(AsyncEval, lambda cursor: self._wire.list_evals(limit=limit, cursor=cursor))

    async def cancel(self, eval_id: str) -> AsyncEval:
        """Cancel an eval."""
        return AsyncEval.from_api(await self._wire.cancel_eval(eval_id), self._client)

    def outputs(self, eval_id: str, *, model: Any = None, missing_scorer: str | None = None, limit: int | None = None) -> AsyncPager[EvalOutput]:
        """Generated outputs."""
        ref = None if model is None else model_ref(model)
        return self._pager(EvalOutput, lambda cursor: self._wire.list_eval_outputs(eval_id, model=ref, missing_scorer=missing_scorer, limit=limit, cursor=cursor))

    def results(self, eval_id: str, *, model: Any = None, limit: int | None = None) -> AsyncPager[EvalResult]:
        """Per-task, per-model results."""
        ref = None if model is None else model_ref(model)
        return self._pager(EvalResult, lambda cursor: self._wire.list_eval_results(eval_id, model=ref, limit=limit, cursor=cursor))

    async def failures(self, eval_id: str, *, model: Any = None, threshold: float | None = None) -> AsyncEvalFailures:
        """Tasks scoring below ``threshold``, all pages."""
        ref = None if model is None else model_ref(model)
        items = await self._pager(EvalResult, lambda cursor: self._wire.list_eval_failures(eval_id, model=ref, threshold=threshold, cursor=cursor)).to_list()
        return AsyncEvalFailures(eval_id, items, self._client)

    async def post_scores(self, eval_id: str, scores: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        """Low level: post local scores (chunked)."""
        result: dict[str, Any] = {}
        items = list(scores)
        for start in range(0, len(items), 1000):
            result = dict(await self._wire.post_eval_scores(eval_id, {"scores": items[start : start + 1000]}))
        return result

    async def score_pending(self, eval_id: str, rubric: Any) -> int:
        """Run local scorers on every output still missing their score and post them."""
        ev = await self.get(eval_id)
        if ev.status != "awaiting_scores" or not ev.local_scorers:
            return 0
        scorers = h.local_scorers_for(rubric, ev.local_scorers, eval_id)
        posted = 0
        for name, scorer in scorers.items():
            previous: set[str] = set()
            while True:
                outputs = (await self._wire.list_eval_outputs(eval_id, missing_scorer=name, limit=200)).get("data") or []
                if not outputs:
                    break
                ids = {o["id"] for o in outputs}
                if ids & previous:
                    raise GradAPIError(
                        status=409,
                        code="scores_not_accepted",
                        title="Scores not accepted",
                        detail=f"The server still reports outputs missing '{name}' after they were scored.",
                        request_id=None,
                        method="POST",
                        url=self._client._transport.url(f"/v1/evals/{eval_id}/scores"),
                    )
                previous = ids
                batch = []
                for raw in outputs:
                    out = EvalOutput.from_api(raw, self._client)
                    batch.append({"output_id": out.id, "scorer": name, "score": scorer.score(out.trajectory(), where=f"output {out.id} ({out.model})")})
                await self.post_scores(eval_id, batch)
                posted += len(batch)
        return posted

    async def wait(self, eval_id: str, *, timeout: float | None = None, rubric: Any = None, raise_on_failure: bool = True, poll_interval: float = 0.5) -> AsyncEval:
        """Wait until the eval completes, scoring local Python scorers when it awaits them."""
        deadline = self._deadline(timeout)
        backoff = h.Backoff(poll_interval)
        while True:
            try:
                ev: AsyncEval | None = await self.get(eval_id)
            except TRANSIENT:
                ev = None
            if ev is not None:
                if ev.status == "awaiting_scores":
                    if await self.score_pending(eval_id, rubric):
                        backoff.reset(poll_interval)
                        continue
                elif ev.status in TERMINAL_EVAL_STATUSES:
                    if ev.status == "failed" and raise_on_failure:
                        raise EvalFailedError(f"Eval {ev.id} ({ev.name}) failed: {ev.error or 'no error reported'}", resource=ev, error=ev.error)
                    ev._local_rubric = rubric
                    return ev
            if self._expired(deadline):
                raise WaitTimeoutError(f"Eval {eval_id} is still {ev.status if ev else 'unknown'} after {timeout}s.", resource=ev)
            await self._sleep(backoff.next(), deadline)

    async def from_inspect(self, *args: Any, **kwargs: Any) -> Any:
        """Not available in v0."""
        raise NotAvailableInV0Error("evals.from_inspect()", "Inspect task imports are deferred past v0.")


class AsyncEnvironments(_AsyncResource):
    """``client.environments`` (async): dispatch tasks to environment workers."""

    async def dispatch(
        self,
        env_name: str,
        task: Mapping[str, Any],
        *,
        model_id: str,
        system_prompt: str | None = None,
        timeout_s: int | None = None,
    ) -> dict[str, Any]:
        """Queue one task for workers serving ``env_name``."""
        body: dict[str, Any] = {"env_name": h.check_slug(env_name, "environment name"), "task": dict(task), "model_id": model_id}
        if system_prompt is not None:
            body["system_prompt"] = system_prompt
        if timeout_s is not None:
            body["timeout_s"] = timeout_s
        return dict(await self._wire.dispatch_env_task(body))

    async def get_task(self, task_id: str) -> dict[str, Any]:
        """A dispatched task with its status and result."""
        return dict(await self._wire.get_env_task(task_id))
