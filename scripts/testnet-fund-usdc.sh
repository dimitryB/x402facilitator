#!/usr/bin/env bash
# Get testnet USDC.e for the buyer without a holder: mint Aave's Sepolia test USDC from Aave's open
# faucet, then deposit it into Hemi's Sepolia -> Hemi testnet tunnel (the OP Stack L1StandardBridge).
#
#   scripts/testnet-fund-usdc.sh          check the route and balances (sends nothing)
#   scripts/testnet-fund-usdc.sh --go     mint, approve, deposit, then wait for it on Hemi testnet
#
# The three transactions are on Ethereum Sepolia, so the buyer needs a little Ethereum Sepolia ETH.
# Hemi testnet ETH does not help here. Env: BUYER_PRIVATE_KEY (.env), SEPOLIA_RPC, AMOUNT (USDC base
# units, default 10 USDC), FUND_TO (Hemi recipient, default the buyer), NO_WAIT=1 (skip the L2 wait).
# Testnet only: the chain ids are checked and the bridge route is read from chain state before sending.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f .env ] && { set -a; . ./.env; set +a; }

SEPOLIA_RPC=${SEPOLIA_RPC:-https://ethereum-sepolia-rpc.publicnode.com}
HEMI_RPC=${HEMI_TESTNET_RPC_FALLBACK:-https://testnet.rpc.hemi.network/rpc}
AMOUNT=${AMOUNT:-10000000}                          # 10 USDC: one payment is 0.001
MIN_GAS_LIMIT=200000                                # L2 gas for finalizeBridgeERC20 (OP SDK default)
FAUCET=0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D   # Aave V3 Sepolia faucet (bgd-labs/aave-address-book)
L2_BRIDGE=0x4200000000000000000000000000000000000010
L2_USDC=$(jq -r '.networks["eip155:743111"].assets["USDC.e"].address' shared/hemi.json)

die() { printf 'testnet-fund-usdc: %s\n' "$*" >&2; exit 1; }
lc() { tr '[:upper:]' '[:lower:]' <<<"$1"; }
num() { awk '{print $1}'; }                          # strip cast's " [1e7]" suffix
# a >= b for decimal integers of any size: bash integers end at 2^63-1, and an allowance can be 2^256-1.
ge() {
  [[ $1 =~ ^[0-9]+$ && $2 =~ ^[0-9]+$ ]] || return 1
  if [ ${#1} -ne ${#2} ]; then [ ${#1} -gt ${#2} ]; else ! [[ $1 < $2 ]]; fi
}
[ -n "${BUYER_PRIVATE_KEY:-}" ] || die "BUYER_PRIVATE_KEY is not set (see .env.example)"
[ "$(cast chain-id --rpc-url "$SEPOLIA_RPC")" = 11155111 ] || die "$SEPOLIA_RPC is not Ethereum Sepolia"
[ "$(cast chain-id --rpc-url "$HEMI_RPC")" = 743111 ] || die "$HEMI_RPC is not Hemi testnet"
# The key stays in the environment: scripts/evm-key.mjs reads it there, so no command line shows it.
export BUYER_PRIVATE_KEY
BUYER=$(node scripts/evm-key.mjs address BUYER_PRIVATE_KEY)
TO=${FUND_TO:-$BUYER}

# The route comes from chain state: USDC.e's L1 token and bridge, and the bridge pair, must agree.
L1_USDC=$(cast call "$L2_USDC" 'remoteToken()(address)' --rpc-url "$HEMI_RPC")
L1_BRIDGE=$(cast call "$L2_BRIDGE" 'OTHER_BRIDGE()(address)' --rpc-url "$HEMI_RPC")
[ "$(lc "$(cast call "$L2_USDC" 'bridge()(address)' --rpc-url "$HEMI_RPC")")" = "$(lc $L2_BRIDGE)" ] \
  || die "USDC.e $L2_USDC is not minted by the standard bridge"
[ "$(lc "$(cast call "$L1_BRIDGE" 'OTHER_BRIDGE()(address)' --rpc-url "$SEPOLIA_RPC")")" = "$(lc $L2_BRIDGE)" ] \
  || die "Sepolia bridge $L1_BRIDGE does not pair with Hemi's L2 bridge"
[ "$(lc "$(cast call "$L1_USDC" 'owner()(address)' --rpc-url "$SEPOLIA_RPC")")" = "$(lc $FAUCET)" ] \
  || die "the faucet no longer owns $L1_USDC, so it cannot mint it"
[ "$(cast call "$FAUCET" 'isPermissioned()(bool)' --rpc-url "$SEPOLIA_RPC")" = false ] \
  || die "the faucet is permissioned now; use the Hemi testnet swap or a holder instead"

eth=$(cast balance "$BUYER" --rpc-url "$SEPOLIA_RPC")
l1=$(cast call "$L1_USDC" 'balanceOf(address)(uint256)' "$BUYER" --rpc-url "$SEPOLIA_RPC" | num)
l2=$(cast call "$L2_USDC" 'balanceOf(address)(uint256)' "$TO" --rpc-url "$HEMI_RPC" | num)
gp=$(cast gas-price --rpc-url "$SEPOLIA_RPC")
[ "$gp" -ge 1000000000 ] || gp=1000000000            # price at >= 1 gwei: Sepolia fees spike
need=$(( 400000 * gp * 2 ))                          # mint + approve + deposit, with 2x headroom
echo "route:  Sepolia USDC $L1_USDC -> bridge $L1_BRIDGE -> Hemi testnet USDC.e $L2_USDC"
echo "buyer   $BUYER  Sepolia ETH=$(cast from-wei "$eth")  Sepolia USDC=$l1"
echo "to      $TO  Hemi USDC.e=$l2 (base units)  amount=$AMOUNT"
ge "$eth" "$need" || {
  echo "MISSING: send >= $(cast from-wei $need) Ethereum Sepolia ETH (chain 11155111) to $BUYER"
  [ "${1:-}" = --go ] && die "fund the buyer on Ethereum Sepolia first"; exit 1; }
[ "${1:-}" = --go ] || { echo "Route and balance OK. Re-run with --go."; exit 0; }

send() { # label, to, signature, args...: cast builds the calldata, evm-key.mjs signs and sends it
  local label=$1 to=$2; shift 2
  local data r; data=$(cast calldata "$@")
  r=$(node scripts/evm-key.mjs send BUYER_PRIVATE_KEY "$SEPOLIA_RPC" "$to" "$data") || die "$label: not sent (see the error above)"
  [ "$(jq -r .status <<<"$r")" = 0x1 ] || die "$label failed: $(jq -c . <<<"$r")"
  local tx; tx=$(jq -r .transactionHash <<<"$r")
  case $SEPOLIA_RPC in
    *127.0.0.1*|*localhost*) echo "$label tx: $tx  (local fork: not on the explorer)" ;;
    *) echo "$label tx: $tx  https://sepolia.etherscan.io/tx/$tx" ;;
  esac
}

ge "$l1" "$AMOUNT" || send "faucet mint" "$FAUCET" 'mint(address,address,uint256)' "$L1_USDC" "$BUYER" "$AMOUNT"
allow=$(cast call "$L1_USDC" 'allowance(address,address)(uint256)' "$BUYER" "$L1_BRIDGE" --rpc-url "$SEPOLIA_RPC" | num)
ge "$allow" "$AMOUNT" || send "approve bridge" "$L1_USDC" 'approve(address,uint256)' "$L1_BRIDGE" "$AMOUNT"
send "tunnel deposit" "$L1_BRIDGE" 'depositERC20To(address,address,address,uint256,uint32,bytes)' \
  "$L1_USDC" "$L2_USDC" "$TO" "$AMOUNT" "$MIN_GAS_LIMIT" 0x

[ "${NO_WAIT:-}" = 1 ] && { echo "NO_WAIT=1: not waiting for Hemi testnet"; exit 0; }
echo "waiting for the deposit on Hemi testnet (usually a few minutes; gives up after 30)"
start=$(date +%s)
while :; do
  now=$(cast call "$L2_USDC" 'balanceOf(address)(uint256)' "$TO" --rpc-url "$HEMI_RPC" | num)
  [ "$now" -ge $(( l2 + AMOUNT )) ] && { echo "arrived after $(( $(date +%s) - start ))s: Hemi USDC.e=$now"; exit 0; }
  [ $(( $(date +%s) - start )) -lt 1800 ] || die "not on Hemi testnet after 30 minutes; the deposit tx above is still the record"
  sleep 15
done
