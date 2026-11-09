/**
 * Demo x402 buyer: pays the seller's GET /echo in one asset on one Hemi network, or in native BTC on
 * Bitcoin L1 (btc-l1.ts).
 *
 *   npm run pay -w buyer -- --asset usdc|btc --network testnet|mainnet [--url URL] [--max BASE_UNITS]
 *   npm run pay -w buyer -- --asset btc-l1 --network btc-testnet3|btc-mainnet [--poll 60] [--resume ID] [--fee-rate N]
 *
 * Permit2 assets (every asset except mainnet USDC.e, see DECISIONS.md D-001) need a one-time
 * approve(Permit2, max) from the buyer. The script checks the allowance and sends that
 * transaction if needed; it is the only transaction the buyer ever sends. The payment itself
 * is an off-chain signature that the facilitator settles.
 */
import { parseArgs } from "node:util";
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  fallback,
  formatUnits,
  http,
  type Address,
  type Hex,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { decodePaymentResponseHeader, wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import type { PaymentRequirements } from "@x402/core/types";
import {
  createPermit2ApprovalTx,
  ExactEvmScheme,
  getPermit2AllowanceReadParams,
} from "@x402/evm/exact/client";
import { btcAsset, NETWORKS, parseNetwork, txUrl, usdcAsset, MAINNET } from "@hemi-x402/shared";
import { runBtcL1 } from "./btc-l1.js";

function fail(message: string): never {
  console.error(`[buyer] ${message}`);
  process.exit(1);
}

const { values: args } = parseArgs({
  options: {
    asset: { type: "string", default: "usdc" },
    // Default: testnet for the Hemi assets, btc-testnet3 for btc-l1.
    network: { type: "string" },
    // Default SELLER_URL, then http://localhost:4021/echo?hello=hemi; --resume uses the journaled URL.
    url: { type: "string" },
    max: { type: "string" },
    // btc-l1 only (btc-l1.ts).
    poll: { type: "string", default: "60" },
    resume: { type: "string" },
    "fee-rate": { type: "string" },
    "stub-pay": { type: "string" },
  },
});

/** The Hemi assets: an off-chain signature the facilitator settles on Hemi. */
async function evm(): Promise<void> {
  const network = parseNetwork(args.network ?? "testnet");
  if (network === MAINNET && process.env.ALLOW_MAINNET !== "yes") {
    fail("refusing --network mainnet: it spends real funds. Set ALLOW_MAINNET=yes to proceed.");
  }
  const info = NETWORKS[network];
  const asset =
    args.asset === "usdc" ? usdcAsset(network) : args.asset === "btc" ? btcAsset(network) : fail("--asset must be usdc, btc or btc-l1");
  // Per-payment cap in base units: about $0.01 by default (10 sats is ~$0.01 at ~$100k/BTC).
  const maxAmount = args.max ?? (args.asset === "usdc" ? "10000" : "10");

  const key = process.env.BUYER_PRIVATE_KEY;
  if (!key || !/^0x[0-9a-fA-F]{64}$/.test(key)) fail("BUYER_PRIVATE_KEY must be a 0x-prefixed 32-byte hex key");
  const account = privateKeyToAccount(key as Hex);

  // BUYER_RPC_URL wins; otherwise dRPC with the Hemi public RPC as fallback.
  const transport = process.env.BUYER_RPC_URL
    ? http(process.env.BUYER_RPC_URL)
    : fallback([http(info.rpc.primary), http(info.rpc.fallback)]);
  const publicClient = createPublicClient({ chain: info.chain, transport });
  const walletClient = createWalletClient({ account, chain: info.chain, transport });

  // Transactions sent through a local RPC (an anvil fork) never reach the public explorer; say so.
  const localRpc = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|host\.docker\.internal)(:|\/|$)/.test(
    process.env.BUYER_RPC_URL ?? "",
  );
  const explorerLink = (hash: string) =>
    localRpc ? `${txUrl(network, hash)}  (local fork: not on the explorer)` : txUrl(network, hash);

  const fmt = (v: bigint) => `${formatUnits(v, asset.decimals)} ${asset.symbol}`;
  const balanceOf = (owner: Address) =>
    publicClient.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] });

  /** The one on-chain step a Permit2 buyer needs: approve Permit2 once, for the max amount. */
  async function ensurePermit2Approval(req: PaymentRequirements): Promise<void> {
    if (req.extra?.assetTransferMethod !== "permit2") return;
    const token = req.asset as Address;
    const allowance = await publicClient.readContract(
      getPermit2AllowanceReadParams({ tokenAddress: token, ownerAddress: account.address }),
    );
    if (allowance >= BigInt(req.amount)) {
      console.log(`[buyer] Permit2 allowance ok (${allowance})`);
      return;
    }
    const tx = createPermit2ApprovalTx(token);
    const hash = await walletClient.sendTransaction({ to: tx.to, data: tx.data });
    console.log(`[buyer] approve(Permit2, max) sent: ${hash}`);
    console.log(`[buyer]   ${explorerLink(hash)}`);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== "success") fail(`approval transaction reverted: ${hash}`);
  }

  async function main(): Promise<void> {
    const chainId = await publicClient.getChainId();
    if (chainId !== info.chainId) fail(`RPC reports chain ${chainId}, expected ${info.chainId} for ${network}`);

    let chosen: PaymentRequirements | undefined;
    let payToBefore = 0n;

    const client = new x402Client()
      .register(network, new ExactEvmScheme(account))
      // Hemi assets are not SDK default assets, so spend controls reject them unless allow-listed.
      .setSpendControls({ allowedAssets: [{ network, asset: asset.address, maxAmountPerPayment: maxAmount }] })
      // Of the seller's accepts, keep only the requested asset on the requested network.
      .registerPolicy((_version, reqs) =>
        reqs.filter(r => r.network === network && r.asset.toLowerCase() === asset.address.toLowerCase()),
      )
      .onBeforePaymentCreation(async ({ selectedRequirements: req }) => {
        chosen = req;
        console.log(
          `[buyer] paying ${req.amount} base units of ${asset.symbol} (${req.asset}) on ${network} ` +
            `to ${req.payTo} via ${req.extra?.assetTransferMethod ?? "eip3009"}`,
        );
        payToBefore = await balanceOf(req.payTo as Address);
        await ensurePermit2Approval(req);
      });

    const buyerBefore = await balanceOf(account.address);
    console.log(`[buyer] buyer ${account.address} holds ${fmt(buyerBefore)}`);
    const url = args.url ?? DEFAULT_URL;
    console.log(`[buyer] GET ${url}`);

    const fetchWithPayment = wrapFetchWithPayment(fetch, client);
    const response = await fetchWithPayment(url);
    const body = await response.text();

    if (!response.ok) {
      let reason = "";
      const required = response.headers.get("PAYMENT-REQUIRED");
      if (required) {
        reason = new x402HTTPClient(client).getPaymentRequiredResponse(name => response.headers.get(name)).error ?? "";
      }
      fail(`seller answered ${response.status}${reason ? ` (${reason})` : ""}: ${body}`);
    }

    const header = response.headers.get("PAYMENT-RESPONSE");
    if (!header) fail(`no PAYMENT-RESPONSE header; body: ${body}`);
    const settlement = decodePaymentResponseHeader(header);

    console.log(`[buyer] asset:    ${asset.symbol} ${asset.address} (${network})`);
    console.log(`[buyer] response: ${body}`);
    console.log(`[buyer] tx:       ${settlement.transaction}`);
    console.log(`[buyer] explorer: ${explorerLink(settlement.transaction)}`);
    if (chosen) {
      // Make sure this RPC has seen the settlement before reading balances after it.
      await publicClient.waitForTransactionReceipt({ hash: settlement.transaction as Hex, timeout: 60_000 });
      const payTo = chosen.payTo as Address;
      const [buyerAfter, payToAfter] = await Promise.all([balanceOf(account.address), balanceOf(payTo)]);
      console.log(`[buyer] buyer balance: ${fmt(buyerBefore)} -> ${fmt(buyerAfter)}`);
      console.log(`[buyer] payTo balance: ${fmt(payToBefore)} -> ${fmt(payToAfter)}`);
    }
  }

  await main();
}

const DEFAULT_URL = process.env.SELLER_URL ?? "http://localhost:4021/echo?hello=hemi";
const run = args.asset === "btc-l1" ? () => runBtcL1(args, DEFAULT_URL) : evm;
run().catch(error => fail(error instanceof Error ? error.message : String(error)));
