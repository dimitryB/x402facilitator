# @hemi-x402/btc

The `exact` scheme on `bip122:*` for the x402 TypeScript SDK: native BTC paid on Bitcoin L1 and verified by the facilitator through Hemi's hBK. The wire format is in [`docs/specs/scheme_exact_bip122.md`](../docs/specs/scheme_exact_bip122.md).

| Export | Use |
|------|------|
| `ExactBtcServerScheme` | Seller side. Register one per Bitcoin network: `server.register(BTC_MAINNET, new ExactBtcServerScheme({ network: BTC_MAINNET, payTo: xpub }))`. Price the accept as `{ asset: "BTC", amount: "<sats>" }` with `payTo` = the xpub. |
| `ExactBtcClientScheme` | Buyer side. Takes a `PayBtc` callback (`(address, sats, ctx) => { txid, vout }`) or a `BtcWallet`, and a `PaymentJournal`. It pays once per `paymentId`, whatever happens after. |
| `BtcWallet`, `EsploraClient` | A single-key demo wallet over mempool.space: largest-first coin selection, change to self, broadcast. |
| `derivePaymentAddress`, `paymentIndices`, `paymentRef`, `isPaymentId` | The derivation rule shared with the facilitator: `payTo/0/i1/i2/i3` from `sha256("x402-btc" ‖ paymentId)`. |
| `@hemi-x402/btc/mock-hbk` | Local forks only: write fabricated Bitcoin transactions into the mock hBK. It refuses non-local RPC URLs. |
| `test-vectors.json` | Derivation vectors every implementation must reproduce (`npm run vectors -w btc` regenerates them). |

```bash
npm test -w btc       # unit tests, no network
npm run typecheck -w btc
```

Do not drive this scheme with `wrapFetchWithPayment`. A payment becomes acceptable only after it confirms, and the wrapper would pay again on the next 402. `buyer/btc-l1.ts` shows the pay-then-poll loop, and `btc/dev/stub-facilitator.ts` stands in for a facilitator in local runs.
