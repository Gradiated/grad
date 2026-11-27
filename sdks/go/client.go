package grad

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// DefaultBaseURL is used when no base URL is configured anywhere.
const DefaultBaseURL = "https://api.gradiated.com"

// Environment variables read by NewClient.
const (
	EnvAPIKey  = "GRADIATED_API_KEY"
	EnvBaseURL = "GRADIATED_BASE_URL"
	EnvProfile = "GRADIATED_PROFILE"
)

// Client is the Gradiated training and serving client. Create it with NewClient.
type Client struct {
	// API is the generated low-level client (one method per OpenAPI operation).
	// It is nil when the configuration is invalid; every call then returns that error.
	API *generated.Client

	Models      *ModelsService
	Datasets    *DatasetsService
	Imports     *ImportsService
	Runs        *RunsService
	Checkpoints *CheckpointsService
	Artifacts   *ArtifactsService
	Deployments *DeploymentsService
	Evals       *EvalsService
	Keys        *KeysService
	Secrets     *SecretsService
	Sources     *SourcesService
	Usage       *UsageService

	baseURL    string
	apiKey     string
	httpClient *http.Client
	configErr  error
	sleep      func(ctx context.Context, d time.Duration) error
	rand       func() float64
	now        func() time.Time
}

type settings struct {
	apiKey     *string
	baseURL    *string
	profile    string
	configFile string
	httpClient *http.Client
	timeout    time.Duration
	maxRetries *int
	userAgent  string
	sleep      func(ctx context.Context, d time.Duration) error
	rand       func() float64
	now        func() time.Time
	getenv     func(string) string
}

// Option configures a Client.
type Option func(*settings)

// WithAPIKey sets the API key (overrides GRADIATED_API_KEY and the config file).
func WithAPIKey(key string) Option { return func(s *settings) { s.apiKey = &key } }

// WithBaseURL sets the API root (overrides GRADIATED_BASE_URL and the config file).
func WithBaseURL(baseURL string) Option { return func(s *settings) { s.baseURL = &baseURL } }

// WithProfile selects a profile from the config file (default GRADIATED_PROFILE, then "default").
func WithProfile(name string) Option { return func(s *settings) { s.profile = name } }

// WithConfigFile reads credentials from this file instead of $XDG_CONFIG_HOME/gradiated/config.json.
func WithConfigFile(path string) Option { return func(s *settings) { s.configFile = path } }

// WithHTTPClient uses a custom *http.Client (its redirect policy is replaced by the SDK's same-origin policy).
func WithHTTPClient(c *http.Client) Option { return func(s *settings) { s.httpClient = c } }

// WithTimeout bounds each request attempt until its response headers (and the body for JSON calls). Default 60 s.
func WithTimeout(d time.Duration) Option { return func(s *settings) { s.timeout = d } }

// WithMaxRetries sets the retry budget for transient failures (default 2).
func WithMaxRetries(n int) Option { return func(s *settings) { s.maxRetries = &n } }

// WithUserAgent overrides the User-Agent header.
func WithUserAgent(ua string) Option { return func(s *settings) { s.userAgent = ua } }

// WithSleep replaces the function used to wait between retries and polls (tests use a fake clock).
// It must return ctx.Err() when ctx ends first.
func WithSleep(fn func(ctx context.Context, d time.Duration) error) Option {
	return func(s *settings) { s.sleep = fn }
}

// WithRand replaces the jitter source (values in [0, 1)).
func WithRand(fn func() float64) Option { return func(s *settings) { s.rand = fn } }

// WithClock replaces time.Now for wait timeouts (tests use a fake clock).
func WithClock(now func() time.Time) Option { return func(s *settings) { s.now = now } }

// WithEnv replaces os.Getenv when resolving configuration (tests).
func WithEnv(getenv func(string) string) Option { return func(s *settings) { s.getenv = getenv } }

type configFile struct {
	Profiles map[string]struct {
		BaseURL string `json:"base_url"`
		APIKey  string `json:"api_key"`
	} `json:"profiles"`
}

// MissingKeyMessage is the error every SDK and the CLI give when no API key is configured
// for a remote server.
func MissingKeyMessage(baseURL string) string {
	return "No API key for " + baseURL + ": run `grad login`, set GRADIATED_API_KEY, or export GRADIATED_PROFILE=local to use a `grad local up` stack."
}

func normalizeBaseURL(raw string) string {
	u := strings.TrimRight(strings.TrimSpace(raw), "/")
	if strings.HasSuffix(u, "/v1") {
		fmt.Fprintf(os.Stderr, "grad: base URL %q ends in /v1; the SDK adds /v1 itself, so it was dropped.\n", u)
		u = strings.TrimSuffix(u, "/v1")
	}
	return u
}

func isLoopback(baseURL string) bool {
	u, err := url.Parse(baseURL)
	if err != nil {
		return false
	}
	host := u.Hostname()
	if host == "localhost" || strings.HasSuffix(host, ".localhost") {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// DefaultConfigPath is $XDG_CONFIG_HOME/gradiated/config.json (default ~/.config/gradiated/config.json),
// the file `grad login` writes.
func DefaultConfigPath(getenv func(string) string) string {
	if getenv == nil {
		getenv = os.Getenv
	}
	if dir := getenv("XDG_CONFIG_HOME"); dir != "" {
		return filepath.Join(dir, "gradiated", "config.json")
	}
	home := getenv("HOME")
	if home == "" {
		home, _ = os.UserHomeDir()
	}
	if home == "" {
		return ""
	}
	return filepath.Join(home, ".config", "gradiated", "config.json")
}

func readProfile(path, profile string, explicit bool) (baseURL, apiKey string, err error) {
	if path == "" {
		return "", "", nil
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) && !explicit {
			return "", "", nil
		}
		return "", "", fmt.Errorf("reading config file %s: %w", path, err)
	}
	var cfg configFile
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return "", "", fmt.Errorf("parsing config file %s: %w", path, err)
	}
	p, ok := cfg.Profiles[profile]
	if !ok {
		if profile != "default" || explicit {
			return "", "", fmt.Errorf("profile %q not found in %s", profile, path)
		}
		return "", "", nil
	}
	return p.BaseURL, p.APIKey, nil
}

// NewClient builds a client. Every SDK and the CLI share one precedence for each setting:
// the option, then the selected profile (WithProfile or GRADIATED_PROFILE), then
// GRADIATED_API_KEY / GRADIATED_BASE_URL, then the default profile of the config file written
// by `grad login`, then https://api.gradiated.com. A key saved in a profile is only sent to that
// profile's base URL, and a trailing /v1 on the base URL is dropped. Configuration errors (bad
// URL, unreadable config file, no API key for a remote server) are returned by the first call
// rather than here, before anything is sent; WithAPIKey("") talks to a server without auth.
func NewClient(opts ...Option) *Client {
	s := &settings{getenv: os.Getenv}
	for _, opt := range opts {
		if opt != nil {
			opt(s)
		}
	}
	c := &Client{sleep: s.sleep, rand: s.rand, now: s.now}
	if c.sleep == nil {
		c.sleep = sleepContext
	}
	if c.rand == nil {
		var mu sync.Mutex
		r := rand.New(rand.NewSource(time.Now().UnixNano()))
		c.rand = func() float64 {
			mu.Lock()
			defer mu.Unlock()
			return r.Float64()
		}
	}
	if c.now == nil {
		c.now = time.Now
	}

	profile := s.profile
	explicitProfile := profile != ""
	if profile == "" {
		profile = s.getenv(EnvProfile)
		explicitProfile = profile != ""
	}
	if profile == "" {
		profile = "default"
	}
	path := s.configFile
	explicitFile := path != ""
	if path == "" {
		path = DefaultConfigPath(s.getenv)
	}

	envKey, envURL := s.getenv(EnvAPIKey), s.getenv(EnvBaseURL)
	covered := (s.baseURL != nil || envURL != "") && (s.apiKey != nil || envKey != "")
	var fileBase, fileKey string
	if !covered || explicitFile || explicitProfile {
		var err error
		fileBase, fileKey, err = readProfile(path, profile, explicitFile || explicitProfile)
		if err != nil {
			c.configErr = &GradError{Code: "invalid_config", Message: "grad: " + err.Error(), Cause: err}
		}
	}
	// Shared precedence: option > selected profile > GRADIATED_* > default profile > Cloud.
	var baseURL string
	switch {
	case s.baseURL != nil:
		baseURL = *s.baseURL
	case explicitProfile && fileBase != "":
		baseURL = fileBase
	case envURL != "":
		baseURL = envURL
	case fileBase != "":
		baseURL = fileBase
	default:
		baseURL = DefaultBaseURL
	}
	baseURL = normalizeBaseURL(baseURL)
	// A saved key belongs to its profile's server: never send it anywhere else.
	owner := DefaultBaseURL
	if fileBase != "" {
		owner = normalizeBaseURL(fileBase)
	}
	usableFileKey := ""
	if owner == baseURL {
		usableFileKey = fileKey
	}
	var apiKey string
	switch {
	case s.apiKey != nil:
		apiKey = *s.apiKey
	case explicitProfile && usableFileKey != "":
		apiKey = usableFileKey
	case envKey != "":
		apiKey = envKey
	default:
		apiKey = usableFileKey
	}
	var missingKey error
	if s.apiKey == nil && apiKey == "" && !isLoopback(baseURL) {
		msg := MissingKeyMessage(baseURL)
		if fileKey != "" && usableFileKey == "" {
			msg += fmt.Sprintf(" (the key saved in profile '%s' belongs to %s, so it was not sent)", profile, owner)
		}
		missingKey = &GradError{Code: "missing_api_key", Message: msg}
	}
	c.baseURL = strings.TrimRight(baseURL, "/")
	c.apiKey = apiKey
	c.httpClient = s.httpClient
	if c.httpClient == nil {
		c.httpClient = http.DefaultClient
	}

	if c.configErr == nil {
		t, err := generated.NewTransport(generated.Config{
			BaseURL:    baseURL,
			APIKey:     apiKey,
			HTTPClient: s.httpClient,
			Timeout:    s.timeout,
			MaxRetries: s.maxRetries,
			UserAgent:  s.userAgent,
			Sleep:      s.sleep,
			Rand:       s.rand,
		})
		if err != nil {
			c.configErr = err
		} else {
			c.API = generated.NewClient(t)
		}
	}
	if c.configErr == nil {
		c.configErr = missingKey
	}

	c.Models = &ModelsService{c: c}
	c.Datasets = &DatasetsService{c: c}
	c.Imports = &ImportsService{c: c}
	c.Runs = &RunsService{c: c}
	c.Checkpoints = &CheckpointsService{c: c}
	c.Artifacts = &ArtifactsService{c: c}
	c.Deployments = &DeploymentsService{c: c}
	c.Evals = &EvalsService{c: c}
	c.Keys = &KeysService{c: c}
	c.Secrets = &SecretsService{c: c}
	c.Sources = &SourcesService{c: c}
	c.Usage = &UsageService{c: c}
	return c
}

// BaseURL is the resolved API root.
func (c *Client) BaseURL() string { return c.baseURL }

// APIKeyConfigured reports whether requests carry a bearer token.
func (c *Client) APIKeyConfigured() bool { return c.apiKey != "" }

// api returns the generated client, or the configuration error.
func (c *Client) api() (*generated.Client, error) {
	if c.configErr != nil {
		return nil, c.configErr
	}
	return c.API, nil
}

func sleepContext(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

func ptr[T any](v T) *T { return &v }

// optString returns nil for "".
func optString(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func optInt(n int) *int {
	if n == 0 {
		return nil
	}
	return &n
}

func optFloat(f float64) *float64 {
	if f == 0 {
		return nil
	}
	return &f
}

func deref[T any](p *T) T {
	var zero T
	if p == nil {
		return zero
	}
	return *p
}
