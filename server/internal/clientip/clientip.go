// Package clientip works out which address a request came from, for per-IP limits. Behind a
// reverse proxy every request arrives from the proxy, so X-Forwarded-For (or X-Real-IP) is used,
// but only when the direct peer is a trusted proxy: anyone else could put anything there.
package clientip

import (
	"fmt"
	"net"
	"net/http"
	"net/netip"
	"strings"
)

// DefaultTrusted is the default TEZCA_TRUSTED_PROXIES: loopback, private (RFC 1918 and IPv6
// unique local) and CGNAT/Tailscale ranges, which covers a proxy on the same host, in Docker, or
// elsewhere on the LAN or tailnet.
const DefaultTrusted = "127.0.0.0/8,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,100.64.0.0/10,fc00::/7"

// Resolver maps a request to its client address.
type Resolver struct {
	trusted []netip.Prefix
}

// Parse builds a Resolver from a comma-separated list of CIDRs or addresses. "none" trusts no
// proxy (the TCP peer is always the client).
func Parse(spec string) (*Resolver, error) {
	r := &Resolver{}
	spec = strings.TrimSpace(spec)
	if strings.EqualFold(spec, "none") {
		return r, nil
	}
	for _, f := range strings.Split(spec, ",") {
		f = strings.TrimSpace(f)
		if f == "" {
			continue
		}
		if strings.Contains(f, "/") {
			p, err := netip.ParsePrefix(f)
			if err != nil {
				return nil, fmt.Errorf("bad trusted proxy %q: %w", f, err)
			}
			r.trusted = append(r.trusted, p.Masked())
			continue
		}
		a, err := netip.ParseAddr(f)
		if err != nil {
			return nil, fmt.Errorf("bad trusted proxy %q: %w", f, err)
		}
		a = a.Unmap()
		r.trusted = append(r.trusted, netip.PrefixFrom(a, a.BitLen()))
	}
	return r, nil
}

// Default returns a Resolver trusting DefaultTrusted.
func Default() *Resolver {
	r, err := Parse(DefaultTrusted)
	if err != nil {
		panic(err)
	}
	return r
}

func (r *Resolver) isTrusted(a netip.Addr) bool {
	a = a.Unmap()
	for _, p := range r.trusted {
		if p.Contains(a) {
			return true
		}
	}
	return false
}

func parseAddr(s string) (netip.Addr, bool) {
	s = strings.TrimSpace(s)
	if h, _, err := net.SplitHostPort(s); err == nil {
		s = h
	}
	s = strings.TrimSuffix(strings.TrimPrefix(s, "["), "]")
	a, err := netip.ParseAddr(s)
	if err != nil {
		return netip.Addr{}, false
	}
	return a.Unmap().WithZone(""), true
}

// IP returns the client address of req as a string. If the TCP peer is a trusted proxy, it's
// the right-most X-Forwarded-For entry that isn't itself a trusted proxy (or X-Real-IP when there
// is no X-Forwarded-For).
func (r *Resolver) IP(req *http.Request) string {
	peer, ok := parseAddr(req.RemoteAddr)
	if !ok {
		return req.RemoteAddr
	}
	if !r.isTrusted(peer) {
		return peer.String()
	}
	var hops []string
	for _, h := range req.Header.Values("X-Forwarded-For") {
		hops = append(hops, strings.Split(h, ",")...)
	}
	if len(hops) == 0 {
		if a, ok := parseAddr(req.Header.Get("X-Real-IP")); ok {
			return a.String()
		}
		return peer.String()
	}
	client := peer
	for i := len(hops) - 1; i >= 0; i-- {
		a, ok := parseAddr(hops[i])
		if !ok {
			break // garbage: stop at the last address we could trust
		}
		client = a
		if !r.isTrusted(a) {
			break
		}
	}
	return client.String()
}
