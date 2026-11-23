// Attachment (blob) sync against the mock host: protocol.md "HTTP API" blobs + "Index document".
import { afterEach, describe, expect, it } from "vitest";
import { bytesFingerprint } from "../src/core/crypto";
import { MemoryVault } from "../src/core/vault";
import { converged, eventually, setupHost, startClient, type Client } from "./helpers";

let clients: Client[] = [];
afterEach(async () => {
	await Promise.all(clients.map((c) => c.engine.stop()));
	clients = [];
});

const bytes = (...xs: number[]) => new Uint8Array(xs);
function big(n: number, seed = 1): Uint8Array {
	const b = new Uint8Array(n);
	for (let i = 0; i < n; i++) b[i] = (i * 31 + seed) & 0xff;
	return b;
}
async function bin(v: MemoryVault, p: string) {
	const b = await v.readBinary(p);
	return b ? bytesFingerprint(b) : null;
}

async function pair(seed: Record<string, string | Uint8Array> = {}) {
	const { host, id, spaceId } = await setupHost();
	const va = new MemoryVault();
	for (const [p, c] of Object.entries(seed)) {
		va.files.set(p, c);
		const dir = p.split("/").slice(0, -1).join("/");
		if (dir) va.folders.add(dir);
	}
	const a = await startClient(host, id, spaceId, "A", va);
	clients.push(a);
	const b = await startClient(host, id, spaceId, "B", new MemoryVault());
	clients.push(b);
	return { host, id, spaceId, a, b };
}

function entryFor(c: Client, path: string) {
	return c.engine.mirror!.index.live().find((e) => e.path === path);
}

describe("blob sync", () => {
	it("uploads existing attachments encrypted and materialises them on a new device", async () => {
		const png = big(5000);
		const { host, a, b } = await pair({ "img/photo.png": png, "note.md": "![[photo.png]]" });
		await converged(a, b);
		expect(await bin(b.vault, "img/photo.png")).toBe(bytesFingerprint(png));
		expect(host.blobs.size).toBe(1);
		const stored = [...host.blobs.values()][0];
		// The host only ever holds ciphertext.
		expect(Buffer.from(stored).includes(Buffer.from(png.subarray(0, 64)))).toBe(false);
		expect(entryFor(b, "img/photo.png")?.kind).toBe("blob");
	});

	it("propagates edits, keeps earlier versions, renames and deletes", async () => {
		const { a, b } = await pair({ "a.pdf": bytes(1, 2, 3) });
		await converged(a, b);
		await b.vault.userWriteBinary("a.pdf", bytes(4, 5, 6, 7));
		await converged(a, b);
		expect(await bin(a.vault, "a.pdf")).toBe(bytesFingerprint(bytes(4, 5, 6, 7)));
		const e = entryFor(a, "a.pdf")!;
		expect(e.prev?.map((r) => r.hash)).toEqual([bytesFingerprint(bytes(1, 2, 3))]);

		await a.vault.rename("a.pdf", "docs/a.pdf");
		await converged(a, b);
		expect(await bin(b.vault, "docs/a.pdf")).toBe(bytesFingerprint(bytes(4, 5, 6, 7)));
		expect(b.vault.files.has("a.pdf")).toBe(false);

		await b.vault.remove("docs/a.pdf");
		await converged(a, b);
		expect(a.vault.files.has("docs/a.pdf")).toBe(false);
	});

	it("deduplicates identical content", async () => {
		const same = big(2000, 9);
		const { host, a, b } = await pair({ "x.png": same, "copy of x.png": same });
		await converged(a, b);
		expect(host.blobPuts).toBe(1);
		expect(await bin(b.vault, "copy of x.png")).toBe(bytesFingerprint(same));
	});

	it("uploads files created offline once the host is reachable", async () => {
		const { host, a, b } = await pair({ "n.md": "hi" });
		await converged(a, b);
		host.down = true;
		host.dropAll();
		await a.vault.userWriteBinary("offline.jpg", big(3000, 4));
		await new Promise((r) => setTimeout(r, 300));
		host.down = false;
		await converged(a, b);
		expect(await bin(b.vault, "offline.jpg")).toBe(bytesFingerprint(big(3000, 4)));
	});

	it("concurrent edits: one version wins everywhere, the other is kept as a local conflict copy", async () => {
		const { host, a, b } = await pair({ "f.bin": bytes(0) });
		await converged(a, b);
		host.down = true;
		host.dropAll();
		await a.vault.userWriteBinary("f.bin", bytes(1, 1));
		await b.vault.userWriteBinary("f.bin", bytes(2, 2));
		await new Promise((r) => setTimeout(r, 200));
		host.down = false;
		await converged(a, b);
		const winner = await bin(a.vault, "f.bin");
		expect(await bin(b.vault, "f.bin")).toBe(winner);
		expect([bytesFingerprint(bytes(1, 1)), bytesFingerprint(bytes(2, 2))]).toContain(winner);
		// The losing side's bytes survive in a conflict copy on that device.
		const copies = [...a.vault.files.keys(), ...b.vault.files.keys()].filter((p) => p.includes("(conflict"));
		expect(copies.length).toBe(1);
		expect(copies[0]).toMatch(/^f \(conflict .*\)\.bin$/);
	});

	it("a local edit beats a remote delete", async () => {
		const { host, a, b } = await pair({ "k.png": bytes(9) });
		await converged(a, b);
		host.down = true;
		host.dropAll();
		await a.vault.remove("k.png");
		await b.vault.userWriteBinary("k.png", bytes(9, 9));
		await new Promise((r) => setTimeout(r, 200));
		host.down = false;
		await converged(a, b);
		expect(await bin(a.vault, "k.png")).toBe(bytesFingerprint(bytes(9, 9)));
	});

	it("restart: picks up remote versions and offline deletes", async () => {
		const { host, id, spaceId, a, b } = await pair({ "keep.png": bytes(1), "gone.png": bytes(2) });
		await converged(a, b);
		await b.engine.stop();
		clients = clients.filter((c) => c !== b);
		b.vault.files.delete("gone.png");
		await a.vault.userWriteBinary("keep.png", bytes(1, 2, 3));
		await a.engine.idle();
		const b2 = await startClient(host, id, spaceId, "B", b.vault, b.store);
		clients.push(b2);
		await converged(a, b2);
		expect(await bin(b2.vault, "keep.png")).toBe(bytesFingerprint(bytes(1, 2, 3)));
		expect(a.vault.files.has("gone.png")).toBe(false);
	});

	it("an unsynced local edit follows a remote rename", async () => {
		const { a, b } = await pair({ "p.bin": bytes(1) });
		await converged(a, b);
		// B's upload of its edit is stuck (e.g. slow network) while A renames the file.
		const client = b.engine.mirror!.opts.blobs!;
		const realUpload = client.upload.bind(client);
		let blocked = true;
		client.upload = (...args) => (blocked ? Promise.reject(new Error("stuck")) : realUpload(...args));
		await b.vault.userWriteBinary("p.bin", bytes(1, 2));
		await new Promise((r) => setTimeout(r, 100));
		await a.vault.rename("p.bin", "moved/p.bin");
		await eventually(() => b.engine.mirror!.index.live().some((e) => e.path === "moved/p.bin"), 3000, "rename reaches B");
		await b.engine.idle();
		blocked = false;
		b.engine.mirror!.retryTransfers();
		await converged(a, b);
		expect(b.vault.files.has("p.bin")).toBe(false);
		expect(await bin(a.vault, "moved/p.bin")).toBe(bytesFingerprint(bytes(1, 2)));
	});

	it("renaming between Markdown and another extension changes the entry kind", async () => {
		const { a, b } = await pair({ "t.md": "text" });
		await converged(a, b);
		await a.vault.rename("t.md", "t.txt");
		await converged(a, b);
		expect(await b.vault.read("t.txt")).toBe("text");
		expect(b.vault.files.has("t.md")).toBe(false);
		expect(entryFor(b, "t.txt")?.kind).toBe("blob");
	});

	it("skips files over the host's size limit with a notice", async () => {
		const { host, a, b } = await pair({ "n.md": "x" });
		host.maxBlobBytes = 1000;
		// The engine reads the limit at start; simulate the host having said so.
		(a.engine as unknown as { maxBlobBytes: number }).maxBlobBytes = 1000;
		const notices: string[] = [];
		a.engine.notices.on((n) => notices.push(n.message));
		await a.vault.userWriteBinary("huge.mov", big(5000));
		await eventually(() => notices.some((m) => m.includes("huge.mov")), 3000, "size notice");
		await a.engine.idle();
		await b.engine.idle();
		expect(b.vault.files.has("huge.mov")).toBe(false);
		expect(host.blobs.size).toBe(0);
	});
});
