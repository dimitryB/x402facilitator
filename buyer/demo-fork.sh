#!/usr/bin/env bash
# End-to-end demo on local anvil forks of Hemi. Nothing here touches a live network.
#
#   buyer/demo-fork.sh
#
# Starts both forks (scripts/fork.sh), the facilitator (docker compose; patched x402-rs) pointed at them,
# and the seller; then pays GET /echo four times (testnet and mainnet fork, USDC.e and the BTC
# asset), prints payTo's balances, and tears everything down on exit.
#
# If the facilitator serves `exact` on Bitcoin mainnet (bip122, phase 2), a fifth payment is native BTC on
# Bitcoin L1: the buyer's --stub-pay writes a fabricated Bitcoin transaction into the mock hBK that
# scripts/fork.sh places on the mainnet fork, and the facilitator verifies and settles it there through
# X402BtcSettler. Nothing goes to Bitcoin. Otherwise that payment is skipped with a note.
#
# Environment (all optional):
#   FORK_TESTNET_PORT (28545)  FORK_MAINNET_PORT (28546)  FORK_STATE_DIR (.scratch/fork-demo)
#   FORK_BLOCK_TESTNET (7094000)  FORK_BLOCK_MAINNET (5614300)   pinned fork blocks, as in tests/lib/env.ts;
#                                 pinned forks also let scripts/fork.sh retry on dRPC if the public RPC rate-limits
#   FORK_TESTNET_UPSTREAM / FORK_MAINNET_UPSTREAM   passed to scripts/fork.sh
#   FACILITATOR_PORT (28080)  SELLER_PORT (24021)  DEMO_PROJECT (hemi-x402-demo, the compose project)
#   DEMO_PAY_TO (anvil account #4)
#   DEMO_BTC_XPUB (the BIP84 test mnemonic's account xpub from btc/test-vectors.json; public test data)
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD

export FORK_TESTNET_PORT=${FORK_TESTNET_PORT:-28545}
export FORK_MAINNET_PORT=${FORK_MAINNET_PORT:-28546}
export FORK_STATE_DIR=${FORK_STATE_DIR:-$ROOT/.scratch/fork-demo}
export FORK_BLOCK_TESTNET=${FORK_BLOCK_TESTNET:-7094000}
export FORK_BLOCK_MAINNET=${FORK_BLOCK_MAINNET:-5614300}
FACILITATOR_PORT=${FACILITATOR_PORT:-28080}
SELLER_PORT=${SELLER_PORT:-24021}
PROJECT=${DEMO_PROJECT:-hemi-x402-demo}
PAY_TO=${DEMO_PAY_TO:-0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65}
BTC_XPUB=${DEMO_BTC_XPUB:-$(jq -r '.vectors[0].payTo' "$ROOT/btc/test-vectors.json")}
BTC_MAINNET=bip122:000000000019d6689c085ae165831e93

# Well-known anvil dev keys (#1, #2, #3). They only ever sign on the local forks.
# #3 is the address scripts/fork.sh funds with ETH and tokens.
FAC_TESTNET_KEY=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
FAC_MAINNET_KEY=0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a
BUYER_KEY=0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6

TESTNET_RPC=http://127.0.0.1:$FORK_TESTNET_PORT
MAINNET_RPC=http://127.0.0.1:$FORK_MAINNET_PORT
HEMI_JSON=$ROOT/shared/hemi.json

log() { printf '\n[demo] %s\n' "$*" >&2; }

# X402BtcSettler addresses that scripts/fork.sh deployed on the forks (phase 2); empty before `fork.sh up`.
settler_var() { sed -n "s/^$1=//p" "$FORK_STATE_DIR/btc-settlers.env" 2>/dev/null; }

# Compose interpolates these on both up and down; set them here so .env cannot override them.
compose() {
  FACILITATOR_PORT=$FACILITATOR_PORT FACILITATOR_CONFIG=config.json \
  X402_BTC_SETTLER_TESTNET=$(settler_var X402_BTC_SETTLER_TESTNET) X402_BTC_SETTLER_MAINNET=$(settler_var X402_BTC_SETTLER_MAINNET) \
  FACILITATOR_TESTNET_PRIVATE_KEY=$FAC_TESTNET_KEY FACILITATOR_MAINNET_PRIVATE_KEY=$FAC_MAINNET_KEY \
  HEMI_TESTNET_RPC_PRIMARY=http://host.docker.internal:$FORK_TESTNET_PORT \
  HEMI_TESTNET_RPC_FALLBACK=http://host.docker.internal:$FORK_TESTNET_PORT \
  HEMI_MAINNET_RPC_PRIMARY=http://host.docker.internal:$FORK_MAINNET_PORT \
  HEMI_MAINNET_RPC_FALLBACK=http://host.docker.internal:$FORK_MAINNET_PORT \
    docker compose -p "$PROJECT" "$@"
}

busy() { lsof -nP -iTCP:"$1" -sTCP:LISTEN >/dev/null 2>&1; }

wait_for() { # url seconds
  for _ in $(seq 1 "$2"); do curl -sf "$1" >/dev/null && return; sleep 1; done
  return 1
}

# Colima publishes a container's port through an ssh forward its Lima agent adds and removes; on some
# machines those calls fail (exit 255) and the facilitator stays unreachable although it runs, or a stale
# forward is left behind (tests/setup/global.ts has the same workaround, DECISIONS.md D-036). This adds or
# cancels the forward by hand through the mux socket, when it exists. Off with DEMO_NO_COLIMA_FIX=1.
COLIMA_SOCK=$HOME/.colima/_lima/colima/ssh.sock
ADDED_FORWARD=
colima_forward() { # forward|cancel port
  [ -z "${DEMO_NO_COLIMA_FIX:-}" ] && [ -S "$COLIMA_SOCK" ] || return 1
  ssh -S "$COLIMA_SOCK" -O "$1" -L "127.0.0.1:$2:127.0.0.1:$2" lima-colima >/dev/null 2>&1 &&
    log "colima: port forward $1 for :$2 done by hand"
}

SELLER_PID=
cleanup() {
  log "tearing down"
  [ -n "$SELLER_PID" ] && kill "$SELLER_PID" 2>/dev/null || true
  compose down >/dev/null 2>&1 || true
  scripts/fork.sh down || true
  [ -n "$ADDED_FORWARD" ] && colima_forward cancel "$FACILITATOR_PORT" || true
}

for p in "$FACILITATOR_PORT" "$SELLER_PORT"; do
  busy "$p" && { echo "[demo] port $p is already in use; set FACILITATOR_PORT / SELLER_PORT" >&2; exit 1; }
done
trap cleanup EXIT
mkdir -p "$FORK_STATE_DIR"

log "starting forks"
scripts/fork.sh up

log "starting facilitator ($PROJECT) on :$FACILITATOR_PORT"
compose up -d
if ! wait_for "http://localhost:$FACILITATOR_PORT/supported" 20; then
  colima_forward forward "$FACILITATOR_PORT" && ADDED_FORWARD=1
  if ! wait_for "http://localhost:$FACILITATOR_PORT/supported" 60; then
    compose logs --tail 50
    if compose logs 2>&1 | grep -q 'config.json: Is a directory'; then
      log "the container cannot see facilitator/config.json: Docker does not share this folder. With Colima, keep the clone under \$HOME."
    fi
    exit 1
  fi
fi
curl -sS "http://localhost:$FACILITATOR_PORT/supported" | jq -c '[.kinds[] | {network, scheme}]'
# The seller exits at startup if it is configured for a network the facilitator does not serve.
if curl -sS "http://localhost:$FACILITATOR_PORT/supported" | jq -e --arg n "$BTC_MAINNET" 'any(.kinds[]; .network == $n)' >/dev/null; then
  SELLER_BTC_NETWORKS=btc-mainnet
else
  SELLER_BTC_NETWORKS=
  log "the facilitator serves no exact kind on $BTC_MAINNET: the Bitcoin L1 payment will be skipped"
fi

log "starting seller on :$SELLER_PORT (logs: $FORK_STATE_DIR/seller.log)"
PORT=$SELLER_PORT FACILITATOR_URL=http://localhost:$FACILITATOR_PORT \
  SELLER_NETWORKS=eip155:743111,eip155:43111 SELLER_PAY_TO=$PAY_TO \
  SELLER_BTC_NETWORKS=$SELLER_BTC_NETWORKS SELLER_BTC_XPUB=$BTC_XPUB \
  "$ROOT/node_modules/.bin/tsx" "$ROOT/seller/server.ts" > "$FORK_STATE_DIR/seller.log" 2>&1 &
SELLER_PID=$!
wait_for "http://localhost:$SELLER_PORT/health" 30 || { cat "$FORK_STATE_DIR/seller.log"; exit 1; }

pay() { # network asset rpc
  log "paying: --network $1 --asset $2"
  # ALLOW_MAINNET is set only for this call, and only because the RPC is the local mainnet fork.
  BUYER_PRIVATE_KEY=$BUYER_KEY BUYER_RPC_URL=$3 ALLOW_MAINNET=$([ "$1" = mainnet ] && echo yes || echo no) \
    SELLER_URL="http://localhost:$SELLER_PORT/echo?demo=fork&network=$1&asset=$2" \
    npm run -s pay -w buyer -- --network "$1" --asset "$2"
}
pay testnet usdc "$TESTNET_RPC"
pay testnet btc "$TESTNET_RPC"
pay mainnet usdc "$MAINNET_RPC"
pay mainnet btc "$MAINNET_RPC"
if [ -n "$SELLER_BTC_NETWORKS" ]; then
  log "paying: --asset btc-l1 --network btc-mainnet (fabricated in the mock hBK on the mainnet fork; nothing goes to Bitcoin)"
  # ALLOW_MAINNET only because --stub-pay writes to the local mainnet fork; mock-hbk.ts refuses any non-local URL.
  ALLOW_MAINNET=yes SELLER_URL="http://localhost:$SELLER_PORT/echo?demo=fork&network=btc-mainnet&asset=btc-l1" \
    npm run -s pay -w buyer -- --asset btc-l1 --network btc-mainnet --stub-pay "$MAINNET_RPC" --poll 2
else
  log "skipping the Bitcoin L1 payment: the facilitator does not serve $BTC_MAINNET"
fi

log "seller settlement log"
grep -E '^\[seller\] (verified|settled|settle failed|verify rejected)' "$FORK_STATE_DIR/seller.log" || true

log "payTo $PAY_TO balances on the forks"
for pair in "eip155:743111 $TESTNET_RPC" "eip155:43111 $MAINNET_RPC"; do
  read -r net rpc <<<"$pair"
  jq -r --arg n "$net" '.networks[$n].assets | to_entries[] | "\(.key) \(.value.address)"' "$HEMI_JSON" |
  while read -r sym token; do
    printf '  %-14s %-8s %s base units\n' "$net" "$sym" \
      "$(cast call "$token" 'balanceOf(address)(uint256)' "$PAY_TO" --rpc-url "$rpc" | awk '{print $1}')"
  done
done
