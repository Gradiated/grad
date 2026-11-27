"""Worker telemetry: an optional Prometheus /metrics endpoint and the few live
numbers each heartbeat carries to grad-server (phase, tokens/s, GPU memory and
utilisation), so workers that can't be scraped still show up in its
``grad_worker_*`` gauges.

``/metrics`` needs ``prometheus_client`` and is served only when
``GRAD_WORKER_METRICS_PORT`` is set. GPU numbers come from NVML (``pynvml``)
when it is installed and a GPU is present, else from torch's allocator.
"""

from __future__ import annotations

import threading
import time
from typing import Any, Callable

PHASES = (
    "idle",
    "starting",
    "loading_model",
    "training",
    "evaluating",
    "checkpointing",
    "uploading",
    "completing",
    "importing",
)

_STEP_BUCKETS = (0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120)
_SLOW_BUCKETS = (0.5, 1, 5, 15, 30, 60, 120, 300, 600, 1800)


_NVML: list[Any] = []  # [module or None] once probed


def _nvml() -> Any | None:
    """pynvml, initialised once; None without the package or a driver."""
    if not _NVML:
        try:
            import pynvml  # type: ignore[import-not-found]

            pynvml.nvmlInit()
            _NVML.append(pynvml)
        except Exception:
            _NVML.append(None)
    return _NVML[0]


def gpu_stats() -> list[dict[str, float]]:
    """Per-GPU ``{"utilization", "memory_used_bytes"}`` (utilization 0-1, or -1
    when unknown); empty without a GPU."""
    nvml = _nvml()
    if nvml is not None:
        try:
            out = []
            for i in range(nvml.nvmlDeviceGetCount()):
                handle = nvml.nvmlDeviceGetHandleByIndex(i)
                util = nvml.nvmlDeviceGetUtilizationRates(handle)
                mem = nvml.nvmlDeviceGetMemoryInfo(handle)
                out.append(
                    {"utilization": float(util.gpu) / 100.0, "memory_used_bytes": float(mem.used)}
                )
            return out
        except Exception:
            pass
    try:
        import torch

        if not torch.cuda.is_available():
            return []
        return [
            {"utilization": -1.0, "memory_used_bytes": float(torch.cuda.memory_allocated(i))}
            for i in range(torch.cuda.device_count())
        ]
    except Exception:
        return []


class WorkerTelemetry:
    """Thread-safe live state of one worker; optionally exported on /metrics."""

    def __init__(
        self,
        *,
        clock: Callable[[], float] = time.monotonic,
        gpus: Callable[[], list[dict[str, float]]] = gpu_stats,
    ) -> None:
        self._clock = clock
        self._gpus = gpus
        self._lock = threading.Lock()
        self.phase = "idle"
        self.tokens_per_second = 0.0
        self._last_step: tuple[float, float] | None = None  # (time, tokens)
        self._prom: dict[str, Any] | None = None
        self.server: Any = None

    # -- state -------------------------------------------------------------

    def set_phase(self, phase: str) -> None:
        phase = phase if phase in PHASES else "idle"
        with self._lock:
            self.phase = phase
            if phase in ("idle", "starting"):
                self._last_step = None
                self.tokens_per_second = 0.0
        if self._prom:
            for p in PHASES:
                self._prom["phase"].labels(phase=p).set(1 if p == phase else 0)

    def observe_step(self, tokens: float | None) -> None:
        """A training step reported ``tokens`` (cumulative for the attempt)."""
        now = self._clock()
        seconds = None
        with self._lock:
            self.phase = "training"
            if isinstance(tokens, (int, float)):
                if self._last_step is not None:
                    t0, k0 = self._last_step
                    seconds = now - t0
                    if seconds > 0 and tokens >= k0:
                        self.tokens_per_second = (tokens - k0) / seconds
                self._last_step = (now, float(tokens))
        if self._prom:
            self.set_phase("training")
            self._prom["steps"].inc()
            if seconds is not None:
                self._prom["step_seconds"].observe(seconds)

    def observe_checkpoint(
        self, seconds: float | None, *, reason: str = "periodic", ok: bool = True
    ) -> None:
        """A checkpoint saved (``ok``, taking ``seconds``) or lost; ``reason`` is
        ``periodic`` or ``emergency`` (saved because compute is being reclaimed)."""
        if self._prom:
            self._prom["checkpoints"].labels(reason=reason, result="ok" if ok else "failed").inc()
            if ok and seconds is not None:
                self._prom["checkpoint_seconds"].observe(seconds)

    def observe_upload(self, kind: str, size_bytes: int, seconds: float) -> None:
        if self._prom:
            self._prom["upload_bytes"].labels(kind=kind).inc(size_bytes)
            self._prom["upload_seconds"].labels(kind=kind).observe(seconds)

    def observe_job(self, kind: str, status: str) -> None:
        if self._prom:
            self._prom["jobs"].labels(kind=kind, status=status).inc()

    def heartbeat_stats(self) -> dict[str, Any]:
        """The ``stats`` object of a heartbeat."""
        with self._lock:
            stats: dict[str, Any] = {
                "phase": self.phase,
                "tokens_per_second": round(self.tokens_per_second, 3),
            }
        gpus = self._gpus()
        if gpus:
            stats["gpu_memory_used_bytes"] = sum(g["memory_used_bytes"] for g in gpus)
            known = [g["utilization"] for g in gpus if g["utilization"] >= 0]
            if known:
                stats["gpu_utilization"] = min(1.0, max(0.0, sum(known) / len(known)))
        return stats

    # -- /metrics -------------------------------------------------------------

    def serve(self, port: int, host: str = "0.0.0.0") -> Any:
        """Starts the /metrics endpoint (needs prometheus_client)."""
        try:
            import prometheus_client as prom
            from prometheus_client.core import GaugeMetricFamily
        except ImportError as exc:  # pragma: no cover - the images install it
            raise RuntimeError(
                "GRAD_WORKER_METRICS_PORT needs the prometheus_client package."
            ) from exc

        registry = prom.CollectorRegistry()
        prom.ProcessCollector(registry=registry)
        prom.PlatformCollector(registry=registry)
        telemetry = self

        class _Live:
            def collect(self) -> Any:
                tps = GaugeMetricFamily(
                    "grad_trainer_tokens_per_second", "Tokens per second over the last step."
                )
                tps.add_metric([], telemetry.tokens_per_second)
                yield tps
                util = GaugeMetricFamily(
                    "grad_trainer_gpu_utilization_ratio", "GPU utilisation (0-1).", labels=["gpu"]
                )
                mem = GaugeMetricFamily(
                    "grad_trainer_gpu_memory_used_bytes", "GPU memory in use.", labels=["gpu"]
                )
                for i, g in enumerate(telemetry._gpus()):
                    if g["utilization"] >= 0:
                        util.add_metric([str(i)], g["utilization"])
                    mem.add_metric([str(i)], g["memory_used_bytes"])
                yield util
                yield mem

        registry.register(_Live())  # type: ignore[arg-type]
        self._prom = {
            "phase": prom.Gauge(
                "grad_trainer_phase", "1 for the worker's current phase.", ["phase"], registry=registry
            ),
            "steps": prom.Counter("grad_trainer_steps", "Training steps reported.", registry=registry),
            "step_seconds": prom.Histogram(
                "grad_trainer_step_duration_seconds",
                "Time between reported training steps.",
                buckets=_STEP_BUCKETS,
                registry=registry,
            ),
            "checkpoint_seconds": prom.Histogram(
                "grad_trainer_checkpoint_duration_seconds",
                "Time to bundle, upload and register a checkpoint.",
                buckets=_SLOW_BUCKETS,
                registry=registry,
            ),
            "checkpoints": prom.Counter(
                "grad_trainer_checkpoints",
                "Checkpoints this worker saved or lost, by reason (periodic, emergency) and result (ok, failed).",
                ["reason", "result"],
                registry=registry,
            ),
            "upload_bytes": prom.Counter(
                "grad_trainer_upload_bytes", "Bytes uploaded, by kind.", ["kind"], registry=registry
            ),
            "upload_seconds": prom.Histogram(
                "grad_trainer_upload_duration_seconds",
                "Upload time, by kind (checkpoint, artifact).",
                ["kind"],
                buckets=_SLOW_BUCKETS,
                registry=registry,
            ),
            "jobs": prom.Counter(
                "grad_trainer_jobs", "Jobs this worker finished, by kind and status.", ["kind", "status"], registry=registry
            ),
        }
        self.set_phase(self.phase)
        self.server, _thread = prom.start_http_server(port, addr=host, registry=registry)
        return self.server

    def close(self) -> None:
        if self.server is not None:
            self.server.shutdown()
            self.server.server_close()
            self.server = None
