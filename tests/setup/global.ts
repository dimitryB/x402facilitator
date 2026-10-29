/**
 * Global setup: two anvil forks (scripts/fork.sh) and the facilitator from docker-compose.yml (x402-rs plus
 * facilitator/x402-rs/patches, built locally) with both primary RPCs pointed at a dead port. Torn down
 * afterwards unless KEEP_STACK=1.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { join } from "node:path";
import { MAINNET, TESTNET } from "@hemi-x402/shared";
import { compose, run, waitForSupported } from "../lib/compose";
import {
  COMPOSE_ENV_FILE,
  COMPOSE_VARS,
  FACILITATOR_PORT,
  FACILITATOR_URL,
  FORK_PORT,
  FORK_RPC,
  OBSERVED_FILE,
  REPO_ROOT,
  STATE_DIR,
  forkEnv,
} from "../lib/env";

const FORK_SH = join(REPO_ROOT, "scripts", "fork.sh");
const log = (msg: string) => console.log(`[e2e setup] ${msg}`);

function portInUse(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => (socket.destroy(), resolve(true)));
    socket.once("error", () => resolve(false));
  });
}

/** Stop forks left by an earlier run of this suite, but only if the recorded pid is still anvil. */
function stopStaleForks(): void {
  for (const name of ["testnet", "mainnet"]) {
    const pidFile = join(STATE_DIR, `${name}.pid`);
    if (!existsSync(pidFile)) continue;
    const pid = readFileSync(pidFile, "utf8").trim();
    const comm = spawnSync("ps", ["-p", pid, "-o", "comm="], { encoding: "utf8" }).stdout.trim();
    if (!comm.endsWith("anvil")) {
      log(`removing stale ${pidFile} (pid ${pid} is not anvil)`);
      rmSync(pidFile);
    }
  }
  run(FORK_SH, ["down"], forkEnv(), 30_000);
}

async function rpc(url: string, method: string, params: unknown[]): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  if (body.error) throw new Error(`${method} on ${url}: ${JSON.stringify(body.error)}`);
  return body.result;
}

export default async function setup(): Promise<() => Promise<void>> {
  mkdirSync(STATE_DIR, { recursive: true });
  rmSync(OBSERVED_FILE, { force: true });
  writeFileSync(
    COMPOSE_ENV_FILE,
    "# Written by tests/setup/global.ts. anvil dev keys only (public test keys, local forks only).\n" +
      Object.entries(COMPOSE_VARS)
        .map(([k, v]) => `${k}=${v}`)
        .join("\n") +
      "\n",
  );

  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 20_000 });
  } catch {
    throw new Error("docker is not reachable; start Colima (`colima start`) first");
  }

  // Leftovers from an earlier, interrupted run of this suite (same compose project, same state dir).
  compose(["down", "--remove-orphans"]);
  stopStaleForks();
  for (const port of [FORK_PORT[TESTNET], FORK_PORT[MAINNET], FACILITATOR_PORT]) {
    if (await portInUse(port)) {
      throw new Error(`port ${port} is in use by something this suite did not start; free it and rerun`);
    }
  }

  const teardown = async () => {
    if (process.env.KEEP_STACK === "1") {
      log(`KEEP_STACK=1: leaving forks on :${FORK_PORT[TESTNET]}/:${FORK_PORT[MAINNET]} and the facilitator on :${FACILITATOR_PORT}`);
      return;
    }
    log("tearing down");
    try {
      compose(["down", "--remove-orphans"]);
    } finally {
      run(FORK_SH, ["down"], forkEnv(), 30_000);
    }
  };

  try {
    log("starting forks (scripts/fork.sh up)");
    run(FORK_SH, ["up"], forkEnv(), 600_000);

    // anvil continues from the pinned block's timestamp, which falls further behind the wall
    // clock every day. Payments are signed and checked against the wall clock, so move each
    // fork's clock to now; anvil then keeps following the wall clock.
    const now = Math.floor(Date.now() / 1000);
    for (const url of [FORK_RPC[TESTNET], FORK_RPC[MAINNET]]) {
      await rpc(url, "evm_setNextBlockTimestamp", [now]);
      await rpc(url, "evm_mine", []);
    }

    // The patched x402-rs image (facilitator/Dockerfile). A no-op when the layer cache is current;
    // the first build compiles x402-rs and takes several minutes.
    log("building the facilitator image (docker compose build)");
    compose(["build"], { timeoutMs: 3_600_000 });
    log("starting facilitator (docker compose, dead primary RPCs)");
    compose(["up", "-d", "--force-recreate", "--no-build"], { timeoutMs: 300_000 });
    await waitForSupported(120_000);
    log(`facilitator ready on ${FACILITATOR_URL}`);
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
