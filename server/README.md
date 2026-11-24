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
| `TEZCA_DATA_DIR` | `./data` | Directory for `tezca.db` (SQLite, WAL) and, with the filesystem blob store, `blobs/`. |
| `TEZCA_LISTEN` | `:8080` | Listen address (plain HTTP). |
| `TEZCA_PUBLIC_URL` | (unset) | Public base URL used in claim and invite links. If unset, the URL comes from `X-Forwarded-Proto`/`X-Forwarded-Host`/`Host`. |
| `TEZCA_SERVER_NAME` | `Tezca` | Display name on the setup pages and in `/api/info`. |
| `TEZCA_PLUGIN_REPO` | `alexjsp/tezca-obsidian-sync` | GitHub `owner/repo` of the Obsidian plugin. The home and invite pages tell people to add it in BRAT, and link to it. |
| `TEZCA_CLAIM_CODE` | (random) | Presets the claim code while the server is unclaimed. |
| `PUID` / `PGID` | (unset) | When the container is started as root (`--user 0:0`, as the Unraid template does), the server gives the data directory to this user and group and then runs as them. Unraid uses `99` / `100`. |
| `TEZCA_DEBUG` | (unset) | Any value enables debug logging. |
| `TEZCA_MAX_BLOB_MB` | `100` | Largest attachment (plaintext MiB). Uploads over this + 40 bytes of encryption overhead get 413. Shown to clients as `max_blob_bytes` in `/api/info`. |
| `TEZCA_GUEST_QUOTA_MB` | `1024` | Storage cap per guest (a user who joined through a share invite and has no host account), in MiB: the attachments they upload plus the note edits and snapshots they write (until history pruning drops them). Uploads over it get 507, edits get `TOO_LARGE`. `0` = unlimited. |
| `TEZCA_HISTORY_HOURS` | `24` | Version history: keep the newest snapshot per clock hour for this many hours. |
| `TEZCA_HISTORY_DAYS` | `30` | Version history: keep the newest snapshot per UTC day for this many days, and the edit log for this long (point-in-time restore). The latest snapshot is always kept. |

Attachments (blobs) are stored on the filesystem under `$TEZCA_DATA_DIR/blobs/` unless
`TEZCA_S3_BUCKET` is set, in which case they go to an S3-compatible bucket (AWS S3, MinIO, R2, B2, …).
The bucket must already exist; the server checks it at startup. The server never deletes blobs.

| Variable | Default | Meaning |
|---|---|---|
| `TEZCA_S3_BUCKET` | (unset) | Bucket name. Setting it enables the S3 blob store. |
| `TEZCA_S3_ENDPOINT` | (required) | `host[:port]`, e.g. `s3.eu-west-1.amazonaws.com` or `minio:9000`. |
| `TEZCA_S3_ACCESS_KEY` / `TEZCA_S3_SECRET_KEY` | | Credentials. |
| `TEZCA_S3_REGION` | (auto) | Region, if the provider needs one. |
| `TEZCA_S3_PREFIX` | (empty) | Key prefix. Objects are stored as `<prefix>blobs/<space_id>/<blob_id>`. |
| `TEZCA_S3_INSECURE` | (unset) | `1` uses plain HTTP to the endpoint. |

While unclaimed, the claim URL `<public>/claim?code=…` is logged on every start.

`tezca-server healthcheck` exits 0 if the server on `TEZCA_LISTEN` answers `/healthz`.

## Layout

```
cmd/tezca-server   main: config, startup banner, graceful shutdown, healthcheck subcommand
internal/sigs      sigInput construction + Ed25519 verification (golden-vector tested)
internal/store     SQLite schema, migrations, all queries (single writer conn + read pool), snapshot retention
internal/blobs     blob byte storage: filesystem (temp file + rename) and S3 (minio-go)
internal/ws        WebSocket sessions, hub, per-doc ordering, space feeds
internal/api       HTTP API (incl. share invites, membership, key rotation), signed-request auth, CORS, claim/landing/invite pages, QR
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

Membership is re-read from the database on every request. `Subscribe` checks it under the doc
lock and `SubscribeSpace` under the feed lock, so when a member is removed the HTTP handler can
delete the row, then drop that user's live subscriptions to the space and its docs, and no
subscription can slip in between. The hub indexes authenticated sessions by user to push
`SpaceChanged`.

## Tests

```sh
go test -race ./...
```

- `internal/sigs`: rebuilds every case in `proto/vectors/sig-vectors.json` and verifies the
  libsodium signatures with `crypto/ed25519`.
- `internal/store`: claim, users, invites, pairings, spaces, updates, snapshots, prune, the
  hourly/daily retention policy, versions, the blob index, and upgrading M1 and M2 databases.
- `internal/blobs`: the same contract test against the filesystem store and the S3 store (backed
  by an in-process [gofakes3](https://github.com/johannesboyne/gofakes3) server), including
  uploads that fail at EOF never becoming visible.
- `internal/e2e`: claim and setup pages, HTTP signature auth (including clock skew), CORS,
  invites/redeem, single-use pairings, and the full WebSocket flow. That covers concurrent pushes
  from two connections with strict per-connection ordering, Acks, broadcast to others only,
  DocHeads, resubscribe, batching, snapshot + prune + subscribe-from-0, error paths
  (FORBIDDEN, EPOCH_STALE, UNAUTHORIZED, TOO_LARGE, UPDATE_REQUIRED), idle timeout, and
  slow-consumer disconnects. Blob PUT/GET/HEAD: signature auth over the streamed body, roles,
  id validation, the size limit (with and without `Content-Length`) and idempotent re-uploads.
  History: snapshot timestamps, retention under a fake clock, `ListVersions` and `GetVersion`.
  Shares: invite create/list/revoke/redeem (every error code, expiry, idempotent re-redeem,
  role merging), `PUT keys`, role changes and last-owner rules, removal ending live
  subscriptions, `SpaceChanged` pushes, and key rotation (epoch and member-set checks,
  `EPOCH_STALE` for old-epoch writes afterwards).
