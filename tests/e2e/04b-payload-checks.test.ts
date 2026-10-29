/**
 * Payloads that are validly signed but wrong for the requirements, and requests that are not readable.
 * Each one must be rejected by /verify and /settle with the x402 v2 §9 code for it, before anything is
 * broadcast (specs/x402-specification-v2.md §9; scheme_exact_evm.md EIP-3009 Phase 2 step 3, Permit2
 * Phase 3 steps 4–6):
 *
 * | Case                                   | §9 code                                                  |
 * | amount above or below the requirement  | invalid_exact_evm_payload_authorization_value_mismatch   |
 * | expired (validBefore / deadline)       | invalid_exact_evm_payload_authorization_valid_before     |
 * | not valid yet (validAfter in future)   | invalid_exact_evm_payload_authorization_valid_after      |
 * | pays someone other than payTo          | invalid_exact_evm_payload_recipient_mismatch             |
 * | Permit2 permit for another token       | invalid_payload                                          |
 * | body is not JSON / names no network    | invalid_payload                                          |
 *
 * Stock x402-rs (and hemi.2) accepted an over-payment and settled the larger amount, and used its own
 * names for the rest (invalid_payment_expired, recipient_mismatch, asset_mismatch, ...); a body that is
 * not JSON got a plain-text 400. facilitator/x402-rs/patches 0009 and 0010 fix that.
 *
 * Payloads come from the stock client; where the stock client cannot produce the case (a future
 * validAfter), the authorization is altered and signed again with the SDK's own EIP-712 types.
 */
import { describe, expect, it } from "vitest";
import type { LocalAccount } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { btcAsset, MAINNET, usdcAsset, type HemiAsset, type HemiNetwork } from "@hemi-x402/shared";
import { postRaw, record, settle, verify } from "../lib/facilitator";
import { freshAccount, freshAddress, requirementsFor, resign, signPayment } from "../lib/payments";
import { SPEC_INVALID_SIGNATURE, settleFailureViolations, verifyFailureViolations, type SpecErrorCode } from "../lib/spec";

interface Method {
  method: "EIP-3009" | "Permit2";
  network: HemiNetwork;
  asset: HemiAsset;
  amount: bigint;
}
const METHODS: Method[] = [
  { method: "EIP-3009", network: MAINNET, asset: usdcAsset(MAINNET), amount: 1_000n },
  { method: "Permit2", network: MAINNET, asset: btcAsset(MAINNET), amount: 10n },
];

/** The same payment presented against other requirements (`accepted` is not signed; it must equal them). */
function presentedAs(payment: PaymentPayload, changes: Partial<PaymentRequirements>): [PaymentPayload, PaymentRequirements] {
  const requirements = { ...payment.accepted, ...changes } as PaymentRequirements;
  return [{ ...structuredClone(payment), accepted: requirements }, requirements];
}

async function expectRejected(
  label: string,
  payment: PaymentPayload,
  requirements: PaymentRequirements,
  reason: SpecErrorCode,
  payer: LocalAccount,
) {
  const v = await verify(payment, requirements);
  record(`verify ${label}`, v);
  expect(verifyFailureViolations(v.body, { reason, payer: payer.address })).toEqual([]);
  expect(v.status).toBe(400);
  const s = await settle(payment, requirements);
  record(`settle ${label}`, s);
  expect(
    settleFailureViolations(s.body, { reasons: [reason], payer: payer.address, network: requirements.network, broadcast: false }),
  ).toEqual([]);
  expect(s.status).toBe(400);
}

for (const m of METHODS) {
  describe(`${m.method} (${m.asset.symbol} on ${m.network})`, () => {
    const payer = freshAccount();
    const sign = (amount: bigint, extra: Partial<PaymentRequirements> = {}) =>
      signPayment(payer, { ...requirementsFor(m.network, m.asset, freshAddress(), amount), ...extra });

    it("over-payment: authorizing 5x the required amount is a value mismatch, not a larger settlement", async () => {
      const [payment, requirements] = presentedAs(await sign(m.amount * 5n), { amount: m.amount.toString() });
      await expectRejected(`over-payment: ${m.method}`, payment, requirements, "invalid_exact_evm_payload_authorization_value_mismatch", payer);
    });

    it("under-payment: authorizing half the required amount is a value mismatch", async () => {
      const [payment, requirements] = presentedAs(await sign(m.amount / 2n), { amount: m.amount.toString() });
      await expectRejected(`under-payment: ${m.method}`, payment, requirements, "invalid_exact_evm_payload_authorization_value_mismatch", payer);
    });

    it("expired: validBefore / deadline one second away", async () => {
      // The stock client sets validBefore = now + maxTimeoutSeconds; the facilitator wants at least 6 s left.
      const payment = await sign(m.amount, { maxTimeoutSeconds: 1 });
      await expectRejected(`expired: ${m.method}`, payment, payment.accepted, "invalid_exact_evm_payload_authorization_valid_before", payer);
    });

    it("not valid yet: validAfter an hour from now", async () => {
      const later = String(Math.floor(Date.now() / 1000) + 3600);
      const payment = await resign(payer, await sign(m.amount), a => {
        if (a.witness) a.witness.validAfter = later;
        else a.validAfter = later;
      });
      await expectRejected(`early: ${m.method}`, payment, payment.accepted, "invalid_exact_evm_payload_authorization_valid_after", payer);
    });

    it("recipient mismatch: the authorization pays someone other than payTo", async () => {
      const [payment, requirements] = presentedAs(await sign(m.amount), { payTo: freshAddress() });
      await expectRejected(`recipient mismatch: ${m.method}`, payment, requirements, "invalid_exact_evm_payload_recipient_mismatch", payer);
    });
  });
}

describe("another asset than the one signed for", () => {
  const payer = freshAccount();

  it("Permit2: a permit for hemiBTC presented for USDC.e is invalid_payload", async () => {
    const signed = await signPayment(payer, requirementsFor(MAINNET, btcAsset(MAINNET), freshAddress(), 10n));
    const [payment, requirements] = presentedAs(signed, { asset: usdcAsset(MAINNET).address });
    await expectRejected("wrong asset: Permit2", payment, requirements, "invalid_payload", payer);
  });

  it(`EIP-3009: the token is the signature's verifying contract, so another asset is "${SPEC_INVALID_SIGNATURE}"`, async () => {
    const signed = await signPayment(payer, requirementsFor(MAINNET, usdcAsset(MAINNET), freshAddress(), 1_000n));
    const [payment, requirements] = presentedAs(signed, { asset: btcAsset(MAINNET).address });
    await expectRejected("wrong asset: EIP-3009", payment, requirements, SPEC_INVALID_SIGNATURE, payer);
  });
});

describe("unreadable requests get the endpoint's JSON error shape with invalid_payload", () => {
  it("a body that is not JSON", async () => {
    for (const path of ["/verify", "/settle"] as const) {
      const res = await postRaw(path, "{not json");
      record(`${path} with a body that is not JSON`, res);
      expect(res.status).toBe(400);
      if (path === "/verify") {
        expect(verifyFailureViolations(res.body, { reason: "invalid_payload" })).toEqual([]);
      } else {
        expect(res.body).toMatchObject({ success: false, errorReason: "invalid_payload", transaction: "" });
        // No network can be read from it, so the field is omitted rather than sent as "".
        expect(res.body).not.toHaveProperty("network");
      }
    }
  });

  it("an empty object names no network: invalid_payload, network omitted", async () => {
    const res = await postRaw("/settle", "{}");
    record("/settle with {}", res);
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, errorReason: "invalid_payload", transaction: "" });
    expect(res.body).not.toHaveProperty("network");
  });
});
