"""grad-server trainer worker: protocol v1 client (``grad.trainer-protocol/1``).

The worker claims ``train`` and ``import`` jobs (GRAD_WORKER_KINDS narrows that), keeps the lease alive from a
background heartbeat thread, moves weights through upload tickets (presigned
S3 PUTs or the server's streaming blob proxy), and finishes every attempt with
``/complete`` so the server can bill it.

Every worker write is keyed by ``(job, attempt, seq|step)`` on the server, so
the client simply re-sends a request whose response was lost (connection reset,
timeout, 5xx): the replay is stored once.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import random
import secrets
import shutil
import signal
import socket
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, BinaryIO, Callable, Mapping, Sequence

from . import import_runner as connector_import_runner
from .bundles import bundle_directory, extract_bundle
from .loggers import Loggers
from .recipes import V0_RECIPES, RecipeRunner, get_recipe_runner
from .records import merge_records
from .sources import redact
from .runner_types import BaseArtifact, Budget, ResumeState, RunCallbacks

PROTOCOL_VERSION = "grad.trainer-protocol/1"
JOB_KINDS = ("train", "import")
RECORDS_BATCH_LIMIT = 10_000
_CHUNK = 1024 * 1024


def _log(message: str) -> None:
    print(f"[grad-trainer] {message}", file=sys.stderr, flush=True)


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
    """Connection-level failure (refused, DNS, timeout)."""


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


class ProtocolClient:
    """Stdlib HTTP client that never follows redirects and only sends the worker
    key to the grad-server origin."""

    def __init__(
        self,
        base_url: str,
        api_key: str | None,
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
        self.api_key = api_key
        self.timeout_s = timeout_s
        self.retry_base_s = retry_base_s
        self.retry_cap_s = retry_cap_s
        self.sleep = sleep
        self._opener = urllib.request.build_opener(_RefuseRedirects)

    def resolve(self, url: str) -> str:
        """Absolute URLs pass through; server paths are joined to the base URL."""
        if urllib.parse.urlparse(url).scheme:
            return url
        return f"{self.base_url}/{url.lstrip('/')}"

    def _same_origin(self, url: str) -> bool:
        parsed = urllib.parse.urlparse(url)
        return (parsed.scheme, parsed.netloc.lower()) == self._origin

    def _open(
        self,
        method: str,
        url: str,
        *,
        data: bytes | BinaryIO | None = None,
        headers: dict[str, str] | None = None,
    ) -> Any:
        full = self.resolve(url)
        hdrs = dict(headers or {})
        if self.api_key and self._same_origin(full):
            hdrs["Authorization"] = f"Bearer {self.api_key}"
        req = urllib.request.Request(full, data=data, headers=hdrs, method=method)
        try:
            return self._opener.open(req, timeout=self.timeout_s)
        except urllib.error.HTTPError as exc:
            raise _parse_problem(exc.code, exc.read(), full) from None
        except (urllib.error.URLError, OSError, http.client.HTTPException) as exc:
            raise ServerUnreachable(f"{full}: {getattr(exc, 'reason', exc)}") from exc

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

    def download(self, url: str, dest: Path, *, attempts: int = 3) -> None:
        delays = backoff_delays(self.retry_base_s, self.retry_cap_s)
        for attempt in range(1, attempts + 1):
            try:
                with self._open("GET", url) as resp, dest.open("wb") as out:
                    shutil.copyfileobj(resp, out, _CHUNK)
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
    batches: int = 0
    final_status: str = "failed"

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
                    },
                )
            except WorkerAuthError as exc:
                self.state.auth_error = exc
                self.state.request_stop("auth")
                return
            except ServerError as exc:
                if exc.status in (404, 409):
                    _log(f"lease lost for {self.state.job_id}: {exc.detail}")
                    self.state.lease_lost = True
                    self.state.request_stop("lease_lost")
                    return
                _log(f"heartbeat failed ({exc}); retrying")
                continue
            except ServerUnreachable as exc:
                _log(f"heartbeat failed ({exc}); retrying")
                continue
            wait = self.interval_s
            if resp.get("should_stop"):
                self.state.request_stop(str(resp.get("stop_reason") or "cancelled"))


def _parse_jsonl(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    with path.open("r", encoding="utf-8") as fh:
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
        api_key: str | None = None,
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
    ) -> None:
        unknown = sorted(set(kinds) - set(JOB_KINDS))
        if not kinds or unknown:
            raise ValueError(
                f"Job kinds must be a non-empty subset of {', '.join(JOB_KINDS)}; got {list(kinds)}."
            )
        self.kinds = [k for k in JOB_KINDS if k in kinds]
        self.client = client or ProtocolClient(server_url, api_key)
        self.worker_id = worker_id or (
            f"trainer-{socket.gethostname()}-{os.getpid()}-{secrets.token_hex(3)}"
        )
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
        self._shutdown = threading.Event()
        self._current: _JobState | None = None

    # -- public API ---------------------------------------------------------

    def request_shutdown(self) -> None:
        """Stop claiming and ask the running job to stop at its next step."""
        self._shutdown.set()
        if self._current is not None:
            self._current.request_stop("shutdown")

    def claim(self) -> dict[str, Any] | None:
        payload: dict[str, Any] = {
            "worker_id": self.worker_id,
            "lease_seconds": self.lease_seconds,
            "kinds": self.kinds,
        }
        if self.recipes:
            payload["recipes"] = self.recipes
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
        _log(f"claimed {job.get('kind', 'train')} job {state.job_id} attempt {state.attempt}")
        if self._shutdown.is_set():
            state.request_stop("shutdown")
        self._current = state
        self.workdir.mkdir(parents=True, exist_ok=True)
        job_dir = Path(tempfile.mkdtemp(prefix=f"{state.job_id}-", dir=self.workdir))
        heartbeat = _Heartbeat(self, state, self.heartbeat_interval_s)
        heartbeat.start()
        try:
            if job.get("kind") == "import":
                return self._run_import(job, state, job_dir)
            return self._run_train(job, state, job_dir)
        except LeaseLost:
            return {"job_id": state.job_id, "status": "lease_lost"}
        except (WorkerAuthError, SystemExit, KeyboardInterrupt):
            raise
        except Exception as exc:
            # Never silently drop a job (it would sit leased until expiry):
            # hand it back so another attempt runs it now.
            _log(f"job {state.job_id} attempt {state.attempt} crashed ({exc}); abandoning it")
            try:
                return self._complete(
                    state, {"status": "abandoned", "tokens_processed": state.max_tokens}
                )
            except LeaseLost:
                return {"job_id": state.job_id, "status": "lease_lost"}
        finally:
            heartbeat.done.set()
            heartbeat.join(timeout=5)
            self._current = None
            shutil.rmtree(job_dir, ignore_errors=True)
            if state.auth_error is not None:
                raise state.auth_error

    def serve_forever(self) -> int:
        """Run until a shutdown signal; returns a process exit code."""

        def _handle(signum: int, _frame: Any) -> None:
            if self._shutdown.is_set():
                _log("second signal received; exiting immediately")
                raise SystemExit(128 + signum)
            _log("shutdown requested; finishing the current step")
            self.request_shutdown()

        signal.signal(signal.SIGTERM, _handle)
        signal.signal(signal.SIGINT, _handle)
        delays = backoff_delays(max(self.poll_interval_s, 0.5), 30.0)
        while not self._shutdown.is_set():
            try:
                result = self.run_once()
            except WorkerAuthError as exc:
                _log(
                    f"the server rejected the worker key (HTTP {exc.status}: {exc.detail}). "
                    "Set TRAINER_API_KEY to the platform trainer key configured on the server "
                    "(TRAINER_API_KEY / TRAINER_API_KEY_HASH); workspace and admin keys cannot run jobs."
                )
                return 2
            except ServerUnreachable as exc:
                wait = next(delays)
                _log(
                    f"grad-server unreachable at {self.client.base_url} ({exc}), retrying in {wait:.1f}s"
                )
                self._shutdown.wait(wait)
                continue
            except Exception as exc:  # keep the daemon alive across bad jobs
                wait = next(delays)
                _log(f"job error: {exc}; retrying in {wait:.1f}s")
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
    ) -> dict[str, Any]:
        if state.lease_lost:
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
                "records",
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
        self.client.put_file(str(ticket["url"]), path, headers)
        return str(ticket["upload_id"])

    def _complete(self, state: _JobState, payload: dict[str, Any]) -> dict[str, Any]:
        """Retries until the server answers: completion is idempotent per attempt,
        and the bundle stays on disk meanwhile. Gives up only when the lease is
        lost (409/404) or the worker is shutting down."""
        state.final_status = str(payload.get("status") or "failed")
        while True:
            try:
                return self._post(
                    state, "complete", payload, attempts=self.complete_attempts
                )
            except ServerUnreachable as exc:
                error: Exception = exc
            except ServerError as exc:
                if not exc.transient:
                    raise
                error = exc
            _log(f"complete failed ({error}); retrying until the server answers")
            if self._shutdown.wait(self.client.retry_cap_s):
                raise error

    # -- train jobs -----------------------------------------------------------

    def _run_train(
        self, job: dict[str, Any], state: _JobState, job_dir: Path
    ) -> dict[str, Any]:
        run = job.get("run") or {}
        try:
            records = self._load_dataset(job, job_dir)
            resume = self._load_resume(job, job_dir)
            base = self._load_base(job, job_dir)
            runner = self.recipe_runner_factory(str(run["recipe_kind"]))
        except (LeaseLost, WorkerAuthError):
            raise
        except Exception as exc:
            return self._complete(
                state, {"status": "failed", "error": f"setup failed: {exc}"[:4000]}
            )

        trackers = Loggers(
            list(job.get("loggers") or []),
            {"id": run.get("id"), "name": run.get("name"), "config": run.get("resolved_config") or {}},
            lambda message: _log(f"run {run.get('id')}: {message}"),
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
        def on_step(metric: dict[str, Any]) -> bool:
            if state.stop.is_set():
                return True
            point = {**metric}
            point.setdefault("timestamp", _now_iso())
            trackers.log(point)
            tokens = point.get("tokens")
            if isinstance(tokens, (int, float)):
                state.max_tokens = max(state.max_tokens, int(tokens))
            try:
                resp = self._post(state, "progress", {"metric": point}, attempts=2)
            except WorkerAuthError:
                raise
            except (ServerError, ServerUnreachable) as exc:
                _log(f"progress report skipped: {exc}")
                return state.stop.is_set()
            if resp.get("should_stop"):
                state.request_stop(str(resp.get("stop_reason") or "cancelled"))
            return state.stop.is_set()

        def on_checkpoint(
            step: int,
            eval_score: float | None,
            checkpoint_dir: Path,
            metadata: dict[str, Any],
        ) -> None:
            if state.stop_reason == "lease_lost":
                return
            bundle = job_dir / f"checkpoint-{step}.grad.tar.gz"
            try:
                inner = dict(metadata.get("manifest") or {})
                fmt = metadata.get("artifact_format") or inner.get("format")
                info = bundle_directory(
                    checkpoint_dir,
                    bundle,
                    manifest={**inner, "kind": "checkpoint", "step": step, "format": fmt},
                )
                upload_id = self._upload(
                    state, "checkpoint", bundle, info.sha256, info.size_bytes
                )
                self._post(
                    state,
                    "checkpoints",
                    {
                        "step": step,
                        "eval_score": eval_score,
                        "upload_id": upload_id,
                        "format": fmt,
                        "metadata": metadata,
                    },
                )
            except (LeaseLost, WorkerAuthError):
                raise
            except ServerError as exc:
                level = "ignored" if exc.status == 409 else "failed"
                _log(f"checkpoint step {step} {level}: {exc}")
            except Exception as exc:
                _log(f"checkpoint step {step} failed: {exc}")
            finally:
                bundle.unlink(missing_ok=True)

        work = job_dir / "work"
        work.mkdir()
        try:
            output = runner.run(
                dict(run.get("resolved_config") or {}),
                records,
                budget=Budget(
                    job.get("max_cost_usd"),
                    float(job.get("price_per_million_tokens") or 0.0),
                ),
                callbacks=RunCallbacks(on_step=on_step, on_checkpoint=on_checkpoint),
                resume=resume,
                workdir=work,
                base=base,
            )
        except (LeaseLost, WorkerAuthError):
            raise
        except Exception as exc:
            if state.lease_lost:
                raise LeaseLost() from exc
            return self._complete(
                state,
                {
                    "status": "failed",
                    "error": str(exc)[:4000] or type(exc).__name__,
                    "tokens_processed": state.max_tokens,
                },
            )

        if state.lease_lost:
            raise LeaseLost()
        tokens = max(int(output.tokens_processed or 0), state.max_tokens)
        status = str(output.status)
        if status == "cancelled" and state.stop_reason == "shutdown":
            status = "abandoned"
        elif status == "cancelled" and state.stop_reason in ("budget", "insufficient_balance"):
            # Out of workspace balance completes like the run's own cap: resumable.
            status = "stopped_budget"

        if status in ("cancelled", "abandoned", "failed"):
            payload: dict[str, Any] = {"status": status, "tokens_processed": tokens}
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
        artifact_dir = Path(output.artifact_dir)
        if artifact_dir.is_dir() and any(artifact_dir.iterdir()):
            bundle = job_dir / "artifact.grad.tar.gz"
            try:
                info = bundle_directory(
                    artifact_dir,
                    bundle,
                    manifest={**output.manifest, "format": output.artifact_format},
                    eval_report=output.eval_report or None,
                )
            except ValueError as exc:
                # A bundle that breaks its format spec won't pass on a retry either.
                return self._complete(
                    state,
                    {"status": "failed", "error": f"invalid artifact bundle: {exc}"[:4000], "tokens_processed": tokens},
                )
            payload["upload_id"] = self._upload(
                state, "artifact", bundle, info.sha256, info.size_bytes
            )
            # The server stores the bundle's own manifest: files, format_version, created_by.
            payload["manifest"] = info.manifest
        return self._complete(state, payload)

    def _load_dataset(self, job: dict[str, Any], job_dir: Path) -> list[dict[str, Any]]:
        dataset = job.get("dataset")
        if not dataset:
            return []
        path = job_dir / "dataset.jsonl"
        self.client.download(str(dataset["download_url"]), path)
        return merge_records(_parse_jsonl(path))

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
            return self._complete(
                state, {"status": "failed", "error": redact(f"download failed: {exc}", *secrets)[:4000]}
            )

        def emit_batch(records: list[dict[str, Any]]) -> None:
            if state.stop.is_set():
                raise _StopImport()
            for start in range(0, len(records), RECORDS_BATCH_LIMIT):
                self._post(
                    state,
                    "records",
                    {
                        "seq": state.batches,
                        "records": records[start : start + RECORDS_BATCH_LIMIT],
                    },
                    attempts=5,
                )
                state.batches += 1

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
                    "dropped_count": int(summary.skipped),
                    "drop_reasons": [str(e)[:1000] for e in summary.errors[:101]],
                    **({"watermark": summary.watermark} if summary.watermark is not None else {}),
                },
            },
        )


def worker_from_env(env: Mapping[str, str]) -> TrainerWorker:
    """The worker `grad-trainer` runs, configured from the environment.

    GRAD_WORKER_KINDS (comma-separated, default ``train,import``) picks the jobs it claims:
    GPU pods take ``train``; CPU pods take ``import`` (imports and source syncs, the only
    jobs that carry workspace secrets).
    """
    server_url = (
        env.get("GRAD_SERVER_URL")
        or env.get("GRADIATED_BASE_URL")
        or "http://127.0.0.1:8787"
    )
    api_key = (
        env.get("TRAINER_API_KEY")
        or env.get("GRAD_API_KEY")
        or env.get("GRADIATED_API_KEY")
    )
    kinds = [k.strip() for k in env.get("GRAD_WORKER_KINDS", "").split(",") if k.strip()]
    return TrainerWorker(
        server_url=server_url,
        api_key=api_key,
        worker_id=env.get("GRAD_WORKER_ID") or None,
        lease_seconds=int(env.get("GRAD_LEASE_SECONDS", "180")),
        poll_interval_s=float(env.get("GRAD_POLL_INTERVAL_S", "1.0")),
        workdir=env.get("GRAD_WORKDIR") or None,
        kinds=kinds or JOB_KINDS,
    )


def main() -> None:
    worker = worker_from_env(os.environ)
    _log(f"worker '{worker.worker_id}' ({','.join(worker.kinds)}) polling {worker.client.base_url}")
    sys.exit(worker.serve_forever())


if __name__ == "__main__":
    main()
