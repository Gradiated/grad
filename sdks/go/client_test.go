package grad_test

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	grad "github.com/Gradiated/grad/sdks/go"
	"github.com/Gradiated/grad/sdks/go/generated"
)

func TestGoClientLifecycle(t *testing.T) {
	artifactBytes := []byte("go-artifact-bundle")
	sum := sha256.Sum256(artifactBytes)
	artifactSHA := hex.EncodeToString(sum[:])

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodPost && r.URL.Path == "/v1/datasets/support/records":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "support", "record_count": 1})
		case r.Method == http.MethodPost && r.URL.Path == "/v1/runs/plan":
			w.Header().Set("Content-Type", "application/json")
			_ = json.NewEncoder(w).Encode(map[string]any{"estimated_steps": 4, "estimated_cost_usd": 0.05})
		case r.Method == http.MethodGet && r.URL.Path == "/v1/artifacts/demo@latest/download":
			w.Header().Set("Content-Type", "application/octet-stream")
			w.Header().Set("X-Artifact-Sha256", artifactSHA)
			_, _ = w.Write(artifactBytes)
		default:
			w.Header().Set("Content-Type", "application/problem+json")
			w.WriteHeader(http.StatusNotFound)
			_ = json.NewEncoder(w).Encode(map[string]any{
				"status": 404, "code": "not_found", "title": "Not Found", "detail": r.URL.Path,
			})
		}
	}))
	defer srv.Close()

	client := grad.New(srv.URL, grad.WithAPIKey("grad_go"), grad.WithHTTPClient(srv.Client()))
	ctx := context.Background()

	ds, err := client.PushDataset(ctx, "support", []map[string]any{
		{"messages": []map[string]any{{"role": "user", "content": "hi"}}},
	})
	if err != nil {
		t.Fatalf("PushDataset failed: %v", err)
	}
	if ds["name"] != "support" {
		t.Fatalf("unexpected dataset name: %v", ds["name"])
	}

	plan, err := client.PlanRun(ctx, "support", "support-sft", grad.SFTRecipe("qwen/qwen3-8b"), nil)
	if err != nil {
		t.Fatalf("PlanRun failed: %v", err)
	}
	if plan["estimated_steps"].(float64) != 4 {
		t.Fatalf("unexpected steps: %v", plan["estimated_steps"])
	}

	gotBytes, err := client.DownloadArtifact(ctx, "demo@latest")
	if err != nil {
		t.Fatalf("DownloadArtifact failed: %v", err)
	}
	if string(gotBytes) != string(artifactBytes) {
		t.Fatalf("unexpected bytes: %q", string(gotBytes))
	}

	_, err = client.Wire.GetDataset(ctx, "missing")
	var apiErr *generated.APIError
	if !errors.As(err, &apiErr) || apiErr.Status != 404 {
		t.Fatalf("expected 404 APIError, got %v", err)
	}
}
