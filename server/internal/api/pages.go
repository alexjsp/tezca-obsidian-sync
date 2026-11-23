package api

import (
	_ "embed"
	"html/template"
	"net/http"
	"net/url"
)

//go:embed icon.svg
var iconSVG []byte

//go:embed apple-touch-icon.png
var appleTouchIcon []byte

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

const pageCSS = `
:root{--bg:#f7f7f8;--card:#fff;--fg:#1d1d1f;--muted:#6b6b73;--border:#e3e3e8;--accent:#7c3aed;--accent-fg:#fff;--code:#f0f0f3}
@media (prefers-color-scheme:dark){:root{--bg:#141417;--card:#1d1d22;--fg:#ececf1;--muted:#9a9aa5;--border:#2e2e36;--accent:#a78bfa;--accent-fg:#141417;--code:#26262d}}
*{box-sizing:border-box}
.logo{display:block;width:64px;height:64px;margin:0 0 12px}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif}
main{max-width:640px;margin:0 auto;padding:48px 16px}
.card{background:var(--card);border:1px solid var(--border);border-radius:14px;padding:28px}
h1{font-size:1.6rem;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 24px}
ol{padding-left:1.3em}li{margin:.5em 0}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em;background:var(--code);border-radius:6px;padding:2px 6px}
.btn{display:inline-block;background:var(--accent);color:var(--accent-fg);text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px;border:0;cursor:pointer;font-size:1rem}
.btn.secondary{background:transparent;color:var(--fg);border:1px solid var(--border);font-weight:500;padding:8px 14px;font-size:.9rem}
.qr{display:block;margin:20px auto;width:240px;height:240px;border-radius:12px;background:#fff;padding:10px}
.row{display:flex;gap:8px;align-items:stretch;margin-top:12px}
.row input{flex:1;min-width:0;font-family:ui-monospace,Menlo,monospace;font-size:.8rem;padding:8px 10px;border-radius:8px;border:1px solid var(--border);background:var(--code);color:var(--fg)}
.center{text-align:center}
.pill{display:inline-block;font-size:.8rem;padding:2px 10px;border-radius:999px;border:1px solid var(--border);color:var(--muted)}
.ok{color:#16a34a;border-color:#16a34a55}
.warn{color:#d97706;border-color:#d9770655}
footer{color:var(--muted);font-size:.85rem;margin-top:20px;text-align:center}
`

var landingTmpl = template.Must(template.New("landing").Parse(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>{{.Name}}</title>` + iconLinks + `<style>` + pageCSS + `</style></head>
<body><main><div class="card">
<img class="logo" src="/icon.svg" alt="" width="64" height="64">
<h1>{{.Name}}</h1>
<p class="sub">Tezca sync server · end-to-end encrypted live sync for Obsidian</p>
{{if .Claimed}}
<p><span class="pill ok">Ready</span></p>
<p>This server is set up. To add a device or a person:</p>
<ol>
<li><b>Another device of yours:</b> in the Tezca plugin on a device that is already connected, choose <i>Add a device</i> and scan the QR code or open the link on the new device.</li>
<li><b>Another person:</b> the admin creates an invite in the plugin (<i>Invite to server</i>) and sends them the link.</li>
</ol>
<p class="sub">This server only stores encrypted data. It can't read your notes, file names or cursors.</p>
{{else}}
<p><span class="pill warn">Not set up yet</span></p>
<p>This server hasn't been claimed. The first person to claim it becomes its admin.</p>
<ol>
<li>Install the <b>Tezca</b> plugin in Obsidian and enable it.</li>
<li>Find the claim link in the server logs. With Docker Compose run <code>docker compose logs tezca</code> and look for the line starting with <code>Claim this server</code>.</li>
<li>Open that link in a browser on the device with Obsidian, then press <b>Open in Obsidian</b> (or scan the QR code on your phone).</li>
<li>Write down the recovery phrase that the plugin shows you.</li>
</ol>
{{end}}
</div><footer>Protocol v{{.Protocol}} · <a href="/api/info" style="color:inherit">/api/info</a></footer></main></body></html>`))

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
<li>The plugin creates your identity and shows a <b>recovery phrase</b>. Write it down: it's the only way back in if you lose all your devices.</li>
</ol>
<p class="center"><a class="btn" href="{{.Link}}">Open in Obsidian</a></p>
<img class="qr" src="{{.QR}}" alt="QR code for the claim link" width="240" height="240">
<p class="sub center" style="margin-bottom:0">Or copy the link and paste it into the plugin's <i>Connect to server</i> dialog:</p>
<div class="row"><input id="link" readonly value="{{.Link}}" aria-label="Claim link"><button class="btn secondary" id="copy" type="button">Copy</button></div>
<p class="sub" style="margin-top:20px;font-size:.85rem">Anyone with this link can claim the server until you do. After it's claimed, this page stops working.</p>
</div></main>
<script>
document.getElementById("copy").addEventListener("click",async function(){var i=document.getElementById("link");try{await navigator.clipboard.writeText(i.value)}catch(e){i.select();document.execCommand("copy")}this.textContent="Copied";var b=this;setTimeout(function(){b.textContent="Copy"},1500)});
</script></body></html>`))

func setPageHeaders(w http.ResponseWriter) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "no-referrer")
	h.Set("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; frame-ancestors 'none'")
}

func (a *API) landing(w http.ResponseWriter, r *http.Request) {
	claimed, err := a.cfg.Store.Claimed(r.Context())
	if err != nil {
		a.fail(w, err)
		return
	}
	setPageHeaders(w)
	landingTmpl.Execute(w, map[string]any{"Name": a.cfg.Name, "Claimed": claimed, "Protocol": ProtocolVersion})
}

func (a *API) claimPage(w http.ResponseWriter, r *http.Request) {
	code, ok := a.validClaimCode(r)
	if !ok {
		http.NotFound(w, r)
		return
	}
	setPageHeaders(w)
	claimTmpl.Execute(w, map[string]any{
		"Name": a.cfg.Name,
		// html/template would rewrite an unknown scheme to #ZgotmplZ; the link is built by us.
		"Link": template.URL(ClaimLink(a.PublicURL(r), code)),
		"QR":   "/claim/qr.png?code=" + url.QueryEscape(code),
	})
}
