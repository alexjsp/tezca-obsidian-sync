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

describe("settings files are known by their path", () => {
	const renamed = (v: MemoryVault) => [...v.files.keys()].filter((p) => p.startsWith(".obsidian/") && / \([A-Za-z0-9_-]{6}\)\.[a-z]+$/.test(p));
	const text = async (v: MemoryVault, p: string) => {
		const b = await v.readBinary(p);
		return b === null ? null : new TextDecoder().decode(b);
	};

	it("two devices that both have the same settings files end up with one of each, never renamed", async () => {
		const { host, id, spaceId } = await setupHost();
		const va = new MemoryVault();
		va.files.set(".obsidian/app.json", '{"from":"A"}');
		va.files.set(".obsidian/themes/T/manifest.json", '{"name":"T"}');
		va.files.set(".obsidian/themes/T/theme.css", "body{}");
		const vb = new MemoryVault();
		vb.files.set(".obsidian/app.json", '{"from":"B"}');
		vb.files.set(".obsidian/themes/T/manifest.json", '{"name":"T"}');
		vb.files.set(".obsidian/themes/T/theme.css", "body{}");
		// Both turn settings sync on at the same time: each imports its own copies first.
		const [a, b] = await Promise.all([start(host, id, spaceId, "A", ALL, va), start(host, id, spaceId, "B", ALL, vb)]);
		await converged(a, b);
		await eventually(async () => (await text(va, ".obsidian/app.json")) === (await text(vb, ".obsidian/app.json")), 5000, "same app.json");
		expect(renamed(va)).toEqual([]);
		expect(renamed(vb)).toEqual([]);
		expect(await text(va, ".obsidian/themes/T/manifest.json")).toBe('{"name":"T"}');
		expect(await text(vb, ".obsidian/themes/T/manifest.json")).toBe('{"name":"T"}');
		// The device whose app.json lost kept its old one as a safety copy.
		const winner = await text(va, ".obsidian/app.json");
		const loser = winner === '{"from":"A"}' ? vb : va;
		const kept = [...loser.backups.values()].map((v) => (typeof v === "string" ? v : new TextDecoder().decode(v)));
		expect(kept).toContain(winner === '{"from":"A"}' ? '{"from":"B"}' : '{"from":"A"}');
	});

	it("repairs settings files that an earlier version renamed to \"name (id)\"", async () => {
		const { host, id, spaceId } = await setupHost();
		const va = new MemoryVault();
		va.files.set(".obsidian/app.json", '{"spellcheck":true}');
		va.files.set(".obsidian/themes/T/manifest.json", '{"name":"T"}');
		const a = await start(host, id, spaceId, "A", ALL, va);
		const b = await start(host, id, spaceId, "B", ALL);
		await converged(a, b);
		// What 0.3.x did: app.json renamed out of the way, and a second manifest entry renamed.
		// (With the repair off, so the bad state reaches both disks as it did then.)
		type Repairable = { repairRenamedConfig(): void };
		const mirrors = [a, b].map((c) => c.engine.mirror as unknown as Repairable);
		for (const m of mirrors) m.repairRenamedConfig = () => undefined;
		const idx = a.engine.mirror!.index;
		const app = idx.live().find((e) => e.path === ".obsidian/app.json")!;
		const man = idx.live().find((e) => e.path === ".obsidian/themes/T/manifest.json")!;
		const { conflictPath } = await import("../src/core/index-model");
		idx.setPath(app.id, conflictPath(app.path, app.id), "test");
		const dupId = "dupDupDupDupDupDup";
		idx.create(dupId, conflictPath(man.path, dupId), "blob", "test");
		idx.setBlob(dupId, man.blob!, "test");
		await eventually(() => renamed(b.vault).length === 2, 5000, "B has the renamed files on disk");
		expect(b.vault.files.has(".obsidian/app.json")).toBe(false);
		// With the fix, the next index change puts them right (as the next startup would).
		for (const m of mirrors) delete (m as Partial<Repairable>).repairRenamedConfig;
		await a.vault.userWrite("poke.md", "x");
		await eventually(() => renamed(a.vault).length === 0 && renamed(b.vault).length === 0, 8000, "repaired");
		// The duplicate that was removed on B was kept as a safety copy first.
		expect([...b.vault.backups.keys()].some((k) => k.endsWith("/.obsidian/themes/T/manifest (dupDup).json")), JSON.stringify([...b.vault.backups.keys()])).toBe(true);
		for (const v of [a.vault, b.vault]) {
			expect(await text(v, ".obsidian/app.json")).toBe('{"spellcheck":true}');
			expect(await text(v, ".obsidian/themes/T/manifest.json")).toBe('{"name":"T"}');
		}
	});

	it("repair keeps the real copy over an empty placeholder whose upload never finished", async () => {
		const { host, id, spaceId } = await setupHost();
		const va = new MemoryVault();
		va.files.set(".obsidian/themes/Things/manifest.json", '{"name":"Things"}');
		const a = await start(host, id, spaceId, "A", ALL, va);
		const b = await start(host, id, spaceId, "B", ALL);
		await converged(a, b);
		type Repairable = { repairRenamedConfig(): void };
		const mirrors = [a, b].map((c) => c.engine.mirror as unknown as Repairable);
		for (const m of mirrors) m.repairRenamedConfig = () => undefined;
		// 0.3.x state: the real manifest renamed away, and a content-less entry at the real path.
		const idx = a.engine.mirror!.index;
		const man = idx.live().find((e) => e.path === ".obsidian/themes/Things/manifest.json")!;
		const { conflictPath } = await import("../src/core/index-model");
		idx.setPath(man.id, conflictPath(man.path, man.id), "test");
		idx.create("ghostGhostGhostGho", ".obsidian/themes/Things/manifest.json", "blob", "test");
		await eventually(() => renamed(b.vault).length === 1, 5000, "B has the renamed manifest");
		for (const m of mirrors) delete (m as Partial<Repairable>).repairRenamedConfig;
		await a.vault.userWrite("poke.md", "x");
		await eventually(async () => (await text(b.vault, ".obsidian/themes/Things/manifest.json")) === '{"name":"Things"}' && renamed(b.vault).length === 0, 8000, "the real manifest is back");
		expect(await text(a.vault, ".obsidian/themes/Things/manifest.json")).toBe('{"name":"Things"}');
	});

	it("reinstalling a theme another device installed updates it in place", async () => {
		const { host, id, spaceId } = await setupHost();
		const va = new MemoryVault();
		va.files.set(".obsidian/themes/T/manifest.json", '{"version":"1"}');
		va.files.set(".obsidian/themes/T/theme.css", "v1");
		const a = await start(host, id, spaceId, "A", ALL, va);
		const b = await start(host, id, spaceId, "B", ALL);
		await converged(a, b);
		// B (re)installs a newer version of the theme.
		await b.vault.userWriteBinary(".obsidian/themes/T/manifest.json", new TextEncoder().encode('{"version":"2"}'));
		await b.vault.userWriteBinary(".obsidian/themes/T/theme.css", new TextEncoder().encode("v2"));
		await eventually(async () => (await text(va, ".obsidian/themes/T/manifest.json")) === '{"version":"2"}', 5000, "A gets it");
		await converged(a, b);
		expect(renamed(va)).toEqual([]);
		expect(renamed(vb(b))).toEqual([]);
		expect(await text(va, ".obsidian/themes/T/theme.css")).toBe("v2");
	});
});

const vb = (c: Client) => c.vault;
