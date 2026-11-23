package e2e

import (
	"bytes"
	"context"
	"fmt"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"tezca/server/internal/pb"
	"tezca/server/internal/sigs"
	"tezca/server/internal/store"
	"tezca/server/internal/ws"
)

// TestWSSyncFlow walks the whole M1 session: create space, space feed, doc subscribe, concurrent
// pushes from two connections with strict per-connection ordering, resubscribe, snapshots.
func TestWSSyncFlow(t *testing.T) {
	e := newEnv(t, nil)
	admin := newIdent()
	e.claim(admin)

	a := e.dial(admin, "dev-a")
	b := e.dial(admin, "dev-b")
	space := randSpaceID()

	// Ping/Pong.
	a.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Ping{Ping: &pb.Ping{T: 42}}})
	if p := a.recv().GetPong(); p == nil || p.T != 42 {
		t.Fatalf("pong: %v", p)
	}

	info := a.createSpace(7, space)
	if info.Epoch != 0 || len(info.Keys) != 1 || string(info.Keys[0].Wrapped) != "wrapped-for-dev-a" ||
		len(info.Members) != 1 || !bytes.Equal(info.Members[0].BoxPk, admin.box) || string(info.Meta) != "meta" {
		t.Fatalf("space info: %v", info)
	}
	// Duplicate id.
	a.send(&pb.ClientFrame{Msg: &pb.ClientFrame_CreateSpace{CreateSpace: &pb.CreateSpace{
		Rid: 8, SpaceId: space, Kind: pb.SpaceKind_SPACE_KIND_ROOT, WrappedKey: []byte("w")}}})
	a.expectError(8, pb.ErrorCode_ERROR_CODE_CONFLICT)
	// Bad id.
	a.send(&pb.ClientFrame{Msg: &pb.ClientFrame_CreateSpace{CreateSpace: &pb.CreateSpace{
		Rid: 9, SpaceId: "short", Kind: pb.SpaceKind_SPACE_KIND_ROOT, WrappedKey: []byte("w")}}})
	a.expectError(9, pb.ErrorCode_ERROR_CODE_BAD_REQUEST)

	// ListSpaces from the other device.
	b.send(&pb.ClientFrame{Msg: &pb.ClientFrame_ListSpaces{ListSpaces: &pb.ListSpaces{Rid: 3}}})
	if l := b.recv().GetSpaceList(); l == nil || l.Rid != 3 || len(l.Spaces) != 1 || l.Spaces[0].SpaceId != space {
		t.Fatalf("space list: %v", l)
	}

	// Space feed on a: empty full heads.
	a.send(&pb.ClientFrame{Msg: &pb.ClientFrame_SubscribeSpace{SubscribeSpace: &pb.SubscribeSpace{SpaceId: space}}})
	if h := a.recv().GetDocHeads(); h == nil || !h.Full || h.SpaceId != space || len(h.Heads) != 0 {
		t.Fatalf("initial heads: %v", h)
	}

	// Subscribing to an empty doc.
	const doc = "index"
	for _, c := range []*client{a, b} {
		snap, seqs, done := c.syncDoc(space, doc, 0)
		if snap != nil || seqs != nil || done.LatestSeq != 0 || done.DocId != doc {
			t.Fatalf("empty sync: %v %v %v", snap, seqs, done)
		}
	}

	// Concurrent pipelined pushes from both connections.
	const perConn = 60
	var wg sync.WaitGroup
	for _, c := range []*client{a, b} {
		wg.Add(1)
		go func(c *client) {
			defer wg.Done()
			for i := 1; i <= perConn; i++ {
				c.push(uint32(i), space, doc, 0, []byte(fmt.Sprintf("%s#%d", c.name, i)))
			}
		}(c)
	}
	wg.Wait()

	// Each connection must see every seq 1..120 exactly once, ascending: its own as Acks
	// (with refs in send order) and the other's as live Updates.
	for _, c := range []*client{a, b} {
		var seen []uint64
		var refs []uint32
		var heads []uint64
		for len(seen) < 2*perConn {
			f := c.recv()
			switch m := f.Msg.(type) {
			case *pb.ServerFrame_Ack:
				seen = append(seen, m.Ack.Seq)
				refs = append(refs, m.Ack.Ref)
			case *pb.ServerFrame_Updates:
				for _, u := range m.Updates.Updates {
					if strings.HasPrefix(string(u.Payload), c.name+"#") {
						t.Fatalf("%s: echoed own update %q", c.name, u.Payload)
					}
					if !bytes.Equal(u.Author, admin.pk) || !sigs.Verify(u.Author, sigs.Update(space, doc, u.Epoch, u.Payload), u.Sig) {
						t.Fatalf("%s: bad relayed update", c.name)
					}
					seen = append(seen, u.Seq)
				}
			case *pb.ServerFrame_DocHeads:
				if c != a || m.DocHeads.Full {
					t.Fatalf("%s: unexpected heads %v", c.name, m.DocHeads)
				}
				heads = append(heads, m.DocHeads.Heads[0].LatestSeq)
			default:
				t.Fatalf("%s: unexpected %v", c.name, f)
			}
		}
		if !reflect.DeepEqual(seen, seqRange(1, 2*perConn)) {
			t.Fatalf("%s: seqs not strictly ascending/gapless: %v", c.name, seen)
		}
		for i, r := range refs {
			if r != uint32(i+1) {
				t.Fatalf("%s: ack refs out of order: %v", c.name, refs)
			}
		}
		if c == a {
			// Remaining DocHeads for a (space subscriber) — all 120, ascending.
			for len(heads) < 2*perConn {
				h := a.recv().GetDocHeads()
				if h == nil {
					t.Fatal("expected DocHeads")
				}
				heads = append(heads, h.Heads[0].LatestSeq)
			}
			if !reflect.DeepEqual(heads, seqRange(1, 2*perConn)) {
				t.Fatalf("doc heads: %v", heads)
			}
		}
		c.quiet(100 * time.Millisecond)
	}

	// Full heads now list the doc.
	b.send(&pb.ClientFrame{Msg: &pb.ClientFrame_SubscribeSpace{SubscribeSpace: &pb.SubscribeSpace{SpaceId: space}}})
	if h := b.recv().GetDocHeads(); h == nil || !h.Full || len(h.Heads) != 1 || h.Heads[0].DocId != doc || h.Heads[0].LatestSeq != 120 {
		t.Fatalf("full heads: %v", h)
	}

	// Resubscribe from since_seq on a new connection.
	c := e.dial(admin, "dev-c")
	snap, seqs, done := c.syncDoc(space, doc, 100)
	if snap != nil || !reflect.DeepEqual(seqs, seqRange(101, 120)) || done.LatestSeq != 120 || done.UpdatesSinceSnapshot != 120 {
		t.Fatalf("resubscribe: %v %v %v", snap, seqs, done)
	}
	// Large backlog is batched (≤256 per frame): push 300 more from c, then sync fresh on d.
	for i := 1; i <= 300; i++ {
		c.push(uint32(1000+i), space, doc, 0, []byte("c"))
	}
	for i := 0; i < 300; i++ {
		if ack := c.recv().GetAck(); ack == nil || ack.Seq != uint64(120+i+1) {
			t.Fatalf("ack %d: %v", i, ack)
		}
	}
	drain := func(cl *client, n int) {
		counts := map[string]int{}
		for i := 0; i < n; i++ {
			select {
			case f := <-cl.in:
				counts[fmt.Sprintf("%T", f.Msg)]++
			case <-time.After(3 * time.Second):
				t.Fatalf("%s: drained %d/%d: %v", cl.name, i, n, counts)
			}
		}
	}
	drain(a, 600) // 300 updates + 300 heads
	drain(b, 600)
	d := e.dial(admin, "dev-d")
	d.subscribe(space, doc, 0)
	var batches []int
	var all []uint64
	for {
		f := d.recv()
		if u := f.GetUpdates(); u != nil {
			batches = append(batches, len(u.Updates))
			for _, x := range u.Updates {
				all = append(all, x.Seq)
			}
			continue
		}
		if f.GetSyncDone() == nil {
			t.Fatalf("unexpected %v", f)
		}
		break
	}
	if !reflect.DeepEqual(batches, []int{256, 164}) || !reflect.DeepEqual(all, seqRange(1, 420)) {
		t.Fatalf("batches %v, seqs ok=%v", batches, reflect.DeepEqual(all, seqRange(1, 420)))
	}

	// Snapshot at 400 → prune → subscribe from 0 gets snapshot then tail.
	a.snapshot(55, space, doc, 400, 0, []byte("snapshot@400"))
	if ack := a.recv().GetSnapshotAck(); ack == nil || ack.Ref != 55 || ack.BaseSeq != 400 {
		t.Fatalf("snapshot ack: %v", ack)
	}
	if h := a.recv().GetDocHeads(); h == nil || h.Heads[0].SnapshotSeq != 400 || h.Heads[0].LatestSeq != 420 {
		t.Fatalf("heads after snapshot: %v", h)
	}
	if h := b.recv().GetDocHeads(); h == nil || h.Heads[0].SnapshotSeq != 400 {
		t.Fatalf("b heads after snapshot: %v", h)
	}
	snap, seqs, done = e.dial(admin, "dev-e").syncDoc(space, doc, 0)
	if snap == nil || snap.BaseSeq != 400 || string(snap.Payload) != "snapshot@400" || !bytes.Equal(snap.Author, admin.pk) ||
		!sigs.Verify(snap.Author, sigs.Snapshot(space, doc, snap.BaseSeq, snap.Epoch, snap.Payload), snap.Sig) {
		t.Fatalf("snapshot: %v", snap)
	}
	if !reflect.DeepEqual(seqs, seqRange(401, 420)) || done.LatestSeq != 420 || done.UpdatesSinceSnapshot != 20 || done.BytesSinceSnapshot != 20 {
		t.Fatalf("tail after snapshot: %v %v", seqs, done)
	}
	// since_seq beyond the snapshot: no snapshot, just the tail.
	snap, seqs, _ = e.dial(admin, "dev-f").syncDoc(space, doc, 410)
	if snap != nil || !reflect.DeepEqual(seqs, seqRange(411, 420)) {
		t.Fatalf("since > base: %v %v", snap, seqs)
	}
	// Invalid snapshots.
	for i, base := range []uint64{400, 399, 421, 0} {
		a.snapshot(uint32(60+i), space, doc, base, 0, []byte("x"))
		a.expectError(uint32(60+i), pb.ErrorCode_ERROR_CODE_CONFLICT)
	}
	// Retention (the hub clock stands still): only the newest snapshot of the hour survives.
	// TestWSHistory covers the policy across hours and days.
	for i, base := range []uint64{405, 410, 415} {
		a.snapshot(uint32(70+i), space, doc, base, 0, []byte("s"))
		if a.recv().GetSnapshotAck() == nil {
			t.Fatal("expected SnapshotAck")
		}
		a.recv() // DocHeads
	}
	got, _ := e.st.SnapshotSeqs(context.Background(), space, doc)
	if !reflect.DeepEqual(got, []uint64{415}) {
		t.Fatalf("retained %v", got)
	}

	// Unsubscribe stops live delivery to b.
	drain(b, 3) // DocHeads for the 3 retention snapshots
	b.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Unsubscribe{Unsubscribe: &pb.Unsubscribe{SpaceId: space, DocId: doc}}})
	b.send(&pb.ClientFrame{Msg: &pb.ClientFrame_UnsubscribeSpace{UnsubscribeSpace: &pb.UnsubscribeSpace{SpaceId: space}}})
	b.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Ping{Ping: &pb.Ping{T: 1}}})
	if b.recv().GetPong() == nil {
		t.Fatal("expected pong")
	}
	a.push(999, space, doc, 0, []byte("after"))
	if ack := a.recv().GetAck(); ack == nil || ack.Seq != 421 {
		t.Fatalf("ack: %v", ack)
	}
	b.quiet(150 * time.Millisecond)
}

func TestWSErrors(t *testing.T) {
	e := newEnv(t, nil)
	admin := newIdent()
	e.claim(admin)
	a := e.dial(admin, "a")
	space := randSpaceID()
	a.createSpace(1, space)

	// EPOCH_STALE.
	a.push(11, space, "index", 1, []byte("x"))
	if err := a.expectError(11, pb.ErrorCode_ERROR_CODE_EPOCH_STALE); err.SpaceId != space || err.DocId != "index" {
		t.Fatalf("error ids: %v", err)
	}
	e.st.SetEpoch(context.Background(), space, 2)
	a.push(12, space, "index", 0, []byte("x"))
	a.expectError(12, pb.ErrorCode_ERROR_CODE_EPOCH_STALE)
	a.push(13, space, "index", 2, []byte("x"))
	if ack := a.recv().GetAck(); ack == nil || ack.Ref != 13 || ack.Seq != 1 {
		t.Fatalf("ack at new epoch: %v", ack)
	}

	// UNAUTHORIZED: bad update signature (session stays open).
	a.send(&pb.ClientFrame{Msg: &pb.ClientFrame_PushUpdate{PushUpdate: &pb.PushUpdate{
		Ref: 14, SpaceId: space, DocId: "index", Epoch: 2, Payload: []byte("x"), Sig: make([]byte, 64)}}})
	a.expectError(14, pb.ErrorCode_ERROR_CODE_UNAUTHORIZED)
	a.snapshot(15, space, "index", 1, 2, []byte("s"))
	a.recv() // SnapshotAck
	a.send(&pb.ClientFrame{Msg: &pb.ClientFrame_PutSnapshot{PutSnapshot: &pb.PutSnapshot{
		Ref: 16, SpaceId: space, DocId: "index", BaseSeq: 1, Epoch: 2, Payload: []byte("x"), Sig: make([]byte, 64)}}})
	a.expectError(16, pb.ErrorCode_ERROR_CODE_UNAUTHORIZED)

	// TOO_LARGE.
	a.push(17, space, "index", 2, make([]byte, ws.MaxUpdate+1))
	a.expectError(17, pb.ErrorCode_ERROR_CODE_TOO_LARGE)
	a.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Awareness{Awareness: &pb.AwarenessIn{SpaceId: space, DocId: "index", Payload: make([]byte, ws.MaxAwareness+1)}}})
	a.expectError(0, pb.ErrorCode_ERROR_CODE_TOO_LARGE)

	// FORBIDDEN: a member who isn't in the space.
	member := e.join(admin, "member")
	m := e.dial(member, "m")
	m.subscribe(space, "index", 0)
	m.expectError(0, pb.ErrorCode_ERROR_CODE_FORBIDDEN)
	m.send(&pb.ClientFrame{Msg: &pb.ClientFrame_SubscribeSpace{SubscribeSpace: &pb.SubscribeSpace{SpaceId: space}}})
	m.expectError(0, pb.ErrorCode_ERROR_CODE_FORBIDDEN)
	m.push(21, space, "index", 2, []byte("x"))
	m.expectError(21, pb.ErrorCode_ERROR_CODE_FORBIDDEN)
	m.send(&pb.ClientFrame{Msg: &pb.ClientFrame_ListSpaces{ListSpaces: &pb.ListSpaces{Rid: 22}}})
	if l := m.recv().GetSpaceList(); l == nil || len(l.Spaces) != 0 {
		t.Fatalf("member sees spaces: %v", l)
	}
	// FORBIDDEN: viewer can subscribe and send presence but not write.
	if err := e.st.AddMember(context.Background(), space, member.pk, store.SpaceViewer, []byte("w")); err != nil {
		t.Fatal(err)
	}
	m.push(23, space, "index", 2, []byte("x"))
	m.expectError(23, pb.ErrorCode_ERROR_CODE_FORBIDDEN)
	m.snapshot(24, space, "index", 1, 2, []byte("x"))
	m.expectError(24, pb.ErrorCode_ERROR_CODE_FORBIDDEN)
	snap, seqs, done := m.syncDoc(space, "index", 0)
	if snap == nil || snap.BaseSeq != 1 || seqs != nil || done.LatestSeq != 1 {
		t.Fatalf("viewer sync: %v %v %v", snap, seqs, done)
	}
	// Awareness from viewer reaches a (subscribed) but not the sender.
	a.syncDoc(space, "index", 1)
	m.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Awareness{Awareness: &pb.AwarenessIn{SpaceId: space, DocId: "index", Epoch: 2, Payload: []byte("cursor")}}})
	aw := a.recv().GetAwareness()
	if aw == nil || !bytes.Equal(aw.From, member.pk) || aw.DeviceId != "m" || string(aw.Payload) != "cursor" || aw.Epoch != 2 {
		t.Fatalf("awareness: %v", aw)
	}
	m.quiet(100 * time.Millisecond)

	// FORBIDDEN: guests can't create spaces.
	g := e.dial(e.join(admin, "guest"), "g")
	g.send(&pb.ClientFrame{Msg: &pb.ClientFrame_CreateSpace{CreateSpace: &pb.CreateSpace{
		Rid: 31, SpaceId: randSpaceID(), Kind: pb.SpaceKind_SPACE_KIND_ROOT, WrappedKey: []byte("w")}}})
	g.expectError(31, pb.ErrorCode_ERROR_CODE_FORBIDDEN)
}

func TestWSAuthFailures(t *testing.T) {
	e := newEnv(t, nil)
	admin := newIdent()
	e.claim(admin)

	hello := func(id *ident, v uint32) *pb.ClientFrame {
		return &pb.ClientFrame{Msg: &pb.ClientFrame_Hello{Hello: &pb.Hello{SignPk: id.pk, DeviceId: "d", ProtocolVersion: v}}}
	}
	start := func() (*client, *pb.Challenge) {
		c := e.rawDial("raw")
		c.startReader()
		return c, c.recv().GetChallenge()
	}

	// Unknown user.
	stranger := newIdent()
	c, ch := start()
	c.send(hello(stranger, 1))
	c.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Auth{Auth: &pb.Auth{Sig: stranger.sign(sigs.Auth(e.serverID, ch.Nonce, stranger.pk, "d"))}}})
	c.expectError(0, pb.ErrorCode_ERROR_CODE_UNAUTHORIZED)
	if code := c.expectClosed(); code != websocket.StatusPolicyViolation {
		t.Fatalf("close code %v", code)
	}

	// Registered user, signature over the wrong nonce.
	c, _ = start()
	c.send(hello(admin, 1))
	c.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Auth{Auth: &pb.Auth{Sig: admin.sign(sigs.Auth(e.serverID, make([]byte, 32), admin.pk, "d"))}}})
	c.expectError(0, pb.ErrorCode_ERROR_CODE_UNAUTHORIZED)
	c.expectClosed()

	// Frame before auth.
	c, _ = start()
	c.send(&pb.ClientFrame{Msg: &pb.ClientFrame_ListSpaces{ListSpaces: &pb.ListSpaces{Rid: 1}}})
	c.expectError(0, pb.ErrorCode_ERROR_CODE_UNAUTHORIZED)
	c.expectClosed()

	// Frame between Hello and Auth.
	c, _ = start()
	c.send(hello(admin, 1))
	c.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Ping{Ping: &pb.Ping{}}})
	c.expectError(0, pb.ErrorCode_ERROR_CODE_UNAUTHORIZED)
	c.expectClosed()

	// Protocol mismatch.
	c, _ = start()
	c.send(hello(admin, 2))
	c.expectError(0, pb.ErrorCode_ERROR_CODE_UPDATE_REQUIRED)
	c.expectClosed()
}

func TestWSIdleTimeout(t *testing.T) {
	e := newEnv(t, func(c *ws.Config) { c.IdleTimeout = 300 * time.Millisecond })
	admin := newIdent()
	e.claim(admin)
	a := e.dial(admin, "a")
	for i := 0; i < 3; i++ { // pings keep it alive
		time.Sleep(150 * time.Millisecond)
		a.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Ping{Ping: &pb.Ping{T: uint64(i)}}})
		if a.recv().GetPong() == nil {
			t.Fatal("expected pong")
		}
	}
	a.expectClosed()
}

// TestWSSlowConsumer: a subscriber that stops reading is disconnected (never silently skipped),
// and other subscribers keep receiving every update.
func TestWSSlowConsumer(t *testing.T) {
	e := newEnv(t, func(c *ws.Config) { c.QueueSize = 8 })
	admin := newIdent()
	e.claim(admin)
	space := randSpaceID()
	a := e.dial(admin, "a")
	a.createSpace(1, space)
	good := e.dial(admin, "good")
	good.syncDoc(space, "doc", 0)

	// The slow client authenticates and subscribes, then never reads again.
	slow := e.rawDial("slow")
	ctx := context.Background()
	_, data, _ := slow.c.Read(ctx)
	ch := mustChallenge(t, data)
	slow.id = admin
	slow.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Hello{Hello: &pb.Hello{SignPk: admin.pk, DeviceId: "slow", ProtocolVersion: 1}}})
	slow.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Auth{Auth: &pb.Auth{Sig: admin.sign(sigs.Auth(e.serverID, ch.Nonce, admin.pk, "slow"))}}})
	slow.subscribe(space, "doc", 0)
	time.Sleep(100 * time.Millisecond)

	payload := make([]byte, 256<<10)
	const n = 200 // ~50 MiB: far beyond socket buffers + queue
	go func() {
		for i := 1; i <= n; i++ {
			a.push(uint32(i), space, "doc", 0, payload)
		}
	}()
	got := 0
	for got < n {
		if u := good.recv().GetUpdates(); u != nil {
			for _, x := range u.Updates {
				got++
				if x.Seq != uint64(got) {
					t.Fatalf("good: seq %d want %d", x.Seq, got)
				}
			}
		}
	}
	// Now drain the slow connection: it must end in a 4008 close, with gapless seqs before it.
	slow.startReader()
	var last uint64
	for {
		f, ok := <-slow.in
		if !ok {
			break
		}
		if u := f.GetUpdates(); u != nil {
			for _, x := range u.Updates {
				if x.Seq != last+1 {
					t.Fatalf("slow: gap %d → %d", last, x.Seq)
				}
				last = x.Seq
			}
		}
	}
	// The close frame usually can't get through a full TCP buffer, so the client may see an
	// abnormal closure (-1) rather than 4008; either way the connection must be gone.
	if code := websocket.CloseStatus(<-slow.closed); code != ws.StatusSlowConsumer && code != -1 {
		t.Fatalf("slow close code %v (got %d updates)", code, last)
	}
	if last >= n {
		t.Fatalf("slow consumer received everything (%d); queue overflow not exercised", last)
	}
}

func mustChallenge(t *testing.T, data []byte) *pb.Challenge {
	t.Helper()
	f := &pb.ServerFrame{}
	if err := protoUnmarshal(data, f); err != nil || f.GetChallenge() == nil {
		t.Fatalf("challenge: %v %v", f, err)
	}
	return f.GetChallenge()
}

// TestWSHistory covers snapshot timestamps, retention with a fake clock, ListVersions and
// GetVersion.
func TestWSHistory(t *testing.T) {
	e := newEnv(t, nil)
	admin := newIdent()
	e.claim(admin)
	a := e.dial(admin, "a")
	space, doc := randSpaceID(), "doc1"
	a.createSpace(1, space)
	for i := uint32(1); i <= 10; i++ {
		a.push(i, space, doc, 0, []byte{byte(i)})
		if ack := a.recv().GetAck(); ack == nil || ack.Seq != uint64(i) {
			t.Fatalf("ack %d: %v", i, ack)
		}
	}
	if _, _, done := e.dial(admin, "b").syncDoc(space, doc, 0); done.SnapshotCreatedAt != 0 {
		t.Fatalf("snapshot_created_at without a snapshot: %v", done)
	}

	t0 := time.Date(2026, 11, 1, 1, 0, 0, 0, time.UTC)
	snap := func(ref uint32, base uint64, at time.Time) {
		t.Helper()
		e.clock.Set(at)
		a.snapshot(ref, space, doc, base, 0, []byte(fmt.Sprintf("snapshot@%d", base)))
		ack := a.recv().GetSnapshotAck()
		if ack == nil || ack.Ref != ref || ack.BaseSeq != base || ack.CreatedAt != at.UnixMilli() {
			t.Fatalf("snapshot ack: %v", ack)
		}
	}
	snap(20, 2, t0)
	snap(21, 4, t0.Add(30*time.Minute)) // same hour as 2: replaces it
	snap(22, 6, t0.Add(time.Hour))
	snap(23, 8, t0.Add(25*time.Hour)) // 4 is now outside the 24 h window and not the newest of its day
	got, _ := e.st.SnapshotSeqs(context.Background(), space, doc)
	if !reflect.DeepEqual(got, []uint64{6, 8}) {
		t.Fatalf("retained %v", got)
	}
	if _, _, done := e.dial(admin, "c").syncDoc(space, doc, 0); done.SnapshotCreatedAt != t0.Add(25*time.Hour).UnixMilli() {
		t.Fatalf("snapshot_created_at: %v", done)
	}

	// ListVersions: newest first. Viewers may read history.
	viewer := e.join(admin, "guest")
	e.st.AddMember(context.Background(), space, viewer.pk, store.SpaceViewer, []byte("w"))
	v := e.dial(viewer, "v")
	v.send(&pb.ClientFrame{Msg: &pb.ClientFrame_ListVersions{ListVersions: &pb.ListVersions{Rid: 30, SpaceId: space, DocId: doc}}})
	list := v.recv().GetVersionList()
	if list == nil || list.Rid != 30 || list.SpaceId != space || list.DocId != doc || len(list.Versions) != 2 {
		t.Fatalf("version list: %v", list)
	}
	for i, want := range []struct {
		base uint64
		at   time.Time
	}{{8, t0.Add(25 * time.Hour)}, {6, t0.Add(time.Hour)}} {
		vi := list.Versions[i]
		if vi.BaseSeq != want.base || vi.CreatedAt != want.at.UnixMilli() || !bytes.Equal(vi.Author, admin.pk) ||
			vi.Size != uint64(len(fmt.Sprintf("snapshot@%d", want.base))) || vi.Epoch != 0 {
			t.Fatalf("version %d: %v", i, vi)
		}
	}
	v.send(&pb.ClientFrame{Msg: &pb.ClientFrame_ListVersions{ListVersions: &pb.ListVersions{Rid: 31, SpaceId: space, DocId: "never-written"}}})
	if l := v.recv().GetVersionList(); l == nil || l.Rid != 31 || len(l.Versions) != 0 {
		t.Fatalf("empty version list: %v", l)
	}

	// GetVersion returns the uploader's signed snapshot.
	v.send(&pb.ClientFrame{Msg: &pb.ClientFrame_GetVersion{GetVersion: &pb.GetVersion{Rid: 32, SpaceId: space, DocId: doc, BaseSeq: 6}}})
	vd := v.recv().GetVersionData()
	if vd == nil || vd.Rid != 32 || vd.Info.BaseSeq != 6 || vd.Info.CreatedAt != t0.Add(time.Hour).UnixMilli() ||
		string(vd.Payload) != "snapshot@6" || vd.Info.Size != uint64(len(vd.Payload)) ||
		!sigs.Verify(vd.Info.Author, sigs.Snapshot(space, doc, vd.Info.BaseSeq, vd.Info.Epoch, vd.Payload), vd.Sig) {
		t.Fatalf("version data: %v", vd)
	}
	for i, base := range []uint64{2, 4, 7, 0} { // pruned or never existed
		rid := uint32(40 + i)
		v.send(&pb.ClientFrame{Msg: &pb.ClientFrame_GetVersion{GetVersion: &pb.GetVersion{Rid: rid, SpaceId: space, DocId: doc, BaseSeq: base}}})
		if err := v.expectError(rid, pb.ErrorCode_ERROR_CODE_NOT_FOUND); err.SpaceId != space || err.DocId != doc {
			t.Fatalf("error ids: %v", err)
		}
	}

	// Membership and ids.
	o := e.dial(e.join(admin, "member"), "o")
	o.send(&pb.ClientFrame{Msg: &pb.ClientFrame_ListVersions{ListVersions: &pb.ListVersions{Rid: 50, SpaceId: space, DocId: doc}}})
	o.expectError(50, pb.ErrorCode_ERROR_CODE_FORBIDDEN)
	o.send(&pb.ClientFrame{Msg: &pb.ClientFrame_GetVersion{GetVersion: &pb.GetVersion{Rid: 51, SpaceId: space, DocId: doc, BaseSeq: 8}}})
	o.expectError(51, pb.ErrorCode_ERROR_CODE_FORBIDDEN)
	v.send(&pb.ClientFrame{Msg: &pb.ClientFrame_ListVersions{ListVersions: &pb.ListVersions{Rid: 52, SpaceId: space, DocId: "a/b"}}})
	v.expectError(52, pb.ErrorCode_ERROR_CODE_BAD_REQUEST)
}
