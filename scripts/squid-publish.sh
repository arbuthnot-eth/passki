#!/usr/bin/env bash
# squid-publish.sh — publish a SUIAMI record via sui cli, reading chains
# from ~/.ski/squids.json. Used because bun-via-snap can't exec sui.
#
#   scripts/squid-publish.sh <name>
#
# Requires: sui cli in PATH, jq, node (for keccak).

set -euo pipefail

NAME="${1:-}"
if [[ -z "$NAME" ]]; then
  echo "usage: $0 <name>"
  exit 1
fi

if [[ "$NAME" == "ultron" ]]; then
  curl -fsS -X POST "${SKI_WORKER_URL:-https://sui.ski}/api/cache/ultron-roster" \
    -H 'content-type: application/json' -d '{}'
  echo
  exit 0
fi

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYSTORE="$REPO_ROOT/.ski/squids.json"
if [[ ! -f "$KEYSTORE" ]]; then
  echo "no keystore at $KEYSTORE — run 'bun run squids add $NAME ...' first"
  exit 1
fi

ENTRY=$(jq -r ".[\"$NAME\"] // empty" "$KEYSTORE")
if [[ -z "$ENTRY" ]]; then
  echo "no keystore entry for $NAME — run 'bun run squids add $NAME ...'"
  exit 1
fi

ROSTER_OBJ="0x30b45c51a34b20b5ab99e8c493a82c332e9502e5f4380d1be6cc79e712eaab1d"
ROSTER_PKG="0x7bf4438feaf953e94b98dfc2aab0cf1aaad2250ee4e0fe87c9cc251965987de8"

KEYS=$(echo "$ENTRY" | jq -r 'keys_unsorted | map("\"" + . + "\"") | "[" + join(",") + "]"')
VALS=$(echo "$ENTRY" | jq -r '[.[]] | map("\"" + . + "\"") | "[" + join(",") + "]"')

NAMEHASH=$(node -e "const {keccak_256}=require('$REPO_ROOT/node_modules/@noble/hashes/sha3.js');process.stdout.write('['+Array.from(keccak_256(new TextEncoder().encode('$NAME'))).join(',')+']')")

echo "publishing $NAME:"
echo "  keys:   $KEYS"
echo "  values: $VALS"
echo "  hash:   $NAMEHASH"

sui client call \
  --package "$ROSTER_PKG" \
  --module roster \
  --function set_identity \
  --args "$ROSTER_OBJ" "$NAME" "$NAMEHASH" "$KEYS" "$VALS" "[]" "" "[]" "0x6" \
  --gas-budget 100000000 \
  --json | jq -r '{digest, status: .effects.status}'
