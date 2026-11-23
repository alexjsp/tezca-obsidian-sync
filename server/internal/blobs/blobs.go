// Package blobs stores encrypted attachment bytes outside SQLite (docs/protocol.md, "Server
// storage"). The blobs table in the store records which blobs exist; a BlobStore holds the bytes.
package blobs

import (
	"context"
	"errors"
	"io"
	"strings"
)

// ErrNotFound is returned by Get when the blob doesn't exist.
var ErrNotFound = errors.New("blob not found")

// BlobStore holds opaque blob bytes keyed by (space_id, blob_id).
//
// Put must read r to io.EOF before the blob becomes visible, and must not make it visible if
// reading r fails: the HTTP layer verifies the request signature when the body reaches EOF and
// reports a bad signature (or an oversized body) as a read error. Putting an existing blob
// replaces it.
type BlobStore interface {
	Put(ctx context.Context, spaceID, blobID string, r io.Reader) error
	// Get returns the blob's bytes and size, or ErrNotFound.
	Get(ctx context.Context, spaceID, blobID string) (io.ReadCloser, int64, error)
	Exists(ctx context.Context, spaceID, blobID string) (bool, error)
	// Delete removes the blob. Deleting a missing blob is not an error.
	Delete(ctx context.Context, spaceID, blobID string) error
}

// validKey guards against path traversal: ids must be non-empty base64url (≥ 2 chars for the
// blob id, which is sharded by its first two characters). The HTTP layer validates the exact
// formats; this is a second line of defence.
func validKey(spaceID, blobID string) bool {
	ok := func(s string, min int) bool {
		return len(s) >= min && len(s) <= 64 && strings.IndexFunc(s, func(r rune) bool {
			return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_')
		}) < 0
	}
	return ok(spaceID, 1) && ok(blobID, 2)
}

var errBadKey = errors.New("invalid space or blob id")
