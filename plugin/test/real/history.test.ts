// Point-in-time history from the host's retained update log (protocol.md "History").
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { noteHistory, pointText, restoreNoteText } from "../../src/core/history";
import { eventually } from "../helpers";
import { claimAdmin, startDevice, startServer, type Device, type RealServer } from "./server";

let server: RealServer;
let devices: Device[] = [];

beforeEach(async () => {
	server = await startServer();
}, 120_000);
afterEach(async () => {
	await Promise.all(devices.map((d) => d.engine.stop()));
	devices = [];
	await server?.stop();
});

describe("point-in-time history (real server)", () => {
	it("offers the moment before a large deletion, even with no saved version, and restores it", async () => {
		const alex = await claimAdmin(server, "Alex");
		const a = await startDevice(server, alex, "a");
		const b = await startDevice(server, alex, "b");
		devices.push(a, b);
		await eventually(() => a.engine.primary.conn.features.has("update-log"), 10_000, "host advertises the log");
		const full = "# Ideas\n\n" + Array.from({ length: 30 }, (_, i) => `- idea number ${i}, worth keeping`).join("\n") + "\n";
		await a.vault.userWrite("ideas.md", full);
		await eventually(() => b.vault.files.get("ideas.md") === full, 10_000, "synced");
		await a.vault.userWrite("ideas.md", full + "- one more\n");
		await eventually(() => b.vault.files.get("ideas.md") === full + "- one more\n", 10_000, "edit synced");
		// Something (a bug, a mistake) wipes most of it on the other device.
		await b.vault.userWrite("ideas.md", "# Ideas\n");
		await eventually(() => a.vault.files.get("ideas.md") === "# Ideas\n", 10_000, "wipe synced");

		const mirror = a.engine.mirror!;
		const id = mirror.index.live().find((e) => e.path === "ideas.md")!.id;
		const points = await noteHistory(mirror.space, id);
		const before = points.find((p) => p.kind === "before-deletion");
		expect(before, JSON.stringify(points.map((p) => [p.kind, p.size]))).toBeTruthy();
		expect(await pointText(mirror.space, id, before!)).toBe(full + "- one more\n");
		await restoreNoteText(mirror, id, before!.text!);
		await eventually(() => b.vault.files.get("ideas.md") === full + "- one more\n", 10_000, "restore reaches b");
	});

	it("keeps the log after a saved version, so earlier points survive compaction", async () => {
		const alex = await claimAdmin(server, "Alex");
		const a = await startDevice(server, alex, "a");
		devices.push(a);
		await eventually(() => a.engine.primary.conn.features.has("update-log"), 10_000, "host advertises the log");
		await a.vault.userWrite("n.md", "first draft\n");
		const mirror = a.engine.mirror!;
		await eventually(() => mirror.index.live().some((e) => e.path === "n.md") && a.engine.currentStatus().unsent === 0, 10_000, "sent");
		const id = mirror.index.live().find((e) => e.path === "n.md")!.id;
		// Force a saved version (compaction) now.
		const doc = await mirror.space.acquireSynced(id);
		(doc as unknown as { putSnapshot(): void }).putSnapshot();
		mirror.space.release(id);
		await eventually(async () => (await noteHistory(mirror.space, id)).some((p) => p.kind === "version"), 10_000, "saved version");
		await a.vault.userWrite("n.md", "second draft, completely rewritten\n");
		const texts = async () => Promise.all((await noteHistory(mirror.space, id)).map((p) => pointText(mirror.space, id, p)));
		await eventually(async () => (await texts()).includes("second draft, completely rewritten\n"), 10_000, "the rewrite in history");
		// The first draft is still a restore point: the log before the saved version was kept.
		expect(await texts()).toContain("first draft\n");
	});
});
