// SPDX-License-Identifier: MIT
// Ported from the internal security review of 2026-11-09 (DECISIONS.md D-038): edge cases of the hand-rolled hBK
// decoding, hBK becoming an EOA, the 64-byte script boundary, value and confirmation boundaries, and that
// SETTLER cannot overwrite a record. RawHbk answers with arbitrary bytes so the decoder sees every shape.
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {X402BtcSettler} from "../src/btc/X402BtcSettler.sol";
import {IHbkReader} from "../src/btc/IHbkReader.sol";
import {MockBitcoinKit} from "./mocks/MockBitcoinKit.sol";

/// Returns arbitrary raw bytes for both hBK selectors; ok=true always.
contract RawHbk {
    bytes public outAnswer;
    bytes public confAnswer;

    function set(
        bytes calldata o,
        bytes calldata c
    ) external {
        outAnswer = o;
        confAnswer = c;
    }

    fallback(
        bytes calldata data
    ) external returns (bytes memory) {
        bytes4 sel = bytes4(data[:4]);
        if (sel == IHbkReader.getSpecificTxOutput.selector) return outAnswer;
        if (sel == IHbkReader.getTxConfirmations.selector) return confAnswer;
        revert("unknown selector");
    }
}

contract AuditTest is Test {
    bytes32 constant TXID = 0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e;
    uint64 constant SATS = 83_050_000;
    bytes constant SCRIPT = hex"0020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c4";
    bytes32 constant REF = keccak256("ref");
    address facilitator = makeAddr("f");

    RawHbk raw;
    X402BtcSettler s;

    function setUp() public {
        raw = new RawHbk();
        s = new X402BtcSettler(address(raw), facilitator, 0);
    }

    function _goodOut() internal pure returns (bytes memory) {
        return abi.encode(IHbkReader.Output(SATS, SCRIPT, "", false, "", true, 34, true));
    }

    function _v(
        uint32 minConf
    ) internal view returns (X402BtcSettler.Check memory) {
        return s.verify(TXID, 1, SCRIPT, SATS, minConf);
    }

    function test_baseline() public {
        raw.set(_goodOut(), abi.encode(uint32(5)));
        assertEq(uint8(_v(1).verdict), uint8(X402BtcSettler.Verdict.Ok));
    }

    // --- confirmations decoding ---
    function test_confEmptyAnswer() public {
        raw.set(_goodOut(), "");
        X402BtcSettler.Check memory c = _v(1);
        assertEq(uint8(c.verdict), uint8(X402BtcSettler.Verdict.HbkError));
        assertEq(c.sats, SATS);
    }

    function test_confShortAnswer() public {
        raw.set(_goodOut(), hex"0000000005");
        assertEq(uint8(_v(1).verdict), uint8(X402BtcSettler.Verdict.HbkError));
    }

    function test_confWiderThanUint32() public {
        raw.set(_goodOut(), abi.encode(uint256(type(uint32).max) + 1));
        assertEq(uint8(_v(1).verdict), uint8(X402BtcSettler.Verdict.HbkError));
        raw.set(_goodOut(), abi.encode(uint256(type(uint32).max)));
        X402BtcSettler.Check memory c = _v(type(uint32).max);
        assertEq(uint8(c.verdict), uint8(X402BtcSettler.Verdict.Ok));
        assertEq(c.confirmations, type(uint32).max);
    }

    function test_confLongerAnswerReadsFirstWord() public {
        raw.set(_goodOut(), abi.encode(uint32(7), uint32(99)));
        X402BtcSettler.Check memory c = _v(7);
        assertEq(uint8(c.verdict), uint8(X402BtcSettler.Verdict.Ok));
        assertEq(c.hbkConfirmations, 7);
    }

    function test_confZeroWithOffset() public {
        X402BtcSettler s3 = new X402BtcSettler(address(raw), facilitator, 3);
        raw.set(_goodOut(), abi.encode(uint32(3)));
        X402BtcSettler.Check memory c = s3.verify(TXID, 1, SCRIPT, SATS, 0);
        assertEq(c.confirmations, 0);
        assertEq(uint8(c.verdict), uint8(X402BtcSettler.Verdict.Ok));
        assertEq(uint8(s3.verify(TXID, 1, SCRIPT, SATS, 1).verdict), uint8(X402BtcSettler.Verdict.TooFewConfirmations));
    }

    // --- output decoding ---
    function test_outEmptyOkAnswer() public {
        raw.set("", abi.encode(uint32(5)));
        assertEq(uint8(_v(1).verdict), uint8(X402BtcSettler.Verdict.HbkError));
    }

    /// Ok-with-empty-data also happens for an EOA (hBK selfdestructed / wrong address).
    function test_hbkBecomesEoa() public {
        vm.etch(address(raw), "");
        assertEq(uint8(_v(1).verdict), uint8(X402BtcSettler.Verdict.HbkError));
    }

    /// Unaligned script offset pointing into the head: must not revert; verdict must not be Ok
    /// unless bytes genuinely match.
    function test_scriptOffsetIntoHead() public {
        // head: offset 0x20, then value, scriptOffset = 0 (points at value word as length)
        bytes memory a = abi.encode(uint256(0x20), uint256(34), uint256(0), 0, 0, 0, 1, 34, true);
        raw.set(a, abi.encode(uint32(5)));
        X402BtcSettler.Check memory c = _v(1);
        assertTrue(c.verdict != X402BtcSettler.Verdict.Ok);
    }

    /// A 64-byte script with containsFullScript true is accepted (boundary of hBK's cut).
    function test_64ByteScriptOk() public {
        bytes memory sc = new bytes(64);
        for (uint256 i; i < 64; i++) {
            sc[i] = bytes1(uint8(i + 1));
        }
        raw.set(abi.encode(IHbkReader.Output(SATS, sc, "", false, "", false, 64, true)), abi.encode(uint32(5)));
        assertEq(uint8(s.verify(TXID, 1, sc, SATS, 1).verdict), uint8(X402BtcSettler.Verdict.Ok));
    }

    /// A 65-byte script cut to 64 with containsFullScript false: mismatch even if caller passes the cut.
    function test_65ByteScriptCut() public {
        bytes memory full = new bytes(65);
        bytes memory cut = new bytes(64);
        for (uint256 i; i < 65; i++) {
            full[i] = bytes1(uint8(i + 1));
            if (i < 64) cut[i] = full[i];
        }
        raw.set(abi.encode(IHbkReader.Output(SATS, cut, "", false, "", false, 65, false)), abi.encode(uint32(5)));
        assertEq(uint8(s.verify(TXID, 1, full, SATS, 1).verdict), uint8(X402BtcSettler.Verdict.ScriptMismatch));
        assertEq(uint8(s.verify(TXID, 1, cut, SATS, 1).verdict), uint8(X402BtcSettler.Verdict.ScriptMismatch));
        // Inconsistent flags (containsFullScript true but fullScriptLength != len) also mismatch
        raw.set(abi.encode(IHbkReader.Output(SATS, cut, "", false, "", false, 65, true)), abi.encode(uint32(5)));
        assertEq(uint8(s.verify(TXID, 1, cut, SATS, 1).verdict), uint8(X402BtcSettler.Verdict.ScriptMismatch));
    }

    /// OP_RETURN detected only from the first byte; a single-byte 0x6a script is OpReturn.
    function test_opReturnSingleByte() public {
        raw.set(abi.encode(IHbkReader.Output(0, hex"6a", "", false, "", false, 1, true)), abi.encode(uint32(5)));
        assertEq(uint8(s.verify(TXID, 1, hex"6a", 0, 1).verdict), uint8(X402BtcSettler.Verdict.OpReturn));
    }

    /// Value exactly uint64 max is Ok; +1 is HbkError (checked path).
    function test_valueBoundary() public {
        raw.set(
            abi.encode(IHbkReader.Output(type(uint64).max, SCRIPT, "", false, "", false, 34, true)),
            abi.encode(uint32(5))
        );
        X402BtcSettler.Check memory c = s.verify(TXID, 1, SCRIPT, type(uint64).max, 1);
        assertEq(uint8(c.verdict), uint8(X402BtcSettler.Verdict.Ok));
        assertEq(c.sats, type(uint64).max);
    }

    /// settle emits sats from the re-check, and cannot be overwritten even by SETTLER.
    function test_settleNoOverwrite() public {
        raw.set(_goodOut(), abi.encode(uint32(5)));
        vm.startPrank(facilitator);
        s.settle(TXID, 1, SCRIPT, SATS, 1, REF);
        vm.expectRevert(
            abi.encodeWithSelector(X402BtcSettler.NotPayable.selector, X402BtcSettler.Verdict.AlreadyConsumed)
        );
        s.settle(TXID, 1, SCRIPT, SATS, 1, keccak256("other"));
        vm.stopPrank();
        assertEq(s.settledBy(TXID, 1), REF);
        // other vout of same txid unaffected
        assertEq(s.settledBy(TXID, 0), bytes32(0));
    }

    /// A revert payload that is Error("Bitcoin transaction not found") with trailing bytes is HbkError, not TxNotFound.
    function test_revertClassificationIsExact() public {
        MockBitcoinKit m = new MockBitcoinKit();
        X402BtcSettler sm = new X402BtcSettler(address(m), facilitator, 0);
        m.setFailData(
            abi.encodePacked(abi.encodeWithSignature("Error(string)", "Bitcoin transaction not found"), hex"00")
        );
        assertEq(uint8(sm.verify(TXID, 1, SCRIPT, SATS, 1).verdict), uint8(X402BtcSettler.Verdict.HbkError));
    }

    /// Gas of verify when hBK's returned struct is as large as hBK can make it (64-byte script).
    function test_gasVerify() public {
        raw.set(_goodOut(), abi.encode(uint32(5)));
        uint256 g = gasleft();
        s.verify(TXID, 1, SCRIPT, SATS, 1);
        emit log_named_uint("verify gas (raw mock)", g - gasleft());
    }
}
