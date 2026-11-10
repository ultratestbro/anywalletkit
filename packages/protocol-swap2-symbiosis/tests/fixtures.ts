/**
 * Recorded answers of Symbiosis' public API (tests/fixtures/*.json, written by
 * scripts/record-fixtures.mjs through the provider's own `fetchImpl`) and the tools the tests use to
 * replay them and to rewrite one field of a real route at any nesting level.
 */
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import {decodeFunctionData, encodeFunctionData, parseAbi, type Hex} from "viem";
import type {Quote, QuoteParams} from "@anywalletkit/protocol-swap2-core/types";
import {symbiosisProvider, type SymbiosisProviderConfig} from "../src/provider.js";

const dir = fileURLToPath(new URL("./fixtures/", import.meta.url));
const read = (name: string): unknown => JSON.parse(readFileSync(`${dir}${name}.json`, "utf8"));

export interface Exchange {method: string; path: string; body?: Record<string, unknown>; status: number; response: unknown}
export interface Recorded {
  recordedAt: string;
  params: QuoteParams;
  config: SymbiosisProviderConfig;
  exchanges: Exchange[];
  result: {destAmount?: string; minDestAmount?: string; providerData?: Record<string, string>; refusal?: string};
}

export const LIMITS = read("limits") as {chainId: number; address: string; min: string; max: string}[];
export const load = (name: string): Recorded => read(name) as Recorded;

export interface Call {url: string; method: string; headers: Record<string, string>; body: Record<string, unknown> | undefined}

/** A `fetch` that answers with the recorded exchanges in order; `patch` rewrites an answer before it is served. */
export function replay(exchanges: readonly Exchange[], patch?: (response: any, exchange: Exchange, index: number) => unknown): {fetchImpl: typeof fetch; calls: Call[]} {
  const calls: Call[] = [];
  let i = 0;
  const fetchImpl = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const e = exchanges[i];
    if (!e) throw new Error(`unexpected request #${i + 1}: ${String(url)}`);
    calls.push({url: String(url), method: init?.method ?? "GET", headers: (init?.headers ?? {}) as Record<string, string>, body: init?.body === undefined ? undefined : JSON.parse(String(init.body))});
    let response = e.response === "@limits" ? LIMITS : structuredClone(e.response);
    if (patch) response = patch(response, e, i) ?? response;
    i++;
    return new Response(JSON.stringify(response), {status: e.status, headers: {"content-type": "application/json"}});
  }) as typeof fetch;
  return {fetchImpl, calls};
}

export interface Outcome {quote: Quote | null; refusal: string | null; calls: Call[]; recorded: Recorded}

/** The recorded scenario through the real provider. */
export async function quoteOf(name: string, o: {params?: Partial<QuoteParams>; config?: SymbiosisProviderConfig; patch?: (response: any, exchange: Exchange, index: number) => unknown; exchanges?: (all: Exchange[]) => Exchange[]} = {}): Promise<Outcome> {
  const recorded = load(name);
  const {fetchImpl, calls} = replay(o.exchanges ? o.exchanges(recorded.exchanges) : recorded.exchanges, o.patch);
  let refusal: string | null = null;
  const quote = await symbiosisProvider({...recorded.config, ...o.config, fetchImpl}).getQuote({...recorded.params, ...o.params, onRefusal: (why) => { refusal = why; }});
  return {quote, refusal, calls, recorded};
}

/** The last exchange of a scenario is the quote the provider accepted (earlier ones named a venue it does not read). */
export const lastOnly = (all: Exchange[]): Exchange[] => [all[0]!, all[all.length - 1]!];

// ── The contracts' ABIs, written out again here on purpose: the tests must not share a decoder with the code they test ──
export const ABI = parseAbi([
  "struct MetaRouteTransaction { bytes firstSwapCalldata; bytes secondSwapCalldata; address[] approvedTokens; address firstDexRouter; address secondDexRouter; uint256 amount; bool nativeIn; address relayRecipient; bytes otherSideCalldata; }",
  "function metaRoute(MetaRouteTransaction t) payable",
  "struct MetaSynthesizeTransaction { uint256 stableBridgingFee; uint256 amount; address rtoken; address chain2address; address receiveSide; address oppositeBridge; address syntCaller; uint256 chainID; address[] swapTokens; address secondDexRouter; bytes secondSwapCalldata; address finalReceiveSide; bytes finalCalldata; uint256 finalOffset; address revertableAddress; bytes32 clientID; }",
  "function metaSynthesize(MetaSynthesizeTransaction t)",
  "struct MetaBurnTransaction { uint256 stableBridgingFee; uint256 amount; bytes32 crossChainID; address syntCaller; address finalReceiveSide; address sToken; bytes finalCallData; uint256 finalOffset; address chain2address; address receiveSide; address oppositeBridge; address revertableAddress; uint256 chainID; bytes32 clientID; }",
  "struct TonAddress { int8 workchain; bytes32 address_hash; }",
  "function metaBurnSyntheticToken(MetaBurnTransaction t)",
  "function burnSyntheticToken(address stoken,uint256 amount,address chain2address,address receiveSide,address oppositeBridge,address revertableAddress,uint256 chainID,bytes32 clientID)",
  "function burnSyntheticTokenTON(uint256 stableBridgingFee,address stoken,uint256 amount,bytes32 crossChainID,TonAddress chain2address,address receiveSide,address oppositeBridge,address revertableAddress,uint256 chainID,bytes32 clientID)",
  "function multicall(uint256 amountIn,bytes[] calldatas,address[] receiveSides,address[] path,uint256[] offsets,address to)",
  "function swap(uint256 tokenIndexFrom,uint256 tokenIndexTo,uint256 dx,uint256 minDy,address to,uint256 deadline)",
  "function swapExactTokensForTokens(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapExactTokensForETH(uint256 amountIn,uint256 amountOutMin,address[] path,address to,uint256 deadline)",
  "function swapExactETHForTokens(uint256 amountOutMin,address[] path,address to,uint256 deadline) payable",
  "function unwrap(uint256 amountIn,address to)",
  "function transfer(address to,uint256 amount)",
]);
export const ONE_INCH_ABI = parseAbi([
  "struct SwapDescription { address srcToken; address dstToken; address srcReceiver; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; }",
  "function swap(address executor, SwapDescription desc, bytes data) payable",
]);
export const KYBER_ABI = parseAbi([
  "struct SwapDescriptionV2 { address srcToken; address dstToken; address[] srcReceivers; uint256[] srcAmounts; address[] feeReceivers; uint256[] feeAmounts; address dstReceiver; uint256 amount; uint256 minReturnAmount; uint256 flags; bytes permit; }",
  "struct SwapExecutionParams { address callTarget; address approveTarget; bytes targetData; SwapDescriptionV2 desc; bytes clientData; }",
  "function swap(SwapExecutionParams execution) payable",
]);

/** Decoded arguments as plain mutable values. */
export function dec(data: string, abi: typeof ABI | typeof ONE_INCH_ABI | typeof KYBER_ABI = ABI): {name: string; args: any[]} {
  const d = decodeFunctionData({abi: abi as typeof ABI, data: data as Hex});
  return {name: d.functionName, args: structuredCloneBig(d.args) as any[]};
}
export function enc(name: string, args: unknown[], abi: typeof ABI | typeof ONE_INCH_ABI | typeof KYBER_ABI = ABI): Hex {
  return encodeFunctionData({abi: abi as typeof ABI, functionName: name as never, args: args as never});
}
function structuredCloneBig(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(structuredCloneBig);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, structuredCloneBig(x)]));
  return v;
}

/** Every level of an EVM / Tron route, open for editing. */
export interface Parts {
  /** `metaRoute` argument. */
  t: any;
  /** `metaSynthesize` argument. */
  s: any;
  /** `multicall` arguments: amountIn, calldatas, receiveSides, path, offsets, to. */
  mc: any[];
  /** Each pool `swap`'s arguments: from, to, dx, minDy, to, deadline. */
  pools: any[][];
  /** `metaBurnSyntheticToken` argument (EVM / Tron destination), else null. */
  burn: any | null;
  /** `burnSyntheticTokenTON` arguments (TON destination), else null. */
  burnTon: any[] | null;
}

export function open(data: string): Parts {
  const t = dec(data).args[0];
  const s = dec(t.otherSideCalldata).args[0];
  const mc = dec(s.secondSwapCalldata).args;
  const pools = (mc[1] as string[]).map((c) => dec(c).args);
  const f = dec(s.finalCalldata);
  return {t, s, mc, pools, burn: f.name === "metaBurnSyntheticToken" ? f.args[0] : null, burnTon: f.name === "burnSyntheticTokenTON" ? f.args : null};
}
export function close(p: Parts): Hex {
  const mc = [...p.mc];
  mc[1] = p.pools.map((a) => enc("swap", a));
  const s = {...p.s, secondSwapCalldata: enc("multicall", mc)};
  if (p.burn) s.finalCalldata = enc("metaBurnSyntheticToken", [p.burn]);
  else if (p.burnTon) s.finalCalldata = enc("burnSyntheticTokenTON", p.burnTon);
  return enc("metaRoute", [{...p.t, otherSideCalldata: enc("metaSynthesize", [s])}]);
}

/** The quote with one thing in its calldata rewritten (everything re-encoded canonically around it). */
export function rewrite(quote: Quote, edit: (p: Parts) => void): Quote {
  const p = open(quote.txRequest!.data!);
  edit(p);
  return {...quote, txRequest: {...quote.txRequest!, data: close(p)}};
}

export const EVIL = "0x000000000000000000000000000000000000dEaD";
export const EVM = "0x28C6c06298d514Db089934071355E5743bf21d60";
export const TON = "UQCD39VS5jcptHL8vMjEXrzGaRcCVYto7HUn4bpAOg8xqEBI";
export const TRON = "TNPdqto8HiuMzoG7Vv9wyyYhWzCojLeHAF";
