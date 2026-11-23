// .obsidian settings sync by opt-in category (plan.md "Content").
import { afterEach, describe, expect, it } from "vitest";
import { NO_CONFIG, configFileIncluded, type ConfigCategories } from "../src/core/config-sync";
import { SyncEngine } from "../src/core/engine";
import { MemoryStore } from "../src/core/store";
import { MemoryVault } from "../src/core/vault";
import type { MockHost } from "./mock-host";
import { converged, eventually, setupHost, type Client } from "./helpers";

const ALL: ConfigCategories = { core: true, appearance: true, hotkeys: true, plugins: true, pluginCode: true };

describe("config categories", () => {
	const inc = (rel: string, c: Partial<ConfigCategories>) => configFileIncluded(rel, { ...NO_CONFIG, ...c }, "tezca-sync");
	it("maps files to categories", () => {
		expect(inc("app.json", { core: true })).toBe(true);
		expect(inc("daily-notes.json", { core: true })).toBe(true);
		expect(inc("appearance.json", { core: true })).toBe(false);
		expect(inc("appearance.json", { appearance: true })).toBe(true);
		expect(inc("themes/Things/theme.css", { appearance: true })).toBe(true);
		expect(inc("snippets/a.css", { appearance: true })).toBe(true);
		expect(inc("hotkeys.json", { hotkeys: true })).toBe(true);
		expect(inc("community-plugins.json", { plugins: true })).toBe(true);
		expect(inc("plugins/dataview/data.json", { plugins: true })).toBe(true);
		expect(inc("plugins/dataview/main.js", { plugins: true })).toBe(false);
		expect(inc("plugins/dataview/main.js", { pluginCode: true })).toBe(true);
	});
	it("never syncs workspace layout or Tezca's own folder", () => {
		expect(configFileIncluded("workspace.json", ALL, "tezca-sync")).toBe(false);
		expect(configFileIncluded("workspace-mobile.json", ALL, "tezca-sync")).toBe(false);
		expect(configFileIncluded("plugins/tezca-sync/data.json", ALL, "tezca-sync")).toBe(false);
		expect(configFileIncluded("plugins/tezca-sync/main.js", ALL, "tezca-sync")).toBe(false);
		expect(configFileIncluded("plugins/x/node_modules/y.js", ALL, "tezca-sync")).toBe(false);
	});
});

let clients: Client[] = [];
afterEach(async () => {
	await Promise.all(clients.map((c) => c.engine.stop()));
	clients = [];
});

async function start(host: MockHost, id: Awaited<ReturnType<typeof setupHost>>["id"], spaceId: string, name: string, categories: ConfigCategories, vault = new MemoryVault()) {
	const engine = new SyncEngine({
		host: "http://mock",
		identity: id,
		deviceId: name,
		deviceName: name,
		spaceId,
		store: new MemoryStore(),
		vault,
		clientVersion: "test",
		WebSocketImpl: host.WebSocket,
		http: host.http,
		startupWaitMs: 3000,
		blobRetryMs: 200,
		config: { dir: ".obsidian", categories, ownPluginId: "tezca-sync" },
	});
	await engine.start();
	const c = { name, vault, store: new MemoryStore(), engine };
	clients.push(c);
	return c;
}

describe("config sync", () => {
	it("syncs the chosen categories only, and tells the user to reload", async () => {
		const { host, id, spaceId } = await setupHost();
		const va = new MemoryVault();
		for (const [p, c] of Object.entries({
			".obsidian/app.json": '{"spellcheck":true}',
			".obsidian/hotkeys.json": "{}",
			".obsidian/appearance.json": '{"theme":"obsidian"}',
			".obsidian/workspace.json": '{"main":{}}',
			".obsidian/plugins/tezca-sync/data.json": '{"deviceId":"A"}',
			"note.md": "hi",
		}))
			va.files.set(p, c);
		const cats = { ...NO_CONFIG, core: true, hotkeys: true };
		const a = await start(host, id, spaceId, "A", cats, va);
		const b = await start(host, id, spaceId, "B", cats);
		const notices: string[] = [];
		b.engine.notices.on((n) => n.kind === "config" && notices.push(n.message));
		await eventually(() => b.vault.files.get(".obsidian/app.json") !== undefined, 5000, "app.json synced");
		await converged(a, b);
		expect(new TextDecoder().decode(await b.vault.readBinary(".obsidian/app.json") as Uint8Array)).toBe('{"spellcheck":true}');
		expect(b.vault.files.has(".obsidian/hotkeys.json")).toBe(true);
		expect(b.vault.files.has(".obsidian/appearance.json")).toBe(false);
		expect(b.vault.files.has(".obsidian/workspace.json")).toBe(false);
		expect(b.vault.files.has(".obsidian/plugins/tezca-sync/data.json")).toBe(false);
		expect(notices.length).toBeGreaterThan(0);

		// A change on B flows back.
		await b.vault.userWriteBinary(".obsidian/app.json", new TextEncoder().encode('{"spellcheck":false}'));
		await eventually(async () => new TextDecoder().decode((await a.vault.readBinary(".obsidian/app.json")) ?? new Uint8Array()) === '{"spellcheck":false}', 5000, "change flows back");
	});

	it("a device that hasn't opted in keeps its own settings", async () => {
		const { host, id, spaceId } = await setupHost();
		const va = new MemoryVault();
		va.files.set(".obsidian/app.json", '{"from":"A"}');
		await start(host, id, spaceId, "A", { ...NO_CONFIG, core: true }, va);
		const vb = new MemoryVault();
		vb.files.set(".obsidian/app.json", '{"from":"B"}');
		const b = await start(host, id, spaceId, "B", NO_CONFIG, vb);
		await new Promise((r) => setTimeout(r, 500));
		await b.engine.idle();
		expect(b.vault.files.get(".obsidian/app.json")).toBe('{"from":"B"}');
	});
});
