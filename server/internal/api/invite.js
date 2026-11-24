// Renders /invite from its URL fragment (protocol.md "Invite links").
//
// The fragment is the invite: do=join|share, host, token and, for a share, k (the secret that
// unwraps the shared folder's key). Browsers never send the fragment to the server, and this
// script never sends it anywhere either: no requests, no storage, no logging. It only builds the
// obsidian://tezca link and a QR code of this page's own URL.
"use strict";
(function () {
	var $ = function (id) {
		return document.getElementById(id);
	};
	var KEYS = ["do", "host", "token", "k"];

	// The invite's parameters, or null if the fragment isn't a valid join or share invite.
	function parse(hash) {
		var p = new URLSearchParams(hash.replace(/^#/, ""));
		var v = {};
		KEYS.forEach(function (k) {
			var x = p.get(k);
			if (x) v[k] = x;
		});
		if (v.do !== "join" && v.do !== "share") return null;
		if (!v.token || (v.do === "share" && !v.k)) return null;
		try {
			var u = new URL(v.host);
			if (u.protocol !== "https:" && u.protocol !== "http:") return null;
			v.hostName = u.host;
		} catch (e) {
			return null;
		}
		return v;
	}

	function deepLink(v) {
		var q = new URLSearchParams();
		KEYS.forEach(function (k) {
			if (v[k]) q.set(k, v[k]);
		});
		return "obsidian://tezca?" + q.toString();
	}

	function drawQR(svg, text) {
		if (typeof qrcode !== "function") return false;
		var qr = qrcode(0, "M");
		qr.addData(text);
		qr.make();
		var n = qr.getModuleCount();
		var m = 4; // quiet zone, in modules
		var d = "";
		for (var r = 0; r < n; r++) for (var c = 0; c < n; c++) if (qr.isDark(r, c)) d += "M" + c + " " + r + "h1v1h-1z";
		var ns = "http://www.w3.org/2000/svg";
		svg.setAttribute("viewBox", -m + " " + -m + " " + (n + 2 * m) + " " + (n + 2 * m));
		svg.setAttribute("shape-rendering", "crispEdges");
		var bg = document.createElementNS(ns, "rect");
		bg.setAttribute("x", -m);
		bg.setAttribute("y", -m);
		bg.setAttribute("width", n + 2 * m);
		bg.setAttribute("height", n + 2 * m);
		bg.setAttribute("fill", "#fff");
		var path = document.createElementNS(ns, "path");
		path.setAttribute("d", d);
		path.setAttribute("fill", "#000");
		svg.replaceChildren(bg, path);
		return true;
	}

	function copy(text, button) {
		var done = function () {
			button.textContent = "Copied";
			setTimeout(function () {
				button.textContent = "Copy";
			}, 1500);
		};
		var fallback = function () {
			var i = $("link");
			i.focus();
			i.select();
			try {
				document.execCommand("copy");
				done();
			} catch (e) {
				/* the link is selected; the person can copy it themselves */
			}
		};
		if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
		else fallback();
	}

	function render() {
		var v = parse(location.hash);
		if (!v) {
			$("bad").hidden = false;
			document.title = "Incomplete invite link";
			return;
		}
		var link = deepLink(v);
		document.querySelectorAll("[data-for]").forEach(function (el) {
			if (el.getAttribute("data-for") !== v.do) el.remove();
		});
		document.title = $("invite").querySelector("h1").textContent;
		$("open").href = link;
		$("host").textContent = v.hostName;
		$("link").value = link;
		$("copy").addEventListener("click", function () {
			copy(link, this);
		});
		// Following #setup would replace the fragment, and with it the invite.
		$("to-setup").addEventListener("click", function (e) {
			e.preventDefault();
			var s = $("setup");
			s.setAttribute("tabindex", "-1");
			s.scrollIntoView({ behavior: "smooth", block: "start" });
			s.focus({ preventScroll: true });
		});
		$("invite").hidden = false;
		document.querySelectorAll("[data-ok]").forEach(function (el) {
			el.hidden = false;
		});
		if (!drawQR($("qr"), location.href)) $("qr").closest(".card").hidden = true;
	}

	render();
})();
