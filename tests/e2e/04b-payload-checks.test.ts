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
 * | Permit2 spender other than the proxy   | invalid_payload                                          |
 * | body is not JSON / names no network    | invalid_payload                                          |
 * | no top-level x402Version, or one that  | invalid_x402_version                                     |
 * | paymentPayload.x402Version contradicts |                                                          |
 * | a consistent but unserved x402Version  | invalid_x402_version                                     |
 *
 * HTTP status: 200 for a verdict on a payload that could be read, 400 for a request that cannot be read
 * (not JSON, names no network, a version that cannot be read), as the TS reference facilitator answers
 * (lib/spec.ts STATUS_VERDICT).
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
import { ensurePermit2Approval, fundEth, fundToken } from "../lib/chain";
import { postRaw, record, settle, verify } from "../lib/facilitator";
import { freshAccount, freshAddress, requirementsFor, resign, signPayment } from "../lib/payments";
import {
  SPEC_INVALID_SIGNATURE,
  STATUS_UNREADABLE,
  STATUS_VERDICT,
  settleFailureViolations,
  verifyFailureViolations,
  type SpecErrorCode,
} from "../lib/spec";

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
  expect(v.status).toBe(STATUS_VERDICT);
  const s = await settle(payment, requirements);
  record(`settle ${label}`, s);
  expect(
    settleFailureViolations(s.body, { reasons: [reason], payer: payer.address, network: requirements.network, broadcast: false }),
  ).toEqual([]);
  expect(s.status).toBe(STATUS_VERDICT);
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
      expect(res.status).toBe(STATUS_UNREADABLE);
      if (path === "/verify") {
        expect(verifyFailureViolations(res.body, { reason: "invalid_payload" })).toEqual([]);
      } else {
        expect(res.body).toMatchObject({ success: false, errorReason: "invalid_payload", transaction: "" });
        // No network can be read from it, so the field is omitted rather than sent as "".
        expect(res.body).not.toHaveProperty("network");
      }
    }
  });

  it("a request with x402Version but no payment names no network: invalid_payload, network omitted", async () => {
    const res = await postRaw("/settle", JSON.stringify({ x402Version: 2 }));
    record("/settle with only x402Version", res);
    expect(res.status).toBe(STATUS_UNREADABLE);
    expect(res.body).toMatchObject({ success: false, errorReason: "invalid_payload", transaction: "" });
    expect(res.body).not.toHaveProperty("network");
  });
});

/**
 * §9 `invalid_x402_version`: "Protocol version is not supported" (facilitator/x402-rs/patches 0013, 0017).
 * The facilitator serves x402 v2 only. Stock x402-rs, and hemi.3, answered a top-level x402Version of 1,
 * or none, with invalid_network ("Unsupported chain") although the network is served; up to hemi.6, a
 * top-level x402Version 2 with paymentPayload.x402Version 1 got invalid_payload.
 */
describe("an x402 version the facilitator cannot read or does not serve", () => {
  const payer = freshAccount();

  it("no top-level x402Version, or one the payload contradicts: invalid_x402_version, 400", async () => {
    const requirements = requirementsFor(MAINNET, usdcAsset(MAINNET), freshAddress(), 1_000n);
    const payment = await signPayment(payer, requirements);
    expect(payment.x402Version).toBe(2);
    const bodies: [string, Record<string, unknown>][] = [
      ["x402Version 1, paymentPayload.x402Version 2", { x402Version: 1, paymentPayload: payment, paymentRequirements: requirements }],
      [
        "x402Version 2, paymentPayload.x402Version 1",
        { x402Version: 2, paymentPayload: { ...payment, x402Version: 1 }, paymentRequirements: requirements },
      ],
      ["no x402Version", { paymentPayload: payment, paymentRequirements: requirements }],
      ["empty object", {}],
    ];
    for (const [label, body] of bodies) {
      const v = await postRaw("/verify", JSON.stringify(body));
      record(`/verify with ${label}`, v);
      expect(v.body).toMatchObject({ isValid: false, invalidReason: "invalid_x402_version" });
      expect(v.status).toBe(STATUS_UNREADABLE);
      const s = await postRaw("/settle", JSON.stringify(body));
      record(`/settle with ${label}`, s);
      expect(s.body).toMatchObject({ success: false, errorReason: "invalid_x402_version", transaction: "" });
      expect(s.status).toBe(STATUS_UNREADABLE);
    }
    const mismatch = await postRaw(
      "/verify",
      JSON.stringify({ x402Version: 2, paymentPayload: { ...payment, x402Version: 1 }, paymentRequirements: requirements }),
    );
    expect(mismatch.body.invalidMessage).toBe("The request's x402Version is 2, but paymentPayload.x402Version is 1");
  });

  it("x402Version 1 throughout, on a served network: invalid_x402_version, as a verdict (200)", async () => {
    const requirements = requirementsFor(MAINNET, usdcAsset(MAINNET), freshAddress(), 1_000n);
    const payment = { ...(await signPayment(payer, requirements)), x402Version: 1 };
    const body = { x402Version: 1, paymentPayload: payment, paymentRequirements: requirements };
    const v = await postRaw("/verify", JSON.stringify(body));
    record("/verify with x402Version 1 throughout", v);
    expect(v.body).toMatchObject({ isValid: false, invalidReason: "invalid_x402_version" });
    expect(v.status).toBe(STATUS_VERDICT);
    const s = await postRaw("/settle", JSON.stringify(body));
    record("/settle with x402Version 1 throughout", s);
    expect(s.body).toMatchObject({ success: false, errorReason: "invalid_x402_version", transaction: "" });
    expect(s.status).toBe(STATUS_VERDICT);
  });
});

/**
 * A Permit2 spender other than the x402 exact proxy is a malformed payload, §9 `invalid_payload`
 * (facilitator/x402-rs/patches 0014). hemi.4 called it a recipient mismatch, or, for an EOA payer, an
 * invalid signature. It is checked before the signature, as in the TS reference (permit2.ts).
 */
describe("Permit2 spender other than the x402 exact proxy", () => {
  it("a permit signed for another spender is invalid_payload", async () => {
    const payer = freshAccount();
    const signed = await signPayment(payer, requirementsFor(MAINNET, btcAsset(MAINNET), freshAddress(), 10n));
    const payment = await resign(payer, signed, a => {
      a.spender = freshAddress();
    });
    await expectRejected("spender is not the proxy: Permit2", payment, payment.accepted, "invalid_payload", payer);
  });
});

/**
 * Combined failures: a payload that is wrong off-chain AND cannot be paid on chain. The facilitator
 * reports the off-chain failure, like the TS reference facilitator (see facilitator/x402-rs/README.md,
 * "Check order"): expiry, amount and recipient are checked before the payer's allowance and balance.
 * scheme_exact_evm.md lists allowance and balance first, so this pins the deliberate difference.
 */
describe("combined failures: the off-chain check is reported, not allowance or balance", () => {
  const expired = { maxTimeoutSeconds: 1 };
  const cases: {
    name: string;
    method: Method;
    setup: (payer: LocalAccount, m: Method) => Promise<void>;
  }[] = [
    {
      name: "Permit2, funded but never approved",
      method: METHODS[1]!,
      setup: async (payer, m) => fundToken(m.network, m.asset, payer.address, 1_000_000n),
    },
    {
      name: "Permit2, approved but unfunded",
      method: METHODS[1]!,
      setup: async (payer, m) => {
        await fundEth(m.network, payer.address);
        await ensurePermit2Approval(m.network, payer, m.asset, m.amount);
      },
    },
    { name: "EIP-3009, unfunded", method: METHODS[0]!, setup: async () => {} },
  ];

  for (const c of cases) {
    const m = c.method;
    describe(c.name, () => {
      const payer = freshAccount();
      const sign = (amount: bigint, extra: Partial<PaymentRequirements> = {}) =>
        signPayment(payer, { ...requirementsFor(m.network, m.asset, freshAddress(), amount), ...extra });

      it("+ expired: valid_before; + over-payment: value_mismatch; + wrong recipient: recipient_mismatch", async () => {
        await c.setup(payer, m);
        const expiredPayment = await sign(m.amount, expired);
        await expectRejected(
          `${c.name} + expired`,
          expiredPayment,
          expiredPayment.accepted,
          "invalid_exact_evm_payload_authorization_valid_before",
          payer,
        );
        const [over, overRequirements] = presentedAs(await sign(m.amount * 5n), { amount: m.amount.toString() });
        await expectRejected(`${c.name} + over-payment`, over, overRequirements, "invalid_exact_evm_payload_authorization_value_mismatch", payer);
        const [elsewhere, elsewhereRequirements] = presentedAs(await sign(m.amount), { payTo: freshAddress() });
        await expectRejected(`${c.name} + wrong recipient`, elsewhere, elsewhereRequirements, "invalid_exact_evm_payload_recipient_mismatch", payer);
        // Control: the same payer with a correct payload gets the on-chain reason.
        const fine = await sign(m.amount);
        const v = await verify(fine, fine.accepted);
        expect(v.body.invalidReason).toBe(c.name.includes("never approved") ? "permit2_allowance_required" : "insufficient_funds");
      });
    });
  }
});
