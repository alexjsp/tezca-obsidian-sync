package store

import (
	"context"
	"database/sql"
	"errors"
)

// ───────────── blobs ─────────────

// Blob is a row of the blobs table.
type Blob struct {
	Size      int64
	CreatedBy []byte
	CreatedAt int64 // unix ms
}

// GetBlob returns a blob's row, or ErrNotFound.
func (s *Store) GetBlob(ctx context.Context, spaceID, blobID string) (Blob, error) {
	var b Blob
	err := s.r.QueryRowContext(ctx, `SELECT size, created_by, created_at FROM blobs WHERE space_id = ? AND blob_id = ?`, spaceID, blobID).
		Scan(&b.Size, &b.CreatedBy, &b.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return b, ErrNotFound
	}
	return b, err
}

// PutBlob records a stored blob. It reports false (and leaves the row alone) if the blob was
// already recorded.
func (s *Store) PutBlob(ctx context.Context, spaceID, blobID string, b Blob) (bool, error) {
	res, err := s.w.ExecContext(ctx, `INSERT INTO blobs(space_id, blob_id, size, created_by, created_at) VALUES(?, ?, ?, ?, ?)
		ON CONFLICT(space_id, blob_id) DO NOTHING`, spaceID, blobID, b.Size, b.CreatedBy, b.CreatedAt)
	if err != nil {
		return false, err
	}
	n, err := res.RowsAffected()
	return n > 0, err
}
