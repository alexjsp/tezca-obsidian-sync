// Package store is the SQLite persistence layer (see docs/protocol.md, "Server storage").
//
// It opens two handles on the same WAL database: a single-connection writer (so all writes
// are serialised and BEGIN IMMEDIATE never contends with itself) and a small read-only pool.
package store

import (
	"context"
	"crypto/rand"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"

	_ "modernc.org/sqlite"
)

var (
	ErrNotFound   = errors.New("not found")
	ErrConflict   = errors.New("conflict")
	ErrEpochStale = errors.New("epoch stale")
	ErrClaimed    = errors.New("server already claimed")
	ErrBadCode    = errors.New("invalid claim code")
	ErrExpired    = errors.New("expired")
	ErrRedeemed   = errors.New("already redeemed")
	ErrForbidden  = errors.New("forbidden")
	ErrLastOwner  = errors.New("last owner")
	ErrBadKeys    = errors.New("keys do not match")
	ErrQuota      = errors.New("quota exceeded")
)

// Host roles (match pb.HostRole).
const (
	HostAdmin  = 1
	HostMember = 2
	HostGuest  = 3
)

// Space kinds (match pb.SpaceKind).
const (
	KindRoot    = 1
	KindShare   = 2
	KindProfile = 3
)

// Space roles (match pb.SpaceRole).
const (
	SpaceOwner  = 1
	SpaceEditor = 2
	SpaceViewer = 3
)

// History is the snapshot retention policy (docs/protocol.md, "History").
type History struct {
	Hours int // keep the newest snapshot per clock hour for this many hours
	Days  int // keep the newest snapshot per UTC day for this many days
}

// DefaultHistory matches TEZCA_HISTORY_HOURS / TEZCA_HISTORY_DAYS defaults.
var DefaultHistory = History{Hours: 24, Days: 30}

// Store wraps the database handles.
type Store struct {
	w *sql.DB // writer, exactly one connection
	r *sql.DB // readers

	history History
}

// SetHistory sets the snapshot retention policy (default DefaultHistory). Call before use.
func (s *Store) SetHistory(h History) { s.history = h }

func dsn(path string, readOnly bool) string {
	q := url.Values{}
	q.Add("_pragma", "busy_timeout(10000)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(NORMAL)")
	q.Add("_pragma", "foreign_keys(ON)")
	if readOnly {
		q.Add("_pragma", "query_only(ON)")
	} else {
		q.Set("_txlock", "immediate")
	}
	return "file:" + path + "?" + q.Encode()
}

// Open opens (creating if needed) the database in dir and runs migrations.
func Open(dir string) (*Store, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	path := filepath.Join(dir, "tezca.db")
	w, err := sql.Open("sqlite", dsn(path, false))
	if err != nil {
		return nil, err
	}
	w.SetMaxOpenConns(1)
	w.SetMaxIdleConns(1)
	w.SetConnMaxLifetime(0)
	if err := migrate(w); err != nil {
		w.Close()
		return nil, fmt.Errorf("migrate: %w", err)
	}
	r, err := sql.Open("sqlite", dsn(path, true))
	if err != nil {
		w.Close()
		return nil, err
	}
	r.SetMaxOpenConns(8)
	r.SetMaxIdleConns(8)
	return &Store{w: w, r: r, history: DefaultHistory}, nil
}

// Close closes both handles.
func (s *Store) Close() error {
	return errors.Join(s.r.Close(), s.w.Close())
}

var migrations = []string{
	// v1
	`
CREATE TABLE server(k TEXT PRIMARY KEY, v BLOB);
CREATE TABLE users(sign_pk BLOB PRIMARY KEY, box_pk BLOB NOT NULL, role INT NOT NULL, created_at INT NOT NULL);
CREATE TABLE invites(token TEXT PRIMARY KEY, role INT NOT NULL, created_by BLOB, created_at INT NOT NULL, expires_at INT NOT NULL, redeemed_by BLOB, redeemed_at INT);
CREATE TABLE pairings(id TEXT PRIMARY KEY, owner BLOB NOT NULL, ciphertext BLOB NOT NULL, expires_at INT NOT NULL);
CREATE TABLE spaces(space_id TEXT PRIMARY KEY, kind INT NOT NULL, epoch INT NOT NULL, meta BLOB, meta_epoch INT NOT NULL, created_by BLOB NOT NULL, created_at INT NOT NULL);
CREATE TABLE members(space_id TEXT NOT NULL, sign_pk BLOB NOT NULL, role INT NOT NULL, PRIMARY KEY(space_id, sign_pk));
CREATE INDEX members_by_user ON members(sign_pk);
CREATE TABLE space_keys(space_id TEXT NOT NULL, epoch INT NOT NULL, sign_pk BLOB NOT NULL, wrapped BLOB NOT NULL, PRIMARY KEY(space_id, epoch, sign_pk));
CREATE TABLE docs(space_id TEXT NOT NULL, doc_id TEXT NOT NULL, latest_seq INT NOT NULL, snapshot_seq INT NOT NULL, updates_since_snapshot INT NOT NULL, bytes_since_snapshot INT NOT NULL, PRIMARY KEY(space_id, doc_id));
CREATE TABLE updates(space_id TEXT NOT NULL, doc_id TEXT NOT NULL, seq INT NOT NULL, epoch INT NOT NULL, author BLOB NOT NULL, payload BLOB NOT NULL, sig BLOB NOT NULL, PRIMARY KEY(space_id, doc_id, seq));
CREATE TABLE snapshots(space_id TEXT NOT NULL, doc_id TEXT NOT NULL, base_seq INT NOT NULL, epoch INT NOT NULL, author BLOB NOT NULL, payload BLOB NOT NULL, sig BLOB NOT NULL, created_at INT NOT NULL, PRIMARY KEY(space_id, doc_id, base_seq));
`,
	// v2 (M2): blob index. snapshots.created_at already exists since v1.
	`
CREATE TABLE IF NOT EXISTS blobs(space_id TEXT NOT NULL, blob_id TEXT NOT NULL, size INT NOT NULL, created_by BLOB NOT NULL, created_at INT NOT NULL, PRIMARY KEY(space_id, blob_id));
`,
	// v3 (M3): share invites. Separate from the host invites table.
	`
CREATE TABLE IF NOT EXISTS share_invites(token TEXT PRIMARY KEY, space_id TEXT NOT NULL, role INT NOT NULL, created_by BLOB NOT NULL, created_at INT NOT NULL, expires_at INT NOT NULL, revoked INT NOT NULL DEFAULT 0, redeemed_by BLOB, redeemed_at INT);
CREATE INDEX IF NOT EXISTS share_invites_by_space ON share_invites(space_id);
CREATE TABLE IF NOT EXISTS share_invite_keys(token TEXT NOT NULL, epoch INT NOT NULL, wrapped BLOB NOT NULL, PRIMARY KEY(token, epoch));
`,
	// v4 (M4): guest blob quotas sum blobs by uploader.
	`
CREATE INDEX IF NOT EXISTS blobs_by_creator ON blobs(created_by);
`,
}

func migrate(db *sql.DB) error {
	var v int
	if err := db.QueryRow(`PRAGMA user_version`).Scan(&v); err != nil {
		return err
	}
	for i := v; i < len(migrations); i++ {
		tx, err := db.Begin()
		if err != nil {
			return err
		}
		if _, err := tx.Exec(migrations[i]); err != nil {
			tx.Rollback()
			return fmt.Errorf("migration %d: %w", i+1, err)
		}
		if _, err := tx.Exec(fmt.Sprintf(`PRAGMA user_version = %d`, i+1)); err != nil {
			tx.Rollback()
			return err
		}
		if err := tx.Commit(); err != nil {
			return err
		}
	}
	return nil
}

func (s *Store) tx(ctx context.Context, fn func(*sql.Tx) error) error {
	tx, err := s.w.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if err := fn(tx); err != nil {
		tx.Rollback()
		return err
	}
	return tx.Commit()
}

// RandomID returns n random bytes as unpadded base64url.
func RandomID(n int) string {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		panic(err)
	}
	return base64.RawURLEncoding.EncodeToString(b)
}

// ───────────── server kv ─────────────

// GetKV returns the server-table value for k, or ErrNotFound.
func (s *Store) GetKV(ctx context.Context, k string) (string, error) {
	var v []byte
	err := s.r.QueryRowContext(ctx, `SELECT v FROM server WHERE k = ?`, k).Scan(&v)
	if errors.Is(err, sql.ErrNoRows) {
		return "", ErrNotFound
	}
	return string(v), err
}

// SetKV upserts a server-table value.
func (s *Store) SetKV(ctx context.Context, k, v string) error {
	_, err := s.w.ExecContext(ctx, `INSERT INTO server(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, []byte(v))
	return err
}

// Init makes sure server_id exists and, while unclaimed, that a claim code exists.
// presetCode (if non-empty) replaces the stored claim code while the server is unclaimed.
// It returns the server id, whether the server is claimed, and the current claim code.
func (s *Store) Init(ctx context.Context, presetCode string) (serverID string, claimed bool, code string, err error) {
	err = s.tx(ctx, func(tx *sql.Tx) error {
		get := func(k string) (string, bool, error) {
			var v []byte
			err := tx.QueryRow(`SELECT v FROM server WHERE k = ?`, k).Scan(&v)
			if errors.Is(err, sql.ErrNoRows) {
				return "", false, nil
			}
			return string(v), err == nil, err
		}
		set := func(k, v string) error {
			_, err := tx.Exec(`INSERT INTO server(k, v) VALUES(?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, []byte(v))
			return err
		}
		id, ok, err := get("server_id")
		if err != nil {
			return err
		}
		if !ok {
			id = RandomID(16)
			if err := set("server_id", id); err != nil {
				return err
			}
		}
		serverID = id
		var n int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM users WHERE role = ?`, HostAdmin).Scan(&n); err != nil {
			return err
		}
		claimed = n > 0
		if claimed {
			_, err := tx.Exec(`DELETE FROM server WHERE k = 'claim_code'`)
			return err
		}
		c, ok, err := get("claim_code")
		if err != nil {
			return err
		}
		switch {
		case presetCode != "":
			c = presetCode
		case !ok || c == "":
			c = RandomID(18)
		}
		code = c
		return set("claim_code", c)
	})
	return
}

// Claimed reports whether an admin exists.
func (s *Store) Claimed(ctx context.Context) (bool, error) {
	var n int
	err := s.r.QueryRowContext(ctx, `SELECT COUNT(*) FROM users WHERE role = ?`, HostAdmin).Scan(&n)
	return n > 0, err
}

// ClaimCode returns the current claim code, or ErrClaimed once claimed.
func (s *Store) ClaimCode(ctx context.Context) (string, error) {
	c, err := s.GetKV(ctx, "claim_code")
	if errors.Is(err, ErrNotFound) || c == "" {
		return "", ErrClaimed
	}
	return c, err
}

// Claim atomically registers the first admin if code matches. The caller verifies the signature.
func (s *Store) Claim(ctx context.Context, code string, signPk, boxPk []byte, now int64) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		var n int
		if err := tx.QueryRow(`SELECT COUNT(*) FROM users WHERE role = ?`, HostAdmin).Scan(&n); err != nil {
			return err
		}
		if n > 0 {
			return ErrClaimed
		}
		var stored []byte
		err := tx.QueryRow(`SELECT v FROM server WHERE k = 'claim_code'`).Scan(&stored)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrClaimed
		}
		if err != nil {
			return err
		}
		if !constEq(string(stored), code) {
			return ErrBadCode
		}
		if _, err := tx.Exec(`INSERT INTO users(sign_pk, box_pk, role, created_at) VALUES(?, ?, ?, ?)
			ON CONFLICT(sign_pk) DO UPDATE SET box_pk = excluded.box_pk, role = excluded.role`,
			signPk, boxPk, HostAdmin, now); err != nil {
			return err
		}
		_, err = tx.Exec(`DELETE FROM server WHERE k = 'claim_code'`)
		return err
	})
}

func constEq(a, b string) bool {
	if len(a) != len(b) {
		return false
	}
	var v byte
	for i := 0; i < len(a); i++ {
		v |= a[i] ^ b[i]
	}
	return v == 0
}

// ───────────── users ─────────────

type User struct {
	SignPk    []byte
	BoxPk     []byte
	Role      int
	CreatedAt int64
}

// GetUser returns the user with this sign_pk or ErrNotFound.
func (s *Store) GetUser(ctx context.Context, signPk []byte) (User, error) {
	u := User{SignPk: signPk}
	err := s.r.QueryRowContext(ctx, `SELECT box_pk, role, created_at FROM users WHERE sign_pk = ?`, signPk).
		Scan(&u.BoxPk, &u.Role, &u.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return u, ErrNotFound
	}
	return u, err
}

// ───────────── invites ─────────────

type Invite struct {
	Token      string
	Role       int
	CreatedBy  []byte
	CreatedAt  int64
	ExpiresAt  int64
	RedeemedBy []byte
	RedeemedAt int64
}

// CreateInvite stores a new host invite and returns its token.
func (s *Store) CreateInvite(ctx context.Context, role int, createdBy []byte, now, expiresAt int64) (string, error) {
	tok := RandomID(18)
	_, err := s.w.ExecContext(ctx, `INSERT INTO invites(token, role, created_by, created_at, expires_at) VALUES(?, ?, ?, ?, ?)`,
		tok, role, createdBy, now, expiresAt)
	return tok, err
}

// ListInvites returns all invites, newest first.
func (s *Store) ListInvites(ctx context.Context) ([]Invite, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT token, role, created_by, created_at, expires_at, redeemed_by, COALESCE(redeemed_at, 0)
		FROM invites ORDER BY created_at DESC, token`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Invite
	for rows.Next() {
		var i Invite
		if err := rows.Scan(&i.Token, &i.Role, &i.CreatedBy, &i.CreatedAt, &i.ExpiresAt, &i.RedeemedBy, &i.RedeemedAt); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

// Redeem consumes an invite for signPk and registers the user. Re-redeeming with the same
// key is idempotent. A key that is already a user keeps its existing (possibly higher) role.
// It returns the user's resulting host role.
func (s *Store) Redeem(ctx context.Context, token string, signPk, boxPk []byte, now int64) (int, error) {
	var role int
	err := s.tx(ctx, func(tx *sql.Tx) error {
		var inv Invite
		err := tx.QueryRow(`SELECT role, expires_at, redeemed_by FROM invites WHERE token = ?`, token).
			Scan(&inv.Role, &inv.ExpiresAt, &inv.RedeemedBy)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if inv.RedeemedBy != nil {
			if string(inv.RedeemedBy) != string(signPk) {
				return ErrRedeemed
			}
			return tx.QueryRow(`SELECT role FROM users WHERE sign_pk = ?`, signPk).Scan(&role)
		}
		if now >= inv.ExpiresAt {
			return ErrExpired
		}
		var existing int
		err = tx.QueryRow(`SELECT role FROM users WHERE sign_pk = ?`, signPk).Scan(&existing)
		switch {
		case errors.Is(err, sql.ErrNoRows):
			role = inv.Role
			if _, err := tx.Exec(`INSERT INTO users(sign_pk, box_pk, role, created_at) VALUES(?, ?, ?, ?)`,
				signPk, boxPk, role, now); err != nil {
				return err
			}
		case err != nil:
			return err
		default:
			role = existing
			if inv.Role < existing { // lower number = more privileged
				role = inv.Role
				if _, err := tx.Exec(`UPDATE users SET role = ? WHERE sign_pk = ?`, role, signPk); err != nil {
					return err
				}
			}
		}
		_, err = tx.Exec(`UPDATE invites SET redeemed_by = ?, redeemed_at = ? WHERE token = ?`, signPk, now, token)
		return err
	})
	return role, err
}

// ───────────── pairings ─────────────

// CreatePairing stores an opaque pairing ciphertext and returns its id.
func (s *Store) CreatePairing(ctx context.Context, owner, ciphertext []byte, expiresAt int64) (string, error) {
	id := RandomID(16)
	_, err := s.w.ExecContext(ctx, `INSERT INTO pairings(id, owner, ciphertext, expires_at) VALUES(?, ?, ?, ?)`,
		id, owner, ciphertext, expiresAt)
	return id, err
}

// TakePairing returns and deletes a pairing atomically. Expired or missing → ErrNotFound.
func (s *Store) TakePairing(ctx context.Context, id string, now int64) ([]byte, error) {
	var ct []byte
	var exp int64
	err := s.tx(ctx, func(tx *sql.Tx) error {
		err := tx.QueryRow(`DELETE FROM pairings WHERE id = ? RETURNING ciphertext, expires_at`, id).Scan(&ct, &exp)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		return err
	})
	if err != nil {
		return nil, err
	}
	if now >= exp {
		return nil, ErrNotFound
	}
	return ct, nil
}

// PruneExpired deletes expired pairings.
func (s *Store) PruneExpired(ctx context.Context, now int64) error {
	_, err := s.w.ExecContext(ctx, `DELETE FROM pairings WHERE expires_at <= ?`, now)
	return err
}
