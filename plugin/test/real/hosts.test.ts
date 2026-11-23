// Cross-host shares and guests (M4) against two real Go servers: protocol.md "Cross-host shares and guests".
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryVault } from "../../src/core/vault";
import { SpaceKind } from "../../src/proto/tezca/v1/sync_pb";
import { eventually } from "../helpers";
import { claimAdmin, hostlessGuest, startDevice, startServer, type Device, type RealServer, type User } from "./server";

let hostA: RealServer;
let hostB: RealServer;
let devices: Device[] = [];

beforeEach(async () => {
	[hostA, hostB] = await Promise.all([startServer(), startServer()]);
}, 120_000);
afterEach(async () => {
	await Promise.all(devices.map((d) => d.engine.stop()));
	devices = [];
	await Promise.all([hostA?.stop(), hostB?.stop()]);
});

async function device(server: RealServer, user: User, name: string, files: Record<string, string> = {}) {
	const vault = new MemoryVault();
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
const params = (link: string) => {
	const u = new URL(link.replace("obsidian://tezca", "http://x/"));
	return { host: u.searchParams.get("host")!, token: u.searchParams.get("token")!, k: u.searchParams.get("k")! };
};

describe("cross-host shares and guests (two real servers)", () => {
	it("a user with their own host joins a share on another host as a guest; all their devices mount it", async () => {
		const alex = await claimAdmin(hostA, "Alex");
		const sam = await claimAdmin(hostB, "Sam");
		const a = await device(hostA, alex, "a", { "Book Club/list.md": "1. Dune\n" });
		const spaceId = await a.engine.shareFolder("Book Club", "Book Club");
		await eventually(() => a.engine.shares.has(spaceId), 10_000, "mounted");
		await a.engine.idle();

		const s1 = await device(hostB, sam, "s1", { "Sam private.md": "on host B" });
		const s2 = await device(hostB, sam, "s2");
		const link = params(await a.engine.createInvite(spaceId, "editor"));
		expect(link.host).toBe(hostA.url);
		const mounted = await s1.engine.joinShare(link.token, link.k, async () => "Book Club", link.host);
		expect(mounted).toBe("Book Club");
		await eventually(() => text(s1, "Book Club/list.md") === "1. Dune\n", 10_000, "Sam's first device gets the share");
		await eventually(() => text(s2, "Book Club/list.md") === "1. Dune\n", 15_000, "Sam's second device mounts it too");
		expect(s1.engine.shares.get(spaceId)!.host).toBe(hostA.url);

		await s2.vault.userWrite("Book Club/list.md", "1. Dune\n2. Piranesi\n");
		await eventually(() => text(a, "Book Club/list.md") === "1. Dune\n2. Piranesi\n", 10_000, "edit crosses hosts");
		// Sam's private vault stays on host B; Alex never sees it.
		await eventually(() => text(s2, "Sam private.md") === "on host B", 10_000, "Sam's private sync on B");
		expect(a.vault.files.has("Sam private.md")).toBe(false);
		// Alex sees Sam as a member, named from Sam's profile.
		await eventually(() => a.engine.members(spaceId).some((m) => m.name === "Sam"), 10_000, "Sam's profile");
	});

	it("someone with no host joins as a guest: only shares sync, their own files stay local, and they can pair devices", async () => {
		const alex = await claimAdmin(hostA, "Alex");
		const a = await device(hostA, alex, "a", { "Family/recipes.md": "Pancakes" });
		const spaceId = await a.engine.shareFolder("Family", "Family");
		await eventually(() => a.engine.shares.has(spaceId), 10_000, "mounted");
		await a.engine.idle();

		const link = await a.engine.createInvite(spaceId, "editor");
		const gus = await hostlessGuest(hostA, "Gus", link);
		const g1 = await device(hostA, gus, "g1", { "diary.md": "private, never uploaded" });
		expect(g1.engine.isProfile).toBe(true);
		expect(g1.engine.space!.info.kind).toBe(SpaceKind.PROFILE);
		const p = params(link);
		await g1.engine.joinShare(p.token, p.k, async () => "Family", p.host); // same key: idempotent
		await eventually(() => text(g1, "Family/recipes.md") === "Pancakes", 10_000, "guest gets the share");

		await g1.vault.userWrite("Family/recipes.md", "Pancakes\nWaffles");
		await eventually(() => text(a, "Family/recipes.md") === "Pancakes\nWaffles", 10_000, "guest edit reaches Alex");

		// A second device of the guest (paired through host A) mounts the same share.
		const g2 = await device(hostA, gus, "g2");
		await eventually(() => text(g2, "Family/recipes.md") === "Pancakes\nWaffles", 15_000, "guest's second device");
		// The guest's own files are never uploaded anywhere.
		await g1.engine.idle();
		expect(g2.vault.files.has("diary.md")).toBe(false);
		expect(g1.engine.space!.index.ydoc.getMap("files").size).toBe(0);
		// Guests can't create shares.
		await expect(g1.engine.shareFolder("Family", "x")).rejects.toThrow();
	});
});
