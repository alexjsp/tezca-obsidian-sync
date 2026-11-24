export interface WaitOptions {
	timeout?: number;
	interval?: number;
	/** What we're waiting for (for the error message). */
	what: string;
	/** Extra state to include in the timeout error. */
	detail?: () => unknown;
}

/** Poll `cond` until it's true; throw a descriptive error on timeout. */
export async function waitFor(cond: () => boolean | Promise<boolean>, opts: WaitOptions): Promise<void> {
	const deadline = Date.now() + (opts.timeout ?? 30_000);
	let lastErr: unknown;
	for (;;) {
		try {
			if (await cond()) return;
			lastErr = undefined;
		} catch (e) {
			lastErr = e;
		}
		if (Date.now() > deadline) {
			let detail = "";
			if (opts.detail) {
				try {
					detail = ` (last: ${JSON.stringify(await opts.detail())?.slice(0, 2000)})`;
				} catch {
					/* ignore */
				}
			}
			throw new Error(`Timed out waiting for ${opts.what}${detail}${lastErr ? `: ${String(lastErr)}` : ""}`);
		}
		await sleep(opts.interval ?? 200);
	}
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
