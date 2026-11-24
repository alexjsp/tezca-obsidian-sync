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
	"bytes"
	"context"
	"log/slog"
	"net"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
	"google.golang.org/protobuf/proto"

	"tezca/server/internal/pb"
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

// Limits on connections before (and while) they authenticate.
const (
	// PreAuthReadLimit bounds frames until AuthOk: Hello and Auth are well under 1 KiB.
	PreAuthReadLimit = 4 << 10
	MaxDeviceID      = 64 // bytes
	// Defaults for TEZCA_MAX_CONNS and TEZCA_MAX_CONNS_PER_IP.
	DefaultMaxConns      = 1000
	DefaultMaxConnsPerIP = 50
)

// Config configures a Hub.
type Config struct {
	Store        *store.Store
	ServerID     string
	Logger       *slog.Logger
	IdleTimeout  time.Duration // default 90s
	AuthTimeout  time.Duration // default 10s
	WriteTimeout time.Duration // default 30s
	QueueSize    int           // default 1024 frames
	Now          func() time.Time
	// MaxConns and MaxConnsPerIP cap concurrent WebSocket connections, authenticated or not,
	// in total and per client address (ClientIP). 0 = unlimited.
	MaxConns      int
	MaxConnsPerIP int
	// ClientIP returns a request's client address (default: the TCP peer's).
	ClientIP func(*http.Request) string
	// GuestQuotaBytes caps what each guest stores on the host: blobs plus the updates and
	// snapshots they author (store.UserBytes). 0 = unlimited.
	GuestQuotaBytes int64
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

	mu    sync.Mutex // guards docs, conns, users, shut
	docs  map[docKey]*docState
	conns map[*conn]struct{}
	users map[string]map[*conn]struct{} // authenticated conns by sign_pk
	shut  bool

	slotsMu sync.Mutex // guards open, perIP
	open    int
	perIP   map[string]int

	spacesMu sync.Mutex // guards spaces
	spaces   map[string]map[*conn]struct{}
}

// NewHub returns a Hub.
func NewHub(cfg Config) *Hub {
	if cfg.IdleTimeout == 0 {
		cfg.IdleTimeout = 90 * time.Second
	}
	if cfg.AuthTimeout == 0 {
		cfg.AuthTimeout = 10 * time.Second
	}
	if cfg.ClientIP == nil {
		cfg.ClientIP = func(r *http.Request) string {
			host, _, err := net.SplitHostPort(r.RemoteAddr)
			if err != nil {
				return r.RemoteAddr
			}
			return host
		}
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
		users:  map[string]map[*conn]struct{}{},
		spaces: map[string]map[*conn]struct{}{},
		perIP:  map[string]int{},
	}
}

// acquire takes a connection slot for ip, or returns the HTTP status to refuse with.
func (h *Hub) acquire(ip string) (ok bool, status int) {
	h.slotsMu.Lock()
	defer h.slotsMu.Unlock()
	if h.cfg.MaxConns > 0 && h.open >= h.cfg.MaxConns {
		return false, http.StatusServiceUnavailable
	}
	if h.cfg.MaxConnsPerIP > 0 && h.perIP[ip] >= h.cfg.MaxConnsPerIP {
		return false, http.StatusTooManyRequests
	}
	h.open++
	h.perIP[ip]++
	return true, 0
}

func (h *Hub) release(ip string) {
	h.slotsMu.Lock()
	defer h.slotsMu.Unlock()
	h.open--
	if h.perIP[ip]--; h.perIP[ip] <= 0 {
		delete(h.perIP, ip)
	}
}

// ServeHTTP upgrades the request to a WebSocket session.
func (h *Hub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	ip := h.cfg.ClientIP(r)
	ok, status := h.acquire(ip)
	if !ok {
		h.log.Debug("refusing WebSocket connection", "ip", ip, "status", status)
		w.Header().Set("Retry-After", "10")
		http.Error(w, "too many connections", status)
		return
	}
	defer h.release(ip)
	ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// Auth is by Ed25519 signature, not cookies, and Obsidian clients send app:// or
		// capacitor:// origins, so origin checks add nothing.
		InsecureSkipVerify: true,
		CompressionMode:    websocket.CompressionDisabled,
	})
	if err != nil {
		return
	}
	ws.SetReadLimit(PreAuthReadLimit) // raised to ReadLimit after AuthOk
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
		if set := h.users[string(c.user.SignPk)]; set != nil {
			delete(set, c)
			if len(set) == 0 {
				delete(h.users, string(c.user.SignPk))
			}
		}
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

// registerUser indexes an authenticated connection by its user (for SpaceChanged).
func (h *Hub) registerUser(c *conn) {
	h.mu.Lock()
	defer h.mu.Unlock()
	k := string(c.user.SignPk)
	set := h.users[k]
	if set == nil {
		set = map[*conn]struct{}{}
		h.users[k] = set
	}
	set[c] = struct{}{}
}

// SpaceChanged pushes SpaceChanged{space} to every connected session of each user in signPks.
func (h *Hub) SpaceChanged(space string, signPks [][]byte) {
	b, _ := proto.Marshal(&pb.ServerFrame{Msg: &pb.ServerFrame_SpaceChanged{SpaceChanged: &pb.SpaceChanged{SpaceId: space}}})
	h.mu.Lock()
	defer h.mu.Unlock()
	seen := map[string]bool{}
	for _, pk := range signPks {
		if seen[string(pk)] {
			continue
		}
		seen[string(pk)] = true
		for c := range h.users[string(pk)] {
			c.sendRaw(b)
		}
	}
}

// EvictMember ends every live subscription signPk's sessions hold on space's doc-heads feed
// and on its docs. Call it after the membership row is gone: subscribe re-checks membership
// under the same locks, so no subscription can be registered after this returns.
//
// The connections' own docSubs/spaceSubs sets (reader-goroutine only) keep stale entries;
// that's harmless because removeSub and unsubscribeSpace are idempotent.
func (h *Hub) EvictMember(space string, signPk []byte) {
	h.mu.Lock()
	var keys []docKey
	for k := range h.docs {
		if k.space == space {
			keys = append(keys, k)
		}
	}
	h.mu.Unlock()
	for _, k := range keys {
		h.withDoc(k.space, k.doc, func(ds *docState) {
			for c := range ds.subs {
				if bytes.Equal(c.user.SignPk, signPk) {
					h.removeSub(ds, c)
				}
			}
		})
	}
	h.spacesMu.Lock()
	defer h.spacesMu.Unlock()
	if set := h.spaces[space]; set != nil {
		for c := range set {
			if bytes.Equal(c.user.SignPk, signPk) {
				delete(set, c)
			}
		}
		if len(set) == 0 {
			delete(h.spaces, space)
		}
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

// subscribeSpace checks membership, registers c for a space's feed and enqueues the full
// DocHeads, atomically with respect to incremental heads and to EvictMember.
func (h *Hub) subscribeSpace(ctx context.Context, c *conn, space string) error {
	h.spacesMu.Lock()
	defer h.spacesMu.Unlock()
	if _, _, err := c.membership(ctx, space); err != nil {
		return err
	}
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
