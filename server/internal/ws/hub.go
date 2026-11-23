// Package ws implements the WebSocket session protocol (docs/protocol.md, "WebSocket session").
//
// Ordering model:
//   - Every connection has one bounded outbound queue drained by a single writer goroutine, so
//     frames reach the socket in exactly the order they were enqueued. Enqueueing never blocks:
//     a full queue closes the connection (the client resyncs with since_seq).
//   - Every doc has a mutex. All writes to a doc (persist → Ack → broadcast → DocHeads) and every
//     Subscribe (snapshot → backlog → SyncDone → register) happen while holding it, so per doc
//     every subscriber sees seqs strictly ascending with no gaps or duplicates.
//   - Lock order: doc lock → spaces lock → hub lock. Never the reverse.
package ws

import (
	"context"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"

	"tezca/server/internal/store"
)

// Protocol limits.
const (
	ProtocolVersion  = 1
	MaxUpdate        = 4 << 20
	MaxSnapshot      = 16 << 20
	MaxAwareness     = 64 << 10
	MaxMeta          = 64 << 10
	MaxWrappedKey    = 4 << 10
	ReadLimit        = 17 << 20
	BatchMaxUpdates  = 256
	BatchMaxBytes    = 1 << 20
	DefaultQueueSize = 1024
)

// Config configures a Hub.
type Config struct {
	Store        *store.Store
	ServerID     string
	Logger       *slog.Logger
	IdleTimeout  time.Duration // default 90s
	AuthTimeout  time.Duration // default 30s
	WriteTimeout time.Duration // default 30s
	QueueSize    int           // default 1024 frames
	Now          func() time.Time
}

type docKey struct{ space, doc string }

type docState struct {
	mu   sync.Mutex
	refs int // in-flight operations + registered subscribers; guarded by Hub.mu
	subs map[*conn]struct{}
}

// Hub owns all live sessions, doc subscriptions and space feeds.
type Hub struct {
	cfg Config
	log *slog.Logger

	mu    sync.Mutex // guards docs, conns, closed
	docs  map[docKey]*docState
	conns map[*conn]struct{}
	shut  bool

	spacesMu sync.Mutex // guards spaces
	spaces   map[string]map[*conn]struct{}
}

// NewHub returns a Hub.
func NewHub(cfg Config) *Hub {
	if cfg.IdleTimeout == 0 {
		cfg.IdleTimeout = 90 * time.Second
	}
	if cfg.AuthTimeout == 0 {
		cfg.AuthTimeout = 30 * time.Second
	}
	if cfg.WriteTimeout == 0 {
		cfg.WriteTimeout = 30 * time.Second
	}
	if cfg.QueueSize == 0 {
		cfg.QueueSize = DefaultQueueSize
	}
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	return &Hub{
		cfg:    cfg,
		log:    cfg.Logger,
		docs:   map[docKey]*docState{},
		conns:  map[*conn]struct{}{},
		spaces: map[string]map[*conn]struct{}{},
	}
}

// ServeHTTP upgrades the request to a WebSocket session.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Auth is by Ed25519 signature, not cookies, and Obsidian clients send app:// or
		// capacitor:// origins, so origin checks add nothing.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(ReadLimit)
	c := newConn(h, ws)
	h.mu.Lock()
	if h.shut {
		h.mu.Unlock()
		ws.Close(websocket.StatusGoingAway, "server shutting down")
		return
	}
	h.conns[c] = struct{}{}
	h.mu.Unlock()
	defer func() {
		h.mu.Lock()
		delete(h.conns, c)
		h.mu.Unlock()
	}()
	c.serve(r.Context())
}

// Close terminates every session (used on shutdown).
func (h *Hub) Close() {
	h.mu.Lock()
	h.shut = true
	cs := make([]*conn, 0, len(h.conns))
	for c := range h.conns {
		cs = append(cs, c)
	}
	h.mu.Unlock()
	for _, c := range cs {
		c.kill(websocket.StatusGoingAway, "server shutting down")
	}
}

// withDoc runs fn while holding the doc's lock.
func (h *Hub) withDoc(space, doc string, fn func(ds *docState)) {
	k := docKey{space, doc}
	h.mu.Lock()
	ds := h.docs[k]
	if ds == nil {
		ds = &docState{subs: map[*conn]struct{}{}}
		h.docs[k] = ds
	}
	ds.refs++
	h.mu.Unlock()

	ds.mu.Lock()
	fn(ds)
	ds.mu.Unlock()

	h.mu.Lock()
	ds.refs--
	if ds.refs == 0 {
		delete(h.docs, k)
	}
	h.mu.Unlock()
}

// addSub / removeSub must be called with ds.mu held.
func (h *Hub) addSub(ds *docState, c *conn) {
	if _, ok := ds.subs[c]; ok {
		return
	}
	ds.subs[c] = struct{}{}
	h.mu.Lock()
	ds.refs++
	h.mu.Unlock()
}

func (h *Hub) removeSub(ds *docState, c *conn) {
	if _, ok := ds.subs[c]; !ok {
		return
	}
	delete(ds.subs, c)
	h.mu.Lock()
	ds.refs-- // never reaches 0 here: withDoc still holds a ref
	h.mu.Unlock()
}

// broadcastHeads sends a raw DocHeads frame to every subscriber of space. Called under the doc
// lock so per-doc heads are delivered in order.
func (h *Hub) broadcastHeads(space string, frame []byte) {
	h.spacesMu.Lock()
	defer h.spacesMu.Unlock()
	for c := range h.spaces[space] {
		c.sendRaw(frame)
	}
}

// subscribeSpace registers c for a space's feed and enqueues the full DocHeads atomically with
// respect to incremental heads.
func (h *Hub) subscribeSpace(ctx context.Context, c *conn, space string) error {
	h.spacesMu.Lock()
	defer h.spacesMu.Unlock()
	heads, err := h.cfg.Store.DocHeads(ctx, space)
	if err != nil {
		return err
	}
	set := h.spaces[space]
	if set == nil {
		set = map[*conn]struct{}{}
		h.spaces[space] = set
	}
	set[c] = struct{}{}
	c.send(fullHeads(space, heads))
	return nil
}

func (h *Hub) unsubscribeSpace(c *conn, space string) {
	h.spacesMu.Lock()
	defer h.spacesMu.Unlock()
	if set := h.spaces[space]; set != nil {
		delete(set, c)
		if len(set) == 0 {
			delete(h.spaces, space)
		}
	}
}

// Stats is a snapshot of hub sizes, for tests.
func (h *Hub) Stats() (conns, docs, spaces int) {
	h.mu.Lock()
	conns, docs = len(h.conns), len(h.docs)
	h.mu.Unlock()
	h.spacesMu.Lock()
	spaces = len(h.spaces)
	h.spacesMu.Unlock()
	return
}
