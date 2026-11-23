// In-memory implementation of the Tezca host protocol, for fast plugin tests.
// Mirrors docs/protocol.md closely (but without persistence or HTTP).
import { create, fromBinary, toBinary, type MessageInitShape } from "@bufbuild/protobuf";
import {
	ClientFrameSchema,
	ErrorCode,
	HostRole,
	ServerFrameSchema,
	SpaceRole,
	type ClientFrame,
	type SpaceInfo,
	type Update,
} from "../src/proto/tezca/v1/sync_pb";
import type { WSCtor, WSLike } from "../src/core/connection";
import { bytesEqual, b64u, randomBytes, sigMsg, verify } from "../src/core/crypto";

type ServerMsg = MessageInitShape<typeof ServerFrameSchema>["msg"];

interface DocState {
	updates: Update[];
	latest: bigint;
	snapshot: { baseSeq: bigint; epoch: number; author: Uint8Array; payload: Uint8Array; sig: Uint8Array } | null;
	subs: Set<MockConn>;
}

interface SpaceState {
	id: string;
	kind: number;
	epoch: number;
	meta: Uint8Array;
	members: Map<string, { signPk: Uint8Array; boxPk: Uint8Array; role: SpaceRole; wrapped: Map<number, Uint8Array> }>;
	docs: Map<string, DocState>;
	subs: Set<MockConn>;
}

export class MockHost {
	readonly serverId = "srv_mock";
	users = new Map<string, { signPk: Uint8Array; boxPk: Uint8Array }>();
	spaces = new Map<string, SpaceState>();
	conns = new Set<MockConn>();
	/** Simulated one-way latency (ms). */
	latency = 0;
	/** When true, every new connection is dropped immediately (server unreachable). */
	down = false;

	addUser(signPk: Uint8Array, boxPk: Uint8Array) {
		this.users.set(b64u(signPk), { signPk, boxPk });
	}

	/** A WebSocket constructor bound to this host. */
	get WebSocket(): WSCtor {
		const host = this;
		return class implements WSLike {
			binaryType = "arraybuffer";
			readyState = 0;
			onopen: ((ev: unknown) => void) | null = null;
			onclose: ((ev: unknown) => void) | null = null;
			onerror: ((ev: unknown) => void) | null = null;
			onmessage: ((ev: { data: unknown }) => void) | null = null;
			conn: MockConn;
			constructor(_url: string) {
				this.conn = new MockConn(host, this);
				host.conns.add(this.conn);
				setTimeout(() => {
					if (host.down) return this.conn.kill();
					this.readyState = 1;
					this.onopen?.({});
					this.conn.start();
				}, 0);
			}
			send(data: Uint8Array) {
				const copy = data.slice();
				setTimeout(() => this.conn.receive(copy), host.latency);
			}
			close() {
				if (this.readyState === 3) return;
				this.readyState = 3;
				this.conn.closed();
				setTimeout(() => this.onclose?.({}), 0);
			}
		} as unknown as WSCtor;
	}

	/** Drop every connection (clients will reconnect). */
	dropAll() {
		for (const c of [...this.conns]) c.kill();
	}

	doc(space: SpaceState, docId: string): DocState {
		let d = space.docs.get(docId);
		if (!d) space.docs.set(docId, (d = { updates: [], latest: 0n, snapshot: null, subs: new Set() }));
		return d;
	}

	spaceInfo(s: SpaceState, pk: string): SpaceInfo {
		const me = s.members.get(pk)!;
		return {
			spaceId: s.id,
			kind: s.kind,
			role: me.role,
			epoch: s.epoch,
			keys: [...me.wrapped].map(([epoch, wrapped]) => ({ epoch, wrapped })),
			meta: s.meta,
			metaEpoch: 0,
			members: [...s.members.values()].map((m) => ({ signPk: m.signPk, boxPk: m.boxPk, role: m.role })),
		} as unknown as SpaceInfo;
	}
}

export class MockConn {
	pk: string | null = null;
	signPk: Uint8Array | null = null;
	deviceId = "";
	nonce = randomBytes(32);
	hello: { signPk: Uint8Array; deviceId: string } | null = null;
	alive = true;
	spaceSubs = new Set<string>();
	docSubs = new Set<string>();

	constructor(
		readonly host: MockHost,
		readonly ws: WSLike & { readyState: number },
	) {}

	send(msg: ServerMsg) {
		if (!this.alive) return;
		const bytes = toBinary(ServerFrameSchema, create(ServerFrameSchema, { msg }));
		setTimeout(() => {
			if (this.alive) this.ws.onmessage?.({ data: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
		}, this.host.latency);
	}

	start() {
		this.send({ case: "challenge", value: { nonce: this.nonce, serverId: this.host.serverId, protocolVersion: 1 } });
	}

	closed() {
		this.alive = false;
		this.host.conns.delete(this);
		for (const s of this.host.spaces.values()) {
			s.subs.delete(this);
			for (const d of s.docs.values()) d.subs.delete(this);
		}
	}

	kill() {
		this.closed();
		this.ws.readyState = 3;
		setTimeout(() => this.ws.onclose?.({}), 0);
	}

	err(rid: number, code: ErrorCode, message: string) {
		this.send({ case: "error", value: { rid, code, message } });
	}

	receive(bytes: Uint8Array) {
		if (!this.alive) return;
		const f: ClientFrame = fromBinary(ClientFrameSchema, bytes);
		const m = f.msg;
		const h = this.host;
		if (m.case === "hello") {
			this.hello = { signPk: m.value.signPk, deviceId: m.value.deviceId };
			return;
		}
		if (m.case === "auth") {
			const hello = this.hello;
			if (!hello || !verify(hello.signPk, sigMsg.auth(h.serverId, this.nonce, hello.signPk, hello.deviceId), m.value.sig)) {
				this.err(0, ErrorCode.UNAUTHORIZED, "bad auth");
				return this.kill();
			}
			const u = h.users.get(b64u(hello.signPk));
			if (!u) {
				this.err(0, ErrorCode.UNAUTHORIZED, "unknown user");
				return this.kill();
			}
			this.pk = b64u(hello.signPk);
			this.signPk = hello.signPk;
			this.deviceId = hello.deviceId;
			this.send({ case: "authOk", value: { signPk: u.signPk, boxPk: u.boxPk, role: HostRole.ADMIN } });
			return;
		}
		if (!this.pk) {
			this.err(0, ErrorCode.UNAUTHORIZED, "not authed");
			return this.kill();
		}
		const pk = this.pk;
		const member = (spaceId: string) => h.spaces.get(spaceId)?.members.get(pk);
		switch (m.case) {
			case "ping":
				return this.send({ case: "pong", value: { t: m.value.t } });
			case "listSpaces": {
				const spaces = [...h.spaces.values()].filter((s) => s.members.has(pk)).map((s) => h.spaceInfo(s, pk));
				return this.send({ case: "spaceList", value: { rid: m.value.rid, spaces } });
			}
			case "createSpace": {
				const v = m.value;
				if (h.spaces.has(v.spaceId)) return this.err(v.rid, ErrorCode.CONFLICT, "exists");
				const u = h.users.get(pk)!;
				const s: SpaceState = {
					id: v.spaceId,
					kind: v.kind,
					epoch: 0,
					meta: v.meta,
					members: new Map([[pk, { signPk: u.signPk, boxPk: u.boxPk, role: SpaceRole.OWNER, wrapped: new Map([[0, v.wrappedKey]]) }]]),
					docs: new Map(),
					subs: new Set(),
				};
				h.spaces.set(v.spaceId, s);
				return this.send({ case: "spaceCreated", value: { rid: v.rid, space: h.spaceInfo(s, pk) } });
			}
			case "subscribeSpace": {
				const s = h.spaces.get(m.value.spaceId);
				if (!s || !member(s.id)) return this.err(0, ErrorCode.FORBIDDEN, "not a member");
				s.subs.add(this);
				const heads = [...s.docs.entries()]
					.filter(([, d]) => d.latest > 0n || d.snapshot)
					.map(([docId, d]) => ({ docId, latestSeq: d.latest, snapshotSeq: d.snapshot?.baseSeq ?? 0n }));
				return this.send({ case: "docHeads", value: { spaceId: s.id, full: true, heads } });
			}
			case "unsubscribeSpace":
				h.spaces.get(m.value.spaceId)?.subs.delete(this);
				return;
			case "subscribe": {
				const s = h.spaces.get(m.value.spaceId);
				if (!s || !member(s.id)) return this.err(0, ErrorCode.FORBIDDEN, "not a member");
				const d = h.doc(s, m.value.docId);
				let from = m.value.sinceSeq;
				if (d.snapshot && d.snapshot.baseSeq > from) {
					this.send({ case: "snapshot", value: { spaceId: s.id, docId: m.value.docId, ...d.snapshot } });
					from = d.snapshot.baseSeq;
				}
				const backlog = d.updates.filter((u) => u.seq > from);
				if (backlog.length) this.send({ case: "updates", value: { spaceId: s.id, docId: m.value.docId, updates: backlog } });
				const since = d.updates.filter((u) => u.seq > (d.snapshot?.baseSeq ?? 0n));
				this.send({
					case: "syncDone",
					value: {
						spaceId: s.id,
						docId: m.value.docId,
						latestSeq: d.latest,
						updatesSinceSnapshot: since.length,
						bytesSinceSnapshot: BigInt(since.reduce((a, u) => a + u.payload.length, 0)),
					},
				});
				d.subs.add(this);
				return;
			}
			case "unsubscribe": {
				const s = h.spaces.get(m.value.spaceId);
				s?.docs.get(m.value.docId)?.subs.delete(this);
				return;
			}
			case "pushUpdate": {
				const v = m.value;
				const s = h.spaces.get(v.spaceId);
				const mem = member(v.spaceId);
				if (!s || !mem || mem.role === SpaceRole.VIEWER) return this.err(v.ref, ErrorCode.FORBIDDEN, "no write");
				if (v.epoch !== s.epoch) return this.err(v.ref, ErrorCode.EPOCH_STALE, "stale");
				if (!verify(this.signPk!, sigMsg.update(v.spaceId, v.docId, v.epoch, v.payload), v.sig))
					return this.err(v.ref, ErrorCode.UNAUTHORIZED, "bad sig");
				const d = h.doc(s, v.docId);
				d.latest += 1n;
				const u = { seq: d.latest, epoch: v.epoch, author: this.signPk!, payload: v.payload, sig: v.sig } as Update;
				d.updates.push(u);
				this.send({ case: "ack", value: { ref: v.ref, spaceId: v.spaceId, docId: v.docId, seq: u.seq } });
				for (const c of d.subs) if (c !== this) c.send({ case: "updates", value: { spaceId: v.spaceId, docId: v.docId, updates: [u] } });
				for (const c of s.subs)
					c.send({
						case: "docHeads",
						value: { spaceId: s.id, full: false, heads: [{ docId: v.docId, latestSeq: d.latest, snapshotSeq: d.snapshot?.baseSeq ?? 0n }] },
					});
				return;
			}
			case "putSnapshot": {
				const v = m.value;
				const s = h.spaces.get(v.spaceId);
				const mem = member(v.spaceId);
				if (!s || !mem || mem.role === SpaceRole.VIEWER) return this.err(v.ref, ErrorCode.FORBIDDEN, "no write");
				const d = h.doc(s, v.docId);
				if (v.baseSeq < 1n || v.baseSeq > d.latest || (d.snapshot && v.baseSeq <= d.snapshot.baseSeq))
					return this.err(v.ref, ErrorCode.CONFLICT, "bad base");
				if (!verify(this.signPk!, sigMsg.snapshot(v.spaceId, v.docId, v.baseSeq, v.epoch, v.payload), v.sig))
					return this.err(v.ref, ErrorCode.UNAUTHORIZED, "bad sig");
				d.snapshot = { baseSeq: v.baseSeq, epoch: v.epoch, author: this.signPk!, payload: v.payload, sig: v.sig };
				d.updates = d.updates.filter((u) => u.seq > v.baseSeq);
				this.send({ case: "snapshotAck", value: { ref: v.ref, spaceId: v.spaceId, docId: v.docId, baseSeq: v.baseSeq } });
				return;
			}
			case "awareness": {
				const v = m.value;
				const s = h.spaces.get(v.spaceId);
				if (!s || !member(v.spaceId)) return;
				const d = s.docs.get(v.docId);
				if (!d) return;
				for (const c of d.subs)
					if (c !== this)
						c.send({ case: "awareness", value: { spaceId: v.spaceId, docId: v.docId, epoch: v.epoch, from: this.signPk!, deviceId: this.deviceId, payload: v.payload } });
				return;
			}
		}
	}
}

export { bytesEqual };
