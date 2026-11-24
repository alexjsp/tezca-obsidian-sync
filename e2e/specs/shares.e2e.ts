// Shared folders between two people on one host: Alice (admin, two desktops) shares a folder with
// Bob (a member of her host, on a phone). Tests run in order and build on each other.
import assert from "node:assert/strict";
import { Device } from "../support/device";
import { claimHost, inviteToHost, openDeepLink, pairDevice, setDisplayName } from "../support/flows";
import { TezcaServer } from "../support/server";
import { listFiles, waitConverged } from "../support/vault";
import { sleep, waitFor } from "../support/wait";

describe("shares: a folder shared between two people", function () {
	let server: TezcaServer;
	let alice: Device;
	let alice2: Device;
	let bob: Device;

	before(async function () {
		server = await TezcaServer.start();
		[alice, alice2, bob] = await Promise.all([Device.launch("alice"), Device.launch("alice-laptop"), Device.launch("bob", { mobile: true })]);
	});

	after(async function () {
		for (const d of [alice, alice2, bob]) await d?.quit();
		await server?.stop();
	});

	/** Alice's share modal for Trip (via the folder's context menu). */
	async function manageTrip() {
		await alice.contextMenu("Trip", "Manage shared folder…");
		return alice.modal("Shared folder: Trip");
	}

	/** Alice creates an invite from the share modal and returns the link. */
	async function inviteLink(kind: "Can edit" | "View only") {
		const m = await manageTrip();
		await alice.clickButton(kind, m);
		const link = await alice.takeLink('Invite to "Trip"');
		await alice.closeModals();
		return link;
	}

	async function bobJoins(link: string, at: string) {
		await openDeepLink(bob, link);
		await bob.submitForm('Join "Trip"', at, "Join");
	}

	it("sets up Alice's host, her second device and Bob's account", async function () {
		await claimHost(alice, server);
		await setDisplayName(alice, "Alice");
		await pairDevice(alice, alice2);
		await inviteToHost(alice, bob);
		await setDisplayName(bob, "Bob");
	});

	it("shares a folder from its context menu and Bob joins with the invite link", async function () {
		await alice.write("Trip/Plan.md", "# Trip plan\n\n- Book flights\n");
		await alice.write("Trip/Packing.md", "- Passport\n");
		await alice.write("Private.md", "Alice's private note.\n");
		await alice2.waitForFile("Trip/Plan.md");

		await alice.contextMenu("Trip", "Share folder…");
		await alice.choose('Share "Trip"?', "Share folder");
		await alice.modal("Shared folder: Trip");
		await alice.closeModals();
		const link = await inviteLink("Can edit");
		assert.match(link, /^obsidian:\/\/tezca\?do=share&/);

		await bobJoins(link, "Shared/Trip");
		await bob.waitForFile("Shared/Trip/Plan.md", "# Trip plan\n\n- Book flights\n");
		await bob.waitForFile("Shared/Trip/Packing.md", "- Passport\n");
		await waitConverged([alice, bob], { under: ["Trip", "Shared/Trip"] });
		assert.equal(bob.exists("Private.md"), false, "Alice's other notes stay private");
		// Alice's second device keeps the folder (now through the share).
		await alice2.write("Trip/From laptop.md", "Laptop note.\n");
		await bob.waitForFile("Shared/Trip/From laptop.md", "Laptop note.\n");
	});

	it("syncs edits both ways, live, and shows who else is in the note", async function () {
		await alice.open("Trip/Plan.md");
		await bob.open("Shared/Trip/Plan.md");
		await alice.cursor("end");
		await alice.type("- Book hotel\n");
		await bob.waitEditorText((t) => t.includes("- Book hotel"), 5_000);
		await bob.cursor("end");
		await bob.type("- Rent a car\n");
		await alice.waitEditorText((t) => t.includes("- Rent a car"), 5_000);
		await waitFor(
			() => alice.exec(() => [...document.querySelectorAll(".tezca-presence .tezca-avatar")].map((e) => e.getAttribute("title"))).then((names) => names.includes("Bob")),
			{ what: "Bob's avatar in Alice's status bar", timeout: 15_000 },
		);
		await bob.write("Shared/Trip/Bob's ideas.md", "Go hiking.\n");
		await alice.waitForFile("Trip/Bob's ideas.md", "Go hiking.\n");
		await alice2.waitForFile("Trip/Bob's ideas.md", "Go hiking.\n");
		// Bob's own notes stay his.
		await bob.write("Bob private.md", "Mine.\n");
		await sleep(2_000);
		assert.equal(alice.exists("Bob private.md"), false);
		await waitConverged([alice, bob], { under: ["Trip", "Shared/Trip"] });
	});

	it("lists members by name, and making Bob a viewer makes his copy read-only", async function () {
		// Bob has the note open while his role changes.
		await bob.open("Shared/Trip/Packing.md");
		assert.equal(await bob.isEditorReadOnly(), false);
		const m = await manageTrip();
		const row = await alice.settingRow("Bob", m);
		await (await row.$("select")).selectByAttribute("value", "viewer");
		await waitFor(async () => (await bob.exec(({ plugins }) => plugins.tezcaSync.engine.roleIn(plugins.tezcaSync.engine.mounts.all()[0].spaceId))) === "viewer", {
			what: "Bob to be a viewer",
		});
		await alice.closeModals();
		await waitFor(() => bob.isEditorReadOnly(), { what: "Bob's open editor to turn read-only" });
		await bob.cursor("end");
		await bob.type("sneaky edit");
		assert.equal(await bob.editorText(), "- Passport\n");
		// Changes made some other way are put back.
		await bob.write("Shared/Trip/Packing.md", "- Passport\n- Changed by a viewer\n");
		await bob.waitForFile("Shared/Trip/Packing.md", "- Passport\n", 20_000);
		assert.equal(await bob.editorText(), "- Passport\n");
		assert.equal(alice.read("Trip/Packing.md"), "- Passport\n");
		// Bob's change is kept as a conflict copy on his device only.
		const copies = listFiles(bob.vaultPath).filter((f) => f.includes("Packing (conflict"));
		assert.equal(copies.length, 1);
		assert.equal(bob.read(copies[0]), "- Passport\n- Changed by a viewer\n");
		// Alice's edits still reach him.
		await alice.write("Trip/Packing.md", "- Passport\n- Sun cream\n");
		await bob.waitForFile("Shared/Trip/Packing.md", "- Passport\n- Sun cream\n");

		const m2 = await manageTrip();
		await (await (await alice.settingRow("Bob", m2)).$("select")).selectByAttribute("value", "editor");
		await alice.closeModals();
		await waitFor(async () => !(await bob.isEditorReadOnly()), { what: "Bob's editor to be writable again" });
		await bob.cursor("end");
		await bob.type("- Hat");
		await alice.waitForFile("Trip/Packing.md", "- Passport\n- Sun cream\n- Hat");
		assert.equal(alice.exists(copies[0].replace("Shared/", "")), false, "the viewer's conflict copy never left Bob's device");
	});

	it("Bob can leave; his copy stays as private files and stops syncing", async function () {
		await bob.closeModals();
		await bob.openSettings();
		await bob.clickButton("Manage");
		const m = await bob.modal("Shared folder: Trip");
		await bob.clickButton("Leave", m);
		await bob.choose('Leave "Trip"?', "Leave");
		await bob.closeSettings();
		await waitFor(async () => (await bob.exec(({ plugins }) => plugins.tezcaSync.engine.mounts.all().length)) === 0, { what: "Bob's mount to go" });

		await alice.write("Trip/After leaving.md", "Bob shouldn't get this.\n");
		await alice2.waitForFile("Trip/After leaving.md");
		await sleep(3_000);
		assert.equal(bob.exists("Shared/Trip/After leaving.md"), false);
		assert.ok(bob.exists("Shared/Trip/Plan.md"), "Bob keeps his copy");
		// Alice still sees the folder (Bob leaving doesn't delete anything for her).
		assert.ok(alice.exists("Trip/Plan.md"));
		const members = await alice.exec(({ plugins }) => plugins.tezcaSync.engine.members(plugins.tezcaSync.engine.mounts.all()[0].spaceId).map((m: { name?: string }) => m.name));
		assert.ok(!members.includes("Bob"), `members: ${members}`);
	});

	it("removing a member cuts them off from new changes", async function () {
		await bobJoins(await inviteLink("Can edit"), "Trip again");
		await bob.waitForFile("Trip again/After leaving.md", "Bob shouldn't get this.\n");
		await alice.write("Trip/Before removal.md", "Shared with Bob.\n");
		await bob.waitForFile("Trip again/Before removal.md");

		const m = await manageTrip();
		const row = await alice.settingRow("Bob", m);
		await alice.click((await row.$('[aria-label="Remove from this shared folder"]')) as unknown as WebdriverIO.Element);
		await alice.choose("Remove Bob?", "Remove");
		await alice.closeModals();
		await waitFor(
			async () => !(await alice.exec(({ plugins }) => plugins.tezcaSync.engine.members(plugins.tezcaSync.engine.mounts.all()[0].spaceId).some((m: { name?: string }) => m.name === "Bob"))),
			{ what: "Bob to be gone from the member list" },
		);

		await alice.write("Trip/After removal.md", "Secret from Bob.\n");
		await bob.write("Trip again/Bob after removal.md", "Bob can't add this.\n").catch(() => undefined);
		await alice2.waitForFile("Trip/After removal.md");
		await sleep(4_000);
		assert.equal(bob.exists("Trip again/After removal.md"), false, "Bob doesn't get new changes");
		assert.equal(alice.exists("Trip/Bob after removal.md"), false, "Bob can't push changes");
		await alice.waitSynced();
		await alice2.waitSynced();
		await waitConverged([alice, alice2]);
	});
});
