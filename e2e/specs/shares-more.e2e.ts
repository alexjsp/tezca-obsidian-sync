// More shared-folder features: view-only and revoked invites, promoting to owner, history inside a
// share, moving the shared folder, moving a file out of it, and removing it from one vault.
import assert from "node:assert/strict";
import { Device } from "../support/device";
import { claimHost, dummyPlugin, installPluginFiles, inviteToHost, openDeepLink, pairDevice, setDisplayName } from "../support/flows";
import { TezcaServer } from "../support/server";
import { listFiles, waitConverged } from "../support/vault";
import { sleep, waitFor } from "../support/wait";

const gardenPlugin = dummyPlugin("garden-helper", "Garden helper");

describe("shares: more", function () {
	let server: TezcaServer;
	let alice: Device;
	let alice2: Device;
	let bob: Device;
	let mount = "Garden";

	before(async function () {
		server = await TezcaServer.start();
		[alice, alice2, bob] = await Promise.all([Device.launch("alice"), Device.launch("alice-laptop"), Device.launch("bob")]);
		await claimHost(alice, server);
		await setDisplayName(alice, "Alice");
		await pairDevice(alice, alice2);
		await inviteToHost(alice, bob);
		await setDisplayName(bob, "Bob");
		await alice.write("Garden/Plan.md", "# Garden plan\n");
		await alice.write("Garden/Seeds.md", "- Tomatoes\n");
		await alice2.waitForFile("Garden/Seeds.md");
		await alice.contextMenu("Garden", "Share folder…");
		await alice.choose('Share "Garden"?', "Share folder");
		await alice.modal("Shared folder: Garden");
		await alice.closeModals();
		await installPluginFiles(alice, gardenPlugin);
	});

	after(async function () {
		for (const d of [alice, alice2, bob]) await d?.quit();
		await server?.stop();
	});

	const role = (d: Device) => d.exec(({ plugins }) => plugins.tezcaSync.engine.roleIn(plugins.tezcaSync.engine.mounts.all()[0]?.spaceId));

	async function manage(d: Device) {
		await d.contextMenu(d === alice || d === alice2 ? mount : "Garden", "Manage shared folder…");
		return d.modal("Shared folder: Garden");
	}

	async function createInvite(kind: "Can edit" | "View only") {
		const m = await manage(alice);
		await alice.clickButton(kind, m);
		const link = await alice.takeLink('Invite to "Garden"');
		await alice.closeModals();
		return link;
	}

	it("a revoked invite can't be used", async function () {
		const link = await createInvite("Can edit");
		const m = await manage(alice);
		await alice.clickButton("Revoke", m);
		await waitFor(async () => !(await m.$("button=Revoke").isExisting()), { what: "the invite to go from the list" });
		await alice.closeModals();
		await openDeepLink(bob, link);
		await waitFor(async () => (await bob.noticesSeen()).some((n) => n.startsWith("Tezca:") && !n.includes("connected")), {
			what: "an error notice on Bob's device",
			detail: () => bob.noticesSeen(),
		});
		assert.equal(await bob.modalTitles().then((t) => t.some((x) => x.includes("Join"))), false);
		assert.equal(await bob.exec(({ plugins }) => plugins.tezcaSync.engine.mounts.all().length), 0);
	});

	it("Alice recommends one of her plugins for the shared folder", async function () {
		const m = await manage(alice);
		const row = await alice.settingRow("None yet", m);
		await alice.click((await row.$("button=Choose…")) as unknown as WebdriverIO.Element);
		const choose = await alice.modal('Recommend plugins for "Garden"');
		await alice.setToggle(gardenPlugin.manifest.name, true, choose);
		await alice.clickButton("Save", choose);
		await alice.noModal("Recommend plugins");
		await alice.find(".setting-item-name", { within: ".modal", text: gardenPlugin.manifest.name });
		await alice.closeModals();
	});

	it("a view-only invite makes Bob a viewer from the start (and offers the recommended plugins)", async function () {
		// Bob's device can't download from GitHub in a test: stand in for the directory lookup
		// and Obsidian's download, and install the files the way Obsidian would.
		await bob.exec(
			({ app, plugins }, manifest, mainJs) => {
				const inst = plugins.tezcaSync.installer;
				inst.lookup = async () => "someone/garden-helper";
				inst.remoteManifest = async () => manifest;
				app.plugins.installPlugin = async (_repo: string, _version: string, m: { id: string }) => {
					const dir = `${app.vault.configDir}/plugins/${m.id}`;
					await app.vault.adapter.mkdir(dir);
					await app.vault.adapter.write(`${dir}/manifest.json`, JSON.stringify(manifest));
					await app.vault.adapter.write(`${dir}/main.js`, mainJs);
					return true;
				};
			},
			gardenPlugin.manifest,
			gardenPlugin.mainJs,
		);
		await openDeepLink(bob, await createInvite("View only"));
		await bob.submitForm('Join "Garden"', "Garden", "Join");
		const offer = await bob.modal('Plugins recommended for "Garden"', 40_000);
		await bob.clickButton("Install and enable", offer);
		await bob.noModal("Plugins recommended");
		await waitFor(() => bob.exec((_, flag) => !!(window as unknown as Record<string, unknown>)[flag], gardenPlugin.flag), { what: "the plugin running on Bob's device" });
		await bob.waitForFile("Garden/Seeds.md", "- Tomatoes\n");
		await waitFor(async () => (await role(bob)) === "viewer", { what: "Bob to be a viewer" });
		await bob.open("Garden/Seeds.md");
		await waitFor(() => bob.isEditorReadOnly(), { what: "read-only editor" });
	});

	it("an owner can make Bob an owner too, who can then invite people", async function () {
		const m = await manage(alice);
		// As a viewer Bob couldn't publish his name, so he's listed by key.
		const bobRow = await alice.find(".setting-item", { within: ".modal", text: /View-only members' names aren't shown/ });
		await (await bobRow.$("select")).selectByAttribute("value", "owner");
		await alice.closeModals();
		await waitFor(async () => (await role(bob)) === "owner", { what: "Bob to be an owner" });
		// Now he can write, his name appears.
		await waitFor(
			() => alice.exec(({ plugins }) => plugins.tezcaSync.engine.members(plugins.tezcaSync.engine.mounts.all()[0].spaceId).some((m: { name?: string }) => m.name === "Bob")),
			{ what: "Bob's name in the member list" },
		);
		// Bob opens the share's settings from the command palette.
		await bob.open("Garden/Seeds.md");
		await bob.command("tezca-sync:manage-share");
		const bm = await bob.modal("Shared folder: Garden");
		await bob.clickButton("Can edit", bm);
		const link = await bob.takeLink('Invite to "Garden"');
		assert.match(link, /do=share/);
		await bob.closeModals();
		await waitFor(() => bob.isEditorReadOnly().then((r) => !r), { what: "Bob can edit now" });
	});

	it("history and Recently deleted work inside a shared folder", async function () {
		await bob.delete("Garden/Plan.md");
		await alice.waitGone("Garden/Plan.md");
		await alice.open("Garden/Seeds.md"); // the command uses the active file's shared folder
		await alice.command("tezca-sync:recently-deleted");
		const m = await alice.modal("Recently deleted");
		const row = await alice.settingRow("Plan.md", m);
		await alice.click((await row.$("button=Restore")) as unknown as WebdriverIO.Element);
		await alice.closeModals();
		await bob.waitForFile("Garden/Plan.md", "# Garden plan\n");
		await alice.waitForFile("Garden/Plan.md", "# Garden plan\n");
		await alice2.waitForFile("Garden/Plan.md", "# Garden plan\n");
	});

	it("moving the shared folder follows on the owner's other devices and doesn't affect others", async function () {
		await alice.rename("Garden", "Projects/Garden");
		mount = "Projects/Garden";
		await alice2.waitForFile("Projects/Garden/Seeds.md", "- Tomatoes\n");
		await alice2.waitGone("Garden");
		await alice.write("Projects/Garden/After the move.md", "Still shared.\n");
		await bob.waitForFile("Garden/After the move.md", "Still shared.\n");
		await waitConverged([alice, alice2, bob], { under: ["Projects/Garden", "Projects/Garden", "Garden"] });
		assert.deepEqual(await alice2.exec(({ plugins }) => plugins.tezcaSync.engine.mounts.all().map((m: { path: string }) => m.path)), ["Projects/Garden"]);
	});

	it("moving a file out of the shared folder makes it private (and says so)", async function () {
		await alice.rename("Projects/Garden/Seeds.md", "Seeds (mine).md");
		await waitFor(async () => (await alice.noticesSeen()).some((n) => n.includes("out of the shared folder")), { what: "a notice" });
		await bob.waitGone("Garden/Seeds.md");
		await alice2.waitForFile("Seeds (mine).md", "- Tomatoes\n");
		await sleep(1_000);
		assert.equal(bob.exists("Seeds (mine).md"), false);
	});

	it("deleting the shared folder on one person's devices removes it only for them", async function () {
		await bob.delete("Garden");
		await waitFor(async () => (await bob.noticesSeen()).some((n) => n.includes("was removed from this vault")), { what: "Bob's notice" });
		await waitFor(async () => (await bob.exec(({ plugins }) => plugins.tezcaSync.engine.mounts.all().length)) === 0, { what: "Bob's mount gone" });
		await sleep(3_000);
		assert.ok(alice.exists("Projects/Garden/Plan.md"), "Alice keeps everything");
		assert.ok(alice2.exists("Projects/Garden/After the move.md"));
		assert.ok(listFiles(alice.vaultPath).filter((f) => f.startsWith("Projects/Garden/")).length >= 2);
	});
});
