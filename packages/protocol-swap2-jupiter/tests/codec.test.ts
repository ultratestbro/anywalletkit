import {describe, expect, it} from "vitest";
import {readFileSync} from "node:fs";
import {decodeComputeBudget, decodeSwapArgs, fromBase64, minOutOf, setComputeUnitLimit, setComputeUnitPrice} from "../src/codec.js";

// Live /build answers, 2026-10-23 (keyless): both route_v2 and shared_accounts_route_v2 shapes.
const fx = JSON.parse(readFileSync(new URL("../fixtures/build-2026-10-23.json", import.meta.url), "utf8")).responses as Record<string, {request: {amount: string; slippageBps: number}; response: {inAmount: string; outAmount: string; otherAmountThreshold: string; swapInstruction: {data: string}; computeBudgetInstructions: {data: string}[]}}>;

describe("Jupiter swap instruction arguments", () => {
  for (const [name, {request, response}] of Object.entries(fx)) {
    it(`${name}: amount in, quoted out, slippage and a zero platform fee read back from the bytes`, () => {
      const a = decodeSwapArgs(fromBase64(response.swapInstruction.data));
      expect(a).toMatchObject({inAmount: BigInt(request.amount), quotedOutAmount: BigInt(response.outAmount), slippageBps: request.slippageBps, platformFeeBps: 0, positiveSlippageBps: 0});
      // Our floor never exceeds the API's threshold (it rounds up by one at most).
      const min = minOutOf(a.quotedOutAmount, a.slippageBps);
      expect(min <= BigInt(response.otherAmountThreshold) && BigInt(response.otherAmountThreshold) - min <= 1n).toBe(true);
    });
  }
  it("both v2 shapes occur in the recordings", () => {
    const kinds = new Set(Object.values(fx).map((f) => decodeSwapArgs(fromBase64(f.response.swapInstruction.data)).kind));
    expect([...kinds].sort()).toEqual(["route_v2", "shared_accounts_route_v2"]);
  });
  it("refuses other instructions and truncated data", () => {
    const d = fromBase64(fx.sol_usdc!.response.swapInstruction.data);
    expect(() => decodeSwapArgs(Uint8Array.from([0xe5, 0x17, 0xcb, 0x97, 0x7a, 0xe3, 0xad, 0x2a, ...d.subarray(8)]))).toThrow(/unsupported Jupiter instruction e517cb977ae3ad2a/); // legacy `route`
    expect(() => decodeSwapArgs(d.subarray(0, 20))).toThrow(/truncated/);
  });
});

describe("compute budget", () => {
  it("decodes Jupiter's SetComputeUnitPrice and round-trips ours", () => {
    expect(decodeComputeBudget(fromBase64(fx.sol_usdc!.response.computeBudgetInstructions[0]!.data)).price).toBeGreaterThan(0n);
    expect(decodeComputeBudget(setComputeUnitLimit(321_000))).toEqual({limit: 321_000});
    expect(decodeComputeBudget(setComputeUnitPrice(12_345n))).toEqual({price: 12_345n});
    expect(() => decodeComputeBudget(Uint8Array.from([1, 0, 0, 0, 0]))).toThrow(/unexpected/); // RequestHeapFrame
  });
});
