import {describe, expect, it} from "vitest";
import {conversionRate, destinationAmount, sourceMinimum, splitFeeDetails, splitSourceAmount} from "../src/amounts.js";

describe("Stargate shared-decimal accounting", () => {
  it("converts a BSC 18-decimal receipt to 6-decimal USDC and back", () => {
    expect(destinationAmount(9_979_999_000_000_000_000n, 18, 6, 6)).toBe(9_979_999n);
    expect(destinationAmount(9_979_999n, 6, 18, 6)).toBe(9_979_999_000_000_000_000n);
  });

  it("rounds a destination floor up, never down, to a representable wire amount", () => {
    expect(sourceMinimum(1_000_000_000_001n, 6, 18, 6)).toBe(2n);
    expect(sourceMinimum(1_000_000_000_000n, 6, 18, 6)).toBe(1n);
    expect(sourceMinimum(2n, 18, 6, 6)).toBe(2_000_000_000_000n);
    expect(sourceMinimum(0n, 6, 18, 6)).toBe(0n);
  });

  it("preserves arbitrary destination floors for both decimal directions", () => {
    for (const [src, dst] of [[6, 18], [18, 6], [18, 18], [6, 6]] as const) {
      const unit = conversionRate(dst, 6);
      for (const floor of [0n, 1n, unit - 1n, unit, unit + 1n, (1n << 63n) + 7n]) {
        const actual = destinationAmount(sourceMinimum(floor, src, dst, 6), src, dst, 6);
        expect(actual).toBeGreaterThanOrEqual(floor);
        expect(actual - floor).toBeLessThan(unit);
      }
    }
  });

  it("accounts for dust and keeps uint64 values above JS safe integers exact", () => {
    expect(splitSourceAmount(1_000_000_000_007n, 18, 6)).toEqual({amountSD: 1n, sentLD: 1_000_000_000_000n, dustLD: 7n});
    expect(splitSourceAmount(7n, 18, 6)).toEqual({amountSD: 0n, sentLD: 0n, dustLD: 7n});
    const max = (1n << 64n) - 1n;
    expect(splitSourceAmount(max * 10n ** 12n, 18, 6).amountSD).toBe(max);
    expect(() => splitSourceAmount((max + 1n) * 10n ** 12n, 18, 6)).toThrow(/uint64/);
    expect(() => sourceMinimum(max * 10n ** 12n + 1n, 6, 18, 6)).toThrow(/uint64/);
  });

  it("rejects malformed decimals, negative values, overflow and unaligned quote receipts", () => {
    for (const [local, shared] of [[5, 6], [18.1, 6], [18, -1], [256, 6], [78, 0], [18, NaN]]) {
      expect(() => conversionRate(local!, shared!)).toThrow(RangeError);
    }
    expect(() => splitSourceAmount(-1n, 6, 6)).toThrow(RangeError);
    expect(() => splitSourceAmount(1n << 256n, 18, 6)).toThrow(RangeError);
    expect(() => destinationAmount(1n, 18, 6, 6)).toThrow(/aligned/);
    expect(() => destinationAmount((1n << 64n) - 1n, 0, 77, 0)).toThrow(/uint256/);
  });

  it("keeps charges and rewards separate without treating a reward as an error", () => {
    expect(splitFeeDetails([{feeAmountLD: -6071n}, {feeAmountLD: 100n}, {feeAmountLD: 0n}])).toEqual({feeLD: 6071n, rewardLD: 100n});
    expect(splitFeeDetails([])).toEqual({feeLD: 0n, rewardLD: 0n});
    expect(() => splitFeeDetails([{feeAmountLD: 1n << 255n}])).toThrow(/int256/);
  });
});
