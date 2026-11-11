# sdk-patch

This patch registers Hemi in the upstream x402 SDKs ([x402-foundation/x402](https://github.com/x402-foundation/x402)) for TypeScript, Go and Python, so dollar-string pricing such as `price: "$0.001"` works on Hemi without extra configuration. It is item 5 of the architecture in [docs/BRIEF.md](../docs/BRIEF.md). It was submitted on 2026-11-10 as [x402-foundation/x402#4213](https://github.com/x402-foundation/x402/pull/4213) and merged on 2026-11-11 as upstream commit `4f674517`, which makes the same change as `0001-hemi-networks.patch`. No SDK release includes it yet: the newest are `@x402/evm` 2.30.0, Go `go/v2.30.0` and PyPI `x402` 2.27.0, all from 2026-11-04 or earlier (DECISIONS.md D-053).

| File | What it is |
|------|------------|
| `0001-hemi-networks.patch` | The PR's whole change as one commit on upstream `main` at `327ff3cb` (2026-11-11), produced with `git format-patch` |
| `PR.md` | The PR's title and description |

## Upstream commits

The PR branch is `hemi-default-stablecoins` on the fork [`dimitryB/x402`](https://github.com/dimitryB/x402/tree/hemi-default-stablecoins).

- **`78ba854`, 2026-11-10:** the first commit, TypeScript only, on upstream `d3eb19d`.
- **Review of 2026-11-11.** A maintainer's review bot (`PhilBot402`, "Automated by @phdargen") asked for three changes. The Robinhood Chain PR (#4207) got the same review the day before:
  1. release the `@x402/evm` changeset as `patch`, not `minor`;
  2. drop the unit test in `defaultAssets.test.ts` that asserted the Hemi values (the `parsePrice` tests in `server.test.ts` stay);
  3. add Hemi to the Go and Python default asset tables too, each with a changelog fragment.
- **`fe85cfb`, 2026-11-11:** GitHub's "Update branch", merging upstream `main` at `404d91c3` into the PR branch. Upstream requires signed commits, and this machine has no signing key, so commits are made through GitHub (GraphQL `createCommitOnBranch`, which GitHub signs), and that API can only add a commit on top of the branch. Upstream had meanwhile added `ethereum` and `flare` to Python's v1 network list (#4212), where Hemi's names go, so a commit on the old base would have conflicted.
- **`a580c10`, 2026-11-11:** the review commit, `address review: release as patch, drop the Hemi value test, add Go and Python`, verified. The branch's tree (`b562833`) is identical to this patch on `404d91c3`; the tests below ran on `327ff3cb`, and `404d91c3` only adds a Go Gin fix. The PR description was replaced with `PR.md` at the same time.
- **`4f674517`, 2026-11-11:** the merge. The maintainer `phdargen` marked the PR ready for review at 20:18 UTC, approved it at 21:05 and squash-merged it at 21:05:42 as `feat(evm): add Hemi default stablecoins (#4213)`, on parent `d69ee2f7`. Its diff touches the same 11 files with the same added lines as `0001-hemi-networks.patch` (+88, nothing removed).

The patch follows the conventions of the earlier default-asset PRs:

- `1d2858cf` feat(evm): add Robinhood Chain (eip155:4663) with USDG as default asset (#4207): all three SDKs, a `@x402/evm` patch changeset, a Go changie fragment (`kind: added`) and a Python Towncrier `feature` fragment, and no default-asset value tests
- `a9955ae5` feat(evm): add Monad testnet USDC default asset (#3570): a v1 network name in `constants.ts`
- `d9bd02d1` feat(evm): add Igra mainnet default stablecoin (#2800): the shape of a Permit2-only entry with no EIP-2612

Neither changie nor Towncrier ties a fragment's kind to a version level; maintainers choose the version when they release.

## What it changes

- **Default assets,** in `typescript/.../defaultAssets.ts`, `go/mechanisms/evm/default_assets.go` and `python/x402/mechanisms/evm/default_assets.py`:
  - `eip155:43111` → USDC.e `0xad11a8BEb98bbf61dbb1aa0F6d6F2ECD87b35afA`: EIP-3009, EIP-712 name `Bridged USDC (Stargate)`, version `2`
  - `eip155:743111` → USDC.e `0xD47971C7F5B1067d25cd45d30b2c9eb60de96443`: Permit2, no EIP-2612 (placeholder domain `USDC.e` / `1`, as for Igra)
- **v1 network names** `hemi` (43111) and `hemi-testnet` (743111): TypeScript `constants.ts`, Go `v1/network.go` and the legacy map in `default_assets.go`, Python `v1/constants.py`
- **Docs:** two rows in `docs/core-concepts/network-and-token-support.mdx`
- **Changelog:** a `@x402/evm` patch changeset, `go/.changes/unreleased/added-20261111-hemi-usdce.yaml`, `python/x402/changelog.d/4213.feature.md`
- **Unit tests:** `parsePrice("$0.001")` on both networks (`server.test.ts`)

The facts behind these values are in [DECISIONS.md](../DECISIONS.md): D-001, D-007, D-009 and D-010.

Before relying on the patch, note that **testnet payments go through Permit2.** The testnet default asset needs canonical Permit2 and the x402 exact Permit2 proxy. Both were deployed on Hemi Testnet on 2026-10-29, and a USDC.e payment has settled there ([docs/testnet-run.md](../docs/testnet-run.md)). The payer sends one on-chain `approve(Permit2)` first.

## Apply

Requirements: Node 22 or later and pnpm 11.1.1 (pinned in `typescript/package.json`; `npx pnpm@11.1.1` works in its place), Go as `go/go.mod` asks (1.26.10; a newer local Go downloads it), and uv 0.13.4 or later for Python.

```sh
git clone https://github.com/x402-foundation/x402
cd x402
git checkout -b hemi-networks 327ff3cb2a78e2b85fad2e99b4f12fff7c338495
git am /path/to/x402facilitator/sdk-patch/0001-hemi-networks.patch
```

To check the patch without committing, run `git apply --check 0001-hemi-networks.patch`. The PR branch can also be fetched directly: `git fetch https://github.com/dimitryB/x402 hemi-default-stablecoins`.

If your global npm config points at a private registry, force the public one for this clone only. Don't commit this file:

```sh
printf 'registry=https://registry.npmjs.org/\n' > typescript/.npmrc
echo typescript/.npmrc >> .git/info/exclude
```

## Build and test

```sh
cd typescript
pnpm install --frozen-lockfile
pnpm turbo run build --filter=@x402/evm      # builds @x402/core and @x402/evm
cd packages/mechanisms/evm
pnpm test                 # vitest run --coverage
pnpm run lint:check       # eslint
pnpm run format:check     # prettier

cd ../../../../go
gofmt -l mechanisms/evm
go test ./...

cd ../python/x402
uv sync
uv run pytest tests/unit/mechanisms/evm
```

Results on 2026-11-11, on `327ff3cb` with the patch:

| Command | Result |
|---------|--------|
| `pnpm test` | `Test Files 64 passed (64)`, `Tests 2102 passed (2102)` (2103 before the value test was dropped) |
| `eslint . --ext .ts`, `prettier --check` (package and changeset) | exit 0; `All matched files use Prettier code style!` |
| `gofmt -l mechanisms/evm` | no output |
| `go test ./...` (go 1.26.10) | 49 packages `ok`, none failed; `FindDefaultAsset` resolves both assets through `hemi` and `hemi-testnet`, and `ConvertDefaultMoney("0.001", "eip155:743111")` gives 1000 units with `permit2` (a throwaway test, not committed) |
| `uv run pytest tests/unit` (uv 0.13.4) | `3472 passed`, of which 1153 in `tests/unit/mechanisms/evm` |
| `ruff check`, `ruff format --check` (`mechanisms/evm`) | `All checks passed!`; `74 files already formatted` |

## Regenerate the patch

From a clone with the PR's change squashed onto upstream `main`:

```sh
git format-patch -1 HEAD --stdout > sdk-patch/0001-hemi-networks.patch
```
