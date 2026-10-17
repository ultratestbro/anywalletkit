import {nearIntents as cfg, nearIntentsChainRefusal, type NearIntentsSuspendedChains} from "./config.js";
import {describeNearIntentsActivity} from "./activity.js";
import {timeoutSignal} from "@forgewallet/protocol-swap2-core/util";
import {CC_DEST, ccAsset, ccAssetByToken, ccChain} from "@forgewallet/swap2-assets";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@forgewallet/protocol-swap2-core/types";

/**
 * NEAR Intents (1Click) provider — the core route, broadest coverage. Ported
 * from a production 1Click integration:
 *   dry quote → pricing preview; live quote → depositAddress the user funds
 *   from any wallet; status polled by depositAddress.
 * Runs server-side, so the partner JWT stays here (no proxy needed). Defensive:
 * any API error yields a null quote so the provider drops out of that round.
 */

const ONE_CLICK_DEFAULT = "https://1click.chaindefuser.com/v0";
const QUOTE_TTL_MS = 55_000;

/** intentId durably carries both status lookup keys (memo is quote-specific). */
const INTENT_PREFIX = "near1click:";

function encodeIntent(depositAddress: string, depositMemo: string | null): string {
  return `${INTENT_PREFIX}${encodeURIComponent(depositAddress)}|${encodeURIComponent(depositMemo ?? "")}`;
}

function decodeIntent(intentId: string): {depositAddress: string; depositMemo?: string} {
  try {
    if (!intentId.startsWith(INTENT_PREFIX)) throw new Error("unsupported id version");
    const raw = intentId.slice(INTENT_PREFIX.length);
    const parts = raw.split("|");
    if (parts.length !== 2 || !parts[0]) throw new Error("invalid id shape");
    const depositAddress = decodeURIComponent(parts[0]);
    const memo = decodeURIComponent(parts[1] ?? "");
    if (!depositAddress) throw new Error("empty deposit address");
    return {depositAddress, ...(memo ? {depositMemo: memo} : {})};
  } catch {
    throw new Error("near-intents: malformed intent id");
  }
}

function authHeaders(jwtOverride?: string): Record<string, string> {
  const h: Record<string, string> = {"content-type": "application/json", accept: "application/json"};
  const jwt = jwtOverride;
  if (jwt) h.authorization = `Bearer ${jwt}`;
  return h;
}

/** Our integrator fee, injected server-side when a recipient is configured. */
function appFees(recipient?: string, bps?: number): {recipient: string; fee: number}[] | undefined {
  return recipient !== undefined && bps !== undefined ? [{recipient, fee: bps}] : undefined;
}

/**
 * Per-source deposit + refund config. Every live default keeps failed-swap
 * ownership on the caller's source-chain address.
 */
function depositConfig(sourceChain: string, refundAddress: string, dry: boolean) {
  // Zcash dry quotes: we have no placeholder t-address, but pricing works with
  // an INTENTS-side refund (verified against the live API). Live quotes still
  // refund to the user's own zec address (the default branch below).
  if (sourceChain.startsWith("zcash:") && dry) {
    return {depositType: "ORIGIN_CHAIN", refundType: "INTENTS", refundTo: "intents.near"};
  }
  // 1Click currently supports TON origin-chain refunds. Keep ownership with
  // the caller; never redirect failed swaps to an integrator-owned NEAR
  // account. Dry quotes use the chain-specific placeholder supplied above.
  return {depositType: "ORIGIN_CHAIN", refundType: "ORIGIN_CHAIN", refundTo: refundAddress};
}

/** Placeholder sender/recipient for dry quotes (1Click requires the fields). */
const PLACEHOLDER: Record<string, string> = {
  bitcoin: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq",
  ton: "UQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJKZ",
  // NOT a token mint: with the USDC mint here, every dry quote whose ORIGIN
  // was Solana USDC answered 500 "Internal server error" (2026-10-09) — a
  // refund "to the asset's own mint" trips 1Click. The incinerator is a
  // plain, valid system address.
  solana: "1nc1nerator11111111111111111111111111111111",
  tron: "TN3W4H6rK2ce4vX9YnFQHwKENnHjoxb3m9",
  // NEAR refunds go to an account id; the registrar account always exists.
  near: "near",
  eip155: "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045",
};

function placeholderFor(chain: string): string {
  return PLACEHOLDER[chain.split(":")[0] ?? ""] ?? PLACEHOLDER.eip155!;
}

function deadlineIn(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * dest asset id for ANY chain in the catalog (inbound → Ethereum, or the step-2
 * off-ramp → any supported chain). Falls back to the Ethereum omft pattern for
 * a mainnet ERC-20 that isn't in the curated catalog.
 */
function destAssetId(destChain: string, destToken: string): string | null {
  const asset = ccAssetByToken(destChain, destToken);
  if (asset) return asset.assetId;
  if (destChain === CC_DEST.caip2 && /^0x[0-9a-fA-F]{40}$/.test(destToken)) {
    return `nep141:eth-${destToken.toLowerCase()}.omft.near`;
  }
  return null;
}

type OneClickQuote = {
  quote?: Record<string, unknown>;
  correlationId?: string;
  error?: string;
  message?: string;
};

/** 1Click returns tx hashes either as strings or {hash, explorerUrl}. */
function txHashOf(entry: unknown): string | null {
  if (!entry) return null;
  if (typeof entry === "string") return entry;
  const h = (entry as {hash?: string}).hash;
  return typeof h === "string" ? h : null;
}

/** Explicit constructor configuration; no deployment environment is read. */
export interface NearIntentsProviderConfig {
  enabled?: boolean;
  apiUrl?: string;
  jwt?: string;
  feeRecipient?: string;
  feeBps?: number;
  /** Corridors the app has paused (caip2 → reason): refused up front, by name, until the app lifts them. */
  suspendedChains?: NearIntentsSuspendedChains;
}

export function nearIntentsProvider(config: NearIntentsProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  const parsedApiUrl = new URL(config.apiUrl ?? ONE_CLICK_DEFAULT);
  if (parsedApiUrl.protocol !== "https:" && parsedApiUrl.protocol !== "http:") {
    throw new Error("near-intents: apiUrl must use http or https");
  }
  const apiBase = parsedApiUrl.toString().replace(/\/$/, "");
  const hasRecipient = config.feeRecipient !== undefined;
  const hasBps = config.feeBps !== undefined;
  if (hasRecipient !== hasBps) throw new Error("near-intents: feeRecipient and feeBps must be configured together");
  if (hasRecipient && (!config.feeRecipient!.trim() || !Number.isInteger(config.feeBps) || config.feeBps! <= 0 || config.feeBps! > 10_000)) {
    throw new Error("near-intents: fee config requires a recipient and feeBps between 1 and 10000");
  }
  return {
    name: "near_intents",
    describeActivity: describeNearIntentsActivity,
    enabled: () => config.enabled ?? true,

    // Capability discovery comes from the provider itself, so it can run alone
    // or inside the optional aggregator without a central capability table.
    supportsChain: (chain: string) => cfg.supportsChain(chain),
    supportsChainPair: (fromChain: string, toChain: string) => cfg.supports(fromChain, toChain),
    supportsRoute(from: Asset, to: Asset): boolean {
      // Chain-level gate first (namespace, catalog listing, hand-suspended
      // corridors such as TON while the HOT bridge is dark) …
      if (!cfg.supports(from.chain, to.chain)) return false;
      // … then only pairs present in the curated catalog are offered — and only
      // those with a 1Click asset id (LI.FI-only tokens carry an empty assetId).
      // Both ends: a destination 1Click doesn't list (Unichain, MegaETH, …)
      // answered "unknown asset" on every quote (589 of the 2026-10-10 matrix).
      const asset = ccAsset(from.chain, from.token);
      return !!ccChain(from.chain) && !!asset?.assetId && !!destAssetId(to.chain, to.token);
    },

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      // Every refusal below names itself: on the server these lines are the
      // only visibility into WHY a live quote returned null (the wire answer
      // is just `null`), and "no route" bugs hide in exactly that silence.
      const refuse = (reason: string): null => {
        const detail = `${reason} [dry=${params.dry !== false} ${params.sourceChain}->${params.destChain} amount=${params.amountIn}]`;
        console.warn(`near-intents: no quote — ${detail}`);
        params.onRefusal?.(detail);
        return null;
      };
      // Up-front, named refusals — no wire call for a corridor 1Click cannot
      // serve: a chain outside its list / suspended by hand, or a token the
      // catalog carries without a 1Click asset id ("1Click does not list …").
      const paused = config.suspendedChains ?? {};
      const chainRefusal = nearIntentsChainRefusal(params.sourceChain, paused) ?? nearIntentsChainRefusal(params.destChain, paused);
      if (chainRefusal) return refuse(chainRefusal);
      const origin = ccAsset(params.sourceChain, params.sourceToken);
      if (!origin?.assetId) return refuse(`1Click does not list ${params.sourceChain} ${params.sourceToken}`);
      const destination = destAssetId(params.destChain, params.destToken);
      if (!destination) return refuse(`1Click does not list ${params.destChain} ${params.destToken}`);
      const dry = params.dry !== false;
      // A live quote derives the deposit address from the refund config —
      // never create one without a real refund destination.
      const refund = params.refundAddress ?? (dry ? placeholderFor(params.sourceChain) : "");
      const dcfg = depositConfig(params.sourceChain, refund, dry);
      if (!dry && !dcfg.refundTo) return refuse("live quote without a refund address");

      const requestedDeadline = deadlineIn(60);
      const body: Record<string, unknown> = {
        dry,
        // FLEX_INPUT (exchange flow): the address accepts any amount; amountIn
        // is just the pricing notional. Verified against the live API.
        swapType: params.flex ? "FLEX_INPUT" : "EXACT_INPUT",
        slippageTolerance: params.slippageBps ?? 100,
        originAsset: origin.assetId,
        depositType: dcfg.depositType,
        destinationAsset: destination,
        amount: params.amountIn,
        refundTo: dcfg.refundTo,
        refundType: dcfg.refundType,
        recipient: params.destAddress,
        recipientType: "DESTINATION_CHAIN",
        deadline: requestedDeadline,
      };
      const fees = appFees(config.feeRecipient, config.feeBps);
      if (fees) body.appFees = fees;

      try {
        // 1Click's solver auction flaps: the same body can answer 400 "No
        // liquidity available" and 201 seconds apart (observed live on
        // TON USDT -> ETH). A transient flap on the EXECUTION quote would
        // surface as a terminal "no route" right after a successful display
        // quote, so ride through it: up to two retries on liquidity flaps,
        // 5xx and network errors. Real rejections (bad address, unknown
        // asset) still fail on the first answer.
        let res: Response | null = null;
        let data: OneClickQuote = {};
        for (let attempt = 0; ; attempt++) {
          try {
            res = await fetch(`${apiBase}/quote`, {
              method: "POST",
              headers: authHeaders(config.jwt),
              body: JSON.stringify(body),
              signal: signal ?? timeoutSignal(12_000),
            });
            data = (await res.json().catch(() => ({}))) as OneClickQuote;
          } catch (err) {
            if (attempt >= 2 || signal?.aborted) throw err;
            res = null;
          }
          if (res?.ok) break;
          const flaky =
            res === null ||
            res.status >= 500 ||
            (res.status === 400 && /no liquidity/i.test(String(data.message ?? "")));
          if (!flaky || attempt >= 2 || signal?.aborted) break;
          await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
        }
        if (!res?.ok) return refuse(`1Click ${res?.status ?? "network error"}: ${String(data.message ?? "").slice(0, 200)}`);
        const q = (data.quote ?? {}) as Record<string, unknown>;

        const depositAddress = typeof q.depositAddress === "string" ? q.depositAddress : "";
        if (!dry && !depositAddress) return refuse("live quote came back without a deposit address");
        const inUsd = Number.parseFloat(String(q.amountInUsd ?? "0"));
        const outUsd = Number.parseFloat(String(q.amountOutUsd ?? "0"));
        const parsedDeadline = Date.parse(String(q.deadline ?? ""));
        if (!dry && (!Number.isFinite(parsedDeadline) || parsedDeadline <= Date.now())) return refuse(`unusable deadline ${String(q.deadline)}`);
        const deadline = Number.isFinite(parsedDeadline) && parsedDeadline > Date.now()
          ? Math.min(parsedDeadline, Date.now() + QUOTE_TTL_MS)
          : Date.now() + QUOTE_TTL_MS;

        if (q.amountIn !== undefined && String(q.amountIn) !== params.amountIn) return refuse(`amountIn mismatch (${String(q.amountIn)} vs ${params.amountIn})`);

        // amountOut is optimistic, not a guaranteed floor. Live execution must
        // not fabricate a minimum when the provider omits it.
        if (q.minAmountOut === undefined || q.minAmountOut === null) return refuse("quote has no minAmountOut");
        const minDestAmount = String(q.minAmountOut);
        if (params.minAmountOut !== undefined && BigInt(minDestAmount) < BigInt(params.minAmountOut)) return refuse(`floor breach (min=${minDestAmount} < floor=${params.minAmountOut})`);
        const depositMemo =
          (typeof q.depositMemo === "string" && q.depositMemo) ||
          (typeof q.memo === "string" && q.memo) ||
          null;
        return {
          provider: "near_intents",
          intentId: depositAddress ? encodeIntent(depositAddress, depositMemo) : `dry:${crypto.randomUUID()}`,
          depositAddress,
          depositMemo,
          sourceAmount: params.amountIn,
          destAmount: String(q.amountOut ?? "0"),
          minDestAmount,
          feeUsd: Math.max(0, inUsd - outUsd),
          etaSeconds: Number(q.timeEstimate ?? 60),
          reliability: 0.95,
          validUntilMs: deadline,
        };
      } catch (err) {
        return refuse(`threw: ${err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200)}`);
      }
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      return {
        chain: "",
        to: quote.depositAddress,
        value: quote.sourceAmount,
        ...(quote.depositMemo ? {memo: quote.depositMemo} : {}),
      };
    },

    async notifyDeposit(intentId: string, txHash: string): Promise<void> {
      const {depositAddress} = decodeIntent(intentId);
      const res = await fetch(`${apiBase}/deposit/submit`, {
        method: "POST",
        headers: authHeaders(config.jwt),
        body: JSON.stringify({depositAddress, txHash}),
        signal: timeoutSignal(12_000),
      });
      if (!res.ok) throw new Error(`near-intents: deposit notification failed (${res.status})`);
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      const {depositAddress, depositMemo} = decodeIntent(ref.intentId);
      // Durable retry: BaseSwap2Protocol embeds the source hash in the swap2
      // id. If the post-broadcast notify failed, every status poll retries it.
      if (ref.sourceTxHash) {
        await this.notifyDeposit?.(ref.intentId, ref.sourceTxHash).catch(() => {});
      }
      try {
        const query = new URLSearchParams({depositAddress});
        if (depositMemo) query.set("depositMemo", depositMemo);
        const res = await fetch(
          `${apiBase}/status?${query.toString()}`,
          {headers: authHeaders(config.jwt), signal: timeoutSignal(12_000)},
        );
        if (!res.ok) return {state: "pending"};
        const s = (await res.json()) as {
          status?: string;
          swapDetails?: {destinationChainTxHashes?: unknown[]};
        };
        const map: Record<string, IntentStatus["state"]> = {
          PENDING_DEPOSIT: "pending",
          INCOMPLETE_DEPOSIT: "pending",
          PROCESSING: "pending",
          SUCCESS: "completed",
          FAILED: "failed",
          REFUNDED: "refunded",
        };
        const state = map[s.status ?? "PENDING_DEPOSIT"] ?? "pending";
        const depositReceived = s.status === "PROCESSING" || s.status === "INCOMPLETE_DEPOSIT";
        const destTx = txHashOf(s.swapDetails?.destinationChainTxHashes?.[0]);
        return {state, depositReceived, ...(destTx ? {destTxHash: destTx} : {})};
      } catch {
        return {state: "pending"};
      }
    },
  };
}
