/**
 * ExactBtcServerScheme inside the SDK's own engine (x402ResourceServer + x402HTTPResourceServer, what
 * @x402/express runs), in front of an in-memory facilitator. Pins down the SDK behaviour the scheme relies on.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader, type HTTPAdapter } from "@x402/core/http";
import { x402HTTPResourceServer, x402ResourceServer, type FacilitatorClient } from "@x402/core/server";
import type { PaymentPayload, PaymentRequirements, SettleResponse, SupportedResponse, VerifyResponse } from "@x402/core/types";
import vectors from "../test-vectors.json" with { type: "json" };
import { ExactBtcServerScheme } from "../src/server.js";
import { isPaymentId } from "../src/derive.js";
import { BTC_MAINNET, BTC_TESTNET3 } from "../src/networks.js";

const XPUB = vectors.vectors.find(v => v.network === BTC_MAINNET)!.payTo;
const TPUB = vectors.vectors.find(v => v.network === BTC_TESTNET3)!.payTo;
const EVM = "eip155:43111";
const EVM_PAY_TO = "0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65";
const TXID = "95bca0290000000000000000000000000000000000000000000000000000367e";

/** A facilitator that records calls and answers /settle from a queue. */
class FakeFacilitator implements FacilitatorClient {
  verifies: PaymentRequirements[] = [];
  settles: { payload: PaymentPayload; requirements: PaymentRequirements }[] = [];
  answers: Partial<SettleResponse>[] = [];
  kinds: SupportedResponse["kinds"] = [
    { x402Version: 2, scheme: "exact", network: BTC_MAINNET, extra: { asset: "BTC", addressTypes: ["p2wpkh", "p2tr"], minConfirmations: { default: 1, floor: 1, ceiling: 6 } } },
    { x402Version: 2, scheme: "exact", network: BTC_TESTNET3 },
    { x402Version: 2, scheme: "exact", network: EVM },
  ];

  async getSupported(): Promise<SupportedResponse> {
    return { kinds: this.kinds, extensions: [], signers: {} };
  }
  async verify(_p: PaymentPayload, r: PaymentRequirements): Promise<VerifyResponse> {
    this.verifies.push(r);
    return { isValid: true };
  }
  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    this.settles.push({ payload: structuredClone(payload), requirements: structuredClone(requirements) });
    const a = this.answers.shift() ?? {};
    return { success: true, transaction: payload.payload.txid as string, network: requirements.network, ...a } as SettleResponse;
  }
}

function adapter(header?: string): HTTPAdapter {
  return {
    getHeader: name => (name.toLowerCase() === "payment-signature" ? header : undefined),
    getMethod: () => "GET",
    getPath: () => "/paid",
    getUrl: () => "http://seller.test/paid",
    getAcceptHeader: () => "application/json",
    getUserAgent: () => "btc-unit-test",
  };
}

let facilitator: FakeFacilitator;
let seller: x402HTTPResourceServer;

async function makeSeller(evm = true) {
  facilitator = new FakeFacilitator();
  const rs = new x402ResourceServer(facilitator)
    .register(BTC_MAINNET, new ExactBtcServerScheme({ network: BTC_MAINNET, payTo: XPUB }))
    .register(BTC_TESTNET3, new ExactBtcServerScheme({ network: BTC_TESTNET3, payTo: TPUB, addressType: "p2tr", minConfirmations: 3 }));
  const accepts = [
    { scheme: "exact", network: BTC_MAINNET, payTo: XPUB, price: { asset: "BTC", amount: "1000" }, maxTimeoutSeconds: 3600 },
    { scheme: "exact", network: BTC_TESTNET3, payTo: TPUB, price: { asset: "BTC", amount: "2000" }, maxTimeoutSeconds: 3600 },
  ];
  if (evm) {
    // A non-bip122 accept beside them, as seller/server.ts has; the enrich hook must leave it alone.
    const { ExactEvmScheme } = await import("@x402/evm/exact/server");
    rs.register(EVM, new ExactEvmScheme());
    accepts.unshift({
      scheme: "exact",
      network: EVM,
      payTo: EVM_PAY_TO,
      price: { asset: "0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA", amount: "1000", extra: { assetTransferMethod: "eip3009", name: "Bridged USDC (Stargate)", version: "2" } } as never,
      maxTimeoutSeconds: 300,
    });
  }
  seller = new x402HTTPResourceServer(rs, { "GET /paid": { accepts: accepts as never, description: "paid", mimeType: "application/json" } });
  await seller.initialize();
}

async function unpaid() {
  const result = await seller.processHTTPRequest({ adapter: adapter(), path: "/paid", method: "GET" });
  if (result.type !== "payment-error") throw new Error(`expected 402, got ${result.type}`);
  return { status: result.response.status, required: decodePaymentRequiredHeader(result.response.headers["PAYMENT-REQUIRED"]!) };
}

function payFor(accepted: PaymentRequirements, txid = TXID, vout = 1): PaymentPayload {
  return { x402Version: 2, resource: { url: "http://seller.test/paid" }, accepted, payload: { txid, vout } };
}

describe("the 402 a stock SDK seller builds", () => {
  beforeEach(() => makeSeller());

  it("each bip122 accept has asset BTC, sats, the xpub, utxo/upfront, its addressType and minConfirmations, and a 32-hex paymentId", async () => {
    const { status, required } = await unpaid();
    expect(status).toBe(402);
    const [evm, main, test] = required.accepts;
    expect(evm.extra.paymentId).toBeUndefined();
    expect(main).toEqual({
      scheme: "exact",
      network: BTC_MAINNET,
      asset: "BTC",
      amount: "1000",
      payTo: XPUB,
      maxTimeoutSeconds: 3600,
      extra: { assetTransferMethod: "utxo", paymentFlow: "upfront", addressType: "p2wpkh", minConfirmations: 1, paymentId: expect.stringMatching(/^[0-9a-f]{32}$/) },
    });
    expect(test.extra).toMatchObject({ addressType: "p2tr", minConfirmations: 3, paymentFlow: "upfront" });
    expect(isPaymentId(test.extra.paymentId)).toBe(true);
    expect(test.extra.paymentId).not.toBe(main.extra.paymentId);
  });

  it("every 402 carries a fresh paymentId", async () => {
    const ids = new Set<unknown>();
    for (let i = 0; i < 5; i++) ids.add((await unpaid()).required.accepts[1].extra.paymentId);
    expect(ids.size).toBe(5);
  });
});

describe("a paid request (upfront flow)", () => {
  beforeEach(() => makeSeller());

  it("skips /verify, settles before the handler, and sends /settle a fresh paymentId while accepted keeps the paid one", async () => {
    const accepted = (await unpaid()).required.accepts[1];
    const result = await seller.processHTTPRequest({ adapter: adapter(encodePaymentSignatureHeader(payFor(accepted))), path: "/paid", method: "GET" });
    expect(result.type).toBe("payment-verified");
    if (result.type !== "payment-verified") return;
    expect(result.beforeHandlerSettlement?.result).toMatchObject({ success: true, transaction: TXID, network: BTC_MAINNET });
    expect(facilitator.verifies).toEqual([]);
    expect(facilitator.settles).toHaveLength(1);
    const [{ payload, requirements }] = facilitator.settles;
    expect(payload.accepted.extra.paymentId).toBe(accepted.extra.paymentId);
    expect(isPaymentId(requirements.extra.paymentId)).toBe(true);
    // The SDK rebuilt the 402 for this request: the facilitator must derive from accepted, never from these.
    expect(requirements.extra.paymentId).not.toBe(accepted.extra.paymentId);
    const { paymentId: _a, ...acceptedRest } = accepted.extra;
    const { paymentId: _b, ...requiredRest } = requirements.extra;
    expect(requiredRest).toEqual(acceptedRest);
  });

  it("a failed settle reaches the buyer as 402 with PAYMENT-RESPONSE carrying the facilitator's errorReason", async () => {
    const accepted = (await unpaid()).required.accepts[1];
    facilitator.answers.push({ success: false, errorReason: "invalid_exact_bip122_payload_unconfirmed", transaction: "" });
    const result = await seller.processHTTPRequest({ adapter: adapter(encodePaymentSignatureHeader(payFor(accepted))), path: "/paid", method: "GET" });
    if (result.type !== "payment-error") throw new Error(`expected payment-error, got ${result.type}`);
    expect(result.response.status).toBe(402);
    expect(result.response.headers["PAYMENT-REQUIRED"]).toBeUndefined();
    expect(decodePaymentResponseHeader(result.response.headers["PAYMENT-RESPONSE"]!)).toMatchObject({
      success: false,
      errorReason: "invalid_exact_bip122_payload_unconfirmed",
      network: BTC_MAINNET,
    });
  });

  it("settlement_pending is retried once by the SDK, then reaches the buyer", async () => {
    const accepted = (await unpaid()).required.accepts[1];
    const hemiTx = `0x${"11".repeat(32)}`;
    facilitator.answers.push(
      { success: false, errorReason: "settlement_pending", transaction: hemiTx },
      { success: false, errorReason: "settlement_pending", transaction: hemiTx },
    );
    const result = await seller.processHTTPRequest({ adapter: adapter(encodePaymentSignatureHeader(payFor(accepted))), path: "/paid", method: "GET" });
    if (result.type !== "payment-error") throw new Error(`expected payment-error, got ${result.type}`);
    expect(facilitator.settles).toHaveLength(2);
    expect(decodePaymentResponseHeader(result.response.headers["PAYMENT-RESPONSE"]!)).toMatchObject({ errorReason: "settlement_pending", transaction: hemiTx });
  });

  it("a payload whose accepted changed a non-dynamic field (amount) matches nothing", async () => {
    const accepted = (await unpaid()).required.accepts[1];
    const result = await seller.processHTTPRequest({
      adapter: adapter(encodePaymentSignatureHeader(payFor({ ...accepted, amount: "999" }))),
      path: "/paid",
      method: "GET",
    });
    if (result.type !== "payment-error") throw new Error(`expected payment-error, got ${result.type}`);
    expect(decodePaymentRequiredHeader(result.response.headers["PAYMENT-REQUIRED"]!).error).toBe("No matching payment requirements");
    expect(facilitator.settles).toEqual([]);
  });
});

describe("configuration checks", () => {
  it("prices: only { asset: BTC, amount: <sats> }", async () => {
    const s = new ExactBtcServerScheme({ network: BTC_MAINNET });
    await expect(s.parsePrice({ asset: "BTC", amount: "1000" }, BTC_MAINNET)).resolves.toEqual({ asset: "BTC", amount: "1000", extra: {} });
    await expect(s.parsePrice("$0.01", BTC_MAINNET)).rejects.toThrow(/must be \{ asset: "BTC"/);
    await expect(s.parsePrice({ asset: "SAT", amount: "1" }, BTC_MAINNET)).rejects.toThrow(/asset/);
    await expect(s.parsePrice({ asset: "BTC", amount: "0.5" }, BTC_MAINNET)).rejects.toThrow(/positive integer/);
    await expect(s.parsePrice({ asset: "BTC", amount: "1" }, BTC_TESTNET3)).rejects.toThrow(/cannot serve/);
  });

  it("payTo must match the network", () => {
    expect(() => new ExactBtcServerScheme({ network: BTC_TESTNET3, payTo: XPUB })).toThrow(/tpub key on Bitcoin testnet3/);
    expect(() => new ExactBtcServerScheme({ network: BTC_MAINNET, minConfirmations: 0 })).toThrow(/minConfirmations/);
  });

  it("validateFacilitatorSupport compares the facilitator's policy", () => {
    const s = new ExactBtcServerScheme({ network: BTC_MAINNET, minConfirmations: 9, addressType: "p2tr" });
    const problem = s.validateFacilitatorSupport(BTC_MAINNET, {
      x402Version: 2,
      scheme: "exact",
      network: BTC_MAINNET,
      extra: { asset: "BTC", addressTypes: ["p2wpkh"], minConfirmations: { default: 1, floor: 1, ceiling: 6 } },
    });
    expect(problem).toMatch(/exclude p2tr.*above the facilitator ceiling 6/);
    expect(new ExactBtcServerScheme({ network: BTC_MAINNET }).validateFacilitatorSupport(BTC_MAINNET, { x402Version: 2, scheme: "exact", network: BTC_MAINNET })).toBeUndefined();
  });

  it("the SDK refuses to start when the scheme's policy does not fit the facilitator's", async () => {
    facilitator = new FakeFacilitator();
    const rs = new x402ResourceServer(facilitator).register(BTC_MAINNET, new ExactBtcServerScheme({ network: BTC_MAINNET, minConfirmations: 7 }));
    const s = new x402HTTPResourceServer(rs, {
      "GET /paid": { accepts: { scheme: "exact", network: BTC_MAINNET, payTo: XPUB, price: { asset: "BTC", amount: "1000" } } },
    });
    await expect(s.initialize()).rejects.toThrow(/above the facilitator ceiling 6/);
  });
});
