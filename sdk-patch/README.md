# sdk-patch

This patch registers Hemi in the upstream x402 TypeScript SDK ([x402-foundation/x402](https://github.com/x402-foundation/x402)), so dollar-string pricing such as `price: "$0.001"` works on Hemi without extra configuration. It is item 5 of the architecture in [docs/BRIEF.md](../docs/BRIEF.md). It is kept here as a draft upstream PR and has not been submitted.

| File | What it is |
|------|------------|
| `0001-hemi-networks.patch` | One commit, `feat(evm): add Hemi default stablecoins`, produced with `git format-patch` |
| `PR.md` | Draft PR title and description: evidence for each token and the Permit2 caveat |

## Upstream commit

The patch targets `e4a086819f419e9395acbbdc1679fe6627029ff7` ("chore: version typescript packages (#4036)", 2026-10-29). It follows the conventions of the most recent default-asset PRs:

- `dd896985` feat(evm): add Arc default stablecoins (#3590): a mainnet and testnet pair, a docs table row, a `@x402/evm` minor changeset
- `a9955ae5` feat(evm): add Monad testnet USDC default asset (#3570): a v1 network name in `constants.ts`
- `d9bd02d1` feat(evm): add Igra mainnet default stablecoin (#2800): the shape of a Permit2-only entry with no EIP-2612

## What it changes

- **`DEFAULT_ASSETS`**
  - `eip155:43111` → USDC.e `0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA`: EIP-3009, EIP-712 name `Bridged USDC (Stargate)`, version `2`
  - `eip155:743111` → USDC.e `0xD47971C7F5B1067d25cd45d30b2c9eb60de96443`: `assetTransferMethod: "permit2"`, no EIP-2612
- **v1 network names:** `hemi` (43111) and `hemi-testnet` (743111)
- **Docs:** two rows in `docs/core-concepts/network-and-token-support.mdx`
- **Changeset:** one for `@x402/evm`
- **Unit tests:** `parsePrice("$0.001")` on both networks, and resolution of the v1 names

The facts behind these values are in [DECISIONS.md](../DECISIONS.md): D-001, D-007, D-009 and D-010.

Two things to know before relying on the patch:

- **Testnet payments go through Permit2.** The testnet default asset needs canonical Permit2 and the x402 exact Permit2 proxy. Both were deployed on Hemi Testnet on 2026-10-29, and a USDC.e payment has settled there ([docs/testnet-run.md](../docs/testnet-run.md)). The payer sends one on-chain `approve(Permit2)` first.
- **TypeScript only.** Upstream usually updates the Go and Python SDKs in the same PR. `PR.md` lists the matching files in those SDKs.

## Apply

Requirements: Node 22 or later, and pnpm 11.1.1, which is pinned in `typescript/package.json`. If pnpm isn't installed, `npx pnpm@11.1.1` works in its place.

```sh
git clone https://github.com/x402-foundation/x402
cd x402
git checkout -b hemi-networks e4a086819f419e9395acbbdc1679fe6627029ff7
git am /path/to/x402facilitator/sdk-patch/0001-hemi-networks.patch
```

To check the patch without committing, run `git apply --check 0001-hemi-networks.patch`. On top of `e4a0868` it applies cleanly and produces the same tree as the working branch.

If your global npm config points at a private registry, force the public one for this clone only. Don't commit this file:

```sh
printf 'registry=https://registry.npmjs.org/\n' > typescript/.npmrc
echo typescript/.npmrc >> .git/info/exclude
```

## Build and test

```sh
cd typescript
pnpm install --frozen-lockfile --filter '@x402/evm...' --filter x402_monorepo
pnpm turbo run build --filter=@x402/evm      # builds @x402/core and @x402/evm

cd packages/mechanisms/evm
pnpm test                 # vitest run --coverage
pnpm run lint:check       # eslint
pnpm run format:check     # prettier

# Only the new Hemi cases:
pnpm exec vitest run test/unit/server.test.ts test/unit/defaultAssets.test.ts -t "emi"
```

Results on 2026-10-29:

| Command | Result |
|---------|--------|
| `pnpm test` | `Test Files 57 passed (57)`, `Tests 1650 passed (1650)`, coverage thresholds met |
| `pnpm run lint:check` | exit 0 |
| `pnpm run format:check` | `All matched files use Prettier code style!` |

## Regenerate the patch

From the working clone, on branch `hemi-networks`:

```sh
git format-patch e4a086819f419e9395acbbdc1679fe6627029ff7 --stdout > sdk-patch/0001-hemi-networks.patch
```
