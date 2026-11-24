package store

import (
	"bytes"
	"context"
	"database/sql"
	"errors"
	"path/filepath"
	"reflect"
	"sort"
	"testing"
	"time"
)

func ms(s string) int64 {
	t, err := time.Parse(time.DateTime, s)
	if err != nil {
		panic(err)
	}
	return t.UnixMilli()
}

func kept(keep map[uint64]bool) []uint64 {
	var out []uint64
	for b := range keep {
		out = append(out, b)
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func TestRetain(t *testing.T) {
	now := ms("2026-11-23 12:30:00")
	asc := []snapTime{
		{1, ms("2026-11-20 10:00:00")}, // older than every window
		{2, ms("2026-11-21 09:00:00")}, // its day starts inside the 2-day window, but it's older than 48 h
		{3, ms("2026-11-21 20:00:00")}, // newest of 11-21 within 48 h
		{4, ms("2026-11-22 08:00:00")},
		{5, ms("2026-11-22 23:59:59")}, // newest of 11-22
		{6, ms("2026-11-23 09:10:00")}, // hour 09 is older than 3 h; 11-23 has a newer one
		{7, ms("2026-11-23 10:05:00")},
		{8, ms("2026-11-23 10:45:00")}, // newest of hour 10
		{9, ms("2026-11-23 12:00:00")},
		{10, ms("2026-11-23 12:20:00")}, // latest, newest of hour 12 and of 11-23
	}
	desc := make([]snapTime, len(asc))
	for i, s := range asc {
		desc[len(asc)-1-i] = s
	}
	for _, tc := range []struct {
		h    History
		want []uint64
	}{
		{History{Hours: 3, Days: 2}, []uint64{3, 5, 8, 10}},
		{History{Hours: 3, Days: 0}, []uint64{8, 10}},
		{History{Hours: 0, Days: 0}, []uint64{10}},
		{History{Hours: 24, Days: 30}, []uint64{1, 3, 5, 6, 8, 10}},
	} {
		if got := kept(retain(desc, now, tc.h)); !reflect.DeepEqual(got, tc.want) {
			t.Errorf("%+v: kept %v, want %v", tc.h, got, tc.want)
		}
	}
	if got := retain(nil, now, DefaultHistory); len(got) != 0 {
		t.Errorf("empty: %v", got)
	}
	// The latest is kept even if it's ancient (or the clock went backwards).
	if got := kept(retain([]snapTime{{7, 0}, {6, 0}}, now, DefaultHistory)); !reflect.DeepEqual(got, []uint64{7}) {
		t.Errorf("ancient latest: %v", got)
	}
}

func TestSnapshotHistory(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	s.Init(ctx, "c")
	s.Claim(ctx, "c", pk(1), pk(2), 1)
	if err := s.CreateSpace(ctx, sp, 1, pk(1), []byte("w"), nil, 1); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		if _, err := s.AppendUpdate(ctx, sp, "d", Update{Author: pk(1), Payload: []byte("u"), Sig: []byte("s")}, 0); err != nil {
			t.Fatal(err)
		}
	}
	if d, _ := s.GetDoc(ctx, sp, "d"); d.SnapshotCreatedAt != 0 {
		t.Fatalf("no snapshot yet: %+v", d)
	}
	t0 := ms("2026-11-01 01:00:00")
	put := func(base uint64, at int64, payload string) {
		t.Helper()
		d, err := s.PutSnapshot(ctx, sp, "d", Snapshot{BaseSeq: base, Author: pk(1), Payload: []byte(payload), Sig: []byte("sig")}, at, 0)
		if err != nil || d.SnapshotCreatedAt != at {
			t.Fatalf("put %d: %+v %v", base, d, err)
		}
	}
	expect := func(want ...uint64) {
		t.Helper()
		if got, _ := s.SnapshotSeqs(ctx, sp, "d"); !reflect.DeepEqual(got, want) {
			t.Fatalf("retained %v, want %v", got, want)
		}
	}
	put(1, t0, "s1")
	put(2, t0+30*60*1000, "s2") // same hour and day as 1
	expect(2)
	put(3, t0+hourMs, "s3") // next hour, same day
	expect(2, 3)
	put(4, t0+25*hourMs, "snap-4") // next day: 2 and 3 fall out of the 24 h window; 3 is newest of its day
	expect(3, 4)
	if d, _ := s.GetDoc(ctx, sp, "d"); d.SnapshotSeq != 4 || d.SnapshotCreatedAt != t0+25*hourMs {
		t.Fatalf("doc: %+v", d)
	}
	if sn, err := s.LatestSnapshot(ctx, sp, "d"); err != nil || sn.CreatedAt != t0+25*hourMs {
		t.Fatalf("latest: %+v %v", sn, err)
	}

	vs, err := s.ListVersions(ctx, sp, "d")
	want := []Version{
		{BaseSeq: 4, CreatedAt: t0 + 25*hourMs, Author: pk(1), Size: 6, Epoch: 0},
		{BaseSeq: 3, CreatedAt: t0 + hourMs, Author: pk(1), Size: 2, Epoch: 0},
	}
	if err != nil || !reflect.DeepEqual(vs, want) {
		t.Fatalf("versions: %+v %v", vs, err)
	}
	v, err := s.GetVersion(ctx, sp, "d", 3)
	if err != nil || string(v.Payload) != "s3" || string(v.Sig) != "sig" || v.CreatedAt != t0+hourMs || !bytes.Equal(v.Author, pk(1)) {
		t.Fatalf("get version: %+v %v", v, err)
	}
	if _, err := s.GetVersion(ctx, sp, "d", 2); !errors.Is(err, ErrNotFound) {
		t.Fatalf("pruned version: %v", err)
	}
	if vs, err := s.ListVersions(ctx, sp, "nope"); err != nil || len(vs) != 0 {
		t.Fatalf("unknown doc: %v %v", vs, err)
	}

	// A stricter policy applies at the next snapshot.
	s.SetHistory(History{})
	put(5, t0+26*hourMs, "s5")
	expect(5)
}

func TestBlobRows(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if _, err := s.GetBlob(ctx, sp, "b"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("missing: %v", err)
	}
	if created, err := s.PutBlob(ctx, sp, "b", Blob{Size: 10, CreatedBy: pk(1), CreatedAt: 5}, 0); err != nil || !created {
		t.Fatalf("put: %v %v", created, err)
	}
	if created, err := s.PutBlob(ctx, sp, "b", Blob{Size: 99, CreatedBy: pk(2), CreatedAt: 6}, 0); err != nil || created {
		t.Fatalf("re-put: %v %v", created, err)
	}
	b, err := s.GetBlob(ctx, sp, "b")
	if err != nil || b.Size != 10 || !bytes.Equal(b.CreatedBy, pk(1)) || b.CreatedAt != 5 {
		t.Fatalf("get: %+v %v", b, err)
	}

	// Quota: a new row that takes its uploader over the cap isn't recorded; an existing one
	// (dedup) never counts.
	if created, err := s.PutBlob(ctx, sp, "c", Blob{Size: 15, CreatedBy: pk(1)}, 20); !errors.Is(err, ErrQuota) || created {
		t.Fatalf("over quota: %v %v", created, err)
	}
	if _, err := s.GetBlob(ctx, sp, "c"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("over-quota row recorded: %v", err)
	}
	if created, err := s.PutBlob(ctx, sp, "b", Blob{Size: 50, CreatedBy: pk(1)}, 20); err != nil || created {
		t.Fatalf("dedup under quota: %v %v", created, err)
	}
	if created, err := s.PutBlob(ctx, sp, "c", Blob{Size: 10, CreatedBy: pk(1)}, 20); err != nil || !created {
		t.Fatalf("up to quota: %v %v", created, err)
	}
	if used, err := s.UserBytes(ctx, pk(1)); err != nil || used != 20 {
		t.Fatalf("usage: %d %v", used, err)
	}
	if used, err := s.UserBytes(ctx, pk(3)); err != nil || used != 0 {
		t.Fatalf("usage of nobody: %d %v", used, err)
	}
}

func TestProfileSpaces(t *testing.T) {
	ctx := context.Background()
	s := open(t)
	if err := s.CreateSpace(ctx, sp, KindProfile, pk(1), []byte("w"), nil, 1); err != nil {
		t.Fatal(err)
	}
	if err := s.CreateSpace(ctx, "BBBBBBBBBBBBBBBBBBBBBB", KindProfile, pk(1), []byte("w"), nil, 1); !errors.Is(err, ErrConflict) {
		t.Fatalf("second profile: %v", err)
	}
	if err := s.CreateSpace(ctx, "BBBBBBBBBBBBBBBBBBBBBB", KindProfile, pk(2), []byte("w"), nil, 1); err != nil {
		t.Fatalf("another user's profile: %v", err)
	}
	if err := s.CreateSpace(ctx, "CCCCCCCCCCCCCCCCCCCCCC", KindShare, pk(1), []byte("w"), nil, 1); err != nil {
		t.Fatalf("share after profile: %v", err)
	}
}

// TestMigrateFromV1 opens a database created by the M1 schema and checks it upgrades in place.
func TestMigrateFromV1(t *testing.T) {
	ctx := context.Background()
	dir := t.TempDir()
	db, err := sql.Open("sqlite", "file:"+filepath.Join(dir, "tezca.db"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(migrations[0]); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`PRAGMA user_version = 1`); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO snapshots VALUES(?, 'd', 3, 0, ?, x'01', x'02', 1234)`, sp, pk(1)); err != nil {
		t.Fatal(err)
	}
	if _, err := db.Exec(`INSERT INTO docs VALUES(?, 'd', 3, 3, 0, 0)`, sp); err != nil {
		t.Fatal(err)
	}
	db.Close()

	s, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	var v int
	s.r.QueryRow(`PRAGMA user_version`).Scan(&v)
	if v != len(migrations) {
		t.Fatalf("user_version %d", v)
	}
	if d, err := s.GetDoc(ctx, sp, "d"); err != nil || d.SnapshotCreatedAt != 1234 {
		t.Fatalf("doc: %+v %v", d, err)
	}
	if _, err := s.PutBlob(ctx, sp, "b", Blob{Size: 1, CreatedBy: pk(1), CreatedAt: 1}, 0); err != nil {
		t.Fatalf("blobs table: %v", err)
	}
}
