// Scan 2026-10-27 (modules), F8/F16: the addresses this provider's EVM swaps call and approve, shipped for
// `remoteProvider({...uniswapPins})` so the app checks a backend's build against them, never against the build itself.
import {describe, expect, it} from "vitest";
import {UNISWAP_V3, uniswapPins} from "../src/addresses.js";
import {UNISWAP_V4} from "../src/v4/addresses.js";

describe("uniswap pins (scan 2026-10-27 modules)", () => {
  it("pin the contract the provider uses on each chain, and nothing where it has no EVM route", () => {
    // 0.5.0: SwapRouter02, then the Universal Router 2.1.2 where v4 quotes a native input (U1) and the chain's SwapProxy
    // where it quotes a token input (U2); spenders are SwapRouter02 and the SwapProxy — never the router or Permit2.
    expect(uniswapPins.callTargets("eip155:8453")).toEqual([UNISWAP_V3[8453]!.router, UNISWAP_V4[8453]!.universalRouter, UNISWAP_V4[8453]!.swapProxy]);
    expect(uniswapPins.spenders("eip155:1")).toEqual([UNISWAP_V3[1]!.router, UNISWAP_V4[1]!.swapProxy]);
    // A v4-only chain (MegaETH): no SwapRouter02; HyperEVM (pinned, not quotable): nothing; zkSync (no v4): v3 only.
    expect(uniswapPins.spenders("eip155:4326")).toEqual([UNISWAP_V4[4326]!.swapProxy]);
    expect(uniswapPins.callTargets("eip155:999")).toEqual([]);
    expect(uniswapPins.callTargets("eip155:324")).toEqual([UNISWAP_V3[324]!.router]);
    // Celo and Arc ship lists (LIVE-2), token → token only: their native coin is an ERC-20, so the SwapProxy and never
    // the Universal Router (native input is refused there).
    expect(uniswapPins.callTargets("eip155:42220")).toEqual([UNISWAP_V3[42220]!.router, UNISWAP_V4[42220]!.swapProxy]);
    expect(uniswapPins.spenders("eip155:42220")).toEqual([UNISWAP_V3[42220]!.router, UNISWAP_V4[42220]!.swapProxy]);
    expect(uniswapPins.callTargets("eip155:5042")).toEqual([UNISWAP_V4[5042]!.swapProxy]);
    // X Layer, World Chain, Robinhood Chain, Ink: v3 and both v4 flows.
    for (const id of [196, 480, 4663, 57073]) expect(uniswapPins.callTargets(`eip155:${id}`), String(id)).toEqual([UNISWAP_V3[id]!.router, UNISWAP_V4[id]!.universalRouter, UNISWAP_V4[id]!.swapProxy]);
    expect(uniswapPins.callTargets("eip155:999999")).toEqual([]);
    expect(uniswapPins.spenders("ton:-239")).toEqual([]);
  });
});
