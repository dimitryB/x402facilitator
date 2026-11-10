# Contributing

Issues and pull requests are welcome. This is a small, experimental project
([status and limits](README.md)), so a reply can take a few days.

- **Security vulnerabilities:** do not open an issue. Report them privately as
  [SECURITY.md](SECURITY.md) describes.
- **Bugs in x402-rs or the x402 SDK themselves:** if it reproduces on unpatched x402-rs at the pinned
  commit, or on the stock SDK, it belongs [upstream](https://github.com/x402-rs/x402-rs/issues). What
  this repository changes is listed in [facilitator/x402-rs/README.md](facilitator/x402-rs/README.md).

## Setup

You need Node 22.9 or newer, [Foundry](https://getfoundry.sh) (`forge`, `cast`, `anvil`), Docker with
Compose, and `jq`. Nothing below needs a key, an account or funds.

```sh
npm ci
npm run typecheck                 # all TypeScript packages
npm test                          # unit tests of the btc package
(cd contracts && forge test)      # contract tests; the fork tests read pinned blocks from the public Hemi RPCs
docker compose build              # the facilitator image: x402-rs at the pinned commit, patched
npm run test:e2e                  # end-to-end suite against that image on local anvil forks
buyer/demo-fork.sh                # the whole flow once: forks, facilitator, seller, five payments
```

CI runs the same commands (`.github/workflows`).

## Rules for a change

- **No live-network transactions in tests or scripts that run by default.** Tests run on anvil forks
  with anvil's published dev keys. Anything that can send to Hemi mainnet or Bitcoin stays behind an
  explicit switch (`ALLOW_MAINNET=yes`, `CONFIRM_MAINNET_DEPLOY=yes`), as it is today.
- **No secrets in the repository.** `.env` is git-ignored; `.env.example` holds names and placeholders
  only. Push protection is on and will reject a commit that contains a recognised credential.
- **Facilitator patches** (`facilitator/x402-rs/patches`) are small, one concern each, and written so
  they could go upstream. The series must apply in order on the pinned commit; bump the image tag in
  `docker-compose.yml` when the image changes. The Rust dependency versions come from x402-rs's
  `Cargo.lock`; the build fails if the lock drifts
  ([facilitator/x402-rs/README.md](facilitator/x402-rs/README.md)).
- **Contracts:** `contracts/src/x402` is kept byte-identical to the x402 reference and
  `contracts/lib` is vendored third-party code; neither is edited here. `contracts/src/btc` is the
  source the deployed `X402BtcSettler` was built from: a change there means a new deployment, so open
  an issue first. Run `forge fmt` before committing.
- **Behaviour changes come with their documentation:** the README, the package's own README, and
  [the scheme spec](docs/specs/scheme_exact_bip122.md) where the wire format is concerned. Larger
  design choices get a dated entry in [DECISIONS.md](DECISIONS.md) with the commands that were run and
  what they printed.
- Say in the pull request how you checked the change.

## Licence of contributions

Unless you say otherwise, anything you submit for inclusion is licensed under
[Apache-2.0](LICENSE), as section 5 of that licence states, without additional terms. Solidity files
under `contracts/` keep the licence named in their SPDX header ([NOTICE](NOTICE)).
