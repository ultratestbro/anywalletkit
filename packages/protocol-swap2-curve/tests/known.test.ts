import {describe, expect, it} from "vitest";
import {curveKnownContracts} from "../src/known.js";
import {CURVE_DEPLOYMENTS, SCRVUSD} from "../src/deployments.js";
import {DEPLOYMENTS, POOLS, TRIPOOL} from "./fixtures.js";

describe("curveKnownContracts (tx-preview labels)", () => {
  it("labels the router, the allowlisted pools, the wrapped native and scrvUSD", () => {
    const k = curveKnownContracts(1, {deployments: DEPLOYMENTS, pools: POOLS});
    expect(k[CURVE_DEPLOYMENTS[1]!.router]).toBe("Curve Router NG 1.2.0 · Ethereum");
    expect(k[TRIPOOL]).toBe("Curve pool · 3pool");
    expect(k[CURVE_DEPLOYMENTS[1]!.weth]).toMatch(/Wrapped native/);
    expect(k[SCRVUSD]).toMatch(/scrvUSD/);
  });
  it("the shipped tables add Ethereum's older routers; nothing for a chain without a router", () => {
    expect(Object.values(curveKnownContracts(1)).filter((l) => /older/.test(l))).toHaveLength(2);
    expect(curveKnownContracts(999_999)).toEqual({});
  });
});
