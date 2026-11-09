/**
 * The two Bitcoin networks the `exact` scheme on `bip122:*` serves (docs/specs/scheme_exact_bip122.md).
 *
 * CAIP-2 ids are `bip122:` plus the first 32 hex chars of the genesis block hash (CAIP-4). Each Bitcoin
 * network is verified on one Hemi network, whose hBK reads that Bitcoin chain.
 */
import { NETWORK, TEST_NETWORK } from "@scure/btc-signer";

export const BTC_MAINNET = "bip122:000000000019d6689c085ae165831e93";
export const BTC_TESTNET3 = "bip122:000000000933ea01ad0ee984209779ba";
export type BtcNetwork = typeof BTC_MAINNET | typeof BTC_TESTNET3;

/** The `asset` of every bip122 accept: native BTC, amounts in satoshis. */
export const BTC_ASSET = "BTC";
/** `extra.assetTransferMethod`: the SDK keys payment flows by transfer method. */
export const UTXO_TRANSFER_METHOD = "utxo";

/** BIP32 serialization version bytes (BIP32, SLIP-132). */
export interface Bip32Versions {
  public: number;
  private: number;
}

export interface BtcNetworkInfo {
  network: BtcNetwork;
  /** CLI name used by buyer/pay.ts and seller env vars. */
  short: "btc-mainnet" | "btc-testnet3";
  name: string;
  /** Hemi network whose hBK reads this Bitcoin chain. */
  hemiNetwork: "eip155:43111" | "eip155:743111";
  /** Address and WIF parameters in @scure/btc-signer's shape (bech32 hrp `bc` / `tb`). */
  params: typeof NETWORK;
  /** `xpub` / `tpub`: the only extended public key forms accepted as `payTo`. */
  xpubPrefix: "xpub" | "tpub";
  bip32: Bip32Versions;
  /** BIP44 coin type for wallet paths (m/84'/coin'/account'). */
  coinType: 0 | 1;
  /** Esplora REST base (mempool.space), read-only use plus the buyer's own broadcast. */
  esplora: string;
  explorer: string;
}

export const BTC_NETWORKS: Record<BtcNetwork, BtcNetworkInfo> = {
  [BTC_MAINNET]: {
    network: BTC_MAINNET,
    short: "btc-mainnet",
    name: "Bitcoin mainnet",
    hemiNetwork: "eip155:43111",
    params: NETWORK,
    xpubPrefix: "xpub",
    bip32: { public: 0x0488b21e, private: 0x0488ade4 },
    coinType: 0,
    esplora: "https://mempool.space/api",
    explorer: "https://mempool.space",
  },
  [BTC_TESTNET3]: {
    network: BTC_TESTNET3,
    short: "btc-testnet3",
    name: "Bitcoin testnet3",
    hemiNetwork: "eip155:743111",
    params: TEST_NETWORK,
    xpubPrefix: "tpub",
    bip32: { public: 0x043587cf, private: 0x04358394 },
    coinType: 1,
    esplora: "https://mempool.space/testnet/api",
    explorer: "https://mempool.space/testnet",
  },
};

/**
 * SLIP-132 prefixes that encode the same key with other version bytes. They are refused as `payTo`
 * so that every party derives from one canonical string; the hint names the conversion.
 */
export const SLIP132_PREFIXES: Record<string, string> = {
  ypub: "ypub (BIP49, mainnet)",
  zpub: "zpub (BIP84, mainnet)",
  Ypub: "Ypub (BIP49 multisig, mainnet)",
  Zpub: "Zpub (BIP84 multisig, mainnet)",
  upub: "upub (BIP49, testnet)",
  vpub: "vpub (BIP84, testnet)",
  Upub: "Upub (BIP49 multisig, testnet)",
  Vpub: "Vpub (BIP84 multisig, testnet)",
};

export function isBtcNetwork(value: unknown): value is BtcNetwork {
  return value === BTC_MAINNET || value === BTC_TESTNET3;
}

/** Accepts the CAIP-2 id or a short name: btc-mainnet / bitcoin / mainnet, btc-testnet3 / testnet3. */
export function parseBtcNetwork(value: string): BtcNetwork {
  const v = value.trim();
  if (isBtcNetwork(v)) return v;
  if (v === "btc-mainnet" || v === "bitcoin" || v === "btc") return BTC_MAINNET;
  if (v === "btc-testnet3" || v === "testnet3" || v === "btc-testnet") return BTC_TESTNET3;
  throw new Error(`Unknown Bitcoin network: ${value} (use ${BTC_MAINNET} / btc-mainnet or ${BTC_TESTNET3} / btc-testnet3)`);
}

export function btcTxUrl(network: BtcNetwork, txid: string): string {
  return `${BTC_NETWORKS[network].explorer}/tx/${txid}`;
}

export function btcAddressUrl(network: BtcNetwork, address: string): string {
  return `${BTC_NETWORKS[network].explorer}/address/${address}`;
}
