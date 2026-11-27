package grad_test

import (
	"context"
	"encoding/json"
	"reflect"
	"regexp"
	"sort"
	"testing"

	grad "github.com/Gradiated/grad/sdks/go"
	"github.com/Gradiated/grad/sdks/go/generated"
)

// parityFixture is tests/fixtures/wire/sdk-parity.json: every SDK and the CLI
// send these requests for the same logical calls.
type parityFixture struct {
	Requests []struct {
		Case           string  `json:"case"`
		Method         string  `json:"method"`
		Path           string  `json:"path"`
		IdempotencyKey *string `json:"idempotency_key"`
		Body           any     `json:"body"`
	} `json:"requests"`
	Responses struct {
		Run      json.RawMessage `json:"run"`
		Eval     json.RawMessage `json:"eval"`
		EvalPlan json.RawMessage `json:"eval_plan"`
		Scoring  json.RawMessage `json:"scoring"`
	} `json:"responses"`
	Expect map[string]any `json:"expect"`
}

func loadParity(t *testing.T) parityFixture {
	t.Helper()
	var p parityFixture
	if err := json.Unmarshal(wire(t, "sdk-parity.json"), &p); err != nil {
		t.Fatal(err)
	}
	return p
}

func TestParityRequests(t *testing.T) {
	ctx := context.Background()
	p := loadParity(t)
	routes := map[string]route{}
	for _, c := range p.Requests {
		routes[c.Method+" "+c.Path] = jsonValue(200, map[string]any{"id": "x", "status": "queued"})
	}
	f := newFake(t, routes)
	c, _ := f.client()
	judge := grad.Judge{Name: "quality", Model: "judge/m", Prompt: "Is the answer correct?", Weight: 1}
	artifact := "support-sft@2026-11-27-1"
	calls := map[string]func() error{
		"plan_sft_every_param": func() error {
			_, err := c.Runs.Plan(ctx, grad.RunParams{Dataset: grad.DatasetName("support"), Name: "sft-params", MaxCostUSD: 5,
				Split: grad.BySession{EvalFraction: 0.2, Seed: 7},
				Recipe: grad.SFTRecipe{MergeOnExport: true, Common: grad.Common{
					Model: "test/tiny-qwen3", Adapter: grad.LoRA{Rank: 16, Alpha: 16}, LR: 0.0002, LRScale: 0.5,
					Optimizer: &grad.AdamW{Betas: [2]float64{0.8, 0.9}, WeightDecay: 0.1, GradClip: 0.5},
					BatchSize: 4, Epochs: 2, Schedule: "cosine", Warmup: 0.05, TrainOn: "all_assistant", Thinking: "off",
					PreserveThinking: true, Reduction: "per_token", Select: "last", CheckpointTTLDays: 7, EvalEvery: 2,
				}}})
			return err
		},
		"create_dpo_from_artifact": func() error {
			_, err := c.Runs.Create(ctx, grad.RunParams{Dataset: grad.DatasetName("prefs"), Name: "dpo-continued", IdempotencyKey: "parity-run-key",
				Recipe: grad.DPORecipe{Common: grad.Common{Model: artifact}, Beta: 0.3}}).Result()
			return err
		},
		"plan_router_judge_rubric": func() error {
			_, err := c.Runs.Plan(ctx, grad.RunParams{Dataset: grad.DatasetName("support-logs"), Name: "router-params",
				Recipe: grad.RouterRecipe{Common: grad.Common{Model: "test/tiny-qwen3"}, Models: []string{"cheap/m", "strong/m"}, Rubric: judge,
					MaxQualityDrop: 0.05, Pricing: map[string]float64{"cheap/m": 0.001, "strong/m": 0.01}, Fallback: "strong/m"}})
			return err
		},
		"plan_cartridge": func() error {
			_, err := c.Runs.Plan(ctx, grad.RunParams{Dataset: grad.DatasetName("docs"), Name: "cartridge-params",
				Recipe: grad.CartridgeRecipe{Common: grad.Common{Model: "test/tiny-qwen3"}, Context: grad.ContextFromText("The capital of Testland is Tinytown."),
					NumTokens: 16, Teacher: "test/tiny-qwen3-teacher", TopK: 7, MaxNewTokens: 5}})
			return err
		},
		"plan_embedding": func() error {
			_, err := c.Runs.Plan(ctx, grad.RunParams{Dataset: grad.DatasetName("pairs"), Name: "embedding-params",
				Recipe: grad.EmbeddingRecipe{Common: grad.Common{Model: "test/tiny-bert"}, Pool: "cls", Temp: 0.1}})
			return err
		},
		"plan_decision": func() error {
			_, err := c.Runs.Plan(ctx, grad.RunParams{Dataset: grad.DatasetName("decisions"), Name: "decision", Recipe: grad.DecisionModelRecipe{}})
			return err
		},
		"plan_distill": func() error {
			_, err := c.Runs.Plan(ctx, grad.RunParams{Dataset: grad.DatasetName("support-prompts"), Name: "distill-params",
				Recipe: grad.DistillRecipe{Common: grad.Common{Model: "test/tiny-qwen3"}, Teacher: "test/tiny-qwen3-teacher", MaxNewTokens: 64, TopK: 16,
					Context: grad.ContextFromText("Refunds take 30 days.")}})
			return err
		},
		"plan_distill_off_policy": func() error {
			_, err := c.Runs.Plan(ctx, grad.RunParams{Dataset: grad.DatasetName("support-prompts"), Name: "distill-off",
				Recipe: grad.DistillRecipe{Teacher: artifact, OffPolicy: true, MaxNewTokens: 128}})
			return err
		},
		"plan_reward": func() error {
			_, err := c.Runs.Plan(ctx, grad.RunParams{Dataset: grad.DatasetName("sql-preferences"), Name: "sql-verifier",
				Recipe: grad.RewardModelRecipe{Common: grad.Common{Model: "test/tiny-qwen3", Adapter: grad.FrozenHead{}}, Rubric: "resolved"}})
			return err
		},
		"create_eval": func() error {
			_, err := c.Evals.Create(ctx, grad.EvalParams{Name: "parity-eval", Models: []string{"test/tiny-qwen3", artifact},
				Dataset: grad.DatasetName("support"), Rubric: grad.Rubric{judge, grad.Scorer{Name: "non_empty", Validator: grad.ValidatorNonEmpty, Weight: 1}},
				Baseline: "test/tiny-qwen3", Samples: 3, Temperature: grad.Float(0.7), MaxTokens: 256, Limit: 10, PassThreshold: grad.Float(0.5),
				DatasetVersion: 1, IdempotencyKey: "parity-eval-key"}).Result()
			return err
		},
		"score_dataset": func() error {
			_, err := c.Datasets.Score(ctx, "support-logs", grad.Rubric{judge},
				grad.ScoreOptions{Version: 1, Name: "support-logs-quality", Limit: 100, IdempotencyKey: "parity-score-key"}).Result()
			return err
		},
		"filter_dataset_fields": func() error {
			_, err := c.Datasets.Filter(ctx, "support-logs", grad.FilterOptions{Scores: map[string]string{"quality": ">=0.8"},
				Metadata: map[string]any{"env": "prod"}, CreatedAfter: "2026-11-01", Version: 2, Name: "support-good"})
			return err
		},
		"import_benchmark": func() error {
			_, err := c.Datasets.ImportBenchmark(ctx, grad.BenchmarkGSM8K, grad.BenchmarkOptions{Limit: 200, Name: "gsm8k-test-200"}).Result()
			return err
		},
		"filter_dataset_ids": func() error {
			_, err := c.Datasets.Filter(ctx, "support-logs", grad.FilterOptions{IDs: []string{"rec_a", "rec_c"}})
			return err
		},
		"deploy": func() error {
			_, err := c.Deployments.Create(ctx, artifact, grad.WithDeploymentName("support"), grad.WithFallback("test/tiny-qwen3"),
				grad.WithExploreRate(0.1), grad.WithDeployIdempotencyKey("parity-deploy-key"))
			return err
		},
	}
	var names, want []string
	for name := range calls {
		names = append(names, name)
	}
	for _, c := range p.Requests {
		want = append(want, c.Case)
	}
	sort.Strings(names)
	sort.Strings(want)
	if !reflect.DeepEqual(names, want) {
		t.Fatalf("cases %v, fixture has %v", names, want)
	}
	uuid := regexp.MustCompile(`^[0-9a-f-]{36}$`)
	for _, tc := range p.Requests {
		if err := calls[tc.Case](); err != nil {
			t.Fatalf("%s: %v", tc.Case, err)
		}
		reqs := f.requests()
		sent := reqs[len(reqs)-1]
		var body any
		if err := json.Unmarshal(sent.Body, &body); err != nil {
			t.Fatal(err)
		}
		if sent.Method != tc.Method || sent.Path != tc.Path || !reflect.DeepEqual(body, tc.Body) {
			got, _ := json.Marshal(body)
			exp, _ := json.Marshal(tc.Body)
			t.Errorf("%s: %s %s\n got %s\nwant %s", tc.Case, sent.Method, sent.Path, got, exp)
		}
		key := sent.Header.Get("Idempotency-Key")
		if (tc.IdempotencyKey == nil && !uuid.MatchString(key)) || (tc.IdempotencyKey != nil && key != *tc.IdempotencyKey) {
			t.Errorf("%s: Idempotency-Key %q", tc.Case, key)
		}
	}
}

func TestParityTypedResponses(t *testing.T) {
	p := loadParity(t)
	var run generated.Run
	var ev generated.EvalRun
	var plan generated.PlanEvalResponse
	var scoring generated.EvalRun
	for raw, into := range map[*json.RawMessage]any{&p.Responses.Run: &run, &p.Responses.Eval: &ev, &p.Responses.EvalPlan: &plan, &p.Responses.Scoring: &scoring} {
		if err := json.Unmarshal(*raw, into); err != nil {
			t.Fatal(err)
		}
	}
	report := run.EvalReport
	got := map[string]any{
		"run.eval_report.metric_name":                      report.MetricName,
		"run.eval_report.selected_step":                    float64(report.SelectedStep),
		"run.eval_report.eval_loss":                        *report.EvalLoss,
		"run.eval_report.fallback_model":                   *report.FallbackModel,
		"run.eval_report.pareto_summary.quality_drop":      *report.ParetoSummary.QualityDrop,
		"run.eval_report.pareto_summary.quality_drop_ci95": []any{report.ParetoSummary.QualityDropCi95[0], report.ParetoSummary.QualityDropCi95[1]},
		"run.latest_metric.eval_metrics.routed_quality":    *run.LatestMetric.EvalMetrics["routed_quality"],
		"eval.total_cost_usd":                              ev.TotalCostUSD,
		"eval.summary[0].cost_per_1k_tasks_usd":            *ev.Summary[0].CostPer1kTasksUSD,
		"eval_plan.estimated_cost_usd":                     plan.EstimatedCostUSD,
		"scoring.mode":                                     string(scoring.Mode),
		"scoring.scored_dataset_version":                   float64(*scoring.ScoredDatasetVersion),
	}
	if !reflect.DeepEqual(got, p.Expect) {
		t.Fatalf("typed responses\n got %v\nwant %v", got, p.Expect)
	}
}
