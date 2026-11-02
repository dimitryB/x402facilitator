/** Before/after state for failure cases: no tokens may move and the facilitator must not broadcast. */
import type { Address } from "viem";
import type { HemiAsset, HemiNetwork } from "@hemi-x402/shared";
import { nonceOf, tokenBalance } from "./chain";
import { FACILITATOR_SIGNER } from "./env";

export interface Snapshot {
  signerNonce: number;
  payer: bigint;
  payTo: bigint;
}

export async function snapshot(network: HemiNetwork, asset: HemiAsset, payer: Address, payTo: Address): Promise<Snapshot> {
  return {
    signerNonce: await nonceOf(network, FACILITATOR_SIGNER[network]),
    payer: await tokenBalance(network, asset, payer),
    payTo: await tokenBalance(network, asset, payTo),
  };
}
