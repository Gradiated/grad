package grad

import (
	"context"
	"iter"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// UsageRecord is one billed increment of a run or eval attempt.
type UsageRecord = generated.UsageRecord

// UsageService lists billed usage.
type UsageService struct{ c *Client }

// UsageOption configures UsageService.List.
type UsageOption func(*generated.ListUsageParams)

// WithUsagePageSize sets how many records each page fetches.
func WithUsagePageSize(n int) UsageOption {
	return func(p *generated.ListUsageParams) { p.Limit = optInt(n) }
}

// List iterates over usage records, newest first, fetching pages as needed.
func (s *UsageService) List(ctx context.Context, opts ...UsageOption) iter.Seq2[*UsageRecord, error] {
	return paginate(ctx, func(ctx context.Context, cursor *string) ([]*UsageRecord, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		params := &generated.ListUsageParams{Cursor: cursor}
		for _, opt := range opts {
			opt(params)
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
