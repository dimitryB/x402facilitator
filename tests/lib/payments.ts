/**
 * Payment requirements as the demo seller advertises them, and payment payloads built by the
 * official client code: x402Client + ExactEvmScheme with a viem account, i.e. what a stock buyer runs.
 */
import { getAddress, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { HemiAsset, HemiNetwork } from "@hemi-x402/shared";

/** Same `extra` as seller/server.ts: Permit2 assets name the method; EIP-3009 assets carry the EIP-712 domain. */
export function requirementsFor(
  network: HemiNetwork,
  asset: HemiAsset,
  payTo: Address,
  amount: bigint,
): PaymentRequirements {
  const extra: Record<string, unknown> =
    asset.transferMethod === "permit2"
      ? { assetTransferMethod: "permit2" }
      : { assetTransferMethod: "eip3009", name: asset.eip712!.name, version: asset.eip712!.version };
  return {
    scheme: "exact",
    network,
    asset: asset.address,
    amount: amount.toString(),
    payTo,
    maxTimeoutSeconds: 300,
    extra,
  };
}

/** Sign a payment for `requirements` exactly as a buyer's x402Client would after a 402. */
export async function signPayment(account: LocalAccount, requirements: PaymentRequirements): Promise<PaymentPayload> {
  const client = new x402Client()
    .register(requirements.network, new ExactEvmScheme(account))
    // Hemi assets are not SDK default assets; a buyer must allow-list them (as buyer/pay.ts does).
    .setSpendControls({ allowedAssets: [{ network: requirements.network, asset: requirements.asset }] });
  return client.createPaymentPayload({
    x402Version: 2,
    resource: { url: "http://seller.e2e.local/echo", description: "e2e test resource", mimeType: "application/json" },
    accepts: [requirements],
  });
}

export function freshAccount(): LocalAccount {
  return privateKeyToAccount(generatePrivateKey());
}

export function freshAddress(): Address {
  return freshAccount().address;
}

/** Flip one bit inside `r` of a 65-byte signature, keeping its length and `v` intact. */
export function tamperSignature(signature: Hex): Hex {
  const bytes = Buffer.from(signature.slice(2), "hex");
  if (bytes.length !== 65) throw new Error(`expected a 65-byte EOA signature, got ${bytes.length} bytes`);
  bytes[10] ^= 0x01;
  return `0x${bytes.toString("hex")}`;
}

type Eip3009Payload = { signature: Hex; authorization: { from: Address } & Record<string, string> };
type Permit2Payload = { signature: Hex; permit2Authorization: { from: Address } & Record<string, unknown> };

/** Deep copy with the signature replaced. */
export function withSignature(payment: PaymentPayload, signature: Hex): PaymentPayload {
  const copy = structuredClone(payment);
  (copy.payload as { signature: Hex }).signature = signature;
  return copy;
}

/** Deep copy claiming a different payer (`from`) than the key that signed it. */
export function withFrom(payment: PaymentPayload, from: Address): PaymentPayload {
  const copy = structuredClone(payment);
  const p = copy.payload as Partial<Eip3009Payload & Permit2Payload>;
  if (p.authorization) p.authorization.from = getAddress(from);
  else if (p.permit2Authorization) p.permit2Authorization.from = getAddress(from);
  else throw new Error("unknown exact EVM payload shape");
  return copy;
}
