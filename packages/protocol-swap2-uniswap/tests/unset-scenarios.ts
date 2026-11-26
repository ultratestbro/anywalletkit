// The scenarios behind tests/unset-byte-identical.test.ts: every getQuote / preflightDeposit path the probe and the
// quote take with `maxPriceImpactBps` unset, run against a provider factory, recording every JSON-RPC request sent and
// every outcome. fixtures/unset-0.4.11.json is this file run against the 0.4.11 dist (origin/main 7535149c, built and
// compared byte for byte with the released dist); the test runs it against src and wants the same. To record it again:
// in a vitest file, import {uniswapProvider} from a 0.4.11 dist and write
// {module, at, scenarios: {[name]: {...r, requests: r.requests.map(digest)}}} for r = await run(uniswapProvider, s, refusalOf).
import {createHash} from "node:crypto";
import {vi} from "vitest";
import {decodeFunctionData, encodeAbiParameters, parseAbi, type Hex} from "viem";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {D, ME, RPC, SQRT_CEIL, SQRT_FLOOR, USDC, USDT, rpcStub, type StubOptions} from "./fixtures.js";

type Factory = (config: Record<string, unknown>) => CrossChainProvider;
type Body = {jsonrpc: string; id: number; method: string; params: unknown[]};
type Answer = (req: Body) => unknown;

const QUOTER = parseAbi([
  "function quoteExactInputSingle((address tokenIn, address tokenOut, uint256 amountIn, uint24 fee, uint160 sqrtPriceLimitX96) params) returns (uint256, uint160, uint32, uint256)",
  "function quoteExactInput(bytes path, uint256 amountIn) returns (uint256, uint160[], uint32[], uint256)",
]);
const NATIVE = "0x0000000000000000000000000000000000000000";
const base = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME};
const usdcUsdt = {...base, sourceToken: "USDC", destToken: USDT, amountIn: "1000000"};
/** The time every scenario runs at (the multicall deadline and validUntilMs are read from the clock). */
export const AT = Date.UTC(2026, 10, 26, 0, 0, 0);

/** The quoted input of a quoter call, or undefined for another call. */
function quotedIn(req: Body): bigint | undefined {
  const p = req.params?.[0] as {data?: Hex} | undefined;
  if (req.method !== "eth_call" || !p?.data) return undefined;
  try {
    const c = decodeFunctionData({abi: QUOTER, data: p.data});
    return c.functionName === "quoteExactInputSingle" ? (c.args[0] as {amountIn: bigint}).amountIn : (c.args[1] as bigint);
  } catch {
    return undefined;
  }
}

/** The probe's one-call batch (input `amountIn / 1000`) answered by `answer` (an item, or a whole HTTP reply). */
function probeAnswered(stub: StubOptions, probeIn: bigint, answer: Answer | {http: number} | {body: unknown} | "abort", ctrl?: AbortController): typeof fetch {
  const inner = rpcStub(stub);
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as Body[];
    if (batch.length === 1 && quotedIn(batch[0]!) === probeIn) {
      if (answer === "abort") {
        ctrl!.abort();
        throw new DOMException("This operation was aborted", "AbortError");
      }
      if (typeof answer === "object" && "http" in answer) return new Response("{}", {status: answer.http});
      if (typeof answer === "object" && "body" in answer) return new Response(JSON.stringify(answer.body));
      return new Response(JSON.stringify([{jsonrpc: "2.0", id: batch[0]!.id, ...(answer(batch[0]!) as object)}]));
    }
    return inner(url, init);
  }) as typeof fetch;
}

const single = (amount: bigint) => ({result: encodeAbiParameters([{type: "uint256"}, {type: "uint160"}, {type: "uint32"}, {type: "uint256"}], [amount, 2n ** 96n, 1, 90_000n])});

interface Scenario {
  name: string;
  params: Omit<QuoteParams, "onRefusal">;
  config?: Record<string, unknown>;
  fetch: (ctrl: AbortController) => typeof fetch;
  /** Abort the caller's signal (the probe scenario aborts it mid-quote). */
  signal?: boolean;
  /** Then run preflightDeposit against these stubs. */
  preflight?: StubOptions[];
}

export const SCENARIOS: Scenario[] = [
  {name: "best of the fee tiers", params: usdcUsdt, fetch: () => rpcStub({byFee: {100: 900_000n, 500: 1_000_000n, 3000: 990_000n}})},
  {name: "impact 4300 from the probe", params: usdcUsdt, fetch: () => rpcStub({byFee: {500: 1_000_000n}, impactBps: 4300})},
  {name: "flat pool, impact 0", params: usdcUsdt, fetch: () => rpcStub({byFee: {500: 1_000_000n}})},
  {name: "native in", params: {...base, sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000"}, fetch: () => rpcStub({quoterGas: 90_000n})},
  {name: "native in with refundETH", params: {...base, sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000"}, config: {refundNativeInput: true}, fetch: () => rpcStub()},
  {name: "native out", params: {...base, sourceToken: "USDC", destToken: NATIVE, amountIn: "1000000"}, fetch: () => rpcStub()},
  {name: "two pools only", params: usdcUsdt, fetch: () => rpcStub({byFee: {}, multiHop: 1_000_000n})},
  {name: "quoter gas 0", params: usdcUsdt, fetch: () => rpcStub({quoterGas: 0n})},
  {name: "quoter gas 5M", params: usdcUsdt, fetch: () => rpcStub({quoterGas: 5_000_000n})},
  {name: "caller slippage 100", params: {...usdcUsdt, slippageBps: 100}, fetch: () => rpcStub()},
  {name: "floor breach", params: {...usdcUsdt, minAmountOut: "999000"}, fetch: () => rpcStub()},
  {name: "no pool", params: usdcUsdt, fetch: () => rpcStub({byFee: {}})},
  {name: "every route drained", params: usdcUsdt, fetch: () => rpcStub({byFee: {500: 1n, 3000: 1n}, sqrtAfter: {500: SQRT_CEIL, 3000: SQRT_FLOOR}})},
  {name: "minimum rounds to 0", params: {...usdcUsdt, amountIn: "1"}, fetch: () => rpcStub({byFee: {500: 1_000_000n}})},
  {name: "deployment mismatch", params: usdcUsdt, fetch: () => rpcStub({badFactory: true})},
  {name: "failover past a down endpoint", params: usdcUsdt, config: {rpcUrls: {1: ["https://down.test", "https://rpc.test"]}}, fetch: () => rpcStub({down: ["https://down.test"]})},
  // The probe's paths with no figure (UNISWAP-V4-RESEARCH gaps/impact-gate §1.1, P1–P9): the quote stands, unmeasured.
  {name: "P1 amount under 1000 units: no probe", params: {...usdcUsdt, amountIn: "999"}, fetch: () => rpcStub({byFee: {500: 1_000_000n}})},
  {name: "P2a probe reverts", params: usdcUsdt, fetch: () => probeAnswered({}, 1000n, () => ({error: {code: 3, message: "execution reverted: AS", data: "0x08c379a0"}}))},
  {name: "P2b probe per-item rate limit", params: usdcUsdt, fetch: () => probeAnswered({}, 1000n, () => ({error: {code: -32005, message: "limit exceeded"}}))},
  {name: "P3 probe HTTP 429", params: usdcUsdt, fetch: () => probeAnswered({}, 1000n, {http: 429})},
  {name: "P4 probe empty answer", params: usdcUsdt, fetch: () => probeAnswered({}, 1000n, () => ({result: "0x"}))},
  {name: "P5 probe pays 0", params: usdcUsdt, fetch: () => probeAnswered({}, 1000n, () => single(0n))},
  {name: "P6 probe does not decode", params: usdcUsdt, fetch: () => probeAnswered({}, 1000n, () => ({result: "0x1234"}))},
  {name: "P7 probe batch refused", params: usdcUsdt, fetch: () => probeAnswered({}, 1000n, {body: {jsonrpc: "2.0", error: {code: -32007, message: "50/second request limit reached"}}})},
  {name: "P8 caller aborts during the probe", params: usdcUsdt, signal: true, fetch: (ctrl) => probeAnswered({}, 1000n, "abort", ctrl)},
  {name: "P9 probe rate under the full rate: clamped 0", params: usdcUsdt, fetch: () => probeAnswered({}, 1000n, () => single(900n))},
  {name: "preflight: unchanged, moved, drained, gone", params: usdcUsdt, fetch: () => rpcStub(), preflight: [{}, {byFee: {500: 900_000n}}, {sqrtAfter: {500: SQRT_FLOOR}}, {byFee: {}}]},
  {name: "preflight of a two-pool route", params: usdcUsdt, fetch: () => rpcStub({byFee: {}, multiHop: 1_000_000n}), preflight: [{byFee: {}, multiHop: 1_000_000n}, {byFee: {}, multiHop: 1_000_000n, multiHopSqrtAfter: [2n ** 96n, SQRT_CEIL]}]},
];

export interface Recorded {
  /** Every batch sent, in order, as [url, the body exactly as sent]. */
  requests: Array<[string, string]>;
  refusals: Array<[string, unknown]>;
  quote: Quote | null;
  preflight: Array<{ok: true} | {message: string; reason: unknown}>;
}

/** A request as the fixture keeps it: the URL, the sha256 of the exact body, and what it asks (method, target, selector). */
export function digest([url, body]: [string, string]): [string, string, string] {
  const calls = (JSON.parse(body) as Body[]).map((c) => {
    const p = c.params?.[0] as {to?: string; data?: string} | undefined;
    return c.method === "eth_call" && p?.data ? `${p.to}:${p.data.slice(0, 10)}` : c.method;
  });
  return [url, createHash("sha256").update(body).digest("hex"), calls.join(" ")];
}

/** Runs one scenario on a fresh provider; requests and outcomes recorded in order. */
export async function run(factory: Factory, s: Scenario, refusalOf: (e: unknown) => unknown): Promise<Recorded> {
  vi.useFakeTimers({toFake: ["Date"]});
  vi.setSystemTime(AT);
  try {
    const ctrl = new AbortController();
    const requests: Recorded["requests"] = [];
    const record = (inner: typeof fetch): typeof fetch => (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push([String(url), String(init?.body)]);
      return inner(url, init);
    }) as typeof fetch;
    vi.stubGlobal("fetch", record(s.fetch(ctrl)));
    const refusals: Recorded["refusals"] = [];
    const p = factory({rpcUrls: RPC, ...s.config});
    const quote = await p.getQuote({...s.params, onRefusal: (text: string, info?: unknown) => { refusals.push([text, info]); }} as QuoteParams, s.signal ? ctrl.signal : undefined);
    const preflight: Recorded["preflight"] = [];
    for (const stub of s.preflight ?? []) {
      vi.stubGlobal("fetch", record(rpcStub(stub)));
      try {
        await p.preflightDeposit!(quote!, await p.buildDeposit(quote!));
        preflight.push({ok: true});
      } catch (e) {
        preflight.push({message: (e as Error).message, reason: refusalOf(e) ?? null});
      }
    }
    return {requests, refusals, quote: quote ? (JSON.parse(JSON.stringify(quote)) as Quote) : null, preflight};
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}

