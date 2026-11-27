"""Rubrics: weighted combinations of ``Judge`` (LLM-as-judge), built-in ``validators`` and
Python ``Scorer`` functions.

Where each item runs in v0:

* ``Judge`` and ``validators.*`` run on the server during evaluations.
* ``Scorer(name, fn=your_function)`` runs **in your Python process** (``runtime="local"``,
  the v0 default; there is no sandbox yet). The eval waits in ``awaiting_scores`` and
  ``ev.wait()`` pulls the model outputs, calls your function and posts the scores.
* ``StatefulScorer(name, fn=f(traj, handle))`` scores an environment rollout against the
  environment's live state; it is only usable inside an ``Environment`` rubric.
"""

from __future__ import annotations

import importlib.metadata
import math
import re
from collections.abc import Callable, Mapping, Sequence
from dataclasses import dataclass
from typing import Any

from ._errors import NotAvailableInV0Error, ScorerError
from .records import Trajectory
from .validators import Validator

__all__ = ["Judge", "Rubric", "Scorer", "StatefulScorer", "coerce_rubric", "model_ref"]

_NAME_RE = re.compile(r"^[A-Za-z0-9_.:-]{1,80}$")
_REQ_RE = re.compile(r"^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(?:(==|>=|<=|~=|!=|>|<)\s*([^\s;,]+))?")


def model_ref(model: Any) -> str:
    """A model id string from a str, an :class:`grad.Artifact` (``name@version``) or a :class:`grad.Model`."""
    if isinstance(model, str):
        return model
    ref = getattr(model, "ref", None) or getattr(model, "id", None)
    if isinstance(ref, str) and ref:
        return ref
    raise TypeError(f"Expected a model id string or an Artifact/Model object, got {type(model).__name__}.")


def _check_name(name: Any, what: str) -> str:
    if not isinstance(name, str) or not _NAME_RE.match(name):
        raise ValueError(f"{what} name must match [A-Za-z0-9_.:-]{{1,80}}, got {name!r}.")
    return name


def _check_weight(weight: Any, what: str) -> float:
    if isinstance(weight, bool) or not isinstance(weight, (int, float)) or not math.isfinite(weight) or weight <= 0:
        raise ValueError(f"{what} weight must be a finite number > 0, got {weight!r}.")
    return float(weight)


def _as_score(value: Any, name: str, where: str) -> float:
    if isinstance(value, bool):
        return 1.0 if value else 0.0
    if not isinstance(value, (int, float)) or not math.isfinite(value):
        raise ScorerError(f"Scorer '{name}' returned {value!r} for {where}; return a float in [0, 1] (or a bool).")
    if not 0.0 <= float(value) <= 1.0:
        raise ScorerError(f"Scorer '{name}' returned {value} for {where}; scores must be in [0, 1].")
    return float(value)


@dataclass(frozen=True)
class Judge:
    """An LLM-as-judge rubric item. ``model`` is required: there is no default that could change under you.

    ``model`` may be a catalog id or an :class:`grad.Artifact` (e.g. a trained reward model).
    The judge sees the conversation, the response and any reference answer, and replies
    with a score in [0, 1] following ``prompt``.
    """

    model: Any
    prompt: str | None = None
    name: str = "judge"
    weight: float = 1.0

    def __post_init__(self) -> None:
        if self.model is None or (isinstance(self.model, str) and not self.model.strip()):
            raise ValueError("Judge requires an explicit model, e.g. Judge(model='qwen/qwen3-32b', prompt=...).")
        object.__setattr__(self, "model", model_ref(self.model).strip())
        if len(self.model) > 160:
            raise ValueError("Judge model ids are limited to 160 characters.")
        _check_name(self.name, "Judge")
        object.__setattr__(self, "weight", _check_weight(self.weight, f"Judge '{self.name}'"))
        if self.prompt is not None and len(self.prompt) > 8000:
            raise ValueError(f"Judge '{self.name}' prompt is {len(self.prompt)} characters; the limit is 8000.")

    def with_weight(self, weight: float) -> Judge:
        """A copy with another weight."""
        return Judge(model=self.model, prompt=self.prompt, name=self.name, weight=weight)

    def to_wire_item(self) -> dict[str, Any]:
        """The ``EvalRubricItem`` sent to the server."""
        item: dict[str, Any] = {"name": self.name, "kind": "judge", "model": self.model, "weight": self.weight}
        if self.prompt:
            item["prompt"] = self.prompt
        return item


class Scorer:
    """A named, weighted rubric check: a built-in validator or your own Python function.

    ``fn`` receives a :class:`grad.Trajectory` (``traj.text`` is the answer, ``traj.metadata``
    and ``traj.expected_output`` the record's fields) and returns a float in [0, 1] (a bool
    is read as 1.0/0.0). With a built-in validator (``fn=validators.JSON()``) the check runs
    on the server; with a function it runs locally (``runtime="local"``, the v0 default).

    ``requirements`` are checked against the packages installed locally before an eval
    starts; ``network`` is accepted for forward compatibility (local functions can always
    reach the network).
    """

    def __init__(
        self,
        name: str,
        fn: Callable[[Trajectory], float | bool] | Validator | None = None,
        *,
        weight: float = 1.0,
        requirements: Sequence[str] | None = None,
        network: bool = False,
        runtime: str | None = None,
    ) -> None:
        self.name = _check_name(name, "Scorer")
        if fn is None:
            raise ValueError(f"Scorer '{name}' needs fn= (a function of the trajectory, or a validators.* check).")
        if not callable(fn):
            raise TypeError(f"Scorer '{name}' fn must be callable, got {type(fn).__name__}.")
        self.fn = fn
        self.weight = _check_weight(weight, f"Scorer '{name}'")
        self.requirements = [str(r) for r in (requirements or [])]
        self.network = bool(network)
        if isinstance(fn, Validator):
            if runtime not in (None, "server"):
                raise ValueError(f"Scorer '{name}' wraps a built-in validator, which always runs on the server.")
            self.runtime = "server"
        else:
            if runtime not in (None, "local"):
                raise NotAvailableInV0Error(
                    f"Scorer(runtime={runtime!r})",
                    "there is no managed sandbox in v0; Python scorers run in your process.",
                    alternative='Leave runtime unset (or "local").',
                )
            self.runtime = "local"

    @property
    def is_local(self) -> bool:
        """True when the function runs in this process (not a built-in validator)."""
        return self.runtime == "local"

    def with_weight(self, weight: float) -> Scorer:
        """A copy with another weight."""
        return Scorer(
            self.name,
            self.fn,
            weight=weight,
            requirements=self.requirements,
            network=self.network,
            runtime=None if self.runtime == "server" else self.runtime,
        )

    def to_wire_item(self) -> dict[str, Any]:
        """The ``EvalRubricItem`` sent to the server."""
        if isinstance(self.fn, Validator):
            return self.fn.to_wire_item(self.name, self.weight)
        return {"name": self.name, "kind": "code", "runtime": "local", "weight": self.weight}

    def check_requirements(self) -> None:
        """Raise :class:`grad.ScorerError` when a declared requirement is not installed locally."""
        for req in self.requirements:
            match = _REQ_RE.match(req)
            if not match:
                raise ScorerError(f"Scorer '{self.name}': cannot parse requirement {req!r}.")
            dist, op, version = match.groups()
            try:
                installed = importlib.metadata.version(dist)
            except importlib.metadata.PackageNotFoundError:
                raise ScorerError(
                    f"Scorer '{self.name}' requires {req!r}, which is not installed in this Python "
                    f"environment. Python scorers run locally in v0: `pip install '{req}'`."
                ) from None
            if op == "==" and version is not None and installed != version:
                raise ScorerError(f"Scorer '{self.name}' requires {req!r} but {dist} {installed} is installed.")

    def score(self, traj: Trajectory | str, *, where: str = "a sample") -> float:
        """Run the check locally and return a score in [0, 1]."""
        if isinstance(traj, str):
            traj = Trajectory(messages=[{"role": "assistant", "content": traj}])
        try:
            value = self.fn(traj)
        except ScorerError:
            raise
        except Exception as exc:
            raise ScorerError(f"Scorer '{self.name}' raised {type(exc).__name__}: {exc} (on {where}).") from exc
        return _as_score(value, self.name, where)

    def __repr__(self) -> str:
        fn = self.fn if isinstance(self.fn, Validator) else getattr(self.fn, "__name__", "fn")
        return f"Scorer({self.name!r}, fn={fn}, weight={self.weight})"


class StatefulScorer:
    """Scores an environment rollout from its live state: ``fn(traj, handle) -> float``.

    Usable in an :class:`grad.Environment` rubric (scored where the environment runs, e.g.
    by ``serve_environment``). Evals and training rubrics cannot carry one in v0.
    """

    def __init__(
        self,
        name: str,
        fn: Callable[[Trajectory, Any], float | bool],
        *,
        weight: float = 1.0,
        requirements: Sequence[str] | None = None,
    ) -> None:
        self.name = _check_name(name, "StatefulScorer")
        if not callable(fn):
            raise TypeError(f"StatefulScorer '{name}' fn must be callable.")
        self.fn = fn
        self.weight = _check_weight(weight, f"StatefulScorer '{name}'")
        self.requirements = [str(r) for r in (requirements or [])]

    is_local = True

    def with_weight(self, weight: float) -> StatefulScorer:
        """A copy with another weight."""
        return StatefulScorer(self.name, self.fn, weight=weight, requirements=self.requirements)

    def to_wire_item(self) -> dict[str, Any]:
        """Not serialisable: stateful scorers need a live environment handle."""
        raise NotAvailableInV0Error(
            f"StatefulScorer '{self.name}' in an eval or training rubric",
            "it needs an environment handle, and environment-backed evals and RL arrive in Wave 2.",
            alternative="Use it in an Environment rubric served with serve_environment, or use a Scorer.",
        )

    def score(self, traj: Trajectory, handle: Any, *, where: str = "a rollout") -> float:
        """Run the check against ``handle`` and return a score in [0, 1]."""
        try:
            value = self.fn(traj, handle)
        except Exception as exc:
            raise ScorerError(f"StatefulScorer '{self.name}' raised {type(exc).__name__}: {exc} (on {where}).") from exc
        return _as_score(value, self.name, where)

    def __repr__(self) -> str:
        return f"StatefulScorer({self.name!r}, weight={self.weight})"


RubricItem = Judge | Scorer | StatefulScorer


def _coerce_item(item: Any, index: int) -> RubricItem:
    if isinstance(item, (Judge, Scorer, StatefulScorer)):
        return item
    if isinstance(item, tuple) and len(item) == 2:
        inner, weight = item
        return _coerce_item(inner, index).with_weight(weight)
    if isinstance(item, Validator):
        return Scorer(str(item.to_wire_item()["name"]), fn=item)
    if isinstance(item, Mapping):
        raise TypeError("Rubric items must be Judge/Scorer objects; pass wire dicts as rubric=[...] directly to evals.")
    if callable(item):
        name = getattr(item, "__name__", "") or f"scorer_{index}"
        if not _NAME_RE.match(name):
            name = f"scorer_{index}"
        return Scorer(name, fn=item)
    raise TypeError(f"Rubric item {index} must be a Judge, Scorer, validator or function; got {type(item).__name__}.")


class Rubric:
    """A weighted combination of checks; the overall score is the weighted mean.

    Items may be ``Judge``, ``Scorer``, ``StatefulScorer``, a ``validators.*`` check, a plain
    function (named after the function) or an ``(item, weight)`` tuple.
    """

    def __init__(self, items: Sequence[Any]) -> None:
        if isinstance(items, (str, bytes)) or not isinstance(items, Sequence):
            items = [items]
        if not items:
            raise ValueError("Rubric needs at least one item.")
        if len(items) > 32:
            raise ValueError(f"Rubric has {len(items)} items; the limit is 32.")
        self.items: list[RubricItem] = [_coerce_item(item, i) for i, item in enumerate(items)]
        names = [item.name for item in self.items]
        dupes = sorted({n for n in names if names.count(n) > 1})
        if dupes:
            raise ValueError(f"Rubric item names must be unique; duplicated: {', '.join(dupes)}.")

    @property
    def entries(self) -> list[RubricItem]:
        """Alias of ``items``."""
        return self.items

    @property
    def local_scorers(self) -> dict[str, Scorer]:
        """The Python-function scorers that run in this process, by name."""
        return {item.name: item for item in self.items if isinstance(item, Scorer) and item.is_local}

    @property
    def judges(self) -> list[Judge]:
        """The ``Judge`` items."""
        return [item for item in self.items if isinstance(item, Judge)]

    def to_wire_items(self) -> list[dict[str, Any]]:
        """``EvalRubricItem`` dicts for the server (raises for stateful scorers)."""
        return [item.to_wire_item() for item in self.items]

    def check_requirements(self) -> None:
        """Verify every local scorer's declared requirements are installed."""
        for scorer in self.local_scorers.values():
            scorer.check_requirements()

    def dry_run(self, sample: Mapping[str, Any] | Trajectory) -> dict[str, float]:
        """Run each local scorer once on a sample record so a broken function fails before any spend."""
        traj = sample if isinstance(sample, Trajectory) else Trajectory.from_record(sample)
        self.check_requirements()
        return {name: s.score(traj, where="a sample record (dry run)") for name, s in self.local_scorers.items()}

    def score_local(self, traj: Trajectory, handle: Any = None) -> dict[str, float]:
        """Score every item in this process (environment rollouts). Judges need the server."""
        out: dict[str, float] = {}
        for item in self.items:
            if isinstance(item, Judge):
                raise NotAvailableInV0Error(
                    f"Judge '{item.name}' inside an environment rubric",
                    "judges run on the server during evals; an environment worker has no judge endpoint.",
                    alternative="Score the rollout with a Scorer or StatefulScorer.",
                )
            if isinstance(item, StatefulScorer):
                out[item.name] = item.score(traj, handle)
            elif isinstance(item.fn, Validator):
                out[item.name] = _as_score(item.fn(traj), item.name, "a rollout")
            else:
                out[item.name] = item.score(traj, where="a rollout")
        return out

    def overall(self, scores: Mapping[str, float]) -> float:
        """Weighted mean of ``scores`` over the rubric's items (missing items count as 0)."""
        total = sum(item.weight for item in self.items)
        return sum(scores.get(item.name, 0.0) * item.weight for item in self.items) / total

    def __repr__(self) -> str:
        return f"Rubric({self.items!r})"


def coerce_rubric(rubric: Any) -> Rubric:
    """Accept a ``Rubric``, a single item, or a list of items."""
    if isinstance(rubric, Rubric):
        return rubric
    if isinstance(rubric, (list, tuple)) and not (len(rubric) == 2 and isinstance(rubric[1], (int, float)) and not isinstance(rubric[1], bool)):
        return Rubric(list(rubric))
    return Rubric([rubric])
