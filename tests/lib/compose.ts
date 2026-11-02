/** docker compose for this suite's project (hemi-x402-tests), shared by the global setup and tests. */
import { execFileSync, spawnSync } from "node:child_process";
import { MAINNET, TESTNET } from "@hemi-x402/shared";
import { COMPOSE_ARGS, COMPOSE_VARS, FACILITATOR_URL, REPO_ROOT } from "./env";

export function run(cmd: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): void {
  const res = spawnSync(cmd, args, { cwd: REPO_ROOT, env, stdio: "inherit", timeout: timeoutMs });
  if (res.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (status ${res.status}, signal ${res.signal}, ${res.error ?? ""})`);
  }
}

/**
 * The env file stops compose from reading the repo's .env; the process env wins over both, so every
 * variable is set there too in case the caller's shell exports one of them. `overrides` win over all.
 */
export function composeEnv(overrides: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { ...process.env, ...COMPOSE_VARS, ...overrides };
}

export function compose(args: string[], options: { env?: Record<string, string>; timeoutMs?: number } = {}): void {
  run("docker", [...COMPOSE_ARGS, ...args], composeEnv(options.env), options.timeoutMs ?? 120_000);
}

/** Run a compose command and return its stdout (for `exec`, `ps`, `logs`). */
export function composeOutput(args: string[], env: Record<string, string> = {}): string {
  return execFileSync("docker", [...COMPOSE_ARGS, ...args], { encoding: "utf8", env: composeEnv(env) });
}

/** Wait until /supported lists both Hemi networks; on timeout, print the container log and throw. */
export async function waitForSupported(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${FACILITATOR_URL}/supported`);
      last = await res.text();
      const networks = (JSON.parse(last).kinds ?? []).map((k: { network: string }) => k.network);
      if (res.ok && networks.includes(TESTNET) && networks.includes(MAINNET)) return;
    } catch (e) {
      last = String(e);
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  spawnSync("docker", [...COMPOSE_ARGS, "logs", "--no-color", "--tail", "50"], { env: composeEnv(), stdio: "inherit" });
  throw new Error(`facilitator did not list both Hemi networks on /supported within ${timeoutMs} ms: ${last}`);
}

/** (Re)create the facilitator container, optionally with other compose variables, and wait for it. */
export async function restartFacilitator(env: Record<string, string> = {}): Promise<void> {
  compose(["up", "-d", "--force-recreate", "--no-build"], { env, timeoutMs: 300_000 });
  await waitForSupported(120_000);
}
