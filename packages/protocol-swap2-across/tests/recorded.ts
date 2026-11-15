/**
 * Real Across answers (fixtures/api/quotes/*.json), recorded 2026-11-15 by scripts/record-quotes.mjs through the real
 * provider: the request each call made (the V5 body exactly as sent, the /suggested-fees query, RPC block reads),
 * Across's answer (V5 trimmed of display-only `chain` objects), the clock of the quote, and what the provider made of
 * it. No headers, no key.
 */
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {expect} from "vitest";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";

const dir = fileURLToPath(new URL("../fixtures/api/", import.meta.url));

export interface RecordedCall {
  kind: "v5" | "suggested-fees" | "rpc";
  url: string;
  method: string;
  request?: unknown;
  status: number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: any;
}

export interface RecordedQuote {
  name: string;
  note: string;
  nowMs: number;
  params: QuoteParams;
  floor: boolean;
  calls: RecordedCall[];
  result:
    | {outputAmount: string; fee: string; priceSource: "suggested-fees" | "suggested-fees (V5 other rail)" | "floor"; v5Fee: string; relayerFee: string; quoteTimestamp: number; fillDeadline: number; etaSeconds: number; placeholder: boolean}
    | {refusal: {text: string; reason: string | null}};
}

export const RECORDED: string[] = readdirSync(`${dir}quotes`).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort();
export function loadRecorded(name: string): RecordedQuote {
  return {name, ...(JSON.parse(readFileSync(`${dir}quotes/${name}.json`, "utf8")) as Omit<RecordedQuote, "name">)};
}
export const quoted = (f: RecordedQuote): f is RecordedQuote & {result: Extract<RecordedQuote["result"], {outputAmount: string}>} => "outputAmount" in f.result;
export const v5Call = (f: RecordedQuote): RecordedCall => f.calls.find((c) => c.kind === "v5")!;
export const feesCall = (f: RecordedQuote): RecordedCall | undefined => f.calls.find((c) => c.kind === "suggested-fees");

export interface ErrorFixture {
  name: string;
  status: number;
  note: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}
const errors = JSON.parse(readFileSync(`${dir}errors.json`, "utf8")) as {v5: ErrorFixture[]; suggestedFees: ErrorFixture[]};
export const v5Error = (name: string): ErrorFixture => errors.v5.find((e) => e.name === name)!;
export const feesError = (name: string): ErrorFixture => errors.suggestedFees.find((e) => e.name === name)!;
export const V5_ERRORS = errors.v5;
export const FEES_ERRORS = errors.suggestedFees;

/** The RPC URLs a floor fixture was recorded with, by label (`rpc:eip155:1` → a test URL). */
export const RPC_URLS: Record<string, string> = {
  "eip155:1": "https://rpc.recorded.test/1",
  "eip155:8453": "https://rpc.recorded.test/8453",
  "eip155:42161": "https://rpc.recorded.test/42161",
  "eip155:10": "https://rpc.recorded.test/10",
};

export interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/**
 * A fetch that answers from a recording: the V5 call (its body must be exactly the recorded one), /suggested-fees
 * (its URL must be the recorded one), RPC block reads by chain. `edit` changes an answer before it is served.
 */
export function replay(f: RecordedQuote, seen: Seen[] = [], edit: (call: RecordedCall) => {status?: number; body?: unknown; url?: string; redirected?: boolean} | void = () => {}): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? JSON.parse(String(init.body)) as unknown : undefined;
    seen.push({url, method: init?.method ?? "GET", headers, body});
    let call: RecordedCall | undefined;
    if (url.startsWith("https://api.across.to/")) {
      call = v5Call(f);
      expect(body).toEqual(call.request);
    } else if (url.startsWith("https://app.across.to/api/suggested-fees")) {
      call = feesCall(f);
      expect(url).toBe(call?.url);
    } else {
      const label = Object.entries(RPC_URLS).find(([, u]) => u === url)?.[0];
      call = f.calls.find((c) => c.kind === "rpc" && c.url === `rpc:${label}`);
      if (call) {
        const id = (body as {id: number}).id;
        const changed = edit(call) ?? {};
        return new Response(JSON.stringify({jsonrpc: "2.0", id, ...(changed.body !== undefined ? changed.body as object : call.response)}), {status: changed.status ?? 200});
      }
    }
    if (!call) throw new Error(`no recorded answer for ${url}`);
    const changed = edit(call) ?? {};
    const res = new Response(JSON.stringify(changed.body !== undefined ? changed.body : call.response), {status: changed.status ?? call.status, headers: {"content-type": "application/json"}});
    if (changed.url !== undefined || changed.redirected !== undefined) {
      Object.defineProperty(res, "url", {value: changed.url ?? url});
      Object.defineProperty(res, "redirected", {value: changed.redirected ?? false});
    }
    return res;
  }) as typeof fetch;
}

/** A key for tests — never a real one. */
export const TEST_KEY = "test-key-not-a-secret";
