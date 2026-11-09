#!/usr/bin/env bash
# Read-only check of X402BtcSettler against the live hBK, with a real Bitcoin payment as fixture.
# Forge cannot run hVM's precompiles, so this uses cast calls against the real Hemi node. Nothing is
# sent: every call is eth_call or eth_estimateGas.
#
#   contracts/check-btc-live.sh mainnet
#   contracts/check-btc-live.sh testnet     (no usable testnet fixture yet; see docs/phase2/contracts.md)
#
# Steps:
#   1. hBK's last Bitcoin header (getLastHeader; btcLastHeader on testnet).
#   2. hBK's confirmation count for the fixture tx and the fixture output (getTxConfirmations,
#      getSpecificTxOutput; btcTxConfirmations, btcTxByTxid on testnet).
#   3. The measured confirmation offset, two ways:
#        vs hVM's header:  hbkConfirmations - (lastHeader - fixtureHeight + 1)   (= how far hVM's header
#                          lags the Bitcoin tip hBK counts against)
#        vs Bitcoin:       hbkConfirmations - (bitcoinTip - fixtureHeight + 1)    (needs BTC_TIP_URL)
#      X402BtcSettler's CONFIRMATION_OFFSET is the second.
#   4. X402BtcSettler.verify(fixture) on the settler: the deployed one if its predicted address has
#      code, otherwise the compiled one, by eth_call with a state override (the runtime code comes from
#      eth_call of the initcode against the same node, so the constructor's checks run there too).
#   5. eth_estimateGas of settle(fixture) from the facilitator's signer, same override.
#
# Environment (defaults: the mainnet fixture, a payment read through hBK on 2026-11-09):
#   BTC_FIXTURE_TXID     display byte order       0x95bca029…367e
#   BTC_FIXTURE_VOUT                              1
#   BTC_FIXTURE_SATS     expected value           83050000
#   BTC_FIXTURE_SCRIPT   expected scriptPubKey    0x0020ff64…12c4 (P2WSH)
#   BTC_FIXTURE_HEIGHT   its Bitcoin block        975189
#   BTC_MIN_CONFIRMATIONS                         1
#   BTC_TIP_URL          JSON with a "height" field for the Bitcoin tip; empty to skip.
#                        Mainnet default: https://api.blockcypher.com/v1/btc/main
#   HEMI_MAINNET_RPC_URL / HEMI_TESTNET_RPC_URL   default: Hemi public RPC
#
# Exit status: 0 if verify returns Ok with exactly BTC_FIXTURE_SATS; 1 otherwise; 2 on usage or RPC errors.
set -euo pipefail
cd "$(dirname "$0")"

die() { printf 'check-btc-live.sh: %s\n' "$*" >&2; exit 2; }
NET=${1:-}
case $NET in
  mainnet)
    CHAIN_ID=43111; RPC=${HEMI_MAINNET_RPC_URL:-https://rpc.hemi.network/rpc}
    HBK=0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12; SIGNER=0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875
    TXID=${BTC_FIXTURE_TXID:-0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e}
    VOUT=${BTC_FIXTURE_VOUT:-1}; SATS=${BTC_FIXTURE_SATS:-83050000}
    SCRIPT=${BTC_FIXTURE_SCRIPT:-0x0020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c4}
    HEIGHT=${BTC_FIXTURE_HEIGHT:-975189}
    TIP_URL=${BTC_TIP_URL-https://api.blockcypher.com/v1/btc/main}
    ;;
  testnet)
    CHAIN_ID=743111; RPC=${HEMI_TESTNET_RPC_URL:-https://testnet.rpc.hemi.network/rpc}
    HBK=0xeC9fa5daC1118963933e1A675a4EEA0009b7f215; SIGNER=0xD2B2fc8093f8A734c42B90762FD2B2F8464631af
    # Default: a coinbase that testnet hBK knew on 2026-11-09 (block 5313912 has only that tx, so its
    # merkle root is the txid). btcTxByTxid reverted for it, so expect TxNotFound. Value and script
    # are placeholders; pass a real testnet3 payment through BTC_FIXTURE_* to test one.
    TXID=${BTC_FIXTURE_TXID:-0x4bace22fb1addc1ce6b774377b28eec684770f30a7aae9a625f8887703b44c8f}
    VOUT=${BTC_FIXTURE_VOUT:-0}; SATS=${BTC_FIXTURE_SATS:-1}
    SCRIPT=${BTC_FIXTURE_SCRIPT:-0x0014000000000000000000000000000000000000000000}
    HEIGHT=${BTC_FIXTURE_HEIGHT:-5313912}
    TIP_URL=${BTC_TIP_URL-} # BlockCypher's testnet3 index is stale (tip 4997970 on 2026-11-09)
    ;;
  *) die "usage: $0 mainnet|testnet" ;;
esac
MINCONF=${BTC_MIN_CONFIRMATIONS:-1}
for tool in forge cast jq; do command -v $tool >/dev/null || die "$tool not found on PATH"; done
RPC_SHOWN=$(printf '%s' "$RPC" | sed -E 's#^([a-z]+://[^/]+).*#\1#')
got=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || die "RPC $RPC_SHOWN did not answer eth_chainId"
[ "$got" = "$CHAIN_ID" ] || die "RPC $RPC_SHOWN reports chain id $got, expected $CHAIN_ID"

VERDICTS=(Ok AlreadyConsumed TxNotFound OutputNotFound ScriptMismatch OpReturn BelowAmount TooFewConfirmations HbkError)
HEADER='((uint32,bytes32,uint32,bytes32,bytes32,uint32,uint32,uint32))'
OUTPUT='((uint256,bytes,string,bool,bytes,bool,uint256,bool))'
# eth_call returning raw hex; on a revert prints "REVERT <reason>" and fails.
raw_call() { # to data [overrides-json]
  local params out
  params="{\"to\":\"$1\",\"data\":\"$2\",\"gas\":\"0x1c9c380\"}"
  if out=$(cast rpc eth_call "$params" latest ${3:+"$3"} --rpc-url "$RPC" 2>&1); then
    printf '%s' "$out" | tr -d '"'
  else
    printf 'REVERT %s' "$(printf '%s' "$out" | grep -oE 'execution reverted[^,]*(, data: "?0x[0-9a-f]*)?' | head -1)"
    return 1
  fi
}

echo "== Hemi $NET (chain id $CHAIN_ID) via $RPC_SHOWN, Hemi block $(cast block-number --rpc-url "$RPC")"
echo "   hBK $HBK"
echo "   fixture tx $TXID vout $VOUT, expected $SATS sats to $SCRIPT, Bitcoin block $HEIGHT"
echo

if [ "$NET" = mainnet ]; then
  sig_header='getLastHeader()'; sig_conf='getTxConfirmations(bytes32)'
else
  sig_header='btcLastHeader()'; sig_conf='btcTxConfirmations(bytes32)'
fi

r=$(raw_call "$HBK" "$(cast calldata "$sig_header")") || die "$sig_header: $r"
last=$(cast decode-abi "f()$HEADER" "$r" | sed -E 's/^\(([0-9]+).*/\1/')
echo "1. $sig_header: height $last"

if r=$(raw_call "$HBK" "$(cast calldata "$sig_conf" "$TXID")"); then
  hbk_conf=$(cast decode-abi 'f()(uint32)' "$r")
  echo "2. $sig_conf: $hbk_conf"
else
  hbk_conf=""
  echo "2. $sig_conf: $r"
fi

if [ "$NET" = mainnet ]; then
  if r=$(raw_call "$HBK" "$(cast calldata 'getSpecificTxOutput(bytes32,uint32)' "$TXID" "$VOUT")"); then
    echo "   getSpecificTxOutput(vout $VOUT): $(cast decode-abi "f()$OUTPUT" "$r")"
    echo "     (outValue, script, outputAddress, isOpReturn, opReturnData, isSpent, fullScriptLength, containsFullScript)"
  else
    echo "   getSpecificTxOutput(vout $VOUT): $r"
  fi
else
  if r=$(raw_call "$HBK" "$(cast calldata 'btcTxByTxid(bytes32)' "$TXID")"); then
    echo "   btcTxByTxid: answered, $(( (${#r} - 2) / 2 )) bytes"
  else
    echo "   btcTxByTxid: $r"
  fi
fi

echo
echo "3. Confirmation offset"
if [ -n "$hbk_conf" ]; then
  hvm_view=$((last - HEIGHT + 1))
  echo "   vs hVM's header: hBK $hbk_conf - (lastHeader $last - $HEIGHT + 1 = $hvm_view) = $((hbk_conf - hvm_view))"
  if [ -n "$TIP_URL" ]; then
    tip=$(curl -fsS --max-time 20 "$TIP_URL" 2>/dev/null | jq -r '.height // empty' 2>/dev/null || true)
    if [[ $tip =~ ^[0-9]+$ ]]; then
      btc_conf=$((tip - HEIGHT + 1))
      echo "   vs Bitcoin:      hBK $hbk_conf - (tip $tip - $HEIGHT + 1 = $btc_conf) = $((hbk_conf - btc_conf))   (tip from $(printf '%s' "$TIP_URL" | sed -E 's#^([a-z]+://[^/]+).*#\1#'))"
    else
      echo "   vs Bitcoin:      skipped, $TIP_URL did not answer with a height"
    fi
  else
    echo "   vs Bitcoin:      skipped (BTC_TIP_URL empty)"
  fi
else
  echo "   not measurable: hBK gave no confirmation count"
fi

echo
echo "4. X402BtcSettler.verify"
plan=$(forge script script/DeployBtcSettler.s.sol:DeployBtcSettler --sig 'plan()' --rpc-url "$RPC" 2>&1) ||
  { printf '%s\n' "$plan" | tail -20; die "forge script plan() failed"; }
overrides="" settler=""
while read -r _ name addr has data; do
  if [ "$has" = 1 ]; then
    echo "   $name $addr: deployed"
  else
    # Contract creation by eth_call (no "to"), with the overrides so far: the testnet settler's
    # constructor checks that the adapter has code.
    rt=$(cast rpc eth_call "{\"data\":\"0x${data:66}\",\"gas\":\"0x1c9c380\"}" latest \
      ${overrides:+"{$overrides}"} --rpc-url "$RPC" 2>&1 | tr -d '"') && [[ $rt =~ ^0x[0-9a-f]+$ ]] ||
      die "creating $name by eth_call failed: $rt"
    overrides+="${overrides:+,}\"$addr\":{\"code\":\"$rt\"}"
    echo "   $name $addr: not deployed; using the compiled code as a state override ($(( (${#rt} - 2) / 2 )) bytes)"
  fi
  [ "$name" = X402BtcSettler ] && settler=$addr
done < <(printf '%s\n' "$plan" | grep -E '^\s*PLAN ')
[ -n "$settler" ] || die "plan() listed no settler"
ov=${overrides:+"{$overrides}"}

r=$(raw_call "$settler" "$(cast calldata 'CONFIRMATION_OFFSET()')" "$ov") || die "CONFIRMATION_OFFSET(): $r"
echo "   CONFIRMATION_OFFSET() = $(cast decode-abi 'f()(uint32)' "$r")"
vdata=$(cast calldata 'verify(bytes32,uint32,bytes,uint64,uint32)' "$TXID" "$VOUT" "$SCRIPT" "$SATS" "$MINCONF")
r=$(raw_call "$settler" "$vdata" "$ov") || die "verify reverted, which it must never do: $r"
read -r v sats hconf conf spent ref < <(cast decode-abi 'f()((uint8,uint64,uint32,uint32,bool,bytes32))' "$r" |
  sed -E 's/ \[[^]]*\]//g; s/[(),]/ /g')
echo "   verify(txid, $VOUT, script, $SATS, minConfirmations $MINCONF):"
echo "     verdict ${VERDICTS[$v]:-unknown($v)}, sats $sats, hbkConfirmations $hconf, confirmations $conf, isSpent $spent, settledBy $ref"

echo
echo "5. settle gas (eth_estimateGas from the facilitator's signer $SIGNER; nothing is sent)"
sdata=$(cast calldata 'settle(bytes32,uint32,bytes,uint64,uint32,bytes32)' "$TXID" "$VOUT" "$SCRIPT" "$SATS" "$MINCONF" \
  0x1111111111111111111111111111111111111111111111111111111111111111)
params="{\"from\":\"$SIGNER\",\"to\":\"$settler\",\"data\":\"$sdata\"}"
if g=$(cast rpc eth_estimateGas "$params" latest ${ov:+"$ov"} --rpc-url "$RPC" 2>&1); then
  echo "   settle: $(cast to-dec "$(printf '%s' "$g" | tr -d '"')") gas"
else
  echo "   settle: would revert: $(printf '%s' "$g" | grep -oE 'execution reverted[^,]*(, data: "?0x[0-9a-f]*)?' | head -1)"
fi

echo
if [ "${VERDICTS[$v]:-}" = Ok ] && [ "$sats" = "$SATS" ]; then
  echo "OK: verify returned Ok with $sats sats."
  exit 0
fi
echo "NOT OK: verify returned ${VERDICTS[$v]:-unknown($v)} with $sats sats (expected Ok with $SATS)."
exit 1
