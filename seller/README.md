# seller

A minimal x402 v2 seller for Hemi. One paid route, `GET /echo` ($0.001), which returns the query string and a timestamp, plus an unpaid `GET /health`. It uses the x402 TypeScript server SDK (`@x402/express` and `ExactEvmScheme` from `@x402/evm/exact/server`) and sends every `/verify` and `/settle` to the facilitator at `FACILITATOR_URL`. The seller never signs or sends a transaction.

It can also take native BTC on Bitcoin L1 (`exact` on `bip122:*`, see [the scheme spec](../docs/specs/scheme_exact_bip122.md) and "Bitcoin L1" below). That needs a facilitator whose `/supported` lists the bip122 kinds.

```sh
SELLER_PAY_TO=0xYourAddress npm run start -w seller
curl -i 'http://localhost:4021/echo?hello=hemi'     # 402 with a PAYMENT-REQUIRED header
```

`npm run start` also loads the repo-root `.env` if it exists. Variables already set in the shell win.

| Variable | Default | Meaning |
|------|------|------|
| `SELLER_PAY_TO` | required | Address that receives the payments |
| `FACILITATOR_URL` | `http://localhost:8080` | The facilitator; see "Run it" in the root README for the fork recipe and the per-network configs |
| `SELLER_NETWORKS` | `eip155:743111` | Comma-separated networks to accept; add `eip155:43111` for mainnet (`testnet` and `mainnet` also work) |
| `SELLER_BTC_AMOUNT` | `1` | Price in the BTC asset on Hemi (hemiBTC, hBTC), in satoshis. 1 sat is about $0.001 at ~$100k/BTC |
| `PORT` | `4021` | Listen port |
| `SELLER_BTC_NETWORKS` | empty (off) | Bitcoin L1 networks to accept native BTC on: `btc-mainnet`, `btc-testnet3`, or the `bip122:…` ids |
| `SELLER_BTC_XPUB` | required with the above | The account extended public key payments are derived from: `xpub…` for mainnet, `tpub…` for testnet3; comma-separate one of each for both |
| `SELLER_BTC_AMOUNT_SATS` | `1000` | Price on Bitcoin L1, in satoshis; at least the dust limit (294 for p2wpkh, 330 for p2tr) |
| `SELLER_BTC_MIN_CONFIRMATIONS` | `1` | Bitcoin confirmations the facilitator must see before it settles |
| `SELLER_BTC_ADDRESS_TYPE` | `p2wpkh` | `p2wpkh` or `p2tr` (BIP86 key path) |
| `SELLER_BTC_MAX_TIMEOUT_SECONDS` | `3600` | How long the buyer is told to keep polling; at least 600 |

With `SELLER_NETWORKS` set to empty the seller takes Bitcoin L1 only and `SELLER_PAY_TO` is not needed. The seller validates every Bitcoin setting at startup and exits with the reason, for example `SELLER_BTC_XPUB for btc-testnet3 (bip122:000000000933ea01ad0ee984209779ba): payTo must be a tpub key on Bitcoin testnet3, got "xpub…" (xpub is for the other Bitcoin network)`. A `zpub`/`vpub` is refused with a hint: the scheme takes the same key with `xpub`/`tpub` version bytes.

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

## Bitcoin L1

Each network in `SELLER_BTC_NETWORKS` adds one accept after the Hemi ones (from a local run against a stub facilitator):

```json
{
  "scheme": "exact",
  "network": "bip122:000000000019d6689c085ae165831e93",
  "amount": "1000",
  "asset": "BTC",
  "payTo": "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V",
  "maxTimeoutSeconds": 3600,
  "extra": {
    "assetTransferMethod": "utxo",
    "paymentFlow": "upfront",
    "addressType": "p2wpkh",
    "minConfirmations": 1,
    "paymentId": "1d15aac3875c11e289a6bfd366892b14"
  }
}
```

`ExactBtcServerScheme` from `@hemi-x402/btc` (registered once per Bitcoin network) adds a fresh random `paymentId` to every 402. The buyer pays to the address derived from `payTo` and that `paymentId` (`m/0/i1/i2/i3` below the xpub, three indices from one hash of the paymentId), so every payment lands on its own address of the seller's wallet. Only someone who saw the 402 knows which address belongs to which payment. The path is random, so a wallet's gap-limit scan will not find these addresses: the seller must keep each settled `paymentId` (the settle log line prints it with the path) to derive the key that spends the funds, `<account xprv>/0/i1/i2/i3`.

The flow is `upfront`: the middleware does not call `/verify`. It calls `/settle` before the handler, and the facilitator checks the Bitcoin output through hBK on Hemi and records it as consumed in a Hemi contract. A payment that is not confirmed yet comes back to the buyer as 402 with `invalid_exact_bip122_payload_unconfirmed` (or `…_transaction_not_found` while hVM has not seen it), and the buyer re-sends the same payment until it settles. A settled payment presented again gets 402 `invalid_transaction_state`. The log line names the Bitcoin transaction, and `payer` is `n/a` because a Bitcoin payment has no single payer address:

```
[seller] settled 1000 of BTC on bip122:000000000933ea01ad0ee984209779ba from n/a: bitcoin tx 14ac11c1…be2a (https://mempool.space/testnet/tx/14ac11c1…be2a); paymentId 12299bf16423f9d28a81192788817d17 -> tb1qd66456etpcrsvpz0pngzugtdumwe3qter8jgjd at tpubDC8msFGe…/0/1047695828/689587608/564264336
```

The handler runs once per settled payment. A Hemi reorg before PoP finality could in principle drop the consumed mark, so a handler that delivers something valuable should also be idempotent per `paymentId` (the scheme spec's "Security considerations").

