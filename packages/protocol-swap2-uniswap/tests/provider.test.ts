import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeFunctionData, parseAbi, type Hex} from "viem";
import {uniswapProvider} from "../src/provider.js";
import {ADDRESS_THIS} from "../src/addresses.js";
import {D, ME, RPC, USDC, USDT, rpcStub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const ROUTER = parseAbi([
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
]);
const legs = (data: string) => {
  const m = decodeFunctionData({abi: ROUTER, data: data as Hex});
  expect(m.functionName).toBe("multicall");
  const [deadline, inner] = m.args as [bigint, Hex[]];
  return {deadline, inner: inner.map((d) => decodeFunctionData({abi: ROUTER, data: d}))};
};
const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME};

describe("Uniswap v3 provider", () => {
  it("quotes every fee tier on-chain, takes the best, and builds an exact-input swap to the recipient", async () => {
    vi.stubGlobal("fetch", rpcStub({byFee: {100: 900_000n, 500: 1_000_000n, 3000: 990_000n}}));
    const q = await uniswapProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"});
    expect(q).toMatchObject({provider: "uniswap", intentId: "uniswap:1", destAmount: "1000000", minDestAmount: "995000", depositAddress: ""});
    expect(q!.txRequest).toMatchObject({to: D.router, value: "0", chainId: 1, approvalAddress: D.router});
    const {deadline, inner} = legs(q!.txRequest!.data!);
    expect(Number(deadline)).toBeGreaterThan(Date.now() / 1000);
    expect(inner).toHaveLength(1);
    expect(inner[0]!.functionName).toBe("exactInputSingle");
    expect(inner[0]!.args[0]).toMatchObject({tokenIn: USDC, tokenOut: USDT, fee: 500, recipient: ME, amountIn: 1_000_000n, amountOutMinimum: 995_000n});
  });

  it("native in: the router wraps msg.value — no approval, tokenIn = WETH", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const q = await uniswapProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000"});
    expect(q!.txRequest).toMatchObject({value: "1000000000000000"});
    expect(q!.txRequest!.approvalAddress).toBeUndefined();
    expect(legs(q!.txRequest!.data!).inner[0]!.args[0]).toMatchObject({tokenIn: D.weth, tokenOut: USDC, recipient: ME});
  });

  it("native out: output stays in the router, then unwrapWETH9(min, recipient)", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const q = await uniswapProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "USDC", destToken: "0x0000000000000000000000000000000000000000", amountIn: "1000000"});
    const {inner} = legs(q!.txRequest!.data!);
    expect(inner[0]!.args[0]).toMatchObject({tokenOut: D.weth, recipient: ADDRESS_THIS, amountOutMinimum: 995_000n});
    expect(inner[1]).toMatchObject({functionName: "unwrapWETH9", args: [995_000n, ME]});
  });

  it("honours the caller's slippage and refuses a floor breach by name", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const p = uniswapProvider({rpcUrls: RPC});
    const q = await p.getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000", slippageBps: 100});
    expect(q!.minDestAmount).toBe("990000");
    let why = "";
    expect(await p.getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000", minAmountOut: "999000", onRefusal: (r) => { why = r; }})).toBeNull();
    expect(why).toBe("uniswap: floor breach (min=995000 < floor=999000)");
  });

  it("refuses when the pinned router/quoter no longer describe one deployment", async () => {
    vi.stubGlobal("fetch", rpcStub({badFactory: true}));
    let why = "";
    expect(await uniswapProvider({rpcUrls: RPC}).getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000", onRefusal: (r) => { why = r; }})).toBeNull();
    expect(why).toMatch(/do not match the pinned deployment/);
  });

  it("names every other refusal: cross-chain, unknown chain, wrap, no pool", async () => {
    vi.stubGlobal("fetch", rpcStub({byFee: {}}));
    const p = uniswapProvider({rpcUrls: RPC});
    const reasons: string[] = [];
    const on = (r: string) => reasons.push(r);
    await p.getQuote({...base, destChain: "eip155:8453", sourceToken: "USDC", destToken: USDT, amountIn: "1", onRefusal: on});
    await p.getQuote({...base, sourceChain: "eip155:8453", destChain: "eip155:8453", sourceToken: "USDC", destToken: USDT, amountIn: "1", onRefusal: on});
    await p.getQuote({...base, sourceToken: "ETH", destToken: D.weth, amountIn: "1", onRefusal: on});
    await p.getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1", onRefusal: on});
    expect(reasons).toEqual([
      "uniswap: same-chain swaps only",
      "uniswap: no Uniswap v3 deployment or RPC for eip155:8453",
      "uniswap: that is a wrap/unwrap, not a swap",
      "uniswap: no Uniswap v3 pool route for this pair and amount",
    ]);
  });

  it("fails over to the next RPC and offers only chains it has an RPC for", async () => {
    const stub = rpcStub({down: ["https://down.test"]});
    vi.stubGlobal("fetch", stub);
    const p = uniswapProvider({rpcUrls: {1: ["https://down.test", "https://rpc.test"]}});
    expect(await p.getQuote({...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"})).not.toBeNull();
    expect(stub.urls).toContain("https://rpc.test");
    expect(p.supportsRoute({chain: "eip155:1", token: "USDC"}, {chain: "eip155:1", token: USDT})).toBe(true);
    expect(p.supportsRoute({chain: "eip155:8453", token: "USDC"}, {chain: "eip155:8453", token: USDT})).toBe(false);
    expect(p.supportsRoute({chain: "eip155:1", token: "USDC"}, {chain: "eip155:10", token: USDT})).toBe(false);
  });

  it("tracks the swap by its mined receipt", async () => {
    const p = uniswapProvider({rpcUrls: RPC});
    vi.stubGlobal("fetch", rpcStub({receipt: null}));
    expect(await p.trackIntent({intentId: "uniswap:1", sourceTxHash: "0xabc"})).toEqual({state: "pending"});
    vi.stubGlobal("fetch", rpcStub({receipt: "0x1"}));
    expect(await p.trackIntent({intentId: "uniswap:1", sourceTxHash: "0xabc"})).toEqual({state: "completed", destTxHash: "0xabc"});
    vi.stubGlobal("fetch", rpcStub({receipt: "0x0"}));
    expect(await p.trackIntent({intentId: "uniswap:1", sourceTxHash: "0xabc"})).toEqual({state: "failed"});
    expect(await p.trackIntent({intentId: "uniswap:1"})).toEqual({state: "pending"});
  });
});
