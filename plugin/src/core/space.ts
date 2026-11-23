// SpaceSync: a space's keys, its index doc, the doc-heads feed and lazily loaded file docs.
import { SpaceRole, ErrorCode, type SpaceInfo, type DocHead } from "../proto/tezca/v1/sync_pb";
import type { HostConnection } from "./connection";
import { bytesEqual, unwrapKey, type Identity, open as aeadOpen, seal, ad, fromUtf8, utf8 } from "./crypto";
import { DocSync } from "./doc-sync";
import type { LocalStore } from "./store";
import { Emitter, log } from "./util";

export const INDEX_DOC = "index";

export interface SpaceContext {
	spaceId: string;
	identity: Identity;
	conn: HostConnection;
	store: LocalStore;
	keyFor(epoch: number): Uint8Array;
	currentEpoch(): number;
	canWrite(): boolean;
	isWriter(pk: Uint8Array): boolean;
	allocRef(doc: DocSync): number;
	noteSaved(docId: string, seq: bigint): void;
	/** A doc gained (true) or flushed all (false) unacknowledged local updates. */
	notePending(docId: string, pending: boolean): void;
}

export interface SpaceMeta {
	name: string;
	created: number;
}

export function encryptMeta(spaceId: string, key: Uint8Array, epoch: number, meta: SpaceMeta): Uint8Array {
	return seal(key, utf8(JSON.stringify(meta)), ad.meta(spaceId, epoch));
}

interface DocSlot {
	doc: DocSync;
	refs: number;
	idleTimer: ReturnType<typeof setTimeout> | null;
	loading: Promise<DocSync>;
}

const IDLE_UNLOAD_MS = 30_000;

export class SpaceSync implements SpaceContext {
	readonly spaceId: string;
	private keys = new Map<number, Uint8Array>();
	private _info: SpaceInfo;
	private slots = new Map<string, DocSlot>();
	private refOwners = new Map<number, DocSync>();
	/** Local last-integrated seq for every doc we have stored (loaded or not). */
	private localSeqs = new Map<string, bigint>();
	/** Latest seq per doc as reported by the server. */
	readonly heads = new Map<string, bigint>();
	/** A doc's server head moved past what we have locally. */
	readonly remoteChanged = new Emitter<string>();
	/** Remote changes were applied to a loaded doc. */
	readonly docApplied = new Emitter<string>();
	/** First full DocHeads list received after (re)connect. */
	readonly headsLoaded = new Emitter<void>();
	private headsReady = false;
	private offs: (() => void)[] = [];
	private seqsDirty = false;
	/** Docs with unacknowledged local updates (persisted, so they are flushed after a restart). */
	private pendingDocs = new Set<string>();
	/** Docs we hold open only to flush their pending updates. */
	private flushHolds = new Set<string>();
	private seqsTimer: ReturnType<typeof setTimeout> | null = null;
	index!: DocSync;

	constructor(
		readonly conn: HostConnection,
		readonly store: LocalStore,
		readonly identity: Identity,
		info: SpaceInfo,
	) {
		this.spaceId = info.spaceId;
		this._info = info;
		this.applyInfo(info);
	}

	/** The latest SpaceInfo (role, epoch, members, wrapped keys). */
	get info(): SpaceInfo {
		return this._info;
	}

	get meta(): SpaceMeta | null {
		if (!this._info.meta.length) return null;
		try {
			return JSON.parse(
				fromUtf8(aeadOpen(this.keyFor(this._info.metaEpoch), this._info.meta, ad.meta(this.spaceId, this._info.metaEpoch))),
			) as SpaceMeta;
		} catch {
			return null;
		}
	}

	get role(): SpaceRole {
		return this._info.role;
	}

	applyInfo(info: SpaceInfo): void {
		this._info = info;
		for (const k of info.keys) {
			if (this.keys.has(k.epoch)) continue;
			try {
				this.keys.set(k.epoch, unwrapKey(k.wrapped, this.identity));
			} catch (e) {
				log.error(`cannot unwrap key epoch ${k.epoch} for space ${this.spaceId}`, e);
			}
		}
	}

	// ───────────── SpaceContext ─────────────

	keyFor(epoch: number): Uint8Array {
		const k = this.keys.get(epoch);
		if (!k) throw new Error(`no key for epoch ${epoch} in space ${this.spaceId}`);
		return k;
	}
	currentEpoch(): number {
		return this._info.epoch;
	}
	canWrite(): boolean {
		return this._info.role === SpaceRole.OWNER || this._info.role === SpaceRole.EDITOR;
	}
	isWriter(pk: Uint8Array): boolean {
		if (!this._info.members.length) return bytesEqual(pk, this.identity.signPk);
		return this._info.members.some(
			(m) => bytesEqual(m.signPk, pk) && (m.role === SpaceRole.OWNER || m.role === SpaceRole.EDITOR),
		);
	}
	allocRef(doc: DocSync): number {
		// One counter per connection (shared with request ids), so errors, which carry only the
		// number, can't be claimed by another space or request on the same connection.
		const ref = this.conn.allocRid();
		this.refOwners.set(ref, doc);
		return ref;
	}
	noteSaved(docId: string, seq: bigint): void {
		if (this.localSeqs.get(docId) === seq) return;
		this.localSeqs.set(docId, seq);
		this.seqsDirty = true;
		if (!this.seqsTimer)
			this.seqsTimer = setTimeout(() => {
				this.seqsTimer = null;
				void this.saveSeqs();
			}, 1000);
	}

	notePending(docId: string, pending: boolean): void {
		const had = this.pendingDocs.has(docId);
		if (pending === had) return;
		if (pending) this.pendingDocs.add(docId);
		else {
			this.pendingDocs.delete(docId);
			if (this.flushHolds.delete(docId)) this.release(docId);
		}
		this.seqsDirty = true;
		this.scheduleSeqsSave();
	}

	private scheduleSeqsSave() {
		if (!this.seqsTimer)
			this.seqsTimer = setTimeout(() => {
				this.seqsTimer = null;
				void this.saveSeqs();
			}, 1000);
	}

	// ───────────── lifecycle ─────────────

	async start(): Promise<void> {
		const seqs = await this.store.get<Record<string, string>>(`seqs/${this.spaceId}`);
		if (seqs) for (const [d, s] of Object.entries(seqs)) this.localSeqs.set(d, BigInt(s));
		const pending = await this.store.get<string[]>(`pending/${this.spaceId}`);
		this.index = await this.acquire(INDEX_DOC);
		for (const d of pending ?? []) {
			if (d === INDEX_DOC) continue;
			this.pendingDocs.add(d);
			this.flushHolds.add(d);
			void this.acquire(d);
		}
		const c = this.conn;
		const mine = (v: { spaceId: string }) => v.spaceId === this.spaceId;
		this.offs.push(
			c.online.on(() => this.onOnline()),
			c.statusChanged.on((s) => {
				if (s !== "online") this.onOffline();
			}),
			c.on("docHeads", (v) => mine(v) && this.onHeads(v.full, v.heads)),
			c.on("snapshot", (v) => mine(v) && this.slots.get(v.docId)?.doc.handleSnapshot(v)),
			c.on("updates", (v) => mine(v) && this.slots.get(v.docId)?.doc.handleUpdates(v)),
			c.on("syncDone", (v) => mine(v) && this.slots.get(v.docId)?.doc.handleSyncDone(v)),
			c.on("ack", (v) => {
				const d = this.refOwners.get(v.ref);
				if (!mine(v) || !d) return;
				this.refOwners.delete(v.ref);
				d.handleAck(v);
			}),
			c.on("snapshotAck", (v) => {
				const d = this.refOwners.get(v.ref);
				if (!mine(v) || !d) return;
				this.refOwners.delete(v.ref);
				d.handleSnapshotAck(v);
			}),
			c.on("awareness", (v) => mine(v) && this.slots.get(v.docId)?.doc.handleAwareness(v)),
			c.on("error", (e) => {
				const d = e.rid ? this.refOwners.get(e.rid) : undefined;
				if (!d) return;
				this.refOwners.delete(e.rid);
				log.warn(`push rejected on ${d.key}: ${ErrorCode[e.code]} ${e.message}`);
				const retryable = e.code === ErrorCode.INTERNAL || e.code === ErrorCode.EPOCH_STALE;
				d.handlePushError(e.rid, retryable);
				if (e.code === ErrorCode.EPOCH_STALE) void this.refreshInfo();
			}),
		);
		if (c.status === "online") this.onOnline();
	}

	async stop(): Promise<void> {
		for (const off of this.offs) off();
		this.offs = [];
		await Promise.all([...this.slots.values()].map(async (s) => (await s.loading).close()));
		this.slots.clear();
		await this.saveSeqs();
	}

	private onOnline() {
		this.headsReady = false;
		this.conn.send({ case: "subscribeSpace", value: { spaceId: this.spaceId } });
		for (const s of this.slots.values()) void s.loading.then((d) => d.connect());
	}

	private onOffline() {
		this.headsReady = false;
		this.refOwners.clear();
		for (const s of this.slots.values()) void s.loading.then((d) => d.disconnected());
	}

	async refreshInfo(): Promise<void> {
		try {
			const list = await this.conn.request((rid) => ({ case: "listSpaces", value: { rid } }), "spaceList");
			const info = list.spaces.find((s) => s.spaceId === this.spaceId);
			if (info) this.applyInfo(info);
		} catch (e) {
			log.warn("refreshInfo failed", e);
		}
	}

	private onHeads(full: boolean, heads: DocHead[]) {
		for (const h of heads) {
			const latest = h.latestSeq > h.snapshotSeq ? h.latestSeq : h.snapshotSeq;
			this.heads.set(h.docId, latest);
			if (latest > this.localSeq(h.docId)) this.remoteChanged.emit(h.docId);
		}
		if (full && !this.headsReady) {
			this.headsReady = true;
			this.headsLoaded.emit();
		}
	}

	get isHeadsReady(): boolean {
		return this.headsReady;
	}

	localSeq(docId: string): bigint {
		const stored = this.localSeqs.get(docId) ?? 0n;
		const slot = this.slots.get(docId);
		if (slot && slot.doc.lastSeq > stored) return slot.doc.lastSeq;
		return stored;
	}

	/** Docs whose server head is ahead of our local copy. */
	staleDocs(): string[] {
		const out: string[] = [];
		for (const [d, s] of this.heads) if (s > this.localSeq(d)) out.push(d);
		return out;
	}

	// ───────────── doc management ─────────────

	isLoaded(docId: string): boolean {
		return this.slots.has(docId);
	}

	/** Load (from local store) and subscribe a doc. Callers must `release()` when done. */
	acquire(docId: string): Promise<DocSync> {
		let slot = this.slots.get(docId);
		if (slot) {
			slot.refs++;
			if (slot.idleTimer) {
				clearTimeout(slot.idleTimer);
				slot.idleTimer = null;
			}
			return slot.loading;
		}
		const doc = new DocSync(this, docId);
		doc.remoteApplied.on(() => this.docApplied.emit(docId));
		const loading = doc.load().then(() => {
			if (this.conn.status === "online") doc.connect();
			return doc;
		});
		slot = { doc, refs: 1, idleTimer: null, loading };
		this.slots.set(docId, slot);
		return loading;
	}

	release(docId: string): void {
		const slot = this.slots.get(docId);
		if (!slot || docId === INDEX_DOC) return;
		slot.refs = Math.max(0, slot.refs - 1);
		if (slot.refs > 0 || slot.idleTimer) return;
		slot.idleTimer = setTimeout(() => {
			slot.idleTimer = null;
			if (slot.refs > 0 || slot.doc.hasPending) {
				if (slot.refs === 0) this.release(docId); // retry later
				return;
			}
			this.slots.delete(docId);
			void slot.doc.close();
		}, IDLE_UNLOAD_MS);
	}

	/** Acquire a doc and wait for it to be in sync with the server (if online). */
	async acquireSynced(docId: string, timeoutMs = 20_000): Promise<DocSync> {
		const doc = await this.acquire(docId);
		if (this.conn.status !== "online") return doc;
		if (doc.phase === "live" && doc.isSynced) return doc;
		await Promise.race([
			new Promise<void>((r) => {
				const off = doc.synced.on(() => {
					off();
					r();
				});
			}),
			new Promise<void>((r) => setTimeout(r, timeoutMs)),
		]);
		return doc;
	}

	async deleteLocalDoc(docId: string): Promise<void> {
		const slot = this.slots.get(docId);
		if (slot) return; // in use
		await this.store.deleteDoc(`${this.spaceId}/${docId}`);
		this.localSeqs.delete(docId);
		this.seqsDirty = true;
	}

	/** Flush every loaded doc and the seq table. */
	async flush(): Promise<void> {
		await Promise.all([...this.slots.values()].map(async (s) => (await s.loading).save()));
		await this.saveSeqs();
	}

	private async saveSeqs() {
		if (!this.seqsDirty) return;
		this.seqsDirty = false;
		const obj: Record<string, string> = {};
		for (const [d, s] of this.localSeqs) obj[d] = s.toString();
		await this.store.put(`seqs/${this.spaceId}`, obj);
		await this.store.put(`pending/${this.spaceId}`, [...this.pendingDocs]);
	}
}
