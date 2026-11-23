// Rebuild a doc's text from its server update log, up to a given seq (incident recovery).
// Usage: TEZCA_KEY=<b64u space key> tsx scripts/recover-doc.ts <space_id> <doc_id> <updates.txt: seq|epoch|hex> <max_seq>
import { readFileSync } from "node:fs";
import * as Y from "yjs";
import { ad, fromB64u, initCrypto, open } from "../src/core/crypto";

const [spaceId, docId, file, maxSeq] = process.argv.slice(2);
await initCrypto();
const key = fromB64u(process.env.TEZCA_KEY!);
const doc = new Y.Doc();
for (const line of readFileSync(file, "utf8").trim().split("\n")) {
	const [seq, epoch, hex] = line.split("|");
	if (Number(seq) > Number(maxSeq)) break;
	const plain = open(key, Buffer.from(hex, "hex"), ad.update(spaceId, docId, Number(epoch)));
	Y.applyUpdate(doc, plain);
}
process.stdout.write(doc.getText("content").toString());
