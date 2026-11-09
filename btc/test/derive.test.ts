import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync } from "@scure/bip39";
import { getAddress } from "@scure/btc-signer";
import vectors from "../test-vectors.json" with { type: "json" };
import {
  derivePaymentAddress,
  isPaymentId,
  newPaymentId,
  parseAccountXpub,
  paymentIndices,
  paymentPath,
  paymentRef,
  type AddressType,
} from "../src/derive.js";
import { BTC_MAINNET, BTC_NETWORKS, BTC_TESTNET3, parseBtcNetwork, type BtcNetwork } from "../src/networks.js";

const DESIGN_XPUB =
  "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V";
const DESIGN_PAYMENT_ID = "00112233445566778899aabbccddeeff";

describe("the DESIGN.md vector (three levels, revised 2026-11-09)", () => {
  it("i1 is the original single-level index 1745573513; the path is m/0/1745573513/250221288/1390224838", () => {
    expect(paymentIndices(DESIGN_PAYMENT_ID)).toEqual([1745573513, 250221288, 1390224838]);
    expect(paymentPath(DESIGN_PAYMENT_ID)).toBe("m/0/1745573513/250221288/1390224838");
    const d = derivePaymentAddress(DESIGN_XPUB, BTC_MAINNET, DESIGN_PAYMENT_ID);
    expect(d).toMatchObject({ addressType: "p2wpkh", address: "bc1qcjpwqf8yvtpfqq65dghnt64r6cw653kjs6yrca" });
    expect(d.script).toMatch(/^0014[0-9a-f]{40}$/);
  });

  it("test-vectors.json starts from the same account key", () => {
    expect(vectors.vectors[0]).toMatchObject({ payTo: DESIGN_XPUB, paymentId: DESIGN_PAYMENT_ID, accountPath: "m/84'/0'/0'" });
  });
});

describe("cross-checks that do not reuse derive.ts", () => {
  const seed = mnemonicToSeedSync(vectors.mnemonic);
  for (const v of vectors.vectors) {
    it(`${v.network.slice(0, 15)}… ${v.addressType} ${v.paymentId}: node crypto digest, private-key path, btc-signer address`, () => {
      const digest = createHash("sha256").update(Buffer.concat([Buffer.from("x402-btc"), Buffer.from(v.paymentId, "hex")])).digest();
      expect(digest.toString("hex")).toBe(v.digest);
      const indices = [0, 4, 8].map(o => digest.readUInt32BE(o) & 0x7fffffff);
      expect(indices).toEqual(v.indices);
      // The seller's wallet reaches the same key from the seed: account path + /0/i1/i2/i3, private derivation.
      const info = BTC_NETWORKS[v.network as BtcNetwork];
      const priv = HDKey.fromMasterSeed(seed, info.bip32).derive(`${v.accountPath}/0/${indices.join("/")}`);
      expect(Buffer.from(priv.publicKey!).toString("hex")).toBe(v.pubkey);
      expect(getAddress(v.addressType === "p2tr" ? "tr" : "wpkh", priv.privateKey!, info.params)).toBe(v.address);
      expect(createHash("sha256").update(Buffer.from(v.paymentId, "hex")).digest("hex")).toBe(v.paymentRef.slice(2));
    });
  }
});

describe("btc/test-vectors.json (shared with the Rust facilitator)", () => {
  for (const v of vectors.vectors) {
    it(`${v.network.slice(0, 15)}… ${v.addressType} ${v.paymentId}`, () => {
      const d = derivePaymentAddress(v.payTo, v.network as BtcNetwork, v.paymentId, v.addressType as AddressType);
      expect({ indices: d.indices, pubkey: d.pubkey, script: d.script, address: d.address }).toEqual({
        indices: v.indices,
        pubkey: v.pubkey,
        script: v.scriptPubKey,
        address: v.address,
      });
      expect(paymentRef(v.paymentId)).toBe(v.paymentRef);
    });
  }

  it("p2tr scripts are 0x5120 || 32 bytes, p2wpkh 0x0014 || 20 bytes, hrp per network", () => {
    for (const v of vectors.vectors) {
      expect(v.scriptPubKey).toMatch(v.addressType === "p2tr" ? /^5120[0-9a-f]{64}$/ : /^0014[0-9a-f]{40}$/);
      expect(v.address.slice(0, 4)).toBe(`${v.network === BTC_MAINNET ? "bc" : "tb"}1${v.addressType === "p2tr" ? "p" : "q"}`);
    }
  });

  for (const r of vectors.rejections) {
    it(`rejects: ${r.reason}`, () => {
      const xpub = "payTo" in r && r.payTo ? r.payTo : DESIGN_XPUB;
      const paymentId = "paymentId" in r && r.paymentId ? r.paymentId : DESIGN_PAYMENT_ID;
      expect(() => derivePaymentAddress(xpub, r.network as BtcNetwork, paymentId)).toThrow();
    });
  }
});

describe("payTo parsing", () => {
  it("names the conversion for a SLIP-132 key", () => {
    const zpub = vectors.rejections.find(r => r.reason.includes("zpub"))!.payTo!;
    expect(() => parseAccountXpub(zpub, BTC_MAINNET)).toThrow(/zpub \(BIP84, mainnet\).*xpub version bytes/);
  });

  it("says when the key is for the other Bitcoin network", () => {
    expect(() => parseAccountXpub(DESIGN_XPUB, BTC_TESTNET3)).toThrow(/tpub key on Bitcoin testnet3.*other Bitcoin network/);
  });

  it("refuses a private key and garbage", () => {
    expect(() => parseAccountXpub("xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi", BTC_MAINNET)).toThrow(
      /not a private key/,
    );
    expect(() => parseAccountXpub("xpub123", BTC_MAINNET)).toThrow(/not a valid xpub/);
  });
});

describe("paymentId", () => {
  it("is 32 lowercase hex chars", () => {
    expect(isPaymentId(DESIGN_PAYMENT_ID)).toBe(true);
    expect(isPaymentId(DESIGN_PAYMENT_ID.toUpperCase())).toBe(false);
    expect(isPaymentId(DESIGN_PAYMENT_ID.slice(2))).toBe(false);
    expect(isPaymentId(`0x${DESIGN_PAYMENT_ID.slice(2)}`)).toBe(false);
    expect(isPaymentId(1234)).toBe(false);
  });

  it("fresh ids are well-formed and distinct, and every index is non-hardened", () => {
    const ids = Array.from({ length: 500 }, newPaymentId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      expect(isPaymentId(id)).toBe(true);
      for (const i of paymentIndices(id)) {
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThan(2 ** 31);
      }
    }
  });

  it("paymentRef is sha256 of the 16 raw bytes", () => {
    // sha256 of 16 zero bytes
    expect(paymentRef("00000000000000000000000000000000")).toBe(
      "0x374708fff7719dd5979ec875d56cd2286f6d3cf7ec317a3b25632aab28ec37bb",
    );
  });
});

describe("network names", () => {
  it("parses ids and short names", () => {
    expect(parseBtcNetwork("btc-mainnet")).toBe(BTC_MAINNET);
    expect(parseBtcNetwork("btc-testnet3")).toBe(BTC_TESTNET3);
    expect(parseBtcNetwork(BTC_TESTNET3)).toBe(BTC_TESTNET3);
    expect(() => parseBtcNetwork("btc-signet")).toThrow(/Unknown Bitcoin network/);
  });
});
