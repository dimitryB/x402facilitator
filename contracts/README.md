# contracts/

Stock x402-rs refuses to start an EVM chain unless three contracts have code at fixed addresses
(DECISIONS.md D-001, `assert_contracts_exists`). This Foundry project puts them on Hemi mainnet
(43111) and Hemi testnet (743111) at those canonical addresses, checks them, and tests the
settlement path the facilitator uses.

Phase 2 adds `X402BtcSettler`, which verifies Bitcoin L1 payments through Hemi's Bitcoin Kit and records
each consumed output on Hemi. It is described in the section "Phase 2: X402BtcSettler" below and in
`docs/phase2/contracts.md`.

| Contract | Address | What it is | Mainnet | Testnet |
|------|------|------|------|------|
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | Uniswap's signature-transfer contract; buyers approve it once per token | present (D-004) | deployed 2026-10-29 |
| EIP-6492 validator | `0xdAcD51A54883eb67D95FAEb2BBfdC4a9a6BD2a3B` | `UniversalSigValidator`; x402-rs calls it only for counterfactual-wallet signatures | deployed 2026-11-04 (D-029) | deployed 2026-10-29 |
| x402 exact Permit2 proxy | `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` | `x402ExactPermit2Proxy`; the only spender the facilitator accepts in a Permit2 payload | deployed 2026-11-04 (D-029) | deployed 2026-10-29 |

At the time of the spike (D-004 to D-006) only mainnet's Permit2 existed. This project deployed the rest: on testnet on 2026-10-29, and on mainnet on 2026-11-04 (D-029).

## Where the bytes come from

Nothing here is compiled for deployment. Each contract is created by sending `<32-byte salt><initcode>`
to the deterministic deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`, which CREATE2s it. The
exact calldata is committed in `deploy-data/`. Recompiling would change the bytecode and with it the
address.

| File | Source | Salt | Initcode keccak |
|------|------|------|------|
| `deploy-data/permit2.calldata.hex` | input of Ethereum tx `0xf2f1fe96…d377`, Uniswap's original Permit2 deployment (D-004) | `0x…d3af2663da51c10215000000` | `0xe2be1e05…f0f8` |
| `deploy-data/validator6492.calldata.hex` | input of Ethereum tx `0x99707363…27c9`, the validator's original deployment (D-006) | `"x402"` | `0x8a457240…475e` |
| `deploy-data/exact-proxy.calldata.hex` | salt and `script/data/exact-proxy-initcode.hex` from x402-foundation/x402 at `e4a0868` (D-005); the initcode embeds canonical Permit2 as constructor argument | `0x…3000000007263b0e` | `0xe774d1d5…604c` |

`script/DeployHemi.s.sol` checks every file's salt, initcode hash and CREATE2 address before
sending anything. The offline test `test/DeployData.t.sol` replays all three files and gets runtime code
byte-identical to what already runs elsewhere:

| Contract | Runtime code keccak | Matches |
|------|------|------|
| Permit2 on 43111 | `0x30002d17c268825d175caba993df71c34b30048f344b2ba63705a3063fa4743a` | Permit2 on Hemi mainnet (D-004) |
| Permit2 on 743111 | `0xc2e956e28d37dfea694910b07039b15bff6df7a4ed332c246beec4db54e2dc02` | the mainnet code with its two immutables (chain id, domain separator) set to testnet's values |
| Validator | `0x9b83857bbb34de3ba755156ba9bee06532be5ff539bf5de301a28606c76d6cab` | the validator on Ethereum and Base |
| Exact proxy | `0xce6429c0bb49284660683287c0a8fe548a88379072327d026626909d202048b9` | the proxy on Ethereum and Base |

Expected Permit2 `DOMAIN_SEPARATOR()`: `0x1bfbbf0056b6ec1bbca73ea788b4a65c034128fd6543621be486785424550c8f`
on mainnet and `0x323d993c5455dce711e33c078f319f1b26ea31ae677aa7d62a2b5cd11ba81c5f` on testnet.

`src/x402/` holds the proxy's Solidity source, copied unchanged from the x402 reference (see
`src/x402/README.md`). It is used for reading, for the proxy's ABI in tests, and for explorer
verification. Built with the reference compile settings, it reproduces the deployed proxy runtime code
exactly, except for the trailing CBOR metadata.

## Layout

```
deploy-data/            committed deployment calldata (salt + initcode), one file per contract
script/DeployHemi.s.sol idempotent deployment script with pre- and post-checks
test/DeployData.t.sol   offline: calldata integrity, byte-identical replay, vendored source vs deployed code
test/DeployHemi.fork.t.sol  forks of Hemi testnet and mainnet: deploy, rerun, settle through the proxy
src/x402/               vendored x402ExactPermit2Proxy source (unchanged), for reading and verification
lib/forge-std/          forge-std v1.17.0 (f3dae6e6), vendored with `forge install --no-git`
lib/openzeppelin-contracts/  the three OpenZeppelin v5.5.0 files the proxy imports, unchanged
deploy.sh               plan, simulate, and (with --broadcast) deploy
verify.sh               best-effort Blockscout verification (also the phase 2 contracts)

Phase 2 (Bitcoin L1 payments):
src/btc/                X402BtcSettler, IHbkReader (the two hBK functions it reads), HbkTestnetAdapter
script/DeployBtcSettler.s.sol  idempotent CREATE2 deployment of the settler (and the testnet adapter)
test/X402BtcSettler.t.sol      offline: settler, adapter, deployment constants vs shared/hemi.json
test/X402BtcSettler.fork.t.sol forks of both chains with MockBitcoinKit etched at the real hBK address
test/X402BtcSettlerAudit.t.sol offline: edge cases from the pre-deployment security review (D-038)
test/X402BtcSettlerLiveReplay.t.sol  offline: raw answers captured from mainnet's hBK, replayed (D-038)
test/mocks/MockBitcoinKit.sol  hBK stand-in with both hBK ABIs and hBK's exact reverts
deploy-btc.sh           deploy.sh's flow for the settler
check-btc-live.sh       read-only check of a real Bitcoin payment through the live hBK
```

`foundry.toml`'s default profile uses the reference's compile settings (solc 0.8.28, cancun, optimizer
200 runs, `cbor_metadata = false`, `bytecode_hash = "none"`). The `verify` profile turns CBOR metadata
back on for explorer verification and writes to `out/verify` and `cache/verify`.

Requirements: Foundry 1.8.6 (`forge`, `cast`, `anvil`), `jq` and `curl`.

## Test

```sh
cd contracts
forge test
```

85 tests in nine suites: the 17 below, 49 for phase 2 (see "Phase 2: X402BtcSettler") and 19 ported
from the pre-deployment security review (D-038).
`DeployDataTest` needs no network. `HemiTestnetForkTest` and
`HemiMainnetForkTest` fork the live chains at pinned blocks (testnet 7094100, mainnet 5614400), run the
deployment script's logic, and assert:

- every missing contract is deployed (3 on testnet, 2 on mainnet, where Permit2 already exists), with
  the runtime code hashes above;
- the proxy's `PERMIT2()` is canonical Permit2, and Permit2's `DOMAIN_SEPARATOR()` equals the hardcoded
  per-chain value;
- a second run deploys nothing and never calls the deployer;
- `settle()` on the proxy, called by a facilitator address with a payer's real Permit2
  `PermitWitnessTransferFrom` signature (built with `vm.sign`), moves the amount from the payer straight
  to the witness `to`. It emits exactly one ERC-20 `Transfer` (payer to `to`), and the facilitator's and
  the proxy's token balances and allowances stay at zero. The same signature with `to` changed to the
  facilitator reverts with `InvalidSigner`, and replaying it reverts with `InvalidNonce`. This runs for
  testnet USDC.e and hBTC, mainnet hemiBTC, and mainnet USDC.e (which settles through EIP-3009 in
  production). The payer is funded by writing the token's balance mapping slot (D-013).

The fork tests read from `https://testnet.rpc.hemi.network/rpc` and `https://rpc.hemi.network/rpc`.
Forge caches the pinned-block state in `~/.foundry/cache/rpc`, so reruns are mostly offline. Overrides:
`HEMI_TESTNET_RPC_URL`, `HEMI_MAINNET_RPC_URL` (for example `https://hemi-testnet.drpc.org` and
`https://hemi.drpc.org` if the public RPC is slow), `HEMI_TESTNET_FORK_BLOCK` and `HEMI_MAINNET_FORK_BLOCK`.
Pass `--no-storage-caching` to force fresh RPC reads.

## Simulate

```sh
contracts/deploy.sh testnet
contracts/deploy.sh mainnet
```

Without `--broadcast` nothing is sent. The script checks that the RPC reports the right chain id, then
prints a plan: each contract, whether it is present, and for each missing one the estimated L2 gas
(`cast estimate`), the L1 data fee (`GasPriceOracle.getL1Fee` on the calldata) and the cost at the current
gas price. It then runs `forge script` as a simulation, which executes the deployments on a fork of the
live chain and runs all post-checks.

On 2026-10-28 the estimates were about 0.0000034 ETH for the three testnet contracts. For the two
contracts missing on mainnet they ranged from 0.0000057 to 0.0000091 ETH across runs that day. Most of
the mainnet cost is the L1 data fee, which follows Ethereum gas prices.

## Deploy

Hemi testnet. The key is `DEPLOYER_PRIVATE_KEY`, or `FACILITATOR_TESTNET_PRIVATE_KEY` if that is unset:

```sh
set -a; . ./.env; set +a          # from the repo root, if the key lives in .env
contracts/deploy.sh testnet --broadcast
```

Hemi mainnet. This needs an explicit go (docs/BRIEF.md). It requires `DEPLOYER_PRIVATE_KEY`; the
testnet key is never used on mainnet, and a `DEPLOYER_PRIVATE_KEY` equal to
`FACILITATOR_TESTNET_PRIVATE_KEY` is refused. Run it without the confirmation first to see the plan:

```sh
contracts/deploy.sh mainnet --broadcast                            # prints the plan and cost, then refuses (exit 3)
CONFIRM_MAINNET_DEPLOY=yes contracts/deploy.sh mainnet --broadcast # deploys
```

`DeployHemi.s.sol` enforces the same confirmation itself, so `forge script … --broadcast` against
chain 43111 without `CONFIRM_MAINNET_DEPLOY=yes` also reverts.

With `--broadcast`, `deploy.sh`:

1. prints the plan and runs the simulation, as above;
2. stops if nothing is missing, and on mainnet stops unless `CONFIRM_MAINNET_DEPLOY=yes`;
3. runs `forge script --broadcast --slow`, one transaction per missing contract, each confirmed before
   the next;
4. prints each transaction as an explorer link, from `broadcast/DeployHemi.s.sol/<chain id>/run-latest.json`;
5. reruns the script as a simulation, which must deploy nothing and pass every check.

Details:

- RPC: `HEMI_TESTNET_RPC_URL` or `HEMI_MAINNET_RPC_URL`, defaulting to the Hemi public RPC. Only the
  scheme and host are printed.
- The key reaches forge through the environment variable `HEMI_DEPLOY_PRIVATE_KEY`, set by `deploy.sh`
  for the forge process only. It is not put on a command line or printed.
- Fees: forge would derive a 1 wei priority fee from Hemi's mostly empty blocks. `deploy.sh` instead
  passes the node's `eth_maxPriorityFeePerGas` (1e6 wei at the time of writing) and a max fee of twice
  the base fee plus that tip.
- The script is idempotent. Rerunning after a partial failure deploys only what is missing.
- `broadcast/DeployHemi.s.sol/<chain id>/run-*.json` from a real deployment is the record of its
  transactions and can be committed. `contracts/.gitignore` ignores dry runs and lock files.

`deploy.sh` was exercised end to end against local anvil forks of both chains (ports 48545 and 48546):
testnet broadcast with the fallback key, rerun as a no-op, mainnet refused without a mainnet key, with
the testnet key, and without the confirmation, the script-level gate on a direct `forge script --broadcast`,
and a confirmed mainnet-fork broadcast. On 2026-10-29 it deployed all three contracts on Hemi testnet; the record is in `broadcast/DeployHemi.s.sol/743111/`. On 2026-11-04 it deployed the validator and the proxy on Hemi mainnet, where Permit2 already existed; the record is in `broadcast/DeployHemi.s.sol/43111/` (D-029).

## Explorer verification

```sh
contracts/verify.sh testnet
contracts/verify.sh mainnet     # if curl cannot reach explorer.hemi.xyz (D-034), run it elsewhere,
                                # or set HEMI_MAINNET_EXPLORER_URL
```

For each contract, `verify.sh` checks that the address has code. It then reads the contract from
Blockscout's API (`/api/v2/smart-contracts/<address>`) and waits for Blockscout's bytecode-database
lookup. If the proxy is still unverified, it submits the vendored source with
`forge verify-contract --verifier blockscout --verifier-url <explorer>/api/` under the `verify`
profile. It prints a summary and exits 0 only if all three show as verified, fully or partially.

What is realistically verifiable, as found on 2026-10-28:

- Hemi's testnet Blockscout (backend `v6.9.0-hemi.25`) uses Blockscout's shared bytecode database
  (eth-bytecode-db). Multicall3 on Hemi testnet shows as fully verified with
  `is_verified_via_eth_bytecode_db: true`, so its source came from that database.
- eth-bytecode-db already holds sources for all three creation codes. A `sources:search` query with each
  committed initcode returned 39 matches for Permit2 (`Permit2`, solc 0.8.17), 4 for the validator
  (`UniversalSigValidator`, solc 0.8.30) and 3 for the proxy (`x402ExactPermit2Proxy`, solc 0.8.28).
  Every match is `PARTIAL`. On Hemi testnet all three now show as partial matches through that
  database, with no submission at all. On Hemi mainnet the validator and the proxy verified the same way
  on 2026-11-04, once looked up in a browser. Permit2, for which Blockscout has no creation transaction,
  did not (D-034).
- The proxy cannot get a full match. The deployed initcode was built with CBOR metadata whose IPFS
  hash depends on the original build environment (the reference repo says so in `Deploy.s.sol`). The
  standard-JSON input `verify.sh` submits compiles (checked with solc 0.8.28 directly) to bytecode of
  the same length as the deployed initcode. It differs only in the 32-byte IPFS digest inside the
  metadata (bytes 3092 to 3123 of 3135). Blockscout calls that a partial match. Building with the
  reference's current `cbor_metadata = false` would not match at all, because the lengths differ.
- Permit2 and the validator are not compiled in this repo, so `verify.sh` submits nothing for them. If
  the bytecode-database lookup does not verify them, their sources are Uniswap/permit2 (solc 0.8.17,
  via-IR, 1,000,000 runs) and the `UniversalSigValidator` source in eth-bytecode-db (solc 0.8.30, prague,
  via-IR, no metadata).

On Hemi testnet, `verify.sh` reports all three contracts as partial matches through the bytecode database. On 2026-10-28, before anything was deployed, it correctly reported "not deployed" for all three. Its status parsing
was checked against a verified contract (Multicall3), an unverified one (the deployer) and an empty
address.

## Phase 2: X402BtcSettler

An x402 buyer can pay in BTC on Bitcoin L1 to an address derived for that payment (scheme `exact` on
`bip122:*`, `docs/phase2/DESIGN.md`). The facilitator checks the payment through Hemi's Bitcoin Kit
(hBK) inside `X402BtcSettler` and marks the output consumed on Hemi. Decisions, commands and outputs
are in `docs/phase2/contracts.md`.

| Network | Contract | Address | Status |
|------|------|------|------|
| Hemi mainnet | X402BtcSettler | `0x9Df0B4752D00dF65Fb4f7FfdFe0545543f08ab9f` | deployed 2026-11-09, tx `0xeaef24d9…1ae1` (D-039); first live `settle` 2026-11-10, tx `0xcaea6da8…ef3b`, 166753 gas (D-040) |
| Hemi testnet | HbkTestnetAdapter | `0x1D561c41067aB82Ab90be4dd385E4a704CC3D8F5` | predicted, not deployed |
| Hemi testnet | X402BtcSettler | `0x56AdDfcC77b087D9101ddEE8D3A38e95E0A365B0` | predicted, not deployed |

- `verify(txid, vout, scriptPubKey, minSats, minConfirmations)` never reverts. It reads the output and
  its confirmation count from hBK (`0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12` on mainnet) and returns a
  verdict: `Ok`, `AlreadyConsumed`, `TxNotFound`, `OutputNotFound`, `ScriptMismatch`, `OpReturn`,
  `BelowAmount`, `TooFewConfirmations` or `HbkError`.
- `settle(…, paymentRef)` re-checks and records `settledBy[txid][vout] = paymentRef`. Only the
  immutable `SETTLER`, the facilitator's Hemi signer, may call it; anyone else could block a real
  settlement by consuming the output first.
- No owner, no upgrade, no funds. Changing hBK, the signer or the confirmation offset means a new
  contract at a new address.
- The mainnet settler's source has not been submitted to the explorer yet (D-039). `contracts/verify.sh
  mainnet` submits it; the default build has no metadata, so a full match is possible.
- `CONFIRMATION_OFFSET` is 0: on 2026-11-09 hBK's count equalled Bitcoin's. A payment becomes visible
  to hBK only once its block reaches hVM's Bitcoin header, which lagged the tip by 2 blocks.
- Testnet's hBK has an older `btc*` ABI; `HbkTestnetAdapter` sits in front of it, so the settler's
  code is the same on both networks. Testnet's `btcTxByTxid` returned no transaction in the checks
  made, so nothing is deployed there yet.

The addresses are CREATE2 addresses of the code built with the default profile (no metadata) and the
constructor arguments in `DeployBtcSettler.s.sol`. The script and `DeployBtcSettlerOfflineTest` refuse a
mismatch between the compiled code, the constants and `shared/hemi.json`.

```sh
contracts/check-btc-live.sh mainnet          # read-only; verify() on a real payment, prints the offset
contracts/deploy-btc.sh mainnet              # plan, cost and simulation; sends nothing
CONFIRM_MAINNET_DEPLOY=yes contracts/deploy-btc.sh mainnet --broadcast   # sends a mainnet transaction
contracts/deploy-btc.sh testnet --broadcast
```

`deploy-btc.sh` takes the same keys and environment as `deploy.sh`. It was exercised against local anvil
forks of both chains, including all three mainnet refusals and the script's own gate. Forge cannot run
hVM's precompiles, so the fork tests replace hBK with `test/mocks/MockBitcoinKit.sol` and the live check
uses `cast` against the real node. Before deployment the live check runs the compiled settler as an
`eth_call` state override.

