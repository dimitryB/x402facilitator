# hemi-x402-facilitator

An x402 v2 facilitator for Hemi. It verifies and settles `exact` payments on Hemi mainnet (`eip155:43111`) and Hemi testnet (`eip155:743111`) in USDC.e and hemiBTC, so any x402-aware agent can pay a Hemi endpoint.

It is the [x402-rs](https://github.com/x402-rs/x402-rs) facilitator at a pinned commit, with a Hemi config and thirteen small patches that make its error responses match the x402 v2 spec. The patches never change to whom funds go. One of them narrows what is accepted to the exact amount (D-016). The image is built locally. The x402 SDKs are used unmodified. On chain, Hemi only needs three standard contracts at their canonical addresses (see [Contracts](#contracts-and-addresses)).

**Status:** built and tested end to end on local forks of both Hemi chains. The live testnet run is scripted but waits for testnet funds. Mainnet waits for an explicit go to deploy two contracts; no mainnet transaction has been sent. See [Definition of done](#definition-of-done).

| Path | What it is |
|------|------|
| [`docker-compose.yml`](docker-compose.yml), [`facilitator/`](facilitator/) | The facilitator: pinned x402-rs image and its Hemi config |
| [`contracts/`](contracts/) | Foundry project that deploys Permit2, the EIP-6492 validator and the x402 exact proxy to their canonical addresses |
| [`seller/`](seller/) | Demo paid endpoint `GET /echo` ($0.001), accepting USDC.e and hemiBTC |
| [`buyer/`](buyer/) | Demo buyer using `@x402/fetch`; pays the seller and prints the settlement tx |
| [`tests/`](tests/) | End-to-end tests of `/verify` and `/settle` on local forks of both Hemi chains |
| [`sdk-patch/`](sdk-patch/) | Draft upstream patch adding Hemi to the x402 TypeScript SDK's default assets |
| [`shared/hemi.json`](shared/hemi.json) | Every Hemi address used here, in one file |
| [`DECISIONS.md`](DECISIONS.md) | The spike and every decision, with commands and outputs |

## Spike result

Each asset's transfer method was decided by read-only on-chain checks on both networks. [DECISIONS.md](DECISIONS.md) entries D-001 to D-012 hold every command and its output.

| Asset | Network | Transfer method | Buyer needs ETH on Hemi? |
|------|------|------|------|
| USDC.e | mainnet | EIP-3009 `transferWithAuthorization` | No, the payment is one signature |
| hemiBTC | mainnet | Permit2, through the x402 exact proxy | Once, for `approve(Permit2)` |
| USDC.e | testnet | Permit2 | Once |
| hBTC | testnet | Permit2 | Once |

- **Mainnet USDC.e** is Circle's FiatToken v2.2. It implements EIP-3009 and EIP-2612, and its EIP-712 domain is name `Bridged USDC (Stargate)`, version `2` (D-009, D-010).
- **Testnet USDC.e** is a different contract, a plain tunnel-bridged ERC-20 with neither standard. The testnet cannot exercise the mainnet USDC.e path, so that path is tested on a local fork of mainnet.
- **hemiBTC and hBTC** implement neither standard (D-011). hemiBTC has no testnet deployment, so testnet uses hBTC, the tunnel's BTC representation (D-008).
- **Contracts required by x402-rs** must exist before it will start a chain: canonical Permit2, the x402 exact proxy and the EIP-6492 validator. Permit2 already exists on mainnet. Everything else is missing and is deployed by `contracts/` (D-001, D-004 to D-006).

## Contracts and addresses

The same addresses on both networks. Each contract is replayed from its original bytes through the deterministic deployer, so it lands at the address every stock x402 client and x402-rs expects.

| Contract | Address | Mainnet | Testnet |
|------|------|------|------|
| Deterministic deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | present | present |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | present (genuine, D-004) | not yet deployed: `scripts/testnet-run.sh --go` deploys it |
| x402 exact Permit2 proxy | `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` | not yet deployed: needs the mainnet go | not yet deployed: `scripts/testnet-run.sh --go` deploys it |
| EIP-6492 validator | `0xdAcD51A54883eb67D95FAEb2BBfdC4a9a6BD2a3B` | not yet deployed: needs the mainnet go | not yet deployed: `scripts/testnet-run.sh --go` deploys it |
| Multicall3 | `0xcA11bde05977b3631167028862bE2a173976CA11` | present | present |

Assets (source: Hemi's token list, which feeds the tunnel UI, plus on-chain reads; D-007, D-008):

| Asset | Mainnet `eip155:43111` | Testnet `eip155:743111` |
|------|------|------|
| USDC.e (6 decimals) | `0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA` | `0xD47971C7F5B1067d25cd45d30b2c9eb60de96443` |
| hemiBTC (8 decimals) | `0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28` | none; use hBTC `0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7` |

Networks:

| | Mainnet | Testnet |
|------|------|------|
| Chain ID | 43111 | 743111 |
| RPC (primary, then fallback) | `https://hemi.drpc.org`, `https://rpc.hemi.network/rpc` | `https://hemi-testnet.drpc.org`, `https://testnet.rpc.hemi.network/rpc` |
| Explorer | https://explorer.hemi.xyz | https://testnet.explorer.hemi.xyz |

## Run it

You need Docker (any engine with Compose v2), Foundry (`cast`, `anvil`, `forge`), `jq` and Node 22.9 or later. The npm scripts use `--env-file-if-exists`, which Node added in 22.9. All Hemi values come from [`shared/hemi.json`](shared/hemi.json).

```bash
cp -n .env.example .env    # only if you have no .env yet; then fill in the keys
npm install
```

### Without funds: everything on local forks

`scripts/fork.sh` forks both Hemi chains with anvil and replays the missing contract deployments onto the forks: all three on testnet, and the proxy and validator on mainnet, where Permit2 already exists. Nothing is sent to a live network.

```bash
buyer/demo-fork.sh
```

This starts both forks, the facilitator (pointed at the forks) and the seller. It then pays once in each asset on each network: testnet USDC.e, testnet hBTC, mainnet USDC.e and mainnet hemiBTC. For each payment it prints the settlement tx and payTo's balance.

### The facilitator

x402-rs refuses to start if any configured chain lacks Permit2, the x402 exact proxy or the EIP-6492 validator. Pick the config that matches what is deployed. Today neither live network has all three (see [Contracts](#contracts-and-addresses)), so only the fork recipe works until a deployment runs.

```bash
# Local forks, works now. Primaries point at a dead port; fallbacks at the forks.
scripts/fork.sh up
docker compose -f docker-compose.yml -f docker-compose.fork.yml up -d
curl -s localhost:8080/supported | jq      # lists eip155:743111 and eip155:43111, scheme exact
docker compose -f docker-compose.yml -f docker-compose.fork.yml down && scripts/fork.sh down   # teardown

# Live networks: needs the contracts on each configured chain.
FACILITATOR_CONFIG=config.testnet.json docker compose up   # testnet only: after the testnet deployment
FACILITATOR_CONFIG=config.mainnet.json docker compose up   # mainnet only: after the mainnet deployment
docker compose up                                          # both chains (config.json): after both
```

If a contract or key is missing, the container exits with the reason. A missing contract shows as `Contract at address … does not exist`. An empty `FACILITATOR_*_PRIVATE_KEY` shows as `Invalid evm private key: invalid string length`. `docker compose logs facilitator` shows it, and the restart policy gives up after 5 tries instead of looping silently.

The image, `hemi-x402-facilitator:e75adda-hemi.4`, is x402-rs at commit `e75adda` plus thirteen small patches, built locally from [`facilitator/Dockerfile`](facilitator/Dockerfile). The first `up` builds it. The build fetches x402-rs from GitHub, the crates from crates.io and the pinned `rust:1.93-trixie` image (about 2.2 GB), then compiles for about 2 minutes on a 4-CPU machine. Add `--build` after changing a patch. Forks also need the Hemi public RPCs to be reachable.

Stock x402-rs does not return the x402 v2 spec's error shapes. The patches fix that:

- **Signature first:** the payer's signature is checked before balance or allowance. A bad signature returns `invalid_exact_evm_payload_signature`; stock x402-rs gives HTTP 500 `unexpected_error`. This holds for plain wallets and for contract wallets. An EIP-1271 wallet is asked `isValidSignature`, and an EIP-6492 signature is checked with the EIP-6492 validator before anything is sent.
- **Error bodies:** they carry the real `payer` and `network`.
- **Permit2:** allowance is checked before balance, and both are re-checked on settle.
- **Replay:** a replay returns `invalid_transaction_state`.
- **Receipt timeout:** a settlement whose receipt doesn't arrive in time returns `settlement_pending` with its tx hash, instead of dropping the hash.
- **Wrong network:** an unsupported network returns `invalid_network`.
- **Exact amount:** a signed amount must equal the price; over- and under-payment return `invalid_exact_evm_payload_authorization_value_mismatch`.
- **Spec codes everywhere:** expired or early authorizations, recipient mismatch, wrong asset, malformed bodies and failed simulations return the spec's §9 codes.
- **One settlement per authorization:** while a settle is pending, `/verify` of the same authorization is refused. A retry of the identical settle returns the same tx hash. The first retry after it is mined gets the success, and every later settle is a replay. One payment cannot pay for two requests.
- **Protocol version:** a missing or unsupported `x402Version` returns `invalid_x402_version`.

None of them changes where funds go. The exact-amount patch narrows what is accepted. [`facilitator/x402-rs/README.md`](facilitator/x402-rs/README.md) and D-016 explain each one. The unpatched stock image is kept, by digest, in a comment in `docker-compose.yml`.

[`facilitator/config.json`](facilitator/config.json) holds both chains, and [`config.testnet.json`](facilitator/config.testnet.json) and [`config.mainnet.json`](facilitator/config.mainnet.json) hold one each. Settings, all explained in D-013:

- **Scheme:** `v2-eip155-exact` on each chain. It accepts both EIP-3009 and Permit2 payloads. `/supported` lists `exact` per network; which transfer method a payment uses is set per asset by the seller's `extra.assetTransferMethod`.
- **RPCs:** dRPC first, the Hemi public RPC second, overridable with `HEMI_{TESTNET,MAINNET}_RPC_{PRIMARY,FALLBACK}`. x402-rs sends every read to all RPCs at once and takes the first answer, so a dead or stalled RPC costs nothing as long as one answers (D-015). The public RPC is throttled to 4 requests per second, under its ~300 per minute limit.
- **Signers:** one key per chain, `FACILITATOR_TESTNET_PRIVATE_KEY` and `FACILITATOR_MAINNET_PRIVATE_KEY`. The signer only pays gas.
- **Receipt timeout:** 60 seconds. Hemi RPCs do stall (the brief's outage note), and if a broadcast tx has no receipt by then, `/settle` returns `settlement_pending` with the tx hash instead of losing it. The timeout must stay under the seller SDK's 90-second facilitator timeout, or a stock seller gives up first and never sees the hash.

### Why the facilitator never holds funds

Read the two settlement paths and the config; neither path routes tokens through the facilitator.

- **EIP-3009 (mainnet USDC.e).** The facilitator submits `transferWithAuthorization(from, to, value, validAfter, validBefore, nonce, signature)` to the token. The payer signed all of those fields over the token's EIP-712 domain, so the token itself moves `value` from `from` to `to`. Any change to `to` breaks the signature.
- **Permit2 (every other asset).** The facilitator calls `settle` on the x402 exact proxy. The proxy's whole transfer step is in [`contracts/src/x402/x402BasePermit2Proxy.sol`](contracts/src/x402/x402BasePermit2Proxy.sol), vendored byte-for-byte from the x402 reference:

  ```solidity
  ISignatureTransfer.SignatureTransferDetails memory transferDetails =
      ISignatureTransfer.SignatureTransferDetails({to: to, requestedAmount: settlementAmount});
  PERMIT2.permitWitnessTransferFrom(permit, transferDetails, owner, witnessHash, witnessTypeString, signature);
  ```

  `to` is the witness the payer signed, and Permit2 pays exactly that address. The proxy has two entry points, `settle` and `settleWithPermit`. Both go through this `_settle`; `settleWithPermit` first submits the payer's own EIP-2612 permit to Permit2. The proxy has no owner and no withdraw function ([`x402ExactPermit2Proxy.sol`](contracts/src/x402/x402ExactPermit2Proxy.sol)).
- **Config.** The facilitator's only key is a gas signer per chain ([`facilitator/config.json`](facilitator/config.json)). Nothing in it, or in the x402-rs settle code, sets a recipient.

The settle tests in `tests/e2e/02-settle.test.ts` check this for each of the four assets. The receipt's only `Transfer` log goes payer to payTo, and the signer and the proxy hold zero tokens before and after.

## For sellers: point your server at this facilitator

Use the x402 server SDK with an HTTP facilitator client at this facilitator's URL. [`seller/server.ts`](seller/server.ts) is a complete Express example, and [`seller/README.md`](seller/README.md) covers it.

```ts
const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: "http://localhost:8080" }));
server.register("eip155:743111", new ExactEvmScheme());
```

Until Hemi is in the SDK's default assets ([`sdk-patch/`](sdk-patch/)), price with an explicit asset rather than a `"$0.001"` string. Set `extra` per asset:

| Asset | `extra` |
|------|------|
| Mainnet USDC.e | `{"assetTransferMethod": "eip3009", "name": "Bridged USDC (Stargate)", "version": "2"}` |
| hemiBTC, testnet USDC.e, hBTC | `{"assetTransferMethod": "permit2"}` |

The seller SDK checks the facilitator's `/supported` at startup and refuses to serve a network the facilitator does not list. A rejected `/verify` comes back from this facilitator as HTTP 400 with the §9 code in the body. The stock TS client surfaces it as a `VerifyError`, so the seller's 402 `error` reads `"<code>: <message>"` rather than the bare code; the spec does not fix the status code. Keep the SDK's default facilitator timeout (90 s) or raise it. Lowering it below the facilitator's 60-second receipt timeout would cut off a `settlement_pending` answer.

## For buyers: approving Permit2 (or not)

- **Mainnet USDC.e:** no approval and no ETH. The payment is one EIP-3009 signature, and the facilitator pays the gas.
- **hemiBTC, testnet USDC.e and hBTC:** once per token, the buyer sends `approve(Permit2, max)`, which needs a little ETH on Hemi. After that every payment is a signature only.
  - These tokens lack EIP-2612, so the approval can't be a signature (D-011). x402-rs does not implement the ERC-20 approval gas-sponsoring extension (D-001).
  - With `@x402/evm`, use `getPermit2AllowanceReadParams` to check the allowance and `createPermit2ApprovalTx` to build the approval. [`buyer/pay.ts`](buyer/pay.ts) does both automatically.
- **Spend controls:** a stock `x402Client` rejects assets it does not recognise. Allow-list the Hemi asset with `setSpendControls({ allowedAssets: [{ network, asset, maxAmountPerPayment }] })` (D-014).

```bash
npm run pay -w buyer -- --asset usdc --network testnet
npm run pay -w buyer -- --asset btc  --network testnet
```

These pay a live seller through a live facilitator, so they work only after the testnet deployment, with both running. `scripts/testnet-run.sh --go` does all of that. For a local run, use `buyer/demo-fork.sh`.

The buyer prints the settlement tx hash and its explorer link. [`buyer/README.md`](buyer/README.md) lists every option.

## Testnet run

Not run yet: the testnet wallets in `.env` are unfunded. Everything else is scripted. With no flag, the script only checks balances and prints what to fund; it sends nothing:

```bash
scripts/testnet-run.sh
```

It needs two funded wallets:

- **Facilitator/deployer:** about 0.001 testnet ETH. It deploys the three contracts (about 0.0000048 ETH in the `contracts/deploy.sh testnet` simulation) and pays settlement gas.
- **Buyer:** about 0.0001 ETH for its two one-time approvals, at least 0.001 USDC.e and at least 1 sat of hBTC.

Where the funds come from, all through the Hemi Portal tunnel in testnet mode (https://app.hemi.xyz/en/tunnel/?networkType=testnet):

| Asset | Path | Wait |
|------|------|------|
| Testnet ETH | Sepolia ETH, from any Sepolia faucet, tunneled Sepolia → Hemi testnet | minutes |
| Testnet USDC.e `0xD479…6443` | A transfer from an existing Hemi-testnet holder; the explorer shows about 206k. Or tunnel Sepolia token `0x94a9D9AC8a22534E3FaCa9F4e7F2E2cf85d5E4C8` (the token list's `bridgeInfo`) from Sepolia. Its `mint` is owner-only, so the Sepolia side also has to come from a holder | minutes |
| Testnet hBTC `0x36Ab…fAe7` | Bitcoin testnet coins (Hemi's docs point to a tBTC faucet) deposited through the Bitcoin tunnel | about 1 hour for 6 Bitcoin confirmations, sometimes plus a manual vault confirmation |

hBTC has no Sepolia route. A Hemi-testnet transfer from an existing holder is the fast alternative.

Then run:

```bash
scripts/testnet-run.sh --go
```

In order, it:

1. deploys the three contracts on testnet and attempts explorer verification;
2. starts the facilitator with the testnet config and the seller;
3. pays once in USDC.e and once in hBTC;
4. writes the settlement tx hashes, linked on testnet.explorer.hemi.xyz, plus the seller's verify-then-settle log, to `docs/testnet-run.md`.

## Mainnet deployment

The mainnet facilitator needs two contracts that do not exist on Hemi mainnet yet: the x402 exact proxy and the EIP-6492 validator. Permit2 is already there. Deploying them is the only mainnet transaction this project needs. The estimated cost is under 0.00001 ETH in total; see D-005 for the breakdown.

1. Simulate. This sends nothing:
   ```bash
   contracts/deploy.sh mainnet
   ```
2. Put a funded mainnet key in `.env` as `DEPLOYER_PRIVATE_KEY`, not on the command line. The script reads `.env` itself and refuses if that key equals `FACILITATOR_TESTNET_PRIVATE_KEY`. Then deploy:
   ```bash
   CONFIRM_MAINNET_DEPLOY=yes contracts/deploy.sh mainnet --broadcast
   ```
   The script checks each contract's CREATE2 address, deployed codehash, `PERMIT2()` and the Permit2 domain separator.
3. Verify on the explorer (best effort; [`contracts/README.md`](contracts/README.md) explains what Blockscout can match):
   ```bash
   contracts/verify.sh mainnet
   ```
4. Set `FACILITATOR_MAINNET_PRIVATE_KEY` in `.env` to a gas-only key with a little ETH. Then start the facilitator. Use the mainnet-only config, or plain `docker compose up` once the testnet contracts are also deployed:
   ```bash
   FACILITATOR_CONFIG=config.mainnet.json docker compose up -d
   ```
5. Start a seller that offers mainnet. It reads `SELLER_PAY_TO` from `.env`:
   ```bash
   SELLER_NETWORKS=eip155:43111 npm run start -w seller
   ```
6. Pay on mainnet. This spends real funds: 0.001 USDC.e, or 1 sat plus a one-time approval for hemiBTC.
   ```bash
   ALLOW_MAINNET=yes npm run pay -w buyer -- --asset usdc --network mainnet
   ```

**Mainnet transactions run so far: none.** No mainnet tx hash exists yet. This section will carry the deployment and payment hashes once they run.

## Tests

```bash
npm test -w tests              # end-to-end on local forks, with dead primary RPCs
(cd contracts && forge test)   # deployment, codehash and settle-path tests on forks
```

The end-to-end suite starts both forks and the facilitator image from this repo. Both primary RPCs point at a dead port, so every test also exercises RPC failover. Every payload is built with the stock `@x402/evm` client. The suite covers:

- `/supported`
- verify and settle in all four assets, with exact balance checks
- bad signatures and insufficient balance under both transfer methods, checked against the spec's error shapes
- the same bad-signature cases with an unfunded, unapproved payer, which must still report the signature first
- contract-wallet (EIP-1271) payers that accept and that reject a signature, and EIP-6492-wrapped signatures
- over- and under-payment, expired and early authorizations, recipient and asset mismatches, and malformed bodies
- missing Permit2 allowance
- replay
- a stalled receipt returning `settlement_pending` with the hash; a retry returns the same hash, then success once mined, then replay; verify is refused while pending; concurrent retries get one success; a seller-engine run with one payment header serves once
- an unsupported network returning `invalid_network`
- that the facilitator and the proxy never hold tokens
- that the dead primary really is dead inside the container

Latest results (2026-10-29), against a no-cache build of the image:

| Suite | Result |
|------|------|
| `npm test -w tests` | 8 files, 82 tests passed, 0 failed (100 s) |
| `forge test` | 17 passed, 0 failed |
| `buyer/demo-fork.sh` | all four payments settled; payTo received exactly the price each time |

## Definition of done

| Item | Status | Evidence |
|------|------|------|
| `docker compose up` starts the facilitator; `/supported` lists both networks with `exact` | Met on forks (`docker-compose.fork.yml`). Blocked live until the contracts are deployed: the testnet run deploys them on testnet; mainnet needs the go | `tests/e2e/01-supported.test.ts`, D-013, D-016 |
| One `/verify` then `/settle` on testnet in USDC.e, tx linked on the explorer | **Open:** waits for testnet funds. On a testnet fork it passes | `scripts/testnet-run.sh`, `tests/e2e/02-settle.test.ts` |
| One settle on testnet in hemiBTC (hBTC, per D-008) | **Open:** waits for testnet funds. On a testnet fork it passes | as above |
| Failed signature and insufficient balance return the spec's error shapes, with tests | Met | `tests/e2e/03-bad-signature.test.ts`, `04-insufficient-balance.test.ts`, D-016 |
| Facilitator never holds funds, shown by reading the proxy and config | Met | [Why the facilitator never holds funds](#why-the-facilitator-never-holds-funds); balance and log checks in `02-settle.test.ts` |
| RPC failover: tests pass with the primary RPC on a dead port | Met | every e2e test runs that way; `tests/e2e/05-rpc-failover.test.ts`, D-015 |
| README covers spike, addresses, Permit2 approval, seller setup, mainnet steps and mainnet tx hash | Met; the mainnet hash is "none yet" | this file |
| DECISIONS.md has an entry, with command and output, for every verify item | Met | D-002 to D-012 |

## Limits and open items

- **Mainnet USDC.e and EIP-3009:** the testnet has no EIP-3009 token, so that path is proven only on a local fork of mainnet until a mainnet payment runs.
- **Explorer verification:** expected to be a partial match at best for the proxy, because its original build embedded metadata (`contracts/README.md`).
- **Mainnet explorer:** blocked from the machine that ran the spike. Mainnet token addresses rest on Hemi's token list and on-chain reads (D-002, Q-1).
- **Combined failures:** when one payload fails several checks, the code reported can differ from `scheme_exact_evm.md`'s listed order. Single-failure cases, which the Definition of done covers, follow the spec. [`facilitator/x402-rs/README.md`](facilitator/x402-rs/README.md) ("Check order") records the chosen order and the test that pins it.
- **Nonce gap after a timeout:** after `settlement_pending`, the facilitator keeps that tx's nonce, so a tx that may still mine is never replaced. If the tx is later dropped from every mempool, later settles on that chain queue behind the gap. To recover, restart the facilitator, which re-reads the nonce from the chain.
- **Charged but not served:** if a settle goes `settlement_pending` and the stock seller's single automatic retry is also still pending, the seller refuses the request. The payment can still mine later, so the buyer is charged without being served. To reconcile, look up the `transaction` hash from the `settlement_pending` answer; the seller logs it. The same payment header is then refused as a replay.
- **Facilitator memory:** pending-settlement records live in memory. A facilitator restart forgets them, after which a pending authorization is judged by the chain alone.
- **Verify-then-settle race:** two requests carrying the same payment header that both pass `/verify` before either settles can both reach the seller's handler; only one settle succeeds. This is inherent to the x402 verify, handler, settle flow, not specific to this facilitator.
- **EIP-6492 deployment path:** a counterfactual wallet that is deployed during settle is untested end to end. The forks have no wallet factory, so only rejection and the plain-wallet shortcut are tested.
- **Phase 2:** paying in Bitcoin L1 and verifying through hBK is not started (D-012).
