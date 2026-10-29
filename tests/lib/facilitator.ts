/** Plain HTTP calls to the facilitator, as a resource server would make them. */
import { appendFileSync } from "node:fs";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";
import { FACILITATOR_URL, OBSERVED_FILE } from "./env";

export interface HttpResult<T = Record<string, unknown>> {
  status: number;
  body: T;
}

async function call<T>(method: "GET" | "POST", path: string, body?: unknown, raw?: string): Promise<HttpResult<T>> {
  const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
  const res = await fetch(`${FACILITATOR_URL}${path}`, {
    method,
    headers: payload === undefined ? undefined : { "content-type": "application/json" },
    body: payload,
  });
  const text = await res.text();
  let parsed: T;
  try {
    parsed = JSON.parse(text) as T;
  } catch {
    throw new Error(`${method} ${path} returned ${res.status} with a non-JSON body: ${text.slice(0, 500)}`);
  }
  return { status: res.status, body: parsed };
}

/** POST a raw body (for deliberately unreadable requests). */
export async function postRaw(path: "/verify" | "/settle", body: string): Promise<HttpResult<Record<string, unknown>>> {
  return call<Record<string, unknown>>("POST", path, undefined, body);
}

/** x402 v2 facilitator request body (specs/x402-specification-v2.md §7.1). */
function request(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) {
  return { x402Version: 2, paymentPayload, paymentRequirements };
}

export function supported() {
  return call<{
    kinds: { x402Version: number; scheme: string; network: string; extra?: unknown }[];
    extensions: unknown[];
    signers: Record<string, string[]>;
  }>("GET", "/supported");
}

export function verify(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) {
  return call<Record<string, unknown>>("POST", "/verify", request(paymentPayload, paymentRequirements));
}

export function settle(paymentPayload: PaymentPayload, paymentRequirements: PaymentRequirements) {
  return call<Record<string, unknown>>("POST", "/settle", request(paymentPayload, paymentRequirements));
}

/** Append a response to .scratch/fork-tests/observed-responses.jsonl so a run leaves evidence behind. */
export function record(label: string, result: HttpResult<unknown>, extra: Record<string, unknown> = {}): void {
  appendFileSync(OBSERVED_FILE, JSON.stringify({ label, status: result.status, body: result.body, ...extra }) + "\n");
}
