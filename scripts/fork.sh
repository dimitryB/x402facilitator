#!/usr/bin/env bash
# Local Hemi forks for tests and demos. Nothing here touches a live network:
# anvil forks read state from the public RPCs and keep every write local.
#
#   scripts/fork.sh up      start forks, deploy the three canonical contracts, fund the buyer
#   scripts/fork.sh down    stop the forks this script started
#   scripts/fork.sh status  show what is running
#
# Environment (all optional):
#   FORK_TESTNET_PORT (8545)  FORK_MAINNET_PORT (8546)
#   FORK_TESTNET_UPSTREAM / FORK_MAINNET_UPSTREAM   RPCs to fork from (default: Hemi public RPCs)
#   FORK_BLOCK_TESTNET / FORK_BLOCK_MAINNET          pin a fork block for reproducibility
#   FORK_BUYER (anvil account #3)                    address funded with ETH and tokens
#   FORK_STATE_DIR (.scratch/fork)
#
# If the upstream refuses at startup (the public RPC rate-limits at ~300 req/min), the script
# retries once against dRPC. On testnet it does so only with a pinned block: dRPC testnet's
# eth_blockNumber lags ~2.9M blocks (DECISIONS.md D-015), so an unpinned fork would start there.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
STATE=${FORK_STATE_DIR:-$ROOT/.scratch/fork}
TP=${FORK_TESTNET_PORT:-8545}
MP=${FORK_MAINNET_PORT:-8546}
T_UP=${FORK_TESTNET_UPSTREAM:-https://testnet.rpc.hemi.network/rpc}
M_UP=${FORK_MAINNET_UPSTREAM:-https://rpc.hemi.network/rpc}
T_ALT=https://hemi-testnet.drpc.org
M_ALT=https://hemi.drpc.org
BUYER=${FORK_BUYER:-0x90F79bf6EB2c4f870365E785982E1f101E93b906}
# anvil's well-known dev account #0; it only ever signs on the local fork.
DEPLOYER_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
DEPLOYER=0x4e59b44847b379578588920cA78FbF26c0B4956C
HEMI_JSON=$ROOT/shared/hemi.json

log() { printf '[fork] %s\n' "$*" >&2; }

is_our_anvil() { # pidfile
  [ -f "$1" ] || return 1
  local pid; pid=$(cat "$1")
  ps -p "$pid" -o comm= 2>/dev/null | grep -q anvil
}

launch() { # name port upstream block -> 0 if the fork answers
  local name=$1 port=$2 up=$3 block=${4:-}
  local args=(--fork-url "$up" --port "$port" --host 0.0.0.0 --silent --fork-retry-backoff 1000 --retries 8 --timeout 45000)
  [ -n "$block" ] && args+=(--fork-block-number "$block")
  nohup anvil "${args[@]}" > "$STATE/$name.log" 2>&1 &
  echo $! > "$STATE/$name.pid"
  for _ in $(seq 1 60); do
    cast chain-id --rpc-url "http://127.0.0.1:$port" >/dev/null 2>&1 && return 0
    is_our_anvil "$STATE/$name.pid" || return 1   # anvil exited (e.g. upstream 429 at startup)
    sleep 1
  done
  kill "$(cat "$STATE/$name.pid")" 2>/dev/null || true
  return 1
}

start_one() { # name port upstream alt-upstream block expected-chain-id
  local name=$1 port=$2 up=$3 alt=$4 block=${5:-} want=$6
  local cid
  if cid=$(cast chain-id --rpc-url "http://127.0.0.1:$port" 2>/dev/null); then
    [ "$cid" = "$want" ] || { log "port $port answers with chain $cid, expected $want; refusing to reuse it"; exit 1; }
    is_our_anvil "$STATE/$name.pid" || { log "port $port is chain $want but was not started from $STATE; stop it or pick another port"; exit 1; }
    log "$name fork already running on :$port (pid $(cat "$STATE/$name.pid"))"; return
  fi
  if ! launch "$name" "$port" "$up" "$block"; then
    if [ "$name" = testnet ] && [ -z "$block" ]; then
      log "$name fork failed against $up; not retrying on dRPC without FORK_BLOCK_TESTNET (see $STATE/$name.log)"; exit 1
    fi
    log "$name fork failed against $up; retrying against $alt"
    launch "$name" "$port" "$alt" "$block" || { log "$name fork failed; see $STATE/$name.log"; exit 1; }
  fi
  cid=$(cast chain-id --rpc-url "http://127.0.0.1:$port")
  [ "$cid" = "$want" ] || { log "$name fork reports chain $cid, expected $want"; exit 1; }
  if [ -n "$block" ]; then
    # A pinned fork starts at that block's timestamp; move the clock to now so
    # validAfter/validBefore windows behave as on the live chain.
    cast rpc evm_setNextBlockTimestamp "$(date +%s)" --rpc-url "http://127.0.0.1:$port" >/dev/null
    cast rpc evm_mine --rpc-url "http://127.0.0.1:$port" >/dev/null
  fi
  log "$name fork up on :$port (pid $(cat "$STATE/$name.pid"))"
}

deploy_canonical() { # rpc
  local rpc=$1
  for c in permit2 validator6492 exact-proxy; do
    local addr
    case $c in
      permit2) addr=$(jq -r .contracts.permit2 "$HEMI_JSON") ;;
      validator6492) addr=$(jq -r .contracts.validator6492 "$HEMI_JSON") ;;
      exact-proxy) addr=$(jq -r .contracts.x402ExactPermit2Proxy "$HEMI_JSON") ;;
    esac
    if [ "$(cast code "$addr" --rpc-url "$rpc")" != "0x" ]; then log "  $c already at $addr"; continue; fi
    cast send "$DEPLOYER" "$(cat "$ROOT/contracts/deploy-data/$c.calldata.hex")" \
      --private-key "$DEPLOYER_KEY" --rpc-url "$rpc" >/dev/null
    [ "$(cast code "$addr" --rpc-url "$rpc")" != "0x" ] || { log "  $c deployment did not land at $addr"; exit 1; }
    log "  $c deployed at $addr"
  done
}

fund() { # rpc network
  local rpc=$1 net=$2
  cast rpc anvil_setBalance "$BUYER" 0x8ac7230489e80000 --rpc-url "$rpc" >/dev/null   # 10 ETH
  jq -r --arg n "$net" '.networks[$n].assets | to_entries[] | "\(.key) \(.value.address) \(.value.decimals) \(.value.balanceSlot)"' "$HEMI_JSON" |
  while read -r sym token decimals slot; do
    # 1000 whole tokens, written straight into the balanceOf mapping slot (D-013).
    local amount; amount=$(cast to-uint256 $((1000 * 10**decimals)))
    cast rpc anvil_setStorageAt "$token" "$(cast index address "$BUYER" "$slot")" "$amount" --rpc-url "$rpc" >/dev/null
    log "  buyer $BUYER holds $(cast call "$token" 'balanceOf(address)(uint256)' "$BUYER" --rpc-url "$rpc" | awk '{print $1}') base units of $sym"
  done
}

case ${1:-} in
  up)
    mkdir -p "$STATE"
    start_one testnet "$TP" "$T_UP" "$T_ALT" "${FORK_BLOCK_TESTNET:-}" 743111
    start_one mainnet "$MP" "$M_UP" "$M_ALT" "${FORK_BLOCK_MAINNET:-}" 43111
    log "testnet fork: deploying canonical contracts"; deploy_canonical "http://127.0.0.1:$TP"
    log "mainnet fork: deploying canonical contracts"; deploy_canonical "http://127.0.0.1:$MP"
    log "funding buyer"; fund "http://127.0.0.1:$TP" eip155:743111; fund "http://127.0.0.1:$MP" eip155:43111
    log "ready: testnet fork http://127.0.0.1:$TP  mainnet fork http://127.0.0.1:$MP"
    ;;
  down)
    for n in testnet mainnet; do
      if is_our_anvil "$STATE/$n.pid"; then kill "$(cat "$STATE/$n.pid")"; log "stopped $n fork"
      elif [ -f "$STATE/$n.pid" ]; then log "$n pid $(cat "$STATE/$n.pid") is not anvil any more; not killing it"; fi
      rm -f "$STATE/$n.pid"
    done
    ;;
  status)
    for n in testnet mainnet; do
      port=$([ $n = testnet ] && echo "$TP" || echo "$MP")
      if cid=$(cast chain-id --rpc-url "http://127.0.0.1:$port" 2>/dev/null); then echo "$n :$port chainId=$cid"; else echo "$n :$port down"; fi
    done
    ;;
  *) echo "usage: $0 up|down|status" >&2; exit 2 ;;
esac
