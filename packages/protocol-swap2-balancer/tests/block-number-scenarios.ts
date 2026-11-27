// The scenarios behind tests/block-number.test.ts: Balancer quotes over the SOR + Vault stub (a token input, a native
// input, a two-path split) and the preflight of one, every request (JSON-RPC and SOR) recorded as sent.
// fixtures/unpinned-0.3.13.json is this file run without `blockNumber` against the 0.3.13 source (origin/main
// d77449a0); the test runs it against src and wants the same requests, byte for byte, and the same outcomes. To record
// it again: in a vitest file of a 0.3.13 checkout, write {module, scenarios: {[name]: digested(await run(balancerProvider, s))}}.
import {createHash} from "node:crypto";
import {vi} from "vitest";
import type {CrossChainProvider, Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {ME, POOL_A, POOL_B, RPC, USDC, WETH, stub, type Stub} from "./fixtures.js";

type Factory = (config: Record<string, unknown>) => CrossChainProvider;

export interface Scenario {
  name: string;
  params: Omit<QuoteParams, "onRefusal">;
  stub: Stub;
  preflight?: boolean;
}

const eth = {sourceChain: "eip155:1", destChain: "eip155:1", destAddress: ME, refundAddress: ME};
export const SCENARIOS: Scenario[] = [
  {name: "WETH → USDC on one pool", params: {...eth, sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000"}, stub: {vaultOut: 2_000_000n}},
  {name: "native ETH → USDC (the Vault's ETH sentinel)", params: {...eth, sourceToken: "ETH", destToken: USDC, amountIn: "1000000000000000000"}, stub: {vaultOut: 2_000_000n}},
  {name: "WETH → USDC split over two paths", params: {...eth, sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000"}, stub: {paths: [{pools: [POOL_A], tokens: [WETH, USDC], amountIn: "600000000000000000"}, {pools: [POOL_B], tokens: [WETH, USDC], amountIn: "400000000000000000"}], vaultOut: 2_000_000n}},
  {name: "WETH → USDC, then its preflight (the Vault re-prices the signed batch)", params: {...eth, sourceToken: "WETH", destToken: USDC, amountIn: "1000000000000000000"}, stub: {vaultOut: 2_000_000n}, preflight: true},
];

/** The time every scenario runs at (the batch deadline and validUntilMs are read from the clock). */
export const AT = Date.UTC(2026, 10, 26, 12, 0, 0);

export interface Recorded {
  requests: Array<[string, string]>;
  refusals: Array<[string, unknown]>;
  quote: Quote | null;
  preflight: string | null;
}

/** One scenario on a fresh provider (`blockNumber`: pinned), requests and outcomes recorded; `node` answers them. */
export async function run(factory: Factory, s: Scenario, blockNumber?: string, node: typeof fetch = stub(s.stub)): Promise<Recorded> {
  vi.useFakeTimers({toFake: ["Date"]});
  vi.setSystemTime(AT);
  try {
    const requests: Recorded["requests"] = [];
    vi.stubGlobal("fetch", (async (url: RequestInfo | URL, init?: RequestInit) => {
      requests.push([String(url), String(init?.body)]);
      return node(url, init);
    }) as typeof fetch);
    const refusals: Recorded["refusals"] = [];
    const p = factory({rpcUrls: RPC});
    const q = await p.getQuote({...s.params, ...(blockNumber !== undefined ? {blockNumber} : {}), onRefusal: (t: string, i?: unknown) => { refusals.push([t, i ?? null]); }} as QuoteParams);
    let preflight: string | null = null;
    if (s.preflight && q) {
      try { await p.preflightDeposit!(q, await p.buildDeposit(q)); preflight = "ok"; } catch (e) { preflight = (e as Error).message; }
    }
    return {requests, refusals, quote: q ? (JSON.parse(JSON.stringify(q)) as Quote) : null, preflight};
  } finally {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}

/** A JSON-RPC request's method, target, selector and block (the SOR's GraphQL request as "sor"). */
export function callOf(url: string, body: string): {method: string; selector?: string; tag?: unknown} {
  if (url.includes("balancer")) return {method: "sor"};
  const c = JSON.parse(body) as {method: string; params: unknown[]};
  const p = c.params?.[0] as {data?: string} | undefined;
  return {method: c.method, ...(p?.data ? {selector: p.data.slice(0, 10)} : {}), ...(c.params?.[1] !== undefined ? {tag: c.params[1]} : {})};
}

export function digested(r: Recorded) {
  return {
    requests: r.requests.map(([url, body]) => {
      const c = callOf(url, body);
      return [url, createHash("sha256").update(body).digest("hex"), `${c.method}${c.selector ? ` ${c.selector}` : ""}${c.tag !== undefined ? ` @${String(c.tag)}` : ""}`];
    }),
    refusals: r.refusals,
    quote: r.quote,
    preflight: r.preflight,
  };
}
