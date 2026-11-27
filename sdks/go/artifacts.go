package grad

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"hash"
	"io"
	"iter"
	"mime"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// Wire types re-exported for convenience.
type (
	// Deployment is a stable model name pointing at an artifact version.
	Deployment = generated.Deployment
	// DeploymentStatus is a deployment plus its feedback statistics.
	DeploymentStatus = generated.DeploymentStatus
	// TrainableModel is a catalog model.
	TrainableModel = generated.TrainableModel
	// APIKey is a scoped API key (without its secret).
	APIKey = generated.APIKey
	// CreatedAPIKey is a new key and its one-time secret.
	CreatedAPIKey = generated.CreatedAPIKey
)

// Artifact is an immutable trained bundle (adapter weights, manifest, eval report).
type Artifact struct {
	generated.Artifact
	c *Client
}

func (c *Client) artifact(a *generated.Artifact) *Artifact { return &Artifact{Artifact: *a, c: c} }

// Ref is "name@version".
func (a *Artifact) Ref() string { return a.Name + "@" + a.Version }

// ArtifactsService reads and downloads artifacts.
type ArtifactsService struct{ c *Client }

// Get fetches an artifact by id, "name@version" or "name@latest".
func (s *ArtifactsService) Get(ctx context.Context, ref string) (*Artifact, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	a, err := api.GetArtifact(ctx, ref)
	if err != nil {
		return nil, err
	}
	return s.c.artifact(a), nil
}

// List iterates over artifacts; name "" lists all.
func (s *ArtifactsService) List(ctx context.Context, name string) iter.Seq2[*Artifact, error] {
	return paginate(ctx, func(ctx context.Context, cursor *string) ([]*Artifact, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		page, err := api.ListArtifacts(ctx, &generated.ListArtifactsParams{Cursor: cursor, Name: optString(name)})
		if err != nil {
			return nil, nil, err
		}
		out := make([]*Artifact, len(page.Data))
		for i := range page.Data {
			out[i] = s.c.artifact(&page.Data[i])
		}
		return out, page.NextCursor, nil
	})
}

// Download is the result of a verified download.
type Download struct {
	Path      string
	SHA256    string
	SizeBytes int64
}

type downloadConfig struct{ verify bool }

// DownloadOption configures Download.
type DownloadOption func(*downloadConfig)

// SkipChecksum disables SHA-256 verification (not recommended).
func SkipChecksum() DownloadOption { return func(d *downloadConfig) { d.verify = false } }

var hex64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

func expectedSHA(resp *generated.StreamResponse) (string, error) {
	expected := strings.ToLower(strings.TrimSpace(resp.Header.Get("X-Artifact-Sha256")))
	if !hex64.MatchString(expected) {
		return "", &ChecksumMismatchError{GradError: &GradError{Code: "invalid_checksum_header", RequestID: resp.RequestID,
			Message: fmt.Sprintf("grad: %s returned no valid X-Artifact-Sha256 header (got %q); refusing an unverifiable download", resp.URL, expected)}, Expected: expected}
	}
	return expected, nil
}

var unsafeFileChars = regexp.MustCompile(`[^A-Za-z0-9._@-]+`)

func downloadFileName(resp *generated.StreamResponse, ref string) string {
	if _, params, err := mime.ParseMediaType(resp.Header.Get("Content-Disposition")); err == nil {
		name := filepath.Base(params["filename"])
		if name != "" && name != "." && name != ".." && name != string(filepath.Separator) {
			return unsafeFileChars.ReplaceAllString(name, "_")
		}
	}
	return unsafeFileChars.ReplaceAllString(ref, "_") + ".grad.tar.gz"
}

// Download streams an artifact bundle (.grad.tar.gz) to dest, verifying its SHA-256
// against X-Artifact-Sha256 while writing a temp file next to it, then renames it into
// place. dest may be a file path, or a directory (existing, or ending in a separator)
// that receives <name>-<version>.grad.tar.gz. On mismatch nothing is left behind and
// the error matches ErrChecksumMismatch.
func (s *ArtifactsService) Download(ctx context.Context, ref, dest string, opts ...DownloadOption) (*Download, error) {
	cfg := &downloadConfig{verify: true}
	for _, opt := range opts {
		opt(cfg)
	}
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	resp, err := api.DownloadArtifact(ctx, ref)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	expected := ""
	if cfg.verify {
		if expected, err = expectedSHA(resp); err != nil {
			return nil, err
		}
	}

	if dest == "" {
		dest = "."
	}
	final := dest
	if info, statErr := os.Stat(dest); (statErr == nil && info.IsDir()) || strings.HasSuffix(dest, string(filepath.Separator)) || strings.HasSuffix(dest, "/") {
		final = filepath.Join(dest, downloadFileName(resp, ref))
	}
	dir := filepath.Dir(final)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("grad: %w", err)
	}
	tmp, err := os.CreateTemp(dir, ".grad-download-*")
	if err != nil {
		return nil, fmt.Errorf("grad: %w", err)
	}
	keep := false
	defer func() {
		if !keep {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	h := sha256.New()
	n, err := io.Copy(io.MultiWriter(tmp, h), resp.Body)
	if err != nil {
		return nil, err
	}
	if err := tmp.Sync(); err != nil {
		return nil, fmt.Errorf("grad: %w", err)
	}
	if err := tmp.Close(); err != nil {
		return nil, fmt.Errorf("grad: %w", err)
	}
	actual := hex.EncodeToString(h.Sum(nil))
	if cfg.verify && actual != expected {
		return nil, &ChecksumMismatchError{GradError: &GradError{Code: "checksum_mismatch", RequestID: resp.RequestID,
			Message: fmt.Sprintf("grad: artifact %s SHA-256 mismatch: expected %s, got %s; the download was discarded", ref, expected, actual)}, Expected: expected, Actual: actual}
	}
	if err := os.Chmod(tmp.Name(), 0o644); err != nil {
		return nil, fmt.Errorf("grad: %w", err)
	}
	if err := os.Rename(tmp.Name(), final); err != nil {
		return nil, fmt.Errorf("grad: %w", err)
	}
	keep = true
	if d, err := os.Open(dir); err == nil {
		_ = d.Sync()
		d.Close()
	}
	return &Download{Path: final, SHA256: actual, SizeBytes: n}, nil
}

// ArtifactStream is an open artifact download; reading to EOF verifies the SHA-256.
type ArtifactStream struct {
	// Body returns *ChecksumMismatchError instead of io.EOF when the bytes don't match.
	Body io.ReadCloser
	// SHA256 is the expected digest from X-Artifact-Sha256.
	SHA256 string
	// FileName is the server's suggested file name.
	FileName string
	// SizeBytes is the Content-Length (-1 when unknown).
	SizeBytes int64
}

type verifyingReader struct {
	body     io.ReadCloser
	h        hash.Hash
	expected string
	ref      string
	done     bool
}

func (v *verifyingReader) Read(p []byte) (int, error) {
	n, err := v.body.Read(p)
	v.h.Write(p[:n])
	if errors.Is(err, io.EOF) && !v.done {
		v.done = true
		if actual := hex.EncodeToString(v.h.Sum(nil)); actual != v.expected {
			return n, &ChecksumMismatchError{GradError: &GradError{Code: "checksum_mismatch",
				Message: fmt.Sprintf("grad: artifact %s SHA-256 mismatch: expected %s, got %s", v.ref, v.expected, actual)}, Expected: v.expected, Actual: actual}
		}
	}
	return n, err
}

func (v *verifyingReader) Close() error { return v.body.Close() }

// Open streams an artifact without writing it to disk (verification happens at EOF).
func (s *ArtifactsService) Open(ctx context.Context, ref string) (*ArtifactStream, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	resp, err := api.DownloadArtifact(ctx, ref)
	if err != nil {
		return nil, err
	}
	expected, err := expectedSHA(resp)
	if err != nil {
		resp.Body.Close()
		return nil, err
	}
	size := int64(-1)
	if n, perr := fmt.Sscan(resp.Header.Get("Content-Length"), &size); n != 1 || perr != nil {
		size = -1
	}
	return &ArtifactStream{Body: &verifyingReader{body: resp.Body, h: sha256.New(), expected: expected, ref: ref}, SHA256: expected, FileName: downloadFileName(resp, ref), SizeBytes: size}, nil
}

// Download streams this artifact to dest; see ArtifactsService.Download.
func (a *Artifact) Download(ctx context.Context, dest string, opts ...DownloadOption) (*Download, error) {
	return a.c.Artifacts.Download(ctx, a.ID, dest, opts...)
}

// Deploy publishes this artifact (Cloud; self-hosted servers return *DeployUnavailableError).
func (a *Artifact) Deploy(ctx context.Context, opts ...DeployOption) (*Deployment, error) {
	return a.c.Deployments.Create(ctx, a.ID, opts...)
}

type deployConfig struct {
	name           string
	fallback       string
	exploreRate    *float64
	idempotencyKey string
}

// DeployOption configures a deployment.
type DeployOption func(*deployConfig)

// WithDeploymentName publishes under this name (default: the artifact's name).
func WithDeploymentName(name string) DeployOption { return func(d *deployConfig) { d.name = name } }

// WithFallback sets the model that receives traffic when a router cannot serve.
func WithFallback(model string) DeployOption { return func(d *deployConfig) { d.fallback = model } }

// WithExploreRate routes this share of traffic to exploration (routers).
func WithExploreRate(rate float64) DeployOption {
	return func(d *deployConfig) { d.exploreRate = &rate }
}

// WithDeployIdempotencyKey makes a retried deploy replay the first one.
func WithDeployIdempotencyKey(key string) DeployOption {
	return func(d *deployConfig) { d.idempotencyKey = key }
}

// DeploymentsService manages deployments (Gradiated Cloud).
type DeploymentsService struct{ c *Client }

// Create points a deployment at an artifact (deploying an earlier version rolls back).
func (s *DeploymentsService) Create(ctx context.Context, artifact string, opts ...DeployOption) (*Deployment, error) {
	cfg := &deployConfig{}
	for _, opt := range opts {
		opt(cfg)
	}
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	return api.DeployArtifact(ctx, &generated.DeployArtifactRequest{Artifact: artifact, Name: optString(cfg.name), Fallback: optString(cfg.fallback), ExploreRate: cfg.exploreRate},
		idempotency(cfg.idempotencyKey)...)
}

// Get returns a deployment with its feedback statistics.
func (s *DeploymentsService) Get(ctx context.Context, name string) (*DeploymentStatus, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	return api.GetDeployment(ctx, name)
}

// List iterates over deployments.
func (s *DeploymentsService) List(ctx context.Context) iter.Seq2[*Deployment, error] {
	return paginate(ctx, func(ctx context.Context, cursor *string) ([]*Deployment, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		page, err := api.ListDeployments(ctx, &generated.ListDeploymentsParams{Cursor: cursor})
		if err != nil {
			return nil, nil, err
		}
		return pointers(page.Data), page.NextCursor, nil
	})
}

// Rollback points the deployment back at its previous artifact.
func (s *DeploymentsService) Rollback(ctx context.Context, name string) (*Deployment, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	return api.RollbackDeployment(ctx, name)
}

// ModelsService lists trainable models.
type ModelsService struct{ c *Client }

// List returns the trainable model catalog.
func (s *ModelsService) List(ctx context.Context) ([]TrainableModel, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	resp, err := api.ListBaseModels(ctx)
	if err != nil {
		return nil, err
	}
	return resp.Data, nil
}

// KeysService manages scoped API keys.
type KeysService struct{ c *Client }

// Create mints a key; Secret is shown only once.
func (s *KeysService) Create(ctx context.Context, name string, scopes ...string) (*CreatedAPIKey, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	req := &generated.CreateAPIKeyRequest{Name: name, Scopes: make([]generated.APIKeyScope, len(scopes))}
	for i, sc := range scopes {
		req.Scopes[i] = generated.APIKeyScope(sc)
	}
	return api.CreateAPIKey(ctx, req)
}

// List iterates over keys.
func (s *KeysService) List(ctx context.Context) iter.Seq2[*APIKey, error] {
	return paginate(ctx, func(ctx context.Context, cursor *string) ([]*APIKey, *string, error) {
		api, err := s.c.api()
		if err != nil {
			return nil, nil, err
		}
		page, err := api.ListAPIKeys(ctx, &generated.ListAPIKeysParams{Cursor: cursor})
		if err != nil {
			return nil, nil, err
		}
		return pointers(page.Data), page.NextCursor, nil
	})
}

// Revoke disables a key.
func (s *KeysService) Revoke(ctx context.Context, id string) (*APIKey, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	return api.RevokeAPIKey(ctx, id)
}
