/**
 * Fixed settings for the end-to-end suite. Everything here runs against local anvil forks;
 * nothing in this suite sends a transaction to a live network.
 *
 * Keys are anvil's well-known dev keys. They are public test keys (printed by every `anvil`
 * start) and only ever sign on the local forks.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Address, Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { MAINNET, TESTNET, type HemiNetwork } from "@hemi-x402/shared";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
/** Git-ignored. Colima only shares $HOME with containers, so nothing mounted may live in /tmp. */
export const STATE_DIR = join(REPO_ROOT, ".scratch", "fork-tests");
export const OBSERVED_FILE = join(STATE_DIR, "observed-responses.jsonl");
export const COMPOSE_ENV_FILE = join(STATE_DIR, "compose.env");

/**
 * Two checkouts (worktrees) can run the suite at the same time if one sets E2E_PORT_OFFSET: it moves the
 * facilitator and both forks to 38080/38545/38546 + offset and names the compose project
 * hemi-x402-tests-<offset>, so neither run tears down the other's stack. Unset, everything is as before.
 */
const PORT_OFFSET = Number(process.env.E2E_PORT_OFFSET ?? 0);
if (!Number.isInteger(PORT_OFFSET) || PORT_OFFSET < 0 || PORT_OFFSET > 1000) {
  throw new Error(`E2E_PORT_OFFSET must be an integer from 0 to 1000, got ${process.env.E2E_PORT_OFFSET}`);
}
export const COMPOSE_PROJECT = PORT_OFFSET ? `hemi-x402-tests-${PORT_OFFSET}` : "hemi-x402-tests";
export const FACILITATOR_PORT = 38080 + PORT_OFFSET;
export const FACILITATOR_URL = `http://127.0.0.1:${FACILITATOR_PORT}`;

export const FORK_PORT: Record<HemiNetwork, number> = { "eip155:743111": 38545 + PORT_OFFSET, "eip155:43111": 38546 + PORT_OFFSET };
export const FORK_RPC: Record<HemiNetwork, string> = {
  "eip155:743111": `http://127.0.0.1:${FORK_PORT[TESTNET]}`,
  "eip155:43111": `http://127.0.0.1:${FORK_PORT[MAINNET]}`,
};

/**
 * Fork heights, pinned so every run starts from the same chain state (both are 2026-10-29).
 * Override with FORK_BLOCK_TESTNET / FORK_BLOCK_MAINNET.
 */
export const FORK_BLOCK: Record<HemiNetwork, number> = {
  "eip155:743111": Number(process.env.FORK_BLOCK_TESTNET ?? 7094000),
  "eip155:43111": Number(process.env.FORK_BLOCK_MAINNET ?? 5614300),
};

/**
 * RPC URLs as the facilitator container sees them. The primaries point at a port nothing
 * listens on (inside the container), so every request must be served by the fallback:
 * this is the Definition of done's "RPC failover" condition, and the whole suite runs under it.
 */
export const DEAD_PRIMARY_RPC = "http://127.0.0.1:1";
export const CONTAINER_FALLBACK_RPC: Record<HemiNetwork, string> = {
  "eip155:743111": `http://host.docker.internal:${FORK_PORT[TESTNET]}`,
  "eip155:43111": `http://host.docker.internal:${FORK_PORT[MAINNET]}`,
};

// anvil dev accounts. #0 deploys the canonical contracts in scripts/fork.sh.
export const FACILITATOR_KEY: Record<HemiNetwork, Hex> = {
  // anvil #1, 0x70997970C51812dc3A010C7d01b50e0d17dc79C8
  "eip155:743111": "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
  // anvil #2, 0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC
  "eip155:43111": "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
};
export const FACILITATOR_SIGNER: Record<HemiNetwork, Address> = {
  "eip155:743111": privateKeyToAccount(FACILITATOR_KEY[TESTNET]).address,
  "eip155:43111": privateKeyToAccount(FACILITATOR_KEY[MAINNET]).address,
};
/** anvil #3, funded by scripts/fork.sh with 10 ETH and 1000 units of every token. */
export const BUYER_KEY: Hex = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";

/** Environment for scripts/fork.sh. Upstreams can still be overridden from the caller's env. */
export function forkEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    FORK_TESTNET_PORT: String(FORK_PORT[TESTNET]),
    FORK_MAINNET_PORT: String(FORK_PORT[MAINNET]),
    FORK_STATE_DIR: STATE_DIR,
    FORK_BLOCK_TESTNET: String(FORK_BLOCK[TESTNET]),
    FORK_BLOCK_MAINNET: String(FORK_BLOCK[MAINNET]),
    FORK_BUYER: privateKeyToAccount(BUYER_KEY).address,
    // X402BtcSettler on each fork lets only this address settle (phase 2).
    FORK_FACILITATOR_TESTNET: FACILITATOR_SIGNER[TESTNET],
    FORK_FACILITATOR_MAINNET: FACILITATOR_SIGNER[MAINNET],
  };
}

/** Every variable docker-compose.yml interpolates, so neither the repo's .env nor the caller's env leaks in. */
export const COMPOSE_VARS: Record<string, string> = {
  FACILITATOR_BIND: "127.0.0.1",
  FACILITATOR_PORT: String(FACILITATOR_PORT),
  FACILITATOR_CONFIG: "config.json",
  RUST_LOG: "info",
  FACILITATOR_TESTNET_PRIVATE_KEY: FACILITATOR_KEY[TESTNET],
  FACILITATOR_MAINNET_PRIVATE_KEY: FACILITATOR_KEY[MAINNET],
  HEMI_TESTNET_RPC_PRIMARY: DEAD_PRIMARY_RPC,
  HEMI_TESTNET_RPC_FALLBACK: CONTAINER_FALLBACK_RPC[TESTNET],
  HEMI_MAINNET_RPC_PRIMARY: DEAD_PRIMARY_RPC,
  HEMI_MAINNET_RPC_FALLBACK: CONTAINER_FALLBACK_RPC[MAINNET],
};

/** `docker compose` argv prefix for this suite's project. */
export const COMPOSE_ARGS = [
  "compose",
  "-p",
  COMPOSE_PROJECT,
  "--project-directory",
  REPO_ROOT,
  "-f",
  join(REPO_ROOT, "docker-compose.yml"),
  "--env-file",
  COMPOSE_ENV_FILE,
];
