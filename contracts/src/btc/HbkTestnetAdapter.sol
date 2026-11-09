// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IHbkReader} from "./IHbkReader.sol";

/// @notice The part of Hemi testnet's hBK (`0xeC9fa5daC1118963933e1A675a4EEA0009b7f215`) that the
///         adapter calls. That contract is an older Bitcoin Kit with `btc*` function names; it reverts
///         on mainnet's `getLastHeader`, `getTxConfirmations` and `getSpecificTxOutput`.
/// @dev ABI from hBK's demo `ContractABI.ts` (hemilabs), the testnet explorer being unreachable from the
///      network this was written on. Checked live on 2026-11-09 for `btcLastHeader` and
///      `btcTxConfirmations`; `btcTxByTxid` reverted "Transaction not found" for every transaction
///      that could be found (coinbases), so its return layout is unconfirmed (docs/phase2/contracts.md).
interface IHbkTestnet {
    struct SpentDetail {
        bytes32 spendingTxId;
        uint256 inputIndex;
    }

    struct Input {
        uint256 inValue;
        bytes32 inputTxId;
        uint256 sourceIndex;
        bytes scriptSig;
        uint256 sequence;
        uint256 fullScriptSigLength;
        bool containsFullScriptSig;
    }

    struct Output {
        uint256 outValue;
        bytes script;
        string outputAddress;
        bool isOpReturn;
        bytes opReturnData;
        bool isSpent;
        uint256 fullScriptLength;
        bool containsFullScript;
        SpentDetail spentDetail;
    }

    struct Transaction {
        bytes32 containingBlockHash;
        uint256 transactionVersion;
        uint256 size;
        uint256 vSize;
        uint256 lockTime;
        Input[] inputs;
        Output[] outputs;
        uint256 totalInputs;
        uint256 totalOutputs;
        bool containsAllInputs;
        bool containsAllOutputs;
    }

    function btcTxConfirmations(
        bytes32 txId
    ) external view returns (uint32 confirmations);

    function btcTxByTxid(
        bytes32 txId
    ) external view returns (Transaction memory);
}

/// @title HbkTestnetAdapter
/// @notice Implements IHbkReader over Hemi testnet's `btc*` hBK, so X402BtcSettler's bytecode is the
///         same on both networks. Stateless; no owner.
/// @dev Reverts are shaped like mainnet hBK's, because X402BtcSettler classifies them:
///      testnet's `Error("Transaction not found")` becomes `Error("Bitcoin transaction not found")`,
///      an output index past the parsed outputs panics with 0x32, and anything else is passed through.
contract HbkTestnetAdapter is IHbkReader {
    /// Hemi testnet's hBK.
    address public immutable HBK;

    error ZeroAddress();
    error NoCode(address account);

    bytes32 private constant TESTNET_NOT_FOUND_HASH =
        keccak256(abi.encodeWithSignature("Error(string)", "Transaction not found"));

    constructor(
        address hbk
    ) {
        if (hbk == address(0)) revert ZeroAddress();
        if (hbk.code.length == 0) revert NoCode(hbk);
        HBK = hbk;
    }

    /// @inheritdoc IHbkReader
    function getTxConfirmations(
        bytes32 txId
    ) external view returns (uint32) {
        return IHbkTestnet(HBK).btcTxConfirmations(txId);
    }

    /// @inheritdoc IHbkReader
    function getSpecificTxOutput(
        bytes32 txId,
        uint32 outputIndex
    ) external view returns (Output memory out) {
        try IHbkTestnet(HBK).btcTxByTxid(txId) returns (IHbkTestnet.Transaction memory t) {
            IHbkTestnet.Output memory o = t.outputs[outputIndex]; // Panic(0x32) past the end, as on mainnet
            out.outValue = o.outValue;
            out.script = o.script;
            out.outputAddress = o.outputAddress;
            out.isOpReturn = o.isOpReturn;
            out.opReturnData = o.opReturnData;
            out.isSpent = o.isSpent;
            out.fullScriptLength = o.fullScriptLength;
            out.containsFullScript = o.containsFullScript;
        } catch (bytes memory reason) {
            if (keccak256(reason) == TESTNET_NOT_FOUND_HASH) revert("Bitcoin transaction not found");
            assembly ("memory-safe") {
                revert(add(reason, 32), mload(reason))
            }
        }
    }
}
