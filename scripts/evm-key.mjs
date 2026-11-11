#!/usr/bin/env node
// Uses an EVM private key without putting it on a command line, where any local user can read it (ps).
// The key comes from the environment variable named by the second argument; only the name is in argv.
// cast takes a raw key only as --private-key on its command line, hence this helper.
//
//   node scripts/evm-key.mjs address BUYER_PRIVATE_KEY
//   node scripts/evm-key.mjs send BUYER_PRIVATE_KEY <rpc-url> <to> <calldata>
//
// `address` prints the key's address. `send` signs one transaction to <to> with <calldata> (build it with
// `cast calldata`), sends it, waits for the receipt and prints {"status":"0x1"|"0x0","transactionHash":"0x…"}.
import { createPublicClient, createWalletClient, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const fail = message => {
  console.error(`evm-key: ${message}`);
  process.exit(1);
};
const [command, name, ...rest] = process.argv.slice(2);
if (!["address", "send"].includes(command) || !/^[A-Z][A-Z0-9_]*$/.test(name ?? "")) {
  fail("usage: evm-key.mjs address ENV_NAME | send ENV_NAME RPC_URL TO CALLDATA");
}
const raw = process.env[name] ?? "";
const key = raw.startsWith("0x") ? raw : `0x${raw}`;
if (!/^0x[0-9a-fA-F]{64}$/.test(key)) fail(`${name} is not set to a 32-byte hex private key`);
const account = privateKeyToAccount(key);

if (command === "address") {
  console.log(account.address);
} else {
  const [rpc, to, data] = rest;
  if (!rpc || !/^0x[0-9a-fA-F]{40}$/.test(to ?? "") || !/^0x(?:[0-9a-fA-F]{2})*$/.test(data ?? "")) {
    fail("usage: evm-key.mjs send ENV_NAME RPC_URL TO CALLDATA");
  }
  const transport = http(rpc, { timeout: 60_000 });
  try {
    // chain: null: the chain id comes from the RPC, which the calling script has already checked.
    const hash = await createWalletClient({ account, transport }).sendTransaction({ to, data, chain: null });
    const receipt = await createPublicClient({ transport }).waitForTransactionReceipt({ hash, timeout: 600_000 });
    console.log(JSON.stringify({ status: receipt.status === "success" ? "0x1" : "0x0", transactionHash: hash }));
  } catch (error) {
    fail(error?.shortMessage ?? error?.message ?? String(error));
  }
}
