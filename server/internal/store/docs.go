package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
	"time"
)

// ───────────── spaces ─────────────

type SpaceKey struct {
	Epoch   uint32
	Wrapped []byte
}

type Member struct {
	SignPk []byte
	BoxPk  []byte
	Role   int
}

// Space is a space as seen by one member.
type Space struct {
	SpaceID   string
	Kind      int
	Role      int // caller's role
	Epoch     uint32
	Keys      []SpaceKey
	Meta      []byte
	MetaEpoch uint32
	Members   []Member
}

// CreateSpace creates a space with owner as OWNER at epoch 0. Duplicate id, or a second
// PROFILE space created by the same user → ErrConflict.
func (s *Store) CreateSpace(ctx context.Context, spaceID string, kind int, owner, wrappedKey, meta []byte, now int64) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		var n int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM spaces WHERE space_id = ?`, spaceID).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return ErrConflict
		}
		if kind == KindProfile {
			if err := tx.QueryRow(`SELECT COUNT(*) FROM spaces WHERE kind = ? AND created_by = ?`, KindProfile, owner).Scan(&n); err != nil {
				return err
			}
			if n > 0 {
				return ErrConflict
			}
		}
		if _, err := tx.Exec(`INSERT INTO spaces(space_id, kind, epoch, meta, meta_epoch, created_by, created_at) VALUES(?, ?, 0, ?, 0, ?, ?)`,
			spaceID, kind, meta, owner, now); err != nil {
			return err
		}
		if _, err := tx.Exec(`INSERT INTO members(space_id, sign_pk, role) VALUES(?, ?, ?)`, spaceID, owner, SpaceOwner); err != nil {
			return err
		}
		_, err := tx.Exec(`INSERT INTO space_keys(space_id, epoch, sign_pk, wrapped) VALUES(?, 0, ?, ?)`, spaceID, owner, wrappedKey)
		return err
	})
}

// Membership returns the caller's role in a space and the space's current epoch.
// Not a member (or no such space) → ErrNotFound.
func (s *Store) Membership(ctx context.Context, spaceID string, signPk []byte) (role int, epoch uint32, err error) {
	err = s.r.QueryRowContext(ctx, `SELECT m.role, sp.epoch FROM members m JOIN spaces sp ON sp.space_id = m.space_id
		WHERE m.space_id = ? AND m.sign_pk = ?`, spaceID, signPk).Scan(&role, &epoch)
	if errors.Is(err, sql.ErrNoRows) {
		err = ErrNotFound
	}
	return
}

// GetSpace returns one space as seen by signPk (ErrNotFound if not a member).
func (s *Store) GetSpace(ctx context.Context, spaceID string, signPk []byte) (Space, error) {
	sp, err := s.spaces(ctx, signPk, spaceID)
	if err != nil {
		return Space{}, err
	}
	if len(sp) == 0 {
		return Space{}, ErrNotFound
	}
	return sp[0], nil
}

// ListSpaces returns every space signPk is a member of, ordered by creation.
func (s *Store) ListSpaces(ctx context.Context, signPk []byte) ([]Space, error) {
	return s.spaces(ctx, signPk, "")
}

func (s *Store) spaces(ctx context.Context, signPk []byte, only string) ([]Space, error) {
	q := `SELECT sp.space_id, sp.kind, m.role, sp.epoch, sp.meta, sp.meta_epoch FROM spaces sp
		JOIN members m ON m.space_id = sp.space_id WHERE m.sign_pk = ?`
	args := []any{signPk}
	if only != "" {
		q += ` AND sp.space_id = ?`
		args = append(args, only)
	}
	q += ` ORDER BY sp.created_at, sp.space_id`
	rows, err := s.r.QueryContext(ctx, q, args...)
	if err != nil {
		return nil, err
	}
	var out []Space
	for rows.Next() {
		var sp Space
		if err := rows.Scan(&sp.SpaceID, &sp.Kind, &sp.Role, &sp.Epoch, &sp.Meta, &sp.MetaEpoch); err != nil {
			rows.Close()
			return nil, err
		}
		out = append(out, sp)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		sp := &out[i]
		krows, err := s.r.QueryContext(ctx, `SELECT epoch, wrapped FROM space_keys WHERE space_id = ? AND sign_pk = ? ORDER BY epoch`, sp.SpaceID, signPk)
		if err != nil {
			return nil, err
		}
		for krows.Next() {
			var k SpaceKey
			if err := krows.Scan(&k.Epoch, &k.Wrapped); err != nil {
				krows.Close()
				return nil, err
			}
			sp.Keys = append(sp.Keys, k)
		}
		krows.Close()
		mrows, err := s.r.QueryContext(ctx, `SELECT m.sign_pk, COALESCE(u.box_pk, x''), m.role FROM members m
			LEFT JOIN users u ON u.sign_pk = m.sign_pk WHERE m.space_id = ? ORDER BY m.role, m.sign_pk`, sp.SpaceID)
		if err != nil {
			return nil, err
		}
		for mrows.Next() {
			var m Member
			if err := mrows.Scan(&m.SignPk, &m.BoxPk, &m.Role); err != nil {
				mrows.Close()
				return nil, err
			}
			sp.Members = append(sp.Members, m)
		}
		mrows.Close()
	}
	return out, nil
}

// ───────────── docs ─────────────

// Doc is a row of the docs table.
type Doc struct {
	SpaceID              string
	DocID                string
	LatestSeq            uint64
	SnapshotSeq          uint64
	UpdatesSinceSnapshot uint32
	BytesSinceSnapshot   uint64
	// SnapshotCreatedAt is the latest snapshot's created_at (unix ms, 0 if none). Only GetDoc
	// and PutSnapshot fill it in.
	SnapshotCreatedAt int64
}

type Update struct {
	Seq     uint64
	Epoch   uint32
	Author  []byte
	Payload []byte
	Sig     []byte
	// CreatedAt is when the server stored it (unix ms); set by AppendUpdate.
	CreatedAt int64
}

type Snapshot struct {
	BaseSeq   uint64
	Epoch     uint32
	Author    []byte
	Payload   []byte
	Sig       []byte
	CreatedAt int64 // unix ms; set by the store
}

// GetDoc returns the doc row; a doc that has never been written returns a zero Doc (no error).
func (s *Store) GetDoc(ctx context.Context, spaceID, docID string) (Doc, error) {
	d := Doc{SpaceID: spaceID, DocID: docID}
	err := s.r.QueryRowContext(ctx, `SELECT latest_seq, snapshot_seq, updates_since_snapshot, bytes_since_snapshot,
		COALESCE((SELECT created_at FROM snapshots sn WHERE sn.space_id = d.space_id AND sn.doc_id = d.doc_id AND sn.base_seq = d.snapshot_seq), 0)
		FROM docs d WHERE space_id = ? AND doc_id = ?`, spaceID, docID).
		Scan(&d.LatestSeq, &d.SnapshotSeq, &d.UpdatesSinceSnapshot, &d.BytesSinceSnapshot, &d.SnapshotCreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return d, nil
	}
	return d, err
}

// DocHeads lists every doc in a space with latest_seq > 0 or a snapshot.
func (s *Store) DocHeads(ctx context.Context, spaceID string) ([]Doc, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT doc_id, latest_seq, snapshot_seq, updates_since_snapshot, bytes_since_snapshot
		FROM docs WHERE space_id = ? AND (latest_seq > 0 OR snapshot_seq > 0) ORDER BY doc_id`, spaceID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Doc
	for rows.Next() {
		d := Doc{SpaceID: spaceID}
		if err := rows.Scan(&d.DocID, &d.LatestSeq, &d.SnapshotSeq, &d.UpdatesSinceSnapshot, &d.BytesSinceSnapshot); err != nil {
			return nil, err
		}
		out = append(out, d)
	}
	return out, rows.Err()
}

func checkEpoch(tx *sql.Tx, spaceID string, epoch uint32) error {
	var cur uint32
	err := tx.QueryRow(`SELECT epoch FROM spaces WHERE space_id = ?`, spaceID).Scan(&cur)
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	if epoch != cur {
		return ErrEpochStale
	}
	return nil
}

// AppendUpdate assigns seq = latest_seq+1, stores the update durably and returns the new doc row.
// The caller must hold the doc's lock so the returned seq order matches broadcast order. With
// quota > 0, an update that would take the author's storage (UserBytes) over quota is not stored
// and ErrQuota is returned.
func (s *Store) AppendUpdate(ctx context.Context, spaceID, docID string, u Update, quota int64) (Doc, error) {
	var d Doc
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if err := checkEpoch(tx, spaceID, u.Epoch); err != nil {
			return err
		}
		d = Doc{SpaceID: spaceID, DocID: docID}
		err := tx.QueryRow(`SELECT latest_seq, snapshot_seq, updates_since_snapshot, bytes_since_snapshot FROM docs
			WHERE space_id = ? AND doc_id = ?`, spaceID, docID).
			Scan(&d.LatestSeq, &d.SnapshotSeq, &d.UpdatesSinceSnapshot, &d.BytesSinceSnapshot)
		if err != nil && !errors.Is(err, sql.ErrNoRows) {
			return err
		}
		d.LatestSeq++
		d.UpdatesSinceSnapshot++
		d.BytesSinceSnapshot += uint64(len(u.Payload))
		created := u.CreatedAt
		if created == 0 {
			created = time.Now().UnixMilli()
		}
		if _, err := tx.Exec(`INSERT INTO updates(space_id, doc_id, seq, epoch, author, payload, sig, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
			spaceID, docID, d.LatestSeq, u.Epoch, u.Author, u.Payload, u.Sig, created); err != nil {
			return err
		}
		if err := checkQuota(tx, u.Author, quota); err != nil {
			return err
		}
		_, err = tx.Exec(`INSERT INTO docs(space_id, doc_id, latest_seq, snapshot_seq, updates_since_snapshot, bytes_since_snapshot)
			VALUES(?, ?, ?, ?, ?, ?) ON CONFLICT(space_id, doc_id) DO UPDATE SET latest_seq = excluded.latest_seq,
			updates_since_snapshot = excluded.updates_since_snapshot, bytes_since_snapshot = excluded.bytes_since_snapshot`,
			spaceID, docID, d.LatestSeq, d.SnapshotSeq, d.UpdatesSinceSnapshot, d.BytesSinceSnapshot)
		return err
	})
	if err != nil {
		return Doc{}, err
	}
	return d, nil
}

// PutSnapshot stores a snapshot with created_at = now (unix ms), applies the History retention
// policy as of now (snapshots and the update log), and recomputes the since-snapshot counters.
// Updates covered by the snapshot are kept for the history window (point-in-time restore); only
// the ones older than that are dropped. Invalid base_seq → ErrConflict. With quota > 0, a
// snapshot that leaves the author's storage (UserBytes, after pruning) over quota is not stored
// and ErrQuota is returned. The caller must hold the doc's lock.
func (s *Store) PutSnapshot(ctx context.Context, spaceID, docID string, sn Snapshot, now, quota int64) (Doc, error) {
	var d Doc
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if err := checkEpoch(tx, spaceID, sn.Epoch); err != nil {
			return err
		}
		d = Doc{SpaceID: spaceID, DocID: docID}
		err := tx.QueryRow(`SELECT latest_seq, snapshot_seq FROM docs WHERE space_id = ? AND doc_id = ?`, spaceID, docID).
			Scan(&d.LatestSeq, &d.SnapshotSeq)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrConflict
		}
		if err != nil {
			return err
		}
		if sn.BaseSeq < 1 || sn.BaseSeq > d.LatestSeq || sn.BaseSeq <= d.SnapshotSeq {
			return ErrConflict
		}
		if _, err := tx.Exec(`INSERT INTO snapshots(space_id, doc_id, base_seq, epoch, author, payload, sig, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
			spaceID, docID, sn.BaseSeq, sn.Epoch, sn.Author, sn.Payload, sn.Sig, now); err != nil {
			return err
		}
		if err := s.pruneUpdates(tx, spaceID, docID, sn.BaseSeq, now); err != nil {
			return err
		}
		if err := s.pruneSnapshots(tx, spaceID, docID, now); err != nil {
			return err
		}
		if err := checkQuota(tx, sn.Author, quota); err != nil {
			return err
		}
		d.SnapshotSeq = sn.BaseSeq
		d.SnapshotCreatedAt = now
		if err := tx.QueryRow(`SELECT COUNT(*), COALESCE(SUM(LENGTH(payload)), 0) FROM updates WHERE space_id = ? AND doc_id = ? AND seq > ?`,
			spaceID, docID, sn.BaseSeq).Scan(&d.UpdatesSinceSnapshot, &d.BytesSinceSnapshot); err != nil {
			return err
		}
		_, err = tx.Exec(`UPDATE docs SET snapshot_seq = ?, updates_since_snapshot = ?, bytes_since_snapshot = ? WHERE space_id = ? AND doc_id = ?`,
			d.SnapshotSeq, d.UpdatesSinceSnapshot, d.BytesSinceSnapshot, spaceID, docID)
		return err
	})
	return d, err
}

// LatestSnapshot returns the newest snapshot for a doc, or ErrNotFound.
func (s *Store) LatestSnapshot(ctx context.Context, spaceID, docID string) (Snapshot, error) {
	var sn Snapshot
	err := s.r.QueryRowContext(ctx, `SELECT base_seq, epoch, author, payload, sig, created_at FROM snapshots
		WHERE space_id = ? AND doc_id = ? ORDER BY base_seq DESC LIMIT 1`, spaceID, docID).
		Scan(&sn.BaseSeq, &sn.Epoch, &sn.Author, &sn.Payload, &sn.Sig, &sn.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return sn, ErrNotFound
	}
	return sn, err
}

// SnapshotSeqs lists retained snapshot base_seqs, ascending (for tests/diagnostics).
func (s *Store) SnapshotSeqs(ctx context.Context, spaceID, docID string) ([]uint64, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT base_seq FROM snapshots WHERE space_id = ? AND doc_id = ? ORDER BY base_seq`, spaceID, docID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []uint64
	for rows.Next() {
		var b uint64
		if err := rows.Scan(&b); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// StreamUpdates calls fn with ascending batches of updates with seq > from. A batch closes at
// maxCount updates or once its payload bytes reach maxBytes (always ≥ 1 update).
func (s *Store) StreamUpdates(ctx context.Context, spaceID, docID string, from uint64, maxCount, maxBytes int, fn func([]Update) error) error {
	return s.streamRange(ctx, spaceID, docID, from, ^uint64(0)>>1, maxCount, maxBytes, fn)
}

// UpdateRange calls fn with ascending batches of the retained updates with from < seq ≤ to
// (the update log, for point-in-time history), including when each was stored.
func (s *Store) UpdateRange(ctx context.Context, spaceID, docID string, from, to uint64, maxCount, maxBytes int, fn func([]Update) error) error {
	return s.streamRange(ctx, spaceID, docID, from, to, maxCount, maxBytes, fn)
}

func (s *Store) streamRange(ctx context.Context, spaceID, docID string, from, to uint64, maxCount, maxBytes int, fn func([]Update) error) error {
	rows, err := s.r.QueryContext(ctx, `SELECT seq, epoch, author, payload, sig, created_at FROM updates
		WHERE space_id = ? AND doc_id = ? AND seq > ? AND seq <= ? ORDER BY seq`, spaceID, docID, from, to)
	if err != nil {
		return err
	}
	defer rows.Close()
	var batch []Update
	size := 0
	for rows.Next() {
		var u Update
		if err := rows.Scan(&u.Seq, &u.Epoch, &u.Author, &u.Payload, &u.Sig, &u.CreatedAt); err != nil {
			return err
		}
		if len(batch) > 0 && (len(batch) >= maxCount || size+len(u.Payload) > maxBytes) {
			if err := fn(batch); err != nil {
				return err
			}
			batch, size = nil, 0
		}
		batch = append(batch, u)
		size += len(u.Payload)
	}
	if err := rows.Err(); err != nil {
		return err
	}
	if len(batch) > 0 {
		return fn(batch)
	}
	return nil
}

// ValidID reports whether id is an acceptable space/doc id: 1–64 chars of the base64url alphabet.
// (Protocol ids are 22-char b64u; "index" is the reserved index doc id.)
func ValidID(id string) bool {
	if len(id) == 0 || len(id) > 64 {
		return false
	}
	return strings.IndexFunc(id, func(r rune) bool {
		return !(r >= 'a' && r <= 'z' || r >= 'A' && r <= 'Z' || r >= '0' && r <= '9' || r == '-' || r == '_')
	}) < 0
}

// AddMember adds (or updates) a space member and stores their wrapped key for the current epoch.
// Test helper; the protocol adds members through share invites (RedeemShareInvite).
func (s *Store) AddMember(ctx context.Context, spaceID string, signPk []byte, role int, wrapped []byte) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		var epoch uint32
		if err := tx.QueryRow(`SELECT epoch FROM spaces WHERE space_id = ?`, spaceID).Scan(&epoch); err != nil {
			if errors.Is(err, sql.ErrNoRows) {
				return ErrNotFound
			}
			return err
		}
		if _, err := tx.Exec(`INSERT INTO members(space_id, sign_pk, role) VALUES(?, ?, ?)
			ON CONFLICT(space_id, sign_pk) DO UPDATE SET role = excluded.role`, spaceID, signPk, role); err != nil {
			return err
		}
		_, err := tx.Exec(`INSERT INTO space_keys(space_id, epoch, sign_pk, wrapped) VALUES(?, ?, ?, ?)
			ON CONFLICT(space_id, epoch, sign_pk) DO UPDATE SET wrapped = excluded.wrapped`, spaceID, epoch, signPk, wrapped)
		return err
	})
}

// SetEpoch sets a space's current key epoch. Test helper; the protocol rotates with RotateKey.
func (s *Store) SetEpoch(ctx context.Context, spaceID string, epoch uint32) error {
	_, err := s.w.ExecContext(ctx, `UPDATE spaces SET epoch = ? WHERE space_id = ?`, epoch, spaceID)
	return err
}
