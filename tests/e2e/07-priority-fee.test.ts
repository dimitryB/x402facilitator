/**
 * Settlement tips: the facilitator must tip at least the node's suggested priority fee
 * (eth_maxPriorityFeePerGas), even when recent blocks carry no tips.
 *
 * alloy's default EIP-1559 estimate falls back to a 1-wei tip when the last ten blocks have no
 * non-zero tips. Hemi's sequencer does not mine a transaction tipping below 0.001 gwei, so such a
 * settlement stays pending and holds the signer's nonce (D-018). Patch 0019 makes the node's
 * suggestion a floor. Here each fork first mines empty blocks, so the fee history has no tips and
 * the unpatched estimate would be 1 wei, while anvil suggests 1 gwei.
 */
import { describe, expect, it } from "vitest";
import { hexToBigInt, type Hash, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAINNET, TESTNET, usdcAsset } from "@hemi-x402/shared";
import { ensurePermit2Approval, publicClient, testClient } from "../lib/chain";
import { BUYER_KEY, FACILITATOR_SIGNER } from "../lib/env";
import { record, settle } from "../lib/facilitator";
import { freshAddress, requirementsFor, signPayment } from "../lib/payments";

const buyer = privateKeyToAccount(BUYER_KEY);

for (const network of [TESTNET, MAINNET]) {
  const asset = usdcAsset(network);
  it(`${network} fork: after ten tip-less blocks, the settlement tips at least eth_maxPriorityFeePerGas`, async () => {
    const client = publicClient(network);
    if (asset.transferMethod === "permit2") await ensurePermit2Approval(network, buyer, asset, 1_000n);
    await testClient(network).mine({ blocks: 12 });

    // The precondition the bug needs: no tips in the window alloy's estimator reads.
    const history = (await client.request({
      method: "eth_feeHistory",
      params: ["0xa", "latest", [20]],
    })) as { reward: Hex[][] };
    expect(history.reward.map(r => hexToBigInt(r[0]))).toEqual(Array(10).fill(0n));
    const suggested = hexToBigInt((await client.request({ method: "eth_maxPriorityFeePerGas" })) as Hex);
    expect(suggested).toBeGreaterThan(1n);

    const requirements = requirementsFor(network, asset, freshAddress(), 1_000n);
    const res = await settle(await signPayment(buyer, requirements), requirements);
    record(`settle after tip-less blocks: ${network}`, res);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const tx = await client.getTransaction({ hash: res.body.transaction as Hash });
    expect(tx.from.toLowerCase()).toBe(FACILITATOR_SIGNER[network].toLowerCase());
    expect(tx.type).toBe("eip1559");
    expect(tx.maxPriorityFeePerGas).toBeGreaterThanOrEqual(suggested);
    // The max fee keeps room for the base fee above the tip.
    expect(tx.maxFeePerGas! - tx.maxPriorityFeePerGas!).toBeGreaterThan(0n);
  });
}
