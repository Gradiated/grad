package grad_test

// The Go snippets of the public docs, compiled (not run) so the documented
// surface cannot drift. Live versions run in live_test.go.

import (
	"context"
	"fmt"
	"log"
	"os"

	grad "github.com/Gradiated/grad/sdks/go"
)

func Example_quickstart() {
	ctx := context.Background()
	client := grad.NewClient()
	dataset, _ := client.Datasets.Create(ctx, "support-prod")
	dataset.ImportFile(ctx, "./support_traces.jsonl").Wait(ctx)

	run, _ := client.Runs.Create(ctx, grad.RunParams{
		Dataset: dataset,
		Name:    "support-router",
		Recipe:  grad.RouterRecipe{},
	}).Wait(ctx)
	_, _ = run.Download(ctx, "./support-router")
}

func Example_apiKey() {
	client := grad.NewClient(grad.WithAPIKey(os.Getenv("GRADIATED_API_KEY")))
	_ = client
}

func Example_selfHosting() {
	client := grad.NewClient(
		grad.WithBaseURL("https://grad.internal.example"),
		grad.WithAPIKey(os.Getenv("GRADIATED_API_KEY")),
	)
	_ = client
}

func Example_planAndCreate() {
	ctx := context.Background()
	client := grad.NewClient()
	dataset, _ := client.Datasets.Get(ctx, "support-prod")

	plan, _ := client.Runs.Plan(ctx, grad.RunParams{
		Dataset: dataset,
		Name:    "support-router",
		Recipe:  grad.RouterRecipe{},
	})
	fmt.Println(plan.ResolvedRecipe, plan.Warnings, plan.EstimatedTokens, plan.EstimatedCostUSD)

	run, _ := client.Runs.Create(ctx, grad.RunParams{
		Dataset:    dataset,
		Name:       "support-router",
		Recipe:     grad.RouterRecipe{},
		MaxCostUSD: 20,
	}).Wait(ctx)
	fmt.Println(run.Artifact.ID, run.EvalReport)
}

func Example_decisionModel() {
	client := grad.NewClient()
	ctx := context.Background()
	dataset, _ := client.Datasets.Get(ctx, "ticket-triage")

	run, _ := client.Runs.Create(ctx, grad.RunParams{
		Dataset: dataset,
		Name:    "ticket-triage",
		Recipe:  grad.DecisionModelRecipe{},
	}).Wait(ctx)
	fmt.Println(run.Artifact.ID, run.EvalReport)
}

func Example_router() {
	client := grad.NewClient()
	ctx := context.Background()
	dataset, _ := client.Datasets.Get(ctx, "support-traces")

	run, _ := client.Runs.Create(ctx, grad.RunParams{
		Dataset: dataset,
		Name:    "support-router",
		Recipe: grad.RouterRecipe{
			Models: []string{"qwen/qwen3-8b", "qwen/qwen3-32b"},
		},
	}).Wait(ctx)
	fmt.Println(run.Artifact.ID, run.EvalReport)
}

func Example_uploadArtifact() {
	ctx := context.Background()
	client := grad.NewClient()
	job, _ := client.Artifacts.Upload(ctx, "./my-lora", grad.UploadParams{Base: "qwen/qwen3-8b"})
	artifact, _ := job.Wait(ctx)
	imported, _ := client.Artifacts.FromHF(ctx, "hf://acme/support-lora@main", grad.FromHFParams{Base: "qwen/qwen3-8b"})
	fromHub, _ := imported.Wait(ctx)
	fmt.Println(artifact.ID, artifact.Provenance.Source, fromHub.Provenance.URI)
}

func Example_trajectories() {
	ctx := context.Background()
	client := grad.NewClient()
	traj := grad.TrajectoryFromMessages([]grad.Message{
		{Role: "user", Content: "Merge these two diffs into one patch."},
		{Role: "assistant", Content: "--- a/app.py\n+++ b/app.py\n@@ -1 +1 @@\n-print('hi')\n+print('hello')"},
	}, grad.WithSessionID("pr_481"))
	traj.Scores["tests_passed"] = 1.0

	_, _ = client.Datasets.Push(ctx, "diff-merge-gold", []grad.Trajectory{traj})
}

func Example_importFile() {
	ctx := context.Background()
	client := grad.NewClient()
	dataset, _ := client.Datasets.Create(ctx, "support-prod")
	job, _ := dataset.ImportFile(ctx, "./traces.parquet").Wait(ctx)
	fmt.Println(job.ImportedCount, job.DetectedScores)
}

func Example_metrics() {
	ctx := context.Background()
	client := grad.NewClient()
	run, _ := client.Runs.Get(ctx, "run_01J9X")
	for m, err := range run.Metrics(ctx, true) {
		if err != nil {
			log.Fatal(err)
		}
		fmt.Println(m.Step, m.Loss, m.EvalMetrics)
	}
}

func Example_evaluation() {
	ctx := context.Background()
	client := grad.NewClient()
	evalDs, _ := client.Datasets.Get(ctx, "sql-eval-holdout")
	rubric := grad.Rubric{
		grad.Scorer{Name: "valid_json", Weight: 0.3, Validator: grad.ValidatorJSON},
		grad.Judge{Name: "correct_query", Model: "claude-sonnet", Prompt: "Verify the SQL answers the question.", Weight: 0.7},
	}
	ev, err := client.Evals.Create(ctx, grad.EvalParams{
		Name:        "sql-baseline-vs-rl",
		Models:      []string{"qwen/qwen3-8b", "sql-agent@latest"},
		Dataset:     evalDs,
		Rubric:      rubric,
		Samples:     4,
		Temperature: grad.Float(0.7),
		Baseline:    "qwen/qwen3-8b",
	}).Wait(ctx)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println(ev.SummaryTable())

	failures, _ := ev.Failures(ctx, grad.FailureOptions{Model: "sql-agent@latest", Threshold: grad.Float(0.8)})
	hard, _ := failures.ToDataset(ctx, "sql-hard-cases")
	n, _ := hard.Count(ctx)
	fmt.Printf("Saved %d failing examples\n", n)
}
