package store

import (
	"bytes"
	"context"
	"errors"
	"reflect"
	"testing"
)

func open(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func pk(b byte) []byte { return bytes.Repeat([]byte{b}, 32) }

const sp = "AAAAAAAAAAAAAAAAAAAAAA"

func TestInitAndClaim(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	id, claimed, code, err := s.Init(ctx, "")
	if err != nil || claimed || code == "" || id == "" {
		t.Fatalf("init: %v %v %q %q", err, claimed, code, id)
	}
	// Preset code overrides while unclaimed; server id is stable.
	id2, _, code2, err := s.Init(ctx, "preset")
	if err != nil || id2 != id || code2 != "preset" {
		t.Fatalf("re-init: %v %q %q", err, id2, code2)
	}
	if err := s.Claim(ctx, "wrong", pk(1), pk(2), 1); !errors.Is(err, ErrBadCode) {
		t.Fatalf("wrong code: %v", err)
	}
	if err := s.Claim(ctx, "preset", pk(1), pk(2), 1); err != nil {
		t.Fatal(err)
	}
	if err := s.Claim(ctx, "preset", pk(3), pk(4), 1); !errors.Is(err, ErrClaimed) {
		t.Fatalf("second claim: %v", err)
	}
	if _, err := s.ClaimCode(ctx); !errors.Is(err, ErrClaimed) {
		t.Fatalf("claim code after claim: %v", err)
	}
	u, err := s.GetUser(ctx, pk(1))
	if err != nil || u.Role != HostAdmin || !bytes.Equal(u.BoxPk, pk(2)) {
		t.Fatalf("user: %+v %v", u, err)
	}
	if _, err := s.GetUser(ctx, pk(9)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown user: %v", err)
	}
	s.Close()

	// Reopen: persisted, still claimed, no new claim code.
	s, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	id3, claimed, code, err := s.Init(ctx, "preset")
	if err != nil || id3 != id || !claimed || code != "" {
		t.Fatalf("reopen: %v %q %v %q", err, id3, claimed, code)
	}
}

func TestInvites(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	tok, err := s.CreateInvite(ctx, HostMember, pk(1), 100, 200)
	if err != nil {
		t.Fatal(err)
	}
	if role, err := s.Redeem(ctx, tok, pk(5), pk(6), 150); err != nil || role != HostMember {
		t.Fatalf("redeem: %v %v", role, err)
	}
	if role, err := s.Redeem(ctx, tok, pk(5), pk(6), 999); err != nil || role != HostMember {
		t.Fatalf("idempotent redeem: %v %v", role, err)
	}
	if _, err := s.Redeem(ctx, tok, pk(7), pk(8), 150); !errors.Is(err, ErrRedeemed) {
		t.Fatalf("other key: %v", err)
	}
	if _, err := s.Redeem(ctx, "nope", pk(7), pk(8), 150); !errors.Is(err, ErrNotFound) {
		t.Fatalf("unknown token: %v", err)
	}
	tok2, _ := s.CreateInvite(ctx, HostGuest, pk(1), 100, 200)
	if _, err := s.Redeem(ctx, tok2, pk(7), pk(8), 200); !errors.Is(err, ErrExpired) {
		t.Fatalf("expired: %v", err)
	}
	invs, err := s.ListInvites(ctx)
	if err != nil || len(invs) != 2 {
		t.Fatalf("list: %v %v", invs, err)
	}
}

func TestPairings(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	id, err := s.CreatePairing(ctx, pk(1), []byte("ct"), 100)
	if err != nil {
		t.Fatal(err)
	}
	ct, err := s.TakePairing(ctx, id, 50)
	if err != nil || string(ct) != "ct" {
		t.Fatalf("take: %q %v", ct, err)
	}
	if _, err := s.TakePairing(ctx, id, 50); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second take: %v", err)
	}
	id2, _ := s.CreatePairing(ctx, pk(1), []byte("ct"), 100)
	if _, err := s.TakePairing(ctx, id2, 100); !errors.Is(err, ErrNotFound) {
		t.Fatalf("expired take: %v", err)
	}
	s.CreatePairing(ctx, pk(1), []byte("ct"), 100)
	if err := s.PruneExpired(ctx, 100); err != nil {
		t.Fatal(err)
	}
}

func TestSpacesAndDocs(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.Init(ctx, "c")
	s.Claim(ctx, "c", pk(1), pk(2), 1)
	if err := s.CreateSpace(ctx, sp, 1, pk(1), []byte("wrapped"), []byte("meta"), 1); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateSpace(ctx, sp, 1, pk(1), []byte("wrapped"), nil, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("dup space: %v", err)
	}
	spaces, err := s.ListSpaces(ctx, pk(1))
	if err != nil || len(spaces) != 1 {
		t.Fatalf("list: %v %v", spaces, err)
	}
	got := spaces[0]
	if got.Role != SpaceOwner || got.Epoch != 0 || len(got.Keys) != 1 || string(got.Keys[0].Wrapped) != "wrapped" ||
		len(got.Members) != 1 || !bytes.Equal(got.Members[0].BoxPk, pk(2)) || string(got.Meta) != "meta" {
		t.Fatalf("space: %+v", got)
	}
	if role, epoch, err := s.Membership(ctx, sp, pk(1)); err != nil || role != SpaceOwner || epoch != 0 {
		t.Fatalf("membership: %v %v %v", role, epoch, err)
	}
	if _, _, err := s.Membership(ctx, sp, pk(9)); !errors.Is(err, ErrNotFound) {
		t.Fatalf("non-member: %v", err)
	}

	// Empty doc.
	d, err := s.GetDoc(ctx, sp, "index")
	if err != nil || d.LatestSeq != 0 {
		t.Fatalf("empty doc: %+v %v", d, err)
	}
	for i := 1; i <= 10; i++ {
		d, err := s.AppendUpdate(ctx, sp, "index", Update{Epoch: 0, Author: pk(1), Payload: make([]byte, 10), Sig: []byte("s")})
		if err != nil || d.LatestSeq != uint64(i) || d.UpdatesSinceSnapshot != uint32(i) || d.BytesSinceSnapshot != uint64(10*i) {
			t.Fatalf("append %d: %+v %v", i, d, err)
		}
	}
	if _, err := s.AppendUpdate(ctx, sp, "index", Update{Epoch: 1, Author: pk(1), Payload: []byte{1}, Sig: []byte("s")}); !errors.Is(err, ErrEpochStale) {
		t.Fatalf("stale epoch: %v", err)
	}
	var batches [][]uint64
	err = s.StreamUpdates(ctx, sp, "index", 2, 3, 1<<20, func(b []Update) error {
		var seqs []uint64
		for _, u := range b {
			seqs = append(seqs, u.Seq)
		}
		batches = append(batches, seqs)
		return nil
	})
	if err != nil || !reflect.DeepEqual(batches, [][]uint64{{3, 4, 5}, {6, 7, 8}, {9, 10}}) {
		t.Fatalf("stream: %v %v", batches, err)
	}
	batches = nil
	s.StreamUpdates(ctx, sp, "index", 0, 100, 25, func(b []Update) error {
		batches = append(batches, []uint64{uint64(len(b))})
		return nil
	})
	if !reflect.DeepEqual(batches, [][]uint64{{2}, {2}, {2}, {2}, {2}}) {
		t.Fatalf("byte batching: %v", batches)
	}

	// Snapshots.
	snap := func(base uint64) error {
		_, err := s.PutSnapshot(ctx, sp, "index", Snapshot{BaseSeq: base, Author: pk(1), Payload: []byte("snap"), Sig: []byte("s")}, 1)
		return err
	}
	for _, bad := range []uint64{0, 11} {
		if err := snap(bad); !errors.Is(err, ErrConflict) {
			t.Fatalf("snapshot %d: %v", bad, err)
		}
	}
	if _, err := s.PutSnapshot(ctx, sp, "other", Snapshot{BaseSeq: 1}, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("snapshot of missing doc: %v", err)
	}
	if err := snap(4); err != nil {
		t.Fatal(err)
	}
	if err := snap(4); !errors.Is(err, ErrConflict) {
		t.Fatalf("same base: %v", err)
	}
	d, _ = s.GetDoc(ctx, sp, "index")
	if d.SnapshotSeq != 4 || d.LatestSeq != 10 || d.UpdatesSinceSnapshot != 6 || d.BytesSinceSnapshot != 60 {
		t.Fatalf("after snapshot: %+v", d)
	}
	var first uint64
	s.StreamUpdates(ctx, sp, "index", 0, 100, 1<<20, func(b []Update) error { first = b[0].Seq; return nil })
	if first != 5 {
		t.Fatalf("prune: first remaining seq %d", first)
	}
	for _, b := range []uint64{6, 8, 10} {
		if err := snap(b); err != nil {
			t.Fatal(err)
		}
	}
	seqs, _ := s.SnapshotSeqs(ctx, sp, "index")
	if !reflect.DeepEqual(seqs, []uint64{6, 8, 10}) {
		t.Fatalf("retained snapshots: %v", seqs)
	}
	sn, err := s.LatestSnapshot(ctx, sp, "index")
	if err != nil || sn.BaseSeq != 10 {
		t.Fatalf("latest snapshot: %+v %v", sn, err)
	}
	heads, err := s.DocHeads(ctx, sp)
	if err != nil || len(heads) != 1 || heads[0].LatestSeq != 10 || heads[0].SnapshotSeq != 10 || heads[0].UpdatesSinceSnapshot != 0 {
		t.Fatalf("heads: %+v %v", heads, err)
	}

	// Members.
	if err := s.AddMember(ctx, sp, pk(3), SpaceViewer, []byte("w3")); err != nil {
		t.Fatal(err)
	}
	if role, _, err := s.Membership(ctx, sp, pk(3)); err != nil || role != SpaceViewer {
		t.Fatalf("viewer: %v %v", role, err)
	}
}

func TestValidID(t *testing.T) {
	for _, ok := range []string{"index", sp, "a-b_c"} {
		if !ValidID(ok) {
			t.Errorf("%q should be valid", ok)
		}
	}
	for _, bad := range []string{"", "a/b", "a b", string(make([]byte, 65))} {
		if ValidID(bad) {
			t.Errorf("%q should be invalid", bad)
		}
	}
}
