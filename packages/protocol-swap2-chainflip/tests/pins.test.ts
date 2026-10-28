// Scan 2026-10-27 (modules), F8/F16: the addresses this provider's EVM swaps call and approve, shipped for
// `remoteProvider({...chainflipPins})` so the app checks a backend's build against them, never against the build itself.
import {describe, expect, it} from "vitest";
import {CF_VAULTS, chainflipPins} from "../src/config.js";

describe("chainflip pins (scan 2026-10-27 modules)", () => {
  it("pin the contract the provider uses on each chain, and nothing where it has no EVM route", () => {
    expect(chainflipPins.callTargets("eip155:1")).toEqual([CF_VAULTS["eip155:1"]]);
    expect(chainflipPins.spenders("eip155:42161")).toEqual([CF_VAULTS["eip155:42161"]]);
    // The Tron Vault is not an EVM call target: Tron sources execute through their own account surface.
    expect(chainflipPins.callTargets("tron:728126428")).toEqual([]);
    expect(chainflipPins.callTargets("eip155:56")).toEqual([]);
  });
});
