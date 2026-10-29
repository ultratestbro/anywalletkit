import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "./types.js";
import {anySignal, timeoutSignal} from "./util.js";

/**
 * HTTP-proxied `CrossChainProvider`: forwards every provider call to a backend
 * that runs the real provider. This is how a BROWSER context (e.g. a wallet's
 * signing worker) executes the full swap2 layer — account binding,
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
 *   claim  {provider, ref: IntentRef}             → UnsignedTx | null
 *   supports {provider, from, to}                 → {supported: boolean}
 *
 * `supportsRoute`/`enabled` need a SYNC answer, so they are config: pass the
 * routes the backend advertises via `supports`, or leave the default
 * allow-and-let-quote-decide behavior (a null quote is a clean miss).
 */
export interface RemoteProviderOptions {
  /** Provider name the backend multiplexes on (e.g. "near-intents"). */
  name: string;
  /** Endpoint prefix, e.g. "/api/v2/swap2" (same-origin) or absolute URL. */
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
  /**
   * The contracts this provider's claims may call, per chain (e.g. `cctpClaimTargets` from
   * `@anywalletkit/protocol-swap2-cctp`). The app's list, not the server's: without it the engine
   * refuses claims from this stub (round 3, M24).
   */
  claimTargets?: (chain: string) => readonly string[];
  /**
   * The contracts this provider's EVM swaps may call, and the spenders they may be approved for,
   * per chain — the provider package's pins (`lifiPins`, `fyndPins`, `uniswapPins`…, spread into
   * these options). The app's lists, not the server's: without them the engine refuses this stub's
   * EVM calldata routes and approvals, so a compromised backend cannot name its own contract or
   * spender (scan 2026-10-27 modules, F8/F9/F16). Deposit-address routes need `depositAddressRoutes`.
   */
  callTargets?: (chain: string) => readonly string[];
  spenders?: (chain: string) => readonly string[];
  /**
   * The provider's own check of a quote's transaction, run here on the client against the request
   * the app sent (shipped with the pins, e.g. `fyndPins`): a quote it refuses never reaches the
   * auction. The backend runs the same check, but the backend is what this guards against.
   */
  verifyQuote?: (params: QuoteParams, quote: Quote) => string | null;
  /**
   * The provider's own check of a build on the client — a typed order, a cell body — against the quote it was built
   * for: the reason it fails, or null. A build it refuses is never approved or signed.
   */
  verifyBuild?: (quote: Quote, tx: UnsignedTx, params?: QuoteParams) => string | null | Promise<string | null>;
  /**
   * Let this stub's routes send the input to an address the backend names: a deposit address (NEAR Intents, a
   * THORChain or Chainflip Tron vault) or a plain value send. Off by default: such a route bypasses `callTargets`, so
   * a compromised backend could name its own address (scan 2026-10-28, F9). Opt in only for a provider whose deposit
   * addresses cannot be pinned, or whose `verifyQuote` / `verifyBuild` checks them (`thorchainPins`, `chainflipPins`).
   */
  depositAddressRoutes?: boolean;
  /**
   * Allow a non-https absolute `baseUrl` (local development only). Quotes, builds and typed orders travel this
   * channel; over plain http anyone on the path can rewrite them (scan 2026-10-27 modules, F4).
   */
  allowInsecureBaseUrl?: boolean;
  /** Defaults to globalThis.fetch — injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Extra headers (e.g. auth) attached to every call. */
  headers?: Record<string, string>;
  /** Per-request fail-closed timeout. Defaults to 12 seconds. */
  timeoutMs?: number;
}

/**
 * A provider that runs on your server: quotes, deposits and tracking go to `baseUrl`, so API keys
 * and affiliate settings never ship in the app. The engine still validates every quote and
 * transaction locally before signing.
 */
export function remoteProvider(opts: RemoteProviderOptions): CrossChainProvider {
  const name = opts.name;
  if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error("swap2-remote: invalid provider name");
  // Trimmed first: a URL parser drops leading spaces and tabs, so " http://host" would reach http (scan 2026-10-28 review).
  const baseUrl = opts.baseUrl.trim().replace(/\/+$/, "");
  if (!baseUrl) throw new Error("swap2-remote: baseUrl is required");
  // A same-origin path ("/api/swap2") inherits the page's scheme; an absolute URL must be https, and a
  // scheme-relative one ("//host/…") names another origin without saying how to reach it.
  const insecure = /^[a-z][a-z0-9+.-]*:/i.test(baseUrl) ? !/^https:\/\//i.test(baseUrl) : /^[\\/]{2}/.test(baseUrl);
  if (insecure && opts.allowInsecureBaseUrl !== true) {
    throw new Error("swap2-remote: baseUrl must be https:// or a same-origin path (allowInsecureBaseUrl for local development)");
  }
  const supportsRoute = opts.supportsRoute;
  const enabled = opts.enabled;
  const headers = Object.freeze({...opts.headers});
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 12_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 60_000) {
    throw new Error("swap2-remote: timeoutMs must be an integer between 1 and 60000");
  }

  // The request each quote answered, for verifyBuild (the build only carries the quote). Bounded: a stub quotes often.
  const requests = new Map<string, QuoteParams>();
  const remember = (intentId: string, params: QuoteParams) => {
    requests.delete(intentId);
    requests.set(intentId, params);
    if (requests.size > 64) requests.delete(requests.keys().next().value!);
  };

  async function call<T>(action: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<T> {
    const timeout = timeoutSignal(timeoutMs);
    const requestSignal = signal ? anySignal([signal, timeout]) : timeout;
    const res = await doFetch(`${baseUrl}/${action}`, {
      method: "POST",
      headers: {...headers, "content-type": "application/json"},
      // UnsignedTx carries bigint fields (value, gasLimit) — JSON.stringify
      // throws on them ("Do not know how to serialize a BigInt", seen
      // 2026-10-10 on a Solana → Base preflight). Wire them as decimal strings.
      body: JSON.stringify({provider: name, ...body}, (_k, v) => (typeof v === "bigint" ? v.toString() : v)),
      signal: requestSignal,
    });
    if (!res.ok) {
      // Surface the backend's message — provider errors are actionable
      // ("quote expired", "route unsupported"), not just status codes.
      const text = await res.text().catch(() => "");
      throw new Error(`swap2-remote ${name}/${action}: ${res.status} ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  return {
    name,
    remote: true,
    ...(opts.verifyBuild ? {verifiesBuilds: true} : {}),
    ...(opts.depositAddressRoutes === true ? {depositAddressRoutes: true} : {}),
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
      if (out && typeof out === "object" && typeof out.intentId === "string") remember(out.intentId, params);
      if (out && opts.verifyQuote) {
        let refusal: string | null;
        try { refusal = opts.verifyQuote(params, out); } catch (e) { refusal = e instanceof Error ? e.message : String(e); }
        if (refusal) throw new Error(`${name}: the quote fails this app's own check — ${refusal.slice(0, 240)}`);
      }
      return out;
    },
    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = await call<UnsignedTx>("build", {quote});
      if (opts.verifyBuild) {
        let refusal: string | null;
        try { refusal = await opts.verifyBuild(quote, tx, requests.get(quote.intentId)); } catch (e) { refusal = e instanceof Error ? e.message : String(e); }
        if (refusal) throw new Error(`${name}: the build fails this app's own check — ${refusal.slice(0, 240)}`);
      }
      return tx;
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
    async buildClaim(ref: IntentRef): Promise<UnsignedTx | null> {
      const out = await call<UnsignedTx | null | Record<string, never>>("claim", {ref});
      // A backend without the action (older deploy) answers {} — treat as "not ready".
      if (!out || typeof out !== "object" || !("to" in out)) return null;
      return out as UnsignedTx;
    },
    ...(opts.supportsChain ? {supportsChain: opts.supportsChain.bind(opts)} : {}),
    ...(opts.supportsChainPair ? {supportsChainPair: opts.supportsChainPair.bind(opts)} : {}),
    ...(opts.supportsSameChain !== undefined ? {supportsSameChain: opts.supportsSameChain} : {}),
    ...(opts.claimTargets ? {claimTargets: opts.claimTargets} : {}),
    ...(opts.callTargets ? {callTargets: opts.callTargets} : {}),
    ...(opts.spenders ? {spenders: opts.spenders} : {}),
  };
}
