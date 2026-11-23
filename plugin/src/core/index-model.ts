// The space index doc: fileId → { path, kind, deleted, … }. Format: protocol.md "Index document".
// Each entry is a nested Y.Map so concurrent edits to different fields merge.
import * as Y from "yjs";
import type { BlobRef } from "./blobs";

export type EntryKind = "md" | "folder" | "blob" | "canvas";

/** How many earlier versions a blob entry keeps. */
export const BLOB_HISTORY = 20;

export interface Entry {
	id: string;
	path: string; // relative to the space mount, no leading slash
	kind: EntryKind;
	deleted: boolean;
	ctime: number;
	mtime: number;
	/** Blob entries: current content, or null while the first upload is pending. */
	blob?: BlobRef | null;
	/** Blob entries: earlier versions, newest first. */
	prev?: BlobRef[];
}

export function canonicalPath(p: string): string {
	return p.normalize("NFC").toLowerCase();
}

export class IndexModel {
	readonly files: Y.Map<Y.Map<unknown>>;

	constructor(readonly ydoc: Y.Doc) {
		this.files = ydoc.getMap("files");
	}

	get(id: string): Entry | null {
		const m = this.files.get(id);
		return m ? toEntry(id, m) : null;
	}

	all(): Entry[] {
		const out: Entry[] = [];
		this.files.forEach((m, id) => {
			const e = toEntry(id, m);
			if (e) out.push(e);
		});
		return out;
	}

	live(): Entry[] {
		return this.all().filter((e) => !e.deleted);
	}

	create(id: string, path: string, kind: EntryKind, origin?: unknown): void {
		this.ydoc.transact(() => {
			const m = new Y.Map<unknown>();
			const now = Date.now();
			m.set("path", path);
			m.set("kind", kind);
			m.set("deleted", false);
			m.set("ctime", now);
			m.set("mtime", now);
			this.files.set(id, m);
		}, origin);
	}

	setPath(id: string, path: string, origin?: unknown): void {
		const m = this.files.get(id);
		if (!m || m.get("path") === path) return;
		this.ydoc.transact(() => {
			m.set("path", path);
			m.set("mtime", Date.now());
		}, origin);
	}

	/** Record a new blob version (the current one moves into `prev`). No-op if unchanged. */
	setBlob(id: string, ref: BlobRef, origin?: unknown): void {
		const m = this.files.get(id);
		if (!m) return;
		const cur = parseRef(m.get("blob"));
		if (cur?.id === ref.id && cur.epoch === ref.epoch) return;
		this.ydoc.transact(() => {
			if (cur) {
				const prev = [cur, ...parseRefs(m.get("prev")).filter((r) => r.id !== ref.id && r.id !== cur.id)].slice(0, BLOB_HISTORY);
				m.set("prev", JSON.stringify(prev));
			}
			m.set("blob", JSON.stringify(ref));
			m.set("mtime", Date.now());
		}, origin);
	}

	tombstone(id: string, origin?: unknown): void {
		const m = this.files.get(id);
		if (!m || m.get("deleted") === true) return;
		this.ydoc.transact(() => {
			m.set("deleted", true);
			m.set("mtime", Date.now());
		}, origin);
	}

	revive(id: string, path: string, origin?: unknown): void {
		const m = this.files.get(id);
		if (!m) return;
		this.ydoc.transact(() => {
			m.set("deleted", false);
			m.set("path", path);
			m.set("mtime", Date.now());
		}, origin);
	}

	/**
	 * Map canonical path → winning live entry. When two live entries claim the same path
	 * (concurrent creates on two devices), the lexicographically smallest id wins and the
	 * others get a deterministic new path, which every client computes identically.
	 */
	resolvePaths(): { byPath: Map<string, Entry>; renames: { id: string; path: string }[] } {
		const byPath = new Map<string, Entry>();
		const losers: Entry[] = [];
		const live = this.live().sort((a, b) => (a.id < b.id ? -1 : 1));
		for (const e of live) {
			const k = canonicalPath(e.path);
			if (byPath.has(k)) {
				if (e.kind === "folder" && byPath.get(k)!.kind === "folder") continue; // duplicate folder entries are harmless
				losers.push(e);
			} else byPath.set(k, e);
		}
		const renames: { id: string; path: string }[] = [];
		for (const e of losers) {
			const p = conflictPath(e.path, e.id);
			renames.push({ id: e.id, path: p });
			byPath.set(canonicalPath(p), { ...e, path: p });
		}
		return { byPath, renames };
	}
}

function toEntry(id: string, m: Y.Map<unknown>): Entry | null {
	const path = m.get("path");
	const kind = m.get("kind");
	if (typeof path !== "string" || (kind !== "md" && kind !== "folder" && kind !== "blob" && kind !== "canvas")) return null;
	const e: Entry = {
		id,
		path,
		kind,
		deleted: m.get("deleted") === true,
		ctime: Number(m.get("ctime") ?? 0),
		mtime: Number(m.get("mtime") ?? 0),
	};
	if (kind === "blob") {
		e.blob = parseRef(m.get("blob"));
		e.prev = parseRefs(m.get("prev"));
	}
	return e;
}

function parseRef(v: unknown): BlobRef | null {
	if (typeof v !== "string") return null;
	try {
		const r = JSON.parse(v) as BlobRef;
		return typeof r.id === "string" && typeof r.hash === "string" && typeof r.epoch === "number" ? r : null;
	} catch {
		return null;
	}
}

function parseRefs(v: unknown): BlobRef[] {
	if (typeof v !== "string") return [];
	try {
		const a = JSON.parse(v) as unknown[];
		return Array.isArray(a) ? a.map((x) => parseRef(JSON.stringify(x))).filter((r): r is BlobRef => r !== null) : [];
	} catch {
		return [];
	}
}

export function conflictPath(path: string, id: string): string {
	const slash = path.lastIndexOf("/");
	const dir = slash >= 0 ? path.slice(0, slash + 1) : "";
	const name = path.slice(slash + 1);
	const dot = name.lastIndexOf(".");
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : "";
	return `${dir}${stem} (${id.slice(0, 6)})${ext}`;
}
