package api

import (
	"net"
	"net/http"
	"strconv"
	"sync"
	"time"
)

// Defaults for the failed-attempt limiter on the endpoints that take a secret from an
// unauthenticated caller (claim code, invite token, pairing id): a burst of DefaultFailBurst
// failures per client address, then one more every DefaultFailEvery.
const (
	DefaultFailBurst = 10
	DefaultFailEvery = 10 * time.Second
)

// failLimiter is a token bucket per client address that only failures drain.
type failLimiter struct {
	burst float64
	every time.Duration

	mu        sync.Mutex
	buckets   map[string]*bucket
	lastSweep time.Time
}

type bucket struct {
	tokens float64
	at     time.Time
}

func newFailLimiter(burst int, every time.Duration) *failLimiter {
	return &failLimiter{burst: float64(burst), every: every, buckets: map[string]*bucket{}}
}

// refill returns ip's bucket topped up to now (nil if it's full). Call with mu held.
func (l *failLimiter) refill(ip string, now time.Time) *bucket {
	b := l.buckets[ip]
	if b == nil {
		return nil
	}
	if now.After(b.at) { // a clock stepping backwards must not drain the bucket
		b.tokens += float64(now.Sub(b.at)) / float64(l.every)
		b.at = now
	}
	if b.tokens >= l.burst {
		delete(l.buckets, ip)
		return nil
	}
	return b
}

// allow reports whether ip may make another attempt.
func (l *failLimiter) allow(ip string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	b := l.refill(ip, now)
	return b == nil || b.tokens >= 1
}

// fail records a failed attempt by ip.
func (l *failLimiter) fail(ip string, now time.Time) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if now.Sub(l.lastSweep) >= time.Minute {
		for k := range l.buckets {
			l.refill(k, now) // drops full buckets
		}
		l.lastSweep = now
	}
	b := l.refill(ip, now)
	if b == nil {
		b = &bucket{tokens: l.burst, at: now}
		l.buckets[ip] = b
	}
	b.tokens = max(b.tokens-1, 0)
}

// statusWriter records the response status.
type statusWriter struct {
	http.ResponseWriter
	status int
}

func (w *statusWriter) WriteHeader(code int) {
	if w.status == 0 {
		w.status = code
	}
	w.ResponseWriter.WriteHeader(code)
}

func (w *statusWriter) Write(b []byte) (int, error) {
	if w.status == 0 {
		w.status = http.StatusOK
	}
	return w.ResponseWriter.Write(b)
}

func (w *statusWriter) Unwrap() http.ResponseWriter { return w.ResponseWriter }

// limited wraps a handler that checks a secret: once a client address has used up its failed
// attempts it gets 429 until its bucket refills. Any 4xx answer counts as a failure.
func (a *API) limited(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ip := a.cfg.ClientIP(r)
		if !a.fails.allow(ip, a.cfg.Now()) {
			w.Header().Set("Retry-After", strconv.Itoa(int(a.fails.every.Seconds()+0.5)))
			a.fail(w, herr(http.StatusTooManyRequests, "too many failed attempts; try again later"))
			return
		}
		sw := &statusWriter{ResponseWriter: w}
		h(sw, r)
		if sw.status >= 400 && sw.status < 500 {
			a.fails.fail(ip, a.cfg.Now())
		}
	}
}

// remoteIP is the default Config.ClientIP: the TCP peer's address.
func remoteIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
