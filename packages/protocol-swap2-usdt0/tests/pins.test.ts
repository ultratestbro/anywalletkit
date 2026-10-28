// Scan 2026-10-27 (modules), F8/F16: the addresses this provider's EVM swaps call and approve, shipped for
// `remoteProvider({...usdt0Pins})` so the app checks a backend's build against them, never against the build itself.
import {describe, expect, it} from "vitest";
import {USDT0_CHAINS, usdt0Pins} from "../src/config.js";

describe("usdt0 pins (scan 2026-10-27 modules)", () => {
  it("pin the contract the provider uses on each chain, and nothing where it has no EVM route", () => {
    expect(usdt0Pins.callTargets("eip155:42161")).toEqual([USDT0_CHAINS["eip155:42161"]!.oft]);
    // Only the Ethereum adapter takes an allowance (it locks USDT); the OFTs burn without one.
    expect(usdt0Pins.spenders("eip155:1")).toEqual([USDT0_CHAINS["eip155:1"]!.oft]);
    expect(usdt0Pins.spenders("eip155:42161")).toEqual([]);
    expect(usdt0Pins.callTargets("eip155:56")).toEqual([]);
  });
});
