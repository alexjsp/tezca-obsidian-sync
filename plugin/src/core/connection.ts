// HostConnection: one authenticated WebSocket to a Tezca host, with reconnect, keepalive,
// request/response matching and frame dispatch.
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import {
	ClientFrameSchema,
	ErrorCode,
	ServerFrameSchema,
	type AuthOk,
	type ServerFrame,
} from "../proto/tezca/v1/sync_pb";
import { sign, sigMsg, type Identity } from "./crypto";
import { Emitter, log } from "./util";

export const PROTOCOL_VERSION = 1;

export type ConnStatus = "offline" | "connecting" | "online" | "stopped" | "update-required" | "unauthorized";

type ClientMsg = MessageInitShape<typeof ClientFrameSchema>["msg"];
export type ServerMsg = ServerFrame["msg"];
type ServerCase = NonNullable<ServerMsg["case"]>;
type ServerValue<C extends ServerCase> = Extract<ServerMsg, { case: C }>["value"];

/** Minimal WebSocket surface so tests and the simulator can inject `ws`. */
export interface WSLike {
	binaryType: string;
	readyState: number;
	send(data: Uint8Array): void;
	close(code?: number, reason?: string): void;
	onopen: ((ev: unknown) => void) | null;
	onclose: ((ev: unknown) => void) | null;
	onerror: ((ev: unknown) => void) | null;
	onmessage: ((ev: { data: unknown }) => void) | null;
}
export type WSCtor = new (url: string) => WSLike;

export interface ConnectionOptions {
	host: string; // http(s)://host[:port][/prefix]
	identity: Identity;
	deviceId: string;
	clientVersion: string;
	WebSocketImpl?: WSCtor;
}

export class ServerError extends Error {
	constructor(
		public code: ErrorCode,
		message: string,
	) {
		super(`${ErrorCode[code] ?? code}: ${message}`);
	}
}

export function wsUrl(host: string): string {
	const u = new URL(host);
	u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
	u.pathname = u.pathname.replace(/\/+$/, "") + "/ws";
	u.search = "";
	u.hash = "";
	return u.toString();
}

export class HostConnection {
	status: ConnStatus = "offline";
	authInfo: AuthOk | null = null;
	readonly statusChanged = new Emitter<ConnStatus>();
	/** Fires after every successful (re)authentication. */
	readonly online = new Emitter<AuthOk>();
	private readonly handlers = new Map<ServerCase, Set<(v: never) => void>>();
	private ws: WSLike | null = null;
	private stopped = true;
	private attempt = 0;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
	private pingTimer: ReturnType<typeof setInterval> | null = null;
	private lastRx = 0;
	private nextRid = 1;
	private readonly pending = new Map<number, { resolve: (f: ServerMsg) => void; reject: (e: Error) => void }>();

	constructor(private readonly opts: ConnectionOptions) {}

	get host(): string {
		return this.opts.host;
	}

	start(): void {
		if (!this.stopped) return;
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = null;
		this.teardown();
		this.setStatus("stopped");
	}

	/** Force an immediate reconnect attempt (e.g. user command, network change). */
	reconnectNow(): void {
		if (this.stopped) return;
		if (this.status === "online" || this.status === "connecting") return;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.attempt = 0;
		this.connect();
	}

	on<C extends ServerCase>(kind: C, fn: (v: ServerValue<C>) => void): () => void {
		let set = this.handlers.get(kind);
		if (!set) this.handlers.set(kind, (set = new Set()));
		set.add(fn as (v: never) => void);
		return () => set!.delete(fn as (v: never) => void);
	}

	/** Send a frame if online. Returns false if it could not be sent. */
	send(msg: ClientMsg): boolean {
		if (this.status !== "online" || !this.ws) return false;
		return this.rawSend(msg);
	}

	allocRid(): number {
		const rid = this.nextRid++;
		if (this.nextRid > 0x7fffffff) this.nextRid = 1;
		return rid;
	}

	/** Request/response for frames carrying `rid`. */
	request<C extends ServerCase>(build: (rid: number) => ClientMsg, expect: C, timeoutMs = 15000): Promise<ServerValue<C>> {
		const rid = this.allocRid();
		return new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(rid);
				reject(new Error("request timed out"));
			}, timeoutMs);
			this.pending.set(rid, {
				resolve: (m) => {
					clearTimeout(timer);
					if (m.case === expect) resolve(m.value);
					else reject(new Error(`unexpected reply ${m.case}`));
				},
				reject: (e) => {
					clearTimeout(timer);
					reject(e);
				},
			});
			if (!this.send(build(rid))) {
				clearTimeout(timer);
				this.pending.delete(rid);
				reject(new Error("not connected"));
			}
		}) as Promise<ServerValue<C>>;
	}

	// ───────────── internals ─────────────

	private setStatus(s: ConnStatus) {
		if (this.status === s) return;
		this.status = s;
		this.statusChanged.emit(s);
	}

	private rawSend(msg: ClientMsg): boolean {
		try {
			this.ws!.send(toBinary(ClientFrameSchema, create(ClientFrameSchema, { msg })));
			return true;
		} catch (e) {
			log.warn("send failed", e);
			return false;
		}
	}

	private connect() {
		this.teardown();
		this.setStatus("connecting");
		const Impl = this.opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as WSCtor);
		let ws: WSLike;
		try {
			ws = new Impl(wsUrl(this.opts.host));
		} catch (e) {
			log.warn("ws construct failed", e);
			this.scheduleReconnect();
			return;
		}
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		ws.onmessage = (ev) => {
			if (this.ws !== ws) return;
			this.lastRx = Date.now();
			let frame: ServerFrame;
			try {
				frame = fromBinary(ServerFrameSchema, toBytes(ev.data));
			} catch (e) {
				log.warn("bad frame", e);
				return;
			}
			this.handleFrame(frame.msg);
		};
		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.onDisconnected();
		};
		ws.onerror = () => {
			/* onclose follows */
		};
	}

	private handleFrame(m: ServerMsg) {
		switch (m.case) {
			case "challenge": {
				const { identity, deviceId, clientVersion } = this.opts;
				if (m.value.protocolVersion !== PROTOCOL_VERSION) {
					this.fatal("update-required");
					return;
				}
				this.rawSend({
					case: "hello",
					value: { signPk: identity.signPk, deviceId, protocolVersion: PROTOCOL_VERSION, clientVersion },
				});
				const sig = sign(identity, sigMsg.auth(m.value.serverId, m.value.nonce, identity.signPk, deviceId));
				this.rawSend({ case: "auth", value: { sig } });
				return;
			}
			case "authOk":
				this.authInfo = m.value;
				this.attempt = 0;
				this.lastRx = Date.now();
				this.setStatus("online");
				this.startPing();
				this.online.emit(m.value);
				return;
			case "error": {
				const err = m.value;
				if (err.code === ErrorCode.UPDATE_REQUIRED) return this.fatal("update-required");
				if (err.code === ErrorCode.UNAUTHORIZED && this.status !== "online") return this.fatal("unauthorized");
				if (err.rid && this.pending.has(err.rid)) {
					const p = this.pending.get(err.rid)!;
					this.pending.delete(err.rid);
					p.reject(new ServerError(err.code, err.message));
					return;
				}
				break; // fall through to dispatch for ref-scoped errors (pushes)
			}
			case "spaceList":
			case "spaceCreated":
			case "versionList":
			case "versionData": {
				const p = this.pending.get(m.value.rid);
				if (p) {
					this.pending.delete(m.value.rid);
					p.resolve(m);
				}
				return;
			}
		}
		if (!m.case) return;
		const set = this.handlers.get(m.case);
		if (set) for (const fn of set) (fn as (v: unknown) => void)(m.value);
	}

	private fatal(s: ConnStatus) {
		this.stopped = true;
		this.teardown();
		this.setStatus(s);
	}

	private startPing() {
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pingTimer = setInterval(() => {
			if (Date.now() - this.lastRx > 60_000) {
				log.info("connection idle, reconnecting");
				this.onDisconnected();
				return;
			}
			this.send({ case: "ping", value: { t: BigInt(Date.now()) } });
		}, 25_000);
	}

	private teardown() {
		if (this.pingTimer) clearInterval(this.pingTimer);
		this.pingTimer = null;
		const ws = this.ws;
		this.ws = null;
		if (ws) {
			ws.onopen = ws.onclose = ws.onerror = ws.onmessage = null;
			try {
				ws.close();
			} catch {
				/* ignore */
			}
		}
		for (const p of this.pending.values()) p.reject(new Error("disconnected"));
		this.pending.clear();
	}

	private onDisconnected() {
		this.teardown();
		this.authInfo = null;
		if (this.stopped) return;
		this.setStatus("offline");
		this.scheduleReconnect();
	}

	private scheduleReconnect() {
		if (this.stopped) return;
		const base = Math.min(30_000, 500 * 2 ** this.attempt);
		const delay = base / 2 + Math.random() * (base / 2);
		this.attempt++;
		if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
		this.reconnectTimer = setTimeout(() => {
			this.reconnectTimer = null;
			this.connect();
		}, delay);
	}
}

function toBytes(data: unknown): Uint8Array {
	if (data instanceof Uint8Array) return data;
	if (data instanceof ArrayBuffer) return new Uint8Array(data);
	if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
	throw new Error("unsupported ws message type");
}
