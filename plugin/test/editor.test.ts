// @vitest-environment happy-dom
// Drives a real CodeMirror EditorView through EditorBindings against a running engine.
import { EditorState } from "@codemirror/state";
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

	// Regression: Obsidian points a view at the new file before loading its text, so for a moment
	// the view shows note A's text under note B's path. Binding then must not push A's text into B.
	it("never merges the previous note's text into a newly opened note", async () => {
		const { host, id, spaceId } = await setupHost();
		const vault = new MemoryVault();
		vault.files.set("a.md", "Sarah wedding notes");
		vault.files.set("b.md", "Hello from the phone");
		const a = await startClient(host, id, spaceId, "A", vault);
		clients.push(a);

		const { mgr } = boundedBindings(a.engine);
		const extensions = [editorInfoField, mgr.extension()];
		const view = openView(mgr, "a.md", "Sarah wedding notes");
		await eventually(() => mgr.isBound("a.md"), 5000, "bound to a");

		// 1. The file switches but the text is still a.md's; workspace file-open fires a rebind.
		view.dispatch({ effects: setFile.of("b.md") });
		mgr.rebindViews([view]);
		await new Promise((r) => setTimeout(r, 300));
		// 2. Obsidian finishes loading b.md and replaces the editor state (as MarkdownView.setViewData does).
		view.setState(
			EditorState.create({ doc: "Hello from the phone", extensions: [...extensions.slice(1), editorInfoField.init(() => ({ file: { path: "b.md" } }))] }),
		);
		await eventually(() => mgr.isBound("b.md"), 8000, "bound to b");
		await a.engine.mirror!.idle();

		const text = async (p: string) => {
			const docId = a.engine.mirror!.docIdFor(p)!;
			const doc = await a.engine.space!.acquireSynced(docId, 3000);
			try {
				return textOf(doc).toString();
			} finally {
				a.engine.space!.release(docId);
			}
		};
		expect(await text("b.md")).toBe("Hello from the phone");
		expect(await text("a.md")).toBe("Sarah wedding notes");
		expect(vault.files.get("b.md")).toBe("Hello from the phone");
		expect(vault.files.get("a.md")).toBe("Sarah wedding notes");
		expect(view.state.doc.toString()).toBe("Hello from the phone");
	});

	it("binds after the editor catches up with text typed before the bind", async () => {
		const { host, id, spaceId } = await setupHost();
		const vault = new MemoryVault();
		vault.files.set("n.md", "");
		const a = await startClient(host, id, spaceId, "A", vault);
		clients.push(a);
		const { mgr } = boundedBindings(a.engine);
		// The user typed before the bind; Obsidian's autosave lands on disk a moment later.
		const view = openView(mgr, "n.md", "typed early");
		setTimeout(() => void vault.userWrite("n.md", "typed early"), 400);
		await eventually(() => mgr.isBound("n.md"), 8000, "bound to n");
		await a.engine.mirror!.idle();
		const docId = a.engine.mirror!.docIdFor("n.md")!;
		const doc = await a.engine.space!.acquireSynced(docId, 3000);
		expect(textOf(doc).toString()).toBe("typed early");
		a.engine.space!.release(docId);
		expect(view.state.doc.toString()).toBe("typed early");
	});
});
