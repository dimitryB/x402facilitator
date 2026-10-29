/**
 * A settlement whose receipt does not arrive in time (facilitator/x402-rs/patches 0006).
 *
 * Spec: specs/x402-specification-v2.md §5.3.2 `transaction` is "" only "if no transaction was broadcast";
 * §9 `settlement_pending`: "The settlement transaction was broadcast but its confirmation could not be
 * established ... MUST carry a non-empty transaction (the broadcast hash) and network".
 *
 * Stock x402-rs answered HTTP 500 `unexpected_error` with "transaction": "" while the transaction sat in
 * the mempool and paid out a block later; it also reset the signer's nonce, which could let the next
 * settlement reuse it. A retry of the same request (the TS SDK's resource server retries a
 * settlement_pending once, immediately) was settled again from scratch; patch 0011 answers it from the
 * first transaction instead.
 *
 * Setup: the facilitator is recreated with a copy of facilitator/config.json whose receipt_timeout_secs is
 * RECEIPT_TIMEOUT_SECS (written to .scratch, not committed), and the mainnet fork stops mining on its own
 * (evm_setAutomine false). Both are restored afterwards. This file runs last, after the checks in
 * 05-rpc-failover.test.ts that the container was never restarted.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAINNET, usdcAsset } from "@hemi-x402/shared";
import { nonceOf, publicClient, testClient, tokenBalance } from "../lib/chain";
import { composeOutput, restartFacilitator } from "../lib/compose";
import { BUYER_KEY, FACILITATOR_SIGNER, REPO_ROOT, STATE_DIR } from "../lib/env";
import { record, settle } from "../lib/facilitator";
import { freshAddress, requirementsFor, signPayment } from "../lib/payments";
import { SPEC_SETTLEMENT_PENDING, settleFailureViolations } from "../lib/spec";

const RECEIPT_TIMEOUT_SECS = 5;
const CONFIG_FILE = join(STATE_DIR, "config.settlement-pending.json");
// docker-compose.yml mounts ./facilitator/${FACILITATOR_CONFIG}; this path leads from there to .scratch.
const CONFIG_FROM_FACILITATOR_DIR = "../.scratch/fork-tests/config.settlement-pending.json";

const network = MAINNET;
const asset = usdcAsset(MAINNET); // EIP-3009: no approval step needed
const amount = 1_000n;
const buyer = privateKeyToAccount(BUYER_KEY);

describe("settlement_pending: the transaction is broadcast but its receipt does not arrive in time", () => {
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, "facilitator", "config.json"), "utf8"));
    for (const chain of Object.values(config.chains) as { receipt_timeout_secs?: number }[]) {
      chain.receipt_timeout_secs = RECEIPT_TIMEOUT_SECS;
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    await restartFacilitator({ FACILITATOR_CONFIG: CONFIG_FROM_FACILITATOR_DIR });
  });

  afterAll(async () => {
    await testClient(network).setAutomine(true);
    await restartFacilitator();
  });

  it("the container under test has the short receipt timeout", () => {
    const mounted = JSON.parse(composeOutput(["exec", "-T", "facilitator", "cat", "/app/config.json"]));
    expect(mounted.chains[network].receipt_timeout_secs).toBe(RECEIPT_TIMEOUT_SECS);
  });

  it("answers settlement_pending with the hash; a retry gets the same hash, then success once mined; pays exactly once", async () => {
    const chain = publicClient(network);
    const payTo = [freshAddress(), freshAddress()];
    const payments = await Promise.all(
      payTo.map(async to => {
        const requirements = requirementsFor(network, asset, to, amount);
        return { requirements, payment: await signPayment(buyer, requirements) };
      }),
    );
    const buyerBefore = await tokenBalance(network, asset, buyer.address);
    const signerNonceBefore = await nonceOf(network, FACILITATOR_SIGNER[network]);

    await testClient(network).setAutomine(false);

    // Two settlements while nothing is mined: each times out waiting for its receipt.
    const hashes: Hash[] = [];
    for (const [i, { payment, requirements }] of payments.entries()) {
      const started = Date.now();
      const res = await settle(payment, requirements);
      record(`settle pending #${i + 1}`, res);
      expect(Date.now() - started).toBeGreaterThanOrEqual(RECEIPT_TIMEOUT_SECS * 1000);
      expect(
        settleFailureViolations(res.body, {
          reasons: [SPEC_SETTLEMENT_PENDING],
          payer: buyer.address,
          network,
          broadcast: true,
        }),
      ).toEqual([]);
      expect(res.body.payer).toBe(buyer.address);
      // Not a failed request: answered like an ordinary settle response (see patch 0006).
      expect(res.status).toBe(200);
      hashes.push(res.body.transaction as Hash);
    }

    // Both are in the mempool, unmined, sent by the facilitator with consecutive nonces: the nonce of
    // the first, which may still be mined, was not reused for the second.
    const txs = await Promise.all(hashes.map(hash => chain.getTransaction({ hash })));
    for (const tx of txs) {
      expect(tx.blockNumber).toBeNull();
      expect(getAddress(tx.from)).toBe(FACILITATOR_SIGNER[network]);
    }
    expect(txs.map(tx => tx.nonce)).toEqual([signerNonceBefore, signerNonceBefore + 1]);
    for (const to of payTo) expect(await tokenBalance(network, asset, to)).toBe(0n);

    // The client retries the first payment while it is pending (the TS SDK's resource server does this
    // once, immediately): the same hash comes back at once and nothing new is sent (patch 0011).
    const retryStarted = Date.now();
    const retry = await settle(payments[0]!.payment, payments[0]!.requirements);
    record("settle pending, retried while pending", retry);
    expect(Date.now() - retryStarted).toBeLessThan(RECEIPT_TIMEOUT_SECS * 1000);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ success: false, errorReason: SPEC_SETTLEMENT_PENDING, transaction: hashes[0] });
    expect(await chain.getTransactionCount({ address: FACILITATOR_SIGNER[network], blockTag: "pending" })).toBe(
      signerNonceBefore + 2,
    );

    // One block later both have paid out, once each.
    await testClient(network).mine({ blocks: 1 });
    for (const hash of hashes) {
      expect((await chain.getTransactionReceipt({ hash })).status).toBe("success");
    }
    for (const to of payTo) expect(await tokenBalance(network, asset, to)).toBe(amount);
    expect(await tokenBalance(network, asset, buyer.address)).toBe(buyerBefore - 2n * amount);

    // Retried once mined, each payment is answered with its success and the same transaction; nothing
    // is sent again and nobody is paid twice.
    await testClient(network).setAutomine(true);
    for (const [i, { payment, requirements }] of payments.entries()) {
      const again = await settle(payment, requirements);
      record(`settle pending #${i + 1}, retried after mining`, again);
      expect(again.status).toBe(200);
      expect(again.body).toEqual({ success: true, payer: buyer.address, transaction: hashes[i], network });
    }
    for (const to of payTo) expect(await tokenBalance(network, asset, to)).toBe(amount);
    expect(await nonceOf(network, FACILITATOR_SIGNER[network])).toBe(signerNonceBefore + 2);
  });
});
