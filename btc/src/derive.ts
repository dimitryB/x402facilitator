/**
 * The payment address rule shared by the seller, the facilitator and the buyer
 * (docs/specs/scheme_exact_bip122.md, "Payment address"):
 *
 *   d       = sha256(utf8("x402-btc") || bytes16(paymentId))
 *   i1, i2, i3 = BE_uint32(d[0..4]), BE_uint32(d[4..8]), BE_uint32(d[8..12]), each & 0x7fffffff
 *   address = non-hardened child m/0/i1/i2/i3 of payTo (the seller's account xpub)
 *   p2wpkh  : script 0x0014 || hash160(pubkey)
 *   p2tr    : BIP86 key path, no script tree: 0x5120 || x(P + H_TapTweak(x(P))·G)
 *
 * Three levels, 93 bits: with one 31-bit level, anyone holding the public xpub could precompute every
 * child address and find another paymentId with the same index in seconds, then claim a payment seen in
 * the mempool (DESIGN.md, revised 2026-11-09). btc/test-vectors.json has the vectors every implementation
 * must reproduce.
 */
import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils";
import { HDKey } from "@scure/bip32";
import { p2tr, p2wpkh } from "@scure/btc-signer";
import { BTC_NETWORKS, SLIP132_PREFIXES, type BtcNetwork } from "./networks.js";

export type AddressType = "p2wpkh" | "p2tr";
export const ADDRESS_TYPES: readonly AddressType[] = ["p2wpkh", "p2tr"];
export const DEFAULT_ADDRESS_TYPE: AddressType = "p2wpkh";

/** Domain separator of the index hash. */
export const PAYMENT_ID_DOMAIN = "x402-btc";
const PAYMENT_ID = /^[0-9a-f]{32}$/;

/** 32 lowercase hex chars (16 bytes). Uppercase is refused so every party hashes the same bytes. */
export function isPaymentId(value: unknown): value is string {
  return typeof value === "string" && PAYMENT_ID.test(value);
}

export function isAddressType(value: unknown): value is AddressType {
  return value === "p2wpkh" || value === "p2tr";
}

/** A fresh random paymentId (16 bytes from the platform CSPRNG). */
export function newPaymentId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)));
}

function paymentIdBytes(paymentId: string): Uint8Array {
  if (!isPaymentId(paymentId)) throw new Error(`paymentId must be 32 lowercase hex chars, got ${JSON.stringify(paymentId)}`);
  return hexToBytes(paymentId);
}

export type PaymentIndices = [number, number, number];

/** The three non-hardened child indices below payTo/0 for `paymentId`: each below 2^31. */
export function paymentIndices(paymentId: string): PaymentIndices {
  const d = sha256(new Uint8Array([...utf8ToBytes(PAYMENT_ID_DOMAIN), ...paymentIdBytes(paymentId)]));
  const view = new DataView(d.buffer, d.byteOffset, 12);
  return [0, 4, 8].map(o => view.getUint32(o, false) & 0x7fffffff) as PaymentIndices;
}

/** `m/0/i1/i2/i3`, relative to payTo. */
export function paymentPath(paymentId: string): string {
  return `m/0/${paymentIndices(paymentId).join("/")}`;
}

/**
 * `paymentRef = sha256(bytes16(paymentId))`, 0x-prefixed: what the facilitator passes to
 * X402BtcSettler.settle and what `settledBy[txid][vout]` holds afterwards. It names the payment
 * without revealing the paymentId (from which the address could be linked to the seller's xpub).
 */
export function paymentRef(paymentId: string): `0x${string}` {
  return `0x${bytesToHex(sha256(paymentIdBytes(paymentId)))}`;
}

/**
 * Parse `payTo` as an account-level extended public key for `network`. Only the canonical `xpub`
 * (mainnet) and `tpub` (testnet3) version bytes are accepted; SLIP-132 forms and private keys are refused.
 */
export function parseAccountXpub(xpub: string, network: BtcNetwork): HDKey {
  const info = BTC_NETWORKS[network];
  const prefix = xpub.slice(0, 4);
  if (SLIP132_PREFIXES[prefix]) {
    throw new Error(
      `payTo is a ${SLIP132_PREFIXES[prefix]} key; the scheme takes the same key with ${info.xpubPrefix} version bytes ` +
        `(convert it, e.g. with any SLIP-132 converter; addressType in extra selects the script type)`,
    );
  }
  if (prefix === "xprv" || prefix === "tprv") throw new Error("payTo must be an extended public key, not a private key");
  if (prefix !== info.xpubPrefix) {
    const other = prefix === "xpub" || prefix === "tpub" ? ` (${prefix} is for the other Bitcoin network)` : "";
    throw new Error(`payTo must be a ${info.xpubPrefix} key on ${info.name}, got "${prefix}…"${other}`);
  }
  let key: HDKey;
  try {
    key = HDKey.fromExtendedKey(xpub, info.bip32);
  } catch (error) {
    throw new Error(`payTo is not a valid ${info.xpubPrefix}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (key.privateKey) throw new Error("payTo must be an extended public key, not a private key");
  return key;
}

export interface PaymentAddress {
  network: BtcNetwork;
  addressType: AddressType;
  paymentId: string;
  indices: PaymentIndices;
  /** Relative to payTo: m/0/i1/i2/i3. */
  path: string;
  /** Compressed SEC1 public key of the child, hex. */
  pubkey: string;
  /** scriptPubKey, hex without 0x: what the settler compares against hBK's output script. */
  script: string;
  address: string;
}

/** Script and address for one payment, derived from the public key alone. */
export function scriptForPubkey(pubkey: Uint8Array, network: BtcNetwork, addressType: AddressType): { script: Uint8Array; address: string } {
  const params = BTC_NETWORKS[network].params;
  const out = addressType === "p2tr" ? p2tr(pubkey.subarray(1), undefined, params) : p2wpkh(pubkey, params);
  if (!out.address) throw new Error(`cannot encode a ${addressType} address`);
  return { script: out.script, address: out.address };
}

export function derivePaymentAddress(
  xpub: string,
  network: BtcNetwork,
  paymentId: string,
  addressType: AddressType = DEFAULT_ADDRESS_TYPE,
): PaymentAddress {
  if (!isAddressType(addressType)) throw new Error(`addressType must be one of ${ADDRESS_TYPES.join(", ")}, got ${JSON.stringify(addressType)}`);
  const indices = paymentIndices(paymentId);
  const child = indices.reduce((key, i) => key.deriveChild(i), parseAccountXpub(xpub, network).deriveChild(0));
  if (!child.publicKey) throw new Error("derived key has no public key");
  const { script, address } = scriptForPubkey(child.publicKey, network, addressType);
  return {
    network,
    addressType,
    paymentId,
    indices,
    path: `m/0/${indices.join("/")}`,
    pubkey: bytesToHex(child.publicKey),
    script: bytesToHex(script),
    address,
  };
}
