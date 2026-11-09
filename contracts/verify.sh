#!/usr/bin/env bash
# Best-effort source verification of the three canonical contracts on Hemi's Blockscout explorer,
# and of the phase 2 contracts (X402BtcSettler; HbkTestnetAdapter on testnet) once they are deployed.
#
#   contracts/verify.sh testnet
#   contracts/verify.sh mainnet
#
# What it does, per contract (see README.md, "Explorer verification"):
#   1. Checks that the address has code (run deploy.sh first).
#   2. Asks Blockscout for the contract. Hemi's Blockscout looks unverified contracts up in
#      Blockscout's shared bytecode database (eth-bytecode-db), which holds sources for all three
#      creation codes, so they may verify themselves; the script waits and asks again.
#   3. If the x402 exact proxy is still unverified, submits the vendored source with
#      forge verify-contract (profile "verify": solc 0.8.28, cancun, 200 runs, CBOR metadata on).
#      The deployed bytecode came from a build whose metadata hash cannot be reproduced, so the best
#      possible result is a partial match.
#   4. Permit2 and the validator are not compiled here, so nothing is submitted for them.
#   5. X402BtcSettler and HbkTestnetAdapter (addresses from shared/hemi.json) are compiled here with the
#      default profile (no metadata), so a full match is possible. If unverified, their source is
#      submitted with the constructor arguments read back from the contracts' own getters. While they
#      are not deployed they are listed as such and do not affect the exit status.
#
# Environment:
#   HEMI_TESTNET_RPC_URL / HEMI_MAINNET_RPC_URL            default: Hemi public RPC
#   HEMI_TESTNET_EXPLORER_URL / HEMI_MAINNET_EXPLORER_URL  default: testnet.explorer.hemi.xyz / explorer.hemi.xyz
#   VERIFY_LOOKUP_WAIT                                     seconds to wait for the bytecode-DB lookup (default 20)
#
# Exit status: 0 if the three canonical contracts, and every deployed phase 2 contract, are verified
# (fully or partially); 1 otherwise.
# Run live on Hemi testnet on 2026-10-29, where all three verified through the bytecode database. On
# mainnet the validator and the proxy verified the same way once looked up in a browser (D-034).
set -euo pipefail
cd "$(dirname "$0")"

PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
NAMES=("Permit2" "EIP-6492 validator" "x402 exact Permit2 proxy")
ADDRS=($PERMIT2 0xdAcD51A54883eb67D95FAEb2BBfdC4a9a6BD2a3B 0x402085c248EeA27D92E8b30b2C58ed07f9E20001)
KINDS=(canonical canonical proxy)
WAIT=${VERIFY_LOOKUP_WAIT:-20}

die() { printf 'verify.sh: %s\n' "$*" >&2; exit 2; }
case ${1:-} in
  testnet) CHAIN_ID=743111; RPC=${HEMI_TESTNET_RPC_URL:-https://testnet.rpc.hemi.network/rpc}; EXPLORER=${HEMI_TESTNET_EXPLORER_URL:-https://testnet.explorer.hemi.xyz}; EXPLORER_VAR=HEMI_TESTNET_EXPLORER_URL ;;
  mainnet) CHAIN_ID=43111; RPC=${HEMI_MAINNET_RPC_URL:-https://rpc.hemi.network/rpc}; EXPLORER=${HEMI_MAINNET_EXPLORER_URL:-https://explorer.hemi.xyz}; EXPLORER_VAR=HEMI_MAINNET_EXPLORER_URL ;;
  *) die "usage: $0 testnet|mainnet" ;;
esac
EXPLORER=${EXPLORER%/}
for tool in forge cast jq curl; do command -v $tool >/dev/null || die "$tool not found on PATH"; done

# Phase 2 contracts, from shared/hemi.json (predicted CREATE2 addresses until deployed).
btc_addr() { jq -r --arg n "eip155:$CHAIN_ID" --arg k "$1" '.networks[$n].contracts[$k] // empty' ../shared/hemi.json; }
a=$(btc_addr hbkTestnetAdapter)
if [ -n "$a" ]; then NAMES+=("HbkTestnetAdapter"); ADDRS+=("$a"); KINDS+=(adapter); fi
a=$(btc_addr x402BtcSettler)
if [ -n "$a" ]; then NAMES+=("X402BtcSettler"); ADDRS+=("$a"); KINDS+=(settler); fi

got=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || die "RPC did not answer eth_chainId"
[ "$got" = "$CHAIN_ID" ] || die "RPC reports chain id $got, expected $CHAIN_ID"
curl -fsS --max-time 30 -o /dev/null "$EXPLORER/api/v2/stats" ||
  die "explorer $EXPLORER is not reachable from here (explorer.hemi.xyz is blocked on some ISPs; set $EXPLORER_VAR or run elsewhere)"

# Prints one of: "full", "partial", "unverified", "not-found"; plus " via-bytecode-db" when applicable.
status() {
  local body
  body=$(curl -sS --max-time 30 "$EXPLORER/api/v2/smart-contracts/$1") || { echo "unreachable"; return; }
  jq -r '
    if (.message? == "Not found") then "not-found"
    elif (.is_verified // false) then
      (if (.is_partially_verified // false) then "partial" else "full" end)
      + (if (.is_verified_via_eth_bytecode_db // false) then " via-bytecode-db" else "" end)
      + " (" + (.name // "?") + ", " + (.compiler_version // "?") + ")"
    else "unverified" end' <<<"$body" 2>/dev/null || echo "unparseable"
}
verified() { [[ $1 == full* || $1 == partial* ]]; }

# Submits a src/btc contract compiled with the default profile (no metadata: a full match is possible).
submit_btc() { # address contract-id constructor-args
  FOUNDRY_PROFILE=default forge build src/btc >/dev/null
  FOUNDRY_PROFILE=default forge verify-contract "$1" "$2" \
    --chain "$CHAIN_ID" \
    --verifier blockscout --verifier-url "$EXPLORER/api/" \
    --compiler-version 0.8.28 --evm-version cancun --num-of-optimizations 200 \
    --constructor-args "$3" \
    --watch || echo "   forge verify-contract failed (see output above)"
}

declare -a RESULT OPTIONAL
for i in "${!NAMES[@]}"; do
  name=${NAMES[$i]} addr=${ADDRS[$i]} kind=${KINDS[$i]}
  echo "== $name $addr"
  if [ "$(cast code "$addr" --rpc-url "$RPC")" = "0x" ]; then
    if [ "$kind" = settler ] || [ "$kind" = adapter ]; then
      echo "   no code on chain $CHAIN_ID; phase 2, deployed by deploy-btc.sh"
      RESULT[$i]="not deployed (phase 2)"
      OPTIONAL[$i]=1
    else
      echo "   no code on chain $CHAIN_ID; deploy it first (deploy.sh)"
      RESULT[$i]="not deployed"
    fi
    continue
  fi
  s=$(status "$addr")
  echo "   explorer: $s"
  if ! verified "$s"; then
    # The first request makes Blockscout look the bytecode up in eth-bytecode-db; give it time.
    echo "   waiting ${WAIT}s for Blockscout's bytecode-database lookup"
    sleep "$WAIT"
    s=$(status "$addr")
    echo "   explorer: $s"
  fi
  if ! verified "$s" && [ "$kind" = settler ]; then
    args=$(cast abi-encode 'constructor(address,address,uint32)' \
      "$(cast call "$addr" 'HBK()(address)' --rpc-url "$RPC")" \
      "$(cast call "$addr" 'SETTLER()(address)' --rpc-url "$RPC")" \
      "$(cast call "$addr" 'CONFIRMATION_OFFSET()(uint32)' --rpc-url "$RPC")")
    echo "   submitting src/btc/X402BtcSettler.sol with forge verify-contract"
    submit_btc "$addr" src/btc/X402BtcSettler.sol:X402BtcSettler "$args"
    s=$(status "$addr")
    echo "   explorer: $s"
  elif ! verified "$s" && [ "$kind" = adapter ]; then
    args=$(cast abi-encode 'constructor(address)' "$(cast call "$addr" 'HBK()(address)' --rpc-url "$RPC")")
    echo "   submitting src/btc/HbkTestnetAdapter.sol with forge verify-contract"
    submit_btc "$addr" src/btc/HbkTestnetAdapter.sol:HbkTestnetAdapter "$args"
    s=$(status "$addr")
    echo "   explorer: $s"
  elif ! verified "$s" && [ "$kind" = proxy ]; then
    echo "   submitting vendored source (src/x402/x402ExactPermit2Proxy.sol) with forge verify-contract"
    FOUNDRY_PROFILE=verify forge build src/x402/x402ExactPermit2Proxy.sol >/dev/null
    FOUNDRY_PROFILE=verify forge verify-contract "$addr" \
      src/x402/x402ExactPermit2Proxy.sol:x402ExactPermit2Proxy \
      --chain "$CHAIN_ID" \
      --verifier blockscout --verifier-url "$EXPLORER/api/" \
      --compiler-version 0.8.28 --evm-version cancun --num-of-optimizations 200 \
      --constructor-args "$(cast abi-encode 'constructor(address)' "$PERMIT2")" \
      --watch || echo "   forge verify-contract failed (see output above)"
    s=$(status "$addr")
    echo "   explorer: $s"
  elif ! verified "$s"; then
    echo "   not verified, and its source is not compiled in this repo; see README.md"
  fi
  RESULT[$i]=$s
done

echo
echo "Summary ($EXPLORER):"
rc=0
for i in "${!NAMES[@]}"; do
  printf '  %-26s %s  %s\n' "${NAMES[$i]}" "${ADDRS[$i]}" "${RESULT[$i]}"
  verified "${RESULT[$i]}" || [ "${OPTIONAL[$i]:-}" = 1 ] || rc=1
done
exit $rc
