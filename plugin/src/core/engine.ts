// SyncEngine: one host connection, the user's root space, and every share mounted in the vault.
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { SpaceInfoSchema, SpaceKind, SpaceRole, type SpaceInfo } from "../proto/tezca/v1/sync_pb";
import { BlobClient } from "./blobs";
import { HostConnection, type ConnStatus, type WSCtor } from "./connection";
import { fromB64u, newSpaceKey, randomBytes, unwrapInvite, wrapForInvite, wrapKey, b64u, type Identity } from "./crypto";
import { DEFAULT_MAX_BLOB_BYTES, DiskMirror, LOCAL_ORIGIN, type MirrorNotice } from "./mirror";
import { Mounts, within, type Mount } from "./mounts";
import { HostApi, ShareApi, createSpace, fetchHttp, listSpaces, waitOnline, type HttpFn, type ShareRole } from "./setup";
import { SpaceSync } from "./space";
import type { LocalStore } from "./store";
import { Emitter, log } from "./util";
import type { VaultAdapter } from "./vault";

export interface EngineOptions {
	host: string;
	identity: Identity;
	deviceId: string;
	deviceName: string;
	/** The user's root (private vault) space. */
	spaceId: string;
	store: LocalStore;
	vault: VaultAdapter;
	clientVersion: string;
	WebSocketImpl?: WSCtor;
	isBound?: (vaultPath: string) => boolean;
	/** How long to wait for the server before reconciling from local state. */
	startupWaitMs?: number;
	/** HTTP transport for blobs and share management (Obsidian passes requestUrl; defaults to fetch). */
	http?: HttpFn;
	/** Retry delay for failed blob transfers. */
	blobRetryMs?: number;
	/** Display name and cursor colour other members of a share see. */
	profile?: () => { name: string; color: string };
}

export interface EngineStatus {
	conn: ConnStatus;
	ready: boolean;
	busy: boolean;
	unsent: number;
}

/** A space being synced into the vault. */
export interface MountedSpace {
	spaceId: string;
	/** Vault folder ("" for the root space). */
	mount: string;
	space: SpaceSync;
	mirror: DiskMirror;
}

export interface ShareMember {
	signPk: Uint8Array;
	role: SpaceRole;
	name?: string;
	color?: string;
	isMe: boolean;
}

const ROLE_NAMES: Record<number, ShareRole> = { [SpaceRole.OWNER]: "owner", [SpaceRole.EDITOR]: "editor", [SpaceRole.VIEWER]: "viewer" };

export class SyncEngine {
	readonly conn: HostConnection;
	readonly status = new Emitter<EngineStatus>();
	readonly notices = new Emitter<MirrorNotice>();
	/** Fires when shares are mounted, unmounted or change role/membership. */
	readonly sharesChanged = new Emitter<void>();
	root: MountedSpace | null = null;
	readonly shares = new Map<string, MountedSpace>();
	mounts: Mounts | null = null;
	readonly api: HostApi;
	readonly shareApi: ShareApi;
	private readonly http: HttpFn;
	private infos = new Map<string, SpaceInfo>();
	private stopped = false;
	private maxBlobBytes = DEFAULT_MAX_BLOB_BYTES;
	private offs: (() => void)[] = [];
	/** Serialises mount/unmount work. */
	private mountQueue: Promise<unknown> = Promise.resolve();
	private starting = new Set<string>();

	constructor(readonly opts: EngineOptions) {
		this.conn = new HostConnection({
			host: opts.host,
			identity: opts.identity,
			deviceId: opts.deviceId,
			clientVersion: opts.clientVersion,
			WebSocketImpl: opts.WebSocketImpl,
		});
		this.http = opts.http ?? fetchHttp;
		this.api = new HostApi(opts.host, this.http);
		this.shareApi = new ShareApi(this.api, opts.identity);
		this.conn.statusChanged.on(() => this.emitStatus());
	}

	/** The root space (compatibility accessors). */
	get space(): SpaceSync | null {
		return this.root?.space ?? null;
	}
	get mirror(): DiskMirror | null {
		return this.root?.mirror ?? null;
	}

	/** The mounted space (root or share) a vault path belongs to. */
	spaceFor(vaultPath: string): MountedSpace | null {
		for (const s of this.shares.values()) if (within(vaultPath, s.mount)) return s;
		return this.root;
	}

	// ───────────── lifecycle ─────────────

	async start(): Promise<void> {
		const { store, spaceId } = this.opts;
		this.conn.start();
		// Mount moves/deletes must be seen before any mirror reacts to the same event.
		this.offs.push(this.opts.vault.onEvent((e) => this.onVaultEvent(e)));
		let info = await this.cachedInfo(spaceId);
		if (!info) {
			await waitOnline(this.conn, 60_000);
			await this.refreshInfos();
			info = this.infos.get(spaceId) ?? null;
			if (!info) throw new Error(`Space ${spaceId} not found on host (or access was removed)`);
		}
		if (this.stopped) return;
		this.offs.push(
			this.conn.online.on(() => void this.onOnline()),
			this.conn.on("spaceChanged", () => void this.onSpaceChanged()),
		);

		const space = new SpaceSync(this.conn, store, this.opts.identity, info);
		await space.start();
		this.mounts = new Mounts(space.index.ydoc);
		const mirror = this.newMirror(space, "", () => this.mounts!.all().map((m) => m.path));
		this.root = { spaceId, mount: "", space, mirror };
		await mirror.start();
		void this.fetchLimits();

		// Prefer reconciling against an up-to-date index; fall back to local state when offline.
		await this.waitForServerState(space, this.opts.startupWaitMs ?? 8000);
		if (this.stopped) return;
		await mirror.initialReconcile();
		this.offs.push(this.mounts.onChange(() => this.syncMounts()));
		this.syncMounts();
		log.info(`space ${spaceId} ready`);
		this.emitStatus();
	}

	private newMirror(space: SpaceSync, mount: string, excluded?: () => string[]): DiskMirror {
		const mirror = new DiskMirror(space, this.opts.vault, {
			mount,
			deviceName: this.opts.deviceName,
			isBound: this.opts.isBound,
			blobs: new BlobClient(this.opts.host, this.opts.identity, this.http),
			maxBlobBytes: () => this.maxBlobBytes,
			retryMs: this.opts.blobRetryMs,
			excluded,
		});
		mirror.notices.on((n) => this.notices.emit(n));
		mirror.idleChanged.on(() => this.emitStatus());
		return mirror;
	}

	private async waitForServerState(space: SpaceSync, ms: number) {
		const deadline = Date.now() + ms;
		const until = (p: Promise<void>) =>
			Promise.race([p, new Promise<void>((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
		try {
			await until(waitOnline(this.conn, ms));
		} catch {
			return;
		}
		if (this.conn.status !== "online") return;
		await until(space.index.whenSynced());
		if (!space.isHeadsReady)
			await until(
				new Promise<void>((r) => {
					const off = space.headsLoaded.on(() => {
						off();
						r();
					});
				}),
			);
	}

	private async cachedInfo(spaceId: string): Promise<SpaceInfo | null> {
		const cached = await this.opts.store.get<Uint8Array>(`spaceinfo/${spaceId}`);
		return cached ? fromBinary(SpaceInfoSchema, cached) : null;
	}

	/** Re-read every space this user belongs to, apply keys/roles, and drop shares we lost. */
	async refreshInfos(): Promise<void> {
		const spaces = await listSpaces(this.conn);
		this.infos = new Map(spaces.map((s) => [s.spaceId, s]));
		for (const s of spaces) await this.opts.store.put(`spaceinfo/${s.spaceId}`, toBinary(SpaceInfoSchema, s));
		this.root?.space.applyInfo(this.infos.get(this.opts.spaceId) ?? this.root.space.info);
		for (const sh of this.shares.values()) {
			const i = this.infos.get(sh.spaceId);
			if (i) sh.space.applyInfo(i);
		}
		// Mounted shares we're no longer a member of: unmount (files stay as private files).
		for (const m of this.mounts?.all() ?? []) {
			if (this.infos.has(m.spaceId)) continue;
			this.notices.emit({ kind: "preserved", message: `You no longer have access to the shared folder "${m.path}". Its files stay in your vault as private files.`, paths: [m.path] });
			this.mounts!.remove(m.spaceId, LOCAL_ORIGIN);
		}
		this.sharesChanged.emit();
	}

	private async fetchLimits() {
		try {
			const info = await this.api.info();
			if (info.max_blob_bytes) this.maxBlobBytes = info.max_blob_bytes;
		} catch (e) {
			log.debug("could not read host limits", e);
		}
	}

	private async onOnline() {
		for (const s of this.allSpaces()) s.mirror.retryTransfers();
		try {
			await this.refreshInfos();
		} catch (e) {
			log.warn("could not refresh space info", e);
		}
		this.syncMounts();
	}

	private async onSpaceChanged() {
		try {
			await this.refreshInfos();
		} catch (e) {
			log.warn("could not refresh after a space change", e);
		}
	}

	// ───────────── mounts ─────────────

	private allSpaces(): MountedSpace[] {
		return [...(this.root ? [this.root] : []), ...this.shares.values()];
	}

	/** Bring running share mirrors in line with the mount table. */
	private syncMounts(): void {
		this.mountQueue = this.mountQueue.then(() => this.syncMountsNow()).catch((e) => log.error("mount sync failed", e));
	}

	private async syncMountsNow(): Promise<void> {
		if (this.stopped || !this.mounts) return;
		const want = new Map(this.mounts.all().map((m) => [m.spaceId, m]));
		for (const [id, sh] of [...this.shares]) {
			const m = want.get(id);
			if (m && m.path === sh.mount) continue;
			await this.unmountNow(id, m === undefined);
			// Moved on another device: move the folder here too before remounting, or the share
			// would see its files missing at the new path (and the old folder would turn private).
			if (m && (await this.opts.vault.exists(sh.mount)) && !(await this.opts.vault.exists(m.path))) {
				try {
					await this.opts.vault.rename(sh.mount, m.path);
				} catch (e) {
					log.warn(`could not move ${sh.mount} to ${m.path}`, e);
				}
			}
		}
		for (const m of want.values()) if (!this.shares.has(m.spaceId)) void this.mountShare(m);
	}

	private async unmountNow(spaceId: string, rescan: boolean): Promise<void> {
		const sh = this.shares.get(spaceId);
		if (!sh) return;
		this.shares.delete(spaceId);
		sh.mirror.suspend();
		await sh.mirror.stop();
		await sh.space.stop();
		// The folder's files become private files again (left the share, or unmounted).
		if (rescan && this.root && (await this.opts.vault.exists(sh.mount))) await this.root.mirror.rescan(sh.mount);
		this.sharesChanged.emit();
		this.emitStatus();
	}

	private async mountShare(m: Mount): Promise<void> {
		if (this.starting.has(m.spaceId) || this.stopped) return;
		this.starting.add(m.spaceId);
		try {
			let info = this.infos.get(m.spaceId) ?? (await this.cachedInfo(m.spaceId));
			// No info yet, or none of our wrapped keys for the current epoch (another of our devices
			// may have mounted it right after redeeming, before its key upload reached us).
			for (let attempt = 0; !info || !info.keys.some((k) => k.epoch === info!.epoch); attempt++) {
				if (attempt >= 20) throw new Error("this device hasn't received the shared folder's key yet");
				if (attempt) await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * attempt)));
				await waitOnline(this.conn, 24 * 3600_000);
				await this.refreshInfos();
				if (!this.mounts?.get(m.spaceId)) return; // unmounted meanwhile (e.g. access removed)
				info = this.infos.get(m.spaceId) ?? null;
			}
			const fresh = !(await this.opts.store.get(`mirror/${m.spaceId}`));
			if (!fresh && !(await this.opts.vault.exists(m.path))) {
				// The mount folder was deleted while we weren't running: that unmounts the share
				// here (as it would live), it must not delete the share's files for everyone.
				this.mounts?.remove(m.spaceId, LOCAL_ORIGIN);
				await this.opts.store.delete(`mirror/${m.spaceId}`);
				this.notices.emit({ kind: "preserved", message: `The shared folder "${m.path}" was removed from this vault. Other members still have it; open its invite again to re-add it.` });
				return;
			}
			const space = new SpaceSync(this.conn, this.opts.store, this.opts.identity, info);
			await space.start();
			const mirror = this.newMirror(space, m.path);
			await mirror.start();
			if (!(await this.opts.vault.exists(m.path))) await this.opts.vault.mkdir(m.path);
			if (fresh) {
				// First time on this device: never reconcile against an empty local index, or the
				// files already on disk would be imported as duplicates of the share's entries.
				await waitOnline(this.conn, 24 * 3600_000);
				await this.waitForServerState(space, 120_000);
			} else await this.waitForServerState(space, this.opts.startupWaitMs ?? 8000);
			if (this.stopped || this.mounts?.get(m.spaceId)?.path !== m.path) {
				await mirror.stop();
				await space.stop();
				return;
			}
			this.shares.set(m.spaceId, { spaceId: m.spaceId, mount: m.path, space, mirror });
			await mirror.initialReconcile();
			this.writeProfile(space);
			log.info(`share ${m.spaceId} mounted at ${m.path}`);
			this.sharesChanged.emit();
			this.emitStatus();
		} catch (e) {
			log.error(`could not mount share at ${m.path}`, e);
			this.notices.emit({ kind: "error", message: `Couldn't open the shared folder "${m.path}": ${(e as Error).message}` });
		} finally {
			this.starting.delete(m.spaceId);
		}
	}

	/** Follow a mount folder being moved or deleted (before the mirrors see the events). */
	private onVaultEvent(e: { type: string; path: string; oldPath?: string; kind: "file" | "folder" }) {
		if (!this.mounts) return;
		if (e.type === "rename" && e.oldPath && !(e.kind === "folder" && this.mounts.all().some((m) => within(m.path, e.oldPath!)))) {
			// A move across a shared folder's edge is a copy into the destination plus a delete from the source.
			const from = this.mounts.containing(e.oldPath);
			const to = this.mounts.containing(e.path);
			if (from?.spaceId !== to?.spaceId) {
				const what = e.kind === "folder" ? "folder" : "file";
				this.notices.emit({
					kind: "preserved",
					message: from
						? `Moved "${e.path}" out of the shared folder "${from.path}": it's now ${to ? `in "${to.path}"` : "private"}, and the other members no longer have this ${what}.`
						: `Moved "${e.path}" into the shared folder "${to!.path}": its members can see this ${what} now.`,
					paths: [e.path],
				});
			}
		}
		if (e.kind !== "folder") return;
		if (e.type === "rename" && e.oldPath) {
			for (const m of this.mounts.all()) {
				if (!within(m.path, e.oldPath)) continue;
				this.shares.get(m.spaceId)?.mirror.suspend();
				this.mounts.set(m.spaceId, e.path + m.path.slice(e.oldPath.length), LOCAL_ORIGIN);
			}
		} else if (e.type === "delete") {
			for (const m of this.mounts.all()) {
				if (!within(m.path, e.path)) continue;
				this.shares.get(m.spaceId)?.mirror.suspend();
				this.mounts.remove(m.spaceId, LOCAL_ORIGIN);
				this.notices.emit({ kind: "preserved", message: `The shared folder "${m.path}" was removed from this vault. Other members still have it; open its invite again to re-add it.` });
			}
		}
	}

	/** Write this user's display name and colour into a share's member profiles. */
	private writeProfile(space: SpaceSync) {
		const p = this.opts.profile?.();
		if (!p || !space.canWrite()) return;
		const members = space.index.ydoc.getMap<string>("members");
		const key = b64u(this.opts.identity.signPk);
		const v = JSON.stringify(p);
		if (members.get(key) !== v) space.index.ydoc.transact(() => members.set(key, v), LOCAL_ORIGIN);
	}

	/** Re-publish the profile (after the user changes name or colour). */
	updateProfile(): void {
		for (const sh of this.shares.values()) this.writeProfile(sh.space);
	}

	// ───────────── sharing ─────────────

	/** Turn a private folder into a share owned by this user. */
	async shareFolder(folder: string, name: string): Promise<string> {
		const root = this.root;
		if (!root || !this.mounts) throw new Error("Sync isn't running");
		if (this.mounts.containing(folder)) throw new Error("This folder is already inside a shared folder");
		if (this.mounts.all().some((m) => within(m.path, folder))) throw new Error("This folder contains a shared folder");
		if (!(await this.opts.vault.exists(folder))) throw new Error("Folder not found");
		await waitOnline(this.conn, 15_000);
		const info = await createSpace(this.conn, this.opts.identity, name, SpaceKind.SHARE);
		this.infos.set(info.spaceId, info);
		await this.opts.store.put(`spaceinfo/${info.spaceId}`, toBinary(SpaceInfoSchema, info));
		await root.mirror.handOver(folder, () => this.mounts!.set(info.spaceId, folder, LOCAL_ORIGIN));
		return info.spaceId;
	}

	/** Create a single-use invite link for a share. */
	async createInvite(spaceId: string, role: "editor" | "viewer", ttlSeconds?: number): Promise<string> {
		const sh = this.shares.get(spaceId);
		if (!sh) throw new Error("Not mounted");
		const secret = randomBytes(32);
		const keys = [];
		for (let e = 0; e <= sh.space.currentEpoch(); e++) keys.push({ epoch: e, wrapped: wrapForInvite(secret, spaceId, e, sh.space.keyFor(e)) });
		const res = await this.shareApi.createInvite(spaceId, role, keys, ttlSeconds);
		return this.shareApi.link(res.token, secret);
	}

	/** Redeem a share invite: join, keep the keys for this user's devices, and mount it. */
	async joinShare(token: string, secretB64u: string, mountPath: (shareName: string) => Promise<string | null>): Promise<string | null> {
		const secret = fromB64u(secretB64u);
		const res = await this.shareApi.redeem(token);
		const keys = res.keys.map((k) => ({ epoch: k.epoch, key: unwrapInvite(secret, res.space_id, k.epoch, fromB64u(k.wrapped)) }));
		await this.shareApi.putKeys(res.space_id, keys.map((k) => ({ epoch: k.epoch, wrapped: wrapKey(k.key, this.opts.identity.boxPk) })));
		await this.refreshInfos();
		if (this.mounts?.get(res.space_id)) return this.mounts.get(res.space_id)!.path; // already mounted
		const info = this.infos.get(res.space_id);
		const name = info ? new SpaceSync(this.conn, this.opts.store, this.opts.identity, info).meta?.name : undefined;
		const path = await mountPath(name ?? "Shared");
		if (!path) return null;
		this.mounts!.set(res.space_id, path, LOCAL_ORIGIN);
		return path;
	}

	/** Members of a mounted share, with names from their profiles. */
	members(spaceId: string): ShareMember[] {
		const sh = this.shares.get(spaceId);
		const info = this.infos.get(spaceId) ?? sh?.space.info;
		if (!info) return [];
		const profiles = sh?.space.index.ydoc.getMap<string>("members");
		const me = b64u(this.opts.identity.signPk);
		return info.members.map((m) => {
			const k = b64u(m.signPk);
			let prof: { name?: string; color?: string } = {};
			try {
				prof = JSON.parse(profiles?.get(k) ?? "{}");
			} catch {
				/* ignore */
			}
			return { signPk: m.signPk, role: m.role, name: prof.name, color: prof.color, isMe: k === me };
		});
	}

	roleIn(spaceId: string): ShareRole | null {
		const info = this.infos.get(spaceId) ?? this.shares.get(spaceId)?.space.info;
		return info ? ROLE_NAMES[info.role] ?? null : null;
	}

	async setRole(spaceId: string, signPk: Uint8Array, role: ShareRole): Promise<void> {
		await this.shareApi.setRole(spaceId, signPk, role);
		await this.refreshInfos();
	}

	/** Remove a member, then rotate the space key so they can't read anything new. */
	async removeMember(spaceId: string, signPk: Uint8Array): Promise<void> {
		await this.shareApi.removeMember(spaceId, signPk);
		await this.rotateKey(spaceId);
	}

	/** New epoch key, wrapped for every current member. */
	async rotateKey(spaceId: string): Promise<void> {
		await this.refreshInfos();
		const info = this.infos.get(spaceId);
		if (!info) throw new Error("Not a member of this share");
		const key = newSpaceKey();
		const epoch = info.epoch + 1;
		await this.shareApi.rotate(
			spaceId,
			epoch,
			info.members.map((m) => ({ signPk: m.signPk, wrapped: wrapKey(key, m.boxPk) })),
		);
		await this.refreshInfos();
	}

	/** Leave a share: this user's devices unmount it and keep the files as private files. */
	async leaveShare(spaceId: string): Promise<void> {
		await this.shareApi.removeMember(spaceId, this.opts.identity.signPk);
		await this.refreshInfos();
	}

	// ───────────── status ─────────────

	private emitStatus() {
		this.status.emit(this.currentStatus());
	}

	currentStatus(): EngineStatus {
		const all = this.allSpaces();
		return {
			conn: this.conn.status,
			ready: this.root?.mirror.isReady ?? false,
			busy: all.some((s) => s.mirror.pendingWork > 0),
			unsent: 0,
		};
	}

	/** Wait until local work is flushed (used by tests/simulator). */
	async idle(): Promise<void> {
		await this.mountQueue.catch(() => undefined);
		for (const s of this.allSpaces()) await s.mirror.idle();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		for (const off of this.offs) off();
		for (const s of this.allSpaces()) {
			s.mirror.suspend();
			await s.mirror.stop();
			await s.space.stop();
		}
		this.shares.clear();
		this.conn.stop();
	}
}
