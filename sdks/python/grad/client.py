"""The ``Grad`` (blocking) and ``AsyncGrad`` (asyncio) clients."""

from __future__ import annotations

import os
from collections.abc import Mapping, Sequence
from typing import Any

from . import _async_resources as ar
from . import _resources as r
from ._config import ResolvedConfig, resolve_config
from ._generated.client import AsyncGeneratedApiClient, GeneratedApiClient
from ._helpers import check_slug
from ._http import AsyncSender, SyncSender
from ._models import AsyncDeployment, AsyncRouteDecision, Deployment, RouteDecision
from ._transport import AsyncTransport, Clock, RetryPolicy, SyncTransport

__all__ = ["AsyncGrad", "Grad"]


def _route_body(deployment: Any, messages: Sequence[Mapping[str, Any]], tools: Sequence[Mapping[str, Any]] | None, session_id: str | None) -> dict[str, Any]:
    name = deployment if isinstance(deployment, str) else getattr(deployment, "name", None)
    if not isinstance(name, str):
        raise TypeError("route() takes a deployment name or a Deployment.")
    if not messages:
        raise ValueError("route() needs at least one message.")
    body: dict[str, Any] = {"deployment": check_slug(name, "deployment name"), "messages": [dict(m) for m in messages]}
    if tools:
        body["tools"] = [dict(t) for t in tools]
    if session_id is not None:
        body["session_id"] = session_id
    return body


class _ClientBase:
    _config: ResolvedConfig

    @property
    def base_url(self) -> str:
        """The API base URL in use."""
        return self._config.base_url

    @property
    def config(self) -> ResolvedConfig:
        """The resolved configuration and where each value came from."""
        return self._config

    def __repr__(self) -> str:
        return f"{type(self).__name__}(base_url={self.base_url!r}, api_key={'set' if self._config.api_key else 'none'})"


class Grad(_ClientBase):
    """Blocking client for the Gradiated training platform.

    Configuration precedence: explicit arguments > ``GRADIATED_API_KEY`` /
    ``GRADIATED_BASE_URL`` > the ``grad login`` config file > ``https://api.gradiated.com``.

    Args:
        api_key: API key (``""`` for servers without authentication).
        base_url: e.g. ``http://localhost:8787`` for a local stack.
        profile: Profile in ``~/.config/gradiated/config.json`` (``"default"``).
        timeout: Per-request timeout in seconds (connect and each read). Downloads and
            event streams use their own longer read timeouts.
        max_retries: Retries for transient failures (see ``grad._transport``).
        default_headers: Extra headers sent with every request.
        config_path: Override the config file location.

    Use it as a context manager (or call :meth:`close`) to release pooled connections.
    """

    _is_async = False

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        profile: str | None = None,
        timeout: float = 60.0,
        max_retries: int = 2,
        default_headers: Mapping[str, str] | None = None,
        config_path: str | os.PathLike[str] | None = None,
        _sender: SyncSender | None = None,
        _clock: Clock | None = None,
        _env: Mapping[str, str] | None = None,
    ) -> None:
        self._config = resolve_config(api_key=api_key, base_url=base_url, profile=profile, config_path=config_path, env=_env)
        self._transport = SyncTransport(
            self._config,
            timeout=timeout,
            retry=RetryPolicy(max_retries=max_retries),
            clock=_clock,
            sender=_sender,
            default_headers=default_headers,
        )
        self.wire = GeneratedApiClient(self._transport)
        """Low-level generated client: one method per API operation (an escape hatch)."""
        self.models = r.Models(self)
        self.datasets = r.Datasets(self)
        self.imports = r.Imports(self)
        self.runs = r.Runs(self)
        self.checkpoints = r.Checkpoints(self)
        self.artifacts = r.Artifacts(self)
        self.deployments = r.Deployments(self)
        self.embeddings = r.EmbeddingsAPI(self)
        self.feedback = r.Feedback(self)
        self.evals = r.Evals(self)
        self.keys = r.Keys(self)
        self.environments = r.Environments(self)
        self.trainers = r.TRAINERS
        self.secrets = r.SECRETS

    def deploy(self, artifact: Any, *, name: str | None = None, fallback: Any = None, explore_rate: float | None = None) -> Deployment:
        """Deploy an artifact (``name@version``, an :class:`Artifact` or a finished :class:`Run`).

        Gradiated Cloud serves it as ``your-org/<name>``. Self-hosted servers raise
        :class:`grad.DeployUnavailableError` explaining how to serve the download on vLLM.
        Rolling back is deploying an earlier version (or ``deployments.rollback(name)``).
        """
        return self.deployments.create(artifact, name=name, fallback=fallback, explore_rate=explore_rate)

    def route(
        self,
        deployment: Any,
        messages: Sequence[Mapping[str, Any]],
        *,
        tools: Sequence[Mapping[str, Any]] | None = None,
        session_id: str | None = None,
    ) -> RouteDecision:
        """Ask a deployed router which model should answer ``messages``.

        Returns a :class:`grad.RouteDecision`: call ``decision.model`` with your own provider
        client, then ``decision.record_feedback(score=...)`` once you know the outcome.
        """
        return RouteDecision.from_api(self.wire.route_request(_route_body(deployment, messages, tools, session_id)), self)

    def close(self) -> None:
        """Close pooled connections."""
        self._transport.close()

    def __enter__(self) -> Grad:
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()


class AsyncGrad(_ClientBase):
    """asyncio client with the same API as :class:`Grad` (coroutine methods).

    Network I/O runs on the event loop (no worker threads), waits use ``asyncio.sleep``
    and cancelling a task cancels its request. Use ``async with AsyncGrad() as client``.
    """

    _is_async = True

    def __init__(
        self,
        api_key: str | None = None,
        *,
        base_url: str | None = None,
        profile: str | None = None,
        timeout: float = 60.0,
        max_retries: int = 2,
        default_headers: Mapping[str, str] | None = None,
        config_path: str | os.PathLike[str] | None = None,
        _sender: AsyncSender | None = None,
        _clock: Clock | None = None,
        _env: Mapping[str, str] | None = None,
    ) -> None:
        self._config = resolve_config(api_key=api_key, base_url=base_url, profile=profile, config_path=config_path, env=_env)
        self._transport = AsyncTransport(
            self._config,
            timeout=timeout,
            retry=RetryPolicy(max_retries=max_retries),
            clock=_clock,
            sender=_sender,
            default_headers=default_headers,
        )
        self.wire = AsyncGeneratedApiClient(self._transport)
        """Low-level generated client: one coroutine per API operation (an escape hatch)."""
        self.models = ar.AsyncModels(self)
        self.datasets = ar.AsyncDatasets(self)
        self.imports = ar.AsyncImports(self)
        self.runs = ar.AsyncRuns(self)
        self.checkpoints = ar.AsyncCheckpoints(self)
        self.artifacts = ar.AsyncArtifacts(self)
        self.deployments = ar.AsyncDeployments(self)
        self.embeddings = ar.AsyncEmbeddingsAPI(self)
        self.feedback = ar.AsyncFeedback(self)
        self.evals = ar.AsyncEvals(self)
        self.keys = ar.AsyncKeys(self)
        self.environments = ar.AsyncEnvironments(self)
        self.trainers = r.TRAINERS
        self.secrets = r.SECRETS

    async def deploy(self, artifact: Any, *, name: str | None = None, fallback: Any = None, explore_rate: float | None = None) -> AsyncDeployment:
        """Deploy an artifact (see :meth:`Grad.deploy`)."""
        return await self.deployments.create(artifact, name=name, fallback=fallback, explore_rate=explore_rate)

    async def route(
        self,
        deployment: Any,
        messages: Sequence[Mapping[str, Any]],
        *,
        tools: Sequence[Mapping[str, Any]] | None = None,
        session_id: str | None = None,
    ) -> AsyncRouteDecision:
        """Ask a deployed router which model should answer ``messages``."""
        return AsyncRouteDecision.from_api(await self.wire.route_request(_route_body(deployment, messages, tools, session_id)), self)

    async def aclose(self) -> None:
        """Close pooled connections."""
        await self._transport.aclose()

    async def __aenter__(self) -> AsyncGrad:
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()
