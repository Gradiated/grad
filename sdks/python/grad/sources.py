"""Observability providers a dataset can sync from (``dataset.add_source(provider=...)``).

    from grad import Grad, sources

    client = Grad()
    source = client.datasets.get("support-prod").add_source(
        provider=sources.Langfuse(host="https://cloud.langfuse.com", secret=client.secrets.get("langfuse-prod")),
        schedule="*/15 * * * *",
    )
    source.sync().wait()

Each sync pulls new traces plus scores and corrections on traces already synced, and saves a
new dataset version. ``filters`` narrow what is synced (every provider takes ``tags``,
``environment``, ``model``, ``version``, ``release``, ``name``, ``user_id``, ``session_id``,
``metadata``, ``from``/``to``, ``has_feedback`` and ``min_score``; the server answers 422 for
any other key), for example ``sources.Langfuse(..., filters={"environment": "production",
"min_score": {"helpfulness": 0.8}})``. ``secret`` is a :class:`grad.SecretRef` (or a secret name): the key itself
never leaves the server's secret store.
"""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass, field
from typing import Any, ClassVar, Final

__all__ = [
    "Braintrust",
    "Gradiated",
    "Langfuse",
    "LangSmith",
    "Phoenix",
    "PostHog",
    "SourceProvider",
]


class _Unset:
    def __repr__(self) -> str:
        return "UNSET"


UNSET: Final[Any] = _Unset()
"""A keyword argument left out of ``sources.update``: the field keeps its value."""


def secret_name(secret: Any) -> str | None:
    """A :class:`grad.SecretRef`, an object with ``.name``, or a plain name → the name."""
    if secret is None:
        return None
    if isinstance(secret, str):
        return secret
    name = getattr(secret, "name", None)
    if isinstance(name, str) and name:
        return name
    raise TypeError(f"secret must be a SecretRef from client.secrets.get(...) or a secret name, not {type(secret).__name__}.")


@dataclass(frozen=True, kw_only=True)
class SourceProvider:
    """A provider and how to reach it. Use one of the subclasses."""

    kind: ClassVar[str] = ""
    host: str | None = None
    secret: Any = None
    project: str | None = None
    filters: Mapping[str, Any] = field(default_factory=dict)

    def to_api(self) -> dict[str, Any]:
        """The ``SourceProvider`` JSON body."""
        body: dict[str, Any] = {"kind": self.kind}
        if self.host is not None:
            body["host"] = self.host
        name = secret_name(self.secret)
        if name is not None:
            body["secret"] = name
        if self.project is not None:
            body["project"] = self.project
        if self.filters:
            body["filters"] = dict(self.filters)
        return body


@dataclass(frozen=True, kw_only=True)
class Langfuse(SourceProvider):
    """Langfuse traces and scores. The secret is ``PUBLIC_KEY:SECRET_KEY``."""

    kind: ClassVar[str] = "langfuse"


@dataclass(frozen=True, kw_only=True)
class LangSmith(SourceProvider):
    """LangSmith runs and feedback, including corrections. ``filters={"filter": "..."}`` adds a
    LangSmith filter expression."""

    kind: ClassVar[str] = "langsmith"


@dataclass(frozen=True, kw_only=True)
class Braintrust(SourceProvider):
    """Braintrust project logs, scores and ``expected`` answers."""

    kind: ClassVar[str] = "braintrust"


@dataclass(frozen=True, kw_only=True)
class PostHog(SourceProvider):
    """PostHog LLM analytics events and survey feedback tied by ``$ai_trace_id``."""

    kind: ClassVar[str] = "posthog"


@dataclass(frozen=True, kw_only=True)
class Phoenix(SourceProvider):
    """Arize Phoenix (OpenInference) spans and annotations. ``host`` is required."""

    kind: ClassVar[str] = "phoenix"


@dataclass(frozen=True, kw_only=True)
class Gradiated(SourceProvider):
    """Gradiated Cloud gateway traces and feedback (Cloud only; no host or secret).

    ``models``/``tasks``/``versions`` narrow what is synced."""

    kind: ClassVar[str] = "gradiated"
    models: tuple[str, ...] = ()
    tasks: tuple[str, ...] = ()
    versions: tuple[str, ...] = ()

    def to_api(self) -> dict[str, Any]:
        body = super().to_api()
        filters = dict(body.get("filters") or {})
        for key in ("models", "tasks", "versions"):
            values = list(getattr(self, key))
            if values:
                filters[key] = values
        if filters:
            body["filters"] = filters
        return body


def provider_body(provider: Any) -> dict[str, Any]:
    """A :class:`SourceProvider` or a plain mapping (``{"kind": "langfuse", ...}``) → JSON."""
    if isinstance(provider, SourceProvider):
        return provider.to_api()
    if isinstance(provider, Mapping) and isinstance(provider.get("kind"), str):
        body = dict(provider)
        if "secret" in body:
            body["secret"] = secret_name(body["secret"])
        return body
    raise TypeError("provider must be one of grad.sources.Langfuse/LangSmith/Braintrust/PostHog/Phoenix/Gradiated, or a mapping with 'kind'.")
