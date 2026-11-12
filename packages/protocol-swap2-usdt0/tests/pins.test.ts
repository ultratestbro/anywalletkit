// Scan 2026-10-27 (modules), F8/F16: the addresses this provider's EVM swaps call and approve, shipped for
// `remoteProvider({...usdt0Pins})` so the app checks a backend's build against them, never against the build itself.
import {describe, expect, it} from "vitest";
import {USDT0_CHAINS, USDT0_MESH_SOURCES, usdt0Pins} from "../src/config.js";

describe("usdt0 pins (scan 2026-10-27 modules)", () => {
  it("pin the contract the provider uses on each chain, and nothing where it has no EVM route", () => {
    // The USDT0 OFT, then (2026-11-12) the Legacy Mesh OFT where the chain is a mesh source.
    expect(usdt0Pins.callTargets("eip155:42161")).toEqual([USDT0_CHAINS["eip155:42161"]!.oft, USDT0_MESH_SOURCES["eip155:42161"]!.oft]);
    expect(usdt0Pins.callTargets("eip155:999")).toEqual([USDT0_CHAINS["eip155:999"]!.oft]);
    // Only the Ethereum adapter takes an allowance (it locks USDT); the OFTs burn without one. A mesh OFT pulls its
    // token, so it is a spender on its three chains — usdt0VerifyQuote keeps an OFT send free of any approval.
    expect(usdt0Pins.spenders("eip155:1")).toEqual([USDT0_CHAINS["eip155:1"]!.oft, USDT0_MESH_SOURCES["eip155:1"]!.oft]);
    expect(usdt0Pins.spenders("eip155:42161")).toEqual([USDT0_MESH_SOURCES["eip155:42161"]!.oft]);
    expect(usdt0Pins.spenders("eip155:999")).toEqual([]);
    expect(usdt0Pins.callTargets("eip155:42220")).toEqual([USDT0_MESH_SOURCES["eip155:42220"]!.oft]);
    expect(usdt0Pins.callTargets("eip155:56")).toEqual([]);
    expect(usdt0Pins.callTargets("tron:728126428")).toEqual([]);
    expect(usdt0Pins.callTargets("ton:-239")).toEqual([]);
  });
});
