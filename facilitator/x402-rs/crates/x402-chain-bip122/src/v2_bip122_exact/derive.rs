//! The payment address: a non-hardened BIP32 descendant of the seller's account key, selected by the
//! payment id.
//!
//! ```text
//! d       = sha256(utf8("x402-btc") || paymentId[16 bytes])
//! i1      = BE_uint32(d[0..4])  & 0x7fffffff
//! i2      = BE_uint32(d[4..8])  & 0x7fffffff
//! i3      = BE_uint32(d[8..12]) & 0x7fffffff
//! child   = payTo / 0 / i1 / i2 / i3                (receive chain, all non-hardened)
//! p2wpkh  = OP_0 <hash160(child pubkey)>            0014…
//! p2tr    = OP_1 <BIP86 tweak of the child x-only>   5120…  (no script tree)
//! ```
//!
//! Seller, buyer and facilitator all compute it. Only the buyer and seller see the payment id, so a
//! watcher of the chain cannot map a payment back to the 402 it pays, nor build a payload for it.
//!
//! Three levels, 93 bits of path: with one 31-bit index (the first rule), anyone holding the xpub could
//! precompute all 2^31 children, spot a payment's address in the mempool, find a payment id with the
//! same index in about 2^31 hashes, and settle the payment for their own request
//! (`docs/phase2/DESIGN.md`, revised 2026-11-09). The vectors in `test-vectors.json` are stream C's
//! `btc/test-vectors.json`, shared by the TypeScript and Rust implementations.

use bitcoin::bip32::{ChildNumber, Xpub};
use bitcoin::hashes::{Hash, sha256};
use bitcoin::secp256k1::{Secp256k1, Verification};
use bitcoin::{Address, ScriptBuf, base58};

use crate::chain::Bip122Network;
use crate::v2_bip122_exact::types::{AddressType, PAYMENT_INDEX_TAG, PaymentId};

/// The digest the path is read from: `sha256("x402-btc" || paymentId)`.
pub fn payment_digest(payment_id: &PaymentId) -> [u8; 32] {
    let mut preimage = Vec::with_capacity(PAYMENT_INDEX_TAG.len() + 16);
    preimage.extend_from_slice(PAYMENT_INDEX_TAG);
    preimage.extend_from_slice(&payment_id.0);
    sha256::Hash::hash(&preimage).to_byte_array()
}

/// The three indices below `0/` of a payment id (each below 2^31, so non-hardened).
pub fn payment_path(payment_id: &PaymentId) -> [u32; 3] {
    let d = payment_digest(payment_id);
    let index =
        |at: usize| u32::from_be_bytes([d[at], d[at + 1], d[at + 2], d[at + 3]]) & 0x7fff_ffff;
    [index(0), index(4), index(8)]
}

/// The `paymentRef` the settler records: `sha256(paymentId)`.
pub fn payment_ref(payment_id: &PaymentId) -> [u8; 32] {
    sha256::Hash::hash(&payment_id.0).to_byte_array()
}

/// Why `payTo` cannot be used on this network.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PayToError {
    #[error("payTo is not a base58check extended key")]
    NotAnExtendedKey,
    #[error(
        "payTo is an extended private key ({0}); send the account's extended public key, and treat that private key as exposed"
    )]
    PrivateKey(&'static str),
    #[error("payTo is a {found} key, but {network} takes {expected}")]
    WrongNetwork {
        found: &'static str,
        expected: &'static str,
        network: Bip122Network,
    },
    #[error("payTo is a {0} key (P2SH-wrapped or multisig SLIP-132); use the account's xpub/tpub")]
    UnsupportedSlip132(&'static str),
    #[error("payTo is a {0} key, which is for p2wpkh only; use the account's xpub/tpub for p2tr")]
    Slip132AddressType(&'static str),
    #[error("payTo cannot be read as an extended public key: {0}")]
    Invalid(String),
    #[error("{0} is not derivable from payTo: {1}")]
    Derivation(String, String),
}

/// SLIP-132 and BIP32 version bytes this module recognises.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Version {
    /// A public key usable for any address type: `xpub`, `tpub`.
    Public(bitcoin::NetworkKind),
    /// A SLIP-132 P2WPKH public key: `zpub`, `vpub`.
    SegwitPublic(bitcoin::NetworkKind),
    Private,
    Unsupported,
}

const VERSIONS: &[([u8; 4], &str, Version)] = {
    use Version::*;
    use bitcoin::NetworkKind::{Main, Test};
    &[
        ([0x04, 0x88, 0xb2, 0x1e], "xpub", Public(Main)),
        ([0x04, 0x35, 0x87, 0xcf], "tpub", Public(Test)),
        ([0x04, 0xb2, 0x47, 0x46], "zpub", SegwitPublic(Main)),
        ([0x04, 0x5f, 0x1c, 0xf6], "vpub", SegwitPublic(Test)),
        ([0x04, 0x9d, 0x7c, 0xb2], "ypub", Unsupported),
        ([0x04, 0x4a, 0x52, 0x62], "upub", Unsupported),
        ([0x02, 0x95, 0xb4, 0x3f], "Ypub", Unsupported),
        ([0x02, 0xaa, 0x7e, 0xd3], "Zpub", Unsupported),
        ([0x02, 0x42, 0x89, 0xef], "Upub", Unsupported),
        ([0x02, 0x57, 0x54, 0x83], "Vpub", Unsupported),
        ([0x04, 0x88, 0xad, 0xe4], "xprv", Private),
        ([0x04, 0x35, 0x83, 0x94], "tprv", Private),
        ([0x04, 0x9d, 0x78, 0x78], "yprv", Private),
        ([0x04, 0x4a, 0x4e, 0x28], "uprv", Private),
        ([0x04, 0xb2, 0x43, 0x0c], "zprv", Private),
        ([0x04, 0x5f, 0x18, 0xbc], "vprv", Private),
        ([0x02, 0x95, 0xb0, 0x05], "Yprv", Private),
        ([0x02, 0xaa, 0x7a, 0x99], "Zprv", Private),
        ([0x02, 0x42, 0x85, 0xb5], "Uprv", Private),
        ([0x02, 0x57, 0x50, 0x48], "Vprv", Private),
    ]
};

const fn public_prefix(kind: bitcoin::NetworkKind) -> &'static str {
    match kind {
        bitcoin::NetworkKind::Main => "xpub",
        bitcoin::NetworkKind::Test => "tpub",
    }
}

/// The seller's account key, read from `payTo`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AccountKey {
    xpub: Xpub,
    /// `Some("zpub")` or `Some("vpub")` when `payTo` was a SLIP-132 P2WPKH key.
    slip132: Option<&'static str>,
}

impl AccountKey {
    /// Reads `pay_to` for `network`: `xpub` on mainnet, `tpub` on testnet3, or their SLIP-132 P2WPKH
    /// forms `zpub`/`vpub`. `ypub`/`upub` (P2SH-P2WPKH), multisig and private keys are refused.
    pub fn parse(pay_to: &str, network: Bip122Network) -> Result<Self, PayToError> {
        let mut data = base58::decode_check(pay_to).map_err(|_| PayToError::NotAnExtendedKey)?;
        if data.len() != 78 {
            return Err(PayToError::NotAnExtendedKey);
        }
        let prefix: [u8; 4] = [data[0], data[1], data[2], data[3]];
        let (name, version) = VERSIONS
            .iter()
            .find(|(bytes, _, _)| *bytes == prefix)
            .map(|(_, name, version)| (*name, *version))
            .ok_or(PayToError::NotAnExtendedKey)?;
        let (kind, slip132) = match version {
            Version::Private => return Err(PayToError::PrivateKey(name)),
            Version::Unsupported => return Err(PayToError::UnsupportedSlip132(name)),
            Version::Public(kind) => (kind, None),
            Version::SegwitPublic(kind) => (kind, Some(name)),
        };
        if kind != network.kind() {
            let expected = match (network.kind(), slip132) {
                (bitcoin::NetworkKind::Main, None) => "xpub",
                (bitcoin::NetworkKind::Main, Some(_)) => "xpub or zpub",
                (bitcoin::NetworkKind::Test, None) => "tpub",
                (bitcoin::NetworkKind::Test, Some(_)) => "tpub or vpub",
            };
            return Err(PayToError::WrongNetwork {
                found: name,
                expected,
                network,
            });
        }
        // A SLIP-132 key is the same key under other version bytes.
        let standard = VERSIONS
            .iter()
            .find(|(_, n, _)| *n == public_prefix(kind))
            .map(|(bytes, _, _)| *bytes)
            .expect("xpub and tpub are listed");
        data[..4].copy_from_slice(&standard);
        let xpub = Xpub::decode(&data).map_err(|e| PayToError::Invalid(e.to_string()))?;
        Ok(Self { xpub, slip132 })
    }

    /// The public key of payment `payment_id`: child `0/i1/i2/i3` of the account key.
    pub fn child(
        &self,
        secp: &Secp256k1<impl Verification>,
        payment_id: &PaymentId,
    ) -> Result<Xpub, PayToError> {
        let [i1, i2, i3] = payment_path(payment_id);
        let path = format!("0/{i1}/{i2}/{i3}");
        let normal = |index: u32| {
            ChildNumber::from_normal_idx(index)
                .map_err(|e| PayToError::Derivation(path.clone(), e.to_string()))
        };
        let path_numbers = [normal(0)?, normal(i1)?, normal(i2)?, normal(i3)?];
        self.xpub
            .derive_pub(secp, &path_numbers)
            .map_err(|e| PayToError::Derivation(path.clone(), e.to_string()))
    }

    /// The output script payment `payment_id` must pay.
    pub fn script(
        &self,
        secp: &Secp256k1<impl Verification>,
        payment_id: &PaymentId,
        address_type: AddressType,
    ) -> Result<ScriptBuf, PayToError> {
        if let (Some(slip132), AddressType::P2tr) = (self.slip132, address_type) {
            return Err(PayToError::Slip132AddressType(slip132));
        }
        let child = self.child(secp, payment_id)?;
        Ok(match address_type {
            AddressType::P2wpkh => ScriptBuf::new_p2wpkh(&child.to_pub().wpubkey_hash()),
            AddressType::P2tr => ScriptBuf::new_p2tr(secp, child.to_x_only_pub(), None),
        })
    }
}

/// The address of `script` on `network`, for messages.
pub fn address(script: &ScriptBuf, network: Bip122Network) -> String {
    Address::from_script(script, network.network())
        .map(|address| address.to_string())
        .unwrap_or_else(|_| script.to_hex_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v2_bip122_exact::types::tests::{PAYMENT_ID, XPUB};

    /// BIP84's test vector account 0 ("abandon … about"), as SLIP-132 zpub.
    const ZPUB: &str = "zpub6rFR7y4Q2AijBEqTUquhVz398htDFrtymD9xYYfG1m4wAcvPhXNfE3EfH1r1ADqtfSdVCToUG868RvUUkgDKf31mGDtKsAYz2oz2AGutZYs";

    fn id() -> PaymentId {
        PAYMENT_ID.parse().unwrap()
    }

    /// The same key bytes under other version bytes.
    fn reencode(key: &str, version: [u8; 4]) -> String {
        let mut data = base58::decode_check(key).unwrap();
        data[..4].copy_from_slice(&version);
        base58::encode_check(&data)
    }

    fn version(name: &str) -> [u8; 4] {
        VERSIONS.iter().find(|(_, n, _)| *n == name).unwrap().0
    }

    /// Stream C's `btc/test-vectors.json` (commit 6607a91), copied byte for byte.
    const VECTORS: &str = include_str!("../../test-vectors.json");

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    #[test]
    fn reproduces_the_shared_test_vectors() {
        let secp = Secp256k1::verification_only();
        let file: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        let vectors = file["vectors"].as_array().unwrap();
        assert_eq!(vectors.len(), 16);
        for v in vectors {
            let text = |key: &str| v[key].as_str().unwrap().to_string();
            let network = Bip122Network::try_from(
                &text("network")
                    .parse::<x402_types::chain::ChainId>()
                    .unwrap(),
            )
            .unwrap();
            let id: PaymentId = text("paymentId").parse().unwrap();
            let address_type: AddressType =
                serde_json::from_value(v["addressType"].clone()).unwrap();
            let case = format!(
                "{} {} {}",
                text("network"),
                text("paymentId"),
                text("addressType")
            );
            assert_eq!(hex(&payment_digest(&id)), text("digest"), "{case}");
            let indices: Vec<u32> = serde_json::from_value(v["indices"].clone()).unwrap();
            assert_eq!(payment_path(&id).to_vec(), indices, "{case}");
            let [i1, i2, i3] = payment_path(&id);
            assert_eq!(format!("m/0/{i1}/{i2}/{i3}"), text("childPath"), "{case}");
            let key = AccountKey::parse(&text("payTo"), network).unwrap();
            let child = key.child(&secp, &id).unwrap();
            assert_eq!(child.to_pub().to_string(), text("pubkey"), "{case}");
            let script = key.script(&secp, &id, address_type).unwrap();
            assert_eq!(script.to_hex_string(), text("scriptPubKey"), "{case}");
            assert_eq!(address(&script, network), text("address"), "{case}");
            assert_eq!(
                format!("0x{}", hex(&payment_ref(&id))),
                text("paymentRef"),
                "{case}"
            );
        }
    }

    #[test]
    fn reproduces_the_shared_rejections() {
        let secp = Secp256k1::verification_only();
        let file: serde_json::Value = serde_json::from_str(VECTORS).unwrap();
        let rejections = file["rejections"].as_array().unwrap();
        assert_eq!(rejections.len(), 5);
        for r in rejections {
            let reason = r["reason"].as_str().unwrap();
            let network = Bip122Network::try_from(
                &r["network"]
                    .as_str()
                    .unwrap()
                    .parse::<x402_types::chain::ChainId>()
                    .unwrap(),
            )
            .unwrap();
            if let Some(id) = r["paymentId"].as_str() {
                assert!(id.parse::<PaymentId>().is_err(), "{reason}");
                continue;
            }
            let pay_to = r["payTo"].as_str().unwrap();
            if pay_to.starts_with("zpub") {
                // Clients and resource servers must refuse SLIP-132 keys; a facilitator may read a
                // zpub as the same key, for p2wpkh only (DESIGN.md, stream B; the spec's MAY).
                let zpub = AccountKey::parse(pay_to, network).unwrap();
                let xpub = AccountKey::parse(XPUB, network).unwrap();
                assert_eq!(
                    zpub.script(&secp, &id(), AddressType::P2wpkh).unwrap(),
                    xpub.script(&secp, &id(), AddressType::P2wpkh).unwrap(),
                    "{reason}"
                );
                assert!(
                    zpub.script(&secp, &id(), AddressType::P2tr).is_err(),
                    "{reason}"
                );
            } else {
                assert!(
                    matches!(
                        AccountKey::parse(pay_to, network),
                        Err(PayToError::WrongNetwork { .. })
                    ),
                    "{reason}"
                );
            }
        }
    }

    #[test]
    fn p2tr_is_the_bip86_key_path_output_of_the_same_child() {
        let secp = Secp256k1::verification_only();
        let key = AccountKey::parse(XPUB, Bip122Network::Mainnet).unwrap();
        let script = key.script(&secp, &id(), AddressType::P2tr).unwrap();
        assert!(script.is_p2tr());
        let child = key.child(&secp, &id()).unwrap();
        let expected = Address::p2tr(
            &secp,
            child.to_x_only_pub(),
            None,
            bitcoin::Network::Bitcoin,
        );
        assert_eq!(script, expected.script_pubkey());
        assert!(address(&script, Bip122Network::Mainnet).starts_with("bc1p"));
    }

    #[test]
    fn zpub_is_the_same_account_and_implies_p2wpkh() {
        let secp = Secp256k1::verification_only();
        assert_eq!(reencode(ZPUB, version("xpub")), XPUB);
        let xpub = AccountKey::parse(XPUB, Bip122Network::Mainnet).unwrap();
        let zpub = AccountKey::parse(ZPUB, Bip122Network::Mainnet).unwrap();
        assert_eq!(
            zpub.script(&secp, &id(), AddressType::P2wpkh).unwrap(),
            xpub.script(&secp, &id(), AddressType::P2wpkh).unwrap()
        );
        assert_eq!(
            zpub.script(&secp, &id(), AddressType::P2tr).unwrap_err(),
            PayToError::Slip132AddressType("zpub")
        );
    }

    #[test]
    fn testnet_keys_derive_tb_addresses() {
        let secp = Secp256k1::verification_only();
        let tpub = reencode(XPUB, version("tpub"));
        assert!(tpub.starts_with("tpub"));
        let key = AccountKey::parse(&tpub, Bip122Network::Testnet3).unwrap();
        let script = key.script(&secp, &id(), AddressType::P2wpkh).unwrap();
        // Same key, same script; only the address encoding differs.
        let mainnet = AccountKey::parse(XPUB, Bip122Network::Mainnet).unwrap();
        assert_eq!(
            script,
            mainnet.script(&secp, &id(), AddressType::P2wpkh).unwrap()
        );
        assert!(address(&script, Bip122Network::Testnet3).starts_with("tb1q"));
        let vpub = reencode(XPUB, version("vpub"));
        assert!(AccountKey::parse(&vpub, Bip122Network::Testnet3).is_ok());
    }

    #[test]
    fn keys_for_the_other_network_are_refused() {
        let wrong = |key: &str, network| AccountKey::parse(key, network).unwrap_err();
        assert!(matches!(
            wrong(XPUB, Bip122Network::Testnet3),
            PayToError::WrongNetwork {
                found: "xpub",
                expected: "tpub",
                ..
            }
        ));
        assert!(matches!(
            wrong(ZPUB, Bip122Network::Testnet3),
            PayToError::WrongNetwork { found: "zpub", .. }
        ));
        for name in ["tpub", "vpub"] {
            assert!(matches!(
                wrong(&reencode(XPUB, version(name)), Bip122Network::Mainnet),
                PayToError::WrongNetwork { .. }
            ));
        }
    }

    #[test]
    fn unsupported_slip132_and_private_keys_are_refused() {
        for name in ["ypub", "upub", "Ypub", "Zpub", "Upub", "Vpub"] {
            let key = reencode(XPUB, version(name));
            let network = if name.starts_with(['u', 'U', 'V']) {
                Bip122Network::Testnet3
            } else {
                Bip122Network::Mainnet
            };
            assert_eq!(
                AccountKey::parse(&key, network).unwrap_err(),
                PayToError::UnsupportedSlip132(
                    VERSIONS.iter().find(|(_, n, _)| *n == name).unwrap().1
                ),
                "{name}"
            );
        }
        for name in ["xprv", "tprv", "zprv", "vprv"] {
            let key = reencode(XPUB, version(name));
            let error = AccountKey::parse(&key, Bip122Network::Mainnet).unwrap_err();
            assert!(matches!(error, PayToError::PrivateKey(_)), "{name}");
            // The message never repeats the key.
            assert!(!error.to_string().contains(&key));
        }
    }

    #[test]
    fn garbage_is_not_an_extended_key() {
        for pay_to in [
            "",
            "bc1qh7vt6al504zckqydvk0963ht2k82kanru70ysp",
            "0x90F79bf6EB2c4f870365E785982E1f101E93b906",
            &XPUB[..XPUB.len() - 1],
            format!("{XPUB}x").as_str(),
        ] {
            assert_eq!(
                AccountKey::parse(pay_to, Bip122Network::Mainnet).unwrap_err(),
                PayToError::NotAnExtendedKey,
                "{pay_to}"
            );
        }
    }

    #[test]
    fn indices_are_non_hardened_and_follow_the_payment_id() {
        let other: PaymentId = "ffeeddccbbaa99887766554433221100".parse().unwrap();
        assert_ne!(payment_path(&id()), payment_path(&other));
        for byte in 0..=255u8 {
            assert!(
                payment_path(&PaymentId([byte; 16]))
                    .iter()
                    .all(|i| *i < 1 << 31)
            );
        }
        // paymentRef = sha256 of the 16 id bytes.
        assert_eq!(
            payment_ref(&id()),
            sha256::Hash::hash(&id().0).to_byte_array()
        );
    }
}
