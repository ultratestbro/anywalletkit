// Scan 2026-10-27 (modules), F8/F16: the addresses this provider's EVM swaps call and approve, shipped for
// `remoteProvider({...cctpPins})` so the app checks a backend's build against them, never against the build itself.
import {describe, expect, it} from "vitest";
import {CCTP_DOMAINS, cctpClaimTargets, cctpPins} from "../src/index.js";

describe("cctp pins (scan 2026-10-27 modules)", () => {
  it("pin the contract the provider uses on each chain, and nothing where it has no EVM route", () => {
    expect(cctpPins.callTargets("eip155:8453")).toEqual([CCTP_DOMAINS["eip155:8453"]!.tokenMessenger]);
    expect(cctpPins.spenders("eip155:1")).toEqual([CCTP_DOMAINS["eip155:1"]!.tokenMessenger]);
    expect(cctpPins.claimTargets("eip155:42161")).toEqual(cctpClaimTargets("eip155:42161"));
    expect(cctpPins.callTargets("eip155:56")).toEqual([]);
  });
});
