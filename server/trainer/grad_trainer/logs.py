"""Structured JSON logs for the trainer worker: one object per line on stdout.

Every line carries ``time``, ``level``, ``component`` (``trainer``) and ``msg``,
plus the worker's context (``worker_id``) and, while a job runs, the job's
(``job_id``, ``kind``, ``attempt``, ``run_id``, ``workspace_id``). A worker runs
one job at a time, so the job context is process-wide and the heartbeat and
checkpoint threads share it. ``exc=True`` inside an ``except`` adds the error
and its stack. Credential-shaped substrings (bearer tokens, grad keys and lease
tokens, presigned-URL signatures, provider keys) are masked before a line is
written; secrets the worker knows by value are masked by the callers
(``sources.redact``).

``install()`` also routes Python ``logging`` (transformers, peft, urllib3) and
``warnings`` through the same JSON format.
"""

from __future__ import annotations

import json
import logging
import re
import sys
import threading
import traceback
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any, Iterator

COMPONENT = "trainer"

_lock = threading.Lock()
_worker: dict[str, Any] = {}
_job: dict[str, Any] = {}

_SECRETS = (
    (re.compile(r"(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}", re.I), r"\1***"),
    (re.compile(r"\bgrad_[0-9a-f]{48}\b"), "grad_***"),
    (re.compile(r"\bgradwt_[A-Za-z0-9_-]{16,}"), "gradwt_***"),
    (re.compile(r"(X-Amz-(?:Signature|Credential|Security-Token)=)[^&\"\s\\]+", re.I), r"\1***"),
    (re.compile(r"\b(sk|hf|pk|sk-lf|pk-lf)[-_][A-Za-z0-9_-]{16,}"), r"\1-***"),
)


def redact_secrets(text: str) -> str:
    for pattern, sub in _SECRETS:
        text = pattern.sub(sub, text)
    return text


def set_worker(**fields: Any) -> None:
    """Fields every line of this process carries (``worker_id``)."""
    with _lock:
        _worker.update({k: v for k, v in fields.items() if v is not None})


@contextmanager
def job_context(**fields: Any) -> Iterator[None]:
    """Adds the job's ids to every line while it runs (any thread)."""
    with _lock:
        _job.clear()
        _job.update({k: v for k, v in fields.items() if v is not None})
    try:
        yield
    finally:
        with _lock:
            _job.clear()


def log(level: str, msg: str, *, exc: bool = False, **fields: Any) -> None:
    """Writes one JSON line; ``exc=True`` (inside ``except``) adds error and stack."""
    with _lock:
        line: dict[str, Any] = {
            "time": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
            "level": level,
            "component": COMPONENT,
            "msg": msg,
            **_worker,
            **_job,
        }
    line.update({k: v for k, v in fields.items() if v is not None})
    if exc:
        error = sys.exc_info()[1]
        if error is not None:
            line["error"] = str(error) or type(error).__name__
            line["error_type"] = type(error).__name__
            line["stack"] = traceback.format_exc().rstrip()
    text = redact_secrets(json.dumps(line, default=str, ensure_ascii=False, separators=(",", ":")))
    try:
        sys.stdout.write(text + "\n")
        sys.stdout.flush()
    except (OSError, ValueError):  # a closed stdout must never kill the worker
        pass


class _JsonHandler(logging.Handler):
    def emit(self, record: logging.LogRecord) -> None:
        level = {logging.DEBUG: "debug", logging.INFO: "info", logging.WARNING: "warn"}.get(
            record.levelno, "error"
        )
        fields: dict[str, Any] = {"logger": record.name}
        if record.exc_info and record.exc_info[1] is not None:
            fields["error"] = str(record.exc_info[1])
            fields["stack"] = "".join(traceback.format_exception(*record.exc_info)).rstrip()
        try:
            message = record.getMessage()
        except Exception:  # a bad format string in a library
            message = str(record.msg)
        log(level, message, **fields)


def install(level: int = logging.WARNING) -> None:
    """Routes the root logger and ``warnings`` through ``log`` (call once, in main)."""
    root = logging.getLogger()
    for handler in list(root.handlers):
        root.removeHandler(handler)
    root.addHandler(_JsonHandler())
    root.setLevel(level)
    logging.captureWarnings(True)
    # huggingface_hub adds its own stderr handler when imported, so its warnings
    # came out twice, once as a raw non-JSON line: import it now and drop that.
    try:
        import huggingface_hub.utils.logging  # noqa: F401
    except ImportError:
        return
    hub = logging.getLogger("huggingface_hub")
    for handler in list(hub.handlers):
        hub.removeHandler(handler)
