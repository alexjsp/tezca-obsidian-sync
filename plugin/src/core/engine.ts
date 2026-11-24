// SyncEngine: the user's root (or profile) space, and every share mounted in the vault, across
// one connection per host.
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { SpaceInfoSchema, SpaceKind, SpaceRole, type SpaceInfo } from "../proto/tezca/v1/sync_pb";
import { BlobClient } from "./blobs";
import { HostConnection, type ConnStatus, type WSCtor } from "./connection";
import { fromB64u, newSpaceKey, randomBytes, unwrapInvite, wrapForInvite, wrapKey, b64u, type Identity } from "./crypto";
import { anyConfig, configFileIncluded, configFolderIncluded, type ConfigCategories } from "./config-sync";
import { DEFAULT_MAX_BLOB_BYTES, DiskMirror, LOCAL_ORIGIN, type MirrorNotice } from "./mirror";
import { safeAvatar, safeColor, safeName } from "./presence";
import { Mounts, mountPathProblem, safeFolderName, within, type Mount } from "./mounts";
import { HostApi, ShareApi, createSpace, fetchHttp, listSpaces, normalizeHost, waitOnline, type HttpFn, type ShareRole } from "./setup";
import { SpaceSync } from "./space";
import type { LocalStore } from "./store";
import { Emitter, log } from "./util";
import type { VaultAdapter } from "./vault";

export interface EngineOptions {
	/** The host of the user's root (or profile) space. */
	host: string;
	identity: Identity;
	deviceId: string;
	deviceName: string;
	/** The user's root space (private vault), or a hostless guest's profile space. */
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
	/** Config-folder sync (private space only): which categories, the folder, and our own plugin id. */
	config?: { dir: string; categories: ConfigCategories; ownPluginId: string };
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
	host: string;
	/** Vault folder ("" for the root space). */
	mount: string;
	space: SpaceSync;
	mirror: DiskMirror;
}

/** A community plugin recommended by a shared folder (its id in Obsidian's plugin directory). */
export interface RecommendedPlugin {
	id: string;
	name: string;
	author?: string;
}

export interface ShareMember {
	signPk: Uint8Array;
	role: SpaceRole;
	name?: string;
	color?: string;
	avatar?: string;
	isMe: boolean;
}

const ROLE_NAMES: Record<number, ShareRole> = { [SpaceRole.OWNER]: "owner", [SpaceRole.EDITOR]: "editor", [SpaceRole.VIEWER]: "viewer" };

/** Everything this device holds for one host. */
export class HostLink {
	readonly conn: HostConnection;
	readonly api: HostApi;
	readonly shareApi: ShareApi;
	readonly blobs: BlobClient;
	infos = new Map<string, SpaceInfo>();
	maxBlobBytes = DEFAULT_MAX_BLOB_BYTES;
	offs: (() => void)[] = [];

	constructor(
		readonly host: string,
		opts: EngineOptions,
		http: HttpFn,
	) {
		this.conn = new HostConnection({
			host,
			identity: opts.identity,
			deviceId: opts.deviceId,
			clientVersion: opts.clientVersion,
			WebSocketImpl: opts.WebSocketImpl,
		});
		this.api = new HostApi(host, http);
		this.shareApi = new ShareApi(this.api, opts.identity);
		this.blobs = new BlobClient(host, opts.identity, http);
	}
}

export class SyncEngine {
	readonly status = new Emitter<EngineStatus>();
	readonly notices = new Emitter<MirrorNotice>();
	/** Fires when shares are mounted, unmounted or change role/membership. */
	readonly sharesChanged = new Emitter<void>();
	/** Our profile (picture) changed, here or on another of our devices. */
	readonly profileChanged = new Emitter<void>();
	/** The root space; its mirror is null for a hostless guest's profile space (no private files). */
	root: (Omit<MountedSpace, "mirror"> & { mirror: DiskMirror | null }) | null = null;
	readonly shares = new Map<string, MountedSpace>();
	mounts: Mounts | null = null;
	readonly hosts = new Map<string, HostLink>();
	readonly primary: HostLink;
	private readonly http: HttpFn;
	private stopped = false;
	private offs: (() => void)[] = [];
	/** Serialises mount/unmount work. */
	private mountQueue: Promise<unknown> = Promise.resolve();
	private starting = new Set<string>();

	constructor(readonly opts: EngineOptions) {
		this.http = opts.http ?? fetchHttp;
		this.primary = this.link(opts.host);
	}

	/** The primary host's connection (compatibility). */
	get conn(): HostConnection {
		return this.primary.conn;
	}
	get api(): HostApi {
		return this.primary.api;
	}
	get shareApi(): ShareApi {
		return this.primary.shareApi;
	}
	/** The root space (compatibility accessors). */
	get space(): SpaceSync | null {
		return this.root?.space ?? null;
	}
	get mirror(): DiskMirror | null {
		return this.root?.mirror ?? null;
	}
	/** Is the root space a hostless guest's profile (no private files synced)? */
	get isProfile(): boolean {
		return this.root?.space.info.kind === SpaceKind.PROFILE;
	}

	/** The mounted space (root or share) a vault path belongs to. */
	spaceFor(vaultPath: string): MountedSpace | null {
		for (const s of this.shares.values()) if (within(vaultPath, s.mount)) return s;
		return this.root?.mirror ? (this.root as MountedSpace) : null;
	}

	/** The host link for a host URL, creating (and connecting) it if needed. */
	link(host: string): HostLink {
		const key = normalizeHost(host);
		let l = this.hosts.get(key);
		if (l) return l;
		l = new HostLink(key, this.opts, this.http);
		this.hosts.set(key, l);
		l.conn.statusChanged.on(() => this.emitStatus());
		if (this.root) this.startLink(l); // links made after start connect right away
		return l;
	}

	private startLink(l: HostLink) {
		if (l.offs.length) return;
		l.offs.push(
			l.conn.online.on(() => void this.onOnline(l)),
			l.conn.on("spaceChanged", () => void this.refreshInfos(l).catch((e) => log.warn("refresh after a space change failed", e))),
		);
		l.conn.start();
		void this.fetchLimits(l);
	}

	// ───────────── lifecycle ─────────────

	async start(): Promise<void> {
		const { store, spaceId } = this.opts;
		const p = this.primary;
		// Mount moves/deletes must be seen before any mirror reacts to the same event.
		this.offs.push(this.opts.vault.onEvent((e) => this.onVaultEvent(e)));
		p.conn.start();
		let info = await this.cachedInfo(spaceId);
		if (!info) {
			await waitOnline(p.conn, 60_000);
			await this.refreshInfos(p);
			info = p.infos.get(spaceId) ?? null;
			if (!info) throw new Error(`Space ${spaceId} not found on host (or access was removed)`);
		}
		if (this.stopped) return;

		const space = new SpaceSync(p.conn, store, this.opts.identity, info);
		await space.start();
		this.mounts = new Mounts(space.index.ydoc);
		const profile = info.kind === SpaceKind.PROFILE;
		const mirror = profile ? null : this.newMirror(p, space, "", () => this.mounts!.all().map((m) => m.path), this.configScope());
		this.root = { spaceId, host: p.host, mount: "", space, mirror };
		// Now that root exists, wire every link (the primary and any made so far).
		for (const l of this.hosts.values()) {
			if (l === p) {
				l.offs.push(
					l.conn.online.on(() => void this.onOnline(l)),
					l.conn.on("spaceChanged", () => void this.refreshInfos(l).catch((e) => log.warn("refresh after a space change failed", e))),
				);
				void this.fetchLimits(l);
			} else this.startLink(l);
		}
		await mirror?.start();

		// Prefer reconciling against an up-to-date index; fall back to local state when offline.
		await this.waitForServerState(p, space, this.opts.startupWaitMs ?? 8000);
		if (this.stopped) return;
		await mirror?.initialReconcile();
		this.offs.push(this.mounts.onChange(() => this.syncMounts()));
		// Our profile picture lives in our own space; when it changes (set on another device too),
		// republish it to the shared folders.
		const myProfile = space.index.ydoc.getMap<string>("members");
		const onProfile = (ev: { keysChanged: Set<string> }) => {
			if (!ev.keysChanged.has(this.myKey)) return;
			this.updateProfile();
			this.profileChanged.emit();
		};
		myProfile.observe(onProfile);
		this.offs.push(() => myProfile.unobserve(onProfile));
		this.syncMounts();
		log.info(`space ${spaceId} ready`);
		this.emitStatus();
	}

	private configScope() {
		const c = this.opts.config;
		if (!c || !anyConfig(c.categories)) return undefined;
		return {
			dir: c.dir,
			file: (rel: string) => configFileIncluded(rel, c.categories, c.ownPluginId),
			folder: (rel: string) => configFolderIncluded(rel, c.categories, c.ownPluginId),
		};
	}

	private newMirror(l: HostLink, space: SpaceSync, mount: string, excluded?: () => string[], config?: DiskMirror["opts"]["config"]): DiskMirror {
		const mirror = new DiskMirror(space, this.opts.vault, {
			config,
			mount,
			deviceName: this.opts.deviceName,
			isBound: this.opts.isBound,
			blobs: l.blobs,
			maxBlobBytes: () => l.maxBlobBytes,
			retryMs: this.opts.blobRetryMs,
			excluded,
		});
		mirror.notices.on((n) => this.notices.emit(n));
		mirror.idleChanged.on(() => this.emitStatus());
		return mirror;
	}

	private async waitForServerState(l: HostLink, space: SpaceSync, ms: number) {
		const deadline = Date.now() + ms;
		const until = (p: Promise<void>) =>
			Promise.race([p, new Promise<void>((r) => setTimeout(r, Math.max(0, deadline - Date.now())))]);
		try {
			await until(waitOnline(l.conn, ms));
		} catch {
			return;
		}
		if (l.conn.status !== "online") return;
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

	private hostOf(m: Mount): string {
		return m.host ? normalizeHost(m.host) : this.primary.host;
	}

	/** Re-read the spaces this user has on a host (all hosts by default), apply keys/roles, and drop shares we lost. */
	async refreshInfos(l?: HostLink): Promise<void> {
		if (!l) {
			await Promise.all([...this.hosts.values()].map((h) => this.refreshInfos(h).catch((e) => log.warn(`refresh ${h.host} failed`, e))));
			return;
		}
		const spaces = await listSpaces(l.conn);
		l.infos = new Map(spaces.map((s) => [s.spaceId, s]));
		for (const s of spaces) await this.opts.store.put(`spaceinfo/${s.spaceId}`, toBinary(SpaceInfoSchema, s));
		if (l === this.primary && this.root) this.root.space.applyInfo(l.infos.get(this.opts.spaceId) ?? this.root.space.info);
		for (const sh of this.shares.values()) {
			if (sh.host !== l.host) continue;
			const i = l.infos.get(sh.spaceId);
			if (i) sh.space.applyInfo(i);
			this.writeProfile(sh.space); // e.g. just made an editor: viewers can't publish their name
		}
		// Mounted shares on this host we're no longer a member of: unmount (files stay as private files).
		for (const m of this.mounts?.all() ?? []) {
			if (this.hostOf(m) !== l.host || l.infos.has(m.spaceId)) continue;
			this.notices.emit({ kind: "preserved", message: `You no longer have access to the shared folder "${m.path}". Its files stay in your vault${this.isProfile ? "" : " as private files"}.`, paths: [m.path] });
			this.mounts!.remove(m.spaceId, LOCAL_ORIGIN);
		}
		this.sharesChanged.emit();
	}

	private async fetchLimits(l: HostLink) {
		try {
			const info = await l.api.info();
			if (info.max_blob_bytes) l.maxBlobBytes = info.max_blob_bytes;
			l.conn.features = new Set(info.features ?? []);
		} catch (e) {
			log.debug(`could not read ${l.host} limits`, e);
		}
	}

	private async onOnline(l: HostLink) {
		for (const s of this.allSpaces()) if (s.host === l.host) s.mirror.retryTransfers();
		try {
			await this.refreshInfos(l);
		} catch (e) {
			log.warn("could not refresh space info", e);
		}
		this.syncMounts();
	}

	// ───────────── mounts ─────────────

	private allSpaces(): MountedSpace[] {
		return [...(this.root?.mirror ? [this.root as MountedSpace] : []), ...this.shares.values()];
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
		if (rescan) {
			// Left (or lost) for good: a later join starts afresh, rather than reading the old mount's
			// state as "its folder was deleted while closed" and unmounting again.
			await this.opts.store.delete(`mirror/${spaceId}`);
			// The folder's files become private files again.
			if (this.root?.mirror && (await this.opts.vault.exists(sh.mount))) await this.root.mirror.rescan(sh.mount);
		}
		this.sharesChanged.emit();
		this.emitStatus();
	}

	private async mountShare(m: Mount): Promise<void> {
		if (this.starting.has(m.spaceId) || this.stopped) return;
		this.starting.add(m.spaceId);
		const l = this.link(this.hostOf(m));
		try {
			let info = l.infos.get(m.spaceId) ?? (await this.cachedInfo(m.spaceId));
			// No info yet, or none of our wrapped keys for the current epoch (another of our devices
			// may have mounted it right after redeeming, before its key upload reached us).
			for (let attempt = 0; !info || !info.keys.some((k) => k.epoch === info!.epoch); attempt++) {
				if (attempt >= 20) throw new Error("this device hasn't received the shared folder's key yet");
				if (attempt) await new Promise((r) => setTimeout(r, Math.min(30_000, 500 * attempt)));
				await waitOnline(l.conn, 24 * 3600_000);
				await this.refreshInfos(l);
				if (!this.mounts?.get(m.spaceId)) return; // unmounted meanwhile (e.g. access removed)
				info = l.infos.get(m.spaceId) ?? null;
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
			const space = new SpaceSync(l.conn, this.opts.store, this.opts.identity, info);
			await space.start();
			const mirror = this.newMirror(l, space, m.path);
			await mirror.start();
			if (!(await this.opts.vault.exists(m.path))) await this.opts.vault.mkdir(m.path);
			if (fresh) {
				// First time on this device: never reconcile against an empty local index, or the
				// files already on disk would be imported as duplicates of the share's entries.
				await waitOnline(l.conn, 24 * 3600_000);
				await this.waitForServerState(l, space, 120_000);
			} else await this.waitForServerState(l, space, this.opts.startupWaitMs ?? 8000);
			if (this.stopped || this.mounts?.get(m.spaceId)?.path !== m.path) {
				await mirror.stop();
				await space.stop();
				return;
			}
			this.shares.set(m.spaceId, { spaceId: m.spaceId, host: l.host, mount: m.path, space, mirror });
			await mirror.initialReconcile();
			this.writeProfile(space);
			log.info(`share ${m.spaceId} mounted at ${m.path} from ${l.host}`);
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
						? `Moved "${e.path}" out of the shared folder "${from.path}": it's now ${to ? `in "${to.path}"` : this.isProfile ? "only on this device" : "private"}, and the other members no longer have this ${what}.`
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
				const to = e.path + m.path.slice(e.oldPath.length);
				try {
					this.mounts.set(m.spaceId, to, LOCAL_ORIGIN);
				} catch (err) {
					// Moved somewhere a shared folder can't live (e.g. into another shared folder):
					// it stops being mounted here; its files stay where they were moved.
					this.mounts.remove(m.spaceId, LOCAL_ORIGIN);
					this.notices.emit({ kind: "preserved", message: `${(err as Error).message} The shared folder was removed from this vault; open its invite again to re-add it.`, paths: [to] });
				}
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

	/** Apply what the safety brake paused, in every mounted space. */
	async forceReconcile(): Promise<void> {
		for (const s of this.allSpaces()) await s.mirror.forceReconcile();
	}

	/** Bring back synced files missing from this device, in every mounted space. */
	restoreMissing(): void {
		for (const s of this.allSpaces()) s.mirror.restoreMissing();
	}

	private get myKey(): string {
		return b64u(this.opts.identity.signPk);
	}

	/**
	 * Our profile picture (a small data URL), or undefined. It's kept in our own space's member
	 * profiles (so every device of ours has it) and copied into each shared folder's.
	 */
	myAvatar(): string | undefined {
		try {
			const p = JSON.parse(this.root?.space.index.ydoc.getMap<string>("members").get(this.myKey) ?? "{}") as { avatar?: string };
			return safeAvatar(p.avatar) ?? undefined;
		} catch {
			return undefined;
		}
	}

	/** Set (or with null, remove) our profile picture on all our devices and shared folders. */
	setAvatar(dataUrl: string | null): void {
		const space = this.root?.space;
		if (!space) throw new Error("Sync isn't running");
		const members = space.index.ydoc.getMap<string>("members");
		const v = JSON.stringify(dataUrl ? { avatar: dataUrl } : {});
		if (members.get(this.myKey) !== v) space.index.ydoc.transact(() => members.set(this.myKey, v), LOCAL_ORIGIN);
		// (The members observer republishes to shares.)
	}

	/** Write this user's display name, colour and picture into a share's member profiles. */
	private writeProfile(space: SpaceSync) {
		const p = this.opts.profile?.();
		if (!p || !space.canWrite()) return;
		const members = space.index.ydoc.getMap<string>("members");
		const avatar = this.myAvatar();
		const v = JSON.stringify(avatar ? { ...p, avatar } : p);
		if (members.get(this.myKey) !== v) space.index.ydoc.transact(() => members.set(this.myKey, v), LOCAL_ORIGIN);
	}

	/** Re-publish the profile (after the user changes name, colour or picture). */
	updateProfile(): void {
		for (const sh of this.shares.values()) this.writeProfile(sh.space);
	}

	// ───────────── sharing ─────────────

	private shareLink(spaceId: string): HostLink {
		const sh = this.shares.get(spaceId);
		const m = this.mounts?.get(spaceId);
		return sh ? this.link(sh.host) : m ? this.link(this.hostOf(m)) : this.primary;
	}

	private infoOf(spaceId: string): SpaceInfo | undefined {
		return this.shareLink(spaceId).infos.get(spaceId) ?? this.shares.get(spaceId)?.space.info;
	}

	/** Turn a private folder into a share owned by this user (on the user's own host). */
	async shareFolder(folder: string, name: string): Promise<string> {
		const root = this.root;
		if (!root?.mirror || !this.mounts) throw new Error(this.isProfile ? "Only folders in your own vault can be shared; you're using Tezca as a guest." : "Sync isn't running");
		if (this.mounts.containing(folder)) throw new Error("This folder is already inside a shared folder");
		if (this.mounts.all().some((m) => within(m.path, folder))) throw new Error("This folder contains a shared folder");
		if (!(await this.opts.vault.exists(folder))) throw new Error("Folder not found");
		const problem = mountPathProblem(folder, this.mounts.all());
		if (problem) throw new Error(problem);
		const l = this.primary;
		await waitOnline(l.conn, 15_000);
		const info = await createSpace(l.conn, this.opts.identity, name, SpaceKind.SHARE);
		l.infos.set(info.spaceId, info);
		await this.opts.store.put(`spaceinfo/${info.spaceId}`, toBinary(SpaceInfoSchema, info));
		await root.mirror.handOver(folder, () => this.mounts!.set(info.spaceId, folder, LOCAL_ORIGIN));
		return info.spaceId;
	}

	/** Create a single-use invite link for a share. */
	async createInvite(spaceId: string, role: "editor" | "viewer", ttlSeconds?: number): Promise<string> {
		const sh = this.shares.get(spaceId);
		if (!sh) throw new Error("Not mounted");
		const l = this.shareLink(spaceId);
		const secret = randomBytes(32);
		const keys = [];
		for (let e = 0; e <= sh.space.currentEpoch(); e++) keys.push({ epoch: e, wrapped: wrapForInvite(secret, spaceId, e, sh.space.keyFor(e)) });
		const res = await l.shareApi.createInvite(spaceId, role, keys, ttlSeconds);
		return l.shareApi.link(res.token, secret);
	}

	/**
	 * Redeem a share invite (on any host: on a host where we have no account we join as a guest),
	 * keep the keys for this user's devices, and mount it.
	 */
	async joinShare(token: string, secretB64u: string, mountPath: (shareName: string) => Promise<string | null>, host = this.primary.host): Promise<string | null> {
		const secret = fromB64u(secretB64u);
		// Redeem before connecting: on a host where we have no account yet, a connection opened
		// first would be refused (and refusals aren't retried). The body-signed form works whether
		// or not we're already a user there.
		const res = await new ShareApi(new HostApi(normalizeHost(host), this.http), this.opts.identity).redeemAsGuest(token);
		const l = this.link(host);
		if (l.conn.status === "unauthorized") l.conn.start(); // refused before we were a user; try again
		const keys = res.keys.map((k) => ({ epoch: k.epoch, key: unwrapInvite(secret, res.space_id, k.epoch, fromB64u(k.wrapped)) }));
		await l.shareApi.putKeys(res.space_id, keys.map((k) => ({ epoch: k.epoch, wrapped: wrapKey(k.key, this.opts.identity.boxPk) })));
		await waitOnline(l.conn, 20_000).catch(() => undefined);
		await this.refreshInfos(l);
		// The invite's keys are authenticated by its secret: trust exactly those (and the owners
		// listed now, to accept their future key rotations).
		if (!(await this.opts.store.get(`keytrust/${res.space_id}`))) {
			const owners = (l.infos.get(res.space_id)?.members ?? []).filter((m) => m.role === SpaceRole.OWNER).map((m) => b64u(m.signPk));
			await this.opts.store.put(`keytrust/${res.space_id}`, { epochs: keys.map((k) => k.epoch), owners, ceiling: Math.max(...keys.map((k) => k.epoch)) });
		}
		if (this.mounts?.get(res.space_id)) return this.mounts.get(res.space_id)!.path; // already mounted
		const info = l.infos.get(res.space_id);
		const name = info ? new SpaceSync(l.conn, this.opts.store, this.opts.identity, info).meta?.name : undefined;
		const path = await mountPath(safeFolderName(name ?? "Shared"));
		if (!path) return null;
		const problem = mountPathProblem(path, this.mounts!.all());
		if (problem) throw new Error(problem);
		this.mounts!.set(res.space_id, path, LOCAL_ORIGIN, l === this.primary ? undefined : l.host);
		return path;
	}

	/** Members of a mounted share, with names from their profiles. */
	members(spaceId: string): ShareMember[] {
		const sh = this.shares.get(spaceId);
		const info = this.infoOf(spaceId);
		if (!info) return [];
		const profiles = sh?.space.index.ydoc.getMap<string>("members");
		const me = b64u(this.opts.identity.signPk);
		return info.members.map((m) => {
			const k = b64u(m.signPk);
			let prof: { name?: string; color?: string; avatar?: string } = {};
			try {
				prof = JSON.parse(profiles?.get(k) ?? "{}");
			} catch {
				/* ignore */
			}
			// Profiles are written by members themselves (or anyone who can edit): validate them.
			const color = typeof prof.color === "string" ? safeColor(prof.color, "") || undefined : undefined;
			return { signPk: m.signPk, role: m.role, name: safeName(prof.name), color, avatar: safeAvatar(prof.avatar) ?? undefined, isMe: k === me };
		});
	}

	/** Community plugins a shared folder's members recommend to whoever joins it. */
	recommendedPlugins(spaceId: string): RecommendedPlugin[] {
		const map = this.shares.get(spaceId)?.space.index.ydoc.getMap<string>("plugins");
		const out: RecommendedPlugin[] = [];
		map?.forEach((v, id) => {
			try {
				const p = JSON.parse(v) as Partial<RecommendedPlugin>;
				if (typeof p.name === "string") out.push({ id, name: p.name, author: typeof p.author === "string" ? p.author : undefined });
			} catch {
				/* ignore malformed */
			}
		});
		return out.sort((a, b) => a.name.localeCompare(b.name));
	}

	/** Replace a shared folder's recommended plugins (members who can edit). */
	setRecommendedPlugins(spaceId: string, plugins: RecommendedPlugin[]): void {
		const space = this.shares.get(spaceId)?.space;
		if (!space) throw new Error("That shared folder isn't mounted here");
		if (!space.canWrite()) throw new Error("Only members who can edit can change the recommended plugins");
		const map = space.index.ydoc.getMap<string>("plugins");
		const want = new Map(plugins.filter((p) => /^[a-z0-9-_.]+$/i.test(p.id)).map((p) => [p.id, JSON.stringify({ name: p.name, author: p.author })]));
		space.index.ydoc.transact(() => {
			for (const id of [...map.keys()]) if (!want.has(id)) map.delete(id);
			for (const [id, v] of want) if (map.get(id) !== v) map.set(id, v);
		}, LOCAL_ORIGIN);
	}

	roleIn(spaceId: string): ShareRole | null {
		const info = this.infoOf(spaceId);
		return info ? ROLE_NAMES[info.role] ?? null : null;
	}

	/** The host a mounted share lives on. */
	hostOfShare(spaceId: string): string {
		return this.shareLink(spaceId).host;
	}

	async setRole(spaceId: string, signPk: Uint8Array, role: ShareRole): Promise<void> {
		const l = this.shareLink(spaceId);
		await l.shareApi.setRole(spaceId, signPk, role);
		// Vouch for a new owner, so other members' devices accept the keys they rotate.
		if (role === "owner") this.shares.get(spaceId)?.space.recordOwner(b64u(signPk));
		await this.refreshInfos(l);
	}

	/** Remove a member, then rotate the space key so they can't read anything new. */
	async removeMember(spaceId: string, signPk: Uint8Array): Promise<void> {
		await this.shareLink(spaceId).shareApi.removeMember(spaceId, signPk);
		await this.rotateKey(spaceId);
	}

	/** New epoch key, wrapped for every current member. */
	async rotateKey(spaceId: string): Promise<void> {
		const l = this.shareLink(spaceId);
		await this.refreshInfos(l);
		const info = l.infos.get(spaceId);
		if (!info) throw new Error("Not a member of this share");
		const key = newSpaceKey();
		await l.shareApi.rotate(
			spaceId,
			info.epoch + 1,
			info.members.map((m) => ({ signPk: m.signPk, wrapped: wrapKey(key, m.boxPk) })),
		);
		// Commit to the new key (signed), so members' devices accept it from us and not from the host.
		await this.shares.get(spaceId)?.space.trustOwnKey(info.epoch + 1, key);
		await this.refreshInfos(l);
	}

	/** Leave a share: this user's devices unmount it and keep the files. */
	async leaveShare(spaceId: string): Promise<void> {
		const l = this.shareLink(spaceId);
		await l.shareApi.removeMember(spaceId, this.opts.identity.signPk);
		await this.refreshInfos(l);
	}

	// ───────────── status ─────────────

	private emitStatus() {
		this.status.emit(this.currentStatus());
	}

	currentStatus(): EngineStatus {
		const all = this.allSpaces();
		const links = [...this.hosts.values()];
		// Worst connection wins, so a share on an unreachable host shows up.
		const order: ConnStatus[] = ["unauthorized", "update-required", "offline", "connecting", "online"];
		const conn = links.map((l) => l.conn.status).sort((a, b) => order.indexOf(a) - order.indexOf(b))[0] ?? "offline";
		return {
			conn,
			ready: this.root ? (this.root.mirror ? this.root.mirror.isReady : true) : false,
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
		if (this.root && !this.root.mirror) await this.root.space.stop();
		this.shares.clear();
		for (const l of this.hosts.values()) {
			for (const off of l.offs) off();
			l.conn.stop();
		}
	}
}
