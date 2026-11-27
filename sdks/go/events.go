package grad

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"iter"
	"time"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// Run lifecycle event types (re-exported wire types).
type (
	// RunEvent is one lifecycle event of a run: switch on Type. Every event has
	// RunID, Seq, Attempt and Timestamp; the other fields belong to its type
	// (Phase/WorkersOnline/Autoscaling/GPU on phase, Metric on metric,
	// CheckpointID/EvalScore/Format on checkpoint, Event/Reason/ResumeStep/
	// MaxAttempts/Message on attempt, Message on warning and log, Status/Run on
	// completed).
	RunEvent = generated.RunEvent
	// RunEventType discriminates a RunEvent.
	RunEventType = generated.RunEventType
	// RunPhase is where a run is in its lifecycle.
	RunPhase = generated.RunPhase
	// InterruptionReason says why an attempt ended without a result.
	InterruptionReason = generated.InterruptionReason
	// RunInterruption is a run's latest interruption (Run.LastInterruption).
	RunInterruption = generated.RunInterruption
)

// Event types.
const (
	EventPhase      = generated.RunEventTypePhase
	EventMetric     = generated.RunEventTypeMetric
	EventCheckpoint = generated.RunEventTypeCheckpoint
	EventAttempt    = generated.RunEventTypeAttempt
	EventWarning    = generated.RunEventTypeWarning
	EventLog        = generated.RunEventTypeLog
	EventCompleted  = generated.RunEventTypeCompleted
)

// EventsOptions configures Run.Events.
type EventsOptions struct {
	// Follow streams live over Server-Sent Events until the run finishes.
	Follow bool
	// Limit is the JSON page size without Follow (0 = the server default).
	Limit int
}

var eventTypes = map[string]bool{
	string(EventPhase): true, string(EventMetric): true, string(EventCheckpoint): true, string(EventAttempt): true,
	string(EventWarning): true, string(EventLog): true, string(EventCompleted): true,
}

// Events iterates over a run's events; see Run.Events.
func (s *RunsService) Events(ctx context.Context, id string, opts EventsOptions) iter.Seq2[RunEvent, error] {
	r := &Run{c: s.c}
	r.ID = id
	return r.Events(ctx, opts)
}

// Events iterates over the run's lifecycle events (phase, metric, checkpoint,
// attempt, warning, log, completed). With Follow it streams live over
// Server-Sent Events, reconnects with Last-Event-ID after a dropped connection
// (never repeating an event) and ends after the completed event, which also
// refreshes the run; without Follow it pages through the events recorded so far.
//
//	for ev, err := range run.Events(ctx, grad.EventsOptions{Follow: true}) {
//		if err != nil { return err }
//		switch ev.Type {
//		case grad.EventPhase: fmt.Println(*ev.Phase)
//		case grad.EventAttempt: fmt.Println(*ev.Message)
//		}
//	}
func (r *Run) Events(ctx context.Context, opts EventsOptions) iter.Seq2[RunEvent, error] {
	if !opts.Follow {
		pages := paginate(ctx, func(ctx context.Context, cursor *string) ([]RunEvent, *string, error) {
			api, err := r.c.api()
			if err != nil {
				return nil, nil, err
			}
			params := &generated.ListRunEventsParams{Cursor: cursor}
			if opts.Limit > 0 {
				params.Limit = ptr(opts.Limit)
			}
			page, err := api.ListRunEvents(ctx, r.ID, params)
			if err != nil {
				return nil, nil, err
			}
			return page.Data, page.NextCursor, nil
		})
		return func(yield func(RunEvent, error) bool) {
			for ev, err := range pages {
				if err == nil {
					r.observe(ev)
				}
				if !yield(ev, err) || err != nil {
					return
				}
			}
		}
	}
	return func(yield func(RunEvent, error) bool) {
		lastID := ""
		lastSeq := 0
		failures := 0
		delay := 500 * time.Millisecond
		for {
			api, err := r.c.api()
			if err != nil {
				yield(RunEvent{}, err)
				return
			}
			var ropts []generated.RequestOption
			if lastID != "" {
				ropts = append(ropts, generated.WithLastEventID(lastID))
			}
			stream, err := api.ListRunEventsStream(ctx, r.ID, nil, ropts...)
			if err == nil {
				for stream.Next() {
					sse := stream.Event()
					failures, delay = 0, 500*time.Millisecond
					if !eventTypes[sse.Event] {
						continue
					}
					var ev RunEvent
					if derr := json.Unmarshal([]byte(sse.Data), &ev); derr != nil {
						stream.Close()
						yield(RunEvent{}, &DecodeError{GradError: &GradError{Code: "invalid_json", Message: "grad: run event is not valid JSON: " + derr.Error(), Cause: derr}})
						return
					}
					if ev.Type != EventCompleted {
						if sse.ID != "" {
							lastID = sse.ID
						}
						if ev.Seq <= lastSeq {
							continue
						}
						lastSeq = ev.Seq
					}
					r.observe(ev)
					if !yield(ev, nil) || ev.Type == EventCompleted {
						stream.Close()
						return
					}
				}
				err = stream.Err()
				stream.Close()
				if err == nil {
					err = &ConnectionError{GradError: &GradError{Code: "connection_error", Message: "grad: the events stream closed before the run finished", Cause: io.ErrUnexpectedEOF}}
				}
			}
			if ctx.Err() != nil {
				yield(RunEvent{}, &GradError{Code: "aborted", Message: "grad: events stream cancelled: " + ctx.Err().Error(), Cause: ctx.Err()})
				return
			}
			failures++
			if !isTransient(err) || failures > 10 {
				yield(RunEvent{}, err)
				return
			}
			if serr := r.c.sleep(ctx, delay); serr != nil {
				yield(RunEvent{}, &GradError{Code: "aborted", Message: "grad: events stream cancelled: " + serr.Error(), Cause: serr})
				return
			}
			delay *= 2
			if delay > 5*time.Second {
				delay = 5 * time.Second
			}
		}
	}
}

// observe keeps the run's phase, status and last interruption in step with its events.
func (r *Run) observe(ev RunEvent) {
	switch ev.Type {
	case EventCompleted:
		if ev.Run != nil && ev.Run.ID != "" {
			art := r.Artifact
			r.Run = *ev.Run
			r.Artifact = art
		}
	case EventPhase:
		if ev.Phase == nil {
			return
		}
		phase := generated.RunPhaseType(*ev.Phase)
		since := ev.Timestamp
		r.Phase, r.PhaseSince = &phase, &since
		if !IsTerminal(r.Status) {
			if *ev.Phase == generated.RunPhaseQueued || *ev.Phase == generated.RunPhaseWaitingForCompute {
				r.Status = RunQueued
			} else {
				r.Status = RunRunning
			}
		}
	case EventAttempt:
		if ev.Event != nil && *ev.Event == generated.RunEventEventInterrupted && ev.Reason != nil {
			r.LastInterruption = &RunInterruption{
				Attempt: ev.Attempt, Reason: *ev.Reason, Step: derefInt(ev.Step), ResumeStep: ev.ResumeStep,
				At: ev.Timestamp, Message: deref(ev.Message),
			}
		}
	}
}

func derefInt(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

// statusKey is what WithOnStatus watches: the status and the phase.
func (r *Run) statusKey() string {
	if r.Phase == nil {
		return string(r.Status)
	}
	return string(r.Status) + "/" + string(*r.Phase)
}

// followEvents waits on the event stream (WithOnEvent), calling the callbacks.
func (r *Run) followEvents(ctx context.Context, w *waitConfig) error {
	wctx := ctx
	if w.timeout > 0 {
		var cancel context.CancelFunc
		wctx, cancel = context.WithTimeout(ctx, w.timeout)
		defer cancel()
	}
	last := ""
	notify := func() {
		if key := r.statusKey(); key != last {
			last = key
			if w.onStatus != nil {
				w.onStatus(string(r.Status))
			}
		}
	}
	notify()
	for ev, err := range r.Events(wctx, EventsOptions{Follow: true}) {
		if err != nil {
			if errors.Is(wctx.Err(), context.DeadlineExceeded) && ctx.Err() == nil {
				return &WaitTimeoutError{GradError: newError("wait_timeout", "timed out after %s waiting for run %s (last status %q)", w.timeout, r.ID, r.Status), LastStatus: string(r.Status)}
			}
			return err
		}
		w.onEvent(ev)
		if ev.Type == EventMetric && ev.Metric != nil && w.onMetric != nil {
			w.onMetric(*ev.Metric)
		}
		notify()
	}
	return nil
}
