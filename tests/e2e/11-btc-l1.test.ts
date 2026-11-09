/**
 * Native BTC on Bitcoin L1: `exact` on `bip122:*` (docs/specs/scheme_exact_bip122.md), verified through
 * the mock hBK and X402BtcSettler on the Hemi forks. A "Bitcoin payment" is a fabricated transaction
 * written into the mock (tests/lib/btc.ts); nothing here touches Bitcoin.
 *
 * Needs the phase 2 pieces: the facilitator with the bip122 scheme (stream B), and scripts/fork.sh placing
 * the mock hBK at the real hBK address and deploying the settler with the fork signer as SETTLER (stream A,
 * integration). Without them the file skips, saying why, so the rest of the suite is unaffected.
 *
 * Codes (stream B, docs/phase2/facilitator.md): TxNotFound -> …_transaction_not_found, OutputNotFound ->
 * …_vout, ScriptMismatch -> …_recipient_mismatch, BelowAmount -> …_value_mismatch, TooFewConfirmations ->
 * …_unconfirmed, AlreadyConsumed -> invalid_transaction_state; malformed payload -> invalid_payload (400).
 */
import { describe, expect, it } from "vitest";
import { getAddress, keccak256, type Hex } from "viem";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader, type HTTPAdapter } from "@x402/core/http";
import { x402Client } from "@x402/core/client";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import {
  BTC_MAINNET,
  derivePaymentAddress,
  ExactBtcClientScheme,
  ExactBtcServerScheme,
  MemoryPaymentJournal,
  newPaymentId,
  paymentRef,
  type BtcNetwork,
  type PayBtc,
} from "@hemi-x402/btc";
import { nonceOf, publicClient } from "../lib/chain";
import { FACILITATOR_SIGNER, FACILITATOR_URL } from "../lib/env";
import { postRaw, record, settle, supported, verify } from "../lib/facilitator";
import { btcPayment, btcRequirementsFor } from "../lib/payments";
import {
  STATUS_UNREADABLE,
  STATUS_VERDICT,
  settleFailureViolations,
  settleSuccessViolations,
  verifyFailureViolations,
  type ErrorCode,
} from "../lib/spec";
import {
  BTC_NETWORKS_UNDER_TEST,
  btcFork,
  HEMI_OF,
  seedBtcPayment,
  setBtcConfirmations,
  settledBy,
  settledEvents,
  TEST_XPUB,
  type BtcFork,
} from "../lib/btc";

const SATS = 1_000n;

// ---- What this run can test: decided once, before any test is collected. ----
let supportedError = "";
const kinds = await supported().then(
  r => r.body.kinds.filter(k => k.scheme === "exact" && k.network.startsWith("bip122:")),
  e => ((supportedError = String(e)), []),
);
const forks = new Map<BtcNetwork, BtcFork>();
const skipReasons: string[] = [];
if (supportedError) skipReasons.push(`GET ${FACILITATOR_URL}/supported failed: ${supportedError}`);
else if (kinds.length === 0) skipReasons.push("the facilitator's /supported lists no exact kind on bip122:* (stream B not in this image)");
for (const network of BTC_NETWORKS_UNDER_TEST) {
  const kind = kinds.find(k => k.network === network);
  if (!kind) continue;
  const fork = await btcFork(network, kind.extra as Record<string, unknown> | undefined).catch(e => `${e}`);
  if (typeof fork === "string") skipReasons.push(`${network}: ${fork}`);
  else forks.set(network, fork);
}
// Straight to stderr: vitest drops console output from a file whose tests are all skipped.
if (skipReasons.length > 0) process.stderr.write(`[11-btc-l1] skipping: ${skipReasons.join("; ")}\n`);

/** The payment address of `requirements` (from accepted.extra.paymentId, as the facilitator derives it). */
function addressOf(requirements: PaymentRequirements) {
  return derivePaymentAddress(
    requirements.payTo,
    requirements.network as BtcNetwork,
    requirements.extra.paymentId as string,
    requirements.extra.addressType as "p2wpkh" | "p2tr",
  );
}

/** What a stock seller sends alongside: the same requirements with the fresh paymentId of its rebuilt 402. */
function sellerCopy(requirements: PaymentRequirements): PaymentRequirements {
  return { ...requirements, extra: { ...requirements.extra, paymentId: newPaymentId() } };
}

async function expectVerifyRejected(label: string, payment: PaymentPayload, requirements: PaymentRequirements, reason: ErrorCode) {
  const res = await verify(payment, requirements);
  record(`verify ${label}`, res);
  expect(verifyFailureViolations(res.body, { reason, network: requirements.network })).toEqual([]);
  expect(res.status).toBe(STATUS_VERDICT);
}

async function expectSettleRejected(label: string, fork: BtcFork, payment: PaymentPayload, requirements: PaymentRequirements, reason: ErrorCode) {
  const nonce = await nonceOf(fork.hemi, FACILITATOR_SIGNER[fork.hemi]);
  const res = await settle(payment, requirements);
  record(`settle ${label}`, res);
  expect(settleFailureViolations(res.body, { reasons: [reason], network: requirements.network, broadcast: false })).toEqual([]);
  expect(res.status).toBe(STATUS_VERDICT);
  // A rejected payment costs the facilitator nothing: no Hemi transaction was sent.
  expect(await nonceOf(fork.hemi, FACILITATOR_SIGNER[fork.hemi])).toBe(nonce);
}

describe.skipIf(kinds.length === 0)("/supported", () => {
  it("lists exact on both Bitcoin networks, BTC over utxo/upfront, with the Hemi signer", async () => {
    const res = await supported();
    for (const network of BTC_NETWORKS_UNDER_TEST) {
      const kind = res.body.kinds.find(k => k.scheme === "exact" && k.network === network);
      expect(kind, `exact on ${network}`).toBeDefined();
      expect(kind!.x402Version).toBe(2);
      expect(kind!.extra).toMatchObject({ asset: "BTC", assetTransferMethod: "utxo", paymentFlow: "upfront" });
      const signers = Object.entries(res.body.signers)
        .filter(([key]) => key === network || key === "bip122:*")
        .flatMap(([, list]) => list.map(a => getAddress(a)));
      expect(signers).toContain(FACILITATOR_SIGNER[HEMI_OF[network]]);
    }
  });
});

for (const network of BTC_NETWORKS_UNDER_TEST) {
  const fork = forks.get(network)!;
  describe.skipIf(!forks.has(network))(`exact on ${network} (${HEMI_OF[network]} fork)`, () => {
    const xpub = TEST_XPUB[network];

    describe("happy path, then replay", () => {
      let requirements: PaymentRequirements;
      let payment: PaymentPayload;
      let ref: { txid: string; vout: number };

      it("verify: a confirmed output paying the derived address is valid, derived from accepted.extra.paymentId", async () => {
        requirements = btcRequirementsFor(network, xpub, SATS);
        ref = await seedBtcPayment(fork, { script: addressOf(requirements).script, sats: SATS, vout: 1, confirmations: 1 });
        payment = btcPayment(requirements, ref);
        const res = await verify(payment, sellerCopy(requirements));
        record(`verify ok: ${network}`, res);
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ isValid: true });
      });

      it("settle: success with the Bitcoin txid and no payer; settledBy = paymentRef; one Settled event from the signer", async () => {
        const fromBlock = await publicClient(fork.hemi).getBlockNumber();
        const nonce = await nonceOf(fork.hemi, FACILITATOR_SIGNER[fork.hemi]);
        const res = await settle(payment, sellerCopy(requirements));
        record(`settle ok: ${network}`, res);
        expect(res.status).toBe(200);
        expect(settleSuccessViolations(res.body, { network, transaction: ref.txid })).toEqual([]);
        expect(res.body).not.toHaveProperty("payer");
        expect(await nonceOf(fork.hemi, FACILITATOR_SIGNER[fork.hemi])).toBe(nonce + 1);

        const id = requirements.extra.paymentId as string;
        expect(await settledBy(fork, ref.txid, ref.vout)).toBe(paymentRef(id));
        const events = await settledEvents(fork, ref.txid, fromBlock);
        expect(
          events.map(e => ({
            vout: e.args.vout,
            scriptPubKeyHash: e.args.scriptPubKeyHash,
            sats: e.args.sats,
            paymentRef: e.args.paymentRef,
            settler: getAddress(e.args.settler!),
          })),
        ).toEqual([
          {
            vout: ref.vout,
            scriptPubKeyHash: keccak256(`0x${addressOf(requirements).script}` as Hex),
            sats: SATS,
            paymentRef: paymentRef(id),
            settler: FACILITATOR_SIGNER[fork.hemi],
          },
        ]);
      });

      it('replay: settle again -> "invalid_transaction_state", nothing broadcast', async () => {
        await expectSettleRejected(`replay: ${network}`, fork, payment, sellerCopy(requirements), "invalid_transaction_state");
      });

      it('replay: verify -> "invalid_transaction_state"', async () => {
        await expectVerifyRejected(`replay: ${network}`, payment, requirements, "invalid_transaction_state");
      });
    });

    it("too few confirmations -> …_unconfirmed until the next block, then the same payload settles", async () => {
      const requirements = btcRequirementsFor(network, xpub, SATS, { minConfirmations: 2 });
      const ref = await seedBtcPayment(fork, { script: addressOf(requirements).script, sats: SATS, confirmations: 1 });
      const payment = btcPayment(requirements, ref);
      await expectVerifyRejected(`1 of 2 confirmations: ${network}`, payment, requirements, "invalid_exact_bip122_payload_unconfirmed");
      await expectSettleRejected(`1 of 2 confirmations: ${network}`, fork, payment, requirements, "invalid_exact_bip122_payload_unconfirmed");
      await setBtcConfirmations(fork, ref.txid, 2);
      const res = await settle(payment, sellerCopy(requirements));
      record(`settle at 2 of 2 confirmations: ${network}`, res);
      expect(settleSuccessViolations(res.body, { network, transaction: ref.txid })).toEqual([]);
    });

    it("a txid hBK does not know -> …_transaction_not_found", async () => {
      const requirements = btcRequirementsFor(network, xpub, SATS);
      const payment = btcPayment(requirements, { txid: "ab".repeat(32), vout: 0 });
      await expectVerifyRejected(`unknown txid: ${network}`, payment, requirements, "invalid_exact_bip122_payload_transaction_not_found");
      await expectSettleRejected(`unknown txid: ${network}`, fork, payment, requirements, "invalid_exact_bip122_payload_transaction_not_found");
    });

    it("an output index past the end -> …_vout", async () => {
      const requirements = btcRequirementsFor(network, xpub, SATS);
      const ref = await seedBtcPayment(fork, { script: addressOf(requirements).script, sats: SATS, vout: 1 });
      const payment = btcPayment(requirements, { txid: ref.txid, vout: 5 });
      await expectVerifyRejected(`vout past the end: ${network}`, payment, requirements, "invalid_exact_bip122_payload_vout");
    });

    it("an output to another paymentId's address -> …_recipient_mismatch (also the decoy output 0)", async () => {
      const paid = btcRequirementsFor(network, xpub, SATS);
      const ref = await seedBtcPayment(fork, { script: addressOf(paid).script, sats: SATS, vout: 1 });
      const other = btcRequirementsFor(network, xpub, SATS);
      await expectVerifyRejected(`other paymentId: ${network}`, btcPayment(other, ref), other, "invalid_exact_bip122_payload_recipient_mismatch");
      await expectSettleRejected(`other paymentId: ${network}`, fork, btcPayment(other, ref), other, "invalid_exact_bip122_payload_recipient_mismatch");
      await expectVerifyRejected(`decoy output: ${network}`, btcPayment(paid, { txid: ref.txid, vout: 0 }), paid, "invalid_exact_bip122_payload_recipient_mismatch");
    });

    it("one sat short -> …_value_mismatch; overpaying is valid", async () => {
      const short = btcRequirementsFor(network, xpub, SATS);
      const refShort = await seedBtcPayment(fork, { script: addressOf(short).script, sats: SATS - 1n });
      await expectVerifyRejected(`one sat short: ${network}`, btcPayment(short, refShort), short, "invalid_exact_bip122_payload_value_mismatch");
      await expectSettleRejected(`one sat short: ${network}`, fork, btcPayment(short, refShort), short, "invalid_exact_bip122_payload_value_mismatch");

      const over = btcRequirementsFor(network, xpub, SATS);
      const refOver = await seedBtcPayment(fork, { script: addressOf(over).script, sats: SATS + 500n });
      const res = await verify(btcPayment(over, refOver), over);
      record(`verify overpaid: ${network}`, res);
      expect(res.body).toEqual({ isValid: true });
    });

    it("a p2tr payment (BIP86 key path) is valid", async () => {
      const requirements = btcRequirementsFor(network, xpub, SATS, { addressType: "p2tr" });
      expect(addressOf(requirements).script).toMatch(/^5120/);
      const ref = await seedBtcPayment(fork, { script: addressOf(requirements).script, sats: SATS });
      const res = await verify(btcPayment(requirements, ref), requirements);
      record(`verify p2tr: ${network}`, res);
      expect(res.body).toEqual({ isValid: true });
    });

    it("payTo of the other Bitcoin network -> invalid_exact_bip122_pay_to", async () => {
      const otherKey = TEST_XPUB[network === BTC_MAINNET ? BTC_NETWORKS_UNDER_TEST[1] : BTC_MAINNET];
      const requirements = { ...btcRequirementsFor(network, xpub, SATS), payTo: otherKey };
      const payment = btcPayment(requirements, { txid: "cd".repeat(32), vout: 0 });
      await expectVerifyRejected(`other network's key: ${network}`, payment, requirements, "invalid_exact_bip122_pay_to");
    });

    it("minConfirmations above the facilitator's ceiling -> invalid_payment_requirements", async () => {
      const requirements = btcRequirementsFor(network, xpub, SATS, { minConfirmations: 1000 });
      const payment = btcPayment(requirements, { txid: "ef".repeat(32), vout: 0 });
      await expectVerifyRejected(`minConfirmations 1000: ${network}`, payment, requirements, "invalid_payment_requirements");
    });

    it("a malformed payload -> invalid_payload (400)", async () => {
      const requirements = btcRequirementsFor(network, xpub, SATS);
      const bad: Record<string, unknown>[] = [{ txid: "abc", vout: 0 }, { txid: "ab".repeat(32), vout: -1 }, { txid: "ab".repeat(32) }];
      for (const payload of bad) {
        const body = { x402Version: 2, paymentPayload: { ...btcPayment(requirements, { txid: "ab".repeat(32), vout: 0 }), payload }, paymentRequirements: requirements };
        for (const path of ["/verify", "/settle"] as const) {
          const res = await postRaw(path, JSON.stringify(body));
          record(`${path} malformed payload ${JSON.stringify(payload)}: ${network}`, res);
          expect(res.status).toBe(STATUS_UNREADABLE);
          expect(res.body).toMatchObject(path === "/verify" ? { isValid: false, invalidReason: "invalid_payload" } : { success: false, errorReason: "invalid_payload" });
        }
      }
    });
  });
}

/**
 * The stock TS seller engine (x402HTTPResourceServer + HTTPFacilitatorClient, what @x402/express runs, as in
 * 04c) with ExactBtcServerScheme, and a buyer with x402Client + ExactBtcClientScheme whose PayBtc writes into
 * the mock hBK. This is the pay-then-poll protocol buyer/btc-l1.ts drives over HTTP.
 */
const stockNetwork = BTC_NETWORKS_UNDER_TEST.find(n => forks.has(n));
describe.skipIf(!stockNetwork)(`a stock TS seller with ExactBtcServerScheme (${stockNetwork ?? "skipped"})`, () => {
  const PATH = "/paid";
  const network = stockNetwork!;
  const xpub = TEST_XPUB[network];
  let seller: x402HTTPResourceServer;
  let required: ReturnType<typeof decodePaymentRequiredHeader>;
  let payment: PaymentPayload;
  const paid: { txid: string; vout: number }[] = [];

  const adapter = (header?: string): HTTPAdapter => ({
    getHeader: name => (name.toLowerCase() === "payment-signature" ? header : undefined),
    getMethod: () => "GET",
    getPath: () => PATH,
    getUrl: () => `http://seller.e2e.local${PATH}`,
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "hemi-x402-e2e",
  });
  const request = (p?: PaymentPayload) =>
    seller.processHTTPRequest({ adapter: adapter(p ? encodePaymentSignatureHeader(p) : undefined), path: PATH, method: "GET" });
  async function refusal(p: PaymentPayload): Promise<{ status: number; reason?: string }> {
    const result = await request(p);
    if (result.type !== "payment-error") throw new Error(`expected a refusal, got ${result.type}`);
    const header = result.response.headers["PAYMENT-RESPONSE"];
    return { status: result.response.status, reason: header ? decodePaymentResponseHeader(header).errorReason : undefined };
  }

  it("the unpaid 402 carries a 32-hex paymentId and the upfront flow", async () => {
    const fork = forks.get(network)!;
    const rs = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL })).register(
      network,
      new ExactBtcServerScheme({ network, payTo: xpub }),
    );
    seller = new x402HTTPResourceServer(rs, {
      [`GET ${PATH}`]: {
        accepts: { scheme: "exact", network, payTo: xpub, price: { asset: "BTC", amount: SATS.toString() }, maxTimeoutSeconds: 3600 },
        description: "e2e paid route",
        mimeType: "application/json",
      },
    });
    await seller.initialize();
    const result = await request();
    if (result.type !== "payment-error") throw new Error("expected 402");
    expect(result.response.status).toBe(402);
    required = decodePaymentRequiredHeader(result.response.headers["PAYMENT-REQUIRED"]!);
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]).toMatchObject({
      network,
      asset: "BTC",
      amount: SATS.toString(),
      payTo: xpub,
      extra: { assetTransferMethod: "utxo", paymentFlow: "upfront", paymentId: expect.stringMatching(/^[0-9a-f]{32}$/) },
    });
    expect(fork.network).toBe(network);
  });

  it("the buyer pays once; before the confirmation the seller answers 402 …_unconfirmed", async () => {
    const fork = forks.get(network)!;
    const pay: PayBtc = async (_address, sats, ctx) => {
      const ref = await seedBtcPayment(fork, { script: ctx.script, sats, confirmations: 0 });
      paid.push(ref);
      return ref;
    };
    const client = new x402Client()
      .register(network, new ExactBtcClientScheme(pay, { journal: new MemoryPaymentJournal() }))
      .setSpendControls({ allowedAssets: [{ network, asset: "BTC", maxAmountPerPayment: "5000" }] });
    payment = await client.createPaymentPayload(required);
    expect(await client.createPaymentPayload(required)).toEqual(payment);
    expect(paid).toHaveLength(1);
    expect(await refusal(payment)).toEqual({ status: 402, reason: "invalid_exact_bip122_payload_unconfirmed" });
  });

  it("after one confirmation the same payload is served once, with the Bitcoin txid", async () => {
    const fork = forks.get(network)!;
    await setBtcConfirmations(fork, paid[0].txid, 1);
    const result = await request(payment);
    expect(result.type).toBe("payment-verified");
    if (result.type !== "payment-verified") return;
    expect(result.beforeHandlerSettlement?.result).toMatchObject({ success: true, transaction: paid[0].txid, network });
  });

  it("a second use of the payment gets 402 invalid_transaction_state", async () => {
    expect(await refusal(payment)).toEqual({ status: 402, reason: "invalid_transaction_state" });
  });
});
