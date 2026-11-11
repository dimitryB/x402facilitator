# buyer

A script that pays the demo seller's `GET /echo` with `@x402/fetch` (`wrapFetchWithPayment`, `x402Client` and `ExactEvmScheme` from `@x402/evm/exact/client`), in one asset on one Hemi network, and prints the settlement transaction. With `--asset btc-l1` it pays native BTC on Bitcoin L1 instead (see "Paying in BTC on Bitcoin L1" below).

```sh
npm run pay -w buyer -- --asset usdc --network testnet
npm run pay -w buyer -- --asset btc  --network testnet
ALLOW_MAINNET=yes npm run pay -w buyer -- --asset usdc --network mainnet
npm run pay -w buyer -- --asset btc-l1 --network btc-testnet3        # native BTC on Bitcoin L1, see below
```

`npm run pay` also loads the repo-root `.env` if it exists. Variables already set in the shell win.

| Option / variable | Default | Meaning |
|------|------|------|
| `--asset` | `usdc` | `usdc` (USDC.e), `btc` (hemiBTC on mainnet, hBTC on testnet) or `btc-l1` (native BTC on Bitcoin L1) |
| `--network` | `testnet` | `testnet` (`eip155:743111`) or `mainnet` (`eip155:43111`); with `btc-l1`, `btc-mainnet` or `btc-testnet3` |
| `--url` / `SELLER_URL` | `http://localhost:4021/echo?hello=hemi` | The paid resource |
| `--max` | `10000` for usdc, `10` for btc | Largest payment the buyer will sign, in base units (about $0.01) |
| `BUYER_PRIVATE_KEY` | required | The paying wallet |
| `BUYER_RPC_URL` | dRPC, then the Hemi public RPC | RPC for balance reads and the Permit2 approval |
| `ALLOW_MAINNET` | unset | Must be `yes` for `--network mainnet`; otherwise the script refuses |

The wallet needs the token. For a Permit2 asset (every asset except mainnet USDC.e, see DECISIONS.md D-001) it also needs a little ETH on Hemi, once: before the first payment the script reads the wallet's allowance to Permit2 (`getPermit2AllowanceReadParams`) and, if it is below the price, sends `approve(Permit2, max)` (`createPermit2ApprovalTx`) and prints that transaction's hash. That approval is the only transaction the buyer ever sends. The payment itself is an off-chain signature; the facilitator submits it and pays the gas. Mainnet USDC.e uses EIP-3009 and needs no ETH and no approval.

Output, from a run against the local forks:

```
[buyer] buyer 0x90F79bf6EB2c4f870365E785982E1f101E93b906 holds 1000 USDC.e
[buyer] GET http://localhost:24021/echo?demo=fork&network=testnet&asset=usdc
[buyer] paying 1000 base units of USDC.e (0xD47971C7F5B1067d25cd45d30b2c9eb60de96443) on eip155:743111 to 0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 via permit2
[buyer] approve(Permit2, max) sent: 0x877b4fc3a6358a8b0c2bcbe982f651f8fa63e11459c8ac469fb7b77caecb72d9
[buyer]   https://testnet.explorer.hemi.xyz/tx/0x877b4fc3a6358a8b0c2bcbe982f651f8fa63e11459c8ac469fb7b77caecb72d9  (local fork: not on the explorer)
[buyer] asset:    USDC.e 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 (eip155:743111)
[buyer] response: {"echo":{"demo":"fork","network":"testnet","asset":"usdc"},"timestamp":"2026-10-29T03:51:30.459Z"}
[buyer] tx:       0x14796f03f3787976cb9b042bdac2e11eaeac5e099aad0e219f9495feb545a1b3
[buyer] explorer: https://testnet.explorer.hemi.xyz/tx/0x14796f03f3787976cb9b042bdac2e11eaeac5e099aad0e219f9495feb545a1b3  (local fork: not on the explorer)
[buyer] buyer balance: 1000 USDC.e -> 999.999 USDC.e
[buyer] payTo balance: 0 USDC.e -> 0.001 USDC.e
```

## How the asset is chosen

The seller offers USDC.e and the BTC asset on each of its networks. The script narrows that list with SDK hooks, not by hand:

- `setSpendControls({ allowedAssets: [...] })` allow-lists the requested Hemi token with a per-payment cap. Without it the SDK rejects every Hemi asset, because by default it only pays assets in its own default table.
- `registerPolicy(...)` keeps only the accepts entry for the requested asset and network. The default selector then takes it.
- `onBeforePaymentCreation(...)` sees the chosen requirements; the script uses it to record payTo's starting balance and to run the Permit2 approval check.

The settlement receipt comes back base64-encoded in the `PAYMENT-RESPONSE` header and is read with `decodePaymentResponseHeader`.

## End-to-end demo on local forks

`buyer/demo-fork.sh` sends nothing to a live network. It starts anvil forks of both chains (`scripts/fork.sh`), the facilitator (`docker compose`) pointed at them, and the seller on both networks; then it makes five payments (USDC.e and the BTC asset on each fork, then native BTC on Bitcoin L1, fabricated in the mock hBK on the mainnet fork), prints payTo's balances on each fork, and tears everything down. It uses public anvil dev keys only.

```sh
buyer/demo-fork.sh
```

The forks are pinned to the same blocks as the e2e tests (`FORK_BLOCK_TESTNET`, `FORK_BLOCK_MAINNET`). That makes runs reproducible. It also lets `scripts/fork.sh` retry on dRPC if the public Hemi RPC rate-limits a fork at startup. Don't point an unpinned testnet fork at dRPC: its `eth_blockNumber` lags by over a million blocks (DECISIONS.md D-015).

Transactions in this demo exist only on the local forks. The buyer prints their explorer links marked "(local fork: not on the explorer)".

Ports and names can be overridden: `FORK_TESTNET_PORT` (28545), `FORK_MAINNET_PORT` (28546), `FACILITATOR_PORT` (28080), `SELLER_PORT` (24021), `DEMO_PROJECT` (compose project, `hemi-x402-demo`), `FORK_STATE_DIR` (`.scratch/fork-demo`), `DEMO_PAY_TO`.

## Paying in BTC on Bitcoin L1

`--asset btc-l1` pays the seller's `bip122` accept (see [the scheme spec](../docs/specs/scheme_exact_bip122.md)) with a real Bitcoin transaction to an address derived from the seller's xpub and the 402's `paymentId`, then polls until the facilitator has verified it through hBK on Hemi and the seller serves the resource.

```sh
BUYER_BTC_MNEMONIC="…" npm run pay -w buyer -- --asset btc-l1 --network btc-testnet3
BUYER_BTC_WIF=L… ALLOW_MAINNET=yes npm run pay -w buyer -- --asset btc-l1 --network btc-mainnet --fee-rate 4
npm run pay -w buyer -- --asset btc-l1 --network btc-mainnet --resume 12299bf16423f9d28a81192788817d17
```

| Option / variable | Default | Meaning |
|------|------|------|
| `--network` | `btc-testnet3` | `btc-testnet3` or `btc-mainnet` |
| `--max` | `5000` | Largest payment the buyer will make, in satoshis |
| `--poll` | `60` | Seconds between re-sends of the payment |
| `--resume` | unset | A paymentId from the journal: poll with that payment again, pay nothing |
| `--fee-rate` | mempool.space 3-block estimate | Miner fee in sat/vB; the wallet refuses estimates above 200 |
| `BUYER_BTC_WIF` / `BUYER_BTC_MNEMONIC` | one required | The paying wallet: a WIF of the network, or a BIP39 mnemonic (first receive address, `m/84'/coin'/0'/0/0`, or `m/86'/…` for p2tr) |
| `BUYER_BTC_ADDRESS_TYPE` | `p2wpkh` | The wallet's own address type: `p2wpkh` or `p2tr` |
| `BUYER_BTC_ESPLORA` | `https://mempool.space/api` (per network) | Another Esplora REST base for UTXOs, fee estimates and the broadcast, for when mempool.space is unreachable, e.g. `https://mempool.emzy.de/api`. Printed links still point at mempool.space |
| `ALLOW_MAINNET` | unset | Must be `yes` for `--network btc-mainnet` |

Before a live payment, run the read-only preflight. It checks that `SELLER_BTC_XPUB` parses for the network and derives a sample address from it, then prints the buyer wallet's address, its balance, the fee rate, and whether the funds cover `SELLER_BTC_AMOUNT_SATS` plus the fee. It reads `.env`, prints public data only, and sends nothing:

```sh
npm run preflight-btc -w buyer                  # btc-mainnet
npm run preflight-btc -w buyer -- btc-testnet3
```

The wallet spends confirmed UTXOs of its one address, largest first, and sends change back to the same address. It reads UTXOs and fee estimates from mempool.space and broadcasts there; that broadcast is the only thing it ever sends.

The flow is driven by hand rather than with `wrapFetchWithPayment`. That wrapper builds a new payment for every 402, and a Bitcoin payment is accepted only after it confirms and hVM has seen its block: about 30 minutes on mainnet (roughly three Bitcoin confirmations), possibly hours on testnet3, where hVM lags. So the script:

1. sends one `GET`, decodes the 402, keeps the `bip122` accept for `--network` (`registerPolicy`) and allow-lists `BTC` with the `--max` cap (`setSpendControls`);
2. calls `createPaymentPayload` once. `ExactBtcClientScheme` derives the address, claims the paymentId with an exclusive file in `.scratch/buyer-btc/journal.jsonl.claims/` (so two buyer processes cannot both pay it), writes the payment to `.scratch/buyer-btc/journal.jsonl` as `paying`, broadcasts, and records it as `paid` with the txid. A payment journaled as `paying` but never `paid` is never retried automatically: check the wallet first;
3. re-sends the same `PAYMENT-SIGNATURE` every `--poll` seconds while the seller answers 402 with `invalid_exact_bip122_payload_unconfirmed`, `invalid_exact_bip122_payload_transaction_not_found` or `settlement_pending`. Any other reason stops it, and so does the accept's `maxTimeoutSeconds`. The payment stays in the journal, so `--resume <paymentId>` picks it up later.

Output against a stub facilitator that answers "unconfirmed" twice (`--stub-pay fake`, below):

```
[buyer] --stub-pay fake: nothing is sent to Bitcoin; the txid is random
[buyer] GET http://127.0.0.1:44021/echo?hello=btc-l1
[buyer] paying 1000 sats on Bitcoin testnet3 to tb1qd66456etpcrsvpz0pngzugtdumwe3qter8jgjd (paymentId 12299bf16423f9d28a81192788817d17, tpubDC8msFGe…/0/1047695828/689587608/564264336)
[buyer]   needs 1 confirmation(s); seller waits up to 3600s
[buyer] bitcoin tx: 14ac11c1fac4fe1199750f84dbec631d11ae749d704a7ea86a00c4f20275be2a vout 0
[buyer]   (stub payment: not on Bitcoin)
[buyer] journal: …/.scratch/buyer-btc/journal.jsonl (resume with --resume 12299bf16423f9d28a81192788817d17)
[buyer] attempt 1: not yet: invalid_exact_bip122_payload_unconfirmed
[buyer] attempt 2: not yet: invalid_exact_bip122_payload_unconfirmed
[buyer] response: {"echo":{"hello":"btc-l1"},"timestamp":"2026-11-09T17:54:03.467Z"}
[buyer] settled on bip122:000000000933ea01ad0ee984209779ba: bitcoin tx 14ac11c1fac4fe1199750f84dbec631d11ae749d704a7ea86a00c4f20275be2a
[buyer] hemi settle tx: not in the response (the facilitator logs it; see the settler's Settled event)
```

Resuming that payment after it was served gets `seller answered 402 (invalid_transaction_state)`: a payment buys one response.

### Development stubs

`--stub-pay` replaces the wallet; nothing goes to Bitcoin.

- `--stub-pay fake` returns a random txid. Only a stub facilitator accepts it (`btc/dev/stub-facilitator.ts`, which answers from a script and reads no chain).
- `--stub-pay http://127.0.0.1:<port>` writes a fabricated transaction paying the derived address into the mock hBK on that local Hemi fork (`@hemi-x402/btc/mock-hbk`; it refuses any non-local URL). The real facilitator then verifies and settles it on the fork. `BUYER_BTC_STUB_HBK` overrides the hBK address from `shared/hemi.json`, and `BUYER_BTC_STUB_CONFIRMATIONS` (default 1) sets the recorded Bitcoin confirmations. `buyer/demo-fork.sh` uses this for its fifth payment.

