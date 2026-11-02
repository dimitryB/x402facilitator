// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test, Vm} from "forge-std/Test.sol";
import {IERC20} from "forge-std/interfaces/IERC20.sol";
import {DeployHemi, HemiCanonical, IPermit2Domain} from "../script/DeployHemi.s.sol";
import {x402ExactPermit2Proxy} from "../src/x402/x402ExactPermit2Proxy.sol";
import {ISignatureTransfer} from "../src/x402/interfaces/ISignatureTransfer.sol";

/// @notice Runs DeployHemi against forks of the live Hemi chains at a pinned block, then settles a
///         Permit2 payment through the deployed x402 exact proxy.
/// @dev RPC and block can be overridden with HEMI_{TESTNET,MAINNET}_RPC_URL and
///      HEMI_{TESTNET,MAINNET}_FORK_BLOCK. With a pinned block, forge caches the fork state under
///      ~/.foundry/cache/rpc, so reruns need little or no RPC traffic.
abstract contract HemiForkBase is Test {
    // EIP-712 types exactly as an x402 client signs them for the exact scheme's Permit2 path
    // (PermitWitnessTransferFrom with witness `Witness witness`). Written out independently of the proxy's
    // WITNESS_TYPE_STRING so the test checks that the two agree.
    bytes32 internal constant PERMIT_WITNESS_TRANSFER_FROM_TYPEHASH = keccak256(
        "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,Witness witness)"
        "TokenPermissions(address token,uint256 amount)Witness(address to,uint256 validAfter)"
    );
    bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH = keccak256("TokenPermissions(address token,uint256 amount)");
    bytes32 internal constant WITNESS_TYPEHASH = keccak256("Witness(address to,uint256 validAfter)");

    // Permit2 custom errors (Uniswap/permit2 SignatureVerification and SignatureTransfer).
    bytes4 internal constant INVALID_SIGNER = bytes4(keccak256("InvalidSigner()"));
    bytes4 internal constant INVALID_NONCE = bytes4(keccak256("InvalidNonce()"));

    DeployHemi internal script;
    uint256 internal deployedInSetUp;

    function _rpcUrl() internal view virtual returns (string memory);
    function _forkBlock() internal view virtual returns (uint256);
    function _expectedChainId() internal pure virtual returns (uint256);
    function _expectedDomainSeparator() internal pure virtual returns (bytes32);
    /// Contracts DeployHemi has to deploy at the pinned block.
    function _expectedDeployCount() internal pure virtual returns (uint256);

    function setUp() public {
        vm.createSelectFork(_rpcUrl(), _forkBlock());
        assertEq(block.chainid, _expectedChainId());
        script = new DeployHemi();
        deployedInSetUp = script.deployAll(0);
    }

    // ---------------------------------------------------------------- deployment

    function test_deploysMissingContracts() public view {
        assertEq(deployedInSetUp, _expectedDeployCount(), "number of contracts deployed");
        assertGt(HemiCanonical.PERMIT2.code.length, 0, "Permit2 has no code");
        assertGt(HemiCanonical.VALIDATOR_6492.code.length, 0, "validator has no code");
        assertGt(HemiCanonical.EXACT_PROXY.code.length, 0, "proxy has no code");
    }

    function test_proxyPointsAtCanonicalPermit2() public view {
        assertEq(address(x402ExactPermit2Proxy(HemiCanonical.EXACT_PROXY).PERMIT2()), HemiCanonical.PERMIT2);
    }

    function test_permit2DomainSeparatorIsThisChains() public view {
        bytes32 ds = IPermit2Domain(HemiCanonical.PERMIT2).DOMAIN_SEPARATOR();
        assertEq(ds, _expectedDomainSeparator(), "hardcoded per-chain value");
        assertEq(ds, HemiCanonical.permit2DomainSeparator(block.chainid), "recomputed value");
    }

    function test_runtimeCodeIsCanonical() public view {
        assertEq(HemiCanonical.PERMIT2.codehash, HemiCanonical.permit2Codehash(block.chainid));
        assertEq(HemiCanonical.VALIDATOR_6492.codehash, HemiCanonical.VALIDATOR_CODEHASH);
        assertEq(HemiCanonical.EXACT_PROXY.codehash, HemiCanonical.EXACT_PROXY_CODEHASH);
    }

    function test_rerunIsNoop() public {
        bytes32 h0 = HemiCanonical.PERMIT2.codehash;
        bytes32 h1 = HemiCanonical.VALIDATOR_6492.codehash;
        bytes32 h2 = HemiCanonical.EXACT_PROXY.codehash;
        // The second run must not call the deployer at all.
        vm.expectCall(HemiCanonical.CREATE2_DEPLOYER, bytes(""), 0);
        assertEq(script.deployAll(0), 0, "second run deployed something");
        assertEq(HemiCanonical.PERMIT2.codehash, h0);
        assertEq(HemiCanonical.VALIDATOR_6492.codehash, h1);
        assertEq(HemiCanonical.EXACT_PROXY.codehash, h2);
    }

    // ---------------------------------------------------------------- settlement

    struct Parties {
        uint256 payerKey;
        address payer;
        address payTo;
        address facilitator;
    }

    /// The proxy's settle() moves the signed amount from the payer straight to the signed witness `to`.
    /// The facilitator (msg.sender) only pays gas: it cannot redirect the payment, cannot replay it, and
    /// neither it nor the proxy ever holds the tokens, even transiently (one Transfer event, payer -> to).
    function _settleThroughProxy(
        address token,
        uint256 balanceSlot,
        uint256 amount
    ) internal {
        Parties memory p;
        p.payerKey = uint256(keccak256("x402-hemi payer"));
        p.payer = vm.addr(p.payerKey);
        p.payTo = makeAddr("seller payTo");
        p.facilitator = makeAddr("facilitator");
        x402ExactPermit2Proxy proxy = x402ExactPermit2Proxy(HemiCanonical.EXACT_PROXY);
        IERC20 t = IERC20(token);

        // Fund the payer by writing its balanceOf mapping slot (D-013), then approve Permit2 once.
        vm.store(token, keccak256(abi.encode(p.payer, balanceSlot)), bytes32(amount * 10));
        assertEq(t.balanceOf(p.payer), amount * 10, "balance slot write did not land");
        vm.prank(p.payer);
        t.approve(HemiCanonical.PERMIT2, type(uint256).max);

        ISignatureTransfer.PermitTransferFrom memory permit = ISignatureTransfer.PermitTransferFrom({
            permitted: ISignatureTransfer.TokenPermissions({token: token, amount: amount}),
            nonce: uint256(keccak256("x402-hemi nonce")),
            deadline: block.timestamp + 1 hours
        });
        x402ExactPermit2Proxy.Witness memory witness =
            x402ExactPermit2Proxy.Witness({to: p.payTo, validAfter: block.timestamp - 10 minutes});
        bytes memory sig = _sign(p.payerKey, permit, witness);

        uint256 payerBefore = t.balanceOf(p.payer);
        uint256 payToBefore = t.balanceOf(p.payTo);
        uint256 facilitatorBefore = t.balanceOf(p.facilitator);
        assertEq(t.balanceOf(address(proxy)), 0, "proxy holds tokens before settle");

        // 1. The facilitator cannot point the payment at itself: the witness is part of the signature.
        x402ExactPermit2Proxy.Witness memory redirected =
            x402ExactPermit2Proxy.Witness({to: p.facilitator, validAfter: witness.validAfter});
        vm.prank(p.facilitator, p.facilitator);
        vm.expectRevert(INVALID_SIGNER);
        proxy.settle(permit, p.payer, redirected, sig);

        // 2. The honest settle.
        vm.recordLogs();
        vm.prank(p.facilitator, p.facilitator);
        proxy.settle(permit, p.payer, witness, sig);
        _assertSingleTransfer(vm.getRecordedLogs(), token, p.payer, p.payTo, amount);

        assertEq(t.balanceOf(p.payer), payerBefore - amount, "payer debited");
        assertEq(t.balanceOf(p.payTo), payToBefore + amount, "payTo credited");
        assertEq(t.balanceOf(p.facilitator), facilitatorBefore, "facilitator balance changed");
        assertEq(t.balanceOf(p.facilitator), 0, "facilitator holds tokens");
        assertEq(t.balanceOf(address(proxy)), 0, "proxy holds tokens");
        assertEq(t.allowance(p.payer, p.facilitator), 0, "facilitator got an allowance");
        assertEq(t.allowance(p.payer, address(proxy)), 0, "proxy got an allowance");

        // 3. The signature is single-use.
        vm.prank(p.facilitator, p.facilitator);
        vm.expectRevert(INVALID_NONCE);
        proxy.settle(permit, p.payer, witness, sig);
    }

    /// Exactly one ERC-20 Transfer in the whole settle tx: `from` -> `to`, for `amount`, by `token`.
    function _assertSingleTransfer(
        Vm.Log[] memory logs,
        address token,
        address from,
        address to,
        uint256 amount
    ) internal pure {
        bytes32 transferSig = keccak256("Transfer(address,address,uint256)");
        uint256 transfers;
        for (uint256 i = 0; i < logs.length; i++) {
            if (logs[i].topics.length == 3 && logs[i].topics[0] == transferSig) {
                transfers++;
                assertEq(logs[i].emitter, token, "Transfer from an unexpected contract");
                assertEq(address(uint160(uint256(logs[i].topics[1]))), from, "Transfer.from");
                assertEq(address(uint160(uint256(logs[i].topics[2]))), to, "Transfer.to");
                assertEq(abi.decode(logs[i].data, (uint256)), amount, "Transfer.value");
            }
        }
        assertEq(transfers, 1, "expected exactly one Transfer");
    }

    function _sign(
        uint256 key,
        ISignatureTransfer.PermitTransferFrom memory permit,
        x402ExactPermit2Proxy.Witness memory witness
    ) internal view returns (bytes memory) {
        bytes32 tokenPermissionsHash =
            keccak256(abi.encode(TOKEN_PERMISSIONS_TYPEHASH, permit.permitted.token, permit.permitted.amount));
        bytes32 witnessHash = keccak256(abi.encode(WITNESS_TYPEHASH, witness.to, witness.validAfter));
        bytes32 structHash = keccak256(
            abi.encode(
                PERMIT_WITNESS_TRANSFER_FROM_TYPEHASH,
                tokenPermissionsHash,
                HemiCanonical.EXACT_PROXY, // spender
                permit.nonce,
                permit.deadline,
                witnessHash
            )
        );
        bytes32 digest =
            keccak256(abi.encodePacked("\x19\x01", HemiCanonical.permit2DomainSeparator(block.chainid), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }
}

contract HemiTestnetForkTest is HemiForkBase {
    address constant USDC_E = 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443; // D-007, balance slot 0
    address constant HBTC = 0x36Ab5Dba83d5d470F670BC4c06d7Da685d9afAe7; // D-008, balance slot 0

    function _rpcUrl() internal view override returns (string memory) {
        return vm.envOr("HEMI_TESTNET_RPC_URL", string("https://testnet.rpc.hemi.network/rpc"));
    }

    function _forkBlock() internal view override returns (uint256) {
        return vm.envOr("HEMI_TESTNET_FORK_BLOCK", uint256(7_094_100));
    }

    function _expectedChainId() internal pure override returns (uint256) {
        return HemiCanonical.HEMI_TESTNET;
    }

    function _expectedDomainSeparator() internal pure override returns (bytes32) {
        return 0x323d993c5455dce711e33c078f319f1b26ea31ae677aa7d62a2b5cd11ba81c5f;
    }

    function _expectedDeployCount() internal pure override returns (uint256) {
        return 3; // nothing exists on testnet yet (D-004 to D-006)
    }

    function test_settle_USDCe() public {
        _settleThroughProxy(USDC_E, 0, 1000); // 0.001 USDC.e
    }

    function test_settle_hBTC() public {
        _settleThroughProxy(HBTC, 0, 1000); // 1000 sats
    }
}

contract HemiMainnetForkTest is HemiForkBase {
    address constant USDC_E = 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA; // D-007, balance slot 9
    address constant HEMI_BTC = 0xAA40c0c7644e0b2B224509571e10ad20d9C4ef28; // D-008, balance slot 0

    function _rpcUrl() internal view override returns (string memory) {
        return vm.envOr("HEMI_MAINNET_RPC_URL", string("https://rpc.hemi.network/rpc"));
    }

    function _forkBlock() internal view override returns (uint256) {
        return vm.envOr("HEMI_MAINNET_FORK_BLOCK", uint256(5_614_400));
    }

    function _expectedChainId() internal pure override returns (uint256) {
        return HemiCanonical.HEMI_MAINNET;
    }

    function _expectedDomainSeparator() internal pure override returns (bytes32) {
        return 0x1bfbbf0056b6ec1bbca73ea788b4a65c034128fd6543621be486785424550c8f; // D-004
    }

    function _expectedDeployCount() internal pure override returns (uint256) {
        return 2; // Permit2 already exists on mainnet (D-004)
    }

    function test_settle_hemiBTC() public {
        _settleThroughProxy(HEMI_BTC, 0, 1000); // 1000 sats
    }

    /// Mainnet USDC.e settles through EIP-3009 in production (D-001); this only shows the Permit2 path
    /// works for it too.
    function test_settle_USDCe_viaPermit2() public {
        _settleThroughProxy(USDC_E, 9, 1000);
    }
}
