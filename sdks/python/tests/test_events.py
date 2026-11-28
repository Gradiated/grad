"""Run events: typed models, ``runs.events()`` (pages and live SSE), ``wait(on_event)`` and progress."""

from __future__ import annotations

import io
import json
import sys
import types
import unittest
from datetime import datetime
from typing import Any
from unittest import mock

from _fakes import Reply, fixture, json_reply, make_client, refused

import grad
from grad import _progress
from grad._models import run_event_from_api

PAGE = fixture("run-events-page.json")
RID = PAGE["run_id"]
EVENTS = PAGE["data"]
SSE = fixture("run-events.sse")
FINAL_RUN = EVENTS[-1]["run"]


def sse_reply(body: str, error: BaseException | None = None) -> Reply:
    return Reply(200, headers={"content-type": "text/event-stream"}, chunks=[body.encode()], error=error)


def frame(raw: dict[str, Any]) -> str:
    seq = "" if raw["type"] == "completed" else f"id: {raw['seq']}\n"
    return f"event: {raw['type']}\ndata: {json.dumps(raw)}\n{seq}\n"


def summary(events: list[Any]) -> list[str]:
    return [f"{e.type}:{getattr(e, 'phase', None) or getattr(e, 'event', None) or getattr(e, 'status', '')}" for e in events]


def epoch(ts: str) -> float:
    return datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()


def run_with(**fields: Any) -> dict[str, Any]:
    return {**FINAL_RUN, **fields}


class EventModelTests(unittest.TestCase):
    def test_every_type_parses_and_unknown_types_are_skipped(self) -> None:
        events = [run_event_from_api(e) for e in EVENTS]
        self.assertTrue(all(e is not None and e.run_id == RID for e in events))
        phase = events[4]
        assert isinstance(phase, grad.PhaseEvent)
        self.assertEqual((phase.phase, phase.gpu, phase.attempt), ("starting", {"name": "NVIDIA H100 80GB HBM3", "memory_gb": 79.6}, 1))
        metric = events[8]
        assert isinstance(metric, grad.MetricEvent)
        self.assertIsInstance(metric.metric, grad.MetricPoint)
        self.assertEqual((metric.step, metric.metric.eval_loss), (2, 0.52))
        interrupted = events[12]
        assert isinstance(interrupted, grad.AttemptEvent)
        self.assertEqual((interrupted.reason, interrupted.step, interrupted.resume_step), ("compute_reclaimed", 2, 2))
        done = events[-1]
        assert isinstance(done, grad.CompletedEvent) and done.run is not None
        self.assertEqual(done.status, "completed")
        self.assertIsNone(done.run.phase)  # finished: no phase
        assert done.run.last_interruption is not None
        self.assertEqual(done.run.last_interruption.message, "attempt 1 interrupted at step 2: the GPU was reclaimed; resuming from step 2 on a new worker")
        self.assertIn("PhaseEvent(", repr(phase))
        self.assertIsNone(run_event_from_api({"type": "telemetry", "seq": 99}))

    def test_run_lifecycle_fields(self) -> None:
        run = grad.Run.from_api(run_with(status="queued", phase="waiting_for_compute", workers_online=2, autoscaling=False, last_interruption=None))
        self.assertEqual((run.phase, run.workers_online, run.autoscaling, run.last_interruption), ("waiting_for_compute", 2, False, None))


class EventsIteratorTests(unittest.TestCase):
    def test_pages_follow_next_cursor_and_stop(self) -> None:
        first = {**PAGE, "data": EVENTS[:10], "next_cursor": "c10"}
        rest = {**PAGE, "data": EVENTS[10:]}
        client, sender, _ = make_client({f"GET /v1/runs/{RID}/events": [json_reply(first), json_reply(rest)]})
        events = list(grad.Run.from_api(FINAL_RUN, client).events())
        self.assertEqual(len(events), len(EVENTS))
        self.assertEqual(sender.sent[0].query, {"limit": ["100"]})
        self.assertEqual(sender.sent[1].query["cursor"], ["c10"])

    def test_a_repeated_cursor_stops_with_a_typed_error(self) -> None:
        loop = {**PAGE, "data": EVENTS[:2], "next_cursor": "same"}
        client, _, _ = make_client({f"GET /v1/runs/{RID}/events": json_reply(loop)})
        with self.assertRaises(grad.PaginationLoopError):
            list(client.runs.events(RID))

    def test_follow_streams_every_event_and_stops_after_completed(self) -> None:
        unknown = 'event: telemetry\ndata: {"type": "telemetry", "seq": 3}\nid: 3\n\n'
        client, sender, _ = make_client({f"GET /v1/runs/{RID}/events": sse_reply(unknown + SSE + frame(EVENTS[0]))})
        events = list(client.runs.events(RID, follow=True))
        self.assertEqual(summary(events), [summary([run_event_from_api(e)])[0] for e in EVENTS])
        self.assertEqual(sender.sent[0].header("Accept"), "text/event-stream")
        self.assertIsNone(sender.sent[0].header("Last-Event-ID"))

    def test_reconnects_resume_after_the_last_seq_invisibly(self) -> None:
        cut = "".join(frame(e) for e in EVENTS[:8])
        again = "".join(frame(e) for e in EVENTS[6:])  # the server replays two: deduped
        client, sender, clock = make_client(
            {f"GET /v1/runs/{RID}/events": [sse_reply("retry: 300\n\n" + cut, ConnectionResetError("drop")), refused(), sse_reply(again)]},
            max_retries=0,
        )
        events = list(client.runs.events(RID, follow=True))
        self.assertEqual([e.seq for e in events], [e["seq"] for e in EVENTS])
        self.assertEqual([s.header("Last-Event-ID") for s in sender.sent], [None, str(EVENTS[7]["seq"]), str(EVENTS[7]["seq"])])
        self.assertTrue(all(0 < s <= 10 for s in clock.sleeps))

    def test_gives_up_after_repeated_failures_and_honours_the_timeout(self) -> None:
        client, _, _ = make_client({f"GET /v1/runs/{RID}/events": sse_reply(": ping\n\n")})
        with self.assertRaises(grad.APIConnectionError) as ctx:
            list(client.runs.events(RID, follow=True))
        self.assertIn("Lost the event stream", str(ctx.exception))
        client, _, _ = make_client({f"GET /v1/runs/{RID}/events": refused()}, max_retries=0)
        with self.assertRaises(grad.APIConnectionError):
            list(client.runs.events(RID, follow=True))
        client, _, clock = make_client({f"GET /v1/runs/{RID}/events": sse_reply(": ping\n\n")})
        self.assertEqual(list(client.runs.events(RID, follow=True, timeout=3)), [])
        self.assertGreaterEqual(clock.now, 1003)
        client, _, _ = make_client({f"GET /v1/runs/{RID}/events": refused()}, max_retries=0)
        self.assertEqual(list(client.runs.events(RID, follow=True, timeout=0)), [])


class WaitEventsTests(unittest.TestCase):
    def test_on_event_gets_every_event_in_order_and_on_status_each_phase_change(self) -> None:
        runs = iter(
            [run_with(status="queued", phase="queued"), run_with(status="queued", phase="waiting_for_compute")]
            + [run_with(status="running", phase="starting")] * 3
            + [run_with(status="running", phase="training")] * 100
        )
        client, sender, _ = make_client(
            {f"GET /v1/runs/{RID}/events": sse_reply(SSE), f"GET /v1/runs/{RID}": lambda _s: json_reply(next(runs))}
        )
        seen: list[Any] = []
        statuses: list[tuple[str, str | None]] = []
        run = grad.Run.from_api(run_with(status="queued"), client).wait(
            on_event=seen.append, on_status=lambda r: statuses.append((r.status, r.phase)), progress=False
        )
        self.assertEqual([e.seq for e in seen], [e["seq"] for e in EVENTS])
        self.assertIsInstance(seen[-1], grad.CompletedEvent)
        self.assertEqual(run.status, "completed")
        self.assertEqual(
            statuses,
            [("queued", "queued"), ("queued", "waiting_for_compute"), ("running", "starting"), ("running", "training"), ("completed", None)],
        )

    def test_wait_follows_until_terminal_even_if_the_stream_ends_early(self) -> None:
        client, _, _ = make_client(
            {
                f"GET /v1/runs/{RID}/events": [sse_reply("".join(frame(e) for e in EVENTS[:3]), ConnectionResetError("x")), refused()],
                f"GET /v1/runs/{RID}": json_reply(FINAL_RUN),
            },
            max_retries=0,
        )
        seen: list[Any] = []
        with mock.patch("grad._resources.MAX_EVENT_RECONNECTS", 1):
            with self.assertRaises(grad.APIConnectionError):
                client.runs.wait(RID, on_event=seen.append, progress=False)
        self.assertEqual(len(seen), 3)

    def test_progress_true_draws_on_stderr(self) -> None:
        client, _, _ = make_client({f"GET /v1/runs/{RID}/events": sse_reply(SSE), f"GET /v1/runs/{RID}": json_reply(run_with(status="queued", phase="queued", total_steps=5, max_cost_usd=1.0))})
        err = io.StringIO()
        with mock.patch.object(sys, "stderr", err), mock.patch.dict("os.environ", {}, clear=False):
            client.runs.wait(RID, progress=True)
        out = err.getvalue()
        self.assertIn("⚠ attempt 1 interrupted at step 2: the GPU was reclaimed; resuming from step 2 on a new worker\n", out)
        self.assertIn("↻ attempt 2 started, resuming from step 2\n", out)
        self.assertTrue(out.endswith("\n"))
        self.assertIn("✓ Completed", out.rsplit("\r\x1b[K", 1)[-1])

    def test_progress_auto_is_silent_when_not_interactive(self) -> None:
        client, sender, _ = make_client({f"GET /v1/runs/{RID}": json_reply(FINAL_RUN)})
        err = io.StringIO()
        with mock.patch.object(sys, "stderr", err):
            self.assertEqual(client.runs.wait(RID).status, "completed")
        self.assertEqual(err.getvalue(), "")
        self.assertEqual(sender.paths(), [f"GET /v1/runs/{RID}"], "no stream without a consumer")


class TTY(io.StringIO):
    def isatty(self) -> bool:
        return True


class ProgressTests(unittest.TestCase):
    def replay(self, renderer: _progress.Progress, clock: list[float], upto: int | None = None) -> list[str]:
        lines = []
        for raw in EVENTS[:upto]:
            clock[0] = epoch(raw["timestamp"]) + 130
            event = run_event_from_api(raw)
            assert event is not None
            renderer.event(event)
            lines.append(renderer.line())
        return lines

    def terminal(self) -> tuple[_progress.TerminalProgress, io.StringIO, list[float]]:
        clock = [0.0]
        buf = io.StringIO()
        renderer = _progress.TerminalProgress(buf, width=100, now=lambda: clock[0])
        renderer.start(grad.Run.from_api(run_with(status="queued", phase="queued", total_steps=5, max_cost_usd=1.0, cost_usd=0.0, current_step=0, latest_metric=None, attempt=0)))
        return renderer, buf, clock

    def test_terminal_line_snapshots(self) -> None:
        renderer, buf, clock = self.terminal()
        lines = self.replay(renderer, clock)
        self.assertEqual(lines[0], "Queued behind 2 runs — 2m 10s  $0.00/$1.00")
        self.assertEqual(lines[2], "Queued behind 1 run — 2m 10s  $0.00/$1.00")
        self.assertEqual(lines[4], "Starting on NVIDIA H100 80GB HBM3 — 2m 10s  $0.00/$1.00")
        self.assertEqual(lines[8], "Training  2/5 [█████       ] 40%  loss 0.3333  ETA 3s  $0.00/$1.00")
        self.assertEqual(lines[13], "Queued — 2m 10s  attempt 2  2/5 [█████       ] 40%  loss 0.3333  $0.00/$1.00")
        self.assertEqual(lines[19], "Training  attempt 2  3/5 [███████     ] 60%  loss 0.25  $0.00/$1.00")
        self.assertEqual(lines[-1], "✓ Completed  3/5 [███████     ] 60%  loss 0.25  $0.00/$1.00")
        renderer.close()
        renderer.close()
        out = buf.getvalue()
        notes = [line.split("\r\x1b[K")[-1] for line in out.split("\n") if "⚠" in line or "↻" in line]
        self.assertEqual(
            notes,
            [
                "⚠ 5 steps is below the 100 we recommend; use batch_size=1 or more epochs/data.",
                "⚠ attempt 1 interrupted at step 2: the GPU was reclaimed; resuming from step 2 on a new worker",
                "↻ attempt 2 started, resuming from step 2",
                "⚠ wandb logger disabled: WANDB_API_KEY is not set",
                "⚠ Only 4 held-out records; eval metrics are noisy.",
            ],
        )
        self.assertEqual(out.count("⚠ attempt 1 interrupted"), 1, "a note prints once")
        self.assertTrue(out.endswith("\n"))
        renderer.event(run_event_from_api(EVENTS[0]))  # type: ignore[arg-type]
        self.assertTrue(buf.getvalue().endswith("\n"), "nothing is drawn after close")

    def test_autoscaling_and_long_waits(self) -> None:
        clock = [epoch(EVENTS[2]["timestamp"]) + 3700]
        renderer = _progress.TerminalProgress(io.StringIO(), width=40, now=lambda: clock[0])
        waiting = {**EVENTS[2], "message": None}
        renderer.event(run_event_from_api({**waiting, "autoscaling": True}))  # type: ignore[arg-type]
        self.assertEqual(renderer.line(), "Starting a worker (autoscaling) — 1h 01m")
        renderer.event(run_event_from_api({**waiting, "workers_online": 1}))  # type: ignore[arg-type]
        self.assertEqual(renderer.line(), "Waiting for a worker (1 online, all busy) — 1h 01m")
        renderer.event(run_event_from_api({**EVENTS[0], "workers_online": None, "message": None}))  # type: ignore[arg-type]
        self.assertEqual(renderer.headline(), "Queued — 1h 02m")
        renderer.event(run_event_from_api({**EVENTS[0], "phase": "stopping", "message": "Cancelled: waiting"}))  # type: ignore[arg-type]
        self.assertEqual(renderer.headline(), "Cancelled: waiting for the worker to stop — 1h 02m")
        drawn = renderer.stream.getvalue().split("\r\x1b[K")[1:]  # type: ignore[attr-defined]
        self.assertEqual(max(len(d) for d in drawn), 40, "lines are cut to the terminal width")

    def test_a_warning_runs_create_issued_is_not_noted_again(self) -> None:
        renderer = _progress.TerminalProgress(io.StringIO(), width=100, now=lambda: 0.0)
        warning = next(e for e in EVENTS if e["type"] == "warning")
        renderer.shown.add(warning["message"])
        renderer.event(run_event_from_api(warning))  # type: ignore[arg-type]
        self.assertEqual(renderer.notes, [])
        renderer.event(run_event_from_api({**warning, "message": "something new"}))  # type: ignore[arg-type]
        self.assertEqual(renderer.notes, ["⚠ something new"])

    def test_notebook_display_updates_in_place_with_a_sparkline(self) -> None:
        shown: list[Any] = []

        class Handle:
            def update(self, obj: Any) -> None:
                shown.append(obj)

        def display(obj: Any, display_id: bool = False) -> Handle:
            self.assertTrue(display_id)
            shown.append(obj)
            return Handle()

        mono = [0.0]
        clock = [0.0]
        renderer = _progress.NotebookProgress(display, now=lambda: clock[0], clock=lambda: mono[0])
        for raw in EVENTS:
            mono[0] += 1.0
            clock[0] = epoch(raw["timestamp"])
            renderer.event(run_event_from_api(raw))  # type: ignore[arg-type]
        renderer.close()
        last = shown[-1]._repr_html_()
        self.assertIn("✓ Completed", last)
        self.assertIn("<polyline", last)
        self.assertIn("⚠ Only 4 held-out records", last)
        self.assertEqual(repr(shown[0]), "<grad run progress>")
        before = len(shown)
        mono[0] += 0.1
        renderer.status = None
        renderer.event(run_event_from_api(EVENTS[5]))  # type: ignore[arg-type]
        self.assertEqual(len(shown), before, "updates are throttled")

    def test_create_picks_the_renderer(self) -> None:
        self.assertIsNone(_progress.create(False))
        self.assertIsNone(_progress.create(None, stream=io.StringIO(), env={}))
        self.assertIsInstance(_progress.create(None, stream=TTY(), env={}), _progress.TerminalProgress)
        for env in ({"CI": "true"}, {"TERM": "dumb"}, {"GRAD_NO_PROGRESS": "1"}):
            self.assertIsNone(_progress.create(None, stream=TTY(), env=env))
        self.assertIsInstance(_progress.create(True, stream=io.StringIO(), env={"CI": "1"}), _progress.TerminalProgress)

        class Closed(io.StringIO):
            def isatty(self) -> bool:
                raise ValueError("closed")

        self.assertIsNone(_progress.create(None, stream=Closed(), env={}))

    def test_create_uses_the_notebook_in_a_jupyter_kernel(self) -> None:
        shell = types.SimpleNamespace(config={"IPKernelApp": {}})
        ipython = types.ModuleType("IPython")
        ipython.get_ipython = lambda: shell  # type: ignore[attr-defined]
        display_mod = types.ModuleType("IPython.display")
        display_mod.display = lambda obj, display_id=False: None  # type: ignore[attr-defined]
        with mock.patch.dict(sys.modules, {"IPython": ipython, "IPython.display": display_mod}):
            self.assertIsInstance(_progress.create(None, env={}), _progress.NotebookProgress)
            shell.config = {}
            self.assertIsNone(_progress.create(None, stream=io.StringIO(), env={}))
            ipython.get_ipython = lambda: None  # type: ignore[attr-defined]
            self.assertIsNone(_progress.create(None, stream=io.StringIO(), env={}))

    def test_helpers(self) -> None:
        self.assertEqual([_progress.duration(s) for s in (-1, 42, 130, 3725)], ["0s", "42s", "2m 10s", "1h 02m"])
        self.assertEqual(_progress.sparkline([1.0]), "")
        svg = _progress.sparkline([3.0, float("nan"), 2.0, 2.0, 1.0])
        self.assertIn('points="0.0,2.0 40.0,12.0 80.0,12.0 120.0,22.0"', svg)
        self.assertIn('points="0.0,22.0 120.0,22.0"', _progress.sparkline([1.0, 1.0]), "a flat line sits at the bottom")


if __name__ == "__main__":
    unittest.main()
