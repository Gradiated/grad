//! Shared retry-policy fixture (tests/fixtures/wire/retries.json), replayed by every SDK.

mod support;

use grad::*;
use serde_json::Value;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use support::mock::{MockServer, Reply};

const FIXTURE: &str = include_str!("../../../tests/fixtures/wire/retries.json");
const DATASET: &str = include_str!("../../../tests/fixtures/wire/dataset.json");

fn reply(method: &str, spec: &Value) -> Reply {
    let status = spec["status"].as_u64().unwrap() as u16;
    if status >= 300 {
        let headers = spec["headers"]
            .as_object()
            .map(|h| {
                h.iter()
                    .map(|(k, v)| (k.as_str(), v.as_str().unwrap().to_string()))
                    .collect()
            })
            .unwrap_or_default();
        return Reply::bytes(status, headers, serde_json::to_vec(&spec["body"]).unwrap());
    }
    match method {
        "GET" => Reply::json(status, serde_json::json!({"data": [], "next_cursor": null})),
        "POST" => Reply::json(status, serde_json::from_str(DATASET).unwrap()),
        _ => Reply::bytes(status, vec![], vec![]),
    }
}

#[tokio::test]
async fn retry_conformance() {
    let fixture: Value = serde_json::from_str(FIXTURE).unwrap();
    for case in fixture["cases"].as_array().unwrap() {
        let name = case["name"].as_str().unwrap();
        let method = case["method"].as_str().unwrap().to_string();
        let replies: Vec<Reply> = case["responses"]
            .as_array()
            .unwrap()
            .iter()
            .map(|r| reply(&method, r))
            .collect();
        let replies = Arc::new(std::sync::Mutex::new(replies));
        let served = Arc::new(AtomicUsize::new(0));
        let (r2, s2) = (replies.clone(), served.clone());
        let srv = MockServer::start(move |_| {
            let i = s2.fetch_add(1, Ordering::SeqCst);
            let mut all = r2.lock().unwrap();
            let last = all.len() - 1;
            std::mem::replace(&mut all[i.min(last)], Reply::Drop)
        });
        let c = Client::builder()
            .ignore_env(true)
            .ignore_config_file(true)
            .base_url(&srv.url)
            .api_key("grad_test_key")
            .retry_base_delay(Duration::from_millis(5))
            .build()
            .unwrap();
        let start = Instant::now();
        let result = match method.as_str() {
            "GET" => c.datasets().list(&ListParams::default()).await.map(|_| ()),
            "POST" => c.datasets().create("d", None).await.map(|_| ()),
            _ => c.secrets().delete("s").await,
        };
        let elapsed = start.elapsed();
        let expect = &case["expect"];
        match expect["error"].as_str() {
            None => assert!(result.is_ok(), "{name}: {:?}", result.err()),
            Some(class) => {
                let variant = class.strip_suffix("Error").unwrap_or(class);
                let got = format!("{:?}", result.as_ref().err());
                assert!(
                    got.starts_with(&format!("Some({variant}(")),
                    "{name}: got {got}, want {class}"
                );
            }
        }
        let attempts = srv.requests().len();
        assert_eq!(
            attempts as u64,
            expect["attempts"].as_u64().unwrap(),
            "{name}: attempts"
        );
        if let Some(sleeps) = expect["sleeps_ms"].as_array() {
            let total: u64 = sleeps.iter().map(|s| s.as_u64().unwrap()).sum();
            let ms = elapsed.as_millis() as u64;
            assert!(
                ms >= total && ms < total + 1500,
                "{name}: waited {ms} ms, want about {total} ms"
            );
        }
        if method == "POST" {
            let keys: std::collections::HashSet<String> = srv
                .requests()
                .iter()
                .map(|r| r.header("idempotency-key").unwrap_or("").to_string())
                .collect();
            assert!(
                keys.len() == 1 && !keys.contains(""),
                "{name}: keys {keys:?}"
            );
        }
    }
}
