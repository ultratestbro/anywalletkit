import {createPublicClient, encodeFunctionData, getAddress, http, isAddress, pad, parseAbi, zeroHash, type Hex} from "viem";
import {describeCctpActivity} from "./activity.js";
import {ccAsset} from "@anywalletkit/swap2-assets";
import {timeoutSignal} from "@anywalletkit/protocol-swap2-core/util";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {CCTP_API, CCTP_BY_DOMAIN, CCTP_DOMAINS, FINALITY_FAST, FINALITY_STANDARD, cctp as cctpCfg, type CctpDomain} from "./config.js";
import {bigintToNumber} from "@anywalletkit/core";

/**
 * Circle CCTP V2 — native USDC between chains by burn-and-mint, no spread, no
 * aggregator fee. TWO-PHASE: `depositForBurn` on the source burns the USDC and
 * emits the message; Circle's attestation service (Iris) signs it once the
 * source reached the requested finality; `receiveMessage(message, attestation)`
 * on the destination mints. That second transaction is the user's: the engine
 * exposes it through `buildClaim` / `claimSwap2` (status "action-required").
 *
 *  - Fast Transfer (finality 1000, confirmed, ~seconds–minutes) costs a fee in
 *    bps that Circle publishes per pair; Standard (2000, finalized, ~15 min)
 *    is free. `mode: "auto"` takes Fast when the pair offers it and the Fast
 *    allowance covers the amount, else Standard.
 *  - `maxFee` sent on-chain is the published fee (plus a small buffer) and is
 *    the only thing that can be deducted: the guaranteed output is
 *    amount − maxFee. `preflightDeposit` re-reads Circle's published fee right
 *    before the burn (the deployed TokenMessengerV2 has no on-chain
 *    `getMinFeeAmount`/`minFee` — both revert on Ethereum, Base, Arbitrum,
 *    2026-10-12) and, with an RPC for the source chain, the transmitter's
 *    `localDomain()` on the very contract the calldata targets.
 *  - Everything is bound to Circle's documented contract addresses and the
 *    native USDC of each domain; a catalog USDC that is not the native one
 *    refuses the route (USDC.e cannot be burnt).
 */

const TOKEN_MESSENGER_ABI = parseAbi([
  "function depositForBurn(uint256 amount, uint32 destinationDomain, bytes32 mintRecipient, address burnToken, bytes32 destinationCaller, uint256 maxFee, uint32 minFinalityThreshold)",
  "function localMessageTransmitter() view returns (address)",
]);
const MESSAGE_TRANSMITTER_ABI = parseAbi([
  "function receiveMessage(bytes message, bytes attestation) returns (bool)",
  "function localDomain() view returns (uint32)",
  "function usedNonces(bytes32 nonce) view returns (uint256)",
]);

const EVM_PLACEHOLDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const DEFAULT_QUOTE_TTL_MS = 60_000;
/** Fallback gas limit: a depositForBurn runs ~110–150k, receiveMessage ~150–200k. */
const GAS_DEPOSIT = "200000";
const GAS_CLAIM = "260000";

export type CctpMode = "auto" | "fast" | "standard";

export interface CctpProviderConfig {
  enabled?: boolean;
  /** Circle attestation API base (default https://iris-api.circle.com). */
  apiUrl?: string;
  /** Fast when offered and within the allowance (default), or force one path. */
  mode?: CctpMode;
  /** Extra headroom on the published Fast fee, in percent of the fee (default 10). The excess is never charged. */
  feeBufferPct?: number;
  /**
   * JSON-RPC URLs per CAIP-2 chain. Optional, but with them the provider
   * verifies the contracts before the burn and detects the mint on the
   * destination (`usedNonces`) so the status reaches "completed" by itself.
   */
  rpcUrls?: Readonly<Record<string, string>>;
  /** Local lifetime of a quote (fees are stable; default 60 s). */
  quoteTtlMs?: number;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
}

interface FeeRow { finalityThreshold: number; minimumFee: number }
interface ApiMessage {
  message?: string;
  eventNonce?: string;
  attestation?: string | null;
  status?: string;
  delayReason?: string | null;
  cctpVersion?: number;
  decodedMessage?: {
    sourceDomain?: string; destinationDomain?: string; nonce?: string; mintRecipient?: string;
    decodedMessageBody?: {amount?: string; maxFee?: string; feeExecuted?: string; expirationBlock?: string; mintRecipient?: string; burnToken?: string};
  };
}

const isHexData = (v: unknown): v is Hex => typeof v === "string" && /^0x(?:[0-9a-fA-F]{2})+$/.test(v);
const same = (a: string | undefined, b: string) => !!a && a.toLowerCase() === b.toLowerCase();

/** `amount × bps` rounded up; `bps` may be fractional (Circle publishes 1.3). */
function feeFor(amount: bigint, bps: number, bufferPct: number): bigint {
  const hundredths = BigInt(Math.round(bps * 100)); // 1.3 bps → 130
  const fee = (amount * hundredths + 999_999n) / 1_000_000n;
  if (fee === 0n) return 0n;
  return fee + (fee * BigInt(Math.round(bufferPct * 100)) + 9_999n) / 10_000n;
}

export function cctpProvider(config: CctpProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  const api = (config.apiUrl ?? CCTP_API).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(api)) throw new Error("cctp: apiUrl must use http or https");
  const mode: CctpMode = config.mode ?? "auto";
  if (!["auto", "fast", "standard"].includes(mode)) throw new Error("cctp: mode must be auto | fast | standard");
  const bufferPct = config.feeBufferPct ?? 10;
  if (!Number.isFinite(bufferPct) || bufferPct < 0 || bufferPct > 100) throw new Error("cctp: feeBufferPct must be between 0 and 100");
  const quoteTtlMs = config.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  if (!Number.isInteger(quoteTtlMs) || quoteTtlMs <= 0 || quoteTtlMs > 300_000) throw new Error("cctp: quoteTtlMs must be an integer between 1 and 300000");
  const doFetch = config.fetchImpl ?? fetch;
  const rpcUrls = Object.freeze({...(config.rpcUrls ?? {})});

  const client = (caip2: string) => {
    const url = rpcUrls[caip2];
    return url ? createPublicClient({transport: http(url, {fetchOptions: {}, ...(config.fetchImpl ? {fetchFn: config.fetchImpl} : {})} as never)}) : null;
  };

  async function getJson<T>(path: string, signal?: AbortSignal): Promise<T | null> {
    const res = await doFetch(`${api}${path}`, {headers: {accept: "application/json"}, signal: signal ?? timeoutSignal(12_000)});
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`cctp: ${path} → ${res.status}`);
    return (await res.json()) as T;
  }

  /** Circle's published fee per finality threshold, in bps of the burnt amount. */
  const feeRows = (src: CctpDomain, dst: CctpDomain, signal?: AbortSignal) =>
    getJson<FeeRow[]>(`/v2/burn/USDC/fees/${src.domain}/${dst.domain}`, signal);

  /** The native USDC of a domain, cross-checked against the asset catalog when it knows the chain. */
  function usdcOf(dom: CctpDomain): string | null {
    const known = ccAsset(dom.caip2, "USDC");
    if (known && (!known.contract || !same(known.contract, dom.usdc))) return null; // catalog has a USDC that is not Circle's → refuse
    return dom.usdc;
  }

  function parseIntent(intentId: string): {src: CctpDomain; dst: CctpDomain; threshold: number} | null {
    const [tag, s, dd, t] = intentId.split(":");
    if (tag !== "cctp") return null;
    const src = CCTP_BY_DOMAIN[Number(s)];
    const dst = CCTP_BY_DOMAIN[Number(dd)];
    const threshold = Number(t);
    if (!src || !dst || !(threshold === FINALITY_FAST || threshold === FINALITY_STANDARD)) return null;
    return {src, dst, threshold};
  }

  async function fetchMessage(src: CctpDomain, sourceTxHash: string): Promise<ApiMessage | null> {
    const out = await getJson<{messages?: ApiMessage[]}>(`/v2/messages/${src.domain}?transactionHash=${encodeURIComponent(sourceTxHash)}`);
    const m = out?.messages?.find((x) => x.cctpVersion === undefined || x.cctpVersion === 2);
    return m ?? null;
  }

  async function minted(dst: CctpDomain, nonce: Hex): Promise<boolean | null> {
    const c = client(dst.caip2);
    if (!c) return null;
    try {
      const used = await c.readContract({address: getAddress(dst.messageTransmitter), abi: MESSAGE_TRANSMITTER_ABI, functionName: "usedNonces", args: [nonce]});
      return used !== 0n;
    } catch {
      return null;
    }
  }

  return {
    name: "cctp",
    describeActivity: describeCctpActivity,
    enabled: () => config.enabled ?? true,
    supportsChain: (chain: string) => cctpCfg.supportsChain(chain),
    supportsChainPair: (from: string, to: string) => cctpCfg.supports(from, to),
    supportsRoute(from: Asset, to: Asset): boolean {
      const src = CCTP_DOMAINS[from.chain];
      const dst = CCTP_DOMAINS[to.chain];
      if (!src || !dst || from.chain === to.chain) return false;
      if (from.token.toUpperCase() !== "USDC") return false;
      // Destination is given as an address (zero = native): only the native USDC of the destination domain.
      return same(to.token, dst.usdc) || to.token.toUpperCase() === "USDC";
    },

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      if (params.flex) return null; // the amount is baked into the calldata
      const src = CCTP_DOMAINS[params.sourceChain];
      const dst = CCTP_DOMAINS[params.destChain];
      if (!src || !dst || src === dst) return null;
      if (params.sourceToken.toUpperCase() !== "USDC") return null;
      if (!(same(params.destToken, dst.usdc) || params.destToken.toUpperCase() === "USDC")) return null;
      const usdc = usdcOf(src);
      if (!usdc) { params.onRefusal?.("catalog USDC on the source chain is not Circle's native USDC"); return null; }
      if (!/^\d+$/.test(params.amountIn)) return null;
      const amount = BigInt(params.amountIn);
      if (amount <= 0n) return null;
      // The placeholder prices a dry quote; a live one without a recipient would mint to it (round 3, H8).
      const recipient = params.destAddress || (params.dry !== false ? EVM_PLACEHOLDER : "");
      if (!recipient) { params.onRefusal?.("a live quote needs a recipient"); return null; }
      if (!isAddress(recipient)) { params.onRefusal?.("destination must be an EVM address"); return null; }

      try {
        const fees = await feeRows(src, dst, signal);
        if (!fees || !Array.isArray(fees) || fees.length === 0) { params.onRefusal?.("Circle publishes no fee for this pair"); return null; }
        const fast = fees.find((f) => f.finalityThreshold === FINALITY_FAST);
        const standard = fees.find((f) => f.finalityThreshold === FINALITY_STANDARD);
        let threshold: number;
        let bps: number;
        if (mode === "standard") {
          if (!standard) { params.onRefusal?.("Standard Transfer is not offered for this pair"); return null; }
          threshold = FINALITY_STANDARD; bps = standard.minimumFee;
        } else {
          let fastOk = !!fast;
          if (fastOk) {
            const allowance = await getJson<{allowance?: number}>("/v2/fastBurn/USDC/allowance", signal).catch(() => null);
            // The allowance is in whole USDC; refuse Fast when it cannot cover the burn.
            if (typeof allowance?.allowance === "number" && allowance.allowance * 1e6 < bigintToNumber(amount)) fastOk = false;
          }
          if (fastOk) { threshold = FINALITY_FAST; bps = fast!.minimumFee; }
          else if (mode === "fast") { params.onRefusal?.(fast ? "Fast Transfer allowance is exhausted" : "Fast Transfer is not offered for this pair"); return null; }
          else if (standard) { threshold = FINALITY_STANDARD; bps = standard.minimumFee; }
          else { params.onRefusal?.("neither Fast nor Standard is offered"); return null; }
        }
        if (!Number.isFinite(bps) || bps < 0) return null;
        const maxFee = feeFor(amount, bps, bufferPct);
        if (maxFee >= amount) { params.onRefusal?.("amount is below the Fast Transfer fee"); return null; }
        const out = amount - maxFee;
        if (params.minAmountOut !== undefined && out < BigInt(params.minAmountOut)) return null;

        const data = encodeFunctionData({
          abi: TOKEN_MESSENGER_ABI,
          functionName: "depositForBurn",
          args: [amount, dst.domain, pad(getAddress(recipient), {size: 32}), getAddress(usdc), zeroHash, maxFee, threshold],
        });
        const eta = threshold === FINALITY_FAST ? (src.domain === 0 ? 180 : 45) : (src.domain === 0 ? 1200 : 1000);
        return {
          provider: "cctp",
          intentId: `cctp:${src.domain}:${dst.domain}:${threshold}`,
          depositAddress: "",
          depositMemo: null,
          txRequest: {to: src.tokenMessenger, data, value: "0", chainId: src.chainId, gasLimit: GAS_DEPOSIT, approvalAddress: src.tokenMessenger},
          sourceAmount: amount.toString(),
          destAmount: out.toString(),
          minDestAmount: out.toString(),
          feeUsd: bigintToNumber(maxFee) / 1e6,
          fees: maxFee > 0n ? [{type: "protocol", amount: maxFee.toString(), token: usdc, included: true, description: `Circle Fast Transfer fee (${bps} bps + ${bufferPct}% buffer, unused part is not charged)`}] : [],
          etaSeconds: eta,
          reliability: 0.99,
          validUntilMs: Date.now() + quoteTtlMs,
          providerData: {
            sourceDomain: String(src.domain), destinationDomain: String(dst.domain), finalityThreshold: String(threshold),
            maxFee: maxFee.toString(), mintRecipient: getAddress(recipient), claimChain: dst.caip2, claimRequired: "1",
          },
        };
      } catch {
        return null;
      }
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      const parsed = parseIntent(quote.intentId);
      if (!tx || !parsed) throw new Error("swap2: CCTP quote has no transaction request");
      return {
        chain: parsed.src.caip2,
        to: tx.to ?? "",
        value: tx.value ?? "0",
        ...(tx.data ? {data: tx.data} : {}),
        ...(tx.chainId !== undefined ? {chainId: tx.chainId} : {}),
        ...(tx.gasLimit ? {gasLimit: tx.gasLimit} : {}),
        ...(tx.approvalAddress ? {approvalAddress: tx.approvalAddress} : {}),
      };
    },

    /**
     * Fast: Circle's CURRENT fee (same source and rounding as the quote, without
     * the buffer) still fits `maxFee` — Iris would otherwise hold the burn
     * until it times out to Standard. With a source RPC: the target really is
     * CCTP for this domain.
     */
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const parsed = parseIntent(quote.intentId);
      if (!parsed) throw new Error("cctp: malformed intent id");
      if (!same(tx.to, parsed.src.tokenMessenger)) throw new Error("cctp: deposit target is not the TokenMessengerV2 of the source domain");
      if (parsed.threshold === FINALITY_FAST) {
        const fast = (await feeRows(parsed.src, parsed.dst))?.find((f) => f.finalityThreshold === FINALITY_FAST);
        if (!fast || !Number.isFinite(fast.minimumFee) || fast.minimumFee < 0) throw new Error("cctp: Circle no longer publishes a Fast Transfer fee for this pair — re-quote");
        const minFee = feeFor(BigInt(quote.sourceAmount), fast.minimumFee, 0);
        const maxFee = BigInt(quote.providerData?.maxFee ?? "0");
        if (minFee > maxFee) throw new Error(`cctp: Circle's Fast Transfer fee ${minFee} (${fast.minimumFee} bps) exceeds the quoted maxFee ${maxFee} — re-quote`);
      }
      const c = client(parsed.src.caip2);
      if (!c) return;
      const transmitter = await c.readContract({address: getAddress(parsed.src.tokenMessenger), abi: TOKEN_MESSENGER_ABI, functionName: "localMessageTransmitter"});
      if (!same(transmitter, parsed.src.messageTransmitter)) throw new Error("cctp: TokenMessengerV2 does not point at the expected MessageTransmitterV2");
      const domain = await c.readContract({address: getAddress(parsed.src.messageTransmitter), abi: MESSAGE_TRANSMITTER_ABI, functionName: "localDomain"});
      if (Number(domain) !== parsed.src.domain) throw new Error(`cctp: MessageTransmitterV2 reports domain ${domain}, expected ${parsed.src.domain}`);
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      const parsed = parseIntent(ref.intentId);
      if (!parsed) return {state: "failed"};
      const claim = {chain: parsed.dst.caip2, ready: false};
      if (!ref.sourceTxHash) return {state: "pending", claim};
      try {
        const m = await fetchMessage(parsed.src, ref.sourceTxHash);
        if (!m) return {state: "pending", depositReceived: false, claim};
        const nonce = m.decodedMessage?.nonce;
        if (m.status === "complete" && isHexData(m.attestation) && isHexData(m.message)) {
          const done = isHexData(nonce) && nonce.length === 66 ? await minted(parsed.dst, nonce) : null;
          if (done) return {state: "completed", claim: {...claim, ready: false}, ...(ref.destTxHash ? {destTxHash: ref.destTxHash} : {})};
          // No destination RPC: a recorded claim hash is the best evidence we have.
          if (done === null && ref.destTxHash) return {state: "completed", destTxHash: ref.destTxHash, claim: {...claim, ready: false}};
          return {state: "action-required", depositReceived: true, claim: {...claim, ready: true}};
        }
        return {state: "pending", depositReceived: true, claim};
      } catch {
        return {state: "pending", claim};
      }
    },

    /** `receiveMessage(message, attestation)` on the destination once Circle attested; null while pending. */
    async buildClaim(ref: IntentRef): Promise<UnsignedTx | null> {
      const parsed = parseIntent(ref.intentId);
      if (!parsed || !ref.sourceTxHash) return null;
      const m = await fetchMessage(parsed.src, ref.sourceTxHash);
      if (!m || m.status !== "complete" || !isHexData(m.attestation) || !isHexData(m.message)) return null;
      // Bind the attested message to the route it claims to complete.
      if (m.decodedMessage?.destinationDomain !== undefined && Number(m.decodedMessage.destinationDomain) !== parsed.dst.domain) {
        throw new Error("cctp: attested message is for another destination domain");
      }
      if (m.decodedMessage?.sourceDomain !== undefined && Number(m.decodedMessage.sourceDomain) !== parsed.src.domain) {
        throw new Error("cctp: attested message is for another source domain");
      }
      // Fast messages expire at `expirationBlock` on the destination; an expired
      // one needs Circle's re-attestation before it can be received. The
      // transmitter compares it with `block.number`, which on Arbitrum-stack
      // chains is the L1 (Ethereum) height, not the L2 height eth_blockNumber
      // returns — the RPC block carries it as `l1BlockNumber` (live
      // 2026-10-16: a Base→Arbitrum claim was held as "expired" by L2 height).
      const exp = m.decodedMessage?.decodedMessageBody?.expirationBlock;
      const c = client(parsed.dst.caip2);
      if (c && exp && /^\d+$/.test(exp) && BigInt(exp) > 0n) {
        const head = await c.request({method: "eth_getBlockByNumber", params: ["latest", false]})
          .then((b) => {
            const block = b as {number?: string; l1BlockNumber?: string} | null;
            const raw = block?.l1BlockNumber ?? block?.number;
            return raw ? BigInt(raw) : null;
          })
          .catch(() => null);
        if (head !== null && head >= BigInt(exp)) {
          const nonce = m.decodedMessage?.nonce ?? m.eventNonce;
          if (nonce) await doFetch(`${api}/v2/reattest/${nonce}`, {method: "POST", signal: timeoutSignal(12_000)}).catch(() => undefined);
          return null;
        }
      }
      return {
        chain: parsed.dst.caip2,
        to: parsed.dst.messageTransmitter,
        value: "0",
        data: encodeFunctionData({abi: MESSAGE_TRANSMITTER_ABI, functionName: "receiveMessage", args: [m.message, m.attestation]}),
        chainId: parsed.dst.chainId,
        gasLimit: GAS_CLAIM,
      };
    },
  };
}
