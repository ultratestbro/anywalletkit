// Offline replay of the U2 token-input recordings (fixtures/rpc/*-token.json): every JSON-RPC answer the 0.5.0
// provider with v4 "all" needed, recorded read-only at one pinned block from a funded holder. Keys are the method and
// its canonical params — block tags dropped (every read was made at the pinned block), hex lower-cased, and the
// SwapProxy deadline word zeroed (it is the clock's, not the chain's: the replayed quote is built now). A request the
// recording does not hold is answered with an error and kept in `misses`, never guessed.
import {readFileSync} from "node:fs";
import {getAddress} from "viem";

export interface TokenFixture {
  about: string;
  chainId: number;
  block: {number: string; hex: string; hash: string; timestamp: string; gasLimit: string};
  holder: `0x${string}`;
  quotes: string[];
  calls: Record<string, {result?: unknown; error?: unknown}>;
}
export const loadTokenFixture = (name: string): TokenFixture => JSON.parse(readFileSync(new URL(`../fixtures/rpc/${name}`, import.meta.url), "utf8")) as TokenFixture;

export const MONAD_TOKEN = loadTokenFixture("monad-125499326-token.json");
export const BASE_TOKEN = loadTokenFixture("base-62413790-token.json");
/** The funded holder both recordings simulate from (sender and recipient). */
export const HOLDER = getAddress(MONAD_TOKEN.holder);

/** Block-tag position per method (dropped from the key). */
const TAGGED: Readonly<Record<string, number>> = {eth_call: 1, eth_getCode: 1, eth_createAccessList: 1, eth_simulateV1: 1, eth_estimateGas: 1, eth_getBalance: 1};
/** `SwapProxy.execute` selector, then router, token, amount, the two offsets — and the deadline word, zeroed. */
const PROXY_DEADLINE = /2894adf9((?:[0-9a-f]{64}){5})[0-9a-f]{64}/g;

/** The recording key of one request. */
export function canon(method: string, params: readonly unknown[]): string {
  const p = [...params];
  const at = TAGGED[method];
  if (at !== undefined && typeof p[at] === "string") p.splice(at, 1);
  if (method === "eth_getBlockByNumber") p.splice(0, 1);
  return `${method} ${JSON.stringify(p).toLowerCase().replace(PROXY_DEADLINE, (_m, g: string) => `2894adf9${g}${"0".repeat(64)}`)}`;
}

export interface SeenRequest {
  method: string;
  params: unknown[];
  key: string;
}
/** An answer that replaces the recording's for one request (return undefined to keep the recording's). */
export type Odd = (req: SeenRequest) => {result?: unknown; error?: unknown} | undefined;

/** A fetch serving `fixtures` (merged), with `odd` answering first; every request and every miss is kept. */
export function tokenReplay(fixtures: readonly TokenFixture[], odd?: Odd) {
  const calls: Record<string, {result?: unknown; error?: unknown}> = Object.assign({}, ...fixtures.map((f) => f.calls));
  const misses: string[] = [];
  const seen: SeenRequest[] = [];
  const fetch: typeof globalThis.fetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
    const batch = JSON.parse(String(init?.body)) as {id: number; method: string; params: unknown[]}[];
    return new Response(JSON.stringify(batch.map((req) => {
      const key = canon(req.method, req.params);
      const r: SeenRequest = {method: req.method, params: req.params, key};
      seen.push(r);
      const instead = odd?.(r);
      if (instead) return {jsonrpc: "2.0", id: req.id, ...instead};
      const answer = calls[key];
      if (!answer) {
        misses.push(key.slice(0, 160));
        return {jsonrpc: "2.0", id: req.id, error: {code: -32603, message: "not in the recording"}};
      }
      return {jsonrpc: "2.0", id: req.id, ...answer};
    })));
  }) as typeof globalThis.fetch;
  return {fetch, misses, seen};
}
