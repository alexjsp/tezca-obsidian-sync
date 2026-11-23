// The space index doc: fileId → { path, kind, deleted }.
// Each entry is a nested Y.Map so concurrent edits to different fields merge.
import * as Y from "yjs";

export type EntryKind = "md" | "folder";

export interface Entry {
	id: string;
	path: string; // relative to the space mount, no leading slash
	kind: EntryKind;
	deleted: boolean;
	ctime: number;
	mtime: number;
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
	if (typeof path !== "string" || (kind !== "md" && kind !== "folder")) return null;
	return {
		id,
		path,
		kind,
		deleted: m.get("deleted") === true,
		ctime: Number(m.get("ctime") ?? 0),
		mtime: Number(m.get("mtime") ?? 0),
	};
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
