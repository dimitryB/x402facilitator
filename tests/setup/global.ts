/**
 * Global setup: two anvil forks (scripts/fork.sh) and the facilitator from docker-compose.yml (x402-rs plus
 * facilitator/x402-rs/patches, built locally) with both primary RPCs pointed at a dead port. Torn down
 * afterwards unless KEEP_STACK=1.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { homedir } from "node:os";
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

/**
 * Colima publishes a container's port on the host through an ssh port forward that its Lima agent adds
 * and removes. On this workstation that agent's `ssh -O forward` / `-O cancel` calls fail now and then
 * (exit 255), which leaves either no forward (the facilitator is unreachable although the container
 * runs) or a stale one (the port guard below trips after the container is gone). Both were hit while
 * integrating phase 2 (docs/phase2/ts.md, TS-17). The same forward can be added or cancelled through the
 * mux socket by hand; this does that, only when the socket exists, and logs it. Off with E2E_NO_COLIMA_FIX=1.
 */
const COLIMA_SOCK = join(homedir(), ".colima", "_lima", "colima", "ssh.sock");
function colimaFixEnabled(): boolean {
  return process.env.E2E_NO_COLIMA_FIX !== "1" && existsSync(COLIMA_SOCK);
}
function colimaForward(action: "forward" | "cancel", port: number): boolean {
  const spec = `127.0.0.1:${port}:127.0.0.1:${port}`;
  const r = spawnSync("ssh", ["-S", COLIMA_SOCK, "-O", action, "-L", spec, "lima-colima"], { encoding: "utf8", timeout: 15_000 });
  log(`colima: ssh -O ${action} -L ${spec}: ${r.status === 0 ? "ok" : `exit ${r.status} ${(r.stderr ?? "").trim()}`}`);
  return r.status === 0;
}
/** True when the listener on `port` is Colima's ssh mux (a forward with no container behind it). */
function heldByColimaMux(port: number): boolean {
  const pids = spawnSync("lsof", ["-t", "-nP", `-iTCP:${port}`, "-sTCP:LISTEN"], { encoding: "utf8" }).stdout.trim().split(/\s+/).filter(Boolean);
  return pids.length > 0 && pids.every(pid => spawnSync("ps", ["-o", "args=", "-p", pid], { encoding: "utf8" }).stdout.includes(".colima/_lima/colima/ssh.sock"));
}

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
      if (port === FACILITATOR_PORT && colimaFixEnabled() && heldByColimaMux(port)) {
        log(`port ${port} is held by a stale Colima forward with no container behind it; cancelling it`);
        colimaForward("cancel", port);
        if (!(await portInUse(port))) continue;
      }
      throw new Error(`port ${port} is in use by something this suite did not start; free it and rerun`);
    }
  }

  let addedColimaForward = false;
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
      // Lima's own cancel may fail too; a forward left behind would trip the next run's port guard.
      if (colimaFixEnabled() && (addedColimaForward || heldByColimaMux(FACILITATOR_PORT))) colimaForward("cancel", FACILITATOR_PORT);
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

    // fork.sh deployed X402BtcSettler on each fork (phase 2); the facilitator learns the addresses
    // through X402_BTC_SETTLER_{TESTNET,MAINNET}. Without the file the bip122 chains stay off.
    const settlersEnv = join(STATE_DIR, "btc-settlers.env");
    if (existsSync(settlersEnv)) {
      const lines = readFileSync(settlersEnv, "utf8").trim();
      writeFileSync(COMPOSE_ENV_FILE, `# From scripts/fork.sh (btc-settlers.env)\n${lines}\n`, { flag: "a" });
      log(`Bitcoin settlers on the forks: ${lines.replace(/\n/g, " ")}`);
    } else {
      log("no btc-settlers.env from fork.sh: the bip122 chains stay off");
    }

    // The patched x402-rs image (facilitator/Dockerfile). A no-op when the layer cache is current;
    // the first build compiles x402-rs and takes several minutes.
    log("building the facilitator image (docker compose build)");
    compose(["build"], { timeoutMs: 3_600_000 });
    log("starting facilitator (docker compose, dead primary RPCs)");
    compose(["up", "-d", "--force-recreate", "--no-build"], { timeoutMs: 300_000 });
    try {
      await waitForSupported(colimaFixEnabled() ? 25_000 : 120_000);
    } catch (error) {
      if (!colimaFixEnabled()) throw error;
      log(`facilitator not reachable on :${FACILITATOR_PORT} after compose up; adding Colima's port forward by hand`);
      colimaForward("forward", FACILITATOR_PORT);
      addedColimaForward = true;
      await waitForSupported(95_000);
    }
    log(`facilitator ready on ${FACILITATOR_URL}`);
  } catch (e) {
    await teardown();
    throw e;
  }
  return teardown;
}
