package e2e

import (
	"bytes"
	"testing"

	"tezca/server/internal/api"
	"tezca/server/internal/pb"
	"tezca/server/internal/store"
	"tezca/server/internal/ws"
)

// A guest's updates and snapshots count toward the guest quota, together with their blobs.
func TestGuestDocQuota(t *testing.T) {
	const quota = 100
	e := newEnvAPI(t, func(c *ws.Config) { c.GuestQuotaBytes = quota }, func(c *api.Config) { c.GuestQuotaBytes = quota })
	owner := newIdent()
	e.claim(owner)
	share := randSpaceID()
	oc := e.dial(owner, "owner")
	oc.createShare(1, share)
	g := e.guest(owner, share, "editor")
	oc.expectSpaceChanged(share)
	gc := e.dial(g, "g")
	profile := randSpaceID()
	gc.createKind(2, profile, pb.SpaceKind_SPACE_KIND_PROFILE)

	gc.push(1, profile, "d", 0, bytes.Repeat([]byte{'u'}, 60))
	if a := gc.recv().GetAck(); a == nil || a.Seq != 1 {
		t.Fatalf("first push: %v", a)
	}
	// In any space, not just the profile.
	gc.push(2, share, "d", 0, bytes.Repeat([]byte{'u'}, 41))
	if e := gc.expectError(2, pb.ErrorCode_ERROR_CODE_TOO_LARGE); e.Message != "guest storage quota exceeded" {
		t.Fatalf("over quota: %v", e)
	}
	// Snapshots count too.
	gc.snapshot(3, profile, "d", 1, 0, bytes.Repeat([]byte{'s'}, 41))
	gc.expectError(3, pb.ErrorCode_ERROR_CODE_TOO_LARGE)
	gc.snapshot(4, profile, "d", 1, 0, bytes.Repeat([]byte{'s'}, 40))
	if a := gc.recv().GetSnapshotAck(); a == nil || a.Ref != 4 {
		t.Fatalf("snapshot up to quota: %v", a)
	}
	// Blobs share the same budget: it's full now.
	code, _, _ := e.rawCall("PUT", "/api/spaces/"+share+"/blobs/"+randBlobID(), []byte("x"), g, nil, false)
	if code != 507 {
		t.Fatalf("blob after docs filled the quota: %d", code)
	}
	// Members have no quota.
	oc.push(5, share, "d", 0, bytes.Repeat([]byte{'o'}, 500))
	for {
		f := oc.recv()
		if a := f.GetAck(); a != nil {
			if a.Ref != 5 {
				t.Fatalf("owner push: %v", a)
			}
			break
		}
		if f.GetDocHeads() == nil {
			t.Fatalf("owner push: %v", f)
		}
	}
}

func TestPairingCap(t *testing.T) {
	e := newEnv(t, nil)
	admin := newIdent()
	e.claim(admin)
	ct := b64.EncodeToString([]byte("sealed"))
	var ids []string
	for i := 0; i < store.MaxPairingsPerUser; i++ {
		code, out := e.do("POST", "/api/pairings", map[string]string{"ciphertext": ct}, admin)
		if code != 200 {
			t.Fatalf("pairing %d: %d %v", i, code, out)
		}
		ids = append(ids, out["id"].(string))
	}
	if code, out := e.do("POST", "/api/pairings", map[string]string{"ciphertext": ct}, admin); code != 429 {
		t.Fatalf("over cap: %d %v", code, out)
	}
	if code, _ := e.do("GET", "/api/pairings/"+ids[0], nil, nil); code != 200 {
		t.Fatalf("take: %d", code)
	}
	if code, out := e.do("POST", "/api/pairings", map[string]string{"ciphertext": ct}, admin); code != 200 {
		t.Fatalf("after take: %d %v", code, out)
	}
}
