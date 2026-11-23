// VaultAdapter backed by Obsidian's Vault API.
import { TFile, TFolder, normalizePath, type App, type EventRef, type TAbstractFile } from "obsidian";
import type { VaultAdapter, VaultEvent, VaultItem } from "../core/vault";

export class ObsidianVault implements VaultAdapter {
	/** Seen state of config-folder files, for turning raw events and scans into create/modify/delete. */
	private configSeen = new Map<string, number>(); // path → mtime

	/** @param syncConfig include the config folder (.obsidian) in list() and events. */
	constructor(
		private readonly app: App,
		private readonly syncConfig = false,
	) {}

	private get vault() {
		return this.app.vault;
	}

	private get adapter() {
		return this.app.vault.adapter;
	}

	/** Is this a path inside the config folder (not in Obsidian's file index; uses the raw adapter)? */
	private isConfig(path: string): boolean {
		const dir = this.vault.configDir;
		return path === dir || path.startsWith(dir + "/");
	}

	private async listConfig(dir = this.vault.configDir, out: VaultItem[] = []): Promise<VaultItem[]> {
		let listed: { files: string[]; folders: string[] };
		try {
			listed = await this.adapter.list(dir);
		} catch {
			return out;
		}
		for (const f of listed.files) out.push({ path: f, kind: "file" });
		for (const d of listed.folders) {
			if (/\/(node_modules|\.git)$/.test(d)) continue;
			out.push({ path: d, kind: "folder" });
			await this.listConfig(d, out);
		}
		return out;
	}

	async list(): Promise<VaultItem[]> {
		const out: VaultItem[] = [];
		for (const f of this.vault.getAllLoadedFiles()) {
			if (f.path === "/" || f.path === "") continue;
			out.push({ path: f.path, kind: f instanceof TFolder ? "folder" : "file" });
		}
		if (this.syncConfig) {
			out.push({ path: this.vault.configDir, kind: "folder" });
			out.push(...(await this.listConfig()));
		}
		return out;
	}

	async read(path: string): Promise<string | null> {
		if (this.isConfig(path)) return (await this.adapter.exists(path)) ? this.adapter.read(path) : null;
		const f = this.vault.getAbstractFileByPath(normalizePath(path));
		if (!(f instanceof TFile)) return null;
		return this.vault.read(f);
	}

	async write(path: string, content: string): Promise<void> {
		if (this.isConfig(path)) {
			await this.ensureConfigParent(path);
			await this.adapter.write(path, content);
			await this.noteConfig(path);
			return;
		}
		const p = normalizePath(path);
		const f = this.vault.getAbstractFileByPath(p);
		if (f instanceof TFile) {
			await this.vault.modify(f, content);
			return;
		}
		await this.ensureParent(p);
		await this.vault.create(p, content);
	}

	async readBinary(path: string): Promise<Uint8Array | null> {
		if (this.isConfig(path)) return (await this.adapter.exists(path)) ? new Uint8Array(await this.adapter.readBinary(path)) : null;
		const f = this.vault.getAbstractFileByPath(normalizePath(path));
		if (!(f instanceof TFile)) return null;
		return new Uint8Array(await this.vault.readBinary(f));
	}

	async writeBinary(path: string, data: Uint8Array): Promise<void> {
		const buf = data.slice().buffer;
		if (this.isConfig(path)) {
			await this.ensureConfigParent(path);
			await this.adapter.writeBinary(path, buf);
			await this.noteConfig(path);
			return;
		}
		const p = normalizePath(path);
		const f = this.vault.getAbstractFileByPath(p);
		if (f instanceof TFile) {
			await this.vault.modifyBinary(f, buf);
			return;
		}
		await this.ensureParent(p);
		await this.vault.createBinary(p, buf);
	}

	async size(path: string): Promise<number | null> {
		if (this.isConfig(path)) {
			const st = await this.adapter.stat(path);
			return st?.type === "file" ? st.size : null;
		}
		const f = this.vault.getAbstractFileByPath(normalizePath(path));
		return f instanceof TFile ? f.stat.size : null;
	}

	async mkdir(path: string): Promise<void> {
		if (this.isConfig(path)) {
			if (!(await this.adapter.exists(path))) await this.adapter.mkdir(path);
			return;
		}
		const p = normalizePath(path);
		if (this.vault.getAbstractFileByPath(p)) return;
		await this.ensureParent(p);
		await this.vault.createFolder(p);
	}

	async remove(path: string): Promise<void> {
		if (this.isConfig(path)) {
			const st = await this.adapter.stat(path);
			if (st?.type === "file") await this.adapter.remove(path);
			else if (st?.type === "folder") await this.adapter.rmdir(path, false);
			this.configSeen.delete(path);
			return;
		}
		const f = this.vault.getAbstractFileByPath(normalizePath(path));
		if (!f) return;
		if (f instanceof TFolder && f.children.length) throw new Error("folder not empty");
		// Respects the user's "deleted files" preference (system trash / .trash / permanent).
		await this.app.fileManager.trashFile(f);
	}

	async rename(from: string, to: string): Promise<void> {
		if (this.isConfig(from) || this.isConfig(to)) {
			await this.ensureConfigParent(to);
			await this.adapter.rename(from, to);
			this.configSeen.delete(from);
			await this.noteConfig(to);
			return;
		}
		const f = this.vault.getAbstractFileByPath(normalizePath(from));
		if (!f) throw new Error(`rename source missing: ${from}`);
		const dest = normalizePath(to);
		await this.ensureParent(dest);
		// vault.rename (not fileManager.renameFile): links were already updated on the originating device.
		await this.vault.rename(f, dest);
	}

	async exists(path: string): Promise<boolean> {
		if (this.isConfig(path)) return this.adapter.exists(path);
		return this.vault.getAbstractFileByPath(normalizePath(path)) !== null;
	}

	private async ensureConfigParent(path: string) {
		const dir = path.slice(0, path.lastIndexOf("/"));
		if (dir && !(await this.adapter.exists(dir))) await this.adapter.mkdir(dir);
	}

	/** Record a config file's mtime after our own write, so the next scan doesn't report it again. */
	private async noteConfig(path: string) {
		const st = await this.adapter.stat(path).catch(() => null);
		if (st?.type === "file") this.configSeen.set(path, st.mtime);
	}

	/** Compare config files against what we've seen; emit create/modify/delete for the differences. */
	private async scanConfig(cb: (e: VaultEvent) => void, quiet = false) {
		const now = new Map<string, number>();
		for (const item of await this.listConfig()) {
			if (item.kind !== "file") continue;
			const st = await this.adapter.stat(item.path).catch(() => null);
			if (st?.type === "file") now.set(item.path, st.mtime);
		}
		if (!quiet) {
			for (const [p, m] of now) {
				const seen = this.configSeen.get(p);
				if (seen === undefined) cb({ type: "create", path: p, kind: "file" });
				else if (seen !== m) cb({ type: "modify", path: p, kind: "file" });
			}
			for (const p of this.configSeen.keys()) if (!now.has(p)) cb({ type: "delete", path: p, kind: "file" });
		}
		this.configSeen = now;
	}

	onEvent(cb: (e: VaultEvent) => void): () => void {
		const kind = (f: TAbstractFile) => (f instanceof TFolder ? "folder" : "file") as "file" | "folder";
		const refs = [
			this.vault.on("create", (f) => cb({ type: "create", path: f.path, kind: kind(f) })),
			this.vault.on("modify", (f) => cb({ type: "modify", path: f.path, kind: kind(f) })),
			this.vault.on("delete", (f) => cb({ type: "delete", path: f.path, kind: kind(f) })),
			this.vault.on("rename", (f, oldPath) => cb({ type: "rename", path: f.path, oldPath, kind: kind(f) })),
		];
		if (!this.syncConfig) return () => refs.forEach((r) => this.vault.offref(r));
		// The config folder isn't in Obsidian's file index: watch it via raw events (desktop) plus a
		// periodic scan (mobile, and anything the watcher missed).
		let scanning: Promise<void> | null = null;
		const scan = (quiet = false) => {
			if (!scanning) scanning = this.scanConfig(cb, quiet).finally(() => (scanning = null));
			return scanning;
		};
		void scan(true);
		let rawTimer: number | null = null;
		// "raw" fires for every filesystem change, including the config folder (not in the public typings).
		const raw = (this.vault as unknown as { on(name: "raw", cb: (path: string) => void): EventRef }).on("raw", (path: string) => {
			if (!this.isConfig(path)) return;
			if (rawTimer !== null) window.clearTimeout(rawTimer);
			rawTimer = window.setTimeout(() => void scan(), 500);
		});
		const interval = window.setInterval(() => void scan(), 30_000);
		return () => {
			refs.forEach((r) => this.vault.offref(r));
			this.vault.offref(raw);
			window.clearInterval(interval);
			if (rawTimer !== null) window.clearTimeout(rawTimer);
		};
	}

	private async ensureParent(path: string) {
		const idx = path.lastIndexOf("/");
		if (idx <= 0) return;
		const dir = path.slice(0, idx);
		if (this.vault.getAbstractFileByPath(dir)) return;
		await this.ensureParent(dir);
		try {
			await this.vault.createFolder(dir);
		} catch {
			/* raced with another create */
		}
	}
}
