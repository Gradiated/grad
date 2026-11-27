package grad

import (
	"context"
	"encoding/json"
	"io"
	"iter"
	"time"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// Wire types re-exported for convenience.
type (
	// MetricPoint is one training step's metrics (extra keys in AdditionalProperties).
	MetricPoint = generated.MetricPoint
	// ResolvedRunConfig is every setting a run resolved to, with rule versions.
	ResolvedRunConfig = generated.ResolvedRunConfig
	// RunStatus is a run's lifecycle state.
	RunStatus = generated.RunStatus
	// EvalReport is a run's held-out report: the shared core plus the fields its recipe writes.
	EvalReport = generated.EvalReport
	// RouterParetoSummary is a router run's quality vs. cost summary (EvalReport.ParetoSummary).
	RouterParetoSummary = generated.RouterParetoSummary
)

// Run statuses.
const (
	RunQueued        = generated.RunStatusQueued
	RunRunning       = generated.RunStatusRunning
	RunCompleted     = generated.RunStatusCompleted
	RunFailed        = generated.RunStatusFailed
	RunCancelled     = generated.RunStatusCancelled
	RunStoppedBudget = generated.RunStatusStoppedBudget
	// RunStoppedBalance means the workspace ran out of balance (Cloud); top up, then Resume.
	RunStoppedBalance = generated.RunStatusStoppedBalance
)

// IsTerminal reports whether a run in this status will not change again.
func IsTerminal(s RunStatus) bool {
	switch s {
	case RunCompleted, RunFailed, RunCancelled, RunStoppedBudget, RunStoppedBalance:
		return true
	}
	return false
}

// RunParams describes a training run.
type RunParams struct {
	// Dataset is a *Dataset or DatasetName("name").
	Dataset DatasetRef
	// Name is the output name; artifacts are versioned under it.
	Name   string
	Recipe Recipe
	// Split defaults to BySession{EvalFraction: 0.10} (0.15 for routers and decision models).
	Split Split
	// MaxCostUSD is the spend cap (0 = none).
	MaxCostUSD float64
	// IdempotencyKey makes a retried Create (even from another process) return
	// the run the first call created (default: a fresh key per call).
	IdempotencyKey string
}

// idempotency returns the per-call Idempotency-Key option, if the caller set one.
func idempotency(key string) []generated.RequestOption {
	if key == "" {
		return nil
	}
	return []generated.RequestOption{generated.WithIdempotencyKey(key)}
}

func (p RunParams) wire() (*generated.PlanRunRequest, error) {
	if p.Dataset == nil || p.Dataset.datasetName() == "" {
		return nil, newError("invalid_request", "RunParams.Dataset is required")
	}
	if p.Recipe == nil {
		return nil, newError("invalid_request", "RunParams.Recipe is required")
	}
	spec, err := p.Recipe.RecipeSpec()
	if err != nil {
		return nil, err
	}
	req := &generated.PlanRunRequest{Dataset: p.Dataset.datasetName(), Name: p.Name, Recipe: spec, MaxCostUSD: optFloat(p.MaxCostUSD)}
	if p.Split != nil {
		s := p.Split.splitSpec()
		req.Split = &s
	}
	return req, nil
}

// RunPlan is the dry run of a training run: resolved settings, warnings and estimates.
type RunPlan struct {
	generated.PlanRunResponse
	// ResolvedRecipe is ResolvedConfig under the name the docs use.
	ResolvedRecipe ResolvedRunConfig
}

// Run is a training run.
type Run struct {
	generated.Run
	// Artifact is the produced artifact, loaded by Wait (nil until then or when none was produced).
	Artifact *Artifact
	c        *Client
}

// RunsService manages training runs.
type RunsService struct{ c *Client }

func (c *Client) run(r *generated.Run) *Run { return &Run{Run: *r, c: c} }

// Plan validates the dataset, resolves every default and estimates tokens and cost. Nothing is billed.
func (s *RunsService) Plan(ctx context.Context, p RunParams) (*RunPlan, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	req, err := p.wire()
	if err != nil {
		return nil, err
	}
	plan, err := api.PlanRun(ctx, req)
	if err != nil {
		return nil, err
	}
	return &RunPlan{PlanRunResponse: *plan, ResolvedRecipe: plan.ResolvedConfig}, nil
}

// RunHandle is a submitted run. Call Wait to block until it finishes.
type RunHandle struct {
	run *Run
	err error
}

// Result returns the run as created (or the error that prevented it).
func (h *RunHandle) Result() (*Run, error) { return h.run, h.err }

// Wait blocks until the run finishes; see Run.Wait.
func (h *RunHandle) Wait(ctx context.Context, opts ...WaitOption) (*Run, error) {
	if h.err != nil {
		return nil, h.err
	}
	if err := h.run.Wait(ctx, opts...); err != nil {
		return h.run, err
	}
	return h.run, nil
}

// Create starts a training run: client.Runs.Create(ctx, params).Wait(ctx).
// The created run's Warnings holds the plan's warnings, such as another queued
// or running run with the same name (names aren't unique; this only warns).
func (s *RunsService) Create(ctx context.Context, p RunParams) *RunHandle {
	api, err := s.c.api()
	if err != nil {
		return &RunHandle{err: err}
	}
	req, err := p.wire()
	if err != nil {
		return &RunHandle{err: err}
	}
	r, err := api.CreateRun(ctx, req, idempotency(p.IdempotencyKey)...)
	if err != nil {
		return &RunHandle{err: err}
	}
	return &RunHandle{run: s.c.run(r)}
}

// Get fetches a run.
func (s *RunsService) Get(ctx context.Context, id string) (*Run, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	r, err := api.GetRun(ctx, id)
	if err != nil {
		return nil, err
	}
	return s.c.run(r), nil
}

// List iterates over runs, newest first.
func (s *RunsService) List(ctx context.Context) iter.Seq2[*Run, error] {
	return paginate(ctx, func(ctx context.Context, cursor *string) ([]*Run, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		page, err := api.ListRuns(ctx, &generated.ListRunsParams{Cursor: cursor})
		if err != nil {
			return nil, nil, err
		}
		out := make([]*Run, len(page.Data))
		for i := range page.Data {
			out[i] = s.c.run(&page.Data[i])
		}
		return out, page.NextCursor, nil
	})
}

// Cancel stops a run (a running attempt is stopped and billed).
func (s *RunsService) Cancel(ctx context.Context, id string) (*Run, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	r, err := api.CancelRun(ctx, id)
	if err != nil {
		return nil, err
	}
	return s.c.run(r), nil
}

// Resume continues a stopped run from its last checkpoint; pass a higher maxCostUSD to
// resume a stopped_budget run (0 keeps the current cap).
func (s *RunsService) Resume(ctx context.Context, id string, maxCostUSD float64) (*Run, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	r, err := api.ResumeRun(ctx, id, &generated.ResumeRunRequest{MaxCostUSD: optFloat(maxCostUSD)})
	if err != nil {
		return nil, err
	}
	return s.c.run(r), nil
}

// Wait fetches a run and waits for it; see Run.Wait.
func (s *RunsService) Wait(ctx context.Context, id string, opts ...WaitOption) (*Run, error) {
	r, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	return r, r.Wait(ctx, opts...)
}

// Metrics iterates over a run's metrics; see Run.Metrics.
func (s *RunsService) Metrics(ctx context.Context, id string, follow bool) iter.Seq2[MetricPoint, error] {
	r := &Run{c: s.c}
	r.ID = id
	return r.Metrics(ctx, follow)
}

// Checkpoints lists a run's checkpoints (step, eval_score, expires_at).
func (s *RunsService) Checkpoints(ctx context.Context, id string) ([]*Checkpoint, error) {
	return Collect(paginate(ctx, func(ctx context.Context, cursor *string) ([]*Checkpoint, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		page, err := api.ListRunCheckpoints(ctx, id, &generated.ListRunCheckpointsParams{Cursor: cursor})
		if err != nil {
			return nil, nil, err
		}
		out := make([]*Checkpoint, len(page.Data))
		for i := range page.Data {
			out[i] = &Checkpoint{Checkpoint: page.Data[i], c: s.c}
		}
		return out, page.NextCursor, nil
	}))
}

// Refresh reloads the run.
func (r *Run) Refresh(ctx context.Context) error {
	fresh, err := r.c.Runs.Get(ctx, r.ID)
	if err != nil {
		return err
	}
	r.Run = fresh.Run
	return nil
}

// Wait polls until the run reaches a terminal status (backoff 0.5 s to 5 s, transient
// errors tolerated). On completion Artifact is loaded. failed, cancelled and
// stopped_budget (and stopped_balance) return *RunFailedError carrying the run.
func (r *Run) Wait(ctx context.Context, opts ...WaitOption) error {
	w := newWaitConfig(opts)
	var err error
	if w.onEvent != nil {
		err = r.followEvents(ctx, w)
	} else {
		err = r.pollUntilDone(ctx, w)
	}
	if err != nil {
		return err
	}
	return r.finish(ctx)
}

// pollUntilDone polls the run (and, with WithOnMetric, its metric pages).
func (r *Run) pollUntilDone(ctx context.Context, w *waitConfig) error {
	var cursor *string
	onStatus := w.onStatus
	polled := *w
	polled.onStatus = nil
	last := ""
	return r.c.poll(ctx, &polled, "run "+r.ID, func(ctx context.Context) (string, bool, error) {
		api, err := r.c.api()
		if err != nil {
			return "", false, err
		}
		fresh, err := api.GetRun(ctx, r.ID)
		if err != nil {
			return "", false, err
		}
		r.Run = *fresh
		if key := r.statusKey(); key != last && onStatus != nil {
			last = key
			onStatus(string(r.Status))
		}
		if w.onMetric != nil {
			page, err := api.ListRunMetrics(ctx, r.ID, &generated.ListRunMetricsParams{Cursor: cursor})
			if err != nil {
				return string(r.Status), false, err
			}
			for _, m := range page.Data {
				w.onMetric(m)
			}
			// tail_cursor follows points written later; next_cursor ends at the last page.
			if page.TailCursor != "" {
				cursor = &page.TailCursor
			}
			if len(page.Data) > 0 && IsTerminal(r.Status) {
				return string(r.Status), false, nil // drain remaining points first
			}
		}
		return string(r.Status), IsTerminal(r.Status), nil
	})
}

// finish loads the artifact of a completed run, or reports why it ended.
func (r *Run) finish(ctx context.Context) error {
	if r.ArtifactID != nil && *r.ArtifactID != "" {
		a, err := r.c.Artifacts.Get(ctx, *r.ArtifactID)
		if err != nil {
			return err
		}
		r.Artifact = a
	}
	if r.Status != RunCompleted {
		msg := deref(r.Error)
		if msg == "" {
			msg = "no error reported"
		}
		switch r.Status {
		case RunStoppedBudget:
			msg = "the spend cap was reached; raise it with Run.Resume(ctx, maxCostUSD)"
		case RunStoppedBalance:
			msg = "the workspace ran out of balance; top up, then Run.Resume(ctx, 0)"
		}
		return &RunFailedError{GradError: newError("run_"+string(r.Status), "run %s (%s) ended %s: %s", r.ID, r.Name, r.Status, msg), Run: r}
	}
	return nil
}

// Metrics iterates over training metrics. With follow, it streams live points over
// Server-Sent Events until the run finishes, reconnecting with Last-Event-ID after a
// dropped connection; without follow it returns the points recorded so far.
//
//	for m, err := range run.Metrics(ctx, true) { ... }
func (r *Run) Metrics(ctx context.Context, follow bool) iter.Seq2[MetricPoint, error] {
	if !follow {
		return paginate(ctx, func(ctx context.Context, cursor *string) ([]MetricPoint, *string, error) {
			api, err := r.c.api()
			if err != nil {
				return nil, nil, err
			}
			page, err := api.ListRunMetrics(ctx, r.ID, &generated.ListRunMetricsParams{Cursor: cursor, Limit: ptr(generated.ListRunMetricsLimitMax)})
			if err != nil {
				return nil, nil, err
			}
			return page.Data, page.NextCursor, nil
		})
	}
	return func(yield func(MetricPoint, error) bool) {
		lastID := ""
		failures := 0
		delay := 500 * time.Millisecond
		for {
			api, err := r.c.api()
			if err != nil {
				yield(MetricPoint{}, err)
				return
			}
			var opts []generated.RequestOption
			if lastID != "" {
				opts = append(opts, generated.WithLastEventID(lastID))
			}
			stream, err := api.ListRunMetricsStream(ctx, r.ID, nil, opts...)
			if err == nil {
				for stream.Next() {
					ev := stream.Event()
					failures, delay = 0, 500*time.Millisecond
					switch ev.Event {
					case "metric":
						var m MetricPoint
						if derr := json.Unmarshal([]byte(ev.Data), &m); derr != nil {
							stream.Close()
							yield(MetricPoint{}, &DecodeError{GradError: &GradError{Code: "invalid_json", Message: "grad: metric event is not valid JSON: " + derr.Error(), Cause: derr}})
							return
						}
						if ev.ID != "" {
							lastID = ev.ID
						}
						if !yield(m, nil) {
							stream.Close()
							return
						}
					case "status":
						var fresh generated.Run
						if json.Unmarshal([]byte(ev.Data), &fresh) == nil && fresh.ID != "" {
							r.Run = fresh
						}
						stream.Close()
						return
					}
				}
				err = stream.Err()
				stream.Close()
				if err == nil {
					err = &ConnectionError{GradError: &GradError{Code: "connection_error", Message: "grad: the metrics stream closed before the run finished", Cause: io.ErrUnexpectedEOF}}
				}
			}
			if ctx.Err() != nil {
				yield(MetricPoint{}, &GradError{Code: "aborted", Message: "grad: metrics stream cancelled: " + ctx.Err().Error(), Cause: ctx.Err()})
				return
			}
			failures++
			if !isTransient(err) || failures > 10 {
				yield(MetricPoint{}, err)
				return
			}
			if serr := r.c.sleep(ctx, delay); serr != nil {
				yield(MetricPoint{}, &GradError{Code: "aborted", Message: "grad: metrics stream cancelled: " + serr.Error(), Cause: serr})
				return
			}
			delay *= 2
			if delay > 5*time.Second {
				delay = 5 * time.Second
			}
		}
	}
}

// Cancel stops the run.
func (r *Run) Cancel(ctx context.Context) error {
	fresh, err := r.c.Runs.Cancel(ctx, r.ID)
	if err != nil {
		return err
	}
	r.Run = fresh.Run
	return nil
}

// Resume continues the run (raise maxCostUSD after stopped_budget; 0 keeps the cap).
func (r *Run) Resume(ctx context.Context, maxCostUSD float64) error {
	fresh, err := r.c.Runs.Resume(ctx, r.ID, maxCostUSD)
	if err != nil {
		return err
	}
	r.Run = fresh.Run
	return nil
}

// Checkpoints lists the run's checkpoints.
func (r *Run) Checkpoints(ctx context.Context) ([]*Checkpoint, error) {
	return r.c.Runs.Checkpoints(ctx, r.ID)
}

func (r *Run) artifactRef() (string, error) {
	if r.ArtifactID == nil || *r.ArtifactID == "" {
		return "", newError("no_artifact", "run %s has no artifact (status %s); wait for it to complete", r.ID, r.Status)
	}
	return *r.ArtifactID, nil
}

// Download streams the run's artifact bundle to dest with SHA-256 verification.
func (r *Run) Download(ctx context.Context, dest string) (*Download, error) {
	ref, err := r.artifactRef()
	if err != nil {
		return nil, err
	}
	return r.c.Artifacts.Download(ctx, ref, dest)
}

// Checkpoint is a saved training state.
type Checkpoint struct {
	generated.Checkpoint
	c *Client
}

// CheckpointsService promotes checkpoints.
type CheckpointsService struct{ c *Client }

// Promote turns a checkpoint into a versioned artifact (name "" keeps the run's name).
func (s *CheckpointsService) Promote(ctx context.Context, id, name string) (*Artifact, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	a, err := api.PromoteCheckpoint(ctx, id, &generated.PromoteCheckpointRequest{Name: optString(name)})
	if err != nil {
		return nil, err
	}
	return s.c.artifact(a), nil
}

// Promote turns this checkpoint into a versioned artifact.
func (ck *Checkpoint) Promote(ctx context.Context, name string) (*Artifact, error) {
	return ck.c.Checkpoints.Promote(ctx, ck.ID, name)
}
