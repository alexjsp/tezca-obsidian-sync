package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"testing"
	"time"

	"tezca/server/internal/api"
	"tezca/server/internal/pb"
	"tezca/server/internal/sigs"
	"tezca/server/internal/store"
)

// ───────────── guest helpers ─────────────

// redeemShareAsGuest redeems a share invite with the unregistered (body-signed) form.
func (e *env) redeemShareAsGuest(id *ident, token string) (int, map[string]any) {
	e.t.Helper()
	return e.do("POST", "/api/share-invites/redeem", map[string]string{
		"token": token, "sign_pk": b64.EncodeToString(id.pk), "box_pk": b64.EncodeToString(id.box),
		"sig": b64.EncodeToString(id.sign(sigs.Redeem(e.serverID, token, id.pk, id.box))),
	}, nil)
}

// hostRole returns id's host role, or 0 if id isn't a host user.
func (e *env) hostRole(id *ident) int {
	e.t.Helper()
	u, err := e.st.GetUser(context.Background(), id.pk)
	if errors.Is(err, store.ErrNotFound) {
		return 0
	}
	if err != nil {
		e.t.Fatal(err)
	}
	return u.Role
}

// guest makes id a guest by redeeming an invite to space (as role) with the body form.
func (e *env) guest(owner *ident, space, role string) *ident {
	e.t.Helper()
	id := newIdent()
	if code, out := e.redeemShareAsGuest(id, e.shareInvite(owner, space, role, 0)); code != 200 {
		e.t.Fatalf("guest redeem: %d %v", code, out)
	}
	return id
}

func (cl *client) createKind(rid uint32, space string, kind pb.SpaceKind) *pb.ServerFrame {
	cl.t.Helper()
	cl.send(&pb.ClientFrame{Msg: &pb.ClientFrame_CreateSpace{CreateSpace: &pb.CreateSpace{
		Rid: rid, SpaceId: space, Kind: kind, WrappedKey: []byte("w-" + cl.name), Meta: []byte("m"),
	}}})
	return cl.recv()
}

// ───────────── tests ─────────────

func TestGuestRedeem(t *testing.T) {
	e := newEnv(t, nil)
	owner := newIdent()
	e.claim(owner)
	oc := e.dial(owner, "owner")
	space := randSpaceID()
	oc.createShare(1, space)

	// Failed redeems create no user.
	nobody := newIdent()
	expired := e.shareInvite(owner, space, "editor", 0)
	revoked := e.shareInvite(owner, space, "editor", 0)
	if code, out := e.do("DELETE", "/api/spaces/"+space+"/invites/"+revoked, nil, owner); code != 200 {
		t.Fatalf("revoke: %d %v", code, out)
	}
	taken := e.shareInvite(owner, space, "viewer", 0)
	first := newIdent()
	if code, out := e.redeemShareAsGuest(first, taken); code != 200 {
		t.Fatalf("first redeem: %d %v", code, out)
	}
	oc.expectSpaceChanged(space)
	if code, out := e.redeemShareAsGuest(nobody, "nope"); code != 404 {
		t.Fatalf("unknown token: %d %v", code, out)
	}
	if code, out := e.redeemShareAsGuest(nobody, revoked); code != 410 {
		t.Fatalf("revoked: %d %v", code, out)
	}
	if code, out := e.redeemShareAsGuest(nobody, taken); code != 409 {
		t.Fatalf("taken: %d %v", code, out)
	}
	tok := e.shareInvite(owner, space, "editor", 0)
	bad := map[string]string{
		"token": tok, "sign_pk": b64.EncodeToString(nobody.pk), "box_pk": b64.EncodeToString(nobody.box),
		"sig": b64.EncodeToString(nobody.sign(sigs.Redeem(e.serverID, "other-token", nobody.pk, nobody.box))),
	}
	if code, out := e.do("POST", "/api/share-invites/redeem", bad, nil); code != 401 {
		t.Fatalf("bad body sig: %d %v", code, out)
	}
	bad["sig"] = "AAAA"
	if code, out := e.do("POST", "/api/share-invites/redeem", bad, nil); code != 400 {
		t.Fatalf("malformed sig: %d %v", code, out)
	}
	if code, out := e.do("POST", "/api/share-invites/redeem", map[string]string{"token": tok}, nil); code != 401 {
		t.Fatalf("no auth at all: %d %v", code, out)
	}
	if code, out := e.redeemShare(nobody, tok); code != 401 { // HTTP sig of a non-user still fails
		t.Fatalf("non-user HTTP sig: %d %v", code, out)
	}
	e.apiClock.Advance(8 * 24 * time.Hour)
	if code, out := e.redeemShareAsGuest(nobody, expired); code != 410 {
		t.Fatalf("expired: %d %v", code, out)
	}
	e.apiClock.Advance(-8 * 24 * time.Hour)
	if r := e.hostRole(nobody); r != 0 {
		t.Fatalf("failed redeems created a user with role %d", r)
	}
	oc.quiet(50 * time.Millisecond)

	// A valid redeem creates a GUEST and answers like the HTTP-sig form.
	g := newIdent()
	code, out := e.redeemShareAsGuest(g, tok)
	if code != 200 || out["space_id"] != space || out["role"] != "editor" || out["kind"] != "share" ||
		out["epoch"] != float64(0) || out["meta"] != b64.EncodeToString([]byte("share-meta")) {
		t.Fatalf("guest redeem: %d %v", code, out)
	}
	if keys := out["keys"].([]any); len(keys) != 1 {
		t.Fatalf("keys: %v", out["keys"])
	}
	oc.expectSpaceChanged(space)
	u, err := e.st.GetUser(context.Background(), g.pk)
	if err != nil || u.Role != store.HostGuest || !bytes.Equal(u.BoxPk, g.box) {
		t.Fatalf("guest user: %+v %v", u, err)
	}
	if r := e.hostRole(first); r != store.HostGuest {
		t.Fatalf("first guest role: %d", r)
	}
	// Re-redeeming (either form) returns the same answer.
	if code, again := e.redeemShareAsGuest(g, tok); code != 200 || again["role"] != "editor" || again["space_id"] != space {
		t.Fatalf("re-redeem (body): %d %v", code, again)
	}
	if code, again := e.redeemShare(g, tok); code != 200 || again["role"] != "editor" {
		t.Fatalf("re-redeem (HTTP sig): %d %v", code, again)
	}

	// The guest connects and sees only the spaces they belong to.
	gc := e.dial(g, "g")
	if sps := gc.listSpaces(1); len(sps) != 1 || sps[0].SpaceId != space || sps[0].Role != pb.SpaceRole_SPACE_ROLE_EDITOR {
		t.Fatalf("guest spaces: %v", sps)
	}
	oc.createSpace(2, randSpaceID()) // the owner's other space stays invisible
	if sps := gc.listSpaces(2); len(sps) != 1 {
		t.Fatalf("guest spaces after owner's new space: %v", sps)
	}

	// An existing user redeeming with the body form keeps their role and box key.
	for _, role := range []string{"member", "guest"} {
		m := e.join(owner, role)
		want := e.hostRole(m)
		other := *m
		other.box = bytes.Repeat([]byte{7}, 32)
		if code, out := e.redeemShareAsGuest(&other, e.shareInvite(owner, space, "viewer", 0)); code != 200 || out["role"] != "viewer" {
			t.Fatalf("%s body redeem: %d %v", role, code, out)
		}
		oc.expectSpaceChanged(space)
		gc.expectSpaceChanged(space)
		u, err := e.st.GetUser(context.Background(), m.pk)
		if err != nil || u.Role != want || !bytes.Equal(u.BoxPk, m.box) {
			t.Fatalf("%s after body redeem: %+v %v", role, u, err)
		}
	}
	// The admin too.
	space2 := randSpaceID()
	gc.createKind(3, space2, pb.SpaceKind_SPACE_KIND_PROFILE)
	if code, out := e.redeemShareAsGuest(owner, e.shareInvite(g, space2, "viewer", 0)); code != 200 {
		t.Fatalf("admin body redeem: %d %v", code, out)
	}
	if r := e.hostRole(owner); r != store.HostAdmin {
		t.Fatalf("admin downgraded to %d", r)
	}
}

func TestGuestSpaces(t *testing.T) {
	e := newEnv(t, nil)
	owner := newIdent()
	e.claim(owner)
	oc := e.dial(owner, "owner")
	share := randSpaceID()
	oc.createShare(1, share)
	g := e.guest(owner, share, "editor")
	oc.expectSpaceChanged(share)
	gc := e.dial(g, "g")

	// Only one PROFILE space; no ROOT or SHARE.
	for i, k := range []pb.SpaceKind{pb.SpaceKind_SPACE_KIND_ROOT, pb.SpaceKind_SPACE_KIND_SHARE} {
		rid := uint32(10 + i)
		if f := gc.createKind(rid, randSpaceID(), k); f.GetError() == nil || f.GetError().Code != pb.ErrorCode_ERROR_CODE_FORBIDDEN || f.GetError().Rid != rid {
			t.Fatalf("guest create %v: %v", k, f)
		}
	}
	profile := randSpaceID()
	f := gc.createKind(20, profile, pb.SpaceKind_SPACE_KIND_PROFILE)
	if sc := f.GetSpaceCreated(); sc == nil || sc.Rid != 20 || sc.Space.Kind != pb.SpaceKind_SPACE_KIND_PROFILE || sc.Space.Role != pb.SpaceRole_SPACE_ROLE_OWNER {
		t.Fatalf("guest create profile: %v", f)
	}
	gc.send(&pb.ClientFrame{Msg: &pb.ClientFrame_CreateSpace{CreateSpace: &pb.CreateSpace{
		Rid: 21, SpaceId: randSpaceID(), Kind: pb.SpaceKind_SPACE_KIND_PROFILE, WrappedKey: []byte("w")}}})
	gc.expectError(21, pb.ErrorCode_ERROR_CODE_CONFLICT)

	// Members may create one PROFILE space too.
	oc.createKind(30, randSpaceID(), pb.SpaceKind_SPACE_KIND_PROFILE)
	oc.send(&pb.ClientFrame{Msg: &pb.ClientFrame_CreateSpace{CreateSpace: &pb.CreateSpace{
		Rid: 31, SpaceId: randSpaceID(), Kind: pb.SpaceKind_SPACE_KIND_PROFILE, WrappedKey: []byte("w")}}})
	oc.expectError(31, pb.ErrorCode_ERROR_CODE_CONFLICT)

	// Exactly their share and their profile (ListSpaces order isn't specified).
	if sps := gc.listSpaces(40); len(sps) != 2 ||
		!((sps[0].SpaceId == share && sps[1].SpaceId == profile) || (sps[0].SpaceId == profile && sps[1].SpaceId == share)) {
		t.Fatalf("guest spaces: %v", sps)
	}

	// Member-level operations in their spaces, per their role there.
	for _, space := range []string{share, profile} {
		gc.push(1, space, "doc", 0, []byte("u1"))
		if a := gc.recv().GetAck(); a == nil || a.Seq != 1 {
			t.Fatalf("guest push to %s: %v", space, a)
		}
		_, seqs, done := gc.syncDoc(space, "doc", 0)
		if len(seqs) != 1 || done == nil {
			t.Fatalf("guest sync %s: %v %v", space, seqs, done)
		}
	}
	// The owner reads what the guest wrote to the share.
	if _, seqs, _ := oc.syncDoc(share, "doc", 0); len(seqs) != 1 {
		t.Fatalf("owner sync: %v", seqs)
	}
	// A guest viewer can read but not write.
	v := e.guest(owner, share, "viewer")
	oc.expectSpaceChanged(share)
	gc.expectSpaceChanged(share)
	vc := e.dial(v, "v")
	vc.push(5, share, "doc", 0, []byte("nope"))
	vc.expectError(5, pb.ErrorCode_ERROR_CODE_FORBIDDEN)

	// Guests can share their own space onward: they own it.
	if code, out := e.do("POST", "/api/spaces/"+profile+"/invites", map[string]any{"role": "viewer", "keys": linkKeys(0)}, g); code != 200 {
		t.Fatalf("guest invite to own space: %d %v", code, out)
	}

	// Pairing: a guest can add devices.
	ct := b64.EncodeToString([]byte("sealed pairing payload"))
	code, out := e.do("POST", "/api/pairings", map[string]string{"ciphertext": ct}, g)
	if code != 200 || out["id"] == nil {
		t.Fatalf("guest pairing: %d %v", code, out)
	}
	if code, got := e.do("GET", "/api/pairings/"+out["id"].(string), nil, nil); code != 200 || got["ciphertext"] != ct {
		t.Fatalf("take pairing: %d %v", code, got)
	}
}

func TestInfoRole(t *testing.T) {
	e := newEnv(t, nil)
	admin := newIdent()
	e.claim(admin)
	member := e.join(admin, "member")
	space := randSpaceID()
	e.dial(admin, "a").createShare(1, space)
	g := e.guest(admin, space, "viewer")

	for _, tc := range []struct {
		name   string
		signer *ident
		want   any
	}{
		{"unsigned", nil, nil},
		{"admin", admin, "admin"},
		{"member", member, "member"},
		{"guest", g, "guest"},
		{"not a user", newIdent(), nil},
	} {
		code, out := e.call("GET", "/api/info", nil, tc.signer, 0)
		if code != 200 || out["server_id"] != e.serverID || out["role"] != tc.want {
			t.Fatalf("%s: %d %v", tc.name, code, out)
		}
		if _, has := out["role"]; has != (tc.want != nil) {
			t.Fatalf("%s: role present = %v", tc.name, has)
		}
	}
	// A bad or stale signature is answered as unsigned.
	if code, out := e.call("GET", "/api/info", nil, admin, time.Hour); code != 200 || out["role"] != nil {
		t.Fatalf("skewed: %d %v", code, out)
	}
	code, _, data := e.rawCall("GET", "/api/info", nil, admin, []byte("not the body"), false)
	var out map[string]any
	json.Unmarshal(data, &out)
	if code != 200 || out["role"] != nil || out["server_id"] != e.serverID {
		t.Fatalf("bad sig: %d %v", code, out)
	}
}

func TestGuestQuota(t *testing.T) {
	const quota = 100
	e := newEnvAPI(t, nil, func(c *api.Config) { c.GuestQuotaBytes = quota })
	owner := newIdent()
	e.claim(owner)
	space := randSpaceID()
	oc := e.dial(owner, "owner")
	oc.createShare(1, space)
	g := e.guest(owner, space, "editor")
	g2 := e.guest(owner, space, "editor")

	blob := func() string { return "/api/spaces/" + space + "/blobs/" + randBlobID() }
	put := func(who *ident, p string, n int, chunked bool) (int, map[string]any) {
		t.Helper()
		code, _, data := e.rawCall("PUT", p, bytes.Repeat([]byte{'x'}, n), who, nil, chunked)
		out := map[string]any{}
		json.Unmarshal(data, &out)
		return code, out
	}
	exists := func(p string) bool {
		t.Helper()
		code, _, _ := e.rawCall("HEAD", p, nil, owner, nil, false)
		return code == 200
	}

	first := blob()
	if code, out := put(g, first, 60, false); code != 201 {
		t.Fatalf("first: %d %v", code, out)
	}
	// Dedup doesn't count: re-uploading the same blob is fine.
	if code, out := put(g, first, 60, false); code != 200 {
		t.Fatalf("dedup: %d %v", code, out)
	}
	// Over quota: by declared length (rejected up front) and streamed (rejected mid-body).
	for _, chunked := range []bool{false, true} {
		p := blob()
		code, out := put(g, p, 41, chunked)
		if code != 507 || out["error"] != "guest storage quota exceeded" {
			t.Fatalf("over quota (chunked=%v): %d %v", chunked, code, out)
		}
		if exists(p) {
			t.Fatalf("over-quota blob stored (chunked=%v)", chunked)
		}
	}
	// Exactly up to the quota is fine; nothing more fits after that.
	if code, out := put(g, blob(), 40, true); code != 201 {
		t.Fatalf("fill: %d %v", code, out)
	}
	if code, out := put(g, blob(), 1, false); code != 507 {
		t.Fatalf("full: %d %v", code, out)
	}
	// Blobs someone else already uploaded don't count either.
	byOwner := blob()
	if code, out := put(owner, byOwner, 500, false); code != 201 {
		t.Fatalf("owner put (no quota for members): %d %v", code, out)
	}
	if code, out := put(g, byOwner, 500, false); code != 200 {
		t.Fatalf("guest dedup of another's blob: %d %v", code, out)
	}
	// The quota is per guest.
	if code, out := put(g2, blob(), 100, false); code != 201 {
		t.Fatalf("second guest: %d %v", code, out)
	}
	if used, err := e.st.UserBytes(context.Background(), g.pk); err != nil || used != 100 {
		t.Fatalf("guest usage: %d %v", used, err)
	}
}
