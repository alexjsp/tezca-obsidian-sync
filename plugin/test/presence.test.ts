// Validation of presence data from other people (core/presence.ts).
import { describe, expect, it } from "vitest";
import { safeAvatar, safeColor, safeName } from "../src/core/presence";

describe("presence validation", () => {
	it("accepts hex colours only", () => {
		expect(safeColor("#e8590c", "x")).toBe("#e8590c");
		expect(safeColor("#e8590c33", "x")).toBe("#e8590c33");
		for (const bad of ["red", "#fff", "red; position:fixed", "#e8590c; background:url(x)", "url(https://e/x)", 3, null]) expect(safeColor(bad, "fb")).toBe("fb");
	});
	it("accepts small embedded JPEG/PNG pictures only", () => {
		expect(safeAvatar("data:image/jpeg;base64,/9j/4AAQSkZJRg==")).toBeTruthy();
		for (const bad of ["https://evil/x.png", "data:image/svg+xml;base64,PHN2Zz4=", "data:image/jpeg;base64,abc\"onerror", "data:image/png;base64," + "A".repeat(30_000)])
			expect(safeAvatar(bad)).toBeNull();
	});
	it("keeps names plain and short", () => {
		expect(safeName("  Alex ")).toBe("Alex");
		expect(safeName("a\u0000b\nc")).toBe("abc");
		expect(safeName("x".repeat(100))?.length).toBe(64);
		expect(safeName("   ")).toBeUndefined();
	});
});
