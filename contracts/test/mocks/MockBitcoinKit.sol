// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IHbkReader} from "../../src/btc/IHbkReader.sol";
import {IHbkTestnet} from "../../src/btc/HbkTestnetAdapter.sol";

/// @title MockBitcoinKit
/// @notice Stand-in for Hemi's Bitcoin Kit on forks and in unit tests, since forge and anvil cannot run
///         hVM's precompiles. It serves both ABIs: mainnet's (`getTxConfirmations`,
///         `getSpecificTxOutput`) and testnet's (`btcTxConfirmations`, `btcTxByTxid`). Tests write
///         transactions with `setTx` or `setPayment`; with `vm.etch` / `anvil_setCode` at the real
///         hBK address, a contract deployed against the real address talks to this mock.
/// @dev Reverts copy what the live contracts returned on 2026-11-09 (docs/phase2/contracts.md):
///      - unknown txid, getSpecificTxOutput: Error("Bitcoin transaction not found")
///      - unknown txid, getTxConfirmations / btcTxConfirmations:
///        Error("Static call to btcTxConfirmations precompile (0x43) contract failed")
///      - unknown txid, btcTxByTxid (testnet): Error("Transaction not found")
///      - output index at or past the parsed outputs: Panic(0x32). hBK parses at most 32 outputs, so
///        indexes from 32 up panic even when the transaction has more.
///      Mainnet's `Output` has no `spentDetail` (IHbkReader.Output); testnet's has one, returned zero.
///      The mock keeps its state in storage, so it works when etched over a contract with none.
contract MockBitcoinKit {
    struct TxRecord {
        bool exists;
        uint32 confirmations;
    }

    /// hBK's BitcoinHeader (BitcoinKitStructs.sol); only `height` is ever set here.
    struct BitcoinHeader {
        uint32 height;
        bytes32 blockHash;
        uint32 version;
        bytes32 previousBlockHash;
        bytes32 merkleRoot;
        uint32 timestamp;
        uint32 bits;
        uint32 nonce;
    }

    uint256 internal constant MAX_PARSED_OUTPUTS = 32; // hBK's maxOutputsExponent 5
    uint256 internal constant MAX_SCRIPT_BYTES = 64; // hBK's maxOutputScriptSizeExponent 2

    mapping(bytes32 txid => TxRecord) internal txs;
    mapping(bytes32 txid => IHbkReader.Output[]) internal outputs;

    /// When non-empty, every read reverts with exactly these bytes.
    bytes public failData;
    /// When non-empty, getSpecificTxOutput returns exactly these bytes (to test decoding).
    bytes public rawOutputAnswer;
    /// When true, the confirmation reads revert with a custom error after the output read succeeded.
    bool public failConfirmations;
    /// Height returned by getLastHeader / btcLastHeader (for check-btc-live.sh against a fork).
    uint32 public lastHeaderHeight;

    error MockHbkFailure();

    // ---------------------------------------------------------------- test controls

    /// Stores a transaction: its outputs, in order, and hBK's confirmation count for it.
    function setTx(
        bytes32 txid,
        IHbkReader.Output[] memory outs,
        uint32 confirmations
    ) public {
        delete outputs[txid];
        IHbkReader.Output[] storage s = outputs[txid];
        for (uint256 i = 0; i < outs.length; i++) {
            IHbkReader.Output storage o = s.push();
            o.outValue = outs[i].outValue;
            o.script = outs[i].script;
            o.outputAddress = outs[i].outputAddress;
            o.isOpReturn = outs[i].isOpReturn;
            o.opReturnData = outs[i].opReturnData;
            o.isSpent = outs[i].isSpent;
            o.fullScriptLength = outs[i].fullScriptLength;
            o.containsFullScript = outs[i].containsFullScript;
        }
        txs[txid] = TxRecord({exists: true, confirmations: confirmations});
    }

    /// Shortcut for scripts and e2e tests: a transaction whose output `vout` pays `sats` to `script`.
    /// Outputs before `vout` are zero-value OP_RETURNs. Replaces any transaction stored under `txid`.
    function setPayment(
        bytes32 txid,
        uint32 vout,
        uint256 sats,
        bytes memory script,
        uint32 confirmations
    ) external {
        IHbkReader.Output[] memory outs = new IHbkReader.Output[](uint256(vout) + 1);
        for (uint256 i = 0; i < vout; i++) {
            outs[i] = hbkOutput(0, hex"6a", false);
        }
        outs[vout] = hbkOutput(sats, script, false);
        setTx(txid, outs, confirmations);
    }

    /// Changes hBK's confirmation count for a stored transaction (as Bitcoin blocks arrive).
    function setConfirmations(
        bytes32 txid,
        uint32 confirmations
    ) external {
        require(txs[txid].exists, "MockBitcoinKit: unknown txid");
        txs[txid].confirmations = confirmations;
    }

    /// Marks an output spent or unspent.
    function setSpent(
        bytes32 txid,
        uint32 vout,
        bool spent
    ) external {
        outputs[txid][vout].isSpent = spent;
    }

    function clearTx(
        bytes32 txid
    ) external {
        delete outputs[txid];
        delete txs[txid];
    }

    function setFailData(
        bytes calldata data
    ) external {
        failData = data;
    }

    function setRawOutputAnswer(
        bytes calldata data
    ) external {
        rawOutputAnswer = data;
    }

    function setLastHeader(
        uint32 height
    ) external {
        lastHeaderHeight = height;
    }

    function setFailConfirmations(
        bool fail
    ) external {
        failConfirmations = fail;
    }

    /// An Output as hBK reports it: the script cut to 64 bytes, `containsFullScript` false if cut,
    /// no address, no OP_RETURN flags.
    function hbkOutput(
        uint256 sats,
        bytes memory script,
        bool isSpent
    ) public pure returns (IHbkReader.Output memory o) {
        o.outValue = sats;
        o.fullScriptLength = script.length;
        o.isSpent = isSpent;
        if (script.length > MAX_SCRIPT_BYTES) {
            bytes memory cut = new bytes(MAX_SCRIPT_BYTES);
            for (uint256 i = 0; i < MAX_SCRIPT_BYTES; i++) {
                cut[i] = script[i];
            }
            o.script = cut;
        } else {
            o.script = script;
            o.containsFullScript = true;
        }
    }

    // ---------------------------------------------------------------- mainnet ABI (IHbkReader)

    function getTxConfirmations(
        bytes32 txId
    ) external view returns (uint32) {
        _maybeFail();
        if (failConfirmations) revert MockHbkFailure();
        if (!txs[txId].exists) revert("Static call to btcTxConfirmations precompile (0x43) contract failed");
        return txs[txId].confirmations;
    }

    function getSpecificTxOutput(
        bytes32 txId,
        uint32 outputIndex
    ) external view returns (IHbkReader.Output memory) {
        _maybeFail();
        bytes memory raw = rawOutputAnswer;
        if (raw.length > 0) {
            assembly ("memory-safe") {
                return(add(raw, 32), mload(raw))
            }
        }
        if (!txs[txId].exists) revert("Bitcoin transaction not found");
        if (outputIndex >= MAX_PARSED_OUTPUTS) _panic(0x32);
        return outputs[txId][outputIndex]; // Panic(0x32) past the end
    }

    function getLastHeader() external view returns (BitcoinHeader memory h) {
        _maybeFail();
        h.height = lastHeaderHeight;
    }

    // ---------------------------------------------------------------- testnet ABI (btc*)

    function btcLastHeader() external view returns (BitcoinHeader memory h) {
        _maybeFail();
        h.height = lastHeaderHeight;
    }

    function btcTxConfirmations(
        bytes32 txId
    ) external view returns (uint32) {
        _maybeFail();
        if (failConfirmations) revert MockHbkFailure();
        if (!txs[txId].exists) revert("Static call to btcTxConfirmations precompile (0x43) contract failed");
        return txs[txId].confirmations;
    }

    function btcTxByTxid(
        bytes32 txId
    ) external view returns (IHbkTestnet.Transaction memory t) {
        _maybeFail();
        if (!txs[txId].exists) revert("Transaction not found");
        IHbkReader.Output[] storage s = outputs[txId];
        uint256 n = s.length < MAX_PARSED_OUTPUTS ? s.length : MAX_PARSED_OUTPUTS;
        t.outputs = new IHbkTestnet.Output[](n);
        for (uint256 i = 0; i < n; i++) {
            t.outputs[i].outValue = s[i].outValue;
            t.outputs[i].script = s[i].script;
            t.outputs[i].isSpent = s[i].isSpent;
            t.outputs[i].fullScriptLength = s[i].fullScriptLength;
            t.outputs[i].containsFullScript = s[i].containsFullScript;
        }
        t.totalOutputs = s.length;
        t.containsAllInputs = true;
        t.containsAllOutputs = n == s.length;
    }

    // ---------------------------------------------------------------- internals

    function _maybeFail() internal view {
        bytes memory data = failData;
        if (data.length > 0) {
            assembly ("memory-safe") {
                revert(add(data, 32), mload(data))
            }
        }
    }

    function _panic(
        uint256 code
    ) internal pure {
        assembly ("memory-safe") {
            mstore(0x00, shl(224, 0x4e487b71))
            mstore(0x04, code)
            revert(0x00, 0x24)
        }
    }
}
