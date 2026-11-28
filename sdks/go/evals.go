package grad

import (
	"context"
	"errors"
	"fmt"
	"iter"
	"math"
	"regexp"
	"strconv"
	"strings"
	"text/tabwriter"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// Wire types re-exported for convenience.
type (
	// EvalOutput is one model output of an eval.
	EvalOutput = generated.EvalOutput
	// EvalTaskOutcome is one scored task (used for failures).
	EvalTaskOutcome = generated.EvalTaskOutcome
	// EvalModelSummary is one model's aggregate score with a 95% CI.
	EvalModelSummary = generated.EvalModelSummary
	// EvalPlan is the cost and call estimate of an eval.
	EvalPlan = generated.PlanEvalResponse
	// EvalStatus is an eval's lifecycle state.
	EvalStatus = generated.EvalStatus
)

// Float returns a pointer to v, for optional numeric fields where 0 is meaningful.
func Float(v float64) *float64 { return &v }

// Int returns a pointer to v.
func Int(v int) *int { return &v }

// RubricItem is one check of a Rubric: Judge, Scorer or Regex.
type RubricItem interface {
	rubricItem() (generated.EvalRubricItem, error)
}

// Rubric is a weighted set of checks.
type Rubric []RubricItem

// Judge scores outputs with a model and a prompt (Model is required: no hidden default).
type Judge struct {
	Name   string
	Model  string
	Prompt string
	Weight float64
}

func (j Judge) rubricItem() (generated.EvalRubricItem, error) {
	if j.Name == "" || j.Model == "" {
		return generated.EvalRubricItem{}, newError("invalid_rubric", "Judge needs Name and Model")
	}
	return generated.EvalRubricItem{Name: j.Name, Kind: generated.EvalRubricItemKindJudge, Model: &j.Model, Prompt: optString(j.Prompt), Weight: optFloat(j.Weight)}, nil
}

// Validator is a built-in check that runs on the server.
type Validator string

// Built-in validators.
const (
	ValidatorJSON       Validator = "json"
	ValidatorNonEmpty   Validator = "non_empty"
	ValidatorExactMatch Validator = "exact_match"
)

// ScoreInput is what a local scorer function sees for one output.
type ScoreInput struct {
	OutputID    string
	TaskID      string
	Model       string
	SampleIndex int
	Input       []Message
	Output      string
	Expected    any
	Record      Trajectory
}

// ScorerFunc scores one output in [0, 1]; it runs in your process.
type ScorerFunc func(ctx context.Context, in ScoreInput) (float64, error)

// Scorer is a named check: a server-side Validator, or a Go function run locally while
// Eval.Wait is waiting (the eval pauses in awaiting_scores until scores are posted).
type Scorer struct {
	Name      string
	Weight    float64
	Fn        ScorerFunc
	Validator Validator
}

func (s Scorer) rubricItem() (generated.EvalRubricItem, error) {
	item := generated.EvalRubricItem{Name: s.Name, Weight: optFloat(s.Weight)}
	switch {
	case s.Name == "":
		return item, newError("invalid_rubric", "Scorer needs a Name")
	case s.Fn != nil && s.Validator != "":
		return item, newError("invalid_rubric", "Scorer %q sets both Fn and Validator", s.Name)
	case s.Fn != nil:
		item.Kind = generated.EvalRubricItemKindCode
		item.Runtime = ptr(generated.EvalRubricItemRuntimeLocal)
	case s.Validator != "":
		item.Kind = generated.EvalRubricItemKindValidator
		item.Validator = ptr(generated.EvalRubricItemValidator(s.Validator))
	default:
		return item, newError("invalid_rubric", "Scorer %q needs Fn or Validator", s.Name)
	}
	return item, nil
}

// Regex passes outputs matching Pattern (ECMAScript syntax, evaluated on the server).
type Regex struct {
	Name    string
	Pattern string
	Flags   string
	Weight  float64
}

func (r Regex) rubricItem() (generated.EvalRubricItem, error) {
	if r.Name == "" || r.Pattern == "" {
		return generated.EvalRubricItem{}, newError("invalid_rubric", "Regex needs Name and Pattern")
	}
	return generated.EvalRubricItem{Name: r.Name, Kind: generated.EvalRubricItemKindRegex, Pattern: &r.Pattern, Flags: optString(r.Flags), Weight: optFloat(r.Weight)}, nil
}

func (r Rubric) wire() ([]generated.EvalRubricItem, map[string]ScorerFunc, error) {
	items := make([]generated.EvalRubricItem, 0, len(r))
	local := map[string]ScorerFunc{}
	for _, it := range r {
		w, err := it.rubricItem()
		if err != nil {
			return nil, nil, err
		}
		if s, ok := it.(Scorer); ok && s.Fn != nil {
			local[s.Name] = s.Fn
		}
		items = append(items, w)
	}
	return items, local, nil
}

var numberRE = regexp.MustCompile(`-?\d[\d,]*(?:\.\d+)?`)

func lastNumber(s string) (float64, bool) {
	all := numberRE.FindAllString(s, -1)
	if len(all) == 0 {
		return 0, false
	}
	v, err := strconv.ParseFloat(strings.ReplaceAll(all[len(all)-1], ",", ""), 64)
	return v, err == nil
}

// NumericMatch scores 1 when the last number in the output equals the expected answer:
// field "" compares with the expected output, otherwise with that key of the expected
// output (when it is an object) or of the record metadata.
func NumericMatch(field string) ScorerFunc {
	return func(_ context.Context, in ScoreInput) (float64, error) {
		var want any = in.Expected
		if field != "" {
			want = nil
			if m, ok := in.Expected.(map[string]any); ok {
				want = m[field]
			}
			if want == nil && in.Record.Metadata != nil {
				want = in.Record.Metadata[field]
			}
		}
		if want == nil {
			return 0, fmt.Errorf("grad: NumericMatch(%q): output %s has no expected value", field, in.OutputID)
		}
		expected, ok := lastNumber(fmt.Sprint(want))
		if !ok {
			return 0, fmt.Errorf("grad: NumericMatch(%q): expected value %v has no number", field, want)
		}
		got, ok := lastNumber(in.Output)
		if ok && math.Abs(got-expected) <= 1e-6*math.Max(1, math.Abs(expected)) {
			return 1, nil
		}
		return 0, nil
	}
}

// EvalParams describes an evaluation.
type EvalParams struct {
	Name     string
	Models   []string
	Baseline string
	// Dataset supplies the tasks (required): a *Dataset or DatasetName("name").
	Dataset        DatasetRef
	DatasetVersion int
	Rubric         Rubric
	Samples        int
	Temperature    *float64
	MaxTokens      int
	Limit          int
	// PassThreshold defaults to 1.0 for binary checks, 0.5 otherwise (server-resolved).
	PassThreshold *float64
	// IdempotencyKey makes a retried Create return the eval the first call created.
	IdempotencyKey string
}

func (p EvalParams) wire() (*generated.PlanEvalRequest, map[string]ScorerFunc, error) {
	if p.Dataset == nil || p.Dataset.datasetName() == "" {
		return nil, nil, errors.New(`grad: EvalParams.Dataset is required (a *Dataset or grad.DatasetName("name"))`)
	}
	items, local, err := p.Rubric.wire()
	if err != nil {
		return nil, nil, err
	}
	req := &generated.PlanEvalRequest{Dataset: p.Dataset.datasetName(), Name: optString(p.Name), Models: p.Models, Baseline: optString(p.Baseline), DatasetVersion: optInt(p.DatasetVersion),
		Rubric: items, Samples: optInt(p.Samples), Temperature: p.Temperature, MaxTokens: optInt(p.MaxTokens), Limit: optInt(p.Limit),
		PassThreshold: p.PassThreshold}
	return req, local, nil
}

// Eval is an evaluation run.
type Eval struct {
	generated.EvalRun
	c       *Client
	scorers map[string]ScorerFunc
}

// EvalsService runs evaluations.
type EvalsService struct{ c *Client }

func (c *Client) eval(e *generated.EvalRun, scorers map[string]ScorerFunc) *Eval {
	return &Eval{EvalRun: *e, c: c, scorers: scorers}
}

// Plan estimates tasks, model and judge calls and cost without running anything.
func (s *EvalsService) Plan(ctx context.Context, p EvalParams) (*EvalPlan, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	req, _, err := p.wire()
	if err != nil {
		return nil, err
	}
	return api.PlanEval(ctx, req)
}

// EvalHandle is a submitted eval. Call Wait to block until it finishes.
type EvalHandle struct {
	eval *Eval
	err  error
}

// Result returns the eval as created (or the error that prevented it).
func (h *EvalHandle) Result() (*Eval, error) { return h.eval, h.err }

// Wait blocks until the eval finishes, running local scorers when it awaits scores.
func (h *EvalHandle) Wait(ctx context.Context, opts ...WaitOption) (*Eval, error) {
	if h.err != nil {
		return nil, h.err
	}
	return h.eval, h.eval.Wait(ctx, opts...)
}

// Create starts an eval: client.Evals.Create(ctx, params).Wait(ctx).
func (s *EvalsService) Create(ctx context.Context, p EvalParams) *EvalHandle {
	api, err := s.c.api()
	if err != nil {
		return &EvalHandle{err: err}
	}
	req, local, err := p.wire()
	if err != nil {
		return &EvalHandle{err: err}
	}
	e, err := api.CreateEval(ctx, req, idempotency(p.IdempotencyKey)...)
	if err != nil {
		return &EvalHandle{err: err}
	}
	return &EvalHandle{eval: s.c.eval(e, local)}
}

// Get fetches an eval.
func (s *EvalsService) Get(ctx context.Context, id string) (*Eval, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	e, err := api.GetEval(ctx, id)
	if err != nil {
		return nil, err
	}
	return s.c.eval(e, nil), nil
}

// EvalListOptions filters Evals.List; the zero value lists every eval.
type EvalListOptions struct {
	// Status keeps evals in these statuses.
	Status []EvalStatus
}

// List iterates over evals, newest first.
func (s *EvalsService) List(ctx context.Context, o EvalListOptions) iter.Seq2[*Eval, error] {
	return paginate(ctx, func(ctx context.Context, cursor *string) ([]*Eval, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		page, err := api.ListEvals(ctx, &generated.ListEvalsParams{Cursor: cursor, Status: statusQuery(o.Status)})
		if err != nil {
			return nil, nil, err
		}
		out := make([]*Eval, len(page.Data))
		for i := range page.Data {
			out[i] = s.c.eval(&page.Data[i], nil)
		}
		return out, page.NextCursor, nil
	})
}

// Cancel stops an eval.
func (s *EvalsService) Cancel(ctx context.Context, id string) (*Eval, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	e, err := api.CancelEval(ctx, id)
	if err != nil {
		return nil, err
	}
	return s.c.eval(e, nil), nil
}

// Wait fetches an eval and waits for it (pass WithRubric for its local scorers).
func (s *EvalsService) Wait(ctx context.Context, id string, opts ...WaitOption) (*Eval, error) {
	e, err := s.Get(ctx, id)
	if err != nil {
		return nil, err
	}
	return e, e.Wait(ctx, opts...)
}

// FailureOptions filters failing tasks.
type FailureOptions struct {
	Model string
	// Threshold defaults to the eval's pass threshold.
	Threshold *float64
}

// Results iterates over every task's outcome (each model's output and scores); a non-empty
// model keeps one model's.
func (s *EvalsService) Results(ctx context.Context, id, model string) iter.Seq2[EvalTaskOutcome, error] {
	return paginate(ctx, func(ctx context.Context, cursor *string) ([]EvalTaskOutcome, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		page, err := api.ListEvalResults(ctx, id, &generated.ListEvalResultsParams{Cursor: cursor, Model: optString(model)})
		if err != nil {
			return nil, nil, err
		}
		return page.Data, page.NextCursor, nil
	})
}

// Outputs iterates over the eval's generated outputs; a non-empty model keeps one model's.
func (s *EvalsService) Outputs(ctx context.Context, id, model string) iter.Seq2[EvalOutput, error] {
	return paginate(ctx, func(ctx context.Context, cursor *string) ([]EvalOutput, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		page, err := api.ListEvalOutputs(ctx, id, &generated.ListEvalOutputsParams{Cursor: cursor, Model: optString(model)})
		if err != nil {
			return nil, nil, err
		}
		return page.Data, page.NextCursor, nil
	})
}

// Results iterates over this eval's task outcomes; see EvalsService.Results.
func (e *Eval) Results(ctx context.Context, model string) iter.Seq2[EvalTaskOutcome, error] {
	return e.c.Evals.Results(ctx, e.ID, model)
}

// Outputs iterates over this eval's generated outputs; see EvalsService.Outputs.
func (e *Eval) Outputs(ctx context.Context, model string) iter.Seq2[EvalOutput, error] {
	return e.c.Evals.Outputs(ctx, e.ID, model)
}

// EvalFailures are tasks scoring below the threshold; turn them into training data with ToDataset.
type EvalFailures struct {
	EvalID   string
	Outcomes []EvalTaskOutcome
	c        *Client
}

// Failures returns every failing task of an eval.
func (s *EvalsService) Failures(ctx context.Context, id string, o FailureOptions) (*EvalFailures, error) {
	outcomes, err := Collect(paginate(ctx, func(ctx context.Context, cursor *string) ([]EvalTaskOutcome, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		page, err := api.ListEvalFailures(ctx, id, &generated.ListEvalFailuresParams{Cursor: cursor, Model: optString(o.Model), Threshold: o.Threshold})
		if err != nil {
			return nil, nil, err
		}
		return page.Data, page.NextCursor, nil
	}))
	if err != nil {
		return nil, err
	}
	return &EvalFailures{EvalID: id, Outcomes: outcomes, c: s.c}, nil
}

// ToDataset pushes the failing tasks' records into a dataset (created if needed).
func (f *EvalFailures) ToDataset(ctx context.Context, name string) (*Dataset, error) {
	if len(f.Outcomes) == 0 {
		return nil, newError("no_failures", "eval %s has no failing tasks to save", f.EvalID)
	}
	records := make([]Trajectory, len(f.Outcomes))
	for i, o := range f.Outcomes {
		records[i] = o.Record
	}
	return f.c.Datasets.Push(ctx, name, records)
}

// Failures returns this eval's failing tasks.
func (e *Eval) Failures(ctx context.Context, o FailureOptions) (*EvalFailures, error) {
	return e.c.Evals.Failures(ctx, e.ID, o)
}

// Refresh reloads the eval.
func (e *Eval) Refresh(ctx context.Context) error {
	fresh, err := e.c.Evals.Get(ctx, e.ID)
	if err != nil {
		return err
	}
	e.EvalRun = fresh.EvalRun
	return nil
}

// Wait polls until the eval completes. While it is awaiting_scores it runs the
// rubric's local Go scorers on the outputs that lack them and posts the scores.
// failed and cancelled return *EvalFailedError.
func (e *Eval) Wait(ctx context.Context, opts ...WaitOption) error {
	w := newWaitConfig(opts)
	if w.rubric != nil {
		_, local, err := w.rubric.wire()
		if err != nil {
			return err
		}
		if e.scorers == nil {
			e.scorers = map[string]ScorerFunc{}
		}
		for k, v := range local {
			e.scorers[k] = v
		}
	}
	err := e.c.poll(ctx, w, "eval "+e.ID, func(ctx context.Context) (string, bool, error) {
		api, err := e.c.api()
		if err != nil {
			return "", false, err
		}
		fresh, err := api.GetEval(ctx, e.ID)
		if err != nil {
			return "", false, err
		}
		e.EvalRun = *fresh
		switch e.Status {
		case generated.EvalStatusCompleted:
			return string(e.Status), true, nil
		case generated.EvalStatusFailed, generated.EvalStatusCancelled:
			return string(e.Status), true, nil
		case generated.EvalStatusAwaitingScores:
			if err := e.scoreLocally(ctx, api); err != nil {
				return string(e.Status), false, err
			}
		}
		return string(e.Status), false, nil
	})
	if err != nil {
		return err
	}
	if e.Status != generated.EvalStatusCompleted {
		msg := deref(e.Error)
		if msg == "" {
			msg = "no error reported"
		}
		return &EvalFailedError{GradError: newError("eval_"+string(e.Status), "eval %s (%s) ended %s: %s", e.ID, e.Name, e.Status, msg), Eval: e}
	}
	return nil
}

func (e *Eval) scoreLocally(ctx context.Context, api *generated.Client) error {
	var missing []string
	for _, name := range e.LocalScorers {
		if e.scorers[name] == nil {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		return newError("local_scorer_missing", "eval %s is waiting for local scores from %s; pass the same Rubric (grad.WithRubric) so Wait can run them", e.ID, strings.Join(missing, ", "))
	}
	for _, name := range e.LocalScorers {
		fn := e.scorers[name]
		lastFirst := ""
		for {
			page, err := api.ListEvalOutputs(ctx, e.ID, &generated.ListEvalOutputsParams{MissingScorer: &name, Limit: ptr(generated.ListEvalOutputsLimitMax)})
			if err != nil {
				return err
			}
			if len(page.Data) == 0 {
				break
			}
			if page.Data[0].ID == lastFirst {
				return newError("scores_not_accepted", "eval %s still lists output %s as unscored by %s after posting its score", e.ID, lastFirst, name)
			}
			lastFirst = page.Data[0].ID
			scores := make([]generated.PostEvalScoresRequestScoresItem, 0, len(page.Data))
			for _, out := range page.Data {
				v, err := fn(ctx, ScoreInput{OutputID: out.ID, TaskID: out.TaskID, Model: out.Model, SampleIndex: out.SampleIndex, Input: out.Input,
					Output: deref(out.Output), Expected: out.ExpectedOutput, Record: out.Record})
				if err != nil {
					return fmt.Errorf("grad: local scorer %q failed on output %s: %w", name, out.ID, err)
				}
				if math.IsNaN(v) || v < 0 || v > 1 {
					return newError("invalid_score", "local scorer %q returned %v for output %s; scores must be in [0, 1]", name, v, out.ID)
				}
				scores = append(scores, generated.PostEvalScoresRequestScoresItem{OutputID: out.ID, Scorer: name, Score: v})
			}
			if _, err := api.PostEvalScores(ctx, e.ID, &generated.PostEvalScoresRequest{Scores: scores}); err != nil {
				return err
			}
		}
	}
	return nil
}

// SummaryTable renders the per-model summary as an aligned text table.
func (e *Eval) SummaryTable() string {
	var b strings.Builder
	tw := tabwriter.NewWriter(&b, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "MODEL\tOVERALL\t95% CI\tPASS@K\tVS BASELINE\tTASKS\tERRORS\tCOST/1K TASKS")
	for _, s := range e.Summary {
		pass := make([]string, 0, len(s.PassAtK))
		for k := 1; k <= len(s.PassAtK)+1; k++ {
			if v, ok := s.PassAtK[fmt.Sprintf("pass@%d", k)]; ok {
				pass = append(pass, fmt.Sprintf("@%d=%.3f", k, v))
			}
		}
		vs := "-"
		if s.VsBaseline != nil {
			vs = fmt.Sprintf("%+.3f [%+.3f, %+.3f]", s.VsBaseline.Delta, s.VsBaseline.CILow, s.VsBaseline.CIHigh)
		}
		cost := "-"
		if s.CostPer1kTasksUSD != nil {
			cost = fmt.Sprintf("$%.4f", *s.CostPer1kTasksUSD)
		}
		fmt.Fprintf(tw, "%s\t%.3f\t[%.3f, %.3f]\t%s\t%s\t%d\t%d\t%s\n", s.Model, s.Overall, s.CILow, s.CIHigh, strings.Join(pass, " "), vs, s.Tasks, s.Errors, cost)
	}
	tw.Flush()
	return b.String()
}
