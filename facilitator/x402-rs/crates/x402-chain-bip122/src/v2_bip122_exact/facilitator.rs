//! Verify, settle and supported for `exact` on `bip122`.
//!
//! ```text
//! verify: parse (invalid_payload) → accepted == requirements except extra.paymentId
//!         (invalid_payment_requirements) → network, asset BTC, utxo, upfront, amount > 0,
//!         minConfirmations in the policy → output not being settled (invalid_transaction_state)
//!         → script = derive(payTo, accepted.extra.paymentId, addressType) (invalid_exact_bip122_pay_to)
//!         → eth_call settler.verify → valid, or the verdict's code
//! settle: the same checks, holding a record of (chain, txid, vout) from the start (0011)
//!         → settler.verify again, so a payment that fails costs no gas
//!         → send settler.settle(…, paymentRef = sha256(paymentId)) from the Hemi signer
//!         → mined: success, transaction = the Bitcoin txid, network = bip122:…, no payer
//!           receipt unavailable: settlement_pending with the Hemi hash; the record answers retries
//!           reverted: invalid_transaction_state with the Hemi hash
//! ```
//!
//! The record is the EVM exact scheme's [`PendingSettlements`], keyed by the output instead of the
//! authorization, so its rules carry over unchanged: one settlement per output at a time; a retry of the
//! same payment (same `accepted` and payload) is answered from the Hemi transaction; the first retry that
//! sees it mined gets the success, later ones are replays; a success whose caller left is kept for the
//! caller's retry (0016); a running settle's record is never evicted (0020).
//!
//! The network is listed in `/supported`, and verify and settle run, only once the settler check has
//! passed: the contract answers `SETTLER()` and its `SETTLER` is one of the Hemi signers (D-047). A
//! buyer pays before anyone settles, so advertising a settler that would revert lets a buyer pay for
//! nothing.

use alloy_primitives::{B256, Bytes, TxHash, keccak256};
use bitcoin::secp256k1::{Secp256k1, VerifyOnly};
use std::collections::HashMap;
use std::sync::{Arc, Mutex, PoisonError};
use std::time::{Duration, Instant};
use x402_chain_eip155::v2_eip155_exact::facilitator::pending::{
    InFlight, PendingSettlements, Record,
};
use x402_types::chain::ChainId;
use x402_types::facilitator::SettleCaller;
use x402_types::proto;
use x402_types::proto::{PaymentVerificationError, v2};
use x402_types::scheme::{
    X402SchemeFacilitator, X402SchemeFacilitatorBuilder, X402SchemeFacilitatorError,
};

use crate::V2Bip122Exact;
use crate::chain::{Bip122ChainProvider, Bip122Network, ConfirmationPolicy};
use crate::v2_bip122_exact::derive::{AccountKey, PayToError, address, payment_ref};
use crate::v2_bip122_exact::settler::{
    Check, DeploymentError, SettleOutcome, SettleQuery, Settler, Verdict,
};
use crate::v2_bip122_exact::types::{
    AddressType, BTC, EXACT, ExactBip122Request, UPFRONT, UTXO, parse_request,
};

impl X402SchemeFacilitatorBuilder<Arc<Bip122ChainProvider>> for V2Bip122Exact {
    fn build(
        &self,
        provider: Arc<Bip122ChainProvider>,
        _config: Option<serde_json::Value>,
    ) -> Result<Box<dyn X402SchemeFacilitator>, Box<dyn std::error::Error>> {
        Ok(Box::new(V2Bip122ExactFacilitator::new(
            provider.network(),
            provider.settler(),
            provider.confirmations(),
        )))
    }
}

/// `extra` of the `/supported` kind: what a seller needs to build requirements for this facilitator.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct V2Bip122ExactSupportedExtra {
    pub asset: &'static str,
    pub asset_transfer_method: &'static str,
    pub payment_flow: &'static str,
    pub address_types: Vec<AddressType>,
    pub min_confirmations: ConfirmationPolicy,
    /// The `X402BtcSettler` that records payments.
    pub settler: String,
    /// The Hemi chain it is on.
    pub hemi_network: ChainId,
}

/// A request that passed every check that needs no chain.
struct Prepared {
    request: ExactBip122Request,
    query: SettleQuery,
    /// The derived address, for messages.
    address: String,
}

/// How often a settler check that could not reach Hemi is repeated, at most.
const RECHECK: Duration = Duration::from_secs(30);

/// What the facilitator knows about its settler (see [`V2Bip122ExactFacilitator::ready`]).
#[derive(Debug, Clone)]
enum Deployment {
    /// The check passed. Final: the contract's `SETTLER` and the signers cannot change.
    Ready,
    /// The check ran and failed. Final until restart.
    Invalid(String),
    /// Not checked yet (`checked: None`), or the last check could not reach Hemi.
    Unknown {
        reason: String,
        checked: Option<Instant>,
    },
}

/// Facilitator of `exact` payments on one Bitcoin network.
pub struct V2Bip122ExactFacilitator<S> {
    network: Bip122Network,
    settler: S,
    confirmations: ConfirmationPolicy,
    /// Outputs being settled, or whose settlement transaction on Hemi is pending.
    pending: PendingSettlements,
    secp: Secp256k1<VerifyOnly>,
    deployment: Mutex<Deployment>,
    recheck: Duration,
}

impl<S: Settler> V2Bip122ExactFacilitator<S> {
    pub fn new(network: Bip122Network, settler: S, confirmations: ConfirmationPolicy) -> Self {
        Self {
            network,
            settler,
            confirmations,
            pending: PendingSettlements::default(),
            secp: Secp256k1::verification_only(),
            deployment: Mutex::new(Deployment::Unknown {
                reason: "the settler has not been checked yet".into(),
                checked: None,
            }),
            recheck: RECHECK,
        }
    }

    /// Whether the settler can record payments. Checked on first use and remembered: a passed or a
    /// failed check is final, and a check that could not reach Hemi is repeated at most every
    /// `recheck`. Until it passes, the network is not listed and verify and settle are refused.
    async fn ready(&self) -> Result<(), DeploymentError> {
        let known = |state: &Deployment| match state {
            Deployment::Ready => Some(Ok(())),
            Deployment::Invalid(reason) => Some(Err(DeploymentError::Invalid(reason.clone()))),
            Deployment::Unknown {
                reason,
                checked: Some(at),
            } if at.elapsed() < self.recheck => Some(Err(DeploymentError::Unreachable(reason.clone()))),
            Deployment::Unknown { .. } => None,
        };
        if let Some(known) = known(&self.lock_deployment()) {
            return known;
        }
        let next = match self.settler.check_deployment().await {
            Ok(_) => Deployment::Ready,
            Err(DeploymentError::Invalid(reason)) => Deployment::Invalid(reason),
            Err(DeploymentError::Unreachable(reason)) => Deployment::Unknown {
                reason,
                checked: Some(Instant::now()),
            },
        };
        let mut state = self.lock_deployment();
        // Another request may have finished a check meanwhile; a final answer is never overwritten.
        if matches!(*state, Deployment::Unknown { .. }) {
            #[cfg(feature = "telemetry")]
            match &next {
                Deployment::Ready => tracing::info!(chain = %self.network, "bip122 settler check passed"),
                Deployment::Invalid(reason) => tracing::error!(
                    chain = %self.network, error = %reason,
                    "bip122 settler unusable; not listing this network"
                ),
                Deployment::Unknown { reason, .. } => tracing::warn!(
                    chain = %self.network, error = %reason,
                    "bip122 settler check could not run; not listing this network until it does"
                ),
            }
            *state = next;
        }
        known(&state).unwrap_or_else(|| match &*state {
            Deployment::Unknown { reason, .. } => Err(DeploymentError::Unreachable(reason.clone())),
            _ => unreachable!("known() answers for Ready and Invalid"),
        })
    }

    fn lock_deployment(&self) -> std::sync::MutexGuard<'_, Deployment> {
        self.deployment.lock().unwrap_or_else(PoisonError::into_inner)
    }

    /// Reads the request and checks everything that needs neither the chain nor the derivation.
    fn parse(
        &self,
        request: &proto::VerifyRequest,
    ) -> Result<(ExactBip122Request, u32), X402SchemeFacilitatorError> {
        let request = parse_request(request, self.network)?;
        let min_confirmations = self
            .confirmations
            .required(request.requirements.min_confirmations)
            .map_err(PaymentVerificationError::InvalidPaymentRequirements)?;
        Ok((request, min_confirmations))
    }

    /// Derives the output script the payment must pay.
    fn prepare(
        &self,
        request: ExactBip122Request,
        min_confirmations: u32,
    ) -> Result<Prepared, X402SchemeFacilitatorError> {
        let requirements = &request.requirements;
        let pay_to_error =
            |e: PayToError| PaymentVerificationError::InvalidExactBip122PayTo(e.to_string());
        let key = AccountKey::parse(&requirements.pay_to, self.network).map_err(pay_to_error)?;
        let script = key
            .script(
                &self.secp,
                &requirements.payment_id,
                requirements.address_type,
            )
            .map_err(pay_to_error)?;
        let query = SettleQuery {
            txid: request.payload.txid,
            vout: request.payload.vout,
            script: Bytes::from(script.to_bytes()),
            min_sats: requirements.amount,
            min_confirmations,
        };
        Ok(Prepared {
            address: address(&script, self.network),
            request,
            query,
        })
    }

    /// The record id of an output: the chain and the outpoint.
    fn record_id(&self, request: &ExactBip122Request) -> B256 {
        keccak256(format!(
            "{}/{}/{}",
            self.network, request.payload.txid, request.payload.vout
        ))
    }

    /// Identifies a payment, so that only its retry is answered from the record: the requirements it
    /// accepted (with its payment id) and the payload. The seller's own copy of the requirements is
    /// left out: its SDK may put a new payment id in it on every request.
    fn request_key(request: &ExactBip122Request) -> B256 {
        let key = serde_json::json!({ "accepted": request.accepted, "payload": request.payload });
        keccak256(serde_json::to_vec(&key).unwrap_or_default())
    }

    async fn check(&self, prepared: &Prepared) -> Result<Check, X402SchemeFacilitatorError> {
        let check = self
            .settler
            .verify(&prepared.query)
            .await
            .map_err(|e| X402SchemeFacilitatorError::OnchainFailure(e.to_string()))?;
        match check.verdict {
            Verdict::Ok => Ok(check),
            _ => Err(verdict_error(&check, prepared, &self.settler.hemi_chain())),
        }
    }

    fn success(&self, prepared: &Prepared) -> proto::SettleResponse {
        proto::SettleResponse(serde_json::json!({
            "success": true,
            "transaction": prepared.request.payload.txid.to_string(),
            "network": self.network.to_string(),
        }))
    }

    /// The answer to a retry of a payment whose Hemi transaction was sent earlier but whose outcome its
    /// caller did not receive (0011, 0016). Nothing is sent again.
    async fn pending_outcome(
        &self,
        prepared: &Prepared,
        id: B256,
        transaction: TxHash,
        caller: &SettleCaller,
    ) -> Result<proto::SettleResponse, X402SchemeFacilitatorError> {
        match self.settler.receipt(transaction).await {
            // Nobody would receive this success: leave the record for the next retry.
            Some(true) if !caller.is_waiting() => Ok(self.success(prepared)),
            Some(true) if self.pending.claim(&id, transaction) => Ok(self.success(prepared)),
            // Another retry already got this success: this one is a replay.
            Some(true) => Err(already_settled().into()),
            Some(false) => {
                self.pending.claim(&id, transaction);
                Err(reverted(transaction))
            }
            None => Err(X402SchemeFacilitatorError::SettlementPending {
                transaction: transaction.to_string(),
                details: format!(
                    "Hemi transaction {transaction} recording this payment is not confirmed yet"
                ),
            }),
        }
    }

    async fn settle_prepared(
        &self,
        prepared: &Prepared,
        in_flight: &InFlight<'_>,
        caller: &SettleCaller,
    ) -> Result<proto::SettleResponse, X402SchemeFacilitatorError> {
        // `settle_for` checked the payment through the settler's `verify` just before taking the record,
        // so a payment that fails costs no gas and holds no record (D-037).
        let payment_ref = B256::from(payment_ref(&prepared.request.requirements.payment_id));
        let outcome = self
            .settler
            .settle(&prepared.query, payment_ref)
            .await
            .map_err(|e| X402SchemeFacilitatorError::OnchainFailure(e.to_string()))?;
        match outcome {
            SettleOutcome::Mined(transaction) => {
                #[cfg(feature = "telemetry")]
                tracing::info!(
                    network = %self.network,
                    txid = %prepared.request.payload.txid,
                    vout = prepared.request.payload.vout,
                    hemi_tx = %transaction,
                    payment_ref = %payment_ref,
                    "Bitcoin payment recorded on Hemi"
                );
                // Nobody receives this success if the caller left: keep it for the caller's retry.
                if !caller.is_waiting() {
                    in_flight.keep(transaction);
                }
                Ok(self.success(prepared))
            }
            SettleOutcome::Pending(transaction) => {
                in_flight.keep(transaction);
                Err(X402SchemeFacilitatorError::SettlementPending {
                    transaction: transaction.to_string(),
                    details: format!(
                        "Hemi transaction {transaction} recording this payment was broadcast, but its receipt is not available"
                    ),
                })
            }
            SettleOutcome::Reverted(transaction) => Err(reverted(transaction)),
        }
    }
}

/// The §9 code of a verdict other than `Ok` (`docs/phase2/DESIGN.md`, "Verdict → code").
fn verdict_error(check: &Check, prepared: &Prepared, hemi: &ChainId) -> X402SchemeFacilitatorError {
    let query = &prepared.query;
    let (txid, vout) = (query.txid, query.vout);
    let error = match check.verdict {
        Verdict::TxNotFound => {
            PaymentVerificationError::InvalidExactBip122PayloadTransactionNotFound(format!(
                "Transaction {txid} is not known to hBK on {hemi}: not mined yet, in a block Hemi's view of Bitcoin has not reached yet, or not a transaction"
            ))
        }
        Verdict::OutputNotFound => PaymentVerificationError::InvalidExactBip122PayloadVout(
            format!("Transaction {txid} has no output {vout}"),
        ),
        Verdict::ScriptMismatch => {
            PaymentVerificationError::InvalidExactBip122PayloadRecipientMismatch(format!(
                "Output {txid}:{vout} does not pay {}, the address derived for this payment",
                prepared.address
            ))
        }
        Verdict::OpReturn => PaymentVerificationError::InvalidExactBip122PayloadRecipientMismatch(
            format!("Output {txid}:{vout} is an OP_RETURN output"),
        ),
        Verdict::BelowAmount => {
            PaymentVerificationError::InvalidExactBip122PayloadValueMismatch(format!(
                "Output {txid}:{vout} is worth {} sats, less than the required {}",
                check.sats, query.min_sats
            ))
        }
        Verdict::TooFewConfirmations => {
            PaymentVerificationError::InvalidExactBip122PayloadUnconfirmed(format!(
                "Transaction {txid} has {} confirmation(s); {} required",
                check.confirmations, query.min_confirmations
            ))
        }
        Verdict::AlreadyConsumed => already_settled(),
        Verdict::HbkError => {
            return X402SchemeFacilitatorError::OnchainFailure(format!(
                "hBK on {hemi} could not read transaction {txid}"
            ));
        }
        Verdict::Unknown(value) => {
            return X402SchemeFacilitatorError::OnchainFailure(format!(
                "The settler answered verdict {value}, which this facilitator does not know"
            ));
        }
        Verdict::Ok => unreachable!("only failed verdicts are reported"),
    };
    error.into()
}

/// An output that was already settled: x402 v2 §9 `invalid_transaction_state`.
/// A settler that cannot be used: refused like a network this facilitator does not serve, which it no
/// longer lists. One that could not be checked: an unexpected error, which the caller may retry.
fn not_ready(error: DeploymentError) -> X402SchemeFacilitatorError {
    match error {
        DeploymentError::Invalid(_) => PaymentVerificationError::UnsupportedChain.into(),
        DeploymentError::Unreachable(reason) => X402SchemeFacilitatorError::OnchainFailure(format!(
            "the settler could not be checked: {reason}"
        )),
    }
}

fn already_settled() -> PaymentVerificationError {
    PaymentVerificationError::AuthorizationAlreadyUsed
}

fn reverted(transaction: TxHash) -> X402SchemeFacilitatorError {
    X402SchemeFacilitatorError::TransactionFailed {
        transaction: transaction.to_string(),
        details: format!("Hemi transaction {transaction} recording this payment reverted"),
    }
}

/// The error for an output that is being settled, or whose settlement transaction is pending.
fn in_flight(record: Record) -> PaymentVerificationError {
    PaymentVerificationError::AuthorizationInFlight(match record.transaction {
        Some(transaction) => format!(
            "A settlement of this Bitcoin output is pending in Hemi transaction {transaction}"
        ),
        None => "A settlement of this Bitcoin output is in progress".to_string(),
    })
}

#[async_trait::async_trait]
impl<S: Settler> X402SchemeFacilitator for V2Bip122ExactFacilitator<S> {
    async fn verify(
        &self,
        request: &proto::VerifyRequest,
    ) -> Result<proto::VerifyResponse, X402SchemeFacilitatorError> {
        let (request, min_confirmations) = self.parse(request)?;
        // An output being settled, or whose settlement is pending, must not pay for anything else.
        if let Some(record) = self.pending.get(&self.record_id(&request)) {
            return Err(in_flight(record).into());
        }
        self.ready().await.map_err(not_ready)?;
        let prepared = self.prepare(request, min_confirmations)?;
        self.check(&prepared).await?;
        // No payer: a Bitcoin payment has inputs, not one paying address.
        Ok(proto::VerifyResponse(
            serde_json::json!({ "isValid": true }),
        ))
    }

    async fn settle(
        &self,
        request: &proto::SettleRequest,
    ) -> Result<proto::SettleResponse, X402SchemeFacilitatorError> {
        self.settle_for(request, SettleCaller::waiting()).await
    }

    async fn settle_for(
        &self,
        request: &proto::SettleRequest,
        caller: SettleCaller,
    ) -> Result<proto::SettleResponse, X402SchemeFacilitatorError> {
        let (request, min_confirmations) = self.parse(request)?;
        let id = self.record_id(&request);
        let key = Self::request_key(&request);
        // A retry of a settlement this process ran is answered from its record (0011, 0016); any other
        // request for an output that is being settled is refused.
        if let Some(record) = self.pending.get(&id) {
            if let (true, Some(transaction)) = (record.request == key, record.transaction) {
                let prepared = self.prepare(request, min_confirmations)?;
                return self
                    .pending_outcome(&prepared, id, transaction, &caller)
                    .await;
            }
            return Err(in_flight(record).into());
        }
        // The checks run before the record is taken, unlike the EVM scheme (0020). There the record id
        // is the payer's own nonce; here it is the Bitcoin output, which anyone can read on chain. A
        // request that fails its checks, such as one with a forged paymentId, must never hold the record,
        // or a watcher could block a payment's settlement for the length of an eth_call, again and again
        // (D-037). Two requests that both pass still race at `begin`, and one of them wins.
        self.ready().await.map_err(not_ready)?;
        let prepared = self.prepare(request, min_confirmations)?;
        self.check(&prepared).await?;
        let in_flight_guard = match self.pending.begin(id, key) {
            Ok(guard) => guard,
            Err(Record {
                request: recorded,
                transaction: Some(transaction),
                ..
            }) if recorded == key => {
                return self
                    .pending_outcome(&prepared, id, transaction, &caller)
                    .await;
            }
            Err(record) => return Err(in_flight(record).into()),
        };
        self.settle_prepared(&prepared, &in_flight_guard, &caller)
            .await
    }

    async fn supported(&self) -> Result<proto::SupportedResponse, X402SchemeFacilitatorError> {
        let chain_id = self.network.chain_id();
        if self.ready().await.is_err() {
            return Ok(proto::SupportedResponse {
                kinds: vec![],
                extensions: vec![],
                signers: HashMap::new(),
            });
        }
        let extra = V2Bip122ExactSupportedExtra {
            asset: BTC,
            asset_transfer_method: UTXO,
            payment_flow: UPFRONT,
            address_types: AddressType::ALL.to_vec(),
            min_confirmations: self.confirmations,
            settler: self.settler.address().to_string(),
            hemi_network: self.settler.hemi_chain(),
        };
        let kinds = vec![proto::SupportedPaymentKind {
            x402_version: v2::X402Version2.into(),
            scheme: EXACT.to_string(),
            network: chain_id.to_string(),
            extra: serde_json::to_value(extra).ok(),
        }];
        let signers = HashMap::from([(chain_id, self.settler.signer_addresses())]);
        Ok(proto::SupportedResponse {
            kinds,
            extensions: vec![],
            signers,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::v2_bip122_exact::derive::payment_ref;
    use crate::v2_bip122_exact::types::PaymentId;
    use crate::v2_bip122_exact::types::tests::{
        PAYMENT_ID, TXID, request_json, request_with, requirements,
    };
    use alloy_primitives::Address;
    use serde_json::json;
    use std::collections::HashSet;
    use std::sync::Mutex;
    use x402_types::proto::{AsPaymentProblem, ErrorReason};

    /// What the next `settle` does.
    #[derive(Debug, Clone, Copy)]
    enum Next {
        Mine,
        Pend,
        Revert,
        Fail,
    }

    #[derive(Debug)]
    struct State {
        /// The verdict for an output that is not consumed.
        verdict: Verdict,
        confirmations: u32,
        sats: u64,
        consumed: HashSet<(String, u32)>,
        next: Next,
        receipts: HashMap<TxHash, bool>,
        /// Sent settles: (query, paymentRef, hash).
        sent: Vec<(SettleQuery, B256, TxHash)>,
        verified: Vec<SettleQuery>,
        rpc_down: bool,
        /// What `check_deployment` answers: None passes.
        deployment: Option<DeploymentError>,
        deployment_checks: usize,
    }

    /// The settler contract, simulated: outputs become consumed when a settle is mined.
    #[derive(Clone)]
    struct MockSettler(Arc<Mutex<State>>);

    impl MockSettler {
        fn new() -> Self {
            Self(Arc::new(Mutex::new(State {
                verdict: Verdict::Ok,
                confirmations: 1,
                sats: 1000,
                consumed: HashSet::new(),
                next: Next::Mine,
                receipts: HashMap::new(),
                sent: vec![],
                verified: vec![],
                rpc_down: false,
                deployment: None,
                deployment_checks: 0,
            })))
        }
        fn state(&self) -> std::sync::MutexGuard<'_, State> {
            self.0.lock().unwrap()
        }
        /// Mines a pending settle.
        fn mine(&self, transaction: TxHash) {
            let mut state = self.state();
            let (query, ..) = state
                .sent
                .iter()
                .find(|(.., h)| *h == transaction)
                .unwrap()
                .clone();
            state.consumed.insert((query.txid.to_string(), query.vout));
            state.receipts.insert(transaction, true);
        }
        fn sent(&self) -> usize {
            self.state().sent.len()
        }
    }

    #[async_trait::async_trait]
    impl Settler for MockSettler {
        fn address(&self) -> Address {
            Address::repeat_byte(0x5e)
        }
        fn hemi_chain(&self) -> ChainId {
            ChainId::new("eip155", "43111")
        }
        fn signer_addresses(&self) -> Vec<String> {
            vec![Address::repeat_byte(0x51).to_string()]
        }
        async fn check_deployment(&self) -> Result<Address, DeploymentError> {
            let mut state = self.state();
            state.deployment_checks += 1;
            match &state.deployment {
                None => Ok(Address::repeat_byte(0x51)),
                Some(error) => Err(error.clone()),
            }
        }
        async fn verify(
            &self,
            query: &SettleQuery,
        ) -> Result<Check, crate::v2_bip122_exact::settler::SettlerError> {
            let mut state = self.state();
            if state.rpc_down {
                return Err(crate::v2_bip122_exact::settler::SettlerError(
                    "connection refused".into(),
                ));
            }
            state.verified.push(query.clone());
            let consumed = state
                .consumed
                .contains(&(query.txid.to_string(), query.vout));
            Ok(Check {
                verdict: if consumed {
                    Verdict::AlreadyConsumed
                } else {
                    state.verdict
                },
                sats: state.sats,
                hbk_confirmations: state.confirmations + 1,
                confirmations: state.confirmations,
                is_spent: false,
                settled_by: B256::ZERO,
            })
        }
        async fn settle(
            &self,
            query: &SettleQuery,
            payment_ref: B256,
        ) -> Result<SettleOutcome, crate::v2_bip122_exact::settler::SettlerError> {
            let mut state = self.state();
            let transaction = TxHash::repeat_byte(0xa0 + state.sent.len() as u8);
            match state.next {
                Next::Fail => {
                    return Err(crate::v2_bip122_exact::settler::SettlerError(
                        "nonce too low".into(),
                    ));
                }
                Next::Mine => {
                    state.consumed.insert((query.txid.to_string(), query.vout));
                    state.receipts.insert(transaction, true);
                }
                Next::Revert => {
                    state.receipts.insert(transaction, false);
                }
                Next::Pend => {}
            }
            state.sent.push((query.clone(), payment_ref, transaction));
            Ok(match state.next {
                Next::Mine => SettleOutcome::Mined(transaction),
                Next::Revert => SettleOutcome::Reverted(transaction),
                _ => SettleOutcome::Pending(transaction),
            })
        }
        async fn receipt(&self, transaction: TxHash) -> Option<bool> {
            self.state().receipts.get(&transaction).copied()
        }
    }

    fn facilitator() -> (V2Bip122ExactFacilitator<MockSettler>, MockSettler) {
        let settler = MockSettler::new();
        let facilitator = V2Bip122ExactFacilitator::new(
            Bip122Network::Mainnet,
            settler.clone(),
            ConfirmationPolicy::default(),
        );
        (facilitator, settler)
    }

    fn request() -> proto::VerifyRequest {
        request_with(requirements())
    }

    fn reason(error: X402SchemeFacilitatorError) -> ErrorReason {
        error.as_payment_problem().reason()
    }

    /// The script of the design's test vector: P2WPKH of bc1qcjpwqf8yvtpfqq65dghnt64r6cw653kjs6yrca (test-vectors.json).
    const VECTOR_SCRIPT_PREFIX: [u8; 2] = [0x00, 0x14];

    #[tokio::test]
    async fn verify_asks_the_settler_about_the_derived_script() {
        let (facilitator, settler) = facilitator();
        let response = facilitator.verify(&request()).await.unwrap();
        // No payer: a Bitcoin payment has none to name.
        assert_eq!(response.0, json!({ "isValid": true }));
        let state = settler.state();
        let query = &state.verified[0];
        assert_eq!(query.txid.to_string(), TXID);
        assert_eq!(
            (query.vout, query.min_sats, query.min_confirmations),
            (1, 1000, 1)
        );
        assert_eq!(query.script[..2], VECTOR_SCRIPT_PREFIX);
        let expected = bitcoin::Address::from_str("bc1qcjpwqf8yvtpfqq65dghnt64r6cw653kjs6yrca")
            .unwrap()
            .assume_checked()
            .script_pubkey();
        assert_eq!(query.script.as_ref(), expected.as_bytes());
        assert!(state.sent.is_empty(), "verify sends nothing");
    }

    use std::str::FromStr;

    #[tokio::test]
    async fn each_verdict_has_its_code() {
        let cases = [
            (
                Verdict::TxNotFound,
                ErrorReason::InvalidExactBip122PayloadTransactionNotFound,
            ),
            (
                Verdict::OutputNotFound,
                ErrorReason::InvalidExactBip122PayloadVout,
            ),
            (
                Verdict::ScriptMismatch,
                ErrorReason::InvalidExactBip122PayloadRecipientMismatch,
            ),
            (
                Verdict::OpReturn,
                ErrorReason::InvalidExactBip122PayloadRecipientMismatch,
            ),
            (
                Verdict::BelowAmount,
                ErrorReason::InvalidExactBip122PayloadValueMismatch,
            ),
            (
                Verdict::TooFewConfirmations,
                ErrorReason::InvalidExactBip122PayloadUnconfirmed,
            ),
            (
                Verdict::AlreadyConsumed,
                ErrorReason::InvalidTransactionState,
            ),
            // OnchainFailure: the handler reports unexpected_verify_error / unexpected_settle_error.
            (Verdict::HbkError, ErrorReason::UnexpectedError),
            (Verdict::Unknown(42), ErrorReason::UnexpectedError),
        ];
        for (verdict, code) in cases {
            let (facilitator, settler) = facilitator();
            settler.state().verdict = verdict;
            let verify = facilitator.verify(&request()).await.unwrap_err();
            assert_eq!(reason(verify), code, "verify {verdict:?}");
            let settle = facilitator.settle(&request()).await.unwrap_err();
            assert_eq!(reason(settle), code, "settle {verdict:?}");
            assert_eq!(
                settler.sent(),
                0,
                "{verdict:?}: nothing is sent for a failed verdict"
            );
        }
    }

    #[tokio::test]
    async fn verdict_messages_name_the_output() {
        let (facilitator, settler) = facilitator();
        settler.state().verdict = Verdict::ScriptMismatch;
        let error = facilitator.verify(&request()).await.unwrap_err();
        let message = error.as_payment_problem().details().to_string();
        assert!(message.contains(&format!("{TXID}:1")), "{message}");
        assert!(
            message.contains("bc1qcjpwqf8yvtpfqq65dghnt64r6cw653kjs6yrca"),
            "{message}"
        );
        settler.state().verdict = Verdict::BelowAmount;
        settler.state().sats = 999;
        let error = facilitator.verify(&request()).await.unwrap_err();
        assert!(error.as_payment_problem().details().contains("999 sats"));
    }

    #[tokio::test]
    async fn an_unreachable_hemi_is_unexpected() {
        let (facilitator, settler) = facilitator();
        settler.state().rpc_down = true;
        let error = facilitator.verify(&request()).await.unwrap_err();
        assert!(matches!(
            error,
            X402SchemeFacilitatorError::OnchainFailure(_)
        ));
        settler.state().rpc_down = false;
        settler.state().next = Next::Fail;
        let error = facilitator.settle(&request()).await.unwrap_err();
        assert!(matches!(
            error,
            X402SchemeFacilitatorError::OnchainFailure(_)
        ));
        // Nothing was broadcast, so the record is gone and a retry runs again.
        settler.state().next = Next::Mine;
        assert!(facilitator.settle(&request()).await.is_ok());
    }

    #[tokio::test]
    async fn confirmations_default_and_range_come_from_the_policy() {
        let settler = MockSettler::new();
        let facilitator = V2Bip122ExactFacilitator::new(
            Bip122Network::Mainnet,
            settler.clone(),
            ConfirmationPolicy::new(3, 2, 6).unwrap(),
        );
        let mut r = requirements();
        r["extra"]
            .as_object_mut()
            .unwrap()
            .remove("minConfirmations");
        facilitator.verify(&request_with(r)).await.unwrap();
        assert_eq!(settler.state().verified[0].min_confirmations, 3);
        for asked in [1, 7] {
            let mut r = requirements();
            r["extra"]["minConfirmations"] = json!(asked);
            let error = facilitator.verify(&request_with(r)).await.unwrap_err();
            assert_eq!(
                reason(error),
                ErrorReason::InvalidPaymentRequirements,
                "{asked}"
            );
        }
    }

    #[tokio::test]
    async fn a_pay_to_that_cannot_derive_is_invalid_pay_to() {
        let (facilitator, settler) = facilitator();
        let tpub = {
            let mut data =
                bitcoin::base58::decode_check(requirements()["payTo"].as_str().unwrap()).unwrap();
            data[..4].copy_from_slice(&[0x04, 0x35, 0x87, 0xcf]);
            bitcoin::base58::encode_check(&data)
        };
        for pay_to in [
            json!("0x90F79bf6EB2c4f870365E785982E1f101E93b906"),
            json!("bc1qh7vt6al504zckqydvk0963ht2k82kanru70ysp"),
            json!(tpub),
        ] {
            let mut r = requirements();
            r["payTo"] = pay_to.clone();
            let error = facilitator.verify(&request_with(r)).await.unwrap_err();
            assert_eq!(
                reason(error),
                ErrorReason::InvalidExactBip122PayTo,
                "{pay_to}"
            );
        }
        assert!(settler.state().verified.is_empty());
    }

    /// D-037: the record id is the Bitcoin output, which anyone can read on chain. A request that fails
    /// its checks (here a forged paymentId, which derives another script) must take no record, so the
    /// real settlement that follows is not refused as "in progress".
    #[tokio::test]
    async fn a_failing_settle_takes_no_record_so_the_real_one_is_not_blocked() {
        let (facilitator, settler) = facilitator();
        settler.state().verdict = Verdict::ScriptMismatch;
        let error = facilitator.settle(&request()).await.unwrap_err();
        assert_eq!(
            reason(error),
            ErrorReason::InvalidExactBip122PayloadRecipientMismatch
        );
        assert!(
            settler.state().sent.is_empty(),
            "nothing was sent for the forged request"
        );
        settler.state().verdict = Verdict::Ok;
        let response = facilitator.settle(&request()).await.unwrap();
        assert_eq!(
            response.0["success"],
            json!(true),
            "the real settlement was not blocked"
        );
        assert_eq!(settler.state().sent.len(), 1);
    }

    #[tokio::test]
    async fn settle_records_the_payment_and_answers_with_the_bitcoin_txid() {
        let (facilitator, settler) = facilitator();
        let response = facilitator.settle(&request()).await.unwrap();
        assert_eq!(
            response.0,
            json!({
                "success": true,
                "transaction": TXID,
                "network": "bip122:000000000019d6689c085ae165831e93",
            })
        );
        {
            let state = settler.state();
            assert_eq!(
                state.verified.len(),
                1,
                "verified once, before the record was taken"
            );
            let (query, reference, _) = &state.sent[0];
            let id: PaymentId = PAYMENT_ID.parse().unwrap();
            assert_eq!(*reference, B256::from(payment_ref(&id)));
            assert_eq!(query.txid.to_string(), TXID);
        }
        // A replay of the same payment, and any verify of it, is refused.
        let replay = facilitator.settle(&request()).await.unwrap_err();
        assert_eq!(reason(replay), ErrorReason::InvalidTransactionState);
        let verify = facilitator.verify(&request()).await.unwrap_err();
        assert_eq!(reason(verify), ErrorReason::InvalidTransactionState);
        assert_eq!(settler.sent(), 1);
    }

    #[tokio::test]
    async fn a_pending_settlement_is_retried_once_then_replayed() {
        let (facilitator, settler) = facilitator();
        settler.state().next = Next::Pend;
        let first = facilitator.settle(&request()).await.unwrap_err();
        let hemi_tx = match &first {
            X402SchemeFacilitatorError::SettlementPending { transaction, .. } => {
                transaction.clone()
            }
            other => panic!("{other:?}"),
        };
        // The Hemi hash, which the handler puts in `transaction` (§9 wants the broadcast hash).
        assert_eq!(hemi_tx, TxHash::repeat_byte(0xa0).to_string());
        assert_eq!(reason(first), ErrorReason::SettlementPending);

        // Meanwhile verify refuses the output, naming the Hemi transaction.
        let verify = facilitator.verify(&request()).await.unwrap_err();
        assert!(verify.as_payment_problem().details().contains(&hemi_tx));
        assert_eq!(reason(verify), ErrorReason::InvalidTransactionState);

        // Another payment claiming the same output is refused too.
        let mut other = requirements();
        other["extra"]["paymentId"] = json!("ffeeddccbbaa99887766554433221100");
        let error = facilitator.settle(&request_with(other)).await.unwrap_err();
        assert_eq!(reason(error), ErrorReason::InvalidTransactionState);

        // A retry of the same payment is answered from the record, sending nothing.
        let retry = facilitator.settle(&request()).await.unwrap_err();
        assert!(
            matches!(&retry, X402SchemeFacilitatorError::SettlementPending { transaction, .. } if *transaction == hemi_tx)
        );
        // Even when the seller's copy of the requirements carries a fresh payment id.
        let mut seller = requirements();
        seller["extra"]["paymentId"] = json!("0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f0f");
        let fresh = request_json(requirements(), json!({ "txid": TXID, "vout": 1 }), seller);
        let retry = facilitator.settle(&fresh).await.unwrap_err();
        assert_eq!(reason(retry), ErrorReason::SettlementPending);
        assert_eq!(settler.sent(), 1);

        // Mined: the first retry gets the success, the next one is a replay.
        settler.mine(TxHash::repeat_byte(0xa0));
        let success = facilitator.settle(&request()).await.unwrap();
        assert_eq!(success.0["success"], json!(true));
        assert_eq!(success.0["transaction"], json!(TXID));
        let replay = facilitator.settle(&request()).await.unwrap_err();
        assert_eq!(reason(replay), ErrorReason::InvalidTransactionState);
        assert_eq!(settler.sent(), 1);
    }

    #[tokio::test]
    async fn a_reverted_settlement_reports_its_hemi_hash_and_frees_the_output() {
        let (facilitator, settler) = facilitator();
        settler.state().next = Next::Revert;
        let error = facilitator.settle(&request()).await.unwrap_err();
        assert!(
            matches!(&error, X402SchemeFacilitatorError::TransactionFailed { transaction, .. }
            if *transaction == TxHash::repeat_byte(0xa0).to_string())
        );
        assert_eq!(reason(error), ErrorReason::InvalidTransactionState);
        settler.state().next = Next::Mine;
        assert!(facilitator.settle(&request()).await.is_ok());
        assert_eq!(settler.sent(), 2);
    }

    #[tokio::test]
    async fn a_pending_settlement_that_reverts_is_reported_with_its_hash_once() {
        let (facilitator, settler) = facilitator();
        settler.state().next = Next::Pend;
        facilitator.settle(&request()).await.unwrap_err();
        settler
            .state()
            .receipts
            .insert(TxHash::repeat_byte(0xa0), false);
        let error = facilitator.settle(&request()).await.unwrap_err();
        assert!(matches!(
            error,
            X402SchemeFacilitatorError::TransactionFailed { .. }
        ));
        // The record is gone: the next settle starts afresh.
        settler.state().next = Next::Mine;
        assert!(facilitator.settle(&request()).await.is_ok());
    }

    #[tokio::test]
    async fn a_success_whose_caller_left_is_kept_for_its_retry() {
        let (facilitator, settler) = facilitator();
        let gone = SettleCaller::new(|| false);
        assert!(facilitator.settle_for(&request(), gone).await.is_ok());
        // The caller's retry gets the success it missed, once.
        let retry = facilitator.settle(&request()).await.unwrap();
        assert_eq!(retry.0["transaction"], json!(TXID));
        let replay = facilitator.settle(&request()).await.unwrap_err();
        assert_eq!(reason(replay), ErrorReason::InvalidTransactionState);
        assert_eq!(settler.sent(), 1);
    }

    #[tokio::test]
    async fn malformed_requests_never_reach_the_settler() {
        let (facilitator, settler) = facilitator();
        let bad_payload = request_json(
            requirements(),
            json!({ "txid": "00", "vout": 1 }),
            requirements(),
        );
        assert_eq!(
            reason(facilitator.verify(&bad_payload).await.unwrap_err()),
            ErrorReason::InvalidPayload
        );
        let mismatch = request_json(requirements(), json!({ "txid": TXID, "vout": 1 }), {
            let mut r = requirements();
            r["amount"] = json!("1");
            r
        });
        assert_eq!(
            reason(facilitator.settle(&mismatch).await.unwrap_err()),
            ErrorReason::InvalidPaymentRequirements
        );
        assert!(settler.state().verified.is_empty());
    }

    #[tokio::test]
    async fn supported_lists_the_kind_and_the_hemi_signer() {
        let (facilitator, _) = facilitator();
        let supported = facilitator.supported().await.unwrap();
        let json = serde_json::to_value(&supported).unwrap();
        assert_eq!(
            json["kinds"],
            json!([{
                "x402Version": 2,
                "scheme": "exact",
                "network": "bip122:000000000019d6689c085ae165831e93",
                "extra": {
                    "asset": "BTC",
                    "assetTransferMethod": "utxo",
                    "paymentFlow": "upfront",
                    "addressTypes": ["p2wpkh", "p2tr"],
                    "minConfirmations": { "default": 1, "floor": 1, "ceiling": 6 },
                    "settler": Address::repeat_byte(0x5e).to_string(),
                    "hemiNetwork": "eip155:43111",
                }
            }])
        );
        assert_eq!(
            json["signers"],
            json!({ "bip122:000000000019d6689c085ae165831e93": [Address::repeat_byte(0x51).to_string()] })
        );
        assert_eq!(json["extensions"], json!([]));
    }

    #[tokio::test]
    async fn the_settler_is_checked_once_when_it_passes() {
        let (facilitator, settler) = facilitator();
        facilitator.supported().await.unwrap();
        facilitator.verify(&request()).await.unwrap();
        facilitator.supported().await.unwrap();
        assert_eq!(settler.state().deployment_checks, 1);
    }

    /// The audit's F04: a settler whose SETTLER is another address (or no settler at all) must not be
    /// listed, or a seller offers BTC, a buyer pays, and every settle reverts.
    #[tokio::test]
    async fn an_unusable_settler_is_not_listed_and_its_payments_are_refused() {
        let (facilitator, settler) = facilitator();
        settler.state().deployment = Some(DeploymentError::Invalid(
            "the settler only accepts settle() from 0x15d3…".into(),
        ));
        let supported = serde_json::to_value(facilitator.supported().await.unwrap()).unwrap();
        assert_eq!(supported["kinds"], json!([]));
        assert_eq!(supported["signers"], json!({}));
        assert_eq!(
            reason(facilitator.verify(&request()).await.unwrap_err()),
            ErrorReason::InvalidNetwork
        );
        assert_eq!(
            reason(facilitator.settle(&request()).await.unwrap_err()),
            ErrorReason::InvalidNetwork
        );
        let state = settler.state();
        assert!(state.verified.is_empty() && state.sent.is_empty());
        // Final: not asked again.
        assert_eq!(state.deployment_checks, 1);
    }

    #[tokio::test]
    async fn a_check_that_cannot_reach_hemi_is_repeated_and_the_network_is_listed_once_it_passes() {
        let (mut facilitator, settler) = facilitator();
        settler.state().deployment = Some(DeploymentError::Unreachable("connection refused".into()));
        let supported = serde_json::to_value(facilitator.supported().await.unwrap()).unwrap();
        assert_eq!(supported["kinds"], json!([]));
        assert!(matches!(
            facilitator.settle(&request()).await.unwrap_err(),
            X402SchemeFacilitatorError::OnchainFailure(_)
        ));
        // Within the recheck interval the answer is remembered, not asked again.
        assert_eq!(settler.state().deployment_checks, 1);
        assert_eq!(settler.sent(), 0);

        settler.state().deployment = None;
        facilitator.recheck = Duration::ZERO;
        let supported = serde_json::to_value(facilitator.supported().await.unwrap()).unwrap();
        assert_eq!(supported["kinds"][0]["network"], json!("bip122:000000000019d6689c085ae165831e93"));
        assert_eq!(settler.state().deployment_checks, 2);
        facilitator.settle(&request()).await.unwrap();
        assert_eq!(settler.sent(), 1);
    }
}
