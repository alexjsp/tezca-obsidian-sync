package store

import (
	"context"
	"errors"
	"testing"
)

func TestRemoveUser(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if _, _, _, err := s.Init(ctx, "code"); err != nil {
		t.Fatal(err)
	}
	admin, member, other := pk(1), pk(2), pk(3)
	if err := s.Claim(ctx, "code", admin, pk(11), 1_700_000_000_000); err != nil {
		t.Fatal(err)
	}
	for _, u := range [][]byte{member, other} {
		tok, _ := s.CreateInvite(ctx, HostMember, admin, 1, 1000)
		if _, err := s.Redeem(ctx, tok, u, pk(12), 2); err != nil {
			t.Fatal(err)
		}
	}
	// member owns a share that other is in, and has a pairing and pending invites.
	if err := s.CreateSpace(ctx, sp, KindShare, member, []byte("w"), nil, 1); err != nil {
		t.Fatal(err)
	}
	if err := s.AddMember(ctx, sp, other, SpaceEditor, []byte("w2")); err != nil {
		t.Fatal(err)
	}
	pairing, _ := s.CreatePairing(ctx, member, []byte("ct"), 1, 1000)
	shareTok, err := s.CreateShareInvite(ctx, sp, member, SpaceViewer, []SpaceKey{{Epoch: 0, Wrapped: []byte("k")}}, 1, 1000)
	if err != nil {
		t.Fatal(err)
	}

	if _, err := s.RemoveUser(ctx, member, other); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-admin: %v", err)
	}
	if _, err := s.RemoveUser(ctx, admin, pk(9)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown: %v", err)
	}
	if _, err := s.RemoveUser(ctx, admin, admin); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("last admin: %v", err)
	}
	spaces, err := s.RemoveUser(ctx, admin, member)
	if err != nil || len(spaces) != 1 || spaces[0] != sp {
		t.Fatalf("remove: %v %v", spaces, err)
	}
	if _, err := s.GetUser(ctx, member); !errors.Is(err, ErrNotFound) {
		t.Fatalf("user still there: %v", err)
	}
	if _, _, err := s.Membership(ctx, sp, member); !errors.Is(err, ErrNotFound) {
		t.Fatalf("membership still there: %v", err)
	}
	if _, err := s.TakePairing(ctx, pairing, 2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pairing still there: %v", err)
	}
	if _, _, err := s.RedeemShareInvite(ctx, shareTok, pk(4), pk(14), 2); !errors.Is(err, ErrExpired) {
		t.Fatalf("share invite still usable: %v", err)
	}
	// The share and its other member stay.
	if role, _, err := s.Membership(ctx, sp, other); err != nil || role != SpaceEditor {
		t.Fatalf("other member: %d %v", role, err)
	}
	var keys int
	s.r.QueryRow(`SELECT COUNT(*) FROM space_keys WHERE sign_pk = ?`, member).Scan(&keys)
	if keys != 0 {
		t.Fatalf("%d wrapped keys left", keys)
	}

	// With two admins, either may remove the other (or themselves); never the last one.
	if _, err := s.w.Exec(`UPDATE users SET role = ? WHERE sign_pk = ?`, HostAdmin, other); err != nil {
		t.Fatal(err)
	}
	if _, err := s.RemoveUser(ctx, admin, admin); err != nil {
		t.Fatalf("remove self with another admin: %v", err)
	}
	if _, err := s.RemoveUser(ctx, other, other); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("now the last admin: %v", err)
	}
	users, err := s.ListUsers(ctx)
	if err != nil || len(users) != 1 || string(users[0].SignPk) != string(other) || users[0].Role != HostAdmin {
		t.Fatalf("users: %+v %v", users, err)
	}
}

func TestSetUserRole(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if _, _, _, err := s.Init(ctx, "code"); err != nil {
		t.Fatal(err)
	}
	admin, member, guest := pk(1), pk(2), pk(3)
	if err := s.Claim(ctx, "code", admin, pk(11), 1_700_000_000_000); err != nil {
		t.Fatal(err)
	}
	for _, u := range []struct {
		pk   []byte
		role int
	}{{member, HostMember}, {guest, HostGuest}} {
		tok, _ := s.CreateInvite(ctx, u.role, admin, 1, 1000)
		if _, err := s.Redeem(ctx, tok, u.pk, pk(12), 2); err != nil {
			t.Fatal(err)
		}
	}
	role := func(p []byte) int {
		u, err := s.GetUser(ctx, p)
		if err != nil {
			t.Fatal(err)
		}
		return u.Role
	}

	if err := s.SetUserRole(ctx, member, member, HostAdmin); !errors.Is(err, ErrForbidden) {
		t.Fatalf("non-admin promoting: %v", err)
	}
	if err := s.SetUserRole(ctx, admin, pk(9), HostAdmin); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown: %v", err)
	}
	if err := s.SetUserRole(ctx, admin, guest, HostAdmin); !errors.Is(err, ErrGuest) {
		t.Fatalf("guest: %v", err)
	}
	if err := s.SetUserRole(ctx, admin, member, HostGuest); err == nil {
		t.Fatal("demoting to guest should be refused")
	}
	if err := s.SetUserRole(ctx, admin, admin, HostMember); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("last admin: %v", err)
	}
	if err := s.SetUserRole(ctx, admin, member, HostAdmin); err != nil || role(member) != HostAdmin {
		t.Fatalf("promote: %v, role %d", err, role(member))
	}
	if err := s.SetUserRole(ctx, admin, member, HostAdmin); err != nil {
		t.Fatalf("promoting again is a no-op: %v", err)
	}
	// With two admins, either can step down; the last one can't.
	if err := s.SetUserRole(ctx, admin, admin, HostMember); err != nil || role(admin) != HostMember {
		t.Fatalf("step down: %v", err)
	}
	if err := s.SetUserRole(ctx, admin, member, HostMember); !errors.Is(err, ErrForbidden) {
		t.Fatalf("former admin: %v", err)
	}
	if err := s.SetUserRole(ctx, member, member, HostMember); !errors.Is(err, ErrLastAdmin) {
		t.Fatalf("last admin stepping down: %v", err)
	}
}
