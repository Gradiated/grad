"""Observability source providers: one class per provider, for file imports and live sync.

See README.md in this directory for how to add one.
"""

from __future__ import annotations

from typing import Any, Callable

from ..errors import SourceUnavailableError
from .base import Page, Provider, ScoreUpdate, SourceSpec
from .braintrust import BraintrustProvider
from .gradiated import GradiatedProvider
from .langfuse import LangfuseProvider
from .langsmith import LangSmithProvider
from .phoenix import PhoenixProvider
from .posthog import PostHogProvider
from .sync import SyncEngine, SyncResult

# Insertion order is the file auto-detection order: the most specific detect() first.
PROVIDERS: dict[str, type[Provider]] = {
    "posthog": PostHogProvider,
    "gradiated": GradiatedProvider,
    "langsmith": LangSmithProvider,
    "braintrust": BraintrustProvider,
    "langfuse": LangfuseProvider,
    "phoenix": PhoenixProvider,
}


def build_provider(
    source: dict[str, Any], *, pull: Callable[[str | None], dict[str, Any]] | None = None, **http_options: Any
) -> Provider:
    """A provider for a source job: ``{provider, host?, secret?, project?, filters?}``."""
    name = str(source.get("provider") or "")
    cls = PROVIDERS.get(name)
    if cls is None:
        raise SourceUnavailableError(f"Unknown source provider '{name}'. Supported: {', '.join(PROVIDERS)}.")
    spec = SourceSpec(
        host=source.get("host") or None,
        secret=str(source.get("secret") or ""),
        project=str(source["project"]) if source.get("project") else None,
        filters=dict(source.get("filters") or {}),
        pull=pull,
    )
    return cls(spec, **http_options)


__all__ = ["PROVIDERS", "Page", "Provider", "ScoreUpdate", "SourceSpec", "SyncEngine", "SyncResult", "build_provider"]
