// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {HemiCanonical} from "../script/DeployHemi.s.sol";
import {DeployBtcSettler, BtcSettlerCanonical} from "../script/DeployBtcSettler.s.sol";
import {X402BtcSettler} from "../src/btc/X402BtcSettler.sol";
import {HbkTestnetAdapter} from "../src/btc/HbkTestnetAdapter.sol";
import {MockBitcoinKit} from "./mocks/MockBitcoinKit.sol";

/// @notice Runs DeployBtcSettler against forks of the live Hemi chains at the same pinned blocks as
///         DeployHemi.fork.t.sol, with MockBitcoinKit etched over the real hBK (forge cannot run hVM's
///         precompiles), then settles a Bitcoin payment through the deployed settler.
/// @dev RPC and block overrides: HEMI_{TESTNET,MAINNET}_RPC_URL and HEMI_{TESTNET,MAINNET}_FORK_BLOCK.
abstract contract BtcSettlerForkBase is Test {
    bytes32 internal constant TXID = 0x95bca0291cdecef1dc71c3ff174ed827f6b34ada52c6f32649e85449ce9d367e;
    uint32 internal constant VOUT = 1;
    uint64 internal constant SATS = 83_050_000;
    bytes internal constant SCRIPT = hex"0020ff64a4670b85c23ef392a5be0f0ff40d4024de223d4f7242d707714b44e012c4";
    bytes32 internal constant PAYMENT_REF = 0xa8faed6abbf35c12a4b26e40f6feb19d736d90045c83b9f9a31f638d323e6811;

    DeployBtcSettler internal script;
    MockBitcoinKit internal hbk;
    uint256 internal deployedInSetUp;

    function _rpcUrl() internal view virtual returns (string memory);
    function _forkBlock() internal view virtual returns (uint256);
    function _expectedChainId() internal pure virtual returns (uint256);
    function _realHbk() internal pure virtual returns (address);
    function _expectedSettlerAddress() internal pure virtual returns (address);
    function _expectedSigner() internal pure virtual returns (address);
    function _expectedDeployCount() internal pure virtual returns (uint256);

    function setUp() public {
        vm.createSelectFork(_rpcUrl(), _forkBlock());
        assertEq(block.chainid, _expectedChainId());
        assertGt(_realHbk().code.length, 0, "no hBK at the pinned block");
        // Replace the real hBK with the mock, keeping its address.
        vm.etch(_realHbk(), address(new MockBitcoinKit()).code);
        hbk = MockBitcoinKit(_realHbk());
        script = new DeployBtcSettler();
        deployedInSetUp = script.deployAll(0);
    }

    function _settler() internal pure returns (X402BtcSettler) {
        return X402BtcSettler(_expectedSettlerAddress());
    }

    function test_deploysAtPredictedAddress() public view {
        assertEq(deployedInSetUp, _expectedDeployCount(), "number of contracts deployed");
        X402BtcSettler s = _settler();
        assertGt(address(s).code.length, 0, "no code at the predicted settler address");
        assertEq(script.predicted(script.settlerTarget()), address(s), "CREATE2 address");
        assertEq(s.SETTLER(), _expectedSigner());
        assertEq(s.CONFIRMATION_OFFSET(), 0);
    }

    function test_rerunIsNoop() public {
        bytes32 h = _expectedSettlerAddress().codehash;
        vm.expectCall(HemiCanonical.CREATE2_DEPLOYER, bytes(""), 0);
        assertEq(script.deployAll(0), 0, "second run deployed something");
        assertEq(_expectedSettlerAddress().codehash, h);
    }

    function test_settleRoundTrip() public {
        X402BtcSettler s = _settler();
        hbk.setPayment(TXID, VOUT, SATS, SCRIPT, 1);

        X402BtcSettler.Check memory c = s.verify(TXID, VOUT, SCRIPT, SATS, 2);
        assertEq(uint8(c.verdict), uint8(X402BtcSettler.Verdict.TooFewConfirmations));
        hbk.setConfirmations(TXID, 2);
        c = s.verify(TXID, VOUT, SCRIPT, SATS, 2);
        assertEq(uint8(c.verdict), uint8(X402BtcSettler.Verdict.Ok));
        assertEq(c.sats, SATS);

        // Only the facilitator's signer may settle.
        vm.expectRevert(abi.encodeWithSelector(X402BtcSettler.NotSettler.selector, address(this)));
        s.settle(TXID, VOUT, SCRIPT, SATS, 2, PAYMENT_REF);

        vm.expectEmit(true, true, true, true, address(s));
        emit X402BtcSettler.Settled(TXID, VOUT, keccak256(SCRIPT), SATS, PAYMENT_REF, _expectedSigner());
        vm.prank(_expectedSigner());
        assertEq(s.settle(TXID, VOUT, SCRIPT, SATS, 2, PAYMENT_REF), SATS);
        assertEq(s.settledBy(TXID, VOUT), PAYMENT_REF);

        vm.prank(_expectedSigner());
        vm.expectRevert(
            abi.encodeWithSelector(X402BtcSettler.NotPayable.selector, X402BtcSettler.Verdict.AlreadyConsumed)
        );
        s.settle(TXID, VOUT, SCRIPT, SATS, 2, PAYMENT_REF);
        assertEq(address(s).balance, 0);
    }

    function test_unknownTxOnFork() public view {
        X402BtcSettler.Check memory c = _settler().verify(keccak256("unknown"), 0, SCRIPT, SATS, 1);
        assertEq(uint8(c.verdict), uint8(X402BtcSettler.Verdict.TxNotFound));
    }
}

contract BtcSettlerTestnetForkTest is BtcSettlerForkBase {
    function _rpcUrl() internal view override returns (string memory) {
        return vm.envOr("HEMI_TESTNET_RPC_URL", string("https://testnet.rpc.hemi.network/rpc"));
    }

    function _forkBlock() internal view override returns (uint256) {
        return vm.envOr("HEMI_TESTNET_FORK_BLOCK", uint256(7_094_100));
    }

    function _expectedChainId() internal pure override returns (uint256) {
        return HemiCanonical.HEMI_TESTNET;
    }

    function _realHbk() internal pure override returns (address) {
        return BtcSettlerCanonical.HBK_TESTNET;
    }

    function _expectedSettlerAddress() internal pure override returns (address) {
        return BtcSettlerCanonical.SETTLER_ADDRESS_TESTNET;
    }

    function _expectedSigner() internal pure override returns (address) {
        return BtcSettlerCanonical.SETTLER_TESTNET;
    }

    function _expectedDeployCount() internal pure override returns (uint256) {
        return 2; // the adapter, then the settler
    }

    function test_settlerReadsThroughAdapter() public view {
        HbkTestnetAdapter a = HbkTestnetAdapter(BtcSettlerCanonical.ADAPTER_ADDRESS_TESTNET);
        assertGt(address(a).code.length, 0, "no code at the predicted adapter address");
        assertEq(script.predicted(script.adapterTarget()), address(a), "adapter CREATE2 address");
        assertEq(a.HBK(), BtcSettlerCanonical.HBK_TESTNET);
        assertEq(_settler().HBK(), address(a));
    }
}

contract BtcSettlerMainnetForkTest is BtcSettlerForkBase {
    function _rpcUrl() internal view override returns (string memory) {
        return vm.envOr("HEMI_MAINNET_RPC_URL", string("https://rpc.hemi.network/rpc"));
    }

    function _forkBlock() internal view override returns (uint256) {
        return vm.envOr("HEMI_MAINNET_FORK_BLOCK", uint256(5_614_400));
    }

    function _expectedChainId() internal pure override returns (uint256) {
        return HemiCanonical.HEMI_MAINNET;
    }

    function _realHbk() internal pure override returns (address) {
        return BtcSettlerCanonical.HBK_MAINNET;
    }

    function _expectedSettlerAddress() internal pure override returns (address) {
        return BtcSettlerCanonical.SETTLER_ADDRESS_MAINNET;
    }

    function _expectedSigner() internal pure override returns (address) {
        return BtcSettlerCanonical.SETTLER_MAINNET;
    }

    function _expectedDeployCount() internal pure override returns (uint256) {
        return 1;
    }

    function test_settlerReadsHbkDirectly() public view {
        assertEq(_settler().HBK(), BtcSettlerCanonical.HBK_MAINNET);
    }
}
