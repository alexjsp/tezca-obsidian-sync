// Host bootstrap flows: claim, invites, redeem, pairing, root space creation.
import { SpaceKind, type SpaceInfo } from "../proto/tezca/v1/sync_pb";
import type { HostConnection } from "./connection";
import {
	b64u,
	fromB64u,
	newSpaceKey,
	openPairing,
	randomBytes,
	randomId,
	sealPairing,
	sign,
	sigMsg,
	utf8,
	wrapKey,
	type Identity,
	type PairingPayload,
} from "./crypto";
import { encryptMeta, type SpaceMeta } from "./space";

export interface HttpResponse {
	status: number;
	json: unknown;
	text: string;
	/** Raw response body. */
	bytes: Uint8Array;
}
export interface HttpRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	body?: string | Uint8Array;
}
export type HttpFn = (req: HttpRequest) => Promise<HttpResponse>;

/** Build an HttpResponse from a raw body. */
export function httpResponse(status: number, bytes: Uint8Array): HttpResponse {
	const text = new TextDecoder().decode(bytes);
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		/* not json */
	}
	return { status, json, text, bytes };
}

/** Default HTTP using global fetch (tests, simulator). Obsidian supplies `requestUrl`. */
export const fetchHttp: HttpFn = async ({ method, url, headers, body }) => {
	const res = await fetch(url, { method, headers, body: body as BodyInit | undefined });
	return httpResponse(res.status, new Uint8Array(await res.arrayBuffer()));
};

/** `Authorization` header value for a signed HTTP request (protocol.md "HTTP API"). */
export function httpAuth(identity: Identity, method: string, pathWithQuery: string, body: Uint8Array): string {
	const ts = Math.floor(Date.now() / 1000);
	const sig = sign(identity, sigMsg.http(method, pathWithQuery, ts, body));
	return `Tezca pk=${b64u(identity.signPk)}, ts=${ts}, sig=${b64u(sig)}`;
}

export class HttpError extends Error {
	constructor(
		public status: number,
		message: string,
	) {
		super(message);
	}
}

export function normalizeHost(host: string): string {
	let h = host.trim();
	if (!/^https?:\/\//i.test(h)) h = "https://" + h;
	return h.replace(/\/+$/, "");
}

export interface ServerInfo {
	server_id: string;
	protocol_version: number;
	claimed: boolean;
	name?: string;
	/** Largest blob plaintext the host accepts (M2+). */
	max_blob_bytes?: number;
	/** Optional server features, e.g. "update-log" (point-in-time history). */
	features?: string[];
}

export class HostApi {
	constructor(
		readonly host: string,
		private readonly http: HttpFn = fetchHttp,
	) {}

	private async call<T>(method: string, path: string, body?: unknown, identity?: Identity): Promise<T> {
		const bodyStr = body === undefined ? "" : JSON.stringify(body);
		const headers: Record<string, string> = {};
		if (body !== undefined) headers["Content-Type"] = "application/json";
		if (identity) headers["Authorization"] = httpAuth(identity, method, path, utf8(bodyStr));
		const res = await this.http({ method, url: this.host + path, headers, body: body === undefined ? undefined : bodyStr });
		if (res.status < 200 || res.status >= 300) {
			const msg = (res.json as { error?: string } | null)?.error ?? res.text ?? `HTTP ${res.status}`;
			throw new HttpError(res.status, msg);
		}
		return res.json as T;
	}

	/** An unsigned JSON request. */
	unsigned<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
		return this.call<T>(method, path, body);
	}

	/** A signed JSON request (any method). */
	signed<T = unknown>(method: string, path: string, identity: Identity, body?: unknown): Promise<T> {
		return this.call<T>(method, path, body, identity);
	}

	info(): Promise<ServerInfo> {
		return this.call("GET", "/api/info");
	}

	async claim(code: string, id: Identity): Promise<{ server_id: string; role: string }> {
		const info = await this.info();
		const sig = sign(id, sigMsg.redeem(info.server_id, code, id.signPk, id.boxPk));
		return this.call("POST", "/api/claim", { code, sign_pk: b64u(id.signPk), box_pk: b64u(id.boxPk), sig: b64u(sig) });
	}

	async redeem(token: string, id: Identity): Promise<{ server_id: string; role: string }> {
		const info = await this.info();
		const sig = sign(id, sigMsg.redeem(info.server_id, token, id.signPk, id.boxPk));
		return this.call("POST", "/api/redeem", { token, sign_pk: b64u(id.signPk), box_pk: b64u(id.boxPk), sig: b64u(sig) });
	}

	createInvite(id: Identity, ttlSeconds = 7 * 86400): Promise<{ token: string; expires_at: number; link: string }> {
		return this.call("POST", "/api/invites", { role: "member", ttl_seconds: ttlSeconds }, id);
	}

	/** Upload an encrypted pairing bundle. Returns the deep link for the new device. */
	async createPairing(id: Identity, payload: PairingPayload): Promise<{ link: string; expiresAt: number }> {
		const secret = randomBytes(32);
		const ct = sealPairing(secret, payload);
		const res = await this.call<{ id: string; expires_at: number }>("POST", "/api/pairings", { ciphertext: b64u(ct) }, id);
		const link = `obsidian://tezca?do=pair&host=${encodeURIComponent(this.host)}&id=${encodeURIComponent(res.id)}&k=${b64u(secret)}`;
		return { link, expiresAt: res.expires_at };
	}

	async fetchPairing(pairingId: string, secretB64u: string): Promise<PairingPayload> {
		const res = await this.call<{ ciphertext: string }>("GET", `/api/pairings/${encodeURIComponent(pairingId)}`);
		return openPairing(fromB64u(secretB64u), fromB64u(res.ciphertext));
	}
}

export type ShareRole = "owner" | "editor" | "viewer";

export interface ShareInviteInfo {
	token: string;
	role: ShareRole;
	created_at: number;
	expires_at: number;
	redeemed_by?: string;
	redeemed_at?: number;
}

export interface RedeemedShare {
	space_id: string;
	role: ShareRole;
	keys: { epoch: number; wrapped: string }[];
	kind: string;
	epoch: number;
	meta: string;
	meta_epoch: number;
}

/** Share and membership management (protocol.md "Shares (M3)"). */
export class ShareApi {
	constructor(
		private readonly api: HostApi,
		private readonly identity: Identity,
	) {}

	private sp(spaceId: string) {
		return `/api/spaces/${encodeURIComponent(spaceId)}`;
	}

	/** Link for a share invite (the secret only ever travels in the link's fragment). */
	link(token: string, secret: Uint8Array): string {
		const host = normalizeHost(this.api.host);
		return inviteLink(host, { do: "share", host, token, k: b64u(secret) });
	}

	createInvite(spaceId: string, role: "editor" | "viewer", keys: { epoch: number; wrapped: Uint8Array }[], ttlSeconds?: number) {
		return this.api.signed<{ token: string; expires_at: number }>("POST", `${this.sp(spaceId)}/invites`, this.identity, {
			role,
			keys: keys.map((k) => ({ epoch: k.epoch, wrapped: b64u(k.wrapped) })),
			...(ttlSeconds ? { ttl_seconds: ttlSeconds } : {}),
		});
	}

	async listInvites(spaceId: string): Promise<ShareInviteInfo[]> {
		return (await this.api.signed<{ invites: ShareInviteInfo[] }>("GET", `${this.sp(spaceId)}/invites`, this.identity)).invites ?? [];
	}

	revokeInvite(spaceId: string, token: string) {
		return this.api.signed("DELETE", `${this.sp(spaceId)}/invites/${encodeURIComponent(token)}`, this.identity);
	}

	redeem(token: string): Promise<RedeemedShare> {
		return this.api.signed("POST", "/api/share-invites/redeem", this.identity, { token });
	}

	/** Redeem without being a user of this host yet: becomes a guest (protocol.md "Guests"). */
	async redeemAsGuest(token: string): Promise<RedeemedShare> {
		const info = await this.api.info();
		const id = this.identity;
		const sig = sign(id, sigMsg.redeem(info.server_id, token, id.signPk, id.boxPk));
		// No Authorization header: the key isn't a user here yet; the body signature proves it.
		return this.api.unsigned("POST", "/api/share-invites/redeem", { token, sign_pk: b64u(id.signPk), box_pk: b64u(id.boxPk), sig: b64u(sig) });
	}

	putKeys(spaceId: string, keys: { epoch: number; wrapped: Uint8Array }[]) {
		return this.api.signed("PUT", `${this.sp(spaceId)}/keys`, this.identity, { keys: keys.map((k) => ({ epoch: k.epoch, wrapped: b64u(k.wrapped) })) });
	}

	setRole(spaceId: string, signPk: Uint8Array, role: ShareRole) {
		return this.api.signed("PUT", `${this.sp(spaceId)}/members/${b64u(signPk)}`, this.identity, { role });
	}

	removeMember(spaceId: string, signPk: Uint8Array) {
		return this.api.signed("DELETE", `${this.sp(spaceId)}/members/${b64u(signPk)}`, this.identity);
	}

	rotate(spaceId: string, epoch: number, keys: { signPk: Uint8Array; wrapped: Uint8Array }[]) {
		return this.api.signed<{ epoch: number }>("POST", `${this.sp(spaceId)}/rotate`, this.identity, {
			epoch,
			keys: keys.map((k) => ({ sign_pk: b64u(k.signPk), wrapped: b64u(k.wrapped) })),
		});
	}
}

export async function listSpaces(conn: HostConnection): Promise<SpaceInfo[]> {
	const res = await conn.request((rid) => ({ case: "listSpaces", value: { rid } }), "spaceList");
	return res.spaces;
}

export async function createRootSpace(conn: HostConnection, identity: Identity, name: string): Promise<SpaceInfo> {
	return createSpace(conn, identity, name, SpaceKind.ROOT);
}

export async function createSpace(conn: HostConnection, identity: Identity, name: string, kind: SpaceKind): Promise<SpaceInfo> {
	const spaceId = randomId();
	const key = newSpaceKey();
	const meta: SpaceMeta = { name, created: Date.now() };
	const res = await conn.request(
		(rid) => ({
			case: "createSpace",
			value: {
				rid,
				spaceId,
				kind,
				wrappedKey: wrapKey(key, identity.boxPk),
				meta: encryptMeta(spaceId, key, 0, meta),
			},
		}),
		"spaceCreated",
	);
	if (!res.space) throw new Error("server returned no space");
	return res.space;
}

/** Wait until a connection is online (or fails terminally). */
export function waitOnline(conn: HostConnection, timeoutMs = 20_000): Promise<void> {
	if (conn.status === "online") return Promise.resolve();
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			off();
			reject(new Error("timed out connecting to host"));
		}, timeoutMs);
		const off = conn.statusChanged.on((s) => {
			if (s === "online") {
				clearTimeout(timer);
				off();
				resolve();
			} else if (s === "unauthorized" || s === "update-required") {
				clearTimeout(timer);
				off();
				reject(new Error(s === "unauthorized" ? "This identity is not registered on the host" : "Plugin/host protocol mismatch: update required"));
			}
		});
	});
}

/**
 * The link people send for a join or share invite: the host's invite page with the deep link's
 * parameters in the fragment, which browsers never send to the server (protocol.md "Invite links").
 */
export function inviteLink(host: string, params: Record<string, string>): string {
	return `${normalizeHost(host)}/invite#${new URLSearchParams(params).toString()}`;
}

/**
 * The deep link parameters in a pasted setup link: the query of an obsidian://tezca?… link, or
 * the fragment of an https://…/invite#… invite link. Null if it isn't a link with a `do`.
 */
export function linkParams(link: string): Record<string, string> | null {
	let url: URL;
	try {
		url = new URL(link.trim());
	} catch {
		return null;
	}
	let search: URLSearchParams;
	if (url.protocol === "obsidian:") search = url.searchParams;
	else if (url.protocol === "https:" || url.protocol === "http:") search = new URLSearchParams(url.hash.replace(/^#/, ""));
	else return null;
	const params: Record<string, string> = {};
	search.forEach((v, k) => (params[k] = v));
	return params.do ? params : null;
}

export function parseDeepLink(params: Record<string, string>): {
	action: "claim" | "join" | "pair" | "share";
	host: string;
	code?: string;
	token?: string;
	id?: string;
	k?: string;
} | null {
	const action = params["do"];
	if (action !== "claim" && action !== "join" && action !== "pair" && action !== "share") return null;
	if (!params.host) return null;
	return { action, host: normalizeHost(params.host), code: params.code, token: params.token, id: params.id, k: params.k };
}
