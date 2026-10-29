# Draft upstream PR

Target: `x402-foundation/x402`, base `main` (patch built on `e4a086819f419e9395acbbdc1679fe6627029ff7`). Not opened. Opening it needs Dimitry's go-ahead.

## Title

feat(evm): add Hemi default stablecoins

## Description

Enable dollar-string pricing (`price: "$0.001"`) on Hemi mainnet (`eip155:43111`) and Hemi Testnet (`eip155:743111`) in the TypeScript SDK.

Without a default asset, `"$0.001"` on either Hemi network throws `No default asset configured for network eip155:43111`, so sellers must hand-build an `AssetAmount`. Buyers are blocked as well: `findDefaultAsset` doesn't recognize Hemi USDC.e, and by default `x402Client` spend controls only accept recognized USD-pegged assets. With this change both sides work out of the box.

### Changes

| File | Change |
|------|--------|
| `typescript/packages/mechanisms/evm/src/defaultAssets.ts` | `eip155:43111` USDC.e (EIP-3009, EIP-712 name `Bridged USDC (Stargate)`, version `2`) and `eip155:743111` USDC.e (`assetTransferMethod: "permit2"`, no `supportsEip2612`, same shape as the Igra entry) |
| `typescript/packages/mechanisms/evm/src/constants.ts` | v1 network names `hemi` → 43111, `hemi-testnet` → 743111 |
| `docs/core-concepts/network-and-token-support.mdx` | Two rows in the EVM default-asset table |
| `typescript/.changeset/add-hemi-default-stablecoin.md` | `@x402/evm` minor |
| `typescript/packages/mechanisms/evm/test/unit/server.test.ts` | `parsePrice("$0.001")` on both networks: the mainnet result carries `name`/`version`; the testnet result carries only `assetTransferMethod: "permit2"`. This is the first exact-server test of a default asset that uses Permit2 without EIP-2612. |
| `typescript/packages/mechanisms/evm/test/unit/defaultAssets.test.ts` | The v1 names `hemi` and `hemi-testnet` resolve to the new entries |

Nothing else needs to change:
- **viem chains.** viem 2.48.11 (the version in the lockfile) already exports `hemi` (43111, "Hemi") and `hemiSepolia` (743111, "Hemi Sepolia", `testnet: true`). The paywall looks chains up dynamically from `viem/chains`, so display names and testnet detection already work.
- **Paywall decimals map.** Both tokens use 6 decimals, so `paywall/src/evm/gen/decimals.ts` doesn't change.
- **Paywall faucet link.** I haven't added one. Testnet USDC.e is tunneled from Sepolia, and I couldn't confirm a direct faucet URL. Adding one later also means regenerating the paywall templates.

### Token details and evidence

| Network | Token | Decimals | EIP-3009 | EIP-2612 | Transfer method |
|---------|-------|----------|----------|----------|-----------------|
| Hemi `eip155:43111` | USDC.e [`0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA`](https://explorer.hemi.xyz/address/0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA) (Circle FiatToken v2.2 behind FiatTokenProxy, Stargate bridged) | 6 | yes | yes | EIP-3009 (default) |
| Hemi Testnet `eip155:743111` | USDC.e [`0xD47971C7F5B1067d25cd45d30b2c9eb60de96443`](https://testnet.explorer.hemi.xyz/address/0xD47971C7F5B1067d25cd45d30b2c9eb60de96443) (plain ERC-20, tunneled from Sepolia, not a proxy) | 6 | no | no | Permit2 |

**Asset selection.** USDC.e is the USD stablecoin that Hemi's official token list ([`hemilabs/token-list@7a326ac`](https://github.com/hemilabs/token-list/blob/7a326ac4bf501e9205e0580625c9932fa8955f63/src/hemi.tokenlist.json)) gives for both chain IDs. Network names follow Hemi's docs ([network details](https://github.com/hemilabs/docs/blob/61aced77175307475fea525d864496b95a21e913/discover/network-details.md): "Hemi Mainnet" / "Hemi Testnet").

**Mainnet EIP-712 domain.** I recomputed the domain separator from name `Bridged USDC (Stargate)`, version `2`, chain 43111 and the token address. It equals the on-chain `DOMAIN_SEPARATOR()`. The token doesn't implement EIP-5267 `eip712Domain()`, so clients can't discover these values on their own; the default-asset entry supplies them.

```
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "name()(string)"    --rpc-url https://rpc.hemi.network/rpc   # "Bridged USDC (Stargate)"
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "version()(string)" --rpc-url https://rpc.hemi.network/rpc   # "2"
$ cast call 0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA "DOMAIN_SEPARATOR()(bytes32)" --rpc-url https://rpc.hemi.network/rpc
0x6fe49ef2438be116233a7505f2b997466e49631ac8e197a2f1f208108d598a11
# viem: domainSeparator({ domain: { name: "Bridged USDC (Stargate)", version: "2", chainId: 43111, verifyingContract: "0xad11…5afA" } })
0x6fe49ef2438be116233a7505f2b997466e49631ac8e197a2f1f208108d598a11
```

**Mainnet EIP-3009.** The function exists. A call with `validBefore = 0` fails the token's own time check, while a nonexistent selector reverts with empty data:

```
$ cast call 0xad11…5afA "transferWithAuthorization(address,address,uint256,uint256,uint256,bytes32,uint8,bytes32,bytes32)" 0x…dEaD 0x…dEaD 1 0 0 0x00…00 27 0x00…00 0x00…00 --rpc-url https://rpc.hemi.network/rpc
Error: execution reverted: FiatTokenV2: authorization is expired
$ cast call 0xad11…5afA "definitelyNotAFunction_x402()" --rpc-url https://rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
```

The implementation behind the proxy is `0x4f5f42799d1e01662b629ede265baea223e9f9c7`. It contains the selectors `e3ee160e`, `cf092995`, `ef55bec6` and `e94a0102` (EIP-3009) and `d505accf`, `7ecebe00` and `3644e515` (EIP-2612).

**Testnet: no EIP-3009 and no EIP-2612.** Every probe reverts with empty data, the same as the control call. None of the selectors above appear in the 5544-byte runtime code, and the EIP-1967 and FiatToken implementation slots are zero.

```
$ cast call 0xD47971C7F5B1067d25cd45d30b2c9eb60de96443 "name()(string)" --rpc-url https://testnet.rpc.hemi.network/rpc   # "USDC.e"
$ cast call 0xD479…6443 "transferWithAuthorization(…v,r,s)" … --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"
$ cast call 0xD479…6443 "version()(string)" / "DOMAIN_SEPARATOR()(bytes32)" / "nonces(address)(uint256)" … --rpc-url https://testnet.rpc.hemi.network/rpc
Error: server returned an error response: error code 3: execution reverted, data: "0x"   # all three
```

The testnet token has no EIP-712 domain at all: no `version()`, no `DOMAIN_SEPARATOR()`. Following the Igra entry, the table carries `name: "USDC.e"` (from `name()`) and `version: "1"`. These are placeholders that satisfy the type, not a real domain, and nothing should sign with them. The exact scheme doesn't send these values for a Permit2 entry without `supportsEip2612`, and the new testnet `parsePrice` test asserts that.

### Caveat: Permit2 on Hemi needs contract deployments first

- **Testnet.** The default asset is Permit2-only, so payments in it can't settle until both of these exist on `eip155:743111`:
  - canonical Permit2 at `0x000000000022D473030F116dDEE9F6B43aC78BA3`
  - `x402ExactPermit2Proxy` at `0x402085c248EeA27D92E8b30b2C58ed07f9E20001`

  As of 2026-10-29 neither has code on Hemi Testnet (`eth_getCode` returns `0x`). Until both are deployed, `"$0.001"` on testnet produces valid payment requirements that no facilitator can settle.
- **Mainnet.** Canonical Permit2 is present and byte-identical to Ethereum's apart from its chain-specific immutables. The exact proxy is not deployed yet. This doesn't affect the mainnet default asset, which settles through EIP-3009 and never touches Permit2.
- **Deployment.** We plan to deploy both contracts at their canonical CREATE2 addresses through the deterministic deployer `0x4e59b44847b379578588920cA78FbF26c0B4956C`, which is present on both chains. A dry run with `eth_call` reproduces the expected addresses. Once deployed, the proxy rows can go into `contracts/evm/README.md`.
- **Options for reviewers.** Merge as is (the entry is correct, and it becomes usable once the contracts land), hold the PR until the deployments are confirmed, or merge the mainnet entry now and the testnet entry later.
- **`upto` scheme.** `upto` always copies `name`/`version` into `extra`. If a facilitator advertises `eip2612GasSponsoring`, a client could try an EIP-2612 permit against the testnet token and fail at `nonces()`. Igra already has the same pre-existing behaviour. The `upto` proxy (`0x4020A4f3…0002`) isn't deployed on Hemi either.

### Other SDKs (not changed in this PR)

Recent default-asset PRs (Arc #3590, Monad testnet #3570, Sei #3227) updated all three SDKs together. This PR covers TypeScript only. The equivalent tables are:

- **Go:** `go/mechanisms/evm/default_assets.go` (`DefaultAssets`, `legacyNetworkChainIDs`), `go/mechanisms/evm/v1/network.go` (`NetworkChainIDs`), and a changelog fragment in `go/.changes/unreleased/`.
- **Python:** `python/x402/mechanisms/evm/default_assets.py` (`DEFAULT_ASSETS`), `python/x402/mechanisms/evm/v1/constants.py` (`V1_NETWORKS`, `V1_NETWORK_CHAIN_IDS`), and a fragment in `python/x402/changelog.d/`.

I'm happy to add Go and Python parity here or in a follow-up, whichever maintainers prefer.

The legacy `x402` v1 package (`typescript/packages/legacy`) has its own viem chain map. It hasn't received any of the recent networks (MegaETH, Stable, Monad), so I left it alone.

### Testing

```
cd typescript
pnpm install --frozen-lockfile --filter '@x402/evm...' --filter x402_monorepo
pnpm turbo run build --filter=@x402/evm
cd packages/mechanisms/evm
pnpm test            # Test Files 57 passed (57), Tests 1650 passed (1650); coverage thresholds met
pnpm run lint:check  # exit 0
pnpm run format:check  # All matched files use Prettier code style!
```

🤖 Generated with [Claude Code](https://claude.com/claude-code)
