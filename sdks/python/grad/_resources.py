"""Blocking resource namespaces of :class:`grad.Grad` (``client.datasets``, ``client.runs``, ...)."""

from __future__ import annotations

import builtins
import typing
import json
import os
import shutil
import sys
import tempfile
import warnings
from collections.abc import Callable, Iterable, Iterator, Mapping, Sequence
from pathlib import Path
from typing import TYPE_CHECKING, Any

import httpx

from . import _helpers as h
from . import _progress
from ._errors import (
    APIConnectionError,
    EvalFailedError,
    GradAPIError,
    ArtifactImportFailedError,
    ImportFailedError,
    NotFoundError,
    RateLimitError,
    RunFailedError,
    ServerError,
    ValidationError,
    WaitTimeoutError,
)
from ._models import (
    ApiKey,
    Artifact,
    Checkpoint,
    CreatedApiKey,
    CursorTrail,
    Dataset,
    DatasetScoring,
    ArtifactImport,
    Eval,
    EvalFailures,
    EvalOutput,
    EvalPlan,
    EvalResult,
    ImportJob,
    CompletedEvent,
    MetricEvent,
    MetricPoint,
    Model,
    Page,
    PhaseEvent,
    Plan,
    RenderPreview,
    Run,
    RunEvent,
    run_event_from_api,
    SecretRef,
    Source,
    UsageRecord,
    UsageSummary,
    TERMINAL_EVAL_STATUSES,
    TERMINAL_IMPORT_STATUSES,
    TERMINAL_RUN_STATUSES,
)
from ._generated.client import LIST_EVAL_OUTPUTS_LIMIT_MAX, ArtifactDownloadUrl, RunCounts
from ._transport import SSEDecoder, iter_sse, quote_path_param
from .recipes import _thinking
from .records import Trajectory
from .sources import UNSET, provider_body, secret_name
from .rubrics import model_ref

if TYPE_CHECKING:
    from .client import Grad

TRANSIENT = (APIConnectionError, ServerError, RateLimitError)
SSE_READ_TIMEOUT = 45.0
MAX_SSE_RECONNECTS = 20
#: Page size of ``runs.events()`` JSON pages.
EVENTS_PAGE_LIMIT = 100


#: ``wait()`` gives up after this long when no ``timeout`` is passed (as the Rust SDK).
DEFAULT_WAIT_TIMEOUT = 24 * 3600.0


class _Resource:
    def __init__(self, client: Grad) -> None:
        self._client = client
        self._wire = client.wire

    @property
    def _clock(self) -> Any:
        return self._client._transport.clock

    def _deadline(self, timeout: float | None) -> float:
        """``timeout=None`` means the 24 h default: no wait() can hang forever."""
        return float(self._clock.monotonic()) + (DEFAULT_WAIT_TIMEOUT if timeout is None else timeout)

    def _expired(self, deadline: float | None) -> bool:
        return deadline is not None and self._clock.monotonic() >= deadline

    def _sleep(self, seconds: float, deadline: float | None) -> None:
        if deadline is not None:
            seconds = max(0.0, min(seconds, deadline - self._clock.monotonic()))
        self._clock.sleep(seconds)

    def _page(self, cls: Any, fetch: Callable[[str | None], Mapping[str, Any]], cursor: str | None = None, *, trail: CursorTrail | None = None) -> Page[Any]:
        trail = trail or CursorTrail(f"list of {cls.__name__} objects")
        data = fetch(cursor)
        return Page(
            [cls.from_api(item, self._client) for item in data.get("data") or []],
            data.get("next_cursor"),
            lambda nxt: self._page(cls, fetch, nxt, trail=trail),
            trail=trail,
        )


class Models(_Resource):
    """``client.models``: the trainable base-model catalog."""

    def list(self) -> list[Model]:
        """Every trainable base model, with prices and supported recipes."""
        return [Model.from_api(m, self._client) for m in self._wire.list_base_models().get("data") or []]

    def get(self, model_id: str) -> Model:
        """One catalog model; raises :class:`grad.NotFoundError` if the server does not offer it."""
        for model in self.list():
            if model.id == model_id:
                return model
        raise NotFoundError(
            status=404,
            code="model_not_found",
            title="Model not found",
            detail=f"Model {model_id!r} is not in this server's catalog (see client.models.list()).",
            request_id=None,
            method="GET",
            url=self._client._transport.url("/v1/base-models"),
        )


class Datasets(_Resource):
    """``client.datasets``: versioned training and eval data."""

    def create(self, name: str, *, metadata: Mapping[str, Any] | None = None) -> Dataset:
        """Create an empty dataset (raises :class:`grad.ConflictError` if it exists)."""
        body: dict[str, Any] = {"name": h.check_slug(name, "dataset name")}
        if metadata is not None:
            body["metadata"] = dict(metadata)
        return Dataset.from_api(self._wire.create_dataset(body), self._client)

    def get(self, name: str) -> Dataset:
        """A dataset by name."""
        return Dataset.from_api(self._wire.get_dataset(h.dataset_name(name)), self._client)

    def list(self, *, search: str | None = None, limit: int | None = None) -> Page[Dataset]:
        """Datasets, newest first (iterating walks every page); ``search`` keeps names containing it (any case) or the exact id."""
        return self._page(Dataset, lambda cursor: self._wire.list_datasets(limit=limit, cursor=cursor, q=search))

    def count(self, dataset: Any) -> int:
        """Record count of the latest version."""
        return self.get(h.dataset_name(dataset)).record_count

    def push(
        self,
        name: str,
        records: Iterable[Any] | str | os.PathLike[str],
        *,
        metadata: Mapping[str, Any] | None = None,
        chunk_size: int = h.DEFAULT_CHUNK_RECORDS,
        connector: str = "auto",
        format: str = "auto",
        timeout: float | None = None,
    ) -> Dataset:
        """Append records (dicts, ``Trajectory``/``Record`` objects, any iterable) or a file.

        Records are sent in chunks of ``chunk_size`` (each chunk becomes a dataset
        version). A path (``"./train.jsonl"``, ``.json``, ``.parquet``) is uploaded and
        imported server-side (with ``connector``), waiting up to ``timeout`` seconds.
        """
        h.check_slug(name, "dataset name")
        if h.is_path_like(records):
            job = self.import_file(name, records, connector=connector, format=format)  # type: ignore[arg-type]
            job.wait(timeout=timeout)
            return self.get(name)
        if isinstance(records, (str, bytes, Mapping)):
            raise TypeError(
                "push() takes a list/iterable of records or a path to a .jsonl/.json/.parquet file; "
                f"{records!r:.60} is neither (does the file exist?)."
            )
        result: Dataset | None = None
        first = True
        for offset, chunk in h.chunk_records(typing.cast(Iterable[Any], records), max_records=chunk_size):
            body: dict[str, Any] = {"records": chunk}
            if metadata is not None and first:
                body["metadata"] = dict(metadata)
            try:
                result = Dataset.from_api(self._wire.push_dataset_records(name, body), self._client)
            except ValidationError as exc:
                raise h.renumber_validation(exc, offset, len(chunk)) from None
            first = False
        if result is None:
            raise ValueError("push() got no records; pass at least one record (or create an empty dataset with datasets.create).")
        return result

    def import_file(self, name: str, path: str | os.PathLike[str], *, connector: str = "auto", format: str = "auto") -> ImportJob:
        """Upload a local file and start a server-side import job (``.wait()`` on the result)."""
        file_path = Path(path).expanduser()
        h.check_slug(name, "dataset name")
        h.check_connector(connector)
        fmt = h.file_format(file_path, format)
        ticket = self._wire.create_upload(h.upload_request(file_path))
        with open(file_path, "rb") as fh:
            self._client._transport.upload(
                ticket["url"],
                fh,
                length=file_path.stat().st_size,
                headers=ticket.get("headers") or {},
                method=ticket.get("method") or "PUT",
                timeout=max(self._client._transport.timeout, 300.0),
            )
        source = {"kind": "upload", "upload_id": ticket["upload_id"], "format": fmt}
        return ImportJob.from_api(self._wire.create_dataset_import(name, {"source": source, "connector": connector}), self._client)

    def from_hf(
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
        secret: Any = None,
        wait: bool = True,
        timeout: float | None = None,
    ) -> Dataset:
        """Import a Hugging Face dataset server-side (nothing is downloaded locally).

        For gated or private datasets pass ``secret=client.secrets.get("hf-token")``: the worker
        receives the token from the workspace secret store, never from this process.

        Column mappings (``messages="messages"``, ``prompt="question"``, ``answer=``,
        ``chosen=``/``rejected=``, ``query=``/``positive=``) say which columns hold what.
        ``subset`` is an alias of ``config``. The dataset name defaults to the repo slug.
        """
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
        token = secret_name(secret)
        if token is not None:
            source["secret"] = token
        ds_name = h.check_slug(name or h.hf_dataset_name(repo, split, cfg), "dataset name")
        job = ImportJob.from_api(
            self._wire.create_dataset_import(ds_name, {"source": source, "connector": h.check_connector(connector)}),
            self._client,
        )
        if wait:
            job.wait(timeout=timeout)
        return self.get(ds_name)

    def from_benchmark(
        self,
        benchmark: str,
        *,
        limit: int | None = None,
        name: str | None = None,
        wait: bool = True,
        timeout: float | None = None,
    ) -> Dataset:
        """Import a built-in benchmark (``"gsm8k"``, ``"mmlu"``, ``"mmlu_pro"``, ``"arc_challenge"``)
        from Hugging Face at a pinned revision, with fixed prompts and its answer check: an eval
        on the dataset without ``rubric=`` scores with it. ``limit`` takes the first N problems;
        the dataset is named ``<benchmark>-<limit>`` (or ``<benchmark>``) unless ``name`` is given.
        """
        ds_name = h.check_slug(name or (f"{benchmark}-{limit}" if limit else benchmark), "dataset name")
        source: dict[str, Any] = {"kind": "benchmark", "benchmark": benchmark}
        if limit is not None:
            source["limit"] = limit
        job = ImportJob.from_api(self._wire.create_dataset_import(ds_name, {"source": source, "connector": "auto"}), self._client)
        if wait:
            job.wait(timeout=timeout)
        return self.get(ds_name)

    def score(
        self,
        dataset: Any,
        rubric: Any,
        *,
        version: int | None = None,
        name: str | None = None,
        limit: int | None = None,
        idempotency_key: str | None = None,
    ) -> DatasetScoring:
        """Score the records' own answers with a ``Judge``, ``Scorer`` or ``Rubric`` (server-side,
        billed like an eval); ``.wait()`` returns the dataset whose next version carries the
        scores in ``record.scores``. Records that already have every score are skipped."""
        ds = h.dataset_name(dataset)
        items, local = h.rubric_items(rubric)
        if not items:
            raise ValueError("dataset.score() needs a Judge, Scorer, validator or Rubric.")
        if local is not None and local.local_scorers:
            sample = next(iter(self.records(ds, version=version, limit=1)), None)
            if sample is not None:
                local.dry_run(sample)
        body: dict[str, Any] = {"rubric": items}
        if version is not None:
            body["version"] = version
        if name is not None:
            body["name"] = h.check_slug(name, "scoring job name")
        if limit is not None:
            body["limit"] = limit
        ev = Eval.from_api(self._wire.score_dataset(ds, body, idempotency_key=idempotency_key), self._client)
        ev._local_rubric = local
        return DatasetScoring(ev)

    def filter(
        self,
        dataset: Any,
        fn: Callable[[Trajectory], bool] | None = None,
        *,
        scores: Mapping[str, Any] | None = None,
        metadata: Mapping[str, Any] | None = None,
        created_after: Any = None,
        created_before: Any = None,
        ids: Sequence[str] | None = None,
        version: int | None = None,
        name: str | None = None,
    ) -> Dataset:
        """Save a filtered view and return it as a dataset.

        Field filters run on the server and cost nothing (``scores={"resolved": ">=0.8"}``,
        ``metadata={"env": "prod"}``, ``created_after=``/``created_before=`` on the record
        timestamp). A function ``fn(trajectory) -> bool`` runs here: the records stream to this
        machine once and the matching ids are saved as the view. The same filter on the same
        version returns the same view.
        """
        ds = h.dataset_name(dataset)
        body: dict[str, Any] = {}
        if fn is not None:
            if not callable(fn):
                raise TypeError("dataset.filter(fn) takes a function (Trajectory) -> bool; use scores= for score conditions.")
            if scores or metadata or created_after or created_before or ids:
                raise ValueError("Pass either a filter function or field filters, not both.")
            version = version or self.get(ds).version
            body["ids"] = [
                str(rec["id"]) for rec in self.records(ds, version=version) if rec.get("id") and fn(Trajectory.from_record(rec))
            ]
        if scores:
            body["scores"] = {str(k): v if isinstance(v, (int, float)) and not isinstance(v, bool) else str(v) for k, v in scores.items()}
        if metadata:
            body["metadata"] = dict(metadata)
        for key, value in (("created_after", created_after), ("created_before", created_before)):
            if value is not None:
                body[key] = h.time_bound(value)
        if ids is not None:
            body["ids"] = [str(i) for i in ids]
        if version is not None:
            body["version"] = version
        if name is not None:
            body["name"] = h.check_slug(name, "view name")
        return Dataset.from_api(self._wire.filter_dataset(ds, body), self._client)

    def records(self, name: Any, *, version: int | None = None, limit: int | None = None) -> Iterator[dict[str, Any]]:
        """Iterate the records of a version (latest by default), page by page."""
        ds = h.dataset_name(name)
        trail = CursorTrail(f"GET /v1/datasets/{ds}/records")
        cursor: str | None = None
        while True:
            page = self._wire.list_dataset_records(ds, version=version, limit=limit, cursor=cursor)
            yield from typing.cast(builtins.list[dict[str, Any]], page.get("data") or [])
            cursor = trail.follow(page.get("next_cursor"), page.get("data") or [])
            if cursor is None:
                return

    def render(
        self,
        dataset: Any,
        *,
        model: Any = None,
        train_on: str | None = None,
        thinking: Any = None,
        preserve_thinking: bool | None = None,
        limit: int | None = None,
    ) -> RenderPreview:
        """Preview chat-template rendering and which tokens are trained (``print()`` it)."""
        body: dict[str, Any] = {}
        if model is not None:
            body["model"] = model_ref(model)
        if train_on is not None:
            body["train_on"] = train_on
        if thinking is not None:
            body["thinking"] = _thinking(thinking)
        if preserve_thinking is not None:
            body["preserve_thinking"] = preserve_thinking
        if limit is not None:
            body["limit"] = limit
        return RenderPreview.from_api(self._wire.render_dataset(h.dataset_name(dataset), body), self._client)


class Usage(_Resource):
    """Billed usage: a summary over a period, and the billed rows behind it.

    Periods are UTC. ``from_`` is inclusive; ``to`` as a ``date`` or ``"YYYY-MM-DD"`` covers that
    whole day, and as a ``datetime`` or ISO timestamp is exclusive. A naive ``datetime`` is UTC.
    """

    def summary(self, *, from_: Any = None, to: Any = None, group_by: str | None = None) -> UsageSummary:
        """Total cost and tokens, by kind, the top runs and evals, and ``group_by`` groups
        (``day``, ``week``, ``month``, ``model``, ``recipe`` or ``kind``). Default period: this month."""
        return UsageSummary.from_api(
            self._wire.get_usage_summary(
                from_=_bound(from_), to=_bound(to), group_by=typing.cast(Any, group_by)
            ),
            self._client,
        )

    def list(
        self,
        *,
        from_: Any = None,
        to: Any = None,
        run_id: Any = None,
        eval_id: Any = None,
        kind: str | None = None,
        limit: int | None = None,
    ) -> Page[UsageRecord]:
        """Billed rows, newest first (iterate the page to follow every page).

        ``run_id`` takes a run or its id and also matches the evals the run started (labeling,
        teacher answers, checkpoint evals); ``eval_id`` takes an eval or its id; ``kind`` is
        ``training``, ``eval``, ``scoring``, ``labeling`` or ``teacher``.
        """
        run, ev = _ref_id(run_id), _ref_id(eval_id)
        from_s, to_s = _bound(from_), _bound(to)
        return self._page(
            UsageRecord,
            lambda cursor: self._wire.list_usage(
                limit=limit,
                cursor=cursor,
                from_=from_s,
                to=to_s,
                run_id=run,
                eval_id=ev,
                kind=typing.cast(Any, kind),
            ),
        )


def _bound(value: Any) -> str | None:
    return None if value is None else h.time_bound(value)


def _ref_id(value: Any) -> str | None:
    return None if value is None else str(getattr(value, "id", value))


def _statuses(value: str | Iterable[str] | None) -> str | None:
    """A ``status`` filter on the wire: comma-separated, and absent when empty."""
    if value is None:
        return None
    joined = value if isinstance(value, str) else ",".join(value)
    return joined or None


class Secrets(_Resource):
    """Workspace secrets (provider keys, HF tokens). Values are write-only."""

    def set(self, name: str, value: str, *, allowed_hosts: Sequence[str] | None = None) -> SecretRef:
        """Create or replace a secret. The value is encrypted at rest and never returned.

        ``allowed_hosts`` are the only hosts the server will send the value to (a source's
        host, ``huggingface.co`` for HF imports, a logger's host). Leave it out for the
        public provider hosts; a secret for a self-hosted tool must name its host.
        """
        if not isinstance(value, str) or not value:
            raise ValueError("A secret value must be a non-empty string.")
        body: dict[str, Any] = {"name": h.check_slug(name, "secret name"), "value": value}
        if allowed_hosts is not None:
            if isinstance(allowed_hosts, str):
                raise TypeError("allowed_hosts must be a list of hosts, not a string.")
            body["allowed_hosts"] = [str(host) for host in allowed_hosts]
        return SecretRef.from_api(self._wire.set_secret(body), self._client)

    def get(self, name: str) -> SecretRef:
        """A reference to pass as ``secret=`` (checks that the secret exists; no value)."""
        return SecretRef.from_api(self._wire.get_secret(h.check_slug(name, "secret name")), self._client)

    def list(self, *, limit: int | None = None) -> Page[SecretRef]:
        """Secret names and metadata, newest first."""
        return self._page(SecretRef, lambda cursor: self._wire.list_secrets(limit=limit, cursor=cursor))

    def delete(self, name: Any) -> None:
        """Delete a secret (409 ConflictError while a source uses it)."""
        self._wire.delete_secret(h.check_slug(secret_name(name) or "", "secret name"))


class Sources(_Resource):
    """Observability sources that sync traces and feedback into datasets.

    A source feeds exactly one dataset; a dataset can have several sources (one per provider or
    project). Deleting a dataset deletes its sources."""

    def create(
        self,
        dataset: Any,
        provider: Any,
        *,
        schedule: str | None = None,
        sample_rate: float | None = None,
        max_records_per_sync: int | None = None,
        max_records_per_day: int | None = None,
        version_interval: int | None = None,
        idempotency_key: str | None = None,
    ) -> Source:
        """Connect ``provider`` (``grad.sources.Langfuse(..., filters={...})``, ...) to
        ``dataset`` (created if missing). ``schedule`` is a five-field UTC cron, so it fires at
        most once a minute. ``sample_rate`` (0-1] keeps that share of traces, chosen by trace id;
        ``max_records_per_sync`` / ``max_records_per_day`` cap the new traces taken.
        ``version_interval`` (seconds, default 900; 0: every sync) is how often scheduled syncs
        commit a dataset version; manual and full syncs always do."""
        body: dict[str, Any] = {"provider": provider_body(provider)}
        for key, value in (
            ("schedule", schedule),
            ("sample_rate", sample_rate),
            ("max_records_per_sync", max_records_per_sync),
            ("max_records_per_day", max_records_per_day),
            ("version_interval", version_interval),
        ):
            if value is not None:
                body[key] = value
        return Source.from_api(
            self._wire.create_dataset_source(h.dataset_name(dataset), body, idempotency_key=idempotency_key),
            self._client,
        )

    def update(
        self,
        source: Any,
        *,
        filters: Any = UNSET,
        schedule: Any = UNSET,
        sample_rate: Any = UNSET,
        max_records_per_sync: Any = UNSET,
        max_records_per_day: Any = UNSET,
        version_interval: Any = UNSET,
    ) -> Source:
        """Change a source from its next sync. Arguments left out keep their value; ``filters``
        replaces all of them (``{}`` clears them), ``None`` clears the schedule or a cap. Traces
        already synced stay; ``sync(full=True)`` rebuilds the dataset with the new settings."""
        body = {
            key: dict(value) if key == "filters" else value
            for key, value in (
                ("filters", filters),
                ("schedule", schedule),
                ("sample_rate", sample_rate),
                ("max_records_per_sync", max_records_per_sync),
                ("max_records_per_day", max_records_per_day),
                ("version_interval", version_interval),
            )
            if value is not UNSET
        }
        source_id = source.id if isinstance(source, Source) else str(source)
        return Source.from_api(self._wire.update_source(source_id, body), self._client)

    def get(self, source_id: str) -> Source:
        return Source.from_api(self._wire.get_source(source_id), self._client)

    def list(self, *, dataset: Any = None, limit: int | None = None) -> Page[Source]:
        """Sources, newest first; ``dataset=`` keeps one dataset's."""
        name = None if dataset is None else h.dataset_name(dataset)
        return self._page(Source, lambda cursor: self._wire.list_sources(limit=limit, cursor=cursor, dataset=name))

    def sync(self, source: Any, *, full: bool = False) -> ImportJob:
        """Queue a sync (or get the one in progress); ``.wait()`` on the job to block.

        A source starts at most one sync a minute: within a minute of the last start this
        returns that sync. ``full=True`` while an incremental sync runs returns the running one
        and queues the full sync right after it. Syncing a paused source resumes it."""
        source_id = source.id if isinstance(source, Source) else str(source)
        return ImportJob.from_api(self._wire.sync_source(source_id, {"full": full}), self._client)

    def delete(self, source: Any) -> None:
        """Disconnect a source; its dataset and versions stay."""
        self._wire.delete_source(source.id if isinstance(source, Source) else str(source))

    def remove(self, source: Any) -> None:
        """Deprecated: use :meth:`delete`."""
        warnings.warn("sources.remove() is deprecated; use sources.delete()", DeprecationWarning, stacklevel=2)
        self.delete(source)


class Imports(_Resource):
    """``client.imports``: dataset import jobs."""

    def get(self, import_id: str) -> ImportJob:
        """An import job."""
        return ImportJob.from_api(self._wire.get_import(import_id), self._client)

    def list(self, *, status: str | Iterable[str] | None = None, dataset: Any = None, limit: int | None = None) -> Page[ImportJob]:
        """Import jobs, newest first; ``status`` keeps these statuses, ``dataset`` one dataset's imports."""
        name = None if dataset is None else h.dataset_name(dataset)
        statuses = _statuses(status)
        return self._page(ImportJob, lambda cursor: self._wire.list_imports(limit=limit, cursor=cursor, status=statuses, dataset=name))

    def wait(self, import_id: str, *, timeout: float | None = None, poll_interval: float = 0.5) -> ImportJob:
        """Block until the import finishes; :class:`grad.ImportFailedError` if it failed."""
        deadline = self._deadline(timeout)
        backoff = h.Backoff(poll_interval)
        while True:
            try:
                job = self.get(import_id)
            except TRANSIENT:
                job = None
            if job is not None and job.status in TERMINAL_IMPORT_STATUSES:
                if job.status == "failed":
                    raise ImportFailedError(f"Import {job.id} into '{job.dataset}' failed: {job.error}", resource=job, error=job.error)
                return job
            if self._expired(deadline):
                status = job.status if job is not None else "unknown"
                raise WaitTimeoutError(f"Import {import_id} is still {status} after {timeout or DEFAULT_WAIT_TIMEOUT:g}s (is a trainer worker running?).", resource=job)
            self._sleep(backoff.next(), deadline)


# Plan warnings that runs.create already issued as Python warnings, by run id.
_WARNED: dict[str, frozenset[str]] = {}


class Runs(_Resource):
    """``client.runs``: plan, launch, watch and manage training runs."""

    def plan(
        self,
        dataset: Any = None,
        *,
        name: str,
        recipe: Any,
        split: Any = None,
        max_cost_usd: float | None = None,
    ) -> Plan:
        """Dry-run a recipe at $0: resolved defaults, warnings, tokens and cost (``print(plan)``)."""
        body = h.run_body(dataset=dataset, name=name, recipe=recipe, split=split, max_cost_usd=max_cost_usd)
        plan = Plan.from_api(self._wire.plan_run(body), self._client)
        plan.max_cost_usd = max_cost_usd
        return plan

    def create(
        self,
        dataset: Any = None,
        *,
        name: str,
        recipe: Any,
        split: Any = None,
        max_cost_usd: float | None = None,
        idempotency_key: str | None = None,
    ) -> Run:
        """Create and enqueue a run (pins the dataset version). Chain ``.wait()``.

        To keep training from a finished run, pass its artifact as the recipe's model:
        ``SFTRecipe(model=run.artifact)``. ``idempotency_key`` makes a retried call (even from
        another process) return the run the first call created instead of starting a second one.
        The plan's warnings (such as another queued or running run with this ``name``) are on
        ``run.warnings`` and are issued as Python warnings.
        """
        body = h.run_body(dataset=dataset, name=name, recipe=recipe, split=split, max_cost_usd=max_cost_usd)
        run = Run.from_api(self._wire.create_run(body, idempotency_key=idempotency_key), self._client)
        for message in run.warnings:
            warnings.warn(message, stacklevel=2)
        # wait()'s progress line doesn't print these a second time.
        _WARNED[run.id] = frozenset(run.warnings)
        return run

    def get(self, run_id: str) -> Run:
        """A run by id."""
        return Run.from_api(self._wire.get_run(run_id), self._client)

    def list(self, *, status: str | Iterable[str] | None = None, search: str | None = None, limit: int | None = None) -> Page[Run]:
        """Runs, newest first; ``status`` keeps these statuses (``"failed"`` or ``["failed", "cancelled"]``),
        ``search`` names containing it (any case) or the exact id."""
        statuses = _statuses(status)
        return self._page(Run, lambda cursor: self._wire.list_runs(limit=limit, cursor=cursor, status=statuses, q=search))

    def counts(self, *, search: str | None = None) -> RunCounts:
        """Runs per status (``{"total": n, "by_status": {"failed": 2, ...}}``), optionally of the runs ``search`` matches."""
        return self._wire.count_runs(q=search)

    def cancel(self, run_id: str) -> Run:
        """Cancel a queued or running run."""
        return Run.from_api(self._wire.cancel_run(run_id), self._client)

    def resume(self, run_id: str, *, max_cost_usd: float | None = None) -> Run:
        """Resume a stopped, failed or cancelled run from its latest checkpoint (optionally raise the cap)."""
        body = {} if max_cost_usd is None else {"max_cost_usd": max_cost_usd}
        return Run.from_api(self._wire.resume_run(run_id, body), self._client)

    def checkpoints(self, run_id: str) -> builtins.list[Checkpoint]:
        """Unexpired checkpoints of a run (best and final never expire)."""
        page = self._page(Checkpoint, lambda cursor: self._wire.list_run_checkpoints(run_id, cursor=cursor))
        return sorted(page.to_list(), key=lambda c: (c.step, c.attempt or 0))

    def metrics(self, run_id: str, *, follow: bool = False, after_step: int | None = None) -> Iterator[MetricPoint]:
        """Metric points so far; ``follow=True`` streams live (SSE) until the run finishes."""
        if follow:
            return (
                event.metric
                for event in self._follow_events(run_id, None)
                if isinstance(event, MetricEvent) and (after_step is None or event.metric.step > after_step)
            )
        return self._metric_pages(run_id, after_step)

    def events(self, run_id: str, *, follow: bool = False, timeout: float | None = None) -> Iterator[RunEvent]:
        """The run's typed lifecycle events, oldest first.

        ``follow=False`` returns the events stored so far (a terminal run's end with
        :class:`grad.CompletedEvent`). ``follow=True`` streams live (SSE) until the run finishes,
        reconnecting with ``Last-Event-ID`` behind the scenes; ``timeout`` bounds the stream.
        """
        if follow:
            return self._follow_events(run_id, self._deadline(timeout))
        return self._event_pages(run_id)

    def _event_pages(self, run_id: str) -> Iterator[RunEvent]:
        trail = CursorTrail(f"GET /v1/runs/{run_id}/events")
        cursor: str | None = None
        while True:
            page = self._wire.list_run_events(run_id, cursor=cursor, limit=EVENTS_PAGE_LIMIT)
            data = page.get("data") or []
            for raw in data:
                event = run_event_from_api(raw, self._client)
                if event is not None:
                    yield event
            nxt = trail.follow(page.get("next_cursor"), data)
            if nxt is None:
                return
            cursor = nxt

    def _follow_events(self, run_id: str, deadline: float | None) -> Iterator[RunEvent]:
        """Live events until ``completed`` (or the deadline); reconnects resume after the last seq."""
        last_seq: int | None = None
        failures = 0
        retry_ms = 1000
        path = f"/v1/runs/{quote_path_param(run_id, 'id')}/events"
        while True:
            try:
                resp = self._wire.list_run_events_stream(run_id, last_event_id=None if last_seq is None else str(last_seq), timeout=SSE_READ_TIMEOUT)
            except TRANSIENT as exc:
                failures += 1
                if failures > MAX_SSE_RECONNECTS:
                    raise exc
                if self._expired(deadline):
                    return
                self._sleep(min(10.0, retry_ms / 1000 * failures), deadline)
                continue
            if "text/event-stream" not in resp.headers.get("content-type", ""):
                resp.close()
                yield from self._poll_events(run_id, deadline, last_seq)
                return
            try:
                for sse in iter_sse(self._lines_until(resp, deadline), SSEDecoder()):
                    if sse.retry is not None:
                        retry_ms = sse.retry
                    event = run_event_from_api(_json(sse.data), self._client) if sse.data else None
                    if event is None:
                        continue
                    if isinstance(event, CompletedEvent):
                        yield event
                        return
                    if last_seq is not None and event.seq <= last_seq:
                        continue
                    last_seq = event.seq
                    failures = 0
                    yield event
            except (httpx.TransportError, APIConnectionError):
                pass
            finally:
                resp.close()
            if self._expired(deadline):
                return
            failures += 1
            if failures > MAX_SSE_RECONNECTS:
                raise APIConnectionError(
                    f"Lost the event stream for run {run_id} {failures} times in a row.",
                    method="GET",
                    url=self._client._transport.url(path),
                )
            self._sleep(min(10.0, retry_ms / 1000 * failures), deadline)

    def _poll_events(self, run_id: str, deadline: float | None, last_seq: int | None) -> Iterator[RunEvent]:
        # Fallback when a proxy strips the event stream: poll JSON pages with backoff.
        cursor: str | None = None
        backoff = h.Backoff()
        while True:
            try:
                page = self._wire.list_run_events(run_id, cursor=cursor, limit=EVENTS_PAGE_LIMIT)
            except TRANSIENT:
                page = None
            if page is not None:
                fresh = False
                for raw in page.get("data") or []:
                    event = run_event_from_api(raw, self._client)
                    if event is None:
                        continue
                    if isinstance(event, CompletedEvent):
                        yield event
                        return
                    if last_seq is None or event.seq > last_seq:
                        last_seq = event.seq
                        fresh = True
                        yield event
                cursor = page.get("tail_cursor") or cursor
                if fresh:
                    backoff.reset()
            if self._expired(deadline):
                return
            self._sleep(backoff.next(), deadline)

    def _metric_pages(self, run_id: str, after_step: int | None) -> Iterator[MetricPoint]:
        trail = CursorTrail(f"GET /v1/runs/{run_id}/metrics")
        cursor: str | None = None
        while True:
            page = self._wire.list_run_metrics(run_id, cursor=cursor, after_step=after_step)
            data = page.get("data") or []
            for point in data:
                yield MetricPoint.from_api(point, self._client)
            nxt = trail.follow(page.get("next_cursor"), data)
            if nxt is None:
                return
            cursor = nxt

    def _lines_until(self, resp: Any, deadline: float | None) -> Iterator[str]:
        for line in resp.iter_lines():
            yield line
            if self._expired(deadline):
                return

    def wait(
        self,
        run_id: str,
        *,
        timeout: float | None = None,
        on_metric: Callable[[MetricPoint], Any] | None = None,
        on_status: Callable[[Run], Any] | None = None,
        on_event: Callable[[RunEvent], Any] | None = None,
        progress: bool | None = None,
        raise_on_failure: bool = True,
        poll_interval: float = 0.5,
    ) -> Run:
        """Block until the run reaches a terminal status and return it.

        ``on_event`` receives every typed event (:class:`grad.PhaseEvent`, ``MetricEvent``,
        ``CheckpointEvent``, ``AttemptEvent``, ``WarningEvent``, ``LogEvent``, then
        ``CompletedEvent``) live; ``on_metric`` each :class:`grad.MetricPoint`; ``on_status``
        each status or phase change. ``progress`` draws a live progress line in a terminal (an
        auto-updating display in Jupyter): ``None`` (default) only when interactive, ``False``
        never. Transient errors are retried. Raises :class:`grad.RunFailedError` for ``failed``,
        ``cancelled``, ``stopped_budget`` and ``stopped_balance`` runs, as every SDK does
        (unless ``raise_on_failure=False``), and :class:`grad.WaitTimeoutError` after
        ``timeout`` seconds (the run keeps going). Ctrl-C stops waiting, not the run.
        """
        try:
            run = self._wait_terminal(run_id, timeout, poll_interval, on_metric, on_status, on_event, progress)
        except KeyboardInterrupt:
            print(
                f"\nStopped waiting; run {run_id} keeps going on the server. "
                f"Call wait() again to follow it, or cancel() to stop it.",
                file=sys.stderr,
            )
            raise
        if run.status != "completed" and raise_on_failure:
            hint = {
                "stopped_budget": " Raise the cap and continue with run.resume(max_cost_usd=...).",
                "stopped_balance": " Top up the workspace balance, then continue with run.resume().",
            }.get(run.status, "")
            raise RunFailedError(
                f"Run {run.id} ({run.name}) ended {run.status}: {run.error or 'no error reported'}.{hint}",
                resource=run,
                error=run.error,
                code=f"run_{run.status}",
            )
        return run

    def _wait_terminal(
        self,
        run_id: str,
        timeout: float | None,
        poll_interval: float,
        on_metric: Callable[[MetricPoint], Any] | None,
        on_status: Callable[[Run], Any] | None,
        on_event: Callable[[RunEvent], Any] | None,
        progress: bool | None,
    ) -> Run:
        deadline = self._deadline(timeout)
        run: Run | None = None
        last: tuple[str, str | None] | None = None

        def status_changed(current: Run) -> None:
            nonlocal last
            key = (current.status, current.phase)
            if key != last:
                last = key
                if on_status is not None:
                    on_status(current)

        reporter = _progress.create(progress)
        if reporter is not None:
            reporter.shown.update(_WARNED.pop(run_id, ()))
        if on_event is not None or on_metric is not None or reporter is not None:
            try:
                if reporter is not None or on_status is not None:
                    try:
                        start = self.get(run_id)
                        status_changed(start)
                        if reporter is not None:
                            reporter.start(start)
                    except TRANSIENT:
                        pass
                for event in self._follow_events(run_id, deadline):
                    if reporter is not None:
                        reporter.event(event)
                    if on_event is not None:
                        on_event(event)
                    if on_metric is not None and isinstance(event, MetricEvent):
                        on_metric(event.metric)
                    if isinstance(event, CompletedEvent) and event.run is not None:
                        run = event.run
                    elif isinstance(event, PhaseEvent) and on_status is not None:
                        try:
                            status_changed(self.get(run_id))
                        except TRANSIENT:
                            pass
            finally:
                if reporter is not None:
                    reporter.close()
            if run is None or run.status not in TERMINAL_RUN_STATUSES:
                run = None
        backoff = h.Backoff(poll_interval)
        while run is None or run.status not in TERMINAL_RUN_STATUSES:
            try:
                run = self.get(run_id)
            except TRANSIENT:
                pass
            if run is not None:
                status_changed(run)
            if run is not None and run.status in TERMINAL_RUN_STATUSES:
                break
            if self._expired(deadline):
                raise WaitTimeoutError(
                    f"Run {run_id} is still {run.status if run else 'unknown'} after {timeout or DEFAULT_WAIT_TIMEOUT:g}s; it keeps running "
                    "server-side. Call wait() again, or cancel() it.",
                    resource=run,
                )
            self._sleep(backoff.next(), deadline)
        status_changed(run)
        return run


class Checkpoints(_Resource):
    """``client.checkpoints``."""

    def promote(self, checkpoint_id: str, *, name: str | None = None) -> Artifact:
        """Copy a checkpoint into a new immutable artifact."""
        body = {} if name is None else {"name": h.check_slug(name, "artifact name")}
        return Artifact.from_api(self._wire.promote_checkpoint(checkpoint_id, body), self._client)


class Artifacts(_Resource):
    """``client.artifacts``: immutable trained artifacts (``name@YYYY-MM-DD-n``, ``name@latest``)."""

    def get(self, ref: Any) -> Artifact:
        """An artifact by ``name@version``, ``name@latest`` or id."""
        return Artifact.from_api(self._wire.get_artifact(model_ref(ref)), self._client)

    def list(self, *, name: str | None = None, search: str | None = None, limit: int | None = None) -> Page[Artifact]:
        """Artifacts, newest first; ``name`` keeps one name's versions, ``search`` names containing it (any case) or the exact id."""
        return self._page(Artifact, lambda cursor: self._wire.list_artifacts(name=name, q=search, limit=limit, cursor=cursor))

    def upload(
        self,
        path: str | os.PathLike[str],
        *,
        base: Any,
        format: str = "peft_lora",
        name: str | None = None,
        idempotency_key: str | None = None,
    ) -> ArtifactImport:
        """Register local weights as an artifact; ``.wait()`` on the result returns it (``name@YYYY-MM-DD-n``).

        ``path`` is a directory (tarred), a single file or a ``.tar``/``.tar.gz``. An import
        worker checks the files against the format spec and ``base`` (a catalog model id):
        for ``peft_lora``, ``adapter_config.json``, the base model and revision, the target
        modules and every tensor shape against the base's ``config.json``. A failure raises
        :class:`grad.ArtifactImportFailedError` from ``wait()`` (``code`` ``invalid_artifact``,
        status 422) naming the file. The result downloads, evaluates and continues training like a
        trained artifact. ``name`` defaults to the file or directory name.
        """
        source = Path(path).expanduser()
        body: dict[str, Any] = {
            "base_model": model_ref(base),
            "format": h.check_artifact_format(format),
            "name": h.check_slug(name if name is not None else h.artifact_name(source), "artifact name"),
        }
        with tempfile.TemporaryDirectory(prefix="grad-upload-") as workdir:
            packed = h.pack_artifact(source, Path(workdir))
            ticket = self._wire.create_upload(h.artifact_upload_request(packed))
            with open(packed, "rb") as fh:
                self._client._transport.upload(
                    ticket["url"],
                    fh,
                    length=packed.stat().st_size,
                    headers=ticket.get("headers") or {},
                    method=ticket.get("method") or "PUT",
                    timeout=max(self._client._transport.timeout, 300.0),
                )
        body["source"] = {"kind": "upload", "upload_id": ticket["upload_id"]}
        return self._create_import(body, idempotency_key)

    def from_hf(
        self,
        uri: str,
        *,
        base: Any,
        format: str = "peft_lora",
        name: str | None = None,
        revision: str | None = None,
        secret: str | None = None,
        idempotency_key: str | None = None,
    ) -> ArtifactImport:
        """Import weights from the Hugging Face Hub (``hf://owner/name[@revision]``); ``.wait()`` returns the artifact.

        The same checks as :meth:`upload`; the artifact pins the commit it imported
        (``provenance.uri``). ``secret`` names a workspace secret holding an HF token for
        gated or private repos. ``name`` defaults to the repo's name.
        """
        repo, rev = h.parse_hf_uri(uri, revision)
        source: dict[str, Any] = {"kind": "hf", "repo": repo}
        if rev is not None:
            source["revision"] = rev
        if secret is not None:
            source["secret"] = secret_name(secret)
        body: dict[str, Any] = {"source": source, "base_model": model_ref(base), "format": h.check_artifact_format(format)}
        if name is not None:
            body["name"] = h.check_slug(name, "artifact name")
        return self._create_import(body, idempotency_key)

    def get_import(self, import_id: str) -> ArtifactImport:
        """An upload or HF import (``artifacts.upload`` and ``from_hf`` wait for it)."""
        return ArtifactImport.from_api(self._wire.get_artifact_import(import_id), self._client)

    def _create_import(self, body: dict[str, Any], idempotency_key: str | None) -> ArtifactImport:
        return ArtifactImport.from_api(self._wire.create_artifact_import(body, idempotency_key=idempotency_key), self._client)

    def wait_import(self, import_id: str, *, timeout: float | None = None) -> Artifact:
        """Block until an upload or HF import finishes and return its artifact.

        Raises :class:`grad.ArtifactImportFailedError` (``code`` ``invalid_artifact``, status
        422, for files that break the format spec) when it failed.
        """
        deadline = self._deadline(timeout)
        backoff = h.Backoff()
        job = self.get_import(import_id)
        while job.status not in TERMINAL_IMPORT_STATUSES:
            if self._expired(deadline):
                raise WaitTimeoutError(
                    f"Artifact import {job.id} is still {job.status} after {timeout or DEFAULT_WAIT_TIMEOUT:g}s (is an import worker running?).",
                    resource=job,
                )
            self._sleep(backoff.next(), deadline)
            try:
                job = self.get_import(job.id)
            except TRANSIENT:
                continue
        if job.status == "failed" or not job.artifact_id:
            code = job.error_code or "artifact_import_failed"
            exc = ArtifactImportFailedError(f"Artifact import {job.id} ('{job.name}') failed: {job.error}", resource=job, error=job.error, code=code)
            exc.status = 422 if code == "invalid_artifact" else None
            raise exc
        return self.get(job.artifact_id)

    def delete(self, ref: Any) -> None:
        """Delete an artifact and its bundle. A pinned one (a published Cloud model version) raises ``ConflictError`` ``artifact_pinned``."""
        self._wire.delete_artifact(model_ref(ref))

    def download_url(self, ref: Any, *, timeout: float | None = None) -> ArtifactDownloadUrl:
        """A presigned URL of the artifact's bundle, valid 15 minutes: ``{url, expires_at, sha256, size_bytes, filename}``.

        Fetch it straight from storage (no API key); verify ``sha256``.
        """
        return self._wire.get_artifact_download_url(model_ref(ref), timeout=timeout)

    def download(
        self,
        ref: Any,
        path: str | os.PathLike[str] = ".",
        *,
        format: str = "peft",
        overwrite: bool = False,
        timeout: float | None = None,
    ) -> Path:
        """Download an artifact, verifying its SHA-256 while streaming (nothing is buffered in memory).

        * ``format="peft"`` (default): extract into directory ``path``, checking every file
          against the bundle manifest; the result loads with
          ``vllm serve <base> --enable-lora --lora-modules name=<path>`` (or is merged weights).
        * ``format="files"``: extract any artifact (routers, embeddings, cartridges).
        * ``format="bundle"``: keep the ``.grad.tar.gz`` (``path`` may be a file or a directory).

        A checksum mismatch or an unsafe archive entry deletes the partial download and raises.
        """
        art = self.get(ref)
        name = h.safe_file_name(str(art.name))
        filename = f"{name}-{art.version}.grad.tar.gz"
        plan = h.plan_download(path, fmt=format, filename=filename, overwrite=overwrite)
        resp = self._wire.download_artifact(art.ref, timeout=timeout or max(self._client._transport.timeout, 120.0))
        writer = h.HashingWriter(plan.temp_dir, f".{name}.")
        url = str(resp.url)
        try:
            try:
                for chunk in resp.iter_bytes():
                    writer.write(chunk)
            except httpx.TransportError as exc:
                raise self._client._transport.connection_error("GET", url, exc) from exc
            digest = writer.finish()
            h.verify_digest(digest, h.expected_sha(resp.headers.get("x-artifact-sha256"), art.sha256, url), url)
            if plan.format == "bundle":
                h.finalize_file(writer.path, plan.target)
                return plan.target
            return _extract(writer.path, plan, art.format, overwrite)
        except BaseException:
            writer.discard()
            raise
        finally:
            resp.close()
            if writer.path.exists() and plan.format != "bundle":
                writer.discard()


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


def _json(text: str) -> Any:
    return json.loads(text)


class Keys(_Resource):
    """``client.keys``: scoped workspace API keys."""

    def create(self, *, name: str, scopes: Sequence[str]) -> CreatedApiKey:
        """Create a key; the returned ``secret`` is shown only once."""
        return CreatedApiKey.from_api(self._wire.create_api_key({"name": h.check_slug(name, "key name"), "scopes": list(scopes)}), self._client)

    def list(self, *, limit: int | None = None) -> Page[ApiKey]:
        """Workspace keys."""
        return self._page(ApiKey, lambda cursor: self._wire.list_api_keys(limit=limit, cursor=cursor))

    def revoke(self, key_id: str) -> ApiKey:
        """Revoke a key."""
        return ApiKey.from_api(self._wire.revoke_api_key(key_id), self._client)


class Evals(_Resource):
    """``client.evals``: server-executed evaluations with optional local Python scorers."""

    def plan(
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
        dataset_version: int | None = None,
    ) -> EvalPlan:
        """Estimate tasks, model/judge calls and cost ($0)."""
        body, _ = h.eval_body(**_eval_kwargs(locals()))
        return EvalPlan.from_api(self._wire.plan_eval(body), self._client)

    def create(
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
        dataset_version: int | None = None,
        idempotency_key: str | None = None,
    ) -> Eval:
        """Queue an eval; chain ``.wait()`` (which also runs local ``Scorer`` functions).

        Local scorers are dry-run once on a sample record first, so a broken function fails
        before any model is called. The eval is billed (``ev.total_cost_usd``); ``evals.plan``
        estimates the cost at $0.
        """
        body, local = h.eval_body(**_eval_kwargs(locals()))
        if local is not None and local.local_scorers and dataset is not None:
            sample = next(iter(self._client.datasets.records(dataset, limit=1)), None)
            if sample is not None:
                local.dry_run(sample)
        ev = Eval.from_api(self._wire.create_eval(body, idempotency_key=idempotency_key), self._client)
        ev._local_rubric = local
        return ev

    def get(self, eval_id: str) -> Eval:
        """An eval by id."""
        return Eval.from_api(self._wire.get_eval(eval_id), self._client)

    def list(self, *, status: str | Iterable[str] | None = None, limit: int | None = None) -> Page[Eval]:
        """Evals, newest first; ``status`` keeps these statuses (``"running"`` or a list)."""
        statuses = _statuses(status)
        return self._page(Eval, lambda cursor: self._wire.list_evals(limit=limit, cursor=cursor, status=statuses))

    def cancel(self, eval_id: str) -> Eval:
        """Cancel a queued, running or awaiting_scores eval."""
        return Eval.from_api(self._wire.cancel_eval(eval_id), self._client)

    def outputs(self, eval_id: str, *, model: Any = None, missing_scorer: str | None = None, limit: int | None = None) -> Page[EvalOutput]:
        """Generated outputs (optionally only those still missing ``missing_scorer``)."""
        ref = None if model is None else model_ref(model)
        return self._page(EvalOutput, lambda cursor: self._wire.list_eval_outputs(eval_id, model=ref, missing_scorer=missing_scorer, limit=limit, cursor=cursor))

    def results(self, eval_id: str, *, model: Any = None, limit: int | None = None) -> Page[EvalResult]:
        """Per-task, per-model results."""
        ref = None if model is None else model_ref(model)
        return self._page(EvalResult, lambda cursor: self._wire.list_eval_results(eval_id, model=ref, limit=limit, cursor=cursor))

    def failures(self, eval_id: str, *, model: Any = None, threshold: float | None = None) -> EvalFailures:
        """Tasks scoring below ``threshold`` (default: the eval's pass threshold), all pages."""
        ref = None if model is None else model_ref(model)
        page = self._page(EvalResult, lambda cursor: self._wire.list_eval_failures(eval_id, model=ref, threshold=threshold, cursor=cursor))
        return EvalFailures(eval_id, page.to_list(), self._client)

    def post_scores(self, eval_id: str, scores: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
        """Post ``{"output_id", "scorer", "score"}`` items in requests of 1,000.

        Returns the last response with ``accepted`` summed over every request."""
        result: dict[str, Any] = {}
        accepted = 0
        items = list(scores)
        for start in range(0, len(items), h.SCORES_PER_REQUEST):
            result = dict(self._wire.post_eval_scores(eval_id, {"scores": items[start : start + h.SCORES_PER_REQUEST]}))
            accepted += int(result.get("accepted") or 0)
        return {**result, "accepted": accepted} if result else result

    def score_pending(self, eval_id: str, rubric: Any) -> int:
        """Run local scorers on every output still missing their score and post them."""
        ev = self.get(eval_id)
        if ev.status != "awaiting_scores" or not ev.local_scorers:
            return 0
        scorers = h.local_scorers_for(rubric, ev.local_scorers, eval_id)
        posted = 0
        for name, scorer in scorers.items():
            previous: set[str] = set()
            while True:
                outputs = self._wire.list_eval_outputs(eval_id, missing_scorer=name, limit=LIST_EVAL_OUTPUTS_LIMIT_MAX).get("data") or []
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
                self.post_scores(eval_id, batch)
                posted += len(batch)
        return posted

    def wait(self, eval_id: str, *, timeout: float | None = None, rubric: Any = None, raise_on_failure: bool = True, poll_interval: float = 0.5) -> Eval:
        """Block until the eval completes, scoring local Python scorers when it awaits them."""
        deadline = self._deadline(timeout)
        backoff = h.Backoff(poll_interval)
        while True:
            try:
                ev: Eval | None = self.get(eval_id)
            except TRANSIENT:
                ev = None
            if ev is not None:
                if ev.status == "awaiting_scores":
                    if self.score_pending(eval_id, rubric):
                        backoff.reset(poll_interval)
                        continue
                elif ev.status in TERMINAL_EVAL_STATUSES:
                    if ev.status == "failed" and raise_on_failure:
                        raise EvalFailedError(f"Eval {ev.id} ({ev.name}) failed: {ev.error or 'no error reported'}", resource=ev, error=ev.error)
                    ev._local_rubric = rubric
                    return ev
            if self._expired(deadline):
                raise WaitTimeoutError(f"Eval {eval_id} is still {ev.status if ev else 'unknown'} after {timeout or DEFAULT_WAIT_TIMEOUT:g}s.", resource=ev)
            self._sleep(backoff.next(), deadline)


def _eval_kwargs(values: Mapping[str, Any]) -> dict[str, Any]:
    keys = (
        "models",
        "name",
        "dataset",
        "dataset_version",
        "rubric",
        "baseline",
        "samples",
        "temperature",
        "max_tokens",
        "limit",
        "pass_threshold",
    )
    return {k: values[k] for k in keys}
