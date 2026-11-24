package e2e

import (
	"testing"

	"tezca/server/internal/pb"
	"tezca/server/internal/sigs"
)

func TestRemoveUser(t *testing.T) {
	e := newEnv(t, nil)
	admin := newIdent()
	e.claim(admin)
	member := e.join(admin, "member")

	// Listing users is admin-only.
	if code, out := e.do("GET", "/api/users", nil, member); code != 403 {
		t.Fatalf("member lists users: %d %v", code, out)
	}
	code, out := e.do("GET", "/api/users", nil, admin)
	users, _ := out["users"].([]any)
	if code != 200 || len(users) != 2 {
		t.Fatalf("list: %d %v", code, out)
	}
	roles := map[string]string{}
	for _, x := range users {
		u := x.(map[string]any)
		roles[u["sign_pk"].(string)] = u["role"].(string)
		if ts, _ := u["created_at"].(float64); ts < 1e9 || ts > 1e11 {
			t.Fatalf("created_at not in seconds: %v", u)
		}
		if u["sign_pk"] == b64.EncodeToString(admin.pk) && u["box_pk"] != b64.EncodeToString(admin.box) {
			t.Fatalf("admin's box_pk: %v", u)
		}
	}
	if roles[b64.EncodeToString(admin.pk)] != "admin" || roles[b64.EncodeToString(member.pk)] != "member" {
		t.Fatalf("roles: %v", roles)
	}

	// The member owns a share with a guest in it; the guest is connected and has a pairing.
	mc := e.dial(member, "m")
	share := randSpaceID()
	mc.createShare(1, share)
	g := e.guest(member, share, "editor")
	mc.expectSpaceChanged(share)
	gc := e.dial(g, "g")
	gc.subscribe(share, "doc", 0)
	if done := gc.recv().GetSyncDone(); done == nil {
		t.Fatal("guest subscribe")
	}
	code, out = e.do("POST", "/api/pairings", map[string]string{"ciphertext": b64.EncodeToString([]byte("p"))}, g)
	if code != 200 {
		t.Fatalf("pairing: %d %v", code, out)
	}
	pairing := out["id"].(string)

	path := func(id *ident) string { return "/api/users/" + b64.EncodeToString(id.pk) }
	if code, out := e.do("DELETE", path(g), nil, member); code != 403 {
		t.Fatalf("member removes: %d %v", code, out)
	}
	if code, out := e.do("DELETE", "/api/users/nope", nil, admin); code != 400 {
		t.Fatalf("bad key: %d %v", code, out)
	}
	if code, out := e.do("DELETE", path(newIdent()), nil, admin); code != 404 {
		t.Fatalf("unknown user: %d %v", code, out)
	}
	if code, out := e.do("DELETE", path(admin), nil, admin); code != 409 {
		t.Fatalf("last admin: %d %v", code, out)
	}

	if code, out := e.do("DELETE", path(g), nil, admin); code != 200 {
		t.Fatalf("remove guest: %d %v", code, out)
	}
	// Their live session ends, the share's members hear about it, and the user is gone.
	gc.expectClosed() // with 1008 "user removed" if the close frame wins the race with the teardown
	mc.expectSpaceChanged(share)
	for _, sp := range mc.listSpaces(2) {
		for _, m := range sp.Members {
			if string(m.SignPk) == string(g.pk) {
				t.Fatalf("removed user still a member of %s", sp.SpaceId)
			}
		}
	}
	if code, _ := e.do("GET", "/api/pairings/"+pairing, nil, nil); code != 404 {
		t.Fatalf("removed user's pairing: %d", code)
	}
	if code, out := e.do("POST", "/api/pairings", map[string]string{"ciphertext": "cA"}, g); code != 401 {
		t.Fatalf("removed user signs a request: %d %v", code, out)
	}
	c := e.rawDial("g-again")
	c.startReader()
	ch := c.recv().GetChallenge()
	c.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Hello{Hello: &pb.Hello{SignPk: g.pk, DeviceId: "g", ProtocolVersion: 1}}})
	c.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Auth{Auth: &pb.Auth{Sig: g.sign(sigs.Auth(e.serverID, ch.Nonce, g.pk, "g"))}}})
	c.expectError(0, pb.ErrorCode_ERROR_CODE_UNAUTHORIZED)

	// Removing a member works the same; the list shrinks.
	if code, out := e.do("DELETE", path(member), nil, admin); code != 200 {
		t.Fatalf("remove member: %d %v", code, out)
	}
	mc.expectClosed()
	if code, out := e.do("GET", "/api/users", nil, admin); code != 200 || len(out["users"].([]any)) != 1 {
		t.Fatalf("list after: %d %v", code, out)
	}
}

func TestSetUserRole(t *testing.T) {
	e := newEnv(t, nil)
	admin := newIdent()
	e.claim(admin)
	member := e.join(admin, "member")
	mc := e.dial(member, "m")
	share := randSpaceID()
	mc.createShare(1, share)
	g := e.guest(member, share, "editor")
	mc.expectSpaceChanged(share)

	path := func(id *ident) string { return "/api/users/" + b64.EncodeToString(id.pk) + "/role" }
	set := func(by, target *ident, role string) (int, map[string]any) {
		return e.do("PUT", path(target), map[string]string{"role": role}, by)
	}
	hostRole := func(id *ident, device string) pb.HostRole {
		c := e.rawDial(device)
		c.startReader()
		ch := c.recv().GetChallenge()
		c.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Hello{Hello: &pb.Hello{SignPk: id.pk, DeviceId: device, ProtocolVersion: 1}}})
		c.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Auth{Auth: &pb.Auth{Sig: id.sign(sigs.Auth(e.serverID, ch.Nonce, id.pk, device))}}})
		ok := c.recv().GetAuthOk()
		if ok == nil {
			t.Fatalf("%s: no AuthOk", device)
		}
		return ok.Role
	}

	if code, out := set(member, member, "admin"); code != 403 {
		t.Fatalf("member promotes self: %d %v", code, out)
	}
	if code, out := set(admin, member, "owner"); code != 400 {
		t.Fatalf("bad role: %d %v", code, out)
	}
	if code, out := set(admin, g, "admin"); code != 409 {
		t.Fatalf("guest: %d %v", code, out)
	}
	if code, out := set(admin, admin, "member"); code != 409 {
		t.Fatalf("last admin steps down: %d %v", code, out)
	}

	// Promoting ends the member's live sessions; they come back as an admin and can manage users.
	if code, out := set(admin, member, "admin"); code != 200 {
		t.Fatalf("promote: %d %v", code, out)
	}
	mc.expectClosed()
	if r := hostRole(member, "m2"); r != pb.HostRole_HOST_ROLE_ADMIN {
		t.Fatalf("role after promotion: %v", r)
	}
	if code, out := e.do("GET", "/api/users", nil, member); code != 200 {
		t.Fatalf("new admin lists users: %d %v", code, out)
	}

	// Now the original admin can step down, and is a member from then on.
	if code, out := set(admin, admin, "member"); code != 200 {
		t.Fatalf("step down: %d %v", code, out)
	}
	if r := hostRole(admin, "a2"); r != pb.HostRole_HOST_ROLE_MEMBER {
		t.Fatalf("role after stepping down: %v", r)
	}
	if code, out := e.do("GET", "/api/users", nil, admin); code != 403 {
		t.Fatalf("former admin lists users: %d %v", code, out)
	}
}
