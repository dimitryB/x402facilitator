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

Every deployment lands at the canonical address, so stock x402-rs, stock TS buyers and the stock proxy all work with no fork. Mainnet deployments wait for an explicit go. The estimated cost is in D-005.

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

No config setting changes any of this, so the facilitator is now built from `facilitator/Dockerfile`: x402-rs `e75adda`, plus the patches in `facilitator/x402-rs/patches/`, plus a build-only workspace trim. The image is tagged `hemi-x402-facilitator:e75adda-hemi.13` (hemi.7 until patch 0019, D-018; hemi.8 until patches 0020 and 0021, D-019; hemi.9 until patch 0022, D-020; hemi.10 until patches 0023 to 0026, D-021; hemi.11 until patch 0027, D-022; hemi.12 until 0027 was corrected, D-023). Each patch is small, unit-tested and written to go upstream. None changes where funds go; 0010 narrows what is accepted to the exact amount. `facilitator/x402-rs/README.md` has the per-patch detail, the resulting check order and draft upstream texts. Nothing has been published.

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

- Q-1. Cross-check the mainnet token addresses on `explorer.hemi.xyz` from a network that isn't blocked (D-002). They currently rest on Hemi's token list and on-chain `name`/`symbol`/`decimals` reads. On 2026-10-29 a retry from this workstation still hit the TLS block, and no alternative mainnet explorer host resolved (`hemi.blockscout.com` and `hemi.explorer.caldera.xyz` return 404; `explorer.hemi.network` does not resolve). Needs someone on another network: `curl -sS 'https://explorer.hemi.xyz/api/v2/tokens?q=USDC.e'` and `?q=hemiBTC`.
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

**Cost.** With a stalled RPC and no receipt yet, a retry answers after its 8 s lookup limit, where the shared read answered at once, and the last look of a first settle can run 8 s past the wait. That makes the worst send and wait 73 s, which still leaves 17 s of the TS SDK's 90 s for the checks before the send. An RPC error during a retry now reads the same as `null`, so `details` no longer carry it. These cases all still answer `settlement_pending`, which is right for them.

**The other first-answer reads were audited and left.** A receipt is the only chain read that happens after a payment has moved. The rest happen before a send, or after one that failed, so a stale answer costs a rejection, a revert or a stuck send, and none can hide a payment that landed:

| Read | Stale answer costs |
|------|------|
| Balance, allowance and simulation | A false rejection, or a transaction that reverts and costs gas |
| Fee and gas estimates | A settlement that reverts, or waits in the mempool as `settlement_pending` |
| `authorizationState` and the Permit2 bitmap after a failure | The message only: both answers are `invalid_transaction_state` |
| Nonce in `PendingNonceManager`, at first use and after a failed send | A low nonce is rejected, or queues behind a transaction the node has not seen |

The nonce is the one to watch. A frozen RPC that keeps winning that read would make settlements fail, or sit pending, until it recovers. That costs availability and hides no payment, so it stays out of this patch, and it is listed in README "Limits and open items".

Verified on 2026-11-02 against a no-cache hemi.14 build (124 s, all 28 patches): `cargo fmt`, `clippy -D warnings` and the unit tests pass, and mutating `find_receipt` back to the first answer fails two unit tests. All four cases in `tests/e2e/10-stale-rpc.test.ts` failed on hemi.13 and pass on hemi.14. The e2e suite passed, 13 files and 116 tests in 361 s. `forge test` passed 17, and `buyer/demo-fork.sh` settled all four payments.

hemi.14 has not run live. It changes how every settlement waits, so `scripts/testnet-run.sh --go` is due on this image. The 41 live receipts above are the only evidence so far that real RPCs answer these lookups.

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
