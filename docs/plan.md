# Tezca Obsidian Sync — build plan

Agreed 2026-11-23. Background and prior art: [research.md](research.md).

## Goals
- Self-hosted (Docker) sync for Obsidian vaults that is **live** (keystroke-level) and easy to set up.
- **Shared folders** with true multiplayer (remote cursors, live text), with users on the same host or on other hosts.
- **Always-on end-to-end encryption.** The host never sees content, paths, or cursors.

## Decisions

### Core model
| Decision | Choice |
|---|---|
| Encryption | E2EE always on. The server is an opaque relay/store (secsync-style: encrypted snapshot + updates + ephemeral messages). Clients do compaction. |
| CRDT | Yjs. `y-codemirror.next` for the editor binding; `y-protocols/awareness` for presence (encrypted). |
| Data model | **Spaces + per-file docs.** Each space has an encrypted **index doc** (fileId → path, type, blob hash, tombstone) and one Y.Doc per file, loaded lazily. A space is the unit of ACL and key. |
| Vault mapping | A user's vault = private **root space** at `/` + N **shared spaces** mounted at folder paths. |

### Identity and keys
| Decision | Choice |
|---|---|
| Identity | Ed25519 signing + X25519 box keypair per user. A host account is keyed by public key. |
| Crypto | libsodium.js (plugin) / `x/crypto` + `nacl` (Go). XChaCha20-Poly1305 for content, sealed boxes to wrap space keys, Argon2id for the recovery kit. |
| New devices | QR / `obsidian://` setup link from an existing device. The keypair is transferred encrypted via the host. |
| Recovery | A 24-word recovery phrase / downloadable kit, shown at first setup. |
| Host access | The first person to claim a host is admin. The admin invites **members** (who get a personal vault + can create shares). **Guests** can access only the spaces they're invited to. |
| Hostless users | Allowed. A guest's encrypted profile doc (mount list, display name) lives on the first host that invited them, and pairing relays through it. The admin can cap guest storage. |

### Sharing
| Decision | Choice |
|---|---|
| Roles | owner / editor / viewer. The server enforces writes by checking signatures against the ACL. |
| Removal | The owner's client rotates the space key (new epoch) and writes a re-encrypted snapshot. Removed users keep what they already had. |
| Invites | Single-use, expiring links: `obsidian://tezca/join?host=…&space=…&invite=…#<secret>`. The secret unwraps a pre-wrapped space key → instant join. The server binds the invite to the redeemer's pubkey. Optional per-share "require approval". Pending invites can be listed and revoked. |
| Mounting | The recipient picks a mount path (default: top-level folder with the share's name). The mount table lives in their private space/profile, so all their devices agree. Moving the folder moves the mount. |
| Nesting | No nested spaces. Any private folder can be **converted** into a share (files migrate to the new space). A folder inside a share can't become its own share. |
| Cross-host | The client connects directly to each host it has spaces on. Space IDs are host-qualified (`host/spaceId`) so server-to-server mirroring can be added later. |

### Content
| Type | Handling |
|---|---|
| Markdown | Live `Y.Text` per file. |
| `.canvas` | Live CRDT (`Y.Map` nodes/edges) with a JSON ↔ CRDT bridge (M5). Until then, a blob. |
| Attachments, `.base`, `.excalidraw`, other | Encrypted, content-addressed whole-file blobs, LWW + local conflict copy. Size cap is configurable. |
| `.obsidian` | Private space only. Opt-in categories: core settings, appearance/themes/snippets, hotkeys, community plugin list + settings, plugin code. Always excluded: `workspace*.json`, our plugin's `data.json`/keys, caches. LWW blobs. |
| Empty folders | Recorded in the index doc as folder entries (unlike YAOS). |

### History
- Periodic encrypted snapshots per doc double as compaction points and **versions**.
- Retention is host-configurable (default: hourly for 24 h, daily for 30 days).
- Plugin modal: per-file version list → diff → restore (restore is a new edit, not a rewind).

### Disk bridge / conflicts (YAOS contract, gaps designed out)
- Editor binding is authoritative for typing. Remote updates go CRDT → DiskMirror → disk, never socket → disk.
- External disk edits are **diff-applied** into `Y.Text`, never replace-all.
- Per-path serialized writes. Our own writes are suppressed by **content fingerprint**, not timers.
- Startup three-way reconcile on baseline (B) / disk (D) / CRDT (C) hashes. When ambiguous: preserve a local conflict sibling, then converge.
- A persisted **disk index** distinguishes "deleted while offline" from "never materialized" (fixes YAOS SYNC-01). The full three-way classifier always runs before editor-equality shortcuts (fixes SYNC-02).
- A locally modified file beats a remote delete. Unknown baselines preserve without reviving.
- Safety brake: block a reconcile pass that would overwrite >20 files and >25% of a space.

### Server and ops
| Decision | Choice |
|---|---|
| Language | Go. Single static binary, distroless image. |
| Storage | SQLite (WAL) for accounts, devices, spaces, ACLs, invites, update logs, snapshots. Blobs as content-addressed files on the volume. Pluggable blob store with an S3/MinIO/R2 backend. |
| TLS | Server speaks plain HTTP. `/deploy` provides compose recipes for Caddy (auto-TLS), Tailscale Serve, and Cloudflare Tunnel. |
| Setup | `docker compose up` → open the URL → claim page (create admin keypair or link an existing identity) → QR/setup link into the plugin. |

### Repo
```
/server   Go relay
/plugin   Obsidian plugin (TypeScript, esbuild)
/proto    protobuf schema (buf → Go + TS codegen)
/sim      headless multi-client simulator (Node)
/deploy   Dockerfile, compose recipes
/docs     research, plan, protocol, sync contract
```

### Testing
- Protocol/crypto unit tests in Go and TS with **shared golden vectors** (wrap/unwrap, frame encode, signature checks).
- **Headless multi-client simulator:** N clients with mock vault filesystems against a real server, running randomized edits, renames, deletes, disconnects, and offline periods. It asserts convergence and no data loss, and is seeded for reproducibility.
- No CI jobs for now; no real-Obsidian e2e for now.

## Architecture sketch

### Crypto layout
- `user`: `sign_pk/sign_sk` (Ed25519) + `box_pk/box_sk` (X25519). The same identity is on all of a user's devices. Each device also has an ID and name for presence and audit.
- `space`: random 32-byte key per **epoch** `K[space, epoch]`. Each member gets `sealed_box(box_pk_member, K)` stored server-side in `space_keys`.
- Update payload: `XChaCha20-Poly1305(K[epoch], nonce, yjs_update, AD = spaceId‖docId‖epoch)`. The frame is signed by the author's `sign_sk` so the server can enforce the role and peers can verify the author (all editors share the symmetric key, so the signature is what proves who wrote it).
- Blobs: `id = BLAKE2b(K-derived MAC key, plaintext)` (keyed, so the host can't confirm guesses), encrypted in chunks (secretstream).
- Index doc entries hold paths/metadata, so paths are encrypted too. The server sees space/doc IDs, sizes, and timing only.

### Wire protocol (WebSocket, protobuf frames; HTTP for blobs/admin)
```
C→S Hello{sign_pk, device_id, client_version}
S→C Challenge{nonce, server_id}
C→S Auth{sig(nonce‖server_id)}
C→S Subscribe{space, doc, since_seq}            // many docs per socket
S→C Updates{space, doc, [ {seq, epoch, author, ciphertext, sig} ]}
S→C Snapshot{space, doc, base_seq, epoch, ciphertext}   // if since_seq < latest snapshot
C→S PushUpdate{space, doc, epoch, ciphertext, sig} → S→C Ack{seq}
C→S PutSnapshot{space, doc, base_seq, epoch, ciphertext, sig}
C↔S Awareness{space, doc, ciphertext}           // relayed, never stored
S→C Error{code: unauthorized|update_required|epoch_stale|…}
```
- The server assigns a monotonic `seq` per doc. Because it can't read Yjs state vectors, clients sync by `since_seq` instead of state-vector exchange.
- Compaction: when the update count/bytes since the last snapshot exceed a threshold, any writer client merges the updates, encrypts a snapshot at `base_seq`, and uploads it. The server prunes updates ≤ `base_seq` according to history retention.
- A receipt (YAOS-style) is the `Ack{seq}` after durable commit, so "saved to server" is honest.

### Server tables (SQLite)
`users(pk, role, display_hint)`, `devices`, `spaces(id, owner_pk, kind: root|share|profile, epoch)`, `members(space, pk, role)`, `space_keys(space, epoch, pk, wrapped)`, `invites(id, space, role, wrapped_key, expires, redeemed_by)`, `docs(space, doc, latest_seq)`, `updates(space, doc, seq, epoch, author, ct, sig)`, `snapshots(space, doc, base_seq, epoch, ct, created_at)`, `blobs(space, id, size, ref)`.

### Plugin modules
- `Identity`: keys, pairing, recovery kit, and secure local storage (stored in IndexedDB, *not* `data.json`).
- `HostConnection`: one per host. Handles auth, subscriptions, reconnect/backoff, and encrypting/decrypting frames.
- `SpaceManager`: the mount table (path → space), index docs, and routing of vault paths to spaces.
- `DocStore`: per-doc Y.Doc lifecycle, IndexedDB persistence, lazy load/unload, compaction.
- `EditorBinding`: `y-codemirror.next` + encrypted awareness. Shows cursor colours and names, plus "who's here" in the status bar.
- `DiskMirror` + `Reconciler`: the disk contract above.
- `BlobSync`: attachments and `.obsidian` categories.
- `HistoryView`, `ShareModal` (invite, members, roles, revoke), and settings/setup UI (QR scan/paste).

## Milestones
1. **M1: personal live sync.**
   - Go relay: auth, updates, snapshots, SQLite, Docker image, claim page.
   - Plugin: identity, pairing, recovery kit, root space, Markdown live sync, DiskMirror/Reconciler, encrypted awareness between your own devices.
   - Proto, golden vectors, simulator v1.
2. **M2: attachments + history.** Encrypted blob store (fs + S3), BlobSync, snapshot retention, history modal, and diff/restore.
3. **M3: same-host shares.** Spaces/mounts, convert folder → share, roles and server enforcement, invites, multiplayer cursors and presence UI, key rotation on removal.
4. **M4: cross-host + guests.** Multi-host connections, guest profiles on the inviting host, host-qualified IDs, guest storage caps.
5. **M5: extras.** Live Canvas CRDT bridge, `.obsidian` category sync.

## Open details to settle during build (not blockers)
- Exact compaction thresholds and retention defaults. Memory policy for unloading idle docs on mobile.
- Recovery kit format (BIP39 words vs a printed key file).
- Cross-space moves (into or out of a share) as copy + tombstone, with a UX warning.
- Name, plugin ID, and licence.

## Progress

### M1: personal live sync (built 2026-11-23)
- **Server** (`/server`): Go relay. Claim/landing pages, signed-HTTP API (claim, invites, redeem, pairings), WebSocket session with challenge auth, per-doc seq ordering, doc-heads feed, snapshots + pruning, awareness relay, SQLite (WAL). Tests: golden vectors, store, end-to-end WS ordering/error paths (`go test -race ./...`).
- **Plugin** (`/plugin`):
  - `core/`: crypto (libsodium), HostConnection, DocSync (encrypted seq-ordered Yjs sync, pending queue, client-side compaction, encrypted awareness), SpaceSync (keys, index doc, lazy doc loading, pending-doc flush across restarts), DiskMirror (startup three-way reconcile, live event import, CAS disk writes, verify sweep, collision resolution, conflict copies, safety brake).
  - `obsidian/`: vault adapter, CM6 editor binding with remote cursors (remote edits excluded from undo history), setup flows (claim / invite / pairing QR / recovery phrase), settings, status bar.
- **Simulator** (`/sim`): N clients against the real server with randomised create/append/insert/rename/delete, network drops and offline restarts. Asserts convergence, disk == CRDT, and no lost content.

Disk-contract details found and fixed with the simulator (each is now a test or a sim invariant):
- Disk writes are compare-and-swap. A user edit that lands between our read and our write is never overwritten.
- Local events resolve files by what we last materialized at that path (baseline), not by the index. During path collisions these can differ.
- A local file at a path whose index entry was never materialized on this device is a *different* file. It gets its own entry, and collision renames separate the two.
- Docs with unacknowledged local updates are persisted and flushed after restart, even when the startup fast path skips them.
- Moved entries are processed before others in both startup reconcile and the live sweep, so old paths are vacated first.
- Baselines record the doc seq, so the startup fast path can't skip a doc whose remote changes never reached disk.

Since verified in real use: desktop and iPhone (via BRAT), and the Docker image on Unraid (`just deploy-unraid`).

Incidents found in real use (both fixed, both now tests):
- 0.1.0: opening a note could start two editor binds that cancelled each other forever, freezing the window.
- 0.1.1: Obsidian points a view at a newly opened file before loading its text. Binding in that gap merged the
  previous note's text into the new note. Binding now never uses editor text as input; it waits until the editor
  shows the file's disk or synced text. `plugin/scripts/recover-doc.ts` rebuilds a doc from the server log.

### M2: attachments and history (built 2026-11-23)
- **Blobs:** every non-Markdown file is a `blob` index entry. Content is encrypted whole-file under a keyed content
  address (dedup, idempotent upload). The entry records the current version and up to 20 earlier ones.
  Server: `PUT/GET/HEAD /api/spaces/{space}/blobs/{id}` with streamed signature and size checks; filesystem or
  S3 store; `TEZCA_MAX_BLOB_MB` (default 100).
- **Blob conflicts:** the last recorded version wins everywhere; a local version that lost (edited concurrently,
  or recorded concurrently and absent from the winner's history) is kept as a local-only conflict copy.
  Transfers run outside the mirror queue (4 at a time) and retry after failures or reconnecting.
- **History:** retained snapshots are versions (latest; hourly for 24 h; daily for 30 days). Devices take a
  version snapshot after local edits, once the note has been quiet for 30 s and the last snapshot is over an hour
  old. `ListVersions`/`GetVersion` on the wire; a modal with diff/restore for notes and preview/restore for
  attachments (command and file menu); "Recently deleted" restores tombstoned files.
- **Simulator:** attachment create/modify/rename/delete; asserts disk equals the index for attachments and that
  no attachment version written by one device ever disappears from every disk and every history.

Found by the simulator during M2: an unsynced local edit was left behind (untracked) when a remote rename
arrived. The file now follows the rename when it is exactly this entry's upload in progress; otherwise (the
edit raced the rename) it is imported as a file of its own. A looser first fix (move it whenever no other entry
claims the old path) let a collision loser take over a deleted winner's file, which the simulator also caught.

Also found by longer simulator runs (250 steps; both reproduce on 0.1.2): a local edit racing a remote delete
created a duplicate entry, and the collision re-check then left the original note missing from that device's
disk. Fixed. After the fixes: attachment seeds 12000–12035 all pass; notes-only 13000–13035 pass 35/36.

Open question (seed 13007, notes-only, timing-dependent, ~1 in 4 reruns): a note ends up deleted everywhere
although the simulator didn't attribute a delete to its content. Most likely an offline device deleting a
stale copy after other devices' edits had already synced (edits only protect a file while they are unsynced),
possibly misattributed by the simulator. The text stays in the doc and "Recently deleted" restores it. Needs
a decision: should an edit made after (in wall-clock terms) a concurrent offline delete revive the file?

Not done in M2:
- Blob garbage collection. The server keeps every blob; the host can't see which ones the encrypted index still
  references, so GC has to be client-driven (an owner device lists live references, the server deletes the rest
  after a grace period).
- Large-file streaming. Blobs are encrypted whole in memory, fine at the 100 MB default cap.
- Versions of attachments are kept only in the index (last 20), not on a time schedule.
