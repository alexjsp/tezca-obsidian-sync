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
// already recorded. With quota > 0, a new row that would take the total size of blobs created
// by b.CreatedBy above quota is not recorded and ErrQuota is returned.
func (s *Store) PutBlob(ctx context.Context, spaceID, blobID string, b Blob, quota int64) (created bool, err error) {
	err = s.tx(ctx, func(tx *sql.Tx) error {
		res, err := tx.Exec(`INSERT INTO blobs(space_id, blob_id, size, created_by, created_at) VALUES(?, ?, ?, ?, ?)
			ON CONFLICT(space_id, blob_id) DO NOTHING`, spaceID, blobID, b.Size, b.CreatedBy, b.CreatedAt)
		if err != nil {
			return err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return err
		}
		created = n > 0
		if !created || quota <= 0 {
			return nil
		}
		var used int64
		if err := tx.QueryRow(`SELECT COALESCE(SUM(size), 0) FROM blobs WHERE created_by = ?`, b.CreatedBy).Scan(&used); err != nil {
			return err
		}
		if used > quota {
			return ErrQuota // rolls the insert back
		}
		return nil
	})
	if err != nil {
		created = false
	}
	return created, err
}

// UserBlobBytes returns the total size of the blobs signPk uploaded on this host.
func (s *Store) UserBlobBytes(ctx context.Context, signPk []byte) (int64, error) {
	var n int64
	err := s.r.QueryRowContext(ctx, `SELECT COALESCE(SUM(size), 0) FROM blobs WHERE created_by = ?`, signPk).Scan(&n)
	return n, err
}
