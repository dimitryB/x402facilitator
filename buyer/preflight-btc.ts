/**
 * Read-only preflight for a live Bitcoin L1 payment (phase 2):
 *
 *   npm run preflight-btc -w buyer                 # btc-mainnet
 *   npm run preflight-btc -w buyer -- btc-testnet3
 *
 * Reads SELLER_BTC_XPUB and BUYER_BTC_WIF / BUYER_BTC_MNEMONIC from .env (tsx --env-file) and prints only
 * public data: whether the xpub parses for the network and a payment address derived from it for a throwaway
 * paymentId, the buyer wallet's address with its confirmed/unconfirmed balance from mempool.space (or the
 * Esplora base in BUYER_BTC_ESPLORA), the
 * current fee rate, and whether the balance covers SELLER_BTC_AMOUNT_SATS plus a one-input p2wpkh spend.
 * Nothing is signed or broadcast; no private key or mnemonic is ever printed.
 */
import {
  BTC_NETWORKS,
  BtcWallet,
  btcAddressUrl,
  derivePaymentAddress,
  EsploraClient,
  isAddressType,
  newPaymentId,
  parseBtcNetwork,
} from "@hemi-x402/btc";

const network = parseBtcNetwork(process.argv[2] ?? "btc-mainnet");
const info = BTC_NETWORKS[network];
const problems: string[] = [];
const log = (line: string) => console.log(line);

log(`network: ${network} (${info.name})`);

// Seller side: the xpub.
const xpub = (process.env.SELLER_BTC_XPUB ?? "").trim();
const sellerType = process.env.SELLER_BTC_ADDRESS_TYPE ?? "p2wpkh";
if (!xpub || xpub.startsWith("REPLACE_WITH")) {
  problems.push("SELLER_BTC_XPUB is not set (still the placeholder)");
} else if (!isAddressType(sellerType)) {
  problems.push(`SELLER_BTC_ADDRESS_TYPE must be p2wpkh or p2tr, got ${sellerType}`);
} else {
  try {
    const id = newPaymentId();
    const derived = derivePaymentAddress(xpub, network, id, sellerType);
    log(`seller xpub: ${xpub.slice(0, 4)}…${xpub.slice(-6)} parses as a ${info.xpubPrefix} on ${info.name}`);
    log(`  sample paymentId ${id} -> ${derived.path} ${derived.address} (${sellerType})`);
  } catch (error) {
    problems.push(`SELLER_BTC_XPUB: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const amount = Number(process.env.SELLER_BTC_AMOUNT_SATS ?? 1000);
if (!(Number.isInteger(amount) && amount >= 294)) problems.push(`SELLER_BTC_AMOUNT_SATS must be an integer >= 294, got ${process.env.SELLER_BTC_AMOUNT_SATS}`);
log(`seller price: ${amount} sats, SELLER_BTC_NETWORKS=${process.env.SELLER_BTC_NETWORKS ?? "(unset)"}`);

// Buyer side: the wallet, never printed.
const wif = (process.env.BUYER_BTC_WIF ?? "").trim();
const mnemonic = (process.env.BUYER_BTC_MNEMONIC ?? "").trim();
const buyerType = process.env.BUYER_BTC_ADDRESS_TYPE ?? "p2wpkh";
if (!isAddressType(buyerType)) problems.push(`BUYER_BTC_ADDRESS_TYPE must be p2wpkh or p2tr, got ${buyerType}`);
const esploraBase = process.env.BUYER_BTC_ESPLORA?.trim().replace(/\/+$/, "");
const esplora = esploraBase ? new EsploraClient(esploraBase) : undefined;
let wallet: BtcWallet | undefined;
if (wif.startsWith("REPLACE_WITH") || (!wif && !mnemonic)) {
  problems.push("neither BUYER_BTC_WIF nor BUYER_BTC_MNEMONIC is set (WIF still the placeholder?)");
} else if (wif && mnemonic) {
  problems.push("both BUYER_BTC_WIF and BUYER_BTC_MNEMONIC are set; keep one");
} else if (isAddressType(buyerType)) {
  try {
    const options = { addressType: buyerType, esplora };
    wallet = wif ? BtcWallet.fromWif(wif, network, options) : BtcWallet.fromMnemonic(mnemonic, network, options);
    log(`buyer wallet: ${wallet.address} (${buyerType}, from ${wif ? "WIF" : "mnemonic, first BIP84/86 receive address"})`);
    log(`  ${btcAddressUrl(network, wallet.address)}`);
  } catch (error) {
    problems.push(`buyer wallet: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (wallet) {
  try {
    const [{ confirmed, unconfirmed }, feeRate, tip] = await Promise.all([wallet.balance(), wallet.esplora.feeRate(3), wallet.esplora.tipHeight()]);
    // One p2wpkh input, two p2wpkh outputs: about 141 vB; p2tr is a little smaller.
    const estFee = BigInt(Math.ceil(141 * feeRate));
    log(`  balance: ${confirmed} sats confirmed, ${unconfirmed} unconfirmed (${wallet.esplora.base}, tip ${tip})`);
    log(`fee rate (3-block estimate): ${feeRate} sat/vB -> about ${estFee} sats for a one-input payment`);
    const need = BigInt(amount) + estFee;
    if (confirmed >= need) log(`funds: ok, ${confirmed} >= ${amount} + ~${estFee}`);
    else if (confirmed + unconfirmed >= need) problems.push(`funds arrive unconfirmed (${unconfirmed} sats pending); wait for one confirmation before paying`);
    else problems.push(`insufficient funds: ${confirmed} sats confirmed, need about ${need} (${amount} + ~${estFee} fee)`);
  } catch (error) {
    problems.push(
      `${wallet.esplora.base}: ${error instanceof Error ? error.message : String(error)}` +
        (esploraBase ? "" : " (if mempool.space is unreachable from here, set BUYER_BTC_ESPLORA to a mirror, e.g. https://mempool.emzy.de/api)"),
    );
  }
}

if (problems.length === 0) {
  log("preflight: ok (nothing was sent)");
} else {
  log("preflight: NOT ready");
  for (const p of problems) log(`  - ${p}`);
  process.exit(1);
}
