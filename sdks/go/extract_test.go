package grad_test

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	grad "github.com/Gradiated/grad/sdks/go"
)

type entry struct {
	name string
	body string
	kind byte
}

func tarGz(t *testing.T, entries []entry) []byte {
	t.Helper()
	var buf bytes.Buffer
	gz := gzip.NewWriter(&buf)
	tw := tar.NewWriter(gz)
	for _, e := range entries {
		kind := e.kind
		if kind == 0 {
			kind = tar.TypeReg
		}
		hdr := &tar.Header{Name: e.name, Mode: 0o644, Size: int64(len(e.body)), Typeflag: kind}
		if kind == tar.TypeSymlink {
			hdr.Size, hdr.Linkname = 0, "/etc/passwd"
		}
		if err := tw.WriteHeader(hdr); err != nil {
			t.Fatal(err)
		}
		if hdr.Size > 0 {
			_, _ = tw.Write([]byte(e.body))
		}
	}
	_ = tw.Close()
	_ = gz.Close()
	return buf.Bytes()
}

func sha(s string) string { h := sha256.Sum256([]byte(s)); return hex.EncodeToString(h[:]) }

func manifest(files map[string]string) string {
	sums := map[string]string{}
	for name, body := range files {
		sums[name] = sha(body)
	}
	raw, _ := json.Marshal(map[string]any{"format": "peft_lora", "files": sums})
	return string(raw)
}

func TestDownloadExtractWritesTheVerifiedFiles(t *testing.T) {
	ctx := context.Background()
	files := map[string]string{"adapter_config.json": `{"r":32}`, "adapter_model.safetensors": "weights"}
	good := tarGz(t, []entry{{name: "manifest.json", body: manifest(files)}, {name: "adapter_config.json", body: files["adapter_config.json"]}, {name: "adapter_model.safetensors", body: files["adapter_model.safetensors"]}})
	routes := map[string]route{"GET /v1/artifacts/good/download": bundleRoute(good, sha(string(good)))}
	bad := map[string][]byte{
		"traversal": tarGz(t, []entry{{name: "manifest.json", body: manifest(nil)}, {name: "../escape", body: "x"}}),
		"symlink":   tarGz(t, []entry{{name: "manifest.json", body: manifest(nil)}, {name: "link", kind: tar.TypeSymlink}}),
		"tampered":  tarGz(t, []entry{{name: "manifest.json", body: manifest(files)}, {name: "adapter_config.json", body: "{}"}, {name: "adapter_model.safetensors", body: "weights"}}),
		"unlisted":  tarGz(t, []entry{{name: "manifest.json", body: manifest(nil)}, {name: "extra.bin", body: "x"}}),
	}
	for ref, body := range bad {
		routes["GET /v1/artifacts/"+ref+"/download"] = bundleRoute(body, sha(string(body)))
	}
	srv := newFake(t, routes)
	c, _ := srv.client()

	root := t.TempDir()
	dest := filepath.Join(root, "support-sft")
	d, err := c.Artifacts.Download(ctx, "good", dest, grad.Extract())
	if err != nil {
		t.Fatal(err)
	}
	if d.Path != dest {
		t.Fatalf("path %q", d.Path)
	}
	for name, body := range files {
		if raw, err := os.ReadFile(filepath.Join(dest, name)); err != nil || string(raw) != body {
			t.Fatalf("%s: %q %v", name, raw, err)
		}
	}
	if entries, _ := os.ReadDir(root); len(entries) != 1 {
		t.Fatalf("left behind next to dest: %v", entries)
	}
	// A non-empty destination is refused before the (possibly many-GB) download starts.
	before := srv.count("GET", "/v1/artifacts/good/download")
	if _, err := c.Artifacts.Download(ctx, "good", dest, grad.Extract()); err == nil {
		t.Fatal("extracted into a non-empty directory")
	}
	if got := srv.count("GET", "/v1/artifacts/good/download"); got != before {
		t.Fatalf("downloaded the bundle before refusing a non-empty destination (%d requests, want %d)", got, before)
	}

	for ref := range bad {
		out := filepath.Join(t.TempDir(), "out")
		_, err := c.Artifacts.Download(ctx, ref, out, grad.Extract())
		var ge *grad.GradError
		if err == nil || !errors.As(err, &ge) {
			t.Fatalf("%s: %v", ref, err)
		}
		if _, statErr := os.Stat(out); !os.IsNotExist(statErr) {
			t.Fatalf("%s: dest exists after a failed extract", ref)
		}
		if entries, _ := os.ReadDir(filepath.Dir(out)); len(entries) != 0 {
			t.Fatalf("%s: left behind %v", ref, entries)
		}
	}
}
