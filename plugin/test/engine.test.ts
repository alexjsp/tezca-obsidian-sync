import { afterEach, describe, expect, it } from "vitest";
import { compaction } from "../src/core/doc-sync";
import { SyncEngine } from "../src/core/engine";
import { MemoryStore } from "../src/core/store";
import { MemoryVault } from "../src/core/vault";
import { converged, eventually, setupHost, snapshotVault, startClient, type Client } from "./helpers";

let clients: Client[] = [];
afterEach(async () => {
	await Promise.all(clients.map((c) => c.engine.stop()));
	clients = [];
});

async function pair(seed?: { a?: Record<string, string>; b?: Record<string, string> }) {
	const { host, id, spaceId } = await setupHost();
	const va = new MemoryVault();
	for (const [p, c] of Object.entries(seed?.a ?? {})) {
		va.files.set(p, c);
		const dir = p.split("/").slice(0, -1).join("/");
		if (dir) va.folders.add(dir);
	}
	const a = await startClient(host, id, spaceId, "A", va);
	clients.push(a);
	const vb = new MemoryVault();
	for (const [p, c] of Object.entries(seed?.b ?? {})) vb.files.set(p, c);
	const b = await startClient(host, id, spaceId, "B", vb);
	clients.push(b);
	return { host, id, spaceId, a, b };
}

describe("sync engine (mock host)", () => {
	it("uploads an existing vault and materialises it on a fresh device", async () => {
		const { a, b } = await pair({ a: { "Welcome.md": "# hi\n", "notes/one.md": "one", "notes/deep/two.md": "two" } });
		await converged(a, b);
		expect(snapshotVault(b.vault)).toEqual({ "Welcome.md": "# hi\n", "notes/deep/two.md": "two", "notes/one.md": "one" });
		expect(b.vault.folders.has("notes/deep")).toBe(true);
	});

	it("propagates creates, edits, renames and deletes live", async () => {
		const { a, b } = await pair();
		await a.vault.userWrite("x.md", "first");
		await converged(a, b);
		expect(b.vault.files.get("x.md")).toBe("first");

		await b.vault.userWrite("x.md", "first, then edited on B");
		await converged(a, b);
		expect(a.vault.files.get("x.md")).toBe("first, then edited on B");

		await a.vault.rename("x.md", "folder/y.md");
		await converged(a, b);
		expect(b.vault.files.has("x.md")).toBe(false);
		expect(b.vault.files.get("folder/y.md")).toBe("first, then edited on B");

		await b.vault.remove("folder/y.md");
		await converged(a, b);
		expect(a.vault.files.has("folder/y.md")).toBe(false);
	});

	it("renames folders with their contents", async () => {
		const { a, b } = await pair({ a: { "proj/a.md": "A", "proj/sub/b.md": "B" } });
		await converged(a, b);
		await a.vault.rename("proj", "archive/proj");
		await converged(a, b);
		expect(snapshotVault(b.vault)).toEqual({ "archive/proj/a.md": "A", "archive/proj/sub/b.md": "B" });
	});

	it("merges concurrent edits to the same note", async () => {
		const { a, b } = await pair({ a: { "n.md": "alpha\n\nbeta\n\ngamma\n" } });
		await converged(a, b);
		await Promise.all([a.vault.userWrite("n.md", "ALPHA\n\nbeta\n\ngamma\n"), b.vault.userWrite("n.md", "alpha\n\nbeta\n\ngamma\n\ndelta\n")]);
		await converged(a, b);
		expect(a.vault.files.get("n.md")).toBe("ALPHA\n\nbeta\n\ngamma\n\ndelta\n");
	});

	it("syncs offline edits from both sides after reconnect", async () => {
		const { host, a, b } = await pair({ a: { "n.md": "one\n\ntwo\n\nthree\n" } });
		await converged(a, b);
		host.dropAll();
		const realWs = host.WebSocket;
		void realWs;
		await a.vault.userWrite("n.md", "ONE\n\ntwo\n\nthree\n");
		await b.vault.userWrite("n.md", "one\n\ntwo\n\nthree\n\nfour\n");
		await b.vault.userWrite("b-only.md", "made offline");
		await converged(a, b);
		expect(a.vault.files.get("n.md")).toBe("ONE\n\ntwo\n\nthree\n\nfour\n");
		expect(a.vault.files.get("b-only.md")).toBe("made offline");
	});

	it("restart: picks up edits made while the plugin was not running", async () => {
		const { host, id, spaceId, a, b } = await pair({ a: { "n.md": "base\n" } });
		await converged(a, b);
		await b.engine.stop();
		clients = clients.filter((c) => c !== b);
		// Edit on disk while B is "closed", and edit remotely on A.
		b.vault.files.set("n.md", "base\nlocal line\n");
		b.vault.files.set("new-offline.md", "created while closed");
		await a.vault.userWrite("other.md", "from A");
		await a.engine.idle();
		const b2 = await startClient(host, id, spaceId, "B", b.vault, b.store);
		clients.push(b2);
		await converged(a, b2);
		expect(a.vault.files.get("n.md")).toBe("base\nlocal line\n");
		expect(a.vault.files.get("new-offline.md")).toBe("created while closed");
		expect(b2.vault.files.get("other.md")).toBe("from A");
	});

	it("restart: a file deleted while closed is deleted everywhere (no resurrection)", async () => {
		const { host, id, spaceId, a, b } = await pair({ a: { "gone.md": "bye", "keep.md": "keep" } });
		await converged(a, b);
		await b.engine.stop();
		clients = clients.filter((c) => c !== b);
		b.vault.files.delete("gone.md");
		const b2 = await startClient(host, id, spaceId, "B", b.vault, b.store);
		clients.push(b2);
		await converged(a, b2);
		expect(a.vault.files.has("gone.md")).toBe(false);
		expect(b2.vault.files.has("gone.md")).toBe(false);
	});

	it("restart: deleted while closed, but edited remotely meanwhile → edit wins", async () => {
		const { host, id, spaceId, a, b } = await pair({ a: { "n.md": "v1" } });
		await converged(a, b);
		await b.engine.stop();
		clients = clients.filter((c) => c !== b);
		b.vault.files.delete("n.md");
		await a.vault.userWrite("n.md", "v2 from A");
		await a.engine.idle();
		await eventually(() => true, 300);
		const b2 = await startClient(host, id, spaceId, "B", b.vault, b.store);
		clients.push(b2);
		await converged(a, b2);
		expect(b2.vault.files.get("n.md")).toBe("v2 from A");
	});

	it("remote delete of a locally modified (unsynced) file revives it", async () => {
		const { host, id, spaceId, a, b } = await pair({ a: { "n.md": "v1" } });
		await converged(a, b);
		await b.engine.stop();
		clients = clients.filter((c) => c !== b);
		b.vault.files.set("n.md", "v1 + local edit while closed");
		await a.vault.remove("n.md");
		await a.engine.idle();
		await eventually(() => true, 300);
		const b2 = await startClient(host, id, spaceId, "B", b.vault, b.store);
		clients.push(b2);
		await converged(a, b2);
		expect(a.vault.files.get("n.md")).toBe("v1 + local edit while closed");
	});

	it("new device with pre-existing different content keeps the synced version and preserves the local one", async () => {
		const { host, id, spaceId, a } = await pair({ a: { "n.md": "server version" } });
		await a.engine.idle();
		const vc = new MemoryVault();
		vc.files.set("n.md", "my unrelated local version");
		const c = await startClient(host, id, spaceId, "C", vc, new MemoryStore());
		clients.push(c);
		await converged(a, c);
		expect(c.vault.files.get("n.md")).toBe("server version");
		const conflict = [...c.vault.files.keys()].find((p) => p.includes("(conflict"));
		expect(conflict).toBeDefined();
		expect(c.vault.files.get(conflict!)).toBe("my unrelated local version");
		// conflict copies are local-only
		expect([...a.vault.files.keys()].some((p) => p.includes("(conflict"))).toBe(false);
	});

	it("concurrent creates at the same path resolve deterministically", async () => {
		const { host, a, b } = await pair();
		host.dropAll();
		await a.vault.userWrite("same.md", "from A");
		await b.vault.userWrite("same.md", "from B");
		await converged(a, b);
		const files = snapshotVault(a.vault);
		expect(Object.values(files).sort()).toEqual(["from A", "from B"]);
		expect(Object.keys(files)).toContain("same.md");
	});

	it("deleting the file at a collided path only deletes that file", async () => {
		const { host, a, b } = await pair();
		host.down = true;
		host.dropAll();
		await a.vault.userWrite("same.md", "lineage A");
		await b.vault.userWrite("same.md", "lineage B");
		await a.engine.idle();
		await b.engine.idle();
		host.down = false;
		a.engine.conn.reconnectNow();
		b.engine.conn.reconnectNow();
		// B deletes its file immediately, possibly before the collision is resolved on disk.
		await b.vault.remove("same.md");
		await converged(a, b);
		const all = Object.values(snapshotVault(a.vault));
		expect(all).toContain("lineage A");
		expect(all).not.toContain("lineage B");
	});

	it("a note created offline is uploaded after a restart that is also offline", async () => {
		const { host, id, spaceId, a, b } = await pair({ a: { "x.md": "x" } });
		await converged(a, b);
		host.down = true;
		host.dropAll();
		await a.vault.userWrite("offline.md", "made offline");
		await a.engine.idle();
		await a.engine.stop();
		clients = clients.filter((c) => c !== a);
		const a2 = await startClient(host, id, spaceId, "A", a.vault, a.store, undefined, 200);
		clients.push(a2);
		host.down = false;
		a2.engine.conn.reconnectNow();
		b.engine.conn.reconnectNow();
		await converged(a2, b);
		expect(b.vault.files.get("offline.md")).toBe("made offline");
	});

	it("keeps edits made while the startup reconcile is still running", async () => {
		const seed: Record<string, string> = {};
		for (let i = 0; i < 40; i++) seed[`n${String(i).padStart(2, "0")}.md`] = `note ${i}\n`;
		const { host, id, spaceId, a } = await pair({ a: seed });
		await converged(a);
		host.latency = 15; // a slow host keeps the new device's startup reconcile busy
		const vault = new MemoryVault();
		const engine = new SyncEngine({ host: "http://mock", identity: id, deviceId: "C", deviceName: "C", spaceId, store: new MemoryStore(), vault, clientVersion: "test", WebSocketImpl: host.WebSocket, http: host.http, startupWaitMs: 3000 });
		const starting = engine.start();
		// As soon as the reconcile has written the first note (and isn't done), the user edits it.
		await eventually(() => vault.files.has("n00.md"), 10_000, "first note written");
		expect(engine.mirror!.isReady).toBe(false);
		await vault.userWrite("n00.md", "note 0\ntyped during startup\n");
		await starting;
		const c = { name: "C", vault, store: new MemoryStore(), engine };
		clients.push(c);
		host.latency = 0;
		await converged(a, c);
		expect(a.vault.files.get("n00.md")).toBe("note 0\ntyped during startup\n");
	});

	it("a verify queued before a local delete doesn't bring the file back", async () => {
		const { a, b } = await pair({ a: { "n.md": "v1" } });
		await converged(a, b);
		const mirror = b.engine.mirror! as unknown as { enqueue(fn: () => Promise<void>): Promise<void> };
		// Keep B's mirror busy so the next two things queue up behind it, in this order:
		let release!: () => void;
		void mirror.enqueue(() => new Promise<void>((r) => (release = r)));
		await a.vault.userWrite("n.md", "v2 from A"); // 1. a remote edit → B queues a verify of n.md
		await new Promise((r) => setTimeout(r, 400));
		await b.vault.remove("n.md"); // 2. B deletes the file; its event queues after the verify
		await new Promise((r) => setTimeout(r, 50));
		release();
		await converged(a, b);
		expect(b.vault.files.has("n.md")).toBe(false);
		expect(a.vault.files.has("n.md")).toBe(false);
	});

	it("a rename made while sync is starting stays a rename (concurrent edits elsewhere survive)", async () => {
		const { host, id, spaceId, a, b } = await pair({ a: { "n.md": "base\n" } });
		await converged(a, b);
		await a.engine.stop();
		clients = clients.filter((c) => c !== a);
		host.latency = 40; // slow host: A's startup reconcile waits a while
		const engine = new SyncEngine({ host: "http://mock", identity: id, deviceId: "A", deviceName: "A", spaceId, store: a.store, vault: a.vault, clientVersion: "test", WebSocketImpl: host.WebSocket, http: host.http, startupWaitMs: 3000 });
		const starting = engine.start();
		await eventually(() => engine.mirror !== null, 3000, "mirror created");
		await new Promise((r) => setTimeout(r, 100));
		expect(engine.mirror!.isReady).toBe(false);
		await a.vault.rename("n.md", "renamed.md"); // during startup
		await b.vault.userWrite("n.md", "base\nedit from B\n"); // concurrently, on B
		await starting;
		host.latency = 0;
		const a2 = { ...a, engine };
		clients.push(a2);
		await converged(a2, b);
		expect(a2.vault.files.get("renamed.md")).toBe("base\nedit from B\n");
		expect(b.vault.files.has("n.md")).toBe(false);
		expect(engine.mirror!.index.live().filter((e) => e.kind === "md").length).toBe(1);
	});

	it("restart: a file moved (and edited) while closed stays the same note", async () => {
		const { host, id, spaceId, a, b } = await pair({ a: { "notes/n.md": "one\ntwo\nthree\nfour\n" } });
		await converged(a, b);
		await b.engine.stop();
		clients = clients.filter((c) => c !== b);
		// While B is closed: the file is moved and edited on disk; meanwhile A edits it too.
		const text = b.vault.files.get("notes/n.md") as string;
		b.vault.files.delete("notes/n.md");
		b.vault.files.set("archive/n.md", text + "five (moved and edited while closed)\n");
		b.vault.folders.add("archive");
		await a.vault.userWrite("notes/n.md", "ONE\ntwo\nthree\nfour\n");
		await a.engine.idle();
		const b2 = await startClient(host, id, spaceId, "B", b.vault, b.store);
		clients.push(b2);
		await converged(a, b2);
		expect(a.vault.files.has("notes/n.md")).toBe(false);
		expect(a.vault.files.get("archive/n.md")).toBe("ONE\ntwo\nthree\nfour\nfive (moved and edited while closed)\n");
		expect(a.engine.mirror!.index.live().filter((e) => e.kind === "md").length).toBe(1);
	});

	it("ignores hidden folders", async () => {
		const { a, b } = await pair({ a: { ".obsidian/app.json": "{}", "img.png": "binary", "ok.md": "ok" } });
		await converged(a, b);
		expect([...b.vault.files.keys()].sort()).toEqual(["img.png", "ok.md"]);
	});

	it("compacts long histories into snapshots and new devices load from them", async () => {
		compaction.updates = 10;
		const { host, id, spaceId, a, b } = await pair({ a: { "n.md": "" } });
		await converged(a, b);
		let text = "";
		for (let i = 0; i < 30; i++) {
			text += `line ${i}\n`;
			await a.vault.userWrite("n.md", text);
			await new Promise((r) => setTimeout(r, 15));
		}
		await converged(a, b);
		const space = [...host.spaces.values()][0];
		await eventually(() => [...space.docs.values()].some((d) => d.snapshot !== null), 8000, "snapshot");
		const c = await startClient(host, id, spaceId, "C");
		clients.push(c);
		await converged(a, c);
		expect(c.vault.files.get("n.md")).toBe(text);
		const d = [...space.docs.values()].find((x) => x.snapshot)!;
		expect(d.updates.every((u) => u.seq > d.snapshot!.baseSeq)).toBe(true);
		compaction.updates = 500;
	});
});
