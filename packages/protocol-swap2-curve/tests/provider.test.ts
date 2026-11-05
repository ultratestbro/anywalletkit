import {afterEach, describe, expect, it, vi} from "vitest";
import {curveProvider} from "../src/provider.js";
import {decodeExchange} from "../src/abi.js";
import {CURVE_ETH, ZERO_ADDRESS} from "../src/deployments.js";
import {CRVUSD, D1, D143, M_3POOL, M_OLD_STABLE, ME, MIM_META, RPC, SCRVUSD, STETH, STETH_NG, TABLES, TRICRYPTO_USDT, TRIPOOL, USDC, USDT, WBTC, WETH, rpcStub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME};
const make = (over: Record<string, unknown> = {}) => curveProvider({rpcUrls: RPC, ...TABLES, onWarning: () => {}, ...over});
const lc = (a: string) => a.toLowerCase();
const steps = (data: string, family: "ng5" | "lite4" = "ng5") => {
  const c = decodeExchange(family, data)!;
  expect(c).not.toBeNull();
  return c;
};

describe("Curve provider: quotes", () => {
  it("prices the allowlisted routes with the router's get_dy, takes the best, and builds the explicit-receiver exchange", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const q = await make().getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000000", slippageBps: 10});
    // 3pool direct: 1000 USDC × 0.999 − 1 wei.
    expect(q).toMatchObject({provider: "curve", intentId: "curve:1", destAmount: "998999999", minDestAmount: "998000999", depositAddress: ""});
    expect(q!.txRequest).toMatchObject({to: D1.router, value: "0", chainId: 1, approvalAddress: D1.router});
    expect(q!.txRequest!.data!.slice(0, 10)).toBe("0xc872a3c5");
    const c = steps(q!.txRequest!.data!);
    expect(c.receiver).toBe(ME);
    expect(c.amount).toBe(1_000_000_000n);
    expect(c.minDy).toBe(998_000_999n);
    expect(c.pools).toEqual(Array(5).fill(ZERO_ADDRESS));
    expect(c.route.slice(0, 3).map(lc)).toEqual([USDC, TRIPOOL, USDT].map(lc));
    expect(c.params[0]).toEqual([1n, 2n, 1n, 1n, 3n]);
    expect(q!.providerData).toMatchObject({route: "3pool", family: "ng5", pools: TRIPOOL, slippageBps: "10"});
  });

  it("a better two-pool route beats a worse direct one", async () => {
    // MIM/3CRV prices DAI → USDC (underlying) at 0.5; 3pool direct at 0.98; crvUSD/USDC is irrelevant.
    vi.stubGlobal("fetch", rpcStub({rateBps: {[lc(TRIPOOL)]: 9_800, [lc(MIM_META)]: 5_000}}));
    const q = await make().getQuote({...base, sourceToken: "DAI", destToken: USDC, amountIn: (1000n * 10n ** 18n).toString(), slippageBps: 10});
    expect(q!.providerData!.route).toBe("3pool");
    vi.stubGlobal("fetch", rpcStub({rateBps: {[lc(TRIPOOL)]: 9_000, [lc(MIM_META)]: 9_999}}));
    const q2 = await make().getQuote({...base, sourceToken: "DAI", destToken: USDC, amountIn: (1000n * 10n ** 18n).toString(), slippageBps: 10});
    expect(q2!.providerData!.route).toBe("MIM/3CRV (underlying)");
    expect(steps(q2!.txRequest!.data!).params[0]).toEqual([1n, 2n, 2n, 1n, 4n]);
  });

  it("splits the get_dy batch for nodes that cap batches (≤ 10 calls) and caps the candidates", async () => {
    const stub = rpcStub();
    vi.stubGlobal("fetch", stub);
    const q = await make().getQuote({...base, sourceToken: "DAI", destToken: WBTC, amountIn: (1000n * 10n ** 18n).toString()});
    expect(q).not.toBeNull();
    expect(Math.max(...stub.batches)).toBeLessThanOrEqual(10);
    expect(Number(q!.providerData!.candidates!.replace("+", ""))).toBeLessThanOrEqual(30);
  });

  it("reports the route's price impact from a 1/1000 probe (information, not a gate)", async () => {
    vi.stubGlobal("fetch", rpcStub({impactBps: 4_300, impactFrom: 1_000_000_000n}));
    const q = await make().getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000000", slippageBps: 10});
    expect(q!.providerData!.priceImpactBps).toBe("4300");
  });

  it("auto slippage follows swap2-core: stable ↔ stable 10 bps + half the impact; a fixed default overrides it", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const auto = await make().getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000000"});
    expect(auto!.providerData!.slippageBps).toBe("10");
    const major = await make().getQuote({...base, sourceToken: "USDT", destToken: WETH, amountIn: "1000000000"});
    expect(major!.providerData!.slippageBps).toBe("50");
    const fixed = await make({defaultSlippageBps: 30}).getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000000"});
    expect(fixed!.providerData!.slippageBps).toBe("30");
    expect(() => make({defaultSlippageBps: 0})).toThrow(/1..4999/);
  });

  it("refuses a floor breach by name, and never builds min_dy 0", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const reasons: string[] = [];
    expect(await make().getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000000", slippageBps: 10, minAmountOut: "999000000", onRefusal: (r) => reasons.push(r)})).toBeNull();
    expect(await make().getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1", slippageBps: 10, onRefusal: (r) => reasons.push(r)})).toBeNull();
    expect(reasons).toEqual(["curve: floor breach (min=998000999 < floor=999000000)", "curve: no allowlisted Curve pool quotes this pair and amount"]);
  });
});

describe("Curve provider: native in / out and pseudo-hops", () => {
  it("native in through a pool that holds the native coin: value = amount, no approval", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const q = await make().getQuote({...base, sourceToken: "ETH", destToken: STETH, amountIn: "1000000000000000000"});
    expect(q!.txRequest).toMatchObject({value: "1000000000000000000"});
    expect(q!.txRequest!.approvalAddress).toBeUndefined();
    const c = steps(q!.txRequest!.data!);
    expect(c.route.slice(0, 3).map(lc)).toEqual([CURVE_ETH, STETH_NG, STETH].map(lc));
  });

  it("native in through a WETH pool: the router wraps first (swap_type 8 through the pinned WETH only)", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const q = await make().getQuote({...base, sourceToken: "ETH", destToken: USDT, amountIn: "1000000000000000000"});
    const c = steps(q!.txRequest!.data!);
    expect(c.route.slice(0, 5).map(lc)).toEqual([CURVE_ETH, WETH, WETH, TRICRYPTO_USDT, USDT].map(lc));
    expect(c.params[0]).toEqual([0n, 0n, 8n, 0n, 0n]);
    expect(c.params[1]).toEqual([2n, 0n, 1n, 30n, 3n]);
    expect(q!.providerData!.route).toBe("wrap → TricryptoUSDT");
  });

  it("native out: the last step unwraps to the native coin, paid to the receiver", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const q = await make().getQuote({...base, sourceToken: "USDT", destToken: ZERO_ADDRESS, amountIn: "1000000000"});
    const c = steps(q!.txRequest!.data!);
    expect(c.route.slice(0, 5).map(lc)).toEqual([USDT, TRICRYPTO_USDT, WETH, WETH, CURVE_ETH].map(lc));
    expect(c.receiver).toBe(ME);
    expect(q!.txRequest!.value).toBe("0");
  });

  it("crvUSD → scrvUSD through the ERC-4626 hop (swap_type 9) on Ethereum's v1.2 router", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const q = await make().getQuote({...base, sourceToken: CRVUSD, sourceDecimals: 18, destToken: SCRVUSD, amountIn: (1000n * 10n ** 18n).toString()});
    const c = steps(q!.txRequest!.data!);
    expect(c.route.slice(0, 3).map(lc)).toEqual([CRVUSD, SCRVUSD, SCRVUSD].map(lc));
    expect(c.params[0]).toEqual([0n, 0n, 9n, 0n, 0n]);
  });

  it("a [4][5] router: uint256[4][5] params, NG pools only (a legacy pool_type 1 pool never enters a route)", async () => {
    vi.stubGlobal("fetch", rpcStub({rateBps: {[lc(M_OLD_STABLE)]: 9_999}}));
    const q = await make().getQuote({sourceChain: "eip155:143", destChain: "eip155:143", destAddress: ME, sourceToken: "USDC", destToken: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", amountIn: "1000000000"});
    expect(q!.txRequest!.data!.slice(0, 10)).toBe("0xfd44959c");
    const c = steps(q!.txRequest!.data!, "lite4");
    expect(c.route[1]!.toLowerCase()).toBe(M_3POOL.toLowerCase());
    expect(c.params[0]).toEqual([1n, 0n, 1n, 10n]);
    expect(q!.txRequest!.to).toBe(D143.router);
  });

  it("names every other refusal: cross-chain, unknown chain, wrap, same token, no route", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const p = make();
    const reasons: string[] = [];
    const on = (r: string) => reasons.push(r);
    await p.getQuote({...base, destChain: "eip155:8453", sourceToken: "USDC", destToken: USDT, amountIn: "1", onRefusal: on});
    await p.getQuote({...base, sourceChain: "eip155:8453", destChain: "eip155:8453", sourceToken: "USDC", destToken: USDT, amountIn: "1", onRefusal: on});
    await p.getQuote({...base, sourceToken: "ETH", destToken: WETH, amountIn: "1", onRefusal: on});
    await p.getQuote({...base, sourceToken: "USDC", destToken: USDC, amountIn: "1", onRefusal: on});
    await p.getQuote({...base, sourceToken: "USDC", destToken: "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984", amountIn: "1000000", onRefusal: on});
    expect(reasons).toEqual([
      "curve: same-chain swaps only",
      "curve: no Curve router, pool allowlist or RPC for eip155:8453",
      "curve: that is a wrap/unwrap, not a swap",
      "curve: same token in and out",
      "curve: no allowlisted Curve pool route for this pair",
    ]);
  });

  it("refuses when the router is not the pinned code or version", async () => {
    for (const bad of [{badRouterCode: true}, {version: "1.1.0"}]) {
      vi.stubGlobal("fetch", rpcStub(bad));
      let why = "";
      expect(await make().getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000", onRefusal: (r) => { why = r; }})).toBeNull();
      expect(why).toMatch(/not the pinned code|reports version 1.1.0, not 1.2.0/);
    }
  });

  it("an AddressProvider that lists another router is only a warning — the pinned router is still used", async () => {
    vi.stubGlobal("fetch", rpcStub({addressProvider: "0x000000000000000000000000000000000000dEaD"}));
    const warnings: string[] = [];
    const q = await make({onWarning: (m: string) => warnings.push(m)}).getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"});
    expect(q!.txRequest!.to).toBe(D1.router);
    expect(q!.txRequest!.approvalAddress).toBe(D1.router);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/lists router 0x000000000000000000000000000000000000dead.*keeps the pinned/);
  });

  it("fails over to the next RPC and offers only chains with a router, an allowlist and an RPC", async () => {
    const stub = rpcStub({down: ["https://down.test"]});
    vi.stubGlobal("fetch", stub);
    const p = make({rpcUrls: {1: ["https://down.test", "https://rpc.test"]}});
    expect(await p.getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"})).not.toBeNull();
    expect(stub.urls).toContain("https://rpc.test");
    expect(p.supportsRoute({chain: "eip155:1", token: "USDC"}, {chain: "eip155:1", token: USDT})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:143", token: "USDC"}, {chain: "eip155:143", token: USDT})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:1", token: "USDC"}, {chain: "eip155:10", token: USDT})).toBe(false);
  });
});

describe("Curve provider: preflight and tracking", () => {
  it("lives a few minutes (the router has no deadline), and preflight re-checks the sealed call on chain", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const p = make();
    const q = await p.getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000000", slippageBps: 10});
    expect(q!.validUntilMs - Date.now()).toBeGreaterThan(2 * 60_000);
    expect(q!.validUntilMs - Date.now()).toBeLessThanOrEqual(3 * 60_000);
    const tx = await p.buildDeposit(q!);
    await expect(p.preflightDeposit!(q!, tx)).resolves.toBeUndefined();
    vi.stubGlobal("fetch", rpcStub({rateBps: {[lc(TRIPOOL)]: 9_000}})); // the pool moved 10% against the user
    await expect(p.preflightDeposit!(q!, tx)).rejects.toThrow(/price moved — the pools now pay 899999999, under your minimum 998000999/);
  });

  it("preflight refuses a transaction that is not byte for byte the quote, a pool whose code or coins changed", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const p = make();
    const q = await p.getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000000", slippageBps: 10});
    const tx = await p.buildDeposit(q!);
    await expect(p.preflightDeposit!(q!, {...tx, data: `${tx.data!.slice(0, -2)}00`})).rejects.toThrow(/not the quoted router call/);
    await expect(p.preflightDeposit!(q!, {...tx, value: "1"})).rejects.toThrow(/value is not the quote's/);
    vi.stubGlobal("fetch", rpcStub({badPoolCode: [TRIPOOL]}));
    await expect(p.preflightDeposit!(q!, tx)).rejects.toThrow(/pool 3pool .* is not the pinned code/);
    vi.stubGlobal("fetch", rpcStub({coins: {[lc(TRIPOOL)]: {2: "0x810ecC2aa8b798F28633e1586a718cd48083Bae9"}}}));
    await expect(p.preflightDeposit!(q!, tx)).rejects.toThrow(/now reports coin 2/);
  });

  it("tracks the swap by its mined receipt", async () => {
    const p = make();
    vi.stubGlobal("fetch", rpcStub({receipt: null}));
    expect(await p.trackIntent({intentId: "curve:1", sourceTxHash: "0xabc"})).toEqual({state: "pending"});
    vi.stubGlobal("fetch", rpcStub({receipt: "0x1"}));
    expect(await p.trackIntent({intentId: "curve:1", sourceTxHash: "0xabc"})).toEqual({state: "completed", destTxHash: "0xabc"});
    vi.stubGlobal("fetch", rpcStub({receipt: "0x0"}));
    expect(await p.trackIntent({intentId: "curve:1", sourceTxHash: "0xabc"})).toEqual({state: "failed"});
    expect(await p.trackIntent({intentId: "curve:1"})).toEqual({state: "pending"});
  });
});



