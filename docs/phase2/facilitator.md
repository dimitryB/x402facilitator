# Phase 2, stream B: the facilitator scheme in x402-rs

Stream B of [`DESIGN.md`](DESIGN.md) ("Stream B: the facilitator scheme in x402-rs"): the `exact` scheme on
`bip122` in the facilitator image, `hemi-x402-facilitator:e75adda-hemi.15`. Written by the stream B session
on 2026-11-09; the integration session merges it with streams A and C and records the D-entries.

Nothing here sent a transaction to a live network or called `/settle` on a facilitator connected to one.
`.env` was never read.

## What was built

| Piece | Where |
|------|------|
| Crate `x402-chain-bip122`: networks, config, provider, wire types, derivation, settler ABI and port, verify/settle/supported, 42 unit tests | [`facilitator/x402-rs/crates/x402-chain-bip122/`](../../facilitator/x402-rs/crates/x402-chain-bip122/) |
| 0029 `types: error codes for the exact bip122 scheme` | `facilitator/x402-rs/patches/0029-…` |
| 0030 `facilitator: register the bip122 chain and v2-bip122-exact` | `facilitator/x402-rs/patches/0030-…` |
| Build patch: workspace member, `bitcoin` 0.32, feature `chain-bip122` (off by default) | `facilitator/x402-rs/build/0001-…patch` |
| Lock allow-list, appended to `Cargo.lock` before `cargo fetch` | `facilitator/x402-rs/build/lock-additions.txt` |
| Lock check with the allow-list | `facilitator/x402-rs/build/check-lock-subset.sh` |
| Dockerfile: crate manifest before the build patch, `bitcoin` warmed, sources after, `--features chain-bip122` | `facilitator/Dockerfile` |
| Config: both Bitcoin networks in `config.json`, one each in `config.mainnet.json` / `config.testnet.json` | `facilitator/config*.json` |
| Compose: `X402_BTC_SETTLER_MAINNET` / `_TESTNET`, empty by default; image tag hemi.15 | `docker-compose.yml`, `.env.example` |
| README sections for the crate, 0029 and 0030, error-code table, Building | `facilitator/x402-rs/README.md` |

## Decisions

### B-1. Follow the verdict table on both endpoints

`TooFewConfirmations` is `invalid_exact_bip122_payload_unconfirmed` and `TxNotFound` is
`invalid_exact_bip122_payload_transaction_not_found`, on `/verify` and on `/settle`, as the stream B table in
DESIGN.md fixes. DESIGN.md's stream C list says "under-confirmed → `settlement_pending` with the txid", and its
buyer "continues only on `settlement_pending`". Those disagree with the table; see open question Q-1.

Reasons for the table: §9 ties `settlement_pending` to a transaction the facilitator broadcast and the caller
reconciles. Nothing was broadcast for an under-confirmed payment, and its `transaction` would be a Bitcoin txid
under a code whose other uses carry a Hemi hash.

### B-2. An unset settler skips the chain

`"settler": "$X402_BTC_SETTLER_MAINNET"` with the variable unset or empty skips that Bitcoin network, with a
warning in the log. A settler that is set but is not an address is a startup error, and so is a Bitcoin
chain whose `hemi` chain is not configured.

The alternative, failing at startup, would have needed separate config files for "with Bitcoin" and
"without", or broken every existing setup and the e2e suite until stream A deploys. With the skip, the
existing suite runs on hemi.15 with the shipped `config.json` unchanged.

### B-3. Startup checks the settler but only warns

With a settler set, the provider calls `SETTLER()` and checks it is one of the Hemi signers. A failure is
logged as a warning. The facilitator still starts, because an RPC outage at startup must not take the EVM
chains down with it. With no contract at the address, verify and settle answer `unexpected_verify_error` /
`unexpected_settle_error` (500). With a `SETTLER` that is not a signer, verify works and settle fails in gas
estimation with `unexpected_settle_error`, before anything is sent.

### B-4. The pending record is the EVM scheme's, keyed by the output

`x402_chain_eip155::…::pending::PendingSettlements` is public, so the scheme uses it as is. The record id is
`keccak256("bip122:<ref>/<txid>/<vout>")`. The request key is the hash of `accepted` and the payload only: the
seller's copy of the requirements is left out, because a stock TS seller rebuilds the 402 (with a fresh
`paymentId`) on every request, and its retry must still be recognised as the same payment. This gives 0011,
0016 and 0020 unchanged: one settlement per output at a time, a retry answered from the Hemi transaction, the
first retry that sees it mined gets the success and later ones are replays, a success whose caller left is
kept for that caller.

> **Changed at integration (D-037):** the critic showed that taking the record before the checks let anyone who saw the Bitcoin output hold it with a forged `paymentId` and block the real settlement. `settle_for` now runs `prepare` and `check` first and takes the record only for a request that passes.

### B-5. `AlreadyConsumed` is always a replay

The contract's `settledBy` would let a facilitator answer success when the output was settled with this
payment's own `paymentRef`. That would answer success to every later copy of a settled payment, which is the
"served twice" case 0011 exists to prevent, so it is not done. The in-memory record covers the retry of a
settlement this process ran.

### B-6. One more generic error variant

0029 adds `PaymentVerificationError::InvalidPaymentRequirements(String)` besides the six scheme codes. The
only variant that reached `invalid_payment_requirements` was `AcceptedRequirementsMismatch`, with a fixed
message, and a seller who sends `asset: "USDC"` on a Bitcoin network should be told which field is wrong.

### B-7. No payer, no Hemi hash in the success body

Success is `{"success": true, "transaction": "<bitcoin txid>", "network": "bip122:…"}`, and a valid verify is
`{"isValid": true}`. A Bitcoin payment has inputs, not one payer address. The Hemi settle hash is not in the
body: the stream B section of DESIGN.md defers that to a proto change. It is in the facilitator log
(`Transaction broadcast tx=…` from 0015, then `Bitcoin payment recorded on Hemi … hemi_tx=…`) and in the
contract's `Settled` event.

### B-8. The `bitcoin` crate, pinned by the lock fragment

`bitcoin` 0.32 (`default-features = false, features = ["std"]`) resolves to 0.32.11. It reuses upstream's
locked `bitcoin_hashes` 0.14.100, `bitcoin-io` 0.1.100, `hex-conservative` 0.2.2 and `secp256k1-sys` 0.10.1,
and adds nine packages (`bitcoin`, `base58ck`, `bech32` 0.11.1, `bitcoin-consensus-encoding` 1.3.0,
`bitcoin-internals` 0.7.0, `bitcoin-units` 0.1.101, `hex-conservative` 1.3.0, `hex_lit`, `secp256k1` 0.29.1).
`build/lock-additions.txt` holds their Cargo.lock entries. The Dockerfile appends it to the lock before
`cargo fetch`, which pins them (a newer `bitcoin` 0.32.x on crates.io does not change the build), and the lock
check accepts exactly those packages besides upstream's.

### B-9. The crate's sources come after the dependency layer

The brief asked for the crate to be copied before the build patch. Only its `Cargo.toml` is: cargo needs the
manifest to resolve and compile dependencies, and an empty `src/lib.rs` stands in for the sources. The sources
are copied with the patches, so editing the crate re-runs only the last step, as editing a patch does. The
crate cannot be compiled in the dependency layer anyway, because it needs 0029. `bitcoin` is compiled there on
its own (`cargo build -p bitcoin`), and the last step compiles no third-party crate.

### B-10. SLIP-132 keys

`zpub`/`vpub` are read as the same key under other version bytes and allowed only with `p2wpkh`, as DESIGN.md's
stream B section says. `ypub`/`upub`, multisig variants and every private-key prefix are refused, and the error
message for a private key never repeats it. Stream C's `networks.ts` rejects `zpub`/`vpub`, which is stricter
and compatible.

### B-11. Unknown keys on a Bitcoin chain are ignored, and logged

The first e2e run on hemi.15 failed in `06-settlement-pending`: the test mounts a copy of `config.json` with
`receipt_timeout_secs` set on every chain, and the Bitcoin chains refused the key
(`Failed to parse config file: unknown field receipt_timeout_secs, expected one of hemi, settler,
min_confirmations`), so the facilitator did not start. `10-stale-rpc` does the same. EVM chains ignore keys
they do not read, so the Bitcoin chains now do too, and the provider logs them as a warning at startup. A
misspelt key such as `min_confirmation` therefore falls back to the default, with that warning; inside
`min_confirmations`, unknown keys are still an error.

### B-12. Three-level derivation, tested against stream C's vectors

The first derivation rule used one 31-bit index (`0/index`). Stream C found that anyone holding the xpub
could precompute all 2^31 children, recognise a payment's address in the mempool, find another `paymentId`
with the same index in about 2^31 hashes, and settle the payment for their own request. DESIGN.md was revised
on 2026-11-09 to `0/i1/i2/i3`, three 31-bit indices from bytes 0..12 of the same digest, and the old vector
was voided. The crate follows the new rule. Stream C's `btc/test-vectors.json` (their commit 6607a91) is
copied byte for byte to `facilitator/x402-rs/crates/x402-chain-bip122/test-vectors.json`, and a unit test
reproduces all 16 cases (mainnet xpub and testnet3 tpub, P2WPKH and P2TR, four payment ids each): digest,
indices, child path, child pubkey, script, address and `paymentRef`. A second test reproduces the 5
rejections: a network mismatch either way, an upper-case and a 15-byte `paymentId`. The `zpub` rejection is
for clients and resource servers; the spec lets a facilitator accept it as P2WPKH, as DESIGN.md's stream B
section does, so the test checks that the facilitator reads it as the same key and refuses it for P2TR. If
the two copies of the file ever differ, the TypeScript and Rust sides may derive different addresses; the
integration session should keep one copy or check that they match.

## Commands and outputs

All on 2026-11-09, on Colima (4 CPUs, 8 GB, Apple silicon), in the pinned `rust:1.93-trixie` image for cargo.

### Unit tests

In a clone of x402-rs at `e75adda` with patches 0001 to 0030 and the build patch applied and the crate copied
to `crates/chains/x402-chain-bip122`:

```sh
cargo fmt --all --check
cargo clippy -p x402-chain-bip122 -p x402-types -p x402-facilitator-local \
  --features x402-chain-bip122/facilitator,x402-chain-bip122/telemetry --tests -- -D warnings
cargo clippy -p x402-chain-bip122 --tests -- -D warnings            # without the facilitator feature
cargo clippy -p x402-facilitator --features chain-bip122 --tests -- -D warnings
cargo clippy -p x402-facilitator --tests -- -D warnings              # feature off, as in the dependency layer
cargo test -p x402-types -p x402-facilitator-local -p x402-chain-eip155 -p x402-chain-bip122 -p x402-facilitator \
  --features x402-chain-eip155/facilitator,x402-chain-eip155/telemetry,x402-chain-bip122/facilitator,x402-chain-bip122/telemetry,x402-facilitator/chain-bip122
```

fmt and every clippy run are clean. Test results:

| Crate | Unit tests | New here |
|------|------|------|
| `x402-chain-bip122` | 42 passed | all |
| `x402-chain-eip155` | 55 passed | none |
| `x402-facilitator` (lib and bin each) | 5 passed | all five, from 0030 |
| `x402-facilitator-local` | 15 passed | 0029 extends the status-code test |
| `x402-types` | 25 passed | 0029: one new test, one extended |
| doc tests | 28 passed, 29 ignored | none |

0029 was also checked on its own (0001 to 0029 and the build patch, no 0030): fmt and clippy clean, and the
same suites pass, the crate's 40 included (log `.scratch/streamB/check-0029.log`, before B-11 added the 41st).

The crate's 42: 18 without the `facilitator` feature (parsing, derivation with the shared vectors and
rejections, chain ids, the scheme id) and 24 more with it (settler ABI, config, verify/settle/supported against the mock settler).

### Image

```sh
docker compose build        # no layer cached: the dangling images had just been pruned
```

```text
Cargo.lock: 518 of 1200 upstream packages kept, none changed; 10 added, all listed in the additions
    Finished `release` profile [optimized] target(s) in 58.91s     # dependencies, unpatched
    Finished `release` profile [optimized] target(s) in 4.16s      # bitcoin
applying 0001-… … applying 0030-facilitator-register-the-bip122-chain-and-v2-bip122-exact.patch
    Finished `release` profile [optimized] target(s) in 14.81s     # patched, --features chain-bip122
Successfully tagged hemi-x402-facilitator:e75adda-hemi.15
docker compose build  … 2:20.73 total
```

The last step compiles only the five x402 crates; `bitcoin` and `secp256k1` come from the dependency layer.
The image is 175 MB (hemi.14: 170 MB).

### Fork smoke test: `/supported`, verify and settle through the real Hemi path

Stream A's contract is not available here, so a stand-in was put at `0x…0B7C01` on both forks with
`anvil_setCode`: 250 bytes of EVM code that answer `SETTLER()` with the fork's facilitator signer and every other
call with a fixed `Check` (`stub_settler.py` in the session scratchpad). It exercises the facilitator's
`eth_call`, ABI decoding, startup check and send path; it is not the contract's logic. Forks from
`scripts/fork.sh up` (pinned blocks, ports 48545/48546), the hemi.15 container from `docker-compose.yml` with
`X402_BTC_SETTLER_MAINNET=X402_BTC_SETTLER_TESTNET=0x00000000000000000000000000000000000B7C01`.

Log at startup:

```text
INFO x402_chain_bip122::chain::provider: Using bip122 provider chain=bip122:000000000933ea01ad0ee984209779ba hemi=eip155:743111 settler=0x00000000000000000000000000000000000b7C01 signer=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
INFO x402_chain_bip122::chain::provider: Using bip122 provider chain=bip122:000000000019d6689c085ae165831e93 hemi=eip155:43111 settler=0x00000000000000000000000000000000000b7C01 signer=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
INFO x402_types::scheme: Registered scheme handler chain_id=bip122:000000000933ea01ad0ee984209779ba scheme=exact id="v2-bip122-exact"
INFO x402_types::scheme: Registered scheme handler chain_id=bip122:000000000019d6689c085ae165831e93 scheme=exact id="v2-bip122-exact"
```

`GET /supported` (keys sorted by the facilitator; EVM kinds shortened):

```json
{"extensions":[],
 "kinds":[
  {"extra":{"addressTypes":["p2wpkh","p2tr"],"asset":"BTC","assetTransferMethod":"utxo","hemiNetwork":"eip155:43111",
            "minConfirmations":{"ceiling":6,"default":1,"floor":1},"paymentFlow":"upfront",
            "settler":"0x00000000000000000000000000000000000b7C01"},
   "network":"bip122:000000000019d6689c085ae165831e93","scheme":"exact","x402Version":2},
  {"extra":{},"network":"eip155:43111","scheme":"exact","x402Version":2},
  {"extra":{"addressTypes":["p2wpkh","p2tr"],"asset":"BTC","assetTransferMethod":"utxo","hemiNetwork":"eip155:743111",
            "minConfirmations":{"ceiling":6,"default":1,"floor":1},"paymentFlow":"upfront",
            "settler":"0x00000000000000000000000000000000000b7C01"},
   "network":"bip122:000000000933ea01ad0ee984209779ba","scheme":"exact","x402Version":2},
  {"extra":{},"network":"eip155:743111","scheme":"exact","x402Version":2}],
 "signers":{"bip122:000000000019d6689c085ae165831e93":["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"],
            "bip122:000000000933ea01ad0ee984209779ba":["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"],
            "eip155:43111":["0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"],
            "eip155:743111":["0x70997970C51812dc3A010C7d01b50e0d17dc79C8"]}}
```

Requests use the first shared vector (`payTo` the BIP84 account-0 xpub, `paymentId`
`00112233445566778899aabbccddeeff`, P2WPKH), amount 1000, a made-up txid `a1b2c3d4…` and vout 1, on the mainnet
fork, against the final image (three-level derivation, built 13:06):

```text
== verify (stand-in verdict Ok)
{"isValid":true} HTTP 200
== settle
{"network":"bip122:000000000019d6689c085ae165831e93","success":true,"transaction":"a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4"} HTTP 200
signer nonce 0 -> 1
tx 0xf1522d64fd19721e72d7d41ad80f939c52f26774b05c32929fa4c6d4412f64d5 from 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC to 0x00000000000000000000000000000000000b7C01, status true
settle(bytes32,uint32,bytes,uint64,uint32,bytes32) decoded:
  0xa1b2c3d4…a1b2c3d4  1  0x0014c482e024e462c29003546a2f35eaa3d61daa46d2  1000  1
  0xa8faed6abbf35c12a4b26e40f6feb19d736d90045c83b9f9a31f638d323e6811   # = sha256(paymentId bytes)
== bad payload
{"invalidMessage":"Invalid format: payload must be {\"txid\": <64 hex>, \"vout\": <output index>}: txid must be 64 hex characters, got \"00\"","invalidReason":"invalid_payload",…,"isValid":false} HTTP 400
== verify (stand-in verdict TooFewConfirmations, 0 confirmations)
{"invalidMessage":"Transaction a1b2…a1b2c3d4 has 0 confirmation(s); 1 required","invalidReason":"invalid_exact_bip122_payload_unconfirmed",…,"isValid":false} HTTP 200
== settle (stand-in verdict ScriptMismatch)
{"errorMessage":"Output a1b2…a1b2c3d4:1 does not pay bc1qcjpwqf8yvtpfqq65dghnt64r6cw653kjs6yrca, the address derived for this payment","errorReason":"invalid_exact_bip122_payload_recipient_mismatch","network":"bip122:000000000019d6689c085ae165831e93","success":false,"transaction":""} HTTP 200
== verify (no contract at the settler address)
{"invalidMessage":"the settler 0x00000000000000000000000000000000000b7C01 answered verify() with data that is not a Check: ABI decoding failed: buffer overrun while deserializing","invalidReason":"unexpected_verify_error",…,"isValid":false} HTTP 500
```

The script in the settle calldata, `0x0014c482…46d2`, is the vector's `scriptPubKey`, for
`bc1qcjpwqf8yvtpfqq65dghnt64r6cw653kjs6yrca`, and the `paymentRef` is the vector's. The facilitator logged
`Transaction broadcast tx=0xf1522d64…` (0015) and `Bitcoin payment recorded on Hemi network=bip122:…
txid=a1b2… hemi_tx=0xf1522d64…`. A first smoke run on the single-index image gave the same answers with that
rule's address.

### End-to-end suite

```sh
npm test -w tests            # global setup: scripts/fork.sh up, docker compose build/up, dead primary RPCs
```

Final image (three-level derivation, built 13:06), with `X402_BTC_SETTLER_*` unset as the suite leaves them:

```text
 Test Files  13 passed (13)
      Tests  116 passed (116)
   Duration  342.07s (tests 99%, import 1%)
npm test -w tests  … 5:42.56 total
```

The shipped `config.json` lists both Bitcoin networks. With no settler set, the facilitator skips them and
serves only the EVM kinds, which is what the suite expects. The suite prints the container log only when its
setup fails, which run 1 below did:

```text
WARN x402_facilitator::chain: No X402BtcSettler address set; this Bitcoin network is not served chain=bip122:000000000933ea01ad0ee984209779ba settler=$X402_BTC_SETTLER_TESTNET
WARN x402_facilitator::chain: No X402BtcSettler address set; this Bitcoin network is not served chain=bip122:000000000019d6689c085ae165831e93 settler=$X402_BTC_SETTLER_MAINNET
WARN x402_types::scheme: No chain provider found for bip122:000000000933ea01ad0ee984209779ba
WARN x402_types::scheme: No chain provider found for bip122:000000000019d6689c085ae165831e93
```

The runs before it, all on hemi.15:

| Run | Image | Result | Why |
|------|------|------|------|
| 1 | first build | setup timed out, reported by vitest as `No test files found` | Colima did not forward port 38080 (Environment notes) |
| 2 | first build | stopped after `06-settlement-pending` failed | the test's config copy adds `receipt_timeout_secs` to every chain and the Bitcoin chains refused it (B-11) |
| 3 | B-11 fixed, single-index derivation | 13 files, 116 tests passed, 375 s | |
| 4 | final | 13 files, 116 tests passed, 342 s | |

The suite has no Bitcoin test yet: `tests/e2e/11-*` is stream C's, and needs the settler on the forks (next
section).

## Error codes

| Failure | Code | HTTP |
|------|------|------|
| request or payload does not parse | `invalid_payload` | 400 |
| `accepted` differs from the requirements other than in `extra.paymentId` | `invalid_payment_requirements` | 200 |
| asset, amount, transfer method, flow, `paymentId`, `addressType`, `minConfirmations` out of range | `invalid_payment_requirements` | 200 |
| network not the handler's | `invalid_network` | 200 |
| `payTo` unusable for this network and address type | `invalid_exact_bip122_pay_to` | 200 |
| output being settled, or its Hemi transaction pending | `invalid_transaction_state` | 200 |
| `TxNotFound` | `invalid_exact_bip122_payload_transaction_not_found` | 200 |
| `OutputNotFound` | `invalid_exact_bip122_payload_vout` | 200 |
| `ScriptMismatch`, `OpReturn` | `invalid_exact_bip122_payload_recipient_mismatch` | 200 |
| `BelowAmount` | `invalid_exact_bip122_payload_value_mismatch` | 200 |
| `TooFewConfirmations` | `invalid_exact_bip122_payload_unconfirmed` | 200 |
| `AlreadyConsumed` | `invalid_transaction_state` | 200 |
| `HbkError`, unknown verdict, Hemi unreachable, settler not deployed | `unexpected_verify_error` / `unexpected_settle_error` | 500 |
| Hemi settle transaction without a receipt in time | `settlement_pending`, `transaction` = Hemi hash | 200 |
| Hemi settle transaction mined and reverted | `invalid_transaction_state`, `transaction` = Hemi hash | 200 |
| success | `success: true`, `transaction` = Bitcoin txid, `network` = `bip122:…`, no `payer` | 200 |

## What the e2e test needs from the facilitator

Stream A's contract is not in this branch, so `scripts/fork.sh` is unchanged and there is no fork test of the
Bitcoin path yet. `tests/e2e/11-*.test.ts` (stream C) and the fork wiring need:

1. **The settler on both forks.** `scripts/fork.sh` deploys `X402BtcSettler` from stream A's deploy data, with
   `HBK` = the real hBK address of that network, `SETTLER` = the facilitator's fork signer (mainnet fork: anvil
   #2 `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC`; testnet fork: anvil #1
   `0x70997970C51812dc3A010C7d01b50e0d17dc79C8`), and `CONFIRMATION_OFFSET` as A fixes it. On the testnet fork
   the settler reads through `HbkTestnetAdapter`.
2. **The mock hBK.** `anvil_setCode` of `MockBitcoinKit`'s runtime code at the real hBK address
   (`0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12` on mainnet), so the settler's immutable `HBK` reaches it.
3. **The address in compose.** The facilitator reads `X402_BTC_SETTLER_MAINNET` / `X402_BTC_SETTLER_TESTNET`.
   The suite passes compose variables through `COMPOSE_VARS` in `tests/lib/env.ts`, so test 11 (or the global
   setup) adds them there, or calls `restartFacilitator({ X402_BTC_SETTLER_MAINNET: … })`. With them empty, as
   today, `/supported` lists no `bip122` kind and every bip122 request answers `invalid_network`.
4. **A paying output.** For `payTo` and `paymentId`, the derived script (`btc/src/derive.ts`, or this crate's
   rule) written into the mock as an output of a fake txid with `value ≥ amount` and enough confirmations,
   counted as the contract counts them (Bitcoin confirmations + `CONFIRMATION_OFFSET` from hBK).
5. **What to expect**, from the facilitator's side:
   - `/supported`: kind `{x402Version: 2, scheme: "exact", network: "bip122:000000000019d6689c085ae165831e93",
     extra: {asset: "BTC", assetTransferMethod: "utxo", paymentFlow: "upfront", addressTypes: ["p2wpkh",
     "p2tr"], minConfirmations: {default: 1, floor: 1, ceiling: 6}, settler, hemiNetwork: "eip155:43111"}}` and
     `signers["bip122:…"]` = the mainnet fork signer.
   - verify valid: `{"isValid": true}`; settle: `{"success": true, "transaction": <txid>, "network": …}`, then a
     `Settled` event with `paymentRef = sha256(paymentId bytes)` and `settledBy[txid][vout]` set; a second settle
     or verify: `invalid_transaction_state`.
   - Failures as in the table above. Under-confirmed and not-yet-known answer `…_unconfirmed` and
     `…_transaction_not_found`, not `settlement_pending` (Q-1).
   - Automine off: `settlement_pending` with the **Hemi** hash, a retry with the same hash and nothing sent,
     `/verify` meanwhile `invalid_transaction_state` naming the Hemi hash, then after one block a retry gets
     success with the Bitcoin txid and the next is a replay.
   - Response bodies have no `payer`; `tests/lib/spec.ts`'s `payerViolation` must not demand one for `bip122:*`.

## Open questions

- **Q-1. Polling across unconfirmed payments.** With B-1, a buyer that stops on any code other than
  `settlement_pending` stops on its first poll: a fresh payment is `…_transaction_not_found` until hVM reaches
  its block (10 to 30 minutes on mainnet), then `…_unconfirmed` until it has `minConfirmations`. Either the
  buyer (stream C) keeps polling on those two codes until `maxTimeoutSeconds`, or the facilitator answers
  `settlement_pending` with the Bitcoin txid for them on `/settle` only, a two-line change in `verdict_error`.
  The first keeps §9's meaning of `settlement_pending`; the second works with a stock seller and buyer
  unchanged. The integration session should pick one; the note in the shared folder tells stream C.
- **Q-2. Hemi settle hash in the success body.** The buyer prints it from `extra.settlementTransaction` in
  DESIGN.md's stream C section, which this facilitator does not send (B-7). A later patch could add it under
  `extensions`; it needs `tests/lib/spec.ts` to allow that field.
- **Q-3. The settler's `CONFIRMATION_OFFSET`.** The facilitator passes Bitcoin confirmations and reports the
  contract's `confirmations` in the message. It never applies an offset itself.
- **Q-4. Top-level README.** It still names hemi.14 and "twenty-eight small patches" (line 101). Left for the
  integration session, as the brief says.
- **Q-5. Restart.** The pending record is in memory, as for EVM. After a restart, a retry of a payment whose
  Hemi transaction was pending is judged by the contract alone: once mined, `AlreadyConsumed`
  (`invalid_transaction_state`), so the buyer who paid is not served. Same limit as **Facilitator memory**
  in the top-level README.

## Environment notes (this workstation, 2026-11-09)

- **Disk.** Colima's 40 GB data disk filled up during the first cargo run. This session removed its own cargo
  target volume and ran `docker image prune` (dangling images only, 6.1 GB reclaimed). The earlier dev loop's
  `hemi-x402-dev-target` volume (3.8 GB) was left alone.
- **Port forwarding.** Lima no longer forwards newly published container ports to the host: its
  `ssh -O forward` calls exit 255 (`~/.colima/_lima/colima/ha.stderr.log`), while ports forwarded before
  that keep working. The first e2e run therefore timed out in its global setup, and vitest reported it as
  `No test files found` with `TypeError: code.charCodeAt is not a function`. The runs here added the
  forward for 127.0.0.1:38080 by hand through Lima's own SSH control master while the suite's container
  ran, and cancelled it afterwards. `colima restart` would likely fix it, but restarts every container on
  the VM, so it was not done. Details: the shared notes folder, `colima-port-forwarding.md`.
