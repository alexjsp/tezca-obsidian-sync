// Cryptographic primitives for Tezca. See docs/protocol.md ("Encodings").
// Everything here is pure (no Obsidian imports) so it runs in the plugin, tests and the simulator.
import _sodium from "libsodium-wrappers";
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2.js";

export type Sodium = typeof _sodium;
let sodium: Sodium | null = null;

/** Must be awaited once before any other function in this module. */
export async function initCrypto(): Promise<Sodium> {
	if (!sodium) {
		await _sodium.ready;
		sodium = _sodium;
	}
	return sodium;
}

function s(): Sodium {
	if (!sodium) throw new Error("crypto not initialised: await initCrypto() first");
	return sodium;
}

const enc = new TextEncoder();
const dec = new TextDecoder();

export const utf8 = (x: string): Uint8Array => enc.encode(x);
export const fromUtf8 = (x: Uint8Array): string => dec.decode(x);

// ───────────── encodings ─────────────

export function b64u(bytes: Uint8Array): string {
	let bin = "";
	for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
	return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromB64u(str: string): Uint8Array {
	const b64 = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
	const bin = atob(b64);
	const out = new Uint8Array(bin.length);
	for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
	return out;
}

export function hex(bytes: Uint8Array): string {
	return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function fromHex(h: string): Uint8Array {
	const out = new Uint8Array(h.length / 2);
	for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
	return out;
}

export function u32(n: number): Uint8Array {
	const b = new Uint8Array(4);
	new DataView(b.buffer).setUint32(0, n >>> 0, false);
	return b;
}

export function u64(n: bigint | number): Uint8Array {
	const b = new Uint8Array(8);
	new DataView(b.buffer).setBigUint64(0, BigInt(n), false);
	return b;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
	const len = parts.reduce((a, p) => a + p.length, 0);
	const out = new Uint8Array(len);
	let o = 0;
	for (const p of parts) {
		out.set(p, o);
		o += p.length;
	}
	return out;
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
	return true;
}

/** Canonical signature / associated-data input. */
export function sigInput(purpose: string, ...fields: (Uint8Array | string)[]): Uint8Array {
	const parts: Uint8Array[] = [utf8("tezca/v1/" + purpose), new Uint8Array([0])];
	for (const f of fields) {
		const b = typeof f === "string" ? utf8(f) : f;
		parts.push(u32(b.length), b);
	}
	return concat(...parts);
}

export function randomBytes(n: number): Uint8Array {
	return s().randombytes_buf(n);
}

/** 16 random bytes, base64url — used for space and doc ids. */
export function randomId(): string {
	return b64u(randomBytes(16));
}

export function blake2b256(key: Uint8Array, msg: Uint8Array | string): Uint8Array {
	return s().crypto_generichash(32, typeof msg === "string" ? utf8(msg) : msg, key);
}

export function sha256(data: Uint8Array): Uint8Array {
	return nobleSha256(data);
}

/** Fast non-keyed content fingerprint (hex) used for local disk bookkeeping only. */
export function fingerprint(text: string): string {
	return hex(s().crypto_generichash(16, utf8(text), null));
}

/** fingerprint() for raw bytes. fingerprint(text) === bytesFingerprint(utf8(text)). */
export function bytesFingerprint(data: Uint8Array): string {
	return hex(s().crypto_generichash(16, data, null));
}

// ───────────── identity ─────────────

export interface Identity {
	seed: Uint8Array;
	signPk: Uint8Array;
	signSk: Uint8Array;
	boxPk: Uint8Array;
	boxSk: Uint8Array;
}

export function identityFromSeed(seed: Uint8Array): Identity {
	if (seed.length !== 32) throw new Error("identity seed must be 32 bytes");
	const so = s();
	const sign = so.crypto_sign_seed_keypair(blake2b256(seed, "tezca/v1/identity/sign"));
	const box = so.crypto_box_seed_keypair(blake2b256(seed, "tezca/v1/identity/box"));
	return { seed, signPk: sign.publicKey, signSk: sign.privateKey, boxPk: box.publicKey, boxSk: box.privateKey };
}

export function newIdentity(): Identity {
	return identityFromSeed(randomBytes(32));
}

export function recoveryPhrase(seed: Uint8Array): string {
	return entropyToMnemonic(seed, wordlist);
}

export function seedFromRecoveryPhrase(phrase: string): Uint8Array {
	const norm = phrase.trim().toLowerCase().split(/\s+/).join(" ");
	if (!validateMnemonic(norm, wordlist)) throw new Error("Invalid recovery phrase");
	return mnemonicToEntropy(norm, wordlist);
}

// ── Recovery key: the identity seed as one string, e.g. TZCA-ABCDE-FGHIJ-… ──
// RFC 4648 Base32 (A–Z, 2–7) of seed ‖ a 2-byte checksum, in dash-separated groups of five
// behind a TZCA- prefix: 34 bytes → 55 characters → 11 groups. Parsing forgives case, missing
// or extra dashes and spaces, a missing prefix, and 0/1/8 typed for O/I/B. The checksum catches
// typos instead of restoring a different (empty) account.

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RK_PREFIX = "TZCA";

function recoveryChecksum(seed: Uint8Array): Uint8Array {
	return blake2b256(utf8("tezca-recovery-key"), seed).slice(0, 2);
}

function base32(bytes: Uint8Array): string {
	let out = "";
	let bits = 0;
	let value = 0;
	for (const b of bytes) {
		value = (value << 8) | b;
		bits += 8;
		while (bits >= 5) {
			out += B32[(value >>> (bits - 5)) & 31];
			bits -= 5;
		}
	}
	if (bits > 0) out += B32[(value << (5 - bits)) & 31];
	return out;
}

function fromBase32(s: string): Uint8Array {
	const out: number[] = [];
	let bits = 0;
	let value = 0;
	for (const ch of s) {
		const v = B32.indexOf(ch);
		if (v < 0) throw new Error("Invalid recovery key");
		value = ((value << 5) | v) & 0xffff;
		bits += 5;
		if (bits >= 8) {
			out.push((value >>> (bits - 8)) & 0xff);
			bits -= 8;
		}
	}
	return new Uint8Array(out);
}

/** The identity seed as a recovery key: TZCA-XXXXX-XXXXX-… (11 groups). */
export function recoveryKey(seed: Uint8Array): string {
	const chars = base32(concat(seed, recoveryChecksum(seed)));
	return [RK_PREFIX, ...(chars.match(/.{1,5}/g) ?? [])].join("-");
}

/** The seed from a recovery key (lenient about formatting; throws on typos). */
export function seedFromRecoveryKey(key: string): Uint8Array {
	let s = key.toUpperCase().replace(/[^A-Z0-9]/g, "");
	if (s.startsWith(RK_PREFIX)) s = s.slice(RK_PREFIX.length);
	s = s.replace(/0/g, "O").replace(/1/g, "I").replace(/8/g, "B");
	if (s.length !== 55) throw new Error("A recovery key has 55 characters after TZCA-; check you have all of it.");
	const bytes = fromBase32(s);
	const seed = bytes.slice(0, 32);
	const sum = bytes.slice(32, 34);
	if (!bytesEqual(sum, recoveryChecksum(seed))) throw new Error("That recovery key has a typo somewhere; check it character by character.");
	return seed;
}

/** The seed from a recovery key, or from a 24-word recovery phrase (older setups). */
export function seedFromRecovery(input: string): Uint8Array {
	const words = input.trim().split(/\s+/);
	if (words.length >= 12 && words.every((w) => /^[a-z]+$/i.test(w))) return seedFromRecoveryPhrase(input);
	return seedFromRecoveryKey(input);
}

export function sign(id: Identity, msg: Uint8Array): Uint8Array {
	return s().crypto_sign_detached(msg, id.signSk);
}

export function verify(pk: Uint8Array, msg: Uint8Array, sig: Uint8Array): boolean {
	try {
		return s().crypto_sign_verify_detached(sig, msg, pk);
	} catch {
		return false;
	}
}

// ───────────── space keys & payloads ─────────────

export function newSpaceKey(): Uint8Array {
	return s().crypto_aead_xchacha20poly1305_ietf_keygen();
}

export function wrapKey(key: Uint8Array, boxPk: Uint8Array): Uint8Array {
	return s().crypto_box_seal(key, boxPk);
}

export function unwrapKey(wrapped: Uint8Array, id: Identity): Uint8Array {
	return s().crypto_box_seal_open(wrapped, id.boxPk, id.boxSk);
}

const NONCE = 24;

export function seal(key: Uint8Array, plaintext: Uint8Array, ad: Uint8Array): Uint8Array {
	const nonce = randomBytes(NONCE);
	const ct = s().crypto_aead_xchacha20poly1305_ietf_encrypt(plaintext, ad, null, nonce, key);
	return concat(nonce, ct);
}

/** Throws on authentication failure. */
export function open(key: Uint8Array, payload: Uint8Array, ad: Uint8Array): Uint8Array {
	if (payload.length < NONCE + 16) throw new Error("payload too short");
	return s().crypto_aead_xchacha20poly1305_ietf_decrypt(
		null,
		payload.subarray(NONCE),
		ad,
		payload.subarray(0, NONCE),
		key,
	);
}

export const ad = {
	update: (space: string, doc: string, epoch: number) => sigInput("ad-update", space, doc, u32(epoch)),
	snapshot: (space: string, doc: string, epoch: number) => sigInput("ad-snapshot", space, doc, u32(epoch)),
	awareness: (space: string, doc: string, epoch: number) => sigInput("ad-awareness", space, doc, u32(epoch)),
	meta: (space: string, epoch: number) => sigInput("ad-meta", space, u32(epoch)),
	pairing: () => sigInput("ad-pairing"),
	blob: (space: string, blobId: string, epoch: number) => sigInput("ad-blob", space, blobId, u32(epoch)),
	invite: (space: string, epoch: number) => sigInput("ad-invite", space, u32(epoch)),
};

export const sigMsg = {
	auth: (serverId: string, nonce: Uint8Array, signPk: Uint8Array, deviceId: string) =>
		sigInput("auth", serverId, nonce, signPk, deviceId),
	http: (method: string, pathWithQuery: string, ts: number, body: Uint8Array) =>
		sigInput("http", method, pathWithQuery, u64(ts), sha256(body)),
	redeem: (serverId: string, token: string, signPk: Uint8Array, boxPk: Uint8Array) =>
		sigInput("redeem", serverId, token, signPk, boxPk),
	update: (space: string, doc: string, epoch: number, payload: Uint8Array) =>
		sigInput("update", space, doc, u32(epoch), payload),
	snapshot: (space: string, doc: string, baseSeq: bigint, epoch: number, payload: Uint8Array) =>
		sigInput("snapshot", space, doc, u64(baseSeq), u32(epoch), payload),
};

// ───────────── pairing ─────────────

export interface PairingPayload {
	seed: string; // b64u
	host: string;
	spaceId: string;
	displayName?: string;
}

function pairingKey(secret: Uint8Array): Uint8Array {
	return blake2b256(secret, "tezca/v1/pairing");
}

export function sealPairing(secret: Uint8Array, p: PairingPayload): Uint8Array {
	return seal(pairingKey(secret), utf8(JSON.stringify(p)), ad.pairing());
}

export function openPairing(secret: Uint8Array, ct: Uint8Array): PairingPayload {
	return JSON.parse(fromUtf8(open(pairingKey(secret), ct, ad.pairing()))) as PairingPayload;
}

// ───────────── blobs ─────────────

/** Keyed content address of a blob (b64u, 43 chars). See protocol.md "Encrypted payloads". */
export function blobId(spaceKey: Uint8Array, plaintext: Uint8Array): string {
	return b64u(blake2b256(blake2b256(spaceKey, "tezca/v1/blob-id"), plaintext));
}

export function sealBlob(spaceKey: Uint8Array, spaceId: string, id: string, epoch: number, plaintext: Uint8Array): Uint8Array {
	return seal(spaceKey, plaintext, ad.blob(spaceId, id, epoch));
}

/** Decrypts and checks the content address; throws if either fails. */
export function openBlob(spaceKey: Uint8Array, spaceId: string, id: string, epoch: number, payload: Uint8Array): Uint8Array {
	const plain = open(spaceKey, payload, ad.blob(spaceId, id, epoch));
	if (blobId(spaceKey, plain) !== id) throw new Error(`blob ${id} content does not match its id`);
	return plain;
}

// ───────────── share invites ─────────────

function inviteKey(secret: Uint8Array): Uint8Array {
	return blake2b256(secret, "tezca/v1/share-invite");
}

/** Wrap a space key for a share-invite link secret (protocol.md "Share invites"). */
export function wrapForInvite(secret: Uint8Array, spaceId: string, epoch: number, spaceKey: Uint8Array): Uint8Array {
	return seal(inviteKey(secret), spaceKey, ad.invite(spaceId, epoch));
}

export function unwrapInvite(secret: Uint8Array, spaceId: string, epoch: number, wrapped: Uint8Array): Uint8Array {
	return open(inviteKey(secret), wrapped, ad.invite(spaceId, epoch));
}
