package api

import (
	"bytes"
	"testing"
)

func TestReplayCache(t *testing.T) {
	c := newReplayCache()
	pk := bytes.Repeat([]byte{1}, 32)
	sig := func(b byte) []byte { return bytes.Repeat([]byte{b}, 64) }
	const now = 1_000_000

	if !c.firstUse(pk, sig(1), now, now) {
		t.Fatal("first use refused")
	}
	if c.firstUse(pk, sig(1), now, now+10) {
		t.Fatal("replay accepted")
	}
	if !c.firstUse(pk, sig(2), now, now+10) {
		t.Fatal("another signature refused")
	}
	if !c.firstUse(bytes.Repeat([]byte{2}, 32), sig(1), now, now+10) {
		t.Fatal("same signature bytes under another key refused")
	}
	// Still refused at the edge of the skew window.
	if c.firstUse(pk, sig(1), now, now+MaxSkew) {
		t.Fatal("replay accepted at the window's edge")
	}
	// Entries whose timestamps have left the window are swept.
	c.firstUse(pk, sig(3), now+2*MaxSkew, now+2*MaxSkew)
	if n := c.len(); n != 1 {
		t.Fatalf("%d entries after sweep, want 1", n)
	}
}
