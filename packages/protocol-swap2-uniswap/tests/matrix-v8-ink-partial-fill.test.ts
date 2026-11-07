// Matrix v8, Ink (eip155:57073): the WETH/USDC v3 pools are dust (the 0.05% pool holds 168 raw USDC), and QuoterV2
// answers an input larger than a pool holds with the partial fill it would make, stopping at the price bound. That
// counted as a quote: 0.01 ETH → USDC "quoted" 1 raw unit with a minimum of 0, and 10 USDC → ETH drained the pool's
// WETH for a fraction of the input. On a native input the router wraps only what the pool takes, so the unspent value
// stayed in the router for anyone to sweep. The real route there runs through USDT0, which was not a hop token.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, encodeFunctionData, parseAbi, type Hex} from "viem";
import {ccAsset} from "@anywalletkit/swap2-assets";
import {uniswapProvider} from "../src/provider.js";
import {HOP_SYMBOLS, uniswapVerifyQuote} from "../src/addresses.js";
import {D, ME, MID_SQRT_PRICE, RPC, SQRT_CEIL, SQRT_FLOOR, USDC, USDT, rpcStub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME};
const ABI = parseAbi([
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function refundETH() payable",
  "function sweepToken(address token, uint256 amountMinimum, address recipient) payable",
]);
const legsOf = (data: string) => (decodeFunctionData({abi: ABI, data: data as Hex}).args![1] as Hex[]);
const refusal = async (params: Parameters<ReturnType<typeof uniswapProvider>["getQuote"]>[0], stub: Parameters<typeof rpcStub>[0]) => {
  vi.stubGlobal("fetch", rpcStub(stub));
  let why = "";
  const q = await uniswapProvider({rpcUrls: RPC}).getQuote({...params, onRefusal: (r) => { why = r; }});
  return {q, why};
};

describe("matrix v8 (Ink): partial fills, zero minimums, USDT0 hops, refundETH", () => {
  it("a pool left at either price bound is a partial fill, not a candidate — the full-fill tier wins instead", async () => {
    for (const bound of [SQRT_FLOOR, SQRT_CEIL, SQRT_FLOOR - 1n, SQRT_CEIL + 1n]) {
      // the drained 0.05% tier "pays" more than the 0.3% tier that takes the whole input
      const {q} = await refusal({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"}, {byFee: {500: 1_200_000n, 3000: 990_000n}, sqrtAfter: {500: bound}});
      expect(q, String(bound)).toMatchObject({destAmount: "990000"});
      expect(q!.providerData).toMatchObject({fee: "3000"});
    }
    // one step inside the bounds is still a full fill
    const {q} = await refusal({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"}, {byFee: {500: 1_200_000n, 3000: 990_000n}, sqrtAfter: {500: SQRT_FLOOR + 1n}});
    expect(q!.providerData).toMatchObject({fee: "500"});
  });

  it("refuses by name when every route runs a pool dry (direct and two-pool, either hop)", async () => {
    const params = {...base, sourceToken: "ETH", destToken: USDC, amountIn: "10000000000000000"};
    const single = await refusal(params, {byFee: {500: 1n, 3000: 1n}, sqrtAfter: {500: SQRT_CEIL, 3000: SQRT_CEIL}});
    expect(single.q).toBeNull();
    expect(single.why).toBe("uniswap: pool liquidity runs out before the full amount (partial fill)");
    for (const list of [[MID_SQRT_PRICE, SQRT_FLOOR], [SQRT_CEIL, MID_SQRT_PRICE]]) {
      const multi = await refusal({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"}, {byFee: {}, multiHop: 1_000_000n, multiHopSqrtAfter: list});
      expect(multi.why).toBe("uniswap: pool liquidity runs out before the full amount (partial fill)");
    }
    // no pool at all is still "no route", not a partial fill
    expect((await refusal(params, {byFee: {}})).why).toBe("uniswap: no Uniswap v3 pool route for this pair and amount");
  });

  it("refuses a quote whose minimum rounds to 0 instead of emitting one validation drops", async () => {
    const {q, why} = await refusal({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1"}, {byFee: {500: 1_000_000n}});
    expect(q).toBeNull();
    expect(why).toBe("uniswap: the minimum output rounds to 0 (quoted 1 at 50 bps slippage) — the amount is too small for this pool");
    // the smallest output that survives 50 bps still quotes, with a minimum of 1
    const ok = await refusal({...base, sourceToken: "USDC", destToken: USDT, amountIn: "2"}, {byFee: {500: 1_000_000n}});
    expect(ok.q).toMatchObject({destAmount: "2", minDestAmount: "1"});
  });

  it("preflight refuses a pool drained after the quote, before anything is broadcast", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const p = uniswapProvider({rpcUrls: RPC});
    const q = (await p.getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"}))!;
    await expect(p.preflightDeposit!(q, await p.buildDeposit(q))).resolves.toBeUndefined();
    // same output as quoted (above the minimum), but the pool now stops at the price bound
    vi.stubGlobal("fetch", rpcStub({sqrtAfter: {500: SQRT_FLOOR}}));
    await expect(p.preflightDeposit!(q, await p.buildDeposit(q))).rejects.toThrow(/partial fill\) — the pool can no longer take this swap\. Nothing was sent/);
    vi.stubGlobal("fetch", rpcStub({byFee: {}, multiHop: 1_000_000n}));
    const path = (await p.getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"}))!;
    expect(path.providerData!.path).toMatch(/^0x/);
    await expect(p.preflightDeposit!(path, await p.buildDeposit(path))).resolves.toBeUndefined();
    vi.stubGlobal("fetch", rpcStub({byFee: {}, multiHop: 1_000_000n, multiHopSqrtAfter: [MID_SQRT_PRICE, SQRT_CEIL]}));
    await expect(p.preflightDeposit!(path, await p.buildDeposit(path))).rejects.toThrow(/partial fill/);
  });

  it("USDT0 is a hop token where the catalog has it (Ink), skipped where it does not resolve (Ethereum)", async () => {
    expect(HOP_SYMBOLS).toContain("USDT0");
    const ink = "eip155:57073";
    const usdt0 = ccAsset(ink, "USDT0")!.contract!;
    const inkUsdc = ccAsset(ink, "USDC")!.contract!;
    const quoted: string[] = [];
    const stub = rpcStub({byFee: {}, multiHop: 1_000_000n});
    vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
      for (const c of JSON.parse(String(init?.body)) as {params: [{data?: string}]}[]) if (c.params[0]?.data) quoted.push(c.params[0].data.toLowerCase());
      return stub(url, init);
    }) as typeof fetch);
    // Ink's deployment, answered by the Ethereum stub's factory/WETH (an override of the same shape)
    const p = uniswapProvider({rpcUrls: {57073: ["https://rpc.test"]}, deployments: {57073: {...D}}});
    const q = await p.getQuote({sourceChain: ink, destChain: ink, destAddress: ME, refundAddress: ME, sourceToken: "ETH", destToken: inkUsdc, amountIn: "10000000000000000"});
    expect(q).not.toBeNull();
    expect(quoted.some((d) => d.includes(usdt0.slice(2).toLowerCase()))).toBe(true);
    expect(ccAsset("eip155:1", "USDT0")).toBeUndefined();
    quoted.length = 0;
    vi.stubGlobal("fetch", (async (url: string, init?: RequestInit) => {
      for (const c of JSON.parse(String(init?.body)) as {params: [{data?: string}]}[]) if (c.params[0]?.data) quoted.push(c.params[0].data);
      return rpcStub()(url, init);
    }) as typeof fetch);
    expect(await uniswapProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000"})).not.toBeNull();
    // Ethereum: 4 direct tiers + 9 two-pool routes through USDT (WETH and USDC are the pair's own tokens) — no USDT0 slot
    expect(quoted.filter((d) => d.startsWith("0xc6a5026a") || d.startsWith("0xcdca1753"))).toHaveLength(4 + 9 + 1);
  });

  it("native in ends with refundETH(); the verifier accepts it there (and builds without it), nowhere else", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const params = {...base, sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000"};
    const q = (await uniswapProvider({rpcUrls: RPC}).getQuote(params))!;
    const legs = legsOf(q.txRequest!.data!);
    expect(legs).toHaveLength(2);
    expect(legs[1]).toBe(encodeFunctionData({abi: ABI, functionName: "refundETH"}));
    expect(uniswapVerifyQuote(params, q)).toBeNull();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
    const withLegs = (l: Hex[]) => ({...q, txRequest: {...q.txRequest!, data: encodeFunctionData({abi: ABI, functionName: "multicall", args: [deadline, l]})}});
    const refund = encodeFunctionData({abi: ABI, functionName: "refundETH"});
    expect(uniswapVerifyQuote(params, withLegs([legs[0]!]))).toBeNull(); // a backend still on the previous build
    expect(uniswapVerifyQuote(params, withLegs([refund, legs[0]!]))).toMatch(/2 legs, not a swap \(and a refund\)/);
    expect(uniswapVerifyQuote(params, withLegs([legs[0]!, refund, refund]))).toMatch(/3 legs, not a swap \(and a refund\)/);
    expect(uniswapVerifyQuote(params, withLegs([legs[0]!, encodeFunctionData({abi: ABI, functionName: "sweepToken", args: [USDC, 0n, ME]})]))).toMatch(/2 legs, not a swap \(and a refund\)/);
    // a token input carries no refund
    vi.stubGlobal("fetch", rpcStub());
    const tokenParams = {...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"};
    const t = (await uniswapProvider({rpcUrls: RPC}).getQuote(tokenParams))!;
    expect(legsOf(t.txRequest!.data!)).toHaveLength(1);
    const tokenWithRefund = {...t, txRequest: {...t.txRequest!, data: encodeFunctionData({abi: ABI, functionName: "multicall", args: [deadline, [...legsOf(t.txRequest!.data!), refund]]})}};
    expect(uniswapVerifyQuote(tokenParams, tokenWithRefund)).toMatch(/2 legs, not a swap$/);
  });

  it("the refund leg's gas rides on the limit", async () => {
    vi.stubGlobal("fetch", rpcStub({quoterGas: 90_000n}));
    const q = await uniswapProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000"});
    expect(q!.txRequest!.gasLimit).toBe("265000"); // 90k × 1.5 + 120k router + 10k refund
  });
});
