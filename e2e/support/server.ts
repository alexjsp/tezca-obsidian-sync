// A fresh Tezca server (empty database) per spec file, on a free local port.
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const CLAIM_CODE = "e2ecode";
const root = resolve(import.meta.dirname, "..", "..");
const bin = join(root, "sim", ".runs", "tezca-server-e2e");
let built = false;

function build() {
	if (built || process.env.E2E_SKIP_SERVER_BUILD) return;
	execFileSync("go", ["build", "-o", bin, "./cmd/tezca-server"], { cwd: join(root, "server"), stdio: "inherit" });
	built = true;
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

export class TezcaServer {
	private constructor(
		readonly url: string,
		private proc: ChildProcess,
		private readonly dir: string,
		readonly env: Record<string, string>,
	) {}

	static async start(extraEnv: Record<string, string> = {}): Promise<TezcaServer> {
		build();
		const port = await freePort();
		const dir = mkdtempSync(join(tmpdir(), "tezca-e2e-"));
		const url = `http://127.0.0.1:${port}`;
		const env = { TEZCA_DATA_DIR: dir, TEZCA_LISTEN: `127.0.0.1:${port}`, TEZCA_CLAIM_CODE: CLAIM_CODE, TEZCA_PUBLIC_URL: url, ...extraEnv };
		const proc = spawn(bin, [], { env: { ...process.env, ...env }, stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore" });
		const s = new TezcaServer(url, proc, dir, env);
		await s.waitHealthy();
		return s;
	}

	private async waitHealthy() {
		for (let i = 0; i < 200; i++) {
			try {
				if ((await fetch(this.url + "/healthz")).ok) return;
			} catch {
				/* not up yet */
			}
			await new Promise((r) => setTimeout(r, 50));
		}
		throw new Error("server didn't start");
	}

	get claimLink(): string {
		return `obsidian://tezca?do=claim&host=${encodeURIComponent(this.url)}&code=${CLAIM_CODE}`;
	}

	/** Start the server again on the same port and data (after `kill`). */
	async restart() {
		this.proc = spawn(bin, [], { env: { ...process.env, ...this.env }, stdio: process.env.E2E_VERBOSE ? "inherit" : "ignore" });
		await this.waitHealthy();
	}

	/** Stop the server process (data is kept, so `restart` resumes where it left off). */
	async kill() {
		if (this.proc.exitCode !== null) return;
		const exited = new Promise((r) => this.proc.once("exit", r));
		this.proc.kill("SIGTERM");
		await exited;
	}

	async stop() {
		await this.kill();
		rmSync(this.dir, { recursive: true, force: true });
	}
}
