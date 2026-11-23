import "fake-indexeddb/auto";
import { initCrypto } from "../src/core/crypto";
import { log } from "../src/core/util";
log.level = (process.env.TEZCA_LOG as typeof log.level) ?? "warn";
await initCrypto();
