#!/usr/bin/env bash
# Deploy Permit2, the EIP-6492 validator and the x402 exact Permit2 proxy to their canonical
# CREATE2 addresses on Hemi, by replaying the committed calldata in deploy-data/ through the
# deterministic deployer (script/DeployHemi.s.sol). Contracts that already exist are skipped.
#
#   contracts/deploy.sh testnet                 plan + simulation, sends nothing
#   contracts/deploy.sh testnet --broadcast     deploy to Hemi testnet
#   contracts/deploy.sh mainnet                 plan + simulation, sends nothing
#   CONFIRM_MAINNET_DEPLOY=yes contracts/deploy.sh mainnet --broadcast
#
# Environment:
#   DEPLOYER_PRIVATE_KEY              signer on either network
#   FACILITATOR_TESTNET_PRIVATE_KEY   testnet-only fallback signer; never used on mainnet
#   HEMI_TESTNET_RPC_URL              default https://testnet.rpc.hemi.network/rpc
#   HEMI_MAINNET_RPC_URL              default https://rpc.hemi.network/rpc
#   CONFIRM_MAINNET_DEPLOY=yes        required for --broadcast on mainnet
#
# Keys are read from the repo's .env (variables already set in the shell win), so they never
# need to appear on a command line or in shell history. The key is handed to forge through the
# environment (HEMI_DEPLOY_PRIVATE_KEY) and is never printed.
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
NAMES=("Permit2" "EIP-6492 validator" "x402 exact Permit2 proxy")
ADDRS=(0x000000000022D473030F116dDEE9F6B43aC78BA3 0xdAcD51A54883eb67D95FAEb2BBfdC4a9a6BD2a3B 0x402085c248EeA27D92E8b30b2C58ed07f9E20001)
FILES=(deploy-data/permit2.calldata.hex deploy-data/validator6492.calldata.hex deploy-data/exact-proxy.calldata.hex)

die() { printf 'deploy.sh: %s\n' "$*" >&2; exit 1; }
usage() {
  cat >&2 <<'USAGE'
usage: contracts/deploy.sh testnet|mainnet [--broadcast]
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
gas_price=$(cast gas-price --rpc-url "$RPC")
total_wei=0 missing=0
printf '%-26s %-44s %-8s %10s %14s %16s\n' contract address status "L2 gas" "L1 fee (wei)" "est. cost (ETH)"
for i in 0 1 2; do
  code=$(cast code "${ADDRS[$i]}" --rpc-url "$RPC")
  if [ "$code" != "0x" ]; then
    printf '%-26s %-44s %-8s\n' "${NAMES[$i]}" "${ADDRS[$i]}" present
    continue
  fi
  missing=$((missing + 1))
  data=$(tr -d '[:space:]' < "${FILES[$i]}")
  gas=$(cast estimate "$DEPLOYER" "$data" --rpc-url "$RPC")
  l1=$(cast call "$GAS_PRICE_ORACLE" 'getL1Fee(bytes)(uint256)' "$data" --rpc-url "$RPC" 2>/dev/null | awk '{print $1}') || l1=""
  [[ $l1 =~ ^[0-9]+$ ]] || l1=0
  cost=$((gas * gas_price + l1))
  total_wei=$((total_wei + cost))
  printf '%-26s %-44s %-8s %10s %14s %16s\n' "${NAMES[$i]}" "${ADDRS[$i]}" DEPLOY "$gas" "$l1" "$(cast from-wei "$cost")"
done
echo
echo "   L2 gas price now: $gas_price wei. Estimated total: $(cast from-wei "$total_wei") ETH for $missing contract(s)."
echo "   (L1 fee from GasPriceOracle.getL1Fee over the calldata; forge sets a 130% gas limit, actual cost is gas used.)"
echo

# --- simulation (always) --------------------------------------------------------------------
FORGE=(forge script script/DeployHemi.s.sol:DeployHemi --rpc-url "$RPC")
# forge derives the tip from fee history, which on Hemi is mostly near-empty blocks (tip 1 wei). Use
# the node's own suggestion instead (1e6 wei at the time of writing) so the transactions are not
# underpriced, with a max fee of twice the base fee plus that tip.
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
  echo "Nothing to deploy: all three contracts already exist on $NET."
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

run=broadcast/DeployHemi.s.sol/$CHAIN_ID/run-latest.json
if [ -f "$run" ]; then
  echo
  echo "Transactions (from $run):"
  case $RPC_SHOWN in *://127.0.0.1* | *://localhost* | *://[[]::1[]]*) echo "  (local RPC: these hashes exist only on that node, not on the explorer)" ;; esac
  jq -r '.receipts[] | "\(.transactionHash) status=\(.status) gasUsed=\(.gasUsed)"' "$run" |
    while read -r h rest; do echo "  $EXPLORER/tx/$h $rest"; done
fi

# --- post-check: rerun read-only; the script asserts code, code hashes, DOMAIN_SEPARATOR, PERMIT2()
echo
echo "== Post-deployment check (simulation, should deploy nothing)"
post=$("${FORGE[@]}" 2>&1) || { printf '%s\n' "$post"; die "post-deployment check failed: the read-only rerun reverted"; }
printf '%s\n' "$post"
grep -q "contracts deployed in this run: 0" <<<"$post" ||
  die "post-deployment check failed: the rerun still wanted to deploy something"
echo "All three contracts are in place on Hemi $NET."
