<!-- Copied from the approved plan of 2026-11-09. Child sessions implement the streams below; the integration session merges them. -->

> **Working notes, kept for the record.** Written on 2026-11-09 while phase 2 was built in three parallel work streams (A: contracts, B: facilitator, C: TypeScript). They describe the state at that time, so some statuses, file names and next steps in them are out of date, and a few refer to scratch files that were never committed. The current state is in the [README](../../README.md) and [DECISIONS.md](../../DECISIONS.md) (D-036 to D-040).

> **Where the implementation departs from this plan** (details in DECISIONS.md D-036 and `docs/phase2/{contracts,facilitator,ts}.md`): the address derivation has three levels (see the revised rule below); `CONFIRMATION_OFFSET` is 0, because hBK counts Bitcoin confirmations (A-2); the buyer keeps polling on `settlement_pending`, `invalid_exact_bip122_payload_unconfirmed` and `invalid_exact_bip122_payload_transaction_not_found`, and the facilitator keeps the verdict table on both endpoints (B-1, TS-7), so the stream C line "continue only on `settlement_pending`" is void; the success body carries no `extra.settlementTransaction` (B-7: that needs a proto change; the Hemi hash is in the log and the `Settled` event); `paymentRef = sha256(bytes16(paymentId))` over the raw bytes (TS-4); `SELLER_BTC_XPUB` takes one key per network (TS-11); the testnet settler is written but not deployed, because testnet's hBK could not be shown to work (A-7).

# Phase 2: Bitcoin L1 payments verified through hBK

## Context

The MVP is done: an x402 v2 facilitator for Hemi settles USDC.e and hemiBTC payments on both Hemi chains (D-001 to D-035). The brief's phase 2 is the part no other facilitator can do: an agent pays **BTC on Bitcoin L1** to a seller-controlled address, and the facilitator verifies that payment **through Hemi's hBK inside a Hemi contract**, with no relayer or oracle. The owner asked for the design, an implementation plan, a work split, and child sessions that start the implementation.

Decisions already made with the owner (2026-11-09):

1. **Binding:** a derived address per payment. The seller's `payTo` is an xpub; each 402 carries a random `extra.paymentId`; the payment address is a BIP32 child of the xpub at an index derived from the `paymentId`. Only the payer learns the `paymentId`, so a chain watcher cannot claim the payment first.
2. **Record:** the consumption record lives in a Hemi contract. `/settle` sends a Hemi transaction that re-checks the UTXO through hBK and marks `(txid, vout)` consumed.
3. **Live proof:** Hemi mainnet, one small real Bitcoin payment on the owner's explicit go. Forks with a mocked hBK for tests; Hemi testnet best effort only.

## What was verified today (read-only)

- **Mainnet hBK** `0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12` answers the full `IBitcoinKit` from hemilabs/bitcoin-tunnel-contracts: `getTxConfirmations(bytes32)` (txid in display byte order; reversed reverts; ~28k gas), `getSpecificTxOutput(bytes32,uint32)` (~134k gas; `outputAddress` is **empty** for segwit outputs, so compare `script` bytes), `getScriptForAddress(string)` (~49k gas), `getTxOutputCount`, `transactionExists`, `isAddressValid`, `getBitcoinAddressBalance`, `getTransactionByTxId`. `getUTXOsForBitcoinAddress` reverted for every address tried; `getHeaderN` reverted for a recent height. Do not rely on either.
- **Confirmation count:** for coinbase txs at tip−1, tip−2, tip−3, hBK returned 3, 4, 5 where Bitcoin says 2, 3, 4; the tip block's txs are not retrievable yet. So hBK's count = Bitcoin confirmations + 1 (to be re-measured by the contracts stream and fixed in the contract's policy).
- **hVM lag:** mainnet `BtcLastHeader` (0x44) is 2 blocks behind the Bitcoin tip. Testnet is ~6,600 blocks behind Bitcoin testnet3 and only keeps pace with it, so a testnet payment may take hours to become verifiable. Testnet hBK `0xeC9f…f215` also has a different ABI (`btc*` names) and reverts on `getLastHeader`.
- **Cost:** Hemi execution gas is ~0.001 gwei; the L1 data fee dominates. A settle of ~250k gas costs about $0.003, like today's ERC-20 settlements.
- **x402-rs** (e75adda): chains are typed by CAIP-2 namespace in `facilitator/src/config.rs` (a `match namespace` with one arm per chain crate), providers in `facilitator/src/chain.rs` (`ChainProvider` enum), scheme blueprints registered in `facilitator/src/run.rs` and paired with chains by `SchemeRegistry::build`. `/supported` kinds come from (scheme, chain id). Adding a namespace = new chain crate + one arm in each of config.rs, chain.rs, schemes.rs, run.rs.
- **x402 TS SDK** (2.29.0): `bip122:<32 hex>` passes the CAIP-2 regex; a client scheme is `SchemeNetworkClient { scheme, createPaymentPayload }`; a server scheme is `SchemeNetworkServer { scheme, defaultAssetTransferMethod, paymentFlows, parsePrice, enhancePaymentRequirements, dynamicExtraFields?, enrichPaymentRequiredResponse? }`. The core requires the payload's `accepted` to deep-equal the rebuilt requirements except `extra` (subset), so the per-request `paymentId` must be a dynamic extra field and `payTo` (the xpub) stays constant. No non-EVM scheme package is installed to copy.
- **Precedent:** x402's Lightning spec `scheme_exact_lnbtc.md` uses scheme `exact`, asset `BTC`, network `lnbtc:<genesis prefix>`, `extra.paymentFlow: "upfront"`, settle-only semantics and a replay store keyed by network + payment hash. The `payment-identifier` extension is a different thing (client-generated idempotency key in `extensions`); our `paymentId` is seller-generated and lives in `extra`.
- Upstream x402-rs has been idle since July 2026 (D-035), so the new scheme is a patch set in our image, like the 28 existing ones.

## Design

### Scheme

| Field | Value |
|------|------|
| `scheme` | `exact` |
| `network` | `bip122:000000000019d6689c085ae165831e93` (Bitcoin mainnet); `bip122:000000000933ea01ad0ee984209779ba` (testnet3) |
| `asset` | `BTC` |
| `amount` | satoshis, decimal string |
| `payTo` | the seller's account xpub (`xpub…` on mainnet, `tpub…` on testnet3), constant per seller |
| `maxTimeoutSeconds` | large (default 7200): a payment becomes verifiable one Bitcoin block after inclusion at the earliest |
| `extra.assetTransferMethod` | `"utxo"` (the SDK keys payment flows by transfer method) |
| `extra.paymentFlow` | `"upfront"`: a stock seller then calls `/settle` before its handler and never `/verify`; a failed settle reaches the buyer as 402 with the facilitator's `errorReason` |
| `extra.paymentId` | 32 lowercase hex chars, random per 402, **dynamic** (declared in `dynamicExtraFields`) |
| `extra.addressType` | `"p2wpkh"` (default) or `"p2tr"` |
| `extra.minConfirmations` | Bitcoin confirmations required, default 1; the seller's choice |
| `payload` | `{ "txid": "<64 hex, display order>", "vout": <n> }` |

**Address derivation** (shared by seller, facilitator and buyer). **Revised 2026-11-09 after stream C found a flaw in the single 31-bit index:** with one level, an attacker who holds the public xpub can precompute all 2^31 child addresses (hours of CPU), recognise the payment's address in the mempool, brute-force any `paymentId` whose digest gives the same 31-bit index (2^31 hashes, seconds), and submit it; the facilitator derives the same script and settles for the attacker. The rule is therefore three non-hardened levels from one digest: `d = sha256(utf8("x402-btc") ‖ bytes16(paymentId))`; `i1 = BE_uint32(d[0..4]) & 0x7fffffff`, `i2 = BE_uint32(d[4..8]) & 0x7fffffff`, `i3 = BE_uint32(d[8..12]) & 0x7fffffff`; address = child `m/0/i1/i2/i3` of `payTo`; p2wpkh script `0014‖hash160(pubkey)`, p2tr per BIP86 (no script tree). 93 bits of index make precomputation and collision search infeasible. Test vectors: `btc/test-vectors.json` (stream C, commit 6607a91, 16 vectors). For xpub `xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V` and paymentId `00112233445566778899aabbccddeeff`: `d = e80b5689…56fb6b`, indices `1745573513 / 250221288 / 1390224838`, p2wpkh `bc1qcjpwqf8yvtpfqq65dghnt64r6cw653kjs6yrca`, p2tr `bc1p36mj32d4l6z589jyh7t6gt9r787dl7rsjztt80hqz3a7eve8g0fsyhls8v`. The Rust stream reproduces every vector. A watcher who sees the payment on chain cannot recover a `paymentId` for that address, so it cannot forge the payload. The facilitator derives from **`accepted.extra.paymentId`**, never from the requirements the seller sends alongside: the SDK regenerates the 402 (and so a fresh `paymentId`) on every paid request, and strips dynamic fields before matching. Output value must be **≥ `amount`**; overpayment is accepted and grants nothing more (as the Lightning scheme does), because Bitcoin has no refund path.

**Verify** (facilitator, no state change): parse; `accepted` matches; derive the script; `eth_call X402BtcSettler.verify(txid, vout, script, amount, minConfirmations)` on Hemi, which reads `getSpecificTxOutput` (script equal, value ≥ amount, not OP_RETURN) and `getTxConfirmations` through hBK and checks `consumed[txid][vout]` is false. `isSpent` is ignored: the seller may sweep its funds.

**Settle:** re-verify, then send `X402BtcSettler.settle(txid, vout, script, amount, minConfirmations, paymentRef)` from the facilitator's Hemi signer, through the same `send_transaction` path as today's settlements (patches 0006, 0011, 0015 to 0028 apply: one settlement per `(txid, vout)`, `settlement_pending` with the hash, retries answered from the record). The contract marks `(txid, vout)` consumed and emits an event with `paymentRef = sha256(paymentId)`. Response: `success: true`, `network` = the bip122 network, `transaction` = the Bitcoin txid (it is the payment on `network`), the Hemi settle hash in `extra.settlementTransaction`, `payer` omitted. Rejections use `invalid_exact_bip122_*` codes plus the §9 codes `settlement_pending`, `invalid_transaction_state`, `invalid_network`, `invalid_payload`.

**Confirmation depth vs PoP finality (the brief's design pass):** acceptance of the *payment* is a Bitcoin question: `minConfirmations` as reported by hBK, corrected for hBK's +1, with the seller choosing the depth per price (1 for cents, 3 for tens of dollars, 6 for more). hVM's view lags the Bitcoin tip by 1 to 2 blocks on mainnet, so the earliest acceptance is 10 to 30 minutes after inclusion. PoP finality (about 9 Bitcoin blocks for Hemi state) does not gate payment acceptance; it gates the durability of the *consumption record* on Hemi. A Hemi reorg before PoP finality could drop a consumed mark; the facilitator's in-memory record (0011) covers that window for one process, and the seller's handler should be idempotent per `paymentId`. Documented as a limit.

### Streams (child sessions)

The interface above is fixed first, so the streams run in parallel against it. Details per stream follow in the next sections, filled in from the stream designs.

### Stream A: the Hemi contract (`contracts/`, Foundry)

**Decisions.** Call the hBK *contract* (constructor immutable), not the precompiles: the 0x42 packed response layout is only known for the request hBK itself sends. The hBK source shows `parseTransactionOutputs` never sets `isOpReturn`, `opReturnData` or `outputAddress`, reads at most 32 outputs and 64 script bytes; so compare `script` bytes (length, `containsFullScript`, keccak) and detect OP_RETURN from `script[0] == 0x6a`. `confirmations = hbkCount − CONFIRMATION_OFFSET` (immutable, 1 on mainnet until the live check re-measures it). `isSpent` ignored. `verify` never reverts: hBK's `Error("Bitcoin transaction not found")` → `TxNotFound`, `Panic(0x32)` → `OutputNotFound`. `settle` reverts `NotPayable(verdict)`. **`settle` is restricted to an immutable `SETTLER` address, the facilitator's Hemi signer:** otherwise anyone who sees the Bitcoin tx could settle first with a bogus `paymentRef` and block the real settlement (griefing). The contract holds no funds, has no owner and no upgrade path; redeploy to change hBK or the settler. `settledBy[txid][vout] = paymentRef` (nonzero = consumed) doubles as reconciliation. Testnet hBK has a `btc*` ABI, so a thin `HbkTestnetAdapter` implements the two-function `IHbkReader` there; settler bytecode is the same on both networks.

**ABI the facilitator calls** (fixed now so streams run in parallel):

```solidity
enum Verdict { Ok, AlreadyConsumed, TxNotFound, OutputNotFound, ScriptMismatch, OpReturn, BelowAmount, TooFewConfirmations, HbkError }
struct Check { Verdict verdict; uint64 sats; uint32 hbkConfirmations; uint32 confirmations; bool isSpent; bytes32 settledBy; }
event Settled(bytes32 indexed txid, uint32 vout, bytes32 indexed scriptPubKeyHash, uint64 sats, bytes32 indexed paymentRef, address settler);
function HBK() view returns (address); function SETTLER() view returns (address); function CONFIRMATION_OFFSET() view returns (uint32);
function settledBy(bytes32 txid, uint32 vout) view returns (bytes32);
function verify(bytes32 txid, uint32 vout, bytes scriptPubKey, uint64 minSats, uint32 minConfirmations) view returns (Check);
function settle(bytes32 txid, uint32 vout, bytes scriptPubKey, uint64 minSats, uint32 minConfirmations, bytes32 paymentRef) returns (uint64 sats);  // only SETTLER
```
`txid` in display byte order (as hBK takes it); `paymentRef = sha256(paymentId)`. A facilitator retry reads `settledBy` first: equal to its `paymentRef` means already settled.

**Files.** `contracts/src/btc/{IHbkReader,X402BtcSettler,HbkTestnetAdapter}.sol`; `contracts/test/mocks/MockBitcoinKit.sol` (both ABIs, `setTx(txid, outputs, confirmations)`, hBK's exact revert string, `vm.etch`ed at the real hBK address); `contracts/test/X402BtcSettler.t.sol` (unit) and `X402BtcSettler.fork.t.sol` (both pinned forks, CREATE2 address check, settle round trip); `contracts/script/DeployBtcSettler.s.sol` (DeployHemi conventions: chain check, `CONFIRM_MAINNET_DEPLOY=yes` gate, CREATE2 via `0x4e59…956C`, skip if code exists; constructor args differ per network so addresses differ); `contracts/deploy-btc.sh` (deploy.sh's flow: simulate, cost plan, gate, `--broadcast --slow`); `contracts/check-btc-live.sh` (read-only `cast call`s against the real node: `getTxConfirmations`, `getSpecificTxOutput` and `verify` for the fixture tx `95bca029…367e` vout 1, 83050000 sats, script `0x0020ff64…`; measures the offset against `getLastHeader`); `shared/hemi.json` per-network `contracts: {hbk, x402BtcSettler, hbkTestnetAdapter}` plus `btcConfirmationOffset`; `contracts/verify.sh` gains the settler (full match possible); `contracts/README.md`, DECISIONS entry.

**Tests.** Happy verify/settle (event, `settledBy`, return); wrong and truncated script; confirmations boundary with offsets 1 and 0; below and exact amount; OP_RETURN; consumed twice; unknown txid; vout out of range (hBK panics); `isSpent` still `Ok`; zero `paymentRef`; non-settler caller reverts; ETH send reverts; fuzz `verify` never reverts; adapter against the `btc*` mock. Live: `check-btc-live.sh mainnet` expects `Ok`, 83050000. Forge cannot run hVM precompiles, so the live check is `cast`, never `forge script`.

**Order.** Contract + unit tests → fork tests → testnet deploy + live check (best effort) → mainnet deploy **only on the owner's go**.

### Stream B: the facilitator scheme in x402-rs (`facilitator/`)

**Where the code lives.** A new crate `facilitator/x402-rs/crates/x402-chain-bip122/` committed as plain files and `COPY`d into `/src/crates/chains/` by the Dockerfile before the build patch (a 1.5k-line crate as a `.patch` is unreviewable; upstream it is a new `crates/chains/` directory). Two small upstreamable patches wire it in: **0029** `types: error codes for the exact bip122 scheme` (`ErrorReason`/`PaymentVerificationError` variants, HTTP 200 verdicts in `handlers.rs`) and **0030** `facilitator: register the bip122 chain and v2-bip122-exact` (`facilitator/src/{config,chain,schemes,run}.rs`, all under `#[cfg(feature = "chain-bip122")]`). Image tag `e75adda-hemi.15`.

**Provider: reuse the registered Hemi provider.** `Bip122ChainProvider { chain, hemi: Arc<Eip155ChainProvider>, settler: Address, confirmations: Policy }`. The registry is built in two passes: eip155 providers first, then each bip122 chain looks up its `hemi` chain id and clones the `Arc`; a missing Hemi chain is a startup error. A second embedded Hemi provider was rejected: it would have its own nonce manager, so USDC.e and BTC settlements from the same signer would collide on nonces. Sharing the object gives patches 0019 to 0028 and the nonce manager for free. The settle tx goes through `hemi.send_transaction(MetaTransaction::new(settler, calldata))`. The Hemi signer must be the contract's `SETTLER`.

**Derivation** in Rust with the `bitcoin` crate (bip32 `derive_pub`, p2wpkh, BIP86 p2tr). It is not in upstream's lock, so `build/check-lock-subset.sh` takes an allow-list `build/lock-additions.txt` of pinned (name, version, source, checksum) lines; everything already locked keeps upstream's version. (The primitives `bs58`, `hmac`, `sha2`, `secp256k1`, `ripemd` are in the lock, so hand-rolling BIP32 is possible, but the `bitcoin` crate is the safer choice for address/script correctness.) Version bytes must match the chain (`xpub` mainnet, `tpub` testnet); `ypub`/`upub` rejected; `zpub`/`vpub` imply p2wpkh.

**Flows.**
```
verify: parse (invalid_payload / invalid_x402_version) → accepted == requirements except dynamic extra (invalid_payment_requirements)
  → network, scheme exact, asset BTC, flow upfront → sats > 0; minConfirmations in [floor, ceiling]
  → pending record exists for (chain, txid, vout) → invalid_transaction_state
  → script = derive(payTo, accepted.extra.paymentId, addressType)   (invalid_exact_bip122_pay_to)
  → eth_call settler.verify(txid, vout, script, sats, minConf) → ok | map(verdict)
settle: same checks; pending.begin((chain, txid, vout), request key) with 0011 semantics (retry of the same request answered from the record)
  → settler.verify again (no gas on a reverting tx) → send settle(…, paymentRef = sha256(paymentId))
  → Ok(receipt): success { transaction: <bitcoin txid>, network: bip122:… }, payer omitted; Hemi hash logged (0015) and in the Settled event
  → ReceiptUnavailable { h }: keep record; settlement_pending { transaction: h }   (§9 wants the broadcast hash)
  → TransactionFailed { h }: invalid_transaction_state { transaction: h }
supported: kinds [{ x402Version 2, scheme exact, network, extra { asset BTC, assetTransferMethod utxo, paymentFlow upfront, addressTypes, minConfirmations policy, settler, hemiNetwork } }], signers { network: [hemi signer] }
```
Exposing the Hemi settle hash in a success body needs a proto change; deferred to a later patch (`extensions`).

**Verdict → code.** `TxNotFound` → `invalid_exact_bip122_payload_transaction_not_found`; `OutputNotFound` → `…_vout`; `ScriptMismatch`, `OpReturn` → `…_recipient_mismatch`; `BelowAmount` → `…_value_mismatch`; `TooFewConfirmations` → `…_unconfirmed`; `AlreadyConsumed` → `invalid_transaction_state`; `HbkError`, RPC failure → `unexpected_*_error`; unparsable xpub → `invalid_exact_bip122_pay_to`. `maxTimeoutSeconds` is accepted, not enforced (an L1 tx has no expiry).

**Config** (`facilitator/config*.json`, compose env defaults, `.env.example`):
```json
"bip122:000000000019d6689c085ae165831e93": { "hemi": "eip155:43111", "settler": "$X402_BTC_SETTLER_MAINNET",
  "min_confirmations": { "default": 1, "floor": 1, "ceiling": 6 } },
"schemes": [ …, { "id": "v2-bip122-exact", "chains": "bip122:000000000019d6689c085ae165831e93" } ]
```
Testnet3 → `"hemi": "eip155:743111"`, `$X402_BTC_SETTLER_TESTNET`.

**Files.** `crates/x402-chain-bip122/{Cargo.toml, src/lib.rs, src/chain/{mod,config,provider}.rs, src/v2_bip122_exact/{mod,types,derive,settler,facilitator}.rs}`; patches 0029, 0030 and README sections; `build/0001-…patch` (workspace member, `bitcoin` in workspace deps, facilitator feature `chain-bip122`, off by default so the dependency layer still builds), `build/lock-additions.txt`, `build/check-lock-subset.sh`; `facilitator/Dockerfile` (copy the crate, warm the new deps, build with `--features chain-bip122`); configs.

**Tests.** Crate unit tests: the derivation vector from the design, SLIP-132 and network mismatches, every parse failure, each verdict → code, `verify`/`settle` against a `MockSettler` (success, pending → retry claims once → later replay, revert), `supported()` shape. Patch unit tests: codes serialise, status 200, config parses, missing Hemi chain errors. e2e `tests/e2e/11-btc-l1.test.ts` (shared with stream C): `scripts/fork.sh` deploys the settler on the forks and `anvil_setCode`s the mock hBK at the real hBK address; seed a fake tx paying the derived address; `/supported`, verify, settle success with the txid, `Settled(paymentRef)`, replay, each failure code, automine-off `settlement_pending` then retry success.

### Stream C: TypeScript scheme, seller, buyer, spec, e2e (`btc/`, `seller/`, `buyer/`, `tests/`, `docs/`)

**Package `btc/` (`@hemi-x402/btc`)**, added to the root workspaces. Dependencies already in the tree via viem: `@scure/bip32`, `@scure/base`, `@noble/hashes`, `@noble/curves`; add `@scure/btc-signer` for PSBT building and signing (no WASM, no bitcoinjs-lib). Files: `src/networks.ts` (the two bip122 ids, hrp `bc`/`tb`, `xpub`/`tpub` version bytes, reject `ypub`/`zpub`/`vpub` with a hint, Esplora bases `https://mempool.space/api` and `/testnet/api`, explorer URLs); `src/derive.ts` (`paymentIndex`, `derivePaymentAddress(xpub, network, paymentId, addressType)`, `isPaymentId`); `src/server.ts` (`ExactBtcServerScheme implements SchemeNetworkServer`: `scheme "exact"`, `defaultAssetTransferMethod "utxo"`, `paymentFlows {utxo: {supported: ["upfront"], default: "upfront"}}`, `dynamicExtraFields ["paymentId"]`, `parsePrice` accepts `{asset:"BTC", amount}` only and rejects dollar strings, `enhancePaymentRequirements` sets asset/flow/addressType/minConfirmations, `enrichPaymentRequiredResponse` adds a fresh random `paymentId` per bip122 accept, `validateFacilitatorSupport` checks the xpub prefix matches the network); `src/client.ts` (`ExactBtcClientScheme implements SchemeNetworkClient`, built on a `PayBtc(address, sats, ctx) → {txid, vout}` callback or a `BtcWallet`, with a `PaymentJournal` keyed by `paymentId` so a repeated `createPaymentPayload` never pays twice); `src/wallet.ts` (`BtcWallet` from WIF or mnemonic, `EsploraClient` for UTXOs, fees, broadcast and status, largest-first coin selection, change to self); unit tests with vitest, no docker.

**Seller.** Env `SELLER_BTC_XPUB`, `SELLER_BTC_NETWORKS` (empty = off), `SELLER_BTC_AMOUNT_SATS` (default ≥ 1000; 1-sat outputs are dust), `SELLER_BTC_MIN_CONFIRMATIONS` (1), `SELLER_BTC_ADDRESS_TYPE` (p2wpkh), `SELLER_BTC_MAX_TIMEOUT_SECONDS` (3600). Accept entries `{scheme:"exact", network, payTo: xpub, price:{asset:"BTC", amount}, maxTimeoutSeconds}` beside the EVM ones; `register(btcNetwork, new ExactBtcServerScheme(...))`; hooks print `payer ?? "n/a"`.

**Buyer.** `--asset btc-l1 --network btc-mainnet|btc-testnet3`, `BUYER_BTC_WIF` or `BUYER_BTC_MNEMONIC`, `--poll 60`, `--resume <paymentId>`, `--fee-rate`; `ALLOW_MAINNET=yes` gate. `wrapFetchWithPayment` would pay again on a second 402, so the buyer drives the flow itself: one GET → decode the 402 → policy keeps the bip122 accept → spend controls allow-list `BTC` → `createPaymentPayload` once (pays, journals to `.scratch/buyer-btc/journal.jsonl`) → re-send with the payment header every poll interval; continue only on `settlement_pending`, stop on any other reason or at `maxTimeoutSeconds`. Prints the Bitcoin txid with its mempool.space link and the Hemi settle tx (from `extra.settlementTransaction`).

**Spec** `docs/specs/scheme_exact_bip122.md` in the x402 template (Summary, Use Cases, Appendix) with the Lightning spec's body: networks, transfer method `utxo` and flow `upfront`, amounts, requirements, derivation rule and vector, payload, facilitator validation in order (core fields equal; network served; asset, amount, flow; `accepted.extra.paymentId` well-formed and used for derivation; payload shape; tx known to hVM; output script equals the derived script; value ≥ amount; confirmations ≥ `minConfirmations`; not consumed), settlement (record on Hemi, `transaction` = Bitcoin txid, `payer` omitted), confirmation policy, error vocabulary, security notes.

**Tests.** `tests/lib/spec.ts`: `settleFailureViolations` takes a `txPattern` (bip122: 64 lowercase hex), `payerViolation` only checks addresses for `eip155:*`, add the bip122 codes. `tests/lib/payments.ts`: `btcRequirementsFor`, `btcPayment(req, {txid, vout})`. New `tests/lib/btc.ts` writes a fake tx, output and confirmation count into the mock hBK on the fork. `tests/e2e/11-btc-l1.test.ts`: `/supported` lists both bip122 kinds; happy verify → settle → replay; under-confirmed → `settlement_pending` with the txid; wrong `paymentId` → recipient mismatch; amount below → mismatch; unknown txid; malformed payload; the stock seller engine (as in `04c`) with `ExactBtcServerScheme`: the 402 carries a 32-hex `paymentId` and `upfront`, served once, a second use gets 402. `buyer/demo-fork.sh` gains a fifth payment through a stub `PayBtc`. README "For sellers", "For buyers", Tests and Limits.

## Work split and sessions

Three child sessions, each in its own worktree branch off `feat/facilitator-mvp`, started together once this plan is approved (the owner asked for child sessions). They code against the interfaces fixed above (settler ABI, scheme fields, derivation vector, error codes), so none waits on another. To avoid merge conflicts, each stream edits only its own area and writes its decision notes to `docs/phase2/<stream>.md` instead of `DECISIONS.md`; the top-level `README.md`, `DECISIONS.md` and the e2e wiring are integrated afterwards in this session.

| Session | Branch | Owns | Done when |
|------|------|------|------|
| A: contract | `phase2/contracts` | `contracts/src/btc`, `contracts/test`, `contracts/script/DeployBtcSettler.s.sol`, `contracts/deploy-btc.sh`, `contracts/check-btc-live.sh`, `contracts/README.md`, `shared/hemi.json` (contracts block only), `docs/phase2/contracts.md` | `forge test` green incl. fork tests; `check-btc-live.sh mainnet` passes read-only against the predicted address; testnet deployed if its hBK cooperates; **no mainnet broadcast** |
| B: facilitator | `phase2/facilitator` | `facilitator/x402-rs/crates/x402-chain-bip122`, patches 0029–0030 and their README sections, `build/`, `Dockerfile`, `facilitator/config*.json`, `.env.example` keys, `docs/phase2/facilitator.md` | image `hemi.15` builds; crate and patch unit tests green; existing e2e suite still 116/116 on the new image; `/supported` lists the bip122 kinds on a fork with the settler address from stream A's deploy data (coordinated through `shared/hemi.json` once A lands; until then a config override) |
| C: TypeScript | `phase2/ts` | `btc/`, `seller/`, `buyer/`, `tests/lib`, `tests/e2e/11-*`, `docs/specs/scheme_exact_bip122.md`, `buyer/demo-fork.sh`, `docs/phase2/ts.md` | unit tests green; spec drafted; seller advertises bip122 accepts; buyer pays and polls against a stub facilitator; e2e file written against the agreed codes (it runs green only after B and A merge) |

Rules every session gets: no transaction on any live network and no `/settle` against a live facilitator; `.env` is never read or printed; commit on its own branch, push nothing; keep the repo's style (DECISIONS-style notes with commands and outputs; patches small, one concern each; no change to where funds go).

**Integration (this session, after the three land):** merge the branches, run `scripts/fork.sh` + e2e `11-*` + the full suite + `demo-fork.sh`; critic pass from the README; then, each on the owner's explicit go: mainnet settler deployment (~$0.003), facilitator config with the settler, and one real Bitcoin payment (a few dollars incl. miner fee) from a buyer wallet the owner funds, settled on Hemi mainnet; record D-036+.

## Verification

- `(cd contracts && forge test)`: new unit + fork tests pass alongside the existing 17.
- `contracts/check-btc-live.sh mainnet`: read-only `cast` calls return `Ok` and 83050000 sats for the fixture tx, and report the measured confirmation offset.
- `docker compose build` produces `hemi-x402-facilitator:e75adda-hemi.15`; `cargo test -p x402-chain-bip122 --features facilitator` green; the lock check passes with the allow-list.
- `npm test -w tests`: the existing 116 tests plus `11-btc-l1` pass on forks with the dead primary RPC; `npm run typecheck --workspaces` clean; `buyer/demo-fork.sh` settles five payments.
- `FACILITATOR_CONFIG=config.mainnet.json docker compose up -d` then `GET /supported` lists `exact` on `bip122:000000000019d6689c085ae165831e93` with the Hemi signer; `tests/live/verify-failures.ts` extended with bip122 failure cases sends nothing.
- Live proof (on go): a Bitcoin mainnet payment to a derived address, the buyer polls, the seller serves once, `settledBy[txid][vout]` on the settler equals `sha256(paymentId)`, the `Settled` event matches, and a second use of the same payment gets 402; receipts read back on both Hemi RPCs and mempool.space.
- A fresh-context critic passes the README's Definition of done plus the phase 2 items.

## Open points carried into the streams

- hBK's confirmation count looked like Bitcoin's + 1 against mempool.space; stream A's live check measured it against hBK's own `getLastHeader` and found the offset is 0, so `CONFIRMATION_OFFSET` is 0 on mainnet and the policy is in hBK's own confirmations. Testnet hBK could not be shown to work.
- Testnet hBK (`btc*` ABI, `getLastHeader` reverts, hVM 6,600 blocks behind): adapter + best effort; the proof is on mainnet.
- A 1-confirmation settle can be reorged on Bitcoin; `minConfirmations` is the seller's lever and the limit is documented.
- The Hemi settle hash is not in the success body yet (needs a proto patch); it is logged and in the `Settled` event.
- Griefing is closed by the `SETTLER` restriction; rotating the facilitator signer means redeploying the settler.
