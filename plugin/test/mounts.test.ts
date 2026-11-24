// Where shared folders may be mounted (core/mounts.ts).
import { describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Mounts, mountPathProblem, safeFolderName } from "../src/core/mounts";

describe("mount paths", () => {
	const others = [{ spaceId: "s1", path: "Shared/Trip" }];
	it("allows ordinary folders", () => {
		for (const p of ["Trip", "Shared/Club", "Work/Team notes", "Ünïcode folder"]) expect(mountPathProblem(p, others), p).toBeNull();
	});
	it("refuses hidden and config folders, odd paths, and nesting with another share", () => {
		for (const p of [
			".obsidian",
			".obsidian/plugins/dataview",
			"Notes/.hidden",
			".tezca-backup",
			"..",
			"a/../b",
			"/abs",
			"trail/",
			"a//b",
			"back\\slash",
			"ctrl\u0007char",
			"",
			"Shared/Trip",
			"Shared/Trip/inner",
			"Shared",
		])
			expect(mountPathProblem(p, others), JSON.stringify(p)).not.toBeNull();
		// Moving a share onto its own path is fine.
		expect(mountPathProblem("Shared/Trip", others, "s1")).toBeNull();
	});
	it("turns any share name into a safe folder suggestion", () => {
		expect(safeFolderName(".obsidian")).toBe("obsidian");
		expect(safeFolderName("../../etc")).toBe("etc");
		expect(safeFolderName(".obsidian/plugins/x")).toBe("obsidian-plugins-x");
		expect(safeFolderName("Trip 2026")).toBe("Trip 2026");
		expect(safeFolderName("...")).toBe("Shared folder");
	});
	it("ignores invalid or nested mounts that arrive in the mount table, and refuses to set them", () => {
		const doc = new Y.Doc();
		const m = new Mounts(doc);
		m.map.set("a", JSON.stringify({ path: "Trip" }));
		m.map.set("b", JSON.stringify({ path: ".obsidian" }));
		m.map.set("c", JSON.stringify({ path: "Trip/inner" }));
		m.map.set("d", JSON.stringify({ path: "x\\.obsidian" }));
		expect(m.all().map((x) => x.spaceId)).toEqual(["a"]);
		expect(() => m.set("e", ".obsidian")).toThrow(/hidden/);
		expect(() => m.set("e", "Trip/sub")).toThrow(/inside or around/);
		m.set("e", "Elsewhere");
		expect(m.get("e")?.path).toBe("Elsewhere");
	});
});
