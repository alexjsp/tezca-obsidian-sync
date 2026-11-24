package e2e

import (
	"bytes"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"tezca/server/internal/api"
	"tezca/server/internal/clientip"
	"tezca/server/internal/sigs"
)

func TestFailedAttemptLimit(t *testing.T) {
	trusted, err := clientip.Parse("127.0.0.1")
	if err != nil {
		t.Fatal(err)
	}
	e := newEnvAPI(t, nil, func(c *api.Config) {
		c.FailBurst = 3
		c.FailEvery = time.Minute
		c.ClientIP = trusted.IP
	})
	from := func(ip, method, path string, body any) int {
		t.Helper()
		var raw []byte
		if body != nil {
			raw, _ = json.Marshal(body)
		}
		req, _ := http.NewRequest(method, e.srv.URL+path, bytes.NewReader(raw))
		req.Header.Set("X-Forwarded-For", ip)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		return resp.StatusCode
	}
	claimBody := func(id *ident, code string) map[string]string {
		return map[string]string{
			"code": code, "sign_pk": b64.EncodeToString(id.pk), "box_pk": b64.EncodeToString(id.box),
			"sig": b64.EncodeToString(id.sign(sigs.Redeem(e.serverID, code, id.pk, id.box))),
		}
	}
	const attacker, other = "198.51.100.66", "198.51.100.7"

	// Failures across the guarded endpoints share one budget per address.
	if code := from(attacker, "POST", "/api/claim", claimBody(newIdent(), "wrong")); code != 403 {
		t.Fatalf("wrong claim code: %d", code)
	}
	if code := from(attacker, "GET", "/api/pairings/nope", nil); code != 404 {
		t.Fatalf("unknown pairing: %d", code)
	}
	if code := from(attacker, "GET", "/claim?code=wrong", nil); code != 404 {
		t.Fatalf("claim page: %d", code)
	}
	// Out of attempts: refused even with the right code.
	if code := from(attacker, "POST", "/api/claim", claimBody(newIdent(), claimCode)); code != 429 {
		t.Fatalf("after the burst: %d", code)
	}
	if code := from(attacker, "POST", "/api/redeem", map[string]string{"token": "x"}); code != 429 {
		t.Fatalf("redeem after the burst: %d", code)
	}
	// Another address is unaffected, and successes don't use up attempts.
	admin := newIdent()
	if code := from(other, "POST", "/api/claim", claimBody(admin, claimCode)); code != 200 {
		t.Fatalf("claim from another address: %d", code)
	}
	tok := e.invite(admin, "member")
	for i := 0; i < 5; i++ {
		if code := from(other, "GET", "/api/info", nil); code != 200 {
			t.Fatalf("unguarded endpoint: %d", code)
		}
	}
	id := newIdent()
	if code := from(other, "POST", "/api/redeem", map[string]string{
		"token": tok, "sign_pk": b64.EncodeToString(id.pk), "box_pk": b64.EncodeToString(id.box),
		"sig": b64.EncodeToString(id.sign(sigs.Redeem(e.serverID, tok, id.pk, id.box))),
	}); code != 200 {
		t.Fatalf("redeem: %d", code)
	}
	// The bucket refills over time.
	e.apiClock.Advance(time.Minute)
	if code := from(attacker, "GET", "/api/pairings/nope", nil); code != 404 {
		t.Fatalf("after refill: %d", code)
	}
	if code := from(attacker, "GET", "/api/pairings/nope", nil); code != 429 {
		t.Fatalf("one attempt per minute: %d", code)
	}
}
