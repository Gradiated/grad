"""Typed error hierarchy for grad-sdk.

Every exception the SDK raises derives from :class:`GradError`. HTTP failures are
:class:`GradAPIError` subclasses chosen by status code (and, for 501, by the
problem+json ``code``), so callers can catch exactly what they handle::

    try:
        client.evals.create(...)
    except grad.InferenceUnavailableError as exc:
        print(exc.detail)  # the server's hint: set GRAD_INFERENCE_BASE_URL
"""

from __future__ import annotations

import email.utils
import json
import re
import time
import urllib.parse
from dataclasses import dataclass
from typing import Any, Mapping

__all__ = [
    "APIConnectionError",
    "APITimeoutError",
    "AuthenticationError",
    "BadRequestError",
    "ChecksumMismatchError",
    "ArtifactImportFailedError",
    "ConflictError",
    "EvalFailedError",
    "FeatureUnavailableError",
    "FieldError",
    "GradAPIError",
    "GradApiError",
    "GradConfigError",
    "GradError",
    "ImportFailedError",
    "InferenceUnavailableError",
    "InvalidResponseError",
    "JobFailedError",
    "NotAvailableInV0Error",
    "NotFoundError",
    "PaginationLoopError",
    "PayloadTooLargeError",
    "PermissionDeniedError",
    "QueueLimitError",
    "RateLimitError",
    "RunFailedError",
    "ScorerError",
    "ServerError",
    "UnexpectedRedirectError",
    "UnsafeArchiveError",
    "ValidationError",
    "WaitTimeoutError",
]

_LOGIN_HINT = "Set GRADIATED_API_KEY, pass Grad(api_key=...), or run `grad login`."

CLOUD_TRAINING_UNAVAILABLE = (
    "Gradiated Cloud training isn't available yet; run `grad local up` "
    "or point at your server with --base-url or GRADIATED_BASE_URL."
)


class GradError(Exception):
    """Base class of every error raised by grad-sdk.

    Attributes:
        message: Human-readable description, also the ``str()`` of the error.
        status: HTTP status when the error came from a response, else ``None``.
        code: Machine-readable code (problem+json ``code`` or an SDK code).
        request_id: The ``x-request-id`` of the failing request, when known.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int | None = None,
        code: str | None = None,
        request_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.message = message
        self.status = status
        self.code = code
        self.request_id = request_id


class GradConfigError(GradError, ValueError):
    """The client is misconfigured (missing API key, malformed base URL or config file)."""


class NotAvailableInV0Error(GradError, NotImplementedError):
    """A documented SDK feature that this release (v0) does not provide yet.

    Raised before anything is sent, so nothing is billed and no placeholder result
    is ever returned. ``feature`` names what was requested and ``alternative`` (when
    set) says what to use instead.
    """

    def __init__(self, feature: str, reason: str, *, alternative: str | None = None) -> None:
        text = f"{feature} is not available in grad v0: {reason}"
        if alternative:
            text += f" {alternative}"
        super().__init__(text, code="not_available_in_v0")
        self.feature = feature
        self.alternative = alternative


class APIConnectionError(GradError):
    """The server could not be reached or the connection failed mid-request."""

    def __init__(self, message: str, *, method: str, url: str, cause: BaseException | None = None) -> None:
        super().__init__(message, code="connection_error")
        self.method = method
        self.url = url
        self.cause = cause


class APITimeoutError(APIConnectionError, TimeoutError):
    """A request (connect or read) exceeded its timeout."""


class InvalidResponseError(GradError):
    """A 2xx response whose body is not the JSON the endpoint promises (e.g. a proxy's HTML page)."""

    def __init__(self, message: str, *, method: str, url: str, status: int, request_id: str | None) -> None:
        super().__init__(message, status=status, code="invalid_response", request_id=request_id)
        self.method = method
        self.url = url


class ChecksumMismatchError(GradError, ValueError):
    """Downloaded bytes do not match the SHA-256 the server declared."""

    def __init__(self, message: str, *, expected: str, actual: str) -> None:
        super().__init__(message, code="checksum_mismatch")
        self.expected = expected
        self.actual = actual


class UnsafeArchiveError(GradError, ValueError):
    """An artifact bundle contains an entry that could escape the target directory."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="unsafe_archive")


class ScorerError(GradError):
    """A local Python scorer raised or returned something other than a score in [0, 1]."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="scorer_error")


class JobFailedError(GradError):
    """A server-side job (run, import or eval) finished without a result (``failed``, ...)."""

    def __init__(self, message: str, *, resource: Any, error: str | None, code: str = "job_failed") -> None:
        super().__init__(message, code=code)
        self.resource = resource
        self.error = error


class RunFailedError(JobFailedError):
    """A run ended ``failed``, ``cancelled``, ``stopped_budget`` or ``stopped_balance`` (code ``run_<status>``).

    ``run`` is the final :class:`grad.Run`; ``error`` the server's reason. A ``stopped_budget``
    run keeps its checkpoints: resume it with ``run.resume(max_cost_usd=...)`` (a higher cap).
    A ``stopped_balance`` run (Cloud: the workspace ran out of balance) resumes with
    ``run.resume()`` after a top-up.
    """

    @property
    def run(self) -> Any:
        """The failed run."""
        return self.resource


class ImportFailedError(JobFailedError):
    """A dataset import failed. ``job`` is the final :class:`grad.ImportJob`."""

    @property
    def job(self) -> Any:
        """The failed import job."""
        return self.resource


class ArtifactImportFailedError(JobFailedError):
    """``artifacts.upload`` / ``artifacts.from_hf`` failed. ``job`` is the final :class:`grad.ArtifactImport`.

    ``code`` is ``invalid_artifact`` (``status`` 422) when the files break the format spec or
    don't fit the base model; ``error`` then names the file and the problem.
    """

    @property
    def job(self) -> Any:
        """The failed artifact import."""
        return self.resource


class EvalFailedError(JobFailedError):
    """An evaluation failed. ``eval`` is the final :class:`grad.Eval`."""

    @property
    def eval(self) -> Any:
        """The failed evaluation."""
        return self.resource


class WaitTimeoutError(GradError, TimeoutError):
    """``wait(timeout=...)`` elapsed before the job finished. The job keeps running server-side."""

    def __init__(self, message: str, *, resource: Any) -> None:
        super().__init__(message, code="wait_timeout")
        self.resource = resource


class PaginationLoopError(GradError):
    """A list endpoint returned a ``next_cursor`` it had already returned, so following it would loop forever.

    Also raised when a collect-all helper exceeds its item bound. ``cursor`` is the repeated
    (or last) cursor and ``endpoint`` the list being walked. The pages read so
    far have already been yielded; this stops the walk instead of buffering pages without end.
    """

    def __init__(self, endpoint: str, cursor: str, *, message: str | None = None) -> None:
        super().__init__(
            message
            or (
                f"{endpoint} returned next_cursor {cursor!r} again; stopping instead of looping forever. "
                "This is a server bug: report it with the endpoint and cursor."
            ),
            code="pagination_loop",
        )
        self.endpoint = endpoint
        self.cursor = cursor


@dataclass(frozen=True)
class FieldError:
    """One field-level validation problem (``path`` like ``records.0.messages``)."""

    path: str
    message: str


class GradAPIError(GradError):
    """The server answered with an error status (an RFC 9457 problem+json body).

    Attributes:
        status: HTTP status code.
        code: Problem ``code`` such as ``run_not_found`` (``http_<status>`` if absent).
        title: Problem title.
        detail: The server's explanation, including any hint on how to fix it.
        request_id: ``x-request-id`` header (or body ``request_id``); quote it in bug reports.
        method, url: The request that failed.
        headers: Response headers (lower-case keys).
        body: Parsed JSON body, or the raw text when the body is not JSON.
        errors: Field-level problems (``ValidationError`` mostly).
    """

    def __init__(
        self,
        *,
        status: int,
        code: str,
        title: str,
        detail: str,
        request_id: str | None,
        method: str,
        url: str,
        headers: Mapping[str, str] | None = None,
        body: Any = None,
        errors: list[FieldError] | None = None,
        hint: str | None = None,
    ) -> None:
        where = f"{method} {url}"
        text = f"[{status} {code}] {detail or title} ({where}"
        text += f", request_id={request_id})" if request_id else ")"
        if hint:
            text += f" {hint}"
        super().__init__(text, status=status, code=code, request_id=request_id)
        self.title = title
        self.detail = detail
        self.method = method
        self.url = url
        self.headers = dict(headers or {})
        self.body = body
        self.errors = list(errors or [])

    @property
    def retry_after(self) -> float | None:
        """Seconds the server asked to wait before retrying (``Retry-After``), if it said."""
        return parse_retry_after(self.headers.get("retry-after"))


GradApiError = GradAPIError
"""Backwards-compatible alias of :class:`GradAPIError`."""


class UnexpectedRedirectError(GradAPIError):
    """The server redirected somewhere the SDK refuses to follow.

    Credentials are never sent to another origin and non-GET requests are never
    replayed, so a redirect of either kind surfaces as this error.
    """

    @property
    def location(self) -> str:
        """The redirect target from the ``Location`` header."""
        return self.headers.get("location", "")


class BadRequestError(GradAPIError):
    """400: the request was malformed."""


class AuthenticationError(GradAPIError):
    """401: no API key, or the key is invalid or revoked."""


class PermissionDeniedError(GradAPIError):
    """403: the key lacks the scope this endpoint needs."""


class NotFoundError(GradAPIError):
    """404: the resource (dataset, run, artifact, ...) does not exist."""


class ConflictError(GradAPIError):
    """409: the request conflicts with the resource's current state."""


class PayloadTooLargeError(GradAPIError):
    """413: the request body is over the server limit (use file uploads for big data)."""


class ValidationError(GradAPIError):
    """422: the server rejected the request body; ``errors`` lists each field problem."""


class RateLimitError(GradAPIError):
    """429: too many requests. ``retry_after`` (seconds) is the server's suggested wait."""


class QueueLimitError(RateLimitError):
    """429 ``queue_limit``: the workspace already has as many queued jobs as it may.

    This is a hard per-workspace cap (``GRAD_MAX_QUEUED_PER_WORKSPACE``), not rate
    limiting, so the SDK never retries it. Wait for queued jobs to start, or cancel
    some, then create the job again.
    """


class FeatureUnavailableError(GradAPIError):
    """501: the server does not offer this capability in its current configuration."""


class InferenceUnavailableError(FeatureUnavailableError):
    """501 ``inference_unavailable``: no inference endpoint is configured for evals."""


class ServerError(GradAPIError):
    """5xx: the server failed. Retried automatically for idempotent requests."""


_STATUS_CLASSES: dict[int, type[GradAPIError]] = {
    400: BadRequestError,
    401: AuthenticationError,
    403: PermissionDeniedError,
    404: NotFoundError,
    409: ConflictError,
    413: PayloadTooLargeError,
    422: ValidationError,
    429: RateLimitError,
    501: FeatureUnavailableError,
}

_CODE_CLASSES: dict[str, type[GradAPIError]] = {
    "inference_unavailable": InferenceUnavailableError,
    "queue_limit": QueueLimitError,
    "cloud_training_unavailable": FeatureUnavailableError,
}

_FIELD_RE = re.compile(r"^([A-Za-z0-9_.\[\]-]+): (.+)$")


def parse_retry_after(value: str | None, *, now: float | None = None) -> float | None:
    """Parse a ``Retry-After`` header (delta seconds or HTTP-date) into seconds >= 0."""
    if not value:
        return None
    value = value.strip()
    try:
        return max(0.0, float(value))
    except ValueError:
        pass
    try:
        when = email.utils.parsedate_to_datetime(value)
    except (TypeError, ValueError, IndexError):
        return None
    if when is None:  # pragma: no cover - defensive, parsedate_to_datetime raises instead
        return None
    current = time.time() if now is None else now
    return max(0.0, when.timestamp() - current)


def _field_errors(body: Mapping[str, Any], detail: str) -> list[FieldError]:
    raw = body.get("errors")
    out: list[FieldError] = []
    if isinstance(raw, list):
        for item in raw:
            if isinstance(item, Mapping):
                path = item.get("path") or item.get("field") or item.get("loc") or ""
                if isinstance(path, list):
                    path = ".".join(str(p) for p in path)
                out.append(FieldError(str(path), str(item.get("message") or item.get("detail") or "")))
        if out:
            return out
    for part in detail.split("; "):
        match = _FIELD_RE.match(part.strip())
        if match:
            out.append(FieldError(match.group(1), match.group(2)))
    return out


def error_from_response(
    *,
    status: int,
    headers: Mapping[str, str],
    body: bytes,
    method: str,
    url: str,
    hint: str | None = None,
) -> GradAPIError:
    """Build the most specific :class:`GradAPIError` for an error response.

    Tolerates any body: problem+json, other JSON (lists, ``null``), HTML or empty.
    """
    text = body.decode("utf-8", errors="replace")
    parsed: Any = None
    if text.strip():
        try:
            parsed = json.loads(text)
        except ValueError:
            parsed = None
    problem: Mapping[str, Any] = parsed if isinstance(parsed, Mapping) else {}

    code = problem.get("code")
    code = code if isinstance(code, str) and code else f"http_{status}"
    title = problem.get("title")
    title = title if isinstance(title, str) and title else f"HTTP {status}"
    detail = problem.get("detail")
    if not isinstance(detail, str) or not detail:
        snippet = " ".join(text.split())[:300]
        detail = snippet if snippet and not problem else title
    request_id = headers.get("x-request-id") or problem.get("request_id")
    request_id = str(request_id) if request_id else None
    if status == 404 and "code" not in problem and urllib.parse.urlsplit(url).hostname == "api.gradiated.com":
        # Gradiated Cloud doesn't route grad's /v1 API yet: its bare 404 isn't a missing resource.
        code, title, detail = "cloud_training_unavailable", "Cloud training unavailable", CLOUD_TRAINING_UNAVAILABLE

    cls = _CODE_CLASSES.get(code) or _STATUS_CLASSES.get(status)
    if cls is None:
        if 300 <= status < 400:
            cls = UnexpectedRedirectError
        elif status >= 500:
            cls = ServerError
        else:
            cls = GradAPIError
    if status == 401 and hint is None:
        hint = _LOGIN_HINT
    return cls(
        status=status,
        code=code,
        title=title,
        detail=detail,
        request_id=request_id,
        method=method,
        url=url,
        headers=headers,
        body=parsed if parsed is not None else (text or None),
        errors=_field_errors(problem, detail) if status in (400, 422) else [],
        hint=hint,
    )
