package grad_test

import (
	"context"
	"encoding/json"
	"iter"
	"net/url"
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
		Case           string            `json:"case"`
		Method         string            `json:"method"`
		Path           string            `json:"path"`
		IdempotencyKey *string           `json:"idempotency_key"`
		Body           any               `json:"body"`
		Query          map[string]string `json:"query"`
	} `json:"requests"`
	Responses struct {
		Run      json.RawMessage `json:"run"`
		Eval     json.RawMessage `json:"eval"`
		EvalPlan json.RawMessage `json:"eval_plan"`
		Scoring  json.RawMessage `json:"scoring"`
		RunPlan  json.RawMessage `json:"run_plan"`
		Source   json.RawMessage `json:"source"`
		Secret   json.RawMessage `json:"secret"`
		Usage    struct {
			Data []json.RawMessage `json:"data"`
		} `json:"usage_page"`
		UsageSummary   json.RawMessage `json:"usage_summary"`
		RunEvents      json.RawMessage `json:"run_events"`
		Artifact       json.RawMessage `json:"artifact"`
		ArtifactImport json.RawMessage `json:"artifact_import"`
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
	for _, list := range []string{"/v1/usage", "/v1/runs", "/v1/evals", "/v1/imports", "/v1/datasets", "/v1/artifacts"} {
		routes["GET "+list] = jsonValue(200, map[string]any{"data": []any{}, "next_cursor": nil})
	}
	var events generated.RunEventsPage
	if err := json.Unmarshal(p.Responses.RunEvents, &events); err != nil {
		t.Fatal(err)
	}
	routes["GET /v1/runs/"+events.RunID+"/events"] = jsonValue(200, map[string]any{"data": []any{}, "next_cursor": nil})
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
		"plan_sft_checkpoint_evals_loggers": func() error {
			_, err := c.Runs.Plan(ctx, grad.RunParams{Dataset: grad.DatasetName("support"), Name: "sft-tracked",
				Recipe: grad.SFTRecipe{Common: grad.Common{Model: "test/tiny-qwen3",
					Evals: []grad.CheckpointEval{{Dataset: grad.DatasetName("gsm8k-200")},
						{Dataset: grad.DatasetName("support-holdout"), Rubric: grad.Rubric{grad.Regex{Name: "starts_select", Pattern: "^SELECT", Weight: 1}}, Limit: 50, Name: "sql"}},
					Loggers: []grad.Logger{grad.WandB("support", "wandb-key", ""), grad.MLflow("https://mlflow.internal", "sft", "")},
				}}})
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
		"import_artifact_hf": func() error {
			_, err := c.Artifacts.FromHF(ctx, "hf://acme/support-lora@v2", grad.FromHFParams{Base: "test/tiny-qwen3", Name: "support-lora",
				Secret: "hf-token", IdempotencyKey: "parity-artifact-import-key"})
			return err
		},
		"artifact_download_url": func() error {
			_, err := c.Artifacts.DownloadURL(ctx, "support-sft@2026-11-27-1")
			return err
		},
		"delete_artifact": func() error { return c.Artifacts.Delete(ctx, "support-sft@2026-11-27-1") },
		"set_secret": func() error {
			_, err := c.Secrets.Set(ctx, "langfuse-prod", "pk-lf-1:sk-lf-2")
			return err
		},
		"set_secret_hosts": func() error {
			_, err := c.Secrets.Set(ctx, "langfuse-self", "pk-lf-1:sk-lf-2", "langfuse.internal:3000")
			return err
		},
		"add_source": func() error {
			secret := &grad.SecretRef{Secret: generated.Secret{Name: "langfuse-prod"}}
			_, err := c.Sources.Create(ctx, grad.DatasetName("support-prod"), grad.SourceParams{
				Provider:       grad.LangfuseSource{Host: "https://cloud.langfuse.com", Secret: secret},
				Schedule:       "*/15 * * * *",
				IdempotencyKey: "parity-source-key",
			})
			return err
		},
		"add_source_gradiated": func() error {
			_, err := c.Sources.Create(ctx, grad.DatasetName("support-prod"), grad.SourceParams{
				Provider: grad.GradiatedSource{Models: []string{"acme/support"}},
				Schedule: "0 * * * *",
			})
			return err
		},
		"add_source_filtered": func() error {
			tenMinutes := 600
			_, err := c.Sources.Create(ctx, grad.DatasetName("support-prod"), grad.SourceParams{
				Provider: grad.LangfuseSource{Secret: grad.SecretName("langfuse-prod"), Filters: map[string]any{
					"environment": []any{"production"}, "min_score": map[string]any{"helpfulness": 0.8}}},
				SampleRate:       0.1,
				MaxRecordsPerDay: 100000,
				VersionInterval:  &tenMinutes,
			})
			return err
		},
		"update_source": func() error {
			half, cleared := 0.5, 0
			_, err := c.Sources.Update(ctx, "src_01J9X", grad.SourceUpdate{
				Filters: map[string]any{"tags": []string{"prod"}}, SampleRate: &half, MaxRecordsPerSync: &cleared})
			return err
		},
		"list_usage": func() error {
			for _, err := range c.Usage.List(ctx, grad.WithUsagePageSize(10)) {
				return err
			}
			return nil
		},
		"list_usage_filtered": func() error {
			for _, err := range c.Usage.List(ctx, grad.WithUsageFrom("2026-11-01"),
				grad.WithUsageTo("2026-11-30"), grad.WithUsageRun("run_015437ae0c01e09a573e4811"),
				grad.WithUsageKind(grad.UsageLabeling), grad.WithUsagePageSize(10)) {
				return err
			}
			return nil
		},
		"usage_summary": func() error {
			_, err := c.Usage.Summary(ctx, grad.WithUsageFrom("2026-11-01"), grad.WithUsageTo("2026-11-30"), grad.WithUsageGroupBy(grad.UsageByModel))
			return err
		},
		"list_runs_filtered": func() error {
			return firstErr(c.Runs.List(ctx, grad.RunListOptions{Status: []grad.RunStatus{grad.RunFailed, grad.RunCancelled}, Search: "sft"}))
		},
		"list_evals_filtered": func() error {
			return firstErr(c.Evals.List(ctx, grad.EvalListOptions{Status: []grad.EvalStatus{"running"}}))
		},
		"list_imports_filtered": func() error {
			return firstErr(c.Imports.List(ctx, grad.ImportListOptions{Status: []grad.ImportStatus{"failed"}, Dataset: grad.DatasetName("support")}))
		},
		"list_datasets_search": func() error {
			return firstErr(c.Datasets.List(ctx, grad.DatasetListOptions{Search: "support"}))
		},
		"list_artifacts_search": func() error {
			return firstErr(c.Artifacts.List(ctx, grad.ArtifactListOptions{Search: "sft"}))
		},
		"count_runs": func() error {
			_, err := c.Runs.Counts(ctx, "sft")
			return err
		},
		"list_run_events": func() error {
			for _, err := range c.Runs.Events(ctx, events.RunID, grad.EventsOptions{Limit: 100}) {
				return err
			}
			return nil
		},
		"sync_source_full": func() error {
			_, err := c.Sources.Sync(ctx, "src_01J9X", grad.FullSync()).Result()
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
		if tc.Method == "GET" {
			key := sent.Header.Get("Idempotency-Key")
			if sent.Path != tc.Path || key != "" || !reflect.DeepEqual(queryMap(sent.Query), tc.Query) {
				t.Errorf("%s: %s %s?%s key %q", tc.Case, sent.Method, sent.Path, sent.Query, key)
			}
			continue
		}
		if len(sent.Body) > 0 {
			if err := json.Unmarshal(sent.Body, &body); err != nil {
				t.Fatal(err)
			}
		}
		if sent.Method != tc.Method || sent.Path != tc.Path || !reflect.DeepEqual(body, tc.Body) {
			got, _ := json.Marshal(body)
			exp, _ := json.Marshal(tc.Body)
			t.Errorf("%s: %s %s\n got %s\nwant %s", tc.Case, sent.Method, sent.Path, got, exp)
		}
		key := sent.Header.Get("Idempotency-Key")
		if tc.Method == "PATCH" || tc.Method == "DELETE" {
			if key != "" {
				t.Errorf("%s: %s sent Idempotency-Key %q", tc.Case, tc.Method, key)
			}
			continue
		}
		if (tc.IdempotencyKey == nil && !uuid.MatchString(key)) || (tc.IdempotencyKey != nil && key != *tc.IdempotencyKey) {
			t.Errorf("%s: Idempotency-Key %q", tc.Case, key)
		}
	}
}

// firstErr fetches a list's first page and returns its error.
func firstErr[T any](seq iter.Seq2[T, error]) error {
	for _, err := range seq {
		return err
	}
	return nil
}

func TestParityTypedResponses(t *testing.T) {
	p := loadParity(t)
	var run generated.Run
	var ev generated.EvalRun
	var plan generated.PlanEvalResponse
	var scoring generated.EvalRun
	var runPlan generated.PlanRunResponse
	var source grad.Source
	var secret grad.SecretRef
	var artifact grad.Artifact
	var artifactImport grad.ArtifactImport
	if err := json.Unmarshal(p.Responses.Artifact, &artifact); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(p.Responses.ArtifactImport, &artifactImport); err != nil {
		t.Fatal(err)
	}
	var usage grad.UsageRecord
	if err := json.Unmarshal(p.Responses.Usage.Data[0], &usage); err != nil {
		t.Fatal(err)
	}
	var totals grad.UsageSummary
	if err := json.Unmarshal(p.Responses.UsageSummary, &totals); err != nil {
		t.Fatal(err)
	}
	for raw, into := range map[*json.RawMessage]any{&p.Responses.Run: &run, &p.Responses.Eval: &ev, &p.Responses.EvalPlan: &plan, &p.Responses.Scoring: &scoring, &p.Responses.Source: &source, &p.Responses.Secret: &secret, &p.Responses.RunPlan: &runPlan} {
		if err := json.Unmarshal(*raw, into); err != nil {
			t.Fatal(err)
		}
	}
	var events generated.RunEventsPage
	if err := json.Unmarshal(p.Responses.RunEvents, &events); err != nil {
		t.Fatal(err)
	}
	ev2, ev4, ev7, ev11, ev12, ev14, ev24 := events.Data[2], events.Data[4], events.Data[7], events.Data[11], events.Data[12], events.Data[14], events.Data[24]
	report := run.EvalReport
	got := map[string]any{
		"artifact.provenance.source":                       string(artifact.Provenance.Source),
		"artifact.provenance.uploader":                     *artifact.Provenance.Uploader,
		"artifact_import.status":                           string(artifactImport.Status),
		"artifact_import.error_code":                       *artifactImport.ErrorCode,
		"run.phase":                                        string(*run.Phase),
		"run.last_interruption.reason":                     string(run.LastInterruption.Reason),
		"run.last_interruption.resume_step":                float64(*run.LastInterruption.ResumeStep),
		"run_events.data[2].phase":                         string(*ev2.Phase),
		"run_events.data[2].workers_online":                float64(*ev2.WorkersOnline),
		"run_events.data[0].queue_position":                float64(*events.Data[0].QueuePosition),
		"run_events.data[2].message":                       *ev2.Message,
		"run.min_gpu_memory_gb":                            *run.MinGPUMemoryGb,
		"run_events.data[4].gpu.name":                      ev4.GPU.Name,
		"run_events.data[7].metric.step":                   float64(ev7.Metric.Step),
		"run_events.data[11].checkpoint_id":                *ev11.CheckpointID,
		"run_events.data[12].event":                        string(*ev12.Event),
		"run_events.data[12].reason":                       string(*ev12.Reason),
		"run_events.data[14].resume_step":                  float64(*ev14.ResumeStep),
		"run_events.data[24].status":                       string(*ev24.Status),
		"run_events.data[24].run.last_interruption.reason": string(ev24.Run.LastInterruption.Reason),
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
		"run_plan.estimated_duration_s":                    float64(runPlan.EstimatedDurationS),
		"run_plan.min_gpu_memory_gb":                       *runPlan.MinGPUMemoryGb,
		"run_plan.cost_breakdown.train_usd":                runPlan.CostBreakdown.TrainUSD,
		"source.id":                                        source.ID,
		"source.provider.kind":                             string(source.Provider.Kind),
		"source.provider.secret":                           *source.Provider.Secret,
		"source.schedule":                                  *source.Schedule,
		"source.sample_rate":                               source.SampleRate,
		"source.max_records_per_day":                       float64(*source.MaxRecordsPerDay),
		"source.records_today":                             float64(source.RecordsToday),
		"source.pending_records":                           float64(source.PendingRecords),
		"source.last_sync.status":                          string(source.LastSync.Status),
		"source.last_sync.dataset_version":                 float64(*source.LastSync.DatasetVersion),
		"source.status":                                    string(source.Status),
		"source.consecutive_failures":                      float64(source.ConsecutiveFailures),
		"source.last_error":                                *source.LastError,
		"secret.name":                                      secret.Name,
		"secret.allowed_hosts[0]":                          secret.AllowedHosts[0],
		"usage[0].kind":                                    string(usage.Kind),
		"usage[0].tokens_through":                          float64(usage.TokensThrough),
		"usage[0].ref_name":                                *usage.RefName,
		"usage[0].run_id":                                  *usage.RunID,
		"usage[0].cost_usd":                                usage.CostUSD,
		"usage_summary.from":                               totals.From,
		"usage_summary.cost_usd":                           totals.CostUSD,
		"usage_summary.tokens":                             float64(totals.Tokens),
		"usage_summary.by_kind[0].kind":                    string(totals.ByKind[0].Kind),
		"usage_summary.top_runs[0].name":                   *totals.TopRuns[0].Name,
		"usage_summary.top_evals[0].kind":                  string(totals.TopEvals[0].Kind),
		"usage_summary.groups[1].key":                      *totals.Groups[1].Key,
		"usage_summary.groups[1].tokens":                   float64(totals.Groups[1].Tokens),
	}
	if !reflect.DeepEqual(got, p.Expect) {
		t.Fatalf("typed responses\n got %v\nwant %v", got, p.Expect)
	}
}

func queryMap(raw string) map[string]string {
	values, _ := url.ParseQuery(raw)
	out := map[string]string{}
	for k, v := range values {
		out[k] = v[0]
	}
	return out
}
