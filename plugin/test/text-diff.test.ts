import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { applyTextDiff, threeWayMerge } from "../src/core/text-diff";

describe("applyTextDiff", () => {
	it("produces the target text", () => {
		const d = new Y.Doc();
		const t = d.getText("t");
		t.insert(0, "hello world");
		applyTextDiff(t, "hello brave new world!");
		expect(t.toString()).toBe("hello brave new world!");
	});
	it("handles surrogate pairs without corrupting them", () => {
		const d = new Y.Doc();
		const t = d.getText("t");
		t.insert(0, "a😀b");
		applyTextDiff(t, "a😁b");
		expect(t.toString()).toBe("a😁b");
		applyTextDiff(t, "😁😀");
		expect(t.toString()).toBe("😁😀");
	});
	it("merges concurrently with remote edits (CRDT semantics preserved)", () => {
		const a = new Y.Doc();
		const b = new Y.Doc();
		a.getText("t").insert(0, "line one\nline two\n");
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		applyTextDiff(a.getText("t"), "line ONE\nline two\n");
		applyTextDiff(b.getText("t"), "line one\nline two\nline three\n");
		Y.applyUpdate(a, Y.encodeStateAsUpdate(b));
		Y.applyUpdate(b, Y.encodeStateAsUpdate(a));
		expect(a.getText("t").toString()).toBe("line ONE\nline two\nline three\n");
		expect(b.getText("t").toString()).toBe(a.getText("t").toString());
	});
});

describe("threeWayMerge", () => {
	it("applies disjoint edits from both sides", () => {
		const base = "# Title\n\nalpha\n\nbeta\n\ngamma\n";
		const local = "# Title\n\nalpha (edited locally)\n\nbeta\n\ngamma\n";
		const current = "# Title\n\nalpha\n\nbeta\n\ngamma\n\ndelta from remote\n";
		const r = threeWayMerge(base, local, current);
		expect(r.clean).toBe(true);
		expect(r.text).toBe("# Title\n\nalpha (edited locally)\n\nbeta\n\ngamma\n\ndelta from remote\n");
	});
	it("short-circuits trivial cases", () => {
		expect(threeWayMerge("a", "b", "a")).toEqual({ text: "b", clean: true });
		expect(threeWayMerge("a", "a", "c")).toEqual({ text: "c", clean: true });
	});
});
