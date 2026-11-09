/**
 * Bitcoin L1 payments on the local forks: there is no Bitcoin network here. scripts/fork.sh puts the mock
 * hBK (contracts/test/mocks/MockBitcoinKit.sol) at the real hBK address on each fork and deploys
 * X402BtcSettler with the facilitator's fork signer as SETTLER. A "payment" is a fabricated transaction
 * written into the mock; the facilitator reads it through the settler exactly as it would read a real one.
 *
 * Addresses: the mock's from shared/hemi.json (`networks[<hemi>].contracts.hbk`); the settler's from the
 * facilitator's /supported kind (`extra.settler`), falling back to shared/hemi.json (the fork deployment
 * may differ from the predicted mainnet address because SETTLER differs).
 */
import { parseAbi, parseAbiItem, type Address, type Hex } from "viem";
import hemiJson from "@hemi-x402/shared/hemi.json" with { type: "json" };
import { MAINNET, TESTNET, type HemiNetwork } from "@hemi-x402/shared";
import { BTC_MAINNET, BTC_TESTNET3, type BtcNetwork } from "@hemi-x402/btc";
import { fakeTxid, hemiBtcContracts, seedMockHbkTx, setMockHbkConfirmations, type FakeOutput } from "@hemi-x402/btc/mock-hbk";
import vectors from "@hemi-x402/btc/test-vectors.json" with { type: "json" };
import { publicClient } from "./chain";
import { FORK_RPC } from "./env";

export const BTC_NETWORKS_UNDER_TEST: BtcNetwork[] = [BTC_MAINNET, BTC_TESTNET3];
export const HEMI_OF: Record<BtcNetwork, HemiNetwork> = { [BTC_MAINNET]: MAINNET, [BTC_TESTNET3]: TESTNET };

/** The seller's account key per network: the vector keys (BIP84 test mnemonic), public test data. */
export const TEST_XPUB: Record<BtcNetwork, string> = {
  [BTC_MAINNET]: vectors.vectors.find(v => v.network === BTC_MAINNET)!.payTo,
  [BTC_TESTNET3]: vectors.vectors.find(v => v.network === BTC_TESTNET3)!.payTo,
};

export const settlerAbi = parseAbi([
  "function HBK() view returns (address)",
  "function SETTLER() view returns (address)",
  "function CONFIRMATION_OFFSET() view returns (uint32)",
  "function settledBy(bytes32 txid, uint32 vout) view returns (bytes32)",
]);
export const settledEvent = parseAbiItem(
  "event Settled(bytes32 indexed txid, uint32 vout, bytes32 indexed scriptPubKeyHash, uint64 sats, bytes32 indexed paymentRef, address settler)",
);

export interface BtcFork {
  network: BtcNetwork;
  hemi: HemiNetwork;
  rpc: string;
  hbk: Address;
  settler: Address;
  /** hBK confirmations minus Bitcoin confirmations, read from the settler. */
  offset: number;
}

/** Everything needed to fake payments for `network`, or the reason it cannot be done on these forks. */
export async function btcFork(network: BtcNetwork, kindExtra: Record<string, unknown> | undefined): Promise<BtcFork | string> {
  const hemi = HEMI_OF[network];
  const fromJson = hemiBtcContracts(hemiJson, hemi);
  const settler = (kindExtra?.settler as Address | undefined) ?? fromJson.x402BtcSettler;
  if (!fromJson.hbk) return `no hBK address for ${hemi} in shared/hemi.json`;
  if (!settler) return `no settler address for ${network} (neither /supported extra.settler nor shared/hemi.json)`;
  const client = publicClient(hemi);
  if (!(await client.getCode({ address: settler }))) return `no code at the settler ${settler} on the ${hemi} fork`;
  if (!(await client.getCode({ address: fromJson.hbk }))) return `no code at hBK ${fromJson.hbk} on the ${hemi} fork`;
  const offset = await client.readContract({ address: settler, abi: settlerAbi, functionName: "CONFIRMATION_OFFSET" });
  return { network, hemi, rpc: FORK_RPC[hemi], hbk: fromJson.hbk, settler, offset: Number(offset) };
}

const DECOY: FakeOutput = { script: `0014${"ab".repeat(20)}`, sats: 12_345n };

/**
 * Write a fake Bitcoin transaction into the mock hBK: decoy outputs before `vout`, then `sats` to `script`.
 * `confirmations` are Bitcoin confirmations; the mock stores hBK's count (+ the settler's offset).
 */
export async function seedBtcPayment(
  fork: BtcFork,
  p: { script: string; sats: bigint; vout?: number; confirmations?: number; txid?: string },
): Promise<{ txid: string; vout: number }> {
  const vout = p.vout ?? 1;
  const txid = p.txid ?? fakeTxid();
  const outputs = [...Array.from({ length: vout }, () => DECOY), { script: p.script, sats: p.sats }];
  await seedMockHbkTx({ rpcUrl: fork.rpc, hbk: fork.hbk, txid, outputs, hbkConfirmations: (p.confirmations ?? 1) + fork.offset });
  return { txid, vout };
}

/** A new Bitcoin block: set the transaction's Bitcoin confirmations. */
export async function setBtcConfirmations(fork: BtcFork, txid: string, confirmations: number): Promise<void> {
  await setMockHbkConfirmations(fork.rpc, fork.hbk, txid, confirmations + fork.offset);
}

export const bytes32 = (txid: string): Hex => `0x${txid}`;

export function settledBy(fork: BtcFork, txid: string, vout: number): Promise<Hex> {
  return publicClient(fork.hemi).readContract({ address: fork.settler, abi: settlerAbi, functionName: "settledBy", args: [bytes32(txid), vout] });
}

/**
 * The Settled events the settler emitted for `txid` since `fromBlock` (a block on the fork: asking an
 * anvil fork for logs before its fork point would send the whole range to the upstream RPC).
 */
export async function settledEvents(fork: BtcFork, txid: string, fromBlock: bigint) {
  return publicClient(fork.hemi).getLogs({
    address: fork.settler,
    event: settledEvent,
    args: { txid: bytes32(txid) },
    fromBlock,
    toBlock: "latest",
  });
}
