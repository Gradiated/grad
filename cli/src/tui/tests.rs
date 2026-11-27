//! Render tests: each layout is drawn on a `TestBackend` from a recorded run
//! (tests/fixtures/tui/sft-reference-run.json) and compared with a text
//! snapshot in tests/snapshots/tui/. `GRAD_UPDATE_SNAPSHOTS=1` rewrites them.

use super::*;
use ratatui::backend::TestBackend;
use ratatui::buffer::Buffer;
use serde_json::Value;
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

fn metrics(fx: &Value) -> Vec<MetricPoint> {
    serde_json::from_value(fx["metrics"].clone()).unwrap()
}

fn checkpoints_upto(fx: &Value, step: i64) -> Vec<Checkpoint> {
    let all: Vec<Checkpoint> = serde_json::from_value(fx["checkpoints"].clone()).unwrap();
    all.into_iter().filter(|c| c.step <= step).collect()
}

fn epoch(ts: &str) -> i64 {
    parse_ts(ts).unwrap()
}

/// Replay the recording up to `step` the way the driver would.
fn replay(fx: &Value, step: i64) -> Model {
    let queued = run_from(&fx["queued"]);
    let mut m = Model::new(queued.clone(), epoch(&queued.created_at));
    let mut running = queued;
    running.status = RunStatus::Running;
    m.apply_run(running);
    for p in metrics(fx).into_iter().filter(|p| p.step <= step) {
        m.tick(epoch(&p.timestamp));
        let eval = p.eval_metrics.is_some();
        let at = p.step;
        m.apply_metric(p);
        if eval {
            m.apply_checkpoints(checkpoints_upto(fx, at));
        }
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

#[test]
fn waiting_for_a_gpu() {
    let fx = fixture();
    let queued = run_from(&fx["queued"]);
    let mut m = Model::new(queued.clone(), epoch(&queued.created_at));
    m.tick(epoch(&queued.created_at) + 130);
    let b = render(&m, 100, 30);
    snapshot("waiting", &b);
    let t = text(&b);
    assert!(t.contains("Waiting for a GPU  for 2m10s"), "{}", t);
    assert!(t.contains("The chart starts with the first training step."));
}

#[test]
fn wide_layout_mid_run() {
    let m = replay(&fixture(), 640);
    let b = render(&m, 100, 30);
    snapshot("wide", &b);
    let t = text(&b);
    let doc = include_str!("../../../docs/CLI_TUI.md");
    assert!(
        doc.contains(&t) || std::env::var("GRAD_UPDATE_SNAPSHOTS").is_ok(),
        "docs/CLI_TUI.md shows an outdated capture; paste tests/snapshots/tui/wide.txt"
    );
    assert!(t.contains("support-sft"));
    assert!(t.contains("sft  ·  test/tiny-qwen3  ·  support-prod@1"));
    assert!(t.contains("Training"));
    assert!(t.contains("640 / 1,062"));
    assert!(t.contains("ETA"));
    assert!(t.contains("$0.05"), "the cost cap is shown");
    assert!(t.contains("best"));
    assert!(t.contains("Eval at step 640 · loss"));
    assert!(
        t.contains("640  0.6195   ● best"),
        "best so far, by metric_mode=min"
    );
}

#[test]
fn narrow_layout_degrades_to_compact() {
    let m = replay(&fixture(), 640);
    let b = render(&m, 60, 18);
    snapshot("narrow", &b);
    let t = text(&b);
    assert!(!t.contains("╭"), "no panels in the compact layout:\n{}", t);
    assert!(t.contains("q detach"));
}

#[test]
fn interrupted_and_resumed() {
    let fx = fixture();
    let mut m = replay(&fx, 652);
    let base = m.now;
    m.link(Some("connection dropped".into()));
    let mut r = m.run.clone();
    r.attempt = 2;
    r.status = RunStatus::Queued;
    m.tick(base + 5);
    m.apply_run(r.clone());
    m.link(None);
    assert_eq!(m.phase().0, "requeued");
    m.tick(base + 25);
    r.status = RunStatus::Running;
    m.apply_run(r);
    assert_eq!(m.phase().1, "Resuming from step 640");
    for mut p in metrics(&fx)
        .into_iter()
        .filter(|p| p.step > 640 && p.step <= 664)
    {
        p.attempt = 2;
        p.seq += 10_000;
        m.tick(base + 30);
        m.apply_metric(p);
    }
    let b = render(&m, 100, 30);
    snapshot("interrupted", &b);
    let t = text(&b);
    let max = m.run.max_attempts;
    assert!(t.contains(&format!("attempt 2/{}", max)));
    let line = format!(
        "Attempt 1 interrupted at step 652; attempt 2/{} resuming from step 640",
        max
    );
    assert!(m.log.iter().any(|l| l.text == line && l.tone == Tone::Warn));
    assert!(t.contains("Attempt 1 interrupted at step 652"));
    assert!(t.contains("Reconnected"));
    assert!(m
        .log
        .iter()
        .any(|l| l.text == "Connection lost (connection dropped); reconnecting"));
    assert!(
        m.samples.windows(2).all(|w| w[0].step < w[1].step),
        "replayed steps replace the interrupted attempt's"
    );
}

#[test]
fn finished_run() {
    let fx = fixture();
    let mut m = replay(&fx, i64::MAX);
    let fin = run_from(&fx["final"]);
    m.tick(epoch(fin.finished_at.as_deref().unwrap()));
    m.apply_run(fin);
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
    assert!(
        t.contains("not deployable"),
        "eval report warnings are logged"
    );
}

#[test]
fn logs_help_and_confirm_overlays() {
    let mut m = replay(&fixture(), 640);
    m.key(KeyCode::Char('l'), KeyModifiers::NONE);
    let t = text(&render(&m, 100, 30));
    assert!(t.contains("Events (l to close)"));
    assert!(t.contains("l chart"));
    assert!(
        t.matches("Eval at step").count() > 10,
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
    done.apply_run(run_from(&fx["final"]));
    assert_eq!(done.key(KeyCode::Char('c'), none), Action::None);
    assert!(!done.confirm, "a finished run can't be cancelled");
}

#[test]
fn tiny_terminals_do_not_panic() {
    let m = replay(&fixture(), 640);
    for (w, h) in [(1, 1), (20, 6), (30, 3), (79, 21), (80, 22), (200, 60)] {
        let b = render(&m, w, h);
        assert_palette(&b);
    }
    let empty = Model::new(run_from(&fixture()["queued"]), 0);
    render(&empty, 25, 8);
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

    // A queued run whose first metric arrives flips to running.
    let mut q = Model::new(run_from(&fx["queued"]), 0);
    assert_eq!(q.phase().1, "Waiting for a GPU");
    q.apply_metric(metrics(&fx).remove(0));
    assert_eq!(q.run.status, RunStatus::Running);
    assert_eq!(q.phase().1, "Training");

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
    assert_eq!(big.samples.iter().filter(|s| s.eval.is_some()).count(), 4);
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
    for (status, label) in [
        (RunStatus::Failed, "Failed"),
        (RunStatus::Cancelled, "Cancelled"),
        (RunStatus::StoppedBudget, "Stopped at the cost cap"),
        (RunStatus::Other("paused".into()), "paused"),
    ] {
        let mut m = replay(&fx, 300);
        let mut r = m.run.clone();
        r.status = status;
        r.error = Some("CUDA out of memory".into());
        m.apply_run(r);
        assert_eq!(m.phase().1, label);
        let t = text(&render(&m, 100, 30));
        assert!(t.contains(label), "{}", t);
    }
    let mut m = replay(&fx, 300);
    let mut r = m.run.clone();
    r.status = RunStatus::Failed;
    r.error = Some("CUDA out of memory".into());
    m.apply_run(r);
    assert!(text(&render(&m, 100, 30)).contains("Run failed: CUDA out of memory"));

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

    // A restart with no checkpoint says so.
    let mut m = Model::new(run_from(&fx["queued"]), 0);
    let mut r = m.run.clone();
    (r.attempt, r.status) = (2, RunStatus::Running);
    m.apply_run(r);
    assert_eq!(m.phase().1, "Restarting from step 0");
    assert!(m
        .log
        .iter()
        .any(|l| l.text.contains("restarting from step 0")));
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
    assert_eq!(series([1.0, 2.0, 3.0].into_iter(), 3), vec![1, 51, 100]);
    assert_eq!(
        series((0..10).map(f64::from), 4).len(),
        4,
        "exactly width buckets"
    );
    assert_eq!(wrap("aa bb cc", 5), vec!["aa bb", "cc"]);
    assert_eq!(wrap("abcdefgh", 3), vec!["abc", "def", "gh"]);
    assert_eq!(wrap("", 3), vec![""]);
    assert_eq!(series([1.0, 1.0].into_iter(), 4), vec![1, 1]);
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
            Msg::Metric(p) => format!("metric {}", p.seq),
            Msg::Finished(r) => format!("finished {}", r.status),
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
    let metric = format!("event: metric\nid: 1\ndata: {}\n\n", fx["metrics"][0]);
    let status = format!("event: status\ndata: {}\n\n", fx["final"]);
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
            "up",
            "metric 1",
            "down connection dropped",
            "finished completed"
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
    let page = serde_json::json!({ "data": fx["checkpoints"], "next_cursor": null });
    let (url, server) = serve(vec![
        (200, "application/json", fx["final"].to_string()),
        (200, "application/json", page.to_string()),
    ])
    .await;
    let (tx, mut rx) = unbounded_channel();
    let polling = Arc::new(AtomicBool::new(true));
    pump_poll(client(&url), "run_x".into(), tx, polling).await;
    let n = fx["checkpoints"].as_array().unwrap().len();
    let last_seq = fx["final"]["latest_metric"]["seq"].as_i64().unwrap();
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
