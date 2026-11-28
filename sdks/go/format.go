package grad

import (
	"encoding/json"
	"fmt"
	"math"
	"sort"
	"strings"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// String renders the plan the way the Python SDK and the CLI print it:
// resolved defaults, split, estimate and warnings. fmt.Println(plan) uses it.
func (p *RunPlan) String() string {
	if p == nil {
		return "<nil plan>"
	}
	cfg := p.ResolvedConfig
	split := cfg.Split
	strategy := map[string]string{"by_session": "BySession", "by_group": "ByGroup", "random": "Random"}[string(split.Strategy)]
	if strategy == "" {
		strategy = string(split.Strategy)
	}
	lines := []string{
		fmt.Sprintf("Dataset     %s v%d (%s of %s records usable)", cfg.Dataset, p.DatasetVersion, fmtInt(p.UsableRecords), fmtInt(p.TotalRecords)),
		fmt.Sprintf("Split       %s(%g, seed=%d): %s train / %s eval", strategy, split.EvalFraction, split.Seed, fmtInt(split.TrainRecords), fmtInt(split.EvalRecords)),
		fmt.Sprintf("Recipe      %s · model %s · %s", cfg.RecipeKind, cfg.Model, fmtAdapter(cfg.Adapter)),
		fmt.Sprintf("Template    %s (pinned) · thinking=%s · train_on=%s (%.0f%% of tokens trained)", cfg.TemplateRevision, cfg.Thinking, cfg.TrainOn, p.TrainedTokenFraction*100),
		fmt.Sprintf("Optimizer   AdamW(lr=%s, betas=(0.9, 0.95), grad_clip=1.0) · %s", fmtNum(cfg.LR), cfg.LRSource),
		fmt.Sprintf("Schedule    %s, warmup %s · batch %d · %d epoch(s) -> %s steps", cfg.Schedule, fmtNum(cfg.Warmup), cfg.BatchSize, cfg.Epochs, fmtInt(p.EstimatedSteps)),
		fmt.Sprintf("Checkpoints every %d steps · keep %s · ttl %dd", cfg.CheckpointEverySteps, cfg.Select, cfg.CheckpointTTLDays),
	}
	if params := fmtParams(cfg.RecipeParams); params != "" {
		lines = append(lines, "Params      "+params)
	}
	lines = append(lines, fmt.Sprintf("Estimate    ~%s tokens (~%s at %s/M)", fmtTokens(p.EstimatedTokens), fmtUSD(p.EstimatedCostUSD), fmtUSD(p.PricePerMillionTokens)))
	b := p.CostBreakdown
	lines = append(lines, fmt.Sprintf("Breakdown   train ~%s · teacher ~%s · evals ~%s (held-out evals during training aren't billed)", fmtUSD(b.TrainUSD), fmtUSD(b.TeacherUSD), fmtUSD(b.EvalUSD)))
	duration := fmt.Sprintf("Duration    ~%s", fmtDuration(p.EstimatedDurationS))
	// "on one GPU" only for a base with a GPU requirement (the CPU dev models have none).
	if p.MinGPUMemoryGb != nil {
		duration += fmt.Sprintf(" on one GPU · needs %s GB of GPU memory", fmtNum(*p.MinGPUMemoryGb))
	}
	lines = append(lines, duration)
	if t := p.Teacher; t != nil {
		lines = append(lines, fmt.Sprintf("Teacher     %s: ~%s tokens, ~%s at %s/M (included above)", t.Model, fmtTokens(t.EstimatedTokens), fmtUSD(t.EstimatedCostUSD), fmtUSD(t.PricePerMillionTokens)))
	}
	if l := p.Labeling; l != nil {
		lines = append(lines, fmt.Sprintf("Labeling    %s model · %s judge calls, ~%s (billed as an eval, included above)", fmtInt(l.EstimatedModelCalls), fmtInt(l.EstimatedJudgeCalls), fmtUSD(l.EstimatedCostUSD)))
	}
	lines = append(lines, fmt.Sprintf("Warnings    %d", len(p.Warnings)))
	for _, w := range p.Warnings {
		lines = append(lines, "  ! "+w)
	}
	return strings.Join(lines, "\n")
}

// fmtDuration matches Python's plan readout: seconds under 90 s, minutes under 90 min, else hours.
func fmtDuration(seconds int) string {
	switch {
	case seconds < 90:
		return fmt.Sprintf("%ds", seconds)
	case seconds < 90*60:
		return fmt.Sprintf("%.0f min", float64(seconds)/60)
	default:
		return fmt.Sprintf("%.1f h", float64(seconds)/3600)
	}
}

func fmtInt(n int) string {
	s := fmt.Sprint(n)
	if n < 0 {
		return "-" + fmtInt(-n)
	}
	for i := len(s) - 3; i > 0; i -= 3 {
		s = s[:i] + "," + s[i:]
	}
	return s
}

func fmtNum(v float64) string {
	if v != 0 && (math.Abs(v) < 1e-3 || math.Abs(v) >= 1e6) {
		return fmt.Sprintf("%.2e", v)
	}
	return fmt.Sprintf("%g", v)
}

func fmtTokens(n int) string {
	switch {
	case n >= 1_000_000:
		return fmt.Sprintf("%.1fM", float64(n)/1_000_000)
	case n >= 10_000:
		return fmt.Sprintf("%.0fk", float64(n)/1_000)
	default:
		return fmtInt(n)
	}
}

func fmtUSD(v float64) string {
	if v >= 0.01 || v == 0 {
		return "$" + fmtThousands(fmt.Sprintf("%.2f", v))
	}
	return fmt.Sprintf("$%.4f", v)
}

func fmtThousands(s string) string {
	whole, frac, _ := strings.Cut(s, ".")
	n := 0
	fmt.Sscan(whole, &n)
	return fmtInt(n) + "." + frac
}

func fmtAdapter(a generated.ResolvedRunConfigAdapter) string {
	switch a.Kind {
	case "lora":
		rank, alpha := 32, 32
		if a.Rank != nil {
			rank = *a.Rank
		}
		if a.Alpha != nil {
			alpha = *a.Alpha
		}
		s := fmt.Sprintf("LoRA(rank=%d, alpha=%d)", rank, alpha)
		if a.MergeOnExport != nil && *a.MergeOnExport {
			s += " · merge_on_export"
		}
		return s
	case "prefix_kv":
		n := 256
		if a.NumTokens != nil {
			n = *a.NumTokens
		}
		return fmt.Sprintf("PrefixKV(num_tokens=%d)", n)
	case "encoder_full":
		return "full encoder"
	case "":
		return "—"
	}
	return string(a.Kind)
}

// fmtParams prints recipe params as k=v in key order; long context text is summarised.
func fmtParams(params map[string]any) string {
	keys := make([]string, 0, len(params))
	for k := range params {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, 0, len(keys))
	for _, k := range keys {
		v := params[k]
		var text string
		switch x := v.(type) {
		case string:
			text = x
			if k == "context_text" {
				text = fmt.Sprintf("<%s chars>", fmtInt(len(x)))
			}
		case float64:
			text = fmtNum(x)
		default:
			b, err := json.Marshal(x)
			if err != nil {
				text = fmt.Sprint(x)
			} else {
				text = string(b)
			}
		}
		parts = append(parts, k+"="+text)
	}
	return strings.Join(parts, ", ")
}
