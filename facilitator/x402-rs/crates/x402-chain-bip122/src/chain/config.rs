//! Configuration of a `bip122` chain.
//!
//! ```json
//! "bip122:000000000019d6689c085ae165831e93": {
//!   "hemi": "eip155:43111",
//!   "settler": "$X402_BTC_SETTLER_MAINNET",
//!   "min_confirmations": { "default": 1, "floor": 1, "ceiling": 6 }
//! }
//! ```
//!
//! - `hemi`: the Hemi chain whose provider (signer, RPCs, nonce manager) sends the settlements. It must
//!   be configured in the same file.
//! - `settler`: the `X402BtcSettler` address, a literal or `$VAR`/`${VAR}`. **Unset or empty means the
//!   chain is skipped** with a warning at startup, so a configuration that lists the Bitcoin chains keeps
//!   working before the contract is deployed. Anything else that is not an address is an error.
//! - `min_confirmations`: the Bitcoin confirmations a payment needs when its requirements do not say
//!   (`default`), and the range a seller's `extra.minConfirmations` must fall in (`floor`, `ceiling`).
//!
//! Other keys are ignored, as on an EVM chain, so tooling that sets a key on every chain (the e2e suite
//! sets `receipt_timeout_secs`) keeps working. The provider logs them as a warning, so a misspelt key
//! does not go unnoticed.

use alloy_primitives::Address;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;
use std::str::FromStr;
use x402_types::chain::ChainId;

use crate::chain::Bip122Network;

/// Configuration of one Bitcoin network.
#[derive(Debug, Clone)]
pub struct Bip122ChainConfig {
    pub chain_reference: Bip122Network,
    pub inner: Bip122ChainConfigInner,
}

impl Bip122ChainConfig {
    pub fn chain_id(&self) -> ChainId {
        self.chain_reference.chain_id()
    }

    /// The Hemi chain that records the payments.
    pub fn hemi(&self) -> &ChainId {
        &self.inner.hemi
    }

    /// The settler contract, if one is configured.
    pub fn settler(&self) -> Option<Address> {
        self.inner.settler.address
    }

    /// The settler as configured (`$VAR` or the literal), for messages.
    pub fn settler_source(&self) -> String {
        self.inner.settler.to_string()
    }

    pub fn confirmations(&self) -> ConfirmationPolicy {
        self.inner.min_confirmations
    }

    /// Keys of the chain's object that this crate does not read.
    pub fn ignored_keys(&self) -> Vec<&str> {
        self.inner.ignored.keys().map(String::as_str).collect()
    }
}

/// The JSON object under a `bip122:` key.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Bip122ChainConfigInner {
    pub hemi: ChainId,
    pub settler: SettlerAddress,
    #[serde(default)]
    pub min_confirmations: ConfirmationPolicy,
    /// Keys this crate does not read; kept to be logged, never serialized.
    #[serde(flatten, skip_serializing)]
    pub ignored: BTreeMap<String, serde_json::Value>,
}

/// An optional contract address that may come from an environment variable.
///
/// Unlike [`LiteralOrEnv`](x402_types::config::LiteralOrEnv), an unset or empty variable is not an
/// error: it means "not deployed here", and the chain is skipped.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettlerAddress {
    pub address: Option<Address>,
    /// The variable it was read from, if any.
    pub var: Option<String>,
}

fn env_var_name(s: &str) -> Option<&str> {
    if let Some(name) = s.strip_prefix("${").and_then(|s| s.strip_suffix('}')) {
        return Some(name);
    }
    let name = s.strip_prefix('$')?;
    (!name.is_empty() && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'))
        .then_some(name)
}

impl SettlerAddress {
    /// Reads `value`, looking a `$VAR` up with `lookup`.
    pub fn resolve(value: &str, lookup: impl Fn(&str) -> Option<String>) -> Result<Self, String> {
        let (text, var) = match env_var_name(value) {
            Some(name) => (lookup(name).unwrap_or_default(), Some(name.to_string())),
            None => (value.to_string(), None),
        };
        let text = text.trim();
        if text.is_empty() {
            return Ok(Self { address: None, var });
        }
        let address = Address::from_str(text).map_err(|e| {
            let source = var
                .as_ref()
                .map(|v| format!(" (from ${v})"))
                .unwrap_or_default();
            format!("settler {text:?}{source} is not an address: {e}")
        })?;
        Ok(Self {
            address: Some(address),
            var,
        })
    }
}

impl std::fmt::Display for SettlerAddress {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match (&self.var, &self.address) {
            (Some(var), _) => write!(f, "${var}"),
            (None, Some(address)) => write!(f, "{address}"),
            (None, None) => f.write_str(""),
        }
    }
}

impl<'de> Deserialize<'de> for SettlerAddress {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let value = String::deserialize(deserializer)?;
        Self::resolve(&value, |name| std::env::var(name).ok()).map_err(serde::de::Error::custom)
    }
}

impl Serialize for SettlerAddress {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(&self.to_string())
    }
}

/// Bitcoin confirmations: the default when a payment's requirements name none, and the range a
/// seller's `extra.minConfirmations` must fall in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub struct ConfirmationPolicy {
    pub default: u32,
    pub floor: u32,
    pub ceiling: u32,
}

impl Default for ConfirmationPolicy {
    fn default() -> Self {
        Self {
            default: 1,
            floor: 1,
            ceiling: 6,
        }
    }
}

impl ConfirmationPolicy {
    /// `default` must lie in `[floor, ceiling]`, and `floor` must be at least 1: an output in the
    /// mempool is not a payment.
    pub fn new(default: u32, floor: u32, ceiling: u32) -> Result<Self, String> {
        if floor == 0 || !(floor <= default && default <= ceiling) {
            return Err(format!(
                "min_confirmations needs 1 <= floor <= default <= ceiling, got floor {floor}, default {default}, ceiling {ceiling}"
            ));
        }
        Ok(Self {
            default,
            floor,
            ceiling,
        })
    }

    /// The confirmations a payment needs: the requirements' own, or the default. `Err` if the
    /// requirements ask for a number outside the range.
    pub fn required(&self, requested: Option<u32>) -> Result<u32, String> {
        let required = requested.unwrap_or(self.default);
        if (self.floor..=self.ceiling).contains(&required) {
            Ok(required)
        } else {
            Err(format!(
                "extra.minConfirmations is {required}; this facilitator accepts {} to {}",
                self.floor, self.ceiling
            ))
        }
    }
}

impl<'de> Deserialize<'de> for ConfirmationPolicy {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Raw {
            default: u32,
            floor: u32,
            ceiling: u32,
        }
        let raw = Raw::deserialize(deserializer)?;
        Self::new(raw.default, raw.floor, raw.ceiling).map_err(serde::de::Error::custom)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SETTLER: &str = "0x00000000000000000000000000000000000B7C01";

    fn lookup(name: &str) -> Option<String> {
        match name {
            "SET" => Some(SETTLER.to_string()),
            "EMPTY" => Some("  ".to_string()),
            "BAD" => Some("0x1234".to_string()),
            _ => None,
        }
    }

    #[test]
    fn a_settler_comes_from_a_literal_or_a_variable() {
        let literal = SettlerAddress::resolve(SETTLER, lookup).unwrap();
        assert_eq!(literal.address, Some(SETTLER.parse().unwrap()));
        for syntax in ["$SET", "${SET}"] {
            let from_env = SettlerAddress::resolve(syntax, lookup).unwrap();
            assert_eq!(from_env.address, literal.address);
            assert_eq!(from_env.to_string(), "$SET");
        }
    }

    #[test]
    fn an_unset_or_empty_settler_means_none() {
        for value in ["", "$UNSET", "${UNSET}", "$EMPTY"] {
            assert_eq!(
                SettlerAddress::resolve(value, lookup).unwrap().address,
                None,
                "{value}"
            );
        }
    }

    #[test]
    fn a_settler_that_is_not_an_address_is_an_error() {
        for value in ["$BAD", "0xnope", "settler"] {
            assert!(SettlerAddress::resolve(value, lookup).is_err(), "{value}");
        }
    }

    #[test]
    fn the_design_config_parses_with_its_defaults() {
        let inner: Bip122ChainConfigInner = serde_json::from_str(&format!(
            r#"{{ "hemi": "eip155:43111", "settler": "{SETTLER}",
                 "min_confirmations": {{ "default": 1, "floor": 1, "ceiling": 6 }} }}"#
        ))
        .unwrap();
        assert_eq!(inner.hemi, ChainId::new("eip155", "43111"));
        assert_eq!(inner.min_confirmations, ConfirmationPolicy::default());
        let defaulted: Bip122ChainConfigInner =
            serde_json::from_str(r#"{ "hemi": "eip155:743111", "settler": "" }"#).unwrap();
        assert_eq!(defaulted.min_confirmations, ConfirmationPolicy::default());
        assert_eq!(defaulted.settler.address, None);
    }

    #[test]
    fn a_bad_policy_is_refused() {
        for json in [
            r#"{ "hemi": "eip155:43111", "settler": "", "min_confirmations": { "default": 0, "floor": 0, "ceiling": 6 } }"#,
            r#"{ "hemi": "eip155:43111", "settler": "", "min_confirmations": { "default": 7, "floor": 1, "ceiling": 6 } }"#,
            r#"{ "hemi": "eip155:43111", "settler": "", "min_confirmations": { "default": 2, "floor": 3, "ceiling": 6 } }"#,
            r#"{ "hemi": "eip155:43111", "settler": "", "min_confirmations": { "default": 1, "floor": 1, "ceiling": 6, "max": 9 } }"#,
            r#"{ "settler": "" }"#,
        ] {
            assert!(
                serde_json::from_str::<Bip122ChainConfigInner>(json).is_err(),
                "{json}"
            );
        }
    }

    #[test]
    fn other_keys_are_ignored_and_listed() {
        // As the e2e suite writes it: a key set on every chain, and a misspelt one.
        let inner: Bip122ChainConfigInner = serde_json::from_str(
            r#"{ "hemi": "eip155:43111", "settler": "", "receipt_timeout_secs": 5,
                 "min_confirmation": { "default": 3, "floor": 1, "ceiling": 6 } }"#,
        )
        .unwrap();
        let config = Bip122ChainConfig {
            chain_reference: Bip122Network::Mainnet,
            inner,
        };
        assert_eq!(
            config.ignored_keys(),
            ["min_confirmation", "receipt_timeout_secs"]
        );
        assert_eq!(config.confirmations(), ConfirmationPolicy::default());
        // They are not written back.
        let json = serde_json::to_value(&config.inner).unwrap();
        assert!(json.get("receipt_timeout_secs").is_none());
    }

    #[test]
    fn the_policy_picks_the_requested_or_default_depth_within_its_range() {
        let policy = ConfirmationPolicy::new(2, 1, 6).unwrap();
        assert_eq!(policy.required(None), Ok(2));
        assert_eq!(policy.required(Some(1)), Ok(1));
        assert_eq!(policy.required(Some(6)), Ok(6));
        assert!(policy.required(Some(0)).is_err());
        assert!(policy.required(Some(7)).is_err());
    }
}
