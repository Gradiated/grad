package grad_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	grad "github.com/Gradiated/grad/sdks/go"
)

func TestEvalCreateWaitRunsLocalScorers(t *testing.T) {
	ctx := context.Background()
	awaiting := wireMap(t, "eval-awaiting-scores.json")
	id := awaiting["id"].(string)
	queued := wireMap(t, "eval-awaiting-scores.json")
	queued["status"] = "running"
	outputs := wireMap(t, "eval-outputs.json")
	var mu sync.Mutex
	posted := false
	f := newFake(t, map[string]route{
		"POST /v1/evals/plan": jsonBody(200, wire(t, "plan-eval.json")),
		"POST /v1/evals":      jsonValue(202, queued),
		"GET /v1/evals/" + id: func(w http.ResponseWriter, r *http.Request, b []byte) {
			mu.Lock()
			done := posted
			mu.Unlock()
			if done {
				jsonBody(200, wire(t, "eval-completed.json"))(w, r, b)
				return
			}
			jsonValue(200, awaiting)(w, r, b)
		},
		"GET /v1/evals/" + id + "/outputs": func(w http.ResponseWriter, r *http.Request, b []byte) {
			if r.URL.Query().Get("missing_scorer") != "mentions_menu" {
				t.Errorf("outputs query %s", r.URL.RawQuery)
			}
			mu.Lock()
			done := posted
			mu.Unlock()
			if done {
				jsonValue(200, map[string]any{"data": []any{}, "next_cursor": nil})(w, r, b)
				return
			}
			jsonValue(200, outputs)(w, r, b)
		},
		"POST /v1/evals/" + id + "/scores": func(w http.ResponseWriter, r *http.Request, b []byte) {
			mu.Lock()
			posted = true
			mu.Unlock()
			jsonBody(200, wire(t, "eval-scores-response.json"))(w, r, b)
		},
		"GET /v1/evals/" + id + "/failures":    jsonValue(200, map[string]any{"eval_id": id, "data": []any{map[string]any{"task_id": "t1", "model": "m", "score": 0.2, "passed": false, "sample_scores": []any{0.2}, "judge_model": nil, "record": map[string]any{"session_id": "s1", "messages": []any{map[string]any{"role": "user", "content": "q"}}}}}, "next_cursor": nil}),
		"POST /v1/datasets/hard-cases/records": jsonBody(200, wire(t, "dataset.json")),
	})
	c, _ := f.client()
	mentionsMenu := func(_ context.Context, in grad.ScoreInput) (float64, error) {
		if strings.Contains(in.Output, "->") || strings.Contains(fmt.Sprint(in.Expected), "->") {
			return 1, nil
		}
		return 0, nil
	}
	params := grad.EvalParams{
		Name:     "support-eval",
		Models:   []string{"test/tiny-qwen3", "qwen/qwen3-8b"},
		Baseline: "qwen/qwen3-8b",
		Dataset:  grad.DatasetName("support-eval"),
		Rubric: grad.Rubric{
			grad.Scorer{Name: "non_empty", Validator: grad.ValidatorNonEmpty},
			grad.Scorer{Name: "mentions_menu", Weight: 0.5, Fn: mentionsMenu},
			grad.Judge{Name: "resolved", Model: "qwen/qwen3-8b", Prompt: "Was it resolved?", Weight: 2},
			grad.Regex{Name: "cites", Pattern: "#\\d+", Flags: "i"},
		},
		Samples:       2,
		Temperature:   grad.Float(0),
		PassThreshold: grad.Float(0.5),
		MaxTokens:     256,
	}
	plan, err := c.Evals.Plan(ctx, params)
	if err != nil || plan.EstimatedTasks == 0 {
		t.Fatalf("plan %v %v", plan, err)
	}
	body := f.last("POST", "/v1/evals/plan").JSON(t)
	raw, _ := json.Marshal(body["rubric"])
	want := `[{"kind":"validator","name":"non_empty","validator":"non_empty"},{"kind":"code","name":"mentions_menu","runtime":"local","weight":0.5},{"kind":"judge","model":"qwen/qwen3-8b","name":"resolved","prompt":"Was it resolved?","weight":2},{"flags":"i","kind":"regex","name":"cites","pattern":"#\\d+"}]`
	if string(raw) != want {
		t.Fatalf("rubric wire\n got %s\nwant %s", raw, want)
	}
	if body["temperature"] != 0.0 || body["pass_threshold"] != 0.5 || body["samples"] != 2.0 || body["dataset"] != "support-eval" {
		t.Fatalf("eval body %v", body)
	}

	ev, err := c.Evals.Create(ctx, params).Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if ev.Status != "completed" || len(ev.Summary) != 2 {
		t.Fatalf("eval %+v", ev.EvalRun)
	}
	scores := f.last("POST", "/v1/evals/"+id+"/scores").JSON(t)["scores"].([]any)
	if len(scores) != len(outputs["data"].([]any)) {
		t.Fatalf("posted %d scores", len(scores))
	}
	first := scores[0].(map[string]any)
	if first["scorer"] != "mentions_menu" || first["score"] != 1.0 {
		t.Fatalf("score %v", first)
	}
	table := ev.SummaryTable()
	if !strings.Contains(table, "test/tiny-qwen3") || !strings.Contains(table, "95% CI") || !strings.Contains(table, "@1=") {
		t.Fatalf("summary table:\n%s", table)
	}

	failures, err := ev.Failures(ctx, grad.FailureOptions{Model: "m", Threshold: grad.Float(0.8)})
	if err != nil || len(failures.Outcomes) != 1 {
		t.Fatalf("failures %v", err)
	}
	if q := f.last("GET", "/v1/evals/"+id+"/failures").Query; !strings.Contains(q, "threshold=0.8") || !strings.Contains(q, "model=m") {
		t.Fatalf("failures query %s", q)
	}
	if _, err := failures.ToDataset(ctx, "hard-cases"); err != nil {
		t.Fatal(err)
	}
	if recs := f.last("POST", "/v1/datasets/hard-cases/records").JSON(t)["records"].([]any); recs[0].(map[string]any)["session_id"] != "s1" {
		t.Fatalf("to dataset %v", recs)
	}
	empty := &grad.EvalFailures{EvalID: "e"}
	if _, err := empty.ToDataset(ctx, "x"); err == nil {
		t.Fatal("empty failures pushed")
	}
}

func TestEvalWaitErrors(t *testing.T) {
	ctx := context.Background()
	awaiting := wireMap(t, "eval-awaiting-scores.json")
	id := awaiting["id"].(string)
	failed := wireMap(t, "eval-completed.json")
	failed["status"] = "failed"
	failed["error"] = "inference endpoint returned 500"
	failed["id"] = "eval_failed"
	outputs := wireMap(t, "eval-outputs.json")
	f := newFake(t, map[string]route{
		"GET /v1/evals/" + id:              jsonValue(200, awaiting),
		"GET /v1/evals/eval_failed":        jsonValue(200, failed),
		"GET /v1/evals/" + id + "/outputs": jsonValue(200, outputs),
		"POST /v1/evals/" + id + "/scores": jsonBody(200, wire(t, "eval-scores-response.json")),
		"GET /v1/evals":                    jsonValue(200, map[string]any{"data": []any{failed}, "next_cursor": nil}),
		"POST /v1/evals/" + id + "/cancel": jsonValue(200, failed),
	})
	c, _ := f.client()
	if _, err := c.Evals.Wait(ctx, id); err == nil || !strings.Contains(err.Error(), "mentions_menu") || !strings.Contains(err.Error(), "WithRubric") {
		t.Fatalf("missing scorer: %v", err)
	}
	outOfRange := grad.Rubric{grad.Scorer{Name: "mentions_menu", Fn: func(context.Context, grad.ScoreInput) (float64, error) { return 7, nil }}}
	if _, err := c.Evals.Wait(ctx, id, grad.WithRubric(outOfRange)); err == nil || !strings.Contains(err.Error(), "[0, 1]") {
		t.Fatalf("out of range: %v", err)
	}
	failing := grad.Rubric{grad.Scorer{Name: "mentions_menu", Fn: func(context.Context, grad.ScoreInput) (float64, error) { return 0, errors.New("boom") }}}
	if _, err := c.Evals.Wait(ctx, id, grad.WithRubric(failing)); err == nil || !strings.Contains(err.Error(), "boom") {
		t.Fatalf("scorer error: %v", err)
	}
	stuck := grad.Rubric{grad.Scorer{Name: "mentions_menu", Fn: func(context.Context, grad.ScoreInput) (float64, error) { return 1, nil }}}
	if _, err := c.Evals.Wait(ctx, id, grad.WithRubric(stuck)); err == nil || !strings.Contains(err.Error(), "still lists") {
		t.Fatalf("server not accepting scores: %v", err)
	}
	_, err := c.Evals.Wait(ctx, "eval_failed")
	var ef *grad.EvalFailedError
	if !errors.As(err, &ef) || !strings.Contains(err.Error(), "returned 500") || ef.Eval.Status != "failed" {
		t.Fatalf("failed eval: %v", err)
	}
	if evs, err := grad.Collect(c.Evals.List(ctx)); err != nil || len(evs) != 1 {
		t.Fatalf("list %v", err)
	}
	if e, err := c.Evals.Cancel(ctx, id); err != nil || e.Status != "failed" {
		t.Fatalf("cancel %v", err)
	}
	e, _ := c.Evals.Get(ctx, "eval_failed")
	if err := e.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []grad.RubricItem{grad.Judge{Name: "j"}, grad.Scorer{}, grad.Scorer{Name: "s"}, grad.Scorer{Name: "s", Validator: grad.ValidatorJSON, Fn: func(context.Context, grad.ScoreInput) (float64, error) { return 0, nil }}, grad.Regex{Name: "r"}} {
		if _, err := c.Evals.Plan(ctx, grad.EvalParams{Models: []string{"m"}, Dataset: grad.DatasetName("d"), Rubric: grad.Rubric{bad}}); err == nil {
			t.Fatalf("invalid rubric item accepted: %+v", bad)
		}
		if _, err := c.Evals.Create(ctx, grad.EvalParams{Models: []string{"m"}, Dataset: grad.DatasetName("d"), Rubric: grad.Rubric{bad}}).Result(); err == nil {
			t.Fatalf("invalid rubric item accepted: %+v", bad)
		}
	}
	if _, err := c.Evals.Wait(ctx, id, grad.WithRubric(grad.Rubric{grad.Judge{}})); err == nil {
		t.Fatal("invalid WithRubric accepted")
	}
}

func TestNumericMatch(t *testing.T) {
	ctx := context.Background()
	score := func(fn grad.ScorerFunc, in grad.ScoreInput) float64 {
		t.Helper()
		v, err := fn(ctx, in)
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	if v := score(grad.NumericMatch(""), grad.ScoreInput{Output: "so the answer is 1,234.", Expected: "#### 1234"}); v != 1 {
		t.Fatalf("expected match, got %v", v)
	}
	if v := score(grad.NumericMatch("answer"), grad.ScoreInput{Output: "42", Expected: map[string]any{"answer": "41"}}); v != 0 {
		t.Fatalf("expected mismatch, got %v", v)
	}
	if v := score(grad.NumericMatch("answer"), grad.ScoreInput{Output: "x = -3.5", Record: grad.Trajectory{Metadata: map[string]any{"answer": -3.5}}}); v != 1 {
		t.Fatalf("metadata match, got %v", v)
	}
	if v := score(grad.NumericMatch(""), grad.ScoreInput{Output: "no idea", Expected: "7"}); v != 0 {
		t.Fatalf("no number in output, got %v", v)
	}
	if _, err := grad.NumericMatch("answer")(ctx, grad.ScoreInput{Output: "1"}); err == nil {
		t.Fatal("missing expected accepted")
	}
	if _, err := grad.NumericMatch("")(ctx, grad.ScoreInput{Output: "1", Expected: "none"}); err == nil {
		t.Fatal("expected without number accepted")
	}
}

func recipeJSON(t *testing.T, r grad.Recipe) string {
	t.Helper()
	spec, err := r.RecipeSpec()
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := json.Marshal(spec)
	return string(raw)
}

func TestRecipesSendOnlyUserSetFields(t *testing.T) {
	ctxFile := filepath.Join(t.TempDir(), "docs.md")
	_ = os.WriteFile(ctxFile, []byte("API docs"), 0o600)
	cases := []struct {
		recipe grad.Recipe
		want   string
	}{
		{grad.SFTRecipe{}, `{"kind":"sft"}`},
		{grad.SFTRecipe{Common: grad.Common{Model: "qwen/qwen3-8b"}, MergeOnExport: true}, `{"kind":"sft","model":"qwen/qwen3-8b","adapter":{"kind":"lora","merge_on_export":true}}`},
		{grad.SFTRecipe{Common: grad.Common{Adapter: grad.LoRA{Rank: 16}, LR: 1e-4, LRScale: 2, Epochs: 2, Schedule: "cosine", Warmup: 0.1, TrainOn: "all_assistant", Thinking: "off", PreserveThinking: true, Reduction: "per_token", Select: "last", CheckpointTTLDays: 7}, MergeOnExport: true},
			`{"kind":"sft","adapter":{"kind":"lora","rank":16,"merge_on_export":true},"lr":0.0001,"lr_scale":2,"epochs":2,"schedule":"cosine","warmup":0.1,"train_on":"all_assistant","thinking":"off","preserve_thinking":true,"reduction":"per_token","select":"last","checkpoint_ttl_days":7}`},
		{grad.SFTRecipe{Common: grad.Common{Optimizer: &grad.AdamW{LR: 1e-4}}}, `{"kind":"sft","lr":0.0001,"optimizer":{"kind":"adamw","betas":[0.9,0.95],"weight_decay":0,"grad_clip":1}}`},
		{grad.DPORecipe{Common: grad.Common{Model: "fast-diff-merge@sft-v1"}, Beta: 0.3}, `{"kind":"dpo","model":"fast-diff-merge@sft-v1","beta":0.3}`},
		{grad.RouterRecipe{Models: []string{"a", "b"}, Rubric: "resolved"}, `{"kind":"router","models":["a","b"],"rubric":"resolved"}`},
		{grad.EmbeddingRecipe{Pool: "mean"}, `{"kind":"embedding","pool":{"kind":"mean"}}`},
		{grad.RouterRecipe{}, `{"kind":"router"}`},
		{grad.RouterRecipe{Models: []string{"a", "b"}, MaxQualityDrop: 0.05}, `{"kind":"router","models":["a","b"],"max_quality_drop":0.05}`},
		{grad.DecisionModelRecipe{}, `{"kind":"decision"}`},
		{grad.CartridgeRecipe{Context: grad.ContextFromText("ctx"), NumTokens: 512, Common: grad.Common{Adapter: grad.PrefixKV{NumTokens: 512}}}, `{"kind":"cartridge","adapter":{"kind":"prefix_kv","num_tokens":512},"context_text":"ctx","num_tokens":512}`},
		{grad.CartridgeRecipe{Context: grad.ContextFromFile(ctxFile)}, `{"kind":"cartridge","context_text":"API docs"}`},
		{grad.CartridgeRecipe{Context: grad.ContextFromURI("s3://b/k")}, `{"kind":"cartridge","context_uri":"s3://b/k"}`},
		{grad.EmbeddingRecipe{Temp: 0.03}, `{"kind":"embedding","temp":0.03}`},
		{grad.DecisionModelRecipe{Common: grad.Common{Adapter: grad.FrozenHead{}}}, `{"kind":"decision","adapter":{"kind":"frozen_head"}}`},
		{grad.RawRecipe{Kind: "sft", BatchSize: grad.Int(8)}, `{"kind":"sft","batch_size":8}`},
		{grad.DistillRecipe{Common: grad.Common{Model: "qwen/qwen3-4b"}, Teacher: "qwen/qwen3-32b"}, `{"kind":"distill","model":"qwen/qwen3-4b","teacher":"qwen/qwen3-32b"}`},
		{grad.DistillRecipe{Teacher: "big@1", OffPolicy: true}, `{"kind":"distill","teacher":"big@1","rollout":{"kind":"off_policy"},"loss":{"kind":"cross_entropy"}}`},
		{grad.RewardModelRecipe{}, `{"kind":"reward"}`},
		{grad.RewardModelRecipe{Common: grad.Common{Model: "qwen/qwen3-8b", Adapter: grad.LoRA{Rank: 8}}, Rubric: "resolved"}, `{"kind":"reward","model":"qwen/qwen3-8b","adapter":{"kind":"lora","rank":8},"rubric":"resolved"}`},
	}
	for _, tc := range cases {
		if got := recipeJSON(t, tc.recipe); got != tc.want {
			t.Errorf("%T\n got %s\nwant %s", tc.recipe, got, tc.want)
		}
	}
	for _, bad := range []grad.Recipe{
		grad.SFTRecipe{MergeOnExport: true, Common: grad.Common{Adapter: grad.PrefixKV{}}},
		grad.SFTRecipe{Common: grad.Common{LR: 1e-3, Optimizer: &grad.AdamW{LR: 1e-4}}},
		grad.RouterRecipe{Models: []string{"a", "b"}, Rubric: grad.Scorer{Name: "mine", Fn: func(context.Context, grad.ScoreInput) (float64, error) { return 1, nil }}},
		grad.RouterRecipe{Rubric: grad.Judge{Name: "j", Model: "m"}},
		grad.RouterRecipe{Rubric: 42},
		grad.CartridgeRecipe{Context: grad.ContextFromFile(filepath.Join(t.TempDir(), "missing"))},
		grad.DistillRecipe{},
		grad.DistillRecipe{Teacher: "t", OffPolicy: true, TopK: 8},
		grad.DistillRecipe{Teacher: "t", OffPolicy: true, Context: grad.ContextFromText("x")},
		grad.DistillRecipe{Teacher: "t", Common: grad.Common{LR: 1e-3, Optimizer: &grad.AdamW{LR: 1e-4}}},
	} {
		if _, err := bad.RecipeSpec(); err == nil {
			t.Errorf("%T accepted", bad)
		}
	}
	for _, s := range []struct {
		split grad.Split
		want  string
	}{
		{grad.BySession{}, `"by_session"`},
		{grad.ByGroup{EvalFraction: 0.2, Seed: 7}, `"by_group"`},
		{grad.Random{}, `"random"`},
	} {
		f := newFake(t, map[string]route{"POST /v1/runs/plan": jsonBody(200, wire(t, "plan-run.json"))})
		c, _ := f.client()
		if _, err := c.Runs.Plan(context.Background(), grad.RunParams{Dataset: grad.DatasetName("d"), Name: "n", Recipe: grad.SFTRecipe{}, Split: s.split}); err != nil {
			t.Fatal(err)
		}
		if raw := string(f.last("POST", "/v1/runs/plan").Body); !strings.Contains(raw, s.want) {
			t.Errorf("split %s missing in %s", s.want, raw)
		}
	}
}

func TestEvalNeedsADataset(t *testing.T) {
	f := newFake(t, map[string]route{})
	c, _ := f.client()
	_, err := c.Evals.Plan(context.Background(), grad.EvalParams{Models: []string{"m"}})
	if err == nil || !strings.Contains(err.Error(), "EvalParams.Dataset is required") {
		t.Fatalf("err %v", err)
	}
	if n := len(f.requests()); n != 0 {
		t.Fatalf("sent %d requests without a dataset", n)
	}
}
