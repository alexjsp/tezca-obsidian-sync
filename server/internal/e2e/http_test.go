package e2e

import (
	"bytes"
	"io"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"

	"tezca/server/internal/sigs"
)

func get(t *testing.T, url string) (int, string, http.Header) {
	t.Helper()
	resp, err := http.Get(url)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(b), resp.Header
}

func TestPagesAndClaim(t *testing.T) {
	e := newEnv(t, nil)
	if code, body, _ := get(t, e.srv.URL+"/healthz"); code != 200 || body != "ok" {
		t.Fatalf("healthz: %d %q", code, body)
	}
	code, info := e.call("GET", "/api/info", nil, nil, 0)
	if code != 200 || info["claimed"] != false || info["server_id"] != e.serverID || info["protocol_version"] != float64(1) || info["name"] != "Test" {
		t.Fatalf("info: %v", info)
	}
	if code, body, _ := get(t, e.srv.URL+"/"); code != 200 || !strings.Contains(body, "docker compose logs") {
		t.Fatalf("landing: %d", code)
	}
	if code, _, _ := get(t, e.srv.URL+"/claim?code=wrong"); code != 404 {
		t.Fatalf("claim wrong code: %d", code)
	}
	code, body, _ := get(t, e.srv.URL+"/claim?code="+claimCode)
	wantLink := "obsidian://tezca?do=claim&amp;host=" + strings.ReplaceAll(strings.ReplaceAll(e.srv.URL, ":", "%3A"), "/", "%2F") + "&amp;code=" + claimCode
	if code != 200 || !strings.Contains(body, wantLink) || !strings.Contains(body, "/claim/qr.png?code=") {
		t.Fatalf("claim page: %d\n%s\nwant %s", code, body, wantLink)
	}
	code, png, hdr := get(t, e.srv.URL+"/claim/qr.png?code="+claimCode)
	if code != 200 || hdr.Get("Content-Type") != "image/png" || !strings.HasPrefix(png, "\x89PNG") {
		t.Fatalf("qr: %d %s", code, hdr.Get("Content-Type"))
	}

	admin := newIdent()
	// Bad signature, then wrong code.
	if code, _ := e.call("POST", "/api/claim", map[string]string{
		"code": claimCode, "sign_pk": b64.EncodeToString(admin.pk), "box_pk": b64.EncodeToString(admin.box),
		"sig": b64.EncodeToString(make([]byte, 64)),
	}, nil, 0); code != 401 {
		t.Fatalf("bad sig claim: %d", code)
	}
	e.claim(admin)
	other := newIdent()
	if code, _ := e.call("POST", "/api/claim", map[string]string{
		"code": claimCode, "sign_pk": b64.EncodeToString(other.pk), "box_pk": b64.EncodeToString(other.box),
		"sig": b64.EncodeToString(other.sign([]byte("x"))),
	}, nil, 0); code != 401 && code != 409 {
		t.Fatalf("second claim: %d", code)
	}
	if code, _, _ := get(t, e.srv.URL+"/claim?code="+claimCode); code != 404 {
		t.Fatalf("claim page after claim: %d", code)
	}
	if code, _, _ := get(t, e.srv.URL+"/claim/qr.png?code="+claimCode); code != 404 {
		t.Fatalf("qr after claim: %d", code)
	}
	if _, info := e.call("GET", "/api/info", nil, nil, 0); info["claimed"] != true {
		t.Fatalf("info after claim: %v", info)
	}
	if code, body, _ := get(t, e.srv.URL+"/"); code != 200 || strings.Contains(body, "docker compose logs") {
		t.Fatalf("landing after claim: %d", code)
	}
}

func TestCORS(t *testing.T) {
	e := newEnv(t, nil)
	req, _ := http.NewRequest("OPTIONS", e.srv.URL+"/api/invites", nil)
	req.Header.Set("Origin", "app://obsidian.md")
	req.Header.Set("Access-Control-Request-Method", "POST")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 204 || resp.Header.Get("Access-Control-Allow-Origin") != "*" ||
		!strings.Contains(resp.Header.Get("Access-Control-Allow-Headers"), "Authorization") {
		t.Fatalf("preflight: %d %v", resp.StatusCode, resp.Header)
	}
	_, _, hdr := get(t, e.srv.URL+"/api/info")
	if hdr.Get("Access-Control-Allow-Origin") != "*" {
		t.Fatal("no CORS header on /api/info")
	}
}

func TestHTTPSigAuth(t *testing.T) {
	e := newEnv(t, nil)
	admin := newIdent()
	e.claim(admin)

	if code, _ := e.call("GET", "/api/invites", nil, nil, 0); code != 401 {
		t.Fatalf("no auth: %d", code)
	}
	if code, _ := e.call("GET", "/api/invites", nil, admin, 0); code != 200 {
		t.Fatalf("valid auth: %d", code)
	}
	if code, _ := e.call("GET", "/api/invites", nil, admin, 250*time.Second); code != 200 {
		t.Fatalf("within skew: %d", code)
	}
	for _, skew := range []time.Duration{-301 * time.Second, 301 * time.Second} {
		if code, out := e.call("GET", "/api/invites", nil, admin, skew); code != 401 || !strings.Contains(out["error"].(string), "skew") {
			t.Fatalf("skew %v: %d %v", skew, code, out)
		}
	}
	// Unknown key with a valid signature.
	if code, _ := e.call("GET", "/api/invites", nil, newIdent(), 0); code != 401 {
		t.Fatalf("unknown user: %d", code)
	}
	// Signature over a different path / body must fail.
	ts := time.Now().Unix()
	sigFor := func(method, path string, body []byte) string {
		return "Tezca pk=" + b64.EncodeToString(admin.pk) + ", ts=" + itoa(ts) + ", sig=" + b64.EncodeToString(admin.sign(sigInputHTTP(method, path, ts, body)))
	}
	body := []byte(`{"role":"member"}`)
	for name, auth := range map[string]string{
		"wrong path":   sigFor("POST", "/api/invites?x=1", body),
		"wrong body":   sigFor("POST", "/api/invites", []byte(`{"role":"guest"}`)),
		"wrong method": sigFor("GET", "/api/invites", body),
	} {
		req, _ := http.NewRequest("POST", e.srv.URL+"/api/invites", bytes.NewReader(body))
		req.Header.Set("Authorization", auth)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != 401 {
			t.Fatalf("%s: %d", name, resp.StatusCode)
		}
	}
	// Query string is part of the signed path_with_query.
	if code, _ := e.call("GET", "/api/invites?verbose=1", nil, admin, 0); code != 200 {
		t.Fatalf("query string: %d", code)
	}
	// Non-admins can't manage invites.
	member := e.join(admin, "member")
	if code, _ := e.call("POST", "/api/invites", map[string]any{}, member, 0); code != 403 {
		t.Fatalf("member invite: %d", code)
	}
}

func TestInvitesRedeem(t *testing.T) {
	e := newEnv(t, nil)
	admin := newIdent()
	e.claim(admin)

	code, out := e.call("POST", "/api/invites", map[string]any{"role": "member", "ttl_seconds": 3600}, admin, 0)
	if code != 200 {
		t.Fatalf("invite: %d %v", code, out)
	}
	tok := out["token"].(string)
	link := out["link"].(string)
	if !strings.HasPrefix(link, "obsidian://tezca?do=join&host=") || !strings.HasSuffix(link, "&token="+tok) {
		t.Fatalf("link: %s", link)
	}
	if exp := int64(out["expires_at"].(float64)); exp < time.Now().Unix()+3500 || exp > time.Now().Unix()+3700 {
		t.Fatalf("expires_at: %d", exp)
	}
	if code, _ := e.call("POST", "/api/invites", map[string]any{"role": "admin"}, admin, 0); code != 400 {
		t.Fatalf("admin role invite: %d", code)
	}

	alice := newIdent()
	// Bad signature.
	if code, _ := e.call("POST", "/api/redeem", map[string]string{
		"token": tok, "sign_pk": b64.EncodeToString(alice.pk), "box_pk": b64.EncodeToString(alice.box),
		"sig": b64.EncodeToString(alice.sign([]byte("nope"))),
	}, nil, 0); code != 401 {
		t.Fatalf("bad sig redeem: %d", code)
	}
	if code, out := e.redeem(alice, tok); code != 200 || out["role"] != "member" || out["server_id"] != e.serverID {
		t.Fatalf("redeem: %d %v", code, out)
	}
	if code, out := e.redeem(alice, tok); code != 200 || out["role"] != "member" {
		t.Fatalf("idempotent redeem: %d %v", code, out)
	}
	if code, _ := e.redeem(newIdent(), tok); code != 409 {
		t.Fatalf("second user redeem: %d", code)
	}
	if code, _ := e.redeem(newIdent(), "missing"); code != 404 {
		t.Fatalf("unknown token: %d", code)
	}
	guest := e.join(admin, "guest")
	_ = guest

	code, out = e.call("GET", "/api/invites", nil, admin, 0)
	invs := out["invites"].([]any)
	if code != 200 || len(invs) != 2 {
		t.Fatalf("list: %d %v", code, out)
	}
	var redeemed int
	for _, i := range invs {
		m := i.(map[string]any)
		if strings.Contains(m["token_hint"].(string), tok) {
			t.Fatal("token_hint leaks full token")
		}
		if m["redeemed_by"] != nil {
			redeemed++
		}
	}
	if redeemed != 2 {
		t.Fatalf("redeemed count %d", redeemed)
	}
}

func TestPairingsSingleUse(t *testing.T) {
	e := newEnv(t, nil)
	admin := newIdent()
	e.claim(admin)
	ct := b64.EncodeToString([]byte("opaque ciphertext"))

	if code, _ := e.call("POST", "/api/pairings", map[string]string{"ciphertext": ct}, nil, 0); code != 401 {
		t.Fatalf("unauth pairing: %d", code)
	}
	code, out := e.call("POST", "/api/pairings", map[string]string{"ciphertext": ct}, admin, 0)
	if code != 200 {
		t.Fatalf("create: %d %v", code, out)
	}
	id := out["id"].(string)
	if exp := int64(out["expires_at"].(float64)); exp < time.Now().Unix()+14*60 {
		t.Fatalf("expires_at %d", exp)
	}
	code, out = e.call("GET", "/api/pairings/"+id, nil, nil, 0)
	if code != 200 || out["ciphertext"] != ct {
		t.Fatalf("take: %d %v", code, out)
	}
	if code, _ := e.call("GET", "/api/pairings/"+id, nil, nil, 0); code != 404 {
		t.Fatalf("second take: %d", code)
	}
	big := b64.EncodeToString(make([]byte, 64<<10+1))
	if code, _ := e.call("POST", "/api/pairings", map[string]string{"ciphertext": big}, admin, 0); code != 413 {
		t.Fatalf("oversized: %d", code)
	}
}

func itoa(n int64) string { return strconv.FormatInt(n, 10) }

func sigInputHTTP(method, path string, ts int64, body []byte) []byte {
	return sigs.HTTP(method, path, uint64(ts), body)
}
