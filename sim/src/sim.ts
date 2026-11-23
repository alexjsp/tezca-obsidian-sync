// Headless multi-client simulator: real Go server + N plugin engines on in-memory vaults.
// Randomised edits/renames/deletes/disconnects/offline restarts, then asserts:
//   1. convergence: every client has identical synced Markdown files
//   2. mirror consistency: each client's files equal its CRDT text
//   3. no data loss: every appended token survives unless its file was deleted
//
// Usage: pnpm sim [--seed N] [--clients N] [--steps N] [--runs N] [--verbose]
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import WebSocket from "ws";
import "fake-indexeddb/auto";

import { HostConnection, type WSCtor, type WSLike } from "../../plugin/src/core/connection";
import { identityFromSeed, initCrypto, randomBytes, type Identity } from "../../plugin/src/core/crypto";
import { SyncEngine } from "../../plugin/src/core/engine";
import { textOf } from "../../plugin/src/core/mirror";
import { HostApi, createRootSpace, waitOnline } from "../../plugin/src/core/setup";
import { MemoryStore } from "../../plugin/src/core/store";
import { log } from "../../plugin/src/core/util";
import { MemoryVault } from "../../plugin/src/core/vault";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const args = process.argv.slice(2);
const arg = (name: string, def: number) => {
	const i = args.indexOf(`--${name}`);
	return i >= 0 ? Number(args[i + 1]) : def;
};
const VERBOSE = args.includes("--verbose");
log.level = VERBOSE ? "info" : "error";

// ───────────── PRNG ─────────────
function mulberry32(a: number) {
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

// ───────────── server ─────────────
async function freePort(): Promise<number> {
	return new Promise((res) => {
		const s = createServer();
		s.listen(0, "127.0.0.1", () => {
			const p = (s.address() as { port: number }).port;
			s.close(() => res(p));
		});
	});
}

function buildServer(): string {
	const out = join(root, "sim", ".runs", "tezca-server");
	execFileSync("go", ["build", "-o", out, "./cmd/tezca-server"], { cwd: join(root, "server"), stdio: "inherit" });
	return out;
}

async function startServer(bin: string): Promise<{ url: string; proc: ChildProcess; dir: string }> {
	const port = await freePort();
	const dir = mkdtempSync(join(tmpdir(), "tezca-sim-"));
	const url = `http://127.0.0.1:${port}`;
	const proc = spawn(bin, [], {
		env: { ...process.env, TEZCA_DATA_DIR: dir, TEZCA_LISTEN: `127.0.0.1:${port}`, TEZCA_CLAIM_CODE: "simcode", TEZCA_PUBLIC_URL: url },
		stdio: VERBOSE ? "inherit" : "ignore",
	});
	for (let i = 0; i < 100; i++) {
		try {
			if ((await fetch(url + "/healthz")).ok) return { url, proc, dir };
		} catch {
			/* not up yet */
		}
		await sleep(50);
	}
	throw new Error("server did not start");
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ───────────── clients ─────────────
interface SimClient {
	name: string;
	vault: MemoryVault;
	store: MemoryStore;
	engine: SyncEngine | null;
	sockets: Set<WebSocket>;
	offline: boolean; // network cut
	stopped: boolean; // plugin not running
}

function wsFactory(c: SimClient): WSCtor {
	return class extends WebSocket {
		constructor(url: string) {
			super(url);
			c.sockets.add(this);
			this.on("close", () => c.sockets.delete(this));
			if (c.offline) setImmediate(() => this.terminate());
		}
	} as unknown as WSCtor & (new (url: string) => WSLike);
}

async function startEngine(c: SimClient, url: string, id: Identity, spaceId: string) {
	c.engine = new SyncEngine({
		host: url,
		identity: id,
		deviceId: c.name,
		deviceName: c.name,
		spaceId,
		store: c.store,
		vault: c.vault,
		clientVersion: "sim",
		WebSocketImpl: wsFactory(c),
		startupWaitMs: 4000,
	});
	await c.engine.start();
	c.stopped = false;
}

// ───────────── model for loss checking ─────────────
const tokens = new Map<string, string>(); // token → lineage
const tokenInfo = new Map<string, string>(); // token → op description
const deletedLineages = new Set<string>();

function lineageOf(text: string | null | undefined): string | null {
	const m = text?.match(/^lineage:(\w+)/);
	return m ? m[1] : null;
}

// ───────────── one run ─────────────
async function run(seed: number, nClients: number, steps: number, bin: string): Promise<boolean> {
	tokens.clear();
	tokenInfo.clear();
	deletedLineages.clear();
	const rnd = mulberry32(seed);
	const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
	const server = await startServer(bin);
	const clients: SimClient[] = [];
	try {
		const id = identityFromSeed(randomBytes(32));
		await new HostApi(server.url).claim("simcode", id);
		const setup = new HostConnection({ host: server.url, identity: id, deviceId: "setup", clientVersion: "sim", WebSocketImpl: WebSocket as unknown as WSCtor });
		setup.start();
		await waitOnline(setup);
		const space = await createRootSpace(setup, id, "sim");
		setup.stop();

		for (let i = 0; i < nClients; i++) {
			const c: SimClient = { name: `C${i}`, vault: new MemoryVault(), store: new MemoryStore(), engine: null, sockets: new Set(), offline: false, stopped: true };
			clients.push(c);
			await startEngine(c, server.url, id, space.spaceId);
		}

		let tok = 0;
		const folders = ["", "a/", "a/b/", "c/"];
		const mdFiles = (c: SimClient) => [...c.vault.files.keys()].filter((p) => p.endsWith(".md") && !p.includes("(conflict"));
		const ops: string[] = [];
		for (let step = 0; step < steps; step++) {
			const c = pick(clients);
			const files = mdFiles(c);
			const r = rnd();
			let op = "";
			try {
				if (r < 0.15 || files.length === 0) {
					const lin = `L${seed}x${step}`;
					const p = `${pick(folders)}note-${Math.floor(rnd() * 40)}.md`;
					if (c.vault.files.has(p)) continue;
					const t = `t${tok++}`;
					tokens.set(t, lin);
					await c.vault.userWrite(p, `lineage:${lin}\n${t}\n`);
					op = `create ${p}`;
				} else if (r < 0.6) {
					const p = pick(files);
					const cur = c.vault.files.get(p)!;
					const lin = lineageOf(cur);
					const t = `t${tok++}`;
					if (lin) tokens.set(t, lin);
					await c.vault.userWrite(p, cur + `${t}\n`);
					op = `append ${p} ${t}`;
				} else if (r < 0.7) {
					const p = pick(files);
					const cur = c.vault.files.get(p)!;
					const lines = cur.split("\n");
					if (lines.length > 3) {
						const i = 1 + Math.floor(rnd() * (lines.length - 2));
						lines.splice(i, 0, `inserted-${step}`);
						await c.vault.userWrite(p, lines.join("\n"));
					}
					op = `insert ${p}`;
				} else if (r < 0.77) {
					const p = pick(files);
					const to = `${pick(folders)}renamed-${step}.md`;
					if (!c.vault.files.has(to)) await c.vault.rename(p, to);
					op = `rename ${p} → ${to}`;
				} else if (r < 0.8) {
					const p = pick(files);
					const lin = lineageOf(c.vault.files.get(p));
					if (lin) deletedLineages.add(lin);
					await c.vault.remove(p);
					op = `delete ${p}`;
				} else if (r < 0.88) {
					c.offline = !c.offline;
					for (const s of c.sockets) s.terminate();
					if (!c.offline) c.engine?.conn.reconnectNow();
					op = c.offline ? "go offline" : "go online";
				} else if (r < 0.93 && !c.stopped) {
					// Restart the plugin, editing the vault while it is "closed".
					await c.engine!.stop();
					c.stopped = true;
					const fs = mdFiles(c);
					if (fs.length) {
						const p = pick(fs);
						const t = `t${tok++}`;
						const lin = lineageOf(c.vault.files.get(p));
						if (lin) tokens.set(t, lin);
						c.vault.files.set(p, c.vault.files.get(p)! + `${t}\n`);
					}
					await startEngine(c, server.url, id, space.spaceId);
					op = "restart with offline edit";
				} else {
					await sleep(Math.floor(rnd() * 200));
					op = "pause";
				}
			} catch (e) {
				op += ` (failed: ${(e as Error).message})`;
			}
			ops.push(`${step} ${c.name}: ${op}`);
			for (const t of tokens.keys()) if (!tokenInfo.has(t)) tokenInfo.set(t, `${step} ${c.name}: ${op}`);
			if (VERBOSE) console.log(ops[ops.length - 1]);
			await sleep(Math.floor(rnd() * 30));
		}

		// Heal: everyone online, wait for quiescence.
		for (const c of clients) {
			c.offline = false;
			c.engine?.conn.reconnectNow();
		}
		const ok = await quiesce(clients);
		const problems: string[] = [];
		if (!ok) {
			problems.push("did not converge within timeout");
			problems.push("conn: " + clients.map((c) => `${c.name}=${c.engine!.conn.status}`).join(" "));
			const paths = new Set(clients.flatMap((c) => [...c.vault.files.keys()]));
			for (const p of [...paths].sort()) {
				if (!p.endsWith(".md") || p.includes("(conflict")) continue;
				const vals = clients.map((c) => c.vault.files.get(p));
				if (vals.every((v) => v === vals[0])) continue;
				problems.push(`differs ${p}: ` + clients.map((c, i) => `${c.name}=${JSON.stringify(vals[i])}`).join(" "));
				const sp = clients.map((c) => {
					const e = c.engine!.mirror!.index.live().find((x) => x.path === p);
					const seq = e ? c.engine!.space!.localSeq(e.id) : -1n;
					const head = e ? c.engine!.space!.heads.get(e.id) : undefined;
					return `${c.name}:id=${e?.id.slice(0, 6)} seq=${seq} head=${head}`;
				});
				problems.push("   " + sp.join(" "));
			}
		}

		// 2. mirror consistency
		for (const c of clients) {
			const sp = c.engine!.space!;
			const mirror = c.engine!.mirror!;
			for (const e of mirror.index.live()) {
				if (e.kind !== "md") continue;
				const doc = await sp.acquire(e.id);
				const crdt = textOf(doc).toString();
				sp.release(e.id);
				const disk = c.vault.files.get(e.path);
				if (disk !== crdt) problems.push(`${c.name}: ${e.path} disk≠crdt (disk ${JSON.stringify(disk?.slice(0, 60))}, crdt ${JSON.stringify(crdt.slice(0, 60))})`);
			}
		}
		// 3. no data loss
		const union = clients.flatMap((c) => [...c.vault.files.values()]).join("\n");
		let lost = 0;
		for (const [t, lin] of tokens) {
			if (deletedLineages.has(lin)) continue;
			if (!new RegExp(`(^|\\n)${t}(\\n|$)`).test(union)) {
				lost++;
				if (lost <= 10) problems.push(`token ${t} (lineage ${lin}) lost — added by [${tokenInfo.get(t)}]`);
			}
		}
		if (lost > 10) problems.push(`… ${lost} tokens lost in total`);
		if (lost) {
			const lostLins = new Set([...tokens].filter(([t, l]) => !deletedLineages.has(l) && !new RegExp(`(^|\\n)${t}(\\n|$)`).test(union)).map(([, l]) => l));
			const c = clients[0];
			const sp = c.engine!.space!;
			for (const e of c.engine!.mirror!.index.all()) {
				if (e.kind !== "md") continue;
				const doc = await sp.acquire(e.id);
				const txt = textOf(doc).toString();
				sp.release(e.id);
				const lin = lineageOf(txt);
				if (lin && lostLins.has(lin)) problems.push(`  lineage ${lin} is entry ${e.id.slice(0, 6)} path=${e.path} deleted=${e.deleted} text=${JSON.stringify(txt.slice(0, 80))}`);
			}
		}

		if (!ok || problems.length) {
			console.log(`✗ seed ${seed}: ${problems.length} problem(s)`);
			for (const p of problems.slice(0, 20)) console.log("   " + p);
			if (!VERBOSE) {
				console.log("   last ops:");
				for (const o of ops.slice(-15)) console.log("     " + o);
			}
			for (const c of clients) console.log(`   ${c.name}: ${JSON.stringify(Object.keys(Object.fromEntries(c.vault.files)).sort())}`);
			return false;
		}
		const fileCount = mdFiles(clients[0]).length;
		console.log(`✓ seed ${seed}: ${clients.length} clients, ${steps} steps, ${fileCount} files, ${tokens.size} tokens`);
		return true;
	} finally {
		for (const c of clients) await c.engine?.stop().catch(() => undefined);
		server.proc.kill("SIGTERM");
		await sleep(100);
		rmSync(server.dir, { recursive: true, force: true });
	}
}

async function quiesce(clients: SimClient[]): Promise<boolean> {
	const deadline = Date.now() + 60_000;
	let stableSince = 0;
	let last = "";
	while (Date.now() < deadline) {
		await Promise.all(clients.map((c) => c.engine!.idle()));
		const snaps = clients.map((c) =>
			JSON.stringify([...c.vault.files].filter(([p]) => p.endsWith(".md") && !p.includes("(conflict")).sort()),
		);
		const all = snaps.join("|");
		const same = snaps.every((s) => s === snaps[0]);
		const online = clients.every((c) => c.engine!.conn.status === "online");
		if (same && online && all === last) {
			if (!stableSince) stableSince = Date.now();
			if (Date.now() - stableSince > 1500) return true;
		} else stableSince = 0;
		last = all;
		await sleep(100);
	}
	return false;
}

await initCrypto();
const bin = buildServer();
const seed0 = arg("seed", Date.now() % 100000);
const runs = arg("runs", 1);
let failed = 0;
for (let i = 0; i < runs; i++) if (!(await run(seed0 + i, arg("clients", 3), arg("steps", 150), bin))) failed++;
console.log(failed ? `${failed}/${runs} runs failed` : `all ${runs} runs passed`);
process.exit(failed ? 1 : 0);
