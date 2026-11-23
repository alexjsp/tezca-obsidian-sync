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

	all(): Mount[] {
		const out: Mount[] = [];
		this.map.forEach((v, spaceId) => {
			try {
				const { path, host } = JSON.parse(v) as { path: string; host?: string };
				if (typeof path === "string" && path) out.push({ spaceId, path, ...(typeof host === "string" && host ? { host } : {}) });
			} catch {
				/* ignore malformed */
			}
		});
		return out.sort((a, b) => (a.path < b.path ? -1 : 1));
	}

	get(spaceId: string): Mount | undefined {
		return this.all().find((m) => m.spaceId === spaceId);
	}

	set(spaceId: string, path: string, origin?: unknown, host?: string): void {
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
