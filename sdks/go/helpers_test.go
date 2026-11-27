package grad_test

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	grad "github.com/Gradiated/grad/sdks/go"
)

// wire reads a shared fixture from tests/fixtures/wire.
func wire(t *testing.T, name string) []byte {
	t.Helper()
	raw, err := os.ReadFile(filepath.Join("..", "..", "tests", "fixtures", "wire", name))
	if err != nil {
		t.Fatalf("fixture %s: %v", name, err)
	}
	return raw
}

// wireMap decodes a JSON fixture into a map so tests can tweak fields.
func wireMap(t *testing.T, name string) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(wire(t, name), &m); err != nil {
		t.Fatal(err)
	}
	return m
}

type recorded struct {
	Method string
	Path   string
	Query  string
	Header http.Header
	Body   []byte
}

func (r recorded) JSON(t *testing.T) map[string]any {
	t.Helper()
	var m map[string]any
	if err := json.Unmarshal(r.Body, &m); err != nil {
		t.Fatalf("request body %q: %v", r.Body, err)
	}
	return m
}

type route func(w http.ResponseWriter, r *http.Request, body []byte)

// fake is an httptest server dispatching on "METHOD /path" (first match on prefix "METHOD /path*").
type fake struct {
	t      *testing.T
	srv    *httptest.Server
	mu     sync.Mutex
	reqs   []recorded
	routes map[string]route
}

func newFake(t *testing.T, routes map[string]route) *fake {
	t.Helper()
	f := &fake{t: t, routes: routes}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.reqs = append(f.reqs, recorded{Method: r.Method, Path: r.URL.Path, Query: r.URL.RawQuery, Header: r.Header.Clone(), Body: body})
		f.mu.Unlock()
		key := r.Method + " " + r.URL.Path
		if h, ok := f.routes[key]; ok {
			h(w, r, body)
			return
		}
		for pattern, h := range f.routes {
			if strings.HasSuffix(pattern, "*") && strings.HasPrefix(key, strings.TrimSuffix(pattern, "*")) {
				h(w, r, body)
				return
			}
		}
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(http.StatusNotFound)
		_, _ = w.Write([]byte(`{"type":"about:blank","title":"Route not found","status":404,"detail":"no fake route for ` + key + `","code":"route_not_found","request_id":"req_fake"}`))
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fake) requests() []recorded {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]recorded(nil), f.reqs...)
}

func (f *fake) count(method, path string) int {
	n := 0
	for _, r := range f.requests() {
		if r.Method == method && r.Path == path {
			n++
		}
	}
	return n
}

func (f *fake) last(method, path string) recorded {
	f.t.Helper()
	reqs := f.requests()
	for i := len(reqs) - 1; i >= 0; i-- {
		if reqs[i].Method == method && reqs[i].Path == path {
			return reqs[i]
		}
	}
	f.t.Fatalf("no %s %s request; got %+v", method, path, reqs)
	return recorded{}
}

func jsonBody(status int, body []byte) route {
	return func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-Id", "req_ok")
		w.WriteHeader(status)
		_, _ = w.Write(body)
	}
}

func jsonValue(status int, v any) route {
	raw, _ := json.Marshal(v)
	return jsonBody(status, raw)
}

// sequence serves the given routes in order, repeating the last one.
func sequence(steps ...route) route {
	var mu sync.Mutex
	i := 0
	return func(w http.ResponseWriter, r *http.Request, body []byte) {
		mu.Lock()
		step := steps[min(i, len(steps)-1)]
		i++
		mu.Unlock()
		step(w, r, body)
	}
}

func problem(status int, code string) route {
	return func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.Header().Set("Content-Type", "application/problem+json")
		w.Header().Set("X-Request-Id", "req_"+code)
		w.WriteHeader(status)
		_, _ = w.Write([]byte(`{"type":"about:blank","title":"x","status":` + itoa(status) + `,"detail":"` + code + ` detail","code":"` + code + `","request_id":"req_` + code + `"}`))
	}
}

func itoa(n int) string {
	raw, _ := json.Marshal(n)
	return string(raw)
}

// clock is a fake clock: sleeps advance it and are recorded.
type clock struct {
	mu     sync.Mutex
	now    time.Time
	sleeps []time.Duration
}

func newClock() *clock { return &clock{now: time.Date(2026, 11, 27, 0, 0, 0, 0, time.UTC)} }

func (c *clock) Sleep(ctx context.Context, d time.Duration) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.sleeps = append(c.sleeps, d)
	c.now = c.now.Add(d)
	return nil
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Sleeps() []time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]time.Duration(nil), c.sleeps...)
}

func noEnv(string) string { return "" }

// client returns a client wired to the fake server with a fake clock and fixed jitter.
func (f *fake) client(opts ...grad.Option) (*grad.Client, *clock) {
	clk := newClock()
	base := []grad.Option{
		grad.WithBaseURL(f.srv.URL),
		grad.WithAPIKey("grad_test_key"),
		grad.WithEnv(noEnv),
		grad.WithSleep(clk.Sleep),
		grad.WithClock(clk.Now),
		grad.WithRand(func() float64 { return 1 }),
	}
	return grad.NewClient(append(base, opts...)...), clk
}
