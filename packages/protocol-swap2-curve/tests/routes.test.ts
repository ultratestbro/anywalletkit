// The route rules beyond pool membership (research doc §5.3 B): which tokens a route may hand the swap through, when a
// metapool's exchange_underlying is open, the runtime deny list, and the pool types a [4][5] router can drive.
import {describe, expect, it} from "vitest";
import {getAddress, type Hex} from "viem";
import {CURVE_DENIED_POOLS, CURVE_ETH, ZERO_ADDRESS} from "../src/deployments.js";
import type {CurveChainPools, CurvePool} from "../src/pools/types.js";
import {checkRoute, findRoutes, intermediateAllowed, poolTypeAllowed, routeArgs, underlyingAllowed} from "../src/routes.js";
import {CRVUSD, CRVUSD_USDC, D1, D143, DAI, MIM, MIM_META, POOLS, SCRVUSD, TRICRYPTO_USDT, TRIPOOL, UNLISTED_POOL, USDC, USDT, WETH} from "./fixtures.js";

const lc = (a: string) => a.toLowerCase();
/** A token no catalog lists (a pool coin the allowlist may admit, never a hop between two pools). */
const ODD = "0x00000000000000000000000000000000000Bad01";
const ODD_IN = "0x5555555555555555555555555555555555555501";
const ODD_OUT = "0x5555555555555555555555555555555555555502";
const pool = (p: Partial<CurvePool> & Pick<CurvePool, "address" | "name" | "coins" | "poolType">): CurvePool =>
  ({decimals: p.coins.map(() => 18), swapTypes: [1], codeHash: `0x${"11".repeat(32)}`, tvlUsd: 5_000_000, ...p});
const table = (extra: CurvePool[], drop: string[] = []): CurveChainPools =>
  ({...POOLS[1]!, pools: [...POOLS[1]!.pools.filter((p) => !drop.includes(p.address)), ...extra]});

describe("intermediate tokens: catalog tokens, the native coin or the pinned wrapped native only", () => {
  const viaOdd = table([
    pool({address: ODD_IN, name: "USDC/ODD", coins: [USDC, ODD], poolType: 10}),
    pool({address: ODD_OUT, name: "ODD/USDT", coins: [ODD, USDT], poolType: 10}),
  ]);

  it("names what may sit between two hops", () => {
    expect(intermediateAllowed(1, D1, USDT)).toBe(true);
    expect(intermediateAllowed(1, D1, CRVUSD)).toBe(true);
    expect(intermediateAllowed(1, D1, WETH)).toBe(true);
    expect(intermediateAllowed(1, D1, CURVE_ETH)).toBe(true);
    expect(intermediateAllowed(1, D1, ODD)).toBe(false);
    expect(intermediateAllowed(1, D1, MIM)).toBe(false);
    expect(intermediateAllowed(1, D1, ZERO_ADDRESS)).toBe(false);
    // Listed on another chain is not listed here.
    expect(intermediateAllowed(42161, {...D1, weth: ZERO_ADDRESS as Hex}, USDT)).toBe(false);
  });

  it("findRoutes never hands the swap through a token the catalog does not list", () => {
    const {routes} = findRoutes(1, D1, viaOdd, getAddress(USDC) as Hex, getAddress(USDT) as Hex, 100);
    expect(routes.length).toBeGreaterThan(0);
    for (const r of routes) for (const s of r.steps.slice(0, -1)) expect(intermediateAllowed(1, D1, s.tokenOut)).toBe(true);
    expect(routes.some((r) => r.steps.some((s) => s.kind === "pool" && [ODD_IN, ODD_OUT].includes(s.pool.address)))).toBe(false);
  });

  it("checkRoute refuses the same route sent by a backend, and still accepts one whose pool merely holds such a coin", () => {
    const hostile = routeArgs("ng5", {label: "", steps: [
      {kind: "pool", pool: viaOdd.pools.find((p) => p.address === ODD_IN)!, swapType: 1, i: 0, j: 1, tokenIn: getAddress(USDC) as Hex, tokenOut: ODD as Hex},
      {kind: "pool", pool: viaOdd.pools.find((p) => p.address === ODD_OUT)!, swapType: 1, i: 0, j: 1, tokenIn: ODD as Hex, tokenOut: getAddress(USDT) as Hex},
    ]});
    expect(checkRoute(1, D1, viaOdd, hostile, USDC, USDT)).toMatch(/step 1 hands the swap through 0x0+Bad01, a token the catalog does not list/i);
    // The source and destination follow the engine's listed / unlisted policy: ODD as the output is a route.
    const toOdd = routeArgs("ng5", {label: "", steps: [{kind: "pool", pool: viaOdd.pools.find((p) => p.address === ODD_IN)!, swapType: 1, i: 0, j: 1, tokenIn: getAddress(USDC) as Hex, tokenOut: ODD as Hex}]});
    expect(checkRoute(1, D1, viaOdd, toOdd, USDC, ODD)).toBeNull();
    // MIM/3CRV holds MIM and the 3Crv LP (neither listed); DAI → USDC through its underlying touches only DAI and USDC.
    const meta = POOLS[1]!.pools.find((p) => p.address === MIM_META)!;
    const daiUsdc = routeArgs("ng5", {label: "", steps: [{kind: "pool", pool: meta, swapType: 2, i: 1, j: 2, tokenIn: getAddress(DAI) as Hex, tokenOut: getAddress(USDC) as Hex}]});
    expect(checkRoute(1, D1, POOLS[1], daiUsdc, DAI, USDC)).toBeNull();
  });

  it("a two-pool route through a listed token passes (USDC → crvUSD → USDT, DAI → USDT → WBTC)", () => {
    const usdcCrv = POOLS[1]!.pools.find((p) => p.address === CRVUSD_USDC)!;
    const extra = table([pool({address: UNLISTED_POOL, name: "crvUSD/USDT", coins: [CRVUSD, USDT], poolType: 10})]);
    const a = routeArgs("ng5", {label: "", steps: [
      {kind: "pool", pool: usdcCrv, swapType: 1, i: 0, j: 1, tokenIn: getAddress(USDC) as Hex, tokenOut: getAddress(CRVUSD) as Hex},
      {kind: "pool", pool: extra.pools.at(-1)!, swapType: 1, i: 0, j: 1, tokenIn: getAddress(CRVUSD) as Hex, tokenOut: getAddress(USDT) as Hex},
    ]});
    expect(checkRoute(1, D1, extra, a, USDC, USDT)).toBeNull();
    expect(findRoutes(1, D1, POOLS[1], getAddress(DAI) as Hex, "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 100).routes.some((r) => r.steps.some((s) => s.kind === "pool" && s.pool.address === TRICRYPTO_USDT))).toBe(true);
  });
});

describe("exchange_underlying (swap_type 2) only on a metapool whose base pool is allowlisted", () => {
  const meta = POOLS[1]!.pools.find((p) => p.address === MIM_META)!;
  const daiUsdc = (m: CurvePool) => routeArgs("ng5", {label: "", steps: [{kind: "pool", pool: m, swapType: 2, i: 1, j: 2, tokenIn: getAddress(DAI) as Hex, tokenOut: getAddress(USDC) as Hex}]});
  const underlyingEdges = (t: CurveChainPools) => findRoutes(1, D1, t, getAddress(DAI) as Hex, getAddress(USDC) as Hex, 100).routes.filter((r) => r.steps.some((s) => s.kind === "pool" && s.swapType === 2));

  it("open with the base pool (3pool) in the allowlist", () => {
    const index = new Map(POOLS[1]!.pools.map((p) => [lc(p.address), p]));
    expect(underlyingAllowed(meta, index)).toBe(true);
    expect(underlyingEdges(POOLS[1]!).length).toBeGreaterThan(0);
  });

  it("closed when the base pool is not allowlisted, is denied, is not named, or its coins are not the underlying", () => {
    const noBase = table([], [TRIPOOL]);
    expect(underlyingEdges(noBase)).toEqual([]);
    expect(checkRoute(1, D1, noBase, daiUsdc(meta), DAI, USDC)).toMatch(/exchange_underlying on pool MIM\/3CRV needs its base pool in the allowlist/);
    const deniedBase = {...meta, basePool: "0xA6d9F4f3A67B35E81DFa560b0FcDE9B0751F1f53" as Hex};
    const t1 = table([deniedBase], [MIM_META]);
    expect(checkRoute(1, D1, t1, daiUsdc(deniedBase), DAI, USDC)).toMatch(/needs its base pool/);
    const {basePool: _named, ...unnamed} = meta;
    const t2 = table([unnamed], [MIM_META]);
    expect(underlyingEdges(t2)).toEqual([]);
    expect(checkRoute(1, D1, t2, daiUsdc(unnamed), DAI, USDC)).toMatch(/needs its base pool/);
    const wrongBase = {...meta, basePool: getAddress(CRVUSD_USDC) as Hex};
    const t3 = table([wrongBase], [MIM_META]);
    expect(checkRoute(1, D1, t3, daiUsdc(wrongBase), DAI, USDC)).toMatch(/needs its base pool/);
  });

  it("never on a lending pool (one underlying coin per wrapped coin, no base pool): its route deposits into the venue", () => {
    const wrapped = ["0x1111111111111111111111111111111111110001", "0x1111111111111111111111111111111111110002"] as Hex[];
    const lending = pool({address: "0x1111111111111111111111111111111111110003", name: "aDAI/aUSDC", coins: wrapped, underlying: [getAddress(DAI) as Hex, getAddress(USDC) as Hex], underlyingDecimals: [18, 6], poolType: 1, swapTypes: [2]});
    expect(underlyingAllowed(lending, new Map())).toBe(false);
    const t = table([lending]);
    expect(findRoutes(1, D1, t, getAddress(DAI) as Hex, getAddress(USDC) as Hex, 100).routes.some((r) => r.steps.some((s) => s.kind === "pool" && s.pool === lending))).toBe(false);
    const a = routeArgs("ng5", {label: "", steps: [{kind: "pool", pool: lending, swapType: 2, i: 0, j: 1, tokenIn: getAddress(DAI) as Hex, tokenOut: getAddress(USDC) as Hex}]});
    expect(checkRoute(1, D1, t, a, DAI, USDC)).toMatch(/needs its base pool in the allowlist/);
  });
});

describe("runtime deny list and router families", () => {
  it("denies the fake-USDT pool, the four pools drained in 2023, Iron Bank and Polygon amWBTC/renBTC", () => {
    expect([...CURVE_DENIED_POOLS[1]!].sort()).toEqual([
      "0x2dded6da1bf5dbdf597c45fcfaa3194e53ecfeaf",
      "0x8301ae4fc9c624d1d396cbdaa1ed877821d7c511",
      "0x9848482da3ee3076165ce6497eda906e66bb85c5",
      "0xa6d9f4f3a67b35e81dfa560b0fcde9b0751f1f53",
      "0xc4c319e2d4d66cca4464c0c2b32c9bd23ebe784e",
      "0xc897b98272aa23714464ea2a0bd5180f1b8c0025",
    ]);
    expect([...CURVE_DENIED_POOLS[137]!]).toEqual(["0xc2d95eef97ec6c17551d45e77b590dc1f9117c67"]);
    // Listed in an allowlist anyway: never a route, and refused when a backend sends one.
    const ironBank = pool({address: "0x2dded6Da1BF5DBdF597C45fcFaa3194e53EcfeAF", name: "cy-pool", coins: [USDC, CRVUSD], poolType: 1, tvlUsd: 9_000_000_000});
    const t = table([ironBank]);
    expect(findRoutes(1, D1, t, getAddress(USDC) as Hex, getAddress(CRVUSD) as Hex, 100).routes.some((r) => r.steps.some((s) => s.kind === "pool" && s.pool === ironBank))).toBe(false);
    const a = routeArgs("ng5", {label: "", steps: [{kind: "pool", pool: ironBank, swapType: 1, i: 0, j: 1, tokenIn: getAddress(USDC) as Hex, tokenOut: getAddress(CRVUSD) as Hex}]});
    expect(checkRoute(1, D1, t, a, USDC, CRVUSD)).toMatch(/a pool this module refuses/);
  });

  it("a [4][5] router drives only pool types 10/20/30", () => {
    expect([1, 2, 3, 10, 20, 30].filter((t) => poolTypeAllowed("lite4", t))).toEqual([10, 20, 30]);
    expect([1, 2, 3, 10, 20, 30].filter((t) => poolTypeAllowed("ng5", t))).toEqual([1, 2, 3, 10, 20, 30]);
    const crypto = pool({address: "0x2222222222222222222222222222222222220001", name: "twocrypto (old)", coins: ["0x754704Bc059F8C67012fEd69BC8A327a5aafb603", "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a"], poolType: 2});
    const t: CurveChainPools = {...POOLS[143]!, pools: [crypto]};
    expect(findRoutes(143, D143, t, crypto.coins[0]!, crypto.coins[1]!, 100).routes).toEqual([]);
  });

  it("the ERC-4626 hop's crvUSD side is a listed token (USDC → crvUSD → scrvUSD on Ethereum)", () => {
    const {routes} = findRoutes(1, D1, POOLS[1], getAddress(USDC) as Hex, getAddress(SCRVUSD) as Hex, 100);
    expect(routes.some((r) => r.steps.length === 2 && r.steps[1]!.kind === "erc4626")).toBe(true);
  });
});
