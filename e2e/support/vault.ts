// Comparing vaults on disk.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Device } from "./device";
import { waitFor } from "./wait";

/** Every file in a vault (relative paths), skipping .trash and (unless `config`) .obsidian. */
export function listFiles(root: string, dir = "", config = false): string[] {
	const out: string[] = [];
	for (const name of readdirSync(join(root, dir))) {
		const rel = dir ? `${dir}/${name}` : name;
		if (!dir && ((name === ".obsidian" && !config) || name === ".trash" || name === ".gitkeep")) continue;
		if (name === ".DS_Store") continue;
		if (statSync(join(root, rel)).isDirectory()) out.push(...listFiles(root, rel, config));
		else out.push(rel);
	}
	return out.sort();
}

/** path → content (binary files as a short hash-like summary). */
export function snapshot(d: Device, under = ""): Record<string, string> {
	const out: Record<string, string> = {};
	for (const f of listFiles(d.vaultPath)) {
		if (under && !f.startsWith(under + "/")) continue;
		const buf = readFileSync(join(d.vaultPath, f));
		out[f] = /\.(md|canvas|txt|json|css)$/.test(f) ? buf.toString("utf8") : `<${buf.length} bytes ${buf.subarray(0, 16).toString("hex")}…${buf.subarray(-16).toString("hex")}>`;
	}
	return out;
}

/** Wait until the devices have the same files with the same contents (optionally under a folder). */
export async function waitConverged(devices: Device[], opts: { timeout?: number; under?: string[] } = {}) {
	let last: Record<string, string>[] = [];
	const snap = (d: Device, i: number) => {
		const s = snapshot(d, opts.under?.[i] ?? "");
		if (!opts.under) return s;
		// Compare relative to each device's folder.
		return Object.fromEntries(Object.entries(s).map(([k, v]) => [k.slice((opts.under![i] ?? "").length + 1), v]));
	};
	await waitFor(
		() => {
			last = devices.map(snap);
			const a = JSON.stringify(last[0]);
			return last.every((s) => JSON.stringify(s) === a);
		},
		{ timeout: opts.timeout ?? 45_000, what: `${devices.map((d) => d.name).join(" and ")} to converge`, detail: () => diff(last, devices) },
	);
	for (const d of devices) await d.waitSynced();
	return last[0];
}

function diff(snaps: Record<string, string>[], devices: Device[]) {
	const keys = new Set(snaps.flatMap((s) => Object.keys(s)));
	const out: Record<string, Record<string, string | null>> = {};
	for (const k of keys) {
		const vals = snaps.map((s) => s[k] ?? null);
		if (vals.every((v) => v === vals[0])) continue;
		out[k] = Object.fromEntries(devices.map((d, i) => [d.name, vals[i]]));
	}
	return out;
}

/** Conflict copies the plugin made (e.g. "x (edited on Mac).md", "x (conflict …).md"). */
export function conflictFiles(d: Device): string[] {
	return listFiles(d.vaultPath, "", true).filter((f) => /\((edited on|conflict)/i.test(f));
}

/** A valid PNG of one colour (w×h), for attachment tests. */
export function png(w: number, h: number, rgb: [number, number, number]): Buffer {
	const crcTable = Array.from({ length: 256 }, (_, n) => {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		return c >>> 0;
	});
	const crc = (b: Buffer) => {
		let c = 0xffffffff;
		for (const x of b) c = crcTable[(c ^ x) & 0xff] ^ (c >>> 8);
		return (c ^ 0xffffffff) >>> 0;
	};
	const chunk = (type: string, data: Buffer) => {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length);
		const td = Buffer.concat([Buffer.from(type), data]);
		const c = Buffer.alloc(4);
		c.writeUInt32BE(crc(td));
		return Buffer.concat([len, td, c]);
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(w, 0);
	ihdr.writeUInt32BE(h, 4);
	ihdr[8] = 8;
	ihdr[9] = 2; // truecolour
	const row = Buffer.concat([Buffer.from([0]), Buffer.from(Array.from({ length: w }, () => rgb).flat())]);
	const raw = Buffer.concat(Array.from({ length: h }, () => row));
	return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
