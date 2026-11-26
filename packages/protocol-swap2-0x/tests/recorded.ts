/**
 * Real 0x answers (fixtures/quotes/*.json), recorded from api.0x.org on 2026-11-15 with a throwaway taker that holds
 * nothing: the response body exactly as 0x sent it, the request rebuilt from the recorded query, the clock of the
 * quote, what the Settler registry answered on that chain, and the pin era it was recorded in. No key, no headers.
 *
 * Pin eras (fixtures/pin-eras.json): the chain table's Settler pins as src/chains.ts held them over time. A recording is
 * replayed with the table of its own era ({@link chainsOf}, {@link chainsConfigOf}) — the registry it recorded is that
 * era's current and previous Settler, exactly — so raising the pins after 0x deploys does not turn a recorded answer
 * into a test of a world it was not recorded in. The newest era is the table in force.
 */
import {readdirSync, readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {vi} from "vitest";
import type {QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {ZEROEX_CHAINS, ZEROEX_NATIVE, ZEROEX_SETTLER_REGISTRY, zeroExChains, type ZeroExChain} from "../src/chains.js";
import {REGISTRY_OWNER_OF_SELECTOR, REGISTRY_PREV_SELECTOR} from "../src/settler.js";

const dir = fileURLToPath(new URL("../fixtures/quotes/", import.meta.url));

interface PinErasJson {
  eras: Record<string, {pinned: string; pins: Record<string, [newestLiveNonce: number, previousLiveNonce: number]>}>;
  unrecorded: string[];
}
const pinEras = JSON.parse(readFileSync(fileURLToPath(new URL("../fixtures/pin-eras.json", import.meta.url)), "utf8")) as PinErasJson;
/** Every pin era, oldest first (as fixtures/pin-eras.json lists them). */
export const PIN_ERAS: readonly string[] = Object.keys(pinEras.eras);
/** The newest era: the one src/chains.ts must be. */
export const CURRENT_PIN_ERA: string = PIN_ERAS.at(-1)!;
/** Eras with no recording yet (owed: re-recording needs ZEROEX_API_KEY). */
export const UNRECORDED_PIN_ERAS: readonly string[] = pinEras.unrecorded;
/** An era's pins, chain id → [newestLiveNonce, previousLiveNonce]. */
export function eraPins(era: string): Readonly<Record<number, readonly [number, number]>> {
  const e = Object.prototype.hasOwnProperty.call(pinEras.eras, era) ? pinEras.eras[era] : undefined;
  if (!e) throw new Error(`recorded: no pin era ${era} in fixtures/pin-eras.json`);
  return Object.fromEntries(Object.entries(e.pins).map(([id, pins]) => [Number(id), pins]));
}
/**
 * The chain table of an era as `chains` config (overrides): each of its chains is the entry in force with that era's
 * pins, every other chain of the defaults removed. Registry, Permit2 and wrapped natives have not moved across eras.
 */
export function eraChainsConfig(era: string): Readonly<Record<number, ZeroExChain | null>> {
  const pins = eraPins(era);
  const out: Record<number, ZeroExChain | null> = {};
  for (const id of Object.keys(ZEROEX_CHAINS).map(Number)) if (!(id in pins)) out[id] = null;
  for (const [key, [newestLiveNonce, previousLiveNonce]] of Object.entries(pins)) {
    const id = Number(key);
    const entry = ZEROEX_CHAINS[id];
    if (!entry) throw new Error(`recorded: pin era ${era} names chain ${id}, which is not in the chain table`);
    out[id] = {...entry, newestLiveNonce, previousLiveNonce};
  }
  return out;
}
/** The whole chain table of an era (validated by `zeroExChains`, as an integrator's table is). */
export const eraChains = (era: string): Readonly<Record<number, ZeroExChain>> => zeroExChains(eraChainsConfig(era));

export interface RecordedQuote {
  name: string;
  note: string;
  request: {
    endpoint: "/swap/permit2/quote" | "/swap/permit2/price";
    sourceChain: string;
    sourceToken: string;
    sourceDecimals?: number;
    destToken: string;
    amountIn: string;
    slippageBps: number;
    destAddress: string;
    refundAddress: string;
    dry: boolean;
    excludedSources?: string[];
    nowMs: number;
  };
  registry: {current: string; prev: string | null};
  /** The pin era the recording was made in (fixtures/pin-eras.json): it is replayed with that era's chain table. */
  pinEra: string;
  /** The refusal this answer must give (the whole text), when it is one. */
  refusal?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  response: Record<string, any>;
}

export function loadRecorded(name: string): RecordedQuote {
  return {name, ...(JSON.parse(readFileSync(`${dir}${name}.json`, "utf8")) as Omit<RecordedQuote, "name">)};
}
export const RECORDED = readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => f.slice(0, -5));

export const chainIdOf = (f: RecordedQuote): number => Number(f.request.sourceChain.slice("eip155:".length));
/** The chain table the recording is replayed with: its pin era's. */
export const chainsOf = (f: RecordedQuote): Readonly<Record<number, ZeroExChain>> => eraChains(f.pinEra);
/** The same table as `chains` config for a provider, protocol or remote provider. */
export const chainsConfigOf = (f: RecordedQuote): Readonly<Record<number, ZeroExChain | null>> => eraChainsConfig(f.pinEra);
/** The recording's chain entry in its era (`chain` for checkZeroExTransaction). */
export const chainOf = (f: RecordedQuote): ZeroExChain => chainsOf(f)[chainIdOf(f)]!;
export const nativeSale = (f: RecordedQuote): boolean => /^0x0{40}$/.test(f.request.sourceToken);
export const rpcOf = (f: RecordedQuote) => ({[chainIdOf(f)]: ["https://rpc.recorded.test"]});

/** The swap2 request the recording answered. */
export function paramsOf(f: RecordedQuote, over: Partial<QuoteParams> = {}): QuoteParams {
  const r = f.request;
  return {
    sourceChain: r.sourceChain, destChain: r.sourceChain, sourceToken: r.sourceToken, ...(r.sourceDecimals !== undefined ? {sourceDecimals: r.sourceDecimals} : {}),
    destToken: r.destToken, amountIn: r.amountIn, slippageBps: r.slippageBps, destAddress: r.destAddress, refundAddress: r.refundAddress, dry: r.dry, ...over,
  };
}

/** The query 0x was sent for this recording, as the provider builds it. */
export function recordedQuery(f: RecordedQuote): Record<string, string> {
  const r = f.request;
  const token = (t: string) => (/^0x0{40}$/.test(t) ? ZEROEX_NATIVE : t);
  return {
    chainId: String(chainIdOf(f)), sellToken: token(r.sourceToken), buyToken: token(r.destToken), sellAmount: r.amountIn, slippageBps: String(r.slippageBps), taker: r.refundAddress,
    ...(r.destAddress.toLowerCase() !== r.refundAddress.toLowerCase() ? {recipient: r.destAddress} : {}),
    ...(r.excludedSources ? {excludedSources: r.excludedSources.join(",")} : {}),
  };
}

export interface Seen {url: string; method: string}
/**
 * One `fetch` for both sides of a recording: the 0x API (GET) answers the recorded body, the chain's JSON-RPC (POST)
 * answers the recorded registry (and code at the recorded Settlers). `body` replaces the response (a tampered copy); `status`/`headers` an HTTP refusal.
 */
export function recordedFetch(f: RecordedQuote, o: {seen?: Seen[]; body?: unknown; status?: number; headers?: Record<string, string>; registry?: {current?: string | null; prev?: string | null}; code?: (address: string) => boolean} = {}): typeof fetch {
  const word = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
  const rpc = (result: unknown) => new Response(JSON.stringify({jsonrpc: "2.0", id: 1, result}));
  const revert = () => new Response(JSON.stringify({jsonrpc: "2.0", id: 1, error: {code: 3, message: "execution reverted"}}));
  return vi.fn(async (input: string | URL, init?: {method?: string; body?: string}) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    o.seen?.push({url, method});
    if (method === "POST") {
      const call = JSON.parse(init!.body!) as {method: string; params: [{to?: string; data?: string}]};
      if (call.method === "eth_getTransactionReceipt") return rpc({status: "0x1"});
      // The recorded Settlers (current and previous) held code when recorded; `code` overrides.
      if (call.method === "eth_getCode") {
        const address = String((call.params as unknown as [string])[0]).toLowerCase();
        const recorded = [f.registry.current, f.registry.prev].some((a) => !!a && a.toLowerCase() === address);
        return rpc((o.code ? o.code(address) : recorded) ? "0x6080604052" : "0x");
      }
      if (call.method !== "eth_call" || call.params[0].to?.toLowerCase() !== ZEROEX_SETTLER_REGISTRY.toLowerCase()) return rpc("0x");
      const registry = {...f.registry, ...o.registry};
      if (call.params[0].data?.startsWith(REGISTRY_OWNER_OF_SELECTOR)) return registry.current ? rpc(word(registry.current)) : revert();
      if (call.params[0].data?.startsWith(REGISTRY_PREV_SELECTOR)) return registry.prev ? rpc(word(registry.prev)) : revert();
      return rpc("0x");
    }
    const body = o.body === undefined ? f.response : o.body;
    return new Response(typeof body === "string" ? body : JSON.stringify(body), {status: o.status ?? 200, headers: o.headers ?? {}});
  }) as unknown as typeof fetch;
}

/** A deep copy of the recorded body, to tamper with. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const bodyOf = (f: RecordedQuote): Record<string, any> => JSON.parse(JSON.stringify(f.response));
