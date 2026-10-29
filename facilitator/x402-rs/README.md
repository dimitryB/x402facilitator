# x402-rs patches

The facilitator image is x402-rs at commit `e75adda8a0e3cf23db446883ba91b88bbab2fe28` plus the patches in
[`patches/`](patches/), built by [`../Dockerfile`](../Dockerfile). Stock x402-rs cannot return the x402 v2
spec's error shapes, and no setting in `config.json` changes that. The Definition of done requires those
shapes (a failed signature and an insufficient balance must "return the spec's error shapes").

Each patch is small, does one thing, has unit tests and is meant to go upstream. None changes what gets
settled, to whom, or for how much. What they change:

- which error is returned, and with which fields (all patches);
- the order of the checks: the signature first, then allowance before balance (0003, 0004);
- one piece of transaction handling: after a broadcast transaction's receipt times out, the signer's
  nonce is kept instead of reset, so that the next settlement cannot reuse it (0006).

HTTP status codes follow x402-rs's existing mapping: 400 for a rejected payment, 412 for a missing Permit2
allowance, 500 for an unexpected failure. The one addition is `settlement_pending`, answered with 200 (see 0006).

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

[`build/0001-build-EVM-only-workspace-for-the-hemi-x402-image.patch`](build/) is **not** for upstream. It
cuts the workspace down to the EVM facilitator, which removes Solana, Aptos and TRON. A full workspace
resolve clones `aptos-core`, which is very large. `build/check-lock-subset.sh` checks that the pruned
`Cargo.lock` only removed packages: every remaining crate keeps the version and checksum upstream locked.

## Check order after the patches

The spec gives an order for the exact scheme on EVM. EIP-3009 lists: signature, balance,
amount/validity window, token/network, simulation (`scheme_exact_evm.md` EIP-3009 Phase 2). Permit2 says
"The verifier must execute these checks in order": signature, allowance, balance, amount, deadline and
validAfter, token/network, simulation (Phase 3). The patched facilitator, on both `/verify` and `/settle`:

| Step | EIP-3009 | Permit2 |
|------|------|------|
| 1 | `accepted` equals the requirements; network | **signature** |
| 2 | **signature** | `accepted` equals the requirements; spender; recipient; deadline and validAfter; amount; token |
| 3 | recipient; validity window; amount | **allowance** (412 `permit2_allowance_required`) |
| 4 | **balance** (`insufficient_funds`) | **balance** (`insufficient_funds`) |
| 5 | simulation (verify) or send (settle) | simulation (verify) or send (settle) |

The **signature check** reads nothing from the chain unless it needs to:

- An EOA signature must recover to `from`, which needs no RPC.
- A signature that does not recover to `from` is accepted only as EIP-1271, so `from` must have code. This
  costs one `eth_getCode`, and only on this path.
- An EIP-6492 signature (a counterfactual wallet) is still checked by the on-chain validator.

As a result, an unfunded, unapproved payer with a bad signature gets `invalid_exact_evm_payload_signature`.
Stock x402-rs answered `insufficient_funds` or `permit2_allowance_required` there.

One departure from the spec's numbering remains. The **off-chain checks** run before the on-chain
allowance and balance reads, although the spec lists them after: requirements match, spender, recipient,
validity window, amount and token. They need no RPC. So a payload that is both expired and unfunded is
reported as expired. The TS reference facilitator orders them the same way.

## Building

`docker compose build` from the repo root builds the image named in `docker-compose.yml`
(`hemi-x402-facilitator:e75adda-hemi.2` for this patch set). The stock image this replaces,
`ghcr.io/x402-rs/x402-facilitator@sha256:4ebe09d8…`, is kept in a comment there. The Dockerfile works with
the classic builder, which is all Colima's Docker CLI has without buildx. It runs these steps in order:

1. Fetch x402-rs at the pinned commit and check `git rev-parse HEAD`.
2. Apply the build patch, prune and check `Cargo.lock`, and compile all dependencies once against
   unpatched sources.
3. Apply each patch in order with `git apply --check`, then `git apply`, and build again.

If a patch has drifted, step 3 fails and names the patch. Measured on Colima (4 CPUs, 8 GB, Apple
silicon), with the base images already pulled:

- Cold build: 114 s. Of that, 57 s compiles the dependency graph and 12 s rebuilds after the patches.
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

The unit tests run with the build patch applied (`git apply <repo>/facilitator/x402-rs/build/*.patch`):

```sh
cargo test -p x402-types -p x402-facilitator-local -p x402-chain-eip155 \
  --features x402-chain-eip155/facilitator,x402-chain-eip155/telemetry
```

Every patch was checked one by one: `cargo fmt --check`, `cargo clippy --tests -D warnings`, and the
tests, with 20 new unit tests in total. `tests/` (`npm test -w tests`) runs the end-to-end suite against
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
facilitator emits them in alphabetical order.

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

Before, with automine off and `receipt_timeout_secs` 10: the critic's repro on the previous patch set,
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

Before: `"invalidReason": "unsupported_scheme"`, which the critic observed. With stock x402-rs, the
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

## What these patches do not change

- **Some reasons still use x402-rs names.** They have §9 equivalents, but no test in this repo triggers
  them and the Definition of done does not cover them:
  - `invalid_payment_early` / `invalid_payment_expired` (§9 `…_authorization_valid_after` / `…_valid_before`)
  - `invalid_payment_amount` (§9 `…_value_mismatch`)
  - `recipient_mismatch` (§9 `…_recipient_mismatch`)
  - `invalid_format` (§9 `invalid_payload`)
  - `chain_id_mismatch`, `asset_mismatch`, `accepted_requirements_mismatch` and `transaction_simulation`,
    which have no direct §9 code
- **v1 and `upto` keep `invalid_signature`.** Only the v2 exact handler maps signature failures to
  `invalid_exact_evm_payload_signature`, and only the v2 exact handler checks the signature first.
- **Unknown payers are omitted.** v1 handlers and non-EVM chains don't implement `payer`, so their error
  bodies leave the field out. The spec allows that.
