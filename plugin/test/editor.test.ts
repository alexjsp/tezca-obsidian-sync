// @vitest-environment happy-dom
// Drives a real CodeMirror EditorView through EditorBindings against a running engine.
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";

import { MemoryVault } from "../src/core/vault";
import { textOf } from "../src/core/mirror";
import { EditorBindings } from "../src/obsidian/editor";
import { editorInfoField, setFile } from "./obsidian-stub";
import { eventually, setupHost, startClient } from "./helpers";

type Client = Awaited<ReturnType<typeof startClient>>;
let clients: Client[] = [];
const views: EditorView[] = [];
afterEach(async () => {
	views.splice(0).forEach((v) => v.destroy());
	await Promise.all(clients.map((c) => c.engine.stop()));
	clients = [];
});

/** EditorBindings whose refresh() stops after `limit` calls, so a refresh loop fails the test instead of hanging it. */
function boundedBindings(engine: Client["engine"], limit = 50) {
	const mgr = new EditorBindings(() => engine, () => ({ name: "Test", color: "#8a5cf5" }));
	const counter = { calls: 0 };
	const orig = mgr.refresh.bind(mgr);
	mgr.refresh = (v: EditorView) => (++counter.calls > limit ? Promise.resolve() : orig(v));
	return { mgr, counter };
}

function openView(mgr: EditorBindings, path: string | null, text: string) {
	const view = new EditorView({ doc: text, extensions: [editorInfoField, mgr.extension()], parent: document.body });
	if (path) view.dispatch({ effects: setFile.of(path) });
	views.push(view);
	return view;
}

describe("editor bindings", () => {
	it("binds once when a note is opened by several triggers at once", async () => {
		const { host, id, spaceId } = await setupHost();
		const vault = new MemoryVault();
		vault.files.set("a.md", "hello");
		const a = await startClient(host, id, spaceId, "A", vault);
		clients.push(a);

		const { mgr, counter } = boundedBindings(a.engine);
		// Constructor microtask + the path-change update + the workspace's file-open rebind all fire together.
		const view = openView(mgr, "a.md", "hello");
		mgr.rebindViews([view]);
		mgr.rebindViews([view]);

		await eventually(() => mgr.isBound("a.md"), 5000, "editor bound");
		expect(counter.calls).toBeLessThan(10);

		// The binding is live: typing reaches the Y.Text.
		view.dispatch({ changes: { from: 5, insert: " world" } });
		const docId = a.engine.mirror!.docIdFor("a.md")!;
		const doc = await a.engine.space!.acquireSynced(docId, 3000);
		expect(textOf(doc).toString()).toBe("hello world");
		a.engine.space!.release(docId);
	});

	it("rebinds when the open file switches", async () => {
		const { host, id, spaceId } = await setupHost();
		const vault = new MemoryVault();
		vault.files.set("a.md", "aaa");
		vault.files.set("b.md", "bbb");
		const a = await startClient(host, id, spaceId, "A", vault);
		clients.push(a);

		const { mgr, counter } = boundedBindings(a.engine);
		const view = openView(mgr, "a.md", "aaa");
		await eventually(() => mgr.isBound("a.md"), 5000, "bound to a");
		// Switch file mid-bind as well as after, with a duplicate rebind racing it.
		view.dispatch({ changes: { from: 0, to: 3, insert: "bbb" }, effects: setFile.of("b.md") });
		mgr.rebindViews([view]);
		await eventually(() => mgr.isBound("b.md") && !mgr.isBound("a.md"), 5000, "bound to b");
		expect(counter.calls).toBeLessThan(10);
	});
});
