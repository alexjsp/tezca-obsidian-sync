package e2e

import (
	"fmt"
	"testing"
	"time"

	"tezca/server/internal/pb"
)

// ───────────── share helpers ─────────────

// do is call with the skew that matches the API clock's offset.
func (e *env) do(method, path string, body any, signer *ident) (int, map[string]any) {
	e.t.Helper()
	return e.call(method, path, body, signer, e.apiClock.Offset())
}

func (cl *client) createShare(rid uint32, space string) {
	cl.t.Helper()
	cl.send(&pb.ClientFrame{Msg: &pb.ClientFrame_CreateSpace{CreateSpace: &pb.CreateSpace{
		Rid: rid, SpaceId: space, Kind: pb.SpaceKind_SPACE_KIND_SHARE, WrappedKey: []byte("owner-key-0"), Meta: []byte("share-meta"),
	}}})
	if f := cl.recv().GetSpaceCreated(); f == nil || f.Rid != rid || f.Space.Kind != pb.SpaceKind_SPACE_KIND_SHARE {
		cl.t.Fatalf("expected SpaceCreated, got %v", f)
	}
}

func linkKeys(epochs ...uint32) []map[string]any {
	out := make([]map[string]any, len(epochs))
	for i, ep := range epochs {
		out[i] = map[string]any{"epoch": ep, "wrapped": b64.EncodeToString([]byte(fmt.Sprintf("link-key-%d", ep)))}
	}
	return out
}

func (e *env) shareInvite(owner *ident, space, role string, epochs ...uint32) string {
	e.t.Helper()
	code, out := e.do("POST", "/api/spaces/"+space+"/invites", map[string]any{"role": role, "keys": linkKeys(epochs...)}, owner)
	if code != 200 {
		e.t.Fatalf("share invite: %d %v", code, out)
	}
	return out["token"].(string)
}

func (e *env) redeemShare(id *ident, token string) (int, map[string]any) {
	e.t.Helper()
	return e.do("POST", "/api/share-invites/redeem", map[string]string{"token": token}, id)
}

// addMember invites id to space with role and redeems it.
func (e *env) addMember(owner *ident, space string, id *ident, role string) {
	e.t.Helper()
	if code, out := e.redeemShare(id, e.shareInvite(owner, space, role, 0)); code != 200 {
		e.t.Fatalf("redeem: %d %v", code, out)
	}
}

func memberPath(space string, id *ident) string {
	return "/api/spaces/" + space + "/members/" + b64.EncodeToString(id.pk)
}

func (cl *client) expectSpaceChanged(space string) {
	cl.t.Helper()
	f := cl.recv()
	if sc := f.GetSpaceChanged(); sc == nil || sc.SpaceId != space {
		cl.t.Fatalf("%s: expected SpaceChanged{%s}, got %v", cl.name, space, f)
	}
}

func (cl *client) listSpaces(rid uint32) []*pb.SpaceInfo {
	cl.t.Helper()
	cl.send(&pb.ClientFrame{Msg: &pb.ClientFrame_ListSpaces{ListSpaces: &pb.ListSpaces{Rid: rid}}})
	l := cl.recv().GetSpaceList()
	if l == nil || l.Rid != rid {
		cl.t.Fatalf("%s: expected SpaceList, got %v", cl.name, l)
	}
	return l.Spaces
}

func expectStatus(t *testing.T, what string, want, got int, out map[string]any) {
	t.Helper()
	if got != want {
		t.Fatalf("%s: status %d (want %d) %v", what, got, want, out)
	}
}

// ───────────── tests ─────────────

func TestShareInvites(t *testing.T) {
	e := newEnv(t, nil)
	owner := newIdent()
	e.claim(owner)
	bob := e.join(owner, "member")
	carol := e.join(owner, "member")
	stranger := newIdent() // not a host user

	oc := e.dial(owner, "owner")
	bc := e.dial(bob, "bob")
	space := randSpaceID()
	oc.createShare(1, space)
	base := "/api/spaces/" + space + "/invites"

	// Create: validation.
	for _, tc := range []struct {
		name string
		body map[string]any
		want int
	}{
		{"owner role", map[string]any{"role": "owner", "keys": linkKeys(0)}, 400},
		{"unknown role", map[string]any{"role": "admin", "keys": linkKeys(0)}, 400},
		{"no keys", map[string]any{"role": "editor"}, 400},
		{"future epoch", map[string]any{"role": "editor", "keys": linkKeys(0, 1)}, 409},
		{"missing epoch", map[string]any{"role": "editor", "keys": linkKeys(1)}, 409},
		{"duplicate epoch", map[string]any{"role": "editor", "keys": linkKeys(0, 0)}, 400},
		{"key without epoch", map[string]any{"role": "editor", "keys": []map[string]any{{"wrapped": "AAAA"}}}, 400},
		{"huge key", map[string]any{"role": "editor", "keys": []map[string]any{{"epoch": 0, "wrapped": b64.EncodeToString(make([]byte, 257))}}}, 400},
	} {
		code, out := e.do("POST", base, tc.body, owner)
		expectStatus(t, tc.name, tc.want, code, out)
	}
	if code, out := e.do("POST", "/api/spaces/short/invites", map[string]any{"role": "editor", "keys": linkKeys(0)}, owner); code != 400 {
		t.Fatalf("bad space id: %d %v", code, out)
	}
	if code, out := e.do("POST", base, map[string]any{"role": "editor", "keys": linkKeys(0)}, nil); code != 401 {
		t.Fatalf("unsigned: %d %v", code, out)
	}
	if code, out := e.do("POST", base, map[string]any{"role": "editor", "keys": linkKeys(0)}, bob); code != 403 {
		t.Fatalf("non-member: %d %v", code, out)
	}

	// TTL: default 7 days, clamped to 30.
	now := time.Now().Unix()
	code, out := e.do("POST", base, map[string]any{"role": "editor", "keys": linkKeys(0)}, owner)
	expectStatus(t, "create", 200, code, out)
	tok := out["token"].(string)
	if exp := int64(out["expires_at"].(float64)); exp < now+7*86400-5 || exp > now+7*86400+5 {
		t.Fatalf("default ttl: %d", exp-now)
	}
	_, out = e.do("POST", base, map[string]any{"role": "viewer", "keys": linkKeys(0), "ttl_seconds": 100 * 86400}, owner)
	if exp := int64(out["expires_at"].(float64)); exp > now+30*86400+5 {
		t.Fatalf("ttl not clamped: %d", exp-now)
	}
	clampedTok := out["token"].(string)

	// List.
	code, out = e.do("GET", base, nil, owner)
	expectStatus(t, "list", 200, code, out)
	if invs := out["invites"].([]any); len(invs) != 2 {
		t.Fatalf("list: %v", out)
	}
	if code, out := e.do("GET", base, nil, bob); code != 403 {
		t.Fatalf("list by non-member: %d %v", code, out)
	}

	// Redeem: auth and unknown token.
	if code, out := e.redeemShare(stranger, tok); code != 401 {
		t.Fatalf("non-user redeem: %d %v", code, out)
	}
	if code, out := e.redeemShare(bob, "nope"); code != 404 {
		t.Fatalf("unknown token: %d %v", code, out)
	}
	if code, out := e.do("POST", "/api/share-invites/redeem", map[string]string{}, bob); code != 400 {
		t.Fatalf("no token: %d %v", code, out)
	}

	// Redeem.
	code, out = e.redeemShare(bob, tok)
	expectStatus(t, "redeem", 200, code, out)
	keys := out["keys"].([]any)
	if out["space_id"] != space || out["role"] != "editor" || out["kind"] != "share" || out["epoch"] != 0.0 ||
		out["meta"] != b64.EncodeToString([]byte("share-meta")) || out["meta_epoch"] != 0.0 || len(keys) != 1 ||
		keys[0].(map[string]any)["wrapped"] != b64.EncodeToString([]byte("link-key-0")) {
		t.Fatalf("redeem response: %v", out)
	}
	oc.expectSpaceChanged(space)
	bc.expectSpaceChanged(space)
	if sp := bc.listSpaces(2); len(sp) != 1 || sp[0].SpaceId != space || sp[0].Role != pb.SpaceRole_SPACE_ROLE_EDITOR || len(sp[0].Members) != 2 {
		t.Fatalf("bob's spaces: %v", sp)
	}

	// Re-redeem with the same key: same answer, no SpaceChanged.
	code, again := e.redeemShare(bob, tok)
	expectStatus(t, "re-redeem", 200, code, again)
	if fmt.Sprint(again) != fmt.Sprint(out) {
		t.Fatalf("re-redeem differs:\n%v\n%v", again, out)
	}
	oc.quiet(100 * time.Millisecond)
	bc.quiet(100 * time.Millisecond)
	// Another key.
	if code, out := e.redeemShare(carol, tok); code != 409 {
		t.Fatalf("other key: %d %v", code, out)
	}

	// The list shows the redemption.
	_, out = e.do("GET", base, nil, owner)
	found := false
	for _, it := range out["invites"].([]any) {
		m := it.(map[string]any)
		if m["token"] == tok {
			found = true
			if m["redeemed_by"] != b64.EncodeToString(bob.pk) || m["redeemed_at"] == nil || m["role"] != "editor" || m["created_at"] == nil {
				t.Fatalf("redeemed item: %v", m)
			}
		} else if _, ok := m["redeemed_by"]; ok {
			t.Fatalf("unredeemed item has redeemed_by: %v", m)
		}
	}
	if !found {
		t.Fatalf("token missing from list: %v", out)
	}

	// Revoke.
	if code, out := e.do("DELETE", base+"/"+tok, nil, owner); code != 409 {
		t.Fatalf("revoke redeemed: %d %v", code, out)
	}
	if code, out := e.do("DELETE", base+"/nope", nil, owner); code != 404 {
		t.Fatalf("revoke unknown: %d %v", code, out)
	}
	if code, out := e.do("DELETE", base+"/"+clampedTok, nil, bob); code != 403 {
		t.Fatalf("revoke by editor: %d %v", code, out)
	}
	if code, out := e.do("DELETE", base+"/"+clampedTok, nil, owner); code != 200 {
		t.Fatalf("revoke: %d %v", code, out)
	}
	if code, out := e.redeemShare(carol, clampedTok); code != 410 {
		t.Fatalf("redeem revoked: %d %v", code, out)
	}
	_, out = e.do("GET", base, nil, owner)
	if invs := out["invites"].([]any); len(invs) != 1 {
		t.Fatalf("revoked invite still listed: %v", out)
	}

	// Expired.
	code, out = e.do("POST", base, map[string]any{"role": "viewer", "keys": linkKeys(0), "ttl_seconds": 60}, owner)
	expectStatus(t, "create short", 200, code, out)
	short := out["token"].(string)
	e.apiClock.Advance(2 * time.Minute)
	if code, out := e.redeemShare(carol, short); code != 410 {
		t.Fatalf("redeem expired: %d %v", code, out)
	}
	// Bob (already redeemed) can still re-redeem his own invite after expiry.
	if code, out := e.redeemShare(bob, tok); code != 200 {
		t.Fatalf("re-redeem after expiry: %d %v", code, out)
	}
}

func TestShareInviteRoles(t *testing.T) {
	e := newEnv(t, nil)
	owner := newIdent()
	e.claim(owner)
	ed := e.join(owner, "member")
	vw := e.join(owner, "member")
	guest := e.join(owner, "guest")
	oc := e.dial(owner, "owner")
	space := randSpaceID()
	oc.createShare(1, space)
	e.addMember(owner, space, ed, "editor")
	e.addMember(owner, space, vw, "viewer")
	e.addMember(owner, space, guest, "viewer") // any host user may redeem
	for range 3 {
		oc.expectSpaceChanged(space)
	}

	// An existing editor keeps editor when redeeming a viewer invite (and nothing changes).
	code, out := e.redeemShare(ed, e.shareInvite(owner, space, "viewer", 0))
	if code != 200 || out["role"] != "editor" {
		t.Fatalf("editor redeeming viewer invite: %d %v", code, out)
	}
	oc.quiet(100 * time.Millisecond)
	// A viewer redeeming an editor invite is promoted.
	code, out = e.redeemShare(vw, e.shareInvite(owner, space, "editor", 0))
	if code != 200 || out["role"] != "editor" {
		t.Fatalf("viewer redeeming editor invite: %d %v", code, out)
	}
	oc.expectSpaceChanged(space)
	// The owner redeeming their own invite stays owner.
	if code, out := e.redeemShare(owner, e.shareInvite(owner, space, "viewer", 0)); code != 200 || out["role"] != "owner" {
		t.Fatalf("owner redeeming: %d %v", code, out)
	}

	// A redeemer who has since been removed can't use the link to come back.
	tok := e.shareInvite(owner, space, "viewer", 0)
	other := e.join(owner, "member")
	if code, _ := e.redeemShare(other, tok); code != 200 {
		t.Fatal("redeem")
	}
	if code, out := e.do("DELETE", memberPath(space, other), nil, owner); code != 200 {
		t.Fatalf("remove: %d %v", code, out)
	}
	if code, out := e.redeemShare(other, tok); code != 410 {
		t.Fatalf("re-redeem after removal: %d %v", code, out)
	}
}

func TestShareKeysAndRoles(t *testing.T) {
	e := newEnv(t, nil)
	owner := newIdent()
	e.claim(owner)
	bob := e.join(owner, "member")
	carol := e.join(owner, "member")
	space := randSpaceID()
	oc := e.dial(owner, "owner")
	oc.createShare(1, space)
	e.addMember(owner, space, bob, "editor")
	oc.expectSpaceChanged(space)
	bc := e.dial(bob, "bob")

	// PUT keys.
	kp := "/api/spaces/" + space + "/keys"
	bobKey := b64.EncodeToString([]byte("bob-key-0"))
	if code, out := e.do("PUT", kp, map[string]any{"keys": []map[string]any{{"epoch": 0, "wrapped": bobKey}}}, bob); code != 200 {
		t.Fatalf("put keys: %d %v", code, out)
	}
	if code, out := e.do("PUT", kp, map[string]any{"keys": []map[string]any{{"epoch": 1, "wrapped": bobKey}}}, bob); code != 400 {
		t.Fatalf("future epoch: %d %v", code, out)
	}
	if code, out := e.do("PUT", kp, map[string]any{"keys": []map[string]any{}}, bob); code != 400 {
		t.Fatalf("no keys: %d %v", code, out)
	}
	if code, out := e.do("PUT", kp, map[string]any{"keys": []map[string]any{{"epoch": 0, "wrapped": bobKey}}}, carol); code != 403 {
		t.Fatalf("non-member: %d %v", code, out)
	}
	sp := bc.listSpaces(2)
	if len(sp) != 1 || len(sp[0].Keys) != 1 || string(sp[0].Keys[0].Wrapped) != "bob-key-0" {
		t.Fatalf("bob's keys: %v", sp)
	}
	bc.quiet(100 * time.Millisecond) // PUT keys doesn't notify

	// Role changes.
	put := func(signer, target *ident, role string) (int, map[string]any) {
		return e.do("PUT", memberPath(space, target), map[string]string{"role": role}, signer)
	}
	if code, out := put(owner, bob, "admin"); code != 400 {
		t.Fatalf("bad role: %d %v", code, out)
	}
	if code, out := put(owner, carol, "viewer"); code != 404 {
		t.Fatalf("not a member: %d %v", code, out)
	}
	if code, out := e.do("PUT", "/api/spaces/"+space+"/members/xyz", map[string]string{"role": "viewer"}, owner); code != 400 {
		t.Fatalf("bad sign_pk: %d %v", code, out)
	}
	if code, out := put(bob, owner, "viewer"); code != 403 {
		t.Fatalf("editor changing roles: %d %v", code, out)
	}
	if code, out := put(owner, owner, "editor"); code != 409 {
		t.Fatalf("demote last owner: %d %v", code, out)
	}
	if code, out := put(owner, bob, "viewer"); code != 200 {
		t.Fatalf("demote bob: %d %v", code, out)
	}
	oc.expectSpaceChanged(space)
	bc.expectSpaceChanged(space)

	// A viewer can't write (role is checked per request).
	bc.push(5, space, "doc", 0, []byte("x"))
	bc.expectError(5, pb.ErrorCode_ERROR_CODE_FORBIDDEN)
	bc.snapshot(6, space, "doc", 1, 0, []byte("x"))
	bc.expectError(6, pb.ErrorCode_ERROR_CODE_FORBIDDEN)

	// Promote bob to owner; then the original owner can step down.
	if code, out := put(owner, bob, "owner"); code != 200 {
		t.Fatalf("promote: %d %v", code, out)
	}
	oc.expectSpaceChanged(space)
	bc.expectSpaceChanged(space)
	bc.push(7, space, "doc", 0, []byte("x"))
	if a := bc.recv().GetAck(); a == nil || a.Ref != 7 {
		t.Fatalf("owner push: %v", a)
	}
	if code, out := put(owner, owner, "editor"); code != 200 {
		t.Fatalf("demote self with another owner: %d %v", code, out)
	}
	oc.expectSpaceChanged(space)
	bc.expectSpaceChanged(space)
	// Now bob is the last owner.
	if code, out := put(bob, bob, "viewer"); code != 409 {
		t.Fatalf("demote last owner: %d %v", code, out)
	}
	if code, out := e.do("DELETE", memberPath(space, bob), nil, bob); code != 409 {
		t.Fatalf("last owner leaves: %d %v", code, out)
	}
	// Non-owners can't remove others; non-members get 404 / 403.
	if code, out := e.do("DELETE", memberPath(space, bob), nil, owner); code != 403 {
		t.Fatalf("editor removes owner: %d %v", code, out)
	}
	if code, out := e.do("DELETE", memberPath(space, carol), nil, bob); code != 404 {
		t.Fatalf("remove non-member: %d %v", code, out)
	}
	if code, out := e.do("DELETE", memberPath(space, carol), nil, carol); code != 403 {
		t.Fatalf("non-member leaves: %d %v", code, out)
	}
	// Leave.
	if code, out := e.do("DELETE", memberPath(space, owner), nil, owner); code != 200 {
		t.Fatalf("leave: %d %v", code, out)
	}
	oc.expectSpaceChanged(space)
	bc.expectSpaceChanged(space)
	if sp := oc.listSpaces(3); len(sp) != 0 {
		t.Fatalf("left space still listed: %v", sp)
	}
}

func TestShareRemovalEndsSubscriptions(t *testing.T) {
	e := newEnv(t, nil)
	owner := newIdent()
	e.claim(owner)
	bob := e.join(owner, "member")
	space := randSpaceID()
	oc := e.dial(owner, "owner")
	oc.createShare(1, space)
	e.addMember(owner, space, bob, "editor")
	oc.expectSpaceChanged(space)
	if code, out := e.do("PUT", "/api/spaces/"+space+"/keys",
		map[string]any{"keys": []map[string]any{{"epoch": 0, "wrapped": b64.EncodeToString([]byte("bob-key"))}}}, bob); code != 200 {
		t.Fatalf("put keys: %d %v", code, out)
	}

	b1 := e.dial(bob, "bob-1")
	b2 := e.dial(bob, "bob-2") // a second device, subscribed to nothing
	b1.send(&pb.ClientFrame{Msg: &pb.ClientFrame_SubscribeSpace{SubscribeSpace: &pb.SubscribeSpace{SpaceId: space}}})
	if h := b1.recv().GetDocHeads(); h == nil || !h.Full {
		t.Fatalf("heads: %v", h)
	}
	for _, doc := range []string{"d1", "d2"} {
		if _, _, done := b1.syncDoc(space, doc, 0); done.LatestSeq != 0 {
			t.Fatalf("sync: %v", done)
		}
	}
	oc.push(1, space, "d1", 0, []byte("u1"))
	if a := oc.recv().GetAck(); a == nil || a.Seq != 1 {
		t.Fatalf("ack: %v", a)
	}
	// Live delivery before removal: Updates then DocHeads.
	if u := b1.recv().GetUpdates(); u == nil || u.DocId != "d1" {
		t.Fatalf("updates: %v", u)
	}
	if h := b1.recv().GetDocHeads(); h == nil || h.Full {
		t.Fatalf("heads: %v", h)
	}

	// Remove bob.
	if code, out := e.do("DELETE", memberPath(space, bob), nil, owner); code != 200 {
		t.Fatalf("remove: %d %v", code, out)
	}
	oc.expectSpaceChanged(space)
	b1.expectSpaceChanged(space)
	b2.expectSpaceChanged(space)

	// No more live frames for bob.
	oc.push(2, space, "d1", 0, []byte("u2"))
	oc.recv() // Ack
	oc.push(3, space, "d2", 0, []byte("u3"))
	oc.recv() // Ack
	b1.quiet(200 * time.Millisecond)

	// Resubscribing is forbidden; so are writes and reads.
	b1.subscribe(space, "d1", 0)
	b1.expectError(0, pb.ErrorCode_ERROR_CODE_FORBIDDEN)
	b1.send(&pb.ClientFrame{Msg: &pb.ClientFrame_SubscribeSpace{SubscribeSpace: &pb.SubscribeSpace{SpaceId: space}}})
	b1.expectError(0, pb.ErrorCode_ERROR_CODE_FORBIDDEN)
	b1.push(9, space, "d1", 0, []byte("x"))
	b1.expectError(9, pb.ErrorCode_ERROR_CODE_FORBIDDEN)
	if sp := b1.listSpaces(4); len(sp) != 0 {
		t.Fatalf("removed member still lists space: %v", sp)
	}
	// Stale client-side bookkeeping is harmless: unsubscribing is a no-op.
	b1.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Unsubscribe{Unsubscribe: &pb.Unsubscribe{SpaceId: space, DocId: "d1"}}})
	b1.send(&pb.ClientFrame{Msg: &pb.ClientFrame_UnsubscribeSpace{UnsubscribeSpace: &pb.UnsubscribeSpace{SpaceId: space}}})
	b1.quiet(100 * time.Millisecond)

	// Re-invited, bob starts without his old wrapped keys and can subscribe again.
	e.addMember(owner, space, bob, "viewer")
	oc.expectSpaceChanged(space)
	b1.expectSpaceChanged(space)
	b2.expectSpaceChanged(space)
	sp := b1.listSpaces(5)
	if len(sp) != 1 || len(sp[0].Keys) != 0 {
		t.Fatalf("re-joined space: %v", sp)
	}
	if _, seqs, _ := b1.syncDoc(space, "d1", 0); len(seqs) != 2 {
		t.Fatalf("resync: %v", seqs)
	}
	oc.push(4, space, "d1", 0, []byte("u4"))
	oc.recv()
	if u := b1.recv().GetUpdates(); u == nil || u.Updates[0].Seq != 3 {
		t.Fatalf("live after rejoin: %v", u)
	}
}

func TestShareRotate(t *testing.T) {
	e := newEnv(t, nil)
	owner := newIdent()
	e.claim(owner)
	bob := e.join(owner, "member")
	carol := e.join(owner, "member")
	space := randSpaceID()
	oc := e.dial(owner, "owner")
	oc.createShare(1, space)
	e.addMember(owner, space, bob, "editor")
	oc.expectSpaceChanged(space)
	bc := e.dial(bob, "bob")
	pending := e.shareInvite(owner, space, "viewer", 0)

	rp := "/api/spaces/" + space + "/rotate"
	key := func(id *ident, s string) map[string]any {
		return map[string]any{"sign_pk": b64.EncodeToString(id.pk), "wrapped": b64.EncodeToString([]byte(s))}
	}
	both := []map[string]any{key(owner, "owner-key-1"), key(bob, "bob-key-1")}
	for _, tc := range []struct {
		name   string
		signer *ident
		body   map[string]any
		want   int
	}{
		{"skip an epoch", owner, map[string]any{"epoch": 2, "keys": both}, 409},
		{"same epoch", owner, map[string]any{"epoch": 0, "keys": both}, 409},
		{"missing member", owner, map[string]any{"epoch": 1, "keys": both[:1]}, 409},
		{"extra member", owner, map[string]any{"epoch": 1, "keys": append([]map[string]any{key(carol, "c")}, both...)}, 409},
		{"stranger instead of member", owner, map[string]any{"epoch": 1, "keys": []map[string]any{both[0], key(carol, "c")}}, 409},
		{"duplicate member", owner, map[string]any{"epoch": 1, "keys": []map[string]any{both[0], both[0]}}, 400},
		{"no epoch", owner, map[string]any{"keys": both}, 400},
		{"not owner", bob, map[string]any{"epoch": 1, "keys": both}, 403},
	} {
		code, out := e.do("POST", rp, tc.body, tc.signer)
		expectStatus(t, tc.name, tc.want, code, out)
	}
	oc.quiet(50 * time.Millisecond)

	code, out := e.do("POST", rp, map[string]any{"epoch": 1, "keys": both}, owner)
	if code != 200 || out["epoch"] != 1.0 {
		t.Fatalf("rotate: %d %v", code, out)
	}
	oc.expectSpaceChanged(space)
	bc.expectSpaceChanged(space)

	sp := bc.listSpaces(2)
	if len(sp) != 1 || sp[0].Epoch != 1 || len(sp[0].Keys) != 1 || sp[0].Keys[0].Epoch != 1 || string(sp[0].Keys[0].Wrapped) != "bob-key-1" {
		t.Fatalf("bob after rotate: %v", sp)
	}
	sp = oc.listSpaces(3)
	if len(sp[0].Keys) != 2 || string(sp[0].Keys[0].Wrapped) != "owner-key-0" || string(sp[0].Keys[1].Wrapped) != "owner-key-1" {
		t.Fatalf("owner keys after rotate: %v", sp[0].Keys)
	}

	// Writes under the old epoch are stale; the new one works.
	bc.push(4, space, "doc", 0, []byte("old"))
	bc.expectError(4, pb.ErrorCode_ERROR_CODE_EPOCH_STALE)
	bc.push(5, space, "doc", 1, []byte("new"))
	if a := bc.recv().GetAck(); a == nil || a.Ref != 5 || a.Seq != 1 {
		t.Fatalf("ack: %v", a)
	}
	bc.snapshot(6, space, "doc", 1, 0, []byte("old"))
	bc.expectError(6, pb.ErrorCode_ERROR_CODE_EPOCH_STALE)

	// The pending invite only carried epoch 0, so the rotation revoked it.
	if code, out := e.redeemShare(carol, pending); code != 410 {
		t.Fatalf("redeem pre-rotation invite: %d %v", code, out)
	}
	// New invites must cover both epochs; PUT keys accepts epoch 1 now.
	if code, out := e.do("POST", "/api/spaces/"+space+"/invites", map[string]any{"role": "viewer", "keys": linkKeys(0)}, owner); code != 409 {
		t.Fatalf("invite missing epoch 1: %d %v", code, out)
	}
	tok := e.shareInvite(owner, space, "viewer", 0, 1)
	code, out = e.redeemShare(carol, tok)
	if code != 200 || out["epoch"] != 1.0 || len(out["keys"].([]any)) != 2 {
		t.Fatalf("redeem after rotate: %d %v", code, out)
	}
	oc.expectSpaceChanged(space)
	bc.expectSpaceChanged(space)
	if code, out := e.do("PUT", "/api/spaces/"+space+"/keys", map[string]any{"keys": []map[string]any{
		{"epoch": 0, "wrapped": "AAAA"}, {"epoch": 1, "wrapped": "AAAA"}}}, carol); code != 200 {
		t.Fatalf("put keys after rotate: %d %v", code, out)
	}
	// Rotation now needs carol's key too.
	if code, out := e.do("POST", rp, map[string]any{"epoch": 2, "keys": both}, owner); code != 409 {
		t.Fatalf("rotate without new member: %d %v", code, out)
	}
}
