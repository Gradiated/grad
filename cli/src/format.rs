//! Output formatting (JSON and pure-Rust YAML) and atomic file writes.

use serde_json::Value;
use std::fs;
use std::io::Write;
use std::path::Path;

fn yaml_scalar(v: &Value) -> String {
    match v {
        Value::Null => "null".to_string(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n.to_string(),
        Value::String(s) => {
            if s.is_empty()
                || s.contains('\n')
                || s.contains(':')
                || s.contains('#')
                || s.starts_with([' ', '-', '?', '[', ']', '{', '}', '"', '\'', '*', '&', '!'])
                || matches!(s.as_str(), "true" | "false" | "null" | "~")
            {
                serde_json::to_string(s).unwrap_or_else(|_| format!("{:?}", s))
            } else {
                s.clone()
            }
        }
        _ => serde_json::to_string(v).unwrap_or_default(),
    }
}

fn write_yaml(v: &Value, indent: usize, out: &mut String) {
    let pad = " ".repeat(indent);
    match v {
        Value::Object(map) if !map.is_empty() => {
            for (k, val) in map {
                match val {
                    Value::Object(inner) if !inner.is_empty() => {
                        out.push_str(&format!("{}{}:\n", pad, k));
                        write_yaml(val, indent + 2, out);
                    }
                    Value::Array(arr) if !arr.is_empty() => {
                        out.push_str(&format!("{}{}:\n", pad, k));
                        write_yaml(val, indent + 2, out);
                    }
                    Value::Object(_) => out.push_str(&format!("{}{}: {{}}\n", pad, k)),
                    Value::Array(_) => out.push_str(&format!("{}{}: []\n", pad, k)),
                    _ => out.push_str(&format!("{}{}: {}\n", pad, k, yaml_scalar(val))),
                }
            }
        }
        Value::Array(arr) if !arr.is_empty() => {
            for item in arr {
                match item {
                    Value::Object(inner) if !inner.is_empty() => {
                        out.push_str(&format!("{}-\n", pad));
                        write_yaml(item, indent + 2, out);
                    }
                    Value::Array(inner) if !inner.is_empty() => {
                        out.push_str(&format!("{}-\n", pad));
                        write_yaml(item, indent + 2, out);
                    }
                    _ => out.push_str(&format!("{}- {}\n", pad, yaml_scalar(item))),
                }
            }
        }
        _ => out.push_str(&format!("{}{}\n", pad, yaml_scalar(v))),
    }
}

pub fn value_to_yaml(value: &Value) -> String {
    let mut out = String::new();
    write_yaml(value, 0, &mut out);
    out
}

pub fn print_value(value: &Value, as_yaml: bool) -> Result<(), String> {
    if as_yaml {
        print!("{}", value_to_yaml(value));
    } else {
        let rendered = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
        println!("{}", rendered);
    }
    Ok(())
}

pub fn write_bytes_atomic(out: &Path, bytes: &[u8]) -> Result<(), String> {
    if out.is_dir() {
        return Err(format!("Output path '{}' is a directory.", out.display()));
    }
    let parent = out
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let tmp_name = format!(
        ".grad-dl-{}-{}.tmp",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    let tmp_path = parent.join(tmp_name);
    let write_res = (|| -> std::io::Result<()> {
        let mut f = fs::File::create(&tmp_path)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        Ok(())
    })();

    if let Err(err) = write_res {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed writing temp artifact: {}", err));
    }

    if let Err(err) = fs::rename(&tmp_path, out) {
        let _ = fs::remove_file(&tmp_path);
        return Err(format!("Failed renaming artifact to '{}': {}", out.display(), err));
    }
    Ok(())
}
