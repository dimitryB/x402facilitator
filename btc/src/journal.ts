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
import { closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, readSync, realpathSync, statSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
 * `claim` first creates `<journal>.claims/<paymentId>` exclusively (O_CREAT | O_EXCL): the filesystem lets
 * only one process create it, so only one client pays, whichever process or instance it runs in. The claim
 * file holds the claimed entry, so a client that stopped between the claim and the journal line still
 * blocks a second payment.
 *
 * `<journal>` is the journal's real path, with every symlink resolved, so clients that open one journal
 * by different paths (a symlink to it or to a directory above it) share one claims directory. Hard links
 * cannot be told apart that way: `claim` refuses a journal file with more than one.
 *
 * Before `claim` returns, the claim file, the journal and the directory entries that name them, including
 * any directory it created, are flushed to disk, so a power loss after the broadcast cannot lose the
 * record and pay again on restart. Directories that already existed are taken to be durable. Use a local
 * filesystem: network filesystems may not honour O_EXCL or a directory fsync. On macOS, fsync reaches the
 * drive but not necessarily past its write cache; Windows cannot fsync a directory, so there only files
 * are flushed.
 *
 * Each entry is appended with one write that ends in a newline. An append that stopped part way (a crash,
 * a power loss, a full disk) leaves the start of a line without its newline: readers skip it, and the next
 * append starts with a newline, so that line never joins a later entry. The stopped client's claim file
 * still blocks a second payment of its paymentId, and `get` returns that payment's last whole line, or its
 * claim.
 */
export class FilePaymentJournal implements PaymentJournal {
  constructor(readonly file: string) {}

  /** The claims directory, beside the journal's real path. */
  get claims(): string {
    return `${realPath(this.file)}.claims`;
  }

  async get(paymentId: string): Promise<JournalEntry | undefined> {
    return this.all().get(paymentId) ?? this.claimed(paymentId);
  }

  async put(entry: JournalEntry): Promise<void> {
    this.create();
    appendLine(this.file, JSON.stringify(entry));
  }

  async claim(entry: JournalEntry): Promise<JournalEntry | undefined> {
    const existing = await this.get(entry.paymentId);
    if (existing) return existing;
    const journal = this.create();
    const links = statSync(journal).nlink;
    if (links > 1) {
      throw new Error(
        `the journal ${journal} has ${links} hard links: claims are kept beside one path, so two clients opening it by ` +
          `different links could both pay. Open it by one path (a symlink is fine) and remove the other links`,
      );
    }
    const claims = `${journal}.claims`;
    mkdirDurably(claims, 0o700);
    try {
      writeDurably(join(claims, checkedPaymentId(entry.paymentId)), "wx", JSON.stringify(entry) + "\n");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      // Another client claimed it first. Its claim file may still be empty while it writes: report the
      // paymentId as being paid, with this claim's terms, so the caller refuses to pay it.
      return (await this.get(entry.paymentId)) ?? { ...entry, status: "paying" };
    }
    // The claim file's name, and the claims directory's own, must be on disk before the wallet broadcasts.
    fsyncDir(claims);
    fsyncDir(dirname(claims));
    await this.put(entry);
    return undefined;
  }

  /** Creates the journal file if it is missing, durably, and returns its real path. */
  private create(): string {
    if (!existsSync(this.file)) {
      mkdirDurably(dirname(this.file));
      writeDurably(this.file, "a", "");
      fsyncDir(dirname(realpathSync(this.file)));
    }
    return realpathSync(this.file);
  }

  /** Latest entry per paymentId, in first-seen order. Claims without a journal line are not included. */
  all(): Map<string, JournalEntry> {
    const out = new Map<string, JournalEntry>();
    if (!existsSync(this.file)) return out;
    const lines = readFileSync(this.file, "utf8").split("\n");
    // Text after the last newline is not an entry yet: a line another client is still writing, which a read
    // can catch half done, or one whose writer stopped. Either client's claim file already exists, so leaving
    // the line out cannot let a second client pay.
    lines.pop();
    for (const line of lines) {
      const entry = parseEntry(line);
      if (entry) out.set(entry.paymentId, entry);
    }
    return out;
  }

  private claimed(paymentId: string): JournalEntry | undefined {
    const path = join(this.claims, checkedPaymentId(paymentId));
    if (!existsSync(path)) return undefined;
    try {
      const entry = JSON.parse(readFileSync(path, "utf8")) as JournalEntry;
      return entry.paymentId === paymentId ? entry : undefined;
    } catch {
      return undefined; // being written; claim() treats the file's existence as the claim
    }
  }
}

/**
 * A journal line as an entry. Undefined for a blank line, and for the start of an append whose writer stopped,
 * which the next append ended with its leading newline (appendLine).
 */
function parseEntry(line: string): JournalEntry | undefined {
  if (!line.trim()) return undefined;
  let entry: Partial<JournalEntry> | null;
  try {
    entry = JSON.parse(line) as Partial<JournalEntry> | null;
  } catch {
    return undefined;
  }
  const whole = typeof entry?.paymentId === "string" && (entry.status === "paying" || entry.status === "paid");
  return whole ? (entry as JournalEntry) : undefined;
}

/** The paymentId names a file, so it must be a paymentId: 32 lowercase hex characters, nothing else. */
function checkedPaymentId(paymentId: string): string {
  if (!isPaymentId(paymentId)) throw new Error(`not a paymentId: ${JSON.stringify(paymentId)}`);
  return paymentId;
}

/** The path `file` names with every symlink resolved, also while it, or a directory above it, does not exist. */
function realPath(file: string, hops = 0): string {
  try {
    return realpathSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const path = resolve(file);
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    if (hops >= 40) throw new Error(`too many levels of symbolic links: ${file}`);
    return realPath(resolve(dirname(path), readlinkSync(path)), hops + 1);
  }
  const parent = dirname(path);
  return parent === path ? path : join(realPath(parent, hops), basename(path));
}

/** Creates `dir` and its missing parents, and flushes the directory entry of each one it creates. */
function mkdirDurably(dir: string, mode?: number): void {
  const missing: string[] = [];
  for (let d = resolve(dir); !existsSync(d); d = dirname(d)) missing.unshift(d);
  if (missing.length === 0) return;
  mkdirSync(dir, { recursive: true, mode });
  for (const d of missing) fsyncDir(dirname(realpathSync(d)));
}

/** Flushes a directory's entries (names of files created in it) to disk. Windows cannot open a directory. */
function fsyncDir(dir: string): void {
  if (process.platform === "win32") return;
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function writeDurably(path: string, flag: "a" | "wx", text: string): void {
  const fd = openSync(path, flag, 0o600);
  try {
    writeAll(fd, path, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Appends `line` and its newline in one write, and flushes it. A local filesystem applies each append whole,
 * after any other, so appends from several clients never interleave. A file that does not end in a newline
 * holds the start of an append whose writer stopped, or one this client caught half done: the write then
 * starts with a newline, so its own line stays whole. If that other writer was still writing, its append
 * lands whole before this one, and the extra newline leaves only a blank line.
 */
function appendLine(path: string, line: string): void {
  const fd = openSync(path, "a+", 0o600);
  try {
    const size = fstatSync(fd).size;
    const last = Buffer.alloc(1);
    const ended = size === 0 || (readSync(fd, last, 0, 1, size - 1) === 1 && last[0] === 0x0a);
    writeAll(fd, path, (ended ? "" : "\n") + line + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Writes all of `text` with one write. A short write (a full disk) throws: writing the rest with a second
 * append could land after another client's line.
 */
function writeAll(fd: number, path: string, text: string): void {
  const bytes = Buffer.from(text, "utf8");
  const written = writeSync(fd, bytes);
  if (written !== bytes.length) throw new Error(`short write to ${path}: ${written} of ${bytes.length} bytes`);
}
