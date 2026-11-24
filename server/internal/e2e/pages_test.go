package e2e

import (
	"net/http"
	"strings"
	"testing"

	"tezca/server/internal/api"
)

func mustContain(t *testing.T, what, body string, wants ...string) {
	t.Helper()
	for _, w := range wants {
		if !strings.Contains(body, w) {
			t.Errorf("%s: missing %q", what, w)
		}
	}
}

func mustNotContain(t *testing.T, what, body string, nots ...string) {
	t.Helper()
	for _, w := range nots {
		if strings.Contains(body, w) {
			t.Errorf("%s: unexpected %q", what, w)
		}
	}
}

func TestInvitePage(t *testing.T) {
	e := newEnv(t, nil)
	code, body, hdr := get(t, e.srv.URL+"/invite")
	if code != 200 {
		t.Fatalf("invite page: %d", code)
	}
	// The fragment carries a share's secret: only our own scripts may run, and nothing may leak
	// the URL onwards.
	csp := hdr.Get("Content-Security-Policy")
	for _, d := range []string{"default-src 'none'", "script-src 'self'", "frame-ancestors 'none'", "base-uri 'none'", "form-action 'none'"} {
		if !strings.Contains(csp, d) {
			t.Errorf("CSP %q lacks %q", csp, d)
		}
	}
	if strings.Contains(strings.SplitN(strings.SplitN(csp, "script-src", 2)[1], ";", 2)[0], "unsafe") {
		t.Errorf("CSP allows inline scripts: %q", csp)
	}
	for k, want := range map[string]string{
		"Referrer-Policy":        "no-referrer",
		"Cache-Control":          "no-store",
		"X-Content-Type-Options": "nosniff",
		"Content-Type":           "text/html; charset=utf-8",
	} {
		if got := hdr.Get(k); got != want {
			t.Errorf("%s = %q, want %q", k, got, want)
		}
	}
	mustContain(t, "invite page", body,
		`<script src="/qrcode.js" defer></script>`, `<script src="/invite.js" defer></script>`,
		`id="open"`, `id="bad"`, `id="qr"`, `id="link"`, `id="to-setup"`,
		"You're invited to Test", "You're invited to a shared folder", "join as a guest",
		"https://obsidian.md/download", "BRAT", "<code>"+api.DefaultPluginRepo+"</code>", "https://github.com/"+api.DefaultPluginRepo,
		"iPhone, iPad and Android", "Expires 7 days", "Works once", "Paste link")
	// No inline script: every <script> loads a same-origin file.
	if n, m := strings.Count(body, "<script"), strings.Count(body, `<script src="/`); n != m {
		t.Errorf("invite page has %d inline scripts", n-m)
	}

	for path, want := range map[string]string{"/invite.js": "location.hash", "/qrcode.js": "QR Code Generator for JavaScript"} {
		code, js, hdr := get(t, e.srv.URL+path)
		if code != 200 || !strings.HasPrefix(hdr.Get("Content-Type"), "text/javascript") || hdr.Get("X-Content-Type-Options") != "nosniff" || !strings.Contains(js, want) {
			t.Errorf("%s: %d %q", path, code, hdr.Get("Content-Type"))
		}
	}
	// invite.js builds the obsidian:// link from the fragment and never makes requests.
	_, js, _ := get(t, e.srv.URL+"/invite.js")
	mustContain(t, "invite.js", js, `"obsidian://tezca?"`, "URLSearchParams")
	mustNotContain(t, "invite.js", js, "fetch(", "XMLHttpRequest", "sendBeacon", "localStorage", "console.")

	if code, _, _ := get(t, e.srv.URL+"/invite?x=1"); code != 200 {
		t.Errorf("invite with query: %d", code)
	}
	resp, err := http.Post(e.srv.URL+"/invite", "text/plain", nil)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusMethodNotAllowed {
		t.Errorf("POST /invite: %d", resp.StatusCode)
	}
}

func TestLandingPage(t *testing.T) {
	e := newEnv(t, nil)
	code, body, hdr := get(t, e.srv.URL+"/")
	if code != 200 || hdr.Get("Referrer-Policy") != "no-referrer" || !strings.Contains(hdr.Get("Content-Security-Policy"), "default-src 'none'") {
		t.Fatalf("landing: %d %v", code, hdr)
	}
	mustContain(t, "unclaimed landing", body, "Not set up yet", "Claim this server", "docker compose logs tezca",
		"recovery phrase", api.DefaultPluginRepo, "/api/info", "Protocol v1")
	mustNotContain(t, "unclaimed landing", body, "Pair device", "Ready")

	e.claim(newIdent())
	_, body, _ = get(t, e.srv.URL+"/")
	mustContain(t, "claimed landing", body, "Ready", "https://obsidian.md/download", "BRAT", "<code>"+api.DefaultPluginRepo+"</code>",
		"https://github.com/"+api.DefaultPluginRepo, "Pair device", "Create invite", "Share folder…", "/api/info")
	// The plugin's real labels, not the old ones.
	mustNotContain(t, "claimed landing", body, "Not set up yet", "docker compose logs", "Add a device", "Invite to server")
}

func TestPluginRepoSetting(t *testing.T) {
	e := newEnvAPI(t, nil, func(c *api.Config) { c.PluginRepo = "someone/tezca-fork" })
	for _, path := range []string{"/", "/invite"} {
		_, body, _ := get(t, e.srv.URL+path)
		mustContain(t, path, body, "<code>someone/tezca-fork</code>", "https://github.com/someone/tezca-fork")
		mustNotContain(t, path, body, api.DefaultPluginRepo)
	}
	// Anything that isn't owner/repo falls back to the default rather than ending up in a link.
	e = newEnvAPI(t, nil, func(c *api.Config) { c.PluginRepo = `x"><script>alert(1)</script>/y` })
	_, body, _ := get(t, e.srv.URL+"/invite")
	mustContain(t, "bad repo", body, "https://github.com/"+api.DefaultPluginRepo)
	mustNotContain(t, "bad repo", body, "alert(1)")

	for s, ok := range map[string]bool{
		"alexjsp/tezca-obsidian-sync": true, "a/b": true, "Org-1/repo.name_2": true,
		"": false, "a": false, "a/b/c": false, "-a/b": false, "a/b c": false, "https://github.com/a/b": false,
	} {
		if api.ValidPluginRepo(s) != ok {
			t.Errorf("ValidPluginRepo(%q) = %v", s, !ok)
		}
	}
}
