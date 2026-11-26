// 0.5.0 review, fix round 1: the smaller v4 findings, each with the case that showed it.
import {describe, expect, it} from "vitest";
import {UNISWAP_V4} from "../src/v4/addresses.js";
import {V4_HOP_SYMBOLS, v4HopTokens} from "../src/v4/verify.js";
import {V4_HOP_SYMBOLS as FROM_SUBPATH} from "../src/v4/index.js";

describe("FUNDS-3: the hop currencies the pins accept cannot be widened from inside the process", () => {
  it("V4_HOP_SYMBOLS is frozen (before: a push made the pins accept a two-hop route through AUSD on Monad)", () => {
    expect(FROM_SUBPATH).toBe(V4_HOP_SYMBOLS);
    expect(Object.isFrozen(V4_HOP_SYMBOLS)).toBe(true);
    const before = v4HopTokens(143, UNISWAP_V4[143]!).size;
    expect(() => (V4_HOP_SYMBOLS as unknown as string[]).push("AUSD")).toThrow(TypeError);
    expect(v4HopTokens(143, UNISWAP_V4[143]!).size).toBe(before);
    expect([...V4_HOP_SYMBOLS]).toEqual(["USDC", "USDT", "USDT0"]);
  });
});
