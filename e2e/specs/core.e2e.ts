// Two devices of one person: "mac" (desktop) and "phone" (mobile emulation), syncing one vault.
// Tests run in order and build on each other (one setup, like a real user's day).
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Device } from "../support/device";
import { claimHost, pairDevice } from "../support/flows";
import { TezcaServer } from "../support/server";
import { conflictFiles, listFiles, png, waitConverged } from "../support/vault";
import { sleep, waitFor } from "../support/wait";

describe("core: two devices, one vault", function () {
	let server: TezcaServer;
	let mac: Device;
	let phone: Device;

	before(async function () {
		server = await TezcaServer.start();
		[mac, phone] = await Promise.all([Device.launch("mac"), Device.launch("phone", { mobile: true })]);
	});

	after(async function () {
		await mac?.quit();
		await phone?.quit();
		await server?.stop();
	});

	it("sets up through the settings UI: claim the host, then pair the phone", async function () {
		await claimHost(mac, server);
		await mac.write("Welcome.md", "# Welcome\n\nWritten on the mac before pairing.\n");
		await mac.waitSynced();
		await pairDevice(mac, phone);
		await phone.waitForFile("Welcome.md", "# Welcome\n\nWritten on the mac before pairing.\n");
		assert.equal((await phone.status()).conn, "online");
	});

	it("shows typing live in the other device's open editor, both ways", async function () {
		await mac.write("Live.md", "Start\n");
		await phone.waitForFile("Live.md", "Start\n");
		await mac.open("Live.md");
		await phone.open("Live.md");
		await mac.cursor("end");
		await mac.type("typed on the mac");
		// Live means it shows in the phone's editor before anything is saved to disk there.
		await phone.waitEditorText("Start\ntyped on the mac", 5_000);
		await phone.cursor("start");
		await phone.type("Phone says hi. ");
		await mac.waitEditorText("Phone says hi. Start\ntyped on the mac", 5_000);
		// Obsidian saves the editor to disk a couple of seconds after typing stops.
		await mac.waitForFile("Live.md", "Phone says hi. Start\ntyped on the mac");
		await phone.waitForFile("Live.md", "Phone says hi. Start\ntyped on the mac");
		await waitConverged([mac, phone]);
	});

	it("merges both devices typing into the same note at the same time", async function () {
		await mac.cursor("end");
		await phone.cursor("end");
		await mac.type("\nmac line");
		await Promise.all([mac.type(" one two three four five six"), phone.type("\nphone line alpha beta gamma delta")]);
		await waitFor(async () => (await mac.editorText()) === (await phone.editorText()), {
			what: "editors to match",
			detail: async () => [await mac.editorText(), await phone.editorText()],
		});
		const text = (await mac.editorText())!;
		await mac.waitForFile("Live.md", text);
		await phone.waitForFile("Live.md", text);
		for (const word of ["mac line", "one two three four five six", "phone line alpha beta gamma delta", "Phone says hi."])
			assert.ok(text.includes(word), `merged text is missing "${word}":\n${text}`);
		await waitConverged([mac, phone]);
	});

	it("opens a note made on the other device from the file list and edits it (frozen-sidebar regression)", async function () {
		await phone.write("From phone.md", "Made on the phone.\n");
		await waitFor(() => mac.exists("From phone.md"), { what: "note on mac" });
		await mac.clickInExplorer("From phone.md");
		await waitFor(async () => (await mac.exec(({ app }) => app.workspace.getActiveFile()?.path)) === "From phone.md", { what: "mac to open the note" });
		await mac.cursor("end");
		await mac.type("Edited on the mac.");
		await phone.waitForFile("From phone.md", "Made on the phone.\nEdited on the mac.");
		// The file list still responds.
		await mac.clickInExplorer("Welcome.md");
		await waitFor(async () => (await mac.exec(({ app }) => app.workspace.getActiveFile()?.path)) === "Welcome.md", { what: "mac to switch notes" });
	});

	it("never mixes up notes when switching between them quickly (overwrite regression)", async function () {
		const notes: Record<string, string> = {};
		for (let i = 0; i < 4; i++) notes[`Quick ${i}.md`] = `Note ${i}: ${randomBytes(8).toString("hex")}\n`;
		for (const [p, c] of Object.entries(notes)) await mac.write(p, c);
		for (const p of Object.keys(notes)) await phone.waitForFile(p, notes[p]);
		for (let round = 0; round < 3; round++)
			for (const p of Object.keys(notes)) {
				await phone.page.openFile(p);
				await mac.page.openFile(p);
			}
		await phone.open("Quick 3.md");
		await phone.cursor("end");
		await phone.type("added");
		notes["Quick 3.md"] += "added";
		await sleep(2_000);
		await waitConverged([mac, phone]);
		for (const [p, c] of Object.entries(notes)) {
			assert.equal(mac.read(p), c, `mac ${p}`);
			assert.equal(phone.read(p), c, `phone ${p}`);
		}
	});

	it("syncs creating, renaming, moving and deleting notes and folders", async function () {
		await mac.mkdir("Projects");
		await mac.write("Projects/Plan.md", "The plan.\n");
		await mac.write("Projects/Ideas.md", "Some ideas. See [[Plan]].\n");
		await mac.write("Scratch.md", "Delete me.\n");
		await waitConverged([mac, phone]);

		await mac.rename("Welcome.md", "Notes/Welcome.md");
		await mac.delete("Scratch.md");
		await phone.rename("Projects", "Archive/Projects 2025");
		await waitConverged([mac, phone]);
		const files = listFiles(mac.vaultPath);
		assert.ok(files.includes("Notes/Welcome.md"));
		assert.ok(files.includes("Archive/Projects 2025/Plan.md"));
		assert.ok(files.includes("Archive/Projects 2025/Ideas.md"));
		assert.ok(!files.includes("Scratch.md"));
		await mac.waitGone("Projects", 20_000);
		assert.deepEqual(conflictFiles(mac), []);
	});

	it("syncs attachments, which render on the other device", async function () {
		const red = png(64, 48, [220, 30, 30]);
		await mac.writeBinary("Attachments/red.png", red);
		await mac.write("Picture.md", "![[red.png]]\n");
		await waitFor(() => phone.readBytes("Attachments/red.png")?.equals(red) ?? false, { what: "png on phone" });
		await phone.waitForFile("Picture.md");
		// It renders in reading view on the phone.
		await phone.open("Picture.md");
		await phone.exec(async ({ app }) => {
			const leaf = app.workspace.getLeaf(false);
			await leaf.setViewState({ type: "markdown", state: { file: "Picture.md", mode: "preview" } });
		});
		await waitFor(
			() =>
				phone.exec(() => {
					const img = document.querySelector(".workspace-leaf.mod-active .markdown-preview-view img") as HTMLImageElement | null;
					return !!img && img.complete && img.naturalWidth === 64;
				}),
			{ what: "image to render on phone" },
		);

		// A new version from the phone replaces it on the mac; a big random file goes through too.
		const blue = png(64, 48, [30, 30, 220]);
		await phone.writeBinary("Attachments/red.png", blue);
		const big = randomBytes(3 * 1024 * 1024);
		await phone.writeBinary("Attachments/data.bin", big);
		await waitFor(() => mac.readBytes("Attachments/red.png")?.equals(blue) ?? false, { what: "new png on mac" });
		await waitFor(() => mac.readBytes("Attachments/data.bin")?.equals(big) ?? false, { what: "big file on mac", timeout: 60_000 });
		await waitConverged([mac, phone]);
	});

	it("merges edits made while the phone was closed, including offline renames", async function () {
		await mac.write("Offline.md", "Para one.\n\nPara two.\n\nPara three.\n");
		await mac.write("Rename me.md", "I will be renamed while the phone is closed.\n");
		await mac.write("Delete me.md", "Gone soon.\n");
		await waitConverged([mac, phone]);

		// "Close" Tezca on the phone (as if Obsidian were quit), then edit its files on disk.
		await phone.page.disablePlugin("tezca-sync");
		phone.writeOnDisk("Offline.md", "Para one.\n\nPara two.\n\nPara three, edited on the phone.\n");
		phone.renameOnDisk("Rename me.md", "Renamed offline.md");
		phone.removeOnDisk("Delete me.md");
		phone.writeOnDisk("Made offline.md", "Written while closed.\n");
		// Meanwhile the mac keeps editing.
		await mac.write("Offline.md", "Para one, edited on the mac.\n\nPara two.\n\nPara three.\n");
		await mac.waitSynced();

		await phone.page.enablePlugin("tezca-sync");
		const files = await waitConverged([mac, phone], { timeout: 60_000 });
		assert.equal(files["Offline.md"], "Para one, edited on the mac.\n\nPara two.\n\nPara three, edited on the phone.\n");
		assert.ok("Renamed offline.md" in files && !("Rename me.md" in files), "rename was recognised");
		assert.ok(!("Delete me.md" in files));
		assert.equal(files["Made offline.md"], "Written while closed.\n");
		assert.deepEqual(conflictFiles(mac), []);
	});

	it("keeps both edits when both devices change the same line while one is offline", async function () {
		await mac.write("Same line.md", "The quick brown fox.\n");
		await waitConverged([mac, phone]);
		await phone.page.disablePlugin("tezca-sync");
		phone.writeOnDisk("Same line.md", "The quick brown fox jumps.\n");
		await mac.write("Same line.md", "The very quick brown fox.\n");
		await mac.waitSynced();
		await phone.page.enablePlugin("tezca-sync");
		const files = await waitConverged([mac, phone]);
		const merged = files["Same line.md"];
		assert.ok(merged.includes("very") && merged.includes("jumps"), `both edits survive: ${JSON.stringify(merged)}`);
	});

	it("rides out the server going away and coming back", async function () {
		await server.kill();
		await waitFor(async () => (await mac.status()).conn !== "online", { what: "mac to notice" });
		await mac.write("While down.md", "Written while the server was down.\n");
		await phone.write("Also while down.md", "Phone too.\n");
		await sleep(1_000);
		await server.restart();
		await mac.command("tezca-sync:reconnect");
		await phone.command("tezca-sync:reconnect");
		const files = await waitConverged([mac, phone], { timeout: 60_000 });
		assert.ok("While down.md" in files && "Also while down.md" in files);
	});

	it("comes back after quitting and reopening Obsidian, with nothing duplicated", async function () {
		const before = await waitConverged([mac, phone]);
		await phone.restart();
		await phone.waitSynced(60_000);
		await mac.write("After restart.md", "Hello again.\n");
		await phone.waitForFile("After restart.md", "Hello again.\n");
		const after = await waitConverged([mac, phone]);
		assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), "After restart.md"].sort());
		assert.deepEqual(conflictFiles(phone), []);
	});
});
