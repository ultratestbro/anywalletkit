/**
 * Chainflip provider — VAULT SWAPS through the public backend (chainflip-swap.chainflip.io), Chainflip's own broker at
 * 0 bps, no account or key:
 *   quote   GET  /v2/quote?isVaultSwap=true          → expected output, fees, ETA, recommended slippage
 *   encode  POST /api/encodeVaultSwapData            → EVM vault calldata / Tron TRC-20 transfer + note (live quotes only)
 *   status  GET  /v2/swaps/{source tx hash}          → RECEIVING … COMPLETED | FAILED, egress / refund tx refs
 * The encoder runs on a server we do not control, so every byte it returns is decoded here and checked against the
 * request before the quote is handed out: vault address, source token and amount, destination chain / asset / address,
 * refund address, the minimum price (it must guarantee our minimum), no boost / DCA / CCM / affiliates, broker fee 0.
 * Fill-or-kill is always on: a price below the minimum after the retry window refunds to the source address.
 */
import {describeChainflipActivity} from "./activity.js";
import {CF_API_DEFAULT, CF_CHAINS, CF_VAULTS, cfAsset, chainflip as cfg} from "./config.js";
import {decodeEvmVaultCall, decodeTronNote, destAddressBytes, fromHex, minOutOf, minPriceX128For, sameBytes, tronToBytes, type CfParameters} from "./codec.js";
import {httpRefusal, refusal, refusalNotes, type Swap2RefusalInfo, type Swap2RefusalReason} from "@anywalletkit/protocol-swap2-core/errors";
import {timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import {decodeFunctionData, parseAbi, type Hex} from "viem";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";

const QUOTE_TTL_MS = 60_000;
/** 50 state-chain blocks ≈ 5 min of retries before a fill-or-kill refund (the backend's recommendation). */
const RETRY_BLOCKS = 50;
const MAX_RETRY_BLOCKS = 600;
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)"]);

export interface ChainflipProviderConfig {
  enabled?: boolean;
  /** Backend base URL (default the public chainflip-swap.chainflip.io). */
  apiUrl?: string;
  /** Live-price (oracle) slippage guard in bps; null turns it off. Default: the quote's recommendation. */
  maxOraclePriceSlippageBps?: number | null;
}

interface CfQuote {
  type?: string;
  egressAmount?: string;
  depositAmount?: string;
  estimatedDurationSeconds?: number;
  recommendedSlippageTolerancePercent?: number;
  recommendedLivePriceSlippageTolerancePercent?: number;
  includedFees?: {type: string; chain: string; asset: string; amount: string}[];
  lowLiquidityWarning?: boolean;
}

/** The intent id: `cfvault:<source chain>` — vault swaps are tracked by their source transaction. */
const INTENT_PREFIX = "cfvault:";

/** The reason behind each text `checkParams` returns. */
const notes = refusalNotes();

/**
 * What a failed backend answer means: the backend's own message first (limits, liquidity, a halted pool), else the
 * status (429 with Retry-After, 408 / 425 / 5xx). The backend takes no key, so a 401 / 403 (a CDN, WAF or region block
 * in front of it) is `upstream_unavailable` with its status, never `key_rejected`. Undefined when neither says.
 */
function backendRefusal(status: number, body: unknown, retryAfter: string | null): Swap2RefusalInfo | undefined {
  const http = httpRefusal(status, retryAfter);
  const byStatus: Swap2RefusalInfo | undefined = http?.reason === "key_rejected" ? {reason: "upstream_unavailable", httpStatus: status} : http;
  if (byStatus?.reason === "rate_limited") return byStatus;
  const m = (body as {message?: unknown} | null)?.message;
  const said = typeof m === "string" ? backendReason(m) : undefined;
  return said && said !== byStatus?.reason ? {reason: said} : byStatus;
}
function backendReason(message: string): Swap2RefusalReason | undefined {
  if (/liquidity/i.test(message)) return "insufficient_liquidity";
  if (/maximum (?:swap )?amount|above (?:the )?max|too (?:large|big|high)|exceeds? (?:the )?max/i.test(message)) return "amount_too_large";
  if (/minimum (?:swap |deposit )?amount|below (?:the )?minimum|lower than (?:the )?(?:estimated|minimum)|too (?:small|low)/i.test(message)) return "amount_too_small";
  if (/halt|paus|maintenance|disabled|suspend|not enabled/i.test(message)) return "chain_halted";
  if (/rate.?limit|too many requests/i.test(message)) return "rate_limited";
  if (/not supported|unsupported|unknown asset|invalid asset/i.test(message)) return "unsupported_pair";
  if (/no (?:route|quote)|could not find/i.test(message)) return "no_route";
  return undefined;
}

export function chainflipProvider(config: ChainflipProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  const base = new URL(config.apiUrl ?? CF_API_DEFAULT).toString().replace(/\/$/, "");

  /** One GET/POST with a single back-off on 429 (the backend sits behind a rate-limiting CDN). */
  const call = async (path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<{ok: boolean; status: number; body: unknown; retryAfter: string | null}> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}${path}`, {...init, headers: {accept: "application/json", ...(init.body ? {"content-type": "application/json"} : {}), ...(init.headers ?? {})}, signal: signal ?? timeoutSignal(12_000)});
      const body = await res.json().catch(() => null);
      if (res.status === 429 && attempt === 0 && !signal?.aborted) { await new Promise((r) => setTimeout(r, 1200)); continue; }
      return {ok: res.ok, status: res.status, body, retryAfter: res.headers?.get?.("retry-after") ?? null};
    }
  };

  /** Everything the encoder returned must say exactly what we asked; any difference refuses the quote. */
  const checkParams = (p: CfParameters, want: {refund: Uint8Array; minPriceX128: bigint; oracle: number | null}): string | null => {
    if (!sameBytes(fromHex(p.refundAddress), want.refund)) return notes.note(`refund address ${p.refundAddress} is not the sender`, "recipient_mismatch");
    if (p.minPriceX128 < want.minPriceX128) return notes.note("minimum price is below the one requested", "price_check_failed");
    if (p.retryDurationBlocks > MAX_RETRY_BLOCKS) return notes.note(`retry window ${p.retryDurationBlocks} blocks is too long`, "policy_refused");
    if (p.maxOraclePriceSlippageBps !== want.oracle) return notes.note("oracle slippage guard differs from the request", "price_check_failed");
    if (p.dca !== null) return notes.note("unexpected DCA parameters", "policy_refused");
    if (p.boostFeeBps !== 0) return notes.note("unexpected boost fee", "policy_refused");
    if (p.broker.feeBps !== 0) return notes.note(`broker takes ${p.broker.feeBps} bps`, "policy_refused");
    if (p.affiliates.length) return notes.note("unexpected affiliates", "policy_refused");
    return null;
  };

  return {
    name: "chainflip",
    describeActivity: describeChainflipActivity,
    enabled: () => config.enabled ?? true,
    supportsChain: (chain: string) => cfg.supportsChain(chain),
    supportsChainPair: (from: string, to: string) => cfg.supports(from, to),
    supportsRoute(from: Asset, to: Asset): boolean {
      if (!cfg.supports(from.chain, to.chain)) return false;
      const a = cfAsset(from.chain, from.token), b = cfAsset(to.chain, to.token);
      return !!a && !!b && a.id !== b.id;
    },

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const dry = params.dry !== false;
      const refuse = (reason: string, why?: Swap2RefusalReason | Swap2RefusalInfo): null => {
        const info = typeof why === "string" ? {reason: why} : why;
        if (info) params.onRefusal?.(`chainflip: ${reason}`, info);
        else params.onRefusal?.(`chainflip: ${reason}`);
        return null;
      };
      // A network failure or our own timeout is the backend's; the caller's abort is not.
      const unreachable = (): Swap2RefusalReason | undefined => (signal?.aborted ? undefined : "upstream_unavailable");
      if (!cfg.supports(params.sourceChain, params.destChain)) return refuse(`no vault swap ${params.sourceChain} → ${params.destChain}`, "unsupported_pair");
      const src = cfAsset(params.sourceChain, params.sourceToken);
      const dst = cfAsset(params.destChain, params.destToken);
      if (!src || !dst) return refuse(`asset not listed (${params.sourceToken} on ${params.sourceChain} → ${params.destToken} on ${params.destChain})`, "unsupported_pair");
      const amountIn = BigInt(params.amountIn);
      if (amountIn < src.minDeposit) return refuse(`below the minimum deposit (${src.minDeposit} ${src.asset})`, "amount_too_small");
      let destBytes: Uint8Array;
      try { destBytes = destAddressBytes(params.destChain, params.destAddress); } catch (e) { return refuse((e as Error).message); }

      const qs = new URLSearchParams({amount: params.amountIn, srcChain: src.chain, srcAsset: src.asset, destChain: dst.chain, destAsset: dst.asset, isVaultSwap: "true", isOnChain: "false", dcaV2Enabled: "false"});
      let q: CfQuote | undefined;
      let answered: unknown;
      try {
        const r = await call(`/v2/quote?${qs.toString()}`, {}, signal);
        if (!r.ok) return refuse(`quote ${r.status}: ${String((r.body as {message?: string} | null)?.message ?? "").slice(0, 160)}`, backendRefusal(r.status, r.body, r.retryAfter));
        answered = r.body;
        q = (r.body as CfQuote[] | null)?.find((x) => x.type === "REGULAR") ?? (r.body as CfQuote[] | null)?.[0];
      } catch (e) { return refuse(`quote failed: ${(e as Error).message.slice(0, 160)}`, unreachable()); }
      // An empty list is no quote for the pair; anything else without an amount is an answer of another shape, unless
      // the caller aborted while the body was read (it reads as null then).
      if (!q?.egressAmount || !/^\d+$/.test(q.egressAmount)) return refuse("quote without an egress amount", Array.isArray(answered) && answered.length === 0 ? "no_route" : unreachable());
      if (q.type && q.type !== "REGULAR") return refuse(`${q.type} quotes are not supported`, "unsupported_pair");
      const expected = BigInt(q.egressAmount);
      // Minimum: the expected output less the slippage (the caller's, else the backend's advice), or the
      // caller's floor. A caller who names both is held to both — the engine checks the quote against
      // each (execution sends a floor under the listed quote AND the slippage the list was quoted at).
      const slipBps = params.slippageBps ?? Math.round((q.recommendedSlippageTolerancePercent ?? 1) * 100);
      const byTolerance = (expected * BigInt(10_000 - Math.min(9_999, Math.max(0, slipBps)))) / 10_000n;
      const callerFloor = params.minAmountOut !== undefined ? BigInt(params.minAmountOut) : undefined;
      const minOut = callerFloor === undefined ? byTolerance
        : params.slippageBps !== undefined && byTolerance > callerFloor ? byTolerance : callerFloor;
      if (minOut > expected) return refuse(`floor ${minOut} above the expected output ${expected}`, "price_check_failed");
      const minPriceX128 = minPriceX128For(amountIn, minOut);
      const guaranteed = minOutOf(amountIn, minPriceX128);
      const oracle = config.maxOraclePriceSlippageBps !== undefined ? config.maxOraclePriceSlippageBps
        : q.recommendedLivePriceSlippageTolerancePercent !== undefined ? Math.round(q.recommendedLivePriceSlippageTolerancePercent * 100) : null;
      const fees = (q.includedFees ?? []).map((f) => ({type: (f.type === "NETWORK" ? "protocol" : f.type === "BROKER" ? "affiliate" : "network") as "network" | "protocol" | "affiliate", amount: f.amount, token: `${f.chain}:${f.asset}`, included: true, description: `Chainflip ${f.type.toLowerCase()} fee`}));
      const stableUsd = (f: {asset: string; amount: string}) => (f.asset === "USDC" || f.asset === "USDT" ? Number(f.amount) / 1e6 : 0);
      const common = {
        provider: "chainflip",
        sourceAmount: params.amountIn,
        destAmount: q.egressAmount,
        minDestAmount: guaranteed.toString(),
        feeUsd: (q.includedFees ?? []).reduce((s, f) => s + stableUsd(f), 0),
        fees,
        etaSeconds: Math.round(q.estimatedDurationSeconds ?? 180),
        reliability: q.lowLiquidityWarning ? 0.75 : 0.9,
        validUntilMs: Date.now() + QUOTE_TTL_MS,
      };
      if (dry) return {...common, intentId: `dry:${crypto.randomUUID()}`, depositAddress: "", depositMemo: null};

      if (!params.refundAddress) return refuse("live quote without a refund address", "policy_refused");
      let refund: Uint8Array;
      try { refund = destAddressBytes(params.sourceChain, params.refundAddress); } catch (e) { return refuse(`refund address: ${(e as Error).message}`); }
      const body = {
        srcAsset: {chain: src.chain, asset: src.asset}, destAsset: {chain: dst.chain, asset: dst.asset},
        srcAddress: params.refundAddress, destAddress: params.destAddress, amount: params.amountIn,
        fillOrKillParams: {retryDurationBlocks: RETRY_BLOCKS, refundAddress: params.refundAddress, minPriceX128: minPriceX128.toString(), maxOraclePriceSlippage: oracle},
        commissionBps: 0,
      };
      let enc: {to?: string; calldata?: string; value?: string; note?: string; sourceTokenAddress?: string; chain?: string};
      try {
        const r = await call("/api/encodeVaultSwapData", {method: "POST", body: JSON.stringify(body)}, signal);
        if (!r.ok) return refuse(`encode ${r.status}: ${String((r.body as {message?: string} | null)?.message ?? "").slice(0, 160)}`, backendRefusal(r.status, r.body, r.retryAfter));
        enc = (r.body ?? {}) as typeof enc;
      } catch (e) { return refuse(`encode failed: ${(e as Error).message.slice(0, 160)}`, unreachable()); }
      const want = {refund, minPriceX128, oracle};
      const vault = CF_VAULTS[params.sourceChain]!;
      const dstChain = CF_CHAINS[params.destChain]!;

      // An answer without a target at all is a malformed one (a body that is not JSON, `{}`, or the caller's abort while
      // it was read), not another vault.
      try {
        if (params.sourceChain.startsWith("eip155:")) {
          if (!enc.to || enc.to.toLowerCase() !== vault.toLowerCase()) return refuse(`encoder targets ${enc.to}, not the ${src.chain} Vault`, !enc.to ? unreachable() : "vault_mismatch");
          const v = decodeEvmVaultCall(enc.calldata ?? "0x");
          if (v.dstChain !== dstChain.id || v.dstToken !== dst.id || !sameBytes(v.dstAddress, destBytes)) return refuse("encoded destination differs from the request", "recipient_mismatch");
          if (src.token === null) {
            if (!v.native || BigInt(enc.value ?? "0") !== amountIn) return refuse("native vault call with a different amount", "policy_refused");
          } else if (v.native || v.srcToken?.toLowerCase() !== src.token.toLowerCase() || v.amount !== amountIn || BigInt(enc.value ?? "0") !== 0n) {
            return refuse("token vault call with a different token or amount", "policy_refused");
          }
          const bad = checkParams(v.params, want);
          if (bad) return refuse(bad, notes.reasonOf(bad));
          return {
            ...common,
            intentId: `${INTENT_PREFIX}${params.sourceChain}`,
            depositAddress: "",
            depositMemo: null,
            txRequest: {to: vault, data: enc.calldata!, value: src.token === null ? params.amountIn : "0", chainId: Number(params.sourceChain.slice(7)), ...(src.token ? {approvalAddress: vault} : {})},
            providerData: {kind: "evm", srcAsset: String(src.id), dstAsset: String(dst.id)},
          };
        }
        // Tron: the deposit IS a plain transfer to the Vault; the swap parameters ride in the transaction note.
        if (enc.to !== vault) return refuse(`encoder targets ${enc.to}, not the Tron Vault`, !enc.to ? unreachable() : "vault_mismatch");
        if (!enc.note) return refuse("Tron vault swap without a note", "recipient_unverifiable");
        if (src.token !== null) {
          if (enc.sourceTokenAddress !== src.token) return refuse(`source token ${enc.sourceTokenAddress} is not ${src.asset}`, "policy_refused");
          const t = decodeFunctionData({abi: ERC20, data: (enc.calldata ?? "0x") as Hex});
          const toVault = sameBytes(fromHex(String(t.args[0])), tronToBytes(vault));
          if (!toVault || t.args[1] !== amountIn) return refuse("TRC-20 transfer is not the amount to the Vault", toVault ? "policy_refused" : "vault_mismatch");
        }
        const n = decodeTronNote(enc.note);
        if (n.outputAsset !== dst.id || n.destTag !== dstChain.addrTag || !sameBytes(n.destAddress, destBytes)) return refuse("note names another destination", "recipient_mismatch");
        const bad = checkParams(n.params, want);
        if (bad) return refuse(bad, notes.reasonOf(bad));
        return {
          ...common,
          intentId: `${INTENT_PREFIX}${params.sourceChain}`,
          depositAddress: vault,
          depositMemo: enc.note,
          providerData: {kind: "tron", memoEncoding: "hex", srcAsset: String(src.id), dstAsset: String(dst.id)},
        };
      } catch (e) {
        return refuse(`encoder output does not decode: ${(e as Error).message.slice(0, 160)}`, "upstream_unavailable");
      }
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      if (quote.providerData?.kind === "evm") {
        const tx = quote.txRequest;
        if (!tx?.to || !tx.data) throw refusal("policy_refused", "chainflip: quote has no vault call");
        return {chain: "", to: tx.to, value: tx.value ?? "0", data: tx.data, ...(tx.chainId !== undefined ? {chainId: tx.chainId} : {}), ...(tx.approvalAddress ? {approvalAddress: tx.approvalAddress} : {})};
      }
      if (quote.providerData?.kind === "tron") {
        if (!quote.depositAddress || !quote.depositMemo) throw refusal("policy_refused", "chainflip: Tron quote without vault or note");
        return {chain: "", to: quote.depositAddress, value: quote.sourceAmount, memo: quote.depositMemo, memoEncoding: "hex"};
      }
      throw refusal("policy_refused", "chainflip: not a live vault-swap quote");
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      if (!ref.sourceTxHash) return {state: "pending"};
      const id = ref.intentId.startsWith(`${INTENT_PREFIX}tron:`) ? ref.sourceTxHash.replace(/^0x/, "") : ref.sourceTxHash;
      try {
        const r = await call(`/v2/swaps/${encodeURIComponent(id)}`);
        if (r.status === 404) return {state: "pending"}; // not witnessed yet
        if (!r.ok) return {state: "pending"};
        const s = (r.body ?? {}) as {state?: string; swapEgress?: {txRef?: string}; refundEgress?: {txRef?: string}; fallbackEgress?: {txRef?: string}; deposit?: {txRef?: string}};
        const egress = s.swapEgress?.txRef;
        const refunded = !!(s.refundEgress || s.fallbackEgress);
        if (s.state === "COMPLETED" || (s.state === "SENT" && egress)) {
          // Fill-or-kill: only a refund went out → refunded; swapped in part and refunded the rest → partial (round 3, M26).
          if (!s.swapEgress && refunded) return {state: "refunded", depositReceived: true};
          if (s.swapEgress && refunded) return {state: "partial", depositReceived: true, ...(egress ? {destTxHash: egress} : {})};
          return {state: "completed", depositReceived: true, ...(egress ? {destTxHash: egress} : {})};
        }
        if (s.state === "FAILED") return s.refundEgress || s.fallbackEgress ? {state: "refunded", depositReceived: true} : {state: "failed", depositReceived: true};
        const received = s.state === "RECEIVING" || s.state === "SWAPPING" || s.state === "SENDING" || s.state === "SENT";
        return {state: "pending", depositReceived: received};
      } catch {
        return {state: "pending"};
      }
    },
  };
}

