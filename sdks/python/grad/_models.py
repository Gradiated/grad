"""Typed objects returned by the API, with the documented convenience methods.

Every object is a dataclass with attribute access to the fields in ``spec/openapi.yaml``,
``.raw`` (the JSON the server sent, including any newer fields), ``obj["field"]`` and
``to_dict()``. Objects returned by :class:`grad.Grad` have blocking methods; the
``Async*`` twins returned by :class:`grad.AsyncGrad` have coroutine methods.
"""

from __future__ import annotations

import builtins
from collections.abc import AsyncIterator, Awaitable, Callable, Iterator, Mapping, Sequence
from dataclasses import MISSING, dataclass, field, fields
from pathlib import Path
from typing import Any, ClassVar, Generic, TypeVar

from ._errors import NotAvailableInV0Error, PaginationLoopError
from ._format import format_eval_plan, format_eval_summary, format_plan, format_render
from .records import Trajectory

T = TypeVar("T")
A = TypeVar("A", bound="APIObject")

__all__ = [
    "APIObject",
    "ApiKey",
    "Artifact",
    "AsyncArtifact",
    "AsyncCheckpoint",
    "AsyncDataset",
    "AsyncDeployment",
    "AsyncDeploymentStatus",
    "AsyncEval",
    "AsyncEvalFailures",
    "AsyncImportJob",
    "AsyncPage",
    "AsyncPager",
    "AsyncRouteDecision",
    "AsyncRun",
    "AttrDict",
    "Checkpoint",
    "CursorTrail",
    "CreatedApiKey",
    "Dataset",
    "Deployment",
    "DeploymentStatus",
    "Embeddings",
    "Eval",
    "EvalFailures",
    "EvalModelSummary",
    "EvalOutput",
    "EvalPlan",
    "EvalReport",
    "EvalResult",
    "FeedbackRecord",
    "FeedbackResult",
    "ImportJob",
    "MetricPoint",
    "Model",
    "Page",
    "Plan",
    "RenderPreview",
    "RouteDecision",
    "RouterParetoSummary",
    "Run",
]

TERMINAL_RUN_STATUSES = frozenset({"completed", "failed", "cancelled", "stopped_budget"})
TERMINAL_EVAL_STATUSES = frozenset({"completed", "failed", "cancelled"})
TERMINAL_IMPORT_STATUSES = frozenset({"completed", "failed"})


class AttrDict(dict[str, Any]):
    """A dict that also allows attribute access (``report.eval_loss`` or ``report["eval_loss"]``)."""

    def __getattr__(self, key: str) -> Any:
        if key.startswith("__"):
            raise AttributeError(key)
        try:
            value = self[key]
        except KeyError:
            known = ", ".join(sorted(self)) or "none"
            raise AttributeError(f"No field {key!r} (fields: {known}).") from None
        return AttrDict(value) if isinstance(value, dict) and not isinstance(value, AttrDict) else value


def _attrdict(value: Any, _client: Any) -> Any:
    return AttrDict(value) if isinstance(value, Mapping) else value


@dataclass(kw_only=True, repr=False, eq=False)
class APIObject:
    """Base of every API object: typed fields plus ``.raw`` and ``obj["field"]``."""

    raw: dict[str, Any] = field(default_factory=dict)
    _client: Any = None

    _repr_fields: ClassVar[tuple[str, ...]] = ("id",)
    _converters: ClassVar[dict[str, Callable[[Any, Any], Any]]] = {}

    @classmethod
    def from_api(cls: builtins.type[A], data: Mapping[str, Any] | None, client: Any = None) -> A:
        """Build the object from a JSON response."""
        payload = dict(data or {})
        kwargs: dict[str, Any] = {}
        converters = getattr(cls, "_converters", {})
        for f in fields(cls):
            if f.name in ("raw", "_client"):
                continue
            if f.name in payload:
                value = payload[f.name]
            elif f.default is not MISSING:
                value = f.default
            elif f.default_factory is not MISSING:
                value = f.default_factory()
            else:
                value = None
            conv = converters.get(f.name)
            if conv is not None and value is not None:
                value = conv(value, client)
            kwargs[f.name] = value
        return cls(raw=payload, _client=client, **kwargs)

    def __getattr__(self, name: str) -> Any:
        if name.startswith("_"):
            raise AttributeError(name)
        raw = self.__dict__.get("raw") or {}
        if name in raw:
            return raw[name]
        raise AttributeError(f"{type(self).__name__} has no attribute {name!r}.")

    def __getitem__(self, key: str) -> Any:
        return self.raw[key]

    def get(self, key: str, default: Any = None) -> Any:
        """``raw.get(key, default)``."""
        return self.raw.get(key, default)

    def to_dict(self) -> dict[str, Any]:
        """A copy of the JSON the server returned."""
        return dict(self.raw)

    def _update_from(self, other: APIObject) -> None:
        for f in fields(self):
            setattr(self, f.name, getattr(other, f.name))

    def _need_client(self) -> Any:
        if self._client is None:
            raise RuntimeError(f"This {type(self).__name__} is not bound to a client; get it through Grad() to call methods.")
        return self._client

    def __eq__(self, other: object) -> bool:
        return type(self) is type(other) and self.raw == other.raw

    def __repr__(self) -> str:
        parts = []
        for name in self._repr_fields:
            value = getattr(self, name, None)
            if value is not None:
                parts.append(f"{name}={value!r}")
        return f"{type(self).__name__}({', '.join(parts)})"


def _is_async(client: Any) -> bool:
    return bool(getattr(client, "_is_async", False))


# ------------------------------------------------------------------------------- pages


MAX_COLLECT_ITEMS = 200_000
"""Upper bound on items a collect-all helper (``to_list()``, ``checkpoints()``, ``failures()``) buffers."""


def _too_many(endpoint: str, cursor: Any, max_items: int) -> PaginationLoopError:
    return PaginationLoopError(
        endpoint,
        str(cursor or ""),
        message=f"{endpoint} returned more than {max_items:,} items; iterate the pages instead of collecting them all.",
    )


class CursorTrail:
    """Remembers the cursors a list walk has followed so a server that repeats one cannot loop it forever.

    :meth:`follow` returns the cursor to request next, or ``None`` when the walk is over
    (no ``next_cursor``, or an empty page), and raises :class:`grad.PaginationLoopError`
    when ``next_cursor`` repeats a cursor this walk already requested.
    """

    def __init__(self, endpoint: str) -> None:
        self.endpoint = endpoint
        self._owners: dict[str, int] = {}
        self._pages = 0

    def register(self) -> int:
        """A fresh id for a page in this walk."""
        self._pages += 1
        return self._pages

    def follow(self, next_cursor: Any, data: Sequence[Any], *, page_id: int = 0) -> str | None:
        """The next cursor to request after a page with ``data`` and ``next_cursor``."""
        if not next_cursor or not data:
            return None
        cursor = str(next_cursor)
        owner = self._owners.get(cursor)
        if owner is not None and (page_id == 0 or owner != page_id):
            raise PaginationLoopError(self.endpoint, cursor)
        self._owners[cursor] = page_id
        return cursor


class Page(Generic[T]):
    """One page of a list endpoint. Iterating it walks every following page too.

    The walk stops at an empty page and raises :class:`grad.PaginationLoopError` if the
    server repeats a cursor, so a buggy server cannot make iteration loop forever.
    """

    def __init__(
        self,
        data: list[T],
        next_cursor: str | None,
        fetch_next: Callable[[str], Page[T]] | None = None,
        *,
        trail: CursorTrail | None = None,
    ) -> None:
        self.data = data
        self.next_cursor = next_cursor
        self._fetch_next = fetch_next
        self._trail = trail or CursorTrail("list")
        self._id = self._trail.register()

    @property
    def has_more(self) -> bool:
        """True when another page exists (an empty page ends the list)."""
        return bool(self.next_cursor) and bool(self.data)

    def next_page(self) -> Page[T] | None:
        """Fetch the next page, or ``None`` at the end."""
        if self._fetch_next is None:
            return None
        cursor = self._trail.follow(self.next_cursor, self.data, page_id=self._id)
        if cursor is None:
            return None
        page = self._fetch_next(cursor)
        if page._trail is not self._trail:
            page._trail = self._trail
            page._id = self._trail.register()
        return page

    def iter_pages(self) -> Iterator[Page[T]]:
        """Yield this page and every following page."""
        page: Page[T] | None = self
        while page is not None:
            yield page
            page = page.next_page()

    def __iter__(self) -> Iterator[T]:
        for page in self.iter_pages():
            yield from page.data

    def to_list(self, *, max_items: int = MAX_COLLECT_ITEMS) -> list[T]:
        """Collect every item of every page (raises :class:`grad.PaginationLoopError` past ``max_items``)."""
        items: list[T] = []
        for page in self.iter_pages():
            items.extend(page.data)
            if len(items) > max_items:
                raise _too_many(self._trail.endpoint, page.next_cursor, max_items)
        return items

    def __repr__(self) -> str:
        return f"Page({len(self.data)} items, has_more={self.has_more})"


class AsyncPage(Generic[T]):
    """One page of a list endpoint (async). ``async for`` walks every following page.

    Stops at an empty page and raises :class:`grad.PaginationLoopError` on a repeated cursor.
    """

    def __init__(
        self,
        data: list[T],
        next_cursor: str | None,
        fetch_next: Callable[[str], Awaitable[AsyncPage[T]]] | None = None,
        *,
        trail: CursorTrail | None = None,
    ) -> None:
        self.data = data
        self.next_cursor = next_cursor
        self._fetch_next = fetch_next
        self._trail = trail or CursorTrail("list")
        self._id = self._trail.register()

    @property
    def has_more(self) -> bool:
        """True when another page exists (an empty page ends the list)."""
        return bool(self.next_cursor) and bool(self.data)

    async def next_page(self) -> AsyncPage[T] | None:
        """Fetch the next page, or ``None`` at the end."""
        if self._fetch_next is None:
            return None
        cursor = self._trail.follow(self.next_cursor, self.data, page_id=self._id)
        if cursor is None:
            return None
        page = await self._fetch_next(cursor)
        if page._trail is not self._trail:
            page._trail = self._trail
            page._id = self._trail.register()
        return page

    async def iter_pages(self) -> AsyncIterator[AsyncPage[T]]:
        """Yield this page and every following page."""
        page: AsyncPage[T] | None = self
        while page is not None:
            yield page
            page = await page.next_page()

    async def __aiter__(self) -> AsyncIterator[T]:
        async for page in self.iter_pages():
            for item in page.data:
                yield item

    def __repr__(self) -> str:
        return f"AsyncPage({len(self.data)} items, has_more={self.has_more})"


class AsyncPager(Generic[T]):
    """``await pager`` gives the first :class:`AsyncPage`; ``async for item in pager`` walks all items."""

    def __init__(self, first: Callable[[], Awaitable[AsyncPage[T]]]) -> None:
        self._first = first

    def __await__(self) -> Any:
        return self._first().__await__()

    async def __aiter__(self) -> AsyncIterator[T]:
        page = await self._first()
        async for item in page:
            yield item

    async def to_list(self, *, max_items: int = MAX_COLLECT_ITEMS) -> list[T]:
        """Collect every item (raises :class:`grad.PaginationLoopError` past ``max_items``)."""
        first = await self._first()
        items: list[T] = []
        async for page in first.iter_pages():
            items.extend(page.data)
            if len(items) > max_items:
                raise _too_many(first._trail.endpoint, page.next_cursor, max_items)
        return items


# ------------------------------------------------------------------------------ models


@dataclass(kw_only=True, repr=False, eq=False)
class Model(APIObject):
    """A trainable base model from the server catalog (the price source for plans)."""

    id: str
    hf_repo: str | None = None
    family: str | None = None
    adapters: list[str] = field(default_factory=list)
    recipes: list[str] = field(default_factory=list)
    default_for: list[str] = field(default_factory=list)
    price_per_million_tokens_usd: float | None = None
    max_context_tokens: int | None = None
    template_revision: str | None = None
    calibrated_lrs: dict[str, float] = field(default_factory=dict)

    def __str__(self) -> str:
        return self.id


# ---------------------------------------------------------------------------- datasets


@dataclass(kw_only=True, repr=False, eq=False)
class _DatasetData(APIObject):
    id: str
    name: str
    workspace_id: str | None = None
    version: int = 0
    record_count: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)
    created_at: str | None = None
    updated_at: str | None = None

    _repr_fields = ("name", "version", "record_count")

    def __str__(self) -> str:
        return self.name

    def _unavailable(self, method: str) -> NotAvailableInV0Error:
        return NotAvailableInV0Error(
            f"Dataset.{method}()",
            "server-side scoring and filtering of datasets is deferred past v0.",
            alternative="Evaluate with client.evals.create(...) and mine failures with ev.failures(...).to_dataset(name), "
            "or filter records locally and push them to a new dataset.",
        )


class Dataset(_DatasetData):
    """A versioned dataset. Every push appends a new version; runs pin the version they used."""

    def refresh(self) -> Dataset:
        """Reload from the server (in place) and return ``self``."""
        self._update_from(self._need_client().datasets.get(self.name))
        return self

    def count(self) -> int:
        """Current number of records (reloads the dataset)."""
        return self.refresh().record_count

    def push(self, records: Any, **kwargs: Any) -> Dataset:
        """Append records or a file (see ``client.datasets.push``); updates ``self``."""
        self._update_from(self._need_client().datasets.push(self.name, records, **kwargs))
        return self

    def import_file(self, path: str | Path, *, connector: str = "auto", format: str = "auto") -> ImportJob:
        """Upload a JSONL/JSON/Parquet file and start an import job; call ``.wait()`` on it."""
        job: ImportJob = self._need_client().datasets.import_file(self.name, path, connector=connector, format=format)
        return job

    def render(self, **kwargs: Any) -> RenderPreview:
        """Preview chat-template rendering and loss masks (see ``client.datasets.render``)."""
        preview: RenderPreview = self._need_client().datasets.render(self.name, **kwargs)
        return preview

    def records(self, *, version: int | None = None, limit: int | None = None) -> Iterator[dict[str, Any]]:
        """Iterate the records of a version (the latest by default)."""
        records: Iterator[dict[str, Any]] = self._need_client().datasets.records(self.name, version=version, limit=limit)
        return records

    def score(self, *args: Any, **kwargs: Any) -> Any:
        """Not available in v0."""
        raise self._unavailable("score")

    def filter(self, *args: Any, **kwargs: Any) -> Any:
        """Not available in v0."""
        raise self._unavailable("filter")

    def add_source(self, *args: Any, **kwargs: Any) -> Any:
        """Not available in v0."""
        raise self._unavailable("add_source")


class AsyncDataset(_DatasetData):
    """A versioned dataset (async methods)."""

    async def refresh(self) -> AsyncDataset:
        """Reload from the server (in place) and return ``self``."""
        self._update_from(await self._need_client().datasets.get(self.name))
        return self

    async def count(self) -> int:
        """Current number of records (reloads the dataset)."""
        return (await self.refresh()).record_count

    async def push(self, records: Any, **kwargs: Any) -> AsyncDataset:
        """Append records or a file; updates ``self``."""
        self._update_from(await self._need_client().datasets.push(self.name, records, **kwargs))
        return self

    async def import_file(self, path: str | Path, *, connector: str = "auto", format: str = "auto") -> AsyncImportJob:
        """Upload a file and start an import job; ``await job.wait()``."""
        job: AsyncImportJob = await self._need_client().datasets.import_file(self.name, path, connector=connector, format=format)
        return job

    async def render(self, **kwargs: Any) -> RenderPreview:
        """Preview chat-template rendering and loss masks."""
        preview: RenderPreview = await self._need_client().datasets.render(self.name, **kwargs)
        return preview

    def records(self, *, version: int | None = None, limit: int | None = None) -> AsyncIterator[dict[str, Any]]:
        """Iterate the records of a version (``async for``)."""
        records: AsyncIterator[dict[str, Any]] = self._need_client().datasets.records(self.name, version=version, limit=limit)
        return records

    async def score(self, *args: Any, **kwargs: Any) -> Any:
        """Not available in v0."""
        raise self._unavailable("score")

    async def filter(self, *args: Any, **kwargs: Any) -> Any:
        """Not available in v0."""
        raise self._unavailable("filter")


@dataclass(kw_only=True, repr=False, eq=False)
class _ImportData(APIObject):
    id: str
    dataset: str
    status: str
    workspace_id: str | None = None
    source: dict[str, Any] = field(default_factory=dict)
    connector: str = "auto"
    attempt: int = 0
    imported_count: int = 0
    dropped_count: int = 0
    detected_scores: list[str] = field(default_factory=list)
    drop_reasons: list[str] = field(default_factory=list)
    dataset_version: int | None = None
    error: str | None = None
    created_at: str | None = None
    updated_at: str | None = None

    _repr_fields = ("id", "dataset", "status", "imported_count", "dropped_count")

    @property
    def done(self) -> bool:
        """True once the import completed or failed."""
        return self.status in TERMINAL_IMPORT_STATUSES


class ImportJob(_ImportData):
    """An asynchronous file or Hugging Face import into a dataset (run by a trainer worker)."""

    def refresh(self) -> ImportJob:
        """Reload from the server (in place)."""
        self._update_from(self._need_client().imports.get(self.id))
        return self

    def wait(self, *, timeout: float | None = None, poll_interval: float = 0.5) -> ImportJob:
        """Block until the import finishes; raises :class:`grad.ImportFailedError` if it failed."""
        self._update_from(self._need_client().imports.wait(self.id, timeout=timeout, poll_interval=poll_interval))
        return self

    def get_dataset(self) -> Dataset:
        """The dataset the records were imported into."""
        dataset: Dataset = self._need_client().datasets.get(self.dataset)
        return dataset


class AsyncImportJob(_ImportData):
    """An asynchronous import (async methods)."""

    async def refresh(self) -> AsyncImportJob:
        """Reload from the server (in place)."""
        self._update_from(await self._need_client().imports.get(self.id))
        return self

    async def wait(self, *, timeout: float | None = None, poll_interval: float = 0.5) -> AsyncImportJob:
        """Wait until the import finishes; raises :class:`grad.ImportFailedError` if it failed."""
        self._update_from(await self._need_client().imports.wait(self.id, timeout=timeout, poll_interval=poll_interval))
        return self

    async def get_dataset(self) -> AsyncDataset:
        """The dataset the records were imported into."""
        dataset: AsyncDataset = await self._need_client().datasets.get(self.dataset)
        return dataset


@dataclass(kw_only=True, repr=False, eq=False)
class RenderPreview(APIObject):
    """How records render under a model's chat template, with trained spans marked."""

    dataset: str
    model: str
    template_revision: str | None = None
    token_counts: str | None = None
    examples: list[dict[str, Any]] = field(default_factory=list)

    _repr_fields = ("dataset", "model", "template_revision")

    def __str__(self) -> str:
        return format_render(self)


# -------------------------------------------------------------------------------- runs


@dataclass(kw_only=True, repr=False, eq=False)
class Plan(APIObject):
    """A $0 dry run: every resolved default, warnings, token and cost estimate. ``print(plan)``."""

    resolved_config: AttrDict = field(default_factory=AttrDict)
    dataset_version: int = 0
    usable_records: int = 0
    total_records: int = 0
    estimated_steps: int = 0
    estimated_tokens: int = 0
    estimated_cost_usd: float = 0.0
    price_per_million_tokens: float = 0.0
    trained_token_fraction: float = 0.0
    warnings: list[str] = field(default_factory=list)
    max_cost_usd: float | None = None

    _repr_fields = ("estimated_steps", "estimated_tokens", "estimated_cost_usd")
    _converters: ClassVar[dict[str, Callable[[Any, Any], Any]]] = {"resolved_config": _attrdict}

    @property
    def resolved_recipe(self) -> AttrDict:
        """Alias of ``resolved_config`` (the name used in the docs)."""
        return self.resolved_config

    def __str__(self) -> str:
        return format_plan(self, self.max_cost_usd)


@dataclass(kw_only=True, repr=False, eq=False)
class MetricPoint(APIObject):
    """One training step's metrics (``m.step``, ``m.loss``, running ``m.tokens`` and ``m.cost_usd``)."""

    step: int = 0
    loss: float | None = None
    seq: int | None = None
    attempt: int | None = None
    eval_loss: float | None = None
    eval_metrics: dict[str, float | None] | None = None
    """Held-out metrics of an eval step by name (including the selection metric); ``None`` between evals."""
    grad_norm: float | None = None
    lr: float | None = None
    tokens_per_sec: float | None = None
    tokens: int = 0
    cost_usd: float = 0.0
    timestamp: str | None = None

    _repr_fields = ("step", "loss", "eval_metrics", "cost_usd")


@dataclass(kw_only=True, repr=False, eq=False)
class RouterParetoSummary(APIObject):
    """Router quality vs. cost on the held-out report fold, against the fallback model."""

    target_max_drop: float = 0.0
    routed_quality: float | None = None
    quality_drop: float | None = None
    quality_drop_ci95: list[float] | None = None
    offload_rate: float | None = None
    cost_savings_pct: float | None = None
    ece: float | None = None
    threshold: float | None = None
    temperature: float = 1.0

    _repr_fields = ("quality_drop", "quality_drop_ci95", "offload_rate", "cost_savings_pct", "ece")


def _pareto(value: Any, client: Any) -> Any:
    return RouterParetoSummary.from_api(value, client) if isinstance(value, Mapping) else value


@dataclass(kw_only=True, repr=False, eq=False)
class EvalReport(APIObject):
    """A run's held-out ``eval_report``: the shared core plus the fields its recipe writes.

    Fields a recipe does not write stay ``None``; every key the server sent is in ``.raw``.
    """

    metric_name: str = ""
    selected_step: int = 0
    best_step: int | None = None
    final_step: int = 0
    train_records: int = 0
    eval_records: int = 0
    warnings: list[str] = field(default_factory=list)
    eval_loss: float | None = None
    eval_token_accuracy: float | None = None
    preference_accuracy: float | None = None
    reward_margin: float | None = None
    eval_kl: float | None = None
    kl_reduction: float | None = None
    recall_at_1: float | None = None
    recall_at_5: float | None = None
    recall_at_10: float | None = None
    mrr: float | None = None
    ece: float | None = None
    candidates: list[str] | None = None
    fallback_model: str | None = None
    fallback_quality: float | None = None
    pareto_summary: RouterParetoSummary | None = None
    heads: AttrDict | None = None

    _repr_fields = ("metric_name", "selected_step", "eval_loss", "preference_accuracy", "eval_kl", "recall_at_10", "pareto_summary")
    _converters: ClassVar[dict[str, Callable[[Any, Any], Any]]] = {"pareto_summary": _pareto, "heads": _attrdict}

    @property
    def metric(self) -> float | None:
        """The value of the selection metric (``metric_name``)."""
        value = self.raw.get(self.metric_name)
        return float(value) if isinstance(value, (int, float)) else None


def _eval_report(value: Any, client: Any) -> Any:
    return EvalReport.from_api(value, client) if isinstance(value, Mapping) else value


def _metric(value: Any, client: Any) -> Any:
    return MetricPoint.from_api(value, client) if isinstance(value, Mapping) else value


@dataclass(kw_only=True, repr=False, eq=False)
class _RunData(APIObject):
    id: str
    name: str
    status: str
    workspace_id: str | None = None
    dataset_id: str | None = None
    dataset_name: str | None = None
    dataset_version: int | None = None
    recipe_kind: str | None = None
    resolved_config: AttrDict = field(default_factory=AttrDict)
    max_cost_usd: float | None = None
    price_per_million_tokens: float | None = None
    tokens_processed: int = 0
    cost_usd: float = 0.0
    current_step: int = 0
    total_steps: int = 0
    attempt: int = 0
    max_attempts: int | None = None
    latest_metric: MetricPoint | None = None
    eval_report: EvalReport | None = None
    artifact_id: str | None = None
    error: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    finished_at: str | None = None

    _repr_fields = ("id", "name", "status", "current_step", "total_steps")
    _converters: ClassVar[dict[str, Callable[[Any, Any], Any]]] = {
        "resolved_config": _attrdict,
        "eval_report": _eval_report,
        "latest_metric": _metric,
    }

    @property
    def done(self) -> bool:
        """True once the run reached a terminal status."""
        return self.status in TERMINAL_RUN_STATUSES

    @property
    def succeeded(self) -> bool:
        """True when the run completed (or stopped at its budget with an artifact)."""
        return self.status == "completed" or (self.status == "stopped_budget" and self.artifact_id is not None)

    def _no_artifact(self) -> RuntimeError:
        hint = "" if self.done else " It is still running: call run.wait() first."
        return RuntimeError(f"Run {self.id} ({self.status}) has no artifact.{hint}")

    def then(self, *args: Any, **kwargs: Any) -> Any:
        """Not available in v0 (run chaining)."""
        raise NotAvailableInV0Error(
            "Run.then()",
            "multi-stage run chains are deferred past v0 (and v0 servers cannot continue training from an artifact).",
            alternative="Wait for the first run, then create the next one.",
        )


class Run(_RunData):
    """A training run. ``wait()``, stream ``metrics(follow=True)``, then ``deploy()`` or download."""

    def refresh(self) -> Run:
        """Reload from the server (in place)."""
        self._update_from(self._need_client().runs.get(self.id))
        return self

    def wait(
        self,
        *,
        timeout: float | None = None,
        on_metric: Callable[[MetricPoint], Any] | None = None,
        on_status: Callable[[Run], Any] | None = None,
        raise_on_failure: bool = True,
    ) -> Run:
        """Block until the run finishes (in place). See ``client.runs.wait``."""
        final = self._need_client().runs.wait(self.id, timeout=timeout, on_metric=on_metric, on_status=on_status, raise_on_failure=raise_on_failure)
        self._update_from(final)
        return self

    def metrics(self, *, follow: bool = False) -> Iterator[MetricPoint]:
        """All metric points so far, or (``follow=True``) a live SSE stream until the run ends."""
        stream: Iterator[MetricPoint] = self._need_client().runs.metrics(self.id, follow=follow)
        return stream

    def cancel(self) -> Run:
        """Cancel the run (a running attempt stops and is billed)."""
        self._update_from(self._need_client().runs.cancel(self.id))
        return self

    def resume(self, *, max_cost_usd: float | None = None) -> Run:
        """Resume from the latest checkpoint, optionally raising the cap."""
        self._update_from(self._need_client().runs.resume(self.id, max_cost_usd=max_cost_usd))
        return self

    def checkpoints(self) -> list[Checkpoint]:
        """Unexpired checkpoints, oldest step first."""
        checkpoints: list[Checkpoint] = self._need_client().runs.checkpoints(self.id)
        return checkpoints

    @property
    def artifact(self) -> Artifact | None:
        """The run's artifact (fetched), or ``None`` until it has one."""
        if not self.artifact_id:
            return None
        artifact: Artifact = self._need_client().artifacts.get(self.artifact_id)
        return artifact

    def deploy(self, *, name: str | None = None, fallback: str | None = None, explore_rate: float | None = None) -> Deployment:
        """Deploy the run's artifact (Gradiated Cloud). Self-hosted servers raise ``DeployUnavailableError``."""
        if not self.artifact_id:
            raise self._no_artifact()
        deployment: Deployment = self._need_client().deploy(self.artifact_id, name=name, fallback=fallback, explore_rate=explore_rate)
        return deployment

    def download(self, path: str | Path, *, format: str = "peft", overwrite: bool = False) -> Path:
        """Download the run's artifact (see ``Artifact.download``)."""
        if not self.artifact_id:
            raise self._no_artifact()
        target: Path = self._need_client().artifacts.download(self.artifact_id, path, format=format, overwrite=overwrite)
        return target


class AsyncRun(_RunData):
    """A training run (async methods)."""

    async def refresh(self) -> AsyncRun:
        """Reload from the server (in place)."""
        self._update_from(await self._need_client().runs.get(self.id))
        return self

    async def wait(
        self,
        *,
        timeout: float | None = None,
        on_metric: Callable[[MetricPoint], Any] | None = None,
        on_status: Callable[[AsyncRun], Any] | None = None,
        raise_on_failure: bool = True,
    ) -> AsyncRun:
        """Wait until the run finishes (in place)."""
        final = await self._need_client().runs.wait(self.id, timeout=timeout, on_metric=on_metric, on_status=on_status, raise_on_failure=raise_on_failure)
        self._update_from(final)
        return self

    def metrics(self, *, follow: bool = False) -> AsyncIterator[MetricPoint]:
        """Metric points (``async for``); ``follow=True`` streams live until the run ends."""
        stream: AsyncIterator[MetricPoint] = self._need_client().runs.metrics(self.id, follow=follow)
        return stream

    async def cancel(self) -> AsyncRun:
        """Cancel the run."""
        self._update_from(await self._need_client().runs.cancel(self.id))
        return self

    async def resume(self, *, max_cost_usd: float | None = None) -> AsyncRun:
        """Resume from the latest checkpoint."""
        self._update_from(await self._need_client().runs.resume(self.id, max_cost_usd=max_cost_usd))
        return self

    async def checkpoints(self) -> list[AsyncCheckpoint]:
        """Unexpired checkpoints, oldest step first."""
        checkpoints: list[AsyncCheckpoint] = await self._need_client().runs.checkpoints(self.id)
        return checkpoints

    async def get_artifact(self) -> AsyncArtifact | None:
        """The run's artifact (fetched), or ``None`` until it has one."""
        if not self.artifact_id:
            return None
        artifact: AsyncArtifact = await self._need_client().artifacts.get(self.artifact_id)
        return artifact

    @property
    def artifact(self) -> Awaitable[AsyncArtifact | None]:
        """``await run.artifact`` fetches the run's artifact (``None`` until it has one)."""
        return self.get_artifact()

    async def deploy(self, *, name: str | None = None, fallback: str | None = None, explore_rate: float | None = None) -> AsyncDeployment:
        """Deploy the run's artifact."""
        if not self.artifact_id:
            raise self._no_artifact()
        deployment: AsyncDeployment = await self._need_client().deploy(self.artifact_id, name=name, fallback=fallback, explore_rate=explore_rate)
        return deployment

    async def download(self, path: str | Path, *, format: str = "peft", overwrite: bool = False) -> Path:
        """Download the run's artifact."""
        if not self.artifact_id:
            raise self._no_artifact()
        target: Path = await self._need_client().artifacts.download(self.artifact_id, path, format=format, overwrite=overwrite)
        return target


@dataclass(kw_only=True, repr=False, eq=False)
class _CheckpointData(APIObject):
    id: str
    run_id: str
    step: int = 0
    workspace_id: str | None = None
    attempt: int | None = None
    eval_score: float | None = None
    format: str | None = None
    sha256: str | None = None
    size_bytes: int = 0
    metadata: dict[str, Any] = field(default_factory=dict)
    best: bool = False
    final: bool = False
    expires_at: str | None = None
    created_at: str | None = None

    _repr_fields = ("id", "step", "eval_score", "best", "final")


class Checkpoint(_CheckpointData):
    """A saved training checkpoint; ``promote(name=...)`` keeps it as an artifact."""

    def promote(self, *, name: str | None = None) -> Artifact:
        """Copy this checkpoint into a new immutable artifact (``name@date-n``)."""
        artifact: Artifact = self._need_client().checkpoints.promote(self.id, name=name)
        return artifact


class AsyncCheckpoint(_CheckpointData):
    """A saved training checkpoint (async)."""

    async def promote(self, *, name: str | None = None) -> AsyncArtifact:
        """Copy this checkpoint into a new immutable artifact."""
        artifact: AsyncArtifact = await self._need_client().checkpoints.promote(self.id, name=name)
        return artifact


# --------------------------------------------------------------------------- artifacts


@dataclass(kw_only=True, repr=False, eq=False)
class _ArtifactData(APIObject):
    id: str
    name: str
    version: str
    workspace_id: str | None = None
    run_id: str | None = None
    checkpoint_id: str | None = None
    base_model: str | None = None
    recipe_kind: str | None = None
    format: str | None = None
    sha256: str | None = None
    size_bytes: int = 0
    manifest: AttrDict = field(default_factory=AttrDict)
    eval_report: EvalReport | None = None
    created_at: str | None = None

    _repr_fields = ("id", "format", "base_model", "size_bytes")
    _converters: ClassVar[dict[str, Callable[[Any, Any], Any]]] = {"manifest": _attrdict, "eval_report": _eval_report}

    @property
    def ref(self) -> str:
        """``name@version``, the reference you pass as ``model=`` or to ``deploy``."""
        return f"{self.name}@{self.version}" if self.name and self.version else self.id

    def __str__(self) -> str:
        return self.ref

    def _no_inference(self, method: str) -> NotAvailableInV0Error:
        return NotAvailableInV0Error(
            f"Artifact.{method}()",
            "direct inference from an artifact handle is deferred past v0.",
            alternative="Deploy it (Gradiated Cloud) and call it with the OpenAI SDK, or download it and serve it on vLLM/SGLang.",
        )


class Artifact(_ArtifactData):
    """An immutable trained artifact (``name@YYYY-MM-DD-n``)."""

    def refresh(self) -> Artifact:
        """Reload from the server (in place)."""
        self._update_from(self._need_client().artifacts.get(self.id))
        return self

    def deploy(self, *, name: str | None = None, fallback: str | None = None, explore_rate: float | None = None) -> Deployment:
        """Deploy under ``your-org/<name>`` (Gradiated Cloud)."""
        deployment: Deployment = self._need_client().deploy(self.ref, name=name, fallback=fallback, explore_rate=explore_rate)
        return deployment

    def download(self, path: str | Path, *, format: str = "peft", overwrite: bool = False) -> Path:
        """Download and verify (SHA-256); ``format="peft"`` extracts a vLLM-loadable directory."""
        target: Path = self._need_client().artifacts.download(self.ref, path, format=format, overwrite=overwrite)
        return target

    def infer(self, *args: Any, **kwargs: Any) -> Any:
        """Not available in v0."""
        raise self._no_inference("infer")

    def infer_batch(self, *args: Any, **kwargs: Any) -> Any:
        """Not available in v0."""
        raise self._no_inference("infer_batch")

    def embed(self, *args: Any, **kwargs: Any) -> Any:
        """Not available in v0 (deploy and use client.embeddings.create)."""
        raise self._no_inference("embed")


class AsyncArtifact(_ArtifactData):
    """An immutable trained artifact (async)."""

    async def refresh(self) -> AsyncArtifact:
        """Reload from the server (in place)."""
        self._update_from(await self._need_client().artifacts.get(self.id))
        return self

    async def deploy(self, *, name: str | None = None, fallback: str | None = None, explore_rate: float | None = None) -> AsyncDeployment:
        """Deploy under ``your-org/<name>``."""
        deployment: AsyncDeployment = await self._need_client().deploy(self.ref, name=name, fallback=fallback, explore_rate=explore_rate)
        return deployment

    async def download(self, path: str | Path, *, format: str = "peft", overwrite: bool = False) -> Path:
        """Download and verify; ``format="peft"`` extracts a vLLM-loadable directory."""
        target: Path = await self._need_client().artifacts.download(self.ref, path, format=format, overwrite=overwrite)
        return target


# ------------------------------------------------------------------------- deployments


@dataclass(kw_only=True, repr=False, eq=False)
class _DeploymentData(APIObject):
    id: str
    name: str
    model_id: str | None = None
    workspace_id: str | None = None
    active_artifact_id: str | None = None
    previous_artifact_id: str | None = None
    fallback_model: str | None = None
    explore_rate: float = 0.0
    status: str | None = None
    created_at: str | None = None
    updated_at: str | None = None

    _repr_fields = ("name", "model_id", "active_artifact_id", "status")


class Deployment(_DeploymentData):
    """A stable model name pointing at one artifact version."""

    def rollback(self) -> Deployment:
        """Point back at the previous artifact (in place)."""
        self._update_from(self._need_client().deployments.rollback(self.name))
        return self

    def status_summary(self) -> DeploymentStatus:
        """Feedback count and average score."""
        status: DeploymentStatus = self._need_client().deployments.get(self.name)
        return status


class AsyncDeployment(_DeploymentData):
    """A deployment (async)."""

    async def rollback(self) -> AsyncDeployment:
        """Point back at the previous artifact (in place)."""
        self._update_from(await self._need_client().deployments.rollback(self.name))
        return self

    async def status_summary(self) -> AsyncDeploymentStatus:
        """Feedback count and average score."""
        status: AsyncDeploymentStatus = await self._need_client().deployments.get(self.name)
        return status


def _deployment(value: Any, client: Any) -> Any:
    cls = AsyncDeployment if _is_async(client) else Deployment
    return cls.from_api(value, client) if isinstance(value, Mapping) else value


@dataclass(kw_only=True, repr=False, eq=False)
class DeploymentStatus(APIObject):
    """A deployment with its feedback summary."""

    deployment: Deployment | None = None
    feedback_count: int = 0
    average_score: float | None = None

    _repr_fields = ("deployment", "feedback_count", "average_score")
    _converters: ClassVar[dict[str, Callable[[Any, Any], Any]]] = {"deployment": _deployment}


class AsyncDeploymentStatus(DeploymentStatus):
    """A deployment with its feedback summary (``deployment`` is an :class:`AsyncDeployment`)."""


@dataclass(kw_only=True, repr=False, eq=False)
class _RouteData(APIObject):
    inference_id: str
    model: str
    deployment: str | None = None
    artifact_id: str | None = None
    is_exploration: bool = False
    confidence: float | None = None
    scores: dict[str, float] = field(default_factory=dict)

    _repr_fields = ("model", "confidence", "inference_id")

    def _feedback_kwargs(self, score: float | None, metrics: Mapping[str, float] | None, expected_output: Any, idempotency_key: str | None) -> dict[str, Any]:
        return {
            "inference_id": self.inference_id,
            "deployment_name": self.deployment,
            "score": score,
            "metrics": metrics,
            "expected_output": expected_output,
            "idempotency_key": idempotency_key,
        }


class RouteDecision(_RouteData):
    """Which model a router picked; call ``record_feedback(...)`` once you know the outcome."""

    def record_feedback(
        self,
        *,
        score: float | None = None,
        metrics: Mapping[str, float] | None = None,
        expected_output: Any = None,
        idempotency_key: str | None = None,
    ) -> FeedbackResult:
        """Log the outcome of this routed request (deduplicated by ``idempotency_key``)."""
        result: FeedbackResult = self._need_client().feedback.record(**self._feedback_kwargs(score, metrics, expected_output, idempotency_key))
        return result


class AsyncRouteDecision(_RouteData):
    """A routing decision (async)."""

    async def record_feedback(
        self,
        *,
        score: float | None = None,
        metrics: Mapping[str, float] | None = None,
        expected_output: Any = None,
        idempotency_key: str | None = None,
    ) -> FeedbackResult:
        """Log the outcome of this routed request."""
        result: FeedbackResult = await self._need_client().feedback.record(**self._feedback_kwargs(score, metrics, expected_output, idempotency_key))
        return result


@dataclass(kw_only=True, repr=False, eq=False)
class Embeddings(APIObject):
    """Embedding vectors in input order (``.embeddings``)."""

    model: str
    data: list[dict[str, Any]] = field(default_factory=list)
    usage: dict[str, int] = field(default_factory=dict)

    _repr_fields = ("model",)

    @property
    def embeddings(self) -> list[list[float]]:
        """The vectors, ordered by input index."""
        return [list(item["embedding"]) for item in sorted(self.data, key=lambda d: d.get("index", 0))]


@dataclass(kw_only=True, repr=False, eq=False)
class FeedbackRecord(APIObject):
    """A stored feedback event."""

    id: str
    idempotency_key: str
    inference_id: str | None = None
    session_id: str | None = None
    deployment_name: str | None = None
    score: float | None = None
    expected_output: Any = None
    metrics: dict[str, float] = field(default_factory=dict)
    workspace_id: str | None = None
    created_at: str | None = None

    _repr_fields = ("id", "idempotency_key", "score")


def _feedback_records(value: Any, client: Any) -> Any:
    return [FeedbackRecord.from_api(v, client) for v in value] if isinstance(value, list) else value


@dataclass(kw_only=True, repr=False, eq=False)
class FeedbackResult(APIObject):
    """How many events were accepted vs deduplicated."""

    accepted: int = 0
    deduplicated: int = 0
    records: list[FeedbackRecord] = field(default_factory=list)

    _repr_fields = ("accepted", "deduplicated")
    _converters: ClassVar[dict[str, Callable[[Any, Any], Any]]] = {"records": _feedback_records}


@dataclass(kw_only=True, repr=False, eq=False)
class ApiKey(APIObject):
    """A scoped workspace API key (the secret is only shown once, at creation)."""

    id: str
    name: str
    prefix: str | None = None
    scopes: list[str] = field(default_factory=list)
    workspace_id: str | None = None
    created_at: str | None = None
    revoked_at: str | None = None

    _repr_fields = ("id", "name", "prefix", "scopes")


def _api_key(value: Any, client: Any) -> Any:
    return ApiKey.from_api(value, client) if isinstance(value, Mapping) else value


@dataclass(kw_only=True, repr=False, eq=False)
class CreatedApiKey(APIObject):
    """A newly created key; ``secret`` is the only copy (store it now)."""

    key: ApiKey | None = None
    secret: str = ""

    _converters: ClassVar[dict[str, Callable[[Any, Any], Any]]] = {"key": _api_key}

    def __repr__(self) -> str:
        return f"CreatedApiKey(key={self.key!r}, secret='{self.secret[:8]}…')"


# ------------------------------------------------------------------------------- evals


@dataclass(kw_only=True, repr=False, eq=False)
class EvalPlan(APIObject):
    """An eval dry run: tasks, model and judge calls, cost and warnings. ``print(plan)``."""

    task_source_kind: str | None = None
    dataset_version: int = 0
    estimated_tasks: int = 0
    estimated_model_calls: int = 0
    estimated_judge_calls: int = 0
    estimated_cost_usd: float = 0.0
    judge_models: list[str] = field(default_factory=list)
    local_scorers: list[str] = field(default_factory=list)
    pass_threshold: float | None = None
    warnings: list[str] = field(default_factory=list)

    _repr_fields = ("estimated_tasks", "estimated_model_calls", "estimated_cost_usd")

    def __str__(self) -> str:
        return format_eval_plan(self)


@dataclass(kw_only=True, repr=False, eq=False)
class EvalModelSummary(APIObject):
    """One model's aggregate: mean score with 95% CI, pass@k, paired delta vs baseline."""

    model: str
    overall: float = 0.0
    ci_low: float = 0.0
    ci_high: float = 0.0
    pass_at_k: dict[str, float] = field(default_factory=dict)
    vs_baseline: dict[str, float] | None = None
    tasks: int = 0
    errors: int = 0
    tokens_per_task: float = 0.0
    cost_per_1k_tasks_usd: float | None = None

    _repr_fields = ("model", "overall", "ci_low", "ci_high")


def _summaries(value: Any, client: Any) -> Any:
    return [EvalModelSummary.from_api(v, client) for v in value] if isinstance(value, list) else value


@dataclass(kw_only=True, repr=False, eq=False)
class EvalOutput(APIObject):
    """One generated model output (one task × model × sample)."""

    id: str
    eval_id: str | None = None
    task_id: str | None = None
    model: str | None = None
    sample_index: int = 0
    input: list[dict[str, Any]] = field(default_factory=list)
    output: str | None = None
    expected_output: Any = None
    record: dict[str, Any] = field(default_factory=dict)
    scores: dict[str, float] = field(default_factory=dict)
    error: str | None = None
    usage: dict[str, int] = field(default_factory=dict)

    _repr_fields = ("id", "model", "task_id", "sample_index")

    def trajectory(self) -> Trajectory:
        """The output as a :class:`grad.Trajectory` (what local scorers receive)."""
        base = Trajectory.from_record(self.record or {})
        expected = self.expected_output if self.expected_output is not None else base.expected_output
        return Trajectory(
            messages=[*[dict(m) for m in self.input], {"role": "assistant", "content": self.output or ""}],
            session_id=base.session_id,
            group_id=base.group_id,
            tools=base.tools,
            scores=dict(base.scores),
            metrics=dict(base.metrics),
            metadata=dict(base.metadata),
            expected_output=expected,
            id=base.id,
        )


@dataclass(kw_only=True, repr=False, eq=False)
class EvalResult(APIObject):
    """One task's result for one model (combined over samples)."""

    task_id: str
    model: str
    score: float = 0.0
    passed: bool = False
    sample_scores: list[float] = field(default_factory=list)
    judge_model: str | None = None
    record: dict[str, Any] = field(default_factory=dict)

    _repr_fields = ("task_id", "model", "score", "passed")


class _FailuresBase(Sequence[EvalResult]):
    def __init__(self, eval_id: str, items: list[EvalResult], client: Any) -> None:
        self.eval_id = eval_id
        self.items = items
        self._client = client

    def __len__(self) -> int:
        return len(self.items)

    def __getitem__(self, index: Any) -> Any:
        return self.items[index]

    def __iter__(self) -> Iterator[EvalResult]:
        return iter(self.items)

    def records(self) -> list[dict[str, Any]]:
        """The failing tasks' dataset records."""
        return [item.record for item in self.items if isinstance(item.record, Mapping) and item.record]

    def _records_or_raise(self) -> list[dict[str, Any]]:
        records = self.records()
        if not records:
            raise ValueError(f"Eval '{self.eval_id}' has no failing records to save.")
        return records

    def __repr__(self) -> str:
        return f"{type(self).__name__}(eval_id={self.eval_id!r}, {len(self.items)} failures)"


class EvalFailures(_FailuresBase):
    """Failing tasks of an eval; ``to_dataset(name)`` saves them for the next training round."""

    def to_dataset(self, name: str, *, metadata: Mapping[str, Any] | None = None) -> Dataset:
        """Push the failing records into dataset ``name`` (tagged ``mined_from_eval``)."""
        dataset: Dataset = self._client.datasets.push(name, self._records_or_raise(), metadata={"mined_from_eval": self.eval_id, **(metadata or {})})
        return dataset


class AsyncEvalFailures(_FailuresBase):
    """Failing tasks of an eval (async ``to_dataset``)."""

    async def to_dataset(self, name: str, *, metadata: Mapping[str, Any] | None = None) -> AsyncDataset:
        """Push the failing records into dataset ``name``."""
        dataset: AsyncDataset = await self._client.datasets.push(name, self._records_or_raise(), metadata={"mined_from_eval": self.eval_id, **(metadata or {})})
        return dataset


@dataclass(kw_only=True, repr=False, eq=False)
class _EvalData(APIObject):
    id: str
    name: str
    status: str
    workspace_id: str | None = None
    models: list[str] = field(default_factory=list)
    baseline: str | None = None
    task_source: dict[str, Any] = field(default_factory=dict)
    rubric: list[dict[str, Any]] = field(default_factory=list)
    samples: int = 1
    temperature: float | None = None
    max_tokens: int | None = None
    pass_threshold: float | None = None
    judge_models: list[str] = field(default_factory=list)
    local_scorers: list[str] = field(default_factory=list)
    progress: dict[str, int] = field(default_factory=dict)
    summary: list[EvalModelSummary] = field(default_factory=list)
    total_cost_usd: float = 0.0
    error: str | None = None
    created_at: str | None = None
    updated_at: str | None = None
    completed_at: str | None = None

    _repr_fields = ("id", "name", "status")
    _converters: ClassVar[dict[str, Callable[[Any, Any], Any]]] = {"summary": _summaries}
    _local_rubric: Any = None

    @property
    def done(self) -> bool:
        """True once the eval completed, failed or was cancelled."""
        return self.status in TERMINAL_EVAL_STATUSES

    def summary_table(self, by: str | None = None) -> str:
        """The side-by-side table: overall (95% CI), pass@k, vs baseline, tokens and cost per model."""
        if by not in (None, "model"):
            raise NotAvailableInV0Error(
                f"summary_table(by={by!r})",
                "the v0 server reports per-model aggregates only.",
                alternative="Use ev.results() / ev.outputs() for per-task and per-check scores.",
            )
        return format_eval_summary(self)

    def __str__(self) -> str:
        return self.summary_table()

    def _update_from(self, other: APIObject) -> None:
        rubric = self._local_rubric
        super()._update_from(other)
        if rubric is not None and getattr(other, "_local_rubric", None) is None:
            self._local_rubric = rubric


class Eval(_EvalData):
    """A server-executed evaluation. ``wait()`` also runs your local Python scorers."""

    def refresh(self) -> Eval:
        """Reload from the server (in place)."""
        self._update_from(self._need_client().evals.get(self.id))
        return self

    def wait(self, *, timeout: float | None = None, rubric: Any = None, raise_on_failure: bool = True) -> Eval:
        """Block until the eval completes, scoring local ``Scorer`` functions when it awaits them."""
        final = self._need_client().evals.wait(self.id, timeout=timeout, rubric=rubric or self._local_rubric, raise_on_failure=raise_on_failure)
        self._update_from(final)
        return self

    def score_pending(self, rubric: Any = None) -> int:
        """Score every output still missing a local score once; returns how many were posted."""
        posted: int = self._need_client().evals.score_pending(self.id, rubric or self._local_rubric)
        return posted

    def failures(self, *, model: Any = None, threshold: float | None = None) -> EvalFailures:
        """Tasks scoring below ``threshold`` (default: the eval's pass threshold)."""
        failures: EvalFailures = self._need_client().evals.failures(self.id, model=model, threshold=threshold)
        return failures

    def results(self, *, model: Any = None) -> Page[EvalResult]:
        """Per-task, per-model results."""
        page: Page[EvalResult] = self._need_client().evals.results(self.id, model=model)
        return page

    def outputs(self, *, model: Any = None) -> Page[EvalOutput]:
        """Generated outputs with their per-check scores."""
        page: Page[EvalOutput] = self._need_client().evals.outputs(self.id, model=model)
        return page

    def cancel(self) -> Eval:
        """Cancel the eval (in place)."""
        self._update_from(self._need_client().evals.cancel(self.id))
        return self


class AsyncEval(_EvalData):
    """A server-executed evaluation (async)."""

    async def refresh(self) -> AsyncEval:
        """Reload from the server (in place)."""
        self._update_from(await self._need_client().evals.get(self.id))
        return self

    async def wait(self, *, timeout: float | None = None, rubric: Any = None, raise_on_failure: bool = True) -> AsyncEval:
        """Wait until the eval completes, scoring local ``Scorer`` functions when it awaits them."""
        final = await self._need_client().evals.wait(self.id, timeout=timeout, rubric=rubric or self._local_rubric, raise_on_failure=raise_on_failure)
        self._update_from(final)
        return self

    async def score_pending(self, rubric: Any = None) -> int:
        """Score every output still missing a local score once."""
        posted: int = await self._need_client().evals.score_pending(self.id, rubric or self._local_rubric)
        return posted

    async def failures(self, *, model: Any = None, threshold: float | None = None) -> AsyncEvalFailures:
        """Tasks scoring below ``threshold``."""
        failures: AsyncEvalFailures = await self._need_client().evals.failures(self.id, model=model, threshold=threshold)
        return failures

    def results(self, *, model: Any = None) -> AsyncPager[EvalResult]:
        """Per-task, per-model results."""
        pager: AsyncPager[EvalResult] = self._need_client().evals.results(self.id, model=model)
        return pager

    def outputs(self, *, model: Any = None) -> AsyncPager[EvalOutput]:
        """Generated outputs with their per-check scores."""
        pager: AsyncPager[EvalOutput] = self._need_client().evals.outputs(self.id, model=model)
        return pager

    async def cancel(self) -> AsyncEval:
        """Cancel the eval (in place)."""
        self._update_from(await self._need_client().evals.cancel(self.id))
        return self


def variant(client: Any, sync_cls: type[T], async_cls: type[Any]) -> type[T]:
    """Pick the sync or async class for ``client``."""
    return async_cls if _is_async(client) else sync_cls
