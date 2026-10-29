/**
 * DoD: "GET /supported lists eip155:743111 and eip155:43111 with scheme exact".
 * Spec: specs/x402-specification-v2.md §7.3 (kinds[] of {x402Version, scheme, network, extra?},
 * extensions[] required, signers{} required, "Map of CAIP-2 patterns ... to public signer addresses").
 */
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { MAINNET, TESTNET } from "@hemi-x402/shared";
import { FACILITATOR_SIGNER } from "../lib/env";
import { record, supported } from "../lib/facilitator";

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
