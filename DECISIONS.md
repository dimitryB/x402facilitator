# Decisions

Each entry records what was checked, the exact command run and its output. Entries marked "verify" in the brief's shared context get one entry each. Full, unedited transcripts of every spike command are in [docs/spike/](docs/spike/). Each can be regenerated read-only with `scripts/spike.sh mainnet|testnet`, which sends no transactions.

All spike entries ran on 2026-10-29 (UTC) from the local workstation with Foundry `cast 1.8.6`. Mainnet height was 5614307 and testnet height was 7093964.

## Verify items: results

| Item | Mainnet (eip155:43111) | Testnet (eip155:743111) | Entry |
|------|------|------|------|
| RPCs answer with the right chain id | yes, both | yes, both | D-002 |
| Deterministic deployer `0x4e59…956C` | present | present | D-003 |
| Permit2 at canonical `0x0000…8BA3` | present, genuine | **absent** | D-004 |
| x402 exact proxy at `0x4020…0001` | **absent** | **absent** | D-005 |
| EIP-6492 validator at `0xdAcD…2a3B` (required by x402-rs at startup) | **absent** | **absent** | D-006 |
| Multicall3 at `0xcA11…CA11` | present, genuine | present, genuine | D-006 |
| USDC.e address | `0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA` | `0xD47971C7F5B1067d25cd45d30b2c9eb60de96443` | D-007 |
| hemiBTC address | `0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28` | none; tunnel BTC is hBTC `0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7` | D-008 |
| USDC.e implements EIP-3009 | **yes** | **no** | D-009 |
| USDC.e implements EIP-2612 | **yes** | **no** | D-010 |
| hemiBTC / hBTC implements EIP-3009 or EIP-2612 | no | no | D-011 |
| hBK contract and precompiles (phase 2) | contract live (`getLastHeader` decodes); precompile `0x44` answers | contract present but `getLastHeader` reverts; precompile `0x44` answers | D-012 |

## D-001. Spike result: transfer method per asset and network

| Asset | Network | Transfer method | Buyer needs ETH on Hemi? |
|------|------|------|------|
| USDC.e | mainnet | `exact` with EIP-3009 `transferWithAuthorization` | No |
| hemiBTC | mainnet | `exact` with Permit2 through the x402 exact proxy | Yes, once, for `approve(Permit2)` |
| USDC.e | testnet | `exact` with Permit2 | Yes, once |
| hBTC (testnet stand-in for hemiBTC) | testnet | `exact` with Permit2 | Yes, once |

Facts behind the table:

- Mainnet USDC.e is Circle's FiatToken v2.2 behind a FiatTokenProxy (D-009, D-010). Its EIP-712 domain is name `Bridged USDC (Stargate)` and version `2`, and both must go in `extra` of the payment requirements.
- Testnet USDC.e is a different contract, a plain tunnel-bridged ERC-20 with no EIP-3009 and no EIP-2612. The testnet therefore cannot exercise the mainnet USDC.e path. The EIP-3009 path is tested against a local anvil fork of Hemi mainnet instead (see D-013).
- Mainnet USDC.e supports EIP-2612, but it settles through EIP-3009, so the facilitator's EIP-2612 gas-sponsoring extension is never needed for the MVP's assets. hemiBTC and both testnet tokens lack EIP-2612. x402-rs at `e75adda` implements only the EIP-2612 sponsoring extension, not the TS SDK's ERC-20 approval sponsoring, so those buyers send one on-chain `approve(Permit2)`.

What must be deployed before stock x402-rs will start a chain. `assert_contracts_exists` in `chain/provider.rs:446` refuses to start a chain unless the validator, Permit2 and the exact proxy all have code.

| Contract | Mainnet | Testnet | How |
|------|------|------|------|
| Permit2 | already there | deploy | replay Uniswap's original CREATE2 call to `0x4e59…` (D-004) |
| EIP-6492 validator | deploy | deploy | replay x402-rs's original CREATE2 call (D-006) |
| x402 exact proxy | deploy | deploy | reference repo's committed initCode via `0x4e59…` (D-005) |

Every deployment lands at the canonical address, so stock x402-rs, stock TS buyers and the stock proxy all work with no fork. The mainnet deployments waited for an explicit go and ran on 2026-11-04 (D-029). The estimated cost is in D-005.

## D-002. RPC reachability and the local network

```
$ curl -sS -X POST -H 'content-type: application/json' --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}' <url>
https://rpc.hemi.network/rpc          {"jsonrpc":"2.0","id":1,"result":"0xa867"}     # 43111
https://testnet.rpc.hemi.network/rpc  {"jsonrpc":"2.0","id":1,"result":"0xb56c7"}    # 743111
https://hemi.drpc.org                 {"id":1,"jsonrpc":"2.0","result":"0xa867"}
https://hemi-testnet.drpc.org         {"id":1,"jsonrpc":"2.0","result":"0xb56c7"}
```

The earlier `403 from proxy` block was specific to the cloud session; from this workstation all four RPCs answer. The workstation's ISP blocks `explorer.hemi.xyz` and `ethereum-rpc.publicnode.com`, while `testnet.explorer.hemi.xyz` on the same Cloudflare IPs works:

```
$ curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://explorer.hemi.xyz/
302 https://<the ISP's warning page>?url=http://explorer.hemi.xyz/&token=<redacted>
$ curl -sv https://explorer.hemi.xyz/
* LibreSSL/3.3.6: error:1404B42E:SSL routines:ST_CONNECT:tlsv1 alert protocol version
```

Mainnet token addresses therefore come from Hemi's token list (D-007), not the mainnet explorer. Ethereum reads use `https://eth.drpc.org`.

## D-003. Deterministic deployer

```
$ cast code 0x4e59b44847b379578588920cA78FbF26c0B4956C --rpc-url https://rpc.hemi.network/rpc
0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3
$ cast code 0x4e59b44847b379578588920cA78FbF26c0B4956C --rpc-url https://testnet.rpc.hemi.network/rpc
0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3
```

Present on both networks with the standard Arachnid runtime code.

## D-004. Permit2

Mainnet: present and genuine.

```
$ cast code 0x000000000022D473030F116dDEE9F6B43aC78BA3 --rpc-url https://rpc.hemi.network/rpc   # size and keccak shown
bytes=9152 keccak=0x30002d17c268825d175caba993df71c34b30048f344b2ba63705a3063fa4743a
$ cast call 0x000000000022D473030F116dDEE9F6B43aC78BA3 "DOMAIN_SEPARATOR()(bytes32)" --rpc-url https://rpc.hemi.network/rpc
0x1bfbbf0056b6ec1bbca73ea788b4a65c034128fd6543621be486785424550c8f
# expected: keccak(abi.encode(keccak("EIP712Domain(string name,uint256 chainId,address verifyingContract)"), keccak("Permit2"), 43111, 0x0000…8BA3))
0x1bfbbf0056b6ec1bbca73ea788b4a65c034128fd6543621be486785424550c8f
```

Byte identity against Ethereum mainnet Permit2, with its two immutables (`_CACHED_CHAIN_ID`, `_CACHED_DOMAIN_SEPARATOR`) swapped for Hemi's values:

```
eth   bytes=9152 keccak=0xc67d1657868aa5146eaf24fb879fb1fdec3d2d493b3683a61c9c2f4fb2851131 DOMAIN_SEPARATOR=0x866a5aba21966af95d6c7ab78eb2b2fc913915c28be3b9aa07cc04ff903e3f28
eth code with Hemi immutables keccak=0x30002d17c268825d175caba993df71c34b30048f344b2ba63705a3063fa4743a
hemi  code                        keccak=0x30002d17c268825d175caba993df71c34b30048f344b2ba63705a3063fa4743a
RESULT: identical to Ethereum Permit2 modulo chain-specific immutables
```

Testnet: absent.

```
$ cast code 0x000000000022D473030F116dDEE9F6B43aC78BA3 --rpc-url https://testnet.rpc.hemi.network/rpc
0x
```

The deployer exists on testnet (D-003), so Permit2 goes to the canonical address by replaying Uniswap's original deployment calldata. That calldata is `<salt><initcode>` sent to `0x4e59…`, taken from Ethereum tx `0xf2f1fe96c16ee674bb7fcee166be52465a418927d124f5f1d231b36eae65d377`, whose creator Blockscout reports as `0x4e59…`. It is committed as `contracts/deploy-data/permit2.calldata.hex`.

```
$ cast tx 0xf2f1fe96…d377 --rpc-url https://eth.drpc.org --json | jq .data.input   # split into salt + initcode
permit2 salt=0x0000000000000000000000000000000000000000d3af2663da51c10215000000 initcodeHash=0xe2be1e05eedf35dacd66c65c862f8150ff9ab4b6b24b9bbe62be71b6b16cf0f8
$ cast create2 --deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C --salt 0x…d3af2663da51c10215000000 --init-code-hash 0xe2be1e05…f0f8
0x000000000022D473030F116dDEE9F6B43aC78BA3
$ cast call 0x4e59b44847b379578588920cA78FbF26c0B4956C $(cat contracts/deploy-data/permit2.calldata.hex) --rpc-url https://testnet.rpc.hemi.network/rpc   # simulation, no tx
0x000000000022d473030f116ddee9f6b43ac78ba3
$ cast estimate … --rpc-url https://testnet.rpc.hemi.network/rpc
2060220
```

## D-005. x402 exact Permit2 proxy

```
$ cast code 0x402085c248EeA27D92E8b30b2C58ed07f9E20001 --rpc-url https://rpc.hemi.network/rpc
0x
$ cast code 0x402085c248EeA27D92E8b30b2C58ed07f9E20001 --rpc-url https://testnet.rpc.hemi.network/rpc
0x
```

Absent on both. It is deployed from the reference repo's committed initCode (`x402-foundation/x402@e4a0868:contracts/evm/script/data/exact-proxy-initcode.hex`) with the reference salt. The initCode embeds canonical Permit2 as its constructor argument.

```
proxy initcodeHash=0xe774d1d5a07218946ab54efe010b300481478b86861bb17d69c98a57f68a604c   # equals EXACT_INIT_CODE_HASH in Deploy.s.sol
$ cast create2 --deployer 0x4e59…956C --salt 0x0000000000000000000000000000000000000000000000003000000007263b0e --init-code-hash 0xe774d1d5…604c
0x402085c248EeA27D92E8b30b2C58ed07f9E20001
$ cast call 0x4e59b44847b379578588920cA78FbF26c0B4956C $(cat contracts/deploy-data/exact-proxy.calldata.hex) --rpc-url https://rpc.hemi.network/rpc   # simulation, no tx
0x402085c248eea27d92e8b30b2c58ed07f9e20001
$ cast call … --rpc-url https://testnet.rpc.hemi.network/rpc
0x402085c248eea27d92e8b30b2c58ed07f9e20001
$ cast estimate …  (both networks)
722776
```

The proxy is compiled for `evm_version = "cancun"`. The successful simulation on both networks shows Hemi executes its creation code.

Mainnet cost estimate for the two missing contracts, from [docs/spike/mainnet-deploy-cost.log](docs/spike/mainnet-deploy-cost.log). Hemi runs the OP Stack GasPriceOracle with Ecotone and Fjord active.

| Item | Validator | Exact proxy |
|------|------|------|
| L2 gas (estimate) | 579233 | 722776 |
| L1 data fee (`getL1Fee`) | 2.51e12 wei | 2.93e12 wei |
| L2 gas price at the time | ~1.0e6 wei | ~1.0e6 wei |
| Total | ~3.1e12 wei | ~3.6e12 wei |

That is about 0.0000067 ETH for both.

## D-006. EIP-6492 validator and Multicall3

x402-rs requires a validator at `0xdAcD51A54883eb67D95FAEb2BBfdC4a9a6BD2a3B` on every EIP-155 chain at startup (`REQUIRED_CONTRACT_ADDRESSES` in `chain/provider.rs:38`). It calls the validator only for EIP-6492 counterfactual-wallet signatures. Multicall3 is used to deploy counterfactual wallets during settle.

```
$ cast code 0xdAcD51A54883eb67D95FAEb2BBfdC4a9a6BD2a3B --rpc-url https://rpc.hemi.network/rpc
0x (empty)
$ cast code 0xdAcD51A54883eb67D95FAEb2BBfdC4a9a6BD2a3B --rpc-url https://testnet.rpc.hemi.network/rpc
0x (empty)
$ cast code 0xcA11bde05977b3631167028862bE2a173976CA11 --rpc-url <each Hemi RPC>   # size and keccak shown
bytes=3808 keccak=0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891   # both networks
ethereum reference: 0xcA11…CA11 bytes=3808 keccak=0xd5c15df687b16f2ff992fc8d767b4216323184a2bbc6ee2f9c398c318e770891
ethereum reference: 0xdAcD…2a3B bytes=2376 keccak=0x9b83857bbb34de3ba755156ba9bee06532be5ff539bf5de301a28606c76d6cab
```

On Ethereum, Blockscout reports the validator's creator as `0x4e59…`, from tx `0x9970736352969c9b39f1b9ebe2668f0e89900c4d68f38891696314cf89f227c9`. Its salt is ASCII `x402`. Replaying that calldata, committed as `contracts/deploy-data/validator6492.calldata.hex`, lands on the same address:

```
validator salt=0x7834303200000000000000000000000000000000000000000000000000000000 initcodeHash=0x8a457240279c04f74154e0e10ecbeb78d2f2a8b68f5fb09658da494d89bb475e
$ cast create2 --deployer 0x4e59…956C --salt 0x78343032… --init-code-hash 0x8a457240…475e
0xdAcD51A54883eb67D95FAEb2BBfdC4a9a6BD2a3B
$ cast call 0x4e59b44847b379578588920cA78FbF26c0B4956C $(cat contracts/deploy-data/validator6492.calldata.hex) --rpc-url <each Hemi RPC>   # simulation, no tx
0xdacd51a54883eb67d95faeb2bbfdc4a9a6bd2a3b   # both networks
$ cast estimate …
579233
```

The x402 upto proxy `0x4020A4f3…0002` is also absent on both networks; the upto scheme is out of scope.

## D-007. USDC.e addresses

Source: Hemi's token list, `hemilabs/token-list@7a326ac4bf501e9205e0580625c9932fa8955f63` (2026-10-23, package `@hemilabs/token-list` 4.2.0), file `src/hemi.tokenlist.json`. The tunnel UI uses this list. Hemi's Portal at app.hemi.xyz, which serves `/tunnel`, depends on that exact package version:

```
$ curl -sS https://raw.githubusercontent.com/hemilabs/ui-monorepo/605713de4b12e8bb8c2b214d822b7287a0d58039/portal/package.json | jq -r '.name, .dependencies["@hemilabs/token-list"]'
portal
4.2.0
$ curl -sS https://raw.githubusercontent.com/hemilabs/ui-monorepo/605713de…/README.md | grep app.hemi
- **portal**: Portal webapp living at [https://app.hemi.xyz](https://app.hemi.xyz).
# the repo tree has portal/app/[locale]/tunnel
```

The mainnet explorer is blocked locally (D-002); the testnet explorer agrees with the list.

```
$ curl -sS https://raw.githubusercontent.com/hemilabs/token-list/7a326ac4…/src/hemi.tokenlist.json | jq -c '.tokens[] | select(.symbol=="USDC.e")'
{"chainId":43111,"symbol":"USDC.e","name":"Bridged USDC (Stargate)","address":"0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA","decimals":6,…}
{"chainId":743111,"symbol":"USDC.e","name":"USDC.e","address":"0xD47971C7F5B1067d25cd45d30b2c9eb60de96443","decimals":6,"extensions":{"bridgeInfo":{"11155111":{"tokenAddress":"0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8"}}}}
$ curl -sS 'https://testnet.explorer.hemi.xyz/api/v2/tokens?q=USDC' | jq -c '.items[0]'
{"address":"0xD47971C7F5B1067d25cd45d30b2c9eb60de96443","name":"USDC.e","symbol":"USDC.e","decimals":"6","holders":"206835","type":"ERC-20"}
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "name()(string)" / "symbol()(string)" / "decimals()(uint8)" --rpc-url https://rpc.hemi.network/rpc
"Bridged USDC (Stargate)"  "USDC.e"  6
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 … --rpc-url https://testnet.rpc.hemi.network/rpc
"USDC.e"  "USDC.e"  6
```

The testnet USDC.e is tunneled from Sepolia, not bridged by Stargate.

## D-008. hemiBTC addresses

```
$ jq -c '.tokens[] | select(.symbol=="hemiBTC")' hemi.tokenlist.json     # same pinned token list
{"chainId":43111,"symbol":"hemiBTC","name":"Hemi Bitcoin","address":"0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28","decimals":8,…}
$ jq -c '.tokens[] | select(.chainId==743111) | {symbol,name,address,decimals}' hemi.tokenlist.json
{"symbol":"WETH",…} {"symbol":"hBTC","name":"HemiBitcoin","address":"0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7","decimals":8} {"symbol":"USDT.e",…} {"symbol":"rUSDC-hemi",…} {"symbol":"USDC.e",…} {"symbol":"hDAI",…}
$ cast call 0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28 name/symbol/decimals --rpc-url https://rpc.hemi.network/rpc
"Hemi Bitcoin"  "hemiBTC"  8
$ cast call 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 name/symbol/decimals --rpc-url https://testnet.rpc.hemi.network/rpc
"HemiBitcoin"  "hBTC"  8
```

hemiBTC has no testnet deployment in the token list. A testnet explorer search for "hemiBTC" returns eleven look-alike contracts with 1 to 5 holders each. None of them is in the token list, so none is canonical.

```
$ curl -sS 'https://testnet.explorer.hemi.xyz/api/v2/tokens?q=hemiBTC' | jq -c '.items[] | {address: (.address_hash // .address), name, symbol, decimals, holders: (.holders_count // .holders)}'
{"address":"0x05710e96a48AF222b564e6A222fF2f3d56725c32","name":"Hemi Bitcoin","symbol":"hemiBTC","decimals":"8","holders":"5"}
{"address":"0x3C864cac3F3E8489a0Ab948b59c40e840C396a8b","name":"hemiBTC","symbol":"hemiBTC","decimals":"8","holders":"5"}
{"address":"0xacB7A69A8Daaa7545309Ee773AB2195eFAd5878A","name":"Scenario hemiBTC","symbol":"shBTC","decimals":"8","holders":"5"}
{"address":"0x01cEF96874Af21d5455333f4eDaBD8dA959dfA97","name":"hemiBTC","symbol":"hemiBTC","decimals":"8","holders":"2"}
{"address":"0x4D3401068FDa7FC81FF6980BA304A33a3b5EeD20","name":"HEMIBTC","symbol":"HTC","decimals":"18","holders":"2"}
{"address":"0x447F5D3b49877EF6E5666cb34310fC64135B109a","name":"Scenario hemiBTC","symbol":"shBTC","decimals":"8","holders":"2"}
{"address":"0xAcB51012600D3BF53A40264923a197FDf84be557","name":"Scenario hemiBTC","symbol":"shBTC","decimals":"8","holders":"2"}
{"address":"0xc16f7D158AB115dA238b7e1662225cAc7e91C3ff","name":"Scenario hemiBTC","symbol":"shBTC","decimals":"8","holders":"2"}
{"address":"0x5C148C1a11abe9740Cae7c6FfdE72EeD6ABe4097","name":"Scenario hemiBTC","symbol":"shBTC","decimals":"8","holders":"1"}
{"address":"0x9976CA2ADc211ac8f22c51d1fb5af7F50a411455","name":"Scenario hemiBTC","symbol":"shBTC","decimals":"8","holders":"1"}
{"address":"0xb73579190FF698ac08134Ce811Ac7C03F48d7aAe","name":"Scenario hemiBTC","symbol":"shBTC","decimals":"8","holders":"1"}
```

The testnet stand-in is the tunnel's BTC representation, hBTC `0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7`, as the brief allows. Both are 8-decimal, Permit2-only tokens (D-011).

## D-009. USDC.e and EIP-3009

The probe calls each function with `validAfter = validBefore = 0`. If the function exists, it fails a time check with a revert reason. A missing function reverts with empty data, exactly like the control call `definitelyNotAFunction_x402()`.

Mainnet: implemented, in both the `(v,r,s)` and the `bytes signature` variants (FiatToken v2.2).

```
$ cast storage 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA 0x7050c9e0f4ca769c69bd3a8ef740bc37934f8e2c036e5a723fd8ee048ed3f8c3 --rpc-url https://rpc.hemi.network/rpc   # FiatTokenProxy implementation slot
0x0000000000000000000000004f5f42799d1e01662b629ede265baea223e9f9c7
$ cast call 0xad11…5afA "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" 0x…dEaD 0x…dEaD 1 0 0 0x00…00 27 0x00…00 0x00…00 --rpc-url https://rpc.hemi.network/rpc
Error: execution reverted: FiatTokenV2: authorization is expired
$ cast call 0xad11…5afA "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes)" 0x…dEaD 0x…dEaD 1 0 0 0x00…00 0x --rpc-url https://rpc.hemi.network/rpc
Error: execution reverted: FiatTokenV2: authorization is expired
$ cast call 0xad11…5afA "authorizationState(address,bytes32)(bool)" 0x…dEaD 0x00…00 --rpc-url https://rpc.hemi.network/rpc
false
$ cast call 0xad11…5afA "definitelyNotAFunction_x402()" --rpc-url https://rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
# selector scan of implementation 0x4f5f42799d1e01662b629ede265baea223e9f9c7 (bytes=23464)
PRESENT e3ee160e transferWithAuthorization(v,r,s)   PRESENT cf092995 transferWithAuthorization(bytes)
PRESENT ef55bec6 receiveWithAuthorization(v,r,s)    PRESENT e94a0102 authorizationState(address,bytes32)
```

Testnet: not implemented. Every probe reverts with empty data, like the control, and the selectors are absent from the runtime code. The contract is not a proxy; both the EIP-1967 and the FiatToken implementation slots are zero.

```
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 authorizationState(address,bytes32)(bool) 0x000000000000000000000000000000000000dEaD 0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32) 0x000000000000000000000000000000000000dEaD 0x000000000000000000000000000000000000dEaD 1 0 0 0x0000000000000000000000000000000000000000000000000000000000000000 27 0x0000000000000000000000000000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,bytes) 0x000000000000000000000000000000000000dEaD 0x000000000000000000000000000000000000dEaD 1 0 0 0x0000000000000000000000000000000000000000000000000000000000000000 0x --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 definitelyNotAFunction_x402() --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
# selector scan of the runtime code (scripts/spike.sh "Extra B")
# USDC.e 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 bytes=5544
  PRESENT a9059cbb transfer(address,uint256) [control]
  PRESENT 095ea7b3 approve(address,uint256) [control]
  absent  e3ee160e transferWithAuthorization(v,r,s)
  absent  cf092995 transferWithAuthorization(bytes)
  absent  ef55bec6 receiveWithAuthorization(v,r,s)
  absent  e94a0102 authorizationState(address,bytes32)
  absent  d505accf permit(address,address,uint256,uint256,uint8,bytes32,bytes32)
  absent  7ecebe00 nonces(address)
  absent  3644e515 DOMAIN_SEPARATOR()
```

## D-010. USDC.e and EIP-2612

The test is stricter, per P-3. It requires `DOMAIN_SEPARATOR()` to match the domain recomputed from `name()` and `version()`, `nonces(address)` to answer, and `permit` to fail a deadline check with a revert reason.

Mainnet: implemented.

```
$ cast call 0xad11…5afA "version()(string)" --rpc-url https://rpc.hemi.network/rpc
"2"
$ cast call 0xad11…5afA "DOMAIN_SEPARATOR()(bytes32)" --rpc-url https://rpc.hemi.network/rpc
0x6fe49ef2438be116233a7505f2b997466e49631ac8e197a2f1f208108d598a11
# expected for name="Bridged USDC (Stargate)" version="2" chainId=43111 verifyingContract=0xad11…5afA
0x6fe49ef2438be116233a7505f2b997466e49631ac8e197a2f1f208108d598a11
$ cast call 0xad11…5afA "nonces(address)(uint256)" 0x…dEaD --rpc-url https://rpc.hemi.network/rpc
0
$ cast call 0xad11…5afA "permit(address,address,uint256,uint256,uint8,bytes32,bytes32)" 0x…dEaD 0x…dEaD 1 0 27 0x00…00 0x00…00 --rpc-url https://rpc.hemi.network/rpc
Error: execution reverted: FiatTokenV2: permit is expired
# selector scan: PRESENT d505accf permit   PRESENT 7ecebe00 nonces   PRESENT 3644e515 DOMAIN_SEPARATOR
```

The matching domain separator also confirms the EIP-712 name and version that EIP-3009 signatures must use. `eip712Domain()` (EIP-5267) is not implemented, so the SDK cannot discover these values and the seller must send them in `extra`.

Testnet: not implemented. Every call reverts with empty data, the same as the control call in D-009, and the selectors `d505accf`, `7ecebe00` and `3644e515` are absent from the runtime code (`docs/spike/testnet.log`, "Extra B").

```
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 version()(string) --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 eip712Domain()(bytes1,string,string,uint256,address,bytes32,uint256[]) --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 DOMAIN_SEPARATOR()(bytes32) --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 nonces(address)(uint256) 0x000000000000000000000000000000000000dEaD --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 permit(address,address,uint256,uint256,uint8,bytes32,bytes32) 0x000000000000000000000000000000000000dEaD 0x000000000000000000000000000000000000dEaD 1 0 27 0x0000000000000000000000000000000000000000000000000000000000000000 0x0000000000000000000000000000000000000000000000000000000000000000 --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
```

## D-011. hemiBTC (mainnet) and hBTC (testnet): neither standard

The brief assumed this; it is now confirmed. Both tokens are small non-proxy ERC-20s, 2098 and 2097 bytes, with zero EIP-1967 slots. For both, every EIP-3009 and EIP-2612 probe reverts with empty data, like the control. The selector scan finds `transfer` and `approve` but none of `e3ee160e cf092995 ef55bec6 e94a0102 d505accf 7ecebe00 3644e515`. Full output is in `docs/spike/mainnet.log` and `docs/spike/testnet.log`. Both go through Permit2.

## D-012. hBK contract and precompiles (phase 2 only)

Source: `hemilabs/docs@61aced77175307475fea525d864496b95a21e913`, pages `building-bitcoin-apps/hemi-bitcoin-kit-hbk/hbk-smart-contract.md` and `building-bitcoin-apps/hemi-virtual-machine-hvm/feature-summary.md`.

- hBK contract: mainnet `0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12`, testnet `0xeC9fa5daC1118963933e1A675a4EEA0009b7f215`.

Read from the docs with:

```
$ curl -sS https://raw.githubusercontent.com/hemilabs/docs/61aced77175307475fea525d864496b95a21e913/building-bitcoin-apps/hemi-bitcoin-kit-hbk/hbk-smart-contract.md | grep -E 'Latest hBK release'
* **Latest hBK release on Hemi:** [0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12](https://explorer.hemi.xyz/address/0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12)
* **Latest hBK release on Hemi testnet:** [0xeC9fa5daC1118963933e1A675a4EEA0009b7f215](https://testnet.explorer.hemi.xyz/address/0xeC9fa5daC1118963933e1A675a4EEA0009b7f215)
$ curl -sS https://raw.githubusercontent.com/hemilabs/docs/61aced77175307475fea525d864496b95a21e913/building-bitcoin-apps/hemi-virtual-machine-hvm/feature-summary.md | grep -o '<tr><td>[A-Za-z]*</td><td>0x4[0-9]</td>'
<tr><td>BtcBalAddr</td><td>0x40</td>
<tr><td>BtcUtxosAddrList</td><td>0x41</td>
<tr><td>BtcTxByTxid</td><td>0x42</td>
<tr><td>BtxTxConfirmations</td><td>0x43</td>
<tr><td>BtcLastHeader</td><td>0x44</td>
<tr><td>BtcHeaderN</td><td>0x45</td>
<tr><td>BtcAddrToScript</td><td>0x46</td>
```

- Precompiles ("Phase 0"): `0x40` BtcBalAddr, `0x41` BtcUtxosAddrList, `0x42` BtcTxByTxid, `0x43` BtxTxConfirmations, `0x44` BtcLastHeader, `0x45` BtcHeaderN, `0x46` BtcAddrToScript.
- ABI: the `IBitcoinKit` interface on the hBK page (`getBitcoinAddressBalance`, `getUTXOsForBitcoinAddress`, `getTransactionByTxId`, `getTransactionInputsByTxId`, `getTransactionOutputsByTxId`, `getTxConfirmations`, `getLastHeader`, `getHeaderN`).

```
$ cast code 0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12 --rpc-url https://rpc.hemi.network/rpc   # size shown
bytes=8415
$ curl -sS https://raw.githubusercontent.com/hemilabs/docs/61aced77175307475fea525d864496b95a21e913/building-bitcoin-apps/hemi-bitcoin-kit-hbk/hbk-smart-contract.md | grep -A10 'struct BitcoinHeader'
struct BitcoinHeader {
  uint32 height; bytes32 blockHash; uint32 version; bytes32 previousBlockHash; bytes32 merkleRoot; uint32 timestamp; uint32 bits; uint32 nonce;
}
$ cast call 0x7007…8F12 'getLastHeader()((uint32,bytes32,uint32,bytes32,bytes32,uint32,uint32,uint32))' --rpc-url https://rpc.hemi.network/rpc
(973644, 0x00000000000000000001263978371155791d58c2e4ad51afcf737be312fcd87d, 584622080, 0x00000000000000000001e71307152f2006b2cca991ac4b7badb640be94a54b97, 0xf07d1cbd…, …)
$ cast call 0xeC9f…f215 'getLastHeader()((uint32,bytes32,uint32,bytes32,bytes32,uint32,uint32,uint32))' --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
$ cast code 0xeC9fa5daC1118963933e1A675a4EEA0009b7f215 --rpc-url https://testnet.rpc.hemi.network/rpc   # size shown
bytes=10266
$ cast call 0xeC9f…f215 'getLastHeader()(…)' --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
$ cast code 0x0000000000000000000000000000000000000044 --rpc-url <either>
0x
```

With the `BitcoinHeader` struct the docs define, mainnet hBK decodes cleanly to a current Bitcoin height (973644), block hash, version and previous hash. (The first spike run used a 7-field guess; the docs' 8-field struct replaced it.) On testnet the same call reverts.

`cast code` proves nothing for a precompile, because a precompile always has empty code. Only `BtcLastHeader` (`0x44`) was exercised; precompiles `0x40` to `0x43`, `0x45` and `0x46` are listed from the docs and were not called. Calling `0x44` directly answers on both networks:

```
$ cast call 0x0000000000000000000000000000000000000044 0x --rpc-url https://rpc.hemi.network/rpc
0x000edb40…   # first 4 bytes: height 0x0edb40 = 973632, followed by header data
$ cast call 0x0000000000000000000000000000000000000044 0x --rpc-url https://testnet.rpc.hemi.network/rpc
0x004fb0b4…   # height 0x4fb0b4 = 5222580 (Bitcoin testnet)
```

Full output is in `docs/spike/hbk.log`. hVM therefore serves Bitcoin headers on both networks. The testnet failure lies in the hBK contract at `0xeC9f…f215`, or in the tuple ABI used here, not in the precompile. Phase 2 is out of scope, so this was not pursued further.

## D-013. Facilitator: stock x402-rs image, Hemi config, fork-based tests

Facilitator image: `ghcr.io/x402-rs/x402-facilitator@sha256:4ebe09d824bf6a5f342add8ae22eb44a2c56894ad22e7d3f5b83ba38023226b9`. That digest is tag `2.0.2` and also `latest`. Its labels name revision `0b14f39`.

```
$ git diff --stat 0b14f39 e75adda -- crates/chains/x402-chain-eip155 facilitator crates/x402-types crates/x402-facilitator-local
(no output: the EVM code is identical to the e75adda tree read for P-1)
```

The config schema at this version differs from the x402-rs README. Each `schemes` entry is `{"id": "v2-eip155-exact", "chains": "<pattern>"}`, with `id` and a single pattern string, not `{"scheme": …, "chains": [...]}`:

```
$ docker run … (schemes written as in the README)
Failed to parse config file: invalid type: sequence, expected a string at line 4 column 56
```

Choices in `facilitator/config.json`:

- Only `v2-eip155-exact` is enabled; v1 and upto are out of scope. It accepts both EIP-3009 and Permit2 payloads. `/supported` lists `scheme: exact` per network with `extra: {}`, because x402-rs has no field for transfer methods. Which method a payment uses is set per asset by the seller's `extra.assetTransferMethod` (D-001).
- `eip1559: true`, since Hemi has a base fee (D-005). `receipt_timeout_secs: 60`, because the brief expects stalled RPCs and the default of 30 is tight for Hemi's roughly 12-second blocks. It was first 120 and was lowered so that a `settlement_pending` answer (D-016) arrives within the seller SDK's 90-second facilitator timeout (`DEFAULT_TIMEOUT_MS = 9e4` in `@x402/core` 2.29.0).
- RPCs are dRPC first and the Hemi public RPC second. Both are fanned out, not tried in order (P-2), so the public RPC is throttled to 4 requests per second to stay under ~300 per minute.
- EIP-2612 gas sponsoring stays off. No MVP asset settles through Permit2 with EIP-2612 (D-001).
- Keys are separate per chain, `FACILITATOR_TESTNET_PRIVATE_KEY` and `FACILITATOR_MAINNET_PRIVATE_KEY`, so a testnet key never signs on mainnet. `facilitator/config.testnet.json` runs testnet alone until the mainnet contracts exist (D-001).

Local fork verification, before any live transaction: `scripts/fork.sh up` forks both chains with anvil and replays the three deployments from `contracts/deploy-data/`. The fork deployments land at the canonical addresses, and Permit2 is skipped on mainnet because it already exists. The stock image then starts against the forks with both primary RPCs pointed at a dead port:

```
$ FORK_TESTNET_PORT=18545 FORK_MAINNET_PORT=18546 scripts/fork.sh up
$ FACILITATOR_PORT=18080 FACILITATOR_TESTNET_PRIVATE_KEY=<anvil #1> FACILITATOR_MAINNET_PRIVATE_KEY=<anvil #2> \
  HEMI_TESTNET_RPC_PRIMARY=http://127.0.0.1:1 HEMI_TESTNET_RPC_FALLBACK=http://host.docker.internal:18545 \
  HEMI_MAINNET_RPC_PRIMARY=http://127.0.0.1:1 HEMI_MAINNET_RPC_FALLBACK=http://host.docker.internal:18546 \
  docker compose -p hemi-x402-probe up -d          # compose then used the stock image (D-016 replaced it)
$ curl -sS localhost:18080/supported | jq -c '.kinds[] | {network,scheme}'
{"network":"eip155:43111","scheme":"exact"}
{"network":"eip155:743111","scheme":"exact"}
```

The same check is now a single committed recipe: `scripts/fork.sh up` followed by `docker compose -f docker-compose.yml -f docker-compose.fork.yml up`. The override sets dead primaries, fork fallbacks on ports 8545 and 8546, and anvil signer keys. It was re-run on 2026-10-29 with the patched image (D-016), and `/supported` listed both networks. `facilitator/config.mainnet.json` gives the mainnet-only counterpart of `config.testnet.json`.

Fork funding writes balances into each token's `balanceOf` mapping. The slots were found by probing: 0 for testnet USDC.e, hBTC and mainnet hemiBTC, and 9 for mainnet USDC.e (FiatToken's `balanceAndBlacklistStates`). `anvil_dealERC20` could not locate these slots.

Workstation setup recorded for reproducibility: Foundry 1.8.6, plus Colima, the Docker CLI and Compose, all from Homebrew. Colima shares only `$HOME` with containers, so files mounted into containers must live under the repo, not `/tmp`. The project `.npmrc` pins the public npm registry, because the user-level npm config points at a private registry.

## D-014. Seller, buyer and SDK: explicit Hemi assets until the SDK patch lands

The published x402 TypeScript SDK (2.29.0) does not know Hemi. That has two consequences, both handled without forking the SDK:

- **Seller prices:** a price string like `"$0.001"` resolves through the SDK's default-asset table, which has no Hemi entry. The seller therefore prices each accepted asset explicitly, as `{asset, amount, extra}`. USDC.e is 1000 base units ($0.001). The BTC asset defaults to 1 sat, about $0.001 at ~$100k/BTC, and `SELLER_BTC_AMOUNT` changes it. `extra.assetTransferMethod` is `eip3009` for mainnet USDC.e, with `name` and `version` from D-010, and `permit2` for the rest.
- **Buyer spend controls:** stock `x402Client` spend controls reject every asset that is not an SDK default asset ("All payment requirements were rejected by spendControls"). The buyer allow-lists only the requested Hemi asset, with a per-payment cap (`setSpendControls({allowedAssets: [...]})`), rather than turning spend controls off.

`sdk-patch/0001-hemi-networks.patch` adds Hemi USDC.e to the SDK's default assets and the v1 names `hemi` and `hemi-testnet`. It follows upstream's Arc (`dd89698`), Monad-testnet (`a9955ae`) and Igra (`d9bd02d`) additions, and applies cleanly to `e4a0868`. The `@x402/evm` suite passes with it: 57 files, 1650 tests. Even with the patch, hemiBTC and hBTC still need explicit prices and allow-listing, because default assets are stablecoins only. The upstream PR text is drafted in `sdk-patch/PR.md` and has not been opened.

All four payments were checked end to end on local forks with `buyer/demo-fork.sh`: testnet USDC.e, testnet hBTC, mainnet USDC.e and mainnet hemiBTC. Each settle receipt is from the facilitator signer. Its single `Transfer` log goes from the buyer straight to `payTo`.

## D-015. RPC behaviour: fan-out confirmed, dRPC testnet reports a stale block number

P-2 is confirmed against alloy-transport 2.0.5, the version in x402-rs's `Cargo.lock`. `FallbackLayer` sends every read to all configured RPCs in parallel and takes the first success; only the `*Sync` send methods are exempt. That made `eth_sendRawTransaction` a fan-out too, which patch 0021 ends (D-019). In an experiment with two logging anvil forks as primary and fallback and no rate limits, 5 verifies produced 5 `eth_call`s on each. With this repo's limits (20/s and 4/s), the throttled public RPC sees fewer calls, because a queued copy is dropped once the other RPC answers. When the primary is dead, all traffic runs through the public RPC at up to 4 requests per second.

dRPC's free-tier testnet endpoint answers `eth_blockNumber` from a stale backend, while its `eth_getBlockByNumber("latest")` and `eth_call` are current:

```
$ curl … '{"method":"eth_blockNumber"}' https://hemi-testnet.drpc.org                     # 6 calls
4170444 4170447 4170449 4170453 4170456 4170459
$ curl … '{"method":"eth_getBlockByNumber","params":["latest",false]}' https://hemi-testnet.drpc.org
7094224 … 7094225
$ cast call 0xcA11bde05977b3631167028862bE2a173976CA11 'getBlockNumber()(uint256)' --rpc-url https://hemi-testnet.drpc.org
7094227
$ cast block-number --rpc-url https://testnet.rpc.hemi.network/rpc
7094225
$ curl … '{"method":"eth_blockNumber"}' https://hemi.drpc.org   vs   cast block-number --rpc-url https://rpc.hemi.network/rpc
5614567 = 5614567                                                                        # mainnet dRPC is fine
```

Impact on the facilitator: verification reads and nonce reads are correct. Settlement waits for its receipt through alloy's `get_receipt`. With x402-rs's one confirmation (`MetaTransaction::confirmations = 1`, `chain/provider.rs:396`), that polls `eth_getTransactionReceipt` on a timer, independent of the `eth_blockNumber` block stream (`alloy-provider` 2.0.5, `heart.rs` `get_receipt`). A stale block number therefore cannot hide the receipt. dRPC stays the testnet primary as the brief specifies, and the live testnet run checks this. A `null` receipt from a lagging RPC could hide it, which this entry missed. D-025 covers that, and since patch 0028 the wait reads neither that timer nor any block number.

Impact on forks: an unpinned anvil fork of dRPC testnet would start ~2.9M blocks back. `scripts/fork.sh` defaults to the public RPCs and falls back to dRPC on testnet only with a pinned block.

## D-016. Facilitator image: x402-rs e75adda plus spec-conformance patches

This supersedes the image choice in D-013. The config in D-013 is unchanged.

Against the stock image, the e2e suite found that x402-rs 2.0.2 does not return the x402 v2 spec's error shapes. The Definition of done requires them for a failed signature and an insufficient balance:

| Case | Stock x402-rs | Spec (`specs/x402-specification-v2.md` §5.3.2, §5.4.2, §9) |
|------|------|------|
| Bad EOA signature (both methods) | HTTP 500 `unexpected_error`; the revert text is in the details | `invalid_exact_evm_payload_signature` |
| Any error body | `"payer": ""`, and on settle `"network": ""` | the payer's address (or omitted); CAIP-2 network required |
| Permit2 settle, insufficient balance | HTTP 500 `unexpected_error` (`TRANSFER_FROM_FAILED`) | `insufficient_funds` |
| Permit2, no allowance and no balance | 412 or 400 at random, because the reads race | 412 allowance-required first (scheme_exact_evm.md) |
| Replay | HTTP 500 `unexpected_error` | a §9 code |

The cause of the signature case: x402-rs treats a 65-byte signature that does not recover to `from` as an EIP-1271 signature and leaves it to the on-chain simulation. The simulation's revert then surfaces as a transport error.

No config setting changes any of this, so the facilitator is now built from `facilitator/Dockerfile`: x402-rs `e75adda`, plus the patches in `facilitator/x402-rs/patches/`, plus a build-only workspace trim. The image is tagged `hemi-x402-facilitator:e75adda-hemi.14` (hemi.7 until patch 0019, D-018; hemi.8 until patches 0020 and 0021, D-019; hemi.9 until patch 0022, D-020; hemi.10 until patches 0023 to 0026, D-021; hemi.11 until patch 0027, D-022; hemi.12 until 0027 was corrected, D-023; hemi.13 until patch 0028, D-025). Each patch is small, unit-tested and written to go upstream. None changes where funds go; 0010 narrows what is accepted to the exact amount. `facilitator/x402-rs/README.md` has the per-patch detail, the resulting check order and draft upstream texts. Nothing has been published.

| Patch | Change |
|------|------|
| 0001 | §9 error codes added to `ErrorReason` |
| 0002 | Error bodies carry `payer` and `network`, plus `invalidMessage`; `unexpected_error` becomes `unexpected_verify_error` or `unexpected_settle_error` |
| 0003 | The payer's signature is checked first. A signature that does not recover to `from`, from an address with no code, returns `invalid_exact_evm_payload_signature` |
| 0004 | Permit2: allowance before balance; both re-checked on settle |
| 0005 | A replayed authorization or Permit2 nonce returns `invalid_transaction_state` |
| 0006 | A broadcast tx whose receipt does not arrive in time returns HTTP 200 `settlement_pending` with the tx hash. The nonce is no longer reset after a broadcast |
| 0007 | An unsupported network returns `invalid_network` |
| 0008 | Contract-wallet payer: `isValidSignature` must return `0x1626ba7e`; known signature reverts map to `invalid_exact_evm_payload_signature` |
| 0009 | Remaining errors map to §9 codes; `network` is omitted rather than `""`; a body that is not JSON gets JSON `invalid_payload` |
| 0010 | The v2 exact scheme requires exactly the required amount (`…_authorization_value_mismatch`) |
| 0011 | One settlement per authorization, keyed by chain, payer and nonce. While a settle is pending, `/verify` of the authorization and any other settle carrying it return `invalid_transaction_state`. An identical retry gets the same hash while pending. The first retry after mining claims the success and removes the record in the same locked step; later settles are replays. A revert returns `invalid_transaction_state` with the hash |
| 0012 | EIP-6492 signatures are validated with the validator's `isValidSigWithSideEffects` (`eth_call`) before balance, allowance or any send. A wrapper around the payer's own EOA signature is ignored, so no factory call is made |
| 0013 | A missing or unsupported top-level `x402Version` returns `invalid_x402_version` |
| 0014 | A Permit2 spender other than the exact proxy returns `invalid_payload`, checked before the signature |
| 0015 | `/settle` runs the settlement in a detached task, so a client disconnect cannot cancel it after broadcast. The hash of every broadcast the node accepts is logged at info |
| 0016 | A settlement that succeeds after its client left keeps its record with the hash; the first identical retry claims the success |
| 0017 | A missing top-level `x402Version`, or a `paymentPayload.x402Version` that contradicts it, returns `invalid_x402_version` |
| 0018 | HTTP status codes follow the TS reference facilitator: 200 for every verdict on a readable request, 400 only for an unreadable one, 500 for unexpected failures |
| 0019 | On EIP-1559 chains a settlement tips at least the node's `eth_maxPriorityFeePerGas`, so it is mined after tip-less blocks (hemi.8, D-018) |
| 0020 | A settle owns its record: no other settle can overwrite or delete it. A running settle's record neither expires nor is evicted, and the 10,000 cap applies to kept records only (hemi.9, D-019) |
| 0021 | `eth_sendRawTransaction` goes to one RPC at a time, moving on only if that RPC cannot be reached (hemi.9, D-019) |
| 0022 | Every RPC request ends after 10 s, and a failed send is looked up by its hash before it counts as failed (hemi.10, D-020) |
| 0023 | `reset_nonce` no longer holds the nonce map across an await, which could freeze the process (hemi.11, D-021) |
| 0024 | A failed send's hash is looked up on each RPC, for two blocks if the send timed out, and is logged (hemi.11, D-021) |
| 0025 | A settlement whose tip cannot be read fails before anything is sent (hemi.11, D-021) |
| 0026 | A send and its receipt wait share one budget, the receipt timeout plus 5 s (hemi.11, D-021) |
| 0027 | Any failed send except a node's rejection of a non-duplicate is searched for, with an 8 s lookup limit, within the budget (hemi.13, D-023) |
| 0028 | A receipt is looked for on each RPC separately, on the first settle and on a retry, so a lagging RPC cannot hide it (hemi.14, D-025) |

hemi.1 had patches 0001 to 0005. A fresh-context critic then found three more gaps:

- **Signature order:** a bad signature from an unfunded payer was reported as a balance or allowance failure, not a signature failure.
- **Lost hash:** a receipt timeout returned 500 with an empty `transaction` while the tx was still in the mempool. The buyer would be charged with no hash returned.
- **Wrong network:** an unsupported network returned `unsupported_scheme`.

hemi.2 fixes all three. A second critic pass on hemi.2 found four more:

- **Contract wallets:** a bad signature from a contract-wallet payer returned HTTP 500.
- **Amount:** overpayment was accepted.
- **Codes:** several codes were not in §9.
- **Retries:** the SDK's automatic retry after `settlement_pending` was handled as a fresh settle.

hemi.3 (0008 to 0011) fixes these. A third critic pass on hemi.3 found that the first version of 0011 answered success to every repeat of a payload whose settle had gone pending, so one payment could pay for several requests. hemi.4 reworks 0011 to allow one settlement per authorization. It also adds 0012, after the critic found EIP-6492 signatures skipped the signature-first check and `/settle` would make an unvalidated factory call. 0013 maps the protocol version. A fourth critic pass on hemi.4 found no failing item and no in-repo major issue. hemi.5 adds 0014 for the spender and settles the check order for combined failures.

Check order, decided in hemi.5: the off-chain checks (recipient, validity window, exact amount, token, Permit2 spender) run before the allowance and balance reads. That matches the TS reference facilitator at `e4a0868`. It checks recipient, `validBefore`, `validAfter` and exact amount before simulating, and reads balance or allowance only to diagnose a failed simulation (`exact/facilitator/eip3009.ts` 245–331, `exact/facilitator/permit2.ts` 119–174 and 306–311, `shared/permit2.ts` 372–428). It is not the order written in `scheme_exact_evm.md`. The off-chain reason is chosen because it needs no RPC call, and because it is the one the payer can act on: an expired or mis-priced payment must be re-signed, which approving or topping up won't fix. Single-failure cases are unaffected. A fifth critic pass on hemi.5 found that a client disconnect after broadcast dropped the pending record and lost the hash. `/verify` then accepted the same payload again. hemi.6 adds 0015, and an e2e test reproduces that scenario; the test fails on hemi.5. A sixth critic pass on hemi.6 found three more problems. A success that landed after the disconnect was still discarded. Stock TS sellers got a wrapped code because rejections were answered with 400. A contradicting inner `x402Version` was mis-coded. hemi.7 adds 0016 to 0018.

Two deliberate differences from the reference remain:

- **Permit2 signature position:** the signature is checked right after the spender, as the spec's step 1 says.
- **Allowance before balance:** when both are missing, allowance is checked first and returns `permit2_allowance_required` (spec order, patch 0004). The reference diagnoses the balance first.

Separately, the receipt timeout dropped from 120 s to 60 s, under the seller SDK's 90 s facilitator timeout, so a stock seller receives `settlement_pending` (D-013 config).

Other choices and known limits of the patch set:

- **Replay code:** a replay is reported as `invalid_transaction_state`. §9 has no replay code, and its definition ("Blockchain transaction failed or was rejected") fits. The TS reference facilitator also uses it as its default for failed settlements.
- **Status codes (0018):** every verdict is HTTP 200, `isValid: false`, `success: false`, `permit2_allowance_required` and `settlement_pending` included. This matches the TS reference facilitator (`examples/typescript/facilitator/basic/index.ts` answers both endpoints with `res.json`, and 500 only when they throw). The stock TS client turns any non-2xx into a thrown `VerifyError` or `SettleError`, so the seller's 402 would carry `"<code>: <message>"` instead of the bare code (`core/src/http/httpFacilitatorClient.ts` 423–435). The 412 for a missing allowance is the seller's answer to the buyer, not the facilitator's. x402-rs's own client deserializes 200, 400 and 412 bodies alike. hemi.1 to hemi.6 answered rejections with 400 or 412.
- **Nonce trade-off:** a tx that is later dropped from every mempool leaves a nonce gap until restart. Before, the nonce could be reused while the earlier tx might still mine.
- **Kept on purpose:** `invalidReasonDetails` stays next to `invalidMessage` for clients of stock x402-rs.
- **One process per signer key:** the pending record (0011) and the nonce manager live in one process, so a restart forgets pending records. Two facilitator instances sharing a signer key collide on nonces; a critic saw `nonce too low` as HTTP 500, which recovered on the next request. Neither instance can see the other's pending settles. Run exactly one facilitator per signer key.
- **Limits of the pending record (0011):** An unclaimed record blocks `/verify` of its authorization for up to 15 minutes. By then the authorization is normally spent. If its transaction was dropped, it is not, and the authorization becomes usable once the record expires.
- **Verify-then-settle race:** two requests that both pass `/verify` before either settles can both reach a seller's handler, and only one settle succeeds. This is inherent to the x402 flow.
- **EIP-6492 deployment:** a counterfactual wallet deployed during settle is untested end to end, because the forks have no wallet factory.
- **After a disconnect:** until the original settlement ends (its receipt wait is at most 60 s, after a send of up to 20 s when RPCs stall), retries get `invalid_transaction_state` ("in progress") without the hash. After that, the first identical retry claims the hash (0016). Two narrow gaps remain. A client that disconnects in the instant between the settlement's "is the caller still waiting" check and the response being written loses that success. A shutdown ends a detached settlement. The broadcast log line survives both.
- **Known gaps found by the seventh critic and left as limits:**
  - **Ambiguous send:** if the node accepts a send but its response is lost, the hash goes unlogged and the nonce is reset.
  - **Eviction:** the 10,000-record cap evicts the oldest records first, including real pending ones. Since hemi.9 this applies to kept records only, and only another kept record pushes one out (D-019).
  - **Stock-seller claims:** a kept success can be claimed only by a direct `/settle` caller, never by a stock seller, which always verifies first.

  None of these allows a double charge, because the payer's on-chain nonce still guards the payment. Each is listed in README "Limits and open items".
- **Build:** base images are pinned by digest, and each patch is applied with `git apply --check`, so upstream drift fails the build. A no-cache build takes about 115 s on the workstation (Colima, 4 CPUs). The image is 170 MB.

hemi.8 adds patch 0019 (D-018). On 2026-10-29 its no-cache build took 119 s, and the e2e suite passed: 10 files, 103 tests.

hemi.9 adds patches 0020 and 0021 (D-019). On 2026-10-30 a build that reused the cached dependency layer took 20 s, and the e2e suite passed: 11 files, 104 tests. No no-cache build was run then, because the workstation's Docker disk was full. On 2026-11-01 one of hemi.9 took 143 s, and the suite passed on it: 11 files, 104 tests. An earlier no-cache build that day took 118 s, and the suite passed on that one too, in 141 s.

Verified on 2026-10-29 against a no-cache hemi.7 build (113 s):

- **e2e suite:** 9 files, 101 tests passed, with dead primary RPCs and no expected-failure markers.
- **Rust checks:** `cargo fmt`, `clippy -D warnings` and the unit tests pass at each patch commit.
- **Demo:** `buyer/demo-fork.sh` settles all four asset and network pairs, and the seller logs a `/verify` before each `/settle`.

The alternative was the stock image with the deviations documented. It was rejected because it fails a Definition-of-done item. The TypeScript facilitator fallback in the brief is for cases where the Rust config cannot express what Hemi needs. This gap is not Hemi-specific, and a patch keeps the Rust facilitator the brief chose.

## D-017. Testnet funding: where USDC.e and hBTC come from

Checked on 2026-10-29 for the live testnet run. Ethereum Sepolia reads use `https://ethereum-sepolia-rpc.publicnode.com`, since dRPC's free plan refuses Sepolia and `rpc.sepolia.org` timed out.

**USDC.e** is an OP Stack bridged token. Its L1 token is Aave V3's Sepolia test USDC, which Aave's faucet mints to anyone. Circle's Sepolia USDC is a different token and does not bridge to it.

```
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 'remoteToken()(address)' / 'bridge()(address)' --rpc-url https://testnet.rpc.hemi.network/rpc
0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8    0x4200000000000000000000000000000000000010
$ cast call 0x4200000000000000000000000000000000000010 'OTHER_BRIDGE()(address)' --rpc-url https://testnet.rpc.hemi.network/rpc
0xc94b1BEe63A3e101FE5F71C80F912b4F4b055925
$ cast call 0xc94b1BEe63A3e101FE5F71C80F912b4F4b055925 'OTHER_BRIDGE()(address)' --rpc-url $SEPOLIA     # the pair points back
0x4200000000000000000000000000000000000010
$ cast call 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8 'mint(uint256)(bool)' 1000000 --from <buyer> --rpc-url $SEPOLIA
Error: execution reverted: Ownable: caller is not the owner
$ cast call 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8 'owner()(address)' --rpc-url $SEPOLIA
0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D         # Blockscout name "Faucet"
$ curl -sS https://raw.githubusercontent.com/bgd-labs/aave-address-book/main/src/AaveV3Sepolia.sol | grep -E 'FAUCET|USDC_UNDERLYING'
  address internal constant FAUCET = 0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D;
  address internal constant USDC_UNDERLYING = 0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8;
$ cast call 0xC959483DBa39aa9E78757139af0e9a2EDEb3f42D 'isPermissioned()(bool)' --rpc-url $SEPOLIA
false
$ cast call 0xC959…f42D 'mint(address,address,uint256)(uint256)' 0x94a9…E4C8 <buyer> 1000000 --from <buyer> --rpc-url $SEPOLIA
1000000 [1e6]
```

`scripts/testnet-fund-usdc.sh --go` does the mint, the approval and `depositERC20To` from the buyer, then waits for the balance on Hemi testnet. It reads the route from chain state and refuses if any link above no longer holds. On an anvil fork of Sepolia, all three transactions succeeded, the bridge's USDC balance rose by the deposited 10 USDC, and the portal `0xB6f9…2516` emitted `TransactionDeposited`.

Hemi testnet also has Uniswap V3 WETH/USDC.e pools with liquidity, for example `0xA2Ecdf4bdb501cde058608F02fB8c4FC111fDF5C` (1% fee, 18.4 WETH and 12.4M USDC.e) and `0x2f53025Ac91D2843018495014F95f0CB956e3719` (0.3%). Their WETH is the token list's `0x0C8aFD1b58aa2A5bAd2414B861D8A7fF898eDC3A`. Swaps go through an unverified router, `0xA18019E62f266C2E17e33398448e4105324e0d0F`, which is called with `execute`; its selectors are Uniswap's Universal Router's. This route needs no Sepolia ETH.

The buyer was funded this way. The swap was first rehearsed on an anvil fork of Hemi testnet, then sent live with a minimum output of half the rehearsed amount:

```
$ PATH_=$(cast concat-hex 0x0C8aFD1b…dC3A 0x000bb8 0xD47971C7…6443)                  # WETH, 0.3% fee, USDC.e
$ IN1=$(cast abi-encode 'f(address,uint256)' 0x…02 10000000000000)                       # WRAP_ETH into the router
$ IN2=$(cast abi-encode 'f(address,uint256,uint256,bytes,bool)' 0x…01 10000000000000 11281039 $PATH_ false)   # V3_SWAP_EXACT_IN to the sender
$ cast send 0xA18019E6…0d0F 'execute(bytes,bytes[],uint256)' 0x0b00 "[$IN1,$IN2]" <deadline> --value 10000000000000 \
    --priority-gas-price 1000000 --gas-price 3000000 --private-key $BUYER_PRIVATE_KEY --rpc-url https://testnet.rpc.hemi.network/rpc
0xef3d65e09632d360b5623a4550a29aa6405c3ccb4250df72c0073b3272bfecd9    # block 7099151
$ cast call 0xD47971C7…6443 'balanceOf(address)(uint256)' 0x35C8182E886382D1133a3Daf980470D3646D3786
22562078 [2.256e7]                                                                       # 22.56 USDC.e for 0.00001 ETH
```

The first attempt had no explicit tip and was never mined; D-018 explains why.

**hBTC** has no bridge link. Only the Bitcoin tunnel's vault manager mints it:

```
$ cast call 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7 'minter()(address)' --rpc-url https://testnet.rpc.hemi.network/rpc
0x8221CFD3Eca3c5F9FA27b2AE774151642f1C449e         # createVault, confirmDeposit, initiateWithdrawal, ...
```

The most recent mint shows the testnet flow end to end. Testnet `confirmDeposit` tx `0x8741add5…1aac` (2026-09-03) names Bitcoin txid `6d1e2ea4…a63f`. That txid exists on Bitcoin **testnet3**, not testnet4 or signet:

```
$ curl -s https://mempool.space/testnet/api/tx/6d1e2ea41e126bbeb6077feec0c6eb417e28041195d759c776294d3e210ea63f | jq -c '[.vout[] | {value, type: .scriptpubkey_type}]'
[{"value":2000000,"type":"p2pkh"},{"value":0,"type":"op_return"},{"value":7137856320,"type":"v0_p2wpkh"}]
# The OP_RETURN holds the recipient's EVM address as ASCII hex. It was confirmed at 2025-12-12T16:41:10Z, and hBTC minted on Hemi was 1990000.
```

- **Fee:** at least 10,000 sats per deposit. That deposit put in 2,000,000 sats and minted 1,990,000, and the other 2026 deposit put in 1,000,000 and minted 990,000. Both match the vault config's minimum deposit fee:

  ```
  $ cast call 0x321774F8950d6B0E14BC2728b14F8E659548900a 'vaultConfig()(address)' --rpc-url https://testnet.rpc.hemi.network/rpc   # vault 6, which took the deposit
  0xe247931fe161e6f796C39c216692A51050804dDd
  $ cast call 0xe247…4dDd 'getMinDepositFeeSats()(uint256)' / 'getMinDepositFeeBasisPoints()(uint256)' / 'getMaxDepositFeeBasisPoints()(uint256)'
  10000    20    200
  ```

- **Minimum:** the Portal's minimum deposit on testnet is 0.01 BTC, as seen in the Portal on 2026-10-29. Hemi's docs say 0.0001 BTC, which would mint nothing after the 10,000-sat fee. Six Bitcoin confirmations are needed.
- **Faucet:** coinfaucet.eu's testnet3 faucet (`https://coinfaucet.eu/en/btc-testnet/`, hCaptcha) was paying on 2026-10-29; its address `tb1qerzrlxcfu24davlur5sqmgzzgsal6wusda40er` sent six testnet3 transactions that day. A claim is about 0.003 BTC, so 0.01 BTC takes several. bitcoinfaucet.uo1.net and testnet.help now pay testnet4, which the tunnel does not watch. Hemi testnet's Bitcoin view was at testnet3 height 5,223,072, two blocks behind the testnet3 tip.
- **Claim:** the mint is not automatic on testnet. The depositor's own EVM address sent `confirmDeposit`, nine months after the Bitcoin transaction confirmed.
- **Activity:** on 2026-10-29 the vault manager's history showed two confirmed deposits in 2026, both from that one address. The tunnel works, but it is barely used.
- **This repo's funding:** a 0.01 BTC deposit minted 990,000 sats to the owner's wallet on 2026-11-01 (`confirmDeposit` tx `0x9a642524b8ecfaf997301667e0826a6e0f0b53073fe8ae114f9192636ad98d53`), and 90,000 sats went on to the buyer (tx `0xf4070e9c9f272a53d430f3411e0abe1a2eded37a71b196a9b835f9eada82d696`).

So hBTC needs Bitcoin testnet3 coins, a UniSat wallet on "Bitcoin Testnet", a Portal deposit and a claim transaction. There is no faster on-chain source: the top hBTC holders are wallets, not pools.

## D-018. Settlement tips: Hemi testnet's sequencer minimum and patch 0019

Found on 2026-10-29 while funding the testnet buyer (D-017). Hemi testnet's sequencer did not mine a transaction offering a 1-wei tip, and a tip of 0.001 gwei (1,000,000 wei) was mined in the next block. Hemi mainnet does mine much lower tips; see the end of this entry. alloy's default fee estimate, which Foundry and the facilitator both use, tips 1 wei whenever the last ten blocks carry no tips. On Hemi that is common, because most blocks hold only the L1-info deposit.

The live evidence is a swap from the buyer on Hemi testnet, sent twice with the same nonce:

```
$ curl -sS https://testnet.explorer.hemi.xyz/api/v2/transactions/0x82202337644fd19e57c19925a3f0b625e74883b44bec40aac837d90f182c08a5 | jq -c '{result, nonce, max_fee_per_gas, max_priority_fee_per_gas}'
{"result":"pending","nonce":0,"max_fee_per_gas":"507","max_priority_fee_per_gas":"1"}     # cast's estimate; pending for minutes while blocks were produced every 12 s
$ cast tx 0x82202337… --rpc-url https://testnet.rpc.hemi.network/rpc
Error: tx not found          # the public RPC did not even keep it
$ cast send … --nonce 0 --priority-gas-price 1000000 --gas-price 3000000
0xef3d65e09632d360b5623a4550a29aa6405c3ccb4250df72c0073b3272bfecd9   # mined in block 7099151, the next block
$ curl -sS 'https://testnet.explorer.hemi.xyz/api/v2/transactions?filter=validated' | jq -r '.items[] | select(.type==2) | .max_priority_fee_per_gas' | sort -n | head -1
1000000                      # no recently mined transaction tips less
```

Both chains' nodes suggest exactly that tip, and both have tip-less fee histories:

```
$ cast rpc eth_maxPriorityFeePerGas --rpc-url https://testnet.rpc.hemi.network/rpc    → "0xf4240" (1000000)
$ cast rpc eth_maxPriorityFeePerGas --rpc-url https://rpc.hemi.network/rpc            → "0xf4240" (1000000)
$ cast rpc eth_feeHistory 10 latest '[20]' --rpc-url https://testnet.rpc.hemi.network/rpc | jq -c '[.reward[][0]]'
["0x0","0x0","0x0","0x0","0xf4240","0xf4240","0x0","0x0","0x0","0x0"]
$ cast rpc eth_feeHistory 10 latest '[20]' --rpc-url https://rpc.hemi.network/rpc | jq -c '[.reward[][0]]'
["0x0","0x0","0x0","0x0","0x0","0x0","0x0","0x1a602d","0x0","0x0"]
$ curl -sS https://raw.githubusercontent.com/alloy-rs/alloy/v2.0.5/crates/provider/src/utils.rs | grep -n 'EIP1559_MIN_PRIORITY_FEE: u128\|is_empty()'
26:pub const EIP1559_MIN_PRIORITY_FEE: u128 = 1;
96:    if rewards.is_empty() {
```

alloy takes the median of the non-zero rewards and falls back to 1 wei when there are none. The facilitator (x402-rs on alloy-provider 2.0.5, `eip1559: true`) leaves its fees to that estimate, so on testnet a settlement sent after two quiet minutes would never be mined. Since patch 0006 keeps the nonce of an unconfirmed transaction, every later settlement from that signer would queue behind it. The forks never showed this, because anvil mines any tip.

What else sends transactions:

- **Contract deployment:** `contracts/deploy.sh` already passes `eth_maxPriorityFeePerGas` to forge as the tip.
- **Buyer approvals:** viem reads `eth_maxPriorityFeePerGas` itself.
- **Funding scripts:** `scripts/testnet-fund-usdc.sh` sends only on Ethereum Sepolia, where blocks carry tips.

Patch 0019 (image hemi.8) makes the facilitator read both alloy's estimate and `eth_maxPriorityFeePerGas`. It tips the larger of the two and sets the max fee to the estimate's base-fee headroom plus that tip. The e2e test `07-priority-fee.test.ts` mines twelve empty blocks on each fork, then settles. Against hemi.7 it failed on both forks:

```
AssertionError: expected 1 to be greater than or equal to 1000000000
 ❯ e2e/07-priority-fee.test.ts:47:37
```

The first live Hemi testnet settlement through hemi.8 tipped 1,000,000 wei. It did not exercise the patch: my deployment and the buyer's approval had just put 1,000,000-wei tips into the fee history, so alloy's own estimate was the same and hemi.7 would have tipped alike. The patch is shown by `07-priority-fee.test.ts` and the swap above.

The hBTC settlement through hemi.9 on 2026-11-01 did not reach the 1-wei case either. The fee history before it held tips of 999,996 to 999,998 wei, so alloy's estimate was 999,997 and the floor raised it by 3 wei.

Those tips come from a legacy sender with a fixed gas price of 1,000,253 wei. As the base fee rose, its effective tip fell below 1,000,000 and it was still mined. So 1,000,000 wei is not an exact minimum on the effective tip. Where the real minimum sits, between 1 wei and about 1,000,000 wei, is unknown. The node's suggestion is safe either way.

```
$ cast rpc eth_feeHistory 10 0x6ca870 '[20]' --rpc-url https://testnet.rpc.hemi.network/rpc | jq -c '[.reward[][0]]'
["0xf423e","0x0","0x0","0x0","0xf423d","0x0","0x0","0x0","0xf423c","0x0"]       # 999998, 999997, 999996
$ cast block 7121007 --json --full --rpc-url https://testnet.rpc.hemi.network/rpc | jq -c '.baseFeePerGas as $b | .transactions[] | select(.type!="0x7e") | {type, base: $b, gasPrice}'
{"type":"0x0","base":"0x101","gasPrice":"0xf433d"}                              # effective tip 1000253 - 257 = 999996
```

```
$ cast tx 0x0bca64a7f81d3472697852739ab6cb005ff5b08de82c727c997f7e137e3fb6c5 --rpc-url https://testnet.rpc.hemi.network/rpc --json | jq -c '{type, maxPriorityFeePerGas, maxFeePerGas}'
{"type":"0x2","maxPriorityFeePerGas":"0xf4240","maxFeePerGas":"0xf443a"}       # tip 1000000; max fee 1000506 = 2 * 253 + tip
$ cast rpc eth_feeHistory 10 0x6c5355 '[20]' --rpc-url https://testnet.rpc.hemi.network/rpc | jq -c '[.reward[][0]]'    # the ten blocks before it
["0xf4240","0xf4240","0xf4240","0x0","0xf4240","0x0","0x0","0x0","0x0","0xf4240"]
```

Hemi mainnet's sequencer has no 0.001 gwei minimum, although its node suggests that tip too. The critic pass on this change scanned recent mainnet blocks and found 179 mined transactions from 28 senders tipping less, the lowest at 21 wei:

```
$ cast tx 0xe1789ca9346d26d06007a3f0abeb11408fdbf7d405d6c3f0adaa9073ce63b48b --rpc-url https://rpc.hemi.network/rpc --json | jq -c '{blockNumber, maxPriorityFeePerGas, maxFeePerGas}'
{"blockNumber":"0x55a872","maxPriorityFeePerGas":"0x16","maxFeePerGas":"0x116"}   # mined in block 5613682 (it reverted, but it was included); base fee 257
```

Whether mainnet mines a 1-wei tip is unproven either way. On mainnet the floor is a precaution: a settlement uses about 103,000 gas, so a 1,000,000-wei tip costs about 1e-7 ETH.

The alternative was `eip1559: false`, which needs no image change, since `eth_gasPrice` is the base fee plus 1,000,000. It was rejected because a config change would not fix x402-rs for other chains with a minimum tip. This entry first also claimed that such a legacy transaction stops being mined once the base fee rises by 1 wei. The legacy sender above shows that was wrong.

### Open questions

- Q-1. Closed by D-027: both mainnet token addresses match the explorer's records. `curl` from this workstation still hits the TLS block, so the explorer was read in a browser. On 2026-10-29 no alternative mainnet explorer host resolved (`hemi.blockscout.com` and `hemi.explorer.caldera.xyz` return 404; `explorer.hemi.network` does not resolve).
- Q-2. Why the testnet hBK contract's `getLastHeader()` reverts while precompile `0x44` answers (D-012): likely a different hBK release or ABI on testnet. Phase 2.


## D-019. External review on 2026-10-30: record ownership, reachability, testnet runner

An outside review found six issues, and verifying the fixes exposed a seventh. Each was checked against the code before being fixed.

**Record ownership (patch 0020, hemi.9).** Eviction could remove a running settle's record, and its guard would then overwrite or delete the record of a later settle of the same authorization. A retry could receive success with another request's hash. A test of the store at the default capacity reproduced this; the full exploit over HTTP was not run. `facilitator/x402-rs/README.md` has the detail.

The first design refused new settles when the store was full. It was dropped because 10,000 queued garbage requests would then have blocked every real settlement. Instead the cap applies only to kept records, and running records are bounded by their tasks. The first version enforced the cap in `begin`, and a unit test showed that one running settle could still push out a kept record, so it moved to `keep`.

**Reachability.** Compose published the port on every interface, and `/settle` has no authentication, so any reachable caller could spend the signer's gas on self-payments. `FACILITATOR_BIND` now defaults to `127.0.0.1`. The config's `"host": "0.0.0.0"` stays, because it is the address inside the container. A wider binding needs authentication or rate limits in front, which this repo does not provide (README "Limits and open items").

**Testnet runner.**

- It shared the Compose project of a plain `docker compose up`, so `up` could replace a mainnet facilitator and `down` could remove it. It now uses the project `hemi-x402-testnet-run`.
- `/health` on a taken seller port satisfied its readiness check, so it could pay another seller's `payTo` and still record `SELLER_PAY_TO` in `docs/testnet-run.md`. It now refuses a taken port before sending anything, and compares the seller's `payTo`, network and facilitator before paying. The seller also now exits on a listen error: Express 5 passes it to the `listen` callback, which logged "listening".
- Balance checks failed above 2^63-1 wei, about 9.2 ETH, and reported the wallet as unfunded. They now compare decimal strings. `scripts/testnet-fund-usdc.sh` had the same overflow, reachable with an unlimited allowance, and has the same fix.

**SDK docs.** `sdk-patch/README.md` still said testnet payments could not settle. `sdk-patch/PR.md` already recorded the deployment.

**Found while verifying: parallel broadcast (patch 0021, hemi.9).** `buyer/demo-fork.sh` failed intermittently. `FallbackLayer` runs only `eth_sendRawTransactionSync` and `eth_sendTransactionSync` one transport at a time, so `eth_sendRawTransaction` went to every RPC at once. The first response wins, and a JSON-RPC error counts as a response. The demo points primary and fallback at one anvil fork, so one copy was mined and the other rejected. When the rejection answered first, the send failed, the nonce cache was reset, and the bitmap read reported `invalid_transaction_state`, although the transfer went through. The payer was charged and the seller refused service.

| Setup | Failed demo runs | Failed sends |
|------|------|------|
| hemi.8, both RPCs on one fork | 3 of 10 | |
| hemi.9 without 0021, both RPCs on one fork | 5 of 10 | 8 of 76 across these two rows |
| hemi.9 without 0021, dead primary, one live RPC | 0 of 12 | 0 of 48 |
| hemi.9, both RPCs on one fork | 0 of 20 | 0 of 80 |

Patch 0021 makes `eth_sendRawTransaction` a sequential method. It goes to the best-ranked RPC and moves on only if that RPC cannot be reached. The alternative was to keep both copies and treat a duplicate rejection as success. It was rejected because telling a duplicate from a real rejection means reading each node's error text.

The cost is that one node has to forward the transaction, and its rejection stands. A dropped transaction ends in `settlement_pending` with a hash that never mines. A retry cannot fix that, because nothing rebroadcasts it, and the nonce gap stops settlement on that chain until a restart (README, "Nonce gap after a timeout"). A mined settlement reported as failed could not be recovered at all, so this was still the better trade. This entry first said a retry could reconcile the dropped case; a fork test with `anvil_dropTransaction` showed that was wrong. Whether the race ever happened on the live RPCs, where two different nodes answer, was not measured.

The e2e suite could not see this, because its primary RPC is dead and only one RPC ever answered. `08-one-broadcast.test.ts` now runs with two live RPCs behind recording proxies. It counted the wrong number of broadcasts on the image without 0021.

**Verification of all seven fixes.** `cargo fmt`, `clippy -D warnings` and the unit tests pass on the final tree. Removing the sequential method fails a unit test, and so does removing each part of 0020. The series was replayed from `e75adda` and gives the same tree. The runner's checks ran in a sandbox with stubbed `cast`, `docker` and `npm`, which sent nothing. No live `testnet-run.sh --go` was run at the time. On 2026-11-01 the hBTC payment went through the new runner and hemi.9 on Hemi testnet (tx `0x5f511cb01e0bae8d8f07707cb6056e2423a1cf4b533e343630bda57d505dfb0d`). The signer sent exactly one transaction, its nonce rose by one, and `/settle` answered 200. That is the ordinary path of 0020 and 0021 on a live network. Neither failure path, a record race or an unreachable first RPC, has run live.

## D-020. A stalled RPC: bounded requests and a hash check on failed sends

The ninth critic pass, the first to review hemi.9, found that patch 0021 had made a stalled RPC hang `/settle`. All eight Definition-of-done items passed, but this was a regression in an expected condition: the brief says to treat a stalled RPC as expected, and D-013 sets the receipt timeout for that reason.

A send waits for its one RPC, `Http` had no timeout, and the sequential fallback moves on only on a transport error. Reads race and the loser records nothing, so a stalled RPC is never demoted by them.

| Image | `/settle` with the best-ranked RPC stalled, on a fork |
|------|------|
| hemi.8 | settled in 2.7 s |
| hemi.9 | no answer in 100 s; every other settlement hung too; after the sockets dropped, the detached settlement paid with the client gone |

Patch 0022 (image hemi.10) has two parts. Every RPC request ends after 10 s, so the send moves on and the failure counts against that RPC. And the transaction is signed before the send, so that a failed send can ask the chain for the hash before it counts as failed. The second part is needed because the first alone brings back the failure 0021 removed: an RPC can forward the transaction and only then stall, and the next RPC rejects the copy.

```
# tests/e2e/09-stalled-rpc.test.ts on a build with the timeout only
 × stalling after forwarding the transaction: a mined settlement is not reported as failed
AssertionError: expected false to be true // Object.is equality
```

A failure does not always flip the rank at once, which my first version of the test wrongly assumed. alloy scores 70% success over the last ten results plus 30% latency:

| Primary after failed sends | Score | Fallback at this average latency | Score |
|------|------|------|------|
| 1 | 0.924 | 0.16 s | 0.959 |
| 2 | 0.854 | 0.5 s | 0.900 |
| 3 | 0.784 | 1.0 s | 0.850 |

So an RPC that stalls everything costs each settlement about 10 s until it loses rank. The scores above suggest one to three failures, but the fallback's throttle sits inside what alloy times, so under load it looks slow: one suite run needed four (D-023). This entry first claimed one or two for any stalled RPC, and that a settlement stays under the TS SDK's 90 s. D-021 shows that neither held.

Rejected alternatives:

- **Send to both RPCs again:** this is what 0021 removed, because a rejection could win the race.
- **A timeout only on the send:** it needs a per-method layer, and reads with every RPC stalled would still have no limit. One client timeout covers both.
- **Reading each node's error text** to recognise a duplicate: node errors differ. A lookup by hash needs no text.

The critic's other findings were false or missing statements, now corrected:

- A dropped transaction cannot be reconciled by a retry (D-019 had said it could). Nothing rebroadcasts it, and settlement on that chain stops until a restart.
- Files 08 and 09 run with two RPCs that answer, so "every test runs with a dead primary" was false.
- An RPC that answers JSON-RPC errors defeats failover, and it is now listed under Limits. Fixing it would mean replacing alloy's fallback layer.

Verified on 2026-11-01 against a no-cache hemi.10 build (118 s, all 22 patches): `cargo fmt`, `clippy -D warnings` and the unit tests pass; the e2e suite passed, 12 files and 106 tests in 195 s; `forge test` passed 17; `buyer/demo-fork.sh` settled all four payments.

Patch 0022 changes how every transaction is sent, so both assets were then paid live on Hemi testnet through hemi.10: USDC.e in `0x97ecdf92a57a57ca59ebcbef0da4286edfda040811f128051297c407e54c9698` and hBTC in `0xfafc0f4573cb6917a07bd73094eae20a45f310eeb0a567a68962758ec51c9563`. The signer's nonce rose by exactly two, and both broadcasts left about 1.5 s after `/settle` began. Neither live run had a stalled RPC, so the bound and the hash lookup are proven on forks only.

## D-021. Tenth critic pass: a freeze, a lookup race, a lost tip floor and a false time bound

All eight Definition-of-done items passed, as in the ninth pass, but the review of hemi.10 found five major issues. Four were in the code. Each was reproduced on a local fork, and each fix has a test that fails without it, except 0026, which has a unit test only.

| Issue | Failure on hemi.10 | Fix |
|------|------|------|
| Process freeze | 10 rejected settlements a second froze the process in 5 of 5 runs, and hemi.9 in 3 of 4. All workers were parked, and it stayed frozen after the RPCs recovered | 0023 |
| Lookup race | With the primary stalled and the fallback answering `null`, a mined settlement was reported as `invalid_transaction_state`, with no hash | 0024 |
| Tip floor lost | With the tip read failing, the settlement went out at 1 wei | 0025 |
| 90 s bound | With both RPCs stalling sends, no block mined and reads 2 s late, `/settle` took 92.7 s, and the SDK threw at 90 s | 0026 |
| Rank | An RPC that stalled only sends kept its rank: 8 of 8 settlements went to it first, each about 10.5 s | documented |

The rank issue costs latency, not funds. Demoting an RPC for a fixed time after a failed send would need a change to alloy's fallback layer, so it is a listed limit.

The freeze is upstream code that the patches left unchanged. It needs fast rejections under load, and a stalled send does not trigger it.

```
# 0023's test on the old reset_nonce
test chain::pending_nonce_manager::tests::a_reset_waiting_for_the_nonce_lock_does_not_block_the_map ... FAILED
# tests/e2e/09-stalled-rpc.test.ts on hemi.10
 × a stalled RPC and a node that has not seen the transaction: any RPC that knows it counts
 × a failed tip read: nothing is sent, because the estimate alone can be a 1-wei tip
```

The rejected-send case in that file also covers what the critic found untested: without the nonce reset, the next settlement queues behind a gap. D-022 has the mutant run that shows it.

Choices made:

- **A failed tip read fails the settlement.** The alternative, the last good suggestion, needs state and can go stale. Nothing has been sent at that point, so a failure costs a retry.
- **Only a send that timed out gets the long search.** The test is the send's duration against the 10 s limit, because the fallback layer reports only the last error. This entry also said a node that answered has either rejected the transaction or taken it. That is false for a gateway; D-022 corrects it.
- **The time budget starts at `send_transaction`, not at `/settle`.** Threading a deadline from the handler would touch every caller. The 25 s left over for checks before the send is about two reads at the 10 s limit.

Still open, and listed under Limits in the README: an RPC that answers JSON-RPC errors defeats failover, a transaction dropped by its one node stops settlement until a restart, and a send that no RPC can show within the search still counts as failed.

Verified on 2026-11-01 against a no-cache hemi.11 build (247 s, all 26 patches): `cargo fmt`, `clippy -D warnings` and the unit tests pass at each of the four new commits; the e2e suite passed, 12 files and 109 tests in 213 s; `forge test` passed 17; `buyer/demo-fork.sh` settled all four payments. Both assets then settled live on Hemi testnet through hemi.11: USDC.e in `0xf72346bea38dd423109a786e65969682c5d85780297d26dcb821fab059d06bb8` and hBTC in `0x42ec5319355db2357a66c27964854cfa2bff1cf4f8b186caa6a274ae9780eac2`, about 8.9 s each. The signer's nonce rose by exactly two. No live run had a stalled RPC or a failed send, so these fixes are proven on forks only.

The critic also noted that a restart after a nonce gap can give one more failed settlement, with HTTP 500 "nonce too low", because the queued transaction mines and overtakes the cached nonce. The next settlement then succeeds.

## D-022. Eleventh critic pass: where the failed-send path stops

All eight Definition-of-done items passed for the third pass in a row. The review found four more issues in the failed-send path. The critic marked its pass incomplete: its mutant queue did not finish, so it does not count as a clean pass. 0023 and 0025 held up, and the freeze did not return in 3 of 3 runs at the load that froze hemi.10.

| Issue | Trigger | Outcome |
|------|------|------|
| A fast failure got one lookup | A gateway forwards the transaction, then answers 5xx or drops the connection, and no RPC shows it yet | Fixed in 0027, fully only after D-023 |
| A 3 s lookup limit hid a transaction | A send timeout, and both RPCs slower than 3 s | Fixed in 0027: 8 s |
| The search ran past the budget | Both RPCs stalling sends, with reads at 8 s: `/settle` took 93 s | Search capped in 0027, but `/settle` can still pass 90 s (D-023) |
| Settlements during a search queue behind its nonce | Every RPC loses one send, plus traffic in the next 25 s or so | Listed under Limits |
| A JSON-RPC error after forwarding | A gateway forwards the transaction, then answers with a JSON-RPC error, and no RPC shows it at that moment | Listed under Limits |

The fourth could be fixed by resending the same signed bytes during the search, which is safe because the hash is the same. It was left because it adds a retry path to the part of the code that has needed the most correction, for a case that needs every RPC to lose a send.

The fifth cannot be told from a real rejection without reading each node's error text.

Two claims were checked with a mutant that removes the nonce reset after a failed send. Both nonce cases in `09-stalled-rpc.test.ts` fail on it. The swallowed-send case passed when run after the failing rejected-send case, which had left a queued transaction on the fork, and it failed when run alone.

```
 × a rejected send: the settlement fails, and the next one reuses the nonce
 × a send that no RPC answers and no RPC can find: it fails, and the next one reuses the nonce     # run alone
AssertionError: expected false to be true // Object.is equality
```

Verified on 2026-11-01 against a no-cache hemi.12 build (287 s, all 27 patches): `cargo fmt`, `clippy -D warnings` and the unit tests pass; the e2e suite passed, 12 files and 111 tests in 283 s; `forge test` passed 17; `buyer/demo-fork.sh` settled all four payments. Both assets then settled live on Hemi testnet through hemi.12: USDC.e in `0x2a181f78116ce3454c61ede99144143b4241f737f9bb79904c956a1d941da26d` and hBTC in `0xadf0e1b867f0b4a477737cc9a5107a977b34b893101b62b43e8b6a0936b84cf8`, in 16 s and 23 s. Both broadcasts left under 2 s after `/settle` began, and the rest was waiting for blocks.

**Where this stops.** Passes 9, 10 and 11 all passed the Definition of done. Each also found failed-send problems that passes before it had not, and most of the last pass's need faults on several RPCs at once. Passes 12 and 13 are therefore scoped as the brief scopes them: the Definition of done from the README, plus a review of the latest change. The remaining failed-send cases are listed under Limits. All of this path is proven on forks only; no live run had a stalled RPC or a failed send.

## D-023. Twelfth critic pass: a hidden fast failure, and the 65 s claim

All eight Definition-of-done items passed, for the fourth pass in a row. The pass was not clean, and it was right on one point that mattered.

**A hidden fast failure.** D-022 called this fixed, and it was fixed only when both RPCs failed. With one gateway forwarding the transaction and answering 502, the healthy RPC rejected the copy. The fallback layer reports only the last result, so the send looked like a plain rejection, the search was skipped, and a paid settlement came back as failed with no hash. That takes one fault. 0027 now also searches after `already known` or `nonce too low`.

An earlier version of D-019's reasoning rejected reading error text, for deciding whether to send a transaction twice. Here the text only starts a search, so a wrong match costs time and a miss costs what it cost before.

```
# tests/e2e/09-stalled-rpc.test.ts, the single-fault case, on hemi.12
 × one gateway's 502 after forwarding: the other RPC's rejection of the copy does not hide it
AssertionError: expected false to be true // Object.is equality
```

**The time claims.** "Within 65 seconds" and "no hash to lose" were false when every RPC is slow, because a read or a lookup that has started runs to its own limit, and a zero receipt wait still runs two reads. The critic measured:

| Case | `/settle` | Answer |
|------|------|------|
| Both RPCs time out on the send, one forwarded it; reads 5 s, lookups 7.5 s | 83.6 s | hash |
| Both RPCs stall sends; reads and lookups 8 s | 95.6 s | `unexpected_settle_error`, no hash |

These need every RPC degraded at once. The budget stays as a target, and the docs now say so. Capping each round by the time left would add a third timer to this path for a case with no RPC working normally.

**The rank claim.** The full suite on hemi.13 failed one case: a fourth failed send still went to the stalled primary, where my test allowed three. Nothing was lost, and each settlement took about 13 s. `ThrottleLayer` wraps each transport inside `FallbackLayer`, so the 4-per-second limit on the fallback counts as its latency, and under load its score drops. The test now asserts that the rank flips within six settlements, and the docs say "a few". This is from reading the layers and from the one failure, and it was not measured separately.

Verified on 2026-11-01 against a no-cache hemi.13 build (194 s, all 27 patches): `cargo fmt`, `clippy -D warnings` and the unit tests pass; the e2e suite passed, 12 files and 112 tests in 292 s; `forge test` passed 17; `buyer/demo-fork.sh` settled all four payments. Both assets then settled live on Hemi testnet through hemi.13: USDC.e in `0xefd1da7d2f08c7f81c19fd8db2bd368e8ee4411e4b0e1fa80c3a564808badf25` and hBTC in `0x36682a866b72c26eed8aee6b5b88e07b1b05391476a7b6d3ed1a6ab44fc8ec6d`.

**Also fixed:** `package-lock.json` disagreed with `package.json` on the Node version, so `npm install` dirtied a clean clone; and the README now says that Colima shares only `$HOME` by default.

## D-024. Thirteenth critic pass

All eight Definition-of-done items passed, and the amended 0027 held up: the single-fault case that hemi.12 reported as failed settles on hemi.13, with `already known` as well as `nonce too low`. The rebuilt binary has the same sha256 as the image that ran the live payments.

The pass was not clean on one point: a comment in `.env.example` said the mainnet key is needed only with `config.json`, and `config.mainnet.json` needs it too. Two README lines were imprecise, and both are corrected. The search rule omitted that a rejection after a timed-out RPC is still searched for. And searching on a real `nonce too low` makes that failure take about 27 s instead of 4 s, measured on a fork with a stale nonce: each failed cleanly, nothing was sent or charged, and the next settlement succeeded. That cost is accepted, because it needs a nonce gap and a restart, and it is now listed under Limits.

No code changed, so hemi.13 stands.

The fourteenth pass, on the commit with those fixes, was clean: all eight items passed and it found no major issue. It also sent about 178 malformed requests to a fork, and all were answered in JSON with 200, 400 or 413, with no 5xx and no crash. Its three minor notes are fixed: `contracts/README.md` was stale about the testnet deployment, one date was wrong, and "a stalled RPC costs nothing" did not hold under load.

The last is now a limit. In a burst of 30 concurrent payments on a fork with the primary dead, the fallback's throttle held throughput to about 0.3 payments a second, `/verify` took up to 88 s and `/settle` up to 86 s, all 30 were mined, and one answered `settlement_pending`.

Passes 9 to 14 all passed the Definition of done. Pass 13 found no code or funds issue, only the comment above, and pass 14 was clean, on the same image. The brief's condition of two passes in a row is met on that reading. Pass 13 was not fully clean by the stricter rule used here.

## D-025. External review on 2026-11-02: a fast stale RPC hid a mined payment

The review reported that a fast RPC with a stale view could hide a confirmed receipt from the healthy fallback, at 404d96f, and it cited the retry's lookup. The finding was correct, and it understated the problem, because the first settle failed too. Reproduced on hemi.13 on a fork, with the stale RPC first in the race. Each time the transfer was mined and `payTo` paid:

| Stale RPC | First settle | Three retries | Once it recovered |
|------|------|------|------|
| `null` for receipts only | `settlement_pending` in 0.9 s | all pending | success, same transaction |
| Also frozen at an old block | `settlement_pending` in 60.5 s | all pending | success, same transaction |

In the frozen run the fallback served the real receipt 10 times, and all 10 were discarded. The cause is D-015's fan-out: the first answer wins, and `null` counts as an answer. The first settle had its own route. alloy's `get_receipt` ends the wait with an error on one `null` once its block watcher has seen the transaction, so the wait could end in under a second. D-015 checked that a stale block number cannot hide a receipt and did not ask whether a stale receipt could.

A stock seller retries once and then refuses, so this was a further route to **Charged but not served**, on a payment that had landed.

**Live exposure was low but not zero.** A read-only sample on 2026-11-02 took the last transaction of each new block for 230 s from the workstation: 41 receipts, none `null` on either RPC, and dRPC answered first twice. dRPC testnet's `eth_blockNumber` was 5,416,126 against the public RPC's 7,126,964, so its stale backend is still there. This is a short sample from one machine.

**Fix, patch 0028.** `find_receipt` asks each RPC on its own and takes the first real receipt. Both routes use it, and it replaces alloy's watcher. An RPC that stalls holds up no other, because each RPC polls on its own schedule. Only a receipt ends the search early. With no RPC holding it, the answer is `settlement_pending`, as before.

The interval is 7 s, alloy's own for a remote RPC. A first version polled every 3 s, and I changed it before measuring, because every look goes to every RPC and the 4-per-second limit on the public RPC is already the facilitator's capacity limit. The lookups now share each RPC's rate limit with the fallback client, where 0024's had none. The same burst of 30 payments, with the primary dead and a block every 12 s on a fork, measured on both images:

| Image | Payments a second | Slowest `/verify` | Slowest `/settle` | Settled | Pending |
|------|------|------|------|------|------|
| hemi.13 | 0.31 | 79 s | 74 s | 30 | 0 |
| hemi.14 | 0.34 | 46 s | 71 s | 30 | 0 |

**Cost.** With a stalled RPC and no receipt yet, a retry answers after its 8 s lookup limit, where the shared read answered at once, and the last look of a first settle can run 8 s past the wait. With a send that fits its budget and no queue at the throttle, that makes the worst send and wait 73 s, which still leaves 17 s of the TS SDK's 90 s for the checks before the send. An RPC error during a retry now reads the same as `null`, so `details` no longer carry it. These cases all still answer `settlement_pending`, which is right for them.

**The other first-answer reads were audited and left.** A receipt is the only read that confirms an accepted send. The rest happen before a send, or after one that failed, so a stale answer costs a rejection, a revert or a stuck send. On a replay the payment has already moved, and D-026 has that case:

| Read | Stale answer costs |
|------|------|
| Balance, allowance and simulation | A false rejection, or a transaction that reverts and costs gas |
| Fee and gas estimates | A settlement that reverts, or waits in the mempool as `settlement_pending` |
| `authorizationState` and the Permit2 bitmap after a failure | After a revert, the message only: both answers are `invalid_transaction_state`. After a send that failed without a revert and landed, `unexpected_settle_error`, the exception in README **Ambiguous broadcast** |
| Nonce in `PendingNonceManager`, at first use and after a failed send | A low nonce is rejected, or queues behind a transaction the node has not seen |

The nonce is the one to watch. A frozen RPC that keeps winning that read would make settlements fail, or sit pending, until it recovers. That costs availability and hides no payment, so it stays out of this patch, and it is listed in README "Limits and open items".

Verified on 2026-11-02 against a no-cache hemi.14 build (124 s, all 28 patches): `cargo fmt`, `clippy -D warnings` and the unit tests pass, and mutating `find_receipt` back to the first answer fails two unit tests. All four cases in `tests/e2e/10-stale-rpc.test.ts` failed on hemi.13 and pass on hemi.14. The e2e suite passed, 13 files and 116 tests in 361 s. `forge test` passed 17, and `buyer/demo-fork.sh` settled all four payments.

hemi.14 changes how every settlement waits, so both assets were then paid live on Hemi testnet through it on 2026-11-02: USDC.e in `0x4e1991ac8eac568dcef6d0e7fce3959ddf928b970fe96d904c877651d6dcb77c` and hBTC in `0xc45075075efcf7fbdcc463b4e0d01c37ccaca441c115c4acd71a318729810cc4`. Read back from the chain, both have status 1 and one Transfer of the exact price from the buyer to `payTo`. The facilitator holds no tokens, and its log has no warnings or errors (docs/testnet-run.md).

`/settle` took 16.5 s and 16.1 s. They answered 6.2 s and 0.6 s after the mining block's timestamp, which fits the 7 s interval. The gap between the two buyer responses was 18.8 s, against 18.4 s on hemi.13, from one run of each.

This run shows that real RPCs answer the new lookups on the normal path. It had no stale RPC, or none the log shows, so the stale cases are still proven on forks only.

## D-026. Fifteenth critic pass: the first review of hemi.14

All eight Definition-of-done items passed, with no major issue. This was the first critic pass on patch 0028. A no-cache build applied all 28 patches in 118 s, and the rebuilt binary has the same sha256 as the image that ran the live payments. In the critic's own runs, the e2e suite passed 13 files and 116 tests in 362 s, `forge test` passed 17, and `buyer/demo-fork.sh` settled all four payments, also from a fresh clone. All four cases in `tests/e2e/10-stale-rpc.test.ts` failed on hemi.13 and passed on hemi.14.

Its measurements agree with D-025. Nine sequential settles on 12 s blocks averaged 12.09 s on hemi.14 and 12.15 s on hemi.13. The burst of 30 payments ran at 0.33 payments a second against 0.29, from one run of each. With the primary's receipt answers stalled, or answering a 429, a JSON-RPC error, an HTML body or a partial receipt, each settle succeeded through the fallback in under a second.

It found five minor issues. None can send funds anywhere but `payTo` or charge twice. The slow lookups can leave a buyer charged and not served.

| Finding | Trigger | Outcome |
|------|------|------|
| README said lookups had no throttle and were rare | None, docs only | Corrected |
| README said a read error can end the receipt wait early. Since 0028 only a receipt does | None, docs only | Deleted |
| D-025 said a receipt is the only read after a payment has moved. A replay is another | A lagging RPC that answers first, plus a resent payment header | D-025 reworded, new limit |
| The 8 s lookup limit can hide a receipt that hemi.13's 10 s read returned | Every RPC answering receipts in 8 to 10 s | New limit, code unchanged |
| "The worst send and wait 73 s" is not a ceiling | Slow reads on every RPC, read from the code | D-025 reworded |

**The replay.** On a fork of hemi.14, with a fast primary one block behind on `eth_call` and `eth_estimateGas`, `/verify` passed a spent payment. `/settle` then sent a transaction that reverted and cost gas, and answered `invalid_transaction_state`. `payTo` stayed at the one payment. Patch 0028 does not touch those reads. The critic also read that a send that failed without a revert and then landed can end in `unexpected_settle_error` under a stale read. `reverted_transfer` does pass such errors through. This was not measured.

**The slow lookups.** With both RPCs answering receipts in 9 s and a 24 s receipt timeout, on a fork, hemi.14 answered `settlement_pending` after 32.8 s and again on a retry after 8.0 s, and succeeded once the RPCs recovered. hemi.13 settled in 18.6 s. That is a regression from 0028 in a narrow band, and it contradicts the constant's own comment. A 10 s limit would fix it and take the worst send and wait to 75 s. The code stays as it is: this takes every RPC in a 2-second band, the answer is the documented `settlement_pending`, and a change would need hemi.15 with a new live run and new critic passes.

D-025's sample of 41 receipts in 230 s left no artifact, and that count only fits a sample of both chains, which it doesn't say. The critic's own 150 s sample had 27 receipts, none `null` from dRPC.

To compare an older image, a retag alone does not work: `tests/setup/global.ts` runs `docker compose build`, which restores the current tag from cache.

No code changed, so hemi.14 stands.

The sixteenth pass, on those doc edits, was clean: all eight items passed and it found no major issue. The e2e suite passed 13 files and 116 tests in 321 s, `forge test` passed 17, and `buyer/demo-fork.sh` settled all four payments. It sent 4,890 malformed requests with no 5xx, and the facilitator kept answering. It checked the fork measurements above against the code and did not repeat them.

Its seven minor notes were all in the docs, and they are fixed. The x402-rs README kept a clause this entry removed from D-025, and its unit-test count is now 63. The image tag in D-016 had stopped at hemi.13. README **Ambiguous broadcast** now names the stale-read exception. The "73 s" holds only with no queue at the throttle, because the 8 s limit starts after it. The summary above the findings table said no issue could lose funds, which read too broadly beside the slow lookups. dRPC testnet's lag is now about 1.65M blocks, so the two places that said 2.9M say over a million.

Passes 15 and 16 were both clean on hemi.14, with no code change between them, so the brief's condition of two passes in a row is met, on the stricter rule too. No critic has read the last doc fixes, which change no code.

## D-027. Q-1: explorer cross-check of the mainnet tokens

Both mainnet token addresses match the explorer's records, so Q-1 is closed and `shared/hemi.json` does not change. The explorer's search misses USDC.e, so that check needed a direct lookup by address.

`curl` still can't reach `explorer.hemi.xyz` from this workstation (D-002), and a cloud session was refused by its own egress proxy (`curl: (56) CONNECT tunnel failed, response 403`). The two searches and the direct lookup were opened in a browser on this workstation on 2026-11-02 and the responses pasted into the session. They are saved in `docs/spike/q1-explorer/`.

```
GET https://explorer.hemi.xyz/api/v2/tokens?q=hemiBTC    # 38 items, next_page_params null
{"address":"0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28","decimals":"8","holders":"6093","name":"Hemi Bitcoin","symbol":"hemiBTC","total_supply":"2711201034","type":"ERC-20"}
$ cast call 0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28 "name()(string)" / "symbol()(string)" / "decimals()(uint8)" / "totalSupply()(uint256)" --rpc-url https://rpc.hemi.network/rpc
"Hemi Bitcoin"  "hemiBTC"  8  2711201034

GET https://explorer.hemi.xyz/api/v2/tokens?q=USDC.e     # 9 items, next_page_params null, 0xad11…5afA not among them
GET https://explorer.hemi.xyz/api/v2/tokens/0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA
{"address":"0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA","decimals":"6","holders":"5334","name":"Bridged USDC (Stargate)","symbol":"USDC.e","total_supply":"376380862031","type":"ERC-20"}
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "name()(string)" / "symbol()(string)" / "decimals()(uint8)" / "totalSupply()(uint256)" --rpc-url https://rpc.hemi.network/rpc
"Bridged USDC (Stargate)"  "USDC.e"  6  376380862031
```

The nine USDC.e results are `0x614e…0A2f`, six ICHI vaults and two option-style tokens that expired on 2026-08-15. Why the search misses `0xad11…5afA` is unknown: the explorer's own record has symbol `USDC.e`.

These reads, taken before the direct lookup, tie that address to the tokens in the search results and to Stargate:

```
$ cast call 0x614eB485DE3c6C49701b40806AC1B985ad6F0A2f "asset()(address)" --rpc-url https://rpc.hemi.network/rpc
0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA
$ cast call <each ICHI vault in the search> "token1()(address)" --rpc-url https://rpc.hemi.network/rpc
0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA    # all six
$ cast logs --json --from-block 5549782 --to-block 5649782 --address 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA 'Mint(address,address,uint256)' --rpc-url https://rpc.hemi.network/rpc
52 logs, every one with minter 0x45f1a95a4d3f3836523f5c83673c797f4d4d263b
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "isMinter(address)(bool)" 0x45f1A95A4D3f3836523F5c83673c797F4D4d263B --rpc-url https://rpc.hemi.network/rpc
true
$ cast call 0x45f1A95A4D3f3836523F5c83673c797F4D4d263B "token()(address)" / "stargateType()(uint8)" --rpc-url https://rpc.hemi.network/rpc
0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA  1
```

`hemilabs/token-list` version 4.2.0, dated 2026-10-22, still lists the address, and it has no other USDC or hemiBTC entry on 43111. Stargate's own API and docs could not be read, because `stargate.finance` and `docs.stargate.finance` reset the connection from this workstation.

Some tokens in these searches copy a symbol or name. None is in this repo, and none is in Hemi's token list. Buy by address, never by symbol.

| Address | Symbol | What it is | Holders |
|------|------|------|------|
| `0x614eB485DE3c6C49701b40806AC1B985ad6F0A2f` | `USDC.e` | Vault share, `asset()` is `0xad11…5afA` | 6 |
| `0xD172B64AA13d892bb5EB35f3482058eAE0BC5B2a` | `hemiBTC` | Vault share, `asset()` is `0xAA40…ef28` | 1,230 |
| `0x7288e5f79Fa29794242Fa6423DF6e8Fc048c4B32` | `HBTC` | Named `HemiBTC`, 18 decimals. Not read on chain | 1 |

Separately, `hemi.drpc.org`, `hemi-testnet.drpc.org` and `drpc.org` all reset the connection from this workstation at 2026-11-03T00:02Z, though `hemi.drpc.org` had answered read-only checks earlier that day. `stargate.finance` and `docs.stargate.finance` do the same. The reset goes by hostname, so dRPC itself isn't shown to be down, and the block is not the same as D-002's, which answers with 256 bytes of 0xFF:

```
$ openssl s_client -connect 172.66.146.203:443 -servername hemi.drpc.org -brief
write:errno=54
$ openssl s_client -connect 172.66.146.203:443 -servername example.com -brief
CONNECTION ESTABLISHED  Protocol version: TLSv1.3
```

The Hemi public RPCs answered throughout. While this lasts, a run from this workstation has one working RPC, so it should run from another network, which `contracts/verify.sh mainnet` needs anyway. `hemi-mainnet.infura.io` does answer from here (401 without a key), so an Infura key is the fallback.

## D-028. Mainnet checks with the real signer, before deployment

Nothing was sent on mainnet. The signer is a fresh key made with `scripts/new-key.sh` on 2026-11-03 and stored in `.env` as both `DEPLOYER_PRIVATE_KEY` and `FACILITATOR_MAINNET_PRIVATE_KEY`. Its address is `0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875`. The key itself was never printed.

Balances at block 5656743 (2026-11-03T23:13:47Z), from `cast balance`, `balanceOf` and `cast nonce` on `https://rpc.hemi.network/rpc`:

| Wallet | ETH (wei) | USDC.e (base units) | hemiBTC (sat) | Nonce |
|------|------|------|------|------|
| Signer `0x1155…0875` | 205000000000000 | 0 | 0 | 0 |
| Buyer `0x35C8…3786` | 50000000000000 | 1000 | 10 | 0 |
| payTo `0x647C…866f` | 0 | 0 | 0 | 0 |

The buyer's hemiBTC allowance to Permit2 is 0, so its first hemiBTC payment sends one `approve`. 1000 base units of USDC.e pay for exactly one USDC.e payment.

The simulation went through the public RPC, because dRPC is blocked from here (D-027). The full output is in `docs/spike/mainnet-simulation-2026-11-03.log`:

```
$ contracts/deploy.sh mainnet
   signer: DEPLOYER_PRIVATE_KEY
Permit2                    0x000000000022D473030F116dDEE9F6B43aC78BA3   present
EIP-6492 validator         0xdAcD51A54883eb67D95FAEb2BBfdC4a9a6BD2a3B   DEPLOY       579233   899374374541 0.000001478753341257
x402 exact Permit2 proxy   0x402085c248EeA27D92E8b30b2C58ed07f9E20001   DEPLOY       722776  1049186306119 0.000001772144445671
   L2 gas price now: 1000252 wei. Estimated total: 0.000003250897786928 ETH for 2 contract(s).
  signer (HEMI_DEPLOY_PRIVATE_KEY): 0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875
  signer balance (wei): 205000000000000
  checks passed: code hashes, Permit2 DOMAIN_SEPARATOR, proxy PERMIT2()
  contracts deployed in this run: 2
Estimated amount required: 0.00000181099728284 ETH
exit=0
```

The signer holds about 63 times the estimate. forge's own "amount required" leaves out the L1 data fee, which is why it is lower than the script's total. forge's dry-run files are git-ignored, and its "sensitive values" file holds only the RPC URL.

```
$ HEMI_MAINNET_FORK_BLOCK=5656750 forge test      # docs/spike/mainnet-fork-tests-2026-11-03.log
Ran 3 test suites in 4.05s (8.11s CPU time): 17 tests passed, 0 failed, 0 skipped (17 total tests)
$ FORK_BLOCK_MAINNET=5656750 npm test -w tests    # read by tests/lib/env.ts; testnet fork at its default block
 Test Files  13 passed (13)
      Tests  116 passed (116)
   Duration  370.48s
```

Both suites pass with mainnet state from 2026-11-03, 42,450 blocks after the pinned default. The suite stopped its forks and containers when it finished.

## D-029. Mainnet deployment of the validator and the exact proxy

Run on Dimitry's go, 2026-11-04 at 00:06Z, from `0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875` (D-028). The script's simulation ran again first, then the broadcast, then its read-only post-check. The full output is in `docs/spike/mainnet-deploy-2026-11-03.log`; the file is named for the local date.

```
$ CONFIRM_MAINNET_DEPLOY=yes contracts/deploy.sh mainnet --broadcast
  [skip]   Permit2: code already at 0x000000000022D473030F116dDEE9F6B43aC78BA3
  [deploy] EIP-6492 validator -> 0xdAcD51A54883eb67D95FAEb2BBfdC4a9a6BD2a3B
  [deploy] x402 exact Permit2 proxy -> 0x402085c248EeA27D92E8b30b2C58ed07f9E20001
ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.
  https://explorer.hemi.xyz/tx/0x9d5d7876579c12f86440bd2e74750bb0748b9d4a07a9836c69bbe6332aa0721e status=0x1 gasUsed=0x8aa4b
  https://explorer.hemi.xyz/tx/0x237bd41c34b314dfa686311685bde4dbfe63e4c5becd66293a91198aa182ec79 status=0x1 gasUsed=0xad23f
== Post-deployment check (simulation, should deploy nothing)
  checks passed: code hashes, Permit2 DOMAIN_SEPARATOR, proxy PERMIT2()
  contracts deployed in this run: 0
All three contracts are in place on Hemi mainnet.
exit=0
```

Read back separately from both RPCs. dRPC answered again by then. Both gave the same answers:

```
$ cast receipt <hash> --json --rpc-url {https://rpc.hemi.network/rpc, https://hemi.drpc.org}
0x9d5d7876  block 5657008  status 0x1  from 0x1155…0875  to 0x4e59…956C  gasUsed 567883  effectiveGasPrice 1000252  l1Fee 1286310174263  fee 1854336280779 wei
0x237bd41c  block 5657009  status 0x1  from 0x1155…0875  to 0x4e59…956C  gasUsed 709183  effectiveGasPrice 1000252  l1Fee 1543552799895  fee 2252914514011 wei
$ cast tx <hash> input    # compared with contracts/deploy-data/
0x9d5d7876  input == validator6492.calldata.hex   nonce 0  value 0
0x237bd41c  input == exact-proxy.calldata.hex     nonce 1  value 0
$ cast keccak $(cast code <address>)
0xdAcD51A54883eb67D95FAEb2BBfdC4a9a6BD2a3B  0x9b83857bbb34de3ba755156ba9bee06532be5ff539bf5de301a28606c76d6cab   # = VALIDATOR_CODEHASH
0x402085c248EeA27D92E8b30b2C58ed07f9E20001  0xce6429c0bb49284660683287c0a8fe548a88379072327d026626909d202048b9   # = EXACT_PROXY_CODEHASH
$ cast call 0x402085c248EeA27D92E8b30b2C58ed07f9E20001 "PERMIT2()(address)"
0x000000000022D473030F116dDEE9F6B43aC78BA3
$ cast balance / cast nonce 0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875
200892749205210 wei, nonce 2
```

The two fees add up to 4107250794790 wei, about 0.0000041 ETH. That is exactly what the signer's balance fell by. The L1 data fee had risen since D-028's simulation, so the script's estimate at broadcast time was 0.0000044 ETH. The signer keeps 0.00020 ETH for settlement gas.

`contracts/verify.sh mainnet` has not run. `curl` to `explorer.hemi.xyz` still fails here with `tlsv1 alert protocol version` (D-002). Both contracts are what the code hashes say, and verification only adds source on the explorer.

## D-030. The facilitator live on mainnet: /supported and /verify failures, read-only

Run on 2026-11-04 from 01:20Z to 01:21Z, after D-029, as step 4 of README "Mainnet deployment". Nothing was sent. The checks call `GET /supported` and `POST /verify` only. The new script `tests/live/verify-failures.ts` refuses to call `/settle` at all. Every payload it sends is signed by a throwaway key it makes itself, so it reads no key from `.env`. The full output is in `docs/spike/mainnet-verify-checks-2026-11-03.log`.

First the mainnet-only config, then `config.json` with both chains. Both started cleanly with hemi.14. x402-rs checks at startup that Permit2, the proxy and the validator exist on every configured chain, and before D-029 the mainnet config could not start (README "The facilitator").

```
$ FACILITATOR_CONFIG=config.mainnet.json docker compose up -d
$ npx tsx tests/live/verify-failures.ts --networks eip155:43111 \
    --signer eip155:43111=0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875 --funded-payer 0x35C8182E886382D1133a3Daf980470D3646D3786
PASS  /supported networks: 200 {"extensions":[],"kinds":[{"extra":{},"network":"eip155:43111","scheme":"exact","x402Version":2}],"signers":{"eip155:43111":["0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875"]}}
...
PASS  unserved network eip155:743111: 200 {"invalidMessage":"Unsupported chain","invalidReason":"invalid_network",...}
PASS  signer eip155:43111 sent nothing: pending nonce 2 -> 2
all checks passed                                   # 14 checks

$ docker compose down && docker compose up -d       # config.json
$ npx tsx tests/live/verify-failures.ts --networks eip155:43111,eip155:743111 \
    --signer eip155:43111=0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875 \
    --signer eip155:743111=0xD2B2fc8093f8A734c42B90762FD2B2F8464631af --funded-payer 0x35C8182E886382D1133a3Daf980470D3646D3786
PASS  /supported networks: 200 {...,"kinds":[{...,"network":"eip155:43111",...},{...,"network":"eip155:743111",...}],"signers":{"eip155:43111":["0x1155…0875"],"eip155:743111":["0xD2B2…31af"]}}
...
PASS  signer eip155:43111 sent nothing: pending nonce 2 -> 2
PASS  signer eip155:743111 sent nothing: pending nonce 15 -> 15
all checks passed                                   # 24 checks
$ docker compose down
```

Every verdict came back HTTP 200 with `isValid: false`, in the spec's §5.4.2 shape (`verifyFailureViolations` in `tests/lib/spec.ts`). Each carried the payer, except `invalid_network`, where the facilitator reads no payload. The answers were the same on both runs:

| Case | USDC.e mainnet (EIP-3009) | hemiBTC mainnet, USDC.e and hBTC testnet (Permit2) |
|------|------|------|
| Fresh key, correctly signed, holds nothing | `insufficient_funds` | `permit2_allowance_required` |
| Fresh key signs, `from` is the funded buyer | `invalid_exact_evm_payload_signature`, payer the buyer | same |
| One bit of `r` flipped | `invalid_exact_evm_payload_signature` | same |
| Signed for 5x the price, presented at the price | `invalid_exact_evm_payload_authorization_value_mismatch` | same |
| Network `eip155:1`, or testnet on the mainnet-only config | `invalid_network` | |

The funded buyer `0x35C8…3786` held 1000 USDC.e units and 10 hemiBTC sats on mainnet, both with Permit2 allowance 0. On testnet it held 22556078 USDC.e units and 89994 hBTC sats, both approved. In the wrong-key cases the signature was rejected first. On balance and allowance alone, mainnet USDC.e and both testnet assets would have passed, and mainnet hemiBTC would have answered `permit2_allowance_required`. So the DoD's failed-signature case now holds live on both chains. Its insufficient-balance case holds live only for mainnet USDC.e. Every Permit2 asset, which includes all of testnet, checks the allowance first, so an unfunded payer gets `permit2_allowance_required` instead. On forks, `04-insufficient-balance.test.ts` covers that case under both transfer methods.

The facilitator log has no settle lines. For each failed verify it logs the whole request body at WARN, signatures included. A logged authorization can only pay the `payTo` it names, but the log should be treated as private.

No payment has run on mainnet. The payments (step 6) need a separate go.

## D-031. First mainnet payment: 0.001 USDC.e by EIP-3009

Run on Dimitry's go ("Go, pay USDC.e") on 2026-11-04 at 17:21Z, as README "Mainnet deployment" steps 4 to 6, with hemi.14 and the mainnet-only config. It was one payment, sent once. The go covered USDC.e only, so hemiBTC has not been paid. The full output is in `docs/spike/mainnet-payment-usdc-2026-11-04.log`.

Before, at block 5662179, read from both RPCs: the buyer `0x35C8…3786` held 1000 units (0.001 USDC.e), payTo `0x647C…866f` held 0, and the signer `0x1155…0875` had 200892749205210 wei at nonce 2. Neither the signer nor the proxy held USDC.e. The seller's 402 offered exactly 1000 units of `0xad11…5afA` on `eip155:43111` to `0x647C…866f`, by `eip3009` with domain `Bridged USDC (Stargate)` version `2`. It also offered 1 sat of hemiBTC.

```
$ FACILITATOR_CONFIG=config.mainnet.json docker compose up -d
$ SELLER_NETWORKS=eip155:43111 npm run start -w seller
$ ALLOW_MAINNET=yes npm run pay -w buyer -- --asset usdc --network mainnet
[buyer] paying 1000 base units of USDC.e (0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA) on eip155:43111 to 0x647C8d7129c0E995B36eF8AAA98f610D5E8f866f via eip3009
[buyer] response: {"echo":{"hello":"hemi"},"timestamp":"2026-11-04T17:21:31.573Z"}
[buyer] tx:       0xa9b7c8c5b605cc0269a9ac55a3053e4d90fd2d5c69d0aeec4092e08b90a9a53d
[buyer] buyer balance: 0.001 USDC.e -> 0 USDC.e
[buyer] payTo balance: 0 USDC.e -> 0.001 USDC.e
[seller] verified 1000 of 0xad11…5afA on eip155:43111 from 0x35C8182E886382D1133a3Daf980470D3646D3786
[seller] settled 1000 of 0xad11…5afA on eip155:43111 from 0x35C8…3786: tx 0xa9b7c8c5…a53d
facilitator: POST /verify status=200 elapsed=389ms; POST /settle status=200 elapsed=8678ms
```

Read back separately from the Hemi public RPC and dRPC. Both returned the same receipt:

```
$ cast receipt 0xa9b7c8c5…a53d
status 0x1  block 5662182  from 0x1155…0875 (signer)  to 0xad11…5afA (USDC.e)
gasUsed 100520  effectiveGasPrice 1000252  l1Fee 1150823163072  fee 1251368494112 wei
logs, both from USDC.e, no others:
  AuthorizationUsed(authorizer 0x35C8…3786, nonce 0xd5a0c21f…8014)
  Transfer(from 0x35C8…3786, to 0x647C…866f, value 1000)
$ cast tx 0xa9b7c8c5…a53d        nonce 2, value 0, type 2, maxPriorityFeePerGas 1000000 (0.001 gwei)
$ cast calldata-decode transferWithAuthorization(...)   from 0x35C8…3786, to 0x647C…866f, value 1000, validAfter 0, validBefore 1793813191
$ cast call 0xad11…5afA "authorizationState(address,bytes32)(bool)" 0x35C8…3786 0xd5a0c21f…8014
true
```

After:

| Wallet | USDC.e | ETH | Nonce |
|------|------|------|------|
| Buyer `0x35C8…3786` | 1000 → 0 | 50000000000000, unchanged | 0, unchanged |
| payTo `0x647C…866f` | 0 → 1000 | 0 | 0 |
| Signer `0x1155…0875` | 0 | 200892749205210 → 199641380711098 | 2 → 3 |
| Proxy `0x4020…0001` | 0 | | |

What this shows:

- **Funds:** USDC.e went from the buyer to payTo in one exact transfer of the price. The facilitator only paid gas, and its ETH fell by exactly the receipt's fee, about 0.0000013 ETH.
- **No buyer gas:** the buyer sent nothing and paid no gas. Mainnet USDC.e needs only a signature (D-001).
- **Tip:** the settlement used the tip floor of 0.001 gwei (D-018).
- **Replay:** the authorization is spent on chain, so it cannot be replayed.
- **Order:** the seller verified before settling. The full settle took 8.7 s.

The EIP-3009 path, until now tested only on a fork of mainnet, has now worked live. The signer keeps 0.00020 ETH, about 160 such settlements at this fee. The buyer now holds no USDC.e. A hemiBTC payment needs its own go. The buyer still holds 10 sats of hemiBTC and 0.00005 ETH for the one-time Permit2 approval.

Both services were stopped afterwards. Explorer verification of the contracts (step 3) has still not run.

## D-032. Second mainnet payment: 1 sat of hemiBTC by Permit2

Run on Dimitry's go ("Go, pay hemiBTC") on 2026-11-04 at 17:30Z, set up as D-031. It was one payment, sent once. The full output is in `docs/spike/mainnet-payment-hemibtc-2026-11-04.log`.

Before, at block 5662223, read from both RPCs:

- **Buyer `0x35C8…3786`:** 10 sats of hemiBTC, Permit2 allowance 0, and 50000000000000 wei.
- **No custody:** payTo, the signer, the proxy and Permit2 held no hemiBTC.
- **Signer:** nonce 3.
- **Approval estimate:** 47024 gas.

The seller's 402 offered exactly 1 sat of `0xAA40…ef28` ("Hemi Bitcoin", 8 decimals) to `0x647C…866f`, by `permit2`.

```
$ ALLOW_MAINNET=yes npm run pay -w buyer -- --asset btc --network mainnet
[buyer] paying 1 base units of hemiBTC (0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28) on eip155:43111 to 0x647C8d7129c0E995B36eF8AAA98f610D5E8f866f via permit2
[buyer] approve(Permit2, max) sent: 0x2798788aa8454916a17f1b332603a7aa2cf3e297374cd519cbdaed1985cc6a56
[buyer] response: {"echo":{"hello":"hemi"},"timestamp":"2026-11-04T17:30:38.999Z"}
[buyer] tx:       0xaa3d89f453e5a2862bbb5689f52ddb3e18e9bb9851e855937baf2c5d47fa3b27
[buyer] buyer balance: 0.0000001 hemiBTC -> 0.00000009 hemiBTC
[buyer] payTo balance: 0 hemiBTC -> 0.00000001 hemiBTC
[seller] verified 1 of 0xAA40…ef28 on eip155:43111 from 0x35C8182E886382D1133a3Daf980470D3646D3786
[seller] settled 1 of 0xAA40…ef28 on eip155:43111 from 0x35C8…3786: tx 0xaa3d89f4…3b27
facilitator: POST /verify status=200 elapsed=722ms; POST /settle status=200 elapsed=8937ms; no WARN or ERROR lines
```

Read back separately from the Hemi public RPC and dRPC. Each receipt was byte-identical on both:

```
$ cast receipt 0x2798788a…6a56     # the buyer's one-time approval
status 0x1  block 5662227  from 0x35C8…3786 (buyer)  to 0xAA40…ef28 (hemiBTC)  nonce 0
input approve(0x000000000022D473030F116dDEE9F6B43aC78BA3, 2^256-1)
logs: Approval(owner 0x35C8…3786, spender Permit2, 2^256-1)
gasUsed 46641  effectiveGasPrice 1000252  l1Fee 345153091200  fee 391805844732 wei, paid by the buyer

$ cast receipt 0xaa3d89f4…3b27     # the settlement
status 0x1  block 5662228  from 0x1155…0875 (signer)  to 0x4020…0001 (x402 exact proxy)  nonce 3
input settle(((0xAA40…ef28, 1), nonce 7135…6282, deadline 1793813738), owner 0x35C8…3786, (to 0x647C…866f, validAfter 0), signature)
logs, no others:
  hemiBTC Transfer(from 0x35C8…3786, to 0x647C…866f, value 1)
  proxy   Settled()
gasUsed 102102  effectiveGasPrice 1000252  l1Fee 891238098926  fee 993365828630 wei, paid by the signer
$ cast call Permit2 "nonceBitmap(address,uint256)(uint256)" 0x35C8…3786 <nonce >> 8>     # bit 74 set: the nonce is spent
```

After:

| Wallet | hemiBTC | ETH | Nonce |
|------|------|------|------|
| Buyer `0x35C8…3786` | 10 → 9 | 50000000000000 → 49608194155268 (the approval fee) | 0 → 1 |
| payTo `0x647C…866f` | 0 → 1 | 0 | 0 |
| Signer `0x1155…0875` | 0 | 199641380711098 → 198648014882468 (the settlement fee) | 3 → 4 |
| Proxy `0x4020…0001` | 0 | | |
| Permit2 `0x0000…8BA3` | 0 | | |

What this shows:

- **Funds:** the token moved from the buyer straight to payTo in one Transfer of the price. The proxy and Permit2 held nothing before or after, and the facilitator only paid gas.
- **Permit2 path:** the path every Permit2 asset uses ran live on mainnet through the newly deployed proxy (D-029). The buyer's only transaction was the one-time approval, as README "For buyers" says.
- **Allowance:** the approval stays at max for later payments. The SignatureTransfer path does not reduce it.
- **Tips:** both transactions tipped 0.001 gwei.
- **Order:** the seller verified before settling, and the full settle took 8.9 s.

Both mainnet payments in the brief have now run. The signer keeps 0.000199 ETH. The buyer holds 9 sats of hemiBTC, 0 USDC.e and 0.0000496 ETH. Both services were stopped afterwards. Explorer verification of the contracts (step 3) has still not run.

## D-033. Seventeenth critic pass: the mainnet work

A fresh-context critic ran the Definition of done from the README on 2026-11-04. It covered everything since D-026: commits 1325d54 to 3eb0670 and the uncommitted D-032. It was barred from sending live transactions, calling `/settle` on a live facilitator, reading `.env`, and editing or committing files.

All eight items passed, with no major issue. Its own checks:

- **Live mainnet claims:** all five mainnet receipts were byte-identical on the Hemi public RPC and dRPC. Every block, fee, nonce, input, log, code hash and balance in README and D-028 to D-032 matched the chain. That includes the spent EIP-3009 authorization, the Permit2 nonce bit, and the zero token balances of the signer, the proxy and Permit2.
- **Live facilitator:** with `config.json`, `/supported` listed both networks and both signers. `tests/live/verify-failures.ts` passed 24 checks on both chains, and README step 4's own command passed 12 on mainnet alone. Neither signer's nonce moved.
- **Suites on forks:** the e2e suite passed 13 files and 116 tests in 305 s. `forge test` passed 17. `buyer/demo-fork.sh` settled all four payments.

It found seven minor issues. None can send funds anywhere but `payTo`.

| Finding | Trigger | Outcome |
|------|------|------|
| `scripts/new-key.sh` missed a key written as `NAME = 0x…` and appended a second one. Node's env-file loader and compose then read the new, unfunded key | A hand-edited `.env` with spaces around `=` | Fixed: spaces are accepted. A line that names the key in any other form, such as `NAME: value`, is refused |
| `new-key.sh` replaced a symlinked `.env` with a plain file, so the link's target never got the key | `.env` as a symlink | Fixed: refused |
| `contracts/README.md` still said `deploy.sh` had not broadcast on mainnet | None, docs only | Corrected |
| D-030 said 25 checks on both chains; the log has 24 | None, docs only | Corrected |
| README and D-030 claimed a live insufficient-balance answer on both chains. Permit2 assets answer `permit2_allowance_required` first, so only mainnet USDC.e showed one | None, docs only | Reworded |
| D-030 called paying step 5; it is step 6 | None, docs only | Corrected |
| README's spike section said the contracts were deployed on testnet only. The two payment logs gave read times as block times | None, docs only | Corrected |

The critic also flagged that the hemiBTC evidence log was untracked while README cited it. It goes in with this entry's commit.

`new-key.sh` was retested on scratch files under macOS bash 3.2, and all 15 cases passed:

- **The two new cases:** a spaced key with a value is refused, and a spaced empty one is filled in place. A symlink and the colon form are both refused.
- **Earlier cases, still holding:** a comment that mentions the name is ignored. Empty names are filled and missing ones appended. The file ends at mode 600, with no temp file left. The printed address matches the key that sourcing and Node's `--env-file` read, and no key appears in the output. A rerun, a bad name, a duplicate and no arguments are all refused. `export NAME=""` in a CRLF file is filled, and a missing file is created.

The critic otherwise found no path in `new-key.sh` that prints or loses a key, and nothing wrong in `tests/live/verify-failures.ts`.

The facilitator image is unchanged (hemi.14). Passes 16 and 17 both passed every item with no major issue. The changes since pass 16 are the deployment, the live checks, the payments, `new-key.sh` and the new read-only script, none of them in the facilitator. No critic has read this entry's fixes to `new-key.sh`.

## D-034. Mainnet explorer verification, and why curl can't reach the explorer

This was step 3 of README "Mainnet deployment", on 2026-11-04 from about 18:05Z to 18:12Z. Nothing was submitted, and `contracts/verify.sh mainnet` did not run.

**Why the CLI fails.** Dimitry reported the explorer was reachable in a browser, failing only now and then with a "can't provide secure access" error. From this workstation at the same time, every TLS client failed on `explorer.hemi.xyz` alone:

- macOS curl (LibreSSL): `tlsv1 alert protocol version`.
- Node fetch and Python urllib (OpenSSL): `WRONG_VERSION_NUMBER`.
- The app's built-in browser: navigation failed, while `testnet.explorer.hemi.xyz/api/v2/stats` loaded.

Raw TLS handshakes to one Cloudflare IP, `104.18.22.222`, from Python, changing only the server name:

```
SNI explorer.hemi.xyz            first bytes back: ff ff ff ff ff ff …   (not TLS)
SNI testnet.explorer.hemi.xyz    16 03 03 …  TLS 1.3 handshake
SNI hemi.xyz                     16 03 03 …  TLS 1.3 handshake
SNI www.cloudflare.com           16 03 03 …  TLS 1.3 handshake
$ curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' http://explorer.hemi.xyz/          # 18:10:57Z
302 https://<the ISP's warning page>?url=http://explorer.hemi.xyz/&token=<redacted>
$ curl … http://testnet.explorer.hemi.xyz/
301 https://testnet.explorer.hemi.xyz/
```

This confirms and sharpens D-002. The workstation's ISP filters the one hostname `explorer.hemi.xyz`. Plain HTTP is redirected to its warning page, and a TCP TLS connection gets non-TLS bytes back. The browser most likely gets through over HTTP/3 (QUIC on UDP), which the filter doesn't touch; that was not measured. The occasional browser error fits a fallback to TCP. Nothing here tells whether other networks fail too. No attempt was made to route around the filter.

**Verification status**, read in Brave by Dimitry and pasted here. The three address responses are saved in `docs/spike/mainnet-explorer/`. The first look at `/api/v2/smart-contracts/<address>` returned bytecode only for all three contracts, which is Blockscout's answer for an unverified contract. A few minutes later, `/api/v2/addresses/<address>` gave:

| Contract | `is_verified` | `name` | Creation tx | Creator |
|------|------|------|------|------|
| x402 exact proxy `0x4020…0001` | true | `x402ExactPermit2Proxy` | `0x237bd41c…2ec79` | `0x4e59…956C` |
| EIP-6492 validator `0xdAcD…2a3B` | true | `UniversalSigValidator` | `0x9d5d7876…0721e` | `0x4e59…956C` |
| Permit2 `0x0000…8BA3` | false | null | null | null |

As on testnet, the first request made Blockscout search its shared bytecode database (contracts/README.md "Explorer verification"), and that verified the two contracts this project deployed. The address endpoint doesn't say whether a match is full or partial. Every database match found on 2026-10-28 was partial, and the proxy can only be partial.

Blockscout knows no creation transaction or creation bytecode for Permit2, and the lookup did not verify it. This project did not deploy it. Its code was checked against the canonical code hash (D-004), which is what the facilitator relies on. Verifying it would mean submitting Uniswap's Permit2 source (solc 0.8.17, via-IR, 1,000,000 runs) from a connection the filter doesn't touch. It changes nothing on chain, so it stays undone.

Step 3 is done for the contracts this project deployed. README and contracts/README now say so, and describe the filter instead of a block.

## D-035. Upstream x402-rs PRs #138, #140 and #142 against the settlement patches

Asked on 2026-11-09 whether the patches are still needed. Read-only: `gh api`, `gh pr view` and `gh pr diff`, with the diffs saved outside the repo.

**Upstream state.** `x402-rs/x402-rs` `main` is still `e75adda` (2026-07-13), the commit the image pins, on every branch; the last merged PR is #100 from 2026-07-08; 58 issues and PRs are open. `x402-foundation/x402` has moved 64 commits past the SDK patch's base `e4a0868`, to `6e9400d`, and at that commit `constants.ts`, `defaultAssets.ts` and the network-support docs have no Hemi entry. The SDK patch applies cleanly to `6e9400d` (`git apply --check` on the five files it touches). So both patch sets are still needed: nothing upstream fixes what they fix, and `@x402/evm` 2.30.0 does not know Hemi.

**The overlapping PRs**, all by `zachsplat`, stacked: #140 carries #138's commit `c6a8680`, and #142 carries both plus `a15d29a` and `ef0e0ff`. They predate this repo (2026-10-11 to 23). The README of `facilitator/x402-rs` now has the comparison. The points below were checked in the diffs, not taken from the descriptions:

```
#138 handlers.rs   X402SchemeFacilitatorError::SettlementPending { .. } => StatusCode::ACCEPTED      (ours: 200, patch 0018)
#138 provider.rs   RECEIPT_RETRY_ATTEMPTS = 3; RECEIPT_RETRY_INITIAL_DELAY = 1 s;
                   on ReceiptUnavailable: self.nonce_manager.reset_nonce(from_address).await          (ours: nonce kept, patch 0006)
#140 pending_settlement.rs   PENDING_SETTLEMENT_TTL = 5 * 60 s; key = keccak256(signature); take(key, request_hash)
                   entry recorded in settle_with_pending_store only on Eip155ExactError::ReceiptUnavailable
                   no change to any verify path (the one "verify" in the diff is an import)             (ours: record from settle start, /verify refused, 0011)
#140 provider.rs   RECONCILE_POLL_INTERVAL = 1 s, up to receipt_timeout_secs
#142 config.rs     reconcile_used_authorizations: bool, #[serde(default)] -> false; log_query_max_blocks default 100
#142 authorization_use.rs   AUTHORIZATION_USE_LOOKBACK = PENDING_SETTLEMENT_TTL; LOG_QUERY_MAX_CALLS = 50; EIP-3009 paths only
#142 handlers.rs   no spawn or JoinHandle: a disconnect still cancels the settlement                   (ours: detached, 0015)
```

The type names in #138 are the same as in 0006, `MetaTransactionSendError::ReceiptUnavailable { tx_hash, source }` and `X402SchemeFacilitatorError::SettlementPending`. Both follow x402-rs's own naming, and 0006 was written without reading #138.

**What this means for the drafts.**

- The upstream maintainer has merged nothing for four months, so submitting is unlikely to change the image soon. The patches stay in the image either way.
- If submitted, 0006 and 0011 should go as comments on #138 and #140 and against issue #136, pointing at the three differences that cost funds or service: the nonce reset, the record that starts too late for `/verify`, and the inline settlement that a disconnect cancels. 0028's per-RPC receipt lookup is a third comment on #138.
- The rest of the series has no upstream counterpart and would be new PRs. Issue #119 already asks for 0002's `network` field.
- Nothing changes in this repo's code. The README of `facilitator/x402-rs` gains the comparison table, and the top-level README's **Facilitator memory** limit is what #142 would address.

## D-036. Phase 2: Bitcoin L1 payments verified through hBK, built and integrated on forks

On 2026-11-09 Dimitry asked for phase 2 to be designed, planned, split and started in child sessions. The design was researched read-only against mainnet hBK and the upstream x402 and x402-rs code, approved with three choices (a derived address per payment, the consumption record in a Hemi contract, the live proof on mainnet with one small real payment), and saved as [`docs/phase2/DESIGN.md`](docs/phase2/DESIGN.md). Three sessions then built it in parallel on their own branches; their notes, with every command and output, are [`docs/phase2/contracts.md`](docs/phase2/contracts.md) (A), [`docs/phase2/facilitator.md`](docs/phase2/facilitator.md) (B) and [`docs/phase2/ts.md`](docs/phase2/ts.md) (C). This entry records what the design fixed, what the streams changed, and the integration.

**The scheme.** `exact` on CAIP-2 `bip122:000000000019d6689c085ae165831e93` (Bitcoin mainnet) and `bip122:000000000933ea01ad0ee984209779ba` (testnet3); asset `BTC`, amount in satoshis; `payTo` is the seller's account xpub; `extra.assetTransferMethod "utxo"`, `extra.paymentFlow "upfront"` (a stock seller calls only `/settle`, before its handler), a random `extra.paymentId` per 402 (dynamic field), `extra.addressType` (p2wpkh default, p2tr), `extra.minConfirmations` (default 1); payload `{txid, vout}`. The payment address is child `m/0/i1/i2/i3` of the xpub with the three indices taken from `sha256("x402-btc" ‖ bytes16(paymentId))`. The facilitator verifies through `X402BtcSettler.verify` on Hemi (an `eth_call` that reads `getSpecificTxOutput` and `getTxConfirmations` from hBK) and settles by sending `settle`, which marks `(txid, vout)` consumed and emits `Settled(txid, vout, scriptPubKeyHash, sats, paymentRef, settler)`, `paymentRef = sha256(bytes16(paymentId))`. Success returns `transaction` = the Bitcoin txid, no `payer`. The spec draft is [`docs/specs/scheme_exact_bip122.md`](docs/specs/scheme_exact_bip122.md).

**Two design changes during the build.**

- *Three derivation levels, not one.* The approved rule used one 31-bit index. Stream C showed that anyone holding the public xpub can precompute its 2^31 children, recognise a payment's address in the mempool, brute-force a `paymentId` whose digest gives the same index in seconds, and submit it: the facilitator derives the same script and settles for the attacker. Three levels give 93 bits. Vectors: `btc/test-vectors.json` (16, each with digest, indices, pubkey, script, address and `paymentRef`); the Rust crate reproduces them (B-12).
- *`settle` only by the facilitator's signer.* A permissionless `settle` would let anyone who sees the Bitcoin tx settle first with a bogus `paymentRef` and block the real one. `SETTLER` is an immutable constructor argument; rotating the signer means a new settler.

**Measured, and corrected.** D-012's and the design's reading that hBK's confirmation count is Bitcoin's + 1 came from comparing with mempool.space's tip. Stream A compared with hBK's own tip and with coinbase transactions of the newest blocks: hBK counts Bitcoin confirmations, and a transaction is retrievable only once hVM's last header, two blocks behind the tip, has passed its block. So `CONFIRMATION_OFFSET` is 0, and the earliest acceptance is about 3 Bitcoin confirmations (about 30 minutes) whatever `minConfirmations` says (A-2). The deployed mainnet hBK also returns an `Output` tuple with eight head words, not the ten of `BitcoinKitStructs.sol`, which is why the settler decodes hBK's answers by hand with bounds checks (A-1). `getUTXOsForBitcoinAddress` reverted for every address tried, so nothing uses it.

**What landed** (merged into `feat/facilitator-mvp` in 07df2e3, f4c8b16 and 9321b76, with no conflicts):

- Contracts: `contracts/src/btc/{X402BtcSettler,IHbkReader,HbkTestnetAdapter}.sol`, `MockBitcoinKit` (both hBK ABIs, etched at the real hBK address in tests and on forks), `DeployBtcSettler.s.sol` (CREATE2 through `0x4e59…956C`, `CONFIRM_MAINNET_DEPLOY` gate), `deploy-btc.sh`, `check-btc-live.sh`. 66 forge tests. Predicted addresses: mainnet `0x9Df0B4752D00dF65Fb4f7FfdFe0545543f08ab9f`, testnet `0x56AdDfcC77b087D9101ddEE8D3A38e95E0A365B0`, in `shared/hemi.json`. **Nothing deployed.** `check-btc-live.sh mainnet` ran read-only with the compiled code as a state override: `verify` of the fixture tx `95bca029…367e` vout 1 answered `Ok`, 83050000 sats (A-6). Testnet's hBK has an older `btc*` ABI and could not be shown to work (A-7).
- Facilitator: crate `facilitator/x402-rs/crates/x402-chain-bip122`, patches 0029 (error codes) and 0030 (chain and scheme registration), image `hemi-x402-facilitator:e75adda-hemi.15`. The bip122 provider wraps the registered Hemi provider, so the settle transaction goes through the same nonce manager and the same send path as every other settlement (patches 0006 to 0028 apply). An unset `X402_BTC_SETTLER_*` skips that Bitcoin chain (B-2). The `bitcoin` crate is pinned by a lock fragment the build checks (B-8). 42 crate unit tests.
- TypeScript: workspace `btc/` (`ExactBtcServerScheme`, `ExactBtcClientScheme` with a payment journal, derivation, a minimal wallet on `@scure/btc-signer`, `mock-hbk` helpers), seller and buyer support, the spec draft, `tests/e2e/11-btc-l1.test.ts` (31 tests), `tests/lib/spec.ts` generalised for a Bitcoin `transaction` and an absent `payer`. The buyer drives a pay-then-poll loop and keeps polling on `settlement_pending`, `…_unconfirmed` and `…_transaction_not_found` (TS-7), which supersedes the design's "continue only on `settlement_pending`"; the facilitator keeps the verdict table on both endpoints (B-1). 90 unit tests.

**Integration** (this session, 2026-11-09):

- `scripts/fork.sh up` now places the mock hBK at the real hBK address on each fork, deploys `HbkTestnetAdapter` (testnet) and `X402BtcSettler` with the facilitator's fork signer as `SETTLER` and offset 0, and writes the addresses to `$FORK_STATE_DIR/btc-settlers.env`; `tests/setup/global.ts` and `buyer/demo-fork.sh` pass them to the facilitator as `X402_BTC_SETTLER_{TESTNET,MAINNET}`. A rerun of `up` is a no-op; `down` removes the file. Two `set -e` traps in the first version (reading and `sed -i` on a file that did not exist yet) made the script exit silently after the first settler; both fixed.
- `tests/e2e/01-supported.test.ts` now expects the two bip122 kinds beside the Hemi ones when the settlers are deployed.
- Colima's Lima agent failed its own `ssh -O forward` and `-O cancel` for port 38080 (exit 255) in three runs, leaving the facilitator unreachable or a stale forward that tripped the suite's port guard, as stream C had seen (TS-17). `tests/setup/global.ts` now cancels a stale forward held by Colima's ssh mux before the guard, adds the forward by hand when `/supported` is unreachable 25 s after `compose up`, and cancels it at teardown; only when `~/.colima/_lima/colima/ssh.sock` exists, logged, and off with `E2E_NO_COLIMA_FIX=1`.

```
$ npm test -w tests          # hemi.15, forks with the settlers, dead primary RPCs
 Test Files  1 failed | 13 passed (14)      # the one failure: 01-supported's "nothing but the two Hemi chains", now updated
      Tests  1 failed | 146 passed (147)
   Duration  564.90s
$ (cd tests && npx vitest run e2e/01-supported.test.ts)    # after the update, same stack
      Tests  2 passed (2)
$ (cd contracts && forge test)     66 passed, 0 failed
$ npm test -w btc                  90 passed, 0 failed
$ npm run typecheck --workspaces   clean (shared, btc, seller, buyer, tests)
$ docker compose build             hemi-x402-facilitator:e75adda-hemi.15
```

`buyer/demo-fork.sh` settled all five payments, the fifth being `--asset btc-l1 --network btc-mainnet --stub-pay <fork RPC>`: 1000 sats to the derived address `bc1q9y72z7…ygcy` (`xpub6CatWdiZ…/0/1842827367/182881499/83036790`) written into the mock hBK, verified and settled through `X402BtcSettler` on the mainnet fork, the seller serving once and logging the paymentId and path it needs to spend the funds. It needed the same Colima forward workaround (`DEMO_NO_COLIMA_FIX=1` turns it off).

The 31 Bitcoin tests cover `/supported`; verify and settle with the Bitcoin txid, `settledBy`, the `Settled` event and replay; a confirmations boundary then success with the same payload; unknown txid, missing output, another paymentId's address, a decoy output, one sat short, overpayment, p2tr; the other network's key, `minConfirmations` out of policy, malformed payloads (400); and the stock seller engine with `ExactBtcServerScheme` paid by `ExactBtcClientScheme`: 402 while unconfirmed, served once after, 402 on reuse. The "vout past the end" case that hung in stream C's pre-flight passed here.

**Not done, each on its own go:** the mainnet settler deployment (`CONFIRM_MAINNET_DEPLOY=yes contracts/deploy-btc.sh mainnet --broadcast`, about 0.000011 ETH, from `DEPLOYER_PRIVATE_KEY`), the facilitator config with `X402_BTC_SETTLER_MAINNET`, and one real Bitcoin payment of a few dollars from a buyer wallet Dimitry funds, polled until hVM sees it. The Hemi settle hash is not in the success body (B-7); the testnet settler is not deployed (A-7). The brief's phase 2 note asked for a design pass on confirmation depth versus PoP finality; the result is in `DESIGN.md` and the README's limits: acceptance is a Bitcoin question (hBK's count, the seller's `minConfirmations`), PoP finality only gates the durability of the consumption record on Hemi.

## D-037. Eighteenth critic pass, on phase 2: a settle lock anyone could hold

A fresh-context critic ran the Definition of done from the README on the merged tree (d4a8d06) and reviewed phase 2 against the code, the spec and D-036, with the suites run again: typecheck clean, `npm test -w btc` 90, `forge test` 66, `npm test -w tests` 14 files / 147 tests in 544 s, `buyer/demo-fork.sh` all five payments, `check-btc-live.sh mainnet` exit 0 (verify `Ok`, 83050000 sats, offset 0, settle estimate 175780 gas). All eight MVP items passed; the four settlement receipts were read again from the public RPCs. The derivation agrees across `btc/`, the Rust crate and the spec: the critic recomputed digest, indices and `paymentRef` for all 16 vectors and the full BIP32 path for three of them in pure Python. The settler's stated properties held (`verify` never reverts, `settle` only by `SETTLER`, no funds, verdict order), the verdict table matched the code, and `11-btc-l1` tests what the README says.

**The major finding.** `settle_for` in the bip122 scheme took the per-output record (`pending.begin`) *before* deriving the script and asking the settler, as the EVM scheme does on purpose (0020, "records before checks"). The EVM record is keyed by the payer's own nonce, which only the payer can produce. The bip122 record is keyed by `(network, txid, vout)`, which anyone can read on Bitcoin. So any `/settle` naming a payment's output, with a random `paymentId`, held the record for the length of one `eth_call`, and a concurrent real settle got `invalid_transaction_state` ("in progress"). A stock seller forwards every payment header to `/settle`, and the buyer treats that code as final, so a watcher with the seller's public URL could leave a buyer charged and not served for as long as it kept sending. The critic showed it on the mainnet fork with `.scratch/critic2/grief.ts`: six attackers looping on the victim's `(txid, vout)`, all eight of the victim's polls answered `invalid_transaction_state`, and the same payload settled once the attackers stopped.

**The fix** (`facilitator/x402-rs/crates/x402-chain-bip122/src/v2_bip122_exact/facilitator.rs`): `settle_for` now answers a retry from an existing record first, then runs `prepare` (derivation) and `check` (the settler's `verify`), and only a request that passes takes the record; `settle_prepared` no longer verifies a second time. A forged `paymentId` derives another script, fails as `…_recipient_mismatch`, and holds nothing. Two requests that both pass still race at `begin`, and one wins, as before. The option of keying the record by `(txid, vout, paymentRef)` was not taken: it would let two settles of one output run at once and rely on the contract alone to stop the second. New unit test `a_failing_settle_takes_no_record_so_the_real_one_is_not_blocked`; the crate has 43 unit tests, run in the image's builder stage:

```
$ docker build --target builder -t hemi-x402-builder:test facilitator/
$ docker run --rm hemi-x402-builder:test cargo test --release --frozen -p x402-chain-bip122 --features x402-chain-bip122/facilitator,x402-chain-bip122/telemetry
test result: ok. 43 passed; 0 failed
$ docker compose build && (cd tests && KEEP_STACK=1 npx vitest run e2e/11-btc-l1.test.ts)
 Tests  31 passed (31)   Duration 125.63s
$ FACILITATOR=http://127.0.0.1:38080 FORK_RPC=http://127.0.0.1:38546 npx tsx .scratch/critic2/grief.ts    # the critic's script, same stack
attacker answers: { invalid_exact_bip122_payload_recipient_mismatch: 5, invalid_transaction_state: 15460 }
victim answers during the attack:  try 1: 200 SUCCESS
victim after the attack stops: invalid_transaction_state "Payment authorization was already used on chain"
```

Under the same attack the victim's first settle succeeded; the attackers got `recipient_mismatch` until it did and replay answers after. The rest of the suite does not touch the bip122 settle path and was not rerun after this change; the image it ran against in D-036 differs only in that path.

**Minor.** The README's fork snippet under "The facilitator" had no note for Colima hosts whose Lima port forward fails; one was added, pointing at the manual `ssh -O forward` (D-036). README "Records before checks" now names the bip122 exception; `facilitator/x402-rs/README.md` and `docs/phase2/facilitator.md` (B-4) say the same.

The critic could not run the Rust unit tests itself (no cargo on the machine), any live settle (forbidden), or open the explorers (the ISP filter, D-034).

## D-038. Security audit of X402BtcSettler before the mainnet deployment

> Note (2026-11-09): "audit" here means an internal review by an AI agent with fresh context, not an independent third-party audit (D-041).

Dimitry stopped the mainnet deployment simulation on 2026-11-09 and asked for a security audit of the contract first. Nothing had been sent: the settler address had no code and the deployer's nonce was unchanged. A fresh-context auditor read `X402BtcSettler.sol`, `IHbkReader.sol`, `HbkTestnetAdapter.sol`, `DeployBtcSettler.s.sol`, `deploy-btc.sh`, the tests and the Rust caller, with Hemi's hBK source beside them, wrote 19 scratch tests, and read raw answers from the live mainnet hBK for three real Bitcoin transactions. It could not broadcast or read `.env`.

**Nothing above low in the contracts.** What it checked and found sound, with its evidence:

- **External calls:** the runtime bytecode has two `STATICCALL`s and one `SSTORE`; the write precedes the event; no payable function, `receive` or `fallback` (an ETH send reverts).
- **The hand-rolled decoding** of hBK's `getSpecificTxOutput` answer: every bound traced (`base + 256 ≤ len`, `base + scriptOffset + 32 ≤ len`, `scriptPos + 32 + scriptLength ≤ len`), no underflow; 256 fuzzed raw answers and offsets into the head never revert; an empty successful answer is `HbkError`; both the live eight-word head and the source's ten-word layout decode; script equality is length plus keccak over the returned bytes plus `containsFullScript` and `fullScriptLength`, so a prefix of a cut script cannot match.
- **Live hBK behaviour, replayed from captured raw answers:** for `8bae12b5…5684`, vout 0 is `OP_RETURN "charley loves heidi"` and verifies as `OpReturn`, vout 1 a P2PKH of 200000 sats verifies `Ok` and `BelowAmount` at 200001, so OP_RETURN outputs are indexed and vout numbering matches Bitcoin's; for `54e48e5f…e713` (948 outputs), vout 0's 201-byte script comes back cut to 64 with `containsFullScript` false (`ScriptMismatch`) and vout 32 panics `0x32` live, so the 32-output cap behaves as modelled.
- **Integers:** `outValue > uint64.max` is `HbkError` (both sides of the boundary tested); `hbkConf > OFFSET ? … : 0` cannot underflow; the confirmation word is width-checked; `uint32.max` handled.
- **The record:** written only on `Ok`, which requires `settledBy == 0`, so it can be neither overwritten nor undone, even by `SETTLER`; a zero `paymentRef` is refused; keyed by `(txid, vout)`.
- **Access control:** `settle` gated on the immutable `SETTLER`; nothing else mutates state; no owner, no upgrade path.
- **hBK availability:** `0x7007…8F12` is 8415 bytes of code with no `DELEGATECALL` and zero EIP-1967 slots, so not a proxy. A pause, revert, empty answer or changed revert string degrades to `HbkError`, where `settle` reverts and nothing is consumed.
- **txid byte order:** display order end to end (Rust `settler.rs`, `types.rs`; hBK), the reversed order being `TxNotFound`.
- **The Rust decoding** reads the verdict as `uint8`, and values ≥ 9 become `Unknown` → `unexpected_*_error`, never success; selectors match; startup asserts `SETTLER()` is a configured signer.
- **CREATE2 and the deployment:** the address is `keccak(0xff ‖ deployer ‖ salt ‖ keccak(initcode))` through Arachnid's deployer, which binds nothing to the sender, so a front-runner can only put the identical code at the identical address, which the script then skips and post-checks; no metadata, pinned solc and optimizer make the initcode reproducible; the constructor rejects zero and code-less addresses; chain id, deployer codehash and `CONFIRM_MAINNET_DEPLOY=yes` are checked in the script and the shell. Hemi mainnet executes Cancun (a state-override `eth_call` with `PUSH0` and `MCOPY` succeeded), which the settler's runtime uses.

**Findings, all low or informational, and what was done:**

| # | Finding | Outcome |
|------|------|------|
| L-1 | A settle forwards all gas to hBK, whose cost grows with the Bitcoin transaction's size: 133604 gas for the 2-output fixture, 909400 for a 948-output transaction, roughly 15M extrapolated for a 400 kB one, under Hemi's 30M block limit. The buyer chooses the transaction, so it chooses the facilitator's gas within that bound, under a cent at Hemi prices | Accepted; noted in README limits |
| L-2 | The Rust scheme never reads `settledBy`: `AlreadyConsumed` is always `invalid_transaction_state`. After a facilitator restart, a buyer whose settle succeeded on chain but whose answer was lost gets a final error (charged, not served) although the contract shows `settledBy == sha256(paymentId)`. Answering success there is the replay-versus-restart trade-off B-5 chose | Left as B-5 decided; recorded as a limit, candidate for a later patch |
| L-3 | A settle that reverts in the block with `NotPayable(TooFewConfirmations)` (the builder's hBK count behind the `eth_call` node's) is `invalid_transaction_state`, final for the buyer, though nothing was consumed and a retry would pass | Recorded as a limit, candidate for a later patch mapping that revert to `…_unconfirmed` |
| I-1 | Any `Panic(0x32)` from hBK is `OutputNotFound`, including a truncated precompile answer inside hBK's own parser; never a wrong `Ok` | No change |
| I-2 | `deploy-btc.sh` splits `.env` lines on the first `=` and keeps quotes; a URL with `=` in its query would be cut, loudly | No change |
| I-3 | Test gaps, all covered by the auditor's scratch tests: short and wide confirmation answers, hBK becoming an EOA, the exact 64-byte script accepted and a 65-byte one rejected, inconsistent `containsFullScript`/`fullScriptLength`, `SETTLER` cannot overwrite a record, a revert payload with trailing bytes is `HbkError` | **Ported** into `contracts/test/X402BtcSettlerAudit.t.sol` and `X402BtcSettlerLiveReplay.t.sol` (the captured hBK answers as constants); `forge test` now 85 passed |
| I-4 | Accepted limits to keep documented: a compromised `SETTLER` key can mark outputs consumed with a bogus ref (griefing, no funds, redeploy to fix); a Bitcoin reorg after settle leaves the record; with hVM's lag the floor is about 3 confirmations today, but the lag moves; payments at vout ≥ 32 or with scripts over 64 bytes are unverifiable | In README limits |

The contract is deployed unchanged by this audit. The deployment itself waits for a new go.

## D-039. X402BtcSettler deployed on Hemi mainnet

On Dimitry's go, after the audit (D-038), on 2026-11-09 at about 20:13Z, from the deployer and facilitator signer `0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875`. The simulation ran first (estimate 0.0000051 ETH), then the broadcast, then the script's read-only post-check. Full output in `docs/spike/mainnet-btc-settler-deploy-2026-11-09.log`; forge's run files in `contracts/broadcast/DeployBtcSettler.s.sol/43111/`.

```
$ CONFIRM_MAINNET_DEPLOY=yes contracts/deploy-btc.sh mainnet --broadcast
  X402BtcSettler HBK: 0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12   SETTLER: 0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875   CONFIRMATION_OFFSET: 0
  [deploy] X402BtcSettler -> 0x9Df0B4752D00dF65Fb4f7FfdFe0545543f08ab9f
ONCHAIN EXECUTION COMPLETE & SUCCESSFUL.
  https://explorer.hemi.xyz/tx/0xeaef24d99180b27b9cc541d52f51f44a3760e60f20c00011dd360bbe2e101ae1 status=0x1 gasUsed=0xbe062
== Post-deployment check (simulation): [skip] X402BtcSettler: code already at 0x9Df0…ab9f; checks passed
$ cast receipt 0xeaef24d9…1ae1 --rpc-url https://rpc.hemi.network/rpc
status 0x1  block 5699044  from 0x1155…0875  to 0x4e59…956C (CREATE2 deployer)  gasUsed 778338  effectiveGasPrice 1000252  l1Fee 4280163982436  fee 5058698123612 wei
$ cast call 0x9Df0…ab9f HBK() / SETTLER() / CONFIRMATION_OFFSET()
0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12 / 0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875 / 0
$ cast balance / cast nonce 0x1155…0875
193589316758856 wei (fell by exactly the fee), nonce 5
```

The address is the one predicted since stream A (`shared/hemi.json`). The on-chain runtime has the same length as the compiled runtime and differs only in the 26 short runs where the three immutables sit. dRPC reset every connection from this workstation during the read-back (the hostname block of D-027 again), so the receipt was read from the public RPC only.

`contracts/check-btc-live.sh mainnet` against the deployed contract: `verify` of the fixture tx `95bca029…367e` vout 1 answers `Ok`, 83050000 sats, hbkConfirmations 24, `settledBy` 0; `settle` estimates 175780 gas from the signer; offset against Bitcoin's tip 0 (against hVM's own header 2: the header lags the node's count by two blocks, as A-2 says).

The facilitator then started live with `config.mainnet.json` and `X402_BTC_SETTLER_MAINNET=0x9Df0…ab9f`. `/supported` lists `exact` on `bip122:000000000019d6689c085ae165831e93` with `extra.settler` the deployed address, `hemiNetwork eip155:43111` and the confirmation policy {1, 1, 6}, with the Hemi signer for both networks; the log has no warning. It was stopped again. No `/settle` was called. `X402_BTC_SETTLER_MAINNET` is now in `.env` (a public address, appended without reading the file's other lines), so `docker compose up` serves the Bitcoin scheme on mainnet by default.

Explorer verification of the settler has not run (the ISP filter, D-034); the default build has no metadata, so a full match is possible when it does. No Bitcoin payment has run; that needs a buyer wallet with real BTC, a seller xpub, and a separate go.

## D-040. First live Bitcoin L1 payment: 1000 sats, verified through hBK, recorded on Hemi mainnet

On Dimitry's go ("Go, pay BTC"), on 2026-11-10 between 01:53Z and 02:25Z (the evening of 2026-11-09 local). One Bitcoin transaction and one Hemi mainnet transaction were sent; nothing else. Full output in `docs/spike/mainnet-btc-l1-payment-2026-11-10.log`.

**Setup.** Dimitry put a fresh seller account xpub (`xpub6CoqSXen…M5EjXH`) and a buyer WIF in `.env`; neither secret was read or printed. The buyer wallet `bc1qyz862zzkswtfxlh7qzxt4ectfl52rtj9tyswkh` held 3000 sats in two UTXOs. The facilitator ran image `hemi.15` with `config.mainnet.json`; the seller advertised 1000 sats on `bip122:000000000019d6689c085ae165831e93`, `minConfirmations` 1, `maxTimeoutSeconds` 7200 (`SELLER_BTC_MAX_TIMEOUT_SECONDS`; the 3600 default leaves little room over the 30 minutes hVM needs).

```
$ ALLOW_MAINNET=yes npm run pay -w buyer -- --asset btc-l1 --network btc-mainnet --poll 60
[buyer] paying 1000 sats on Bitcoin mainnet to bc1qv6v32p9kw0az6lv6mz62famwf5acajp3wyntsa (paymentId 674294bb435d4208deccabbcdfc1243a, xpub6CoqSXen…/0/389963158/2013573210/756408873)
[buyer] sending 1000 sats …: 1 input(s), fee 141 sats (141 vB), change 859 sats, txid 43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4
[buyer] attempt 1 … attempt 28: not yet: invalid_exact_bip122_payload_transaction_not_found
[buyer] response: {"echo":{"live":"btc-l1","network":"btc-mainnet"},"timestamp":"2026-11-10T02:22:39.820Z"}
[buyer] settled on bip122:000000000019d6689c085ae165831e93: bitcoin tx 43cb9bdc…cea4
[seller] settled 1000 of BTC on bip122:… from n/a: bitcoin tx 43cb9bdc…cea4; paymentId 674294bb… -> bc1qv6v3…ntsa at xpub6CoqSXen…/0/389963158/2013573210/756408873
facilitator: Bitcoin payment recorded on Hemi network=bip122:… txid=43cb9bdc…cea4 vout=0 hemi_tx=0xcaea6da8…ef3b payment_ref=0xb43e2ee7…ab71
$ cast receipt 0xcaea6da85cda3bb9d6135f57b65128a47d9c18af82a900c79cf91cea5b7fef3b      # public RPC; dRPC agrees on status and block
status 0x1  block 5700887 (02:22:35Z)  from 0x1155…0875  to 0x9Df0…ab9f  gasUsed 166753  l1Fee 161408938348  fee 328203960104 wei
Settled: txid 0x43cb9bdc…cea4  scriptPubKeyHash 0x805b1e6b…791e  paymentRef 0xb43e2ee7…ab71  vout 0  sats 1000  settler 0x1155…0875
$ cast call settler 'settledBy(bytes32,uint32)(bytes32)' 0x43cb9bdc…cea4 0
0xb43e2ee7516a1cd7827cb6c59548ca97aaf08e964ae04b353cc0a7726e17ab71      # = sha256(bytes16(paymentId))
$ cast call settler 'verify(…)' 0x43cb9bdc…cea4 0 0x001466991504b673fa2d7d9ad8b4a4f76e4d3b8ec831 1000 1
verdict 1 (AlreadyConsumed)
$ … pay … --resume 674294bb435d4208deccabbcdfc1243a      # the same payment a second time
[buyer] seller answered 402 (invalid_transaction_state): Payment authorization was already used on chain
```

**What the read-back shows.**

- Bitcoin: [`43cb9bdc…cea4`](https://mempool.space/tx/43cb9bdcba36fc4c222b311ac176189081d644c64fef328d12982d1edb92cea4) spends one 2000-sat input into 1000 sats to the derived address (vout 0) and 859 sats change, fee 141 sats at 1 sat/vB, in block 975240.
- Hemi: [`0xcaea6da8…ef3b`](https://explorer.hemi.xyz/tx/0xcaea6da85cda3bb9d6135f57b65128a47d9c18af82a900c79cf91cea5b7fef3b) is the facilitator signer calling `settle` on `X402BtcSettler`. `scriptPubKeyHash` is the keccak of the derived script, and `paymentRef` and `settledBy` both equal `sha256(bytes16(paymentId))` computed here. The signer's balance fell by exactly the fee, 0.00000033 ETH; nonce 5 to 6.
- The facilitator and the seller never held or moved BTC: the 1000 sats sit unspent on the seller's derived address.
- Replay: the second use got a 402 with `invalid_transaction_state`. The facilitator answered in 288 ms without sending a transaction; the signer's nonce and balance did not move.

**Timing.** Paid 01:54:18Z. Mined 02:00:22Z (block 975240). 28 polls a minute apart answered `…_transaction_not_found`. The settle was broadcast at 02:22:25Z, 42 seconds after block 975242 (02:21:43Z), the payment's third confirmation, and the buyer was served at 02:22:39Z. So 28 minutes from broadcast and 22 from the first confirmation, as the two-block hVM lag predicts (A-2); `minConfirmations` 1 was never the binding condition. hBK then reported 3 confirmations at Bitcoin tip 975242, which confirms `CONFIRMATION_OFFSET` 0 on the live contract. Each early attempt was a failed `eth_call` only (D-037), so the 28 polls cost no gas.

**Costs.** Buyer: 1000 sats plus a 141-sat miner fee. Facilitator: 328203960104 wei of Hemi gas, 0.00000033 ETH, well under a cent, half of it L1 data fee. Seller: nothing.

**Things that came up on the way.**

- *The seller needs an account xpub, not an address.* The first `.env` had a `bc1q…` address in `SELLER_BTC_XPUB`, and UniSat cannot export an xpub. Dimitry made a fresh wallet that can. A new read-only script, `npm run preflight-btc -w buyer`, reports this before any money moves: it checks that the xpub parses for the network, derives a sample address, shows the buyer wallet's address and balance, the fee rate, and whether the funds cover price plus fee. It prints public data only and sends nothing.
- *mempool.space was unreachable for a while.* The ISP filter of D-027 and D-034 reset TLS connections to mempool.space and blockstream.info. `BUYER_BTC_ESPLORA` now points the buyer and the preflight at any other Esplora base (`https://mempool.ninja/api` worked; `mempool.emzy.de` rate-limits after a few calls). The block lifted before the payment, which went through mempool.space.
- *Colima's port forward* for 8080 was missing again after `compose up` (D-036); it was added by hand through the mux socket and cancelled at teardown.

**Still open.** The success response carries the Bitcoin txid but not the Hemi settle hash (it is in the facilitator log and the `Settled` event). Audit items L-2 (reconcile from `settledBy` after a restart) and L-3 (treat an in-block `TooFewConfirmations` revert as retryable) are unpatched; neither came up in this run. The seller's 1000 sats are at `m/0/389963158/2013573210/756408873`, a path no standard wallet scans; there is no sweep tool yet, so the paymentId in the seller log and in this entry is what makes them spendable. Explorer verification of the settler has not run.

## D-041. Licence and preparation for publishing the repository

On 2026-11-09 the repository was checked for publication and prepared for it. It is still private; making it public is a separate step.

**Licence: Apache-2.0** (`LICENSE`, `NOTICE`, `"license"` in every `package.json`). Copyright is held by Dimitry B and Neva Technologies Inc. It is the licence of x402-rs and of the x402 SDK, which the patches, the bip122 crate (`license.workspace = true` inside the x402-rs workspace) and `sdk-patch` build on. The Solidity sources keep their `SPDX-License-Identifier: MIT` headers, with the text in `contracts/LICENSE-MIT`: a header is part of the source the deployed contracts were compiled and verified from, so changing it would break the match with the bytecode on chain. `IHbkReader.sol` is taken from hemilabs/bitcoin-tunnel-contracts (MIT), credited in `NOTICE` and `contracts/LICENSE-MIT`.

**Secrets: none in the history.** All 77 commits on every ref were dumped with `git log --all -p` and searched for keys, mnemonics, WIFs, extended private keys, tokens and keyed RPC URLs. The only env file ever committed is `.env.example`. Every hit is a published test value: anvil development keys #0 to #3, the private-key-1 WIF, a BIP32 test vector, the forge-std and BIP84 test mnemonics, forge-std's default Infura URL. As a second check, each of the 173 distinct 64-hex strings in the history was tried as a private key against each of the 165 EVM addresses and 23 p2wpkh addresses in the history:

```
checked 169 candidate keys
000000… is the key of 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf      (private key 1)
000000… is the key of bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4      (private key 1)
59c699… 5de411… 7c8521… ac0974…                                        (anvil #1, #2, #3, #0)
```

So neither the mainnet signer's key nor the buyer's is there. The seller's real xpub appears only in shortened form. Commits carry the GitHub noreply address.

**Removed from the current files:** the local checkout path in three deploy logs (now `<repo>/`), the ISP's name and the two warning-page URLs with their tokens (D-002, D-034, README, `contracts/README.md`), and a gendered pronoun in D-034. These remain in earlier commits; publishing with the existing history publishes them too. Removing them for good means publishing from a new history.

**Added:** `SECURITY.md` (status, private reporting, scope); a line near the top of the README that the project is independent of Hemi Labs, the x402 Foundation and x402-rs and has had no independent audit; a "Licence and security" section. The README no longer calls the settler "audited": D-038 was an internal review by an AI agent with fresh context, and its entry now says so.

**Left as they are:** the owner's first name in these entries and in the patches' `From:` lines (the commits carry it anyway); the signer, buyer and payment addresses (public on chain, and the evidence for D-029 to D-040); no CI; Rust dependencies not checked with `cargo audit`; `npm audit --omit=dev` reports 0 vulnerabilities.

## D-042. Open-source audit of the public repository

On 2026-11-09, after the repository had been made public (D-041 prepared that; `main` is at `8d66b7e`, PR #6), it was audited as a stranger would meet it: every document read against the code, the dependencies and licences checked, the GitHub settings read, and the README followed from a fresh clone by an agent with no other context. What could be fixed in the files was fixed; what needs the owner's decision is listed at the end.

**Documents against the code.** Each README, `SECURITY.md`, `NOTICE`, the spec draft, the phase 2 notes and the code comments were read against what the code and the chain say today. Corrected: the README's opening and path table, which predated phase 2 (the bip122 crate, the settler, the fifth demo payment); test counts and a commit date that had moved; a status line that called the settler "audited"; wording that assumed the reader knew the brief or the three work streams; and broken relative links in `docs/phase2/ts.md`. `docs/BRIEF.md` and the four phase 2 notes now open with a line saying they are kept for the record and where the current state is. A link check over the 24 Markdown files finds no broken relative link or anchor.

**Dependencies and licences.**

- npm: `npm audit` reports 0 vulnerabilities, development dependencies included. Licences of the 196 installed packages: MIT 164, Apache-2.0 10, MPL-2.0 12, ISC 5, BSD 4, Unlicense 1. The MPL-2.0 ones are `lightningcss` and its platform builds, which only vitest pulls in; nothing from them is distributed.
- Rust: there is no `cargo` on this machine, so the dependency tree was taken from the builder image (`cargo tree --features chain-bip122 -e normal,build`: 317 crates in the binary) and each crate at its locked version was looked up in the OSV database. Twelve have advisories at upstream x402-rs's locked versions, none critical: `rustls 0.23.40`, `rustls-webpki 0.103.13`, `h2 0.4.14`, `tokio 1.52.3`, `serde_with 3.20.0`, `anyhow 1.0.102`, `block-buffer 0.12.0`, `ruint 1.18.0`, `lru 0.16.4`, `crypto-bigint 0.5.5`, `paste` and `proc-macro-error2` (the last two unmaintained). They are left as they are: the image builds only from upstream's lock, so a bump means an allow-list of overrides in `build/`, image hemi.16, a rebuild and a full e2e run. No licence tally was made for the Rust crates.

**GitHub.** Read through `gh`, nothing changed: public, Apache-2.0 detected, security policy shown, private vulnerability reporting on, secret scanning and push protection on with 0 alerts, issues on. Not set: description, homepage and topics; branch protection on `main`; Dependabot alerts and security updates; any tag or release. PR #5's title still says "settler audited".

**Added.** `.github/workflows/ci.yml` (typecheck, unit tests, `forge fmt --check`, build and tests) and `e2e.yml` (builds the image, runs the Rust tests inside the builder stage without network, then the e2e suite), both with read-only permissions and Actions pinned by commit SHA; `dependabot.yml` for npm and Actions; an issue template, a pull request template and `CONTRIBUTING.md`; root npm scripts `typecheck`, `test`, `test:unit` and `test:e2e`.

**Fresh-clone walkthrough.** The agent cloned the public repository into an empty directory and followed the README with nothing else. What it hit, and what was done:

| Finding | Fix |
|------|------|
| `11-btc-l1` failed 1 to 4 tests on a cold Foundry RPC cache (146/147, 143/147), and passed 147/147 warm: the public Hemi RPCs stalled for longer than viem's 10-second default | the tests' fork clients and `sendToMock` now wait 60 seconds; the README says a first run can time out. Not proven against a cold cache. D-043 found a different cause for 180-second timeouts of this kind |
| With Colima, a clone outside `$HOME` fails late with `config.json: Is a directory` | `demo-fork.sh` and the e2e setup print the container log and say why; the README has the warning on its own line |
| The manual `fork.sh` and compose path printed nothing when Lima's port forward failed, and the workaround stood after the teardown line with no way to undo it | `curl -sS`, the note moved before the request, the cancel command named |
| `scripts/fork.sh` took a wrapper script around anvil for a foreign process and failed | it now looks at the whole command line, and stops what it started when it gives up; `tests/setup/global.ts` likewise |
| No quick start; "fill in the keys" read as required | a three-command quick start at the top; the fork paths are said to need no `.env` |
| `.env.example` lacked `FACILITATOR_CONFIG` and the `HEMI_*_RPC_URL` variables | added, with a pointer to each script's header for the rest |
| hBK, hVM, spike, phase 2, §9, D-0xx and hemi.N were never explained; no tool versions | a list of terms after the quick start; the versions last checked |
| The manual path lists two networks while the demo shows a Bitcoin payment | the README says why and how to pass the fork settlers |
| Testnet and mainnet sections read as if every step were still to do | they say which contracts exist, that a newcomer starts at mainnet step 4, and where the signer address comes from |

The agent did not check Linux, Docker Desktop, Node 22.9 itself, or the live-network sections.

**Verification after the changes.** on 2026-11-09, with everything above in the working tree: `npm run typecheck` clean; `npm test` 90 passed; `forge fmt --check` clean and `forge test` 85 passed in nine suites; `npm run test:e2e` 14 files, 147 tests passed in 616 s; `buyer/demo-fork.sh` settled all five payments in about a minute; the two `cargo test --frozen` commands of `e2e.yml`, run in the builder stage with `--network none`, passed (55, 15 and 25 tests in the patched crates, 43 in `x402-chain-bip122`, 5 in the facilitator). The README's manual path (`scripts/fork.sh up`, the settlers file, compose, `/supported`, teardown) was followed once: four networks listed, and Colima's forward had to be added and cancelled by hand as the README now says. The two workflows have not run on GitHub yet, since nothing is pushed.

**Left for the owner.** Committing and pushing these changes; the repository description, topics and homepage; Dependabot alerts and security updates; branch protection on `main`; the Rust dependency bump; a `CODE_OF_CONDUCT.md`, which needs a contact address; PR #5's title; the `Co-Authored-By` trailers in patches 0020 to 0030 and `sdk-patch/0001`, which name a model version where the others do not; a first release tag; submitting the mainnet settler's source to the explorer (`contracts/verify.sh mainnet`, from a network that reaches it); the "stream A/B/C" wording in two Rust comments, which would need an image tag bump; a history rewrite to drop what D-041 lists, which on a public repository would also break every existing link and clone.

## D-043. A failed upstream read while anvil mines a block strands the transaction; the forks drop two system contracts

**What failed.** On 2026-11-10 the first run of `e2e.yml` on GitHub (run 42841940153, PR #7 at `7f30831`) ended with `Tests 1 failed | 141 passed | 5 skipped (147)`:

```
FAIL  e2e/03-bad-signature.test.ts > bad signature, Permit2 (USDC.e on eip155:743111)
Error: Hook timed out in 180000ms.
FAIL  e2e/11-btc-l1.test.ts > exact on bip122:000000000933ea01ad0ee984209779ba (eip155:743111 fork) > an output to another paymentId's address ...
Error: Test timed out in 180000ms.
```

Both are on the testnet fork, both sit in code that sends one transaction to the fork and waits for its receipt (`ensurePermit2Approval`, `sendToMock`), and every other test ran at normal speed. The runner had no Foundry RPC cache, so every read went to the public Hemi RPC.

**Mechanism.** Measured on this machine with anvil 1.8.6 forking testnet at block 7094000 through a local proxy that logs each upstream request and can leave a chosen one unanswered, or answer it with HTTP 429.

- Under Prague, every block anvil mines begins with a call into the beacon roots contract (EIP-4788, `0x000F3df6D732807Ef1319fB7B8bB8522d0Beac02`) and the block-hash history contract (EIP-2935, `0x0000F90827F1C53a10cb7A02335B175320002935`). Both have code on Hemi (97 and 83 bytes at the pinned testnet block). The calls write slots keyed by the new block's timestamp and number, so the fork reads three new slots from the upstream for each block, and no cache can hold them. A gas estimate makes the same reads, because anvil estimates on a pending block.
- In a full suite run on a cold cache these were the largest group of upstream storage reads: 279 of 464 on the testnet fork and 232 of 451 on the mainnet fork.
- When one of these reads fails while a block is mined, anvil leaves the transaction in its pool, writes nothing to its log and does not try again until another transaction arrives. One `approve` sent with an explicit gas limit, the beacon roots read left unanswered once (`anvil --timeout 5000`):

  ```
  eth_sendTransaction answered after .02 s: 0x9ccc5a1e…
  NO RECEIPT after 20 s; txpool: {"pending":"0x1","queued":"0x0"}; block 7094000
  after an unrelated second tx: first receipt status '0x1', txpool: {"pending":"0x0","queued":"0x0"}; block 7094001
  ```

  Nine 429 answers in a row (anvil's first request and its 8 retries) give the same result; three are absorbed and the receipt comes about 3 s late.
- A read that fails during the estimate is different: anvil answers with an error, and viem retries the request. With one such stall in `03-bad-signature` the file passed, 45 s slower.
- The same fault aimed at mining, in the suite: the proxy answered the estimate's read 1.2 s late, so the block was mined in a later second and needed a new timestamp slot, and left that read unanswered. Result of `npm run test:e2e -- e2e/03-bad-signature.test.ts`:

  ```
  FAIL  e2e/03-bad-signature.test.ts > bad signature, Permit2 (USDC.e on eip155:743111)
  Error: Hook timed out in 180000ms.
  Tests  26 passed | 5 skipped (31)
  ```

  That is the first CI failure, message for message.
- The public RPC does answer 429 during the suite: the proxies saw 5 in the cold run before the change and 38 in the one after it, one of them on a beacon roots slot. All were absorbed by anvil's retries.

What is not established: the runner has no log of what the upstream answered, so that a read failed there, and whether it was a stall past anvil's 45 s or more than eight 429s, is inferred from the match above. The D-042 failures of `11-btc-l1` on a cold cache had the same shape (a 180 s timeout, then tests that found state from the stranded transaction) and were not re-examined.

**Decision.** `scripts/fork.sh` removes the code of both system contracts on each fork right after it starts (`anvil_setCode <address> 0x`, three attempts each, since anvil fetches the account from the upstream first). The two system calls then do nothing and mining a block reads nothing from the upstream. Nothing in this project reads either contract; a test that needs EIP-4788 roots or EIP-2935 block hashes on a fork would have to put them back. Anvil's `--timeout` and `--retries` are unchanged.

Not done: a patch or bug report for anvil's silent drop; saving the facilitator's log before the suite's teardown, without which the workflow's "Facilitator and fork logs" step prints nothing useful.

**Verification** on 2026-11-10, with the change in the working tree:

- three blocks in a row on a fork with the code removed: 6 upstream requests for the first (accounts every block touches), 0 for the second and third;
- the mining-time fault above, armed again: nothing matched it, `03-bad-signature` passed 31/31, and the testnet fork made 0 system-contract reads;
- `npm run test:e2e` on a cold cache through the logging proxies: 14 files, 147 tests passed in 414 s (704 s before the change, same setup); upstream requests fell from 641 to 337 on the testnet fork and from 672 to 448 on the mainnet fork;
- `buyer/demo-fork.sh` settled all five payments; `npm run typecheck` clean.

**Limits.** Other upstream reads can still fail. A wallet that estimates first reads a transaction's state during the estimate, where a failure is reported and retried. A transaction sent with an explicit gas limit, or through `eth_sendTransaction` after anvil's internal estimate failed, first reads its state while the block is mined and can still be stranded. A stalled read elsewhere costs up to 45 s.

## D-044. The repository is recreated with a clean history; the old one is a private archive

**Why.** D-041 removed the ISP's name, the two warning-page URLs with their tokens, the local checkout path and a gendered pronoun from the current files, and noted that they remained in earlier commits. D-041 also said the repository was still private. That was wrong: GitHub's event log has a `PublicEvent` for `dimitryB/x402facilitator` at its creation, 2026-10-31 00:22:55 UTC. Its traffic for the 14 days to 2026-11-09 was 6 views and 3 clones from one unique visitor, with no forks, stars or watchers.

A force-push would not have removed the old commits. GitHub keeps `refs/pull/1/head` to `refs/pull/7/head` pointing at them; the owner cannot change those refs, so the merged pull requests would still show the old diffs. On 2026-11-10 the owner chose to recreate the repository instead.

**What was done.**

1. PR #7 was merged after its three checks passed at `a6f7ea7` (merge commit `aad7d01`).
2. The repository was renamed `dimitryB/x402facilitator-archive` and made private. It keeps PRs #1 to #7, their discussions and the Actions history. PR numbers cited in this file before D-044 refer to it.
3. A fresh copy of `main` and `feat/facilitator-mvp` was rewritten with `git filter-branch --index-filter … --msg-filter …`. The filter rewrote the six files that ever held these strings: `DECISIONS.md`, `README.md`, `contracts/README.md` and the three deploy logs in `docs/spike/`. It applied the D-041 wording to every earlier version: the ISP's name became "the ISP" or "the spike machine's ISP", each warning-page URL became `https://<the ISP's warning page>?url=…&token=<redacted>`, `/Users/…/x402facilitator/` became `<repo>/` and "his browser" became "a browser". One commit message was reworded the same way.
4. A new public `dimitryB/x402facilitator` was created (2026-11-10 19:11 UTC) and the two rewritten branches were pushed to it. Its settings were compared with the old repository's: 21 repository fields matched, including the merge options, secret scanning and push protection (on), wiki (off) and the default branch. Private vulnerability reporting, which `SECURITY.md` points to, was off on the new repository and was turned on. Dependabot alerts and security updates are off, as before. Actions is enabled with a read-only default token. Neither repository has secrets, variables, rulesets, branch protection, webhooks, deploy keys, environments, custom labels, issues or releases.

**Verification** on the rewritten copy before it was pushed:

```
tip trees before/after: main SAME, feat/facilitator-mvp SAME
main: 82 commits old, 82 new; feat/facilitator-mvp: 78 old, 78 new
author and committer names, emails and dates: identical, commit by commit
lines matching the removed strings, in every blob and message: 0 (old history: 136)
commits with a new hash: 79 of 82 (the first three are unchanged)
```

`git ls-remote` on the new repository gives `main` at `3c60cc2` and `feat/facilitator-mvp` at `f8108e3`. The local checkout was moved to them; its files did not change, since the trees are identical. The new repository's first `CI` run on `main` passed.

**Old and new hashes.** Earlier entries and some files cite commits by their old hashes. They were left as written: the forge broadcast records under `contracts/broadcast/` are what forge wrote at deployment, and the comment in the bip122 crate is part of the image source. The old hashes resolve only in the archive. Their new equivalents:

| Old | New | Cited in |
|------|------|------|
| `7bd6bd5` | `8037db8` | testnet `DeployHemi` broadcast record |
| `404d96f` | `f1845ad` | D-025 |
| `1325d54` to `3eb0670` | `4f007d9` to `67a5f99` | D-033 |
| `b2a8576` | `c89c195` | mainnet `DeployHemi` broadcast record |
| `41a73b4` | `47eaea7` | `docs/phase2/ts.md` |
| `6607a91` | `5b91d7f` | `docs/phase2/{DESIGN,facilitator,ts}.md`, `derive.rs` |
| `07df2e3`, `f4c8b16`, `9321b76` | `15f078f`, `4693566`, `b389cf2` | D-036 |
| `d4a8d06` | `099ab9f` | D-037 |
| `caf8402` | `3b83b54` | mainnet `DeployBtcSettler` broadcast record |
| `8d66b7e` | `ee1a18e` | D-042 |
| `7f30831` | `2bcfd1b` | D-043 |
| `a6f7ea7`, `aad7d01` | `f8108e3`, `3c60cc2` | this entry |

**Left as it is.** The local-only branches `claude/*` and `phase2/contracts` still hold the old commits, and so does the local object store. Neither is published.

## D-045. The SDK patch goes upstream; the x402-rs patches stay a patch set

On 2026-11-10 the owner chose what to do with the two patch sets that change upstream code.

**Upstream state that day.**

- `x402-rs/x402-rs`: still at `e75adda` (2026-07-13). Its last merge was on 2026-07-08 and its last release was v1.3.0 in February. About 15 pull requests are open without review, including zachsplat's #138, #140 and #142 (D-035) and a Bitcoin Cash chain.
- `x402-foundation/x402`: active. It merged a default-asset PR for Robinhood Chain (#4207) the same day, and four more since August. Hemi is still not in its default assets.

**Decision.**

- The SDK patch was submitted, TypeScript only: [x402-foundation/x402#4213](https://github.com/x402-foundation/x402/pull/4213).
- The x402-rs patches stay a patch set in this repository, applied to the pinned commit. Nothing was submitted to x402-rs and nothing was posted on #136, #138 or #140. Submitting the series, posting on those PRs and forking x402-rs were the options not taken; they can be revisited if the maintainer becomes active again.

**How the SDK PR was made.**

1. Rebase. The patch was replayed on upstream `main` at `d3eb19d`. It conflicted only where Robinhood Chain had been added at the same place in `defaultAssets.ts` and in the docs table; both entries were kept.
2. Upstream's rules. Upstream asks for concise commit messages that explain why. The commit message and changeset were shortened to match, and the PR description was cut down from the earlier draft to the shape of #4207.
3. On-chain values, checked again with read-only calls:
   - mainnet USDC.e: name "Bridged USDC (Stargate)", version "2", 6 decimals; `DOMAIN_SEPARATOR()` equals the recomputed domain (`0x6fe49ef2…8a11`); `authorizationState` is callable;
   - testnet USDC.e: name "USDC.e", 6 decimals; `version()`, `DOMAIN_SEPARATOR()`, `nonces()` and `authorizationState()` revert;
   - the exact Permit2 proxy has code hash `0xce6429c0…048b9` on Hemi mainnet, Hemi testnet and Base mainnet alike.
4. Upstream's checks, run on the rebased tree with `pnpm` 11.1.1:

   ```
   install --frozen-lockfile, turbo build @x402/evm:  ok
   pnpm test:          Test Files 64 passed (64), Tests 2103 passed (2103), coverage thresholds met
   lint:check, format:check, prettier on the changeset:  clean
   the three Hemi tests, run by name:  3 passed
   ```

5. Signing. Upstream requires signed commits, and this machine has no gpg or SSH signing key. The fork `dimitryB/x402` was created, branch `hemi-default-stablecoins` was set to `d3eb19d`, and the commit was made with GitHub's GraphQL `createCommitOnBranch`, which GitHub signs. The result is commit `78ba854`: verified, authored by `dimitryB`, with the same tree as the tested one (`dd7199f`).
6. Draft and disclosure. Upstream's contributing guide says not to open a non-draft PR before a human has reviewed AI-generated code, and to disclose significant AI use. The PR was opened as a draft and says so.

**State after opening.** The PR is a draft, mergeable, and open to edits by maintainers. Its CI workflows show `action_required`: this is a first contribution from a fork, so a maintainer must approve the runs. `sdk-patch/` now holds the submitted commit and the posted description.

**Left for the owner.** Review the six changed files in #4213 and mark the PR ready for review. Go and Python parity is offered in the PR, not done.

## D-046. Audit fixes, first batch: one payment per paymentId across clients, required fields, keys off the command line

On 2026-11-10 an open-source readiness audit of this repository (at `9091a07`) was run outside this session. It reported seven findings: three P1, four P2. Each was checked against the code, the built image and the advisory databases before anything was changed, and all seven hold:

| | Finding | Checked |
|------|------|------|
| F01 | The runtime stage runs `apt-get` with apt 3.0.3, which Debian lists under CVE-2026-109518 (fixed in 3.0.4 by DSA-6607-1) | `apt-get --version` in `hemi-x402-facilitator:e75adda-hemi.15`; sources are `http://deb.debian.org`. The flaw needs an on-path attacker while the image is built; the running service never uses apt |
| F02 | Rust dependencies with advisories | `crypto-bigint` 0.5.5, `rustls` 0.23.40, `rustls-webpki` 0.103.13 and `h2` 0.4.14 in upstream's `Cargo.lock` at `e75adda`; RUSTSEC-2026-0387, -0285, -0382 and -0258 exist. Already left for the owner in D-042 |
| F03 | Two clients sharing one journal could both pay a paymentId | `ExactBtcClientScheme` guarded only its own in-flight map; the journal's `get` then `put` was not atomic |
| F04 | A Bitcoin network is advertised although its settler check failed | `provider.rs` logs the failed `check_deployment` and discards it (`let _ = check`). With the wrong signer `/verify` passes and `/settle` reverts, so in the upfront flow a buyer pays and is not served |
| F05 | Spec, client and facilitator disagree on fields | The spec let `extra.assetTransferMethod` be omitted; the facilitator rejects that. The client filled in `assetTransferMethod` and `paymentFlow` and never checked `minConfirmations` |
| F06 | Testnet scripts put private keys on command lines | `scripts/testnet-run.sh:42-43` and `scripts/testnet-fund-usdc.sh:35,66` passed real keys to `cast` |
| F07 | No protection on `main`, Dependabot alerts off | As recorded in D-044 |

The owner chose to fix the TypeScript, spec and script findings first (F03, F05, F06): they need no new image.

**F03: a paymentId is claimed atomically before the wallet pays.**

- `PaymentJournal` gains `claim(entry)`: it records the `paying` entry only if the journal has nothing for that paymentId, and otherwise returns what is there. Of concurrent claims, exactly one wins.
- `MemoryPaymentJournal` checks and writes with no `await` in between, so clients sharing one instance in one process cannot both win.
- `FilePaymentJournal` first creates `<journal>.claims/<paymentId>` with `O_CREAT | O_EXCL`, which the filesystem grants to one process only, and writes the entry into it. A client that stopped between its claim and its journal line therefore still blocks the next one; so does an empty claim file still being written. Every journal line and claim file is now flushed with `fsync` before the wallet is called. The paymentId names a file, so the journal itself rejects anything that is not 32 lowercase hex characters.
- Concurrent requests in one client now share a payment only if they ask for the same network and address and no more than its amount, the rule a recorded payment already followed. A request for more is refused instead of being answered with the smaller payment.
- The spec's client steps say the same; `btc/README.md`, `buyer/README.md` and the README describe the claim files.

**F05: required means required.** The spec now requires `extra.assetTransferMethod: "utxo"`, as the facilitator already did, and says a client must not fill in a missing required field, because it pays before any facilitator sees the requirements. The client rejects a missing `assetTransferMethod` or `paymentFlow`, and a `minConfirmations` that is not a whole number of at least 1. The seller and the facilitator were already strict, so neither changes.

**F06: keys stay in the environment.** cast 1.8.6 takes a raw key only as `--private-key` on its command line (`cast send --help` lists no environment variable for it). `scripts/evm-key.mjs` reads the key from the environment variable it is given by name, with viem: `address` prints the address, and `send` signs and sends a transaction whose calldata `cast calldata` built, then prints `{status, transactionHash}`. The two scripts use it. `contracts/deploy*.sh` already passed keys through the environment, and `scripts/fork.sh` uses anvil's published key.

**Verification**, 2026-11-10:

```
npm test -w btc            Tests 103 passed (103)                    (90 before; 13 new)
  two clients on one MemoryPaymentJournal, two FilePaymentJournal instances on one file:  1 wallet call each
  4 processes racing to claim the same 40 paymentIds:                                    each won exactly once
  claim written with "w" instead of "wx" (deliberately, then reverted):                  3 tests fail
npm run typecheck          clean
npm run test:e2e           Test Files 14 passed (14), Tests 147 passed (147), 375 s
buyer/demo-fork.sh         exit 0: all five payments settled; the Bitcoin one created journal.jsonl.claims/ (mode 0700)
scripts/evm-key.mjs        same address as cast wallet address for anvil key #0, with and without 0x;
                           two sends to a local anvil: status 0x1; a failing send: "evm-key: Transaction creation failed."
```

The two testnet scripts were not run against live networks: they send testnet transactions. Their syntax was checked with `bash -n`, and each piece they now call was run on its own.

**Left.** The image batch (F01, F04, the routine Rust bumps of F02, a non-root user and this repository in the image's source label; a new tag and a full e2e run), the `crypto-bigint` upgrade of F02, the GitHub settings of F07, and the audit's hardening notes on browser origins, seller recovery records and the buyer journal's location. The client still cannot check `minConfirmations` against a facilitator's policy before paying: it does not see `/supported`. The audit report is not in the repository.

## D-047. Audit fixes, second batch: image hemi.16 without apt, an unprivileged container, security upgrades, and no Bitcoin network without a usable settler

The audit findings that change the facilitator image (D-046 lists them all): F01, the upgradable part of F02, F04, and the container hardening from the audit's notes. The image tag is now `e75adda-hemi.16`.

**F01: no apt in the image build.**

- The runtime stage installed `ca-certificates` with `apt-get` over HTTP, using apt 3.0.3, which CVE-2026-109518 affects. It now runs no package manager. The CA bundle is copied from the builder image (`ca-certificates` 20250419, 150 certificates).
- The runtime base moved to the `debian:trixie-slim` index of 2026-11-04, `sha256:a72b4433…b6b2`, whose apt is 3.0.4. The service never used apt; the bump is so the image no longer carries the flagged version.
- The builder image is unchanged. It contains apt 3.0.3 as well, but the build runs no apt in it.

**The container runs unprivileged.** The image creates user `facilitator` (uid 10001) and runs as it. `docker-compose.yml` adds `read_only: true`, `cap_drop: [ALL]` and `no-new-privileges`. The service listens on 8080 and only reads its config, and the e2e suite and the fork demo pass under these settings.

The labels now name this repository as the image's source and Apache-2.0 as its licence; x402-rs and its commit are in `x402-rs.source` and `x402-rs.revision`.

**F04: a Bitcoin network is listed only with a settler that can record its payments.**

- `Settler::check_deployment` now says why a check failed:
  - `Unreachable`: the `eth_call` failed.
  - `Invalid`: nothing at the address answers `SETTLER()` like an `X402BtcSettler`, or its `SETTLER` is not one of the facilitator's Hemi signers.
- The scheme facilitator keeps the outcome. Until a check passes, the network is missing from `/supported` and from `signers`, and verify and settle are refused before anything reaches Hemi:
  - `Invalid` is final until restart, since the `SETTLER` and the signers cannot change. Verify and settle answer `invalid_network`, as for a network the facilitator does not serve.
  - `Unreachable` is checked again, at most every 30 seconds, the next time the network is asked about. Until then the answer is `unexpected_*_error`, which the caller may retry.
- A passed check is final. The startup log says which case applies, at error level for `Invalid`. The EVM chains are served either way.
- Before this, a wrong signer showed as one warning in the log. The network stayed listed and verify passed, but settle failed at gas estimation. A seller would offer BTC, and its buyer would pay on Bitcoin for a request that was never served.

The audit's reproduction, run by hand on forks with hemi.16: the settler accepts only anvil #2, and the facilitator was started with anvil #3 as its mainnet key.

```
startup log  ERROR bip122 settler unusable; this network is not listed in /supported and its verify and settle are refused
             chain=bip122:000000000019d6689c085ae165831e93 … (testnet3's settler passed: "Using bip122 provider")
/supported   kinds: eip155:43111, eip155:743111, bip122:000000000933ea01ad0ee984209779ba   (no bip122 mainnet, no signer for it)
/verify      {"invalidReason":"invalid_network","isValid":false,…}                         HTTP 200
/settle      {"errorReason":"invalid_network","success":false,"transaction":"",…}          HTTP 200
right key    kinds include bip122:000000000019d6689c085ae165831e93; settle reaches the settler (hBK does not know the made-up txid)
container    user=10001:10001 readonly=true capdrop=[ALL] secopt=[no-new-privileges:true]
```

**F02: security upgrades, pinned in a committed lock.**

- The build used to append `lock-additions.txt` to upstream's `Cargo.lock` and let `cargo fetch` prune it. It now uses `facilitator/x402-rs/build/Cargo.lock`: that same pruned lock, with these upgrades made by `cargo update -p NAME@OLD --precise NEW` in the pinned builder image:

  | Package | From | To | Advisories |
  |------|------|------|------|
  | `anyhow` | 1.0.102 | 1.0.103 | RUSTSEC-2026-0190 |
  | `h2` | 0.4.14 | 0.4.16 | RUSTSEC-2026-0258 |
  | `rustls-webpki` | 0.103.13 | 0.103.16 | RUSTSEC-2026-0382 |
  | `rustls` | 0.23.40 | 0.23.46 | RUSTSEC-2026-0285, -0346, -0348, -0349 |
  | `ruint` | 1.18.0 | 1.20.0 | RUSTSEC-2026-0220 |
  | `serde_with` | 3.20.0 | 3.21.0 | GHSA-7gcf-g7xr-8hxj |
  | `tokio` | 1.52.3 | 1.53.3 | RUSTSEC-2026-0386 |

- Cargo chose some versions itself: `aws-lc-rs` 1.19.0 and `aws-lc-sys` 0.47.0 with a new `pkg-config` 0.3.34 for `rustls-webpki`, the `ark-ff` 0.6 family for `ruint`, and `serde_with_macros` 3.21.0. Resolving these again in every build would pick whatever is newest that day, so the whole lock is committed and fetched with `--locked`.
- `check-lock-subset.sh` now takes any number of allow-lists. It refuses any package that is not in upstream's lock, `lock-additions.txt` or the new `lock-upgrades.txt` (17 entries, with the advisories in its header). Without the upgrades file, the committed lock fails the check.

Not upgraded, because no compatible release fixes them:
- `crypto-bigint` 0.5.5 (RUSTSEC-2026-0387): the fix is 0.7.6, and `elliptic-curve` 0.13 and `alloy-signer` 2.0.5 need 0.5. This is the timing advisory under the signer's key; it needs an alloy upgrade.
- `lru` 0.16.4 (RUSTSEC-2026-0253): the fix is in 0.18.2, a breaking release, and `alloy-provider` 2.0.5 needs 0.16.
- `block-buffer` 0.12.0: no fixed release is listed.
- `paste` and `proc-macro-error2`: unmaintained, and used at compile time only.

The audit's other flagged packages are not in this binary's dependency graph (`quinn-proto`, `rkyv`, `webpki-root-certs`, `derivative`, `pin-utils`).

**Verification** on 2026-11-10:

```
docker compose build          exit 0; "Cargo.lock: 498 packages as upstream locked them (of 1200); 27 others, all listed in
                              /hemi/build/lock-additions.txt /hemi/build/lock-upgrades.txt"; aws-lc-sys 0.47.0 compiled
Rust tests (CI's commands, --network none)   179 passed, 27 ignored, 0 failed (176 before plus the 3 new F04 tests);
                              no warnings from x402-chain-bip122
npm run test:e2e              Test Files 14 passed (14), Tests 147 passed (147), 377 s
buyer/demo-fork.sh            exit 0: all five payments settled
image                         uid=10001(facilitator); apt 3.0.4; /var/lib/apt/lists empty; CA bundle present
```

**Left.**
- The `crypto-bigint` and `lru` advisories, which need an alloy upgrade.
- An OS package scan of the new image: none was run here.
- Licence files inside the image, if it is ever published.
- The browser-origin (CORS) setting that x402-rs ships.
- The GitHub settings of F07.

## D-048. `main` is protected by a ruleset, the e2e check always reports, and Dependabot alerts are on

The audit's F07 (D-046): `main` had no protection and no rulesets, and Dependabot alerts and security updates were off, so a change could reach `main` without passing CI. On 2026-11-10 the owner chose these settings.

**The e2e check reports on every pull request.** The e2e workflow had a path filter, so a docs-only pull request got no "Image build, Rust tests, e2e on forks" check at all. A required check that never reports blocks a pull request forever.
- The workflow now runs on every pull request. A first job lists the changed files, including the old names of renamed ones, and matches them against the paths the filter had.
- The e2e job runs only if one matches. GitHub counts a job skipped by its condition as passed.
- If that first job fails, the e2e job runs anyway, so an error there cannot let a pull request skip the suite.
- This is PR #7 (`4c5f4c5`), whose own run took the run path.

**Ruleset 27003451, "main"**, on the default branch, enforcement active:

| Rule | Setting | Why |
|------|------|------|
| Pull request required | 0 approvals | The owner cannot approve their own pull requests, so one approval would block every merge. The rule still means every change to `main` goes through a pull request and its checks |
| Required checks | `TypeScript (typecheck, unit tests)`, `Contracts (fmt, build, tests)`, `Image build, Rust tests, e2e on forks`, each from the GitHub Actions app (id 15368) | Pinning the app means no other integration can report them as passed |
| Up to date with `main` | Not required | With pull requests that follow one another, as #4 and #5 did, it would force a branch update and another 11-minute e2e run each time |
| Force pushes, deletion | Blocked | A history rewrite such as D-044's now needs the ruleset changed first |
| Bypass | Repository admins, pull requests only | An emergency merge of a pull request whose checks are broken; never a direct push |

GitHub added `require_extra_approval_for_unattributed_changes: true` to the pull request rule. It applies only to pull requests Copilot opens without a human collaborator, and only when approvals are required, so it has no effect here. GitHub's view of `main` afterwards (`GET /repos/…/rules/branches/main`) lists `deletion`, `non_fast_forward`, `pull_request` and `required_status_checks` with the three checks.

**Dependabot alerts and security updates are on.**
- The dependency graph reads the committed `facilitator/x402-rs/build/Cargo.lock` (D-047): 758 packages, 523 of them Rust crates.
- No alert was open when this was written. Whether the remaining Rust advisories (`crypto-bigint`, `lru`) appear depends on GitHub's advisory database.
- Security updates can open pull requests for npm only: no `Cargo.toml` sits next to the Rust lock.
- Dependabot's open pull request #1 (13 npm updates) fails the TypeScript and e2e checks, so it cannot merge until it is fixed.

Secret scanning, push protection and private vulnerability reporting were already on (D-044).

## D-049. alloy 2.5 for the `lru` advisory, built with Rust 1.94.1; `crypto-bigint` accepted until alloy moves to k256 0.14

The two Rust advisories D-047 left, both reached only through alloy.

**`lru` (RUSTSEC-2026-0253) is fixed by alloy 2.5.0.**
- `lru` 0.18.2 fixes it. `alloy-provider` asks for `lru` ^0.16 up to 2.3.0 and ^0.18.2 from 2.4.0 (2026-08-12) on. x402-rs asks for alloy "2.0", which allows any 2.x, so no change to x402-rs or the patches is needed.
- In the committed lock the 17 crates of the alloy 2.x family move from 2.0.5 to 2.5.0 (2026-09-23), the latest, and `lru` from 0.16.4 to 0.18.5. With them come `alloy-eip7928` 0.3.7 → 0.4.12, `alloy-trie` 0.9.5 → 0.9.9 and a new `alloy-eip8141` 0.1.1. alloy-core (`alloy-primitives`, `alloy-sol-types` and so on, 1.6.0) does not move.
- Every alloy release from 2.2.0 on requires Rust 1.94.1, and the builder had 1.93. The builder image is now `rust:1.94.1-trixie`, pinned by its multi-arch index `sha256:652612f0…165c` (rustc 1.94.1 of 2026-03-25, image built 2026-04-07). It runs no apt, as before.
- x402-rs's workspace still declares `rust-version = "1.93.0"`, and cargo's resolver chooses only releases that version supports: without help it stopped at alloy 2.1.1, still on `lru` 0.16. The update therefore ran with `CARGO_RESOLVER_INCOMPATIBLE_RUST_VERSIONS=allow`. The build itself needs nothing special: the toolchain is 1.94.1, and the lock is fetched with `--locked`.
- `lock-upgrades.txt` now lists 38 entries. The lock check reads `478 packages as upstream locked them (of 1200); 48 others, all listed`.

The bug was not reachable here: it needs a cache key whose `Drop` panics during `pop()`, and alloy's cache keys are hashes and numbers. The upgrade removes the advisory and brings five minor alloy releases of fixes. It also brings their risk to the settlement patches 0019 to 0028, which lean on the provider's behaviour (fallback, receipts, nonces). The e2e suite covers that: RPC failover, settlement pending, retries and replays.

**`crypto-bigint` (RUSTSEC-2026-0387) is accepted.**
- **No compatible fix.** The fix is in 0.7.6. Even `alloy-signer` 2.5.0 requires `k256` ^0.13, which needs `elliptic-curve` 0.13 and so `crypto-bigint` 0.5. `k256` 0.14, on the fixed line, has been stable since 2026-07-08, but alloy has not adopted it; that is a breaking change for alloy, likely its 3.0.
- **The alternatives are worse.** One is a backport of constant-time arithmetic fixes, maintained here. The other is moving signing out of the process, to a remote signer or KMS, which is an architecture change for a demo-scale facilitator.
- **Exposure.** The advisory says exploitability depends on compiler, CPU and the algorithm. An attacker would have to time many of the signer's signatures precisely over the network. The signer only signs settlements, and each one needs a real, paid payment.
- **Impact if the key leaked.** The signer only pays gas: it never holds payment funds. An attacker could spend its gas and, as the Bitcoin settler's `SETTLER`, record bogus settlements that block real ones. It could not redirect any payment.
- **Revisit** when an alloy release depends on `k256` 0.14. If Dependabot raises the advisory, dismiss it as tolerable risk, pointing here.

**Verification**, 2026-11-10, image `e75adda-hemi.17`:

```
docker compose build          exit 0; "Cargo.lock: 478 packages as upstream locked them (of 1200); 48 others, all listed";
                              lru 0.18.5 and alloy-provider 2.5.0 compiled; no compiler warnings
Rust tests (CI's commands, --network none)   179 passed, 0 failed, 27 ignored (as on hemi.16)
npm run test:e2e              Test Files 14 passed (14), Tests 147 passed (147), 375 s
buyer/demo-fork.sh            exit 0: all five payments settled
```

## D-050. Audit follow-up: Bitcoin settlements from the `SETTLER`, one journal claim per file, nulls refused, `block-buffer` 0.12.1

The audit's follow-up review of 2026-11-11 (`docs/OPEN_SOURCE_AUDIT_2026-11-10.md`, at `5e7e49a`) found five P2 gaps in the earlier fixes. Each was checked against the code before it was fixed; all five held.

**R01: a Bitcoin settlement could go from a signer the settler refuses.**
- `check_deployment` accepted the settler when its `SETTLER` was any of the Hemi chain's signers, but `settle()` built its `MetaTransaction` without a sender, so the shared Hemi provider took the next signer in its rotation. With two signers, every other Bitcoin settlement reverted `NotSettler` after the buyer had paid on Bitcoin (the audit saw 500, 200, 500, 200).
- Now `Deployment::Ready` keeps the `SETTLER` the check read, `Settler::settle` takes it as `from`, and the Hemi settler sends with `MetaTransaction::with_from`. `send_transaction` uses a given sender as is and does not advance the rotation, so EVM settlements keep rotating among all signers. `/supported` lists only the `SETTLER` under the Bitcoin network; the Hemi chain still lists every signer.
- The other fix the audit offered, refusing several signers for this scheme, was not taken: a facilitator may well want several signers for its EVM settlements.
- Tests: a unit test (four settlements, the mock's `SETTLER` the second of two signers, every sender recorded), and `tests/e2e/12-btc-settler-signer.test.ts`, which recreates the facilitator with anvil #4 as a second mainnet signer ahead of the usual one and alternates EVM and Bitcoin settlements. Each round is one EVM settlement and then two Bitcoin ones back to back. Built without the sender (the hemi.17 behaviour), the file failed as the audit did: round 0's second Bitcoin settlement answered HTTP 500 `unexpected_settle_error`, its `settle()` reverting `NotSettler(0x15d3…6a65)`, anvil #4. A first version alternated one EVM and one Bitcoin settlement; on the old build that put every Bitcoin settlement on the `SETTLER`, and only the EVM senders showed the bug, hence the two in a row.

**R02: a symlink to the journal had its own claims directory.**
- Claims lived at `<path as given>.claims`, so a client that opened the journal through a symlink claimed beside the symlink, and both clients paid. The claims directory is now beside the journal's real path, with every symlink resolved, also before the journal exists (a dangling symlink is followed to its target, a missing directory resolved through its nearest existing parent).
- Hard links cannot be resolved that way: two links are two equally real paths. `claim` refuses a journal file with more than one link, before paying, with a message that says to keep one path.
- Tests: a symlink to the file, a symlinked directory above a journal that does not exist yet, a dangling symlink, and a hard link (refused through either link, no wallet call). The first, third and fourth failed on the old journal; the symlinked directory already worked, since the operating system resolves it.

**R03: a first claim's directory entries were not flushed.**
- `writeDurably` fsynced each file but no directory, so after a power loss the new journal, the new claims directory or the claim file could be missing although their contents had been flushed, and a restart would pay again. Before `claim` returns now: the journal file is created and flushed with its directory if it was missing; every directory `claim` creates has its parent flushed; and the claims directory and the journal's directory are flushed after each claim, whether or not they are new, so a claim made after another process created the directory and stopped is still durable. Directories that existed before are taken to be durable.
- Limits, in the class's comment and the spec: a local filesystem (network filesystems may not honour `O_EXCL` or a directory fsync, and a failed one stops the payment); macOS's `fsync` does not flush the drive's write cache (Node has no `F_FULLFSYNC`); Windows cannot open a directory, so there only files are flushed.
- Tests: `btc/test/journal-durability.test.ts` wraps `node:fs` to record each fsync by path. A first claim into two new directories has flushed the journal, the claim file, the claims directory and every directory up to the existing parent by the time the wallet is called; a later claim still flushes the claims directory and the journal's; a failed fsync of the claims directory, of the journal's new directory, or of the directory above a new one stops the payment with no wallet call. All five failed on the old journal. No power-loss experiment was run.

**R04: `addressType: null` was paid as p2wpkh.**
- The client defaulted with `??`, so `null` became `p2wpkh` and the wallet paid; the facilitator, which defaults only an absent field, then refused the requirements. The client now defaults only `undefined`.
- Shared cases: `btc/requirements-cases.json` (23 cases over `addressType`, `minConfirmations`, `assetTransferMethod`, `paymentFlow` and `paymentId`: absent, `null`, out of range, wrong type) is run by the client's tests (`requirements-cases.test.ts`: it pays the derived address, or refuses naming the field and never calls the wallet) and by the crate (`the_shared_requirement_cases`, through `include_str!` of its byte-identical copy `crates/x402-chain-bip122/requirements-cases.json`; a btc test checks the two copies, and `test-vectors.json`, are identical).
- Two more disagreements the cases exposed are fixed on the Rust side: `minConfirmations: 0` passed the parser and was refused only by the confirmation policy (now refused while parsing, as the client does), and `1.0` was refused although JavaScript cannot tell it from `1` (now read as 1, as the client does).
- In passing: the spec said a bad `paymentId` or `addressType` is `invalid_payload`; the facilitator answers `invalid_payment_requirements`, which is what they are, so the spec now says that. The spec also says that an optional field defaults only when absent, and adds the alias and durability rules to the client's journal step.

**R05: `block-buffer` 0.12.1 was available.**
- D-047 listed `block-buffer` 0.12.0 (GHSA-qwgh-2vcv-g2f7) as having no fixed release; 0.12.1, released 2026-06-11, is the patched version, and `digest` 0.11 accepts it. `cargo update -p block-buffer@0.12.0 --precise 0.12.1` in the pinned builder changed only that package (checksum `d2f6c7db…60aa`, as crates.io lists it). It reaches the binary through `digest` 0.11.3 → `sha3` → `alloy-primitives`. `lock-upgrades.txt` lists it (39 entries) and no longer calls it unfixed.
- The audit also suggests a Rust advisory scan in CI with reviewed exceptions, so an accepted risk cannot hide a fixable one. Not done here: it is a new CI job and, to bind, a new required check, which is a settings decision.

**Image `e75adda-hemi.18`.** Compose, the READMEs and the issue template name it. The crate is now rustfmt-clean (edition 2024): on `main` it had eight differences, from D-047, and CI does not check Rust formatting.

**Verification**, 2026-11-11:

```
docker compose build          exit 0; "Cargo.lock: 477 packages as upstream locked them (of 1200); 49 others, all listed";
                              block-buffer 0.12.1 compiled; no compiler warnings
Rust tests (CI's commands, --network none)   181 passed, 0 failed, 27 ignored (179 before, plus the R01 and R04 tests)
npm test -w btc               136 passed, 0 failed (103 before, plus 24 shared cases, 4 alias and 5 durability tests)
npm run typecheck --workspaces   exit 0
npm run test:e2e              Test Files 15 passed (15), Tests 149 passed (149), 411 s; 12-btc-settler-signer's six
                              Bitcoin settlements all HTTP 200, each Settled event from the SETTLER
12-btc-settler-signer, built without the sender   1 failed: HTTP 500, NotSettler(anvil #4)
buyer/demo-fork.sh            exit 0: all five payments settled, the fifth 1000 sats of fabricated BTC through the file journal
```

## Pre-spike context: what the reference code requires

Read at x402-rs `e75adda` (2026-07-13) and x402-foundation/x402 `e4a0868` (2026-10-28).

### P-1. Permit2 and the exact proxy are compile-time constants, not config

- x402-rs `crates/chains/x402-chain-eip155/src/chain/permit2.rs` hardcodes `PERMIT2_ADDRESS = 0x000000000022D473030F116dDEE9F6B43aC78BA3` and `EXACT_PERMIT2_PROXY_ADDRESS = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001`.
- The facilitator rejects any Permit2 payload whose spender is not that proxy (`v2_eip155_exact/facilitator/permit2.rs:122`).
- The per-chain config (`Eip155ChainConfigInner`) has only `eip1559`, `flashblocks`, `signers`, `rpc` and `receipt_timeout_secs`; there is no field for either address.
- The TS SDK hardcodes the same two addresses (`typescript/packages/mechanisms/evm/src/constants.ts`), so every stock buyer signs for them.
- The proxy reaches its address via CREATE2 through `0x4e59…`, using a fixed salt and a committed initCode (`contracts/evm/script/data/exact-proxy-initcode.hex`) that embeds canonical Permit2 as its constructor argument.

Consequences:

- The Permit2 route works with stock x402-rs and stock buyers only if, on each Hemi chain, the deployer exists, Permit2 is canonical, and the proxy sits at `0x402085…0001`.
- A non-canonical Permit2 means forking x402-rs and patching the client SDK; it is not a config change.
- `contracts/` deploys the proxy from the reference repo's committed initCode via its `Deploy.s.sol`. Recompiling changes the CBOR metadata and moves the address.

### P-2. The RPC list is a fan-out, not primary/fallback

`chain/provider.rs` wraps every configured RPC in alloy's `FallbackLayer`, with the active transport count equal to the number of RPCs. Per alloy's design, requests go to all of them in parallel and the first success wins (to confirm against the alloy version in `Cargo.lock`). A dead primary is tolerated, but every call also counts against the public RPC's ~300 req/min.

### P-3. `DOMAIN_SEPARATOR()` alone does not prove EIP-2612

EIP-3009-only tokens expose it too. The EIP-2612 check must also call `nonces(address)` and probe the `permit` selector.
