//! Shared parity fixture (tests/fixtures/wire/sdk-parity.json), replayed by every SDK and the CLI.

mod support;

use grad::*;
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
        "plan_distill" => {
            let recipe = RecipeSpec {
                teacher: model("test/tiny-qwen3-teacher"),
                rollout: Some(recipes::on_policy(Some(64))),
                loss: Some(LossSpec {
                    kind: LossSpecKind::TopKKlDistill,
                    top_k: Some(16),
                    ..Default::default()
                }),
                context_text: model("Refunds take 30 days."),
                ..RecipeSpec::new(RecipeKind::Distill).model("test/tiny-qwen3")
            };
            let req = PlanRunRequest::new("support-prompts", "distill-params", recipe);
            c.runs().plan(&req).await.map(drop)
        }
        "plan_distill_off_policy" => {
            let recipe = RecipeSpec {
                teacher: model("support-sft@2026-11-27-1"),
                rollout: Some(recipes::off_policy(Some(128))),
                loss: Some(LossSpec {
                    kind: LossSpecKind::CrossEntropy,
                    ..Default::default()
                }),
                ..RecipeSpec::new(RecipeKind::Distill)
            };
            let req = PlanRunRequest::new("support-prompts", "distill-off", recipe);
            c.runs().plan(&req).await.map(drop)
        }
        "plan_reward" => {
            let recipe = RecipeSpec {
                adapter: Some(AdapterSpec {
                    kind: AdapterSpecKind::FrozenHead,
                    ..Default::default()
                }),
                rubric: Some(json!("resolved")),
                ..RecipeSpec::new(RecipeKind::Reward).model("test/tiny-qwen3")
            };
            let req = PlanRunRequest::new("sql-preferences", "sql-verifier", recipe);
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
        "plan_sft_checkpoint_evals_loggers" => {
            let starts = EvalRubricItem {
                name: "starts_select".into(),
                kind: EvalRubricItemKind::Regex,
                pattern: Some("^SELECT".into()),
                weight: Some(1.0),
                ..Default::default()
            };
            let recipe = RecipeSpec {
                evals: Some(vec![
                    RecipeEval {
                        dataset: "gsm8k-200".into(),
                        ..Default::default()
                    },
                    RecipeEval {
                        dataset: "support-holdout".into(),
                        rubric: Some(vec![starts]),
                        limit: Some(50),
                        name: model("sql"),
                        ..Default::default()
                    },
                ]),
                loggers: Some(vec![
                    LoggerSpec {
                        kind: LoggerSpecKind::Wandb,
                        project: model("support"),
                        secret: model("wandb-key"),
                        ..Default::default()
                    },
                    LoggerSpec {
                        kind: LoggerSpecKind::Mlflow,
                        tracking_uri: model("https://mlflow.internal"),
                        experiment: model("sft"),
                        ..Default::default()
                    },
                ]),
                ..RecipeSpec::new(RecipeKind::Sft).model("test/tiny-qwen3")
            };
            let req = PlanRunRequest::new("support", "sft-tracked", recipe);
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
        "score_dataset" => {
            let req = ScoreDatasetRequest {
                rubric: vec![judge()],
                version: Some(1),
                name: model("support-logs-quality"),
                limit: Some(100),
            };
            c.datasets()
                .score("support-logs", &req, Some("parity-score-key"))
                .await
                .map(drop)
        }
        "filter_dataset_fields" => {
            let req = FilterDatasetRequest {
                scores: Some([("quality".to_string(), json!(">=0.8"))].into()),
                metadata: Some([("env".to_string(), json!("prod"))].into()),
                created_after: Some(json!("2026-11-01")),
                version: Some(2),
                name: model("support-good"),
                ..Default::default()
            };
            c.datasets().filter("support-logs", &req).await.map(drop)
        }
        "import_benchmark" => c
            .datasets()
            .import_benchmark("gsm8k-test-200", "gsm8k", Some(200))
            .await
            .map(drop),
        "filter_dataset_ids" => {
            let req = FilterDatasetRequest {
                ids: Some(vec!["rec_a".into(), "rec_c".into()]),
                ..Default::default()
            };
            c.datasets().filter("support-logs", &req).await.map(drop)
        }
        "set_secret" => c
            .secrets()
            .set("langfuse-prod", "pk-lf-1:sk-lf-2")
            .await
            .map(drop),
        "set_secret_hosts" => c
            .secrets()
            .set_with_hosts(
                "langfuse-self",
                "pk-lf-1:sk-lf-2",
                &["langfuse.internal:3000"],
            )
            .await
            .map(drop),
        "add_source" => {
            let provider = SourceProvider::langfuse()
                .host("https://cloud.langfuse.com")
                .secret(SecretRef::named("langfuse-prod"));
            c.sources()
                .create(
                    "support-prod",
                    &provider,
                    Some("*/15 * * * *"),
                    Some("parity-source-key"),
                )
                .await
                .map(drop)
        }
        "add_source_gradiated" => c
            .datasets()
            .add_source(
                "support-prod",
                &SourceProvider::gradiated().models(["acme/support"]),
                Some("0 * * * *"),
            )
            .await
            .map(drop),
        "sync_source_full" => c.sources().sync("src_01J9X", true).await.map(drop),
        "list_usage" => c
            .usage()
            .list(&ListParams {
                limit: Some(10),
                cursor: None,
            })
            .await
            .map(drop),
        "list_run_events" => {
            let id = fixture()["responses"]["run_events"]["run_id"]
                .as_str()
                .unwrap()
                .to_string();
            c.runs().events_page(&id, None, Some(100)).await.map(drop)
        }
        other => panic!("no Rust call for parity case {}", other),
    }
}

#[tokio::test]
async fn requests_match_the_shared_fixture() {
    let srv = MockServer::start(|r| {
        if r.path() == "/v1/usage" {
            Reply::json(200, json!({"data": [], "next_cursor": null}))
        } else {
            Reply::json(200, json!({"id": "x", "status": "queued"}))
        }
    });
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
        let key = sent.header("idempotency-key").unwrap_or_default();
        if case["method"] == "GET" {
            let query: Value = sent
                .query()
                .split('&')
                .filter_map(|kv| kv.split_once('='))
                .map(|(k, v)| (k.to_string(), Value::String(v.to_string())))
                .collect::<serde_json::Map<_, _>>()
                .into();
            assert_eq!(query, case["query"], "{}", name);
            assert_eq!(key, "", "{}: GETs carry no Idempotency-Key", name);
            continue;
        }
        assert_eq!(norm(&sent.json()), norm(&case["body"]), "{}", name);
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
    let scoring: EvalRun = serde_json::from_value(fx["responses"]["scoring"].clone()).unwrap();
    let run_plan: PlanRunResponse =
        serde_json::from_value(fx["responses"]["run_plan"].clone()).unwrap();
    let plan: PlanEvalResponse =
        serde_json::from_value(fx["responses"]["eval_plan"].clone()).unwrap();
    let source: Source = serde_json::from_value(fx["responses"]["source"].clone()).unwrap();
    let secret: SecretRef = serde_json::from_value(fx["responses"]["secret"].clone()).unwrap();
    let usage: UsageRecord =
        serde_json::from_value(fx["responses"]["usage_page"]["data"][0].clone()).unwrap();
    let events: RunEventsPage =
        serde_json::from_value(fx["responses"]["run_events"].clone()).unwrap();
    let phase = |i: usize| match &events.data[i] {
        RunEvent::Phase(p) => p.clone(),
        other => panic!("event {} is {}", i, other.type_name()),
    };
    let attempt = |i: usize| match &events.data[i] {
        RunEvent::Attempt(a) => a.clone(),
        other => panic!("event {} is {}", i, other.type_name()),
    };
    let RunEvent::Metric(metric7) = &events.data[7] else {
        panic!("metric")
    };
    let RunEvent::Checkpoint(ckpt11) = &events.data[11] else {
        panic!("checkpoint")
    };
    let RunEvent::Completed(done) = &events.data[24] else {
        panic!("completed")
    };
    let interruption = run.last_interruption.clone().unwrap();
    let last = source.last_sync.clone().unwrap();
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
        "scoring.mode": scoring.mode.as_str(),
        "scoring.scored_dataset_version": scoring.scored_dataset_version,
        "run_plan.estimated_duration_s": run_plan.estimated_duration_s,
        "run_plan.min_gpu_memory_gb": run_plan.min_gpu_memory_gb,
        "source.id": source.id,
        "source.provider.kind": source.provider.kind,
        "source.provider.secret": source.provider.secret,
        "source.schedule": source.schedule,
        "source.last_sync.status": last.status.as_str(),
        "source.last_sync.dataset_version": last.dataset_version,
        "source.status": source.status,
        "source.consecutive_failures": source.consecutive_failures,
        "source.last_error": source.last_error,
        "secret.name": secret.name,
        "secret.allowed_hosts[0]": secret.allowed_hosts[0],
        "usage[0].kind": usage.kind,
        "usage[0].tokens_through": usage.tokens_through,
        "usage[0].cost_usd": usage.cost_usd,
        "run.phase": run.phase.as_ref().unwrap().as_str(),
        "run.last_interruption.reason": interruption.reason.as_str(),
        "run.last_interruption.resume_step": interruption.resume_step,
        "run_events.data[2].phase": phase(2).phase.as_str(),
        "run_events.data[2].workers_online": phase(2).workers_online,
        "run_events.data[4].gpu.name": phase(4).gpu.unwrap().name,
        "run_events.data[7].metric.step": metric7.metric.step,
        "run_events.data[11].checkpoint_id": ckpt11.checkpoint_id,
        "run_events.data[12].event": "interrupted",
        "run_events.data[12].reason": attempt(12).reason.unwrap().as_str(),
        "run_events.data[14].resume_step": attempt(14).resume_step,
        "run_events.data[24].status": done.status.as_str(),
        "run_events.data[24].run.last_interruption.reason": done.run.last_interruption.clone().unwrap().reason.as_str(),
    });
    assert_eq!(attempt(12).event, AttemptKind::Interrupted);
    assert_eq!(norm(&got), norm(&fx["expect"]));
    assert_eq!(report.metric(), Some(0.41));
}
