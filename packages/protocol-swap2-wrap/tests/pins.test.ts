// Scan 2026-10-27 (modules), F8/F16: the addresses this provider's EVM swaps call and approve, shipped for
// `remoteProvider({...wrapPins})` so the app checks a backend's build against them, never against the build itself.
import {describe, expect, it} from "vitest";
import {WRAPPED_NATIVE, wrapPins} from "../src/provider.js";

describe("wrap pins (scan 2026-10-27 modules)", () => {
  it("pin the contract the provider uses on each chain, and nothing where it has no EVM route", () => {
    expect(wrapPins.callTargets("eip155:8453")).toEqual([WRAPPED_NATIVE[8453]!.address]);
    expect(wrapPins.spenders("eip155:8453")).toEqual([]);
    expect(wrapPins.callTargets("eip155:999999")).toEqual([]);
  });
});
