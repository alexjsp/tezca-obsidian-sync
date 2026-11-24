// Headless multi-client simulator: real Go server + N plugin engines on in-memory vaults.
// Randomised edits/renames/deletes/disconnects/offline restarts, then asserts:
//   1. convergence: every client has identical synced Markdown files
//   2. mirror consistency: each client's files equal its CRDT text
//   3. no data loss: every appended token survives unless its file was deleted
//   4. attachments: every version written survives on disk, in a conflict copy, or in history
//
// Usage: pnpm sim [--seed N] [--clients N] [--steps N] [--runs N] [--verbose] [--no-blobs] [--shares]
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import WebSocket from "ws";
import "fake-indexeddb/auto";

import { HostConnection, type WSCtor, type WSLike } from "../../plugin/src/core/connection";
import { bytesFingerprint, identityFromSeed, initCrypto, randomBytes, type Identity } from "../../plugin/src/core/crypto";
import { SyncEngine } from "../../plugin/src/core/engine";
import { contentModel, textOf } from "../../plugin/src/core/mirror";
import { formatCanvas, parseCanvas } from "../../plugin/src/core/canvas";
import { HostApi, createRootSpace, fetchHttp, linkParams, waitOnline, type HttpFn } from "../../plugin/src/core/setup";
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
const NO_BLOBS = args.includes("--no-blobs");
const NO_CANVAS = args.includes("--no-canvas");
/** Two users (C0,C1 = user 0; C2,C3 = user 1). User 0 shares folder "s"; user 1 mounts it at "s". */
const SHARES = args.includes("--shares");
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
	user: number;
	id?: Identity;
	rootSpaceId?: string;
}

function wsFactory(c: SimClient): WSCtor {
	return class extends WebSocket {
		constructor(url: string) {
			super(url);
			c.sockets.add(this);
			this.on("close", () => c.sockets.delete(this));
			// Node's ws throws on close-before-open with no error listener; browsers don't.
			this.on("error", () => undefined);
			if (c.offline) setImmediate(() => this.terminate());
		}
	} as unknown as WSCtor & (new (url: string) => WSLike);
}

/** Blob HTTP that fails while the client is "offline", like its WebSocket. */
function httpFor(c: SimClient): HttpFn {
	return async (req) => {
		if (c.offline) throw new Error("offline");
		return fetchHttp(req);
	};
}

/** Synced files of a client: Markdown as text, others as a fingerprint. */
function snap(c: SimClient): [string, string][] {
	// Local-only files (kept after a delete elsewhere, with a notice) are deliberately not synced.
	const localOnly = new Set(c.engine ? spacesOf(c).flatMap(({ mirror }) => (mirror as unknown as { state: { localOnly: string[] } }).state.localOnly) : []);
	return [...c.vault.files]
		.filter(([p]) => !p.includes("(conflict") && !localOnly.has(p))
		.map(([p, v]): [string, string] => [p, p.endsWith(".md") ? (typeof v === "string" ? v : new TextDecoder().decode(v)) : fp(v)])
		.sort(([a], [b]) => (a < b ? -1 : 1));
}

/** Every mounted space of a client: its mirror, space, and the vault prefix of its paths. */
function spacesOf(c: SimClient) {
	const e = c.engine!;
	return [...(e.root?.mirror ? [e.root] : []), ...e.shares.values()].map((m) => ({ mirror: m.mirror!, space: m.space, prefix: m.mount ? m.mount + "/" : "" }));
}

/** Which other clients a path must match on: the same user's devices, plus everyone for shared paths. */
function peersFor(clients: SimClient[], c: SimClient, path: string): SimClient[] {
	return clients.filter((o) => o.user === c.user || (SHARES && path.startsWith("s/")));
}

function converged(clients: SimClient[]): boolean {
	const snaps = clients.map((c) => new Map(snap(c)));
	for (let i = 0; i < clients.length; i++)
		for (let j = 0; j < clients.length; j++) {
			if (i === j) continue;
			const sameUser = clients[i].user === clients[j].user;
			for (const [p, v] of snaps[i]) {
				if (!sameUser && !(SHARES && p.startsWith("s/"))) continue;
				if (snaps[j].get(p) !== v) return false;
			}
		}
	return true;
}

function fp(v: string | Uint8Array): string {
	return bytesFingerprint(typeof v === "string" ? new TextEncoder().encode(v) : v);
}

async function startEngine(c: SimClient, url: string) {
	c.engine = new SyncEngine({
		host: url,
		identity: c.id!,
		deviceId: c.name,
		deviceName: c.name,
		spaceId: c.rootSpaceId!,
		profile: () => ({ name: `user${c.user}`, color: "#888888" }),
		store: c.store,
		vault: c.vault,
		clientVersion: "sim",
		WebSocketImpl: wsFactory(c),
		startupWaitMs: 4000,
		http: httpFor(c),
		blobRetryMs: 500,
	});
	await c.engine.start();
	c.stopped = false;
}

// ───────────── model for loss checking ─────────────
const tokens = new Map<string, string>(); // token → lineage
const tokenInfo = new Map<string, string>(); // token → op description
const deletedLineages = new Set<string>();
/** Fingerprint → op that wrote it, for every attachment version written. */
const blobsWritten = new Map<string, string>();

/** Canvas card tokens: every card id added must survive unless its canvas was deleted. */
const canvasTokens = new Map<string, string>(); // card id → canvas lineage

function canvasLineage(text: string | Uint8Array | undefined): string | null {
	if (typeof text !== "string") return null;
	try {
		const l = parseCanvas(text).extra.lineage;
		return typeof l === "string" ? l : null;
	} catch {
		return null;
	}
}

function lineageOf(text: string | null | undefined): string | null {
	const m = text?.match(/^lineage:(\w+)/);
	return m ? m[1] : null;
}

// ───────────── one run ─────────────
async function run(seed: number, nClients: number, steps: number, bin: string): Promise<boolean> {
	tokens.clear();
	tokenInfo.clear();
	deletedLineages.clear();
	blobsWritten.clear();
	canvasTokens.clear();
	const rnd = mulberry32(seed);
	const pick = <T>(xs: T[]): T => xs[Math.floor(rnd() * xs.length)];
	const server = await startServer(bin);
	const clients: SimClient[] = [];
	try {
		const api = new HostApi(server.url);
		const makeUser = async (admin: Identity | null) => {
			const id = identityFromSeed(randomBytes(32));
			if (!admin) await api.claim("simcode", id);
			else await api.redeem((await api.createInvite(admin)).token, id);
			const setup = new HostConnection({ host: server.url, identity: id, deviceId: "setup", clientVersion: "sim", WebSocketImpl: WebSocket as unknown as WSCtor });
			setup.start();
			await waitOnline(setup);
			const space = await createRootSpace(setup, id, "sim");
			setup.stop();
			return { id, spaceId: space.spaceId };
		};
		const users = [await makeUser(null)];
		if (SHARES) users.push(await makeUser(users[0].id));

		for (let i = 0; i < nClients; i++) {
			const user = SHARES && i >= nClients / 2 ? 1 : 0;
			const c: SimClient = { name: `C${i}`, vault: new MemoryVault(), store: new MemoryStore(), engine: null, sockets: new Set(), offline: false, stopped: true, user, id: users[user].id, rootSpaceId: users[user].spaceId };
			clients.push(c);
			await startEngine(c, server.url);
		}
		if (SHARES) {
			// User 0 shares "s"; user 1 joins and mounts it at "s" too (so paths compare directly).
			const owner = clients[0];
			await owner.vault.userWrite("s/readme.md", "lineage:Lshare\nshared\n");
			await owner.engine!.idle();
			const sid = await owner.engine!.shareFolder("s", "shared");
			for (let i = 0; i < 100 && !owner.engine!.shares.has(sid); i++) await sleep(50);
			const link = await owner.engine!.createInvite(sid, "editor");
			const p = linkParams(link)!;
			const joiner = clients.find((c) => c.user === 1)!;
			await joiner.engine!.joinShare(p.token, p.k, async () => "s");
			for (let i = 0; i < 200 && !clients.every((c) => c.engine!.shares.has(sid)); i++) await sleep(50);
			if (!clients.every((c) => c.engine!.shares.has(sid))) throw new Error("share setup failed");
		}

		let tok = 0;
		const folders = SHARES ? ["", "a/", "s/", "s/x/"] : ["", "a/", "a/b/", "c/"];
		const mdFiles = (c: SimClient) => [...c.vault.files.keys()].filter((p) => p.endsWith(".md") && !p.includes("(conflict"));
		const binFiles = (c: SimClient) => [...c.vault.files.keys()].filter((p) => !p.endsWith(".md") && !p.includes("(conflict"));
		const randomBlob = (label: string) => {
			const b = new Uint8Array(64 + Math.floor(rnd() * 4000));
			for (let i = 0; i < b.length; i++) b[i] = Math.floor(rnd() * 256);
			blobsWritten.set(bytesFingerprint(b), label);
			return b;
		};
		const ops: string[] = [];
		for (let step = 0; step < steps; step++) {
			const c = pick(clients);
			const files = mdFiles(c);
			const r = rnd();
			let op = "";
			try {
				const bins = NO_BLOBS ? [] : binFiles(c).filter((p) => !p.endsWith(".canvas"));
				const canvases = NO_CANVAS ? [] : [...c.vault.files.keys()].filter((p) => p.endsWith(".canvas") && !p.includes("(conflict"));
				if (!NO_CANVAS && r >= 0.88 && r < 0.9) {
					// Create a canvas, or add a card to one / move a card.
					if (!canvases.length || rnd() < 0.3) {
						const p = `${pick(folders)}board-${Math.floor(rnd() * 8)}.canvas`;
						if (c.vault.files.has(p)) continue;
						const t = `c${tok++}`;
						canvasTokens.set(t, `C${seed}x${step}`);
						await c.vault.userWrite(p, formatCanvas({ nodes: [{ id: t, type: "text", text: t, x: 0, y: 0, width: 100, height: 50 }], edges: [], extra: { lineage: `C${seed}x${step}` } }));
						op = `create canvas ${p}`;
					} else {
						const p = pick(canvases);
						const cur = parseCanvas(c.vault.files.get(p) as string);
						if (rnd() < 0.6 || !cur.nodes.length) {
							const t = `c${tok++}`;
							const lin = typeof cur.extra.lineage === "string" ? cur.extra.lineage : null;
							if (lin) canvasTokens.set(t, lin);
							cur.nodes.push({ id: t, type: "text", text: t, x: step, y: 0, width: 100, height: 50 });
							op = `add card ${t} to ${p}`;
						} else {
							const n = pick(cur.nodes);
							n.x = step;
							op = `move card ${n.id} in ${p}`;
						}
						await c.vault.userWrite(p, formatCanvas(cur));
					}
				} else if (!NO_BLOBS && r >= 0.12 && r < 0.17) {
					const p = `${pick(folders)}img-${Math.floor(rnd() * 15)}.bin`;
					if (c.vault.files.has(p)) continue;
					await c.vault.userWriteBinary(p, randomBlob(`${step} ${c.name}: create ${p}`));
					op = `create blob ${p}`;
				} else if (r >= 0.17 && r < 0.22 && bins.length) {
					const p = pick(bins);
					// Overwriting a version on the same device is the user's choice, not a loss.
					const prior = fp(c.vault.files.get(p)!);
					if (blobsWritten.has(prior)) blobsWritten.set(prior, "superseded");
					await c.vault.userWriteBinary(p, randomBlob(`${step} ${c.name}: modify ${p}`));
					op = `modify blob ${p}`;
				} else if (r >= 0.22 && r < 0.25 && bins.length) {
					const p = pick(bins);
					if (rnd() < 0.5) {
						const to = `${pick(folders)}moved-${step}.bin`;
						if (!c.vault.files.has(to)) await c.vault.rename(p, to);
						op = `rename blob ${p} → ${to}`;
					} else {
						for (const [h] of blobsWritten) if (h === fp(c.vault.files.get(p)!)) blobsWritten.set(h, "deleted");
						await c.vault.remove(p);
						op = `delete blob ${p}`;
					}
				} else if (r < 0.15 || files.length === 0) {
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
					// Moving into/out of a shared folder is copy + delete for the side it left (by design).
					if (SHARES && p.startsWith("s/") !== to.startsWith("s/")) {
						const lin = lineageOf(c.vault.files.get(p) as string);
						if (lin) deletedLineages.add(lin);
					}
					if (!c.vault.files.has(to)) await c.vault.rename(p, to);
					op = `rename ${p} → ${to}`;
				} else if (r < 0.8) {
					const p = pick(files);
					const lin = lineageOf(c.vault.files.get(p) as string);
					if (lin) deletedLineages.add(lin);
					await c.vault.remove(p);
					op = `delete ${p} (lineage ${lin ?? "none"})`;
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
					await startEngine(c, server.url);
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
				if (p.includes("(conflict")) continue;
				const vals = clients.map((c) => {
					const v = c.vault.files.get(p);
					return v === undefined ? undefined : p.endsWith(".md") ? v : fp(v);
				});
				const differs = clients.some((c, i) => peersFor(clients, c, p).some((o) => vals[clients.indexOf(o)] !== vals[i]));
				if (!differs) continue;
				problems.push(`differs ${p}: ` + clients.map((c, i) => `${c.name}=${JSON.stringify(vals[i])}`).join(" "));
				const base = p.split("/").pop()!;
				for (const o of ops) if (o.includes(base)) problems.push(`   op ${o}`);
				for (const c of clients) {
					for (const { mirror, prefix } of spacesOf(c)) {
						const es = mirror.index.all().filter((x) => prefix + x.path === p);
						const st = (mirror as unknown as { state: { baselines: Record<string, unknown>; localOnly: string[] } }).state;
						if (!es.length && !st.localOnly.includes(p)) continue;
						problems.push(`   ${c.name}[${prefix || "root"}] entries: ${JSON.stringify(es.map((x) => ({ id: x.id.slice(0, 6), kind: x.kind, deleted: x.deleted, blob: x.blob?.hash?.slice(0, 8), base: st.baselines[x.id] })))} localOnly=${st.localOnly.includes(p)}`);
					}
				}
				const sp = clients.map((c) => {
					const e = c.engine!.mirror!.index.live().find((x) => x.path === p);
					const seq = e ? c.engine!.space!.localSeq(e.id) : -1n;
					const head = e ? c.engine!.space!.heads.get(e.id) : undefined;
					return `${c.name}:id=${e?.id.slice(0, 6)} seq=${seq} head=${head}`;
				});
				problems.push("   " + sp.join(" "));
			}
		}

		// 2b. attachments: disk equals the entry's current version
		for (const c of clients) {
			for (const { mirror, prefix } of spacesOf(c)) {
				for (const e of mirror.index.live()) {
					if (e.kind !== "blob") continue;
					const disk = c.vault.files.get(prefix + e.path);
					const dh = disk === undefined ? null : fp(disk);
					if (dh !== (e.blob?.hash ?? null)) problems.push(`${c.name}: ${prefix + e.path} disk≠index blob (disk ${dh}, index ${e.blob?.hash})`);
				}
			}
		}
		// 4. no attachment version vanished
		{
			const seen = new Set<string>();
			for (const c of clients) for (const [, v] of c.vault.files) seen.add(fp(v));
			for (const c of clients)
				for (const { mirror } of spacesOf(c))
					for (const e of mirror.index.all()) {
						if (e.kind !== "blob") continue;
						if (e.blob) seen.add(e.blob.hash);
						for (const r of e.prev ?? []) seen.add(r.hash);
					}
			let missing = 0;
			for (const [h, label] of blobsWritten) {
				if (label === "deleted" || label === "superseded" || seen.has(h)) continue;
				if (++missing <= 10) problems.push(`attachment version ${h.slice(0, 8)} lost — written by [${label}]`);
			}
		}

		// 2. mirror consistency
		for (const c of clients) {
			for (const { mirror, space: sp, prefix } of spacesOf(c)) {
				for (const e of mirror.index.live()) {
					if (e.kind !== "md" && e.kind !== "canvas") continue;
					const doc = await sp.acquire(e.id);
					const model = contentModel(e.kind);
					const crdt = model.read(doc);
					sp.release(e.id);
					const disk = c.vault.files.get(prefix + e.path);
					if (typeof disk !== "string" || !model.same(disk, crdt)) problems.push(`${c.name}: ${prefix + e.path} disk≠crdt (disk ${JSON.stringify(disk?.slice(0, 60))}, crdt ${JSON.stringify(crdt.slice(0, 60))})`);
				}
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
		// Where (if anywhere) do lost tokens still exist in a CRDT? (any client, any space, deleted too)
		if (lost) {
			const lostTokens = [...tokens].filter(([t, l]) => !deletedLineages.has(l) && !new RegExp(`(^|\\n)${t}(\\n|$)`).test(union)).map(([t]) => t).slice(0, 3);
			for (const c of clients)
				for (const { mirror, space: sp, prefix } of spacesOf(c))
					for (const e of mirror.index.all()) {
						if (e.kind !== "md") continue;
						const doc = await sp.acquire(e.id);
						const txt = textOf(doc).toString();
						sp.release(e.id);
						for (const t of lostTokens)
							if (new RegExp(`(^|\\n)${t}(\\n|$)`).test(txt))
								problems.push(`  ${t} is in ${c.name} ${prefix}${e.path} (entry ${e.id.slice(0, 6)}, deleted=${e.deleted}, disk=${JSON.stringify(String(c.vault.files.get(prefix + e.path) ?? "<none>").slice(0, 40))})`);
					}
		}
		for (const [t, lin] of canvasTokens) {
			if (deletedLineages.has(lin) || union.includes(`"id":"${t}"`)) continue;
			problems.push(`canvas card ${t} (canvas ${lin}) lost`);
		}
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
				if (lin && lostLins.has(lin)) {
					problems.push(`  lineage ${lin} is entry ${e.id.slice(0, 6)} path=${e.path} deleted=${e.deleted} text=${JSON.stringify(txt.slice(0, 80))}`);
					const names = new Set([e.path.split("/").pop()!]);
					for (const o of ops) if (o.includes(e.path.split("/").pop()!)) for (const m of o.matchAll(/([\w-]+\.md)/g)) names.add(m[1]);
					for (const o of ops) if ([...names].some((n) => o.includes(n))) problems.push(`     op ${o}`);
				}
			}
		}

		if (!ok || problems.length) {
			console.log(`✗ seed ${seed}: ${problems.length} problem(s)`);
			for (const p of problems.slice(0, 80)) console.log("   " + p);
			if (process.env.SIM_ALL_OPS) for (const o of ops) console.log("     " + o);
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
		const snaps = clients.map((c) => JSON.stringify(snap(c)));
		const all = snaps.join("|");
		const same = converged(clients);
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
