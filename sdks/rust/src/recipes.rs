//! Recipe names. Build a recipe with [`RecipeSpec::new`] and set the fields
//! you need; unset parameters keep the server's documented `"auto"` defaults.
//!
//! [`RecipeSpec::new`]: crate::RecipeSpec::new

use crate::models::{RecipeKind, RolloutSpec, RolloutSpecKind};

/// Parse a v0 recipe name as written in the docs and CLI (`sft`, `decision-model`, ...).
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
            _ => return None,
        },
    )
}

/// Recipe names accepted by [`parse_kind`], for help and error messages.
pub const RECIPE_NAMES: &str =
    "sft, dpo, router, decision-model (decision), cartridge, embedding, distill, reward-model (reward)";

/// DistillRecipe rollout: the student writes each answer (up to `max_new_tokens`, `None` =
/// "auto") and the teacher scores those tokens.
pub fn on_policy(max_new_tokens: Option<u32>) -> RolloutSpec {
    RolloutSpec {
        kind: RolloutSpecKind::OnPolicy,
        max_new_tokens: max_new_tokens.map(serde_json::Value::from),
    }
}

/// DistillRecipe rollout: the teacher answers each prompt once through the inference
/// endpoint (a labeling eval) and the student trains on those answers.
pub fn off_policy(max_new_tokens: Option<u32>) -> RolloutSpec {
    RolloutSpec {
        kind: RolloutSpecKind::OffPolicy,
        max_new_tokens: max_new_tokens.map(serde_json::Value::from),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::RecipeSpec;

    #[test]
    fn documented_names_parse_and_unset_fields_are_not_sent() {
        assert_eq!(parse_kind("decision-model"), Some(RecipeKind::Decision));
        assert_eq!(parse_kind("decision"), Some(RecipeKind::Decision));
        assert_eq!(parse_kind("SFT"), Some(RecipeKind::Sft));
        assert_eq!(
            parse_kind("grpo"),
            None,
            "Wave 2 recipes are not v0 recipes"
        );
        assert_eq!(parse_kind("nope"), None);
        assert_eq!(parse_kind("reward-model"), Some(RecipeKind::Reward));
        assert_eq!(parse_kind("distillation"), Some(RecipeKind::Distill));
        assert_eq!(
            serde_json::to_value(on_policy(None)).unwrap(),
            serde_json::json!({"kind": "on_policy"})
        );
        assert_eq!(
            serde_json::to_value(off_policy(Some(64))).unwrap(),
            serde_json::json!({"kind": "off_policy", "max_new_tokens": 64})
        );
        let v = serde_json::to_value(RecipeSpec::new(RecipeKind::Dpo).model("sft@1")).unwrap();
        assert_eq!(v, serde_json::json!({"kind": "dpo", "model": "sft@1"}));
    }
}
