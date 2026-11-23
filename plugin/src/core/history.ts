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
