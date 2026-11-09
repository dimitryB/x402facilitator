import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import vectors from "../test-vectors.json" with { type: "json" };
import { ExactBtcClientScheme, type PayBtc } from "../src/client.js";
import { derivePaymentAddress, newPaymentId } from "../src/derive.js";
import { FilePaymentJournal, MemoryPaymentJournal } from "../src/journal.js";
import { BTC_MAINNET, BTC_TESTNET3 } from "../src/networks.js";

const XPUB = vectors.vectors.find(v => v.network === BTC_MAINNET)!.payTo;
const dir = mkdtempSync(join(tmpdir(), "btc-journal-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function requirements(extra: Record<string, unknown> = {}, over: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: "exact",
    network: BTC_MAINNET,
    asset: "BTC",
    amount: "1000",
    payTo: XPUB,
    maxTimeoutSeconds: 3600,
    extra: { assetTransferMethod: "utxo", paymentFlow: "upfront", addressType: "p2wpkh", minConfirmations: 1, paymentId: newPaymentId(), ...extra },
    ...over,
  };
}

function required(accepts: PaymentRequirements[]): PaymentRequired {
  return { x402Version: 2, resource: { url: "http://seller.test/paid" }, accepts };
}

/** A PayBtc that records calls and returns a deterministic output. */
function recorder(delayMs = 0) {
  const calls: { address: string; sats: bigint; script: string }[] = [];
  const pay: PayBtc = async (address, sats, ctx) => {
    calls.push({ address, sats, script: ctx.script });
    if (delayMs) await new Promise(r => setTimeout(r, delayMs));
    return { txid: calls.length.toString(16).padStart(64, "0"), vout: 1 };
  };
  return { calls, pay };
}

describe("ExactBtcClientScheme through x402Client", () => {
  it("pays the derived address once and returns { txid, vout } with accepted = the requirements", async () => {
    const { calls, pay } = recorder();
    const req = requirements();
    const client = new x402Client()
      .register(BTC_MAINNET, new ExactBtcClientScheme(pay))
      .setSpendControls({ allowedAssets: [{ network: BTC_MAINNET, asset: "BTC", maxAmountPerPayment: "5000" }] });
    const payment = await client.createPaymentPayload(required([req]));
    expect(payment.accepted).toEqual(req);
    expect(payment.payload).toEqual({ txid: "1".padStart(64, "0"), vout: 1 });
    const d = derivePaymentAddress(XPUB, BTC_MAINNET, req.extra.paymentId as string);
    expect(calls).toEqual([{ address: d.address, sats: 1000n, script: d.script }]);
  });

  it("without an allowedAssets entry the SDK's spend controls refuse BTC", async () => {
    const client = new x402Client().register(BTC_MAINNET, new ExactBtcClientScheme(recorder().pay));
    await expect(client.createPaymentPayload(required([requirements()]))).rejects.toThrow(/spendControls/);
  });

  it("the per-asset cap holds", async () => {
    const { calls, pay } = recorder();
    const client = new x402Client()
      .register(BTC_MAINNET, new ExactBtcClientScheme(pay))
      .setSpendControls({ allowedAssets: [{ network: BTC_MAINNET, asset: "BTC", maxAmountPerPayment: "999" }] });
    await expect(client.createPaymentPayload(required([requirements()]))).rejects.toThrow(/maxAmountPerPayment/);
    expect(calls).toEqual([]);
  });
});

describe("never pays twice", () => {
  it("a repeated createPaymentPayload for one paymentId returns the recorded output", async () => {
    const { calls, pay } = recorder();
    const scheme = new ExactBtcClientScheme(pay);
    const req = requirements();
    const a = await scheme.createPaymentPayload(2, req);
    const b = await scheme.createPaymentPayload(2, structuredClone(req));
    expect(b).toEqual(a);
    expect(calls).toHaveLength(1);
  });

  it("concurrent calls share one payment", async () => {
    const { calls, pay } = recorder(20);
    const scheme = new ExactBtcClientScheme(pay);
    const req = requirements();
    const results = await Promise.all([1, 2, 3].map(() => scheme.createPaymentPayload(2, req)));
    expect(new Set(results.map(r => JSON.stringify(r))).size).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("a restarted buyer reads the file journal and does not pay again", async () => {
    const file = join(dir, "restart.jsonl");
    const req = requirements();
    const first = recorder();
    const r1 = await new ExactBtcClientScheme(first.pay, { journal: new FilePaymentJournal(file) }).createPaymentPayload(2, req);
    const second = recorder();
    const r2 = await new ExactBtcClientScheme(second.pay, { journal: new FilePaymentJournal(file) }).createPaymentPayload(2, req);
    expect(r2).toEqual(r1);
    expect(second.calls).toEqual([]);
    const lines = readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(lines.map(l => l.status)).toEqual(["paying", "paid"]);
    expect(lines[1]).toMatchObject({ paymentId: req.extra.paymentId, txid: r1.payload.txid, vout: 1, amount: "1000", requirements: req });
  });

  it("a payment that failed mid-way (paying, never paid) blocks a second attempt", async () => {
    const journal = new MemoryPaymentJournal();
    const req = requirements();
    const failing: PayBtc = async () => {
      throw new Error("connection reset after broadcast");
    };
    await expect(new ExactBtcClientScheme(failing, { journal }).createPaymentPayload(2, req)).rejects.toThrow(/connection reset/);
    const { calls, pay } = recorder();
    await expect(new ExactBtcClientScheme(pay, { journal }).createPaymentPayload(2, req)).rejects.toThrow(/never recorded as paid.*may have been broadcast/);
    expect(calls).toEqual([]);
  });

  it("a journal entry for the same paymentId but another payee is refused", async () => {
    const journal = new MemoryPaymentJournal();
    const req = requirements();
    await new ExactBtcClientScheme(recorder().pay, { journal }).createPaymentPayload(2, req);
    const other = { ...req, payTo: vectors.vectors.find(v => v.network === BTC_MAINNET && v.addressType === "p2tr")!.payTo, amount: "5000" };
    await expect(new ExactBtcClientScheme(recorder().pay, { journal }).createPaymentPayload(2, other)).rejects.toThrow(/another payment/);
  });
});

describe("requirements a buyer must refuse before paying", () => {
  const cases: [string, PaymentRequirements, RegExp][] = [
    ["asset other than BTC", requirements({}, { asset: "SAT" }), /asset must be "BTC"/],
    ["a non-integer amount", requirements({}, { amount: "1.5" }), /positive integer/],
    ["flow other than upfront", requirements({ paymentFlow: "authorization" }), /paymentFlow/],
    ["transfer method other than utxo", requirements({ assetTransferMethod: "eip3009" }), /assetTransferMethod/],
    ["no paymentId", requirements({ paymentId: undefined }), /paymentId/],
    ["uppercase paymentId", requirements({ paymentId: "00112233445566778899AABBCCDDEEFF" }), /paymentId/],
    ["unknown addressType", requirements({ addressType: "p2pkh" }), /addressType/],
    ["an EVM network", requirements({}, { network: "eip155:43111" }), /not a supported Bitcoin network/],
    ["an xpub on testnet3", requirements({}, { network: BTC_TESTNET3 }), /tpub key on Bitcoin testnet3/],
  ];
  for (const [name, req, error] of cases) {
    it(name, async () => {
      const { calls, pay } = recorder();
      await expect(new ExactBtcClientScheme(pay).createPaymentPayload(2, req)).rejects.toThrow(error);
      expect(calls).toEqual([]);
    });
  }

  it("a PayBtc that returns a malformed txid fails the payload (and stays journaled as paying)", async () => {
    const journal = new MemoryPaymentJournal();
    const req = requirements();
    const bad: PayBtc = async () => ({ txid: "0xABC", vout: 0 });
    await expect(new ExactBtcClientScheme(bad, { journal }).createPaymentPayload(2, req)).rejects.toThrow(/64 lowercase hex/);
    expect((await journal.get(req.extra.paymentId as string))?.status).toBe("paying");
  });
});
