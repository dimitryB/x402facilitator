/**
 * A minimal single-key Bitcoin wallet for the demo buyer: one p2wpkh or p2tr address from a WIF or a
 * BIP39 mnemonic, UTXOs and broadcast through an Esplora API (mempool.space), largest-first coin selection,
 * change back to the same address, signing with @scure/btc-signer.
 *
 * The only network write is EsploraClient.broadcast, called from BtcWallet.pay. Everything else reads.
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { Address, OutScript, Transaction, WIF } from "@scure/btc-signer";
import type { BtcOutputRef, BtcPayer, PayBtcContext } from "./client.js";
import { DEFAULT_ADDRESS_TYPE, isAddressType, scriptForPubkey, type AddressType } from "./derive.js";
import { BTC_NETWORKS, type BtcNetwork } from "./networks.js";

export interface Utxo {
  txid: string;
  vout: number;
  /** Satoshis. */
  value: number;
  status?: { confirmed: boolean; block_height?: number };
}

export interface TxStatus {
  confirmed: boolean;
  block_height?: number;
  block_hash?: string;
}

/** The Esplora REST API as mempool.space serves it (https://mempool.space/docs/api/rest). */
export class EsploraClient {
  constructor(
    readonly base: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  static for(network: BtcNetwork, fetchImpl: typeof fetch = fetch): EsploraClient {
    return new EsploraClient(BTC_NETWORKS[network].esplora, fetchImpl);
  }

  private async get(path: string): Promise<Response> {
    const res = await this.fetchImpl(`${this.base}${path}`);
    if (!res.ok) throw new Error(`GET ${this.base}${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
    return res;
  }

  async utxos(address: string): Promise<Utxo[]> {
    return (await this.get(`/address/${address}/utxo`)).json() as Promise<Utxo[]>;
  }

  /** Target blocks -> sat/vB. */
  async feeEstimates(): Promise<Record<string, number>> {
    return (await this.get("/fee-estimates")).json() as Promise<Record<string, number>>;
  }

  /** The estimate for the largest target <= `targetBlocks` (rounded up to 0.1 sat/vB), at least 1 sat/vB. */
  async feeRate(targetBlocks = 3): Promise<number> {
    const estimates = await this.feeEstimates();
    const keys = Object.keys(estimates).map(Number).filter(k => k <= targetBlocks).sort((a, b) => b - a);
    const rate = keys.length > 0 ? estimates[String(keys[0])] : Math.max(...Object.values(estimates));
    return Math.max(1, Math.ceil(rate * 10) / 10);
  }

  async txStatus(txid: string): Promise<TxStatus> {
    return (await this.get(`/tx/${txid}/status`)).json() as Promise<TxStatus>;
  }

  async tipHeight(): Promise<number> {
    return Number(await (await this.get("/blocks/tip/height")).text());
  }

  /** POST /tx: the one write. Returns the txid Esplora reports. */
  async broadcast(hex: string): Promise<string> {
    const res = await this.fetchImpl(`${this.base}/tx`, { method: "POST", body: hex, headers: { "content-type": "text/plain" } });
    const text = (await res.text()).trim();
    if (!res.ok) throw new Error(`broadcast rejected by ${this.base}: ${res.status} ${text.slice(0, 300)}`);
    return text;
  }
}

/** Virtual sizes used for fee estimation (BIP141 weights, signatures at their maximum size). */
export const VSIZE = {
  /** version, locktime, counts, segwit marker and flag. */
  overhead: 11,
  input: { p2wpkh: 68, p2tr: 58 } satisfies Record<AddressType, number>,
  /** value (8) + script length (1) + script. */
  output: (scriptLength: number) => 9 + scriptLength,
};

/** Outputs below this are non-standard (Bitcoin Core's dust relay limit at 3 sat/vB). */
export const DUST = { p2wpkh: 294n, p2tr: 330n } satisfies Record<AddressType, bigint>;

export interface CoinSelection {
  inputs: Utxo[];
  fee: bigint;
  /** 0 when the remainder is below dust and goes to the miner instead. */
  change: bigint;
  vsize: number;
}

/**
 * Largest-first: take UTXOs from the biggest down until they cover `sats` plus the fee at `feeRate`.
 * Change goes back to the wallet when it is at least `dust`; otherwise it is added to the fee.
 */
export function selectLargestFirst(
  utxos: readonly Utxo[],
  sats: bigint,
  feeRate: number,
  sizes: { input: number; paymentOutput: number; changeOutput: number },
  dust: bigint,
): CoinSelection {
  if (sats <= 0n) throw new Error("amount must be positive");
  if (!(feeRate > 0)) throw new Error("fee rate must be positive");
  const sorted = [...utxos].sort((a, b) => b.value - a.value || a.txid.localeCompare(b.txid) || a.vout - b.vout);
  const feeFor = (vsize: number) => BigInt(Math.ceil(vsize * feeRate));
  const inputs: Utxo[] = [];
  let total = 0n;
  for (const utxo of sorted) {
    inputs.push(utxo);
    total += BigInt(utxo.value);
    const base = VSIZE.overhead + inputs.length * sizes.input + sizes.paymentOutput;
    const feeNoChange = feeFor(base);
    if (total < sats + feeNoChange) continue;
    const withChange = base + sizes.changeOutput;
    const change = total - sats - feeFor(withChange);
    if (change >= dust) return { inputs, fee: feeFor(withChange), change, vsize: withChange };
    return { inputs, fee: total - sats, change: 0n, vsize: base };
  }
  const need = sats + feeFor(VSIZE.overhead + Math.max(1, inputs.length) * sizes.input + sizes.paymentOutput);
  throw new Error(`insufficient funds: ${total} sats in ${utxos.length} spendable UTXOs, need about ${need} sats at ${feeRate} sat/vB`);
}

export interface SignedPayment {
  hex: string;
  txid: string;
  /** The output paying the seller; always 0 (change, if any, is output 1). */
  vout: number;
  fee: bigint;
  change: bigint;
  vsize: number;
  inputs: Utxo[];
}

export interface BtcWalletOptions {
  addressType?: AddressType;
  esplora?: EsploraClient;
  /** sat/vB. Default: Esplora's estimate for `feeTargetBlocks`. */
  feeRate?: number;
  feeTargetBlocks?: number;
  /** Refuse to pay more than this rate (default 200 sat/vB), whatever the estimate says. */
  maxFeeRate?: number;
  /** Spend unconfirmed UTXOs too (default false: confirmed only). */
  allowUnconfirmed?: boolean;
  log?: (message: string) => void;
}

export class BtcWallet implements BtcPayer {
  readonly network: BtcNetwork;
  readonly addressType: AddressType;
  readonly address: string;
  readonly script: Uint8Array;
  readonly esplora: EsploraClient;
  private readonly privateKey: Uint8Array;
  private readonly options: BtcWalletOptions;

  private constructor(privateKey: Uint8Array, network: BtcNetwork, options: BtcWalletOptions) {
    const addressType = options.addressType ?? DEFAULT_ADDRESS_TYPE;
    if (!isAddressType(addressType)) throw new Error(`unsupported address type ${addressType}`);
    this.privateKey = privateKey;
    this.network = network;
    this.addressType = addressType;
    const { script, address } = scriptForPubkey(secp256k1.getPublicKey(privateKey, true), network, addressType);
    this.script = script;
    this.address = address;
    this.esplora = options.esplora ?? EsploraClient.for(network);
    this.options = options;
  }

  /** A WIF of the right network (K/L… on mainnet, c… on testnet), compressed key. */
  static fromWif(wif: string, network: BtcNetwork, options: BtcWalletOptions = {}): BtcWallet {
    let key: Uint8Array;
    try {
      key = WIF(BTC_NETWORKS[network].params).decode(wif.trim());
    } catch (error) {
      throw new Error(`not a ${BTC_NETWORKS[network].name} WIF: ${error instanceof Error ? error.message : String(error)}`);
    }
    return new BtcWallet(key, network, options);
  }

  /** BIP84 (p2wpkh) or BIP86 (p2tr) first receive address: m/84'|86'/coin'/account'/0/0. */
  static fromMnemonic(
    mnemonic: string,
    network: BtcNetwork,
    options: BtcWalletOptions & { account?: number; passphrase?: string } = {},
  ): BtcWallet {
    const words = mnemonic.trim().split(/\s+/).join(" ");
    if (!validateMnemonic(words, wordlist)) throw new Error("BUYER_BTC_MNEMONIC is not a valid BIP39 English mnemonic");
    const purpose = (options.addressType ?? DEFAULT_ADDRESS_TYPE) === "p2tr" ? 86 : 84;
    const path = `m/${purpose}'/${BTC_NETWORKS[network].coinType}'/${options.account ?? 0}'/0/0`;
    const key = HDKey.fromMasterSeed(mnemonicToSeedSync(words, options.passphrase)).derive(path).privateKey;
    if (!key) throw new Error(`no private key at ${path}`);
    return new BtcWallet(key, network, options);
  }

  async spendable(): Promise<Utxo[]> {
    const utxos = await this.esplora.utxos(this.address);
    return this.options.allowUnconfirmed ? utxos : utxos.filter(u => u.status?.confirmed !== false);
  }

  async balance(): Promise<{ confirmed: bigint; unconfirmed: bigint }> {
    const utxos = await this.esplora.utxos(this.address);
    const sum = (list: Utxo[]) => list.reduce((s, u) => s + BigInt(u.value), 0n);
    return { confirmed: sum(utxos.filter(u => u.status?.confirmed !== false)), unconfirmed: sum(utxos.filter(u => u.status?.confirmed === false)) };
  }

  async resolveFeeRate(): Promise<number> {
    const rate = this.options.feeRate ?? (await this.esplora.feeRate(this.options.feeTargetBlocks ?? 3));
    const max = this.options.maxFeeRate ?? 200;
    if (rate > max) throw new Error(`fee rate ${rate} sat/vB is above the cap of ${max} sat/vB; pass --fee-rate to choose one`);
    return rate;
  }

  /** Build and sign (nothing is sent): `sats` to `address` as output 0, change to self as output 1. */
  buildPaymentFrom(utxos: readonly Utxo[], address: string, sats: bigint, feeRate: number): SignedPayment {
    const params = BTC_NETWORKS[this.network].params;
    const paymentScript = OutScript.encode(Address(params).decode(address));
    const outType = OutScript.decode(paymentScript).type;
    const dust = outType === "wpkh" ? DUST.p2wpkh : outType === "tr" ? DUST.p2tr : 546n;
    if (sats < dust) throw new Error(`${sats} sats is below the dust limit (${dust}) for ${address}`);
    const sel = selectLargestFirst(
      utxos,
      sats,
      feeRate,
      { input: VSIZE.input[this.addressType], paymentOutput: VSIZE.output(paymentScript.length), changeOutput: VSIZE.output(this.script.length) },
      DUST[this.addressType],
    );
    const tx = new Transaction();
    const xonly = this.addressType === "p2tr" ? secp256k1.getPublicKey(this.privateKey, true).subarray(1) : undefined;
    for (const u of sel.inputs) {
      tx.addInput({
        txid: u.txid,
        index: u.vout,
        witnessUtxo: { script: this.script, amount: BigInt(u.value) },
        ...(xonly ? { tapInternalKey: xonly } : {}),
      });
    }
    tx.addOutputAddress(address, sats, params);
    if (sel.change > 0n) tx.addOutput({ script: this.script, amount: sel.change });
    tx.sign(this.privateKey);
    tx.finalize();
    if (tx.fee !== sel.fee) throw new Error(`internal error: fee ${tx.fee} != selected ${sel.fee}`);
    return { hex: tx.hex, txid: tx.id, vout: 0, fee: sel.fee, change: sel.change, vsize: tx.vsize, inputs: sel.inputs };
  }

  async buildPayment(address: string, sats: bigint): Promise<SignedPayment> {
    return this.buildPaymentFrom(await this.spendable(), address, sats, await this.resolveFeeRate());
  }

  /** PayBtc: build, sign, broadcast through Esplora. */
  pay = async (address: string, sats: bigint, ctx?: PayBtcContext): Promise<BtcOutputRef> => {
    if (ctx && ctx.network !== this.network) throw new Error(`wallet is on ${this.network}, payment asks for ${ctx.network}`);
    const p = await this.buildPayment(address, sats);
    this.options.log?.(
      `sending ${sats} sats to ${address} from ${this.address}: ${p.inputs.length} input(s), fee ${p.fee} sats ` +
        `(${p.vsize} vB), change ${p.change} sats, txid ${p.txid}`,
    );
    const reported = await this.esplora.broadcast(p.hex);
    if (reported !== p.txid) throw new Error(`Esplora reported txid ${reported}, expected ${p.txid}`);
    return { txid: p.txid, vout: p.vout };
  };
}
