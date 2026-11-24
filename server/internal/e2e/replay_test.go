package e2e

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"tezca/server/internal/sigs"
)

// A state-changing signed request is accepted once; the identical request again is refused.
func TestHTTPReplay(t *testing.T) {
	e := newEnv(t, nil)
	admin := newIdent()
	e.claim(admin)

	signed := func(method, path string, body []byte, ts int64) func() (int, map[string]any) {
		auth := fmt.Sprintf("Tezca pk=%s, ts=%d, sig=%s", b64.EncodeToString(admin.pk), ts,
			b64.EncodeToString(admin.sign(sigs.HTTP(method, path, uint64(ts), body))))
		return func() (int, map[string]any) {
			req, _ := http.NewRequest(method, e.srv.URL+path, bytes.NewReader(body))
			req.Header.Set("Authorization", auth)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			defer resp.Body.Close()
			out := map[string]any{}
			data, _ := io.ReadAll(resp.Body)
			json.Unmarshal(data, &out)
			return resp.StatusCode, out
		}
	}

	ts := time.Now().Unix()
	invite := signed("POST", "/api/invites", []byte(`{"role":"member"}`), ts)
	if code, out := invite(); code != 200 {
		t.Fatalf("first: %d %v", code, out)
	}
	if code, out := invite(); code != 409 || out["token"] != nil {
		t.Fatalf("replay: %d %v", code, out)
	}
	// The same request signed with another timestamp is a new request.
	if code, out := signed("POST", "/api/invites", []byte(`{"role":"member"}`), ts-1)(); code != 200 {
		t.Fatalf("re-signed: %d %v", code, out)
	}
	// Reads may repeat.
	list := signed("GET", "/api/invites", nil, ts)
	for i := 0; i < 2; i++ {
		if code, out := list(); code != 200 {
			t.Fatalf("read %d: %d %v", i, code, out)
		}
	}
	// A refused request (bad signature) doesn't use up the real one.
	space := randSpaceID()
	e.dial(admin, "a").createSpace(1, space)
	body := []byte(`{"role":"viewer","keys":[{"epoch":0,"wrapped":"a2V5"}]}`)
	path := "/api/spaces/" + space + "/invites"
	good := signed("POST", path, body, ts)
	req, _ := http.NewRequest("POST", e.srv.URL+path, bytes.NewReader([]byte(`{"role":"editor"}`)))
	req.Header.Set("Authorization", fmt.Sprintf("Tezca pk=%s, ts=%d, sig=%s", b64.EncodeToString(admin.pk), ts,
		b64.EncodeToString(admin.sign(sigs.HTTP("POST", path, uint64(ts), body)))))
	if resp, err := http.DefaultClient.Do(req); err != nil || resp.StatusCode != 401 {
		t.Fatalf("tampered body: %v %v", resp, err)
	}
	if code, out := good(); code != 200 {
		t.Fatalf("share invite: %d %v", code, out)
	}
	if code, out := good(); code != 409 {
		t.Fatalf("share invite replay: %d %v", code, out)
	}
}
