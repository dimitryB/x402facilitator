/**
 * What a stock TS seller makes of this facilitator's rejections.
 *
 * The seller is the SDK's own HTTP layer: x402HTTPResourceServer over x402ResourceServer with the stock
 * HTTPFacilitatorClient, which is what @x402/express's paymentMiddleware runs. It is driven through
 * processHTTPRequest with a minimal request adapter, because seller/server.ts itself would listen on its
 * own TCP port, and this suite may only use 38080, 38545 and 38546.
 *
 * Why the HTTP status matters (x402-foundation/x402 @ e4a0868, typescript/packages/core/src):
 *   - http/httpFacilitatorClient.ts 423–436: a non-2xx /verify answer with `isValid` becomes a thrown
 *     VerifyError; types/facilitator.ts 68–71 makes its message "<code>: <message>".
 *   - http/x402HTTPResourceServer.ts 692–699: an `isValid: false` result puts the bare code into the
 *     seller's 402 (`error`); 762–770: a thrown error puts its message there instead.
 *   - http/x402HTTPResourceServer.ts 1351–1353: the seller answers 412 instead of 402 only when that
 *     error is exactly "permit2_allowance_required".
 * The TS reference facilitator answers rejections with 200 (examples/typescript/facilitator/basic/
 * index.ts 208, 290), and so does this one since facilitator/x402-rs/patches 0018. Up to hemi.6 it answered
 * 400 (and 412 for a missing allowance): the seller's 402 then read
 * "invalid_exact_evm_payload_signature: Signature was not made by …", and a missing allowance gave the
 * buyer 402, not 412.
 */
import { appendFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import type { Hex, LocalAccount } from "viem";
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader, type HTTPAdapter } from "@x402/core/http";
import { HTTPFacilitatorClient, x402HTTPResourceServer, x402ResourceServer } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { MAINNET, TESTNET, usdcAsset, type HemiAsset, type HemiNetwork } from "@hemi-x402/shared";
import { fundEth, fundToken } from "../lib/chain";
import { FACILITATOR_URL, OBSERVED_FILE } from "../lib/env";
import { freshAccount, freshAddress, signPayment, tamperSignature, withSignature } from "../lib/payments";

const PATH = "/paid";
const payTo = freshAddress();
const AMOUNT = "1000";

/** The route's accepted payments, priced like seller/server.ts does (explicit asset and amount). */
function accept(network: HemiNetwork, asset: HemiAsset) {
  const extra =
    asset.transferMethod === "permit2"
      ? { assetTransferMethod: "permit2" }
      : { assetTransferMethod: "eip3009", name: asset.eip712!.name, version: asset.eip712!.version };
  return { scheme: "exact" as const, network, payTo, price: { asset: asset.address, amount: AMOUNT, extra } };
}

function adapter(paymentHeader?: string): HTTPAdapter {
  return {
    getHeader: name => (name.toLowerCase() === "payment-signature" ? paymentHeader : undefined),
    getMethod: () => "GET",
    getPath: () => PATH,
    getUrl: () => `http://seller.e2e.local${PATH}`,
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "hemi-x402-e2e",
  };
}

interface SellerAnswer {
  status: number;
  /** The `error` of the seller's PAYMENT-REQUIRED answer, as a buyer reads it. */
  error: string | undefined;
  body: unknown;
}

describe("a stock TS seller (x402HTTPResourceServer + HTTPFacilitatorClient) in front of this facilitator", () => {
  let resourceServer: x402ResourceServer;
  let seller: x402HTTPResourceServer;

  async function request(payment?: PaymentPayload): Promise<SellerAnswer> {
    const header = payment ? encodePaymentSignatureHeader(payment) : undefined;
    const result = await seller.processHTTPRequest({ adapter: adapter(header), path: PATH, method: "GET" });
    if (result.type !== "payment-error") throw new Error(`expected the seller to refuse, got ${result.type}`);
    const { status, headers, body } = result.response;
    const required = headers["PAYMENT-REQUIRED"];
    const error = required ? decodePaymentRequiredHeader(required).error : undefined;
    appendFileSync(OBSERVED_FILE, JSON.stringify({ label: "stock seller answer", status, error, body }) + "\n");
    return { status, error, body };
  }

  /** The requirements the seller advertises for `asset` on `network`, read from its unpaid 402. */
  async function advertised(network: HemiNetwork, asset: HemiAsset): Promise<PaymentRequirements> {
    const result = await seller.processHTTPRequest({ adapter: adapter(), path: PATH, method: "GET" });
    if (result.type !== "payment-error") throw new Error("expected a 402 for an unpaid request");
    expect(result.response.status).toBe(402);
    const required = decodePaymentRequiredHeader(result.response.headers["PAYMENT-REQUIRED"]!);
    const match = required.accepts.find(a => a.network === network && a.asset === asset.address);
    if (!match) throw new Error(`the seller does not advertise ${asset.symbol} on ${network}`);
    return match;
  }

  beforeAll(async () => {
    resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: FACILITATOR_URL }));
    for (const network of [MAINNET, TESTNET]) resourceServer.register(network, new ExactEvmScheme());
    seller = new x402HTTPResourceServer(resourceServer, {
      [`GET ${PATH}`]: {
        accepts: [accept(MAINNET, usdcAsset(MAINNET)), accept(TESTNET, usdcAsset(TESTNET))],
        description: "e2e paid route",
        mimeType: "application/json",
      },
    });
    await seller.initialize();
  });

  it("a tampered signature: verifyPayment returns the bare §9 code, and the seller's 402 carries it", async () => {
    const buyer: LocalAccount = freshAccount();
    await fundEth(MAINNET, buyer.address);
    await fundToken(MAINNET, usdcAsset(MAINNET), buyer.address, 1_000_000n);
    const requirements = await advertised(MAINNET, usdcAsset(MAINNET));
    const genuine = await signPayment(buyer, requirements);
    const tampered = withSignature(genuine, tamperSignature((genuine.payload as { signature: Hex }).signature));

    // The SDK reads the rejection as a result, not as a thrown VerifyError.
    const verified = await resourceServer.verifyPayment(tampered, requirements);
    expect(verified).toMatchObject({ isValid: false, invalidReason: "invalid_exact_evm_payload_signature" });

    const answer = await request(tampered);
    expect(answer.status).toBe(402);
    expect(answer.error).toBe("invalid_exact_evm_payload_signature");
    expect(answer.body).toEqual({ error: "invalid_exact_evm_payload_signature" });
  });

  it("a payer with no tokens: the seller's 402 carries insufficient_funds", async () => {
    const buyer = freshAccount();
    const requirements = await advertised(MAINNET, usdcAsset(MAINNET));
    const answer = await request(await signPayment(buyer, requirements));
    expect(answer.status).toBe(402);
    expect(answer.error).toBe("insufficient_funds");
  });

  it("no Permit2 allowance: the seller answers 412 permit2_allowance_required (scheme_exact_evm.md Permit2 step 2)", async () => {
    const buyer = freshAccount();
    await fundToken(TESTNET, usdcAsset(TESTNET), buyer.address, 1_000_000n);
    const requirements = await advertised(TESTNET, usdcAsset(TESTNET));
    expect(requirements.extra).toMatchObject({ assetTransferMethod: "permit2" });
    const answer = await request(await signPayment(buyer, requirements));
    expect(answer.status).toBe(412);
    expect(answer.error).toBe("permit2_allowance_required");
  });
});
