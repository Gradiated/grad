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
