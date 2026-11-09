/** Wallet tests. No network: Esplora is a fake fetch, and nothing is broadcast anywhere. */
import { describe, expect, it } from "vitest";
import { Transaction } from "@scure/btc-signer";
import vectors from "../test-vectors.json" with { type: "json" };
import { BtcWallet, EsploraClient, selectLargestFirst, VSIZE, type Utxo } from "../src/wallet.js";
import { BTC_MAINNET, BTC_TESTNET3 } from "../src/networks.js";

const MNEMONIC = vectors.mnemonic;
/** The vector address for the DESIGN.md xpub and paymentId (p2wpkh, mainnet). */
const PAY_TO_ADDRESS = vectors.vectors[0].address;
const P2WPKH = { input: VSIZE.input.p2wpkh, paymentOutput: 31, changeOutput: 31 };
const utxo = (byte: string, value: number, vout = 0, confirmed = true): Utxo => ({ txid: byte.repeat(32), vout, value, status: { confirmed } });

/** Esplora stand-in: answers from tables and records POSTs. */
function fakeEsplora(utxos: Utxo[], fees: Record<string, number> = { "1": 20, "3": 5.04, "6": 3 }) {
  const posted: string[] = [];
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const u = String(url);
    if (init?.method === "POST" && u.endsWith("/tx")) {
      posted.push(String(init.body));
      return new Response(Transaction.fromRaw(Buffer.from(String(init.body), "hex")).id);
    }
    if (u.endsWith("/fee-estimates")) return Response.json(fees);
    if (u.includes("/utxo")) return Response.json(utxos);
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { esplora: new EsploraClient("https://esplora.test/api", fetchImpl), posted };
}

describe("keys and addresses", () => {
  it("BIP84 and BIP86 test vectors from the test mnemonic", () => {
    expect(BtcWallet.fromMnemonic(MNEMONIC, BTC_MAINNET).address).toBe("bc1qcr8te4kr609gcawutmrza0j4xv80jy8z306fyu");
    expect(BtcWallet.fromMnemonic(MNEMONIC, BTC_MAINNET, { addressType: "p2tr" }).address).toBe(
      "bc1p5cyxnuxmeuwuvkwfem96lqzszd02n6xdcjrs20cac6yqjjwudpxqkedrcr",
    );
    expect(BtcWallet.fromMnemonic(MNEMONIC, BTC_TESTNET3).address).toMatch(/^tb1q/);
  });

  it("WIF of private key 1 is the BIP173 example address", () => {
    expect(BtcWallet.fromWif("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn", BTC_MAINNET).address).toBe(
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    );
  });

  it("a mainnet WIF is refused on testnet3, and a bad mnemonic is refused", () => {
    expect(() => BtcWallet.fromWif("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn", BTC_TESTNET3)).toThrow(/testnet3 WIF/);
    expect(() => BtcWallet.fromMnemonic("abandon abandon abandon", BTC_MAINNET)).toThrow(/not a valid BIP39/);
  });
});

describe("largest-first coin selection", () => {
  it("takes the biggest UTXO first and returns change", () => {
    const sel = selectLargestFirst([utxo("aa", 2_000), utxo("bb", 50_000), utxo("cc", 10_000)], 1_000n, 2, P2WPKH, 294n);
    expect(sel.inputs.map(u => u.value)).toEqual([50_000]);
    expect(sel.fee).toBe(282n); // 2 sat/vB * (11 + 68 + 31 + 31)
    expect(sel.change).toBe(50_000n - 1_000n - 282n);
  });

  it("adds inputs until the payment and its fee are covered", () => {
    const sel = selectLargestFirst([utxo("aa", 800), utxo("bb", 700), utxo("cc", 600)], 1_500n, 1, P2WPKH, 294n);
    expect(sel.inputs.map(u => u.value)).toEqual([800, 700, 600]);
    expect(sel.fee + sel.change + 1_500n).toBe(2_100n);
  });

  it("a remainder below dust goes to the fee instead of a change output", () => {
    const sel = selectLargestFirst([utxo("aa", 1_400)], 1_000n, 1, P2WPKH, 294n);
    expect(sel).toMatchObject({ change: 0n, fee: 400n, vsize: 110 });
  });

  it("refuses when funds do not cover payment plus fee", () => {
    expect(() => selectLargestFirst([utxo("aa", 1_000)], 1_000n, 1, P2WPKH, 294n)).toThrow(/insufficient funds: 1000 sats in 1/);
    expect(() => selectLargestFirst([], 1_000n, 1, P2WPKH, 294n)).toThrow(/insufficient funds/);
  });
});

describe("building and signing", () => {
  for (const addressType of ["p2wpkh", "p2tr"] as const) {
    it(`${addressType}: output 0 pays the seller, output 1 is change to self, fee as selected`, () => {
      const wallet = BtcWallet.fromMnemonic(MNEMONIC, BTC_MAINNET, { addressType });
      const p = wallet.buildPaymentFrom([utxo("aa", 50_000, 2), utxo("bb", 3_000)], PAY_TO_ADDRESS, 1_000n, 2);
      const tx = Transaction.fromRaw(Buffer.from(p.hex, "hex"));
      expect(tx.id).toBe(p.txid);
      expect(p.txid).toMatch(/^[0-9a-f]{64}$/);
      expect(tx.inputsLength).toBe(1);
      expect(tx.getOutput(0)).toMatchObject({ amount: 1_000n });
      expect(Buffer.from(tx.getOutput(0).script!).toString("hex")).toBe(vectors.vectors[0].scriptPubKey);
      expect(Buffer.from(tx.getOutput(1).script!)).toEqual(Buffer.from(wallet.script));
      expect(tx.getOutput(1).amount).toBe(p.change);
      expect(p.change + p.fee + 1_000n).toBe(50_000n);
      expect(p.vout).toBe(0);
      // The estimate assumes maximum-size signatures, so the real tx is never smaller in fee rate.
      expect(Number(p.fee) / p.vsize).toBeGreaterThanOrEqual(2);
    });
  }

  it("refuses a payment below dust", () => {
    const wallet = BtcWallet.fromMnemonic(MNEMONIC, BTC_MAINNET);
    expect(() => wallet.buildPaymentFrom([utxo("aa", 50_000)], PAY_TO_ADDRESS, 293n, 1)).toThrow(/dust/);
  });

  it("refuses an address of the other network", () => {
    const wallet = BtcWallet.fromMnemonic(MNEMONIC, BTC_TESTNET3);
    expect(() => wallet.buildPaymentFrom([utxo("aa", 50_000)], PAY_TO_ADDRESS, 1_000n, 1)).toThrow();
  });
});

describe("pay through Esplora (faked)", () => {
  it("uses the 3-block estimate, skips unconfirmed UTXOs, broadcasts once, returns { txid, vout: 0 }", async () => {
    const { esplora, posted } = fakeEsplora([utxo("aa", 9_000_000, 0, false), utxo("bb", 60_000)]);
    const logs: string[] = [];
    const wallet = BtcWallet.fromMnemonic(MNEMONIC, BTC_MAINNET, { esplora, log: m => logs.push(m) });
    const out = await wallet.pay(PAY_TO_ADDRESS, 1_000n);
    expect(posted).toHaveLength(1);
    const tx = Transaction.fromRaw(Buffer.from(posted[0], "hex"));
    expect(out).toEqual({ txid: tx.id, vout: 0 });
    expect(Buffer.from(tx.getInput(0).txid!).toString("hex")).toBe("bb".repeat(32));
    expect(tx.getOutput(1).amount).toBe(60_000n - 1_000n - 720n); // ceil(5.1 sat/vB * 141 vB)
    expect(logs[0]).toContain(`sending 1000 sats to ${PAY_TO_ADDRESS}`);
    expect(logs[0]).toMatch(/fee 720 sats/);
  });

  it("refuses a fee rate above the cap", async () => {
    const { esplora, posted } = fakeEsplora([utxo("bb", 60_000)], { "1": 900, "3": 450 });
    const wallet = BtcWallet.fromMnemonic(MNEMONIC, BTC_MAINNET, { esplora });
    await expect(wallet.pay(PAY_TO_ADDRESS, 1_000n)).rejects.toThrow(/above the cap of 200 sat\/vB/);
    expect(posted).toEqual([]);
  });

  it("a fixed --fee-rate overrides the estimate", async () => {
    const { esplora } = fakeEsplora([utxo("bb", 60_000)]);
    const wallet = BtcWallet.fromMnemonic(MNEMONIC, BTC_MAINNET, { esplora, feeRate: 1 });
    expect(await wallet.resolveFeeRate()).toBe(1);
    const p = await wallet.buildPayment(PAY_TO_ADDRESS, 1_000n);
    expect(p.fee).toBe(141n);
  });

  it("refuses to pay for a requirement on another network", async () => {
    const { esplora } = fakeEsplora([utxo("bb", 60_000)]);
    const wallet = BtcWallet.fromMnemonic(MNEMONIC, BTC_MAINNET, { esplora });
    await expect(
      wallet.pay(PAY_TO_ADDRESS, 1_000n, { network: BTC_TESTNET3, paymentId: "0".repeat(32), addressType: "p2wpkh", script: "", requirements: {} as never }),
    ).rejects.toThrow(/wallet is on/);
  });
});
