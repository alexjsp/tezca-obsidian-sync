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
