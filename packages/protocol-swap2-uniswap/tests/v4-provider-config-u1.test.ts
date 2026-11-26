// U1 (UNISWAP-V4-RESEARCH §5.4, §9 U1): the v4 options, where the provider offers v4, and what stays v3 — token input,
// native output, and every chain while `v4` is "off" (the default).
import {afterEach, describe, expect, it, vi} from "vitest";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {UniswapSwap2Protocol} from "../src/protocol.js";
import {UNISWAP_V4, type UniswapV4Deployment} from "../src/v4/addresses.js";
import {MULTICALL3} from "../src/v4/discover.js";
import {D, ME, RPC, USDC, USDT, rpcStub} from "./fixtures.js";

afterEach(() => vi.unstubAllGlobals());

const NATIVE = "0x0000000000000000000000000000000000000000";
const HOOK = "0x4445520306c9C70952bDFEc28F3989f53d9f80C4";
const AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const MONAD_USDC = "0x754704Bc059F8C67012fEd69BC8A327a5aafb603";
const ALL_RPC = Object.fromEntries([1, 10, 56, 130, 137, 143, 196, 480, 999, 4326, 4663, 5042, 8453, 42161, 42220, 43114, 57073, 59144, 99901].map((id) => [id, [`https://rpc.${id}.test`]]));

describe("v4 options are checked when the provider is made", () => {
  const make = (c: Partial<UniswapProviderConfig>) => () => uniswapProvider({rpcUrls: RPC, ...c});
  it('"off" (the default) and "native-in" are accepted; "all" is not built in this release', () => {
    expect(make({})).not.toThrow();
    expect(make({v4: "off"})).not.toThrow();
    expect(make({v4: "native-in"})).not.toThrow();
    expect(make({v4: "all"})).toThrow(/"all" \(token input through the SwapProxy\) is not built in this release/);
    expect(make({v4: "everything" as never})).toThrow(/v4 must be "off" or "native-in"/);
  });
  it("v4MaxFeePips is an integer 1..100000 (the 10% cap can be lowered, never raised); v4MinEdgeBps 0..10000", () => {
    for (const bad of [0, 100_001, 1.5, -1]) expect(make({v4MaxFeePips: bad})).toThrow(/v4MaxFeePips must be an integer in 1\.\.100000/);
    expect(make({v4MaxFeePips: 3000})).not.toThrow();
    for (const bad of [-1, 10_001, 0.5]) expect(make({v4MinEdgeBps: bad})).toThrow(/v4MinEdgeBps must be an integer 0\.\.10000/);
    expect(make({v4MinEdgeBps: 25})).not.toThrow();
  });
  it("v4ExtraPools: hookless only, ordered, static fee ≤ 10% — a bad key throws here, never skipped later", () => {
    const ok = {currency0: NATIVE, currency1: AUSD, fee: 500, tickSpacing: 1, hooks: NATIVE} as const;
    expect(make({v4ExtraPools: {143: [ok]}})).not.toThrow();
    expect(make({v4ExtraPools: {143: [{...ok, hooks: HOOK}]}})).toThrow(/has hook .* only hookless pools are routed/);
    expect(make({v4ExtraPools: {143: [{...ok, fee: 200_000}]}})).toThrow(/above the 100000-pip cap/);
    expect(make({v4ExtraPools: {143: [{...ok, fee: 0x800000}]}})).toThrow(/not a static LP fee/);
    expect(make({v4ExtraPools: {143: [{...ok, currency0: AUSD, currency1: NATIVE}]}})).toThrow(/not in order/);
    expect(make({v4ExtraPools: {143: [{...ok, tickSpacing: 0}]}})).toThrow(/tickSpacing 0/);
    expect(make({v4ExtraPools: {143: "nope" as never}})).toThrow(/not a list of pool keys/);
  });
  it("declares ownGasEstimate: the engine sends the account's own estimate of the exact call, v3 and v4 alike", () => {
    expect(uniswapProvider({rpcUrls: RPC}).ownGasEstimate).toBe(true);
    expect(uniswapProvider({rpcUrls: RPC, v4: "native-in"}).ownGasEstimate).toBe(true);
  });
});

describe("where v4 is offered", () => {
  const supported = (c: Partial<UniswapProviderConfig> = {}) => {
    const p = uniswapProvider({rpcUrls: ALL_RPC, ...c});
    const proto = new UniswapSwap2Protocol(undefined, {fromChain: "eip155:1", rpcUrls: ALL_RPC, ...c} as never) as unknown as {chainSupported(c: string): boolean};
    return (id: number) => {
      const a = p.supportsChain!(`eip155:${id}`);
      expect(proto.chainSupported(`eip155:${id}`)).toBe(a); // the standalone protocol agrees with its provider
      return a;
    };
  };
  it('"off": exactly the v3 chains, as 0.4.x', () => {
    const s = supported();
    for (const id of [1, 10, 56, 130, 137, 143, 196, 324, 480, 4663, 8453, 42161, 42220, 43114, 57073, 59144].filter((id) => ALL_RPC[id])) expect(s(id)).toBe(true);
    for (const id of [999, 4326, 5042, 99901]) expect(s(id)).toBe(false);
  });
  it('"native-in": also the v4-only chains with a shipped pool list (MegaETH, Elysium) — never HyperEVM (no quotable pool) or Arc (native = USDC)', () => {
    const s = supported({v4: "native-in"});
    expect(s(4326)).toBe(true);
    expect(s(99901)).toBe(true);
    expect(s(999)).toBe(false);
    expect(s(5042)).toBe(false);
    expect(s(143)).toBe(true);
  });
  it("a pinned chain without a shipped list is offered on v4 only with the integrator's own pools (provenance)", () => {
    const fake: UniswapV4Deployment = {...UNISWAP_V4[4326]!};
    const v4Deployments = {...UNISWAP_V4, 777: fake};
    const rpcUrls = {...ALL_RPC, 777: ["https://rpc.777.test"]};
    expect(uniswapProvider({rpcUrls, v4: "native-in", v4Deployments}).supportsChain!("eip155:777")).toBe(false);
    expect(uniswapProvider({rpcUrls, v4: "native-in", v4Deployments, v4ExtraPools: {777: [{currency0: NATIVE, currency1: AUSD, fee: 500, tickSpacing: 1, hooks: NATIVE}]}}).supportsChain!("eip155:777")).toBe(true);
  });
});

describe("what stays on v3 with v4 on", () => {
  /** rpcStub on Ethereum, every request's target kept. */
  function stub() {
    const base = rpcStub();
    const targets: string[] = [];
    const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
      for (const r of JSON.parse(String(init?.body)) as {method: string; params: [{to?: string} | string]}[]) targets.push(`${r.method} ${typeof r.params[0] === "object" ? r.params[0]?.to ?? "" : r.params[0]}`.toLowerCase());
      return base(input, init);
    }) as typeof fetch;
    return {f, targets};
  }
  const run = async (c: Partial<UniswapProviderConfig>, p: {sourceToken: string; destToken: string; amountIn: string}) => {
    const s = stub();
    vi.stubGlobal("fetch", s.f);
    const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
    const q = await uniswapProvider({rpcUrls: RPC, ...c}).getQuote({sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, ...p, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
    return {q, heard, targets: s.targets};
  };
  it("a token input (USDC → USDT) is the v3 quote, with no v4 read", async () => {
    const off = await run({}, {sourceToken: "USDC", destToken: USDT, amountIn: "1000000"});
    const on = await run({v4: "native-in"}, {sourceToken: "USDC", destToken: USDT, amountIn: "1000000"});
    expect(on.q).toMatchObject({destAmount: off.q!.destAmount, txRequest: {to: D.router, approvalAddress: D.router}});
    expect({...on.q, validUntilMs: 0, txRequest: {...on.q!.txRequest, data: ""}}).toEqual({...off.q, validUntilMs: 0, txRequest: {...off.q!.txRequest, data: ""}});
    const v4 = UNISWAP_V4[1]!;
    for (const t of on.targets) expect(t).not.toMatch(new RegExp(`${MULTICALL3.toLowerCase()}|${v4.universalRouter.toLowerCase()}|${v4.quoter.toLowerCase()}|eth_getcode`));
  });
  it("a native output (USDC → ETH) is the v3 quote too", async () => {
    const on = await run({v4: "native-in"}, {sourceToken: "USDC", destToken: NATIVE, amountIn: "1000000"});
    expect(on.q?.txRequest?.to).toBe(D.router);
    expect(on.q?.providerData?.venue).toBeUndefined();
  });
  it("a token input on a chain only v4 serves (MegaETH) is refused as unsupported, not quoted", async () => {
    const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
    const q = await uniswapProvider({rpcUrls: ALL_RPC, v4: "native-in"}).getQuote({sourceChain: "eip155:4326", destChain: "eip155:4326", sourceToken: "USDT0", destToken: NATIVE, amountIn: "1000000", destAddress: ME, onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
    expect(q).toBeNull();
    expect(heard).toEqual([["uniswap: Uniswap v4 takes a native-coin input only on this chain (it has no Uniswap v3 deployment)", {reason: "unsupported_pair"}]]);
  });
  it('the refusal for an unsupported chain names v4 only when it is on', async () => {
    const heard: string[] = [];
    await uniswapProvider({rpcUrls: RPC}).getQuote({sourceChain: "eip155:4326", destChain: "eip155:4326", sourceToken: "ETH", destToken: USDC, amountIn: "1", destAddress: ME, onRefusal: (t: string) => { heard.push(t); }});
    await uniswapProvider({rpcUrls: RPC, v4: "native-in"}).getQuote({sourceChain: "eip155:4326", destChain: "eip155:4326", sourceToken: "ETH", destToken: USDC, amountIn: "1", destAddress: ME, onRefusal: (t: string) => { heard.push(t); }});
    expect(heard).toEqual(["uniswap: no Uniswap v3 deployment or RPC for eip155:4326", "uniswap: no Uniswap v3 or v4 deployment or RPC for eip155:4326"]);
  });
  it("Monad USDC (a token input) never touches v4 even with v4 on", async () => {
    // Monad's v3 deployment answers nothing here (the stub knows Ethereum only): the point is which contracts are read.
    const s = stub();
    vi.stubGlobal("fetch", s.f);
    await uniswapProvider({rpcUrls: {143: ["https://rpc.test"]}, v4: "native-in"}).getQuote({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "USDC", destToken: AUSD, amountIn: "1000000", destAddress: ME});
    expect(s.targets.some((t) => t.includes(MULTICALL3.toLowerCase()) || t.startsWith("eth_getcode"))).toBe(false);
    expect(MONAD_USDC).toMatch(/^0x/);
  });
});
