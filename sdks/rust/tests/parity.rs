//! Shared parity fixture (tests/fixtures/wire/sdk-parity.json), replayed by every SDK and the CLI.

mod support;

use grad_sdk::*;
use serde_json::{json, Value};
use support::mock::{MockServer, Reply};

fn fixture() -> Value {
    let path = concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../tests/fixtures/wire/sdk-parity.json"
    );
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

/// JSON numbers compared by value (`5` and `5.0` are the same number on the wire).
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        other => other.clone(),
    }
}

fn judge() -> EvalRubricItem {
    EvalRubricItem {
        name: "quality".into(),
        kind: EvalRubricItemKind::Judge,
        weight: Some(1.0),
        model: Some("judge/m".into()),
        prompt: Some("Is the answer correct?".into()),
        ..Default::default()
    }
}

const ARTIFACT: &str = "support-sft@2026-11-27-1";

async fn call(c: &Client, case: &str) -> Result<()> {
    let model = |m: &str| Some(m.to_string());
    match case {
        "plan_sft_every_param" => {
            let recipe = RecipeSpec {
                model: model("test/tiny-qwen3"),
                adapter: Some(AdapterSpec {
                    kind: AdapterSpecKind::Lora,
                    rank: Some(16),
                    alpha: Some(16),
                    merge_on_export: Some(true),
                    ..Default::default()
                }),
                lr: Some(json!(0.0002)),
                lr_scale: Some(0.5),
                optimizer: Some(OptimizerSpec {
                    kind: Some(OptimizerSpecKind::Adamw),
                    betas: Some(vec![json!(0.8), json!(0.9)]),
                    weight_decay: Some(0.1),
                    grad_clip: Some(0.5),
                }),
                batch_size: Some(4),
                epochs: Some(2),
                schedule: Some(RecipeSpecSchedule::Cosine),
                warmup: Some(0.05),
                train_on: Some(RecipeSpecTrainOn::AllAssistant),
                thinking: Some(RecipeSpecThinking::Off),
                preserve_thinking: Some(true),
                reduction: Some(RecipeSpecReduction::PerToken),
                select: Some(RecipeSpecSelect::Last),
                checkpoint_ttl_days: Some(7),
                eval_every: Some(json!(2)),
                ..RecipeSpec::new(RecipeKind::Sft)
            };
            let mut req = PlanRunRequest::new("support", "sft-params", recipe).max_cost_usd(5.0);
            req.split = Some(SplitSpec {
                strategy: Some(SplitSpecStrategy::BySession),
                eval_fraction: Some(0.2),
                seed: Some(7),
            });
            c.runs().plan(&req).await.map(drop)
        }
        "create_dpo_from_artifact" => {
            let recipe = RecipeSpec {
                beta: Some(0.3),
                ..RecipeSpec::new(RecipeKind::Dpo).model(ARTIFACT)
            };
            let req = PlanRunRequest::new("prefs", "dpo-continued", recipe);
            c.runs()
                .create(&req, Some("parity-run-key"))
                .await
                .map(drop)
        }
        "plan_router_judge_rubric" => {
            let recipe = RecipeSpec {
                models: Some(vec!["cheap/m".into(), "strong/m".into()]),
                rubric: Some(json!([judge()])),
                max_quality_drop: Some(0.05),
                pricing: Some([("cheap/m".into(), 0.001), ("strong/m".into(), 0.01)].into()),
                fallback: model("strong/m"),
                ..RecipeSpec::new(RecipeKind::Router).model("test/tiny-qwen3")
            };
            let req = PlanRunRequest::new("support-logs", "router-params", recipe);
            c.runs().plan(&req).await.map(drop)
        }
        "plan_cartridge" => {
            let recipe = RecipeSpec {
                context_text: model("The capital of Testland is Tinytown."),
                num_tokens: Some(16),
                teacher: model("test/tiny-qwen3-teacher"),
                loss: Some(LossSpec {
                    kind: LossSpecKind::TopKKlDistill,
                    top_k: Some(7),
                    ..Default::default()
                }),
                max_new_tokens: Some(5),
                ..RecipeSpec::new(RecipeKind::Cartridge).model("test/tiny-qwen3")
            };
            let req = PlanRunRequest::new("docs", "cartridge-params", recipe);
            c.runs().plan(&req).await.map(drop)
        }
        "plan_embedding" => {
            let recipe = RecipeSpec {
                temp: Some(0.1),
                pool: Some(PoolingSpec {
                    kind: PoolingSpecKind::Cls,
                }),
                ..RecipeSpec::new(RecipeKind::Embedding).model("test/tiny-bert")
            };
            let req = PlanRunRequest::new("pairs", "embedding-params", recipe);
            c.runs().plan(&req).await.map(drop)
        }
        "plan_decision" => {
            let req = PlanRunRequest::new(
                "decisions",
                "decision",
                RecipeSpec::new(RecipeKind::Decision),
            );
            c.runs().plan(&req).await.map(drop)
        }
        "create_eval" => {
            let non_empty = EvalRubricItem {
                name: "non_empty".into(),
                kind: EvalRubricItemKind::Validator,
                validator: Some(EvalRubricItemValidator::NonEmpty),
                weight: Some(1.0),
                ..Default::default()
            };
            let req = PlanEvalRequest {
                name: model("parity-eval"),
                models: vec!["test/tiny-qwen3".into(), ARTIFACT.into()],
                dataset: "support".into(),
                dataset_version: Some(1),
                rubric: Some(vec![judge(), non_empty]),
                baseline: model("test/tiny-qwen3"),
                samples: Some(3),
                temperature: Some(0.7),
                max_tokens: Some(256),
                limit: Some(10),
                pass_threshold: Some(0.5),
            };
            c.evals()
                .create(&req, Some("parity-eval-key"))
                .await
                .map(drop)
        }
        "deploy" => {
            let req = DeployArtifactRequest {
                artifact: ARTIFACT.into(),
                name: model("support"),
                fallback: model("test/tiny-qwen3"),
                explore_rate: Some(0.1),
            };
            c.deployments()
                .create(&req, Some("parity-deploy-key"))
                .await
                .map(drop)
        }
        other => panic!("no Rust call for parity case {}", other),
    }
}

#[tokio::test]
async fn requests_match_the_shared_fixture() {
    let srv = MockServer::start(|_| Reply::json(200, json!({"id": "x", "status": "queued"})));
    let c = Client::builder()
        .ignore_env(true)
        .ignore_config_file(true)
        .base_url(&srv.url)
        .api_key("grad_test_key")
        .build()
        .unwrap();
    let fx = fixture();
    for case in fx["requests"].as_array().unwrap() {
        let name = case["case"].as_str().unwrap();
        call(&c, name).await.unwrap();
        let sent = srv.requests().pop().unwrap();
        assert_eq!(
            (sent.method.as_str(), sent.path()),
            (
                case["method"].as_str().unwrap(),
                case["path"].as_str().unwrap()
            ),
            "{}",
            name
        );
        assert_eq!(norm(&sent.json()), norm(&case["body"]), "{}", name);
        let key = sent.header("idempotency-key").unwrap_or_default();
        match case["idempotency_key"].as_str() {
            Some(k) => assert_eq!(key, k, "{}", name),
            None => assert_eq!(key.len(), 36, "{}: a fresh UUIDv4", name),
        }
    }
}

#[test]
fn typed_responses() {
    let fx = fixture();
    let run: Run = serde_json::from_value(fx["responses"]["run"].clone()).unwrap();
    let ev: EvalRun = serde_json::from_value(fx["responses"]["eval"].clone()).unwrap();
    let plan: PlanEvalResponse =
        serde_json::from_value(fx["responses"]["eval_plan"].clone()).unwrap();
    let report = run.eval_report.unwrap();
    let pareto = report.pareto_summary.clone().unwrap();
    let got = json!({
        "run.eval_report.metric_name": report.metric_name,
        "run.eval_report.selected_step": report.selected_step,
        "run.eval_report.eval_loss": report.eval_loss,
        "run.eval_report.fallback_model": report.fallback_model,
        "run.eval_report.pareto_summary.quality_drop": pareto.quality_drop,
        "run.eval_report.pareto_summary.quality_drop_ci95": pareto.quality_drop_ci95,
        "run.latest_metric.eval_metrics.routed_quality": run.latest_metric.unwrap().eval_metrics.unwrap()["routed_quality"],
        "eval.total_cost_usd": ev.total_cost_usd,
        "eval.summary[0].cost_per_1k_tasks_usd": ev.summary[0].cost_per_1k_tasks_usd,
        "eval_plan.estimated_cost_usd": plan.estimated_cost_usd,
    });
    assert_eq!(norm(&got), norm(&fx["expect"]));
    assert_eq!(report.metric(), Some(0.41));
}
