// SpaceSync: a space's keys, its index doc, the doc-heads feed and lazily loaded file docs.
import { SpaceKind, SpaceRole, ErrorCode, type SpaceInfo, type DocHead } from "../proto/tezca/v1/sync_pb";
import type { HostConnection } from "./connection";
import { b64u, bytesEqual, unwrapKey, type Identity, open as aeadOpen, seal, ad, fromUtf8, utf8 } from "./crypto";
import { commitmentValid, makeCommitment, makeOwnerRecord, ownerRecordValid, type Commitment, type TrustState } from "./key-trust";
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
	hasKey(epoch: number): boolean;
	/** Is this epoch's key verified (key-trust.ts)? */
	keyTrusted(epoch: number): boolean;
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
	/** The wrapped form each key came in (to notice when the host offers a different one). */
	private wrapped = new Map<number, Uint8Array>();
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
		let keysChanged = false;
		for (const k of info.keys) {
			// A trusted key never changes. An untrusted one is replaced if the host now offers a
			// different one (a bogus key mustn't block the real one for the same epoch).
			if (this.keys.has(k.epoch) && (this.trust?.epochs.has(k.epoch) || bytesEqual(this.wrapped.get(k.epoch) ?? new Uint8Array(), k.wrapped))) continue;
			try {
				this.keys.set(k.epoch, unwrapKey(k.wrapped, this.identity));
				this.wrapped.set(k.epoch, k.wrapped);
				keysChanged = true;
			} catch (e) {
				log.error(`cannot unwrap key epoch ${k.epoch} for space ${this.spaceId}`, e);
			}
		}
		this.evaluateTrust();
		if (keysChanged) this.notifyKeysChanged();
	}

	private notifyKeysChanged(): void {
		this.index?.keysChanged();
		for (const s of this.slots?.values() ?? []) void s.loading.then((d) => d.keysChanged());
	}

	// ───────────── key trust (key-trust.ts) ─────────────

	private trust: { epochs: Set<number>; owners: Set<string>; ceiling: number } | null = null;

	/** The user's own vault (or a guest's profile): only the user's own identity commits keys. */
	private get personal(): boolean {
		return this._info.kind === SpaceKind.ROOT || this._info.kind === SpaceKind.PROFILE;
	}

	private get myPk(): string {
		return b64u(this.identity.signPk);
	}

	private ownersInInfo(): string[] {
		return this._info.members.filter((m) => m.role === SpaceRole.OWNER).map((m) => b64u(m.signPk));
	}

	private async loadTrust(): Promise<void> {
		const saved = await this.store.get<TrustState & { ceiling?: number }>(`keytrust/${this.spaceId}`);
		if (saved) {
			this.trust = { epochs: new Set(saved.epochs), owners: new Set(saved.owners), ceiling: saved.ceiling ?? Math.max(-1, ...saved.epochs) };
			return;
		}
		// First time this device opens the space: trust what it has now (as it always did), and
		// from here on only keys committed by the user (or a known owner).
		this.trust = { epochs: new Set(), owners: new Set([...this.ownersInInfo(), ...(this.personal ? [this.myPk] : [])]), ceiling: this._info.epoch };
		await this.saveTrust();
	}

	private async saveTrust(): Promise<void> {
		if (!this.trust) return;
		await this.store.put(`keytrust/${this.spaceId}`, { epochs: [...this.trust.epochs], owners: [...this.trust.owners], ceiling: this.trust.ceiling });
	}

	/** Re-check which keys to trust (after new keys, or new commitments in the index). */
	private evaluateTrust(): void {
		const t = this.trust;
		if (!t || !this.index) return;
		const commits = this.index.ydoc.getMap<string>("keys");
		const ownerRecs = this.index.ydoc.getMap<string>("owners");
		let changed = false;
		// Owners promoted by an owner we already trust.
		for (let grew = true; grew; ) {
			grew = false;
			ownerRecs.forEach((v, pk) => {
				if (t.owners.has(pk)) return;
				try {
					const r = JSON.parse(v) as { by: string; sig: string };
					if (t.owners.has(r.by) && ownerRecordValid(this.spaceId, pk, r)) {
						t.owners.add(pk);
						grew = changed = true;
					}
				} catch {
					/* ignore malformed */
				}
			});
		}
		for (const [epoch, key] of this.keys) {
			if (t.epochs.has(epoch)) continue;
			let c: Commitment | null = null;
			try {
				c = JSON.parse(commits.get(String(epoch)) ?? "null") as Commitment | null;
			} catch {
				c = null;
			}
			let ok = false;
			if (c) {
				const signer = this.personal ? c.by === this.myPk : t.owners.has(c.by);
				ok = signer && commitmentValid(c, this.spaceId, epoch, key);
				if (!ok) log.warn(`not trusting key epoch ${epoch} of space ${this.spaceId}: its commitment doesn't check out`);
			} else ok = epoch <= t.ceiling; // from before commitments (trust on first use)
			if (ok) {
				t.epochs.add(epoch);
				changed = true;
			}
		}
		if (!changed) return;
		void this.saveTrust();
		this.commitTrustedKeys();
		// A newly trusted key (first one, or after a rotation): send what was waiting for it.
		if (this.slots) {
			this.index?.retryPush();
			for (const s of this.slots.values()) void s.loading.then((d) => d.retryPush());
		}
	}

	/** Write commitments for trusted keys that don't have one yet (if we may commit keys here). */
	private commitTrustedKeys(): void {
		const t = this.trust;
		if (!t || !this.index || !this.canWrite()) return;
		if (!this.personal && !t.owners.has(this.myPk)) return;
		if (this.personal && this._info.role !== SpaceRole.OWNER) return;
		const commits = this.index.ydoc.getMap<string>("keys");
		const missing = [...t.epochs].filter((e) => !commits.has(String(e)) && this.keys.has(e));
		if (!missing.length) return;
		this.index.ydoc.transact(() => {
			for (const e of missing) commits.set(String(e), JSON.stringify(makeCommitment(this.identity, this.spaceId, e, this.keys.get(e)!)));
		}, "tezca-local");
	}

	/** This device made `key` for `epoch` (a rotation): trust and commit it. */
	async trustOwnKey(epoch: number, key: Uint8Array): Promise<void> {
		this.keys.set(epoch, key);
		if (this.trust) {
			this.trust.epochs.add(epoch);
			this.trust.ceiling = Math.max(this.trust.ceiling, epoch);
			await this.saveTrust();
		}
		this.commitTrustedKeys();
		this.evaluateTrust();
	}

	/** Record that `owner` (b64u sign pk) was made an owner by us, so other devices trust their keys. */
	recordOwner(owner: string): void {
		if (!this.index) return;
		this.index.ydoc.transact(() => this.index.ydoc.getMap<string>("owners").set(owner, JSON.stringify(makeOwnerRecord(this.identity, this.spaceId, owner))), "tezca-local");
		this.trust?.owners.add(owner);
		void this.saveTrust();
	}

	// ───────────── SpaceContext ─────────────

	hasKey(epoch: number): boolean {
		return this.keys.has(epoch);
	}
	keyTrusted(epoch: number): boolean {
		return !!this.trust?.epochs.has(epoch);
	}
	/** Can we encrypt with this epoch's key (we have it and trust it)? */
	canEncrypt(epoch: number): boolean {
		return this.keys.has(epoch) && !!this.trust?.epochs.has(epoch);
	}
	keyFor(epoch: number): Uint8Array {
		const k = this.keys.get(epoch);
		if (!k) throw new Error(`no key for epoch ${epoch} in space ${this.spaceId}`);
		return k;
	}
	/** The epoch to encrypt with: the newest key we trust (-1 if none yet). */
	currentEpoch(): number {
		let best = -1;
		for (const e of this.trust?.epochs ?? []) if (e <= this._info.epoch && e > best && this.keys.has(e)) best = e;
		return best;
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
		await this.loadTrust();
		this.index = await this.acquire(INDEX_DOC);
		const onCommit = () => this.evaluateTrust();
		this.index.ydoc.getMap("keys").observe(onCommit);
		this.index.ydoc.getMap("owners").observe(onCommit);
		this.offs.push(() => {
			this.index.ydoc.getMap("keys").unobserve(onCommit);
			this.index.ydoc.getMap("owners").unobserve(onCommit);
		});
		this.evaluateTrust();
		this.commitTrustedKeys();
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
