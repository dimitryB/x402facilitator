// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IHbkReader} from "./IHbkReader.sol";

/// @title X402BtcSettler
/// @notice Records Bitcoin L1 payments for the x402 `exact` scheme on `bip122:*` networks. The
///         facilitator asks `verify` whether output `vout` of Bitcoin transaction `txid` pays at least
///         `minSats` to `scriptPubKey` with enough confirmations, as seen through Hemi's Bitcoin Kit
///         (hBK), and then calls `settle`, which re-checks and marks the output consumed so it can pay
///         for one request only.
/// @dev No owner, no upgrade path, no funds: there is no payable function, receive or fallback.
///      Changing hBK, the settler address or the confirmation offset means deploying a new contract.
///
///      - `txid` is in display byte order, as hBK takes it (and as explorers print it).
///      - Only the immutable `SETTLER`, the facilitator's Hemi signer, may call `settle`. Otherwise
///        anyone who sees the Bitcoin payment could consume it first with a bogus `paymentRef` and
///        block the real settlement.
///      - `settledBy[txid][vout]` holds the `paymentRef` (sha256 of the x402 `paymentId`) of the
///        settlement that consumed the output; zero means not consumed. A facilitator retry compares
///        it with its own `paymentRef`.
///      - Confirmations: `confirmations = hbkConfirmations - CONFIRMATION_OFFSET` (floored at 0).
///        On 2026-11-09 hBK's count equalled Bitcoin's on mainnet, so the offset is 0 there
///        (docs/phase2/contracts.md).
///      - `isSpent` is reported but never rejected: the seller may sweep the output once paid.
///      - `verify` never reverts. hBK's responses are read with low-level calls and bounds-checked
///        decoding, so a revert or malformed answer from hBK becomes a verdict instead.
contract X402BtcSettler {
    enum Verdict {
        Ok,
        AlreadyConsumed,
        TxNotFound,
        OutputNotFound,
        ScriptMismatch,
        OpReturn,
        BelowAmount,
        TooFewConfirmations,
        HbkError
    }

    struct Check {
        Verdict verdict;
        uint64 sats;
        uint32 hbkConfirmations;
        uint32 confirmations;
        bool isSpent;
        bytes32 settledBy;
    }

    event Settled(
        bytes32 indexed txid,
        uint32 vout,
        bytes32 indexed scriptPubKeyHash,
        uint64 sats,
        bytes32 indexed paymentRef,
        address settler
    );

    error NotPayable(Verdict verdict);
    error ZeroPaymentRef();
    error NotSettler(address caller);
    error ZeroAddress();
    error NoCode(address account);

    /// hBK, or on Hemi testnet the HbkTestnetAdapter in front of it.
    address public immutable HBK;
    /// The only address allowed to call `settle`: the facilitator's Hemi signer.
    address public immutable SETTLER;
    /// Subtracted from hBK's confirmation count to get Bitcoin confirmations.
    uint32 public immutable CONFIRMATION_OFFSET;

    /// paymentRef of the settlement that consumed (txid, vout); zero if not consumed.
    mapping(bytes32 txid => mapping(uint32 vout => bytes32 paymentRef)) public settledBy;

    bytes32 private constant TX_NOT_FOUND_HASH =
        keccak256(abi.encodeWithSignature("Error(string)", "Bitcoin transaction not found"));
    bytes32 private constant OUT_OF_BOUNDS_HASH = keccak256(abi.encodeWithSignature("Panic(uint256)", 0x32));
    /// Words in the head of hBK's `Output` tuple that this contract reads (IHbkReader.Output).
    uint256 private constant OUTPUT_HEAD_WORDS = 8;

    constructor(
        address hbk,
        address settler,
        uint32 confirmationOffset
    ) {
        if (hbk == address(0) || settler == address(0)) revert ZeroAddress();
        if (hbk.code.length == 0) revert NoCode(hbk);
        HBK = hbk;
        SETTLER = settler;
        CONFIRMATION_OFFSET = confirmationOffset;
    }

    /// @notice Checks whether output `vout` of `txid` pays at least `minSats` to `scriptPubKey` with at
    ///         least `minConfirmations` Bitcoin confirmations and has not been consumed. Never reverts.
    /// @dev The verdict is the first failing check, in this order: AlreadyConsumed (no hBK call);
    ///      TxNotFound, OutputNotFound, HbkError (from reading the output); HbkError (from reading
    ///      the confirmations); OpReturn; ScriptMismatch; BelowAmount; TooFewConfirmations. The other
    ///      fields are filled as far as the checks got.
    function verify(
        bytes32 txid,
        uint32 vout,
        bytes calldata scriptPubKey,
        uint64 minSats,
        uint32 minConfirmations
    ) external view returns (Check memory) {
        return _check(txid, vout, scriptPubKey, minSats, minConfirmations);
    }

    /// @notice Re-runs `verify` and, if the verdict is Ok, marks (txid, vout) consumed by `paymentRef`.
    /// @return sats The output's value.
    function settle(
        bytes32 txid,
        uint32 vout,
        bytes calldata scriptPubKey,
        uint64 minSats,
        uint32 minConfirmations,
        bytes32 paymentRef
    ) external returns (uint64 sats) {
        if (msg.sender != SETTLER) revert NotSettler(msg.sender);
        if (paymentRef == bytes32(0)) revert ZeroPaymentRef();
        Check memory c = _check(txid, vout, scriptPubKey, minSats, minConfirmations);
        if (c.verdict != Verdict.Ok) revert NotPayable(c.verdict);
        settledBy[txid][vout] = paymentRef;
        // hBK is only ever called with STATICCALL, so nothing can re-enter before this event.
        // forge-lint: disable-next-line(reentrancy-events)
        emit Settled(txid, vout, keccak256(scriptPubKey), c.sats, paymentRef, msg.sender);
        return c.sats;
    }

    // ------------------------------------------------------------------------------- internals

    /// What `_readOutput` takes from hBK's answer.
    struct Out {
        uint256 value;
        uint256 scriptLength; // bytes present in `script`
        bytes32 scriptHash; // keccak256 of those bytes
        bytes1 firstByte; // 0x00 if the script is empty
        bool isSpent;
        uint256 fullScriptLength;
        bool containsFullScript;
    }

    function _check(
        bytes32 txid,
        uint32 vout,
        bytes calldata scriptPubKey,
        uint64 minSats,
        uint32 minConfirmations
    ) private view returns (Check memory c) {
        c.settledBy = settledBy[txid][vout];
        if (c.settledBy != bytes32(0)) {
            c.verdict = Verdict.AlreadyConsumed;
            return c;
        }

        (Verdict readVerdict, Out memory o) = _readOutput(txid, vout);
        if (readVerdict != Verdict.Ok) {
            c.verdict = readVerdict;
            return c;
        }
        if (o.value > type(uint64).max) {
            c.verdict = Verdict.HbkError; // more sats than Bitcoin has; hBK answered nonsense
            return c;
        }
        // Safe: checked against type(uint64).max just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        c.sats = uint64(o.value);
        c.isSpent = o.isSpent;

        (bool confOk, uint32 hbkConf) = _readConfirmations(txid);
        if (!confOk) {
            c.verdict = Verdict.HbkError;
            return c;
        }
        c.hbkConfirmations = hbkConf;
        c.confirmations = hbkConf > CONFIRMATION_OFFSET ? hbkConf - CONFIRMATION_OFFSET : 0;

        if (o.firstByte == 0x6a && o.scriptLength > 0) {
            c.verdict = Verdict.OpReturn; // OP_RETURN: provably unspendable, never a payment
        } else if (
            scriptPubKey.length == 0 || !o.containsFullScript || o.fullScriptLength != scriptPubKey.length
                || o.scriptLength != scriptPubKey.length || o.scriptHash != keccak256(scriptPubKey)
        ) {
            c.verdict = Verdict.ScriptMismatch;
        } else if (c.sats < minSats) {
            c.verdict = Verdict.BelowAmount;
        } else if (c.confirmations < minConfirmations) {
            c.verdict = Verdict.TooFewConfirmations;
        } else {
            c.verdict = Verdict.Ok;
        }
    }

    /// Calls hBK's getSpecificTxOutput and decodes the first eight head words of the returned
    /// `Output` with bounds checks, so that no answer from hBK can make the caller revert.
    function _readOutput(
        bytes32 txid,
        uint32 vout
    ) private view returns (Verdict v, Out memory o) {
        (bool ok, bytes memory ret) = HBK.staticcall(abi.encodeCall(IHbkReader.getSpecificTxOutput, (txid, vout)));
        if (!ok) {
            bytes32 h = keccak256(ret);
            if (h == TX_NOT_FOUND_HASH) return (Verdict.TxNotFound, o);
            if (h == OUT_OF_BOUNDS_HASH) return (Verdict.OutputNotFound, o);
            return (Verdict.HbkError, o);
        }
        uint256 len = ret.length;
        // abi.encode(Output): word 0 is the offset of the tuple.
        if (len < 32) return (Verdict.HbkError, o);
        uint256 base = _word(ret, 0);
        if (base > len || len - base < OUTPUT_HEAD_WORDS * 32) return (Verdict.HbkError, o);
        o.value = _word(ret, base);
        uint256 scriptOffset = _word(ret, base + 32);
        if (scriptOffset > len - base || len - base - scriptOffset < 32) return (Verdict.HbkError, o);
        uint256 scriptPos = base + scriptOffset;
        o.scriptLength = _word(ret, scriptPos);
        if (o.scriptLength > len - scriptPos - 32) return (Verdict.HbkError, o);
        uint256 scriptLength = o.scriptLength;
        bytes32 scriptHash;
        bytes1 firstByte = 0x00;
        assembly ("memory-safe") {
            let start := add(add(ret, 64), scriptPos) // skip ret's length word and the script's length word
            scriptHash := keccak256(start, scriptLength)
            if gt(scriptLength, 0) { firstByte := and(mload(start), shl(248, 0xff)) }
        }
        o.scriptHash = scriptHash;
        o.firstByte = firstByte;
        o.isSpent = _word(ret, base + 5 * 32) != 0;
        o.fullScriptLength = _word(ret, base + 6 * 32);
        o.containsFullScript = _word(ret, base + 7 * 32) != 0;
        return (Verdict.Ok, o);
    }

    /// Calls hBK's getTxConfirmations; false on a revert, a short answer or a value wider than uint32.
    function _readConfirmations(
        bytes32 txid
    ) private view returns (bool, uint32) {
        (bool ok, bytes memory ret) = HBK.staticcall(abi.encodeCall(IHbkReader.getTxConfirmations, (txid)));
        if (!ok || ret.length < 32) return (false, 0);
        uint256 n = _word(ret, 0);
        if (n > type(uint32).max) return (false, 0);
        // Safe: checked against type(uint32).max just above.
        // forge-lint: disable-next-line(unsafe-typecast)
        return (true, uint32(n));
    }

    /// The 32-byte word at byte offset `pos` of `data`'s contents. Callers check `pos + 32 <= length`.
    function _word(
        bytes memory data,
        uint256 pos
    ) private pure returns (uint256 w) {
        assembly ("memory-safe") {
            w := mload(add(add(data, 32), pos))
        }
    }
}
