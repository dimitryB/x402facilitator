/**
 * DoD: "GET /supported lists eip155:743111 and eip155:43111 with scheme exact".
 * Spec: specs/x402-specification-v2.md §7.3 (kinds[] of {x402Version, scheme, network, extra?},
 * extensions[] required, signers{} required, "Map of CAIP-2 patterns ... to public signer addresses").
 */
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAINNET, TESTNET, usdcAsset } from "@hemi-x402/shared";
import { BUYER_KEY, FACILITATOR_SIGNER } from "../lib/env";
import { record, settle, supported, verify } from "../lib/facilitator";
import { freshAddress, requirementsFor, signPayment } from "../lib/payments";
import { SPEC_INVALID_NETWORK, STATUS_VERDICT, settleFailureViolations, verifyFailureViolations } from "../lib/spec";

describe("GET /supported", () => {
  it("lists exact/x402Version 2 on both Hemi networks, with a signer per network", async () => {
    const res = await supported();
    record("supported", res);
    expect(res.status).toBe(200);

    for (const network of [MAINNET, TESTNET]) {
      const kinds = res.body.kinds.filter(k => k.network === network);
      expect(kinds, `kinds for ${network}`).toEqual([
        expect.objectContaining({ x402Version: 2, scheme: "exact", network }),
      ]);
      const signers = res.body.signers[network];
      expect(signers, `signers for ${network}`).toHaveLength(1);
      expect(getAddress(signers![0]!)).toBe(FACILITATOR_SIGNER[network]);
    }
    // §7.3.1: extensions is required. EIP-2612 gas sponsoring is off (DECISIONS.md D-013).
    expect(res.body.extensions).toEqual([]);
    // Nothing but the two Hemi chains is configured.
    expect(new Set(res.body.kinds.map(k => k.network))).toEqual(new Set([MAINNET, TESTNET]));
  });
});

/**
 * §9 `invalid_network`: "Specified blockchain network is not supported" (facilitator/x402-rs/patches 0007;
 * stock x402-rs answered `unsupported_scheme`). The payer is unknowable here, since no handler reads the
 * payload, and §5.4.2/§5.3.2 let the facilitator omit it.
 */
describe("a network the facilitator does not support", () => {
  it(`/verify and /settle answer "${SPEC_INVALID_NETWORK}" for eip155:1`, async () => {
    const requirements = { ...requirementsFor(MAINNET, usdcAsset(MAINNET), freshAddress(), 1_000n), network: "eip155:1" as const };
    const payment = await signPayment(privateKeyToAccount(BUYER_KEY), requirements);
    expect(payment.accepted.network).toBe("eip155:1");

    const v = await verify(payment, requirements);
    record("verify unsupported network", v);
    expect(verifyFailureViolations(v.body, { reason: SPEC_INVALID_NETWORK })).toEqual([]);
    expect(v.status).toBe(STATUS_VERDICT);

    const s = await settle(payment, requirements);
    record("settle unsupported network", s);
    expect(
      settleFailureViolations(s.body, { reasons: [SPEC_INVALID_NETWORK], network: "eip155:1", broadcast: false }),
    ).toEqual([]);
    expect(s.status).toBe(STATUS_VERDICT);
  });
});
