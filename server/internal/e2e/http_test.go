package e2e

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"tezca/server/internal/api"
	"tezca/server/internal/sigs"
	"tezca/server/internal/store"
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
		!strings.Contains(resp.Header.Get("Access-Control-Allow-Headers"), "Authorization") ||
		resp.Header.Get("Access-Control-Allow-Methods") != "GET, POST, PUT, DELETE, HEAD, OPTIONS" {
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
	// The invite page on this host, with the deep link's parameters in the fragment.
	wantLink := e.srv.URL + "/invite#do=join&host=" + url.QueryEscape(e.srv.URL) + "&token=" + tok
	if link != wantLink {
		t.Fatalf("link: %s\nwant %s", link, wantLink)
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

func randBlobID() string {
	b := make([]byte, 32)
	rand.Read(b)
	return b64.EncodeToString(b)
}

func TestBlobs(t *testing.T) {
	e := newEnv(t, nil)
	admin := newIdent()
	e.claim(admin)
	space := randSpaceID()
	e.dial(admin, "a").createSpace(1, space)
	editor, viewer, outsider := e.join(admin, "member"), e.join(admin, "guest"), e.join(admin, "member")
	ctx := context.Background()
	if err := e.st.AddMember(ctx, space, editor.pk, store.SpaceEditor, []byte("w")); err != nil {
		t.Fatal(err)
	}
	if err := e.st.AddMember(ctx, space, viewer.pk, store.SpaceViewer, []byte("w")); err != nil {
		t.Fatal(err)
	}

	if _, info := e.call("GET", "/api/info", nil, nil, 0); info["max_blob_bytes"] != float64(testMaxBlob) {
		t.Fatalf("info: %v", info)
	}

	id := randBlobID()
	path := "/api/spaces/" + space + "/blobs/" + id
	ct := []byte("nonce+ciphertext+tag")
	put := func(who *ident, p string, body []byte) (int, map[string]any) {
		t.Helper()
		code, _, data := e.rawCall("PUT", p, body, who, nil, false)
		out := map[string]any{}
		json.Unmarshal(data, &out)
		return code, out
	}

	// Store, then idempotent re-upload.
	if code, out := put(admin, path, ct); code != 201 || out["size"] != float64(len(ct)) {
		t.Fatalf("put: %d %v", code, out)
	}
	if code, out := put(editor, path, []byte("a different encryption")); code != 200 || out["size"] != float64(len(ct)) {
		t.Fatalf("re-put: %d %v", code, out)
	}
	for _, who := range []*ident{admin, editor, viewer} {
		code, hdr, data := e.rawCall("GET", path, nil, who, nil, false)
		if code != 200 || !bytes.Equal(data, ct) || hdr.Get("Content-Type") != "application/octet-stream" || hdr.Get("Content-Length") != itoa(int64(len(ct))) {
			t.Fatalf("get: %d %q %v", code, data, hdr)
		}
		code, hdr, data = e.rawCall("HEAD", path, nil, who, nil, false)
		if code != 200 || len(data) != 0 || hdr.Get("Content-Length") != itoa(int64(len(ct))) {
			t.Fatalf("head: %d %v", code, hdr)
		}
	}

	// Roles and auth.
	if code, _ := put(viewer, "/api/spaces/"+space+"/blobs/"+randBlobID(), ct); code != 403 {
		t.Fatalf("viewer put: %d", code)
	}
	if code, out := put(editor, "/api/spaces/"+space+"/blobs/"+randBlobID(), ct); code != 201 {
		t.Fatalf("editor put: %d %v", code, out)
	}
	for _, m := range []string{"GET", "HEAD", "PUT"} {
		if code, _, _ := e.rawCall(m, path, ct, outsider, nil, false); code != 403 {
			t.Fatalf("outsider %s: %d", m, code)
		}
		if code, _, _ := e.rawCall(m, path, ct, nil, nil, false); code != 401 {
			t.Fatalf("unsigned %s: %d", m, code)
		}
		if code, _, _ := e.rawCall(m, path, ct, newIdent(), nil, false); code != 401 {
			t.Fatalf("unknown user %s: %d", m, code)
		}
	}
	// The signature covers the body: a mismatched one is rejected and nothing is stored,
	// whether or not the blob already exists.
	fresh := "/api/spaces/" + space + "/blobs/" + randBlobID()
	if code, _, _ := e.rawCall("PUT", fresh, ct, admin, []byte("other"), false); code != 401 {
		t.Fatalf("bad body sig: %d", code)
	}
	if code, _, _ := e.rawCall("HEAD", fresh, nil, admin, nil, false); code != 404 {
		t.Fatalf("blob stored despite bad sig: %d", code)
	}
	if code, _, _ := e.rawCall("PUT", path, ct, admin, []byte("other"), false); code != 401 {
		t.Fatalf("bad body sig on existing blob: %d", code)
	}
	// Unknown blob, bad ids.
	for _, m := range []string{"GET", "HEAD"} {
		if code, _, _ := e.rawCall(m, fresh, nil, viewer, nil, false); code != 404 {
			t.Fatalf("%s unknown: %d", m, code)
		}
	}
	for _, p := range []string{
		"/api/spaces/short/blobs/" + id,
		"/api/spaces/" + space + "/blobs/" + id[:42],
		"/api/spaces/" + space + "/blobs/" + id[:42] + "=",
		"/api/spaces/" + space + "/blobs/" + strings.Repeat("~", 43),
	} {
		if code, _, _ := e.rawCall("PUT", p, ct, admin, nil, false); code != 400 {
			t.Fatalf("bad id %s: %d", p, code)
		}
		if code, _, _ := e.rawCall("GET", p, nil, admin, nil, false); code != 400 {
			t.Fatalf("bad id GET %s: %d", p, code)
		}
	}

	// Size limit: max_blob_bytes + 40 is the largest accepted ciphertext, by Content-Length
	// or streamed without one.
	maxCT := make([]byte, testMaxBlob+api.BlobOverhead)
	rand.Read(maxCT)
	if code, out := put(admin, "/api/spaces/"+space+"/blobs/"+randBlobID(), maxCT); code != 201 || out["size"] != float64(len(maxCT)) {
		t.Fatalf("max size: %d %v", code, out)
	}
	tooBig := append(maxCT, 0)
	for _, chunked := range []bool{false, true} {
		p := "/api/spaces/" + space + "/blobs/" + randBlobID()
		code, _, data := e.rawCall("PUT", p, tooBig, admin, nil, chunked)
		if code != 413 {
			t.Fatalf("too big (chunked=%v): %d %s", chunked, code, data)
		}
		if code, _, _ := e.rawCall("HEAD", p, nil, admin, nil, false); code != 404 {
			t.Fatalf("too-big blob stored (chunked=%v): %d", chunked, code)
		}
	}
	// A chunked upload within the limit is fine.
	if code, _, _ := e.rawCall("PUT", "/api/spaces/"+space+"/blobs/"+randBlobID(), ct, admin, nil, true); code != 201 {
		t.Fatalf("chunked put: %d", code)
	}

	// If the bytes went missing from the blob store, a re-upload restores them.
	if err := os.Remove(filepath.Join(e.blobDir, space, id[:2], id)); err != nil {
		t.Fatal(err)
	}
	if code, _, _ := e.rawCall("GET", path, nil, admin, nil, false); code != 404 {
		t.Fatalf("get missing bytes: %d", code)
	}
	if code, out := put(admin, path, ct); code != 200 {
		t.Fatalf("restore: %d %v", code, out)
	}
	if code, _, data := e.rawCall("GET", path, nil, admin, nil, false); code != 200 || !bytes.Equal(data, ct) {
		t.Fatalf("get restored: %d", code)
	}

	// JSON endpoints keep their small body limit.
	big := b64.EncodeToString(make([]byte, api.MaxBody))
	if code, _ := e.call("POST", "/api/pairings", map[string]string{"ciphertext": big}, admin, 0); code != 413 {
		t.Fatalf("JSON body limit: %d", code)
	}
}
