// Version history and Recently deleted, through their modals. Note versions are saved 30s after
// edits stop (if none was saved in the last hour), so this spec waits for that once.
import assert from "node:assert/strict";
import { Device } from "../support/device";
import { claimHost, pairDevice } from "../support/flows";
import { TezcaServer } from "../support/server";
import { png, waitConverged } from "../support/vault";
import { sleep, waitFor } from "../support/wait";

describe("history: versions and recently deleted", function () {
	let server: TezcaServer;
	let mac: Device;
	let phone: Device;
	const red = png(32, 32, [220, 30, 30]);
	const blue = png(32, 32, [30, 30, 220]);

	before(async function () {
		server = await TezcaServer.start();
		[mac, phone] = await Promise.all([Device.launch("mac"), Device.launch("phone", { mobile: true })]);
		await claimHost(mac, server);
		await pairDevice(mac, phone);
	});

	after(async function () {
		await mac?.quit();
		await phone?.quit();
		await server?.stop();
	});

	it("restores an earlier version of a note from Version history", async function () {
		await mac.write("Diary.md", "Monday: sunny.\n");
		await phone.waitForFile("Diary.md", "Monday: sunny.\n");
		// Meanwhile an attachment gets a second version (used by the next test).
		await mac.writeBinary("pic.png", red);
		await phone.waitForFile("pic.png");
		await mac.writeBinary("pic.png", blue);
		await waitFor(() => phone.readBytes("pic.png")?.equals(blue) ?? false, { what: "blue png on phone" });

		// Wait for the first version to be saved, then change the note.
		await waitFor(
			() => mac.exec(async ({ plugins }) => {
				const m = plugins.tezcaSync.engine.mirror;
				const e = m.index.live().find((x: { path: string }) => x.path === "Diary.md");
				const res = await m.space.conn.request((rid: number) => ({ case: "listVersions", value: { rid, spaceId: m.space.spaceId, docId: e.id } }), "versionList");
				return res.versions.length > 0;
			}),
			{ what: "a saved version", timeout: 90_000, interval: 2_000 },
		);
		await phone.write("Diary.md", "Monday: rain all day.\n");
		await mac.waitForFile("Diary.md", "Monday: rain all day.\n");

		await mac.contextMenu("Diary.md", "Version history");
		const m = await mac.modal("History: Diary.md");
		const item = await m.$(".tezca-history-item");
		await item.waitForExist({ timeout: 15_000 });
		await mac.click(item as unknown as WebdriverIO.Element);
		// The diff shows what restoring removes (red) and brings back (green).
		const diffAs = (skip: string) =>
			mac.exec((_, skip) => {
				const el = document.querySelector(".tezca-diff");
				return el ? [...el.children].filter((c) => !c.classList.contains(skip)).map((c) => c.textContent).join("") : null;
			}, skip);
		await waitFor(async () => (await diffAs("tezca-diff-del")) === "Monday: sunny.\n", { what: "diff without red = old version", detail: () => diffAs("x") });
		assert.equal(await diffAs("tezca-diff-ins"), "Monday: rain all day.\n", "diff without green = current text");
		await mac.clickButton("Restore this version", m);
		await mac.noModal("History: Diary.md");
		await mac.waitForFile("Diary.md", "Monday: sunny.\n");
		await phone.waitForFile("Diary.md", "Monday: sunny.\n");
	});

	it("restores an earlier version of an attachment, with a preview", async function () {
		await phone.open("pic.png");
		await phone.command("tezca-sync:file-history");
		const m = await phone.modal("History: pic.png");
		const items = await m.$$(".tezca-history-item");
		assert.equal(items.length, 2, "current + one earlier version");
		assert.equal(await items[0].getText().then((t) => t.split("\n")[0]), "Current version");
		await phone.click(items[1] as unknown as WebdriverIO.Element);
		await waitFor(
			() => phone.exec(() => {
				const img = document.querySelector(".tezca-history-preview img") as HTMLImageElement | null;
				return !!img && img.complete && img.naturalWidth === 32;
			}),
			{ what: "preview of the old version" },
		);
		await phone.clickButton("Restore this version", m);
		await waitFor(() => phone.readBytes("pic.png")?.equals(red) ?? false, { what: "red png back on phone" });
		await waitFor(() => mac.readBytes("pic.png")?.equals(red) ?? false, { what: "red png back on mac" });
	});

	it("brings deleted files back from Recently deleted", async function () {
		await mac.write("Old notes/Recipe.md", "Pancakes: flour, eggs, milk.\n");
		await mac.writeBinary("Old notes/photo.png", blue);
		await waitConverged([mac, phone]);
		await phone.delete("Old notes/Recipe.md");
		await phone.delete("Old notes/photo.png");
		await mac.waitGone("Old notes/Recipe.md");
		await mac.waitGone("Old notes/photo.png");

		await mac.exec(({ app }) => app.workspace.getLeaf(false).detach?.());
		await mac.command("tezca-sync:recently-deleted");
		const m = await mac.modal("Recently deleted");
		for (const name of ["Old notes/Recipe.md", "Old notes/photo.png"]) {
			const row = await mac.settingRow(name, m);
			await mac.click((await row.$("button=Restore")) as unknown as WebdriverIO.Element);
			await sleep(300);
		}
		await mac.closeModals();
		await phone.waitForFile("Old notes/Recipe.md", "Pancakes: flour, eggs, milk.\n");
		await waitFor(() => phone.readBytes("Old notes/photo.png")?.equals(blue) ?? false, { what: "photo back on phone" });
		await waitConverged([mac, phone]);
	});
});
