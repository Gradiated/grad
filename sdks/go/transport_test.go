package grad_test

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	grad "github.com/Gradiated/grad/sdks/go"
)

type errorCase struct {
	Name     string            `json:"name"`
	Status   int               `json:"status"`
	Headers  map[string]string `json:"headers"`
	Body     json.RawMessage   `json:"body"`
	BodyText *string           `json:"body_text"`
	Expect   struct {
		Class           string            `json:"class"`
		Status          int               `json:"status"`
		Code            string            `json:"code"`
		RequestID       *string           `json:"request_id"`
		MessageContains []string          `json:"message_contains"`
		FieldErrors     []grad.FieldError `json:"field_errors"`
		RetryAfterMS    int               `json:"retry_after_ms"`
		Retryable       bool              `json:"retryable"`
	} `json:"expect"`
}

// matchClass checks err against the class named in errors.json via errors.As.
func matchClass(err error, class string) bool {
	targets := map[string]any{
		"APIError":                  new(*grad.APIError),
		"BadRequestError":           new(*grad.BadRequestError),
		"AuthenticationError":       new(*grad.AuthenticationError),
		"PermissionDeniedError":     new(*grad.PermissionDeniedError),
		"NotFoundError":             new(*grad.NotFoundError),
		"ConflictError":             new(*grad.ConflictError),
		"ValidationError":           new(*grad.ValidationError),
		"RateLimitError":            new(*grad.RateLimitError),
		"ServerError":               new(*grad.ServerError),
		"DeployUnavailableError":    new(*grad.DeployUnavailableError),
		"InferenceUnavailableError": new(*grad.InferenceUnavailableError),
	}
	target, ok := targets[class]
	if !ok || !errors.As(err, target) {
		return false
	}
	// The concrete type must be exactly the named class (not just a wrapper of it).
	concrete := reflect.TypeOf(target).Elem().String()
	return reflect.TypeOf(err).String() == concrete || class == "APIError" && reflect.TypeOf(err).String() == "*generated.APIError"
}

func TestErrorMappingFromSharedFixtures(t *testing.T) {
	var table struct {
		Cases []errorCase `json:"cases"`
	}
	if err := json.Unmarshal(wire(t, "errors.json"), &table); err != nil {
		t.Fatal(err)
	}
	for _, tc := range table.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			respond := func(w http.ResponseWriter, _ *http.Request, _ []byte) {
				for k, v := range tc.Headers {
					w.Header().Set(k, v)
				}
				w.WriteHeader(tc.Status)
				if tc.BodyText != nil {
					_, _ = w.Write([]byte(*tc.BodyText))
				} else {
					_, _ = w.Write(tc.Body)
				}
			}
			f := newFake(t, map[string]route{"GET /v1/runs/run_x": respond})
			c, clk := f.client()
			_, err := c.Runs.Get(context.Background(), "run_x")
			if err == nil {
				t.Fatal("expected an error")
			}
			if !matchClass(err, tc.Expect.Class) {
				t.Fatalf("error %T (%v) is not %s", err, err, tc.Expect.Class)
			}
			var base *grad.GradError
			if !errors.As(err, &base) {
				t.Fatalf("%T does not unwrap to *GradError", err)
			}
			var api *grad.APIError
			if !errors.As(err, &api) {
				t.Fatalf("%T does not unwrap to *APIError", err)
			}
			if base.Status != tc.Expect.Status || base.Code != tc.Expect.Code {
				t.Fatalf("status/code = %d/%s, want %d/%s", base.Status, base.Code, tc.Expect.Status, tc.Expect.Code)
			}
			wantID := ""
			if tc.Expect.RequestID != nil {
				wantID = *tc.Expect.RequestID
			}
			if base.RequestID != wantID {
				t.Fatalf("request id = %q, want %q", base.RequestID, wantID)
			}
			for _, s := range tc.Expect.MessageContains {
				if !strings.Contains(err.Error(), s) {
					t.Fatalf("message %q lacks %q", err.Error(), s)
				}
			}
			if !strings.Contains(err.Error(), "/v1/runs/run_x") {
				t.Fatalf("message %q does not name the endpoint", err.Error())
			}
			if tc.Expect.FieldErrors != nil && !reflect.DeepEqual(api.FieldErrors, tc.Expect.FieldErrors) {
				t.Fatalf("field errors = %+v, want %+v", api.FieldErrors, tc.Expect.FieldErrors)
			}
			if tc.Expect.RetryAfterMS > 0 && api.RetryAfter != time.Duration(tc.Expect.RetryAfterMS)*time.Millisecond {
				t.Fatalf("retry after = %s", api.RetryAfter)
			}
			wantRequests := 1
			if tc.Expect.Retryable {
				wantRequests = 3
			}
			if n := f.count("GET", "/v1/runs/run_x"); n != wantRequests {
				t.Fatalf("GET sent %d times, want %d (sleeps %v)", n, wantRequests, clk.Sleeps())
			}
		})
	}
}

func TestCapturedProblemFixturesMapToTypedErrors(t *testing.T) {
	cases := map[string]string{
		"problem-not-found.json":          "NotFoundError",
		"problem-validation.json":         "ValidationError",
		"problem-unauthorized.json":       "AuthenticationError",
		"problem-deploy-unavailable.json": "DeployUnavailableError",
		"problem-conflict.json":           "ConflictError",
	}
	for file, class := range cases {
		var fx struct {
			Status  int               `json:"status"`
			Headers map[string]string `json:"headers"`
			Body    json.RawMessage   `json:"body"`
		}
		if err := json.Unmarshal(wire(t, file), &fx); err != nil {
			t.Fatal(err)
		}
		f := newFake(t, map[string]route{"POST /v1/deployments": func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			for k, v := range fx.Headers {
				w.Header().Set(k, v)
			}
			w.WriteHeader(fx.Status)
			_, _ = w.Write(fx.Body)
		}})
		c, _ := f.client()
		_, err := c.Deployments.Create(context.Background(), "a@latest")
		if !matchClass(err, class) {
			t.Fatalf("%s: got %T %v", file, err, err)
		}
		if gerr := (*grad.GradError)(nil); !errors.As(err, &gerr) || gerr.RequestID != fx.Headers["x-request-id"] {
			t.Fatalf("%s: request id not captured: %v", file, err)
		}
	}
}

func TestRetriesHonourRetryAfterAndMethodRules(t *testing.T) {
	ctx := context.Background()
	t.Run("429 Retry-After then success", func(t *testing.T) {
		limited := func(w http.ResponseWriter, _ *http.Request, _ []byte) {
			w.Header().Set("Retry-After", "3")
			problem(429, "rate_limited")(w, nil, nil)
		}
		f := newFake(t, map[string]route{"POST /v1/feedback": sequence(limited, jsonBody(200, wire(t, "feedback-response.json")))})
		c, clk := f.client()
		if err := c.Feedback.Record(ctx, grad.Feedback{InferenceID: "inf_1", Score: 1}); err != nil {
			t.Fatal(err)
		}
		if n := f.count("POST", "/v1/feedback"); n != 2 {
			t.Fatalf("POST sent %d times", n)
		}
		if got := clk.Sleeps(); len(got) != 1 || got[0] != 3*time.Second {
			t.Fatalf("sleeps = %v, want [3s]", got)
		}
	})
	t.Run("503 GET retried with exponential backoff", func(t *testing.T) {
		f := newFake(t, map[string]route{"GET /v1/models": sequence(problem(503, "unavailable"), problem(503, "unavailable"), jsonBody(200, wire(t, "models.json")))})
		c, clk := f.client()
		models, err := c.Models.List(ctx)
		if err != nil || len(models) == 0 {
			t.Fatalf("models = %v, %v", models, err)
		}
		if got := clk.Sleeps(); !reflect.DeepEqual(got, []time.Duration{500 * time.Millisecond, time.Second}) {
			t.Fatalf("sleeps = %v", got)
		}
	})
	t.Run("POST 500 is not retried", func(t *testing.T) {
		f := newFake(t, map[string]route{"POST /v1/runs": problem(500, "internal_error")})
		c, _ := f.client()
		_, err := c.Runs.Create(ctx, grad.RunParams{Dataset: grad.DatasetName("d"), Name: "n", Recipe: grad.SFTRecipe{}}).Result()
		var se *grad.ServerError
		if !errors.As(err, &se) || f.count("POST", "/v1/runs") != 1 {
			t.Fatalf("err = %v, requests = %d", err, f.count("POST", "/v1/runs"))
		}
	})
	t.Run("retry budget is configurable", func(t *testing.T) {
		f := newFake(t, map[string]route{"GET /v1/models": problem(502, "bad_gateway")})
		c, _ := f.client(grad.WithMaxRetries(0))
		if _, err := c.Models.List(ctx); err == nil || f.count("GET", "/v1/models") != 1 {
			t.Fatalf("err = %v, requests = %d", err, f.count("GET", "/v1/models"))
		}
	})
	t.Run("POST retried when the connection was refused", func(t *testing.T) {
		ln, err := net.Listen("tcp", "127.0.0.1:0")
		if err != nil {
			t.Fatal(err)
		}
		addr := ln.Addr().String()
		ln.Close()
		clk := newClock()
		c := grad.NewClient(grad.WithBaseURL("http://"+addr), grad.WithEnv(noEnv), grad.WithSleep(clk.Sleep), grad.WithRand(func() float64 { return 1 }))
		_, err = c.Runs.Create(ctx, grad.RunParams{Dataset: grad.DatasetName("d"), Name: "n", Recipe: grad.SFTRecipe{}}).Result()
		var conn *grad.ConnectionError
		if !errors.As(err, &conn) {
			t.Fatalf("err = %T %v", err, err)
		}
		if !strings.Contains(err.Error(), "GRADIATED_BASE_URL") || len(clk.Sleeps()) != 2 {
			t.Fatalf("message %q, sleeps %v", err, clk.Sleeps())
		}
	})
	t.Run("timeout is typed", func(t *testing.T) {
		f := newFake(t, map[string]route{"GET /v1/models": func(w http.ResponseWriter, _ *http.Request, _ []byte) { time.Sleep(200 * time.Millisecond) }})
		c, _ := f.client(grad.WithTimeout(20*time.Millisecond), grad.WithMaxRetries(0))
		_, err := c.Models.List(ctx)
		var te *grad.TimeoutError
		var conn *grad.ConnectionError
		if !errors.As(err, &te) || !errors.As(err, &conn) {
			t.Fatalf("err = %T %v", err, err)
		}
	})
}

func TestRedirects(t *testing.T) {
	ctx := context.Background()
	other := newFake(t, map[string]route{"GET /v1/models": jsonBody(200, wire(t, "models.json"))})
	t.Run("cross-origin redirect is refused and the key never leaves", func(t *testing.T) {
		f := newFake(t, map[string]route{"GET /v1/models": func(w http.ResponseWriter, r *http.Request, _ []byte) {
			http.Redirect(w, r, other.srv.URL+"/v1/models", http.StatusFound)
		}})
		c, _ := f.client()
		_, err := c.Models.List(ctx)
		var re *grad.RedirectError
		if !errors.As(err, &re) || re.Code != "redirect_refused" {
			t.Fatalf("err = %T %v", err, err)
		}
		if len(other.requests()) != 0 {
			t.Fatalf("other origin received %d requests", len(other.requests()))
		}
	})
	t.Run("same-origin GET redirect is followed with credentials", func(t *testing.T) {
		f := newFake(t, map[string]route{
			"GET /old/v1/models": func(w http.ResponseWriter, r *http.Request, _ []byte) {
				http.Redirect(w, r, "/v1/models", http.StatusMovedPermanently)
			},
			"GET /v1/models": jsonBody(200, wire(t, "models.json")),
		})
		c, _ := f.client(grad.WithBaseURL(f.srv.URL + "/old"))
		if _, err := c.Models.List(ctx); err != nil {
			t.Fatal(err)
		}
		if got := f.last("GET", "/v1/models").Header.Get("Authorization"); got != "Bearer grad_test_key" {
			t.Fatalf("authorization = %q", got)
		}
	})
	t.Run("POST redirect is refused even on the same origin", func(t *testing.T) {
		f := newFake(t, map[string]route{"POST /v1/feedback": func(w http.ResponseWriter, r *http.Request, _ []byte) {
			http.Redirect(w, r, "/v2/feedback", http.StatusTemporaryRedirect)
		}})
		c, _ := f.client()
		var re *grad.RedirectError
		if err := c.Feedback.Record(ctx, grad.Feedback{InferenceID: "i"}); !errors.As(err, &re) {
			t.Fatalf("err = %v", err)
		}
	})
}

func TestConfigResolution(t *testing.T) {
	ctx := context.Background()
	f := newFake(t, map[string]route{"GET /v1/models": jsonBody(200, wire(t, "models.json"))})
	dir := t.TempDir()
	cfgPath := filepath.Join(dir, "gradiated", "config.json")
	if err := os.MkdirAll(filepath.Dir(cfgPath), 0o700); err != nil {
		t.Fatal(err)
	}
	cfg := `{"profiles":{"default":{"base_url":"` + f.srv.URL + `","api_key":"grad_file_key"},"staging":{"base_url":"` + f.srv.URL + `","api_key":"grad_staging_key"}}}`
	if err := os.WriteFile(cfgPath, []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	env := func(vals map[string]string) grad.Option {
		return grad.WithEnv(func(k string) string { return vals[k] })
	}
	authOf := func(c *grad.Client) string {
		t.Helper()
		if _, err := c.Models.List(ctx); err != nil {
			t.Fatal(err)
		}
		return f.last("GET", "/v1/models").Header.Get("Authorization")
	}

	if got := authOf(grad.NewClient(env(map[string]string{"XDG_CONFIG_HOME": dir}))); got != "Bearer grad_file_key" {
		t.Fatalf("config file: %q", got)
	}
	if got := authOf(grad.NewClient(env(map[string]string{"XDG_CONFIG_HOME": dir, "GRADIATED_PROFILE": "staging"}))); got != "Bearer grad_staging_key" {
		t.Fatalf("profile env: %q", got)
	}
	if got := authOf(grad.NewClient(env(map[string]string{"XDG_CONFIG_HOME": dir}), grad.WithProfile("staging"))); got != "Bearer grad_staging_key" {
		t.Fatalf("profile option: %q", got)
	}
	if got := authOf(grad.NewClient(env(map[string]string{"XDG_CONFIG_HOME": dir, "GRADIATED_API_KEY": "grad_env_key"}))); got != "Bearer grad_env_key" {
		t.Fatalf("env wins over file: %q", got)
	}
	if got := authOf(grad.NewClient(env(map[string]string{"GRADIATED_API_KEY": "grad_env_key", "GRADIATED_BASE_URL": f.srv.URL}), grad.WithAPIKey("grad_opt_key"))); got != "Bearer grad_opt_key" {
		t.Fatalf("option wins over env: %q", got)
	}
	if got := authOf(grad.NewClient(grad.WithConfigFile(cfgPath), env(nil))); got != "Bearer grad_file_key" {
		t.Fatalf("explicit config file: %q", got)
	}
	if got := authOf(grad.NewClient(env(map[string]string{"GRADIATED_BASE_URL": f.srv.URL, "HOME": dir}))); got != "" {
		t.Fatalf("no key anywhere should send no Authorization, got %q", got)
	}

	if c := grad.NewClient(env(map[string]string{"HOME": t.TempDir()})); c.BaseURL() != grad.DefaultBaseURL || c.APIKeyConfigured() {
		t.Fatalf("defaults: %s %v", c.BaseURL(), c.APIKeyConfigured())
	}
	if p := grad.DefaultConfigPath(func(k string) string { return map[string]string{"HOME": "/home/u"}[k] }); p != "/home/u/.config/gradiated/config.json" {
		t.Fatalf("default path %s", p)
	}

	bad := grad.NewClient(grad.WithBaseURL("ftp://nope"), env(nil))
	var gerr *grad.GradError
	if _, err := bad.Models.List(ctx); !errors.As(err, &gerr) || gerr.Code != "invalid_base_url" {
		t.Fatalf("bad base url: %v", err)
	}
	missingProfile := grad.NewClient(env(map[string]string{"XDG_CONFIG_HOME": dir}), grad.WithProfile("nope"))
	if _, err := missingProfile.Models.List(ctx); err == nil || !strings.Contains(err.Error(), `profile "nope"`) {
		t.Fatalf("missing profile: %v", err)
	}
	if err := os.WriteFile(cfgPath, []byte("{not json"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, err := grad.NewClient(env(map[string]string{"XDG_CONFIG_HOME": dir})).Models.List(ctx); err == nil || !strings.Contains(err.Error(), "parsing config file") {
		t.Fatalf("corrupt config: %v", err)
	}

	unauth := newFake(t, map[string]route{"GET /v1/models": problem(401, "unauthorized")})
	_, err := grad.NewClient(grad.WithBaseURL(unauth.srv.URL), env(map[string]string{"HOME": t.TempDir()})).Models.List(ctx)
	if err == nil || !strings.Contains(err.Error(), "GRADIATED_API_KEY") || !strings.Contains(err.Error(), "grad login") {
		t.Fatalf("401 without key should explain how to configure one: %v", err)
	}
}

func TestUserAgentAndCancellation(t *testing.T) {
	f := newFake(t, map[string]route{"GET /v1/models": jsonBody(200, wire(t, "models.json"))})
	c, _ := f.client()
	if _, err := c.Models.List(context.Background()); err != nil {
		t.Fatal(err)
	}
	if ua := f.last("GET", "/v1/models").Header.Get("User-Agent"); !strings.HasPrefix(ua, "grad-go/"+grad.Version) {
		t.Fatalf("user agent %q", ua)
	}
	c2, _ := f.client(grad.WithUserAgent("my-app/1"))
	_, _ = c2.Models.List(context.Background())
	if ua := f.last("GET", "/v1/models").Header.Get("User-Agent"); ua != "my-app/1" {
		t.Fatalf("custom user agent %q", ua)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := c.Models.List(ctx); err == nil || !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled ctx: %v", err)
	}
	hc := &http.Client{}
	c3, _ := f.client(grad.WithHTTPClient(hc))
	if _, err := c3.Models.List(context.Background()); err != nil || c3.API == nil {
		t.Fatalf("custom http client: %v", err)
	}
}
