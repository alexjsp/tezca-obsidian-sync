package store

import (
	"context"
	"database/sql"
	"errors"
)

// ───────────── shares (M3) ─────────────
//
// Authorization (OWNER, or the member themselves) is re-checked inside each transaction, so a
// concurrent role change can't slip between the API's check and the write.

// ShareInvite is a row of share_invites. Times are unix seconds.
type ShareInvite struct {
	Token      string
	SpaceID    string
	Role       int
	CreatedBy  []byte
	CreatedAt  int64
	ExpiresAt  int64
	RedeemedBy []byte
	RedeemedAt int64
}

// ShareRedemption is what a redeemer gets back: the invite's link-wrapped keys and the space.
type ShareRedemption struct {
	SpaceID   string
	Role      int // the redeemer's resulting role
	Keys      []SpaceKey
	Kind      int
	Epoch     uint32
	Meta      []byte
	MetaEpoch uint32
}

// MemberKey is one member's wrapped key for a rotation.
type MemberKey struct {
	SignPk  []byte
	Wrapped []byte
}

// memberRole returns signPk's role in space, or ok=false if not a member.
func memberRole(tx *sql.Tx, space string, signPk []byte) (role int, ok bool, err error) {
	err = tx.QueryRow(`SELECT role FROM members WHERE space_id = ? AND sign_pk = ?`, space, signPk).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, false, nil
	}
	return role, err == nil, err
}

// requireOwner returns ErrForbidden unless signPk is an OWNER of space.
func requireOwner(tx *sql.Tx, space string, signPk []byte) error {
	role, ok, err := memberRole(tx, space, signPk)
	if err != nil {
		return err
	}
	if !ok || role != SpaceOwner {
		return ErrForbidden
	}
	return nil
}

func spaceEpoch(tx *sql.Tx, space string) (uint32, error) {
	var e uint32
	err := tx.QueryRow(`SELECT epoch FROM spaces WHERE space_id = ?`, space).Scan(&e)
	if errors.Is(err, sql.ErrNoRows) {
		return 0, ErrNotFound
	}
	return e, err
}

func ownerCount(tx *sql.Tx, space string) (int, error) {
	var n int
	err := tx.QueryRow(`SELECT COUNT(*) FROM members WHERE space_id = ? AND role = ?`, space, SpaceOwner).Scan(&n)
	return n, err
}

// CreateShareInvite stores an invite for space made by owner. keys must hold exactly one
// key for every epoch 0..current (ErrBadKeys otherwise). Not an owner → ErrForbidden.
func (s *Store) CreateShareInvite(ctx context.Context, space string, owner []byte, role int, keys []SpaceKey, now, expiresAt int64) (string, error) {
	tok := RandomID(18)
	err := s.tx(ctx, func(tx *sql.Tx) error {
		if err := requireOwner(tx, space, owner); err != nil {
			return err
		}
		cur, err := spaceEpoch(tx, space)
		if err != nil {
			return err
		}
		if len(keys) != int(cur)+1 {
			return ErrBadKeys
		}
		seen := make([]bool, cur+1)
		for _, k := range keys {
			if k.Epoch > cur || seen[k.Epoch] {
				return ErrBadKeys
			}
			seen[k.Epoch] = true
		}
		if _, err := tx.Exec(`INSERT INTO share_invites(token, space_id, role, created_by, created_at, expires_at) VALUES(?, ?, ?, ?, ?, ?)`,
			tok, space, role, owner, now, expiresAt); err != nil {
			return err
		}
		for _, k := range keys {
			if _, err := tx.Exec(`INSERT INTO share_invite_keys(token, epoch, wrapped) VALUES(?, ?, ?)`, tok, k.Epoch, k.Wrapped); err != nil {
				return err
			}
		}
		return nil
	})
	return tok, err
}

// ListShareInvites returns a space's invites that haven't been revoked, newest first.
func (s *Store) ListShareInvites(ctx context.Context, space string) ([]ShareInvite, error) {
	rows, err := s.r.QueryContext(ctx, `SELECT token, role, created_by, created_at, expires_at, redeemed_by, COALESCE(redeemed_at, 0)
		FROM share_invites WHERE space_id = ? AND revoked = 0 ORDER BY created_at DESC, token`, space)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []ShareInvite
	for rows.Next() {
		i := ShareInvite{SpaceID: space}
		if err := rows.Scan(&i.Token, &i.Role, &i.CreatedBy, &i.CreatedAt, &i.ExpiresAt, &i.RedeemedBy, &i.RedeemedAt); err != nil {
			return nil, err
		}
		out = append(out, i)
	}
	return out, rows.Err()
}

// RevokeShareInvite revokes an unredeemed invite of space and drops its wrapped keys.
// Unknown (or another space's) → ErrNotFound; redeemed → ErrRedeemed; already revoked → nil.
func (s *Store) RevokeShareInvite(ctx context.Context, space string, owner []byte, token string) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := requireOwner(tx, space, owner); err != nil {
			return err
		}
		var redeemedBy []byte
		err := tx.QueryRow(`SELECT redeemed_by FROM share_invites WHERE token = ? AND space_id = ?`, token, space).Scan(&redeemedBy)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		if redeemedBy != nil {
			return ErrRedeemed
		}
		if _, err := tx.Exec(`UPDATE share_invites SET revoked = 1 WHERE token = ?`, token); err != nil {
			return err
		}
		_, err = tx.Exec(`DELETE FROM share_invite_keys WHERE token = ?`, token)
		return err
	})
}

// RedeemShareInvite consumes an invite for signPk and adds them to the space (an existing
// member keeps the higher role). Re-redeeming with the same key returns the same answer while
// the redeemer is still a member. Errors: ErrNotFound (unknown), ErrRedeemed (another key),
// ErrExpired (expired, revoked, or the redeemer has since been removed). joined reports whether
// this call changed the space's membership.
//
// With a non-nil guestBoxPk (M4), a caller who isn't a host user yet is registered as a GUEST
// with that box key once the invite has been checked, in the same transaction; a failed redeem
// creates no user. An existing user keeps their role and box key.
func (s *Store) RedeemShareInvite(ctx context.Context, token string, signPk, guestBoxPk []byte, now int64) (out ShareRedemption, joined bool, err error) {
	err = s.tx(ctx, func(tx *sql.Tx) error {
		ensureUser := func() error {
			if guestBoxPk == nil {
				return nil
			}
			_, err := tx.Exec(`INSERT INTO users(sign_pk, box_pk, role, created_at) VALUES(?, ?, ?, ?)
				ON CONFLICT(sign_pk) DO NOTHING`, signPk, guestBoxPk, HostGuest, now)
			return err
		}
		var inv ShareInvite
		var revoked bool
		err := tx.QueryRow(`SELECT space_id, role, expires_at, revoked, redeemed_by FROM share_invites WHERE token = ?`, token).
			Scan(&inv.SpaceID, &inv.Role, &inv.ExpiresAt, &revoked, &inv.RedeemedBy)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		space := inv.SpaceID
		role, isMember, err := memberRole(tx, space, signPk)
		if err != nil {
			return err
		}
		switch {
		case inv.RedeemedBy != nil && string(inv.RedeemedBy) != string(signPk):
			return ErrRedeemed
		case inv.RedeemedBy != nil:
			if !isMember {
				return ErrExpired // removed (or left) since redeeming; the link can't re-add them
			}
		case revoked || now >= inv.ExpiresAt:
			return ErrExpired
		default:
			switch {
			case !isMember:
				role = inv.Role
				if _, err := tx.Exec(`INSERT INTO members(space_id, sign_pk, role) VALUES(?, ?, ?)`, space, signPk, role); err != nil {
					return err
				}
				joined = true
			case inv.Role < role: // lower number = more privileged
				role = inv.Role
				if _, err := tx.Exec(`UPDATE members SET role = ? WHERE space_id = ? AND sign_pk = ?`, role, space, signPk); err != nil {
					return err
				}
				joined = true
			}
			if _, err := tx.Exec(`UPDATE share_invites SET redeemed_by = ?, redeemed_at = ? WHERE token = ?`, signPk, now, token); err != nil {
				return err
			}
		}
		if err := ensureUser(); err != nil {
			return err
		}
		out = ShareRedemption{SpaceID: space, Role: role}
		err = tx.QueryRow(`SELECT kind, epoch, meta, meta_epoch FROM spaces WHERE space_id = ?`, space).
			Scan(&out.Kind, &out.Epoch, &out.Meta, &out.MetaEpoch)
		if errors.Is(err, sql.ErrNoRows) {
			return ErrNotFound
		}
		if err != nil {
			return err
		}
		rows, err := tx.Query(`SELECT epoch, wrapped FROM share_invite_keys WHERE token = ? ORDER BY epoch`, token)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			var k SpaceKey
			if err := rows.Scan(&k.Epoch, &k.Wrapped); err != nil {
				return err
			}
			out.Keys = append(out.Keys, k)
		}
		return rows.Err()
	})
	return
}

// PutMemberKeys stores signPk's own wrapped keys for space, replacing any for the same epoch.
// Not a member → ErrForbidden; an epoch above the current one → ErrBadKeys.
func (s *Store) PutMemberKeys(ctx context.Context, space string, signPk []byte, keys []SpaceKey) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if _, ok, err := memberRole(tx, space, signPk); err != nil {
			return err
		} else if !ok {
			return ErrForbidden
		}
		cur, err := spaceEpoch(tx, space)
		if err != nil {
			return err
		}
		for _, k := range keys {
			if k.Epoch > cur {
				return ErrBadKeys
			}
			if _, err := tx.Exec(`INSERT INTO space_keys(space_id, epoch, sign_pk, wrapped) VALUES(?, ?, ?, ?)
				ON CONFLICT(space_id, epoch, sign_pk) DO UPDATE SET wrapped = excluded.wrapped`, space, k.Epoch, signPk, k.Wrapped); err != nil {
				return err
			}
		}
		return nil
	})
}

// SetMemberRole changes target's role (owner only). Target not a member → ErrNotFound;
// demoting the last owner → ErrLastOwner.
func (s *Store) SetMemberRole(ctx context.Context, space string, owner, target []byte, role int) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := requireOwner(tx, space, owner); err != nil {
			return err
		}
		cur, ok, err := memberRole(tx, space, target)
		if err != nil {
			return err
		}
		if !ok {
			return ErrNotFound
		}
		if cur == role {
			return nil
		}
		if cur == SpaceOwner {
			n, err := ownerCount(tx, space)
			if err != nil {
				return err
			}
			if n <= 1 {
				return ErrLastOwner
			}
		}
		_, err = tx.Exec(`UPDATE members SET role = ? WHERE space_id = ? AND sign_pk = ?`, role, space, target)
		return err
	})
}

// RemoveMember removes target from space with their wrapped keys. actor must be an owner or
// target itself (ErrForbidden otherwise). Target not a member → ErrNotFound; removing the last
// owner → ErrLastOwner.
func (s *Store) RemoveMember(ctx context.Context, space string, actor, target []byte) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if string(actor) != string(target) {
			if err := requireOwner(tx, space, actor); err != nil {
				return err
			}
		}
		cur, ok, err := memberRole(tx, space, target)
		if err != nil {
			return err
		}
		if !ok {
			if string(actor) == string(target) {
				return ErrForbidden // leaving a space you're not in
			}
			return ErrNotFound
		}
		if cur == SpaceOwner {
			n, err := ownerCount(tx, space)
			if err != nil {
				return err
			}
			if n <= 1 {
				return ErrLastOwner
			}
		}
		if _, err := tx.Exec(`DELETE FROM members WHERE space_id = ? AND sign_pk = ?`, space, target); err != nil {
			return err
		}
		_, err = tx.Exec(`DELETE FROM space_keys WHERE space_id = ? AND sign_pk = ?`, space, target)
		return err
	})
}

// RotateKey stores a new epoch's key for every member and makes it current (owner only).
// epoch ≠ current+1 → ErrConflict; keys not exactly one per current member → ErrBadKeys.
// Unredeemed invites are revoked: their keys stop at the old epoch.
func (s *Store) RotateKey(ctx context.Context, space string, owner []byte, epoch uint32, keys []MemberKey) error {
	return s.tx(ctx, func(tx *sql.Tx) error {
		if err := requireOwner(tx, space, owner); err != nil {
			return err
		}
		cur, err := spaceEpoch(tx, space)
		if err != nil {
			return err
		}
		if epoch != cur+1 {
			return ErrConflict
		}
		members, err := memberPks(tx, space)
		if err != nil {
			return err
		}
		if len(keys) != len(members) {
			return ErrBadKeys
		}
		want := map[string]bool{}
		for _, m := range members {
			want[string(m)] = true
		}
		for _, k := range keys {
			if !want[string(k.SignPk)] {
				return ErrBadKeys // not a member, or a duplicate
			}
			delete(want, string(k.SignPk))
		}
		for _, k := range keys {
			if _, err := tx.Exec(`INSERT INTO space_keys(space_id, epoch, sign_pk, wrapped) VALUES(?, ?, ?, ?)
				ON CONFLICT(space_id, epoch, sign_pk) DO UPDATE SET wrapped = excluded.wrapped`, space, epoch, k.SignPk, k.Wrapped); err != nil {
				return err
			}
		}
		if _, err := tx.Exec(`UPDATE spaces SET epoch = ? WHERE space_id = ?`, epoch, space); err != nil {
			return err
		}
		if _, err := tx.Exec(`DELETE FROM share_invite_keys WHERE token IN
			(SELECT token FROM share_invites WHERE space_id = ? AND redeemed_by IS NULL AND revoked = 0)`, space); err != nil {
			return err
		}
		_, err = tx.Exec(`UPDATE share_invites SET revoked = 1 WHERE space_id = ? AND redeemed_by IS NULL AND revoked = 0`, space)
		return err
	})
}

type queryer interface {
	QueryContext(ctx context.Context, q string, args ...any) (*sql.Rows, error)
}

func memberPksQ(ctx context.Context, q queryer, space string) ([][]byte, error) {
	rows, err := q.QueryContext(ctx, `SELECT sign_pk FROM members WHERE space_id = ? ORDER BY sign_pk`, space)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out [][]byte
	for rows.Next() {
		var pk []byte
		if err := rows.Scan(&pk); err != nil {
			return nil, err
		}
		out = append(out, pk)
	}
	return out, rows.Err()
}

func memberPks(tx *sql.Tx, space string) ([][]byte, error) {
	return memberPksQ(context.Background(), tx, space)
}

// MemberPks lists the sign_pks of a space's members.
func (s *Store) MemberPks(ctx context.Context, space string) ([][]byte, error) {
	return memberPksQ(ctx, s.r, space)
}
