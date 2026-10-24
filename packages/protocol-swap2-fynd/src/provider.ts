import {getAddress} from "viem";
import {ccAsset} from "@anywalletkit/swap2-assets";
import {evmRef, isEvm, timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {describeFyndActivity} from "./activity.js";
import {FYND_CHAINS, checkFyndTransaction} from "./router.js";

/**
 * Fynd — Propeller Heads' DEX aggregator (docs.fynd.xyz) as a same-chain
 * swap2 provider: exact-input swaps on Ethereum, Base, Arbitrum, BNB Chain,
 * Polygon, Unichain and Robinhood Chain, priced over the pools Tycho indexes
 * and settled through TychoRouterV3.
 *
 * Fynd outputs are licensed under the Fynd License: a swap built from a Fynd
 * quote must settle through the Tycho router with its fees intact — which is
 * the only transaction this provider builds (see README).
 *
 * Two backends: the hosted API (`apiKey` — keep it on a server, behind
 * `remoteProvider`) or your own `fynd serve` per chain (`selfHosted`).
 */

const ZERO = "0x0000000000000000000000000000000000000000";
const DEFAULT_BASE_URL = "https://fynd-api.propellerheads.xyz";
const DEFAULT_SLIPPAGE_BPS = 50;
/** A Fynd quote is priced at one block; the router enforces the minimum, the engine re-checks this TTL before broadcast. */
const DEFAULT_TTL_MS = 30_000;
/**
 * Liquidity families left out of routing by default. 2026-10-24 on the hosted
 * API: every Ethereum route through `uniswap_v4_hooks` was quoted ~0.6–1 %
 * above the market and reverted when simulated (4 of 4 native-in pairs,
 * also USDT → USDC), while the same pairs without it executed (8 of 8 across
 * Ethereum, Base and Arbitrum). Override with `excludeProtocols`.
 */
export const FYND_DEFAULT_EXCLUDED_PROTOCOLS: readonly string[] = Object.freeze(["uniswap_v4_hooks"]);
const QUOTE_FAILURES: Readonly<Record<string, string>> = {
  no_route_found: "no route for this pair",
  insufficient_liquidity: "not enough liquidity for this amount",
  timeout: "the solver timed out",
  not_ready: "the solver is still syncing",
  price_check_failed: "the price guard rejected the route",
  encoding_failed: "could not encode the swap (fees + slippage leave nothing)",
};

export interface FyndProviderConfig {
  enabled?: boolean;
  /** Hosted API key (raw `Authorization` value). Server-side only. */
  apiKey?: string;
  /** Hosted API base URL; requests go to `{baseUrl}/v1/{chain}/quote`. */
  baseUrl?: string;
  /** Your own Fynd servers per EVM chain id; requests go to `{url}/v1/quote`, no key. Takes precedence over the hosted API for that chain. */
  selfHosted?: Readonly<Record<number, string>>;
  /** JSON-RPC endpoints per chain id: pre-broadcast simulation and receipts. Optional. */
  rpcUrls?: Readonly<Record<number, readonly string[]>>;
  defaultSlippageBps?: number;
  quoteTtlMs?: number;
  timeoutMs?: number;
  /** Protocol names or family prefixes ending in ":" Fynd must not route through. Default {@link FYND_DEFAULT_EXCLUDED_PROTOCOLS}. */
  excludeProtocols?: readonly string[];
}

interface FyndOrderQuote {
  status?: string;
  amount_in?: string;
  amount_out?: string;
  gas_estimate?: string;
  price_impact_bps?: number | null;
  route?: {swaps?: {protocol?: string}[]};
  fee_breakdown?: {router_fee?: string; client_fee?: string; max_slippage?: string; min_amount_received?: string};
  transaction?: {to?: string; value?: string; data?: string};
}

const uint = (v: unknown): bigint | null => (typeof v === "string" && /^\d+$/.test(v) ? BigInt(v) : null);

export function fyndProvider(config: FyndProviderConfig): CrossChainProvider {
  const baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
  const slippageDefault = config.defaultSlippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const ttl = config.quoteTtlMs ?? DEFAULT_TTL_MS;
  const timeoutMs = config.timeoutMs ?? 10_000;
  const excluded = [...(config.excludeProtocols ?? FYND_DEFAULT_EXCLUDED_PROTOCOLS)];
  const isExcluded = (protocol: string) => excluded.some((x) => (x.endsWith(":") ? protocol.startsWith(x) : protocol === x));

  const endpoint = (chainId: number): {url: string; headers: Record<string, string>} | null => {
    const chain = FYND_CHAINS[chainId];
    if (!chain) return null;
    const own = config.selfHosted?.[chainId];
    if (own) return {url: `${own.replace(/\/+$/, "")}/v1/quote`, headers: {}};
    if (!config.apiKey) return null;
    return {url: `${baseUrl}/v1/${chain.slug}/quote`, headers: {authorization: config.apiKey}};
  };
  const chainIdOf = (caip2: string): number | null => {
    if (!isEvm(caip2)) return null;
    const id = evmRef(caip2);
    return endpoint(id) ? id : null;
  };

  async function rpc(chainId: number, method: string, params: unknown[]): Promise<unknown> {
    let lastErr: unknown;
    for (const url of config.rpcUrls?.[chainId] ?? []) {
      try {
        const res = await fetch(url, {method: "POST", headers: {"content-type": "application/json"}, body: JSON.stringify({jsonrpc: "2.0", id: 1, method, params}), signal: timeoutSignal(12_000)});
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const body = (await res.json()) as {result?: unknown; error?: {message?: string}};
        if (body.error) throw Object.assign(new Error(body.error.message ?? "rpc error"), {rpc: true});
        return body.result ?? null;
      } catch (e) {
        if ((e as {rpc?: boolean}).rpc) throw e;
        lastErr = e;
      }
    }
    throw new Error(`fynd: no RPC answered on chain ${chainId} (${lastErr instanceof Error ? lastErr.message : String(lastErr)})`);
  }

  return {
    name: "fynd",
    describeActivity: describeFyndActivity,
    supportsSameChain: true,
    enabled: () => config.enabled ?? true,
    supportsChain: (caip2: string) => chainIdOf(caip2) !== null,
    supportsChainPair: (from: string, to: string) => from === to && chainIdOf(from) !== null,
    supportsRoute: (from: Asset, to: Asset) => from.chain === to.chain && chainIdOf(from.chain) !== null,

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const refuse = (why: string): null => {
        params.onRefusal?.(`fynd: ${why}`);
        return null;
      };
      if (params.flex) return refuse("amount-flexible deposits are not supported");
      if (params.sourceChain !== params.destChain) return refuse("same-chain swaps only");
      const chainId = chainIdOf(params.sourceChain);
      if (chainId === null) return refuse(`Fynd is not configured for ${params.sourceChain}`);
      const ep = endpoint(chainId)!;
      const src = ccAsset(params.sourceChain, params.sourceToken);
      if (!src) return refuse(`unknown source token ${params.sourceToken}`);
      const tokenIn = src.contract ? getAddress(src.contract) : ZERO;
      const nativeOut = /^0x0+$/.test(params.destToken);
      if (!nativeOut && !/^0x[0-9a-fA-F]{40}$/.test(params.destToken)) return refuse("destination token must be an EVM address");
      const tokenOut = nativeOut ? ZERO : getAddress(params.destToken);
      if (tokenIn === tokenOut) return refuse("same token in and out");
      if (!/^0x[0-9a-fA-F]{40}$/.test(params.destAddress)) return refuse("recipient must be an EVM address");
      const receiver = getAddress(params.destAddress);
      const sender = getAddress(params.refundAddress && /^0x[0-9a-fA-F]{40}$/.test(params.refundAddress) ? params.refundAddress : params.destAddress);
      let amountIn: bigint;
      try {
        amountIn = BigInt(params.amountIn);
      } catch {
        return refuse("amount is not an integer");
      }
      if (amountIn <= 0n) return refuse("amount must be positive");
      const bps = params.slippageBps ?? slippageDefault;
      if (!Number.isInteger(bps) || bps <= 0 || bps >= 10_000) return refuse("invalid slippage");

      const body = {
        orders: [{token_in: tokenIn, token_out: tokenOut, amount: amountIn.toString(), side: "sell", sender, receiver}],
        options: {
          timeout_ms: Math.min(timeoutMs, 8_000),
          encoding_options: {slippage: (bps / 10_000).toString(), transfer_type: "transfer_from"},
          ...(excluded.length ? {route_filter: {exclude_protocols: excluded}} : {}),
        },
      };
      let res: Response;
      try {
        res = await fetch(ep.url, {method: "POST", headers: {"content-type": "application/json", ...ep.headers}, body: JSON.stringify(body), signal: signal ?? timeoutSignal(timeoutMs)});
      } catch (e) {
        return refuse(`API unreachable (${e instanceof Error ? e.name : "error"})`);
      }
      if (res.status === 401 || res.status === 403) return refuse(`API key rejected (HTTP ${res.status})`);
      if (res.status === 429) return refuse("rate limited (HTTP 429)");
      if (res.status === 422) return refuse("no route for this pair");
      if (!res.ok) return refuse(`API answered HTTP ${res.status}`);
      let parsed: {orders?: FyndOrderQuote[]};
      try {
        parsed = (await res.json()) as {orders?: FyndOrderQuote[]};
      } catch {
        return refuse("malformed API response");
      }
      if (!Array.isArray(parsed.orders) || parsed.orders.length !== 1) return refuse("malformed API response (order count)");
      const q = parsed.orders[0]!;
      if (q.status !== "success") return refuse(QUOTE_FAILURES[q.status ?? ""] ?? `quote status ${String(q.status).slice(0, 40)}`);

      const quotedIn = uint(q.amount_in);
      const gross = uint(q.amount_out);
      const routerFee = uint(q.fee_breakdown?.router_fee);
      const clientFee = uint(q.fee_breakdown?.client_fee);
      const maxSlippage = uint(q.fee_breakdown?.max_slippage);
      const minOut = uint(q.fee_breakdown?.min_amount_received);
      const value = uint(q.transaction?.value ?? "");
      if (quotedIn === null || gross === null || routerFee === null || clientFee === null || maxSlippage === null || minOut === null || value === null) {
        return refuse("malformed quote amounts");
      }
      if (quotedIn !== amountIn) return refuse(`quoted ${quotedIn}, not the requested ${amountIn}`);
      if (clientFee !== 0n) return refuse("the quote carries a client fee");
      if (routerFee + clientFee + maxSlippage + minOut !== gross) return refuse("fee breakdown does not add up to the output");
      if (params.minAmountOut !== undefined && minOut < BigInt(params.minAmountOut)) return refuse(`floor breach (min=${minOut} < floor=${params.minAmountOut})`);
      const tx = {to: q.transaction?.to ?? "", value, data: q.transaction?.data ?? ""};
      try {
        checkFyndTransaction(tx, {chainId, tokenIn, tokenOut, amountIn, receiver, expectedAmountOut: gross, minAmountOut: minOut});
      } catch (e) {
        return refuse(e instanceof Error ? e.message.replace(/^fynd: /, "") : String(e));
      }
      const allProtocols = [...new Set((q.route?.swaps ?? []).map((s) => s.protocol).filter((p): p is string => typeof p === "string"))];
      const banned = allProtocols.find(isExcluded);
      if (banned) return refuse(`the route goes through ${banned}, which this wallet excludes`);
      // Native input needs no allowance: the exact transaction can be executed
      // against the latest block right now, so a route that would revert never
      // enters the auction. (ERC-20 input is simulated in preflightDeposit,
      // once the approval exists.)
      if (tokenIn === ZERO && config.rpcUrls?.[chainId]?.length) {
        try {
          await rpc(chainId, "eth_call", [{from: sender, to: tx.to, data: tx.data, value: `0x${value.toString(16)}`}, "latest", {[sender]: {balance: `0x${(value + 10n ** 18n).toString(16)}`}}]);
        } catch (e) {
          if ((e as {rpc?: boolean}).rpc) return refuse(`the route does not execute on-chain right now (simulation reverted via ${allProtocols.join(", ") || "?"})`);
          // no RPC answered: the router still enforces the minimum
        }
      }
      const gas = uint(q.gas_estimate) ?? 0n;
      const protocols = allProtocols.slice(0, 6);
      return {
        provider: "fynd",
        intentId: `fynd:${chainId}`,
        depositAddress: "",
        depositMemo: null,
        txRequest: {
          to: getAddress(tx.to),
          data: tx.data,
          value: value.toString(),
          chainId,
          // the router's own overhead on top of Fynd's route estimate
          gasLimit: ((gas * 13n) / 10n + 80_000n).toString(),
          ...(tokenIn === ZERO ? {} : {approvalAddress: getAddress(tx.to)}),
        },
        sourceAmount: amountIn.toString(),
        // what the receiver gets at the quoted price: gross minus the router fee
        destAmount: (gross - routerFee).toString(),
        minDestAmount: minOut.toString(),
        feeUsd: 0,
        etaSeconds: 15,
        reliability: 0.96,
        validUntilMs: Date.now() + ttl,
        providerData: {
          minOut: minOut.toString(),
          sender,
          routerFee: routerFee.toString(),
          gross: gross.toString(),
          protocols: protocols.join(","),
          ...(typeof q.price_impact_bps === "number" ? {priceImpactBps: String(q.price_impact_bps)} : {}),
        },
      };
    },

    /** Simulate the exact transaction at the latest block (allowance already in place); refuse when it would revert. */
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const chainId = Number(quote.intentId.split(":")[1]);
      const sender = quote.providerData?.sender;
      if (!FYND_CHAINS[chainId] || !config.rpcUrls?.[chainId]?.length || !tx.data || !sender) return;
      try {
        await rpc(chainId, "eth_call", [{from: sender, to: tx.to, data: tx.data, value: `0x${BigInt(tx.value || "0").toString(16)}`}, "latest"]);
      } catch (e) {
        if ((e as {rpc?: boolean}).rpc) {
          throw new Error(`fynd: the swap would revert now (${e instanceof Error ? e.message.slice(0, 120) : "revert"}) — the price moved past your minimum. Nothing was sent; refresh the quote.`);
        }
        // no RPC answered: leave it to the router's own minimum
      }
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      if (!tx?.to || !tx.data) throw new Error("swap2: Fynd quote has no transaction request");
      return {chain: "", to: tx.to, value: tx.value ?? "0", data: tx.data, ...(tx.chainId !== undefined ? {chainId: tx.chainId} : {}), ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {}), ...(tx.approvalAddress ? {approvalAddress: tx.approvalAddress} : {})};
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      if (!ref.sourceTxHash) return {state: "pending"};
      const chainId = Number(ref.intentId.split(":")[1]);
      if (!FYND_CHAINS[chainId] || !config.rpcUrls?.[chainId]?.length) return {state: "pending"};
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
