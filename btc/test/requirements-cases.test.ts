import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { PaymentRequirements } from "@x402/core/types";
import cases from "../requirements-cases.json" with { type: "json" };
import { ExactBtcClientScheme, type PayBtc } from "../src/client.js";
import { derivePaymentAddress } from "../src/derive.js";
import { BTC_MAINNET } from "../src/networks.js";

const crate = new URL("../../facilitator/x402-rs/crates/x402-chain-bip122/", import.meta.url);

type Case = (typeof cases.cases)[number] & { set?: Record<string, unknown>; remove?: string[]; field?: string };

function accept(c: Case): PaymentRequirements {
  const req = structuredClone(cases.base) as PaymentRequirements;
  Object.assign(req.extra, c.set ?? {});
  for (const key of c.remove ?? []) delete req.extra[key];
  return req;
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
      const payment = new ExactBtcClientScheme(pay).createPaymentPayload(2, accept(c));
      if (c.accept) {
        await payment;
        const derived = derivePaymentAddress(cases.base.payTo, BTC_MAINNET, cases.base.extra.paymentId, c.addressType as "p2wpkh" | "p2tr");
        expect(calls).toEqual([derived.address]);
      } else {
        await expect(payment).rejects.toThrow(new RegExp(`extra\\.${c.field}\\b`));
        expect(calls).toEqual([]);
      }
    });
  }
});
