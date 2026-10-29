/**
 * A settlement whose receipt does not arrive in time (facilitator/x402-rs/patches 0006 and 0011).
 *
 * Spec: specs/x402-specification-v2.md §5.3.2 `transaction` is "" only "if no transaction was broadcast";
 * §9 `settlement_pending`: "The settlement transaction was broadcast but its confirmation could not be
 * established ... MUST carry a non-empty transaction (the broadcast hash) and network".
 *
 * Required behaviour (patch 0011), for one payment authorization:
 * - settle → settlement_pending with hash H (HTTP 200);
 * - while H is unmined: /verify of the payment → invalid_transaction_state (it must not pay for another
 *   request); a retry of the settle → settlement_pending with the same H, and nothing new is sent;
 * - once H is mined: the FIRST retry → success with H (what lets the SDK's automatic retry complete the
 *   original request), and the facilitator forgets the record in the same step, atomically;
 * - any later settle → invalid_transaction_state (a replay); payTo is paid exactly once.
 *
 * Stock x402-rs answered 500 with "transaction": "" and reset the signer's nonce. hemi.3 kept answering
 * success to every repeat of the payload for 15 minutes and let /verify accept it while H was unmined,
 * so one payment could buy several resources.
 *
 * The same holds when the client hangs up after the broadcast (patch 0015): the settlement runs to its
 * end without it, and the facilitator logs every broadcast hash. Up to hemi.5 the settlement was dropped
 * with the request, and its record with it: /verify called the payment valid again while H was unmined,
 * and H was nowhere to be found.
 *
 * Setup: the facilitator is recreated with a copy of facilitator/config.json whose receipt_timeout_secs is
 * RECEIPT_TIMEOUT_SECS (written to .scratch, not committed), and the mainnet fork stops mining on its own
 * (evm_setAutomine false). Both are restored afterwards. This file runs last, after the checks in
 * 05-rpc-failover.test.ts that the container was never restarted.
 */
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { getAddress, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { MAINNET, usdcAsset } from "@hemi-x402/shared";
import { nonceOf, publicClient, testClient, tokenBalance } from "../lib/chain";
import { composeOutput, restartFacilitator } from "../lib/compose";
import { BUYER_KEY, FACILITATOR_SIGNER, FACILITATOR_URL, OBSERVED_FILE, REPO_ROOT, STATE_DIR } from "../lib/env";
import { record, settle, verify } from "../lib/facilitator";
import { freshAddress, requirementsFor, signPayment } from "../lib/payments";
import {
  SPEC_INVALID_TRANSACTION_STATE,
  SPEC_SETTLEMENT_PENDING,
  STATUS_VERDICT,
  settleFailureViolations,
  verifyFailureViolations,
} from "../lib/spec";

const RECEIPT_TIMEOUT_SECS = 5;
const CONFIG_FILE = join(STATE_DIR, "config.settlement-pending.json");
// docker-compose.yml mounts ./facilitator/${FACILITATOR_CONFIG}; this path leads from there to .scratch.
const CONFIG_FROM_FACILITATOR_DIR = "../.scratch/fork-tests/config.settlement-pending.json";

const network = MAINNET;
const asset = usdcAsset(MAINNET); // EIP-3009: no approval step needed
const amount = 1_000n;
const buyer = privateKeyToAccount(BUYER_KEY);
const chain = () => publicClient(network);

interface Payment {
  payTo: `0x${string}`;
  requirements: PaymentRequirements;
  payment: PaymentPayload;
}

async function newPayment(): Promise<Payment> {
  const payTo = freshAddress();
  const requirements = requirementsFor(network, asset, payTo, amount);
  return { payTo, requirements, payment: await signPayment(buyer, requirements) };
}

/** Settle and expect settlement_pending after the receipt timeout; returns the broadcast hash. */
async function settlePending(p: Payment, label: string): Promise<Hash> {
  const started = Date.now();
  const res = await settle(p.payment, p.requirements);
  record(label, res);
  expect(Date.now() - started).toBeGreaterThanOrEqual(RECEIPT_TIMEOUT_SECS * 1000);
  expect(
    settleFailureViolations(res.body, { reasons: [SPEC_SETTLEMENT_PENDING], payer: buyer.address, network, broadcast: true }),
  ).toEqual([]);
  // Not a failed request: answered like an ordinary settle response (patch 0006).
  expect(res.status).toBe(200);
  return res.body.transaction as Hash;
}

/** The facilitator's transaction with `nonce`, once it is in the fork's mempool (automine is off). */
async function waitForBroadcast(signer: Address, nonce: number, deadline: number): Promise<Hash> {
  while (Date.now() < deadline) {
    const pool = await testClient(network).getTxpoolContent();
    for (const [from, txs] of Object.entries(pool.pending)) {
      if (getAddress(from) !== signer) continue;
      const tx = Object.values(txs).find(tx => Number(tx.nonce) === nonce);
      if (tx) return tx.hash;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`no transaction from ${signer} with nonce ${nonce} reached the mempool in time`);
}

async function expectReplay(p: Payment, label: string) {
  const res = await settle(p.payment, p.requirements);
  record(label, res);
  expect(
    settleFailureViolations(res.body, {
      reasons: [SPEC_INVALID_TRANSACTION_STATE],
      payer: buyer.address,
      network,
      broadcast: false,
    }),
  ).toEqual([]);
  expect(res.status).toBe(STATUS_VERDICT);
}

describe("settlement_pending: the transaction is broadcast but its receipt does not arrive in time", () => {
  beforeAll(async () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, "facilitator", "config.json"), "utf8"));
    for (const chain of Object.values(config.chains) as { receipt_timeout_secs?: number }[]) {
      chain.receipt_timeout_secs = RECEIPT_TIMEOUT_SECS;
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    await restartFacilitator({ FACILITATOR_CONFIG: CONFIG_FROM_FACILITATOR_DIR });
  });

  afterEach(async () => {
    await testClient(network).setAutomine(true);
  });

  afterAll(async () => {
    await testClient(network).setAutomine(true);
    await restartFacilitator();
  });

  it("the container under test has the short receipt timeout", () => {
    const mounted = JSON.parse(composeOutput(["exec", "-T", "facilitator", "cat", "/app/config.json"]));
    expect(mounted.chains[network].receipt_timeout_secs).toBe(RECEIPT_TIMEOUT_SECS);
  });

  it("pending, verify refused, retry pending with the same hash, first retry after mining succeeds, then replays fail", async () => {
    const [a, b] = [await newPayment(), await newPayment()];
    expect((await verify(a.payment, a.requirements)).body).toEqual({ isValid: true, payer: buyer.address });
    const buyerBefore = await tokenBalance(network, asset, buyer.address);
    const signerNonceBefore = await nonceOf(network, FACILITATOR_SIGNER[network]);

    await testClient(network).setAutomine(false);
    const hashA = await settlePending(a, "settle pending A");
    const hashB = await settlePending(b, "settle pending B");

    // Both are in the mempool, sent by the facilitator with consecutive nonces: the nonce of the
    // first, which may still be mined, was not reused for the second (patch 0006).
    const txs = await Promise.all([hashA, hashB].map(hash => chain().getTransaction({ hash })));
    for (const tx of txs) {
      expect(tx.blockNumber).toBeNull();
      expect(getAddress(tx.from)).toBe(FACILITATOR_SIGNER[network]);
    }
    expect(txs.map(tx => tx.nonce)).toEqual([signerNonceBefore, signerNonceBefore + 1]);

    // While A is pending, /verify must not call the payment valid: it is committed to H.
    const verifyPending = await verify(a.payment, a.requirements);
    record("verify while settlement pending", verifyPending);
    expect(verifyFailureViolations(verifyPending.body, { reason: SPEC_INVALID_TRANSACTION_STATE, payer: buyer.address })).toEqual([]);
    expect(String(verifyPending.body.invalidMessage)).toContain(hashA);
    expect(verifyPending.status).toBe(STATUS_VERDICT);

    // A retry while pending: the same hash at once, nothing new sent.
    const retryStarted = Date.now();
    const retry = await settle(a.payment, a.requirements);
    record("settle retried while pending", retry);
    expect(Date.now() - retryStarted).toBeLessThan(RECEIPT_TIMEOUT_SECS * 1000);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ success: false, errorReason: SPEC_SETTLEMENT_PENDING, transaction: hashA });
    expect(await chain().getTransactionCount({ address: FACILITATOR_SIGNER[network], blockTag: "pending" })).toBe(
      signerNonceBefore + 2,
    );
    for (const p of [a, b]) expect(await tokenBalance(network, asset, p.payTo)).toBe(0n);

    await testClient(network).mine({ blocks: 1 });
    await testClient(network).setAutomine(true);

    // The first retry that sees the mined receipt gets the success, with the same hash...
    for (const [p, hash, label] of [[a, hashA, "A"], [b, hashB, "B"]] as const) {
      const first = await settle(p.payment, p.requirements);
      record(`settle ${label} retried after mining`, first);
      expect(first.status).toBe(200);
      expect(first.body).toEqual({ success: true, payer: buyer.address, transaction: hash, network });
      // ...and every later settle of the payment is a replay.
      await expectReplay(p, `settle ${label} again after the successful retry`);
    }
    const verifyAfter = await verify(a.payment, a.requirements);
    record("verify after the settlement", verifyAfter);
    expect(verifyAfter.body).toMatchObject({ isValid: false, invalidReason: SPEC_INVALID_TRANSACTION_STATE });

    for (const p of [a, b]) expect(await tokenBalance(network, asset, p.payTo)).toBe(amount);
    expect(await tokenBalance(network, asset, buyer.address)).toBe(buyerBefore - 2n * amount);
    expect(await nonceOf(network, FACILITATOR_SIGNER[network])).toBe(signerNonceBefore + 2);
  });

  it("two concurrent retries after mining: exactly one success, the other a replay", async () => {
    const p = await newPayment();
    await testClient(network).setAutomine(false);
    const hash = await settlePending(p, "settle pending (concurrent retries)");
    await testClient(network).mine({ blocks: 1 });
    await testClient(network).setAutomine(true);

    const answers = await Promise.all([settle(p.payment, p.requirements), settle(p.payment, p.requirements)]);
    answers.forEach((res, i) => record(`concurrent retry #${i + 1}`, res));
    const successes = answers.filter(res => res.body.success === true);
    expect(successes).toHaveLength(1);
    expect(successes[0]!.body.transaction).toBe(hash);
    const other = answers.find(res => res.body.success !== true)!;
    expect(other.body).toMatchObject({ success: false, errorReason: SPEC_INVALID_TRANSACTION_STATE });
    expect(await tokenBalance(network, asset, p.payTo)).toBe(amount);
  });

  /**
   * The client hangs up after the transaction is broadcast and before the receipt timeout: a dropped
   * connection, or a proxy or client timeout shorter than receipt_timeout_secs. The settlement must still
   * end as it would have with the client there: the authorization stays committed to H, a retry is
   * answered from H, and the first retry after mining gets the success (patch 0015).
   */
  it("client disconnects after the broadcast: the settlement completes without it, and the hash is logged", async () => {
    const p = await newPayment();
    const signer = FACILITATOR_SIGNER[network];
    const signerNonceBefore = await nonceOf(network, signer);
    await testClient(network).setAutomine(false);

    const hangUp = new AbortController();
    const started = Date.now();
    const answer = settle(p.payment, p.requirements, { signal: hangUp.signal }).then(
      res => ({ answered: res }),
      (error: Error) => ({ error }),
    );
    const hash = await waitForBroadcast(signer, signerNonceBefore, started + (RECEIPT_TIMEOUT_SECS * 1000) / 2);
    hangUp.abort();
    const outcome = await answer;
    expect("error" in outcome && outcome.error.name).toBe("AbortError");
    expect(Date.now() - started).toBeLessThan(RECEIPT_TIMEOUT_SECS * 1000);

    // The authorization stays committed: /verify refuses it while the settlement waits for the receipt,
    // and names H once the wait ends in settlement_pending.
    const deadline = started + (RECEIPT_TIMEOUT_SECS + 10) * 1000;
    let verifyRes = await verify(p.payment, p.requirements);
    for (;;) {
      expect(verifyFailureViolations(verifyRes.body, { reason: SPEC_INVALID_TRANSACTION_STATE, payer: buyer.address })).toEqual([]);
      expect(verifyRes.status).toBe(STATUS_VERDICT);
      if (String(verifyRes.body.invalidMessage).includes(hash) || Date.now() > deadline) break;
      await new Promise(r => setTimeout(r, 250));
      verifyRes = await verify(p.payment, p.requirements);
    }
    record("verify after the client disconnected", verifyRes);
    expect(String(verifyRes.body.invalidMessage)).toContain(hash);
    expect(Date.now() - started).toBeGreaterThanOrEqual(RECEIPT_TIMEOUT_SECS * 1000);

    // An identical settle is answered from H at once, and nothing new is sent.
    const retryStarted = Date.now();
    const retry = await settle(p.payment, p.requirements);
    record("settle retried after the client disconnected", retry);
    expect(Date.now() - retryStarted).toBeLessThan(RECEIPT_TIMEOUT_SECS * 1000);
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ success: false, errorReason: SPEC_SETTLEMENT_PENDING, transaction: hash });
    expect(await chain().getTransactionCount({ address: signer, blockTag: "pending" })).toBe(signerNonceBefore + 1);
    expect(await tokenBalance(network, asset, p.payTo)).toBe(0n);

    await testClient(network).mine({ blocks: 1 });
    await testClient(network).setAutomine(true);

    const done = await settle(p.payment, p.requirements);
    record("settle retried after mining (client had disconnected)", done);
    expect(done.status).toBe(200);
    expect(done.body).toEqual({ success: true, payer: buyer.address, transaction: hash, network });
    await expectReplay(p, "settle again after the success (client had disconnected)");

    expect((await chain().getTransactionReceipt({ hash })).status).toBe("success");
    expect(await tokenBalance(network, asset, p.payTo)).toBe(amount);
    expect(await nonceOf(network, signer)).toBe(signerNonceBefore + 1);

    // Nobody received an answer with H, but the facilitator's log has it.
    const lines = composeOutput(["logs", "--no-color", "facilitator"])
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      .filter(line => line.includes(hash));
    appendFileSync(OBSERVED_FILE, JSON.stringify({ label: "facilitator log lines naming the hash", lines }) + "\n");
    expect(lines.some(line => line.includes("Transaction broadcast"))).toBe(true);
    expect(lines.some(line => line.includes("settlement pending"))).toBe(true);
  });

  /**
   * The same thing from a seller's side, with the SDK code a stock seller runs: x402ResourceServer (what
   * @x402/express wraps) with HTTPFacilitatorClient, doing verify → handler → settle per request, the
   * settle including the SDK's automatic retry of settlement_pending. seller/server.ts itself cannot run
   * here: it listens on its own TCP port, and this suite may only use 38080, 38545 and 38546.
   */
  it("seller: three requests with the same payment header run the paid handler once; payTo is paid once", async () => {
    const server = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL })).register(
      network,
      new ExactEvmScheme(),
    );
    await server.initialize();
    let handlerRuns = 0;
    const request = async (p: Payment): Promise<"served" | "verify refused" | "settle failed"> => {
      const verified = await server.verifyPayment(p.payment, p.requirements).catch(() => ({ isValid: false }));
      if (!verified.isValid) return "verify refused";
      handlerRuns++;
      const settled = await server.settlePayment(p.payment, p.requirements).catch(() => ({ success: false }));
      return settled.success ? "served" : "settle failed";
    };

    const p = await newPayment();
    await testClient(network).setAutomine(false);
    // Request 1: verified, the handler runs, settle (and the SDK's retry) stay pending.
    expect(await request(p)).toBe("settle failed");
    // Request 2, same payment header, while the transaction is unmined: refused at verify.
    expect(await request(p)).toBe("verify refused");
    await testClient(network).mine({ blocks: 1 });
    await testClient(network).setAutomine(true);
    // Request 3, after it is mined: refused at verify too (the authorization is spent).
    expect(await request(p)).toBe("verify refused");

    expect(handlerRuns).toBe(1);
    expect(await tokenBalance(network, asset, p.payTo)).toBe(amount);
  });
});

/**
 * The client hangs up after the broadcast, and the transaction is mined within the receipt wait, so the
 * settlement ends in success with nobody to receive it (facilitator/x402-rs/patches 0016). The facilitator
 * must keep that success for the client's retry: the first identical retry gets it, with the hash, and
 * every later settle is a replay. In hemi.6 the success was discarded: the retry and /verify got
 * invalid_transaction_state ("already used on chain") with "transaction": "", so the buyer was charged
 * and not served, and the hash was only in the log.
 *
 * This runs against the container as configured in facilitator/config.json, whose receipt timeout must
 * leave the settlement time to see the block before the wait ends (the test requires at least 20 s).
 */
describe("success after the client left: kept for the client's retry", () => {
  afterEach(async () => {
    await testClient(network).setAutomine(true);
  });

  it("hang up, mine within the receipt wait: the first identical retry gets the success, the next is a replay", async () => {
    const mounted = JSON.parse(composeOutput(["exec", "-T", "facilitator", "cat", "/app/config.json"]));
    const receiptTimeoutSecs: number = mounted.chains[network].receipt_timeout_secs;
    expect(receiptTimeoutSecs).toBeGreaterThanOrEqual(20);

    const p = await newPayment();
    const signer = FACILITATOR_SIGNER[network];
    const signerNonceBefore = await nonceOf(network, signer);
    await testClient(network).setAutomine(false);

    const hangUp = new AbortController();
    const started = Date.now();
    const answer = settle(p.payment, p.requirements, { signal: hangUp.signal }).then(
      res => ({ answered: res }),
      (error: Error) => ({ error }),
    );
    const hash = await waitForBroadcast(signer, signerNonceBefore, started + 10_000);
    hangUp.abort();
    const outcome = await answer;
    expect("error" in outcome && outcome.error.name).toBe("AbortError");

    // While the settlement waits for its receipt, the authorization is in progress: refused, nothing sent.
    const inProgress = await settle(p.payment, p.requirements);
    record("identical settle while the settlement still waits (client gone)", inProgress);
    expect(inProgress.body).toMatchObject({ success: false, errorReason: SPEC_INVALID_TRANSACTION_STATE, transaction: "" });

    await testClient(network).mine({ blocks: 1 });
    await testClient(network).setAutomine(true);
    expect((await chain().getTransactionReceipt({ hash })).status).toBe("success");
    expect(await tokenBalance(network, asset, p.payTo)).toBe(amount);

    // Once the settlement has seen the receipt, the authorization is committed to H: /verify says so, and
    // another request carrying the same authorization is refused without taking the success.
    const deadline = Date.now() + (receiptTimeoutSecs + 10) * 1000;
    let verifyRes = await verify(p.payment, p.requirements);
    while (!String(verifyRes.body.invalidMessage).includes(hash) && Date.now() < deadline) {
      expect(verifyFailureViolations(verifyRes.body, { reason: SPEC_INVALID_TRANSACTION_STATE, payer: buyer.address })).toEqual([]);
      await new Promise(r => setTimeout(r, 250));
      verifyRes = await verify(p.payment, p.requirements);
    }
    record("verify after the success nobody received", verifyRes);
    expect(verifyFailureViolations(verifyRes.body, { reason: SPEC_INVALID_TRANSACTION_STATE, payer: buyer.address })).toEqual([]);
    expect(String(verifyRes.body.invalidMessage)).toContain(hash);
    // It ended in success within the wait, not in settlement_pending.
    expect(Date.now() - started).toBeLessThan(receiptTimeoutSecs * 1000);

    const other = await settle(p.payment, { ...p.requirements, maxTimeoutSeconds: p.requirements.maxTimeoutSeconds + 1 });
    record("another request with the same authorization", other);
    expect(other.body).toMatchObject({ success: false, errorReason: SPEC_INVALID_TRANSACTION_STATE });
    expect(String(other.body.errorMessage)).toContain(hash);

    const retry = await settle(p.payment, p.requirements);
    record("identical retry after the success nobody received", retry);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual({ success: true, payer: buyer.address, transaction: hash, network });
    await expectReplay(p, "settle again after the kept success was claimed");
    const verifyAfter = await verify(p.payment, p.requirements);
    expect(verifyAfter.body).toMatchObject({ isValid: false, invalidReason: SPEC_INVALID_TRANSACTION_STATE });

    expect(await tokenBalance(network, asset, p.payTo)).toBe(amount);
    expect(await nonceOf(network, signer)).toBe(signerNonceBefore + 1);

    const lines = composeOutput(["logs", "--no-color", "facilitator"])
      .replace(/\x1b\[[0-9;]*m/g, "")
      .split("\n")
      .filter(line => line.includes(hash));
    appendFileSync(OBSERVED_FILE, JSON.stringify({ label: "facilitator log lines naming the kept success", lines }) + "\n");
    expect(lines.some(line => line.includes("Transaction broadcast"))).toBe(true);
    expect(lines.some(line => line.includes("Settlement succeeded after its caller left"))).toBe(true);
    expect(lines.some(line => line.includes("settlement pending"))).toBe(false);
  });
});
