/**
 * With two live RPCs, a settlement must broadcast its transaction once.
 *
 * alloy's FallbackLayer sends a request to every RPC at once and takes the first response, and a
 * JSON-RPC error counts as one. For eth_sendRawTransaction that meant one copy per RPC: the node that saw
 * a copy second rejected it, and when that rejection arrived first the settle failed although the
 * transfer was mined, so the payer was charged for a settlement reported as failed (D-019). The other
 * e2e files cannot see this, because their primary RPC is dead and only one RPC ever answers. Here both
 * RPCs are live: each is a recording proxy in front of the same fork.
 */
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { TESTNET, usdcAsset } from "@hemi-x402/shared";
import { ensurePermit2Approval } from "../lib/chain";
import { restartFacilitator } from "../lib/compose";
import { BUYER_KEY, FORK_RPC } from "../lib/env";
import { record, settle } from "../lib/facilitator";
import { freshAddress, requirementsFor, signPayment } from "../lib/payments";

const SETTLEMENTS = 3;
const buyer = privateKeyToAccount(BUYER_KEY);
const asset = usdcAsset(TESTNET);

/** An RPC in front of the testnet fork that counts the requests and the transactions it receives. */
class RecordingRpc {
  requests = 0;
  sends = 0;
  private readonly server: Server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString();
    const calls = [JSON.parse(body)].flat() as { method: string }[];
    this.requests += calls.length;
    this.sends += calls.filter(call => call.method === "eth_sendRawTransaction").length;
    const answer = await fetch(FORK_RPC[TESTNET], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    response.writeHead(answer.status, { "content-type": "application/json" });
    response.end(await answer.text());
  });

  /** Listens like the forks do, so that the container reaches it through host.docker.internal. */
  async start(): Promise<string> {
    await new Promise<void>(resolve => this.server.listen(0, "0.0.0.0", resolve));
    return `http://host.docker.internal:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    await new Promise(resolve => this.server.close(resolve));
  }
}

describe("settling with two live RPCs", () => {
  const rpcs = [new RecordingRpc(), new RecordingRpc()];

  beforeAll(async () => {
    const [primary, fallback] = await Promise.all(rpcs.map(rpc => rpc.start()));
    await restartFacilitator({ HEMI_TESTNET_RPC_PRIMARY: primary!, HEMI_TESTNET_RPC_FALLBACK: fallback! });
    await ensurePermit2Approval(TESTNET, buyer, asset, 1_000n * BigInt(SETTLEMENTS));
  });

  afterAll(async () => {
    await restartFacilitator();
    await Promise.all(rpcs.map(rpc => rpc.stop()));
  });

  it("broadcasts each settlement once, and both RPCs are in use", async () => {
    for (let i = 1; i <= SETTLEMENTS; i++) {
      const requirements = requirementsFor(TESTNET, asset, freshAddress(), 1_000n);
      const res = await settle(await signPayment(buyer, requirements), requirements);
      record(`settle ${i} with two live RPCs`, res);
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(rpcs[0]!.sends + rpcs[1]!.sends).toBe(i);
    }
    expect(rpcs[0]!.requests).toBeGreaterThan(0);
    expect(rpcs[1]!.requests).toBeGreaterThan(0);
  });
});
