# Developing Tezca

## Repository

| Path | What |
|---|---|
| [`server/`](../server/) | Go relay server ([README](../server/README.md)) |
| [`plugin/`](../plugin/) | Obsidian plugin (TypeScript) |
| [`proto/`](../proto/) | Protobuf wire schema, codegen script and cross-language test vectors |
| [`sim/`](../sim/) | Headless multi-client simulator against the real server |
| [`e2e/`](../e2e/) | End-to-end tests in real Obsidian ([README](../e2e/README.md)) |
| [`deploy/`](../deploy/) | Dockerfile and compose recipes |
| [`docs/`](.) | [research](research.md), [plan](plan.md), [protocol](protocol.md) |

Commands use [just](https://github.com/casey/just) and pnpm (`just` lists them).

## Run it locally

```sh
pnpm install
just server        # unclaimed server on :8080; claim at http://localhost:8080/claim?code=dev
just build         # plugin → plugin/main.js, manifest.json, styles.css
just install-plugin ~/path/to/vault
```

## Tests

```sh
just test          # plugin tests (incl. against the real server) and Go tests with -race
just sim           # randomized multi-client simulation against the real server
just e2e [filter]  # real Obsidian windows; slow and takes over the screen (see e2e/README.md)
```

`proto/gen.sh` regenerates protobuf code. `pnpm -C plugin vectors` regenerates the signature test vectors.

## Releasing

```sh
just release 0.3.3
```

This runs the tests, bumps the plugin version, builds, commits, pushes and creates the GitHub release (BRAT installs from it). Publishing the release also builds the server image for amd64 and arm64 and pushes it to `ghcr.io/alexjsp/tezca-server` (`.github/workflows/docker.yml`). The first time, make the package public in GitHub (**Packages → tezca-server → Package settings → Change visibility**) so Unraid and Docker can pull it without logging in.

## Deploying your own build to Unraid

`just deploy-unraid` builds the server on the Unraid box and restarts it, from a local `.env` (copy `.env.example`). The [Unraid template](https://github.com/alexjsp/unraid-community-apps/blob/main/templates/tezca.xml) is the way for everyone else.
