// @vitest-environment happy-dom
// Other people's cursors in the editor (remote-cursors.ts).
import { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it } from "vitest";
import { YSyncConfig, ySync, ySyncFacet } from "y-codemirror.next";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { remoteCursors } from "../src/obsidian/remote-cursors";

const views: EditorView[] = [];
afterEach(() => views.splice(0).forEach((v) => v.destroy()));

function setup(text: string) {
	const a = new Y.Doc();
	a.getText("content").insert(0, text);
	const b = new Y.Doc();
	Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
	const awA = new Awareness(a);
	const awB = new Awareness(b);
	awA.setLocalStateField("user", { name: "Mac", color: "#e8590c" });
	const tb = b.getText("content");
	const view = new EditorView({
		doc: tb.toString(),
		extensions: [ySyncFacet.of(new YSyncConfig(tb, awB)), ySync, remoteCursors(() => null)],
		parent: document.body,
	});
	views.push(view);
	/** A selects anchor..head (indexes into the text) and the update reaches B. */
	const select = (anchor: number, head: number) => {
		const ta = a.getText("content");
		awA.setLocalStateField("cursor", { anchor: Y.createRelativePositionFromTypeIndex(ta, anchor), head: Y.createRelativePositionFromTypeIndex(ta, head) });
		applyAwarenessUpdate(awB, encodeAwarenessUpdate(awA, [a.clientID]), "remote");
	};
	const carets = () => view.dom.querySelectorAll(".tezca-caret").length;
	return { view, select, carets };
}

describe("remote cursors", () => {
	it("draws one caret per person: a cursor, a word, a whole line (triple-click) and several lines", async () => {
		const text = "Back to the railway\n\nPoints is the British term.\n\n## Anatomy\n";
		const { select, carets } = setup(text);
		const line = text.indexOf("Points");
		const lineEnd = text.indexOf("\n", line);
		for (const [anchor, head] of [
			[line, line], // a cursor
			[line, line + 6], // a word
			[line, lineEnd + 1], // triple-click: the line plus its line break
			[lineEnd + 1, line], // the same, backwards
			[0, text.length], // everything
		]) {
			select(anchor, head);
			await new Promise((r) => setTimeout(r, 0));
			expect(carets(), `selection ${anchor}..${head}`).toBe(1);
		}
	});
});
