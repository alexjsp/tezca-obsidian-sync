package e2e

import (
	"bytes"
	"context"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"tezca/server/internal/api"
	"tezca/server/internal/clientip"
	"tezca/server/internal/pb"
	"tezca/server/internal/sigs"
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

// Before AuthOk only small frames are accepted; afterwards the full ReadLimit applies.
func TestWSPreAuthLimits(t *testing.T) {
	e := newEnv(t, nil)
	admin := newIdent()
	e.claim(admin)

	// An oversized first frame closes the connection.
	c := e.rawDial("big")
	c.startReader()
	c.recv().GetChallenge()
	c.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Hello{Hello: &pb.Hello{
		SignPk: admin.pk, DeviceId: "d", ProtocolVersion: 1, ClientVersion: strings.Repeat("x", ws.PreAuthReadLimit+1)}}})
	if code := c.expectClosed(); code != websocket.StatusMessageTooBig {
		t.Fatalf("close code %v", code)
	}

	// A device_id over MaxDeviceID is refused.
	c = e.rawDial("long-device")
	c.startReader()
	ch := c.recv().GetChallenge()
	dev := strings.Repeat("d", ws.MaxDeviceID+1)
	c.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Hello{Hello: &pb.Hello{SignPk: admin.pk, DeviceId: dev, ProtocolVersion: 1}}})
	c.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Auth{Auth: &pb.Auth{Sig: admin.sign(sigs.Auth(e.serverID, ch.Nonce, admin.pk, dev))}}})
	c.expectError(0, pb.ErrorCode_ERROR_CODE_UNAUTHORIZED)
	c.expectClosed()

	// Once authenticated, large frames are fine.
	ac := e.dial(admin, strings.Repeat("d", ws.MaxDeviceID))
	space := randSpaceID()
	ac.createSpace(1, space)
	ac.push(2, space, "doc", 0, bytes.Repeat([]byte{'p'}, 1<<20))
	if a := ac.recv().GetAck(); a == nil || a.Ref != 2 {
		t.Fatalf("large push after auth: %v", a)
	}
}

// tryDial opens a WebSocket and returns the HTTP status of a refused upgrade (0 on success).
func (e *env) tryDial(header http.Header) (*websocket.Conn, int) {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, resp, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(e.srv.URL, "http")+"/ws", &websocket.DialOptions{HTTPHeader: header})
	if err != nil {
		if resp == nil {
			e.t.Fatal(err)
		}
		return nil, resp.StatusCode
	}
	e.t.Cleanup(func() { c.CloseNow() })
	return c, 0
}

// waitConns waits until the hub has n connections.
func (e *env) waitConns(n int) {
	e.t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for {
		conns, _, _ := e.hub.Stats()
		if conns == n {
			return
		}
		if time.Now().After(deadline) {
			e.t.Fatalf("conns = %d, want %d", conns, n)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func TestWSConnectionCaps(t *testing.T) {
	trusted, err := clientip.Parse("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	e := newEnv(t, func(c *ws.Config) {
		c.MaxConns = 4
		c.MaxConnsPerIP = 2
		c.ClientIP = trusted.IP
	})
	from := func(ip string) http.Header { return http.Header{"X-Forwarded-For": {ip}} }

	a1, _ := e.tryDial(from("198.51.100.1"))
	e.tryDial(from("198.51.100.1"))
	if _, status := e.tryDial(from("198.51.100.1")); status != http.StatusTooManyRequests {
		t.Fatalf("third from one IP: %d", status)
	}
	e.tryDial(from("198.51.100.2"))
	e.tryDial(from("198.51.100.3"))
	e.waitConns(4)
	if _, status := e.tryDial(from("198.51.100.4")); status != http.StatusServiceUnavailable {
		t.Fatalf("over the total: %d", status)
	}
	// Closing one frees its slot.
	a1.CloseNow()
	for deadline := time.Now().Add(5 * time.Second); ; time.Sleep(10 * time.Millisecond) {
		_, status := e.tryDial(from("198.51.100.1"))
		if status == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("after close: %d", status)
		}
	}
}
