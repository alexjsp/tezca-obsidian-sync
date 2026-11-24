package store

import (
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"testing"
)

// TestMigrateFromV2 opens a database created by the M2 schema (with a space in it) and checks it
// upgrades in place, keeps its data, and supports share invites. The v3 migration is idempotent,
// so a database that already has the share tables at user_version 2 upgrades too.
func TestMigrateFromV2(t *testing.T) {
	for _, preexisting := range []bool{false, true} {
		ctx := context.Background()
		dir := t.TempDir()
		db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "tezca.db"))
		if err != nil {
			t.Fatal(err)
		}
		for _, m := range migrations[:2] {
			if _, err := db.Exec(m); err != nil {
				t.Fatal(err)
			}
		}
		if preexisting {
			if _, err := db.Exec(migrations[2]); err != nil {
				t.Fatal(err)
			}
		}
		if _, err := db.Exec(`PRAGMA user_version = 2`); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO users VALUES(?, ?, 1, 1), (?, ?, 2, 1)`, pk(1), pk(11), pk(2), pk(12)); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO spaces VALUES(?, 2, 0, x'6d', 0, ?, 1)`, sp, pk(1)); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO members VALUES(?, ?, 1)`, sp, pk(1)); err != nil {
			t.Fatal(err)
		}
		if _, err := db.Exec(`INSERT INTO space_keys VALUES(?, 0, ?, x'01')`, sp, pk(1)); err != nil {
			t.Fatal(err)
		}
		db.Close()

		s, err := Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		var v int
		s.r.QueryRow(`PRAGMA user_version`).Scan(&v)
		if v != len(migrations) || v != 6 {
			t.Fatalf("user_version %d", v)
		}
		if got, err := s.GetSpace(ctx, sp, pk(1)); err != nil || got.Role != SpaceOwner || len(got.Keys) != 1 {
			t.Fatalf("space after migration: %+v %v", got, err)
		}
		tok, err := s.CreateShareInvite(ctx, sp, pk(1), SpaceEditor, []SpaceKey{{Epoch: 0, Wrapped: []byte("k")}}, 10, 100)
		if err != nil {
			t.Fatal(err)
		}
		res, joined, err := s.RedeemShareInvite(ctx, tok, pk(2), nil, 20)
		if err != nil || !joined || res.Role != SpaceEditor || res.Kind != 2 || len(res.Keys) != 1 {
			t.Fatalf("redeem: %+v %v %v", res, joined, err)
		}
		s.Close()

		// Reopening is a no-op.
		s, err = Open(dir)
		if err != nil {
			t.Fatal(err)
		}
		if _, _, err := s.RedeemShareInvite(ctx, tok, pk(3), nil, 20); !errors.Is(err, ErrRedeemed) {
			t.Fatalf("after reopen: %v", err)
		}
		s.Close()
	}
}
