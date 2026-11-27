"""Public Python SDK surface for Gradiated."""

from .client import AsyncGrad, EvalFailures, Grad, GradApiError
from .environments import (
    Environment,
    RemoteEnvironment,
    StepOutcome,
    ToolsEnvironment,
    environments,
    serve_environment,
)
from .recipes import (
    CartridgeRecipe,
    DecisionModelRecipe,
    DistillRecipe,
    DPORecipe,
    EmbeddingRecipe,
    GRPORecipe,
    RewardModelRecipe,
    RouterRecipe,
    SFTRecipe,
)
from .rubrics import Judge, Rubric, Scorer, validators
from .types import (
    Context,
    PreferencePair,
    Record,
    Task,
    Trajectory,
    Triplet,
    adapters,
    losses,
    optim,
    splits,
)

__version__ = "0.1.0"

__all__ = [
    "AsyncGrad",
    "CartridgeRecipe",
    "Context",
    "DPORecipe",
    "DecisionModelRecipe",
    "DistillRecipe",
    "EmbeddingRecipe",
    "Environment",
    "EvalFailures",
    "GRPORecipe",
    "Grad",
    "GradApiError",
    "Judge",
    "PreferencePair",
    "Record",
    "RemoteEnvironment",
    "RewardModelRecipe",
    "RouterRecipe",
    "Rubric",
    "SFTRecipe",
    "Scorer",
    "StepOutcome",
    "Task",
    "ToolsEnvironment",
    "Trajectory",
    "Triplet",
    "adapters",
    "environments",
    "losses",
    "optim",
    "serve_environment",
    "splits",
    "validators",
]
