// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, stdError} from "forge-std/Test.sol";
import {IHbkReader} from "../src/btc/IHbkReader.sol";
import {X402BtcSettler} from "../src/btc/X402BtcSettler.sol";
import {HbkTestnetAdapter} from "../src/btc/HbkTestnetAdapter.sol";
import {MockBitcoinKit} from "./mocks/MockBitcoinKit.sol";
import {DeployBtcSettler, BtcSettlerCanonical} from "../script/DeployBtcSettler.s.sol";

/// @notice Offline unit tests of X402BtcSettler and HbkTestnetAdapter against MockBitcoinKit.
/// @dev The fixture is a real Bitcoin mainnet output, read through mainnet hBK on 2026-11-09:
///      tx 95bca029…367e (block 975189), vout 1, 83050000 sats, P2WSH script 0x0020ff64…12c4,
///      already spent. check-btc-live.sh reads the same output from the live node.
contract X402BtcSettlerTest is Test {
    bytes32 internal constant TXID = 0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e;
    uint32 internal constant VOUT = 1;
    uint64 internal constant SATS = 83_050_000;
    bytes internal constant SCRIPT = hex"0020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c4";
    /// sha256 of the paymentId 00112233445566778899aabbccddeeff (the derivation vector's), written out:
    /// a sha256(...) constant would call the precompile at each use and consume vm.prank.
    bytes32 internal constant PAYMENT_REF = 0xa8faed6abbf35c12a4b26e40f6feb19d736d90045c83b9f9a31f638d323e6811;

    /// Raw eth_call answer of mainnet hBK getSpecificTxOutput(TXID, 1) on 2026-11-09 (14 words).
    /// Eight head words: no spentDetail, unlike BitcoinKitStructs.sol.
    bytes internal constant LIVE_ANSWER = abi.encodePacked(
        hex"0000000000000000000000000000000000000000000000000000000000000020",
        hex"0000000000000000000000000000000000000000000000000000000004f33e10",
        hex"0000000000000000000000000000000000000000000000000000000000000100",
        hex"0000000000000000000000000000000000000000000000000000000000000160",
        hex"0000000000000000000000000000000000000000000000000000000000000000",
        hex"0000000000000000000000000000000000000000000000000000000000000180",
        hex"0000000000000000000000000000000000000000000000000000000000000001",
        hex"0000000000000000000000000000000000000000000000000000000000000022",
        hex"0000000000000000000000000000000000000000000000000000000000000001",
        hex"0000000000000000000000000000000000000000000000000000000000000022",
        hex"0020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e0",
        hex"12c4000000000000000000000000000000000000000000000000000000000000",
        hex"0000000000000000000000000000000000000000000000000000000000000000",
        hex"0000000000000000000000000000000000000000000000000000000000000000"
    );

    MockBitcoinKit internal hbk;
    X402BtcSettler internal settler;
    address internal facilitator = makeAddr("facilitator");

    function setUp() public {
        hbk = new MockBitcoinKit();
        settler = new X402BtcSettler(address(hbk), facilitator, 0);
        _setFixture(10);
    }

    function _setFixture(
        uint32 confirmations
    ) internal {
        IHbkReader.Output[] memory outs = new IHbkReader.Output[](2);
        outs[0] =
            hbk.hbkOutput(461_648_009, hex"512068d343ef205a6afa4ae74508ab4aefb92dd46549e30d5eecf63acf3155c0798e", true);
        outs[1] = hbk.hbkOutput(SATS, SCRIPT, true);
        hbk.setTx(TXID, outs, confirmations);
    }

    function _verify(
        bytes memory script,
        uint64 minSats,
        uint32 minConf
    ) internal view returns (X402BtcSettler.Check memory) {
        return settler.verify(TXID, VOUT, script, minSats, minConf);
    }

    function _assertVerdict(
        X402BtcSettler.Check memory c,
        X402BtcSettler.Verdict v
    ) internal pure {
        assertEq(uint8(c.verdict), uint8(v), "verdict");
    }

    // ---------------------------------------------------------------- constructor and getters

    function test_getters() public view {
        assertEq(settler.HBK(), address(hbk));
        assertEq(settler.SETTLER(), facilitator);
        assertEq(settler.CONFIRMATION_OFFSET(), 0);
        assertEq(settler.settledBy(TXID, VOUT), bytes32(0));
    }

    function test_constructor_rejectsZeroAndCodelessAddresses() public {
        vm.expectRevert(X402BtcSettler.ZeroAddress.selector);
        new X402BtcSettler(address(0), facilitator, 0);
        vm.expectRevert(X402BtcSettler.ZeroAddress.selector);
        new X402BtcSettler(address(hbk), address(0), 0);
        address eoa = makeAddr("no code");
        vm.expectRevert(abi.encodeWithSelector(X402BtcSettler.NoCode.selector, eoa));
        new X402BtcSettler(eoa, facilitator, 0);
    }

    // ---------------------------------------------------------------- happy path

    function test_verify_ok() public view {
        X402BtcSettler.Check memory c = _verify(SCRIPT, SATS, 1);
        _assertVerdict(c, X402BtcSettler.Verdict.Ok);
        assertEq(c.sats, SATS);
        assertEq(c.hbkConfirmations, 10);
        assertEq(c.confirmations, 10);
        assertTrue(c.isSpent);
        assertEq(c.settledBy, bytes32(0));
    }

    function test_settle_recordsEmitsAndReturns() public {
        vm.expectEmit(true, true, true, true, address(settler));
        emit X402BtcSettler.Settled(TXID, VOUT, keccak256(SCRIPT), SATS, PAYMENT_REF, facilitator);
        vm.prank(facilitator);
        uint64 sats = settler.settle(TXID, VOUT, SCRIPT, SATS, 1, PAYMENT_REF);
        assertEq(sats, SATS, "return value");
        assertEq(settler.settledBy(TXID, VOUT), PAYMENT_REF, "settledBy");
        assertEq(settler.settledBy(TXID, 0), bytes32(0), "other vout untouched");

        X402BtcSettler.Check memory c = _verify(SCRIPT, SATS, 1);
        _assertVerdict(c, X402BtcSettler.Verdict.AlreadyConsumed);
        assertEq(c.settledBy, PAYMENT_REF);
    }

    function test_settle_twiceReverts() public {
        vm.startPrank(facilitator);
        settler.settle(TXID, VOUT, SCRIPT, SATS, 1, PAYMENT_REF);
        vm.expectRevert(
            abi.encodeWithSelector(X402BtcSettler.NotPayable.selector, X402BtcSettler.Verdict.AlreadyConsumed)
        );
        settler.settle(TXID, VOUT, SCRIPT, SATS, 1, PAYMENT_REF);
        // A different paymentRef for the same output is refused too.
        vm.expectRevert(
            abi.encodeWithSelector(X402BtcSettler.NotPayable.selector, X402BtcSettler.Verdict.AlreadyConsumed)
        );
        settler.settle(TXID, VOUT, SCRIPT, SATS, 1, keccak256("another payment"));
        vm.stopPrank();
        assertEq(settler.settledBy(TXID, VOUT), PAYMENT_REF, "first settlement kept");
    }

    function test_alreadyConsumed_skipsHbk() public {
        vm.prank(facilitator);
        settler.settle(TXID, VOUT, SCRIPT, SATS, 1, PAYMENT_REF);
        hbk.setFailData(hex"deadbeef"); // any hBK call would now revert
        _assertVerdict(_verify(SCRIPT, SATS, 1), X402BtcSettler.Verdict.AlreadyConsumed);
    }

    // ---------------------------------------------------------------- script

    function test_wrongScript() public view {
        bytes memory other = hex"0014bf98bd77f47d458b008d659e5d46eb558eab7663"; // a P2WPKH script
        _assertVerdict(_verify(other, SATS, 1), X402BtcSettler.Verdict.ScriptMismatch);
        bytes memory flipped = SCRIPT;
        flipped[33] = 0xc5;
        _assertVerdict(_verify(flipped, SATS, 1), X402BtcSettler.Verdict.ScriptMismatch);
        _assertVerdict(_verify("", SATS, 1), X402BtcSettler.Verdict.ScriptMismatch);
    }

    function test_scriptPrefixAndExtensionDoNotMatch() public view {
        bytes memory prefix = new bytes(SCRIPT.length - 1);
        for (uint256 i = 0; i < prefix.length; i++) {
            prefix[i] = SCRIPT[i];
        }
        _assertVerdict(_verify(prefix, SATS, 1), X402BtcSettler.Verdict.ScriptMismatch);
        _assertVerdict(_verify(abi.encodePacked(SCRIPT, hex"00"), SATS, 1), X402BtcSettler.Verdict.ScriptMismatch);
    }

    /// hBK cuts scripts to 64 bytes. A payment script that long cannot be matched, even by its prefix.
    function test_truncatedScript() public {
        bytes memory long = new bytes(80);
        for (uint256 i = 0; i < long.length; i++) {
            long[i] = bytes1(uint8(i + 1));
        }
        IHbkReader.Output[] memory outs = new IHbkReader.Output[](1);
        outs[0] = hbk.hbkOutput(SATS, long, false);
        assertFalse(outs[0].containsFullScript);
        assertEq(outs[0].script.length, 64);
        bytes32 txid = keccak256("long script tx");
        hbk.setTx(txid, outs, 5);
        _assertVerdict(settler.verify(txid, 0, long, SATS, 1), X402BtcSettler.Verdict.ScriptMismatch);
        _assertVerdict(settler.verify(txid, 0, outs[0].script, SATS, 1), X402BtcSettler.Verdict.ScriptMismatch);
    }

    function test_opReturn() public {
        bytes memory opReturn = hex"6a0b68656c6c6f20776f726c64";
        bytes32 txid = keccak256("op_return tx");
        hbk.setPayment(txid, 0, SATS, opReturn, 5);
        _assertVerdict(settler.verify(txid, 0, opReturn, SATS, 1), X402BtcSettler.Verdict.OpReturn);
        _assertVerdict(settler.verify(txid, 0, SCRIPT, SATS, 1), X402BtcSettler.Verdict.OpReturn);
    }

    // ---------------------------------------------------------------- amount

    function test_amount_exactIsOk_oneMoreIsBelow() public view {
        _assertVerdict(_verify(SCRIPT, SATS, 1), X402BtcSettler.Verdict.Ok);
        _assertVerdict(_verify(SCRIPT, SATS - 1, 1), X402BtcSettler.Verdict.Ok); // overpayment is accepted
        X402BtcSettler.Check memory c = _verify(SCRIPT, SATS + 1, 1);
        _assertVerdict(c, X402BtcSettler.Verdict.BelowAmount);
        assertEq(c.sats, SATS, "sats reported on BelowAmount");
    }

    function test_settle_belowAmountReverts() public {
        vm.prank(facilitator);
        vm.expectRevert(abi.encodeWithSelector(X402BtcSettler.NotPayable.selector, X402BtcSettler.Verdict.BelowAmount));
        settler.settle(TXID, VOUT, SCRIPT, SATS + 1, 1, PAYMENT_REF);
        assertEq(settler.settledBy(TXID, VOUT), bytes32(0));
    }

    // ---------------------------------------------------------------- confirmations

    function test_confirmations_boundary_offset0() public {
        _setFixture(3);
        _assertVerdict(_verify(SCRIPT, SATS, 3), X402BtcSettler.Verdict.Ok);
        X402BtcSettler.Check memory c = _verify(SCRIPT, SATS, 4);
        _assertVerdict(c, X402BtcSettler.Verdict.TooFewConfirmations);
        assertEq(c.hbkConfirmations, 3);
        assertEq(c.confirmations, 3);
    }

    function test_confirmations_boundary_offset1() public {
        X402BtcSettler s1 = new X402BtcSettler(address(hbk), facilitator, 1);
        _setFixture(3);
        X402BtcSettler.Check memory c = s1.verify(TXID, VOUT, SCRIPT, SATS, 2);
        _assertVerdict(c, X402BtcSettler.Verdict.Ok);
        assertEq(c.hbkConfirmations, 3);
        assertEq(c.confirmations, 2);
        _assertVerdict(s1.verify(TXID, VOUT, SCRIPT, SATS, 3), X402BtcSettler.Verdict.TooFewConfirmations);
    }

    function test_confirmations_belowOffsetFloorAtZero() public {
        X402BtcSettler s2 = new X402BtcSettler(address(hbk), facilitator, 2);
        _setFixture(1);
        X402BtcSettler.Check memory c = s2.verify(TXID, VOUT, SCRIPT, SATS, 1);
        _assertVerdict(c, X402BtcSettler.Verdict.TooFewConfirmations);
        assertEq(c.confirmations, 0);
        _assertVerdict(s2.verify(TXID, VOUT, SCRIPT, SATS, 0), X402BtcSettler.Verdict.Ok);
    }

    function test_settle_tooFewConfirmationsThenOk() public {
        _setFixture(1);
        vm.startPrank(facilitator);
        vm.expectRevert(
            abi.encodeWithSelector(X402BtcSettler.NotPayable.selector, X402BtcSettler.Verdict.TooFewConfirmations)
        );
        settler.settle(TXID, VOUT, SCRIPT, SATS, 2, PAYMENT_REF);
        hbk.setConfirmations(TXID, 2);
        settler.settle(TXID, VOUT, SCRIPT, SATS, 2, PAYMENT_REF);
        vm.stopPrank();
        assertEq(settler.settledBy(TXID, VOUT), PAYMENT_REF);
    }

    // ---------------------------------------------------------------- unknown tx, bad vout, hBK errors

    function test_unknownTxid() public view {
        X402BtcSettler.Check memory c = settler.verify(keccak256("unknown"), 0, SCRIPT, SATS, 1);
        _assertVerdict(c, X402BtcSettler.Verdict.TxNotFound);
        assertEq(c.sats, 0);
    }

    function test_txidInWrongByteOrderIsNotFound() public view {
        bytes32 reversed;
        for (uint256 i = 0; i < 32; i++) {
            reversed |= bytes32(uint256(uint8(TXID[i])) << (8 * i));
        }
        _assertVerdict(settler.verify(reversed, VOUT, SCRIPT, SATS, 1), X402BtcSettler.Verdict.TxNotFound);
    }

    function test_clearTx() public {
        hbk.clearTx(TXID);
        _assertVerdict(_verify(SCRIPT, SATS, 1), X402BtcSettler.Verdict.TxNotFound);
    }

    function test_voutOutOfRange() public view {
        _assertVerdict(settler.verify(TXID, 2, SCRIPT, SATS, 1), X402BtcSettler.Verdict.OutputNotFound);
        _assertVerdict(settler.verify(TXID, type(uint32).max, SCRIPT, SATS, 1), X402BtcSettler.Verdict.OutputNotFound);
    }

    /// hBK parses only the first 32 outputs, so output 32 panics even when it exists.
    function test_voutPast32IsNotFound() public {
        bytes32 txid = keccak256("wide tx");
        hbk.setPayment(txid, 32, SATS, SCRIPT, 5);
        _assertVerdict(settler.verify(txid, 32, SCRIPT, SATS, 1), X402BtcSettler.Verdict.OutputNotFound);
        hbk.setPayment(txid, 31, SATS, SCRIPT, 5);
        _assertVerdict(settler.verify(txid, 31, SCRIPT, SATS, 1), X402BtcSettler.Verdict.Ok);
    }

    function test_mockRevertsLikeHbk() public {
        vm.expectRevert(bytes("Bitcoin transaction not found"));
        hbk.getSpecificTxOutput(keccak256("unknown"), 0);
        vm.expectRevert(bytes("Static call to btcTxConfirmations precompile (0x43) contract failed"));
        hbk.getTxConfirmations(keccak256("unknown"));
        vm.expectRevert(stdError.indexOOBError);
        hbk.getSpecificTxOutput(TXID, 2);
    }

    function test_hbkRevertingIsHbkError() public {
        hbk.setFailData(
            abi.encodeWithSignature("Error(string)", "Static call to btcTxByTxid precompile (0x42) contract failed")
        );
        _assertVerdict(_verify(SCRIPT, SATS, 1), X402BtcSettler.Verdict.HbkError);
        hbk.setFailData(hex"");
        _assertVerdict(_verify(SCRIPT, SATS, 1), X402BtcSettler.Verdict.Ok);
    }

    function test_confirmationsRevertingIsHbkError() public {
        hbk.setFailConfirmations(true);
        X402BtcSettler.Check memory c = _verify(SCRIPT, SATS, 1);
        _assertVerdict(c, X402BtcSettler.Verdict.HbkError);
        assertEq(c.sats, SATS, "output fields kept");
        vm.prank(facilitator);
        vm.expectRevert(abi.encodeWithSelector(X402BtcSettler.NotPayable.selector, X402BtcSettler.Verdict.HbkError));
        settler.settle(TXID, VOUT, SCRIPT, SATS, 1, PAYMENT_REF);
    }

    // ---------------------------------------------------------------- isSpent

    function test_isSpentIsStillOk() public {
        hbk.setSpent(TXID, VOUT, true);
        X402BtcSettler.Check memory c = _verify(SCRIPT, SATS, 1);
        _assertVerdict(c, X402BtcSettler.Verdict.Ok);
        assertTrue(c.isSpent);
        hbk.setSpent(TXID, VOUT, false);
        c = _verify(SCRIPT, SATS, 1);
        _assertVerdict(c, X402BtcSettler.Verdict.Ok);
        assertFalse(c.isSpent);
    }

    // ---------------------------------------------------------------- access and funds

    function test_settle_zeroPaymentRefReverts() public {
        vm.prank(facilitator);
        vm.expectRevert(X402BtcSettler.ZeroPaymentRef.selector);
        settler.settle(TXID, VOUT, SCRIPT, SATS, 1, bytes32(0));
    }

    function test_settle_nonSettlerReverts() public {
        address griefer = makeAddr("griefer");
        vm.prank(griefer);
        vm.expectRevert(abi.encodeWithSelector(X402BtcSettler.NotSettler.selector, griefer));
        settler.settle(TXID, VOUT, SCRIPT, SATS, 1, PAYMENT_REF);
        assertEq(settler.settledBy(TXID, VOUT), bytes32(0));
    }

    function test_ethSendReverts() public {
        vm.deal(address(this), 1 ether);
        (bool ok,) = address(settler).call{value: 1}("");
        assertFalse(ok, "plain ETH transfer accepted");
        (ok,) = address(settler).call{value: 1}(hex"12345678");
        assertFalse(ok, "ETH with unknown calldata accepted");
        vm.prank(facilitator);
        vm.deal(facilitator, 1 ether);
        (ok,) = address(settler).call{value: 1}(
            abi.encodeCall(X402BtcSettler.settle, (TXID, VOUT, SCRIPT, SATS, 1, PAYMENT_REF))
        );
        assertFalse(ok, "settle accepted ETH");
        assertEq(address(settler).balance, 0);
    }

    // ---------------------------------------------------------------- decoding hBK's answer

    /// The exact bytes mainnet hBK returned for the fixture decode to the fixture.
    function test_liveMainnetAnswerDecodes() public {
        hbk.setRawOutputAnswer(LIVE_ANSWER);
        X402BtcSettler.Check memory c = _verify(SCRIPT, SATS, 1);
        _assertVerdict(c, X402BtcSettler.Verdict.Ok);
        assertEq(c.sats, SATS);
        assertTrue(c.isSpent);
    }

    /// BitcoinKitStructs.sol's layout (with a trailing SpentDetail) decodes the same way.
    function test_sourceLayoutWithSpentDetailDecodes() public {
        hbk.setRawOutputAnswer(
            abi.encode(
                uint256(0x20),
                SATS,
                uint256(0x140), // script offset: 10 head words
                uint256(0x1a0), // outputAddress offset
                false,
                uint256(0x1c0), // opReturnData offset
                true,
                SCRIPT.length,
                true,
                bytes32(0),
                uint256(0)
            )
        );
        // abi.encode above gives the head only; append the tails by hand.
        bytes memory answer = abi.encodePacked(
            hbk.rawOutputAnswer(), uint256(SCRIPT.length), SCRIPT, new bytes(30), uint256(0), uint256(0)
        );
        // Word 0 is the tuple offset; the tuple head is 10 words, then the script, outputAddress and
        // opReturnData tails.
        hbk.setRawOutputAnswer(answer);
        X402BtcSettler.Check memory c = _verify(SCRIPT, SATS, 1);
        _assertVerdict(c, X402BtcSettler.Verdict.Ok);
        assertEq(c.sats, SATS);
    }

    function test_malformedAnswersAreHbkError() public {
        bytes[] memory answers = new bytes[](6);
        answers[0] = hex"01"; // shorter than a word
        answers[1] = abi.encode(uint256(0x20)); // offset only
        answers[2] = abi.encode(type(uint256).max, uint256(0)); // offset past the end
        // Head fine, script offset past the end.
        answers[3] = abi.encode(uint256(0x20), SATS, uint256(0xffff), 0, 0, 0, 0, 0, 0);
        // Script length past the end.
        answers[4] = abi.encode(uint256(0x20), SATS, uint256(0x100), 0, 0, 0, 0, 0, uint256(1000));
        // More sats than fit in uint64.
        answers[5] = abi.encodePacked(
            abi.encode(uint256(0x20), uint256(type(uint64).max) + 1, uint256(0x100), 0, 0, 0, 0, 34, true),
            abi.encode(uint256(34)),
            SCRIPT,
            new bytes(30)
        );
        for (uint256 i = 0; i < answers.length; i++) {
            hbk.setRawOutputAnswer(answers[i]);
            _assertVerdict(_verify(SCRIPT, SATS, 1), X402BtcSettler.Verdict.HbkError);
        }
    }

    // ---------------------------------------------------------------- fuzz: verify never reverts

    function testFuzz_verifyNeverReverts(
        bytes32 txid,
        uint32 vout,
        bytes calldata script,
        uint64 minSats,
        uint32 minConf
    ) public view {
        // Half the runs hit the stored transaction.
        if (uint256(txid) % 2 == 0) txid = TXID;
        settler.verify(txid, vout, script, minSats, minConf);
    }

    function testFuzz_verifyNeverReverts_rawAnswer(
        bytes calldata raw,
        uint64 minSats
    ) public {
        hbk.setRawOutputAnswer(raw);
        settler.verify(TXID, VOUT, SCRIPT, minSats, 1);
    }

    function testFuzz_verifyNeverReverts_revertData(
        bytes calldata data
    ) public {
        vm.assume(data.length > 0);
        hbk.setFailData(data);
        X402BtcSettler.Check memory c = _verify(SCRIPT, SATS, 1);
        assertTrue(
            c.verdict == X402BtcSettler.Verdict.TxNotFound || c.verdict == X402BtcSettler.Verdict.OutputNotFound
                || c.verdict == X402BtcSettler.Verdict.HbkError
        );
    }

    // ---------------------------------------------------------------- testnet adapter

    function test_adapter_overBtcAbi() public {
        HbkTestnetAdapter adapter = new HbkTestnetAdapter(address(hbk));
        X402BtcSettler s = new X402BtcSettler(address(adapter), facilitator, 0);
        assertEq(adapter.HBK(), address(hbk));

        IHbkReader.Output memory o = adapter.getSpecificTxOutput(TXID, VOUT);
        assertEq(o.outValue, SATS);
        assertEq(o.script, SCRIPT);
        assertTrue(o.isSpent);
        assertTrue(o.containsFullScript);
        assertEq(o.fullScriptLength, SCRIPT.length);
        assertEq(adapter.getTxConfirmations(TXID), 10);

        X402BtcSettler.Check memory c = s.verify(TXID, VOUT, SCRIPT, SATS, 1);
        _assertVerdict(c, X402BtcSettler.Verdict.Ok);
        assertEq(c.sats, SATS);
        assertEq(c.hbkConfirmations, 10);

        // Testnet's "Transaction not found" is reshaped to mainnet's revert, and a bad vout still panics.
        _assertVerdict(s.verify(keccak256("unknown"), 0, SCRIPT, SATS, 1), X402BtcSettler.Verdict.TxNotFound);
        _assertVerdict(s.verify(TXID, 2, SCRIPT, SATS, 1), X402BtcSettler.Verdict.OutputNotFound);
        _assertVerdict(s.verify(TXID, VOUT, SCRIPT, SATS + 1, 1), X402BtcSettler.Verdict.BelowAmount);
        _assertVerdict(s.verify(TXID, VOUT, SCRIPT, SATS, 11), X402BtcSettler.Verdict.TooFewConfirmations);

        vm.prank(facilitator);
        assertEq(s.settle(TXID, VOUT, SCRIPT, SATS, 1, PAYMENT_REF), SATS);
        assertEq(s.settledBy(TXID, VOUT), PAYMENT_REF);

        // Other failures pass through and become HbkError.
        hbk.setFailData(abi.encodeWithSignature("Error(string)", "something else"));
        _assertVerdict(s.verify(TXID, 0, SCRIPT, SATS, 1), X402BtcSettler.Verdict.HbkError);
    }

    function test_adapter_constructorChecks() public {
        vm.expectRevert(HbkTestnetAdapter.ZeroAddress.selector);
        new HbkTestnetAdapter(address(0));
        address eoa = makeAddr("no code");
        vm.expectRevert(abi.encodeWithSelector(HbkTestnetAdapter.NoCode.selector, eoa));
        new HbkTestnetAdapter(eoa);
    }
}

/// @notice Offline checks of the deployment constants: the compiled code lands at the addresses in
///         DeployBtcSettler.s.sol, and shared/hemi.json lists the same addresses and offsets.
contract DeployBtcSettlerOfflineTest is Test {
    DeployBtcSettler internal script;
    string internal json;

    function setUp() public {
        script = new DeployBtcSettler();
        json = vm.readFile("../shared/hemi.json");
    }

    function test_mainnetConstants() public {
        vm.chainId(43_111);
        DeployBtcSettler.Target memory t = script.settlerTarget();
        assertEq(script.predicted(t), BtcSettlerCanonical.SETTLER_ADDRESS_MAINNET, "predicted settler address");
        script.checkTarget(t);
        (address hbk, address settler, uint32 offset) = script.settlerArgs();
        assertEq(hbk, 0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12);
        assertEq(settler, 0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875);
        assertEq(offset, 0);
        assertEq(script.targets().length, 1);

        string memory n = ".networks.['eip155:43111']";
        assertEq(vm.parseJsonAddress(json, string.concat(n, ".contracts.hbk")), hbk, "hemi.json hbk");
        assertEq(
            vm.parseJsonAddress(json, string.concat(n, ".contracts.x402BtcSettler")),
            BtcSettlerCanonical.SETTLER_ADDRESS_MAINNET,
            "hemi.json x402BtcSettler"
        );
        assertEq(vm.parseJsonUint(json, string.concat(n, ".btcConfirmationOffset")), offset, "hemi.json offset");
    }

    function test_testnetConstants() public {
        vm.chainId(743_111);
        DeployBtcSettler.Target memory a = script.adapterTarget();
        DeployBtcSettler.Target memory s = script.settlerTarget();
        assertEq(script.predicted(a), BtcSettlerCanonical.ADAPTER_ADDRESS_TESTNET, "predicted adapter address");
        assertEq(script.predicted(s), BtcSettlerCanonical.SETTLER_ADDRESS_TESTNET, "predicted settler address");
        (address hbk, address settler, uint32 offset) = script.settlerArgs();
        assertEq(hbk, BtcSettlerCanonical.ADAPTER_ADDRESS_TESTNET, "testnet settler reads through the adapter");
        assertEq(settler, 0xD2B2fc8093f8A734c42B90762FD2B2F8464631af);
        assertEq(offset, 0);
        assertEq(script.targets().length, 2);

        string memory n = ".networks.['eip155:743111']";
        assertEq(vm.parseJsonAddress(json, string.concat(n, ".contracts.hbk")), BtcSettlerCanonical.HBK_TESTNET, "hbk");
        assertEq(
            vm.parseJsonAddress(json, string.concat(n, ".contracts.hbkTestnetAdapter")),
            BtcSettlerCanonical.ADAPTER_ADDRESS_TESTNET,
            "hemi.json hbkTestnetAdapter"
        );
        assertEq(
            vm.parseJsonAddress(json, string.concat(n, ".contracts.x402BtcSettler")),
            BtcSettlerCanonical.SETTLER_ADDRESS_TESTNET,
            "hemi.json x402BtcSettler"
        );
        assertEq(vm.parseJsonUint(json, string.concat(n, ".btcConfirmationOffset")), offset, "hemi.json offset");
    }

    function test_otherChainsRefused() public {
        vm.chainId(1);
        vm.expectRevert(bytes("DeployBtcSettler: chain id is neither 43111 nor 743111"));
        script.settlerArgs();
    }
}
