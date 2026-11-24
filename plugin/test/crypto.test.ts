import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	ad, fromHex, hex, identityFromSeed, newSpaceKey, open, recoveryPhrase, seal, seedFromRecoveryPhrase,
	sigInput, sigMsg, u32, u64, unwrapKey, verify, wrapKey, randomBytes, sealPairing, openPairing,
} from "../src/core/crypto";

const vectors = JSON.parse(readFileSync(new URL("../../proto/vectors/sig-vectors.json", import.meta.url), "utf8"));

describe("crypto", () => {
	it("derives the vector identity", () => {
		const id = identityFromSeed(fromHex(vectors.seed_hex));
		expect(hex(id.signPk)).toBe(vectors.sign_pk_hex);
		expect(hex(id.boxPk)).toBe(vectors.box_pk_hex);
		expect(recoveryPhrase(id.seed)).toBe(vectors.recovery_phrase);
		expect(hex(seedFromRecoveryPhrase(vectors.recovery_phrase.toUpperCase()))).toBe(vectors.seed_hex);
	});

	it("matches golden sigInput vectors and signatures verify", () => {
		const id = identityFromSeed(fromHex(vectors.seed_hex));
		const nonce = new Uint8Array(32).fill(7);
		const payload = new Uint8Array([1, 2, 3, 4, 5]);
		const body = new TextEncoder().encode('{"role":"member"}');
		const rebuilt: Record<string, Uint8Array> = {
			auth: sigMsg.auth("srv_test", nonce, id.signPk, "dev-1"),
			http: sigMsg.http("POST", "/api/invites", 1764000000, body),
			redeem: sigMsg.redeem("srv_test", "tok123", id.signPk, id.boxPk),
			update: sigMsg.update("AAAAAAAAAAAAAAAAAAAAAA", "index", 3, payload),
			snapshot: sigMsg.snapshot("AAAAAAAAAAAAAAAAAAAAAA", "index", 42n, 3, payload),
			"ad-update": sigInput("ad-update", "AAAAAAAAAAAAAAAAAAAAAA", "index", u32(3)),
			"u64-max": sigInput("x", u64(0xffffffffffffffffn)),
		};
		for (const c of vectors.cases) {
			expect(hex(rebuilt[c.name]), c.name).toBe(c.input_hex);
			expect(verify(id.signPk, fromHex(c.input_hex), fromHex(c.sig_hex)), c.name).toBe(true);
		}
	});

	it("rejects invalid recovery phrases", () => {
		expect(() => seedFromRecoveryPhrase("abandon abandon abandon")).toThrow();
	});

	it("seals and opens payloads, binding associated data", () => {
		const key = newSpaceKey();
		const ct = seal(key, new Uint8Array([9, 9]), ad.update("s", "d", 0));
		expect([...open(key, ct, ad.update("s", "d", 0))]).toEqual([9, 9]);
		expect(() => open(key, ct, ad.update("s", "other", 0))).toThrow();
	});

	it("wraps space keys to a box key", () => {
		const id = identityFromSeed(randomBytes(32));
		const k = newSpaceKey();
		expect(hex(unwrapKey(wrapKey(k, id.boxPk), id))).toBe(hex(k));
	});

	it("round-trips pairing payloads", () => {
		const secret = randomBytes(32);
		const p = { seed: "abc", host: "https://h", spaceId: "s" };
		expect(openPairing(secret, sealPairing(secret, p))).toEqual(p);
		expect(() => openPairing(randomBytes(32), sealPairing(secret, p))).toThrow();
	});
});

describe("recovery key", () => {
	it("round-trips, forgives formatting, and catches typos", async () => {
		const { recoveryKey, seedFromRecoveryKey, seedFromRecovery, recoveryPhrase: phrase } = await import("../src/core/crypto");
		const seed = new Uint8Array(32).map((_, i) => (i * 37 + 11) & 0xff);
		const key = recoveryKey(seed);
		expect(key).toMatch(/^TZCA(-[A-Z2-7]{5}){11}$/);
		expect(hex(seedFromRecoveryKey(key))).toBe(hex(seed));
		// Lower case, no dashes, spaces, no prefix, 0/1/8 for O/I/B.
		const sloppy = key.toLowerCase().replace(/-/g, " ").replace(/^tzca /, "").replace(/o/g, "0").replace(/i/g, "1").replace(/b/g, "8");
		expect(hex(seedFromRecoveryKey(sloppy))).toBe(hex(seed));
		// One character wrong: rejected, not a different account.
		const chars = key.split("");
		const at = chars.findIndex((c, i) => i > 5 && /[A-Z]/.test(c));
		chars[at] = chars[at] === "A" ? "B" : "A";
		expect(() => seedFromRecoveryKey(chars.join(""))).toThrow(/typo/);
		expect(() => seedFromRecoveryKey("TZCA-ABCDE")).toThrow(/55 characters/);
		// Old 24-word phrases still restore.
		expect(hex(seedFromRecovery(phrase(seed)))).toBe(hex(seed));
		expect(hex(seedFromRecovery(key))).toBe(hex(seed));
	});
});
