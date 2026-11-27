// The scenarios behind tests/block-number.test.ts: Curve quotes on the fixture tables (Ethereum 3pool, a native input,
// Monad) and the preflight of one, every JSON-RPC request recorded as sent. fixtures/unpinned-0.1.10.json is this file
// run without `blockNumber` against the 0.1.10 source (origin/main d77449a0); the test runs it against src and wants
// the same requests, byte for byte, and the same outcomes. To record it again: in a vitest file of a 0.1.10 checkout,
// write {module, scenarios: {[name]: digested(await run(curveProvider, s))}}.
import {createHash} from "node:crypto";
import {vi} from "vitest";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {ME, RPC, STETH, TABLES, USDT, rpcStub} from "./fixtures.js";

type Factory = (config: Record<string, unknown>) => CrossChainProvider;

export interface Scenario {
  name: string;
  params: Omit<QuoteParams, "onRefusal">;
  /** Then run preflightDeposit on the quote. */
  preflight?: boolean;
}

const eth = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME};
export const SCENARIOS: Scenario[] = [
  {name: "USDC → USDT on the 3pool, with the impact probe", params: {...eth, sourceToken: "USDC", destToken: USDT, amountIn: "1000000000", slippageBps: 10}},
  {name: "native ETH → stETH", params: {...eth, sourceToken: "ETH", destToken: STETH, amountIn: "1000000000000000000"}},
  {name: "Monad USDC → AUSD", params: {sourceChain: "eip155:143", destChain: "eip155:143", destAddress: ME, refundAddress: ME, sourceToken: "USDC", destToken: "0x00000000eFE302BEAA2b3e6e1b18d08D69a9012a", amountIn: "1000000000"}},
  {name: "USDC → USDT, then its preflight (code, coins and a fresh get_dy)", params: {...eth, sourceToken: "USDC", destToken: USDT, amountIn: "1000000000"}, preflight: true},
];

/** The time every scenario runs at (validUntilMs is read from the clock). */
export const AT = Date.UTC(2026, 10, 26, 12, 0, 0);

export interface Recorded {
  requests: Array<[string, string]>;
  refusals: Array<[string, unknown]>;
  quote: Quote | null;
  preflight: string | null;
}

/** One scenario on a fresh provider (`blockNumber`: pinned), requests and outcomes recorded; `node` answers them. */
export async function run(factory: Factory, s: Scenario, blockNumber?: string, node: typeof fetch = rpcStub()): Promise<Recorded> {
  vi.useFakeTimers({toFake: ["Date"]});
  vi.setSystemTime(AT);
  try {
    const requests: Recorded["requests"] = [];
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push([String(url), String(init?.body)]);
      return node(url, init);
    }) as typeof fetch);
    const refusals: Recorded["refusals"] = [];
    const p = factory({rpcUrls: RPC, ...TABLES, onWarning: () => {}});
    const q = await p.getQuote({...s.params, ...(blockNumber !== undefined ? {blockNumber} : {}), onRefusal: (t: string, i?: unknown) => { refusals.push([t, i ?? null]); }} as QuoteParams);
    let preflight: string | null = null;
    if (s.preflight && q) {
      try { await p.preflightDeposit!(q, await p.buildDeposit(q)); preflight = "ok"; } catch (e) { preflight = (e as Error).message; }
    }
    // The intent id carries a random tag per quote: kept as its shape.
    const quote = q ? (JSON.parse(JSON.stringify({...q, intentId: q.intentId.replace(/[0-9a-f]{16}$/, "<tag>")})) as Quote) : null;
    return {requests, refusals, quote, preflight};
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}

/** Every call of a request: its method, target and selector (eth_call), and the block it names. */
export function callsOf(body: string): Array<{method: string; to?: string; selector?: string; tag?: unknown}> {
  return (JSON.parse(body) as {method: string; params: unknown[]}[]).map((c) => {
    const p = c.params?.[0] as {to?: string; data?: string} | undefined;
    return {method: c.method, ...(p?.to ? {to: p.to.toLowerCase()} : {}), ...(p?.data ? {selector: p.data.slice(0, 10)} : {}), ...(c.params?.[1] !== undefined ? {tag: c.params[1]} : {})};
  });
}

export function digested(r: Recorded) {
  return {
    requests: r.requests.map(([url, body]) => [url, createHash("sha256").update(body).digest("hex"), callsOf(body).map((c) => `${c.method}${c.to ? ` ${c.to}:${c.selector}` : ""} @${String(c.tag)}`).join(" | ")]),
    refusals: r.refusals,
    quote: r.quote,
    preflight: r.preflight,
  };
}
