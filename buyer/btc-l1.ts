/**
 * `npm run pay -w buyer -- --asset btc-l1 --network btc-mainnet|btc-testnet3`: pay the seller in native
 * BTC on Bitcoin L1 (`exact` on `bip122:*`, docs/specs/scheme_exact_bip122.md), then poll until the
 * facilitator can verify the payment through Hemi's hBK and the seller serves the resource.
 *
 * Why not wrapFetchWithPayment: it builds a new payload for each 402 and retries once. A Bitcoin payment is
 * accepted only after it confirms and hVM has seen the block (10 to 30 minutes on mainnet), and paying again
 * on the next 402 would pay twice. So the flow is driven by hand:
 *
 *   1. one GET, decode the 402, keep the bip122 accept (policy), allow-list BTC (spend controls);
 *   2. createPaymentPayload once: ExactBtcClientScheme pays and journals it in .scratch/buyer-btc/journal.jsonl;
 *   3. re-send the same PAYMENT-SIGNATURE every --poll seconds while the answer is "not yet"
 *      (RETRYABLE below); stop on any other reason, on success, or at the accept's maxTimeoutSeconds.
 *
 * --resume <paymentId> skips 1 and 2 and polls with the journaled payload (after a restart or a timeout).
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodePaymentResponseHeader, x402Client, x402HTTPClient } from "@x402/fetch";
import type { PaymentPayload, SettleResponse } from "@x402/core/types";
import hemiJson from "@hemi-x402/shared/hemi.json" with { type: "json" };
import {
  BTC_MAINNET,
  BTC_NETWORKS,
  btcAddressUrl,
  btcTxUrl,
  BtcWallet,
  derivePaymentAddress,
  EsploraClient,
  ExactBtcClientScheme,
  FilePaymentJournal,
  isAddressType,
  isPaymentId,
  parseBtcNetwork,
  type BtcNetwork,
  type JournalEntry,
  type PayBtc,
} from "@hemi-x402/btc";
import { fakeTxid, hemiBtcContracts, mockHbkPayBtc } from "@hemi-x402/btc/mock-hbk";

export interface BtcL1Args {
  network?: string;
  url?: string;
  max?: string;
  poll?: string;
  resume?: string;
  "fee-rate"?: string;
  "stub-pay"?: string;
}

/**
 * Answers that mean "not yet", so the buyer keeps re-sending the same payload:
 *   settlement_pending: the facilitator broadcast the Hemi settle tx but has no receipt yet (§9);
 *   ..._unconfirmed: hVM sees the tx with fewer than extra.minConfirmations confirmations;
 *   ..._transaction_not_found: hVM has not seen the tx yet; normal for the first block or two after broadcast.
 * Every other reason is final for this payload.
 */
export const RETRYABLE = new Set([
  "settlement_pending",
  "invalid_exact_bip122_payload_unconfirmed",
  "invalid_exact_bip122_payload_transaction_not_found",
]);

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const JOURNAL = join(REPO_ROOT, ".scratch", "buyer-btc", "journal.jsonl");
const log = (message: string) => console.log(`[buyer] ${message}`);
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function fail(message: string): never {
  throw new Error(message);
}

/** How the buyer pays: a real wallet, or (development only) a stub that sends nothing to Bitcoin. */
function payer(network: BtcNetwork, args: BtcL1Args): { pay: PayBtc; stub: boolean; describe: () => Promise<void> } {
  const stub = args["stub-pay"];
  if (stub === "fake") {
    // For a stub facilitator: a random txid that exists nowhere.
    return {
      stub: true,
      pay: async () => ({ txid: fakeTxid(), vout: 0 }),
      describe: async () => log("--stub-pay fake: nothing is sent to Bitcoin; the txid is random"),
    };
  }
  if (stub) {
    // For a local Hemi fork with the mock hBK: record a fabricated tx there. mockHbkPayBtc refuses non-local URLs.
    const hemiNetwork = BTC_NETWORKS[network].hemiNetwork;
    const contracts = hemiBtcContracts(hemiJson, hemiNetwork);
    const hbk = (process.env.BUYER_BTC_STUB_HBK ?? contracts.hbk) as `0x${string}` | undefined;
    if (!hbk) fail(`no hBK address for ${hemiNetwork}: set BUYER_BTC_STUB_HBK or shared/hemi.json networks.${hemiNetwork}.contracts.hbk`);
    const confirmations = Number(process.env.BUYER_BTC_STUB_CONFIRMATIONS ?? 1);
    return {
      stub: true,
      pay: mockHbkPayBtc({ rpcUrl: stub, hbk, bitcoinConfirmations: confirmations, confirmationOffset: contracts.confirmationOffset, log }),
      describe: async () => log(`--stub-pay ${stub}: nothing is sent to Bitcoin; the payment is written into the mock hBK ${hbk} on that fork`),
    };
  }
  const wif = process.env.BUYER_BTC_WIF;
  const mnemonic = process.env.BUYER_BTC_MNEMONIC;
  if (!wif && !mnemonic) fail("set BUYER_BTC_WIF or BUYER_BTC_MNEMONIC (the Bitcoin wallet that pays)");
  const addressType = process.env.BUYER_BTC_ADDRESS_TYPE ?? "p2wpkh";
  if (!isAddressType(addressType)) fail("BUYER_BTC_ADDRESS_TYPE must be p2wpkh or p2tr");
  const feeRate = args["fee-rate"] === undefined ? undefined : Number(args["fee-rate"]);
  if (feeRate !== undefined && !(feeRate >= 1)) fail("--fee-rate must be a number of sat/vB, at least 1");
  // BUYER_BTC_ESPLORA: another Esplora REST base (a mempool.space mirror), for when mempool.space is unreachable.
  const esploraBase = process.env.BUYER_BTC_ESPLORA?.trim().replace(/\/+$/, "");
  if (esploraBase && !/^https:\/\/[^\s]+$/.test(esploraBase)) fail("BUYER_BTC_ESPLORA must be an https:// Esplora API base, e.g. https://mempool.emzy.de/api");
  const esplora = esploraBase ? new EsploraClient(esploraBase) : undefined;
  const options = { addressType, feeRate, log, esplora };
  const wallet = wif ? BtcWallet.fromWif(wif, network, options) : BtcWallet.fromMnemonic(mnemonic!, network, options);
  return {
    stub: false,
    pay: wallet.pay,
    describe: async () => {
      const { confirmed, unconfirmed } = await wallet.balance();
      log(`wallet ${wallet.address} (${addressType}) holds ${confirmed} sats confirmed, ${unconfirmed} unconfirmed`);
      log(`  ${btcAddressUrl(network, wallet.address)}`);
      log(`fee rate: ${feeRate ?? `${await wallet.esplora.feeRate(3)} (3-block estimate from ${wallet.esplora.base})`} sat/vB`);
    },
  };
}

function hemiSettleTx(settlement: SettleResponse): string | undefined {
  const s = settlement as SettleResponse & { extra?: Record<string, unknown>; extensions?: Record<string, unknown> };
  const v = s.extra?.settlementTransaction ?? s.extensions?.settlementTransaction;
  return typeof v === "string" ? v : undefined;
}

export async function runBtcL1(args: BtcL1Args, defaultUrl: string): Promise<void> {
  const network = parseBtcNetwork(args.network ?? "btc-testnet3");
  const info = BTC_NETWORKS[network];
  if (network === BTC_MAINNET && process.env.ALLOW_MAINNET !== "yes") {
    fail("refusing --network btc-mainnet: it spends real bitcoin. Set ALLOW_MAINNET=yes to proceed.");
  }
  const pollSeconds = Number(args.poll ?? 60);
  if (!(pollSeconds > 0)) fail("--poll must be a positive number of seconds");
  // Per-payment cap in sats: 5000 by default (a few dollars at ~$100k/BTC; the seller's default is 1000).
  const max = args.max ?? "5000";
  if (!/^[1-9]\d*$/.test(max)) fail("--max must be a positive integer of satoshis");

  const journal = new FilePaymentJournal(JOURNAL);
  // --resume never pays, so it needs no wallet.
  const how = args.resume
    ? { stub: false, pay: (async () => fail("internal error: --resume must not pay")) as PayBtc, describe: async () => {} }
    : payer(network, args);
  const scheme = new ExactBtcClientScheme(how.pay, { journal, maxSats: BigInt(max) });
  const client = new x402Client()
    .register(network, scheme)
    // BTC is not an SDK default asset, so spend controls reject it unless allow-listed.
    .setSpendControls({ allowedAssets: [{ network, asset: "BTC", maxAmountPerPayment: max }] })
    // Of the seller's accepts, keep only native BTC on the requested Bitcoin network.
    .registerPolicy((_version, reqs) => reqs.filter(r => r.scheme === "exact" && r.network === network && r.asset === "BTC"))
    .onBeforePaymentCreation(async ({ selectedRequirements: req }) => {
      const d = derivePaymentAddress(req.payTo, network, req.extra.paymentId as string, (req.extra.addressType ?? "p2wpkh") as "p2wpkh");
      log(`paying ${req.amount} sats on ${info.name} to ${d.address} (paymentId ${d.paymentId}, ${req.payTo.slice(0, 12)}…/${d.path.slice(2)})`);
      log(`  needs ${req.extra.minConfirmations ?? 1} confirmation(s); seller waits up to ${req.maxTimeoutSeconds}s`);
    });
  const http = new x402HTTPClient(client);

  let entry: JournalEntry;
  let url: string;
  if (args.resume) {
    if (!isPaymentId(args.resume)) fail("--resume takes a paymentId (32 lowercase hex chars)");
    const found = await journal.get(args.resume);
    if (!found) fail(`paymentId ${args.resume} is not in ${JOURNAL}`);
    if (found.status !== "paid" || !found.payment) fail(`paymentId ${args.resume} was never recorded as paid; check the wallet before anything else`);
    if (found.network !== network) fail(`paymentId ${args.resume} was paid on ${found.network}; pass --network ${BTC_NETWORKS[found.network].short}`);
    entry = found;
    url = args.url ?? found.url ?? fail("no URL in the journal entry; pass --url");
    log(`resuming paymentId ${entry.paymentId}: tx ${entry.txid} vout ${entry.vout}`);
  } else {
    url = args.url ?? defaultUrl;
    await how.describe();
    log(`GET ${url}`);
    const res = await fetch(url);
    const body = await res.text();
    if (res.status !== 402) fail(`expected 402 Payment Required, got ${res.status}: ${body.slice(0, 300)}`);
    let parsed: unknown;
    try {
      parsed = body ? JSON.parse(body) : undefined;
    } catch {
      parsed = undefined; // v2 sellers put the requirements in the PAYMENT-REQUIRED header; the body is optional
    }
    const required = http.getPaymentRequiredResponse(name => res.headers.get(name), parsed);
    const payment = await client.createPaymentPayload(required);
    const paid = await journal.get(payment.accepted.extra.paymentId as string);
    if (!paid || paid.status !== "paid") fail("internal error: the payment is not in the journal");
    entry = { ...paid, payment, url, stub: how.stub || undefined, updatedAt: new Date().toISOString() };
    await journal.put(entry);
  }

  const payment = entry.payment as PaymentPayload;
  const txid = payment.payload.txid as string;
  log(`bitcoin tx: ${txid} vout ${payment.payload.vout}`);
  log(`  ${entry.stub ? "(stub payment: not on Bitcoin)" : btcTxUrl(network, txid)}`);
  log(`journal: ${JOURNAL} (resume with --resume ${entry.paymentId})`);

  // A fresh payment polls for maxTimeoutSeconds after paying; --resume gets a new window from now.
  const deadline = (args.resume ? Date.now() : Date.parse(entry.createdAt)) + payment.accepted.maxTimeoutSeconds * 1000;
  const headers = http.encodePaymentSignatureHeader(payment);
  let unreachable = 0;
  for (let attempt = 1; ; attempt++) {
    let res: Response | undefined;
    try {
      res = await fetch(url, { headers });
      unreachable = 0;
    } catch (error) {
      log(`attempt ${attempt}: ${url} unreachable (${error instanceof Error ? error.message : String(error)})`);
      if (++unreachable >= 3) fail(`the seller did not answer 3 times in a row; the payment is journaled: --resume ${entry.paymentId}`);
    }
    if (res?.ok) {
      const body = await res.text();
      const settlement = http.getPaymentSettleResponse(name => res!.headers.get(name));
      log(`response: ${body}`);
      log(`settled on ${settlement.network}: bitcoin tx ${settlement.transaction}`);
      if (settlement.transaction !== txid) log(`  warning: the seller reports another txid than the one paid (${txid})`);
      const hemiTx = hemiSettleTx(settlement);
      log(hemiTx ? `hemi settle tx: ${hemiTx}` : "hemi settle tx: not in the response (the facilitator logs it; see the settler's Settled event)");
      return;
    }
    if (res) {
      await res.text();
      const response = res.headers.get("PAYMENT-RESPONSE");
      const required = res.headers.get("PAYMENT-REQUIRED");
      const failure = response ? decodePaymentResponseHeader(response) : undefined;
      const reason = failure?.errorReason ?? (required ? http.getPaymentRequiredResponse(name => res!.headers.get(name)).error : undefined);
      if (res.status !== 402 || !reason || !RETRYABLE.has(reason)) {
        fail(`seller answered ${res.status}${reason ? ` (${reason})` : ""}${failure?.errorMessage && failure.errorMessage !== reason ? `: ${failure.errorMessage}` : ""}`);
      }
      const hemiTx = reason === "settlement_pending" && failure?.transaction ? ` (hemi tx ${failure.transaction})` : "";
      log(`attempt ${attempt}: not yet: ${reason}${hemiTx}`);
    }
    if (Date.now() + pollSeconds * 1000 > deadline) {
      fail(
        `gave up at maxTimeoutSeconds (${payment.accepted.maxTimeoutSeconds}s after paying). The payment stays valid ` +
          `on Bitcoin and in the journal: --resume ${entry.paymentId}`,
      );
    }
    await sleep(pollSeconds * 1000);
  }
}
