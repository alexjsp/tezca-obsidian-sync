// Encrypted blob transfer (attachments and other non-Markdown files). protocol.md "HTTP API".
import { blobId, bytesFingerprint, openBlob, sealBlob, type Identity } from "./crypto";
import { HttpError, fetchHttp, httpAuth, type HttpFn } from "./setup";

/** What an index entry records about a blob version (stored as JSON in the encrypted index). */
export interface BlobRef {
	id: string;
	epoch: number;
	size: number;
	/** Unkeyed fingerprint of the plaintext, for local change detection. */
	hash: string;
	/** When this version was recorded (unix ms). */
	mtime?: number;
}

export interface BlobKeys {
	readonly spaceId: string;
	keyFor(epoch: number): Uint8Array;
	currentEpoch(): number;
}

export class BlobClient {
	constructor(
		readonly host: string,
		private readonly identity: Identity,
		private readonly http: HttpFn = fetchHttp,
	) {}

	private path(spaceId: string, id: string) {
		return `/api/spaces/${encodeURIComponent(spaceId)}/blobs/${encodeURIComponent(id)}`;
	}

	private async send(method: string, path: string, body?: Uint8Array) {
		const headers: Record<string, string> = { Authorization: httpAuth(this.identity, method, path, body ?? new Uint8Array()) };
		if (body) headers["Content-Type"] = "application/octet-stream";
		return this.http({ method, url: this.host + path, headers, body });
	}

	/** Encrypt and upload `plain` (idempotent). */
	async upload(keys: BlobKeys, plain: Uint8Array, now = Date.now()): Promise<BlobRef> {
		const epoch = keys.currentEpoch();
		const key = keys.keyFor(epoch);
		const id = blobId(key, plain);
		const path = this.path(keys.spaceId, id);
		const head = await this.send("HEAD", path);
		if (head.status !== 200) {
			const res = await this.send("PUT", path, sealBlob(key, keys.spaceId, id, epoch, plain));
			if (res.status !== 200 && res.status !== 201) throw new HttpError(res.status, errorText(res.json, res.text, res.status));
		}
		return { id, epoch, size: plain.length, hash: bytesFingerprint(plain), mtime: now };
	}

	/** Download and decrypt a blob. Throws HttpError(404) if the host doesn't have it (yet). */
	async download(keys: BlobKeys, ref: BlobRef): Promise<Uint8Array> {
		const res = await this.send("GET", this.path(keys.spaceId, ref.id));
		if (res.status !== 200) throw new HttpError(res.status, errorText(res.json, res.text, res.status));
		return openBlob(keys.keyFor(ref.epoch), keys.spaceId, ref.id, ref.epoch, res.bytes);
	}
}

function errorText(json: unknown, text: string, status: number): string {
	return (json as { error?: string } | null)?.error ?? (text || `HTTP ${status}`);
}
