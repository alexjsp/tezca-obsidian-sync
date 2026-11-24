// Shared folders (M3) end to end against the real Go server: protocol.md "Shares (M3)".
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bytesFingerprint } from "../../src/core/crypto";
import { linkParams } from "../../src/core/setup";
import { MemoryVault } from "../../src/core/vault";
import { eventually } from "../helpers";
import { claimAdmin, inviteMember, startDevice, startServer, type Device, type RealServer, type User } from "./server";

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

async function device(user: User, name: string, files: Record<string, string | Uint8Array> = {}, vault = new MemoryVault()) {
	for (const [p, c] of Object.entries(files)) {
		vault.files.set(p, c);
		const parts = p.split("/");
		for (let i = 1; i < parts.length; i++) vault.folders.add(parts.slice(0, i).join("/"));
	}
	const d = await startDevice(server, user, name, vault);
	devices.push(d);
	return d;
}

const text = (d: Device, p: string) => d.vault.files.get(p);
const fp = (v: string | Uint8Array | undefined) => (v === undefined ? undefined : bytesFingerprint(typeof v === "string" ? new TextEncoder().encode(v) : v));
const idle = (...ds: Device[]) => Promise.all(ds.map((d) => d.engine.idle()));

/** Create an invite on `owner` and have `joiner` mount it at `path`. */
async function join(owner: Device, joiner: Device, spaceId: string, role: "editor" | "viewer", path: string) {
	const link = await owner.engine.createInvite(spaceId, role);
	const p = linkParams(link)!;
	const mounted = await joiner.engine.joinShare(p.token, p.k, async () => path);
	expect(mounted).toBe(path);
	await eventually(() => joiner.engine.shares.has(spaceId), 10_000, "share mounted");
}

describe("shared folders (real server)", () => {
	it("shares a folder: members and the owner's other devices sync it; private files stay private", async () => {
		const alex = await claimAdmin(server, "Alex");
		const sam = await inviteMember(server, alex, "Sam");
		const pic = new Uint8Array([1, 2, 3, 4]);
		const a1 = await device(alex, "a-mac", { "Family/plan.md": "# Plan\n", "Family/pic.png": pic, "Private.md": "mine" });
		const a2 = await device(alex, "a-phone");
		await eventually(() => text(a2, "Family/plan.md") === "# Plan\n", 10_000, "a2 has root files");

		const spaceId = await a1.engine.shareFolder("Family", "Family");
		await eventually(() => a1.engine.shares.has(spaceId) && a2.engine.shares.has(spaceId), 10_000, "both of Alex's devices mount the share");
		await idle(a1, a2);
		// Converting didn't delete or clobber anything on the owner's other device.
		expect(text(a2, "Family/plan.md")).toBe("# Plan\n");
		expect([...a2.vault.files.keys()].filter((p) => p.includes("(conflict"))).toEqual([]);

		const s1 = await device(sam, "s-laptop");
		await join(a1, s1, spaceId, "editor", "Shared/Family");
		await eventually(() => text(s1, "Shared/Family/plan.md") === "# Plan\n", 10_000, "Sam gets the note");
		await eventually(() => fp(s1.vault.files.get("Shared/Family/pic.png")) === fp(pic), 10_000, "Sam gets the attachment");
		expect(s1.vault.files.has("Private.md")).toBe(false);
		expect(s1.vault.files.has("Shared/Private.md")).toBe(false);

		// Edits flow both ways, including to the owner's second device.
		await s1.vault.userWrite("Shared/Family/plan.md", "# Plan\n- from Sam\n");
		await eventually(() => text(a1, "Family/plan.md") === "# Plan\n- from Sam\n" && text(a2, "Family/plan.md") === "# Plan\n- from Sam\n", 10_000, "Sam's edit reaches Alex");
		await a2.vault.userWrite("Family/new.md", "from Alex's phone");
		await eventually(() => text(s1, "Shared/Family/new.md") === "from Alex's phone", 10_000, "Alex's new note reaches Sam");

		// Profiles name the members.
		await eventually(() => a1.engine.members(spaceId).some((m) => m.name === "Sam"), 10_000, "Sam's profile");
		// The root space no longer holds the shared files (no duplicates in Alex's private space).
		const rootPaths = a1.engine.mirror!.index.live().map((e) => e.path);
		expect(rootPaths.some((p) => p.startsWith("Family/"))).toBe(false);
	});

	it("viewers can't change a share; their local edits are kept as conflict copies", async () => {
		const alex = await claimAdmin(server, "Alex");
		const vic = await inviteMember(server, alex, "Vic");
		const a = await device(alex, "a", { "Docs/x.md": "original" });
		const spaceId = await a.engine.shareFolder("Docs", "Docs");
		await eventually(() => a.engine.shares.has(spaceId), 10_000, "mounted");
		await idle(a);
		const v = await device(vic, "v");
		await join(a, v, spaceId, "viewer", "Docs");
		await eventually(() => text(v, "Docs/x.md") === "original", 10_000, "viewer has the file");
		await v.vault.userWrite("Docs/x.md", "viewer edit");
		await eventually(() => text(v, "Docs/x.md") === "original", 10_000, "viewer edit reverted");
		expect([...v.vault.files.keys()].some((p) => p.startsWith("Docs/x (conflict"))).toBe(true);
		await new Promise((r) => setTimeout(r, 500));
		expect(text(a, "Docs/x.md")).toBe("original");
		// The owner's edits still reach the viewer.
		await a.vault.userWrite("Docs/x.md", "owner edit");
		await eventually(() => text(v, "Docs/x.md") === "owner edit", 10_000, "owner edit reaches viewer");
	});

	it("a viewer made an editor publishes their name to the member list", async () => {
		const alex = await claimAdmin(server, "Alex");
		const vic = await inviteMember(server, alex, "Vic");
		const a = await device(alex, "a", { "Docs/x.md": "original" });
		const spaceId = await a.engine.shareFolder("Docs", "Docs");
		await eventually(() => a.engine.shares.has(spaceId), 10_000, "mounted");
		await idle(a);
		const v = await device(vic, "v");
		await join(a, v, spaceId, "viewer", "Docs");
		await idle(v);
		const named = () => a.engine.members(spaceId).some((m) => m.name === "Vic");
		expect(named()).toBe(false); // viewers can't write their profile
		await a.engine.setRole(spaceId, vic.id.signPk, "editor");
		await eventually(named, 10_000, "Vic's name appears");
	});

	it("removing a member rotates the key: the rest keep syncing, the removed member keeps their copy privately", async () => {
		const alex = await claimAdmin(server, "Alex");
		const sam = await inviteMember(server, alex, "Sam");
		const kim = await inviteMember(server, alex, "Kim");
		const a = await device(alex, "a", { "Team/notes.md": "v1" });
		const spaceId = await a.engine.shareFolder("Team", "Team");
		await eventually(() => a.engine.shares.has(spaceId), 10_000, "mounted");
		await idle(a);
		const s = await device(sam, "s");
		const k = await device(kim, "k");
		await join(a, s, spaceId, "editor", "Team");
		await join(a, k, spaceId, "editor", "Team");
		await eventually(() => text(s, "Team/notes.md") === "v1" && text(k, "Team/notes.md") === "v1", 10_000, "both joined");

		const epochBefore = a.engine.shares.get(spaceId)!.space.currentEpoch();
		await a.engine.removeMember(spaceId, sam.id.signPk);
		expect(a.engine.shares.get(spaceId)!.space.currentEpoch()).toBe(epochBefore + 1);
		await eventually(() => !s.engine.shares.has(spaceId), 10_000, "Sam unmounted");

		await a.vault.userWrite("Team/notes.md", "v2 after removal");
		await eventually(() => text(k, "Team/notes.md") === "v2 after removal", 10_000, "Kim still syncs under the new key");
		await k.vault.userWrite("Team/notes.md", "v3 from Kim");
		await eventually(() => text(a, "Team/notes.md") === "v3 from Kim", 10_000, "Alex gets Kim's edit");
		// Sam keeps what they had, now as a private file, and gets nothing new.
		await idle(s);
		expect(text(s, "Team/notes.md")).toBe("v1");
		await eventually(() => s.engine.mirror!.index.live().some((e) => e.path === "Team/notes.md"), 10_000, "Sam's copy is private now");
	});

	it("leaving a share keeps the files as private files", async () => {
		const alex = await claimAdmin(server, "Alex");
		const sam = await inviteMember(server, alex, "Sam");
		const a = await device(alex, "a", { "Trip/itinerary.md": "day 1" });
		const spaceId = await a.engine.shareFolder("Trip", "Trip");
		await eventually(() => a.engine.shares.has(spaceId), 10_000, "mounted");
		await idle(a);
		const s = await device(sam, "s");
		await join(a, s, spaceId, "editor", "Trip");
		await eventually(() => text(s, "Trip/itinerary.md") === "day 1", 10_000, "joined");
		await s.engine.leaveShare(spaceId);
		await eventually(() => !s.engine.shares.has(spaceId), 10_000, "left");
		await eventually(() => s.engine.mirror!.index.live().some((e) => e.path === "Trip/itinerary.md"), 10_000, "kept privately");
		expect(a.engine.members(spaceId).some((m) => !m.isMe)).toBe(false);
	});

	it("rejoining a share after leaving it works (at a new folder)", async () => {
		const alex = await claimAdmin(server, "Alex");
		const sam = await inviteMember(server, alex, "Sam");
		const a = await device(alex, "a", { "Trip/itinerary.md": "day 1" });
		const spaceId = await a.engine.shareFolder("Trip", "Trip");
		await eventually(() => a.engine.shares.has(spaceId), 10_000, "mounted");
		await idle(a);
		const s = await device(sam, "s");
		await join(a, s, spaceId, "editor", "Trip");
		await eventually(() => text(s, "Trip/itinerary.md") === "day 1", 10_000, "joined");
		await s.engine.leaveShare(spaceId);
		await eventually(() => !s.engine.shares.has(spaceId), 10_000, "left");
		await a.vault.userWrite("Trip/itinerary.md", "day 1\nday 2");
		await join(a, s, spaceId, "editor", "Trip again");
		await eventually(() => text(s, "Trip again/itinerary.md") === "day 1\nday 2", 10_000, "rejoined");
		await s.vault.userWrite("Trip again/new.md", "from Sam");
		await eventually(() => text(a, "Trip/new.md") === "from Sam", 10_000, "Sam's edit reaches Alex");
		expect(s.engine.mounts!.all().map((m) => m.path)).toEqual(["Trip again"]);
	});

	it("deleting the mount folder (even while closed) unmounts it without deleting anything for others", async () => {
		const alex = await claimAdmin(server, "Alex");
		const sam = await inviteMember(server, alex, "Sam");
		const a = await device(alex, "a", { "Club/rules.md": "be nice" });
		const spaceId = await a.engine.shareFolder("Club", "Club");
		await eventually(() => a.engine.shares.has(spaceId), 10_000, "mounted");
		await idle(a);
		const s = await device(sam, "s");
		await join(a, s, spaceId, "editor", "Club");
		await eventually(() => text(s, "Club/rules.md") === "be nice", 10_000, "joined");
		// Sam closes Obsidian, deletes the folder, reopens.
		await s.engine.stop();
		devices = devices.filter((d) => d !== s);
		s.vault.files.delete("Club/rules.md");
		s.vault.folders.delete("Club");
		const s2 = await startDevice(server, sam, "s", s.vault, s.store);
		devices.push(s2);
		await idle(s2, a);
		await new Promise((r) => setTimeout(r, 500));
		expect(s2.engine.shares.has(spaceId)).toBe(false);
		expect(text(a, "Club/rules.md")).toBe("be nice");
		expect(a.engine.shares.get(spaceId)!.mirror.index.live().map((e) => e.path)).toContain("rules.md");
	});

	it("moving the mount folder moves the mount on all of the user's devices", async () => {
		const alex = await claimAdmin(server, "Alex");
		const a1 = await device(alex, "a1", { "Proj/a.md": "A" });
		const a2 = await device(alex, "a2");
		const spaceId = await a1.engine.shareFolder("Proj", "Proj");
		await eventually(() => a2.engine.shares.has(spaceId) && text(a2, "Proj/a.md") === "A", 10_000, "a2 mounted");
		await idle(a1, a2);
		await a1.vault.rename("Proj", "Work/Proj");
		await eventually(() => a1.engine.shares.get(spaceId)?.mount === "Work/Proj", 10_000, "a1 remounted");
		await eventually(() => a2.engine.shares.get(spaceId)?.mount === "Work/Proj" && text(a2, "Work/Proj/a.md") === "A", 10_000, "a2 follows");
		// Nothing was deleted from the share by the move.
		expect(a1.engine.shares.get(spaceId)!.mirror.index.live().map((e) => e.path)).toContain("a.md");
		await a2.vault.userWrite("Work/Proj/a.md", "A2");
		await eventually(() => text(a1, "Work/Proj/a.md") === "A2", 10_000, "still syncing after the move");
	});
});
