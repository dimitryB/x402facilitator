# seller

A minimal x402 v2 seller for Hemi. One paid route, `GET /echo` ($0.001), which returns the query string and a timestamp, plus an unpaid `GET /health`. It uses the x402 TypeScript server SDK (`@x402/express` and `ExactEvmScheme` from `@x402/evm/exact/server`) and sends every `/verify` and `/settle` to the facilitator at `FACILITATOR_URL`. The seller never signs or sends a transaction.

```sh
SELLER_PAY_TO=0xYourAddress npm run start -w seller
curl -i 'http://localhost:4021/echo?hello=hemi'     # 402 with a PAYMENT-REQUIRED header
```

`npm run start` also loads the repo-root `.env` if it exists. Variables already set in the shell win.

| Variable | Default | Meaning |
|------|------|------|
| `SELLER_PAY_TO` | required | Address that receives the payments |
| `FACILITATOR_URL` | `http://localhost:8080` | The facilitator (`docker compose up` at the repo root) |
| `SELLER_NETWORKS` | `eip155:743111` | Comma-separated networks to accept; add `eip155:43111` for mainnet (`testnet` and `mainnet` also work) |
| `SELLER_BTC_AMOUNT` | `1` | Price in the BTC asset, in satoshis. 1 sat is about $0.001 at ~$100k/BTC |
| `PORT` | `4021` | Listen port |

## What it advertises

Each network in `SELLER_NETWORKS` gets two `accepts` entries, in this order:

| Network | Asset | Amount | `extra` |
|------|------|------|------|
| `eip155:743111` | USDC.e `0xD479…6443` | `1000` (6 decimals, $0.001) | `{"assetTransferMethod":"permit2"}` |
| `eip155:743111` | hBTC `0x36Ab…fAe7` | `SELLER_BTC_AMOUNT` | `{"assetTransferMethod":"permit2"}` |
| `eip155:43111` | USDC.e `0xad11…5afA` | `1000` | `{"assetTransferMethod":"eip3009","name":"Bridged USDC (Stargate)","version":"2"}` |
| `eip155:43111` | hemiBTC `0xAA40…ef28` | `SELLER_BTC_AMOUNT` | `{"assetTransferMethod":"permit2"}` |

Addresses, transfer methods and the EIP-712 domain come from `@hemi-x402/shared` (DECISIONS.md D-001, D-007, D-008). Prices are explicit `{ asset, amount, extra }` objects because Hemi is not in the SDK's default asset table, so a `"$0.001"` price string does not resolve on Hemi with the stock SDK.

In x402 v2 the requirements travel base64-encoded in the `PAYMENT-REQUIRED` response header; the 402 body is only `{"error":"Payment required"}`. To read them:

```sh
curl -si 'http://localhost:4021/echo' | sed -n 's/^PAYMENT-REQUIRED: //Ip' | tr -d '\r' | base64 -d | jq .accepts
```

## Payment flow

The middleware verifies the `PAYMENT-SIGNATURE` header with the facilitator before the handler runs, and settles after the handler returns a status below 400. The buyer gets the settlement receipt in the `PAYMENT-RESPONSE` header. The seller logs every settlement:

```
[seller] settled 1000 of 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 on eip155:743111 from 0x90F7…b906: tx 0xae65…72c6
```

The facilitator's `/supported` must list every network in `SELLER_NETWORKS`. The SDK reads it at startup, and if a configured network is missing the seller exits with a `RouteConfigurationError` (`missing_facilitator`). If the facilitator is unreachable at startup, the SDK retries on the first paid request.
