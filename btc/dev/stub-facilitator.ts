/**
 * A stand-in facilitator for local runs of the seller and buyer while the real bip122 scheme is not in
 * the facilitator image yet. It touches no chain and no network: /supported lists the Hemi kinds and both
 * bip122 kinds (shaped like stream B's), /verify and /settle answer bip122 payments from a script:
 *
 *   the first STUB_UNCONFIRMED_POLLS settles of a (txid, vout) -> invalid_exact_bip122_payload_unconfirmed
 *   the next one                                                -> success, transaction = the Bitcoin txid
 *   any later one                                               -> invalid_transaction_state (consumed)
 *
 * The derived address is checked against the payload's accepted.extra.paymentId only for the log line;
 * there is no Bitcoin to look at. EVM payments are refused with unexpected_settle_error.
 *
 *   STUB_FACILITATOR_PORT=48080 STUB_UNCONFIRMED_POLLS=2 npx tsx btc/dev/stub-facilitator.ts
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { isTxid, isVout } from "../src/client.js";
import { derivePaymentAddress, isAddressType, isPaymentId } from "../src/derive.js";
import { BTC_MAINNET, BTC_TESTNET3, isBtcNetwork } from "../src/networks.js";

const port = Number(process.env.STUB_FACILITATOR_PORT ?? 48080);
const unconfirmedPolls = Number(process.env.STUB_UNCONFIRMED_POLLS ?? 2);
const polls = new Map<string, number>();
const consumed = new Set<string>();
const log = (msg: string) => console.log(`[stub-facilitator] ${msg}`);

const btcKindExtra = (hemiNetwork: string) => ({
  asset: "BTC",
  assetTransferMethod: "utxo",
  paymentFlow: "upfront",
  addressTypes: ["p2wpkh", "p2tr"],
  minConfirmations: { default: 1, floor: 1, ceiling: 6 },
  hemiNetwork,
});
const supported = {
  kinds: [
    { x402Version: 2, scheme: "exact", network: "eip155:43111" },
    { x402Version: 2, scheme: "exact", network: "eip155:743111" },
    { x402Version: 2, scheme: "exact", network: BTC_MAINNET, extra: btcKindExtra("eip155:43111") },
    { x402Version: 2, scheme: "exact", network: BTC_TESTNET3, extra: btcKindExtra("eip155:743111") },
  ],
  extensions: [],
  signers: {},
};

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req: IncomingMessage): Promise<{ paymentPayload?: PaymentPayload; paymentRequirements?: PaymentRequirements }> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

/** Shape checks a real facilitator makes before reading the chain; returns a §9-style code or undefined. */
function check(p: PaymentPayload | undefined): { code?: string; note?: string } {
  if (!p?.accepted || !isBtcNetwork(p.accepted.network)) return { code: "invalid_network" };
  const { txid, vout } = p.payload ?? {};
  if (!isTxid(txid) || !isVout(vout)) return { code: "invalid_payload" };
  const { paymentId, addressType = "p2wpkh" } = p.accepted.extra ?? {};
  if (!isPaymentId(paymentId) || !isAddressType(addressType)) return { code: "invalid_payload" };
  try {
    const d = derivePaymentAddress(p.accepted.payTo, p.accepted.network, paymentId, addressType);
    return { note: `pays ${p.accepted.amount} sats to ${d.address} (index ${d.index})` };
  } catch {
    return { code: "invalid_exact_bip122_pay_to" };
  }
}

createServer(async (req, res) => {
  try {
    if (req.method === "GET" && req.url === "/supported") return send(res, 200, supported);
    if (req.method !== "POST" || (req.url !== "/verify" && req.url !== "/settle")) return send(res, 404, { error: "not found" });
    const { paymentPayload: p, paymentRequirements: r } = await readJson(req);
    const network = p?.accepted?.network ?? r?.network ?? "";
    if (!isBtcNetwork(network)) {
      log(`${req.url} ${network}: refused (stub serves bip122 only)`);
      return req.url === "/verify"
        ? send(res, 200, { isValid: false, invalidReason: "unexpected_verify_error", invalidMessage: "stub facilitator: bip122 only" })
        : send(res, 200, { success: false, errorReason: "unexpected_settle_error", transaction: "", network });
    }
    const { code, note } = check(p);
    const key = `${network}:${p?.payload?.txid}:${p?.payload?.vout}`;
    const verdict = code ?? (consumed.has(key) ? "invalid_transaction_state" : undefined);
    if (req.url === "/verify") {
      log(`/verify ${key} -> ${verdict ?? "valid"} ${note ?? ""}`);
      return send(res, 200, verdict ? { isValid: false, invalidReason: verdict } : { isValid: true });
    }
    if (verdict) {
      log(`/settle ${key} -> ${verdict}`);
      return send(res, 200, { success: false, errorReason: verdict, transaction: "", network });
    }
    const n = (polls.get(key) ?? 0) + 1;
    polls.set(key, n);
    if (n <= unconfirmedPolls) {
      log(`/settle ${key} -> invalid_exact_bip122_payload_unconfirmed (poll ${n} of ${unconfirmedPolls}) ${note}`);
      return send(res, 200, { success: false, errorReason: "invalid_exact_bip122_payload_unconfirmed", transaction: "", network });
    }
    consumed.add(key);
    log(`/settle ${key} -> success ${note}`);
    return send(res, 200, { success: true, transaction: p!.payload.txid, network });
  } catch (error) {
    send(res, 400, { error: error instanceof Error ? error.message : String(error) });
  }
}).listen(port, "127.0.0.1", () => log(`listening on http://127.0.0.1:${port} (no chain access; unconfirmed polls: ${unconfirmedPolls})`));
