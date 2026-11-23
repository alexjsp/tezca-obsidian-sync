// VaultAdapter backed by Obsidian's Vault API.
import { TFile, TFolder, normalizePath, type App, type TAbstractFile } from "obsidian";
import type { VaultAdapter, VaultEvent, VaultItem } from "../core/vault";

export class ObsidianVault implements VaultAdapter {
	constructor(private readonly app: App) {}

	private get vault() {
		return this.app.vault;
	}

	async list(): Promise<VaultItem[]> {
		const out: VaultItem[] = [];
		for (const f of this.vault.getAllLoadedFiles()) {
			if (f.path === "/" || f.path === "") continue;
			out.push({ path: f.path, kind: f instanceof TFolder ? "folder" : "file" });
		}
		return out;
	}

	async read(path: string): Promise<string | null> {
		const f = this.vault.getAbstractFileByPath(normalizePath(path));
		if (!(f instanceof TFile)) return null;
		return this.vault.read(f);
	}

	async write(path: string, content: string): Promise<void> {
		const p = normalizePath(path);
		const f = this.vault.getAbstractFileByPath(p);
		if (f instanceof TFile) {
			await this.vault.modify(f, content);
			return;
		}
		await this.ensureParent(p);
		await this.vault.create(p, content);
	}

	async mkdir(path: string): Promise<void> {
		const p = normalizePath(path);
		if (this.vault.getAbstractFileByPath(p)) return;
		await this.ensureParent(p);
		await this.vault.createFolder(p);
	}

	async remove(path: string): Promise<void> {
		const f = this.vault.getAbstractFileByPath(normalizePath(path));
		if (!f) return;
		if (f instanceof TFolder && f.children.length) throw new Error("folder not empty");
		// Respects the user's "deleted files" preference (system trash / .trash / permanent).
		await this.app.fileManager.trashFile(f);
	}

	async rename(from: string, to: string): Promise<void> {
		const f = this.vault.getAbstractFileByPath(normalizePath(from));
		if (!f) throw new Error(`rename source missing: ${from}`);
		const dest = normalizePath(to);
		await this.ensureParent(dest);
		// vault.rename (not fileManager.renameFile): links were already updated on the originating device.
		await this.vault.rename(f, dest);
	}

	async exists(path: string): Promise<boolean> {
		return this.vault.getAbstractFileByPath(normalizePath(path)) !== null;
	}

	onEvent(cb: (e: VaultEvent) => void): () => void {
		const kind = (f: TAbstractFile) => (f instanceof TFolder ? "folder" : "file") as "file" | "folder";
		const refs = [
			this.vault.on("create", (f) => cb({ type: "create", path: f.path, kind: kind(f) })),
			this.vault.on("modify", (f) => cb({ type: "modify", path: f.path, kind: kind(f) })),
			this.vault.on("delete", (f) => cb({ type: "delete", path: f.path, kind: kind(f) })),
			this.vault.on("rename", (f, oldPath) => cb({ type: "rename", path: f.path, oldPath, kind: kind(f) })),
		];
		return () => refs.forEach((r) => this.vault.offref(r));
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
