import {afterEach, describe, expect, it, vi} from "vitest";
import {encodeFunctionData} from "viem";
import {describeProtocolBehaviour, describeProtocolModule} from "@anywalletkit/conformance";
import {fyndProvider} from "../src/provider.js";
import {FyndSwap2Protocol} from "../src/protocol.js";
import {FYND_CHAINS, ROUTER_NATIVE, TYCHO_ROUTER_ABI} from "../src/router.js";

afterEach(() => vi.unstubAllGlobals());

const ZERO = "0x0000000000000000000000000000000000000000";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";
const ME = "0x4444444444444444444444444444444444444444";
const ROUTER = FYND_CHAINS[8453]!.router;
const NO_FEE = {clientFeeBps: 0, clientFeeReceiver: ZERO, maxClientContribution: 0n, deadline: 0n, clientSignature: "0x"} as const;
const RPC = {8453: ["https://rpc.test"]};

interface Stub {
  out?: bigint;
  routerFee?: bigint;
  status?: string;
  http?: number;
  /** Rewrite the encoded transaction the "API" returns (a compromised or buggy endpoint). */
  tamper?: (tx: {to: string; value: string; data: string}, order: Record<string, string>) => {to: string; value: string; data: string};
  amountInEcho?: string;
  clientFee?: string;
  ethCallRevert?: boolean;
  protocols?: string[];
  calls?: {url: string; body: Record<string, unknown>; headers: Record<string, string>}[];
}

function stub(o: Stub = {}): typeof fetch {
  return vi.fn(async (url: string, init: {body: string; headers?: Record<string, string>}) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    o.calls?.push({url, body, headers: init.headers ?? {}});
    if (url.includes("/quote")) {
      if (o.http) return new Response("{}", {status: o.http});
      const order = (body.orders as Record<string, string>[])[0]!;
      const enc = (body.options as {encoding_options: {slippage: string}}).encoding_options;
      const amountIn = BigInt(order.amount!);
      const gross = o.out ?? 400_000_000_000_000_000n;
      const routerFee = o.routerFee ?? 0n;
      const bps = BigInt(Math.round(Number(enc.slippage) * 10_000));
      const maxSlip = ((gross - routerFee) * bps) / 10_000n;
      const min = gross - routerFee - maxSlip;
      const sentinel = (t: string) => (t === ZERO ? ROUTER_NATIVE : t);
      const data = encodeFunctionData({abi: TYCHO_ROUTER_ABI, functionName: "singleSwap", args: [amountIn, sentinel(order.token_in!) as `0x${string}`, sentinel(order.token_out!) as `0x${string}`, gross, min, order.receiver as `0x${string}`, NO_FEE as never, "0xdeadbeef"]});
      let tx: {to: string; value: string; data: string} = {to: ROUTER, value: order.token_in === ZERO ? amountIn.toString() : "0", data};
      if (o.tamper) tx = o.tamper(tx, order);
      return new Response(JSON.stringify({
        orders: [{
          status: o.status ?? "success",
          amount_in: o.amountInEcho ?? amountIn.toString(),
          amount_out: gross.toString(),
          gas_estimate: "150000",
          price_impact_bps: 4,
          route: {swaps: (o.protocols ?? ["uniswap_v3", "vm:balancer"]).map((protocol) => ({protocol}))},
          fee_breakdown: {router_fee: routerFee.toString(), client_fee: o.clientFee ?? "0", max_slippage: maxSlip.toString(), min_amount_received: min.toString()},
          transaction: tx,
        }],
        total_gas_estimate: "150000",
        solve_time_ms: 12,
      }));
    }
    const rpc = body as {method: string};
    if (rpc.method === "eth_call") return new Response(JSON.stringify(o.ethCallRevert ? {jsonrpc: "2.0", id: 1, error: {message: "execution reverted: TychoRouter__NegativeSlippage"}} : {jsonrpc: "2.0", id: 1, result: "0x"}));
    if (rpc.method === "eth_getTransactionReceipt") return new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result: {status: "0x1"}}));
    return new Response("{}", {status: 404});
  }) as unknown as typeof fetch;
}

const params = (over: Record<string, unknown> = {}) => ({
  sourceChain: "eip155:8453", sourceToken: "USDC", destChain: "eip155:8453", destToken: WETH,
  amountIn: "1000000000", destAddress: ME, refundAddress: ME, slippageBps: 50, ...over,
});

describe("fyndProvider.getQuote", () => {
  it("quotes through the hosted API with the key, and returns the checked router transaction", async () => {
    const calls: NonNullable<Stub["calls"]> = [];
    vi.stubGlobal("fetch", stub({calls, routerFee: 40_000_000_000_000n}));
    const q = await fyndProvider({apiKey: "k-1"}).getQuote(params() as never);
    expect(calls[0]!.url).toBe("https://fynd-api.propellerheads.xyz/v1/base/quote");
    expect(calls[0]!.headers.authorization).toBe("k-1");
    expect(calls[0]!.body).toMatchObject({orders: [{token_in: USDC, token_out: WETH, amount: "1000000000", side: "sell", sender: ME, receiver: ME}], options: {encoding_options: {slippage: "0.005", transfer_type: "transfer_from"}, route_filter: {exclude_protocols: ["uniswap_v4_hooks"]}}});
    expect(q).toMatchObject({provider: "fynd", intentId: "fynd:8453", sourceAmount: "1000000000", destAmount: (400_000_000_000_000_000n - 40_000_000_000_000n).toString()});
    expect(q!.txRequest).toMatchObject({to: ROUTER, value: "0", chainId: 8453, approvalAddress: ROUTER});
    expect(BigInt(q!.minDestAmount!)).toBe(((400_000_000_000_000_000n - 40_000_000_000_000n) * 9950n) / 10_000n);
    expect(q!.providerData).toMatchObject({protocols: "uniswap_v3,vm:balancer", priceImpactBps: "4", routerFee: "40000000000000"});
  });

  it("uses a self-hosted server for a chain instead of the hosted API, without the key", async () => {
    const calls: NonNullable<Stub["calls"]> = [];
    vi.stubGlobal("fetch", stub({calls}));
    await fyndProvider({apiKey: "k-1", selfHosted: {8453: "https://fynd-base.internal/"}}).getQuote(params() as never);
    expect(calls[0]!.url).toBe("https://fynd-base.internal/v1/quote");
    expect(calls[0]!.headers.authorization).toBeUndefined();
  });

  it("native input: zero address to the API, value = amount, no approval", async () => {
    vi.stubGlobal("fetch", stub({out: 3_000_000_000n}));
    const q = await fyndProvider({apiKey: "k"}).getQuote(params({sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000000"}) as never);
    expect(q!.txRequest).toMatchObject({value: "1000000000000000000"});
    expect(q!.txRequest!.approvalAddress).toBeUndefined();
  });

  const refusals: [string, Stub, Record<string, unknown>, RegExp][] = [
    ["a transaction paying someone else", {tamper: (tx, order) => ({...tx, data: tx.data.replace(order.receiver!.slice(2).toLowerCase(), "33".repeat(20))})}, {}, /pays 0x3333/],
    ["a transaction to another contract", {tamper: (tx) => ({...tx, to: "0x2222222222222222222222222222222222222222"})}, {}, /not the Tycho router/],
    ["an echoed amount that differs", {amountInEcho: "999"}, {}, /quoted 999/],
    ["a client fee in the breakdown", {clientFee: "1"}, {}, /client fee/],
    ["a solver failure, by name", {status: "insufficient_liquidity"}, {}, /not enough liquidity/],
    ["a rejected key", {http: 401}, {}, /API key rejected/],
    ["rate limiting", {http: 429}, {}, /rate limited/],
    ["no route", {http: 422}, {}, /no route/],
    ["a minimum under the caller's floor", {}, {minAmountOut: "999999999999999999999"}, /floor breach/],
    ["cross-chain", {}, {destChain: "eip155:1"}, /same-chain/],
    ["a route through an excluded protocol the server returned anyway", {protocols: ["uniswap_v3", "uniswap_v4_hooks"]}, {}, /goes through uniswap_v4_hooks/],
    ["an unconfigured chain", {}, {sourceChain: "eip155:10", destChain: "eip155:10"}, /not configured/],
  ];
  for (const [name, s, over, msg] of refusals) {
    it(`refuses ${name} — named, never a silent null`, async () => {
      vi.stubGlobal("fetch", stub(s));
      const reasons: string[] = [];
      const q = await fyndProvider({apiKey: "k"}).getQuote(params({...over, onRefusal: (r: string) => reasons.push(r)}) as never);
      expect(q).toBeNull();
      expect(reasons.join(" | ")).toMatch(msg);
    });
  }

  it("serves no chain without a key or a self-hosted server", () => {
    const p = fyndProvider({});
    expect(p.supportsChain!("eip155:8453")).toBe(false);
    expect(fyndProvider({selfHosted: {1: "http://localhost:3000"}}).supportsChain!("eip155:1")).toBe(true);
  });
});

describe("fyndProvider quote-time simulation (native input)", () => {
  it("refuses a native-input route whose exact transaction reverts now, and keeps one that executes", async () => {
    const reasons: string[] = [];
    vi.stubGlobal("fetch", stub({ethCallRevert: true, out: 3_000_000_000n, protocols: ["uniswap_v3"]}));
    const native = params({sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000000", onRefusal: (r: string) => reasons.push(r)});
    expect(await fyndProvider({apiKey: "k", rpcUrls: RPC}).getQuote(native as never)).toBeNull();
    expect(reasons.join()).toMatch(/does not execute on-chain/);
    vi.stubGlobal("fetch", stub({out: 3_000_000_000n}));
    expect(await fyndProvider({apiKey: "k", rpcUrls: RPC}).getQuote(native as never)).not.toBeNull();
  });

  it("lets the caller choose the exclusions (none at all, or a family prefix)", async () => {
    const calls: NonNullable<Stub["calls"]> = [];
    vi.stubGlobal("fetch", stub({calls}));
    await fyndProvider({apiKey: "k", excludeProtocols: []}).getQuote(params() as never);
    await fyndProvider({apiKey: "k", excludeProtocols: ["fallback:"]}).getQuote(params() as never);
    expect((calls[0]!.body.options as Record<string, unknown>).route_filter).toBeUndefined();
    expect((calls[1]!.body.options as {route_filter: unknown}).route_filter).toEqual({exclude_protocols: ["fallback:"]});
  });
});

describe("fyndProvider.preflightDeposit", () => {
  it("simulates the exact transaction from the sender and refuses when it would revert", async () => {
    vi.stubGlobal("fetch", stub({ethCallRevert: true}));
    const p = fyndProvider({apiKey: "k", rpcUrls: RPC});
    const q = (await p.getQuote(params() as never))!;
    const tx = await p.buildDeposit(q);
    await expect(p.preflightDeposit!(q, tx)).rejects.toThrow(/would revert now/);
    vi.stubGlobal("fetch", stub());
    await expect(p.preflightDeposit!(q, tx)).resolves.toBeUndefined();
  });

  it("tracks the swap by its receipt", async () => {
    vi.stubGlobal("fetch", stub());
    await expect(fyndProvider({apiKey: "k", rpcUrls: RPC}).trackIntent({intentId: "fynd:8453", sourceTxHash: "0xabc"})).resolves.toEqual({state: "completed", destTxHash: "0xabc"});
  });
});

describeProtocolModule("protocol-swap2-fynd", {
  type: "swap2",
  Protocol: FyndSwap2Protocol,
  config: {fromChain: "eip155:8453", skipAccountChainCheck: true, apiKey: "k"},
  samples: {getSupportedChains: []}, mustResolve: ["getSupportedChains"],
});

describeProtocolBehaviour("protocol-swap2-fynd", {
  type: "swap2",
  Protocol: FyndSwap2Protocol,
  config: {fromChain: "eip155:8453", apiKey: "k"},
  fixtures: [
    {name: "USDC → WETH (exact approve to the Tycho router, then singleSwap)", options: {fromToken: "USDC", toToken: WETH, toChain: 8453, recipient: ME, fromTokenAmount: 1_000_000_000n, minAmountOut: 390_000_000_000_000_000n}, fetch: stub(), account: {address: ME, chain: "eip155:8453"}, own: [ME], spender: ROUTER, sourceToken: USDC},
    {name: "ETH → USDC (native value, no approval)", options: {fromToken: "ETH", toToken: USDC, toChain: 8453, recipient: ME, fromTokenAmount: 10n ** 18n, minAmountOut: 2_900_000_000n}, fetch: stub({out: 3_000_000_000n}), account: {address: ME, chain: "eip155:8453"}, own: [ME]},
  ],
});
