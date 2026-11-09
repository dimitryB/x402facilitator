# Scheme: `exact` on Bitcoin L1 (`bip122`), verified through Hemi's hBK

## Summary

This document specifies the x402 `exact` payment scheme for native BTC on the Bitcoin base layer, using the `bip122` CAIP-2 namespace. The client pays an ordinary Bitcoin transaction to an address derived from the resource server's account extended public key (`payTo`) and a random per-challenge `extra.paymentId`, and sends the transaction id and output index. The facilitator does not run a Bitcoin node or trust an oracle: it reads the output and its confirmation count through hBK, the Bitcoin view built into Hemi's EVM (hVM), inside a Hemi contract, and records the output as consumed in that contract with one Hemi transaction.

The scheme supports only the `utxo` asset transfer method and the `upfront` payment flow. The resource server processes the request only after `/settle` succeeds. Because a Bitcoin payment becomes verifiable one block after inclusion at the earliest, the client re-sends the same payload until the facilitator accepts it.

It targets x402 protocol version 2 and uses the core `PaymentRequirements`, `PaymentPayload` and `SettlementResponse` types of `x402-specification-v2.md`. Its structure follows the Lightning scheme, [`specs/schemes/exact/scheme_exact_lnbtc.md`](https://github.com/x402-foundation/x402/blob/ac01018697d854721b16e5b43504c41e87522a3e/specs/schemes/exact/scheme_exact_lnbtc.md) of x402-foundation/x402, which is the precedent for `asset: "BTC"`, a settle-only `upfront` flow, a dynamic `extra` field per challenge, and a replay record keyed by network and payment.

The reference implementation is this repository: `btc/` (`@hemi-x402/btc`: derivation, `ExactBtcServerScheme`, `ExactBtcClientScheme`, a demo wallet), `seller/`, `buyer/btc-l1.ts`, the facilitator crate `x402-chain-bip122`, and the contract `X402BtcSettler`.

## Use Cases

- **Agents that hold bitcoin and nothing else.** An agent with a Bitcoin wallet pays an API in BTC without bridging, wrapping or holding gas on another chain.
- **Larger or less frequent purchases.** Bitcoin fees and block times make this unsuitable for sub-cent calls. It fits a report, a dataset, a batch of credits, an account top-up: anything worth a few dollars or more where 10 to 60 minutes to first access is acceptable.
- **Sellers who want BTC on L1 without running Bitcoin infrastructure.** The seller publishes an xpub. It needs no node, no Lightning channels and no watcher: the facilitator checks payments through Hemi.
- **Not for:** sub-second or sub-cent payments (use an EVM `exact` scheme or Lightning), or flows that must refund (Bitcoin has none).

## Scheme and Networks

The `bip122` namespace reference is the first 32 lowercase hex characters of the Bitcoin network's genesis block hash ([CAIP-4](https://namespaces.chainagnostic.org/bip122/caip2)).

| Network | CAIP-2 id | `payTo` prefix | Address hrp | Verified on |
|------|------|------|------|------|
| Bitcoin mainnet | `bip122:000000000019d6689c085ae165831e93` | `xpub` | `bc` | Hemi mainnet (`eip155:43111`) |
| Bitcoin testnet3 | `bip122:000000000933ea01ad0ee984209779ba` | `tpub` | `tb` | Hemi testnet (`eip155:743111`) |

- `scheme` MUST be `"exact"`.
- `asset` MUST be `"BTC"`.
- Messages on the wire MUST use one of these concrete network ids.
- A facilitator lists each network it serves as a `/supported` kind. Its `extra` SHOULD carry `asset`, `assetTransferMethod`, `paymentFlow`, `addressTypes` (the address types it can verify), `minConfirmations` (its policy as `{ default, floor, ceiling }`), the settler contract address and the Hemi network, so a resource server can check its configuration at startup.

## Asset Transfer Method and Payment Flow

`"utxo"` is the only asset transfer method. `extra.assetTransferMethod` MAY be omitted and then means `"utxo"`; any explicit value MUST be `"utxo"`.

`"upfront"` is the only payment flow, because the payment exists on Bitcoin before the request is served. The resource server MUST set `extra.paymentFlow` to `"upfront"`. Clients and resource servers MUST reject any other value.

The sequence:

1. The resource server returns a 402 whose bip122 accept carries a fresh random `extra.paymentId`.
2. The client derives the payment address, pays `amount` to it in one output, and builds the payload `{ txid, vout }`.
3. The client sends the payload. The resource server sends it to the facilitator's `/settle`. It MUST NOT call `/verify` for this flow (a stock x402 TS server does not, for `upfront`).
4. The facilitator validates the payment through hBK and records `(txid, vout)` as consumed in a Hemi transaction.
5. The resource server serves the request only after `/settle` succeeds. A failure reaches the client as 402 with the facilitator's `errorReason` in `PAYMENT-RESPONSE`.
6. While the reason is one of the retryable ones (see "Error Vocabulary"), the client re-sends the same payload, at most until `maxTimeoutSeconds` after paying.

## Amounts

`amount` MUST be a decimal string encoding a positive integer number of satoshis, without sign, decimal point, exponent, separator or unit. The paying output's value MUST be at least `amount`. Overpayment is accepted and grants nothing more; there is no refund path, as in the Lightning scheme. The miner fee is paid by the client on top of `amount`.

`amount` SHOULD be at least the dust limit of the address type (294 sats for p2wpkh, 330 for p2tr); standard Bitcoin nodes do not relay smaller outputs. The reference seller refuses smaller prices at startup.

SDKs MUST use an explicit atomic price, `{ "asset": "BTC", "amount": "1000" }`. Dollar prices and bare numbers MUST be rejected unless the application registers its own conversion: the scheme has no exchange rate.

## `PaymentRequirements`

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
    "paymentId": "00112233445566778899aabbccddeeff"
  }
}
```

| Field | Required | Meaning |
|------|------|------|
| `payTo` | Yes | The resource server's account-level extended public key, constant per seller: `xpub…` on mainnet, `tpub…` on testnet3. SLIP-132 forms (`ypub`, `zpub`, `upub`, `vpub`, …) MUST be rejected by clients and resource servers; the same key with `xpub`/`tpub` version bytes is the canonical form. A facilitator MAY accept `zpub`/`vpub` as p2wpkh. |
| `maxTimeoutSeconds` | Yes | How long the client should keep re-sending after paying. It SHOULD be large (3600 to 7200): a payment is verifiable one block after inclusion at the earliest, and hVM lags the Bitcoin tip. A Bitcoin transaction has no expiry, so the facilitator does not enforce it. |
| `extra.assetTransferMethod` | No | `"utxo"` if present. |
| `extra.paymentFlow` | Yes | `"upfront"`. |
| `extra.paymentId` | Yes | 32 lowercase hex characters (16 bytes) from a CSPRNG, fresh for every challenge. **Dynamic**: implementations MUST declare it in `dynamicExtraFields`, so it is ignored when a paid retry's `accepted` is matched against the requirements rebuilt for that request. |
| `extra.addressType` | No | `"p2wpkh"` (default) or `"p2tr"`. |
| `extra.minConfirmations` | No | Bitcoin confirmations required before settlement, default 1. The resource server chooses it per price; the facilitator MAY refuse values outside its policy. |

Every core field and every `extra` field except `paymentId` MUST match between `accepted` and the requirements.

## Payment Address

The payment address is a non-hardened BIP32 descendant of `payTo`, three levels below `payTo/0`:

```text
d       = SHA-256( UTF8("x402-btc") || bytes16(paymentId) )
i1      = BE_uint32(d[0..4])  & 0x7fffffff
i2      = BE_uint32(d[4..8])  & 0x7fffffff
i3      = BE_uint32(d[8..12]) & 0x7fffffff
child   = CKDpub(CKDpub(CKDpub(CKDpub(payTo, 0), i1), i2), i3)          // path payTo/0/i1/i2/i3
p2wpkh  : scriptPubKey = 0x00 0x14 || HASH160(compressed child pubkey)
p2tr    : scriptPubKey = 0x51 0x20 || x(Q), Q = P + int(TaggedHash("TapTweak", x(P)))·G    // BIP86, no script tree
```

`bytes16(paymentId)` is the 16 bytes the hex string encodes. The address is the network's bech32 (p2wpkh) or bech32m (p2tr) encoding of the script. The three levels give 93 bits of path; a single 31-bit level would let anyone holding `payTo` claim payments (see "Address binding and front-running").

Test vector (the BIP84 test mnemonic `abandon … about`, account `m/84'/0'/0'`):

| | |
|------|------|
| `payTo` | `xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V` |
| `paymentId` | `00112233445566778899aabbccddeeff` |
| `d` | `e80b56898eea12e8d2dd25c6383febd6420c1778109fdab78b7cf292ba56fb6b` |
| path | `m/0/1745573513/250221288/1390224838` |
| child pubkey | `03cbeecf22bec0774f9ae6b06429bcb4c5eea85ba699380ad18ae8ab2cebc9de4b` |
| p2wpkh | `0014c482e024e462c29003546a2f35eaa3d61daa46d2`, `bc1qcjpwqf8yvtpfqq65dghnt64r6cw653kjs6yrca` |
| p2tr | `51208eb728a9b5fe85439644bf97a42ca3f1fcdff8709096b3bee0147becb32743d3`, `bc1p36mj32d4l6z589jyh7t6gt9r787dl7rsjztt80hqz3a7eve8g0fsyhls8v` |
| `paymentRef` | `0xa8faed6abbf35c12a4b26e40f6feb19d736d90045c83b9f9a31f638d323e6811` |

`btc/test-vectors.json` has 16 vectors (both networks, both address types, four paymentIds, the testnet3 key `tpubDC8msFGe…` from `m/84'/1'/0'`) and rejection cases. Every implementation MUST reproduce them.

Each payment lands on its own address. The path is effectively random, so wallets that scan with a gap limit do not find these addresses. The resource server MUST keep each settled `paymentId` (or its path) to derive the spending key, `<account xprv>/0/i1/i2/i3`.

## `PaymentPayload`

```json
{
  "x402Version": 2,
  "resource": { "url": "https://api.example.com/report" },
  "accepted": { "scheme": "exact", "network": "bip122:000000000019d6689c085ae165831e93", "...": "the requirements, with the paymentId that was paid" },
  "payload": {
    "txid": "95bca029…367e",
    "vout": 1
  }
}
```

- `payload.txid`: the Bitcoin transaction id in display byte order (as block explorers show it), 64 lowercase hex characters.
- `payload.vout`: the index of the output that pays the derived address, a non-negative integer.
- `accepted.extra.paymentId` is the one the address was derived from. It differs from the `paymentId` in the 402 the server builds for the paid retry; the facilitator MUST derive from `accepted`.

## Client Payment Construction

1. Validate the accept: `scheme`, network, `asset`, `amount`, transfer method, flow, a well-formed `paymentId`, a supported `addressType`, and `payTo` with the right version bytes for the network. Apply the client's own spend cap.
2. Derive the address. Pay `amount` to it in one output of a standard transaction. Other outputs (change) are allowed.
3. Record the payment by `paymentId` **before** broadcasting and again with the txid after. A client MUST NOT pay a `paymentId` it has already recorded; if a record has no txid, a broadcast may have happened and the client MUST NOT pay again automatically.
4. Send the payload and re-send the same payload while the answer is retryable. A client SHOULD NOT use a generic "pay on every 402" wrapper with this scheme: the first answers after paying are always "not yet", and paying again on them pays twice.

## Facilitator Validation

`/settle` treats the payload and the requirements as untrusted and checks, in order:

1. The request parses; `x402Version` is 2. Otherwise `invalid_payload` / `invalid_x402_version`.
2. `accepted` equals the requirements in `scheme`, `network`, `amount`, `asset`, `payTo`, `maxTimeoutSeconds` and every `extra` field except `paymentId`. Otherwise `invalid_payment_requirements`.
3. The network is a bip122 network the facilitator serves (`invalid_network`); `scheme` is `exact` (`unsupported_scheme`); `asset` is `BTC`, `amount` a positive integer, the flow `upfront` and the transfer method `utxo` (`invalid_payment_requirements`); `minConfirmations` is inside the facilitator's policy (`invalid_payment_requirements`).
4. `accepted.extra.paymentId` is 32 lowercase hex characters, `addressType` is supported, and `payload` is exactly `{ txid: 64 lowercase hex, vout: non-negative integer }`. Otherwise `invalid_payload`.
5. `payTo` parses as an extended public key of this network. Otherwise `invalid_exact_bip122_pay_to`.
6. No settlement of `(network, txid, vout)` is in flight. Otherwise `invalid_transaction_state`.
7. Derive the script from `payTo`, `accepted.extra.paymentId` and `addressType`. Through the settler contract (one `eth_call`, which reads hBK):
   1. hBK knows the transaction: else `invalid_exact_bip122_payload_transaction_not_found`;
   2. output `vout` exists: else `invalid_exact_bip122_payload_vout`;
   3. its script equals the derived script byte for byte and is not `OP_RETURN`: else `invalid_exact_bip122_payload_recipient_mismatch`;
   4. its value is at least `amount`: else `invalid_exact_bip122_payload_value_mismatch`;
   5. Bitcoin confirmations (hBK's count minus the settler's offset) are at least `minConfirmations`: else `invalid_exact_bip122_payload_unconfirmed`;
   6. `(txid, vout)` is not consumed: else `invalid_transaction_state`.

Whether the output has since been spent is ignored: the seller may sweep its funds. `/verify` performs the same checks without recording anything.

## Settlement and Replay Protection

The Bitcoin payment moved the funds already. Settlement only records it, in the Hemi contract `X402BtcSettler`:

```solidity
function settle(bytes32 txid, uint32 vout, bytes scriptPubKey, uint64 minSats, uint32 minConfirmations, bytes32 paymentRef)
    returns (uint64 sats);              // only the facilitator's Hemi signer (SETTLER)
function settledBy(bytes32 txid, uint32 vout) view returns (bytes32);      // nonzero = consumed
event Settled(bytes32 indexed txid, uint32 vout, bytes32 indexed scriptPubKeyHash, uint64 sats, bytes32 indexed paymentRef, address settler);
```

`settle` re-runs the checks of step 7 on chain and reverts unless they pass, so a settlement cannot record an invalid payment. The consumption key is `(txid, vout)` on the settler of that network; `paymentRef = sha256(bytes16(paymentId))` names the payment without revealing the paymentId. A facilitator retry first reads `settledBy`: its own `paymentRef` there means already settled.

Only the facilitator's signer may call `settle`. Otherwise anyone who saw the Bitcoin transaction could settle it first with a bogus `paymentRef` and block the real settlement.

Success:

```json
{ "success": true, "transaction": "95bca029…367e", "network": "bip122:000000000019d6689c085ae165831e93" }
```

`transaction` is the Bitcoin txid: it is the payment on `network`. `payer` MUST be omitted: a Bitcoin payment has no single payer address. The Hemi settle transaction hash SHOULD be reported as `extra.settlementTransaction` once the response type allows it; until then it is in the facilitator's log and the `Settled` event.

A settle transaction broadcast without a receipt yet answers `settlement_pending` with the Hemi transaction hash in `transaction`, as the core spec's §9 requires. A retry of the same request is answered from the record and does not broadcast twice.

## Confirmation Policy

Payment acceptance is a Bitcoin question: how deep the paying transaction is. `minConfirmations` is counted in Bitcoin confirmations. The settler subtracts a per-deployment `CONFIRMATION_OFFSET` from hBK's count; on Hemi mainnet hBK's count equals Bitcoin's (offset 0, measured 2026-11-09). The seller chooses the depth per price, for example 1 for small amounts, 3 for tens of dollars and 6 above that.

hBK can return a transaction only once its block is at or below hVM's last Bitcoin header, which lagged the tip by two blocks on mainnet. So the earliest acceptance is at about three Bitcoin confirmations, roughly 30 minutes after inclusion, whatever `minConfirmations` says; until then the answer is `…_transaction_not_found`. On testnet3 hVM is thousands of blocks behind, so a testnet payment may take hours.

Hemi's Proof-of-Proof finality (about nine Bitcoin blocks for Hemi state) does not gate acceptance. It gates the durability of the consumption record: a Hemi reorganisation before finality could drop a `Settled` mark. The facilitator's in-memory record covers that window for one process, and a resource server that delivers something valuable SHOULD be idempotent per `paymentId`.

## Error Vocabulary

| Reason | Meaning | Client action |
|------|------|------|
| `invalid_exact_bip122_payload_transaction_not_found` | hBK does not know the transaction (yet). | Retry: normal for a block or two after broadcast. |
| `invalid_exact_bip122_payload_unconfirmed` | Fewer Bitcoin confirmations than `minConfirmations`. | Retry. |
| `settlement_pending` | The Hemi settle transaction was broadcast without a receipt yet; `transaction` is its hash. | Retry. |
| `invalid_exact_bip122_payload_vout` | The transaction has no output `vout`. | Stop. |
| `invalid_exact_bip122_payload_recipient_mismatch` | The output does not pay the derived address, or is `OP_RETURN`. | Stop. |
| `invalid_exact_bip122_payload_value_mismatch` | The output pays less than `amount`. | Stop. |
| `invalid_exact_bip122_pay_to` | `payTo` is not an extended public key of this network. | Stop. |
| `invalid_transaction_state` | The output is already consumed, a settlement of it is in flight, or the Hemi settle transaction reverted (then `transaction` is its hash). | Stop. |
| `invalid_payload` | Malformed payload or `extra`. | Stop. |
| `invalid_payment_requirements` | `accepted` and the requirements differ, or a policy field is out of range. | Stop. |
| `invalid_network`, `unsupported_scheme`, `invalid_x402_version` | As in the core spec. | Stop. |
| `unexpected_verify_error`, `unexpected_settle_error` | hBK or the Hemi RPC failed. | Retry later. |

Rejections that are verdicts on a readable request are HTTP 200 from the facilitator; unreadable requests are 400 (`invalid_payload`) and `unexpected_*` errors are 500. The Lightning scheme names its replay code `duplicate_settlement`; this scheme uses the core §9 code `invalid_transaction_state` for the same case, as this facilitator's EVM schemes do.

## Security Considerations

### Address binding and front-running

The payment is bound to a challenge only through the address: the facilitator accepts an output for whoever presents a `paymentId` that derives its script. A stock resource server ignores `paymentId` when it matches `accepted` (the field is dynamic), so the binding's strength is the attacker's cost to find *any* paymentId that derives the address of a payment it sees on chain.

That cost is why the path has three levels. With one 31-bit level (the first version of this design), `payTo` being public lets an attacker precompute the address of every index once per seller (about 12 CPU core-hours), recognise a payment's index from the mempool, and find another paymentId with that index in about 2^31 SHA-256 evaluations, seconds on a GPU. It could then settle the buyer's payment for itself, or at least deny it to the buyer by calling `/settle` first. With 93 bits neither the table nor the collision search is feasible.

A resource server that wants more can authenticate its own paymentIds (for example a MAC over a nonce, checked before settling). That is optional and not part of the wire format.

### Settler griefing

`settle` is restricted to the facilitator's signer. Rotating that signer means deploying a new settler.

### Reorganisations

A payment accepted at 1 confirmation can be reorganised out of Bitcoin, and its consumption mark can be reorganised out of Hemi before PoP finality. `minConfirmations` is the seller's lever for the first; idempotent handlers per `paymentId` cover the second.

### Privacy

Every payment goes to a fresh address under one published xpub. With a 93-bit path nobody can enumerate those addresses, so a payment cannot be attributed to the seller from the chain alone. Once the seller spends from them, ordinary chain analysis applies.

### hBK limits

hBK's parser reads at most 32 outputs and 64 script bytes and does not decode addresses for segwit outputs, so the settler compares script bytes and lengths. A payment MUST put the paying output among the first 32. Mainnet hBK returns an `Output` of eight members, without the `spentDetail` that `BitcoinKitStructs.sol` declares.

## Appendix

### Differences from the Lightning scheme

| | `lnbtc` | `bip122` (this scheme) |
|------|------|------|
| Proof | Preimage of the invoice's payment hash | `(txid, vout)` read through hBK |
| Binding to the challenge | Signed invoice with request hash | Derived address from `payTo` + `paymentId` |
| Dynamic field | `extra.invoice` | `extra.paymentId` |
| Time to acceptance | Seconds | One Bitcoin block or more |
| Replay record | Facilitator store, `network:payment_hash` | Hemi contract, `(txid, vout)` |
| Replay code | `duplicate_settlement` | `invalid_transaction_state` |
| `transaction` on success | Payment hash | Bitcoin txid |
| Payer | Omitted | Omitted |

### References

- x402 v2 core: `specs/x402-specification-v2.md` (x402-foundation/x402 @ ac01018), §5.3.2, §9.
- Lightning precedent: `specs/schemes/exact/scheme_exact_lnbtc.md` (same commit).
- BIP32, BIP84 (test mnemonic and p2wpkh), BIP86 (p2tr key path), BIP173/BIP350 (bech32/bech32m), SLIP-132, CAIP-2/CAIP-4.
- hBK `IBitcoinKit` and its `Output` struct: hemilabs/bitcoin-tunnel-contracts, `contracts/bitcoinkit/`.
- This repository: `docs/phase2/DESIGN.md`, `btc/test-vectors.json`, `contracts/src/btc/X402BtcSettler.sol`.
