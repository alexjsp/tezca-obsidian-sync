// Key trust (key-trust.ts): a host can't make clients encrypt with a key it chose.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { b64u, identityFromSeed, newSpaceKey, randomBytes, wrapKey } from "../../src/core/crypto";
import { makeCommitment } from "../../src/core/key-trust";
import type { SpaceSync } from "../../src/core/space";
import { eventually } from "../helpers";
import { claimAdmin, inviteMember, startDevice, startServer, type Device, type RealServer } from "./server";
import { linkParams } from "../../src/core/setup";

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

/** What a malicious host could send: a newer epoch whose key it chose, sealed to the victim. */
function inject(space: SpaceSync, boxPk: Uint8Array) {
	const evil = newSpaceKey();
	const epoch = space.info.epoch + 1;
	space.applyInfo({ ...space.info, epoch, keys: [...space.info.keys, { epoch, wrapped: wrapKey(evil, boxPk) }] } as never);
	return { epoch, evil };
}

describe("key trust (real server)", () => {
	it("never encrypts the private vault with a key the host chose", async () => {
		const alex = await claimAdmin(server, "Alex");
		const a = await startDevice(server, alex, "a");
		devices.push(a);
		const space = a.engine.root!.space;
		expect(space.currentEpoch()).toBe(0);
		// Its own key is committed in the vault's index, signed by the user.
		await eventually(() => space.index.ydoc.getMap("keys").has("0"), 5000, "commitment written");
		const { epoch } = inject(space, alex.id.boxPk);
		expect(space.canEncrypt(epoch)).toBe(false);
		expect(space.currentEpoch()).toBe(0);
		// A commitment signed by someone else doesn't help.
		const mallory = identityFromSeed(randomBytes(32));
		space.index.ydoc.getMap<string>("keys").set(String(epoch), JSON.stringify(makeCommitment(mallory, space.spaceId, epoch, space.keyFor(epoch))));
		expect(space.canEncrypt(epoch)).toBe(false);
		// Sync carries on under the real key.
		await a.vault.userWrite("n.md", "still private");
		await eventually(() => a.engine.currentStatus().unsent === 0, 5000, "sent");
	});

	it("trusts a shared folder's new key only when an owner it knew committed it", async () => {
		const alex = await claimAdmin(server, "Alex");
		const sam = await inviteMember(server, alex, "Sam");
		const a = await startDevice(server, alex, "a");
		const s = await startDevice(server, sam, "s");
		devices.push(a, s);
		await a.vault.userWrite("Team/x.md", "x");
		await eventually(() => a.engine.mirror!.index.live().some((e) => e.path === "Team/x.md"), 5000, "imported");
		const spaceId = await a.engine.shareFolder("Team", "Team");
		await eventually(() => a.engine.shares.has(spaceId), 10_000, "mounted");
		const link = await a.engine.createInvite(spaceId, "editor");
		const p = linkParams(link)!;
		await s.engine.joinShare(p.token!, p.k!, async () => "Team");
		await eventually(() => s.engine.shares.has(spaceId), 10_000, "joined");
		const space = s.engine.shares.get(spaceId)!.space;
		const before = space.currentEpoch();
		const { epoch } = inject(space, sam.id.boxPk);
		expect(space.canEncrypt(epoch)).toBe(false);
		expect(space.currentEpoch()).toBe(before);
		// A real rotation by the owner is accepted.
		await a.engine.rotateKey(spaceId);
		await eventually(() => space.currentEpoch() === before + 1 && space.canEncrypt(before + 1), 10_000, "real rotation trusted");
		expect(b64u(space.keyFor(before + 1))).toBe(b64u(a.engine.shares.get(spaceId)!.space.keyFor(before + 1)));
		// And content written under the new key reaches the member, both ways.
		await a.vault.userWrite("Team/after.md", "after the rotation");
		await eventually(() => s.vault.files.get("Team/after.md") === "after the rotation", 10_000, "new-key content reaches Sam");
		await s.vault.userWrite("Team/from-sam.md", "hi");
		await eventually(() => a.vault.files.get("Team/from-sam.md") === "hi", 10_000, "and back");
	});
});

describe("server identity pinning (real server)", () => {
	it("won't sign in to a host that presents a different server identity than before", async () => {
		const alex = await claimAdmin(server, "Alex");
		const a = await startDevice(server, alex, "a");
		devices.push(a);
		const key = `serverid/${server.url}`;
		expect(await a.store.get<string>(key)).toBeTruthy();
		await a.engine.stop();
		devices = [];
		// As if another server (or one relaying another host's login) now answered at this address.
		await a.store.put(key, "someOtherServerId");
		const a2 = await startDevice(server, alex, "a", a.vault, a.store).catch((e) => e as Error);
		if (!(a2 instanceof Error)) devices.push(a2);
		const status = a2 instanceof Error ? "unauthorized" : a2.engine.primary.conn.status;
		expect(status).toBe("unauthorized");
	});
});

describe("signed requests (real server)", () => {
	it("two identical requests in the same second both go through (the host accepts each signature once)", async () => {
		const alex = await claimAdmin(server, "Alex");
		const { HostApi } = await import("../../src/core/setup");
		const api = new HostApi(server.url);
		const [a, b] = await Promise.all([api.createInvite(alex.id), api.createInvite(alex.id)]);
		expect(a.token).toBeTruthy();
		expect(b.token).toBeTruthy();
		expect(a.token).not.toBe(b.token);
	});
});

describe("removing someone from the host (real server)", () => {
	it("cuts off all their devices and gives shared folders they were in a new key", async () => {
		const alex = await claimAdmin(server, "Alex");
		const sam = await inviteMember(server, alex, "Sam");
		const a = await startDevice(server, alex, "a");
		const s = await startDevice(server, sam, "s");
		devices.push(a, s);
		await a.vault.userWrite("Team/x.md", "x");
		await eventually(() => a.engine.mirror!.index.live().some((e) => e.path === "Team/x.md"), 5000, "imported");
		const spaceId = await a.engine.shareFolder("Team", "Team");
		await eventually(() => a.engine.shares.has(spaceId), 10_000, "shared");
		const p = linkParams(await a.engine.createInvite(spaceId, "editor"))!;
		await s.engine.joinShare(p.token!, p.k!, async () => "Team");
		await eventually(() => s.engine.shares.has(spaceId), 10_000, "joined");
		const users = await a.engine.primary.api.listUsers(alex.id);
		expect(users.map((u) => u.role).sort()).toEqual(["admin", "member"]);
		const epoch = a.engine.shares.get(spaceId)!.space.currentEpoch();

		await a.engine.removeHostUser(sam.id.signPk);
		await eventually(() => s.engine.primary.conn.status === "unauthorized" || s.engine.primary.conn.status === "offline", 10_000, "Sam cut off");
		await eventually(() => a.engine.shares.get(spaceId)!.space.currentEpoch() === epoch + 1, 10_000, "new key");
		expect((await a.engine.primary.api.listUsers(alex.id)).length).toBe(1);
		await a.vault.userWrite("Team/after.md", "secret");
		await new Promise((r) => setTimeout(r, 1000));
		expect(s.vault.files.has("Team/after.md")).toBe(false);
	});
});

describe("changing someone's host role (real server)", () => {
	it("a promoted member reconnects as an admin and can manage the host; the last admin can't step down", async () => {
		const alex = await claimAdmin(server, "Alex");
		const sam = await inviteMember(server, alex, "Sam");
		const s = await startDevice(server, sam, "s");
		devices.push(s);
		const { HostRole } = await import("../../src/proto/tezca/v1/sync_pb");
		await eventually(() => s.engine.primary.conn.authInfo?.role === HostRole.MEMBER, 10_000, "Sam online");
		const { HostApi } = await import("../../src/core/setup");
		const api = new HostApi(server.url);
		await expect(api.listUsers(sam.id)).rejects.toThrow();

		await api.setUserRole(alex.id, sam.id.signPk, "admin");
		await eventually(() => s.engine.primary.conn.authInfo?.role === HostRole.ADMIN, 15_000, "Sam reconnected as an admin");
		expect((await api.listUsers(sam.id)).length).toBe(2);

		await api.setUserRole(sam.id, alex.id.signPk, "member");
		await expect(api.setUserRole(sam.id, sam.id.signPk, "member")).rejects.toThrow(/at least one admin/);
		await expect(api.listUsers(alex.id)).rejects.toThrow();
	});
});
