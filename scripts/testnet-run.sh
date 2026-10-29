#!/usr/bin/env bash
# Live Hemi TESTNET run: deploy the canonical contracts if missing, start the facilitator and the
# demo seller, pay once in USDC.e and once in hBTC, and record the evidence in docs/testnet-run.md.
#
#   scripts/testnet-run.sh            check balances and print what is missing (sends nothing)
#   scripts/testnet-run.sh --go       do the run
#
# Reads .env: FACILITATOR_TESTNET_PRIVATE_KEY (deploys contracts and pays settlement gas),
# BUYER_PRIVATE_KEY, SELLER_PAY_TO. Testnet only; this script never touches mainnet.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
[ -f .env ] && { set -a; . ./.env; set +a; }

RPC=${HEMI_TESTNET_RPC_FALLBACK:-https://testnet.rpc.hemi.network/rpc}
EXPLORER=https://testnet.explorer.hemi.xyz
USDC=$(jq -r '.networks["eip155:743111"].assets["USDC.e"].address' shared/hemi.json)
HBTC=$(jq -r '.networks["eip155:743111"].assets.hBTC.address' shared/hemi.json)
FPORT=${FACILITATOR_PORT:-8080}
SPORT=${SELLER_PORT:-4021}
OUT=$ROOT/docs/testnet-run.md
LOGDIR=$ROOT/.scratch/testnet-run
mkdir -p "$LOGDIR"

die() { printf 'testnet-run: %s\n' "$*" >&2; exit 1; }
for v in FACILITATOR_TESTNET_PRIVATE_KEY BUYER_PRIVATE_KEY SELLER_PAY_TO; do
  [ -n "${!v:-}" ] || die "$v is not set (see .env.example)"
done
[ "$(cast chain-id --rpc-url "$RPC")" = 743111 ] || die "$RPC is not Hemi testnet"

FAC=$(cast wallet address "$FACILITATOR_TESTNET_PRIVATE_KEY")
BUYER=$(cast wallet address "$BUYER_PRIVATE_KEY")
bal() { cast call "$1" 'balanceOf(address)(uint256)' "$2" --rpc-url "$RPC" | awk '{print $1}'; }

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
[ "$fac_eth" -ge $NEED_FAC_WEI ] || { echo "MISSING: send >= 0.001 testnet ETH to $FAC"; missing=1; }
[ "$buyer_eth" -ge $NEED_BUYER_WEI ] || { echo "MISSING: send >= 0.0001 testnet ETH to $BUYER (for the one-time approve(Permit2) per token)"; missing=1; }
[ "$buyer_usdc" -ge $NEED_USDC ] || { echo "MISSING: send >= 0.001 testnet USDC.e ($USDC) to $BUYER"; missing=1; }
[ "$buyer_hbtc" -ge $NEED_HBTC ] || { echo "MISSING: send >= 1 sat of testnet hBTC ($HBTC) to $BUYER"; missing=1; }
[ "${1:-}" = --go ] || { [ $missing = 0 ] && echo "Balances OK. Re-run with --go."; exit $missing; }
[ $missing = 0 ] || die "fund the addresses above first"

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
FACILITATOR_CONFIG=config.testnet.json FACILITATOR_PORT=$FPORT docker compose up -d
for _ in $(seq 1 60); do curl -sf "localhost:$FPORT/supported" >/dev/null && break; sleep 2; done
curl -sS "localhost:$FPORT/supported" | tee "$LOGDIR/supported.json" | jq -c '.kinds[] | {network, scheme}'

echo "== 3. seller"
FACILITATOR_URL=http://localhost:$FPORT SELLER_NETWORKS=eip155:743111 PORT=$SPORT \
  npm run start -w seller > "$LOGDIR/seller.log" 2>&1 &
SELLER_PID=$!
for _ in $(seq 1 30); do curl -sf "localhost:$SPORT/health" >/dev/null && break; sleep 1; done

echo "== 4. payments"
pay() { # asset
  SELLER_URL="http://localhost:$SPORT/echo?run=testnet&asset=$1" BUYER_RPC_URL="$RPC" \
    npm run pay -w buyer -- --asset "$1" --network testnet 2>&1 | tee "$LOGDIR/pay-$1.log"
}
pay usdc; pay btc
USDC_TX=$(grep -o 'tx: *0x[0-9a-fA-F]\{64\}' "$LOGDIR/pay-usdc.log" | grep -o '0x.*')
BTC_TX=$(grep -o 'tx: *0x[0-9a-fA-F]\{64\}' "$LOGDIR/pay-btc.log" | grep -o '0x.*')
[ -n "$USDC_TX" ] && [ -n "$BTC_TX" ] || die "a payment did not settle; see $LOGDIR"

receipt_line() { # tx
  local r; r=$(cast receipt "$1" --rpc-url "$RPC" --json | jq '.data // .')
  echo "status=$(echo "$r" | jq -r .status) block=$(( $(echo "$r" | jq -r .blockNumber) )) from=$(echo "$r" | jq -r .from) to=$(echo "$r" | jq -r .to)"
}

{
  echo "# Live testnet run"
  echo
  echo "Run on $(date -u +%FT%TZ) by \`scripts/testnet-run.sh --go\` against Hemi testnet (\`eip155:743111\`)."
  echo
  echo "| Payment | Settlement tx | Receipt |"
  echo "|------|------|------|"
  echo "| USDC.e \`$USDC\` (Permit2) | [\`$USDC_TX\`]($EXPLORER/tx/$USDC_TX) | $(receipt_line "$USDC_TX") |"
  echo "| hBTC \`$HBTC\` (Permit2) | [\`$BTC_TX\`]($EXPLORER/tx/$BTC_TX) | $(receipt_line "$BTC_TX") |"
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
  grep '^\[buyer\]' "$LOGDIR/pay-usdc.log" "$LOGDIR/pay-btc.log" | sed 's#^.*/pay-#pay-#'
  echo '```'
} > "$OUT"
echo "== recorded in $OUT"
