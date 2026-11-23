# tezca-server

The Tezca relay: an opaque store-and-forward server for end-to-end-encrypted Obsidian live sync.
It authenticates users by Ed25519 signatures, enforces roles, assigns per-doc sequence numbers, and
stores and relays encrypted bytes. It never holds a decryption key.

The normative spec is [`docs/protocol.md`](../docs/protocol.md). The wire schema is
[`proto/tezca/v1/sync.proto`](../proto/tezca/v1/sync.proto).

## Run locally

```sh
cd server
go run ./cmd/tezca-server
# … Claim this server: http://localhost:8080/claim?code=…
```

For a fixed claim code (tests, the simulator):

```sh
TEZCA_CLAIM_CODE=dev TEZCA_DATA_DIR=/tmp/tezca go run ./cmd/tezca-server
```

Static binary:

```sh
CGO_ENABLED=0 go build -trimpath -ldflags='-s -w' -o tezca-server ./cmd/tezca-server
```

For Docker, see [`deploy/README.md`](../deploy/README.md).

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `TEZCA_DATA_DIR` | `./data` | Directory for `tezca.db` (SQLite, WAL). |
| `TEZCA_LISTEN` | `:8080` | Listen address (plain HTTP). |
| `TEZCA_PUBLIC_URL` | (unset) | Public base URL used in claim and invite links. If unset, the URL comes from `X-Forwarded-Proto`/`X-Forwarded-Host`/`Host`. |
| `TEZCA_SERVER_NAME` | `Tezca` | Display name on the setup pages and in `/api/info`. |
| `TEZCA_CLAIM_CODE` | (random) | Presets the claim code while the server is unclaimed. |
| `TEZCA_DEBUG` | (unset) | Any value enables debug logging. |

While unclaimed, the claim URL `<public>/claim?code=…` is logged on every start.

`tezca-server healthcheck` exits 0 if the server on `TEZCA_LISTEN` answers `/healthz`.

## Layout

```
cmd/tezca-server   main: config, startup banner, graceful shutdown, healthcheck subcommand
internal/sigs      sigInput construction + Ed25519 verification (golden-vector tested)
internal/store     SQLite schema, migrations, all queries (single writer conn + read pool)
internal/ws        WebSocket sessions, hub, per-doc ordering, space feeds
internal/api       HTTP API, signed-request auth, CORS, claim/landing pages, QR
internal/pb        generated protobuf code (proto/gen.sh)
internal/e2e       end-to-end tests (httptest server + real WebSocket clients)
```

### Ordering

Each connection has one bounded outbound queue (1024 frames) drained by a single writer goroutine.
Each doc has a mutex. Everything that touches a doc runs while holding that mutex: a push
(commit → Ack to the sender → `Updates` to the other subscribers → `DocHeads` to space subscribers),
a snapshot, and a subscribe (snapshot → backlog → `SyncDone` → register as a live subscriber).
Per doc, every connection therefore sees seqs strictly ascending with no gaps or duplicates.
Enqueueing never blocks. If a queue overflows, the connection is closed (status 4008), never
silently skipped, and the client resyncs with `since_seq`.

## Tests

```sh
go test -race ./...
```

- `internal/sigs`: rebuilds every case in `proto/vectors/sig-vectors.json` and verifies the
  libsodium signatures with `crypto/ed25519`.
- `internal/store`: claim, users, invites, pairings, spaces, updates, snapshots, prune and retention.
- `internal/e2e`: claim and setup pages, HTTP signature auth (including clock skew), CORS,
  invites/redeem, single-use pairings, and the full WebSocket flow. That covers concurrent pushes
  from two connections with strict per-connection ordering, Acks, broadcast to others only,
  DocHeads, resubscribe, batching, snapshot + prune + subscribe-from-0, error paths
  (FORBIDDEN, EPOCH_STALE, UNAUTHORIZED, TOO_LARGE, UPDATE_REQUIRED), idle timeout, and
  slow-consumer disconnects.
