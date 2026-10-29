# Vendored x402 exact Permit2 proxy source

These files are copied unchanged from the x402 reference repository. They are here to be read, to
give the tests the proxy's ABI, and for explorer verification. They are not compiled for deployment:
the proxy is deployed from the reference repo's committed initcode (`../../deploy-data/exact-proxy.calldata.hex`).

- Repository: https://github.com/x402-foundation/x402
- Commit: `e4a086819f419e9395acbbdc1679fe6627029ff7` (e4a0868, 2026-10-28)
- Path: `contracts/evm/src/`

| File here | Source path | sha256 |
|------|------|------|
| `x402ExactPermit2Proxy.sol` | `contracts/evm/src/x402ExactPermit2Proxy.sol` | `6af38108c14d82dc61bdb719bac865ad138f49d8a06bb548223606d5bf325bae` |
| `x402BasePermit2Proxy.sol` | `contracts/evm/src/x402BasePermit2Proxy.sol` | `276f1d092f740ede30bb00508b03ae25fc4f64947dde03c4aaa0cccfc73ce1f7` |
| `interfaces/ISignatureTransfer.sol` | `contracts/evm/src/interfaces/ISignatureTransfer.sol` | `9ba755409cba5cada98715cc09c9efa50014d6f4c1e98da43e18bc301fe9bbc4` |

`LICENSE` and `NOTICE` are the repository's root license files (Apache-2.0). The source files carry
`SPDX-License-Identifier: MIT` headers.

The OpenZeppelin imports (`ReentrancyGuard`, `StorageSlot`, `IERC20Permit`) resolve to
`../../lib/openzeppelin-contracts/`, a copy of only those three files at OpenZeppelin Contracts
v5.5.0 (`fcbae5394ae8ad52d8e580a3477db99814b9d565`), the commit the reference repo pins as a submodule.

Compiled with the reference settings (solc 0.8.28, cancun, optimizer 200 runs, no CBOR metadata),
this source produces exactly the deployed proxy runtime code minus its trailing 53 bytes of CBOR
metadata. `test/DeployData.t.sol` checks that.
