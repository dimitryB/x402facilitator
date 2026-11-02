/**
 * Hemi constants shared by the seller, buyer and tests.
 * Every value here is backed by an entry in DECISIONS.md.
 */
import { hemi, hemiSepolia } from "viem/chains";
import type { Address, Chain } from "viem";
import data from "./hemi.json" with { type: "json" };

export type HemiNetwork = "eip155:43111" | "eip155:743111";
export type TransferMethod = "eip3009" | "permit2";

export interface HemiAsset {
  symbol: string;
  address: Address;
  decimals: number;
  transferMethod: TransferMethod;
  eip2612: boolean;
  eip712?: { name: string; version: string };
  /** Solidity mapping slot of balanceOf, used only to fund wallets on local forks. */
  balanceSlot?: number;
}

export interface HemiNetworkInfo {
  network: HemiNetwork;
  name: string;
  chainId: number;
  chain: Chain;
  rpc: { primary: string; fallback: string };
  explorer: string;
  assets: Record<string, HemiAsset>;
}

export const CONTRACTS = data.contracts as Record<keyof typeof data.contracts, Address>;

const CHAINS: Record<HemiNetwork, Chain> = {
  "eip155:43111": hemi,
  "eip155:743111": hemiSepolia,
};

export const NETWORKS: Record<HemiNetwork, HemiNetworkInfo> = Object.fromEntries(
  (Object.entries(data.networks) as [HemiNetwork, (typeof data.networks)[HemiNetwork]][]).map(
    ([network, n]) => [
      network,
      {
        network,
        name: n.name,
        chainId: n.chainId,
        chain: CHAINS[network],
        rpc: n.rpc,
        explorer: n.explorer,
        assets: Object.fromEntries(
          Object.entries(n.assets).map(([symbol, a]) => {
            const { _note, ...rest } = a as typeof a & { _note?: string };
            return [symbol, { symbol, ...rest } as HemiAsset];
          }),
        ),
      },
    ],
  ),
) as Record<HemiNetwork, HemiNetworkInfo>;

export const MAINNET: HemiNetwork = "eip155:43111";
export const TESTNET: HemiNetwork = "eip155:743111";

/** The BTC asset per network: hemiBTC on mainnet, the tunnel's hBTC on testnet (D-008). */
export function btcAsset(network: HemiNetwork): HemiAsset {
  const assets = NETWORKS[network].assets;
  return assets.hemiBTC ?? assets.hBTC;
}

export function usdcAsset(network: HemiNetwork): HemiAsset {
  return NETWORKS[network].assets["USDC.e"];
}

export function txUrl(network: HemiNetwork, hash: string): string {
  return `${NETWORKS[network].explorer}/tx/${hash}`;
}

export function parseNetwork(value: string): HemiNetwork {
  if (value === MAINNET || value === TESTNET) return value;
  if (value === "mainnet" || value === "hemi") return MAINNET;
  if (value === "testnet" || value === "hemi-testnet" || value === "hemiSepolia") return TESTNET;
  throw new Error(`Unknown Hemi network: ${value}`);
}
