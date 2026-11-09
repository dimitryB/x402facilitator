//! The `exact` scheme on `bip122` (`v2-bip122-exact`): the buyer pays BTC on Bitcoin to an address
//! derived from the seller's xpub and a per-402 payment id; the facilitator checks the payment through
//! Hemi's hBK and records the consumed output in the `X402BtcSettler` contract on Hemi.
//!
//! - [`types`]: requirements (`extra.paymentId`, `addressType`, `minConfirmations`) and payload
//!   (`{ txid, vout }`), and how a request is read.
//! - [`derive`]: the derivation rule and its test vector.
//! - [`settler`]: the settler contract's ABI and the [`Settler`](settler::Settler) port the
//!   facilitator talks to (feature `facilitator`).
//! - [`facilitator`]: verify, settle and supported (feature `facilitator`).

pub mod derive;
pub mod types;

#[cfg(feature = "facilitator")]
pub mod facilitator;
#[cfg(feature = "facilitator")]
pub mod settler;

#[cfg(feature = "facilitator")]
pub use facilitator::*;
pub use types::*;

use x402_types::scheme::X402SchemeId;

/// The `exact` scheme on Bitcoin (`v2-bip122-exact`).
pub struct V2Bip122Exact;

impl X402SchemeId for V2Bip122Exact {
    fn namespace(&self) -> &str {
        crate::chain::BIP122_NAMESPACE
    }

    fn scheme(&self) -> &str {
        types::EXACT
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_scheme_id_is_v2_bip122_exact() {
        assert_eq!(V2Bip122Exact.id(), "v2-bip122-exact");
        assert_eq!(V2Bip122Exact.x402_version(), 2);
    }
}
