import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { x402Client } from "@x402/core/client";
import type { PaymentRequirements } from "@x402/core/types";
import cases from "../requirements-cases.json" with { type: "json" };
import { ExactBtcClientScheme, type PayBtc } from "../src/client.js";
import { derivePaymentAddress } from "../src/derive.js";
import { BTC_MAINNET } from "../src/networks.js";

const crate = new URL("../../facilitator/x402-rs/crates/x402-chain-bip122/", import.meta.url);
const written = readFileSync(new URL("../requirements-cases.json", import.meta.url), "utf8");

type Case = (typeof cases.cases)[number] & { set?: Record<string, unknown>; sent?: Record<string, unknown>; remove?: string[]; field?: string };

function accept(c: Case, changes = c.set): PaymentRequirements {
  const req = structuredClone(cases.base) as PaymentRequirements;
  Object.assign(req.extra, changes ?? {});
  for (const key of c.remove ?? []) delete req.extra[key];
  return req;
}

/** The case's `set` as the file writes it, before JSON.parse reads its numbers. One case per line. */
function setAsWritten(c: Case): string {
  const line = written.split("\n").find(l => l.includes(`"name": ${JSON.stringify(c.name)}`));
  const set = line?.match(/"set": (\{[^{}]*\})/)?.[1];
  if (!set) throw new Error(`no "set" on the line of ${c.name}`);
  return set;
}

describe("requirements-cases.json (shared with the Rust facilitator)", () => {
  it("is identical to the crate's copy, as is test-vectors.json", () => {
    for (const file of ["requirements-cases.json", "test-vectors.json"]) {
      expect(readFileSync(new URL(file, crate), "utf8"), file).toBe(readFileSync(new URL(`../${file}`, import.meta.url), "utf8"));
    }
  });

  for (const c of cases.cases as Case[]) {
    it(`${c.name}: ${c.accept ? "pays" : `refuses (${c.field}) before paying`}`, async () => {
      const calls: string[] = [];
      const pay: PayBtc = async address => {
        calls.push(address);
        return { txid: "1".padStart(64, "0"), vout: 0 };
      };
      if (c.accept) {
        const payment = await new x402Client()
          .register(BTC_MAINNET, new ExactBtcClientScheme(pay))
          .setSpendControls({ allowedAssets: [{ network: BTC_MAINNET, asset: "BTC", maxAmountPerPayment: cases.base.amount }] })
          .createPaymentPayload({ x402Version: 2, resource: { url: "http://seller.test/paid" }, accepts: [accept(c)] });
        const derived = derivePaymentAddress(cases.base.payTo, BTC_MAINNET, cases.base.extra.paymentId, c.addressType as "p2wpkh" | "p2tr");
        expect(calls).toEqual([derived.address]);
        // What the facilitator receives as accepted: the seller's terms as JavaScript reads them, which the
        // Rust side of this file builds from `sent`, or from `set` when the case has no `sent`.
        expect(JSON.stringify(payment.accepted)).toBe(JSON.stringify(accept(c, c.sent ?? c.set)));
      } else {
        await expect(new ExactBtcClientScheme(pay).createPaymentPayload(2, accept(c))).rejects.toThrow(new RegExp(`extra\\.${c.field}\\b`));
        expect(calls).toEqual([]);
      }
    });

    if (c.sent) {
      it(`${c.name}: a JavaScript buyer sends ${JSON.stringify(c.sent)} back`, () => {
        const set = setAsWritten(c);
        expect(JSON.stringify(JSON.parse(set))).toBe(JSON.stringify(c.sent));
        // Otherwise the case would test nothing the others do not.
        expect(set.replace(/\s/g, "")).not.toBe(JSON.stringify(c.sent));
      });
    }
  }
});
