export class Emitter<T> {
	private fns = new Set<(v: T) => void>();
	on(fn: (v: T) => void): () => void {
		this.fns.add(fn);
		return () => this.fns.delete(fn);
	}
	emit(v: T): void {
		for (const fn of [...this.fns]) {
			try {
				fn(v);
			} catch (e) {
				log.error("listener failed", e);
			}
		}
	}
}

type Level = "debug" | "info" | "warn" | "error";
const order: Record<Level, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export const log = {
	level: "info" as Level,
	prefix: "[tezca]",
	sink: null as null | ((level: Level, args: unknown[]) => void),
	debug: (...a: unknown[]) => emit("debug", a),
	info: (...a: unknown[]) => emit("info", a),
	warn: (...a: unknown[]) => emit("warn", a),
	error: (...a: unknown[]) => emit("error", a),
};

function emit(level: Level, args: unknown[]) {
	if (order[level] < order[log.level]) return;
	if (log.sink) return log.sink(level, args);
	const fn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
	fn(log.prefix, ...args);
}

/** Serialises async work per key. */
export class KeyedQueue {
	private tails = new Map<string, Promise<unknown>>();
	run<T>(key: string, fn: () => Promise<T>): Promise<T> {
		const prev = this.tails.get(key) ?? Promise.resolve();
		const next = prev.then(fn, fn);
		const tail = next.catch(() => undefined);
		this.tails.set(key, tail);
		void tail.then(() => {
			if (this.tails.get(key) === tail) this.tails.delete(key);
		});
		return next;
	}
	idle(): Promise<void> {
		return Promise.all([...this.tails.values()]).then(() => undefined);
	}
}

export function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** Limits how many async tasks run at once. */
export class Semaphore {
	private waiting: (() => void)[] = [];
	private active = 0;
	constructor(private readonly max: number) {}

	async run<T>(fn: () => Promise<T>): Promise<T> {
		if (this.active >= this.max) await new Promise<void>((r) => this.waiting.push(r));
		this.active++;
		try {
			return await fn();
		} finally {
			this.active--;
			this.waiting.shift()?.();
		}
	}
}
