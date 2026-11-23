#!/usr/bin/env bash
# Regenerate protobuf code for the Go server and the TS plugin.
# Requires: protoc, protoc-gen-go (go install google.golang.org/protobuf/cmd/protoc-gen-go@latest),
# and plugin deps installed (pnpm install) for protoc-gen-es.
set -euo pipefail
cd "$(dirname "$0")"
ROOT=$(cd .. && pwd)
mkdir -p "$ROOT/server/internal/pb" "$ROOT/plugin/src/proto"
protoc -I . \
  --go_out="$ROOT/server/internal/pb" --go_opt=paths=source_relative \
  tezca/v1/sync.proto
# source_relative puts it under tezca/v1; flatten into internal/pb
mv "$ROOT/server/internal/pb/tezca/v1/sync.pb.go" "$ROOT/server/internal/pb/sync.pb.go"
rm -rf "$ROOT/server/internal/pb/tezca"
protoc -I . \
  --plugin=protoc-gen-es="$ROOT/node_modules/.bin/protoc-gen-es" \
  --es_out="$ROOT/plugin/src/proto" --es_opt=target=ts,import_extension=none \
  tezca/v1/sync.proto
echo "generated"
