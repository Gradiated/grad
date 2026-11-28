package grad_test

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	grad "github.com/Gradiated/grad/sdks/go"
)

// TestRetryConformance replays the shared retry-policy fixture (tests/fixtures/wire/retries.json).
func TestRetryConformance(t *testing.T) {
	var fixture struct {
		Cases []struct {
			Name      string `json:"name"`
			Method    string `json:"method"`
			Responses []struct {
				Status  int               `json:"status"`
				Headers map[string]string `json:"headers"`
				Body    json.RawMessage   `json:"body"`
			} `json:"responses"`
			Expect struct {
				Attempts int     `json:"attempts"`
				Error    *string `json:"error"`
				SleepsMS []int   `json:"sleeps_ms"`
			} `json:"expect"`
		} `json:"cases"`
	}
	if err := json.Unmarshal(wire(t, "retries.json"), &fixture); err != nil {
		t.Fatal(err)
	}
	paths := map[string]string{"GET": "/v1/datasets", "POST": "/v1/datasets", "DELETE": "/v1/secrets/s"}
	success := map[string][]byte{"GET": []byte(`{"data":[],"next_cursor":null}`), "POST": wire(t, "dataset.json")}
	for _, c := range fixture.Cases {
		t.Run(c.Name, func(t *testing.T) {
			var steps []route
			for _, r := range c.Responses {
				switch {
				case r.Status >= 300:
					steps = append(steps, func(w http.ResponseWriter, _ *http.Request, _ []byte) {
						for k, v := range r.Headers {
							w.Header().Set(k, v)
						}
						w.WriteHeader(r.Status)
						_, _ = w.Write(r.Body)
					})
				case success[c.Method] != nil:
					steps = append(steps, jsonBody(r.Status, success[c.Method]))
				default:
					steps = append(steps, func(w http.ResponseWriter, _ *http.Request, _ []byte) { w.WriteHeader(r.Status) })
				}
			}
			f := newFake(t, map[string]route{c.Method + " " + paths[c.Method]: sequence(steps...)})
			client, clk := f.client()
			ctx := context.Background()
			var err error
			switch c.Method {
			case "GET":
				for _, e := range client.Datasets.List(ctx) {
					err = e
					break
				}
			case "POST":
				_, err = client.Datasets.Create(ctx, "d")
			case "DELETE":
				err = client.Secrets.Delete(ctx, grad.SecretName("s"))
			}
			if c.Expect.Error == nil {
				if err != nil {
					t.Fatalf("unexpected error %v", err)
				}
			} else if !matchClass(err, *c.Expect.Error) {
				t.Fatalf("error %T %v, want %s", err, err, *c.Expect.Error)
			}
			if n := f.count(c.Method, paths[c.Method]); n != c.Expect.Attempts {
				t.Fatalf("attempts %d, want %d", n, c.Expect.Attempts)
			}
			if c.Expect.SleepsMS != nil {
				var got []int
				for _, d := range clk.Sleeps() {
					got = append(got, int(d.Milliseconds()))
				}
				if fmt.Sprint(got) != fmt.Sprint(c.Expect.SleepsMS) {
					t.Fatalf("sleeps %v, want %v", got, c.Expect.SleepsMS)
				}
			}
			if c.Method == "POST" {
				keys := map[string]bool{}
				for _, r := range f.requests() {
					keys[r.Header.Get("Idempotency-Key")] = true
				}
				if len(keys) != 1 || keys[""] {
					t.Fatalf("Idempotency-Key per attempt %v", keys)
				}
			}
		})
	}
}
