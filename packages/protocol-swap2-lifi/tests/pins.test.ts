// Scan 2026-10-27 (modules), F8/F16: the addresses this provider's EVM swaps call and approve, shipped for
// `remoteProvider({...lifiPins})` so the app checks a backend's build against them, never against the build itself.
import {describe, expect, it} from "vitest";
import {lifiPins} from "../src/provider.js";

describe("lifi pins (scan 2026-10-27 modules)", () => {
  it("pin the contract the provider uses on each chain, and nothing where it has no EVM route", () => {
    expect(lifiPins.callTargets("eip155:1")).toEqual(["0x1231DEB6f5749EF6cE6943a275A1D3E7486F4EaE"]);
    // A chain with its own Diamond pins that one only.
    expect(lifiPins.spenders("eip155:324")).toEqual(["0x341e94069f53234fE6DabeF707aD424830525715"]);
    expect(lifiPins.callTargets("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")).toEqual([]);
  });
});
