# hemi-x402-facilitator

An x402 v2 facilitator that verifies and settles payments on Hemi (`eip155:43111` mainnet, `eip155:743111` testnet) in USDC.e and hemiBTC, so any x402-aware agent can pay a Hemi endpoint.

**Status:** pre-spike. The on-chain checks that decide the transfer method have not run yet; see [DECISIONS.md](DECISIONS.md). MVP work happens on `feat/facilitator-mvp`.
