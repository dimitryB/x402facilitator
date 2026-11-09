/**
 * ExactBtcClientScheme: the buyer side of `exact` on `bip122:*` for the x402 TS SDK.
 *
 *   new x402Client().register(BTC_MAINNET, new ExactBtcClientScheme(wallet, { journal }))
 *
 * createPaymentPayload pays on Bitcoin L1 (through the PayBtc callback or a BtcWallet) to the address
 * derived from `payTo` and `extra.paymentId`, and returns `{ txid, vout }`. The payment is real and
 * irreversible, so the scheme journals it by paymentId: a second call for the same paymentId returns the
 * recorded output instead of paying again. Concurrent calls for one paymentId share one payment.
 *
 * The facilitator can accept the payload only once hVM sees the transaction with enough confirmations,
 * so the buyer re-sends the same payload until then (buyer/btc-l1.ts). Do not use wrapFetchWithPayment
 * with this scheme: it creates a payload per 402 and gives up after one retry.
 */
import type { PaymentPayloadContext, PaymentPayloadResult, PaymentRequirements, SchemeNetworkClient } from "@x402/core/types";
import { derivePaymentAddress, DEFAULT_ADDRESS_TYPE, isAddressType, isPaymentId, type AddressType } from "./derive.js";
import { MemoryPaymentJournal, type JournalEntry, type PaymentJournal } from "./journal.js";
import { BTC_ASSET, isBtcNetwork, UTXO_TRANSFER_METHOD, type BtcNetwork } from "./networks.js";

export interface PayBtcContext {
  network: BtcNetwork;
  paymentId: string;
  addressType: AddressType;
  /** scriptPubKey of the payment address, hex. */
  script: string;
  requirements: PaymentRequirements;
}

/** The output that pays the seller: Bitcoin txid in display byte order (64 lowercase hex) and its index. */
export interface BtcOutputRef {
  txid: string;
  vout: number;
}

/** Pay exactly `sats` to `address` in one output and return that output. Broadcasting is the callee's job. */
export type PayBtc = (address: string, sats: bigint, ctx: PayBtcContext) => Promise<BtcOutputRef>;

export interface BtcPayer {
  pay: PayBtc;
}

export interface ExactBtcClientSchemeOptions {
  journal?: PaymentJournal;
  /** Hard per-payment cap in satoshis, on top of the SDK's spendControls. */
  maxSats?: bigint;
}

const SATS = /^[1-9]\d*$/;
const TXID = /^[0-9a-f]{64}$/;

export function isTxid(value: unknown): value is string {
  return typeof value === "string" && TXID.test(value);
}

export function isVout(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 0xffffffff;
}

/** The exact bip122 payload. */
export function btcPayload(ref: BtcOutputRef): { txid: string; vout: number } {
  if (!isTxid(ref.txid)) throw new Error(`txid must be 64 lowercase hex chars (display order), got ${JSON.stringify(ref.txid)}`);
  if (!isVout(ref.vout)) throw new Error(`vout must be a non-negative integer, got ${JSON.stringify(ref.vout)}`);
  return { txid: ref.txid, vout: ref.vout };
}

export interface CheckedBtcRequirements {
  network: BtcNetwork;
  paymentId: string;
  addressType: AddressType;
  sats: bigint;
}

/** Everything a buyer must check in a bip122 accept before paying it. Throws with the reason. */
export function checkBtcRequirements(requirements: PaymentRequirements): CheckedBtcRequirements {
  const { network, asset, amount, extra } = requirements;
  if (requirements.scheme !== "exact") throw new Error(`scheme must be "exact", got ${JSON.stringify(requirements.scheme)}`);
  if (!isBtcNetwork(network)) throw new Error(`not a supported Bitcoin network: ${network}`);
  if (asset !== BTC_ASSET) throw new Error(`asset must be "${BTC_ASSET}", got ${JSON.stringify(asset)}`);
  if (!SATS.test(amount)) throw new Error(`amount must be a positive integer of satoshis, got ${JSON.stringify(amount)}`);
  const atm = extra?.assetTransferMethod ?? UTXO_TRANSFER_METHOD;
  if (atm !== UTXO_TRANSFER_METHOD) throw new Error(`extra.assetTransferMethod must be "${UTXO_TRANSFER_METHOD}", got ${JSON.stringify(atm)}`);
  const flow = extra?.paymentFlow ?? "upfront";
  if (flow !== "upfront") throw new Error(`extra.paymentFlow must be "upfront", got ${JSON.stringify(flow)}`);
  if (!isPaymentId(extra?.paymentId)) throw new Error(`extra.paymentId must be 32 lowercase hex chars, got ${JSON.stringify(extra?.paymentId)}`);
  const addressType = extra?.addressType ?? DEFAULT_ADDRESS_TYPE;
  if (!isAddressType(addressType)) throw new Error(`extra.addressType ${JSON.stringify(addressType)} is not supported`);
  return { network, paymentId: extra.paymentId as string, addressType, sats: BigInt(amount) };
}

export class ExactBtcClientScheme implements SchemeNetworkClient {
  readonly scheme = "exact";
  readonly journal: PaymentJournal;
  private readonly pay: PayBtc;
  private readonly maxSats?: bigint;
  private readonly inflight = new Map<string, Promise<BtcOutputRef>>();

  constructor(payer: PayBtc | BtcPayer, options: ExactBtcClientSchemeOptions = {}) {
    this.pay = typeof payer === "function" ? payer : (address, sats, ctx) => payer.pay(address, sats, ctx);
    this.journal = options.journal ?? new MemoryPaymentJournal();
    this.maxSats = options.maxSats;
  }

  async createPaymentPayload(
    x402Version: number,
    requirements: PaymentRequirements,
    context?: PaymentPayloadContext,
  ): Promise<PaymentPayloadResult> {
    if (x402Version !== 2) throw new Error(`exact on bip122 is x402 v2 only, got version ${x402Version}`);
    const checked = checkBtcRequirements(requirements);
    if (context?.maxAmountPerPayment !== undefined && checked.sats > BigInt(context.maxAmountPerPayment)) {
      throw new Error(`amount ${checked.sats} sats exceeds the spend cap ${context.maxAmountPerPayment}`);
    }
    if (this.maxSats !== undefined && checked.sats > this.maxSats) {
      throw new Error(`amount ${checked.sats} sats exceeds this client's cap of ${this.maxSats}`);
    }
    let pending = this.inflight.get(checked.paymentId);
    if (!pending) {
      pending = this.payOnce(requirements, checked).finally(() => this.inflight.delete(checked.paymentId));
      this.inflight.set(checked.paymentId, pending);
    }
    return { x402Version, payload: btcPayload(await pending) };
  }

  private async payOnce(requirements: PaymentRequirements, c: CheckedBtcRequirements): Promise<BtcOutputRef> {
    const derived = derivePaymentAddress(requirements.payTo, c.network, c.paymentId, c.addressType);
    const existing = await this.journal.get(c.paymentId);
    if (existing) return this.recorded(existing, derived.address, c);

    const now = new Date().toISOString();
    const entry: JournalEntry = {
      paymentId: c.paymentId,
      status: "paying",
      network: c.network,
      payTo: requirements.payTo,
      addressType: c.addressType,
      address: derived.address,
      script: derived.script,
      amount: c.sats.toString(),
      requirements: structuredClone(requirements),
      createdAt: now,
      updatedAt: now,
    };
    await this.journal.put(entry);
    const ref = btcPayload(
      await this.pay(derived.address, c.sats, {
        network: c.network,
        paymentId: c.paymentId,
        addressType: c.addressType,
        script: derived.script,
        requirements,
      }),
    );
    await this.journal.put({ ...entry, status: "paid", txid: ref.txid, vout: ref.vout, updatedAt: new Date().toISOString() });
    return ref;
  }

  private recorded(entry: JournalEntry, address: string, c: CheckedBtcRequirements): BtcOutputRef {
    if (entry.network !== c.network || entry.address !== address || BigInt(entry.amount) < c.sats) {
      throw new Error(
        `paymentId ${c.paymentId} is already in the journal for another payment ` +
          `(${entry.amount} sats to ${entry.address} on ${entry.network}); refusing to pay it again`,
      );
    }
    if (entry.status !== "paid" || entry.txid === undefined || entry.vout === undefined) {
      throw new Error(
        `paymentId ${c.paymentId} was started at ${entry.createdAt} but never recorded as paid; the transaction ` +
          `may have been broadcast. Check the wallet's transactions to ${entry.address} before doing anything else.`,
      );
    }
    return { txid: entry.txid, vout: entry.vout };
  }
}
