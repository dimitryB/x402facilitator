/** viem clients and helpers for the local forks. Every write here lands on a local anvil fork. */
import {
  createPublicClient,
  createTestClient,
  createWalletClient,
  encodeAbiParameters,
  erc20Abi,
  http,
  keccak256,
  numberToHex,
  type Account,
  type Address,
  type PublicClient,
} from "viem";
import { NETWORKS, type HemiAsset, type HemiNetwork } from "@hemi-x402/shared";
import {
  createPermit2ApprovalTx,
  getPermit2AllowanceReadParams,
} from "@x402/evm/exact/client";
import { FORK_RPC } from "./env";

const POLL_MS = 200;
const publicClients = new Map<HemiNetwork, PublicClient>();

export function publicClient(network: HemiNetwork): PublicClient {
  let client = publicClients.get(network);
  if (!client) {
    client = createPublicClient({
      chain: NETWORKS[network].chain,
      transport: http(FORK_RPC[network]),
      pollingInterval: POLL_MS,
    });
    publicClients.set(network, client);
  }
  return client;
}

export function testClient(network: HemiNetwork) {
  return createTestClient({ mode: "anvil", chain: NETWORKS[network].chain, transport: http(FORK_RPC[network]) });
}

export function walletClient(network: HemiNetwork, account: Account) {
  return createWalletClient({ account, chain: NETWORKS[network].chain, transport: http(FORK_RPC[network]) });
}

export function tokenBalance(network: HemiNetwork, asset: HemiAsset, owner: Address): Promise<bigint> {
  return publicClient(network).readContract({
    address: asset.address,
    abi: erc20Abi,
    functionName: "balanceOf",
    args: [owner],
  });
}

export function nonceOf(network: HemiNetwork, address: Address): Promise<number> {
  return publicClient(network).getTransactionCount({ address });
}

/** Give an address native ETH on the fork (anvil_setBalance). */
export async function fundEth(network: HemiNetwork, address: Address, wei = 10n ** 18n): Promise<void> {
  await testClient(network).setBalance({ address, value: wei });
}

/**
 * Give an address tokens on the fork by writing its balanceOf mapping slot, exactly like
 * scripts/fork.sh does for the buyer (slots probed in DECISIONS.md D-013).
 */
export async function fundToken(network: HemiNetwork, asset: HemiAsset, owner: Address, amount: bigint): Promise<void> {
  if (asset.balanceSlot === undefined) throw new Error(`${asset.symbol} has no balanceSlot in shared/hemi.json`);
  const slot = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [owner, BigInt(asset.balanceSlot)]),
  );
  await testClient(network).setStorageAt({ address: asset.address, index: slot, value: numberToHex(amount, { size: 32 }) });
  const actual = await tokenBalance(network, asset, owner);
  if (actual !== amount) throw new Error(`funding ${asset.symbol} for ${owner} failed: balance ${actual}`);
}

/**
 * The buyer's one-time on-chain step for Permit2 assets: approve(Permit2, max), built with the
 * SDK's own helpers, the same way buyer/pay.ts does it. Returns the approval tx hash, or null
 * if the allowance was already enough.
 */
export async function ensurePermit2Approval(
  network: HemiNetwork,
  account: Account,
  asset: HemiAsset,
  amount: bigint,
): Promise<`0x${string}` | null> {
  const client = publicClient(network);
  const allowance = await client.readContract(
    getPermit2AllowanceReadParams({ tokenAddress: asset.address, ownerAddress: account.address }),
  );
  if (allowance >= amount) return null;
  const tx = createPermit2ApprovalTx(asset.address);
  const hash = await walletClient(network, account).sendTransaction({ to: tx.to, data: tx.data, chain: NETWORKS[network].chain });
  const receipt = await client.waitForTransactionReceipt({ hash, pollingInterval: POLL_MS });
  if (receipt.status !== "success") throw new Error(`approve(Permit2) reverted: ${hash}`);
  return hash;
}

/**
 * Turn `address` into a contract wallet on the fork: give it ETH, tokens and, for Permit2 assets, the
 * one-time approve(Permit2) (sent while it is still an EOA, through anvil_impersonateAccount), then set
 * `bytecode` as its code (anvil_setCode).
 */
export async function makeContractWallet(
  network: HemiNetwork,
  asset: HemiAsset,
  address: Address,
  tokens: bigint,
  bytecode: `0x${string}`,
): Promise<void> {
  const test = testClient(network);
  await fundEth(network, address);
  await fundToken(network, asset, address, tokens);
  if (asset.transferMethod === "permit2") {
    await test.impersonateAccount({ address });
    try {
      const tx = createPermit2ApprovalTx(asset.address);
      const wallet = createWalletClient({ account: address, chain: NETWORKS[network].chain, transport: http(FORK_RPC[network]) });
      const hash = await wallet.sendTransaction({ to: tx.to, data: tx.data, chain: NETWORKS[network].chain });
      const receipt = await publicClient(network).waitForTransactionReceipt({ hash, pollingInterval: POLL_MS });
      if (receipt.status !== "success") throw new Error(`approve(Permit2) from ${address} reverted`);
    } finally {
      await test.stopImpersonatingAccount({ address });
    }
  }
  await test.setCode({ address, bytecode });
}
