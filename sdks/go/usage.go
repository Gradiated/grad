package grad

import (
	"context"
	"iter"
	"time"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// UsageRecord is one billed increment of a run or eval attempt. Kind is what
// the tokens paid for; RunID is the run billed (the run itself, or the run
// whose labeling, teacher or checkpoint eval it is).
type UsageRecord = generated.UsageRecord

// UsageSummary is billed usage over [From, To): totals, by kind, the top runs
// and evals, and the groups asked for with WithUsageGroupBy.
type UsageSummary = generated.UsageSummary

// UsageKind is what billed tokens paid for.
type UsageKind = generated.UsageKind

// Usage kinds.
const (
	UsageTraining = generated.UsageKindTraining
	UsageEval     = generated.UsageKindEval
	UsageScoring  = generated.UsageKindScoring
	UsageLabeling = generated.UsageKindLabeling
	UsageTeacher  = generated.UsageKindTeacher
)

// UsageGroupBy groups a usage summary.
type UsageGroupBy = generated.UsageGroupBy

// Usage summary groupings.
const (
	UsageByDay    = generated.UsageGroupByDay
	UsageByWeek   = generated.UsageGroupByWeek
	UsageByMonth  = generated.UsageGroupByMonth
	UsageByModel  = generated.UsageGroupByModel
	UsageByRecipe = generated.UsageGroupByRecipe
	UsageByKind   = generated.UsageGroupByKind
)

// UsageBound is a period bound, in UTC: a string ("2026-11-01", which as an
// end covers that whole day, or an ISO 8601 timestamp) or a time.Time (an
// instant; exclusive as an end).
type UsageBound interface{ string | time.Time }

func boundString[T UsageBound](v T) *string {
	switch b := any(v).(type) {
	case time.Time:
		return ptr(b.UTC().Format(time.RFC3339Nano))
	case string:
		return optString(b)
	}
	return nil
}

// UsageService reports billed usage.
type UsageService struct{ c *Client }

type usageOptions struct {
	from, to, runID, evalID *string
	kind                    *UsageKind
	groupBy                 *UsageGroupBy
	limit                   *int
}

// UsageOption configures UsageService.List and UsageService.Summary.
type UsageOption func(*usageOptions)

// WithUsageFrom starts the period at v (inclusive).
func WithUsageFrom[T UsageBound](v T) UsageOption {
	return func(o *usageOptions) { o.from = boundString(v) }
}

// WithUsageTo ends the period at v: a date covers that whole UTC day; a
// timestamp or time.Time is exclusive.
func WithUsageTo[T UsageBound](v T) UsageOption {
	return func(o *usageOptions) { o.to = boundString(v) }
}

// WithUsageRun lists a run's usage: its training and the evals it started
// (labeling, teacher answers, checkpoint evals). List only.
func WithUsageRun(runID string) UsageOption {
	return func(o *usageOptions) { o.runID = optString(runID) }
}

// WithUsageEval lists one eval's usage. List only.
func WithUsageEval(evalID string) UsageOption {
	return func(o *usageOptions) { o.evalID = optString(evalID) }
}

// WithUsageKind lists one kind of usage. List only.
func WithUsageKind(kind UsageKind) UsageOption {
	return func(o *usageOptions) { o.kind = &kind }
}

// WithUsageGroupBy adds groups to a summary. Summary only.
func WithUsageGroupBy(by UsageGroupBy) UsageOption {
	return func(o *usageOptions) { o.groupBy = &by }
}

// WithUsagePageSize sets how many records each page fetches. List only.
func WithUsagePageSize(n int) UsageOption {
	return func(o *usageOptions) { o.limit = optInt(n) }
}

func usageOpts(opts []UsageOption) usageOptions {
	var o usageOptions
	for _, opt := range opts {
		opt(&o)
	}
	return o
}

// Summary returns total cost and tokens, by kind, the top runs and evals, and
// optional groups over a period (default: the current UTC month).
func (s *UsageService) Summary(ctx context.Context, opts ...UsageOption) (*UsageSummary, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	o := usageOpts(opts)
	params := &generated.GetUsageSummaryParams{From: o.from, To: o.to}
	if o.groupBy != nil {
		params.GroupBy = ptr(generated.GetUsageSummaryParamsGroupBy(*o.groupBy))
	}
	return api.GetUsageSummary(ctx, params)
}

// List iterates over billed rows, newest first, fetching pages as needed.
func (s *UsageService) List(ctx context.Context, opts ...UsageOption) iter.Seq2[*UsageRecord, error] {
	o := usageOpts(opts)
	return paginate(ctx, func(ctx context.Context, cursor *string) ([]*UsageRecord, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		params := &generated.ListUsageParams{
			Cursor: cursor, Limit: o.limit, From: o.from, To: o.to, RunID: o.runID, EvalID: o.evalID,
		}
		if o.kind != nil {
			params.Kind = ptr(generated.ListUsageParamsKind(*o.kind))
		}
		page, err := api.ListUsage(ctx, params)
		if err != nil {
			return nil, nil, err
		}
		out := make([]*UsageRecord, len(page.Data))
		for i := range page.Data {
			out[i] = &page.Data[i]
		}
		return out, page.NextCursor, nil
	})
}
