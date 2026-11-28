package grad_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	grad "github.com/Gradiated/grad/sdks/go"
)

func bundleRoute(payload []byte, sha string) route {
	return func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "application/octet-stream")
		if sha != "" {
			w.Header().Set("X-Artifact-Sha256", sha)
		}
		w.Header().Set("Content-Disposition", `attachment; filename="support-sft-2026-11-27-1.grad.tar.gz"`)
		_, _ = w.Write(payload)
	}
}

func noTemps(t *testing.T, dir string) {
	t.Helper()
	entries, _ := os.ReadDir(dir)
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), ".grad-download-") {
			t.Fatalf("temp file left behind: %s", e.Name())
		}
	}
}

func TestArtifactDownloadVerifiesChecksum(t *testing.T) {
	ctx := context.Background()
	payload := []byte(strings.Repeat("adapter-bytes-", 5000))
	sum := sha256.Sum256(payload)
	good := hex.EncodeToString(sum[:])
	f := newFake(t, map[string]route{
		"GET /v1/artifacts/good/download":     bundleRoute(payload, strings.ToUpper(good)),
		"GET /v1/artifacts/missing/download":  bundleRoute(payload, ""),
		"GET /v1/artifacts/nonhex/download":   bundleRoute(payload, strings.Repeat("z", 64)),
		"GET /v1/artifacts/mismatch/download": bundleRoute(payload, strings.Repeat("a", 64)),
	})
	c, _ := f.client()

	dir := t.TempDir()
	d, err := c.Artifacts.Download(ctx, "good", dir)
	if err != nil {
		t.Fatal(err)
	}
	if d.Path != filepath.Join(dir, "support-sft-2026-11-27-1.grad.tar.gz") || d.SHA256 != good || d.SizeBytes != int64(len(payload)) {
		t.Fatalf("download %+v", d)
	}
	if raw, _ := os.ReadFile(d.Path); string(raw) != string(payload) {
		t.Fatal("content differs")
	}
	if info, _ := os.Stat(d.Path); info.Mode().Perm() != 0o644 {
		t.Fatalf("mode %v", info.Mode())
	}
	file := filepath.Join(dir, "nested", "out.tgz")
	if d, err := c.Artifacts.Download(ctx, "good", file); err != nil || d.Path != file {
		t.Fatalf("file dest %v %v", d, err)
	}
	if d, err := c.Artifacts.Download(ctx, "good", filepath.Join(dir, "newdir")+"/"); err != nil || filepath.Base(d.Path) != "support-sft-2026-11-27-1.grad.tar.gz" {
		t.Fatalf("new dir dest %v %v", d, err)
	}

	for _, ref := range []string{"missing", "nonhex", "mismatch"} {
		out := t.TempDir()
		_, err := c.Artifacts.Download(ctx, ref, filepath.Join(out, "a.tgz"))
		var cm *grad.ChecksumMismatchError
		if !errors.As(err, &cm) || !errors.Is(err, grad.ErrChecksumMismatch) {
			t.Fatalf("%s: %T %v", ref, err, err)
		}
		var base *grad.GradError
		if !errors.As(err, &base) {
			t.Fatalf("%s: not a GradError", ref)
		}
		if _, statErr := os.Stat(filepath.Join(out, "a.tgz")); !os.IsNotExist(statErr) {
			t.Fatalf("%s: destination written", ref)
		}
		noTemps(t, out)
	}
	if _, err := c.Artifacts.Download(ctx, "mismatch", filepath.Join(dir, "unchecked.tgz"), grad.SkipChecksum()); err != nil {
		t.Fatalf("skip checksum: %v", err)
	}
	if _, err := c.Artifacts.Download(ctx, "absent", dir); !grad.IsNotFound(err) {
		t.Fatalf("404: %v", err)
	}
	noTemps(t, dir)

	stream, err := c.Artifacts.Open(ctx, "good")
	if err != nil {
		t.Fatal(err)
	}
	raw, err := io.ReadAll(stream.Body)
	stream.Body.Close()
	if err != nil || len(raw) != len(payload) || stream.SHA256 != good || stream.FileName == "" {
		t.Fatalf("open %v %d", err, len(raw))
	}
	bad, err := c.Artifacts.Open(ctx, "mismatch")
	if err != nil {
		t.Fatal(err)
	}
	_, err = io.ReadAll(bad.Body)
	bad.Body.Close()
	if !errors.Is(err, grad.ErrChecksumMismatch) {
		t.Fatalf("open mismatch: %v", err)
	}
	if _, err := c.Artifacts.Open(ctx, "missing"); !errors.Is(err, grad.ErrChecksumMismatch) {
		t.Fatalf("open missing header: %v", err)
	}
}

func TestArtifactsGetListAndHelpers(t *testing.T) {
	ctx := context.Background()
	art := wireMap(t, "artifact.json")
	id := art["id"].(string)
	payload := []byte("bundle")
	sum := sha256.Sum256(payload)
	f := newFake(t, map[string]route{
		"GET /v1/artifacts/" + id:                jsonValue(200, art),
		"GET /v1/artifacts":                      jsonBody(200, wire(t, "artifacts-page.json")),
		"GET /v1/artifacts/" + id + "/download":  bundleRoute(payload, hex.EncodeToString(sum[:])),
		"DELETE /v1/artifacts/" + id:             func(w http.ResponseWriter, _ *http.Request, _ []byte) { w.WriteHeader(204) },
		"GET /v1/runs/" + art["run_id"].(string): jsonBody(200, wire(t, "run-completed.json")),
	})
	c, _ := f.client()
	a, err := c.Artifacts.Get(ctx, id)
	if err != nil || a.Ref() != art["name"].(string)+"@"+art["version"].(string) {
		t.Fatalf("get %v %v", a, err)
	}
	list, err := grad.Collect(c.Artifacts.List(ctx, grad.ArtifactListOptions{Name: "support-sft"}))
	if err != nil || len(list) == 0 {
		t.Fatalf("list %v", err)
	}
	if q := f.last("GET", "/v1/artifacts").Query; q != "name=support-sft" {
		t.Fatalf("list query %s", q)
	}
	if _, err := a.Download(ctx, t.TempDir()); err != nil {
		t.Fatal(err)
	}
	if string(a.Provenance.Source) != "run" || a.Provenance.RunID == nil || *a.Provenance.RunID != art["run_id"] {
		t.Fatalf("provenance %+v", a.Provenance)
	}
	if err := a.Delete(ctx); err != nil || f.count("DELETE", "/v1/artifacts/"+id) != 1 {
		t.Fatalf("delete %v", err)
	}
	run, err := c.Runs.Get(ctx, art["run_id"].(string))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := run.Download(ctx, t.TempDir()); err != nil {
		t.Fatal(err)
	}
}

func TestKeysModels(t *testing.T) {
	ctx := context.Background()
	f := newFake(t, map[string]route{
		"POST /v1/keys":         jsonBody(201, wire(t, "api-key-created.json")),
		"GET /v1/keys":          jsonBody(200, wire(t, "api-keys-page.json")),
		"DELETE /v1/keys/key_1": jsonValue(200, wireMap(t, "api-key-created.json")["key"]),
		"GET /v1/base-models":   jsonBody(200, wire(t, "models.json")),
	})
	c, _ := f.client()

	key, err := c.Keys.Create(ctx, "ci", "runs:read", "datasets:write")
	if err != nil || key.Secret == "" {
		t.Fatalf("key %v", err)
	}
	if body := f.last("POST", "/v1/keys").JSON(t); len(body["scopes"].([]any)) != 2 {
		t.Fatalf("key body %v", body)
	}
	if keys, err := grad.Collect(c.Keys.List(ctx)); err != nil || len(keys) == 0 {
		t.Fatalf("keys %v", err)
	}
	if _, err := c.Keys.Revoke(ctx, "key_1"); err != nil {
		t.Fatal(err)
	}
	models, err := c.Models.List(ctx)
	if err != nil || len(models) < 2 {
		t.Fatalf("models %v", err)
	}
}

func TestEverythingSurfacesConfigErrors(t *testing.T) {
	ctx := context.Background()
	c := grad.NewClient(grad.WithBaseURL("not a url"), grad.WithEnv(noEnv))
	var gerr *grad.GradError
	check := func(name string, err error) {
		t.Helper()
		if !errors.As(err, &gerr) || gerr.Code != "invalid_base_url" {
			t.Fatalf("%s: %v", name, err)
		}
	}
	_, err := c.Datasets.Create(ctx, "d")
	check("create", err)
	_, err = c.Datasets.Get(ctx, "d")
	check("get", err)
	_, err = c.Datasets.Push(ctx, "d", []grad.Trajectory{{}})
	check("push", err)
	_, err = c.Datasets.Render(ctx, "d", grad.RenderOptions{})
	check("render", err)
	_, err = c.Runs.Plan(ctx, grad.RunParams{})
	check("plan", err)
	_, err = c.Runs.Create(ctx, grad.RunParams{}).Wait(ctx)
	check("create run", err)
	_, err = c.Runs.Get(ctx, "r")
	check("get run", err)
	_, err = c.Runs.Cancel(ctx, "r")
	check("cancel", err)
	_, err = c.Runs.Resume(ctx, "r", grad.ResumeOptions{})
	check("resume", err)
	_, err = c.Runs.Checkpoints(ctx, "r")
	check("checkpoints", err)
	_, err = c.Checkpoints.Promote(ctx, "c", "")
	check("promote", err)
	_, err = c.Artifacts.Get(ctx, "a")
	check("artifact", err)
	_, err = c.Artifacts.Download(ctx, "a", t.TempDir())
	check("download", err)
	_, err = c.Artifacts.Open(ctx, "a")
	check("open", err)
	check("delete artifact", c.Artifacts.Delete(ctx, "a"))
	_, err = c.Artifacts.FromHF(ctx, "acme/lora", grad.FromHFParams{Base: "b"})
	check("from hf", err)
	_, err = c.Artifacts.Upload(ctx, t.TempDir(), grad.UploadParams{Base: "b"})
	check("upload", err)
	_, err = c.Artifacts.GetImport(ctx, "i")
	check("get import", err)
	_, err = c.Models.List(ctx)
	check("models", err)
	_, err = c.Keys.Create(ctx, "k")
	check("key", err)
	_, err = c.Keys.Revoke(ctx, "k")
	check("revoke", err)
	_, err = c.Imports.Get(ctx, "i")
	check("import", err)
	_, err = c.Evals.Plan(ctx, grad.EvalParams{})
	check("eval plan", err)
	_, err = c.Evals.Create(ctx, grad.EvalParams{}).Wait(ctx)
	check("eval create", err)
	_, err = c.Evals.Get(ctx, "e")
	check("eval get", err)
	_, err = c.Evals.Cancel(ctx, "e")
	check("eval cancel", err)
	_, err = c.Evals.Failures(ctx, "e", grad.FailureOptions{})
	check("failures", err)
	for name, seq := range map[string]func() error{
		"datasets":  func() error { _, err := grad.Collect(c.Datasets.List(ctx, grad.DatasetListOptions{})); return err },
		"records":   func() error { _, err := grad.Collect(c.Datasets.Records(ctx, "d")); return err },
		"imports":   func() error { _, err := grad.Collect(c.Imports.List(ctx, grad.ImportListOptions{})); return err },
		"runs":      func() error { _, err := grad.Collect(c.Runs.List(ctx, grad.RunListOptions{})); return err },
		"metrics":   func() error { _, err := grad.Collect(c.Runs.Metrics(ctx, "r", false)); return err },
		"follow":    func() error { _, err := grad.Collect(c.Runs.Metrics(ctx, "r", true)); return err },
		"artifacts": func() error { _, err := grad.Collect(c.Artifacts.List(ctx, grad.ArtifactListOptions{})); return err },
		"evals":     func() error { _, err := grad.Collect(c.Evals.List(ctx, grad.EvalListOptions{})); return err },
		"keys":      func() error { _, err := grad.Collect(c.Keys.List(ctx)); return err },
	} {
		check(name, seq())
	}
}
