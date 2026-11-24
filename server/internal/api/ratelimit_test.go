package api

import (
	"testing"
	"time"
)

func TestFailLimiter(t *testing.T) {
	l := newFailLimiter(2, time.Minute)
	t0 := time.Unix(1_000_000, 0)
	for i := 0; i < 2; i++ {
		if !l.allow("a", t0) {
			t.Fatalf("attempt %d refused", i)
		}
		l.fail("a", t0)
	}
	if l.allow("a", t0) {
		t.Fatal("allowed after the burst")
	}
	if !l.allow("b", t0) {
		t.Fatal("another address refused")
	}
	// A clock stepping backwards neither refills nor drains.
	if l.allow("a", t0.Add(-time.Hour)) {
		t.Fatal("allowed after the clock stepped back")
	}
	if !l.allow("a", t0.Add(time.Minute)) {
		t.Fatal("not refilled after one interval")
	}
	// Full buckets are forgotten.
	if !l.allow("a", t0.Add(time.Hour)) || len(l.buckets) != 0 {
		t.Fatalf("buckets: %v", l.buckets)
	}
}
