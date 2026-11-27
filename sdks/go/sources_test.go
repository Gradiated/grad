package grad_test

import (
	"context"
	"errors"
	"net/http"
	"reflect"
	"testing"
	"time"

	grad "github.com/Gradiated/grad/sdks/go"
)

func parityResponse(t *testing.T, key string) map[string]any {
	t.Helper()
	return wireMap(t, "sdk-parity.json")["responses"].(map[string]any)[key].(map[string]any)
}

func noContent() route {
	return func(w http.ResponseWriter, _ *http.Request, _ []byte) { w.WriteHeader(http.StatusNoContent) }
}

func TestSecrets(t *testing.T) {
	ctx := context.Background()
	secret := parityResponse(t, "secret")
	f := newFake(t, map[string]route{
		"POST /v1/secrets":                 jsonValue(200, secret),
		"GET /v1/secrets/langfuse-prod":    jsonValue(200, secret),
		"GET /v1/secrets":                  jsonValue(200, map[string]any{"data": []any{secret}, "next_cursor": nil}),
		"DELETE /v1/secrets/langfuse-prod": noContent(),
		"DELETE /v1/secrets/used":          problem(409, "secret_in_use"),
	})
	c, _ := f.client()

	ref, err := c.Secrets.Set(ctx, "langfuse-prod", "pk:sk")
	if err != nil || ref.Name != "langfuse-prod" {
		t.Fatalf("set: %v %+v", err, ref)
	}
	if got := f.last("POST", "/v1/secrets").JSON(t); !reflect.DeepEqual(got, map[string]any{"name": "langfuse-prod", "value": "pk:sk"}) {
		t.Fatalf("set body %v", got)
	}
	if _, err := c.Secrets.Set(ctx, "x", ""); err == nil {
		t.Fatal("empty values must be refused")
	}
	if got, err := c.Secrets.Get(ctx, "langfuse-prod"); err != nil || got.Name != "langfuse-prod" {
		t.Fatalf("get: %v", err)
	}
	var names []string
	for s, err := range c.Secrets.List(ctx) {
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, s.Name)
	}
	if !reflect.DeepEqual(names, []string{"langfuse-prod"}) {
		t.Fatalf("list %v", names)
	}
	if err := c.Secrets.Delete(ctx, ref); err != nil {
		t.Fatal(err)
	}
	var conflict *grad.ConflictError
	if err := c.Secrets.Delete(ctx, grad.SecretName("used")); !errors.As(err, &conflict) {
		t.Fatalf("delete in use: %v", err)
	}
}

func TestSourcesThroughTheDataset(t *testing.T) {
	ctx := context.Background()
	source := parityResponse(t, "source")
	job := map[string]any{"id": "imp_7c1d", "workspace_id": "ws", "dataset": "support-prod", "status": "completed", "source": map[string]any{}, "connector": "auto",
		"attempt": 1, "imported_count": 3, "dropped_count": 0, "detected_scores": []any{}, "drop_reasons": []any{}, "dataset_version": 3, "error": nil, "created_at": "x", "updated_at": "x"}
	dataset := map[string]any{"id": "ds_1", "workspace_id": "ws", "name": "support-prod", "version": 2, "record_count": 10, "metadata": map[string]any{}, "created_at": "x", "updated_at": "x"}
	f := newFake(t, map[string]route{
		"GET /v1/datasets/support-prod":          jsonValue(200, dataset),
		"POST /v1/datasets/support-prod/sources": jsonValue(201, source),
		"POST /v1/sources/src_01J9X/sync":        jsonValue(202, job),
		"GET /v1/imports/imp_7c1d":               jsonValue(200, job),
		"GET /v1/sources/src_01J9X":              jsonValue(200, source),
		"GET /v1/sources":                        jsonValue(200, map[string]any{"data": []any{source}, "next_cursor": nil}),
		"DELETE /v1/sources/src_01J9X":           noContent(),
		"POST /v1/datasets/c/sources":            problem(501, "source_unavailable"),
	})
	c, _ := f.client()

	d, err := c.Datasets.Get(ctx, "support-prod")
	if err != nil {
		t.Fatal(err)
	}
	src, err := d.AddSource(ctx, grad.SourceParams{
		Provider: grad.BraintrustSource{Host: "https://api.braintrust.dev", Secret: grad.SecretName("bt"), Project: "support-bot", Filters: map[string]any{"tag": "prod"}},
		Schedule: "*/15 * * * *",
	})
	if err != nil || src.ID != "src_01J9X" {
		t.Fatalf("add: %v", err)
	}
	want := map[string]any{"provider": map[string]any{"kind": "braintrust", "host": "https://api.braintrust.dev", "secret": "bt", "project": "support-bot", "filters": map[string]any{"tag": "prod"}}, "schedule": "*/15 * * * *"}
	if got := f.last("POST", "/v1/datasets/support-prod/sources").JSON(t); !reflect.DeepEqual(got, want) {
		t.Fatalf("add body %v", got)
	}

	done, err := src.Sync(ctx).Wait(ctx)
	if err != nil || done.Status != "completed" {
		t.Fatalf("sync: %v", err)
	}
	if got := f.last("POST", "/v1/sources/src_01J9X/sync").JSON(t); !reflect.DeepEqual(got, map[string]any{"full": false}) {
		t.Fatalf("sync body %v", got)
	}
	if err := src.Refresh(ctx); err != nil {
		t.Fatal(err)
	}
	n := 0
	for s, err := range d.Sources(ctx) {
		if err != nil || s.ID != "src_01J9X" {
			t.Fatalf("list: %v", err)
		}
		n++
	}
	if n != 1 || f.last("GET", "/v1/sources").Query != "dataset=support-prod" {
		t.Fatalf("list %d %q", n, f.last("GET", "/v1/sources").Query)
	}
	for range c.Sources.List(ctx, nil) {
	}
	if err := src.Remove(ctx); err != nil {
		t.Fatal(err)
	}

	if _, err := c.Sources.Create(ctx, grad.DatasetName("c"), grad.SourceParams{}); err == nil {
		t.Fatal("a provider is required")
	}
	_, err = c.Sources.Create(ctx, grad.DatasetName("c"), grad.SourceParams{Provider: grad.GradiatedSource{}})
	var apiErr *grad.APIError
	if !errors.As(err, &apiErr) || apiErr.Code != "source_unavailable" || apiErr.Status != 501 {
		t.Fatalf("cloud only: %v", err)
	}
}

func TestProviderBodies(t *testing.T) {
	ctx := context.Background()
	f := newFake(t, map[string]route{"POST /v1/datasets/d/sources": jsonValue(201, parityResponse(t, "source"))})
	c, _ := f.client()
	for _, tc := range []struct {
		p    grad.SourceProvider
		want map[string]any
	}{
		{grad.LangSmithSource{Secret: grad.SecretName("ls")}, map[string]any{"kind": "langsmith", "secret": "ls"}},
		{grad.PostHogSource{Host: "https://us.posthog.com", Secret: grad.SecretName("ph"), Project: "123"}, map[string]any{"kind": "posthog", "host": "https://us.posthog.com", "secret": "ph", "project": "123"}},
		{grad.PhoenixSource{Host: "http://phoenix:6006"}, map[string]any{"kind": "phoenix", "host": "http://phoenix:6006"}},
		{grad.LangfuseSource{}, map[string]any{"kind": "langfuse"}},
		{grad.GradiatedSource{Tasks: []string{"t"}, Versions: []string{"v1"}, Filters: map[string]any{"trainable_only": true}},
			map[string]any{"kind": "gradiated", "filters": map[string]any{"tasks": []any{"t"}, "versions": []any{"v1"}, "trainable_only": true}}},
	} {
		if _, err := c.Sources.Create(ctx, grad.DatasetName("d"), grad.SourceParams{Provider: tc.p}); err != nil {
			t.Fatal(err)
		}
		if got := f.last("POST", "/v1/datasets/d/sources").JSON(t)["provider"]; !reflect.DeepEqual(got, tc.want) {
			t.Fatalf("got %v want %v", got, tc.want)
		}
	}
}

func TestFromHFSendsTheSecretName(t *testing.T) {
	ctx := context.Background()
	job := map[string]any{"id": "imp_1", "workspace_id": "ws", "dataset": "gated", "status": "queued", "source": map[string]any{}, "connector": "auto",
		"attempt": 0, "imported_count": 0, "dropped_count": 0, "detected_scores": []any{}, "drop_reasons": []any{}, "dataset_version": nil, "error": nil, "created_at": "x", "updated_at": "x"}
	dataset := map[string]any{"id": "ds_1", "workspace_id": "ws", "name": "gated", "version": 0, "record_count": 0, "metadata": map[string]any{}, "created_at": "x", "updated_at": "x"}
	f := newFake(t, map[string]route{"GET /v1/datasets/gated": jsonValue(200, dataset), "POST /v1/datasets/gated/imports": jsonValue(202, job)})
	c, _ := f.client()
	d, err := c.Datasets.Get(ctx, "gated")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := d.ImportHF(ctx, "org/gated", grad.HFOptions{Prompt: "q", Secret: grad.SecretName("hf-token")}).Result(); err != nil {
		t.Fatal(err)
	}
	src := f.last("POST", "/v1/datasets/gated/imports").JSON(t)["source"].(map[string]any)
	if src["secret"] != "hf-token" {
		t.Fatalf("source %v", src)
	}
}

func TestUsageList(t *testing.T) {
	ctx := context.Background()
	page := wireMap(t, "sdk-parity.json")["responses"].(map[string]any)["usage_page"].(map[string]any)
	calls := 0
	f := newFake(t, map[string]route{"GET /v1/usage": func(w http.ResponseWriter, r *http.Request, b []byte) {
		calls++
		if calls == 1 {
			jsonValue(200, map[string]any{"data": page["data"], "next_cursor": "c1"})(w, r, b)
			return
		}
		jsonValue(200, map[string]any{"data": []any{}, "next_cursor": nil})(w, r, b)
	}})
	c, _ := f.client()
	var got []string
	for u, err := range c.Usage.List(ctx, grad.WithUsagePageSize(5)) {
		if err != nil {
			t.Fatal(err)
		}
		got = append(got, u.RefID)
	}
	if len(got) != 1 || f.last("GET", "/v1/usage").Query != "cursor=c1&limit=5" {
		t.Fatalf("usage %v %q", got, f.last("GET", "/v1/usage").Query)
	}
}

func TestUsageFiltersAndTimeBounds(t *testing.T) {
	ctx := context.Background()
	f := newFake(t, map[string]route{"GET /v1/usage": jsonValue(200, map[string]any{"data": []any{}, "next_cursor": nil})})
	c, _ := f.client()
	noon := time.Date(2026, 11, 2, 13, 30, 0, 0, time.FixedZone("CET", 3600))
	for _, err := range c.Usage.List(ctx, grad.WithUsageFrom(noon), grad.WithUsageTo(""), grad.WithUsageEval("eval_1"), grad.WithUsageKind(grad.UsageEval)) {
		if err != nil {
			t.Fatal(err)
		}
	}
	if q := f.last("GET", "/v1/usage").Query; q != "eval_id=eval_1&from=2026-11-02T12%3A30%3A00Z&kind=eval" {
		t.Fatalf("query %q", q)
	}
}

func TestUsageSummary(t *testing.T) {
	ctx := context.Background()
	body := wireMap(t, "sdk-parity.json")["responses"].(map[string]any)["usage_summary"]
	f := newFake(t, map[string]route{"GET /v1/usage/summary": jsonValue(200, body)})
	c, _ := f.client()
	s, err := c.Usage.Summary(ctx, grad.WithUsageTo(time.Date(2026, 12, 1, 0, 0, 0, 0, time.UTC)), grad.WithUsageGroupBy(grad.UsageByRecipe))
	if err != nil {
		t.Fatal(err)
	}
	if q := f.last("GET", "/v1/usage/summary").Query; q != "group_by=recipe&to=2026-12-01T00%3A00%3A00Z" {
		t.Fatalf("query %q", q)
	}
	if s.CostUSD != 0.0046 || s.ByKind[0].Kind != grad.UsageTeacher || *s.TopRuns[0].Name != "support-sft" || *s.GroupBy != grad.UsageByModel {
		t.Fatalf("summary %+v", s)
	}
	if _, err := c.Usage.Summary(ctx); err != nil {
		t.Fatal(err)
	}
	if q := f.last("GET", "/v1/usage/summary").Query; q != "" {
		t.Fatalf("default query %q", q)
	}
}
