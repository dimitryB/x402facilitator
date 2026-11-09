# Phase 2, stream A: the Hemi contract

Stream A of `docs/phase2/DESIGN.md`, written on 2026-11-09. It adds `X402BtcSettler`, the contract that verifies a Bitcoin L1 payment through Hemi's Bitcoin Kit (hBK) and records the consumed output on Hemi. Everything here was run read-only against the live chains. No transaction was sent to any live network.

**The ABI is exactly DESIGN.md's.** Nothing in it changed. The contract adds custom errors only:

```
error NotPayable(Verdict verdict);   // selector 0x1c5a03f1; settle on any verdict other than Ok
error ZeroPaymentRef();               // settle with paymentRef == 0
error NotSettler(address caller);     // settle from anyone but SETTLER
error ZeroAddress();  error NoCode(address account);   // constructor only
```

**One design number changed.** `CONFIRMATION_OFFSET` is 0, not 1. hBK's confirmation count equals Bitcoin's (A-2).

## Addresses

Nothing is deployed. These are the CREATE2 addresses `contracts/deploy-btc.sh` will deploy to. They are also in `shared/hemi.json` per network.

| Network | Contract | Address | Constructor arguments |
|------|------|------|------|
| Hemi mainnet 43111 | X402BtcSettler | `0x9Df0B4752D00dF65Fb4f7FfdFe0545543f08ab9f` (predicted) | hBK `0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12`, SETTLER `0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875`, offset 0 |
| Hemi testnet 743111 | HbkTestnetAdapter | `0x1D561c41067aB82Ab90be4dd385E4a704CC3D8F5` (predicted) | testnet hBK `0xeC9fa5daC1118963933e1A675a4EEA0009b7f215` |
| Hemi testnet 743111 | X402BtcSettler | `0x56AdDfcC77b087D9101ddEE8D3A38e95E0A365B0` (predicted) | the adapter, SETTLER `0xD2B2fc8093f8A734c42B90762FD2B2F8464631af`, offset 0 |

All three addresses had no code on 2026-11-09 (`cast code` returned `0x`).

## Files

```
contracts/src/btc/IHbkReader.sol          the two hBK functions the settler reads, with hBK's Output struct
contracts/src/btc/X402BtcSettler.sol      the settler
contracts/src/btc/HbkTestnetAdapter.sol   IHbkReader over testnet's btc* hBK
contracts/test/mocks/MockBitcoinKit.sol   mock hBK with both ABIs, for unit tests, forks and e2e
contracts/test/X402BtcSettler.t.sol       unit tests, plus offline checks of the deployment constants
contracts/test/X402BtcSettler.fork.t.sol  both pinned forks: deploy, CREATE2 address, settle round trip, rerun
contracts/script/DeployBtcSettler.s.sol   idempotent CREATE2 deployment with pre- and post-checks
contracts/deploy-btc.sh                   plan, cost, simulation, gate, broadcast (deploy.sh's flow)
contracts/check-btc-live.sh               read-only check against the real hBK; measures the offset
contracts/verify.sh                       now also verifies the settler and the adapter once deployed
shared/hemi.json, shared/index.ts         per-network contracts.{hbk,x402BtcSettler,hbkTestnetAdapter}, btcConfirmationOffset
```

## Decisions

### A-1. Read hBK with low-level calls and decode its answer by hand

`verify` must never revert. A Solidity `try` does not catch a failure to decode the return data, so a high-level call to hBK could still revert on an unexpected answer. The settler therefore calls hBK with `staticcall` and reads the answer itself, with bounds checks. Any answer it cannot read becomes `HbkError`.

That turned out to matter. The deployed mainnet hBK does not return the `Output` struct of `BitcoinKitStructs.sol`. The raw `eth_call` answer of `getSpecificTxOutput(fixture, 1)` has eight head words, not ten:

```
$ cast rpc eth_call '{"to":"0x7007…8F12","data":"<getSpecificTxOutput(0x95bca029…367e, 1)>"}' latest | fold -w 64
 1  …0020                      offset of the tuple
 2  …04f33e10                  outValue = 83050000
 3  …0100                      script offset = 8 words: the head ends after containsFullScript
 4  …0160                      outputAddress offset
 5  …0000                      isOpReturn
 6  …0180                      opReturnData offset
 7  …0001                      isSpent
 8  …0022                      fullScriptLength = 34
 9  …0001                      containsFullScript
10  …0022                      script length
11  0020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e0
12  12c4000000…
13  …0000                      outputAddress length
14  …0000                      opReturnData length
```

The deployed struct has no `SpentDetail spentDetail`. Decoding with the source struct still succeeds, but `spentDetail` then reads the script's length (`0x22`) and bytes. `IHbkReader.Output` is therefore the source struct without `spentDetail`. The settler reads only the first eight head words and follows the script offset, so it handles both layouts. `test_liveMainnetAnswerDecodes` replays the bytes above, and `test_sourceLayoutWithSpentDetailDecodes` feeds the ten-word layout.

From hBK's source (`parseTransactionOutputs`), hBK never sets `outputAddress`, `isOpReturn` or `opReturnData`. It parses at most the first 32 outputs and at most 64 script bytes. The settler matches on script bytes: `containsFullScript`, `fullScriptLength == scriptPubKey.length`, the returned length, and keccak256 of both. It detects OP_RETURN from the first script byte, `0x6a`.

### A-2. CONFIRMATION_OFFSET is 0: hBK counts Bitcoin confirmations

DESIGN.md measured hBK's count as Bitcoin's plus 1 and asked this stream to re-measure. The task's formula compares hBK's count with hVM's own last header: `hbk - (getLastHeader().height - fixtureHeight + 1)`. That gives 2 on mainnet. Comparing with the Bitcoin tip from public explorers gives 0. The difference is that hVM's last header lags the Bitcoin tip that hBK counts against.

Coinbase transactions of the newest blocks, with the tip from BlockCypher read before and after (975198 both times) and hVM's last header at 975196:

```
height 975198 coinbase a751ecc2…1362: bitcoinConf 1 hvmView -1 hbk=reverted ("Static call to btcTxConfirmations precompile (0x43) contract failed")
height 975197 coinbase 9f41b3ef…6c5b: bitcoinConf 2 hvmView  0 hbk=reverted (same)
height 975196 coinbase e3077fae…1c96: bitcoinConf 3 hvmView  1 hbk=3
height 975195 coinbase eccb604b…e153: bitcoinConf 4 hvmView  2 hbk=4
height 975194 coinbase d3852f9e…9021: bitcoinConf 5 hvmView  3 hbk=5
```

The fixture gave the same picture: hBK 10, BlockCypher 10 (block 975189, tip 975198), hVM's header view 8. A live run of `check-btc-live.sh` at 18:04Z gave hBK 16, btcscan.org 16 (tip 975204) and hVM's header view 14 (A-6).

So:

- hBK's count equals Bitcoin's confirmations, counted against the Bitcoin tip hBK's node knows.
- A transaction is retrievable only once its block is at or below hVM's last header. Above it, `getTxConfirmations` reverts and `getSpecificTxOutput` reverts "Bitcoin transaction not found".
- hVM's header lagged the Bitcoin tip by 2 blocks on mainnet. That lag, not an hBK +1, is what the task's formula measures. It moves: DESIGN.md's earlier reading suggests 1. A constant offset against hVM's header would be wrong whenever the lag changes.

`CONFIRMATION_OFFSET` is therefore 0 on mainnet, and `confirmations` in `Check` is Bitcoin's count. On testnet the same hVM code runs, but no testnet3 explorer was reachable to measure against (A-7), so 0 is assumed there. `check-btc-live.sh` prints both measurements every time it runs.

A single reading disagreed. One run of `check-btc-live.sh` on 2026-11-09 near 17:36Z printed hBK 13 against a BlockCypher tip of 975200, an offset of 1. To settle it, a sampler read three public tips before and after each hBK read, every 50 seconds for 22 minutes, and kept only samples where all answers agreed. Times are UTC−5, so 12:42:49 is 17:42:49Z. BlockCypher answered `null` after six minutes, which looks like its rate limit.

```
time      tips before (btcscan/blockcypher/mempool.bitcoin-21)  hBK  hVM header  tips after          offset
12:42:49  975202/975202/975202                                  14   975200      975202/975202/975202  0
…         (9 more samples with tip 975202, hBK 14, header 975200; BlockCypher null from 12:48:36)
12:51:05  975203/null/975203                                    15   975201      975203/null/975203    0
…         (2 more samples, same values)
12:53:33  975204/null/975204                                    16   975202      975204/null/975204    0
…         (12 more samples, same values)
13:04:18  975204/null/975204                                    16   975202      975204/null/975204    0
```

All 27 samples gave 0, across two new Bitcoin blocks. hBK picked up each block no later than btcscan.org and the mempool instance, and hVM's header moved with it, always 2 behind. The reading of 1 was BlockCypher answering an older tip. `check-btc-live.sh` therefore reads the tip from btcscan.org first and falls back to BlockCypher.

One consequence for integration: a payment cannot verify before its block reaches hVM's header. On mainnet that was 3 Bitcoin confirmations, about 30 minutes, whatever `minConfirmations` says. `minConfirmations` 1 and 3 behave the same until the lag shrinks.

### A-3. Classifying hBK's reverts

What the live mainnet hBK returned on 2026-11-09, for a random txid, the fixture txid in reversed byte order, a transaction newer than hVM's header, and bad output indexes:

```
getTxConfirmations(unknown)     Error("Static call to btcTxConfirmations precompile (0x43) contract failed")
getSpecificTxOutput(unknown, 0) Error("Bitcoin transaction not found")
getSpecificTxOutput(fixture, 2|31|32|99)   Panic(0x32)      the fixture has 2 outputs
getTxOutputCount(fixture)       2
```

The source has a "Bitcoin transaction not found" branch in `getTxConfirmations`, but the node fails the precompile call first, so that string never comes back from it. The settler reads the output first, so an unknown transaction maps to `TxNotFound` and a bad index to `OutputNotFound`. Any other revert, a malformed answer or a confirmation read that fails after the output was found maps to `HbkError`. `MockBitcoinKit` returns exactly these reverts.

### A-4. Verdict order and edge cases

`verify` returns the first failing check:

1. `AlreadyConsumed`, without calling hBK. `settledBy` is filled.
2. `TxNotFound`, `OutputNotFound` or `HbkError` from reading the output.
3. `HbkError` if the output's value exceeds `uint64`, or if the confirmation read fails. `sats` and `isSpent` stay filled.
4. `OpReturn` if the output script starts with `0x6a`. It goes before `ScriptMismatch` because such an output can never be a payment.
5. `ScriptMismatch` if the scripts differ, the script is cut (`containsFullScript` false), or the `scriptPubKey` argument is empty.
6. `BelowAmount` if `sats < minSats`. Overpayment is `Ok`.
7. `TooFewConfirmations` if `hbkConfirmations - CONFIRMATION_OFFSET`, floored at 0, is below `minConfirmations`.

`isSpent` is reported and never rejected. The fixture output itself is spent. `minSats` 0 and `minConfirmations` 0 are accepted; the facilitator's own checks (amount > 0, a confirmation floor) come first.

`settle` checks the caller, then `paymentRef != 0`, then runs the same checks and reverts `NotPayable(verdict)` on anything but `Ok`. It writes `settledBy[txid][vout] = paymentRef` and emits `Settled(txid, vout, keccak256(scriptPubKey), sats, paymentRef, msg.sender)`. hBK is only called with `staticcall`, so nothing can re-enter.

### A-5. Deployment: compiled code, CREATE2, fixed addresses

These contracts are new, so unlike `DeployHemi.s.sol` there is no earlier deployment to replay. `DeployBtcSettler.s.sol` builds the initcode from `type(X402BtcSettler).creationCode` and the constructor arguments. It deploys through the deterministic deployer `0x4e59…956C` with the salts `"x402 btc settler v1"` and `"x402 hbk testnet adapter v1"`.

The default profile compiles without metadata, so the bytecode, and with it the address, does not depend on the build machine. The script refuses to run when a computed address differs from the constant in `BtcSettlerCanonical`. `DeployBtcSettlerOfflineTest` checks the constants against the compiled code and against `shared/hemi.json`. A change to `src/btc`, to the compiler settings or to a constructor argument therefore fails the tests until the three places are updated together. Rotating the facilitator's signer means a new settler at a new address.

The script follows `DeployHemi.s.sol`: chain check, deployer code hash, hBK present, skip if code exists, `CONFIRM_MAINNET_DEPLOY=yes` checked inside the script for any broadcast to 43111. Post-checks read `HBK()`, `SETTLER()`, `CONFIRMATION_OFFSET()` and, on testnet, the adapter's `HBK()`.

`deploy-btc.sh` is `deploy.sh`'s flow: chain id check, key handling (`DEPLOYER_PRIVATE_KEY`, testnet-only fallback `FACILITATOR_TESTNET_PRIVATE_KEY`, read from `.env` by the script itself), plan with cost, simulation, mainnet gate, `--broadcast --slow`, explorer links, read-only rerun. The plan comes from the script's `plan()`, so the addresses and calldata have one source.

Plan and simulation against the live chains (nothing sent):

```
$ contracts/deploy-btc.sh mainnet
contract             address                                      status       L2 gas   L1 fee (wei)  est. cost (ETH)
X402BtcSettler       0x9Df0B4752D00dF65Fb4f7FfdFe0545543f08ab9f   DEPLOY       793029  9904635891759 0.000010697864735067
   L2 gas price now: 1000252 wei. Estimated total: 0.000010697864735067 ETH for 1 contract(s).
  [deploy] X402BtcSettler -> 0x9Df0B4752D00dF65Fb4f7FfdFe0545543f08ab9f
  checks passed: code present, HBK(), SETTLER(), CONFIRMATION_OFFSET()

$ contracts/deploy-btc.sh testnet
HbkTestnetAdapter    0x1D561c41067aB82Ab90be4dd385E4a704CC3D8F5   DEPLOY       636986         536455 0.000000637147693913
X402BtcSettler       0x56AdDfcC77b087D9101ddEE8D3A38e95E0A365B0   DEPLOY          n/a         705628      L1 fee only
   (1 contract(s) could not be gas-estimated before an earlier one exists; the total counts only their L1 fee.)
  [deploy] HbkTestnetAdapter -> 0x1D561c41067aB82Ab90be4dd385E4a704CC3D8F5
  [deploy] X402BtcSettler -> 0x56AdDfcC77b087D9101ddEE8D3A38e95E0A365B0
  contracts deployed in this run: 2
```

The mainnet deployment costs about 0.000011 ETH, almost all of it the L1 data fee for 3.8 kB of initcode. That is about $0.03 at $3,000 per ETH.

`--broadcast` and the gates were exercised against local anvil forks of both chains (ports 48545 and 48546) with anvil's public dev key, as `deploy.sh` was. The records were deleted afterwards because they are not real deployments.

```
testnet fork --broadcast              exit 0  [deploy] adapter, [deploy] settler, both status=0x1; rerun "contracts deployed in this run: 0"
testnet fork --broadcast, again       exit 0  "Nothing to deploy: everything already exists on testnet."
mainnet fork --broadcast, no key      exit 1  "--broadcast on mainnet needs DEPLOYER_PRIVATE_KEY (the testnet key is never used on mainnet)"
mainnet fork, deployer = testnet key  exit 1  "DEPLOYER_PRIVATE_KEY equals FACILITATOR_TESTNET_PRIVATE_KEY; refusing …"
mainnet fork, no confirmation         exit 3  "Refusing to broadcast to Hemi mainnet: … Set CONFIRM_MAINNET_DEPLOY=yes to proceed."
direct forge script --broadcast       revert  "DeployBtcSettler: broadcasting to Hemi mainnet needs CONFIRM_MAINNET_DEPLOY=yes"
mainnet fork, CONFIRM_MAINNET_DEPLOY=yes  exit 0  settler at 0x9Df0…ab9f, status=0x1 gasUsed=0xbe062 (778,338); SETTLER() = 0x1155…0875
```

### A-6. The live check: cast against the real node, with a state override

Forge cannot run hVM's precompiles, so `check-btc-live.sh` uses `cast` against the real node. Before deployment it gets the settler's runtime code by `eth_call` of the initcode, a contract creation with no `to`, on the same node, so the constructor's checks run there too. It then calls `verify` with that code as a state override. On testnet the adapter is created first and passed as an override while creating the settler, whose constructor checks that the adapter has code. `cast call --override-code` cannot be used because `cast call` refuses a target without code before sending, so the script uses `cast rpc eth_call` with an override object.

```
$ contracts/check-btc-live.sh mainnet
== Hemi mainnet (chain id 43111) via https://rpc.hemi.network, Hemi block 5698398
   hBK 0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12
   fixture tx 0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e vout 1, expected 83050000 sats to 0x0020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c4, Bitcoin block 975189

1. getLastHeader(): height 975202
2. getTxConfirmations(bytes32): 16
   getSpecificTxOutput(vout 1): (83050000 [8.305e7], 0x0020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c4, "", false, 0x, true, 34, true)
     (outValue, script, outputAddress, isOpReturn, opReturnData, isSpent, fullScriptLength, containsFullScript)

3. Confirmation offset
   vs hVM's header: hBK 16 - (lastHeader 975202 - 975189 + 1 = 14) = 2
   vs Bitcoin:      hBK 16 - (tip 975204 - 975189 + 1 = 16) = 0   (tip from https://btcscan.org)

4. X402BtcSettler.verify
   X402BtcSettler 0x9Df0B4752D00dF65Fb4f7FfdFe0545543f08ab9f: not deployed; using the compiled code as a state override (3314 bytes)
   CONFIRMATION_OFFSET() = 0
   verify(txid, 1, script, 83050000, minConfirmations 1):
     verdict Ok, sats 83050000, hbkConfirmations 16, confirmations 16, isSpent true, settledBy 0x0000000000000000000000000000000000000000000000000000000000000000

5. settle gas (eth_estimateGas from the facilitator's signer 0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875; nothing is sent)
   settle: 175780 gas

OK: verify returned Ok with 83050000 sats.
```

`verify` costs about 151,000 gas (`eth_estimateGas` with the override: `0x24e07`), and `settle` 175,780. With the 292-byte calldata's L1 fee of 638,553,817,162 wei and 1,000,252 wei gas price, one settlement costs 0.00000081 ETH, about $0.0025.

The same script with wrong inputs returns the expected verdicts and exits 1:

```
BTC_FIXTURE_SATS=83050001     verdict BelowAmount, sats 83050000      settle: would revert 0x1c5a03f1…06
BTC_FIXTURE_SCRIPT=0x0014bf98…7663   verdict ScriptMismatch           settle: would revert 0x1c5a03f1…04
BTC_FIXTURE_VOUT=2            getSpecificTxOutput: Panic(0x32); verdict OutputNotFound;  settle: would revert 0x1c5a03f1…03
```

### A-7. Testnet: adapter written, nothing deployed

Testnet's hBK `0xeC9f…f215` is an older Bitcoin Kit with `btc*` names. Its ABI came from hBK's demo `ContractABI.ts`. `testnet.explorer.hemi.xyz` reset every connection from this network, as `explorer.hemi.xyz` does (D-034), and so did mempool.space, blockstream.info and blockchair. `HbkTestnetAdapter` implements `IHbkReader` with `btcTxConfirmations` and `btcTxByTxid(txid).outputs[vout]`. It reshapes testnet's `Error("Transaction not found")` into mainnet's `Error("Bitcoin transaction not found")`, so the settler's bytecode is the same on both networks.

What the live testnet hBK did:

- `getLastHeader`, `getTxConfirmations`, `getSpecificTxOutput` (mainnet names): revert with no data.
- `btcLastHeader`: answers. `btcHeaderN` reverts for every height tried, as `getHeaderN` does on mainnet.
- To find a transaction the testnet hBK knows, without an explorer: block 5313912 contains only its coinbase, so the header's merkle root is that txid, `0x4bace22f…4c8f`. `btcTxConfirmations` gave 93 for it, then 141, 613 and 1787 as testnet3 blocks arrived. hVM's header lagged hBK's count by about 100 blocks.
- `btcTxByTxid` for that txid, in either byte order: `Error("Transaction not found")`. The `0x42` precompile answered when called directly with inputs left out of the bit flags, and returned nothing when inputs were requested. Testnet's hBK requests them, which may fail only for coinbases. No non-coinbase testnet transaction could be found to tell.

`check-btc-live.sh testnet` records this with the coinbase as its default fixture:

```
== Hemi testnet (chain id 743111) via https://testnet.rpc.hemi.network, Hemi block 7178058
   hBK 0xeC9fa5daC1118963933e1A675a4EEA0009b7f215
   fixture tx 0x4bace22fb1addc1ce6b774377b28eec684770f30a7aae9a625f8887703b44c8f vout 0, expected 1 sats to 0x0014000000000000000000000000000000000000000000, Bitcoin block 5313912

1. btcLastHeader(): height 5315598
2. btcTxConfirmations(bytes32): 1787
   btcTxByTxid: REVERT execution reverted: Transaction not found, data: "0x08c379a0000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000155472616e73616374696f6e206e6f7420666f756e640000000000000000000000

3. Confirmation offset
   vs hVM's header: hBK 1787 - (lastHeader 5315598 - 5313912 + 1 = 1687) = 100
   vs Bitcoin:      skipped (BTC_TIP_URL empty)

4. X402BtcSettler.verify
   HbkTestnetAdapter 0x1D561c41067aB82Ab90be4dd385E4a704CC3D8F5: not deployed; using the compiled code as a state override (2610 bytes)
   X402BtcSettler 0x56AdDfcC77b087D9101ddEE8D3A38e95E0A365B0: not deployed; using the compiled code as a state override (3314 bytes)
   CONFIRMATION_OFFSET() = 0
   verify(txid, 0, script, 1, minConfirmations 1):
     verdict TxNotFound, sats 0, hbkConfirmations 0, confirmations 0, isSpent false, settledBy 0x0000000000000000000000000000000000000000000000000000000000000000

5. settle gas (eth_estimateGas from the facilitator's signer 0xD2B2fc8093f8A734c42B90762FD2B2F8464631af; nothing is sent)
   settle: would revert: execution reverted, data: "0x1c5a03f10000000000000000000000000000000000000000000000000000000000000002

NOT OK: verify returned TxNotFound with 0 sats (expected Ok with 1).
```

Deployment on testnet was skipped for two reasons. The adapter's main path, `btcTxByTxid`, has not returned a transaction once. And this worktree has no `.env`, so `deploy.sh`'s key mechanism has no testnet key here. The command is ready for when a testnet3 payment confirms that `btcTxByTxid` works:

```
BTC_FIXTURE_TXID=0x… BTC_FIXTURE_VOUT=… BTC_FIXTURE_SATS=… BTC_FIXTURE_SCRIPT=0x… BTC_FIXTURE_HEIGHT=… contracts/check-btc-live.sh testnet
contracts/deploy-btc.sh testnet --broadcast
```

### A-8. MockBitcoinKit

`MockBitcoinKit` serves both ABIs from storage, so it works when etched over a contract: `vm.etch` in forge, `anvil_setCode` on an anvil fork. It reverts exactly as listed in A-3. It enforces hBK's 32-output limit, and `hbkOutput()` cuts scripts to 64 bytes as hBK does. For e2e on forks (streams B and C):

```
forge inspect test/mocks/MockBitcoinKit.sol:MockBitcoinKit deployedBytecode    # code for anvil_setCode at 0x7007…8F12
setPayment(bytes32 txid, uint32 vout, uint256 sats, bytes script, uint32 confirmations)   # earlier outputs are 0-value OP_RETURNs
setConfirmations(bytes32 txid, uint32 confirmations)
setSpent(bytes32 txid, uint32 vout, bool spent)    clearTx(bytes32 txid)
setTx(bytes32 txid, (uint256,bytes,string,bool,bytes,bool,uint256,bool)[] outputs, uint32 confirmations)
setLastHeader(uint32 height)                     # what getLastHeader / btcLastHeader return
setFailData(bytes) / setRawOutputAnswer(bytes) / setFailConfirmations(bool)   # error injection
```

On a fork the settler is deployed against the real hBK address, with the mock's code at that address, exactly as the fork tests do. On an anvil fork, `deploy-btc.sh` against the fork RPC does the same, because the deployment calls no hBK function. This sequence was run on a local anvil fork of mainnet (port 48546, anvil's dev key; nothing left the machine):

```
cast rpc anvil_setCode 0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12 "$(forge inspect test/mocks/MockBitcoinKit.sol:MockBitcoinKit deployedBytecode)"
cast send 0x7007…8F12 'setPayment(bytes32,uint32,uint256,bytes,uint32)' 0x95bca029…367e 1 83050000 0x0020ff64…12c4 11
cast send 0x7007…8F12 'setLastHeader(uint32)' 975197
HEMI_MAINNET_RPC_URL=http://127.0.0.1:48546 BTC_TIP_URL= contracts/check-btc-live.sh mainnet
    X402BtcSettler 0x9Df0…ab9f: not deployed; using the compiled code as a state override (3314 bytes)
    verdict Ok, sats 83050000, hbkConfirmations 11, confirmations 11, isSpent false   ->  exit 0
CONFIRM_MAINNET_DEPLOY=yes … contracts/deploy-btc.sh mainnet --broadcast                 ->  exit 0
contracts/check-btc-live.sh mainnet (same fork)
    X402BtcSettler 0x9Df0…ab9f: deployed
    verdict Ok, sats 83050000 …  settle: 93988 gas                                       ->  exit 0
cast send 0x9Df0…ab9f 'settle(…)' … 0xa8faed6a…6811 --from 0x1155…0875 (impersonated)   ->  status 1, gasUsed 93988
contracts/check-btc-live.sh mainnet (same fork)
    verdict AlreadyConsumed, settledBy 0xa8faed6a…6811; settle: would revert 0x1c5a03f1…01  ->  exit 1
```

The 93,988 gas against the mock is lower than the live estimate of 175,780 because the real hBK's precompile calls cost more.

### A-9. Explorer verification

`verify.sh` takes the settler and, on testnet, the adapter from `shared/hemi.json`. While they have no code they are listed as "not deployed (phase 2)" and do not change the exit status. Once deployed and unverified, it submits `src/btc` under the default profile, without metadata, so a full match is possible. It reads the constructor arguments back from the contract's own getters. The explorer is unreachable from this network (D-034). The branching was checked against a local stub explorer, read-only against mainnet and against an anvil fork with the settler deployed. The fork run recovered the arguments correctly (`7007dd1c…8f12, 1155c33c…0875, 0`) and exited 1 because the stub cannot accept a submission.

## Tests

```
$ (cd contracts && forge test)
forge Version: 1.8.6-Homebrew
Ran  3 tests for test/DeployData.t.sol:DeployDataTest
Ran  3 tests for test/X402BtcSettler.t.sol:DeployBtcSettlerOfflineTest
Ran 36 tests for test/X402BtcSettler.t.sol:X402BtcSettlerTest
Ran  5 tests for test/X402BtcSettler.fork.t.sol:BtcSettlerMainnetForkTest
Ran  7 tests for test/DeployHemi.fork.t.sol:HemiMainnetForkTest
Ran  7 tests for test/DeployHemi.fork.t.sol:HemiTestnetForkTest
Ran  5 tests for test/X402BtcSettler.fork.t.sol:BtcSettlerTestnetForkTest
Ran 7 test suites in 6.29s (12.91s CPU time): 66 tests passed, 0 failed, 0 skipped (66 total tests)
(every suite "ok", 0 failed, 0 skipped; fuzz tests at 256 runs each)
```

The 17 existing tests are unchanged. The 49 new ones, by DESIGN.md's list:

| DESIGN.md item | Tests |
|------|------|
| happy verify and settle: event, `settledBy`, return | `test_verify_ok`, `test_settle_recordsEmitsAndReturns`, fork `test_settleRoundTrip` |
| wrong and truncated script | `test_wrongScript`, `test_scriptPrefixAndExtensionDoNotMatch`, `test_truncatedScript` |
| confirmations boundary, offsets 1 and 0 | `test_confirmations_boundary_offset0`, `…_offset1`, `test_confirmations_belowOffsetFloorAtZero`, `test_settle_tooFewConfirmationsThenOk` |
| below and exact amount | `test_amount_exactIsOk_oneMoreIsBelow`, `test_settle_belowAmountReverts` |
| OP_RETURN | `test_opReturn` |
| consumed twice | `test_settle_twiceReverts`, `test_alreadyConsumed_skipsHbk` |
| unknown txid | `test_unknownTxid`, `test_txidInWrongByteOrderIsNotFound`, `test_clearTx`, fork `test_unknownTxOnFork` |
| vout out of range (hBK panics) | `test_voutOutOfRange`, `test_voutPast32IsNotFound`, `test_mockRevertsLikeHbk` |
| `isSpent` still Ok | `test_isSpentIsStillOk` |
| zero `paymentRef`, non-settler caller, ETH send | `test_settle_zeroPaymentRefReverts`, `test_settle_nonSettlerReverts`, `test_ethSendReverts` |
| fuzz: `verify` never reverts | `testFuzz_verifyNeverReverts`, `…_rawAnswer`, `…_revertData` (256 runs each), `test_malformedAnswersAreHbkError`, `test_hbkRevertingIsHbkError`, `test_confirmationsRevertingIsHbkError` |
| hBK's real answer layout | `test_liveMainnetAnswerDecodes`, `test_sourceLayoutWithSpentDetailDecodes` |
| adapter against the `btc*` mock | `test_adapter_overBtcAbi`, `test_adapter_constructorChecks`, fork `test_settlerReadsThroughAdapter` |
| deployment constants, CREATE2 address, rerun no-op | `DeployBtcSettlerOfflineTest` (3), fork `test_deploysAtPredictedAddress`, `test_rerunIsNoop` on both chains |

## Open questions for integration

1. **Earliest acceptance.** A payment verifies only once its block reaches hVM's header, about 3 Bitcoin confirmations on mainnet (A-2). Until then hBK says the transaction does not exist, so `verify` returns `TxNotFound`. DESIGN.md maps that to `invalid_exact_bip122_payload_transaction_not_found`, which a polling buyer treats as final. Stream B could answer `TxNotFound` with `settlement_pending` while `maxTimeoutSeconds` has not run out, as it does for `TooFewConfirmations`. The contract cannot tell "not yet" from "never".
2. **The count moves between `eth_call` and the transaction.** hBK counts against its node's Bitcoin tip, not hVM's header. A `verify` that passes in `eth_call` could fail inside the settle transaction on a node with an older tip. The settle then reverts `NotPayable(TooFewConfirmations)` and costs gas, but loses nothing. Whether every Hemi node computes the same count during block execution is a question for Hemi. hVM must be deterministic, so the count is probably fixed per block, but this was not measured.
3. **The 32-output and 64-byte limits.** hBK parses only the first 32 outputs and 64 script bytes. The buyer (stream C) must put the payment within the first 32 outputs. P2WPKH (22 bytes) and P2TR (34 bytes) scripts fit.
4. **Mainnet deployment** needs the owner's go: `CONFIRM_MAINNET_DEPLOY=yes contracts/deploy-btc.sh mainnet --broadcast` with `DEPLOYER_PRIVATE_KEY`, about 0.000011 ETH. Then commit `contracts/broadcast/DeployBtcSettler.s.sol/43111/`, run `contracts/check-btc-live.sh mainnet`, which then calls the deployed settler, and `contracts/verify.sh mainnet` from a network that reaches the explorer. The address does not change.
5. **The facilitator's mainnet signer is immutable in the settler.** Rotating `0x1155…0875` means a new settler at a new address, and a facilitator config update (stream B's `X402_BTC_SETTLER_MAINNET`).
6. **Testnet** stays best effort. It needs one non-coinbase testnet3 transaction that hVM knows, to confirm `btcTxByTxid` and the adapter's struct (A-7), and then a testnet key in `.env`.
7. **e2e on forks** (streams B and C): use the mock's code at the real hBK address and the setters in A-8. `setPayment` followed by `setConfirmations` covers the under-confirmed-then-confirmed flow.
