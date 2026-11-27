//! The flat run-config YAML used by `grad train -f` and written by
//! `grad runs inspect RUN --yaml`:
//!
//! ```yaml
//! dataset: support-prod        # or {name: support-prod}
//! name: support-router
//! recipe: router               # recipe kind (decision-model, reward-model, ... accepted)
//! model: qwen/qwen3-0.6b
//! adapter: {kind: lora, rank: 64}
//! split: {strategy: by_session, eval_fraction: 0.1, seed: 42}
//! max_cost_usd: 20
//! context: {file: ./docs.md}   # cartridge: read into context_text
//! ```
//!
//! Every other top-level key is a recipe parameter. Unknown keys are errors so
//! a typo (`lerning_rate`) never trains silently with the default.

use grad_sdk::{recipes, PlanRunRequest, RecipeSpec, Run, SplitSpec};
use serde_json::{Map, Value};
use std::path::{Path, PathBuf};

use crate::output::{CliError, CliResult};

/// Recipe parameters accepted at the top level of a run file: every
/// `RecipeSpec` property (generated from the OpenAPI schema) except `kind`.
fn recipe_keys() -> impl Iterator<Item = &'static str> {
    RecipeSpec::FIELDS.iter().copied().filter(|k| *k != "kind")
}

fn is_recipe_key(k: &str) -> bool {
    recipe_keys().any(|r| r == k)
}

const RUN_KEYS: &[&str] = &[
    "dataset",
    "name",
    "recipe",
    "split",
    "max_cost_usd",
    "context",
];

/// A parsed run file: run-level fields plus recipe parameters.
#[derive(Debug, Default, Clone)]
pub struct RunFile {
    pub dataset: Option<String>,
    pub name: Option<String>,
    pub recipe: Option<String>,
    pub split: Option<Value>,
    pub max_cost_usd: Option<f64>,
    pub params: Map<String, Value>,
}

fn yaml_to_json(path: &Path, raw: &str) -> CliResult<Value> {
    let v: serde_norway::Value = serde_norway::from_str(raw)
        .map_err(|e| CliError::usage(format!("{}: invalid YAML: {}", path.display(), e)))?;
    serde_json::to_value(v)
        .map_err(|e| CliError::usage(format!("{}: unsupported YAML value: {}", path.display(), e)))
}

fn closest<'a>(key: &str, options: impl Iterator<Item = &'a str>) -> Option<&'a str> {
    let mut best: Option<(&str, usize)> = None;
    for o in options {
        let d = strsim(key, o);
        if d <= 3 && best.is_none_or(|(_, bd)| d < bd) {
            best = Some((o, d));
        }
    }
    best.map(|(o, _)| o)
}

/// Levenshtein distance (small inputs only).
fn strsim(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    for i in 1..=a.len() {
        let mut cur = vec![i; b.len() + 1];
        for j in 1..=b.len() {
            let cost = usize::from(a[i - 1] != b[j - 1]);
            cur[j] = (prev[j] + 1).min(cur[j - 1] + 1).min(prev[j - 1] + cost);
        }
        prev = cur;
    }
    prev[b.len()]
}

/// Parse a run file. Relative `context.file` paths resolve against the file's directory.
pub fn parse(path: &Path) -> CliResult<RunFile> {
    let raw = std::fs::read_to_string(path)
        .map_err(|e| CliError::usage(format!("{}: {}", path.display(), e)))?;
    parse_str(path, &raw)
}

pub fn parse_str(path: &Path, raw: &str) -> CliResult<RunFile> {
    let v = yaml_to_json(path, raw)?;
    let Value::Object(map) = v else {
        return Err(CliError::usage(format!(
            "{}: expected a mapping of run settings (dataset, name, recipe, ...)",
            path.display()
        )));
    };
    let base_dir = path
        .parent()
        .map(Path::to_path_buf)
        .unwrap_or_else(|| PathBuf::from("."));
    let mut rf = RunFile::default();
    for (k, val) in map {
        match k.as_str() {
            "dataset" => match val {
                Value::String(s) => rf.dataset = Some(s),
                Value::Object(m) => {
                    if let Some(f) = m.keys().find(|k| *k != "name") {
                        return Err(CliError::usage(format!(
                            "{}: dataset.{} is not supported in v0; filter the records before pushing them, then reference the dataset by name",
                            path.display(), f
                        )));
                    }
                    rf.dataset = m.get("name").and_then(Value::as_str).map(str::to_string);
                }
                other => {
                    return Err(CliError::usage(format!(
                        "{}: dataset must be a name, got {}",
                        path.display(),
                        other
                    )))
                }
            },
            "name" => rf.name = val.as_str().map(str::to_string),
            "recipe" => match val {
                Value::String(s) => rf.recipe = Some(s),
                Value::Object(m) => {
                    // Nested form: recipe: {kind: sft, lr: ...}
                    for (rk, rv) in m {
                        if rk == "kind" {
                            rf.recipe = rv.as_str().map(str::to_string);
                        } else {
                            rf.params.insert(rk, rv);
                        }
                    }
                }
                other => {
                    return Err(CliError::usage(format!(
                        "{}: recipe must be a name like sft or router, got {}",
                        path.display(),
                        other
                    )))
                }
            },
            "split" => rf.split = Some(val),
            "max_cost_usd" => {
                rf.max_cost_usd = Some(val.as_f64().ok_or_else(|| {
                    CliError::usage(format!("{}: max_cost_usd must be a number", path.display()))
                })?)
            }
            "context" => match val {
                Value::String(s) => {
                    rf.params.insert("context_text".into(), Value::String(s));
                }
                Value::Object(m) => {
                    if let Some(f) = m.get("file").and_then(Value::as_str) {
                        let p = base_dir.join(f);
                        let text = std::fs::read_to_string(&p).map_err(|e| {
                            CliError::usage(format!(
                                "{}: context.file {}: {}",
                                path.display(),
                                p.display(),
                                e
                            ))
                        })?;
                        rf.params.insert("context_text".into(), Value::String(text));
                    } else if let Some(t) = m.get("text") {
                        rf.params.insert("context_text".into(), t.clone());
                    } else if let Some(u) = m.get("uri") {
                        rf.params.insert("context_uri".into(), u.clone());
                    } else {
                        return Err(CliError::usage(format!(
                            "{}: context needs file, text or uri",
                            path.display()
                        )));
                    }
                }
                _ => {
                    return Err(CliError::usage(format!(
                        "{}: context must be text or {{file: PATH}}",
                        path.display()
                    )))
                }
            },
            other if is_recipe_key(other) => {
                rf.params.insert(k, val);
            }
            other => {
                let all = RUN_KEYS.iter().copied().chain(recipe_keys());
                let hint = closest(other, all)
                    .map(|c| format!(" (did you mean '{}'?)", c))
                    .unwrap_or_default();
                return Err(CliError::usage(format!(
                    "{}: unknown setting '{}'{}",
                    path.display(),
                    other,
                    hint
                )));
            }
        }
    }
    Ok(rf)
}

/// Parse `KEY=VALUE` with VALUE as a YAML scalar/flow value.
pub fn parse_set(spec: &str) -> CliResult<(String, Value)> {
    let (k, v) = spec
        .split_once('=')
        .ok_or_else(|| CliError::usage(format!("--set expects KEY=VALUE, got '{}'", spec)))?;
    let k = k.trim().to_string();
    if !is_recipe_key(&k) {
        let hint = closest(&k, recipe_keys())
            .map(|c| format!(" (did you mean '{}'?)", c))
            .unwrap_or_default();
        return Err(CliError::usage(format!(
            "--set: unknown recipe parameter '{}'{}",
            k, hint
        )));
    }
    let val = yaml_to_json(Path::new("--set"), v)?;
    Ok((k, val))
}

/// Assemble a typed request; field types are checked by the SDK model.
pub fn build_request(rf: RunFile) -> CliResult<PlanRunRequest> {
    let dataset = rf
        .dataset
        .ok_or_else(|| CliError::usage("missing --dataset (or `dataset:` in the run file)"))?;
    let name = rf
        .name
        .ok_or_else(|| CliError::usage("missing --name (or `name:` in the run file)"))?;
    let recipe_name = rf
        .recipe
        .ok_or_else(|| CliError::usage("missing --recipe (or `recipe:` in the run file)"))?;
    let kind = recipes::parse_kind(&recipe_name).ok_or_else(|| {
        CliError::usage(format!(
            "unknown recipe '{}'; expected one of {}",
            recipe_name,
            recipes::RECIPE_NAMES
        ))
    })?;
    let mut params = rf.params;
    params.insert("kind".into(), Value::String(kind.as_str().into()));
    let recipe: RecipeSpec = serde_json::from_value(Value::Object(params))
        .map_err(|e| CliError::usage(format!("invalid recipe parameter: {}", e)))?;
    let split: Option<SplitSpec> = match rf.split {
        None => None,
        Some(v) => Some(
            serde_json::from_value(v)
                .map_err(|e| CliError::usage(format!("invalid split: {}", e)))?,
        ),
    };
    Ok(PlanRunRequest {
        dataset,
        name,
        recipe,
        split,
        max_cost_usd: rf.max_cost_usd,
        ..Default::default()
    })
}

/// Export a run's resolved configuration as a run file (round-trips through `parse`).
pub fn export(run: &Run) -> CliResult<String> {
    let rc = &run.resolved_config;
    let resolved = serde_json::to_value(rc).unwrap_or(Value::Null);
    let mut m = serde_norway::Mapping::new();
    let mut put = |k: &str, v: Value| {
        let empty = v.is_null() || v.as_str() == Some("") || v.as_f64() == Some(0.0);
        if !empty {
            if let Ok(y) = serde_norway::to_value(&v) {
                m.insert(serde_norway::Value::String(k.into()), y);
            }
        }
    };
    let or = |a: &str, b: &str| Value::String(if a.is_empty() { b } else { a }.to_string());
    put("dataset", or(&rc.dataset, &run.dataset_name));
    put("name", or(&rc.name, &run.name));
    let kind = if rc.rule_version.is_empty() {
        &run.recipe_kind
    } else {
        &rc.recipe_kind
    };
    put("recipe", Value::String(kind.to_string()));
    for k in [
        "model",
        "adapter",
        "lr",
        "batch_size",
        "epochs",
        "schedule",
        "warmup",
        "train_on",
        "thinking",
        "preserve_thinking",
        "reduction",
        "select",
        "checkpoint_ttl_days",
    ] {
        put(k, resolved.get(k).cloned().unwrap_or(Value::Null));
    }
    if !rc.split.strategy.as_str().is_empty() && !rc.rule_version.is_empty() {
        put(
            "split",
            serde_json::json!({
                "strategy": rc.split.strategy,
                "eval_fraction": rc.split.eval_fraction,
                "seed": rc.split.seed,
            }),
        );
    }
    for (k, v) in &rc.recipe_params {
        if is_recipe_key(k) {
            put(k, v.clone());
        }
    }
    if let Some(c) = run.max_cost_usd {
        put("max_cost_usd", serde_json::json!(c));
    }
    let body = serde_norway::to_string(&serde_norway::Value::Mapping(m))
        .map_err(|e| CliError::general("encode_error", e.to_string()))?;
    Ok(format!(
        "# grad train -f <this file>  (exported from run {}{})\n{}",
        run.id,
        if rc.rule_version.is_empty() {
            String::new()
        } else {
            format!(", defaults rule {}", rc.rule_version)
        },
        body
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn p(raw: &str) -> CliResult<RunFile> {
        parse_str(Path::new("recipe.yaml"), raw)
    }

    #[test]
    fn parses_the_documented_shapes() {
        let rf = p("dataset:\n  name: diff-merge-prod\nname: fast-diff-merge\nrecipe: sft\nmodel: qwen/qwen3-8b\nadapter:\n  kind: lora\n  rank: 64\n").unwrap();
        let req = build_request(rf).unwrap();
        assert_eq!(req.dataset, "diff-merge-prod");
        let v = serde_json::to_value(&req).unwrap();
        assert_eq!(
            v["recipe"],
            json!({"kind": "sft", "model": "qwen/qwen3-8b", "adapter": {"kind": "lora", "rank": 64}})
        );

        let rf = p("dataset: t\nname: t\nrecipe: decision-model\nsplit: {strategy: random, eval_fraction: 0.2}\nmax_cost_usd: 5\n").unwrap();
        let req = build_request(rf).unwrap();
        assert_eq!(req.recipe.kind.as_str(), "decision");
        assert_eq!(req.max_cost_usd, Some(5.0));
        assert_eq!(
            req.split.unwrap().strategy,
            Some(grad_sdk::SplitSpecStrategy::Random)
        );

        let rf = p("dataset: d\nname: n\nrecipe: {kind: dpo, beta: 0.2}\n").unwrap();
        assert_eq!(build_request(rf).unwrap().recipe.beta, Some(0.2));
    }

    #[test]
    fn rejects_typos_filters_and_bad_types() {
        let e = p("dataset: d\nname: n\nrecipe: sft\nlerning_rate: 1\n").unwrap_err();
        assert!(
            e.message.contains("unknown setting 'lerning_rate'"),
            "{}",
            e.message
        );
        let e = p("dataset: d\nname: n\nrecip: sft\n").unwrap_err();
        assert!(e.message.contains("did you mean 'recipe'"), "{}", e.message);
        let e = p("dataset:\n  name: d\n  filter: {scores: {x: '>=1'}}\nname: n\nrecipe: sft\n")
            .unwrap_err();
        assert!(e.message.contains("not supported in v0"), "{}", e.message);
        let e = build_request(p("dataset: d\nname: n\nrecipe: sft\nepochs: two\n").unwrap())
            .unwrap_err();
        assert!(
            e.message.contains("invalid recipe parameter"),
            "{}",
            e.message
        );
        let e = build_request(p("dataset: d\nname: n\nrecipe: magic\n").unwrap()).unwrap_err();
        assert!(e.message.contains("unknown recipe 'magic'"));
        assert!(build_request(p("name: n\nrecipe: sft\n").unwrap()).is_err());
        assert!(p("- a\n- b\n").is_err());
        assert!(p("dataset: [\n").is_err());
        assert!(p("dataset: d\ncontext: {}\n").is_err());
    }

    #[test]
    fn set_flags_parse_yaml_values() {
        assert_eq!(
            parse_set("lr_scale=0.5").unwrap(),
            ("lr_scale".into(), json!(0.5))
        );
        assert_eq!(parse_set("models=[a, b]").unwrap().1, json!(["a", "b"]));
        assert_eq!(parse_set("thinking=auto").unwrap().1, json!("auto"));
        assert!(parse_set("nope").is_err());
        assert!(parse_set("warmpu=1")
            .unwrap_err()
            .message
            .contains("warmup"));
    }

    #[test]
    fn export_round_trips() {
        let run: Run = serde_json::from_value(json!({
            "id": "run_1", "name": "support-router", "recipe_kind": "router", "max_cost_usd": 20.0,
            "resolved_config": {
                "rule_version": "auto@1", "dataset": "support-prod", "name": "support-router",
                "recipe_kind": "router", "model": "qwen/qwen3-0.6b",
                "adapter": {"kind": "lora", "rank": 32, "alpha": 32, "merge_on_export": false},
                "lr": 0.0005, "batch_size": 128, "epochs": 1, "schedule": "cosine", "warmup": 0.03,
                "train_on": "last", "thinking": "auto", "preserve_thinking": false,
                "reduction": "per_example", "select": "best", "checkpoint_every_steps": 50,
                "checkpoint_ttl_days": 30,
                "split": {"strategy": "by_session", "eval_fraction": 0.15, "seed": 42, "train_records": 9, "eval_records": 1},
                "recipe_params": {"models": ["a", "b"], "max_quality_drop": 0.02, "internal": 1}
            }
        }))
        .unwrap();
        let yaml = export(&run).unwrap();
        assert!(yaml.starts_with("# grad train -f"));
        assert!(yaml.contains("recipe: router"));
        assert!(!yaml.contains("internal"));
        let req = build_request(parse_str(Path::new("x.yaml"), &yaml).unwrap()).unwrap();
        assert_eq!(req.dataset, "support-prod");
        assert_eq!(
            req.recipe.models,
            Some(vec!["a".to_string(), "b".to_string()])
        );
        assert_eq!(req.recipe.lr, Some(json!(0.0005)));
        assert_eq!(req.max_cost_usd, Some(20.0));
        assert_eq!(req.split.unwrap().eval_fraction, Some(0.15));
    }

    #[test]
    fn context_file_is_read_relative_to_the_run_file() {
        let dir = std::env::var_os("TMPDIR")
            .map(PathBuf::from)
            .unwrap_or_else(std::env::temp_dir)
            .join(format!("grad-trainfile-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("docs.md"), "the docs").unwrap();
        let f = dir.join("c.yaml");
        std::fs::write(
            &f,
            "dataset: d\nname: n\nrecipe: cartridge\ncontext:\n  file: ./docs.md\n",
        )
        .unwrap();
        let req = build_request(parse(&f).unwrap()).unwrap();
        assert_eq!(req.recipe.context_text.as_deref(), Some("the docs"));
        std::fs::write(&f, "dataset: d\ncontext:\n  file: ./missing.md\n").unwrap();
        assert!(parse(&f).is_err());
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(strsim("kitten", "sitting"), 3);
    }
}
