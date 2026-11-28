//! The plan readout, matching the Python, TypeScript and Go SDKs: `println!("{plan}")`.

use std::fmt;

use serde_json::Value;

use crate::generated::{PlanRunResponse, ResolvedRunConfigAdapter};

impl fmt::Display for PlanRunResponse {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let cfg = &self.resolved_config;
        let split = &cfg.split;
        let strategy = match split.strategy.as_str() {
            "by_session" => "BySession",
            "by_group" => "ByGroup",
            "random" => "Random",
            other => other,
        };
        let mut lines = vec![
            format!(
                "Dataset     {} v{} ({} of {} records usable)",
                cfg.dataset,
                self.dataset_version,
                int(self.usable_records),
                int(self.total_records)
            ),
            format!(
                "Split       {}({}, seed={}): {} train / {} eval",
                strategy,
                split.eval_fraction,
                split.seed,
                int(split.train_records),
                int(split.eval_records)
            ),
            format!(
                "Recipe      {} · model {} · {}",
                cfg.recipe_kind,
                cfg.model,
                adapter(&cfg.adapter)
            ),
            format!(
                "Template    {} (pinned) · thinking={} · train_on={} ({:.0}% of tokens trained)",
                cfg.template_revision,
                cfg.thinking,
                cfg.train_on,
                self.trained_token_fraction * 100.0
            ),
            format!(
                "Optimizer   AdamW(lr={}, betas=(0.9, 0.95), grad_clip=1.0) · {}",
                num(cfg.lr),
                cfg.lr_source
            ),
            format!(
                "Schedule    {}, warmup {} · batch {} · {} epoch(s) -> {} steps",
                cfg.schedule,
                num(cfg.warmup),
                cfg.batch_size,
                cfg.epochs,
                int(self.estimated_steps)
            ),
            format!(
                "Checkpoints every {} steps · keep {} · ttl {}d",
                cfg.checkpoint_every_steps, cfg.select, cfg.checkpoint_ttl_days
            ),
        ];
        let shown = params(&cfg.recipe_params);
        if !shown.is_empty() {
            lines.push(format!("Params      {}", shown));
        }
        lines.push(format!(
            "Estimate    ~{} tokens (~{} at {}/M)",
            tokens(self.estimated_tokens),
            usd(self.estimated_cost_usd),
            usd(self.price_per_million_tokens)
        ));
        let b = &self.cost_breakdown;
        lines.push(format!(
            "Breakdown   train ~{} · teacher ~{} · evals ~{} (held-out evals during training aren't billed)",
            usd(b.train_usd),
            usd(b.teacher_usd),
            usd(b.eval_usd)
        ));
        let gpu = self
            .min_gpu_memory_gb
            .map(|gb| format!(" · needs {} GB of GPU memory", num(gb)))
            .unwrap_or_default();
        lines.push(format!(
            "Duration    ~{} on one GPU{}",
            duration(self.estimated_duration_s),
            gpu
        ));
        if let Some(t) = &self.teacher {
            lines.push(format!(
                "Teacher     {}: ~{} tokens, ~{} at {}/M (included above)",
                t.model,
                tokens(t.estimated_tokens),
                usd(t.estimated_cost_usd),
                usd(t.price_per_million_tokens)
            ));
        }
        if let Some(l) = &self.labeling {
            lines.push(format!(
                "Labeling    {} model · {} judge calls, ~{} (billed as an eval, included above)",
                int(l.estimated_model_calls),
                int(l.estimated_judge_calls),
                usd(l.estimated_cost_usd)
            ));
        }
        lines.push(format!("Warnings    {}", self.warnings.len()));
        lines.extend(self.warnings.iter().map(|w| format!("  ! {}", w)));
        f.write_str(&lines.join("\n"))
    }
}

fn int(n: i64) -> String {
    let digits = n.unsigned_abs().to_string();
    let mut out = String::new();
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (digits.len() - i) % 3 == 0 {
            out.push(',');
        }
        out.push(c);
    }
    if n < 0 {
        format!("-{}", out)
    } else {
        out
    }
}

/// `1.00e-04` for tiny or huge values (as Python and Go print them), else the shortest form.
fn num(v: f64) -> String {
    if v != 0.0 && (v.abs() < 1e-3 || v.abs() >= 1e6) {
        let s = format!("{:.2e}", v);
        let (mantissa, exp) = s.split_once('e').unwrap_or((&s, "0"));
        let (sign, digits) = exp.strip_prefix('-').map_or(("+", exp), |d| ("-", d));
        return format!("{}e{}{:0>2}", mantissa, sign, digits);
    }
    v.to_string()
}

fn tokens(n: i64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1e6)
    } else if n >= 10_000 {
        format!("{:.0}k", n as f64 / 1e3)
    } else {
        int(n)
    }
}

fn usd(v: f64) -> String {
    if v >= 0.01 || v == 0.0 {
        let cents = format!("{:.2}", v);
        let (whole, frac) = cents.split_once('.').unwrap_or((&cents, "00"));
        format!("${}.{}", int(whole.parse().unwrap_or(0)), frac)
    } else {
        format!("${:.4}", v)
    }
}

fn duration(s: i64) -> String {
    if s < 90 {
        format!("{}s", s)
    } else if s < 90 * 60 {
        format!("{:.0} min", s as f64 / 60.0)
    } else {
        format!("{:.1} h", s as f64 / 3600.0)
    }
}

fn adapter(a: &ResolvedRunConfigAdapter) -> String {
    match a.kind.as_str() {
        "lora" => format!(
            "LoRA(rank={}, alpha={}){}",
            a.rank.unwrap_or(32),
            a.alpha.unwrap_or(32),
            if a.merge_on_export == Some(true) {
                " · merge_on_export"
            } else {
                ""
            }
        ),
        "prefix_kv" => format!("PrefixKV(num_tokens={})", a.num_tokens.unwrap_or(256)),
        "encoder_full" => "full encoder".into(),
        "" => "—".into(),
        other => other.into(),
    }
}

/// Recipe params as `k=v` in key order; long context text is summarised.
fn params(p: &std::collections::BTreeMap<String, Value>) -> String {
    p.iter()
        .map(|(k, v)| match v {
            Value::String(s) if k == "context_text" => {
                format!("{}=<{} chars>", k, int(s.len() as i64))
            }
            Value::String(s) => format!("{}={}", k, s),
            Value::Number(n) => format!("{}={}", k, n.as_f64().map_or(n.to_string(), num)),
            other => format!("{}={}", k, other),
        })
        .collect::<Vec<_>>()
        .join(", ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn numbers_match_the_other_sdks() {
        assert_eq!(int(1234567), "1,234,567");
        assert_eq!(int(-1000), "-1,000");
        assert_eq!(num(0.0001), "1.00e-04");
        assert_eq!(num(2e6), "2.00e+06");
        assert_eq!(num(0.0002), "2.00e-04");
        assert_eq!(num(0.05), "0.05");
        assert_eq!(usd(1234.5), "$1,234.50");
        assert_eq!(usd(0.0002), "$0.0002");
        assert_eq!(usd(0.0), "$0.00");
        assert_eq!(tokens(12_345), "12k");
        assert_eq!(tokens(2_500_000), "2.5M");
        assert_eq!(duration(3600), "60 min");
        assert_eq!(duration(7200), "2.0 h");
    }
}
