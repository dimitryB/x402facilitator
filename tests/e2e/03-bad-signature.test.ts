/**
 * DoD: "A failed-signature ... case ... return[s] the spec's error shapes".
 *
 * Two kinds of bad signature per transfer method:
 *   - tampered: a valid stock-client payload with one bit of `r` flipped;
 *   - wrong key: a stock-client payload signed by another key, with `from` rewritten to the victim.
 * The victim (`from`) holds tokens and, for Permit2, has approved Permit2, so the signature is the
 * only thing wrong.
 * Those run for EIP-3009 (USDC.e) and Permit2 (hemiBTC) on the mainnet fork, and for Permit2 (USDC.e) on
 * the testnet fork; the blocks after them run on the mainnet fork.
 *
 * Spec: specs/schemes/exact/scheme_exact_evm.md, EIP-3009 Phase 2 step 1 and Permit2 Phase 3 step 1
 * ("Verify ... signature is valid and recovers to ... from"); specs/x402-specification-v2.md §9
 * `invalid_exact_evm_payload_signature`: "Payment authorization signature is invalid or improperly signed";
 * shapes per §5.4.2/§7.1 (verify) and §5.3.2/§7.2 (settle). See tests/lib/spec.ts.
 *
 * The signature is checked first, before balance and allowance (EIP-3009 Phase 2 step 1; Permit2 Phase 3,
 * "The verifier must execute these checks in order", step 1). The last block below uses a payer with no
 * tokens and no Permit2 allowance, where checking balance or allowance first would answer
 * insufficient_funds or permit2_allowance_required instead.
 *
 * The last block uses contract-wallet payers (EIP-1271): code is set at `from` with anvil_setCode, and the
 * wallet's owner key signs. One wallet accepts every signature (isValidSignature returns 0x1626ba7e), one
 * accepts none. The accepting one must still settle; the other must get the §9 signature code.
 *
 * Stock x402-rs answered all of these with HTTP 500 "unexpected_error" and "payer": "" (and "network": ""
 * on settle), and checked balance and allowance before the signature; facilitator/x402-rs/patches 0002,
 * 0003 and 0008 fix that.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { erc20Abi, getAddress, parseEventLogs, serializeErc6492Signature, type Hex, type LocalAccount } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { btcAsset, MAINNET, TESTNET, usdcAsset, type HemiAsset, type HemiNetwork } from "@hemi-x402/shared";
import {
  ensurePermit2Approval,
  fundEth,
  fundToken,
  makeContractWallet,
  nonceOf,
  publicClient,
  tokenBalance,
} from "../lib/chain";
import { FACILITATOR_SIGNER } from "../lib/env";
import { record, settle, verify } from "../lib/facilitator";
import {
  contractWalletSigner,
  freshAccount,
  freshAddress,
  requirementsFor,
  signPayment,
  tamperSignature,
  withFrom,
  withSignature,
} from "../lib/payments";
import { snapshot, type Snapshot } from "../lib/snapshot";
import {
  SPEC_INSUFFICIENT_FUNDS,
  SPEC_INVALID_SIGNATURE,
  STATUS_VERDICT,
  settleFailureViolations,
  verifyFailureViolations,
} from "../lib/spec";

interface Method {
  method: "EIP-3009" | "Permit2";
  network: HemiNetwork;
  asset: HemiAsset;
  amount: bigint;
}
const METHODS: Method[] = [
  { method: "EIP-3009", network: MAINNET, asset: usdcAsset(MAINNET), amount: 1_000n },
  { method: "Permit2", network: MAINNET, asset: btcAsset(MAINNET), amount: 10n },
];
/** The first block also runs on the testnet fork, which the facilitator serves with its own signer. */
const METHODS_BOTH_NETWORKS: Method[] = [
  ...METHODS,
  { method: "Permit2", network: TESTNET, asset: usdcAsset(TESTNET), amount: 1_000n },
];

for (const m of METHODS_BOTH_NETWORKS) {
  describe(`bad signature, ${m.method} (${m.asset.symbol} on ${m.network})`, () => {
    let victim: LocalAccount;
    let attacker: LocalAccount;
    const payTo = freshAddress();
    let requirements: PaymentRequirements;
    let genuine: PaymentPayload;

    beforeAll(async () => {
      victim = freshAccount();
      attacker = freshAccount();
      await fundEth(m.network, victim.address);
      await fundToken(m.network, m.asset, victim.address, 1_000_000n);
      if (m.asset.transferMethod === "permit2") await ensurePermit2Approval(m.network, victim, m.asset, m.amount);
      requirements = requirementsFor(m.network, m.asset, payTo, m.amount);
      genuine = await signPayment(victim, requirements);
    });

    it("control: the untampered payload verifies", async () => {
      const res = await verify(genuine, requirements);
      expect(res.body).toEqual({ isValid: true, payer: victim.address });
    });

    const variants: [string, () => Promise<PaymentPayload>][] = [
      ["tampered signature", async () => withSignature(genuine, tamperSignature((genuine.payload as { signature: Hex }).signature))],
      ["signed by a different key than `from`", async () => withFrom(await signPayment(attacker, requirements), victim.address)],
    ];

    for (const [variant, build] of variants) {
      describe(variant, () => {
        let bad: PaymentPayload;
        let before: Snapshot;

        beforeAll(async () => {
          bad = await build();
          before = await snapshot(m.network, m.asset, victim.address, payTo);
        });

        it(`/verify answers isValid false, "${SPEC_INVALID_SIGNATURE}", in the spec's §7.1 shape`, async () => {
          const res = await verify(bad, requirements);
          record(`verify bad signature: ${m.method}, ${variant}`, res);
          expect(verifyFailureViolations(res.body, { reason: SPEC_INVALID_SIGNATURE, payer: victim.address })).toEqual([]);
          expect(res.body.payer).toBe(victim.address);
          expect(res.body.invalidMessage).toEqual(expect.any(String));
          // A verdict on a readable payload: an ordinary answer, as the TS reference facilitator gives.
          expect(res.status).toBe(STATUS_VERDICT);
        });

        it(`/settle answers success false, "${SPEC_INVALID_SIGNATURE}", in the spec's §7.2 shape; nothing moves`, async () => {
          const res = await settle(bad, requirements);
          record(`settle bad signature: ${m.method}, ${variant}`, res);
          expect(
            settleFailureViolations(res.body, {
              reasons: [SPEC_INVALID_SIGNATURE],
              payer: victim.address,
              network: m.network,
              broadcast: false,
            }),
          ).toEqual([]);
          expect(res.body.payer).toBe(victim.address);
          expect(res.status).toBe(STATUS_VERDICT);
          // Rejected before any transaction: no tokens moved and the facilitator's nonce is unchanged.
          expect(await snapshot(m.network, m.asset, victim.address, payTo)).toEqual(before);
        });
      });
    }
  });
}

describe("bad signature from a payer with no tokens and no Permit2 allowance: the signature is checked first", () => {
  for (const m of METHODS) {
    describe(`${m.method} (${m.asset.symbol} on ${m.network})`, () => {
      let poor: LocalAccount;
      let requirements: PaymentRequirements;
      let genuine: PaymentPayload;
      const payTo = freshAddress();

      beforeAll(async () => {
        poor = freshAccount(); // no ETH, no tokens, no approval
        requirements = requirementsFor(m.network, m.asset, payTo, m.amount);
        genuine = await signPayment(poor, requirements);
      });

      it("control: the genuine payload fails on funds (EIP-3009) or allowance (Permit2)", async () => {
        const res = await verify(genuine, requirements);
        expect(res.body.isValid).toBe(false);
        expect(res.body.invalidReason).toBe(
          m.asset.transferMethod === "permit2" ? "permit2_allowance_required" : SPEC_INSUFFICIENT_FUNDS,
        );
      });

      const variants: [string, () => Promise<PaymentPayload>][] = [
        ["tampered signature", async () => withSignature(genuine, tamperSignature((genuine.payload as { signature: Hex }).signature))],
        ["signed by a different key than `from`", async () => withFrom(await signPayment(freshAccount(), requirements), poor.address)],
      ];
      for (const [variant, build] of variants) {
        it(`${variant}: /verify and /settle answer "${SPEC_INVALID_SIGNATURE}"`, async () => {
          const bad = await build();
          const before = await snapshot(m.network, m.asset, poor.address, payTo);

          const v = await verify(bad, requirements);
          record(`verify bad signature, unfunded payer: ${m.method}, ${variant}`, v);
          expect(verifyFailureViolations(v.body, { reason: SPEC_INVALID_SIGNATURE, payer: poor.address })).toEqual([]);
          expect(v.status).toBe(STATUS_VERDICT);

          const s = await settle(bad, requirements);
          record(`settle bad signature, unfunded payer: ${m.method}, ${variant}`, s);
          expect(
            settleFailureViolations(s.body, {
              reasons: [SPEC_INVALID_SIGNATURE],
              payer: poor.address,
              network: m.network,
              broadcast: false,
            }),
          ).toEqual([]);
          expect(s.status).toBe(STATUS_VERDICT);
          expect(await snapshot(m.network, m.asset, poor.address, payTo)).toEqual(before);
        });
      }
    });
  }
});

/** Runtime code answering every call with bytes4 0x1626ba7e: an EIP-1271 wallet that accepts any signature. */
const ACCEPT_ALL_WALLET = "0x631626ba7e60e01b60005260206000f3" as const;
/** Runtime code answering every call with 32 zero bytes: an EIP-1271 wallet that accepts no signature. */
const REJECT_ALL_WALLET = "0x60206000f3" as const;

describe("contract-wallet payers (EIP-1271): the wallet's isValidSignature decides", () => {
  for (const m of METHODS) {
    describe(`${m.method} (${m.asset.symbol} on ${m.network})`, () => {
      const owner = freshAccount();

      it("a wallet that accepts the signature verifies and settles; tokens move from the wallet to payTo", async () => {
        const wallet = freshAddress();
        await makeContractWallet(m.network, m.asset, wallet, 1_000_000n, ACCEPT_ALL_WALLET);
        const payTo = freshAddress();
        const requirements = requirementsFor(m.network, m.asset, payTo, m.amount);
        const payment = await signPayment(contractWalletSigner(wallet, owner), requirements);

        const v = await verify(payment, requirements);
        record(`verify EIP-1271 accepting wallet: ${m.method}`, v);
        expect(v.body).toEqual({ isValid: true, payer: wallet });

        const s = await settle(payment, requirements);
        record(`settle EIP-1271 accepting wallet: ${m.method}`, s);
        expect(s.body).toMatchObject({ success: true, payer: wallet, network: m.network });
        const receipt = await publicClient(m.network).getTransactionReceipt({ hash: s.body.transaction as Hex });
        const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs });
        expect(transfers.map(t => ({ from: t.args.from, to: t.args.to, value: t.args.value, token: getAddress(t.address) }))).toEqual([
          { from: wallet, to: payTo, value: m.amount, token: m.asset.address },
        ]);
        expect(await tokenBalance(m.network, m.asset, payTo)).toBe(m.amount);
      });

      it(`a wallet that rejects the signature gets "${SPEC_INVALID_SIGNATURE}" from /verify and /settle`, async () => {
        const wallet = freshAddress();
        await makeContractWallet(m.network, m.asset, wallet, 1_000_000n, REJECT_ALL_WALLET);
        const payTo = freshAddress();
        const requirements = requirementsFor(m.network, m.asset, payTo, m.amount);
        const payment = await signPayment(contractWalletSigner(wallet, owner), requirements);
        const before = await snapshot(m.network, m.asset, wallet, payTo);

        const v = await verify(payment, requirements);
        record(`verify EIP-1271 rejecting wallet: ${m.method}`, v);
        expect(verifyFailureViolations(v.body, { reason: SPEC_INVALID_SIGNATURE, payer: wallet })).toEqual([]);
        expect(v.status).toBe(STATUS_VERDICT);

        const s = await settle(payment, requirements);
        record(`settle EIP-1271 rejecting wallet: ${m.method}`, s);
        expect(
          settleFailureViolations(s.body, { reasons: [SPEC_INVALID_SIGNATURE], payer: wallet, network: m.network, broadcast: false }),
        ).toEqual([]);
        expect(s.status).toBe(STATUS_VERDICT);
        expect(await snapshot(m.network, m.asset, wallet, payTo)).toEqual(before);
      });
    });
  }
});

/**
 * EIP-6492-wrapped signatures (counterfactual wallets): facilitator/x402-rs/patches 0012.
 *
 * - The wrapped signature is checked by the EIP-6492 validator first, before balance and allowance, on
 *   /verify and /settle. hemi.3 answered an unfunded payer with insufficient_funds / 412 and a funded
 *   one with invalid_transaction_state ("Multicall3: call failed"); its /settle also sent
 *   Multicall3.aggregate3([factory.call(<payload calldata>), transfer]) for a payer without code.
 * - A wrapper around the payer's own EOA signature is ignored: the payment settles as a plain EOA
 *   payment, and no factory is called.
 */
describe("EIP-6492-wrapped signatures", () => {
  /** Some address standing in for a wallet factory; the validator calls it in its simulation only. */
  const FACTORY = "0x00000000000000000000000000000000fac70e11" as const;
  const wrap = (signature: Hex) =>
    serializeErc6492Signature({ address: FACTORY, data: "0xdeadbeef", signature });

  for (const m of METHODS) {
    describe(`${m.method} (${m.asset.symbol} on ${m.network})`, () => {
      for (const funded of [false, true]) {
        it(`${funded ? "funded" : "unfunded"} payer, wrapped signature by another key: "${SPEC_INVALID_SIGNATURE}", nothing sent`, async () => {
          const payer = freshAccount();
          if (funded) {
            await fundEth(m.network, payer.address);
            await fundToken(m.network, m.asset, payer.address, 1_000_000n);
            if (m.asset.transferMethod === "permit2") await ensurePermit2Approval(m.network, payer, m.asset, m.amount);
          }
          const payTo = freshAddress();
          const requirements = requirementsFor(m.network, m.asset, payTo, m.amount);
          const foreign = withFrom(await signPayment(freshAccount(), requirements), payer.address);
          const bad = withSignature(foreign, wrap((foreign.payload as { signature: Hex }).signature));
          const before = await snapshot(m.network, m.asset, payer.address, payTo);

          const v = await verify(bad, requirements);
          record(`verify EIP-6492 bad signature, ${funded ? "funded" : "unfunded"}: ${m.method}`, v);
          expect(verifyFailureViolations(v.body, { reason: SPEC_INVALID_SIGNATURE, payer: payer.address })).toEqual([]);
          expect(v.status).toBe(STATUS_VERDICT);

          const s = await settle(bad, requirements);
          record(`settle EIP-6492 bad signature, ${funded ? "funded" : "unfunded"}: ${m.method}`, s);
          expect(
            settleFailureViolations(s.body, { reasons: [SPEC_INVALID_SIGNATURE], payer: payer.address, network: m.network, broadcast: false }),
          ).toEqual([]);
          expect(s.status).toBe(STATUS_VERDICT);
          // No Multicall3 / factory transaction was sent: the facilitator's nonce did not move.
          expect(await snapshot(m.network, m.asset, payer.address, payTo)).toEqual(before);
        });
      }

      it("a wrapper around the payer's own signature is ignored: it settles as a plain EOA payment", async () => {
        const payer = freshAccount();
        await fundEth(m.network, payer.address);
        await fundToken(m.network, m.asset, payer.address, 1_000_000n);
        if (m.asset.transferMethod === "permit2") await ensurePermit2Approval(m.network, payer, m.asset, m.amount);
        const payTo = freshAddress();
        const requirements = requirementsFor(m.network, m.asset, payTo, m.amount);
        const own = await signPayment(payer, requirements);
        const wrapped = withSignature(own, wrap((own.payload as { signature: Hex }).signature));

        const v = await verify(wrapped, requirements);
        record(`verify EIP-6492 wrapper around own signature: ${m.method}`, v);
        expect(v.body).toEqual({ isValid: true, payer: payer.address });
        const nonceBefore = await nonceOf(m.network, FACILITATOR_SIGNER[m.network]);
        const s = await settle(wrapped, requirements);
        record(`settle EIP-6492 wrapper around own signature: ${m.method}`, s);
        expect(s.body).toMatchObject({ success: true, payer: payer.address, network: m.network });
        // One transaction, straight to the token (EIP-3009) or the x402 proxy (Permit2): no Multicall3.
        const receipt = await publicClient(m.network).getTransactionReceipt({ hash: s.body.transaction as Hex });
        expect(getAddress(receipt.to!)).toBe(m.asset.transferMethod === "eip3009" ? m.asset.address : getAddress("0x402085c248EeA27D92E8b30b2C58ed07f9E20001"));
        expect(await nonceOf(m.network, FACILITATOR_SIGNER[m.network])).toBe(nonceBefore + 1);
        expect(await tokenBalance(m.network, m.asset, payTo)).toBe(m.amount);
      });
    });
  }
});
