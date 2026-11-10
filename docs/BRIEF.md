# Brief: Hemi x402 facilitator MVP

> **Kept for the record.** This is the brief the project was built from, unchanged apart from this note. "The session", "lead agent", "sub-agent" and "critic" refer to the AI-assisted working sessions that built it. What exists now is described in the [README](../README.md), and how each item was decided in [DECISIONS.md](../DECISIONS.md).

Build and run an x402 v2 facilitator that verifies and settles payments on Hemi (eip155:43111 and eip155:743111) in USDC.e and hemiBTC, so any x402-aware agent can pay a Hemi endpoint. Deliverable: a deployable facilitator, the on-chain contracts it needs, a demo seller and buyer, and a /supported response that lists Hemi.

Out of scope for the MVP: verifying Bitcoin L1 payments through hBK (phase 2, below); the upto and deferred schemes; a hosted production deployment; any token other than USDC.e and hemiBTC; a UI.

## Why this is config, not a rewrite

x402 registers networks dynamically, so any eip155:<chainId> works at the protocol level and the only missing piece is a facilitator that supports it (x402 network support). The community Rust facilitator, x402-rs, takes a config.json keyed by CAIP-2 chain id with RPC list and signer, ships as a Docker image, and already implements both EVM transfer methods: EIP-3009 and Permit2 via an X402ExactPermit2Proxy contract, plus EIP-2612 gas sponsoring and EIP-1271/6492 smart-wallet signatures (x402-rs, x402-chain-eip155). Start from it; fall back to the TypeScript facilitator in x402-foundation/x402 only if the Rust config cannot express what Hemi needs.

> Note (2026-10-28): see DECISIONS.md P-1. Permit2 and the exact proxy addresses are compile-time constants in x402-rs and the TS SDK, not config.

## Spike (first hour, before any code)

Settle the transfer method with three checks on mainnet and testnet:

1. Does USDC.e implement EIP-3009 transferWithAuthorization? Call the selector with cast; a revert with a non-selector error means yes, an empty revert or missing function means no. If yes, the exact scheme with eip3009 works unchanged and the spike is over.
2. If no: is Permit2 at the canonical 0x000000000022D473030F116dDEE9F6B43aC78BA3? cast code non-empty means deployed. If empty, check whether the deterministic deployer 0x4e59b44847b379578588920cA78FbF26c0B4956C exists; if it does, Permit2 can be deployed to the canonical address with Uniswap's salt, otherwise deploy to a non-canonical address and record it in config (several networks run non-canonical Permit2 and SDKs read it from config, per LI.FI's Permit2 notes).
3. Does USDC.e implement EIP-2612 permit? If yes, the facilitator's gas-sponsoring extension lets a buyer approve Permit2 by signature only, so the agent never needs ETH on Hemi. If no, the buyer needs one on-chain approve(Permit2) and the README must say so.

hemiBTC is assumed to support neither standard; it goes through Permit2 regardless. Write the spike's result as the first entry in the repo's DECISIONS.md before building.

> Note (2026-10-28): DECISIONS.md has a revised six-check list that adds the deterministic deployer, the exact proxy address and a stricter EIP-2612 test.

## Architecture (MVP)

1. facilitator/ — x402-rs with a config.json holding both Hemi chains, dRPC primary and public RPC fallback, signer key from env, Permit2 and proxy addresses from the spike. Exposes /verify, /settle, /supported.
2. contracts/ — Foundry project: X402ExactPermit2Proxy (taken from the x402 reference, not rewritten) and, only if the spike needs it, Permit2. Deploy scripts for testnet then mainnet, with verification on the Hemi explorer.
3. seller/ — a minimal paid endpoint (GET /echo, price $0.001) using the x402 TypeScript server SDK pointed at the local facilitator, advertising both USDC.e and hemiBTC as accepted assets on Hemi.
4. buyer/ — a script using @x402/fetch that pays the seller from a testnet wallet in each asset and prints the settlement tx hash.
5. sdk-patch/ — the client-side network table additions (chain id, viem chain object, default asset) as a patch against x402-foundation/x402, kept as a draft upstream PR so dollar-string pricing works for Hemi out of the box.

## Definition of done

A fresh-context critic passes all of these from the README alone:

- [ ] docker compose up starts the facilitator; GET /supported lists eip155:743111 and eip155:43111 with scheme exact and both transfer methods actually available after the spike
- [ ] One successful /verify then /settle on testnet in USDC.e, with the tx hash linked on testnet.explorer.hemi.xyz
- [ ] One successful settle on testnet in hemiBTC (or the testnet tunnel's BTC representation if hemiBTC has no testnet deployment, recorded in DECISIONS.md)
- [ ] A failed-signature and an insufficient-balance case both return the spec's error shapes, covered by tests
- [ ] Facilitator never holds funds: settlement is signature-authorized transfer only, confirmed by reading the proxy and config, not by assertion
- [ ] RPC failover works: tests pass with the primary RPC URL pointed at a dead port
- [ ] README covers: spike result, addresses per network, how a buyer approves Permit2 (or doesn't), how a seller points at this facilitator, mainnet deployment steps and the mainnet tx hash if one was run
- [ ] DECISIONS.md has an entry for every verify-first item from the Shared context, with the command run and its output

## How to run the session

Repo hemi-x402-facilitator, branch feat/facilitator-mvp. Lead agent plans; one sub-agent on contracts, one on facilitator config and tests, one on seller/buyer; a separate fresh-context critic runs the Definition of done from the README only and reports failures as issues. Loop until the critic passes twice in a row. No mainnet transactions without an explicit go from Dimitry; testnet is unrestricted.

## Phase 2 (not now)

A custom scheme in which the agent pays BTC on Bitcoin L1 to a seller-owned address and the facilitator verifies the UTXO through hBK inside a Hemi contract. This is the part no other facilitator can do; it needs the MVP's plumbing first and a design pass on confirmation depth versus PoP finality.

---

# Shared context: Hemi

Hemi is an EVM L2 (gas in ETH, EIP-1559) whose hVM embeds a full indexed Bitcoin node, so contracts read Bitcoin UTXOs, balances and headers through the Hemi Bitcoin Kit (hBK) with no relayer. Proof-of-Proof anchors Hemi state to Bitcoin; finality is measured in hours, not seconds. Verified values below come from docs.hemi.xyz; everything marked verify must be checked on the explorer before use.

| Item | Mainnet | Testnet | Status |
|------|---------|---------|--------|
| Chain ID | 43111 | 743111 | verified |
| CAIP-2 id (x402 network) | eip155:43111 | eip155:743111 | derived from chain ID |
| Public RPC (~300 req/min) | https://rpc.hemi.network/rpc | https://testnet.rpc.hemi.network/rpc | verified |
| dRPC (free tier) | https://hemi.drpc.org | https://hemi-testnet.drpc.org | verified |
| Infura/DIN | https://hemi-mainnet.infura.io/v3/KEY | https://hemi-testnet.infura.io/v3/KEY | verified |
| Explorer | https://explorer.hemi.xyz | https://testnet.explorer.hemi.xyz | verified |
| Testnet faucet / tunnel | — | https://app.hemi.xyz/en/tunnel/?networkType=testnet | verified |
| USDC.e (Stargate-bridged) address | take from explorer token list | take from explorer | verify |
| hemiBTC address on Hemi | take from explorer token list | take from explorer | verify |
| USDC.e implements EIP-3009? | call transferWithAuthorization selector via cast | same | verify — decides the scheme |
| USDC.e implements EIP-2612 permit? | cast call <token> "DOMAIN_SEPARATOR()" | same | verify |
| Permit2 at canonical 0x000000000022D473030F116dDEE9F6B43aC78BA3? | cast code on mainnet; non-empty = deployed | same | verify |
| hBK precompile addresses and ABI | docs.hemi.xyz hBK | same | verify against docs |

Do not take token addresses from CoinGecko, DexPaprika or similar aggregators; the explorer or the Hemi tunnel UI is the source. A verification command that fails is a finding, not a blocker: record it in Open questions and continue with testnet.

Two operational facts to design around: Hemi had a mainnet outage on 1 June 2026 and is mid-way through a Rust-based node rewrite, so clients retry with backoff and treat a stalled RPC as expected; and any asset hop to Ethereum costs Ethereum gas, so everything here settles on Hemi and only reads Bitcoin.
