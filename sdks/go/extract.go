package grad

import (
	"archive/tar"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Limits on what Extract writes (the same as the Python SDK's).
const (
	maxBundleMembers = 10_000
	maxExtractBytes  = 512 << 30
)

// reservedBundleFiles are bundle files manifest.json does not list.
var reservedBundleFiles = map[string]bool{"manifest.json": true, "eval_report.json": true}

// Extract makes Download write the bundle's files (for an LLM artifact, the PEFT adapter
// that vLLM and SGLang load) into dest, a directory that must not exist or be empty, instead
// of the .grad.tar.gz. Only regular files with safe relative paths are written, and every
// file must match the SHA-256 that manifest.json lists; on any failure dest is left as it was.
func Extract() DownloadOption { return func(d *downloadConfig) { d.extract = true } }

func unsafeArchive(format string, args ...any) error {
	return newError("unsafe_archive", format, args...)
}

func memberName(name string) (string, error) {
	if name == "" || strings.ContainsAny(name, "\x00\\") || strings.HasPrefix(name, "/") || (len(name) > 1 && name[1] == ':') {
		return "", unsafeArchive("refusing to extract unsafe archive entry %q", name)
	}
	parts := strings.Split(strings.TrimSuffix(name, "/"), "/")
	for _, p := range parts {
		if p == "" || p == "." || p == ".." {
			return "", unsafeArchive("refusing to extract unsafe archive entry %q (path traversal)", name)
		}
	}
	return strings.Join(parts, "/"), nil
}

// extractBundle writes a .grad.tar.gz into the empty directory dest and checks every file
// against manifest.json.
func extractBundle(archive, dest string) error {
	f, err := os.Open(archive)
	if err != nil {
		return fmt.Errorf("grad: %w", err)
	}
	defer f.Close()
	gz, err := gzip.NewReader(f)
	if err != nil {
		return unsafeArchive("the download is not a .grad.tar.gz bundle: %v", err)
	}
	tr := tar.NewReader(gz)
	seen := map[string]string{}
	var total int64
	for count := 1; ; count++ {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return unsafeArchive("corrupt bundle: %v", err)
		}
		if count > maxBundleMembers {
			return unsafeArchive("the bundle has more than %d entries", maxBundleMembers)
		}
		name, err := memberName(hdr.Name)
		if err != nil {
			return err
		}
		if hdr.Typeflag == tar.TypeDir {
			continue
		}
		if hdr.Typeflag != tar.TypeReg {
			return unsafeArchive("refusing to extract %q: only regular files are allowed (no links or devices)", name)
		}
		if _, dup := seen[name]; dup {
			return unsafeArchive("duplicate archive entry %q", name)
		}
		if total += hdr.Size; total > maxExtractBytes {
			return unsafeArchive("the bundle expands beyond %d bytes", int64(maxExtractBytes))
		}
		out := filepath.Join(dest, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return fmt.Errorf("grad: %w", err)
		}
		w, err := os.OpenFile(out, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o644)
		if err != nil {
			return fmt.Errorf("grad: %w", err)
		}
		h := sha256.New()
		_, err = io.Copy(io.MultiWriter(w, h), io.LimitReader(tr, hdr.Size))
		if cerr := w.Close(); err == nil {
			err = cerr
		}
		if err != nil {
			return unsafeArchive("extracting %q: %v", name, err)
		}
		seen[name] = hex.EncodeToString(h.Sum(nil))
	}
	raw, err := os.ReadFile(filepath.Join(dest, "manifest.json"))
	if err != nil {
		return unsafeArchive("the bundle has no manifest.json")
	}
	var manifest struct {
		Files map[string]string `json:"files"`
	}
	if err := json.Unmarshal(raw, &manifest); err != nil || manifest.Files == nil {
		return unsafeArchive("manifest.json has no 'files' checksum map")
	}
	var unlisted []string
	for name := range seen {
		if _, ok := manifest.Files[name]; !ok && !reservedBundleFiles[name] {
			unlisted = append(unlisted, name)
		}
	}
	if len(unlisted) > 0 {
		sort.Strings(unlisted)
		return unsafeArchive("the bundle has files manifest.json does not list: %s", strings.Join(unlisted, ", "))
	}
	for name, want := range manifest.Files {
		got, ok := seen[name]
		if !ok {
			return unsafeArchive("manifest.json lists %q, which is missing from the bundle", name)
		}
		if !strings.EqualFold(want, got) {
			return &ChecksumMismatchError{GradError: newError("checksum_mismatch", "bundle file %q does not match its manifest checksum", name), Expected: want, Actual: got}
		}
	}
	return nil
}

// checkExtractDest refuses a destination that exists and is not an empty directory.
func checkExtractDest(dest string) error {
	if entries, err := os.ReadDir(dest); err == nil && len(entries) > 0 {
		return newError("destination_not_empty", "%s is not empty; pick a new directory", dest)
	}
	return nil
}

// extractInto unpacks the verified bundle at archive into dest through a staging directory
// next to it, so dest only ever appears complete.
func extractInto(archive, dest string) error {
	if err := checkExtractDest(dest); err != nil {
		return err
	}
	parent := filepath.Dir(filepath.Clean(dest))
	if err := os.MkdirAll(parent, 0o755); err != nil {
		return fmt.Errorf("grad: %w", err)
	}
	staging, err := os.MkdirTemp(parent, ".grad-extract-*")
	if err != nil {
		return fmt.Errorf("grad: %w", err)
	}
	if err := extractBundle(archive, staging); err != nil {
		os.RemoveAll(staging)
		return err
	}
	_ = os.Remove(dest) // an empty directory
	if err := os.Rename(staging, dest); err != nil {
		os.RemoveAll(staging)
		return fmt.Errorf("grad: %w", err)
	}
	return nil
}
