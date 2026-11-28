//! Render tests: each layout is drawn on a `TestBackend` from a recorded run
//! (tests/fixtures/tui/sft-reference-run.json) and compared with a text
//! snapshot in tests/snapshots/tui/. `GRAD_UPDATE_SNAPSHOTS=1` rewrites them.

use super::*;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use serde_json::{json, Value};
use std::path::PathBuf;

fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../tests/fixtures/tui/sft-reference-run.json"
    ))
    .unwrap()
}

fn run_from(v: &Value) -> Run {
    serde_json::from_value(v.clone()).unwrap()
}

fn events(fx: &Value) -> Vec<RunEvent> {
    serde_json::from_value(fx["events"].clone()).unwrap()
}

fn kind(e: &RunEvent) -> &'static str {
    match e {
        RunEvent::Phase { .. } => "phase",
        RunEvent::Metric { .. } => "metric",
        RunEvent::Checkpoint { .. } => "checkpoint",
        RunEvent::Attempt { .. } => "attempt",
        RunEvent::Warning { .. } => "warning",
        RunEvent::Log { .. } => "log",
        RunEvent::Completed { .. } => "completed",
        RunEvent::Unknown => "unknown",
    }
}

fn metrics(fx: &Value) -> Vec<MetricPoint> {
    events(fx)
        .into_iter()
        .filter_map(|e| match e {
            RunEvent::Metric { metric, .. } => Some(metric),
            _ => None,
        })
        .collect()
}

fn final_run(fx: &Value) -> Run {
    events(fx)
        .into_iter()
        .find_map(|e| match e {
            RunEvent::Completed { run, .. } => Some(*run),
            _ => None,
        })
        .unwrap()
}

fn checkpoints_upto(fx: &Value, step: i64) -> Vec<Checkpoint> {
    let all: Vec<Checkpoint> = serde_json::from_value(fx["checkpoints"].clone()).unwrap();
    all.into_iter().filter(|c| c.step <= step).collect()
}

fn epoch(ts: &str) -> i64 {
    parse_ts(ts).unwrap()
}

/// Feed one event the way the driver does (a checkpoint event refetches the list).
fn feed(m: &mut Model, fx: &Value, ev: RunEvent) {
    if let Some(at) = ev.meta().map(|e| epoch(&e.timestamp)) {
        m.tick(at);
    }
    let step = match &ev {
        RunEvent::Checkpoint { step, .. } => *step,
        _ => 0,
    };
    m.apply_event(ev);
    if m.checkpoints_stale {
        m.checkpoints_stale = false;
        if step > 0 {
            m.apply_checkpoints(checkpoints_upto(fx, step));
        }
    }
}

/// An event shaped like the recording's, from JSON fields.
fn event(fx: &Value, at_secs: i64, attempt: i64, body: Value) -> RunEvent {
    let created = epoch(fx["queued"]["created_at"].as_str().unwrap());
    let mut v = body;
    v["run_id"] = fx["queued"]["id"].clone();
    v["attempt"] = attempt.into();
    v["timestamp"] = fmt_ts(created + at_secs).into();
    serde_json::from_value(v).unwrap()
}

fn fmt_ts(epoch: i64) -> String {
    // Days-from-civil inverse, enough for test timestamps.
    let (days, secs) = (epoch.div_euclid(86_400), epoch.rem_euclid(86_400));
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mo = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(mo <= 2);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.000Z",
        y,
        mo,
        d,
        secs / 3600,
        secs % 3600 / 60,
        secs % 60
    )
}

/// Replay the recorded events up to training step `step` (all of them,
/// `completed` included, for `i64::MAX`).
fn replay(fx: &Value, step: i64) -> Model {
    let queued = run_from(&fx["queued"]);
    let mut m = Model::new(queued.clone(), epoch(&queued.created_at));
    m.apply_run(queued);
    for ev in events(fx) {
        let past = match &ev {
            RunEvent::Metric { metric, .. } => metric.step > step,
            RunEvent::Checkpoint { step: s, .. } => *s > step,
            RunEvent::Completed { .. } | RunEvent::Warning { .. } => step != i64::MAX,
            _ => false,
        };
        if past {
            continue;
        }
        feed(&mut m, fx, ev);
    }
    m
}

fn render(m: &Model, w: u16, h: u16) -> Buffer {
    let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
    t.draw(|f| draw(f, m)).unwrap();
    t.backend().buffer().clone()
}

fn text(b: &Buffer) -> String {
    let w = b.area.width as usize;
    let cells: Vec<&str> = b.content.iter().map(|c| c.symbol()).collect();
    cells
        .chunks(w)
        .map(|row| row.concat().trim_end().to_string())
        .collect::<Vec<_>>()
        .join("\n")
        + "\n"
}

fn snapshot(name: &str, b: &Buffer) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/snapshots/tui")
        .join(format!("{}.txt", name));
    let got = text(b);
    if std::env::var("GRAD_UPDATE_SNAPSHOTS").as_deref() == Ok("1") {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &got).unwrap();
        return;
    }
    let want = std::fs::read_to_string(&path).unwrap_or_else(|_| {
        panic!(
            "missing snapshot {} (run with GRAD_UPDATE_SNAPSHOTS=1)\n{}",
            path.display(),
            got
        )
    });
    assert_eq!(got, want, "snapshot {} differs:\n{}", name, got);
    assert_palette(b);
}

/// docs/CLI_TUI.md shows the wide and narrow snapshots as its first two
/// `text` blocks; `GRAD_UPDATE_SNAPSHOTS=1` rewrites them.
fn doc_capture(block: usize, text: &str) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../docs/CLI_TUI.md");
    let doc = std::fs::read_to_string(&path).unwrap();
    let mut parts: Vec<String> = doc.split("```text\n").map(str::to_string).collect();
    let i = block + 1;
    let end = parts[i].find("```").unwrap();
    if std::env::var("GRAD_UPDATE_SNAPSHOTS").as_deref() == Ok("1") {
        parts[i] = format!("{}{}", text, &parts[i][end..]);
        std::fs::write(&path, parts.join("```text\n")).unwrap();
        return;
    }
    assert_eq!(
        &parts[i][..end],
        text,
        "docs/CLI_TUI.md capture {} is stale",
        block
    );
}

/// Light/dark safety: never paint a background, and use only named ANSI
/// colours the terminal theme maps.
fn assert_palette(b: &Buffer) {
    for c in &b.content {
        assert_eq!(c.bg, Color::Reset, "explicit background at {:?}", c);
        assert!(
            matches!(
                c.fg,
                Color::Reset
                    | Color::Cyan
                    | Color::Magenta
                    | Color::Green
                    | Color::Yellow
                    | Color::Red
            ),
            "off-palette colour {:?}",
            c.fg
        );
    }
}

/// The run as a server without lifecycle phases reports it.
fn no_phase(r: &Run) -> Run {
    Run {
        phase: None,
        phase_since: None,
        workers_online: None,
        autoscaling: None,
        ..r.clone()
    }
}

fn label(m: &Model) -> String {
    m.phase().label
}

fn log_texts(m: &Model) -> Vec<String> {
    m.log.iter().map(|l| l.text.clone()).collect()
}

#[test]
fn recorded_events_decode() {
    let evs = events(&fixture());
    let kinds: HashSet<&str> = evs.iter().map(kind).collect();
    for k in [
        "phase",
        "metric",
        "checkpoint",
        "attempt",
        "warning",
        "completed",
    ] {
        assert!(kinds.contains(k), "the recording has a {} event", k);
    }
    let unknown: RunEvent =
        serde_json::from_value(json!({"type": "future_thing", "seq": 1})).unwrap();
    assert_eq!(
        unknown,
        RunEvent::Unknown,
        "unknown event types are ignored"
    );
    let mut m = replay(&fixture(), 40);
    let n = m.log.len();
    m.apply_event(unknown);
    assert_eq!(m.log.len(), n);
}

#[test]
fn queue_position_and_reasons() {
    let fx = fixture();
    let queued = run_from(&fx["queued"]);
    let mut m = Model::new(queued.clone(), epoch(&queued.created_at));
    m.apply_run(queued.clone());
    let ev = json!({"type": "phase", "seq": 1, "phase": "queued", "step": 0,
        "workers_online": 0, "autoscaling": false, "queue_position": 3,
        "message": "Queued behind 3 runs", "gpu": null});
    feed(&mut m, &fx, event(&fx, 0, 1, ev));
    assert_eq!(label(&m), "Queued behind 3 runs");
    // The polled run is live: its reason replaces the event's.
    let mut capped = queued.clone();
    capped.queue_position = Some(0);
    capped.queue_message = Some("Queued: workspace concurrency limit (8 running)".into());
    m.apply_run(capped.clone());
    assert_eq!(label(&m), "Queued: workspace concurrency limit (8 running)");
    // Next in line: who is online again.
    capped.queue_message = None;
    m.apply_run(capped);
    assert_eq!(label(&m), "Queued");
}

#[test]
fn waiting_for_a_gpu() {
    let fx = fixture();
    let queued = run_from(&fx["queued"]);
    let mut m = Model::new(queued.clone(), epoch(&queued.created_at));
    m.apply_run(queued.clone());
    assert_eq!(
        label(&m),
        "Queued",
        "the run's own phase and queue details, before any event"
    );
    let mut bare = Model::new(no_phase(&queued), 0);
    bare.apply_run(no_phase(&queued));
    assert_eq!(label(&bare), "Queued", "servers without phases");
    feed(&mut m, &fx, events(&fx).remove(0));
    assert_eq!(label(&m), "Queued");
    // As the server reports it when no worker claims the run within 45 s.
    let waiting = json!({"type": "phase", "seq": 2, "phase": "waiting_for_compute",
        "step": 0, "workers_online": 0, "autoscaling": false, "gpu": null});
    feed(&mut m, &fx, event(&fx, 45, 1, waiting));
    m.tick(epoch(&queued.created_at) + 130);
    let b = render(&m, 100, 30);
    snapshot("waiting", &b);
    let t = text(&b);
    assert!(
        t.contains("Waiting for a worker (none online)  for 2m10s"),
        "one clock across queued and waiting_for_compute:\n{}",
        t
    );
    // The empty chart says why there's no step yet, never just "soon".
    assert!(t.contains("Waiting for a worker (none online)…"), "{}", t);
    assert_eq!(
        log_texts(&m),
        ["Run created", "Waiting for a worker (none online)"],
        "logged once, not per poll"
    );

    // Two busy workers, then scale-from-zero.
    let busy = json!({"type": "phase", "seq": 3, "phase": "waiting_for_compute",
        "step": 0, "workers_online": 2, "autoscaling": false, "gpu": null});
    feed(&mut m, &fx, event(&fx, 140, 1, busy));
    assert_eq!(label(&m), "Waiting for a worker (2 online, all busy)");
    let scaling = json!({"type": "phase", "seq": 4, "phase": "waiting_for_compute",
        "step": 0, "workers_online": 0, "autoscaling": true, "gpu": null});
    feed(&mut m, &fx, event(&fx, 150, 1, scaling));
    assert_eq!(label(&m), "Waiting for a worker (one is starting)");
    assert_eq!(m.log.len(), 2);
}

#[test]
fn phases_from_the_server() {
    let fx = fixture();
    let queued = run_from(&fx["queued"]);
    let mut m = Model::new(queued.clone(), epoch(&queued.created_at));
    feed(&mut m, &fx, events(&fx).remove(0));
    let gpu = json!({"name": "NVIDIA H100 80GB HBM3", "memory_gb": 79.6});
    let steps = [
        (
            json!({"type": "phase", "seq": 5, "phase": "starting", "step": 0, "gpu": gpu}),
            "Starting on NVIDIA H100 80GB HBM3 (80 GB)",
        ),
        (
            json!({"type": "phase", "seq": 6, "phase": "loading_model", "step": 0}),
            "Loading the model",
        ),
        (
            json!({"type": "phase", "seq": 7, "phase": "training", "step": 0}),
            "Training",
        ),
        (
            json!({"type": "phase", "seq": 8, "phase": "evaluating", "step": 20}),
            "Evaluating",
        ),
        (
            json!({"type": "phase", "seq": 9, "phase": "checkpointing", "step": 20}),
            "Saving a checkpoint",
        ),
        (
            json!({"type": "phase", "seq": 10, "phase": "training", "step": 20}),
            "Training",
        ),
        (
            json!({"type": "phase", "seq": 11, "phase": "uploading", "step": 40}),
            "Uploading the artifact",
        ),
        (
            json!({"type": "phase", "seq": 12, "phase": "completing", "step": 40}),
            "Finishing up",
        ),
        (
            json!({"type": "phase", "seq": 13, "phase": "new_phase", "step": 40}),
            "Working",
        ),
    ];
    for (i, (body, want)) in steps.into_iter().enumerate() {
        feed(&mut m, &fx, event(&fx, 10 + i as i64, 1, body));
        assert_eq!(label(&m), want);
    }
    let training = m.log.iter().filter(|l| l.text == "Training").count();
    assert_eq!(training, 1, "training is logged once per attempt");
    assert!(log_texts(&m).contains(&"Starting on NVIDIA H100 80GB HBM3 (80 GB)".to_string()));
    assert!(
        !log_texts(&m).iter().any(|l| l == "Evaluating"),
        "eval cycles stay out of the log"
    );
    assert_eq!(
        starting_label(Some(&Gpu {
            name: "L4".into(),
            memory_gb: 0.0
        })),
        "Starting on L4"
    );
}

#[test]
fn wide_layout_mid_run() {
    let m = replay(&fixture(), 640);
    let b = render(&m, 100, 30);
    snapshot("wide", &b);
    let t = text(&b);
    doc_capture(0, &t);
    assert!(t.contains("support-sft"));
    assert!(t.contains("recipe sft   model test/tiny-qwen3   dataset support-prod@1"));
    assert!(t.contains("Training"));
    assert!(t.contains("640 / 1,062"));
    assert!(t.contains("ETA"));
    assert!(t.contains("$0.05"), "the cost cap is shown");
    assert!(t.contains("best 0.6195 @ 640"));
    assert!(
        t.contains("eval loss"),
        "the checkpoints' metric names the column"
    );
    assert!(
        t.contains("640  0.6195   ● best"),
        "best so far, by metric_mode=min"
    );
    assert!(t.contains("lr "), "the lr sparkline");
    assert!(
        !t.contains("Eval at step"),
        "plain eval losses stay in the chart"
    );
    assert!(!t.contains("│0.") && !t.contains("└─"), "no axis lines");
    // The classic 80x24 terminal keeps the full layout.
    let b = render(&m, 80, 24);
    snapshot("standard", &b);
    assert!(text(&b).contains("╭ Checkpoints"));
}

#[test]
fn narrow_layout_degrades_to_compact() {
    let m = replay(&fixture(), 640);
    let b = render(&m, 60, 18);
    snapshot("narrow", &b);
    let t = text(&b);
    doc_capture(1, &t);
    assert!(!t.contains("╭"), "no panels in the compact layout:\n{}", t);
    assert!(t.contains("q detach"));
    assert!(t.contains("best 0.6195 @ 640"));
}

/// A reclaimed GPU as the worker and server report it.
fn reclaim(fx: &Value, m: &mut Model) {
    let t0 = m.now - m.started;
    let gpu = json!({"name": "NVIDIA H100 80GB HBM3", "memory_gb": 79.6});
    for (dt, attempt, body) in [
        (
            0,
            1,
            json!({"type": "log", "seq": 900, "step": 652,
            "message": "SIGTERM: saving an emergency checkpoint at step 652"}),
        ),
        (
            1,
            1,
            json!({"type": "attempt", "seq": 901, "event": "interrupted",
            "reason": "compute_reclaimed", "step": 652, "resume_step": 652, "max_attempts": 10,
            "message": "attempt 1 interrupted at step 652: the GPU was reclaimed; resuming from step 652 on a new worker"}),
        ),
        (
            1,
            2,
            json!({"type": "phase", "seq": 902, "phase": "queued", "step": 652,
            "workers_online": 0, "autoscaling": false}),
        ),
        (
            20,
            2,
            json!({"type": "attempt", "seq": 903, "event": "started",
            "resume_step": 652, "max_attempts": 10,
            "message": "attempt 2 started, resuming from step 652"}),
        ),
        (
            20,
            2,
            json!({"type": "phase", "seq": 904, "phase": "starting", "step": 652, "gpu": gpu}),
        ),
    ] {
        feed(m, fx, event(fx, t0 + dt, attempt, body));
    }
}

#[test]
fn interrupted_and_resumed() {
    let fx = fixture();
    let mut m = replay(&fx, 652);
    m.link(Some("connection dropped".into()));
    reclaim(&fx, &mut m);
    let t0 = m.now;
    m.link(None);
    m.tick(t0 + 3);
    let v = m.phase();
    assert_eq!(v.label, "Starting on NVIDIA H100 80GB HBM3 (80 GB)");
    assert_eq!(v.note.as_deref(), Some("resuming from step 652"));
    assert_eq!(v.tone, Tone::Warn);
    let b = render(&m, 100, 30);
    snapshot("interrupted", &b);
    let t = text(&b);
    assert!(t.contains("attempt 2/10"));
    assert!(
        t.contains("Attempt 1 interrupted at step 652: the GPU was"),
        "{}",
        t
    );
    assert!(t.contains("Attempt 2 started, resuming from step 652"));
    assert!(t.contains("Reconnected"));
    assert!(log_texts(&m).contains(&"Connection lost (connection dropped); reconnecting".into()));

    // The poller's run object then shows attempt 2: no second line.
    let n = m.log.len();
    let mut r = m.run.clone();
    r.attempt = 2;
    m.apply_run(r);
    assert_eq!(m.log.len(), n);

    // Training resumes: replayed steps replace the interrupted attempt's.
    for mut p in metrics(&fx)
        .into_iter()
        .filter(|p| p.step > 640 && p.step <= 700)
    {
        p.attempt = 2;
        p.seq += 10_000;
        m.apply_metric(p);
    }
    assert_eq!(
        m.phase(),
        PhaseView {
            key: "training",
            label: "Training".into(),
            note: None,
            tone: Tone::Plain
        }
    );
    assert!(m.samples.windows(2).all(|w| w[0].step < w[1].step));
    assert_eq!(
        m.log.iter().filter(|l| l.text == "Training").count(),
        2,
        "once per attempt"
    );

    // An attempt that gives up is logged in red.
    let gave_up = json!({"type": "attempt", "seq": 990, "event": "gave_up",
        "reason": "lease_lost", "step": 700, "max_attempts": 10,
        "message": "attempt 2 ended: the worker was lost; no attempts left"});
    feed(&mut m, &fx, event(&fx, t0 + 60, 2, gave_up));
    assert_eq!(m.log.back().unwrap().tone, Tone::Bad);
}

#[test]
fn interruptions_are_worded_neutrally() {
    let fx = fixture();
    let mut m = replay(&fx, 652);
    reclaim(&fx, &mut m);
    let mut all = log_texts(&m).join("\n");
    for (w, h) in [(100, 30), (60, 18)] {
        all.push_str(&text(&render(&m, w, h)));
    }
    // A server without lifecycle events: only the attempt number changes.
    let mut old = replay(&fx, 652);
    old.life = None;
    old.apply_checkpoints(checkpoints_upto(&fx, 640));
    let mut r = old.run.clone();
    r.attempt = 2;
    old.apply_run(r);
    all.push_str(&log_texts(&old).join("\n"));
    all.push_str(&text(&render(&old, 100, 30)));
    let lower = all.to_lowercase();
    for word in ["spot", "preempt", "gpu-hour", "gpu hour"] {
        assert!(!lower.contains(word), "{:?} in:\n{}", word, all);
    }
    assert!(all.contains("Attempt 1 was interrupted at step 652; attempt 2 resumes from step 640"));
    assert_eq!(old.phase().note.as_deref(), Some("resuming from step 640"));
}

#[test]
fn finished_run() {
    let fx = fixture();
    let mut m = replay(&fx, i64::MAX);
    let fin = final_run(&fx);
    m.tick(epoch(fin.finished_at.as_deref().unwrap()));
    m.apply_checkpoints(checkpoints_upto(&fx, i64::MAX));
    let b = render(&m, 100, 30);
    snapshot("finished", &b);
    let t = text(&b);
    assert!(t.contains("✓ Completed"));
    assert!(t.contains("Run completed"));
    assert!(
        t.contains("● best"),
        "the server's best checkpoint is marked"
    );
    assert!(!t.contains("c cancel"), "no cancel key once the run ended");
    assert!(!t.contains("● live"), "no link state once the run ended");
    assert_eq!(
        m.log
            .iter()
            .filter(|l| l.text.contains("not deployable"))
            .count(),
        1,
        "the warning event and the eval report's copy are logged once"
    );
}

#[test]
fn logs_help_and_confirm_overlays() {
    let fx = fixture();
    let mut m = replay(&fx, 640);
    for i in 0..30 {
        let body = json!({"type": "log", "seq": 2000 + i, "step": 640, "message": format!("worker line {}", i)});
        feed(&mut m, &fx, event(&fx, 10, 1, body));
    }
    m.key(KeyCode::Char('l'), KeyModifiers::NONE);
    let t = text(&render(&m, 100, 30));
    assert!(t.contains("l chart"));
    assert!(
        t.matches("Worker line").count() > 15,
        "the full log uses the whole body:\n{}",
        t
    );

    m.key(KeyCode::Char('?'), KeyModifiers::NONE);
    let b = render(&m, 100, 30);
    assert_palette(&b);
    let t = text(&b);
    assert!(t.contains("detach; the run keeps going on the server"));
    assert!(t.contains(&format!("grad runs watch {}", m.run.id)));
    m.key(KeyCode::Esc, KeyModifiers::NONE);
    assert!(!m.help);

    m.key(KeyCode::Char('c'), KeyModifiers::NONE);
    let t = text(&render(&m, 100, 30));
    assert!(t.contains("Cancel support-sft?"), "{}", t);
    assert!(t.contains("y cancel the run"));
    let t = text(&render(&m, 40, 10));
    assert!(t.contains("Cancel"), "the modal shrinks to small terminals");
}

#[test]
fn keys() {
    let fx = fixture();
    let mut m = replay(&fx, 100);
    let none = KeyModifiers::NONE;
    assert_eq!(m.key(KeyCode::Char('q'), none), Action::Detach);
    assert_eq!(m.key(KeyCode::Esc, none), Action::Detach);
    assert_eq!(
        m.key(KeyCode::Char('c'), KeyModifiers::CONTROL),
        Action::Detach,
        "Ctrl-C detaches like q"
    );
    assert_eq!(m.key(KeyCode::Char('c'), none), Action::None);
    assert!(m.confirm);
    assert_eq!(m.key(KeyCode::Char('x'), none), Action::None);
    assert_eq!(m.key(KeyCode::Char('n'), none), Action::None);
    assert!(!m.confirm, "n keeps the run");
    m.key(KeyCode::Char('c'), none);
    assert_eq!(m.key(KeyCode::Char('y'), none), Action::Cancel);
    assert!(!m.confirm);
    m.key(KeyCode::Char('?'), none);
    assert_eq!(
        m.key(KeyCode::Char('q'), none),
        Action::None,
        "q closes help first"
    );
    assert!(!m.help);
    m.key(KeyCode::Char('h'), none);
    assert_eq!(m.key(KeyCode::Char('x'), none), Action::None);
    assert!(m.help, "other keys leave help open");
    m.key(KeyCode::Char('?'), none);
    assert_eq!(m.key(KeyCode::Char('z'), none), Action::None);

    let mut done = m;
    done.apply_run(final_run(&fx));
    assert_eq!(done.key(KeyCode::Char('c'), none), Action::None);
    assert!(!done.confirm, "a finished run can't be cancelled");
}

#[test]
fn tiny_terminals_do_not_panic() {
    let fx = fixture();
    let m = replay(&fx, 640);
    let mut fin = replay(&fx, i64::MAX);
    fin.apply_checkpoints(checkpoints_upto(&fx, i64::MAX));
    for (w, h) in [
        (1, 1),
        (20, 6),
        (30, 3),
        (79, 23),
        (80, 24),
        (80, 12),
        (200, 60),
    ] {
        assert_palette(&render(&m, w, h));
        assert_palette(&render(&fin, w, h));
    }
    let empty = Model::new(run_from(&fx["queued"]), 0);
    render(&empty, 25, 8);
    render(&empty, 100, 30);
}

#[test]
fn stream_bookkeeping() {
    let fx = fixture();
    let mut m = replay(&fx, 200);
    let n = m.samples.len();
    let log = m.log.len();
    let again = metrics(&fx).into_iter().find(|p| p.step == 200).unwrap();
    m.apply_metric(again);
    assert_eq!(
        (m.samples.len(), m.log.len()),
        (n, log),
        "duplicate seq ignored"
    );
    assert_eq!(m.run.current_step, 200);
    assert!(m.tok_per_sec.unwrap() > 0.0);
    assert!(m.eta().unwrap() >= 0);
    assert_eq!(m.best_eval().unwrap().0, 200, "loss falls on this run");

    // A server without phases: a queued run whose first metric arrives trains.
    let mut q = Model::new(no_phase(&run_from(&fx["queued"])), 0);
    assert_eq!(label(&q), "Queued");
    q.apply_run(Run {
        status: RunStatus::Running,
        ..no_phase(&run_from(&fx["queued"]))
    });
    assert_eq!(label(&q), "Starting");
    q.apply_event(RunEvent::metric(metrics(&fx).remove(0)));
    assert_eq!(q.run.status, RunStatus::Running);
    assert_eq!(label(&q), "Training");
    assert_eq!(log_texts(&q), ["Run created", "Starting", "Training"]);

    // An eval step or a checkpoint asks for the checkpoint list.
    let mut q = Model::new(run_from(&fx["queued"]), 0);
    let p = metrics(&fx)
        .into_iter()
        .find(|p| eval_loss(p).is_some())
        .unwrap();
    q.apply_metric(p);
    assert!(q.checkpoints_stale);

    // A reattached run that already ended logs its status.
    let ended = Model::new(final_run(&fx), 0);
    assert!(log_texts(&ended).contains(&"Run completed".into()));

    // The sample buffer stays bounded and keeps every eval point.
    let mut big = Model::new(run_from(&fx["queued"]), 0);
    let template = metrics(&fx).remove(0);
    for i in 1..=(MAX_SAMPLES as i64 + 10) {
        let mut p = template.clone();
        (p.seq, p.step) = (i, i);
        p.eval_loss = (i % 1000 == 0).then_some(0.5);
        big.apply_metric(p);
    }
    assert!(big.samples.len() <= MAX_SAMPLES);
    assert_eq!(
        big.samples.iter().filter(|s| s.eval.is_some()).count(),
        MAX_SAMPLES / 1000
    );
    for _ in 0..MAX_LOG + 5 {
        big.push_log(0, Tone::Plain, "x".into());
    }
    assert_eq!(big.log.len(), MAX_LOG);
}

#[test]
fn link_states() {
    let mut m = replay(&fixture(), 40);
    m.link(None);
    assert_eq!(m.link, Link::Live);
    m.link(Some("a".into()));
    m.link(Some("b".into()));
    assert_eq!(m.link, Link::Down("b".into()));
    assert!(text(&render(&m, 100, 30)).contains("reconnecting"));
    m.link(None);
    assert_eq!(m.link, Link::Live);
    m.polling();
    assert!(text(&render(&m, 100, 30)).contains("polling"));
    m.notice(true, "Cancel failed: nope".into());
    assert!(text(&render(&m, 100, 30)).contains("Cancel failed: nope"));
}

#[test]
fn terminal_statuses() {
    let fx = fixture();
    for (status, want) in [
        (RunStatus::Failed, "Failed"),
        (RunStatus::Cancelled, "Cancelled"),
        (RunStatus::StoppedBudget, "Stopped at the cost cap"),
        (RunStatus::StoppedBalance, "Stopped: out of balance"),
        (RunStatus::Other("paused".into()), "paused"),
    ] {
        let mut m = replay(&fx, 300);
        let mut r = m.run.clone();
        r.status = status;
        r.error = Some("CUDA out of memory".into());
        m.apply_run(r);
        assert_eq!(label(&m), want);
        let t = text(&render(&m, 100, 30));
        assert!(t.contains(want), "{}", t);
    }
    let mut m = replay(&fx, 300);
    let mut r = m.run.clone();
    r.status = RunStatus::Failed;
    r.error = Some("CUDA out of memory".into());
    m.apply_run(r);
    assert!(text(&render(&m, 100, 30)).contains("Run failed: CUDA out of memory"));

    // Cancelled while the worker still holds the run: the server says stopping.
    let mut m = replay(&fx, 300);
    let stopping = json!({"type": "phase", "seq": 900, "phase": "stopping", "step": 300});
    feed(&mut m, &fx, event(&fx, 400, 1, stopping));
    let mut r = m.run.clone();
    r.status = RunStatus::Cancelled;
    m.apply_run(r);
    assert_eq!(label(&m), "Cancelled: waiting for the worker to stop");

    // Without a cap the cost line says so; near the cap it turns yellow.
    let mut m = replay(&fx, 300);
    m.run.max_cost_usd = None;
    assert!(text(&render(&m, 100, 30)).contains("no cap"));
    m.run.max_cost_usd = Some(m.run.cost_usd);
    let b = render(&m, 100, 30);
    assert!(b
        .content
        .iter()
        .any(|c| c.fg == Color::Yellow && c.symbol() == "━"));

    // A restart with no checkpoint says so (servers without phases).
    let mut q = no_phase(&run_from(&fx["queued"]));
    q.attempt = 1;
    let mut m = Model::new(q, 0);
    let mut r = m.run.clone();
    (r.attempt, r.status) = (2, RunStatus::Running);
    m.apply_run(r);
    assert_eq!(
        m.phase().note.as_deref(),
        Some("starting again from step 0")
    );
    assert!(log_texts(&m)
        .iter()
        .any(|l| l.contains("attempt 2 starts from step 0")));

    // Reclaims don't count toward max_attempts, so the attempt can pass it.
    m.run.attempt = 12;
    assert!(text(&render(&m, 100, 30)).contains("attempt 12"));
}

#[test]
fn recipe_eval_lines() {
    let point = |pairs: &[(&str, f64)]| MetricPoint {
        step: 120,
        eval_metrics: Some(
            pairs
                .iter()
                .map(|(k, v)| (k.to_string(), Some(*v)))
                .chain([("skipped".to_string(), None)])
                .collect(),
        ),
        ..Default::default()
    };
    let router = point(&[
        ("eval_loss", 0.41),
        ("offload_rate", 0.62),
        ("cost_savings_pct", 0.41),
        ("quality_drop", 0.01),
    ]);
    assert_eq!(
        eval_line(&router),
        "Eval at step 120 · loss 0.41 · saving 41.0% · offload 62.0% · quality drop 0.01"
    );
    let decision = point(&[("accuracy", 0.9), ("ece", 0.031)]);
    assert_eq!(
        eval_line(&decision),
        "Eval at step 120 · accuracy 90.0% · ECE 0.031"
    );
    let embed = point(&[("recall_at_5", 0.8), ("mrr", 0.7)]);
    assert_eq!(
        eval_line(&embed),
        "Eval at step 120 · MRR 0.7 · recall@5 80.0%"
    );
    let other = point(&[
        ("preference_accuracy", 0.75),
        ("eval_kl", 0.2),
        ("reward_margin", 1.5),
    ]);
    assert_eq!(
        eval_line(&other),
        "Eval at step 120 · KL 0.2 · pref. accuracy 75.0% · reward margin 1.5"
    );
}

#[test]
fn helpers() {
    assert_eq!(
        ts_ms("2026-11-27T13:45:31.861245Z"),
        Some(epoch("2026-11-27T13:45:31Z") * 1000 + 861)
    );
    assert_eq!(
        ts_ms("2026-11-27T13:45:31.8Z"),
        Some(epoch("2026-11-27T13:45:31Z") * 1000 + 800)
    );
    assert_eq!(
        ts_ms("2026-11-27T13:45:31Z"),
        Some(epoch("2026-11-27T13:45:31Z") * 1000)
    );
    assert_eq!(ts_ms("nope"), None);
    assert_eq!(clock(65), "01:05");
    assert_eq!(clock(3725), "1:02:05");
    assert_eq!(clock(-3), "00:00");
    assert_eq!(series([1.0, 2.0, 3.0].into_iter(), 3), vec![8, 54, 100]);
    assert_eq!(
        series((0..10).map(f64::from), 4).len(),
        4,
        "exactly width buckets"
    );
    assert_eq!(wrap("aa bb cc", 5), vec!["aa bb", "cc"]);
    assert_eq!(wrap("abcdefgh", 3), vec!["abc", "def", "gh"]);
    assert_eq!(wrap("", 3), vec![""]);
    assert_eq!(series([1.0, 1.0].into_iter(), 4), vec![8, 8]);
    assert!(series(std::iter::empty(), 4).is_empty());
    assert_eq!(round3(0.123456), 0.123);
    assert_eq!(round3(1234.5), 1230.0);
    assert_eq!(round3(0.0), 0.0);
    assert!(!enabled(true, false), "--json never opens the TUI");
    assert!(!enabled(false, true), "--plain never opens the TUI");
}

/// A one-request-per-connection HTTP server answering `replies` in order;
/// resolves to the request heads it saw.
async fn serve(
    replies: Vec<(u16, &'static str, String)>,
) -> (String, tokio::task::JoinHandle<Vec<String>>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let task = tokio::spawn(async move {
        let mut heads = Vec::new();
        for (status, ctype, body) in replies {
            let (mut sock, _) = listener.accept().await.unwrap();
            let mut buf = vec![0u8; 8192];
            let n = sock.read(&mut buf).await.unwrap();
            heads.push(String::from_utf8_lossy(&buf[..n]).to_lowercase());
            let resp = format!(
                "HTTP/1.1 {} X\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                status,
                ctype,
                body.len(),
                body
            );
            sock.write_all(resp.as_bytes()).await.unwrap();
        }
        heads
    });
    (url, task)
}

fn client(url: &str) -> Client {
    Client::builder()
        .base_url(url)
        .api_key("grad_test")
        .max_retries(0)
        .build()
        .unwrap()
}

fn drain(rx: &mut tokio::sync::mpsc::UnboundedReceiver<Msg>) -> Vec<String> {
    let mut out = Vec::new();
    while let Ok(m) = rx.try_recv() {
        out.push(match m {
            Msg::Event(e) => match *e {
                RunEvent::Metric { metric, .. } => format!("metric {}", metric.seq),
                RunEvent::Completed { run, .. } => format!("finished {}", run.status),
                other => kind(&other).to_string(),
            },
            Msg::Run(r) => format!("run {}", r.status),
            Msg::Checkpoints(c) => format!("checkpoints {}", c.len()),
            Msg::Link(None) => "up".into(),
            Msg::Link(Some(e)) => format!("down {}", e),
            Msg::Polling => "polling".into(),
            Msg::Fatal(e) => format!("fatal {}", e.code()),
            Msg::Input(_) | Msg::Cancelled(_) => "other".into(),
        });
    }
    out
}

const SSE: &str = "text/event-stream";

#[tokio::test]
async fn stream_resumes_after_drops_with_last_event_id() {
    let fx = fixture();
    // The events stream: each SSE carries a RunEvent; `completed` the final Run.
    let raw = fx["events"].as_array().unwrap();
    let first = raw.iter().find(|e| e["type"] == "metric").unwrap();
    let done = raw.iter().find(|e| e["type"] == "completed").unwrap();
    let metric = format!("event: metric\nid: 1\ndata: {}\n\n", first);
    let status = format!("event: completed\ndata: {}\n\n", done);
    // 1: one metric, then the body ends; 2: ends at once (the SDK gives up and
    // the pump reconnects itself); 3: the final status.
    let (url, server) = serve(vec![
        (200, SSE, metric),
        (200, SSE, String::new()),
        (200, SSE, status),
    ])
    .await;
    let (tx, mut rx) = unbounded_channel();
    pump_stream(
        client(&url),
        "run_x".into(),
        tx,
        Arc::new(AtomicBool::new(false)),
    )
    .await;
    assert_eq!(
        drain(&mut rx),
        [
            "up".to_string(),
            format!("metric {}", metrics(&fx)[0].seq),
            "down connection dropped".into(),
            "up".into(),
            "finished completed".into(),
        ]
    );
    let heads = server.await.unwrap();
    assert!(!heads[0].contains("last-event-id"));
    assert!(heads[1].contains("last-event-id: 1"), "{}", heads[1]);
    assert!(heads[2].contains("last-event-id: 1"), "{}", heads[2]);
}

#[tokio::test]
async fn stream_falls_back_to_polling_or_stops_on_fatal_errors() {
    let (url, _s) = serve(vec![(200, "application/json", "{}".into())]).await;
    let (tx, mut rx) = unbounded_channel();
    let polling = Arc::new(AtomicBool::new(false));
    pump_stream(client(&url), "run_x".into(), tx, polling.clone()).await;
    assert_eq!(drain(&mut rx), ["polling"], "a buffering proxy");
    assert!(polling.load(Ordering::SeqCst));

    let problem = r#"{"type":"about:blank","title":"Not Found","status":404,"code":"run_not_found","detail":"no run"}"#;
    let (url, _s) = serve(vec![(404, "application/problem+json", problem.into())]).await;
    let (tx, mut rx) = unbounded_channel();
    pump_stream(
        client(&url),
        "run_x".into(),
        tx,
        Arc::new(AtomicBool::new(false)),
    )
    .await;
    assert_eq!(drain(&mut rx), ["fatal run_not_found"]);
}

#[tokio::test]
async fn poller_reports_the_run_and_checkpoints_until_it_ends() {
    let fx = fixture();
    let page = json!({ "data": fx["checkpoints"], "next_cursor": null });
    let fin = serde_json::to_string(&final_run(&fx)).unwrap();
    let (url, server) = serve(vec![
        (200, "application/json", fin.clone()),
        (200, "application/json", page.to_string()),
    ])
    .await;
    let (tx, mut rx) = unbounded_channel();
    let polling = Arc::new(AtomicBool::new(true));
    pump_poll(client(&url), "run_x".into(), tx, polling).await;
    let n = fx["checkpoints"].as_array().unwrap().len();
    let last_seq = final_run(&fx).latest_metric.unwrap().seq;
    assert_eq!(
        drain(&mut rx),
        [
            format!("metric {}", last_seq),
            "run completed".to_string(),
            "up".to_string(),
            format!("checkpoints {}", n),
        ],
        "in polling mode the run's latest metric feeds the chart"
    );
    let heads = server.await.unwrap();
    assert!(heads[1].starts_with("get /v1/runs/run_x/checkpoints?limit=100"));

    let problem = r#"{"type":"about:blank","title":"Unauthorized","status":401,"code":"unauthorized","detail":"bad key"}"#;
    let (url, _s) = serve(vec![(401, "application/problem+json", problem.into())]).await;
    let (tx, mut rx) = unbounded_channel();
    pump_poll(
        client(&url),
        "run_x".into(),
        tx,
        Arc::new(AtomicBool::new(false)),
    )
    .await;
    assert_eq!(drain(&mut rx), ["fatal unauthorized"]);
}

/// A ~1,700-step run attached at step 845: the run as `grad runs watch` first
/// reads it, and its event history (replayed from the first event).
fn long_run(fx: &Value) -> (Run, Vec<RunEvent>) {
    let created = epoch(fx["queued"]["created_at"].as_str().unwrap());
    let mut run = run_from(&fx["queued"]);
    run.status = RunStatus::Running;
    (run.total_steps, run.current_step, run.attempt) = (1691, 845, 1);
    run.phase = serde_json::from_value(json!("training")).unwrap();
    run.phase_since = Some(fmt_ts(created + 60));
    let template = metrics(fx).remove(0);
    let point = |i: i64| {
        let mut p = template.clone();
        (p.seq, p.step, p.attempt) = (10 + i, i, 1);
        // Falls from 6.2 towards 5.86 with a little noise and one spike.
        let noise = ((i * 7919) % 13) as f64 / 13.0 * 0.01;
        p.loss =
            5.86 + 0.34 * (-(i as f64) / 150.0).exp() + noise + if i == 700 { 3.0 } else { 0.0 };
        p.tokens = i * 100;
        p.timestamp = fmt_ts(created + 60 + i);
        p
    };
    run.latest_metric = Some(point(845));
    let mut evs = vec![
        event(
            fx,
            0,
            1,
            json!({"type": "phase", "seq": 1, "phase": "queued", "step": 0, "workers_online": 0, "autoscaling": false, "gpu": null}),
        ),
        event(
            fx,
            20,
            1,
            json!({"type": "phase", "seq": 2, "phase": "starting", "step": 0, "gpu": {"name": "NVIDIA L4", "memory_gb": 22.5}}),
        ),
        event(
            fx,
            30,
            1,
            json!({"type": "phase", "seq": 3, "phase": "loading_model", "step": 0}),
        ),
        event(
            fx,
            60,
            1,
            json!({"type": "phase", "seq": 4, "phase": "training", "step": 0}),
        ),
    ];
    for i in 1..=845 {
        let p = point(i);
        evs.push(event(
            fx,
            60 + i,
            1,
            json!({"type": "metric", "seq": p.seq, "metric": p}),
        ));
        if i % 400 == 0 {
            evs.push(event(
                fx,
                60 + i,
                1,
                json!({"type": "phase", "seq": 10 + i, "phase": "evaluating", "step": i}),
            ));
            evs.push(event(
                fx,
                60 + i,
                1,
                json!({"type": "phase", "seq": 10 + i, "phase": "training", "step": i}),
            ));
        }
    }
    (run, evs)
}

#[test]
fn attaching_mid_run_backfills_the_whole_history() {
    // r8 trial: attached at 845/1691, the chart held only the points since
    // attaching (auto-scaled to 5.84-5.89) and said "Training for 5s".
    let fx = fixture();
    let (run, evs) = long_run(&fx);
    let created = epoch(&run.created_at);
    let now = created + 60 + 845 + 5;
    let mut m = Model::new(run.clone(), now);
    assert_eq!(label(&m), "Training");
    assert_eq!(
        m.phase_since,
        created + 60,
        "since the server's phase_since"
    );
    for ev in evs {
        m.apply_event(ev);
    }
    m.tick(now);
    assert_eq!(m.samples.len(), 845);
    assert_eq!(m.samples.first().map(|s| s.step), Some(1));
    let t = text(&render(&m, 100, 30));
    assert!(
        t.contains("Training  for 14m10s"),
        "phase clock from its start:\n{}",
        t
    );
    // The y axis spans the early, high losses; the one spike is clipped, not scaled to.
    assert!(t.contains(" 6.") && !t.contains(" 8.9"), "{}", t);
    assert!(t.contains("1,691"), "x runs to total_steps:\n{}", t);
    let b = render(&m, 100, 30);
    assert!(
        b.content
            .iter()
            .any(|c| c.fg == Color::Yellow && c.symbol() == "•"),
        "the clipped spike is marked"
    );
    snapshot("attached", &b);
}

#[test]
fn chart_downsamples_to_its_width_and_ignores_outliers() {
    let points: Vec<(i64, f64)> = (0..100_000)
        .map(|i| {
            (
                i,
                if i == 50_000 {
                    99.0
                } else {
                    1.0 + i as f64 * 1e-6
                },
            )
        })
        .collect();
    let cut = min_max_buckets(points.iter().copied(), 100_000.0, 160);
    assert!(
        cut.len() <= 320,
        "two points per column at most: {}",
        cut.len()
    );
    assert_eq!(cut.first().map(|p| p.0), Some(0.0), "starts at step 0");
    assert!(cut.iter().any(|p| p.1 == 99.0), "a spike survives the cut");
    assert!(cut.windows(2).all(|w| w[0].0 <= w[1].0), "in step order");
    let (lo, hi) = y_bounds(points.iter().map(|p| p.1));
    assert!(lo < 1.0 && hi < 2.0, "{} {}", lo, hi);
    let (lo, hi) = y_bounds([3.0, 1.0, 2.0].into_iter());
    assert!(lo < 1.0 && hi > 3.0, "few points: all of them");
    assert_eq!(y_bounds(std::iter::empty()), (0.0, 1.0));
}

#[test]
fn the_empty_chart_says_what_the_run_is_doing() {
    let fx = fixture();
    let queued = run_from(&fx["queued"]);
    let mut m = Model::new(queued.clone(), epoch(&queued.created_at));
    let busy = json!({"type": "phase", "seq": 2, "phase": "waiting_for_compute",
        "step": 0, "workers_online": 2, "autoscaling": false, "gpu": null});
    feed(&mut m, &fx, event(&fx, 45, 1, busy));
    assert_eq!(
        empty_chart_message(&m),
        "Waiting for a worker (2 online, all busy)…"
    );
    feed(
        &mut m,
        &fx,
        event(
            &fx,
            50,
            1,
            json!({"type": "phase", "seq": 3, "phase": "loading_model", "step": 0}),
        ),
    );
    assert_eq!(empty_chart_message(&m), "Loading the model…");
    let t = text(&render(&m, 100, 30));
    assert!(t.contains("Loading the model…"), "{}", t);
    feed(
        &mut m,
        &fx,
        event(
            &fx,
            60,
            1,
            json!({"type": "phase", "seq": 4, "phase": "training", "step": 0}),
        ),
    );
    assert_eq!(
        empty_chart_message(&m),
        "Training: waiting for the first step…"
    );
    let mut r = m.run.clone();
    r.status = RunStatus::Failed;
    m.apply_run(r);
    assert_eq!(
        empty_chart_message(&m),
        "Failed before the first training step"
    );
    for msg in [empty_chart_message(&m), text(&render(&m, 100, 30))] {
        assert!(!msg.to_lowercase().contains("spot"));
    }
}
