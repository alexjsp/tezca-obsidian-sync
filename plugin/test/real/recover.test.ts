// Offline recovery from a server's data folder and the recovery key (src/recover/recover.ts).
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recoveryKey, seedFromRecovery } from "../../src/core/crypto";
import { recover, type Db } from "../../src/recover/recover";
import { eventually } from "../helpers";
import { claimAdmin, inviteMember, startDevice, startServer, type Device, type RealServer } from "./server";
import { linkParams } from "../../src/core/setup";

let server: RealServer;
let devices: Device[] = [];
beforeEach(async () => {
	server = await startServer();
}, 120_000);
afterEach(async () => {
	await Promise.all(devices.map((d) => d.engine.stop()));
	devices = [];
	await server?.stop();
});

function files(root: string, dir = ""): string[] {
	return readdirSync(join(root, dir)).flatMap((n) => {
		const rel = dir ? `${dir}/${n}` : n;
		return statSync(join(root, rel)).isDirectory() ? files(root, rel) : [rel];
	});
}

async function openDb(dataDir: string): Promise<Db & { close(): void }> {
	process.removeAllListeners("warning");
	const { DatabaseSync } = (await import("node:sqlite")) as unknown as { DatabaseSync: new (f: string, o: { readOnly: boolean }) => Db & { close(): void } };
	return new DatabaseSync(join(dataDir, "tezca.db"), { readOnly: true });
}

describe("offline recovery (real server data)", () => {
	it("rebuilds the vault, its shared folders and attachments from the data folder and the recovery key", async () => {
		const alex = await claimAdmin(server, "Alex");
		const sam = await inviteMember(server, alex, "Sam");
		const a = await startDevice(server, alex, "a");
		devices.push(a);
		const pic = new Uint8Array(5000).map((_, i) => (i * 7) & 0xff);
		const canvas = JSON.stringify({ nodes: [{ id: "n1", type: "text", text: "Card", x: 0, y: 0, width: 100, height: 60 }], edges: [] });
		await a.vault.userWrite("Welcome.md", "# Hello\n\nMy notes.\n");
		await a.vault.userWrite("Projects/Plan.md", "The plan.\n");
		await a.vault.userWriteBinary("Projects/pic.png", pic);
		await a.vault.userWrite("Board.canvas", canvas);
		await a.vault.userWrite("Team/shared.md", "Shared with Sam.\n");
		await a.vault.userWrite("Gone.md", "Deleted later.\n");
		await eventually(() => a.engine.mirror!.index.live().filter((e) => e.kind !== "folder").length === 6, 10_000, "imported");
		const spaceId = await a.engine.shareFolder("Team", "Team");
		await eventually(() => a.engine.shares.has(spaceId), 10_000, "shared");
		await a.vault.remove("Gone.md");
		// Sam has a share mounted somewhere else, and his own notes.
		const s = await startDevice(server, sam, "s");
		devices.push(s);
		const p = linkParams(await a.engine.createInvite(spaceId, "editor"))!;
		await s.engine.joinShare(p.token!, p.k!, async () => "From Alex/Team");
		await s.vault.userWrite("Sam's own.md", "Sam's note.\n");
		await eventually(() => s.vault.files.get("From Alex/Team/shared.md") === "Shared with Sam.\n", 10_000, "Sam joined");
		await a.engine.idle();
		await s.engine.idle();
		await new Promise((r) => setTimeout(r, 500));

		const db = await openDb(server.dataDir);
		try {
			// Alex, using only the recovery key (as the user would type it).
			const out = mkdtempSync(join(tmpdir(), "tezca-recover-"));
			const res = recover({ db, dataDir: server.dataDir, seed: seedFromRecovery(recoveryKey(alex.id.seed).toLowerCase()), outDir: out, includeDeleted: true });
			expect(res.problems).toEqual([]);
			const vault = res.vaults[0].dir;
			expect(files(vault).sort()).toEqual(["Board.canvas", "Projects/Plan.md", "Projects/pic.png", "Recently deleted (Tezca)/Gone.md", "Team/shared.md", "Welcome.md"]);
			expect(readFileSync(join(vault, "Welcome.md"), "utf8")).toBe("# Hello\n\nMy notes.\n");
			expect(new Uint8Array(readFileSync(join(vault, "Projects/pic.png")))).toEqual(pic);
			expect(JSON.parse(readFileSync(join(vault, "Board.canvas"), "utf8")).nodes[0].text).toBe("Card");
			expect(readFileSync(join(vault, "Team/shared.md"), "utf8")).toBe("Shared with Sam.\n");
			// Sam gets his vault, with the share where he mounted it, and nothing of Alex's private notes.
			const out2 = mkdtempSync(join(tmpdir(), "tezca-recover-"));
			const res2 = recover({ db, dataDir: server.dataDir, seed: sam.id.seed, outDir: out2 });
			const sv = files(res2.vaults[0].dir).sort();
			expect(sv).toEqual(["From Alex/Team/shared.md", "Sam's own.md"]);
		} finally {
			db.close();
		}
		// The one-file command, as a user runs it.
		execFileSync("pnpm", ["build:recover"], { cwd: join(import.meta.dirname, "..", ".."), stdio: "ignore" });
		const out3 = join(mkdtempSync(join(tmpdir(), "tezca-recover-")), "restored");
		const stdout = execFileSync("node", [join(import.meta.dirname, "..", "..", "dist", "tezca-recover.mjs"), "--data", server.dataDir, "--out", out3], {
			env: { ...process.env, TEZCA_RECOVERY_KEY: recoveryKey(alex.id.seed) },
			encoding: "utf8",
		});
		expect(stdout).toMatch(/Done: 5 file\(s\)/);
		expect(readFileSync(join(out3, readdirSync(out3)[0], "Welcome.md"), "utf8")).toBe("# Hello\n\nMy notes.\n");
	});
});
