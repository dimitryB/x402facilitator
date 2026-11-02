# hemi-x402-facilitator

An x402 v2 facilitator for Hemi. It verifies and settles `exact` payments on Hemi mainnet (`eip155:43111`) and Hemi testnet (`eip155:743111`) in USDC.e and hemiBTC, so any x402-aware agent can pay a Hemi endpoint.

It is the [x402-rs](https://github.com/x402-rs/x402-rs) facilitator at a pinned commit, with a Hemi config and twenty-seven small patches. Eighteen make its error responses match the x402 v2 spec, one keeps a settlement from being priced below Hemi testnet's minimum tip (D-018), and eight keep a settlement's outcome correct under load and when RPCs stall or fail (D-019 to D-022). The patches never change to whom funds go. One of them narrows what is accepted to the exact amount (D-016). The image is built locally. The x402 SDKs are used unmodified. On chain, Hemi only needs three standard contracts at their canonical addresses (see [Contracts](#contracts-and-addresses)).

**Status:** built and tested end to end on local forks of both Hemi chains. On Hemi testnet, the contracts are deployed and live payments have settled in USDC.e and hBTC ([docs/testnet-run.md](docs/testnet-run.md)). Mainnet waits for an explicit go to deploy two contracts; no mainnet transaction has been sent. See [Definition of done](#definition-of-done).

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

Each asset's transfer method was decided by read-only on-chain checks on both networks. [DECISIONS.md](DECISIONS.md) entries D-002 to D-012 hold the decisive commands and outputs; D-001 summarises them. The full, unshortened transcripts are in [`docs/spike/`](docs/spike/).

| Asset | Network | Transfer method | Buyer needs ETH on Hemi? |
|------|------|------|------|
| USDC.e | mainnet | EIP-3009 `transferWithAuthorization` | No, the payment is one signature |
| hemiBTC | mainnet | Permit2, through the x402 exact proxy | Once, for `approve(Permit2)` |
| USDC.e | testnet | Permit2 | Once |
| hBTC | testnet | Permit2 | Once |

- **Mainnet USDC.e** is Circle's FiatToken v2.2. It implements EIP-3009 and EIP-2612, and its EIP-712 domain is name `Bridged USDC (Stargate)`, version `2` (D-009, D-010).
- **Testnet USDC.e** is a different contract, a plain tunnel-bridged ERC-20 with neither standard. The testnet cannot exercise the mainnet USDC.e path, so that path is tested on a local fork of mainnet.
- **hemiBTC and hBTC** implement neither standard (D-011). hemiBTC has no testnet deployment, so testnet uses hBTC, the tunnel's BTC representation (D-008).
- **Contracts required by x402-rs** must exist before it will start a chain: canonical Permit2, the x402 exact proxy and the EIP-6492 validator. At the time of the spike only mainnet Permit2 existed. `contracts/` deploys the rest (D-001, D-004 to D-006), which is done on testnet; see [Contracts](#contracts-and-addresses) for what exists now.

## Contracts and addresses

The same addresses on both networks. Each contract is replayed from its original bytes through the deterministic deployer, so it lands at the address every stock x402 client and x402-rs expects.

| Contract | Address | Mainnet | Testnet |
|------|------|------|------|
| Deterministic deployer | `0x4e59b44847b379578588920cA78FbF26c0B4956C` | present | present |
| Permit2 | `0x000000000022D473030F116dDEE9F6B43aC78BA3` | present (genuine, D-004) | deployed 2026-10-29, [tx](https://testnet.explorer.hemi.xyz/tx/0xa50c7ded891f840ba67b6fd92c74a5acba7d630d166cd8da18004e64c876c638) |
| x402 exact Permit2 proxy | `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` | not yet deployed: needs the mainnet go | deployed 2026-10-29, [tx](https://testnet.explorer.hemi.xyz/tx/0x0b2c46fa31d97c43588f9a78fb3eec469f664033495d342979408253481ec863) |
| EIP-6492 validator | `0xdAcD51A54883eb67D95FAEb2BBfdC4a9a6BD2a3B` | not yet deployed: needs the mainnet go | deployed 2026-10-29, [tx](https://testnet.explorer.hemi.xyz/tx/0xec5e69e3ee1a477a54df8b549d5191b8ecb0761bf43b2d7df0db8055929c740e) |
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

You need Docker (any engine with Compose v2), Foundry (`cast`, `anvil`, `forge`), `jq` and Node 22.9 or later. With Colima, keep the clone under `$HOME`, the only path it shares by default. Elsewhere the facilitator exits with `Failed to read config file at /app/config.json: Is a directory`. The npm scripts use `--env-file-if-exists`, which Node added in 22.9. The seller, buyer and tests take their Hemi values from [`shared/hemi.json`](shared/hemi.json). The facilitator configs and compose defaults repeat the chain ids and RPC URLs.

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

x402-rs refuses to start if any configured chain lacks Permit2, the x402 exact proxy or the EIP-6492 validator. Pick the config that matches what is deployed. Since 2026-10-29 testnet has all three, so `config.testnet.json` works live. Mainnet still lacks the proxy and the validator (see [Contracts](#contracts-and-addresses)), so `config.json` and `config.mainnet.json` fail on live networks until the mainnet go.

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

If a contract or key is missing, the container exits with the reason. A missing contract shows as `Contract at address … does not exist`. An empty `FACILITATOR_*_PRIVATE_KEY` shows as `Invalid evm private key: invalid string length`. If every RPC stalls at startup, it exits after about 10 seconds with `error sending request for url (…)`. `docker compose logs facilitator` shows it, and the restart policy gives up after 5 tries instead of looping silently, so after an RPC outage at startup, start it again by hand.

The image, `hemi-x402-facilitator:e75adda-hemi.13`, is x402-rs at commit `e75adda` plus twenty-seven small patches, built locally from [`facilitator/Dockerfile`](facilitator/Dockerfile). The first `up` builds it. The build fetches x402-rs from GitHub, the crates from crates.io and the pinned `rust:1.93-trixie` image (about 2.2 GB), then compiles for 2 to 4 minutes on a 4-CPU machine. Add `--build` after changing a patch. Forks also need the Hemi public RPCs to be reachable.

Stock x402-rs does not return the x402 v2 spec's error shapes, and on a quiet Hemi it can send a settlement that is never mined. The patches fix both:

- **Signature first:** the payer's signature is checked before balance or allowance. A bad signature returns `invalid_exact_evm_payload_signature`; stock x402-rs gives HTTP 500 `unexpected_error`. This holds for plain wallets and for contract wallets. An EIP-1271 wallet is asked `isValidSignature`, and an EIP-6492 signature is checked with the EIP-6492 validator before anything is sent.
- **Error bodies:** they carry the real `payer` and `network`.
- **Permit2:** allowance is checked before balance, and both are re-checked on settle.
- **Replay:** a replay returns `invalid_transaction_state`.
- **Receipt timeout:** a settlement whose receipt doesn't arrive in time returns `settlement_pending` with its tx hash, instead of dropping the hash.
- **Wrong network:** an unsupported network returns `invalid_network`.
- **Exact amount:** a signed amount must equal the price; over- and under-payment return `invalid_exact_evm_payload_authorization_value_mismatch`.
- **Spec codes:** expired or early authorizations, recipient mismatch, wrong asset, malformed bodies and failed simulations return the spec's §9 codes. The one exception is a missing Permit2 allowance. Its code `permit2_allowance_required` comes from `scheme_exact_evm.md`, which spells it `PERMIT2_ALLOWANCE_REQUIRED`, not from §9. The TS reference SDK uses the same lowercase form, and the seller SDK turns it into a 412 to the buyer.
- **One settlement per authorization:** while a settle is pending, `/verify` of the same authorization is refused. A retry of the identical settle returns the same tx hash. The first retry after it is mined gets the success, and every later settle is a replay. One payment cannot pay for two requests.
- **Protocol version:** a missing or unsupported `x402Version` returns `invalid_x402_version`.
- **Permit2 spender:** a Permit2 payload whose spender is not the x402 exact proxy returns `invalid_payload`.
- **Client disconnects:** a settlement finishes even if the client hangs up, and its tx hash is logged once the node accepts the transaction. The record is kept, and an identical `/settle` retry gets `settlement_pending` with the hash while the tx is unmined. The first retry after it mines gets the success; later retries are replays. A stock seller always verifies before settling, and `/verify` refuses an authorization with a record. So only a client that calls `/settle` directly can claim a kept success. For a stock seller, see "Charged but not served" under [Limits](#limits-and-open-items).
- **Settlement tips:** a settlement tips at least the node's suggested priority fee, which is 0.001 gwei on both Hemi chains. After ten blocks without tips, stock x402-rs tips 1 wei. Hemi testnet's sequencer never mines that, and the stuck nonce would block every later settlement. Mainnet has mined tips as low as 21 wei, so there the floor is a precaution that costs about 1e-7 ETH per settlement (D-018). If the tip can't be read, the settlement fails before anything is sent, and a retry can follow. Only a node without the method keeps stock behaviour (D-021).
- **One broadcast per settlement:** a transaction goes to one RPC at a time, moving on only if that RPC can't be reached or doesn't answer within 10 seconds. Stock x402-rs sends a copy to every RPC, and the rejection of the second copy can make a mined settlement look failed.
- **A failed send is checked by its hash:** the facilitator signs first, so it knows the hash. After a failed send it asks each RPC for the transaction. A quick rejection of anything but a duplicate gets one lookup, and every other failure is searched for up to two blocks. If an RPC shows it, the settlement carries on from that hash instead of being reported as failed. Either way the hash is logged (D-020 to D-022).
- **HTTP status codes as the reference facilitator uses them:** 200 for every verdict on a readable request, `isValid: false`, `success: false` and `settlement_pending` included. 400 is only for a request that cannot be read; 500 for unexpected failures. A stock TS seller then receives the bare §9 code.

None of them changes where funds go. The exact-amount patch narrows what is accepted. [`facilitator/x402-rs/README.md`](facilitator/x402-rs/README.md) and D-016 explain each one. The unpatched stock image is kept, by digest, in a comment in `docker-compose.yml`.

[`facilitator/config.json`](facilitator/config.json) holds both chains, and [`config.testnet.json`](facilitator/config.testnet.json) and [`config.mainnet.json`](facilitator/config.mainnet.json) hold one each. Settings, all explained in D-013:

- **Scheme:** `v2-eip155-exact` on each chain. It accepts both EIP-3009 and Permit2 payloads. `/supported` lists `exact` per network; which transfer method a payment uses is set per asset by the seller's `extra.assetTransferMethod`.
- **RPCs:** dRPC first, the Hemi public RPC second, overridable with `HEMI_{TESTNET,MAINNET}_RPC_{PRIMARY,FALLBACK}`. x402-rs sends every read to all RPCs at once and takes the first answer, so for reads a dead or stalled RPC costs nothing as long as one answers (D-015). A transaction goes to one RPC at a time, starting with the best-ranked one (D-019). Every RPC request ends after 10 seconds, so a stalled best-ranked RPC adds about 10 seconds to a settlement. An RPC that stalls everything loses its rank after a few failed sends. How many depends on the load, because the fallback's throttle counts as latency in alloy's score. An RPC that stalls only sends keeps winning reads, so it keeps its rank, and each settlement pays those 10 seconds for as long as that lasts (D-021). Lookups after a failed send use their own clients, with an 8-second limit and no throttle; they are rare. The public RPC is throttled to 4 requests per second, under its ~300 per minute limit.
- **Signers:** one key per chain, `FACILITATOR_TESTNET_PRIVATE_KEY` and `FACILITATOR_MAINNET_PRIVATE_KEY`. The signer only pays gas. Run exactly one facilitator process per signer key, and don't use the key elsewhere while it runs. The nonce manager and the pending-settlement records live in that one process.
- **Reachability:** compose publishes the port on `127.0.0.1`, so only this machine can reach it. `/settle` has no authentication and the signer pays its gas, so anyone who can reach the port can spend that gas on valid payments of their own, such as paying themselves. A seller on another machine needs `FACILITATOR_BIND` set to a wider interface, and then authentication or rate limits in front of the facilitator, for example in a reverse proxy. This repo provides neither.
- **Receipt timeout:** 60 seconds. Hemi RPCs do stall (the brief's outage note), and if a broadcast tx has no receipt by then, `/settle` returns `settlement_pending` with the tx hash instead of losing it. A slow send shortens the wait, so that a send and its wait aim to take about 65 seconds, which leaves 25 of the seller SDK's 90 seconds for the checks before the send. That is a target, not a limit: reads and lookups run to their own limits once started. With every RPC slow, `/settle` has taken 83 to 96 seconds, and past 90 a stock seller gives up first. The hash is then in the facilitator's log (D-023). A read error during the wait can end it early, with the same `settlement_pending` answer. A retry then gets the outcome.

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
- **Counterfactual wallets (EIP-6492).** The same transfer or `settle` call is sent inside `Multicall3.aggregate3`, after the payer-supplied wallet factory call. That happens only once the EIP-6492 validator accepts the signature. The factory call runs as Multicall3, carries no value, and sets no recipient.
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

The seller SDK checks the facilitator's `/supported` at startup and refuses to serve a network the facilitator does not list. A rejected `/verify` comes back as HTTP 200 with `isValid: false`, as from the TS reference facilitator. The seller SDK's `onAfterVerify` hook sees it, and the buyer's 402 carries the bare §9 code. A missing Permit2 allowance becomes a 412 to the buyer. `tests/e2e/04c-stock-seller.test.ts` checks this with the stock seller engine. Keep the SDK's default facilitator timeout (90 s) or raise it. `/settle` can take 65 seconds or more plus its checks when RPCs stall, and a lower timeout can cut off a `settlement_pending` answer.

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

Both assets have settled live. On 2026-10-29 the contracts were deployed and a USDC.e payment settled through hemi.8, in [tx `0x0bca64a7…b6c5`](https://testnet.explorer.hemi.xyz/tx/0x0bca64a7f81d3472697852739ab6cb005ff5b08de82c727c997f7e137e3fb6c5). On 2026-11-01 an hBTC payment settled through hemi.9, in [tx `0x5f511cb0…fb0d`](https://testnet.explorer.hemi.xyz/tx/0x5f511cb01e0bae8d8f07707cb6056e2423a1cf4b533e343630bda57d505dfb0d). The same day both assets settled through hemi.13, the current image, in [`0xefd1da7d…df25`](https://testnet.explorer.hemi.xyz/tx/0xefd1da7d2f08c7f81c19fd8db2bd368e8ee4411e4b0e1fa80c3a564808badf25) and [`0x36682a86…ec6d`](https://testnet.explorer.hemi.xyz/tx/0x36682a866b72c26eed8aee6b5b88e07b1b05391476a7b6d3ed1a6ab44fc8ec6d), after earlier runs on hemi.10 to hemi.12. [docs/testnet-run.md](docs/testnet-run.md) has each receipt, the seller's verify-then-settle log and the buyer's output. With no flag, the script only checks balances and prints what to fund; it sends nothing:

```bash
scripts/testnet-run.sh
```

The run uses its own Compose project, so it cannot replace or stop a facilitator started with plain `docker compose`. With `--go`, it stops before sending anything if its facilitator or seller port is in use. It also stops before paying if the seller's `payTo`, network or facilitator differ from the run's.

It needs two funded wallets:

- **Facilitator/deployer:** about 0.001 testnet ETH. It deploys the three contracts (about 0.0000048 ETH in the `contracts/deploy.sh testnet` simulation) and pays settlement gas.
- **Buyer:** about 0.0001 ETH for its two one-time approvals, at least 0.001 USDC.e and at least 1 sat of hBTC.

Where the funds come from (D-017):

| Asset | Path | Wait |
|------|------|------|
| Testnet ETH | Ethereum Sepolia ETH from any Sepolia faucet, tunneled to Hemi testnet in the [Hemi Portal](https://app.hemi.xyz/en/tunnel/?networkType=testnet) | minutes |
| Testnet USDC.e `0xD479…6443` | Aave's Sepolia test USDC `0x94a9…E4C8`, which Aave's open faucet mints, tunneled to Hemi testnet. `scripts/testnet-fund-usdc.sh --go` does both from the buyer and needs about 0.001 Ethereum Sepolia ETH there. By hand: app.aave.com/faucet in testnet mode, then the Portal. Circle's Sepolia USDC is a different token and does not work. Or swap a little Hemi testnet ETH on Hemi testnet's Uniswap V3 WETH/USDC.e pool, which is how this buyer was funded (D-017) | minutes |
| Testnet hBTC `0x36Ab…fAe7` | Bitcoin **testnet3** coins from [coinfaucet.eu's testnet3 faucet](https://coinfaucet.eu/en/btc-testnet/), at least 0.01 BTC, deposited through the Portal's Bitcoin tunnel with UniSat set to "Bitcoin Testnet", then claimed | over an hour, plus the faucet claims |

For USDC.e, the funding script sends nothing without `--go`. Without a flag it checks the route on-chain and prints what is missing:

```bash
scripts/testnet-fund-usdc.sh
```

The Sepolia transactions need Ethereum Sepolia ETH; Hemi testnet ETH cannot pay for them. Without Sepolia ETH, use the swap; D-017 has the exact commands.

hBTC needs more care:

- **Network:** the tunnel watches Bitcoin testnet3. Many faucets now pay out testnet4, and those coins never reach the tunnel. Hemi's docs point to coinfaucet.eu.
- **Amounts:** the Portal's minimum deposit on testnet is 0.01 BTC, although Hemi's docs say 0.0001 BTC. The vault charges at least 10,000 sats per deposit. A faucet claim is smaller than 0.01 BTC, so several claims have to be pooled first. One payment needs 1 sat.
- **Claim:** after six Bitcoin confirmations, the depositor's EVM wallet must send the claim, `confirmDeposit`, from the Portal. Nothing is minted until it does, and it costs a little Hemi testnet ETH.
- **Reliability:** the testnet tunnel is barely used, but it worked for this repo: a 0.01 BTC deposit minted 990,000 sats on 2026-11-01. If a claim fails, Hemi's Discord is the fallback for a few sats.

Deposit to your own wallet and then send some hBTC to the buyer, or deposit to the buyer's address directly.

Then run:

```bash
scripts/testnet-run.sh --go
```

`ASSETS=usdc` or `ASSETS=btc` pays in one asset only. Each run appends its own section to `docs/testnet-run.md`.

In order, it:

1. deploys the three contracts on testnet and attempts explorer verification;
2. starts the facilitator with the testnet config and the seller;
3. pays once in USDC.e and once in hBTC;
4. writes the settlement tx hashes, linked on testnet.explorer.hemi.xyz, plus the seller's verify-then-settle log, to `docs/testnet-run.md`.

The script stops if either payment does not come back settled. That also tests D-015's claim that dRPC testnet's stale `eth_blockNumber` cannot delay receipts. If settlements come back `settlement_pending` instead, first check the earlier hash on the explorer; that payment may still mine. Then rerun with `HEMI_TESTNET_RPC_PRIMARY=https://testnet.rpc.hemi.network/rpc`. A rerun makes new payments, so fund the buyer for two.

## Mainnet deployment

The mainnet facilitator needs two contracts that do not exist on Hemi mainnet yet: the x402 exact proxy and the EIP-6492 validator. Permit2 is already there. Deploying them is the only mainnet transaction this project needs. The estimated cost is under 0.00001 ETH in total; see D-005 for the breakdown.

1. From a network that can reach explorer.hemi.xyz, cross-check the mainnet token addresses (Q-1 in DECISIONS.md) and record the output. The brief requires addresses checked on the explorer before use, and the spike machine could not reach it:
   ```bash
   curl -sS 'https://explorer.hemi.xyz/api/v2/tokens?q=USDC.e'
   curl -sS 'https://explorer.hemi.xyz/api/v2/tokens?q=hemiBTC'
   ```
   Then simulate. This sends nothing:
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
   It is reachable from this machine only. Read **Reachability** under [The facilitator](#the-facilitator) before setting `FACILITATOR_BIND`.
5. Start a seller that offers mainnet. It reads `SELLER_PAY_TO` from `.env`:
   ```bash
   SELLER_NETWORKS=eip155:43111 npm run start -w seller
   ```
6. Pay on mainnet. This spends real funds: 0.001 USDC.e, or 1 sat plus a one-time approval for hemiBTC. `BUYER_PRIVATE_KEY` must hold mainnet USDC.e; for `--asset btc` it must hold hemiBTC and a little ETH for the approval.
   ```bash
   ALLOW_MAINNET=yes npm run pay -w buyer -- --asset usdc --network mainnet
   ```

**Mainnet transactions run so far: none.** No mainnet tx hash exists yet. This section will carry the deployment and payment hashes once they run.

## Tests

```bash
npm test -w tests              # end-to-end on local forks, with dead primary RPCs
(cd contracts && forge test)   # deployment, codehash and settle-path tests on forks
```

The end-to-end suite starts both forks and the facilitator image from this repo. Both primary RPCs point at a dead port, so every test also exercises RPC failover, except files 08 and 09, which need two RPCs that answer. Every payload is built with the stock `@x402/evm` client. The suite covers:

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
- the stock TS seller engine against this facilitator: a buyer with a bad signature, no tokens or no allowance gets a 402 or 412 with the bare §9 code
- that the facilitator and the proxy never hold tokens
- that the dead primary really is dead inside the container
- that a settlement sent after ten tip-less blocks tips at least the node's suggested priority fee
- that a settlement is broadcast once when two RPCs are live
- that a stalled RPC neither holds a settlement nor loses one, whether it stalls before the send or after forwarding the transaction, and even if the first RPC to answer a lookup has not seen the transaction
- that a gateway's 502 after it forwarded the transaction is not reported as a failed settlement, whether or not the other RPC then rejects the copy
- that a rejected send, and a send no RPC can find, free the nonce for the next settlement, and that a failed tip read sends nothing

Latest results, from 2026-11-01 against a no-cache build of hemi.13:

| Suite | Result |
|------|------|
| `npm test -w tests` | 12 files, 112 tests passed, 0 failed (292 s) |
| `forge test` | 17 passed, 0 failed |
| `buyer/demo-fork.sh` | all four payments settled; payTo received exactly the price each time. Before patch 0022, hemi.9 settled all four in 20 of 20 runs |

## Definition of done

| Item | Status | Evidence |
|------|------|------|
| `docker compose up` starts the facilitator; `/supported` lists both networks with `exact` | Met on forks (`docker-compose.fork.yml`). Live on testnet with the testnet config, which lists `eip155:743111`. Both networks live need the mainnet contracts, which need the go | `tests/e2e/01-supported.test.ts`, D-013, D-016 |
| One `/verify` then `/settle` on testnet in USDC.e, tx linked on the explorer | Met: [`0x0bca64a7…b6c5`](https://testnet.explorer.hemi.xyz/tx/0x0bca64a7f81d3472697852739ab6cb005ff5b08de82c727c997f7e137e3fb6c5) | [docs/testnet-run.md](docs/testnet-run.md), `tests/e2e/02-settle.test.ts` |
| One settle on testnet in hemiBTC (hBTC, per D-008) | Met: [`0x5f511cb0…fb0d`](https://testnet.explorer.hemi.xyz/tx/0x5f511cb01e0bae8d8f07707cb6056e2423a1cf4b533e343630bda57d505dfb0d) | [docs/testnet-run.md](docs/testnet-run.md), `tests/e2e/02-settle.test.ts` |
| Failed signature and insufficient balance return the spec's error shapes, with tests | Met | `tests/e2e/03-bad-signature.test.ts`, `04-insufficient-balance.test.ts`, D-016 |
| Facilitator never holds funds, shown by reading the proxy and config | Met | [Why the facilitator never holds funds](#why-the-facilitator-never-holds-funds); balance and log checks in `02-settle.test.ts` |
| RPC failover: tests pass with the primary RPC on a dead port | Met | every e2e test except files 08 and 09 runs that way; `tests/e2e/05-rpc-failover.test.ts`, D-015. A stalled RPC is covered by `09-stalled-rpc.test.ts` |
| README covers spike, addresses, Permit2 approval, seller setup, mainnet steps and mainnet tx hash | Met; the mainnet hash is "none yet" | this file |
| DECISIONS.md has an entry, with command and output, for every verify item | Met | D-002 to D-012 |

## Limits and open items

- **Mainnet USDC.e and EIP-3009:** the testnet has no EIP-3009 token, so that path is proven only on a local fork of mainnet until a mainnet payment runs.
- **Explorer verification:** expected to be a partial match at best for the proxy, because its original build embedded metadata (`contracts/README.md`).
- **Mainnet explorer:** blocked from the machine that ran the spike. Mainnet token addresses rest on Hemi's token list and on-chain reads (D-002, Q-1).
- **Combined failures:** when one payload fails several checks, the code reported follows the TS reference facilitator, not the order written in `scheme_exact_evm.md`. Checks that need no RPC (recipient, validity window, exact amount, token, Permit2 spender) run before the allowance and balance reads. So an expired payment from an unfunded payer gets `…_valid_before`, not `insufficient_funds`. Single-failure cases, which the Definition of done covers, return the spec's code. `tests/e2e/04b-payload-checks.test.ts` ("combined failures") pins the behaviour. [`facilitator/x402-rs/README.md`](facilitator/x402-rs/README.md) ("Check order") cites the reference line by line and lists the two places this facilitator differs from it.
- **Nonce gap after a timeout:** after `settlement_pending`, the facilitator keeps that tx's nonce, so a tx that may still mine is never replaced. If the tx is later dropped from every mempool, retries keep answering `settlement_pending` with the dead hash, because nothing rebroadcasts it, and later settles on that chain queue behind the gap. Settlement on that chain stops until a restart, which re-reads the nonce from the chain. After a restart, one settlement can still fail with "nonce too low" for each queued tx that mines. Each such failure takes about 27 seconds, because the transaction is searched for first, and it costs nothing. The next settlement succeeds.
- **Nonce gap during a search:** while a failed send is searched for, its nonce stays taken, for about 25 seconds. Settlements that arrive then use later nonces. If the search finds nothing, they stay queued until a later settlement fills the gap. They answer `settlement_pending`, and a stock seller refuses them, so the buyer can be charged later and not served. It takes every RPC losing a send, plus traffic in that window.
- **Charged but not served:** this happens in three ways. A settle can go `settlement_pending` while the stock seller's single automatic retry is also still pending. The seller can time out or disconnect from `/settle` after the tx was broadcast. Or a send can count as failed while a node holds the tx (see **Ambiguous broadcast**). In each case the seller refuses the request, the payment can still mine, and the buyer is charged without being served. Resending the same payment header gets a 402 while the facilitator holds the record, up to 15 minutes, and a replay error after that. To reconcile, use the tx hash from the seller's log (`settlement_pending` answers) or the facilitator's log, which has every send, including failed ones.
- **Missing Permit2 allowance is HTTP 200:** `scheme_exact_evm.md` Permit2 step 2 says the verifier returns `412 Precondition Failed`. This facilitator answers 200 with `permit2_allowance_required`, as the TS reference facilitator does. The stock seller SDK then answers the buyer 412. This is a deliberate deviation from the scheme text (D-016, 0018).
- **Ambiguous broadcast:** a send that no node answered, whether by a timeout, a dropped connection or a gateway's 5xx, is looked up on each RPC for about two blocks. If no RPC shows the transaction in that time, for instance because they all take over 8 seconds to answer, the facilitator treats the send as failed, although a node may still hold it and it can still mine. A quick JSON-RPC error other than `already known` or `nonce too low` counts as a node's rejection and gets one lookup, so a gateway that forwards a transaction and then answers with such an error has the same effect. Either way the facilitator resets the nonce and answers with no hash: `unexpected_settle_error`, or `invalid_transaction_state` once the tx has mined. The hash is in the log, and the payer's nonce still prevents a double charge.
- **Single broadcast:** a transaction reaches only the first RPC that answers. If that node accepts it and never forwards it, no other RPC holds a copy, and the settle ends in `settlement_pending`. Sending to both RPCs would have hidden that, but nothing recovers it now: see **Nonce gap after a timeout**. If that node rejects it, the rejection stands, even if the other RPC would have taken it. Sending to both RPCs was worse: a mined settlement could be reported as failed (D-019).
- **An RPC that answers with errors:** failover covers an RPC that is dead or silent, not one that answers. A JSON-RPC error counts as an answer, and it can win a read's race. A primary answering every read with an error makes `/verify` and `/settle` fail with 500 while the fallback is fine, and it keeps its rank. No funds move, because the payment fails before any broadcast.
- **No authentication:** anyone who can reach the facilitator can spend its signer's gas on valid payments of their own. The default binding is loopback for that reason, and a wider one needs authentication or rate limits in front of it. See **Reachability** under [The facilitator](#the-facilitator).
- **Record eviction:** records that outlive their settlement are capped at 10,000, and the oldest goes when another is kept. Only a settlement that broadcast a transaction can push one out, so a flood of rejected requests cannot. An eviction drops the `/verify` block and any kept success. The on-chain nonce still prevents a double charge.
- **Records before checks:** a settle's record is created before its request is checked, so that two settles can never race. A request with someone else's payer and nonce therefore blocks that authorization while its own checks run. It needs that payer's nonce, and the block ends when the request is rejected.
- **Timeouts in front of `/settle`:** a proxy or client timeout on `/settle` should be at least 90 seconds. With stalled RPCs a settle can take 65 seconds or more plus its checks, and with a shorter timeout the hash won't come back in the response. The facilitator logs the hash of every send. After a client hangs up, the settlement keeps running. A retry while it is still waiting for the receipt gets `invalid_transaction_state` ("in progress"). Once it ends, the first identical retry gets the hash.
- **Facilitator memory:** pending-settlement records live in memory. A facilitator restart forgets them, after which a pending authorization is judged by the chain alone.
- **Verify-then-settle race:** two requests carrying the same payment header that both pass `/verify` before either settles can both reach the seller's handler; only one settle succeeds. This is inherent to the x402 verify, handler, settle flow, not specific to this facilitator.
- **EIP-6492 deployment path:** a counterfactual wallet that is deployed during settle is untested end to end. The forks have no wallet factory, so only rejection and the plain-wallet shortcut are tested.
- **Phase 2:** paying in Bitcoin L1 and verifying through hBK is not started (D-012).
