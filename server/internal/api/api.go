// Package api implements the HTTP API and setup pages (docs/protocol.md, "HTTP API").
package api

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	qrcode "github.com/skip2/go-qrcode"

	"tezca/server/internal/blobs"
	"tezca/server/internal/sigs"
	"tezca/server/internal/store"
	"tezca/server/internal/ws"
)

const (
	MaxPairing      = 64 << 10
	MaxBody         = 256 << 10 // JSON request bodies; blob bodies have their own limit
	BlobOverhead    = 40        // nonce(24) + Poly1305 tag(16)
	DefaultMaxBlob  = 100 << 20
	MaxSkew         = 300 // seconds
	PairingTTL      = 15 * time.Minute
	DefaultInvite   = 7 * 24 * time.Hour
	MaxInvite       = 30 * 24 * time.Hour
	MinInvite       = time.Minute
	ProtocolVersion = ws.ProtocolVersion
)

// Config configures the API.
type Config struct {
	Store     *store.Store
	Hub       http.Handler // serves /ws
	ServerID  string
	PublicURL string // optional; otherwise derived from X-Forwarded-Proto / Host
	Name      string
	Logger    *slog.Logger
	Now       func() time.Time

	Blobs        blobs.BlobStore // blob bytes; blob routes are disabled if nil
	MaxBlobBytes int64           // max plaintext blob size (default DefaultMaxBlob)
}

// API is the HTTP handler.
type API struct {
	cfg Config
	log *slog.Logger
	mux *http.ServeMux
}

// New returns the HTTP handler.
func New(cfg Config) *API {
	if cfg.Now == nil {
		cfg.Now = time.Now
	}
	if cfg.Logger == nil {
		cfg.Logger = slog.Default()
	}
	if cfg.MaxBlobBytes <= 0 {
		cfg.MaxBlobBytes = DefaultMaxBlob
	}
	cfg.PublicURL = strings.TrimRight(cfg.PublicURL, "/")
	a := &API{cfg: cfg, log: cfg.Logger, mux: http.NewServeMux()}
	m := a.mux
	m.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) { io.WriteString(w, "ok") })
	m.HandleFunc("GET /api/info", a.info)
	m.HandleFunc("GET /icon.svg", serveIcon)
	m.HandleFunc("GET /favicon.ico", serveIcon)
	m.HandleFunc("GET /apple-touch-icon.png", serveTouchIcon)
	m.HandleFunc("GET /{$}", a.landing)
	m.HandleFunc("GET /claim", a.claimPage)
	m.HandleFunc("GET /claim/qr.png", a.claimQR)
	m.HandleFunc("POST /api/claim", a.claim)
	m.HandleFunc("POST /api/invites", a.createInvite)
	m.HandleFunc("GET /api/invites", a.listInvites)
	m.HandleFunc("POST /api/redeem", a.redeem)
	m.HandleFunc("POST /api/pairings", a.createPairing)
	m.HandleFunc("GET /api/pairings/{id}", a.takePairing)
	if cfg.Blobs != nil {
		m.HandleFunc("PUT /api/spaces/{space_id}/blobs/{blob_id}", a.putBlob)
		m.HandleFunc("GET /api/spaces/{space_id}/blobs/{blob_id}", a.getBlob) // GET patterns also match HEAD
	}
	if cfg.Hub != nil {
		m.Handle("GET /ws", cfg.Hub)
	}
	return a
}

// ServeHTTP adds permissive CORS to /api/* (auth is by signature, never cookies) and answers
// preflight requests, then dispatches.
func (a *API) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if strings.HasPrefix(r.URL.Path, "/api/") {
		h := w.Header()
		h.Set("Access-Control-Allow-Origin", "*")
		h.Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		h.Set("Access-Control-Allow-Methods", "GET, POST, PUT, HEAD, OPTIONS")
		h.Set("Access-Control-Max-Age", "86400")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
	}
	a.mux.ServeHTTP(w, r)
}

// PublicURL returns the configured public URL or one derived from the request.
func (a *API) PublicURL(r *http.Request) string {
	if a.cfg.PublicURL != "" {
		return a.cfg.PublicURL
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	if p := r.Header.Get("X-Forwarded-Proto"); p != "" {
		scheme = strings.ToLower(strings.TrimSpace(strings.Split(p, ",")[0]))
	}
	host := r.Host
	if h := r.Header.Get("X-Forwarded-Host"); h != "" {
		host = strings.TrimSpace(strings.Split(h, ",")[0])
	}
	return scheme + "://" + host
}

// ClaimLink is the obsidian:// deep link that claims the server.
func ClaimLink(publicURL, code string) string {
	return "obsidian://tezca?do=claim&host=" + url.QueryEscape(publicURL) + "&code=" + url.QueryEscape(code)
}

// JoinLink is the obsidian:// deep link for a host invite.
func JoinLink(publicURL, token string) string {
	return "obsidian://tezca?do=join&host=" + url.QueryEscape(publicURL) + "&token=" + url.QueryEscape(token)
}

// ───────────── helpers ─────────────

// B64 is a []byte that (un)marshals as unpadded base64url.
type B64 []byte

func (b B64) MarshalJSON() ([]byte, error) {
	return json.Marshal(base64.RawURLEncoding.EncodeToString(b))
}

func (b *B64) UnmarshalJSON(d []byte) error {
	var s string
	if err := json.Unmarshal(d, &s); err != nil {
		return err
	}
	v, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
	if err != nil {
		return fmt.Errorf("invalid base64url: %w", err)
	}
	*b = v
	return nil
}

type httpError struct {
	status int
	msg    string
}

func (e *httpError) Error() string { return e.msg }

func herr(status int, msg string) error { return &httpError{status, msg} }

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(v)
}

func (a *API) fail(w http.ResponseWriter, err error) {
	var he *httpError
	if errors.As(err, &he) {
		writeJSON(w, he.status, map[string]string{"error": he.msg})
		return
	}
	a.log.Error("http request failed", "err", err)
	writeJSON(w, http.StatusInternalServerError, map[string]string{"error": "internal error"})
}

func readBody(r *http.Request) ([]byte, error) {
	b, err := io.ReadAll(http.MaxBytesReader(nil, r.Body, MaxBody))
	if err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			return nil, herr(http.StatusRequestEntityTooLarge, "body too large")
		}
		return nil, herr(http.StatusBadRequest, "cannot read body")
	}
	return b, nil
}

func decode(body []byte, v any) error {
	if err := json.Unmarshal(body, v); err != nil {
		return herr(http.StatusBadRequest, "invalid JSON: "+err.Error())
	}
	return nil
}

// authHeader is a parsed `Authorization: Tezca pk=…, ts=…, sig=…` header.
type authHeader struct {
	pk, sig []byte
	ts      int64
}

// parseAuth parses the Authorization header and checks the timestamp skew. It doesn't verify
// the signature.
func (a *API) parseAuth(r *http.Request) (authHeader, error) {
	h := r.Header.Get("Authorization")
	scheme, params, ok := strings.Cut(h, " ")
	if !ok || !strings.EqualFold(scheme, "Tezca") {
		return authHeader{}, herr(http.StatusUnauthorized, "missing Tezca authorization")
	}
	var ah authHeader
	var haveTS bool
	for _, p := range strings.Split(params, ",") {
		k, v, ok := strings.Cut(strings.TrimSpace(p), "=")
		if !ok {
			continue
		}
		switch k {
		case "pk":
			ah.pk, _ = base64.RawURLEncoding.DecodeString(v)
		case "sig":
			ah.sig, _ = base64.RawURLEncoding.DecodeString(v)
		case "ts":
			var err error
			ah.ts, err = strconv.ParseInt(v, 10, 64)
			haveTS = err == nil
		}
	}
	if len(ah.pk) != 32 || len(ah.sig) != 64 || !haveTS || ah.ts < 0 {
		return authHeader{}, herr(http.StatusUnauthorized, "malformed authorization")
	}
	now := a.cfg.Now().Unix()
	if ah.ts < now-MaxSkew || ah.ts > now+MaxSkew {
		return authHeader{}, herr(http.StatusUnauthorized, "timestamp outside allowed skew")
	}
	return ah, nil
}

// verify checks the header's signature over the request and the body's SHA-256.
func (ah authHeader) verify(r *http.Request, bodySHA256 []byte) bool {
	return sigs.Verify(ah.pk, sigs.HTTPDigest(r.Method, r.RequestURI, uint64(ah.ts), bodySHA256), ah.sig)
}

// user returns the registered user for the header's key.
func (a *API) user(r *http.Request, ah authHeader) (store.User, error) {
	u, err := a.cfg.Store.GetUser(r.Context(), ah.pk)
	if errors.Is(err, store.ErrNotFound) {
		return store.User{}, herr(http.StatusUnauthorized, "unknown user")
	}
	return u, err
}

// authenticate verifies the `Authorization: Tezca pk=…, ts=…, sig=…` header against the
// request and returns the registered user and the (size-limited) request body.
func (a *API) authenticate(r *http.Request) (store.User, []byte, error) {
	body, err := readBody(r)
	if err != nil {
		return store.User{}, nil, err
	}
	ah, err := a.parseAuth(r)
	if err != nil {
		return store.User{}, nil, err
	}
	sum := sha256.Sum256(body)
	if !ah.verify(r, sum[:]) {
		return store.User{}, nil, herr(http.StatusUnauthorized, "bad signature")
	}
	u, err := a.user(r, ah)
	if err != nil {
		return store.User{}, nil, err
	}
	return u, body, nil
}

func roleName(r int) string {
	switch r {
	case store.HostAdmin:
		return "admin"
	case store.HostMember:
		return "member"
	case store.HostGuest:
		return "guest"
	}
	return "unknown"
}

// ───────────── handlers ─────────────

func (a *API) info(w http.ResponseWriter, r *http.Request) {
	claimed, err := a.cfg.Store.Claimed(r.Context())
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"server_id":        a.cfg.ServerID,
		"protocol_version": ProtocolVersion,
		"claimed":          claimed,
		"name":             a.cfg.Name,
		"max_blob_bytes":   a.cfg.MaxBlobBytes,
	})
}

type redeemReq struct {
	Code   string `json:"code"`
	Token  string `json:"token"`
	SignPk B64    `json:"sign_pk"`
	BoxPk  B64    `json:"box_pk"`
	Sig    B64    `json:"sig"`
}

func (q *redeemReq) check(token string) error {
	if token == "" || len(q.SignPk) != 32 || len(q.BoxPk) != 32 || len(q.Sig) != 64 {
		return herr(http.StatusBadRequest, "missing or malformed fields")
	}
	return nil
}

func (a *API) claim(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		body, err := readBody(r)
		if err != nil {
			return err
		}
		var q redeemReq
		if err := decode(body, &q); err != nil {
			return err
		}
		if err := q.check(q.Code); err != nil {
			return err
		}
		if !sigs.Verify(q.SignPk, sigs.Redeem(a.cfg.ServerID, q.Code, q.SignPk, q.BoxPk), q.Sig) {
			return herr(http.StatusUnauthorized, "bad signature")
		}
		switch err := a.cfg.Store.Claim(r.Context(), q.Code, q.SignPk, q.BoxPk, a.cfg.Now().UnixMilli()); {
		case errors.Is(err, store.ErrClaimed):
			return herr(http.StatusConflict, "server already claimed")
		case errors.Is(err, store.ErrBadCode):
			return herr(http.StatusForbidden, "invalid claim code")
		case err != nil:
			return err
		}
		a.log.Info("server claimed", "admin", base64.RawURLEncoding.EncodeToString(q.SignPk))
		writeJSON(w, http.StatusOK, map[string]any{"server_id": a.cfg.ServerID, "role": "admin"})
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}

func (a *API) redeem(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		body, err := readBody(r)
		if err != nil {
			return err
		}
		var q redeemReq
		if err := decode(body, &q); err != nil {
			return err
		}
		if err := q.check(q.Token); err != nil {
			return err
		}
		if !sigs.Verify(q.SignPk, sigs.Redeem(a.cfg.ServerID, q.Token, q.SignPk, q.BoxPk), q.Sig) {
			return herr(http.StatusUnauthorized, "bad signature")
		}
		role, err := a.cfg.Store.Redeem(r.Context(), q.Token, q.SignPk, q.BoxPk, a.cfg.Now().Unix())
		switch {
		case errors.Is(err, store.ErrNotFound):
			return herr(http.StatusNotFound, "invite not found")
		case errors.Is(err, store.ErrExpired):
			return herr(http.StatusGone, "invite expired")
		case errors.Is(err, store.ErrRedeemed):
			return herr(http.StatusConflict, "invite already redeemed")
		case err != nil:
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"server_id": a.cfg.ServerID, "role": roleName(role)})
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}

func (a *API) createInvite(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		u, body, err := a.authenticate(r)
		if err != nil {
			return err
		}
		if u.Role != store.HostAdmin {
			return herr(http.StatusForbidden, "admin only")
		}
		var q struct {
			Role       string `json:"role"`
			TTLSeconds int64  `json:"ttl_seconds"`
		}
		if len(body) > 0 {
			if err := decode(body, &q); err != nil {
				return err
			}
		}
		role := store.HostMember
		switch q.Role {
		case "", "member":
		case "guest":
			role = store.HostGuest
		default:
			return herr(http.StatusBadRequest, "role must be \"member\" or \"guest\"")
		}
		ttl := DefaultInvite
		if q.TTLSeconds > 0 {
			ttl = min(max(time.Duration(q.TTLSeconds)*time.Second, MinInvite), MaxInvite)
		}
		now := a.cfg.Now()
		exp := now.Add(ttl).Unix()
		tok, err := a.cfg.Store.CreateInvite(r.Context(), role, u.SignPk, now.Unix(), exp)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"token": tok, "expires_at": exp, "link": JoinLink(a.PublicURL(r), tok)})
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}

func (a *API) listInvites(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		u, _, err := a.authenticate(r)
		if err != nil {
			return err
		}
		if u.Role != store.HostAdmin {
			return herr(http.StatusForbidden, "admin only")
		}
		invs, err := a.cfg.Store.ListInvites(r.Context())
		if err != nil {
			return err
		}
		type item struct {
			TokenHint  string `json:"token_hint"`
			Role       string `json:"role"`
			ExpiresAt  int64  `json:"expires_at"`
			RedeemedBy *B64   `json:"redeemed_by"`
		}
		out := make([]item, 0, len(invs))
		for _, i := range invs {
			it := item{TokenHint: i.Token[:min(6, len(i.Token))] + "…", Role: roleName(i.Role), ExpiresAt: i.ExpiresAt}
			if i.RedeemedBy != nil {
				b := B64(i.RedeemedBy)
				it.RedeemedBy = &b
			}
			out = append(out, it)
		}
		writeJSON(w, http.StatusOK, map[string]any{"invites": out})
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}

func (a *API) createPairing(w http.ResponseWriter, r *http.Request) {
	err := func() error {
		u, body, err := a.authenticate(r)
		if err != nil {
			return err
		}
		var q struct {
			Ciphertext B64 `json:"ciphertext"`
		}
		if err := decode(body, &q); err != nil {
			return err
		}
		if len(q.Ciphertext) == 0 {
			return herr(http.StatusBadRequest, "ciphertext required")
		}
		if len(q.Ciphertext) > MaxPairing {
			return herr(http.StatusRequestEntityTooLarge, "ciphertext exceeds 64 KiB")
		}
		exp := a.cfg.Now().Add(PairingTTL).Unix()
		id, err := a.cfg.Store.CreatePairing(r.Context(), u.SignPk, q.Ciphertext, exp)
		if err != nil {
			return err
		}
		writeJSON(w, http.StatusOK, map[string]any{"id": id, "expires_at": exp})
		return nil
	}()
	if err != nil {
		a.fail(w, err)
	}
}

func (a *API) takePairing(w http.ResponseWriter, r *http.Request) {
	ct, err := a.cfg.Store.TakePairing(r.Context(), r.PathValue("id"), a.cfg.Now().Unix())
	if errors.Is(err, store.ErrNotFound) {
		a.fail(w, herr(http.StatusNotFound, "pairing not found"))
		return
	}
	if err != nil {
		a.fail(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ciphertext": B64(ct)})
}

// ───────────── pages ─────────────

// validClaimCode returns the current claim code if code matches it and the server is unclaimed.
func (a *API) validClaimCode(r *http.Request) (string, bool) {
	code := r.URL.Query().Get("code")
	cur, err := a.cfg.Store.ClaimCode(r.Context())
	if err != nil || code == "" || len(code) != len(cur) {
		return "", false
	}
	var v byte
	for i := range code {
		v |= code[i] ^ cur[i]
	}
	return cur, v == 0
}

func (a *API) claimQR(w http.ResponseWriter, r *http.Request) {
	code, ok := a.validClaimCode(r)
	if !ok {
		http.NotFound(w, r)
		return
	}
	png, err := qrcode.Encode(ClaimLink(a.PublicURL(r), code), qrcode.Medium, 320)
	if err != nil {
		a.fail(w, err)
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(png)
}
