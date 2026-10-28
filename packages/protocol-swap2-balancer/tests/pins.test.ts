// Scan 2026-10-27 (modules), F8/F16: the addresses this provider's EVM swaps call and approve, shipped for
// `remoteProvider({...balancerPins})` so the app checks a backend's build against them, never against the build itself.
import {describe, expect, it} from "vitest";
import {BALANCER_V2_VAULT, balancerPins} from "../src/provider.js";

describe("balancer pins (scan 2026-10-27 modules)", () => {
  it("pin the contract the provider uses on each chain, and nothing where it has no EVM route", () => {
    expect(balancerPins.callTargets("eip155:1")).toEqual([BALANCER_V2_VAULT]);
    expect(balancerPins.spenders("eip155:10")).toEqual([BALANCER_V2_VAULT]);
    expect(balancerPins.callTargets("eip155:999999")).toEqual([]);
  });
});
