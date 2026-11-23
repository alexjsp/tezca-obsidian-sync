// Version history, restore and recently-deleted against the mock host.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { versioning } from "../src/core/doc-sync";
import { bytesFingerprint } from "../src/core/crypto";
import {
	blobVersions,
	deletedFiles,
	listNoteVersions,
	noteVersionText,
	restoreBlobVersion,
	restoreDeleted,
	restoreNoteText,
} from "../src/core/history";
import { MemoryVault } from "../src/core/vault";
import { converged, eventually, setupHost, startClient, type Client } from "./helpers";

let clients: Client[] = [];
const saved = { ...versioning };
beforeEach(() => {
	versioning.intervalMs = 0;
	versioning.quietMs = 50;
});
afterEach(async () => {
	Object.assign(versioning, saved);
	await Promise.all(clients.map((c) => c.engine.stop()));
	clients = [];
});

async function pair(seed: Record<string, string | Uint8Array> = {}) {
	const { host, id, spaceId } = await setupHost();
	const va = new MemoryVault();
	for (const [p, c] of Object.entries(seed)) va.files.set(p, c);
	const a = await startClient(host, id, spaceId, "A", va);
	const b = await startClient(host, id, spaceId, "B", new MemoryVault());
	clients.push(a, b);
	return { host, a, b };
}

const docOf = (c: Client, p: string) => c.engine.mirror!.docIdFor(p)!;

describe("history", () => {
	it("takes version snapshots after edits and restores an old version everywhere", async () => {
		const { a, b } = await pair({ "n.md": "first draft" });
		await converged(a, b);
		await a.vault.userWrite("n.md", "second draft");
		await converged(a, b);
		const id = docOf(a, "n.md");
		await eventually(async () => (await listNoteVersions(a.engine.space!, id)).length >= 1, 5000, "a version");
		await a.vault.userWrite("n.md", "third draft, oops");
		await converged(a, b);
		await eventually(async () => (await listNoteVersions(a.engine.space!, id)).length >= 2, 5000, "two versions");

		const versions = await listNoteVersions(b.engine.space!, id);
		const texts = await Promise.all(versions.map((v) => noteVersionText(b.engine.space!, id, v.baseSeq)));
		expect(texts[0]).toBe("third draft, oops");
		expect(texts).toContain("second draft");

		await restoreNoteText(b.engine.mirror!, id, "second draft");
		await converged(a, b);
		expect(a.vault.files.get("n.md")).toBe("second draft");
	});

	it("does not version the index or docs without local edits", async () => {
		const { a, b } = await pair({ "n.md": "x" });
		await converged(a, b);
		await new Promise((r) => setTimeout(r, 200));
		const versions = await listNoteVersions(a.engine.space!, "index");
		expect(versions).toEqual([]);
	});

	it("restores an earlier attachment version", async () => {
		const v1 = new Uint8Array([1, 1, 1]);
		const v2 = new Uint8Array([2, 2, 2]);
		const { a, b } = await pair({ "p.png": v1 });
		await converged(a, b);
		await a.vault.userWriteBinary("p.png", v2);
		await converged(a, b);
		const e = b.engine.mirror!.index.live().find((x) => x.path === "p.png")!;
		const [cur, old] = blobVersions(e);
		expect(cur.hash).toBe(bytesFingerprint(v2));
		restoreBlobVersion(b.engine.mirror!, e.id, old);
		await converged(a, b);
		expect(bytesFingerprint((await a.vault.readBinary("p.png"))!)).toBe(bytesFingerprint(v1));
		// The version it replaced is kept.
		expect(blobVersions(a.engine.mirror!.index.get(e.id)!).map((r) => r.hash)).toContain(bytesFingerprint(v2));
	});

	it("restores deleted notes and attachments", async () => {
		const { a, b } = await pair({ "dir/n.md": "keep me", "dir/p.png": new Uint8Array([7]) });
		await converged(a, b);
		await a.vault.remove("dir/n.md");
		await a.vault.remove("dir/p.png");
		await a.vault.remove("dir");
		await converged(a, b);
		expect(b.vault.files.has("dir/n.md")).toBe(false);
		const gone = deletedFiles(b.engine.mirror!);
		expect(gone.map((e) => e.path).sort()).toEqual(["dir/n.md", "dir/p.png"]);
		for (const e of gone) restoreDeleted(b.engine.mirror!, e.id);
		await converged(a, b);
		expect(a.vault.files.get("dir/n.md")).toBe("keep me");
		expect(bytesFingerprint((await a.vault.readBinary("dir/p.png"))!)).toBe(bytesFingerprint(new Uint8Array([7])));
	});
});
