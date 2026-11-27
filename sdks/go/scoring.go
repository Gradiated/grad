package grad

import (
	"context"
	"errors"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// ScoreOptions configures Dataset.Score; zero values use the server defaults.
type ScoreOptions struct {
	// Version to score (default: the current one).
	Version int
	// Name of the scoring job (default "<dataset>-score").
	Name  string
	Limit int
	// IdempotencyKey makes a retried Score return the job the first call created.
	IdempotencyKey string
}

// ScoringHandle is a submitted dataset.Score job (an eval in mode "score").
type ScoringHandle struct {
	eval *Eval
	err  error
}

// Result returns the scoring job as created (or the error that prevented it).
func (h *ScoringHandle) Result() (*Eval, error) { return h.eval, h.err }

// Wait blocks until the records are scored (running local scorers when asked)
// and returns the dataset; its version Eval.ScoredDatasetVersion carries the scores.
func (h *ScoringHandle) Wait(ctx context.Context, opts ...WaitOption) (*Dataset, error) {
	if h.err != nil {
		return nil, h.err
	}
	if err := h.eval.Wait(ctx, opts...); err != nil {
		return nil, err
	}
	return h.eval.c.Datasets.Get(ctx, h.eval.TaskSource.Dataset)
}

// Score grades the records' own answers with judges, validators or local
// scorers, server-side and billed like an eval. Records that already have
// every score are skipped.
func (s *DatasetsService) Score(ctx context.Context, name string, rubric Rubric, o ScoreOptions) *ScoringHandle {
	api, err := s.c.api()
	if err != nil {
		return &ScoringHandle{err: err}
	}
	items, local, err := rubric.wire()
	if err != nil {
		return &ScoringHandle{err: err}
	}
	if len(items) == 0 {
		return &ScoringHandle{err: errors.New("grad: Dataset.Score needs a Judge, Scorer, validator or Rubric")}
	}
	req := &generated.ScoreDatasetRequest{Rubric: items, Version: optInt(o.Version), Name: optString(o.Name), Limit: optInt(o.Limit)}
	e, err := api.ScoreDataset(ctx, name, req, idempotency(o.IdempotencyKey)...)
	if err != nil {
		return &ScoringHandle{err: err}
	}
	return &ScoringHandle{eval: s.c.eval(e, local)}
}

// FilterOptions are field filters, run on the server at no cost. Scores holds
// conditions such as {"resolved": ">=0.8"}; CreatedAfter/CreatedBefore apply to
// the record timestamp (RFC 3339 or a UTC date "2006-01-02").
type FilterOptions struct {
	Scores        map[string]string
	Metadata      map[string]any
	CreatedAfter  string
	CreatedBefore string
	IDs           []string
	// Version of the source (default: the current one).
	Version int
	// Name of the view (default "<dataset>-f-<hash>", the same for the same filter).
	Name string
}

func (o FilterOptions) wire() generated.FilterDatasetRequest {
	req := generated.FilterDatasetRequest{IDs: o.IDs, Version: optInt(o.Version), Name: optString(o.Name)}
	if len(o.Scores) > 0 {
		req.Scores = make(map[string]any, len(o.Scores))
		for k, v := range o.Scores {
			req.Scores[k] = v
		}
	}
	if len(o.Metadata) > 0 {
		req.Metadata = o.Metadata
	}
	if o.CreatedAfter != "" {
		req.CreatedAfter = o.CreatedAfter
	}
	if o.CreatedBefore != "" {
		req.CreatedBefore = o.CreatedBefore
	}
	return req
}

// idsFilter sends "ids" even when empty (a local filter that matched nothing).
type idsFilter struct {
	generated.FilterDatasetRequest
	IDs []string `json:"ids"`
}

// Filter saves the matching records as a view and returns it. The same filter
// on the same version returns the same view.
func (s *DatasetsService) Filter(ctx context.Context, name string, o FilterOptions) (*Dataset, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	req := o.wire()
	d, err := api.FilterDataset(ctx, name, &req)
	if err != nil {
		return nil, err
	}
	return s.c.dataset(d), nil
}

// FilterFunc runs keep over the records here (they stream once) and saves the
// matching ids as a server-side view. Only Version and Name of o apply.
func (s *DatasetsService) FilterFunc(ctx context.Context, name string, keep func(Trajectory) bool, o FilterOptions) (*Dataset, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	version := o.Version
	if version == 0 {
		d, err := s.Get(ctx, name)
		if err != nil {
			return nil, err
		}
		version = d.Version
	}
	ids := make([]string, 0)
	for rec, err := range s.Records(ctx, name, AtVersion(version)) {
		if err != nil {
			return nil, err
		}
		if rec.ID != nil && keep(rec) {
			ids = append(ids, *rec.ID)
		}
	}
	body := idsFilter{FilterDatasetRequest: generated.FilterDatasetRequest{Version: optInt(version), Name: optString(o.Name)}, IDs: ids}
	path, err := generated.EscapePathParam("name", name)
	if err != nil {
		return nil, err
	}
	var out generated.Dataset
	spec := generated.RequestSpec{Method: "POST", Path: "/v1/datasets/" + path + "/filter", Body: body, Idempotent: true}
	if err := api.T.DoJSON(ctx, spec, &out); err != nil {
		return nil, err
	}
	return s.c.dataset(&out), nil
}

// Score grades this dataset's records (see DatasetsService.Score).
func (d *Dataset) Score(ctx context.Context, rubric Rubric, o ScoreOptions) *ScoringHandle {
	return d.c.Datasets.Score(ctx, d.Name, rubric, o)
}

// Filter saves a filtered view of this dataset (see DatasetsService.Filter).
func (d *Dataset) Filter(ctx context.Context, o FilterOptions) (*Dataset, error) {
	return d.c.Datasets.Filter(ctx, d.Name, o)
}

// FilterFunc saves the records keep selects as a view (see DatasetsService.FilterFunc).
func (d *Dataset) FilterFunc(ctx context.Context, keep func(Trajectory) bool, o FilterOptions) (*Dataset, error) {
	return d.c.Datasets.FilterFunc(ctx, d.Name, keep, o)
}
