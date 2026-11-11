/**
 * The audit's R03: before the wallet broadcasts, a first claim must have flushed not only its files but
 * the directory entries that name them, including directories it created; otherwise a power loss can drop
 * the record and a restart pays again. node:fs is wrapped to record each fsync by path and to fail one,
 * and to cut a write short as a full disk does (R06).
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import vectors from "../test-vectors.json" with { type: "json" };
import { ExactBtcClientScheme, type PayBtc } from "../src/client.js";
import { newPaymentId } from "../src/derive.js";
import { FilePaymentJournal } from "../src/journal.js";
import { BTC_MAINNET } from "../src/networks.js";

const fsState = vi.hoisted(() => ({
  fsynced: [] as string[],
  paths: new Map<number, string>(),
  failing: undefined as string | undefined,
  short: undefined as string | undefined,
}));

vi.mock("node:fs", async importOriginal => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    openSync: ((path: string, ...rest: never[]) => {
      const fd = (real.openSync as (...a: unknown[]) => number)(path, ...rest);
      fsState.paths.set(fd, String(path));
      return fd;
    }) as typeof real.openSync,
    fsyncSync: (fd: number) => {
      const path = fsState.paths.get(fd) ?? `fd ${fd}`;
      if (path === fsState.failing) throw Object.assign(new Error(`EIO: i/o error, fsync '${path}'`), { code: "EIO" });
      real.fsyncSync(fd);
      fsState.fsynced.push(path);
    },
    writeSync: ((fd: number, data: Uint8Array, ...rest: never[]) => {
      if (fsState.paths.get(fd) !== fsState.short || !(data instanceof Uint8Array) || data.length < 2) {
        return (real.writeSync as (...a: unknown[]) => number)(fd, data, ...rest);
      }
      return real.writeSync(fd, data, 0, Math.floor(data.length / 2));
    }) as typeof real.writeSync,
  };
});

const base = realpathSync(mkdtempSync(join(tmpdir(), "btc-durable-")));
afterAll(() => rmSync(base, { recursive: true, force: true }));
beforeEach(() => {
  fsState.fsynced.length = 0;
  fsState.failing = undefined;
  fsState.short = undefined;
});

function requirements(): PaymentRequirements {
  return {
    scheme: "exact",
    network: BTC_MAINNET,
    asset: "BTC",
    amount: "1000",
    payTo: vectors.vectors.find(v => v.network === BTC_MAINNET)!.payTo,
    maxTimeoutSeconds: 3600,
    extra: { assetTransferMethod: "utxo", paymentFlow: "upfront", paymentId: newPaymentId() },
  };
}

/** A wallet that records, at the moment it would broadcast, what had been flushed. */
function wallet() {
  const flushedBeforePaying: string[][] = [];
  const pay: PayBtc = async () => {
    flushedBeforePaying.push([...fsState.fsynced]);
    return { txid: "1".padStart(64, "0"), vout: 0 };
  };
  return { flushedBeforePaying, pay };
}

describe("FilePaymentJournal durability before a broadcast", () => {
  it("a first claim into new directories flushes every new name before the wallet is called", async () => {
    const file = join(base, "new", "nested", "journal.jsonl");
    const req = requirements();
    const { flushedBeforePaying, pay } = wallet();
    await new ExactBtcClientScheme(pay, { journal: new FilePaymentJournal(file) }).createPaymentPayload(2, req);
    expect(flushedBeforePaying).toHaveLength(1);
    const flushed = flushedBeforePaying[0]!;
    for (const path of [
      file, // the journal's contents
      `${file}.claims/${req.extra.paymentId}`, // the claim's contents
      `${file}.claims`, // the claim file's name
      join(base, "new", "nested"), // the journal's and the claims directory's names
      join(base, "new"), // "nested"
      base, // "new"
    ]) {
      expect(flushed, path).toContain(path);
    }
  });

  it("a later claim in the same journal still flushes its claim file's name and the claims directory's", async () => {
    const file = join(base, "existing.jsonl");
    const { pay } = wallet();
    await new ExactBtcClientScheme(pay, { journal: new FilePaymentJournal(file) }).createPaymentPayload(2, requirements());
    fsState.fsynced.length = 0;
    const second = wallet();
    await new ExactBtcClientScheme(second.pay, { journal: new FilePaymentJournal(file) }).createPaymentPayload(2, requirements());
    expect(second.flushedBeforePaying[0]).toEqual(expect.arrayContaining([`${file}.claims`, base, file]));
  });

  for (const [what, failing] of [
    ["the claims directory", (file: string) => `${file}.claims`],
    ["the journal's new directory", (file: string) => dirname(file)],
    ["the directory above a new one", () => base],
  ] as const) {
    it(`a failed fsync of ${what} stops the payment: the wallet is never called`, async () => {
      const file = join(base, `fail-${newPaymentId()}`, "journal.jsonl");
      fsState.failing = failing(file);
      const { flushedBeforePaying, pay } = wallet();
      await expect(new ExactBtcClientScheme(pay, { journal: new FilePaymentJournal(file) }).createPaymentPayload(2, requirements())).rejects.toThrow(/EIO/);
      expect(flushedBeforePaying).toEqual([]);
    });
  }

  for (const [what, short] of [
    ["the claim file", (file: string, paymentId: string) => `${file}.claims/${paymentId}`],
    ["the journal line", (file: string) => file],
  ] as const) {
    it(`a short write of ${what} (a full disk) stops the payment, and the paymentId stays claimed`, async () => {
      const file = join(base, `short-${newPaymentId()}.jsonl`);
      const req = requirements();
      fsState.short = short(file, req.extra.paymentId as string);
      const { flushedBeforePaying, pay } = wallet();
      const journal = new FilePaymentJournal(file);
      await expect(new ExactBtcClientScheme(pay, { journal }).createPaymentPayload(2, req)).rejects.toThrow(/short write/);
      expect(flushedBeforePaying).toEqual([]);
      fsState.short = undefined;
      await expect(new ExactBtcClientScheme(pay, { journal }).createPaymentPayload(2, req)).rejects.toThrow(/not recorded as paid/);
      expect(flushedBeforePaying).toEqual([]);
    });
  }
});
