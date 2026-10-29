/**
 * DoD: a successful /verify then /settle per asset and network, "Facilitator never holds funds"
 * (confirmed by reading chain state, not by assertion), and replay protection.
 *
 * Every payload is built by x402Client + ExactEvmScheme (the stock buyer code) for anvil #3,
 * which scripts/fork.sh funded with 1000 units of each token.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { erc20Abi, getAddress, parseEventLogs, type Address, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { btcAsset, CONTRACTS, MAINNET, TESTNET, usdcAsset, type HemiAsset, type HemiNetwork } from "@hemi-x402/shared";
import { ensurePermit2Approval, nonceOf, publicClient, tokenBalance } from "../lib/chain";
import { BUYER_KEY, FACILITATOR_SIGNER } from "../lib/env";
import { record, settle, verify } from "../lib/facilitator";
import { freshAddress, requirementsFor, signPayment } from "../lib/payments";
import { SPEC_INVALID_TRANSACTION_STATE, settleFailureViolations, verifyFailureViolations } from "../lib/spec";

const buyer = privateKeyToAccount(BUYER_KEY);
const PROXY = CONTRACTS.x402ExactPermit2Proxy;
const PERMIT2 = CONTRACTS.permit2;

interface Case {
  name: string;
  network: HemiNetwork;
  asset: HemiAsset;
  amount: bigint;
}
const CASES: Case[] = [
  { name: "mainnet fork, USDC.e, EIP-3009", network: MAINNET, asset: usdcAsset(MAINNET), amount: 1_000n }, // $0.001
  { name: "mainnet fork, hemiBTC, Permit2", network: MAINNET, asset: btcAsset(MAINNET), amount: 10n }, // 10 sats
  { name: "testnet fork, USDC.e, Permit2", network: TESTNET, asset: usdcAsset(TESTNET), amount: 1_000n },
  { name: "testnet fork, hBTC, Permit2", network: TESTNET, asset: btcAsset(TESTNET), amount: 10n },
];

interface Settled {
  c: Case;
  payTo: Address;
  requirements: PaymentRequirements;
  payment: PaymentPayload;
  tx: Hash;
}
const settled = new Map<string, Settled>();

const ALL_ASSETS = CASES.map(c => ({ network: c.network, asset: c.asset }));
/** Token balances of everything that must never hold payment funds: the facilitator signers and the proxy. */
async function custodyBalances(): Promise<Record<string, bigint>> {
  const out: Record<string, bigint> = {};
  for (const { network, asset } of ALL_ASSETS) {
    for (const [who, addr] of [["signer", FACILITATOR_SIGNER[network]], ["proxy", PROXY]] as const) {
      out[`${network} ${asset.symbol} ${who} ${addr}`] = await tokenBalance(network, asset, addr);
    }
  }
  return out;
}

let custodyBefore: Record<string, bigint>;
beforeAll(async () => {
  custodyBefore = await custodyBalances();
});

for (const c of CASES) {
  describe(c.name, () => {
    const payTo = freshAddress();
    let requirements: PaymentRequirements;
    let payment: PaymentPayload;
    let tx: Hash;

    if (c.asset.transferMethod === "permit2") {
      it("buyer sends the one-time approve(Permit2), as a real buyer would", async () => {
        await ensurePermit2Approval(c.network, buyer, c.asset, c.amount);
        const allowance = await publicClient(c.network).readContract({
          address: c.asset.address,
          abi: erc20Abi,
          functionName: "allowance",
          args: [buyer.address, PERMIT2],
        });
        expect(allowance).toBeGreaterThanOrEqual(c.amount);
      });
    }

    it("/verify returns isValid true with the payer", async () => {
      requirements = requirementsFor(c.network, c.asset, payTo, c.amount);
      payment = await signPayment(buyer, requirements);
      expect(payment.accepted).toEqual(requirements);
      expect(Object.keys(payment.payload)).toContain(
        c.asset.transferMethod === "permit2" ? "permit2Authorization" : "authorization",
      );

      const res = await verify(payment, requirements);
      record(`verify ok: ${c.name}`, res);
      expect(res.status).toBe(200);
      // §5.4.2: invalidReason is omitted when valid.
      expect(res.body).toEqual({ isValid: true, payer: buyer.address });
    });

    it("/settle succeeds; payTo gains exactly the amount and the payer loses exactly the amount", async () => {
      const payerBefore = await tokenBalance(c.network, c.asset, buyer.address);
      const payToBefore = await tokenBalance(c.network, c.asset, payTo);

      const res = await settle(payment, requirements);
      record(`settle ok: ${c.name}`, res);
      expect(res.status).toBe(200);
      // §5.3.2 / §7.2 success shape; errorReason is omitted on success.
      expect(res.body).toEqual({
        success: true,
        payer: buyer.address,
        transaction: expect.stringMatching(/^0x[0-9a-f]{64}$/),
        network: c.network,
      });
      tx = res.body.transaction as Hash;
      settled.set(c.name, { c, payTo, requirements, payment, tx });

      const receipt = await publicClient(c.network).getTransactionReceipt({ hash: tx });
      expect(receipt.status).toBe("success");
      expect(await tokenBalance(c.network, c.asset, payTo)).toBe(payToBefore + c.amount);
      expect(await tokenBalance(c.network, c.asset, buyer.address)).toBe(payerBefore - c.amount);
    });

    it("the settle tx is sent by the facilitator signer and moves tokens payer -> payTo directly", async () => {
      const receipt = await publicClient(c.network).getTransactionReceipt({ hash: tx });
      expect(getAddress(receipt.from)).toBe(FACILITATOR_SIGNER[c.network]);
      // EIP-3009: the signer calls the token itself. Permit2: the signer calls the x402 proxy.
      expect(getAddress(receipt.to!)).toBe(c.asset.transferMethod === "eip3009" ? c.asset.address : PROXY);

      const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs });
      // Exactly one token movement in the whole tx, straight from the payer to payTo.
      expect(
        transfers.map(t => ({ token: getAddress(t.address), from: t.args.from, to: t.args.to, value: t.args.value })),
      ).toEqual([{ token: c.asset.address, from: buyer.address, to: payTo, value: c.amount }]);
    });
  });
}

describe("facilitator never holds funds", () => {
  it("signer and proxy token balances are zero before and after all settles", async () => {
    expect(settled.size, "every settle above must have run").toBe(CASES.length);
    const after = await custodyBalances();
    const zero = Object.fromEntries(Object.keys(after).map(k => [k, 0n]));
    expect(custodyBefore).toEqual(zero);
    expect(after).toEqual(zero);
  });

  it("the proxy every Permit2 settle went through is wired to canonical Permit2 on both forks", async () => {
    const abi = [{ type: "function", name: "PERMIT2", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] }] as const;
    for (const network of [MAINNET, TESTNET]) {
      const permit2 = await publicClient(network).readContract({ address: PROXY, abi, functionName: "PERMIT2" });
      expect(getAddress(permit2)).toBe(PERMIT2);
    }
  });
});

/**
 * Replay: the same payload settled (and verified) a second time. EIP-3009 and Permit2 nonces are
 * single-use on chain, so it must fail without moving funds or broadcasting anything.
 *
 * The spec (§9) has no replay-specific code. The patched facilitator answers `invalid_transaction_state`,
 * "Blockchain transaction failed or was rejected": the chain rejects the transfer because the
 * authorization's nonce is already spent (facilitator/x402-rs/patches 0005 explains the choice).
 * Stock x402-rs answered HTTP 500 "unexpected_error", which is not a §9 code.
 */
describe("replay", () => {
  const replays = [
    ["EIP-3009", "mainnet fork, USDC.e, EIP-3009"],
    ["Permit2", "testnet fork, USDC.e, Permit2"],
  ] as const;

  for (const [method, caseName] of replays) {
    it(`${method}: settling the same payload again fails with "${SPEC_INVALID_TRANSACTION_STATE}" and moves nothing`, async () => {
      const s = settled.get(caseName)!;
      expect(s, `${caseName} must have settled first`).toBeDefined();
      const { c } = s;
      const nonceBefore = await nonceOf(c.network, FACILITATOR_SIGNER[c.network]);
      const payerBefore = await tokenBalance(c.network, c.asset, buyer.address);
      const payToBefore = await tokenBalance(c.network, c.asset, s.payTo);

      const res = await settle(s.payment, s.requirements);
      record(`settle replay: ${method}`, res);
      expect(
        settleFailureViolations(res.body, {
          reasons: [SPEC_INVALID_TRANSACTION_STATE],
          payer: buyer.address,
          network: c.network,
          broadcast: false,
        }),
      ).toEqual([]);
      expect(res.status).toBe(400);

      expect(await tokenBalance(c.network, c.asset, buyer.address)).toBe(payerBefore);
      expect(await tokenBalance(c.network, c.asset, s.payTo)).toBe(payToBefore);
      // No transaction was broadcast for the replay: the facilitator's gas is not burnt either.
      expect(await nonceOf(c.network, FACILITATOR_SIGNER[c.network])).toBe(nonceBefore);
    });

    it(`${method}: verifying the spent payload also answers "${SPEC_INVALID_TRANSACTION_STATE}"`, async () => {
      const s = settled.get(caseName)!;
      const res = await verify(s.payment, s.requirements);
      record(`verify replay: ${method}`, res);
      expect(
        verifyFailureViolations(res.body, { reason: SPEC_INVALID_TRANSACTION_STATE, payer: buyer.address }),
      ).toEqual([]);
      expect(res.status).toBe(400);
    });
  }
});
