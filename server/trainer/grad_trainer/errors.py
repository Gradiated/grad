"""Typed trainer errors. ``code`` is a stable machine-readable string for the worker."""

from __future__ import annotations


class TrainerError(Exception):
    code = "trainer_error"


class RecipeConfigError(TrainerError, ValueError):
    """The resolved run config is invalid for this recipe."""

    code = "invalid_recipe_config"


class RecipeDataError(TrainerError, ValueError):
    """The dataset records can't be used by this recipe."""

    code = "invalid_dataset"


class ModelUnavailableError(TrainerError, RuntimeError):
    """Model weights could not be located (offline, unknown id, missing mirror)."""

    code = "model_unavailable"


class SourceUnavailableError(TrainerError, RuntimeError):
    """An import source (file, Hugging Face dataset) could not be read."""

    code = "source_unavailable"


class BackendUnavailableError(TrainerError, RuntimeError):
    """The selected training backend can't run here (for example torch is missing)."""

    code = "backend_unavailable"


class ResumeMismatchError(TrainerError, ValueError):
    """A checkpoint does not belong to this run configuration."""

    code = "resume_mismatch"


class SourceAuthError(SourceUnavailableError):
    """The provider rejected the source's secret (HTTP 401/403, or a malformed key)."""

    code = "source_auth_failed"


class SourceUnreachableError(SourceUnavailableError):
    """The provider host could not be reached, kept failing, or redirected somewhere unsafe."""

    code = "source_unreachable"


class SourceHostBlockedError(SourceUnavailableError):
    """The source host is not allowed: wrong scheme, or it resolves to a blocked address."""

    code = "source_host_blocked"


class SourceAPIChangedError(SourceUnavailableError):
    """The provider answered with a status or shape this connector does not understand."""

    code = "source_api_changed"


class PaginationLoopError(SourceAPIChangedError):
    """The provider returned a cursor it already returned, or too many pages."""

    code = "source_pagination_loop"
