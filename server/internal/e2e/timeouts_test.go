package e2e

import (
	"bufio"
	"bytes"
	"fmt"
	"net"
	"net/http"
	"strings"
	"testing"
	"time"

	"tezca/server/internal/api"
	"tezca/server/internal/sigs"
)

// slowRequest writes head, then the chunks of body with gap between them, and returns the
// response status (0 if the server closed the connection without answering) and how long after
// the start it arrived. It stops sending once a response has arrived.
func (e *env) slowRequest(head string, body [][]byte, gap time.Duration) (int, time.Duration) {
	e.t.Helper()
	conn, err := net.Dial("tcp", strings.TrimPrefix(e.srv.URL, "http://"))
	if err != nil {
		e.t.Fatal(err)
	}
	defer conn.Close()
	start := time.Now()
	type result struct {
		status int
		at     time.Duration
	}
	got := make(chan result, 1)
	go func() {
		conn.SetReadDeadline(time.Now().Add(30 * time.Second))
		resp, err := http.ReadResponse(bufio.NewReader(conn), nil)
		if err != nil {
			got <- result{0, time.Since(start)}
			return
		}
		resp.Body.Close()
		got <- result{resp.StatusCode, time.Since(start)}
	}()
	if _, err := conn.Write([]byte(head)); err != nil {
		e.t.Fatal(err)
	}
	for i, chunk := range body {
		if i > 0 {
			select {
			case r := <-got:
				return r.status, r.at
			case <-time.After(gap):
			}
		}
		if _, err := conn.Write(chunk); err != nil {
			break // the server gave up on us
		}
	}
	r := <-got
	return r.status, r.at
}

func TestBodyReadTimeouts(t *testing.T) {
	e := newEnvAPI(t, nil, func(c *api.Config) {
		c.BodyTimeout = 300 * time.Millisecond
		c.BlobIdleTimeout = 300 * time.Millisecond
	})
	admin := newIdent()
	e.claim(admin)

	// A JSON body that doesn't arrive in time.
	body := []byte(`{"token":"x","sign_pk":"","box_pk":"","sig":""}`)
	head := fmt.Sprintf("POST /api/redeem HTTP/1.1\r\nHost: x\r\nContent-Type: application/json\r\nContent-Length: %d\r\n\r\n", len(body))
	if status, at := e.slowRequest(head, [][]byte{body[:5], body[5:]}, 5*time.Second); (status != 400 && status != 0) || at > 2*time.Second {
		t.Fatalf("slow JSON body: %d after %v", status, at)
	}
	// The same body sent promptly is answered normally.
	if status, _ := e.slowRequest(head, [][]byte{body}, 0); status != 400 { // malformed fields
		t.Fatalf("prompt JSON body: %d", status)
	}

	space := randSpaceID()
	e.dial(admin, "a").createSpace(1, space)
	blobHead := func(path string, payload []byte) string {
		ts := time.Now().Unix()
		sig := admin.sign(sigs.HTTP("PUT", path, uint64(ts), payload))
		return fmt.Sprintf("PUT %s HTTP/1.1\r\nHost: x\r\nContent-Type: application/octet-stream\r\nContent-Length: %d\r\n"+
			"Authorization: Tezca pk=%s, ts=%d, sig=%s\r\n\r\n", path, len(payload), b64.EncodeToString(admin.pk), ts, b64.EncodeToString(sig))
	}
	payload := bytes.Repeat([]byte{'b'}, 10)
	chunks := make([][]byte, len(payload))
	for i := range payload {
		chunks[i] = payload[i : i+1]
	}

	// A blob upload that keeps moving may take longer than the idle timeout in total.
	path := "/api/spaces/" + space + "/blobs/" + randBlobID()
	if status, at := e.slowRequest(blobHead(path, payload), chunks, 100*time.Millisecond); status != 201 || at < 600*time.Millisecond {
		t.Fatalf("steady blob upload: %d after %v", status, at)
	}
	// One that stalls is cut off.
	path = "/api/spaces/" + space + "/blobs/" + randBlobID()
	if status, at := e.slowRequest(blobHead(path, payload), [][]byte{payload[:5], payload[5:]}, 5*time.Second); status == 201 || status == 200 || at > 2*time.Second {
		t.Fatalf("stalled blob upload: %d after %v", status, at)
	}
	if code, _, _ := e.rawCall("HEAD", path, nil, admin, nil, false); code != 404 {
		t.Fatalf("stalled blob was stored: %d", code)
	}
	// Refused before the body is read (bad signature): the rest of a slow body isn't waited for.
	bad := strings.Replace(blobHead(path, payload), "sig=", "sig=AAAA", 1)
	if status, at := e.slowRequest(bad, [][]byte{payload[:5], payload[5:]}, 5*time.Second); status == 201 || at > 2*time.Second {
		t.Fatalf("refused slow blob upload: %d after %v", status, at)
	}

	// Downloads aren't cut off by a leftover deadline: a signed GET after a body request on a
	// keep-alive connection still works when it takes longer than the body timeout.
	time.Sleep(400 * time.Millisecond)
	if code, _, data := e.rawCall("GET", "/api/spaces/"+space+"/blobs/"+randBlobID(), nil, admin, nil, false); code != 404 {
		t.Fatalf("download after timeouts: %d %s", code, data)
	}
}
