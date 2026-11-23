package blobs

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
)

// FS stores blobs as files: <dir>/<space_id>/<blob_id[0:2]>/<blob_id>.
type FS struct {
	dir string
}

// NewFS returns a filesystem BlobStore rooted at dir (created if needed).
func NewFS(dir string) (*FS, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	return &FS{dir: dir}, nil
}

func (f *FS) path(spaceID, blobID string) string {
	return filepath.Join(f.dir, spaceID, blobID[:2], blobID)
}

// Put writes r to a temp file next to the destination, syncs it and renames it into place, so
// readers only ever see complete blobs.
func (f *FS) Put(ctx context.Context, spaceID, blobID string, r io.Reader) error {
	if !validKey(spaceID, blobID) {
		return errBadKey
	}
	dst := f.path(spaceID, blobID)
	if err := os.MkdirAll(filepath.Dir(dst), 0o700); err != nil {
		return err
	}
	tmp, err := os.CreateTemp(filepath.Dir(dst), ".tmp-"+blobID+"-*")
	if err != nil {
		return err
	}
	ok := false
	defer func() {
		if !ok {
			tmp.Close()
			os.Remove(tmp.Name())
		}
	}()
	if _, err := io.Copy(tmp, ctxReader{ctx, r}); err != nil {
		return err
	}
	if err := tmp.Sync(); err != nil {
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp.Name(), dst); err != nil {
		return err
	}
	ok = true
	return nil
}

// Get opens the blob's file.
func (f *FS) Get(_ context.Context, spaceID, blobID string) (io.ReadCloser, int64, error) {
	if !validKey(spaceID, blobID) {
		return nil, 0, ErrNotFound
	}
	fh, err := os.Open(f.path(spaceID, blobID))
	if errors.Is(err, fs.ErrNotExist) {
		return nil, 0, ErrNotFound
	}
	if err != nil {
		return nil, 0, err
	}
	st, err := fh.Stat()
	if err != nil {
		fh.Close()
		return nil, 0, err
	}
	return fh, st.Size(), nil
}

// Exists reports whether the blob's file exists.
func (f *FS) Exists(_ context.Context, spaceID, blobID string) (bool, error) {
	if !validKey(spaceID, blobID) {
		return false, nil
	}
	_, err := os.Stat(f.path(spaceID, blobID))
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	return err == nil, err
}

// ctxReader stops a copy once ctx is cancelled (e.g. the client went away).
type ctxReader struct {
	ctx context.Context
	r   io.Reader
}

func (c ctxReader) Read(p []byte) (int, error) {
	if err := c.ctx.Err(); err != nil {
		return 0, err
	}
	return c.r.Read(p)
}

// Delete removes the blob's file.
func (f *FS) Delete(_ context.Context, spaceID, blobID string) error {
	if !validKey(spaceID, blobID) {
		return errBadKey
	}
	err := os.Remove(f.path(spaceID, blobID))
	if errors.Is(err, fs.ErrNotExist) {
		return nil
	}
	return err
}
