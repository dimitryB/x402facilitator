/**
 * Payment requirements as the demo seller advertises them, and payment payloads built by the
 * official client code: x402Client + ExactEvmScheme with a viem account, i.e. what a stock buyer runs.
 */
import { getAddress, type Address, type Hex, type LocalAccount } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { authorizationTypes, permit2WitnessTypes, PERMIT2_ADDRESS, type ClientEvmSigner } from "@x402/evm";
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

/**
 * Sign a payment for `requirements` exactly as a buyer's x402Client would after a 402. `signer` is a viem
 * account, or any ClientEvmSigner, e.g. a contract wallet whose owner key signs (EIP-1271).
 */
export async function signPayment(signer: ClientEvmSigner, requirements: PaymentRequirements): Promise<PaymentPayload> {
  const client = new x402Client()
    .register(requirements.network, new ExactEvmScheme(signer))
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

/** A contract wallet at `address` whose owner signs for it: what a smart-wallet SDK hands x402Client. */
export function contractWalletSigner(address: Address, owner: LocalAccount): ClientEvmSigner {
  return { address, signTypedData: message => owner.signTypedData(message as Parameters<LocalAccount["signTypedData"]>[0]) };
}

function chainIdOf(payment: PaymentPayload): number {
  return Number(payment.accepted.network.split(":")[1]);
}

/**
 * A deliberately altered payload that is still validly signed: apply `mutate` to the authorization,
 * then sign it again with the SDK's own EIP-712 types (`authorizationTypes`, `permit2WitnessTypes`)
 * and the same domain. Used for cases the stock client never produces, such as a future validAfter.
 */
export async function resign(
  account: LocalAccount,
  payment: PaymentPayload,
  mutate: (authorization: Record<string, any>) => void,
): Promise<PaymentPayload> {
  const copy = structuredClone(payment);
  const p = copy.payload as Record<string, any>;
  const chainId = chainIdOf(copy);
  if (p.authorization) {
    const a = p.authorization;
    mutate(a);
    p.signature = await account.signTypedData({
      domain: {
        name: copy.accepted.extra.name as string,
        version: copy.accepted.extra.version as string,
        chainId,
        verifyingContract: getAddress(copy.accepted.asset),
      },
      types: authorizationTypes,
      primaryType: "TransferWithAuthorization",
      message: {
        from: getAddress(a.from),
        to: getAddress(a.to),
        value: BigInt(a.value),
        validAfter: BigInt(a.validAfter),
        validBefore: BigInt(a.validBefore),
        nonce: a.nonce,
      },
    });
  } else {
    const a = p.permit2Authorization;
    mutate(a);
    p.signature = await account.signTypedData({
      domain: { name: "Permit2", chainId, verifyingContract: PERMIT2_ADDRESS },
      types: permit2WitnessTypes,
      primaryType: "PermitWitnessTransferFrom",
      message: {
        permitted: { token: getAddress(a.permitted.token), amount: BigInt(a.permitted.amount) },
        spender: getAddress(a.spender),
        nonce: BigInt(a.nonce),
        deadline: BigInt(a.deadline),
        witness: { to: getAddress(a.witness.to), validAfter: BigInt(a.witness.validAfter) },
      },
    });
  }
  return copy;
}
