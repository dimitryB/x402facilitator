#!/usr/bin/env bash
# Read-only on-chain spike for the Hemi x402 facilitator. Sends no transactions.
# Usage: scripts/spike.sh mainnet|testnet
set -u
NET=${1:?mainnet|testnet}
case $NET in
  mainnet) RPC=https://rpc.hemi.network/rpc;         USDC=0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA; BTC=0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28 ;;
  testnet) RPC=https://testnet.rpc.hemi.network/rpc; USDC=0xD47971C7F5B1067d25cd45d30b2c9eb60de96443; BTC=0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 ;;
  *) echo "unknown network"; exit 2 ;;
esac
DEPLOYER=0x4e59b44847b379578588920cA78FbF26c0B4956C
PERMIT2=0x000000000022D473030F116dDEE9F6B43aC78BA3
PROXY=0x402085c248EeA27D92E8b30b2C58ed07f9E20001
ANY=0x000000000000000000000000000000000000dEaD
ZERO32=0x0000000000000000000000000000000000000000000000000000000000000000
IMPL_SLOT=0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc

run() { echo "\$ $*"; out=$("$@" 2>&1); rc=$?; echo "$out"; echo "[exit $rc]"; echo; }
codeinfo() { # prints size and keccak of runtime code
  echo "\$ cast code $1 --rpc-url $RPC  # size and keccak shown"
  c=$(cast code "$1" --rpc-url "$RPC" 2>&1); rc=$?
  if [ "$c" = "0x" ]; then echo "0x (empty)"; else echo "bytes=$(( (${#c}-2)/2 )) keccak=$(cast keccak "$c")"; echo "first64=${c:0:66}"; fi
  echo "[exit $rc]"; echo
}

echo "### network=$NET rpc=$RPC  $(date -u +%FT%TZ)"; echo
run cast chain-id --rpc-url $RPC
run cast block-number --rpc-url $RPC

echo "## 1. Deterministic deployer"
run cast code $DEPLOYER --rpc-url $RPC

echo "## 2. Permit2 at canonical address"
codeinfo $PERMIT2
run cast call $PERMIT2 "DOMAIN_SEPARATOR()(bytes32)" --rpc-url $RPC
CID=$(cast chain-id --rpc-url $RPC)
echo "# expected Permit2 DOMAIN_SEPARATOR for chainId=$CID (EIP712Domain(string name,uint256 chainId,address verifyingContract), name=Permit2):"
run cast keccak $(cast abi-encode "f(bytes32,bytes32,uint256,address)" $(cast keccak "EIP712Domain(string name,uint256 chainId,address verifyingContract)") $(cast keccak "Permit2") $CID $PERMIT2)

echo "## 3. x402 exact Permit2 proxy at reference address"
codeinfo $PROXY

for T in USDC BTC; do
  A=${!T}
  echo "## Token $T $A"
  codeinfo $A
  run cast storage $A $IMPL_SLOT --rpc-url $RPC
  run cast call $A "name()(string)" --rpc-url $RPC
  run cast call $A "symbol()(string)" --rpc-url $RPC
  run cast call $A "decimals()(uint8)" --rpc-url $RPC
  run cast call $A "version()(string)" --rpc-url $RPC
  run cast call $A "eip712Domain()(bytes1,string,string,uint256,address,bytes32,uint256[])" --rpc-url $RPC
  echo "# EIP-3009"
  run cast call $A "authorizationState(address,bytes32)(bool)" $ANY $ZERO32 --rpc-url $RPC
  run cast call $A "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" $ANY $ANY 1 0 0 $ZERO32 27 $ZERO32 $ZERO32 --rpc-url $RPC
  run cast call $A "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)" $ANY $ANY 1 0 0 $ZERO32 0x --rpc-url $RPC
  echo "# EIP-2612"
  run cast call $A "DOMAIN_SEPARATOR()(bytes32)" --rpc-url $RPC
  run cast call $A "nonces(address)(uint256)" $ANY --rpc-url $RPC
  run cast call $A "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)" $ANY $ANY 1 0 27 $ZERO32 $ZERO32 --rpc-url $RPC
  echo "# control: a selector no token implements"
  run cast call $A "definitelyNotAFunction_x402()" --rpc-url $RPC
done

echo "## Extra A. EIP-712 domain of USDC.e (what an EIP-3009/2612 signer must use)"
FIAT_IMPL_SLOT=0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3  # keccak("org.zeppelinos.proxy.implementation"), Circle FiatTokenProxy
run cast storage $USDC $FIAT_IMPL_SLOT --rpc-url $RPC
N=$(cast call $USDC "name()(string)" --rpc-url $RPC | tr -d '"')
V=$(cast call $USDC "version()(string)" --rpc-url $RPC 2>/dev/null | tr -d '"')
if [ -n "$V" ]; then
  echo "# expected DOMAIN_SEPARATOR for name=\"$N\" version=\"$V\" chainId=$CID verifyingContract=$USDC:"
  run cast keccak $(cast abi-encode "f(bytes32,bytes32,bytes32,uint256,address)" $(cast keccak "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)") "$(cast keccak "$N")" "$(cast keccak "$V")" $CID $USDC)
fi

echo "## Extra B. Selector scan of runtime code (PUSH4 <selector>); proxies scanned at their implementation"
scan() { # $1 label, $2 address
  c=$(cast code "$2" --rpc-url "$RPC" | tr 'A-F' 'a-f')
  echo "# $1 $2 bytes=$(( (${#c}-2)/2 ))"
  for s in "a9059cbb transfer(address,uint256) [control]" "095ea7b3 approve(address,uint256) [control]" \
           "e3ee160e transferWithAuthorization(v,r,s)" "cf092995 transferWithAuthorization(bytes)" \
           "ef55bec6 receiveWithAuthorization(v,r,s)" "e94a0102 authorizationState(address,bytes32)" \
           "d505accf permit(address,address,uint256,uint256,uint8,bytes32,bytes32)" \
           "7ecebe00 nonces(address)" "3644e515 DOMAIN_SEPARATOR()"; do
    sel=${s%% *}; desc=${s#* }
    if [[ "$c" == *"63$sel"* ]]; then echo "  PRESENT $sel $desc"; else echo "  absent  $sel $desc"; fi
  done
  echo
}
USDC_IMPL=$(cast storage $USDC $FIAT_IMPL_SLOT --rpc-url $RPC)
if [ "$USDC_IMPL" != "$ZERO32" ]; then scan "USDC.e implementation" 0x${USDC_IMPL:26}; else scan "USDC.e" $USDC; fi
scan "BTC token" $BTC

echo "## Extra C. Permit2 bytecode identity vs Ethereum mainnet (immutables _CACHED_CHAIN_ID and _CACHED_DOMAIN_SEPARATOR substituted)"
ETH_RPC=https://eth.drpc.org
P_HERE=$(cast code $PERMIT2 --rpc-url $RPC | tr 'A-F' 'a-f')
if [ "$P_HERE" = "0x" ]; then echo "Permit2 not deployed on $NET; skipped"; echo; else
  run cast chain-id --rpc-url $ETH_RPC
  [ "$(cast chain-id --rpc-url $ETH_RPC 2>/dev/null)" = "1" ] || { echo "Ethereum RPC unreachable; Permit2 identity check skipped"; exit 0; }
  P_ETH=$(cast code $PERMIT2 --rpc-url $ETH_RPC | tr 'A-F' 'a-f')
  DS_ETH=$(cast call $PERMIT2 "DOMAIN_SEPARATOR()(bytes32)" --rpc-url $ETH_RPC | tr 'A-F' 'a-f')
  DS_HERE=$(cast call $PERMIT2 "DOMAIN_SEPARATOR()(bytes32)" --rpc-url $RPC | tr 'A-F' 'a-f')
  CID_ETH_W=$(printf '%064x' 1); CID_HERE_W=$(printf '%064x' $CID)
  echo "eth   bytes=$(( (${#P_ETH}-2)/2 )) keccak=$(cast keccak $P_ETH) DOMAIN_SEPARATOR=$DS_ETH"
  echo "eth occurrences of PUSH32 chainId=1: $(grep -o "7f$CID_ETH_W" <<<"$P_ETH" | wc -l | tr -d ' ')  PUSH32 domainSeparator: $(grep -o "7f${DS_ETH:2}" <<<"$P_ETH" | wc -l | tr -d ' ')"
  SUB=${P_ETH//7f$CID_ETH_W/7f$CID_HERE_W}; SUB=${SUB//7f${DS_ETH:2}/7f${DS_HERE:2}}
  echo "eth code with Hemi immutables keccak=$(cast keccak $SUB)"
  echo "hemi  code                        keccak=$(cast keccak $P_HERE)"
  [ "$SUB" = "$P_HERE" ] && echo "RESULT: identical to Ethereum Permit2 modulo chain-specific immutables" || echo "RESULT: DIFFERENT"
  echo
fi
