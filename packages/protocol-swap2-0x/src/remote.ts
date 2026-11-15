/**
 * The app's side of 0x when the API key stays on a server.
 *
 * `zeroExRemoteProvider({baseUrl, rpcUrls})` forwards quotes and builds to your backend (which runs
 * `zeroExProvider` with the key) and checks, on the device, everything that comes back before the
 * engine signs: the Settler from the on-chain registry read through the app's own RPC, the
 * transaction and the Permit2 payload held to the request the app itself sent
 * ({@link zeroExVerifyQuote} on the quote, {@link zeroExVerifyBuild} on the build), and, right
 * before the broadcast, the registry read once more ({@link zeroExPreflightDeposit}) ahead of the
 * backend's own preflight. The backend is what these checks guard against; it never names its own
 * Settler, spender, recipient or minimum.
 *
 * Every text the verifiers return is classified (`zeroExPins.reasonOf`, CS-13), so a remote stub's
 * refusal carries its `Swap2RefusalReason`; the app's own malformed request stays unclassified.
 */
import {getAddress} from "viem";
import {refusalNotes, refusalOf, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {remoteProvider, type RemoteProviderOptions} from "@anywalletkit/protocol-swap2-core/remote";
import {sourceAssetOf} from "@anywalletkit/protocol-swap2-core/util";
import {slippageFloor} from "@anywalletkit/protocol-swap2-core/validate";
import type {CrossChainProvider, Quote, QuoteParams, RemotePins, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {describeZeroExActivity} from "./activity.js";
import {ZEROEX_NATIVE, ZEROEX_PERMIT2, zeroExChain, zeroExChainId, zeroExChains, type ZeroExChain} from "./chains.js";
import {ZEROEX_PROVIDER, zeroExPreflightDeposit} from "./provider.js";
import type {RpcUrls} from "./rpc.js";
import {ZEROEX_MAX_NATIVE_QUOTE_SECONDS, checkZeroExTransaction, createSettlerResolver, isZeroExNative, type SettlerResolver} from "./settler.js";

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const same = (a: string, b: string): boolean => a.length === b.length && a.toLowerCase() === b.toLowerCase();
const uint = (v: unknown): bigint | null => (typeof v === "string" && /^[0-9]{1,78}$/.test(v) ? BigInt(v) : null);
const message = (e: unknown, fallback: string): string => (e instanceof Error ? e.message.replace(/^zeroex: /, "") : fallback);

/** The reason behind each text {@link zeroExVerifyQuote} / {@link zeroExVerifyBuild} return (`zeroExPins.reasonOf`). */
const notes = refusalNotes();
/** A verifier's answer: the text, its reason remembered (none: the app's own malformed request). */
const note = (text: string, reason?: Swap2RefusalReason): string =>
  // Noted without a valid reason, a text is unclassified (and forgets any earlier classification of the same text).
  notes.note(text, reason ?? ({} as Swap2RefusalReason));
/** A refusal raised by the checks: its text without the prefix, and the reason it carries. */
const noteError = (e: unknown, fallback: string): string => note(message(e, fallback), refusalOf(e)?.reason ?? "policy_refused");

/** The reason a text from {@link zeroExVerifyQuote} or {@link zeroExVerifyBuild} carries; undefined for any other text. */
export const zeroExRefusalReason = (text: string) => notes.reasonOf(text);

export interface ZeroExVerifyContext {
  /** The chain table in force. */
  chains: Readonly<Record<number, ZeroExChain>>;
  /** Settlers the app resolved from the registry for a chain (never the backend's word). */
  settlers(chainId: number): readonly string[];
  /** The most slippage accepted when the request named none, bps. Default 50 — the provider's own default. */
  defaultSlippageBps?: number | undefined;
  /** Clock (tests). */
  nowMs?: number | undefined;
}

/**
 * A remote 0x quote, held to the request the app sent. Null when it passes, the reason otherwise.
 *
 * An indicative quote (`dry`) carries no transaction and only its amounts are checked. A live quote must carry one,
 * and it goes through {@link checkZeroExTransaction} with an expectation built only from `params`: the sell token and
 * amount, the buy token, the app's recipient, the quote's minimum (itself held to the requested slippage and floor),
 * the chain's pins and the Settlers the app resolved. It may stay valid no longer than its Permit2 deadline (a token
 * sale) or {@link ZEROEX_MAX_NATIVE_QUOTE_SECONDS} from now (a native-coin sale).
 */
export function zeroExVerifyQuote(params: QuoteParams, quote: Quote, ctx: ZeroExVerifyContext): string | null {
  if (quote.provider !== ZEROEX_PROVIDER) return note("the quote is not a 0x quote", "policy_refused");
  if (params.sourceChain !== params.destChain) return note("0x swaps stay on one chain", "unsupported_pair");
  const chainId = zeroExChainId(params.sourceChain);
  const chain = zeroExChain(ctx.chains, chainId);
  if (!chain) return note("the chain is not in the 0x chain table", "unsupported_pair");
  if (quote.intentId.replace(/~[0-9a-f]{32}$/, "").split(":").slice(0, 2).join(":") !== `zeroex:${chainId}`) return note("the intent id does not name this chain", "policy_refused");
  const src = sourceAssetOf(params);
  if (!src) return note("unknown source token");
  if (src.contract && !ADDRESS.test(src.contract)) return note("the source token is not an EVM address");
  if (typeof params.destToken !== "string" || !ADDRESS.test(params.destToken)) return note("the destination token is not an EVM address");
  const sellToken = src.contract ? getAddress(src.contract) : ZEROEX_NATIVE;
  const buyToken = isZeroExNative(params.destToken) ? ZEROEX_NATIVE : getAddress(params.destToken);

  const amountIn = uint(params.amountIn);
  const quotedIn = uint(quote.sourceAmount);
  const dest = uint(quote.destAmount);
  const min = uint(quote.minDestAmount);
  if (amountIn === null || quotedIn === null || dest === null || min === null) return note("the quote's amounts are not integers", amountIn === null ? undefined : "upstream_unavailable");
  if (quotedIn !== amountIn) return note(`the quote spends ${quotedIn}, not the ${amountIn} input`, "policy_refused");
  if (min <= 0n || min > dest) return note("the quoted minimum is not between zero and the quoted output", "price_check_failed");
  const bps = params.slippageBps ?? ctx.defaultSlippageBps ?? 50;
  if (!Number.isInteger(bps) || bps < 0 || bps >= 10_000) return note("invalid slippage");
  if (min < slippageFloor(dest, bps)) return note(`the quoted minimum ${min} is below ${bps} bps of the quoted output`, "price_check_failed");
  if (params.minAmountOut !== undefined) {
    const floor = uint(params.minAmountOut);
    if (floor === null || min < floor) return note(`the quoted minimum ${min} is below the caller's floor`, floor === null ? undefined : "price_check_failed");
  }

  const tx = quote.txRequest;
  const dry = params.dry !== false;
  if (!tx) return dry ? null : note("a live quote carries no transaction", "upstream_unavailable");
  if (dry) return note("an indicative quote carries a transaction", "policy_refused");
  if (tx.serializedTx !== undefined || tx.nativeFee !== undefined) return note("the quote carries more than a Settler call", "policy_refused");
  if (typeof params.destAddress !== "string" || !ADDRESS.test(params.destAddress)) return note("a live quote needs the recipient", "recipient_mismatch");
  try {
    const checked = checkZeroExTransaction(tx, {
      chainId,
      chain,
      settlers: ctx.settlers(chainId),
      sellToken,
      buyToken,
      sellAmount: amountIn,
      recipient: params.destAddress,
      minBuyAmount: min,
      ...(ctx.nowMs !== undefined ? {nowMs: ctx.nowMs} : {}),
    });
    // The quote must lapse before the signature it asks for does; a native sale, which signs nothing, within a short window.
    if (checked.permit2 && !(Number.isFinite(quote.validUntilMs) && BigInt(Math.ceil(quote.validUntilMs)) <= checked.permit2.deadline * 1000n)) return note("the quote outlives its Permit2 deadline", "policy_refused");
    if (!checked.permit2 && !(Number.isFinite(quote.validUntilMs) && quote.validUntilMs <= (ctx.nowMs ?? Date.now()) + ZEROEX_MAX_NATIVE_QUOTE_SECONDS * 1000)) {
      return note(`the native-coin sale's quote is valid for more than ${ZEROEX_MAX_NATIVE_QUOTE_SECONDS} s`, "policy_refused");
    }
  } catch (e) {
    return noteError(e, "the transaction is refused");
  }
  return null;
}

/**
 * A remote 0x build, held to its quote and to the request: the built transaction must be the quote's own (target,
 * data, value, chain, allowance target, Permit2 payload), and that quote must pass {@link zeroExVerifyQuote} again
 * against Settlers read from the registry just now. Without the request (`params`) nothing can be checked: refused.
 */
export async function zeroExVerifyBuild(quote: Quote, tx: UnsignedTx, params: QuoteParams | undefined, ctx: ZeroExVerifyContext & {resolver: SettlerResolver}): Promise<string | null> {
  if (!params) return note("the request this quote answered is not known to the app", "policy_refused");
  const quoted = quote.txRequest;
  if (!quoted?.to || !quoted.data) return note("the quote carries no transaction", "policy_refused");
  if (
    typeof tx.to !== "string" || typeof tx.data !== "string" || !same(tx.to, quoted.to) || !same(tx.data, quoted.data) ||
    uint(tx.value || "0") === null || uint(tx.value || "0") !== uint(quoted.value ?? "0") ||
    (tx.chainId !== undefined && tx.chainId !== quoted.chainId) ||
    tx.approvalAddress !== quoted.approvalAddress || tx.permit2Transfer !== quoted.permit2Transfer || tx.gasLimit !== quoted.gasLimit ||
    tx.serializedTx !== undefined || tx.typedData !== undefined || tx.memo !== undefined
  ) {
    return note("the built transaction is not the quoted swap", "policy_refused");
  }
  let settlers: readonly string[];
  try {
    settlers = await ctx.resolver.resolve(zeroExChainId(params.sourceChain), {fresh: true});
  } catch (e) {
    return noteError(e, "the 0x Settler cannot be resolved");
  }
  return zeroExVerifyQuote({...params, dry: false}, quote, {...ctx, settlers: () => settlers});
}

export interface ZeroExPinsConfig {
  chains?: Readonly<Record<number, ZeroExChain | null>> | undefined;
  /** JSON-RPC endpoints per EVM chain id — the app's own, for the Settler registry read. */
  rpcUrls?: RpcUrls | undefined;
  settlerMaxAgeMs?: number | undefined;
  settlerResolver?: SettlerResolver | undefined;
  /** The most slippage accepted when a request names none, bps. Default 50; keep it in step with the backend's default. */
  defaultSlippageBps?: number | undefined;
}

/**
 * The app's pins for a remote 0x provider. Unlike a provider with one fixed router, the call target is whatever the
 * registry names now, so the pins hold a resolver: `callTargets` answers from its last fresh read (empty until one is
 * made — use {@link zeroExRemoteProvider}, which reads before every live quote and build), `spenders` is canonical
 * Permit2 and nothing else. `reasonOf` classifies every text the verifiers return.
 *
 * For a signing policy's known Permit2 spenders (wallet-evm `describeTypedData({knownSpenders})`, a kit allowlist)
 * use {@link zeroExKnownSpenders} with the provider the app swaps through: the Settler rotates, so no static table can
 * hold it, and a fresh `zeroExPins()` has a resolver of its own that has read nothing yet.
 */
export function zeroExPins(config: ZeroExPinsConfig = {}): RemotePins & {resolver: SettlerResolver; chains: Readonly<Record<number, ZeroExChain>>} {
  const chains = zeroExChains(config.chains);
  const resolver = config.settlerResolver ?? createSettlerResolver({chains, rpcUrls: config.rpcUrls, maxAgeMs: config.settlerMaxAgeMs});
  const ctx: ZeroExVerifyContext = {chains, settlers: (chainId) => resolver.known(chainId), defaultSlippageBps: config.defaultSlippageBps};
  return Object.freeze({
    resolver,
    chains,
    callTargets: (chain: string): readonly string[] => (zeroExChain(chains, zeroExChainId(chain)) ? resolver.known(zeroExChainId(chain)) : []),
    spenders: (chain: string): readonly string[] => (zeroExChain(chains, zeroExChainId(chain)) ? [ZEROEX_PERMIT2] : []),
    verifyQuote: (params: QuoteParams, quote: Quote) => zeroExVerifyQuote(params, quote, ctx),
    verifyBuild: (quote: Quote, tx: UnsignedTx, params?: QuoteParams) => zeroExVerifyBuild(quote, tx, params, {...ctx, resolver}),
    reasonOf: zeroExRefusalReason,
  });
}

export interface ZeroExRemoteOptions extends ZeroExPinsConfig, Pick<RemoteProviderOptions, "baseUrl" | "enabled" | "fetchImpl" | "headers" | "timeoutMs" | "allowInsecureBaseUrl"> {}

/** What {@link zeroExRemoteProvider} returns: a remote swap2 provider, plus the Settler resolver it reads through. */
export type ZeroExRemoteProvider = CrossChainProvider & {readonly ownGasEstimate: true; readonly settlerResolver: SettlerResolver};

/** How long a live quote's Settler set stays a call target after the quote, at most (its own `validUntilMs` first). */
const QUOTED_SET_MAX_MS = 120_000;

/**
 * 0x through your backend: `remoteProvider` with {@link zeroExPins}, plus the registry reads the pins need — the
 * Settler is resolved through the app's RPC before a live quote is asked for (and once more, fresh, if the backend
 * quotes a Settler the app has not seen yet), and the quote is held to exactly that set, however long the backend
 * takes to answer; right before the broadcast `preflightDeposit` reads the registry again on the device and refuses a
 * Settler no longer in it ({@link zeroExPreflightDeposit}), then asks the backend's preflight. Indicative quotes need
 * no RPC. `settlerResolver` is the resolver it reads through (signing policies: {@link zeroExKnownSpenders}).
 */
export function zeroExRemoteProvider(options: ZeroExRemoteOptions): ZeroExRemoteProvider {
  const pins = zeroExPins(options);
  const served = (caip2: string): boolean => !!zeroExChain(pins.chains, zeroExChainId(caip2));
  // The Settlers each live quote request was resolved against, by request: the verifier holds the backend's answer to
  // that set, not to whatever the resolver's cache holds once the backend answered (its max age may pass meanwhile).
  const checkedAgainst = new WeakMap<QuoteParams, readonly string[]>();
  // …and, per chain, while that quote may still be used: the router's pin check (callTargets) runs after the answer too.
  const quoted = new Map<number, {settlers: readonly string[]; untilMs: number}>();
  const callTargets = (chain: string): readonly string[] => {
    const chainId = zeroExChainId(chain);
    const known = pins.callTargets(chain);
    const held = quoted.get(chainId);
    if (!held || held.untilMs < Date.now() || !zeroExChain(pins.chains, chainId)) return known;
    return [...known, ...held.settlers.filter((s) => !known.some((k) => same(k, s)))];
  };
  const verifyCtx: ZeroExVerifyContext = {chains: pins.chains, settlers: (chainId) => pins.resolver.known(chainId), defaultSlippageBps: options.defaultSlippageBps};
  const inner = remoteProvider({
    name: ZEROEX_PROVIDER,
    baseUrl: options.baseUrl,
    supportsSameChain: true,
    supportsChain: served,
    supportsChainPair: (from, to) => from === to && served(from),
    supportsRoute: (from, to) => from.chain === to.chain && served(from.chain),
    callTargets,
    spenders: pins.spenders,
    verifyQuote: (params, quote) => {
      const set = checkedAgainst.get(params);
      return zeroExVerifyQuote(params, quote, set ? {...verifyCtx, settlers: () => set} : verifyCtx);
    },
    verifyBuild: pins.verifyBuild!,
    reasonOf: pins.reasonOf!,
    ...(options.enabled ? {enabled: options.enabled} : {}),
    ...(options.fetchImpl ? {fetchImpl: options.fetchImpl} : {}),
    ...(options.headers ? {headers: options.headers} : {}),
    ...(options.timeoutMs !== undefined ? {timeoutMs: options.timeoutMs} : {}),
    ...(options.allowInsecureBaseUrl !== undefined ? {allowInsecureBaseUrl: options.allowInsecureBaseUrl} : {}),
  });
  return {
    ...inner,
    describeActivity: describeZeroExActivity,
    // The quoted gas limit is the backend's word: every call goes out with the account's own estimate.
    ownGasEstimate: true,
    settlerResolver: pins.resolver,
    // The backend's preflight is its own word: the device reads the registry first (a Settler paused, replaced or
    // removed while the user was on the review screen is refused here, nothing sent), then asks the backend.
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      await zeroExPreflightDeposit(quote, tx, {chains: pins.chains, resolver: pins.resolver});
      await inner.preflightDeposit!(quote, tx);
    },
    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      if (params.dry !== false) return inner.getQuote(params, signal);
      const chainId = zeroExChainId(params.sourceChain);
      const ask = async (settlers: readonly string[]): Promise<Quote | null> => {
        checkedAgainst.set(params, settlers);
        const q = await inner.getQuote(params, signal);
        if (q) quoted.set(chainId, {settlers, untilMs: Math.min(Number.isFinite(q.validUntilMs) ? q.validUntilMs : 0, Date.now() + QUOTED_SET_MAX_MS)});
        return q;
      };
      const before = await pins.resolver.resolve(chainId);
      try {
        return await ask(before);
      } catch (e) {
        // A Settler the app has not seen: read the registry again and, only if it changed, ask once more.
        if (!(e instanceof Error) || !/is not a 0x Settler from the on-chain registry/.test(e.message)) throw e;
        const after = await pins.resolver.resolve(chainId, {fresh: true});
        if (after.length === before.length && after.every((s, i) => same(s, before[i]!))) throw e;
        return ask(after);
      }
    },
  };
}

/**
 * The 0x Settlers a signing policy should know as Permit2 spenders on `chainId`, labelled — the `knownSpenders` of
 * wallet-evm's `describeTypedData`, and the addresses a kit allowlist needs next to Permit2 and the token. Pass the
 * provider the app swaps through (`zeroExRemoteProvider` / `zeroExProvider`, or its `settlerResolver`): the set is the
 * one that resolver read from the registry, cached for its max age and read again after it. Empty when the registry
 * cannot be read: the permit is then described as a grant to an unknown spender, never silently trusted.
 *
 * ```ts
 * const zeroex = zeroExRemoteProvider({baseUrl, rpcUrls});
 * describeTypedData(typed, {chainId: 8453, account, knownSpenders: await zeroExKnownSpenders(zeroex, 8453)});
 * ```
 */
export async function zeroExKnownSpenders(source: SettlerResolver | {readonly settlerResolver: SettlerResolver}, chainId: number, label = "0x Settler"): Promise<Record<string, string>> {
  const resolver = "settlerResolver" in source ? source.settlerResolver : source;
  try {
    return Object.fromEntries((await resolver.resolve(chainId)).map((settler) => [settler, label]));
  } catch {
    return {};
  }
}
