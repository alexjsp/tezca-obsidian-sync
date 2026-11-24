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
// already recorded. With quota > 0, a new row that would take b.CreatedBy's storage (UserBytes)
// above quota is not recorded and ErrQuota is returned.
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
		return checkQuota(tx, b.CreatedBy, quota) // over quota rolls the insert back
	})
	if err != nil {
		created = false
	}
	return created, err
}

// userBytesQuery sums what one user has stored on this host: the blobs they uploaded plus the
// retained updates and snapshots they authored (in any space). Updates and snapshots that the
// history policy prunes stop counting.
const userBytesQuery = `SELECT
	(SELECT COALESCE(SUM(size), 0) FROM blobs WHERE created_by = ?1) +
	(SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM updates WHERE author = ?1) +
	(SELECT COALESCE(SUM(LENGTH(payload)), 0) FROM snapshots WHERE author = ?1)`

// UserBytes returns how much signPk has stored on this host (see userBytesQuery). Guest quotas
// (TEZCA_GUEST_QUOTA_MB) cap this.
func (s *Store) UserBytes(ctx context.Context, signPk []byte) (int64, error) {
	var n int64
	err := s.r.QueryRowContext(ctx, userBytesQuery, signPk).Scan(&n)
	return n, err
}

// checkQuota returns ErrQuota if quota > 0 and signPk's storage, as seen inside tx, is over it.
func checkQuota(tx *sql.Tx, signPk []byte, quota int64) error {
	if quota <= 0 {
		return nil
	}
	var used int64
	if err := tx.QueryRow(userBytesQuery, signPk).Scan(&used); err != nil {
		return err
	}
	if used > quota {
		return ErrQuota
	}
	return nil
}
