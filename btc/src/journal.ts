/**
 * A record of Bitcoin payments by paymentId, so a buyer never pays the same 402 twice: not when the SDK
 * calls createPaymentPayload again, not when the buyer process restarts and resumes polling.
 *
 * An entry is written as `paying` before the wallet broadcasts and as `paid` with the txid after. A
 * `paying` entry without a `paid` successor means a broadcast may have happened without being recorded;
 * the client scheme refuses to pay that paymentId again until a person looks.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import type { AddressType } from "./derive.js";
import type { BtcNetwork } from "./networks.js";

export interface JournalEntry {
  paymentId: string;
  status: "paying" | "paid";
  network: BtcNetwork;
  payTo: string;
  addressType: AddressType;
  /** The derived payment address and its scriptPubKey (hex). */
  address: string;
  script: string;
  /** Satoshis paid. */
  amount: string;
  txid?: string;
  vout?: number;
  /** The requirements the payment answers (accepted), with this paymentId. */
  requirements: PaymentRequirements;
  /** The full payload sent in PAYMENT-SIGNATURE; the buyer adds it once x402Client has built it. */
  payment?: PaymentPayload;
  /** The paid resource's URL, for --resume. */
  url?: string;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentJournal {
  get(paymentId: string): Promise<JournalEntry | undefined>;
  put(entry: JournalEntry): Promise<void>;
}

export class MemoryPaymentJournal implements PaymentJournal {
  private readonly entries = new Map<string, JournalEntry>();

  async get(paymentId: string): Promise<JournalEntry | undefined> {
    const e = this.entries.get(paymentId);
    return e ? structuredClone(e) : undefined;
  }

  async put(entry: JournalEntry): Promise<void> {
    this.entries.set(entry.paymentId, structuredClone(entry));
  }
}

/** Append-only JSON lines; the last line for a paymentId wins. Synchronous appends keep the order on crash. */
export class FilePaymentJournal implements PaymentJournal {
  constructor(readonly file: string) {}

  async get(paymentId: string): Promise<JournalEntry | undefined> {
    return this.all().get(paymentId);
  }

  async put(entry: JournalEntry): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    appendFileSync(this.file, JSON.stringify(entry) + "\n", { mode: 0o600 });
  }

  /** Latest entry per paymentId, in first-seen order. */
  all(): Map<string, JournalEntry> {
    const out = new Map<string, JournalEntry>();
    if (!existsSync(this.file)) return out;
    for (const line of readFileSync(this.file, "utf8").split("\n")) {
      if (!line.trim()) continue;
      const entry = JSON.parse(line) as JournalEntry;
      out.set(entry.paymentId, entry);
    }
    return out;
  }
}
