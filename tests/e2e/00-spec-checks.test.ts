/** The spec checks in lib/spec.ts themselves, on hand-written bodies (no facilitator involved). */
import { describe, expect, it } from "vitest";
import { settleFailureViolations, verifyFailureViolations } from "../lib/spec";

const payer = "0x90F79bf6EB2c4f870365E785982E1f101E93b906" as const;

describe("lib/spec.ts", () => {
  it("accepts the §7.1 example shape, plus the one tolerated field invalidReasonDetails", () => {
    const body = { isValid: false, invalidReason: "insufficient_funds", invalidMessage: "m", invalidReasonDetails: "m", payer };
    expect(verifyFailureViolations(body, { reason: "insufficient_funds", payer })).toEqual([]);
  });

  it("flags any other unknown field, a wrong code, an empty payer", () => {
    const body = { isValid: false, invalidReason: "unexpected_error", payer: "", debug: 1 };
    expect(verifyFailureViolations(body, { reason: "insufficient_funds", payer })).toHaveLength(3);
    const settle = { success: false, errorReason: "insufficient_funds", transaction: "", network: "eip155:1", trace: "x" };
    expect(settleFailureViolations(settle, { reasons: ["insufficient_funds"], network: "eip155:1", broadcast: false })).toEqual([
      'field "trace" is not in §5.3.2',
    ]);
  });

  it("requires the hash once a transaction was broadcast, and an empty string when none was", () => {
    const pending = { success: false, errorReason: "settlement_pending", transaction: "", network: "eip155:1" };
    expect(settleFailureViolations(pending, { reasons: ["settlement_pending"], network: "eip155:1", broadcast: true })).toHaveLength(1);
    const failed = { ...pending, errorReason: "insufficient_funds", transaction: `0x${"ab".repeat(32)}` };
    expect(settleFailureViolations(failed, { reasons: ["insufficient_funds"], network: "eip155:1", broadcast: false })).toHaveLength(1);
  });
});
