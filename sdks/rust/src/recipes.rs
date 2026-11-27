//! Recipe builders. Every builder leaves unset parameters to the server, so
//! the server's documented `"auto"` defaults keep applying.

use crate::models::{AdapterSpec, RecipeKind, RecipeSpec};

/// Parse a recipe name as written in the docs and CLI (`sft`, `decision-model`, ...).
pub fn parse_kind(name: &str) -> Option<RecipeKind> {
    Some(
        match name.trim().to_ascii_lowercase().replace('_', "-").as_str() {
            "sft" => RecipeKind::Sft,
            "dpo" => RecipeKind::Dpo,
            "router" => RecipeKind::Router,
            "decision" | "decision-model" => RecipeKind::Decision,
            "cartridge" | "cartridges" => RecipeKind::Cartridge,
            "embedding" | "embeddings" => RecipeKind::Embedding,
            "distill" | "distillation" => RecipeKind::Distill,
            "reward" | "reward-model" => RecipeKind::Reward,
            "grpo" | "rl" => RecipeKind::Grpo,
            _ => return None,
        },
    )
}

/// Recipe names accepted by [`parse_kind`], for help and error messages.
pub const RECIPE_NAMES: &str =
    "sft, dpo, router, decision-model (decision), cartridge, embedding, reward-model, distill, grpo";

/// Supervised fine-tuning.
pub fn sft() -> RecipeSpec {
    RecipeSpec::new(RecipeKind::Sft)
}

/// Direct preference optimization.
pub fn dpo() -> RecipeSpec {
    RecipeSpec::new(RecipeKind::Dpo)
}

/// Model router over candidate `models`.
pub fn router(models: Vec<String>) -> RecipeSpec {
    RecipeSpec {
        models: if models.is_empty() {
            None
        } else {
            Some(models)
        },
        ..RecipeSpec::new(RecipeKind::Router)
    }
}

/// Decision model (`Choice`, `Noul`, `Score`).
pub fn decision() -> RecipeSpec {
    RecipeSpec::new(RecipeKind::Decision)
}

/// Cartridge (trained prefix KV cache) over `context_text`.
pub fn cartridge(context_text: Option<String>) -> RecipeSpec {
    RecipeSpec {
        context_text,
        ..RecipeSpec::new(RecipeKind::Cartridge)
    }
}

/// Embedding fine-tune.
pub fn embedding() -> RecipeSpec {
    RecipeSpec::new(RecipeKind::Embedding)
}

/// LoRA adapter with optional rank/alpha.
pub fn lora(rank: Option<u32>, alpha: Option<u32>, merge_on_export: Option<bool>) -> AdapterSpec {
    AdapterSpec::Lora {
        rank,
        alpha,
        merge_on_export,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn documented_names_parse() {
        assert_eq!(parse_kind("decision-model"), Some(RecipeKind::Decision));
        assert_eq!(parse_kind("decision"), Some(RecipeKind::Decision));
        assert_eq!(parse_kind("reward-model"), Some(RecipeKind::Reward));
        assert_eq!(parse_kind("SFT"), Some(RecipeKind::Sft));
        assert_eq!(parse_kind("nope"), None);
        let r = router(vec!["a".into()]);
        assert_eq!(serde_json::to_value(&r).unwrap()["models"][0], "a");
        assert!(serde_json::to_value(router(vec![]))
            .unwrap()
            .get("models")
            .is_none());
        assert_eq!(
            serde_json::to_value(cartridge(Some("ctx".into()))).unwrap()["context_text"],
            "ctx"
        );
        for spec in [sft(), dpo(), decision(), embedding()] {
            let v = serde_json::to_value(&spec).unwrap();
            assert_eq!(v.as_object().unwrap().len(), 1, "only kind is sent: {}", v);
        }
        let l = serde_json::to_value(lora(Some(64), None, None)).unwrap();
        assert_eq!(l, serde_json::json!({"kind": "lora", "rank": 64}));
    }
}
