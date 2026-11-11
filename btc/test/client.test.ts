import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import type { PaymentRequired, PaymentRequirements } from "@x402/core/types";
import vectors from "../test-vectors.json" with { type: "json" };
import { ExactBtcClientScheme, type PayBtc } from "../src/client.js";
import { derivePaymentAddress, newPaymentId } from "../src/derive.js";
import { FilePaymentJournal, MemoryPaymentJournal, type JournalEntry } from "../src/journal.js";
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
    await expect(new ExactBtcClientScheme(pay, { journal }).createPaymentPayload(2, req)).rejects.toThrow(/not recorded as paid.*may have been broadcast/);
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

describe("clients that share a journal pay once", () => {
  it("two clients on one MemoryPaymentJournal", async () => {
    const journal = new MemoryPaymentJournal();
    const { calls, pay } = recorder(20);
    const req = requirements();
    const [a, b] = await Promise.allSettled([1, 2].map(() => new ExactBtcClientScheme(pay, { journal }).createPaymentPayload(2, req)));
    expect(calls).toHaveLength(1);
    expect([a.status, b.status].sort()).toEqual(["fulfilled", "rejected"]);
    expect(String((a.status === "rejected" ? a : b as PromiseRejectedResult).reason)).toMatch(/not recorded as paid/);
    // Once the first has recorded the payment, a third client gets the recorded output.
    const c = await new ExactBtcClientScheme(recorder().pay, { journal }).createPaymentPayload(2, req);
    expect(c).toEqual((a.status === "fulfilled" ? a : b as PromiseFulfilledResult<unknown>).value);
  });

  it("two FilePaymentJournal instances on one file (the audit's reproduction)", async () => {
    const file = join(dir, "shared.jsonl");
    const { calls, pay } = recorder(20);
    const req = requirements();
    const results = await Promise.allSettled(
      [1, 2].map(() => new ExactBtcClientScheme(pay, { journal: new FilePaymentJournal(file) }).createPaymentPayload(2, req)),
    );
    expect(calls).toHaveLength(1);
    expect(results.map(r => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    const lines = readFileSync(file, "utf8").trim().split("\n").map(l => JSON.parse(l));
    expect(lines.map(l => l.status)).toEqual(["paying", "paid"]);
  });

  it("a client that stopped between its claim and its journal line still blocks the next", async () => {
    const file = join(dir, "stopped.jsonl");
    const journal = new FilePaymentJournal(file);
    const req = requirements();
    const paymentId = req.extra.paymentId as string;
    const d = derivePaymentAddress(XPUB, BTC_MAINNET, paymentId);
    const claimed: JournalEntry = {
      paymentId, status: "paying", network: BTC_MAINNET, payTo: XPUB, addressType: "p2wpkh", address: d.address, script: d.script,
      amount: "1000", requirements: req, createdAt: "2026-11-10T00:00:00.000Z", updatedAt: "2026-11-10T00:00:00.000Z",
    };
    mkdirSync(journal.claims, { recursive: true });
    writeFileSync(join(journal.claims, paymentId), JSON.stringify(claimed));
    expect(await journal.get(paymentId)).toEqual(claimed);
    const { calls, pay } = recorder();
    await expect(new ExactBtcClientScheme(pay, { journal }).createPaymentPayload(2, req)).rejects.toThrow(/2026-11-10T00:00:00.000Z but is not recorded as paid/);
    expect(calls).toEqual([]);
  });

  it("a claim file still being written (empty) blocks too", async () => {
    const journal = new FilePaymentJournal(join(dir, "empty-claim.jsonl"));
    const req = requirements();
    mkdirSync(journal.claims, { recursive: true });
    writeFileSync(join(journal.claims, req.extra.paymentId as string), "");
    const { calls, pay } = recorder();
    await expect(new ExactBtcClientScheme(pay, { journal }).createPaymentPayload(2, req)).rejects.toThrow(/not recorded as paid/);
    expect(calls).toEqual([]);
  });

  it("separate processes claiming the same paymentIds: each is won exactly once", async () => {
    const file = join(dir, "processes.jsonl");
    const script = join(dir, "claimer.mts");
    const journalModule = fileURLToPath(new URL("../src/journal.ts", import.meta.url));
    writeFileSync(
      script,
      `import { FilePaymentJournal } from ${JSON.stringify(journalModule)};
const [file, start, ...ids] = process.argv.slice(2);
const journal = new FilePaymentJournal(file);
while (Date.now() < Number(start)) {}
const won: string[] = [];
for (const paymentId of ids) {
  const entry = { paymentId, status: "paying", network: "bip122:000000000019d6689c085ae165831e93", payTo: "", addressType: "p2wpkh",
    address: "", script: "", amount: "1", requirements: {}, createdAt: "", updatedAt: "" };
  if ((await journal.claim(entry as never)) === undefined) won.push(paymentId);
}
console.log(JSON.stringify(won));
`,
    );
    const ids = Array.from({ length: 40 }, () => newPaymentId());
    const start = Date.now() + 1500;
    const run = () =>
      new Promise<string[]>((resolve, reject) => {
        const child = spawn(process.execPath, ["--import", "tsx", script, file, String(start), ...ids], { stdio: ["ignore", "pipe", "pipe"] });
        let out = "";
        let err = "";
        child.stdout.on("data", d => (out += d));
        child.stderr.on("data", d => (err += d));
        child.on("close", code => (code === 0 ? resolve(JSON.parse(out)) : reject(new Error(err))));
      });
    const won = (await Promise.all([1, 2, 3, 4].map(run))).flat();
    expect(won.sort()).toEqual([...ids].sort());
  }, 30_000);

  it("a concurrent request for the same paymentId and a larger amount is refused", async () => {
    const { calls, pay } = recorder(20);
    const scheme = new ExactBtcClientScheme(pay);
    const req = requirements();
    const [a, b] = await Promise.allSettled([scheme.createPaymentPayload(2, req), scheme.createPaymentPayload(2, { ...req, amount: "2000" })]);
    expect(a.status).toBe("fulfilled");
    expect(b.status).toBe("rejected");
    expect(String((b as PromiseRejectedResult).reason)).toMatch(/being paid as 1000 sats.*refusing a concurrent request for 2000 sats/);
    expect(calls).toHaveLength(1);
  });

  it("a concurrent request for a smaller amount shares the payment, as a recorded one would", async () => {
    const { calls, pay } = recorder(20);
    const scheme = new ExactBtcClientScheme(pay);
    const req = requirements();
    const [a, b] = await Promise.all([scheme.createPaymentPayload(2, req), scheme.createPaymentPayload(2, { ...req, amount: "999" })]);
    expect(b).toEqual(a);
    expect(calls).toHaveLength(1);
  });

  it("the file journal refuses a paymentId that is not one, since it names a file", async () => {
    await expect(new FilePaymentJournal(join(dir, "names.jsonl")).get("../../etc/passwd")).rejects.toThrow(/not a paymentId/);
  });
});

describe("requirements a buyer must refuse before paying", () => {
  const cases: [string, PaymentRequirements, RegExp][] = [
    ["asset other than BTC", requirements({}, { asset: "SAT" }), /asset must be "BTC"/],
    ["a non-integer amount", requirements({}, { amount: "1.5" }), /positive integer/],
    ["flow other than upfront", requirements({ paymentFlow: "authorization" }), /paymentFlow/],
    ["transfer method other than utxo", requirements({ assetTransferMethod: "eip3009" }), /assetTransferMethod/],
    ["no transfer method (the facilitator requires it)", requirements({ assetTransferMethod: undefined }), /assetTransferMethod/],
    ["no payment flow", requirements({ paymentFlow: undefined }), /paymentFlow/],
    ["minConfirmations 0", requirements({ minConfirmations: 0 }), /minConfirmations/],
    ["fractional minConfirmations", requirements({ minConfirmations: 1.5 }), /minConfirmations/],
    ["minConfirmations as a string", requirements({ minConfirmations: "1" }), /minConfirmations/],
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
