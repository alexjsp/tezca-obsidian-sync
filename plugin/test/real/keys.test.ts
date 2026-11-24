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
