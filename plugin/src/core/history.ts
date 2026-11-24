// Version history and restore (protocol.md "History"). Restores are new edits, never rewinds.
import * as Y from "yjs";
import type { BlobRef } from "./blobs";
import { ad, open } from "./crypto";
import type { Entry } from "./index-model";
import { canvasText } from "./canvas";
import { LOCAL_ORIGIN, TEXT_KEY, contentModel, type DiskMirror } from "./mirror";
import type { SpaceSync } from "./space";

export interface NoteVersion {
	baseSeq: bigint;
	/** unix ms */
	createdAt: number;
	size: number;
	epoch: number;
}

/** A note's retained versions on the host, newest first. */
export async function listNoteVersions(space: SpaceSync, docId: string): Promise<NoteVersion[]> {
	const res = await space.conn.request(
		(rid) => ({ case: "listVersions", value: { rid, spaceId: space.spaceId, docId } }),
		"versionList",
	);
	return res.versions.map((v) => ({ baseSeq: v.baseSeq, createdAt: Number(v.createdAt), size: Number(v.size), epoch: v.epoch }));
}

/** A point a note can be restored to: a saved version, or a moment rebuilt from the edit log. */
export interface HistoryPoint {
	/** unix ms */
	at: number;
	/** Size of the text at that point (characters). */
	size: number;
	/** "version": a saved version; "edits": the end of a burst of edits; "before-deletion": just before a large deletion. */
	kind: "version" | "edits" | "before-deletion";
	/** For "before-deletion": how many characters the deletion removed. */
	removed?: number;
	/** The text, when already rebuilt (log points); saved versions are fetched on demand. */
	text?: string;
	/** For saved versions. */
	baseSeq?: bigint;
}

/** A gap this long between edits ends a burst (one restore point per burst). */
const BURST_GAP_MS = 10 * 60_000;

/** A single change counts as a large deletion if it removes at least this share and this many characters. */
const LARGE_DELETION = { share: 0.4, chars: 200 };

interface LogUpdate {
	seq: bigint;
	epoch: number;
	payload: Uint8Array;
	createdAt: number;
}

/** The host's retained update log for a doc (hosts advertising "update-log"). */
async function fetchLog(space: SpaceSync, docId: string): Promise<LogUpdate[]> {
	const out: LogUpdate[] = [];
	let from = 0n;
	for (let page = 0; page < 1000; page++) {
		const res = await space.conn.request(
			(rid) => ({ case: "getUpdates", value: { rid, spaceId: space.spaceId, docId, fromSeq: from, toSeq: 0n } }),
			"updateRange",
		);
		for (const u of res.updates) out.push({ seq: u.seq, epoch: u.epoch, payload: u.payload, createdAt: Number(u.createdAt) });
		if (res.done || !res.updates.length) break;
		from = res.updates[res.updates.length - 1].seq;
	}
	return out;
}

async function versionState(space: SpaceSync, docId: string, baseSeq: bigint): Promise<Uint8Array> {
	const res = await space.conn.request(
		(rid) => ({ case: "getVersion", value: { rid, spaceId: space.spaceId, docId, baseSeq } }),
		"versionData",
	);
	const epoch = res.info?.epoch ?? 0;
	return open(space.keyFor(epoch), res.payload, ad.snapshot(space.spaceId, docId, epoch));
}

/**
 * Every point a note can be restored to, newest first: saved versions, plus (when the host keeps
 * the edit log) the end of each burst of edits and the moment just before each large deletion.
 * The log is rebuilt here, on this device; the host only ever sees encrypted updates.
 */
export async function noteHistory(space: SpaceSync, docId: string, kind = "md"): Promise<HistoryPoint[]> {
	const versions = await listNoteVersions(space, docId);
	const points: HistoryPoint[] = versions.map((v) => ({ at: v.createdAt, size: v.size, kind: "version", baseSeq: v.baseSeq }));
	if (!space.conn.features.has("update-log")) return points;
	const log = await fetchLog(space, docId);
	if (!log.length) return points;

	// Start from the doc's beginning if the log reaches it, else from the oldest saved version the
	// log continues without a gap.
	const first = log[0].seq;
	const doc = new Y.Doc();
	try {
		let start = 0n;
		if (first > 1n) {
			const base = [...versions].sort((a, b) => (a.baseSeq < b.baseSeq ? -1 : 1)).find((v) => v.baseSeq >= first - 1n);
			if (!base) return points;
			Y.applyUpdate(doc, await versionState(space, docId, base.baseSeq));
			start = base.baseSeq;
		}
		const read = () => (kind === "canvas" ? canvasText(doc) : doc.getText(TEXT_KEY).toString());
		let text = read();
		const updates = log.filter((u) => u.seq > start);
		for (let i = 0; i < updates.length; i++) {
			const u = updates[i];
			try {
				Y.applyUpdate(doc, open(space.keyFor(u.epoch), u.payload, ad.update(space.spaceId, docId, u.epoch)));
			} catch {
				continue; // a key this device doesn't have (e.g. from before it joined): skip
			}
			const next = read();
			const removed = text.length - next.length;
			if (removed >= LARGE_DELETION.chars && removed >= text.length * LARGE_DELETION.share)
				points.push({ at: u.createdAt - 1, size: text.length, kind: "before-deletion", removed, text });
			const following = updates[i + 1];
			if (!following || following.createdAt - u.createdAt >= BURST_GAP_MS) points.push({ at: u.createdAt, size: next.length, kind: "edits", text: next });
			text = next;
		}
	} finally {
		doc.destroy();
	}
	return points.sort((a, b) => b.at - a.at);
}

/** The text at a history point. */
export async function pointText(space: SpaceSync, docId: string, p: HistoryPoint, kind = "md"): Promise<string> {
	if (p.text !== undefined) return p.text;
	return noteVersionText(space, docId, p.baseSeq!, kind);
}

/** The text of a note (or canvas) at a retained version. */
export async function noteVersionText(space: SpaceSync, docId: string, baseSeq: bigint, kind = "md"): Promise<string> {
	const res = await space.conn.request(
		(rid) => ({ case: "getVersion", value: { rid, spaceId: space.spaceId, docId, baseSeq } }),
		"versionData",
	);
	const epoch = res.info?.epoch ?? 0;
	const state = open(space.keyFor(epoch), res.payload, ad.snapshot(space.spaceId, docId, epoch));
	const doc = new Y.Doc();
	try {
		Y.applyUpdate(doc, state);
		return kind === "canvas" ? canvasText(doc) : doc.getText(TEXT_KEY).toString();
	} finally {
		doc.destroy();
	}
}

/** Make a note's (or canvas's) current content equal `text` (as a diff, so concurrent edits elsewhere survive). */
export async function restoreNoteText(mirror: DiskMirror, docId: string, text: string, kind = "md"): Promise<void> {
	const doc = await mirror.space.acquireSynced(docId);
	try {
		contentModel(kind).write(doc, text, null);
	} finally {
		mirror.space.release(docId);
	}
	mirror.scheduleWrite(docId);
}

/** An attachment's versions: current first, then earlier ones. */
export function blobVersions(e: Entry): BlobRef[] {
	return [...(e.blob ? [e.blob] : []), ...(e.prev ?? [])];
}

/** Make an earlier attachment version current again (the current one moves into history). */
export function restoreBlobVersion(mirror: DiskMirror, id: string, ref: BlobRef): void {
	mirror.index.setBlob(id, { ...ref, mtime: Date.now() }, LOCAL_ORIGIN);
	mirror.scheduleWrite(id);
}

/** Deleted notes and attachments that can be restored, most recently deleted first. */
export function deletedFiles(mirror: DiskMirror): Entry[] {
	return mirror.index
		.all()
		.filter((e) => e.deleted && e.kind !== "folder")
		.sort((a, b) => b.mtime - a.mtime);
}

/** Bring a deleted file back at its last path (a path collision gets the usual " (id)" rename). */
export function restoreDeleted(mirror: DiskMirror, id: string): void {
	const e = mirror.index.get(id);
	if (!e || !e.deleted) return;
	mirror.restoreEntry(id);
}
