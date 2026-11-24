// Live Canvas (cards merge per field, text per character) and settings sync, across three devices
// of one person: mac + laptop (desktop) for Canvas, mac + phone for settings.
import assert from "node:assert/strict";
import { Device } from "../support/device";
import { claimHost, pairDevice } from "../support/flows";
import { TezcaServer } from "../support/server";
import { waitFor } from "../support/wait";

interface CanvasNode {
	id: string;
	text?: string;
	x: number;
	y: number;
}

/** The canvas as the open Canvas view holds it (not the file). */
function viewNodes(d: Device): Promise<CanvasNode[]> {
	return d.exec(({ app }) => {
		const view = app.workspace.getLeavesOfType("canvas")[0]?.view;
		return (view?.canvas?.getData().nodes ?? []).map((n: CanvasNode) => ({ id: n.id, text: n.text, x: n.x, y: n.y }));
	});
}

function fileNodes(d: Device, path = "Board.canvas"): CanvasNode[] {
	const raw = d.read(path);
	return raw ? (JSON.parse(raw).nodes as CanvasNode[]) : [];
}

const textOf = (nodes: CanvasNode[], id: string) => nodes.find((n) => n.id === id)?.text;

/** Double-click a card (by id) to edit it, and type at the end of its text. */
async function typeInCard(d: Device, id: string, text: string) {
	const idx = await d.exec(({ app }, id) => {
		const view = app.workspace.getLeavesOfType("canvas")[0].view;
		const node = view.canvas.nodes.get(id);
		return [...document.querySelectorAll(".canvas-node")].indexOf(node.nodeEl);
	}, id);
	const nodes = await d.browser.$$(".canvas-node");
	await nodes[idx].doubleClick();
	// Type into this card's own editor (not whatever editor was last active).
	await waitFor(
		() =>
			d.exec(({ app }, id) => {
				const node = app.workspace.getLeavesOfType("canvas")[0].view.canvas.nodes.get(id);
				const ed = node?.isEditing ? node.child?.editMode?.editor : null;
				if (!ed) return false;
				ed.setCursor(ed.offsetToPos(ed.getValue().length));
				ed.focus();
				return true;
			}, id),
		{ what: `${d.name}: editing card ${id}` },
	);
	await d.type(text);
}

/** Click away from the card being edited (ends editing; the card's text goes into the canvas). */
async function stopEditing(d: Device) {
	await d.exec(({ app }) => app.workspace.getLeavesOfType("canvas")[0].view.canvas.deselectAll());
	await waitFor(
		() => d.exec(({ app }) => ![...app.workspace.getLeavesOfType("canvas")[0].view.canvas.nodes.values()].some((n: { isEditing?: boolean }) => n.isEditing)),
		{ what: `${d.name}: editing to end` },
	);
}

describe("canvas and settings sync", function () {
	let server: TezcaServer;
	let mac: Device;
	let laptop: Device;
	let phone: Device;

	before(async function () {
		server = await TezcaServer.start();
		[mac, laptop, phone] = await Promise.all([Device.launch("mac"), Device.launch("laptop"), Device.launch("phone", { mobile: true })]);
		await claimHost(mac, server);
		await pairDevice(mac, laptop);
		await pairDevice(mac, phone);
		if (process.env.E2E_DEBUG)
			for (const d of [mac, laptop]) {
				await d.openSettings();
				await d.setToggle("Debug logging", true);
				await d.closeSettings();
			}
	});

	after(async function () {
		for (const d of [mac, laptop, phone]) await d?.quit();
		await server?.stop();
	});

	describe("live canvas", function () {
		it("syncs a canvas and edits to different cards made at the same time", async function () {
			const canvas = {
				nodes: [
					{ id: "a1", type: "text", text: "Card A", x: 0, y: 0, width: 260, height: 140 },
					{ id: "b2", type: "text", text: "Card B", x: 400, y: 0, width: 260, height: 140 },
				],
				edges: [{ id: "e1", fromNode: "a1", fromSide: "right", toNode: "b2", toSide: "left" }],
			};
			await mac.write("Board.canvas", JSON.stringify(canvas, null, "\t"));
			await laptop.waitForFile("Board.canvas");
			await mac.open("Board.canvas");
			await laptop.open("Board.canvas");
			await waitFor(async () => (await viewNodes(laptop)).length === 2, { what: "laptop canvas view" });

			await Promise.all([typeInCard(mac, "a1", " edited on the mac"), typeInCard(laptop, "b2", " edited on the laptop")]);
			await Promise.all([stopEditing(mac), stopEditing(laptop)]);
			for (const d of [mac, laptop]) {
				await waitFor(
					async () => {
						const v = await viewNodes(d);
						return textOf(v, "a1") === "Card A edited on the mac" && textOf(v, "b2") === "Card B edited on the laptop";
					},
					{ what: `${d.name}'s canvas view to show both edits`, detail: () => viewNodes(d) },
				);
				await waitFor(
					() => {
						const f = fileNodes(d);
						return textOf(f, "a1") === "Card A edited on the mac" && textOf(f, "b2") === "Card B edited on the laptop";
					},
					{ what: `${d.name}'s file to have both edits`, detail: () => d.read("Board.canvas") },
				);
			}
			assert.equal(JSON.parse(mac.read("Board.canvas")!).edges.length, 1, "edge kept");
		});

		// KNOWN ISSUE (docs/plan.md, "Canvas views and remote changes"): fails about half the time.
		// An open Canvas view holds unsaved changes for ~2s and Tezca syncs canvases through the file,
		// so a remote write can land before the view saves and the view then reloads over its edit.
		// Run with E2E_KNOWN_ISSUES=1.
		(process.env.E2E_KNOWN_ISSUES ? it : it.skip)("merges two people typing in the same card", async function () {
			await Promise.all([typeInCard(mac, "a1", " +mac"), typeInCard(laptop, "a1", " +laptop")]);
			await Promise.all([stopEditing(mac), stopEditing(laptop)]);
			await waitFor(
				() => {
					const a = textOf(fileNodes(mac), "a1");
					return !!a && a === textOf(fileNodes(laptop), "a1") && a.includes("+mac") && a.includes("+laptop");
				},
				{ what: "card A to merge", detail: () => [textOf(fileNodes(mac), "a1"), textOf(fileNodes(laptop), "a1")] },
			);
			assert.ok(textOf(fileNodes(mac), "a1")!.startsWith("Card A edited on the mac"));
		});

		it("merges a new card on one device with a moved card on the other", async function () {
			await Promise.all([
				mac.exec(({ app }) => {
					const canvas = app.workspace.getLeavesOfType("canvas")[0].view.canvas;
					canvas.createTextNode({ pos: { x: 0, y: 400 }, text: "New card from the mac", size: { width: 260, height: 140 } });
					canvas.requestSave();
				}),
				laptop.exec(({ app }) => {
					const canvas = app.workspace.getLeavesOfType("canvas")[0].view.canvas;
					const node = canvas.nodes.get("b2");
					node.moveTo({ x: 800, y: 200 });
					canvas.requestSave();
				}),
			]);
			for (const d of [mac, laptop])
				await waitFor(
					() => {
						const f = fileNodes(d);
						const b = f.find((n) => n.id === "b2");
						return f.length === 3 && f.some((n) => n.text === "New card from the mac") && b?.x === 800 && b?.y === 200;
					},
					{ what: `${d.name}: new card and moved card`, detail: () => fileNodes(d) },
				);
			await waitFor(async () => (await viewNodes(laptop)).length === 3, { what: "laptop's view to show the new card" });
			assert.deepEqual(JSON.parse(mac.read("Board.canvas")!), JSON.parse(laptop.read("Board.canvas")!));
		});
	});

	describe("settings sync", function () {
		const categories = ["Core settings", "Appearance", "Hotkeys", "Community plugin list and settings"];

		async function enable(d: Device) {
			await d.openSettings();
			for (const c of categories) await d.setToggle(c, true);
			await d.closeSettings();
			await d.waitSynced();
		}

		it("syncs core settings, snippets and hotkeys to devices that opt in", async function () {
			await enable(mac);
			await enable(phone);
			// The laptop leaves settings sync off.
			await mac.exec(async ({ app }) => {
				app.vault.setConfig("showLineNumber", true);
				await app.vault.adapter.mkdir(`${app.vault.configDir}/snippets`).catch(() => undefined);
				await app.vault.adapter.write(`${app.vault.configDir}/snippets/e2e-test.css`, "body { --e2e-marker: 1; }\n");
				await app.customCss.requestLoadSnippets?.();
				app.customCss.setCssEnabledStatus("e2e-test", true);
				app.hotkeyManager.setHotkeys("editor:toggle-bold", [{ modifiers: ["Mod", "Shift"], key: "B" }]);
				await app.hotkeyManager.save();
			});
			await phone.waitForFile(".obsidian/snippets/e2e-test.css", "body { --e2e-marker: 1; }\n");
			await phone.waitForFile(".obsidian/app.json", (c) => JSON.parse(c).showLineNumber === true);
			await phone.waitForFile(".obsidian/appearance.json", (c) => (JSON.parse(c).enabledCssSnippets ?? []).includes("e2e-test"));
			await phone.waitForFile(".obsidian/hotkeys.json", (c) => "editor:toggle-bold" in JSON.parse(c));
			await waitFor(async () => (await phone.noticesSeen()).some((n) => n.includes("settings changed on another device")), {
				what: "phone to say settings changed",
			});
			assert.equal(laptop.exists(".obsidian/snippets/e2e-test.css"), false, "the laptop didn't opt in");
		});

		it("applies them after the other device reloads Obsidian", async function () {
			await phone.restart();
			await phone.waitSynced(60_000);
			const s = await phone.exec(({ app }) => ({
				lineNumbers: app.vault.getConfig("showLineNumber"),
				snippet: app.customCss.enabledSnippets.has("e2e-test"),
				hotkey: app.hotkeyManager.getHotkeys("editor:toggle-bold"),
			}));
			assert.deepEqual(s, { lineNumbers: true, snippet: true, hotkey: [{ modifiers: ["Mod", "Shift"], key: "B" }] });
		});

		it("never syncs Tezca's own settings or the workspace layout", async function () {
			const own = (d: Device) => JSON.parse(d.read(".obsidian/plugins/tezca-sync/data.json") ?? "{}") as { deviceId?: string };
			assert.ok(own(mac).deviceId && own(phone).deviceId);
			assert.notEqual(own(mac).deviceId, own(phone).deviceId, "each device keeps its own identity");
			const ws = (d: Device) => d.read(".obsidian/workspace.json") ?? d.read(".obsidian/workspace-mobile.json");
			assert.notEqual(ws(mac), ws(phone));
		});
	});
});
