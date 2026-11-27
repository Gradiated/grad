//! Live CLI suite against the real grad-server started by tests/harness/stack.ts.
//!
//! Skips cleanly when `server/api/node_modules/.bin/tsx` is missing (run
//! `pnpm -C server/api install --frozen-lockfile`). The Cloud/torch test also
//! needs `GRAD_TRAINER_PYTHON` pointing at a Python with the pinned torch stack
//! (for example /root/grad-work/venv-trainer/bin/python); it skips otherwise.

use serde_json::{json, Value};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc;
use std::time::Duration;

fn repo() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf()
}

struct Stack {
    child: Child,
    _stdin: Option<ChildStdin>,
    info: Value,
}

impl Stack {
    fn url(&self) -> String {
        self.info["base_url"].as_str().unwrap().to_string()
    }
    fn key(&self) -> String {
        self.info["api_key"].as_str().unwrap().to_string()
    }
}

impl Drop for Stack {
    fn drop(&mut self) {
        // Closing stdin makes the harness tear everything down; SIGTERM as a backstop.
        self._stdin.take();
        let _ = Command::new("kill")
            .arg(self.child.id().to_string())
            .status();
        let _ = self.child.wait();
    }
}

fn start(args: &[&str]) -> Option<Stack> {
    let tsx = repo().join("server/api/node_modules/.bin/tsx");
    if !tsx.exists() {
        eprintln!(
            "skipping live test: {} not found (pnpm -C server/api install)",
            tsx.display()
        );
        return None;
    }
    let mut child = Command::new(&tsx)
        .arg("../../tests/harness/stack.ts")
        .args(args)
        .current_dir(repo().join("server/api"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .expect("start harness");
    let stdin = child.stdin.take();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = tx.send(line);
    });
    let line = rx
        .recv_timeout(Duration::from_secs(300))
        .expect("harness did not report ready");
    let info: Value = serde_json::from_str(line.trim())
        .unwrap_or_else(|e| panic!("harness output {:?}: {}", line, e));
    Some(Stack {
        child,
        _stdin: stdin,
        info,
    })
}

struct Home {
    dir: PathBuf,
}

impl Home {
    fn new(tag: &str) -> Home {
        let base = std::env::var_os("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        let dir = base.join(format!("grad-live-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        Home { dir }
    }
}

impl Drop for Home {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

struct Out {
    code: i32,
    stdout: String,
    stderr: String,
}

impl Out {
    fn json(&self) -> Value {
        serde_json::from_str(&self.stdout)
            .unwrap_or_else(|e| panic!("{}: {}\n{}", e, self.stdout, self.stderr))
    }
}

fn grad(home: &Home, args: &[&str], extra_env: &[(&str, &str)]) -> Out {
    let mut c = Command::new(assert_cmd::cargo::cargo_bin("grad"));
    c.args(args)
        .current_dir(&home.dir)
        .env("HOME", &home.dir)
        .env("XDG_CONFIG_HOME", home.dir.join("xdg"))
        .env_remove("GRADIATED_API_KEY")
        .env_remove("GRADIATED_BASE_URL")
        .env_remove("GRADIATED_PROFILE")
        .stdin(Stdio::null());
    for (k, v) in extra_env {
        c.env(k, v);
    }
    let out = c.output().unwrap();
    Out {
        code: out.status.code().unwrap_or(-1),
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
    }
}

fn ok(o: &Out) {
    assert_eq!(o.code, 0, "stdout:\n{}\nstderr:\n{}", o.stdout, o.stderr);
}

fn write_sft(path: &Path, n: usize) {
    let mut s = String::new();
    for i in 0..n {
        s.push_str(
            &json!({"session_id": format!("s{}", i), "messages": [
                {"role": "user", "content": format!("Reset my password {}", i)},
                {"role": "assistant", "content": "Open Settings, then Security."}]})
            .to_string(),
        );
        s.push('\n');
    }
    std::fs::write(path, s).unwrap();
}

/// `GET /__fault/stats` from the harness fault proxy (plain HTTP/1.0).
fn fault_stats(fault_url: &str) -> Value {
    use std::io::{Read, Write};
    let addr = fault_url.trim_start_matches("http://");
    let mut conn = std::net::TcpStream::connect(addr).unwrap();
    write!(
        conn,
        "GET /__fault/stats HTTP/1.0\r\nHost: {}\r\n\r\n",
        addr
    )
    .unwrap();
    let mut text = String::new();
    conn.read_to_string(&mut text).unwrap();
    serde_json::from_str(text.split("\r\n\r\n").nth(1).unwrap_or("")).unwrap()
}

#[test]
fn live_post_whose_response_was_lost_is_replayed() {
    let Some(stack) = start(&["--auth", "api_key", "--worker", "none"]) else {
        return;
    };
    let home = Home::new("idempotent");
    let key = stack.key();
    let fault_url = stack.info["fault_url"].as_str().unwrap().to_string();
    // The fault proxy lets the server commit the first attempt, then answers 503; the
    // retry carries the same Idempotency-Key, so the server replays 201 instead of 409.
    let flaky = [
        ("GRADIATED_BASE_URL", fault_url.as_str()),
        ("GRADIATED_API_KEY", key.as_str()),
    ];
    let o = grad(
        &home,
        &["--json", "datasets", "create", "rs-idempotent"],
        &flaky,
    );
    ok(&o);
    assert!(
        o.json().to_string().contains("rs-idempotent"),
        "{}",
        o.stdout
    );
    let stats = fault_stats(&fault_url);
    assert!(stats["dropped"].as_u64() >= Some(1), "{}", stats);
    assert!(stats["replayed"].as_u64() >= Some(1), "{}", stats);
    let url = stack.url();
    let direct = [
        ("GRADIATED_BASE_URL", url.as_str()),
        ("GRADIATED_API_KEY", key.as_str()),
    ];
    let again = grad(&home, &["datasets", "create", "rs-idempotent"], &direct);
    assert_eq!(
        again.code, 5,
        "a new logical create is not replayed: {}",
        again.stderr
    );
}

#[test]
fn live_self_hosted_quickstart() {
    let Some(stack) = start(&["--auth", "api_key", "--worker", "reference"]) else {
        return;
    };
    let home = Home::new("selfhosted");
    let url = stack.url();
    let key = stack.key();

    // grad login (validated against the server).
    ok(&grad(
        &home,
        &["login", "--base-url", &url, "--api-key", &key],
        &[],
    ));
    let o = grad(
        &home,
        &[
            "login",
            "--profile",
            "bad",
            "--base-url",
            &url,
            "--api-key",
            "grad_not_a_key",
        ],
        &[],
    );
    assert_eq!(o.code, 3, "{}", o.stderr);

    // grad import (upload + import job run by the worker).
    write_sft(&home.dir.join("support_traces.jsonl"), 40);
    let o = grad(
        &home,
        &[
            "import",
            "./support_traces.jsonl",
            "--dataset",
            "support-prod",
        ],
        &[],
    );
    ok(&o);
    assert!(o.stdout.contains("imported 40 records"), "{}", o.stdout);

    // grad train --dry-run / --wait.
    let o = grad(
        &home,
        &[
            "--json",
            "train",
            "--dataset",
            "support-prod",
            "--name",
            "support-sft",
            "--recipe",
            "sft",
            "--model",
            "test/tiny-qwen3",
            "--batch-size",
            "8",
            "--dry-run",
        ],
        &[],
    );
    ok(&o);
    assert!(o.json()["data"]["estimated_steps"].as_u64().unwrap() >= 1);
    let o = grad(
        &home,
        &[
            "train",
            "--dataset",
            "support-prod",
            "--name",
            "support-sft",
            "--recipe",
            "sft",
            "--model",
            "test/tiny-qwen3",
            "--batch-size",
            "8",
            "--wait",
        ],
        &[],
    );
    ok(&o);
    assert!(
        o.stdout.contains("✓ Trained test/tiny-qwen3 sft"),
        "{}",
        o.stdout
    );
    assert!(
        o.stdout.contains("✓ Exported artifact support-sft@"),
        "{}",
        o.stdout
    );

    // Round-trip the run config.
    let o = grad(&home, &["runs", "inspect", "support-sft", "--yaml"], &[]);
    ok(&o);
    std::fs::write(home.dir.join("recipe.yaml"), &o.stdout).unwrap();
    ok(&grad(
        &home,
        &["train", "-f", "recipe.yaml", "--dry-run"],
        &[],
    ));
    let o = grad(&home, &["runs", "logs", "support-sft"], &[]);
    ok(&o);
    assert!(o.stdout.contains("STEP"));

    // grad artifacts download --output DIR (verified + extracted).
    let o = grad(
        &home,
        &[
            "artifacts",
            "download",
            "support-sft@latest",
            "--output",
            "./support-sft",
        ],
        &[],
    );
    ok(&o);
    assert!(home.dir.join("support-sft/manifest.json").is_file());

    // Self-hosted: no hosted serving, exit 6 with the download hint.
    let o = grad(&home, &["--json", "deploy", "support-sft@latest"], &[]);
    assert_eq!(o.code, 6, "{}", o.stderr);
    let e: Value = serde_json::from_str(&o.stderr).unwrap();
    assert_eq!(e["error"]["code"], "deploy_unavailable");

    // grad eval against the harness's OpenAI-compatible inference fixture.
    std::fs::write(
        home.dir.join("rubric.yaml"),
        "- name: nonempty\n  kind: validator\n  validator: non_empty\n",
    )
    .unwrap();
    let o = grad(
        &home,
        &[
            "eval",
            "--name",
            "smoke",
            "--models",
            "qwen/qwen3-8b",
            "--dataset",
            "support-prod",
            "--rubric",
            "rubric.yaml",
            "--limit",
            "5",
            "--wait",
        ],
        &[],
    );
    ok(&o);
    assert!(o.stdout.contains("qwen/qwen3-8b"), "{}", o.stdout);

    // Scoped keys: a runs:read key cannot push data (exit 3).
    let o = grad(
        &home,
        &[
            "--json",
            "keys",
            "create",
            "--name",
            "ci",
            "--scopes",
            "runs:read",
        ],
        &[],
    );
    ok(&o);
    let secret = o.json()["data"]["secret"].as_str().unwrap().to_string();
    let o = grad(
        &home,
        &[
            "--api-key",
            &secret,
            "datasets",
            "push",
            "x",
            "./support_traces.jsonl",
        ],
        &[],
    );
    assert_eq!(o.code, 3, "{}", o.stderr);
    ok(&grad(&home, &["--api-key", &secret, "runs", "list"], &[]));
}

fn torch_python() -> Option<String> {
    let py = std::env::var("GRAD_TRAINER_PYTHON").ok()?;
    let ok = Command::new(&py)
        .args(["-c", "import torch, transformers, peft"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(false);
    if ok {
        Some(py)
    } else {
        None
    }
}

#[test]
fn live_cloud_quickstart_with_torch_worker() {
    if torch_python().is_none() {
        eprintln!(
            "skipping: set GRAD_TRAINER_PYTHON to a Python with torch, transformers and peft"
        );
        return;
    }
    let Some(stack) = start(&["--cloud", "--worker", "torch"]) else {
        return;
    };
    let home = Home::new("cloud");
    let url = stack.url();
    ok(&grad(
        &home,
        &["login", "--base-url", &url, "--api-key", &stack.key()],
        &[],
    ));

    // Router traces with per-model scores.
    let mut s = String::new();
    for i in 0..60 {
        let hard = i % 2 == 0;
        let prompt = format!(
            "{} {}",
            if hard {
                "hard SQL join query"
            } else {
                "say hello"
            },
            i
        );
        s.push_str(
            &json!({"session_id": format!("s{}", i), "messages": [{"role": "user", "content": prompt}],
                    "scores": {"cheap/m": if hard { 0.0 } else { 1.0 }, "strong/m": 1.0}})
            .to_string(),
        );
        s.push('\n');
    }
    std::fs::write(home.dir.join("support_traces.jsonl"), s).unwrap();
    ok(&grad(
        &home,
        &[
            "import",
            "./support_traces.jsonl",
            "--dataset",
            "support-prod",
        ],
        &[],
    ));
    let train = |extra: &[&str]| {
        let mut a = vec![
            "train",
            "--dataset",
            "support-prod",
            "--name",
            "support-router",
            "--recipe",
            "router",
            "--model",
            "test/tiny-qwen3",
            "--models",
            "cheap/m,strong/m",
            "--batch-size",
            "8",
        ];
        a.extend_from_slice(extra);
        grad(&home, &a, &[])
    };
    let o = train(&["--dry-run"]);
    ok(&o);
    assert!(o.stdout.contains("Plan for support-router"), "{}", o.stdout);
    let o = train(&["--wait"]);
    ok(&o);
    assert!(o.stdout.contains("Eval report:"), "{}", o.stdout);
    assert!(
        o.stdout.contains("Next: grad deploy support-router@"),
        "{}",
        o.stdout
    );

    let o = grad(
        &home,
        &[
            "artifacts",
            "download",
            "support-router@latest",
            "--output",
            "./support-router",
        ],
        &[],
    );
    ok(&o);
    assert!(home
        .dir
        .join("support-router/adapter_config.json")
        .is_file());
    assert!(home
        .dir
        .join("support-router/adapter_model.safetensors")
        .is_file());

    let o = grad(&home, &["--json", "deploy", "support-router@latest"], &[]);
    ok(&o);
    let first = o.json()["data"]["active_artifact_id"]
        .as_str()
        .unwrap()
        .to_string();
    let o = grad(
        &home,
        &[
            "--json",
            "route",
            "--deployment",
            "support-router",
            "--prompt",
            "hard SQL join query 3",
        ],
        &[],
    );
    ok(&o);
    assert!(o.json()["data"]["inference_id"].as_str().is_some());
    // The fake Cloud routes between the candidates the trainer recorded in the manifest.
    let model = o.json()["data"]["model"]
        .as_str()
        .unwrap_or_default()
        .to_string();
    assert!(
        model == "cheap/m" || model == "strong/m",
        "routed to {model:?}, not a trained candidate"
    );

    // A second version (promoted checkpoint), then roll back to the first.
    let o = grad(
        &home,
        &["--json", "runs", "checkpoints", "support-router"],
        &[],
    );
    ok(&o);
    let ckpt = o.json()["data"]["data"][0]["id"]
        .as_str()
        .unwrap()
        .to_string();
    ok(&grad(
        &home,
        &["runs", "promote", &ckpt, "--name", "support-router"],
        &[],
    ));
    let o = grad(&home, &["--json", "deploy", "support-router@latest"], &[]);
    ok(&o);
    assert_ne!(
        o.json()["data"]["active_artifact_id"].as_str().unwrap(),
        first
    );
    let o = grad(&home, &["--json", "rollback", "support-router"], &[]);
    ok(&o);
    assert_eq!(o.json()["data"]["active_artifact_id"], first.as_str());
    let o = grad(&home, &["deployments", "status", "support-router"], &[]);
    ok(&o);
}
