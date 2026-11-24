// Which space keys a device trusts enough to encrypt with (protocol.md "Key commitments").
//
// Wrapped keys come from the host, and a sealed box can be made by anyone who knows a member's
// public key, so the host could otherwise hand out a key it chose. Each key is therefore
// committed to inside the space's own (encrypted, signed) index: `keys`: epoch → JSON
// {fp, by, sig}, where fp fingerprints the key and sig is `by`'s signature over
// (space, epoch, fp). A device encrypts only with keys it trusts:
//   - the user's own vault (root/profile space): committed by the user's own identity;
//   - a shared folder: committed by an owner this device already knew (owners it saw when it
//     first opened the share, its creator, and owners promoted by a known owner, recorded in the
//     index's `owners` map as {by, sig}), or received through an invite (authenticated by the
//     invite's secret);
//   - keys the device already used before commitments existed (trust on first use).
// Untrusted keys are still used to read, never to write.
import { b64u, blake2b256, fromB64u, sigInput, sign, u32, utf8, verify, type Identity } from "./crypto";

export interface Commitment {
	fp: string;
	by: string;
	sig: string;
}

export function keyFingerprint(key: Uint8Array): string {
	return b64u(blake2b256(utf8("tezca-key-fp"), key));
}

function commitMsg(spaceId: string, epoch: number, fp: string): Uint8Array {
	return sigInput("key-commit", spaceId, u32(epoch), fp);
}

function ownerMsg(spaceId: string, owner: string): Uint8Array {
	return sigInput("owner", spaceId, owner);
}

export function makeCommitment(id: Identity, spaceId: string, epoch: number, key: Uint8Array): Commitment {
	const fp = keyFingerprint(key);
	return { fp, by: b64u(id.signPk), sig: b64u(sign(id, commitMsg(spaceId, epoch, fp))) };
}

export function makeOwnerRecord(id: Identity, spaceId: string, owner: string): { by: string; sig: string } {
	return { by: b64u(id.signPk), sig: b64u(sign(id, ownerMsg(spaceId, owner))) };
}

/** Does commitment `c` vouch for `key` at `epoch`, signed by `c.by`? (Who may sign is the caller's call.) */
export function commitmentValid(c: Commitment, spaceId: string, epoch: number, key: Uint8Array): boolean {
	try {
		return c.fp === keyFingerprint(key) && verify(fromB64u(c.by), commitMsg(spaceId, epoch, c.fp), fromB64u(c.sig));
	} catch {
		return false;
	}
}

export function ownerRecordValid(spaceId: string, owner: string, r: { by: string; sig: string }): boolean {
	try {
		return verify(fromB64u(r.by), ownerMsg(spaceId, owner), fromB64u(r.sig));
	} catch {
		return false;
	}
}

/** What a device remembers about a space's keys (persisted per space). */
export interface TrustState {
	/** Epochs whose keys this device trusts. */
	epochs: number[];
	/** Owners (sign pk, b64u) this device trusts to commit new keys (shared folders). */
	owners: string[];
}
