"""The default live progress of ``run.wait()``: one redrawn terminal line, or a Jupyter display.

``create(progress)`` picks the renderer: ``False`` never; ``True`` always (a terminal line on
stderr outside Jupyter); ``None`` only when someone is watching (Jupyter, or an interactive
terminal that is not CI, ``TERM=dumb`` or ``GRAD_NO_PROGRESS``). Renderers take events from
``runs.wait`` and never raise: a broken display must not break a wait.
"""

from __future__ import annotations

import html
import os
import shutil
import sys
import time
from collections.abc import Callable
from datetime import datetime
from typing import IO, Any

from ._models import (
    AttemptEvent,
    CompletedEvent,
    MetricEvent,
    PhaseEvent,
    Run,
    RunEvent,
    WarningEvent,
)

__all__ = ["NotebookProgress", "Progress", "TerminalProgress", "create", "duration", "sparkline"]

PHASE_LABELS = {
    "queued": "Queued",
    "waiting_for_compute": "Waiting for a GPU",
    "starting": "Starting",
    "loading_model": "Loading model",
    "training": "Training",
    "evaluating": "Evaluating",
    "checkpointing": "Checkpointing",
    "uploading": "Uploading",
    "completing": "Completing",
}

STATUS_LABELS = {
    "completed": "✓ Completed",
    "failed": "✗ Failed",
    "cancelled": "Cancelled",
    "stopped_budget": "Stopped at the budget",
    "stopped_balance": "Stopped: the balance ran out",
}

BAR_WIDTH = 12
SPARK_POINTS = 120


def duration(seconds: float) -> str:
    """``42s``, ``2m 10s``, ``1h 05m``."""
    s = max(0, int(seconds))
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m {s % 60:02d}s"
    return f"{s // 3600}h {s % 3600 // 60:02d}m"


def _epoch(timestamp: str | None) -> float | None:
    if not timestamp:
        return None
    try:
        return datetime.fromisoformat(timestamp.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return None


def sparkline(values: list[float], width: int = 120, height: int = 24) -> str:
    """An inline SVG polyline of ``values`` (empty string with fewer than two)."""
    points = [v for v in values if v == v][-SPARK_POINTS:]  # drop NaN
    if len(points) < 2:
        return ""
    lo, hi = min(points), max(points)
    span = (hi - lo) or 1.0
    step = width / (len(points) - 1)
    coords = " ".join(f"{i * step:.1f},{height - 2 - (v - lo) / span * (height - 4):.1f}" for i, v in enumerate(points))
    return (
        f'<svg width="{width}" height="{height}" viewBox="0 0 {width} {height}" role="img" aria-label="loss">'
        f'<polyline fill="none" stroke="currentColor" stroke-width="1.5" points="{coords}"/></svg>'
    )


class Progress:
    """Run state folded from events; subclasses render it."""

    def __init__(self, *, now: Callable[[], float] = time.time) -> None:
        self._now = now
        self.phase = "queued"
        self.phase_at: float | None = None
        self.workers_online: int | None = None
        self.autoscaling = False
        self.queue_message: str | None = None
        self.gpu: str | None = None
        self.step = 0
        self.total = 0
        self.loss: float | None = None
        self.losses: list[float] = []
        self.cost = 0.0
        self.cap: float | None = None
        self.attempt = 1
        self.status: str | None = None
        self.notes: list[str] = []
        self.shown: set[str] = set()
        """Warnings already shown elsewhere (runs.create issues the plan's as Python warnings)."""
        self._rate_start: tuple[int, float] | None = None
        self._rate_last: tuple[int, float] | None = None

    # -- state ---------------------------------------------------------------------

    def start(self, run: Run) -> None:
        """Seed from the run object (totals, cap, current phase)."""
        self.total = run.total_steps or self.total
        self.cap = run.max_cost_usd
        self.step = run.current_step or self.step
        self.cost = run.cost_usd or self.cost
        self.attempt = run.attempt or self.attempt
        if run.phase:
            self.phase = run.phase
            self.phase_at = _epoch(run.phase_since)
        self.workers_online = run.workers_online
        self.autoscaling = bool(run.autoscaling)
        self.queue_message = run.queue_message
        if run.latest_metric is not None and run.latest_metric.loss is not None:
            self.loss = run.latest_metric.loss
        self.draw()

    def event(self, event: RunEvent) -> None:
        """Fold one event in and redraw (never raises)."""
        try:
            self._apply(event)
            self.draw()
        except Exception:  # pragma: no cover - a display must never break wait()
            pass

    def _apply(self, event: RunEvent) -> None:
        if isinstance(event, PhaseEvent):
            self.phase = event.phase
            self.phase_at = _epoch(event.timestamp)
            self.attempt = event.attempt
            if event.phase in ("queued", "waiting_for_compute"):
                self.workers_online = event.workers_online
                self.autoscaling = bool(event.autoscaling)
                self.queue_message = event.message
            if event.gpu:
                self.gpu = str(event.gpu.get("name") or "") or None
        elif isinstance(event, MetricEvent):
            m = event.metric
            self.step = max(self.step, m.step) if event.attempt == self.attempt else m.step
            if m.loss is not None:
                self.loss = m.loss
                self.losses.append(m.loss)
            self.cost = m.cost_usd or self.cost
            at = _epoch(m.timestamp) or self._now()
            if self._rate_start is None or event.attempt != self.attempt:
                self._rate_start = (m.step, at)
            self._rate_last = (m.step, at)
            self.attempt = event.attempt
        elif isinstance(event, AttemptEvent):
            if event.event == "started":
                self._rate_start = None
                if event.attempt > 1:
                    self.note(f"↻ {event.message}")
            else:
                self.note(f"⚠ {event.message}")
        elif isinstance(event, WarningEvent):
            if event.message not in self.shown:
                self.note(f"⚠ {event.message}")
        elif isinstance(event, CompletedEvent):
            self.status = event.status
            if event.run is not None:
                self.cost = event.run.cost_usd
                self.step = event.run.current_step or self.step

    def note(self, message: str) -> None:
        self.notes.append(message)

    @property
    def eta(self) -> float | None:
        """Seconds left from the observed step rate of this attempt."""
        if self._rate_start is None or self._rate_last is None or not self.total:
            return None
        (s0, t0), (s1, t1) = self._rate_start, self._rate_last
        if s1 <= s0 or t1 <= t0:
            return None
        return (self.total - s1) * (t1 - t0) / (s1 - s0)

    def headline(self) -> str:
        """The phase part: what the run is doing and for how long."""
        since = duration(self._now() - self.phase_at) if self.phase_at else ""
        tail = f" — {since}" if since else ""
        if self.status is not None:
            return STATUS_LABELS.get(self.status, self.status)
        if self.phase in ("queued", "waiting_for_compute"):
            # The server's reason: queue position, a workspace cap, a GPU nobody has.
            if self.queue_message:
                return f"{self.queue_message}{tail}"
            if self.autoscaling and not self.workers_online:
                return f"Starting a worker (autoscaling){tail}"
            # An idle worker claims within a poll; the server says waiting_for_compute after ~30 s.
            if self.phase == "waiting_for_compute":
                n = self.workers_online or 0
                return f"Waiting for a worker ({f'{n} online, all busy' if n else 'none online'}){tail}"
            return f"Queued{tail}"
        label = PHASE_LABELS.get(self.phase, self.phase)
        if self.phase == "starting" and self.gpu:
            label = f"Starting on {self.gpu}"
        if self.phase in ("starting", "loading_model"):
            return f"{label}{tail}"
        return label

    def details(self) -> list[str]:
        """Attempt, step bar, loss, ETA and cost (what follows the headline)."""
        parts: list[str] = []
        if self.attempt > 1 and self.status is None:
            parts.append(f"attempt {self.attempt}")
        if self.total and (self.step or self.phase not in ("queued", "waiting_for_compute", "starting", "loading_model")):
            frac = min(1.0, self.step / self.total)
            filled = int(round(frac * BAR_WIDTH))
            parts.append(f"{self.step}/{self.total} [{'█' * filled}{' ' * (BAR_WIDTH - filled)}] {frac:.0%}")
        if self.loss is not None:
            parts.append(f"loss {self.loss:.4g}")
        eta = self.eta
        if eta is not None and self.status is None and self.phase in ("training", "evaluating", "checkpointing"):
            parts.append(f"ETA {duration(eta)}")
        if self.cost or self.cap is not None:
            parts.append(f"${self.cost:.2f}" + (f"/${self.cap:.2f}" if self.cap is not None else ""))
        return parts

    def line(self) -> str:
        """The compact one-line readout."""
        return "  ".join([self.headline(), *self.details()])

    # -- rendering -----------------------------------------------------------------

    def draw(self) -> None:  # pragma: no cover - overridden
        raise NotImplementedError

    def close(self) -> None:  # pragma: no cover - overridden
        raise NotImplementedError


class TerminalProgress(Progress):
    """One line redrawn with ``\\r``; notes (interruptions, warnings) scroll above it."""

    def __init__(self, stream: IO[str], *, width: int | None = None, now: Callable[[], float] = time.time) -> None:
        super().__init__(now=now)
        self.stream = stream
        self.width = width
        self._printed = 0
        self._closed = False

    def _columns(self) -> int:
        return self.width or max(20, shutil.get_terminal_size((100, 20)).columns - 1)

    def draw(self) -> None:
        if self._closed:
            return
        out = ["\r\x1b[K"]
        for note in self.notes[self._printed :]:
            out.append(f"{note}\n")
        self._printed = len(self.notes)
        out.append(self.line()[: self._columns()])
        self.stream.write("".join(out))
        self.stream.flush()

    def close(self) -> None:
        if self._closed:
            return
        self.draw()
        self.stream.write("\n")
        self.stream.flush()
        self._closed = True


class NotebookProgress(Progress):
    """A small auto-updating HTML display (IPython ``display_id``) with a loss sparkline."""

    MIN_INTERVAL = 0.5

    def __init__(self, display: Callable[..., Any], *, now: Callable[[], float] = time.time, clock: Callable[[], float] = time.monotonic) -> None:
        super().__init__(now=now)
        self._display = display
        self._clock = clock
        self._handle: Any = None
        self._drawn_at: float | None = None

    def html(self) -> str:
        """The display's HTML."""
        spark = sparkline(self.losses)
        notes = "".join(f"<div>{html.escape(n)}</div>" for n in self.notes[-5:])
        bar = f'<progress value="{self.step}" max="{self.total}" style="width:12em"></progress> ' if self.total else ""
        return (
            '<div style="font-family:monospace;font-size:12px;line-height:1.5">'
            f"<div><b>{html.escape(self.headline())}</b></div>"
            f"<div>{bar}{html.escape('  '.join(self.details()))}</div>"
            f"{f'<div>{spark}</div>' if spark else ''}{notes}</div>"
        )

    def draw(self, *, force: bool = False) -> None:
        now = self._clock()
        if not force and self._drawn_at is not None and now - self._drawn_at < self.MIN_INTERVAL and self.status is None:
            return
        self._drawn_at = now
        obj = _HTML(self.html())
        if self._handle is None:
            self._handle = self._display(obj, display_id=True)
        else:
            self._handle.update(obj)

    def close(self) -> None:
        self.draw(force=True)


class _HTML:
    """What ``IPython.display`` renders (``_repr_html_``) without importing IPython here."""

    def __init__(self, text: str) -> None:
        self.text = text

    def _repr_html_(self) -> str:
        return self.text

    def __repr__(self) -> str:
        return "<grad run progress>"


def _notebook_display() -> Callable[..., Any] | None:
    """IPython's ``display`` when running in a Jupyter kernel, else None."""
    shell_mod = sys.modules.get("IPython")
    if shell_mod is None:
        return None
    try:
        from IPython import get_ipython  # type: ignore[import-not-found,unused-ignore]
        from IPython.display import display  # type: ignore[import-not-found,unused-ignore]
    except Exception:  # pragma: no cover - broken IPython install
        return None
    shell = get_ipython()
    if shell is None or "IPKernelApp" not in getattr(shell, "config", {}):
        return None
    fn: Callable[..., Any] = display
    return fn


def _interactive(stream: IO[str], env: dict[str, str]) -> bool:
    if env.get("GRAD_NO_PROGRESS") or env.get("CI") or env.get("TERM") == "dumb":
        return False
    try:
        return bool(stream.isatty())
    except (AttributeError, ValueError):
        return False


def create(progress: bool | None, *, stream: IO[str] | None = None, env: dict[str, str] | None = None) -> Progress | None:
    """The renderer for ``wait(progress=...)``, or None."""
    if progress is False:
        return None
    env = dict(os.environ) if env is None else env
    if progress is None and env.get("GRAD_NO_PROGRESS"):
        return None
    display = _notebook_display()
    if display is not None:
        return NotebookProgress(display)
    out = stream or sys.stderr
    if progress or _interactive(out, env):
        return TerminalProgress(out)
    return None
