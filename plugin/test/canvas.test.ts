// The Canvas CRDT bridge: JSON Canvas ↔ Y.Doc, merging concurrent edits.
import * as Y from "yjs";
import { describe, expect, it } from "vitest";
import { applyCanvas, canvasText, formatCanvas, parseCanvas, sameCanvas } from "../src/core/canvas";

const canvas = (nodes: object[], edges: object[] = []) => formatCanvas({ nodes: nodes as never, edges: edges as never, extra: {} });
const node = (id: string, extra: object = {}) => ({ id, type: "text", text: `card ${id}`, x: 0, y: 0, width: 200, height: 60, ...extra });

function sync(a: Y.Doc, b: Y.Doc) {
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a, Y.encodeStateVector(b)));
	Y.applyUpdate(a, Y.encodeStateAsUpdate(b, Y.encodeStateVector(a)));
}

describe("canvas bridge", () => {
	it("round-trips Obsidian's format", () => {
		const text = canvas([node("a"), node("b", { color: "4" })], [{ id: "e1", fromNode: "a", toNode: "b" }]);
		const doc = new Y.Doc();
		applyCanvas(doc, null, text, "t");
		expect(canvasText(doc)).toBe(text);
		expect(text).toContain('\n\t\t{"id":"a"');
		expect(parseCanvas(text).nodes.map((n) => n.id)).toEqual(["a", "b"]);
	});

	it("merges concurrent edits from two devices", () => {
		const start = canvas([node("a"), node("b")]);
		const A = new Y.Doc();
		applyCanvas(A, null, start, "t");
		const B = new Y.Doc();
		sync(A, B);
		// A moves card a and adds card c; B edits card a's text, deletes b and adds d.
		applyCanvas(A, start, canvas([node("a", { x: 500 }), node("b"), node("c")]), "t");
		applyCanvas(B, start, canvas([node("a", { text: "card a, edited on B" }), node("d")]), "t");
		sync(A, B);
		const merged = parseCanvas(canvasText(A));
		expect(canvasText(A)).toBe(canvasText(B));
		const a = merged.nodes.find((n) => n.id === "a")!;
		expect(a.x).toBe(500);
		expect(a.text).toBe("card a, edited on B");
		expect(merged.nodes.map((n) => n.id).sort()).toEqual(["a", "c", "d"]);
	});

	it("merges concurrent text edits to the same card", () => {
		const start = canvas([node("a", { text: "one\ntwo\nthree" })]);
		const A = new Y.Doc();
		applyCanvas(A, null, start, "t");
		const B = new Y.Doc();
		sync(A, B);
		applyCanvas(A, start, canvas([node("a", { text: "ONE\ntwo\nthree" })]), "t");
		applyCanvas(B, start, canvas([node("a", { text: "one\ntwo\nthree\nfour" })]), "t");
		sync(A, B);
		expect(parseCanvas(canvasText(A)).nodes[0].text).toBe("ONE\ntwo\nthree\nfour");
	});

	it("keeps unknown top-level keys and ignores formatting differences", () => {
		const text = '{"nodes":[{"id":"a","type":"text","text":"x","x":0,"y":0,"width":1,"height":1}],"edges":[],"metadata":{"v":1}}';
		const doc = new Y.Doc();
		applyCanvas(doc, null, text, "t");
		expect(sameCanvas(canvasText(doc), text)).toBe(true);
		expect(parseCanvas(canvasText(doc)).extra).toEqual({ metadata: { v: 1 } });
	});

	it("rejects text that isn't a canvas", () => {
		expect(() => applyCanvas(new Y.Doc(), null, "not json", "t")).toThrow();
	});
});

// Through the mirror and the mock host.
import { afterEach } from "vitest";
import { MemoryVault } from "../src/core/vault";
import { converged, eventually, setupHost, startClient, type Client } from "./helpers";

let clients: Client[] = [];
afterEach(async () => {
	await Promise.all(clients.map((c) => c.engine.stop()));
	clients = [];
});

describe("canvas sync", () => {
	it("syncs a new canvas live and merges concurrent edits made in two vaults", async () => {
		const { host, id, spaceId } = await setupHost();
		const start = canvas([node("a"), node("b")]);
		const va = new MemoryVault();
		va.files.set("Board.canvas", start);
		const a = await startClient(host, id, spaceId, "A", va);
		const b = await startClient(host, id, spaceId, "B", new MemoryVault());
		clients.push(a, b);
		await converged(a, b);
		expect(a.engine.mirror!.index.live().find((e) => e.path === "Board.canvas")?.kind).toBe("canvas");
		expect(sameCanvas(b.vault.files.get("Board.canvas") as string, start)).toBe(true);

		// Offline on both sides: A moves card a and adds c; B rewrites card b's text and adds d.
		host.down = true;
		host.dropAll();
		await a.vault.userWrite("Board.canvas", canvas([node("a", { x: 900 }), node("b"), node("c")]));
		await b.vault.userWrite("Board.canvas", canvas([node("a"), node("b", { text: "B's text" }), node("d")]));
		await new Promise((r) => setTimeout(r, 200));
		host.down = false;
		await converged(a, b);
		const merged = parseCanvas(a.vault.files.get("Board.canvas") as string);
		expect(merged.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "d"]);
		expect(merged.nodes.find((n) => n.id === "a")!.x).toBe(900);
		expect(merged.nodes.find((n) => n.id === "b")!.text).toBe("B's text");
		// No conflict copies: canvas edits merge per node.
		expect([...a.vault.files.keys(), ...b.vault.files.keys()].some((p) => p.includes("(conflict"))).toBe(false);
	});

	it("leaves a half-written canvas alone until it's valid", async () => {
		const { host, id, spaceId } = await setupHost();
		const a = await startClient(host, id, spaceId, "A", new MemoryVault());
		const b = await startClient(host, id, spaceId, "B", new MemoryVault());
		clients.push(a, b);
		await a.vault.userWrite("New.canvas", '{"nodes":[{"id":"a"');
		await a.engine.idle();
		expect(a.engine.mirror!.index.live().some((e) => e.path === "New.canvas")).toBe(false);
		await a.vault.userWrite("New.canvas", canvas([node("a")]));
		await eventually(() => typeof b.vault.files.get("New.canvas") === "string", 5000, "valid canvas syncs");
	});
});
