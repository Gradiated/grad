#![recursion_limit = "512"]
//! CLI integration tests: run the built `grad` binary against an in-process mock server.

#[path = "../../sdks/rust/tests/support/mock.rs"]
mod mock;

use assert_cmd::Command;
use mock::{MockServer, Recorded, Reply};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

struct Sandbox {
    dir: PathBuf,
}

impl Sandbox {
    fn new(tag: &str) -> Sandbox {
        let base = std::env::var_os("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!(
            "grad-cli-{}-{}-{}",
            tag,
            std::process::id(),
            &mock::sha256_hex(format!("{:?}", std::time::Instant::now()).as_bytes())[..8]
        ));
        std::fs::create_dir_all(&dir).unwrap();
        Sandbox { dir }
    }

    fn path(&self, p: &str) -> PathBuf {
        self.dir.join(p)
    }

    fn config_path(&self) -> PathBuf {
        self.dir.join("xdg").join("gradiated").join("config.json")
    }

    /// `grad` with an isolated HOME/XDG and the env pointing at `url`.
    fn grad(&self, url: Option<&str>) -> Command {
        let mut c = Command::cargo_bin("grad").unwrap();
        c.current_dir(&self.dir)
            .env("HOME", &self.dir)
            .env("XDG_CONFIG_HOME", self.dir.join("xdg"))
            .env("XDG_DATA_HOME", self.dir.join("data"))
            .env("GRAD_RETRY_BASE_MS", "1")
            .env_remove("GRADIATED_PROFILE")
            .env_remove("GRADIATED_API_KEY")
            .env_remove("GRADIATED_BASE_URL")
            .env_remove("GRAD_COMPOSE_FILE")
            .env_remove("COMPOSE_PROJECT_NAME")
            .env_remove("GRAD_PORT")
            .env_remove("GRAD_GRAFANA_PORT")
            .env_remove("GRAD_PROMETHEUS_PORT")
            .env_remove("GRAD_S3_PORT")
            .timeout(Duration::from_secs(60));
        if let Some(u) = url {
            c.env("GRADIATED_BASE_URL", u)
                .env("GRADIATED_API_KEY", "grad_cli_test");
        }
        c
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

struct Ran {
    code: i32,
    stdout: String,
    stderr: String,
}

impl Ran {
    fn json(&self) -> Value {
        serde_json::from_str(&self.stdout)
            .unwrap_or_else(|e| panic!("stdout is not JSON ({}): {}", e, self.stdout))
    }
    fn err_json(&self) -> Value {
        serde_json::from_str(&self.stderr)
            .unwrap_or_else(|e| panic!("stderr is not JSON ({}): {}", e, self.stderr))
    }
}

fn run(mut c: Command, args: &[&str]) -> Ran {
    let out = c.args(args).output().unwrap();
    Ran {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

fn run_stdin(mut c: Command, args: &[&str], stdin: &str) -> Ran {
    let out = c
        .args(args)
        .write_stdin(stdin.to_string())
        .output()
        .unwrap();
    Ran {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

fn expect(r: &Ran, code: i32) {
    assert_eq!(
        r.code, code,
        "exit code\nstdout:\n{}\nstderr:\n{}",
        r.stdout, r.stderr
    );
}

/// Replace values that vary between runs (ports, temp paths) before snapshotting.
fn normalize(v: &Value, url: &str, dir: &Path) -> Value {
    match v {
        Value::String(s) => Value::String(
            s.replace(url, "<URL>")
                .replace(&dir.display().to_string(), "<DIR>"),
        ),
        Value::Array(a) => Value::Array(a.iter().map(|x| normalize(x, url, dir)).collect()),
        Value::Object(m) => Value::Object(
            m.iter()
                .map(|(k, x)| (k.clone(), normalize(x, url, dir)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn snapshot(name: &str, v: &Value) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("snapshots")
        .join(format!("{}.json", name));
    let rendered = serde_json::to_string_pretty(v).unwrap() + "\n";
    if std::env::var_os("UPDATE_SNAPSHOTS").is_some() || !path.exists() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &rendered).unwrap();
        return;
    }
    let expected = std::fs::read_to_string(&path).unwrap();
    assert_eq!(
        rendered, expected,
        "snapshot {} differs (UPDATE_SNAPSHOTS=1 to accept)",
        name
    );
}

fn run_obj(id: &str, name: &str, status: &str) -> Value {
    json!({
        "id": id, "workspace_id": "ws", "name": name, "dataset_name": "support-prod", "dataset_version": 3,
        "recipe_kind": "router", "status": status, "current_step": 2, "total_steps": 2, "attempt": 1, "max_attempts": 3,
        "tokens_processed": 1100000, "cost_usd": 0.12, "max_cost_usd": if status == "stopped_budget" { json!(0.1) } else { Value::Null },
        "created_at": "2026-11-26T10:00:00.000Z", "updated_at": "2026-11-26T10:00:42.000Z",
        "finished_at": if status == "running" || status == "queued" { Value::Null } else { json!("2026-11-26T10:00:42.000Z") },
        "artifact_id": if status == "completed" { json!("art_1") } else { Value::Null },
        "error": if status == "failed" { json!("worker crashed: CUDA OOM") } else { Value::Null },
        "eval_report": if status == "completed" { json!({"fallback_quality": 0.912, "routed_quality": 0.906, "offload_rate": 0.641, "warnings": ["small eval split"]}) } else { Value::Null },
        "resolved_config": {
            "rule_version": "auto@2", "dataset": "support-prod", "dataset_version": 3, "name": name, "recipe_kind": "router",
            "model": "qwen/qwen3-0.6b", "adapter": {"kind": "lora", "rank": 32}, "lr": 0.0005, "lr_source": "auto",
            "batch_size": 128, "epochs": 1, "schedule": "cosine", "warmup": 0.03, "train_on": "last", "thinking": "auto",
            "preserve_thinking": false, "reduction": "per_example", "select": "best", "checkpoint_every_steps": 50,
            "checkpoint_ttl_days": 30,
            "split": {"strategy": "by_session", "eval_fraction": 0.15, "seed": 42, "train_records": 4097, "eval_records": 723},
            "recipe_params": {"models": ["qwen/qwen3-8b", "qwen/qwen3-32b"]}
        }
    })
}

fn plan_obj() -> Value {
    json!({
        "resolved_config": run_obj("x", "support-router", "queued")["resolved_config"].clone(),
        "dataset_version": 3, "usable_records": 4820, "total_records": 4820, "estimated_steps": 33,
        "estimated_tokens": 1100000, "estimated_cost_usd": 0.165, "estimated_duration_s": 140,
        "min_gpu_memory_gb": 24, "price_per_million_tokens": 0.15,
        "cost_breakdown": {"train_usd": 0.15, "teacher_usd": 0, "eval_usd": 0.02},
        "trained_token_fraction": 0.62, "warnings": ["3 records have no scores"]
    })
}

fn artifact_obj() -> Value {
    json!({"id": "art_1", "name": "support-router", "version": "2026-11-26-1", "format": "router_bundle",
           "base_model": "qwen/qwen3-0.6b", "recipe_kind": "router", "sha256": "ab".repeat(32), "size_bytes": 2048,
           "manifest": {}, "created_at": "2026-11-26T10:00:42.000Z"})
}

fn sse_body(events: &[(&str, Option<u64>, Value)]) -> Vec<u8> {
    let mut s = String::new();
    for (e, id, d) in events {
        s.push_str(&format!("event: {}\n", e));
        if let Some(id) = id {
            s.push_str(&format!("id: {}\n", id));
        }
        s.push_str(&format!("data: {}\n\n", d));
    }
    s.into_bytes()
}

/// One RunEvent of run `run` (seq, type, extra fields).
fn ev(run: &str, seq: u64, ty: &str, extra: Value) -> Value {
    let mut v = json!({"type": ty, "run_id": run, "seq": seq, "attempt": 1, "timestamp": "2026-11-26T10:00:00.000Z"});
    for (k, x) in extra.as_object().unwrap() {
        v[k] = x.clone();
    }
    v
}

fn metric_ev(run: &str, seq: u64, step: u64) -> (&'static str, Option<u64>, Value) {
    (
        "metric",
        Some(seq),
        ev(
            run,
            seq,
            "metric",
            json!({"step": step, "metric": metric(step)}),
        ),
    )
}

fn completed_ev(run: &str, seq: u64, final_run: Value) -> (&'static str, Option<u64>, Value) {
    let status = final_run["status"].clone();
    (
        "completed",
        None,
        ev(
            run,
            seq,
            "completed",
            json!({"status": status, "run": final_run}),
        ),
    )
}

fn metric(seq: u64) -> Value {
    json!({"seq": seq, "attempt": 1, "step": seq, "loss": 0.5, "eval_loss": if seq == 2 { json!(0.4) } else { Value::Null },
           "lr": 0.0005, "tokens": seq * 550000, "cost_usd": 0.06 * seq as f64, "timestamp": "2026-11-26T10:00:10Z"})
}

/// A server implementing the happy path of most endpoints.
fn api() -> MockServer {
    MockServer::start(handler)
}

fn handler(r: &Recorded) -> Reply {
    let sse = r.header("accept") == Some("text/event-stream");
    match (r.method.as_str(), r.path()) {
        ("GET", "/health/ready") => Reply::json(200, json!({"status": "ready"})),
        ("GET", "/v1/base-models") => Reply::json(
            200,
            json!({"data": [
                {"id": "qwen/qwen3-0.6b", "family": "llm", "adapters": ["lora"], "recipes": ["router", "sft"], "max_context_tokens": 32768, "price_per_million_tokens_usd": 0.15},
                {"id": "baai/bge-small-en-v1.5", "family": "encoder", "adapters": ["encoder_full"], "recipes": ["embedding"], "max_context_tokens": 512, "price_per_million_tokens_usd": 0.08}
            ]}),
        ),
        ("GET", "/v1/datasets") => Reply::json(
            200,
            json!({"data": [{"name": "support-prod", "version": 3, "record_count": 4820, "updated_at": "2026-11-26T09:00:00Z"}], "next_cursor": null}),
        ),
        ("GET", "/v1/datasets/support-prod") => Reply::json(
            200,
            json!({"name": "support-prod", "version": 3, "record_count": 4820}),
        ),
        ("POST", "/v1/datasets") => Reply::json(
            201,
            json!({"name": r.json()["name"], "version": 0, "record_count": 0}),
        ),
        ("POST", p) if p.ends_with("/records") => {
            let n = r.json()["records"].as_array().map(|a| a.len()).unwrap_or(0);
            Reply::json(
                200,
                json!({"name": "support-sft", "version": 1, "record_count": n}),
            )
        }
        ("GET", "/v1/datasets/support-prod/records") => Reply::json(
            200,
            json!({"dataset": "support-prod", "version": 3, "total": 1, "data": [{"id": "rec_1", "messages": []}], "next_cursor": null}),
        ),
        ("POST", "/v1/datasets/support-sft/render") => Reply::json(
            200,
            json!({"dataset": "support-sft", "model": "qwen/qwen3-8b", "template_revision": "qwen3@3", "token_counts": "estimated",
            "examples": [{"record_id": "r1", "total_tokens": 10, "trained_tokens": 4, "trained_fraction": 0.4, "spans": [{"text": "<|im_start|>user\nhi", "trained": false, "tokens": 6}, {"text": "hello", "trained": true, "tokens": 4}]}]}),
        ),
        ("POST", "/v1/uploads") => Reply::json(
            201,
            json!({"upload_id": "up_1", "method": "PUT", "url": "/blobs/uploads/up_1?exp=1&sig=s", "headers": {}, "expires_at": "x"}),
        ),
        ("PUT", "/blobs/uploads/up_1") => Reply::json(200, json!({"upload_id": "up_1"})),
        ("POST", p) if p.ends_with("/imports") => Reply::json(
            202,
            json!({"id": "imp_1", "dataset": p.split('/').nth(3).unwrap(), "status": "queued", "connector": r.json()["connector"].as_str().unwrap_or("auto")}),
        ),
        ("GET", "/v1/imports/imp_1") => Reply::json(
            200,
            json!({"id": "imp_1", "dataset": "support-prod", "status": "completed", "connector": "openai_chat", "imported_count": 4820, "dropped_count": 2, "detected_scores": ["csat"], "drop_reasons": ["line 7: invalid JSON", "line 9: no messages"], "dataset_version": 3}),
        ),
        ("GET", "/v1/imports") => Reply::json(
            200,
            json!({"data": [{"id": "imp_1", "dataset": "support-prod", "status": "completed", "imported_count": 4820}]}),
        ),
        ("POST", "/v1/runs/plan") => Reply::json(200, plan_obj()),
        ("POST", "/v1/runs") => Reply::json(
            202,
            run_obj("run_1", r.json()["name"].as_str().unwrap_or("x"), "queued"),
        ),
        ("GET", "/v1/runs") => Reply::json(
            200,
            json!({"data": [run_obj("run_1", "support-router", "completed")], "next_cursor": null}),
        ),
        ("GET", "/v1/runs/run_1/events") if !sse => Reply::json(
            200,
            json!({"run_id": "run_1", "status": "completed", "next_cursor": null, "tail_cursor": "c", "data": [
                ev("run_1", 1, "phase", json!({"phase": "queued", "step": 0, "workers_online": 2, "autoscaling": false, "gpu": null})),
                ev("run_1", 2, "phase", json!({"phase": "starting", "step": 0, "gpu": {"name": "NVIDIA L4", "memory_gb": 22.5}})),
                ev("run_1", 3, "phase", json!({"phase": "training", "step": 0})),
                ev("run_1", 4, "metric", json!({"step": 2, "metric": metric(2)})),
                ev("run_1", 5, "checkpoint", json!({"step": 2, "checkpoint_id": "ckpt_2", "eval_score": 0.4, "format": "peft_lora"})),
                ev("run_1", 6, "log", json!({"step": 2, "message": "uploaded"})),
                ev("run_1", 7, "future", json!({})),
                ev("run_1", 7, "completed", json!({"status": "completed", "run": run_obj("run_1", "support-router", "completed")})),
            ]}),
        ),
        ("GET", "/v1/runs/run_1/events") => Reply::Stream {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream".into())],
            chunks: vec![
                (
                    Duration::ZERO,
                    sse_body(&[
                        (
                            "phase",
                            Some(1),
                            ev(
                                "run_1",
                                1,
                                "phase",
                                json!({"phase": "waiting_for_compute", "step": 0, "workers_online": 0, "autoscaling": false, "gpu": null}),
                            ),
                        ),
                        (
                            "phase",
                            Some(2),
                            ev(
                                "run_1",
                                2,
                                "phase",
                                json!({"phase": "starting", "step": 0, "workers_online": null, "autoscaling": null, "gpu": {"name": "NVIDIA H100 80GB HBM3", "memory_gb": 79.6}}),
                            ),
                        ),
                        (
                            "phase",
                            Some(3),
                            ev("run_1", 3, "phase", json!({"phase": "training", "step": 0})),
                        ),
                        metric_ev("run_1", 4, 1),
                        (
                            "checkpoint",
                            Some(5),
                            ev(
                                "run_1",
                                5,
                                "checkpoint",
                                json!({"step": 1, "checkpoint_id": "ckpt_1", "eval_score": null, "format": null}),
                            ),
                        ),
                        (
                            "attempt",
                            Some(6),
                            ev(
                                "run_1",
                                6,
                                "attempt",
                                json!({"event": "interrupted", "reason": "compute_reclaimed", "step": 1, "resume_step": 1, "max_attempts": 3, "message": "attempt 1 interrupted at step 1: the GPU was reclaimed; resuming from step 1 on a new worker"}),
                            ),
                        ),
                        (
                            "warning",
                            Some(7),
                            ev(
                                "run_1",
                                7,
                                "warning",
                                json!({"step": null, "message": "wandb logger disabled"}),
                            ),
                        ),
                        (
                            "phase",
                            Some(8),
                            ev("run_1", 8, "phase", json!({"phase": "training", "step": 1})),
                        ),
                    ]),
                ),
                (
                    Duration::from_millis(20),
                    sse_body(&[
                        metric_ev("run_1", 9, 2),
                        completed_ev("run_1", 9, run_obj("run_1", "support-router", "completed")),
                    ]),
                ),
            ],
        },
        ("GET", "/v1/runs/run_1/metrics") if sse => Reply::Stream {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream".into())],
            chunks: vec![
                (Duration::ZERO, sse_body(&[("metric", Some(1), metric(1))])),
                (
                    Duration::from_millis(20),
                    sse_body(&[
                        ("metric", Some(2), metric(2)),
                        (
                            "status",
                            None,
                            run_obj("run_1", "support-router", "completed"),
                        ),
                    ]),
                ),
            ],
        },
        ("GET", "/v1/runs/run_1/metrics") => Reply::json(
            200,
            json!({"run_id": "run_1", "status": "completed", "data": [metric(1), metric(2)], "next_cursor": null}),
        ),
        ("GET", "/v1/runs/run_1") => {
            Reply::json(200, run_obj("run_1", "support-router", "completed"))
        }
        ("GET", "/v1/runs/support-router") => {
            Reply::problem(404, "run_not_found", "Run 'support-router' not found.")
        }
        ("POST", "/v1/runs/run_1/cancel") => {
            Reply::json(200, run_obj("run_1", "support-router", "cancelled"))
        }
        ("POST", "/v1/runs/run_1/resume") => {
            Reply::json(200, run_obj("run_1", "support-router", "queued"))
        }
        ("GET", "/v1/runs/run_1/checkpoints") => Reply::json(
            200,
            json!({"data": [{"id": "ckpt_1", "step": 2, "eval_score": 0.9, "best": true, "final": true, "format": "router_bundle"}]}),
        ),
        ("POST", "/v1/checkpoints/ckpt_1/promote") => Reply::json(201, artifact_obj()),
        ("GET", "/v1/artifacts") => Reply::json(200, json!({"data": [artifact_obj()]})),
        ("GET", "/v1/artifacts/art_1") | ("GET", "/v1/artifacts/support-router%40latest") => {
            Reply::json(200, artifact_obj())
        }
        ("DELETE", "/v1/artifacts/support-router%40latest") => Reply::problem(
            409,
            "artifact_pinned",
            "Artifact 'support-router@2026-11-26-1' is pinned by inference:mv_1 (acme/support v3).",
        ),
        ("DELETE", "/v1/artifacts/art_1") => Reply::bytes(204, vec![], vec![]),
        ("POST", "/v1/artifact-imports") => Reply::json(
            202,
            json!({"id": "imp_9", "name": r.json()["name"].as_str().unwrap_or("support-lora"), "status": "queued"}),
        ),
        ("GET", "/v1/artifact-imports/imp_9") => Reply::json(
            200,
            json!({"id": "imp_9", "name": "my-lora", "status": "completed", "artifact_id": "art_1"}),
        ),
        ("POST", "/v1/keys") => Reply::json(
            201,
            json!({"key": {"id": "key_1", "name": r.json()["name"], "prefix": "grad_ab", "scopes": r.json()["scopes"], "created_at": "2026-11-27T00:00:00Z"}, "secret": "grad_abcdefghijklmnop"}),
        ),
        ("GET", "/v1/keys") => Reply::json(
            200,
            json!({"data": [{"id": "key_1", "name": "ci", "prefix": "grad_ab", "scopes": ["runs:read"], "created_at": "2026-11-27T00:00:00Z"}]}),
        ),
        ("DELETE", "/v1/keys/key_1") => Reply::json(
            200,
            json!({"id": "key_1", "revoked_at": "2026-11-27T00:00:00Z"}),
        ),
        ("POST", "/v1/evals/plan") => Reply::json(
            200,
            json!({"task_source_kind": "dataset", "dataset_version": 1, "estimated_tasks": 50, "estimated_model_calls": 200, "estimated_judge_calls": 0, "estimated_cost_usd": 0.4, "pass_threshold": 1.0, "warnings": []}),
        ),
        ("POST", "/v1/evals") => Reply::json(
            202,
            json!({"id": "eval_1", "name": "sql", "status": "queued", "models": r.json()["models"]}),
        ),
        ("GET", "/v1/evals/eval_1") => Reply::json(
            200,
            json!({"id": "eval_1", "name": "sql", "status": "completed", "samples": 4, "pass_threshold": 1.0, "total_cost_usd": 0.4,
            "summary": [{"model": "qwen/qwen3-8b", "overall": 0.71, "ci_low": 0.65, "ci_high": 0.77, "pass_at_k": {"pass@1": 0.7}, "vs_baseline": null, "tasks": 50, "errors": 0, "cost_per_1k_tasks_usd": 1.2},
                        {"model": "sql-agent@latest", "overall": 0.86, "ci_low": 0.8, "ci_high": 0.9, "pass_at_k": {"pass@1": 0.85}, "vs_baseline": {"delta": 0.15, "ci_low": 0.1, "ci_high": 0.2}, "tasks": 50, "errors": 1, "cost_per_1k_tasks_usd": null}]}),
        ),
        ("GET", "/v1/evals") => Reply::json(
            200,
            json!({"data": [{"id": "eval_1", "name": "sql", "status": "completed", "models": ["a"]}]}),
        ),
        ("GET", "/v1/evals/eval_1/failures") => Reply::json(
            200,
            json!({"data": [{"task_id": "t1", "model": "qwen/qwen3-8b", "score": 0.2, "passed": false, "judge_model": null}]}),
        ),
        ("GET", "/v1/evals/eval_1/results") => Reply::json(
            200,
            json!({"data": [{"task_id": "t1", "model": "qwen/qwen3-8b", "score": 1.0, "passed": true}]}),
        ),
        ("POST", "/v1/datasets/support-prod/score") => Reply::json(
            202,
            json!({"id": "eval_s", "name": "support-prod-score", "status": "queued", "mode": "score", "models": ["record"]}),
        ),
        ("GET", "/v1/evals/eval_s") => Reply::json(
            200,
            json!({"id": "eval_s", "name": "support-prod-score", "status": "completed", "mode": "score", "total_cost_usd": 0.12, "scored_dataset_version": 4}),
        ),
        ("POST", "/v1/datasets/support-prod/filter") => Reply::json(
            201,
            json!({"id": "ds_v", "name": "support-prod-f-0123456789", "version": 1, "record_count": 1200}),
        ),
        ("POST", "/v1/evals/eval_1/cancel") => {
            Reply::json(200, json!({"id": "eval_1", "status": "cancelled"}))
        }
        _ => Reply::problem(
            404,
            "not_found",
            &format!("no mock for {} {}", r.method, r.path()),
        ),
    }
}

// ---------------------------------------------------------------- help & usage

#[test]
fn help_documents_exit_codes_and_every_command_has_help() {
    let sb = Sandbox::new("help");
    let r = run(sb.grad(None), &["--help"]);
    expect(&r, 0);
    for needle in [
        "Exit codes:",
        "130",
        "grad login",
        "GRADIATED_API_KEY",
        "--json",
    ] {
        assert!(
            r.stdout.contains(needle),
            "missing {}: {}",
            needle,
            r.stdout
        );
    }
    for cmd in [
        vec!["login"],
        vec!["train"],
        vec!["import"],
        vec!["eval"],
        vec!["local", "up"],
        vec!["artifacts", "download"],
        vec!["datasets", "import", "hf"],
        vec!["runs", "inspect"],
        vec!["keys", "create"],
        vec!["artifacts", "upload"],
        vec!["artifacts", "import"],
        vec!["secrets"],
        vec!["sources"],
        vec!["ui"],
    ] {
        let mut args = cmd.clone();
        args.push("--help");
        let r = run(sb.grad(None), &args);
        expect(&r, 0);
        assert!(
            r.stdout.contains("Example"),
            "{:?} has examples: {}",
            cmd,
            r.stdout
        );
    }
    let r = run(sb.grad(None), &["--version"]);
    expect(&r, 0);
    assert!(r.stdout.starts_with("grad "));
}

#[test]
fn usage_errors_exit_2_and_json_mode_wraps_them() {
    let sb = Sandbox::new("usage");
    let r = run(sb.grad(None), &["train", "--bogus"]);
    expect(&r, 2);
    let r = run(sb.grad(None), &["--json", "frobnicate"]);
    expect(&r, 2);
    let e = r.err_json();
    assert_eq!(e["ok"], false);
    assert_eq!(e["error"]["code"], "usage_error");
    assert_eq!(e["error"]["exit_code"], 2);
    assert!(r.stdout.is_empty());
    let r = run(sb.grad(None), &[]);
    expect(&r, 2);
    // Missing required run settings without -f.
    let r = run(
        sb.grad(Some("http://127.0.0.1:1")),
        &["train", "--dataset", "d", "--name", "n"],
    );
    expect(&r, 2);
    assert!(r.stderr.contains("--recipe"), "{}", r.stderr);
    let r = run(
        sb.grad(Some("http://127.0.0.1:1")),
        &[
            "train",
            "--dataset",
            "d",
            "--name",
            "n",
            "--recipe",
            "magic",
        ],
    );
    expect(&r, 2);
    assert!(r.stderr.contains("decision-model"), "{}", r.stderr);
    for cut in [
        &["secrets", "set", "x"][..],
        &["env", "serve", "m:e"],
        &["rollback", "x"],
    ] {
        expect(&run(sb.grad(None), cut), 2);
    }
    let r = run(
        sb.grad(None),
        &["--base-url", "localhost:18787", "models", "list"],
    );
    expect(&r, 2);
    assert!(r.stderr.contains("http://localhost:18787"), "{}", r.stderr);
    // No key for a remote server: fail before sending, with the message every SDK gives.
    let r = run(
        sb.grad(None),
        &[
            "--base-url",
            "https://grad.example.invalid",
            "datasets",
            "list",
        ],
    );
    expect(&r, 2);
    assert!(
        r.stderr.contains(
            "No API key for https://grad.example.invalid: run `grad login`, set GRADIATED_API_KEY, or export GRADIATED_PROFILE=local"
        ),
        "{}",
        r.stderr
    );
}

// ---------------------------------------------------------------- login & config

#[test]
fn login_validates_and_writes_a_private_config() {
    let srv = MockServer::start(|r| match r.header("authorization") {
        Some("Bearer grad_good_key_123456") => Reply::json(200, json!({"data": []})),
        _ => Reply::problem(401, "unauthorized", "Provide a valid API key."),
    });
    let sb = Sandbox::new("login");
    let r = run_stdin(
        sb.grad(None),
        &["login", "--base-url", &srv.url, "--api-key-stdin"],
        "grad_good_key_123456\n",
    );
    expect(&r, 0);
    assert!(r.stdout.contains("Logged in"), "{}", r.stdout);
    assert!(
        !r.stdout.contains("grad_good_key_123456"),
        "the key is masked"
    );
    let cfg: Value =
        serde_json::from_str(&std::fs::read_to_string(sb.config_path()).unwrap()).unwrap();
    assert_eq!(
        cfg["profiles"]["default"],
        json!({"base_url": srv.url, "api_key": "grad_good_key_123456"})
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(sb.config_path())
            .unwrap()
            .permissions()
            .mode()
            & 0o777;
        assert_eq!(mode, 0o600);
    }
    // The saved profile is used by later commands, with no env at all.
    let r = run(sb.grad(None), &["models", "list", "--json"]);
    expect(&r, 0);
    assert_eq!(
        srv.last("GET", "/v1/base-models")
            .unwrap()
            .header("authorization"),
        Some("Bearer grad_good_key_123456")
    );

    // A rejected key exits 3 and saves nothing.
    let r = run(
        sb.grad(None),
        &[
            "login",
            "--profile",
            "other",
            "--base-url",
            &srv.url,
            "--api-key",
            "grad_bad_key_000000",
        ],
    );
    expect(&r, 3);
    assert!(r.stderr.contains("rejected"), "{}", r.stderr);
    let cfg: Value =
        serde_json::from_str(&std::fs::read_to_string(sb.config_path()).unwrap()).unwrap();
    assert!(cfg["profiles"].get("other").is_none());

    // --no-verify saves without contacting an unreachable server; profiles stay separate.
    let r = run(
        sb.grad(None),
        &[
            "--json",
            "login",
            "--profile",
            "local",
            "--base-url",
            "http://127.0.0.1:9",
            "--api-key",
            "grad_local_key_99999",
            "--no-verify",
        ],
    );
    expect(&r, 0);
    let j = r.json();
    assert_eq!(j["data"]["profile"], "local");
    assert_eq!(j["data"]["verified"], false);
    let r = run(
        sb.grad(None),
        &["--profile", "local", "--json", "config", "show"],
    );
    expect(&r, 0);
    assert_eq!(r.json()["data"]["base_url"], "http://127.0.0.1:9");
    assert_eq!(r.json()["data"]["api_key_source"], "profile 'local'");

    // Nothing on stdin -> usage error.
    let r = run_stdin(sb.grad(None), &["login", "--base-url", &srv.url], "");
    expect(&r, 2);

    // Unreachable server without --no-verify -> exit 1 naming the URL.
    let r = run(
        sb.grad(None),
        &[
            "login",
            "--base-url",
            "http://127.0.0.1:9",
            "--api-key",
            "grad_x_0000000000",
        ],
    );
    expect(&r, 1);
    assert!(r.stderr.contains("http://127.0.0.1:9"), "{}", r.stderr);

    let r = run(sb.grad(None), &["config", "path"]);
    assert_eq!(PathBuf::from(r.stdout.trim()), sb.config_path());
    let r = run(sb.grad(None), &["--profile", "local", "logout"]);
    expect(&r, 0);
    let cfg: Value =
        serde_json::from_str(&std::fs::read_to_string(sb.config_path()).unwrap()).unwrap();
    assert!(cfg["profiles"].get("local").is_none());
    let r = run(sb.grad(None), &["--profile", "local", "logout"]);
    expect(&r, 0);
    assert!(r.stdout.contains("no saved key"));
    let r = run(sb.grad(None), &["--profile", "nope", "models", "list"]);
    expect(&r, 2);
    assert!(
        r.stderr.contains("grad login --profile nope"),
        "{}",
        r.stderr
    );
}

// ---------------------------------------------------------------- errors & exit codes

#[test]
fn api_errors_map_to_exit_codes_and_json_envelopes() {
    let srv = MockServer::start(|r| match r.path() {
        "/v1/runs/missing" => Reply::problem(404, "run_not_found", "Run 'missing' not found."),
        "/v1/runs" => Reply::json(200, json!({"data": [], "next_cursor": null})),
        "/v1/artifacts/missing%40latest" => Reply::problem(
            404,
            "artifact_not_found",
            "Artifact 'missing@latest' not found.",
        ),
        "/v1/evals" => Reply::problem(501, "inference_unavailable", "No inference endpoint."),
        "/v1/keys" => Reply::problem(403, "insufficient_scope", "This key lacks the admin scope."),
        "/v1/runs/plan" => Reply::problem(
            422,
            "router_candidates_required",
            "Router training needs at least two candidate models.",
        ),
        "/v1/runs/run_9" => Reply::json(200, run_obj("run_9", "n", "stopped_budget")),
        "/v1/runs/run_9/resume" => {
            Reply::problem(409, "run_not_resumable", "Raise max_cost_usd to resume.")
        }
        "/v1/base-models" => Reply::problem(503, "store_unavailable", "Database down."),
        _ => Reply::problem(404, "not_found", "nope"),
    });
    let sb = Sandbox::new("errors");
    let u = Some(srv.url.as_str());
    let r = run(
        sb.grad(u),
        &["--json", "artifacts", "inspect", "missing@latest"],
    );
    expect(&r, 4);
    assert!(r.stdout.is_empty());
    let env = r.err_json();
    snapshot("error_not_found", &normalize(&env, &srv.url, &sb.dir));
    let r = run(sb.grad(u), &["artifacts", "inspect", "missing@latest"]);
    expect(&r, 4);
    assert!(r.stderr.starts_with("error: GET "), "{}", r.stderr);
    assert!(r.stderr.contains("req_mock"));
    // Runs resolve by id, then by name.
    let r = run(sb.grad(u), &["--json", "runs", "inspect", "missing"]);
    expect(&r, 4);
    assert_eq!(r.err_json()["error"]["code"], "run_not_found");
    assert!(r.err_json()["error"]["hint"]
        .as_str()
        .unwrap()
        .contains("grad runs list"));

    // Deploying is Gradiated Cloud's (its Models API), not a grad command.
    let r = run(sb.grad(u), &["deploy", "x@latest"]);
    expect(&r, 2);
    let r = run(sb.grad(u), &["eval", "--models", "a", "--dataset", "d"]);
    expect(&r, 6);
    assert!(r.stderr.contains("INFERENCE_BASE_URL"));
    let r = run(
        sb.grad(u),
        &["keys", "create", "--name", "k", "--scopes", "admin"],
    );
    expect(&r, 3);
    let r = run(
        sb.grad(u),
        &[
            "train",
            "--dataset",
            "d",
            "--name",
            "n",
            "--recipe",
            "router",
            "--dry-run",
        ],
    );
    expect(&r, 5);
    let r = run(sb.grad(u), &["runs", "resume", "run_9"]);
    expect(&r, 5);
    let r = run(sb.grad(u), &["--json", "models", "list"]);
    expect(&r, 1);
    assert_eq!(r.err_json()["error"]["status"], 503);
    assert_eq!(srv.count("GET", "/v1/base-models"), 3, "GETs are retried");

    // Connection refused: exit 1, names the URL and the cause, no "[0] network_error".
    let r = run(sb.grad(Some("http://127.0.0.1:9")), &["models", "list"]);
    expect(&r, 1);
    assert!(
        r.stderr.contains("http://127.0.0.1:9") && r.stderr.contains("/v1/base-models"),
        "{}",
        r.stderr
    );
    assert!(r.stderr.to_lowercase().contains("refused"), "{}", r.stderr);
    assert!(!r.stderr.contains("network_error"));
}

#[test]
fn global_flags_work_after_the_subcommand() {
    let srv = api();
    let sb = Sandbox::new("global");
    let r = run(
        sb.grad(None),
        &[
            "models",
            "list",
            "--base-url",
            &srv.url,
            "--api-key",
            "grad_flag_key",
            "--json",
        ],
    );
    expect(&r, 0);
    assert_eq!(r.json()["ok"], true);
    assert_eq!(
        srv.last("GET", "/v1/base-models")
            .unwrap()
            .header("authorization"),
        Some("Bearer grad_flag_key")
    );
    snapshot("models_list", &normalize(&r.json(), &srv.url, &sb.dir));
    let r = run(
        sb.grad(Some(&srv.url)),
        &["models", "list", "--recipe", "embedding"],
    );
    expect(&r, 0);
    assert!(
        r.stdout.contains("baai/bge-small-en-v1.5") && !r.stdout.contains("qwen3-0.6b"),
        "{}",
        r.stdout
    );
    assert!(r.stdout.starts_with("ID"), "human table: {}", r.stdout);
}

// ---------------------------------------------------------------- train & runs

#[test]
fn train_dry_run_prints_the_plan_and_sends_the_recipe() {
    let srv = api();
    let sb = Sandbox::new("dryrun");
    let u = Some(srv.url.as_str());
    let r = run(
        sb.grad(u),
        &[
            "train",
            "--dataset",
            "support-prod",
            "--name",
            "support-router",
            "--recipe",
            "router",
            "--dry-run",
        ],
    );
    expect(&r, 0);
    for needle in [
        "Plan for support-router",
        "4,820 usable",
        "4,097 train / 723 eval",
        "~1.1M",
        "$0.17",
        "~2m20s on one GPU (needs 24 GB of GPU memory)",
        "breakdown : train $0.15 · teacher $0.00 · evals $0.02 (held-out evals during training aren't billed)",
        "3 records have no scores",
    ] {
        assert!(
            r.stdout.contains(needle),
            "missing {:?}:\n{}",
            needle,
            r.stdout
        );
    }
    let body = srv.last("POST", "/v1/runs/plan").unwrap().json();
    assert_eq!(
        body,
        json!({"dataset": "support-prod", "name": "support-router", "recipe": {"kind": "router"}})
    );

    let r = run(
        sb.grad(u),
        &[
            "train",
            "--dataset",
            "t",
            "--name",
            "t",
            "--recipe",
            "decision-model",
            "--max-cost-usd",
            "20",
            "--dry-run",
            "--json",
        ],
    );
    expect(&r, 0);
    snapshot("train_dry_run", &normalize(&r.json(), &srv.url, &sb.dir));
    let body = srv.last("POST", "/v1/runs/plan").unwrap().json();
    assert_eq!(body["recipe"]["kind"], "decision");
    assert_eq!(body["max_cost_usd"], 20.0);

    std::fs::write(sb.path("docs.md"), "API docs").unwrap();
    std::fs::write(
        sb.path("recipe.yaml"),
        "dataset: api-docs\nname: api-docs-cartridge\nrecipe: cartridge\nmodel: qwen/qwen3-8b\ncontext:\n  file: ./docs.md\n",
    )
    .unwrap();
    let r = run(
        sb.grad(u),
        &[
            "train",
            "-f",
            "recipe.yaml",
            "--dry-run",
            "--set",
            "num_tokens=128",
        ],
    );
    expect(&r, 0);
    let body = srv.last("POST", "/v1/runs/plan").unwrap().json();
    assert_eq!(
        body["recipe"],
        json!({"kind": "cartridge", "model": "qwen/qwen3-8b", "context_text": "API docs", "num_tokens": 128})
    );
    std::fs::write(
        sb.path("bad.yaml"),
        "dataset: d\nname: n\nrecipe: sft\nlerning_rate: 1\n",
    )
    .unwrap();
    let r = run(sb.grad(u), &["train", "-f", "bad.yaml", "--dry-run"]);
    expect(&r, 2);
    assert!(r.stderr.contains("lerning_rate"));
}

#[test]
fn train_distill_and_reward_flags_and_teacher_costs() {
    let srv = MockServer::start(|r| match r.path() {
        "/v1/runs/plan" => {
            let mut plan = plan_obj();
            plan["teacher"] = json!({"model": "qwen/qwen3-32b", "price_per_million_tokens": 1.2,
                "estimated_tokens": 2_500_000, "estimated_cost_usd": 3.0});
            plan["labeling"] = json!({"estimated_model_calls": 1200, "estimated_judge_calls": 0,
                "estimated_cost_usd": 0.42});
            Reply::json(200, plan)
        }
        _ => Reply::problem(404, "not_found", "nope"),
    });
    let sb = Sandbox::new("distill");
    let u = Some(srv.url.as_str());
    let r = run(
        sb.grad(u),
        &[
            "train",
            "--dataset",
            "support-prompts",
            "--name",
            "d",
            "--recipe",
            "distill",
            "--model",
            "qwen/qwen3-4b",
            "--teacher",
            "qwen/qwen3-32b",
            "--rollout",
            "off-policy",
            "--max-new-tokens",
            "64",
            "--dry-run",
        ],
    );
    expect(&r, 0);
    for needle in [
        "teacher   : qwen/qwen3-32b: ~2.5M tokens, $3.00",
        "1,200 model + 0 judge calls, $0.42",
    ] {
        assert!(
            r.stdout.contains(needle),
            "missing {:?}:\n{}",
            needle,
            r.stdout
        );
    }
    let body = srv.last("POST", "/v1/runs/plan").unwrap().json();
    assert_eq!(
        body["recipe"],
        json!({"kind": "distill", "model": "qwen/qwen3-4b", "teacher": "qwen/qwen3-32b",
            "rollout": {"kind": "off_policy", "max_new_tokens": 64}})
    );
    let r = run(
        sb.grad(u),
        &[
            "train",
            "--dataset",
            "sql-preferences",
            "--name",
            "v",
            "--recipe",
            "reward-model",
            "--score",
            "resolved",
            "--dry-run",
        ],
    );
    expect(&r, 0);
    let body = srv.last("POST", "/v1/runs/plan").unwrap().json();
    assert_eq!(
        body["recipe"],
        json!({"kind": "reward", "rubric": "resolved"})
    );
    let r = run(
        sb.grad(u),
        &[
            "train",
            "--dataset",
            "d",
            "--name",
            "n",
            "--recipe",
            "distill",
            "--max-new-tokens",
            "5",
        ],
    );
    expect(&r, 2);
}

#[test]
fn train_wait_streams_metrics_and_prints_the_readout() {
    let srv = api();
    let sb = Sandbox::new("wait");
    let r = run(
        sb.grad(Some(&srv.url)),
        &[
            "train",
            "--dataset",
            "support-prod",
            "--name",
            "support-router",
            "--recipe",
            "router",
            "--wait",
        ],
    );
    expect(&r, 0);
    for needle in [
        "✓ Dataset support-prod: 4,820 records",
        "✓ Split: 4,097 train / 723 eval (by session)",
        "Waiting for a GPU (0 workers online)",
        "▸ Starting on NVIDIA H100 80GB HBM3 (80 GB)",
        "▸ Training",
        "⚠ attempt 1 interrupted at step 1: the GPU was reclaimed; resuming from step 1 on a new worker",
        "⚠ wandb logger disabled",
        "step     2/2",
        "eval 0.4",
        "✓ Trained qwen/qwen3-0.6b router in 42s (~1.1M tokens",
        "Eval report:",
        "fallback quality",
        "! small eval split",
        "✓ Exported artifact support-router@2026-11-26-1",
        "Next: grad artifacts download support-router@2026-11-26-1 --output ./support-router",
    ] {
        assert!(
            r.stdout.contains(needle),
            "missing {:?}:\n{}",
            needle,
            r.stdout
        );
    }
    let r = run(
        sb.grad(Some(&srv.url)),
        &[
            "--json",
            "train",
            "--dataset",
            "support-prod",
            "--name",
            "support-router",
            "--recipe",
            "router",
            "--wait",
        ],
    );
    expect(&r, 0);
    let j = r.json();
    assert_eq!(j["data"]["run"]["status"], "completed");
    assert_eq!(j["data"]["artifact"]["version"], "2026-11-26-1");
    // Without --wait: the run id and how to follow it.
    let r = run(
        sb.grad(Some(&srv.url)),
        &[
            "train",
            "--dataset",
            "support-prod",
            "--name",
            "support-router",
            "--recipe",
            "router",
        ],
    );
    expect(&r, 0);
    assert!(r.stdout.contains("grad runs logs run_1 --follow"));
}

fn failing_server(status: &'static str) -> MockServer {
    MockServer::start(move |r| match (r.method.as_str(), r.path()) {
        ("POST", "/v1/runs") => Reply::json(202, run_obj("run_f", "n", "queued")),
        ("GET", "/v1/runs/run_f/events") => Reply::Stream {
            status: 200,
            headers: vec![("content-type".into(), "text/event-stream".into())],
            chunks: vec![(
                Duration::ZERO,
                sse_body(&[
                    metric_ev("run_f", 1, 1),
                    completed_ev("run_f", 1, run_obj("run_f", "n", status)),
                ]),
            )],
        },
        ("GET", "/v1/datasets/d") => Reply::problem(404, "dataset_not_found", "x"),
        _ => Reply::problem(404, "not_found", "x"),
    })
}

#[test]
fn unsuccessful_runs_exit_7_with_a_next_step() {
    let sb = Sandbox::new("runfail");
    for (status, needle) in [
        ("failed", "CUDA OOM"),
        ("stopped_budget", "grad runs resume run_f --max-cost-usd"),
        ("cancelled", "grad runs resume run_f"),
    ] {
        let srv = failing_server(status);
        let r = run(
            sb.grad(Some(&srv.url)),
            &[
                "train",
                "--dataset",
                "d",
                "--name",
                "n",
                "--recipe",
                "sft",
                "--wait",
            ],
        );
        expect(&r, 7);
        assert!(r.stderr.contains(needle), "{}: {}", status, r.stderr);
        let r = run(
            sb.grad(Some(&srv.url)),
            &[
                "--json",
                "train",
                "--dataset",
                "d",
                "--name",
                "n",
                "--recipe",
                "sft",
                "--wait",
            ],
        );
        expect(&r, 7);
        let e = r.err_json();
        assert_eq!(e["error"]["code"], format!("run_{}", status));
        assert_eq!(e["error"]["details"]["id"], "run_f");
    }
}

#[test]
fn runs_commands() {
    let srv = api();
    let sb = Sandbox::new("runs");
    let u = Some(srv.url.as_str());
    let r = run(sb.grad(u), &["runs", "list"]);
    expect(&r, 0);
    assert!(r.stdout.contains("run_1") && r.stdout.contains("support-router"));
    // By name: falls back to a list lookup.
    let r = run(sb.grad(u), &["runs", "inspect", "support-router"]);
    expect(&r, 0);
    assert!(
        r.stdout.contains("status") && r.stdout.contains("completed"),
        "{}",
        r.stdout
    );
    let r = run(sb.grad(u), &["runs", "inspect", "run_1", "--yaml"]);
    expect(&r, 0);
    assert!(
        r.stdout.contains("recipe: router") && r.stdout.contains("dataset: support-prod"),
        "{}",
        r.stdout
    );
    std::fs::write(sb.path("exported.yaml"), &r.stdout).unwrap();
    let r = run(sb.grad(u), &["train", "-f", "exported.yaml", "--dry-run"]);
    expect(&r, 0);
    let body = srv.last("POST", "/v1/runs/plan").unwrap().json();
    assert_eq!(
        body["recipe"]["models"],
        json!(["qwen/qwen3-8b", "qwen/qwen3-32b"])
    );
    assert_eq!(body["split"]["eval_fraction"], 0.15);

    let r = run(sb.grad(u), &["runs", "logs", "run_1"]);
    expect(&r, 0);
    assert!(r.stdout.contains("STEP") && r.stdout.contains("0.4"));
    let r = run(sb.grad(u), &["runs", "logs", "run_1", "--follow"]);
    expect(&r, 0);
    assert_eq!(r.stdout.lines().count(), 3, "{}", r.stdout);
    let r = run(sb.grad(u), &["--json", "runs", "logs", "run_1", "--follow"]);
    expect(&r, 0);
    assert_eq!(r.json()["data"]["metrics"].as_array().unwrap().len(), 2);
    let r = run(sb.grad(u), &["runs", "events", "run_1", "--limit", "50"]);
    expect(&r, 0);
    for needle in [
        "SEQ  ATTEMPT  TYPE  DETAIL",
        "queued: Waiting for a GPU (2 workers online, all busy)",
        "starting on NVIDIA L4 (22 GB)",
        "training at step 0",
        "step 2 loss 0.5 eval 0.4",
        "step 2 ckpt_2 score 0.4",
        "6  1  log  uploaded",
        "completed  completed",
    ] {
        assert!(
            r.stdout.contains(needle),
            "missing {:?}:\n{}",
            needle,
            r.stdout
        );
    }
    assert!(srv
        .last("GET", "/v1/runs/run_1/events")
        .unwrap()
        .query()
        .contains("limit=50"));
    let r = run(sb.grad(u), &["runs", "events", "run_1", "--limit", "0"]);
    expect(&r, 2);
    let r = run(
        sb.grad(u),
        &["--json", "runs", "events", "support-router", "--follow"],
    );
    // A name resolves to its run.
    expect(&r, 0);
    assert_eq!(r.json()["data"]["run_id"], "run_1");
    let r = run(
        sb.grad(u),
        &["--json", "runs", "events", "run_1", "--follow"],
    );
    expect(&r, 0);
    let events = r.json()["data"]["events"].as_array().unwrap().clone();
    assert_eq!(events.first().unwrap()["phase"], "waiting_for_compute");
    assert_eq!(events.last().unwrap()["type"], "completed");
    let r = run(sb.grad(u), &["runs", "wait", "run_1"]);
    expect(&r, 0);
    assert!(r.stdout.contains("Next: grad artifacts download"));
    // Off a terminal `runs watch` is `runs wait`; GRAD_NO_TUI takes 1/0/true/false.
    for v in ["1", "0", "true", ""] {
        let mut c = sb.grad(u);
        c.env("GRAD_NO_TUI", v);
        let w = run(c, &["runs", "watch", "run_1"]);
        expect(&w, 0);
        assert_eq!(w.stdout, r.stdout, "GRAD_NO_TUI={}", v);
    }
    let w = run(sb.grad(u), &["--plain", "runs", "watch", "run_1"]);
    expect(&w, 0);
    assert_eq!(w.stdout, r.stdout);
    let r = run(sb.grad(u), &["runs", "cancel", "run_1"]);
    expect(&r, 0);
    assert!(r.stdout.contains("cancelled"));
    let r = run(
        sb.grad(u),
        &["runs", "resume", "run_1", "--max-cost-usd", "5"],
    );
    expect(&r, 0);
    assert_eq!(
        srv.last("POST", "/v1/runs/run_1/resume").unwrap().json(),
        json!({"max_cost_usd": 5.0})
    );
    let r = run(
        sb.grad(u),
        &["runs", "resume", "run_1", "--max-cost-usd", "-5"],
    );
    expect(&r, 2);
    let r = run(sb.grad(u), &["runs", "checkpoints", "run_1"]);
    expect(&r, 0);
    assert!(r.stdout.contains("ckpt_1"));
    let r = run(
        sb.grad(u),
        &["runs", "promote", "ckpt_1", "--name", "support-router"],
    );
    expect(&r, 0);
    assert!(r.stdout.contains("support-router@2026-11-26-1"));
    let r = run(sb.grad(u), &["runs", "inspect", "run_404"]);
    expect(&r, 4);
}

#[test]
fn reimporting_the_same_file_says_nothing_new_was_added() {
    let srv = MockServer::start(|r| match (r.method.as_str(), r.path()) {
        ("POST", p) if p.ends_with("/imports") => Reply::json(
            200,
            json!({"id": "imp_old", "dataset": "support-prod", "status": "completed", "connector": "auto",
                   "imported_count": 80, "dropped_count": 0, "dataset_version": 2, "detected_scores": [],
                   "drop_reasons": [], "created_at": "2026-11-26T10:00:00.000Z", "updated_at": "2026-11-26T10:00:00.000Z"}),
        ),
        ("GET", "/v1/imports/imp_old") => Reply::json(
            200,
            json!({"id": "imp_old", "dataset": "support-prod", "status": "completed", "connector": "auto",
                   "imported_count": 80, "dropped_count": 0, "dataset_version": 2, "detected_scores": [],
                   "drop_reasons": [], "created_at": "2026-11-26T10:00:00.000Z", "updated_at": "2026-11-26T10:00:00.000Z"}),
        ),
        _ => handler(r),
    });
    let sb = Sandbox::new("reimport");
    std::fs::write(sb.path("t.jsonl"), "{}\n").unwrap();
    let r = run(
        sb.grad(Some(&srv.url)),
        &["import", "./t.jsonl", "--dataset", "support-prod"],
    );
    expect(&r, 0);
    assert!(
        r.stderr.contains("already imported into support-prod as version 2 (import imp_old); nothing new was added"),
        "{}",
        r.stderr
    );
}

#[test]
fn cancel_and_resume_by_name_never_pick_one_of_several_runs() {
    let srv = MockServer::start(|r| match (r.method.as_str(), r.path()) {
        ("GET", "/v1/runs") => Reply::json(
            200,
            json!({"data": [
                run_obj("run_new", "dup", "queued"),
                run_obj("run_old", "dup", "running"),
                run_obj("run_done", "dup", "completed"),
                run_obj("run_solo", "solo", "running"),
                run_obj("run_s1", "stopped", "stopped_budget"),
                run_obj("run_s2", "stopped", "cancelled"),
            ], "next_cursor": null}),
        ),
        ("GET", p) if p.starts_with("/v1/runs/run_") => {
            let id = p.trim_start_matches("/v1/runs/");
            Reply::json(200, run_obj(id, "x", "running"))
        }
        ("GET", _) => Reply::problem(404, "run_not_found", "no such run"),
        ("POST", p) if p.ends_with("/cancel") => {
            let id = p.split('/').nth(3).unwrap();
            Reply::json(200, run_obj(id, "dup", "cancelled"))
        }
        ("POST", p) if p.ends_with("/resume") => {
            let id = p.split('/').nth(3).unwrap();
            Reply::json(200, run_obj(id, "stopped", "queued"))
        }
        _ => Reply::problem(404, "not_found", "no route"),
    });
    let sb = Sandbox::new("ambiguous");
    let u = Some(srv.url.as_str());
    let r = run(sb.grad(u), &["--json", "runs", "cancel", "dup"]);
    expect(&r, 5);
    let e = r.err_json();
    assert_eq!(e["error"]["code"], "ambiguous_run_name");
    let msg = e["error"]["message"].as_str().unwrap();
    assert!(
        msg.contains("run_new") && msg.contains("run_old"),
        "{}",
        msg
    );
    assert!(!msg.contains("run_done"), "{}", msg);
    assert!(srv.last("POST", "/v1/runs/run_new/cancel").is_none());
    let r = run(sb.grad(u), &["runs", "cancel", "dup", "--latest"]);
    expect(&r, 0);
    assert!(srv.last("POST", "/v1/runs/run_new/cancel").is_some());
    // One active run with the name is unambiguous.
    expect(&run(sb.grad(u), &["runs", "cancel", "solo"]), 0);
    assert!(srv.last("POST", "/v1/runs/run_solo/cancel").is_some());
    let r = run(
        sb.grad(u),
        &["runs", "resume", "stopped", "--max-cost-usd", "5"],
    );
    expect(&r, 5);
    assert!(
        r.stderr.contains("run_s1") && r.stderr.contains("run_s2"),
        "{}",
        r.stderr
    );
    let r = run(sb.grad(u), &["runs", "resume", "run_s2"]);
    expect(&r, 0);
    assert!(r.stdout.contains("next attempt"), "{}", r.stdout);
}

#[test]
fn a_name_several_runs_share_shows_the_newest_and_says_so() {
    let dup = "run support-sft is already running (run_old); this starts a second one.";
    let srv = MockServer::start(move |r| match (r.method.as_str(), r.path()) {
        ("GET", "/v1/runs") => Reply::json(
            200,
            json!({"data": [
                run_obj("run_new", "dup", "queued"),
                run_obj("run_old", "dup", "completed"),
                run_obj("run_solo", "solo", "running"),
            ], "next_cursor": null}),
        ),
        ("GET", "/v1/runs/run_new/checkpoints") => {
            Reply::json(200, json!({"data": [], "next_cursor": null}))
        }
        ("GET", _) => Reply::problem(404, "run_not_found", "no such run"),
        ("POST", "/v1/runs") => {
            let mut run = run_obj("run_2", "support-sft", "queued");
            run["warnings"] = json!([dup]);
            Reply::json(202, run)
        }
        _ => Reply::problem(404, "not_found", "no route"),
    });
    let sb = Sandbox::new("dup-names");
    let u = Some(srv.url.as_str());
    let note = "2 runs match 'dup'; showing the newest (run_new). Pass a run id to choose.";
    for args in [
        &["runs", "inspect", "dup"][..],
        &["runs", "checkpoints", "dup"][..],
    ] {
        let r = run(sb.grad(u), args);
        expect(&r, 0);
        assert!(r.stderr.contains(note), "{:?}: {}", args, r.stderr);
    }
    assert!(srv.last("GET", "/v1/runs/run_new/checkpoints").is_some());
    let r = run(sb.grad(u), &["--json", "runs", "inspect", "dup"]);
    expect(&r, 0);
    let j = r.json();
    assert_eq!(j["data"]["id"], "run_new");
    assert_eq!(j["warnings"], json!([note]));
    // One run with the name: nothing to say.
    let r = run(sb.grad(u), &["--json", "runs", "inspect", "solo"]);
    expect(&r, 0);
    assert!(r.json().get("warnings").is_none());

    // grad train warns about a queued or running run with the same name, but starts it.
    let r = run(
        sb.grad(u),
        &[
            "train",
            "--dataset",
            "support",
            "--name",
            "support-sft",
            "--recipe",
            "sft",
        ],
    );
    expect(&r, 0);
    assert!(
        r.stderr.contains(&format!("warning: {}", dup)),
        "{}",
        r.stderr
    );
    assert!(r.stdout.contains("Started run run_2"), "{}", r.stdout);
    let r = run(
        sb.grad(u),
        &[
            "--json",
            "train",
            "--dataset",
            "support",
            "--name",
            "support-sft",
            "--recipe",
            "sft",
        ],
    );
    expect(&r, 0);
    assert_eq!(r.json()["warnings"], json!([dup]));
}

// ---------------------------------------------------------------- data

#[test]
fn import_uploads_streams_and_waits() {
    let srv = api();
    let sb = Sandbox::new("import");
    let content = "{\"messages\": []}\n".repeat(100);
    std::fs::write(sb.path("support_traces.jsonl"), &content).unwrap();
    let r = run(
        sb.grad(Some(&srv.url)),
        &[
            "import",
            "./support_traces.jsonl",
            "--dataset",
            "support-prod",
        ],
    );
    expect(&r, 0);
    assert!(
        r.stdout.contains("imported 4,820 records, dropped 2"),
        "{}",
        r.stdout
    );
    assert!(r.stdout.contains("line 7: invalid JSON"));
    let put = srv.last("PUT", "/blobs/uploads/up_1").unwrap();
    assert_eq!(put.body, content.as_bytes());
    assert!(put.header("authorization").is_none());
    let r = run(
        sb.grad(Some(&srv.url)),
        &[
            "import",
            "./support_traces.jsonl",
            "--format",
            "otel",
            "--dataset",
            "support-prod",
            "--json",
            "--no-wait",
        ],
    );
    expect(&r, 0);
    assert_eq!(r.json()["data"]["status"], "queued");
    let imp = srv
        .last("POST", "/v1/datasets/support-prod/imports")
        .unwrap()
        .json();
    assert_eq!(imp["connector"], "otel");
    assert!(imp["source"].get("format").is_none());
    let r = run(
        sb.grad(Some(&srv.url)),
        &["import", "./missing.jsonl", "--dataset", "x"],
    );
    expect(&r, 2);
    let r = run(sb.grad(Some(&srv.url)), &["imports", "list"]);
    expect(&r, 0);
    let r = run(sb.grad(Some(&srv.url)), &["imports", "status", "imp_1"]);
    expect(&r, 0);
    let r = run(sb.grad(Some(&srv.url)), &["imports", "wait", "imp_1"]);
    expect(&r, 0);
}

#[test]
fn datasets_commands() {
    let srv = api();
    let sb = Sandbox::new("datasets");
    let u = Some(srv.url.as_str());
    let mut s = String::new();
    for i in 0..2500 {
        s.push_str(&format!(
            "{{\"messages\": [{{\"role\": \"user\", \"content\": \"{}\"}}]}}\n",
            i
        ));
    }
    std::fs::write(sb.path("train.jsonl"), &s).unwrap();
    let r = run(
        sb.grad(u),
        &["datasets", "push", "support-sft", "./train.jsonl"],
    );
    expect(&r, 0);
    assert_eq!(
        srv.count("POST", "/v1/datasets/support-sft/records"),
        3,
        "2,500 records in 1,000-record batches"
    );
    std::fs::write(sb.path("bad.jsonl"), "{\"a\": 1}\nnot json\n").unwrap();
    let r = run(
        sb.grad(u),
        &["datasets", "push", "support-sft", "./bad.jsonl"],
    );
    expect(&r, 2);
    assert!(r.stderr.contains("line 2"), "{}", r.stderr);
    let r = run(sb.grad(u), &["datasets", "list"]);
    expect(&r, 0);
    assert!(r.stdout.contains("4,820"));
    let r = run(sb.grad(u), &["datasets", "get", "support-prod"]);
    expect(&r, 0);
    let r = run(sb.grad(u), &["datasets", "create", "new-ds"]);
    expect(&r, 0);
    let r = run(
        sb.grad(u),
        &["datasets", "records", "support-prod", "--limit", "1"],
    );
    expect(&r, 0);
    assert!(r.stdout.contains("rec_1"));
    assert!(srv
        .last("GET", "/v1/datasets/support-prod/records")
        .unwrap()
        .query()
        .contains("limit=1"));
    let r = run(
        sb.grad(u),
        &[
            "render",
            "support-sft",
            "--model",
            "qwen/qwen3-8b",
            "--limit",
            "3",
        ],
    );
    expect(&r, 0);
    assert!(r.stdout.contains("TRAIN │ hello"), "{}", r.stdout);
    let r = run(sb.grad(u), &["render", "support-sft", "--thinking", "off"]);
    expect(&r, 0);
    assert_eq!(
        srv.last("POST", "/v1/datasets/support-sft/render")
            .unwrap()
            .json()["thinking"],
        "off"
    );
    let r = run(sb.grad(u), &["render", "support-sft", "--limit", "99"]);
    expect(&r, 2);
    let r = run(
        sb.grad(u),
        &[
            "datasets",
            "import",
            "hf",
            "HuggingFaceH4/ultrachat_200k",
            "--split",
            "train_sft",
            "--limit",
            "2000",
            "--name",
            "ultrachat",
            "--column",
            "messages=messages",
            "--no-wait",
        ],
    );
    expect(&r, 0);
    let body = srv
        .last("POST", "/v1/datasets/ultrachat/imports")
        .unwrap()
        .json();
    assert_eq!(
        body,
        json!({"source": {"kind": "hf", "repo": "HuggingFaceH4/ultrachat_200k", "split": "train_sft", "columns": {"messages": "messages"}, "limit": 2000}})
    );
    let r = run(
        sb.grad(u),
        &["datasets", "import", "hf", "o/r", "--column", "nope=x"],
    );
    expect(&r, 2);
}

// ---------------------------------------------------------------- secrets & sources

fn source_obj() -> Value {
    json!({
        "id": "src_01J9X", "workspace_id": "ws", "dataset": "support-prod",
        "provider": {"kind": "langfuse", "host": "https://cloud.langfuse.com",
                     "secret": "langfuse-prod", "project": null, "filters": {}},
        "schedule": "*/15 * * * *", "next_sync_at": "2026-11-27T12:15:00.000Z",
        "last_synced_at": "2026-11-27T12:00:41.000Z",
        "last_sync": {"import_id": "imp_7c1d", "status": "completed", "full": false,
                      "dataset_version": 3, "error": null,
                      "created_at": "2026-11-27T12:00:00.000Z", "finished_at": "2026-11-27T12:00:41.000Z"},
        "created_at": "2026-11-27T11:00:00.000Z", "updated_at": "2026-11-27T12:00:41.000Z"
    })
}

fn sources_api() -> MockServer {
    let polls = Arc::new(AtomicUsize::new(0));
    MockServer::start(move |r| {
        let secret = json!({"name": "langfuse-prod", "workspace_id": "ws",
                            "allowed_hosts": ["cloud.langfuse.com"],
                            "created_at": "2026-11-27T11:00:00.000Z", "updated_at": "2026-11-27T11:00:00.000Z"});
        let job = |status: &str| {
            json!({"id": "imp_7c1d", "dataset": "support-prod", "status": status,
                                        "connector": "auto", "imported_count": 4, "dropped_count": 0,
                                        "dataset_version": 3, "source": {"kind": "provider"}})
        };
        match (r.method.as_str(), r.path()) {
            ("POST", "/v1/secrets") => Reply::json(200, secret),
            ("GET", "/v1/secrets") => {
                Reply::json(200, json!({"data": [secret], "next_cursor": null}))
            }
            ("DELETE", "/v1/secrets/langfuse-prod") => Reply::bytes(204, vec![], vec![]),
            ("DELETE", "/v1/secrets/used") => Reply::problem(
                409,
                "secret_in_use",
                "Secret 'used' is used by source src_1.",
            ),
            ("POST", "/v1/datasets/support-prod/sources") => Reply::json(201, source_obj()),
            ("POST", "/v1/datasets/manual/sources") => {
                let mut s = source_obj();
                s["schedule"] = Value::Null;
                s["last_sync"] = Value::Null;
                Reply::json(201, s)
            }
            ("POST", "/v1/datasets/self-hosted/sources") => Reply::problem(
                501,
                "source_unavailable",
                "The 'gradiated' source is only available on Gradiated Cloud.",
            ),
            ("GET", "/v1/sources") => {
                let mut paused = source_obj();
                paused["id"] = json!("src_paused");
                paused["status"] = json!("paused");
                paused["consecutive_failures"] = json!(10);
                paused["paused_reason"] = json!("10 syncs in a row failed.");
                paused["last_error"] = json!("langfuse: 401 Unauthorized (auth failed for ***)");
                let mut failing = source_obj();
                failing["id"] = json!("src_failing");
                failing["consecutive_failures"] = json!(2);
                failing["last_error"] = json!("x".repeat(80));
                Reply::json(
                    200,
                    json!({"data": [source_obj(), paused, failing], "next_cursor": null}),
                )
            }
            ("POST", "/v1/sources/src_01J9X/sync") => Reply::json(202, job("queued")),
            ("POST", "/v1/sources/src_recent/sync") => Reply::json(202, job("completed")),
            ("POST", "/v1/sources/src_busy/sync") => Reply::json(202, job("running")),
            ("GET", "/v1/imports/imp_7c1d") => {
                let n = polls.fetch_add(1, Ordering::SeqCst);
                Reply::json(200, job(if n == 0 { "running" } else { "completed" }))
            }
            ("DELETE", "/v1/sources/src_01J9X") => Reply::bytes(204, vec![], vec![]),
            ("GET", "/v1/sources/src_01J9X") | ("PATCH", "/v1/sources/src_01J9X") => {
                let mut s = source_obj();
                s["provider"]["filters"] =
                    json!({"environment": ["production"], "min_score": {"helpfulness": 0.8}});
                s["sample_rate"] = json!(0.1);
                s["max_records_per_day"] = json!(100000);
                s["records_today"] = json!(4200);
                s["version_interval"] = json!(900);
                s["pending_records"] = json!(120);
                Reply::json(200, s)
            }
            ("PATCH", "/v1/sources/src_bad") => Reply::problem(
                422,
                "source_filter_unsupported",
                "The langfuse source has no filter 'tag'.",
            ),
            _ => Reply::problem(404, "not_found", "nope"),
        }
    })
}

#[test]
fn sources_show_and_update_print_the_effective_filters() {
    let srv = sources_api();
    let sb = Sandbox::new("sources-update");
    let u = Some(srv.url.as_str());

    let r = run(sb.grad(u), &["sources", "show", "src_01J9X"]);
    expect(&r, 0);
    for want in [
        r#"environment=["production"] · min_score={"helpfulness":0.8} · 10% sampled · ≤100000/day"#,
        "4200 of 100000 new traces",
        "at most every 900s; 120 records wait for the next",
        "completed (v3)",
    ] {
        assert!(r.stdout.contains(want), "{}", r.stdout);
    }
    let r = run(sb.grad(u), &["sources", "list"]);
    expect(&r, 0);
    assert!(r.stdout.contains("FILTERS"), "{}", r.stdout);

    let r = run(
        sb.grad(u),
        &[
            "sources",
            "update",
            "src_01J9X",
            "--clear-filters",
            "--no-schedule",
            "--max-records-per-day",
            "0",
            "--sample-rate",
            "0.5",
        ],
    );
    expect(&r, 0);
    assert!(
        r.stdout.contains("Updated source src_01J9X"),
        "{}",
        r.stdout
    );
    assert_eq!(
        srv.last("PATCH", "/v1/sources/src_01J9X").unwrap().json(),
        json!({"filters": {}, "schedule": null, "sample_rate": 0.5, "max_records_per_day": null})
    );
    let r = run(sb.grad(u), &["sources", "update", "src_01J9X"]);
    expect(&r, 2);
    assert!(r.stderr.contains("nothing to change"), "{}", r.stderr);
    let r = run(
        sb.grad(u),
        &["sources", "update", "src_bad", "--filter", "tag=prod"],
    );
    expect(&r, 5);
    assert!(r.stderr.contains("no filter 'tag'"), "{}", r.stderr);
}

#[test]
fn secrets_set_reads_stdin_and_never_prints_the_value() {
    let srv = sources_api();
    let sb = Sandbox::new("secrets");
    let u = Some(srv.url.as_str());
    let value = "pk-lf-123:sk-lf-very-secret";

    for json_mode in [false, true] {
        let mut args = vec!["secrets", "set", "langfuse-prod"];
        if json_mode {
            args.push("--json");
        }
        let r = run_stdin(sb.grad(u), &args, &format!("{}\n", value));
        expect(&r, 0);
        assert!(
            !r.stdout.contains("sk-lf") && !r.stderr.contains("sk-lf"),
            "{}{}",
            r.stdout,
            r.stderr
        );
        let sent = srv.last("POST", "/v1/secrets").unwrap().json();
        assert_eq!(
            sent,
            json!({"name": "langfuse-prod", "value": value}),
            "one trailing newline is trimmed"
        );
        if json_mode {
            assert_eq!(r.json()["data"]["name"], "langfuse-prod");
        } else {
            assert!(
                r.stdout.contains("Saved secret langfuse-prod"),
                "{}",
                r.stdout
            );
        }
    }

    // A self-hosted tool's secret names the hosts it may be sent to.
    let r = run_stdin(
        sb.grad(u),
        &[
            "secrets",
            "set",
            "langfuse-prod",
            "--allowed-host",
            "langfuse.internal:3000",
            "--allowed-host",
            "lf2.internal",
        ],
        value,
    );
    expect(&r, 0);
    assert_eq!(
        srv.last("POST", "/v1/secrets").unwrap().json()["allowed_hosts"],
        json!(["langfuse.internal:3000", "lf2.internal"])
    );

    let before = srv.count("POST", "/v1/secrets");
    let r = run_stdin(sb.grad(u), &["secrets", "set", "empty"], "\n");
    expect(&r, 2);
    assert!(r.stderr.contains("no value"), "{}", r.stderr);
    let r = run_stdin(
        sb.grad(u),
        &["secrets", "set", "big"],
        &"x".repeat(17 * 1024),
    );
    expect(&r, 2);
    assert_eq!(
        srv.count("POST", "/v1/secrets"),
        before,
        "nothing sent for bad values"
    );

    let r = run(sb.grad(u), &["secrets", "list"]);
    expect(&r, 0);
    assert!(r.stdout.contains("langfuse-prod"));
    assert!(r.stdout.contains("cloud.langfuse.com"), "{}", r.stdout);
    let r = run(sb.grad(u), &["secrets", "delete", "langfuse-prod"]);
    expect(&r, 0);
    assert_eq!(srv.count("DELETE", "/v1/secrets/langfuse-prod"), 1);
    let r = run(sb.grad(u), &["secrets", "delete", "used", "--json"]);
    expect(&r, 5);
    assert_eq!(r.err_json()["error"]["code"], "secret_in_use");
}

fn usage_row(kind: &str, ref_id: &str, name: Option<&str>, tokens: u64) -> Value {
    json!({"id": "use_1", "kind": kind, "ref_id": ref_id, "ref_name": name, "run_id": null,
        "attempt": 2, "tokens_from": 0, "tokens_through": tokens, "tokens": tokens,
        "cost_usd": 0.000084, "price_version": "catalog@1", "idempotency_key": "k",
        "created_at": "2026-11-27T04:35:21.351Z"})
}

fn usage_api() -> MockServer {
    MockServer::start(|r| match r.path() {
        "/v1/usage/summary" => {
            let grouped = r.query().contains("group_by=day");
            let empty = r.query().contains("from=2025-01-01");
            Reply::json(
                200,
                json!({"from": "2026-11-01T00:00:00.000Z", "to": "2026-12-01T00:00:00.000Z",
                    "cost_usd": if empty { 0.0 } else { 12.5 }, "tokens": if empty { 0 } else { 2_400_000 },
                    "records": if empty { 0 } else { 7 },
                    "by_kind": [{"kind": "training", "cost_usd": 10.0, "tokens": 2_000_000, "records": 4},
                                {"kind": "labeling", "cost_usd": 2.5, "tokens": 400_000, "records": 3}],
                    "top_runs": [{"id": "run_abc", "name": "support-sft", "kind": "training", "cost_usd": 10.0, "tokens": 2_000_000}],
                    "top_evals": [{"id": "eval_lbl", "name": "support-router-labels", "kind": "labeling", "cost_usd": 2.5, "tokens": 400_000}],
                    "group_by": if grouped { json!("day") } else { Value::Null },
                    "groups": if grouped { json!([{"key": "2026-11-02", "cost_usd": 12.5, "tokens": 2_400_000, "records": 7}]) } else { json!([]) }}),
            )
        }
        "/v1/usage" => Reply::json(
            200,
            json!({"data": [usage_row("training", "run_abc", Some("support-sft"), 84),
                            usage_row("scoring", "eval_sc", None, 12)],
                   "next_cursor": if r.query().contains("limit=2") { json!("c2") } else { Value::Null }}),
        ),
        "/v1/runs" => Reply::json(
            200,
            json!({"data": [{"id": "run_new", "name": "support-sft", "status": "completed"},
                            {"id": "run_old", "name": "support-sft", "status": "completed"},
                            {"id": "run_other", "name": "other", "status": "completed"}],
                   "next_cursor": null}),
        ),
        "/v1/evals" => Reply::json(
            200,
            json!({"data": [{"id": "eval_new", "name": "nightly", "status": "completed"},
                            {"id": "eval_old", "name": "nightly", "status": "completed"},
                            {"id": "eval_one", "name": "weekly", "status": "completed"}], "next_cursor": null}),
        ),
        p if p.starts_with("/v1/runs/") => Reply::json(
            404,
            json!({"type": "about:blank", "title": "Not Found", "status": 404, "code": "not_found", "detail": "no such run"}),
        ),
        other => panic!("unexpected {}", other),
    })
}

#[test]
fn usage_summary_breaks_down_the_period() {
    let srv = usage_api();
    let sb = Sandbox::new("usage");
    let r = run(sb.grad(Some(&srv.url)), &["usage"]);
    expect(&r, 0);
    assert_eq!(srv.last("GET", "/v1/usage/summary").unwrap().query(), "");
    for want in [
        "Usage 2026-11-01 00:00 to 2026-12-01 00:00 UTC: $12.50 · 2,400,000 tokens · 7 billed rows",
        "KIND      COST    TOKENS     ROWS",
        "training  $10.00  2,000,000  4",
        "Top runs",
        "support-sft  run_abc  training  $10.00  2,000,000",
        "Top evals",
        "support-router-labels  eval_lbl  labeling  $2.50  400,000",
    ] {
        assert!(
            r.stdout.contains(want),
            "missing {:?} in\n{}",
            want,
            r.stdout
        );
    }

    let r = run(
        sb.grad(Some(&srv.url)),
        &[
            "usage",
            "--by",
            "day",
            "--from",
            "2026-11-01",
            "--to",
            "2026-11-30T12:00:00Z",
        ],
    );
    expect(&r, 0);
    assert_eq!(
        srv.last("GET", "/v1/usage/summary").unwrap().query(),
        "from=2026-11-01&to=2026-11-30T12%3A00%3A00Z&group_by=day"
    );
    assert!(
        r.stdout.contains("DAY         COST    TOKENS     ROWS"),
        "{}",
        r.stdout
    );
    assert!(
        r.stdout.contains("2026-11-02  $12.50  2,400,000  7"),
        "{}",
        r.stdout
    );
    assert!(!r.stdout.contains("Top runs"), "{}", r.stdout);

    let r = run(
        sb.grad(Some(&srv.url)),
        &["usage", "--json", "--from", "2025-01-01"],
    );
    expect(&r, 0);
    let v: Value = serde_json::from_str(&r.stdout).unwrap();
    assert_eq!(v["data"]["records"], 0);
    assert_eq!(v["data"]["from"], "2026-11-01T00:00:00.000Z");
    let r = run(sb.grad(Some(&srv.url)), &["usage", "--from", "2025-01-01"]);
    assert!(
        r.stdout.contains("Nothing billed in this period."),
        "{}",
        r.stdout
    );

    let before = srv.requests().len();
    for bad in [
        &["usage", "--from", "2026-02-30"][..],
        &["usage", "--to", "11/30/2026"],
        &["usage", "list", "--from", "yesterday"],
        &["usage", "--by", "hour"],
        &["usage", "list", "--kind", "gpu"],
    ] {
        let r = run(sb.grad(Some(&srv.url)), bad);
        expect(&r, 2);
    }
    let r = run(
        sb.grad(Some(&srv.url)),
        &["--json", "usage", "--from", "2026-13-01"],
    );
    expect(&r, 2);
    let e = r.err_json();
    assert_eq!(e["error"]["code"], "usage_error");
    assert!(
        e["error"]["message"]
            .as_str()
            .unwrap()
            .contains("--from '2026-13-01' is not a date (YYYY-MM-DD)"),
        "{}",
        e
    );
    assert_eq!(
        srv.requests().len(),
        before,
        "bad dates are refused before any request"
    );
}

#[test]
fn usage_list_filters_and_resolves_names() {
    let srv = usage_api();
    let sb = Sandbox::new("usage-list");
    let r = run(sb.grad(Some(&srv.url)), &["usage", "list"]);
    expect(&r, 0);
    for want in [
        "TIME              KIND      RUN/EVAL               ATTEMPT  TOKENS  COST",
        "2026-11-27 04:35  training  support-sft (run_abc)  2        84      $0.0001",
        "2026-11-27 04:35  scoring   eval_sc                2        12      $0.0001",
    ] {
        assert!(
            r.stdout.contains(want),
            "missing {:?} in\n{}",
            want,
            r.stdout
        );
    }

    // A name several runs share: the newest, with a note.
    let r = run(
        sb.grad(Some(&srv.url)),
        &[
            "usage",
            "list",
            "--run",
            "support-sft",
            "--kind",
            "labeling",
            "--from",
            "2026-11-01",
            "--limit",
            "2",
        ],
    );
    expect(&r, 0);
    assert!(
        r.stderr.contains(
            "warning: 2 runs match 'support-sft'; showing the newest (run_new). Pass a run id to choose."
        ),
        "{}",
        r.stderr
    );
    assert!(r.stderr.contains("more: --cursor c2"), "{}", r.stderr);
    assert_eq!(
        srv.last("GET", "/v1/usage").unwrap().query(),
        "limit=2&from=2026-11-01&run_id=run_new&kind=labeling"
    );

    let r = run(
        sb.grad(Some(&srv.url)),
        &["usage", "list", "--eval", "weekly", "--to", "2026-11-30"],
    );
    expect(&r, 0);
    assert!(!r.stderr.contains("match"), "{}", r.stderr);
    assert_eq!(
        srv.last("GET", "/v1/usage").unwrap().query(),
        "to=2026-11-30&eval_id=eval_one"
    );
    let r = run(
        sb.grad(Some(&srv.url)),
        &["--json", "usage", "list", "--eval", "nightly"],
    );
    expect(&r, 0);
    let v: Value = serde_json::from_str(&r.stdout).unwrap();
    assert_eq!(
        v["warnings"][0],
        "2 evals match 'nightly'; showing the newest (eval_new). Pass an eval id to choose."
    );
    assert_eq!(
        srv.last("GET", "/v1/usage").unwrap().query(),
        "eval_id=eval_new"
    );

    let r = run(
        sb.grad(Some(&srv.url)),
        &[
            "usage",
            "list",
            "--run",
            "run_direct",
            "--eval",
            "eval_direct",
        ],
    );
    expect(&r, 0);
    assert_eq!(
        srv.last("GET", "/v1/usage").unwrap().query(),
        "run_id=run_direct&eval_id=eval_direct"
    );

    let r = run(
        sb.grad(Some(&srv.url)),
        &["usage", "list", "--eval", "missing"],
    );
    expect(&r, 4);
    assert!(
        r.stderr.contains("no eval with id or name 'missing'"),
        "{}",
        r.stderr
    );
    assert!(r.stderr.contains("grad eval list"), "{}", r.stderr);

    let r = run(sb.grad(Some(&srv.url)), &["usage", "list", "--json"]);
    expect(&r, 0);
    let v: Value = serde_json::from_str(&r.stdout).unwrap();
    assert_eq!(v["data"]["data"][0]["kind"], "training");
    assert_eq!(v["data"]["data"][0]["ref_name"], "support-sft");
}

#[test]
fn sources_add_list_sync_and_remove() {
    let srv = sources_api();
    let sb = Sandbox::new("sources");
    let u = Some(srv.url.as_str());

    let r = run(
        sb.grad(u),
        &[
            "sources",
            "add",
            "Langfuse",
            "--dataset",
            "support-prod",
            "--host",
            "https://cloud.langfuse.com",
            "--secret",
            "langfuse-prod",
            "--schedule",
            "*/15 * * * *",
            "--filter",
            "tags=[\"prod\"]",
            "--filter",
            "environment=production",
        ],
    );
    expect(&r, 0);
    assert!(r.stdout.contains("Added source src_01J9X"), "{}", r.stdout);
    assert!(r.stdout.contains("*/15 * * * *"), "{}", r.stdout);
    assert_eq!(
        srv.last("POST", "/v1/datasets/support-prod/sources")
            .unwrap()
            .json(),
        json!({"provider": {"kind": "langfuse", "host": "https://cloud.langfuse.com", "secret": "langfuse-prod",
                            "filters": {"tags": ["prod"], "environment": "production"}},
               "schedule": "*/15 * * * *"})
    );
    let r = run(
        sb.grad(u),
        &[
            "sources",
            "add",
            "braintrust",
            "--dataset",
            "manual",
            "--secret",
            "bt",
            "--project",
            "support-bot",
        ],
    );
    expect(&r, 0);
    assert!(
        r.stdout.contains("grad sources sync src_01J9X"),
        "{}",
        r.stdout
    );
    assert_eq!(
        srv.last("POST", "/v1/datasets/manual/sources")
            .unwrap()
            .json(),
        json!({"provider": {"kind": "braintrust", "secret": "bt", "project": "support-bot"}})
    );
    let r = run(
        sb.grad(u),
        &["sources", "add", "gradiated", "--dataset", "self-hosted"],
    );
    expect(&r, 6);
    assert!(r.stderr.contains("Gradiated Cloud"), "{}", r.stderr);
    let r = run(
        sb.grad(u),
        &[
            "sources",
            "add",
            "langfuse",
            "--dataset",
            "d",
            "--filter",
            "nokey",
        ],
    );
    expect(&r, 2);

    let r = run(
        sb.grad(u),
        &["sources", "list", "--dataset", "support-prod"],
    );
    expect(&r, 0);
    assert!(r.stdout.contains("completed (v3)"), "{}", r.stdout);
    assert!(r.stdout.contains("active (2 failed)"), "{}", r.stdout);
    assert!(
        r.stdout.contains("langfuse: 401 Unauthorized"),
        "{}",
        r.stdout
    );
    assert!(
        r.stdout.contains(&format!("{}…", "x".repeat(59))),
        "{}",
        r.stdout
    );
    assert!(
        r.stdout
            .contains("! src_paused is paused: 10 syncs in a row failed."),
        "{}",
        r.stdout
    );
    let r = run(sb.grad(u), &["sources", "sync", "src_recent"]);
    expect(&r, 0);
    assert!(r.stdout.contains("at most once a minute"), "{}", r.stdout);
    let r = run(sb.grad(u), &["sources", "sync", "src_busy", "--full"]);
    expect(&r, 0);
    assert!(
        r.stdout.contains("the full sync starts when it ends"),
        "{}",
        r.stdout
    );
    assert!(srv
        .last("GET", "/v1/sources")
        .unwrap()
        .query()
        .contains("dataset=support-prod"));

    let r = run(sb.grad(u), &["sources", "sync", "src_01J9X"]);
    expect(&r, 0);
    assert!(
        r.stdout.contains("grad imports status imp_7c1d"),
        "{}",
        r.stdout
    );
    assert_eq!(
        srv.last("POST", "/v1/sources/src_01J9X/sync")
            .unwrap()
            .json(),
        json!({"full": false})
    );
    let r = run(
        sb.grad(u),
        &["sources", "sync", "src_01J9X", "--full", "--wait", "--json"],
    );
    expect(&r, 0);
    assert_eq!(
        srv.last("POST", "/v1/sources/src_01J9X/sync")
            .unwrap()
            .json(),
        json!({"full": true})
    );
    assert_eq!(r.json()["data"]["status"], "completed");

    let r = run(sb.grad(u), &["sources", "remove", "src_01J9X"]);
    expect(&r, 0);
    assert_eq!(srv.count("DELETE", "/v1/sources/src_01J9X"), 1);
    let r = run(sb.grad(u), &["sources", "remove", "src_missing"]);
    expect(&r, 4);
}

#[test]
fn hf_import_with_a_secret_sends_its_name() {
    let srv = MockServer::start(|_| {
        Reply::json(
            202,
            json!({"id": "imp_1", "dataset": "gated", "status": "queued"}),
        )
    });
    let sb = Sandbox::new("hf-secret");
    let r = run(
        sb.grad(Some(&srv.url)),
        &[
            "datasets",
            "import",
            "hf",
            "org/gated",
            "--name",
            "gated",
            "--secret",
            "hf-token",
            "--no-wait",
        ],
    );
    expect(&r, 0);
    let body = srv
        .last("POST", "/v1/datasets/gated/imports")
        .unwrap()
        .json();
    assert_eq!(body["source"]["secret"], "hf-token");
}

// ---------------------------------------------------------------- artifacts & serving

#[test]
fn artifacts_download_extracts_a_verified_peft_directory() {
    let bundle = mock::bundle(&[
        ("adapter_config.json", b"{\"peft_type\": \"LORA\"}"),
        ("adapter_model.safetensors", &[1u8; 4096]),
    ]);
    let sha = mock::sha256_hex(&bundle);
    let b2 = bundle.clone();
    let srv = MockServer::start(move |r| {
        if r.path() == "/v1/artifacts/fast-diff-merge%40latest/download" {
            Reply::bytes(
                200,
                vec![
                    ("x-artifact-sha256", sha.clone()),
                    ("content-type", "application/octet-stream".into()),
                ],
                b2.clone(),
            )
        } else if r.path() == "/v1/artifacts/tampered/download" {
            Reply::bytes(200, vec![("x-artifact-sha256", "0".repeat(64))], b2.clone())
        } else {
            handler(r)
        }
    });
    let sb = Sandbox::new("download");
    let u = Some(srv.url.as_str());
    let r = run(
        sb.grad(u),
        &[
            "artifacts",
            "download",
            "fast-diff-merge@latest",
            "--output",
            "./fast-diff-merge",
        ],
    );
    expect(&r, 0);
    assert!(sb.path("fast-diff-merge/adapter_config.json").is_file());
    assert!(sb
        .path("fast-diff-merge/adapter_model.safetensors")
        .is_file());
    assert!(
        r.stdout.contains("--lora-modules fast-diff-merge="),
        "{}",
        r.stdout
    );
    // Second time: refuses the non-empty directory (exit 2) unless --force.
    let r = run(
        sb.grad(u),
        &[
            "artifacts",
            "download",
            "fast-diff-merge@latest",
            "--output",
            "./fast-diff-merge",
        ],
    );
    expect(&r, 2);
    let r = run(
        sb.grad(u),
        &[
            "artifacts",
            "download",
            "fast-diff-merge@latest",
            "--output",
            "./fast-diff-merge",
            "--force",
            "--json",
        ],
    );
    expect(&r, 0);
    assert_eq!(r.json()["data"]["files"].as_object().unwrap().len(), 2);
    // --out stays as an alias that keeps the archive.
    let r = run(
        sb.grad(u),
        &[
            "artifacts",
            "download",
            "fast-diff-merge@latest",
            "--out",
            "./a.grad.tar.gz",
        ],
    );
    expect(&r, 0);
    assert_eq!(std::fs::read(sb.path("a.grad.tar.gz")).unwrap(), bundle);
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(sb.path("victim"), sb.path("link.tgz")).unwrap();
        let r = run(
            sb.grad(u),
            &[
                "artifacts",
                "download",
                "fast-diff-merge@latest",
                "--archive",
                "./link.tgz",
                "--force",
            ],
        );
        expect(&r, 2);
        assert!(!sb.path("victim").exists());
    }
    let r = run(
        sb.grad(u),
        &["artifacts", "download", "tampered", "--output", "./t"],
    );
    expect(&r, 1);
    assert!(r.stderr.contains("expected"), "{}", r.stderr);
    assert!(!sb.path("t").exists());
    let r = run(
        sb.grad(u),
        &["artifacts", "download", "fast-diff-merge@latest"],
    );
    expect(&r, 2);
    let r = run(sb.grad(u), &["artifacts", "list"]);
    expect(&r, 0);
    assert!(r.stdout.contains("support-router@2026-11-26-1"));
    let r = run(
        sb.grad(u),
        &["artifacts", "inspect", "support-router@latest", "--json"],
    );
    expect(&r, 0);
    assert_eq!(r.json()["data"]["id"], "art_1");
}

#[test]
fn artifact_upload_import_delete_and_keys() {
    let srv = api();
    let sb = Sandbox::new("serve");
    let u = Some(srv.url.as_str());
    std::fs::create_dir_all(sb.path("My LoRA")).unwrap();
    std::fs::write(sb.path("My LoRA/adapter_config.json"), "{}").unwrap();
    let r = run(
        sb.grad(u),
        &[
            "artifacts",
            "upload",
            "My LoRA",
            "--base",
            "test/tiny-qwen3",
        ],
    );
    expect(&r, 0);
    assert!(r.stdout.contains("✓ Registered artifact"), "{}", r.stdout);
    assert!(r.stdout.contains("source"), "{}", r.stdout);
    assert_eq!(
        srv.last("POST", "/v1/uploads").unwrap().json()["purpose"],
        "artifact_import"
    );
    assert_eq!(
        srv.last("POST", "/v1/artifact-imports").unwrap().json(),
        json!({"source": {"kind": "upload", "upload_id": "up_1"}, "base_model": "test/tiny-qwen3", "format": "peft_lora", "name": "my-lora"})
    );
    let r = run(
        sb.grad(u),
        &[
            "--json",
            "artifacts",
            "import",
            "hf://acme/lora@main",
            "--base",
            "test/tiny-qwen3",
            "--no-wait",
        ],
    );
    expect(&r, 0);
    assert_eq!(r.json()["data"]["id"], "imp_9");
    let r = run(
        sb.grad(u),
        &["artifacts", "import", "hf://../x", "--base", "b"],
    );
    expect(&r, 2);
    let r = run(sb.grad(u), &["artifacts", "delete", "art_1"]);
    expect(&r, 0);
    let r = run(
        sb.grad(u),
        &["artifacts", "delete", "support-router@latest"],
    );
    expect(&r, 5);
    assert!(
        r.stderr.contains("pinned by inference:mv_1"),
        "{}",
        r.stderr
    );

    let r = run(
        sb.grad(u),
        &[
            "--json",
            "keys",
            "create",
            "--name",
            "ci-nightly",
            "--scopes",
            "datasets:write,runs:write,artifacts:read",
        ],
    );
    expect(&r, 0);
    snapshot("keys_create", &normalize(&r.json(), &srv.url, &sb.dir));
    assert_eq!(
        srv.last("POST", "/v1/keys").unwrap().json()["scopes"],
        json!(["datasets:write", "runs:write", "artifacts:read"])
    );
    let r = run(
        sb.grad(u),
        &[
            "keys",
            "create",
            "--name",
            "x",
            "--scopes",
            "artifacts:read",
        ],
    );
    expect(&r, 0);
    assert!(
        r.stdout.contains("grad_abcdefghijklmnop"),
        "the secret is shown once"
    );
    let r = run(sb.grad(u), &["keys", "list"]);
    expect(&r, 0);
    assert!(r.stdout.contains("key_1"));
    let r = run(sb.grad(u), &["keys", "revoke", "key_1"]);
    expect(&r, 0);
}

#[test]
fn dataset_score_and_filter_commands() {
    let srv = api();
    let sb = Sandbox::new("score");
    let u = Some(srv.url.as_str());
    std::fs::write(
        sb.path("judge.yaml"),
        "- name: resolved\n  kind: judge\n  model: qwen/qwen3-32b\n  prompt: Resolved?\n",
    )
    .unwrap();
    let r = run(
        sb.grad(u),
        &[
            "datasets",
            "score",
            "support-prod",
            "--rubric",
            "judge.yaml",
            "--wait",
        ],
    );
    expect(&r, 0);
    assert!(
        r.stdout.contains("scores in version 4") && r.stdout.contains("cost $0.12"),
        "{}",
        r.stdout
    );
    let body = srv
        .last("POST", "/v1/datasets/support-prod/score")
        .unwrap()
        .json();
    assert_eq!(body["rubric"][0]["kind"], "judge");
    let r = run(
        sb.grad(u),
        &[
            "datasets",
            "score",
            "support-prod",
            "--rubric",
            "judge.yaml",
        ],
    );
    expect(&r, 0);
    assert!(r.stdout.contains("grad eval status eval_s"), "{}", r.stdout);

    let r = run(
        sb.grad(u),
        &[
            "datasets",
            "filter",
            "support-prod",
            "--score",
            "resolved>=0.8",
            "--metadata",
            "env=prod",
            "--metadata",
            "turns=3",
            "--created-before",
            "2026-12-01",
        ],
    );
    expect(&r, 0);
    assert!(
        r.stdout
            .contains("support-prod-f-0123456789: 1,200 records"),
        "{}",
        r.stdout
    );
    let body = srv
        .last("POST", "/v1/datasets/support-prod/filter")
        .unwrap()
        .json();
    assert_eq!(
        body,
        json!({"scores": {"resolved": ">=0.8"}, "metadata": {"env": "prod", "turns": 3}, "created_before": "2026-12-01"})
    );
    for bad in [["--score", ">=0.8"], ["--metadata", "env"]] {
        let r = run(
            sb.grad(u),
            &["datasets", "filter", "support-prod", bad[0], bad[1]],
        );
        expect(&r, 2);
    }
}

#[test]
fn eval_commands() {
    let srv = api();
    let sb = Sandbox::new("eval");
    let u = Some(srv.url.as_str());
    std::fs::write(
        sb.path("rubric.yaml"),
        "- name: valid-sql\n  kind: regex\n  pattern: '^SELECT'\n- name: judge\n  kind: judge\n  model: qwen/qwen3-32b\n  prompt: Is it right?\n  weight: 0.5\n",
    )
    .unwrap();
    let r = run(
        sb.grad(u),
        &[
            "eval",
            "--name",
            "sql",
            "--models",
            "qwen/qwen3-8b,sql-agent@latest",
            "--dataset",
            "sql-eval-holdout",
            "--rubric",
            "./rubric.yaml",
            "--samples",
            "4",
            "--temperature",
            "0.7",
            "--baseline",
            "qwen/qwen3-8b",
            "--wait",
        ],
    );
    expect(&r, 0);
    assert!(
        r.stdout.contains("sql-agent@latest")
            && r.stdout.contains("+15.0%")
            && r.stdout.contains("86.0%")
            && r.stdout.contains("cost $0.40"),
        "eval billing is shown: {}",
        r.stdout
    );
    let body = srv.last("POST", "/v1/evals").unwrap().json();
    assert_eq!(body["temperature"], 0.7);
    assert_eq!(
        body["rubric"][0],
        json!({"name": "valid-sql", "kind": "regex", "pattern": "^SELECT"})
    );
    assert_eq!(body["models"], json!(["qwen/qwen3-8b", "sql-agent@latest"]));
    let r = run(
        sb.grad(u),
        &["eval", "--models", "a", "--dataset", "d", "--dry-run"],
    );
    expect(&r, 0);
    assert!(
        r.stdout.contains("model calls") && r.stdout.contains("est. cost"),
        "{}",
        r.stdout
    );
    let r = run(
        sb.grad(u),
        &["eval", "plan", "--models", "a", "--dataset", "d"],
    );
    expect(&r, 0);
    let r = run(sb.grad(u), &["eval", "--models", "a", "--dataset", "d"]);
    expect(&r, 0);
    assert!(r.stdout.contains("grad eval status eval_1"));
    for args in [
        vec!["eval", "status", "eval_1"],
        vec!["eval", "list"],
        vec!["eval", "wait", "eval_1"],
        vec!["eval", "results", "eval_1"],
        vec![
            "eval",
            "failures",
            "eval_1",
            "--model",
            "qwen/qwen3-8b",
            "--threshold",
            "0.5",
        ],
        vec!["eval", "cancel", "eval_1"],
    ] {
        let r = run(sb.grad(u), &args);
        expect(&r, 0);
    }
    assert!(srv
        .last("GET", "/v1/evals/eval_1/failures")
        .unwrap()
        .query()
        .contains("threshold=0.5"));
    std::fs::write(sb.path("code.yaml"), "- name: mine\n  kind: code\n").unwrap();
    let r = run(
        sb.grad(u),
        &[
            "eval",
            "--models",
            "a",
            "--dataset",
            "d",
            "--rubric",
            "code.yaml",
        ],
    );
    expect(&r, 2);
    assert!(r.stderr.contains("Python SDK"), "{}", r.stderr);
    let r = run(
        sb.grad(u),
        &[
            "eval",
            "--models",
            "a",
            "--dataset",
            "d",
            "--temperature",
            "9",
        ],
    );
    expect(&r, 2);
    let r = run(sb.grad(u), &["eval", "--models", "a"]);
    expect(&r, 2);
}

// ---------------------------------------------------------------- local stack

/// A loopback port the OS just handed out, free again.
fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}

/// A fake docker that logs its arguments and env. `docker ps` prints
/// `docker-ps.txt` (the Ports column of our running containers), if present.
fn docker_shim(sb: &Sandbox, exit: i32) -> PathBuf {
    let shim = sb.path("docker-shim.sh");
    std::fs::write(
        &shim,
        format!(
            "#!/bin/sh\necho \"$@\" >> \"{log}\"\necho \"HASH=$GRAD_ADMIN_API_KEY_HASH TRAINER=$GRAD_TRAINER_API_KEY SECRETS=$GRAD_SECRETS_KEY PORT=$GRAD_PORT GRAFANA=$GRAD_GRAFANA_PORT PROMETHEUS=$GRAD_PROMETHEUS_PORT S3=$GRAD_S3_PORT S3KEYS=$GRAD_S3_ACCESS_KEY:$GRAD_S3_SECRET_KEY AUTH=$GRAD_AUTH_MODE\" >> \"{log}\"\nif [ \"$1\" = ps ]; then cat \"{ps}\" 2>/dev/null; fi\nexit {exit}\n",
            log = sb.path("docker.log").display(),
            ps = sb.path("docker-ps.txt").display(),
            exit = exit
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    shim
}

#[cfg(unix)]
#[test]
fn ui_opens_the_browser_with_a_one_time_key_fragment_and_never_prints_the_key() {
    let sb = Sandbox::new("ui");
    // A fake browser that records the URL it was asked to open.
    let browser = sb.path("browser.sh");
    std::fs::write(
        &browser,
        format!(
            "#!/bin/sh\nprintf '%s' \"$1\" > {}\n",
            sb.path("opened.txt").display()
        ),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&browser, std::fs::Permissions::from_mode(0o755)).unwrap();
    }
    let mut c = sb.grad(Some("http://127.0.0.1:18787"));
    c.env("BROWSER", &browser);
    let r = run(c, &["ui", "--json"]);
    expect(&r, 0);
    assert_eq!(r.json()["data"]["url"], "http://127.0.0.1:18787/");
    assert_eq!(r.json()["data"]["opened"], true);
    assert_eq!(
        std::fs::read_to_string(sb.path("opened.txt")).unwrap(),
        "http://127.0.0.1:18787/#key=grad_cli_test"
    );
    assert!(!r.stdout.contains("grad_cli_test") && !r.stderr.contains("grad_cli_test"));

    let mut c = sb.grad(Some("http://127.0.0.1:18787/"));
    c.env("BROWSER", &browser);
    let r = run(c, &["ui", "run_01J9X"]);
    expect(&r, 0);
    assert!(
        r.stdout
            .contains("Opened http://127.0.0.1:18787/runs/run_01J9X"),
        "{}",
        r.stdout
    );

    let r = run(
        sb.grad(Some("http://127.0.0.1:18787")),
        &["ui", "--no-open"],
    );
    expect(&r, 0);
    assert_eq!(r.stdout.trim(), "http://127.0.0.1:18787/");
    assert!(!r.stderr.contains("grad_cli_test"));

    let mut c = sb.grad(Some("http://127.0.0.1:18787"));
    c.env("BROWSER", sb.path("no-such-browser"));
    let r = run(c, &["ui", "--json"]);
    expect(&r, 1);
    assert_eq!(r.err_json()["error"]["code"], "browser_unavailable");
    assert!(!r.stderr.contains("grad_cli_test"));
}

#[test]
fn local_up_and_reset_only_ever_write_the_local_profile() {
    // r8 code-quality P1: GRADIATED_PROFILE=staging used to make `grad local up`
    // overwrite staging's key and URL with the local stack's, and `reset` wipe it.
    let sb = Sandbox::new("local-profile");
    let shim = docker_shim(&sb, 0);
    std::fs::create_dir_all(sb.config_path().parent().unwrap()).unwrap();
    let staging =
        json!({"base_url": "https://grad.staging.example", "api_key": "grad_staging_key"});
    std::fs::write(
        sb.config_path(),
        json!({"profiles": {"staging": staging}}).to_string(),
    )
    .unwrap();
    let config = || -> Value {
        serde_json::from_str(&std::fs::read_to_string(sb.config_path()).unwrap()).unwrap()
    };
    for (env, args) in [
        (Some("staging"), vec!["local", "up", "--no-wait"]),
        (
            None,
            vec!["--profile", "staging", "local", "up", "--no-wait"],
        ),
        (Some("staging"), vec!["local", "reset", "--yes"]),
    ] {
        let mut c = sb.grad(None);
        c.env("GRAD_DOCKER", &shim);
        if let Some(p) = env {
            c.env("GRADIATED_PROFILE", p);
        }
        let r = run(c, &args);
        expect(&r, 2);
        assert!(
            r.stderr.contains(
                "profile 'staging' points at https://grad.staging.example, not a local stack"
            ),
            "{:?}: {}",
            args,
            r.stderr
        );
        assert!(r
            .stderr
            .contains("Unset GRADIATED_PROFILE or pass --profile local"));
        assert_eq!(config()["profiles"]["staging"], staging, "{:?}", args);
        assert!(config()["profiles"].get("local").is_none());
    }
    assert!(
        !sb.path("docker.log").exists(),
        "docker never ran for a refused command"
    );

    // A selected profile that isn't remote: the stack still lives in 'local'.
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim).env("GRADIATED_PROFILE", "dev");
    let r = run(c, &["local", "up", "--no-wait"]);
    expect(&r, 0);
    assert!(
        r.stderr.contains("uses the 'local' profile, not 'dev'"),
        "{}",
        r.stderr
    );
    let cfg = config();
    assert!(cfg["profiles"]["local"]["api_key"]
        .as_str()
        .unwrap()
        .starts_with("grad_local_"));
    assert!(cfg["profiles"].get("dev").is_none());
    assert_eq!(cfg["profiles"]["staging"], staging);
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim).env("GRADIATED_PROFILE", "dev");
    let r = run(c, &["local", "reset", "--yes"]);
    expect(&r, 0);
    let cfg = config();
    assert!(cfg["profiles"]["local"].get("api_key").is_none());
    assert_eq!(cfg["profiles"]["staging"], staging);

    // 'local' itself pointed at a remote server is refused too.
    let mut cfg = config();
    cfg["profiles"]["local"] = staging.clone();
    std::fs::write(sb.config_path(), cfg.to_string()).unwrap();
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim);
    let r = run(c, &["local", "up", "--no-wait"]);
    expect(&r, 2);
    assert!(r
        .stderr
        .contains("profile 'local' points at https://grad.staging.example"));
    assert_eq!(config()["profiles"]["local"], staging);
}

#[test]
fn local_up_moves_off_a_busy_default_port_and_refuses_a_busy_pinned_one() {
    let sb = Sandbox::new("local-ports");
    let shim = docker_shim(&sb, 0);
    // Hold the default API port (if something else on this machine already
    // does, it is just as busy).
    let _hold = std::net::TcpListener::bind("127.0.0.1:18787");
    assert!(std::net::TcpListener::bind("127.0.0.1:18787").is_err());
    let profile_url = || -> String {
        let cfg: Value =
            serde_json::from_str(&std::fs::read_to_string(sb.config_path()).unwrap()).unwrap();
        cfg["profiles"]["local"]["base_url"]
            .as_str()
            .unwrap()
            .to_string()
    };

    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim);
    let r = run(c, &["local", "up", "--no-wait"]);
    expect(&r, 0);
    let url = profile_url();
    let port: u16 = url.rsplit(':').next().unwrap().parse().unwrap();
    assert_ne!(port, 18787);
    assert!(
        r.stderr.contains(&format!(
            "18787 is in use (by another process); serving the API on 127.0.0.1:{}",
            port
        )),
        "{}",
        r.stderr
    );
    assert!(r.stdout.contains(&format!("grad is running at {}", url)));
    let log = std::fs::read_to_string(sb.path("docker.log")).unwrap();
    assert!(log.contains(&format!("PORT={} ", port)), "{}", log);
    let saved: Value = serde_json::from_str(
        &std::fs::read_to_string(sb.path("data/gradiated/local/ports.json")).unwrap(),
    )
    .unwrap();
    assert_eq!(saved["grad-local"]["api"], port);

    // The next `up` keeps the saved port (stable URLs), silently.
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim);
    let r = run(c, &["local", "up", "--no-wait"]);
    expect(&r, 0);
    assert_eq!(profile_url(), url);
    assert!(!r.stderr.contains("is in use"), "{}", r.stderr);

    // A pinned port that is busy fails with exit 2 and never starts docker.
    std::fs::remove_file(sb.path("docker.log")).unwrap();
    for (env, args, how) in [
        (
            None,
            vec!["--json", "local", "up", "--port", "18787"],
            "--port / GRAD_PORT",
        ),
        (
            Some(("GRAD_PORT", "18787")),
            vec!["--json", "local", "up"],
            "--port / GRAD_PORT",
        ),
        (
            Some(("GRAD_GRAFANA_PORT", "18787")),
            vec!["--json", "local", "up", "--observability"],
            "GRAD_GRAFANA_PORT",
        ),
    ] {
        let mut c = sb.grad(None);
        c.env("GRAD_DOCKER", &shim);
        if let Some((k, v)) = env {
            c.env(k, v);
        }
        let r = run(c, &args);
        expect(&r, 2);
        let err = &r.err_json()["error"];
        assert_eq!(err["code"], "port_in_use", "{}", r.stderr);
        assert!(
            err["message"]
                .as_str()
                .unwrap()
                .contains(&format!("port 18787 ({})", how)),
            "{}",
            err
        );
        let hint = err["hint"].as_str().unwrap();
        assert!(
            hint.contains("lsof -i :18787") && hint.contains("ss -ltnp"),
            "{}",
            hint
        );
    }
    let log = std::fs::read_to_string(sb.path("docker.log")).unwrap_or_default();
    assert!(!log.contains("up -d"), "{}", log);
    assert_eq!(profile_url(), url, "a refused up keeps the profile");

    // Our own running stack holding the port is not a clash.
    std::fs::write(sb.path("docker-ps.txt"), "127.0.0.1:18787->8787/tcp\n").unwrap();
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim);
    let r = run(
        c,
        &["--json", "local", "up", "--port", "18787", "--no-wait"],
    );
    expect(&r, 0);
    assert_eq!(r.json()["data"]["base_url"], "http://127.0.0.1:18787");
    assert_eq!(profile_url(), "http://127.0.0.1:18787");
}

#[test]
fn local_up_uses_the_embedded_compose_from_any_directory_and_saves_keys() {
    let srv = api();
    let port = srv.url.rsplit(':').next().unwrap().to_string();
    let sb = Sandbox::new("local");
    let shim = docker_shim(&sb, 0);
    // The mock API stands in for our own running stack: its port isn't a clash.
    std::fs::write(
        sb.path("docker-ps.txt"),
        format!("127.0.0.1:{}->8787/tcp\n", port),
    )
    .unwrap();
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim).current_dir("/");
    let r = run(c, &["local", "up", "--port", &port, "--timeout", "10"]);
    expect(&r, 0);
    assert!(
        r.stdout
            .contains(&format!("grad is running at http://127.0.0.1:{}", port)),
        "{}",
        r.stdout
    );
    assert!(r.stdout.contains("grad --profile local models list"));
    assert!(
        r.stdout
            .contains(&format!("Web UI: http://127.0.0.1:{}/", port)),
        "{}",
        r.stdout
    );
    let compose = sb.path("data/gradiated/local/docker-compose.yml");
    let text = std::fs::read_to_string(&compose).unwrap();
    // A source build pulls `main`; release.yml bakes the version in (build.rs).
    assert!(text.contains(&format!(
        "docker.io/gradiated/grad-server:{}",
        env!("GRAD_DEFAULT_IMAGE_TAG")
    )));
    let log = std::fs::read_to_string(sb.path("docker.log")).unwrap();
    let pull = format!("compose -p grad-local -f {} pull", compose.display());
    let up = format!("compose -p grad-local -f {} up -d", compose.display());
    assert!(
        log.find(&pull)
            .is_some_and(|p| log.find(&up).is_some_and(|u| p < u)),
        "pulls, then starts: {}",
        log
    );
    let cfg: Value =
        serde_json::from_str(&std::fs::read_to_string(sb.config_path()).unwrap()).unwrap();
    let local = &cfg["profiles"]["local"];
    let admin = local["api_key"].as_str().unwrap();
    let trainer = local["trainer_key"].as_str().unwrap();
    assert!(admin.starts_with("grad_local_") && trainer.starts_with("grad_trainer_"));
    assert_eq!(local["base_url"], format!("http://127.0.0.1:{}", port));
    assert!(log.contains(&format!("HASH={}", mock::sha256_hex(admin.as_bytes()))));
    assert!(log.contains(&format!("TRAINER={}", trainer)) && log.contains("AUTH=api_key"));
    let secrets = local["secrets_key"].as_str().unwrap();
    assert_eq!(secrets.len(), 44, "32 bytes in base64: {}", secrets);
    assert!(log.contains(&format!("SECRETS={}", secrets)));
    // The S3 store's key pair, generated once and passed to compose.
    let s3_keys = format!(
        "{}:{}",
        local["s3_access_key"].as_str().unwrap(),
        local["s3_secret_key"].as_str().unwrap()
    );
    assert!(s3_keys.starts_with("grad") && s3_keys.len() == 20 + 1 + 48);
    assert!(log.contains(&format!("S3KEYS={}", s3_keys)), "{}", log);
    // ...and its loopback port, probed like the API's.
    let s3_port: u16 = log
        .split("S3=")
        .skip(1)
        .find_map(|rest| rest.split(' ').next()?.parse().ok())
        .expect("GRAD_S3_PORT");
    assert_ne!(s3_port.to_string(), port);
    assert!(
        !log.contains(admin),
        "the admin key itself never reaches docker"
    );
    assert!(srv.count("GET", "/health/ready") >= 1);
    assert_eq!(
        srv.last("GET", "/v1/base-models")
            .unwrap()
            .header("authorization"),
        Some(format!("Bearer {}", admin).as_str())
    );

    // Keys are reused on the next run; --gpu adds the profile.
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim);
    let r = run(
        c,
        &[
            "--json",
            "local",
            "up",
            "--gpu",
            "--port",
            &port,
            "--no-wait",
        ],
    );
    expect(&r, 0);
    assert_eq!(r.json()["data"]["keys_created"], false);
    let log = std::fs::read_to_string(sb.path("docker.log")).unwrap();
    assert!(log.contains("--profile gpu up -d"));

    // --observability adds Prometheus and Grafana, with the dashboards beside the compose file.
    let grafana = free_port();
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim)
        .env("GRAD_GRAFANA_PORT", grafana.to_string());
    let r = run(
        c,
        &[
            "--json",
            "local",
            "up",
            "--observability",
            "--port",
            &port,
            "--no-wait",
        ],
    );
    expect(&r, 0);
    assert_eq!(
        r.json()["data"]["grafana_url"],
        format!("http://127.0.0.1:{}/", grafana)
    );
    let prometheus = r.json()["data"]["ports"]["prometheus"].as_u64().unwrap();
    let log = std::fs::read_to_string(sb.path("docker.log")).unwrap();
    assert!(
        log.contains(&format!("PORT={} GRAFANA={} ", port, grafana)),
        "{}",
        log
    );
    assert!(log.contains("--profile observability pull"), "{}", log);
    assert!(log.contains("--profile observability up -d"), "{}", log);
    let overview = sb.path("data/gradiated/local/grafana/overview.json");
    let dashboard: Value =
        serde_json::from_str(&std::fs::read_to_string(overview).unwrap()).unwrap();
    assert_eq!(dashboard["uid"], "grad-overview");
    assert!(text.contains("./grafana:/var/lib/grafana/dashboards/grad:ro"));

    // status prints the URLs the last `up` chose.
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim);
    let r = run(c, &["--json", "local", "status"]);
    expect(&r, 0);
    let d = &r.json()["data"];
    assert_eq!(d["base_url"], format!("http://127.0.0.1:{}", port));
    assert_eq!(d["ui_url"], format!("http://127.0.0.1:{}/", port));
    assert_eq!(d["grafana_url"], format!("http://127.0.0.1:{}/", grafana));
    assert_eq!(
        d["prometheus_url"],
        format!("http://127.0.0.1:{}/", prometheus)
    );
    assert_eq!(d["healthy"], true);
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim);
    let r = run(c, &["local", "status"]);
    expect(&r, 0);
    assert!(
        r.stdout
            .contains(&format!("Grafana:    http://127.0.0.1:{}/", grafana)),
        "{}",
        r.stdout
    );
    for (args, needle) in [
        (
            vec!["local", "down", "--volumes"],
            "--profile * down --volumes",
        ),
        (
            vec!["local", "logs", "grad-server", "--tail", "50"],
            "logs --tail 50 grad-server",
        ),
        (vec!["local", "status"], " ps"),
        (
            vec!["local", "reset", "--yes"],
            "down --volumes --remove-orphans",
        ),
    ] {
        let mut c = sb.grad(None);
        c.env("GRAD_DOCKER", &shim);
        let r = run(c, &args);
        expect(&r, 0);
        let log = std::fs::read_to_string(sb.path("docker.log")).unwrap();
        assert!(log.contains(needle), "{:?}: {}", args, log);
    }
    let cfg: Value =
        serde_json::from_str(&std::fs::read_to_string(sb.config_path()).unwrap()).unwrap();
    assert!(
        cfg["profiles"]["local"].get("api_key").is_none()
            && cfg["profiles"]["local"].get("secrets_key").is_none()
            && cfg["profiles"]["local"].get("s3_secret_key").is_none(),
        "reset forgets the keys"
    );

    // --build needs a checkout; reset needs --yes without a terminal.
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim).current_dir("/");
    let r = run(c, &["local", "up", "--build"]);
    expect(&r, 2);
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim);
    let r = run(c, &["local", "reset"]);
    expect(&r, 2);
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim);
    let r = run(c, &["local", "up", "--file", "missing.yml"]);
    expect(&r, 2);
    // --file repeats (or GRAD_COMPOSE_FILE lists files) for compose overrides.
    let (base, extra) = (sb.path("base.yml"), sb.path("override.yml"));
    std::fs::write(&base, "name: x\n").unwrap();
    std::fs::write(&extra, "name: x\n").unwrap();
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim);
    let r = run(
        c,
        &[
            "--json",
            "local",
            "up",
            "--no-wait",
            "--file",
            base.to_str().unwrap(),
            "--file",
            extra.to_str().unwrap(),
        ],
    );
    expect(&r, 0);
    assert_eq!(
        r.json()["data"]["compose_files"].as_array().unwrap().len(),
        2
    );
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim).env(
        "GRAD_COMPOSE_FILE",
        format!("{}:{}", base.display(), extra.display()),
    );
    let r = run(c, &["local", "down"]);
    expect(&r, 0);
    let log = std::fs::read_to_string(sb.path("docker.log")).unwrap();
    let pair = format!("-f {} -f {}", base.display(), extra.display());
    assert!(log.contains(&format!("{} up -d", pair)), "{}", log);
    assert!(
        log.contains(&format!("{} --profile * down", pair)),
        "{}",
        log
    );
    // Docker missing or failing.
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", sb.path("no-docker-here"));
    let r = run(c, &["local", "up", "--no-wait"]);
    expect(&r, 1);
    assert!(r.stderr.contains("Install Docker"), "{}", r.stderr);
    let failing = docker_shim(&sb, 3);
    let spare = free_port().to_string();
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &failing);
    let r = run(c, &["local", "up", "--no-wait", "--port", &spare]);
    expect(&r, 1);
    assert!(
        r.stderr.contains("docker output above") && !r.stderr.contains("in use"),
        "a free port is not blamed: {}",
        r.stderr
    );

    // --dev-models layers the tiny-model override on the compose file.
    let shim = docker_shim(&sb, 0);
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim);
    let r = run(c, &["--json", "local", "up", "--no-wait", "--dev-models"]);
    expect(&r, 0);
    assert_eq!(r.json()["data"]["dev_models"], true);
    let dev = sb.path("data/gradiated/local/dev-models.yml");
    assert!(std::fs::read_to_string(&dev)
        .unwrap()
        .contains("GRAD_DEV_MODELS: \"1\""));
    let log = std::fs::read_to_string(sb.path("docker.log")).unwrap();
    assert!(
        log.contains(&format!(
            "-f {} -f {} up -d",
            compose.display(),
            dev.display()
        )),
        "{}",
        log
    );

    // --image-tag picks the tag; tags are validated; --build builds instead.
    let shim = docker_shim(&sb, 0);
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim);
    let r = run(
        c,
        &["local", "up", "--no-wait", "--image-tag", "sha-abc1234"],
    );
    expect(&r, 0);
    let text = std::fs::read_to_string(&compose).unwrap();
    assert!(text.contains("docker.io/gradiated/grad-trainer:sha-abc1234-gpu"));
    for bad in [
        vec!["local", "up", "--image-tag", "a\nb: c"],
        vec!["local", "up", "--image-tag", "main", "--build"],
    ] {
        let mut c = sb.grad(None);
        c.env("GRAD_DOCKER", &shim);
        expect(&run(c, &bad), 2);
    }
    // An image override means the user manages images: no pull.
    std::fs::remove_file(sb.path("docker.log")).unwrap();
    let mut c = sb.grad(None);
    c.env("GRAD_DOCKER", &shim)
        .env("GRAD_SERVER_IMAGE", "my-server:dev");
    expect(&run(c, &["local", "up", "--no-wait"]), 0);
    let log = std::fs::read_to_string(sb.path("docker.log")).unwrap();
    assert!(!log.contains(" pull") && log.contains("up -d"), "{}", log);

    // A refused pull (a bad login) or a missing tag fails with a hint before `up`.
    for (msg, code, hint) in [
        (
            "Error response from daemon: pull access denied for gradiated/grad-server, repository does not exist or may require 'docker login'",
            "image_pull_denied",
            "docker logout",
        ),
        (
            "Error response from daemon: manifest unknown",
            "image_not_found",
            "--image-tag",
        ),
    ] {
        let shim = sb.path("docker-pull-fails.sh");
        std::fs::write(
            &shim,
            format!(
                "#!/bin/sh\necho \"$@\" >> \"{log}\"\ncase \"$*\" in *pull*) echo \"{msg}\" >&2; exit 18;; esac\nexit 0\n",
                log = sb.path("docker.log").display()
            ),
        )
        .unwrap();
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&shim, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        std::fs::remove_file(sb.path("docker.log")).unwrap();
        let mut c = sb.grad(None);
        c.env("GRAD_DOCKER", &shim).current_dir("/");
        let r = run(c, &["--json", "local", "up", "--no-wait"]);
        expect(&r, 1);
        let err = &r.err_json()["error"];
        assert_eq!(err["code"], code, "{}", r.stderr);
        let h = err["hint"].as_str().unwrap_or_default();
        assert!(h.contains(hint) && h.contains("--build"), "{}", h);
        let log = std::fs::read_to_string(sb.path("docker.log")).unwrap();
        assert!(!log.contains("up -d"), "{}", log);

        // Inside a grad checkout the same failure builds the images from it instead.
        let checkout = sb.path("checkout");
        std::fs::create_dir_all(checkout.join("server/sub")).unwrap();
        std::fs::write(checkout.join("server/docker-compose.yml"), "name: x\n").unwrap();
        std::fs::remove_file(sb.path("docker.log")).unwrap();
        let mut c = sb.grad(None);
        c.env("GRAD_DOCKER", &shim)
            .current_dir(checkout.join("server/sub"));
        let r = run(c, &["local", "up", "--no-wait"]);
        expect(&r, 0);
        assert!(r.stderr.contains("building them from this checkout"), "{}", r.stderr);
        let log = std::fs::read_to_string(sb.path("docker.log")).unwrap();
        let source = checkout.join("server/docker-compose.yml");
        assert!(
            log.contains(&format!("-f {} up -d --build", source.display())),
            "{}",
            log
        );
        // ...unless a tag was asked for explicitly.
        let mut c = sb.grad(None);
        c.env("GRAD_DOCKER", &shim)
            .current_dir(checkout.join("server/sub"));
        let r = run(c, &["--json", "local", "up", "--no-wait", "--image-tag", "9.9.9"]);
        expect(&r, 1);
        assert_eq!(r.err_json()["error"]["code"], code);
        std::fs::remove_dir_all(&checkout).unwrap();
    }
}

// ---------------------------------------------------------------- interrupt

#[cfg(unix)]
#[test]
fn ctrl_c_while_waiting_exits_130_and_says_the_run_continues() {
    let hits = Arc::new(AtomicUsize::new(0));
    let h = hits.clone();
    let srv = MockServer::start(move |r| match (r.method.as_str(), r.path()) {
        ("POST", "/v1/runs") => Reply::json(202, run_obj("run_slow", "n", "queued")),
        ("GET", "/v1/runs/run_slow/events") => {
            h.fetch_add(1, Ordering::SeqCst);
            Reply::Stream {
                status: 200,
                headers: vec![("content-type".into(), "text/event-stream".into())],
                chunks: vec![
                    (Duration::ZERO, b": ping\n\n".to_vec()),
                    (Duration::from_secs(20), b": ping\n\n".to_vec()),
                ],
            }
        }
        _ => Reply::problem(404, "not_found", "x"),
    });
    let sb = Sandbox::new("sigint");
    let bin = assert_cmd::cargo::cargo_bin("grad");
    let child = std::process::Command::new(bin)
        .args([
            "train",
            "--dataset",
            "d",
            "--name",
            "n",
            "--recipe",
            "sft",
            "--wait",
        ])
        .env("GRADIATED_BASE_URL", &srv.url)
        .env("GRADIATED_API_KEY", "k")
        .env("XDG_CONFIG_HOME", sb.path("xdg"))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(15);
    while hits.load(Ordering::SeqCst) == 0 && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(50));
    }
    std::thread::sleep(Duration::from_millis(200));
    std::process::Command::new("kill")
        .args(["-INT", &child.id().to_string()])
        .status()
        .unwrap();
    let out = child.wait_with_output().unwrap();
    assert_eq!(out.status.code(), Some(130));
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(stderr.contains("run_slow keeps going"), "{}", stderr);
}

/// Regression: a server that echoes the cursor it was sent must not produce a
/// `--cursor` hint that loops; an empty page must not advertise more pages.
#[test]
fn list_cursor_hints_stop_on_repeated_cursor_and_empty_page() {
    let srv = MockServer::start(|r| match r.path() {
        "/v1/runs" | "/v1/datasets" => Reply::json(
            200,
            json!({"data": [run_obj("run_1", "a", "completed")], "next_cursor": "same"}),
        ),
        "/v1/datasets/ds/records" => Reply::json(
            200,
            json!({"dataset": "ds", "version": 1, "total": 0, "data": [], "next_cursor": "fresh"}),
        ),
        _ => Reply::problem(404, "nf", "nf"),
    });
    let sb = Sandbox::new("pagination");
    let u = Some(srv.url.as_str());

    // First page: the hint is fine.
    let r = run(sb.grad(u), &["runs", "list"]);
    expect(&r, 0);
    assert!(r.stderr.contains("more: --cursor same"), "{}", r.stderr);

    // Following it returns the same cursor: typed error, exit 1.
    for cmd in [["runs", "list"], ["datasets", "list"]] {
        let r = run(sb.grad(u), &["--json", cmd[0], cmd[1], "--cursor", "same"]);
        expect(&r, 1);
        let e = r.err_json();
        assert_eq!(e["error"]["code"], "pagination_loop", "{}", r.stderr);
        assert!(r.stdout.is_empty());
    }

    // Empty page with a cursor: no hint.
    let r = run(sb.grad(u), &["datasets", "records", "ds"]);
    expect(&r, 0);
    assert!(!r.stderr.contains("more:"), "{}", r.stderr);
}

// ---------------------------------------------------------------- parity

/// JSON numbers compared by value (`5` and `5.0` are the same on the wire).
fn norm(v: &Value) -> Value {
    match v {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::Array(a) => Value::Array(a.iter().map(norm).collect()),
        Value::Object(m) => Value::Object(m.iter().map(|(k, v)| (k.clone(), norm(v))).collect()),
        other => other.clone(),
    }
}

/// The CLI sends tests/fixtures/wire/sdk-parity.json's requests: runs through a
/// `grad train -f` run file (the request body is a valid run file), evals and
/// artifact imports through flags, each with --idempotency-key when the fixture has one.
#[test]
fn parity_requests_match_the_shared_fixture() {
    let raw = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../tests/fixtures/wire/sdk-parity.json"),
    )
    .unwrap();
    let fx: Value = serde_json::from_str(&raw).unwrap();
    let srv = MockServer::start(|r| {
        if r.path() == "/v1/usage" {
            Reply::json(200, json!({"data": [], "next_cursor": null}))
        } else {
            Reply::json(200, json!({"id": "x", "name": "x", "status": "queued"}))
        }
    });
    let sb = Sandbox::new("parity");
    for case in fx["requests"].as_array().unwrap() {
        let name = case["case"].as_str().unwrap();
        let path = case["path"].as_str().unwrap();
        let body = &case["body"];
        let s = |k: &str| body[k].to_string().trim_matches('"').to_string();
        let mut args: Vec<String> = match path {
            "/v1/runs/plan" | "/v1/runs" => {
                std::fs::write(sb.path("run.yaml"), body.to_string()).unwrap();
                let mut a = vec!["train".into(), "-f".into(), "run.yaml".into()];
                if path == "/v1/runs/plan" {
                    a.push("--dry-run".into());
                }
                a
            }
            "/v1/evals" => {
                std::fs::write(sb.path("rubric.yaml"), body["rubric"].to_string()).unwrap();
                let models: Vec<&str> = body["models"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .map(|m| m.as_str().unwrap())
                    .collect();
                let mut a: Vec<String> = vec![
                    "eval".into(),
                    "--models".into(),
                    models.join(","),
                    "--rubric".into(),
                    "rubric.yaml".into(),
                ];
                for (flag, key) in [
                    ("--name", "name"),
                    ("--dataset", "dataset"),
                    ("--dataset-version", "dataset_version"),
                    ("--baseline", "baseline"),
                    ("--samples", "samples"),
                    ("--temperature", "temperature"),
                    ("--max-tokens", "max_tokens"),
                    ("--limit", "limit"),
                    ("--pass-threshold", "pass_threshold"),
                ] {
                    a.push(flag.into());
                    a.push(s(key));
                }
                a
            }
            "/v1/artifact-imports" => vec![
                "artifacts".into(),
                "import".into(),
                format!(
                    "hf://{}@{}",
                    body["source"]["repo"].as_str().unwrap(),
                    body["source"]["revision"].as_str().unwrap()
                ),
                "--base".into(),
                s("base_model"),
                "--format".into(),
                s("format"),
                "--name".into(),
                s("name"),
                "--secret".into(),
                body["source"]["secret"].as_str().unwrap().into(),
                "--no-wait".into(),
            ],
            p if case["method"] == "DELETE" && p.starts_with("/v1/artifacts/") => vec![
                "artifacts".into(),
                "delete".into(),
                p.trim_start_matches("/v1/artifacts/").into(),
            ],
            "/v1/datasets/support-logs/score" => {
                std::fs::write(sb.path("rubric.yaml"), body["rubric"].to_string()).unwrap();
                vec![
                    "datasets".into(),
                    "score".into(),
                    "support-logs".into(),
                    "--rubric".into(),
                    "rubric.yaml".into(),
                    "--version".into(),
                    s("version"),
                    "--job-name".into(),
                    s("name"),
                    "--limit".into(),
                    s("limit"),
                ]
            }
            "/v1/datasets/gsm8k-test-200/imports" => vec![
                "datasets".into(),
                "import".into(),
                "benchmark".into(),
                body["source"]["benchmark"].as_str().unwrap().into(),
                "--limit".into(),
                body["source"]["limit"].to_string(),
                "--name".into(),
                "gsm8k-test-200".into(),
                "--no-wait".into(),
            ],
            "/v1/datasets/support-logs/filter" => {
                let mut a: Vec<String> =
                    vec!["datasets".into(), "filter".into(), "support-logs".into()];
                for (k, v) in body["scores"].as_object().into_iter().flatten() {
                    a.push("--score".into());
                    a.push(format!("{}{}", k, v.as_str().unwrap()));
                }
                for (k, v) in body["metadata"].as_object().into_iter().flatten() {
                    a.push("--metadata".into());
                    a.push(format!("{}={}", k, v.as_str().unwrap()));
                }
                if let Some(ids) = body["ids"].as_array() {
                    let ids: Vec<&str> = ids.iter().map(|i| i.as_str().unwrap()).collect();
                    a.push("--ids".into());
                    a.push(ids.join(","));
                }
                for (flag, key) in [
                    ("--created-after", "created_after"),
                    ("--version", "version"),
                    ("--view", "name"),
                ] {
                    if !body[key].is_null() {
                        a.push(flag.into());
                        a.push(s(key));
                    }
                }
                a
            }
            "/v1/secrets" => {
                let mut a = vec!["secrets".into(), "set".into(), s("name")];
                for host in body["allowed_hosts"].as_array().into_iter().flatten() {
                    a.push("--allowed-host".into());
                    a.push(host.as_str().unwrap().into());
                }
                a
            }
            "/v1/usage" | "/v1/usage/summary" => {
                let (mut a, flags): (Vec<String>, &[(&str, &str)]) = if path == "/v1/usage" {
                    (
                        vec!["usage".into(), "list".into()],
                        &[
                            ("limit", "--limit"),
                            ("from", "--from"),
                            ("to", "--to"),
                            ("run_id", "--run"),
                            ("eval_id", "--eval"),
                            ("kind", "--kind"),
                        ],
                    )
                } else {
                    (
                        vec!["usage".into()],
                        &[("from", "--from"), ("to", "--to"), ("group_by", "--by")],
                    )
                };
                for (key, flag) in flags {
                    if let Some(v) = case["query"][key].as_str() {
                        a.push(flag.to_string());
                        a.push(v.into());
                    }
                }
                a
            }
            p if p.starts_with("/v1/runs/") && p.ends_with("/events") => vec![
                "runs".into(),
                "events".into(),
                p.trim_start_matches("/v1/runs/")
                    .trim_end_matches("/events")
                    .into(),
                "--limit".into(),
                case["query"]["limit"].as_str().unwrap().into(),
            ],
            "/v1/sources/src_01J9X/sync" => {
                let mut a = vec!["sources".into(), "sync".into(), "src_01J9X".into()];
                if body["full"] == json!(true) {
                    a.push("--full".into());
                }
                a
            }
            p if p.starts_with("/v1/datasets/") && p.ends_with("/sources") => {
                let provider = &body["provider"];
                let field = |k: &str| provider[k].as_str().map(str::to_string);
                let mut a: Vec<String> = vec![
                    "sources".into(),
                    "add".into(),
                    field("kind").unwrap(),
                    "--dataset".into(),
                    p.trim_start_matches("/v1/datasets/")
                        .trim_end_matches("/sources")
                        .into(),
                ];
                for (flag, key) in [
                    ("--host", "host"),
                    ("--secret", "secret"),
                    ("--project", "project"),
                ] {
                    if let Some(v) = field(key) {
                        a.push(flag.into());
                        a.push(v);
                    }
                }
                for (k, v) in provider["filters"].as_object().into_iter().flatten() {
                    a.push("--filter".into());
                    a.push(format!("{}={}", k, v));
                }
                if let Some(cron) = body["schedule"].as_str() {
                    a.push("--schedule".into());
                    a.push(cron.into());
                }
                for key in [
                    "sample_rate",
                    "max_records_per_sync",
                    "max_records_per_day",
                    "version_interval",
                ] {
                    if !body[key].is_null() {
                        a.push(format!("--{}", key.replace('_', "-")));
                        a.push(body[key].to_string());
                    }
                }
                a
            }
            "/v1/sources/src_01J9X" => {
                let mut a: Vec<String> =
                    vec!["sources".into(), "update".into(), "src_01J9X".into()];
                for (k, v) in body["filters"].as_object().into_iter().flatten() {
                    a.push("--filter".into());
                    a.push(format!("{}={}", k, v));
                }
                for (key, v) in body.as_object().unwrap() {
                    if key != "filters" {
                        a.push(format!("--{}", key.replace('_', "-")));
                        // null clears a cap: 0 on the command line.
                        a.push(if v.is_null() {
                            "0".into()
                        } else {
                            v.to_string()
                        });
                    }
                }
                a
            }
            other => panic!("no CLI command for {}", other),
        };
        if let Some(k) = case["idempotency_key"].as_str() {
            args.push("--idempotency-key".into());
            args.push(k.into());
        }
        let argv: Vec<&str> = args.iter().map(String::as_str).collect();
        // `grad secrets set` reads the value from stdin, with a trailing newline.
        let stdin = body["value"]
            .as_str()
            .map(|v| format!("{}\n", v))
            .unwrap_or_default();
        let r = run_stdin(sb.grad(Some(&srv.url)), &argv, &stdin);
        expect(&r, 0);
        let sent = srv
            .last(case["method"].as_str().unwrap(), &path.replace('@', "%40"))
            .unwrap_or_else(|| panic!("{}: nothing sent", name));
        let key = sent.header("idempotency-key").unwrap_or_default();
        if case["method"] == "GET" {
            let got: std::collections::BTreeMap<String, String> = sent
                .query()
                .split('&')
                .filter(|kv| !kv.is_empty())
                .map(|kv| {
                    let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
                    (k.to_string(), v.to_string())
                })
                .collect();
            let want: std::collections::BTreeMap<String, String> = case["query"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(k, v)| (k.clone(), v.as_str().unwrap().to_string()))
                .collect();
            assert_eq!(got, want, "{}", name);
            assert_eq!(key, "", "{}", name);
            continue;
        }
        assert_eq!(norm(&sent.json()), norm(body), "{}", name);
        if case["method"] == "PATCH" || case["method"] == "DELETE" {
            assert_eq!(key, "", "{}", name);
            continue;
        }
        match case["idempotency_key"].as_str() {
            Some(k) => assert_eq!(key, k, "{}", name),
            None => assert_eq!(key.len(), 36, "{}", name),
        }
    }
}
