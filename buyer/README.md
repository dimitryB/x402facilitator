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
[buyer] paying 1000 base units of USDC.e (0xD47971C7F5B1067d25cd45d30b2c9eb60de96443) on eip155:743111 to 0x15d3…6A65 via permit2
[buyer] approve(Permit2, max) sent: 0x475d…7c3a
[buyer]   https://testnet.explorer.hemi.xyz/tx/0x475d…7c3a
[buyer] asset:    USDC.e 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 (eip155:743111)
[buyer] response: {"echo":{"demo":"fork","network":"testnet","asset":"usdc"},"timestamp":"2026-10-29T02:21:12.313Z"}
[buyer] tx:       0xae65…72c6
[buyer] explorer: https://testnet.explorer.hemi.xyz/tx/0xae65…72c6
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
# if the public Hemi RPCs rate-limit the forks:
FORK_TESTNET_UPSTREAM=https://hemi-testnet.drpc.org FORK_MAINNET_UPSTREAM=https://hemi.drpc.org buyer/demo-fork.sh
```

Ports and names can be overridden: `FORK_TESTNET_PORT` (28545), `FORK_MAINNET_PORT` (28546), `FACILITATOR_PORT` (28080), `SELLER_PORT` (24021), `DEMO_PROJECT` (compose project, `hemi-x402-demo`), `FORK_STATE_DIR` (`.scratch/fork-demo`), `DEMO_PAY_TO`.
