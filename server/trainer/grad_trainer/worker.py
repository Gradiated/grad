"""grad-server trainer worker: protocol v1 client (``grad.trainer-protocol/1``).

The worker claims ``train`` and ``import`` jobs (GRAD_WORKER_KINDS narrows that; ``eval`` jobs run on
``grad-server worker --kinds eval``), keeps the lease alive from a
background heartbeat thread, moves weights through upload tickets (presigned
S3 PUTs or the server's streaming blob proxy), and finishes every attempt with
``/complete`` so the server can bill it.

Every worker write is keyed by ``(job, attempt, seq|step)`` on the server, so
the client simply re-sends a request whose response was lost (connection reset,
timeout, 5xx): the replay is stored once.
"""

from __future__ import annotations

import fcntl
import gzip
import hashlib
import http.client
import json
import os
import random
import secrets
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
import traceback
import urllib.error
import urllib.parse
import urllib.request
import zlib
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Callable, Mapping, Sequence

from . import artifact_import
from . import logs
from . import import_runner as connector_import_runner
from .bundles import bundle_directory, extract_bundle
from .errors import GPUOutOfMemoryError, SourceUnavailableError
from .gpu import ALLOC_CONF, release_gpu_memory
from .loggers import Loggers
from .recipes import V0_RECIPES, RecipeRunner, get_recipe_runner
from .parts import Part, PartWriter
from .records import merge_records
from .sources import redact
from .runner_types import BaseArtifact, Budget, ResumeState, RunCallbacks
from .telemetry import WorkerTelemetry

PROTOCOL_VERSION = "grad.trainer-protocol/1"
JOB_KINDS = ("train", "import")
_CHUNK = 1024 * 1024


def _log(message: str, level: str = "info", **fields: Any) -> None:
    logs.log(level, message, **fields)


_JOB_LOCK = ".grad-job.lock"


def _hold_job_dir(job_dir: Path) -> BinaryIO:
    """Locks ``job_dir`` for this process's lifetime (the OS drops it when the process dies)."""
    lock = (job_dir / _JOB_LOCK).open("wb")
    fcntl.flock(lock, fcntl.LOCK_EX)
    return lock


def sweep_stale_job_dirs(workdir: Path) -> int:
    """Deletes job directories a killed worker left behind; returns how many.

    The workdir (an emptyDir in Helm) outlives a container restart, and a
    worker killed mid-job (an OOM kill, SIGKILL after the grace period) never
    reaches its cleanup, so a crash loop would fill the node's disk with
    downloads and bundles. A live job holds its directory's lock; any other
    worker sharing the workdir keeps its own.
    """
    removed = 0
    for lock_path in workdir.glob(f"*/{_JOB_LOCK}"):
        try:
            with lock_path.open("rb") as lock:
                fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                shutil.rmtree(lock_path.parent, ignore_errors=True)
                removed += 1
        except OSError:
            continue  # held by a live job (or already gone)
    if removed:
        _log(f"removed {removed} job directories left by a killed worker in {workdir}")
    return removed


def _log_traceback(what: str, level: str = "error", **fields: Any) -> None:
    """Log the exception being handled, with its stack (call inside ``except``)."""
    logs.log(level, what, exc=True, **fields)


# --- transport -------------------------------------------------------------------


class ServerError(Exception):
    """HTTP error from grad-server or object storage, parsed from problem+json."""

    def __init__(self, status: int, code: str, detail: str, url: str) -> None:
        super().__init__(f"HTTP {status} {code} from {url}: {detail}")
        self.status = status
        self.code = code
        self.detail = detail

    @property
    def transient(self) -> bool:
        return self.status == 429 or self.status >= 500


class WorkerAuthError(ServerError):
    """The server rejected the worker key (401/403); retrying cannot help."""


class ServerUnreachable(Exception):
    """Connection-level failure (refused, DNS, timeout, a body cut short)."""

    transient = True


class _RefuseRedirects(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):  # type: ignore[no-untyped-def]
        return None


def _parse_problem(status: int, body: bytes, url: str) -> ServerError:
    code, detail = f"http_{status}", body.decode("utf-8", errors="replace")[:1000]
    try:
        parsed = json.loads(body)
        if isinstance(parsed, dict):
            code = str(parsed.get("code") or code)
            detail = str(parsed.get("detail") or parsed.get("title") or detail)
    except ValueError:
        pass
    if 300 <= status < 400:
        code, detail = "redirect", "redirects are refused by the trainer worker"
    cls = WorkerAuthError if status in (401, 403) else ServerError
    return cls(status, code, detail or f"HTTP {status}", url)


def backoff_delays(base_s: float, cap_s: float) -> Any:
    """Exponential backoff with full jitter: base, 2·base, ... capped at cap."""
    delay = base_s
    while True:
        yield random.uniform(delay / 2, delay)
        delay = min(cap_s, delay * 2)


class FileToken:
    """GRAD_WORKER_TOKEN_FILE: the worker token, re-read on every request so a rotated
    token (a projected service-account token, a re-minted lease token) is picked up.
    Never logs or reprs the token itself."""

    def __init__(self, path: str | Path) -> None:
        self.path = Path(path)
        self._warned = False

    def __call__(self) -> str | None:
        try:
            token = self.path.read_text(encoding="utf-8").strip()
        except OSError as exc:
            if not self._warned:
                self._warned = True
                _log(f"cannot read GRAD_WORKER_TOKEN_FILE {self.path}: {exc.strerror or exc}", "error")
            return None
        self._warned = False
        return token or None

    def __repr__(self) -> str:
        return f"FileToken({str(self.path)!r})"


TokenSource = Callable[[], "str | None"]


def worker_token_from_env(env: Mapping[str, str]) -> str | TokenSource | None:
    """GRAD_WORKER_TOKEN, else GRAD_WORKER_TOKEN_FILE (re-read per request), else the
    static key names (TRAINER_API_KEY, GRAD_API_KEY, GRADIATED_API_KEY)."""
    token = (env.get("GRAD_WORKER_TOKEN") or "").strip()
    if token:
        return token
    path = (env.get("GRAD_WORKER_TOKEN_FILE") or "").strip()
    if path:
        return FileToken(path)
    return env.get("TRAINER_API_KEY") or env.get("GRAD_API_KEY") or env.get("GRADIATED_API_KEY")


class ProtocolClient:
    """Stdlib HTTP client that never follows redirects and only sends the worker
    token to the grad-server origin."""

    def __init__(
        self,
        base_url: str,
        api_key: str | TokenSource | None,
        *,
        timeout_s: float = 60.0,
        retry_base_s: float = 0.5,
        retry_cap_s: float = 30.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        parsed = urllib.parse.urlparse(base_url)
        if parsed.scheme not in ("http", "https") or not parsed.netloc:
            raise ValueError(
                f"Invalid grad-server URL {base_url!r}; expected http(s)://host[:port]."
            )
        self.base_url = base_url.rstrip("/")
        self._origin = (parsed.scheme, parsed.netloc.lower())
        self._token: TokenSource = api_key if callable(api_key) else (lambda: api_key)
        self._rotating = callable(api_key)
        self.timeout_s = timeout_s
        self.retry_base_s = retry_base_s
        self.retry_cap_s = retry_cap_s
        self.sleep = sleep
        # The current job's W3C traceparent: its requests join the trace that created it.
        self.traceparent: str | None = None
        self._opener = urllib.request.build_opener(_RefuseRedirects)

    def resolve(self, url: str) -> str:
        """Absolute URLs pass through; server paths are joined to the base URL."""
        if urllib.parse.urlparse(url).scheme:
            return url
        return f"{self.base_url}/{url.lstrip('/')}"

    def _same_origin(self, url: str) -> bool:
        parsed = urllib.parse.urlparse(url)
        return (parsed.scheme, parsed.netloc.lower()) == self._origin

    def shown(self, url: str) -> str:
        """``url`` as errors may quote it: errors reach the tenant (run and import errors), so
        never a query string (presigned credentials and signatures)."""
        return urllib.parse.urlparse(self.resolve(url))._replace(query="", fragment="").geturl()

    def _open(
        self,
        method: str,
        url: str,
        *,
        data: bytes | BinaryIO | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        full = self.resolve(url)
        same_origin = self._same_origin(full)
        # Never quote a storage response body either.
        shown = self.shown(full)
        token = self._token() if same_origin else None
        for retry_401 in (True, False):
            hdrs = dict(headers or {})
            if same_origin:
                if token:
                    hdrs["Authorization"] = f"Bearer {token}"
                if self.traceparent:
                    hdrs["traceparent"] = self.traceparent
            req = urllib.request.Request(full, data=data, headers=hdrs, method=method)
            try:
                return self._opener.open(req, timeout=self.timeout_s)
            except urllib.error.HTTPError as exc:
                body = exc.read() if same_origin else b""
                # A token file rotated between the read and the request: one retry
                # with the new token (a body stream cannot be re-sent).
                if exc.code == 401 and retry_401 and self._rotating and not hasattr(data, "read"):
                    fresh = self._token()
                    if fresh and fresh != token:
                        token = fresh
                        continue
                raise _parse_problem(exc.code, body, shown) from None
            except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
                raise ServerUnreachable(f"{shown}: {getattr(exc, 'reason', exc)}") from exc
        raise AssertionError("unreachable")  # pragma: no cover

    def post_json(
        self, path: str, payload: dict[str, Any], *, attempts: int = 1
    ) -> dict[str, Any]:
        """POST JSON; retries connection errors (also a response cut off after the
        server committed), 429 and 5xx up to ``attempts`` times."""
        body = json.dumps(payload).encode("utf-8")
        delays = backoff_delays(self.retry_base_s, self.retry_cap_s)
        for attempt in range(1, attempts + 1):
            try:
                with self._open(
                    "POST",
                    path,
                    data=body,
                    headers={"Content-Type": "application/json"},
                ) as resp:
                    try:
                        raw = resp.read()
                    except (http.client.HTTPException, OSError) as exc:
                        raise ServerUnreachable(f"{path}: response lost ({exc!r})") from exc
                return json.loads(raw) if raw else {}
            except (ServerError, ServerUnreachable) as exc:
                retryable = isinstance(exc, ServerUnreachable) or exc.transient
                if not retryable or attempt == attempts:
                    raise
                self.sleep(next(delays))
        raise AssertionError("unreachable")  # pragma: no cover

    def get_json(self, path: str) -> dict[str, Any]:
        with self._open("GET", path, headers={"Accept": "application/json"}) as resp:
            return json.loads(resp.read())

    def download(self, url: str, dest: Path, *, attempts: int = 5) -> None:
        """GET ``url`` into ``dest``. A connection that drops mid-body, or a body shorter than
        its Content-Length (which ``http.client`` reads as a clean end), is retried from the
        start like a refused connection."""
        delays = backoff_delays(self.retry_base_s, self.retry_cap_s)
        for attempt in range(1, attempts + 1):
            try:
                with self._open("GET", url) as resp, dest.open("wb") as out:
                    expected = resp.headers.get("Content-Length")
                    received = 0
                    while True:
                        try:
                            chunk = resp.read(_CHUNK)
                        except (http.client.HTTPException, OSError) as exc:
                            raise ServerUnreachable(f"{self.shown(url)}: download interrupted ({exc!r})") from exc
                        if not chunk:
                            break
                        out.write(chunk)
                        received += len(chunk)
                    if expected is not None and expected.isdigit() and received != int(expected):
                        raise ServerUnreachable(
                            f"{self.shown(url)}: download ended after {received} of {expected} bytes"
                        )
                return
            except (ServerError, ServerUnreachable) as exc:
                retryable = isinstance(exc, ServerUnreachable) or exc.transient
                if not retryable or attempt == attempts:
                    raise
                self.sleep(next(delays))

    def put_file(
        self, url: str, path: Path, headers: dict[str, str], *, attempts: int = 3
    ) -> None:
        delays = backoff_delays(self.retry_base_s, self.retry_cap_s)
        size = path.stat().st_size
        for attempt in range(1, attempts + 1):
            hdrs = {"Content-Type": "application/octet-stream", **headers}
            hdrs["Content-Length"] = str(size)
            try:
                with (
                    path.open("rb") as fh,
                    self._open("PUT", url, data=fh, headers=hdrs) as resp,
                ):
                    resp.read()
                return
            except (ServerError, ServerUnreachable) as exc:
                retryable = isinstance(exc, ServerUnreachable) or exc.transient
                if not retryable or attempt == attempts:
                    raise
                self.sleep(next(delays))


# --- job execution -------------------------------------------------------------


class LeaseLost(Exception):
    """Another claim owns the job now; this attempt must not complete."""


class _HandBack(Exception):
    """The worker's compute is going away: hand the attempt back now."""


class _StopImport(Exception):
    pass


@dataclass
class _JobState:
    job_id: str
    attempt: int
    stop: threading.Event = field(default_factory=threading.Event)
    stop_reason: str | None = None
    lease_lost: bool = False
    auth_error: WorkerAuthError | None = None
    max_tokens: int = 0
    final_status: str = "failed"
    # Lifecycle: the phase last reported, log line numbering, step/checkpoint timing.
    phase: str | None = None
    step: int = 0
    notes: int = 0
    last_step_at: float | None = None
    step_seconds: float | None = None
    checkpoint_started: float | None = None
    checkpoint_seconds: float | None = None
    # Compute reclaimed: save by this monotonic deadline, then hand the job back.
    reclaim_deadline: float | None = None
    emergency: bool = False
    handed_back: bool = False
    # A /complete is being sent: the reclaim deadline no longer hands it back.
    completing: bool = False

    def request_stop(self, reason: str) -> None:
        if self.stop_reason is None:
            self.stop_reason = reason
        self.stop.set()


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


class _Heartbeat(threading.Thread):
    def __init__(
        self, worker: "TrainerWorker", state: _JobState, interval_s: float
    ) -> None:
        super().__init__(name=f"heartbeat-{state.job_id}", daemon=True)
        self.worker = worker
        self.state = state
        self.interval_s = interval_s
        self.done = threading.Event()

    def run(self) -> None:
        wait = self.interval_s
        while not self.done.wait(wait):
            # After a failure, retry fast (1-5 s) instead of a full interval, so
            # the lease is renewed as soon as the server is back.
            wait = min(self.interval_s, random.uniform(1.0, 5.0))
            try:
                resp = self.worker.client.post_json(
                    f"/v1/trainer-jobs/{self.state.job_id}/heartbeat",
                    {
                        "worker_id": self.worker.worker_id,
                        "attempt": self.state.attempt,
                        "lease_seconds": self.worker.lease_seconds,
                        "stats": self.worker.telemetry.heartbeat_stats(),
                    },
                )
            except WorkerAuthError as exc:
                self.state.auth_error = exc
                self.state.request_stop("auth")
                return
            except ServerError as exc:
                if exc.status in (404, 409):
                    _log(f"lease lost for {self.state.job_id}: {exc.detail}", "warn", code=exc.code)
                    self.state.lease_lost = True
                    self.state.request_stop("lease_lost")
                    return
                _log(f"heartbeat failed ({exc}); retrying", "warn", status=exc.status, code=exc.code)
                continue
            except ServerUnreachable as exc:
                _log(f"heartbeat failed ({exc}); retrying", "warn")
                continue
            wait = self.interval_s
            if resp.get("should_stop"):
                self.state.request_stop(str(resp.get("stop_reason") or "cancelled"))


def _parse_jsonl_gz(path: Path) -> list[dict[str, Any]]:
    """The job dataset download: gzip-compressed JSONL (the dataset's parts, concatenated)."""
    records: list[dict[str, Any]] = []
    with gzip.open(path, "rt", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                records.append(json.loads(line))
    return records


class TrainerWorker:
    """Claims jobs from grad-server and runs them through the recipe-runner seam."""

    def __init__(
        self,
        *,
        server_url: str,
        api_key: str | TokenSource | None = None,
        worker_id: str | None = None,
        lease_seconds: int = 180,
        poll_interval_s: float = 1.0,
        workdir: str | os.PathLike[str] | None = None,
        recipe_runner_factory: Callable[[str], RecipeRunner] = get_recipe_runner,
        import_runner: Any = connector_import_runner,
        recipes: list[str] | None = None,
        heartbeat_interval_s: float | None = None,
        client: ProtocolClient | None = None,
        complete_attempts: int = 8,
        kinds: Sequence[str] = JOB_KINDS,
        telemetry: WorkerTelemetry | None = None,
        reclaim_grace_s: float = 25.0,
        termination_notice: str | None = None,
        gpu: dict[str, Any] | None | bool = True,
    ) -> None:
        unknown = sorted(set(kinds) - set(JOB_KINDS))
        if not kinds or unknown:
            hint = (
                " Eval jobs run on the grad-server image: `grad-server worker --kinds eval`."
                if "eval" in unknown
                else ""
            )
            raise ValueError(
                f"Job kinds must be a non-empty subset of {', '.join(JOB_KINDS)}; got {list(kinds)}.{hint}"
            )
        self.kinds = [k for k in JOB_KINDS if k in kinds]
        self.client = client or ProtocolClient(server_url, api_key)
        # The lease belongs to this process, not to the configured name: a
        # restarted container keeps its GRAD_WORKER_ID (a pod name), and must
        # take a new, billed attempt instead of re-entering its own (r8 B6/B7).
        base = worker_id or f"trainer-{socket.gethostname()}-{os.getpid()}"
        self.worker_id = f"{base[:150]}-{secrets.token_hex(3)}"
        logs.set_worker(worker_id=self.worker_id)
        self.lease_seconds = lease_seconds
        self.poll_interval_s = poll_interval_s
        self.workdir = (
            Path(workdir) if workdir else Path(tempfile.gettempdir()) / "grad-trainer"
        )
        self.recipe_runner_factory = recipe_runner_factory
        self.import_runner = import_runner
        self.recipes = recipes if recipes is not None else sorted(V0_RECIPES)
        self.heartbeat_interval_s = heartbeat_interval_s or max(1.0, lease_seconds / 3)
        self.complete_attempts = complete_attempts
        self.telemetry = telemetry or WorkerTelemetry()
        self.reclaim_grace_s = reclaim_grace_s
        if termination_notice not in (None, "aws"):
            raise ValueError(
                f"Unknown termination notice source {termination_notice!r}; supported: aws."
            )
        self.termination_notice = termination_notice
        # True: detect with nvidia-smi on first claim; a dict or None: use as given.
        self._gpu: dict[str, Any] | None | bool = gpu
        self._shutdown = threading.Event()
        self._current: _JobState | None = None
        self._lock = threading.Lock()

    # -- public API ---------------------------------------------------------

    def request_shutdown(self, grace_s: float | None = None) -> None:
        """The worker's compute is going away (SIGTERM, a termination notice): stop
        claiming and save the running job if a checkpoint fits ``grace_s`` (default
        GRAD_RECLAIM_GRACE_SECONDS); otherwise hand it back at once. Either way the
        job is reported ``abandoned`` (``compute_reclaimed``) and requeues immediately."""
        self._shutdown.set()
        state = self._current
        if state is None:
            return
        with self._lock:
            if state.reclaim_deadline is not None or state.handed_back:
                return
            grace = self.reclaim_grace_s if grace_s is None else grace_s
            now = time.monotonic()
            if state.phase in ("uploading", "completing"):
                # The result is nearly in: let it finish.
                state.reclaim_deadline = now + grace
                return
            fits = state.phase in ("training", "evaluating", "checkpointing") and (
                self._remaining_step(state, now) + (state.checkpoint_seconds or 0.0)
                <= grace
            )
            if fits:
                _log(f"job {state.job_id}: compute reclaimed; checkpointing after the current step (grace {grace:.0f}s)", "warn", phase=state.phase, grace_s=round(grace))
                state.reclaim_deadline = now + grace
                state.request_stop("reclaimed")
                self._arm_deadline(state, grace)
                return
            _log(f"job {state.job_id}: compute reclaimed; no time to checkpoint in phase {state.phase}; handing it back now", "warn", phase=state.phase, grace_s=round(grace))
            state.handed_back = True
            state.request_stop("reclaimed")
        # Too little time to save: hand the attempt back now (off the signal handler).
        threading.Thread(target=self._hand_back, args=(state,), daemon=True).start()

    def _arm_deadline(self, state: _JobState, grace: float) -> None:
        """The grace is a promise to the platform: if the emergency save is still
        running when it ends (a slow checkpoint upload), hand the attempt back anyway,
        so it requeues now as a preemption instead of waiting out its lease as a
        failure once SIGKILL lands. (A finished run's own upload is let run.)"""

        def expire() -> None:
            with self._lock:
                if self._current is not state or state.handed_back or state.completing:
                    return
                _log(f"job {state.job_id}: the {grace:.0f}s grace ran out mid-{state.phase}; handing it back")
                state.handed_back = True
                state.request_stop("reclaimed")
            self._hand_back(state)

        timer = threading.Timer(grace, expire)
        timer.daemon = True
        timer.start()

    @staticmethod
    def _remaining_step(state: _JobState, now: float) -> float:
        if state.step_seconds is None or state.last_step_at is None:
            return 0.0
        return max(0.0, state.step_seconds - (now - state.last_step_at))

    def _hand_back(self, state: _JobState) -> None:
        state.handed_back = True
        try:
            self._complete(
                state,
                {
                    "status": "abandoned",
                    "reason": "compute_reclaimed",
                    "tokens_processed": state.max_tokens,
                },
                force=True,
            )
        except Exception as exc:  # the lease expiry requeues it anyway
            _log_traceback(f"hand-back of job {state.job_id} failed; its lease expiry requeues it", "warn")

    def _report(self, state: _JobState, payload: dict[str, Any]) -> None:
        """Best effort: a lifecycle event never fails the job."""
        try:
            self._post(state, "events", payload, attempts=2)
        except (LeaseLost, WorkerAuthError):
            raise
        except (ServerError, ServerUnreachable) as exc:
            _log(f"event not reported: {exc}", "warn")

    def _phase(self, state: _JobState, phase: str, step: int | None = None) -> None:
        if state.phase == phase:
            return
        state.phase = phase
        self.telemetry.set_phase(phase)
        _log(f"phase {phase}", phase=phase, step=state.step if step is None else step)
        if phase == "checkpointing":
            state.checkpoint_started = time.monotonic()
        self._report(state, {"type": "phase", "phase": phase, "step": state.step if step is None else step})

    def _note(self, state: _JobState, kind: str, message: str) -> None:
        seq, state.notes = state.notes, state.notes + 1
        try:
            self._report(state, {"type": kind, "seq": seq, "message": message[:2000], "step": state.step})
        except LeaseLost:
            pass

    def _report_step(self, state: _JobState, trackers: Loggers, metric: dict[str, Any]) -> bool:
        point = {**metric}
        point.setdefault("timestamp", _now_iso())
        trackers.log(point)
        tokens = point.get("tokens")
        if isinstance(tokens, (int, float)):
            state.max_tokens = max(state.max_tokens, int(tokens))
        self.telemetry.observe_step(tokens if isinstance(tokens, (int, float)) else None)
        try:
            resp = self._post(state, "progress", {"metric": point}, attempts=2)
        except WorkerAuthError:
            raise
        except (ServerError, ServerUnreachable) as exc:
            _log(f"progress report skipped: {exc}", "warn")
            return state.stop.is_set()
        if resp.get("should_stop"):
            state.request_stop(str(resp.get("stop_reason") or "cancelled"))
        return state.stop.is_set()

    def _tracker_warning(self, state: _JobState, run: dict[str, Any], message: str) -> None:
        _log(f"run {run.get('id')}: {message}", "warn")
        if state.notes < 50:  # a flapping tracker must not flood the run's events
            self._note(state, "warning", message)

    def _watch_aws_notice(
        self, poll_s: float = 5.0, notice: Callable[[], float | None] | None = None
    ) -> None:
        """GRAD_TERMINATION_NOTICE=aws: poll EC2 metadata for a termination notice
        (about two minutes ahead) and treat it like SIGTERM with that much grace."""
        check = notice or aws_termination_notice
        while not self._shutdown.wait(poll_s):
            seconds = check()
            if seconds is not None:
                _log(f"termination notice: the instance goes away in {seconds:.0f}s", "warn", seconds=round(seconds))
                self.request_shutdown(grace_s=max(self.reclaim_grace_s, seconds - 5.0))
                return

    def _gpu_info(self) -> dict[str, Any] | None:
        if self._gpu is True:
            self._gpu = detect_gpu()
        return self._gpu if isinstance(self._gpu, dict) else None

    def claim(self) -> dict[str, Any] | None:
        payload: dict[str, Any] = {
            "worker_id": self.worker_id,
            "lease_seconds": self.lease_seconds,
            "kinds": self.kinds,
        }
        if self.recipes:
            payload["recipes"] = self.recipes
        gpu = self._gpu_info() if "train" in self.kinds else None
        # A GPU worker gets only runs whose min_gpu_memory_gb fits gpu.memory_gb.
        payload["device"] = "gpu" if gpu else "cpu"
        if gpu:
            payload["gpu"] = gpu
        resp = self.client.post_json("/v1/trainer-jobs/claim", payload, attempts=5)
        protocol = resp.get("protocol")
        if protocol not in (None, PROTOCOL_VERSION):
            raise RuntimeError(
                f"Unsupported trainer protocol {protocol!r}; expected {PROTOCOL_VERSION}."
            )
        job = resp.get("job")
        return job if isinstance(job, dict) else None

    def run_once(self) -> dict[str, Any] | None:
        """Claim and execute at most one job. Returns the /complete response,
        ``{"job_id", "status": "lease_lost"}``, or None when idle."""
        job = self.claim()
        if job is None:
            return None

        state = _JobState(job_id=str(job["id"]), attempt=int(job["attempt"]))
        kind = str(job.get("kind") or "train")
        owner = job.get("run") or job.get("import") or job.get("artifact_import") or {}
        run = job.get("run") or {}
        with logs.job_context(
            job_id=state.job_id,
            kind=kind,
            attempt=state.attempt,
            run_id=run.get("id"),
            workspace_id=owner.get("workspace_id"),
        ):
            started = time.monotonic()
            _log(
                f"claimed {kind} job {state.job_id} attempt {state.attempt}",
                recipe_kind=run.get("recipe_kind"),
                resume_step=(job.get("resume") or {}).get("step"),
            )
            result = self._run_claimed(job, state, kind)
            outcome = (result or {}).get("status")
            clean = state.final_status in ("completed", "stopped_budget", "cancelled") and outcome not in (
                "lease_lost",
                "handed_back",
            )
            _log(
                f"{kind} job {state.job_id} attempt {state.attempt} finished: {outcome or state.final_status}",
                "info" if clean else "warn",
                status=state.final_status,
                outcome=outcome,
                tokens=state.max_tokens or None,
                duration_s=round(time.monotonic() - started, 1),
            )
            return result

    def _run_claimed(self, job: dict[str, Any], state: _JobState, kind: str) -> dict[str, Any] | None:
        self.telemetry.set_phase("importing" if kind == "import" else "starting")
        traceparent = job.get("traceparent")
        self.client.traceparent = traceparent if isinstance(traceparent, str) else None
        if self._shutdown.is_set():
            state.request_stop("shutdown")
        self._current = state
        self.workdir.mkdir(parents=True, exist_ok=True)
        job_dir = Path(tempfile.mkdtemp(prefix=f"{state.job_id}-", dir=self.workdir))
        job_lock = _hold_job_dir(job_dir)
        heartbeat = _Heartbeat(self, state, self.heartbeat_interval_s)
        heartbeat.start()
        try:
            if job.get("artifact_import"):
                return self._run_artifact_import(job, state, job_dir)
            if job.get("kind") == "import":
                return self._run_import(job, state, job_dir)
            return self._run_train(job, state, job_dir)
        except LeaseLost:
            return {"job_id": state.job_id, "status": "handed_back" if state.handed_back else "lease_lost"}
        except (WorkerAuthError, SystemExit, KeyboardInterrupt):
            raise
        except Exception as exc:
            # Never silently drop a job (it would sit leased until expiry):
            # hand it back so another attempt runs it now.
            _log_traceback(f"job {state.job_id} attempt {state.attempt} crashed ({exc}); abandoning it")
            try:
                return self._complete(
                    state,
                    {
                        "status": "abandoned",
                        "reason": _interruption(exc),
                        "tokens_processed": state.max_tokens,
                    },
                )
            except LeaseLost:
                return {"job_id": state.job_id, "status": "lease_lost"}
        finally:
            heartbeat.done.set()
            heartbeat.join(timeout=5)
            self.telemetry.observe_job(kind, state.final_status)
            self.telemetry.set_phase("idle")
            self.client.traceparent = None
            self._current = None
            shutil.rmtree(job_dir, ignore_errors=True)
            job_lock.close()
            # The runner, its model and outputs are out of scope now: give the GPU back.
            release_gpu_memory()
            if state.auth_error is not None:
                raise state.auth_error

    def serve_forever(self) -> int:
        """Run until a shutdown signal; returns a process exit code."""

        def _handle(signum: int, _frame: Any) -> None:
            if self._shutdown.is_set():
                _log("second signal received; exiting immediately", "warn", signal=signum)
                raise SystemExit(128 + signum)
            _log("shutdown requested; checkpointing the current job if there is time", "warn", signal=signum)
            self.request_shutdown()

        signal.signal(signal.SIGTERM, _handle)
        signal.signal(signal.SIGINT, _handle)
        sweep_stale_job_dirs(self.workdir)
        if self.termination_notice == "aws":
            threading.Thread(target=self._watch_aws_notice, name="termination-notice", daemon=True).start()
        delays = backoff_delays(max(self.poll_interval_s, 0.5), 30.0)
        while not self._shutdown.is_set():
            try:
                result = self.run_once()
            except WorkerAuthError as exc:
                _log(
                    f"the server rejected the worker token (HTTP {exc.status}: {exc.detail}). "
                    "Set GRAD_WORKER_TOKEN or GRAD_WORKER_TOKEN_FILE (a lease or service-account token), "
                    "or TRAINER_API_KEY (a static key from the server's TRAINER_KEYS_JSON / "
                    "TRAINER_API_KEY_HASH); workspace and admin keys cannot run jobs.",
                    "error",
                    status=exc.status,
                    code=exc.code,
                )
                return 2
            except ServerUnreachable as exc:
                wait = next(delays)
                _log(
                    f"grad-server unreachable at {self.client.base_url} ({exc}), retrying in {wait:.1f}s",
                    "warn",
                )
                self._shutdown.wait(wait)
                continue
            except Exception as exc:  # keep the daemon alive across bad jobs
                wait = next(delays)
                _log_traceback(f"job error: {exc}; retrying in {wait:.1f}s")
                self._shutdown.wait(wait)
                continue
            delays = backoff_delays(max(self.poll_interval_s, 0.5), 30.0)
            if result is None:
                self._shutdown.wait(self.poll_interval_s)
        return 0

    # -- shared helpers -------------------------------------------------------

    def _ref(self, state: _JobState) -> dict[str, Any]:
        return {"worker_id": self.worker_id, "attempt": state.attempt}

    def _post(
        self,
        state: _JobState,
        suffix: str,
        payload: dict[str, Any],
        *,
        attempts: int = 3,
        force: bool = False,
    ) -> dict[str, Any]:
        # Once a reclaimed attempt was handed back, only that hand-back may still post.
        if state.lease_lost or (state.handed_back and not force):
            raise LeaseLost()
        try:
            return self.client.post_json(
                f"/v1/trainer-jobs/{state.job_id}/{suffix}",
                {**self._ref(state), **payload},
                attempts=attempts,
            )
        except WorkerAuthError:
            raise
        except ServerError as exc:
            if exc.status in (404, 409) and suffix in (
                "progress",
                "parts",
                "complete",
                "uploads",
                "source-page",
            ):
                state.lease_lost = True
                state.request_stop("lease_lost")
                raise LeaseLost() from exc
            raise

    def _upload(
        self, state: _JobState, kind: str, path: Path, sha256: str, size: int
    ) -> str:
        ticket = self._post(
            state, "uploads", {"kind": kind, "sha256": sha256, "size_bytes": size}
        )
        if ticket.get("method", "PUT") != "PUT":
            raise RuntimeError(f"Unsupported upload method {ticket.get('method')!r}.")
        headers = {str(k): str(v) for k, v in (ticket.get("headers") or {}).items()}
        started = time.monotonic()
        self.client.put_file(str(ticket["url"]), path, headers)
        self.telemetry.observe_upload(kind, size, time.monotonic() - started)
        return str(ticket["upload_id"])

    def _retry_later(self, state: _JobState, why: str) -> dict[str, Any]:
        """Hand back an attempt that failed for a reason another attempt may not hit (grad-server
        or storage unreachable, a download cut short, the Hub down). It counts toward
        max_attempts, so an outage that outlasts them still fails the job."""
        _log(f"job {state.job_id}: {why}; handing it back for another attempt", "warn")
        self._note(state, "warning", f"Attempt {state.attempt} hit a transient error and will be retried: {why}")
        return self._complete(
            state,
            {"status": "abandoned", "reason": "worker_error", "error": why[:4000], "tokens_processed": state.max_tokens},
        )

    def _complete(
        self, state: _JobState, payload: dict[str, Any], *, force: bool = False
    ) -> dict[str, Any]:
        """Retries until the server answers: completion is idempotent per attempt,
        and the bundle stays on disk meanwhile. Gives up only when the lease is
        lost (409/404) or the worker is shutting down."""
        state.final_status = str(payload.get("status") or "failed")
        if not force:
            state.completing = True
        self.telemetry.set_phase("completing")
        while True:
            try:
                return self._post(
                    state, "complete", payload, attempts=self.complete_attempts, force=force
                )
            except ServerUnreachable as exc:
                error: Exception = exc
            except ServerError as exc:
                if not exc.transient:
                    raise
                error = exc
            _log(f"complete failed ({error}); retrying until the server answers", "warn")
            if self._shutdown.wait(self.client.retry_cap_s):
                raise error

    # -- train jobs -----------------------------------------------------------

    def _run_train(
        self, job: dict[str, Any], state: _JobState, job_dir: Path
    ) -> dict[str, Any]:
        run = job.get("run") or {}
        state.step = int((job.get("resume") or {}).get("step") or 0)
        self._phase(state, "loading_model")
        try:
            records = self._load_dataset(job, job_dir)
            resume = self._load_resume(job, job_dir)
            base = self._load_base(job, job_dir)
            runner = self.recipe_runner_factory(str(run["recipe_kind"]))
        except (LeaseLost, WorkerAuthError):
            raise
        except Exception as exc:
            if _transient(exc):
                return self._retry_later(state, f"setup failed: {exc}")
            return self._complete(
                state, {"status": "failed", "error": f"setup failed: {exc}"[:4000]}
            )

        trackers = Loggers(
            list(job.get("loggers") or []),
            {"id": run.get("id"), "name": run.get("name"), "config": run.get("resolved_config") or {}},
            lambda message: self._tracker_warning(state, run, message),
        )
        try:
            return self._train(job, run, state, job_dir, records, resume, base, runner, trackers)
        finally:
            trackers.finish(state.final_status)

    def _train(
        self,
        job: dict[str, Any],
        run: dict[str, Any],
        state: _JobState,
        job_dir: Path,
        records: list[dict[str, Any]],
        resume: ResumeState | None,
        base: BaseArtifact | None,
        runner: RecipeRunner,
        trackers: Loggers,
    ) -> dict[str, Any]:
        def on_step(metric: dict[str, Any]) -> bool | str:
            now = time.monotonic()
            if state.last_step_at is not None:
                took = now - state.last_step_at
                state.step_seconds = took if state.step_seconds is None else 0.7 * state.step_seconds + 0.3 * took
            state.last_step_at = now
            state.step = int(metric.get("step") or state.step)
            if state.handed_back:
                raise LeaseLost()
            reported = False
            if state.reclaim_deadline is None:
                if state.stop.is_set():
                    return True
                stop = self._report_step(state, trackers, metric)
                if state.reclaim_deadline is None:  # (a notice may land during the report)
                    return stop
                reported = True
            # Compute is being reclaimed: keep this step (billed), then save it if there's time.
            if not reported:
                self._report_step(state, trackers, metric)
            if time.monotonic() + (state.checkpoint_seconds or 0.0) <= state.reclaim_deadline:
                state.emergency = True
                self._note(
                    state,
                    "log",
                    f"The worker is shutting down: saving a checkpoint at step {state.step} "
                    "before handing the run back",
                )
                return "checkpoint"
            raise _HandBack()

        def on_checkpoint(
            step: int,
            eval_score: float | None,
            checkpoint_dir: Path,
            metadata: dict[str, Any],
        ) -> None:
            # The training loop calls this from its checkpoint thread, one checkpoint at a
            # time and in order, while training continues.
            if state.stop_reason == "lease_lost" or state.handed_back:
                return
            bundle = job_dir / f"checkpoint-{step}.grad.tar.gz"
            started = time.monotonic()
            reason = "emergency" if state.emergency else "periodic"
            try:
                inner = dict(metadata.get("manifest") or {})
                fmt = metadata.get("artifact_format") or inner.get("format")
                info = bundle_directory(
                    checkpoint_dir,
                    bundle,
                    manifest={**inner, "kind": "checkpoint", "step": step, "format": fmt},
                )
                upload_started = time.monotonic()
                upload_id = self._upload(
                    state, "checkpoint", bundle, info.sha256, info.size_bytes
                )
                upload_seconds = round(time.monotonic() - upload_started, 3)
                self._post(
                    state,
                    "checkpoints",
                    {
                        "step": step,
                        "eval_score": eval_score,
                        "upload_id": upload_id,
                        "format": fmt,
                        "metadata": {**metadata, "upload_seconds": upload_seconds},
                    },
                )
                took = time.monotonic() - started
                self.telemetry.observe_checkpoint(took, reason=reason, ok=True)
                _log(
                    f"checkpoint step {step} saved",
                    step=step,
                    reason=reason,
                    size_bytes=info.size_bytes,
                    upload_s=upload_seconds,
                    duration_s=round(took, 3),
                )
            except (LeaseLost, WorkerAuthError):
                self.telemetry.observe_checkpoint(None, reason=reason, ok=False)
                raise
            except ServerError as exc:
                if exc.status == 409:
                    _log(f"checkpoint step {step} ignored: {exc}", "warn", step=step, reason=reason)
                else:
                    self.telemetry.observe_checkpoint(None, reason=reason, ok=False)
                    _log_traceback(f"checkpoint step {step} failed", step=step, reason=reason)
            except Exception:
                self.telemetry.observe_checkpoint(None, reason=reason, ok=False)
                _log_traceback(f"checkpoint step {step} failed", step=step, reason=reason)
            finally:
                bundle.unlink(missing_ok=True)
                if state.checkpoint_started is not None:
                    state.checkpoint_seconds = time.monotonic() - state.checkpoint_started
            # The emergency checkpoint is the last one taken (an earlier one may still be
            # uploading when the notice lands): hand the run back once it is in.
            if state.emergency and step >= state.step:
                raise _HandBack()

        def on_phase(phase: str, step: int) -> None:
            state.step = step
            self._phase(state, phase, step)


        config = dict(run.get("resolved_config") or {})
        callbacks = RunCallbacks(on_step=on_step, on_checkpoint=on_checkpoint, on_phase=on_phase)
        budget = Budget(job.get("max_cost_usd"), float(job.get("price_per_million_tokens") or 0.0))
        work = job_dir / "work"
        self.telemetry.set_phase("loading_model")
        failure: str | None = None
        retried = False
        while True:
            shutil.rmtree(work, ignore_errors=True)
            work.mkdir()
            retry_tokens: int | None = None
            try:
                output = runner.run(
                    config, records, budget=budget, callbacks=callbacks, resume=resume, workdir=work, base=base
                )
                break
            except (LeaseLost, WorkerAuthError):
                raise
            except _HandBack:
                return self._complete(
                    state,
                    {"status": "abandoned", "reason": "compute_reclaimed", "tokens_processed": state.max_tokens},
                )
            except GPUOutOfMemoryError as exc:
                # Every v0 worker has the same GPU, so another attempt at the same settings
                # would run out too: retry here once at half the micro-batch, else fail.
                _log_traceback(f"job {state.job_id} ran out of GPU memory")
                if state.lease_lost or state.handed_back:
                    raise LeaseLost() from exc
                if not retried and exc.micro_batch_tokens and exc.micro_batch_tokens >= 2048 and not state.stop.is_set():
                    retry_tokens = exc.micro_batch_tokens // 2
                else:
                    failure = str(exc) + (" (already retried with micro_batch_tokens halved)" if retried else "")
            except Exception as exc:
                _log_traceback(f"job {state.job_id} failed")
                if state.lease_lost or state.handed_back:
                    raise LeaseLost() from exc
                if _interruption(exc) == "oom":
                    # Out of memory outside a recipe's step (no micro-batch to halve): another
                    # attempt retries it; counts toward max_attempts.
                    self._note(state, "warning", f"The GPU ran out of memory at step {state.step}; retrying the run")
                    return self._complete(
                        state, {"status": "abandoned", "reason": "oom", "tokens_processed": state.max_tokens}
                    )
                if _transient(exc):
                    return self._retry_later(state, str(exc))
                failure = str(exc) or type(exc).__name__
            if retry_tokens is None:
                break
            # The failed attempt's model and activations are unreachable now; free them first.
            release_gpu_memory()
            self._note(state, "warning", f"The GPU ran out of memory at step {state.step}; retrying with micro_batch_tokens={retry_tokens}")
            _log(
                f"retrying job {state.job_id} once with micro_batch_tokens={retry_tokens}",
                "warn",
                micro_batch_tokens=retry_tokens,
            )
            config = {**config, "micro_batch_tokens": retry_tokens}
            retried = True
        if failure is not None:
            return self._complete(
                state,
                {"status": "failed", "error": failure[:4000], "tokens_processed": state.max_tokens},
            )

        if state.lease_lost:
            raise LeaseLost()
        tokens = max(int(output.tokens_processed or 0), state.max_tokens)
        status = str(output.status)
        if status == "cancelled" and state.stop_reason == "reclaimed":
            status = "abandoned"
        elif status == "cancelled" and state.stop_reason in ("budget", "insufficient_balance"):
            # Out of workspace balance completes like the run's own cap: resumable.
            status = "stopped_budget"

        if status in ("cancelled", "abandoned", "failed"):
            payload: dict[str, Any] = {"status": status, "tokens_processed": tokens}
            if status == "abandoned":
                payload["reason"] = "compute_reclaimed"
            if status == "failed":
                payload["error"] = str(
                    (output.eval_report or {}).get("error") or "recipe reported failure"
                )[:4000]
            return self._complete(state, payload)

        payload = {
            "status": status,
            "format": output.artifact_format,
            "manifest": output.manifest,
            "eval_report": output.eval_report or None,
            "tokens_processed": tokens,
        }
        if status == "stopped_budget":
            # The server tells budget stops (resume with a higher cap) from balance stops
            # (top up) by this; the trainer's own cap check is a budget stop.
            payload["stop_reason"] = (
                "insufficient_balance" if state.stop_reason == "insufficient_balance" else "budget"
            )
        artifact_dir = Path(output.artifact_dir)
        if artifact_dir.is_dir() and any(artifact_dir.iterdir()):
            self._phase(state, "uploading")
            bundle = job_dir / "artifact.grad.tar.gz"
            try:
                info = bundle_directory(
                    artifact_dir,
                    bundle,
                    manifest={
                        **output.manifest,
                        "format": output.artifact_format,
                        "provenance": {"source": "run", "run_id": state.job_id},
                    },
                    eval_report=output.eval_report or None,
                )
            except ValueError as exc:
                # A bundle that breaks its format spec won't pass on a retry either.
                return self._complete(
                    state,
                    {"status": "failed", "error": f"invalid artifact bundle: {exc}"[:4000], "tokens_processed": tokens},
                )
            self.telemetry.set_phase("uploading")
            payload["upload_id"] = self._upload(
                state, "artifact", bundle, info.sha256, info.size_bytes
            )
            # The server stores the bundle's own manifest: files, format_version, created_by.
            payload["manifest"] = info.manifest
        self._phase(state, "completing")
        return self._complete(state, payload)

    def _load_dataset(self, job: dict[str, Any], job_dir: Path) -> list[dict[str, Any]]:
        dataset = job.get("dataset")
        if not dataset:
            return []
        path = job_dir / "dataset.jsonl.gz"
        self.client.download(str(dataset["download_url"]), path)
        try:
            return merge_records(_parse_jsonl_gz(path))
        except (EOFError, zlib.error) as exc:  # a stream cut short that still looked complete
            raise ServerUnreachable(f"the dataset download is truncated or corrupt ({exc})") from exc
        finally:
            path.unlink(missing_ok=True)

    def _load_resume(self, job: dict[str, Any], job_dir: Path) -> ResumeState | None:
        resume = job.get("resume")
        if not resume:
            return None
        archive = job_dir / "resume.grad.tar.gz"
        self.client.download(str(resume["download_url"]), archive)
        target = job_dir / "resume"
        extract_bundle(archive, target)
        archive.unlink(missing_ok=True)
        return ResumeState(step=int(resume["step"]), checkpoint_dir=target)

    def _load_base(self, job: dict[str, Any], job_dir: Path) -> BaseArtifact | None:
        """Continued training: download, verify and extract the starting artifact."""
        base = job.get("base")
        if not base:
            return None
        archive = job_dir / "base.grad.tar.gz"
        self.client.download(str(base["download_url"]), archive)
        digest = hashlib.sha256()
        with archive.open("rb") as fh:
            for chunk in iter(lambda: fh.read(_CHUNK), b""):
                digest.update(chunk)
        if digest.hexdigest() != base["sha256"]:
            raise ValueError(f"starting artifact '{base['artifact_id']}' failed its sha256 check")
        target = job_dir / "base"
        extract_bundle(archive, target)
        archive.unlink(missing_ok=True)
        return BaseArtifact(artifact_id=str(base["artifact_id"]), directory=target)

    # -- import jobs ----------------------------------------------------------

    def _run_artifact_import(
        self, job: dict[str, Any], state: _JobState, job_dir: Path
    ) -> dict[str, Any]:
        """``grad artifacts upload`` / ``import``: validate, bundle, upload, complete."""
        spec = job["artifact_import"]
        token = (spec.get("source") or {}).get("token")
        try:
            info = artifact_import.run(spec, workdir=job_dir, download=self.client.download)
        except (LeaseLost, WorkerAuthError):
            raise
        except artifact_import.InvalidArtifact as exc:
            return self._complete(
                state, {"status": "failed", "error_code": "invalid_artifact", "error": str(exc)[:4000]}
            )
        except (SourceUnavailableError, ServerError, ServerUnreachable) as exc:
            return self._complete(
                state,
                {"status": "failed", "error_code": "source_unavailable", "error": redact(str(exc), token)[:4000]},
            )
        self.telemetry.set_phase("uploading")
        upload_id = self._upload(state, "artifact", info.path, info.sha256, info.size_bytes)
        return self._complete(
            state,
            {"status": "completed", "upload_id": upload_id, "format": spec["format"], "manifest": info.manifest},
        )

    def _run_import(
        self, job: dict[str, Any], state: _JobState, job_dir: Path
    ) -> dict[str, Any]:
        spec = job.get("import") or {}
        runner = self.import_runner
        source = dict(spec.get("source") or {})
        # Provider keys and HF tokens arrive only in this claim; never echo them back.
        secrets = (source.get("secret"), source.get("token"))
        connector = spec.get("connector")
        try:
            if source.get("kind") == "upload":
                path = job_dir / "import-input"
                self.client.download(str(source["download_url"]), path)
                source = {
                    "kind": "file",
                    "path": str(path),
                    "format": source.get("format", "auto"),
                }
        except (LeaseLost, WorkerAuthError):
            raise
        except Exception as exc:
            if _transient(exc):
                return self._retry_later(state, f"download failed: {exc}")
            return self._complete(
                state, {"status": "failed", "error": redact(f"download failed: {exc}", *secrets)[:4000]}
            )

        def upload_part(part: Part) -> None:
            upload_id = self._upload(state, "records", part.path, part.upload_sha256, part.size)
            self._post(
                state,
                "parts",
                {
                    "seq": part.seq,
                    "upload_id": upload_id,
                    "sha256": part.sha256,
                    "count": part.count,
                    "resets": part.resets,
                    "records": part.records,
                    "score_updates": part.score_updates,
                    "detected_scores": part.scores[:1000],
                },
                attempts=5,
            )

        parts = PartWriter(job_dir, upload_part, id_prefix=f"{state.job_id}:{state.attempt}")

        def emit_batch(records: list[dict[str, Any]]) -> None:
            if state.stop.is_set():
                raise _StopImport()
            parts.write(records)

        def source_page(cursor: str | None) -> dict[str, Any]:
            if state.stop.is_set():
                raise _StopImport()
            return self._post(state, "source-page", {"cursor": cursor}, attempts=5)

        work = job_dir / "work"
        work.mkdir()
        try:
            summary = runner.run(
                source,
                None if connector in (None, "auto") else str(connector),
                emit_batch=emit_batch,
                workdir=work,
                source_page=source_page,
            )
            parts.close()
        except (LeaseLost, WorkerAuthError):
            raise
        except _StopImport:
            if state.lease_lost:
                raise LeaseLost() from None
            return self._complete(state, {"status": "abandoned"})
        except Exception as exc:
            return self._complete(
                state,
                {"status": "failed", "error": redact(str(exc), *secrets)[:4000] or type(exc).__name__},
            )
        return self._complete(
            state,
            {
                "status": "completed",
                "import_summary": {
                    "dropped_count": int(summary.skipped) + parts.dropped,
                    "drop_reasons": [str(e)[:1000] for e in [*summary.errors, *parts.reasons][:101]],
                    **({"watermark": summary.watermark, "traces": int(summary.traces)} if summary.watermark is not None else {}),
                },
            },
        )


def _transient(exc: BaseException) -> bool:
    """A failure another attempt may not hit: grad-server or storage unreachable or answering
    429/5xx, a download cut short, a model download that failed on the network."""
    return bool(getattr(exc, "transient", False))


def _interruption(exc: BaseException) -> str:
    """The interruption reason a crash reports: ``oom`` for CUDA out of memory."""
    name = type(exc).__name__
    if name == "OutOfMemoryError" or "CUDA out of memory" in str(exc):
        return "oom"
    return "worker_error"


def detect_gpu(run: Callable[..., Any] = subprocess.run) -> dict[str, Any] | None:
    """The first GPU's name and memory (``nvidia-smi``), or None without one."""
    try:
        out = run(
            ["nvidia-smi", "--query-gpu=name,memory.total", "--format=csv,noheader,nounits"],
            capture_output=True,
            text=True,
            timeout=10,
            check=True,
        ).stdout
        name, mib = [part.strip() for part in out.splitlines()[0].split(",")[:2]]
        return {"name": name[:200], "memory_gb": round(float(mib) / 1024, 1)}
    except (OSError, ValueError, IndexError, subprocess.SubprocessError):
        return None


IMDS = "http://169.254.169.254"


def aws_termination_notice(timeout_s: float = 2.0) -> float | None:
    """Seconds until AWS reclaims this instance (IMDSv2 ``spot/instance-action``), or None."""
    opener = urllib.request.build_opener(_RefuseRedirects)
    try:
        token_req = urllib.request.Request(
            f"{IMDS}/latest/api/token",
            method="PUT",
            headers={"X-aws-ec2-metadata-token-ttl-seconds": "60"},
        )
        with opener.open(token_req, timeout=timeout_s) as resp:
            token = resp.read().decode()
        req = urllib.request.Request(
            f"{IMDS}/latest/meta-data/spot/instance-action",
            headers={"X-aws-ec2-metadata-token": token},
        )
        with opener.open(req, timeout=timeout_s) as resp:
            notice = json.loads(resp.read())
    except (urllib.error.URLError, OSError, ValueError, http.client.HTTPException):
        return None  # 404: no notice (or not on EC2)
    try:
        at = datetime.fromisoformat(str(notice["time"]).replace("Z", "+00:00"))
    except (KeyError, TypeError, ValueError):
        return 0.0
    return max(0.0, (at - datetime.now(timezone.utc)).total_seconds())


def worker_from_env(env: Mapping[str, str]) -> TrainerWorker:
    """The worker `grad-trainer` runs, configured from the environment.

    GRAD_WORKER_KINDS (comma-separated, default ``train,import``) picks the jobs it claims:
    GPU pods take ``train``; CPU pods take ``import`` (imports and source syncs, the only
    jobs that carry workspace secrets). GRAD_WORKER_METRICS_PORT serves Prometheus
    metrics (``grad_trainer_*``) on that port.
    """
    server_url = (
        env.get("GRAD_SERVER_URL")
        or env.get("GRADIATED_BASE_URL")
        or "http://127.0.0.1:8787"
    )
    api_key = worker_token_from_env(env)
    kinds = [k.strip() for k in env.get("GRAD_WORKER_KINDS", "").split(",") if k.strip()]
    telemetry = WorkerTelemetry()
    port = env.get("GRAD_WORKER_METRICS_PORT", "").strip()
    if port:
        telemetry.serve(int(port), env.get("GRAD_WORKER_METRICS_HOST", "0.0.0.0"))
    return TrainerWorker(
        server_url=server_url,
        api_key=api_key,
        worker_id=env.get("GRAD_WORKER_ID") or None,
        lease_seconds=int(env.get("GRAD_LEASE_SECONDS", "180")),
        poll_interval_s=float(env.get("GRAD_POLL_INTERVAL_S", "1.0")),
        workdir=env.get("GRAD_WORKDIR") or None,
        kinds=kinds or JOB_KINDS,
        telemetry=telemetry,
        reclaim_grace_s=float(env.get("GRAD_RECLAIM_GRACE_SECONDS", "25")),
        termination_notice=env.get("GRAD_TERMINATION_NOTICE") or None,
        gpu=_gpu_from_env(env.get("GRAD_WORKER_GPU")),
    )


def _gpu_from_env(raw: str | None) -> dict[str, Any] | None | bool:
    """GRAD_WORKER_GPU: unset = detect, "none" = no GPU, else JSON {name, memory_gb}."""
    if not raw:
        return True
    if raw.strip().lower() == "none":
        return None
    value = json.loads(raw)
    if not isinstance(value, dict) or not {"name", "memory_gb"} <= value.keys():
        raise ValueError('GRAD_WORKER_GPU must be "none" or JSON {"name": ..., "memory_gb": ...}.')
    return {"name": str(value["name"]), "memory_gb": float(value["memory_gb"])}


def main() -> None:
    # Before torch loads: grow the CUDA cache in place instead of fragmenting it (r6: 45 -> 71 GiB).
    os.environ.setdefault("PYTORCH_CUDA_ALLOC_CONF", ALLOC_CONF)
    logs.install()
    worker = worker_from_env(os.environ)
    logs.set_worker(worker_id=worker.worker_id)
    _log(
        f"worker '{worker.worker_id}' ({','.join(worker.kinds)}) polling {worker.client.base_url}",
        kinds=",".join(worker.kinds),
    )
    sys.exit(worker.serve_forever())


if __name__ == "__main__":
    main()
