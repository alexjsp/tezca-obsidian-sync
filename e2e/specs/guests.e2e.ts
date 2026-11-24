// Joining a shared folder without being a member of its host: Carol has no Tezca setup at all
// (joins as a guest), Dave runs his own host (joins across hosts).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Device } from "../support/device";
import { claimHost, openDeepLink } from "../support/flows";
import { TezcaServer } from "../support/server";
import { waitConverged } from "../support/vault";
import { sleep, waitFor } from "../support/wait";

describe("guests and cross-host shares", function () {
	let aliceHost: TezcaServer;
	let daveHost: TezcaServer;
	let alice: Device;
	let carol: Device;
	let dave: Device;

	before(async function () {
		[aliceHost, daveHost] = await Promise.all([TezcaServer.start({ TEZCA_GUEST_QUOTA_MB: "1" }), TezcaServer.start()]);
		[alice, carol, dave] = await Promise.all([Device.launch("alice"), Device.launch("carol", { mobile: true }), Device.launch("dave")]);
		await claimHost(alice, aliceHost);
		await claimHost(dave, daveHost);
		await alice.write("Club/Rules.md", "1. Be nice.\n");
		await alice.write("Alice only.md", "Private.\n");
		await alice.waitSynced();
		await alice.contextMenu("Club", "Share folder…");
		await alice.choose('Share "Club"?', "Share folder");
		await alice.modal("Shared folder: Club");
		await alice.closeModals();
	});

	after(async function () {
		for (const d of [alice, carol, dave]) await d?.quit();
		await aliceHost?.stop();
		await daveHost?.stop();
	});

	async function invite() {
		await alice.contextMenu("Club", "Manage shared folder…");
		const m = await alice.modal("Shared folder: Club");
		await alice.clickButton("Can edit", m);
		const link = await alice.takeLink('Invite to "Club"');
		await alice.closeModals();
		return link;
	}

	it("someone without Tezca joins as a guest; only the shared folder syncs", async function () {
		carol.writeOnDisk("Carol's diary.md", "Not for sharing.\n");
		await openDeepLink(carol, await invite());
		await carol.ackRecoveryKey();
		await carol.submitForm('Join "Club"', "Club", "Join");
		await carol.waitForFile("Club/Rules.md", "1. Be nice.\n");
		await carol.write("Club/Carol.md", "Hi from Carol.\n");
		await alice.waitForFile("Club/Carol.md", "Hi from Carol.\n");
		await alice.write("Club/Rules.md", "1. Be nice.\n2. Bring snacks.\n");
		await carol.waitForFile("Club/Rules.md", "1. Be nice.\n2. Bring snacks.\n");
		await sleep(2_000);
		assert.equal(alice.exists("Carol's diary.md"), false, "a guest's own notes stay on their device");
		assert.equal(carol.exists("Alice only.md"), false);
		await carol.openSettings();
		await carol.find(".tezca-settings-note", { text: /You're using Tezca as a guest/ });
		await carol.closeSettings();
	});

	it("a guest over their storage quota is told, and the file stays on their device", async function () {
		await carol.writeBinary("Club/Small photo.bin", randomBytes(200 * 1024));
		await alice.waitForFile("Club/Small photo.bin");
		await carol.writeBinary("Club/Huge video.bin", randomBytes(2 * 1024 * 1024));
		await waitFor(async () => (await carol.noticesSeen()).some((n) => n.includes("Huge video.bin") && n.includes("storage on this host is full")), {
			what: "a quota notice on Carol's device",
			detail: () => carol.noticesSeen(),
		});
		assert.equal(alice.exists("Club/Huge video.bin"), false);
		// Alice (a member, not a guest) isn't limited.
		await alice.writeBinary("Club/Alice video.bin", randomBytes(2 * 1024 * 1024));
		await carol.waitForFile("Club/Alice video.bin");
		await carol.delete("Club/Huge video.bin");
	});

	it("someone with their own host joins across hosts", async function () {
		await dave.write("Dave's notes.md", "On Dave's host.\n");
		await openDeepLink(dave, await invite());
		await dave.submitForm('Join "Club"', "Shared/Club", "Join");
		await dave.waitForFile("Shared/Club/Rules.md", "1. Be nice.\n2. Bring snacks.\n");
		await dave.write("Shared/Club/Dave.md", "Dave was here.\n");
		await alice.waitForFile("Club/Dave.md", "Dave was here.\n");
		await carol.waitForFile("Club/Dave.md", "Dave was here.\n");
		await waitConverged([alice, carol, dave], { under: ["Club", "Club", "Shared/Club"] });
		assert.equal(alice.exists("Dave's notes.md"), false, "Dave's private notes stay on his host");
		const hosts = await dave.exec(({ plugins }) => plugins.tezcaSync.engine.mounts.all().map((m: { host?: string }) => m.host ?? "own"));
		assert.deepEqual(hosts, [aliceHost.url]);
	});
});
