// Where each share is mounted in this user's vault (protocol.md "Mounts"). Lives in the root
// space's index doc, so all of the user's devices agree.
import * as Y from "yjs";

export interface Mount {
	spaceId: string;
	/** Vault folder path. */
	path: string;
	/** Host of a share that isn't on the root/profile space's host (normalized URL). */
	host?: string;
}

export class Mounts {
	readonly map: Y.Map<string>;

	constructor(readonly ydoc: Y.Doc) {
		this.map = ydoc.getMap<string>("mounts");
	}

	/**
	 * Valid mounts, by path. The table syncs from other devices (and a compromised host could
	 * tamper with it), so a path that isn't a safe place for a shared folder is ignored here.
	 */
	all(): Mount[] {
		const raw: Mount[] = [];
		this.map.forEach((v, spaceId) => {
			try {
				const { path, host } = JSON.parse(v) as { path: string; host?: string };
				if (typeof path === "string" && !pathProblem(path)) raw.push({ spaceId, path, ...(typeof host === "string" && host ? { host } : {}) });
			} catch {
				/* ignore malformed */
			}
		});
		raw.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.spaceId < b.spaceId ? -1 : 1));
		// Never one shared folder inside (or at) another: the first by path wins.
		const out: Mount[] = [];
		for (const m of raw) if (!out.some((o) => within(m.path, o.path) || within(o.path, m.path))) out.push(m);
		return out;
	}

	get(spaceId: string): Mount | undefined {
		return this.all().find((m) => m.spaceId === spaceId);
	}

	/** Mount (or move) a share at `path`. Throws if that isn't an allowed place (see mountPathProblem). */
	set(spaceId: string, path: string, origin?: unknown, host?: string): void {
		const problem = mountPathProblem(path, this.all(), spaceId);
		if (problem) throw new Error(problem);
		const cur = this.get(spaceId);
		const h = host ?? cur?.host;
		if (cur?.path === path && cur?.host === h) return;
		this.ydoc.transact(() => this.map.set(spaceId, JSON.stringify(h ? { path, host: h } : { path })), origin);
	}

	remove(spaceId: string, origin?: unknown): void {
		if (!this.map.has(spaceId)) return;
		this.ydoc.transact(() => this.map.delete(spaceId), origin);
	}

	/** The mount containing `vaultPath` (or that is it), if any. */
	containing(vaultPath: string): Mount | undefined {
		return this.all().find((m) => vaultPath === m.path || vaultPath.startsWith(m.path + "/"));
	}

	onChange(cb: () => void): () => void {
		const h = () => cb();
		this.map.observe(h);
		return () => this.map.unobserve(h);
	}
}

/** Is `p` the folder `dir` or inside it? */
export function within(p: string, dir: string): boolean {
	return p === dir || p.startsWith(dir + "/");
}

/** Why `path` isn't a valid vault folder for a shared folder at all, or null. */
function pathProblem(path: string): string | null {
	if (!path || path.startsWith("/") || path.endsWith("/") || path.includes("//")) return "isn't a valid folder path";
	// eslint-disable-next-line no-control-regex
	if (/[\\\x00-\x1f\x7f]/.test(path)) return "contains characters that aren't allowed in a folder path";
	if (path.split("/").some((seg) => seg.startsWith(".") || !seg.trim())) return "can't be or be inside a hidden folder (like .obsidian)";
	return null;
}

/**
 * Why a shared folder can't live at `path`, or null if it can: it must be an ordinary folder
 * (not hidden, not the config folder, nothing like `..`), and not inside or around another
 * shared folder. `self` is the share being moved, if any.
 */
export function mountPathProblem(path: string, others: Mount[], self?: string): string | null {
	const p = pathProblem(path);
	if (p) return `"${path}" ${p}.`;
	const clash = others.find((o) => o.spaceId !== self && (within(path, o.path) || within(o.path, path)));
	if (clash) return `"${path}" would be inside or around the shared folder "${clash.path}".`;
	return null;
}

/** A shared folder's (owner-chosen) name made safe to suggest as a vault folder. */
export function safeFolderName(name: string): string {
	// eslint-disable-next-line no-control-regex
	const s = name.replace(/[\/\\\x00-\x1f\x7f]+/g, "-").replace(/^[.\s-]+/, "").trim();
	return s || "Shared folder";
}
