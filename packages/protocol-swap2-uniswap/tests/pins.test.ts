// Scan 2026-10-27 (modules), F8/F16: the addresses this provider's EVM swaps call and approve, shipped for
// `remoteProvider({...uniswapPins})` so the app checks a backend's build against them, never against the build itself.
import {describe, expect, it} from "vitest";
import {UNISWAP_V3, uniswapPins} from "../src/addresses.js";
import {UNISWAP_V4} from "../src/v4/addresses.js";

describe("uniswap pins (scan 2026-10-27 modules)", () => {
  it("pin the contract the provider uses on each chain, and nothing where it has no EVM route", () => {
    // 0.5.0 (U1): SwapRouter02, then the Universal Router 2.1.2 where v4 quotes a native input; neither is anything else.
    expect(uniswapPins.callTargets("eip155:8453")).toEqual([UNISWAP_V3[8453]!.router, UNISWAP_V4[8453]!.universalRouter]);
    expect(uniswapPins.spenders("eip155:1")).toEqual([UNISWAP_V3[1]!.router]);
    expect(uniswapPins.callTargets("eip155:999999")).toEqual([]);
    expect(uniswapPins.spenders("ton:-239")).toEqual([]);
  });
});
