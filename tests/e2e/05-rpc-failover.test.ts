/**
 * DoD: "RPC failover works: tests pass with the primary RPC URL pointed at a dead port".
 *
 * The global setup starts the facilitator with HEMI_*_RPC_PRIMARY=http://127.0.0.1:1 (inside the
 * container nothing listens there) and the fallbacks on the forks, so every earlier test in this run
 * already went through the fallback. This file proves the running container really has that config
 * and was never restarted, then makes fresh verify and settle calls while the primary stays dead.
 *
 * x402-rs wraps the configured RPCs in alloy's FallbackLayer with active_transport_count equal to the
 * number of RPCs (chain/provider.rs, rpc_client): each request is sent to all of them in parallel and
 * the first success wins, so a dead primary costs nothing but a failed sample in alloy's ranking.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";
import { btcAsset, MAINNET, TESTNET, usdcAsset, type HemiNetwork } from "@hemi-x402/shared";
import { ensurePermit2Approval, tokenBalance } from "../lib/chain";
import {
  BUYER_KEY,
  COMPOSE_ARGS,
  COMPOSE_VARS,
  CONTAINER_FALLBACK_RPC,
  DEAD_PRIMARY_RPC,
  REPO_ROOT,
} from "../lib/env";
import { record, settle, verify } from "../lib/facilitator";
import { freshAddress, requirementsFor, signPayment } from "../lib/payments";

const ENV_NAME: Record<HemiNetwork, { primary: string; fallback: string }> = {
  "eip155:743111": { primary: "HEMI_TESTNET_RPC_PRIMARY", fallback: "HEMI_TESTNET_RPC_FALLBACK" },
  "eip155:43111": { primary: "HEMI_MAINNET_RPC_PRIMARY", fallback: "HEMI_MAINNET_RPC_FALLBACK" },
};

function docker(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8", env: { ...process.env, ...COMPOSE_VARS } });
}
const composeExec = (...cmd: string[]) => docker([...COMPOSE_ARGS, "exec", "-T", "facilitator", ...cmd]);

describe("RPC failover: the facilitator runs with dead primary RPCs", () => {
  it("the container's resolved env has the dead primaries and the fork fallbacks", () => {
    const env = Object.fromEntries(
      composeExec("env")
        .trim()
        .split("\n")
        .map(line => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
    );
    for (const network of [TESTNET, MAINNET]) {
      expect(env[ENV_NAME[network].primary]).toBe(DEAD_PRIMARY_RPC);
      expect(env[ENV_NAME[network].fallback]).toBe(CONTAINER_FALLBACK_RPC[network]);
    }
  });

  it("the mounted config is the repo's facilitator/config.json, primary first", () => {
    const mounted = composeExec("cat", "/app/config.json");
    expect(mounted).toBe(readFileSync(join(REPO_ROOT, "facilitator", "config.json"), "utf8"));
    const config = JSON.parse(mounted) as { chains: Record<string, { rpc: { http: string }[] }> };
    for (const network of [TESTNET, MAINNET]) {
      expect(config.chains[network]!.rpc.map(r => r.http)).toEqual([
        `$${ENV_NAME[network].primary}`,
        `$${ENV_NAME[network].fallback}`,
      ]);
    }
  });

  it("from inside the container the primary refuses connections and the fallback accepts them", () => {
    const probe = (host: string, port: number) =>
      composeExec("bash", "-c", `timeout 5 bash -c 'exec 3<>/dev/tcp/${host}/${port}' 2>/dev/null && echo open || echo closed`).trim();
    const dead = new URL(DEAD_PRIMARY_RPC);
    expect(probe(dead.hostname, Number(dead.port))).toBe("closed");
    for (const network of [TESTNET, MAINNET]) {
      const fallback = new URL(CONTAINER_FALLBACK_RPC[network]);
      expect(probe(fallback.hostname, Number(fallback.port))).toBe("open");
    }
  });

  it("x402-rs resolved those URLs at startup, and the container has not restarted since", () => {
    const logs = docker([...COMPOSE_ARGS, "logs", "--no-color", "facilitator"]).replace(/\x1b\[[0-9;]*m/g, "");
    for (const network of [TESTNET, MAINNET]) {
      expect(logs).toContain(`Using HTTP transport chain=${network} rpc_url=${DEAD_PRIMARY_RPC}/`);
      expect(logs).toContain(`Using HTTP transport chain=${network} rpc_url=${CONTAINER_FALLBACK_RPC[network]}/`);
    }
    expect(logs.match(/Starting server at/g)).toHaveLength(1);
    const id = docker([...COMPOSE_ARGS, "ps", "-q", "facilitator"]).trim();
    const state = JSON.parse(docker(["inspect", "--format", "{{json .State}}", id])) as { Running: boolean; Restarting: boolean };
    expect(state.Running).toBe(true);
    expect(docker(["inspect", "--format", "{{.RestartCount}}", id]).trim()).toBe("0");
    // And it is the locally built, patched image that docker-compose.yml names.
    const composeFile = readFileSync(join(REPO_ROOT, "docker-compose.yml"), "utf8");
    const image = /^\s*image:\s*(\S+)\s*$/m.exec(composeFile)?.[1];
    expect(image).toMatch(/^hemi-x402-facilitator:/);
    expect(docker(["inspect", "--format", "{{.Config.Image}}", id]).trim()).toBe(image);
  });

  it("verify and settle still work on both networks with the primary dead", async () => {
    const buyer = privateKeyToAccount(BUYER_KEY);
    const cases = [
      { network: MAINNET, asset: usdcAsset(MAINNET), amount: 1_000n }, // reads + EIP-3009 write path
      { network: TESTNET, asset: btcAsset(TESTNET), amount: 10n }, // reads + Permit2 write path
    ];
    for (const c of cases) {
      if (c.asset.transferMethod === "permit2") await ensurePermit2Approval(c.network, buyer, c.asset, c.amount);
      const payTo = freshAddress();
      const requirements = requirementsFor(c.network, c.asset, payTo, c.amount);
      const payment = await signPayment(buyer, requirements);

      const v = await verify(payment, requirements);
      record(`failover verify ${c.network}`, v);
      expect(v.body).toEqual({ isValid: true, payer: buyer.address });

      const s = await settle(payment, requirements);
      record(`failover settle ${c.network}`, s);
      expect(s.body).toMatchObject({ success: true, network: c.network });
      expect(await tokenBalance(c.network, c.asset, payTo)).toBe(c.amount);
    }
  });
});
