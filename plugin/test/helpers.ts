import { HostConnection } from "../src/core/connection";
import { identityFromSeed, randomBytes, type Identity } from "../src/core/crypto";
import { SyncEngine } from "../src/core/engine";
import { createRootSpace, waitOnline } from "../src/core/setup";
import { MemoryStore } from "../src/core/store";
import { MemoryVault } from "../src/core/vault";
import { MockHost } from "./mock-host";

export interface Client {
	name: string;
	vault: MemoryVault;
	store: MemoryStore;
	engine: SyncEngine;
}

export async function setupHost(): Promise<{ host: MockHost; id: Identity; spaceId: string }> {
	const host = new MockHost();
	const id = identityFromSeed(randomBytes(32));
	host.addUser(id.signPk, id.boxPk);
	const conn = new HostConnection({ host: "http://mock", identity: id, deviceId: "setup", clientVersion: "test", WebSocketImpl: host.WebSocket });
	conn.start();
	await waitOnline(conn);
	const space = await createRootSpace(conn, id, "Test vault");
	conn.stop();
	return { host, id, spaceId: space.spaceId };
}

export async function startClient(
	host: MockHost,
	id: Identity,
	spaceId: string,
	name: string,
	vault = new MemoryVault(),
	store = new MemoryStore(),
	isBound?: (p: string) => boolean,
	startupWaitMs = 3000,
): Promise<Client> {
	const engine = new SyncEngine({
		host: "http://mock",
		identity: id,
		deviceId: name,
		deviceName: name,
		spaceId,
		store,
		vault,
		clientVersion: "test",
		WebSocketImpl: host.WebSocket,
		startupWaitMs,
		isBound,
	});
	await engine.start();
	return { name, vault, store, engine };
}

export async function eventually(fn: () => boolean | Promise<boolean>, timeoutMs = 8000, label = "condition"): Promise<void> {
	const end = Date.now() + timeoutMs;
	for (;;) {
		if (await fn()) return;
		if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
		await new Promise((r) => setTimeout(r, 25));
	}
}

export function snapshotVault(v: MemoryVault): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [p, c] of [...v.files].sort()) if (p.endsWith(".md") && !p.includes("(conflict")) out[p] = c;
	return out;
}

export async function converged(...clients: Client[]): Promise<void> {
	try {
		await convergedInner(clients);
	} catch (e) {
		const detail = clients.map((c) => `${c.name}: ${JSON.stringify(Object.fromEntries(c.vault.files))}`).join("\n");
		throw new Error(`${(e as Error).message}\n${detail}`);
	}
}

async function convergedInner(clients: Client[]): Promise<void> {
	await eventually(
		async () => {
			for (const c of clients) await c.engine.idle();
			const a = JSON.stringify(snapshotVault(clients[0].vault));
			return clients.every((c) => JSON.stringify(snapshotVault(c.vault)) === a);
		},
		10000,
		"convergence",
	);
}
