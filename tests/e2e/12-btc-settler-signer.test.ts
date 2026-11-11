/**
 * Bitcoin settlements go from the settler's SETTLER, whatever other signers the Hemi chain has (the
 * audit's R01, D-050).
 *
 * X402BtcSettler accepts settle() from one immutable address. The Hemi provider rotates its signers for
 * every transaction that names no sender, and up to hemi.17 the Bitcoin settlement named none: with two
 * signers, every other Bitcoin settlement reverted with NotSettler after the buyer had paid on Bitcoin
 * (the audit saw HTTP 500, 200, 500, 200). Since hemi.18 the facilitator sends each one from the SETTLER
 * its startup check read, and lists only that signer for the Bitcoin network in /supported.
 *
 * Setup: the facilitator is recreated with a copy of facilitator/config.json whose mainnet chain has a
 * second signer ahead of the usual one: anvil #4, which the settler does not accept (written to .scratch,
 * not committed). Each round is one EVM settlement and then two Bitcoin settlements back to back: without a
 * sender, two consecutive transactions cannot both get the SETTLER from a two-signer rotation (strict
 * alternation with EVM ones would hide the bug, landing every Bitcoin settlement on the SETTLER). The usual
 * config is restored afterwards.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getAddress, type Hash } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BTC_MAINNET, derivePaymentAddress, paymentRef } from "@hemi-x402/btc";
import { MAINNET, usdcAsset } from "@hemi-x402/shared";
import { btcFork, seedBtcPayment, settledBy, settledEvents, TEST_XPUB } from "../lib/btc";
import { publicClient } from "../lib/chain";
import { restartFacilitator } from "../lib/compose";
import { BUYER_KEY, FACILITATOR_SIGNER, REPO_ROOT, STATE_DIR } from "../lib/env";
import { record, settle, supported } from "../lib/facilitator";
import { btcPayment, btcRequirementsFor, freshAddress, requirementsFor, signPayment } from "../lib/payments";
import { settleSuccessViolations } from "../lib/spec";

const CONFIG_FILE = join(STATE_DIR, "config.two-signers.json");
// docker-compose.yml mounts ./facilitator/${FACILITATOR_CONFIG}; this path leads from there to .scratch.
const CONFIG_FROM_FACILITATOR_DIR = "../.scratch/fork-tests/config.two-signers.json";
/** anvil #4: a published dev key that anvil funds on the fork. The settler does not accept it. */
const OTHER_KEY = "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a";
const OTHER_SIGNER = privateKeyToAccount(OTHER_KEY).address;
const SETTLER_SIGNER = FACILITATOR_SIGNER[MAINNET];
const buyer = privateKeyToAccount(BUYER_KEY);
const SATS = 1_000n;
const ROUNDS = 3;

// Decided before any test is collected, as in 11-btc-l1: without a mainnet settler there is nothing to test.
const kind = await supported().then(
  r => r.body.kinds.find(k => k.scheme === "exact" && k.network === BTC_MAINNET),
  () => undefined,
);
const fork = kind ? await btcFork(BTC_MAINNET, kind.extra as Record<string, unknown> | undefined) : "no exact kind on bitcoin mainnet in /supported";
if (typeof fork === "string") process.stderr.write(`[12-btc-settler-signer] skipping: ${fork}\n`);

describe.skipIf(typeof fork === "string")("a Hemi chain with two signers, only one of them the settler's SETTLER", () => {
  const btc = fork as Exclude<typeof fork, string>;

  beforeAll(async () => {
    const config = JSON.parse(readFileSync(join(REPO_ROOT, "facilitator", "config.json"), "utf8"));
    config.chains[MAINNET].signers = [OTHER_KEY, ...config.chains[MAINNET].signers];
    writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
    await restartFacilitator({ FACILITATOR_CONFIG: CONFIG_FROM_FACILITATOR_DIR });
  });

  afterAll(async () => {
    await restartFacilitator();
  });

  it("/supported: the Hemi chain lists both signers, the Bitcoin network only the SETTLER", async () => {
    const { body } = await supported();
    expect(body.kinds.some(k => k.network === BTC_MAINNET)).toBe(true);
    expect((body.signers[MAINNET] ?? []).map(a => getAddress(a)).sort()).toEqual([OTHER_SIGNER, SETTLER_SIGNER].sort());
    expect((body.signers[BTC_MAINNET] ?? []).map(a => getAddress(a))).toEqual([SETTLER_SIGNER]);
  });

  it(`${ROUNDS} rounds of one EVM and two Bitcoin settlements: every Bitcoin one succeeds, sent from the SETTLER`, async () => {
    const hemi = publicClient(MAINNET);
    const evmSenders = new Set<string>();
    for (let round = 0; round < ROUNDS; round++) {
      // An EVM settlement first: it takes the next signer in the rotation.
      const evmRequirements = requirementsFor(MAINNET, usdcAsset(MAINNET), freshAddress(), 1_000n);
      const evm = await settle(await signPayment(buyer, evmRequirements), evmRequirements);
      record(`two signers: EVM settle ${round}`, evm);
      expect(settleSuccessViolations(evm.body, { network: MAINNET, payer: buyer.address })).toEqual([]);
      evmSenders.add((await hemi.getTransaction({ hash: evm.body.transaction as Hash })).from);

      for (const n of [1, 2]) {
        const requirements = btcRequirementsFor(BTC_MAINNET, TEST_XPUB[BTC_MAINNET], SATS);
        const address = derivePaymentAddress(requirements.payTo, BTC_MAINNET, requirements.extra.paymentId as string);
        const ref = await seedBtcPayment(btc, { script: address.script, sats: SATS, confirmations: 1 });
        const fromBlock = await hemi.getBlockNumber();
        const res = await settle(btcPayment(requirements, ref), requirements);
        record(`two signers: Bitcoin settle ${round}.${n}`, res);
        expect(res.status, `round ${round}, Bitcoin settlement ${n}: ${JSON.stringify(res.body)}`).toBe(200);
        expect(settleSuccessViolations(res.body, { network: BTC_MAINNET, transaction: ref.txid })).toEqual([]);
        expect(await settledBy(btc, ref.txid, ref.vout)).toBe(paymentRef(requirements.extra.paymentId as string));
        const events = await settledEvents(btc, ref.txid, fromBlock);
        expect(events.map(e => getAddress(e.args.settler!))).toEqual([SETTLER_SIGNER]);
      }
    }
    // The rotation was live: the EVM settlements went from both signers.
    expect([...evmSenders].map(a => getAddress(a)).sort()).toEqual([OTHER_SIGNER, SETTLER_SIGNER].sort());
  });
});
