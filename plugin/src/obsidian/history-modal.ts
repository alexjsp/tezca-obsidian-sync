// Version history and recently-deleted UI.
import DiffMatchPatch from "diff-match-patch";
import { App, Modal, Notice, Setting, TFile } from "obsidian";
import type { BlobRef } from "../core/blobs";
import {
	blobVersions,
	deletedFiles,
	listNoteVersions,
	noteVersionText,
	restoreBlobVersion,
	restoreDeleted,
	restoreNoteText,
	type NoteVersion,
} from "../core/history";
import { contentModel, type DiskMirror } from "../core/mirror";
import { log } from "../core/util";
import { copyText } from "./modals";

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

function when(ms: number): string {
	if (!ms) return "unknown time";
	const d = new Date(ms);
	const mins = Math.round((Date.now() - ms) / 60000);
	const rel = mins < 1 ? "just now" : mins < 60 ? `${mins} min ago` : mins < 1440 ? `${Math.round(mins / 60)} h ago` : `${Math.round(mins / 1440)} d ago`;
	return `${d.toLocaleString()} (${rel})`;
}

function size(n: number): string {
	return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** Version list for one file, with a diff (notes) or preview (images) and restore. */
export class HistoryModal extends Modal {
	private listEl!: HTMLElement;
	private viewEl!: HTMLElement;
	private objectUrl: string | null = null;

	constructor(
		app: App,
		private readonly mirror: DiskMirror,
		private readonly file: TFile,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle(`History: ${this.file.name}`);
		this.modalEl.addClass("tezca-history-modal");
		const body = this.contentEl.createDiv({ cls: "tezca-history" });
		this.listEl = body.createDiv({ cls: "tezca-history-list" });
		this.viewEl = body.createDiv({ cls: "tezca-history-view" });
		this.viewEl.setText("Select a version.");
		void this.load();
	}

	onClose() {
		if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
		this.contentEl.empty();
	}

	private entry() {
		const rel = this.mirror.toRel(this.file.path);
		return rel === null ? undefined : this.mirror.index.live().find((e) => e.path === rel);
	}

	private async load() {
		const e = this.entry();
		if (!e) {
			this.listEl.setText("This file isn't synced yet.");
			return;
		}
		if (e.kind === "blob") return this.loadBlob(e.id, blobVersions(e));
		this.listEl.setText("Loading…");
		try {
			const versions = await listNoteVersions(this.mirror.space, e.id);
			this.listEl.empty();
			if (!versions.length) {
				this.listEl.setText("No saved versions yet. A version is saved about an hour after you start editing a note.");
				return;
			}
			for (const v of versions) {
				const item = this.listEl.createDiv({ cls: "tezca-history-item", text: when(v.createdAt) });
				item.createDiv({ cls: "tezca-history-meta", text: size(v.size) });
				item.onclick = () => {
					this.listEl.findAll(".is-active").forEach((el) => el.removeClass("is-active"));
					item.addClass("is-active");
					void this.showNoteVersion(e.id, v);
				};
			}
		} catch (err) {
			log.warn("history load failed", err);
			this.listEl.setText(`Couldn't load history: ${(err as Error).message}. Versions need a connection to the host.`);
		}
	}

	private async showNoteVersion(docId: string, v: NoteVersion) {
		this.viewEl.setText("Loading…");
		try {
			const kind = this.entry()?.kind ?? "md";
			const old = await noteVersionText(this.mirror.space, docId, v.baseSeq, kind);
			const doc = await this.mirror.space.acquire(docId);
			const current = contentModel(kind).read(doc);
			this.mirror.space.release(docId);
			this.viewEl.empty();
			new Setting(this.viewEl)
				.setName(when(v.createdAt))
				.setDesc(old === current ? "Same as the current text." : "Restoring removes the red text and brings back the green text.")
				.addButton((b) => b.setButtonText("Copy text").onClick(async () => {
					new Notice((await copyText(old, this.contentEl)) ? "Copied" : "Couldn't copy");
				}))
				.addButton((b) =>
					b
						.setButtonText("Restore this version")
						.setCta()
						.setDisabled(old === current)
						.onClick(async () => {
							await restoreNoteText(this.mirror, docId, old, kind);
							new Notice(`Restored ${this.file.name}`);
							this.close();
						}),
				);
			renderDiff(this.viewEl.createDiv({ cls: "tezca-diff" }), old, current);
		} catch (err) {
			this.viewEl.setText(`Couldn't load this version: ${(err as Error).message}`);
		}
	}

	private loadBlob(id: string, refs: BlobRef[]) {
		this.listEl.empty();
		refs.forEach((r, i) => {
			const item = this.listEl.createDiv({ cls: "tezca-history-item", text: i === 0 ? "Current version" : when(r.mtime ?? 0) });
			item.createDiv({ cls: "tezca-history-meta", text: size(r.size) });
			item.onclick = () => {
				this.listEl.findAll(".is-active").forEach((el) => el.removeClass("is-active"));
				item.addClass("is-active");
				void this.showBlobVersion(id, r, i === 0);
			};
		});
		if (refs.length < 2) this.viewEl.setText("No earlier versions yet.");
	}

	private async showBlobVersion(id: string, ref: BlobRef, isCurrent: boolean) {
		this.viewEl.empty();
		new Setting(this.viewEl)
			.setName(isCurrent ? "Current version" : when(ref.mtime ?? 0))
			.setDesc(size(ref.size))
			.addButton((b) =>
				b
					.setButtonText("Restore this version")
					.setCta()
					.setDisabled(isCurrent)
					.onClick(() => {
						restoreBlobVersion(this.mirror, id, ref);
						new Notice(`Restoring ${this.file.name}`);
						this.close();
					}),
			);
		const client = this.mirror.opts.blobs;
		if (!client || !IMAGE_EXT.test(this.file.name)) return;
		const preview = this.viewEl.createDiv({ cls: "tezca-history-preview", text: "Loading preview…" });
		try {
			const bytes = await client.download(this.mirror.space, ref);
			if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
			const type = this.file.extension === "svg" ? "image/svg+xml" : `image/${this.file.extension}`;
			this.objectUrl = URL.createObjectURL(new Blob([bytes.slice().buffer], { type }));
			preview.empty();
			preview.createEl("img", { attr: { src: this.objectUrl, alt: this.file.name } });
		} catch (err) {
			preview.setText(`Couldn't load a preview: ${(err as Error).message}`);
		}
	}
}

/** Old → current diff: deletions (in the old version only) red, insertions green. */
function renderDiff(el: HTMLElement, old: string, current: string) {
	const dmp = new DiffMatchPatch();
	const diffs = dmp.diff_main(current, old);
	dmp.diff_cleanupSemantic(diffs);
	// Shown from the point of view of restoring: what restoring would remove/bring back.
	for (const [op, text] of diffs) {
		if (op === 0) el.createSpan({ text });
		else if (op === -1) el.createSpan({ cls: "tezca-diff-del", text });
		else el.createSpan({ cls: "tezca-diff-ins", text });
	}
}

/** Deleted notes and attachments, with restore. */
export class DeletedFilesModal extends Modal {
	constructor(
		app: App,
		private readonly mirror: DiskMirror,
	) {
		super(app);
	}

	onOpen() {
		this.setTitle("Recently deleted");
		this.render();
	}

	private render() {
		this.contentEl.empty();
		const files = deletedFiles(this.mirror).slice(0, 200);
		if (!files.length) {
			this.contentEl.setText("Nothing has been deleted.");
			return;
		}
		const live = new Set(this.mirror.index.live().map((e) => e.path.toLowerCase()));
		for (const e of files) {
			const s = new Setting(this.contentEl).setName(e.path).setDesc(`Deleted ${when(e.mtime)}`);
			if (live.has(e.path.toLowerCase())) s.setDesc(`Deleted ${when(e.mtime)}. A file with this name exists now; restoring adds a renamed copy.`);
			s.addButton((b) =>
				b.setButtonText("Restore").onClick(() => {
					restoreDeleted(this.mirror, e.id);
					new Notice(`Restoring ${e.path}`);
					this.render();
				}),
			);
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
