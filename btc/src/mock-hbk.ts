/**
 * Local-fork only: write a fabricated Bitcoin transaction into the MockBitcoinKit that scripts/fork.sh
 * places at the real hBK address (contracts/test/mocks/MockBitcoinKit.sol, stream A), so the facilitator's
 * X402BtcSettler.verify sees a "Bitcoin payment" without any Bitcoin network.
 *
 * Every function here refuses an RPC URL that is not a local address. Nothing in this file touches Bitcoin.
 *
 * Mock setter (agreed in docs/phase2/DESIGN.md, stream A):
 *   setTx(bytes32 txid, Output[] outputs, uint32 confirmations)
 * with hBK's Output struct (hemilabs/bitcoin-tunnel-contracts contracts/bitcoinkit/BitcoinKitStructs.sol),
 * `txid` in display byte order, `confirmations` in hBK's own count (Bitcoin confirmations + the settler's
 * CONFIRMATION_OFFSET).
 */
import { bytesToHex } from "@noble/hashes/utils";
import { createPublicClient, createTestClient, createWalletClient, http, type Address, type Hash, type Hex } from "viem";
import type { PayBtc } from "./client.js";

const outputComponents = [
  { name: "outValue", type: "uint256" },
  { name: "script", type: "bytes" },
  { name: "outputAddress", type: "string" },
  { name: "isOpReturn", type: "bool" },
  { name: "opReturnData", type: "bytes" },
  { name: "isSpent", type: "bool" },
  { name: "fullScriptLength", type: "uint256" },
  { name: "containsFullScript", type: "bool" },
  {
    name: "spentDetail",
    type: "tuple",
    components: [
      { name: "spendingTxId", type: "bytes32" },
      { name: "inputIndex", type: "uint256" },
    ],
  },
] as const;

export const mockBitcoinKitAbi = [
  {
    type: "function",
    name: "setTx",
    stateMutability: "nonpayable",
    inputs: [
      { name: "txid", type: "bytes32" },
      { name: "outputs", type: "tuple[]", components: outputComponents },
      { name: "confirmations", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "getTxConfirmations",
    stateMutability: "view",
    inputs: [{ name: "txId", type: "bytes32" }],
    outputs: [{ name: "confirmations", type: "uint32" }],
  },
  {
    type: "function",
    name: "getSpecificTxOutput",
    stateMutability: "view",
    inputs: [
      { name: "txId", type: "bytes32" },
      { name: "outputIndex", type: "uint32" },
    ],
    outputs: [{ name: "", type: "tuple", components: outputComponents }],
  },
] as const;

export interface FakeOutput {
  /** scriptPubKey, hex with or without 0x. */
  script: string;
  sats: bigint;
  isSpent?: boolean;
}

const LOCAL_RPC = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\]|host\.docker\.internal)(:\d+)?(\/|$)/;
/** An address nobody holds a key for; impersonated on the fork to send setTx. */
export const MOCK_HBK_SEEDER: Address = "0x00000000000000000000000000000000b7c5eed0";

export function assertLocalRpc(rpcUrl: string): void {
  if (!LOCAL_RPC.test(rpcUrl)) throw new Error(`refusing ${rpcUrl}: the mock hBK exists only on a local fork (127.0.0.1 / localhost)`);
}

/** 32 random bytes as a txid in display order (64 lowercase hex). */
export function fakeTxid(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
}

const hex0x = (s: string): Hex => (s.startsWith("0x") ? s : `0x${s}`) as Hex;

/** hBK's Output for a script, as real hBK fills it for a segwit output (no address, no OP_RETURN parsing). */
export function hbkOutput(o: FakeOutput) {
  const script = hex0x(o.script);
  return {
    outValue: o.sats,
    script,
    outputAddress: "",
    isOpReturn: false,
    opReturnData: "0x" as Hex,
    isSpent: o.isSpent ?? false,
    fullScriptLength: BigInt((script.length - 2) / 2),
    containsFullScript: true,
    spentDetail: { spendingTxId: `0x${"00".repeat(32)}` as Hex, inputIndex: 0n },
  };
}

export interface SeedTx {
  rpcUrl: string;
  hbk: Address;
  txid: string;
  outputs: FakeOutput[];
  /** hBK's raw count: Bitcoin confirmations + CONFIRMATION_OFFSET. */
  hbkConfirmations: number;
}

/** setTx on the mock hBK, sent from an impersonated address; resolves once mined. Rewriting a txid replaces it. */
export async function seedMockHbkTx(s: SeedTx): Promise<Hash> {
  assertLocalRpc(s.rpcUrl);
  const transport = http(s.rpcUrl);
  const test = createTestClient({ mode: "anvil", transport });
  await test.impersonateAccount({ address: MOCK_HBK_SEEDER });
  await test.setBalance({ address: MOCK_HBK_SEEDER, value: 10n ** 18n });
  const wallet = createWalletClient({ account: MOCK_HBK_SEEDER, transport });
  const hash = await wallet.writeContract({
    chain: null,
    address: s.hbk,
    abi: mockBitcoinKitAbi,
    functionName: "setTx",
    args: [hex0x(s.txid), s.outputs.map(hbkOutput), s.hbkConfirmations],
  });
  const receipt = await createPublicClient({ transport }).waitForTransactionReceipt({ hash, pollingInterval: 100 });
  if (receipt.status !== "success") throw new Error(`setTx ${hash} reverted on ${s.rpcUrl}`);
  return hash;
}

export interface MockHbkPayOptions {
  rpcUrl: string;
  hbk: Address;
  /** Bitcoin confirmations to record (default 1). */
  bitcoinConfirmations?: number;
  /** hBK count = Bitcoin confirmations + this (default 1, the mainnet value in DESIGN.md). */
  confirmationOffset?: number;
  log?: (message: string) => void;
}

/**
 * A PayBtc that "pays" by recording a fabricated transaction in the mock hBK: output 0 is a decoy to
 * another script, output 1 pays the derived address, so vout handling is exercised. Local forks only.
 */
export function mockHbkPayBtc(o: MockHbkPayOptions): PayBtc {
  assertLocalRpc(o.rpcUrl);
  return async (address, sats, ctx) => {
    const txid = fakeTxid();
    const decoy = { script: `0014${"ab".repeat(20)}`, sats: 12_345n };
    const confirmations = o.bitcoinConfirmations ?? 1;
    await seedMockHbkTx({
      rpcUrl: o.rpcUrl,
      hbk: o.hbk,
      txid,
      outputs: [decoy, { script: ctx.script, sats }],
      hbkConfirmations: confirmations + (o.confirmationOffset ?? 1),
    });
    o.log?.(`mock hBK at ${o.hbk}: fake tx ${txid} pays ${sats} sats to ${address} (vout 1), ${confirmations} confirmation(s)`);
    return { txid, vout: 1 };
  };
}
