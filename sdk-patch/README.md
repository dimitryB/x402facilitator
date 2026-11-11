# sdk-patch

This patch registers Hemi in the upstream x402 TypeScript SDK ([x402-foundation/x402](https://github.com/x402-foundation/x402)), so dollar-string pricing such as `price: "$0.001"` works on Hemi without extra configuration. It is item 5 of the architecture in [docs/BRIEF.md](../docs/BRIEF.md). It was submitted on 2026-11-10 as [x402-foundation/x402#4213](https://github.com/x402-foundation/x402/pull/4213). The PR stays a draft until the owner has reviewed it, as upstream's rules for AI-assisted contributions require (DECISIONS.md D-045).

| File | What it is |
|------|------------|
| `0001-hemi-networks.patch` | The PR's commit, `feat(evm): add Hemi default stablecoins`, produced with `git format-patch` |
| `PR.md` | The PR's title and description as posted |

## Upstream commit

The patch is commit `78ba854` on the fork [`dimitryB/x402`](https://github.com/dimitryB/x402/tree/hemi-default-stablecoins), branch `hemi-default-stablecoins`, on top of upstream `main` at `d3eb19d018801c190be58acf4017e76f8bcf6d45` (2026-11-10). It was first written against `e4a0868` (2026-10-28). Replayed on `d3eb19d`, it conflicted only where upstream had just added Robinhood Chain (#4207) at the same place in `defaultAssets.ts` and in the docs table; both entries were kept.

Upstream requires signed commits, and this machine has no signing key, so the commit was created through GitHub's GraphQL `createCommitOnBranch`, which GitHub signs. GitHub shows it as verified, authored by `dimitryB`.

The patch follows the conventions of the earlier default-asset PRs:

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
- **TypeScript only.** Upstream usually updates the Go and Python SDKs in the same PR. The PR offers to add them there or separately.

## Apply

Requirements: Node 22 or later, and pnpm 11.1.1, which is pinned in `typescript/package.json`. If pnpm isn't installed, `npx pnpm@11.1.1` works in its place.

```sh
git clone https://github.com/x402-foundation/x402
cd x402
git checkout -b hemi-networks d3eb19d018801c190be58acf4017e76f8bcf6d45
git am /path/to/x402facilitator/sdk-patch/0001-hemi-networks.patch
```

To check the patch without committing, run `git apply --check 0001-hemi-networks.patch`. On top of `d3eb19d` it applies cleanly and produces the tree of the PR's commit. The PR branch can also be fetched directly: `git fetch https://github.com/dimitryB/x402 hemi-default-stablecoins`.

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

Results on 2026-11-10, on `d3eb19d`:

| Command | Result |
|---------|--------|
| `pnpm test` | `Test Files 64 passed (64)`, `Tests 2103 passed (2103)`, coverage thresholds met |
| `pnpm run lint:check` | exit 0 |
| `pnpm run format:check` | `All matched files use Prettier code style!` |

## Regenerate the patch

From a clone that has the PR branch:

```sh
git format-patch -1 <the PR's head commit> --stdout > sdk-patch/0001-hemi-networks.patch
```
