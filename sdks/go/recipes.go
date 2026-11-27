package grad

// SFTRecipe constructs an SFT recipe specification map.
func SFTRecipe(model string) map[string]any {
	spec := map[string]any{"kind": "sft"}
	if model != "" {
		spec["model"] = model
	}
	return spec
}

// DPORecipe constructs a Direct Preference Optimization recipe specification map.
func DPORecipe(model string, beta float64) map[string]any {
	spec := map[string]any{"kind": "dpo", "beta": beta}
	if model != "" {
		spec["model"] = model
	}
	return spec
}

// RouterRecipe constructs a Model Router recipe specification map.
func RouterRecipe(models []string, maxQualityDrop float64) map[string]any {
	return map[string]any{
		"kind":             "router",
		"models":           models,
		"max_quality_drop": maxQualityDrop,
	}
}

// DecisionRecipe constructs a Decision Model recipe specification map.
func DecisionRecipe(model string) map[string]any {
	spec := map[string]any{"kind": "decision"}
	if model != "" {
		spec["model"] = model
	}
	return spec
}

// CartridgeRecipe constructs a PrefixKV Cartridge recipe specification map.
func CartridgeRecipe(model, contextText string, numTokens int) map[string]any {
	spec := map[string]any{"kind": "cartridge", "num_tokens": numTokens}
	if model != "" {
		spec["model"] = model
	}
	if contextText != "" {
		spec["context_text"] = contextText
	}
	return spec
}

// EmbeddingRecipe constructs an InfoNCE Embedding recipe specification map.
func EmbeddingRecipe(model string, temp float64) map[string]any {
	spec := map[string]any{"kind": "embedding", "temp": temp}
	if model != "" {
		spec["model"] = model
	}
	return spec
}
