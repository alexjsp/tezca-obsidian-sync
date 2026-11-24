// Local persistence. IndexedDB in Obsidian (desktop + mobile), in-memory for tests/simulator.
import { openDB, type IDBPDatabase } from "idb";

export interface DocRecord {
	/** Full Yjs state (encodeStateAsUpdate) */
	state: Uint8Array;
	/** Highest server seq integrated into `state` (decimal string, u64). */
	lastSeq: string;
	/** Local Yjs updates not yet acknowledged by the server. */
	pending: Uint8Array[];
	/** Newest key epoch of any update integrated (updates under older epochs are refused after it). */
	maxEpoch?: number;
}

export interface LocalStore {
	getDoc(key: string): Promise<DocRecord | undefined>;
	putDoc(key: string, rec: DocRecord): Promise<void>;
	deleteDoc(key: string): Promise<void>;
	listDocKeys(prefix: string): Promise<string[]>;
	get<T>(key: string): Promise<T | undefined>;
	put<T>(key: string, value: T): Promise<void>;
	delete(key: string): Promise<void>;
	close(): void;
}

export class MemoryStore implements LocalStore {
	docs = new Map<string, DocRecord>();
	kv = new Map<string, unknown>();
	async getDoc(key: string) {
		const r = this.docs.get(key);
		return r ? structuredClone(r) : undefined;
	}
	async putDoc(key: string, rec: DocRecord) {
		this.docs.set(key, structuredClone(rec));
	}
	async deleteDoc(key: string) {
		this.docs.delete(key);
	}
	async listDocKeys(prefix: string) {
		return [...this.docs.keys()].filter((k) => k.startsWith(prefix));
	}
	async get<T>(key: string) {
		const v = this.kv.get(key);
		return v === undefined ? undefined : (structuredClone(v) as T);
	}
	async put<T>(key: string, value: T) {
		this.kv.set(key, structuredClone(value));
	}
	async delete(key: string) {
		this.kv.delete(key);
	}
	close() {}
}

export class IdbStore implements LocalStore {
	private constructor(private db: IDBPDatabase) {}

	static async open(name: string): Promise<IdbStore> {
		const db = await openDB(name, 1, {
			upgrade(db) {
				db.createObjectStore("docs");
				db.createObjectStore("kv");
			},
		});
		return new IdbStore(db);
	}

	getDoc(key: string) {
		return this.db.get("docs", key) as Promise<DocRecord | undefined>;
	}
	async putDoc(key: string, rec: DocRecord) {
		await this.db.put("docs", rec, key);
	}
	async deleteDoc(key: string) {
		await this.db.delete("docs", key);
	}
	async listDocKeys(prefix: string) {
		const range = IDBKeyRange.bound(prefix, prefix + "￿");
		return (await this.db.getAllKeys("docs", range)) as string[];
	}
	get<T>(key: string) {
		return this.db.get("kv", key) as Promise<T | undefined>;
	}
	async put<T>(key: string, value: T) {
		await this.db.put("kv", value, key);
	}
	async delete(key: string) {
		await this.db.delete("kv", key);
	}
	close() {
		this.db.close();
	}
}
