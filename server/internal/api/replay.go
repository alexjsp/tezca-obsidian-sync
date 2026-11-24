package api

import "sync"

// replayCache remembers the HTTP signatures seen within the allowed clock skew, so a captured
// signed request can't be sent again. An entry can be forgotten once its timestamp is outside
// the skew window, because parseAuth refuses it from then on anyway.
type replayCache struct {
	mu        sync.Mutex
	seen      map[[96]byte]int64 // pk ‖ sig → last unix second at which ts is still accepted
	lastSweep int64
}

func newReplayCache() *replayCache {
	return &replayCache{seen: map[[96]byte]int64{}}
}

// firstUse records (pk, sig) and reports whether it hadn't been seen yet. ts is the signed
// timestamp, now the current unix time.
func (c *replayCache) firstUse(pk, sig []byte, ts, now int64) bool {
	var k [96]byte
	copy(k[:32], pk)
	copy(k[32:], sig)
	c.mu.Lock()
	defer c.mu.Unlock()
	if now-c.lastSweep >= 60 {
		for k, exp := range c.seen {
			if exp < now {
				delete(c.seen, k)
			}
		}
		c.lastSweep = now
	}
	if exp, ok := c.seen[k]; ok && exp >= now {
		return false
	}
	c.seen[k] = ts + MaxSkew
	return true
}

func (c *replayCache) len() int {
	c.mu.Lock()
	defer c.mu.Unlock()
	return len(c.seen)
}
