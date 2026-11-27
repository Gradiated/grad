package grad_test

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"testing"
	"time"

	grad "github.com/Gradiated/grad/sdks/go"
)

type eventsFixture struct {
	RunID string            `json:"run_id"`
	Data  []json.RawMessage `json:"data"`
}

func loadEvents(t *testing.T) (eventsFixture, []string) {
	t.Helper()
	var page eventsFixture
	if err := json.Unmarshal(wire(t, "run-events-page.json"), &page); err != nil {
		t.Fatal(err)
	}
	blocks := strings.Split(strings.TrimSpace(string(wire(t, "run-events.sse"))), "\n\n")
	if len(blocks) != len(page.Data) {
		t.Fatalf("fixture: %d SSE blocks, %d page events", len(blocks), len(page.Data))
	}
	return page, blocks
}

func sseRoute(t *testing.T, chunks ...[]string) (route, *[]string) {
	var lastIDs []string
	n := 0
	return func(w http.ResponseWriter, r *http.Request, _ []byte) {
		if r.Header.Get("Accept") != "text/event-stream" {
			t.Errorf("accept %q", r.Header.Get("Accept"))
		}
		lastIDs = append(lastIDs, r.Header.Get("Last-Event-ID"))
		chunk := chunks[min(n, len(chunks)-1)]
		n++
		if chunk == nil {
			problem(503, "unavailable")(w, r, nil)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte(strings.Join(chunk, "\n\n") + "\n\n"))
	}, &lastIDs
}

func TestEventsFollowReconnectsWithoutRepeats(t *testing.T) {
	ctx := context.Background()
	page, blocks := loadEvents(t)
	// Drop after 8 events, fail once, then replay event 8 again (a proxy re-send) before the rest.
	events, lastIDs := sseRoute(t, blocks[:8], nil, append([]string{"event: future\ndata: {}"}, blocks[7:]...))
	f := newFake(t, map[string]route{"GET /v1/runs/" + page.RunID + "/events": events})
	c, clk := f.client(grad.WithMaxRetries(0))
	var types []string
	var got []grad.RunEvent
	for ev, err := range c.Runs.Events(ctx, page.RunID, grad.EventsOptions{Follow: true}) {
		if err != nil {
			t.Fatal(err)
		}
		types = append(types, string(ev.Type))
		got = append(got, ev)
	}
	if len(got) != len(page.Data) || types[0] != "phase" || types[len(types)-1] != "completed" {
		t.Fatalf("events %v", types)
	}
	seen := map[int]bool{}
	for _, ev := range got[:len(got)-1] {
		if seen[ev.Seq] {
			t.Fatalf("repeated seq %d", ev.Seq)
		}
		seen[ev.Seq] = true
	}
	if fmt.Sprint(*lastIDs) != fmt.Sprintf("[ %d %d]", got[7].Seq, got[7].Seq) {
		t.Fatalf("Last-Event-ID per connection %v", *lastIDs)
	}
	if len(clk.Sleeps()) != 2 {
		t.Fatalf("sleeps %v", clk.Sleeps())
	}
	waiting, starting := got[2], got[4]
	if *waiting.Phase != grad.RunPhase("waiting_for_compute") || *waiting.WorkersOnline != 0 || starting.GPU.Name != "NVIDIA H100 80GB HBM3" || got[0].RunID != page.RunID {
		t.Fatalf("phases %+v %+v", waiting, starting)
	}
	if got[12].Type != grad.EventAttempt || *got[12].Reason != "compute_reclaimed" || *got[12].ResumeStep != 2 {
		t.Fatalf("interruption %+v", got[12])
	}

	// Breaking out early stops cleanly.
	count := 0
	for _, err := range c.Runs.Events(ctx, page.RunID, grad.EventsOptions{Follow: true}) {
		if err != nil {
			t.Fatal(err)
		}
		count++
		break
	}
	if count != 1 {
		t.Fatal("early break")
	}
}

func TestEventsPagesWithoutFollow(t *testing.T) {
	ctx := context.Background()
	page, _ := loadEvents(t)
	half := len(page.Data) / 2
	path := "/v1/runs/" + page.RunID + "/events"
	f := newFake(t, map[string]route{"GET " + path: func(w http.ResponseWriter, r *http.Request, b []byte) {
		if r.URL.Query().Get("cursor") == "" {
			jsonValue(200, map[string]any{"run_id": page.RunID, "status": "completed", "data": page.Data[:half], "next_cursor": "c2", "tail_cursor": "c2"})(w, r, b)
			return
		}
		jsonValue(200, map[string]any{"run_id": page.RunID, "status": "completed", "data": page.Data[half:], "next_cursor": nil, "tail_cursor": "c3"})(w, r, b)
	}})
	c, _ := f.client()
	n := 0
	var last grad.RunEvent
	for ev, err := range c.Runs.Events(ctx, page.RunID, grad.EventsOptions{Limit: 7}) {
		if err != nil {
			t.Fatal(err)
		}
		n++
		last = ev
	}
	if n != len(page.Data) || last.Type != grad.EventCompleted || *last.Status != "completed" {
		t.Fatalf("paged %d events, last %+v", n, last)
	}
	if q := f.requests()[0].Query; q != "limit=7" {
		t.Fatalf("query %q", q)
	}

	bad := newFake(t, map[string]route{"GET " + path: problem(404, "run_not_found")})
	bc, _ := bad.client()
	for _, err := range bc.Runs.Events(ctx, page.RunID, grad.EventsOptions{Follow: true}) {
		var nf *grad.NotFoundError
		if !errors.As(err, &nf) {
			t.Fatalf("want NotFoundError, got %v", err)
		}
	}
	garbled := newFake(t, map[string]route{"GET " + path: func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = w.Write([]byte("event: phase\ndata: {nope\n\n"))
	}})
	gc, _ := garbled.client()
	for _, err := range gc.Runs.Events(ctx, page.RunID, grad.EventsOptions{Follow: true}) {
		var de *grad.DecodeError
		if !errors.As(err, &de) {
			t.Fatalf("want DecodeError, got %v", err)
		}
	}
}

func TestWaitOnEventsCallsBack(t *testing.T) {
	ctx := context.Background()
	page, blocks := loadEvents(t)
	var final map[string]any
	if err := json.Unmarshal(page.Data[len(page.Data)-1], &final); err != nil {
		t.Fatal(err)
	}
	finalRun := final["run"].(map[string]any)
	queued := map[string]any{}
	for k, v := range finalRun {
		queued[k] = v
	}
	queued["status"], queued["phase"], queued["artifact_id"] = "queued", "queued", nil
	artifact := wireMap(t, "artifact.json")
	events, _ := sseRoute(t, blocks)
	f := newFake(t, map[string]route{
		"GET /v1/runs/" + page.RunID:                            jsonValue(200, queued),
		"GET /v1/runs/" + page.RunID + "/events":                events,
		"GET /v1/artifacts/" + finalRun["artifact_id"].(string): jsonValue(200, artifact),
	})
	c, _ := f.client()
	var types, statuses []string
	var steps []int
	run, err := c.Runs.Get(ctx, page.RunID)
	if err != nil {
		t.Fatal(err)
	}
	err = run.Wait(ctx,
		grad.WithOnEvent(func(ev grad.RunEvent) { types = append(types, string(ev.Type)) }),
		grad.WithOnMetric(func(m grad.MetricPoint) { steps = append(steps, m.Step) }),
		grad.WithOnStatus(func(s string) { statuses = append(statuses, s+"/"+string(*run.Phase)) }),
	)
	if err != nil {
		t.Fatal(err)
	}
	if len(types) != len(page.Data) || fmt.Sprint(steps) != "[1 2 3]" || run.Artifact == nil {
		t.Fatalf("types %v steps %v artifact %v", types, steps, run.Artifact)
	}
	joined := strings.Join(statuses, ",")
	if !strings.HasPrefix(joined, "queued/queued,queued/waiting_for_compute,running/starting") || !strings.HasSuffix(joined, "completed/completing") {
		t.Fatalf("statuses %s", joined)
	}
	if run.LastInterruption == nil || run.LastInterruption.Reason != "compute_reclaimed" {
		t.Fatalf("interruption %+v", run.LastInterruption)
	}

	// The wait timeout applies to the stream.
	hang := newFake(t, map[string]route{
		"GET /v1/runs/" + page.RunID: jsonValue(200, queued),
		"GET /v1/runs/" + page.RunID + "/events": func(w http.ResponseWriter, r *http.Request, _ []byte) {
			w.Header().Set("Content-Type", "text/event-stream")
			w.WriteHeader(200)
			w.(http.Flusher).Flush()
			<-r.Context().Done()
		},
	})
	hc, _ := hang.client()
	_, werr := hc.Runs.Wait(ctx, page.RunID, grad.WithOnEvent(func(grad.RunEvent) {}), grad.WithWaitTimeout(50*time.Millisecond))
	var timeout *grad.WaitTimeoutError
	if !errors.As(werr, &timeout) {
		t.Fatalf("want WaitTimeoutError, got %v", werr)
	}
}
