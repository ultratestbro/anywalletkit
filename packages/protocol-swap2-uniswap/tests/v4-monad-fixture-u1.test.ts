// cp0x ask 1c, the v4 half (UNISWAP-V4-RESEARCH §7.3, §9 U1): Monad 62,000 MON → AUSD and 100 MON → AUSD at block
// 125,409,523, replayed offline through the real provider with v4 "native-in". The v3 answers are the U0 recording
// (fixtures/rpc/monad-125409523.json); the v4 ones (the deployment check, the shipped-list discovery through Multicall3
// on the pinned StateView, the V4Quoter candidates and probes) were recorded at the same block by the 0.5.0 provider
// itself (fixtures/rpc/monad-125409523-v4.json). Both of cp0x's expectations, side by side: v3 thin and v4 deep → v4
// wins and passes the 500 gate; v4 absent → refused at 500. Then the failure paths that must refuse rather than quote
// from fewer pools, and the remote corridor (old 0.4.11 pins refuse a Universal Router quote; v4 "off" keeps v3).
import {readFileSync} from "node:fs";
import {afterEach, describe, expect, it, vi} from "vitest";
import {decodeAbiParameters, decodeFunctionData, encodeAbiParameters, getAddress, keccak256, parseAbi, type Hex} from "viem";
import type {Swap2RefusalInfo} from "@anywalletkit/protocol-swap2-core/errors";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {remotePinRefusal} from "@anywalletkit/protocol-swap2-core/validate";
import {createSwap2Handler} from "@anywalletkit/protocol-swap2-core/server";
import {remoteProvider} from "@anywalletkit/protocol-swap2-core/remote";
import {uniswapProvider, type UniswapProviderConfig} from "../src/provider.js";
import {UNISWAP_V3, uniswapPins, uniswapV3VerifyQuote, uniswapVerifyQuote} from "../src/addresses.js";
import {UNISWAP_V4} from "../src/v4/addresses.js";
import {MULTICALL3} from "../src/v4/discover.js";
import {poolIdOf} from "../src/v4/pool.js";

afterEach(() => vi.unstubAllGlobals());

interface Fixture {
  chainId: number;
  block: {number: string; hex: string; hash: string; gasLimit: string};
  calls: Record<string, {result?: unknown; error?: unknown}>;
}
const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/rpc/${name}`, import.meta.url), "utf8")) as Fixture;
const v3fx = load("monad-125409523.json");
const v4fx = load("monad-125409523-v4.json");
const CALLS = {...v3fx.calls, ...v4fx.calls};

const AUSD = getAddress("0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a");
const USDC = getAddress("0x754704Bc059F8C67012fEd69BC8A327a5aafb603");
const NATIVE = "0x0000000000000000000000000000000000000000";
const ME = "0x1111111111111111111111111111111111111111";
const RPC = {143: ["https://monad.fixture"]};
const D4 = UNISWAP_V4[143]!;
const MON = (n: bigint) => (n * 10n ** 18n).toString();
const params = (amountIn: string, extra: Partial<QuoteParams> = {}): QuoteParams => ({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "MON", destToken: AUSD, amountIn, destAddress: ME, refundAddress: ME, ...extra});
/** The deployment checks (v3 factory()/WETH9(), v4 poolManager()) and eth_getCode: read once per chain at "latest". */
const DEPLOYMENT_CHECK = /^0x(c45a0155|4aa4a4fc|dc4c90d3)$/;
const MC3 = parseAbi([
  "struct Call3 { address target; bool allowFailure; bytes callData; }",
  "struct Result { bool success; bytes returnData; }",
  "function aggregate3(Call3[] calls) payable returns (Result[] returnData)",
]);
const RESULTS = [{type: "tuple[]", components: [{name: "success", type: "bool"}, {name: "returnData", type: "bytes"}]}] as const;

type Odd = (req: {method: string; to?: string; data?: string}) => object | undefined;
/** Serves both recordings (an answer `odd` returns instead, when it returns one); every read's block tag, every miss
 *  and every request are kept for the test to check. */
function replay(odd?: Odd) {
  const tags = new Set<string>();
  const misses: string[] = [];
  const seen: {method: string; to?: string; data?: string}[] = [];
  const f = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]}[];
    return new Response(JSON.stringify(batch.map((req) => {
      let key = req.method;
      let to: string | undefined, data: string | undefined;
      if (req.method === "eth_call") {
        const [c, tag] = req.params as [{to: string; data: string}, string];
        to = c.to.toLowerCase();
        data = c.data.toLowerCase();
        if (!DEPLOYMENT_CHECK.test(data.slice(0, 10))) tags.add(tag);
        key = `eth_call ${to} ${data}`;
      } else if (req.method === "eth_getCode") {
        to = String(req.params[0]).toLowerCase();
        key = `eth_getCode ${to}`;
      }
      seen.push({method: req.method, ...(to ? {to} : {}), ...(data ? {data} : {})});
      const instead = odd?.({method: req.method, ...(to ? {to} : {}), ...(data ? {data} : {})});
      if (instead) return {jsonrpc: "2.0", id: req.id, ...instead};
      const answer = CALLS[key];
      if (!answer) {
        misses.push(key.slice(0, 120));
        return {jsonrpc: "2.0", id: req.id, error: {code: -32603, message: "not in the recording"}};
      }
      return {jsonrpc: "2.0", id: req.id, ...answer};
    })));
  }) as typeof fetch;
  return {fetch: f, tags, misses, seen};
}

async function quote(amountIn: string, config: Partial<UniswapProviderConfig> = {}, odd?: Odd, extra: Partial<QuoteParams> = {}) {
  const r = replay(odd);
  vi.stubGlobal("fetch", r.fetch);
  const heard: Array<[string, Swap2RefusalInfo | undefined]> = [];
  const provider = uniswapProvider({rpcUrls: RPC, ...config});
  const q = await provider.getQuote({...params(amountIn, extra), onRefusal: (t: string, i?: Swap2RefusalInfo) => { heard.push([t, i]); }});
  return {q, heard, tags: [...r.tags], misses: r.misses, seen: r.seen, provider};
}

const DEEP_MON_USDC = poolIdOf({currency0: NATIVE, currency1: USDC, fee: 500, tickSpacing: 10, hooks: NATIVE});
const AUSD_USDC_50_1 = poolIdOf({currency0: AUSD, currency1: USDC, fee: 50, tickSpacing: 1, hooks: NATIVE});

describe("Monad 62,000 MON → AUSD at block 125,409,523: v3 and v4 ranked together", () => {
  it("the v4 recording is of the same block as the v3 one", () => {
    expect(v4fx.chainId).toBe(143);
    expect(v4fx.block).toEqual(v3fx.block);
    expect(JSON.stringify(v4fx)).not.toMatch(/https?:\/\//);
  });

  it('v4 "off" (the default): the 0.4.11 v3 quote, and no v4 read at all', async () => {
    const {q, misses, seen} = await quote(MON(62_000n));
    expect(misses).toEqual([]);
    expect(q).toMatchObject({destAmount: "1130999", txRequest: {to: UNISWAP_V3[143]!.router, gasLimit: "16303291"}});
    expect(q!.providerData!.venue).toBeUndefined();
    expect(seen.some((s) => s.to === MULTICALL3.toLowerCase() || s.to === D4.quoter.toLowerCase() || s.method === "eth_getCode")).toBe(false);
  });

  it('v4 "native-in", unset: v4 wins — 676.608109 AUSD via MON → USDC 0.05%/10 → AUSD 0.005%/1 (impact 17) against v3\'s 1.130999', async () => {
    const {q, heard, misses, tags} = await quote(MON(62_000n), {v4: "native-in"});
    expect(misses).toEqual([]);
    expect(heard).toEqual([]);
    expect(tags).toEqual(["latest"]);
    expect(q).toMatchObject({destAmount: "676608109", sourceAmount: MON(62_000n), txRequest: {to: D4.universalRouter, value: MON(62_000n), chainId: 143, gasLimit: "264844"}});
    expect(q!.txRequest!.approvalAddress).toBeUndefined();
    const pd = q!.providerData!;
    expect(pd).toMatchObject({venue: "v4", route: "v4 via USDC 0.05%/10 → 0.005%/1", priceImpactBps: "17", router: D4.universalRouter, currencyIn: NATIVE, currencyOut: AUSD, amountIn: MON(62_000n), minOut: q!.minDestAmount});
    expect(pd.valueLossBps).toBeUndefined(); // as v3: the spot measure rides only when the gate is set
    const keys = JSON.parse(pd.poolKeys!) as Parameters<typeof poolIdOf>[0][];
    expect(keys.map(poolIdOf)).toEqual([DEEP_MON_USDC, AUSD_USDC_50_1]);
    expect(pd.path).toBe(`${NATIVE}>${USDC}>${AUSD}`);
    // The app's shipped pins accept it (the Universal Router is a call target, the strict check passes)…
    expect(uniswapVerifyQuote(params(MON(62_000n)), q!)).toBeNull();
    expect(uniswapPins.callTargets("eip155:143")).toContain(D4.universalRouter);
    // …and 0.4.11's pins refuse it.
    expect(uniswapV3VerifyQuote(params(MON(62_000n)), q!)).toMatch(/not the SwapRouter/);
  });

  it('v4 "native-in", maxPriceImpactBps 500: v4 wins and passes — G = max(probe 17, spot 23) = 23, every read at the one block', async () => {
    const {q, heard, misses, tags} = await quote(MON(62_000n), {v4: "native-in", maxPriceImpactBps: 500});
    expect(misses).toEqual([]);
    expect(heard).toEqual([]);
    expect(tags).toEqual([v3fx.block.hex]);
    expect(q).toMatchObject({destAmount: "676608109", providerData: {venue: "v4", priceImpactBps: "17", valueLossBps: "23"}});
  });

  it("the gate is the winner's: 23 refuses at a limit of 23, passes at 24", async () => {
    const at = await quote(MON(62_000n), {v4: "native-in", maxPriceImpactBps: 23});
    expect(at.q).toBeNull();
    expect(at.heard).toEqual([["uniswap: loses 0.2% of the value to price impact — its pools are too thin for this amount (limit 0.23%; best route v4 via USDC 0.05%/10 → 0.005%/1)", {reason: "insufficient_liquidity"}]]);
    const above = await quote(MON(62_000n), {v4: "native-in", maxPriceImpactBps: 24});
    expect(above.q?.destAmount).toBe("676608109");
  });

  it('v4 absent ("off") at 500: refused — the v3 route loses 99.8%', async () => {
    const {q, heard, misses} = await quote(MON(62_000n), {maxPriceImpactBps: 500});
    expect(misses).toEqual([]);
    expect(q).toBeNull();
    expect(heard).toEqual([["uniswap: loses 99.8% of the value to price impact — its pools are too thin for this amount (limit 5%; best route via USDC 0.3% → 0.01%)", {reason: "insufficient_liquidity"}]]);
  });

  it("100 MON at 500: v4 1.093251 AUSD wins (G = 6), while v3 alone (0.871160) is refused", async () => {
    const on = await quote(MON(100n), {v4: "native-in", maxPriceImpactBps: 500});
    expect(on.misses).toEqual([]);
    expect(on.q).toMatchObject({destAmount: "1093251", providerData: {venue: "v4", route: "v4 via USDC 0.05%/10 → 0.0009%/1", priceImpactBps: "0", valueLossBps: "6"}});
    const off = await quote(MON(100n), {maxPriceImpactBps: 500});
    expect(off.q).toBeNull();
    expect(off.heard[0]![1]).toEqual({reason: "insufficient_liquidity"});
  });

  it("v4MinEdgeBps: v4 has to pay more than v3 by more than the edge — v4's ×598 here clears any edge the option allows", async () => {
    const {q} = await quote(MON(62_000n), {v4: "native-in", v4MinEdgeBps: 10_000});
    expect(q?.providerData?.venue).toBe("v4");
  });
});

describe("a failed v4 read refuses the quote — never a quote from fewer pools (§5.3, decision 5)", () => {
  const isDiscovery = (r: {to?: string; data?: string}) => r.to === MULTICALL3.toLowerCase() && !!r.data && decodeFunctionData({abi: MC3, data: r.data as Hex}).args[0].every((c) => getAddress(c.target) === getAddress(D4.stateView));

  it("the discovery read rate-limited on every attempt (QuickNode -32007): rate_limited, not the v3 route and not a thinner v4 one", async () => {
    const limited = {error: {code: -32007, message: "50/second request limit reached"}};
    const {q, heard} = await quote(MON(62_000n), {v4: "native-in"}, (r) => (isDiscovery(r) ? limited : undefined));
    expect(q).toBeNull();
    expect(heard).toHaveLength(1);
    expect(heard[0]![1]).toEqual({reason: "rate_limited"});
  }, 15_000);

  it("the deep MON/USDC 500/10 pool's state read failing inside the aggregate: refused, never the 1%/200 route", async () => {
    // The research lane that lost this one read to HTTP 429 reported 584.56 AUSD at 1,337 bps (§10, refuted).
    const {q, heard} = await quote(MON(62_000n), {v4: "native-in"}, (r) => {
      if (!isDiscovery(r)) return undefined;
      const key = `eth_call ${r.to} ${r.data}`;
      const calls = decodeFunctionData({abi: MC3, data: r.data as Hex}).args[0];
      const results = [...decodeAbiParameters(RESULTS, CALLS[key]!.result as Hex)[0]];
      const at = calls.findIndex((c) => c.callData.toLowerCase().includes(DEEP_MON_USDC.slice(2)));
      expect(at).toBeGreaterThanOrEqual(0);
      results[at] = {success: false, returnData: "0x"};
      return {result: encodeAbiParameters(RESULTS, [results])};
    });
    expect(q).toBeNull();
    expect(heard[0]![0]).toMatch(/a pool state read failed .* refusing rather than quoting from fewer pools/);
    expect(heard[0]![1]).toEqual({reason: "upstream_unavailable"});
  });

  it("a listed pool reading as uninitialized (a wrong node): refused", async () => {
    const {q, heard} = await quote(MON(62_000n), {v4: "native-in"}, (r) => {
      if (!isDiscovery(r)) return undefined;
      const results = [...decodeAbiParameters(RESULTS, CALLS[`eth_call ${r.to} ${r.data}`]!.result as Hex)[0]].map((x) => ({success: true, returnData: `0x${"0".repeat(x.returnData.length - 2)}` as Hex}));
      return {result: encodeAbiParameters(RESULTS, [results])};
    });
    expect(q).toBeNull();
    expect(heard[0]![0]).toMatch(/reads as uninitialized/);
  });

  it("a V4Quoter call that fails without revert data inside the aggregate: refused, not ranked out", async () => {
    // Every quote aggregate answers each sub-call with no revert data (how a sub-call out of gas looks): the batcher splits
    // the chunk down to single calls, and one that still fails that way refuses the quote.
    const {q, heard} = await quote(MON(62_000n), {v4: "native-in"}, (r) => {
      if (r.to !== MULTICALL3.toLowerCase() || isDiscovery(r)) return undefined;
      const n = decodeFunctionData({abi: MC3, data: r.data as Hex}).args[0].length;
      return {result: encodeAbiParameters(RESULTS, [Array.from({length: n}, () => ({success: false, returnData: "0x" as Hex}))])};
    });
    expect(q).toBeNull();
    expect(heard[0]![0]).toMatch(/without revert data/);
    expect(heard[0]![1]).toEqual({reason: "upstream_unavailable"});
  });

  it("a v4 deployment that does not match its pins (another router build): v4 is off on the chain, v3 still quotes", async () => {
    const {q, heard, seen} = await quote(MON(62_000n), {v4: "native-in"}, (r) => (r.method === "eth_getCode" ? {result: "0x6080604052"} : undefined));
    expect(heard).toEqual([]);
    expect(q).toMatchObject({destAmount: "1130999", txRequest: {to: UNISWAP_V3[143]!.router}});
    expect(seen.some((s) => s.to === MULTICALL3.toLowerCase())).toBe(false);
  });

  it("the v4 deployment check unanswered: refused (rate_limited), not a silent v3-only quote", async () => {
    const {q, heard} = await quote(MON(62_000n), {v4: "native-in"}, (r) => (r.method === "eth_getCode" ? {error: {code: -32007, message: "50/second request limit reached"}} : undefined));
    expect(q).toBeNull();
    expect(heard[0]![1]).toEqual({reason: "rate_limited"});
  }, 15_000);
});

// ── The remote corridor (§5.5): a backend running the provider behind createSwap2Handler, apps on old and new pins ──

const SECRET = "test-seal-secret-that-is-at-least-32-bytes-long";
function backend(config: Partial<UniswapProviderConfig>): typeof fetch {
  const handle = createSwap2Handler<string>({providers: [uniswapProvider({rpcUrls: RPC, ...config})], sealSecret: SECRET, guard: () => {}, subject: () => "app"});
  return (async (url: string, init: RequestInit) => {
    const res = await handle(String(url).split("/").pop()!, JSON.parse(String(init.body)), "app");
    return new Response(JSON.stringify(res.body), {status: res.status, headers: {"content-type": "application/json"}});
  }) as unknown as typeof fetch;
}
/** The pins a 0.4.11 app ships: SwapRouter02 only, the v3 check. */
const V3_ONLY = (chain: string): readonly string[] => {
  const id = Number(chain.slice(7));
  return Object.prototype.hasOwnProperty.call(UNISWAP_V3, id) ? [UNISWAP_V3[id]!.router] : [];
};
const PINS_0411 = {callTargets: V3_ONLY, spenders: V3_ONLY, verifyQuote: uniswapV3VerifyQuote, reasonOf: uniswapPins.reasonOf!};
async function appQuote(server: Partial<UniswapProviderConfig>, pins: typeof PINS_0411 | typeof uniswapPins): Promise<{q: Quote | null; error?: unknown; stub: CrossChainProvider}> {
  const r = replay();
  vi.stubGlobal("fetch", r.fetch);
  const stub = remoteProvider({name: "uniswap", baseUrl: "https://backend.example/api/swap2", fetchImpl: backend(server), supportsSameChain: true, ...pins});
  try {
    const q = await stub.getQuote(params(MON(62_000n)));
    return {q, stub};
  } catch (error) {
    return {q: null, error, stub};
  }
}

describe("remote corridor: old 0.4.11 pins and v4 on the server", () => {
  it('server v4 "native-in", app on 0.4.11 pins: the Universal Router quote is refused (the app loses Uniswap on the pair — hence the server flag)', async () => {
    const {q, error, stub} = await appQuote({v4: "native-in"}, PINS_0411);
    expect(q).toBeNull();
    expect(String((error as Error).message)).toMatch(/fails this app's own check — the call targets 0xa6CE4F10d83dBdDAc17E68e1837ca9cE6a1b596e, not the SwapRouter/);
    expect((error as {reason?: string}).reason).toBe("vault_mismatch");
    expect(stub.callTargets!("eip155:143")).not.toContain(D4.universalRouter);
  });

  it('server v4 "off", app on 0.4.11 pins: v3 keeps working', async () => {
    const {q, error, stub} = await appQuote({}, PINS_0411);
    expect(error).toBeUndefined();
    expect(q).toMatchObject({destAmount: "1130999", txRequest: {to: UNISWAP_V3[143]!.router}});
    expect(remotePinRefusal(stub, q!, "eip155:143")).toBeNull();
  });

  it('server v4 "native-in", app on 0.5.0 pins: the v4 quote passes the app\'s own strict check and its pin list', async () => {
    const {q, error, stub} = await appQuote({v4: "native-in"}, uniswapPins);
    expect(error).toBeUndefined();
    expect(q).toMatchObject({destAmount: "676608109", txRequest: {to: D4.universalRouter, value: MON(62_000n)}, providerData: {venue: "v4"}});
    expect(remotePinRefusal(stub, q!, "eip155:143")).toBeNull();
  });

  it('server v4 "off", app on 0.5.0 pins: the v3 quote passes as before', async () => {
    const {q, error} = await appQuote({}, uniswapPins);
    expect(error).toBeUndefined();
    expect(q).toMatchObject({destAmount: "1130999", txRequest: {to: UNISWAP_V3[143]!.router}});
  });

  it("a compromised backend's v4 quote (TAKE to itself, re-sealed) is refused by the app's pins", async () => {
    const {q} = await quote(MON(62_000n), {v4: "native-in"});
    const evil = "0x2222222222222222222222222222222222222222";
    const data = q!.txRequest!.data!.toLowerCase().split(ME.slice(2).toLowerCase()).join(evil.slice(2));
    expect(data).not.toBe(q!.txRequest!.data!.toLowerCase());
    expect(uniswapVerifyQuote(params(MON(62_000n)), {...q!, txRequest: {...q!.txRequest!, data}})).toMatch(/TAKE pays 0x2222222222222222222222222222222222222222, not the recipient/);
    expect(keccak256(data as Hex)).not.toBe(keccak256(q!.txRequest!.data! as Hex));
  });
});

// ── preflightDeposit on a v4 quote (§6.5 row 16, §6.6): V4Quoter re-quote, then an eth_call of the exact tx from the sender ──

describe("v4 preflight: the same route re-quoted, then the exact transaction dry-run from the quote's sender", () => {
  const SENDER = getAddress("0x4444444444444444444444444444444444444444");
  async function v4Quote(): Promise<{q: Quote; provider: CrossChainProvider}> {
    const {q, provider} = await quote(MON(62_000n), {v4: "native-in"}, undefined, {sender: SENDER});
    expect(q!.providerData!.sender).toBe(SENDER);
    return {q: q!, provider};
  }
  type Answer = {result?: unknown; error?: {code: number; message: string; data?: string}};
  /** The node for the preflight: the quoter's direct re-quote and the dry run; every request is kept. */
  function node(requote: Answer, dry: Answer) {
    const seen: {method: string; params: unknown[]}[] = [];
    vi.stubGlobal("fetch", (async (_u: RequestInfo | URL, init?: RequestInit) => {
      const batch = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]}[];
      return new Response(JSON.stringify(batch.map((req) => {
        seen.push({method: req.method, params: req.params});
        const c = req.params[0] as {to: string; from?: string};
        return {jsonrpc: "2.0", id: req.id, ...(getAddress(c.to) === getAddress(D4.quoter) ? requote : dry)};
      })));
    }) as typeof fetch);
    return seen;
  }
  const quoted = (out: bigint): Answer => ({result: encodeAbiParameters([{type: "uint256"}, {type: "uint256"}], [out, 86_591n])});
  const revert = (data: Hex): Answer => ({error: {code: 3, message: "execution reverted", data}});
  const err = (sig: string, args: readonly unknown[] = []) => encodeErrorResultOf(sig, args);

  it("passes: the re-quote pays at least the minimum and the exact call succeeds from the sender at latest", async () => {
    const {q, provider} = await v4Quote();
    const seen = node(quoted(676_608_109n), {result: "0x"});
    const tx = await provider.buildDeposit(q);
    await expect(provider.preflightDeposit!(q, tx)).resolves.toBeUndefined();
    expect(seen).toHaveLength(2);
    const dry = seen[1]!;
    expect(dry.method).toBe("eth_call");
    expect(dry.params[0]).toEqual({from: SENDER, to: D4.universalRouter, data: q.txRequest!.data, value: `0x${BigInt(q.txRequest!.value!).toString(16)}`});
    expect(dry.params[1]).toBe("latest");
  });

  it("the pool now pays under the minimum: price_check_failed, nothing dry-run", async () => {
    const {q, provider} = await v4Quote();
    const seen = node(quoted(BigInt(q.minDestAmount) - 1n), {result: "0x"});
    await expect(provider.preflightDeposit!(q, await provider.buildDeposit(q))).rejects.toMatchObject({reason: "price_check_failed", message: expect.stringMatching(/price moved — the pool now pays \d+, under your minimum/)});
    expect(seen).toHaveLength(1);
  });

  it("the re-quote is a partial fill (NotEnoughLiquidity wrapped in UnexpectedRevertBytes): insufficient_liquidity", async () => {
    const {q, provider} = await v4Quote();
    const inner = err("NotEnoughLiquidity(bytes32 poolId)", [DEEP_MON_USDC]);
    node(revert(err("UnexpectedRevertBytes(bytes revertData)", [inner])), {result: "0x"});
    await expect(provider.preflightDeposit!(q, await provider.buildDeposit(q))).rejects.toMatchObject({reason: "insufficient_liquidity"});
  });

  it("the dry run reverts: V4TooLittleReceived → price_check_failed, CurrencyNotSettled → insufficient_liquidity, the deadline → quote_expired", async () => {
    const {q, provider} = await v4Quote();
    const tx = await provider.buildDeposit(q);
    const failed = err("ExecutionFailed(uint256 commandIndex, bytes message)", [0n, err("V4TooLittleReceived(uint256 minAmountOutReceived, uint256 amountReceived)", [BigInt(q.minDestAmount), 1n])]);
    node(quoted(676_608_109n), revert(failed));
    await expect(provider.preflightDeposit!(q, tx)).rejects.toMatchObject({reason: "price_check_failed", message: expect.stringMatching(/dry-run from 0x4444444444444444444444444444444444444444/)});
    node(quoted(676_608_109n), revert(err("ExecutionFailed(uint256 commandIndex, bytes message)", [0n, err("CurrencyNotSettled()")])));
    await expect(provider.preflightDeposit!(q, tx)).rejects.toMatchObject({reason: "insufficient_liquidity"});
    node(quoted(676_608_109n), revert(err("TransactionDeadlinePassed()")));
    await expect(provider.preflightDeposit!(q, tx)).rejects.toMatchObject({reason: "quote_expired"});
  });

  it("no answer is a refusal, never a pass", async () => {
    const {q, provider} = await v4Quote();
    node(quoted(676_608_109n), {error: {code: -32603, message: "internal error"}});
    await expect(provider.preflightDeposit!(q, await provider.buildDeposit(q))).rejects.toMatchObject({reason: "upstream_unavailable"});
  });

  it("refuses what it cannot dry-run: no sender, another target, an unknown venue, v4 off on this side", async () => {
    const {q, provider} = await v4Quote();
    node(quoted(676_608_109n), {result: "0x"});
    const tx = await provider.buildDeposit(q);
    const {sender: _s, ...noSender} = q.providerData!;
    await expect(provider.preflightDeposit!({...q, providerData: noSender}, tx)).rejects.toMatchObject({reason: "policy_refused", message: expect.stringMatching(/names no sender/)});
    await expect(provider.preflightDeposit!(q, {...tx, to: UNISWAP_V3[143]!.router})).rejects.toMatchObject({reason: "vault_mismatch"});
    await expect(provider.preflightDeposit!({...q, providerData: {...q.providerData!, venue: "v9"}}, tx)).rejects.toMatchObject({reason: "policy_refused", message: expect.stringMatching(/unknown venue/)});
    await expect(uniswapProvider({rpcUrls: RPC}).preflightDeposit!(q, tx)).rejects.toMatchObject({reason: "policy_refused", message: expect.stringMatching(/v4 is off here/)});
    const hooked = JSON.stringify([{currency0: NATIVE, currency1: USDC, fee: 500, tickSpacing: 10, hooks: "0x4445520306c9C70952bDFEc28F3989f53d9f80C4"}]);
    await expect(provider.preflightDeposit!({...q, providerData: {...q.providerData!, poolKeys: hooked}}, tx)).rejects.toMatchObject({reason: "policy_refused", message: expect.stringMatching(/hookless pools/)});
  });
});

/** Revert data for `Name(type name, …)` (selector + ABI-encoded arguments). */
function encodeErrorResultOf(sig: string, args: readonly unknown[]): Hex {
  const m = /^(\w+)\((.*)\)$/.exec(sig)!;
  const types = m[2]!.split(",").map((x) => x.trim()).filter(Boolean).map((x) => x.split(" ")[0]!);
  const selector = keccak256(new TextEncoder().encode(`${m[1]}(${types.join(",")})`)).slice(0, 10);
  return `${selector}${encodeAbiParameters(types.map((type) => ({type})), args as never).slice(2)}` as Hex;
}
