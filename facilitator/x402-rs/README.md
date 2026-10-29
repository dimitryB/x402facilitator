# x402-rs patches

The facilitator image is x402-rs at commit `e75adda8a0e3cf23db446883ba91b88bbab2fe28` plus the patches in
[`patches/`](patches/), built by [`../Dockerfile`](../Dockerfile). Stock x402-rs cannot return the x402 v2
spec's error shapes, and no setting in `config.json` changes that. The Definition of done requires those
shapes (a failed signature and an insufficient balance must "return the spec's error shapes").

Each patch is small, does one thing, has unit tests and is meant to go upstream. None changes what gets
settled or how. Each one only changes which error is returned, with which fields, and when the error is
detected. HTTP status codes follow x402-rs's existing mapping: 400 for a rejected payment, 412 for a
missing Permit2 allowance, 500 for an unexpected failure.

Spec references are to `x402-foundation/x402` at `e4a0868`:

- `specs/x402-specification-v2.md`: §5.3.2 SettleResponse, §5.4.2 VerifyResponse, §7.1 and §7.2 error
  examples, §9 error codes.
- `specs/schemes/exact/scheme_exact_evm.md`.

| Patch | Fixes | Spec |
|------|------|------|
| [0001](patches/0001-types-add-x402-v2-9-error-codes-to-ErrorReason.patch) | `ErrorReason` lacks the §9 codes x402-rs needs | §9 |
| [0002](patches/0002-facilitator-local-fill-payer-and-network-in-error-re.patch) | error bodies send `"payer": ""` and `"network": ""`, and `unexpected_error` | §5.3.2, §5.4.2, §9 |
| [0003](patches/0003-eip155-report-a-signature-not-made-by-an-EOA-payer-a.patch) | a bad EOA signature returns HTTP 500 `unexpected_error` | scheme_exact_evm.md, §9 |
| [0004](patches/0004-eip155-check-Permit2-allowance-before-balance-and-re.patch) | Permit2: allowance and balance are checked in random order, and not re-checked on settle | scheme_exact_evm.md Permit2 steps 2–3 |
| [0005](patches/0005-eip155-report-a-replayed-authorization-as-invalid_tr.patch) | a replayed authorization returns HTTP 500 `unexpected_error` | §9 |

[`build/0001-build-EVM-only-workspace-for-the-hemi-x402-image.patch`](build/) is **not** for upstream. It
cuts the workspace down to the EVM facilitator, which removes Solana, Aptos and TRON. A full workspace
resolve clones `aptos-core`, which is very large. `build/check-lock-subset.sh` checks that the pruned
`Cargo.lock` only removed packages: every remaining crate keeps the version and checksum upstream locked.

## Building

`docker compose build` from the repo root builds `hemi-x402-facilitator:e75adda-hemi.1`. The stock image
this replaces, `ghcr.io/x402-rs/x402-facilitator@sha256:4ebe09d8…`, is kept in a comment in
`docker-compose.yml`. The Dockerfile works with the classic builder, which is all Colima's Docker CLI
has without buildx. It runs these steps in order:

1. Fetch x402-rs at the pinned commit and check `git rev-parse HEAD`.
2. Apply the build patch, prune and check `Cargo.lock`, and compile all dependencies once against
   unpatched sources.
3. Apply each patch in order with `git apply --check`, then `git apply`, and build again.

If a patch has drifted, step 3 fails and names the patch. Measured on Colima (4 CPUs, 8 GB, Apple
silicon), with the base images already pulled:

- Cold build: 114 s. Of that, 57 s compiles the dependency graph and 12 s rebuilds after the patches.
- Rebuild after editing only a patch: about 15 s, because the dependency layer is cached.

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
tests, with 16 new unit tests in total. `tests/` (`npm test -w tests`) runs the end-to-end suite against
the built image on anvil forks.

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
  - `/verify` errors gain `invalidMessage` (§5.4.2). `invalidReasonDetails` stays, with the same text, so
    existing clients keep working.
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

### 0003 eip155: report a signature not made by an EOA payer as invalid

- **The bug.** `StructuredSignature::try_from_bytes` treats a 64/65-byte signature that does not recover
  to the payer as EIP-1271, so that smart wallets keep working. For an EOA payer, which has no code, that
  signature can never be valid. The facilitator still simulated it. The revert ("FiatTokenV2: invalid
  signature", or Permit2 `InvalidSigner()`) surfaced as a transport error: HTTP 500 `unexpected_error`
  from both `/verify` and `/settle`.
- **The fix.** Before simulating or sending an EIP-1271 signature, check that the signer has code. If it
  has none, the signature is invalid. This costs one `eth_getCode`, and only on that path.
- **What is unaffected.** EIP-1271 wallets have code, so they behave as before. EIP-6492 counterfactual
  wallets use wrapped signatures, which take a different path.
- **The code.** The v2 exact handler reports signature failures as `invalid_exact_evm_payload_signature`,
  the §9 code for this scheme, instead of `invalid_signature`.

Before (stock, EIP-3009 and Permit2, verify and settle alike):

```json
{"isValid":false,"invalidReason":"unexpected_error","invalidReasonDetails":"server returned an error response: error code 3: execution reverted: FiatTokenV2: invalid signature, data: \"0x08c379a0…\"","payer":""}
{"success":false,"network":"","transaction":"","errorReason":"unexpected_error","errorMessage":"server returned an error response: error code 3: execution reverted: custom error 0x815e1d64, data: \"0x815e1d64\"","payer":""}
```

After (HTTP 400):

```json
{"isValid":false,"invalidReason":"invalid_exact_evm_payload_signature","invalidMessage":"Signature was not made by 0x65b09DAA7a7a6B41091693D0Ef1AB36E855F4A32, which has no code to validate it as an EIP-1271 signature","invalidReasonDetails":"…same…","payer":"0x65b09DAA7a7a6B41091693D0Ef1AB36E855F4A32"}
{"success":false,"network":"eip155:43111","transaction":"","errorReason":"invalid_exact_evm_payload_signature","errorMessage":"Signature was not made by 0x03f76e34c2f465F1DA2e3c0FAF4c521335A781B5, which has no code to validate it as an EIP-1271 signature","payer":"0x03f76e34c2f465F1DA2e3c0FAF4c521335A781B5"}
```

<details><summary>Upstream issue / PR draft</summary>

> **Title:** A wrong EOA signature is reported as HTTP 500 `unexpected_error` instead of an invalid signature
>
> **Repro:** take a valid `exact` payload (EIP-3009 or Permit2) for an EOA payer, then flip one bit of the signature, or sign with another key and keep `from`. `/verify` and `/settle` both answer HTTP 500 `{"invalidReason": "unexpected_error", ...}` with the token's revert message.
>
> **Cause:** `StructuredSignature::try_from_bytes` treats a 64/65-byte signature that does not recover to `from` as EIP-1271, so that contract wallets work. The EIP-1271 path never checks whether `from` is a contract. It goes straight to the transfer simulation (verify) or the gas estimate (settle), and the revert surfaces as `Eip155ExactError::Transport`, then `OnchainFailure`, then `unexpected_error`.
>
> **Fix:** on the EIP-1271 path, read `from`'s code first (`assert_eip1271_signer_has_code`). Without code, the signature is invalid, and the payload is rejected before any simulation or transaction. This applies to `verify_payment`, `settle_payment`, `assert_onchain_exact_permit2` and `execute_permit2_settlement`. Deployed EIP-1271 wallets and EIP-6492 counterfactual wallets are unaffected. The v2 exact handler then reports `invalid_exact_evm_payload_signature`, the code x402 v2 §9 defines ("Payment authorization signature is invalid or improperly signed"). Unit tests use alloy's mocked transport.
</details>

### 0004 eip155: check Permit2 allowance before balance, and re-check both on settle

- **The ordering bug.** `scheme_exact_evm.md` (Permit2, Phase 3) checks the allowance (step 2, answered
  with 412 `PERMIT2_ALLOWANCE_REQUIRED`) before the balance (step 3). x402-rs ran both reads with
  `tokio::try_join!`, which returns whichever error arrives first. A payer with neither got 400
  `insufficient_funds` or 412 `permit2_allowance_required` at random: 3 and 2 times out of 5 calls with
  the same payload.
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

## What these patches do not change

- **`invalidReasonDetails` stays** next to `invalidMessage`, so clients of stock x402-rs keep working.
  The spec doesn't forbid extra fields.
- **v1 and `upto` keep `invalid_signature`.** Only the v2 exact handler maps signature failures to
  `invalid_exact_evm_payload_signature`. The v1 exact scheme and the `upto` scheme still report
  `invalid_signature`.
- **Unknown payers are omitted.** v1 handlers and non-EVM chains don't implement `payer`, so their error
  bodies leave the field out. The spec allows that.
