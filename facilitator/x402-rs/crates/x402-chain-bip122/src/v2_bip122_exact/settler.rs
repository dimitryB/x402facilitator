//! The `X402BtcSettler` contract on Hemi, and the port the facilitator uses to reach it.
//!
//! The facilitator never reads Bitcoin itself. `verify` is an `eth_call` of the settler's `verify`,
//! which reads the output and its confirmations through hBK and checks that `(txid, vout)` is not
//! consumed. `settle` sends the settler's `settle` from the facilitator's Hemi signer, through the shared
//! Hemi provider's `send_transaction`: the same nonce manager, fee rules, broadcast and receipt handling
//! as every EVM settlement (patches 0006, 0011, 0015 to 0028).
//!
//! The ABI is fixed in `docs/phase2/DESIGN.md` (stream A). `Verdict` is a Solidity enum, which the ABI
//! encodes as `uint8`; it is read as one here, so a verdict this code does not know is an error rather
//! than a decoding failure.

use alloy_primitives::{Address, B256, Bytes, TxHash};
use alloy_sol_types::{SolCall, sol};
use std::fmt;
use std::sync::Arc;
use std::time::Duration;
use x402_types::chain::{ChainId, ChainProviderOps};

use crate::v2_bip122_exact::types::Txid;

sol! {
    /// `X402BtcSettler.Check`, with `Verdict verdict` read as its ABI type `uint8`.
    #[derive(Debug, PartialEq, Eq)]
    struct SettlerCheck {
        uint8 verdict;
        uint64 sats;
        uint32 hbkConfirmations;
        uint32 confirmations;
        bool isSpent;
        bytes32 settledBy;
    }

    /// The functions of `X402BtcSettler` this crate calls.
    interface IX402BtcSettler {
        function SETTLER() external view returns (address);
        function settledBy(bytes32 txid, uint32 vout) external view returns (bytes32);
        function verify(bytes32 txid, uint32 vout, bytes scriptPubKey, uint64 minSats, uint32 minConfirmations) external view returns (SettlerCheck memory);
        function settle(bytes32 txid, uint32 vout, bytes scriptPubKey, uint64 minSats, uint32 minConfirmations, bytes32 paymentRef) external returns (uint64 sats);
    }
}

/// `X402BtcSettler.Verdict`, in the contract's order.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    Ok,
    AlreadyConsumed,
    TxNotFound,
    OutputNotFound,
    ScriptMismatch,
    OpReturn,
    BelowAmount,
    TooFewConfirmations,
    HbkError,
    /// A value the contract's enum does not have (a different contract at the configured address).
    Unknown(u8),
}

impl From<u8> for Verdict {
    fn from(value: u8) -> Self {
        match value {
            0 => Verdict::Ok,
            1 => Verdict::AlreadyConsumed,
            2 => Verdict::TxNotFound,
            3 => Verdict::OutputNotFound,
            4 => Verdict::ScriptMismatch,
            5 => Verdict::OpReturn,
            6 => Verdict::BelowAmount,
            7 => Verdict::TooFewConfirmations,
            8 => Verdict::HbkError,
            other => Verdict::Unknown(other),
        }
    }
}

/// What `X402BtcSettler.verify` found.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Check {
    pub verdict: Verdict,
    /// The output's value, when it was read.
    pub sats: u64,
    /// hBK's own count, before the contract's `CONFIRMATION_OFFSET` correction.
    pub hbk_confirmations: u32,
    /// Bitcoin confirmations, as the contract counts them.
    pub confirmations: u32,
    /// Ignored: the seller may sweep the output once it is paid.
    pub is_spent: bool,
    /// The `paymentRef` the output was settled with; zero while it is not consumed.
    pub settled_by: B256,
}

impl From<SettlerCheck> for Check {
    fn from(check: SettlerCheck) -> Self {
        Self {
            verdict: check.verdict.into(),
            sats: check.sats,
            hbk_confirmations: check.hbkConfirmations,
            confirmations: check.confirmations,
            is_spent: check.isSpent,
            settled_by: check.settledBy,
        }
    }
}

/// The output to check or settle, and what it must satisfy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettleQuery {
    pub txid: Txid,
    pub vout: u32,
    /// The output script derived for the payment.
    pub script: Bytes,
    pub min_sats: u64,
    /// Bitcoin confirmations.
    pub min_confirmations: u32,
}

impl SettleQuery {
    fn txid(&self) -> B256 {
        // Display byte order, as hBK takes it.
        B256::from(self.txid.0)
    }

    /// Calldata of `verify(txid, vout, scriptPubKey, minSats, minConfirmations)`.
    pub fn verify_calldata(&self) -> Bytes {
        IX402BtcSettler::verifyCall {
            txid: self.txid(),
            vout: self.vout,
            scriptPubKey: self.script.clone(),
            minSats: self.min_sats,
            minConfirmations: self.min_confirmations,
        }
        .abi_encode()
        .into()
    }

    /// Calldata of `settle(txid, vout, scriptPubKey, minSats, minConfirmations, paymentRef)`.
    pub fn settle_calldata(&self, payment_ref: B256) -> Bytes {
        IX402BtcSettler::settleCall {
            txid: self.txid(),
            vout: self.vout,
            scriptPubKey: self.script.clone(),
            minSats: self.min_sats,
            minConfirmations: self.min_confirmations,
            paymentRef: payment_ref,
        }
        .abi_encode()
        .into()
    }
}

/// How a sent `settle` transaction ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SettleOutcome {
    /// Mined and succeeded: the output is consumed.
    Mined(TxHash),
    /// Mined and reverted.
    Reverted(TxHash),
    /// Broadcast, but no receipt in time (0006): it may still be mined.
    Pending(TxHash),
}

/// A Hemi call or send that failed without a transaction to report.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SettlerError(pub String);

impl fmt::Display for SettlerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for SettlerError {}

/// Why settlements cannot be sent to the settler, from [`Settler::check_deployment`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DeploymentError {
    /// The check could not run: the `eth_call` to Hemi failed. It is repeated later.
    Unreachable(String),
    /// The check ran and failed: nothing at the address answers `SETTLER()` like an `X402BtcSettler`,
    /// or its `SETTLER` is not one of this facilitator's Hemi signers. Both are fixed until the
    /// facilitator restarts with another settler address or key.
    Invalid(String),
}

impl fmt::Display for DeploymentError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unreachable(reason) | Self::Invalid(reason) => f.write_str(reason),
        }
    }
}

impl std::error::Error for DeploymentError {}

/// The facilitator's view of the settler contract. [`HemiSettler`] is the real one; tests use a mock.
#[async_trait::async_trait]
pub trait Settler: Send + Sync {
    /// The contract's address.
    fn address(&self) -> Address;
    /// The Hemi chain it is deployed on.
    fn hemi_chain(&self) -> ChainId;
    /// Whether settlements can be sent to the contract: it answers `SETTLER()` like an
    /// `X402BtcSettler`, and its `SETTLER` is one of the Hemi signers. Returns that `SETTLER`, the only
    /// signer `settle` may be sent from.
    async fn check_deployment(&self) -> Result<Address, DeploymentError>;
    /// `verify`, as an `eth_call`. It never reverts on a payment; an error here is Hemi or hBK failing.
    async fn verify(&self, query: &SettleQuery) -> Result<Check, SettlerError>;
    /// Sends `settle` from `from`, the contract's `SETTLER` as `check_deployment` returned it, and
    /// waits for its receipt. The Hemi provider rotates its signers for every other transaction, so a
    /// settlement without a sender could go out from one the contract refuses (`NotSettler`).
    async fn settle(
        &self,
        query: &SettleQuery,
        payment_ref: B256,
        from: Address,
    ) -> Result<SettleOutcome, SettlerError>;
    /// Whether a sent `settle` was mined: `Some(true)` succeeded, `Some(false)` reverted, `None` no RPC
    /// has its receipt.
    async fn receipt(&self, transaction: TxHash) -> Option<bool>;
}

pub use hemi::HemiSettler;

mod hemi {
    use super::*;
    use alloy_provider::Provider;
    use alloy_rpc_types_eth::TransactionRequest;
    use x402_chain_eip155::chain::{
        Eip155ChainProvider, Eip155MetaTransactionProvider, Eip155SignerAddresses, MetaTransaction,
        MetaTransactionSendError,
    };

    /// The settler on Hemi, reached through the registered Hemi provider.
    #[derive(Debug, Clone)]
    pub struct HemiSettler {
        hemi: Arc<Eip155ChainProvider>,
        address: Address,
    }

    impl HemiSettler {
        pub fn new(hemi: Arc<Eip155ChainProvider>, address: Address) -> Self {
            Self { hemi, address }
        }

        async fn call(&self, calldata: Bytes) -> Result<Bytes, SettlerError> {
            let request = TransactionRequest::default()
                .to(self.address)
                .input(calldata.into());
            self.hemi.inner().call(request).await.map_err(|e| {
                SettlerError(format!(
                    "eth_call to the settler {} failed: {e}",
                    self.address
                ))
            })
        }
    }

    #[async_trait::async_trait]
    impl Settler for HemiSettler {
        fn address(&self) -> Address {
            self.address
        }

        fn hemi_chain(&self) -> ChainId {
            self.hemi.chain_id()
        }

        async fn check_deployment(&self) -> Result<Address, DeploymentError> {
            let data = self
                .call(IX402BtcSettler::SETTLERCall {}.abi_encode().into())
                .await
                .map_err(|e| DeploymentError::Unreachable(e.0))?;
            let settler = IX402BtcSettler::SETTLERCall::abi_decode_returns(&data).map_err(|e| {
                DeploymentError::Invalid(format!(
                    "{} does not answer SETTLER() like an X402BtcSettler: {e}",
                    self.address
                ))
            })?;
            let signers = Eip155SignerAddresses::signer_addresses(&*self.hemi);
            if !signers.contains(&settler) {
                return Err(DeploymentError::Invalid(format!(
                    "the settler {} only accepts settle() from {settler}, which is not a signer of {} ({signers:?})",
                    self.address,
                    self.hemi.chain_id()
                )));
            }
            Ok(settler)
        }

        async fn verify(&self, query: &SettleQuery) -> Result<Check, SettlerError> {
            let data = self.call(query.verify_calldata()).await?;
            IX402BtcSettler::verifyCall::abi_decode_returns(&data)
                .map(Check::from)
                .map_err(|e| {
                    SettlerError(format!(
                        "the settler {} answered verify() with data that is not a Check: {e}",
                        self.address
                    ))
                })
        }

        async fn settle(
            &self,
            query: &SettleQuery,
            payment_ref: B256,
            from: Address,
        ) -> Result<SettleOutcome, SettlerError> {
            let tx = MetaTransaction::new(self.address, query.settle_calldata(payment_ref))
                .with_from(from);
            match self.hemi.send_transaction(tx).await {
                Ok(receipt) if receipt.status() => {
                    Ok(SettleOutcome::Mined(receipt.transaction_hash))
                }
                Ok(receipt) => Ok(SettleOutcome::Reverted(receipt.transaction_hash)),
                Err(MetaTransactionSendError::ReceiptUnavailable { tx_hash, .. }) => {
                    Ok(SettleOutcome::Pending(tx_hash))
                }
                Err(e) => Err(SettlerError(format!(
                    "settle() on {} was not sent: {e}",
                    self.address
                ))),
            }
        }

        async fn receipt(&self, transaction: TxHash) -> Option<bool> {
            self.hemi
                .find_receipt(transaction, Duration::ZERO)
                .await
                .map(|receipt| receipt.status())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_sol_types::SolValue;

    #[test]
    fn verdicts_follow_the_contract_enum() {
        let order = [
            Verdict::Ok,
            Verdict::AlreadyConsumed,
            Verdict::TxNotFound,
            Verdict::OutputNotFound,
            Verdict::ScriptMismatch,
            Verdict::OpReturn,
            Verdict::BelowAmount,
            Verdict::TooFewConfirmations,
            Verdict::HbkError,
        ];
        for (i, verdict) in order.into_iter().enumerate() {
            assert_eq!(Verdict::from(i as u8), verdict);
        }
        assert_eq!(Verdict::from(9), Verdict::Unknown(9));
    }

    #[test]
    fn selectors_match_the_design_abi() {
        use alloy_primitives::keccak256;
        let selector = |signature: &str| <[u8; 4]>::try_from(&keccak256(signature)[..4]).unwrap();
        assert_eq!(
            IX402BtcSettler::verifyCall::SELECTOR,
            selector("verify(bytes32,uint32,bytes,uint64,uint32)")
        );
        assert_eq!(
            IX402BtcSettler::settleCall::SELECTOR,
            selector("settle(bytes32,uint32,bytes,uint64,uint32,bytes32)")
        );
        assert_eq!(
            IX402BtcSettler::SETTLERCall::SELECTOR,
            selector("SETTLER()")
        );
        assert_eq!(
            IX402BtcSettler::settledByCall::SELECTOR,
            selector("settledBy(bytes32,uint32)")
        );
    }

    #[test]
    fn a_check_decodes_from_the_returned_struct() {
        // What a Solidity `returns (Check memory)` with a static struct encodes: its fields in place.
        let encoded = SettlerCheck {
            verdict: 7,
            sats: 83_050_000,
            hbkConfirmations: 3,
            confirmations: 2,
            isSpent: true,
            settledBy: B256::repeat_byte(0xab),
        }
        .abi_encode();
        let check = Check::from(IX402BtcSettler::verifyCall::abi_decode_returns(&encoded).unwrap());
        assert_eq!(
            check,
            Check {
                verdict: Verdict::TooFewConfirmations,
                sats: 83_050_000,
                hbk_confirmations: 3,
                confirmations: 2,
                is_spent: true,
                settled_by: B256::repeat_byte(0xab),
            }
        );
    }

    #[test]
    fn calldata_carries_the_txid_in_display_order() {
        let query = SettleQuery {
            txid: Txid([0x11; 32]),
            vout: 1,
            script: Bytes::from_static(&[0x00, 0x14]),
            min_sats: 1000,
            min_confirmations: 1,
        };
        let call =
            IX402BtcSettler::settleCall::abi_decode(&query.settle_calldata(B256::repeat_byte(2)))
                .unwrap();
        assert_eq!(call.txid, B256::repeat_byte(0x11));
        assert_eq!(
            (call.vout, call.minSats, call.minConfirmations),
            (1, 1000, 1)
        );
        assert_eq!(call.paymentRef, B256::repeat_byte(2));
        assert_eq!(call.scriptPubKey, query.script);
    }
}
