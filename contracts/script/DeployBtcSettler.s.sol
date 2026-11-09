// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";
import {HemiCanonical} from "./DeployHemi.s.sol";
import {X402BtcSettler} from "../src/btc/X402BtcSettler.sol";
import {HbkTestnetAdapter} from "../src/btc/HbkTestnetAdapter.sol";

/// @notice Deployment facts for X402BtcSettler (phase 2, docs/phase2/contracts.md).
library BtcSettlerCanonical {
    /// Hemi's Bitcoin Kit. Mainnet's implements IHbkReader; testnet's has the older `btc*` ABI.
    address internal constant HBK_MAINNET = 0x7007dd1C09527B92AEcd8Ae6570B73d09E0B8F12;
    address internal constant HBK_TESTNET = 0xeC9fa5daC1118963933e1A675a4EEA0009b7f215;

    /// The facilitator's Hemi signers: the only addresses allowed to call `settle`.
    address internal constant SETTLER_MAINNET = 0x1155C33c3Ef5d0dEE61C98d21f2e22c053a60875;
    address internal constant SETTLER_TESTNET = 0xD2B2fc8093f8A734c42B90762FD2B2F8464631af;

    /// hBK's confirmation count minus Bitcoin's. Measured 0 on mainnet on 2026-11-09 against
    /// BlockCypher's tip (check-btc-live.sh). Testnet runs the same hVM; its offset could not be
    /// measured against a testnet3 explorer from here and is taken to be the same.
    uint32 internal constant CONFIRMATION_OFFSET_MAINNET = 0;
    uint32 internal constant CONFIRMATION_OFFSET_TESTNET = 0;

    bytes32 internal constant SETTLER_SALT = "x402 btc settler v1";
    bytes32 internal constant ADAPTER_SALT = "x402 hbk testnet adapter v1";

    /// CREATE2 addresses for the code in src/btc built with foundry.toml's default profile (no
    /// metadata, so the bytecode does not depend on the build machine). The constructor arguments
    /// differ per network, so the settler's address does too. A change to the source, the compiler
    /// settings or the arguments moves these; the script and the tests then refuse until they are
    /// updated here, in shared/hemi.json and in docs/phase2/contracts.md.
    address internal constant SETTLER_ADDRESS_MAINNET = 0x9Df0B4752D00dF65Fb4f7FfdFe0545543f08ab9f;
    address internal constant SETTLER_ADDRESS_TESTNET = 0x56AdDfcC77b087D9101ddEE8D3A38e95E0A365B0;
    address internal constant ADAPTER_ADDRESS_TESTNET = 0x1D561c41067aB82Ab90be4dd385E4a704CC3D8F5;
}

/// @title DeployBtcSettler
/// @notice Idempotent CREATE2 deployment of X402BtcSettler on Hemi mainnet (43111), and of
///         HbkTestnetAdapter followed by X402BtcSettler on Hemi testnet (743111), through the
///         deterministic deployer. A contract whose address already has code is skipped.
/// @dev Same conventions as DeployHemi.s.sol: signer from HEMI_DEPLOY_PRIVATE_KEY (set by
///      deploy-btc.sh) or forge's own sender; broadcasting on mainnet requires
///      CONFIRM_MAINNET_DEPLOY=yes, checked here as well as in deploy-btc.sh.
///
///      Unlike DeployHemi, the initcode is compiled here (type(...).creationCode), because these are
///      new contracts with no earlier deployment to replay. Each address is checked against the
///      constant in BtcSettlerCanonical before anything is sent.
contract DeployBtcSettler is Script {
    struct Target {
        string name;
        address expected;
        bytes32 salt;
        bytes initCode;
    }

    /// Constructor arguments of X402BtcSettler on this chain.
    function settlerArgs() public view returns (address hbk, address settler, uint32 confirmationOffset) {
        if (block.chainid == HemiCanonical.HEMI_MAINNET) {
            return (
                BtcSettlerCanonical.HBK_MAINNET,
                BtcSettlerCanonical.SETTLER_MAINNET,
                BtcSettlerCanonical.CONFIRMATION_OFFSET_MAINNET
            );
        }
        if (block.chainid == HemiCanonical.HEMI_TESTNET) {
            return (
                adapterTarget().expected,
                BtcSettlerCanonical.SETTLER_TESTNET,
                BtcSettlerCanonical.CONFIRMATION_OFFSET_TESTNET
            );
        }
        revert("DeployBtcSettler: chain id is neither 43111 nor 743111");
    }

    /// The real hBK on this chain (what the settler reads, directly or through the adapter).
    function realHbk() public view returns (address) {
        if (block.chainid == HemiCanonical.HEMI_MAINNET) return BtcSettlerCanonical.HBK_MAINNET;
        if (block.chainid == HemiCanonical.HEMI_TESTNET) return BtcSettlerCanonical.HBK_TESTNET;
        revert("DeployBtcSettler: chain id is neither 43111 nor 743111");
    }

    function adapterTarget() public pure returns (Target memory t) {
        t.name = "HbkTestnetAdapter";
        t.expected = BtcSettlerCanonical.ADAPTER_ADDRESS_TESTNET;
        t.salt = BtcSettlerCanonical.ADAPTER_SALT;
        t.initCode = abi.encodePacked(type(HbkTestnetAdapter).creationCode, abi.encode(BtcSettlerCanonical.HBK_TESTNET));
    }

    function settlerTarget() public view returns (Target memory t) {
        (address hbk, address settler, uint32 offset) = settlerArgs();
        t.name = "X402BtcSettler";
        t.expected = block.chainid == HemiCanonical.HEMI_MAINNET
            ? BtcSettlerCanonical.SETTLER_ADDRESS_MAINNET
            : BtcSettlerCanonical.SETTLER_ADDRESS_TESTNET;
        t.salt = BtcSettlerCanonical.SETTLER_SALT;
        t.initCode = abi.encodePacked(type(X402BtcSettler).creationCode, abi.encode(hbk, settler, offset));
    }

    /// The deployments on this chain, in order: the adapter (testnet only), then the settler.
    function targets() public view returns (Target[] memory t) {
        if (block.chainid == HemiCanonical.HEMI_TESTNET) {
            t = new Target[](2);
            t[0] = adapterTarget();
            t[1] = settlerTarget();
        } else {
            t = new Target[](1);
            t[0] = settlerTarget();
        }
    }

    /// CREATE2 address of `t` through the deterministic deployer.
    function predicted(
        Target memory t
    ) public pure returns (address) {
        return HemiCanonical.create2Address(t.salt, keccak256(t.initCode));
    }

    /// The deployer calldata for `t`: `<salt><initcode>`.
    function deployerCalldata(
        Target memory t
    ) public pure returns (bytes memory) {
        return abi.encodePacked(t.salt, t.initCode);
    }

    function run() external {
        uint256 key = vm.envOr("HEMI_DEPLOY_PRIVATE_KEY", uint256(0));
        bool broadcasting =
            vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        if (block.chainid == HemiCanonical.HEMI_MAINNET && broadcasting) {
            require(
                keccak256(bytes(vm.envOr("CONFIRM_MAINNET_DEPLOY", string("")))) == keccak256("yes"),
                "DeployBtcSettler: broadcasting to Hemi mainnet needs CONFIRM_MAINNET_DEPLOY=yes"
            );
        }
        console2.log("mode:", broadcasting ? "BROADCAST" : "simulation (no transactions are sent)");
        if (key != 0) {
            console2.log("signer (HEMI_DEPLOY_PRIVATE_KEY):", vm.addr(key));
            console2.log("signer balance (wei):", vm.addr(key).balance);
        } else {
            console2.log("signer: forge --sender/wallet, or forge's default sender in a simulation");
        }
        deployAll(key);
    }

    /// For deploy-btc.sh: one line per target, `PLAN <name> <address> <has code: 0|1> <deployer calldata>`.
    /// Read-only.
    function plan() external view {
        checkChain();
        Target[] memory t = targets();
        for (uint256 i = 0; i < t.length; i++) {
            checkTarget(t[i]);
            console2.log(
                string.concat(
                    "PLAN ",
                    t[i].name,
                    " ",
                    vm.toString(t[i].expected),
                    " ",
                    t[i].expected.code.length > 0 ? "1" : "0",
                    " ",
                    vm.toString(deployerCalldata(t[i]))
                )
            );
        }
    }

    /// @notice Deploys every missing contract, then checks them. Returns how many were deployed.
    /// @param key Private key to broadcast with, or 0 for forge's configured sender.
    function deployAll(
        uint256 key
    ) public returns (uint256 deployed) {
        checkChain();
        (address hbk, address settler, uint32 offset) = settlerArgs();
        console2.log("X402BtcSettler HBK:", hbk);
        console2.log("X402BtcSettler SETTLER:", settler);
        console2.log("X402BtcSettler CONFIRMATION_OFFSET:", offset);
        Target[] memory t = targets();
        for (uint256 i = 0; i < t.length; i++) {
            checkTarget(t[i]);
            if (t[i].expected.code.length > 0) {
                console2.log(string.concat("[skip]   ", t[i].name, ": code already at"), t[i].expected);
                continue;
            }
            console2.log(string.concat("[deploy] ", t[i].name, " ->"), t[i].expected);
            if (key != 0) vm.startBroadcast(key);
            else vm.startBroadcast();
            (bool ok, bytes memory ret) = HemiCanonical.CREATE2_DEPLOYER.call(deployerCalldata(t[i]));
            vm.stopBroadcast();
            require(ok, string.concat("DeployBtcSettler: deployer call reverted for ", t[i].name));
            require(
                ret.length == 20 && address(bytes20(ret)) == t[i].expected,
                string.concat("DeployBtcSettler: deployer returned an unexpected address for ", t[i].name)
            );
            require(
                t[i].expected.code.length > 0, string.concat("DeployBtcSettler: no code after deploying ", t[i].name)
            );
            deployed++;
        }
        checkDeployed();
        console2.log("contracts deployed in this run:", deployed);
    }

    /// @notice Reverts unless this is a Hemi chain with the deterministic deployer and hBK in place.
    function checkChain() public view {
        require(HemiCanonical.isHemi(block.chainid), "DeployBtcSettler: chain id is neither 43111 nor 743111");
        require(
            HemiCanonical.CREATE2_DEPLOYER.codehash == HemiCanonical.CREATE2_DEPLOYER_CODEHASH,
            "DeployBtcSettler: deterministic deployer 0x4e59...956C missing or unexpected"
        );
        require(realHbk().code.length > 0, "DeployBtcSettler: no code at hBK");
        console2.log("chain id:", block.chainid);
    }

    /// @notice The compiled initcode lands at the address in BtcSettlerCanonical.
    function checkTarget(
        Target memory t
    ) public pure {
        address p = predicted(t);
        if (p != t.expected) {
            console2.log(string.concat(t.name, " would deploy to"), p);
            console2.log("but BtcSettlerCanonical expects", t.expected);
            revert(
                string.concat(
                    "DeployBtcSettler: CREATE2 address of ",
                    t.name,
                    " differs from BtcSettlerCanonical; the source, compiler settings or constructor arguments changed"
                )
            );
        }
    }

    /// @notice Post-conditions: each contract exists and reports the expected immutables.
    function checkDeployed() public view {
        (address hbk, address settler, uint32 offset) = settlerArgs();
        X402BtcSettler s = X402BtcSettler(settlerTarget().expected);
        require(address(s).code.length > 0, "DeployBtcSettler: no code at the settler");
        require(s.HBK() == hbk, "DeployBtcSettler: settler HBK() mismatch");
        require(s.SETTLER() == settler, "DeployBtcSettler: settler SETTLER() mismatch");
        require(s.CONFIRMATION_OFFSET() == offset, "DeployBtcSettler: settler CONFIRMATION_OFFSET() mismatch");
        if (block.chainid == HemiCanonical.HEMI_TESTNET) {
            HbkTestnetAdapter a = HbkTestnetAdapter(adapterTarget().expected);
            require(address(a).code.length > 0, "DeployBtcSettler: no code at the adapter");
            require(a.HBK() == BtcSettlerCanonical.HBK_TESTNET, "DeployBtcSettler: adapter HBK() mismatch");
        }
        console2.log("checks passed: code present, HBK(), SETTLER(), CONFIRMATION_OFFSET()");
    }
}
