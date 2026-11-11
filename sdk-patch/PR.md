# Upstream PR

Opened on 2026-11-10 as a draft: [x402-foundation/x402#4213](https://github.com/x402-foundation/x402/pull/4213), from `dimitryB/x402` branch `hemi-default-stablecoins` into `main`. Below are the title and description as posted.

## Title

feat(evm): add Hemi default stablecoins

## Body

### Description

Adds Hemi mainnet (`eip155:43111`) and Hemi Testnet (`eip155:743111`) to the TypeScript EVM default asset table, so `price: "$0.01"` resolves to USDC.e on both, and registers the v1 network names `hemi` and `hemi-testnet`. USDC.e is the USD stablecoin that Hemi's official token list ([`hemilabs/token-list@7a326ac`](https://github.com/hemilabs/token-list/blob/7a326ac4bf501e9205e0580625c9932fa8955f63/src/hemi.tokenlist.json)) gives for both chain IDs.

| Network | Asset | EIP-712 name / version | Decimals | Transfer method |
|---|---|---|---|---|
| Hemi | `0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA` | `Bridged USDC (Stargate)` / `2` | 6 | EIP-3009 (default) |
| Hemi Testnet | `0xD47971C7F5B1067d25cd45d30b2c9eb60de96443` | none on chain; `USDC.e` / `1` placeholders, as for Igra | 6 | Permit2, no EIP-2612 |

Changes:
- `DEFAULT_ASSETS` entries in `typescript/packages/mechanisms/evm/src/defaultAssets.ts`; v1 names in `constants.ts`
- Unit tests: `parsePrice("$0.001")` on both networks (the testnet result carries only `assetTransferMethod`, not the placeholder domain) and v1-name resolution
- Two rows in `docs/core-concepts/network-and-token-support.mdx`; `@x402/evm` minor changeset

Decimals are 6, so no paywall regeneration is needed. This PR is TypeScript only; Go and Python can follow here or separately, whichever you prefer.

### On-chain verification (public RPCs)

- Mainnet: `name()` → "Bridged USDC (Stargate)", `symbol()` → "USDC.e", `version()` → "2", `decimals()` → 6. `DOMAIN_SEPARATOR()` → `0x6fe49ef2438be116233a7505f2b997466e49631ac8e197a2f1f208108d598a11`, equal to the hash of that domain with chain ID 43111 and the token address. `authorizationState(address,bytes32)` is callable (Circle FiatToken v2.2 behind its proxy).
- Testnet: `name()` → "USDC.e", `decimals()` → 6; `version()`, `DOMAIN_SEPARATOR()`, `nonces(address)` and `authorizationState(address,bytes32)` all revert, so the token has neither EIP-3009 nor EIP-2612.
- Permit2 `0x000000000022D473030F116dDEE9F6B43aC78BA3` has code on both chains. `x402ExactPermit2Proxy` `0x402085c248EeA27D92E8b30b2C58ed07f9E20001` is deployed on both, with runtime bytecode identical to Base mainnet (code hash `0xce6429c0…048b9`). The `upto` proxy is not deployed on Hemi.
- Both defaults have settled live payments: USDC.e through the exact Permit2 proxy on Hemi Testnet, and USDC.e through EIP-3009 on mainnet (tx `0xa9b7c8c5b605cc0269a9ac55a3053e4d90fd2d5c69d0aeec4092e08b90a9a53d`).

Most of this PR, including the on-chain checks, was prepared with an AI coding agent. It stays a draft until I have reviewed it myself.

### Tests

From `typescript/packages/mechanisms/evm`, after `pnpm install --frozen-lockfile` and `pnpm turbo run build --filter=@x402/evm`:

- `pnpm test`: 64 files, 2103 tests passed; coverage thresholds met
- `pnpm lint:check` and `pnpm format:check`: clean; Prettier also clean on the changeset

### Checklist

- [x] I have formatted and linted my code
- [x] All new and existing tests pass
- [x] My commits are signed (required for merge)
- [x] I added a changelog fragment for user-facing changes (docs-only changes can skip)

🤖 Generated with [Claude Code](https://claude.com/claude-code)
