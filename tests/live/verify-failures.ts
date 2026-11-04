/**
 * Read-only checks of a facilitator running on live Hemi networks. It sends GET /supported and POST /verify
 * only, never /settle, so the facilitator broadcasts nothing; the signer's nonce is read before and after
 * to show that.
 *
 * Every payload is signed by a throwaway key made here. No key from .env is read. `--funded-payer` is
 * a public address that holds tokens; the wrong-key case claims it as `from`, so its signature check
 * runs against a payer whose balance or allowance alone would not fail it.
 *
 *   npx tsx tests/live/verify-failures.ts --networks eip155:43111 \
 *     --signer eip155:43111=0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875 \
 *     --funded-payer 0x35C8182E886382D1133a3Daf980470D3646D3786
 *
 * Options: --url (default http://127.0.0.1:8080), --networks (the exact set /supported must list),
 * --signer NETWORK=ADDRESS (repeatable; the signer /supported must list for that network),
 * --funded-payer ADDRESS (optional). Exits 1 if any check fails.
 *
 * Cases per served network and asset (USDC.e and the BTC asset, at the demo seller's prices):
 *   no funds        a fresh key signs correctly but holds nothing: insufficient_funds (EIP-3009) or
 *                   permit2_allowance_required (Permit2, whose allowance is checked before the balance)
 *   wrong key       a fresh key signs, `from` is the funded payer: invalid_exact_evm_payload_signature
 *   tampered        one bit of `r` flipped: invalid_exact_evm_payload_signature
 *   over-payment    signed for 5x the price, presented at the price: ..._authorization_value_mismatch
 * and once per run: eip155:1, plus any Hemi network the facilitator does not serve: invalid_network.
 */
import { createPublicClient, erc20Abi, fallback, getAddress, http, isAddress, type Address } from "viem";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { PERMIT2_ADDRESS } from "@x402/evm";
import { btcAsset, NETWORKS, parseNetwork, usdcAsset, type HemiAsset, type HemiNetwork } from "@hemi-x402/shared";
import { freshAccount, freshAddress, requirementsFor, signPayment, tamperSignature, withFrom, withSignature } from "../lib/payments";
import {
  SPEC_INSUFFICIENT_FUNDS,
  SPEC_INVALID_NETWORK,
  SPEC_INVALID_SIGNATURE,
  SPEC_PERMIT2_ALLOWANCE_REQUIRED,
  STATUS_VERDICT,
  verifyFailureViolations,
  type SpecErrorCode,
} from "../lib/spec";

const ALL_HEMI: HemiNetwork[] = Object.keys(NETWORKS) as HemiNetwork[];
/** Seller defaults: 0.001 USDC.e and 1 sat (seller/server.ts, SELLER_BTC_AMOUNT). */
const PRICE = { usdc: 1_000n, btc: 1n };

function parseArgs(argv: string[]) {
  const opts = { url: "http://127.0.0.1:8080", networks: [] as HemiNetwork[], signers: {} as Record<string, Address>, fundedPayer: undefined as Address | undefined };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[++i];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--url") opts.url = value.replace(/\/$/, "");
    else if (flag === "--networks") opts.networks = value.split(",").map(parseNetwork);
    else if (flag === "--signer") {
      const [network, address] = value.split("=");
      if (!address || !isAddress(address)) throw new Error(`--signer wants NETWORK=ADDRESS, got ${value}`);
      opts.signers[parseNetwork(network!)] = getAddress(address);
    } else if (flag === "--funded-payer") {
      if (!isAddress(value)) throw new Error(`--funded-payer: not an address: ${value}`);
      opts.fundedPayer = getAddress(value);
    } else throw new Error(`unknown option ${flag}`);
  }
  if (opts.networks.length === 0) throw new Error("--networks is required, e.g. --networks eip155:43111");
  return opts;
}

const opts = parseArgs(process.argv.slice(2));
let failures = 0;

function report(ok: boolean, label: string, detail: string): void {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}: ${detail}`);
}

async function call(method: "GET" | "POST", path: string, body?: unknown): Promise<{ status: number; body: Record<string, any> }> {
  if (path === "/settle") throw new Error("this script never calls /settle");
  const res = await fetch(`${opts.url}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  try {
    return { status: res.status, body: JSON.parse(text) };
  } catch {
    throw new Error(`${method} ${path} returned ${res.status} with a non-JSON body: ${text.slice(0, 300)}`);
  }
}

const verify = (payload: PaymentPayload, requirements: PaymentRequirements) =>
  call("POST", "/verify", { x402Version: 2, paymentPayload: payload, paymentRequirements: requirements });

function client(network: HemiNetwork) {
  const { rpc, chain } = NETWORKS[network];
  return createPublicClient({ chain, transport: fallback([http(rpc.primary, { timeout: 10_000 }), http(rpc.fallback, { timeout: 10_000 })]) });
}

async function expectVerdict(
  label: string,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  expected: { reason: SpecErrorCode | "permit2_allowance_required"; payer?: Address },
): Promise<void> {
  const res = await verify(payload, requirements);
  const problems: string[] = [];
  if (res.status !== STATUS_VERDICT) problems.push(`HTTP ${res.status}, expected ${STATUS_VERDICT}`);
  if (expected.reason === "permit2_allowance_required") {
    // The spec writes it in capitals; x402-rs and the TS SDK send it in lower case (tests/lib/spec.ts).
    if (res.body.isValid !== false) problems.push(`isValid is ${JSON.stringify(res.body.isValid)}`);
    if (String(res.body.invalidReason).toUpperCase() !== SPEC_PERMIT2_ALLOWANCE_REQUIRED) {
      problems.push(`invalidReason is ${JSON.stringify(res.body.invalidReason)}, expected permit2_allowance_required`);
    }
    if (expected.payer && (typeof res.body.payer !== "string" || getAddress(res.body.payer) !== expected.payer)) {
      problems.push(`payer is ${JSON.stringify(res.body.payer)}, expected ${expected.payer}`);
    }
  } else {
    problems.push(...verifyFailureViolations(res.body, { reason: expected.reason, payer: expected.payer }));
  }
  report(problems.length === 0, label, `${res.status} ${JSON.stringify(res.body)}${problems.length ? `  <- ${problems.join("; ")}` : ""}`);
}

async function payerState(network: HemiNetwork, asset: HemiAsset, owner: Address): Promise<string> {
  const c = client(network);
  const [balance, allowance] = await Promise.all([
    c.readContract({ address: asset.address, abi: erc20Abi, functionName: "balanceOf", args: [owner] }),
    c.readContract({ address: asset.address, abi: erc20Abi, functionName: "allowance", args: [owner, PERMIT2_ADDRESS] }),
  ]);
  return `${asset.symbol} balance ${balance}, Permit2 allowance ${allowance}`;
}

async function checkAsset(network: HemiNetwork, asset: HemiAsset, amount: bigint): Promise<void> {
  const tag = `${network} ${asset.symbol} (${asset.transferMethod})`;
  const payer = freshAccount();
  const requirements = requirementsFor(network, asset, freshAddress(), amount);
  const payment = await signPayment(payer, requirements);

  await expectVerdict(`${tag} no funds`, payment, requirements, {
    reason: asset.transferMethod === "permit2" ? "permit2_allowance_required" : SPEC_INSUFFICIENT_FUNDS,
    payer: payer.address,
  });

  if (opts.fundedPayer) {
    console.log(`      funded payer ${opts.fundedPayer}: ${await payerState(network, asset, opts.fundedPayer)}`);
    await expectVerdict(`${tag} wrong key, from = funded payer`, withFrom(payment, opts.fundedPayer), requirements, {
      reason: SPEC_INVALID_SIGNATURE,
      payer: opts.fundedPayer,
    });
  }

  const sig = (payment.payload as { signature: `0x${string}` }).signature;
  await expectVerdict(`${tag} tampered signature`, withSignature(payment, tamperSignature(sig)), requirements, {
    reason: SPEC_INVALID_SIGNATURE,
    payer: payer.address,
  });

  const over = await signPayment(payer, { ...requirements, amount: (amount * 5n).toString() });
  await expectVerdict(`${tag} over-payment (5x signed)`, { ...over, accepted: requirements }, requirements, {
    reason: "invalid_exact_evm_payload_authorization_value_mismatch",
    payer: payer.address,
  });
}

async function main(): Promise<void> {
  console.log(`facilitator ${opts.url}, expected networks ${opts.networks.join(", ")}`);

  const sup = await call("GET", "/supported");
  const kinds = (sup.body.kinds ?? []) as { x402Version: number; scheme: string; network: string }[];
  const listed = [...new Set(kinds.map(k => k.network))].sort();
  report(
    sup.status === 200 && JSON.stringify(listed) === JSON.stringify([...opts.networks].sort()),
    "/supported networks",
    `${sup.status} ${JSON.stringify(sup.body)}`,
  );
  for (const network of opts.networks) {
    const k = kinds.filter(k => k.network === network);
    report(k.length === 1 && k[0]!.x402Version === 2 && k[0]!.scheme === "exact", `/supported kind for ${network}`, JSON.stringify(k));
    const expectedSigner = opts.signers[network];
    if (expectedSigner) {
      const listedSigners = ((sup.body.signers ?? {})[network] ?? []) as string[];
      report(
        listedSigners.length === 1 && getAddress(listedSigners[0]!) === expectedSigner,
        `/supported signer for ${network}`,
        JSON.stringify(listedSigners),
      );
    }
  }

  const nonceBefore: Record<string, number> = {};
  for (const [network, signer] of Object.entries(opts.signers) as [HemiNetwork, Address][]) {
    nonceBefore[network] = await client(network).getTransactionCount({ address: signer, blockTag: "pending" });
    console.log(`      signer ${signer} on ${network}: pending nonce ${nonceBefore[network]}`);
  }

  for (const network of opts.networks) {
    await checkAsset(network, usdcAsset(network), PRICE.usdc);
    await checkAsset(network, btcAsset(network), PRICE.btc);
  }

  const unserved = ["eip155:1", ...ALL_HEMI.filter(n => !opts.networks.includes(n))];
  for (const network of unserved) {
    const base = ALL_HEMI.includes(network as HemiNetwork) ? (network as HemiNetwork) : opts.networks[0]!;
    const requirements = { ...requirementsFor(base, usdcAsset(base), freshAddress(), PRICE.usdc), network: network as HemiNetwork };
    await expectVerdict(`unserved network ${network}`, await signPayment(freshAccount(), requirements), requirements, {
      reason: SPEC_INVALID_NETWORK,
    });
  }

  for (const [network, signer] of Object.entries(opts.signers) as [HemiNetwork, Address][]) {
    const after = await client(network).getTransactionCount({ address: signer, blockTag: "pending" });
    report(after === nonceBefore[network], `signer ${network} sent nothing`, `pending nonce ${nonceBefore[network]} -> ${after}`);
  }

  console.log(failures === 0 ? "all checks passed" : `${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
