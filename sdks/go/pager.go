package grad

import (
	"context"
	"fmt"
	"iter"
)

// ErrPaginationLoop is returned when a server hands back a cursor it already
// returned earlier in the same listing; following it would never terminate.
var ErrPaginationLoop = fmt.Errorf("grad: pagination loop: server repeated a cursor")

// paginate turns a cursor-paged endpoint into an iterator. Iteration stops at the
// first error (yielded once), when the server returns no next cursor, or with
// ErrPaginationLoop when a cursor repeats.
func paginate[T any](ctx context.Context, fetch func(ctx context.Context, cursor *string) ([]T, *string, error)) iter.Seq2[T, error] {
	return func(yield func(T, error) bool) {
		var cursor *string
		seen := map[string]struct{}{}
		for {
			if err := ctx.Err(); err != nil {
				var zero T
				yield(zero, err)
				return
			}
			items, next, err := fetch(ctx, cursor)
			if err != nil {
				var zero T
				yield(zero, err)
				return
			}
			for _, item := range items {
				if !yield(item, nil) {
					return
				}
			}
			if next == nil || *next == "" || len(items) == 0 {
				return
			}
			if _, dup := seen[*next]; dup {
				var zero T
				yield(zero, fmt.Errorf("%w %q", ErrPaginationLoop, *next))
				return
			}
			seen[*next] = struct{}{}
			cursor = next
		}
	}
}

// Collect drains an iterator from List/Records into a slice, stopping at the first error.
func Collect[T any](seq iter.Seq2[T, error]) ([]T, error) {
	var out []T
	for item, err := range seq {
		if err != nil {
			return out, err
		}
		out = append(out, item)
	}
	return out, nil
}

func pointers[T any](items []T) []*T {
	out := make([]*T, len(items))
	for i := range items {
		out[i] = &items[i]
	}
	return out
}
