# x402-rs patches

The facilitator image is x402-rs at commit `e75adda8a0e3cf23db446883ba91b88bbab2fe28` plus the patches in
[`patches/`](patches/) and one new crate, [`crates/x402-chain-bip122/`](crates/x402-chain-bip122/), built by
[`../Dockerfile`](../Dockerfile). The crate adds BTC payments on Bitcoin L1 (phase 2, see
[The exact scheme on bip122](#the-exact-scheme-on-bip122)); patches 0029 and 0030 wire it in.

Stock x402-rs cannot return the x402 v2 spec's error shapes, and no setting in `config.json` changes that.
The Definition of done requires those shapes (a failed signature and an insufficient balance must "return
the spec's error shapes").

Each patch is small, does one thing, has unit tests (0024 has e2e tests only) and is meant to go upstream. None changes to whom or
how a payment is settled. What they change:

- which error is returned, and with which fields (all patches);
- the order and strictness of the checks: the signature first, including a contract wallet's own
  EIP-1271 answer, then allowance before balance (0003, 0004, 0008);
- what may be settled: the exact scheme now settles only the exact required amount and rejects an
  over-authorization, which stock x402-rs settled in full (0010);
- transaction handling in three places: after a broadcast transaction's receipt times out, the signer's
  nonce is kept instead of reset (0006); each payment authorization is settled at most once at a time,
  with a retry of a pending settle answered from its transaction rather than sending another (0011); and
  a settlement runs to its end even if the client disconnects, with every broadcast hash logged (0015),
  and a success nobody received is kept for the client's retry (0016); each settle owns its record, so
  no other settle can overwrite or delete it, and a running settle's record is never evicted (0020);
- where a transaction goes: to one RPC at a time, moving on only if that RPC cannot be reached or does not
  answer within 10 s, instead of a copy to every RPC (0021, 0022);
- when a send counts as failed: only once no RPC shows the transaction (0022, 0024, 0027);
- when a settlement counts as pending: only once no RPC has its receipt, on the first settle and on a
  retry (0028);
- what is sent at all: an EIP-6492 wallet deployment through Multicall3 is only sent after the EIP-6492
  validator accepted the signature, and a wrapper around the payer's own signature is never sent (0012).

- the HTTP status codes: a rejected payment is answered with 200, as the TS reference facilitator does,
  400 is kept for a request that cannot be read, and 500 for an unexpected failure (0018; see
  [HTTP status codes](#http-status-codes)).
- the fees a settlement pays: on an EIP-1559 chain the tip is at least the node's suggested priority fee,
  so a settlement sent after a run of tip-less blocks is still mined where the sequencer has a minimum
  tip, as Hemi testnet's does (0019), and a settlement whose tip cannot be read is not sent (0025). These,
  and 0021 to 0028, are about liveness rather than error shapes.
- a new scheme, `exact` on `bip122` (0029, 0030 and the crate). The buyer pays the seller directly on
  Bitcoin, to an address derived from the seller's xpub, so the facilitator moves no funds there either.
  Its Hemi signer sends one transaction per payment, to the `X402BtcSettler` contract, which re-checks the
  payment through hBK and marks the output consumed. The signer pays that transaction's gas, as it does for
  EVM settlements.

Spec references are to `x402-foundation/x402` at `e4a0868`:

- `specs/x402-specification-v2.md`: §5.3.2 SettleResponse, §5.4.2 VerifyResponse, §7.1 and §7.2 error
  examples, §9 error codes.
- `specs/schemes/exact/scheme_exact_evm.md`.

| Patch | Fixes | Spec |
|------|------|------|
| [0001](patches/0001-types-add-x402-v2-9-error-codes-to-ErrorReason.patch) | `ErrorReason` lacks the §9 codes x402-rs needs | §9 |
| [0002](patches/0002-facilitator-local-fill-payer-and-network-in-error-re.patch) | error bodies send `"payer": ""` and `"network": ""`, and `unexpected_error` | §5.3.2, §5.4.2, §9 |
| [0003](patches/0003-eip155-check-the-payer-s-signature-first-and-reject-.patch) | balance and allowance are read before the signature is checked; a bad EOA signature returns HTTP 500 `unexpected_error` | scheme_exact_evm.md (step 1 of both methods), §9 |
| [0004](patches/0004-eip155-check-Permit2-allowance-before-balance-and-re.patch) | Permit2: allowance and balance are checked in random order, and not re-checked on settle | scheme_exact_evm.md Permit2 steps 2–3 |
| [0005](patches/0005-eip155-report-a-replayed-authorization-as-invalid_tr.patch) | a replayed authorization returns HTTP 500 `unexpected_error` | §9 |
| [0006](patches/0006-settle-report-an-unconfirmed-settlement-as-settlemen.patch) | a receipt timeout returns 500 with `"transaction": ""`, losing the hash of a transaction that later pays out | §5.3.2, §9 `settlement_pending` |
| [0007](patches/0007-facilitator-local-report-a-request-for-an-unsupporte.patch) | a request for a network the facilitator does not serve returns `unsupported_scheme` | §9 `invalid_network` |
| [0008](patches/0008-eip155-verify-EIP-1271-signatures-before-the-transfe.patch) | a contract wallet (EIP-1271) with a signature it rejects gets HTTP 500 `unexpected_*_error` | scheme_exact_evm.md step 1, §9 |
| [0009](patches/0009-errors-report-the-remaining-failures-with-x402-v2-9-.patch) | the remaining errors use x402-rs names (`invalid_payment_expired`, `recipient_mismatch`, ...); `"network": ""` for a request without one; plain-text 400 for a body that is not JSON | §9, §5.3.2 |
| [0010](patches/0010-eip155-require-exactly-the-required-amount-in-the-v2.patch) | the exact scheme accepts and settles an amount above the requirement | §9 `…_value_mismatch` |
| [0011](patches/0011-eip155-one-settlement-per-authorization-answer-a-pen.patch) | a retried `settlement_pending` settle is settled again from scratch; `/verify` accepts a payment whose settle is pending; a mined revert loses its hash | §9 `settlement_pending`, §5.3.2 |
| [0012](patches/0012-eip155-validate-EIP-6492-signatures-first-ignore-a-w.patch) | EIP-6492 signatures skip the signature-first rule; `/settle` sends a caller-chosen factory call without validating the signature | scheme_exact_evm.md step 1, §9 |
| [0013](patches/0013-facilitator-local-report-a-missing-or-unserved-x402-.patch) | a missing or unserved `x402Version` is reported as `invalid_network` | §9 `invalid_x402_version` |
| [0014](patches/0014-eip155-report-a-Permit2-spender-other-than-the-exact.patch) | a Permit2 spender other than the exact proxy is reported as a recipient mismatch (or an invalid signature) | §9 `invalid_payload` |
| [0015](patches/0015-facilitator-local-finish-a-settlement-whose-client-d.patch) | a client that disconnects after the broadcast cancels the settlement: the transaction is still mined, but its record and hash are lost | §5.3.2, §9 `settlement_pending` |
| [0016](patches/0016-eip155-keep-a-success-whose-caller-left-for-that-cal.patch) | a settlement that succeeds after its client left discards the success: the retry gets a replay error, and the buyer is charged and not served | §5.3.2, §9 `invalid_transaction_state` |
| [0017](patches/0017-facilitator-local-report-an-x402Version-the-payload-.patch) | a top-level `x402Version` that `paymentPayload.x402Version` contradicts is reported as `invalid_payload` | §9 `invalid_x402_version` |
| [0018](patches/0018-facilitator-local-answer-a-rejected-payment-with-200.patch) | a rejected payment is answered with 400 (412 for a missing allowance), so a stock TS seller throws and reports `"<code>: <message>"`, and never answers 412 | TS reference facilitator; scheme_exact_evm.md Permit2 step 2 |
| [0019](patches/0019-eip155-tip-at-least-the-node-s-suggested-priority-fe.patch) | after ten blocks without tips, a settlement tips 1 wei; Hemi testnet's sequencer never mines it, and it holds the signer's nonce and every later settlement | none: liveness (§9 `settlement_pending` is what the buyer sees) |
| [0020](patches/0020-eip155-a-settlement-owns-its-record-until-it-ends.patch) | a flood of settles evicts a running settle's record; its guard then overwrites or deletes the record of a later settle of that authorization, so a retry can get success with another request's hash | §5.3.2, §9 `invalid_transaction_state` |
| [0021](patches/0021-eip155-broadcast-a-transaction-to-one-RPC-at-a-time.patch) | with two RPCs a transaction is broadcast twice, and the rejection of the second copy can make a mined settlement look failed: the payer is charged and the seller refuses service | §5.3.2, §9 `invalid_transaction_state` |
| [0022](patches/0022-eip155-a-stalled-RPC-can-neither-hold-a-settlement-n.patch) | a stalled best-ranked RPC holds a settlement with no limit since 0021, and an RPC that forwards a transaction and then stalls would make a mined settlement look failed | none: liveness (§9 `settlement_pending`) |
| [0023](patches/0023-eip155-do-not-hold-the-nonce-map-while-waiting-for-a.patch) | rejected sends under load can freeze the whole process: `reset_nonce` holds a map guard across an await | none: liveness |
| [0024](patches/0024-eip155-ask-every-RPC-for-a-failed-send-s-hash-for-tw.patch) | a lookup after a failed send takes the first answer, and `null` is one, so a mined settlement can still be reported as failed | none: §5.3.2 hash |
| [0025](patches/0025-eip155-do-not-send-a-settlement-whose-tip-floor-coul.patch) | a failed tip read removes 0019's floor, and the settlement goes out at 1 wei | none: liveness |
| [0026](patches/0026-eip155-bound-a-send-and-its-receipt-wait-together.patch) | a slow send plus the receipt wait can outlast the TS SDK's 90 s, and the hash is lost to the caller | §5.3.2 hash |
| [0027](patches/0027-eip155-search-after-any-failed-send-no-node-answered.patch) | a fast 5xx or a slow lookup can still report a mined settlement as failed, and the search ignores the send's budget | §5.3.2 hash |
| [0028](patches/0028-eip155-a-lagging-RPC-cannot-hide-a-settlement-s-rece.patch) | a receipt read takes the first answer, and `null` is one, so a fast RPC that lags reports a mined settlement as pending, on the first settle and on every retry | §9 `settlement_pending` |
| [0029](patches/0029-types-error-codes-for-the-exact-bip122-scheme.patch) | `ErrorReason` has no codes for a Bitcoin payment's failures, and no way to report unusable requirements with a message | §9 `invalid_payment_requirements`; scheme codes in the style of §9's exact EVM ones |
| [0030](patches/0030-facilitator-register-the-bip122-chain-and-v2-bip122-exact.patch) | the binary knows no `bip122` chains, and a chain cannot share another chain's provider | none: wiring for the crate |

[`build/0001-build-EVM-only-workspace-for-the-hemi-x402-image.patch`](build/) is **not** for upstream. It
cuts the workspace down to the EVM facilitator, which removes Solana, Aptos and TRON. A full workspace
resolve clones `aptos-core`, which is very large. It also adds `crates/chains/x402-chain-bip122` as a
member, `bitcoin` 0.32 as a workspace dependency, and the facilitator feature `chain-bip122`, off by default.
`build/check-lock-subset.sh` checks that the pruned `Cargo.lock` only removed packages, except for the ones
listed in [`build/lock-additions.txt`](build/lock-additions.txt): every remaining crate keeps the version
and checksum upstream locked. The additions are `bitcoin` and the eight packages it brings that upstream's
lock lacks. The file is in Cargo.lock format, and the Dockerfile appends it to the lock before
`cargo fetch`, so a newer release of any of them on crates.io does not change the build.

## Related upstream pull requests

Read on 2026-11-09 (DECISIONS.md D-035). Upstream `main` is still `e75adda`, its last commit, from
2026-07-13. Three open PRs by `zachsplat`, stacked on one another, cover the same ground as the settlement
patches here. They were opened on 2026-10-11, 12 and 23, before this repo's patches were written, and
nothing here was taken from them. None of ours were submitted.

| Upstream | What it does | Here | Differences that matter |
|------|------|------|------|
| [#138](https://github.com/x402-rs/x402-rs/pull/138), closes [#136](https://github.com/x402-rs/x402-rs/issues/136) | Keeps the hash of a broadcast transaction when the receipt wait fails, looks the receipt up three more times (1, 2 and 4 s), and answers `settlement_pending` with the hash. Same type names as ours: `MetaTransactionSendError::ReceiptUnavailable`, `X402SchemeFacilitatorError::SettlementPending` | 0006, 0028 | It answers HTTP 202; we answer 200 (0018), which is what the TS reference sends and the only status `x402-axum` reads a body from. It still resets the signer's nonce after the wait (`provider.rs`), so the next settlement may reuse the nonce of a transaction that can still mine; 0006 keeps it. Its extra lookups go through the fallback layer, where `null` from a lagging RPC counts as the answer; 0028 asks each RPC on its own |
| [#140](https://github.com/x402-rs/x402-rs/pull/140) | An in-memory `PendingSettlementStore`, as the TS reference has: keyed by the signature's hash plus a hash of the request, 5 min TTL. An entry is recorded when a settle ends with the receipt unavailable. A retry of the same request takes the entry and is answered from the receipt, polled every second | 0011, 0016, 0020 | Its record starts when the receipt wait ends; ours starts when the settle starts. So with #140 `/verify` still passes a payment whose settlement is pending, and a second request carrying the same authorization is settled from scratch. A stock seller then runs its handler again for the same payment, which is the case 0011 was redone for. It has no equivalent of 0015, so a client that disconnects after the broadcast still cancels the settlement before anything is recorded, and no equivalent of 0016 or 0020 |
| [#142](https://github.com/x402-rs/x402-rs/pull/142) | When a retry finds no store entry, after a restart or on another instance, reads `authorizationState` on the token and searches `eth_getLogs` for `AuthorizationUsed(from, nonce)` over the last five minutes, in calls of at most `log_query_max_blocks` (default 100). EIP-3009 only, off by default (`reconcile_used_authorizations`) | none | We have nothing like it: **Facilitator memory** in the top-level README's limits says a restart forgets pending records. Its author's own table shows why it is off by default: with it on, copies of a settled payment are answered with success for five minutes |

Nothing upstream covers 0015 (a disconnect cancels the settlement), 0019 and 0025 (the tip floor), 0021 to
0024 and 0026 to 0027 (one RPC at a time, bounded requests, the search by hash after a failed send, the
nonce-map deadlock), or the error-shape patches 0001 to 0014, 0017 and 0018. Issue
[#119](https://github.com/x402-rs/x402-rs/issues/119) reports the empty `network` that 0002 fills. PR
[#116](https://github.com/x402-rs/x402-rs/pull/116) resends once on `fee cap less than base fee`, which is a
different fee problem from 0019's.

If #138 to #142 were merged, 0006, 0011, 0028 and the `handlers.rs` parts of the error-shape patches would
conflict textually, since they touch the same lines, and 0006 and 0011 would need redoing as changes to
theirs: keep the nonce, start the record at the settle's start, and refuse `/verify` while it is pending.
If ours are submitted first, they should be filed against #136 and as review comments on #138 and #140,
not as a competing series.

## Check order after the patches

The spec gives an order for the exact scheme on EVM. EIP-3009 lists: signature, balance,
amount/validity window, token/network, simulation (`scheme_exact_evm.md` EIP-3009 Phase 2). Permit2 says
"The verifier must execute these checks in order": signature, allowance, balance, amount, deadline and
validAfter, token/network, simulation (Phase 3). The patched facilitator, on both `/verify` and `/settle`:

| Step | EIP-3009 | Permit2 |
|------|------|------|
| 1 | `accepted` equals the requirements; network | spender is the x402 exact proxy (`invalid_payload`) |
| 2 | **signature** | **signature** |
| 2b | | `accepted` equals the requirements; recipient; deadline and validAfter; exact amount; token |
| 3 | recipient; validity window; exact amount | **allowance** (`permit2_allowance_required`) |
| 4 | **balance** (`insufficient_funds`) | **balance** (`insufficient_funds`) |
| 5 | simulation (verify) or send (settle) | simulation (verify) or send (settle) |

The **signature check** reads nothing from the chain unless it needs to:

- An EOA signature must recover to `from`, which needs no RPC.
- A signature that does not recover to `from` is accepted only as EIP-1271: `from` must have code, and
  its `isValidSignature(hash, signature)` must return `0x1626ba7e` for the EIP-712 hash the token or
  Permit2 will check. Anything else, a revert included, is an invalid signature. This costs an
  `eth_getCode` and an `eth_call`, and only on this path. It is the TS reference facilitator's strict
  EIP-1271 check.
- An EIP-6492-wrapped signature (a wallet that may not be deployed yet) must be accepted by the EIP-6492
  validator (`isValidSigWithSideEffects`, run as an `eth_call`) before anything else is read or sent.
  A wrapper around a signature that recovers to `from` is dropped: it is a plain EOA payment.
- If the transfer simulation or send still reverts with a signature error, that is reported as an invalid
  signature too: FiatToken "invalid signature", or Permit2 `InvalidSigner()`, `InvalidSignature()`,
  `InvalidContractSignature()` or `InvalidSignatureLength()`. That covers an EIP-712 domain in the
  requirements that differs from the token's.

As a result, an unfunded, unapproved payer with a bad signature gets `invalid_exact_evm_payload_signature`.
Stock x402-rs answered `insufficient_funds` or `permit2_allowance_required` there.

### Decision: off-chain checks before allowance and balance

This is a deliberate departure from the spec text, and it matches the TS reference facilitator.

**What the spec says.** `scheme_exact_evm.md` puts the on-chain reads right after the signature:

- Permit2 (Phase 3): signature, then allowance, then balance, and only then amount, deadline/validAfter
  and token.
- EIP-3009 (Phase 2): signature, then balance, then amount and validity window.

**What we do.** The facilitator runs the off-chain checks first, as listed in the table above, because
that is what the TS reference facilitator does (x402-foundation/x402 `e4a0868`,
`typescript/packages/mechanisms/evm/src/`):

- `exact/facilitator/eip3009.ts`: signature at 151–243; recipient at 247–257, `validBefore` at 259–270,
  `validAfter` at 272–282 and the exact amount at 284–294. Only then comes the simulation (308–331).
  If the simulation fails, the balance is read by `diagnoseEip3009SimulationFailure`
  (`exact/facilitator/eip3009-utils.ts` 161–238, balance at 224–228).
- `exact/facilitator/permit2.ts`: spender at 119–128, recipient at 130–138, deadline at 140–147,
  `validAfter` at 149–155, exact amount at 157–166 and token at 168–174. The signature follows at
  199–221, then the simulation (306–311). If the simulation fails, balance and allowance are read by
  `diagnosePermit2SimulationFailure` (`shared/permit2.ts` 372–428: balance at 410–415, then allowance at
  417–422).

**Why.**

- Clients see the same reason from this facilitator and the reference.
- The off-chain checks need no RPC, so a payload that is wrong anyway costs nothing to reject.
- The off-chain reason is the one the payer can act on. An expired or mis-priced payment must be
  re-signed, and approving Permit2 or topping up the balance would not make it valid.

**What this means for combined failures.** A payload that is wrong off-chain and also unfunded or
unapproved gets the off-chain code:

- Permit2 with no allowance, or approved but unfunded, and also expired: `…_valid_before`. The spec text
  gives `permit2_allowance_required` or `insufficient_funds`.
- The same with an over-payment: `…_value_mismatch`.
- EIP-3009, unfunded, and also expired, over-paying or with a wrong recipient: the off-chain code.
- `tests/e2e/04b-payload-checks.test.ts` pins all of these ("combined failures"). It also pins the control
  case: with a correct payload, the same payers get `permit2_allowance_required` / `insufficient_funds`.

**Where we differ from the reference, and why.**

- *Signature position for Permit2.* The reference checks the Permit2 signature after the other off-chain
  checks. Here the signature comes right after the spender, as spec step 1 has it, and as both the spec
  and the reference do for EIP-3009. So a Permit2 payload with a bad signature that is also, say,
  expired is reported as an invalid signature here. The reference reports it as expired.
- *Allowance before balance.* When both are missing, the reference's failure diagnosis reads the balance
  first (`shared/permit2.ts` 410–415, before the allowance at 417–422) and answers
  `permit2_insufficient_balance`. Here the allowance
  comes first (`permit2_allowance_required`), as the spec orders steps 2 and 3. That was an explicit
  decision for 0004.

## Error codes after the patches

Every reason the v2 exact handler can return, with the §9 code it is reported as. "Generic" means the
mapping lives in `x402-types` and applies to every chain. "Exact EVM" means it applies only to the v2
exact handler, where §9 has a scheme-specific code.

| x402-rs error | §9 code | Why this code |
|------|------|------|
| `InvalidSignature` (incl. EIP-1271 rejection and signature reverts) | `invalid_exact_evm_payload_signature` | §9: "signature is invalid or improperly signed" (exact EVM) |
| `Early` | `invalid_exact_evm_payload_authorization_valid_after` | §9: "not yet valid (before validAfter)" (exact EVM) |
| `Expired` | `invalid_exact_evm_payload_authorization_valid_before` | §9: "has expired (after validBefore)"; Permit2's `deadline` plays that role (exact EVM) |
| `InvalidPaymentAmount` (now any difference) | `invalid_exact_evm_payload_authorization_value_mismatch` | §9: "does not exactly match the required amount" (exact EVM) |
| `RecipientMismatch` | `invalid_exact_evm_payload_recipient_mismatch` | §9: "Recipient address does not match payment requirements" (exact EVM) |
| `InsufficientFunds` | `insufficient_funds` | unchanged |
| `InsufficientAllowance` | `permit2_allowance_required` | scheme_exact_evm.md Permit2 step 2; same spelling as the TS reference. The spec's 412 is the resource server's answer to the buyer (see [HTTP status codes](#http-status-codes)) |
| `AuthorizationAlreadyUsed` | `invalid_transaction_state` | the chain rejects the transfer because the nonce is spent (0005) |
| `AuthorizationInFlight`: `/verify` (or another settle request) of an authorization whose settle is running or pending | `invalid_transaction_state` | the authorization is committed to a transaction and can't pay for anything else (0011; see below) |
| `TransactionSimulation`, other simulation reverts | `invalid_transaction_state` | §9: "Blockchain transaction failed or was rejected": the transfer fails on chain (generic) |
| a mined settlement that reverted | `invalid_transaction_state`, with its hash | same, and §5.3.2: a broadcast transaction is reported (0011) |
| `AssetMismatch` | `invalid_payload` | the payload authorizes another token than the requirements ask for: "contains invalid data" (generic) |
| `InvalidPermit2Spender`: a Permit2 spender other than the x402 exact proxy | `invalid_payload` | the spender never receives funds, so it is not a recipient mismatch; the payload is unusable (0014, 0018) |
| `InvalidFormat`, a body that is not JSON, a v2 request naming no network | `invalid_payload` | §9: "malformed or contains invalid data" (generic) |
| `AcceptedRequirementsMismatch` | `invalid_payment_requirements` | the requirements sent are not the ones the payload accepted; §9: "requirements object is invalid" (generic) |
| `ChainIdMismatch`, `UnsupportedChain` | `invalid_network` | §9: "network is not supported" (generic) |
| `UnsupportedScheme` | `unsupported_scheme` | unchanged |
| `UnsupportedX402Version`: an `x402Version` no handler serves (here: anything but 2) | `invalid_x402_version` | §9: "Protocol version is not supported" (0013) |
| `InvalidX402Version`: no top-level `x402Version`, or one that `paymentPayload.x402Version` contradicts | `invalid_x402_version` | same; the request disagrees with itself about its version, which is not a malformed payload (0013, 0017) |
| receipt not confirmed in time | `settlement_pending`, with the hash | §9 (0006, 0011) |
| an RPC that cannot be reached | `unexpected_verify_error` / `unexpected_settle_error` | §9; the only case left as "unexpected" |

The `exact` scheme on `bip122` (0029 and the crate) reports these. The settler contract's `verify` returns a
`Verdict`, which `docs/phase2/DESIGN.md` maps to a code:

| Failure | Code | Notes |
|------|------|------|
| request or payload does not parse (`txid` not 64 hex, `vout` not a `u32`) | `invalid_payload` (400) | as for EVM |
| `accepted` differs from the requirements other than in `extra.paymentId` | `invalid_payment_requirements` | the seller's SDK makes a new `paymentId` per 402, so that one field may differ |
| asset not `BTC`, `amount` not a positive whole number of satoshis, `extra.assetTransferMethod` not `utxo`, `extra.paymentFlow` not `upfront`, `extra.paymentId` not 32 lowercase hex, unknown `addressType`, `minConfirmations` outside the facilitator's range | `invalid_payment_requirements` | `PaymentVerificationError::InvalidPaymentRequirements` (0029) |
| `network` not the handler's | `invalid_network` | |
| `payTo` not an `xpub`/`tpub` (or `zpub`/`vpub`) for this network, a private key, `ypub`/`upub`, or `zpub`/`vpub` with `p2tr` | `invalid_exact_bip122_pay_to` | |
| output being settled, or its Hemi transaction pending | `invalid_transaction_state` | 0011's record, keyed by (network, txid, vout) |
| `TxNotFound` | `invalid_exact_bip122_payload_transaction_not_found` | not mined, or mined in a block hVM has not reached yet |
| `OutputNotFound` | `invalid_exact_bip122_payload_vout` | |
| `ScriptMismatch`, `OpReturn` | `invalid_exact_bip122_payload_recipient_mismatch` | the message names the derived address |
| `BelowAmount` | `invalid_exact_bip122_payload_value_mismatch` | more than the amount is accepted |
| `TooFewConfirmations` | `invalid_exact_bip122_payload_unconfirmed` | |
| `AlreadyConsumed` | `invalid_transaction_state` | the output was settled before |
| `HbkError`, an unknown verdict, Hemi unreachable | `unexpected_verify_error` / `unexpected_settle_error` (500) | |
| Hemi settle transaction without a receipt in time | `settlement_pending`, Hemi hash in `transaction` | as 0006 |
| Hemi settle transaction mined and reverted | `invalid_transaction_state`, Hemi hash in `transaction` | as 0011 |

## HTTP status codes

Patch 0018 answers as the x402 TS reference facilitator does. References are to `x402-foundation/x402` at
`e4a0868`; `index.ts` is `examples/typescript/facilitator/basic/index.ts`.

| Answer | Status | The reference |
|------|------|------|
| a valid payment; a settled one | 200 | `index.ts` 208 (`/verify`) and 290 (`/settle`): `res.json(response)` |
| a verdict on a payment that could be read: `isValid: false` or `success: false` with any §9 code, including `permit2_allowance_required`, `invalid_network`, `unsupported_scheme`, an unserved `x402Version`, `settlement_pending` and a reverted settlement | 200 | the same lines send whatever `verify` or `settle` returns, valid or not. The EVM scheme returns a missing allowance as `isValid: false` (`mechanisms/evm/src/shared/permit2.ts` 129, 156). An unsupported scheme, network or version is answered with `res.json` too (`index.ts` 182, 261) |
| a request that cannot be read: `invalid_payload` for a body that is not JSON, a payload that does not parse or a request that names no network; `invalid_x402_version` for a version that cannot be read (no top-level `x402Version`, or one `paymentPayload.x402Version` contradicts) | 400 (axum's own status for a body that is not JSON) | `index.ts` 157, 168, 194 and 236, 247, 275: 400 for a body without `paymentPayload` or `paymentRequirements`, a payload that is not an object, or an exact EVM payload with neither `authorization` nor `permit2Authorization` |
| an unexpected failure (an RPC that cannot be reached) | 500 | `index.ts` 211, 307: 500 when `verify` or `settle` throws |

Up to hemi.6 the image used x402-rs's mapping: 400 for every rejected payment, 412 for a missing Permit2
allowance, 400 for a mined revert, 200 only for `settlement_pending` (0006).

**Why it matters to a stock TS seller** (`typescript/packages/core/src`):

- `http/httpFacilitatorClient.ts` 423–435 (`verify`) and 481–493 (`settle`): a non-2xx answer whose body
  has `isValid` or `success` becomes a thrown `VerifyError` or `SettleError`. `types/facilitator.ts` 71
  and 100 make its message `"<code>: <message>"`.
- `http/x402HTTPResourceServer.ts` 692–696: a returned `isValid: false` puts the bare code into the
  seller's 402 (`error`, in the body and in the `PAYMENT-REQUIRED` header). 762–769: a thrown error puts
  its message there instead, so the buyer read `"invalid_exact_evm_payload_signature: Signature was not
  made by …"`.
- `x402HTTPResourceServer.ts` 1353: the seller answers 412 instead of 402 only when that error is exactly
  `permit2_allowance_required`. That is the 412 of `scheme_exact_evm.md` Permit2 step 2 ("Return 412
  Precondition Failed"): the resource server's answer to the client, not the facilitator's. With the
  facilitator answering 412 itself, the buyer got 402.
- Settle failures were less affected: the seller takes `SettleError.errorReason` (894–895), the bare
  code. The 200 there is for consistency with the reference.

**One difference from the reference.** It reports an unsupported scheme, network or version as
`unsupported_scheme` (`index.ts` 182, 261), and reads only `paymentPayload.x402Version`. This facilitator
uses the §9 codes `unsupported_scheme`, `invalid_network` and `invalid_x402_version`, with the same 200,
and answers 400 when the request has no top-level `x402Version` or contradicts itself (0017).

**x402-rs's own client still reads every answer.** `x402-axum`'s `FacilitatorClient::post_json`
(`crates/x402-axum/src/facilitator_client.rs` 398–400) deserializes the body of a 200, 400 or 412 alike.
`paygate.rs` then decides by the fields: `validate_verify_response` (378–394) by `isValid`, answering the
buyer 412 for `permit2_allowance_required` read from the body, and `validate_settlement_success` by
`success`. A unit test (`a_rejection_reads_as_one_for_the_x402_axum_client`) parses a 200 rejection the way
x402-axum does. 4xx answers that x402-axum would not read (415, 422 from axum for a body that is not JSON)
are unchanged.

e2e: `04c-stock-seller.test.ts` runs the SDK's `x402HTTPResourceServer` with the stock
`HTTPFacilitatorClient` against this facilitator. A tampered signature gives the buyer 402 with
`"error": "invalid_exact_evm_payload_signature"`, and `verifyPayment` returns it rather than throwing. A
payer without tokens gets 402 `insufficient_funds`. A Permit2 payer without an allowance gets 412
`permit2_allowance_required`.

## Building

`docker compose build` from the repo root builds the image named in `docker-compose.yml`
(`hemi-x402-facilitator:e75adda-hemi.15` for this patch set). The stock image this replaces,
`ghcr.io/x402-rs/x402-facilitator@sha256:4ebe09d8…`, is kept in a comment there. The Dockerfile works with
the classic builder, which is all Colima's Docker CLI has without buildx. It runs these steps in order:

1. Fetch x402-rs at the pinned commit and check `git rev-parse HEAD`.
2. Copy the Bitcoin crate's manifest, with an empty `src/lib.rs` in place of its sources. Apply the build
   patch, append `build/lock-additions.txt` to `Cargo.lock`, prune and check the lock, and compile all
   dependencies once against unpatched sources, `bitcoin` included.
3. Apply each patch in order with `git apply --check`, then `git apply`, copy the crate's sources, and
   build again with `--features chain-bip122`. Editing a patch or the crate re-runs only this step.

If a patch has drifted, step 3 fails and names the patch. Measured on Colima (4 CPUs, 8 GB, Apple
silicon), with the base images already pulled:

- Cold build: 114 s for hemi.1. Of that, 57 s compiles the dependency graph and 12 s rebuilds after the
  patches.
- `docker compose build --no-cache`, which re-fetches x402-rs and the crates and compiles everything:
  113 s for hemi.3; 112 s for hemi.4 (57.1 s dependencies, 12.0 s after the patches); 113 s for hemi.5
  (57.8 s, 11.9 s); 115 s for hemi.6 (57.4 s, 12.0 s); 113 s for hemi.7 (57.8 s, 12.0 s); 119 s for hemi.8; 118 s and 143 s for hemi.9; 118 s for hemi.10; 247 s for hemi.11; 287 s for hemi.12; 194 s for hemi.13; 124 s for hemi.14; 141 s for hemi.15, with no layer cached (58.9 s dependencies, 4.2 s `bitcoin`, 14.8 s after the patches and the crate).
- Rebuild after changing only patches: about 15 s, because the dependency layer is cached.

Base images are pinned by digest: `rust:1.93-trixie` for the build, `debian:trixie-slim` for the runtime.

## Changing a patch

```sh
git clone https://github.com/x402-rs/x402-rs.git && cd x402-rs
git checkout -b hemi e75adda8a0e3cf23db446883ba91b88bbab2fe28
git am <repo>/facilitator/x402-rs/patches/*.patch                    # one commit per patch
# edit, `git commit --fixup`, autosquash, then regenerate:
git format-patch --no-signature -o <repo>/facilitator/x402-rs/patches e75adda..HEAD
```

The unit tests run with the build patch applied (`git apply <repo>/facilitator/x402-rs/build/*.patch`) and
the crate copied in (`cp -r <repo>/facilitator/x402-rs/crates/x402-chain-bip122 crates/chains/`):

```sh
cargo test -p x402-types -p x402-facilitator-local -p x402-chain-eip155 \
  --features x402-chain-eip155/facilitator,x402-chain-eip155/telemetry
cargo test -p x402-chain-bip122 -p x402-facilitator \
  --features x402-chain-bip122/facilitator,x402-chain-bip122/telemetry,x402-facilitator/chain-bip122
```

Every patch was checked one by one: `cargo fmt --check`, `cargo clippy --tests -D warnings`, and the
tests, with 69 new unit tests in total. `tests/` (`npm test -w tests`) runs the end-to-end suite against
the built image on anvil forks.

## The one non-spec field: `invalidReasonDetails`

§5.4.2 names the human-readable field of a `/verify` error `invalidMessage`. Stock x402-rs calls it
`invalidReasonDetails`. Patch 0002 adds `invalidMessage` and keeps `invalidReasonDetails` next to it with
the same text, so that clients written against stock x402-rs keep working. Nothing in the spec forbids
extra fields. Even so, `tests/lib/spec.ts` flags every field outside §5.4.2 and §5.3.2 except this one, and
checks that it equals `invalidMessage`. Dropping it would be a one-line change in `handlers.rs`.

## What each patch changes

The "before" and "after" bodies come from the end-to-end suite: the stock image, then this image, on the
same forks. Long revert data is cut to `0x08c379a0…`. Keys are reordered here for reading; the patched
facilitator emits them in alphabetical order. The HTTP status in an "After" line is the one that patch
gave. Since 0018 every rejection of a readable payment is answered with 200 (see
[HTTP status codes](#http-status-codes)).

### 0001 types: add x402 v2 §9 error codes to `ErrorReason`

- **What changes.** Adds the §9 codes x402-rs had no equivalent for:
  - `invalid_exact_evm_payload_signature`
  - `invalid_transaction_state`
  - `unexpected_verify_error`
  - `unexpected_settle_error`
- It also adds two `PaymentVerificationError` variants that map to the first two:
  `InvalidExactEvmPayloadSignature` and `AuthorizationAlreadyUsed`.
- Existing variants and how they serialize are unchanged. This patch on its own changes no behaviour.

<details><summary>Upstream issue / PR draft</summary>

> **Title:** Add x402 v2 §9 error codes (`invalid_exact_evm_payload_signature`, `invalid_transaction_state`, `unexpected_verify_error`, `unexpected_settle_error`)
>
> The x402 v2 spec (`specs/x402-specification-v2.md` §9) lists the error codes facilitators return in `invalidReason` / `errorReason`, and says clients "MUST use the corresponding `invalidReason` or `errorReason` code". Several codes x402-rs needs have no `ErrorReason` variant:
>
> - a bad exact-EVM signature has `invalid_exact_evm_payload_signature`, while x402-rs has only the chain-agnostic `invalid_signature`;
> - an authorization the chain rejects (for example, already used) has `invalid_transaction_state`;
> - unexpected failures have `unexpected_verify_error` / `unexpected_settle_error`, while x402-rs sends `unexpected_error`, which is not in §9.
>
> This PR adds the four variants, plus `PaymentVerificationError::{InvalidExactEvmPayloadSignature, AuthorizationAlreadyUsed}` mapped to the first two. It is additive: no existing variant or serialization changes. Follow-up PRs use them.
</details>

### 0002 facilitator-local: fill `payer` and `network` in error responses, use spec codes

- **What changes in the bodies:**
  - Error bodies carry the request's network and the payer.
  - `/verify` errors gain `invalidMessage` (§5.4.2). `invalidReasonDetails` stays, as described above.
  - `unexpected_error` becomes `unexpected_verify_error` or `unexpected_settle_error`, depending on the
    endpoint.
- **How it works:**
  - `FacilitatorLocalError` gains an `ErrorContext`.
  - The new `X402SchemeFacilitator::payer` lets a scheme handler report the payer. By default it reports
    none, and `payer` is then omitted.
  - `VerifyRequest::network` reads the network as the request writes it.

Before (stock):

```json
{"isValid":false,"invalidReason":"insufficient_funds","invalidReasonDetails":"Onchain balance is not enough to cover the payment amount","payer":""}
{"success":false,"network":"","transaction":"","errorReason":"insufficient_funds","errorMessage":"Onchain balance is not enough to cover the payment amount","payer":""}
```

After:

```json
{"isValid":false,"invalidReason":"insufficient_funds","invalidMessage":"Onchain balance is not enough to cover the payment amount","invalidReasonDetails":"Onchain balance is not enough to cover the payment amount","payer":"0x81c5Ed12E1aCb26c6008d68Dad2F2038cC109ca7"}
{"success":false,"network":"eip155:43111","transaction":"","errorReason":"insufficient_funds","errorMessage":"Onchain balance is not enough to cover the payment amount","payer":"0x81c5Ed12E1aCb26c6008d68Dad2F2038cC109ca7"}
```

<details><summary>Upstream issue / PR draft</summary>

> **Title:** Error responses: report `payer` and `network`, add `invalidMessage`, use §9 unexpected-error codes
>
> `/verify` and `/settle` error bodies hardcode `"payer": ""` and `"network": ""` (`x402-facilitator-local/src/handlers.rs`). The x402 v2 spec requires `network` on every SettleResponse, as a CAIP-2 id (§5.3.2). It defines `payer` as the payer's address (§5.3.2, §5.4.2), and its §7.1 and §7.2 error examples include both. An empty string is neither an address nor a CAIP-2 id. Separately, §5.4.2 names the human-readable field `invalidMessage`, and §9 has no `unexpected_error`, only `unexpected_verify_error` and `unexpected_settle_error`.
>
> This PR:
> - adds an `ErrorContext { payer, network }` to `FacilitatorLocalError`, filled from the request (`VerifyRequest::network`) and from the new `X402SchemeFacilitator::payer`. The default returns `None`, and `payer` is then omitted. The EIP-155 v2 exact handler implements it;
> - adds `invalidMessage` to `/verify` errors and keeps `invalidReasonDetails` for compatibility;
> - maps `unexpected_error` to `unexpected_verify_error` / `unexpected_settle_error` by endpoint.
>
> HTTP status codes are unchanged. Unit tests cover the bodies and the status codes.
</details>

### 0003 eip155: check the payer's signature first, and reject one an EOA cannot have made

**Two bugs.**

1. *Order.* x402-rs read the balance first, and for Permit2 the allowance too, and only then looked at the
   signature. An unfunded payer with a bad signature got `insufficient_funds` (EIP-3009) or 412
   `permit2_allowance_required` (Permit2). The spec puts the signature first for both methods.
2. *Classification.* `StructuredSignature::try_from_bytes` treats a 64/65-byte signature that does not
   recover to the payer as EIP-1271, so that smart wallets keep working. For an EOA payer, which has no
   code, such a signature can never be valid, yet it went to the simulation. The revert ("FiatTokenV2:
   invalid signature", Permit2 `InvalidSigner()`) surfaced as HTTP 500 `unexpected_error` from `/verify`
   and `/settle`.

**The fix.**

- The v2 exact verify and settle paths, for both methods, check the signature before any balance or
  allowance read, as shown in the table above.
- A signature that does not recover to `from` is accepted only from a payer with code. This costs one
  `eth_getCode`, and only on that path.
- EIP-1271 wallets have code, so they behave as before. EIP-6492 counterfactual wallets use wrapped
  signatures and are still checked on chain.
- Signature failures are reported as `invalid_exact_evm_payload_signature`, the §9 code for this scheme.

Before (stock), funded payer, both methods, verify and settle alike:

```json
{"isValid":false,"invalidReason":"unexpected_error","invalidReasonDetails":"server returned an error response: error code 3: execution reverted: FiatTokenV2: invalid signature, data: \"0x08c379a0…\"","payer":""}
{"success":false,"network":"","transaction":"","errorReason":"unexpected_error","errorMessage":"server returned an error response: error code 3: execution reverted: custom error 0x815e1d64, data: \"0x815e1d64\"","payer":""}
```

Before (stock), unfunded and unapproved payer: 400 `insufficient_funds` (EIP-3009), 412 `permit2_allowance_required` (Permit2).

After (HTTP 400), funded or not:

```json
{"isValid":false,"invalidReason":"invalid_exact_evm_payload_signature","invalidMessage":"Signature was not made by 0x8DdB73725f472dFbeB67d1cD04DEfFA5b5496cfd, which has no code to validate it as an EIP-1271 signature","invalidReasonDetails":"…same…","payer":"0x8DdB73725f472dFbeB67d1cD04DEfFA5b5496cfd"}
{"success":false,"network":"eip155:43111","transaction":"","errorReason":"invalid_exact_evm_payload_signature","errorMessage":"Signature was not made by 0x0f09dC43fb6562D12330DE1Baf0f42d35d983Ee4, which has no code to validate it as an EIP-1271 signature","payer":"0x0f09dC43fb6562D12330DE1Baf0f42d35d983Ee4"}
```

<details><summary>Upstream issue / PR draft</summary>

> **Title:** exact/EVM: check the signature before balance and allowance; a wrong EOA signature is HTTP 500 `unexpected_error`
>
> **Repro 1 (order):** take a fresh payer with no tokens and no Permit2 allowance, and send a payload with a tampered signature. EIP-3009 answers 400 `insufficient_funds`; Permit2 answers 412 `permit2_allowance_required`. `scheme_exact_evm.md` checks the signature first for both methods. For Permit2 it says "The verifier must execute these checks in order", step 1 being the signature, step 2 the allowance and step 3 the balance. The cause: `assert_valid_payment` (EIP-3009) reads the balance, and `assert_onchain_exact_permit2` reads allowance and balance, before the signature is looked at.
>
> **Repro 2 (500):** for a funded EOA payer, flip one bit of the signature, or sign with another key and keep `from`. `/verify` and `/settle` both answer HTTP 500 `{"invalidReason": "unexpected_error", ...}` with the token's revert message. The cause: `StructuredSignature::try_from_bytes` treats a 64/65-byte signature that does not recover to `from` as EIP-1271, so that contract wallets work. The EIP-1271 path never checks whether `from` is a contract, so the transfer simulation reverts, and the revert surfaces as `Eip155ExactError::Transport`, then `OnchainFailure`, then `unexpected_error`.
>
> **Fix:** the v2 exact verify and settle paths of both methods call a new `assert_signed_by_payer` before any balance or allowance read. An EOA signature already recovered to `from`. An EIP-1271 signature additionally requires `from` to have code (`assert_eip1271_signer_has_code`, one `eth_getCode`). EIP-6492 signatures are left to the on-chain validator. Signature failures are reported as `invalid_exact_evm_payload_signature`, the x402 v2 §9 code ("Payment authorization signature is invalid or improperly signed"). Unit tests use alloy's mocked transport, and one asserts that an EOA signature costs no RPC call.
</details>

### 0004 eip155: check Permit2 allowance before balance, and re-check both on settle

- **The ordering bug.** x402-rs ran the allowance and balance reads with `tokio::try_join!`, which returns
  whichever error arrives first. A payer with neither got 400 `insufficient_funds` or 412
  `permit2_allowance_required` at random: 3 and 2 times out of 5 calls with the same payload.
- **The fix for the ordering.** Both reads still run concurrently, but the allowance result is evaluated
  first.
- **The settle bug.** The Permit2 settle checked nothing on chain, so an unfunded payer got a failed gas
  estimate: HTTP 500 `unexpected_error` with `TRANSFER_FROM_FAILED`.
- **The fix for settle.** It now runs the same checks as verify, as the EIP-3009 settle already does. With
  an EIP-2612 permit only the balance is checked, because the permit grants the allowance in the same
  transaction.

Before (stock): a Permit2 settle with an approved Permit2 allowance but no balance.

```json
{"success":false,"network":"","transaction":"","errorReason":"unexpected_error","errorMessage":"server returned an error response: error code 3: execution reverted: TRANSFER_FROM_FAILED, data: \"0x08c379a0…\"","payer":""}
```

After (HTTP 400), followed by `/verify` from a payer with no allowance and no balance, which is now always HTTP 412:

```json
{"success":false,"network":"eip155:743111","transaction":"","errorReason":"insufficient_funds","errorMessage":"Onchain balance is not enough to cover the payment amount","payer":"0xb2E5C0dFC42A48dd23FcC3c3D7da160c3346E319"}
{"isValid":false,"invalidReason":"permit2_allowance_required","invalidMessage":"Allowance is not enough to cover the payment amount","invalidReasonDetails":"…same…","payer":"0x9c1B982D2994E92c577b0059bADB6199f82A4DB4"}
```

<details><summary>Upstream issue / PR draft</summary>

> **Title:** Permit2: allowance vs balance error is nondeterministic; settle skips both checks
>
> 1. `assert_onchain_exact_permit2` runs the allowance and balance reads with `tokio::try_join!`, so a payer with neither allowance nor balance gets 412 `permit2_allowance_required` or 400 `insufficient_funds` depending on which RPC answers first. On the same payload we saw both answers within five calls. The scheme spec checks allowance first (Permit2 verification step 2) and answers 412 so the client knows to approve. This PR keeps the reads concurrent (`tokio::join!`) but evaluates the allowance first.
> 2. `settle_permit2_payment` only runs the off-chain checks before sending. An unfunded or unapproved payer therefore gets a reverted gas estimate, reported as HTTP 500 `unexpected_error`. The EIP-3009 settle re-checks the balance. This PR runs the same allowance-then-balance check before the Permit2 settle; with an EIP-2612 permit only the balance, since the permit sets the allowance atomically.
>
> Settlement transactions are unchanged. A unit test with alloy's mocked transport covers the ordering.
</details>

### 0005 eip155: report a replayed authorization as `invalid_transaction_state`

- **The bug.** Settling or verifying a payload whose EIP-3009 nonce or Permit2 nonce is already spent
  made the simulation or gas estimate revert ("FiatTokenV2: authorization is used or canceled", Permit2
  `InvalidNonce()`). The revert surfaced as HTTP 500 `unexpected_error`.
- **The fix.** When the transfer fails to execute, read the nonce state on chain (EIP-3009
  `authorizationState`, Permit2 `nonceBitmap`). If the nonce is spent, report `AuthorizationAlreadyUsed`.
  The state is read only after a failure, so a successful payment makes no extra call. Failures after a
  transaction was broadcast, such as a receipt timeout, are not reclassified, because there it was our
  own transaction that may have spent the nonce.

**Why `invalid_transaction_state`.** §9 has no replay-specific code. Its definition, "Blockchain transaction
failed or was rejected", fits a transfer that the chain rejects because of on-chain state. The alternatives
fit worse:

- `invalid_payload` ("malformed or contains invalid data") would wrongly call a payload malformed when it
  was valid until it was used.
- `unexpected_verify_error` / `unexpected_settle_error` would invite retries that cannot succeed.

The TS reference facilitator also uses `invalid_transaction_state` as its default for a failed settlement
transaction (`mechanisms/evm/src/shared/settleReceipt.ts`).

Before (stock, both methods):

```json
{"success":false,"network":"","transaction":"","errorReason":"unexpected_error","errorMessage":"server returned an error response: error code 3: execution reverted: FiatTokenV2: authorization is used or canceled, data: \"0x08c379a0…\"","payer":""}
{"success":false,"network":"","transaction":"","errorReason":"unexpected_error","errorMessage":"server returned an error response: error code 3: execution reverted: custom error 0x756688fe, data: \"0x756688fe\"","payer":""}
```

After (HTTP 400; `/verify` answers the same code):

```json
{"success":false,"network":"eip155:43111","transaction":"","errorReason":"invalid_transaction_state","errorMessage":"Payment authorization was already used on chain","payer":"0x90F79bf6EB2c4f870365E785982E1f101E93b906"}
{"success":false,"network":"eip155:743111","transaction":"","errorReason":"invalid_transaction_state","errorMessage":"Payment authorization was already used on chain","payer":"0x90F79bf6EB2c4f870365E785982E1f101E93b906"}
```

<details><summary>Upstream issue / PR draft</summary>

> **Title:** A replayed EIP-3009 / Permit2 authorization is reported as HTTP 500 `unexpected_error`
>
> **Repro:** settle a valid payload, then send it to `/settle` (or `/verify`) again. The second call answers HTTP 500 `unexpected_error` with the token's revert ("authorization is used or canceled", or Permit2 `InvalidNonce()`). Nothing is broadcast, which is correct, but the client cannot tell a replay from a facilitator failure, and may retry.
>
> **Fix:** when the transfer simulation, gas estimate or transaction fails, read the nonce on chain: EIP-3009 `authorizationState(from, nonce)`, or Permit2 `nonceBitmap(owner, nonce >> 8)` and bit `nonce & 0xff`. If the nonce is spent, return the new `PaymentVerificationError::AuthorizationAlreadyUsed`, mapped to x402 v2 §9 `invalid_transaction_state` ("Blockchain transaction failed or was rejected"). §9 has no replay code. `invalid_payload` would call a once-valid payload malformed, and the unexpected-error codes would invite futile retries. The read happens only after a failure, so a successful payment costs no extra RPC call. Failures after broadcast (receipt timeouts) are left alone, because there our own transaction may have spent the nonce. Unit tests cover both lookups with alloy's mocked transport.
</details>

### 0006 settle: report an unconfirmed settlement as `settlement_pending` with its hash

**The bug.** Suppose the settlement transaction is broadcast but its receipt does not arrive within
`receipt_timeout_secs`, or the RPC fails while waiting. `send_transaction` (`chain/provider.rs`) then:

- dropped the transaction hash;
- reset the signer's nonce;
- made `/settle` answer HTTP 500 `unexpected_settle_error` with `"transaction": ""`.

The transaction was still in the mempool and paid out a block later. Resetting the nonce also let the
next settlement ask a node that had not seen the pending transaction for the next nonce, reuse it, and
replace or race it. §5.3.2 allows an empty `transaction` only "if no transaction was broadcast". §9
defines `settlement_pending` for exactly this case.

**The fix.**

- `MetaTransactionSendError::ReceiptUnavailable` carries the hash of a broadcast transaction whose
  receipt did not arrive. It travels as `Eip155ExactError::SettlementPending` and then the new
  `X402SchemeFacilitatorError::SettlementPending`.
- `/settle` answers `success: false`, `errorReason: "settlement_pending"`, the hash in `transaction`, plus
  `network` and `payer`.
- The nonce of a broadcast transaction is kept. A submission failure still resets it, as before.
- **Trade-off:** if a pending transaction is later dropped from every mempool, its nonce leaves a gap that
  holds back later transactions until the facilitator restarts. On restart the nonce is re-read with
  `pending`. That is the price of never reusing the nonce of a transaction that may still be mined.

**HTTP 200**, because this is not a failed request: the transaction is out and may still be mined. Three
reasons:

- The TS reference facilitator returns its `settlement_pending` SettleResponse as an ordinary result, with
  HTTP 200 from `res.json(...)`.
- The TS resource server reads it from a 2xx body (`isRetryableSettlementPendingResult`).
- x402-rs's own facilitator client (`x402-axum`) only reads the body of a 200, 400 or 412. A 5xx would
  lose the hash.

Before, with automine off and `receipt_timeout_secs` 10: a review's repro on the previous patch set,
`hemi.1`, where `network` and `payer` were already filled. Stock x402-rs gives the same, with
`unexpected_error`, `"network": ""` and `"payer": ""`.

```json
{"success":false,"errorReason":"unexpected_settle_error","transaction":"", …}
```

After (HTTP 200), with automine off and `receipt_timeout_secs` 5:

```json
{"success":false,"errorReason":"settlement_pending","errorMessage":"Transaction 0x20225e494360d26c9e4c3b138567dfa0d9b2aec664dee1f7e20aec5f3bbb1487 was broadcast, but its receipt is not available: transaction was not confirmed within the timeout","transaction":"0x20225e494360d26c9e4c3b138567dfa0d9b2aec664dee1f7e20aec5f3bbb1487","network":"eip155:43111","payer":"0x90F79bf6EB2c4f870365E785982E1f101E93b906"}
```

The e2e test does the following:

1. It sends two such settlements.
2. It checks that both are in the mempool with consecutive nonces.
3. It mines one block.
4. It checks that each `payTo` was paid exactly once, and that a third settle of the first payload is
   refused as a replay.

The test cannot show the nonce-reuse hazard itself, because anvil's `pending` nonce already counts
mempool transactions.

<details><summary>Upstream issue / PR draft</summary>

> **Title:** Receipt timeout loses the settlement transaction hash (should be `settlement_pending`)
>
> **Repro:** fork a chain with anvil, `evm_setAutomine false`, set `receipt_timeout_secs: 10`, and settle a valid payment. `/settle` answers HTTP 500 `{"errorReason": "unexpected_settle_error", "transaction": ""}`, but the transaction is in the mempool and pays out as soon as a block is mined. The client has no hash to reconcile, and may retry.
>
> **Cause:** `Eip155ChainProvider::send_transaction` maps a receipt-watcher error to `MetaTransactionSendError::PendingTransaction`, dropping the hash, and resets the nonce, so the next transaction may ask an RPC that has not seen the pending one and reuse its nonce.
>
> **Fix:** a new `MetaTransactionSendError::ReceiptUnavailable { tx_hash, source }` keeps the hash, and the nonce is not reset after a successful broadcast. Submission failures still reset it. The hash travels as `Eip155ExactError::SettlementPending` and a new `X402SchemeFacilitatorError::SettlementPending { transaction, details }`. It is rendered as x402 v2 §9 `settlement_pending`, with the hash in `transaction` as §5.3.2 and §9 require, plus `network` and `payer`. The response is HTTP 200: it is not a failed request, the TS reference facilitator returns it as an ordinary settle response, and x402-rs's `x402-axum` client discards the body of a 5xx.
>
> Trade-off: a pending transaction that is later dropped everywhere leaves a nonce gap until restart, instead of risking a nonce reuse that could replace a transaction which may still pay out.
</details>

### 0007 facilitator-local: report a request for an unsupported network as `invalid_network`

- **The bug.** A request for a network no handler serves, such as `eip155:1` here, was answered with
  `unsupported_scheme`.
- **The fix.**
  - `SchemeRegistry::supports_chain` tells whether any handler serves a chain.
  - When no handler matches, `FacilitatorLocal` reports `UnsupportedChain` for an unserved network, and
    `UnsupportedScheme` otherwise.
  - `PaymentVerificationError::UnsupportedChain`, which scheme handlers already use for networks they
    cannot serve, now maps to `invalid_network` instead of the non-spec `unsupported_chain`.
- No handler reads the payload in this case, so `payer` is unknown and omitted.

Before: `"invalidReason": "unsupported_scheme"`, which a review run observed. With stock x402-rs, the
full body follows from its code: `{"isValid":false,"invalidReason":"unsupported_scheme","invalidReasonDetails":"Unsupported scheme","payer":""}`.

After (HTTP 400):

```json
{"isValid":false,"invalidReason":"invalid_network","invalidMessage":"Unsupported chain","invalidReasonDetails":"Unsupported chain"}
{"success":false,"errorReason":"invalid_network","errorMessage":"Unsupported chain","transaction":"","network":"eip155:1"}
```

<details><summary>Upstream issue / PR draft</summary>

> **Title:** Unsupported network is reported as `unsupported_scheme`; x402 v2 §9 has `invalid_network`
>
> A `/verify` or `/settle` request for a chain the facilitator is not configured for gets `unsupported_scheme`. §9 distinguishes `invalid_network` ("Specified blockchain network is not supported") from `unsupported_scheme`. This PR adds `SchemeRegistry::supports_chain`. When no handler matches, `FacilitatorLocal` reports `UnsupportedChain` if no handler serves the request's chain at all, and `UnsupportedScheme` otherwise. `UnsupportedChain`, already used by scheme handlers, now maps to a new `ErrorReason::InvalidNetwork` (`invalid_network`) instead of the non-spec `unsupported_chain`. Unit tests cover both lookups.
</details>

### 0008 eip155: verify EIP-1271 signatures before the transfer, and report signature reverts

- **The bug.** A payer with code (a contract wallet) and a signature the wallet does not accept got HTTP
  500 `unexpected_verify_error` / `unexpected_settle_error`. 0003 only checked that the payer had code,
  and the signature itself was judged inside the transfer simulation. The revert surfaced as a transport
  error: "FiatTokenV2: invalid signature", or Permit2 `InvalidContractSignature()` `0xb0669cbc`.
- **The fix.**
  - For an EIP-1271 signature, call the payer's `isValidSignature(hash, signature)` with the EIP-712 hash
    that the token or Permit2 will check, and require the magic value `0x1626ba7e`.
  - Any other answer, a revert included, is an invalid signature. Only an RPC that cannot be reached
    stays an unexpected error. This mirrors the TS reference
    (`mechanisms/evm/src/exact/facilitator/permit2.ts`, strict EIP-1271).
  - A simulation or send that still reverts with a known signature error is reported as an invalid
    signature. The known errors are FiatToken `Error(string)` reasons containing "invalid signature" and
    Permit2's four signature errors, as in the TS reference's `eip3009-utils.ts`.
- **EIP-6492** counterfactual wallets are unchanged.
- **Tests.** The e2e suite gives two addresses code with `anvil_setCode`. One wallet returns the magic
  value for anything, and must still verify and settle; tokens go from the wallet to `payTo`. The other
  returns `0x00000000`. Both are tested with both methods.

Before (hemi.2, critic's probe; stock x402-rs says `unexpected_error`):
`{"isValid":false,"invalidReason":"unexpected_verify_error","invalidMessage":"… FiatTokenV2: invalid signature …", …}`.

After (HTTP 400):

```json
{"isValid":false,"invalidReason":"invalid_exact_evm_payload_signature","invalidMessage":"0xa58FED5834D90Ba82d2AA1c0EC1b35A14D5C8B61 does not accept the signature (isValidSignature returned 0x00000000)","invalidReasonDetails":"…same…","payer":"0xa58FED5834D90Ba82d2AA1c0EC1b35A14D5C8B61"}
{"success":false,"errorReason":"invalid_exact_evm_payload_signature","errorMessage":"0x1d973D8FE359Cf82f5d7BC36c8F8CE0b162a080C does not accept the signature (isValidSignature returned 0x00000000)","transaction":"","network":"eip155:43111","payer":"0x1d973D8FE359Cf82f5d7BC36c8F8CE0b162a080C"}
```

<details><summary>Upstream issue / PR draft</summary>

> **Title:** exact/EVM: a contract wallet's rejected signature is HTTP 500; check `isValidSignature` first
>
> **Repro:** give the payer code that does not accept the signature (any EIP-1271 wallet, or anvil_setCode with code returning `0x00000000`), fund and approve it, and send a payload. `/verify` and `/settle` answer HTTP 500 `unexpected_error`: the signature is only judged inside the transfer simulation, whose revert ("FiatTokenV2: invalid signature", Permit2 `InvalidContractSignature()`) surfaces as a transport error.
>
> **Fix:** for a signature that does not recover to `from` (and therefore can only be EIP-1271), call `from.isValidSignature(hash, signature)` with the EIP-712 hash of the `TransferWithAuthorization` / `PermitWitnessTransferFrom`, and require `0x1626ba7e`. Anything else, a revert included, is an invalid signature; only a failure to reach the RPC is an error. As a fallback, a simulation or send that reverts with a known signature error (`Error(string)` mentioning an invalid signature; Permit2 `InvalidSignature()`, `InvalidSigner()`, `InvalidContractSignature()`, `InvalidSignatureLength()`) is reported as an invalid signature as well. EIP-6492 wallets are unchanged. This matches the TS reference facilitator. Unit tests use alloy's mocked transport.
</details>

### 0009 errors: report the remaining failures with x402 v2 §9 codes, and answer unreadable bodies in JSON

- **The bug.** The remaining errors went out with x402-rs's own names, as listed in the error-code table
  above. A `/settle` request that names no network got `"network": ""`. A body that is not JSON got
  axum's plain-text 400.
- **The fix.**
  - The exact EVM codes are mapped at the v2 exact handler's boundary, next to the signature mapping, so
    other chains keep their generic codes.
  - The generic ones are mapped in `x402-types`.
  - A transfer simulation that reverts for any other reason, for example a paused token, becomes
    `invalid_transaction_state`. Only errors that are not reverts stay `unexpected_*_error`.
  - A request without a network gets `invalid_payload`, and `network` is omitted instead of `""`.
  - A body that is not JSON gets the endpoint's JSON error shape with `invalid_payload`, keeping axum's
    status code.

Before: stock x402-rs and hemi.2 used `invalid_payment_expired`, `invalid_payment_early`,
`recipient_mismatch` and `asset_mismatch`. For a body that is not JSON they answered with a `text/plain`
body: "Failed to parse the request body as JSON: …".

After (HTTP 400, both endpoints), examples:

```json
{"isValid":false,"invalidReason":"invalid_exact_evm_payload_authorization_valid_before","invalidMessage":"Payment authorization is expired","invalidReasonDetails":"…same…","payer":"0xC5F46EdE7C19D96f982b2187C334d9CD9F0E8284"}
{"success":false,"errorReason":"invalid_exact_evm_payload_recipient_mismatch","errorMessage":"Payment recipient is invalid with respect to the payment requirements","transaction":"","network":"eip155:43111","payer":"0x7b1FFAe7245f74d7ba5901E9C694150ddF977a0d"}
{"success":false,"errorReason":"invalid_payload","errorMessage":"Payment asset is invalid with respect to the payment requirements","transaction":"","network":"eip155:43111","payer":"0x78523c398252CD83A8fA942F95E14972bfce8c1B"}
{"success":false,"errorReason":"invalid_payload","errorMessage":"Failed to parse the request body as JSON: key must be a string at line 1 column 2","transaction":""}
```

<details><summary>Upstream issue / PR draft</summary>

> **Title:** Report verification failures with x402 v2 §9 codes; JSON error bodies for unreadable requests
>
> Several `ErrorReason`s are not x402 v2 §9 codes: `invalid_payment_expired`, `invalid_payment_early`, `invalid_payment_amount`, `recipient_mismatch`, `asset_mismatch`, `chain_id_mismatch`, `accepted_requirements_mismatch`, `transaction_simulation`, `invalid_format`. This PR maps them as follows.
>
> - **EIP-155 v2 exact handler** (the codes §9 defines for the exact scheme on EVM): `…_authorization_valid_after`, `…_valid_before`, `…_value_mismatch`, `…_recipient_mismatch`.
> - **Generic, in `x402-types`**: `invalid_payload` (format, asset), `invalid_network` (chain id), `invalid_payment_requirements` (accepted ≠ requirements), `invalid_transaction_state` (simulation).
> - **Other reverts:** a transfer simulation that reverts for another reason is reported as `invalid_transaction_state` rather than an unexpected error.
> - **Requests without a network:** they get `invalid_payload`, and `network` is omitted rather than `""`.
> - **Bodies that are not JSON:** they get the endpoint's JSON error shape with `invalid_payload` instead of axum's plain-text rejection.
>
> Each mapping has a unit test.
</details>

### 0010 eip155: require exactly the required amount in the v2 exact scheme

- **The bug.** `assert_enough_value` only rejected `sent < required`. A payload authorizing 5000 for a
  1000 requirement verified, and settled 5000.
- **The fix.** `assert_exact_value` rejects any difference. It is used by the v2 exact EIP-3009 and
  Permit2 paths and reported as `invalid_exact_evm_payload_authorization_value_mismatch`. The TS
  reference compares with `!==`. `upto` and v1 are unchanged.

Before (hemi.2, critic's probe): required 1000, signed 5000, then `isValid: true`, and settle moved 5000.
After (HTTP 400): `{"isValid":false,"invalidReason":"invalid_exact_evm_payload_authorization_value_mismatch","invalidMessage":"Payment amount does not match the required amount", …}`.
Under-payment gets the same code.

<details><summary>Upstream issue / PR draft</summary>

> **Title:** exact scheme settles more than the required amount
>
> `assert_enough_value` accepts any authorized amount ≥ the requirement, so an `exact` payment authorizing 5× the price verifies and settles 5×. §9 defines `invalid_exact_evm_payload_authorization_value_mismatch` as "Payment amount does not exactly match the required amount", and the TS reference facilitator compares with `!==`. This PR adds `assert_exact_value` and uses it in the v2 exact EIP-3009 and Permit2 paths; `upto` (where the amount is a ceiling) and v1 are unchanged.
</details>

### 0011 eip155: one settlement per authorization; answer a pending one's retry from its transaction

- **The bug.** §9 makes `settlement_pending` non-terminal, and the TS SDK's resource server re-sends the
  same settle once, immediately (`settleWithPendingRetry`). Stock x402-rs kept no record of the first
  attempt, so the retry was settled from scratch: a second broadcast, or `invalid_transaction_state` once
  the first transaction had spent the nonce, although the payment went through. Meanwhile `/verify`
  still called the payment valid while its transaction was unmined.
- **The hemi.3 version of this patch was unsafe.** It answered success to *every* repeat of a pending
  payload for 15 minutes, and `/verify` still accepted the payload while it was unmined. A stock seller
  (verify, then handler, then settle) therefore served one payment several times.
- **The record.** The v2 exact handler keeps one record per payment authorization, keyed by chain, payer
  and EIP-3009 or Permit2 nonce. It is created when a settle starts and holds until the outcome is known:
  - While it exists, `/verify` of that authorization is refused with `invalid_transaction_state`. So is
    `/settle` of any other request carrying it. The authorization is committed to a settlement and must
    not pay for anything else.
  - A settle that ends in anything but `settlement_pending` drops the record when it ends, through a drop
    guard. The guard fires when the settlement's future is dropped, so up to hemi.5 it also fired when
    the client disconnected mid-settlement: hyper dropped the request, and with it the settlement, its
    record and its hash, even after the broadcast. Since 0015 the settlement runs on its own task, which a
    disconnect does not cancel, so the guard fires only when the settlement itself ends.
  - A retry of the very same request sends nothing and is answered from the receipt, as below.
  - Records live in memory, are bounded (10,000, oldest dropped first) and expire after 15 minutes.
    Since 0020 these limits apply only to records that outlive their settle.
- **How a retry of the same request is answered** (same payload, signature and requirements):
  - not mined yet: `settlement_pending` with the same hash;
  - mined, for the first retry that sees it: success with the hash. That retry also removes the record,
    under the same lock as the check (`PendingSettlements::claim`), so two concurrent retries cannot
    both get the success;
  - every later settle of the payload: a replay, `invalid_transaction_state`;
  - reverted: `invalid_transaction_state` with the hash, and the record is removed.
  This is what the TS reference's pending-settlement store does: its entry is cleared on success or
  terminal failure (`mechanisms/evm/src/shared/settleReceipt.ts`).
- **Why `/verify` answers `invalid_transaction_state`, not `settlement_pending`.**
  - `settlement_pending` is a settle outcome. §5.3.2 and §9 tie it to a broadcast transaction that the
    caller of `/settle` reconciles, and it means "retry this settle".
  - A `/verify` caller is deciding whether to run a handler. The answer it needs is "this authorization
    cannot pay for a new request": its nonce is committed to a transaction, exactly as for a spent
    authorization.
  - `invalidMessage` names the pending transaction, for operators.
- **Mined reverts.** Any settlement transaction that was mined but reverted is reported with its hash
  (`TransactionFailed`, HTTP 400), instead of `unexpected_error` with `"transaction": ""`.
- **Limits.**
  - The record is per process, so a restart forgets it, and a pending authorization is then judged by
    the chain alone.
  - If no client ever retries, the record expires after 15 minutes. Until then, `/verify` keeps refusing
    the authorization, which is spent by then anyway.
  - A proxy or client timeout on `/settle` shorter than `receipt_timeout_secs` loses the response with
    the hash, though not the record or the log line: see 0015.

What the e2e suite checks (`06-settlement-pending.test.ts`, automine off, 5 s receipt timeout):

1. `/verify` P → valid. `/settle` P → `settlement_pending` H (200).
2. `/verify` P → `invalid_transaction_state`, naming H. A retry → `settlement_pending` H at once, and
   no new transaction is sent.
3. One block is mined. A retry → `{"success":true,"transaction":H,…}`. The next settle →
   `invalid_transaction_state`, and so does `/verify`.
4. `payTo` was paid exactly once.
5. Two concurrent retries after mining give exactly one success.
6. The seller flow, with the SDK's `x402ResourceServer` plus `HTTPFacilitatorClient`, does
   verify → handler → settle with the SDK's automatic retry. Three requests with the same payment header
   run the paid handler once. (`seller/server.ts` itself listens on its own TCP port, which the test rules
   don't allow.)

<details><summary>Upstream issue / PR draft</summary>

> **Title:** One settlement per authorization: answer a `settlement_pending` retry from its transaction, refuse `/verify` while it is pending
>
> After `settlement_pending` (non-terminal per x402 v2 §9) the TS SDK's resource server retries the same settle once, immediately. x402-rs keeps no record of the first attempt, so the retry runs a fresh settlement (a second broadcast, or `invalid_transaction_state` once the nonce is spent), and `/verify` keeps calling the payment valid while its transaction is unmined, so a seller can run its handler again for the same payment.
>
> This PR keeps an in-memory record per payment authorization (chain, payer, nonce) from the start of a settle until its outcome is known. While it exists, `/verify` of the authorization and `/settle` of any other request carrying it return `invalid_transaction_state`. A retry of the identical request sends nothing and is answered from the receipt: `settlement_pending` with the same hash while unmined; success for the first retry that sees it mined, which removes the record atomically (so concurrent retries cannot both succeed and later settles are replays); `invalid_transaction_state` with the hash if it reverted. A settle that ends otherwise drops its record via a drop guard. Records are bounded (10,000) and expire (15 min). It also reports any mined-but-reverted settlement with its hash instead of `unexpected_error` with `"transaction": ""`. Unit tests cover the store, the claim and the keys.
</details>

### 0012 eip155: validate EIP-6492 signatures first; ignore a wrapper around the payer's own signature

- **The bugs.**
  - EIP-6492-wrapped signatures skipped 0003's signature-first rule: they were only checked inside the
    transfer simulation. With a tampered inner signature, an unfunded payer got `insufficient_funds` or
    412, and a funded one got `invalid_transaction_state` ("Multicall3: call failed").
  - `/settle` did not validate the signature at all before sending. For a payer without code it sent
    `Multicall3.aggregate3([factory.call(<calldata from the payload>), transfer])`. That is a call to a
    caller-chosen address with caller-chosen calldata, paid for by the facilitator, even when `/verify`
    had rejected the payload.
- **The fix.**
  - `assert_signed_by_payer` runs on verify and settle, for both methods, before balances, allowances
    and simulation. It now asks the EIP-6492 validator (`isValidSigWithSideEffects`, as an `eth_call`, so
    nothing is deployed for real) whether it accepts the wrapped signature.
  - A rejection or a revert is `invalid_exact_evm_payload_signature`. Only an RPC that cannot be reached
    stays an unexpected error.
  - `StructuredSignature::try_from_bytes` treats a wrapper around a 64/65-byte signature that recovers to
    the payer as the plain EOA signature. The payer's own key signed, so nothing needs deploying and the
    factory is never called.

**The Multicall3 deployment path**, as it stands after 0012: for a counterfactual wallet whose signature
the validator accepted, `/settle` sends one transaction to Multicall3 (`0xcA11…CA11`).
`aggregate3([Call3{factory, allowFailure: true, factoryCalldata}, Call3{token or proxy, allowFailure: false, transfer}])`

- **What it can do.** Run the factory call (deploying the wallet), then the same transfer as on the
  normal path. The transfer is still bound by the payer's signature, so the amount and recipient are
  the signed ones.
- **What it cannot do.** Spend anything the facilitator owns. Both calls are made by Multicall3
  (`msg.sender` is Multicall3), not by the facilitator signer, and Multicall3 holds no funds or
  approvals. Its only cost to the facilitator is gas.
- **What 0012 changes.** That gas is now spent only after the validator has shown, in a simulation, that
  this factory call yields a wallet that accepts the signature. Before, any payload could make the
  facilitator pay for an arbitrary factory call.

Before (hemi.3): unfunded payer → 400 `insufficient_funds` / 412 `permit2_allowance_required`; funded →
`invalid_transaction_state` "Multicall3: call failed". After (HTTP 400, verify and settle, funded or not):

```json
{"isValid":false,"invalidReason":"invalid_exact_evm_payload_signature","invalidMessage":"The EIP-6492 validator does not accept the signature for 0x11733Cd3111FAd509780dA54c7A189eAe9C6f0A0: server returned an error response: error code 3: execution reverted, data: \"0x\"","invalidReasonDetails":"…same…","payer":"0x11733Cd3111FAd509780dA54c7A189eAe9C6f0A0"}
```

A wrapper around the payer's own signature now verifies and settles as an EOA payment. The settle
transaction goes straight to the token or the x402 proxy, not to Multicall3.

<details><summary>Upstream issue / PR draft</summary>

> **Title:** EIP-6492: validate before balance checks and before settling; drop a wrapper around an EOA signature
>
> 1. An EIP-6492-wrapped signature is only checked inside the transfer simulation, after balance and allowance, so a tampered one from an unfunded payer gets `insufficient_funds` / 412 instead of an invalid signature. x402's exact EVM scheme checks the signature first.
> 2. `/settle` does not validate a wrapped signature before sending: for a payer without code it sends `Multicall3.aggregate3([factory.call(calldata), transfer])` with the factory and calldata taken from the payload, so any payload can make the facilitator pay gas for an arbitrary call (msg.sender is Multicall3, so no funds are at risk, only gas).
>
> This PR runs the EIP-6492 validator's `isValidSigWithSideEffects` (as an `eth_call`) on verify and settle before anything else is read or sent, reporting a rejection as an invalid signature, and treats a wrapper around a 64/65-byte signature that recovers to the payer as the plain EOA signature, so the factory is never called for it. Unit tests cover both, with alloy's mocked transport.
</details>

### 0013 facilitator-local: report a missing or unserved x402 version as `invalid_x402_version`

- **The bug.** A request whose top-level `x402Version` was 1, or missing, got `invalid_network`
  ("Unsupported chain") even for a served network, because its slug could not be read.
- **The fix.**
  - `FacilitatorLocal` first checks the top-level `x402Version` (`VerifyRequest::x402_version`) against
    the versions its handlers serve (`SchemeRegistry::supports_version`). A missing or unserved version
    gets `invalid_x402_version`: §9 "Protocol version is not supported".
  - `SchemeRegistry::with_handler` builds registries by hand for the tests.
  - A v2 request that names no network still gets `invalid_payload` (0009).

After (HTTP 400): `{"isValid":false,"invalidReason":"invalid_x402_version","invalidMessage":"Unsupported x402 protocol version",…}`.
`/settle` gives the same, with the network if the request names one.

<details><summary>Upstream issue / PR draft</summary>

> **Title:** Missing or unsupported `x402Version` is reported as `invalid_network`; x402 v2 §9 has `invalid_x402_version`
>
> A request with top-level `x402Version: 1` (to a v2-only facilitator) or none at all gets `invalid_network` "Unsupported chain", although the network is served. This PR checks the version first: `VerifyRequest::x402_version` reads it, `SchemeRegistry::supports_version` tells whether any handler serves it, and a missing or unserved version gets `invalid_x402_version`. It also adds `SchemeRegistry::with_handler` for registries built by hand. Unit tests cover v1, a missing version and `{}`.
</details>

### 0014 eip155: report a Permit2 spender other than the exact proxy as `invalid_payload`

- **The bug.** `assert_offchain_valid` mapped a permit whose spender is not the x402 exact proxy to
  `RecipientMismatch`, i.e. `invalid_exact_evm_payload_recipient_mismatch`. For an EOA payer the
  signature-first rule (0003) answered first, with an invalid signature, because the signature's EIP-712
  hash is built with the proxy as spender.
- **The fix.** `assert_exact_proxy_spender` runs before the signature check and reports `invalid_payload`.
  The spender never receives funds: the proxy is what binds the transfer to the witness's recipient, so
  another spender makes the payload unusable. The TS reference also checks the spender first
  (`permit2.ts` 119–128), with its own code `invalid_permit2_spender`. §9 has no spender code, so this
  facilitator uses `invalid_payload`.

e2e: a permit re-signed with a random spender gets `invalid_payload` from `/verify` and `/settle` (400 in
this patch; a verdict, 200, since 0018).

<details><summary>Upstream issue / PR draft</summary>

> **Title:** Permit2: a spender other than the exact proxy is reported as a recipient mismatch
>
> `assert_offchain_valid` returns `RecipientMismatch` for a permit whose spender is not `EXACT_PERMIT2_PROXY_ADDRESS`, and since the EIP-712 hash is built with the proxy as spender, a payload signed for another spender usually fails earlier as an invalid signature. The spender is not the recipient; another spender makes the payload unusable. This PR adds `assert_exact_proxy_spender`, run before the signature check (as the TS reference does), reporting `InvalidFormat`, i.e. x402 v2 §9 `invalid_payload`. Unit test included.
</details>

### 0015 facilitator-local: finish a settlement whose client disconnected; log every broadcast

- **The bug.** `post_settle` awaited the settlement inside the request's future. When the client
  disconnects, or a proxy or client timeout in front of the facilitator gives up, hyper drops that future
  and the settlement with it, wherever it was suspended. After the broadcast that is the receipt wait. The
  transaction is still mined and pays out, but:
  - 0011's drop guard removed the authorization's record, so `/verify` of the same payload called it valid
    again while the transaction was unmined, and a retry was settled from scratch: it could send a second
    transaction for the same authorization, which reverts once the first is mined;
  - the hash was neither returned nor logged, so nobody could reconcile the payment.
- **The fix.**
  - `post_settle` runs `Facilitator::settle` on its own tokio task, in the request's tracing span, and
    awaits its `JoinHandle`. A disconnect drops only the handle, which detaches the task: the settlement
    runs to its end and its outcome is recorded as for any other request. That is the receipt, or 0011's
    pending record naming the hash when the receipt does not arrive within `receipt_timeout_secs`. A
    settlement task that panics is answered with 500 `unexpected_settle_error`.
  - `send_transaction` (`chain/provider.rs`) logs every broadcast at info level before it waits for the
    receipt (`Transaction broadcast tx=<hash> from=<signer> to=<contract>`), and logs a warning with the
    hash when the receipt does not arrive (`Transaction receipt not available; settlement pending`).
  - `/verify` stays in the request's future: it sends nothing.
- **Timeouts in front of the facilitator.** Any proxy, load balancer or client timeout on `/settle` should
  be at least 90 s, the TS SDK's default. Sending and waiting take up to `receipt_timeout_secs` (60 s in
  `facilitator/config*.json`) plus 5 s (0026), a stalled RPC can hold the last look for 8 s more (0028), and the checks before the
  broadcast come on top. With a
  shorter timeout the caller loses the response, and with it the hash,
  although the settlement completes. The hash is then in the facilitator's log. A retry of the same request
  is answered from it once the receipt wait has ended.
- **Limits.**
  - Between the hang-up and the end of the receipt wait the settlement is still running. `/verify` and an
    identical `/settle` both get `invalid_transaction_state` ("A settlement of this payment authorization
    is in progress"), without the hash. Once the wait ends, 0011's rules apply, and 0016 keeps a success
    that arrives during the wait. The hash is not
    written to the record at the moment of broadcast: that needs a hook in the provider, and the record
    would then have to stop a retry from claiming the success while the original request is still waiting
    for the same receipt.
  - A shutdown or restart still ends a detached settlement: axum's graceful shutdown waits for open
    connections, not for detached tasks. The pending record is in memory anyway (0011). The broadcast log
    line is what survives.

Before (hemi.5, i.e. patches 0001–0014), with automine off and `receipt_timeout_secs` 5: the client hangs up
once the transaction is in the mempool, and `/verify` of the same payload then answers

```json
{"isValid":true,"payer":"0x90F79bf6EB2c4f870365E785982E1f101E93b906"}
```

while the transaction is unmined, and nothing in the log names it.

After, same steps: `/verify` answers 400 `invalid_transaction_state` while the settlement waits for its
receipt, then names the transaction:

```json
{"isValid":false,"invalidReason":"invalid_transaction_state","invalidMessage":"A settlement of this payment authorization is pending in transaction 0x91579799f47ad52d12e7c2031ce51b5529f411064f79dedb758ee02c5cf09cda","invalidReasonDetails":"A settlement of this payment authorization is pending in transaction 0x91579799f47ad52d12e7c2031ce51b5529f411064f79dedb758ee02c5cf09cda","payer":"0x90F79bf6EB2c4f870365E785982E1f101E93b906"}
```

and the log has these lines (spans shortened). The client hung up right after the first; the warning
comes from the detached settlement, still in the request's span:

```text
06:38:40.673  INFO http_request{… uri=/settle …}:post_settle:settle{…}:…: x402_chain_eip155::chain::provider: Transaction broadcast tx=0x91579799f47ad52d12e7c2031ce51b5529f411064f79dedb758ee02c5cf09cda from=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC to=0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA
06:38:46.076  WARN http_request{… uri=/settle …}:post_settle:settle{…}:…: x402_chain_eip155::chain::provider: Transaction receipt not available; settlement pending tx=0x91579799f47ad52d12e7c2031ce51b5529f411064f79dedb758ee02c5cf09cda error=transaction was not confirmed within the timeout
```

The e2e test (`06-settlement-pending.test.ts`, automine off, 5 s receipt timeout):

1. `/settle` P; the test aborts the request once the facilitator's transaction H is in the fork's mempool,
   well before the receipt timeout.
2. `/verify` P → `invalid_transaction_state` throughout, naming H once the receipt wait has ended.
3. An identical `/settle` → `settlement_pending` H at once; the signer's pending nonce shows nothing new
   was sent.
4. One block is mined. A retry → `{"success":true,"transaction":H,…}`; the next settle is a replay.
5. `payTo` was paid exactly once, and the facilitator's log has H on the broadcast line and on the
   receipt warning.

Against patches 0001–0014 the test fails at step 2: `/verify` answers `isValid: true`.

<details><summary>Upstream issue / PR draft</summary>

> **Title:** A `/settle` cancelled by a client disconnect loses a broadcast transaction
>
> `post_settle` awaits the settlement inside the request future. When the client disconnects (or a proxy timeout fires) while the settlement waits for its receipt, hyper drops the future and the settlement with it. The transaction is already broadcast and still pays out, but its hash is never returned or logged, so neither the client nor the operator can reconcile the payment, and any per-request state the settlement keeps is lost with it.
>
> This PR runs the settlement on its own task (instrumented with the request span) and awaits the `JoinHandle`, so a disconnect detaches the settlement instead of cancelling it; a panic in it is answered with 500 `unexpected_settle_error`. `Eip155ChainProvider::send_transaction` logs each broadcast hash at info level before waiting for the receipt, and a warning with the hash when the receipt is unavailable. `post_settle` now requires the state to be `Clone + Send + Sync + 'static`, as `routes()` already did. Unit test: a handler aborted in the middle of a settlement; the settlement still completes.
</details>

### 0016 eip155: keep a success whose caller left for that caller's retry

- **The bug** (critic, hemi.6, fork with automine off and a 60 s receipt timeout). The client hangs up
  1.6 s after the broadcast. A retry during the receipt wait gets "in progress". A block is mined and
  `payTo` is paid. The settlement, still running since 0015, sees the receipt and ends in success, with
  nobody to receive it, and its drop guard removes the record. The next identical retry, and `/verify`,
  get `invalid_transaction_state` ("Payment authorization was already used on chain") with
  `"transaction": ""`. The buyer is charged and not served, and the hash is only in the log.
- **The fix.**
  - `x402-types`: `SettleCaller` tells a settlement whether its caller is still waiting.
    `Facilitator::settle_for` and `X402SchemeFacilitator::settle_for` take one. Their defaults ignore it
    and call `settle`, so other implementations (v1, other chains, other facilitators) are unaffected.
  - `facilitator-local`: `post_settle` passes a `SettleCaller` that turns false when the handler's future
    is dropped, i.e. when the client disconnects (a guard sets an `AtomicBool` on drop).
  - v2 exact EVM: a settlement that succeeds after its caller left keeps its record, naming the
    transaction, exactly as a `settlement_pending` one does (0011). The first identical retry claims the
    success through the same atomic `claim`; later settles and `/verify` are replays. Any other request
    carrying the authorization still gets `invalid_transaction_state`, now naming the transaction. A retry
    whose own caller has left does not claim it either. The record still expires after 15 minutes. It logs
    `Settlement succeeded after its caller left; kept for a retry of the same request tx=<hash>`.
- **Limits.**
  - A client that disconnects in the instant between the settlement's check and the response being
    written still loses that success.
  - A retry during the receipt wait is still answered "in progress" (0015, Limits).

Before (hemi.6, HTTP 400), the identical retry after the block was mined:

```json
{"success":false,"errorReason":"invalid_transaction_state","errorMessage":"Payment authorization was already used on chain","transaction":"","network":"eip155:43111","payer":"0x90F79bf6EB2c4f870365E785982E1f101E93b906"}
```

After, and the facilitator's log for H (spans shortened; the client hung up right after the first line):

```json
{"success":true,"transaction":"0x31e0981902bdd7da5c8a76156372a3c220ea39f15cab5a9c2b703ddf7357dea2","network":"eip155:43111","payer":"0x90F79bf6EB2c4f870365E785982E1f101E93b906"}
```

```text
07:26:52.884  INFO …: x402_chain_eip155::chain::provider: Transaction broadcast tx=0x31e0981902bdd7da5c8a76156372a3c220ea39f15cab5a9c2b703ddf7357dea2 from=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC to=0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA
07:26:53.652  INFO …: x402_chain_eip155::v2_eip155_exact::facilitator: Settlement succeeded after its caller left; kept for a retry of the same request tx=0x31e0981902bdd7da5c8a76156372a3c220ea39f15cab5a9c2b703ddf7357dea2
```

The e2e test (`06-settlement-pending.test.ts`, second block) runs against the container as
`facilitator/config.json` configures it. Its receipt timeout (60 s) leaves the settlement time to see the
block before the wait ends.

1. `/settle` P; the test aborts the request once H is in the fork's mempool.
2. An identical `/settle` during the receipt wait → `invalid_transaction_state`, in progress.
3. One block is mined; `payTo` is paid.
4. `/verify` P is refused throughout, and names H once the settlement has seen the receipt, before the
   receipt timeout.
5. Another request with the same authorization (different `maxTimeoutSeconds`) →
   `invalid_transaction_state` naming H, without taking the success.
6. The identical retry → `{"success":true,"transaction":H,…}`. The next settle is a replay, and so is
   `/verify`.
7. `payTo` was paid once; the signer sent one transaction; the log has the broadcast line and the kept
   success for H, and no receipt warning.

<details><summary>Upstream issue / PR draft</summary>

> **Title:** Let a settlement know its caller left, so that a handler can keep an undelivered success
>
> With the settlement running on its own task (previous PR), a settlement that completes after the client disconnected has nobody to report to. This PR adds `SettleCaller`, which tells a settlement whether its caller is still waiting, and `settle_for(request, caller)` on `Facilitator` and `X402SchemeFacilitator`, defaulting to `settle`. The HTTP handler passes one that turns false when its future is dropped. It is a building block: a scheme that remembers per-payment state, such as a pending-settlement store, can keep a success nobody received and answer the client's retry with it.
</details>

### 0017 facilitator-local: report an `x402Version` the payload contradicts as `invalid_x402_version`

- **The bug.** A request with top-level `x402Version` 2 and `paymentPayload.x402Version` 1 was routed by
  the top-level version to the v2 handler, which could not read the payload and answered
  `invalid_payload`. The payload is not malformed: the request disagrees with itself about its protocol
  version, which §9 reports as `invalid_x402_version` ("Protocol version is not supported").
- **The fix.** `VerifyRequest::payment_payload_x402_version` reads `paymentPayload.x402Version`.
  `PaymentVerificationError::InvalidX402Version(details)` is a version that cannot be read: no top-level
  `x402Version`, or one the payload contradicts. `FacilitatorLocal` checks it before routing, on
  `/verify` and `/settle`. `UnsupportedX402Version` keeps the case of a consistent version no handler
  serves. Both are reported as `invalid_x402_version`. 0018 answers the first with 400 and the second with
  200.

Before (hemi.6, HTTP 400): `{"isValid":false,"invalidReason":"invalid_payload",…}`. After (HTTP 400):

```json
{"isValid":false,"invalidReason":"invalid_x402_version","invalidMessage":"The request's x402Version is 2, but paymentPayload.x402Version is 1","invalidReasonDetails":"The request's x402Version is 2, but paymentPayload.x402Version is 1"}
```

e2e (`04b-payload-checks.test.ts`): top-level 2 with payload 1, top-level 1 with payload 2, no top-level
version, and `{}` all get `invalid_x402_version` with 400. Version 1 throughout gets
`invalid_x402_version` with 200.

<details><summary>Upstream issue / PR draft</summary>

> **Title:** A request whose `x402Version` contradicts `paymentPayload.x402Version` is reported as `invalid_payload`
>
> Routing uses the top-level `x402Version`, so `{"x402Version": 2, "paymentPayload": {"x402Version": 1, …}}` reaches the v2 handler, which fails to deserialize the payload and answers `invalid_payload`. This PR checks, before routing, that the top-level version exists and that the payload does not contradict it, and reports a failure as x402 v2 §9 `invalid_x402_version` with a message naming both versions (`PaymentVerificationError::InvalidX402Version`). Unit test included.
</details>

### 0018 facilitator-local: answer a rejected payment with 200, as the TS reference facilitator does

See [HTTP status codes](#http-status-codes) for the decision and the references. In short:

- 200 for every verdict on a payment that could be read, including `permit2_allowance_required` (was
  412), `invalid_network`, `unsupported_scheme`, an unserved version, a mined revert (was 400) and
  `settlement_pending` (already 200).
- 400 for a request that cannot be read: `InvalidFormat` (`invalid_payload`) and `InvalidX402Version`.
  A body that is not JSON keeps axum's status.
- 500 for `OnchainFailure` (`unexpected_*_error`).
- `PaymentVerificationError::InvalidPermit2Spender` takes over 0014's spender check from `InvalidFormat`.
  It is still `invalid_payload`, but a verdict on a readable payload, so 200.

Unit tests cover the status of every case and parse a 200 rejection the way `x402-axum` does.

e2e: every rejection test now expects 200 (`tests/lib/spec.ts` `STATUS_VERDICT`), and unreadable requests
400 (`STATUS_UNREADABLE`). `04c-stock-seller.test.ts` checks what a stock TS seller makes of it.

<details><summary>Upstream issue / PR draft</summary>

> **Title:** Answer rejected payments with 200 like the TS reference facilitator; a 400 makes a stock TS seller report "<code>: <message>"
>
> x402-rs answers a rejected `/verify` or `/settle` with 400, and a missing Permit2 allowance with 412. The TS reference facilitator (`examples/typescript/facilitator/basic/index.ts`) sends whatever `verify`/`settle` returns with `res.json` (200), and 400 only for a body it cannot read. The TS `HTTPFacilitatorClient` turns any non-2xx answer into a `VerifyError`/`SettleError` whose message is `"<code>: <message>"`, which `x402HTTPResourceServer` then puts into its 402 instead of the bare x402 v2 §9 code; and since it only answers 412 when that error is exactly `permit2_allowance_required`, a missing allowance reaches the buyer as 402. This PR answers every verdict on a readable payment with 200, keeps 400 for `InvalidFormat` and an unreadable `x402Version`, and 500 for `OnchainFailure`. A Permit2 spender mismatch gets its own variant (`InvalidPermit2Spender`, still `invalid_payload`) so that it is a verdict. `x402-axum` reads the bodies of 200, 400 and 412 alike, so it is unaffected; a unit test parses a 200 rejection as it does.
</details>

### 0019 eip155: tip at least the node's suggested priority fee

**Problem.** On an EIP-1559 chain, `send_transaction` left the fees to alloy's `GasFiller`. alloy's
default estimate takes the median of the non-zero 20th-percentile tips of the last ten blocks and falls
back to a 1-wei tip when there are none (`EIP1559_MIN_PRIORITY_FEE`, alloy-provider 2.0.5
`utils.rs`). Hemi's blocks are often empty apart from the L1-info deposit, whose tip is 0, so the
fallback is common. Hemi testnet's sequencer did not mine a 1-wei tip, while a tip of 0.001 gwei
(1,000,000 wei) was mined in the next block. Hemi mainnet's mines tips as low as 21 wei, so there the floor is a precaution that
costs about 1e-7 ETH per settlement. On testnet, such a settlement is broadcast, its receipt times out, the buyer gets
`settlement_pending`, and since 0006 keeps the nonce, every later settlement queues behind it.

Seen live on Hemi testnet with the same estimator, through `cast send` (DECISIONS D-018): a 1-wei-tip
transaction stayed pending while empty blocks were produced, and the same transaction with a 1,000,000
wei tip was mined in the next block. The forks never showed it, because anvil mines any tip.

**Change.** On EIP-1559 chains `send_transaction` now sets both fees itself. It reads alloy's estimate
and `eth_maxPriorityFeePerGas`. The tip is the larger of the two, and the max fee is the estimate's
base-fee headroom (twice the base fee) plus that tip. A node that does not answer
`eth_maxPriorityFeePerGas` keeps alloy's estimate. Legacy chains are unchanged. The cost is one more RPC
read per settlement.

**Tests.** Unit tests for `fees_with_tip_floor`. e2e `07-priority-fee.test.ts` mines twelve empty blocks
on each fork, checks that the fee history has no tips and that anvil suggests 1 gwei, then settles and
reads the transaction: its tip must be at least the suggestion. Against hemi.7 it fails with a 1-wei tip
on both forks.

**Live.** Neither live Hemi testnet settlement demonstrates the patch. Before the USDC.e one, the fee
history held 1,000,000-wei tips from the deployment and the buyer's approval, so alloy's estimate was the
same. Before the hBTC one, alloy's estimate was 999,997 wei, and the floor raised it by 3 wei (D-018).

<details><summary>Upstream issue / PR draft</summary>

> **Title:** Settlements on quiet OP Stack chains tip 1 wei and are never mined; use eth_maxPriorityFeePerGas as a floor
>
> On EIP-1559 chains the facilitator relies on alloy's default fee estimate. When the last ten blocks carry no non-zero tips, which is common on quiet L2s where most blocks only hold the L1-info deposit, alloy falls back to a 1-wei tip. A sequencer with a minimum tip does not include such a transaction, so the settlement is never mined, the receipt times out, and the signer's nonce is stuck. This PR reads `eth_maxPriorityFeePerGas` alongside the estimate and uses it as a floor for the tip, keeping the estimate's base-fee headroom in the max fee. Nodes without the method keep the old behaviour. Observed on Hemi testnet (chain 743111): a 1-wei tip stayed unmined, and a tip of 1000000 wei, the value its node answers to `eth_maxPriorityFeePerGas`, was mined in the next block.
</details>

### 0020 eip155: a settlement owns its record until it ends

**Problem.** A settle's guard found its record by authorization alone, and at 10,000 records the oldest
was evicted whether its settle was still running or not. A record is created before any check, and a
request with no token name or version then waits in the throttled RPC queue before its signature is
read, so 10,000 live records take no valid signature and no gas. Once a running settle A was evicted, a
settle B of the same authorization could begin. A's guard then acted on B's record:

- `keep` wrote A's transaction into it, so a retry of B got success with A's hash. That retry is answered
  from the record without any check, so B could even be a forged request.
- The drop deleted it while B was running, so a third settle could run alongside B.

`/verify` keeps a forged payload away from a stock seller. A correctly signed second request carries the
same payer, nonce, recipient and amount, so no funds move wrongly, but one payment could be delivered
twice. A store-level test reproduced both effects at the default capacity. The full exploit over HTTP was
not run.

**Change.** A record names the settle that began it, and `keep` and the drop act only on their own
record. A running settle's record neither expires nor is evicted. Running records are bounded by the
tasks that run them, so the capacity now bounds kept records, and it is enforced in `keep`. A settle
refused during its checks can no longer push anything out.

**Tests.** Unit tests: a running settlement neither expires nor is evicted; running settlements do not
push out a kept record; a settle cannot touch the record of a later settle.

### 0021 eip155: broadcast a transaction to one RPC at a time

**Problem.** `FallbackLayer` sends a request to every RPC at once and returns the first response, and a
JSON-RPC error counts as one. Only `eth_sendRawTransactionSync` and `eth_sendTransactionSync` are exempt,
so with two RPCs `eth_sendRawTransaction` went out twice. The node that saw a copy second rejected it.
When that rejection arrived first, the send failed although the other copy was mined. The nonce cache was
reset, and the payment's nonce was by then spent, so the failure was reported as a replay
(`invalid_transaction_state`). The payer was charged, and the seller refused service.

Reads fanning out is harmless, so this stayed hidden. The e2e suite's primary RPC is dead, so only one RPC
ever answered. `buyer/demo-fork.sh` points both RPCs at one fork, and it failed intermittently. DECISIONS
D-019 has the measurements. The live RPCs were not measured.

**Change.** `eth_sendRawTransaction` is a sequential method. It goes to the best-ranked RPC and moves on
only if that RPC cannot be reached. Reads are unchanged.

**Trade-off.** One copy of a transaction means one node has to forward it. A node's rejection is now the
answer, even if the other RPC would have taken the transaction. A transaction whose node drops it ends in
`settlement_pending` with a hash that never mines, which a retry cannot fix (see D-019). Before, a mined
settlement could be reported as failed, which was worse: no later step could put that right. A stalled RPC
also held a send with no limit, until 0022.

**Tests.** Unit tests through alloy's mock transport, with RPCs that answer on a later poll: a transaction
goes to one RPC and a read to all; a transaction moves on from an RPC it cannot reach; a node's rejection
is not sent to another. e2e `08-one-broadcast.test.ts` puts a recording proxy on each of two live RPCs in
front of one fork, settles three payments and counts the broadcasts. It fails without this patch.

### 0022 eip155: a stalled RPC can neither hold a settlement nor lose one

**Problem.** Since 0021 a transaction waits for its one RPC. `Http` had no timeout, and the sequential
fallback moves on only on a transport error, so an RPC that accepts the connection and never answers held
the send with no limit. Reads race and the loser records nothing, so a stalled RPC stayed the first choice.
On a fork with a stalled primary, hemi.9 gave `/settle` no answer in 100 s, past the 60 s receipt timeout
and the TS SDK's 90 s, and every other settlement hung behind it. hemi.8 settled the same case in 2.7 s.
When the sockets dropped, the detached settlement went on and paid after the client had left. D-013 sets
the receipt timeout because stalled RPCs are expected on Hemi, so this is an expected condition.

**Change.** Two parts, and the first needs the second.

1. Every RPC request ends after 10 s (`RPC_REQUEST_TIMEOUT`). That counts as a transport error, so the send
   moves on and the failure counts against the RPC's rank. alloy scores the last ten results and latency,
   so the rank flips after a few failures. How many depends on the load, because the other RPC's throttle
   counts as latency: four were needed in one suite run. Until then each settlement pays about 10 s more. That holds for an RPC that stalls everything. One that stalls
   only sends keeps winning reads and keeps its rank.
2. The transaction is signed before the send, so its hash is known. If a send fails, `send_transaction`
   asks the RPCs for that hash, which 0024 makes a question to each one. If one knows it, the settlement
   carries on from the hash and the nonce is kept. If none does, the send failed as before. Without this, an RPC that forwards the transaction and
   then stalls would bring back what 0021 removed: the next RPC rejects the copy, and a mined settlement is
   reported as failed. The lookup needs no error text, and it runs only after a failed send.

**Left as it was.** If a node takes a transaction and no RPC can show it yet when the lookup runs, the send
still counts as failed. That is the ambiguous send listed under Limits in the main README.

**Tests.** A unit test ends a request to a listener that never answers. e2e `09-stalled-rpc.test.ts` puts a
proxy in front of the fork as each RPC, with a slower fallback so the primary ranks first, and stalls the
primary in two ways: before the send, and after forwarding the transaction. With only part 1, the second
case failed: the payment was mined and `/settle` reported failure.

**Live.** Both assets settled through hemi.10 on Hemi testnet, which covers the sign-first send path. Neither
run had a stalled RPC, so the timeout and the lookup are proven on forks only.

<details><summary>Upstream issue / PR draft</summary>

> **Title:** A stalled RPC hangs transaction sends once they are sequential; bound requests and check a failed send by hash
>
> `Http::new` has no request timeout, and alloy's sequential fallback moves on only on a transport error, so a node that accepts the connection and never answers holds `eth_sendRawTransaction` with no limit. This PR gives each RPC request a 10 s timeout. A timeout makes the send ambiguous, since the node may have forwarded the transaction and the next RPC will then reject the copy, so the transaction is now signed before the send and a failed send looks the hash up before it is reported as failed. Only relevant together with a one-RPC-at-a-time send.
</details>

### 0023 eip155: do not hold the nonce map while waiting for a nonce lock

**Problem.** `reset_nonce` kept a DashMap read guard across `nonce_lock.lock().await`, and `get_next_nonce`
calls `entry()`, which parks the OS thread until the shard is free. Under a stream of rejected sends every
tokio worker ends up parked, with nothing left to drive I/O. `/supported` stops answering, the container
still shows `running`, and it stays frozen after the RPCs recover. On four CPUs, 10 rejected settlements a
second froze hemi.10 in 5 of 5 runs, and hemi.9 in 3 of 4. This is upstream code, not a regression.

**Change.** Clone the `Arc` out of the map first, as `get_next_nonce` already does. **Tests.** A unit test
holds the lock, starts a reset, and checks that `entry()` still returns. It fails without the change.

### 0024 eip155: ask every RPC for a failed send's hash, for two blocks if it timed out

**Problem.** 0022's lookup went through the fallback layer, which takes the first answer, and `null` is one.
A node that had not seen the transaction could answer first while another held it. A mined settlement was
still reported as failed, with an empty hash, and the hash was in no log.

**Change.** Each RPC has its own lookup client, and any that knows the transaction settles it. A send that
timed out may have reached a node that alone holds the transaction until it is mined, so that search lasts
25 s, two of Hemi's blocks. The hash of a failed send is now logged in every case. 0027 widens this.

**Tests.** e2e only: `09-stalled-rpc.test.ts` has the primary stall on both the send and the lookup while
the fallback answers `null` twice. It fails on hemi.10.

### 0025 eip155: do not send a settlement whose tip floor could not be read

**Problem.** `suggested_tip.ok()` turned any failed read into "no suggestion", so an RPC that answered that
read with a JSON-RPC error sent the settlement out at alloy's 1-wei fallback. On Hemi testnet that
transaction is never mined, and its kept nonce stops settlement on the chain.

**Change.** Only -32601, a node without the method, keeps the estimate. Any other failure fails the
settlement before anything is sent and before a nonce is taken. **Tests.** A unit test for the error check,
and an e2e case that sends nothing on a failed read and then settles on the retry. It fails on hemi.10.

### 0026 eip155: bound a send and its receipt wait together

**Problem.** 0022 claimed a settlement stays under the TS SDK's 90 s, but counted only the sends and the
receipt wait. With both RPCs stalling sends, no block mined and each read 2 s late, `/settle` took 92.7 s,
and the SDK threw at 90 s before the hash came back.

**Change.** `send_transaction` has one budget, the receipt timeout plus 5 s, for its reads and sends. A slow
send shortens the receipt wait, and when the budget is gone the wait ends after its first reads, and the
transaction is reported as pending with its hash. The 60 s timeout leaves 25 s for the checks before the send. 0027 brings the search into the budget.
**Tests.** A unit test for the arithmetic. With no mining and both RPCs stalling sends, a review run measured
65.2 s at no read delay and 69.6 s at 2 s, against 92.7 s on hemi.10.

### 0027 eip155: search after any failed send no node answered, within the budget

**Problem.** The lookup could still report a mined settlement as failed in three ways, all reproduced on a
fork against hemi.11:

- A fast failure got one lookup. A gateway can forward a transaction and answer 5xx, or drop the connection,
  in under 10 s. The next RPC then rejects the copy, and the fallback layer reports only that rejection.
- The 3 s lookup limit hid a transaction from RPCs that answer in more than 3 s but under the 10 s limit.
- The search did not count against the budget, so a failing send reached 93 s, past the TS SDK's 90 s.

**Change.** Only a node's rejection of something other than a duplicate skips the search, so the search covers
timeouts, dropped connections, 5xx, and `already known` or `nonce too low`. Those two come from the error text.
It is only a hint to search, so a node that words them otherwise loses nothing but the search. The lookup
limit is 8 s. The search ends with the send's budget, which is a target: reads and lookups that have started
run to their own limits, so with every RPC slow a settle can still pass 90 s, with its hash in the log.

**Left as it is.** A gateway that forwards a transaction and then answers with any other JSON-RPC error looks
like a rejection. See Limits in the main README.

**Tests.** Unit tests for when the search runs. e2e cases: a 502 after forwarding, with the other RPC either
also answering 502 or rejecting the copy, and with `null` from the first lookups; and a send that every RPC
swallows, which fails and frees its nonce.

### 0028 eip155: a lagging RPC cannot hide a settlement's receipt

**Problem.** A read goes to every RPC and the first answer wins, and `null` from a node that has not seen the
block is an answer. A fast RPC that lags hid a receipt the other RPC had, for as long as it lagged. Reproduced
on a fork against hemi.13: the transfer was mined and `payTo` paid, the settle and three retries answered
`settlement_pending`, and they succeeded only once the RPC recovered. There were two routes:

- A retry read the receipt through the shared client (0011).
- The first settle waited in alloy's `get_receipt`. Once its block watcher has seen the transaction, one
  `null` ends the wait with an error, so the settle answered pending in 0.9 s. With the RPC frozen at an old
  block the watcher saw nothing, and the settle used the whole 60 s.

A stock seller retries once and then refuses, so the buyer was charged and not served.

**Change.** `find_receipt` asks each RPC on its own and takes the first real receipt. Only a receipt ends the
search early, and an RPC that stalls holds up no other. Both routes use it. The first settle polls every RPC
in place of alloy's watcher, every 7 s as alloy did, with a last look when the wait ends. A retry looks once.
With no RPC holding the receipt the answer is `settlement_pending`, as before. An RPC error now counts the
same as `null`, so a retry's `details` no longer carry it. `MetaTransaction.confirmations` was always 1 and
is gone, because a receipt is the one confirmation the wait gives.

These lookups now use each RPC's rate limit, shared with the fallback client, so the 4 per second on the
public RPC covers them. With a stalled RPC and no receipt yet, a retry answers after its 8 s lookup limit, and
the last look of a first settle can run 8 s past the wait, plus any queue at the throttle.

**Left as it is.** The other reads still take the first answer. They happen before a send, or after one
that failed, so a stale answer costs a rejection, a revert or a stuck send. On a replay the payment has already
moved: see **A replay through a lagging RPC** in the top-level README. The
one to know about is the nonce read in `PendingNonceManager`, at first use and after a failed send. A stale nonce is
rejected, or queues behind a transaction the node has not seen, so that settlement fails or stays pending. See
D-025.

**Tests.** Unit tests for `find_receipt`. `tests/e2e/10-stale-rpc.test.ts` keeps a fast primary stale through
each case: `null` receipts, frozen at an old block, a block during the wait, and a retry after
`settlement_pending`. All four failed on hemi.13.

### 0029 types: error codes for the exact bip122 scheme

- **What changes.** Adds the codes the `exact` scheme on `bip122` reports, with a
  `PaymentVerificationError` variant for each that carries its message:
  - `invalid_exact_bip122_payload_transaction_not_found`
  - `invalid_exact_bip122_payload_vout`
  - `invalid_exact_bip122_payload_recipient_mismatch`
  - `invalid_exact_bip122_payload_value_mismatch`
  - `invalid_exact_bip122_payload_unconfirmed`
  - `invalid_exact_bip122_pay_to`
- It also adds `PaymentVerificationError::InvalidPaymentRequirements(String)`, reported as §9
  `invalid_payment_requirements`. Until now only `AcceptedRequirementsMismatch` reached that code, with a
  fixed message. A scheme can now say which field of the requirements it cannot use.
- **HTTP status.** All are verdicts on a payment that could be read, so 0018's rule answers them with 200.
  The status test in `handlers.rs` lists them.
- **Naming.** §9 has no Bitcoin codes. These follow its exact EVM ones (`invalid_exact_evm_payload_*`).
  `docs/phase2/DESIGN.md` fixes the same strings for the TS side and the scheme spec.
- Existing variants and their serialization are unchanged. On its own the patch changes no behaviour.
- **Tests.** Each code serializes as written above, and each variant maps to its code and keeps its message.

### 0030 facilitator: register the bip122 chain and v2-bip122-exact

- **What changes.** The binary reads `bip122:<genesis hash prefix>` chains and serves `v2-bip122-exact` on
  them, behind the feature `chain-bip122`, which the image enables:
  - `config.rs`: the namespace arm. The chain's object is the crate's `Bip122ChainConfig`, shown under
    [The exact scheme on bip122](#the-exact-scheme-on-bip122).
  - `chain.rs`: `ChainProvider::Bip122`, and a registry built in two passes.
  - `schemes.rs`, `run.rs`: the builder and the registration.
- **Two passes.** A Bitcoin chain's provider holds the provider of the Hemi chain it names: the same
  `Arc<Eip155ChainProvider>` the EVM scheme uses, not a second one built from the same config. A second
  provider for the same signer would have its own nonce manager, so a BTC and a USDC.e settlement could take
  the same nonce. The registry builds every other chain first, then each Bitcoin chain from that map.
  `ChainProvider::from_config` on a Bitcoin chain alone is an error that says so.
- **Startup.**
  - A Bitcoin chain whose Hemi chain is not configured stops the facilitator with an error that names both.
  - One whose `settler` is unset or empty is skipped with a warning (`No X402BtcSettler address set`). The
    scheme registry then logs `No chain provider found` for it, and `/supported` does not list it. That keeps
    every config working on a chain that has no settler (Hemi testnet today), and needs no second set of
    config files.
  - With a settler set, the provider calls its `SETTLER()` and checks it is one of the Hemi signers. A failed
    check is a warning, not an error, so an RPC outage at startup cannot stop the EVM chains. With no contract
    at the address, verify and settle answer `unexpected_verify_error` / `unexpected_settle_error`. With a
    `SETTLER` that is not a signer, verify works and settle fails in gas estimation
    (`unexpected_settle_error`), before anything is sent.
- **Upstream.** The Cargo side (workspace member, dependency, feature) is in the build patch here, because
  the crate lives outside x402-rs's tree. Upstream, the crate would be `crates/chains/x402-chain-bip122` and
  this patch would carry those lines.
- **Tests.** The config parses next to its Hemi chain and serializes back; an unknown Bitcoin network, a
  settler that is not an address, and a missing `hemi` are refused; a missing Hemi chain is a startup error;
  an unset settler skips the chain; a Bitcoin chain cannot be built on its own.

## The exact scheme on bip122

[`crates/x402-chain-bip122/`](crates/x402-chain-bip122/) is committed as plain files rather than as a patch:
at 2,900 lines, 1,700 of them outside the tests, it would be an unreviewable diff, and upstream it is a new
directory. The design, with the scheme's fields and the settler ABI, is `docs/phase2/DESIGN.md`; decisions
and measurements are in `docs/phase2/facilitator.md`.

**Configuration** (`facilitator/config*.json`):

```json
"bip122:000000000019d6689c085ae165831e93": {
  "hemi": "eip155:43111",
  "settler": "$X402_BTC_SETTLER_MAINNET",
  "min_confirmations": { "default": 1, "floor": 1, "ceiling": 6 }
}
```

`settler` is a literal or a `$VAR`; unset or empty skips the chain (0030). `min_confirmations` is in Bitcoin
confirmations: `default` applies when the requirements name none, and a seller's `extra.minConfirmations`
must be within `floor` and `ceiling`. Testnet3 (`bip122:000000000933ea01ad0ee984209779ba`) records on
`eip155:743111` with `$X402_BTC_SETTLER_TESTNET`. Other keys are ignored, as on an EVM chain, and logged as a
warning at startup (`Ignoring keys a bip122 chain does not read`): the e2e suite sets
`receipt_timeout_secs` on every chain of the config it mounts.

**What it does.**

- **Requirements.** `asset` `BTC`; `amount` in satoshis; `payTo` the seller's account xpub (`xpub` on
  mainnet, `tpub` on testnet3; SLIP-132 `zpub`/`vpub` are read as P2WPKH-only keys); `extra.assetTransferMethod`
  `utxo`, `extra.paymentFlow` `upfront`, `extra.paymentId` 32 lowercase hex, `extra.addressType` `p2wpkh`
  (default) or `p2tr`, `extra.minConfirmations` optional. `maxTimeoutSeconds` is accepted, not enforced: a
  Bitcoin transaction does not expire.
- **Payload.** `{ "txid": "<64 hex, display order>", "vout": <n> }`.
- **Derivation.** `d = sha256("x402-btc" ‖ paymentId)`, then `i1`, `i2`, `i3` = bytes 0..4, 4..8 and 8..12 of `d`
  as big-endian `u32 & 0x7fffffff`, child `0/i1/i2/i3` of `payTo`, then P2WPKH or BIP86 P2TR, with the
  `bitcoin` crate. Three levels, because with a single 31-bit index anyone holding the xpub could
  precompute every child, match a payment seen in the mempool, find a `paymentId` with the same index in
  about 2^31 hashes and settle it for their own request (DESIGN.md, revised 2026-11-09). The facilitator
  derives from `accepted.extra.paymentId`, never from the seller's copy of the requirements, which may
  carry a newer one. The TypeScript package's `btc/test-vectors.json` (16 cases: xpub and tpub, p2wpkh and p2tr) is
  copied into the crate and reproduced by a unit test.
- **Verify.** The checks in the order of the table above, then an `eth_call` of the settler's `verify`.
  Valid answers `{"isValid": true}` with no `payer`: a Bitcoin payment has inputs, not one paying address.
- **Settle.** The same checks and the settler's `verify` first, then a record of (network, txid, vout),
  then the settler's `settle(…, paymentRef = sha256(paymentId))` through the Hemi provider's
  `send_transaction`. The checks come before the record, unlike the EVM scheme's "records before checks"
  (0020): the record id here is the Bitcoin output, which anyone can read on chain, so a request that
  fails its checks (a forged `paymentId`, for one) must never hold it, or a watcher could block the
  payment's settlement (D-037). The
  record is the EVM scheme's `PendingSettlements` (0011, 0016, 0020), keyed by the output, and a retry is
  the same `accepted` and payload: the seller's copy of the requirements is left out of the key, so a stock
  seller's retry with a fresh `paymentId` there is still recognised. Success is
  `{"success": true, "transaction": "<bitcoin txid>", "network": "bip122:…"}`: the transaction is the
  payment on that network. The Hemi hash is in the broadcast log line (0015) and in the contract's
  `Settled` event. `settlement_pending` and a mined revert carry the Hemi hash, since that is the
  transaction the facilitator broadcast.
- **Supported.** One kind per network, with `extra` `{asset, assetTransferMethod, paymentFlow,
  addressTypes, minConfirmations, settler, hemiNetwork}`, and the Hemi signer under the `bip122` network in
  `signers`.

**Tests.** 43 unit tests: the shared derivation vectors and rejections, P2TR, SLIP-132 and network mismatches, private and
unsupported keys, every parse failure, each verdict to its code on verify and on settle, the settle
flows against a mock settler (success and replay; pending, retry from the record, mined, one success, then
replay; revert; a success whose caller left; Hemi unreachable), the confirmation policy, `/supported`, the
config, and the ABI selectors and decoding. The end-to-end test, `tests/e2e/11-btc-l1.test.ts`,
runs the scheme against the real `X402BtcSettler` and a mock hBK on the forks.

## What these patches do not change

- **v1 and `upto` keep x402-rs's own behaviour.** The changes specific to the v2 exact handler are:
  - the exact EVM codes;
  - the check of the signature first, including EIP-1271;
  - the exact amount;
  - the pending-settlement record;
  - EIP-6492 validation first.
  The generic code mappings in `x402-types`, and 0015's settlement task, apply to every chain and scheme.
- **Unknown payers are omitted.** v1 handlers and non-EVM chains don't implement `payer`, so their error
  bodies leave the field out. The spec allows that.
- **No payer for Bitcoin.** The `bip122` scheme omits `payer` on success and on a valid verify too: a
  Bitcoin payment has inputs, not one paying address.
- **`invalidReasonDetails` remains.** It is the one non-spec field, kept for compatibility (see above).
- **Untested end to end:**
  - The successful EIP-6492 deployment path (a real counterfactual wallet and factory). The suite has no
    wallet factory. It does test rejected wrapped signatures (funded and unfunded, both methods, nothing
    sent) and the EOA-wrapper shortcut.
  - A mined settlement revert. The unit tests cover it.
  - The `bip122` scheme on Bitcoin testnet3: no settler is deployed on Hemi testnet. On forks the scheme
    runs against the real `X402BtcSettler` and a mock hBK (`tests/e2e/11-btc-l1.test.ts`), and one live
    payment has settled on mainnet (DECISIONS.md D-040).
