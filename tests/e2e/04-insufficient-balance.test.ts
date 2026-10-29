/**
 * DoD: "... an insufficient-balance case ... return[s] the spec's error shapes".
 *
 * A fresh account funded with ETH only signs a valid payment with the stock client.
 * Spec: specs/x402-specification-v2.md §9 `insufficient_funds`: "Client does not have enough tokens to
 * complete the payment", with the §7.1 / §7.2 error examples using exactly that code; field rules per
 * §5.4.2 / §5.3.2. scheme_exact_evm.md: EIP-3009 Phase 2 step 2 and Permit2 Phase 3 step 3 check balance.
 *
 * Stock x402-rs answered with "payer": "" and "network": "", and settled Permit2 without re-checking the
 * balance (HTTP 500 "unexpected_error"); facilitator/x402-rs/patches 0002 and 0004 fix that.
 *
 * Permit2 checks allowance (Phase 3 step 2, 412 PERMIT2_ALLOWANCE_REQUIRED) before balance (step 3), so
 * the insufficient-balance account first approves Permit2, as a real buyer would. The no-allowance
 * cases are covered separately below.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { LocalAccount } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { MAINNET, TESTNET, usdcAsset, type HemiAsset, type HemiNetwork } from "@hemi-x402/shared";
import { ensurePermit2Approval, fundEth, fundToken, tokenBalance } from "../lib/chain";
import { record, settle, verify, type HttpResult } from "../lib/facilitator";
import { freshAccount, freshAddress, requirementsFor, signPayment } from "../lib/payments";
import { snapshot, type Snapshot } from "../lib/snapshot";
import {
  SPEC_INSUFFICIENT_FUNDS,
  SPEC_PERMIT2_ALLOWANCE_REQUIRED,
  settleFailureViolations,
  verifyFailureViolations,
} from "../lib/spec";

interface Method {
  method: "EIP-3009" | "Permit2";
  network: HemiNetwork;
  asset: HemiAsset;
  amount: bigint;
}
const METHODS: Method[] = [
  { method: "EIP-3009", network: MAINNET, asset: usdcAsset(MAINNET), amount: 1_000n },
  { method: "Permit2", network: TESTNET, asset: usdcAsset(TESTNET), amount: 1_000n },
];

for (const m of METHODS) {
  describe(`insufficient balance, ${m.method} (${m.asset.symbol} on ${m.network})`, () => {
    let poor: LocalAccount;
    const payTo = freshAddress();
    let requirements: PaymentRequirements;
    let payment: PaymentPayload;
    let before: Snapshot;

    beforeAll(async () => {
      poor = freshAccount();
      await fundEth(m.network, poor.address);
      if (m.asset.transferMethod === "permit2") {
        // The one-time approval a Permit2 buyer sends; it costs ETH, which is all this account has.
        expect(await ensurePermit2Approval(m.network, poor, m.asset, m.amount)).not.toBeNull();
      }
      expect(await tokenBalance(m.network, m.asset, poor.address)).toBe(0n);
      requirements = requirementsFor(m.network, m.asset, payTo, m.amount);
      payment = await signPayment(poor, requirements);
      before = await snapshot(m.network, m.asset, poor.address, payTo);
    });

    it(`/verify answers isValid false, "${SPEC_INSUFFICIENT_FUNDS}", in the spec's §7.1 shape`, async () => {
      const res = await verify(payment, requirements);
      record(`verify insufficient balance: ${m.method}`, res);
      expect(verifyFailureViolations(res.body, { reason: SPEC_INSUFFICIENT_FUNDS, payer: poor.address })).toEqual([]);
      expect(res.body.payer).toBe(poor.address);
      expect(res.status).toBe(400);
    });

    it(`/settle answers success false, "${SPEC_INSUFFICIENT_FUNDS}", in the spec's §7.2 shape; nothing moves`, async () => {
      const res = await settle(payment, requirements);
      record(`settle insufficient balance: ${m.method}`, res);
      expect(
        settleFailureViolations(res.body, {
          reasons: [SPEC_INSUFFICIENT_FUNDS],
          payer: poor.address,
          network: m.network,
          broadcast: false,
        }),
      ).toEqual([]);
      expect(res.body.payer).toBe(poor.address);
      expect(res.status).toBe(400);
      expect(await snapshot(m.network, m.asset, poor.address, payTo)).toEqual(before);
    });
  });
}

/**
 * scheme_exact_evm.md Permit2 Phase 3 step 2: "Return 412 Precondition Failed (Error Code:
 * PERMIT2_ALLOWANCE_REQUIRED)", checked before the balance (step 3). The spec writes the code in capitals;
 * the TS reference SDK and x402-rs both send "permit2_allowance_required", so the comparison ignores case.
 */
describe("Permit2 without an allowance", () => {
  const network = TESTNET;
  const asset = usdcAsset(TESTNET);
  const amount = 1_000n;

  function expectAllowanceRequired(res: HttpResult, payer: string, field: "invalidReason" | "errorReason") {
    expect(res.status).toBe(412);
    expect(String(res.body[field]).toUpperCase()).toBe(SPEC_PERMIT2_ALLOWANCE_REQUIRED);
    expect(res.body.payer).toBe(payer);
  }

  it(`funded but never approved: /verify and /settle answer 412 ${SPEC_PERMIT2_ALLOWANCE_REQUIRED}`, async () => {
    const buyer = freshAccount();
    await fundToken(network, asset, buyer.address, 1_000_000n);
    const payTo = freshAddress();
    const requirements = requirementsFor(network, asset, payTo, amount);
    const payment = await signPayment(buyer, requirements);
    const before = await snapshot(network, asset, buyer.address, payTo);

    const v = await verify(payment, requirements);
    record("verify no allowance, funded", v);
    expect(v.body.isValid).toBe(false);
    expectAllowanceRequired(v, buyer.address, "invalidReason");

    const s = await settle(payment, requirements);
    record("settle no allowance, funded", s);
    expect(s.body).toMatchObject({ success: false, transaction: "", network });
    expectAllowanceRequired(s, buyer.address, "errorReason");
    expect(await snapshot(network, asset, buyer.address, payTo)).toEqual(before);
  });

  it(`neither allowance nor balance: always 412 ${SPEC_PERMIT2_ALLOWANCE_REQUIRED}, the allowance being checked first`, async () => {
    // Stock x402-rs raced the two reads (tokio::try_join!) and answered 400 insufficient_funds or
    // 412 permit2_allowance_required at random for the same payload; patch 0004 fixes the order.
    const buyer = freshAccount();
    const requirements = requirementsFor(network, asset, freshAddress(), amount);
    const payment = await signPayment(buyer, requirements);
    for (let i = 0; i < 5; i++) {
      const res = await verify(payment, requirements);
      record(`verify no allowance, no balance #${i + 1}`, res);
      expect(res.body.isValid).toBe(false);
      expectAllowanceRequired(res, buyer.address, "invalidReason");
    }
  });
});
