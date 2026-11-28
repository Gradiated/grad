//! Secrets and observability sources against an in-process mock server.

mod support;

use grad::*;
use serde_json::{json, Value};
use std::time::Duration;
use support::mock::{MockServer, Reply};

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

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/wire/sdk-parity.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn job() -> Value {
    json!({"id": "imp_7c1d", "dataset": "support-prod", "status": "queued",
           "source": {"kind": "provider", "source_id": "src_01J9X", "full": false}})
}

#[tokio::test]
async fn secrets_set_get_list_delete() {
    let fx = fixture();
    let secret = fx["responses"]["secret"].clone();
    let srv = MockServer::start(move |r| match (r.method.as_str(), r.path()) {
        ("POST", "/v1/secrets") | ("GET", "/v1/secrets/langfuse-prod") => {
            Reply::json(200, secret.clone())
        }
        ("GET", "/v1/secrets") => {
            Reply::json(200, json!({"data": [secret.clone()], "next_cursor": null}))
        }
        ("DELETE", "/v1/secrets/langfuse-prod") => Reply::bytes(204, vec![], vec![]),
        ("DELETE", "/v1/secrets/used") => Reply::problem(409, "secret_in_use", "used by src_1"),
        _ => Reply::problem(501, "secrets_unavailable", "Set GRAD_SECRETS_KEY."),
    });
    let c = client(&srv.url);

    let r = c.secrets().set("langfuse-prod", "pk:sk").await.unwrap();
    assert_eq!(r.name, "langfuse-prod");
    let sent = srv.last("POST", "/v1/secrets").unwrap();
    assert_eq!(
        sent.json(),
        json!({"name": "langfuse-prod", "value": "pk:sk"})
    );
    assert_eq!(sent.header("idempotency-key").unwrap().len(), 36);

    assert_eq!(c.secrets().get("langfuse-prod").await.unwrap(), r);
    assert_eq!(c.secrets().list_all().await.unwrap(), vec![r.clone()]);
    assert_eq!(
        c.secrets()
            .list(&ListParams::default())
            .await
            .unwrap()
            .data
            .len(),
        1
    );
    c.secrets().delete(&r).await.unwrap();
    assert_eq!(srv.count("DELETE", "/v1/secrets/langfuse-prod"), 1);

    let e = c.secrets().delete("used").await.unwrap_err();
    assert!(matches!(e, Error::Conflict(_)), "{:?}", e);
    assert!(matches!(
        c.secrets().set("x", "").await.unwrap_err(),
        Error::InvalidInput(_)
    ));
    assert!(matches!(
        c.secrets().get("..").await.unwrap_err(),
        Error::InvalidInput(_)
    ));
    let e = c.secrets().get("other").await.unwrap_err();
    assert!(matches!(e, Error::FeatureUnavailable(_)), "{:?}", e);
    assert_eq!(e.code(), "secrets_unavailable");
    assert!(!e.is_transient());
}

#[test]
fn providers_serialise_names_projects_and_filters() {
    let p = SourceProvider::braintrust()
        .host("https://api.braintrust.dev")
        .secret(SecretRef::named("bt"))
        .project("support-bot");
    assert_eq!(
        serde_json::to_value(&p).unwrap(),
        json!({"kind": "braintrust", "host": "https://api.braintrust.dev", "secret": "bt", "project": "support-bot"})
    );
    let names = [
        SourceProvider::langfuse(),
        SourceProvider::langsmith(),
        SourceProvider::posthog(),
        SourceProvider::phoenix(),
        SourceProvider::gradiated(),
    ]
    .map(|p| p.kind);
    assert_eq!(
        names,
        ["langfuse", "langsmith", "posthog", "phoenix", "gradiated"]
    );
    assert_eq!(
        serde_json::to_value(SourceProvider::langsmith().secret("ls")).unwrap(),
        json!({"kind": "langsmith", "secret": "ls"})
    );
    assert_eq!(
        serde_json::to_value(
            SourceProvider::posthog()
                .secret(String::from("ph"))
                .filter("event", "$ai_generation")
        )
        .unwrap()["filters"],
        json!({"event": "$ai_generation"})
    );
    let g = SourceProvider::gradiated()
        .models(["a/m"])
        .tasks(["support"])
        .versions(["v1"])
        .versions(Vec::<String>::new());
    assert_eq!(
        serde_json::to_value(g).unwrap(),
        json!({"kind": "gradiated", "filters": {"models": ["a/m"], "tasks": ["support"], "versions": ["v1"]}})
    );
}

#[tokio::test]
async fn sources_create_list_sync_remove() {
    let fx = fixture();
    let source = fx["responses"]["source"].clone();
    let srv = MockServer::start(move |r| match (r.method.as_str(), r.path()) {
        ("POST", "/v1/datasets/support-prod/sources") => Reply::json(201, source.clone()),
        ("GET", "/v1/sources/src_01J9X") => Reply::json(200, source.clone()),
        ("GET", "/v1/sources") => {
            Reply::json(200, json!({"data": [source.clone()], "next_cursor": null}))
        }
        ("POST", "/v1/sources/src_01J9X/sync") => Reply::json(202, job()),
        ("DELETE", "/v1/sources/src_01J9X") => Reply::bytes(204, vec![], vec![]),
        ("POST", "/v1/datasets/d/sources") => Reply::problem(
            422,
            "source_provider_unsupported",
            "grad can't sync from 'helicone'.",
        ),
        _ => Reply::problem(501, "source_unavailable", "Cloud only."),
    });
    let c = client(&srv.url);

    let provider = SourceProvider::langfuse()
        .host("https://cloud.langfuse.com")
        .secret("langfuse-prod");
    let s = c
        .datasets()
        .add_source("support-prod", &provider, Some("*/15 * * * *"))
        .await
        .unwrap();
    assert_eq!(
        (s.id.as_str(), s.provider.kind.as_str()),
        ("src_01J9X", "langfuse")
    );
    assert_eq!(
        s.last_sync.as_ref().unwrap().status,
        ImportStatus::Completed
    );
    assert_eq!(
        srv.last("POST", "/v1/datasets/support-prod/sources")
            .unwrap()
            .json(),
        json!({"provider": {"kind": "langfuse", "host": "https://cloud.langfuse.com", "secret": "langfuse-prod"},
               "schedule": "*/15 * * * *"})
    );

    assert_eq!(c.sources().get("src_01J9X").await.unwrap(), s);
    assert_eq!(
        c.datasets().sources("support-prod").await.unwrap(),
        vec![s.clone()]
    );
    assert!(srv
        .last("GET", "/v1/sources")
        .unwrap()
        .query()
        .contains("dataset=support-prod"));
    assert_eq!(c.sources().list_all(None).await.unwrap().len(), 1);
    assert_eq!(
        c.sources()
            .list(None, &ListParams::default())
            .await
            .unwrap()
            .data
            .len(),
        1
    );

    let j = c.sources().sync("src_01J9X", false).await.unwrap();
    assert_eq!(j.id, "imp_7c1d");
    assert_eq!(
        srv.last("POST", "/v1/sources/src_01J9X/sync")
            .unwrap()
            .json(),
        json!({"full": false})
    );
    c.sources().remove("src_01J9X").await.unwrap();
    assert_eq!(srv.count("DELETE", "/v1/sources/src_01J9X"), 1);

    let e = c
        .sources()
        .create("d", &SourceProvider::new("helicone"), None, None)
        .await
        .unwrap_err();
    assert!(matches!(e, Error::Validation(_)), "{:?}", e);
    assert_eq!(e.code(), "source_provider_unsupported");
    let e = c
        .sources()
        .create("c", &SourceProvider::gradiated(), None, None)
        .await
        .unwrap_err();
    assert!(matches!(e, Error::FeatureUnavailable(_)), "{:?}", e);
    assert!(c.sources().sync("", true).await.is_err());
    assert!(c.sources().remove("..").await.is_err());
}

#[tokio::test]
async fn source_pagers_stop_on_a_repeated_cursor() {
    let srv = MockServer::start(|r| match r.path() {
        "/v1/sources" | "/v1/secrets" => Reply::json(
            200,
            json!({"data": [{"id": "src_1", "name": "a"}], "next_cursor": "same"}),
        ),
        _ => Reply::problem(404, "nf", "nf"),
    });
    let c = client(&srv.url);
    for e in [
        c.sources().list_all(Some("d")).await.unwrap_err(),
        c.secrets().list_all().await.unwrap_err(),
    ] {
        assert_eq!(e.code(), "pagination_loop", "{:?}", e);
    }
    assert_eq!(srv.requests().len(), 4);
}

#[tokio::test]
async fn from_hf_with_a_secret_sends_the_name_only() {
    let srv = MockServer::start(|_| Reply::json(202, job()));
    let c = client(&srv.url);
    let source = ImportSource {
        kind: ImportSourceKind::Hf,
        repo: Some("org/gated".into()),
        secret: Some(SecretRef::named("hf-token").secret_name()),
        ..Default::default()
    };
    c.datasets().from_hf("gated", source, None).await.unwrap();
    let sent = srv
        .last("POST", "/v1/datasets/gated/imports")
        .unwrap()
        .json();
    assert_eq!(sent["source"]["secret"], json!("hf-token"));
    assert_eq!(sent["source"]["repo"], json!("org/gated"));
}

#[tokio::test]
async fn usage_list_all_keeps_filters_on_every_page_and_summary_decodes() {
    let fx = fixture();
    let page = fx["responses"]["usage_page"].clone();
    let summary = fx["responses"]["usage_summary"].clone();
    let srv = MockServer::start(move |r| match r.path() {
        "/v1/usage/summary" => Reply::json(200, summary.clone()),
        _ if r.query().contains("cursor=c1") => {
            Reply::json(200, json!({"data": [], "next_cursor": null}))
        }
        _ => {
            let mut p = page.clone();
            p["next_cursor"] = json!("c1");
            Reply::json(200, p)
        }
    });
    let c = client(&srv.url);
    let since = std::time::UNIX_EPOCH + Duration::from_secs(1_793_491_200);
    let q = UsageQuery::new()
        .from(since)
        .eval("eval_1")
        .kind(UsageKind::Eval)
        .limit(3)
        .cursor("ignored");
    let rows = c.usage().list_all(&q).await.unwrap();
    assert_eq!(rows[0].kind, UsageKind::Training);
    let queries: Vec<String> = srv
        .requests()
        .iter()
        .map(|r| r.query().to_string())
        .collect();
    let want = "from=2026-11-01T00%3A00%3A00Z&eval_id=eval_1&kind=eval&limit=200";
    assert_eq!(queries, [want.to_string(), format!("{want}&cursor=c1")]);

    let s = c
        .usage()
        .summary(&UsageSummaryQuery::new().group_by(UsageGroupBy::Day))
        .await
        .unwrap();
    assert_eq!(s.top_runs[0].name.as_deref(), Some("support-sft"));
    assert_eq!(s.group_by, Some(UsageGroupBy::Model));
    assert_eq!(srv.requests().last().unwrap().query(), "group_by=day");
}
