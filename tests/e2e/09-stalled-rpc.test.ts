/**
 * A stalled RPC must not hold a settlement, or lose one.
 *
 * Since patch 0021 a transaction goes to one RPC at a time, so a node that accepts the connection and
 * never answers would hold a settlement with no limit. Reads race, and a stalled RPC loses them without
 * losing rank, so it is still the first choice for the send. Patch 0022 bounds every request. The second
 * case is the reason a timeout alone is not enough: an RPC can forward the transaction and only then
 * stall. The next RPC then rejects the copy, and the settlement must still be reported from its hash.
 *
 * Each RPC here is a proxy in front of the testnet fork. The fallback answers later than the primary, so
 * the primary wins every read and ranks first.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { TESTNET, usdcAsset } from "@hemi-x402/shared";
import { ensurePermit2Approval, nonceOf, publicClient, tokenBalance } from "../lib/chain";
import { restartFacilitator } from "../lib/compose";
import { BUYER_KEY, FACILITATOR_SIGNER, FORK_RPC } from "../lib/env";
import { record, settle, verify } from "../lib/facilitator";
import { freshAddress, requirementsFor, signPayment } from "../lib/payments";

/** RPC_REQUEST_TIMEOUT in patch 0022, plus room for the fallback and a block. */
const SEND_BOUND_MS = 20_000;
const buyer = privateKeyToAccount(BUYER_KEY);
const asset = usdcAsset(TESTNET);

type Mode = "answer" | "stall" | "forward-then-stall";

class ProxyRpc {
  mode: Mode = "answer";
  delayMs = 0;
  sends = 0;
  heldSends = 0;
  private readonly server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    const calls = [JSON.parse(body)].flat() as { method: string }[];
    const isSend = calls.some(call => call.method === "eth_sendRawTransaction");
    if (isSend) this.sends++;
    if (this.mode === "stall" || (this.mode === "forward-then-stall" && isSend)) {
      if (isSend) this.heldSends++;
      if (this.mode === "forward-then-stall") await forward(body);
      return; // Never answers.
    }
    if (this.delayMs > 0) await new Promise(resolve => setTimeout(resolve, this.delayMs));
    const answer = await forward(body);
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

async function forward(body: string): Promise<{ status: number; text: string }> {
  const answer = await fetch(FORK_RPC[TESTNET], {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
  });
  return { status: answer.status, text: await answer.text() };
}

async function payment() {
  const requirements = requirementsFor(TESTNET, asset, freshAddress(), 1_000n);
  return { requirements, signed: await signPayment(buyer, requirements), payTo: requirements.payTo as `0x${string}` };
}

describe("a stalled RPC", () => {
  const primary = new ProxyRpc();
  const fallback = new ProxyRpc();
  let urls: string[] = [];

  beforeEach(async () => {
    primary.mode = "answer";
    primary.sends = fallback.sends = primary.heldSends = fallback.heldSends = 0;
    fallback.delayMs = 150;
    if (urls.length === 0) urls = await Promise.all([primary.start(), fallback.start()]);
    // A new facilitator has no ranking yet; one settlement makes the primary the first choice.
    await restartFacilitator({ HEMI_TESTNET_RPC_PRIMARY: urls[0]!, HEMI_TESTNET_RPC_FALLBACK: urls[1]! });
    await ensurePermit2Approval(TESTNET, buyer, asset, 10_000n);
    const first = await payment();
    expect((await settle(first.signed, first.requirements)).body.success).toBe(true);
    expect(primary.sends, "the primary must be the first choice for this test to mean anything").toBe(1);
  });

  afterAll(async () => {
    await restartFacilitator();
    await Promise.all([primary.stop(), fallback.stop()]);
  });

  it("stalling before the send: the settlement moves on, and the RPC soon loses its rank", async () => {
    primary.mode = "stall";
    const { requirements, signed, payTo } = await payment();
    expect((await verify(signed, requirements)).body.isValid).toBe(true);
    const nonce = await nonceOf(TESTNET, FACILITATOR_SIGNER[TESTNET]);

    const started = Date.now();
    const res = await settle(signed, requirements);
    record("settle with a stalled primary", res);
    expect(res.body.success).toBe(true);
    expect(Date.now() - started).toBeLessThan(SEND_BOUND_MS);
    expect(primary.heldSends).toBe(1);
    expect(fallback.sends).toBe(1);
    expect(await nonceOf(TESTNET, FACILITATOR_SIGNER[TESTNET])).toBe(nonce + 1);
    expect(await tokenBalance(TESTNET, asset, payTo)).toBe(1_000n);

    // Failed sends count against the primary. alloy scores the last ten results, plus latency, so its
    // rank flips after one or two of them, depending on how fast the fallback measured.
    let lastMs = Number.POSITIVE_INFINITY;
    for (let i = 0; i < 3; i++) {
      const next = await payment();
      const nextStarted = Date.now();
      expect((await settle(next.signed, next.requirements)).body.success).toBe(true);
      lastMs = Date.now() - nextStarted;
      expect(lastMs).toBeLessThan(SEND_BOUND_MS);
    }
    expect(lastMs).toBeLessThan(5_000);
    expect(primary.heldSends).toBeLessThanOrEqual(3);
  });

  it("stalling after forwarding the transaction: a mined settlement is not reported as failed", async () => {
    primary.mode = "forward-then-stall";
    const { requirements, signed, payTo } = await payment();
    const nonce = await nonceOf(TESTNET, FACILITATOR_SIGNER[TESTNET]);

    const started = Date.now();
    const res = await settle(signed, requirements);
    record("settle with a primary that forwards and stalls", res);
    expect(res.body.success).toBe(true);
    expect(Date.now() - started).toBeLessThan(SEND_BOUND_MS);
    // The copy reached the fallback, which refused it: the transaction was already mined.
    expect(primary.heldSends).toBe(1);
    expect(fallback.sends).toBe(1);

    const receipt = await publicClient(TESTNET).getTransactionReceipt({ hash: res.body.transaction as Hash });
    expect(receipt.status).toBe("success");
    expect(await nonceOf(TESTNET, FACILITATOR_SIGNER[TESTNET])).toBe(nonce + 1);
    expect(await tokenBalance(TESTNET, asset, payTo)).toBe(1_000n);
  });
});
