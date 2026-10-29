// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {VmSafe} from "forge-std/Vm.sol";

/// @notice Canonical addresses and deployment facts for the three contracts stock x402-rs needs on
///         every EVM chain. Sources: DECISIONS.md D-003 to D-006.
library HemiCanonical {
    uint256 internal constant HEMI_MAINNET = 43_111;
    uint256 internal constant HEMI_TESTNET = 743_111;

    /// Arachnid's deterministic deployer. Calldata is `<32-byte salt><initcode>`; it CREATE2s the
    /// initcode with that salt and returns the 20-byte address.
    address internal constant CREATE2_DEPLOYER = 0x4e59b44847b379578588920cA78FbF26c0B4956C;
    /// keccak256 of the deployer's standard runtime code (D-003, same on both Hemi chains).
    bytes32 internal constant CREATE2_DEPLOYER_CODEHASH =
        0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989;

    address internal constant PERMIT2 = 0x000000000022D473030F116dDEE9F6B43aC78BA3;
    address internal constant VALIDATOR_6492 = 0xdAcD51A54883eb67D95FAEb2BBfdC4a9a6BD2a3B;
    address internal constant EXACT_PROXY = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001;

    // Salts and initcode hashes of the committed calldata (D-004, D-005, D-006).
    bytes32 internal constant PERMIT2_SALT = 0x0000000000000000000000000000000000000000d3af2663da51c10215000000;
    bytes32 internal constant PERMIT2_INITCODE_HASH =
        0xe2be1e05eedf35dacd66c65c862f8150ff9ab4b6b24b9bbe62be71b6b16cf0f8;
    bytes32 internal constant VALIDATOR_SALT = 0x7834303200000000000000000000000000000000000000000000000000000000; // "x402"
    bytes32 internal constant VALIDATOR_INITCODE_HASH =
        0x8a457240279c04f74154e0e10ecbeb78d2f2a8b68f5fb09658da494d89bb475e;
    bytes32 internal constant EXACT_PROXY_SALT = 0x0000000000000000000000000000000000000000000000003000000007263b0e;
    // Equals EXACT_INIT_CODE_HASH in x402-foundation/x402 commit e4a0868, contracts/evm/script/Deploy.s.sol.
    bytes32 internal constant EXACT_PROXY_INITCODE_HASH =
        0xe774d1d5a07218946ab54efe010b300481478b86861bb17d69c98a57f68a604c;

    // Runtime code hashes of the same contracts on Ethereum and Base. The validator and the proxy have
    // no chain-dependent bytes, so these hold on Hemi too. Permit2 embeds its chain id and domain
    // separator as immutables, so its runtime code hash is per chain.
    bytes32 internal constant VALIDATOR_CODEHASH = 0x9b83857bbb34de3ba755156ba9bee06532be5ff539bf5de301a28606c76d6cab;
    bytes32 internal constant EXACT_PROXY_CODEHASH = 0xce6429c0bb49284660683287c0a8fe548a88379072327d026626909d202048b9;
    /// Read from Hemi mainnet (D-004).
    bytes32 internal constant PERMIT2_CODEHASH_MAINNET =
        0x30002d17c268825d175caba993df71c34b30048f344b2ba63705a3063fa4743a;
    /// Produced by replaying permit2.calldata.hex on a Hemi testnet fork. It equals the mainnet code
    /// with the two immutables (chain id, domain separator) swapped for testnet's values.
    bytes32 internal constant PERMIT2_CODEHASH_TESTNET =
        0xc2e956e28d37dfea694910b07039b15bff6df7a4ed332c246beec4db54e2dc02;

    bytes32 internal constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");

    /// Permit2's EIP-712 domain separator for `chainId`, as Permit2's own EIP712 contract computes it.
    function permit2DomainSeparator(
        uint256 chainId
    ) internal pure returns (bytes32) {
        return keccak256(abi.encode(EIP712_DOMAIN_TYPEHASH, keccak256("Permit2"), chainId, PERMIT2));
    }

    function permit2Codehash(
        uint256 chainId
    ) internal pure returns (bytes32) {
        if (chainId == HEMI_MAINNET) return PERMIT2_CODEHASH_MAINNET;
        if (chainId == HEMI_TESTNET) return PERMIT2_CODEHASH_TESTNET;
        revert("HemiCanonical: not a Hemi chain");
    }

    function isHemi(
        uint256 chainId
    ) internal pure returns (bool) {
        return chainId == HEMI_MAINNET || chainId == HEMI_TESTNET;
    }

    function create2Address(
        bytes32 salt,
        bytes32 initCodeHash
    ) internal pure returns (address) {
        return
            address(uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), CREATE2_DEPLOYER, salt, initCodeHash)))));
    }
}

interface IPermit2Domain {
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

interface IExactPermit2Proxy {
    function PERMIT2() external view returns (address);
}

/// @title DeployHemi
/// @notice Idempotent deployment of Permit2, the EIP-6492 validator and the x402 exact Permit2 proxy
///         to their canonical CREATE2 addresses on Hemi mainnet (43111) or Hemi testnet (743111).
/// @dev Nothing is compiled for deployment. Each contract is deployed by sending the committed
///      calldata in deploy-data/ (`<salt><initcode>`, taken from the original deployments; see
///      DECISIONS.md) to the deterministic deployer. A contract whose address already has code is
///      skipped, so rerunning the script is a no-op.
///
///      Signer: the env var HEMI_DEPLOY_PRIVATE_KEY if set (deploy.sh sets it from
///      DEPLOYER_PRIVATE_KEY or, on testnet only, FACILITATOR_TESTNET_PRIVATE_KEY); otherwise the
///      wallet given to forge on the command line, or forge's default sender in a simulation.
///
///      Broadcasting on Hemi mainnet requires CONFIRM_MAINNET_DEPLOY=yes, checked here as well as in
///      deploy.sh, so a direct `forge script --broadcast` cannot skip the gate.
contract DeployHemi is Script {
    struct Target {
        string name;
        string file;
        address expected;
        bytes32 salt;
        bytes32 initCodeHash;
    }

    /// The three deployments, in deployment order.
    function targets() public pure returns (Target[3] memory t) {
        t[0] = Target(
            "Permit2",
            "deploy-data/permit2.calldata.hex",
            HemiCanonical.PERMIT2,
            HemiCanonical.PERMIT2_SALT,
            HemiCanonical.PERMIT2_INITCODE_HASH
        );
        t[1] = Target(
            "EIP-6492 validator",
            "deploy-data/validator6492.calldata.hex",
            HemiCanonical.VALIDATOR_6492,
            HemiCanonical.VALIDATOR_SALT,
            HemiCanonical.VALIDATOR_INITCODE_HASH
        );
        t[2] = Target(
            "x402 exact Permit2 proxy",
            "deploy-data/exact-proxy.calldata.hex",
            HemiCanonical.EXACT_PROXY,
            HemiCanonical.EXACT_PROXY_SALT,
            HemiCanonical.EXACT_PROXY_INITCODE_HASH
        );
    }

    function run() external {
        uint256 key = vm.envOr("HEMI_DEPLOY_PRIVATE_KEY", uint256(0));
        bool broadcasting =
            vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        if (block.chainid == HemiCanonical.HEMI_MAINNET && broadcasting) {
            require(
                keccak256(bytes(vm.envOr("CONFIRM_MAINNET_DEPLOY", string("")))) == keccak256("yes"),
                "DeployHemi: broadcasting to Hemi mainnet needs CONFIRM_MAINNET_DEPLOY=yes"
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

    /// @notice Deploys every missing contract, then checks all three. Returns how many were deployed.
    /// @param key Private key to broadcast with, or 0 for forge's configured sender.
    function deployAll(
        uint256 key
    ) public returns (uint256 deployed) {
        checkChain();
        Target[3] memory t = targets();
        for (uint256 i = 0; i < t.length; i++) {
            // Validate the committed calldata even when the contract exists, so a corrupted file
            // is caught on the first run against any chain.
            bytes memory data = loadCalldata(t[i]);
            if (t[i].expected.code.length > 0) {
                console2.log(string.concat("[skip]   ", t[i].name, ": code already at"), t[i].expected);
                continue;
            }
            console2.log(string.concat("[deploy] ", t[i].name, " ->"), t[i].expected);
            if (key != 0) vm.startBroadcast(key);
            else vm.startBroadcast();
            (bool ok, bytes memory ret) = HemiCanonical.CREATE2_DEPLOYER.call(data);
            vm.stopBroadcast();
            require(ok, string.concat("DeployHemi: deployer call reverted for ", t[i].name));
            require(
                ret.length == 20 && address(bytes20(ret)) == t[i].expected,
                string.concat("DeployHemi: deployer returned an unexpected address for ", t[i].name)
            );
            require(t[i].expected.code.length > 0, string.concat("DeployHemi: no code after deploying ", t[i].name));
            deployed++;
        }
        checkDeployed();
        console2.log("contracts deployed in this run:", deployed);
    }

    /// @notice Reverts unless this is Hemi mainnet or testnet (or a fork of one, which keeps the
    ///         chain id) and the standard deterministic deployer is present.
    function checkChain() public view {
        require(HemiCanonical.isHemi(block.chainid), "DeployHemi: chain id is neither 43111 nor 743111");
        require(
            HemiCanonical.CREATE2_DEPLOYER.code.length > 0, "DeployHemi: deterministic deployer 0x4e59...956C missing"
        );
        require(
            HemiCanonical.CREATE2_DEPLOYER.codehash == HemiCanonical.CREATE2_DEPLOYER_CODEHASH,
            "DeployHemi: unexpected code at the deterministic deployer"
        );
        console2.log("chain id:", block.chainid);
    }

    /// @notice Post-conditions: all three contracts carry the expected runtime code, Permit2's domain
    ///         separator is this chain's, and the proxy points at canonical Permit2.
    function checkDeployed() public view {
        require(
            HemiCanonical.PERMIT2.codehash == HemiCanonical.permit2Codehash(block.chainid),
            "DeployHemi: unexpected runtime code at Permit2"
        );
        require(
            HemiCanonical.VALIDATOR_6492.codehash == HemiCanonical.VALIDATOR_CODEHASH,
            "DeployHemi: unexpected runtime code at the EIP-6492 validator"
        );
        require(
            HemiCanonical.EXACT_PROXY.codehash == HemiCanonical.EXACT_PROXY_CODEHASH,
            "DeployHemi: unexpected runtime code at the exact proxy"
        );
        require(
            IPermit2Domain(HemiCanonical.PERMIT2).DOMAIN_SEPARATOR()
                == HemiCanonical.permit2DomainSeparator(block.chainid),
            "DeployHemi: Permit2 DOMAIN_SEPARATOR mismatch"
        );
        require(
            IExactPermit2Proxy(HemiCanonical.EXACT_PROXY).PERMIT2() == HemiCanonical.PERMIT2,
            "DeployHemi: exact proxy PERMIT2() is not canonical Permit2"
        );
        console2.log("checks passed: code hashes, Permit2 DOMAIN_SEPARATOR, proxy PERMIT2()");
    }

    /// @notice Reads `<salt><initcode>` from the committed hex file and checks it against the expected
    ///         salt, initcode hash and CREATE2 address before anything is sent.
    function loadCalldata(
        Target memory t
    ) public view returns (bytes memory data) {
        data = vm.parseBytes(vm.trim(vm.readFile(t.file)));
        require(data.length > 32, string.concat("DeployHemi: calldata too short in ", t.file));
        bytes32 salt;
        bytes32 initCodeHash;
        assembly {
            salt := mload(add(data, 32))
            initCodeHash := keccak256(add(data, 64), sub(mload(data), 32))
        }
        require(salt == t.salt, string.concat("DeployHemi: unexpected salt in ", t.file));
        require(initCodeHash == t.initCodeHash, string.concat("DeployHemi: unexpected initcode in ", t.file));
        require(
            HemiCanonical.create2Address(salt, initCodeHash) == t.expected,
            string.concat("DeployHemi: CREATE2 address mismatch for ", t.file)
        );
    }
}
