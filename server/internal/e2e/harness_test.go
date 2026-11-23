// Package e2e runs the full server (store + HTTP API + WebSocket hub) under httptest.
package e2e

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"tezca/server/internal/api"
	"tezca/server/internal/blobs"
	"tezca/server/internal/pb"
	"tezca/server/internal/sigs"
	"tezca/server/internal/store"
	"tezca/server/internal/ws"
)

const claimCode = "test-claim-code"

var b64 = base64.RawURLEncoding

type env struct {
	t        *testing.T
	st       *store.Store
	hub      *ws.Hub
	srv      *httptest.Server
	serverID string
	clock    *fakeClock   // the hub's clock (snapshot created_at)
	apiClock *offsetClock // the HTTP API's clock: real time plus a settable offset
	blobDir  string       // filesystem blob store root
}

// testMaxBlob is the plaintext blob limit in tests: small, so 413s don't need huge bodies.
const testMaxBlob = 64 << 10

// fakeClock is a settable clock. It starts at the real time and stands still.
type fakeClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *fakeClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.t
}

func (c *fakeClock) Set(t time.Time) {
	c.mu.Lock()
	c.t = t
	c.mu.Unlock()
}

// offsetClock is real time shifted by a settable offset (0 by default).
type offsetClock struct {
	mu sync.Mutex
	d  time.Duration
}

func (c *offsetClock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return time.Now().Add(c.d)
}

// Advance moves the clock forward; signed requests then need skew = Offset().
func (c *offsetClock) Advance(d time.Duration) {
	c.mu.Lock()
	c.d += d
	c.mu.Unlock()
}

func (c *offsetClock) Offset() time.Duration {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.d
}

func newEnv(t *testing.T, mod func(*ws.Config)) *env {
	t.Helper()
	return newEnvAPI(t, mod, nil)
}

// newEnvAPI is newEnv with a hook for the HTTP API's config as well.
func newEnvAPI(t *testing.T, mod func(*ws.Config), apiMod func(*api.Config)) *env {
	t.Helper()
	dir := t.TempDir()
	st, err := store.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	id, _, _, err := st.Init(context.Background(), claimCode)
	if err != nil {
		t.Fatal(err)
	}
	blobDir := filepath.Join(dir, "blobs")
	bs, err := blobs.NewFS(blobDir)
	if err != nil {
		t.Fatal(err)
	}
	clock := &fakeClock{t: time.Now()}
	log := slog.New(slog.NewTextHandler(io.Discard, nil))
	cfg := ws.Config{Store: st, ServerID: id, Logger: log, Now: clock.Now}
	if mod != nil {
		mod(&cfg)
	}
	hub := ws.NewHub(cfg)
	apiClock := &offsetClock{}
	acfg := api.Config{Store: st, Hub: hub, Notify: hub, ServerID: id, Name: "Test", Logger: log, Now: apiClock.Now,
		Blobs: bs, MaxBlobBytes: testMaxBlob}
	if apiMod != nil {
		apiMod(&acfg)
	}
	h := api.New(acfg)
	srv := httptest.NewServer(h)
	t.Cleanup(func() {
		hub.Close()
		srv.Close()
		st.Close()
	})
	return &env{t: t, st: st, hub: hub, srv: srv, serverID: id, clock: clock, apiClock: apiClock, blobDir: blobDir}
}

type ident struct {
	pk  ed25519.PublicKey
	sk  ed25519.PrivateKey
	box []byte
}

func newIdent() *ident {
	pk, sk, _ := ed25519.GenerateKey(rand.Reader)
	box := make([]byte, 32)
	rand.Read(box)
	return &ident{pk: pk, sk: sk, box: box}
}

func (id *ident) sign(msg []byte) []byte { return ed25519.Sign(id.sk, msg) }

// call performs an HTTP request; signer (optional) adds the Tezca Authorization header with
// ts = now + skew. It returns the status and the decoded JSON body (if any).
func (e *env) call(method, path string, body any, signer *ident, skew time.Duration) (int, map[string]any) {
	e.t.Helper()
	var raw []byte
	if body != nil {
		raw, _ = json.Marshal(body)
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, bytes.NewReader(raw))
	if signer != nil {
		ts := time.Now().Add(skew).Unix()
		sig := signer.sign(sigs.HTTP(method, path, uint64(ts), raw))
		req.Header.Set("Authorization", fmt.Sprintf("Tezca pk=%s, ts=%d, sig=%s", b64.EncodeToString(signer.pk), ts, b64.EncodeToString(sig)))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	out := map[string]any{}
	data, _ := io.ReadAll(resp.Body)
	if strings.HasPrefix(resp.Header.Get("Content-Type"), "application/json") {
		if err := json.Unmarshal(data, &out); err != nil {
			e.t.Fatalf("bad json %q: %v", data, err)
		}
	}
	return resp.StatusCode, out
}

// rawCall sends a raw body (chunked if chunked is set), signed by signer over sha256(signBody)
// (signBody defaults to body). It returns the status, headers and response body.
func (e *env) rawCall(method, path string, body []byte, signer *ident, signBody []byte, chunked bool) (int, http.Header, []byte) {
	e.t.Helper()
	var rd io.Reader = bytes.NewReader(body)
	if chunked {
		rd = io.MultiReader(rd) // hide the length
	}
	req, _ := http.NewRequest(method, e.srv.URL+path, rd)
	if chunked {
		req.ContentLength = -1
	}
	if method == "PUT" {
		req.Header.Set("Content-Type", "application/octet-stream")
	}
	if signer != nil {
		if signBody == nil {
			signBody = body
		}
		ts := time.Now().Unix()
		sig := signer.sign(sigs.HTTP(method, path, uint64(ts), signBody))
		req.Header.Set("Authorization", fmt.Sprintf("Tezca pk=%s, ts=%d, sig=%s", b64.EncodeToString(signer.pk), ts, b64.EncodeToString(sig)))
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, resp.Header, data
}

func (e *env) claim(id *ident) {
	e.t.Helper()
	code, out := e.call("POST", "/api/claim", map[string]string{
		"code": claimCode, "sign_pk": b64.EncodeToString(id.pk), "box_pk": b64.EncodeToString(id.box),
		"sig": b64.EncodeToString(id.sign(sigs.Redeem(e.serverID, claimCode, id.pk, id.box))),
	}, nil, 0)
	if code != 200 || out["role"] != "admin" || out["server_id"] != e.serverID {
		e.t.Fatalf("claim: %d %v", code, out)
	}
}

func (e *env) invite(admin *ident, role string) string {
	e.t.Helper()
	code, out := e.call("POST", "/api/invites", map[string]any{"role": role}, admin, 0)
	if code != 200 {
		e.t.Fatalf("invite: %d %v", code, out)
	}
	return out["token"].(string)
}

func (e *env) redeem(id *ident, token string) (int, map[string]any) {
	return e.call("POST", "/api/redeem", map[string]string{
		"token": token, "sign_pk": b64.EncodeToString(id.pk), "box_pk": b64.EncodeToString(id.box),
		"sig": b64.EncodeToString(id.sign(sigs.Redeem(e.serverID, token, id.pk, id.box))),
	}, nil, 0)
}

// join registers a new user with the given host role ("member" or "guest").
func (e *env) join(admin *ident, role string) *ident {
	e.t.Helper()
	id := newIdent()
	if code, out := e.redeem(id, e.invite(admin, role)); code != 200 || out["role"] != role {
		e.t.Fatalf("redeem: %d %v", code, out)
	}
	return id
}

// ───────────── WebSocket client ─────────────

type client struct {
	t      *testing.T
	name   string
	id     *ident
	c      *websocket.Conn
	in     chan *pb.ServerFrame
	closed chan error
}

func (e *env) rawDial(name string) *client {
	e.t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	c, _, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(e.srv.URL, "http")+"/ws", &websocket.DialOptions{
		HTTPHeader: http.Header{"Origin": {"app://obsidian.md"}},
	})
	if err != nil {
		e.t.Fatal(err)
	}
	c.SetReadLimit(64 << 20)
	cl := &client{t: e.t, name: name, c: c, in: make(chan *pb.ServerFrame, 100000), closed: make(chan error, 1)}
	e.t.Cleanup(func() { c.CloseNow() })
	return cl
}

// startReader drains frames into cl.in in the background.
func (cl *client) startReader() {
	go func() {
		for {
			_, data, err := cl.c.Read(context.Background())
			if err != nil {
				cl.closed <- err
				close(cl.in)
				return
			}
			f := &pb.ServerFrame{}
			if err := proto.Unmarshal(data, f); err != nil {
				panic(err)
			}
			cl.in <- f
		}
	}()
}

// dial connects and authenticates id.
func (e *env) dial(id *ident, device string) *client {
	e.t.Helper()
	cl := e.rawDial(device)
	cl.id = id
	cl.startReader()
	ch := cl.recv().GetChallenge()
	if ch == nil || ch.ServerId != e.serverID || len(ch.Nonce) != 32 || ch.ProtocolVersion != 1 {
		e.t.Fatalf("bad challenge %v", ch)
	}
	cl.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Hello{Hello: &pb.Hello{SignPk: id.pk, DeviceId: device, ProtocolVersion: 1, ClientVersion: "test"}}})
	cl.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Auth{Auth: &pb.Auth{Sig: id.sign(sigs.Auth(e.serverID, ch.Nonce, id.pk, device))}}})
	ok := cl.recv().GetAuthOk()
	if ok == nil || !bytes.Equal(ok.SignPk, id.pk) || !bytes.Equal(ok.BoxPk, id.box) {
		e.t.Fatalf("expected AuthOk, got %v", ok)
	}
	return cl
}

func (cl *client) send(f *pb.ClientFrame) {
	cl.t.Helper()
	b, err := proto.Marshal(f)
	if err != nil {
		cl.t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := cl.c.Write(ctx, websocket.MessageBinary, b); err != nil {
		cl.t.Fatalf("%s: write: %v", cl.name, err)
	}
}

func (cl *client) recv() *pb.ServerFrame {
	cl.t.Helper()
	select {
	case f, ok := <-cl.in:
		if !ok {
			cl.t.Fatalf("%s: connection closed", cl.name)
		}
		return f
	case <-time.After(10 * time.Second):
		cl.t.Fatalf("%s: timed out waiting for a frame", cl.name)
	}
	return nil
}

// quiet asserts no frame arrives within d.
func (cl *client) quiet(d time.Duration) {
	cl.t.Helper()
	select {
	case f, ok := <-cl.in:
		if ok {
			cl.t.Fatalf("%s: unexpected frame %v", cl.name, f)
		}
	case <-time.After(d):
	}
}

// expectClosed waits for the server to close the connection and returns the close status.
func (cl *client) expectClosed() websocket.StatusCode {
	cl.t.Helper()
	for {
		select {
		case _, ok := <-cl.in:
			if !ok {
				return websocket.CloseStatus(<-cl.closed)
			}
		case <-time.After(10 * time.Second):
			cl.t.Fatalf("%s: connection not closed", cl.name)
		}
	}
}

func (cl *client) expectError(rid uint32, code pb.ErrorCode) *pb.Error {
	cl.t.Helper()
	f := cl.recv()
	e := f.GetError()
	if e == nil || e.Code != code || e.Rid != rid {
		cl.t.Fatalf("%s: expected Error{rid:%d code:%v}, got %v", cl.name, rid, code, f)
	}
	return e
}

// ───────────── frame builders ─────────────

func randSpaceID() string {
	b := make([]byte, 16)
	rand.Read(b)
	return b64.EncodeToString(b)
}

func (cl *client) createSpace(rid uint32, space string) *pb.SpaceInfo {
	cl.t.Helper()
	cl.send(&pb.ClientFrame{Msg: &pb.ClientFrame_CreateSpace{CreateSpace: &pb.CreateSpace{
		Rid: rid, SpaceId: space, Kind: pb.SpaceKind_SPACE_KIND_ROOT, WrappedKey: []byte("wrapped-for-" + cl.name), Meta: []byte("meta"),
	}}})
	f := cl.recv().GetSpaceCreated()
	if f == nil || f.Rid != rid || f.Space.SpaceId != space || f.Space.Role != pb.SpaceRole_SPACE_ROLE_OWNER {
		cl.t.Fatalf("expected SpaceCreated, got %v", f)
	}
	return f.Space
}

func (cl *client) push(ref uint32, space, doc string, epoch uint32, payload []byte) {
	cl.t.Helper()
	cl.send(&pb.ClientFrame{Msg: &pb.ClientFrame_PushUpdate{PushUpdate: &pb.PushUpdate{
		Ref: ref, SpaceId: space, DocId: doc, Epoch: epoch, Payload: payload,
		Sig: cl.id.sign(sigs.Update(space, doc, epoch, payload)),
	}}})
}

func (cl *client) snapshot(ref uint32, space, doc string, base uint64, epoch uint32, payload []byte) {
	cl.t.Helper()
	cl.send(&pb.ClientFrame{Msg: &pb.ClientFrame_PutSnapshot{PutSnapshot: &pb.PutSnapshot{
		Ref: ref, SpaceId: space, DocId: doc, BaseSeq: base, Epoch: epoch, Payload: payload,
		Sig: cl.id.sign(sigs.Snapshot(space, doc, base, epoch, payload)),
	}}})
}

func (cl *client) subscribe(space, doc string, since uint64) {
	cl.send(&pb.ClientFrame{Msg: &pb.ClientFrame_Subscribe{Subscribe: &pb.Subscribe{SpaceId: space, DocId: doc, SinceSeq: since}}})
}

// syncDoc subscribes and collects the backlog until SyncDone.
func (cl *client) syncDoc(space, doc string, since uint64) (snap *pb.Snapshot, seqs []uint64, done *pb.SyncDone) {
	cl.t.Helper()
	cl.subscribe(space, doc, since)
	for {
		f := cl.recv()
		switch m := f.Msg.(type) {
		case *pb.ServerFrame_Snapshot:
			if snap != nil || seqs != nil {
				cl.t.Fatalf("snapshot out of order")
			}
			snap = m.Snapshot
		case *pb.ServerFrame_Updates:
			for _, u := range m.Updates.Updates {
				seqs = append(seqs, u.Seq)
			}
		case *pb.ServerFrame_SyncDone:
			return snap, seqs, m.SyncDone
		default:
			cl.t.Fatalf("%s: unexpected frame during sync: %v", cl.name, f)
		}
	}
}

func seqRange(from, to uint64) []uint64 {
	var out []uint64
	for i := from; i <= to; i++ {
		out = append(out, i)
	}
	return out
}

var protoUnmarshal = proto.Unmarshal
