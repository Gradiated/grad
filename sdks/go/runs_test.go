package grad_test

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	grad "github.com/Gradiated/grad/sdks/go"
	"github.com/Gradiated/grad/sdks/go/generated"
)

func runFixture(t *testing.T, status string) map[string]any {
	t.Helper()
	r := wireMap(t, "run-completed.json")
	r["status"] = status
	if status != "completed" {
		r["artifact_id"] = nil
	}
	return r
}

func TestRunsPlanCreateWait(t *testing.T) {
	ctx := context.Background()
	run := runFixture(t, "completed")
	id := run["id"].(string)
	artifact := wireMap(t, "artifact.json")
	f := newFake(t, map[string]route{
		"POST /v1/runs/plan": jsonBody(200, wire(t, "plan-run.json")),
		"POST /v1/runs":      jsonBody(202, wire(t, "run-queued.json")),
		"GET /v1/runs/" + id: sequence(jsonValue(200, runFixture(t, "queued")), jsonValue(200, runFixture(t, "running")), problem(503, "unavailable"), jsonValue(200, run)),
		"GET /v1/runs/" + id + "/metrics": sequence(
			jsonValue(200, map[string]any{"run_id": id, "status": "running", "data": wireMap(t, "metrics-page.json")["data"].([]any)[:2], "next_cursor": nil, "tail_cursor": "c2"}),
			jsonValue(200, map[string]any{"run_id": id, "status": "running", "data": wireMap(t, "metrics-page.json")["data"].([]any)[2:], "next_cursor": nil, "tail_cursor": "c6"}),
			jsonValue(200, map[string]any{"run_id": id, "status": "completed", "data": []any{}, "next_cursor": nil, "tail_cursor": "c6"}),
		),
		"GET /v1/artifacts/" + artifact["id"].(string): jsonValue(200, artifact),
	})
	c, clk := f.client(grad.WithMaxRetries(0))
	params := grad.RunParams{
		Dataset:    grad.DatasetName("support-prod"),
		Name:       "support-sft",
		Recipe:     grad.SFTRecipe{Common: grad.Common{Model: "test/tiny-qwen3", BatchSize: 1}},
		Split:      grad.BySession{EvalFraction: 0.2},
		MaxCostUSD: 5,
	}
	plan, err := c.Runs.Plan(ctx, params)
	if err != nil {
		t.Fatal(err)
	}
	if plan.ResolvedRecipe.Model != "test/tiny-qwen3" || plan.EstimatedTokens == 0 || plan.ResolvedRecipe.RuleVersion != plan.ResolvedConfig.RuleVersion {
		t.Fatalf("plan %+v", plan)
	}
	// fmt.Println(plan) prints the same readout as Python's print(plan) and the CLI.
	text := fmt.Sprint(plan)
	for _, want := range []string{"Dataset     support-prod v2", "Recipe      sft · model test/tiny-qwen3 · LoRA(rank=", "Estimate    ~", "Breakdown   train ~$0.0002 · teacher ~$0.00 · evals ~$0.00 (held-out evals during training aren't billed)", "Duration    ~", "on one GPU", "Warnings    2", "  ! 6 steps are below"} {
		if !strings.Contains(text, want) {
			t.Fatalf("plan readout lacks %q:\n%s", want, text)
		}
	}
	labeled := &grad.RunPlan{}
	labeled.ResolvedConfig.RecipeParams = map[string]any{"context_text": "abcd", "max_quality_drop": 0.02, "models": []any{"a", "b"}}
	labeled.Labeling = &generated.PlanRunResponseLabeling{EstimatedModelCalls: 1200, EstimatedJudgeCalls: 3, EstimatedCostUSD: 0.004}
	labeled.Teacher = &generated.PlanRunResponseTeacher{Model: "big", EstimatedTokens: 25_000_000, EstimatedCostUSD: 1234.5}
	gb := 36.0
	labeled.EstimatedDurationS, labeled.MinGPUMemoryGb = 843, &gb
	text = labeled.String()
	for _, want := range []string{"Params      context_text=<4 chars>, max_quality_drop=0.02, models=[\"a\",\"b\"]", "Labeling    1,200 model · 3 judge calls, ~$0.0040", "Teacher     big: ~25.0M tokens, ~$1,234.50", "Duration    ~14 min on one GPU · needs 36 GB of GPU memory"} {
		if !strings.Contains(text, want) {
			t.Fatalf("plan readout lacks %q:\n%s", want, text)
		}
	}
	if (*grad.RunPlan)(nil).String() != "<nil plan>" {
		t.Fatal("nil plan")
	}
	body := f.last("POST", "/v1/runs/plan").JSON(t)
	recipe := body["recipe"].(map[string]any)
	if body["dataset"] != "support-prod" || body["max_cost_usd"] != 5.0 || recipe["kind"] != "sft" || recipe["batch_size"] != 1.0 || len(recipe) != 3 {
		t.Fatalf("plan body %v", body)
	}
	if split := body["split"].(map[string]any); split["strategy"] != "by_session" || split["eval_fraction"] != 0.2 {
		t.Fatalf("split %v", split)
	}

	var statuses []string
	var steps []int
	got, err := c.Runs.Create(ctx, params).Wait(ctx,
		grad.WithOnStatus(func(s string) { statuses = append(statuses, s) }),
		grad.WithOnMetric(func(m grad.MetricPoint) { steps = append(steps, m.Step) }))
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != grad.RunCompleted || got.Artifact == nil || got.Artifact.ID != artifact["id"] {
		t.Fatalf("run %+v artifact %+v", got.Run, got.Artifact)
	}
	if fmt.Sprint(statuses) != "[queued running completed]" || fmt.Sprint(steps) != "[1 2 3 4 5 6]" {
		t.Fatalf("statuses %v steps %v", statuses, steps)
	}
	if q := f.requests(); !strings.Contains(fmt.Sprint(q), "cursor=c2") {
		t.Fatalf("tail_cursor was not passed back")
	}
	sleeps := clk.Sleeps()
	want := []time.Duration{500 * time.Millisecond, 750 * time.Millisecond, 1125 * time.Millisecond}
	if fmt.Sprint(sleeps) != fmt.Sprint(want) {
		t.Fatalf("poll backoff %v", sleeps)
	}
}

func TestCreateCarriesThePlanWarnings(t *testing.T) {
	dup := "run support-sft is already running (run_abc); this starts a second one."
	queued := wireMap(t, "run-queued.json")
	queued["warnings"] = []any{dup}
	f := newFake(t, map[string]route{"POST /v1/runs": jsonValue(202, queued)})
	c, _ := f.client(grad.WithMaxRetries(0))
	run, err := c.Runs.Create(context.Background(), grad.RunParams{
		Dataset: grad.DatasetName("support"), Name: "support-sft", Recipe: grad.SFTRecipe{},
	}).Result()
	if err != nil || fmt.Sprint(run.Warnings) != fmt.Sprint([]string{dup}) {
		t.Fatalf("run %+v err %v", run, err)
	}
}

func TestRunWaitTerminalFailuresTimeoutAndCancel(t *testing.T) {
	ctx := context.Background()
	for _, status := range []string{"failed", "cancelled", "stopped_budget"} {
		r := runFixture(t, status)
		r["error"] = "trainer crashed: CUDA OOM"
		f := newFake(t, map[string]route{"GET /v1/runs/" + r["id"].(string): jsonValue(200, r)})
		c, _ := f.client()
		got, err := c.Runs.Wait(ctx, r["id"].(string))
		var rf *grad.RunFailedError
		if !errors.As(err, &rf) || string(rf.Run.Status) != status || rf.Code != "run_"+status || got == nil {
			t.Fatalf("%s: %v", status, err)
		}
		if status == "failed" && !strings.Contains(err.Error(), "CUDA OOM") {
			t.Fatalf("server error missing: %v", err)
		}
		if status == "stopped_budget" && !strings.Contains(err.Error(), "Resume") {
			t.Fatalf("budget hint missing: %v", err)
		}
	}

	r := runFixture(t, "running")
	id := r["id"].(string)
	f := newFake(t, map[string]route{"GET /v1/runs/" + id: jsonValue(200, r)})
	c, clk := f.client()
	run, err := c.Runs.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	// No timeout given: the 24 h default still ends the wait.
	c2, _ := newFake(t, map[string]route{"GET /v1/runs/" + id: jsonValue(200, r)}).client()
	run2, err := c2.Runs.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	err = run2.Wait(ctx, grad.WithPollInterval(time.Hour, time.Hour))
	var dt *grad.WaitTimeoutError
	if !errors.As(err, &dt) || !strings.Contains(err.Error(), "24h0m0s") {
		t.Fatalf("default timeout: %v", err)
	}
	err = run.Wait(ctx, grad.WithWaitTimeout(10*time.Second), grad.WithPollInterval(time.Second, 2*time.Second))
	var wt *grad.WaitTimeoutError
	if !errors.As(err, &wt) || wt.LastStatus != "running" {
		t.Fatalf("timeout: %v", err)
	}
	for _, s := range clk.Sleeps() {
		if s > 2*time.Second {
			t.Fatalf("interval exceeded max: %v", clk.Sleeps())
		}
	}
	cctx, cancel := context.WithCancel(ctx)
	cancel()
	if err := run.Wait(cctx); err == nil {
		t.Fatal("cancelled wait returned nil")
	}

	f404 := newFake(t, map[string]route{})
	c404, _ := f404.client()
	if _, err := c404.Runs.Wait(ctx, "run_missing"); !grad.IsNotFound(err) {
		t.Fatalf("404 should stop waiting: %v", err)
	}
}

func TestRunListCancelResumeCheckpointsPromote(t *testing.T) {
	ctx := context.Background()
	run := wireMap(t, "run-completed.json")
	id := run["id"].(string)
	ckpts := wireMap(t, "checkpoints.json")
	ckptID := ckpts["data"].([]any)[0].(map[string]any)["id"].(string)
	f := newFake(t, map[string]route{
		"GET /v1/runs":                                jsonBody(200, wire(t, "runs-page.json")),
		"GET /v1/runs/" + id:                          jsonValue(200, run),
		"POST /v1/runs/" + id + "/cancel":             jsonValue(200, runFixture(t, "cancelled")),
		"POST /v1/runs/" + id + "/resume":             jsonValue(200, runFixture(t, "queued")),
		"GET /v1/runs/" + id + "/checkpoints":         jsonValue(200, ckpts),
		"POST /v1/checkpoints/" + ckptID + "/promote": jsonBody(201, wire(t, "artifact.json")),
	})
	c, _ := f.client()
	runs, err := grad.Collect(c.Runs.List(ctx, grad.RunListOptions{}))
	if err != nil || len(runs) == 0 {
		t.Fatalf("list %v %v", runs, err)
	}
	r, err := c.Runs.Get(ctx, id)
	if err != nil {
		t.Fatal(err)
	}
	if err := r.Cancel(ctx); err != nil || r.Status != grad.RunCancelled {
		t.Fatalf("cancel %v %v", r.Status, err)
	}
	if err := r.Resume(ctx, grad.ResumeOptions{MaxCostUSD: 25}); err != nil || r.Status != grad.RunQueued {
		t.Fatalf("resume %v %v", r.Status, err)
	}
	if body := f.last("POST", "/v1/runs/"+id+"/resume").JSON(t); body["max_cost_usd"] != 25.0 {
		t.Fatalf("resume body %v", body)
	}
	if _, err := c.Runs.Resume(ctx, id, grad.ResumeOptions{}); err != nil {
		t.Fatal(err)
	}
	if body := f.last("POST", "/v1/runs/"+id+"/resume").JSON(t); len(body) != 0 {
		t.Fatalf("resume without cap should send {}: %v", body)
	}
	if err := r.Refresh(ctx); err != nil || r.Status != grad.RunCompleted {
		t.Fatal(err)
	}
	list, err := r.Checkpoints(ctx)
	if err != nil || len(list) != len(ckpts["data"].([]any)) {
		t.Fatalf("checkpoints %d %v", len(list), err)
	}
	art, err := list[0].Promote(ctx, "keeper")
	if err != nil || art.Ref() == "" {
		t.Fatalf("promote %v %v", art, err)
	}
	if body := f.last("POST", "/v1/checkpoints/"+ckptID+"/promote").JSON(t); body["name"] != "keeper" {
		t.Fatalf("promote body %v", body)
	}
	if _, err := c.Checkpoints.Promote(ctx, ckptID, ""); err != nil {
		t.Fatal(err)
	}
	if body := f.last("POST", "/v1/checkpoints/"+ckptID+"/promote").JSON(t); len(body) != 0 {
		t.Fatalf("promote without name %v", body)
	}
	if !grad.IsTerminal(grad.RunStoppedBudget) || grad.IsTerminal(grad.RunRunning) {
		t.Fatal("IsTerminal")
	}
	noArtifact := &grad.Run{}
	if _, err := noArtifact.Download(ctx, t.TempDir()); err == nil {
		t.Fatal("download without artifact")
	}
	if _, err := c.Runs.Create(ctx, grad.RunParams{Name: "x", Recipe: grad.SFTRecipe{}}).Result(); err == nil {
		t.Fatal("missing dataset accepted")
	}
	if _, err := c.Runs.Plan(ctx, grad.RunParams{Dataset: grad.DatasetName("d"), Name: "x"}); err == nil {
		t.Fatal("missing recipe accepted")
	}
}

func TestMetricsFollowReconnectsWithLastEventID(t *testing.T) {
	ctx := context.Background()
	blocks := strings.Split(strings.TrimSpace(string(wire(t, "run-events.sse"))), "\n\n")
	if len(blocks) != 25 {
		t.Fatalf("fixture has %d events", len(blocks))
	}
	run := wireMap(t, "run-completed.json")
	id := run["id"].(string)
	var lastIDs []string
	connections := 0
	f := newFake(t, map[string]route{
		"GET /v1/runs/" + id + "/events": func(w http.ResponseWriter, r *http.Request, _ []byte) {
			if r.Header.Get("Accept") != "text/event-stream" {
				t.Errorf("accept %q", r.Header.Get("Accept"))
			}
			connections++
			lastIDs = append(lastIDs, r.Header.Get("Last-Event-ID"))
			w.Header().Set("Content-Type", "text/event-stream")
			switch connections {
			case 1:
				_, _ = w.Write([]byte(": ping\n\n" + strings.Join(blocks[:8], "\n\n") + "\n\n"))
			case 2:
				problem(503, "unavailable")(w, r, nil)
			default:
				_, _ = w.Write([]byte(strings.Join(blocks[8:], "\n\n") + "\n\n"))
			}
		},
	})
	c, clk := f.client(grad.WithMaxRetries(0))
	var steps []int
	for m, err := range c.Runs.Metrics(ctx, id, true) {
		if err != nil {
			t.Fatal(err)
		}
		steps = append(steps, m.Step)
	}
	if fmt.Sprint(steps) != "[1 2 3]" {
		t.Fatalf("steps %v", steps)
	}
	if fmt.Sprint(lastIDs) != "[ 8 8]" {
		t.Fatalf("Last-Event-ID per connection %q", lastIDs)
	}
	if len(clk.Sleeps()) != 2 {
		t.Fatalf("reconnect sleeps %v", clk.Sleeps())
	}

	// Breaking out of the loop early stops cleanly.
	count := 0
	for _, err := range c.Runs.Metrics(ctx, id, true) {
		if err != nil {
			t.Fatal(err)
		}
		count++
		break
	}
	if count != 1 {
		t.Fatal("early break")
	}
}

func TestMetricsFollowGivesUpOnPermanentErrors(t *testing.T) {
	f := newFake(t, map[string]route{"GET /v1/runs/run_x/events": problem(404, "run_not_found")})
	c, _ := f.client()
	for _, err := range c.Runs.Metrics(context.Background(), "run_x", true) {
		if !grad.IsNotFound(err) {
			t.Fatalf("err %v", err)
		}
	}
	bad := newFake(t, map[string]route{"GET /v1/runs/run_x/events": func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event: metric\nid: 1\ndata: {not json\n\n"))
	}})
	cb, _ := bad.client()
	for _, err := range cb.Runs.Metrics(context.Background(), "run_x", true) {
		var de *grad.DecodeError
		if !errors.As(err, &de) {
			t.Fatalf("err %v", err)
		}
	}
}

func TestMetricsPagesWithoutFollow(t *testing.T) {
	// next_cursor is null on the last page (tail_cursor is only for tailing), so one request suffices.
	page := wireMap(t, "metrics-page.json")
	f := newFake(t, map[string]route{"GET /v1/runs/run_x/metrics": jsonValue(200, page)})
	c, _ := f.client()
	points, err := grad.Collect(c.Runs.Metrics(context.Background(), "run_x", false))
	if err != nil || len(points) != 6 || points[5].Loss == 0 {
		t.Fatalf("points %d %v", len(points), err)
	}
	if n, q := len(f.requests()), f.reqs[0].Query; n != 1 || q != fmt.Sprintf("limit=%d", generated.ListRunMetricsLimitMax) {
		t.Fatalf("requests %d, query %s", n, q)
	}
}

func TestMetricsStopsOnRepeatedCursor(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	page := wireMap(t, "metrics-page.json")
	page["next_cursor"] = "same"
	f := newFake(t, map[string]route{"GET /v1/runs/run_x/metrics": jsonValue(200, page)})
	c, _ := f.client()
	_, err := grad.Collect(c.Runs.Metrics(ctx, "run_x", false))
	if !errors.Is(err, grad.ErrPaginationLoop) {
		t.Fatalf("err %v", err)
	}
	if n := f.count("GET", "/v1/runs/run_x/metrics"); n != 2 {
		t.Fatalf("fetched %d pages, want 2", n)
	}
}

func TestEvalReportIsTyped(t *testing.T) {
	run := wireMap(t, "run-completed.json")
	run["eval_report"].(map[string]any)["pareto_summary"] = map[string]any{"target_max_drop": 0.02, "quality_drop_ci95": []any{-0.004, 0.019}, "temperature": 1.3}
	f := newFake(t, map[string]route{"GET /v1/runs/run_x": jsonValue(200, run)})
	c, _ := f.client()
	got, err := c.Runs.Get(context.Background(), "run_x")
	if err != nil {
		t.Fatal(err)
	}
	var report *grad.EvalReport = got.EvalReport
	if report == nil || report.MetricName != "eval_loss" || report.SelectedStep != 6 || report.BestStep != nil || report.EvalLoss != nil {
		t.Fatalf("report %+v", report)
	}
	var pareto *grad.RouterParetoSummary = report.ParetoSummary
	if pareto == nil || len(pareto.QualityDropCi95) != 2 || pareto.OffloadRate != nil {
		t.Fatalf("pareto %+v", pareto)
	}
	if report.AdditionalProperties["reference_backend"] != true {
		t.Fatalf("unknown fields are kept: %+v", report.AdditionalProperties)
	}
}
