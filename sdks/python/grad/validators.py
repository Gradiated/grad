"""Built-in deterministic checks that the server runs during evaluations.

Use them as a rubric item (``Rubric([validators.JSON()])``), as a scorer's function
(``Scorer("valid_json", weight=0.3, fn=validators.JSON())``) or call them locally:
``validators.JSON()(text) -> 1.0 | 0.0``. Server-side they run with the same rules
(output trimmed; ``ExactMatch`` compares against the record's expected answer; ``Regex``
uses JavaScript regex syntax with a hard timeout).

``SQL``, ``TypeScriptAST``, ``NumericMatch`` and ``JSONSchema`` appear in the docs but the
v0 server has no such validators; constructing one raises
:class:`grad.NotAvailableInV0Error` with a local-scorer alternative.
"""

from __future__ import annotations

import json
import re
from typing import Any

from ._errors import NotAvailableInV0Error

__all__ = [
    "ExactMatch",
    "JSON",
    "JSONSchema",
    "NonEmpty",
    "NumericMatch",
    "Regex",
    "SQL",
    "TypeScriptAST",
    "Validator",
    "exact_match",
    "json_valid",
    "non_empty",
    "regex",
]

_PY_ONLY_REGEX = re.compile(r"\(\?P[<=>]|\(\?#|\\[AZz]|\(\?[aLx]")


def _text_and_expected(value: Any, expected: Any) -> tuple[str, Any]:
    text = getattr(value, "text", value)
    if expected is None:
        expected = getattr(value, "expected_output", None)
    if not isinstance(text, str):
        text = json.dumps(text) if text is not None else ""
    return text, expected


def _expected_text(expected: Any) -> str | None:
    if expected is None:
        return None
    if isinstance(expected, str):
        return expected
    if isinstance(expected, dict) and isinstance(expected.get("content"), str):
        return str(expected["content"])
    return json.dumps(expected)


class Validator:
    """A server-side check. Calling it scores locally with the same rules (1.0 or 0.0)."""

    kind = "validator"
    validator: str = ""
    default_name: str = "validator"

    def to_wire_item(self, name: str | None = None, weight: float = 1.0) -> dict[str, Any]:
        """The ``EvalRubricItem`` for this check."""
        return {"name": name or self.default_name, "kind": "validator", "validator": self.validator, "weight": weight}

    def __call__(self, output: Any, expected: Any = None) -> float:  # pragma: no cover - overridden
        """Score ``output`` (a string or a trajectory) locally."""
        raise NotImplementedError

    def __repr__(self) -> str:
        return f"validators.{type(self).__name__}()"


class JSON(Validator):
    """1.0 when the trimmed output parses as JSON."""

    validator = "json"
    default_name = "valid_json"

    def __call__(self, output: Any, expected: Any = None) -> float:
        """Score ``output`` locally."""
        text, _ = _text_and_expected(output, expected)
        try:
            json.loads(text.strip())
        except ValueError:
            return 0.0
        return 1.0


class NonEmpty(Validator):
    """1.0 when the trimmed output is not empty."""

    validator = "non_empty"
    default_name = "non_empty"

    def __call__(self, output: Any, expected: Any = None) -> float:
        """Score ``output`` locally."""
        text, _ = _text_and_expected(output, expected)
        return 1.0 if text.strip() else 0.0


class ExactMatch(Validator):
    """1.0 when the trimmed output equals the record's expected answer (0.0 if it has none)."""

    validator = "exact_match"
    default_name = "exact_match"

    def __call__(self, output: Any, expected: Any = None) -> float:
        """Score ``output`` locally against ``expected`` (or the trajectory's ``expected_output``)."""
        text, exp = _text_and_expected(output, expected)
        ref = _expected_text(exp)
        return 1.0 if ref is not None and text.strip() == ref.strip() else 0.0


class Regex(Validator):
    """1.0 when ``pattern`` matches the output (JavaScript syntax; flags from ``imsu``)."""

    kind = "regex"
    default_name = "regex"

    def __init__(self, pattern: str, flags: str = "") -> None:
        if not pattern:
            raise ValueError("Regex needs a non-empty pattern.")
        if len(pattern) > 256:
            raise ValueError(f"Regex patterns are limited to 256 characters, got {len(pattern)}.")
        if not re.fullmatch(r"[imsu]{0,4}", flags):
            raise ValueError(f"Regex flags must come from 'imsu', got {flags!r}.")
        if _PY_ONLY_REGEX.search(pattern):
            raise ValueError(
                f"Pattern {pattern!r} uses Python-only regex syntax ((?P<name>...), \\A, \\Z, inline (?x)...); "
                "the server evaluates JavaScript regexes. Use (?<name>...), ^ and $ instead."
            )
        self.pattern = pattern
        self.flags = flags
        py_flags = 0
        if "i" in flags:
            py_flags |= re.IGNORECASE
        if "m" in flags:
            py_flags |= re.MULTILINE
        if "s" in flags:
            py_flags |= re.DOTALL
        try:
            self._compiled: re.Pattern[str] | None = re.compile(pattern.replace("(?<", "(?P<").replace("(?P<=", "(?<=").replace("(?P<!", "(?<!"), py_flags)
        except re.error:
            self._compiled = None  # valid JS but not Python: the server still evaluates it

    def to_wire_item(self, name: str | None = None, weight: float = 1.0) -> dict[str, Any]:
        """The ``EvalRubricItem`` for this check."""
        item: dict[str, Any] = {"name": name or self.default_name, "kind": "regex", "pattern": self.pattern, "weight": weight}
        if self.flags:
            item["flags"] = self.flags
        return item

    def __call__(self, output: Any, expected: Any = None) -> float:
        """Score ``output`` locally (best effort: Python's regex engine approximates JavaScript's)."""
        if self._compiled is None:
            raise ValueError(f"Pattern {self.pattern!r} cannot be evaluated locally; the server evaluates it in evals.")
        text, _ = _text_and_expected(output, expected)
        return 1.0 if self._compiled.search(text[:16384]) else 0.0

    def __repr__(self) -> str:
        return f"validators.Regex({self.pattern!r}" + (f", flags={self.flags!r})" if self.flags else ")")


def _unavailable(name: str) -> NotAvailableInV0Error:
    return NotAvailableInV0Error(
        f"validators.{name}",
        "the v0 server has no such validator (built-ins: JSON, NonEmpty, ExactMatch, Regex).",
        alternative=f"Write the check as a Python function and use Scorer('{name.lower()}', fn=your_check); "
        "it runs in your process during evals.",
    )


def SQL(*args: Any, **kwargs: Any) -> Validator:
    """Not available in v0 (no server-side SQL parser)."""
    raise _unavailable("SQL")


def TypeScriptAST(*args: Any, **kwargs: Any) -> Validator:
    """Not available in v0 (no server-side TypeScript parser)."""
    raise _unavailable("TypeScriptAST")


def NumericMatch(*args: Any, **kwargs: Any) -> Validator:
    """Not available in v0."""
    raise _unavailable("NumericMatch")


def JSONSchema(*args: Any, **kwargs: Any) -> Validator:
    """Not available in v0."""
    raise _unavailable("JSONSchema")


# Lower-case aliases kept from the 0.1 SDK.
def json_valid() -> Validator:
    """Alias of :class:`JSON`."""
    return JSON()


def non_empty() -> Validator:
    """Alias of :class:`NonEmpty`."""
    return NonEmpty()


def exact_match() -> Validator:
    """Alias of :class:`ExactMatch`."""
    return ExactMatch()


def regex(pattern: str, flags: str = "") -> Validator:
    """Alias of :class:`Regex`."""
    return Regex(pattern, flags)
