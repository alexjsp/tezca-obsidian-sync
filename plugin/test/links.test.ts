// Setup links: protocol.md "Invite links".
import { describe, expect, it } from "vitest";
import { inviteLink, linkParams, parseDeepLink, ShareApi, HostApi } from "../src/core/setup";
import { identityFromSeed } from "../src/core/crypto";

describe("inviteLink", () => {
	it("is the host's invite page with the deep link params in the fragment", () => {
		expect(inviteLink("https://sync.example.com/", { do: "join", host: "https://sync.example.com", token: "t0k" })).toBe(
			"https://sync.example.com/invite#do=join&host=https%3A%2F%2Fsync.example.com&token=t0k",
		);
	});

	it("builds share invites from the share host's URL, keeping k out of the query", () => {
		const share = new ShareApi(new HostApi("https://notes.example.org:8443/"), identityFromSeed(new Uint8Array(32)));
		const link = share.link("tok-1", new Uint8Array([1, 2, 3, 250]));
		expect(link).toBe("https://notes.example.org:8443/invite#do=share&host=https%3A%2F%2Fnotes.example.org%3A8443&token=tok-1&k=AQID-g");
		const u = new URL(link);
		expect(u.search).toBe("");
		expect(linkParams(link)).toEqual({ do: "share", host: "https://notes.example.org:8443", token: "tok-1", k: "AQID-g" });
	});
});

describe("linkParams", () => {
	it("reads an obsidian:// link's query", () => {
		expect(linkParams("obsidian://tezca?do=claim&host=http%3A%2F%2Flocalhost%3A8080&code=dev")).toEqual({
			do: "claim",
			host: "http://localhost:8080",
			code: "dev",
		});
	});

	it("reads an https invite link's fragment, trimming whitespace", () => {
		expect(linkParams("  https://h.example/invite#do=join&host=https%3A%2F%2Fh.example&token=abc\n")).toEqual({
			do: "join",
			host: "https://h.example",
			token: "abc",
		});
		expect(linkParams("http://localhost:8080/invite#do=share&host=http%3A%2F%2Flocalhost%3A8080&token=t&k=s")?.k).toBe("s");
	});

	it("ignores an https link's query (invite params only travel in the fragment)", () => {
		expect(linkParams("https://h.example/invite?do=join&host=x&token=y")).toBeNull();
	});

	it("rejects things that aren't setup links", () => {
		for (const s of ["", "not a link", "https://h.example/invite", "https://h.example/invite#", "https://h.example/#setup", "obsidian://tezca", "ftp://h/#do=join"])
			expect(linkParams(s), s).toBeNull();
	});

	it("feeds parseDeepLink the same way for both forms", () => {
		const a = parseDeepLink(linkParams("obsidian://tezca?do=share&host=https%3A%2F%2Fh.example&token=t&k=s")!);
		const b = parseDeepLink(linkParams("https://h.example/invite#do=share&host=https%3A%2F%2Fh.example&token=t&k=s")!);
		expect(a).toEqual(b);
		expect(b).toMatchObject({ action: "share", host: "https://h.example", token: "t", k: "s" });
	});
});
