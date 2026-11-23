// Abstract vault so the sync engine can run against Obsidian, an in-memory FS (tests/sim), etc.

export interface VaultItem {
	path: string;
	kind: "file" | "folder";
}

export type VaultEvent =
	| { type: "create" | "modify" | "delete"; path: string; kind: "file" | "folder" }
	| { type: "rename"; path: string; oldPath: string; kind: "file" | "folder" };

export interface VaultAdapter {
	list(): Promise<VaultItem[]>;
	/** File content, or null if it does not exist. */
	read(path: string): Promise<string | null>;
	/** Create or overwrite a file, creating parent folders as needed. */
	write(path: string, content: string): Promise<void>;
	mkdir(path: string): Promise<void>;
	/** Delete a file (to trash where supported) or an empty folder. */
	remove(path: string): Promise<void>;
	rename(from: string, to: string): Promise<void>;
	exists(path: string): Promise<boolean>;
	onEvent(cb: (e: VaultEvent) => void): () => void;
}

/** In-memory vault used by tests and the simulator. Emits events asynchronously like Obsidian. */
export class MemoryVault implements VaultAdapter {
	files = new Map<string, string>();
	folders = new Set<string>();
	private listeners = new Set<(e: VaultEvent) => void>();

	private emit(e: VaultEvent) {
		setTimeout(() => {
			for (const l of this.listeners) l(e);
		}, 0);
	}

	private ensureParents(path: string, silent = false) {
		const parts = path.split("/");
		for (let i = 1; i < parts.length; i++) {
			const dir = parts.slice(0, i).join("/");
			if (!this.folders.has(dir)) {
				this.folders.add(dir);
				if (!silent) this.emit({ type: "create", path: dir, kind: "folder" });
			}
		}
	}

	async list() {
		return [
			...[...this.folders].map((path) => ({ path, kind: "folder" as const })),
			...[...this.files.keys()].map((path) => ({ path, kind: "file" as const })),
		];
	}
	async read(path: string) {
		return this.files.get(path) ?? null;
	}
	async write(path: string, content: string) {
		this.ensureParents(path);
		const existed = this.files.has(path);
		this.files.set(path, content);
		this.emit({ type: existed ? "modify" : "create", path, kind: "file" });
	}
	async mkdir(path: string) {
		if (this.folders.has(path)) return;
		this.ensureParents(path);
		this.folders.add(path);
		this.emit({ type: "create", path, kind: "folder" });
	}
	async remove(path: string) {
		if (this.files.delete(path)) this.emit({ type: "delete", path, kind: "file" });
		else if (this.folders.has(path)) {
			const prefix = path + "/";
			if ([...this.files.keys(), ...this.folders].some((p) => p.startsWith(prefix))) throw new Error("folder not empty");
			this.folders.delete(path);
			this.emit({ type: "delete", path, kind: "folder" });
		}
	}
	async rename(from: string, to: string) {
		if (this.files.has(to) || this.folders.has(to)) throw new Error(`rename target exists: ${to}`);
		if (this.files.has(from)) {
			this.ensureParents(to);
			this.files.set(to, this.files.get(from)!);
			this.files.delete(from);
			this.emit({ type: "rename", path: to, oldPath: from, kind: "file" });
			return;
		}
		if (!this.folders.has(from)) throw new Error(`rename source missing: ${from}`);
		this.ensureParents(to);
		const prefix = from + "/";
		for (const f of [...this.folders]) {
			if (f === from || f.startsWith(prefix)) {
				this.folders.delete(f);
				this.folders.add(to + f.slice(from.length));
			}
		}
		for (const [p, c] of [...this.files]) {
			if (p.startsWith(prefix)) {
				this.files.delete(p);
				this.files.set(to + p.slice(from.length), c);
			}
		}
		this.emit({ type: "rename", path: to, oldPath: from, kind: "folder" });
	}
	async exists(path: string) {
		return this.files.has(path) || this.folders.has(path);
	}
	onEvent(cb: (e: VaultEvent) => void) {
		this.listeners.add(cb);
		return () => this.listeners.delete(cb);
	}

	// ── "user" operations for tests/sim: same as above but named for intent ──
	userWrite(path: string, content: string) {
		return this.write(path, content);
	}
}
