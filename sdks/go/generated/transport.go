// HTTP runtime of the generated client (hand-written; scripts/generate-sdks.mjs emits only
// models.go, client.go and doc.go next to it).

package generated

import (
	"bufio"
	"bytes"
	"context"
	crand "crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"math/rand"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"
)

// SDKVersion is the version reported in the User-Agent header.
const SDKVersion = "0.2.0-alpha.6"

// Defaults for the transport.
const (
	DefaultTimeout     = 60 * time.Second
	DefaultMaxRetries  = 2
	DefaultIdleTimeout = 120 * time.Second
	MaxRetryAfter      = 60 * time.Second
	maxRedirects       = 5
)

// ---------------------------------------------------------------- errors

// GradError is the base of every error the SDK returns; errors.As(err, &gradErr) matches all of them.
type GradError struct {
	// Status is the HTTP status code, or 0 when no response was received.
	Status int
	// Code is the machine-readable problem code (for example "run_not_found" or "connection_error").
	Code string
	// RequestID is the server's x-request-id, when a response was received.
	RequestID string
	Message   string
	Cause     error
}

func (e *GradError) Error() string { return e.Message }

// Unwrap returns the underlying cause (for example a *net.OpError).
func (e *GradError) Unwrap() error { return e.Cause }

// FieldError is one field-level validation failure from a 422 response.
type FieldError struct {
	Field   string
	Message string
}

// APIError is a non-2xx response, parsed from RFC 7807 problem+json when possible.
type APIError struct {
	*GradError
	Title       string
	Detail      string
	Type        string
	Method      string
	URL         string
	Header      http.Header
	Body        []byte
	FieldErrors []FieldError
	// RetryAfter is the server's Retry-After hint (0 when absent).
	RetryAfter time.Duration
}

// Unwrap exposes the embedded *GradError to errors.As.
func (e *APIError) Unwrap() error { return e.GradError }

// BadRequestError is a 400 response.
type BadRequestError struct{ *APIError }

// AuthenticationError is a 401 response.
type AuthenticationError struct{ *APIError }

// PermissionDeniedError is a 403 response.
type PermissionDeniedError struct{ *APIError }

// NotFoundError is a 404 response.
type NotFoundError struct{ *APIError }

// ConflictError is a 409 response.
type ConflictError struct{ *APIError }

// ValidationError is a 422 response; FieldErrors lists the offending fields.
type ValidationError struct{ *APIError }

// RateLimitError is a 429 response.
type RateLimitError struct{ *APIError }

// QueueLimitError is a 429 queue_limit response: the workspace already has as many queued jobs as
// it may (GRAD_MAX_QUEUED_PER_WORKSPACE). It is a hard cap, not rate limiting, so it is never
// retried. It unwraps to *RateLimitError, so errors.As matches either.
type QueueLimitError struct{ *RateLimitError }

// ServerError is a 5xx response.
type ServerError struct{ *APIError }

// FeatureUnavailableError is a 501 response: the server doesn't offer this capability as
// configured. It is never retried.
type FeatureUnavailableError struct{ *APIError }

// InferenceUnavailableError is a 501 inference_unavailable response: no inference endpoint is
// configured. It unwraps to *FeatureUnavailableError, so errors.As matches either.
type InferenceUnavailableError struct{ *FeatureUnavailableError }

func (e *BadRequestError) Unwrap() error           { return e.APIError }
func (e *AuthenticationError) Unwrap() error       { return e.APIError }
func (e *PermissionDeniedError) Unwrap() error     { return e.APIError }
func (e *NotFoundError) Unwrap() error             { return e.APIError }
func (e *ConflictError) Unwrap() error             { return e.APIError }
func (e *ValidationError) Unwrap() error           { return e.APIError }
func (e *RateLimitError) Unwrap() error            { return e.APIError }
func (e *QueueLimitError) Unwrap() error           { return e.RateLimitError }
func (e *ServerError) Unwrap() error               { return e.APIError }
func (e *FeatureUnavailableError) Unwrap() error   { return e.APIError }
func (e *InferenceUnavailableError) Unwrap() error { return e.FeatureUnavailableError }

// ConnectionError means no HTTP response was received (DNS, refused, reset, TLS).
type ConnectionError struct{ *GradError }

// Unwrap exposes the embedded *GradError.
func (e *ConnectionError) Unwrap() error { return e.GradError }

// TimeoutError means the per-request timeout elapsed, or a stream went idle.
type TimeoutError struct{ *ConnectionError }

// Unwrap exposes the embedded *ConnectionError.
func (e *TimeoutError) Unwrap() error { return e.ConnectionError }

// RedirectError means a redirect would leave the API origin or change a non-GET request; it is refused so credentials never leak.
type RedirectError struct{ *GradError }

// Unwrap exposes the embedded *GradError.
func (e *RedirectError) Unwrap() error { return e.GradError }

// DecodeError means a 2xx response body could not be decoded.
type DecodeError struct{ *GradError }

// Unwrap exposes the embedded *GradError.
func (e *DecodeError) Unwrap() error { return e.GradError }

var fieldErrorRE = regexp.MustCompile(`(?s)^([A-Za-z0-9_.\[\]-]+): (.+)$`)

// ParseFieldErrors reads a problem "errors" array, or the server's "a.b: message; c: other" detail.
func ParseFieldErrors(problem map[string]any, detail string) []FieldError {
	if items, ok := problem["errors"].([]any); ok {
		out := make([]FieldError, 0, len(items))
		for _, item := range items {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			field, _ := m["field"].(string)
			if field == "" {
				if path, ok := m["path"].([]any); ok {
					parts := make([]string, 0, len(path))
					for _, p := range path {
						parts = append(parts, fmt.Sprint(p))
					}
					field = strings.Join(parts, ".")
				}
			}
			msg, _ := m["message"].(string)
			if msg == "" {
				msg, _ = m["detail"].(string)
			}
			out = append(out, FieldError{Field: field, Message: msg})
		}
		return out
	}
	var out []FieldError
	for _, part := range strings.Split(detail, "; ") {
		if m := fieldErrorRE.FindStringSubmatch(part); m != nil {
			out = append(out, FieldError{Field: m[1], Message: m[2]})
		}
	}
	return out
}

// ParseRetryAfter reads Retry-After-Ms, or Retry-After as seconds or an HTTP date.
func ParseRetryAfter(h http.Header, now time.Time) (time.Duration, bool) {
	if ms := strings.TrimSpace(h.Get("Retry-After-Ms")); ms != "" {
		if v, err := strconv.ParseFloat(ms, 64); err == nil && v >= 0 {
			return time.Duration(v * float64(time.Millisecond)), true
		}
	}
	raw := strings.TrimSpace(h.Get("Retry-After"))
	if raw == "" {
		return 0, false
	}
	if v, err := strconv.ParseFloat(raw, 64); err == nil && v >= 0 {
		return time.Duration(v * float64(time.Second)), true
	}
	if t, err := http.ParseTime(raw); err == nil {
		d := t.Sub(now)
		if d < 0 {
			d = 0
		}
		return d, true
	}
	return 0, false
}

// NewAPIError builds the typed error for a non-2xx response; tolerant of any body shape.
func NewAPIError(status int, header http.Header, body []byte, method, rawURL string, apiKeyConfigured bool) error {
	problem := map[string]any{}
	_ = json.Unmarshal(body, &problem)
	str := func(key string) string {
		v, _ := problem[key].(string)
		return v
	}
	code := str("code")
	if code == "" {
		code = fmt.Sprintf("http_%d", status)
	}
	title := str("title")
	if title == "" {
		title = fmt.Sprintf("HTTP %d", status)
	}
	detail := str("detail")
	if detail == "" {
		detail = str("message")
	}
	if detail == "" && len(problem) == 0 {
		text := strings.TrimSpace(string(body))
		if len(text) > 500 {
			text = text[:500]
		}
		detail = text
	}
	requestID := header.Get("X-Request-Id")
	if requestID == "" {
		requestID = str("request_id")
	}
	hint := ""
	if status == http.StatusUnauthorized && !apiKeyConfigured {
		hint = " No API key is configured: set GRADIATED_API_KEY, use grad.WithAPIKey, or run `grad login`."
	}
	msg := fmt.Sprintf("%s %s returned %d %s", method, rawURL, status, code)
	if detail != "" {
		msg += ": " + detail
	}
	msg += hint
	if requestID != "" {
		msg += " (request_id " + requestID + ")"
	}
	typ := str("type")
	if typ == "" {
		typ = "about:blank"
	}
	retryAfter, _ := ParseRetryAfter(header, time.Now())
	base := &APIError{
		GradError:  &GradError{Status: status, Code: code, RequestID: requestID, Message: msg},
		Title:      title,
		Detail:     detail,
		Type:       typ,
		Method:     method,
		URL:        rawURL,
		Header:     header,
		Body:       body,
		RetryAfter: retryAfter,
	}
	if status == http.StatusUnprocessableEntity {
		base.FieldErrors = ParseFieldErrors(problem, detail)
	}
	switch {
	case code == "inference_unavailable":
		return &InferenceUnavailableError{&FeatureUnavailableError{base}}
	case status == http.StatusTooManyRequests && code == "queue_limit":
		return &QueueLimitError{&RateLimitError{base}}
	case status == http.StatusBadRequest:
		return &BadRequestError{base}
	case status == http.StatusUnauthorized:
		return &AuthenticationError{base}
	case status == http.StatusForbidden:
		return &PermissionDeniedError{base}
	case status == http.StatusNotFound:
		return &NotFoundError{base}
	case status == http.StatusConflict:
		return &ConflictError{base}
	case status == http.StatusUnprocessableEntity:
		return &ValidationError{base}
	case status == http.StatusTooManyRequests:
		return &RateLimitError{base}
	case status == http.StatusNotImplemented:
		return &FeatureUnavailableError{base}
	case status >= 500:
		return &ServerError{base}
	}
	return base
}

// ---------------------------------------------------------------- transport

// Config configures a Transport.
type Config struct {
	// BaseURL is the API root, for example https://api.gradiated.com.
	BaseURL string
	// APIKey is sent as a bearer token when non-empty.
	APIKey string
	// HTTPClient is cloned; its CheckRedirect is replaced so redirects are handled by the transport.
	HTTPClient *http.Client
	// Timeout bounds each attempt until the response headers (and, for JSON, the body). Default 60 s.
	Timeout time.Duration
	// MaxRetries is the retry budget; nil means DefaultMaxRetries.
	MaxRetries *int
	// UserAgent overrides the default User-Agent.
	UserAgent string
	// Header is sent on every request.
	Header http.Header
	// Sleep waits between retries (tests inject a fake clock). Must return ctx.Err() when ctx ends.
	Sleep func(ctx context.Context, d time.Duration) error
	// Rand returns jitter in [0, 1) (tests inject a fixed value).
	Rand func() float64
}

// Transport sends requests with retries, backoff, Retry-After, timeouts and same-origin-only redirects.
// Operations that accept an Idempotency-Key send one (reused by every retry) and retry like GETs.
type Transport struct {
	baseURL    string
	origin     string
	apiKey     string
	httpClient *http.Client
	timeout    time.Duration
	maxRetries int
	userAgent  string
	header     http.Header
	sleep      func(ctx context.Context, d time.Duration) error
	rand       func() float64
}

// NewTransport validates the base URL and builds a transport.
func NewTransport(cfg Config) (*Transport, error) {
	parsed, err := url.Parse(cfg.BaseURL)
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" {
		return nil, &GradError{Code: "invalid_base_url", Message: fmt.Sprintf("invalid base URL %q: it must be an absolute http(s) URL", cfg.BaseURL), Cause: err}
	}
	base := http.DefaultClient
	if cfg.HTTPClient != nil {
		base = cfg.HTTPClient
	}
	client := *base
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	client.Timeout = 0
	t := &Transport{
		baseURL:    strings.TrimRight(cfg.BaseURL, "/"),
		origin:     parsed.Scheme + "://" + parsed.Host,
		apiKey:     cfg.APIKey,
		httpClient: &client,
		timeout:    cfg.Timeout,
		maxRetries: DefaultMaxRetries,
		userAgent:  cfg.UserAgent,
		header:     cfg.Header.Clone(),
		sleep:      cfg.Sleep,
		rand:       cfg.Rand,
	}
	if t.timeout <= 0 {
		t.timeout = DefaultTimeout
	}
	if cfg.MaxRetries != nil && *cfg.MaxRetries >= 0 {
		t.maxRetries = *cfg.MaxRetries
	}
	if t.userAgent == "" {
		t.userAgent = fmt.Sprintf("grad-go/%s (%s; %s/%s)", SDKVersion, runtime.Version(), runtime.GOOS, runtime.GOARCH)
	}
	if t.sleep == nil {
		t.sleep = sleepContext
	}
	if t.rand == nil {
		var mu sync.Mutex
		r := rand.New(rand.NewSource(time.Now().UnixNano()))
		t.rand = func() float64 {
			mu.Lock()
			defer mu.Unlock()
			return r.Float64()
		}
	}
	return t, nil
}

// BaseURL returns the normalized base URL.
func (t *Transport) BaseURL() string { return t.baseURL }

// APIKeyConfigured reports whether requests carry a bearer token.
func (t *Transport) APIKeyConfigured() bool { return t.apiKey != "" }

func sleepContext(ctx context.Context, d time.Duration) error {
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// ResponseInfo describes the final response of a call.
type ResponseInfo struct {
	StatusCode int
	Header     http.Header
	RequestID  string
	URL        string
}

type requestOptions struct {
	timeout        time.Duration
	idleTimeout    time.Duration
	maxRetries     *int
	header         http.Header
	onResponse     func(ResponseInfo)
	idempotencyKey string
}

// RequestOption customizes one call.
type RequestOption func(*requestOptions)

// WithRequestTimeout overrides the per-attempt timeout for one call.
func WithRequestTimeout(d time.Duration) RequestOption {
	return func(o *requestOptions) { o.timeout = d }
}

// WithIdleTimeout aborts a streaming body that yields nothing for d (default 120 s).
func WithIdleTimeout(d time.Duration) RequestOption {
	return func(o *requestOptions) { o.idleTimeout = d }
}

// WithRetries overrides the retry budget for one call.
func WithRetries(n int) RequestOption {
	return func(o *requestOptions) { o.maxRetries = &n }
}

// WithHeader adds a header to one call.
func WithHeader(key, value string) RequestOption {
	return func(o *requestOptions) {
		if o.header == nil {
			o.header = http.Header{}
		}
		o.header.Set(key, value)
	}
}

// WithIdempotencyKey sets the Idempotency-Key of one call to an operation that
// accepts one (default: a fresh UUIDv4 per call, reused by its retries). Pass
// your own to retry a call across processes.
func WithIdempotencyKey(key string) RequestOption {
	return func(o *requestOptions) { o.idempotencyKey = key }
}

// NewIdempotencyKey returns a random UUIDv4 for the Idempotency-Key header.
func NewIdempotencyKey() string {
	var b [16]byte
	if _, err := crand.Read(b[:]); err != nil {
		panic(fmt.Sprintf("grad: reading random bytes for an Idempotency-Key: %v", err))
	}
	b[6] = b[6]&0x0f | 0x40
	b[8] = b[8]&0x3f | 0x80
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// WithLastEventID resumes a Server-Sent Events stream after the given event id.
func WithLastEventID(id string) RequestOption {
	return WithHeader("Last-Event-ID", id)
}

// WithResponseInfo receives the status, headers and request id of the final response.
func WithResponseInfo(fn func(ResponseInfo)) RequestOption {
	return func(o *requestOptions) { o.onResponse = fn }
}

// RequestSpec describes one HTTP call in wire terms.
type RequestSpec struct {
	Method string
	Path   string
	Query  url.Values
	Header http.Header
	// Body is JSON-encoded when non-nil.
	Body   any
	Accept string
	// Idempotent marks an operation that accepts an Idempotency-Key: it is sent
	// with one and retried like a GET.
	Idempotent bool
}

var errTimeout = errors.New("grad: request timed out")

var idempotent = map[string]bool{"GET": true, "HEAD": true, "PUT": true, "DELETE": true, "OPTIONS": true}

func retryableStatus(status int) bool {
	switch status {
	case 408, 429, 500, 502, 503, 504:
		return true
	}
	return false
}

// neverSent reports whether a transport error happened before any byte of the request was written.
func neverSent(err error) bool {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return true
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) {
		return opErr.Op == "dial"
	}
	return false
}

// Backoff is exponential (0.5 s, 1 s, 2 s, ... capped at 8 s) scaled into [50%, 100%] by jitter.
func (t *Transport) Backoff(attempt int) time.Duration {
	base := math.Min(8000, 500*math.Pow(2, float64(attempt)))
	return time.Duration(base*(0.5+t.rand()*0.5)) * time.Millisecond
}

func (t *Transport) buildURL(spec RequestSpec) string {
	u := t.baseURL + spec.Path
	if len(spec.Query) > 0 {
		if enc := spec.Query.Encode(); enc != "" {
			u += "?" + enc
		}
	}
	return u
}

type attempt struct {
	resp     *http.Response
	url      string
	cancel   context.CancelCauseFunc
	stop     func() bool
	attemptC context.Context
}

func (t *Transport) wait(ctx context.Context, d time.Duration, method, rawURL string) error {
	if err := t.sleep(ctx, d); err != nil {
		return &GradError{Code: "aborted", Message: fmt.Sprintf("%s %s was cancelled: %v", method, rawURL, err), Cause: err}
	}
	return nil
}

// send performs retries and same-origin redirects. On success the caller owns a.resp.Body and must call a.cancel.
// When streaming, the per-attempt timer stops once headers arrive.
func (t *Transport) send(ctx context.Context, spec RequestSpec, o *requestOptions, streaming bool) (*attempt, error) {
	method := strings.ToUpper(spec.Method)
	maxRetries := t.maxRetries
	if o.maxRetries != nil && *o.maxRetries >= 0 {
		maxRetries = *o.maxRetries
	}
	timeout := t.timeout
	if o.timeout > 0 {
		timeout = o.timeout
	}
	var payload []byte
	if spec.Body != nil {
		raw, err := json.Marshal(spec.Body)
		if err != nil {
			return nil, &GradError{Code: "invalid_request", Message: fmt.Sprintf("%s %s: encoding the request body: %v", method, spec.Path, err), Cause: err}
		}
		payload = raw
	}
	target := t.buildURL(spec)
	redirects := 0
	idemKey := o.idempotencyKey
	if idemKey == "" && spec.Idempotent && o.header.Get("Idempotency-Key") == "" {
		idemKey = NewIdempotencyKey()
	}
	keyed := idemKey != "" || o.header.Get("Idempotency-Key") != ""
	retrySafe := idempotent[method] || keyed

	for try := 0; ; try++ {
		if err := ctx.Err(); err != nil {
			return nil, &GradError{Code: "aborted", Message: fmt.Sprintf("%s %s was cancelled: %v", method, target, err), Cause: err}
		}
		attemptCtx, cancel := context.WithCancelCause(ctx)
		timer := time.AfterFunc(timeout, func() { cancel(errTimeout) })

		var body io.Reader
		if payload != nil {
			body = bytes.NewReader(payload)
		}
		req, err := http.NewRequestWithContext(attemptCtx, method, target, body)
		if err != nil {
			timer.Stop()
			cancel(nil)
			return nil, &GradError{Code: "invalid_request", Message: fmt.Sprintf("%s %s: %v", method, target, err), Cause: err}
		}
		for k, vs := range t.header {
			for _, v := range vs {
				req.Header.Add(k, v)
			}
		}
		req.Header.Set("User-Agent", t.userAgent)
		accept := spec.Accept
		if accept == "" {
			accept = "application/json"
		}
		req.Header.Set("Accept", accept)
		if t.apiKey != "" {
			req.Header.Set("Authorization", "Bearer "+t.apiKey)
		}
		if payload != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		for k, vs := range spec.Header {
			req.Header[http.CanonicalHeaderKey(k)] = vs
		}
		for k, vs := range o.header {
			req.Header[http.CanonicalHeaderKey(k)] = vs
		}
		if idemKey != "" {
			req.Header.Set("Idempotency-Key", idemKey)
		}

		resp, err := t.httpClient.Do(req)
		if err != nil {
			timer.Stop()
			timedOut := errors.Is(context.Cause(attemptCtx), errTimeout)
			cancel(nil)
			if ctx.Err() != nil {
				return nil, &GradError{Code: "aborted", Message: fmt.Sprintf("%s %s was cancelled: %v", method, target, ctx.Err()), Cause: ctx.Err()}
			}
			var wrapped error
			if timedOut {
				wrapped = &TimeoutError{&ConnectionError{&GradError{Code: "timeout", Message: fmt.Sprintf("%s %s timed out after %s", method, target, timeout), Cause: err}}}
			} else {
				wrapped = &ConnectionError{&GradError{Code: "connection_error", Message: fmt.Sprintf("%s %s failed: could not reach %s (%v). Is the server running? Check GRADIATED_BASE_URL or grad.WithBaseURL.", method, target, t.origin, err), Cause: err}}
			}
			if try < maxRetries && (retrySafe || (!timedOut && neverSent(err))) {
				if werr := t.wait(ctx, t.Backoff(try), method, target); werr != nil {
					return nil, werr
				}
				continue
			}
			return nil, wrapped
		}

		if resp.StatusCode >= 300 && resp.StatusCode < 400 && resp.StatusCode != http.StatusNotModified {
			timer.Stop()
			_, _ = io.Copy(io.Discard, io.LimitReader(resp.Body, 64<<10))
			resp.Body.Close()
			cancel(nil)
			loc, locErr := resp.Location()
			if locErr == nil && loc.Scheme+"://"+loc.Host == t.origin && (method == "GET" || method == "HEAD") && redirects < maxRedirects {
				redirects++
				target = loc.String()
				try--
				continue
			}
			where := "an unknown location"
			if locErr == nil {
				where = loc.String()
			}
			return nil, &RedirectError{&GradError{Status: resp.StatusCode, Code: "redirect_refused", RequestID: resp.Header.Get("X-Request-Id"),
				Message: fmt.Sprintf("%s %s was redirected (%d) to %s; refusing to follow a redirect that leaves %s or changes a %s request, so credentials are never sent elsewhere. Point GRADIATED_BASE_URL at the final URL.", method, target, resp.StatusCode, where, t.origin, method)}}
		}

		if resp.StatusCode < 200 || resp.StatusCode >= 300 {
			raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
			resp.Body.Close()
			timer.Stop()
			cancel(nil)
			apiErr := NewAPIError(resp.StatusCode, resp.Header, raw, method, target, t.apiKey != "")
			delay, hinted := ParseRetryAfter(resp.Header, time.Now())
			// 409 + Retry-After on a keyed request: the first attempt is still running server-side.
			inProgress := resp.StatusCode == http.StatusConflict && keyed && hinted
			// 429 queue_limit is the workspace's queued-jobs cap, not rate limiting: never retried.
			_, capped := apiErr.(*QueueLimitError)
			if !capped && ((retryableStatus(resp.StatusCode) && (retrySafe || resp.StatusCode == http.StatusTooManyRequests)) || inProgress) && try < maxRetries {
				if !hinted {
					delay = t.Backoff(try)
				}
				if delay <= MaxRetryAfter {
					if werr := t.wait(ctx, delay, method, target); werr != nil {
						return nil, werr
					}
					continue
				}
			}
			if o.onResponse != nil {
				o.onResponse(ResponseInfo{StatusCode: resp.StatusCode, Header: resp.Header, RequestID: resp.Header.Get("X-Request-Id"), URL: target})
			}
			return nil, apiErr
		}

		if streaming {
			timer.Stop()
		}
		if o.onResponse != nil {
			o.onResponse(ResponseInfo{StatusCode: resp.StatusCode, Header: resp.Header, RequestID: resp.Header.Get("X-Request-Id"), URL: target})
		}
		return &attempt{resp: resp, url: target, cancel: cancel, stop: timer.Stop, attemptC: attemptCtx}, nil
	}
}

func applyOptions(opts []RequestOption) *requestOptions {
	o := &requestOptions{}
	for _, opt := range opts {
		if opt != nil {
			opt(o)
		}
	}
	return o
}

// DoJSON sends the request and decodes a JSON response into out (which may be nil).
func (t *Transport) DoJSON(ctx context.Context, spec RequestSpec, out any, opts ...RequestOption) error {
	o := applyOptions(opts)
	a, err := t.send(ctx, spec, o, false)
	if err != nil {
		return err
	}
	defer a.cancel(nil)
	defer a.stop()
	defer a.resp.Body.Close()
	raw, err := io.ReadAll(a.resp.Body)
	method := strings.ToUpper(spec.Method)
	if err != nil {
		if ctx.Err() != nil {
			return &GradError{Code: "aborted", Message: fmt.Sprintf("%s %s was cancelled: %v", method, a.url, ctx.Err()), Cause: ctx.Err()}
		}
		if errors.Is(context.Cause(a.attemptC), errTimeout) {
			return &TimeoutError{&ConnectionError{&GradError{Code: "timeout", Message: fmt.Sprintf("%s %s timed out reading the response body", method, a.url), Cause: err}}}
		}
		return &ConnectionError{&GradError{Code: "connection_error", Message: fmt.Sprintf("%s %s failed while reading the response: %v", method, a.url, err), Cause: err}}
	}
	if out == nil || a.resp.StatusCode == http.StatusNoContent || len(bytes.TrimSpace(raw)) == 0 {
		return nil
	}
	if err := json.Unmarshal(raw, out); err != nil {
		snippet := string(raw)
		if len(snippet) > 200 {
			snippet = snippet[:200]
		}
		return &DecodeError{&GradError{Status: a.resp.StatusCode, Code: "invalid_json", RequestID: a.resp.Header.Get("X-Request-Id"),
			Message: fmt.Sprintf("%s %s returned %d with a body that does not decode: %v: %s", method, a.url, a.resp.StatusCode, err, snippet), Cause: err}}
	}
	return nil
}

// StreamResponse is a successful streaming response. Close it when done.
type StreamResponse struct {
	StatusCode int
	Header     http.Header
	RequestID  string
	URL        string
	// Body streams the response; read errors are typed (*TimeoutError when idle, *ConnectionError when broken).
	Body io.ReadCloser
}

type idleBody struct {
	body    io.ReadCloser
	timer   *time.Timer
	idle    time.Duration
	cancel  context.CancelCauseFunc
	ctx     context.Context
	parent  context.Context
	method  string
	url     string
	closeMu sync.Once
}

var errIdle = errors.New("grad: stream idle timeout")

func (b *idleBody) Read(p []byte) (int, error) {
	n, err := b.body.Read(p)
	if n > 0 {
		b.timer.Reset(b.idle)
	}
	if err != nil && err != io.EOF {
		switch {
		case b.parent.Err() != nil:
			return n, &GradError{Code: "aborted", Message: fmt.Sprintf("%s %s was cancelled: %v", b.method, b.url, b.parent.Err()), Cause: b.parent.Err()}
		case errors.Is(context.Cause(b.ctx), errIdle):
			return n, &TimeoutError{&ConnectionError{&GradError{Code: "timeout", Message: fmt.Sprintf("%s %s: the stream sent nothing for %s", b.method, b.url, b.idle), Cause: err}}}
		default:
			return n, &ConnectionError{&GradError{Code: "connection_error", Message: fmt.Sprintf("%s %s: the stream broke: %v", b.method, b.url, err), Cause: err}}
		}
	}
	return n, err
}

func (b *idleBody) Close() error {
	var err error
	b.closeMu.Do(func() {
		b.timer.Stop()
		err = b.body.Close()
		b.cancel(nil)
	})
	return err
}

// DoStream sends the request and returns the streaming body; the timeout covers only the headers.
func (t *Transport) DoStream(ctx context.Context, spec RequestSpec, opts ...RequestOption) (*StreamResponse, error) {
	o := applyOptions(opts)
	a, err := t.send(ctx, spec, o, true)
	if err != nil {
		return nil, err
	}
	idle := o.idleTimeout
	if idle <= 0 {
		idle = DefaultIdleTimeout
	}
	body := &idleBody{body: a.resp.Body, idle: idle, cancel: a.cancel, ctx: a.attemptC, parent: ctx, method: strings.ToUpper(spec.Method), url: a.url}
	body.timer = time.AfterFunc(idle, func() { a.cancel(errIdle) })
	return &StreamResponse{StatusCode: a.resp.StatusCode, Header: a.resp.Header, RequestID: a.resp.Header.Get("X-Request-Id"), URL: a.url, Body: body}, nil
}

// SSEEvent is one Server-Sent Event.
type SSEEvent struct {
	Event string
	Data  string
	ID    string
	// Retry is the server's reconnection hint (0 when absent).
	Retry time.Duration
}

// SSEStream reads events from one connection: for stream.Next() { e := stream.Event() }; check stream.Err().
type SSEStream struct {
	resp   *StreamResponse
	reader *bufio.Reader
	event  SSEEvent
	err    error
	lastID string
}

// DoSSE opens a Server-Sent Events stream (use WithLastEventID to resume).
func (t *Transport) DoSSE(ctx context.Context, spec RequestSpec, opts ...RequestOption) (*SSEStream, error) {
	spec.Accept = "text/event-stream"
	resp, err := t.DoStream(ctx, spec, opts...)
	if err != nil {
		return nil, err
	}
	return &SSEStream{resp: resp, reader: bufio.NewReader(resp.Body)}, nil
}

// Next advances to the next event; it returns false at the end of the stream or on error.
func (s *SSEStream) Next() bool {
	if s.err != nil {
		return false
	}
	var event string
	var data []string
	var retry time.Duration
	hasData := false
	for {
		line, err := s.reader.ReadString('\n')
		if err != nil && (err != io.EOF || line == "") {
			if err != io.EOF {
				s.err = err
			} else {
				s.err = io.EOF
			}
			return false
		}
		line = strings.TrimRight(line, "\r\n")
		if line == "" {
			if hasData || event != "" {
				if event == "" {
					event = "message"
				}
				s.event = SSEEvent{Event: event, Data: strings.Join(data, "\n"), ID: s.lastID, Retry: retry}
				return true
			}
			continue
		}
		if strings.HasPrefix(line, ":") {
			continue
		}
		field, value, found := strings.Cut(line, ":")
		if found {
			value = strings.TrimPrefix(value, " ")
		}
		switch field {
		case "event":
			event = value
		case "data":
			data = append(data, value)
			hasData = true
		case "id":
			if !strings.Contains(value, "\x00") {
				s.lastID = value
			}
		case "retry":
			if ms, err := strconv.Atoi(value); err == nil {
				retry = time.Duration(ms) * time.Millisecond
			}
		}
	}
}

// Event returns the current event.
func (s *SSEStream) Event() SSEEvent { return s.event }

// Err returns the error that ended the stream (nil for a clean end).
func (s *SSEStream) Err() error {
	if s.err == io.EOF {
		return nil
	}
	return s.err
}

// LastEventID is the id of the last event received (send it as Last-Event-ID to resume).
func (s *SSEStream) LastEventID() string { return s.lastID }

// Close releases the connection.
func (s *SSEStream) Close() error { return s.resp.Body.Close() }

// ---------------------------------------------------------------- helpers used by generated code

// EscapePathParam percent-encodes a path segment and rejects empty, "." and "..".
func EscapePathParam(name, value string) (string, error) {
	if value == "" || value == "." || value == ".." {
		return "", &GradError{Code: "invalid_path_parameter", Message: fmt.Sprintf("path parameter %q must be a non-empty value other than '.' or '..'", name)}
	}
	return url.PathEscape(value), nil
}

// FormatScalar renders a query or header value (booleans as true/false).
func FormatScalar(v any) string {
	switch x := v.(type) {
	case string:
		return x
	case bool:
		return strconv.FormatBool(x)
	case int:
		return strconv.Itoa(x)
	case int64:
		return strconv.FormatInt(x, 10)
	case float64:
		return strconv.FormatFloat(x, 'f', -1, 64)
	case fmt.Stringer:
		return x.String()
	}
	return fmt.Sprint(v)
}

// MarshalWithAdditional encodes known fields plus additional properties into one object.
func MarshalWithAdditional(known any, extra map[string]any) ([]byte, error) {
	raw, err := json.Marshal(known)
	if err != nil || len(extra) == 0 {
		return raw, err
	}
	merged := map[string]json.RawMessage{}
	if err := json.Unmarshal(raw, &merged); err != nil {
		return nil, err
	}
	for k, v := range extra {
		if _, exists := merged[k]; exists {
			continue
		}
		enc, err := json.Marshal(v)
		if err != nil {
			return nil, err
		}
		merged[k] = enc
	}
	return json.Marshal(merged)
}

// AdditionalFields returns the members of a JSON object that are not in known.
func AdditionalFields(data []byte, known map[string]bool) (map[string]any, error) {
	all := map[string]any{}
	if err := json.Unmarshal(data, &all); err != nil {
		return nil, err
	}
	var extra map[string]any
	for k, v := range all {
		if !known[k] {
			if extra == nil {
				extra = map[string]any{}
			}
			extra[k] = v
		}
	}
	return extra, nil
}

// Ptr returns a pointer to v (handy for optional fields).
func Ptr[T any](v T) *T { return &v }
