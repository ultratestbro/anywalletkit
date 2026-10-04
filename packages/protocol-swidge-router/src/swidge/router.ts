/**
 * Aggregator swidge protocol — the piece the ecosystem is missing: every
 * published swidge module is single-provider and makes the USER pick a venue.
 * This one quotes EVERYTHING in parallel and executes the best route across
 * two kinds of sources:
 *
 *  1. Engine `CrossChainProvider`s (our near-intents/thorchain/omniston — the
 *     deposit-address/calldata model executed by {@link BaseSwidgeProtocol}).
 *  2. Any external `ISwidgeProtocol` MODULE (e.g. a venue's own
 *     published module) — quoted via
 *     its own `quoteSwidge` and, when it wins, executed via its own `swidge()`
 *     (the module signs through the account IT was constructed with).
 *
 * Status resumes against whichever source actually won: engine ids keep the
 * `awk1.<provider>.…` scheme; module ids are wrapped as `awk1.mod~<name>.<id>`.
 */
import {SwidgeExecutionError} from "@forgewallet/protocol-swidge-core/errors";
import {
  BaseSwidgeProtocol,
  type SwidgeAccount,
  type SwidgeEngineConfig,
} from "@forgewallet/protocol-swidge-core/swidge/base";
import type {CrossChainProvider, Quote, QuoteParams} from "@forgewallet/protocol-swidge-core/types";
import {CrossChainRouter} from "@forgewallet/protocol-swidge-core/router";
import type {
  SwidgeOptions,
  SwidgeProtocolConfig,
  SwidgeQuote,
  SwidgeResult,
  SwidgeStatusOptions,
  SwidgeStatusResult,
  SwidgeSupportedChain,
  SwidgeSupportedToken,
  SwidgeSupportedTokensOptions,
} from "@forgewallet/core";
import {ccAsset, ccAssetByToken, ccChain} from "@forgewallet/swidge-assets";
import {nearIntents, lifi, thorchain, omniston} from "../config.js";

/** Structural view of an ISwidgeProtocol — any published module satisfies it. */
export interface ExternalSwidgeProtocol {
  quoteSwidge(options: SwidgeOptions, signal?: AbortSignal): Promise<SwidgeQuote>;
  swidge(options: SwidgeOptions, config?: SwidgeProtocolConfig): Promise<SwidgeResult>;
  getSwidgeStatus(id: string, options?: SwidgeStatusOptions): Promise<SwidgeStatusResult>;
  getSupportedChains(): Promise<SwidgeSupportedChain[]>;
  getSupportedTokens(options?: SwidgeSupportedTokensOptions): Promise<SwidgeSupportedToken[]>;
  close?: () => void;
}

export interface ExternalSwidgeModule {
  /** Stable name for ids/status routing (e.g. "lifi"). No dots. */
  name: string;
  protocol: ExternalSwidgeProtocol;
  /**
   * Translate the aggregator's normalized options (CAIP-2 `toChain`, catalog
   * token refs) into the module's own notation — `SwidgeOptions` identifiers
   * are provider-specific by design. Default mapping converts CAIP-2
   * `eip155:<n>` toChain into the numeric chain id most EVM modules accept;
   * everything else passes through.
   */
  mapOptions?: (options: SwidgeOptions) => SwidgeOptions;
  /**
   * The account this module signs through. REQUIRED whenever the aggregator
   * itself is account-bound: a module that cannot name its account could be
   * wired to a different one, so it is never allowed to quote or execute for
   * this caller. Registering one without it on an account-bound router throws
   * at construction — see the constructor.
   */
  accountAddress?: string | (() => string | Promise<string>);
  /** Optional synchronous route gate used by auction and discovery. */
  supportsRoute?: (fromChain: string, toChain?: string | number) => boolean;
  /**
   * Derive the per-call config the WINNING quote must execute against, given
   * the quote this module returned during the auction.
   *
   * Some modules bind execution to a quote object they handed back on the
   * quote call (rhino.fi returns its raw quote on `SwidgeQuote.quote` and
   * re-fetches a fresh one unless it is passed back as `config.quote`). Without
   * this hook such a module re-prices between the auction and execution, so the
   * amount the user approved is not the amount that executes — and our
   * post-execution floor check can only notice AFTER the deposit is broadcast.
   * The returned object is merged over the caller's config.
   */
  bindQuote?: (quote: SwidgeQuote, config?: SwidgeProtocolConfig) => SwidgeProtocolConfig | undefined;
  /**
   * Normalize this module's chain identifiers (as they appear in
   * `getSupportedChains`/`getSupportedTokens`) into the aggregator's CAIP-2
   * space, so discovery unions dedup instead of listing Ethereum three times
   * ("eip155:1" from the engine, `1` from an EVM module, "ethereum" from a
   * slug-keyed one). Default: numeric/`"1"`-style ids → `eip155:<n>`.
   */
  mapChainId?: (id: string | number) => string | number;
}

const MODULE_PREFIX = "mod~";
/** A slow venue must not stall the whole auction. */
const MODULE_QUOTE_TIMEOUT_MS = 8_000;

function sameAccount(chain: string, actual: string, expected: string): boolean {
  return chain.startsWith("eip155:")
    ? actual.toLowerCase() === expected.toLowerCase()
    : actual === expected;
}

function defaultMapOptions(options: SwidgeOptions): SwidgeOptions {
  const {toChain} = options;
  if (typeof toChain === "string" && toChain.startsWith("eip155:")) {
    const id = Number(toChain.slice("eip155:".length));
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error("swidge: invalid EVM destination chain id");
    return {...options, toChain: id};
  }
  return {...options};
}

function snapshotOptions(options: SwidgeOptions): SwidgeOptions {
  return Object.freeze({...options});
}

function callerFloor(options: SwidgeOptions): bigint | undefined {
  if (options.minAmountOut === undefined) return undefined;
  const floor = BigInt(options.minAmountOut);
  if (floor <= 0n) throw new Error("swidge: minAmountOut must be a positive integer");
  return floor;
}

/**
 * A module's chain id in the aggregator's CAIP-2 space. Modules answer
 * discovery in their OWN notation — numeric EVM ids, or a venue's slugs
 * ("ethereum", "spark") — so a union without this lists one chain several
 * times under ids a caller cannot compare.
 */
function moduleChainId(module: ExternalSwidgeModule, id: string | number): string | number {
  if (module.mapChainId) return module.mapChainId(id);
  const value = String(id);
  return /^\d+$/.test(value) ? `eip155:${value}` : id;
}

/** Normalize numeric EVM chain notation before querying CAIP-2 configs. */
function discoveryCaip2(chain: string | number | undefined): string | undefined {
  if (chain === undefined) return undefined;
  const value = String(chain);
  return /^\d+$/.test(value) ? `eip155:${value}` : value;
}

/**
 * A slow or throwing module must not stall or break the auction — but it must
 * not vanish without a trace either: collapsing both into `null` made a timeout
 * and a rejected pair indistinguishable, which is why a misconfigured module
 * could only ever be diagnosed by reading its source.
 */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<{value: T} | {reason: string}> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({reason: `quote timed out after ${ms}ms`}), ms);
    p.then(
      (value) => resolve({value}),
      (e) => resolve({reason: e instanceof Error ? e.message : String(e)}),
    ).finally(() => clearTimeout(timer));
  });
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value).replace(/\./g, "%2E");
}

const FEE_TYPES = new Set(["network", "protocol", "affiliate", "other"]);
const TX_TYPES = new Set(["source", "destination", "approval", "refund", "other"]);
const STATUS_TYPES = new Set(["pending", "action-required", "completed", "failed", "refund-pending", "refunded", "cancelled", "expired", "partial"]);

function validFees(value: unknown): boolean {
  return Array.isArray(value) && value.every((raw) => {
    const fee = raw as {type?: unknown; amount?: unknown; token?: unknown; chain?: unknown; included?: unknown; description?: unknown};
    return typeof fee === "object" && fee !== null && typeof fee.type === "string" && FEE_TYPES.has(fee.type) &&
      typeof fee.amount === "bigint" && fee.amount >= 0n && typeof fee.token === "string" && fee.token.length > 0 &&
      (fee.chain === undefined || typeof fee.chain === "string" || (typeof fee.chain === "number" && Number.isSafeInteger(fee.chain))) &&
      (fee.included === undefined || typeof fee.included === "boolean") &&
      (fee.description === undefined || typeof fee.description === "string");
  });
}

function validModuleQuote(q: SwidgeQuote, options: SwidgeOptions): boolean {
  try {
    if (options.fromTokenAmount == null || q.fromTokenAmount !== BigInt(options.fromTokenAmount)) return false;
    if (q.toTokenAmount <= 0n || q.toTokenAmountMin <= 0n || q.toTokenAmountMin > q.toTokenAmount) return false;
    if (!validFees(q.fees)) return false;
    if (q.estimatedDuration !== undefined && (!Number.isFinite(q.estimatedDuration) || q.estimatedDuration < 0)) return false;
    // Price impact is signed: a NEGATIVE value is a route that pays better than
    // the reference price, and real modules report it (Symbiosis returns
    // -0.001 on ordinary stable pairs). Rejecting it dropped every such quote
    // from the auction as "malformed" — silently, since a module that sits out
    // is indistinguishable from one that had no route.
    if (q.priceImpact !== undefined && (!Number.isFinite(q.priceImpact) || q.priceImpact < -1 || q.priceImpact > 1)) return false;
    if (q.expiry !== undefined && (!Number.isSafeInteger(q.expiry) || q.expiry <= Math.floor(Date.now() / 1000))) return false;
    const floor = callerFloor(options);
    if (floor !== undefined && q.toTokenAmountMin < floor) return false;
    if (options.slippage !== undefined) {
      if (!Number.isFinite(options.slippage) || options.slippage < 0 || options.slippage >= 1) return false;
      const scale = 1_000_000_000n;
      const permitted = BigInt(Math.floor(options.slippage * Number(scale)));
      const required = (q.toTokenAmount * (scale - permitted) + scale - 1n) / scale;
      if (q.toTokenAmountMin < required) return false;
    }
    return true;
  } catch { return false; }
}

function validModuleResult(result: SwidgeResult): boolean {
  try {
    if (typeof result.id !== "string" || result.id.length === 0 || !validFees(result.fees)) return false;
    if (result.hash !== undefined && (typeof result.hash !== "string" || result.hash.length === 0)) return false;
    if (result.transactions !== undefined && (!Array.isArray(result.transactions) || !result.transactions.every((raw) => {
      const tx = raw as {hash?: unknown; chain?: unknown; type?: unknown};
      return typeof tx === "object" && tx !== null && typeof tx.hash === "string" && tx.hash.length > 0 &&
        (tx.chain === undefined || typeof tx.chain === "string" || (typeof tx.chain === "number" && Number.isSafeInteger(tx.chain))) &&
        (tx.type === undefined || (typeof tx.type === "string" && TX_TYPES.has(tx.type)));
    }))) return false;
    return typeof result.fromTokenAmount === "bigint" && typeof result.toTokenAmount === "bigint" &&
      (result.toTokenAmountMin === undefined || typeof result.toTokenAmountMin === "bigint");
  } catch { return false; }
}

function validModuleStatus(result: SwidgeStatusResult): boolean {
  if (!result || typeof result !== "object" || typeof result.status !== "string" || !STATUS_TYPES.has(result.status)) return false;
  if (result.transactions === undefined) return true;
  return Array.isArray(result.transactions) && result.transactions.every((raw) => {
    const tx = raw as {hash?: unknown; chain?: unknown; type?: unknown};
    return typeof tx === "object" && tx !== null && typeof tx.hash === "string" && tx.hash.length > 0 &&
      (tx.chain === undefined || typeof tx.chain === "string" || (typeof tx.chain === "number" && Number.isSafeInteger(tx.chain))) &&
      (tx.type === undefined || (typeof tx.type === "string" && TX_TYPES.has(tx.type)));
  });
}

export interface RouterSwidgeConfig extends SwidgeEngineConfig {
  /**
   * The engine router to aggregate over — REQUIRED (no singleton default) so
   * bundlers can tree-shake the providers a context doesn't use: a browser
   * worker passes `new CrossChainRouter([remoteProvider(...)])`, the server
   * passes its `crossChainRouter()` engine singleton.
   */
  router: CrossChainRouter;
  /** External swidge modules to include in the auction. */
  modules?: ExternalSwidgeModule[];
  /**
   * Called when a module leaves the auction, with the reason. Diagnostics only:
   * every skip is still fail-closed and silent to the caller, but without this
   * an unregistered module, a foreign account, a rejected quote and a timeout
   * are one indistinguishable absence — which is exactly how a module that
   * quotes for display and vanishes at execution stays invisible. Never called
   * with caller funds at stake; throwing from it cannot affect a route.
   */
  onModuleSkipped?: (name: string, reason: string) => void;
  /**
   * Spot USD price by catalog SYMBOL, for a like-for-like auction. Candidates
   * are ranked on the guaranteed output NET of venue fees charged on top
   * (`fees[].included === false`, e.g. USDT0's bridge fee in native ETH):
   * a fee in the destination token is subtracted directly, one in the source
   * token at the candidate's own guaranteed rate, anything else through this
   * hook. Without the hook such fees cannot be priced and are ignored — the
   * pre-2026-09 behaviour, where a 1:1 bridge could "win" a dust-sized swap
   * while charging more in gas-token fees than the rival's whole spread.
   * With the hook, a candidate whose fee it cannot price sits out (reported
   * through onModuleSkipped) rather than being compared as if free.
   * Network (gas) fees are never subtracted: every source-chain candidate
   * pays gas and only some itemize it.
   */
  priceUsd?: (symbol: string) => number | undefined;
}

/** Normalize a `toChain` (number chainId | CAIP-2 | numeric string) to CAIP-2. */
function toCaip2(chain: string | number | undefined, fallback: string): string {
  if (chain === undefined || chain === null || chain === "") return fallback;
  if (typeof chain === "number") return `eip155:${chain}`;
  return /^\d+$/.test(chain) ? `eip155:${chain}` : chain;
}

/** Resolve a fee's token (catalog symbol, "native", or on-chain address) on a chain. */
function feeAsset(chain: string, token: string): {symbol: string; decimals: number} | undefined {
  const native = ccChain(chain)?.assets.find((a) => !a.contract);
  if (token === "native" || /^0x0+$/.test(token)) return native;
  return ccAsset(chain, token) ?? ccAssetByToken(chain, token);
}

export class RouterSwidgeProtocol extends BaseSwidgeProtocol {
  private readonly router: CrossChainRouter;
  private readonly modules: ExternalSwidgeModule[];
  private readonly onModuleSkipped: (name: string, reason: string) => void;
  private readonly priceUsd: ((symbol: string) => number | undefined) | undefined;

  constructor(account: SwidgeAccount | undefined, config: RouterSwidgeConfig) {
    super(account, config);
    this.router = config.router;
    this.priceUsd = config.priceUsd;
    const notify = config.onModuleSkipped;
    this.onModuleSkipped = notify
      ? (name, reason) => { try { notify(name, reason); } catch { /* diagnostics must not alter routing */ } }
      : () => {};
    const modules = config.modules ?? [];
    const names = new Set<string>();
    for (const module of modules) {
      if (!module.name || /[.|]/.test(module.name) || names.has(module.name)) {
        throw new Error(`swidge: invalid or duplicate external module name '${module.name}'`);
      }
      names.add(module.name);
      // Reject at wiring time rather than dropping it from the auction later:
      // an account-bound router excludes such a module, so the alternative is a
      // module that quotes while unbound (display) and silently disappears once
      // a wallet is attached (execution) — a difference no test that quotes
      // will ever show. Status-only registrations belong on a router with no
      // account, which is all status resolution needs.
      if (account && !module.accountAddress) {
        throw new Error(
          `swidge: external module '${module.name}' must declare accountAddress to be registered on an account-bound router`,
        );
      }
    }
    this.modules = modules.map((module) => {
      const protocol = module.protocol;
      return {
        name: module.name,
        protocol: {
          quoteSwidge: protocol.quoteSwidge.bind(protocol),
          swidge: protocol.swidge.bind(protocol),
          getSwidgeStatus: protocol.getSwidgeStatus.bind(protocol),
          getSupportedChains: protocol.getSupportedChains.bind(protocol),
          getSupportedTokens: protocol.getSupportedTokens.bind(protocol),
          ...(protocol.close ? {close: protocol.close.bind(protocol)} : {}),
        },
        ...(module.mapOptions ? {mapOptions: module.mapOptions.bind(module)} : {}),
        ...(module.accountAddress
          ? {accountAddress: typeof module.accountAddress === "function" ? module.accountAddress.bind(module) : module.accountAddress}
          : {}),
        ...(module.supportsRoute ? {supportsRoute: module.supportsRoute.bind(module)} : {}),
        ...(module.bindQuote ? {bindQuote: module.bindQuote.bind(module)} : {}),
        ...(module.mapChainId ? {mapChainId: module.mapChainId.bind(module)} : {}),
      };
    });
  }

  protected resolveQuote(params: QuoteParams): Promise<Quote | null> {
    return this.router.getBestQuote(params);
  }

  protected override noRouteDetail(): string {
    return this.router.lastRejections.join("; ").slice(0, 400);
  }

  protected providerFor(name: string): CrossChainProvider | undefined {
    return this.router.getProvider(name);
  }

  protected chainSupported(caip2: string): boolean {
    return (
      (this.router.hasEnabledProvider("near_intents") && (nearIntents.supports(caip2, "eip155:1") || nearIntents.supports("eip155:1", caip2))) ||
      (this.router.hasEnabledProvider("lifi") && caip2 !== "solana:mainnet" && lifi.supportsChain(caip2)) ||
      (this.router.hasEnabledProvider("thorchain") && thorchain.supportsChain(caip2)) ||
      (this.router.hasEnabledProvider("omniston") && omniston.supportsChain(caip2)) ||
      this.router.supportsChain(caip2)
    );
  }

  /** Quote every external module in parallel; failures/timeouts drop out. */
  private async moduleQuotes(
    options: SwidgeOptions,
    config?: SwidgeProtocolConfig,
  ): Promise<{module: ExternalSwidgeModule; quote: SwidgeQuote; mapped: SwidgeOptions}[]> {
    const results = await Promise.all(
      this.modules.map(async (module) => {
        try {
          if (this._account && !module.accountAddress) {
            this.onModuleSkipped(module.name, "no accountAddress on an account-bound router");
            return null;
          }
          if (module.supportsRoute && !module.supportsRoute(this.fromChain, options.toChain)) {
            this.onModuleSkipped(module.name, "supportsRoute declined the pair");
            return null;
          }
          const mapped = snapshotOptions((module.mapOptions ?? defaultMapOptions)(snapshotOptions(options)));
          const controller = new AbortController();
          const outcome = await withTimeout(module.protocol.quoteSwidge(mapped, controller.signal), MODULE_QUOTE_TIMEOUT_MS);
          controller.abort();
          if ("reason" in outcome) {
            this.onModuleSkipped(module.name, outcome.reason);
            return null;
          }
          const quote = outcome.value;
          if (!quote || !validModuleQuote(quote, options)) {
            this.onModuleSkipped(module.name, quote ? "quote failed validation" : "no quote returned");
            return null;
          }
          this.assertFeeCaps(quote.fees, quote.fromTokenAmount, mapped.fromToken, config);
          return {module, quote, mapped};
        } catch (e) {
          this.onModuleSkipped(module.name, e instanceof Error ? e.message : String(e));
          return null;
        }
      }),
    );
    return results.filter((r): r is {module: ExternalSwidgeModule; quote: SwidgeQuote; mapped: SwidgeOptions} => r !== null);
  }

  /**
   * The auction's yardstick: guaranteed output minus the venue's own fees
   * charged ON TOP, in destination base units. `null` = a fee could not be
   * priced although a price hook is configured (the candidate must sit out).
   */
  private netGuaranteed(quote: SwidgeQuote, options: SwidgeOptions): bigint | null {
    let net = quote.toTokenAmountMin;
    const extras = (quote.fees ?? []).filter((fee) => fee.included === false && fee.type !== "network" && fee.amount > 0n);
    if (extras.length === 0) return net;
    const destChain = toCaip2(options.toChain, this.fromChain);
    const dest = ccAssetByToken(destChain, options.toToken) ?? ccAsset(destChain, options.toToken);
    const source = ccAsset(this.fromChain, options.fromToken);
    for (const fee of extras) {
      const chain = toCaip2(fee.chain, this.fromChain);
      const asset = feeAsset(chain, fee.token);
      let inDest: bigint | undefined;
      if (asset && dest && asset.symbol === dest.symbol) {
        inDest = (fee.amount * 10n ** BigInt(dest.decimals)) / 10n ** BigInt(asset.decimals);
      } else if (asset && source && chain === this.fromChain && asset.symbol === source.symbol && quote.fromTokenAmount > 0n) {
        inDest = (fee.amount * quote.toTokenAmountMin) / quote.fromTokenAmount;
      } else if (this.priceUsd && asset && dest) {
        const feePrice = this.priceUsd(asset.symbol);
        const destPrice = this.priceUsd(dest.symbol);
        if (typeof feePrice === "number" && typeof destPrice === "number" && feePrice > 0 && destPrice > 0) {
          const usd = (Number(fee.amount) / 10 ** asset.decimals) * feePrice;
          const units = (usd / destPrice) * 10 ** dest.decimals;
          if (Number.isFinite(units)) inDest = BigInt(Math.ceil(units));
        }
      }
      if (inDest === undefined) {
        if (this.priceUsd) return null; // opted into net comparison: an unpriced fee must not read as free
        continue; // no price hook: nothing to compare it with — legacy gross comparison
      }
      net -= inDest;
    }
    return net < 0n ? 0n : net;
  }

  /** Rank module candidates by net guaranteed output; unpriceable ones sit out. */
  private rankModules<T extends {module: ExternalSwidgeModule; quote: SwidgeQuote}>(mods: T[], options: SwidgeOptions): {best: T; net: bigint} | null {
    let best: {best: T; net: bigint} | null = null;
    for (const m of mods) {
      const net = this.netGuaranteed(m.quote, options);
      if (net === null) {
        this.onModuleSkipped(m.module.name, "a fee charged on top cannot be priced for a net comparison");
        continue;
      }
      if (!best || net > best.net) best = {best: m, net};
    }
    return best;
  }

  /** All candidates quote the SAME options → net guaranteed output is comparable. */
  override async quoteSwidge(options: SwidgeOptions): Promise<SwidgeQuote> {
    const snapshot = snapshotOptions(options);
    const [engine, mods] = await Promise.all([
      super.quoteSwidge(snapshot).catch(() => null),
      this.moduleQuotes(snapshot),
    ]);
    const bestModule = this.rankModules(mods, snapshot);
    // The engine's fees are netted into its floor already; an unpriceable
    // extra (none of our providers report one) falls back to gross.
    const engineNet = engine ? (this.netGuaranteed(engine, snapshot) ?? engine.toTokenAmountMin) : null;
    if (engine && engineNet !== null && (!bestModule || engineNet >= bestModule.net)) return engine;
    if (!bestModule) throw new Error("swidge: no route available for the requested pair");
    return bestModule.best.quote;
  }

  override async swidge(options: SwidgeOptions, config?: SwidgeProtocolConfig): Promise<SwidgeResult> {
    // Account first, before any option is validated (SDK protocol conformance):
    // without external modules only the engine can execute, and the engine needs a
    // signing account. External modules sign through the account THEY were built
    // with, so with modules configured a read-only/missing account here is allowed.
    const signer = this._account as {sendTransaction?: unknown} | undefined;
    const hasModules = ((this._config as RouterSwidgeConfig).modules?.length ?? 0) > 0;
    if (!hasModules && (!signer || typeof signer.sendTransaction !== "function")) {
      throw new SwidgeExecutionError("swidge: swidge() requires a signing account (read-only accounts can only quote)");
    }
    const snapshot = snapshotOptions(options);
    const configSnapshot = config ? Object.freeze({...config}) : undefined;
    // Fee caps apply to the whole auction. If providers cannot prove a signed
    // breakdown, reject before either the engine or a module is allowed to win.
    this.assertFeeConfig(configSnapshot);
    // Validate eagerly instead of allowing invalid mutable input to disappear
    // into a failed venue and silently select another one.
    if (snapshot.minAmountOut === undefined) {
      throw new Error("swidge: swidge() requires caller-supplied minAmountOut");
    }
    callerFloor(snapshot);
    // Run the auction: the engine's best quote vs every module's quote.
    const [engineQuote, mods] = await Promise.all([
      this.modules.length
        ? super.quoteSwidge(snapshot).then((quote) => {
            this.assertFeeCaps(quote.fees, quote.fromTokenAmount, snapshot.fromToken, configSnapshot);
            return quote;
          }).catch(() => null)
        : null,
      this.moduleQuotes(snapshot, configSnapshot),
    ]);
    const ranked = this.rankModules(mods, snapshot);
    const engineNet = engineQuote ? (this.netGuaranteed(engineQuote, snapshot) ?? engineQuote.toTokenAmountMin) : null;

    // Engine wins (or no modules configured): the base flow executes it —
    // it re-resolves the engine quote internally, keeping ids/guards intact.
    if (!ranked || (engineNet !== null && engineNet >= ranked.net)) {
      return super.swidge(snapshot, configSnapshot);
    }
    const bestModule = ranked.best;

    // A module wins: IT executes (signing through its own bound account), and
    // the id is wrapped so status calls route back to it.
    if (bestModule.module.accountAddress && this._account) {
      const expected = typeof bestModule.module.accountAddress === "function"
        ? await bestModule.module.accountAddress()
        : bestModule.module.accountAddress;
      const actual = await (this._account as {getAddress?: () => string | Promise<string>}).getAddress?.();
      if (!actual || !sameAccount(this.fromChain, actual, expected)) {
        throw new Error(`swidge: external module '${bestModule.module.name}' is bound to a different account`);
      }
    }
    if (bestModule.quote.expiry !== undefined && bestModule.quote.expiry <= Math.floor(Date.now() / 1000)) {
      throw new Error(`swidge: external module '${bestModule.module.name}' quote expired before execution`);
    }
    // Execute the exact mapped snapshot that was quoted. Calling a stateful or
    // mutable mapOptions hook a second time was a quote→execute TOCTOU gap.
    // `bindQuote` closes the same gap on the module's own side: a module that
    // re-prices unless handed its auction quote back would otherwise execute
    // against a market that moved since the user approved the number.
    const execConfig = bestModule.module.bindQuote
      ? {...configSnapshot, ...bestModule.module.bindQuote(bestModule.quote, configSnapshot)}
      : configSnapshot;
    // A module signs through its own account; the finest we can report is
    // "signing" until it returns with a hash.
    this.emitPhase("signing");
    const result = await bestModule.module.protocol.swidge(bestModule.mapped, execConfig);
    if (result?.hash) this.emitPhase("broadcast", {hash: result.hash});
    if (!validModuleResult(result)) {
      throw new Error(`swidge: external module '${bestModule.module.name}' returned a malformed execution result`);
    }
    const floor = callerFloor(snapshot);
    const resultMin = result.toTokenAmountMin ?? result.toTokenAmount;
    if (
      result.fromTokenAmount !== bestModule.quote.fromTokenAmount ||
      result.toTokenAmount <= 0n ||
      resultMin <= 0n ||
      resultMin > result.toTokenAmount ||
      resultMin < bestModule.quote.toTokenAmountMin
    ) {
      throw new Error(`swidge: external module '${bestModule.module.name}' returned an execution result below its quote`);
    }
    if (floor !== undefined && resultMin < floor) {
      throw new Error(`swidge: external module '${bestModule.module.name}' executed below caller minAmountOut`);
    }
    this.assertFeeCaps(result.fees, result.fromTokenAmount, bestModule.mapped.fromToken, configSnapshot);
    return {
      ...result,
      id: `awk1.${MODULE_PREFIX}${encodeSegment(bestModule.module.name)}.${encodeSegment(result.id)}`,
    };
  }

  override async getSwidgeStatus(id: string, options?: SwidgeStatusOptions): Promise<SwidgeStatusResult> {
    if (id.startsWith(`awk1.${MODULE_PREFIX}`)) {
      let name: string;
      let inner: string;
      try {
        const parts = id.slice("awk1.".length).split(".");
        if (parts.length !== 2 || !parts[0]?.startsWith(MODULE_PREFIX) || !parts[1]) throw new Error("invalid id shape");
        name = decodeURIComponent(parts[0].slice(MODULE_PREFIX.length));
        inner = decodeURIComponent(parts[1]);
        if (!name || !inner) throw new Error("empty id segment");
      } catch {
        throw new Error("swidge: malformed external-module status id");
      }
      const module = this.modules.find((m) => m.name === name);
      if (!module) throw new Error(`swidge: module '${name}' is not registered`);
      const status = await module.protocol.getSwidgeStatus(inner, options);
      if (!validModuleStatus(status)) throw new Error(`swidge: external module '${name}' returned a malformed status`);
      return status;
    }
    return super.getSwidgeStatus(id, options);
  }

  override async getSupportedChains(): Promise<SwidgeSupportedChain[]> {
    const discoverable = this.modules.filter((m) => !this._account || !!m.accountAddress);
    const lists = await Promise.all([
      super.getSupportedChains(),
      ...discoverable.map((m) =>
        m.protocol
          .getSupportedChains()
          .then((chains) => chains.map((c) => ({...c, id: moduleChainId(m, c.id)})))
          .catch(() => [] as SwidgeSupportedChain[]),
      ),
    ]);
    const seen = new Set<string>();
    return lists.flat().filter((c) => {
      const key = String(c.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  override async getSupportedTokens(options?: SwidgeSupportedTokensOptions): Promise<SwidgeSupportedToken[]> {
    const from = options?.fromChain == null ? undefined : discoveryCaip2(options.fromChain);
    const to = options?.toChain == null ? undefined : discoveryCaip2(options.toChain);
    const enginePairSupported = !from || !to ||
      this.router.supportsChainPair(from, to) ||
      (this.router.hasEnabledProvider("near_intents") && nearIntents.supports(from, to)) ||
      (this.router.hasEnabledProvider("lifi") && lifi.supports(from, to)) ||
      (this.router.hasEnabledProvider("thorchain") && thorchain.supports(from, to)) ||
      (this.router.hasEnabledProvider("omniston") && omniston.supports(from, to));
    const eligibleModules = this.modules.filter((m) => {
      if (this._account && !m.accountAddress) return false;
      if (!m.supportsRoute) return true;
      try { return m.supportsRoute(this.fromChain, options?.toChain); } catch { return false; }
    });
    const lists = await Promise.all([
      enginePairSupported ? super.getSupportedTokens(options) : Promise.resolve([] as SwidgeSupportedToken[]),
      ...eligibleModules.map((m) =>
        m.protocol
          .getSupportedTokens(options)
          .then((tokens) => tokens.map((t) => ({...t, chain: moduleChainId(m, t.chain)})))
          .catch(() => [] as SwidgeSupportedToken[]),
      ),
    ]);
    const seen = new Set<string>();
    return lists.flat().filter((t) => {
      const key = `${t.chain}:${t.token}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  close(): void {
    this.router.close();
    for (const module of this.modules) module.protocol.close?.();
  }
}
