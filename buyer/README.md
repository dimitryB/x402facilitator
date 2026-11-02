# buyer

A script that pays the demo seller's `GET /echo` with `@x402/fetch` (`wrapFetchWithPayment`, `x402Client` and `ExactEvmScheme` from `@x402/evm/exact/client`), in one asset on one Hemi network, and prints the settlement transaction.

```sh
npm run pay -w buyer -- --asset usdc --network testnet
npm run pay -w buyer -- --asset btc  --network testnet
ALLOW_MAINNET=yes npm run pay -w buyer -- --asset usdc --network mainnet
```

`npm run pay` also loads the repo-root `.env` if it exists. Variables already set in the shell win.

| Option / variable | Default | Meaning |
|------|------|------|
| `--asset` | `usdc` | `usdc` (USDC.e) or `btc` (hemiBTC on mainnet, hBTC on testnet) |
| `--network` | `testnet` | `testnet` (`eip155:743111`) or `mainnet` (`eip155:43111`) |
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

`buyer/demo-fork.sh` sends nothing to a live network. It starts anvil forks of both chains (`scripts/fork.sh`), the facilitator (`docker compose`) pointed at them, and the seller on both networks; then it makes the four payments (testnet and mainnet fork, USDC.e and BTC asset), prints payTo's balances on each fork, and tears everything down. It uses public anvil dev keys only.

```sh
buyer/demo-fork.sh
```

The forks are pinned to the same blocks as the e2e tests (`FORK_BLOCK_TESTNET`, `FORK_BLOCK_MAINNET`). That makes runs reproducible. It also lets `scripts/fork.sh` retry on dRPC if the public Hemi RPC rate-limits a fork at startup. Don't point an unpinned testnet fork at dRPC: its `eth_blockNumber` lags by over a million blocks (DECISIONS.md D-015).

Transactions in this demo exist only on the local forks. The buyer prints their explorer links marked "(local fork: not on the explorer)".

Ports and names can be overridden: `FORK_TESTNET_PORT` (28545), `FORK_MAINNET_PORT` (28546), `FACILITATOR_PORT` (28080), `SELLER_PORT` (24021), `DEMO_PROJECT` (compose project, `hemi-x402-demo`), `FORK_STATE_DIR` (`.scratch/fork-demo`), `DEMO_PAY_TO`.
