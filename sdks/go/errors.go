package grad

import (
	"errors"
	"fmt"
	"net/http"
	"time"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// Error types. Every error the SDK returns unwraps to *GradError, so
//
//	var gerr *grad.GradError
//	if errors.As(err, &gerr) { log.Println(gerr.Status, gerr.Code, gerr.RequestID) }
//
// works for all of them; match a specific case with, for example, *grad.NotFoundError.
type (
	// GradError is the base of every SDK error (Status 0 when no response was received).
	GradError = generated.GradError
	// APIError is any non-2xx response, parsed from problem+json.
	APIError = generated.APIError
	// FieldError is one field-level validation failure of a 422 response.
	FieldError = generated.FieldError
	// BadRequestError is a 400 response.
	BadRequestError = generated.BadRequestError
	// AuthenticationError is a 401 response.
	AuthenticationError = generated.AuthenticationError
	// PermissionDeniedError is a 403 response.
	PermissionDeniedError = generated.PermissionDeniedError
	// NotFoundError is a 404 response.
	NotFoundError = generated.NotFoundError
	// ConflictError is a 409 response.
	ConflictError = generated.ConflictError
	// ValidationError is a 422 response with FieldErrors.
	ValidationError = generated.ValidationError
	// RateLimitError is a 429 response.
	RateLimitError = generated.RateLimitError
	// ServerError is a 5xx response.
	ServerError = generated.ServerError
	// InferenceUnavailableError is 501 inference_unavailable: no inference endpoint is configured.
	InferenceUnavailableError = generated.InferenceUnavailableError
	// ConnectionError means no response was received.
	ConnectionError = generated.ConnectionError
	// TimeoutError means a request timed out or a stream went idle.
	TimeoutError = generated.TimeoutError
	// RedirectError means a redirect was refused (it would leave the API origin or change a non-GET request).
	RedirectError = generated.RedirectError
	// DecodeError means a 2xx body could not be decoded.
	DecodeError = generated.DecodeError
)

// ErrChecksumMismatch matches any *ChecksumMismatchError with errors.Is.
var ErrChecksumMismatch = errors.New("grad: artifact checksum mismatch")

// ChecksumMismatchError means a download's SHA-256 does not match X-Artifact-Sha256
// (or the header is missing or malformed). Nothing is written to the destination.
type ChecksumMismatchError struct {
	*GradError
	Expected string
	Actual   string
}

// Unwrap exposes the embedded *GradError.
func (e *ChecksumMismatchError) Unwrap() error { return e.GradError }

// Is reports whether target is ErrChecksumMismatch.
func (e *ChecksumMismatchError) Is(target error) bool { return target == ErrChecksumMismatch }

// RunFailedError is returned by Run.Wait when a run ends failed, cancelled, stopped_budget or stopped_balance.
// Run carries the final state (for stopped_budget, raise the cap with Run.Resume).
type RunFailedError struct {
	*GradError
	Run *Run
}

// Unwrap exposes the embedded *GradError.
func (e *RunFailedError) Unwrap() error { return e.GradError }

// EvalFailedError is returned by Eval.Wait when an eval ends failed or cancelled.
type EvalFailedError struct {
	*GradError
	Eval *Eval
}

// Unwrap exposes the embedded *GradError.
func (e *EvalFailedError) Unwrap() error { return e.GradError }

// ImportFailedError is returned by ImportHandle.Wait when an import job fails.
type ImportFailedError struct {
	*GradError
	Job *ImportJob
}

// Unwrap exposes the embedded *GradError.
func (e *ImportFailedError) Unwrap() error { return e.GradError }

// ArtifactImportFailedError is returned by ArtifactImport.Wait when an upload or HF
// import fails. Code is "invalid_artifact" (Status 422) when the files break the
// format spec or don't fit the base model; the message names the file.
type ArtifactImportFailedError struct {
	*GradError
	Job *generated.ArtifactImport
}

// Unwrap exposes the embedded *GradError.
func (e *ArtifactImportFailedError) Unwrap() error { return e.GradError }

// WaitTimeoutError is returned when WithWaitTimeout elapses before a terminal status.
type WaitTimeoutError struct {
	*GradError
	// LastStatus is the last status observed.
	LastStatus string
}

// Unwrap exposes the embedded *GradError.
func (e *WaitTimeoutError) Unwrap() error { return e.GradError }

func newError(code, format string, args ...any) *GradError {
	return &GradError{Code: code, Message: "grad: " + fmt.Sprintf(format, args...)}
}

// IsNotFound reports whether err is a 404.
func IsNotFound(err error) bool {
	var nf *NotFoundError
	return errors.As(err, &nf)
}

// isTransient reports whether polling should keep going after err.
func isTransient(err error) bool {
	var conn *ConnectionError
	if errors.As(err, &conn) {
		return true
	}
	var timeout *TimeoutError
	if errors.As(err, &timeout) {
		return true
	}
	var api *APIError
	if errors.As(err, &api) {
		switch api.Status {
		case http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusInternalServerError,
			http.StatusBadGateway, http.StatusServiceUnavailable, http.StatusGatewayTimeout:
			return true
		}
	}
	return false
}

// retryDelay is the server's Retry-After hint when err carries one.
func retryDelay(err error) time.Duration {
	var api *APIError
	if errors.As(err, &api) {
		return api.RetryAfter
	}
	return 0
}
