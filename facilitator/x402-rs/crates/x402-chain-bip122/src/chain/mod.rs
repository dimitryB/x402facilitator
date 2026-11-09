//! The `bip122` CAIP-2 namespace: Bitcoin networks, named by the first 16 bytes of their genesis
//! block hash.

#[cfg(feature = "facilitator")]
pub mod config;
#[cfg(feature = "facilitator")]
pub mod provider;

#[cfg(feature = "facilitator")]
pub use config::*;
#[cfg(feature = "facilitator")]
pub use provider::*;

use std::fmt;
use x402_types::chain::ChainId;

/// The CAIP-2 namespace of Bitcoin networks.
pub const BIP122_NAMESPACE: &str = "bip122";

/// A Bitcoin network this crate can verify payments on.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Bip122Network {
    /// Bitcoin mainnet: `bip122:000000000019d6689c085ae165831e93`.
    Mainnet,
    /// Bitcoin testnet3: `bip122:000000000933ea01ad0ee984209779ba`.
    Testnet3,
}

impl Bip122Network {
    /// The CAIP-2 reference: the genesis block hash's first 32 hex characters.
    pub const fn reference(self) -> &'static str {
        match self {
            Bip122Network::Mainnet => "000000000019d6689c085ae165831e93",
            Bip122Network::Testnet3 => "000000000933ea01ad0ee984209779ba",
        }
    }

    /// The CAIP-2 chain id.
    pub fn chain_id(self) -> ChainId {
        ChainId::new(BIP122_NAMESPACE, self.reference())
    }

    /// The `bitcoin` crate's network.
    pub fn network(self) -> bitcoin::Network {
        match self {
            Bip122Network::Mainnet => bitcoin::Network::Bitcoin,
            Bip122Network::Testnet3 => bitcoin::Network::Testnet,
        }
    }

    /// Mainnet or test keys: the version bytes an extended public key must carry on this network.
    pub fn kind(self) -> bitcoin::NetworkKind {
        match self {
            Bip122Network::Mainnet => bitcoin::NetworkKind::Main,
            Bip122Network::Testnet3 => bitcoin::NetworkKind::Test,
        }
    }
}

impl fmt::Display for Bip122Network {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{BIP122_NAMESPACE}:{}", self.reference())
    }
}

/// A chain id that is not one of the supported Bitcoin networks.
#[derive(Debug, thiserror::Error)]
#[error("{0} is not a supported Bitcoin network (bip122:{mainnet} or bip122:{testnet3})",
    mainnet = Bip122Network::Mainnet.reference(), testnet3 = Bip122Network::Testnet3.reference())]
pub struct UnsupportedBip122Chain(pub ChainId);

impl TryFrom<&ChainId> for Bip122Network {
    type Error = UnsupportedBip122Chain;

    fn try_from(chain_id: &ChainId) -> Result<Self, Self::Error> {
        if chain_id.namespace() != BIP122_NAMESPACE {
            return Err(UnsupportedBip122Chain(chain_id.clone()));
        }
        [Bip122Network::Mainnet, Bip122Network::Testnet3]
            .into_iter()
            .find(|network| network.reference() == chain_id.reference())
            .ok_or_else(|| UnsupportedBip122Chain(chain_id.clone()))
    }
}

impl From<Bip122Network> for ChainId {
    fn from(network: Bip122Network) -> Self {
        network.chain_id()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chain_ids_round_trip() {
        for network in [Bip122Network::Mainnet, Bip122Network::Testnet3] {
            let chain_id: ChainId = network.to_string().parse().unwrap();
            assert_eq!(chain_id, network.chain_id());
            assert_eq!(Bip122Network::try_from(&chain_id).unwrap(), network);
        }
        for other in ["eip155:43111", "bip122:000000000019d6689c085ae165831e94"] {
            let chain_id: ChainId = other.parse().unwrap();
            assert!(Bip122Network::try_from(&chain_id).is_err(), "{other}");
        }
    }
}
