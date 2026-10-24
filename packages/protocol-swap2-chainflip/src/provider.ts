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

export function chainflipProvider(config: ChainflipProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  const base = new URL(config.apiUrl ?? CF_API_DEFAULT).toString().replace(/\/$/, "");

  /** One GET/POST with a single back-off on 429 (the backend sits behind a rate-limiting CDN). */
  const call = async (path: string, init: RequestInit = {}, signal?: AbortSignal): Promise<{ok: boolean; status: number; body: unknown}> => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${base}${path}`, {...init, headers: {accept: "application/json", ...(init.body ? {"content-type": "application/json"} : {}), ...(init.headers ?? {})}, signal: signal ?? timeoutSignal(12_000)});
      const body = await res.json().catch(() => null);
      if (res.status === 429 && attempt === 0 && !signal?.aborted) { await new Promise((r) => setTimeout(r, 1200)); continue; }
      return {ok: res.ok, status: res.status, body};
    }
  };

  /** Everything the encoder returned must say exactly what we asked; any difference refuses the quote. */
  const checkParams = (p: CfParameters, want: {refund: Uint8Array; minPriceX128: bigint; oracle: number | null}): string | null => {
    if (!sameBytes(fromHex(p.refundAddress), want.refund)) return `refund address ${p.refundAddress} is not the sender`;
    if (p.minPriceX128 < want.minPriceX128) return "minimum price is below the one requested";
    if (p.retryDurationBlocks > MAX_RETRY_BLOCKS) return `retry window ${p.retryDurationBlocks} blocks is too long`;
    if (p.maxOraclePriceSlippageBps !== want.oracle) return "oracle slippage guard differs from the request";
    if (p.dca !== null) return "unexpected DCA parameters";
    if (p.boostFeeBps !== 0) return "unexpected boost fee";
    if (p.broker.feeBps !== 0) return `broker takes ${p.broker.feeBps} bps`;
    if (p.affiliates.length) return "unexpected affiliates";
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
      const refuse = (reason: string): null => {
        params.onRefusal?.(`chainflip: ${reason}`);
        return null;
      };
      if (!cfg.supports(params.sourceChain, params.destChain)) return refuse(`no vault swap ${params.sourceChain} → ${params.destChain}`);
      const src = cfAsset(params.sourceChain, params.sourceToken);
      const dst = cfAsset(params.destChain, params.destToken);
      if (!src || !dst) return refuse(`asset not listed (${params.sourceToken} on ${params.sourceChain} → ${params.destToken} on ${params.destChain})`);
      const amountIn = BigInt(params.amountIn);
      if (amountIn < src.minDeposit) return refuse(`below the minimum deposit (${src.minDeposit} ${src.asset})`);
      let destBytes: Uint8Array;
      try { destBytes = destAddressBytes(params.destChain, params.destAddress); } catch (e) { return refuse((e as Error).message); }

      const qs = new URLSearchParams({amount: params.amountIn, srcChain: src.chain, srcAsset: src.asset, destChain: dst.chain, destAsset: dst.asset, isVaultSwap: "true", isOnChain: "false", dcaV2Enabled: "false"});
      let q: CfQuote | undefined;
      try {
        const r = await call(`/v2/quote?${qs.toString()}`, {}, signal);
        if (!r.ok) return refuse(`quote ${r.status}: ${String((r.body as {message?: string} | null)?.message ?? "").slice(0, 160)}`);
        q = (r.body as CfQuote[] | null)?.find((x) => x.type === "REGULAR") ?? (r.body as CfQuote[] | null)?.[0];
      } catch (e) { return refuse(`quote failed: ${(e as Error).message.slice(0, 160)}`); }
      if (!q?.egressAmount || !/^\d+$/.test(q.egressAmount)) return refuse("quote without an egress amount");
      if (q.type && q.type !== "REGULAR") return refuse(`${q.type} quotes are not supported`);
      const expected = BigInt(q.egressAmount);
      // Minimum: the caller's floor, else the expected output less the slippage (the caller's, else the backend's advice).
      const slipBps = params.slippageBps ?? Math.round((q.recommendedSlippageTolerancePercent ?? 1) * 100);
      const byTolerance = (expected * BigInt(10_000 - Math.min(9_999, Math.max(0, slipBps)))) / 10_000n;
      const minOut = params.minAmountOut !== undefined ? BigInt(params.minAmountOut) : byTolerance;
      if (minOut > expected) return refuse(`floor ${minOut} above the expected output ${expected}`);
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

      if (!params.refundAddress) return refuse("live quote without a refund address");
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
        if (!r.ok) return refuse(`encode ${r.status}: ${String((r.body as {message?: string} | null)?.message ?? "").slice(0, 160)}`);
        enc = (r.body ?? {}) as typeof enc;
      } catch (e) { return refuse(`encode failed: ${(e as Error).message.slice(0, 160)}`); }
      const want = {refund, minPriceX128, oracle};
      const vault = CF_VAULTS[params.sourceChain]!;
      const dstChain = CF_CHAINS[params.destChain]!;

      try {
        if (params.sourceChain.startsWith("eip155:")) {
          if (!enc.to || enc.to.toLowerCase() !== vault.toLowerCase()) return refuse(`encoder targets ${enc.to}, not the ${src.chain} Vault`);
          const v = decodeEvmVaultCall(enc.calldata ?? "0x");
          if (v.dstChain !== dstChain.id || v.dstToken !== dst.id || !sameBytes(v.dstAddress, destBytes)) return refuse("encoded destination differs from the request");
          if (src.token === null) {
            if (!v.native || BigInt(enc.value ?? "0") !== amountIn) return refuse("native vault call with a different amount");
          } else if (v.native || v.srcToken?.toLowerCase() !== src.token.toLowerCase() || v.amount !== amountIn || BigInt(enc.value ?? "0") !== 0n) {
            return refuse("token vault call with a different token or amount");
          }
          const bad = checkParams(v.params, want);
          if (bad) return refuse(bad);
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
        if (enc.to !== vault) return refuse(`encoder targets ${enc.to}, not the Tron Vault`);
        if (!enc.note) return refuse("Tron vault swap without a note");
        if (src.token !== null) {
          if (enc.sourceTokenAddress !== src.token) return refuse(`source token ${enc.sourceTokenAddress} is not ${src.asset}`);
          const t = decodeFunctionData({abi: ERC20, data: (enc.calldata ?? "0x") as Hex});
          if (!sameBytes(fromHex(String(t.args[0])), tronToBytes(vault)) || t.args[1] !== amountIn) return refuse("TRC-20 transfer is not the amount to the Vault");
        }
        const n = decodeTronNote(enc.note);
        if (n.outputAsset !== dst.id || n.destTag !== dstChain.addrTag || !sameBytes(n.destAddress, destBytes)) return refuse("note names another destination");
        const bad = checkParams(n.params, want);
        if (bad) return refuse(bad);
        return {
          ...common,
          intentId: `${INTENT_PREFIX}${params.sourceChain}`,
          depositAddress: vault,
          depositMemo: enc.note,
          providerData: {kind: "tron", memoEncoding: "hex", srcAsset: String(src.id), dstAsset: String(dst.id)},
        };
      } catch (e) {
        return refuse(`encoder output does not decode: ${(e as Error).message.slice(0, 160)}`);
      }
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      if (quote.providerData?.kind === "evm") {
        const tx = quote.txRequest;
        if (!tx?.to || !tx.data) throw new Error("chainflip: quote has no vault call");
        return {chain: "", to: tx.to, value: tx.value ?? "0", data: tx.data, ...(tx.chainId !== undefined ? {chainId: tx.chainId} : {}), ...(tx.approvalAddress ? {approvalAddress: tx.approvalAddress} : {})};
      }
      if (quote.providerData?.kind === "tron") {
        if (!quote.depositAddress || !quote.depositMemo) throw new Error("chainflip: Tron quote without vault or note");
        return {chain: "", to: quote.depositAddress, value: quote.sourceAmount, memo: quote.depositMemo, memoEncoding: "hex"};
      }
      throw new Error("chainflip: not a live vault-swap quote");
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
        if (s.state === "COMPLETED" || (s.state === "SENT" && egress)) return {state: "completed", depositReceived: true, ...(egress ? {destTxHash: egress} : {})};
        if (s.state === "FAILED") return s.refundEgress || s.fallbackEgress ? {state: "refunded", depositReceived: true} : {state: "failed", depositReceived: true};
        const received = s.state === "RECEIVING" || s.state === "SWAPPING" || s.state === "SENDING" || s.state === "SENT";
        return {state: "pending", depositReceived: received};
      } catch {
        return {state: "pending"};
      }
    },
  };
}

