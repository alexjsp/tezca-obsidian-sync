// Offline recovery: rebuild a user's vaults from a Tezca server's data folder and their recovery
// key, with no server, Obsidian or plugin running. Used by scripts/tezca-recover.ts.
//
// Reads the server's SQLite database (spaces, wrapped keys, snapshots, updates) and attachment
// files (blobs/<space>/<id[:2]>/<id>), decrypts everything the user is a member of, and writes
// the notes, canvases, attachments and (synced) settings files as plain files.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import * as Y from "yjs";
import { ad, b64u, fromUtf8, identityFromSeed, open, openBlob, unwrapKey, type Identity } from "../core/crypto";
import { IndexModel, type Entry } from "../core/index-model";
import { contentModel } from "../core/mirror";
import { Mounts } from "../core/mounts";

/** SpaceKind values (proto/tezca/v1/sync.proto). */
const ROOT = 1;
const SHARE = 2;
const PROFILE = 3;

/** The few SQLite calls used here (node:sqlite's DatabaseSync). */
export interface Db {
	prepare(sql: string): { all(...params: unknown[]): Record<string, unknown>[] };
}

export interface RecoverOptions {
	db: Db;
	/** The server's data folder (holds blobs/). */
	dataDir: string;
	seed: Uint8Array;
	outDir: string;
	/** Also write deleted notes and files (to "<vault>/Recently deleted (Tezca)/"). */
	includeDeleted?: boolean;
	log?: (line: string) => void;
}

export interface RecoverResult {
	vaults: { name: string; dir: string; files: number }[];
	problems: string[];
}

interface Space {
	id: string;
	kind: number;
	name: string;
	keys: Map<number, Uint8Array>;
}

const bytes = (v: unknown): Uint8Array => (v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer));

export function recover(o: RecoverOptions): RecoverResult {
	const log = o.log ?? (() => undefined);
	const id = identityFromSeed(o.seed);
	const problems: string[] = [];
	const spaces = loadSpaces(o.db, id, problems);
	if (!spaces.length) throw new Error("This recovery key isn't a member of anything on this server (wrong key, or wrong server's data?).");
	log(`Account ${b64u(id.signPk).slice(0, 12)}…: ${spaces.length} space(s) on this server.`);

	const result: RecoverResult = { vaults: [], problems };
	const placed = new Set<string>();
	const usedNames = new Set<string>();
	const folderFor = (name: string) => {
		let base = safeName(name) || "Vault";
		for (let i = 2; usedNames.has(base); i++) base = `${safeName(name) || "Vault"} ${i}`;
		usedNames.add(base);
		return join(o.outDir, base);
	};

	// The user's own vaults (and a guest's profile), with the shares mounted in them.
	for (const sp of spaces.filter((s) => s.kind === ROOT || s.kind === PROFILE)) {
		const dir = folderFor(sp.kind === PROFILE ? `${sp.name} (shared folders)` : sp.name);
		const index = loadDoc(o.db, sp, "index", problems);
		const mounts = new Mounts(index).all();
		let files = sp.kind === ROOT ? writeSpace(o, sp, index, dir, problems, log, mounts.map((m) => m.path)) : 0;
		for (const m of mounts) {
			const share = spaces.find((s) => s.id === m.spaceId);
			if (!share) {
				problems.push(`"${m.path}" is a shared folder on ${m.host ?? "another host"}; its data isn't in this folder.`);
				continue;
			}
			files += writeSpace(o, share, loadDoc(o.db, share, "index", problems), safeJoin(dir, m.path), problems, log);
			placed.add(share.id);
		}
		index.destroy();
		result.vaults.push({ name: sp.name, dir, files });
	}
	// Shared folders not mounted in any of the user's vaults.
	for (const sp of spaces.filter((s) => s.kind === SHARE && !placed.has(s.id))) {
		const dir = safeJoin(join(o.outDir, "Shared folders"), safeName(sp.name) || sp.id);
		const index = loadDoc(o.db, sp, "index", problems);
		result.vaults.push({ name: sp.name, dir, files: writeSpace(o, sp, index, dir, problems, log) });
		index.destroy();
	}
	return result;
}

function loadSpaces(db: Db, id: Identity, problems: string[]): Space[] {
	const rows = db
		.prepare(`SELECT s.space_id, s.kind, s.meta, s.meta_epoch FROM spaces s JOIN members m ON m.space_id = s.space_id WHERE m.sign_pk = ?`)
		.all(id.signPk);
	const out: Space[] = [];
	for (const r of rows) {
		const spaceId = String(r.space_id);
		const keys = new Map<number, Uint8Array>();
		for (const k of db.prepare(`SELECT epoch, wrapped FROM space_keys WHERE space_id = ? AND sign_pk = ?`).all(spaceId, id.signPk)) {
			try {
				keys.set(Number(k.epoch), unwrapKey(bytes(k.wrapped), id));
			} catch {
				problems.push(`Couldn't unwrap key ${k.epoch} of space ${spaceId}.`);
			}
		}
		let name = spaceId;
		try {
			const me = Number(r.meta_epoch);
			name = (JSON.parse(fromUtf8(open(keys.get(me)!, bytes(r.meta), ad.meta(spaceId, me)))) as { name?: string }).name || spaceId;
		} catch {
			/* keep the id */
		}
		out.push({ id: spaceId, kind: Number(r.kind), name, keys });
	}
	return out;
}

/** A doc's current state: its latest snapshot plus the updates after it. */
function loadDoc(db: Db, sp: Space, docId: string, problems: string[]): Y.Doc {
	const doc = new Y.Doc();
	const snap = db.prepare(`SELECT base_seq, epoch, payload FROM snapshots WHERE space_id = ? AND doc_id = ? ORDER BY base_seq DESC LIMIT 1`).all(sp.id, docId)[0];
	let base = 0;
	if (snap) {
		try {
			const e = Number(snap.epoch);
			Y.applyUpdate(doc, open(sp.keys.get(e)!, bytes(snap.payload), ad.snapshot(sp.id, docId, e)));
			base = Number(snap.base_seq);
		} catch {
			problems.push(`Couldn't read the saved state of ${docId} in "${sp.name}"; rebuilding from its edit log.`);
		}
	}
	for (const u of db.prepare(`SELECT seq, epoch, payload FROM updates WHERE space_id = ? AND doc_id = ? AND seq > ? ORDER BY seq`).all(sp.id, docId, base)) {
		try {
			const e = Number(u.epoch);
			Y.applyUpdate(doc, open(sp.keys.get(e)!, bytes(u.payload), ad.update(sp.id, docId, e)));
		} catch {
			problems.push(`Skipped an edit (${u.seq}) of ${docId} in "${sp.name}" that couldn't be decrypted.`);
		}
	}
	return doc;
}

function writeSpace(o: RecoverOptions, sp: Space, indexDoc: Y.Doc, dir: string, problems: string[], log: (l: string) => void, mountPaths: string[] = []): number {
	const index = new IndexModel(indexDoc);
	const { byPath } = index.resolvePaths();
	let n = 0;
	const write = (e: Entry, root: string) => {
		const target = safeJoin(root, e.path);
		if (!target) {
			problems.push(`Skipped "${e.path}" in "${sp.name}": not a safe path.`);
			return;
		}
		const data = content(o, sp, e, problems);
		if (data === null) return;
		mkdirSync(dirname(target), { recursive: true });
		writeFileSync(target, data);
		n++;
	};
	for (const e of byPath.values()) {
		if (e.kind === "folder") {
			const d = safeJoin(dir, e.path);
			if (d) mkdirSync(d, { recursive: true });
		} else write(e, dir);
	}
	if (o.includeDeleted) {
		// Files that moved into a shared folder are recorded as deleted here; the share has them.
		const inMount = (p: string) => mountPaths.some((m) => p === m || p.startsWith(m + "/"));
		for (const e of index.all().filter((x) => x.deleted && x.kind !== "folder" && !inMount(x.path))) write(e, join(dir, "Recently deleted (Tezca)"));
	}
	log(`  ${sp.name}: ${n} file(s) → ${dir}`);
	return n;
}

function content(o: RecoverOptions, sp: Space, e: Entry, problems: string[]): Uint8Array | string | null {
	if (e.kind === "blob") {
		const ref = e.blob;
		if (!ref) {
			problems.push(`"${e.path}" in "${sp.name}" was never fully uploaded.`);
			return null;
		}
		const file = join(o.dataDir, "blobs", sp.id, ref.id.slice(0, 2), ref.id);
		if (!existsSync(file)) {
			problems.push(`"${e.path}" in "${sp.name}": its attachment file is missing (${file}).`);
			return null;
		}
		try {
			return openBlob(sp.keys.get(ref.epoch)!, sp.id, ref.id, ref.epoch, readFileSync(file));
		} catch {
			problems.push(`"${e.path}" in "${sp.name}": its attachment couldn't be decrypted.`);
			return null;
		}
	}
	const doc = loadDoc(o.db, sp, e.id, problems);
	try {
		return contentModel(e.kind).read({ ydoc: doc } as Parameters<ReturnType<typeof contentModel>["read"]>[0]); // reads only .ydoc
	} finally {
		doc.destroy();
	}
}

function safeName(name: string): string {
	// eslint-disable-next-line no-control-regex
	return name.replace(/[/\\:*?"<>|\x00-\x1f]+/g, "-").replace(/^[.\s]+/, "").trim();
}

/** `root/rel`, or "" if `rel` would escape `root` (absolute, "..", backslashes…). */
function safeJoin(root: string, rel: string): string {
	// eslint-disable-next-line no-control-regex
	if (!rel || rel.startsWith("/") || /[\\\x00-\x1f]/.test(rel) || rel.split("/").some((s) => s === ".." || s === ".")) return "";
	const full = resolve(root, rel);
	return full === resolve(root) || full.startsWith(resolve(root) + sep) ? full : "";
}
