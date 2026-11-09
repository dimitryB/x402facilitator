# Phase 2, stream C: TypeScript scheme, seller, buyer, spec, e2e

> **Derivation vectors (three-level rule): `btc/test-vectors.json`, committed in `6607a91e08126264435a616ce11994b0d7d9c7b0`** on branch `claude/optimistic-meninsky-f0b705`, unchanged since. For the DESIGN.md xpub and paymentId `00112233445566778899aabbccddeeff`:
>
> | Field | Value |
> |------|------|
> | `d` | `e80b56898eea12e8d2dd25c6383febd6420c1778109fdab78b7cf292ba56fb6b` |
> | `i1`, `i2`, `i3` | `1745573513`, `250221288`, `1390224838` |
> | child pubkey | `03cbeecf22bec0774f9ae6b06429bcb4c5eea85ba699380ad18ae8ab2cebc9de4b` |
> | p2wpkh | `0014c482e024e462c29003546a2f35eaa3d61daa46d2`, `bc1qcjpwqf8yvtpfqq65dghnt64r6cw653kjs6yrca` |
> | p2tr | `51208eb728a9b5fe85439644bf97a42ca3f1fcdff8709096b3bee0147becb32743d3`, `bc1p36mj32d4l6z589jyh7t6gt9r787dl7rsjztt80hqz3a7eve8g0fsyhls8v` |
> | `paymentRef` | `0xa8faed6abbf35c12a4b26e40f6feb19d736d90045c83b9f9a31f638d323e6811` |
>
> The testnet3 case uses `tpubDC8msFGeGuwnKG9Upg7DM2b4DaRqg3CUZa5g8v2SRQ6K4NSkxUgd7HsL2XVWbVm39yBA4LAxysQAm397zwQSQoQgewGiYZqrA9DsP4zbQ1M` (`m/84'/1'/0'` of the same mnemonic). Its p2wpkh address is `tb1qakyl8vdjmkzr7a99ylf7jx9axh4f43u4znf3lq`, with script `0014ed89f3b1b2dd843f74a527d3e918bd35ea9ac795`; the p2tr address is `tb1pnzwq4w85mtxz5rvyu6rqelglju3xj0papu85x70d040gqe2hrjgs2gk439`. The file holds 16 vectors in all plus rejection cases.

Stream C of `docs/phase2/DESIGN.md`, on branch `claude/optimistic-meninsky-f0b705`. Decisions are numbered TS-1 onward for the integration session to fold into `DECISIONS.md`. Nothing here sent a transaction to any live network; the only network reads were GitHub (the x402 spec, hBK's struct, the sibling branches) and the npm registry.

## What landed

| Path | What |
|------|------|
| `btc/` (`@hemi-x402/btc`) | `src/networks.ts`, `src/derive.ts`, `src/server.ts` (`ExactBtcServerScheme`), `src/client.ts` (`ExactBtcClientScheme`, `PayBtc`), `src/journal.ts` (`PaymentJournal`, memory and JSONL), `src/wallet.ts` (`BtcWallet`, `EsploraClient`, `selectLargestFirst`), `src/mock-hbk.ts` (local forks only), `test-vectors.json` and its generator `dev/make-vectors.ts`, `dev/stub-facilitator.ts`, 90 vitest unit tests |
| `seller/` | `SELLER_BTC_*` settings, bip122 accepts beside the Hemi ones, startup validation, `payer ?? "n/a"`, settle log with paymentId and path; README section "Bitcoin L1" |
| `buyer/` | `btc-l1.ts` (pay-then-poll), `pay.ts` dispatch and flags, `demo-fork.sh` fifth payment; README section "Paying in BTC on Bitcoin L1" |
| `docs/specs/scheme_exact_bip122.md` | The scheme in the x402 template shape with the Lightning spec's body |
| `tests/lib/` | `spec.ts` (bip122 codes, `txPatternFor`, family-aware `payer`, `settleSuccessViolations`), `payments.ts` (`btcRequirementsFor`, `btcPayment`), `btc.ts` (new) |
| `tests/e2e/11-btc-l1.test.ts` | 20 tests, skipped with the reason until the facilitator lists a bip122 kind and the forks carry the mock hBK and settler |
| `.env.example` | Seller and buyer keys for Bitcoin L1 |
| `shared/` | A `typecheck` script and tsconfig. On main, `npm run typecheck --workspaces` failed on `shared` ("Missing script"); now all five workspaces pass |
| `tests/lib/env.ts` | Opt-in `E2E_PORT_OFFSET` for running the suite next to another worktree (TS-17) |

## Decisions

**TS-1. `@scure/btc-signer` 1.8.1, not 2.x.** 1.8.1 depends on `@noble/curves` ~1.9, `@noble/hashes` ~1.8 and `@scure/base` ~1.2, exactly what viem already installed. 2.x pulls the noble 2.x line, a second copy of every primitive. The lock gained two packages, `@scure/btc-signer` and `micro-packed` 0.7.3. All `btc/` dependencies are exact-pinned. `@scure/base` turned out unused and is not a dependency.

**TS-2. The payment path has three levels: `payTo/0/i1/i2/i3`.** The approved rule had one 31-bit index. While writing the spec's security section, stream C found that this lets anyone holding the public xpub claim a payment:

1. Precompute all 2^31 child addresses once per seller, about 12 CPU core-hours.
2. Recognise a payment's index in the mempool.
3. Find any paymentId with the same index, about 2^31 SHA-256 evaluations or seconds on a GPU.
4. Present it. The stock seller ignores `paymentId` when matching (it is a dynamic field), and the facilitator derives the same script.

The parent session revised DESIGN.md the same day: `d = sha256("x402-btc" ‖ bytes16(paymentId))`, then `i1, i2, i3` = `d[0..4]`, `d[4..8]`, `d[8..12]`, each masked to 31 bits. That gives 93 bits, so neither the table nor the collision search is feasible. `i1` equals the old single index, so the original vector's first step still checks. The analysis is in the shared notes (`stream-c-derivation-31-bit-issue.md`).

**TS-3. Test vectors.** `btc/test-vectors.json` has 16 vectors: {xpub, tpub} × {p2wpkh, p2tr} × four paymentIds, each with `digest`, `indices`, `childPath`, `pubkey`, `scriptPubKey`, `address` and `paymentRef`, plus rejection cases. Both account keys come from the BIP84 test mnemonic: `m/84'/0'/0'` is the DESIGN.md xpub and `m/84'/1'/0'` the tpub. The unit tests check every vector twice. One check uses derive.ts. The other does not reuse it: node's `crypto` computes the digest, the private-key path from the seed (`m/84'/c'/0'/0/i1/i2/i3`) gives the pubkey, and btc-signer's `getAddress` gives the address. The wallet tests also pin the BIP84 and BIP86 published addresses of the same mnemonic.

**TS-4. `paymentRef = sha256(bytes16(paymentId))`**, over the 16 raw bytes, not the 32-char string. For the vector paymentId that is `0xa8faed6abbf35c12a4b26e40f6feb19d736d90045c83b9f9a31f638d323e6811`. The e2e checks `settledBy` and the `Settled` event against it. The Rust stream should use the same bytes; the value is in the vectors.

**TS-5. One `ExactBtcServerScheme` per Bitcoin network.** The SDK calls `enrichPaymentRequiredResponse` once per accept, and `assertAcceptsAdditiveExtraAfterSchemeEnrich` lets the hook add `extra` fields only to accepts with the scheme and network of the accept it was called for. So each instance is bound to one network and adds a fresh `paymentId` to that network's accepts that have none. `validateFacilitatorSupport` compares the instance's `addressType` and `minConfirmations` with the facilitator's advertised `addressTypes` and `{floor, ceiling}`. The SDK then refuses to start a seller whose policy the facilitator would reject (unit test "the SDK refuses to start…"). The hook cannot see `payTo`, so the xpub's network is checked in the constructor and in `enhancePaymentRequirements`, and the seller checks it at startup.

**TS-6. Strict inputs on the TS side.** `paymentId` must be lowercase hex, so every party hashes the same bytes. `payTo` must be `xpub`/`tpub`: `ypub`, `zpub`, `upub`, `vpub` and their multisig forms are refused with a hint to convert. Stream B accepts `zpub`/`vpub` as p2wpkh, which is harmless; the spec says implementations MAY.

**TS-7. The buyer keeps polling on three codes.** These are `settlement_pending`, `invalid_exact_bip122_payload_unconfirmed` and `invalid_exact_bip122_payload_transaction_not_found`. DESIGN.md's buyer line says "continue only on `settlement_pending`", and its stream C test list expects `settlement_pending` for an under-confirmed payment. Stream B built the verdict table instead: `…_unconfirmed` and `…_transaction_not_found`. A fresh payment is `transaction_not_found` until hVM's last header passes its block, about 3 confirmations on mainnet (stream A). With "only `settlement_pending`" the buyer would stop on its first poll. Stream B's note proposes the same resolution. Any other reason stops the buyer, and so does the accept's `maxTimeoutSeconds`.

**TS-8. A failed settle reaches the buyer as 402 with `PAYMENT-RESPONSE`, not `PAYMENT-REQUIRED`.** In the `upfront` flow the SDK puts the facilitator's failure (`success: false`, `errorReason`, `transaction`) into `PAYMENT-RESPONSE` with an empty body (`buildSettlementFailureResponse`). The buyer reads that header first and falls back to `PAYMENT-REQUIRED`'s `error`, for example "No matching payment requirements". The SDK retries a `settlement_pending` settle once by itself (`settleWithPendingRetry`), which the unit test pins.

**TS-9. The journal records a payment before broadcast as well as after.** `ExactBtcClientScheme` writes `paying` before calling `PayBtc` and `paid` with the txid after. A second `createPaymentPayload` for that paymentId returns the recorded output, and concurrent calls share one payment. A `paying` entry with no `paid` entry means a broadcast may have happened: the scheme refuses to pay that paymentId again and says to check the wallet. The buyer adds the full payload and the URL to the entry, so `--resume` needs neither a wallet nor a new 402. The file is `.scratch/buyer-btc/journal.jsonl`, append-only, mode 0600.

**TS-10. The demo wallet is minimal on purpose.** It has one address, from a WIF or the first receive address of a mnemonic (BIP84, or BIP86 for p2tr). It spends confirmed UTXOs largest first and sends change to the same address when the change is at least dust (294 sats for p2wpkh, 330 for p2tr); smaller change goes to the fee. The payment is output 0. The fee rate comes from `--fee-rate`, or else mempool.space's 3-block estimate, and anything above 200 sat/vB is refused. Fees use maximum-size vsizes (p2wpkh input 68 vB, p2tr 58, overhead 11), so the real rate is never below the target. The sequence is btc-signer's default `0xffffffff`, so the transaction does not signal RBF. Its only write is Esplora's `POST /tx`, and the txid Esplora returns must equal the signed one.

**TS-11. Seller settings.** These are DESIGN.md's variables plus two changes. `SELLER_BTC_XPUB` takes one key per network, comma-separated, matched by prefix (`xpub` to mainnet, `tpub` to testnet3), because one key cannot serve both. `SELLER_NETWORKS` may now be empty, giving a Bitcoin-only seller that needs no `SELLER_PAY_TO`. Startup refuses these cases:
- an amount below dust;
- `minConfirmations` < 1;
- `SELLER_BTC_MAX_TIMEOUT_SECONDS` < 600;
- a key of the wrong network or SLIP-132 form;
- nothing to sell.

The default timeout is 3600 as the brief says. DESIGN.md's scheme table says 7200; the earliest acceptance is about 30 minutes, so either works. `SELLER_BTC_AMOUNT` (hemiBTC on Hemi) keeps its name, and the README tells it apart from `SELLER_BTC_AMOUNT_SATS`.

**TS-12. The seller logs what it needs to spend the funds.** A random 93-bit path is invisible to any wallet's gap-limit scan, so the seller's settle line prints the paymentId, the address and `xpub…/0/i1/i2/i3`. A seller that cannot recover paymentIds cannot spend what it was paid. The spec says the resource server MUST keep them.

**TS-13. Development stubs never reach Bitcoin.** `--stub-pay fake` returns a random txid, for `btc/dev/stub-facilitator.ts`. `--stub-pay <local fork RPC>` writes a fabricated transaction into the mock hBK through `@hemi-x402/btc/mock-hbk`. That module refuses any URL that is not 127.0.0.1, localhost, `[::1]` or `host.docker.internal`, and sends from an impersonated address. The stub facilitator reads no chain: `/settle` answers `…_unconfirmed` N times per output, then success, then `invalid_transaction_state`.

**TS-14. `tests/lib/spec.ts`: what `transaction` looks like on bip122.** A success names the Bitcoin txid, 64 lowercase hex without `0x` (`txPatternFor`). A failure that broadcast something, `settlement_pending` or a reverted settle, names the Hemi settle transaction (stream B), so it is an EVM hash; that is `settleFailureViolations`' default `txPattern`. `payer` is address-checked only on `eip155:*`. The bip122 codes are typed (`ErrorCode = SpecErrorCode | Bip122ErrorCode`), and `settleSuccessViolations` is new. All existing callers compile unchanged.

**TS-15. The e2e decides what it can test before collecting.** Its top-level `await` reads `/supported`, and for each listed bip122 kind it checks three things on the matching fork: the settler (from `extra.settler`, else `shared/hemi.json`), code at `hbk`, and the settler's `CONFIRMATION_OFFSET()`. Anything missing becomes a `describe.skipIf` and one warning line naming the reason. The file is `11-btc-l1.test.ts` as the brief says; DESIGN.md's stream B section calls the shared file `11-bip122-exact.test.ts`. Stream B's branch has no e2e file, so there is nothing to merge.

**TS-16. `demo-fork.sh` fifth payment.** It runs only when the demo facilitator's `/supported` lists `bip122:000000000019d6689c085ae165831e93`; otherwise the seller would exit at startup (`missing_facilitator`). The seller then takes BTC on Bitcoin mainnet to the vector xpub. The buyer pays with `--stub-pay <mainnet fork>`, recording 1 confirmation, with `--poll 2`, so it settles on the first re-send.

**TS-17. `E2E_PORT_OFFSET` lets two worktrees run the e2e suite at once.** Streams B and C both ran `npm test -w tests` today and collided. The suite's ports (38080, 38545, 38546) and compose project `hemi-x402-tests` are fixed, and its setup runs `docker compose down` on that project, which tears down whatever another worktree has up. With `E2E_PORT_OFFSET=100` the ports are 38180, 38645 and 38646 and the project is `hemi-x402-tests-100`; unset, nothing changes.

**It does not work on the spike machine as it is now.** Colima's Lima host agent fails every `ssh -O forward` and `ssh -O cancel` it runs (exit 255 in `~/.colima/_lima/colima/ha.stderr.log`). A container port that was not forwarded before never reaches the host, so a run with offset 100 timed out waiting for `/supported` on 38180. Only 38080, forwarded through the long-lived ssh mux, works. On a Colima whose forwarder works, or Docker Desktop, the offset is fine.

Two traps showed up along the way:
- The 38080 forward stays after the container is gone, because the cancel fails too, which trips the setup's port guard. It can be freed by hand when nothing in the VM listens (`colima ssh -- ss -ltn | grep :38080` is empty): `ssh -S ~/.colima/_lima/colima/ssh.sock -O cancel -L 127.0.0.1:38080:127.0.0.1:38080 lima-colima`.
- When the global setup throws, vitest 5 prints only "No test files found" and a `code.charCodeAt is not a function` TypeError from vite's source-map code; the real message is lost. Running the setup alone with tsx shows it.

## Commands and outputs

```
$ npm run typecheck --workspaces; echo $?   # shared, btc, seller, buyer, tests
0
$ npx -w btc vitest run
 Test Files  4 passed (4)
      Tests  90 passed (90)
   Duration  214ms
$ npm run -s vectors -w btc
wrote 16 vectors to …/btc/test-vectors.json
```

DESIGN.md vector under the revised rule:

| | |
|------|------|
| `d` | `e80b56898eea12e8d2dd25c6383febd6420c1778109fdab78b7cf292ba56fb6b` |
| path | `m/0/1745573513/250221288/1390224838` |
| pubkey | `03cbeecf22bec0774f9ae6b06429bcb4c5eea85ba699380ad18ae8ab2cebc9de4b` |
| p2wpkh | `bc1qcjpwqf8yvtpfqq65dghnt64r6cw653kjs6yrca` |
| p2tr | `bc1p36mj32d4l6z589jyh7t6gt9r787dl7rsjztt80hqz3a7eve8g0fsyhls8v` |
| tpub p2wpkh | `tb1qakyl8vdjmkzr7a99ylf7jx9axh4f43u4znf3lq` |

Under the original single-level rule this code reproduced DESIGN.md's first vector exactly: index 1745573513, pubkey `0326c1a6…e6ab`, `bc1qh7vt6al504zckqydvk0963ht2k82kanru70ysp`.

### The seller's 402, with a stub facilitator

The stub facilitator ran on :48080 and the seller on :44021, with both Hemi networks and both Bitcoin networks. No `.env` was read and no chain was touched.

```
$ STUB_FACILITATOR_PORT=48080 npx tsx btc/dev/stub-facilitator.ts &
$ PORT=44021 FACILITATOR_URL=http://127.0.0.1:48080 SELLER_NETWORKS=eip155:743111,eip155:43111 \
  SELLER_PAY_TO=0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65 SELLER_BTC_NETWORKS=btc-mainnet,btc-testnet3 \
  SELLER_BTC_XPUB="xpub6CatWdiZ…PW6V,tpubDC8msFGe…bQ1M" npx tsx seller/server.ts &
[seller]   bip122:000000000019d6689c085ae165831e93  1000 sats of BTC on Bitcoin mainnet to xpub6CatWdiZ…  p2wpkh, 1 confirmation(s), maxTimeoutSeconds 3600
[seller]   bip122:000000000933ea01ad0ee984209779ba  1000 sats of BTC on Bitcoin testnet3 to tpubDC8msFGe…  p2wpkh, 1 confirmation(s), maxTimeoutSeconds 3600
$ curl -si 'http://127.0.0.1:44021/echo?hello=btc' | sed -n 's/^PAYMENT-REQUIRED: //Ip' | tr -d '\r' | base64 -d \
  | jq -c '.accepts[] | {network, asset, amount, payTo: (.payTo[0:12]+"…"), extra}'
{"network":"eip155:743111","asset":"0xD47971C7F5B1067d25cd45d30b2c9eb60de96443","amount":"1000","payTo":"0x15d34AAf54…","extra":{"assetTransferMethod":"permit2"}}
{"network":"eip155:743111","asset":"0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7","amount":"1","payTo":"0x15d34AAf54…","extra":{"assetTransferMethod":"permit2"}}
{"network":"eip155:43111","asset":"0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA","amount":"1000","payTo":"0x15d34AAf54…","extra":{"assetTransferMethod":"eip3009","name":"Bridged USDC (Stargate)","version":"2"}}
{"network":"eip155:43111","asset":"0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28","amount":"1","payTo":"0x15d34AAf54…","extra":{"assetTransferMethod":"permit2"}}
{"network":"bip122:000000000019d6689c085ae165831e93","asset":"BTC","amount":"1000","payTo":"xpub6CatWdiZ…","extra":{"assetTransferMethod":"utxo","paymentFlow":"upfront","addressType":"p2wpkh","minConfirmations":1,"paymentId":"1d15aac3875c11e289a6bfd366892b14"}}
{"network":"bip122:000000000933ea01ad0ee984209779ba","asset":"BTC","amount":"1000","payTo":"tpubDC8msFGe…","extra":{"assetTransferMethod":"utxo","paymentFlow":"upfront","addressType":"p2wpkh","minConfirmations":1,"paymentId":"9d2f5842e281c102d7f3ee3b8ab4b50a"}}
```

### The buyer's pay-then-poll against that stack

The stub answered "unconfirmed" twice, then success; resuming the served payment then got `invalid_transaction_state`.

```
$ npx tsx buyer/pay.ts --asset btc-l1 --network btc-testnet3 --url 'http://127.0.0.1:44021/echo?hello=btc-l1' --stub-pay fake --poll 1
[buyer] paying 1000 sats on Bitcoin testnet3 to tb1qd66456etpcrsvpz0pngzugtdumwe3qter8jgjd (paymentId 12299bf16423f9d28a81192788817d17, tpubDC8msFGe…/0/1047695828/689587608/564264336)
[buyer] bitcoin tx: 14ac11c1fac4fe1199750f84dbec631d11ae749d704a7ea86a00c4f20275be2a vout 0
[buyer] attempt 1: not yet: invalid_exact_bip122_payload_unconfirmed
[buyer] attempt 2: not yet: invalid_exact_bip122_payload_unconfirmed
[buyer] response: {"echo":{"hello":"btc-l1"},"timestamp":"2026-11-09T17:54:03.467Z"}
[buyer] settled on bip122:000000000933ea01ad0ee984209779ba: bitcoin tx 14ac11c1fac4fe1199750f84dbec631d11ae749d704a7ea86a00c4f20275be2a
$ npx tsx buyer/pay.ts --asset btc-l1 --network btc-testnet3 --resume 12299bf16423f9d28a81192788817d17 --poll 1
[buyer] seller answered 402 (invalid_transaction_state)                                   # exit 1
$ … --resume 12299bf16423f9d28a81192788817d17 --url http://127.0.0.1:1/echo
[buyer] the seller did not answer 3 times in a row; the payment is journaled: --resume 12299bf16423f9d28a81192788817d17
$ … --asset btc-l1 --network btc-mainnet --stub-pay fake
[buyer] refusing --network btc-mainnet: it spends real bitcoin. Set ALLOW_MAINNET=yes to proceed.
```

Seller log for that payment:

```
[seller] settle failed (bip122:000000000933ea01ad0ee984209779ba BTC) [invalid_exact_bip122_payload_unconfirmed]: invalid_exact_bip122_payload_unconfirmed
[seller] settle failed (bip122:000000000933ea01ad0ee984209779ba BTC) [invalid_exact_bip122_payload_unconfirmed]: invalid_exact_bip122_payload_unconfirmed
[seller] settled 1000 of BTC on bip122:000000000933ea01ad0ee984209779ba from n/a: bitcoin tx 14ac11c1…be2a (https://mempool.space/testnet/tx/14ac11c1…be2a); paymentId 12299bf16423f9d28a81192788817d17 -> tb1qd66456etpcrsvpz0pngzugtdumwe3qter8jgjd at tpubDC8msFGe…/0/1047695828/689587608/564264336
[seller] settle failed (bip122:000000000933ea01ad0ee984209779ba BTC) [invalid_transaction_state]: invalid_transaction_state
```

Startup refusals:

```
[seller] SELLER_BTC_XPUB for btc-testnet3 (bip122:000000000933ea01ad0ee984209779ba): payTo must be a tpub key on Bitcoin testnet3, got "xpub…" (xpub is for the other Bitcoin network)
[seller] SELLER_BTC_XPUB for btc-mainnet (bip122:000000000019d6689c085ae165831e93): payTo is a zpub (BIP84, mainnet) key; the scheme takes the same key with xpub version bytes (…)
[seller] SELLER_BTC_AMOUNT_SATS must be an integer of at least 294 sats (smaller p2wpkh outputs are dust)
[seller] nothing to sell: set SELLER_NETWORKS and/or SELLER_BTC_NETWORKS
```

### Interface check against stream A's contracts

Stream A's committed contracts (`claude/quirky-mclaren-678b23` @ `41a73b4`) were exported with `git archive` to the scratch directory and built there with `forge build`. They ran on a throwaway local anvil, not a fork, on port 48545. The mock's runtime code went to the mainnet hBK address with `anvil_setCode`, and `X402BtcSettler(hbk, anvil #0, offset 0)` was deployed. A script that was not committed then drove them with `btc/src/derive.ts` and `btc/src/mock-hbk.ts` (`setTx` with the 8-member `Output`, `setConfirmations`):

```
ok   derived p2wpkh, 1 conf: Ok sats=1000 hbkConf=1 conf=1
ok   needs 2 conf: TooFewConfirmations sats=1000 hbkConf=1 conf=1
ok   another paymentId's script: ScriptMismatch sats=1000 hbkConf=1 conf=1
ok   decoy output 0: ScriptMismatch sats=12345 hbkConf=1 conf=1
ok   vout past the end: OutputNotFound sats=0 hbkConf=0 conf=0
ok   one sat short: BelowAmount sats=1000 hbkConf=1 conf=1
ok   unknown txid: TxNotFound sats=0 hbkConf=0 conf=0
ok   derived p2tr, overpaid: Ok sats=1500 hbkConf=3 conf=3
ok   after setConfirmations 2: Ok sats=1000 hbkConf=2 conf=2
ok   settle: status success, gas 89431, settledBy == paymentRef true, Settled {"txid":"0x9060c197…0a0e","scriptPubKeyHash":"0xc913f1b9…99b6","paymentRef":"0x0dcb31fc…c241","vout":1,"sats":"1000","settler":"0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"}
ok   replay after settle: AlreadyConsumed sats=0 hbkConf=0 conf=0
all checks passed
```

So the TS derivation, the mock encoding, `paymentRef` and the event fields that `11-btc-l1` asserts (`scriptPubKeyHash = keccak256(script)`, `settler = msg.sender`) agree with the contract. Stream B's facilitator was not part of this check.

### e2e

See "e2e run" at the end of this file.

## For integration

### What `scripts/fork.sh` must do for `11-btc-l1` and the demo's fifth payment

Neither sibling branch changes `scripts/fork.sh` yet.

1. Put the runtime code of `MockBitcoinKit` at `networks[<hemi>].contracts.hbk` of `shared/hemi.json` on each fork with `anvil_setCode`:
   - mainnet fork: `0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12`;
   - testnet fork: `0xeC9fa5daC1118963933e1A675a4EEA0009b7f215`, where the mock also serves the `btc*` ABI that `HbkTestnetAdapter` reads.

   Get the code with `forge inspect test/mocks/MockBitcoinKit.sol:MockBitcoinKit deployedBytecode`.
2. Deploy `X402BtcSettler` on each fork with `SETTLER` = the facilitator's fork signer and `CONFIRMATION_OFFSET` 0. The signers are anvil #2 `0x3C44…93BC` on the mainnet fork and anvil #1 `0x7099…79C8` on the testnet fork. On the testnet fork, deploy the adapter first and use it as the settler's `HBK`.
3. Pass the fork settler addresses to the facilitator as `X402_BTC_SETTLER_MAINNET` / `_TESTNET`, through `tests/lib/env.ts` `COMPOSE_VARS` and the demo's `compose()`. Use a hemi.15 compose image tag. The e2e reads the settler from `/supported`'s `extra.settler`, so it needs no address of its own.
4. The mock's setters must stay unrestricted: `tests/lib/btc.ts` and `--stub-pay` send from an impersonated address.

### Open points

- **Stream B releasing a claim after a pre-broadcast rejection.** The e2e settles the same `(txid, vout)` after an `…_unconfirmed` settle, which the buyer's polling also relies on. If B kept a pending record after a rejection that broadcast nothing, the second settle would get `invalid_transaction_state`. Its note suggests it does not; the e2e will tell.
- **The Hemi settle hash in the success body.** Stream B omits `extra.settlementTransaction`, which needs a proto change. The seller and buyer read it if present (`extra` or `extensions`) and otherwise say it is in the facilitator log and the `Settled` event.
- **Stream A's mainnet `Output` has 8 members.** `mock-hbk.ts` encodes `setTx` with the 8-member struct and uses `setConfirmations` for new blocks. If the mock's ABI changes, only that file changes.
- **Earliest acceptance is about 3 Bitcoin confirmations on mainnet**, because hVM's last header lags the tip by two blocks. That holds whatever `minConfirmations` says. The spec, both READMEs and the buyer's retry set reflect it. A live run should use `--poll 60` or more and `maxTimeoutSeconds` of at least 3600.
- **`invalid_payload` status for a malformed bip122 payload.** The e2e expects 400, as stream B states.
- **A live mainnet payment needs the owner's go.** The buyer's wallet path (`BUYER_BTC_WIF` or `_MNEMONIC`, `ALLOW_MAINNET=yes`) has run only against faked Esplora answers in unit tests; nothing was broadcast. A few dollars covers the 1000-sat default price plus a 1-input, 2-output fee.

## Proposed README text

For the integration session to place in the top-level `README.md`. Stream C did not edit that file.

### For sellers (append)

> **Bitcoin L1.** The same seller can take native BTC on Bitcoin mainnet or testnet3, paid on chain and verified by the facilitator through Hemi's hBK. Set `SELLER_BTC_NETWORKS=btc-mainnet` and `SELLER_BTC_XPUB` to an account xpub (`tpub` for testnet3); the price is `SELLER_BTC_AMOUNT_SATS` (default 1000). With the SDK, register `new ExactBtcServerScheme({ network, payTo: xpub })` from `@hemi-x402/btc` once per Bitcoin network and price the accept as `{ asset: "BTC", amount: "<sats>" }` with `payTo` = the xpub. Every 402 gets a fresh `extra.paymentId`. Each payment goes to its own address, `xpub/0/i1/i2/i3`, derived from that paymentId. The flow is `upfront`: the SDK skips `/verify` and settles before the handler. Keep the paymentIds of settled payments (the demo seller logs them): no wallet scan finds these addresses, and you need the path to spend the funds. [`docs/specs/scheme_exact_bip122.md`](docs/specs/scheme_exact_bip122.md) is the scheme; [`seller/README.md`](seller/README.md) has the settings.

### For buyers (append)

> **Bitcoin L1.** `npm run pay -w buyer -- --asset btc-l1 --network btc-testnet3` pays a real Bitcoin transaction from `BUYER_BTC_WIF` or `BUYER_BTC_MNEMONIC` to the address derived from the seller's xpub and the 402's paymentId. It then re-sends the same payment every `--poll` seconds until the seller serves it. Expect 30 minutes or more on mainnet: hVM must see about 3 confirmations. Don't use `wrapFetchWithPayment` for this scheme, because it would pay again on the next 402. `ExactBtcClientScheme` journals every payment by paymentId and never pays one twice. The journal is in `.scratch/buyer-btc/journal.jsonl`, and `--resume <paymentId>` continues after a restart. `ALLOW_MAINNET=yes` is required for `btc-mainnet`. See [`buyer/README.md`](buyer/README.md).

### Tests (add)

> ```bash
> npm test -w btc                # @hemi-x402/btc unit tests: derivation vectors, SDK engine, journal, wallet (no network)
> ```
>
> - native BTC on Bitcoin L1 (`11-btc-l1`): payments are fabricated in the mock hBK on the forks. The file covers:
>   - `/supported`;
>   - verify and settle with the Bitcoin txid, `settledBy`, the `Settled` event, replay;
>   - a confirmations boundary, then success with the same payload;
>   - unknown txid, missing output, wrong address (another paymentId, the decoy output), one sat short, overpayment, p2tr;
>   - the other network's key, an out-of-policy `minConfirmations`, malformed payloads;
>   - the stock seller engine with `ExactBtcServerScheme` paid by `ExactBtcClientScheme`: 402 while unconfirmed, served once after, 402 on reuse.

### Limits and open items (replace the **Phase 2** bullet)

> - **Bitcoin L1 payments take time.** hBK returns a transaction only once hVM's last Bitcoin header passes its block, two blocks behind the tip on mainnet. So a payment is accepted after about 3 confirmations, about 30 minutes, whatever `minConfirmations` says. On testnet3 hVM is thousands of blocks behind, so a testnet payment can take hours.
> - **Bitcoin L1 refunds:** none. Overpayment is accepted and buys nothing more. A buyer that stops polling still paid; `--resume` picks the payment up again.
> - **Bitcoin L1 payment addresses** are random descendants of the seller's xpub, so wallets do not find them by scanning. The seller must keep each paymentId to spend the funds.
> - **Bitcoin L1 reorganisations:** a payment accepted at 1 confirmation can be reorganised out of Bitcoin. The consumption record can be reorganised out of Hemi before PoP finality. `minConfirmations` and idempotent handlers per paymentId are the levers.
> - **Bitcoin L1 settle hash:** the success response carries the Bitcoin txid. The Hemi settle transaction is in the facilitator log and the settler's `Settled` event, not yet in the response.

## e2e run

### The existing suite is unaffected

This ran at the default ports, on this branch with its changed `tests/lib/`, the `hemi.14` image, and no bip122 in the facilitator:

```
$ npm test -w tests
 Test Files  13 passed | 1 skipped (14)
      Tests  116 passed | 31 skipped (147)
   Start at  13:06:48
   Duration  381.02s (tests 99%, import 1%)
```

The 116 are the existing tests, the same count as the README's last result. The 31 skipped are all of `11-btc-l1`. Its reason goes to stderr, because vitest drops console output from a file whose tests all skip:

```
[11-btc-l1] skipping: the facilitator's /supported lists no exact kind on bip122:* (stream B not in this image)
```

Two attempts before this one never got past the global setup, and both were collisions:
- The first used the default ports while stream B's run held them.
- The second used `E2E_PORT_OFFSET=100`, whose port 38180 Colima could not forward (TS-17).

