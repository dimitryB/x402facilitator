# Decisions

Each entry records what was checked, the exact command run and its output. Entries marked "verify" in the brief's shared context get one entry each.

## Spike status: not run (2026-10-28)

The checks below could not be run. From both the cloud session and the local workspace VM, every Hemi RPC (`rpc.hemi.network`, `testnet.rpc.hemi.network`, `hemi.drpc.org`, `hemi-testnet.drpc.org`) returns `403 from proxy after CONNECT`. The explorer also refuses automated requests. The block is the session's egress allowlist; nothing on Hemi has been observed. The spike result will be entry D-001.

### Verify items still open

| Item | Mainnet | Testnet |
|------|---------|---------|
| Deterministic deployer at `0x4e59b44847b379578588920cA78FbF26c0B4956C` | not run | not run |
| Permit2 at canonical `0x000000000022D473030F116dDEE9F6B43aC78BA3` | not run | not run |
| Exact proxy already at `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` | not run | not run |
| USDC.e address (explorer or tunnel UI only) | not run | not run |
| hemiBTC address (explorer or tunnel UI only) | not run | not run |
| USDC.e implements EIP-3009 `transferWithAuthorization` | not run | not run |
| USDC.e implements EIP-2612 `permit` | not run | not run |
| hBK precompile addresses and ABI (phase 2 only) | not run | not run |

## Pre-spike context: what the reference code requires

Read at x402-rs `e75adda` (2026-07-13) and x402-foundation/x402 `e4a0868` (2026-10-28).

### P-1. Permit2 and the exact proxy are compile-time constants, not config

- x402-rs `crates/chains/x402-chain-eip155/src/chain/permit2.rs` hardcodes `PERMIT2_ADDRESS = 0x000000000022D473030F116dDEE9F6B43aC78BA3` and `EXACT_PERMIT2_PROXY_ADDRESS = 0x402085c248EeA27D92E8b30b2C58ed07f9E20001`.
- The facilitator rejects any Permit2 payload whose spender is not that proxy (`v2_eip155_exact/facilitator/permit2.rs:122`).
- The per-chain config (`Eip155ChainConfigInner`) has only `eip1559`, `flashblocks`, `signers`, `rpc` and `receipt_timeout_secs`; there is no field for either address.
- The TS SDK hardcodes the same two addresses (`typescript/packages/mechanisms/evm/src/constants.ts`), so every stock buyer signs for them.
- The proxy reaches its address via CREATE2 through `0x4e59…`, using a fixed salt and a committed initCode (`contracts/evm/script/data/exact-proxy-initcode.hex`) that embeds canonical Permit2 as its constructor argument.

Consequences:

- The Permit2 route works with stock x402-rs and stock buyers only if, on each Hemi chain, the deployer exists, Permit2 is canonical, and the proxy sits at `0x402085…0001`.
- A non-canonical Permit2 means forking x402-rs and patching the client SDK; it is not a config change.
- `contracts/` deploys the proxy from the reference repo's committed initCode via its `Deploy.s.sol`. Recompiling changes the CBOR metadata and moves the address.

### P-2. The RPC list is a fan-out, not primary/fallback

`chain/provider.rs` wraps every configured RPC in alloy's `FallbackLayer`, with the active transport count equal to the number of RPCs. Per alloy's design, requests go to all of them in parallel and the first success wins (to confirm against the alloy version in `Cargo.lock`). A dead primary is tolerated, but every call also counts against the public RPC's ~300 req/min.

### P-3. `DOMAIN_SEPARATOR()` alone does not prove EIP-2612

EIP-3009-only tokens expose it too. The EIP-2612 check must also call `nonces(address)` and probe the `permit` selector.
