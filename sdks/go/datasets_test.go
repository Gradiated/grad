package grad_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	grad "github.com/Gradiated/grad/sdks/go"
)

func TestDatasetsCreateGetListPushRecordsRender(t *testing.T) {
	ctx := context.Background()
	page2Cursor := wireMap(t, "datasets-page-1.json")["next_cursor"].(string)
	f := newFake(t, map[string]route{
		"POST /v1/datasets":                      jsonBody(201, wire(t, "dataset-created.json")),
		"GET /v1/datasets/support-prod":          jsonBody(200, wire(t, "dataset.json")),
		"POST /v1/datasets/support-prod/records": jsonBody(200, wire(t, "dataset.json")),
		"GET /v1/datasets": func(w http.ResponseWriter, r *http.Request, b []byte) {
			if r.URL.Query().Get("cursor") == page2Cursor {
				jsonBody(200, wire(t, "datasets-page-2.json"))(w, r, b)
				return
			}
			jsonBody(200, wire(t, "datasets-page-1.json"))(w, r, b)
		},
		"GET /v1/datasets/support-prod/records": func(w http.ResponseWriter, r *http.Request, b []byte) {
			page := wireMap(t, "dataset-records-page.json")
			if r.URL.Query().Get("cursor") != "" {
				page["data"] = page["data"].([]any)[:1]
				page["next_cursor"] = nil
			}
			jsonValue(200, page)(w, r, b)
		},
		"POST /v1/datasets/support-prod/render": jsonValue(200, map[string]any{"dataset": "support-prod", "model": "qwen/qwen3-8b", "template_revision": "qwen3@3", "token_counts": "estimated", "examples": []any{}}),
	})
	c, _ := f.client()

	ds, err := c.Datasets.Create(ctx, "support-prod", grad.WithDatasetMetadata(map[string]any{"team": "support"}))
	if err != nil || ds.Name != "support-prod" {
		t.Fatalf("create: %+v %v", ds, err)
	}
	if body := f.last("POST", "/v1/datasets").JSON(t); body["name"] != "support-prod" || body["metadata"].(map[string]any)["team"] != "support" {
		t.Fatalf("create body %v", body)
	}
	got, err := c.Datasets.Get(ctx, "support-prod")
	if err != nil || got.RecordCount != 3 {
		t.Fatalf("get: %+v %v", got, err)
	}
	all, err := grad.Collect(c.Datasets.List(ctx))
	if err != nil || len(all) != 2 || all[0].Name != "support-eval" || all[1].Name != "support-prod" {
		t.Fatalf("list: %v %v", all, err)
	}
	if n, err := got.Count(ctx); err != nil || n != 3 {
		t.Fatalf("count %d %v", n, err)
	}

	traj := grad.TrajectoryFromMessages([]grad.Message{{Role: "user", Content: "hi"}, {Role: "assistant", Content: "hello"}}, grad.WithSessionID("s1"), grad.WithGroupID("g"), grad.WithMetadata(map[string]any{"model": "m"}))
	traj.Scores["tests_passed"] = 1.0
	if err := got.Push(ctx, []grad.Trajectory{traj}); err != nil {
		t.Fatal(err)
	}
	pushed := f.last("POST", "/v1/datasets/support-prod/records").JSON(t)
	rec := pushed["records"].([]any)[0].(map[string]any)
	if rec["session_id"] != "s1" || rec["scores"].(map[string]any)["tests_passed"] != 1.0 || len(rec["messages"].([]any)) != 2 {
		t.Fatalf("pushed %v", rec)
	}

	records, err := grad.Collect(got.Records(ctx, grad.AtVersion(2), grad.WithPageSize(2)))
	if err != nil || len(records) != 3 {
		t.Fatalf("records %d %v", len(records), err)
	}
	if q := f.last("GET", "/v1/datasets/support-prod/records").Query; !strings.Contains(q, "version=2") || !strings.Contains(q, "limit=2") {
		t.Fatalf("records query %s", q)
	}
	if _, err := got.Render(ctx, grad.RenderOptions{Model: "qwen/qwen3-8b", TrainOn: "all_assistant", Thinking: "off", PreserveThinking: true, Limit: 2}); err != nil {
		t.Fatal(err)
	}
	if body := f.last("POST", "/v1/datasets/support-prod/render").JSON(t); body["train_on"] != "all_assistant" || body["thinking"] != "off" || body["preserve_thinking"] != true || body["limit"] != 2.0 {
		t.Fatalf("render body %v", body)
	}
}

func TestPushBatchesByCountAndBytes(t *testing.T) {
	ctx := context.Background()
	f := newFake(t, map[string]route{"POST /v1/datasets/big/records": jsonBody(200, wire(t, "dataset.json"))})
	c, _ := f.client()
	records := make([]grad.Trajectory, 2500)
	for i := range records {
		records[i] = grad.TrajectoryFromMessages([]grad.Message{{Role: "user", Content: fmt.Sprintf("q%d", i)}})
	}
	if _, err := c.Datasets.Push(ctx, "big", records, grad.WithDatasetMetadata(map[string]any{"v": 1})); err != nil {
		t.Fatal(err)
	}
	reqs := f.requests()
	if len(reqs) != 3 {
		t.Fatalf("%d requests, want 3", len(reqs))
	}
	sizes := []int{}
	for i, r := range reqs {
		body := r.JSON(t)
		sizes = append(sizes, len(body["records"].([]any)))
		if _, has := body["metadata"]; has != (i == 0) {
			t.Fatalf("metadata only on the first batch: request %d %v", i, has)
		}
	}
	if fmt.Sprint(sizes) != "[1000 1000 500]" {
		t.Fatalf("batch sizes %v", sizes)
	}

	f2 := newFake(t, map[string]route{"POST /v1/datasets/big/records": jsonBody(200, wire(t, "dataset.json"))})
	c2, _ := f2.client()
	if _, err := c2.Datasets.Push(ctx, "big", records[:10], grad.WithBatchBytes(200), grad.WithBatchSize(1000)); err != nil {
		t.Fatal(err)
	}
	if n := len(f2.requests()); n < 3 {
		t.Fatalf("byte cap should split 10 records into several requests, got %d", n)
	}
	var gerr *grad.GradError
	if _, err := c2.Datasets.Push(ctx, "big", nil); !errors.As(err, &gerr) || gerr.Code != "empty_push" {
		t.Fatalf("empty push: %v", err)
	}
}

func TestPushFileStreamsJSONL(t *testing.T) {
	ctx := context.Background()
	f := newFake(t, map[string]route{"POST /v1/datasets/f/records": jsonBody(200, wire(t, "dataset.json"))})
	c, _ := f.client()
	path := filepath.Join(t.TempDir(), "traces.jsonl")
	lines := `{"session_id":"a","messages":[{"role":"user","content":"x","reasoning_content":"keep me"}]}` + "\n\n" + `{"session_id":"b","messages":[{"role":"user","content":"y"}]}` + "\n"
	if err := os.WriteFile(path, []byte(lines), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Datasets.PushFile(ctx, "f", path, grad.WithBatchSize(1)); err != nil {
		t.Fatal(err)
	}
	reqs := f.requests()
	if len(reqs) != 2 || !strings.Contains(string(reqs[0].Body), `"reasoning_content":"keep me"`) {
		t.Fatalf("requests %d, first %s", len(reqs), reqs[0].Body)
	}
	bad := filepath.Join(t.TempDir(), "bad.jsonl")
	_ = os.WriteFile(bad, []byte("{\"ok\":1}\nnot json\n"), 0o600)
	if _, err := c.Datasets.PushFile(ctx, "f", bad); err == nil || !strings.Contains(err.Error(), "bad.jsonl:2") {
		t.Fatalf("bad jsonl: %v", err)
	}
	if _, err := c.Datasets.PushFile(ctx, "f", filepath.Join(t.TempDir(), "missing.jsonl")); err == nil {
		t.Fatal("missing file accepted")
	}
}

func TestImportFileUploadsWithoutCredentialsAndWaits(t *testing.T) {
	ctx := context.Background()
	content := []byte("{\"messages\":[{\"role\":\"user\",\"content\":\"hi\"}]}\n")
	sum := sha256.Sum256(content)
	ticket := wireMap(t, "upload-ticket.json")
	var putHeader http.Header
	var putBody []byte
	queued := wire(t, "import-job-queued.json")
	running := wireMap(t, "import-job-queued.json")
	running["status"] = "running"
	f := newFake(t, map[string]route{
		"GET /v1/datasets/support-prod": jsonBody(200, wire(t, "dataset.json")),
		"POST /v1/uploads":              jsonValue(201, ticket),
		"PUT /blobs/uploads/*": func(w http.ResponseWriter, r *http.Request, body []byte) {
			putHeader, putBody = r.Header.Clone(), body
			w.WriteHeader(200)
			_, _ = w.Write([]byte(`{}`))
		},
		"POST /v1/datasets/support-prod/imports": jsonBody(202, queued),
		"GET /v1/imports/imp_" + strings.TrimPrefix(wireMap(t, "import-job-queued.json")["id"].(string), "imp_"): sequence(jsonValue(200, running), problem(502, "bad_gateway"), jsonBody(200, wire(t, "import-job-completed.json"))),
	})
	c, clk := f.client(grad.WithMaxRetries(0))
	path := filepath.Join(t.TempDir(), "support_traces.jsonl")
	if err := os.WriteFile(path, content, 0o600); err != nil {
		t.Fatal(err)
	}
	dataset, err := c.Datasets.Get(ctx, "support-prod")
	if err != nil {
		t.Fatal(err)
	}
	job, err := dataset.ImportFile(ctx, path, grad.WithFormat("jsonl"), grad.WithConnector("grad_trajectories")).Wait(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if job.Status != "completed" || job.ImportedCount != 3 || len(job.DetectedScores) != 1 {
		t.Fatalf("job %+v", job)
	}
	up := f.last("POST", "/v1/uploads").JSON(t)
	if up["sha256"] != hex.EncodeToString(sum[:]) || up["size_bytes"] != float64(len(content)) || up["filename"] != "support_traces.jsonl" || up["purpose"] != "dataset_import" {
		t.Fatalf("upload request %v", up)
	}
	if putHeader.Get("Authorization") != "" {
		t.Fatal("the upload PUT carried the API key")
	}
	if putHeader.Get("Content-Type") != "application/octet-stream" || string(putBody) != string(content) {
		t.Fatalf("upload PUT headers %v body %q", putHeader, putBody)
	}
	imp := f.last("POST", "/v1/datasets/support-prod/imports").JSON(t)
	src := imp["source"].(map[string]any)
	if src["kind"] != "upload" || src["upload_id"] != ticket["upload_id"] || src["format"] != "jsonl" || imp["connector"] != "grad_trajectories" {
		t.Fatalf("import request %v", imp)
	}
	if s := clk.Sleeps(); len(s) != 2 || s[0].Milliseconds() != 500 || s[1].Milliseconds() != 750 {
		t.Fatalf("poll backoff %v", s)
	}
}

func TestImportFailuresAndUploadErrors(t *testing.T) {
	ctx := context.Background()
	failed := wireMap(t, "import-job-completed.json")
	failed["status"] = "failed"
	failed["error"] = "line 3: not a trajectory"
	id := failed["id"].(string)
	f := newFake(t, map[string]route{
		"GET /v1/datasets/support-prod": jsonBody(200, wire(t, "dataset.json")),
		"GET /v1/imports/" + id:         jsonValue(200, failed),
		"GET /v1/imports":               jsonValue(200, map[string]any{"data": []any{failed}, "next_cursor": nil}),
		"POST /v1/uploads":              jsonValue(201, map[string]any{"upload_id": "upl_1", "method": "PUT", "url": "/blobs/uploads/upl_1?sig=x", "headers": map[string]string{}, "expires_at": "t"}),
		"PUT /blobs/uploads/upl_1":      problem(403, "invalid_upload_signature"),
	})
	c, _ := f.client()
	_, err := c.Imports.Wait(ctx, id)
	var ife *grad.ImportFailedError
	if !errors.As(err, &ife) || ife.Job.Status != "failed" || !strings.Contains(err.Error(), "not a trajectory") {
		t.Fatalf("wait: %v", err)
	}
	jobs, err := grad.Collect(c.Imports.List(ctx))
	if err != nil || len(jobs) != 1 {
		t.Fatalf("list %v %v", jobs, err)
	}
	d, _ := c.Datasets.Get(ctx, "support-prod")
	path := filepath.Join(t.TempDir(), "x.jsonl")
	_ = os.WriteFile(path, []byte("{}\n"), 0o600)
	h := d.ImportFile(ctx, path)
	if _, err := h.Result(); err == nil {
		t.Fatal("upload 403 should fail the import")
	}
	var pd *grad.PermissionDeniedError
	if _, err := h.Wait(ctx); !errors.As(err, &pd) || strings.Contains(err.Error(), "sig=") {
		t.Fatalf("upload error %v (must not echo the signed query)", err)
	}
	if _, err := d.ImportFile(ctx, filepath.Join(t.TempDir(), "nope.jsonl")).Result(); err == nil {
		t.Fatal("missing file accepted")
	}
}

func TestFromHFCreatesOrReusesAndWaits(t *testing.T) {
	ctx := context.Background()
	job := wireMap(t, "import-job-completed.json")
	job["source"] = map[string]any{"kind": "hf", "repo": "openai/gsm8k"}
	f := newFake(t, map[string]route{
		"POST /v1/datasets":                           problem(409, "dataset_exists"),
		"GET /v1/datasets/hf-openai-gsm8k-main-train": jsonBody(200, wire(t, "dataset.json")),
		"POST /v1/datasets/support-prod/imports":      jsonValue(202, job),
		"GET /v1/imports/" + job["id"].(string):       jsonValue(200, job),
		"GET /v1/datasets/support-prod":               jsonBody(200, wire(t, "dataset.json")),
	})
	c, _ := f.client()
	ds, err := c.Datasets.FromHF(ctx, "openai/gsm8k", grad.HFOptions{Subset: "main", Split: "train", Prompt: "question", Answer: "answer", Limit: 50, Revision: "r1"})
	if err != nil {
		t.Fatal(err)
	}
	if ds.Name != "support-prod" {
		t.Fatalf("dataset %s", ds.Name)
	}
	create := f.last("POST", "/v1/datasets").JSON(t)
	if create["name"] != "hf-openai-gsm8k-main-train" {
		t.Fatalf("derived name %v", create["name"])
	}
	imp := f.last("POST", "/v1/datasets/support-prod/imports").JSON(t)
	src := imp["source"].(map[string]any)
	cols := src["columns"].(map[string]any)
	if src["kind"] != "hf" || src["repo"] != "openai/gsm8k" || src["config"] != "main" || src["split"] != "train" || src["limit"] != 50.0 || cols["prompt"] != "question" || cols["answer"] != "answer" {
		t.Fatalf("hf source %v", src)
	}
	raw, _ := json.Marshal(src)
	if strings.Contains(string(raw), "messages") {
		t.Fatalf("unset columns must be omitted: %s", raw)
	}
}

// A server (or proxy) that keeps returning the same cursor must not make the SDK
// page forever and buffer every page: this once grew a test process to 15 GB.
func TestRecordsStopsOnRepeatedCursor(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	f := newFake(t, map[string]route{
		"GET /v1/datasets/loop/records": func(w http.ResponseWriter, r *http.Request, b []byte) {
			page := wireMap(t, "dataset-records-page.json")
			page["next_cursor"] = "same"
			jsonValue(200, page)(w, r, b)
		},
	})
	c, _ := f.client()
	records, err := grad.Collect(c.Datasets.Records(ctx, "loop"))
	if !errors.Is(err, grad.ErrPaginationLoop) {
		t.Fatalf("err %v", err)
	}
	if n := f.count("GET", "/v1/datasets/loop/records"); n != 2 {
		t.Fatalf("fetched %d pages, want 2", n)
	}
	if len(records) == 0 {
		t.Fatal("records before the loop should still be returned")
	}
}

func TestPaginationHonoursCancelledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	f := newFake(t, map[string]route{})
	c, _ := f.client()
	if _, err := grad.Collect(c.Datasets.Records(ctx, "any")); !errors.Is(err, context.Canceled) {
		t.Fatalf("err %v", err)
	}
	if n := f.count("GET", "/v1/datasets/any/records"); n != 0 {
		t.Fatalf("fetched %d pages after cancel", n)
	}
}
