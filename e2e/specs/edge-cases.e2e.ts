// Edge cases on two devices of one person: editor details, unusual renames, limits, races, and the
// safety brake. The server caps files at 1 MB here.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Device } from "../support/device";
import { claimHost, pairDevice } from "../support/flows";
import { TezcaServer } from "../support/server";
import { conflictFiles, listFiles, waitConverged } from "../support/vault";
import { sleep, waitFor } from "../support/wait";

describe("edge cases", function () {
	let server: TezcaServer;
	let mac: Device;
	let phone: Device;

	before(async function () {
		server = await TezcaServer.start({ TEZCA_MAX_BLOB_MB: "1" });
		[mac, phone] = await Promise.all([Device.launch("mac"), Device.launch("phone", { mobile: true })]);
		await claimHost(mac, server);
		await pairDevice(mac, phone);
	});

	after(async function () {
		await mac?.quit();
		await phone?.quit();
		await server?.stop();
	});

	/** Stop Tezca on a device (as if Obsidian were closed), run `offline`, then start it again. */
	async function whileClosed(d: Device, offline: () => Promise<void> | void) {
		await d.page.disablePlugin("tezca-sync");
		await offline();
		await d.page.enablePlugin("tezca-sync");
	}

	const statusText = (d: Device) => d.exec(() => document.querySelector(".tezca-status")?.textContent ?? null);

	it("shows sync state in the status bar, including offline", async function () {
		await waitFor(async () => (await statusText(mac)) === "Tezca: synced", { what: "synced", detail: () => statusText(mac) });
		await server.kill();
		await waitFor(async () => (await statusText(mac)) === "Tezca: offline" || (await statusText(mac)) === "Tezca: connecting…", {
			what: "offline status",
			detail: () => statusText(mac),
		});
		await server.restart();
		await mac.command("tezca-sync:reconnect");
		await phone.command("tezca-sync:reconnect");
		await waitFor(async () => (await statusText(mac)) === "Tezca: synced", { what: "synced again", timeout: 30_000, detail: () => statusText(mac) });
		await phone.waitSynced();
	});

	it("shows the other device's cursor with its name, and keeps split panes of one note in step", async function () {
		await phone.openSettings();
		await (await phone.settingRow("Display name")).$("input").setValue("Phone person");
		await phone.closeSettings();
		await mac.write("Cursors.md", "Line one\nLine two\n");
		await phone.waitForFile("Cursors.md");
		await phone.open("Cursors.md");
		await phone.cursor({ line: 1, ch: 4 });
		await mac.open("Cursors.md");
		await waitFor(
			() => mac.exec(() => [...document.querySelectorAll(".workspace-leaf.mod-active .cm-ySelectionInfo")].map((e) => e.textContent)).then((n) => n.includes("Phone person")),
			{ what: "the phone's named cursor on the mac", timeout: 15_000 },
		);

		// The same note in two panes on the mac: remote and local edits show in both, once.
		await mac.exec(async ({ app }) => {
			const leaf = app.workspace.getLeaf("split");
			await leaf.openFile(app.vault.getAbstractFileByPath("Cursors.md"));
		});
		await sleep(500);
		await phone.cursor("end");
		await phone.type("From the phone");
		const panes = () =>
			mac.exec(({ app }) => app.workspace.getLeavesOfType("markdown").filter((l: any) => l.view.file?.path === "Cursors.md").map((l: any) => l.view.editor.getValue()));
		await waitFor(async () => (await panes()).every((t: string) => t === "Line one\nLine two\nFrom the phone") && (await panes()).length === 2, {
			what: "both panes to show the phone's text",
			detail: panes,
		});
		await mac.cursor("end");
		await mac.type(" and the mac");
		await waitFor(async () => (await panes()).every((t: string) => t === "Line one\nLine two\nFrom the phone and the mac"), { what: "both panes in step", detail: panes });
		await phone.waitForFile("Cursors.md", "Line one\nLine two\nFrom the phone and the mac");
		await mac.waitForFile("Cursors.md", "Line one\nLine two\nFrom the phone and the mac");
	});

	it("handles a rename that only changes case, and a change of file extension", async function () {
		await mac.write("Shopping.md", "Milk\n");
		await mac.write("Plain.md", "Plain text really.\n");
		await waitConverged([mac, phone]);
		await mac.rename("Shopping.md", "shopping.md");
		await mac.rename("Plain.md", "Plain.txt");
		await waitFor(() => listFiles(phone.vaultPath).includes("shopping.md") && listFiles(phone.vaultPath).includes("Plain.txt"), {
			what: "renames on the phone",
			detail: () => listFiles(phone.vaultPath),
		});
		const files = await waitConverged([mac, phone]);
		assert.ok(!("Shopping.md" in files) && !("Plain.md" in files), JSON.stringify(Object.keys(files)));
		assert.equal(files["shopping.md"], "Milk\n");
		assert.equal(files["Plain.txt"], "Plain text really.\n");
		// The .txt is an attachment now; edits to it still sync.
		await phone.writeOnDisk("Plain.txt", "Edited as a text file.\n");
		await mac.waitForFile("Plain.txt", "Edited as a text file.\n");
	});

	it("never syncs hidden folders or Obsidian's trash", async function () {
		mac.writeOnDisk(".private/secret.md", "Hidden.\n");
		await mac.write("Trash me.md", "Bye.\n");
		await phone.waitForFile("Trash me.md");
		await mac.delete("Trash me.md"); // goes to .trash
		await phone.waitGone("Trash me.md");
		await sleep(2_000);
		assert.ok(mac.exists(".trash/Trash me.md"));
		assert.equal(phone.exists(".private/secret.md"), false);
		assert.equal(phone.exists(".trash/Trash me.md"), false);
		mac.removeOnDisk(".private");
	});

	it("doesn't sync a file over the host's size limit, and says so", async function () {
		await mac.writeBinary("Big video.bin", randomBytes(2 * 1024 * 1024));
		await waitFor(async () => (await mac.noticesSeen()).some((n) => n.includes("Big video.bin") && n.includes("limit")), { what: "a notice about the limit" });
		await mac.writeBinary("Small.bin", randomBytes(100 * 1024));
		await phone.waitForFile("Small.bin");
		assert.equal(phone.exists("Big video.bin"), false);
		await mac.delete("Big video.bin");
	});

	it("keeps an edit made while closed to a note renamed elsewhere (in the renamed note)", async function () {
		await mac.write("Draft.md", "Original text.\n");
		await waitConverged([mac, phone]);
		await whileClosed(phone, async () => {
			await mac.rename("Draft.md", "Final.md");
			await mac.waitSynced();
			phone.writeOnDisk("Draft.md", "Original text.\nAdded on the phone.\n");
		});
		// The phone sees the rename when it starts, moves its edited file along and merges the edit.
		const files = await waitConverged([mac, phone], { timeout: 60_000 });
		assert.equal(files["Final.md"], "Original text.\nAdded on the phone.\n");
		assert.ok(!("Draft.md" in files));
		assert.deepEqual(conflictFiles(mac), []);
	});

	it("keeps a file deleted elsewhere if it had local edits that hadn't synced", async function () {
		await mac.write("Keep me.md", "Version one.\n");
		await waitConverged([mac, phone]);
		await whileClosed(phone, async () => {
			await mac.delete("Keep me.md");
			await mac.waitSynced();
			phone.writeOnDisk("Keep me.md", "Version one.\nImportant offline edit.\n");
		});
		const files = await waitConverged([mac, phone], { timeout: 60_000 });
		assert.equal(files["Keep me.md"], "Version one.\nImportant offline edit.\n");
		await waitFor(async () => (await phone.noticesSeen()).some((n) => n.includes("Keep me.md") && n.includes("kept")), { what: "a notice on the phone" });
	});

	it("pauses instead of deleting most of the vault after a mass delete while closed", async function () {
		for (let i = 0; i < 24; i++) await mac.write(`Bulk/Note ${i}.md`, `Bulk note ${i}\n`);
		await waitConverged([mac, phone]);
		await whileClosed(phone, async () => {
			for (let i = 0; i < 22; i++) phone.removeOnDisk(`Bulk/Note ${i}.md`); // the brake needs more than 20
			// As if Obsidian had been closed: it has seen the files go before Tezca starts.
			await waitFor(() => phone.exec(({ app }) => app.vault.getFiles().filter((f: { path: string }) => f.path.startsWith("Bulk/")).length === 2), {
				what: "Obsidian to notice the deletes",
			});
		});
		await waitFor(async () => (await phone.noticesSeen()).some((n) => n.includes("Sync paused")), { what: "the brake notice", timeout: 30_000 });
		await sleep(3_000);
		assert.equal(listFiles(mac.vaultPath).filter((f) => f.startsWith("Bulk/")).length, 24, "nothing was deleted on the mac");
		assert.deepEqual(conflictFiles(mac), []);
		const bulk = (d: Device) => listFiles(d.vaultPath).filter((f) => f.startsWith("Bulk/")).length;
		assert.equal(bulk(phone), 2);

		// One way out: bring the files back.
		await phone.command("tezca-sync:restore-missing");
		await waitFor(() => bulk(phone) === 24, { what: "files restored on the phone" });
		await waitConverged([mac, phone]);

		// The other: confirm the deletes.
		await whileClosed(phone, async () => {
			for (let i = 0; i < 22; i++) phone.removeOnDisk(`Bulk/Note ${i}.md`);
			await waitFor(() => phone.exec(({ app }) => app.vault.getFiles().filter((f: { path: string }) => f.path.startsWith("Bulk/")).length === 2), {
				what: "Obsidian to notice the deletes",
			});
		});
		await waitFor(async () => (await phone.noticesSeen()).filter((n) => n.includes("Sync paused")).length >= 1, { what: "the brake again" });
		await sleep(2_000);
		assert.equal(bulk(mac), 24);
		await phone.command("tezca-sync:force-reconcile");
		await phone.choose("Force full reconcile?", "Apply");
		await waitFor(() => bulk(mac) === 2, { what: "the deletes to reach the mac", detail: () => bulk(mac) });
		await waitConverged([mac, phone]);
	});

	it("survives flipping all the settings-sync switches quickly", async function () {
		const names = ["Core settings", "Appearance", "Hotkeys", "Community plugin list and settings", "Community plugin code"];
		for (const on of [true, false]) {
			await mac.openSettings();
			await mac.settingRow(names[0]); // selects the Settings window
			// All five at once (WebDriver clicks are slower than a person flicking switches).
			await mac.browser.execute((names: string[]) => {
				for (const row of document.querySelectorAll(".setting-item"))
					if (names.includes(row.querySelector(".setting-item-name")?.textContent ?? "")) (row.querySelector(".checkbox-container") as HTMLElement).click();
			}, names);
			await mac.closeSettings();
			await mac.waitSynced(60_000);
			const errors = (await mac.noticesSeen()).filter((n) => /IDBDatabase|could not start|InvalidStateError/.test(n));
			assert.deepEqual(errors, []);
			const cfg = await mac.exec(({ plugins }) => plugins.tezcaSync.settings.configSync);
			assert.ok(Object.values(cfg).every((v) => v === on), JSON.stringify(cfg));
		}
		await mac.write("After toggling.md", "Still syncing.\n");
		await phone.waitForFile("After toggling.md", "Still syncing.\n");
	});
});
