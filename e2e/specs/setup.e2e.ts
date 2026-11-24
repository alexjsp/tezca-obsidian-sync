// The other ways in and out: restoring with the recovery phrase, a second synced vault for the
// same person, and disconnecting a vault.
import assert from "node:assert/strict";
import { Device } from "../support/device";
import { claimHost, pasteSetupLink } from "../support/flows";
import { TezcaServer } from "../support/server";
import { listFiles, waitConverged } from "../support/vault";
import { sleep, waitFor } from "../support/wait";

describe("setup: recovery phrase, second vault, disconnect", function () {
	let server: TezcaServer;
	let mac: Device;
	let restored: Device;
	let other: Device;

	before(async function () {
		server = await TezcaServer.start();
		[mac, restored, other] = await Promise.all([Device.launch("mac"), Device.launch("new-laptop"), Device.launch("other-vault", { mobile: true })]);
		await claimHost(mac, server);
		await mac.write("Notes/Important.md", "Don't lose me.\n");
		await mac.waitSynced();
	});

	after(async function () {
		for (const d of [mac, restored, other]) await d?.quit();
		await server?.stop();
	});

	it("restores access on a new device from the recovery phrase", async function () {
		await mac.command("tezca-sync:show-recovery-phrase");
		await mac.choose("Show recovery phrase?", "Show");
		const m = await mac.modal("Your recovery phrase");
		const words: string[] = [];
		for (const w of await m.$$(".tezca-phrase > div")) words.push((await w.getText()).replace(/^\d+\.\s*/, ""));
		assert.equal(words.length, 24);
		await mac.closeModals();

		await restored.openSettings();
		await restored.clickButton("Restore");
		const form = await restored.modal("Restore with recovery phrase");
		await (await form.$("input[type=text]")).setValue(server.url);
		await (await form.$("textarea")).setValue(words.join(" "));
		await restored.clickButton("Continue", form);
		const vaultName = await mac.exec(({ app }) => app.vault.getName());
		await restored.choose("Choose a synced vault", vaultName);
		await restored.closeSettings();
		await restored.waitForFile("Notes/Important.md", "Don't lose me.\n");
		await restored.write("Notes/From the new laptop.md", "Back in.\n");
		await mac.waitForFile("Notes/From the new laptop.md", "Back in.\n");
		// Same identity as the mac.
		const fp = (d: Device) => d.exec(({ plugins }) => plugins.tezcaSync.identityFingerprint());
		assert.equal(await fp(restored), await fp(mac));
	});

	it("sets up a separate synced vault for the same person", async function () {
		await mac.openSettings();
		await mac.clickButton("Create link");
		const link = await mac.takeLink("Set up another synced vault");
		await mac.closeSettings();
		await pasteSetupLink(other, link);
		const name = await other.exec(({ app }) => app.vault.getName());
		await other.choose("Choose a synced vault", `New synced vault "${name}"`);
		await other.closeSettings();
		await other.waitSynced();
		await other.write("Separate.md", "In the other vault.\n");
		await other.waitSynced();
		await sleep(2_000);
		assert.equal(mac.exists("Separate.md"), false, "the vaults don't mix");
		assert.equal(other.exists("Notes/Important.md"), false);
		// A device restored into the second vault would see it: it's listed as a vault of this identity.
		const vaults = await mac.exec(async ({ plugins }) => {
			const conn = plugins.tezcaSync.engine.conn;
			const res = await conn.request((rid: number) => ({ case: "listSpaces", value: { rid } }), "spaceList");
			return res.spaces.filter((s: { kind: number }) => s.kind === 1).length;
		});
		assert.equal(vaults, 2);
	});

	it("disconnecting stops syncing and keeps the files", async function () {
		await restored.openSettings();
		await restored.clickButton("Disconnect");
		await restored.choose("Disconnect this vault?", "Disconnect");
		await restored.closeSettings();
		await waitFor(async () => !(await restored.status()).configured, { what: "disconnected" });
		const text = await restored.exec(() => document.querySelector(".tezca-status")?.textContent);
		assert.equal(text, "Tezca: not set up");
		await mac.write("After disconnect.md", "Not for the laptop.\n");
		await mac.waitSynced();
		await restored.write("Notes/Local only.md", "Stays here.\n");
		await sleep(3_000);
		assert.equal(restored.exists("After disconnect.md"), false);
		assert.equal(mac.exists("Notes/Local only.md"), false);
		assert.ok(restored.exists("Notes/Important.md"), "files are kept");
		assert.ok(listFiles(mac.vaultPath).includes("Notes/From the new laptop.md"), "nothing was deleted on the mac");
		await waitConverged([mac]);
	});
});
