package ws

import (
	"context"
	"crypto/rand"
	"encoding/base64"
	"errors"
	"sync"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"tezca/server/internal/pb"
	"tezca/server/internal/sigs"
	"tezca/server/internal/store"
)

// StatusSlowConsumer is the close code used when a connection's outbound queue overflows.
const StatusSlowConsumer websocket.StatusCode = 4008

type outItem struct {
	b      []byte
	close  bool
	code   websocket.StatusCode
	reason string
}

type conn struct {
	h  *Hub
	ws *websocket.Conn

	out      chan outItem
	dead     chan struct{}
	killOnce sync.Once
	closing  bool // set by reader goroutine after enqueueing a final error

	// Set once authenticated; read-only afterwards.
	user     store.User
	deviceID string

	// Touched only by the reader goroutine.
	docSubs   map[docKey]struct{}
	spaceSubs map[string]struct{}
}

func newConn(h *Hub, ws *websocket.Conn) *conn {
	return &conn{
		h:         h,
		ws:        ws,
		out:       make(chan outItem, h.cfg.QueueSize),
		dead:      make(chan struct{}),
		docSubs:   map[docKey]struct{}{},
		spaceSubs: map[string]struct{}{},
	}
}

// kill closes the connection immediately (idempotent, safe from any goroutine).
func (c *conn) kill(code websocket.StatusCode, reason string) {
	c.killOnce.Do(func() {
		close(c.dead)
		go c.ws.Close(code, reason)
	})
}

// sendRaw enqueues an encoded ServerFrame. It never blocks: if the queue is full the
// connection is closed so that no frame is ever silently dropped.
func (c *conn) sendRaw(b []byte) {
	select {
	case <-c.dead:
		return
	default:
	}
	select {
	case c.out <- outItem{b: b}:
	default:
		c.h.log.Warn("closing slow consumer", "pk", b64(c.user.SignPk), "device", c.deviceID)
		c.kill(StatusSlowConsumer, "outbound queue overflow")
	}
}

func (c *conn) send(f *pb.ServerFrame) {
	b, err := proto.Marshal(f)
	if err != nil {
		c.h.log.Error("marshal", "err", err)
		return
	}
	c.sendRaw(b)
}

// sendFinal enqueues f, then closes the connection once it has been written.
func (c *conn) sendFinal(f *pb.ServerFrame, code websocket.StatusCode, reason string) {
	c.send(f)
	c.closing = true
	select {
	case c.out <- outItem{close: true, code: code, reason: reason}:
	default:
		c.kill(code, reason)
	}
}

func (c *conn) writer() {
	for {
		select {
		case <-c.dead:
			return
		case it := <-c.out:
			if it.close {
				c.kill(it.code, it.reason)
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), c.h.cfg.WriteTimeout)
			err := c.ws.Write(ctx, websocket.MessageBinary, it.b)
			cancel()
			if err != nil {
				c.kill(websocket.StatusInternalError, "write failed")
				return
			}
		}
	}
}

func (c *conn) read(ctx context.Context, timeout time.Duration) (*pb.ClientFrame, error) {
	rctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	typ, data, err := c.ws.Read(rctx)
	if err != nil {
		return nil, err
	}
	if typ != websocket.MessageBinary {
		return nil, errBadFrame
	}
	f := &pb.ClientFrame{}
	if err := proto.Unmarshal(data, f); err != nil {
		return nil, errBadFrame
	}
	return f, nil
}

var errBadFrame = errors.New("bad frame")

func (c *conn) serve(reqCtx context.Context) {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-c.dead:
		case <-reqCtx.Done():
		}
		cancel()
	}()
	go c.writer()
	defer c.cleanup()
	defer c.kill(websocket.StatusNormalClosure, "")

	if !c.handshake(ctx) {
		// Give the writer a moment to flush the final error before the deferred kill.
		select {
		case <-c.dead:
		case <-time.After(2 * time.Second):
		}
		return
	}
	for !c.closing {
		f, err := c.read(ctx, c.h.cfg.IdleTimeout)
		if errors.Is(err, errBadFrame) {
			c.send(errFrame(0, pb.ErrorCode_ERROR_CODE_BAD_REQUEST, "malformed frame", "", ""))
			continue
		}
		if err != nil {
			return
		}
		c.dispatch(ctx, f)
	}
	select {
	case <-c.dead:
	case <-time.After(2 * time.Second):
	}
}

func (c *conn) handshake(ctx context.Context) bool {
	nonce := make([]byte, 32)
	rand.Read(nonce)
	c.send(&pb.ServerFrame{Msg: &pb.ServerFrame_Challenge{Challenge: &pb.Challenge{
		Nonce: nonce, ServerId: c.h.cfg.ServerID, ProtocolVersion: ProtocolVersion,
	}}})
	deadline := time.Now().Add(c.h.cfg.AuthTimeout)
	unauth := func(msg string) bool {
		c.sendFinal(errFrame(0, pb.ErrorCode_ERROR_CODE_UNAUTHORIZED, msg, "", ""), websocket.StatusPolicyViolation, "unauthorized")
		return false
	}

	f, err := c.read(ctx, time.Until(deadline))
	if err != nil {
		if errors.Is(err, errBadFrame) {
			return unauth("expected Hello")
		}
		return false
	}
	hello := f.GetHello()
	if hello == nil {
		return unauth("expected Hello")
	}
	if hello.ProtocolVersion != ProtocolVersion {
		c.sendFinal(errFrame(0, pb.ErrorCode_ERROR_CODE_UPDATE_REQUIRED, "protocol version mismatch", "", ""),
			websocket.StatusPolicyViolation, "update required")
		return false
	}
	f, err = c.read(ctx, time.Until(deadline))
	if err != nil {
		if errors.Is(err, errBadFrame) {
			return unauth("expected Auth")
		}
		return false
	}
	auth := f.GetAuth()
	if auth == nil {
		return unauth("expected Auth")
	}
	if len(hello.SignPk) != 32 {
		return unauth("bad sign_pk")
	}
	user, err := c.h.cfg.Store.GetUser(ctx, hello.SignPk)
	if err != nil {
		return unauth("unknown user")
	}
	if !sigs.Verify(hello.SignPk, sigs.Auth(c.h.cfg.ServerID, nonce, hello.SignPk, hello.DeviceId), auth.Sig) {
		return unauth("bad signature")
	}
	c.user = user
	c.deviceID = hello.DeviceId
	c.h.registerUser(c) // before AuthOk, so a client that has seen AuthOk gets SpaceChanged
	c.send(&pb.ServerFrame{Msg: &pb.ServerFrame_AuthOk{AuthOk: &pb.AuthOk{
		SignPk: user.SignPk, BoxPk: user.BoxPk, Role: pb.HostRole(user.Role),
	}}})
	c.h.log.Debug("session authenticated", "pk", b64(user.SignPk), "device", c.deviceID)
	return true
}

// cleanup removes every subscription held by this connection.
func (c *conn) cleanup() {
	for k := range c.docSubs {
		c.h.withDoc(k.space, k.doc, func(ds *docState) { c.h.removeSub(ds, c) })
	}
	for s := range c.spaceSubs {
		c.h.unsubscribeSpace(c, s)
	}
}

func b64(b []byte) string { return base64.RawURLEncoding.EncodeToString(b) }

func errFrame(rid uint32, code pb.ErrorCode, msg, space, doc string) *pb.ServerFrame {
	return &pb.ServerFrame{Msg: &pb.ServerFrame_Error{Error: &pb.Error{
		Rid: rid, Code: code, Message: msg, SpaceId: space, DocId: doc,
	}}}
}

func fullHeads(space string, docs []store.Doc) *pb.ServerFrame {
	heads := make([]*pb.DocHead, len(docs))
	for i, d := range docs {
		heads[i] = &pb.DocHead{DocId: d.DocID, LatestSeq: d.LatestSeq, SnapshotSeq: d.SnapshotSeq}
	}
	return &pb.ServerFrame{Msg: &pb.ServerFrame_DocHeads{DocHeads: &pb.DocHeads{SpaceId: space, Full: true, Heads: heads}}}
}
