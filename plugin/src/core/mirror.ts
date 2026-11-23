// DiskMirror: keeps a space's files on disk and its CRDT state in agreement.
// Implements the disk contract in docs/plan.md ("Disk bridge / conflicts").
import type * as Y from "yjs";
import type { BlobClient, BlobRef } from "./blobs";
import { bytesFingerprint, fingerprint, randomId } from "./crypto";
import { REMOTE_ORIGIN, type DocSync } from "./doc-sync";
import { IndexModel, canonicalPath, type Entry } from "./index-model";
import { INDEX_DOC, type SpaceSync } from "./space";
import { applyTextDiff, threeWayMerge } from "./text-diff";
import type { VaultAdapter, VaultEvent } from "./vault";
import { Emitter, log, Semaphore } from "./util";

export const LOCAL_ORIGIN = "tezca-local";
export const TEXT_KEY = "content";

/** Last state where disk and CRDT agreed, per file id. */
interface Baseline {
	path: string; // space-relative
	hash: string;
	/** Doc seq when the baseline was recorded (decimal). Used by the startup fast path. */
	seq?: string;
}

interface MirrorState {
	baselines: Record<string, Baseline>;
	/** vault paths that are deliberately not synced (conflict artifacts, preserved files). */
	localOnly: string[];
}

export interface MirrorOptions {
	/** Vault folder the space is mounted at; "" for the root space. */
	mount: string;
	deviceName: string;
	/** Is this vault path currently bound to a live editor? */
	isBound?: (vaultPath: string) => boolean;
	/** Safety brake thresholds. */
	brake?: { minFiles: number; fraction: number };
	now?: () => Date;
	/** Transfers attachments and other non-Markdown files. Without it only Markdown syncs. */
	blobs?: BlobClient;
	/** Largest file (bytes) synced as a blob. */
	maxBlobBytes?: () => number;
	/** Delay before retrying a failed blob transfer. */
	retryMs?: number;
}

/** Default blob size cap when the host doesn't say. */
export const DEFAULT_MAX_BLOB_BYTES = 100 * 1024 * 1024;
const BLOB_CONCURRENCY = 4;
/** Downloaded blobs waiting to be written are kept up to this many bytes (oldest evicted first). */
const DOWNLOAD_CACHE_BYTES = 64 * 1024 * 1024;

/** What kind of entry a file at this path is. */
export function fileKind(path: string): "md" | "blob" {
	return path.toLowerCase().endsWith(".md") ? "md" : "blob";
}

export interface MirrorNotice {
	kind: "conflict" | "brake" | "preserved" | "error";
	message: string;
	paths?: string[];
}

export function textOf(doc: DocSync): Y.Text {
	return doc.ydoc.getText(TEXT_KEY);
}

/** Quiet period before verifying touched files against the CRDT. */
const SWEEP_DEBOUNCE_MS = 150;

/** The file changed on disk between our read and our write; the write was skipped. */
class DiskChanged extends Error {
	constructor(readonly vaultPath: string) {
		super(`disk changed under ${vaultPath}`);
	}
}

export class DiskMirror {
	readonly notices = new Emitter<MirrorNotice>();
	readonly idleChanged = new Emitter<boolean>();
	index!: IndexModel;
	private state: MirrorState = { baselines: {}, localOnly: [] };
	private localOnly = new Set<string>();
	private ready = false;
	private queue: Promise<unknown> = Promise.resolve();
	private queueDepth = 0;
	private expectedWrites = new Map<string, string[]>(); // vault path → hashes
	private expectedDeletes = new Set<string>();
	private expectedRenames = new Map<string, string>(); // new path → old path
	/** File ids whose disk/CRDT agreement must be (re)verified. */
	private touched = new Set<string>();
	private sweepTimer: ReturnType<typeof setTimeout> | null = null;
	private offs: (() => void)[] = [];
	private stateTimer: ReturnType<typeof setTimeout> | null = null;
	private indexTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;
	// Blob transfers run outside the serial queue; verifyBlob picks up their results.
	private downloaded = new Map<string, Uint8Array>(); // blob id → plaintext ready to write
	private downloadedBytes = 0;
	private uploaded = new Map<string, BlobRef>(); // plaintext hash → uploaded, not yet recorded
	/** Transfer key → entry ids to re-verify when it finishes (several entries can share a blob). */
	private inflight = new Map<string, Set<string>>();
	private transferSlots = new Semaphore(BLOB_CONCURRENCY);
	private retryIds = new Set<string>();
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private tooLarge = new Set<string>();

	constructor(
		readonly space: SpaceSync,
		readonly vault: VaultAdapter,
		readonly opts: MirrorOptions,
	) {}

	private get stateKey() {
		return `mirror/${this.space.spaceId}`;
	}

	// ───────────── path helpers ─────────────

	toVault(rel: string): string {
		return this.opts.mount ? `${this.opts.mount}/${rel}` : rel;
	}

	/** Vault path → space-relative path, or null if outside this space's mount. */
	toRel(vaultPath: string): string | null {
		const m = this.opts.mount;
		if (!m) return vaultPath;
		if (vaultPath === m) return "";
		return vaultPath.startsWith(m + "/") ? vaultPath.slice(m.length + 1) : null;
	}

	/** Is this vault path something we sync (Markdown / folders, not hidden, not local-only)? */
	inScope(vaultPath: string, kind: "file" | "folder"): boolean {
		const rel = this.toRel(vaultPath);
		if (rel === null || rel === "") return false;
		if (rel.split("/").some((seg) => seg.startsWith("."))) return false;
		if (this.localOnly.has(vaultPath)) return false;
		if (kind === "file") return fileKind(rel) === "md" || this.opts.blobs !== undefined;
		return true;
	}

	private isBound(vaultPath: string): boolean {
		return this.opts.isBound?.(vaultPath) ?? false;
	}

	// ───────────── lifecycle ─────────────

	async start(): Promise<void> {
		const st = await this.space.store.get<MirrorState>(this.stateKey);
		if (st) this.state = st;
		this.localOnly = new Set(this.state.localOnly);
		this.index = new IndexModel(this.space.index.ydoc);
		this.offs.push(
			this.vault.onEvent((e) => this.onVaultEvent(e)),
			this.space.index.remoteApplied.on(() => this.scheduleIndexReconcile()),
			this.space.docApplied.on((docId) => {
				if (docId !== INDEX_DOC) this.scheduleWrite(docId);
			}),
			this.space.remoteChanged.on((docId) => {
				if (this.ready && docId !== INDEX_DOC) this.fetchRemote(docId);
			}),
		);
	}

	/**
	 * Run the startup reconcile. Call once the index has synced with the server
	 * (or immediately when offline, to work from local state).
	 */
	async initialReconcile(): Promise<void> {
		await this.enqueue(() => this.reconcileAll());
		this.ready = true;
		for (const d of this.space.staleDocs()) if (d !== INDEX_DOC) this.fetchRemote(d);
		const first = this.touched.values().next();
		if (!first.done) this.touch(first.value);
	}

	get isReady(): boolean {
		return this.ready;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const off of this.offs) off();
		if (this.sweepTimer) clearTimeout(this.sweepTimer);
		if (this.retryTimer) clearTimeout(this.retryTimer);
		await this.queue.catch(() => undefined);
		await this.saveState();
	}

	/** Resolves when all queued work has finished. */
	async idle(): Promise<void> {
		for (;;) {
			const q = this.queue;
			await q.catch(() => undefined);
			if (q === this.queue && this.touched.size === 0 && !this.sweepTimer && this.inflight.size === 0) return;
			if (q === this.queue) await new Promise((r) => setTimeout(r, SWEEP_DEBOUNCE_MS + 10));
		}
	}

	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		this.queueDepth++;
		if (this.queueDepth === 1) this.idleChanged.emit(false);
		const run = this.queue.then(
			() => (this.stopped ? (undefined as T) : fn()),
			() => (this.stopped ? (undefined as T) : fn()),
		);
		this.queue = run
			.catch((e) => {
				if (e instanceof DiskChanged) return this.touchPath(e.vaultPath);
				log.error("mirror task failed", e);
				this.notices.emit({ kind: "error", message: String(e) });
			})
			.finally(() => {
				this.queueDepth--;
				if (this.queueDepth === 0) this.idleChanged.emit(true);
			});
		return run;
	}

	// ───────────── state ─────────────

	private async setBaseline(id: string, rel: string, text: string) {
		const hash = fingerprint(text);
		const prev = this.state.baselines[id];
		this.state.baselines[id] = { path: rel, hash, seq: this.space.localSeq(id).toString() };
		this.scheduleStateSave();
		if (prev?.hash !== hash) await this.space.store.put(`basetext/${this.space.spaceId}/${id}`, text);
	}

	private setBlobBaseline(id: string, rel: string, hash: string) {
		this.state.baselines[id] = { path: rel, hash };
		this.scheduleStateSave();
	}

	/** Content fingerprint of a file on disk (text or bytes per its kind), or null if missing. */
	private async diskHash(vp: string, kind: "md" | "blob" | "folder"): Promise<string | null> {
		if (kind === "blob") {
			const b = await this.vault.readBinary(vp);
			return b ? bytesFingerprint(b) : null;
		}
		const t = await this.vault.read(vp);
		return t === null ? null : fingerprint(t);
	}

	private dropBaseline(id: string) {
		if (!(id in this.state.baselines)) return;
		delete this.state.baselines[id];
		this.scheduleStateSave();
		void this.space.store.delete(`basetext/${this.space.spaceId}/${id}`);
	}

	private addLocalOnly(vaultPath: string) {
		this.localOnly.add(vaultPath);
		this.state.localOnly = [...this.localOnly];
		this.scheduleStateSave();
	}

	private scheduleStateSave() {
		if (this.stateTimer) return;
		this.stateTimer = setTimeout(() => {
			this.stateTimer = null;
			void this.saveState();
		}, 500);
	}

	async saveState(): Promise<void> {
		if (this.stateTimer) {
			clearTimeout(this.stateTimer);
			this.stateTimer = null;
		}
		await this.space.store.put(this.stateKey, this.state);
	}

	/**
	 * The live entry for a file at `rel` on disk. Prefers the file we last materialized there
	 * (baseline), because during path collisions or pending renames the index's owner of a path
	 * can differ from what is actually on disk; falls back to the index.
	 */
	private entryByPath(rel: string): Entry | undefined {
		const k = canonicalPath(rel);
		for (const [id, b] of Object.entries(this.state.baselines)) {
			if (canonicalPath(b.path) !== k) continue;
			const e = this.index.get(id);
			if (e && !e.deleted) return e;
		}
		return this.index.resolvePaths().byPath.get(k);
	}

	// ───────────── expected self-events ─────────────

	/**
	 * Write a file we own the content of. With `expected`, this is a compare-and-swap: if the
	 * file no longer holds `expected` (a user edit landed after we read it) nothing is written and
	 * DiskChanged is thrown; the file is re-verified shortly after.
	 */
	private async selfWrite(vaultPath: string, text: string, expected?: string | null) {
		if (expected !== undefined && (await this.vault.read(vaultPath)) !== expected) throw new DiskChanged(vaultPath);
		const list = this.expectedWrites.get(vaultPath) ?? [];
		list.push(fingerprint(text));
		if (list.length > 8) list.shift();
		this.expectedWrites.set(vaultPath, list);
		await this.vault.write(vaultPath, text);
	}

	/** Write bytes we own; with `expected` (a disk hash, or null for "absent") a compare-and-swap. */
	private async selfWriteBinary(vaultPath: string, data: Uint8Array, expected?: string | null) {
		if (expected !== undefined && (await this.diskHash(vaultPath, "blob")) !== expected) throw new DiskChanged(vaultPath);
		const list = this.expectedWrites.get(vaultPath) ?? [];
		list.push(bytesFingerprint(data));
		if (list.length > 8) list.shift();
		this.expectedWrites.set(vaultPath, list);
		await this.vault.writeBinary(vaultPath, data);
	}

	private consumeExpectedWrite(vaultPath: string, text: string): boolean {
		return this.consumeExpectedHash(vaultPath, fingerprint(text));
	}

	private consumeExpectedHash(vaultPath: string, h: string): boolean {
		const list = this.expectedWrites.get(vaultPath);
		if (!list) return false;
		const i = list.indexOf(h);
		if (i === -1) return false;
		list.splice(0, i + 1); // this and every older expectation are settled
		if (!list.length) this.expectedWrites.delete(vaultPath);
		return true;
	}

	private async selfRemove(vaultPath: string) {
		this.expectedDeletes.add(vaultPath);
		try {
			await this.vault.remove(vaultPath);
		} catch (e) {
			this.expectedDeletes.delete(vaultPath);
			throw e;
		}
	}

	private async selfRename(from: string, to: string) {
		this.expectedRenames.set(to, from);
		try {
			await this.vault.rename(from, to);
		} catch (e) {
			this.expectedRenames.delete(to);
			throw e;
		}
	}

	// ───────────── conflict artifacts ─────────────

	private async writeConflictCopy(vaultPath: string, text: string, why: string): Promise<string> {
		const d = (this.opts.now?.() ?? new Date()).toISOString().slice(0, 16).replace("T", " ").replace(":", "");
		const dot = vaultPath.toLowerCase().endsWith(".md") ? vaultPath.length - 3 : vaultPath.length;
		let p = `${vaultPath.slice(0, dot)} (conflict ${this.opts.deviceName} ${d})${vaultPath.slice(dot)}`;
		for (let i = 2; await this.vault.exists(p); i++) p = `${vaultPath.slice(0, dot)} (conflict ${this.opts.deviceName} ${d} ${i})${vaultPath.slice(dot)}`;
		this.addLocalOnly(p);
		await this.selfWrite(p, text);
		this.notices.emit({ kind: "conflict", message: `${why}: kept your version as "${p}"`, paths: [vaultPath, p] });
		return p;
	}

	private conflictCopyPath(vaultPath: string, n: number): string {
		const d = (this.opts.now?.() ?? new Date()).toISOString().slice(0, 16).replace("T", " ").replace(":", "");
		const slash = vaultPath.lastIndexOf("/");
		const dot = vaultPath.lastIndexOf(".");
		const cut = dot > slash + 1 ? dot : vaultPath.length;
		return `${vaultPath.slice(0, cut)} (conflict ${this.opts.deviceName} ${d}${n > 1 ? ` ${n}` : ""})${vaultPath.slice(cut)}`;
	}

	private async writeConflictCopyBinary(vaultPath: string, data: Uint8Array, why: string): Promise<string> {
		let p = this.conflictCopyPath(vaultPath, 1);
		for (let i = 2; await this.vault.exists(p); i++) p = this.conflictCopyPath(vaultPath, i);
		this.addLocalOnly(p);
		await this.selfWriteBinary(p, data);
		this.notices.emit({ kind: "conflict", message: `${why}: kept your version as "${p}"`, paths: [vaultPath, p] });
		return p;
	}

	// ───────────── startup reconcile ─────────────

	private async reconcileAll(): Promise<void> {
		// 1. deterministic resolution of path collisions in the index
		const { renames } = this.index.resolvePaths();
		for (const r of renames) this.index.setPath(r.id, r.path, LOCAL_ORIGIN);
		const { byPath } = this.index.resolvePaths();

		const disk = await this.vault.list();
		const diskFiles = new Map<string, string>(); // canonical rel → actual vault path
		const diskFolders = new Map<string, string>();
		for (const item of disk) {
			if (!this.inScope(item.path, item.kind)) continue;
			const rel = this.toRel(item.path)!;
			(item.kind === "file" ? diskFiles : diskFolders).set(canonicalPath(rel), item.path);
		}

		const plan: (() => Promise<void>)[] = [];
		let overwrites = 0;
		let deletes = 0;

		// 2. live index entries; entries that moved since we last materialized them go first, so
		//    their files leave the old path before another entry claims it.
		const moved = (e: Entry) => {
			const b = this.state.baselines[e.id];
			return b && b.path !== e.path ? 0 : 1;
		};
		for (const e of [...byPath.values()].sort((a, b) => moved(a) - moved(b))) {
			const k = canonicalPath(e.path);
			const vp = this.toVault(e.path);
			if (e.kind === "folder") {
				if (!diskFolders.has(k)) plan.push(() => this.vault.mkdir(vp));
				diskFolders.delete(k);
				continue;
			}
			const actual = diskFiles.get(k);
			diskFiles.delete(k);
			const base = this.state.baselines[e.id];
			if (base && base.path !== e.path && actual === undefined) {
				// Renamed remotely while we were away: move the old file if it is still there.
				const oldK = canonicalPath(base.path);
				const oldVp = diskFiles.get(oldK);
				if (oldVp !== undefined) {
					diskFiles.delete(oldK);
					plan.push(async () => {
						await this.selfRename(oldVp, vp);
						this.state.baselines[e.id] = { ...base, path: e.path };
						await this.reconcileEntry(e, vp, this.state.baselines[e.id]);
					});
					continue;
				}
			}
			const decision = await this.peekFile(e, actual ?? vp, base, actual !== undefined);
			if (decision === "overwrite") overwrites++;
			if (decision === "delete") deletes++;
			plan.push(() => this.reconcileEntry(e, actual ?? vp, base));
		}

		// 3. tombstoned entries whose files are still on disk
		const tombByPath = new Map<string, Entry>();
		for (const e of this.index.all()) if (e.deleted) tombByPath.set(canonicalPath(e.path), e);

		// 4. disk files without a live entry
		for (const [k, vp] of diskFiles) {
			const tomb = tombByPath.get(k);
			if (tomb) {
				const base = this.state.baselines[tomb.id];
				if (base && (await this.diskHash(vp, tomb.kind)) === base.hash) deletes++;
				plan.push(() => this.handleRemoteDelete(tomb, vp));
			} else plan.push(() => this.importNewFile(vp));
		}
		for (const [, vp] of diskFolders) plan.push(() => this.importNewFolder(vp));

		// 5. tombstones with baselines whose file is gone everywhere: forget the baseline
		for (const e of this.index.all()) if (e.deleted && this.state.baselines[e.id] && !diskFiles.has(canonicalPath(e.path))) this.dropBaseline(e.id);

		// 6. safety brake
		const total = Math.max(1, [...byPath.values()].filter((e) => e.kind !== "folder").length);
		const brake = this.opts.brake ?? { minFiles: 20, fraction: 0.25 };
		const destructive = overwrites + deletes;
		if (destructive > brake.minFiles && destructive / total > brake.fraction) {
			this.notices.emit({
				kind: "brake",
				message: `Sync paused: reconciling would overwrite or delete ${destructive} of ${total} notes. Check the vault and use "Force full reconcile" if this is expected.`,
			});
			this.brakeEngaged = true;
		}
		for (const step of plan) {
			try {
				await step();
			} catch (e) {
				if (e instanceof DiskChanged) this.touchPath(e.vaultPath);
				else log.error("reconcile step failed", e);
			}
		}
		this.brakeEngaged = false;
		await this.saveState();
	}

	private brakeEngaged = false;

	/** Dry-run classification used by the safety brake. */
	private async peekFile(e: Entry, vp: string, base: Baseline | undefined, onDisk: boolean): Promise<"none" | "overwrite" | "delete"> {
		if (!onDisk) return base ? "delete" : "none";
		if (!base) return "none";
		if (e.kind === "blob") {
			const dh = await this.diskHash(vp, "blob");
			return dh === base.hash && e.blob && e.blob.hash !== base.hash ? "overwrite" : "none";
		}
		const d = await this.vault.read(vp);
		if (d === null || fingerprint(d) !== base.hash) return "none";
		const seq = this.space.localSeq(e.id);
		const head = this.space.heads.get(e.id) ?? seq;
		return head > seq ? "overwrite" : "none";
	}

	private reconcileEntry(e: Entry, vp: string, base: Baseline | undefined): Promise<void> {
		return e.kind === "blob" ? this.reconcileBlob(e, vp, base) : this.reconcileFile(e, vp, base);
	}

	/** Startup reconcile of a blob entry: detect offline deletes, then verify. */
	private async reconcileBlob(e: Entry, vp: string, base: Baseline | undefined): Promise<void> {
		if (base && !(await this.vault.exists(vp))) {
			// Deleted while we were not running. A newer remote version beats the delete.
			if (this.brakeEngaged) return;
			if (!e.blob || e.blob.hash === base.hash) {
				this.index.tombstone(e.id, LOCAL_ORIGIN);
				this.dropBaseline(e.id);
				return;
			}
		}
		await this.verifyBlob(e.id);
	}

	/** Bring one live file entry and its disk file into agreement (three-way on baseline/disk/CRDT). */
	private async reconcileFile(e: Entry, vp: string, base: Baseline | undefined): Promise<void> {
		const stale = (this.space.heads.get(e.id) ?? 0n) > this.space.localSeq(e.id);
		if (base && !stale && base.path === e.path) {
			const d0 = await this.vault.read(vp);
			if (d0 !== null && fingerprint(d0) === base.hash && base.seq === this.space.localSeq(e.id).toString() && !this.space.isLoaded(e.id)) {
				// Disk unchanged since last sync and no newer remote state: nothing to do.
				return;
			}
		}
		const doc = stale ? await this.space.acquireSynced(e.id) : await this.space.acquire(e.id);
		try {
			const ytext = textOf(doc);
			const C = ytext.toString();
			const D = await this.vault.read(vp);
			if (D === null) {
				if (base) {
					// Previously materialized here and now gone: deleted while we were not running.
					if (fingerprint(C) === base.hash || !doc.isSynced) {
						if (this.brakeEngaged) return;
						this.index.tombstone(e.id, LOCAL_ORIGIN);
						this.dropBaseline(e.id);
					} else {
						// Remote edits since our baseline beat the offline delete.
						await this.selfWrite(vp, C, null);
						await this.setBaseline(e.id, e.path, C);
					}
				} else {
					await this.selfWrite(vp, C, null);
					await this.setBaseline(e.id, e.path, C);
				}
				return;
			}
			if (D === C) {
				await this.setBaseline(e.id, e.path, D);
				return;
			}
			const dh = fingerprint(D);
			const ch = fingerprint(C);
			if (!base) {
				// No shared history: CRDT keeps the path, disk version is preserved.
				if (this.brakeEngaged) return;
				await this.writeConflictCopy(vp, D, "Local file differed from synced version");
				await this.selfWrite(vp, C, D);
				await this.setBaseline(e.id, e.path, C);
				return;
			}
			if (dh !== base.hash && ch === base.hash) {
				applyTextDiff(ytext, D, LOCAL_ORIGIN);
				await this.setBaseline(e.id, e.path, D);
				return;
			}
			if (dh === base.hash && ch !== base.hash) {
				if (this.brakeEngaged) return;
				await this.selfWrite(vp, C, D);
				await this.setBaseline(e.id, e.path, C);
				return;
			}
			// Both changed: merge disk's changes onto the CRDT.
			await this.mergeDiskIntoCrdt(e, vp, doc, D, base);
		} finally {
			this.space.release(e.id);
		}
	}

	private async baselineText(id: string, base: Baseline | undefined): Promise<string | null> {
		if (!base) return null;
		const t = (await this.space.store.get<string>(`basetext/${this.space.spaceId}/${id}`)) ?? null;
		return t !== null && fingerprint(t) === base.hash ? t : null;
	}

	private async mergeDiskIntoCrdt(e: Entry, vp: string, doc: DocSync, D: string, base: Baseline): Promise<void> {
		const ytext = textOf(doc);
		const C = ytext.toString();
		const B = await this.baselineText(e.id, base);
		let merged: string;
		let clean: boolean;
		if (B === null) {
			// Baseline text unavailable: cannot merge safely.
			merged = C;
			clean = false;
		} else ({ text: merged, clean } = threeWayMerge(B, D, C));
		if (!clean) await this.writeConflictCopy(vp, D, "Edits made outside Obsidian could not be merged automatically");
		applyTextDiff(ytext, merged, LOCAL_ORIGIN);
		// The CRDT now contains D's changes: D is the new common ancestor until disk catches up.
		const rel = this.toRel(vp)!;
		await this.setBaseline(e.id, rel, D);
		if (merged !== D) await this.selfWrite(vp, merged, D);
		await this.setBaseline(e.id, rel, merged);
	}

	// ───────────── local vault events ─────────────

	private onVaultEvent(ev: VaultEvent) {
		if (!this.ready || this.stopped) return;
		const relevant =
			this.inScope(ev.path, ev.kind) || (ev.type === "rename" && this.inScope(ev.oldPath, ev.kind));
		if (!relevant) {
			// Still consume self-expectations so they don't leak.
			if (ev.type === "delete") this.expectedDeletes.delete(ev.path);
			return;
		}
		void this.enqueue(() => this.handleVaultEvent(ev));
	}

	private async handleVaultEvent(ev: VaultEvent): Promise<void> {
		switch (ev.type) {
			case "create":
			case "modify":
				if (ev.kind === "folder") return this.importNewFolder(ev.path);
				return this.onLocalWrite(ev.path);
			case "delete":
				if (this.expectedDeletes.delete(ev.path)) return;
				return this.onLocalDelete(ev.path, ev.kind);
			case "rename":
				if (this.expectedRenames.get(ev.path) === ev.oldPath) {
					this.expectedRenames.delete(ev.path);
					return;
				}
				return this.onLocalRename(ev.oldPath, ev.path, ev.kind);
		}
	}

	private async onLocalWrite(vp: string): Promise<void> {
		if (fileKind(vp) === "blob") return this.onLocalBlobWrite(vp);
		const D = await this.vault.read(vp);
		const rel = this.toRel(vp)!;
		if (D === null) {
			// Moved/deleted before we got here; let the sweep reconcile whatever is there now.
			const gone = this.entryByPath(rel);
			if (gone) this.touch(gone.id);
			return;
		}
		if (this.consumeExpectedWrite(vp, D)) return;
		const e = this.entryByPath(rel);
		if (!e) return this.importNewFile(vp);
		if (e.kind !== "md") return;
		const doc = await this.space.acquire(e.id);
		try {
			const ytext = textOf(doc);
			const C = ytext.toString();
			if (D === C) {
				await this.setBaseline(e.id, rel, D);
				return;
			}
			if (this.isBound(vp)) return; // the live editor is authoritative while open
			const base = this.state.baselines[e.id];
			if (!base) {
				// We never materialized this entry here: the file on disk is a different note.
				await this.createEntryFor(rel, D);
				this.touch(e.id);
				return;
			}
			if (fingerprint(C) === base.hash) {
				// CRDT hasn't moved since disk was last in sync (or no history): disk change is the edit.
				applyTextDiff(ytext, D, LOCAL_ORIGIN);
				await this.setBaseline(e.id, rel, D);
				return;
			}
			await this.mergeDiskIntoCrdt(e, vp, doc, D, base);
		} finally {
			this.space.release(e.id);
			if (canonicalPath(rel) !== canonicalPath(e.path)) this.touch(e.id); // a rename is pending
		}
	}

	private async onLocalBlobWrite(vp: string): Promise<void> {
		const rel = this.toRel(vp)!;
		const D = await this.vault.readBinary(vp);
		if (D === null) {
			const gone = this.entryByPath(rel);
			if (gone) this.touch(gone.id);
			return;
		}
		if (this.consumeExpectedHash(vp, bytesFingerprint(D))) return;
		const e = this.entryByPath(rel);
		if (!e) return this.createBlobEntry(rel, D);
		if (e.kind !== "blob") return;
		if (!this.state.baselines[e.id]) {
			// We never materialized this entry here: the file on disk is a different file.
			await this.createBlobEntry(rel, D);
			this.touch(e.id);
			return;
		}
		this.touch(e.id); // verifyBlob decides: upload a local edit, or a conflict
	}

	private maxBlobBytes(): number {
		return this.opts.maxBlobBytes?.() ?? DEFAULT_MAX_BLOB_BYTES;
	}

	private warnTooLarge(vp: string, size: number) {
		if (this.tooLarge.has(vp)) return;
		this.tooLarge.add(vp);
		const mb = (n: number) => `${Math.round(n / 1024 / 1024)} MB`;
		this.notices.emit({ kind: "error", message: `"${vp}" is ${mb(size)}, over this host's ${mb(this.maxBlobBytes())} limit, so it isn't synced.`, paths: [vp] });
	}

	/** Track a local non-Markdown file as a new entry; its upload happens in verifyBlob. */
	private async createBlobEntry(rel: string, D: Uint8Array): Promise<void> {
		if (D.length > this.maxBlobBytes()) return this.warnTooLarge(this.toVault(rel), D.length);
		await this.ensureFolderEntries(rel);
		const id = randomId();
		this.index.create(id, rel, "blob", LOCAL_ORIGIN);
		this.setBlobBaseline(id, rel, bytesFingerprint(D));
		this.applyCollisionRenames();
		this.touch(id);
	}

	private async importNewFile(vp: string): Promise<void> {
		if (fileKind(vp) === "blob") {
			const rel = this.toRel(vp)!;
			const existing = this.entryByPath(rel);
			if (existing && this.state.baselines[existing.id]) return this.onLocalBlobWrite(vp);
			const D = await this.vault.readBinary(vp);
			return D === null ? undefined : this.createBlobEntry(rel, D);
		}
		const D = await this.vault.read(vp);
		if (D === null) return;
		const rel = this.toRel(vp)!;
		const existing = this.entryByPath(rel);
		if (existing && this.state.baselines[existing.id]) return this.onLocalWrite(vp);
		await this.createEntryFor(rel, D);
	}

	/**
	 * Track a local file as a brand-new entry. If the index already has a (never materialized
	 * here) entry at the same path, they are different files: collision resolution renames one.
	 */
	private async createEntryFor(rel: string, D: string): Promise<void> {
		await this.ensureFolderEntries(rel);
		const id = randomId();
		this.index.create(id, rel, "md", LOCAL_ORIGIN);
		const doc = await this.space.acquire(id);
		try {
			textOf(doc).insert(0, D);
			await this.setBaseline(id, rel, D);
		} finally {
			this.space.release(id);
		}
		this.applyCollisionRenames();
	}

	/** Apply deterministic renames for live entries sharing a path, and re-verify them. */
	private applyCollisionRenames(): void {
		const { renames } = this.index.resolvePaths();
		for (const r of renames) {
			this.index.setPath(r.id, r.path, LOCAL_ORIGIN);
			this.touch(r.id);
			for (const [id, b] of Object.entries(this.state.baselines)) {
				// whoever is on disk at the contested path must be re-verified too
				if (id !== r.id && canonicalPath(b.path) === canonicalPath(this.index.get(r.id)?.path ?? "")) this.touch(id);
			}
		}
	}

	private async importNewFolder(vp: string): Promise<void> {
		const rel = this.toRel(vp)!;
		if (!(await this.vault.exists(vp))) return;
		await this.ensureFolderEntries(rel + "/x");
	}

	/** Ensure folder entries exist for every ancestor of `rel`. */
	private async ensureFolderEntries(rel: string) {
		const parts = rel.split("/");
		const live = this.index.resolvePaths().byPath;
		for (let i = 1; i < parts.length; i++) {
			const dir = parts.slice(0, i).join("/");
			const cur = live.get(canonicalPath(dir));
			if (cur) continue;
			const tomb = this.index.all().find((e) => e.deleted && e.kind === "folder" && canonicalPath(e.path) === canonicalPath(dir));
			if (tomb) this.index.revive(tomb.id, dir, LOCAL_ORIGIN);
			else this.index.create(randomId(), dir, "folder", LOCAL_ORIGIN);
		}
	}

	private async onLocalDelete(vp: string, kind: "file" | "folder"): Promise<void> {
		const rel = this.toRel(vp)!;
		const e = this.entryByPath(rel);
		if (e) {
			this.index.tombstone(e.id, LOCAL_ORIGIN);
			this.dropBaseline(e.id);
		}
		if (kind === "folder" || e?.kind === "folder") {
			const prefix = canonicalPath(rel) + "/";
			for (const c of this.index.live()) {
				if (canonicalPath(c.path).startsWith(prefix)) {
					this.index.tombstone(c.id, LOCAL_ORIGIN);
					this.dropBaseline(c.id);
				}
			}
		}
	}

	private async onLocalRename(oldVp: string, newVp: string, kind: "file" | "folder"): Promise<void> {
		const oldIn = this.inScope(oldVp, kind) || (this.toRel(oldVp) !== null && this.entryByPath(this.toRel(oldVp)!) !== undefined);
		const newIn = this.inScope(newVp, kind);
		const oldRel = this.toRel(oldVp);
		const newRel = this.toRel(newVp);
		const e = oldRel ? this.entryByPath(oldRel) : undefined;
		if (!e) {
			if (newIn && newRel && this.entryByPath(newRel)) return; // already moved (e.g. child of a renamed folder)
			if (newIn) return kind === "folder" ? this.importFolderTree(newVp) : this.importNewFile(newVp);
			return;
		}
		if (kind === "file" && e.kind !== "folder" && newRel !== null && fileKind(newRel) !== e.kind) {
			// The extension changed between Markdown and other: a different kind of entry.
			if (oldIn) await this.onLocalDelete(oldVp, kind);
			if (newIn) await this.importNewFile(newVp);
			return;
		}
		if (!newIn || newRel === null) {
			// Moved out of the synced area: treat as delete.
			if (oldIn) return this.onLocalDelete(oldVp, kind);
			return;
		}
		await this.ensureFolderEntries(newRel);
		const movedIds: string[] = [e.id];
		this.index.ydoc.transact(() => {
			this.index.setPath(e.id, newRel, LOCAL_ORIGIN);
			const b = this.state.baselines[e.id];
			if (b) this.state.baselines[e.id] = { ...b, path: newRel };
			if (kind === "folder" || e.kind === "folder") {
				const prefix = canonicalPath(oldRel!) + "/";
				for (const c of this.index.live()) {
					if (!canonicalPath(c.path).startsWith(prefix)) continue;
					const moved = newRel + c.path.slice(oldRel!.length);
					this.index.setPath(c.id, moved, LOCAL_ORIGIN);
					movedIds.push(c.id);
					const cb = this.state.baselines[c.id];
					if (cb) this.state.baselines[c.id] = { ...cb, path: moved };
				}
			}
		}, LOCAL_ORIGIN);
		this.scheduleStateSave();
		for (const id of movedIds) if (this.index.get(id)?.kind !== "folder") this.touch(id);
	}

	private async importFolderTree(vp: string) {
		await this.importNewFolder(vp);
		const prefix = vp + "/";
		for (const item of await this.vault.list()) {
			if (!item.path.startsWith(prefix) || !this.inScope(item.path, item.kind)) continue;
			if (item.kind === "folder") await this.importNewFolder(item.path);
			else await this.importNewFile(item.path);
		}
	}

	// ───────────── remote changes ─────────────

	private scheduleIndexReconcile() {
		if (!this.ready || this.indexTimer) return;
		this.indexTimer = setTimeout(() => {
			this.indexTimer = null;
			void this.enqueue(() => this.applyRemoteIndex());
		}, 50);
	}

	/** Apply remote index changes: creates, renames, deletes. */
	private async applyRemoteIndex(): Promise<void> {
		const { renames } = this.index.resolvePaths();
		for (const r of renames) this.index.setPath(r.id, r.path, LOCAL_ORIGIN);
		const { byPath } = this.index.resolvePaths();
		const folders = [...byPath.values()].filter((e) => e.kind === "folder").sort((a, b) => a.path.length - b.path.length);
		for (const f of folders) {
			const vp = this.toVault(f.path);
			if (!(await this.vault.exists(vp))) await this.vault.mkdir(vp);
		}
		for (const r of renames) this.touch(r.id);
		for (const e of byPath.values()) {
			if (e.kind === "folder") continue;
			const base = this.state.baselines[e.id];
			if (e.kind === "blob") {
				if (!base || base.path !== e.path || (e.blob && e.blob.hash !== base.hash)) this.touch(e.id);
				continue;
			}
			if (!base) this.fetchRemote(e.id); // new file from elsewhere
			else if (base.path !== e.path) this.touch(e.id); // renamed elsewhere
		}
		for (const e of this.index.all()) {
			if (!e.deleted || !this.state.baselines[e.id]) continue;
			const vp = this.toVault(this.state.baselines[e.id].path);
			await this.handleRemoteDelete(e, vp);
		}
		// Remove folders tombstoned remotely, deepest first, only if empty.
		const deadFolders = this.index
			.all()
			.filter((e) => e.deleted && e.kind === "folder" && !byPath.has(canonicalPath(e.path)))
			.sort((a, b) => b.path.length - a.path.length);
		for (const f of deadFolders) {
			const vp = this.toVault(f.path);
			if (!(await this.vault.exists(vp))) continue;
			const prefix = vp + "/";
			const items = await this.vault.list();
			if (items.some((i) => i.path.startsWith(prefix))) continue;
			try {
				await this.selfRemove(vp);
			} catch (err) {
				log.debug("folder remove failed", err);
			}
		}
	}

	private async handleRemoteDelete(e: Entry, vp: string): Promise<void> {
		const base = this.state.baselines[e.id];
		const dh = await this.diskHash(vp, e.kind);
		if (dh === null) {
			this.dropBaseline(e.id);
			return;
		}
		if (base && dh === base.hash) {
			if (this.brakeEngaged) return;
			await this.selfRemove(vp);
			this.dropBaseline(e.id);
			return;
		}
		if (base && e.kind === "blob") {
			// Local edits since last sync beat the remote delete: revive; verifyBlob uploads them.
			this.index.revive(e.id, this.toRel(vp)!, LOCAL_ORIGIN);
			this.touch(e.id);
			this.notices.emit({ kind: "preserved", message: `"${vp}" was deleted on another device but had local changes, so it was kept.`, paths: [vp] });
			return;
		}
		const D = (await this.vault.read(vp)) ?? "";
		if (base) {
			// Local edits since last sync beat the remote delete: revive.
			const rel = this.toRel(vp)!;
			this.index.revive(e.id, rel, LOCAL_ORIGIN);
			const doc = await this.space.acquire(e.id);
			try {
				applyTextDiff(textOf(doc), D, LOCAL_ORIGIN);
				await this.setBaseline(e.id, rel, D);
			} finally {
				this.space.release(e.id);
			}
			this.notices.emit({ kind: "preserved", message: `"${vp}" was deleted on another device but had local changes, so it was kept.`, paths: [vp] });
			return;
		}
		// Unknown baseline: preserve locally without reviving.
		this.addLocalOnly(vp);
		this.notices.emit({
			kind: "preserved",
			message: `"${vp}" was deleted on another device; your local copy is kept but no longer synced.`,
			paths: [vp],
		});
	}

	/** A file doc has (or may have) newer remote content: sync it and write it to disk. */
	fetchRemote(docId: string): void {
		if (this.stopped) return;
		void (async () => {
			await this.space.acquireSynced(docId);
			this.scheduleWrite(docId);
			this.space.release(docId);
		})().catch((e) => log.warn("fetchRemote failed", e));
	}

	/** Request that a file's disk copy be verified against (and brought in line with) its CRDT. */
	scheduleWrite(docId: string): void {
		this.touch(docId);
	}

	private touchPath(vaultPath: string): void {
		const rel = this.toRel(vaultPath);
		const e = rel === null ? undefined : this.entryByPath(rel);
		if (e) this.touch(e.id);
	}

	private touch(id: string): void {
		if (id === INDEX_DOC || this.stopped) return;
		this.touched.add(id);
		if (!this.ready) return;
		if (this.sweepTimer) clearTimeout(this.sweepTimer);
		this.sweepTimer = setTimeout(() => {
			this.sweepTimer = null;
			// Renames first, so a moved file vacates its old path before anything else claims it.
			const moving = (id: string) => {
				const b = this.state.baselines[id];
				const e = this.index.get(id);
				return b && e && b.path !== e.path ? 0 : 1;
			};
			const ids = [...this.touched].sort((a, b) => moving(a) - moving(b));
			this.touched.clear();
			void this.enqueue(async () => {
				this.applyCollisionRenames();
				for (const id of ids) {
					try {
						await this.verifyFile(id);
					} catch (e) {
						if (e instanceof DiskChanged) this.touch(id);
						else throw e;
					}
				}
			});
		}, SWEEP_DEBOUNCE_MS);
	}

	/**
	 * Bring one live file's disk copy and CRDT into agreement. Runs from the serial queue after
	 * pending vault events, so it sees post-event state. Never deletes; deletions come from events.
	 */
	private async verifyFile(id: string): Promise<void> {
		const e = this.index.get(id);
		if (e?.kind === "blob") return this.verifyBlob(id);
		if (!e || e.deleted || e.kind !== "md") return;
		const vp = this.toVault(e.path);
		if (this.isBound(vp)) return;
		const base = await this.locate(e);
		if (base === false) return;
		const doc = await this.space.acquire(id);
		try {
			const ytext = textOf(doc);
			const C = ytext.toString();
			const D = await this.vault.read(vp);
			if (D === C) {
				await this.setBaseline(id, e.path, C);
				return;
			}
			if (D === null) {
				await this.selfWrite(vp, C, null);
				await this.setBaseline(id, e.path, C);
				return;
			}
			if (!base) {
				await this.writeConflictCopy(vp, D, "A different local file existed at this path");
				await this.selfWrite(vp, C, D);
				await this.setBaseline(id, e.path, C);
				return;
			}
			const dh = fingerprint(D);
			if (dh === base.hash) {
				await this.selfWrite(vp, C, D); // disk is stale
				await this.setBaseline(id, e.path, C);
				return;
			}
			if (fingerprint(C) === base.hash) {
				applyTextDiff(ytext, D, LOCAL_ORIGIN); // unimported local edit
				await this.setBaseline(id, e.path, D);
				return;
			}
			await this.mergeDiskIntoCrdt(e, vp, doc, D, base);
		} finally {
			this.space.release(id);
		}
	}

	/**
	 * Shared verify prelude: make sure `e` owns its path, follow a rename made elsewhere, and wait
	 * for any other tracked file still sitting at the path to move away. Returns the (updated)
	 * baseline, or false if verification should stop for now.
	 */
	private async locate(e: Entry): Promise<Baseline | undefined | false> {
		const id = e.id;
		const { byPath } = this.index.resolvePaths();
		if (byPath.get(canonicalPath(e.path))?.id !== id) return false;
		const vp = this.toVault(e.path);
		let base = this.state.baselines[id];
		// Follow a rename made elsewhere.
		if (base && base.path !== e.path) {
			const oldVp = this.toVault(base.path);
			// Only move the old file if it is still ours (unchanged since last sync).
			if ((await this.diskHash(oldVp, e.kind)) === base.hash && !(await this.vault.exists(vp))) {
				await this.selfRename(oldVp, vp);
			}
			base = { ...base, path: e.path };
			this.state.baselines[id] = base;
			this.scheduleStateSave();
		}
		// Another tracked file still sits at this path (e.g. a collision loser not yet moved away).
		for (const [other, b] of Object.entries(this.state.baselines)) {
			if (other === id || canonicalPath(b.path) !== canonicalPath(e.path)) continue;
			const oe = this.index.get(other);
			if (oe && !oe.deleted && canonicalPath(oe.path) !== canonicalPath(e.path)) {
				await this.verifyFile(other); // moves it to its new path
			}
			if (canonicalPath(this.state.baselines[other]?.path ?? "") === canonicalPath(e.path) && this.index.get(other) && !this.index.get(other)!.deleted) {
				this.touch(id); // still occupied; retry later
				return false;
			}
		}
		return base;
	}

	// ───────────── blobs ─────────────

	/**
	 * Bring a blob entry and its disk file into agreement. Like Markdown, but whole-file: a local
	 * edit is uploaded and recorded; a remote version is downloaded and written; when both changed,
	 * the remote version wins and the local one is kept as a local-only conflict copy.
	 * Transfers run outside the queue and re-touch the entry when done.
	 */
	private async verifyBlob(id: string): Promise<void> {
		const e = this.index.get(id);
		if (!e || e.deleted || e.kind !== "blob" || !this.opts.blobs) return;
		const vp = this.toVault(e.path);
		const base = await this.locate(e);
		if (base === false) return;
		const C = e.blob ?? null;
		const D = await this.vault.readBinary(vp);
		const dh = D ? bytesFingerprint(D) : null;
		if (!C) {
			// First upload still pending: ours (we have the baseline) or another device's.
			if (D && base) await this.commitLocalBlob(e, D, dh!);
			return;
		}
		if (dh === C.hash) {
			this.setBlobBaseline(id, e.path, dh);
			this.uploaded.delete(dh);
			return;
		}
		if (D === null) {
			await this.writeRemoteBlob(e, C, null);
			return;
		}
		if (!base) {
			// A different local file sat at this path: keep it as a conflict copy.
			if (!this.downloaded.has(C.id)) return this.startDownload(e.id, C);
			await this.writeConflictCopyBinary(vp, D, "A different local file existed at this path");
			await this.writeRemoteBlob(e, C, dh);
			return;
		}
		if (dh === base.hash) {
			// Disk is stale. If our version is nowhere in the entry's history, it was recorded
			// concurrently with the winning one and lost the race: keep it as a conflict copy.
			const known = (e.prev ?? []).some((r) => r.hash === dh);
			if (!known) {
				if (!this.downloaded.has(C.id)) return this.startDownload(e.id, C);
				await this.writeConflictCopyBinary(vp, D, "This file was changed on another device too");
			}
			await this.writeRemoteBlob(e, C, dh);
			return;
		}
		if (C.hash === base.hash) {
			await this.commitLocalBlob(e, D, dh!); // local edit
			return;
		}
		// Changed on both sides: last writer wins; keep ours locally.
		if (!this.downloaded.has(C.id)) return this.startDownload(e.id, C);
		await this.writeConflictCopyBinary(vp, D, "This file was changed on another device too");
		await this.writeRemoteBlob(e, C, dh);
	}

	/** Write a downloaded version (compare-and-swap against `expected`), or start its download. */
	private async writeRemoteBlob(e: Entry, C: BlobRef, expected: string | null): Promise<void> {
		const bytes = this.downloaded.get(C.id);
		if (!bytes) return this.startDownload(e.id, C);
		await this.selfWriteBinary(this.toVault(e.path), bytes, expected);
		this.setBlobBaseline(e.id, e.path, C.hash);
	}

	/** Record a local version once uploaded, or start its upload. */
	private async commitLocalBlob(e: Entry, D: Uint8Array, dh: string): Promise<void> {
		if (D.length > this.maxBlobBytes()) return this.warnTooLarge(this.toVault(e.path), D.length);
		const ref = this.uploaded.get(dh);
		if (!ref) return this.startUpload(e.id, D, dh);
		this.index.setBlob(e.id, ref, LOCAL_ORIGIN);
		this.setBlobBaseline(e.id, e.path, dh);
		this.uploaded.delete(dh);
	}

	/** Run a transfer once per key; every entry waiting on it is re-verified when it ends. */
	private transfer<T>(key: string, entryId: string, run: () => Promise<T>, done: (v: T) => void): void {
		const waiting = this.inflight.get(key);
		if (waiting) {
			waiting.add(entryId);
			return;
		}
		const ids = new Set([entryId]);
		this.inflight.set(key, ids);
		void this.transferSlots
			.run(run)
			.then((v) => {
				done(v);
				for (const id of ids) this.touch(id);
			})
			.catch((err) => {
				log.warn(`blob transfer ${key} failed; will retry`, err);
				for (const id of ids) this.scheduleRetry(id);
			})
			.finally(() => this.inflight.delete(key));
	}

	private startDownload(entryId: string, ref: BlobRef): void {
		if (this.downloaded.has(ref.id) || !this.opts.blobs) return;
		this.transfer(`d:${ref.id}`, entryId, () => this.opts.blobs!.download(this.space, ref), (bytes) => this.cacheDownload(ref.id, bytes));
	}

	/** Keep downloads until written; bounded so a big first sync doesn't hold everything in memory. */
	private cacheDownload(id: string, bytes: Uint8Array) {
		this.downloaded.set(id, bytes);
		this.downloadedBytes += bytes.length;
		for (const [old, b] of this.downloaded) {
			if (this.downloadedBytes <= DOWNLOAD_CACHE_BYTES || old === id) break;
			this.downloaded.delete(old);
			this.downloadedBytes -= b.length;
		}
	}

	private startUpload(entryId: string, D: Uint8Array, dh: string): void {
		if (this.uploaded.has(dh) || !this.opts.blobs) return;
		this.transfer(`u:${dh}`, entryId, () => this.opts.blobs!.upload(this.space, D), (ref) => this.uploaded.set(dh, ref));
	}

	private scheduleRetry(id: string): void {
		if (this.stopped) return;
		this.retryIds.add(id);
		if (this.retryTimer) return;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.retryTransfers();
		}, this.opts.retryMs ?? 30_000);
	}

	/** Retry failed blob transfers now (e.g. after reconnecting). */
	retryTransfers(): void {
		const ids = [...this.retryIds];
		this.retryIds.clear();
		for (const id of ids) this.touch(id);
	}

	/** Revive a deleted entry at its last path and write it back to disk. */
	restoreEntry(id: string): Promise<void> {
		return this.enqueue(async () => {
			const e = this.index.get(id);
			if (!e || !e.deleted) return;
			await this.ensureFolderEntries(e.path);
			for (const dir of folderAncestors(e.path)) {
				const vp = this.toVault(dir);
				if (!(await this.vault.exists(vp))) await this.vault.mkdir(vp);
			}
			this.index.revive(id, e.path, LOCAL_ORIGIN);
			this.applyCollisionRenames();
			this.touch(id);
		});
	}

	/** After an editor closes, make sure disk catches up with the CRDT. */
	afterUnbind(vaultPath: string): void {
		const rel = this.toRel(vaultPath);
		if (rel === null) return;
		const e = this.entryByPath(rel);
		if (e) setTimeout(() => this.scheduleWrite(e.id), 1500);
	}

	/**
	 * Called right before binding an editor: bring the file on disk and its CRDT into agreement
	 * (disk is how local edits arrive), and report both texts.
	 *
	 * The editor's own text is deliberately NOT an input. Obsidian points a view at a new file before
	 * it loads that file's text, so at bind time the editor may still show the previous note; merging
	 * it in once overwrote a note with another note's content. The caller only binds when the editor
	 * shows one of the texts returned here.
	 */
	prepareEditor(docId: string, vaultPath: string): Promise<{ crdt: string; disk: string | null }> {
		return this.enqueue(async () => {
			try {
				await this.verifyFile(docId);
			} catch (e) {
				if (!(e instanceof DiskChanged)) throw e;
			}
			const doc = await this.space.acquire(docId);
			try {
				return { crdt: textOf(doc).toString(), disk: await this.vault.read(vaultPath) };
			} finally {
				this.space.release(docId);
			}
		});
	}

	/** Resolve a vault path to its file doc id (live entries only). */
	docIdFor(vaultPath: string): string | null {
		const rel = this.toRel(vaultPath);
		if (rel === null) return null;
		const e = this.entryByPath(rel);
		return e && e.kind === "md" ? e.id : null;
	}

	/** Make sure a file has an entry (e.g. a note opened before its create event was processed). */
	async ensureEntry(vaultPath: string): Promise<string | null> {
		if (!this.inScope(vaultPath, "file")) return null;
		const existing = this.docIdFor(vaultPath);
		if (existing) return existing;
		await this.enqueue(() => this.importNewFile(vaultPath));
		return this.docIdFor(vaultPath);
	}

	get pendingWork(): number {
		return this.queueDepth + this.touched.size;
	}
}

export { REMOTE_ORIGIN };

/** "a/b/c.md" → ["a", "a/b"] */
function folderAncestors(rel: string): string[] {
	const parts = rel.split("/");
	return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}
