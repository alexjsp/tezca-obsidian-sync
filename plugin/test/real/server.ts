// Runs plugin engines against the real Go server (built once per test run).
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import WebSocket from "ws";
import { HostConnection, type WSCtor } from "../../src/core/connection";
import { identityFromSeed, randomBytes, type Identity } from "../../src/core/crypto";
import { SyncEngine } from "../../src/core/engine";
import { HostApi, createRootSpace, linkParams, waitOnline } from "../../src/core/setup";
import { MemoryStore } from "../../src/core/store";
import { MemoryVault } from "../../src/core/vault";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
let built: string | null = null;

function buildServer(): string {
	if (built) return built;
	const out = join(root, "sim", ".runs", "tezca-server-test");
	execFileSync("go", ["build", "-o", out, "./cmd/tezca-server"], { cwd: join(root, "server"), stdio: "inherit" });
	built = out;
	return out;
}

async function freePort(): Promise<number> {
	return new Promise((res) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => res(p));
		});
	});
}

/** Node's ws throws on close-before-open without an error listener; browsers don't. */
export const NodeWS = class extends WebSocket {
	constructor(url: string) {
		super(url);
		this.on("error", () => undefined);
	}
} as unknown as WSCtor;

export interface RealServer {
	url: string;
	stop(): Promise<void>;
}

export async function startServer(): Promise<RealServer> {
	const bin = buildServer();
	const port = await freePort();
	const dir = mkdtempSync(join(tmpdir(), "tezca-test-"));
	const url = `http://127.0.0.1:${port}`;
	const proc: ChildProcess = spawn(bin, [], {
		env: { ...process.env, TEZCA_DATA_DIR: dir, TEZCA_LISTEN: `127.0.0.1:${port}`, TEZCA_CLAIM_CODE: "testcode", TEZCA_PUBLIC_URL: url },
		stdio: process.env.TEZCA_TEST_VERBOSE ? "inherit" : "ignore",
	});
	for (let i = 0; i < 200; i++) {
		try {
			if ((await fetch(url + "/healthz")).ok) break;
		} catch {
			/* not up yet */
		}
		await new Promise((r) => setTimeout(r, 50));
	}
	return {
		url,
		async stop() {
			proc.kill("SIGTERM");
			await new Promise((r) => setTimeout(r, 50));
			rmSync(dir, { recursive: true, force: true });
		},
	};
}

export interface User {
	name: string;
	id: Identity;
	rootSpaceId: string;
}

/** The admin (claims the host) and their root space. */
export async function claimAdmin(server: RealServer, name = "Admin"): Promise<User> {
	const id = identityFromSeed(randomBytes(32));
	await new HostApi(server.url).claim("testcode", id);
	return { name, id, rootSpaceId: await makeRoot(server, id) };
}

/** A host member invited by the admin, with their own root space. */
export async function inviteMember(server: RealServer, admin: User, name: string): Promise<User> {
	const api = new HostApi(server.url);
	const { token } = await api.createInvite(admin.id);
	const id = identityFromSeed(randomBytes(32));
	await api.redeem(token, id);
	return { name, id, rootSpaceId: await makeRoot(server, id) };
}

async function makeRoot(server: RealServer, id: Identity): Promise<string> {
	const conn = new HostConnection({ host: server.url, identity: id, deviceId: "setup", clientVersion: "test", WebSocketImpl: NodeWS });
	conn.start();
	await waitOnline(conn);
	const space = await createRootSpace(conn, id, "vault");
	conn.stop();
	return space.spaceId;
}

export interface Device {
	user: User;
	name: string;
	vault: MemoryVault;
	store: MemoryStore;
	engine: SyncEngine;
}

/** Start a device (engine) for a user. Reuse vault/store to simulate a restart. */
export async function startDevice(server: RealServer, user: User, name: string, vault = new MemoryVault(), store = new MemoryStore()): Promise<Device> {
	const engine = new SyncEngine({
		host: server.url,
		identity: user.id,
		deviceId: name,
		deviceName: name,
		spaceId: user.rootSpaceId,
		store,
		vault,
		clientVersion: "test",
		WebSocketImpl: NodeWS,
		startupWaitMs: 3000,
		blobRetryMs: 200,
		profile: () => ({ name: user.name, color: "#8a5cf5" }),
	});
	await engine.start();
	return { user, name, vault, store, engine };
}

/**
 * Someone with no host of their own: joins a share on `server` as a guest and keeps their mount
 * table in a profile space there. Returns the user (rootSpaceId = the profile space).
 */
export async function hostlessGuest(server: RealServer, name: string, inviteLink: string): Promise<User> {
	const { ShareApi, createSpace } = await import("../../src/core/setup");
	const { SpaceKind } = await import("../../src/proto/tezca/v1/sync_pb");
	const id = identityFromSeed(randomBytes(32));
	await new ShareApi(new HostApi(server.url), id).redeemAsGuest(linkParams(inviteLink)!.token);
	const conn = new HostConnection({ host: server.url, identity: id, deviceId: "setup", clientVersion: "test", WebSocketImpl: NodeWS });
	conn.start();
	await waitOnline(conn);
	const profile = await createSpace(conn, id, `${name}'s profile`, SpaceKind.PROFILE);
	conn.stop();
	return { name, id, rootSpaceId: profile.spaceId };
}
