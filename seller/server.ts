/**
 * Demo x402 seller: one paid route, GET /echo, priced at $0.001.
 *
 * Every network in SELLER_NETWORKS advertises two accepted assets, USDC.e and the BTC asset
 * (hemiBTC on mainnet, hBTC on testnet). Verification and settlement go to the facilitator at
 * FACILITATOR_URL; the seller never touches a chain itself.
 */
import express from "express";
import { getAddress, isAddress } from "viem";
import { HTTPFacilitatorClient, type RouteConfig } from "@x402/core/server";
import { SettleError, type AssetAmount } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/server";
import { paymentMiddleware, x402ResourceServer } from "@x402/express";
import { btcAsset, parseNetwork, usdcAsset, type HemiAsset, type HemiNetwork } from "@hemi-x402/shared";

const PRICE_USD = "$0.001";
const USDC_AMOUNT = "1000"; // 6 decimals: 1000 base units = $0.001
// 8 decimals: 1 sat = 0.00000001 BTC, about $0.001 at ~$100k/BTC.
const BTC_AMOUNT = process.env.SELLER_BTC_AMOUNT ?? "1";

function fail(message: string): never {
  console.error(`[seller] ${message}`);
  process.exit(1);
}

const payToEnv = process.env.SELLER_PAY_TO ?? "";
if (!isAddress(payToEnv)) fail("SELLER_PAY_TO must be set to the 0x address that receives payments");
if (!/^[1-9]\d*$/.test(BTC_AMOUNT)) fail("SELLER_BTC_AMOUNT must be a positive integer (satoshis)");
const payTo = getAddress(payToEnv);
const facilitatorUrl = process.env.FACILITATOR_URL ?? "http://localhost:8080";
const port = Number(process.env.PORT ?? 4021);
const networks: HemiNetwork[] = (process.env.SELLER_NETWORKS ?? "eip155:743111")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean)
  .map(parseNetwork);

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

const accepts: RouteConfig["accepts"] = networks.flatMap(network => [
  { scheme: "exact", network, payTo, price: price(usdcAsset(network), USDC_AMOUNT) },
  { scheme: "exact", network, payTo, price: price(btcAsset(network), BTC_AMOUNT) },
]);

const resourceServer = new x402ResourceServer(new HTTPFacilitatorClient({ url: facilitatorUrl }))
  .onAfterVerify(async ({ result, requirements }) => {
    if (result.isValid) {
      console.log(`[seller] verified ${requirements.amount} of ${requirements.asset} on ${requirements.network} from ${result.payer}`);
    } else {
      console.warn(`[seller] verify rejected (${requirements.network} ${requirements.asset}): ${result.invalidReason} ${result.invalidMessage ?? ""}`);
    }
  })
  // A rejection answered with 200 (this facilitator, the TS reference) reaches onAfterVerify above.
  // A facilitator that answers non-2xx, or one that cannot be reached, lands here instead.
  .onVerifyFailure(async ({ error, requirements }) => {
    console.warn(`[seller] verify rejected (${requirements.network} ${requirements.asset}): ${error.message}`);
  })
  .onAfterSettle(async ({ result, requirements }) => {
    console.log(
      `[seller] settled ${requirements.amount} of ${requirements.asset} on ${result.network} ` +
        `from ${result.payer}: tx ${result.transaction}`,
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

const app = express();

app.get("/health", (_req, res) => {
  res.json({ ok: true, networks, payTo, facilitator: facilitatorUrl });
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
  console.log(`[seller] listening on http://localhost:${port}  facilitator ${facilitatorUrl}  payTo ${payTo}`);
  for (const a of accepts as { network: string; price: AssetAmount }[]) {
    console.log(`[seller]   ${a.network}  ${a.price.amount} of ${a.price.asset}  ${JSON.stringify(a.price.extra)}`);
  }
});
