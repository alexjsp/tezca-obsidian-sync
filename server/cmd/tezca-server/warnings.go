package main

import (
	"net"
	"net/netip"
)

// MinClaimCode is the shortest TEZCA_CLAIM_CODE that doesn't get a startup warning.
const MinClaimCode = 16

// isLoopback reports whether a listen address (host:port) only accepts local connections.
func isLoopback(listen string) bool {
	host, _, err := net.SplitHostPort(listen)
	if err != nil || host == "" {
		return false // ":8080" listens on every interface
	}
	if host == "localhost" {
		return true
	}
	a, err := netip.ParseAddr(host)
	return err == nil && a.Unmap().IsLoopback()
}

// startupWarnings returns the configuration problems to log prominently at startup.
func startupWarnings(listen, publicURL, presetCode string, claimed bool) []string {
	var out []string
	if publicURL == "" && !isLoopback(listen) {
		out = append(out, "TEZCA_PUBLIC_URL is not set and the server listens on "+listen+
			", which isn't loopback-only. Claim and invite links will use whatever host the request names "+
			"(Host / X-Forwarded-Host). Set TEZCA_PUBLIC_URL to the URL your devices use.")
	}
	if presetCode != "" && !claimed && len(presetCode) < MinClaimCode {
		out = append(out, "TEZCA_CLAIM_CODE is shorter than 16 characters, so it can be guessed. "+
			"Anyone who can reach this server can claim it with that code: use a long random code, "+
			"or unset it to have one generated.")
	}
	return out
}
