package grad_test

// Live tests: the docs' Go snippets, nearly verbatim, against a real grad-server
// started by tests/harness/stack.ts. They skip when server/api/node_modules is
// missing (pnpm -C server/api install --frozen-lockfile), with -short, or with
// GRAD_SKIP_LIVE=1. The torch test needs GRAD_TRAINER_PYTHON (torch, transformers, peft).

import (
	"bufio"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	grad "github.com/Gradiated/grad/sdks/go"
)

type liveStack struct {
	BaseURL string `json:"base_url"`
	APIKey  string `json:"api_key"`
	Mode    string `json:"mode"`
}

func repoRoot(t *testing.T) string {
	_, file, _, _ := runtime.Caller(0)
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", ".."))
}

func torchPython() string {
	py := os.Getenv("GRAD_TRAINER_PYTHON")
	if py == "" {
		return ""
	}
	if exec.Command(py, "-c", "import torch, transformers, peft").Run() != nil {
		return ""
	}
	return py
}

// startStack boots the harness and stops it (and only it) when the test ends.
func startStack(t *testing.T, args ...string) *liveStack {
	t.Helper()
	if testing.Short() || os.Getenv("GRAD_SKIP_LIVE") == "1" {
		t.Skip("live tests disabled (-short or GRAD_SKIP_LIVE=1)")
	}
	root := repoRoot(t)
	tsx := filepath.Join(root, "server", "api", "node_modules", ".bin", "tsx")
	if _, err := os.Stat(tsx); err != nil {
		t.Skipf("skipping live test: %s missing (pnpm -C server/api install --frozen-lockfile)", tsx)
	}
	cmd := exec.Command(tsx, append([]string{filepath.Join(root, "tests", "harness", "stack.ts"), "--auth", "api_key"}, args...)...)
	cmd.Dir = filepath.Join(root, "server", "api")
	stdin, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	logFile, err := os.CreateTemp("", "grad-go-stack-*.log")
	if err != nil {
		t.Fatal(err)
	}
	cmd.Stderr = logFile
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	exited := make(chan struct{})
	go func() { _ = cmd.Wait(); close(exited) }()
	t.Cleanup(func() {
		_ = stdin.Close() // the harness tears its children down when stdin closes
		select {
		case <-exited:
		case <-time.After(30 * time.Second):
			_ = cmd.Process.Kill()
			<-exited
		}
		_ = logFile.Close()
		if !t.Failed() {
			_ = os.Remove(logFile.Name())
		} else {
			t.Logf("stack log: %s", logFile.Name())
		}
	})
	lines := make(chan string, 1)
	go func() {
		line, _ := bufio.NewReader(stdout).ReadString('\n')
		lines <- line
		_, _ = io.Copy(io.Discard, stdout)
	}()
	select {
	case line := <-lines:
		var info liveStack
		if err := json.Unmarshal([]byte(strings.TrimSpace(line)), &info); err != nil {
			t.Fatalf("harness output %q: %v (log %s)", line, err, logFile.Name())
		}
		return &info
	case <-time.After(5 * time.Minute):
		t.Fatalf("harness did not report ready (log %s)", logFile.Name())
	}
	return nil
}

func writeTraces(t *testing.T, path string, n int) {
	t.Helper()
	var b strings.Builder
	for i := 0; i < n; i++ {
		line, _ := json.Marshal(map[string]any{
			"session_id": fmt.Sprintf("s%d", i),
			"messages": []map[string]string{
				{"role": "user", "content": fmt.Sprintf("Reset my password %d", i)},
				{"role": "assistant", "content": "Open Settings, then Security."},
			},
		})
		b.Write(line)
		b.WriteByte('\n')
	}
	if err := os.WriteFile(path, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}
}

// must(f())(t) returns f's value, failing the test on its error.
func must[T any](v T, err error) func(*testing.T) T {
	return func(t *testing.T) T {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
}

func TestLiveSelfHosted(t *testing.T) {
	stack := startStack(t, "--worker", "reference")
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Minute)
	defer cancel()
	dir := t.TempDir()
	client := grad.NewClient(grad.WithBaseURL(stack.BaseURL), grad.WithAPIKey(stack.APIKey))

	t.Run("quickstart", func(t *testing.T) {
		traces := filepath.Join(dir, "support_traces.jsonl")
		writeTraces(t, traces, 40)

		dataset := must(client.Datasets.Create(ctx, "support-prod"))(t)
		job := must(dataset.ImportFile(ctx, traces).Wait(ctx))(t)
		if job.ImportedCount != 40 {
			t.Fatalf("imported %d", job.ImportedCount)
		}
		var conflict *grad.ConflictError
		if _, err := client.Datasets.Create(ctx, "support-prod"); !errors.As(err, &conflict) {
			t.Fatalf("duplicate create: %v", err)
		}

		recipe := grad.SFTRecipe{Model: "test/tiny-qwen3", BatchSize: 8}
		plan := must(client.Runs.Plan(ctx, grad.RunParams{Dataset: dataset, Name: "support-sft", Recipe: recipe}))(t)
		if plan.EstimatedSteps < 1 {
			t.Fatalf("plan %+v", plan)
		}

		var metrics []grad.MetricPoint
		var statuses []string
		run := must(client.Runs.Create(ctx, grad.RunParams{
			Dataset:    dataset,
			Name:       "support-sft",
			Recipe:     recipe,
			MaxCostUSD: 5,
		}).Wait(ctx, grad.WithOnMetric(func(m grad.MetricPoint) { metrics = append(metrics, m) }), grad.WithOnStatus(func(s string) { statuses = append(statuses, s) })))(t)
		if run.Status != grad.RunCompleted || run.Artifact == nil || len(metrics) == 0 {
			t.Fatalf("run %s artifact %v metrics %d", run.Status, run.Artifact, len(metrics))
		}
		if statuses[len(statuses)-1] != "completed" {
			t.Fatalf("statuses %v", statuses)
		}
		points := must(grad.Collect(run.Metrics(ctx, false)))(t)
		if len(points) != len(metrics) {
			t.Fatalf("paged %d points, streamed %d while waiting", len(points), len(metrics))
		}
		if len(must(run.Checkpoints(ctx))(t)) == 0 {
			t.Fatal("no checkpoints")
		}

		dl := must(run.Download(ctx, dir))(t)
		raw := must(os.ReadFile(dl.Path))(t)
		sum := sha256.Sum256(raw)
		if hex.EncodeToString(sum[:]) != run.Artifact.SHA256 || dl.SizeBytes != int64(len(raw)) {
			t.Fatalf("download %+v does not match artifact sha %s", dl, run.Artifact.SHA256)
		}

		// Self-hosted servers have no hosted serving.
		var unavailable *grad.DeployUnavailableError
		if _, err := run.Deploy(ctx); !errors.As(err, &unavailable) {
			t.Fatalf("deploy: %v", err)
		}
		latest := must(client.Artifacts.Get(ctx, "support-sft@latest"))(t)
		if latest.ID != run.Artifact.ID {
			t.Fatalf("latest %s, run artifact %s", latest.ID, run.Artifact.ID)
		}
	})

	t.Run("trajectories and records", func(t *testing.T) {
		traj := grad.TrajectoryFromMessages([]grad.Message{
			{Role: "user", Content: "Merge these two diffs into one patch."},
			{Role: "assistant", Content: "--- a/app.py\n+++ b/app.py"},
		}, grad.WithSessionID("pr_481"))
		traj.Scores["tests_passed"] = 1.0
		ds := must(client.Datasets.Push(ctx, "diff-merge-gold", []grad.Trajectory{traj, traj, traj}, grad.WithBatchSize(2)))(t)
		if n := must(ds.Count(ctx))(t); n != 3 {
			t.Fatalf("count %d", n)
		}
		records := must(grad.Collect(ds.Records(ctx, grad.WithPageSize(2))))(t)
		if len(records) != 3 || records[0].Scores["tests_passed"] != 1.0 {
			t.Fatalf("records %+v", records)
		}
	})

	t.Run("evaluation with a local scorer", func(t *testing.T) {
		holdout := filepath.Join(dir, "holdout.jsonl")
		writeTraces(t, holdout, 4)
		evalDs := must(client.Datasets.Create(ctx, "support-eval"))(t)
		must(evalDs.ImportFile(ctx, holdout).Wait(ctx))(t)
		rubric := grad.Rubric{
			grad.Scorer{Name: "nonempty", Weight: 0.5, Validator: grad.ValidatorNonEmpty},
			grad.Scorer{Name: "mentions_settings", Weight: 0.5, Fn: func(_ context.Context, in grad.ScoreInput) (float64, error) {
				if strings.Contains(in.Output, "Settings") {
					return 1, nil
				}
				return 0, nil
			}},
		}
		ev := must(client.Evals.Create(ctx, grad.EvalParams{
			Name:    "smoke",
			Models:  []string{"qwen/qwen3-8b"},
			Dataset: evalDs,
			Rubric:  rubric,
			Limit:   4,
		}).Wait(ctx))(t)
		if ev.Status != "completed" || !strings.Contains(ev.SummaryTable(), "qwen/qwen3-8b") {
			t.Fatalf("eval %s\n%s", ev.Status, ev.SummaryTable())
		}
		failures := must(ev.Failures(ctx, grad.FailureOptions{Threshold: grad.Float(0.9)}))(t)
		if len(failures.Outcomes) > 0 {
			hard := must(failures.ToDataset(ctx, "support-hard-cases"))(t)
			if n := must(hard.Count(ctx))(t); n == 0 {
				t.Fatal("no failing examples saved")
			}
		}
	})

	t.Run("scoped keys, errors.As and config fallbacks", func(t *testing.T) {
		key := must(client.Keys.Create(ctx, "ci", "runs:read"))(t)
		ci := grad.NewClient(grad.WithBaseURL(stack.BaseURL), grad.WithAPIKey(key.Secret))
		var denied *grad.PermissionDeniedError
		if _, err := ci.Datasets.Push(ctx, "x", []grad.Trajectory{grad.TrajectoryFromMessages([]grad.Message{{Role: "user", Content: "hi"}})}); !errors.As(err, &denied) {
			t.Fatalf("push with runs:read: %v", err)
		}
		if _, err := grad.Collect(ci.Runs.List(ctx)); err != nil {
			t.Fatal(err)
		}
		must(client.Keys.Revoke(ctx, key.Key.ID))(t)
		var unauth *grad.AuthenticationError
		if _, err := grad.Collect(ci.Runs.List(ctx)); !errors.As(err, &unauth) {
			t.Fatalf("revoked key: %v", err)
		}

		env := map[string]string{"GRADIATED_API_KEY": stack.APIKey, "GRADIATED_BASE_URL": stack.BaseURL}
		fromEnv := grad.NewClient(grad.WithEnv(func(k string) string { return env[k] }))
		if len(must(fromEnv.Models.List(ctx))(t)) == 0 {
			t.Fatal("no models via env")
		}
		cfg := filepath.Join(dir, "config.json")
		body, _ := json.Marshal(map[string]any{"profiles": map[string]any{"default": map[string]string{"base_url": stack.BaseURL, "api_key": stack.APIKey}}})
		if err := os.WriteFile(cfg, body, 0o600); err != nil {
			t.Fatal(err)
		}
		fromFile := grad.NewClient(grad.WithEnv(func(string) string { return "" }), grad.WithConfigFile(cfg))
		if fromFile.BaseURL() != stack.BaseURL || len(must(fromFile.Models.List(ctx))(t)) == 0 {
			t.Fatalf("config file client %s", fromFile.BaseURL())
		}
	})
}

func TestLiveCloudRouterWithTorch(t *testing.T) {
	if torchPython() == "" {
		t.Skip("skipping: set GRAD_TRAINER_PYTHON to a Python with torch, transformers and peft")
	}
	stack := startStack(t, "--cloud", "--worker", "torch")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	client := grad.NewClient(grad.WithBaseURL(stack.BaseURL), grad.WithAPIKey(stack.APIKey))

	var b strings.Builder
	for i := 0; i < 60; i++ {
		hard := i%2 == 0
		prompt := fmt.Sprintf("say hello %d", i)
		cheap := 1.0
		if hard {
			prompt, cheap = fmt.Sprintf("hard SQL join query %d", i), 0
		}
		line, _ := json.Marshal(map[string]any{"session_id": fmt.Sprintf("s%d", i), "messages": []map[string]string{{"role": "user", "content": prompt}}, "scores": map[string]float64{"cheap/m": cheap, "strong/m": 1}})
		b.Write(line)
		b.WriteByte('\n')
	}
	traces := filepath.Join(t.TempDir(), "support_traces.jsonl")
	if err := os.WriteFile(traces, []byte(b.String()), 0o600); err != nil {
		t.Fatal(err)
	}

	dataset := must(client.Datasets.Create(ctx, "support-prod"))(t)
	must(dataset.ImportFile(ctx, traces).Wait(ctx))(t)
	run := must(client.Runs.Create(ctx, grad.RunParams{
		Dataset: dataset,
		Name:    "support-router",
		Recipe:  grad.RouterRecipe{Model: "test/tiny-qwen3", Models: []string{"cheap/m", "strong/m"}, BatchSize: 8},
	}).Wait(ctx))(t)
	first := must(run.Deploy(ctx))(t)
	if first.ActiveArtifactID != run.Artifact.ID {
		t.Fatalf("deployed %s, want %s", first.ActiveArtifactID, run.Artifact.ID)
	}

	messages := []grad.Message{{Role: "user", Content: "hard SQL join query 3"}}
	decision := must(client.Route(ctx, "support-router", grad.RouteInput{Messages: messages}))(t)
	if decision.InferenceID == "" || decision.ArtifactID != run.Artifact.ID {
		t.Fatalf("decision %+v", decision.RouteResponse)
	}
	if err := decision.RecordFeedback(ctx, grad.Feedback{Score: 1.0, Metrics: map[string]float64{"latency_ms": 12}}); err != nil {
		t.Fatal(err)
	}
	again := must(client.Feedback.RecordMany(ctx, grad.Feedback{InferenceID: decision.InferenceID, IdempotencyKey: decision.InferenceID, Score: 1.0}))(t)
	if again.Deduplicated != 1 {
		t.Fatalf("feedback replay %+v", again)
	}

	checkpoints := must(run.Checkpoints(ctx))(t)
	promoted := must(checkpoints[0].Promote(ctx, "support-router"))(t)
	second := must(promoted.Deploy(ctx, grad.WithDeploymentName("support-router")))(t)
	if second.ActiveArtifactID == first.ActiveArtifactID {
		t.Fatal("promoted checkpoint did not become active")
	}
	rolled := must(client.Deployments.Rollback(ctx, "support-router"))(t)
	if rolled.ActiveArtifactID != first.ActiveArtifactID {
		t.Fatalf("rollback active %s, want %s", rolled.ActiveArtifactID, first.ActiveArtifactID)
	}
	status := must(client.Deployments.Get(ctx, "support-router"))(t)
	if status.FeedbackCount < 1 {
		t.Fatalf("status %+v", status)
	}
}
