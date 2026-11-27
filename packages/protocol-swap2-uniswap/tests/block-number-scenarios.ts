// The scenarios behind tests/block-number.test.ts: getQuote / getQuotes over every read path a quote takes — v3 alone
// (ungated, native out, gated by maxPriceImpactBps), v4 on the Monad recordings at block 125,409,523
// ("best" and venueRoutes "both", ungated and gated, a routeId pick) and the v4 token input with a sender (the
// eth_simulateV1 check) on the fake Monad node — every JSON-RPC request recorded as sent, and every outcome.
// fixtures/unpinned-0.5.0.json is this file run without `blockNumber` against the 0.5.0 source (origin/main d77449a0);
// the test runs it against src and wants the same requests, byte for byte, and the same outcomes. To record it again:
// in a vitest file of a 0.5.0 checkout, write {module, scenarios: {[name]: digested(await run(uniswapProvider, s))}}.
import {createHash} from "node:crypto";
import {readFileSync} from "node:fs";
import {vi} from "vitest";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {ME as ETH_ME, RPC as ETH_RPC, USDT as ETH_USDT, rpcStub} from "./fixtures.js";
import {AUSD as FAKE_AUSD, ME as FAKE_ME, RPC as FAKE_RPC, V4 as FAKE_V4, fakeNode} from "./v4-fake-node.js";

type Factory = (config: Record<string, unknown>) => CrossChainProvider;
type Body = {jsonrpc: string; id: number; method: string; params: unknown[]};

interface Recording {
  calls: Record<string, {result?: unknown; error?: unknown}>;
}
const load = (name: string) => JSON.parse(readFileSync(new URL(`../fixtures/rpc/${name}`, import.meta.url), "utf8")) as Recording;
/** The Monad recordings at block 125,409,523 (v3 and v4 reads, keyed by method, target and data — not by block tag). */
const CALLS = {...load("monad-125409523.json").calls, ...load("monad-125409523-v4.json").calls};
export const MONAD_BLOCK = "125409523";
export const MONAD_RPC = {143: ["https://monad.fixture"]};
const MONAD_AUSD = "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a";
const MONAD_ME = "0x1111111111111111111111111111111111111111";
const MON = (n: bigint) => (n * 10n ** 18n).toString();

/** Serves the Monad recordings whatever block a call names (a miss is a JSON-RPC error). */
export function monadReplay(): typeof fetch {
  return (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as Body[];
    return new Response(JSON.stringify(batch.map((req) => {
      let key = req.method;
      if (req.method === "eth_call") {
        const [c] = req.params as [{to: string; data: string}];
        key = `eth_call ${c.to.toLowerCase()} ${c.data.toLowerCase()}`;
      } else if (req.method === "eth_getCode") key = `eth_getCode ${String(req.params[0]).toLowerCase()}`;
      const answer = CALLS[key];
      return answer ? {jsonrpc: "2.0", id: req.id, ...answer} : {jsonrpc: "2.0", id: req.id, error: {code: -32603, message: "not in the recording"}};
    })));
  }) as typeof fetch;
}

export interface Scenario {
  name: string;
  /** The block a pinned run of this scenario names (`QuoteParams.blockNumber`). */
  block: string;
  config: Record<string, unknown>;
  params: Omit<QuoteParams, "onRefusal">;
  /** getQuotes (venueRoutes "both") instead of getQuote. */
  quotes?: boolean;
  fetch: () => typeof fetch;
}

const eth = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ETH_ME, refundAddress: ETH_ME};
const monad = (amountIn: string, extra: Partial<QuoteParams> = {}) => ({sourceChain: "eip155:143", destChain: "eip155:143", sourceToken: "MON", destToken: MONAD_AUSD, amountIn, destAddress: MONAD_ME, refundAddress: MONAD_ME, ...extra});
const fakeMonad = {sourceChain: "eip155:143", destChain: "eip155:143", destAddress: FAKE_ME, refundAddress: FAKE_ME};
/** The fake node's AUSD/USDC 0.0009%/1 pool (UNISWAP_V4_POOLS[143]) and the swap the token-input check simulates. */
const AUSD_USDC_9_1 = "0xd112fde908d7342135fc7297cc53d25bf7a11d6c6e21fe7ac3e73c40f70827e8";

export const SCENARIOS: Scenario[] = [
  {name: "v3, ungated: best of the fee tiers and the probe", block: "4660", config: {rpcUrls: ETH_RPC}, params: {...eth, sourceToken: "USDC", destToken: ETH_USDT, amountIn: "1000000"}, fetch: () => rpcStub({byFee: {100: 900_000n, 500: 1_000_000n, 3000: 990_000n}})},
  {name: "v3, ungated, native out", block: "4660", config: {rpcUrls: ETH_RPC}, params: {...eth, sourceToken: "USDC", destToken: "0x0000000000000000000000000000000000000000", amountIn: "1000000"}, fetch: () => rpcStub()},
  {name: "v3, maxPriceImpactBps 500: the pinned block, getPool and slot0", block: "4660", config: {rpcUrls: ETH_RPC, maxPriceImpactBps: 500}, params: {...eth, sourceToken: "USDC", destToken: ETH_USDT, amountIn: "1000000"}, fetch: () => rpcStub({byFee: {500: 1_000_000n}})},
  {name: "v4 native-in, best: 62,000 MON → AUSD (recorded)", block: MONAD_BLOCK, config: {rpcUrls: MONAD_RPC, v4: "native-in"}, params: monad(MON(62_000n)), fetch: monadReplay},
  {name: "v4 native-in, best, maxPriceImpactBps 500: 100 MON → AUSD (recorded)", block: MONAD_BLOCK, config: {rpcUrls: MONAD_RPC, v4: "native-in", maxPriceImpactBps: 500}, params: monad(MON(100n)), fetch: monadReplay},
  {name: "venueRoutes both: 62,000 MON → AUSD, v3 and v4 (recorded)", block: MONAD_BLOCK, config: {rpcUrls: MONAD_RPC, v4: "native-in", venueRoutes: "both"}, params: monad(MON(62_000n)), quotes: true, fetch: monadReplay},
  {name: "venueRoutes both, maxPriceImpactBps 500: 100 MON → AUSD (recorded)", block: MONAD_BLOCK, config: {rpcUrls: MONAD_RPC, v4: "native-in", venueRoutes: "both", maxPriceImpactBps: 500}, params: monad(MON(100n)), quotes: true, fetch: monadReplay},
  {name: "venueRoutes both, routeId v3: 100 MON → AUSD (recorded)", block: MONAD_BLOCK, config: {rpcUrls: MONAD_RPC, v4: "native-in", venueRoutes: "both"}, params: monad(MON(100n), {routeId: "v3"}), fetch: monadReplay},
  {name: "venueRoutes both, routeId v4: 100 MON → AUSD (recorded)", block: MONAD_BLOCK, config: {rpcUrls: MONAD_RPC, v4: "native-in", venueRoutes: "both"}, params: monad(MON(100n), {routeId: "v4"}), fetch: monadReplay},
  {name: "v4 all, token input with a sender: 700 USDC → AUSD, the approve + swap simulation (fake node)", block: "125409523", config: {rpcUrls: FAKE_RPC, v4: "all", v4Deployments: FAKE_V4}, params: {...fakeMonad, sourceToken: "USDC", destToken: FAKE_AUSD, amountIn: "700000000", sender: FAKE_ME},
    fetch: () => fakeNode({amount: 700_000_000n, v3: {tokenOut: FAKE_AUSD, fee: 100, out: 699_000_000n}, v4: new Map([[AUSD_USDC_9_1, {out: 700_500_000n, gas: 60_000n}]])}).fetch},
  {name: "v4 all, venueRoutes both, token input with a sender, maxPriceImpactBps 500 (fake node)", block: "125409523", config: {rpcUrls: FAKE_RPC, v4: "all", v4Deployments: FAKE_V4, venueRoutes: "both", maxPriceImpactBps: 500}, params: {...fakeMonad, sourceToken: "USDC", destToken: FAKE_AUSD, amountIn: "700000000", sender: FAKE_ME}, quotes: true,
    fetch: () => fakeNode({amount: 700_000_000n, v3: {tokenOut: FAKE_AUSD, fee: 100, out: 699_000_000n}, v4: new Map([[AUSD_USDC_9_1, {out: 700_500_000n, gas: 60_000n}]])}).fetch},
];

/** The time every scenario runs at (deadlines and validUntilMs are read from the clock). */
export const AT = Date.UTC(2026, 10, 26, 12, 0, 0);

export interface Recorded {
  /** Every batch sent, in order, as [url, the body exactly as sent]. */
  requests: Array<[string, string]>;
  refusals: Array<[string, unknown]>;
  quotes: Quote[];
}

/** One scenario on a fresh provider (`blockNumber`: pinned), requests and outcomes recorded. */
export async function run(factory: Factory, s: Scenario, blockNumber?: string): Promise<Recorded> {
  vi.useFakeTimers({toFake: ["Date"]});
  vi.setSystemTime(AT);
  try {
    const requests: Recorded["requests"] = [];
    const inner = s.fetch();
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push([String(url), String(init?.body)]);
      return inner(url, init);
    }) as typeof fetch);
    const refusals: Recorded["refusals"] = [];
    const p = factory({...s.config});
    const params = {...s.params, ...(blockNumber !== undefined ? {blockNumber} : {}), onRefusal: (text: string, info?: unknown) => { refusals.push([text, info ?? null]); }} as QuoteParams;
    const quotes = s.quotes ? await p.getQuotes!(params) : [await p.getQuote(params)].filter((q): q is Quote => q !== null);
    return {requests, refusals, quotes: JSON.parse(JSON.stringify(quotes)) as Quote[]};
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}

/** Every call of a request, one line each: the method, its target and selector (eth_call), and its block tag. */
export function callsOf(body: string): Array<{method: string; to?: string; selector?: string; tag?: unknown; overrides: boolean}> {
  return (JSON.parse(body) as Body[]).map((c) => {
    const p = c.params?.[0] as {to?: string; data?: string} | undefined;
    const tag = c.method === "eth_getBlockByNumber" ? c.params[0] : c.params?.[1];
    return {method: c.method, ...(p?.to ? {to: p.to.toLowerCase()} : {}), ...(p?.data ? {selector: p.data.slice(0, 10)} : {}), ...(tag !== undefined ? {tag} : {}), overrides: c.params?.[2] !== undefined};
  });
}

/** A request as the fixture keeps it: the URL, the sha256 of the exact body, and what it asks. */
export function digest([url, body]: [string, string]): [string, string, string] {
  const calls = callsOf(body).map((c) => `${c.method}${c.to ? ` ${c.to}:${c.selector}` : ""}${c.tag !== undefined ? ` @${String(c.tag)}` : ""}`);
  return [url, createHash("sha256").update(body).digest("hex"), calls.join(" | ")];
}

/** A recording as the fixture keeps it: digested requests (in the order sent), the refusals and the quotes. */
export function digested(r: Recorded): {requests: Array<[string, string, string]>; refusals: Recorded["refusals"]; quotes: Quote[]} {
  return {requests: r.requests.map(digest), refusals: r.refusals, quotes: r.quotes};
}
