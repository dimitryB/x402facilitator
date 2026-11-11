/**
 * A record of Bitcoin payments by paymentId, so a buyer never pays the same 402 twice: not when the SDK
 * calls createPaymentPayload again, not when the buyer process restarts and resumes polling, and not when
 * several clients or processes share one journal.
 *
 * Before the wallet broadcasts, the client claims the paymentId: `claim` records a `paying` entry only if
 * the journal has nothing for it, atomically, so of any number of concurrent claims exactly one wins. After
 * the broadcast the entry is written again as `paid` with the txid. A `paying` entry without a `paid`
 * successor means another client is still paying, or a broadcast may have happened without being
 * recorded; the client scheme refuses to pay that paymentId again until a person looks.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { isPaymentId, type AddressType } from "./derive.js";
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
  /** Set when the payment was fabricated for a local test (no Bitcoin transaction exists). */
  stub?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface PaymentJournal {
  get(paymentId: string): Promise<JournalEntry | undefined>;
  put(entry: JournalEntry): Promise<void>;
  /**
   * Records `entry` only if the journal has nothing for `entry.paymentId`, and returns undefined: the caller
   * now owns the payment. Otherwise records nothing and returns the existing entry. Atomic for every client
   * that shares the journal: of concurrent claims for one paymentId, exactly one returns undefined.
   */
  claim(entry: JournalEntry): Promise<JournalEntry | undefined>;
}

/** One process only: share the same instance between clients that must not pay a paymentId twice. */
export class MemoryPaymentJournal implements PaymentJournal {
  private readonly entries = new Map<string, JournalEntry>();

  async get(paymentId: string): Promise<JournalEntry | undefined> {
    const e = this.entries.get(paymentId);
    return e ? structuredClone(e) : undefined;
  }

  async put(entry: JournalEntry): Promise<void> {
    this.entries.set(entry.paymentId, structuredClone(entry));
  }

  // No await between the check and the write, so no other claim can run in between.
  async claim(entry: JournalEntry): Promise<JournalEntry | undefined> {
    const existing = this.entries.get(entry.paymentId);
    if (existing) return structuredClone(existing);
    this.entries.set(entry.paymentId, structuredClone(entry));
    return undefined;
  }
}

/**
 * Append-only JSON lines; the last line for a paymentId wins. Each line is flushed to disk (fsync) before
 * `put` or `claim` returns, so a `paying` line is durable before the wallet broadcasts.
 *
 * `claim` first creates `<file>.claims/<paymentId>` exclusively (O_CREAT | O_EXCL): the filesystem lets
 * only one process create it, so only one client pays, whichever process or instance it runs in. The claim
 * file holds the claimed entry, so a client that stopped between the claim and the journal line still
 * blocks a second payment. Use a local filesystem: network filesystems may not honour O_EXCL.
 */
export class FilePaymentJournal implements PaymentJournal {
  constructor(readonly file: string) {}

  get claims(): string {
    return `${this.file}.claims`;
  }

  async get(paymentId: string): Promise<JournalEntry | undefined> {
    return this.all().get(paymentId) ?? this.claimed(paymentId);
  }

  async put(entry: JournalEntry): Promise<void> {
    mkdirSync(dirname(this.file), { recursive: true });
    writeDurably(this.file, "a", JSON.stringify(entry) + "\n");
  }

  async claim(entry: JournalEntry): Promise<JournalEntry | undefined> {
    const existing = await this.get(entry.paymentId);
    if (existing) return existing;
    mkdirSync(this.claims, { recursive: true, mode: 0o700 });
    try {
      writeDurably(this.claimPath(entry.paymentId), "wx", JSON.stringify(entry) + "\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another client claimed it first. Its claim file may still be empty while it writes: report the
      // paymentId as being paid, with this claim's terms, so the caller refuses to pay it.
      return (await this.get(entry.paymentId)) ?? { ...entry, status: "paying" };
    }
    await this.put(entry);
    return undefined;
  }

  /** The paymentId names a file, so it must be a paymentId: 32 lowercase hex characters, nothing else. */
  private claimPath(paymentId: string): string {
    if (!isPaymentId(paymentId)) throw new Error(`not a paymentId: ${JSON.stringify(paymentId)}`);
    return join(this.claims, paymentId);
  }

  /** Latest entry per paymentId, in first-seen order. Claims without a journal line are not included. */
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

  private claimed(paymentId: string): JournalEntry | undefined {
    const path = this.claimPath(paymentId);
    if (!existsSync(path)) return undefined;
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as JournalEntry;
      return entry.paymentId === paymentId ? entry : undefined;
    } catch {
      return undefined; // being written; claim() treats the file's existence as the claim
    }
  }
}

function writeDurably(path: string, flag: "a" | "wx", text: string): void {
  const fd = openSync(path, flag, 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
