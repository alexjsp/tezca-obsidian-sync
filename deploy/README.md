# Deploying Tezca

The server is one static binary in a distroless, non-root image. It speaks **plain HTTP on port
8080** and keeps everything (SQLite database) in the `/data` volume. TLS is the job of whatever
sits in front of it. Pick one of the recipes below.

| File | Use it when | TLS |
|---|---|---|
| `docker-compose.yml` | LAN only, or you already have a reverse proxy | none (HTTP :8080) |
| `compose.caddy.yml` | You have a domain and can open ports 80/443 | Let's Encrypt via Caddy |
| `compose.tailscale.yml` | All your devices are on a Tailscale tailnet | Tailscale Serve certs |
| `compose.cloudflared.yml` | You use Cloudflare and can't (or won't) open ports | Cloudflare edge |

All commands below run from this `deploy/` directory. Each recipe builds the image from `../server`
(build context `server/`, Dockerfile `deploy/Dockerfile`). To build it by hand from the repo root:

```sh
docker build -f deploy/Dockerfile -t tezca-server server
```

## First start: claim the server

The first person to claim a server becomes its admin. Until then, every start prints a claim link:

```sh
docker compose logs tezca        # add -f compose.<recipe>.yml for the other recipes
# ========================================================================
#   This server is not claimed yet.
#   Claim this server: https://notes.example.com/claim?code=…
# ========================================================================
```

Open that link on a device with the Tezca plugin installed and press **Open in Obsidian**, or scan
the QR code with your phone. After the claim, the link stops working. Keep the logs private until
you've claimed the server: anyone with the link can claim it first.

Set `TEZCA_PUBLIC_URL` to the exact URL your devices use. It goes into claim and invite links.

## Plain HTTP (`docker-compose.yml`)

```sh
TEZCA_PUBLIC_URL=http://192.168.1.10:8080 docker compose up -d
```

Use this only on a network you trust. Content is end-to-end encrypted, but plain HTTP still exposes
metadata (who syncs which doc, and when) to anyone on the path. Obsidian mobile may also refuse
non-HTTPS hosts. If you already run nginx or Traefik, point it at `:8080` and make sure it forwards
WebSocket upgrades on `/ws`.

## Caddy with automatic HTTPS (`compose.caddy.yml`)

1. Point a DNS `A`/`AAAA` record (e.g. `notes.example.com`) at this machine.
2. Open ports 80 and 443.
3. Start it:

```sh
TEZCA_DOMAIN=notes.example.com docker compose -f compose.caddy.yml up -d
```

Caddy gets a certificate on first request and proxies HTTP and WebSockets to the server
(see `Caddyfile`). The Tezca container publishes no ports itself.

## Tailscale Serve (`compose.tailscale.yml`)

The server is only reachable from your tailnet, and nothing is exposed to the internet.

1. In the Tailscale admin console, enable **MagicDNS** and **HTTPS certificates**.
2. Create an auth key (Settings → Keys).
3. Start it, passing your tailnet's DNS name (shown in the admin console, e.g. `tail1234.ts.net`):

```sh
TS_AUTHKEY=tskey-auth-… TS_TAILNET=tail1234.ts.net docker compose -f compose.tailscale.yml up -d
```

The server is then at `https://tezca.tail1234.ts.net` (change the name with `TS_HOSTNAME`). The Tezca
container shares the Tailscale container's network namespace. `tailscale-serve.json` makes
Serve terminate TLS on 443 and proxy to `127.0.0.1:8080`. Every device that syncs needs Tailscale
running.

## Cloudflare Tunnel (`compose.cloudflared.yml`)

Works behind NAT or CGNAT, with no inbound ports.

1. In Cloudflare Zero Trust → Networks → Tunnels, create a tunnel and copy its token.
2. Add a public hostname, e.g. `notes.example.com`, with the service `http://tezca:8080`.
   Tunnels proxy WebSockets by default.
3. Start it:

```sh
TUNNEL_TOKEN=… TEZCA_DOMAIN=notes.example.com docker compose -f compose.cloudflared.yml up -d
```

Cloudflare terminates TLS, so it sees the traffic. It still can't read your notes, because they're
end-to-end encrypted, but it sees the same metadata the server does.

## Operations

- **Health:** the image has a `HEALTHCHECK` that runs `/tezca-server healthcheck` (GET `/healthz`).
- **Backups:** back up the `tezca-data` volume. The database is `tezca.db` in WAL mode, so copy it
  together with `tezca.db-wal`/`-shm`, or stop the container first. A consistent online copy:
  `sqlite3 tezca.db ".backup backup.db"`.
- **Upgrades:** `docker compose pull && docker compose up -d --build`. Migrations run on start.
- **Shutdown:** `SIGTERM` closes all sessions (clients reconnect and resync) and exits cleanly.
- **Environment:** see [`server/README.md`](../server/README.md#configuration).
