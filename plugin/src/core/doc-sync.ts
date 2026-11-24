// DocSync: one encrypted Yjs document synchronised with a host via seq-ordered updates.
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import type { AwarenessOut, Snapshot, SyncDone, Updates, Ack, SnapshotAck } from "../proto/tezca/v1/sync_pb";
import { ad, open, seal, sigMsg, sign, verify, b64u } from "./crypto";
import type { SpaceContext } from "./space";
import type { DocRecord } from "./store";
import { Emitter, log } from "./util";

/** Transaction origin for changes that came from the server (must not be re-sent). */
export const REMOTE_ORIGIN = "tezca-remote";
const AWARENESS_REMOTE = "tezca-remote-awareness";

/** Client-side compaction thresholds (see protocol.md). Mutable for tests. */
export const compaction = { updates: 500, bytes: 1024 * 1024 };

/**
 * Version snapshots (protocol.md "History"): after local edits, once the doc has been quiet for
 * `quietMs` and the latest snapshot is older than `intervalMs`, take a snapshot. Mutable for tests.
 */
export const versioning = { intervalMs: 60 * 60 * 1000, quietMs: 30_000 };

/** Docs that never get version snapshots. */
const UNVERSIONED = new Set(["index"]);

type Phase = "offline" | "syncing" | "live";

interface PendingEntry {
	update: Uint8Array;
	ref: number | null; // null = not yet sent on the current connection
}

export class DocSync {
	readonly ydoc: Y.Doc;
	lastSeq = 0n;
	phase: Phase = "offline";
	/** Fires each time an initial/re-sync completes. */
	readonly synced = new Emitter<void>();
	/** Fires when remote changes were applied (after decrypt). */
	readonly remoteApplied = new Emitter<void>();
	/** Fires when lastSeq changes. */
	readonly seqChanged = new Emitter<bigint>();
	private pending: PendingEntry[] = [];
	private sinceSnapshot = { count: 0, bytes: 0 };
	private snapshotInFlight: number | null = null;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private flushScheduled = false;
	private closed = false;
	private hasSyncedOnce = false;
	private awareness: Awareness | null = null;
	private subscribed = false;
	/** created_at of the latest snapshot the host told us about (unix ms; 0 = none). */
	private lastSnapshotAt = 0;
	/** Local edits have been acked since the latest snapshot. */
	private editedSinceSnapshot = false;
	private versionTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(
		readonly ctx: SpaceContext,
		readonly docId: string,
	) {
		this.ydoc = new Y.Doc();
		this.ydoc.on("update", this.onLocalUpdate);
	}

	get key(): string {
		return `${this.ctx.spaceId}/${this.docId}`;
	}

	get hasPending(): boolean {
		return this.pending.length > 0;
	}

	get isSynced(): boolean {
		return this.hasSyncedOnce;
	}

	/** Resolves once the doc has completed a sync with the server at least once since load. */
	whenSynced(): Promise<void> {
		if (this.hasSyncedOnce) return Promise.resolve();
		return new Promise((r) => {
			const off = this.synced.on(() => {
				off();
				r();
			});
		});
	}

	async load(): Promise<void> {
		const rec = await this.ctx.store.getDoc(this.key);
		if (!rec) return;
		this.ydoc.transact(() => {
			if (rec.state.length) Y.applyUpdate(this.ydoc, rec.state, REMOTE_ORIGIN);
			for (const u of rec.pending) Y.applyUpdate(this.ydoc, u, REMOTE_ORIGIN);
		}, REMOTE_ORIGIN);
		this.lastSeq = BigInt(rec.lastSeq);
		this.pending = rec.pending.map((u) => ({ update: u, ref: null }));
		if (this.pending.length) this.ctx.notePending(this.docId, true);
	}

	// ───────────── connection lifecycle ─────────────

	/** Called by the space when the connection is (re)authenticated. */
	connect(): void {
		if (this.closed) return;
		for (const p of this.pending) p.ref = null;
		this.snapshotInFlight = null;
		this.subscribed = true;
		this.phase = "syncing";
		this.ctx.conn.send({
			case: "subscribe",
			value: { spaceId: this.ctx.spaceId, docId: this.docId, sinceSeq: this.lastSeq },
		});
		// Pushes may be sent before SyncDone: the server orders them after the backlog.
		this.flushPending();
		this.broadcastLocalAwareness();
	}

	disconnected(): void {
		this.phase = "offline";
		this.subscribed = false;
		for (const p of this.pending) p.ref = null;
		this.snapshotInFlight = null;
		if (this.awareness) {
			const remote = [...this.awareness.getStates().keys()].filter((c) => c !== this.ydoc.clientID);
			removeAwarenessStates(this.awareness, remote, AWARENESS_REMOTE);
		}
	}

	private resync(reason: string) {
		log.warn(`resync ${this.key}: ${reason}`);
		this.ctx.conn.send({ case: "unsubscribe", value: { spaceId: this.ctx.spaceId, docId: this.docId } });
		this.connect();
	}

	// ───────────── inbound ─────────────

	handleSnapshot(s: Snapshot): void {
		if (s.baseSeq <= this.lastSeq) return; // we already have everything it covers
		if (!this.ctx.isWriter(s.author)) {
			log.warn(`snapshot from non-writer on ${this.key}, ignoring`);
			return;
		}
		if (!verify(s.author, sigMsg.snapshot(s.spaceId, s.docId, s.baseSeq, s.epoch, s.payload), s.sig)) {
			log.warn(`bad snapshot signature on ${this.key}`);
			return;
		}
		try {
			const plain = open(this.ctx.keyFor(s.epoch), s.payload, ad.snapshot(s.spaceId, s.docId, s.epoch));
			Y.applyUpdate(this.ydoc, plain, REMOTE_ORIGIN);
		} catch (e) {
			log.warn(`snapshot decrypt failed on ${this.key}`, e);
			return;
		}
		this.setSeq(s.baseSeq);
		this.sinceSnapshot = { count: 0, bytes: 0 };
		this.remoteApplied.emit();
		this.scheduleSave();
	}

	handleUpdates(msg: Updates): void {
		let applied = false;
		this.ydoc.transact(() => {
			for (const u of msg.updates) {
				if (u.seq <= this.lastSeq) continue;
				if (u.seq !== this.lastSeq + 1n) {
					this.resync(`gap: have ${this.lastSeq}, got ${u.seq}`);
					return;
				}
				this.setSeq(u.seq);
				this.sinceSnapshot.count++;
				this.sinceSnapshot.bytes += u.payload.length;
				if (!this.ctx.isWriter(u.author)) {
					log.warn(`update ${u.seq} on ${this.key} from non-writer ${b64u(u.author)}, skipping`);
					continue;
				}
				if (!verify(u.author, sigMsg.update(msg.spaceId, msg.docId, u.epoch, u.payload), u.sig)) {
					log.warn(`bad signature on update ${u.seq} of ${this.key}, skipping`);
					continue;
				}
				try {
					const plain = open(this.ctx.keyFor(u.epoch), u.payload, ad.update(msg.spaceId, msg.docId, u.epoch));
					Y.applyUpdate(this.ydoc, plain, REMOTE_ORIGIN);
					applied = true;
				} catch (e) {
					log.warn(`decrypt failed on update ${u.seq} of ${this.key}`, e);
				}
			}
		}, REMOTE_ORIGIN);
		if (applied) this.remoteApplied.emit();
		this.scheduleSave();
		if (this.phase === "live") this.maybeSnapshot();
	}

	handleSyncDone(d: SyncDone): void {
		this.phase = "live";
		this.sinceSnapshot = { count: d.updatesSinceSnapshot, bytes: Number(d.bytesSinceSnapshot) };
		this.lastSnapshotAt = Number(d.snapshotCreatedAt);
		if (d.latestSeq > this.lastSeq && this.pending.length === 0) {
			// Server says there's more than we got — shouldn't happen, but recover.
			this.resync(`syncDone latest ${d.latestSeq} > have ${this.lastSeq}`);
			return;
		}
		this.hasSyncedOnce = true;
		this.synced.emit();
		this.maybeSnapshot();
	}

	handleAck(a: Ack): void {
		const idx = this.pending.findIndex((p) => p.ref === a.ref);
		if (idx === -1) return;
		this.pending = this.pending.filter((p) => p.ref !== a.ref);
		if (a.seq === this.lastSeq + 1n) this.setSeq(a.seq);
		if (!this.pending.length) {
			void this.save().then(() => this.ctx.notePending(this.docId, false));
		}
		else if (a.seq > this.lastSeq + 1n) this.resync(`ack gap: have ${this.lastSeq}, ack ${a.seq}`);
		this.sinceSnapshot.count++;
		this.editedSinceSnapshot = true;
		this.scheduleVersion();
		this.scheduleSave();
		this.maybeSnapshot();
	}

	handleSnapshotAck(a: SnapshotAck): void {
		if (this.snapshotInFlight === a.ref) {
			this.snapshotInFlight = null;
			this.sinceSnapshot = { count: 0, bytes: 0 };
			this.editedSinceSnapshot = false;
			this.lastSnapshotAt = Number(a.createdAt) || Date.now();
		}
	}

	handlePushError(ref: number, retryable: boolean): void {
		if (ref === this.snapshotInFlight) {
			this.snapshotInFlight = null;
			return;
		}
		for (const p of this.pending) if (p.ref === ref) p.ref = retryable ? null : p.ref;
		if (retryable) setTimeout(() => this.flushPending(), 1000);
	}

	handleAwareness(a: AwarenessOut): void {
		if (!this.awareness) return;
		try {
			const plain = open(this.ctx.keyFor(a.epoch), a.payload, ad.awareness(a.spaceId, a.docId, a.epoch));
			const known = new Set(this.awareness.getStates().keys());
			applyAwarenessUpdate(this.awareness, plain, AWARENESS_REMOTE);
			// Someone just opened this note: tell them where we are now, rather than leaving them
			// without our cursor until our next periodic renewal (~15s).
			if ([...this.awareness.getStates().keys()].some((c) => !known.has(c))) this.broadcastLocalAwareness();
		} catch (e) {
			log.debug("awareness decrypt failed", e);
		}
	}

	ownsRef(ref: number): boolean {
		return ref === this.snapshotInFlight || this.pending.some((p) => p.ref === ref);
	}

	// ───────────── outbound ─────────────

	private onLocalUpdate = (update: Uint8Array, origin: unknown) => {
		if (origin === REMOTE_ORIGIN || this.closed) return;
		this.pending.push({ update, ref: null });
		if (this.pending.length === 1) this.ctx.notePending(this.docId, true);
		this.scheduleSave();
		if (!this.flushScheduled) {
			this.flushScheduled = true;
			queueMicrotask(() => {
				this.flushScheduled = false;
				this.flushPending();
			});
		}
	};

	/** Try sending unsent local updates again (e.g. after a key arrived). */
	retryPush(): void {
		this.flushPending();
	}

	private flushPending() {
		if (!this.subscribed || this.ctx.conn.status !== "online" || !this.ctx.canWrite()) return;
		const unsent = this.pending.filter((p) => p.ref === null);
		if (!unsent.length) return;
		const epoch = this.ctx.currentEpoch();
		if (!this.ctx.hasKey(epoch)) return; // key not received yet; retried after the next space refresh
		const merged = unsent.length === 1 ? unsent[0].update : Y.mergeUpdates(unsent.map((p) => p.update));
		const payload = seal(this.ctx.keyFor(epoch), merged, ad.update(this.ctx.spaceId, this.docId, epoch));
		const sig = sign(this.ctx.identity, sigMsg.update(this.ctx.spaceId, this.docId, epoch, payload));
		const ref = this.ctx.allocRef(this);
		const ok = this.ctx.conn.send({
			case: "pushUpdate",
			value: { ref, spaceId: this.ctx.spaceId, docId: this.docId, epoch, payload, sig },
		});
		if (!ok) return;
		// Collapse sent entries into one pending record so acks map 1:1.
		this.pending = [...this.pending.filter((p) => p.ref !== null), { update: merged, ref }];
	}

	private scheduleVersion() {
		if (UNVERSIONED.has(this.docId) || this.closed) return;
		if (this.versionTimer) clearTimeout(this.versionTimer);
		this.versionTimer = setTimeout(() => {
			this.versionTimer = null;
			this.maybeVersion();
		}, versioning.quietMs);
	}

	/** Take a version snapshot if local edits are due one (see `versioning`). */
	private maybeVersion() {
		if (UNVERSIONED.has(this.docId) || !this.editedSinceSnapshot) return;
		if (Date.now() - this.lastSnapshotAt < versioning.intervalMs) return;
		this.putSnapshot();
	}

	private maybeSnapshot() {
		if (this.sinceSnapshot.count < compaction.updates && this.sinceSnapshot.bytes < compaction.bytes) return;
		this.putSnapshot();
	}

	private putSnapshot() {
		if (this.snapshotInFlight !== null || this.pending.length || this.phase !== "live") return;
		if (!this.ctx.canWrite() || this.lastSeq === 0n || !this.subscribed || !this.ctx.hasKey(this.ctx.currentEpoch())) return;
		const epoch = this.ctx.currentEpoch();
		const state = Y.encodeStateAsUpdate(this.ydoc);
		const payload = seal(this.ctx.keyFor(epoch), state, ad.snapshot(this.ctx.spaceId, this.docId, epoch));
		const baseSeq = this.lastSeq;
		const sig = sign(this.ctx.identity, sigMsg.snapshot(this.ctx.spaceId, this.docId, baseSeq, epoch, payload));
		const ref = this.ctx.allocRef(this);
		if (
			this.ctx.conn.send({
				case: "putSnapshot",
				value: { ref, spaceId: this.ctx.spaceId, docId: this.docId, baseSeq, epoch, payload, sig },
			})
		) {
			this.snapshotInFlight = ref;
			log.debug(`snapshot ${this.key} @${baseSeq}`);
		}
	}

	// ───────────── awareness ─────────────

	getAwareness(): Awareness {
		if (!this.awareness) {
			const aw = new Awareness(this.ydoc);
			aw.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
				if (origin === AWARENESS_REMOTE) return;
				const changed = [...added, ...updated, ...removed].filter((c) => c === this.ydoc.clientID);
				if (changed.length) this.sendAwareness(changed);
			});
			this.awareness = aw;
		}
		return this.awareness;
	}

	private broadcastLocalAwareness() {
		if (this.awareness && this.awareness.getLocalState() !== null) this.sendAwareness([this.ydoc.clientID]);
	}

	private sendAwareness(clients: number[]) {
		if (!this.awareness || !this.subscribed) return;
		const epoch = this.ctx.currentEpoch();
		const plain = encodeAwarenessUpdate(this.awareness, clients);
		const payload = seal(this.ctx.keyFor(epoch), plain, ad.awareness(this.ctx.spaceId, this.docId, epoch));
		this.ctx.conn.send({ case: "awareness", value: { spaceId: this.ctx.spaceId, docId: this.docId, epoch, payload } });
	}

	releaseAwareness(): void {
		if (!this.awareness) return;
		removeAwarenessStates(this.awareness, [this.ydoc.clientID], "local");
		this.awareness.destroy();
		this.awareness = null;
	}

	// ───────────── persistence ─────────────

	private setSeq(seq: bigint) {
		this.lastSeq = seq;
		this.seqChanged.emit(seq);
	}

	private scheduleSave() {
		if (this.closed || this.saveTimer) return;
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.save();
		}, 300);
	}

	async save(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
		}
		const rec: DocRecord = {
			state: Y.encodeStateAsUpdate(this.ydoc),
			lastSeq: this.lastSeq.toString(),
			pending: this.pending.length ? [Y.mergeUpdates(this.pending.map((p) => p.update))] : [],
		};
		await this.ctx.store.putDoc(this.key, rec);
		this.ctx.noteSaved(this.docId, this.lastSeq);
	}

	/** Unsubscribe, persist, and free. */
	async close(): Promise<void> {
		if (this.closed) return;
		if (this.versionTimer) {
			clearTimeout(this.versionTimer);
			this.versionTimer = null;
		}
		this.maybeVersion(); // don't lose a due version because the doc is being unloaded
		this.releaseAwareness();
		if (this.subscribed) this.ctx.conn.send({ case: "unsubscribe", value: { spaceId: this.ctx.spaceId, docId: this.docId } });
		this.subscribed = false;
		await this.save();
		this.closed = true;
		this.ydoc.off("update", this.onLocalUpdate);
		this.ydoc.destroy();
	}
}
