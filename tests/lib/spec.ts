/**
 * What the x402 v2 spec says the facilitator must return, encoded as checks.
 *
 * Sources (x402-foundation/x402 @ e4a0868):
 *   specs/x402-specification-v2.md
 *     §5.3.2 SettleResponse fields: success (required), errorReason (optional, omitted if successful),
 *            errorMessage (optional), payer (optional, "Address of the payer's wallet"),
 *            transaction (required, "empty string if no transaction was broadcast"),
 *            network (required, "Blockchain network identifier in CAIP-2 format").
 *            Also amount and extensions (optional).
 *     §5.4.2 VerifyResponse fields: isValid (required), invalidReason (optional, omitted if valid),
 *            invalidMessage (optional), payer (optional, "Address of the payer's wallet"),
 *            extensions and extra (optional).
 *     §7.1   /verify error response example: { isValid: false, invalidReason: "insufficient_funds", payer: "0x857b…" }
 *     §7.2   /settle error response example: { success: false, errorReason: "insufficient_funds",
 *            payer: "0x857b…", transaction: "", network: "eip155:84532" }
 *     §9     Error codes (list below). "clients MUST use the corresponding invalidReason or errorReason code".
 *            settlement_pending: "MUST carry a non-empty transaction (the broadcast hash) and network".
 *   specs/schemes/exact/scheme_exact_evm.md
 *     EIP-3009 Phase 2 step 1 / Permit2 Phase 3 step 1: the signature must recover to `from`.
 *     Permit2 Phase 3 step 2: allowance < amount and no sponsoring extension ->
 *            "Return 412 Precondition Failed (Error Code: PERMIT2_ALLOWANCE_REQUIRED)", checked before balance (step 3).
 *   docs/specs/scheme_exact_bip122.md (this repository): the `invalid_exact_bip122_*` codes, `payer` omitted,
 *            `transaction` on success = the Bitcoin txid (64 lowercase hex, no 0x).
 */
import { getAddress, isAddress, type Address } from "viem";

/** specs/x402-specification-v2.md §9 "Error Handling", verbatim code list. */
export const SPEC_ERROR_CODES = [
  "insufficient_funds",
  "invalid_exact_evm_payload_authorization_valid_after",
  "invalid_exact_evm_payload_authorization_valid_before",
  "invalid_exact_evm_payload_authorization_value_mismatch",
  "invalid_exact_evm_payload_signature",
  "invalid_exact_evm_payload_recipient_mismatch",
  "invalid_network",
  "invalid_payload",
  "invalid_payment_requirements",
  "invalid_scheme",
  "unsupported_scheme",
  "invalid_x402_version",
  "invalid_transaction_state",
  "unexpected_verify_error",
  "unexpected_settle_error",
  "settlement_pending",
] as const;
export type SpecErrorCode = (typeof SPEC_ERROR_CODES)[number];

/** docs/specs/scheme_exact_bip122.md "Error Vocabulary": the scheme's own codes besides the §9 ones. */
export const BIP122_ERROR_CODES = [
  "invalid_exact_bip122_payload_transaction_not_found",
  "invalid_exact_bip122_payload_vout",
  "invalid_exact_bip122_payload_recipient_mismatch",
  "invalid_exact_bip122_payload_value_mismatch",
  "invalid_exact_bip122_payload_unconfirmed",
  "invalid_exact_bip122_pay_to",
] as const;
export type Bip122ErrorCode = (typeof BIP122_ERROR_CODES)[number];
/** Any code a /verify or /settle answer may carry. */
export type ErrorCode = SpecErrorCode | Bip122ErrorCode;

/**
 * `transaction` per network family. An EVM chain's hash is 0x-prefixed. A bip122 success names the Bitcoin
 * payment: its txid in display order, 64 lowercase hex without 0x. A bip122 failure that broadcast something
 * (settlement_pending, a reverted settle) names the Hemi settle transaction, so it is an EVM hash.
 */
export const TX_PATTERN = {
  eip155: /^0x[0-9a-fA-F]{64}$/,
  bip122: /^[0-9a-f]{64}$/,
} as const;

export function txPatternFor(network: string): RegExp {
  return network.startsWith("bip122:") ? TX_PATTERN.bip122 : TX_PATTERN.eip155;
}

/** §9: "Payment authorization signature is invalid or improperly signed". */
export const SPEC_INVALID_SIGNATURE: SpecErrorCode = "invalid_exact_evm_payload_signature";
/** §9: "Specified blockchain network is not supported". */
export const SPEC_INVALID_NETWORK: SpecErrorCode = "invalid_network";
/** §9: broadcast, but its confirmation could not be established; non-terminal, carries the hash. */
export const SPEC_SETTLEMENT_PENDING: SpecErrorCode = "settlement_pending";
/** §9: "Client does not have enough tokens to complete the payment". */
export const SPEC_INSUFFICIENT_FUNDS: SpecErrorCode = "insufficient_funds";
/**
 * §9: "Blockchain transaction failed or was rejected". §9 has no replay-specific code; this is the one
 * that fits a transfer the chain rejects because its authorization's nonce is already spent.
 */
export const SPEC_INVALID_TRANSACTION_STATE: SpecErrorCode = "invalid_transaction_state";
/**
 * HTTP status of a /verify or /settle answer that is a verdict on a payment the facilitator could read
 * (isValid false, or success false, with any §9 code): 200, as the x402 TS reference facilitator answers
 * (x402-foundation/x402 @ e4a0868, examples/typescript/facilitator/basic/index.ts: `res.json(response)`).
 * A stock TS resource server reads the bare §9 code only from a 2xx answer; see
 * facilitator/x402-rs/README.md, "HTTP status codes".
 */
export const STATUS_VERDICT = 200;
/** HTTP status of a request that cannot be read (invalid_payload, invalid_x402_version): 400. */
export const STATUS_UNREADABLE = 400;
/**
 * scheme_exact_evm.md Permit2 Phase 3 step 2 (the TS reference SDK spells it `permit2_allowance_required`).
 * The 412 there is the resource server's answer to the client (x402HTTPResourceServer.ts 1351–1353);
 * the facilitator reports the code with STATUS_VERDICT.
 */
export const SPEC_PERMIT2_ALLOWANCE_REQUIRED = "PERMIT2_ALLOWANCE_REQUIRED";

type Body = Record<string, unknown>;

/** §5.4.2 VerifyResponse fields. */
const VERIFY_FIELDS = ["isValid", "invalidReason", "invalidMessage", "payer", "extensions", "extra"];
/** §5.3.2 SettleResponse fields. */
const SETTLE_FIELDS = ["success", "errorReason", "errorMessage", "payer", "transaction", "network", "amount", "extensions"];
/**
 * The one field outside §5.4.2 that the facilitator is allowed to send: x402-rs's own name for the
 * human-readable message, kept next to `invalidMessage` (same text) for clients of stock x402-rs.
 * See facilitator/x402-rs/README.md. Any other unknown field is a violation.
 */
export const TOLERATED_VERIFY_EXTRA_FIELDS = ["invalidReasonDetails"];

function unknownFields(body: Body, known: string[], section: string): string[] {
  return Object.keys(body)
    .filter(k => !known.includes(k))
    .map(k => `field ${JSON.stringify(k)} is not in ${section}`);
}

/**
 * `payer` is optional (§5.3.2, §5.4.2). On `eip155:*` it must be an address (the expected one if given).
 * Elsewhere it is not an EVM address: a bip122 payment has no single payer, and the scheme omits the field,
 * so only its type and, if expected, its value are checked.
 */
function payerViolation(body: Body, payer: string | undefined, section: string, network?: string): string[] {
  if (!("payer" in body)) return [];
  const value = body.payer;
  const evm = network === undefined || network.startsWith("eip155:");
  const ok = evm
    ? typeof value === "string" && isAddress(value) && (payer === undefined || getAddress(value) === payer)
    : typeof value === "string" && (payer === undefined || value === payer);
  if (ok) return [];
  return [`payer is ${JSON.stringify(value)}; ${section} payer is the payer's wallet address (${payer ?? "any"}) or omitted`];
}

/**
 * Every way `body` departs from a spec /verify failure for this case (§5.4.2, §7.1, §9). Empty = conforms.
 * `payer` undefined means the facilitator cannot know it (it may omit the field).
 */
export function verifyFailureViolations(
  body: Body,
  expected: { reason: ErrorCode; payer?: Address | string; network?: string },
): string[] {
  const v: string[] = [];
  if (body.isValid !== false) v.push(`isValid is ${JSON.stringify(body.isValid)}; spec requires false`);
  if (body.invalidReason !== expected.reason) {
    v.push(`invalidReason is ${JSON.stringify(body.invalidReason)}; the spec §9 code for this case is "${expected.reason}"`);
  }
  if ("invalidMessage" in body && typeof body.invalidMessage !== "string") v.push("invalidMessage is not a string");
  if ("invalidReasonDetails" in body && body.invalidReasonDetails !== body.invalidMessage) {
    v.push("invalidReasonDetails (tolerated compatibility field) differs from invalidMessage");
  }
  v.push(...payerViolation(body, expected.payer, "§5.4.2", expected.network));
  v.push(...unknownFields(body, [...VERIFY_FIELDS, ...TOLERATED_VERIFY_EXTRA_FIELDS], "§5.4.2"));
  return v;
}

/**
 * Every way `body` departs from a spec /settle failure for this case (§5.3.2, §7.2, §9). Empty = conforms.
 * `broadcast`: whether a transaction went out, so `transaction` must be its hash rather than "".
 * `txPattern`: the shape of that hash; default an EVM hash, which a bip122 failure also carries (the Hemi tx).
 */
export function settleFailureViolations(
  body: Body,
  expected: {
    reasons: readonly ErrorCode[];
    payer?: Address | string;
    network: string;
    broadcast: boolean;
    txPattern?: RegExp;
  },
): string[] {
  const v: string[] = [];
  if (body.success !== false) v.push(`success is ${JSON.stringify(body.success)}; spec requires false`);
  if (!expected.reasons.includes(body.errorReason as ErrorCode)) {
    v.push(
      expected.reasons === SPEC_ERROR_CODES
        ? `errorReason is ${JSON.stringify(body.errorReason)}, which is not one of the spec §9 codes`
        : `errorReason is ${JSON.stringify(body.errorReason)}; spec §9 code for this case is ${expected.reasons.map(r => `"${r}"`).join(" or ")}`,
    );
  }
  if ("errorMessage" in body && typeof body.errorMessage !== "string") v.push("errorMessage is not a string");
  if (typeof body.transaction !== "string") {
    v.push(`transaction is ${JSON.stringify(body.transaction)}; §5.3.2 requires a string`);
  } else if (!expected.broadcast && body.transaction !== "") {
    v.push(`transaction is ${JSON.stringify(body.transaction)}; nothing was broadcast, so §5.3.2 requires ""`);
  } else if (expected.broadcast && !(expected.txPattern ?? TX_PATTERN.eip155).test(body.transaction)) {
    v.push(`transaction is ${JSON.stringify(body.transaction)}; a transaction was broadcast, so §5.3.2/§9 require its hash`);
  }
  if (body.network !== expected.network) {
    v.push(`network is ${JSON.stringify(body.network)}; §5.3.2 requires the CAIP-2 network ("${expected.network}")`);
  }
  v.push(...payerViolation(body, expected.payer, "§5.3.2", expected.network));
  v.push(...unknownFields(body, SETTLE_FIELDS, "§5.3.2"));
  return v;
}

/**
 * Every way `body` departs from a spec /settle success (§5.3.2): `success` true, no `errorReason`,
 * `transaction` shaped for the network's family (and equal to `transaction` if given), the CAIP-2 network,
 * `payer` as payerViolation allows, no unknown fields.
 */
export function settleSuccessViolations(
  body: Body,
  expected: { network: string; transaction?: string; payer?: Address | string },
): string[] {
  const v: string[] = [];
  if (body.success !== true) v.push(`success is ${JSON.stringify(body.success)}; expected true`);
  if ("errorReason" in body) v.push("errorReason is present; §5.3.2 omits it on success");
  const pattern = txPatternFor(expected.network);
  if (typeof body.transaction !== "string" || !pattern.test(body.transaction)) {
    v.push(`transaction is ${JSON.stringify(body.transaction)}; on ${expected.network} it must match ${pattern}`);
  } else if (expected.transaction !== undefined && body.transaction !== expected.transaction) {
    v.push(`transaction is ${body.transaction}; expected ${expected.transaction}`);
  }
  if (body.network !== expected.network) v.push(`network is ${JSON.stringify(body.network)}; expected "${expected.network}"`);
  v.push(...payerViolation(body, expected.payer, "§5.3.2", expected.network));
  v.push(...unknownFields(body, SETTLE_FIELDS, "§5.3.2"));
  return v;
}
