package store

import (
	"context"
	"database/sql"
	"errors"
)

// ───────────── history (snapshot retention + versions) ─────────────

const (
	hourMs = int64(60 * 60 * 1000)
	dayMs  = 24 * hourMs
)

type snapTime struct {
	BaseSeq   uint64
	CreatedAt int64 // unix ms
}

// retain returns the base_seqs to keep under policy h as of now (unix ms). snaps must be
// ordered newest first, i.e. base_seq descending: base_seq only ever grows, so it orders
// snapshots by upload even if the server clock stepped backwards. It keeps:
//   - the latest snapshot;
//   - the newest snapshot in each clock hour, for snapshots less than h.Hours hours old;
//   - the newest snapshot in each UTC day, for snapshots less than h.Days days old.
func retain(snaps []snapTime, now int64, h History) map[uint64]bool {
	keep := map[uint64]bool{}
	if len(snaps) == 0 {
		return keep
	}
	keep[snaps[0].BaseSeq] = true
	hourCut := now - int64(h.Hours)*hourMs
	dayCut := now - int64(h.Days)*dayMs
	hours := map[int64]bool{}
	days := map[int64]bool{}
	for _, s := range snaps {
		if h.Hours > 0 && s.CreatedAt > hourCut {
			if b := s.CreatedAt / hourMs; !hours[b] {
				hours[b] = true
				keep[s.BaseSeq] = true
			}
		}
		if h.Days > 0 && s.CreatedAt > dayCut {
			if b := s.CreatedAt / dayMs; !days[b] { // unix time has no leap seconds: day = UTC day
				days[b] = true
				keep[s.BaseSeq] = true
			}
		}
	}
	return keep
}

// pruneSnapshots applies the retention policy to one doc inside a write transaction.
func (s *Store) pruneSnapshots(tx *sql.Tx, spaceID, docID string, now int64) error {
	rows, err := tx.Query(`SELECT base_seq, created_at FROM snapshots WHERE space_id = ? AND doc_id = ? ORDER BY base_seq DESC`, spaceID, docID)
	if err != nil {
		return err
	}
	var snaps []snapTime
	for rows.Next() {
		var st snapTime
		if err := rows.Scan(&st.BaseSeq, &st.CreatedAt); err != nil {
			rows.Close()
			return err
		}
		snaps = append(snaps, st)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}
	keep := retain(snaps, now, s.history)
	for _, st := range snaps {
		if keep[st.BaseSeq] {
			continue
		}
		if _, err := tx.Exec(`DELETE FROM snapshots WHERE space_id = ? AND doc_id = ? AND base_seq = ?`, spaceID, docID, st.BaseSeq); err != nil {
			return err
		}
	}
	return nil
}

// Version describes one retained snapshot.
type Version struct {
	BaseSeq   uint64
	CreatedAt int64 // unix ms
	Author    []byte
	Size      uint64 // payload bytes
	Epoch     uint32
}

// ListVersions returns a doc's retained snapshots, newest first. An unknown doc has none.
func (s *Store) ListVersions(ctx context.Context, spaceID, docID string) ([]Version, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT base_seq, created_at, author, LENGTH(payload), epoch FROM snapshots
		WHERE space_id = ? AND doc_id = ? ORDER BY base_seq DESC`, spaceID, docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Version
	for rows.Next() {
		var v Version
		if err := rows.Scan(&v.BaseSeq, &v.CreatedAt, &v.Author, &v.Size, &v.Epoch); err != nil {
			return nil, err
		}
		out = append(out, v)
	}
	return out, rows.Err()
}

// GetVersion returns the retained snapshot with this base_seq, or ErrNotFound.
func (s *Store) GetVersion(ctx context.Context, spaceID, docID string, baseSeq uint64) (Snapshot, error) {
	sn := Snapshot{BaseSeq: baseSeq}
	err := s.r.QueryRowContext(ctx, `SELECT epoch, author, payload, sig, created_at FROM snapshots
		WHERE space_id = ? AND doc_id = ? AND base_seq = ?`, spaceID, docID, baseSeq).
		Scan(&sn.Epoch, &sn.Author, &sn.Payload, &sn.Sig, &sn.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return sn, ErrNotFound
	}
	return sn, err
}

// pruneUpdates drops log entries the history window no longer needs: covered by the snapshot at
// baseSeq (the newest) and older than History.Days. Newer ones are kept so any point in the
// window can be rebuilt from an earlier snapshot (or the doc's start) plus updates.
func (s *Store) pruneUpdates(tx *sql.Tx, spaceID, docID string, baseSeq uint64, now int64) error {
	cutoff := now - int64(s.history.Days)*24*3600*1000
	_, err := tx.Exec(`DELETE FROM updates WHERE space_id = ? AND doc_id = ? AND seq <= ? AND created_at < ?`, spaceID, docID, baseSeq, cutoff)
	return err
}
