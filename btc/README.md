# @hemi-x402/btc

The `exact` scheme on `bip122:*` for the x402 TypeScript SDK: native BTC paid on Bitcoin L1 and verified by the facilitator through Hemi's hBK. The wire format is in [`docs/specs/scheme_exact_bip122.md`](../docs/specs/scheme_exact_bip122.md).

| Export | Use |
|------|------|
| `ExactBtcServerScheme` | Seller side. Register one per Bitcoin network: `server.register(BTC_MAINNET, new ExactBtcServerScheme({ network: BTC_MAINNET, payTo: xpub }))`. Price the accept as `{ asset: "BTC", amount: "<sats>" }` with `payTo` = the xpub. |
| `ExactBtcClientScheme` | Buyer side. Takes a `PayBtc` callback (`(address, sats, ctx) => { txid, vout }`) or a `BtcWallet`, and a `PaymentJournal`. It pays at most once per `paymentId`: clients that share a journal claim the `paymentId` atomically before paying (a `FilePaymentJournal` does so across processes, with an exclusive claim file beside the journal's real path, so a symlinked path reaches the same claim; it refuses a hard-linked journal, and flushes the claim and the directory entries naming it before the wallet is called). An append that stopped part way is skipped, and the next starts on a new line, so it cannot damage later entries; a short write fails the payment. |
| `BtcWallet`, `EsploraClient` | A single-key demo wallet over mempool.space: largest-first coin selection, change to self, broadcast. |
| `derivePaymentAddress`, `paymentIndices`, `paymentRef`, `isPaymentId` | The derivation rule shared with the facilitator: `payTo/0/i1/i2/i3` from `sha256("x402-btc" ‖ paymentId)`. |
| `@hemi-x402/btc/mock-hbk` | Local forks only: write fabricated Bitcoin transactions into the mock hBK. It refuses non-local RPC URLs. |
| `test-vectors.json` | Derivation vectors every implementation must reproduce (`npm run vectors -w btc` regenerates them). |
| `requirements-cases.json` | How the `extra` fields of an accept read: absent, `null` and invalid values, and which a buyer may pay. The client's tests and the Rust facilitator's run every case; the facilitator's as a whole request, with the payload's `accepted` as a JavaScript buyer sends it back (`sent`: `1.0` returns as `1`). The crate keeps an identical copy, which a test here checks. |

```bash
npm test -w btc       # unit tests, no network
npm run typecheck -w btc
```

Do not drive this scheme with `wrapFetchWithPayment`. A payment becomes acceptable only after it confirms, and the wrapper would pay again on the next 402. `buyer/btc-l1.ts` shows the pay-then-poll loop, and `btc/dev/stub-facilitator.ts` stands in for a facilitator in local runs.
