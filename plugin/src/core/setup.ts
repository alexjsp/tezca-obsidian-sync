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
}
export type HttpFn = (req: { method: string; url: string; headers: Record<string, string>; body?: string }) => Promise<HttpResponse>;

/** Default HTTP using global fetch (tests, simulator). Obsidian supplies `requestUrl`. */
export const fetchHttp: HttpFn = async ({ method, url, headers, body }) => {
	const res = await fetch(url, { method, headers, body });
	const text = await res.text();
	let json: unknown = null;
	try {
		json = text ? JSON.parse(text) : null;
	} catch {
		/* not json */
	}
	return { status: res.status, json, text };
};

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
		if (identity) {
			const ts = Math.floor(Date.now() / 1000);
			const sig = sign(identity, sigMsg.http(method, path, ts, utf8(bodyStr)));
			headers["Authorization"] = `Tezca pk=${b64u(identity.signPk)}, ts=${ts}, sig=${b64u(sig)}`;
		}
		const res = await this.http({ method, url: this.host + path, headers, body: body === undefined ? undefined : bodyStr });
		if (res.status < 200 || res.status >= 300) {
			const msg = (res.json as { error?: string } | null)?.error ?? res.text ?? `HTTP ${res.status}`;
			throw new HttpError(res.status, msg);
		}
		return res.json as T;
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

export async function listSpaces(conn: HostConnection): Promise<SpaceInfo[]> {
	const res = await conn.request((rid) => ({ case: "listSpaces", value: { rid } }), "spaceList");
	return res.spaces;
}

export async function createRootSpace(conn: HostConnection, identity: Identity, name: string): Promise<SpaceInfo> {
	const spaceId = randomId();
	const key = newSpaceKey();
	const meta: SpaceMeta = { name, created: Date.now() };
	const res = await conn.request(
		(rid) => ({
			case: "createSpace",
			value: {
				rid,
				spaceId,
				kind: SpaceKind.ROOT,
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

export function parseDeepLink(params: Record<string, string>): {
	action: "claim" | "join" | "pair";
	host: string;
	code?: string;
	token?: string;
	id?: string;
	k?: string;
} | null {
	const action = params["do"];
	if (action !== "claim" && action !== "join" && action !== "pair") return null;
	if (!params.host) return null;
	return { action, host: normalizeHost(params.host), code: params.code, token: params.token, id: params.id, k: params.k };
}
