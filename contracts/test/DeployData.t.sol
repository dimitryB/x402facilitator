// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {DeployHemi, HemiCanonical} from "../script/DeployHemi.s.sol";
import {x402ExactPermit2Proxy} from "../src/x402/x402ExactPermit2Proxy.sol";

/// @notice Offline checks of the committed deployment calldata. No RPC is needed.
contract DeployDataTest is Test {
    /// Standard runtime code of Arachnid's deterministic deployer (D-003).
    bytes constant DEPLOYER_RUNTIME =
        hex"7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffe03601600081602082378035828234f58015156039578182fd5b8082525050506014600cf3";

    DeployHemi internal script;

    function setUp() public {
        script = new DeployHemi();
        // The local test EVM may or may not carry the deployer; pin its standard code either way.
        vm.etch(HemiCanonical.CREATE2_DEPLOYER, DEPLOYER_RUNTIME);
        assertEq(HemiCanonical.CREATE2_DEPLOYER.codehash, HemiCanonical.CREATE2_DEPLOYER_CODEHASH);
    }

    /// Each file holds the expected salt and initcode, and CREATE2 maps them to the canonical address.
    function test_calldataFilesMatchCanonicalAddresses() public view {
        DeployHemi.Target[3] memory t = script.targets();
        for (uint256 i = 0; i < t.length; i++) {
            bytes memory data = script.loadCalldata(t[i]); // reverts on any mismatch
            assertGt(data.length, 32);
            assertEq(HemiCanonical.create2Address(t[i].salt, t[i].initCodeHash), t[i].expected);
        }
    }

    /// Replaying the committed calldata through the deployer reproduces, byte for byte, the runtime code
    /// already deployed elsewhere: Permit2 as on Hemi mainnet, the validator and proxy as on Ethereum/Base.
    function test_replayReproducesCanonicalRuntimeCode() public {
        DeployHemi.Target[3] memory t = script.targets();

        vm.chainId(HemiCanonical.HEMI_MAINNET);
        uint256 snap = vm.snapshotState();
        for (uint256 i = 0; i < t.length; i++) {
            _replay(t[i]);
        }
        assertEq(HemiCanonical.PERMIT2.codehash, HemiCanonical.PERMIT2_CODEHASH_MAINNET, "Permit2 (mainnet)");
        assertEq(HemiCanonical.VALIDATOR_6492.codehash, HemiCanonical.VALIDATOR_CODEHASH, "validator");
        assertEq(HemiCanonical.EXACT_PROXY.codehash, HemiCanonical.EXACT_PROXY_CODEHASH, "exact proxy");
        script.checkDeployed();

        // Permit2 bakes the chain id into its immutables; on testnet it yields the testnet hash.
        vm.revertToState(snap);
        vm.chainId(HemiCanonical.HEMI_TESTNET);
        for (uint256 i = 0; i < t.length; i++) {
            _replay(t[i]);
        }
        assertEq(HemiCanonical.PERMIT2.codehash, HemiCanonical.PERMIT2_CODEHASH_TESTNET, "Permit2 (testnet)");
        script.checkDeployed();
    }

    /// The vendored x402 source compiles (reference settings, no CBOR metadata) to exactly the deployed
    /// proxy runtime code minus its trailing CBOR metadata. This is the basis for a partial match on
    /// an explorer, and shows the vendored source is the code that runs.
    function test_vendoredProxySourceMatchesDeployedCodeModuloMetadata() public {
        vm.chainId(HemiCanonical.HEMI_TESTNET);
        _replay(script.targets()[2]);
        bytes memory deployed = HemiCanonical.EXACT_PROXY.code;

        // Solidity appends CBOR metadata followed by its 2-byte length (0x0033 = 51 bytes here).
        uint256 n = deployed.length;
        uint256 cborLen = (uint256(uint8(deployed[n - 2])) << 8) | uint256(uint8(deployed[n - 1]));
        assertEq(cborLen, 51, "unexpected CBOR length");
        // 0xa2 0x64 "ipfs" 0x58 0x22 <34-byte multihash> 0x64 "solc" 0x43 <3-byte version>
        assertEq(uint8(deployed[n - 2 - cborLen]), 0xa2, "CBOR map header");
        assertEq(uint8(deployed[n - 3]), 0x1c, "solc minor version 28");
        bytes memory deployedWithoutMetadata = _slice(deployed, 0, n - 2 - cborLen);

        x402ExactPermit2Proxy fresh = new x402ExactPermit2Proxy(HemiCanonical.PERMIT2);
        assertEq(address(fresh).code, deployedWithoutMetadata, "vendored source differs from deployed code");
        assertEq(address(fresh.PERMIT2()), HemiCanonical.PERMIT2);
    }

    function _replay(
        DeployHemi.Target memory t
    ) internal {
        (bool ok, bytes memory ret) = HemiCanonical.CREATE2_DEPLOYER.call(script.loadCalldata(t));
        assertTrue(ok, t.name);
        assertEq(address(bytes20(ret)), t.expected, t.name);
    }

    function _slice(
        bytes memory b,
        uint256 start,
        uint256 len
    ) internal pure returns (bytes memory out) {
        out = new bytes(len);
        for (uint256 i = 0; i < len; i++) {
            out[i] = b[start + i];
        }
    }
}
