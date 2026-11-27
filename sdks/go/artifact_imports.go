package grad

import (
	"archive/tar"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/Gradiated/grad/sdks/go/generated"
)

// ArtifactImport is an upload or Hugging Face import that an import worker
// validates against the format spec and releases as an Artifact. Wait returns it.
type ArtifactImport struct {
	generated.ArtifactImport
	c *Client
}

// Done reports whether the import completed or failed.
func (i *ArtifactImport) Done() bool {
	return i.Status == generated.ArtifactImportStatusCompleted || i.Status == generated.ArtifactImportStatusFailed
}

// Wait polls until the import finishes and returns the artifact; a failure
// returns *ArtifactImportFailedError (Code "invalid_artifact", Status 422, for
// files that break the format spec; the message names the file).
func (i *ArtifactImport) Wait(ctx context.Context, opts ...WaitOption) (*Artifact, error) {
	return i.c.Artifacts.WaitImport(ctx, i.ID, opts...)
}

// UploadParams configures ArtifactsService.Upload.
type UploadParams struct {
	// Base is the catalog base model the files were trained on (required).
	Base string
	// Format is peft_lora (default), merged_safetensors, cartridge,
	// encoder_safetensors, router_bundle, decision_bundle or reward_bundle.
	Format string
	// Name is the artifact name (default: the file or directory name).
	Name           string
	IdempotencyKey string
}

// FromHFParams configures ArtifactsService.FromHF.
type FromHFParams struct {
	// Base is the catalog base model the weights were trained on (required).
	Base   string
	Format string
	// Name is the artifact name (default: the repo's name).
	Name string
	// Revision is a branch, tag or commit (or pass hf://owner/name@revision).
	Revision string
	// Secret names a workspace secret holding an HF token (gated or private repos).
	Secret         string
	IdempotencyKey string
}

var hfURI = regexp.MustCompile(`^(?:hf://)?([A-Za-z0-9][\w.-]*(?:/[A-Za-z0-9][\w.-]*)?)(?:@([^@\s]+))?$`)

// ParseHFURI splits hf://owner/name[@revision] (or owner/name) into the repo and revision.
func ParseHFURI(uri, revision string) (repo, rev string, err error) {
	m := hfURI.FindStringSubmatch(strings.TrimSpace(uri))
	if m == nil || strings.Contains(m[1], "..") {
		return "", "", newError("invalid_hf_uri", "grad: %q is not a Hugging Face repo: use hf://owner/name or hf://owner/name@revision", uri)
	}
	if m[2] != "" && revision != "" && m[2] != revision {
		return "", "", newError("invalid_hf_uri", "grad: %q pins revision %q, but revision %q was passed too", uri, m[2], revision)
	}
	if m[2] != "" {
		return m[1], m[2], nil
	}
	return m[1], revision, nil
}

var slugJunk = regexp.MustCompile(`[^a-z0-9._-]+`)

// artifactName is an upload's default name: its file or directory name as a slug.
func artifactName(path string) string {
	base := filepath.Base(filepath.Clean(path))
	for _, suffix := range []string{".grad.tar.gz", ".tar.gz", ".tgz", ".tar"} {
		if strings.HasSuffix(base, suffix) {
			base = strings.TrimSuffix(base, suffix)
			break
		}
	}
	slug := strings.TrimLeft(slugJunk.ReplaceAllString(strings.ToLower(base), "-"), "-._")
	if len(slug) > 64 {
		slug = slug[:64]
	}
	if slug = strings.TrimRight(slug, "-._"); slug == "" {
		return "upload"
	}
	return slug
}

func isArchive(path string) bool {
	return strings.HasSuffix(path, ".tar.gz") || strings.HasSuffix(path, ".tgz") || strings.HasSuffix(path, ".tar")
}

// packArtifact returns the file to upload for path: a .tar/.tar.gz as is, else
// a gzip tar of the directory's regular files (sorted, relative paths) or of the
// single file. cleanup removes the temporary archive.
func packArtifact(path string) (string, func(), error) {
	info, err := os.Lstat(path)
	if err != nil {
		return "", nil, fmt.Errorf("grad: %w", err)
	}
	if info.Mode().IsRegular() && isArchive(path) {
		return path, func() {}, nil
	}
	root, names := filepath.Dir(path), []string{filepath.Base(path)}
	switch {
	case info.IsDir():
		root, names = path, nil
		err = filepath.WalkDir(path, func(p string, d fs.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if d.Type()&fs.ModeSymlink != 0 {
				return fmt.Errorf("refusing to upload symlink %s; copy the file instead", p)
			}
			if d.Type().IsRegular() {
				rel, _ := filepath.Rel(path, p)
				names = append(names, filepath.ToSlash(rel))
			}
			return nil
		})
		if err != nil {
			return "", nil, fmt.Errorf("grad: %w", err)
		}
		if len(names) == 0 {
			return "", nil, newError("empty_upload", "grad: %s has no files to upload", path)
		}
		sort.Strings(names)
	case !info.Mode().IsRegular():
		return "", nil, newError("file_not_found", "grad: %s is not a file or directory", path)
	}
	dir, err := os.MkdirTemp("", "grad-upload-")
	if err != nil {
		return "", nil, fmt.Errorf("grad: %w", err)
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	out := filepath.Join(dir, "upload.tar.gz")
	if err := writeTarGz(out, root, names); err != nil {
		cleanup()
		return "", nil, fmt.Errorf("grad: packing %s: %w", path, err)
	}
	return out, cleanup, nil
}

func writeTarGz(out, root string, names []string) error {
	f, err := os.Create(out)
	if err != nil {
		return err
	}
	defer f.Close()
	gz := gzip.NewWriter(f)
	tw := tar.NewWriter(gz)
	for _, name := range names {
		src, err := os.Open(filepath.Join(root, filepath.FromSlash(name)))
		if err != nil {
			return err
		}
		st, err := src.Stat()
		if err == nil {
			err = tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: st.Size(), Typeflag: tar.TypeReg, Format: tar.FormatPAX})
		}
		if err == nil {
			_, err = io.Copy(tw, src)
		}
		src.Close()
		if err != nil {
			return err
		}
	}
	if err := tw.Close(); err != nil {
		return err
	}
	if err := gz.Close(); err != nil {
		return err
	}
	return f.Close()
}

func (s *ArtifactsService) create(ctx context.Context, body *generated.CreateArtifactImportRequest, key string) (*ArtifactImport, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	job, err := api.CreateArtifactImport(ctx, body, idempotency(key)...)
	if err != nil {
		return nil, err
	}
	return &ArtifactImport{ArtifactImport: *job, c: s.c}, nil
}

func importFormat(format string) *generated.ImportableArtifactFormat {
	if format == "" {
		format = "peft_lora"
	}
	return ptr(generated.ImportableArtifactFormat(format))
}

// Upload registers local weights (a directory, a file or a .tar.gz) as an
// artifact: the client uploads them through a presigned PUT and an import
// worker checks them against the format spec and p.Base (for peft_lora: the
// adapter config, base model and revision, target modules and every tensor
// shape). Wait on the result for the Artifact.
func (s *ArtifactsService) Upload(ctx context.Context, path string, p UploadParams) (*ArtifactImport, error) {
	if p.Base == "" {
		return nil, newError("invalid_argument", "grad: Upload needs UploadParams.Base (a catalog base model id)")
	}
	name := p.Name
	if name == "" {
		name = artifactName(path)
	}
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	packed, cleanup, err := packArtifact(path)
	if err != nil {
		return nil, err
	}
	defer cleanup()
	f, err := os.Open(packed)
	if err != nil {
		return nil, fmt.Errorf("grad: %w", err)
	}
	defer f.Close()
	h := sha256.New()
	size, err := io.Copy(h, f)
	if err != nil {
		return nil, fmt.Errorf("grad: hashing %s: %w", packed, err)
	}
	ticket, err := api.CreateUpload(ctx, &generated.CreateUploadRequest{
		Purpose:   generated.CreateUploadRequestPurposeArtifactImport,
		Filename:  filepath.Base(packed),
		SizeBytes: int(size),
		SHA256:    hex.EncodeToString(h.Sum(nil)),
	})
	if err != nil {
		return nil, err
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return nil, fmt.Errorf("grad: %w", err)
	}
	if err := s.c.upload(ctx, ticket, f, size); err != nil {
		return nil, err
	}
	return s.create(ctx, &generated.CreateArtifactImportRequest{
		Source:    generated.ArtifactImportSource{Kind: generated.ArtifactImportSourceKindUpload, UploadID: &ticket.UploadID},
		BaseModel: p.Base,
		Format:    importFormat(p.Format),
		Name:      &name,
	}, p.IdempotencyKey)
}

// FromHF imports weights from the Hugging Face Hub (hf://owner/name[@revision]),
// pinned to the commit the revision resolves to; the same checks as Upload.
func (s *ArtifactsService) FromHF(ctx context.Context, uri string, p FromHFParams) (*ArtifactImport, error) {
	if p.Base == "" {
		return nil, newError("invalid_argument", "grad: FromHF needs FromHFParams.Base (a catalog base model id)")
	}
	repo, rev, err := ParseHFURI(uri, p.Revision)
	if err != nil {
		return nil, err
	}
	return s.create(ctx, &generated.CreateArtifactImportRequest{
		Source:    generated.ArtifactImportSource{Kind: generated.ArtifactImportSourceKindHF, Repo: &repo, Revision: optString(rev), Secret: optString(p.Secret)},
		BaseModel: p.Base,
		Format:    importFormat(p.Format),
		Name:      optString(p.Name),
	}, p.IdempotencyKey)
}

// GetImport fetches an upload or HF import.
func (s *ArtifactsService) GetImport(ctx context.Context, id string) (*ArtifactImport, error) {
	api, err := s.c.api()
	if err != nil {
		return nil, err
	}
	job, err := api.GetArtifactImport(ctx, id)
	if err != nil {
		return nil, err
	}
	return &ArtifactImport{ArtifactImport: *job, c: s.c}, nil
}

// WaitImport polls an upload or HF import until it finishes and returns its
// artifact; see ArtifactImport.Wait.
func (s *ArtifactsService) WaitImport(ctx context.Context, id string, opts ...WaitOption) (*Artifact, error) {
	var job *ArtifactImport
	err := s.c.poll(ctx, newWaitConfig(opts), "artifact import "+id, func(ctx context.Context) (string, bool, error) {
		j, err := s.GetImport(ctx, id)
		if err != nil {
			return "", false, err
		}
		job = j
		return string(j.Status), j.Done(), nil
	})
	if err != nil {
		return nil, err
	}
	if job.Status == generated.ArtifactImportStatusFailed || job.ArtifactID == nil {
		code, status, msg := "artifact_import_failed", 0, "unknown error"
		if job.ErrorCode != nil {
			code = *job.ErrorCode
		}
		if code == "invalid_artifact" {
			status = 422
		}
		if job.Error != nil {
			msg = *job.Error
		}
		failure := newError(code, "artifact import %s (%q) failed: %s", job.ID, job.Name, msg)
		failure.Status = status
		return nil, &ArtifactImportFailedError{GradError: failure, Job: &job.ArtifactImport}
	}
	return s.Get(ctx, *job.ArtifactID)
}
