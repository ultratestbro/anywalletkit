import {decodeErrorResult, decodeFunctionData, encodeFunctionData, getAddress, parseAbi, type Hex} from "viem";
import {evmRef, isEvm, timeoutSignal, sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import {httpRefusal, refusal, refusalOf, withReason, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {ccAssetByToken} from "@anywalletkit/swap2-assets";
import {WRAPPED_NATIVE} from "@anywalletkit/protocol-swap2-wrap/provider";
import {describeKyberActivity} from "./activity.js";
import {KYBER_NATIVE, KYBER_ROUTER_ABI, KYBER_ROUTER_V2, KYBER_ROUTER_V3, checkKyberTransaction, kyberApiSlippage, kyberChain, kyberMinimum, kyberNativeSwaps} from "./router.js";

/**
 * KyberSwap Aggregator (docs.kyberswap.com) as a same-chain swap2 provider: exact-input swaps on the chains in
 * `KYBER_CHAINS`, routed by KyberSwap and settled through MetaAggregationRouterV2.
 *
 * A dry quote is `GET /routes` only. An execution quote (the engine's, with `dry: false`) also calls
 * `POST /route/build` and returns the encoded transaction, checked field by field against the request
 * (`checkKyberTransaction`): the build endpoint encodes whatever route summary it is sent, fee entries included, so
 * nothing in its answer is taken on trust. Before the transaction is signed it is simulated from the account at the
 * latest block; with no RPC answering, the swap is refused.
 *
 * Keyless by default (the public API, 3 requests per second per IP). With `apiKey`, requests go to KyberSwap's API
 * gateway instead. No integrator fee is ever charged; KyberSwap keeps any output above the quote (positive slippage).
 */

const ZERO = "0x0000000000000000000000000000000000000000";
const PUBLIC_BASE_URL = "https://aggregator-api.kyberswap.com";
const GATEWAY_BASE_URL = "https://api.kyberswap.com/swap";
const DEFAULT_SLIPPAGE_BPS = 50;
/** How long a quote stays executable for the engine: the user's review fits, an approval mined meanwhile gets one re-quote. */
const DEFAULT_TTL_MS = 30_000;
/** A dry route is reused this long for the same request (KyberSwap asks not to cache routes for more than 5–10 s). */
const DRY_CACHE_MS = 5_000;
/** The executor's own deadline for a built swap (the build endpoint's default). */
const BUILD_DEADLINE_S = 20 * 60;

/**
 * KyberSwap's error codes (docs.kyberswap.com, aggregator API errors) → refusal reasons. 4222: the route quoted
 * under KyberSwap's own estimate; 4227: its gas estimation failed.
 */
const ERROR_REASONS: Readonly<Record<number, Swap2RefusalReason>> = {
  4000: "policy_refused", 4001: "policy_refused", 4002: "policy_refused", 4005: "policy_refused", 4007: "policy_refused", 40017: "policy_refused",
  4008: "no_route", 40011: "no_route",
  4009: "insufficient_liquidity", 4010: "insufficient_liquidity",
  4011: "unsupported_pair", 4221: "unsupported_pair",
  4222: "price_check_failed",
  4227: "simulation_failed",
};
const errorReason = (code: unknown): Swap2RefusalReason | undefined =>
  typeof code === "number" && Object.prototype.hasOwnProperty.call(ERROR_REASONS, code) ? ERROR_REASONS[code] : undefined;

export interface KyberswapProviderConfig {
  enabled?: boolean;
  /** `x-client-id` and the build's `source` (written on-chain in the swap's `clientData`). Default "anywalletkit". */
  clientId?: string;
  /** KyberSwap API-gateway key (`X-Api-Key`); keep it on a server. Without it the keyless public API is used. */
  apiKey?: string;
  /** Override the API base (`{baseUrl}/{chain}/api/v1/...`). */
  baseUrl?: string;
  /** JSON-RPC endpoints per chain id: required for execution (pre-broadcast simulation) and receipts. */
  rpcUrls?: Readonly<Record<number, readonly string[]>>;
  /** Chains to quote on (default: every chain in `KYBER_CHAINS`). */
  enabledChains?: readonly number[];
  defaultSlippageBps?: number;
  quoteTtlMs?: number;
  timeoutMs?: number;
  /** Leave RFQ / private-market-maker sources out of routes (short-lived quotes; default true). */
  excludeRfqSources?: boolean;
  /** KyberSwap source ids to leave out of routes. */
  excludedSources?: readonly string[];
}

interface RouteSummary {
  tokenIn?: string;
  amountIn?: string;
  tokenOut?: string;
  amountOut?: string;
  amountInUsd?: string;
  amountOutUsd?: string;
  gas?: string;
  extraFee?: {feeAmount?: string; feeReceiver?: string; chargeFeeBy?: string; isInBps?: boolean};
  route?: {pool?: string; exchange?: string}[][];
  routeID?: string;
  [k: string]: unknown;
}

const uint = (v: unknown): bigint | null => (typeof v === "string" && /^\d{1,78}$/.test(v) ? BigInt(v) : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null);
const isAddr = (a: unknown): a is string => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a);
const same = (a: unknown, b: string): boolean => isAddr(a) && a.toLowerCase() === b.toLowerCase();
const sameText = (a: string, b: string): boolean => a.length === b.length && a.toLowerCase() === b.toLowerCase();
const sameAmount = (a: string, b: string): boolean => /^\d{1,80}$/.test(a) && /^\d{1,80}$/.test(b) && BigInt(a) === BigInt(b);
const apiToken = (t: string): string => (t === ZERO ? KYBER_NATIVE : t);
/** An API text as it may appear in a refusal: one line, at most 120 characters. */
const short = (s: unknown): string => String(s ?? "").replace(/\s+/g, " ").slice(0, 120);

/**
 * A quote's `gasEstimate`: KyberSwap's `routeSummary.gas` from `GET /routes` (asked with `gasInclude=true`) as canonical
 * digits, the same figure on a dry quote and on the execution quote built from that route. Undefined when the route
 * states none, zero, or a figure past the contract's ten digits: no figure is made up. See the README for how it
 * compares with the gas the built call used.
 */
export function kyberGasEstimate(routeGas: unknown): string | undefined {
  const gas = uint(routeGas);
  return gas !== null && gas > 0n && gas < 10_000_000_000n ? gas.toString() : undefined;
}

const ERC20_READS = parseAbi(["function balanceOf(address) view returns (uint256)", "function allowance(address, address) view returns (uint256)", "function approve(address, uint256) returns (bool)"]);

/** The revert data an RPC error carries, at most 4 KB of it. */
function revertData(e: unknown): Hex | null {
  const err = e as {data?: unknown; message?: unknown};
  const nested = err.data && typeof err.data === "object" ? (err.data as {data?: unknown}).data : undefined;
  for (const v of [err.data, nested]) if (typeof v === "string" && /^0x(?:[0-9a-fA-F]{2}){4,4096}$/.test(v)) return v as Hex;
  return null;
}
/**
 * KyberSwap's own USD value of the output against the input, as basis points lost (pool impact and pool fees together).
 * Information for the user's "be careful" warning, never a refusal. null when KyberSwap does not price either side
 * ("0" means unpriced, not worthless) or the numbers are not plain decimals.
 */
export function kyberValueLossBps(amountInUsd: unknown, amountOutUsd: unknown): number | null {
  const num = (v: unknown) => (typeof v === "string" && /^\d{1,15}(\.\d{1,30})?$/.test(v) ? Number(v) : null);
  const vin = num(amountInUsd), vout = num(amountOutUsd);
  if (vin === null || vout === null || vin <= 0 || vout <= 0) return null;
  return Math.min(10_000, Math.max(0, Math.round(((vin - vout) / vin) * 10_000)));
}

/** `Error(string)` from revert data, if that is what it is. */
function revertString(e: unknown): string | null {
  const data = revertData(e);
  if (data) {
    try {
      // viem knows Error(string) and Panic(uint256) without an ABI.
      const r = decodeErrorResult({abi: [], data});
      if (r.errorName === "Error" && typeof r.args?.[0] === "string") return r.args[0].slice(0, 200);
    } catch {
      // not a plain revert string
    }
  }
  const m = e instanceof Error ? /execution reverted:?\s*([^\n]{1,160})/.exec(e.message) : null;
  return m ? m[1]! : null;
}

export function kyberswapProvider(config: KyberswapProviderConfig = {}): CrossChainProvider {
  const baseUrl = (config.baseUrl ?? (config.apiKey ? GATEWAY_BASE_URL : PUBLIC_BASE_URL)).replace(/\/+$/, "");
  const clientId = config.clientId ?? "anywalletkit";
  const slippageDefault = config.defaultSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const ttl = config.quoteTtlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const enabledChains = config.enabledChains ? new Set(config.enabledChains) : null;
  // KyberSwap asked (2026-11-25): with a key, send X-Api-Key only, without x-client-id.
  // The build's `source` still carries the client id on-chain.
  const headers: Record<string, string> = config.apiKey ? {"x-api-key": config.apiKey} : {"x-client-id": clientId};
  const dryCache = new Map<string, {at: number; value: Promise<RoutesResult>}>();

  const chainIdOf = (caip2: string): number | null => {
    if (!isEvm(caip2)) return null;
    const id = evmRef(caip2);
    return kyberChain(id) && (!enabledChains || enabledChains.has(id)) ? id : null;
  };

  async function rpc(chainId: number, method: string, params: unknown[]): Promise<unknown> {
    let lastErr: unknown;
    for (const url of config.rpcUrls?.[chainId] ?? []) {
      try {
        const res = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), signal: timeoutSignal(12_000)});
        if (!res.ok) {
          const error = new Error(`HTTP ${res.status}`);
          const info = httpRefusal(res.status, res.headers?.get?.("retry-after"));
          throw info ? withReason(error, info) : error;
        }
        const body = (await res.json()) as {result?: unknown; error?: {message?: string; data?: unknown}};
        if (body.error) throw Object.assign(new Error(body.error.message ?? "rpc error"), {rpc: true, data: body.error.data});
        return body.result ?? null;
      } catch (e) {
        if ((e as {rpc?: boolean}).rpc) throw e;
        lastErr = e;
      }
    }
    throw withReason(new Error(`kyberswap: no RPC answered on chain ${chainId} (${lastErr instanceof Error ? lastErr.message : String(lastErr ?? "none configured")})`), refusalOf(lastErr) ?? "upstream_unavailable");
  }

  type ApiResult = {ok: true; data: Record<string, unknown>} | {ok: false; why: string; info?: Swap2RefusalReason | Swap2RefusalInfo};
  async function api(url: string, init: RequestInit, signal?: AbortSignal): Promise<ApiResult> {
    let res: Response;
    try {
      res = await fetch(url, {...init, headers: {...headers, ...(init.body ? {"content-type": "application/json"} : {})}, signal: signal ?? timeoutSignal(timeoutMs)});
    } catch (e) {
      return {ok: false, why: `API unreachable (${e instanceof Error ? e.name : "error"})`, ...(signal?.aborted ? {} : {info: "upstream_unavailable" as const})};
    }
    type Body = {code?: unknown; message?: unknown; data?: unknown};
    let body: Body | null;
    try {
      const parsed: unknown = await res.json();
      body = parsed && typeof parsed === "object" ? (parsed as Body) : null;
    } catch {
      body = null;
    }
    if (res.status === 429) return {ok: false, why: "rate limited (HTTP 429)", info: httpRefusal(429, res.headers?.get?.("retry-after")) ?? "rate_limited"};
    if (res.status === 401 || res.status === 403) return {ok: false, why: `API key rejected (HTTP ${res.status})`, info: httpRefusal(res.status) ?? "policy_refused"};
    if (res.status === 404 && !body?.code) return {ok: false, why: "KyberSwap does not serve this chain (HTTP 404)", info: "unsupported_pair"};
    if (!res.ok || body?.code !== 0) {
      const code = typeof body?.code === "number" ? body.code : undefined;
      const reason = errorReason(code) ?? (res.status >= 500 ? "upstream_unavailable" : undefined);
      return {ok: false, why: `${code !== undefined ? `error ${code}` : `HTTP ${res.status}`}${body?.message ? `: ${short(body.message)}` : ""}`, ...(reason ? {info: reason} : {})};
    }
    if (!body?.data || typeof body.data !== "object") return {ok: false, why: "malformed API response", info: "upstream_unavailable"};
    return {ok: true, data: body.data as Record<string, unknown>};
  }

  type RoutesResult = {ok: true; summary: RouteSummary; amountOut: bigint; sources: string[]} | {ok: false; why: string; info?: Swap2RefusalReason | Swap2RefusalInfo};
  async function routes(chainId: number, tokenIn: string, tokenOut: string, amountIn: bigint, signal?: AbortSignal): Promise<RoutesResult> {
    const q = new URLSearchParams({tokenIn: apiToken(tokenIn), tokenOut: apiToken(tokenOut), amountIn: amountIn.toString(), gasInclude: "true"});
    if (config.excludeRfqSources ?? true) q.set("excludeRFQSources", "true");
    if (config.excludedSources?.length) q.set("excludedSources", config.excludedSources.join(","));
    const r = await api(`${baseUrl}/${kyberChain(chainId)!.slug}/api/v1/routes?${q}`, {method: "GET"}, signal);
    if (!r.ok) return r;
    const summary = r.data.routeSummary as RouteSummary | undefined;
    const router = r.data.routerAddress;
    if (!summary || typeof summary !== "object") return {ok: false, why: "malformed API response (no route)", info: "upstream_unavailable"};
    if (same(router, KYBER_ROUTER_V3)) return {ok: false, why: "Kyber router V3 not supported yet", info: "policy_refused"};
    if (!same(router, KYBER_ROUTER_V2)) return {ok: false, why: "the route settles through another router than the pinned one", info: "vault_mismatch"};
    if (!same(summary.tokenIn, apiToken(tokenIn)) || !same(summary.tokenOut, apiToken(tokenOut))) return {ok: false, why: "the route swaps other tokens than requested", info: "policy_refused"};
    if (uint(summary.amountIn) !== amountIn) return {ok: false, why: "the route prices another amount", info: "price_check_failed"};
    const fee = summary.extraFee;
    // No fee is ever asked for: the API answers with empty fields ("" amount, "" receiver); anything else is refused.
    if (fee !== undefined && fee !== null) {
      const amount = fee.feeAmount === "" || fee.feeAmount === undefined ? 0n : uint(fee.feeAmount);
      if (typeof fee !== "object" || amount !== 0n || (fee.feeReceiver !== undefined && fee.feeReceiver !== "")) return {ok: false, why: "the route carries an integrator fee", info: "policy_refused"};
    }
    const amountOut = uint(summary.amountOut);
    if (amountOut === null || amountOut <= 0n) return {ok: false, why: "the route pays nothing", info: "no_route"};
    const sources = [...new Set((summary.route ?? []).flat().map((h) => h?.exchange).filter((x): x is string => typeof x === "string"))].slice(0, 6).map((s) => s.slice(0, 40));
    return {ok: true, summary, amountOut, sources};
  }

  /** Why the swap reverts for `sender` now: the price (the router's minimum check), the wallet's input, or the revert as it is. */
  async function revertReason(chainId: number, sender: string, quoted: NonNullable<Quote["txRequest"]>, e: unknown): Promise<Error> {
    const text = revertString(e);
    if (text && /return amount is not enough|min return/i.test(text)) {
      return refusal("price_check_failed", "kyberswap: the price moved past your minimum. Nothing was sent; refresh the quote.");
    }
    const lack = await inputShortfall(chainId, sender, quoted).catch(() => null);
    if (lack) return refusal("simulation_failed", lack);
    return refusal("simulation_failed", `kyberswap: the swap would revert now (${short(text ?? (e instanceof Error ? e.message : "revert"))}). Nothing was sent; refresh the quote.`);
  }

  async function inputShortfall(chainId: number, sender: string, quoted: NonNullable<Quote["txRequest"]>): Promise<string | null> {
    const call = decodeFunctionData({abi: KYBER_ROUTER_ABI, data: quoted.data as Hex});
    const desc = (call.args[0] as {desc: {srcToken: string; amount: bigint}}).desc;
    const word = (v: unknown): bigint | null => (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : null);
    if (same(desc.srcToken, KYBER_NATIVE)) {
      const balance = word(await rpc(chainId, "eth_getBalance", [sender, "latest"]));
      return balance !== null && balance < desc.amount ? `kyberswap: the wallet's balance is below the amount (${balance} < ${desc.amount}). Nothing was sent.` : null;
    }
    const read = (data: Hex) => rpc(chainId, "eth_call", [{to: desc.srcToken, data}, "latest"]);
    const [balance, allowance] = (await Promise.all([
      read(encodeFunctionData({abi: ERC20_READS, functionName: "balanceOf", args: [sender as Hex]})),
      read(encodeFunctionData({abi: ERC20_READS, functionName: "allowance", args: [sender as Hex, KYBER_ROUTER_V2]})),
    ])).map(word);
    if (balance != null && balance < desc.amount) return `kyberswap: the wallet's balance is below the amount (${balance} < ${desc.amount}). Nothing was sent.`;
    if (allowance != null && allowance < desc.amount) return "kyberswap: the token approval is not visible on-chain yet. Nothing was sent; try again in a moment.";
    return null;
  }

  /**
   * A token sale is checked before the user pays for an approval: with the allowance already in place the exact call
   * runs against the latest block; without it the approval and the swap run as one simulated block (eth_simulateV1),
   * so a route that reverts never asks for an approval. A wallet without the input, or an RPC that cannot simulate a
   * block, skips the check (`null` with the reason in `skipped`) — preflightDeposit still simulates before signing.
   */
  async function tokenSwapCheck(chainId: number, sender: string, token: string, amount: bigint, data: Hex): Promise<{refusal: ReturnType<typeof refuseRevert> | null; simulated: string}> {
    const word = (v: unknown): bigint | null => (typeof v === "string" && /^0x[0-9a-fA-F]{1,64}$/.test(v) ? BigInt(v) : null);
    const read = (call: Hex) => rpc(chainId, "eth_call", [{to: token, data: call}, "latest"]);
    const [balance, allowance] = (await Promise.all([
      read(encodeFunctionData({abi: ERC20_READS, functionName: "balanceOf", args: [sender as Hex]})),
      read(encodeFunctionData({abi: ERC20_READS, functionName: "allowance", args: [sender as Hex, KYBER_ROUTER_V2]})),
    ])).map(word);
    if (balance == null || allowance == null) return {refusal: null, simulated: "none"};
    if (balance < amount) return {refusal: null, simulated: "none"};
    if (allowance >= amount) {
      try {
        await rpc(chainId, "eth_call", [{from: sender, to: KYBER_ROUTER_V2, data, value: "0x0"}, "latest"]);
        return {refusal: null, simulated: "swap"};
      } catch (e) {
        if ((e as {rpc?: boolean}).rpc) return {refusal: refuseRevert(revertString(e)), simulated: "swap"};
        throw e;
      }
    }
    const approve = (n: bigint) => ({from: sender, to: token, data: encodeFunctionData({abi: ERC20_READS, functionName: "approve", args: [KYBER_ROUTER_V2, n]})});
    // A token that refuses to change a non-zero allowance (USDT) is reset first, as the wallet's own approval does.
    const calls = [...(allowance > 0n ? [approve(0n)] : []), approve(amount), {from: sender, to: KYBER_ROUTER_V2, data, value: "0x0"}];
    let result: unknown;
    try {
      result = await rpc(chainId, "eth_simulateV1", [{blockStateCalls: [{calls}], validation: false}, "latest"]);
    } catch {
      return {refusal: null, simulated: "none"};
    }
    type Call = {status?: unknown; returnData?: unknown; error?: {message?: unknown; data?: unknown}};
    const out = (Array.isArray(result) ? (result[0] as {calls?: Call[]} | undefined)?.calls : undefined) ?? [];
    if (out.length !== calls.length || out.slice(0, -1).some((c) => c.status !== "0x1")) return {refusal: null, simulated: "none"};
    const swap = out[out.length - 1]!;
    if (swap.status === "0x1") return {refusal: null, simulated: "approve+swap"};
    const err = {data: swap.error?.data ?? swap.returnData, message: typeof swap.error?.message === "string" ? swap.error.message : ""};
    return {refusal: refuseRevert(revertString(Object.assign(new Error(err.message), {data: err.data}))), simulated: "approve+swap"};
  }

  function refuseRevert(why: string | null): {why: string; reason: Swap2RefusalReason} {
    return {
      why: `the route does not execute on-chain right now${why ? ` (${short(why)})` : ""}`,
      reason: why && /return amount is not enough/i.test(why) ? "price_check_failed" : "simulation_failed",
    };
  }

  return {
    name: "kyberswap",
    describeActivity: describeKyberActivity,
    supportsSameChain: true,
    // The account's own estimate of the exact call, never the API's gas model.
    ownGasEstimate: true,
    enabled: () => config.enabled ?? true,
    supportsChain: (caip2: string) => chainIdOf(caip2) !== null,
    supportsChainPair: (from: string, to: string) => from === to && chainIdOf(from) !== null,
    supportsRoute: (from: Asset, to: Asset) => {
      if (from.chain !== to.chain) return false;
      const id = chainIdOf(from.chain);
      if (id === null) return false;
      // Native ↔ wrapped is a wrap (the Wrap provider's), which KyberSwap does not route: no request is spent on it.
      const wrapped = Object.prototype.hasOwnProperty.call(WRAPPED_NATIVE, id) ? WRAPPED_NATIVE[id]!.address : null;
      const isNative = (t: string) => /^0x0+$/.test(t) || same(t, KYBER_NATIVE) || t === ccAssetByToken(from.chain, ZERO)?.symbol;
      const isWrapped = (t: string) => !!wrapped && (same(t, wrapped) || t === WRAPPED_NATIVE[id]!.symbol);
      return !((isNative(from.token) && isWrapped(to.token)) || (isWrapped(from.token) && isNative(to.token)));
    },

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const refuse = (why: string, info?: Swap2RefusalReason | Swap2RefusalInfo): null => {
        params.onRefusal?.(`kyberswap: ${why}`, typeof info === "string" ? {reason: info} : info);
        return null;
      };
      if (params.flex) return refuse("amount-flexible deposits are not supported", "unsupported_pair");
      if (params.sourceChain !== params.destChain) return refuse("same-chain swaps only", "unsupported_pair");
      const chainId = chainIdOf(params.sourceChain);
      if (chainId === null) return refuse(`KyberSwap is not enabled for ${params.sourceChain}`, "unsupported_pair");
      const chain = kyberChain(chainId)!;
      const src = sourceAssetOf(params);
      if (!src) return refuse(`unknown source token ${params.sourceToken}`, "unsupported_pair");
      const tokenIn = src.contract ? getAddress(src.contract) : ZERO;
      const nativeOut = /^0x0+$/.test(params.destToken) || same(params.destToken, KYBER_NATIVE);
      if (!nativeOut && !isAddr(params.destToken)) return refuse("destination token must be an EVM address", "unsupported_pair");
      const tokenOut = nativeOut ? ZERO : getAddress(params.destToken);
      // Refused before any request: a useless call spends the shared keyless quota.
      if (tokenIn === tokenOut) return refuse("same token in and out", "unsupported_pair");
      if ((tokenIn === ZERO || tokenOut === ZERO) && !kyberNativeSwaps(chainId)) return refuse(`the native coin on ${chain.name} is not a catalog asset here; swap its ERC-20 instead`, "unsupported_pair");
      let amountIn: bigint;
      try {
        amountIn = BigInt(params.amountIn);
      } catch {
        return refuse("amount is not an integer");
      }
      if (amountIn <= 0n) return refuse("amount must be positive");
      const bps = params.slippageBps ?? slippageDefault;
      if (!Number.isInteger(bps) || bps <= 0 || bps >= 2_000) return refuse("invalid slippage (KyberSwap accepts under 20%)", "price_check_failed");
      let floor = 0n;
      if (params.minAmountOut !== undefined) {
        const f = uint(params.minAmountOut);
        if (f === null) return refuse("minimum output is not an integer");
        floor = f;
      }
      const dry = params.dry !== false;
      if (!dry && !isAddr(params.destAddress)) return refuse("recipient must be an EVM address", "recipient_mismatch");
      if (!dry && !config.rpcUrls?.[chainId]?.length) return refuse(`no RPC configured for ${chain.name}: a KyberSwap swap is simulated before it is signed`, "upstream_unavailable");

      // Dry quotes for the same request share one route for a few seconds; an execution quote always asks afresh.
      let r: RoutesResult;
      if (dry) {
        const key = `${chainId}|${tokenIn}|${tokenOut}|${amountIn}`;
        const hit = dryCache.get(key);
        if (hit && Date.now() - hit.at < DRY_CACHE_MS) r = await hit.value;
        else {
          const value = routes(chainId, tokenIn, tokenOut, amountIn, signal);
          dryCache.set(key, {at: Date.now(), value});
          if (dryCache.size > 64) for (const [k, v] of dryCache) if (Date.now() - v.at >= DRY_CACHE_MS) dryCache.delete(k);
          r = await value;
          if (!r.ok) dryCache.delete(key);
        }
      } else r = await routes(chainId, tokenIn, tokenOut, amountIn, signal);
      if (!r.ok) return refuse(r.why, r.info);
      // KyberSwap's minimum lands one unit under the plain floor; asking for a hair less slippage keeps it at or
      // above the engine's floor for the user's slippage (a tiny output needs more than 1 bps for that unit).
      const apiBps = kyberApiSlippage(r.amountOut, bps);
      if (apiBps === null) return refuse("the output is too small to carry a minimum", "amount_too_small");
      const minOut = kyberMinimum(r.amountOut, apiBps);
      if (minOut < floor) return refuse(`floor breach (min=${minOut} < floor=${floor})`, "price_check_failed");

      // The route's own gas figure, for comparing routes; execution still sends the account's own estimate.
      const gasEstimate = kyberGasEstimate(r.summary.gas);
      const base = {
        provider: "kyberswap",
        intentId: `kyberswap:${chainId}`,
        depositAddress: "",
        depositMemo: null,
        sourceAmount: amountIn.toString(),
        // KyberSwap's amountOut is the route's ceiling, not an average: the executed output came 1.5–7.4 bps under it.
        destAmount: r.amountOut.toString(),
        minDestAmount: minOut.toString(),
        feeUsd: 0,
        ...(gasEstimate !== undefined ? {gasEstimate, gasEstimateSource: "venue" as const} : {}),
        etaSeconds: 15,
        reliability: 0.95,
        validUntilMs: Date.now() + ttl,
      } satisfies Partial<Quote>;
      const providerData: Record<string, string> = {
        amountOut: r.amountOut.toString(),
        minOut: minOut.toString(),
        apiSlippageBps: String(apiBps),
        ...(typeof r.summary.routeID === "string" ? {routeId: r.summary.routeID.slice(0, 80)} : {}),
        ...(r.sources.length ? {sources: r.sources.join(",")} : {}),
      };
      // The router's quoteValues reads priceImpactBps into the user's "be careful" warning (Unichain USDC → JUP: −78 %).
      const lossBps = kyberValueLossBps(r.summary.amountInUsd, r.summary.amountOutUsd);
      if (lossBps !== null) providerData.priceImpactBps = String(lossBps);
      if (dry) {
        // A token sale approves the router first; the auction's gas estimate reads the spender from here.
        return {...base, providerData: tokenIn === ZERO ? providerData : {...providerData, approvalAddress: KYBER_ROUTER_V2}};
      }

      const receiver = getAddress(params.destAddress);
      const signer = isAddr(params.sender) ? params.sender : isAddr(params.refundAddress) ? params.refundAddress : params.destAddress;
      const sender = getAddress(signer);
      const built = await api(`${baseUrl}/${chain.slug}/api/v1/route/build`, {
        method: "POST",
        body: JSON.stringify({
          routeSummary: r.summary,
          sender,
          recipient: receiver,
          slippageTolerance: apiBps,
          deadline: Math.floor(Date.now() / 1000) + BUILD_DEADLINE_S,
          source: clientId,
        }),
      }, signal);
      if (!built.ok) return refuse(`build: ${built.why}`, built.info);
      const b = built.data;
      if (uint(b.amountIn) !== amountIn) return refuse("the build spends another amount", "price_check_failed");
      if (same(b.routerAddress, KYBER_ROUTER_V3)) return refuse("Kyber router V3 not supported yet", "policy_refused");
      const value = uint(b.transactionValue ?? "0");
      if (value === null || typeof b.data !== "string") return refuse("malformed build response", "upstream_unavailable");
      const tx = {to: typeof b.routerAddress === "string" ? b.routerAddress : "", value, data: b.data};
      let decoded;
      try {
        decoded = checkKyberTransaction(tx, {chainId, tokenIn, tokenOut, amountIn, receiver, minAmountOut: minOut > floor ? minOut : floor});
      } catch (e) {
        return refuse(e instanceof Error ? e.message.replace(/^kyberswap: /, "") : String(e), refusalOf(e));
      }
      // Native input needs no allowance: the exact call runs against the latest block now, so a route that would revert
      // never reaches the user. Token input is checked the same way before any approval (tokenSwapCheck).
      let simulated = "swap";
      if (tokenIn !== ZERO) {
        try {
          const check = await tokenSwapCheck(chainId, sender, tokenIn, amountIn, tx.data as Hex);
          if (check.refusal) return refuse(check.refusal.why, check.refusal.reason);
          simulated = check.simulated;
        } catch (e) {
          return refuse(e instanceof Error ? e.message.replace(/^kyberswap: /, "") : String(e), refusalOf(e) ?? "upstream_unavailable");
        }
      }
      if (tokenIn === ZERO) {
        try {
          await rpc(chainId, "eth_call", [{from: sender, to: KYBER_ROUTER_V2, data: tx.data, value: `0x${value.toString(16)}`}, "latest", {[sender]: {balance: `0x${(value + 10n ** 18n).toString(16)}`}}]);
        } catch (e) {
          if ((e as {rpc?: boolean}).rpc) {
            const why = revertString(e);
            return refuse(`the route does not execute on-chain right now${why ? ` (${short(why)})` : ""}`, why && /return amount is not enough/i.test(why) ? "price_check_failed" : "simulation_failed");
          }
          return refuse(e instanceof Error ? e.message.replace(/^kyberswap: /, "") : String(e), refusalOf(e) ?? "upstream_unavailable");
        }
      }
      return {
        ...base,
        minDestAmount: decoded.minReturnAmount.toString(),
        txRequest: {
          to: KYBER_ROUTER_V2,
          data: tx.data,
          value: value.toString(),
          chainId,
          ...(tokenIn === ZERO ? {} : {approvalAddress: KYBER_ROUTER_V2}),
        },
        providerData: {...providerData, sender, minOut: decoded.minReturnAmount.toString(), simulated},
      };
    },

    /**
     * Simulate the exact quoted transaction from the account at the latest block (approval in place) and refuse when
     * it would revert or when no RPC answers — the API is not trusted, so an unsimulated swap is not sent.
     * Only the quote's own transaction is simulated, never a caller's.
     */
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const chainId = Number(quote.intentId.split(":")[1]);
      const sender = quote.providerData?.sender;
      const quoted = quote.txRequest;
      if (!kyberChain(chainId) || !isAddr(sender)) throw refusal("policy_refused", "kyberswap: the quote is not an execution quote. Nothing was sent; refresh the quote.");
      if (!quoted?.to || !quoted.data || !sameText(tx.to, quoted.to) || !sameText(tx.data ?? "", quoted.data) || !sameAmount(tx.value || "0", quoted.value ?? "0")) {
        throw refusal("policy_refused", "kyberswap: the transaction is not the quoted swap. Nothing was sent; refresh the quote.");
      }
      try {
        await rpc(chainId, "eth_call", [{from: sender, to: quoted.to, data: quoted.data, value: `0x${BigInt(quoted.value ?? "0").toString(16)}`}, "latest"]);
      } catch (e) {
        if ((e as {rpc?: boolean}).rpc) throw await revertReason(chainId, sender, quoted, e);
        throw withReason(new Error("kyberswap: the swap cannot be simulated (no RPC answered). Nothing was sent; try again."), refusalOf(e) ?? "upstream_unavailable");
      }
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx?.to || !tx.data) throw refusal("policy_refused", "swap2: KyberSwap quote has no transaction request (a dry quote cannot be executed)");
      return {chain: "", to: tx.to, value: tx.value ?? "0", data: tx.data, ...(tx.chainId !== undefined ? {chainId: tx.chainId} : {}), ...(tx.approvalAddress ? {approvalAddress: tx.approvalAddress} : {})};
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      if (!ref.sourceTxHash) return {state: "pending"};
      const chainId = Number(ref.intentId.split(":")[1]);
      if (!kyberChain(chainId) || !config.rpcUrls?.[chainId]?.length) return {state: "pending"};
      try {
        const receipt = (await rpc(chainId, "eth_getTransactionReceipt", [ref.sourceTxHash])) as {status?: string} | null;
        if (!receipt) return {state: "pending"};
        return receipt.status === "0x1" ? {state: "completed", destTxHash: ref.sourceTxHash} : {state: "failed"};
      } catch {
        return {state: "pending"};
      }
    },
  };
}
