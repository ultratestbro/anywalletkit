// Scan 2026-10-28, F1: uniswapPins pinned only SwapRouter02, so a remote backend wrote the swap's recipient (or a
// pull + sweepToken) and the engine sent it. The pins now carry uniswapVerifyQuote, which opens the multicall on the
// client. The attacks are refused before anything is approved; the provider's real builds still pass and execute
// through remoteProvider + pins + engine, behind the real swap2 server handler.
import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeFunctionData, parseAbi, type Hex} from "viem";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import type {CrossChainProvider, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {ADDRESS_THIS, UNISWAP_V3, uniswapPins, uniswapVerifyQuote} from "../src/addresses.js";
import {uniswapProvider} from "../src/provider.js";
import {D, ME, RPC, USDC, USDT, rpcStub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());
const noTx = ({txRequest: _tx, ...q}: Quote): Quote => q;

const ATTACKER = "0x9999999999999999999999999999999999999999";
const WETH = D.weth;
const ZERO = "0x0000000000000000000000000000000000000000";
const ROUTER = UNISWAP_V3[1]!.router;
const ABI = parseAbi([
  "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) payable returns (uint256 amountOut)",
  "function exactInput((bytes path, address recipient, uint256 amountIn, uint256 amountOutMinimum) params) payable returns (uint256 amountOut)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
  "function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function pull(address token, uint256 value) payable",
  "function sweepToken(address token, uint256 amountMinimum, address recipient) payable",
]);
const deadline = BigInt(Math.floor(Date.now() / 1000) + 600);
const multicall = (...legs: Hex[]) => encodeFunctionData({abi: ABI, functionName: "multicall", args: [deadline, legs]});
const single = (o: Partial<{tokenIn: string; tokenOut: string; recipient: string; amountIn: bigint; amountOutMinimum: bigint; sqrtPriceLimitX96: bigint}> = {}) =>
  encodeFunctionData({abi: ABI, functionName: "exactInputSingle", args: [{tokenIn: USDC, tokenOut: USDT, fee: 500, recipient: ME, amountIn: 1_000_000n, amountOutMinimum: 995_000n, sqrtPriceLimitX96: 0n, ...o} as never]});

/** A backend that answers every quote with the router call `txFor` writes (the repro's malicious backend). */
function evilBackend(txFor: (params: QuoteParams) => {data: Hex; value: string; approval: boolean}) {
  return (async (url: string, init: {body: string}) => {
    const action = String(url).split("/").at(-1);
    const body = JSON.parse(init.body) as {params?: QuoteParams; quote?: Quote};
    const reply = (v: unknown) => new Response(JSON.stringify(v), {status: 200, headers: {"content-type": "application/json"}});
    if (action === "quote") {
      const p = body.params!;
      const t = txFor(p);
      return reply({
        provider: "uniswap", intentId: `i-${Math.random()}`, depositAddress: "", depositMemo: null,
        sourceAmount: p.amountIn, destAmount: "999999999999999999999", minDestAmount: p.minAmountOut ?? "1",
        feeUsd: 0, etaSeconds: 1, reliability: 1, validUntilMs: Date.now() + 60_000,
        txRequest: {to: ROUTER, data: t.data, value: t.value, chainId: 1, gasLimit: "300000", ...(t.approval ? {approvalAddress: ROUTER} : {})},
      } satisfies Quote);
    }
    if (action === "build") {
      const tx = body.quote!.txRequest!;
      return reply({...tx, chain: "eip155:1", to: tx.to!, value: tx.value ?? "0"} satisfies UnsignedTx);
    }
    return reply({});
  }) as unknown as typeof fetch;
}

/** The real provider behind the real swap2 handler, as the app's backend runs it. */
function realBackend(): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [uniswapProvider({rpcUrls: RPC})], sealSecret: "test-seal-secret-that-is-at-least-32-bytes-long", guard: () => {}, subject: () => "alice"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "alice");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}

/** The app: remoteProvider({name: "uniswap", baseUrl, ...uniswapPins}) under the engine, with a recording account. */
function app(fetchImpl: typeof fetch) {
  const sent: Array<{to: string; data?: string; value?: string | bigint}> = [];
  const account = {
    getAddress: async () => ME, getChainId: async () => 1, getAllowance: async () => 0n, waitForTransaction: async () => {},
    sendTransaction: async (tx: {to: string; data?: string; value?: string}) => { sent.push(tx); return {hash: `0x${String(sent.length).padStart(64, "0")}`}; },
  };
  const provider: CrossChainProvider = remoteProvider({name: "uniswap", baseUrl: "https://backend.example/api/v2/swap2", fetchImpl, supportsSameChain: true, ...uniswapPins});
  class P extends SingleProviderSwap2 { protected readonly provider = provider; protected chainSupported(): boolean { return true; } }
  return {sent, swap2: new P(account as never, {fromChain: "eip155:1"})};
}

describe("scan 2026-10-28 F1: a remote Uniswap router call is opened on the client", () => {
  it("the repro's attacks are refused before anything is approved: recipient = attacker, pull + sweepToken, native to the attacker", async () => {
    const attacks: Array<[string, (p: QuoteParams) => {data: Hex; value: string; approval: boolean}, string, RegExp]> = [
      ["recipient", (p) => ({data: multicall(single({tokenOut: WETH, recipient: ATTACKER, amountIn: BigInt(p.amountIn), amountOutMinimum: 0n})), value: "0", approval: true}), "USDC", /the swap's input, minimum or price limit|pays 0x9999/],
      ["pull + sweep", (p) => ({data: multicall(encodeFunctionData({abi: ABI, functionName: "pull", args: [USDC, BigInt(p.amountIn)]}), encodeFunctionData({abi: ABI, functionName: "sweepToken", args: [USDC, 0n, ATTACKER]})), value: "0", approval: true}), "USDC", /legs, not a swap|is not exactInputSingle/],
      ["native", (p) => ({data: multicall(single({tokenIn: WETH, tokenOut: USDC, recipient: ATTACKER, amountIn: BigInt(p.amountIn), amountOutMinimum: 1n})), value: p.amountIn, approval: false}), "ETH", /pays 0x9999/],
    ];
    for (const [what, txFor, fromToken, why] of attacks) {
      const {sent, swap2} = app(evilBackend(txFor));
      const toToken = fromToken === "ETH" ? USDC : WETH;
      const outcome = await swap2.swap2({fromToken, toToken, toChain: 1, recipient: ME, fromTokenAmount: fromToken === "ETH" ? 10n ** 16n : 1_000_000n, minAmountOut: 1n} as never).then(() => "RESOLVED", (e: Error) => e.message);
      expect(outcome, what).toMatch(/fails this app's own check/);
      expect(outcome, what).toMatch(why);
      expect(sent, what).toEqual([]);
    }
  });

  it("uniswapVerifyQuote refuses every other shape: extra legs, another router call, another token, value or minimum", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const params: QuoteParams = {sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "USDC", destToken: USDT, amountIn: "1000000", destAddress: ME, refundAddress: ME};
    const real = (await uniswapProvider({rpcUrls: RPC}).getQuote(params))!;
    expect(uniswapVerifyQuote(params, real)).toBeNull();
    const withTx = (over: Partial<NonNullable<Quote["txRequest"]>>, q: Partial<Quote> = {}): Quote => ({...real, ...q, txRequest: {...real.txRequest!, ...over}});
    const cases: Array<[string, Quote, RegExp]> = [
      ["no router call (a deposit address)", {...noTx(real), depositAddress: ATTACKER}, /no router call/],
      ["another target", withTx({to: ATTACKER}), /not the SwapRouter/],
      ["value on a token input", withTx({value: "1"}), /attaches no value/],
      ["approval to another spender", withTx({approvalAddress: ATTACKER}), /approves the SwapRouter/],
      ["a bare exactInputSingle", withTx({data: single()}), /exactInputSingle is not multicall/],
      ["multicall(bytes[])", withTx({data: encodeFunctionData({abi: ABI, functionName: "multicall", args: [[single()]]})}), /not multicall\(deadline, legs\)/],
      ["a second swap leg", withTx({data: multicall(single(), single())}), /2 legs/],
      ["sweepToken alone", withTx({data: multicall(encodeFunctionData({abi: ABI, functionName: "sweepToken", args: [USDC, 0n, ATTACKER]}))}), /is not exactInputSingle/],
      ["another output token", withTx({data: multicall(single({tokenOut: WETH}))}), /other tokens/],
      ["a lower minimum", withTx({data: multicall(single({amountOutMinimum: 1n}))}), /minimum/],
      ["a larger input", withTx({data: multicall(single({amountIn: 2_000_000n}))}), /input/],
      ["a price limit", withTx({data: multicall(single({sqrtPriceLimitX96: 1n}))}), /price limit/],
      ["the quote's minimum lowered on the quote", {...real, minDestAmount: "1"}, /minimum/],
      ["cross-chain", real, /same-chain/],
    ];
    for (const [what, q, why] of cases) {
      const p = what === "cross-chain" ? {...params, destChain: "eip155:8453"} : params;
      expect(uniswapVerifyQuote(p, q), what).toMatch(why);
    }
  });

  it("native out: the swap must keep the output in the router and unwrap the quoted minimum to the recipient", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const params: QuoteParams = {sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "USDC", destToken: ZERO, amountIn: "1000000", destAddress: ME, refundAddress: ME};
    const real = (await uniswapProvider({rpcUrls: RPC}).getQuote(params))!;
    expect(uniswapVerifyQuote(params, real)).toBeNull();
    const unwrapTo = (to: string, min = 995_000n) => ({...real, txRequest: {...real.txRequest!, data: multicall(single({tokenOut: WETH, recipient: ADDRESS_THIS}), encodeFunctionData({abi: ABI, functionName: "unwrapWETH9", args: [min, to as Hex]}))}});
    expect(uniswapVerifyQuote(params, unwrapTo(ME))).toBeNull();
    expect(uniswapVerifyQuote(params, unwrapTo(ATTACKER))).toMatch(/unwrap pays someone else/);
    expect(uniswapVerifyQuote(params, unwrapTo(ME, 1n))).toMatch(/unwrap pays someone else or less/);
    expect(uniswapVerifyQuote(params, {...real, txRequest: {...real.txRequest!, data: multicall(single({tokenOut: WETH, recipient: ADDRESS_THIS}))}})).toMatch(/1 legs, not a swap and an unwrap/);
  });

  it("the provider's real builds pass the verifier: direct, native in, native out and a two-pool exactInput path", async () => {
    const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME};
    const runs: Array<[QuoteParams, Parameters<typeof rpcStub>[0]]> = [
      [{...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"}, {}],
      [{...base, sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000"}, {}],
      [{...base, sourceToken: "USDC", destToken: ZERO, amountIn: "1000000", slippageBps: 100}, {}],
      [{...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"}, {byFee: {}, multiHop: 1_000_000n}],
    ];
    for (const [params, stub] of runs) {
      vi.stubGlobal("fetch", rpcStub(stub));
      const q = await uniswapProvider({rpcUrls: RPC}).getQuote(params);
      expect(q, JSON.stringify(params)).not.toBeNull();
      expect(uniswapVerifyQuote(params, q!), JSON.stringify(params)).toBeNull();
      if (stub?.multiHop) expect(q!.providerData!.path).toMatch(/^0x/);
    }
  });

  it("corridor: real builds execute through remoteProvider + uniswapPins + the engine (token in, native in, native out)", async () => {
    vi.stubGlobal("fetch", rpcStub());
    const runs: Array<[string, string, bigint, (sent: Array<{to: string; data?: string}>) => void]> = [
      ["USDC", USDT, 1_000_000n, (sent) => expect(sent.map((t) => t.to.toLowerCase())).toEqual([USDC.toLowerCase(), ROUTER.toLowerCase()])],
      ["ETH", USDC, 10n ** 15n, (sent) => expect(sent.map((t) => t.to.toLowerCase())).toEqual([ROUTER.toLowerCase()])],
      ["USDC", ZERO, 1_000_000n, (sent) => expect(sent.map((t) => t.to.toLowerCase())).toEqual([USDC.toLowerCase(), ROUTER.toLowerCase()])],
    ];
    for (const [fromToken, toToken, amount, check] of runs) {
      const {sent, swap2} = app(realBackend());
      const result = await swap2.swap2({fromToken, toToken, toChain: 1, recipient: ME, fromTokenAmount: amount, minAmountOut: 1n} as never);
      expect(result, `${fromToken} → ${toToken}`).toMatchObject({id: expect.any(String)});
      check(sent);
    }
  });
});
