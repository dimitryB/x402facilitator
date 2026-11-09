//! Bitcoin L1 payments for the x402 protocol, verified through Hemi's hBK.
//!
//! A buyer pays BTC on Bitcoin to an address derived from the seller's account xpub (`payTo`) and a
//! per-402 `paymentId`. The facilitator does not run a Bitcoin node: it asks the `X402BtcSettler`
//! contract on Hemi, which reads the transaction through Hemi's Bitcoin Kit (hBK, the hVM's view of
//! Bitcoin), and `/settle` records the consumed output `(txid, vout)` in that contract.
//!
//! - [`chain`]: the two `bip122` networks, the chain configuration and the provider, which wraps the
//!   already registered Hemi [`Eip155ChainProvider`](x402_chain_eip155::chain::Eip155ChainProvider).
//! - [`v2_bip122_exact`]: the `exact` scheme on `bip122` (`v2-bip122-exact`).
//!
//! Feature `facilitator` enables the provider and the scheme facilitator; the wire types and the
//! address derivation are always available.

pub mod chain;
pub mod v2_bip122_exact;

pub use v2_bip122_exact::V2Bip122Exact;
