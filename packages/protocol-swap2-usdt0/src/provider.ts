import {createPublicClient, encodeFunctionData, fallback, getAddress, http, isAddress, pad, parseAbi, type Hex} from "viem";
import {describeUsdt0Activity} from "./activity.js";
import {ccAsset} from "@forgewallet/swap2-assets";
import {timeoutSignal} from "@forgewallet/protocol-swap2-core/util";
import type {Asset, CrossChainProvider, IntentRef, IntentState, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@forgewallet/protocol-swap2-core/types";
import {LZ_SCAN_API, USDT0_BY_EID, USDT0_CHAINS, USDT0_SYMBOLS, usdt0 as usdt0Cfg, type Usdt0Chain} from "./config.js";

/**
 * USDT0 — Tether's USDT as a LayerZero OFT. ONE source transaction:
 * `send(SendParam, MessagingFee, refund)` on the chain's OFT with the
 * LayerZero messaging fee as `msg.value`; LayerZero's DVNs verify and the
 * executor delivers on the destination (mint of USDT0, or unlock of USDT out
 * of the Ethereum adapter). No second user transaction in the normal case.
 *
 *  - Quote = two `eth_call`s on the source OFT: `quoteOFT` for the limits,
 *    protocol fees and the amount that really arrives after dust removal
 *    (shared decimals = 6, so none today), then `quoteSend` for the native
 *    fee with `minAmountLD` pinned to that received amount — the contract
 *    reverts rather than deliver less. Both are sealed into the quote.
 *  - `enforcedOptions` on every deployment already carry the executor gas
 *    (type-3 options, lzReceive gas 80 000, read on-chain 2026-10-20), so
 *    `extraOptions` stays empty; LayerZero Scan confirms deliveries ran on it.
 *  - Ethereum locks USDT in an adapter (`approvalRequired()` = true →
 *    `approvalAddress`); every other chain's OFT burns the caller's USDT0
 *    itself (`approvalRequired()` = false → no approval at all).
 *  - Every address in `config.ts` is re-read on-chain before the first quote
 *    on a chain (`token()`, `approvalRequired()`) and per pair (`peers(dstEid)`
 *    must be the destination OFT) — a mismatch refuses the route.
 *  - Status: LayerZero Scan by source hash. DELIVERED carries the destination
 *    hash; PAYLOAD_STORED (delivery reverted on the destination, funds safe)
 *    becomes "action-required" with a `buildClaim` that retries
 *    `EndpointV2.lzReceive` — anyone may call it, so the user can.
 */

const OFT_ABI = parseAbi([
  "struct SendParam { uint32 dstEid; bytes32 to; uint256 amountLD; uint256 minAmountLD; bytes extraOptions; bytes composeMsg; bytes oftCmd; }",
  "struct MessagingFee { uint256 nativeFee; uint256 lzTokenFee; }",
  "struct OFTLimit { uint256 minAmountLD; uint256 maxAmountLD; }",
  "struct OFTFeeDetail { int256 feeAmountLD; string description; }",
  "struct OFTReceipt { uint256 amountSentLD; uint256 amountReceivedLD; }",
  "struct MessagingReceipt { bytes32 guid; uint64 nonce; MessagingFee fee; }",
  "function quoteSend(SendParam s, bool payInLzToken) view returns (MessagingFee)",
  "function quoteOFT(SendParam s) view returns (OFTLimit, OFTFeeDetail[], OFTReceipt)",
  "function send(SendParam s, MessagingFee fee, address refundAddress) payable returns (MessagingReceipt, OFTReceipt)",
  "function token() view returns (address)",
  "function approvalRequired() view returns (bool)",
  "function peers(uint32 eid) view returns (bytes32)",
]);
const ENDPOINT_ABI = parseAbi([
  "struct Origin { uint32 srcEid; bytes32 sender; uint64 nonce; }",
  "function lzReceive(Origin origin, address receiver, bytes32 guid, bytes message, bytes extraData) payable",
]);

const EVM_PLACEHOLDER = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const DEFAULT_QUOTE_TTL_MS = 60_000;
const RPC_TIMEOUT_MS = 12_000;
const SCAN_TIMEOUT_MS = 12_000;
/** A direct `send` used ~330k gas on Arbitrum and on the Ethereum adapter (2026-10-20 receipts). */
const GAS_SEND = "450000";
/** `lzReceive` retry of a stored payload: a mint plus the endpoint bookkeeping. */
const GAS_CLAIM = "300000";
const ZERO_B32 = `0x${"00".repeat(32)}` as Hex;

export interface Usdt0ProviderConfig {
  enabled?: boolean;
  /**
   * JSON-RPC URL(s) per CAIP-2 chain. REQUIRED for every chain the provider
   * should quote from: the fee and the received amount come from the OFT
   * itself. The destination RPC is optional (used for the stored-payload retry).
   */
  rpcUrls?: Readonly<Record<string, string | readonly string[]>>;
  /** LayerZero Scan base (default https://scan.layerzero-api.com). */
  scanUrl?: string;
  /** Local lifetime of a quote (default 60 s; the sealed fee is re-checked at preflight). */
  quoteTtlMs?: number;
  /** Injectable for tests (also used by the RPC transport). */
  fetchImpl?: typeof fetch;
}

interface ScanMessage {
  pathway?: {srcEid?: number; dstEid?: number; sender?: {address?: string}; receiver?: {address?: string}; nonce?: number};
  source?: {status?: string; tx?: {txHash?: string; payload?: string; options?: {lzReceive?: {gas?: string; value?: string}}}};
  destination?: {status?: string; tx?: {txHash?: string}};
  guid?: string;
  status?: {name?: string; message?: string};
}

const same = (a: string | undefined | null, b: string) => !!a && a.toLowerCase() === b.toLowerCase();
const isHexData = (v: unknown): v is Hex => typeof v === "string" && /^0x(?:[0-9a-fA-F]{2})*$/.test(v);

/** Does the catalog symbol on `chain` name this deployment's token? (USDT on Ethereum/Polygon, USDT0 elsewhere.) */
function tokenMatches(chain: Usdt0Chain, symbolOrAddress: string): boolean {
  if (symbolOrAddress.startsWith("0x")) return same(symbolOrAddress, chain.token);
  if (!USDT0_SYMBOLS.includes(symbolOrAddress.toUpperCase().replace("USD₮", "USDT"))) return false;
  const known = ccAsset(chain.caip2, symbolOrAddress);
  // A symbol the catalog binds to another contract (OP's legacy bridged USDT) is not the OFT token.
  return !known || same(known.contract ?? "", chain.token);
}

export function usdt0Provider(config: Usdt0ProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  const scan = (config.scanUrl ?? LZ_SCAN_API).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(scan)) throw new Error("usdt0: scanUrl must use http or https");
  const quoteTtlMs = config.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  if (!Number.isInteger(quoteTtlMs) || quoteTtlMs <= 0 || quoteTtlMs > 300_000) throw new Error("usdt0: quoteTtlMs must be an integer between 1 and 300000");
  const rpcUrls = Object.freeze({...(config.rpcUrls ?? {})});
  const doFetch: typeof fetch = (input, init) => (config.fetchImpl ?? fetch)(input, init);

  const client = (caip2: string) => {
    const raw = rpcUrls[caip2];
    const urls = typeof raw === "string" ? [raw] : [...(raw ?? [])];
    if (urls.length === 0) return null;
    const opts = {timeout: RPC_TIMEOUT_MS, ...(config.fetchImpl ? {fetchFn: config.fetchImpl} : {})} as never;
    return createPublicClient({transport: urls.length === 1 ? http(urls[0], opts) : fallback(urls.map((u) => http(u, opts)))});
  };

  /** Once per chain: the OFT really is the OFT of the listed token with the listed approval mode. */
  const verified = new Map<string, Promise<void>>();
  function verifyChain(chain: Usdt0Chain): Promise<void> {
    let p = verified.get(chain.caip2);
    if (!p) {
      p = (async () => {
        const c = client(chain.caip2);
        if (!c) throw new Error(`usdt0: no RPC for ${chain.caip2}`);
        const [token, approval] = await Promise.all([
          c.readContract({address: getAddress(chain.oft), abi: OFT_ABI, functionName: "token"}),
          c.readContract({address: getAddress(chain.oft), abi: OFT_ABI, functionName: "approvalRequired"}),
        ]);
        if (!same(token, chain.token)) throw new Error(`usdt0: OFT ${chain.oft} on ${chain.name} reports token ${token}, expected ${chain.token}`);
        if (approval !== chain.adapter) throw new Error(`usdt0: OFT ${chain.oft} on ${chain.name} reports approvalRequired=${String(approval)}, expected ${String(chain.adapter)}`);
      })();
      p.catch(() => verified.delete(chain.caip2));
      verified.set(chain.caip2, p);
    }
    return p;
  }

  /** Once per pair: the source OFT's peer for the destination eid is the destination OFT. */
  const peers = new Map<string, Promise<void>>();
  function verifyPeer(src: Usdt0Chain, dst: Usdt0Chain): Promise<void> {
    const key = `${src.eid}>${dst.eid}`;
    let p = peers.get(key);
    if (!p) {
      p = (async () => {
        const c = client(src.caip2);
        if (!c) throw new Error(`usdt0: no RPC for ${src.caip2}`);
        const peer = await c.readContract({address: getAddress(src.oft), abi: OFT_ABI, functionName: "peers", args: [dst.eid]});
        if (!same(peer, pad(getAddress(dst.oft), {size: 32}))) throw new Error(`usdt0: ${src.name} OFT has no peer for ${dst.name} (eid ${dst.eid}) — route not wired`);
      })();
      p.catch(() => peers.delete(key));
      peers.set(key, p);
    }
    return p;
  }

  function parseIntent(intentId: string): {src: Usdt0Chain; dst: Usdt0Chain} | null {
    const [tag, s, d] = intentId.split(":");
    if (tag !== "usdt0") return null;
    const src = USDT0_BY_EID[Number(s)];
    const dst = USDT0_BY_EID[Number(d)];
    return src && dst && src !== dst ? {src, dst} : null;
  }

  const sendParam = (dstEid: number, recipient: string, amountLD: bigint, minAmountLD: bigint) => ({
    dstEid, to: pad(getAddress(recipient), {size: 32}), amountLD, minAmountLD, extraOptions: "0x" as Hex, composeMsg: "0x" as Hex, oftCmd: "0x" as Hex,
  });

  /** The LayerZero message of a source transaction on this route, or null while Scan has not indexed it. */
  async function scanMessage(src: Usdt0Chain, dst: Usdt0Chain, sourceTxHash: string): Promise<ScanMessage | null | "foreign"> {
    const res = await doFetch(`${scan}/v1/messages/tx/${encodeURIComponent(sourceTxHash)}`, {headers: {accept: "application/json"}, signal: timeoutSignal(SCAN_TIMEOUT_MS)});
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`usdt0: LayerZero Scan → ${res.status}`);
    const body = (await res.json()) as {data?: ScanMessage[]};
    const list = Array.isArray(body?.data) ? body.data : [];
    if (list.length === 0) return null;
    const m = list.find((x) => x.pathway?.srcEid === src.eid && x.pathway?.dstEid === dst.eid && same(x.pathway?.sender?.address, src.oft));
    return m ?? "foreign";
  }

  return {
    name: "usdt0",
    describeActivity: describeUsdt0Activity,
    enabled: () => config.enabled ?? true,
    supportsChain: (chain: string) => usdt0Cfg.supportsChain(chain) && client(chain) !== null,
    supportsChainPair: (from: string, to: string) => usdt0Cfg.supports(from, to) && client(from) !== null,
    supportsRoute(from: Asset, to: Asset): boolean {
      const src = USDT0_CHAINS[from.chain];
      const dst = USDT0_CHAINS[to.chain];
      if (!src || !dst || src === dst || client(from.chain) === null) return false;
      return tokenMatches(src, from.token) && tokenMatches(dst, to.token);
    },

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const refuse = (reason: string) => { params.onRefusal?.(reason); return null; };
      if (params.flex) return refuse("the amount is sealed into the calldata (no flexible deposits)");
      const src = USDT0_CHAINS[params.sourceChain];
      const dst = USDT0_CHAINS[params.destChain];
      if (!src || !dst) return refuse("USDT0 is not deployed on this chain");
      if (src === dst) return refuse("same-chain transfers are not a bridge");
      if (!tokenMatches(src, params.sourceToken)) return refuse(`source token ${params.sourceToken} is not USDT0 (${src.token}) on ${src.name}`);
      if (!tokenMatches(dst, params.destToken)) return refuse(`destination token ${params.destToken} is not USDT0 (${dst.token}) on ${dst.name}`);
      if (!/^\d+$/.test(params.amountIn)) return refuse("amount must be a base-unit integer");
      const amount = BigInt(params.amountIn);
      if (amount <= 0n) return refuse("amount must be positive");
      const recipient = params.destAddress || EVM_PLACEHOLDER;
      if (!isAddress(recipient)) return refuse("destination must be an EVM address");
      const refund = params.refundAddress || EVM_PLACEHOLDER;
      if (!isAddress(refund)) return refuse("refund address must be an EVM address");
      const c = client(src.caip2);
      if (!c) return refuse(`no RPC configured for ${src.caip2}`);

      try {
        await Promise.all([verifyChain(src), verifyPeer(src, dst)]);
        const probe = sendParam(dst.eid, recipient, amount, 0n);
        const [limit, feeDetails, receipt] = await c.readContract({address: getAddress(src.oft), abi: OFT_ABI, functionName: "quoteOFT", args: [probe]});
        if (amount < limit.minAmountLD) return refuse(`amount ${amount} is below the OFT minimum ${limit.minAmountLD}`);
        if (amount > limit.maxAmountLD) return refuse(`amount ${amount} exceeds the OFT maximum ${limit.maxAmountLD}`);
        const received = receipt.amountReceivedLD;
        if (received <= 0n) return refuse("amount is below the OFT dust threshold — nothing would arrive");
        if (received > amount) return refuse("OFT reports more received than sent — refusing");
        if (params.minAmountOut !== undefined && received < BigInt(params.minAmountOut)) return refuse(`received ${received} is below the caller's floor ${params.minAmountOut}`);
        const sp = sendParam(dst.eid, recipient, amount, received);
        const fee = await c.readContract({address: getAddress(src.oft), abi: OFT_ABI, functionName: "quoteSend", args: [sp, false]});
        if (fee.lzTokenFee !== 0n) return refuse("OFT asks for a fee in LZ token — unsupported");
        const nativeFee = fee.nativeFee;
        const data = encodeFunctionData({abi: OFT_ABI, functionName: "send", args: [sp, {nativeFee, lzTokenFee: 0n}, getAddress(refund)]});
        const protocolFees = feeDetails
          .filter((f) => f.feeAmountLD > 0n)
          .map((f) => ({type: "protocol" as const, amount: f.feeAmountLD.toString(), token: src.token, included: true, description: f.description || "OFT fee"}));
        const feeUsd = protocolFees.reduce((a, f) => a + Number(f.amount) / 1e6, 0);
        // Ethereum sources wait for 60 confirmations before the DVNs attest (~15 min live); L2 sources land in a few minutes.
        const eta = src.chainId === 1 ? 1000 : 240;
        return {
          provider: "usdt0",
          intentId: `usdt0:${src.eid}:${dst.eid}`,
          depositAddress: "",
          depositMemo: null,
          txRequest: {
            to: src.oft,
            data,
            value: nativeFee.toString(),
            chainId: src.chainId,
            gasLimit: GAS_SEND,
            ...(src.adapter ? {approvalAddress: src.oft} : {}),
            ...(nativeFee > 0n ? {nativeFee: nativeFee.toString()} : {}),
          },
          sourceAmount: amount.toString(),
          destAmount: received.toString(),
          minDestAmount: received.toString(),
          feeUsd,
          fees: protocolFees,
          etaSeconds: eta,
          reliability: 0.98,
          validUntilMs: Date.now() + quoteTtlMs,
          providerData: {
            srcEid: String(src.eid), dstEid: String(dst.eid), oft: src.oft, token: src.token, recipient: getAddress(recipient), refundAddress: getAddress(refund),
            amountLD: amount.toString(), minAmountLD: received.toString(), nativeFee: nativeFee.toString(),
          },
        };
      } catch (err) {
        return refuse(err instanceof Error ? err.message : String(err));
      }
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      const tx = quote.txRequest;
      const parsed = parseIntent(quote.intentId);
      if (!tx || !parsed) throw new Error("swap2: USDT0 quote has no transaction request");
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
     * Right before signing: the target is the source OFT, the peer is still the
     * destination OFT, and the CURRENT LayerZero fee still fits the sealed
     * `msg.value` — the endpoint reverts a send that underpays, so a fee that
     * moved up means re-quote rather than a wasted broadcast.
     */
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const parsed = parseIntent(quote.intentId);
      if (!parsed) throw new Error("usdt0: malformed intent id");
      const {src, dst} = parsed;
      if (!same(tx.to, src.oft)) throw new Error(`usdt0: deposit target ${tx.to} is not the ${src.name} OFT`);
      const pd = quote.providerData ?? {};
      if (!/^\d+$/.test(pd.amountLD ?? "") || !/^\d+$/.test(pd.minAmountLD ?? "") || !/^\d+$/.test(pd.nativeFee ?? "") || !isAddress(pd.recipient ?? "")) {
        throw new Error("usdt0: quote carries no sealed send parameters");
      }
      const c = client(src.caip2);
      if (!c) throw new Error(`usdt0: no RPC for ${src.caip2}`);
      await Promise.all([verifyChain(src), verifyPeer(src, dst)]);
      const sp = sendParam(dst.eid, pd.recipient!, BigInt(pd.amountLD!), BigInt(pd.minAmountLD!));
      const fee = await c.readContract({address: getAddress(src.oft), abi: OFT_ABI, functionName: "quoteSend", args: [sp, false]});
      const sealed = BigInt(pd.nativeFee!);
      if (fee.nativeFee > sealed) throw new Error(`usdt0: LayerZero fee rose to ${fee.nativeFee} above the quoted ${sealed} — re-quote`);
      if (BigInt(tx.value) !== sealed) throw new Error(`usdt0: transaction value ${tx.value} is not the quoted fee ${sealed}`);
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      const parsed = parseIntent(ref.intentId);
      if (!parsed) return {state: "failed"};
      const {src, dst} = parsed;
      if (!ref.sourceTxHash) return {state: "pending"};
      try {
        const m = await scanMessage(src, dst, ref.sourceTxHash);
        if (m === null) return {state: "pending", depositReceived: false};
        if (m === "foreign") return {state: "failed"}; // the hash carries a LayerZero message, but not ours
        const name = (m.status?.name ?? "").toUpperCase();
        const destHash = m.destination?.tx?.txHash;
        if (name === "DELIVERED") return {state: "completed", depositReceived: true, ...(destHash ? {destTxHash: destHash} : ref.destTxHash ? {destTxHash: ref.destTxHash} : {})};
        if (name === "PAYLOAD_STORED") return {state: "action-required", depositReceived: true, claim: {chain: dst.caip2, ready: true}};
        if (["FAILED", "APPLICATION_BURNED", "APPLICATION_SKIPPED", "UNRESOLVABLE_COMMAND", "MALFORMED_COMMAND"].includes(name)) return {state: "failed", depositReceived: true};
        // INFLIGHT, CONFIRMING, BLOCKED (an earlier nonce on the pathway is stuck — LayerZero clears it), or anything new.
        return {state: "pending", depositReceived: true};
      } catch {
        return {state: "pending"};
      }
    },

    /**
     * A delivery that reverted on the destination (PAYLOAD_STORED — out of
     * executor gas, paused token) is retried by anyone through the endpoint:
     * `lzReceive(origin, receiver, guid, message, extraData)` with the exact
     * packet LayerZero Scan recorded. Null while nothing is stored.
     */
    async buildClaim(ref: IntentRef): Promise<UnsignedTx | null> {
      const parsed = parseIntent(ref.intentId);
      if (!parsed || !ref.sourceTxHash) return null;
      const {src, dst} = parsed;
      const m = await scanMessage(src, dst, ref.sourceTxHash);
      if (!m || m === "foreign" || (m.status?.name ?? "").toUpperCase() !== "PAYLOAD_STORED") return null;
      const nonce = m.pathway?.nonce;
      const guid = m.guid;
      const message = m.source?.tx?.payload;
      if (!Number.isInteger(nonce) || !isHexData(guid) || guid.length !== 66 || !isHexData(message) || message.length <= 2) {
        throw new Error("usdt0: LayerZero Scan has no complete packet for the stored payload");
      }
      if (!same(m.pathway?.receiver?.address, dst.oft)) throw new Error("usdt0: stored payload is addressed to another receiver");
      const valueRaw = m.source?.tx?.options?.lzReceive?.value ?? "0";
      const value = /^\d+$/.test(valueRaw) ? valueRaw : "0";
      return {
        chain: dst.caip2,
        to: dst.endpoint,
        value,
        data: encodeFunctionData({
          abi: ENDPOINT_ABI,
          functionName: "lzReceive",
          args: [{srcEid: src.eid, sender: pad(getAddress(src.oft), {size: 32}), nonce: BigInt(nonce as number)}, getAddress(dst.oft), guid, message, "0x"],
        }),
        chainId: dst.chainId,
        gasLimit: GAS_CLAIM,
      };
    },
  };
}

/** Exported for tests and diagnostics: the LayerZero Scan status → swap2 state mapping. */
export const USDT0_STATUS_MAP: Readonly<Record<string, IntentState>> = Object.freeze({
  INFLIGHT: "pending", CONFIRMING: "pending", BLOCKED: "pending",
  DELIVERED: "completed", PAYLOAD_STORED: "action-required",
  FAILED: "failed", APPLICATION_BURNED: "failed", APPLICATION_SKIPPED: "failed", UNRESOLVABLE_COMMAND: "failed", MALFORMED_COMMAND: "failed",
});

export {ZERO_B32 as USDT0_ZERO_PEER};
