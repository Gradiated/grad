//! Run lifecycle events (GET /v1/runs/{id}/events) against the recorded fixtures.

mod support;

use grad_sdk::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use support::mock::{MockServer, Reply};

const SSE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/wire/run-events.sse"
));
const PAGE: &str = include_str!(concat!(
    env!("CARGO_MANIFEST_DIR"),
    "/../../tests/fixtures/wire/run-events-page.json"
));

fn page() -> Value {
    serde_json::from_str(PAGE).unwrap()
}

fn blocks() -> Vec<String> {
    SSE.trim()
        .split("\n\n")
        .map(|b| format!("{}\n\n", b))
        .collect()
}

fn client(url: &str) -> Client {
    Client::builder()
        .ignore_env(true)
        .ignore_config_file(true)
        .base_url(url)
        .api_key("grad_test_key")
        .retry_base_delay(Duration::from_millis(5))
        .build()
        .unwrap()
}

fn stream(body: String) -> Reply {
    Reply::Stream {
        status: 200,
        headers: vec![("content-type".into(), "text/event-stream".into())],
        chunks: vec![(Duration::ZERO, body.into_bytes())],
    }
}

#[tokio::test]
async fn follows_typed_events_and_reconnects_without_repeats() {
    let p = page();
    let id = p["run_id"].as_str().unwrap().to_string();
    let all = blocks();
    let conns = Arc::new(AtomicUsize::new(0));
    let last_ids = Arc::new(Mutex::new(vec![]));
    let (c2, l2, b2) = (conns.clone(), last_ids.clone(), all.clone());
    let srv = MockServer::start(move |r| {
        assert_eq!(r.header("accept"), Some("text/event-stream"));
        l2.lock()
            .unwrap()
            .push(r.header("last-event-id").unwrap_or("").to_string());
        match c2.fetch_add(1, Ordering::SeqCst) {
            0 => stream(b2[..8].concat()),
            1 => Reply::problem(503, "unavailable", "restarting"),
            // A proxy re-sends event 8 and a future event type before the rest.
            _ => stream(format!(
                "event: future\ndata: {{\"type\":\"future\"}}\n\n{}",
                b2[7..].concat()
            )),
        }
    });
    let c = client(&srv.url);
    let mut events = c
        .runs()
        .events(&id, true)
        .reconnect_base(Duration::from_millis(5));
    let mut got = vec![];
    while let Some(ev) = events.next().await {
        got.push(ev.unwrap());
    }
    let types: Vec<&str> = got.iter().map(|e| e.type_name()).collect();
    let want: Vec<&str> = p["data"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["type"].as_str().unwrap())
        .collect();
    assert_eq!(types, want);
    let seq8 = got[7].seq().to_string();
    assert_eq!(
        *last_ids.lock().unwrap(),
        vec!["".to_string(), seq8.clone(), seq8.clone()]
    );
    assert_eq!(
        events.last_event_id(),
        Some(got[got.len() - 2].seq().to_string().as_str())
    );

    let RunEvent::Phase(waiting) = &got[2] else {
        panic!("phase")
    };
    assert_eq!(waiting.phase, RunPhase::WaitingForCompute);
    assert_eq!(waiting.workers_online, Some(0));
    assert_eq!(waiting.meta.run_id, id);
    let RunEvent::Phase(starting) = &got[4] else {
        panic!("phase")
    };
    assert_eq!(starting.gpu.as_ref().unwrap().memory_gb, 79.6);
    let RunEvent::Attempt(interrupted) = &got[12] else {
        panic!("attempt")
    };
    assert_eq!(interrupted.event, AttemptKind::Interrupted);
    assert_eq!(
        interrupted.reason,
        Some(InterruptionReason::ComputeReclaimed)
    );
    assert_eq!(interrupted.resume_step, Some(2));
    let RunEvent::Completed(done) = got.last().unwrap() else {
        panic!("completed")
    };
    assert_eq!(done.run.status, RunStatus::Completed);

    // Applying the events to a snapshot tracks phase, status and interruptions.
    let mut run = Run::default();
    for ev in &got[..13] {
        ev.apply(&mut run);
    }
    assert_eq!(run.status, RunStatus::Running);
    assert_eq!(run.last_interruption.as_ref().unwrap().step, 2);
    got[13].apply(&mut run);
    assert_eq!(run.status, RunStatus::Queued);
    assert_eq!(run.phase, Some(RunPhase::Queued));
}

#[tokio::test]
async fn pages_events_without_follow_and_waits_with_events() {
    let p = page();
    let id = p["run_id"].as_str().unwrap().to_string();
    let data = p["data"].as_array().unwrap().clone();
    let half = data.len() / 2;
    let (d2, id2, all) = (data.clone(), id.clone(), blocks().concat());
    let srv = MockServer::start(move |r| {
        let events = format!("/v1/runs/{}/events", id2);
        match r.path() {
            path if path == events && r.header("accept") == Some("text/event-stream") => {
                stream(all.clone())
            }
            path if path == events && r.query().contains("cursor=c2") => Reply::json(
                200,
                json!({"run_id": id2, "status": "completed", "data": d2[half..], "next_cursor": null, "tail_cursor": "c3"}),
            ),
            path if path == events => Reply::json(
                200,
                json!({"run_id": id2, "status": "completed", "data": d2[..half], "next_cursor": "c2", "tail_cursor": "c2"}),
            ),
            "/v1/runs/run_loop/events" => Reply::json(
                200,
                json!({"run_id": "run_loop", "status": "running", "data": d2[..1], "next_cursor": "same", "tail_cursor": "same"}),
            ),
            _ => Reply::problem(404, "run_not_found", "no such run"),
        }
    });
    let c = client(&srv.url);
    let mut paged = c.runs().events(&id, false).limit(7);
    let mut n = 0;
    let mut last = None;
    while let Some(ev) = paged.next().await {
        n += 1;
        last = Some(ev.unwrap());
    }
    assert_eq!(n, data.len());
    assert!(matches!(last, Some(RunEvent::Completed(_))));
    assert!(srv.requests()[0].query().contains("limit=7"));

    // The same events as a futures Stream.
    let mut s = std::pin::pin!(c.runs().events(&id, false).limit(7).into_stream());
    let mut streamed = vec![];
    while let Some(ev) =
        std::future::poll_fn(|cx| futures_core::Stream::poll_next(s.as_mut(), cx)).await
    {
        streamed.push(ev.unwrap());
    }
    assert_eq!(streamed.len(), data.len());
    assert!(matches!(streamed.last(), Some(RunEvent::Completed(_))));
    assert!(
        std::future::poll_fn(|cx| futures_core::Stream::poll_next(s.as_mut(), cx))
            .await
            .is_none()
    );

    let mut looping = c.runs().events("run_loop", false);
    let mut err = None;
    while let Some(ev) = looping.next().await {
        if let Err(e) = ev {
            err = Some(e);
        }
    }
    assert!(
        matches!(err, Some(Error::PaginationLoop { .. })),
        "{:?}",
        err
    );

    let mut missing = c.runs().events("run_nope", true);
    assert!(matches!(
        missing.next().await,
        Some(Err(Error::NotFound(_)))
    ));
    assert!(missing.next().await.is_none());

    let seen = Mutex::new(vec![]);
    let run = c
        .runs()
        .wait_with_events(&id, &WaitOptions::default(), |ev| {
            seen.lock().unwrap().push(ev.type_name())
        })
        .await
        .unwrap();
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(seen.lock().unwrap().len(), data.len());
    let page = c.runs().events_page(&id, None, Some(5)).await.unwrap();
    assert_eq!(page.data.len(), half);
    assert_eq!(page.next_cursor.as_deref(), Some("c2"));
}

#[test]
fn unknown_event_types_decode_as_unknown() {
    let ev: RunEvent = serde_json::from_value(json!({"type": "future", "x": 1})).unwrap();
    assert_eq!(ev, RunEvent::Unknown);
    assert_eq!(ev.seq(), 0);
    assert!(ev.meta().is_none());
    let log: RunEvent = serde_json::from_value(
        json!({"type": "log", "run_id": "r", "seq": 3, "attempt": 1, "timestamp": "t", "step": null, "message": "hi"}),
    )
    .unwrap();
    assert_eq!(log.type_name(), "log");
    assert_eq!(serde_json::to_value(&log).unwrap()["type"], "log");
}
