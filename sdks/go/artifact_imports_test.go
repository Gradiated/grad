package grad_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	grad "github.com/Gradiated/grad/sdks/go"
)

func artifactImport(status string, extra map[string]any) map[string]any {
	job := map[string]any{
		"id": "imp_1", "workspace_id": "ws_a", "status": status, "name": "my-lora", "base_model": "test/tiny-qwen3",
		"format": "peft_lora", "source": map[string]any{"kind": "upload", "upload_id": "a", "repo": nil, "revision": nil},
		"artifact_id": nil, "error": nil, "error_code": nil, "attempt": 0, "created_at": "t", "updated_at": "t",
	}
	for k, v := range extra {
		job[k] = v
	}
	return job
}

func TestArtifactUploadTarsADirectoryAndWaits(t *testing.T) {
	ctx := context.Background()
	ticket := wireMap(t, "upload-ticket.json")
	art := wireMap(t, "artifact.json")
	var put []byte
	f := newFake(t, map[string]route{
		"POST /v1/uploads": jsonValue(201, ticket),
		"PUT /blobs/uploads/*": func(w http.ResponseWriter, _ *http.Request, body []byte) {
			put = body
			w.WriteHeader(200)
		},
		"POST /v1/artifact-imports": jsonValue(202, artifactImport("queued", nil)),
		"GET /v1/artifact-imports/imp_1": sequence(
			jsonValue(200, artifactImport("running", nil)),
			jsonValue(200, artifactImport("completed", map[string]any{"artifact_id": art["id"]})),
		),
		"GET /v1/artifacts/" + art["id"].(string): jsonValue(200, art),
	})
	c, _ := f.client()
	dir := filepath.Join(t.TempDir(), "My LoRA")
	if err := os.MkdirAll(filepath.Join(dir, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "adapter_config.json"), []byte("{}"), 0o600)
	_ = os.WriteFile(filepath.Join(dir, "sub", "x.bin"), []byte("xyz"), 0o600)
	job, err := c.Artifacts.Upload(ctx, dir, grad.UploadParams{Base: "test/tiny-qwen3"})
	if err != nil || job.Done() {
		t.Fatalf("upload %+v %v", job, err)
	}
	a, err := job.Wait(ctx)
	if err != nil || a.ID != art["id"] {
		t.Fatalf("wait %v %v", a, err)
	}
	if up := f.last("POST", "/v1/uploads").JSON(t); up["purpose"] != "artifact_import" || up["filename"] != "upload.tar.gz" {
		t.Fatalf("upload request %v", up)
	}
	body := f.last("POST", "/v1/artifact-imports").JSON(t)
	if body["name"] != "my-lora" || body["base_model"] != "test/tiny-qwen3" || body["format"] != "peft_lora" ||
		body["source"].(map[string]any)["upload_id"] != ticket["upload_id"] {
		t.Fatalf("import request %v", body)
	}
	gz, err := gzip.NewReader(bytes.NewReader(put))
	if err != nil {
		t.Fatal(err)
	}
	tr := tar.NewReader(gz)
	var names []string
	for {
		h, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatal(err)
		}
		names = append(names, h.Name)
	}
	if len(names) != 2 || names[0] != "adapter_config.json" || names[1] != "sub/x.bin" {
		t.Fatalf("tar entries %v", names)
	}
	if _, err := c.Artifacts.Upload(ctx, dir, grad.UploadParams{}); err == nil {
		t.Fatal("upload without a base")
	}
	if _, err := c.Artifacts.Upload(ctx, filepath.Join(dir, "missing"), grad.UploadParams{Base: "b"}); err == nil {
		t.Fatal("missing path accepted")
	}
}

func TestArtifactImportFailureIs422NamingTheFile(t *testing.T) {
	ctx := context.Background()
	failed := artifactImport("failed", map[string]any{"error": "adapter_model.safetensors: tensor shape mismatch", "error_code": "invalid_artifact"})
	f := newFake(t, map[string]route{"GET /v1/artifact-imports/imp_1": jsonValue(200, failed)})
	c, _ := f.client()
	_, err := c.Artifacts.WaitImport(ctx, "imp_1")
	var fail *grad.ArtifactImportFailedError
	if !errors.As(err, &fail) || fail.Status != 422 || fail.Code != "invalid_artifact" || fail.Job.Name != "my-lora" {
		t.Fatalf("failure %v", err)
	}
	if !bytes.Contains([]byte(err.Error()), []byte("adapter_model.safetensors")) {
		t.Fatalf("message %q", err.Error())
	}
}

func TestArtifactFromHFParsesURIs(t *testing.T) {
	ctx := context.Background()
	f := newFake(t, map[string]route{"POST /v1/artifact-imports": jsonValue(202, artifactImport("queued", nil))})
	c, _ := f.client()
	if _, err := c.Artifacts.FromHF(ctx, "hf://acme/lora@main", grad.FromHFParams{Base: "test/tiny-qwen3", Secret: "hf-token"}); err != nil {
		t.Fatal(err)
	}
	src := f.last("POST", "/v1/artifact-imports").JSON(t)["source"].(map[string]any)
	if src["kind"] != "hf" || src["repo"] != "acme/lora" || src["revision"] != "main" || src["secret"] != "hf-token" {
		t.Fatalf("source %v", src)
	}
	if _, err := c.Artifacts.FromHF(ctx, "acme/lora", grad.FromHFParams{}); err == nil {
		t.Fatal("from hf without a base")
	}
	for _, bad := range [][2]string{{"hf://../x", ""}, {"hf://a/b@x", "y"}, {"not a repo!", ""}} {
		if _, _, err := grad.ParseHFURI(bad[0], bad[1]); err == nil {
			t.Fatalf("%v accepted", bad)
		}
	}
	if repo, rev, err := grad.ParseHFURI("acme/lora", "v1"); err != nil || repo != "acme/lora" || rev != "v1" {
		t.Fatalf("parse %s %s %v", repo, rev, err)
	}
}
