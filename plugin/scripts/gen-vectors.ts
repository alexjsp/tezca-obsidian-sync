// Generates proto/vectors/sig-vectors.json: deterministic cross-language test vectors for
// sigInput construction and Ed25519 signatures. Verified by plugin tests and server Go tests.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { b64u, hex, identityFromSeed, initCrypto, sigMsg, sign, u32, u64, sigInput, recoveryPhrase } from "../src/core/crypto";

await initCrypto();
const seed = new Uint8Array(32).map((_, i) => i);
const id = identityFromSeed(seed);
const nonce = new Uint8Array(32).fill(7);
const payload = new Uint8Array([1, 2, 3, 4, 5]);
const body = new TextEncoder().encode('{"role":"member"}');

const cases = [
	{ name: "auth", input: sigMsg.auth("srv_test", nonce, id.signPk, "dev-1") },
	{ name: "http", input: sigMsg.http("POST", "/api/invites", 1764000000, body) },
	{ name: "redeem", input: sigMsg.redeem("srv_test", "tok123", id.signPk, id.boxPk) },
	{ name: "update", input: sigMsg.update("AAAAAAAAAAAAAAAAAAAAAA", "index", 3, payload) },
	{ name: "snapshot", input: sigMsg.snapshot("AAAAAAAAAAAAAAAAAAAAAA", "index", 42n, 3, payload) },
	{ name: "ad-update", input: sigInput("ad-update", "AAAAAAAAAAAAAAAAAAAAAA", "index", u32(3)) },
	{ name: "u64-max", input: sigInput("x", u64(0xffffffffffffffffn)) },
];

const out = {
	seed_hex: hex(seed),
	recovery_phrase: recoveryPhrase(seed),
	sign_pk_hex: hex(id.signPk),
	box_pk_hex: hex(id.boxPk),
	sign_pk_b64u: b64u(id.signPk),
	cases: cases.map((c) => ({ name: c.name, input_hex: hex(c.input), sig_hex: hex(sign(id, c.input)) })),
};
const path = fileURLToPath(new URL("../../proto/vectors/sig-vectors.json", import.meta.url));
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log("wrote", path);
