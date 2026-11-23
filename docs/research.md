# Tezca Obsidian Sync — research notes (2026-11-23)

Goal: a self-hosted (Docker) Obsidian sync plugin with live sync (keystroke-level), shared folders with true multiplayer (remote cursors), sharing across users on the same host *and* on other hosts, easy setup, and E2EE where possible.

## Prior art

### YAOS (kavinsood/yaos) — Yjs on Cloudflare Workers
- **Model:** one vault = one Durable Object room = one vault-wide `Y.Doc`. The doc holds stable file IDs → path metadata, a `Y.Text` per Markdown file, blob hash refs, and tombstones. Folders aren't modelled (derived from paths; empty folders don't sync).
- **Client:** `y-indexeddb` for local persistence, `y-partyserver` provider, `y-codemirror.next` editor binding. A `DiskMirror` turns CRDT state into files and watches the disk. External edits are applied as `fast-diff` diffs, not replace-all.
- **Hard-won lessons (their docs, BACKLOG):**
  - Most of the complexity is the **disk ↔ CRDT ↔ editor bridge**, not the CRDT. Obsidian file events are noisy and non-causal.
  - They suppress their own writes with **content fingerprints, not TTLs**. Time windows misclassified delayed events.
  - Startup reconciliation uses a three-way baseline/disk/CRDT hash. Open bugs: offline deletes get resurrected, and bound-file divergence can discard one side.
  - "Preservation before convergence": on ambiguity, write a conflict sibling, then converge. They also have a mass-overwrite safety brake (>20 files and >25% of the vault).
  - A single vault-wide `Y.Doc` hits a **memory ceiling**: Yjs structs live for the doc's lifetime. Sharding was deferred because it changes bootstrap, persistence, and recovery.
  - Server persistence uses checkpoint + coalesced delta journal + integrity hashes, and fails closed on corruption.
  - Attachments are whole-file, content-addressed, and stored in R2. `.canvas`, `.excalidraw`, and `.base` are treated as blobs.
  - Auth: claim-once setup page → bearer token → short-lived HMAC WebSocket tickets. A QR/setup link fills in plugin settings.
  - Explicitly *not* done: Docker, multi-user collaboration, `.obsidian` sync, E2EE.

### Self-hosted LiveSync (vrtmrz/obsidian-livesync) — CouchDB/PouchDB
- **Model:** file metadata docs plus content-defined, deduplicated **chunks**, replicated PouchDB ↔ CouchDB. There are also object-storage "journal sync" and WebRTC P2P backends.
- **Conflicts:** CouchDB revision trees, with a three-way merge (diff-match-patch) from the nearest common ancestor and a dialogue when that fails. That's "sync on save", not keystroke-level: no cursors, no live co-editing.
- **E2EE:** passphrase-derived key encrypts chunks and can obfuscate paths. This works because the server only replicates opaque docs.
- **Setup:** an encrypted "Setup URI" copies settings to new devices. Running CouchDB is widely seen as the painful part.
- **Takeaway:** strong on E2EE and robustness, but its replication model can't give us live multiplayer.

### Relay (No-Instructions/Relay, "system3 relay") — closest to our goal
- Obsidian plugin (MIT) + **Relay Server, a fork of y-sweet** (Rust, MIT). Yjs-based shared folders with live cursors. Self-hostable, but the identity/control plane is their hosted service. Several forks/clones exist (Team Relay, Mood Collab, Collaborative Folders, Kurotsuki).
- It proves the **"shared folder = its own Yjs namespace mounted into a vault"** model works with Obsidian's CodeMirror 6 editor.

### E2EE over CRDTs — secsync (nikgraf/secsync, NGI funded, beta)
- The server is a **dumb relay/store of encrypted blobs**: an encrypted *snapshot* (full CRDT state), encrypted *updates* referencing that snapshot, and encrypted *ephemeral* messages (awareness/cursors).
- Clients periodically make new snapshots (compaction happens client-side, because the server can't read state). Works with Yjs because Yjs updates are commutative and idempotent.
- So **live typing + cursors + E2EE are compatible.** We give up server-side features that need plaintext: server-side merge/compaction, search, a web viewer, server-rendered history diffs. Sharing needs key management: a per-space key wrapped to each member, and key rotation on revocation.

## Technology options

### CRDT library
| | Yjs | Loro | Automerge |
|---|---|---|---|
| CodeMirror 6 binding (Obsidian's editor) | `y-codemirror.next`, mature, includes remote cursors/selections | early/none for CM6 | community only |
| Awareness/presence protocol | built in (`y-protocols/awareness`) | built-in ephemeral store | DIY |
| Server implementations | JS (Hocuspocus, y-websocket), Rust (yrs, y-sweet), others | Rust/WASM | Rust/JS |
| Used by Obsidian prior art | YAOS, Relay, most clones | — | — |

→ **Yjs** is the clear default. Loro has better history/version features, but no CodeMirror binding exists yet, so we'd have to write one.

### Document granularity
- **One Y.Doc per vault** (YAOS): simple, with atomic folder renames, but has a memory ceiling. Doesn't fit per-folder sharing.
- **Per "space" index doc + one Y.Doc per file** (Relay-style): an index `Y.Map` maps fileId → {path, type, hash, tombstone}, and each file's contents are a separate lazily loaded doc. This scales, makes the space the natural unit of **sharing, ACL, and encryption key**, and loads only open/changed docs.
- Proposed: a user's vault = one private space at `/` plus N **shared spaces mounted at folder paths**.

### Cross-host sharing ("federation")
1. **Client-side multi-host:** the plugin keeps connections to several servers. An invite to a folder on host A is a link with A's URL + capability token (+ key in the URL fragment if E2EE). Host B never learns about it. Simple, and works today.
2. **Server-to-server federation:** host B mirrors/relays the space from host A, so B's users connect only to B. Better for offline hosts and corporate networks, but much more protocol: identity federation, trust, conflict of authority.
→ Start with option 1 and design the protocol so option 2 is possible later.

### Server language / runtime
- **Opaque-blob server (if E2EE-first):** the server never needs a CRDT library. It stores and fans out encrypted updates and snapshots per doc and enforces ACLs. Any language works; **Go** or **Rust** give a single static binary and a tiny Docker image.
- **CRDT-aware server (if plaintext):** the server merges and compacts Yjs state itself, so either **TypeScript (Bun/Node + Hocuspocus/y-websocket)**, which shares code and types with the plugin, or **Rust (yrs / y-sweet fork)**, which is fast with low memory.
- **Hybrid:** an opaque protocol for E2EE spaces, plus optional server-side Yjs (yrs) for plaintext spaces to enable a web viewer, search, and server compaction.

### Storage
- **SQLite (WAL)** in the Docker volume for users, devices, spaces, ACLs, invites, per-doc update logs, and snapshots. That means no external DB and makes backup a single file. (Same checkpoint + journal pattern as YAOS.)
- **Blobs** (attachments, encrypted if E2EE): content-addressed files on the volume, with an optional S3-compatible backend.
- Postgres is optional later for big multi-user hosts.

### Transport
- WebSocket per server connection, multiplexing many docs (subscribe/unsubscribe by docId). HTTP for blobs, auth, and admin.
- Mobile Obsidian needs **HTTPS/WSS**. Options for the Docker setup: bundled Caddy with automatic TLS, documented Tailscale Serve/Cloudflare Tunnel, or BYO reverse proxy.

### Client (plugin) architecture, borrowing YAOS's lessons
- Local persistence in IndexedDB (per doc). Offline-first, with sync on reconnect.
- Editor binding via `y-codemirror.next` for open files, with awareness for cursors/names/colours.
- DiskMirror with per-path serialized writes, content-fingerprint suppression, and diff-applied external edits. Startup three-way reconcile, conflict siblings, and a mass-change safety brake.
- Attachments: content-addressed whole-file blobs, last-writer-wins plus a conflict copy.
- Setup: a server claim page → QR / `obsidian://` setup link that fills in settings (both YAOS and LiveSync converge on this).

## Key open questions (for the grilling)
1. E2EE: mandatory, optional per space, or deferred? (It drives the server language and features.)
2. Server language: Go/Rust opaque relay, TypeScript, or a Rust yrs hybrid?
3. Identity: accounts per host, or keypair identities portable across hosts?
4. Federation: is client multi-host enough?
5. Sharing semantics: mount point and naming, roles (viewer/editor), nested shares, moving shared folders.
6. Scope of sync: Markdown only, or canvas/base/attachments/`.obsidian` too? Size limits?
7. History/versioning and snapshots/restore.
8. MVP cut and milestones.
