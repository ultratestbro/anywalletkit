import {afterEach, describe, expect, it, vi} from "vitest";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {CrossChainRouter} from "../src/router.js";
import {RouterSwap2Protocol} from "../src/swap2/router.js";

const params: QuoteParams = {sourceChain: "eip155:1", sourceToken: "USDC", destChain: "eip155:8453", destToken: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", amountIn: "100", destAddress: "0x3333333333333333333333333333333333333333"};
const options = {fromToken: "USDC", toToken: params.destToken, toChain: params.destChain, fromTokenAmount: 100n, minAmountOut: 90n, recipient: params.destAddress};
const target = "0x2222222222222222222222222222222222222222";
const tx = {to: target, data: "0xdeadbeef", value: "0", chainId: 1, approvalAddress: target};
function quote(routeId: string, p = params): Quote {
  return {provider: "multi", routeId, intentId: `intent-${routeId}`, depositAddress: "", depositMemo: null, txRequest: {...tx}, sourceAmount: p.amountIn, destAmount: routeId === "bus" ? "100" : "95", minDestAmount: routeId === "bus" ? "100" : "95", feeUsd: 0, etaSeconds: routeId === "bus" ? 300 : 30, reliability: 1, validUntilMs: Date.now() + 60_000, providerData: {mode: routeId}};
}
function provider(over: Partial<CrossChainProvider> = {}): CrossChainProvider {
  return {name: "multi", enabled: () => true, supportsRoute: () => true,
    getQuote: async (p) => quote(p.routeId ?? "taxi", p),
    getQuotes: async (p) => [quote("taxi", p), quote("bus", p)],
    buildDeposit: async (q) => ({chain: "eip155:1", ...q.txRequest!, to: target, value: "0"}),
    trackIntent: async () => ({state: "pending"}), ...over};
}
afterEach(() => vi.restoreAllMocks());

describe("multiple candidates from one provider", () => {
  it("ranks both modes and exposes stable selectors through the public picker", async () => {
    const p = provider();
    const set = (await new CrossChainRouter([p]).getQuotes(params))!;
    expect(set.best.routeId).toBe("bus"); expect(set.fastest!.routeId).toBe("taxi");
    const api = new RouterSwap2Protocol(undefined, {fromChain: "eip155:1", providers: [p]});
    const routes = await api.quoteSwap2Routes(options);
    expect(routes.map((r) => [r.provider, r.routeId, r.quote.routeId])).toEqual([["multi", "bus", "bus"], ["multi", "taxi", "taxi"]]);
    expect((await api.using("multi", "bus").quoteSwap2(options)).routeId).toBe("bus");
    await expect(api.using("multi", "bus").quoteSwap2({...options, routeId: "taxi"})).rejects.toThrow(/conflicts/);
    expect((await api.using("multi").quoteSwap2(options)).toTokenAmountMin).toBe(100n);
  });

  it("uses a single selected live quote and refuses silent mode substitution", async () => {
    const one = vi.fn(async (p: QuoteParams) => quote("taxi", p));
    const many = vi.fn(async (p: QuoteParams) => [quote("bus", p)]);
    const router = new CrossChainRouter([provider({getQuote: one, getQuotes: many})]);
    expect(await router.getQuotes({...params, dry: false, routeId: "bus"})).toBeNull();
    expect(one).toHaveBeenCalledOnce(); expect(many).not.toHaveBeenCalled();
    expect(await router.getQuotes({...params, dry: false, routeId: "taxi", minAmountOut: "96"})).toBeNull();
  });

  it("rejects an unnamed default path from a multi-route provider", async () => {
    const router = new CrossChainRouter([provider({getQuote: async () => {
      const {routeId: _id, ...missing} = quote("taxi"); return missing;
    }})]);
    expect(await router.getQuotes({...params, dry: false})).toBeNull();
  });

  it("isolates malformed, duplicate, expired and floor-breaking candidates", async () => {
    const router = new CrossChainRouter([provider({getQuotes: async () => [
      quote("bus"), {...quote("expired"), validUntilMs: Date.now() - 1},
      quote("duplicate"), quote("duplicate"), {...quote("bad"), provider: "attacker"},
      {...quote("floor"), minDestAmount: "1"}, quote(""), null as never,
    ]})]);
    const set = (await router.getQuotes({...params, minAmountOut: "90"}))!;
    expect(set.quotes.map((q) => q.routeId)).toEqual(["bus"]);
    expect(set.rejections.length).toBe(7);
    expect(await new CrossChainRouter([provider({getQuotes: async () => Array.from({length: 33}, (_, i) => quote(String(i)))})]).getQuotes(params)).toBeNull();
  });

  it("does not share mutable candidate data with observers or concurrent requests", async () => {
    const router = new CrossChainRouter([provider()]);
    const [a, b] = await Promise.all([
      router.getQuotes(params, {onUpdate: (set) => {
        set.best.providerData!.mode = "tampered";
        set.best.txRequest!.to = "tampered";
        set.best.sourceAmount = "1";
      }}),
      router.getQuotes({...params, amountIn: "200"}),
    ]);
    expect(a!.best.providerData!.mode).toBe("bus"); expect(a!.best.txRequest!.to).toBe(target);
    expect(a!.best.sourceAmount).toBe("100"); expect(b!.best.sourceAmount).toBe("200");
  });

  it("drops candidates that expire while another provider is still answering", async () => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const slow = provider({name: "slow", getQuote: async () => {
      await new Promise((r) => setTimeout(r, 5)); now += 100;
      return {...quote("slow"), provider: "slow"};
    }});
    delete slow.getQuotes;
    const fast = provider({getQuotes: async () => [{...quote("bus"), validUntilMs: now + 50}]});
    expect((await new CrossChainRouter([fast, slow]).getQuotes(params))!.quotes.map((q) => q.provider)).toEqual(["slow"]);
  });

  it.each([false, true])("pins provider/mode/floor after approval expiry (substitution=%s)", async (substitute) => {
    let now = 1_800_000_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const requests: QuoteParams[] = [], sent: string[] = [], reviewed: string[] = [];
    const p = provider({getQuote: async (p) => {
      requests.push(p);
      const q = quote(substitute && requests.length > 1 ? "taxi" : "bus", p);
      return {...q, validUntilMs: now + (requests.length === 1 ? 50 : 60_000)};
    }});
    let competingCalls = 0;
    const other = provider({name: "other", getQuote: async (p) => {
      competingCalls++;
      return {...quote("taxi", p), provider: "other", destAmount: "94", minDestAmount: "94"};
    }});
    delete other.getQuotes;
    const account = {getAddress: async () => params.destAddress, getChainId: async () => 1,
      getAllowance: async () => 0n,
      sendTransaction: async (tx: {data?: string}) => { sent.push(tx.data === "0xdeadbeef" ? "deposit" : "approve"); return {hash: `0x${sent.length}`}; },
      waitForTransaction: async () => { now += 100; },
    };
    const api = new RouterSwap2Protocol(account as never, {fromChain: "eip155:1", providers: [p, other], reviewExecution: async (plan) => { reviewed.push(plan.routeId!); }});
    if (substitute) {
      await expect(api.swap2(options)).rejects.toThrow(/no route/);
      expect(sent).toEqual(["approve", "approve"]); // original approval, then revoke
    } else {
      const result = await api.swap2(options);
      expect(result.id).toMatch(/^awk1\./);
      expect(sent).toEqual(["approve", "deposit"]);
      expect(reviewed).toEqual(["bus"]);
    }
    expect(competingCalls).toBe(1);
    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({routeId: "bus", minAmountOut: "90", amountIn: "100"});
  });
});
