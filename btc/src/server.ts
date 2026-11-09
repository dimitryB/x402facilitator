/**
 * ExactBtcServerScheme: the resource-server side of `exact` on `bip122:*` for the x402 TS SDK.
 *
 * Register one instance per Bitcoin network:
 *
 *   resourceServer.register(BTC_MAINNET, new ExactBtcServerScheme({ network: BTC_MAINNET, payTo: xpub }))
 *
 * and price the route's accept as `{ asset: "BTC", amount: "<sats>" }` with `payTo` = the account xpub.
 *
 * How it fits the SDK (x402 2.29.0, @x402/core/dist/cjs/server/index.js):
 *   - `paymentFlows.utxo` is `upfront` only: core then skips /verify and calls /settle before the handler.
 *   - `enrichPaymentRequiredResponse` adds a fresh `extra.paymentId` to each of this network's accepts, every
 *     time a 402 is built. Core builds one on every paid request too, so the requirements a seller sends to
 *     /settle carry a new paymentId; the facilitator derives from `paymentPayload.accepted.extra.paymentId`.
 *   - `dynamicExtraFields: ["paymentId"]` makes core ignore paymentId when it matches the payload's
 *     `accepted` against the rebuilt requirements (paymentRequirementsMatchAccepted).
 *   - Core lets the hook add extra fields only to accepts with the same scheme and network as the accept
 *     it is called for (assertAcceptsAdditiveExtraAfterSchemeEnrich), hence one instance per network.
 */
import type { Network, PaymentRequirements, Price, SchemeNetworkServer, SupportedKind } from "@x402/core/types";
import type { AssetAmount, SchemePaymentRequiredContext } from "@x402/core/types";
import {
  ADDRESS_TYPES,
  DEFAULT_ADDRESS_TYPE,
  isAddressType,
  isPaymentId,
  newPaymentId,
  parseAccountXpub,
  type AddressType,
} from "./derive.js";
import { BTC_ASSET, BTC_NETWORKS, isBtcNetwork, UTXO_TRANSFER_METHOD, type BtcNetwork } from "./networks.js";

export const DEFAULT_MIN_CONFIRMATIONS = 1;
const SATS = /^[1-9]\d*$/;

export interface ExactBtcServerSchemeOptions {
  network: BtcNetwork;
  /** The seller's account xpub/tpub. Optional; when given, its version bytes are checked against `network` up front. */
  payTo?: string;
  /** `extra.addressType` of every accept (default p2wpkh). */
  addressType?: AddressType;
  /** `extra.minConfirmations`: Bitcoin confirmations the facilitator must see (default 1). */
  minConfirmations?: number;
}

export class ExactBtcServerScheme implements SchemeNetworkServer {
  readonly scheme = "exact";
  readonly defaultAssetTransferMethod = UTXO_TRANSFER_METHOD;
  readonly paymentFlows = { [UTXO_TRANSFER_METHOD]: { supported: ["upfront"] as const, default: "upfront" as const } };
  readonly dynamicExtraFields = ["paymentId"];
  readonly network: BtcNetwork;
  readonly addressType: AddressType;
  readonly minConfirmations: number;

  constructor(options: ExactBtcServerSchemeOptions) {
    if (!isBtcNetwork(options.network)) throw new Error(`ExactBtcServerScheme: unknown Bitcoin network ${options.network}`);
    const addressType = options.addressType ?? DEFAULT_ADDRESS_TYPE;
    if (!isAddressType(addressType)) throw new Error(`addressType must be one of ${ADDRESS_TYPES.join(", ")}`);
    const minConfirmations = options.minConfirmations ?? DEFAULT_MIN_CONFIRMATIONS;
    if (!Number.isInteger(minConfirmations) || minConfirmations < 1) throw new Error("minConfirmations must be an integer >= 1");
    if (options.payTo !== undefined) parseAccountXpub(options.payTo, options.network);
    this.network = options.network;
    this.addressType = addressType;
    this.minConfirmations = minConfirmations;
  }

  /** Only an explicit `{ asset: "BTC", amount: "<sats>" }`: a dollar price would need a BTC/USD oracle. */
  async parsePrice(price: Price, network: Network): Promise<AssetAmount> {
    this.assertNetwork(network);
    if (typeof price !== "object" || price === null) {
      throw new Error(`price on ${network} must be { asset: "${BTC_ASSET}", amount: "<satoshis>" }, not ${JSON.stringify(price)}`);
    }
    if (price.asset !== BTC_ASSET) throw new Error(`asset on ${network} must be "${BTC_ASSET}", got ${JSON.stringify(price.asset)}`);
    if (typeof price.amount !== "string" || !SATS.test(price.amount)) {
      throw new Error(`amount on ${network} must be a positive integer number of satoshis as a string, got ${JSON.stringify(price.amount)}`);
    }
    return { asset: BTC_ASSET, amount: price.amount, extra: { ...price.extra } };
  }

  async enhancePaymentRequirements(
    requirements: PaymentRequirements,
    _supportedKind: SupportedKind,
    _facilitatorExtensions: string[],
  ): Promise<PaymentRequirements> {
    this.assertNetwork(requirements.network);
    parseAccountXpub(requirements.payTo, this.network);
    const addressType = requirements.extra?.addressType ?? this.addressType;
    if (!isAddressType(addressType)) throw new Error(`extra.addressType must be one of ${ADDRESS_TYPES.join(", ")}`);
    const minConfirmations = requirements.extra?.minConfirmations ?? this.minConfirmations;
    if (!Number.isInteger(minConfirmations) || (minConfirmations as number) < 1) {
      throw new Error("extra.minConfirmations must be an integer >= 1");
    }
    return {
      ...requirements,
      asset: BTC_ASSET,
      extra: {
        ...requirements.extra,
        assetTransferMethod: UTXO_TRANSFER_METHOD,
        paymentFlow: "upfront",
        addressType,
        minConfirmations,
      },
    };
  }

  /** A fresh random paymentId on each of this network's `exact` accepts that has none yet. */
  enrichPaymentRequiredResponse = async (ctx: SchemePaymentRequiredContext): Promise<PaymentRequirements[]> =>
    ctx.requirements.map(r =>
      r.scheme === this.scheme && r.network === this.network && !isPaymentId(r.extra?.paymentId)
        ? { ...r, extra: { ...r.extra, paymentId: newPaymentId() } }
        : r,
    );

  /**
   * The facilitator's `/supported` kind must match what this seller asks for: asset BTC, the utxo/upfront
   * flow, the address type and a confirmation count inside its policy. Fields it does not advertise are not checked.
   */
  validateFacilitatorSupport(network: Network, supportedKind: SupportedKind): string | void {
    if (network !== this.network) return `registered for ${this.network}, asked about ${network}`;
    const extra = (supportedKind.extra ?? {}) as Record<string, unknown>;
    const problems: string[] = [];
    if (extra.asset !== undefined && extra.asset !== BTC_ASSET) problems.push(`facilitator asset is ${JSON.stringify(extra.asset)}, not "${BTC_ASSET}"`);
    if (extra.assetTransferMethod !== undefined && extra.assetTransferMethod !== UTXO_TRANSFER_METHOD) {
      problems.push(`facilitator assetTransferMethod is ${JSON.stringify(extra.assetTransferMethod)}`);
    }
    if (extra.paymentFlow !== undefined && extra.paymentFlow !== "upfront") problems.push(`facilitator paymentFlow is ${JSON.stringify(extra.paymentFlow)}`);
    if (Array.isArray(extra.addressTypes) && !extra.addressTypes.includes(this.addressType)) {
      problems.push(`facilitator addressTypes ${JSON.stringify(extra.addressTypes)} exclude ${this.addressType}`);
    }
    const policy = extra.minConfirmations as { floor?: unknown; ceiling?: unknown } | undefined;
    if (policy && typeof policy === "object") {
      if (typeof policy.floor === "number" && this.minConfirmations < policy.floor) {
        problems.push(`minConfirmations ${this.minConfirmations} is below the facilitator floor ${policy.floor}`);
      }
      if (typeof policy.ceiling === "number" && this.minConfirmations > policy.ceiling) {
        problems.push(`minConfirmations ${this.minConfirmations} is above the facilitator ceiling ${policy.ceiling}`);
      }
    }
    if (problems.length > 0) return `${BTC_NETWORKS[this.network].name}: ${problems.join("; ")}`;
  }

  private assertNetwork(network: string): void {
    if (network !== this.network) throw new Error(`ExactBtcServerScheme for ${this.network} cannot serve ${network}`);
  }
}
