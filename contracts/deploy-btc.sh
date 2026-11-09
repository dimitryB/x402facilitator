#!/usr/bin/env bash
# Deploy X402BtcSettler (phase 2) to its CREATE2 address on Hemi, through the deterministic deployer
# (script/DeployBtcSettler.s.sol). On testnet the HbkTestnetAdapter is deployed first. Contracts that
# already exist are skipped. Same flow and key handling as deploy.sh.
#
#   contracts/deploy-btc.sh testnet                 plan + simulation, sends nothing
#   contracts/deploy-btc.sh testnet --broadcast     deploy to Hemi testnet
#   contracts/deploy-btc.sh mainnet                 plan + simulation, sends nothing
#   CONFIRM_MAINNET_DEPLOY=yes contracts/deploy-btc.sh mainnet --broadcast
#
# Environment:
#   DEPLOYER_PRIVATE_KEY              signer on either network
#   FACILITATOR_TESTNET_PRIVATE_KEY   testnet-only fallback signer; never used on mainnet
#   HEMI_TESTNET_RPC_URL              default https://testnet.rpc.hemi.network/rpc
#   HEMI_MAINNET_RPC_URL              default https://rpc.hemi.network/rpc
#   CONFIRM_MAINNET_DEPLOY=yes        required for --broadcast on mainnet
#
# The deploying key does not matter to the contracts: the settler's SETTLER (the facilitator's signer)
# and HBK are constructor arguments fixed in DeployBtcSettler.s.sol, and nobody owns the contracts.
# Keys are read from the repo's .env (variables already set in the shell win) and handed to forge
# through the environment (HEMI_DEPLOY_PRIVATE_KEY); they are never printed.
set -euo pipefail
cd "$(dirname "$0")"
if [ -f ../.env ]; then
  while IFS='=' read -r k v; do
    case $k in
      DEPLOYER_PRIVATE_KEY|FACILITATOR_TESTNET_PRIVATE_KEY|HEMI_TESTNET_RPC_URL|HEMI_MAINNET_RPC_URL)
        [ -z "${!k:-}" ] && [ -n "$v" ] && export "$k=$v" ;;
    esac
  done < <(grep -E '^[A-Z_]+=' ../.env)
fi
# Only this script decides which key reaches forge.
unset HEMI_DEPLOY_PRIVATE_KEY

DEPLOYER=0x4e59b44847b379578588920cA78FbF26c0B4956C
GAS_PRICE_ORACLE=0x420000000000000000000000000000000000000F # OP Stack predeploy, L1 data fee
SCRIPT=script/DeployBtcSettler.s.sol:DeployBtcSettler

die() { printf 'deploy-btc.sh: %s\n' "$*" >&2; exit 1; }
usage() {
  cat >&2 <<'USAGE'
usage: contracts/deploy-btc.sh testnet|mainnet [--broadcast]
  without --broadcast: plan and simulation only, nothing is sent
  mainnet --broadcast also needs CONFIRM_MAINNET_DEPLOY=yes and DEPLOYER_PRIVATE_KEY
USAGE
  exit 2
}

NET=${1:-}
[ $# -gt 0 ] && shift
BROADCAST=0
for arg in "$@"; do
  case $arg in
    --broadcast) BROADCAST=1 ;;
    *) usage ;;
  esac
done

case $NET in
  testnet) CHAIN_ID=743111; RPC=${HEMI_TESTNET_RPC_URL:-https://testnet.rpc.hemi.network/rpc}; EXPLORER=https://testnet.explorer.hemi.xyz ;;
  mainnet) CHAIN_ID=43111; RPC=${HEMI_MAINNET_RPC_URL:-https://rpc.hemi.network/rpc}; EXPLORER=https://explorer.hemi.xyz ;;
  *) usage ;;
esac
for tool in forge cast jq; do command -v $tool >/dev/null || die "$tool not found on PATH"; done

# Show only scheme://host, since RPC URLs can embed API keys.
RPC_SHOWN=$(printf '%s' "$RPC" | sed -E 's#^([a-z]+://[^/]+).*#\1#')

got=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || die "RPC $RPC_SHOWN did not answer eth_chainId"
[ "$got" = "$CHAIN_ID" ] || die "RPC $RPC_SHOWN reports chain id $got, expected $CHAIN_ID for $NET"

# --- signer --------------------------------------------------------------------------------
normalize_key() { # prints 0x-prefixed lowercase key or fails
  local k=${1#0x}; k=${k#0X}
  [[ $k =~ ^[0-9a-fA-F]{64}$ ]] || return 1
  printf '0x%s' "$(printf '%s' "$k" | tr 'A-F' 'a-f')"
}
KEY="" KEY_SRC=""
if [ -n "${DEPLOYER_PRIVATE_KEY:-}" ]; then
  KEY=$(normalize_key "$DEPLOYER_PRIVATE_KEY") || die "DEPLOYER_PRIVATE_KEY is not a 32-byte hex key"
  KEY_SRC=DEPLOYER_PRIVATE_KEY
elif [ "$NET" = testnet ] && [ -n "${FACILITATOR_TESTNET_PRIVATE_KEY:-}" ]; then
  KEY=$(normalize_key "$FACILITATOR_TESTNET_PRIVATE_KEY") || die "FACILITATOR_TESTNET_PRIVATE_KEY is not a 32-byte hex key"
  KEY_SRC=FACILITATOR_TESTNET_PRIVATE_KEY
fi
if [ "$NET" = mainnet ] && [ -n "$KEY" ] && [ -n "${FACILITATOR_TESTNET_PRIVATE_KEY:-}" ]; then
  tk=$(normalize_key "$FACILITATOR_TESTNET_PRIVATE_KEY" || true)
  [ "$KEY" != "$tk" ] || die "DEPLOYER_PRIVATE_KEY equals FACILITATOR_TESTNET_PRIVATE_KEY; refusing to sign on mainnet with the testnet key"
fi
if [ "$BROADCAST" = 1 ] && [ -z "$KEY" ]; then
  if [ "$NET" = testnet ]; then die "--broadcast needs DEPLOYER_PRIVATE_KEY or FACILITATOR_TESTNET_PRIVATE_KEY"; fi
  die "--broadcast on mainnet needs DEPLOYER_PRIVATE_KEY (the testnet key is never used on mainnet)"
fi

# --- plan and cost estimate -----------------------------------------------------------------
echo "== Hemi $NET (chain id $CHAIN_ID) via $RPC_SHOWN"
SIGNER_NOTE="none set; the simulation uses the default forge sender"
echo "   signer: ${KEY_SRC:-$SIGNER_NOTE}"
echo
# plan() checks the chain, the deployer and hBK, checks each compiled initcode against the expected
# CREATE2 address, and prints `PLAN <name> <address> <has code> <deployer calldata>` per contract.
plan=$(forge script "$SCRIPT" --sig 'plan()' --rpc-url "$RPC" 2>&1) || { printf '%s\n' "$plan" >&2; die "plan() failed"; }
gas_price=$(cast gas-price --rpc-url "$RPC")
total_wei=0 missing=0 unestimated=0
printf '%-20s %-44s %-8s %10s %14s %16s\n' contract address status "L2 gas" "L1 fee (wei)" "est. cost (ETH)"
while read -r _ name addr has data; do
  if [ "$has" = 1 ]; then
    printf '%-20s %-44s %-8s\n' "$name" "$addr" present
    continue
  fi
  missing=$((missing + 1))
  l1=$(cast call "$GAS_PRICE_ORACLE" 'getL1Fee(bytes)(uint256)' "$data" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}') || l1=""
  [[ $l1 =~ ^[0-9]+$ ]] || l1=0
  # The testnet settler's constructor needs the adapter to exist, so it cannot be estimated before
  # the adapter is deployed; the simulation below still runs both.
  if gas=$(cast estimate "$DEPLOYER" "$data" --rpc-url "$RPC" 2>/dev/null); then
    cost=$((gas * gas_price + l1))
    total_wei=$((total_wei + cost))
    printf '%-20s %-44s %-8s %10s %14s %16s\n' "$name" "$addr" DEPLOY "$gas" "$l1" "$(cast from-wei "$cost")"
  else
    unestimated=$((unestimated + 1))
    total_wei=$((total_wei + l1))
    printf '%-20s %-44s %-8s %10s %14s %16s\n' "$name" "$addr" DEPLOY "n/a" "$l1" "L1 fee only"
  fi
done < <(printf '%s\n' "$plan" | grep -E '^\s*PLAN ')
echo
echo "   L2 gas price now: $gas_price wei. Estimated total: $(cast from-wei "$total_wei") ETH for $missing contract(s)."
[ "$unestimated" = 0 ] || echo "   ($unestimated contract(s) could not be gas-estimated before an earlier one exists; the total counts only their L1 fee.)"
echo "   (L1 fee from GasPriceOracle.getL1Fee over the calldata; forge sets a 130% gas limit, actual cost is gas used.)"
echo

# --- simulation (always) --------------------------------------------------------------------
FORGE=(forge script "$SCRIPT" --rpc-url "$RPC")
# Use the node's priority fee suggestion rather than forge's (see deploy.sh).
tip=$(cast rpc eth_maxPriorityFeePerGas --rpc-url "$RPC" 2>/dev/null | tr -d '"') || tip=""
base_fee=$(cast base-fee --rpc-url "$RPC" 2>/dev/null) || base_fee=""
if [[ $tip =~ ^0x[0-9a-fA-F]+$ ]] && [[ $base_fee =~ ^[0-9]+$ ]]; then
  tip=$(cast to-dec "$tip")
  FORGE+=(--priority-gas-price "$tip" --with-gas-price $((2 * base_fee + tip)))
fi
with_key() { if [ -n "$KEY" ]; then HEMI_DEPLOY_PRIVATE_KEY=$KEY "$@"; else "$@"; fi; }
echo "== Simulation (no transactions sent)"
with_key "${FORGE[@]}"

if [ "$BROADCAST" = 0 ]; then
  echo
  echo "Simulation only. Re-run with --broadcast to send the transactions."
  exit 0
fi
if [ "$missing" = 0 ]; then
  echo
  echo "Nothing to deploy: everything already exists on $NET."
  exit 0
fi

# --- mainnet gate ---------------------------------------------------------------------------
if [ "$NET" = mainnet ] && [ "${CONFIRM_MAINNET_DEPLOY:-}" != yes ]; then
  echo
  echo "Refusing to broadcast to Hemi mainnet: the plan above would deploy $missing contract(s) for about $(cast from-wei "$total_wei") ETH." >&2
  echo "Set CONFIRM_MAINNET_DEPLOY=yes to proceed." >&2
  exit 3
fi

# --- broadcast ------------------------------------------------------------------------------
echo
echo "== Broadcasting to Hemi $NET"
with_key "${FORGE[@]}" --broadcast --slow

run=broadcast/DeployBtcSettler.s.sol/$CHAIN_ID/run-latest.json
if [ -f "$run" ]; then
  echo
  echo "Transactions (from $run):"
  case $RPC_SHOWN in *://127.0.0.1* | *://localhost* | *://[[]::1[]]*) echo "  (local RPC: these hashes exist only on that node, not on the explorer)" ;; esac
  jq -r '.receipts[] | "\(.transactionHash) status=\(.status) gasUsed=\(.gasUsed)"' "$run" |
    while read -r h rest; do echo "  $EXPLORER/tx/$h $rest"; done
fi

# --- post-check: rerun read-only; the script asserts code and the immutables -----------------
echo
echo "== Post-deployment check (simulation, should deploy nothing)"
post=$("${FORGE[@]}" 2>&1) || { printf '%s\n' "$post"; die "post-deployment check failed: the read-only rerun reverted"; }
printf '%s\n' "$post"
grep -q "contracts deployed in this run: 0" <<<"$post" ||
  die "post-deployment check failed: the rerun still wanted to deploy something"
echo "X402BtcSettler is in place on Hemi $NET. Next: contracts/check-btc-live.sh $NET"
