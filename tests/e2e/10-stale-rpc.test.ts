/**
 * A fast RPC that lags must not hide a mined payment from an RPC that has its receipt.
 *
 * A read goes to every RPC and the first answer wins, and null from a node that has not seen the block is
 * an answer. Up to hemi.13 a lagging primary hid the receipt: the transfer was mined and payTo paid, but
 * the settle and every retry answered settlement_pending until the primary caught up. A stock seller
 * retries once and then refuses, so the buyer was charged and not served. Patch 0028 asks each RPC on its
 * own, on the first settle and on a retry, so only null from all of them means pending.
 *
 * Each RPC here is a proxy in front of the testnet fork. The fallback answers later than the primary, so
 * the primary wins every read and ranks first. The primary stays stale for the whole of each test.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TESTNET, usdcAsset } from "@hemi-x402/shared";
import { ensurePermit2Approval, publicClient, testClient, tokenBalance } from "../lib/chain";
import { restartFacilitator } from "../lib/compose";
import { BUYER_KEY, FORK_RPC, REPO_ROOT, STATE_DIR } from "../lib/env";
import { record, settle } from "../lib/facilitator";
import { freshAddress, requirementsFor, signPayment } from "../lib/payments";
import { SPEC_INVALID_TRANSACTION_STATE, SPEC_SETTLEMENT_PENDING } from "../lib/spec";

/** Well under the 60 s receipt timeout: the frozen primary used to hold the whole of it. */
const NO_RECEIPT_WAIT_MS = 20_000;
const RECEIPT_TIMEOUT_SECS = 5;
const CONFIG_FILE = join(STATE_DIR, "config.stale-rpc.json");
// docker-compose.yml mounts ./facilitator/${FACILITATOR_CONFIG}; this path leads from there to .scratch.
const CONFIG_FROM_FACILITATOR_DIR = "../.scratch/fork-tests/config.stale-rpc.json";
const buyer = privateKeyToAccount(BUYER_KEY);
const asset = usdcAsset(TESTNET);

async function forward(body: string): Promise<{ status: number; text: string }> {
  const answer = await fetch(FORK_RPC[TESTNET], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: answer.status, text: await answer.text() };
}

async function ask(method: string, params: unknown[]): Promise<unknown> {
  const answer = await forward(JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }));
  return JSON.parse(answer.text).result;
}

class ProxyRpc {
  delayMs = 0;
  sends = 0;
  /** Receipts forwarded to the facilitator. */
  receipts = 0;
  /** Answers null for a receipt or a transaction, as a node that has not seen the block. */
  nullReceipts = false;
  /** Answers for the chain's head from this block, as a node that stopped following the chain. */
  frozen: { number: unknown; block: unknown } | undefined;
  private readonly server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    const call = JSON.parse(body) as { id: number; method: string; params?: unknown[] };
    const answerWith = (result: unknown) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: call.id, result }));
    };
    const isReceipt = call.method === "eth_getTransactionReceipt";
    if (call.method === "eth_sendRawTransaction") this.sends++;
    if (this.nullReceipts && (isReceipt || call.method === "eth_getTransactionByHash")) return answerWith(null);
    if (this.frozen && call.method === "eth_blockNumber") return answerWith(this.frozen.number);
    if (this.frozen && call.method === "eth_getBlockByNumber") {
      const tag = call.params?.[0] as string;
      if (tag === "latest") return answerWith(this.frozen.block);
      if (tag.startsWith("0x") && BigInt(tag) > BigInt(this.frozen.number as string)) return answerWith(null);
    }
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    const answer = await forward(body);
    if (isReceipt && JSON.parse(answer.text).result) this.receipts++;
    if (response.destroyed) return;
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(answer.text);
  });

  async start(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, "0.0.0.0", resolve));
    return `http://host.docker.internal:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise(resolve => this.server.close(resolve));
  }
}

async function payment() {
  const requirements = requirementsFor(TESTNET, asset, freshAddress(), 1_000n);
  return { requirements, signed: await signPayment(buyer, requirements), payTo: requirements.payTo as `0x${string}` };
}

/** The facilitator's transaction, once it is in the fork's mempool (automine is off). */
async function waitForMempool(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const pool = await testClient(TESTNET).getTxpoolContent();
    if (Object.keys(pool.pending).length > 0) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("no transaction reached the fork's mempool in time");
}

describe("a fast stale RPC", () => {
  const primary = new ProxyRpc();
  const fallback = new ProxyRpc();
  let urls: string[] = [];

  /** A new facilitator has no ranking yet; one settlement makes the primary the first choice. */
  async function startFacilitator(env: Record<string, string> = {}) {
    await restartFacilitator({ HEMI_TESTNET_RPC_PRIMARY: urls[0]!, HEMI_TESTNET_RPC_FALLBACK: urls[1]!, ...env });
    await ensurePermit2Approval(TESTNET, buyer, asset, 100_000n);
    const first = await payment();
    expect((await settle(first.signed, first.requirements)).body.success).toBe(true);
    expect(primary.sends, "the primary must be the first choice for this test to mean anything").toBe(1);
    primary.sends = fallback.sends = primary.receipts = fallback.receipts = 0;
  }

  async function expectPaidOnce(hash: Hash, payTo: `0x${string}`) {
    const receipt = await publicClient(TESTNET).getTransactionReceipt({ hash });
    expect(receipt.status).toBe("success");
    expect(await tokenBalance(TESTNET, asset, payTo)).toBe(1_000n);
    expect(primary.sends + fallback.sends).toBe(1);
    expect(primary.receipts).toBe(0);
    expect(fallback.receipts).toBeGreaterThan(0);
  }

  beforeEach(async () => {
    primary.nullReceipts = false;
    primary.frozen = undefined;
    primary.sends = fallback.sends = primary.receipts = fallback.receipts = 0;
    fallback.delayMs = 150;
    if (urls.length === 0) urls = await Promise.all([primary.start(), fallback.start()]);
  });

  afterEach(async () => {
    await testClient(TESTNET).setAutomine(true);
  });

  afterAll(async () => {
    await restartFacilitator();
    await Promise.all([primary.stop(), fallback.stop()]);
  });

  it("answering null for a receipt: the first settle succeeds from the other RPC", async () => {
    await startFacilitator();
    primary.nullReceipts = true;
    const { requirements, signed, payTo } = await payment();

    const res = await settle(signed, requirements);
    record("settle with a primary that has no receipt", res);
    expect(res.body.success).toBe(true);
    await expectPaidOnce(res.body.transaction as Hash, payTo);
  });

  it("frozen at an old block: the first settle does not wait out the receipt timeout", async () => {
    await startFacilitator();
    primary.frozen = {
      number: await ask("eth_blockNumber", []),
      block: await ask("eth_getBlockByNumber", ["latest", false]),
    };
    primary.nullReceipts = true;
    const { requirements, signed, payTo } = await payment();

    const started = Date.now();
    const res = await settle(signed, requirements);
    record("settle with a frozen primary", res);
    expect(res.body.success).toBe(true);
    expect(Date.now() - started).toBeLessThan(NO_RECEIPT_WAIT_MS);
    await expectPaidOnce(res.body.transaction as Hash, payTo);
  });

  it("a block that arrives during the wait: the settle finds its receipt on the other RPC", async () => {
    await startFacilitator();
    primary.nullReceipts = true;
    const { requirements, signed, payTo } = await payment();

    await testClient(TESTNET).setAutomine(false);
    const settling = settle(signed, requirements);
    await waitForMempool();
    await new Promise(resolve => setTimeout(resolve, 1_000));
    await testClient(TESTNET).mine({ blocks: 1 });

    const res = await settling;
    record("settle with a block during the wait", res);
    expect(res.body.success).toBe(true);
    await expectPaidOnce(res.body.transaction as Hash, payTo);
  });

  it("settlement_pending, then mined: the retry finds the receipt on the other RPC", async () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, "facilitator", "config.json"), "utf8"));
    for (const chain of Object.values(config.chains) as { receipt_timeout_secs?: number }[]) {
      chain.receipt_timeout_secs = RECEIPT_TIMEOUT_SECS;
    }
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    await startFacilitator({ FACILITATOR_CONFIG: CONFIG_FROM_FACILITATOR_DIR });
    primary.nullReceipts = true;
    const { requirements, signed, payTo } = await payment();

    await testClient(TESTNET).setAutomine(false);
    const pending = await settle(signed, requirements);
    record("settle pending with a stale primary", pending);
    expect(pending.body.errorReason).toBe(SPEC_SETTLEMENT_PENDING);
    const hash = pending.body.transaction as Hash;
    await testClient(TESTNET).mine({ blocks: 1 });

    const retry = await settle(signed, requirements);
    record("retry with a stale primary", retry);
    expect(retry.body.success).toBe(true);
    expect(retry.body.transaction).toBe(hash);
    await expectPaidOnce(hash, payTo);

    const replay = await settle(signed, requirements);
    record("replay with a stale primary", replay);
    expect(replay.body.errorReason).toBe(SPEC_INVALID_TRANSACTION_STATE);
    expect(await tokenBalance(TESTNET, asset, payTo)).toBe(1_000n);
  });
});
