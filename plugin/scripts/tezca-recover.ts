// tezca-recover: rebuild your vaults from a Tezca server's data folder and your recovery key,
// with nothing else running. Needs Node.js 22.13 or newer. Built into one file by
// `pnpm -C plugin build:recover` (dist/tezca-recover.mjs, attached to each release).
//
//   node tezca-recover.mjs --data /mnt/user/appdata/tezca --out ./recovered
//
// Options: --data <server data folder>  --out <where to write>  --include-deleted
// The recovery key (TZCA-…, or a 24-word phrase) is asked for, so it stays out of your shell
// history; or pass --key, or set TEZCA_RECOVERY_KEY.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { initCrypto, seedFromRecovery } from "../src/core/crypto";
import { recover, type Db } from "../src/recover/recover";

function arg(name: string): string | undefined {
	const i = process.argv.indexOf(`--${name}`);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function usage(msg?: string): never {
	if (msg) console.error(`Error: ${msg}\n`);
	console.error(
		"Usage: node tezca-recover.mjs --data <Tezca server data folder> --out <output folder> [--include-deleted] [--key TZCA-…]\n\n" +
			"Rebuilds your synced vaults and shared folders as plain files from the server's data\n" +
			"(the folder with tezca.db and blobs/) and your recovery key. Stop the server, or work on a copy.",
	);
	process.exit(msg ? 1 : 0);
}

async function main() {
	if (process.argv.includes("--help") || process.argv.includes("-h")) usage();
	const dataDir = resolve(arg("data") ?? usage("--data is required"));
	const outDir = resolve(arg("out") ?? usage("--out is required"));
	const dbFile = join(dataDir, "tezca.db");
	if (!existsSync(dbFile)) usage(`no tezca.db in ${dataDir}`);
	if (existsSync(outDir) && readdirSync(outDir).length) usage(`${outDir} isn't empty; choose an empty or new folder`);

	let key = arg("key") ?? process.env.TEZCA_RECOVERY_KEY;
	if (!key) {
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		key = await rl.question("Recovery key (TZCA-…): ");
		rl.close();
	}
	await initCrypto();
	let seed: Uint8Array;
	try {
		seed = seedFromRecovery(key);
	} catch (e) {
		usage((e as Error).message);
	}

	// node:sqlite prints an "experimental" warning; it's fine for reading.
	process.removeAllListeners("warning");
	const { DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (file: string, opts: { readOnly: boolean }) => Db & { close(): void } };
	const db = new DatabaseSync(dbFile, { readOnly: true });
	mkdirSync(outDir, { recursive: true });
	try {
		const res = recover({ db, dataDir, seed, outDir, includeDeleted: process.argv.includes("--include-deleted"), log: (l) => console.log(l) });
		const files = res.vaults.reduce((n, v) => n + v.files, 0);
		console.log(`\nDone: ${files} file(s) in ${res.vaults.length} vault(s)/folder(s), in ${outDir}`);
		if (res.problems.length) {
			console.log(`\n${res.problems.length} problem(s):`);
			for (const p of res.problems) console.log(`  - ${p}`);
		}
	} finally {
		db.close();
	}
}

main().catch((e) => {
	console.error(`Error: ${(e as Error).message}`);
	process.exit(1);
});
