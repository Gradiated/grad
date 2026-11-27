//! Live CLI suite against the real grad-server started by tests/harness/stack.ts.
//!
//! Skips cleanly when `server/api/node_modules/.bin/tsx` is missing (run
//! `pnpm -C server/api install --frozen-lockfile`) or `GRAD_SKIP_LIVE=1` is set.
//! The torch test also uploads the harness's tiny LoRAs (`grad artifacts
//! upload`), valid and invalid, and plans continued training from one. It
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
    if std::env::var("GRAD_SKIP_LIVE").as_deref() == Ok("1") {
        eprintln!("skipping live test: GRAD_SKIP_LIVE=1");
        return None;
    }
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
            "--set",
            "warmup=0",
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

    // The run is billed: in this month's summary, and listed by its name.
    let o = grad(&home, &["--json", "usage", "--by", "kind"], &[]);
    ok(&o);
    let summary = o.json()["data"].clone();
    assert!(summary["tokens"].as_u64().unwrap() > 0, "{}", summary);
    assert!(
        summary["top_runs"]
            .as_array()
            .unwrap()
            .iter()
            .any(|r| r["name"] == "support-sft"),
        "{}",
        summary
    );
    assert!(
        summary["groups"]
            .as_array()
            .unwrap()
            .iter()
            .any(|g| g["key"] == "training"),
        "{}",
        summary
    );
    let o = grad(
        &home,
        &[
            "--json",
            "usage",
            "list",
            "--run",
            "support-sft",
            "--kind",
            "training",
        ],
        &[],
    );
    ok(&o);
    let rows = o.json()["data"]["data"].as_array().unwrap().clone();
    assert!(!rows.is_empty());
    assert!(
        rows.iter().all(|r| r["ref_name"] == "support-sft"),
        "{:?}",
        rows
    );
    let o = grad(&home, &["usage", "list", "--from", "2026-02-30"], &[]);
    assert_eq!(o.code, 2, "{}", o.stderr);

    // Round-trip the run config: re-planning the exported file resolves exactly
    // the same config (zero values such as warmup=0 included).
    let o = grad(&home, &["runs", "inspect", "support-sft", "--yaml"], &[]);
    ok(&o);
    std::fs::write(home.dir.join("recipe.yaml"), &o.stdout).unwrap();
    let replanned = grad(
        &home,
        &["--json", "train", "-f", "recipe.yaml", "--dry-run"],
        &[],
    );
    ok(&replanned);
    let o = grad(&home, &["--json", "runs", "inspect", "support-sft"], &[]);
    ok(&o);
    let mut original = o.json()["data"]["resolved_config"].clone();
    let mut again = replanned.json()["data"]["resolved_config"].clone();
    assert_eq!(original["warmup"], 0.0);
    // The file pins the auto-resolved lr as a number, so only its provenance differs.
    assert_eq!(again["lr_source"], "explicit");
    original["lr_source"] = Value::Null;
    again["lr_source"] = Value::Null;
    assert_eq!(again, original);
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

    // A trained artifact records its run.
    let o = grad(
        &home,
        &["--json", "artifacts", "inspect", "support-sft@latest"],
        &[],
    );
    ok(&o);
    let a: Value = serde_json::from_str(&o.stdout).unwrap();
    assert_eq!(a["data"]["provenance"]["source"], "run");

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

    // grad datasets score / filter: score the records' own answers, then keep the passing ones.
    std::fs::write(
        home.dir.join("score.yaml"),
        "- name: mentions_settings\n  kind: regex\n  pattern: Settings\n",
    )
    .unwrap();
    let o = grad(
        &home,
        &[
            "datasets",
            "score",
            "support-prod",
            "--rubric",
            "score.yaml",
            "--wait",
        ],
        &[],
    );
    ok(&o);
    assert!(
        o.stdout.contains("Scored dataset support-prod"),
        "{}",
        o.stdout
    );
    let o = grad(
        &home,
        &[
            "--json",
            "datasets",
            "filter",
            "support-prod",
            "--score",
            "mentions_settings>=1",
        ],
        &[],
    );
    ok(&o);
    let view: Value = serde_json::from_str(&o.stdout).unwrap();
    assert!(
        view["data"]["record_count"].as_i64().unwrap_or(0) > 0,
        "{}",
        o.stdout
    );

    // recipe evals and loggers in a run file: the plan pins the eval's dataset version.
    std::fs::write(
        home.dir.join("tracked.yaml"),
        "dataset: support-prod\nname: tracked\nrecipe: sft\nmodel: test/tiny-qwen3\nevals:\n  - dataset: support-prod\n    limit: 5\nloggers:\n  - kind: mlflow\n    tracking_uri: http://127.0.0.1:9\n",
    )
    .unwrap();
    let o = grad(
        &home,
        &["--json", "train", "-f", "tracked.yaml", "--dry-run"],
        &[],
    );
    ok(&o);
    let plan: Value = serde_json::from_str(&o.stdout).unwrap();
    let pinned = &plan["data"]["resolved_config"]["checkpoint_evals"][0];
    assert_eq!(pinned["dataset"], "support-prod", "{}", o.stdout);
    assert_eq!(pinned["limit"], 5, "{}", o.stdout);

    // A built-in benchmark import is queued with its pinned source.
    let o = grad(
        &home,
        &[
            "--json",
            "datasets",
            "import",
            "benchmark",
            "gsm8k",
            "--limit",
            "5",
            "--no-wait",
        ],
        &[],
    );
    ok(&o);
    let job: Value = serde_json::from_str(&o.stdout).unwrap();
    assert_eq!(job["data"]["dataset"], "gsm8k-5", "{}", o.stdout);
    assert_eq!(job["data"]["source"]["benchmark"], "gsm8k", "{}", o.stdout);

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

/// Run `grad` on a pseudo-terminal (util-linux `script`, 100x30), typing
/// `keys` after the given delays. Returns the exit code and the raw output.
fn grad_pty(
    home: &Home,
    args: &[&str],
    extra_env: &[(&str, &str)],
    keys: &[(u64, &str)],
) -> Option<(i32, String)> {
    if Command::new("script").arg("--version").output().is_err() {
        eprintln!("skipping pty check: util-linux `script` not found");
        return None;
    }
    let quoted: Vec<String> = args.iter().map(|a| format!("'{}'", a)).collect();
    let cmd = format!(
        "stty rows 30 cols 100; exec '{}' {}",
        assert_cmd::cargo::cargo_bin("grad").display(),
        quoted.join(" ")
    );
    let log = home.dir.join("pty.log");
    let mut c = Command::new("timeout");
    c.arg("120")
        .args(["script", "-qfec", &cmd])
        .arg(&log)
        .current_dir(&home.dir)
        .env("HOME", &home.dir)
        .env("XDG_CONFIG_HOME", home.dir.join("xdg"))
        .env("TERM", "xterm-256color")
        .env_remove("GRADIATED_API_KEY")
        .env_remove("GRADIATED_BASE_URL")
        .env_remove("GRAD_NO_TUI")
        .stdin(Stdio::piped())
        .stdout(Stdio::null());
    for (k, v) in extra_env {
        c.env(k, v);
    }
    let mut child = c.spawn().unwrap();
    let mut stdin = child.stdin.take().unwrap();
    for (delay, k) in keys {
        std::thread::sleep(Duration::from_millis(*delay));
        use std::io::Write;
        let _ = stdin.write_all(k.as_bytes());
        let _ = stdin.flush();
    }
    // Keep stdin open until grad exits: EOF would end the session early.
    let code = child.wait().unwrap().code().unwrap_or(-1);
    drop(stdin);
    let out = String::from_utf8_lossy(&std::fs::read(&log).unwrap()).into_owned();
    Some((code, out))
}

/// The part of a pty transcript printed after the TUI left the alternate screen.
fn after_tui(out: &str) -> &str {
    out.rfind("\x1b[?1049l").map_or("", |i| &out[i..])
}

#[test]
fn live_tui_follows_detaches_and_cancels_a_run() {
    let Some(stack) = start(&["--worker", "reference"]) else {
        return;
    };
    let home = Home::new("tui");
    let url = stack.url();
    let key = stack.key();
    let env = [
        ("GRADIATED_BASE_URL", url.as_str()),
        ("GRADIATED_API_KEY", key.as_str()),
    ];
    write_sft(&home.dir.join("traces.jsonl"), 200);
    ok(&grad(
        &home,
        &["import", "./traces.jsonl", "--dataset", "support-prod"],
        &env,
    ));
    let train = |name: &'static str, epochs: &'static str| {
        vec![
            "train",
            "--dataset",
            "support-prod",
            "--name",
            name,
            "--recipe",
            "sft",
            "--model",
            "test/tiny-qwen3",
            "--batch-size",
            "1",
            "--epochs",
            epochs,
            "--wait",
        ]
    };

    // Followed to the end: full screen, then the usual report on the main screen.
    let Some((code, out)) = grad_pty(&home, &train("tui-short", "1"), &env, &[]) else {
        return;
    };
    assert_eq!(code, 0, "{}", out);
    assert!(out.contains("\x1b[?1049h"), "entered the alternate screen");
    assert!(
        out.contains("\x1b[?2026h"),
        "frames use synchronized updates"
    );
    assert!(out.contains("tui-short"), "the header names the run");
    assert!(out.contains("Training"), "the phase line");
    assert!(
        !out.to_lowercase().contains("spot"),
        "interruptions are worded neutrally"
    );
    let tail = after_tui(&out);
    assert!(tail.contains("✓ Trained test/tiny-qwen3 sft"), "{}", tail);
    assert!(tail.contains("✓ Exported artifact tui-short@"), "{}", tail);
    assert!(!tail.contains("\x1b[?1049h"), "the TUI did not come back");

    // q detaches; the run keeps going and the reattach command is printed.
    let (code, out) = grad_pty(&home, &train("tui-long", "20"), &env, &[(3000, "q")]).unwrap();
    assert_eq!(code, 130, "{}", out);
    let tail = after_tui(&out);
    assert!(tail.contains("keeps going on the server"), "{}", tail);
    let id = tail
        .split("grad runs watch ")
        .nth(1)
        .and_then(|s| s.split('`').next())
        .expect("reattach hint")
        .to_string();
    let o = grad(&home, &["--json", "runs", "inspect", &id], &env);
    ok(&o);
    assert_ne!(o.json()["data"]["status"], "cancelled");

    // Attached past step 1, the plain readout starts from step 1 too.
    let (_, out) = grad_pty(
        &home,
        &["--plain", "runs", "watch", &id, "--timeout", "3"],
        &env,
        &[],
    )
    .unwrap();
    assert!(
        out.contains("step     1/"),
        "step-1 data on attach: {}",
        out
    );

    // Reattach with `runs watch`, then cancel with confirmation.
    let (code, out) = grad_pty(
        &home,
        &["runs", "watch", &id],
        &env,
        &[(2000, "c"), (500, "y")],
    )
    .unwrap();
    assert_eq!(code, 7, "{}", out);
    assert!(out.contains("Cancelling"), "{}", out);
    assert!(after_tui(&out).contains("status cancelled"), "{}", out);
    // Reattached past step 1, the view replays the run from its first event
    // (r8 trial: it showed only the points since attaching).
    assert!(
        out.contains("Starting") && out.contains("Run created"),
        "the event history from the start: {}",
        out
    );

    // --plain and GRAD_NO_TUI=1 keep the line output on a terminal.
    for (flag, extra) in [("--plain", None), ("", Some(("GRAD_NO_TUI", "1")))] {
        let mut a = vec!["runs", "watch", id.as_str()];
        if !flag.is_empty() {
            a.insert(0, flag);
        }
        let mut e = env.to_vec();
        e.extend(extra);
        let (code, out) = grad_pty(&home, &a, &e, &[]).unwrap();
        assert_eq!(code, 7, "{}", out);
        assert!(
            !out.contains("\x1b[?1049h"),
            "{} must not open the TUI",
            flag
        );
    }
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
fn live_router_quickstart_with_torch_worker() {
    if torch_python().is_none() {
        eprintln!(
            "skipping: set GRAD_TRAINER_PYTHON to a Python with torch, transformers and peft"
        );
        return;
    }
    let Some(stack) = start(&["--worker", "torch"]) else {
        return;
    };
    let home = Home::new("torch");
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
        o.stdout
            .contains("Next: grad artifacts download support-router@"),
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

    // docs: artifacts.mdx "Upload or import an artifact": the harness's tiny LoRAs.
    let lora = stack.info["tiny_lora"].as_str().unwrap();
    let o = grad(
        &home,
        &[
            "--json",
            "artifacts",
            "upload",
            lora,
            "--base",
            "test/tiny-qwen3",
            "--name",
            "uploaded-lora",
        ],
        &[],
    );
    ok(&o);
    let up: Value = serde_json::from_str(&o.stdout).unwrap();
    assert_eq!(up["data"]["provenance"]["source"], "upload");
    let uploaded = up["data"]["id"].as_str().unwrap().to_string();
    let bad = stack.info["tiny_lora_invalid"].as_str().unwrap();
    let o = grad(
        &home,
        &["artifacts", "upload", bad, "--base", "test/tiny-qwen3"],
        &[],
    );
    assert_eq!(o.code, 5, "{}", o.stderr);
    assert!(
        o.stderr
            .contains("adapter_config.json: base_model_name_or_path is 'Qwen/Qwen3-8B'"),
        "{}",
        o.stderr
    );
    std::fs::write(
        home.dir.join("prefs.jsonl"),
        (0..12)
            .map(|i| format!("{}\n", json!({"prompt": format!("Count users {i}"), "chosen": "SELECT count(*) FROM users;", "rejected": "no idea"})))
            .collect::<String>(),
    )
    .unwrap();
    ok(&grad(
        &home,
        &["import", "./prefs.jsonl", "--dataset", "upload-prefs"],
        &[],
    ));
    let o = grad(
        &home,
        &[
            "train",
            "--dataset",
            "upload-prefs",
            "--name",
            "dpo-from-upload",
            "--recipe",
            "dpo",
            "--model",
            &uploaded,
            "--dry-run",
        ],
        &[],
    );
    ok(&o);
    assert!(o.stdout.contains(&uploaded), "{}", o.stdout);
    ok(&grad(&home, &["artifacts", "delete", &uploaded], &[]));

    // docs: recipes/distillation.mdx (YAML) and recipes/reward-models.mdx (flags), tiny models.
    let prompts: String = (0..12)
        .map(|i| format!("{}\n", json!({"messages": [{"role": "user", "content": format!("How do I rotate API key {i}?")}]})))
        .collect();
    std::fs::write(home.dir.join("prompts.jsonl"), prompts).unwrap();
    ok(&grad(
        &home,
        &["import", "./prompts.jsonl", "--dataset", "support-prompts"],
        &[],
    ));
    std::fs::write(
        home.dir.join("distill.yaml"),
        "dataset: support-prompts\nname: support-distilled\nrecipe: distill\nmodel: test/tiny-qwen3\nteacher: test/tiny-qwen3-teacher\nrollout: {kind: on_policy, max_new_tokens: 4}\nbatch_size: 4\n",
    )
    .unwrap();
    let o = grad(&home, &["train", "-f", "distill.yaml", "--dry-run"], &[]);
    ok(&o);
    assert!(
        o.stdout.contains("test/tiny-qwen3-teacher: ~"),
        "{}",
        o.stdout
    );
    ok(&grad(
        &home,
        &["train", "-f", "distill.yaml", "--wait"],
        &[],
    ));
    let pairs: String = (0..16)
        .map(|i| format!("{}\n", json!({"prompt": format!("Count users {i}"), "chosen": "SELECT count(*) FROM users;", "rejected": "no idea"})))
        .collect();
    std::fs::write(home.dir.join("pairs.jsonl"), pairs).unwrap();
    ok(&grad(
        &home,
        &["import", "./pairs.jsonl", "--dataset", "sql-preferences"],
        &[],
    ));
    let o = grad(
        &home,
        &[
            "train",
            "--dataset",
            "sql-preferences",
            "--name",
            "sql-verifier",
            "--recipe",
            "reward-model",
            "--model",
            "test/tiny-qwen3",
            "--batch-size",
            "4",
            "--wait",
        ],
        &[],
    );
    ok(&o);
    let o = grad(
        &home,
        &["--json", "artifacts", "inspect", "sql-verifier@latest"],
        &[],
    );
    ok(&o);
    assert_eq!(o.json()["data"]["format"], "reward_bundle");
}
