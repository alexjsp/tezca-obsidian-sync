package api

import (
	_ "embed"
	"html/template"
	"net/http"
	"net/url"
	"regexp"
)

//go:embed icon.svg
var iconSVG []byte

//go:embed apple-touch-icon.png
var appleTouchIcon []byte

// inviteJS renders the /invite page from its URL fragment.
//
//go:embed invite.js
var inviteJS []byte

// qrcodeJS is qrcode-generator 1.5.2 (MIT, Kazuhiko Arase), vendored unmodified from npm. The
// invite page draws its QR code in the browser because the server never sees the fragment.
//
//go:embed qrcode.js
var qrcodeJS []byte

const iconLinks = `<link rel="icon" type="image/svg+xml" href="/icon.svg"><link rel="apple-touch-icon" href="/apple-touch-icon.png">`

func serveIcon(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "image/svg+xml")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(iconSVG)
}

func serveTouchIcon(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(appleTouchIcon)
}

func serveScript(w http.ResponseWriter, body []byte) {
	h := w.Header()
	h.Set("Content-Type", "text/javascript; charset=utf-8")
	h.Set("Cache-Control", "public, max-age=3600")
	h.Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(body)
}

func serveInviteJS(w http.ResponseWriter, _ *http.Request) { serveScript(w, inviteJS) }
func serveQRCodeJS(w http.ResponseWriter, _ *http.Request) { serveScript(w, qrcodeJS) }

var pluginRepoRe = regexp.MustCompile(`^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$`)

// ValidPluginRepo reports whether s looks like a GitHub "owner/repo".
func ValidPluginRepo(s string) bool { return pluginRepoRe.MatchString(s) }

const pageCSS = `
:root{--bg:#f7f7f8;--card:#fff;--fg:#1d1d1f;--muted:#5f5f68;--border:#e3e3e8;--accent:#7c3aed;--accent-fg:#fff;--accent-soft:#7c3aed14;--code:#f0f0f3;--ok:#15803d;--warn:#b45309}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--card:#1d1d22;--fg:#ececf1;--muted:#a0a0ab;--border:#2e2e36;--accent:#a78bfa;--accent-fg:#141417;--accent-soft:#a78bfa1f;--code:#26262d;--ok:#4ade80;--warn:#fbbf24}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;overflow-wrap:break-word}
main{max-width:640px;margin:0 auto;padding:40px 16px 48px}
.card{background:var(--card);border:1px solid var(--border);border-radius:16px;padding:32px 28px;margin-top:16px}
.card:first-child{margin-top:0}
@media (max-width:480px){main{padding-top:20px}.card{padding:24px 18px;border-radius:14px}}
.brand{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:.9rem;margin:0 0 20px}
.brand img{width:28px;height:28px;border-radius:7px}
.logo{display:block;width:64px;height:64px;margin:0 0 16px}
h1{font-size:1.65rem;line-height:1.25;margin:0 0 8px;letter-spacing:-.01em}
h2{font-size:1.1rem;line-height:1.3;margin:0 0 6px}
p{margin:0 0 14px}
.sub{color:var(--muted);margin:0 0 20px}
.small{font-size:.875rem}
.muted{color:var(--muted)}
a{color:var(--accent);text-underline-offset:2px}
a:hover{text-decoration-thickness:2px}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px;border-radius:6px}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em;background:var(--code);border-radius:6px;padding:2px 6px;overflow-wrap:anywhere}
kbd,.ui{font-weight:600}
ol,ul{padding-left:1.3em;margin:0 0 14px}li{margin:.4em 0}
ol.steps{list-style:none;padding:0;counter-reset:s;margin:16px 0}
ol.steps>li{counter-increment:s;position:relative;padding-left:44px;margin:0 0 18px}
ol.steps>li:last-child{margin-bottom:0}
ol.steps>li::before{content:counter(s);position:absolute;left:0;top:0;width:28px;height:28px;border-radius:50%;background:var(--accent-soft);color:var(--accent);font-weight:700;font-size:.85rem;display:flex;align-items:center;justify-content:center}
ol.steps b{display:block}
ol.steps .d{color:var(--muted);font-size:.95rem}
.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;background:var(--accent);color:var(--accent-fg);text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px;border:0;cursor:pointer;font:inherit;font-weight:600;line-height:1.2}
.btn:hover{filter:brightness(1.07);text-decoration:none}
.btn.big{font-size:1.1rem;padding:16px 28px;border-radius:12px;min-width:min(100%,280px)}
.btn.secondary{background:transparent;color:var(--fg);border:1px solid var(--border);font-weight:500;padding:8px 14px;font-size:.9rem}
.btn.secondary:hover{background:var(--code);filter:none}
.cta{text-align:center;margin:28px 0 8px}
.cta .hint{margin:12px 0 0}
.qr{display:block;margin:20px auto;width:240px;height:240px;max-width:100%;border-radius:12px;background:#fff;padding:10px}
.qrbox{display:flex;gap:20px;align-items:center}
.qrbox svg{flex:none;width:176px;height:176px;border-radius:10px}
@media (max-width:480px){.qrbox{flex-direction:column;text-align:center}}
.row{display:flex;gap:8px;align-items:stretch;margin-top:12px}
.row input{flex:1;min-width:0;font-family:ui-monospace,Menlo,monospace;font-size:.8rem;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--code);color:var(--fg)}
.center{text-align:center}
.pill{display:inline-flex;align-items:center;gap:6px;font-size:.8rem;font-weight:600;padding:3px 10px;border-radius:999px;border:1px solid var(--border);color:var(--muted)}
.pill::before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}
.ok{color:var(--ok);border-color:currentColor}
.warn{color:var(--warn);border-color:currentColor}
.facts{display:flex;flex-wrap:wrap;gap:8px 20px;margin:20px 0 0;padding:14px 0 0;border-top:1px solid var(--border);font-size:.875rem;color:var(--muted)}
.facts b{color:var(--fg);font-weight:600}
.note{background:var(--accent-soft);border-radius:10px;padding:12px 14px;font-size:.92rem;margin:16px 0 0}
.grid{display:grid;gap:20px;margin-top:8px}
.grid>div{border-top:1px solid var(--border);padding-top:18px}
.grid>div:first-child{border-top:0;padding-top:4px}
.grid p{margin:0}
footer{color:var(--muted);font-size:.85rem;margin-top:24px;text-align:center;line-height:1.8}
footer a{color:inherit}
[hidden]{display:none!important}
`

// setupSteps is how someone without the plugin gets it (shared by the home and invite pages).
// .Repo is the plugin's GitHub owner/repo.
const setupSteps = `{{define "setup"}}<ol class="steps">
<li><b>Install Obsidian</b><span class="d">Free for Mac, Windows, Linux, iPhone, iPad and Android: <a href="https://obsidian.md/download" rel="noopener noreferrer">obsidian.md/download</a>. Open or create a vault.</span></li>
<li><b>Install the BRAT plugin</b><span class="d">In Obsidian, open <span class="ui">Settings → Community plugins</span>, turn community plugins on, then <span class="ui">Browse</span>, search for <span class="ui">BRAT</span>, install it and enable it.</span></li>
<li><b>Add Tezca with BRAT</b><span class="d">In BRAT's settings choose <span class="ui">Add beta plugin</span> and enter <code>{{.Repo}}</code> (<a href="https://github.com/{{.Repo}}" rel="noopener noreferrer">GitHub</a>).</span></li>
<li><b>Enable Tezca</b><span class="d">Turn on <span class="ui">Tezca</span> in <span class="ui">Settings → Community plugins</span>.</span></li>
</ol>{{end}}`

var pages = template.Must(template.New("pages").Parse(setupSteps))

var landingTmpl = template.Must(template.Must(pages.Clone()).New("landing").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer"><title>{{.Name}}</title>` + iconLinks + `<style>` + pageCSS + `</style></head>
<body><main>
<div class="card">
<img class="logo" src="/icon.svg" alt="" width="64" height="64">
<h1>{{.Name}}</h1>
<p class="sub" style="margin-bottom:14px">A Tezca server: live, end-to-end encrypted sync for Obsidian. Your notes sync between your devices and the people you share folders with, and this server only ever sees encrypted data.</p>
{{if .Claimed}}<p style="margin:0"><span class="pill ok">Ready</span></p>{{else}}<p style="margin:0"><span class="pill warn">Not set up yet</span></p>{{end}}
</div>
{{if .Claimed}}
<div class="card">
<h2>Get started</h2>
<p class="muted">Set up the plugin on each device you want to sync.</p>
{{template "setup" .}}
<p class="note">BRAT works on iPhone, iPad and Android too. To join this server you need an invite link from its admin, or a pairing link from one of your own devices that's already connected.</p>
</div>
<div class="card">
<h2>Using Tezca</h2>
<div class="grid">
<div><p><b>Add another device</b></p><p class="muted">On a device that's already connected, open <span class="ui">Settings → Tezca</span> and press <span class="ui">Pair device</span>. Scan the QR code with the new device (with the plugin installed), or open the link on it.</p></div>
<div><p><b>Invite a person</b></p><p class="muted">Admins: open <span class="ui">Settings → Tezca</span> and press <span class="ui">Create invite</span>, then send the link. They get their own private synced vault on this server.</p></div>
<div><p><b>Share a folder</b></p><p class="muted">Right-click a folder and choose <span class="ui">Share folder…</span>, then create an invite and send the link. People without a Tezca server of their own join as guests: only the shared folder syncs.</p></div>
</div>
</div>
{{else}}
<div class="card">
<h2>Claim this server</h2>
<p class="muted">Nobody has claimed this server yet. The first person to claim it becomes its admin.</p>
<ol class="steps">
<li><b>Set up the Tezca plugin</b><span class="d">On the device you'll use first: install Obsidian, then the BRAT plugin, and add <code>{{.Repo}}</code> in BRAT (<a href="https://github.com/{{.Repo}}" rel="noopener noreferrer">GitHub</a>). Enable Tezca.</span></li>
<li><b>Find the claim link</b><span class="d">It's in the server's log. With Docker Compose run <code>docker compose logs tezca</code> and look for the line starting with <code>Claim this server</code>.</span></li>
<li><b>Open the claim link</b><span class="d">Open it in a browser and press <span class="ui">Open in Obsidian</span>, or scan its QR code with your phone.</span></li>
<li><b>Save your recovery key</b><span class="d">The plugin shows a recovery key (TZCA-…). Save it in your password manager or write it down: it's the only way back in if you lose every device.</span></li>
</ol>
</div>
{{end}}
<footer><a href="https://github.com/{{.Repo}}" rel="noopener noreferrer">Tezca on GitHub</a> · Protocol v{{.Protocol}} · <a href="/api/info">/api/info</a></footer>
</main></body></html>`))

var claimTmpl = template.Must(template.New("claim").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer">
<title>Claim {{.Name}}</title>` + iconLinks + `<style>` + pageCSS + `</style></head>
<body><main><div class="card">
<img class="logo" src="/icon.svg" alt="" width="64" height="64">
<h1>Claim {{.Name}}</h1>
<p class="sub">You're about to become this server's admin.</p>
<ol>
<li>Make sure the <b>Tezca</b> plugin is installed and enabled in Obsidian.</li>
<li>On this device, press <b>Open in Obsidian</b>. On a phone, scan the QR code instead.</li>
<li>The plugin creates your identity and shows a <b>recovery key</b> (TZCA-…). Save it somewhere safe: it's the only way back in if you lose all your devices.</li>
</ol>
<p class="center"><a class="btn" href="{{.Link}}">Open in Obsidian</a></p>
<img class="qr" src="{{.QR}}" alt="QR code for the claim link" width="240" height="240">
<p class="sub center" style="margin-bottom:0">Or copy the link, then in Obsidian open <i>Settings → Tezca</i>, press <i>Paste link</i> and paste it:</p>
<div class="row"><input id="link" readonly value="{{.Link}}" aria-label="Claim link"><button class="btn secondary" id="copy" type="button">Copy</button></div>
<p class="sub" style="margin-top:20px;font-size:.85rem">Anyone with this link can claim the server until you do. After it's claimed, this page stops working.</p>
</div></main>
<script>
document.getElementById("copy").addEventListener("click",async function(){var i=document.getElementById("link");try{await navigator.clipboard.writeText(i.value)}catch(e){i.select();document.execCommand("copy")}this.textContent="Copied";var b=this;setTimeout(function(){b.textContent="Copy"},1500)});
</script></body></html>`))

// inviteTmpl is the page host and share invite links open (protocol.md "Invite links"). The
// invite itself is in the URL fragment, which never reaches the server: /invite.js reads it and
// fills in the page, so the HTML is the same for every invite.
var inviteTmpl = template.Must(template.Must(pages.Clone()).New("invite").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="referrer" content="no-referrer">
<title>Tezca invite</title>` + iconLinks + `<style>` + pageCSS + `</style>
<script src="/qrcode.js" defer></script><script src="/invite.js" defer></script></head>
<body><main>
<div class="card" id="invite" hidden>
<p class="brand"><img src="/icon.svg" alt="" width="28" height="28"><span>{{.Name}} · Tezca</span></p>
<h1 data-for="join">You're invited to {{.Name}}</h1>
<h1 data-for="share">You're invited to a shared folder</h1>
<p class="sub" data-for="join">{{.Name}} is a Tezca server: live, end-to-end encrypted sync for Obsidian. This invite gives you your own private synced vault on it.</p>
<p class="sub" data-for="share">Someone shared a folder with you on {{.Name}}. Open the invite in Obsidian and pick where the folder goes in your vault; it then syncs live, end-to-end encrypted. The folder's name is encrypted too, so this page can't show it.</p>
<p class="note" data-for="share">Don't use Tezca yet? You'll join as a guest: only the shared folder syncs, and the rest of your vault stays on your device.</p>
<div class="cta">
<a class="btn big" id="open" href="#">Open in Obsidian</a>
<p class="hint small muted">Needs the Tezca plugin. First time? <a href="#setup" id="to-setup">Set it up</a>, then come back here.</p>
</div>
<p class="facts"><span>Server <b id="host"></b></span><span>Works once</span><span>Expires 7 days after it was made</span></p>
</div>
<div class="card" id="bad" hidden>
<p class="brand"><img src="/icon.svg" alt="" width="28" height="28"><span>{{.Name}} · Tezca</span></p>
<h1>This invite link is incomplete</h1>
<p class="sub">The invite is in the part of the link after the <code>#</code>, and it's missing or damaged here. That can happen when a link is copied only in part, or a chat app shortens it.</p>
<p>Copy the whole link again, or ask the person who sent it for a new one.</p>
<p class="small muted" style="margin:0"><a href="/">About this server</a></p>
</div>
<noscript><div class="card"><h1>Turn on JavaScript</h1><p class="sub" style="margin:0">This page reads the invite from the link in your browser, so the server never sees it. That needs JavaScript.</p></div></noscript>
<div class="card" id="setup" data-ok hidden>
<h2>First time? Set up Tezca</h2>
<p class="muted">Do this once on each device you want to use, then come back to this page and press <span class="ui">Open in Obsidian</span>.</p>
{{template "setup" .}}
<p class="note">BRAT works on iPhone, iPad and Android too.</p>
</div>
<div class="card" data-ok hidden>
<div class="qrbox">
<svg id="qr" role="img" aria-label="QR code for this page" viewBox="0 0 1 1"></svg>
<div><h2>Open on your phone</h2><p class="muted" style="margin:0">Scan this with your phone's camera to open this page there.</p></div>
</div>
</div>
<div class="card" data-ok hidden>
<h2>Button not working?</h2>
<p class="muted">Copy the link. If Tezca isn't set up on your device yet, open <span class="ui">Settings → Tezca</span> in Obsidian, press <span class="ui">Paste link</span> and paste it.</p>
<div class="row"><input id="link" readonly aria-label="Invite link for Obsidian"><button class="btn secondary" id="copy" type="button">Copy</button></div>
</div>
<footer>Tezca is end-to-end encrypted: this server can't read your notes. <a href="/">About this server</a></footer>
</main></body></html>`))

// setPageHeaders sets the headers for a setup page; csp is its Content-Security-Policy.
func setPageHeaders(w http.ResponseWriter, csp string) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy", csp)
}

const (
	cspInline = "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
	// The invite page runs only its own scripts: the URL fragment holds a secret.
	cspInvite = "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
)

func (a *API) landing(w http.ResponseWriter, r *http.Request) {
	claimed, err := a.cfg.Store.Claimed(r.Context())
	if err != nil {
		a.fail(w, err)
		return
	}
	setPageHeaders(w, cspInline)
	landingTmpl.Execute(w, map[string]any{"Name": a.cfg.Name, "Claimed": claimed, "Protocol": ProtocolVersion, "Repo": a.cfg.PluginRepo})
}

func (a *API) invitePage(w http.ResponseWriter, r *http.Request) {
	setPageHeaders(w, cspInvite)
	inviteTmpl.Execute(w, map[string]any{"Name": a.cfg.Name, "Repo": a.cfg.PluginRepo})
}

func (a *API) claimPage(w http.ResponseWriter, r *http.Request) {
	code, ok := a.validClaimCode(r)
	if !ok {
		http.NotFound(w, r)
		return
	}
	setPageHeaders(w, cspInline)
	claimTmpl.Execute(w, map[string]any{
		"Name": a.cfg.Name,
		// html/template would rewrite an unknown scheme to #ZgotmplZ; the link is built by us.
		"Link": template.URL(ClaimLink(a.PublicURL(r), code)),
		"QR":   "/claim/qr.png?code=" + url.QueryEscape(code),
	})
}
