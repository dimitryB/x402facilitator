/**
 * DoD: "A failed-signature ... case ... return[s] the spec's error shapes".
 *
 * Two kinds of bad signature per transfer method:
 *   - tampered: a valid stock-client payload with one bit of `r` flipped;
 *   - wrong key: a stock-client payload signed by another key, with `from` rewritten to the victim.
 * The victim (`from`) holds tokens and, for Permit2, has approved Permit2, so the signature is the
 * only thing wrong.
 *
 * Spec: specs/schemes/exact/scheme_exact_evm.md, EIP-3009 Phase 2 step 1 and Permit2 Phase 3 step 1
 * ("Verify ... signature is valid and recovers to ... from"); specs/x402-specification-v2.md §9
 * `invalid_exact_evm_payload_signature`: "Payment authorization signature is invalid or improperly signed";
 * shapes per §5.4.2/§7.1 (verify) and §5.3.2/§7.2 (settle). See tests/lib/spec.ts.
 *
 * Stock x402-rs answered all of these with HTTP 500 "unexpected_error" and "payer": "" (and "network": ""
 * on settle); facilitator/x402-rs/patches 0002 and 0003 fix that.
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Hex, LocalAccount } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { btcAsset, MAINNET, usdcAsset, type HemiAsset, type HemiNetwork } from "@hemi-x402/shared";
import { ensurePermit2Approval, fundEth, fundToken } from "../lib/chain";
import { record, settle, verify } from "../lib/facilitator";
import { freshAccount, freshAddress, requirementsFor, signPayment, tamperSignature, withFrom, withSignature } from "../lib/payments";
import { snapshot, type Snapshot } from "../lib/snapshot";
import { SPEC_INVALID_SIGNATURE, settleFailureViolations, verifyFailureViolations } from "../lib/spec";

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

for (const m of METHODS) {
  describe(`bad signature, ${m.method} (${m.asset.symbol} on ${m.network})`, () => {
    let victim: LocalAccount;
    let attacker: LocalAccount;
    const payTo = freshAddress();
    let requirements: PaymentRequirements;
    let genuine: PaymentPayload;

    beforeAll(async () => {
      victim = freshAccount();
      attacker = freshAccount();
      await fundEth(m.network, victim.address);
      await fundToken(m.network, m.asset, victim.address, 1_000_000n);
      if (m.asset.transferMethod === "permit2") await ensurePermit2Approval(m.network, victim, m.asset, m.amount);
      requirements = requirementsFor(m.network, m.asset, payTo, m.amount);
      genuine = await signPayment(victim, requirements);
    });

    it("control: the untampered payload verifies", async () => {
      const res = await verify(genuine, requirements);
      expect(res.body).toEqual({ isValid: true, payer: victim.address });
    });

    const variants: [string, () => Promise<PaymentPayload>][] = [
      ["tampered signature", async () => withSignature(genuine, tamperSignature((genuine.payload as { signature: Hex }).signature))],
      ["signed by a different key than `from`", async () => withFrom(await signPayment(attacker, requirements), victim.address)],
    ];

    for (const [variant, build] of variants) {
      describe(variant, () => {
        let bad: PaymentPayload;
        let before: Snapshot;

        beforeAll(async () => {
          bad = await build();
          before = await snapshot(m.network, m.asset, victim.address, payTo);
        });

        it(`/verify answers isValid false, "${SPEC_INVALID_SIGNATURE}", in the spec's §7.1 shape`, async () => {
          const res = await verify(bad, requirements);
          record(`verify bad signature: ${m.method}, ${variant}`, res);
          expect(verifyFailureViolations(res.body, { reason: SPEC_INVALID_SIGNATURE, payer: victim.address })).toEqual([]);
          expect(res.body.payer).toBe(victim.address);
          expect(res.body.invalidMessage).toEqual(expect.any(String));
          // A rejected payload is a client error, not a facilitator failure.
          expect(res.status).toBe(400);
        });

        it(`/settle answers success false, "${SPEC_INVALID_SIGNATURE}", in the spec's §7.2 shape; nothing moves`, async () => {
          const res = await settle(bad, requirements);
          record(`settle bad signature: ${m.method}, ${variant}`, res);
          expect(
            settleFailureViolations(res.body, {
              reasons: [SPEC_INVALID_SIGNATURE],
              payer: victim.address,
              network: m.network,
              broadcast: false,
            }),
          ).toEqual([]);
          expect(res.body.payer).toBe(victim.address);
          expect(res.status).toBe(400);
          // Rejected before any transaction: no tokens moved and the facilitator's nonce is unchanged.
          expect(await snapshot(m.network, m.asset, victim.address, payTo)).toEqual(before);
        });
      });
    }
  });
}
