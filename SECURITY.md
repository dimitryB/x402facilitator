# Security

## Status

This is experimental software. It has settled a handful of small live payments (README, "Mainnet deployment") and has not had an independent security audit. The review of `X402BtcSettler` recorded in DECISIONS.md D-038 was an internal, AI-assisted review done before deployment; treat it as a careful read, not as an audit. Run it with keys and amounts you can afford to lose.

## Reporting a vulnerability

Please report privately, not in a public issue: use **Report a vulnerability** under this repository's Security tab (GitHub private vulnerability reporting). Include what is affected, how to reproduce it, and what an attacker gains. This is a one-person project, so a reply can take a few days. There is no bug bounty.

## In scope

- The facilitator patches in `facilitator/x402-rs/patches` and the crate in `facilitator/x402-rs/crates/x402-chain-bip122`: anything that makes the facilitator settle a payment it should reject, settle one payment twice, or spend its signer's funds beyond gas for a valid settlement.
- `X402BtcSettler` (`contracts/src/btc`), deployed on Hemi mainnet at `0x9Df0B4752D00dF65Fb4f7FfdFe0545543f08ab9f`: anything that marks an output consumed without the checks, or lets someone other than `SETTLER` do so.
- The deploy scripts and the address derivation in `btc/` (a payment address that the seller's xpub does not control, or that two paymentIds share by construction).
- A secret committed to this repository.

## Out of scope here

- Bugs in upstream x402-rs, the x402 SDK, Permit2, the x402 exact proxy, or Hemi's hBK that do not depend on this repository's changes: report those to their maintainers.
- The limits already listed in the README ("Limits and open items"), unless you can show they are worse than described.
- The keys in `scripts/fork.sh`, `buyer/demo-fork.sh`, `docker-compose.fork.yml` and the test files: they are the well-known anvil development keys and published test vectors, used only on local forks.

## Keys

The facilitator's signer is a hot key that pays gas and is the settler contract's only authorised caller. It never holds buyer or seller funds: payments move from buyer to seller directly. Keep it funded with gas money only. Secrets belong in `.env`, which is git-ignored; `scripts/new-key.sh` creates keys without printing them.
