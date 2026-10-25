// Audit 2026-10-25, finding 16: some Hermes builds turn Number(x) of a bigint at or above 2^63 into
// garbage. A check made AFTER the conversion (`Number.isSafeInteger(Number(x))`) then passes on a
// value that came from nowhere. The engine is simulated here: Number() returns 1 for such bigints.
import {afterEach, describe, expect, it, vi} from "vitest";
import {normalizeTypedDomain} from "../src/swap2/base.js";

const hermesLikeNumber = () => vi.stubGlobal("Number", new Proxy(Number, {
  apply: (target, self, args: unknown[]) => (typeof args[0] === "bigint" && (args[0] >= 2n ** 63n || args[0] <= -(2n ** 63n)) ? 1 : Reflect.apply(target, self, args)),
}));
afterEach(() => { vi.unstubAllGlobals(); });

describe("normalizeTypedDomain on an engine with a broken Number(bigint)", () => {
  it("leaves an out-of-range chainId as it is instead of turning it into chain 1", () => {
    hermesLikeNumber();
    const huge = 2n ** 64n + 1n;
    expect(normalizeTypedDomain({name: "Permit2", chainId: huge})).toEqual({name: "Permit2", chainId: huge});
    expect(normalizeTypedDomain({name: "Permit2", chainId: "0x10000000000000001"})).toEqual({name: "Permit2", chainId: "0x10000000000000001"});
    expect(normalizeTypedDomain({name: "Permit2", chainId: 137n})).toEqual({name: "Permit2", chainId: 137});
    expect(normalizeTypedDomain({name: "Permit2", chainId: "0x89"})).toEqual({name: "Permit2", chainId: 137});
  });
});
