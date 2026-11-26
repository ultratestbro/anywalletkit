// U1/U2 review round 1 (R1-1 / SEC-U4-3, R1-3 / LIVE-4): pool provenance across the remote corridor, and the remote
// stub's own gas estimate. A small fake Monad node serves everything the provider reads: the v3 deployment check and
// QuoterV2, the v4 deployment check (its router code hashed into an overridden pin, same addresses as the shipped
// table), the discovery through Multicall3 on the StateView (every listed pool of the pair set initialized; one hookless
// MON/X 0.3%/60 pool on the unlisted-token grid), and the V4Quoter candidates.
//
// The case: a user swaps MON into a custom token X the shipped list does not know. The grid finds a live hookless MON/X
// pool that pays more than v3's MON/X route. Before the fix the server returned that v4 quote; every app on the shipped
// pins refused it ("not in the pinned pool list") and — a stub gets one quote per pair — lost the v3 quote it used to get.
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeAbiParameters, decodeFunctionData, encodeAbiParameters, encodeFunctionData, encodeFunctionResult, getAddress, keccak256, parseAbi, type Hex} from "viem";
import {SingleProviderSwap2} from "@anywalletkit/protocol-swap2-core/swap2/single";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {remotePinRefusal} from "@anywalletkit/protocol-swap2-core/validate";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {UNISWAP_V3, uniswapPins, uniswapPinsWith, uniswapVerifyQuote} from "../src/addresses.js";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {uniswapRemoteProvider} from "../src/remote.js";
import {UNISWAP_V4} from "../src/v4/addresses.js";
import {MULTICALL3} from "../src/v4/discover.js";
import {poolIdOf} from "../src/v4/pool.js";
import {V4_QUOTER_ABI} from "../src/v4/quote.js";
import {UNISWAP_V4_POOLS} from "../src/v4pools/index.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const CHAIN = 143;
const D3 = UNISWAP_V3[CHAIN]!;
const ROUTER_CODE: Hex = "0x60806040526000805500fe";
const PROXY_CODE: Hex = "0x6080604052600180550000fe";
/** The shipped Monad pins with the fake node's code hashed in: the same addresses, so the app's shipped pins still apply. */
const V4 = {...UNISWAP_V4, [CHAIN]: {...UNISWAP_V4[CHAIN]!, routerCodehash: keccak256(ROUTER_CODE), swapProxyCodehash: keccak256(PROXY_CODE)}};
const D4 = V4[CHAIN]!;
const NATIVE = "0x0000000000000000000000000000000000000000";
/** A custom token the shipped Monad list does not know (above every listed currency, so it is currency1 of MON/X). */
const X = getAddress("0xfefefefefefefefefefefefefefefefefefefefe");
const ME = getAddress("0x4444444444444444444444444444444444444444");
const RPC = {[CHAIN]: ["https://monad.fake"]};
const AMOUNT = 100n * 10n ** 18n;
/** v3's best MON → X route (direct 0.3%), and the grid pool's v4 output — 20% more. */
const V3_OUT = 1_000_000n;
const V4_OUT = 1_200_000n;
const GRID_KEY = {currency0: NATIVE, currency1: X, fee: 3000, tickSpacing: 60, hooks: NATIVE} as const;
const GRID_ID = poolIdOf(GRID_KEY);

const MC3 = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const STATE_VIEW = parseAbi([
  "function getSlot0(bytes32 poolId) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)",
  "function getLiquidity(bytes32 poolId) view returns (uint128 liquidity)",
]);
const V3_QUOTER = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256 amountOut, uint160[] sqrtPriceX96AfterList, uint32[] initializedTicksCrossedList, uint256 gasEstimate)",
]);
const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}` as Hex;
const Q96 = 1n << 96n;
/** The fees of the shipped Monad list's pools, by PoolId: each reads initialized and live. */
const LISTED_FEE = new Map(UNISWAP_V4_POOLS[CHAIN]!.pools.map((p) => [p.id.toLowerCase(), p.fee]));

type Answer = {result: unknown} | {error: {code: number; message: string; data?: Hex}};
const REVERT: Answer = {error: {code: 3, message: "execution reverted", data: "0x"}};

/** One StateView read of the discovery: listed pools and the grid pool live, every other grid key uninitialized. */
function stateView(data: Hex, gridLive: boolean): {success: boolean; returnData: Hex} {
  const d = decodeFunctionData({abi: STATE_VIEW, data});
  const id = (d.args[0] as Hex).toLowerCase();
  const fee = LISTED_FEE.get(id) ?? (gridLive && id === GRID_ID ? GRID_KEY.fee : undefined);
  if (d.functionName === "getSlot0") {
    return {success: true, returnData: encodeFunctionResult({abi: STATE_VIEW, functionName: "getSlot0", result: fee === undefined ? [0n, 0, 0, 0] : [Q96, 0, 0, fee]})};
  }
  return {success: true, returnData: encodeFunctionResult({abi: STATE_VIEW, functionName: "getLiquidity", result: fee === undefined ? 0n : 10n ** 24n})};
}

/** UnexpectedRevertBytes(""): the quoter's inner call starved. */
const STARVED: Hex = `0x6190b2b0${encodeAbiParameters([{type: "bytes"}], ["0x"]).slice(2)}`;
/** One V4Quoter call: the grid pool pays V4_OUT (pro rata) — or starves for gas (`starved`); every other route reverts
 *  (no pool to price). */
function v4Quote(data: Hex, starved: boolean): {success: boolean; returnData: Hex} {
  const d = decodeFunctionData({abi: V4_QUOTER_ABI, data});
  if (starved) return {success: false, returnData: STARVED};
  if (d.functionName === "quoteExactInputSingle") {
    const p = d.args[0] as {poolKey: {currency0: Hex; currency1: Hex; fee: number; tickSpacing: number; hooks: Hex}; exactAmount: bigint};
    if (poolIdOf(p.poolKey) === GRID_ID) return {success: true, returnData: encodeAbiParameters([{type: "uint256"}, {type: "uint256"}], [(V4_OUT * p.exactAmount) / AMOUNT, 90_000n])};
  }
  return {success: false, returnData: "0x486aa307"}; // PoolNotInitialized(): no candidate
}

/** The fake node. `v3Route`: whether v3 has its MON/X route. Every request is kept. */
function fakeNode(o: {v3Route?: boolean; gridLive?: boolean; starved?: boolean} = {}) {
  const v3Route = o.v3Route ?? true, gridLive = o.gridLive ?? true, starved = o.starved ?? false;
  const seen: {method: string; to?: string; data?: string}[] = [];
  const answer = (method: string, params: unknown[]): Answer => {
    if (method === "eth_blockNumber") return {result: "0x77998f3"};
    if (method === "eth_getBlockByNumber") return {result: {number: "0x77998f3", gasLimit: "0xbebc200"}};
    if (method === "eth_getCode") {
      const at = getAddress(String(params[0]));
      return {result: at === getAddress(D4.universalRouter) ? ROUTER_CODE : at === getAddress(D4.swapProxy) ? PROXY_CODE : "0x"};
    }
    if (method !== "eth_call") return {error: {code: -32601, message: "method not found"}};
    const c = params[0] as {to: string; data: Hex};
    const to = getAddress(c.to);
    const sel = c.data.slice(0, 10);
    seen.push({method, to, data: c.data});
    // v3 deployment check: factory() / WETH9() of the router and the quoter.
    if ((to === getAddress(D3.router) || to === getAddress(D3.quoter)) && sel === "0xc45a0155") return {result: word(D3.factory)};
    if ((to === getAddress(D3.router) || to === getAddress(D3.quoter)) && sel === "0x4aa4a4fc") return {result: word(D3.weth)};
    // v4 linkage: poolManager() of the router, the quoter and the StateView.
    if (sel === "0xdc4c90d3") return {result: word(D4.poolManager)};
    if (to === getAddress(D3.quoter)) {
      const d = decodeFunctionData({abi: V3_QUOTER, data: c.data});
      if (v3Route && d.functionName === "quoteExactInputSingle") {
        const p = d.args[0] as {tokenOut: Hex; amountIn: bigint; fee: number};
        if (getAddress(p.tokenOut) === X && p.fee === 3000) return {result: encodeFunctionResult({abi: V3_QUOTER, functionName: "quoteExactInputSingle", result: [(V3_OUT * p.amountIn) / AMOUNT, Q96, 1, 110_000n]})};
      }
      return REVERT;
    }
    // A V4Quoter call read alone (the re-read at the per-transaction gas cap): it starves there too.
    if (to === getAddress(D4.quoter)) return starved ? {error: {code: 3, message: "execution reverted", data: STARVED}} : REVERT;
    if (to === getAddress(MULTICALL3)) {
      const calls = decodeFunctionData({abi: MC3, data: c.data}).args[0];
      const results = calls.map((x) => (getAddress(x.target) === getAddress(D4.stateView) ? stateView(x.callData, gridLive) : getAddress(x.target) === getAddress(D4.quoter) ? v4Quote(x.callData, starved) : {success: false, returnData: "0x" as Hex}));
      return {result: encodeFunctionResult({abi: MC3, functionName: "aggregate3", result: results})};
    }
    return REVERT;
  };
  const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]} | {id: number; method: string; params: unknown[]}[];
    const batch = Array.isArray(body) ? body : [body];
    const out = batch.map((r) => ({jsonrpc: "2.0", id: r.id, ...answer(r.method, r.params)}));
    return new Response(JSON.stringify(Array.isArray(body) ? out : out[0]));
  }) as typeof fetch;
  return {fetch: f, seen};
}

const params = (extra: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: `eip155:${CHAIN}`, destChain: `eip155:${CHAIN}`, sourceToken: "MON", destToken: X, amountIn: AMOUNT.toString(), destAddress: ME, refundAddress: ME, ...extra});
const server = (c: Partial<UniswapProviderConfig> = {}) => uniswapProvider({rpcUrls: RPC, v4: "native-in", v4Deployments: V4, ...c});

const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
function backend(provider: CrossChainProvider): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [provider], sealSecret: SECRET, guard: () => {}, subject: () => "app"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "app");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}
async function viaStub(stub: CrossChainProvider): Promise<{q: Quote | null; error?: Error}> {
  try {
    return {q: await stub.getQuote(params())};
  } catch (error) {
    return {q: null, error: error as Error};
  }
}

describe("R1-1 / SEC-U4-3: a v4 route through a pool outside the shipped list never displaces the v3 route by default", () => {
  it("the fake node is what the case needs: the grid finds the MON/X pool, it pays 20% more than v3, the app's pins refuse it", async () => {
    vi.stubGlobal("fetch", fakeNode().fetch);
    const local = await server({v4RankedPools: "all"}).getQuote(params());
    expect(local).toMatchObject({destAmount: V4_OUT.toString(), providerData: {venue: "v4", route: "v4 direct 0.3%/60"}});
    expect(JSON.parse(local!.providerData!.poolKeys!).map(poolIdOf)).toEqual([GRID_ID]);
    // The shipped pins check the list alone: a server-found pool is no provenance (§6.5 row 9).
    expect(uniswapVerifyQuote(params(), local!)).toMatch(new RegExp(`the pool ${GRID_ID} is not in the pinned pool list`));
  });

  it('server v4 "native-in" (default v4RankedPools "listed"), app on 0.5.0 uniswapPins: v3 is still served', async () => {
    vi.stubGlobal("fetch", fakeNode().fetch);
    const stub = remoteProvider({name: "uniswap", baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(server()), supportsSameChain: true, ...uniswapPins});
    const {q, error} = await viaStub(stub);
    expect(error).toBeUndefined();
    expect(q).toMatchObject({destAmount: V3_OUT.toString(), txRequest: {to: D3.router, value: AMOUNT.toString()}});
    expect(q!.providerData!.venue).toBeUndefined();
    expect(remotePinRefusal(stub, q!, `eip155:${CHAIN}`)).toBeNull();
    // And through the uniswap remote helper.
    const helper = await viaStub(uniswapRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(server())}));
    expect(helper.q?.destAmount).toBe(V3_OUT.toString());
  });

  it('a server that ranks every pool ("all") hands that app a quote its pins refuse — the case the default prevents', async () => {
    vi.stubGlobal("fetch", fakeNode().fetch);
    const stub = remoteProvider({name: "uniswap", baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(server({v4RankedPools: "all"})), supportsSameChain: true, ...uniswapPins});
    const {q, error} = await viaStub(stub);
    expect(q).toBeNull();
    expect(error?.message).toMatch(/fails this app's own check — the pool 0x[0-9a-f]{64} is not in the pinned pool list/);
  });

  it("with no v3 route for the pair, the grid route is still returned (nothing the app had is lost); the server's own check passes it", async () => {
    vi.stubGlobal("fetch", fakeNode({v3Route: false}).fetch);
    const q = await server().getQuote(params());
    expect(q).toMatchObject({destAmount: V4_OUT.toString(), providerData: {venue: "v4"}});
  });

  it('v4ExtraPools shared with the app: "extra" ranks them, and uniswapPinsWith({v4ExtraPools}) accepts the route', async () => {
    vi.stubGlobal("fetch", fakeNode().fetch);
    const v4ExtraPools = {[CHAIN]: [GRID_KEY]};
    // "listed" (the default): an extra pool is not ranked against v3 either.
    const listed = await server({v4ExtraPools}).getQuote(params());
    expect(listed?.destAmount).toBe(V3_OUT.toString());
    const extra = await server({v4ExtraPools, v4RankedPools: "extra"}).getQuote(params());
    expect(extra).toMatchObject({destAmount: V4_OUT.toString(), providerData: {venue: "v4"}});
    expect(uniswapVerifyQuote(params(), extra!)).toMatch(/not in the pinned pool list/);
    const shared = uniswapPinsWith({v4ExtraPools});
    expect(shared.verifyQuote!(params(), extra!)).toBeNull();
    // End to end: the server on "extra", the app on the same pools.
    const stub = uniswapRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(server({v4ExtraPools, v4RankedPools: "extra"})), v4ExtraPools});
    const {q, error} = await viaStub(stub);
    expect(error).toBeUndefined();
    expect(q).toMatchObject({destAmount: V4_OUT.toString(), txRequest: {to: D4.universalRouter}});
    expect(remotePinRefusal(stub, q!, `eip155:${CHAIN}`)).toBeNull();
    // A grid pool cannot be shared that way: "extra" does not rank it.
    const grid = await server({v4RankedPools: "extra"}).getQuote(params());
    expect(grid?.destAmount).toBe(V3_OUT.toString());
  });

  it("v4RankedPools and uniswapPinsWith refuse a bad setting when made", () => {
    expect(() => server({v4RankedPools: "grid" as never})).toThrow(/v4RankedPools/);
    expect(() => uniswapPinsWith({v4ExtraPools: {[CHAIN]: [{...GRID_KEY, hooks: "0x4445520306c9C70952bDFEc28F3989f53d9f80C4"}]}})).toThrow(/hookless/);
    expect(() => uniswapPinsWith({v4ExtraPools: {[CHAIN]: [{...GRID_KEY, fee: 200_000}]}})).toThrow(/cap/);
    expect(() => uniswapPinsWith({clockSkewSeconds: -1})).toThrow(/clockSkewSeconds/);
    expect(() => uniswapPinsWith({clockSkewSeconds: 3601})).toThrow(/clockSkewSeconds/);
    // The shipped pins are uniswapPinsWith() — the same targets on every chain.
    for (const id of [1, 143, 8453, 42220, 5042, 999, 324]) expect(uniswapPinsWith().callTargets(`eip155:${id}`)).toEqual(uniswapPins.callTargets(`eip155:${id}`));
  });
});

describe("LIVE-1: every v4 candidate past the per-transaction gas cap and no v3 route", () => {
  it("refused as insufficient_liquidity, naming the cap — not upstream_unavailable", async () => {
    const node = fakeNode({v3Route: false, starved: true});
    vi.stubGlobal("fetch", node.fetch);
    const heard: Array<[string, unknown]> = [];
    const q = await server().getQuote({...params(), onRefusal: (t: string, i?: unknown) => { heard.push([t, i]); }});
    expect(q).toBeNull();
    expect(heard).toEqual([[expect.stringMatching(/every Uniswap v3 and v4 route for this pair and amount is out: the v4 ones need more gas than one transaction on chain 143 may have \(30000000\)/), {reason: "insufficient_liquidity"}]]);
    // The starved call was read again alone, straight to the quoter.
    expect(node.seen.some((r) => r.to === getAddress(D4.quoter))).toBe(true);
  });
  it("with a v3 route, v3 is quoted and the count rides on it", async () => {
    vi.stubGlobal("fetch", fakeNode({starved: true}).fetch);
    const q = await server().getQuote(params());
    expect(q).toMatchObject({destAmount: V3_OUT.toString(), txRequest: {to: D3.router}, providerData: {v4Unexecutable: "1"}});
  });
});

describe("R1-2 / SEC-U4-2 / LIVE-3: a server's deadlineSeconds above 600 no longer loses the v4 quote on every app", () => {
  it("the v4 deadline is at most 600 s ahead whatever deadlineSeconds says; v3 keeps the full deadline", async () => {
    vi.useFakeTimers({toFake: ["Date"]});
    vi.setSystemTime(new Date("2026-11-26T12:00:00Z"));
    const nowS = BigInt(Math.floor(Date.now() / 1000));
    vi.stubGlobal("fetch", fakeNode({v3Route: false}).fetch);
    const q = await server({deadlineSeconds: 1200}).getQuote(params());
    expect(q?.providerData?.venue).toBe("v4");
    const d = decodeFunctionData({abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]), data: q!.txRequest!.data as Hex});
    expect(d.args[2]).toBe(nowS + 600n);
    // The shipped pins accept it (600 s + 60 s skew); before the fix they refused "more than 600 s ahead".
    expect(uniswapPinsWith({v4ExtraPools: {[CHAIN]: [GRID_KEY]}}).verifyQuote!(params(), q!)).toBeNull();
    // A shorter deadlineSeconds is kept as it is.
    const short = await server({deadlineSeconds: 120}).getQuote(params());
    expect(decodeFunctionData({abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]), data: short!.txRequest!.data as Hex}).args[2]).toBe(nowS + 120n);
    // v3: the multicall deadline is still deadlineSeconds.
    vi.stubGlobal("fetch", fakeNode().fetch);
    const v3 = await uniswapProvider({rpcUrls: RPC, deadlineSeconds: 1200}).getQuote(params());
    const m = decodeFunctionData({abi: parseAbi(["function multicall(uint256 deadline, bytes[] data) payable returns (bytes[] results)"]), data: v3!.txRequest!.data as Hex});
    expect(m.args[0]).toBe(nowS + 1200n);
  });

  it("end to end: a server at deadlineSeconds 1200 with v4 on, an app on the shipped pins — the v4 quote passes", async () => {
    vi.stubGlobal("fetch", fakeNode({v3Route: false}).fetch);
    const v4ExtraPools = {[CHAIN]: [GRID_KEY]};
    const stub = uniswapRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(server({deadlineSeconds: 1200, v4ExtraPools, v4RankedPools: "extra"})), v4ExtraPools});
    const {q, error} = await viaStub(stub);
    expect(error).toBeUndefined();
    expect(q?.providerData?.venue).toBe("v4");
  });
});

describe("R1-3 / LIVE-4 / SEC-U4-1: the remote stub carries ownGasEstimate", () => {
  type Call = {to?: string; data?: string; value?: bigint; gasLimit?: bigint};
  function account(log: {sent: Call[]; estimated: Call[]}) {
    return {
      getAddress: async () => ME,
      getChainId: async () => CHAIN,
      getBalance: async () => 10n ** 24n,
      getAllowance: async () => 0n,
      quoteSendTransaction: async (t: Call) => { log.estimated.push(t); return {fee: 1n}; },
      sendTransaction: async (t: Call) => { log.sent.push(t); return {hash: `0x${String(log.sent.length).padStart(64, "0")}`}; },
      waitForTransaction: async () => {},
    };
  }
  async function swapThrough(stub: CrossChainProvider) {
    const log = {sent: [] as Call[], estimated: [] as Call[]};
    class P extends SingleProviderSwap2 { protected readonly provider = stub; protected chainSupported(): boolean { return true; } }
    await new P(account(log) as never, {fromChain: `eip155:${CHAIN}`}).swap2({fromToken: "MON", toToken: X, toChain: CHAIN, recipient: ME, fromTokenAmount: AMOUNT, minAmountOut: 1n} as never);
    return log;
  }

  it("uniswapRemoteProvider declares it; the bare remoteProvider({...uniswapPins}) cannot (core has no such pin)", () => {
    expect(uniswapRemoteProvider({baseUrl: "https://backend.example/api/swap2"}).ownGasEstimate).toBe(true);
    expect(remoteProvider({name: "uniswap", baseUrl: "https://backend.example/api/swap2", supportsSameChain: true, ...uniswapPins}).ownGasEstimate).toBeUndefined();
    expect(uniswapProvider({rpcUrls: RPC}).ownGasEstimate).toBe(true);
  });

  it("through the engine: the swap goes out with the account's own estimate, never the backend's quoted gas limit", async () => {
    vi.stubGlobal("fetch", fakeNode().fetch);
    const helper = await swapThrough(uniswapRemoteProvider({baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(server())}));
    expect(helper.sent).toHaveLength(1);
    expect(helper.sent[0]!.to).toBe(D3.router);
    expect(helper.sent[0]!.gasLimit).toBeUndefined();
    expect(helper.estimated.some((t) => t.to === D3.router && t.gasLimit === undefined && t.value === AMOUNT)).toBe(true);
    // The bare stub broadcasts the backend's limit (the README says to use the helper).
    const bare = await swapThrough(remoteProvider({name: "uniswap", baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(server()), supportsSameChain: true, ...uniswapPins}));
    expect(bare.sent[0]!.gasLimit).toBeGreaterThan(0n);
  });

  it("the helper offers only chains its pins can check, and describes activity", () => {
    const stub = uniswapRemoteProvider({baseUrl: "https://backend.example/api/swap2"});
    expect(stub.supportsChain!(`eip155:${CHAIN}`)).toBe(true);
    expect(stub.supportsChain!("eip155:999")).toBe(false); // HyperEVM: v4 pinned not quotable, no v3
    expect(stub.supportsChain!("eip155:999999")).toBe(false);
    expect(stub.supportsChainPair!(`eip155:${CHAIN}`, "eip155:8453")).toBe(false);
    expect(typeof stub.describeActivity).toBe("function");
  });
});
