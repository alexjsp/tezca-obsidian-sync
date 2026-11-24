default:
  @just --list

# Install workspace dependencies
install:
  pnpm install

# Build the Obsidian plugin (plugin/main.js)
build:
  pnpm -C plugin build

# Run plugin, server and protocol tests
test:
  pnpm -C plugin test
  go -C server test -race ./...

# Randomized multi-client simulation against the real server
sim *args="--runs 5 --steps 200 --clients 4":
  pnpm sim -- {{args}}

# Run the server locally (unclaimed; claim at http://localhost:8080/claim?code=dev)
[no-exit-message]
server:
  TEZCA_CLAIM_CODE=dev TEZCA_DATA_DIR=${TEZCA_DATA_DIR:-/tmp/tezca} go -C server run ./cmd/tezca-server

# Build and (re)start the server on Unraid
deploy-unraid:
  ./scripts/deploy-unraid

# Build the plugin and install it into a vault's .obsidian/plugins/tezca-sync
install-plugin vault: build
  mkdir -p {{quote(vault)}}/.obsidian/plugins/tezca-sync
  cp plugin/main.js plugin/manifest.json plugin/styles.css {{quote(vault)}}/.obsidian/plugins/tezca-sync/

# Publish a plugin release to GitHub (BRAT installs/updates from these). Usage: just release 0.1.1
release version: test
  #!/usr/bin/env bash
  set -euo pipefail
  [ -z "$(git status --porcelain)" ] || { echo "working tree not clean" >&2; exit 1; }
  jq --arg v {{quote(version)}} '.version = $v' plugin/manifest.json > plugin/manifest.json.tmp && mv plugin/manifest.json.tmp plugin/manifest.json
  jq --arg v {{quote(version)}} '.version = $v' plugin/package.json > plugin/package.json.tmp && mv plugin/package.json.tmp plugin/package.json
  pnpm -C plugin build
  pnpm -C plugin build:recover
  if ! git diff --quiet; then git commit -qam "Release {{version}}"; fi
  git push origin main
  gh release create {{quote(version)}} --target main --title {{quote(version)}} --generate-notes \
    plugin/main.js plugin/manifest.json plugin/styles.css plugin/dist/tezca-recover.mjs

# Drive real (sandboxed) Obsidian end-to-end; slow, run when a change needs it. `just e2e core` runs specs/*core*
e2e filter="": build
  cd e2e && E2E_FILTER={{quote(filter)}} pnpm exec mocha
