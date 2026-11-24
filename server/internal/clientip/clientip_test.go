package clientip

import (
	"net/http"
	"testing"
)

func TestIP(t *testing.T) {
	def := Default()
	none, err := Parse("none")
	if err != nil {
		t.Fatal(err)
	}
	only, err := Parse("10.0.0.1, 2001:db8::/32")
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name   string
		r      *Resolver
		remote string
		xff    []string
		real   string
		want   string
	}{
		{"direct public peer ignores XFF", def, "203.0.113.5:1234", []string{"1.2.3.4"}, "", "203.0.113.5"},
		{"trusted peer, no header", def, "127.0.0.1:1234", nil, "", "127.0.0.1"},
		{"trusted peer, XFF", def, "172.18.0.2:1234", []string{"198.51.100.7"}, "", "198.51.100.7"},
		{"right-most untrusted hop wins", def, "127.0.0.1:1", []string{"6.6.6.6, 198.51.100.7, 10.0.0.3"}, "", "198.51.100.7"},
		{"multiple XFF headers", def, "127.0.0.1:1", []string{"6.6.6.6", "198.51.100.7"}, "", "198.51.100.7"},
		{"all hops trusted", def, "127.0.0.1:1", []string{"192.168.1.4, 10.0.0.3"}, "", "192.168.1.4"},
		{"garbage hop", def, "127.0.0.1:1", []string{"198.51.100.7, nonsense"}, "", "127.0.0.1"},
		{"X-Real-IP", def, "[::1]:1", nil, "198.51.100.9", "198.51.100.9"},
		{"IPv6 peer", def, "[2001:db8::1]:1", []string{"1.2.3.4"}, "", "2001:db8::1"},
		{"mapped IPv4 peer", def, "[::ffff:127.0.0.1]:1", []string{"198.51.100.7"}, "", "198.51.100.7"},
		{"none trusts nobody", none, "127.0.0.1:1", []string{"198.51.100.7"}, "", "127.0.0.1"},
		{"single address", only, "10.0.0.1:1", []string{"198.51.100.7"}, "", "198.51.100.7"},
		{"not in custom list", only, "10.0.0.2:1", []string{"198.51.100.7"}, "", "10.0.0.2"},
		{"custom v6 prefix", only, "[2001:db8::5]:1", []string{"198.51.100.7"}, "", "198.51.100.7"},
	} {
		req, _ := http.NewRequest("GET", "/", nil)
		req.RemoteAddr = tc.remote
		for _, h := range tc.xff {
			req.Header.Add("X-Forwarded-For", h)
		}
		if tc.real != "" {
			req.Header.Set("X-Real-IP", tc.real)
		}
		if got := tc.r.IP(req); got != tc.want {
			t.Errorf("%s: got %s, want %s", tc.name, got, tc.want)
		}
	}
	if _, err := Parse("10.0.0.0/33"); err == nil {
		t.Error("bad prefix accepted")
	}
	if _, err := Parse("example.com"); err == nil {
		t.Error("hostname accepted")
	}
}
