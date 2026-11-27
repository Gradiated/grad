//! SDK façade tests against an in-process mock HTTP server.

mod support;

use grad_sdk::*;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use support::mock::{self, MockServer, Reply};

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

fn fast_wait() -> WaitOptions {
    WaitOptions {
        timeout: Some(Duration::from_secs(10)),
        interval: Duration::from_millis(5),
        max_interval: Duration::from_millis(20),
        max_transient_errors: 5,
    }
}

fn run_json(id: &str, status: &str) -> Value {
    json!({
        "id": id, "name": "support-sft", "status": status, "recipe_kind": "sft",
        "dataset_name": "ds", "dataset_version": 1, "current_step": 3, "total_steps": 10,
        "artifact_id": if status == "completed" { json!("art_1") } else { Value::Null },
        "error": if status == "failed" { json!("CUDA out of memory") } else { Value::Null },
        "resolved_config": {"model": "qwen/qwen3-8b", "split": {"train_records": 9, "eval_records": 1}},
        "brand_new_field": {"kept": true}
    })
}

#[tokio::test]
async fn typed_errors_carry_status_code_request_id_and_url() {
    let srv = MockServer::start(|r| match r.path() {
        "/v1/runs/missing" => Reply::problem(404, "run_not_found", "Run 'missing' not found."),
        "/v1/deployments" => Reply::problem(
            501,
            "deploy_unavailable",
            "Hosted serving is not configured; download the artifact and serve it on vLLM.",
        ),
        "/v1/evals" => Reply::problem(501, "inference_unavailable", "Set INFERENCE_BASE_URL."),
        "/v1/keys" => Reply::problem(403, "insufficient_scope", "Needs admin."),
        "/v1/runs/plan" => Reply::json(
            422,
            json!({"status": 422, "code": "validation_error", "title": "Validation failed",
                   "detail": "recipe.lr: Expected number", "request_id": "req_1",
                   "errors": [{"path": ["recipe", "lr"], "message": "Expected number"}]}),
        ),
        "/v1/runs/conflict/resume" => {
            Reply::problem(409, "run_not_resumable", "Raise max_cost_usd.")
        }
        "/v1/base-models" => Reply::bytes(
            500,
            vec![("x-request-id", "req_hdr".into())],
            b"upstream exploded".to_vec(),
        ),
        _ => Reply::problem(400, "bad", "bad"),
    });
    let c = client(&srv.url).with_max_retries(0);

    let e = c.runs().get("missing").await.unwrap_err();
    assert!(matches!(e, Error::NotFound(_)), "{:?}", e);
    assert_eq!(e.status(), 404);
    assert_eq!(e.code(), "run_not_found");
    assert_eq!(e.request_id(), Some("req_mock"));
    let msg = e.to_string();
    assert!(
        msg.contains(&format!("GET {}/v1/runs/missing", srv.url)),
        "{}",
        msg
    );
    assert!(msg.contains("Run 'missing' not found."), "{}", msg);

    let e = c
        .deployments()
        .create(
            &DeployArtifactRequest {
                artifact: "a@latest".into(),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(e, Error::DeployUnavailable(_)));
    assert!(e.to_string().contains("vLLM"));

    let e = c
        .evals()
        .create(&PlanEvalRequest::default(), None)
        .await
        .unwrap_err();
    assert!(matches!(e, Error::InferenceUnavailable(_)));

    let e = c.keys().create("k", &["admin".into()]).await.unwrap_err();
    assert!(matches!(e, Error::PermissionDenied(_)));

    let e = c
        .runs()
        .plan(&PlanRunRequest::new(
            "ds",
            "n",
            RecipeSpec::new(RecipeKind::Sft),
        ))
        .await
        .unwrap_err();
    assert!(matches!(e, Error::Validation(_)));
    assert!(e.api().unwrap().errors.is_some());
    assert!(e.to_string().contains("recipe.lr: Expected number"));

    let e = c.runs().resume("conflict", None).await.unwrap_err();
    assert!(matches!(e, Error::Conflict(_)));

    let e = c.models().list().await.unwrap_err();
    assert!(matches!(e, Error::Server(_)));
    assert_eq!(e.code(), "http_500");
    assert_eq!(e.request_id(), Some("req_hdr"));
    assert!(e.to_string().contains("upstream exploded"));
    assert!(e.is_transient());
}

#[tokio::test]
async fn unauthorized_without_a_key_explains_how_to_authenticate() {
    let srv =
        MockServer::start(|_| Reply::problem(401, "unauthorized", "Authentication required."));
    let c = Client::builder()
        .ignore_env(true)
        .ignore_config_file(true)
        .base_url(&srv.url)
        .build()
        .unwrap();
    assert!(!c.has_api_key());
    let e = c.models().list().await.unwrap_err();
    assert!(matches!(e, Error::Authentication(_)));
    let msg = e.to_string();
    assert!(
        msg.contains("GRADIATED_API_KEY") && msg.contains("grad login"),
        "{}",
        msg
    );
    assert!(srv.requests()[0].header("authorization").is_none());
}

#[tokio::test]
async fn no_key_for_a_remote_server_fails_before_sending() {
    let c = Client::builder()
        .ignore_env(true)
        .ignore_config_file(true)
        .base_url("https://grad.example.invalid/v1/")
        .build()
        .unwrap();
    assert_eq!(c.base_url(), "https://grad.example.invalid");
    let e = c.models().list().await.unwrap_err();
    assert!(matches!(e, Error::Config(_)), "{:?}", e);
    assert_eq!(
        e.to_string().trim_start_matches("configuration error: "),
        grad_sdk::config::missing_key_message("https://grad.example.invalid")
    );
    // An explicitly empty key talks to a server without authentication.
    let open = Client::builder()
        .ignore_env(true)
        .ignore_config_file(true)
        .base_url("https://grad.example.invalid")
        .api_key("")
        .max_retries(0)
        .build()
        .unwrap();
    assert!(!open.has_api_key());
    let e = open.models().list().await.unwrap_err();
    assert!(!matches!(e, Error::Config(_)), "{:?}", e);
}

#[tokio::test]
async fn connection_errors_name_the_url_and_the_cause() {
    let port = {
        let l = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        l.local_addr().unwrap().port()
    };
    let c = client(&format!("http://127.0.0.1:{}", port)).with_max_retries(0);
    let e = c.models().list().await.unwrap_err();
    assert!(matches!(e, Error::Connection { .. }), "{:?}", e);
    let msg = e.to_string();
    assert!(
        msg.contains(&format!("http://127.0.0.1:{}", port)),
        "{}",
        msg
    );
    assert!(msg.contains("/v1/base-models"), "{}", msg);
    assert!(msg.to_lowercase().contains("refused"), "{}", msg);
    assert!(msg.contains("grad local up"), "{}", msg);
    assert!(!msg.contains("network_error"));
    assert_eq!(e.status(), 0);
    assert_eq!(e.code(), "connection_error");
}

#[tokio::test]
async fn invalid_base_url_is_a_config_error() {
    let err = Client::builder()
        .ignore_env(true)
        .ignore_config_file(true)
        .base_url("localhost:8787")
        .build()
        .unwrap_err();
    assert!(matches!(err, Error::Config(_)));
    let c = Client::new().with_base_url("::nope");
    let e = c.models().list().await.unwrap_err();
    assert!(matches!(e, Error::Config(_)), "{:?}", e);
}

#[tokio::test]
async fn idempotent_and_keyed_requests_retry_with_backoff() {
    let hits = Arc::new(AtomicUsize::new(0));
    let h = hits.clone();
    let srv = MockServer::start(move |r| match (r.method.as_str(), r.path()) {
        ("GET", "/v1/base-models") => {
            if h.fetch_add(1, Ordering::SeqCst) < 2 {
                Reply::problem(503, "store_unavailable", "try again")
            } else {
                Reply::json(
                    200,
                    json!({"data": [{"id": "qwen/qwen3-8b", "family": "llm"}]}),
                )
            }
        }
        ("POST", "/v1/runs") => Reply::problem(503, "store_unavailable", "busy"),
        ("POST", "/v1/runs/plan") => Reply::problem(502, "bad_gateway", "nope"),
        ("GET", "/v1/datasets") => Reply::Drop,
        _ => Reply::problem(404, "nf", "nf"),
    });
    let c = client(&srv.url);
    let models = c.models().list().await.unwrap();
    assert_eq!(models[0].id, "qwen/qwen3-8b");
    assert_eq!(srv.count("GET", "/v1/base-models"), 3);

    let e = c
        .runs()
        .create(
            &PlanRunRequest::new("d", "n", RecipeSpec::new(RecipeKind::Sft)),
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(e, Error::Server(_)));
    assert_eq!(
        srv.count("POST", "/v1/runs"),
        3,
        "a keyed POST is retried on 503"
    );
    let keys: std::collections::HashSet<_> = srv
        .requests()
        .iter()
        .filter(|r| r.method == "POST" && r.path() == "/v1/runs")
        .map(|r| r.header("idempotency-key").unwrap_or("").to_string())
        .collect();
    assert_eq!(keys.len(), 1, "every retry reuses one Idempotency-Key");
    assert_eq!(keys.iter().next().unwrap().len(), 36);

    let e = c.datasets().list(&ListParams::default()).await.unwrap_err();
    assert!(
        matches!(e, Error::Connection { .. } | Error::Decode { .. }),
        "{:?}",
        e
    );
    assert_eq!(
        srv.count("GET", "/v1/datasets"),
        3,
        "dropped GETs are retried twice"
    );
}

#[tokio::test]
async fn posts_retry_on_429_and_honour_retry_after() {
    let hits = Arc::new(AtomicUsize::new(0));
    let h = hits.clone();
    let srv = MockServer::start(move |_| {
        if h.fetch_add(1, Ordering::SeqCst) == 0 {
            Reply::problem(429, "rate_limited", "slow down").with_header("retry-after", "0")
        } else {
            Reply::json(
                200,
                json!({"name": "support", "model_id": "ws/support", "active_artifact_id": "art_1"}),
            )
        }
    });
    let c = client(&srv.url);
    let d = c
        .deployments()
        .create(
            &DeployArtifactRequest {
                artifact: "support-sft@latest".into(),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(d.model_id, "ws/support");
    let sent: Vec<_> = srv
        .requests()
        .into_iter()
        .filter(|r| r.method == "POST" && r.path() == "/v1/deployments")
        .collect();
    assert_eq!(sent.len(), 2);
    let key = sent[0]
        .header("idempotency-key")
        .expect("POST sends an Idempotency-Key");
    assert_eq!(
        sent[1].header("idempotency-key"),
        Some(key),
        "retries reuse the key"
    );
    let body = sent[1].json();
    assert_eq!(body["artifact"], "support-sft@latest");
    assert!(body.get("name").is_none(), "unset fields are not sent");
}

#[tokio::test]
async fn retries_stop_after_max_retries() {
    let srv = MockServer::start(|_| Reply::problem(503, "down", "down"));
    let c = client(&srv.url).with_max_retries(1);
    let e = c.runs().get("r1").await.unwrap_err();
    assert!(matches!(e, Error::Server(_)));
    assert_eq!(srv.count("GET", "/v1/runs/r1"), 2);
}

#[tokio::test]
async fn request_timeout_is_typed() {
    let srv = MockServer::start(|_| Reply::Stream {
        status: 200,
        headers: vec![("content-type".into(), "application/json".into())],
        chunks: vec![(Duration::from_millis(1500), b"{}".to_vec())],
    });
    let c = client(&srv.url)
        .with_timeout(Duration::from_millis(200))
        .with_max_retries(0);
    let e = c.runs().get("slow").await.unwrap_err();
    assert!(matches!(e, Error::Timeout { .. }), "{:?}", e);
    assert!(e.to_string().contains("timed out"));
    assert!(e.is_transient());
}

#[tokio::test]
async fn redirects_same_origin_get_only() {
    let other = MockServer::start(|_| Reply::json(200, json!({"data": []})));
    let other_url = other.url.clone();
    let srv = MockServer::start(move |r| match r.path() {
        "/v1/base-models" => {
            Reply::bytes(302, vec![("location", "/v1/base-models2".into())], vec![])
        }
        "/v1/base-models2" => Reply::json(200, json!({"data": [{"id": "m"}]})),
        "/v1/datasets" => Reply::bytes(
            302,
            vec![("location", format!("{}/steal", other_url))],
            vec![],
        ),
        "/v1/runs" => Reply::bytes(307, vec![("location", "/v1/runs2".into())], vec![]),
        "/v1/loop" => Reply::bytes(302, vec![("location", "/v1/loop".into())], vec![]),
        _ => Reply::problem(404, "nf", "nf"),
    });
    let c = client(&srv.url);
    let models = c.models().list().await.unwrap();
    assert_eq!(models[0].id, "m");
    assert_eq!(
        srv.last("GET", "/v1/base-models2")
            .unwrap()
            .header("authorization"),
        Some("Bearer grad_test_key")
    );

    let e = c.datasets().list(&ListParams::default()).await.unwrap_err();
    assert!(matches!(e, Error::Redirect { .. }), "{:?}", e);
    assert!(e.to_string().contains("cross-origin"));
    assert!(
        other.requests().is_empty(),
        "the other origin never sees the request"
    );

    let e = c
        .runs()
        .create(
            &PlanRunRequest::new("d", "n", RecipeSpec::new(RecipeKind::Sft)),
            None,
        )
        .await
        .unwrap_err();
    assert!(matches!(e, Error::Redirect { .. }));
    assert_eq!(srv.count("POST", "/v1/runs2"), 0);
    assert_eq!(
        srv.count("GET", "/v1/runs2"),
        0,
        "POST is never turned into GET"
    );
}

#[tokio::test]
async fn wait_backs_off_tolerates_transient_errors_and_types_failures() {
    let n = Arc::new(AtomicUsize::new(0));
    let n2 = n.clone();
    let srv = MockServer::start(move |r| match r.path() {
        "/v1/runs/r_ok" => match n2.fetch_add(1, Ordering::SeqCst) {
            0 => Reply::json(200, run_json("r_ok", "queued")),
            1 => Reply::problem(503, "store_unavailable", "blip"),
            2 => Reply::Drop,
            3 => Reply::json(200, run_json("r_ok", "running")),
            _ => Reply::json(200, run_json("r_ok", "completed")),
        },
        "/v1/runs/r_fail" => Reply::json(200, run_json("r_fail", "failed")),
        "/v1/runs/r_budget" => Reply::json(200, run_json("r_budget", "stopped_budget")),
        "/v1/runs/r_slow" => Reply::json(200, run_json("r_slow", "running")),
        _ => Reply::problem(404, "run_not_found", "nope"),
    });
    let c = client(&srv.url).with_max_retries(0);
    let run = c.runs().wait("r_ok", &fast_wait()).await.unwrap();
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(run.artifact_id.as_deref(), Some("art_1"));
    // `run_json` carries a field this SDK does not know: decoding still succeeds.

    let e = c.runs().wait("r_fail", &fast_wait()).await.unwrap_err();
    match &e {
        Error::RunFailed(r) => {
            assert_eq!(r.status, RunStatus::Failed);
            assert_eq!(r.error.as_deref(), Some("CUDA out of memory"));
        }
        other => panic!("{:?}", other),
    }
    assert!(e.to_string().contains("CUDA out of memory"));
    assert_eq!(e.code(), "run_failed");

    let e = c.runs().wait("r_budget", &fast_wait()).await.unwrap_err();
    assert_eq!(e.code(), "run_stopped_budget");

    let e = c
        .runs()
        .wait("r_slow", &fast_wait().timeout(Duration::from_millis(60)))
        .await
        .unwrap_err();
    assert!(matches!(e, Error::WaitTimeout { .. }), "{:?}", e);
    assert!(e.to_string().contains("running"));

    let e = c.runs().wait("r_missing", &fast_wait()).await.unwrap_err();
    assert!(
        matches!(e, Error::NotFound(_)),
        "non-transient errors are not retried"
    );
}

fn sse(events: &[(&str, Option<u64>, Value)]) -> Vec<u8> {
    let mut out = String::from(": ping\n\n");
    for (ev, id, data) in events {
        out.push_str(&format!("event: {}\n", ev));
        if let Some(id) = id {
            out.push_str(&format!("id: {}\n", id));
        }
        out.push_str(&format!("data: {}\n\n", data));
    }
    out.into_bytes()
}

fn metric(seq: u64, step: u64) -> Value {
    json!({"seq": seq, "attempt": 1, "step": step, "loss": 1.0 / (step as f64 + 1.0),
           "tokens": step * 100, "cost_usd": 0.001 * step as f64, "timestamp": "2026-11-27T00:00:00Z"})
}

#[tokio::test]
async fn metrics_stream_reconnects_with_last_event_id() {
    let conns = Arc::new(AtomicUsize::new(0));
    let c2 = conns.clone();
    let srv = MockServer::start(move |r| {
        assert_eq!(r.header("accept"), Some("text/event-stream"));
        let headers = vec![("content-type".to_string(), "text/event-stream".to_string())];
        match c2.fetch_add(1, Ordering::SeqCst) {
            0 => Reply::Stream {
                status: 200,
                headers,
                chunks: vec![
                    (Duration::ZERO, sse(&[("metric", Some(1), metric(1, 1))])),
                    // Split an event across chunks and use CRLF line endings.
                    (
                        Duration::from_millis(10),
                        b"event: metric\r\nid: 2\r\ndata: ".to_vec(),
                    ),
                    (
                        Duration::from_millis(10),
                        format!("{}\r\n\r\n", metric(2, 2)).into_bytes(),
                    ),
                ],
            },
            1 => {
                assert_eq!(r.header("last-event-id"), Some("2"));
                Reply::Stream {
                    status: 200,
                    headers,
                    chunks: vec![(
                        Duration::ZERO,
                        sse(&[
                            ("metric", Some(3), metric(3, 3)),
                            ("status", None, run_json("r1", "completed")),
                        ]),
                    )],
                }
            }
            _ => panic!("no third connection expected"),
        }
    });
    let c = client(&srv.url);
    let mut stream = c
        .runs()
        .stream_metrics("r1", None)
        .reconnect_base(Duration::from_millis(5));
    let mut steps = vec![];
    let mut finished = None;
    while let Some(ev) = stream.next().await {
        match ev.unwrap() {
            MetricEvent::Metric(p) => steps.push(p.step),
            MetricEvent::Finished(run) => finished = Some(run),
        }
    }
    assert_eq!(steps, vec![1, 2, 3]);
    assert_eq!(finished.unwrap().status, RunStatus::Completed);
    assert_eq!(stream.last_event_id(), Some("3"));
    assert_eq!(conns.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn wait_with_metrics_falls_back_to_polling() {
    let polls = Arc::new(AtomicUsize::new(0));
    let p2 = polls.clone();
    let srv = MockServer::start(move |r| {
        let sse_req = r.header("accept") == Some("text/event-stream");
        match r.path() {
            // A buffering proxy answers the SSE request with JSON.
            "/v1/runs/r1/metrics" if sse_req => Reply::json(200, json!({"data": []})),
            "/v1/runs/r1/metrics" => {
                let i = p2.fetch_add(1, Ordering::SeqCst);
                let (data, status, tail) = match i {
                    0 => (vec![metric(1, 1), metric(2, 2)], "running", "c2"),
                    _ => (vec![metric(2, 2), metric(3, 3)], "completed", "c3"),
                };
                Reply::json(
                    200,
                    json!({"run_id": "r1", "status": status, "data": data, "next_cursor": null, "tail_cursor": tail}),
                )
            }
            "/v1/runs/r1" => Reply::json(200, run_json("r1", "completed")),
            "/v1/runs/r2/metrics" => Reply::problem(404, "run_not_found", "no such run"),
            _ => Reply::problem(404, "nf", "nf"),
        }
    });
    let c = client(&srv.url);
    let seen = Mutex::new(vec![]);
    let run = c
        .runs()
        .wait_with_metrics("r1", &fast_wait(), |m| seen.lock().unwrap().push(m.seq))
        .await
        .unwrap();
    assert_eq!(run.status, RunStatus::Completed);
    assert_eq!(
        *seen.lock().unwrap(),
        vec![1, 2, 3],
        "duplicates are skipped"
    );
    assert!(srv
        .requests()
        .iter()
        .any(|r| r.query().contains("cursor=c2")));

    let e = c
        .runs()
        .wait_with_metrics("r2", &fast_wait(), |_| {})
        .await
        .unwrap_err();
    assert!(matches!(e, Error::NotFound(_)));
}

#[test]
fn sse_parser_follows_the_spec() {
    let mut p = SseParser::new();
    let evs =
        p.feed(b"data: a\ndata: b\nid: 7\nretry: 100\n\n: comment\nevent: x\ndata\n\nfoo: bar\n\n");
    assert_eq!(evs.len(), 2);
    assert_eq!(evs[0].event, "message");
    assert_eq!(evs[0].data, "a\nb");
    assert_eq!(evs[0].id.as_deref(), Some("7"));
    assert_eq!(evs[0].retry, Some(100));
    assert_eq!(evs[1].event, "x");
    assert_eq!(evs[1].data, "");
    assert_eq!(evs[1].id.as_deref(), Some("7"), "id persists");
    // A trailing CR waits for the next chunk.
    assert!(p.feed(b"data: z\r").is_empty());
    let evs = p.feed(b"\n\r\n");
    assert_eq!(evs[0].data, "z");
}

fn artifact_server(bundle: Vec<u8>, sha: Option<String>, declared: Option<usize>) -> MockServer {
    MockServer::start(move |r| {
        if r.path().ends_with("/download") {
            let mut headers = vec![(
                "content-type".to_string(),
                "application/octet-stream".to_string(),
            )];
            if let Some(s) = &sha {
                headers.push(("x-artifact-sha256".into(), s.clone()));
            }
            match declared {
                Some(n) => Reply::Truncated {
                    status: 200,
                    headers,
                    body: bundle.clone(),
                    declared: n,
                },
                None => Reply::Full {
                    status: 200,
                    headers,
                    body: bundle.clone(),
                },
            }
        } else {
            Reply::problem(404, "nf", "nf")
        }
    })
}

fn tmpdir(tag: &str) -> std::path::PathBuf {
    let base = std::env::var_os("TMPDIR")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(std::env::temp_dir);
    let d = base.join(format!(
        "grad-sdk-test-{}-{}",
        tag,
        &grad_sdk::sha256_hex(format!("{:?}", std::time::Instant::now()).as_bytes())[..10]
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

#[tokio::test]
async fn download_streams_verifies_and_extracts_a_peft_directory() {
    let report = br#"{"eval_loss": 0.5}"#;
    let b = mock::bundle_with(
        &[
            ("adapter_config.json", br#"{"peft_type":"LORA"}"#),
            ("adapter_model.safetensors", &[7u8; 70_000]),
            ("sub/dir/extra.txt", b"x"),
        ],
        Some(report),
        |_| {},
    );
    // Uppercase digests are accepted.
    let srv = artifact_server(b.clone(), Some(mock::sha256_hex(&b).to_uppercase()), None);
    let c = client(&srv.url);
    let dir = tmpdir("dl");
    let out = dir.join("adapter");
    let res = c
        .artifacts()
        .download("support-sft@latest", &DownloadOptions::extract(&out))
        .await
        .unwrap();
    assert_eq!(res.sha256, mock::sha256_hex(&b));
    assert_eq!(res.size_bytes, b.len() as u64);
    assert!(out.join("adapter_config.json").is_file());
    assert_eq!(
        std::fs::read(out.join("adapter_model.safetensors"))
            .unwrap()
            .len(),
        70_000
    );
    assert!(out.join("manifest.json").is_file());
    assert!(out.join("sub/dir/extra.txt").is_file());
    assert_eq!(res.files.len(), 3);
    assert_eq!(res.manifest["schema"], "grad.artifact/1");
    assert_eq!(
        srv.requests()[0].path(),
        "/v1/artifacts/support-sft%40latest/download"
    );
    // No temp files are left behind.
    let leftovers: Vec<_> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
        .collect();
    assert!(leftovers.is_empty());

    // A non-empty output directory is refused before downloading...
    let before = srv.requests().len();
    let e = c
        .artifacts()
        .download("support-sft@latest", &DownloadOptions::extract(&out))
        .await
        .unwrap_err();
    assert!(e.to_string().contains("--force"), "{}", e);
    assert_eq!(srv.requests().len(), before);
    // ...unless overwrite is set.
    let mut opts = DownloadOptions::extract(&out);
    opts.overwrite = true;
    c.artifacts()
        .download("support-sft@latest", &opts)
        .await
        .unwrap();

    // Archive mode keeps the verified tarball.
    let archive = dir.join("bundle.grad.tar.gz");
    let res = c
        .artifacts()
        .download("support-sft@latest", &DownloadOptions::archive(&archive))
        .await
        .unwrap();
    assert_eq!(std::fs::read(&archive).unwrap(), b);
    assert!(res.directory.is_none());
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn download_fails_closed() {
    let good = mock::bundle(&[("adapter_config.json", b"{}")]);
    let dir = tmpdir("dlfail");

    // Wrong digest.
    let srv = artifact_server(good.clone(), Some("0".repeat(64)), None);
    let e = client(&srv.url)
        .artifacts()
        .download("a", &DownloadOptions::extract(dir.join("o1")))
        .await
        .unwrap_err();
    assert!(matches!(e, Error::Checksum { .. }), "{:?}", e);
    assert!(!dir.join("o1").exists());

    // Missing digest header.
    let srv = artifact_server(good.clone(), None, None);
    let e = client(&srv.url)
        .artifacts()
        .download("a", &DownloadOptions::extract(dir.join("o2")))
        .await
        .unwrap_err();
    assert!(e.to_string().contains("X-Artifact-Sha256"), "{}", e);

    // Truncated body (connection closes early).
    let srv = artifact_server(
        good[..good.len() / 2].to_vec(),
        Some(mock::sha256_hex(&good)),
        Some(good.len()),
    );
    let e = client(&srv.url)
        .with_max_retries(0)
        .artifacts()
        .download("a", &DownloadOptions::extract(dir.join("o3")))
        .await
        .unwrap_err();
    assert!(
        matches!(
            e,
            Error::Connection { .. } | Error::Checksum { .. } | Error::Decode { .. }
        ),
        "{:?}",
        e
    );
    assert!(!dir.join("o3").exists());

    // Symlinked archive target.
    #[cfg(unix)]
    {
        let srv = artifact_server(good.clone(), Some(mock::sha256_hex(&good)), None);
        let link = dir.join("link.tgz");
        std::os::unix::fs::symlink(dir.join("elsewhere"), &link).unwrap();
        let mut opts = DownloadOptions::archive(&link);
        opts.overwrite = true;
        let e = client(&srv.url)
            .artifacts()
            .download("a", &opts)
            .await
            .unwrap_err();
        assert!(e.to_string().contains("symbolic link"), "{}", e);
        assert!(!dir.join("elsewhere").exists());
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn extraction_rejects_unsafe_bundles() {
    let dir = tmpdir("unsafe");
    let cases: Vec<(&str, Vec<u8>)> = vec![
        (
            "parent traversal",
            mock::raw_tar_gz(&[("../evil".into(), b"x".to_vec())]),
        ),
        (
            "absolute path",
            mock::raw_tar_gz(&[("/etc/evil".into(), b"x".to_vec())]),
        ),
        (
            "dot segment",
            mock::raw_tar_gz(&[("a/./b".into(), b"x".to_vec())]),
        ),
        (
            "backslash",
            mock::raw_tar_gz(&[("a\\b".into(), b"x".to_vec())]),
        ),
        (
            "duplicate",
            mock::raw_tar_gz(&[("a".into(), b"x".to_vec()), ("a".into(), b"y".to_vec())]),
        ),
        (
            "symlink",
            mock::symlink_tar_gz("adapter_model.safetensors", "/etc/passwd"),
        ),
        (
            "no manifest",
            mock::raw_tar_gz(&[("adapter_config.json".into(), b"{}".to_vec())]),
        ),
        (
            "undeclared file",
            mock::bundle_with(&[("a.json", b"{}")], None, |m| {
                m.insert("files".into(), json!({}));
            }),
        ),
        (
            "missing declared file",
            mock::bundle_with(&[("a.json", b"{}")], None, |m| {
                m["files"]["b.json"] = json!("0".repeat(64));
            }),
        ),
        (
            "tampered file",
            mock::bundle_with(&[("a.json", b"{}")], None, |m| {
                m["files"]["a.json"] = json!("1".repeat(64));
            }),
        ),
        (
            "wrong schema",
            mock::bundle_with(&[("a.json", b"{}")], None, |m| {
                m.insert("schema".into(), json!("other/9"));
            }),
        ),
        (
            "tampered eval report",
            mock::bundle_with(&[("a.json", b"{}")], Some(b"{}"), |m| {
                m.insert("eval_report_sha256".into(), json!("2".repeat(64)));
            }),
        ),
        ("not gzip", b"definitely not a tarball".to_vec()),
    ];
    for (what, bundle) in cases {
        let srv = artifact_server(bundle.clone(), Some(mock::sha256_hex(&bundle)), None);
        let out = dir.join(what.replace(' ', "_"));
        let e = client(&srv.url)
            .artifacts()
            .download("a", &DownloadOptions::extract(&out))
            .await
            .unwrap_err();
        assert!(
            matches!(e, Error::UnsafeArchive(_) | Error::Checksum { .. }),
            "{}: {:?}",
            what,
            e
        );
        assert!(!out.exists(), "{}: nothing is installed", what);
    }
    assert!(!dir.parent().unwrap().join("evil").exists());
    // Entry-count limit.
    let many: Vec<(&str, &[u8])> = vec![("a", b"1"), ("b", b"2"), ("c", b"3")];
    let b = mock::bundle(&many);
    let srv = artifact_server(b.clone(), Some(mock::sha256_hex(&b)), None);
    let mut opts = DownloadOptions::extract(dir.join("limited"));
    opts.limits = ExtractLimits {
        max_entries: 2,
        max_total_bytes: 1 << 20,
    };
    let e = client(&srv.url)
        .artifacts()
        .download("a", &opts)
        .await
        .unwrap_err();
    assert!(e.to_string().contains("entries"), "{}", e);
    opts.limits = ExtractLimits {
        max_entries: 100,
        max_total_bytes: 4,
    };
    let e = client(&srv.url)
        .artifacts()
        .download("a", &opts)
        .await
        .unwrap_err();
    assert!(e.to_string().contains("limit"), "{}", e);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn import_file_uploads_without_the_bearer_token() {
    let srv = MockServer::start(|r| match (r.method.as_str(), r.path()) {
        ("POST", "/v1/uploads") => Reply::json(
            201,
            json!({"upload_id": "up_1", "method": "PUT", "url": "/blobs/uploads/up_1?exp=9&sig=abc",
                   "headers": {"Content-Type": "application/octet-stream"}, "expires_at": "x"}),
        ),
        ("PUT", "/blobs/uploads/up_1") => Reply::json(200, json!({"upload_id": "up_1"})),
        ("POST", "/v1/datasets/support-prod/imports") => Reply::json(
            202,
            json!({"id": "imp_1", "dataset": "support-prod", "status": "queued", "connector": "auto"}),
        ),
        ("GET", "/v1/imports/imp_1") => Reply::json(
            200,
            json!({"id": "imp_1", "dataset": "support-prod", "status": "completed",
                   "imported_count": 3, "dropped_count": 1, "drop_reasons": ["line 2: invalid JSON"]}),
        ),
        _ => Reply::problem(404, "nf", "nf"),
    });
    let dir = tmpdir("upload");
    let file = dir.join("traces.jsonl");
    let content = b"{\"messages\": []}\n{bad\n{\"messages\": []}\n".repeat(10);
    std::fs::write(&file, &content).unwrap();
    let c = client(&srv.url);
    let job = c
        .datasets()
        .import_file(
            "support-prod",
            &file,
            &ImportFileOptions {
                format: Some("jsonl".into()),
                connector: Some("openai_chat".into()),
            },
        )
        .await
        .unwrap();
    assert_eq!(job.id, "imp_1");
    let ticket_req = srv.last("POST", "/v1/uploads").unwrap().json();
    assert_eq!(ticket_req["size_bytes"], content.len());
    assert_eq!(ticket_req["sha256"], mock::sha256_hex(&content));
    assert_eq!(ticket_req["filename"], "traces.jsonl");
    let put = srv.last("PUT", "/blobs/uploads/up_1").unwrap();
    assert!(
        put.header("authorization").is_none(),
        "presigned URLs never get the key"
    );
    assert_eq!(put.body, content);
    assert!(put.query().contains("sig=abc"));
    let imp = srv
        .last("POST", "/v1/datasets/support-prod/imports")
        .unwrap()
        .json();
    assert_eq!(
        imp,
        json!({"source": {"kind": "upload", "upload_id": "up_1", "format": "jsonl"}, "connector": "openai_chat"})
    );
    let done = c.imports().wait("imp_1", &fast_wait()).await.unwrap();
    assert_eq!(done.imported_count, 3);

    let e = c
        .datasets()
        .import_file(
            "x",
            &dir.join("missing.jsonl"),
            &ImportFileOptions::default(),
        )
        .await
        .unwrap_err();
    assert!(matches!(e, Error::Io { .. }));
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn push_file_validates_then_sends_bounded_batches() {
    let srv = MockServer::start(|r| {
        let n = r.json()["records"].as_array().map(|a| a.len()).unwrap_or(0);
        Reply::json(200, json!({"name": "ds", "version": 1, "record_count": n}))
    });
    let dir = tmpdir("push");
    let file = dir.join("train.jsonl");
    let mut s = String::new();
    for i in 0..2500 {
        s.push_str(&format!(
            "{{\"messages\": [{{\"role\": \"user\", \"content\": \"{}\"}}]}}\n",
            i
        ));
        if i == 10 {
            s.push('\n');
        }
    }
    std::fs::write(&file, &s).unwrap();
    let c = client(&srv.url);
    let mut progress = vec![];
    c.datasets()
        .push_file("ds", &file, &PushOptions::default(), |p| {
            progress.push(p.records_sent)
        })
        .await
        .unwrap();
    assert_eq!(progress, vec![1000, 2000, 2500]);
    assert_eq!(srv.count("POST", "/v1/datasets/ds/records"), 3);

    let bad = dir.join("bad.jsonl");
    std::fs::write(&bad, "{\"a\": 1}\n[1, 2]\n").unwrap();
    let before = srv.requests().len();
    let e = c
        .datasets()
        .push_file("ds", &bad, &PushOptions::default(), |_| {})
        .await
        .unwrap_err();
    assert!(e.to_string().contains("line 2"), "{}", e);
    assert_eq!(
        srv.requests().len(),
        before,
        "nothing is sent when a line is invalid"
    );

    let broken = dir.join("broken.jsonl");
    std::fs::write(&broken, "{\"a\": 1}\n{oops\n").unwrap();
    let e = c
        .datasets()
        .push_file("ds", &broken, &PushOptions::default(), |_| {})
        .await
        .unwrap_err();
    assert!(e.to_string().contains("line 2: invalid JSON"), "{}", e);
    let _ = std::fs::remove_dir_all(&dir);
}

#[tokio::test]
async fn list_all_follows_cursors_and_path_params_are_checked() {
    let srv = MockServer::start(|r| {
        if r.query().contains("cursor=p2") {
            Reply::json(
                200,
                json!({"data": [{"id": "r3", "name": "c"}], "next_cursor": null}),
            )
        } else {
            Reply::json(
                200,
                json!({"data": [{"id": "r1", "name": "a"}, {"id": "r2", "name": "b"}], "next_cursor": "p2"}),
            )
        }
    });
    let c = client(&srv.url);
    let all = c.runs().list_all().await.unwrap();
    assert_eq!(
        all.iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
        vec!["r1", "r2", "r3"]
    );
    let found = c.runs().find_by_name("c").await.unwrap().unwrap();
    assert_eq!(found.id, "r3");
    assert!(c.runs().find_by_name("zzz").await.unwrap().is_none());
    let before = srv.requests().len();
    assert!(matches!(
        c.runs().get("..").await,
        Err(Error::InvalidInput(_))
    ));
    assert!(matches!(
        c.artifacts().get("").await,
        Err(Error::InvalidInput(_))
    ));
    assert_eq!(srv.requests().len(), before);
}

#[tokio::test]
async fn resources_send_documented_wire_shapes() {
    let srv = MockServer::start(|r| match (r.method.as_str(), r.path()) {
        ("POST", "/v1/deployments") => Reply::json(
            200,
            json!({"name": "support-router", "model_id": "ws/support-router"}),
        ),
        ("POST", "/v1/deployments/support-router/rollback") => {
            Reply::json(200, json!({"name": "support-router"}))
        }
        ("GET", "/v1/deployments/support-router") => Reply::json(
            200,
            json!({"deployment": {"name": "support-router"}, "feedback_count": 3, "average_score": 0.9}),
        ),
        ("POST", "/v1/checkpoints/ck_1/promote") => Reply::json(
            201,
            json!({"id": "art_9", "name": "n", "version": "2026-11-27-1"}),
        ),
        ("POST", "/v1/runs/r1/resume") => Reply::json(200, run_json("r1", "queued")),
        ("POST", "/v1/runs/r1/cancel") => Reply::json(200, run_json("r1", "cancelled")),
        ("GET", "/v1/runs/r1/checkpoints") => Reply::json(
            200,
            json!({"data": [{"id": "ck_1", "final": true, "best": true}]}),
        ),
        ("POST", "/v1/keys") => Reply::json(
            201,
            json!({"key": {"id": "key_1", "scopes": ["runs:read"]}, "secret": "grad_live_secret"}),
        ),
        ("DELETE", "/v1/keys/key_1") => {
            Reply::json(200, json!({"id": "key_1", "revoked_at": "now"}))
        }
        ("POST", "/v1/evals/e1/scores") => Reply::json(
            200,
            json!({"accepted": 1, "status": "completed", "pending_local_scores": 0}),
        ),
        ("GET", "/v1/evals/e1/failures") => Reply::json(
            200,
            json!({"data": [{"task_id": "t1", "model": "m", "score": 0.1}]}),
        ),
        ("GET", "/v1/evals/e1/results") => Reply::json(200, json!({"data": []})),
        ("GET", "/v1/evals/e1/outputs") => {
            Reply::json(200, json!({"data": [{"id": "o1", "output": "hi"}]}))
        }
        ("POST", "/v1/evals/e1/cancel") => {
            Reply::json(200, json!({"id": "e1", "status": "cancelled"}))
        }
        ("GET", "/v1/evals/e1") => Reply::json(
            200,
            json!({"id": "e1", "status": "completed", "summary": [{"model": "m", "overall": 0.9}]}),
        ),
        ("GET", "/v1/evals/e2") => Reply::json(
            200,
            json!({"id": "e2", "status": "failed", "error": "judge down"}),
        ),
        ("POST", "/v1/datasets/ds/render") => Reply::json(
            200,
            json!({"examples": [{"record_id": "r", "spans": [{"text": "hi", "trained": true}]}]}),
        ),
        ("GET", "/v1/datasets/ds/records") => {
            Reply::json(200, json!({"total": 1, "data": [{"id": "x"}]}))
        }
        ("GET", "/health/ready") => Reply::json(200, json!({"status": "ready"})),
        _ => Reply::problem(404, "nf", &format!("{} {}", r.method, r.path())),
    });
    let c = client(&srv.url);
    c.deployments()
        .create(
            &DeployArtifactRequest {
                artifact: "support-router@latest".into(),
                explore_rate: Some(0.1),
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(
        srv.last("POST", "/v1/deployments").unwrap().json(),
        json!({"artifact": "support-router@latest", "explore_rate": 0.1})
    );
    c.deployments().rollback("support-router").await.unwrap();
    assert_eq!(
        c.deployments()
            .get("support-router")
            .await
            .unwrap()
            .feedback_count,
        3
    );
    assert_eq!(
        c.checkpoints()
            .promote("ck_1", Some("n"))
            .await
            .unwrap()
            .reference(),
        "n@2026-11-27-1"
    );
    c.runs().resume("r1", Some(5.0)).await.unwrap();
    assert_eq!(
        srv.last("POST", "/v1/runs/r1/resume").unwrap().json(),
        json!({"max_cost_usd": 5.0})
    );
    assert_eq!(
        c.runs().cancel("r1").await.unwrap().status,
        RunStatus::Cancelled
    );
    assert!(
        c.runs()
            .checkpoints("r1", &ListParams::default())
            .await
            .unwrap()
            .data[0]
            .r#final
    );
    let k = c.keys().create("ci", &["runs:read".into()]).await.unwrap();
    assert!(!format!("{:?}", k).contains("grad_live_secret"));
    assert_eq!(k.secret, "grad_live_secret");
    c.keys().revoke("key_1").await.unwrap();
    c.evals()
        .post_scores(
            "e1",
            &[LocalScore {
                output_id: "o1".into(),
                scorer: "s".into(),
                score: 1.0,
            }],
        )
        .await
        .unwrap();
    let f = c
        .evals()
        .failures("e1", Some("m"), Some(0.5), &ListParams::default())
        .await
        .unwrap();
    assert_eq!(f.data[0].task_id, "t1");
    assert!(srv
        .last("GET", "/v1/evals/e1/failures")
        .unwrap()
        .query()
        .contains("threshold=0.5"));
    c.evals()
        .results("e1", None, &ListParams::default())
        .await
        .unwrap();
    c.evals()
        .outputs("e1", None, Some("s"), &ListParams::default())
        .await
        .unwrap();
    c.evals().cancel("e1").await.unwrap();
    let mut polls = 0;
    let ev = c
        .evals()
        .wait("e1", &fast_wait(), |_| polls += 1)
        .await
        .unwrap();
    assert_eq!(ev.summary[0].overall, 0.9);
    assert_eq!(polls, 1);
    let e = c
        .evals()
        .wait("e2", &fast_wait(), |_| {})
        .await
        .unwrap_err();
    assert!(matches!(e, Error::EvalFailed(_)));
    assert!(e.to_string().contains("judge down"));
    let r = c
        .datasets()
        .render(
            "ds",
            &RenderDatasetRequest {
                limit: Some(2),
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert!(r.examples[0].spans[0].trained);
    assert_eq!(
        c.datasets()
            .records("ds", Some(1), &ListParams::default())
            .await
            .unwrap()
            .total,
        1
    );
    assert_eq!(c.health().await.unwrap()["status"], "ready");
    assert!(srv
        .last("GET", "/health/ready")
        .unwrap()
        .header("authorization")
        .is_none());
}

fn is_loop(e: &Error, cursor: &str) -> bool {
    matches!(e, Error::PaginationLoop { cursor: c, .. } if c == cursor)
}

/// Regression for the OOM incident: a fake that always returns the same
/// `next_cursor` must end every pager with a typed error after two pages.
#[tokio::test]
async fn pagers_stop_on_a_repeated_cursor() {
    let srv = MockServer::start(|r| match r.path() {
        "/v1/runs/r1/metrics" => Reply::json(
            200,
            json!({"run_id": "r1", "status": "running", "data": [metric(1, 1)], "next_cursor": null, "tail_cursor": "same"}),
        ),
        "/v1/runs/r1" => Reply::json(200, run_json("r1", "running")),
        "/v1/runs" | "/v1/datasets" | "/v1/keys" => Reply::json(
            200,
            json!({"data": [{"id": "r1", "name": "a", "version": 1, "record_count": 1,
                             "prefix": "grad_x", "scopes": []}], "next_cursor": "same"}),
        ),
        _ => Reply::problem(404, "nf", "nf"),
    });
    let c = client(&srv.url);

    let e = c.runs().list_all().await.unwrap_err();
    assert!(is_loop(&e, "same"), "{:?}", e);
    assert_eq!(e.code(), "pagination_loop");
    assert!(
        e.to_string().contains("/v1/runs") && e.to_string().contains("same"),
        "{}",
        e
    );
    assert_eq!(srv.requests().len(), 2, "stops after the cursor repeats");

    let e = c.runs().find_by_name("zzz").await.unwrap_err();
    assert!(is_loop(&e, "same"), "{:?}", e);
    let e = c.datasets().list_all().await.unwrap_err();
    assert!(is_loop(&e, "same"), "{:?}", e);
    let e = c.keys().list_all().await.unwrap_err();
    assert!(is_loop(&e, "same"), "{:?}", e);

    // The metrics tail: a non-empty page that does not advance the cursor.
    let before = srv.requests().len();
    let e = c
        .runs()
        .wait_with_metrics("r1", &fast_wait(), |_| {})
        .await
        .unwrap_err();
    assert!(is_loop(&e, "same"), "{:?}", e);
    let polls = srv.requests()[before..]
        .iter()
        .filter(|r| r.path() == "/v1/runs/r1/metrics")
        .count();
    assert!(polls <= 3, "metrics polls: {}", polls);
}

#[tokio::test]
async fn pagers_stop_on_an_empty_page_and_tail_tolerates_an_echoed_cursor() {
    let n = Arc::new(AtomicUsize::new(0));
    let n2 = n.clone();
    let srv = MockServer::start(move |r| match r.path() {
        // Always hands out a fresh cursor, but with no rows.
        "/v1/runs" => {
            let i = n2.fetch_add(1, Ordering::SeqCst);
            Reply::json(200, json!({"data": [], "next_cursor": format!("c{}", i)}))
        }
        // Tail: empty pages echo the cursor until the run completes.
        "/v1/runs/r1/metrics" => {
            let i = n2.fetch_add(1, Ordering::SeqCst);
            if i < 4 {
                Reply::json(
                    200,
                    json!({"run_id": "r1", "status": "running", "data": [], "next_cursor": null, "tail_cursor": "t1"}),
                )
            } else {
                Reply::json(
                    200,
                    json!({"run_id": "r1", "status": "completed", "data": [metric(1, 1)], "next_cursor": null, "tail_cursor": "t2"}),
                )
            }
        }
        "/v1/runs/r1" => Reply::json(200, run_json("r1", "completed")),
        _ => Reply::problem(404, "nf", "nf"),
    });
    let c = client(&srv.url);
    assert!(c.runs().list_all().await.unwrap().is_empty());
    assert_eq!(srv.requests().len(), 1);
    assert!(c.runs().find_by_name("x").await.unwrap().is_none());
    assert_eq!(srv.requests().len(), 2);
    let run = c
        .runs()
        .wait_with_metrics("r1", &fast_wait(), |_| {})
        .await
        .unwrap();
    assert_eq!(run.status, RunStatus::Completed);
}

#[tokio::test]
async fn collect_all_is_bounded_by_a_page_budget() {
    let n = Arc::new(AtomicUsize::new(0));
    let n2 = n.clone();
    // Finite: the client is asserted to stop at its page budget.
    let srv = MockServer::start(move |_| {
        let i = n2.fetch_add(1, Ordering::SeqCst);
        Reply::json(
            200,
            json!({"data": [{"id": format!("r{}", i), "name": "a"}], "next_cursor": format!("c{}", i)}),
        )
    });
    let c = client(&srv.url);
    let e = c.runs().list_all().await.unwrap_err();
    match &e {
        Error::PaginationLimit { path, pages } => {
            assert_eq!(path, "/v1/runs");
            assert_eq!(*pages, 500);
        }
        other => panic!("{:?}", other),
    }
    assert_eq!(e.code(), "pagination_limit");
    assert!(e.to_string().contains("500 pages"), "{}", e);
    assert_eq!(n.load(Ordering::SeqCst), 500);
}

#[test]
fn cursor_trail_rules() {
    let mut t = CursorTrail::new("/v1/x");
    assert_eq!(t.advance(None, 3, Some("a")).unwrap().as_deref(), Some("a"));
    assert_eq!(
        t.advance(Some("a"), 3, Some("b")).unwrap().as_deref(),
        Some("b")
    );
    assert!(t.advance(Some("b"), 3, Some("a")).is_err(), "older cursor");
    let mut t = CursorTrail::new("/v1/x");
    assert!(t.advance(Some("a"), 1, Some("a")).is_err(), "echoed cursor");
    assert_eq!(t.advance(None, 0, Some("z")).unwrap(), None, "empty page");
    assert_eq!(t.advance(None, 5, Some("")).unwrap(), None);
    assert_eq!(t.advance(None, 5, None).unwrap(), None);
    assert_eq!(t.pages(), 4);
}

#[test]
fn eval_reports_and_metric_points_are_typed() {
    let mut run = run_json("r1", "completed");
    run["eval_report"] = json!({
        "metric_name": "eval_loss", "selected_step": 3, "best_step": null, "final_step": 4,
        "train_records": 90, "eval_records": 10, "warnings": ["w"], "eval_loss": 0.4,
        "fallback_model": "b",
        "pareto_summary": {"target_max_drop": 0.02, "quality_drop": 0.008, "quality_drop_ci95": [-0.004, 0.019], "temperature": 1.3},
        "future": 1
    });
    run["latest_metric"] = json!({"seq": 1, "attempt": 1, "step": 4, "loss": 0.5, "tokens": 1,
        "cost_usd": 0.0, "timestamp": "t", "eval_metrics": {"eval_loss": 0.4, "eval_token_accuracy": null}});
    let run: Run = serde_json::from_value(run).unwrap();
    let report = run.eval_report.unwrap();
    assert_eq!(
        (report.selected_step, report.best_step, report.metric()),
        (3, None, Some(0.4))
    );
    let pareto = report.pareto_summary.unwrap();
    assert_eq!(pareto.quality_drop_ci95, Some(vec![-0.004, 0.019]));
    assert_eq!(pareto.offload_rate, None);
    let other = EvalReport {
        metric_name: "custom".into(),
        ..Default::default()
    };
    assert_eq!(other.metric(), None);
    for (name, field) in [
        ("preference_accuracy", 1),
        ("eval_kl", 2),
        ("recall_at_10", 3),
    ] {
        let r = EvalReport {
            metric_name: name.into(),
            preference_accuracy: Some(1.0),
            eval_kl: Some(2.0),
            recall_at_10: Some(3.0),
            ..Default::default()
        };
        assert_eq!(r.metric(), Some(field as f64));
    }
    let metrics = run.latest_metric.unwrap().eval_metrics.unwrap();
    assert_eq!(metrics["eval_loss"], Some(0.4));
    assert_eq!(metrics["eval_token_accuracy"], None);
}

#[tokio::test]
async fn dataset_scoring_waits_and_filters_stream_ids() {
    let polls = Arc::new(AtomicUsize::new(0));
    let p = polls.clone();
    let srv = MockServer::start(move |r| match (r.method.as_str(), r.path()) {
        ("POST", "/v1/datasets/logs/score") => Reply::json(
            202,
            json!({"id": "eval_s", "name": "logs-score", "status": "queued", "mode": "score",
                   "models": ["record"], "task_source": {"kind": "dataset", "dataset": "logs", "version": 3}}),
        ),
        ("GET", "/v1/evals/eval_s") => {
            let done = p.fetch_add(1, Ordering::SeqCst) > 0;
            Reply::json(
                200,
                json!({"id": "eval_s", "name": "logs-score", "status": if done { "completed" } else { "running" },
                       "mode": "score", "scored_dataset_version": if done { json!(4) } else { Value::Null },
                       "task_source": {"kind": "dataset", "dataset": "logs", "version": 3}}),
            )
        }
        ("GET", "/v1/datasets/logs") => {
            Reply::json(200, json!({"id": "ds_1", "name": "logs", "version": 3}))
        }
        ("GET", "/v1/datasets/logs/records") => {
            if r.query().contains("cursor=c1") {
                Reply::json(
                    200,
                    json!({"dataset": "logs", "version": 3, "total": 3, "next_cursor": null,
                           "data": [{"id": "c", "prompt": "long one"}]}),
                )
            } else {
                Reply::json(
                    200,
                    json!({"dataset": "logs", "version": 3, "total": 3, "next_cursor": "c1",
                           "data": [{"id": "a", "prompt": "hi"}, {"prompt": "no id"}]}),
                )
            }
        }
        ("POST", "/v1/datasets/logs/filter") => Reply::json(
            201,
            json!({"id": "ds_2", "name": "logs-f-0123456789", "version": 1}),
        ),
        _ => Reply::problem(404, "route_not_found", "no route"),
    });
    let c = client(&srv.url);
    let item = EvalRubricItem {
        name: "ok".into(),
        kind: EvalRubricItemKind::Validator,
        validator: Some(EvalRubricItemValidator::NonEmpty),
        ..Default::default()
    };
    let job = c
        .datasets()
        .score(
            "logs",
            &ScoreDatasetRequest {
                rubric: vec![item],
                ..Default::default()
            },
            None,
        )
        .await
        .unwrap();
    assert_eq!(job.mode.as_str(), "score");
    let (ev, ds) = c
        .datasets()
        .wait_scored(&job.id, &fast_wait(), |_| {})
        .await
        .unwrap();
    assert_eq!(
        (ev.scored_dataset_version, ds.name.as_str()),
        (Some(4), "logs")
    );

    let view = c
        .datasets()
        .filter_with("logs", None, Some("short"), |r| {
            r.prompt.as_ref().and_then(Value::as_str).map(str::len) < Some(5)
        })
        .await
        .unwrap();
    assert_eq!(view.name, "logs-f-0123456789");
    let sent = srv.requests().pop().unwrap();
    assert_eq!(
        sent.json(),
        json!({"ids": ["a"], "version": 3, "name": "short"})
    );
}
