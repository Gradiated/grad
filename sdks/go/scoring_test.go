package grad_test

import (
	"context"
	"encoding/json"
	"net/http"
	"reflect"
	"testing"

	grad "github.com/Gradiated/grad/sdks/go"
)

func TestDatasetScoreRunsLocalScorersAndReturnsTheScoredDataset(t *testing.T) {
	ctx := context.Background()
	queued, done := wireMap(t, "eval-scoring-queued.json"), wireMap(t, "eval-scoring-completed.json")
	id := queued["id"].(string)
	awaiting := map[string]any{}
	for k, v := range queued {
		awaiting[k] = v
	}
	awaiting["status"], awaiting["local_scorers"] = "awaiting_scores", []string{"short"}
	output := map[string]any{"id": "evout_1", "eval_id": id, "task_id": "rec_a", "model": "record", "sample_index": 0,
		"input": []any{map[string]any{"role": "user", "content": "hi"}}, "output": "hello", "expected_output": nil,
		"record": map[string]any{"id": "rec_a"}, "scores": map[string]any{}, "error": nil,
		"usage": map[string]any{"prompt_tokens": 0, "completion_tokens": 0}}
	dataset := wireMap(t, "dataset.json")
	dataset["name"], dataset["version"] = "support-logs", 2
	f := newFake(t, map[string]route{
		"POST /v1/datasets/support-logs/score": jsonValue(202, queued),
		"GET /v1/evals/" + id:                  sequence(jsonValue(200, awaiting), jsonValue(200, done)),
		"GET /v1/evals/" + id + "/outputs":     sequence(jsonValue(200, map[string]any{"data": []any{output}, "next_cursor": nil}), jsonValue(200, map[string]any{"data": []any{}, "next_cursor": nil})),
		"POST /v1/evals/" + id + "/scores":     jsonValue(200, map[string]any{"accepted": 1, "status": "completed", "pending_local_scores": 0}),
		"GET /v1/datasets/support-logs":        jsonValue(200, dataset),
	})
	c, _ := f.client()
	ds, err := c.Datasets.Get(ctx, "support-logs")
	if err != nil {
		t.Fatal(err)
	}
	short := grad.Scorer{Name: "short", Fn: func(_ context.Context, in grad.ScoreInput) (float64, error) {
		if len(in.Output) < 20 {
			return 1, nil
		}
		return 0, nil
	}}
	h := ds.Score(ctx, grad.Rubric{grad.Judge{Name: "resolved", Model: "qwen/qwen3-32b", Prompt: "ok?"}, short}, grad.ScoreOptions{})
	job, err := h.Result()
	if err != nil || job.ID != id {
		t.Fatalf("result %v %v", job, err)
	}
	scored, err := h.Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if scored.Name != "support-logs" || scored.Version != 2 || *job.ScoredDatasetVersion != 2 {
		t.Fatalf("scored %+v", scored)
	}
	posted := f.last("POST", "/v1/evals/"+id+"/scores").JSON(t)
	want := map[string]any{"scores": []any{map[string]any{"output_id": "evout_1", "scorer": "short", "score": 1.0}}}
	if !reflect.DeepEqual(posted, want) {
		t.Fatalf("posted %v", posted)
	}
	if _, err := c.Datasets.Score(ctx, "support-logs", nil, grad.ScoreOptions{}).Wait(ctx); err == nil {
		t.Fatal("an empty rubric must fail")
	}
	if _, err := c.Datasets.Score(ctx, "nope", grad.Rubric{short}, grad.ScoreOptions{}).Result(); err == nil {
		t.Fatal("a missing dataset must fail")
	}
}

func TestDatasetFilterByFieldsAndByFunction(t *testing.T) {
	ctx := context.Background()
	dataset := wireMap(t, "dataset.json")
	dataset["name"], dataset["version"] = "support-logs", 3
	view := wireMap(t, "dataset.json")
	view["name"] = "support-logs-f-0123456789"
	page := map[string]any{"dataset": "support-logs", "version": 3, "total": 3, "next_cursor": nil, "data": []any{
		map[string]any{"id": "a", "messages": []any{map[string]any{"role": "user", "content": "short"}}},
		map[string]any{"id": "b", "messages": []any{map[string]any{"role": "user", "content": "x"}, map[string]any{"role": "user", "content": "y"}}},
		map[string]any{"messages": []any{map[string]any{"role": "user", "content": "no id"}}},
	}}
	f := newFake(t, map[string]route{
		"GET /v1/datasets/support-logs":         jsonValue(200, dataset),
		"GET /v1/datasets/support-logs/records": jsonValue(200, page),
		"POST /v1/datasets/support-logs/filter": jsonValue(201, view),
	})
	c, _ := f.client()
	ds, err := c.Datasets.Get(ctx, "support-logs")
	if err != nil {
		t.Fatal(err)
	}
	got, err := ds.FilterFunc(ctx, func(r grad.Trajectory) bool { return len(r.Messages) <= 1 }, grad.FilterOptions{Name: "short-chats"})
	if err != nil || got.Name != "support-logs-f-0123456789" {
		t.Fatalf("view %v %v", got, err)
	}
	body := f.last("POST", "/v1/datasets/support-logs/filter").JSON(t)
	if !reflect.DeepEqual(body, map[string]any{"ids": []any{"a"}, "version": 3.0, "name": "short-chats"}) {
		t.Fatalf("body %v", body)
	}
	if _, err := ds.FilterFunc(ctx, func(grad.Trajectory) bool { return false }, grad.FilterOptions{Version: 3}); err != nil {
		t.Fatal(err)
	}
	raw := f.last("POST", "/v1/datasets/support-logs/filter").Body
	var empty map[string]json.RawMessage
	_ = json.Unmarshal(raw, &empty)
	if string(empty["ids"]) != "[]" {
		t.Fatalf("a filter that matched nothing must send ids: [] (got %s)", raw)
	}
	if _, err := ds.Filter(ctx, grad.FilterOptions{CreatedBefore: "2026-12-01"}); err != nil {
		t.Fatal(err)
	}
	if b := f.last("POST", "/v1/datasets/support-logs/filter").JSON(t); !reflect.DeepEqual(b, map[string]any{"created_before": "2026-12-01"}) {
		t.Fatalf("body %v", b)
	}
	failing := newFake(t, map[string]route{"GET /v1/datasets/x": problem(http.StatusNotFound, "dataset_not_found")})
	fc, _ := failing.client()
	if _, err := fc.Datasets.FilterFunc(ctx, "x", func(grad.Trajectory) bool { return true }, grad.FilterOptions{}); err == nil {
		t.Fatal("a missing dataset must fail")
	}
	if _, err := fc.Datasets.Filter(ctx, "x", grad.FilterOptions{}); err == nil {
		t.Fatal("a missing dataset must fail")
	}
}
