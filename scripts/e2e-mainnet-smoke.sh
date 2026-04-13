#!/usr/bin/env bash
# End-to-end mainnet smoke test for the .SKI v4.1.0 release.
#
# Covers every net-new endpoint + on-chain invariant from the nursery
# wrap-up swarm (Registeel + Magneton + Porygon commits 624ebcb..b86cdda):
#
#   1. /api/ultron/wasm-spike    — IKA WASM runs inside a Durable Object
#   2. /api/ultron/read-dwallet  — IkaClient + JSON-RPC transport + Active state
#   3. /api/cache/ultron-sol-probe — legacy sol@ultron fully drained
#   4. /api/sol-rpc              — Helius proxy relays JSON-RPC + blocks sendTransaction
#   5. /api/cache/bam-mint-v2    — vector-intent helper wired
#   6. /api/cache/send-iusd-v2   — vector-intent helper reusable
#   7. ultron owns 2 DWalletCaps on-chain (ed25519 + secp256k1)
#   8. New sol@ultron holds the swept iUSD + USDC SPL balances
#
# Exits non-zero on the first failure. Read-only + sign-free — safe any time.

set -uo pipefail

SKI_HOST="${SKI_HOST:-https://sui.ski}"
SUI_RPC="${SUI_RPC:-https://sui-rpc.publicnode.com}"
ULTRON_ADDR="0xa84cebfde3f0522cd893263d5208a633cd226a1585249b32f02d77438094b3c3"
ULTRON_SOL_NEW="GfVzGHiSPyTnX6bawnahJnUPXeASF6qKPd224VQws1DW"
ULTRON_SOL_OLD="7iVxCjQpLEhsYTLCUVJkPBZvnTXgtLKmNLKVDMrctv3U"
DWALLET_CAP_TYPE="0xdd24c62739923fbf582f49ef190b4a007f981ca6eb209ca94f3a8eaf7c611317::coordinator_inner::DWalletCap"
IUSD_SPL_MINT="Jk4P1ADUyiEY9e6X4VRPt9vN8Za87tjZ7sq2QWRgpps"
USDC_SPL_MINT="EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"

RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

pass=0
fail=0

# Each check runs `python3 -` with the body piped in. $? propagates the
# assert outcome so the harness records pass/fail. Inline everything —
# no shell functions cross the subshell boundary.
check() {
  local label="$1"
  shift
  printf "  %-50s " "$label"
  if "$@" > /tmp/ski-smoke.out 2> /tmp/ski-smoke.err; then
    pass=$((pass + 1))
    echo "${GREEN}✓${RESET}"
  else
    fail=$((fail + 1))
    echo "${RED}✗${RESET}"
    local out err
    out=$(head -c 400 /tmp/ski-smoke.out 2>/dev/null || true)
    err=$(head -c 400 /tmp/ski-smoke.err 2>/dev/null || true)
    [[ -n "$out" ]] && echo "    ${YELLOW}stdout:${RESET} $out"
    [[ -n "$err" ]] && echo "    ${YELLOW}stderr:${RESET} $err"
  fi
}

section() {
  echo
  echo "${BOLD}$1${RESET}"
}

check_wasm_spike() {
  curl -fsS "$SKI_HOST/api/ultron/wasm-spike" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d.get("ok") is True, d
print("ok")
'
}

check_read_dwallet() {
  curl -fsS "$SKI_HOST/api/ultron/read-dwallet" | python3 -c '
import json, sys
d = json.load(sys.stdin)
assert d.get("ok") is True, d
assert d.get("state") == "Active", d
assert d.get("curve") == 2, d
assert d.get("encryptedUserShareCount") == 1, d
assert d.get("publicOutputLength", 0) > 700, d
print("ok")
'
}

check_sol_probe_drained() {
  curl -fsS "$SKI_HOST/api/cache/ultron-sol-probe" | python3 -c "
import json, sys
d = json.load(sys.stdin)
assert d['oldSolAddress'] == '$ULTRON_SOL_OLD', d
assert d['solLamports'] == 0, d
assert d['totalTokens'] == 0, d
print('ok')
"
}

check_sol_new_has_spl() {
  local body
  body='{"jsonrpc":"2.0","id":1,"method":"getTokenAccountsByOwner","params":["'"$ULTRON_SOL_NEW"'",{"programId":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},{"encoding":"jsonParsed"}]}'
  curl -fsS -X POST "$SKI_HOST/api/sol-rpc" -H 'content-type: application/json' -d "$body" |
  python3 -c "
import json, sys
d = json.load(sys.stdin)
mints = [a['account']['data']['parsed']['info']['mint'] for a in d['result']['value']]
assert '$IUSD_SPL_MINT' in mints, ('iUSD SPL missing', mints)
assert '$USDC_SPL_MINT' in mints, ('USDC SPL missing', mints)
print('ok')
"
}

check_sol_rpc_balance() {
  local body
  body='{"jsonrpc":"2.0","id":1,"method":"getBalance","params":["'"$ULTRON_SOL_NEW"'"]}'
  curl -fsS -X POST "$SKI_HOST/api/sol-rpc" -H 'content-type: application/json' -d "$body" |
  python3 -c "
import json, sys
d = json.load(sys.stdin)
v = d['result']['value']
assert isinstance(v, int) and v > 1_000_000, v
print('ok')
"
}

check_sol_rpc_blocks_send() {
  local body='{"jsonrpc":"2.0","id":1,"method":"sendTransaction","params":[]}'
  local code
  code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$SKI_HOST/api/sol-rpc" -H 'content-type: application/json' -d "$body")
  test "$code" = "403"
}

check_bam_mint_v2_rejects_empty() {
  local code
  code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$SKI_HOST/api/cache/bam-mint-v2" -H 'content-type: application/json' -d '{}')
  test "$code" -ge 400 && test "$code" -lt 500
}

check_send_iusd_v2_rejects_empty() {
  local code
  code=$(curl -sS -o /dev/null -w "%{http_code}" -X POST "$SKI_HOST/api/cache/send-iusd-v2" -H 'content-type: application/json' -d '{}')
  test "$code" -ge 400 && test "$code" -lt 500
}

check_ultron_has_two_caps() {
  local body
  body='{"jsonrpc":"2.0","id":1,"method":"suix_getOwnedObjects","params":["'"$ULTRON_ADDR"'",{"filter":{"StructType":"'"$DWALLET_CAP_TYPE"'"},"options":{"showContent":true}},null,50]}'
  curl -fsS -X POST "$SUI_RPC" -H 'content-type: application/json' -d "$body" |
  python3 -c "
import json, sys
d = json.load(sys.stdin)
caps = d['result']['data']
assert len(caps) == 2, ('expected 2 DWalletCaps', len(caps))
print('ok')
"
}

check_ultron_spl_balances() {
  local body
  body='{"jsonrpc":"2.0","id":1,"method":"getTokenAccountsByOwner","params":["'"$ULTRON_SOL_NEW"'",{"programId":"TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"},{"encoding":"jsonParsed"}]}'
  curl -fsS -X POST "$SKI_HOST/api/sol-rpc" -H 'content-type: application/json' -d "$body" |
  python3 -c "
import json, sys
d = json.load(sys.stdin)
amounts = {a['account']['data']['parsed']['info']['mint']: int(a['account']['data']['parsed']['info']['tokenAmount']['amount']) for a in d['result']['value']}
assert amounts.get('$IUSD_SPL_MINT', 0) > 0, ('iUSD balance zero', amounts)
assert amounts.get('$USDC_SPL_MINT', 0) > 0, ('USDC balance zero', amounts)
print('ok')
"
}

echo "${BOLD}.SKI v4.1.0 mainnet smoke test${RESET}"
echo "host: $SKI_HOST"
echo "ultron: $ULTRON_ADDR"

section "1. UltronSigningAgent WASM + IkaClient path"
check "WASM spike returns ok=true"             check_wasm_spike
check "read-dwallet returns Active ed25519"    check_read_dwallet

section "2. sol@ultron sweep invariants"
check "old sol@ultron fully drained"           check_sol_probe_drained
check "new sol@ultron has SPL balances"        check_sol_new_has_spl

section "3. Helius proxy"
check "sol-rpc proxy returns getBalance"       check_sol_rpc_balance
check "sol-rpc proxy rejects sendTransaction"  check_sol_rpc_blocks_send

section "4. Vector intent endpoints"
check "bam-mint-v2 rejects empty body"         check_bam_mint_v2_rejects_empty
check "send-iusd-v2 rejects empty body"        check_send_iusd_v2_rejects_empty

section "5. On-chain invariants"
check "ultron owns 2 DWalletCaps"              check_ultron_has_two_caps
check "new sol@ultron iUSD + USDC > 0"         check_ultron_spl_balances

echo
echo "${BOLD}Result:${RESET} ${GREEN}$pass passed${RESET}, ${RED}$fail failed${RESET}"
if [[ $fail -gt 0 ]]; then
  exit 1
fi
