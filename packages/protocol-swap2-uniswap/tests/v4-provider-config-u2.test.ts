// U2 (UNISWAP-V4-RESEARCH §5.4, decision 6): where v4 "all" is offered and which flows it takes, the standalone protocol
// agreeing with its provider; and the RPC layer's "method not served" classification the Monad fallback rests on.
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {UniswapSwap2Protocol} from "../src/protocol.js";
import {isUnsupportedMethod, type RpcSlot} from "../src/rpc.js";
import {UNISWAP_V4} from "../src/v4/addresses.js";
import {v4ServedDeployment, v4ServesFlow} from "../src/v4/serve.js";
import {MULTICALL3} from "../src/v4/discover.js";
import {ME, RPC, USDT, rpcStub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const NATIVE = "0x0000000000000000000000000000000000000000";
const ALL_RPC = Object.fromEntries([1, 10, 56, 130, 137, 143, 196, 480, 999, 4326, 4663, 5042, 8453, 42161, 42220, 43114, 57073, 59144, 99901].map((id) => [id, [`https://rpc.${id}.test`]]));
const ARC_USDC_POOL = {currency0: "0x1111111111111111111111111111111111111111", currency1: "0x2222222222222222222222222222222222222222", fee: 500, tickSpacing: 10, hooks: NATIVE} as const;

describe('where v4 "all" is offered', () => {
  const supported = (c: Partial<UniswapProviderConfig>) => {
    const p = uniswapProvider({rpcUrls: ALL_RPC, ...c});
    const proto = new UniswapSwap2Protocol(undefined, {fromChain: "eip155:1", rpcUrls: ALL_RPC, ...c} as never) as unknown as {chainSupported(c: string): boolean};
    return (id: number) => {
      const a = p.supportsChain!(`eip155:${id}`);
      expect(proto.chainSupported(`eip155:${id}`), `chain ${id}`).toBe(a);
      return a;
    };
  };
  it("the v4-only chains with a shipped list, never HyperEVM; Arc (native = USDC) for token → token; a chain without a list only with the integrator's own pools", () => {
    const s = supported({v4: "all"});
    expect([4326, 99901, 143, 8453].map(s)).toEqual([true, true, true, true]);
    expect(s(999)).toBe(false);
    // LIVE-2: Arc ships a list (token → token pools only: its native coin is the USDC ERC-20).
    expect(s(5042)).toBe(true);
    expect(supported({v4: "native-in"})(5042)).toBe(false); // native-in needs a native coin that is not an ERC-20
    // A pinned chain with no shipped list (an integrator's own deployment row): served only with its own pools.
    const rpcUrls = {...ALL_RPC, 777777: ["https://rpc.777777.test"]};
    const v4Deployments = {...UNISWAP_V4, 777777: UNISWAP_V4[5042]!};
    expect(supported({v4: "all", rpcUrls, v4Deployments})(777777)).toBe(false);
    expect(supported({v4: "all", rpcUrls, v4Deployments, v4ExtraPools: {777777: [ARC_USDC_POOL]}})(777777)).toBe(true);
    expect(supported({v4: "native-in", rpcUrls, v4Deployments, v4ExtraPools: {777777: [ARC_USDC_POOL]}})(777777)).toBe(false);
  });
  it("the flows: native in → token on both modes; token → token and token → native on \"all\" only; native legs never where the native coin is an ERC-20", () => {
    const base = UNISWAP_V4[8453]!, arc = UNISWAP_V4[5042]!;
    expect([v4ServesFlow(base, "native-in", true, false), v4ServesFlow(base, "native-in", false, false), v4ServesFlow(base, "native-in", false, true)]).toEqual([true, false, false]);
    expect([v4ServesFlow(base, "all", true, false), v4ServesFlow(base, "all", false, false), v4ServesFlow(base, "all", false, true), v4ServesFlow(base, "all", true, true)]).toEqual([true, true, true, false]);
    expect([v4ServesFlow(arc, "all", false, false), v4ServesFlow(arc, "all", true, false), v4ServesFlow(arc, "all", false, true)]).toEqual([true, false, false]);
    expect(v4ServesFlow(base, "off", true, false)).toBe(false);
    expect(v4ServedDeployment(999, "all", UNISWAP_V4, {})).toBeUndefined();
  });
});

describe('what "all" does on a chain', () => {
  it("a token input on a v4-only chain (MegaETH) is now quoted on v4, not refused as native-only (the stub node answers nothing: refused for that, after the v4 deployment check)", async () => {
    const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
    vi.stubGlobal("fetch", rpcStub());
    const q = await uniswapProvider({rpcUrls: ALL_RPC, v4: "all"}).getQuote({sourceChain: "eip155:4326", destChain: "eip155:4326", sourceToken: "USDT0", destToken: NATIVE, amountIn: "1000000", destAddress: ME, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
    expect(q).toBeNull();
    expect(heard[0]![0]).not.toMatch(/native-coin input only/);
  });
  it('a catalog token input on Ethereum: "all" checks the v4 deployment (the router\'s and the SwapProxy\'s code) alongside v3; "native-in" never reads v4', async () => {
    const run = async (v4: "all" | "native-in") => {
      const seen: string[] = [];
      const base = rpcStub();
      vi.stubGlobal("fetch", (async (u: RequestInfo | URL, init?: RequestInit) => {
        for (const r of JSON.parse(String(init?.body)) as {method: string; params: [{to?: string} | string]}[]) seen.push(`${r.method} ${typeof r.params[0] === "string" ? r.params[0] : r.params[0]?.to ?? ""}`.toLowerCase());
        return base(u, init);
      }) as typeof fetch);
      const q = await uniswapProvider({rpcUrls: RPC, v4}).getQuote({sourceChain: "eip155:1", destChain: "eip155:1", sourceToken: "USDC", destToken: USDT, amountIn: "1000000", destAddress: ME});
      return {q, seen};
    };
    const d1 = UNISWAP_V4[1]!;
    const all = await run("all");
    expect(all.seen).toContain(`eth_getcode ${d1.universalRouter.toLowerCase()}`);
    expect(all.seen).toContain(`eth_getcode ${d1.swapProxy.toLowerCase()}`);
    expect(all.q).toBeNull(); // the stub node serves v3 only: an unanswered v4 read refuses the quote, never a v3-only quote
    const nativeIn = await run("native-in");
    expect(nativeIn.q?.providerData?.venue).toBeUndefined();
    expect(nativeIn.seen.some((x) => x.startsWith("eth_getcode") || x.includes(MULTICALL3.toLowerCase()))).toBe(false);
  });
});

describe("isUnsupportedMethod (rpc.ts)", () => {
  const failed = (code: number | undefined, message: string): RpcSlot => ({ok: false, failed: new Error("x"), error: {...(code !== undefined ? {code} : {}), message}});
  it("EIP-1474 -32601, QuickNode -32604, and the texts nodes use for a method they do not serve", () => {
    expect(isUnsupportedMethod(failed(-32601, "Method not found"))).toBe(true);
    expect(isUnsupportedMethod(failed(-32604, "this request method is not supported"))).toBe(true);
    expect(isUnsupportedMethod(failed(-32000, "the method eth_simulateV1 does not exist/is not available"))).toBe(true);
    expect(isUnsupportedMethod(failed(undefined, "unsupported method: eth_createAccessList"))).toBe(true);
  });
  it("never a rate limit, a node fault, a revert, an HTTP failure or an answer", () => {
    expect(isUnsupportedMethod(failed(-32007, "50/second request limit reached"))).toBe(false);
    expect(isUnsupportedMethod(failed(-32603, "internal error"))).toBe(false);
    expect(isUnsupportedMethod(failed(-32000, "service temporarily not available"))).toBe(false);
    expect(isUnsupportedMethod({ok: false, failed: new Error("HTTP 502")})).toBe(false);
    expect(isUnsupportedMethod({ok: false, revert: {code: 3, message: "execution reverted"}})).toBe(false);
    expect(isUnsupportedMethod({ok: true, result: "0x"})).toBe(false);
    expect(isUnsupportedMethod(undefined)).toBe(false);
  });
});
