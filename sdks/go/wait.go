package grad

import (
	"context"
	"time"
)

type waitConfig struct {
	timeout     time.Duration
	minInterval time.Duration
	maxInterval time.Duration
	onStatus    func(status string)
	onMetric    func(MetricPoint)
	rubric      Rubric
}

// WaitOption configures Wait on runs, imports and evals.
type WaitOption func(*waitConfig)

// WithWaitTimeout gives up with *WaitTimeoutError after d (the ctx deadline applies too).
func WithWaitTimeout(d time.Duration) WaitOption { return func(w *waitConfig) { w.timeout = d } }

// WithPollInterval sets the polling backoff bounds (default 500 ms growing to 5 s).
func WithPollInterval(min, max time.Duration) WaitOption {
	return func(w *waitConfig) { w.minInterval, w.maxInterval = min, max }
}

// WithOnStatus is called whenever the observed status changes.
func WithOnStatus(fn func(status string)) WaitOption { return func(w *waitConfig) { w.onStatus = fn } }

// WithOnMetric is called with each new training metric while a run is waited on.
func WithOnMetric(fn func(MetricPoint)) WaitOption { return func(w *waitConfig) { w.onMetric = fn } }

// WithRubric supplies the local scorers an eval needs when it was not created by this handle.
func WithRubric(r Rubric) WaitOption { return func(w *waitConfig) { w.rubric = r } }

func newWaitConfig(opts []WaitOption) *waitConfig {
	w := &waitConfig{minInterval: 500 * time.Millisecond, maxInterval: 5 * time.Second}
	for _, opt := range opts {
		if opt != nil {
			opt(w)
		}
	}
	if w.minInterval <= 0 {
		w.minInterval = 500 * time.Millisecond
	}
	if w.maxInterval < w.minInterval {
		w.maxInterval = w.minInterval
	}
	return w
}

// poll calls step until it reports done, backing off between calls and tolerating
// transient errors (connection failures, timeouts, 408/429/5xx). step returns the
// current status for callbacks and timeout messages.
func (c *Client) poll(ctx context.Context, w *waitConfig, what string, step func(ctx context.Context) (status string, done bool, err error)) error {
	var deadline time.Time
	if w.timeout > 0 {
		deadline = c.now().Add(w.timeout)
	}
	interval := w.minInterval
	last := ""
	for {
		status, done, err := step(ctx)
		if err != nil {
			if !isTransient(err) || ctx.Err() != nil {
				return err
			}
		} else {
			if status != last && w.onStatus != nil {
				w.onStatus(status)
			}
			last = status
			if done {
				return nil
			}
		}
		delay := interval
		if hint := retryDelay(err); hint > delay {
			delay = hint
		}
		if !deadline.IsZero() {
			remaining := deadline.Sub(c.now())
			if remaining <= 0 {
				return &WaitTimeoutError{GradError: newError("wait_timeout", "timed out after %s waiting for %s (last status %q)", w.timeout, what, last), LastStatus: last}
			}
			if delay > remaining {
				delay = remaining
			}
		}
		if serr := c.sleep(ctx, delay); serr != nil {
			return &GradError{Code: "aborted", Message: "grad: stopped waiting for " + what + ": " + serr.Error(), Cause: serr}
		}
		interval = time.Duration(float64(interval) * 1.5)
		if interval > w.maxInterval {
			interval = w.maxInterval
		}
	}
}
