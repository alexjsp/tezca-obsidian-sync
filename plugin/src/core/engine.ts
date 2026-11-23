// SyncEngine: wires a host connection, one root space and its disk mirror together.
import { fromBinary, toBinary } from "@bufbuild/protobuf";
import { SpaceInfoSchema, type SpaceInfo } from "../proto/tezca/v1/sync_pb";
import { HostConnection, type ConnStatus, type WSCtor } from "./connection";
import type { Identity } from "./crypto";
import { DiskMirror, type MirrorNotice } from "./mirror";
import { listSpaces, waitOnline } from "./setup";
import { SpaceSync } from "./space";
import type { LocalStore } from "./store";
import { Emitter, log } from "./util";
import type { VaultAdapter } from "./vault";

export interface EngineOptions {
	host: string;
	identity: Identity;
	deviceId: string;
	deviceName: string;
	spaceId: string;
	store: LocalStore;
	vault: VaultAdapter;
	clientVersion: string;
	WebSocketImpl?: WSCtor;
	isBound?: (vaultPath: string) => boolean;
	/** How long to wait for the server before reconciling from local state. */
	startupWaitMs?: number;
}

export interface EngineStatus {
	conn: ConnStatus;
	ready: boolean;
	busy: boolean;
	unsent: number;
}

export class SyncEngine {
	readonly conn: HostConnection;
	space: SpaceSync | null = null;
	mirror: DiskMirror | null = null;
	readonly status = new Emitter<EngineStatus>();
	readonly notices = new Emitter<MirrorNotice>();
	private stopped = false;

	constructor(readonly opts: EngineOptions) {
		this.conn = new HostConnection({
			host: opts.host,
			identity: opts.identity,
			deviceId: opts.deviceId,
			clientVersion: opts.clientVersion,
			WebSocketImpl: opts.WebSocketImpl,
		});
		this.conn.statusChanged.on(() => this.emitStatus());
	}

	private get infoKey() {
		return `spaceinfo/${this.opts.spaceId}`;
	}

	async start(): Promise<void> {
		const { store, identity, spaceId } = this.opts;
		this.conn.start();
		let info: SpaceInfo | null = null;
		const cached = await store.get<Uint8Array>(this.infoKey);
		if (cached) info = fromBinary(SpaceInfoSchema, cached);
		if (!info) {
			await waitOnline(this.conn, 60_000);
			info = await this.fetchInfo();
		}
		if (this.stopped) return;
		this.conn.online.on(() => void this.onOnline());

		const space = new SpaceSync(this.conn, store, identity, info);
		this.space = space;
		await space.start();
		const mirror = new DiskMirror(space, this.opts.vault, {
			mount: "",
			deviceName: this.opts.deviceName,
			isBound: this.opts.isBound,
		});
		this.mirror = mirror;
		mirror.notices.on((n) => this.notices.emit(n));
		mirror.idleChanged.on(() => this.emitStatus());
		await mirror.start();

		// Prefer reconciling against an up-to-date index; fall back to local state when offline.
		await this.waitForServerState(this.opts.startupWaitMs ?? 8000);
		if (this.stopped) return;
		await mirror.initialReconcile();
		log.info(`space ${spaceId} ready`);
		this.emitStatus();
	}

	private async waitForServerState(ms: number) {
		const space = this.space!;
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

	private async fetchInfo(): Promise<SpaceInfo> {
		const spaces = await listSpaces(this.conn);
		const info = spaces.find((s) => s.spaceId === this.opts.spaceId);
		if (!info) throw new Error(`Space ${this.opts.spaceId} not found on host (or access was removed)`);
		await this.opts.store.put(this.infoKey, toBinary(SpaceInfoSchema, info));
		return info;
	}

	private async onOnline() {
		try {
			const info = await this.fetchInfo();
			this.space?.applyInfo(info);
		} catch (e) {
			log.warn("could not refresh space info", e);
		}
	}

	private emitStatus() {
		this.status.emit(this.currentStatus());
	}

	currentStatus(): EngineStatus {
		return {
			conn: this.conn.status,
			ready: this.mirror?.isReady ?? false,
			busy: (this.mirror?.pendingWork ?? 0) > 0,
			unsent: 0,
		};
	}

	/** Wait until local work is flushed (used by tests/simulator). */
	async idle(): Promise<void> {
		await this.mirror?.idle();
	}

	async stop(): Promise<void> {
		this.stopped = true;
		await this.mirror?.stop();
		await this.space?.stop();
		this.conn.stop();
	}
}
