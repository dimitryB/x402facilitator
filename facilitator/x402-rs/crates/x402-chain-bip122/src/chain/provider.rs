//! The provider of a `bip122` chain: the Bitcoin network it serves, the Hemi chain that records its
//! payments, and the settler contract there.
//!
//! It holds the **already registered** Hemi [`Eip155ChainProvider`], not a second one built from the
//! same configuration. A second provider would have its own nonce manager, so a BTC settlement and a
//! USDC.e settlement sent by the same Hemi signer at the same time could take the same nonce. Sharing
//! the object also shares patches 0019 to 0028 (fees, one RPC at a time, receipt lookups). The
//! facilitator binary therefore builds its chain registry in two passes: EVM chains first, then each
//! `bip122` chain from its `hemi` chain's provider (patch 0030).

use alloy_primitives::Address;
use std::sync::Arc;
use x402_chain_eip155::chain::Eip155ChainProvider;
use x402_types::chain::{ChainId, ChainProviderOps};

use crate::chain::{Bip122ChainConfig, Bip122Network, ConfirmationPolicy};
use crate::v2_bip122_exact::settler::HemiSettler;

/// A Bitcoin network served through a Hemi chain.
#[derive(Debug)]
pub struct Bip122ChainProvider {
    network: Bip122Network,
    hemi: Arc<Eip155ChainProvider>,
    settler: Address,
    confirmations: ConfirmationPolicy,
}

impl Bip122ChainProvider {
    /// The provider of `config`'s chain, recording payments through `hemi`, which must be the provider
    /// of `config.hemi()`. Checks the settler deployment and logs what it finds; a failed check is a
    /// warning, not an error, so that an RPC outage at startup does not stop the EVM chains.
    pub async fn new(
        config: &Bip122ChainConfig,
        settler: Address,
        hemi: Arc<Eip155ChainProvider>,
    ) -> Result<Self, String> {
        let hemi_chain = ChainProviderOps::chain_id(&*hemi);
        if &hemi_chain != config.hemi() {
            return Err(format!(
                "{} records its payments on {}, but was given the provider of {hemi_chain}",
                config.chain_id(),
                config.hemi()
            ));
        }
        let provider = Self {
            network: config.chain_reference,
            hemi,
            settler,
            confirmations: config.confirmations(),
        };
        #[cfg(feature = "telemetry")]
        if !config.ignored_keys().is_empty() {
            tracing::warn!(
                chain = %provider.network, keys = ?config.ignored_keys(),
                "Ignoring keys a bip122 chain does not read"
            );
        }
        let check = provider.settler().check_deployment().await;
        #[cfg(feature = "telemetry")]
        match &check {
            Ok(signer) => tracing::info!(
                chain = %provider.network, hemi = %hemi_chain, settler = %settler, signer = %signer,
                "Using bip122 provider"
            ),
            Err(e) => tracing::warn!(
                chain = %provider.network, hemi = %hemi_chain, settler = %settler, error = %e,
                "bip122 settler check failed; verify and settle will fail until it passes"
            ),
        }
        let _ = check;
        Ok(provider)
    }

    pub fn network(&self) -> Bip122Network {
        self.network
    }

    /// The Hemi provider shared with the EVM chain.
    pub fn hemi(&self) -> &Arc<Eip155ChainProvider> {
        &self.hemi
    }

    pub fn settler_address(&self) -> Address {
        self.settler
    }

    /// The settler contract, through the shared Hemi provider.
    pub fn settler(&self) -> HemiSettler {
        HemiSettler::new(Arc::clone(&self.hemi), self.settler)
    }

    pub fn confirmations(&self) -> ConfirmationPolicy {
        self.confirmations
    }
}

impl ChainProviderOps for Bip122ChainProvider {
    /// The Hemi signers: they send the settlements, and the settler accepts only its `SETTLER`.
    fn signer_addresses(&self) -> Vec<String> {
        ChainProviderOps::signer_addresses(&*self.hemi)
    }

    fn chain_id(&self) -> ChainId {
        self.network.chain_id()
    }
}
