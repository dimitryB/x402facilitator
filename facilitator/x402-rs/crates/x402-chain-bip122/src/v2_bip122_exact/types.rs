//! Wire types of the `exact` scheme on `bip122`, and the parsing of a verify or settle request.
//!
//! The requirements and the payload are read field by field, so that each mistake gets its own x402 v2
//! §9 code and a message that names it, instead of one serde error for the whole request.

use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use std::str::FromStr;
use x402_types::proto;
use x402_types::proto::{PaymentVerificationError, v2};

use crate::chain::Bip122Network;

/// The scheme name.
pub const EXACT: &str = "exact";
/// The only asset: bitcoin, amounts in satoshis.
pub const BTC: &str = "BTC";
/// `extra.assetTransferMethod`: the payment is a transaction output (the TS SDK keys flows by it).
pub const UTXO: &str = "utxo";
/// `extra.paymentFlow`: the buyer pays first and the seller settles before serving.
pub const UPFRONT: &str = "upfront";
/// Tag of the derivation digest (see [`crate::v2_bip122_exact::derive::payment_path`]).
pub const PAYMENT_INDEX_TAG: &[u8] = b"x402-btc";

/// Parses `N` bytes from exactly `2 * N` hex characters; `lowercase` refuses upper case.
fn parse_hex<const N: usize>(s: &str, lowercase: bool) -> Option<[u8; N]> {
    let valid = |c: u8| {
        c.is_ascii_digit()
            || (b'a'..=b'f').contains(&c)
            || (!lowercase && (b'A'..=b'F').contains(&c))
    };
    if s.len() != 2 * N || !s.bytes().all(valid) {
        return None;
    }
    let mut out = [0u8; N];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&s[2 * i..2 * i + 2], 16).ok()?;
    }
    Some(out)
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// The seller's per-402 payment id: 16 bytes, 32 lowercase hex characters on the wire. It selects the
/// derived address and, hashed, is the `paymentRef` recorded on Hemi.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct PaymentId(pub [u8; 16]);

impl FromStr for PaymentId {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        parse_hex::<16>(s, true)
            .map(PaymentId)
            .ok_or_else(|| format!("paymentId must be 32 lowercase hex characters, got {s:?}"))
    }
}

impl fmt::Display for PaymentId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&to_hex(&self.0))
    }
}

/// A Bitcoin transaction id in display byte order (as block explorers and hBK show it).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct Txid(pub [u8; 32]);

impl FromStr for Txid {
    type Err = String;
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        parse_hex::<32>(s, false)
            .map(Txid)
            .ok_or_else(|| format!("txid must be 64 hex characters, got {s:?}"))
    }
}

impl fmt::Display for Txid {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&to_hex(&self.0))
    }
}

impl Serialize for Txid {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for Txid {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

/// The output script the payment must pay: `p2wpkh` (the default) or `p2tr` (BIP86, key path only).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AddressType {
    #[default]
    P2wpkh,
    P2tr,
}

impl AddressType {
    pub const ALL: [AddressType; 2] = [AddressType::P2wpkh, AddressType::P2tr];
}

impl fmt::Display for AddressType {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            AddressType::P2wpkh => "p2wpkh",
            AddressType::P2tr => "p2tr",
        })
    }
}

/// The payload: the output of a Bitcoin transaction that pays the derived address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ExactBip122Payload {
    pub txid: Txid,
    pub vout: u32,
}

/// The requirements the payload accepted, read and checked.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExactBip122Requirements {
    pub network: Bip122Network,
    /// Satoshis; the output must be worth at least this much.
    pub amount: u64,
    /// The seller's account extended public key (`xpub`/`tpub`, or SLIP-132 `zpub`/`vpub`).
    pub pay_to: String,
    pub max_timeout_seconds: u64,
    pub payment_id: PaymentId,
    pub address_type: AddressType,
    /// `extra.minConfirmations`; the facilitator's default when absent.
    pub min_confirmations: Option<u32>,
}

/// A verify or settle request of this scheme, parsed.
#[derive(Debug, Clone)]
pub struct ExactBip122Request {
    pub requirements: ExactBip122Requirements,
    pub payload: ExactBip122Payload,
    /// `paymentPayload.accepted` as sent: with `payload`, it identifies a retry of the same payment.
    pub accepted: serde_json::Value,
}

/// The request as it arrives: the payload's `accepted` and `payload` and the seller's requirements, all
/// still JSON.
type WireRequest =
    v2::VerifyRequest<v2::PaymentPayload<serde_json::Value, serde_json::Value>, serde_json::Value>;

fn invalid_requirements(message: impl Into<String>) -> PaymentVerificationError {
    PaymentVerificationError::InvalidPaymentRequirements(message.into())
}

/// `requirements` without its dynamic `extra.paymentId`: the seller's SDK makes a new one for every 402,
/// so the requirements it sends alongside may carry another one than the payload accepted.
fn without_payment_id(requirements: &serde_json::Value) -> serde_json::Value {
    let mut requirements = requirements.clone();
    if let Some(extra) = requirements
        .get_mut("extra")
        .and_then(serde_json::Value::as_object_mut)
    {
        extra.remove("paymentId");
    }
    requirements
}

/// Reads `accepted` (the requirements the payload accepted) for `network`.
pub fn parse_requirements(
    accepted: &serde_json::Value,
    network: Bip122Network,
) -> Result<ExactBip122Requirements, PaymentVerificationError> {
    let base: v2::PaymentRequirements<String, String, String, Option<serde_json::Value>> =
        serde_json::from_value(accepted.clone())
            .map_err(|e| invalid_requirements(format!("accepted requirements: {e}")))?;
    if base.scheme != EXACT {
        return Err(PaymentVerificationError::UnsupportedScheme);
    }
    if Bip122Network::try_from(&base.network).ok() != Some(network) {
        return Err(PaymentVerificationError::ChainIdMismatch);
    }
    if base.asset != BTC {
        return Err(invalid_requirements(format!(
            "asset must be {BTC:?}, got {:?}",
            base.asset
        )));
    }
    let amount = Some(&base.amount)
        .filter(|a| !a.is_empty() && a.bytes().all(|b| b.is_ascii_digit()))
        .and_then(|a| a.parse::<u64>().ok())
        .filter(|a| *a > 0)
        .ok_or_else(|| {
            invalid_requirements(format!(
                "amount must be a positive whole number of satoshis below 2^64, got {:?}",
                base.amount
            ))
        })?;
    let extra = base
        .extra
        .as_ref()
        .and_then(serde_json::Value::as_object)
        .ok_or_else(|| invalid_requirements("extra must be an object"))?;
    let text = |key: &str| extra.get(key).and_then(serde_json::Value::as_str);
    if text("assetTransferMethod") != Some(UTXO) {
        return Err(invalid_requirements(format!(
            "extra.assetTransferMethod must be {UTXO:?}"
        )));
    }
    if text("paymentFlow") != Some(UPFRONT) {
        return Err(invalid_requirements(format!(
            "extra.paymentFlow must be {UPFRONT:?}"
        )));
    }
    let payment_id = text("paymentId")
        .ok_or_else(|| invalid_requirements("extra.paymentId is missing"))?
        .parse::<PaymentId>()
        .map_err(|e| invalid_requirements(format!("extra.{e}")))?;
    let address_type = match extra.get("addressType") {
        None => AddressType::default(),
        Some(value) => AddressType::deserialize(value).map_err(|_| {
            invalid_requirements(format!(
                "extra.addressType must be \"p2wpkh\" or \"p2tr\", got {value}"
            ))
        })?,
    };
    let min_confirmations = match extra.get("minConfirmations") {
        None => None,
        Some(value) => Some(
            value
                .as_u64()
                .and_then(|n| u32::try_from(n).ok())
                .ok_or_else(|| {
                    invalid_requirements(format!(
                        "extra.minConfirmations must be a whole number, got {value}"
                    ))
                })?,
        ),
    };
    Ok(ExactBip122Requirements {
        network,
        amount,
        pay_to: base.pay_to,
        max_timeout_seconds: base.max_timeout_seconds,
        payment_id,
        address_type,
        min_confirmations,
    })
}

/// Parses a verify or settle request for `network`, in the order the scheme checks it:
///
/// 1. the request and the payload's shape (`invalid_payload`);
/// 2. `accepted` equals the seller's requirements, except `extra.paymentId` (`invalid_payment_requirements`);
/// 3. the accepted requirements: network (`invalid_network`), asset, amount, transfer method, flow,
///    payment id, address type (`invalid_payment_requirements`).
pub fn parse_request(
    request: &proto::VerifyRequest,
    network: Bip122Network,
) -> Result<ExactBip122Request, PaymentVerificationError> {
    let wire: WireRequest = serde_json::from_str(request.as_str())?;
    let payload: ExactBip122Payload = serde_json::from_value(wire.payment_payload.payload)
        .map_err(|e| {
            PaymentVerificationError::InvalidFormat(format!(
                "payload must be {{\"txid\": <64 hex>, \"vout\": <output index>}}: {e}"
            ))
        })?;
    let accepted = wire.payment_payload.accepted;
    if without_payment_id(&accepted) != without_payment_id(&wire.payment_requirements) {
        return Err(PaymentVerificationError::AcceptedRequirementsMismatch);
    }
    let requirements = parse_requirements(&accepted, network)?;
    Ok(ExactBip122Request {
        requirements,
        payload,
        accepted,
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use serde_json::json;
    use x402_types::proto::{AsPaymentProblem, ErrorReason};

    pub const XPUB: &str = "xpub6CatWdiZiodmUeTDp8LT5or8nmbKNcuyvz7WyksVFkKB4RHwCD3XyuvPEbvqAQY3rAPshWcMLoP2fMFMKHPJ4ZeZXYVUhLv1VMrjPC7PW6V";
    pub const PAYMENT_ID: &str = "00112233445566778899aabbccddeeff";
    pub const TXID: &str = "a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4a1b2c3d4";

    pub fn requirements() -> serde_json::Value {
        json!({
            "scheme": "exact",
            "network": "bip122:000000000019d6689c085ae165831e93",
            "amount": "1000",
            "asset": "BTC",
            "payTo": XPUB,
            "maxTimeoutSeconds": 7200,
            "extra": {
                "assetTransferMethod": "utxo",
                "paymentFlow": "upfront",
                "paymentId": PAYMENT_ID,
                "addressType": "p2wpkh",
                "minConfirmations": 1
            }
        })
    }

    pub fn request_json(
        accepted: serde_json::Value,
        payload: serde_json::Value,
        requirements: serde_json::Value,
    ) -> proto::VerifyRequest {
        let json = json!({
            "x402Version": 2,
            "paymentPayload": { "x402Version": 2, "accepted": accepted, "payload": payload },
            "paymentRequirements": requirements,
        });
        serde_json::from_str(&json.to_string()).unwrap()
    }

    pub fn request_with(accepted: serde_json::Value) -> proto::VerifyRequest {
        request_json(
            accepted.clone(),
            json!({ "txid": TXID, "vout": 1 }),
            accepted,
        )
    }

    fn parse(request: &proto::VerifyRequest) -> Result<ExactBip122Request, ErrorReason> {
        parse_request(request, Bip122Network::Mainnet).map_err(|e| e.as_payment_problem().reason())
    }

    fn with_extra(key: &str, value: serde_json::Value) -> serde_json::Value {
        let mut r = requirements();
        r["extra"][key] = value;
        r
    }

    fn with_field(key: &str, value: serde_json::Value) -> serde_json::Value {
        let mut r = requirements();
        r[key] = value;
        r
    }

    #[test]
    fn a_well_formed_request_parses() {
        let parsed = parse(&request_with(requirements())).unwrap();
        assert_eq!(parsed.requirements.amount, 1000);
        assert_eq!(parsed.requirements.payment_id.to_string(), PAYMENT_ID);
        assert_eq!(parsed.requirements.address_type, AddressType::P2wpkh);
        assert_eq!(parsed.requirements.min_confirmations, Some(1));
        assert_eq!(parsed.payload.txid.to_string(), TXID);
        assert_eq!(parsed.payload.vout, 1);
    }

    #[test]
    fn defaults_apply_when_optional_extra_fields_are_absent() {
        let mut r = requirements();
        let extra = r["extra"].as_object_mut().unwrap();
        extra.remove("addressType");
        extra.remove("minConfirmations");
        let parsed = parse(&request_with(r)).unwrap();
        assert_eq!(parsed.requirements.address_type, AddressType::P2wpkh);
        assert_eq!(parsed.requirements.min_confirmations, None);
    }

    #[test]
    fn an_upper_case_txid_is_read_and_reported_in_lower_case() {
        let r = requirements();
        let request = request_json(
            r.clone(),
            json!({ "txid": TXID.to_uppercase(), "vout": 0 }),
            r,
        );
        assert_eq!(parse(&request).unwrap().payload.txid.to_string(), TXID);
    }

    #[test]
    fn the_seller_may_send_another_payment_id_than_the_payload_accepted() {
        let accepted = requirements();
        let seller = with_extra("paymentId", json!("ffeeddccbbaa99887766554433221100"));
        let request = request_json(accepted, json!({ "txid": TXID, "vout": 1 }), seller);
        let parsed = parse(&request).unwrap();
        // Derivation uses the accepted one.
        assert_eq!(parsed.requirements.payment_id.to_string(), PAYMENT_ID);
        // Or none at all.
        let mut seller = requirements();
        seller["extra"].as_object_mut().unwrap().remove("paymentId");
        let request = request_json(requirements(), json!({ "txid": TXID, "vout": 1 }), seller);
        assert!(parse(&request).is_ok());
    }

    #[test]
    fn every_other_difference_from_the_requirements_is_refused() {
        let differences = [
            with_field("amount", json!("999")),
            with_field("payTo", json!("xpub-other")),
            with_field("maxTimeoutSeconds", json!(60)),
            with_extra("minConfirmations", json!(2)),
            with_extra("addressType", json!("p2tr")),
        ];
        for seller in differences {
            let request = request_json(
                requirements(),
                json!({ "txid": TXID, "vout": 1 }),
                seller.clone(),
            );
            assert_eq!(
                parse(&request).unwrap_err(),
                ErrorReason::InvalidPaymentRequirements,
                "{seller}"
            );
        }
    }

    #[test]
    fn malformed_payloads_are_invalid_payload() {
        let payloads = [
            json!({ "txid": TXID }),
            json!({ "vout": 1 }),
            json!({ "txid": &TXID[2..], "vout": 1 }),
            json!({ "txid": format!("{TXID}00"), "vout": 1 }),
            json!({ "txid": format!("0x{}", &TXID[2..]), "vout": 1 }),
            json!({ "txid": TXID.replace('a', "g"), "vout": 1 }),
            json!({ "txid": TXID, "vout": -1 }),
            json!({ "txid": TXID, "vout": 4294967296u64 }),
            json!({ "txid": TXID, "vout": "1" }),
            json!("not an object"),
        ];
        for payload in payloads {
            let request = request_json(requirements(), payload.clone(), requirements());
            assert_eq!(
                parse(&request).unwrap_err(),
                ErrorReason::InvalidPayload,
                "{payload}"
            );
        }
        // A request that is not a v2 request at all.
        let request: proto::VerifyRequest =
            serde_json::from_str(r#"{"x402Version":2,"paymentPayload":{}}"#).unwrap();
        assert_eq!(parse(&request).unwrap_err(), ErrorReason::InvalidPayload);
    }

    #[test]
    fn each_bad_requirement_has_its_code() {
        let cases = [
            (
                with_field("network", json!("bip122:000000000933ea01ad0ee984209779ba")),
                ErrorReason::InvalidNetwork,
            ),
            (
                with_field("network", json!("eip155:43111")),
                ErrorReason::InvalidNetwork,
            ),
            (
                with_field("scheme", json!("upto")),
                ErrorReason::UnsupportedScheme,
            ),
            (
                with_field("asset", json!("0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28")),
                ErrorReason::InvalidPaymentRequirements,
            ),
            (
                with_field("amount", json!("0")),
                ErrorReason::InvalidPaymentRequirements,
            ),
            (
                with_field("amount", json!("-5")),
                ErrorReason::InvalidPaymentRequirements,
            ),
            (
                with_field("amount", json!("1.5")),
                ErrorReason::InvalidPaymentRequirements,
            ),
            (
                with_field("amount", json!("18446744073709551616")),
                ErrorReason::InvalidPaymentRequirements,
            ),
            (
                with_field("amount", json!(1000)),
                ErrorReason::InvalidPaymentRequirements,
            ),
            (
                with_field("extra", json!(null)),
                ErrorReason::InvalidPaymentRequirements,
            ),
            (
                with_extra("assetTransferMethod", json!("permit2")),
                ErrorReason::InvalidPaymentRequirements,
            ),
            (
                with_extra("paymentFlow", json!("deferred")),
                ErrorReason::InvalidPaymentRequirements,
            ),
            (
                with_extra("paymentId", json!("00112233445566778899AABBCCDDEEFF")),
                ErrorReason::InvalidPaymentRequirements,
            ),
            (
                with_extra("paymentId", json!("0011")),
                ErrorReason::InvalidPaymentRequirements,
            ),
            (
                with_extra("paymentId", json!(null)),
                ErrorReason::InvalidPaymentRequirements,
            ),
            (
                with_extra("addressType", json!("p2pkh")),
                ErrorReason::InvalidPaymentRequirements,
            ),
            (
                with_extra("minConfirmations", json!(-1)),
                ErrorReason::InvalidPaymentRequirements,
            ),
            (
                with_extra("minConfirmations", json!("1")),
                ErrorReason::InvalidPaymentRequirements,
            ),
        ];
        for (accepted, reason) in cases {
            assert_eq!(
                parse(&request_with(accepted.clone())).unwrap_err(),
                reason,
                "{accepted}"
            );
        }
        let mut no_id = requirements();
        no_id["extra"].as_object_mut().unwrap().remove("paymentId");
        assert_eq!(
            parse(&request_with(no_id)).unwrap_err(),
            ErrorReason::InvalidPaymentRequirements
        );
    }
}
