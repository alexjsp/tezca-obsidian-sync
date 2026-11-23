package blobs

import (
	"bytes"
	"context"
	"crypto/rand"
	"errors"
	"io"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/johannesboyne/gofakes3"
	"github.com/johannesboyne/gofakes3/backend/s3mem"
)

const (
	space = "AAAAAAAAAAAAAAAAAAAAAA"
	blob  = "abcdefghijklmnopqrstuvwxyz0123456789-_ABCDE"
)

// failAtEOF yields data and then fails instead of returning io.EOF, like the API's
// signature-checking reader on a bad signature.
type failAtEOF struct{ r io.Reader }

var errBad = errors.New("bad signature")

func (f failAtEOF) Read(p []byte) (int, error) {
	n, err := f.r.Read(p)
	if err == io.EOF {
		return n, errBad
	}
	return n, err
}

func randBytes(n int) []byte {
	b := make([]byte, n)
	rand.Read(b)
	return b
}

// conformance runs the BlobStore contract against bs.
func conformance(t *testing.T, bs BlobStore) {
	ctx := context.Background()
	get := func(id string) []byte {
		t.Helper()
		rc, size, err := bs.Get(ctx, space, id)
		if err != nil {
			t.Fatalf("get %s: %v", id, err)
		}
		defer rc.Close()
		b, err := io.ReadAll(rc)
		if err != nil || int64(len(b)) != size {
			t.Fatalf("read %s: %d bytes, size %d, %v", id, len(b), size, err)
		}
		return b
	}

	if ok, err := bs.Exists(ctx, space, blob); err != nil || ok {
		t.Fatalf("exists before put: %v %v", ok, err)
	}
	if _, _, err := bs.Get(ctx, space, blob); !errors.Is(err, ErrNotFound) {
		t.Fatalf("get before put: %v", err)
	}

	small := []byte("ciphertext")
	if err := bs.Put(ctx, space, blob, bytes.NewReader(small)); err != nil {
		t.Fatal(err)
	}
	if ok, err := bs.Exists(ctx, space, blob); err != nil || !ok {
		t.Fatalf("exists after put: %v %v", ok, err)
	}
	if got := get(blob); !bytes.Equal(got, small) {
		t.Fatalf("got %q", got)
	}

	// Overwrite.
	big := randBytes(s3PartSize + 1234) // more than one S3 part
	if err := bs.Put(ctx, space, blob, bytes.NewReader(big)); err != nil {
		t.Fatal(err)
	}
	if got := get(blob); !bytes.Equal(got, big) {
		t.Fatalf("overwrite: got %d bytes", len(got))
	}

	// A reader that fails at EOF never becomes visible, small or multi-part, and doesn't
	// clobber an existing blob.
	for _, n := range []int{100, s3PartSize + 10} {
		other := strings.Repeat("z", 43)
		if err := bs.Put(ctx, space, other, failAtEOF{bytes.NewReader(randBytes(n))}); !errors.Is(err, errBad) {
			t.Fatalf("failing put (%d bytes): %v", n, err)
		}
		if ok, err := bs.Exists(ctx, space, other); err != nil || ok {
			t.Fatalf("failed put (%d bytes) is visible: %v %v", n, ok, err)
		}
		if err := bs.Put(ctx, space, blob, failAtEOF{bytes.NewReader(randBytes(n))}); !errors.Is(err, errBad) {
			t.Fatalf("failing overwrite (%d bytes): %v", n, err)
		}
		if got := get(blob); !bytes.Equal(got, big) {
			t.Fatalf("failed overwrite (%d bytes) clobbered the blob", n)
		}
	}

	// Path traversal is refused.
	if err := bs.Put(ctx, "../x", blob, bytes.NewReader(small)); err == nil {
		t.Fatal("traversal accepted")
	}
	if err := bs.Put(ctx, space, "../../etc", bytes.NewReader(small)); err == nil {
		t.Fatal("traversal accepted")
	}
}

func TestFS(t *testing.T) {
	dir := t.TempDir()
	fs, err := NewFS(dir)
	if err != nil {
		t.Fatal(err)
	}
	conformance(t, fs)
	// Layout: <dir>/<space>/<blob[0:2]>/<blob>, and no temp files left behind.
	if _, err := os.Stat(filepath.Join(dir, space, blob[:2], blob)); err != nil {
		t.Fatal(err)
	}
	var stray []string
	filepath.Walk(dir, func(p string, info os.FileInfo, err error) error {
		if err == nil && strings.HasPrefix(info.Name(), ".tmp-") {
			stray = append(stray, p)
		}
		return nil
	})
	if len(stray) > 0 {
		t.Fatalf("temp files left: %v", stray)
	}
}

func TestS3(t *testing.T) {
	backend := s3mem.New()
	if err := backend.CreateBucket("tezca"); err != nil {
		t.Fatal(err)
	}
	srv := httptest.NewServer(gofakes3.New(backend).Server())
	defer srv.Close()
	cfg := S3Config{
		Endpoint: strings.TrimPrefix(srv.URL, "http://"), AccessKey: "ak", SecretKey: "sk",
		Region: "us-east-1", Bucket: "tezca", Prefix: "pre/", Insecure: true,
	}
	s3, err := NewS3(cfg)
	if err != nil {
		t.Fatal(err)
	}
	if err := s3.Check(context.Background()); err != nil {
		t.Fatal(err)
	}
	conformance(t, s3)
	// Key layout: <prefix>blobs/<space>/<blob>.
	if _, err := backend.HeadObject("tezca", "pre/blobs/"+space+"/"+blob); err != nil {
		t.Fatalf("object key: %v", err)
	}

	cfg.Bucket = "missing"
	s3, _ = NewS3(cfg)
	if err := s3.Check(context.Background()); err == nil || !strings.Contains(err.Error(), "does not exist") {
		t.Fatalf("missing bucket: %v", err)
	}
}
