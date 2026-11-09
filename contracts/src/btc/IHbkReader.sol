// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @title IHbkReader
/// @notice The two functions of Hemi's Bitcoin Kit (hBK) that X402BtcSettler reads. Mainnet hBK
///         `0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12` implements them directly; on Hemi testnet,
///         whose hBK has a `btc*` ABI, HbkTestnetAdapter implements them.
/// @dev Source: hemilabs/bitcoin-tunnel-contracts, IBitcoinKit.sol and BitcoinKitStructs.sol.
///
///      `Output` is BitcoinKitStructs.sol's `Output` without its last member, `SpentDetail spentDetail`.
///      The deployed mainnet hBK returns eight head words for `getSpecificTxOutput`, not ten: on
///      2026-11-09 the raw return for the fixture tx 95bca029…367e vout 1 was offset 0x20, then
///      outValue, script offset 0x100 (= 8 words), outputAddress offset, isOpReturn, opReturnData
///      offset, isSpent, fullScriptLength, containsFullScript, then the tails (docs/phase2/contracts.md).
///      Decoding it with the ten-member struct still succeeds, but `spentDetail` then reads the
///      script's length and bytes. X402BtcSettler does not depend on either layout: it reads the first
///      eight head words itself.
///
///      What hBK fills in (BitcoinKit.sol, parseTransactionOutputs): outValue, script (at most 64
///      bytes), isSpent, fullScriptLength, containsFullScript. It never sets outputAddress, isOpReturn
///      or opReturnData, and it parses at most the first 32 outputs of a transaction.
interface IHbkReader {
    struct Output {
        uint256 outValue; // in sats
        bytes script; // the output script, cut to 64 bytes
        string outputAddress; // always empty from hBK
        bool isOpReturn; // never set by hBK
        bytes opReturnData; // never set by hBK
        bool isSpent;
        uint256 fullScriptLength; // length of the script in the Bitcoin transaction
        bool containsFullScript; // false if `script` was cut
    }

    /// @notice Confirmations of a Bitcoin transaction, txid in display byte order. Counted against the
    ///         Bitcoin tip hBK's node knows, so the count equals Bitcoin's (measured 2026-11-09).
    /// @dev Reverts `Error("Static call to btcTxConfirmations precompile (0x43) contract failed")` for a
    ///      transaction hVM does not know (measured on mainnet; the source's "Bitcoin transaction not
    ///      found" branch is not what the node returns).
    function getTxConfirmations(
        bytes32 txId
    ) external view returns (uint32 confirmations);

    /// @notice Output `outputIndex` of a Bitcoin transaction, txid in display byte order.
    /// @dev Reverts `Error("Bitcoin transaction not found")` for an unknown transaction and
    ///      `Panic(0x32)` for an index at or past the number of parsed outputs (at most 32).
    function getSpecificTxOutput(
        bytes32 txId,
        uint32 outputIndex
    ) external view returns (Output memory);
}
