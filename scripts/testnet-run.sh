#!/usr/bin/env bash
# Live Hemi TESTNET run: deploy the canonical contracts if missing, start the facilitator and the
# demo seller, pay once in USDC.e and once in hBTC, and record the evidence in docs/testnet-run.md.
#
#   scripts/testnet-run.sh            check balances and print what is missing (sends nothing)
#   scripts/testnet-run.sh --go       do the run
#   ASSETS=usdc scripts/testnet-run.sh --go    pay in one asset only (default: "usdc btc")
#
# Each run appends a section to docs/testnet-run.md, so runs for different assets accumulate.
#
# Reads .env: FACILITATOR_TESTNET_PRIVATE_KEY (deploys contracts and pays settlement gas),
# BUYER_PRIVATE_KEY, SELLER_PAY_TO. Testnet only; this script never touches mainnet.
#
# It stops before sending anything if FACILITATOR_PORT or SELLER_PORT (default 8080, 4021) is in use.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
[ -f .env ] && { set -a; . ./.env; set +a; }
# Its own Compose project: `up` and `down` below must not replace or remove a facilitator started
# from this checkout with plain `docker compose`, such as the README's mainnet deployment.
export COMPOSE_PROJECT_NAME=hemi-x402-testnet-run

RPC=${HEMI_TESTNET_RPC_FALLBACK:-https://testnet.rpc.hemi.network/rpc}
EXPLORER=https://testnet.explorer.hemi.xyz
USDC=$(jq -r '.networks["eip155:743111"].assets["USDC.e"].address' shared/hemi.json)
HBTC=$(jq -r '.networks["eip155:743111"].assets.hBTC.address' shared/hemi.json)
FPORT=${FACILITATOR_PORT:-8080}
SPORT=${SELLER_PORT:-4021}
OUT=$ROOT/docs/testnet-run.md
LOGDIR=$ROOT/.scratch/testnet-run
mkdir -p "$LOGDIR"
ASSETS=${ASSETS:-usdc btc}
for a in $ASSETS; do case $a in usdc|btc) ;; *) printf 'testnet-run: unknown asset %s (usdc, btc)\n' "$a" >&2; exit 1 ;; esac; done
wants() { [[ " $ASSETS " == *" $1 "* ]]; }

die() { printf 'testnet-run: %s\n' "$*" >&2; exit 1; }
for v in FACILITATOR_TESTNET_PRIVATE_KEY BUYER_PRIVATE_KEY SELLER_PAY_TO; do
  [ -n "${!v:-}" ] || die "$v is not set (see .env.example)"
done
[ "$(cast chain-id --rpc-url "$RPC")" = 743111 ] || die "$RPC is not Hemi testnet"

FAC=$(cast wallet address "$FACILITATOR_TESTNET_PRIVATE_KEY")
BUYER=$(cast wallet address "$BUYER_PRIVATE_KEY")
bal() { cast call "$1" 'balanceOf(address)(uint256)' "$2" --rpc-url "$RPC" | awk '{print $1}'; }
# a >= b for decimal integers of any size: bash integers end at 2^63-1 wei, about 9.2 ETH.
ge() {
  [[ $1 =~ ^[0-9]+$ && $2 =~ ^[0-9]+$ ]] || return 1
  if [ ${#1} -ne ${#2} ]; then [ ${#1} -gt ${#2} ]; else ! [[ $1 < $2 ]]; fi
}

# Minimums: deployment is ~4.8M gas and each settle ~100k gas at ~0.001 gwei; approvals ~50k gas.
NEED_FAC_WEI=1000000000000000      # 0.001 ETH
NEED_BUYER_WEI=100000000000000     # 0.0001 ETH
NEED_USDC=1000                     # 0.001 USDC.e (one payment)
NEED_HBTC=1                        # 1 sat (one payment)

fac_eth=$(cast balance "$FAC" --rpc-url "$RPC"); buyer_eth=$(cast balance "$BUYER" --rpc-url "$RPC")
buyer_usdc=$(bal "$USDC" "$BUYER"); buyer_hbtc=$(bal "$HBTC" "$BUYER")
echo "facilitator/deployer $FAC  ETH=$(cast from-wei "$fac_eth")"
echo "buyer                $BUYER  ETH=$(cast from-wei "$buyer_eth")  USDC.e=$buyer_usdc  hBTC=$buyer_hbtc (base units)"
echo "seller payTo         $SELLER_PAY_TO"
missing=0
ge "$fac_eth" $NEED_FAC_WEI || { echo "MISSING: send >= 0.001 testnet ETH to $FAC"; missing=1; }
ge "$buyer_eth" $NEED_BUYER_WEI || { echo "MISSING: send >= 0.0001 testnet ETH to $BUYER (for the one-time approve(Permit2) per token)"; missing=1; }
! wants usdc || ge "$buyer_usdc" $NEED_USDC || { echo "MISSING: send >= 0.001 testnet USDC.e ($USDC) to $BUYER (scripts/testnet-fund-usdc.sh mints and tunnels it)"; missing=1; }
! wants btc || ge "$buyer_hbtc" $NEED_HBTC || { echo "MISSING: send >= 1 sat of testnet hBTC ($HBTC) to $BUYER (Bitcoin testnet3 via the Bitcoin tunnel; see README)"; missing=1; }
[ "${1:-}" = --go ] || { [ $missing = 0 ] && echo "Balances OK for: $ASSETS. Re-run with --go."; exit $missing; }
[ $missing = 0 ] || die "fund the addresses above first"

# A taken port would leave this run talking to whatever listens there, and a seller with another
# payTo would be paid. The seller is checked again once it runs (step 3).
port_taken() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null || (exec 3<>"/dev/tcp/::1/$1") 2>/dev/null; }
for port in "$FPORT" "$SPORT"; do
  ! port_taken "$port" || die "port $port is in use; stop what listens there, or set FACILITATOR_PORT or SELLER_PORT"
done

cleanup() {
  [ -n "${SELLER_PID:-}" ] && kill "$SELLER_PID" 2>/dev/null || true
  docker compose logs --no-color facilitator > "$LOGDIR/facilitator.log" 2>&1 || true
  FACILITATOR_CONFIG=config.testnet.json docker compose down >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "== 1. contracts"
# Deploy with the facilitator's testnet key: it is the wallet whose balance was checked above.
# deploy.sh would otherwise pick DEPLOYER_PRIVATE_KEY from .env, which may be a mainnet key.
DEPLOYER_PRIVATE_KEY=$FACILITATOR_TESTNET_PRIVATE_KEY contracts/deploy.sh testnet --broadcast 2>&1 | tee "$LOGDIR/deploy.log"
contracts/verify.sh testnet 2>&1 | tee "$LOGDIR/verify.log" || echo "(verification is best effort; see contracts/README.md)"

echo "== 2. facilitator (testnet config)"
FACILITATOR_CONFIG=config.testnet.json FACILITATOR_BIND=127.0.0.1 FACILITATOR_PORT=$FPORT docker compose up -d
for _ in $(seq 1 60); do curl -sf "localhost:$FPORT/supported" >/dev/null && break; sleep 2; done
curl -sS "localhost:$FPORT/supported" | tee "$LOGDIR/supported.json" | jq -c '.kinds[] | {network, scheme}'

echo "== 3. seller"
FACILITATOR_URL=http://localhost:$FPORT SELLER_NETWORKS=eip155:743111 PORT=$SPORT \
  npm run start -w seller > "$LOGDIR/seller.log" 2>&1 &
SELLER_PID=$!
health=
for _ in $(seq 1 30); do
  kill -0 "$SELLER_PID" 2>/dev/null || die "the seller exited; see $LOGDIR/seller.log"
  health=$(curl -sf "localhost:$SPORT/health") && break
  sleep 1
done
[ -n "$health" ] || die "the seller did not answer on port $SPORT; see $LOGDIR/seller.log"
jq -e --arg payTo "$SELLER_PAY_TO" --arg facilitator "http://localhost:$FPORT" \
  '(.payTo | ascii_downcase) == ($payTo | ascii_downcase)
   and .networks == ["eip155:743111"] and .facilitator == $facilitator' <<<"$health" >/dev/null \
  || die "the seller on port $SPORT is not this run's seller: $health"

echo "== 4. payments"
pay() { # asset
  SELLER_URL="http://localhost:$SPORT/echo?run=testnet&asset=$1" BUYER_RPC_URL="$RPC" \
    npm run pay -w buyer -- --asset "$1" --network testnet 2>&1 | tee "$LOGDIR/pay-$1.log"
}
txof() { cat "$LOGDIR/tx-$1"; }   # bash 3.2 (macOS) has no associative arrays
for a in $ASSETS; do
  rm -f "$LOGDIR/tx-$a"
  pay "$a"
  grep -o 'tx: *0x[0-9a-fA-F]\{64\}' "$LOGDIR/pay-$a.log" | grep -o '0x.*' | head -1 > "$LOGDIR/tx-$a" || true
  [ -s "$LOGDIR/tx-$a" ] || die "the $a payment did not settle; see $LOGDIR"
done

receipt_line() { # tx
  local r; r=$(cast receipt "$1" --rpc-url "$RPC" --json | jq '.data // .')
  echo "status=$(echo "$r" | jq -r .status) block=$(( $(echo "$r" | jq -r .blockNumber) )) from=$(echo "$r" | jq -r .from) to=$(echo "$r" | jq -r .to)"
}
tip_line() { # tx
  echo "tip $(( $(cast tx "$1" maxPriorityFeePerGas --rpc-url "$RPC") )) wei"
}

[ -f "$OUT" ] || printf '# Live testnet runs\n\nEach section is one run of `scripts/testnet-run.sh --go` against Hemi testnet (`eip155:743111`).\n' > "$OUT"
{
  echo
  echo "## Run on $(date -u +%FT%TZ): $ASSETS"
  echo
  echo "Facilitator image \`$(docker compose config --images facilitator 2>/dev/null | head -1)\`."
  echo
  echo "| Payment | Settlement tx | Receipt |"
  echo "|------|------|------|"
  for a in $ASSETS; do
    case $a in usdc) label="USDC.e \`$USDC\` (Permit2)" ;; btc) label="hBTC \`$HBTC\` (Permit2)" ;; esac
    tx=$(txof "$a")
    echo "| $label | [\`$tx\`]($EXPLORER/tx/$tx) | $(receipt_line "$tx"), $(tip_line "$tx") |"
  done
  echo
  echo "The facilitator signer is \`$FAC\`; the buyer is \`$BUYER\`; payTo is \`$SELLER_PAY_TO\`."
  echo
  echo "Seller log: each payment is verified by the facilitator's /verify, then settled by its /settle:"
  echo
  echo '```'
  grep -E '^\[seller\] (verified|settled|verify rejected|settle failed)' "$LOGDIR/seller.log" || true
  echo '```'
  echo
  echo "Buyer output:"
  echo
  echo '```'
  for a in $ASSETS; do grep '^\[buyer\]' "$LOGDIR/pay-$a.log" | sed "s#^#pay-$a: #"; done
  echo '```'
} >> "$OUT"
echo "== recorded in $OUT"
