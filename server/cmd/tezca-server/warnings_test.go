package main

import (
	"strings"
	"testing"
)

func TestStartupWarnings(t *testing.T) {
	for _, tc := range []struct {
		listen, publicURL, code string
		claimed                 bool
		want                    []string // substrings, one per warning
	}{
		{":8080", "", "", false, []string{"TEZCA_PUBLIC_URL"}},
		{"0.0.0.0:8080", "", "", true, []string{"TEZCA_PUBLIC_URL"}},
		{"192.168.1.5:8080", "", "", true, []string{"TEZCA_PUBLIC_URL"}},
		{":8080", "https://notes.example.com", "", false, nil},
		{"127.0.0.1:8080", "", "", false, nil},
		{"[::1]:8080", "", "", false, nil},
		{"localhost:8080", "", "", false, nil},
		{"127.0.0.1:8080", "", "dev", false, []string{"TEZCA_CLAIM_CODE"}},
		{"127.0.0.1:8080", "", "dev", true, nil}, // already claimed: the code is unused
		{"127.0.0.1:8080", "", "0123456789abcdef", false, nil},
		{":8080", "", "short", false, []string{"TEZCA_PUBLIC_URL", "TEZCA_CLAIM_CODE"}},
	} {
		got := startupWarnings(tc.listen, tc.publicURL, tc.code, tc.claimed)
		if len(got) != len(tc.want) {
			t.Errorf("%+v: got %q", tc, got)
			continue
		}
		for i, w := range tc.want {
			if !strings.Contains(got[i], w) {
				t.Errorf("%+v: warning %d = %q, want it to mention %s", tc, i, got[i], w)
			}
		}
	}
}
