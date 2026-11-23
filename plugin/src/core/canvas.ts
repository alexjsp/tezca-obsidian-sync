// Live Canvas: a .canvas file (JSON Canvas: {nodes, edges, ...}) held in a Y.Doc so concurrent edits
// merge per node and per field (text cards merge character by character).
//
// CRDT layout (root map "canvas"):
//   nodes:  Y.Map<id, Y.Map<field, JSON value | Y.Text for "text">>
//   edges:  Y.Map<id, Y.Map<field, JSON value>>
//   nodeOrder / edgeOrder: Y.Array<id> (z-order / file order)
//   extra:  Y.Map<key, JSON value> for any other top-level keys
import * as Y from "yjs";
import { applyTextDiff, threeWayMerge } from "./text-diff";

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
type Item = { id: string; [k: string]: Json };
interface CanvasData {
	nodes: Item[];
	edges: Item[];
	extra: Record<string, Json>;
}

const ROOT = "canvas";

function root(doc: Y.Doc) {
	return doc.getMap<unknown>(ROOT);
}

function sub<T>(m: Y.Map<unknown>, key: string, make: () => T): T {
	let v = m.get(key) as T | undefined;
	if (!v) {
		v = make();
		m.set(key, v);
	}
	return v;
}

/** Parse canvas JSON; throws on anything that isn't a JSON Canvas object. */
export function parseCanvas(text: string): CanvasData {
	const raw = text.trim() === "" ? {} : (JSON.parse(text) as Record<string, Json>);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new Error("not a canvas");
	const items = (v: Json | undefined): Item[] =>
		Array.isArray(v) ? (v.filter((x) => x && typeof x === "object" && !Array.isArray(x) && typeof (x as Item).id === "string") as Item[]) : [];
	const extra: Record<string, Json> = {};
	for (const [k, v] of Object.entries(raw)) if (k !== "nodes" && k !== "edges") extra[k] = v;
	return { nodes: items(raw.nodes), edges: items(raw.edges), extra };
}

/** Serialise like Obsidian does: one node/edge per line, tab-indented. */
export function formatCanvas(c: CanvasData): string {
	const line = (items: Item[]) => items.map((i) => `\t\t${JSON.stringify(i)}`).join(",\n");
	const parts = [`\t"nodes":[\n${line(c.nodes)}\n\t]`, `\t"edges":[\n${line(c.edges)}\n\t]`];
	for (const [k, v] of Object.entries(c.extra)) parts.push(`\t${JSON.stringify(k)}:${JSON.stringify(v)}`);
	return `{\n${parts.join(",\n")}\n}`;
}

function readItems(map: Y.Map<unknown> | undefined, order: Y.Array<string> | undefined): Item[] {
	if (!map) return [];
	const ids = order ? order.toArray().filter((id, i, a) => map.has(id) && a.indexOf(id) === i) : [];
	const rest = [...map.keys()].filter((id) => !ids.includes(id)).sort();
	return [...ids, ...rest].map((id) => {
		const m = map.get(id) as Y.Map<unknown>;
		const out: Item = { id };
		for (const [k, v] of m.entries()) {
			if (k === "id") continue;
			out[k] = v instanceof Y.Text ? v.toString() : (v as Json);
		}
		return out;
	});
}

/** The canvas held in a doc. */
export function readCanvas(doc: Y.Doc): CanvasData {
	const r = root(doc);
	const extra: Record<string, Json> = {};
	const ex = r.get("extra") as Y.Map<Json> | undefined;
	ex?.forEach((v, k) => (extra[k] = v));
	return {
		nodes: readItems(r.get("nodes") as Y.Map<unknown> | undefined, r.get("nodeOrder") as Y.Array<string> | undefined),
		edges: readItems(r.get("edges") as Y.Map<unknown> | undefined, r.get("edgeOrder") as Y.Array<string> | undefined),
		extra,
	};
}

export function canvasText(doc: Y.Doc): string {
	return formatCanvas(readCanvas(doc));
}

const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Do two canvas texts hold the same canvas (ignoring formatting)? */
export function sameCanvas(a: string, b: string): boolean {
	if (a === b) return true;
	try {
		return eq(parseCanvas(a), parseCanvas(b));
	} catch {
		return false;
	}
}

function applyItems(
	parent: Y.Map<unknown>,
	mapKey: string,
	orderKey: string,
	base: Item[] | null,
	next: Item[],
) {
	const map = sub(parent, mapKey, () => new Y.Map<unknown>());
	const order = sub(parent, orderKey, () => new Y.Array<string>());
	const baseById = new Map((base ?? []).map((i) => [i.id, i]));
	const nextIds = new Set(next.map((i) => i.id));
	// Removed since base (or, without a base, anything not in next).
	const removed = base ? [...baseById.keys()].filter((id) => !nextIds.has(id)) : [...map.keys()].filter((id) => !nextIds.has(id));
	for (const id of removed) map.delete(id);
	for (const item of next) {
		const b = baseById.get(item.id);
		let m = map.get(item.id) as Y.Map<unknown> | undefined;
		if (!m) {
			m = new Y.Map<unknown>();
			map.set(item.id, m);
		}
		const fields = new Set([...Object.keys(item), ...(b ? Object.keys(b) : [...m.keys()])]);
		for (const k of fields) {
			if (k === "id") continue;
			const nv = item[k];
			if (b && k in b && eq(b[k], nv)) continue; // unchanged locally: keep whatever the CRDT has
			if (nv === undefined) {
				m.delete(k);
				continue;
			}
			if (k === "text" && typeof nv === "string") {
				let t = m.get(k);
				if (!(t instanceof Y.Text)) {
					t = new Y.Text();
					m.set(k, t);
				}
				const bt = b && typeof b[k] === "string" ? (b[k] as string) : null;
				// Merge our edit onto the card's current text, so a concurrent edit to the same card survives.
				const target = bt !== null ? threeWayMerge(bt, nv, (t as Y.Text).toString()).text : nv;
				applyTextDiff(t as Y.Text, target, null);
				continue;
			}
			if (!eq(m.get(k), nv)) m.set(k, nv);
		}
	}
	// Order: follow next, keeping ids only the CRDT has (added elsewhere) where they were.
	const want = next.map((i) => i.id);
	const cur = order.toArray();
	const keep = cur.filter((id) => map.has(id) && !nextIds.has(id));
	const merged = [...want, ...keep];
	if (!eq(cur, merged)) {
		order.delete(0, order.length);
		order.insert(0, merged);
	}
}

/**
 * Bring the doc in line with `next` (a canvas file's text). With `base` (the last synced text),
 * only what changed between base and next is applied, so concurrent remote changes survive.
 * Throws if `next` isn't valid canvas JSON.
 */
export function applyCanvas(doc: Y.Doc, base: string | null, next: string, origin: unknown): void {
	const n = parseCanvas(next);
	let b: CanvasData | null = null;
	if (base !== null) {
		try {
			b = parseCanvas(base);
		} catch {
			b = null;
		}
	}
	doc.transact(() => {
		const r = root(doc);
		applyItems(r, "nodes", "nodeOrder", b?.nodes ?? null, n.nodes);
		applyItems(r, "edges", "edgeOrder", b?.edges ?? null, n.edges);
		const ex = sub(r, "extra", () => new Y.Map<Json>()) as Y.Map<Json>;
		for (const [k, v] of Object.entries(n.extra)) if (!(b && eq(b.extra[k], v)) && !eq(ex.get(k), v)) ex.set(k, v);
		for (const k of [...ex.keys()]) if (!(k in n.extra) && (!b || k in b.extra)) ex.delete(k);
	}, origin);
}
