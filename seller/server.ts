/**
 * Demo x402 seller: one paid route, GET /echo, priced at $0.001.
 *
 * Every network in SELLER_NETWORKS advertises two accepted assets, USDC.e and the BTC asset
 * (hemiBTC on mainnet, hBTC on testnet). Every Bitcoin network in SELLER_BTC_NETWORKS adds an accept
 * for native BTC on Bitcoin L1 (`exact` on `bip122:*`, docs/specs/scheme_exact_bip122.md), paid to an
 * address derived from SELLER_BTC_XPUB and verified by the facilitator through Hemi's hBK.
 * Verification and settlement go to the facilitator at FACILITATOR_URL; the seller never touches a chain itself.
 */
import express from "express";
import { getAddress, isAddress } from "viem";
import { HTTPFacilitatorClient, type RouteConfig } from "@x402/core/server";
import { SettleError, type AssetAmount } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { btcAsset, parseNetwork, usdcAsset, type HemiAsset, type HemiNetwork } from "@hemi-x402/shared";
import {
  BTC_NETWORKS,
  btcTxUrl,
  derivePaymentAddress,
  DUST,
  ExactBtcServerScheme,
  isAddressType,
  isBtcNetwork,
  parseAccountXpub,
  parseBtcNetwork,
  type BtcNetwork,
} from "@hemi-x402/btc";

const PRICE_USD = "$0.001";
const USDC_AMOUNT = "1000"; // 6 decimals: 1000 base units = $0.001
// 8 decimals: 1 sat = 0.00000001 BTC, about $0.001 at ~$100k/BTC.
const BTC_AMOUNT = process.env.SELLER_BTC_AMOUNT ?? "1";

function fail(message: string): never {
  console.error(`[seller] ${message}`);
  process.exit(1);
}

const list = (value: string) => value.split(",").map(s => s.trim()).filter(Boolean);
const facilitatorUrl = process.env.FACILITATOR_URL ?? "http://localhost:8080";
const port = Number(process.env.PORT ?? 4021);
// An empty SELLER_NETWORKS turns the Hemi accepts off (a Bitcoin-only seller).
const networks: HemiNetwork[] = list(process.env.SELLER_NETWORKS ?? "eip155:743111").map(parseNetwork);

const payToEnv = process.env.SELLER_PAY_TO ?? "";
if (networks.length > 0 && !isAddress(payToEnv)) fail("SELLER_PAY_TO must be set to the 0x address that receives payments");
if (!/^[1-9]\d*$/.test(BTC_AMOUNT)) fail("SELLER_BTC_AMOUNT must be a positive integer (satoshis)");
const payTo = networks.length > 0 ? getAddress(payToEnv) : undefined;

/** Native BTC on Bitcoin L1: one accept per network in SELLER_BTC_NETWORKS (empty = off). */
interface BtcAccept {
  network: BtcNetwork;
  xpub: string;
}
const btcNetworks: BtcNetwork[] = list(process.env.SELLER_BTC_NETWORKS ?? "").map(n => {
  try {
    return parseBtcNetwork(n);
  } catch (error) {
    return fail(`SELLER_BTC_NETWORKS: ${(error as Error).message}`);
  }
});
const btcAmountSats = process.env.SELLER_BTC_AMOUNT_SATS ?? "1000";
const btcMinConfirmations = Number(process.env.SELLER_BTC_MIN_CONFIRMATIONS ?? 1);
const btcAddressType = process.env.SELLER_BTC_ADDRESS_TYPE ?? "p2wpkh";
const btcMaxTimeoutSeconds = Number(process.env.SELLER_BTC_MAX_TIMEOUT_SECONDS ?? 3600);
const btcXpubs = list(process.env.SELLER_BTC_XPUB ?? "");
const btcAccepts: BtcAccept[] = [];
if (btcNetworks.length > 0) {
  if (!isAddressType(btcAddressType)) fail("SELLER_BTC_ADDRESS_TYPE must be p2wpkh or p2tr");
  if (!/^[1-9]\d*$/.test(btcAmountSats) || BigInt(btcAmountSats) < DUST[btcAddressType]) {
    fail(`SELLER_BTC_AMOUNT_SATS must be an integer of at least ${DUST[btcAddressType]} sats (smaller ${btcAddressType} outputs are dust)`);
  }
  if (!Number.isInteger(btcMinConfirmations) || btcMinConfirmations < 1) fail("SELLER_BTC_MIN_CONFIRMATIONS must be an integer >= 1");
  if (!Number.isInteger(btcMaxTimeoutSeconds) || btcMaxTimeoutSeconds < 600) {
    fail("SELLER_BTC_MAX_TIMEOUT_SECONDS must be an integer >= 600: a payment is verifiable one Bitcoin block after inclusion at the earliest");
  }
  if (btcXpubs.length === 0) fail("SELLER_BTC_XPUB must be set when SELLER_BTC_NETWORKS is (an account xpub, or a tpub for testnet3)");
  for (const network of btcNetworks) {
    // One key per network, picked by prefix: xpub for Bitcoin mainnet, tpub for testnet3.
    const info = BTC_NETWORKS[network];
    const xpub = btcXpubs.find(k => k.startsWith(info.xpubPrefix)) ?? btcXpubs[0];
    try {
      parseAccountXpub(xpub, network);
    } catch (error) {
      fail(`SELLER_BTC_XPUB for ${info.short} (${network}): ${(error as Error).message}`);
    }
    btcAccepts.push({ network, xpub });
  }
}
if (networks.length === 0 && btcAccepts.length === 0) fail("nothing to sell: set SELLER_NETWORKS and/or SELLER_BTC_NETWORKS");

/**
 * Explicit asset/amount price. Hemi is not in the SDK's default asset table, so "$0.001"
 * cannot be used as a price string here.
 */
function price(asset: HemiAsset, amount: string): AssetAmount {
  if (asset.transferMethod === "permit2") {
    return { asset: asset.address, amount, extra: { assetTransferMethod: "permit2" } };
  }
  if (!asset.eip712) throw new Error(`${asset.symbol} is EIP-3009 but has no EIP-712 domain in shared/`);
  return {
    asset: asset.address,
    amount,
    extra: { assetTransferMethod: "eip3009", name: asset.eip712.name, version: asset.eip712.version },
  };
}

const accepts: RouteConfig["accepts"] = [
  ...networks.flatMap(network => [
    { scheme: "exact", network, payTo: payTo!, price: price(usdcAsset(network), USDC_AMOUNT) },
    { scheme: "exact", network, payTo: payTo!, price: price(btcAsset(network), BTC_AMOUNT) },
  ]),
  // payTo is the account xpub; ExactBtcServerScheme adds a fresh extra.paymentId to every 402.
  ...btcAccepts.map(({ network, xpub }) => ({
    scheme: "exact",
    network,
    payTo: xpub,
    price: { asset: "BTC", amount: btcAmountSats },
    maxTimeoutSeconds: btcMaxTimeoutSeconds,
  })),
];

/**
 * For bip122 the settled `transaction` is the Bitcoin txid; the Hemi settle tx, if reported, is in `extra`.
 * The line also names the paymentId and the derived path: the funds sit at payTo/0/i1/i2/i3, a
 * random path no wallet's gap-limit scan finds, so this log (or the seller's own records) is what lets
 * the seller spend them later.
 */
function settledTx(network: string, transaction: string, result: object, accepted: { payTo: string; extra: object }): string {
  if (!isBtcNetwork(network)) return `tx ${transaction}`;
  const extra = (result as { extra?: { settlementTransaction?: string } }).extra;
  const hemi = extra?.settlementTransaction ? `, Hemi settle tx ${extra.settlementTransaction}` : "";
  const { paymentId, addressType } = accepted.extra as { paymentId: string; addressType?: "p2wpkh" | "p2tr" };
  const d = derivePaymentAddress(accepted.payTo, network, paymentId, addressType);
  return (
    `bitcoin tx ${transaction} (${btcTxUrl(network, transaction)})${hemi}; ` +
    `paymentId ${paymentId} -> ${d.address} at ${accepted.payTo.slice(0, 12)}…/${d.path.slice(2)}`
  );
}

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
  .onAfterVerify(async ({ result, requirements }) => {
    if (result.isValid) {
      console.log(`[seller] verified ${requirements.amount} of ${requirements.asset} on ${requirements.network} from ${result.payer ?? "n/a"}`);
    } else {
      console.warn(`[seller] verify rejected (${requirements.network} ${requirements.asset}): ${result.invalidReason} ${result.invalidMessage ?? ""}`);
    }
  })
  // A rejection answered with 200 (this facilitator, the TS reference) reaches onAfterVerify above.
  // A facilitator that answers non-2xx, or one that cannot be reached, lands here instead.
  .onVerifyFailure(async ({ error, requirements }) => {
    console.warn(`[seller] verify rejected (${requirements.network} ${requirements.asset}): ${error.message}`);
  })
  .onAfterSettle(async ({ result, requirements, paymentPayload }) => {
    console.log(
      `[seller] settled ${requirements.amount} of ${requirements.asset} on ${result.network} ` +
        `from ${result.payer ?? "n/a"}: ${settledTx(result.network, result.transaction, result, paymentPayload.accepted)}`,
    );
  })
  .onSettleFailure(async ({ error, requirements }) => {
    // A settlement_pending answer carries the broadcast tx hash; log it so the payment can be
    // reconciled if it mines after the request was refused (README "Limits and open items").
    const tx = error instanceof SettleError && error.transaction ? ` tx ${error.transaction}` : "";
    const reason = error instanceof SettleError && error.errorReason ? ` [${error.errorReason}]` : "";
    console.error(`[seller] settle failed (${requirements.network} ${requirements.asset})${reason}: ${error.message}${tx}`);
  });
for (const network of networks) resourceServer.register(network, new ExactEvmScheme());
for (const { network, xpub } of btcAccepts) {
  resourceServer.register(
    network,
    new ExactBtcServerScheme({ network, payTo: xpub, addressType: btcAddressType as "p2wpkh" | "p2tr", minConfirmations: btcMinConfirmations }),
  );
}

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, networks, payTo, btc: btcAccepts, facilitator: facilitatorUrl });
});

app.use(
  paymentMiddleware(
    {
      "GET /echo": {
        accepts,
        description: `Echoes the query string back with a timestamp (${PRICE_USD})`,
        mimeType: "application/json",
      },
    },
    resourceServer,
  ),
);

app.get("/echo", (req, res) => {
  res.json({ echo: req.query, timestamp: new Date().toISOString() });
});

app.listen(port, error => {
  if (error) fail(`cannot listen on port ${port}: ${error.message}`);
  console.log(`[seller] listening on http://localhost:${port}  facilitator ${facilitatorUrl}  payTo ${payTo ?? "n/a"}`);
  for (const a of accepts as { network: string; payTo: string; price: AssetAmount }[]) {
    if (isBtcNetwork(a.network)) {
      console.log(
        `[seller]   ${a.network}  ${a.price.amount} sats of BTC on ${BTC_NETWORKS[a.network].name} to ${a.payTo.slice(0, 12)}…  ` +
          `${btcAddressType}, ${btcMinConfirmations} confirmation(s), maxTimeoutSeconds ${btcMaxTimeoutSeconds}`,
      );
    } else {
      console.log(`[seller]   ${a.network}  ${a.price.amount} of ${a.price.asset}  ${JSON.stringify(a.price.extra)}`);
    }
  }
});
