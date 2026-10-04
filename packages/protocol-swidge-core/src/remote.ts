import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "./types.js";
import {anySignal, timeoutSignal} from "./util.js";

/**
 * HTTP-proxied `CrossChainProvider`: forwards every provider call to a backend
 * that runs the real provider. This is how a BROWSER context (e.g. a wallet's
 * signing worker) executes the full swidge layer — account binding,
 * approvals, cell-body guards, id/status lifecycle — while provider secrets
 * (API JWTs, affiliate config) and non-CORS REST endpoints stay server-side.
 *
 * Wire protocol: POST {baseUrl}/{action} with a JSON body, one action per
 * provider method:
 *   quote  {provider, params: QuoteParams}        → Quote | null
 *   build  {provider, quote: Quote}               → UnsignedTx
 *   preflight {provider, quote: Quote, tx: UnsignedTx} → {}
 *   track  {provider, ref: IntentRef}             → IntentStatus
 *   notify {provider, intentId, txHash}           → {}
 *   register {provider, intentId, signature}      → {}
 *   supports {provider, from, to}                 → {supported: boolean}
 *
 * `supportsRoute`/`enabled` need a SYNC answer, so they are config: pass the
 * routes the backend advertises via `supports`, or leave the default
 * allow-and-let-quote-decide behavior (a null quote is a clean miss).
 */
export interface RemoteProviderOptions {
  /** Provider name the backend multiplexes on (e.g. "near-intents"). */
  name: string;
  /** Endpoint prefix, e.g. "/api/v2/swidge" (same-origin) or absolute URL. */
  baseUrl: string;
  /** Sync capability gate; defaults to true (the backend quote decides). */
  supportsRoute?: (from: Asset, to: Asset) => boolean;
  /** Optional synchronous dark flag for accurate client-side discovery. */
  enabled?: () => boolean;
  /** Optional chain-level discovery hooks mirrored from the backend. */
  supportsChain?: (caip2: string) => boolean;
  supportsChainPair?: (fromChain: string, toChain: string) => boolean;
  /** Explicit opt-in when the backend can execute same-chain swaps. */
  supportsSameChain?: boolean;
  /** Defaults to globalThis.fetch — injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Extra headers (e.g. auth) attached to every call. */
  headers?: Record<string, string>;
  /** Per-request fail-closed timeout. Defaults to 12 seconds. */
  timeoutMs?: number;
}

export function remoteProvider(opts: RemoteProviderOptions): CrossChainProvider {
  const name = opts.name;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("swidge-remote: invalid provider name");
  const baseUrl = opts.baseUrl.replace(/\/+$/, "");
  if (!baseUrl) throw new Error("swidge-remote: baseUrl is required");
  const supportsRoute = opts.supportsRoute;
  const enabled = opts.enabled;
  const headers = Object.freeze({...opts.headers});
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error("swidge-remote: timeoutMs must be an integer between 1 and 60000");
  }

  async function call<T>(action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const timeout = timeoutSignal(timeoutMs);
    const requestSignal = signal ? anySignal([signal, timeout]) : timeout;
    const res = await doFetch(`${baseUrl}/${action}`, {
      method: "POST",
      headers: {...headers, "content-type": "application/json"},
      body: JSON.stringify({provider: name, ...body}),
      signal: requestSignal,
    });
    if (!res.ok) {
      // Surface the backend's message — provider errors are actionable
      // ("quote expired", "route unsupported"), not just status codes.
      const text = await res.text().catch(() => "");
      throw new Error(`swidge-remote ${name}/${action}: ${res.status} ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  return {
    name,
    // The browser side has no dark-flag env; the backend enforces its own
    // flags — a disabled provider simply quotes null / rejects build.
    enabled: () => enabled ? enabled() : true,
    supportsRoute(from: Asset, to: Asset): boolean {
      return supportsRoute ? supportsRoute(from, to) : true;
    },
    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const out = await call<Quote | {noQuote: string} | null>("quote", {params}, signal);
      if (out && typeof out === "object" && "noQuote" in out) {
        // The backend forwarded the venue's own refusal — throw it so the
        // router records a REASON instead of an anonymous null.
        throw new Error(String((out as {noQuote: unknown}).noQuote).slice(0, 300));
      }
      return out;
    },
    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      return call<UnsignedTx>("build", {quote});
    },
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      await call<Record<string, never>>("preflight", {quote, tx});
    },
    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      return call<IntentStatus>("track", {ref});
    },
    async notifyDeposit(intentId: string, txHash: string): Promise<void> {
      await call<Record<string, never>>("notify", {intentId, txHash});
    },
    async registerSignedOrder(intentId: string, signature: string): Promise<void> {
      await call<Record<string, never>>("register", {intentId, signature});
    },
    ...(opts.supportsChain ? {supportsChain: opts.supportsChain.bind(opts)} : {}),
    ...(opts.supportsChainPair ? {supportsChainPair: opts.supportsChainPair.bind(opts)} : {}),
    ...(opts.supportsSameChain !== undefined ? {supportsSameChain: opts.supportsSameChain} : {}),
  };
}
