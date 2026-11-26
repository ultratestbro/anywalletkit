// TOOLING-5 (0.5.0 review): watch.json watches the code of the five v4 contracts on the swap path on every pinned
// chain, and every PoolManager's owner() and protocolFeeController(). Nothing tied those sources to UNISWAP_V4: a pin
// changed or a chain added in src/v4/addresses.ts without a watch.json edit would leave the watch reading the old
// addresses, CI green (json-pins only checks that Uniswap's deployments.json still lists the pins). This is the drift
// guard: one evm-code source per (chain, role) at the pinned address, exactly the two evm-call sources per PoolManager,
// and no v4 code or call source pointing anywhere else. Permit2 and the PositionManager are on no flow: not watched.
import {readFileSync} from "node:fs";
import {describe, expect, it} from "vitest";
import {getAddress} from "viem";
import {UNISWAP_V4} from "../src/v4/addresses.js";

interface Source {id: string; type: string; chainId?: number; address?: string; to?: string; signature?: string}
const manifest = JSON.parse(readFileSync(new URL("../watch.json", import.meta.url), "utf8")) as {sources: Source[]};
const ROLES = ["poolManager", "quoter", "stateView", "universalRouter", "swapProxy"] as const;
const chains = Object.keys(UNISWAP_V4).map(Number);
const v4Code = manifest.sources.filter((s) => s.type === "evm-code" && s.id.startsWith("v4-"));
const v4Calls = manifest.sources.filter((s) => s.type === "evm-call" && s.id.startsWith("v4-"));

describe("TOOLING-5: watch.json's v4 code and call sources match UNISWAP_V4", () => {
  it("one evm-code source per pinned chain and role, at the pinned address", () => {
    expect(chains.length).toBe(19);
    for (const id of chains) {
      const d = UNISWAP_V4[id]!;
      for (const role of ROLES) {
        const at = getAddress(d[role]);
        const hits = v4Code.filter((s) => s.chainId === id && s.address !== undefined && getAddress(s.address) === at);
        expect([id, role, hits.length]).toEqual([id, role, 1]);
      }
    }
    expect(v4Code).toHaveLength(chains.length * ROLES.length);
  });

  it("every v4 evm-code source points at a contract pinned on its chain (no stale address left behind)", () => {
    for (const s of v4Code) {
      const d = UNISWAP_V4[s.chainId!];
      expect([s.id, d !== undefined]).toEqual([s.id, true]);
      expect([s.id, ROLES.some((r) => getAddress(d![r]) === getAddress(s.address!))]).toEqual([s.id, true]);
    }
  });

  it("each PoolManager has exactly owner() and protocolFeeController() watched, and no v4 call source reads anything else", () => {
    for (const id of chains) {
      const pm = getAddress(UNISWAP_V4[id]!.poolManager);
      const calls = v4Calls.filter((s) => s.chainId === id && s.to !== undefined && getAddress(s.to) === pm).map((s) => s.signature).sort();
      expect([id, calls]).toEqual([id, ["owner()", "protocolFeeController()"]]);
    }
    expect(v4Calls).toHaveLength(chains.length * 2);
  });
});
