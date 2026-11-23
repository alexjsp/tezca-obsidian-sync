// Where each share is mounted in this user's vault (protocol.md "Mounts"). Lives in the root
// space's index doc, so all of the user's devices agree.
import * as Y from "yjs";

export interface Mount {
	spaceId: string;
	/** Vault folder path. */
	path: string;
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
				const { path } = JSON.parse(v) as { path: string };
				if (typeof path === "string" && path) out.push({ spaceId, path });
			} catch {
				/* ignore malformed */
			}
		});
		return out.sort((a, b) => (a.path < b.path ? -1 : 1));
	}

	get(spaceId: string): Mount | undefined {
		return this.all().find((m) => m.spaceId === spaceId);
	}

	set(spaceId: string, path: string, origin?: unknown): void {
		this.ydoc.transact(() => this.map.set(spaceId, JSON.stringify({ path })), origin);
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
