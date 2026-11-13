import {createPublicClient, decodeFunctionData, encodeFunctionData, fallback, getAddress, http, isAddress, pad, parseAbi, type Hex} from "viem";
import {describeUsdt0Activity} from "./activity.js";
import {ccAsset} from "@anywalletkit/swap2-assets";
import {redactUrls, timeoutSignal, tonRawAddress} from "@anywalletkit/protocol-swap2-core/util";
import {bigintToUnits} from "@anywalletkit/core";
import type {Asset, CrossChainProvider, IntentRef, IntentState, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {LZ_SCAN_API, USDT0_BY_EID, USDT0_CHAINS, USDT0_MESH_INTENT, tokenMatches, usdt0ClaimTargets, usdt0VerifyMeshSend, usdt0 as usdt0Cfg, type Usdt0Chain} from "./config.js";
import {
  USDT0_MESH_DEFAULT_DESTINATIONS, USDT0_MESH_DESTINATION_BY_EID, USDT0_MESH_PLACEHOLDER, USDT0_MESH_SOURCES, USDT0_MESH_SOURCE_BY_EID, meshDestTokenMatches,
  meshDestTxHash, meshDestinationFor, meshDestinationOn, meshRecipientBytes32, meshRecipientMatches, meshSourceFor, type Usdt0MeshDestination,
  type Usdt0MeshFamily, type Usdt0MeshSource,
} from "./mesh.js";
import {ZERO_RECIPIENT_REFUSAL, isZeroEvmAddress, placeholderBuildRefusal, placeholderIn, placeholderPreflightRefusal, type Usdt0Placeholder} from "./placeholder.js";

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
 *
 * USDT0 Legacy Mesh (`mesh.ts`): Ethereum USDT / Arbitrum USDT0 / Celo USD₮ →
 * USDT on Tron or TON, same one source transaction on the chain's `UsdtOFT`
 * (approval to it: it pulls the token). Quote = `quoteOFT` (limit = the pool's
 * credit toward the destination, received = amount − 0.03 % mesh fee) +
 * `quoteSend`; the recipient is encoded as the destination OFT reads it and
 * the built send is decoded against the request before it is returned, and
 * the deposit again, whole, against the sealed send at preflight. Status:
 * the same LayerZero Scan message; on Tron the payout is inside `lzReceive`
 * (DELIVERED = paid), on TON it is a jetton transfer later in the trace, so a
 * TON delivery completes only when tonapi shows that transfer to the recipient.
 * No claim on Tron / TON (nothing signs there in this package). TON is on by default, Tron is opt-in
 * (`meshDestinations`): its LayerZero fee is above the swap2 engine's native-fee ceiling today.
 *
 * A dry request without the recipient or the refund address is priced for a stand-in (vitalik.eth; the zero account on
 * Tron / TON) and comes back as its price only: no `txRequest`, `providerData.placeholder` = "recipient" | "refund".
 * `buildDeposit` and `preflightDeposit` refuse such a quote; a recipient that is the zero account is refused outright.
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
/** UsdtOFT (Legacy Mesh): the OFT calls plus its custom errors, so a revert reads as its name (credits, slippage). */
const MESH_ABI = parseAbi([
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
  "error InsufficientCredits(uint32 eid, uint256 credits, uint256 amountWithdraw)",
  "error SlippageExceeded(uint256 amountReceived, uint256 minAmount)",
  "error InvalidAmount()",
  "error TONComposeNotSupported()",
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
/**
 * The LayerZero fee is quoted at quote time but paid at send time, and it moves
 * with source and destination gas (live: +1.7 % within a minute on Ethereum).
 * The sealed `msg.value` carries this headroom; EndpointV2 charges the current
 * fee and refunds the surplus to `refundAddress` (the trader) in the same
 * transaction, so the headroom costs nothing — it only avoids a re-quote.
 */
const FEE_HEADROOM_BPS = 2_500n;
/** `lzReceive` retry of a stored payload: a mint plus the endpoint bookkeeping. */
const GAS_CLAIM = "300000";
const ZERO_B32 = `0x${"00".repeat(32)}` as Hex;
/** tonapi (TON payout of a mesh delivery: `GET /v2/events/{hash}`, no query string). */
export const TON_API = "https://tonapi.io";
const TON_API_TIMEOUT_MS = 12_000;
/** Legacy Mesh sends seen on LayerZero Scan 2026-11-12: Ethereum → Tron median 229 s; Arbitrum / Celo → Tron / TON 39–53 s. */
const MESH_ETA_ETHEREUM = 300;
const MESH_ETA_L2 = 90;

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
  /**
   * tonapi base (default https://tonapi.io): a Legacy Mesh delivery to TON completes only once the trace of the
   * delivery shows the USDT jetton paid to the recipient (`GET {tonApiUrl}/v2/events/{hash}`, no query string).
   */
  tonApiUrl?: string;
  /** Local lifetime of a quote (default 60 s; the sealed fee is re-checked at preflight). */
  quoteTtlMs?: number;
  /**
   * USDT0 Legacy Mesh destinations to offer from the EVM mesh sources (Ethereum, Arbitrum, Celo): `"ton"`, `"tron"`.
   * Default `["ton"]`; `[]` leaves the mesh out. Tron is opt-in: the LayerZero fee into Tron (live 2026-11-12:
   * ≈ 0.0053 ETH from Ethereum / Arbitrum, ≈ 170 CELO from Celo, before the 25 % headroom) is above the swap2 engine's
   * native-fee ceiling (0.005 ETH, 100 CELO), so `swap2` refuses to execute it — turn it on only where that send can
   * run. A destination left out is not routed and answers as it did before the mesh ("USDT0 is not deployed on this chain").
   */
  meshDestinations?: readonly Usdt0MeshFamily[];
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

/**
 * A quote built for a stand-in, reduced to its price (review r3, 2026-11-13): the `send` is dropped and so are the
 * sealed addresses (the stand-in's), so neither `buildDeposit` nor `preflightDeposit` has anything to work from; the
 * amounts, the fee rows and the sealed LayerZero fee (`providerData.nativeFee`) stay for display.
 */
function priceOnly(quote: Quote, placeholder: Usdt0Placeholder): Quote {
  const {txRequest: _send, providerData, ...price} = quote;
  const {recipient: _recipient, recipientBytes32: _bytes, refundAddress: _refund, ...kept} = providerData ?? {};
  return {...price, providerData: {...kept, placeholder}};
}


/**
 * A refusal / preflight error that may reach a client: an RPC transport failure
 * becomes a fixed reason (viem's HTTP / timeout errors carry `URL: …`, and a keyed
 * endpoint's key sits in that path — scan 2026-10-23 F8); anything else loses its URLs.
 */
function rpcSafeReason(err: unknown, chainName: string): string {
  const e = err as {name?: string; shortMessage?: string; message?: string} | undefined;
  const text = `${e?.shortMessage ?? ""}\n${e?.message ?? String(err)}`;
  if (/HttpRequestError|TimeoutError|RpcRequestError|WebSocketRequestError/.test(String(e?.name)) || /\bURL: |HTTP request failed|request timed out|took too long to respond/i.test(text)) {
    return `usdt0: RPC for ${chainName} unavailable — try again`;
  }
  return redactUrls(err instanceof Error ? err.message : String(err));
}

export function usdt0Provider(config: Usdt0ProviderConfig = {}): CrossChainProvider {
  config = Object.freeze({...config});
  const scan = (config.scanUrl ?? LZ_SCAN_API).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(scan)) throw new Error("usdt0: scanUrl must use http or https");
  const tonApi = (config.tonApiUrl ?? TON_API).replace(/\/+$/, "");
  if (!/^https?:\/\//.test(tonApi)) throw new Error("usdt0: tonApiUrl must use http or https");
  const quoteTtlMs = config.quoteTtlMs ?? DEFAULT_QUOTE_TTL_MS;
  if (!Number.isInteger(quoteTtlMs) || quoteTtlMs <= 0 || quoteTtlMs > 300_000) throw new Error("usdt0: quoteTtlMs must be an integer between 1 and 300000");
  const families: unknown = config.meshDestinations ?? USDT0_MESH_DEFAULT_DESTINATIONS;
  if (!Array.isArray(families) || families.some((f) => f !== "tron" && f !== "ton")) throw new Error('usdt0: meshDestinations lists only "tron" and "ton"');
  const meshFamilies: readonly Usdt0MeshFamily[] = Object.freeze([...(families as Usdt0MeshFamily[])]);
  /** The mesh destination on `chain` when this provider offers it. */
  const meshOn = (chain: string): Usdt0MeshDestination | undefined => meshDestinationOn(chain, meshFamilies);
  const rpcUrls = Object.freeze({...(config.rpcUrls ?? {})});
  const doFetch: typeof fetch = (input, init) => (config.fetchImpl ?? fetch)(input, init);

  const client = (caip2: string) => {
    const raw = rpcUrls[caip2];
    const urls = typeof raw === "string" ? [raw] : [...(raw ?? [])];
    if (urls.length === 0) return null;
    const opts = {timeout: RPC_TIMEOUT_MS, ...(config.fetchImpl ? {fetchFn: config.fetchImpl} : {})} as never;
    return createPublicClient({transport: urls.length === 1 ? http(urls[0], opts) : fallback(urls.map((u) => http(u, opts))), ccipRead: false});
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
  async function scanMessage(src: {eid: number; oft: string}, dst: {eid: number}, sourceTxHash: string): Promise<ScanMessage | null | "foreign"> {
    const res = await doFetch(`${scan}/v1/messages/tx/${encodeURIComponent(sourceTxHash)}`, {headers: {accept: "application/json"}, signal: timeoutSignal(SCAN_TIMEOUT_MS)});
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`usdt0: LayerZero Scan → ${res.status}`);
    const body = (await res.json()) as {data?: ScanMessage[]};
    const list = Array.isArray(body?.data) ? body.data : [];
    if (list.length === 0) return null;
    const m = list.find((x) => x.pathway?.srcEid === src.eid && x.pathway?.dstEid === dst.eid && same(x.pathway?.sender?.address, src.oft));
    return m ?? "foreign";
  }

  // ── Legacy Mesh (EVM source → Tron / TON) ────────────────────────────────────────────────────────────────────────

  /** Once per chain: the mesh OFT pulls the listed token (`token()`, `approvalRequired()` = true). */
  const meshVerified = new Map<string, Promise<void>>();
  function verifyMeshSource(src: Usdt0MeshSource): Promise<void> {
    let p = meshVerified.get(src.caip2);
    if (!p) {
      p = (async () => {
        const c = client(src.caip2);
        if (!c) throw new Error(`usdt0: no RPC for ${src.caip2}`);
        const [token, approval] = await Promise.all([
          c.readContract({address: getAddress(src.oft), abi: MESH_ABI, functionName: "token"}),
          c.readContract({address: getAddress(src.oft), abi: MESH_ABI, functionName: "approvalRequired"}),
        ]);
        if (!same(token, src.token)) throw new Error(`usdt0: Legacy Mesh OFT ${src.oft} on ${src.name} reports token ${token}, expected ${src.token}`);
        if (approval !== true) throw new Error(`usdt0: Legacy Mesh OFT ${src.oft} on ${src.name} reports approvalRequired=${String(approval)}, expected true`);
      })();
      p.catch(() => meshVerified.delete(src.caip2));
      meshVerified.set(src.caip2, p);
    }
    return p;
  }

  /** Once per pair: the source mesh OFT's peer for the destination eid is the pinned Tron / TON OFT. */
  const meshPeers = new Map<string, Promise<void>>();
  function verifyMeshPeer(src: Usdt0MeshSource, dst: Usdt0MeshDestination): Promise<void> {
    const key = `${src.eid}>${dst.eid}`;
    let p = meshPeers.get(key);
    if (!p) {
      p = (async () => {
        const c = client(src.caip2);
        if (!c) throw new Error(`usdt0: no RPC for ${src.caip2}`);
        const peer = await c.readContract({address: getAddress(src.oft), abi: MESH_ABI, functionName: "peers", args: [dst.eid]});
        if (!same(peer, dst.peer)) throw new Error(`usdt0: ${src.name} Legacy Mesh OFT has no pinned peer for ${dst.name} (eid ${dst.eid}) — route not wired`);
      })();
      p.catch(() => meshPeers.delete(key));
      meshPeers.set(key, p);
    }
    return p;
  }

  function parseMeshIntent(intentId: string): {src: Usdt0MeshSource; dst: Usdt0MeshDestination} | null {
    const [tag, s, d, ...rest] = intentId.split(":");
    if (tag !== USDT0_MESH_INTENT || rest.length > 0 || !/^\d+$/.test(s ?? "") || !/^\d+$/.test(d ?? "")) return null;
    const src = Object.prototype.hasOwnProperty.call(USDT0_MESH_SOURCE_BY_EID, Number(s)) ? USDT0_MESH_SOURCE_BY_EID[Number(s)] : undefined;
    const dst = Object.prototype.hasOwnProperty.call(USDT0_MESH_DESTINATION_BY_EID, Number(d)) ? USDT0_MESH_DESTINATION_BY_EID[Number(d)] : undefined;
    return src && dst ? {src, dst} : null;
  }

  const meshSendParam = (dstEid: number, to: Hex, amountLD: bigint, minAmountLD: bigint) => ({
    dstEid, to, amountLD, minAmountLD, extraOptions: "0x" as Hex, composeMsg: "0x" as Hex, oftCmd: "0x" as Hex,
  });

  async function meshQuote(params: QuoteParams, src: Usdt0MeshSource, dst: Usdt0MeshDestination, refuse: (reason: string) => null): Promise<Quote | null> {
    if (!tokenMatches(src, params.sourceToken)) return refuse(`source token ${params.sourceToken} is not USDT0 (${src.token}) on ${src.name}`);
    if (!meshDestTokenMatches(dst, params.destToken)) return refuse(`destination token ${params.destToken} is not USDT0 (${dst.token}) on ${dst.name}`);
    if (!/^\d+$/.test(params.amountIn)) return refuse("amount must be a base-unit integer");
    const amount = BigInt(params.amountIn);
    if (amount <= 0n) return refuse("amount must be positive");
    // The zero-account placeholder prices a dry quote; a live one without a recipient would send there (round 3, H8).
    const dry = params.dry !== false;
    const recipient = params.destAddress || (dry ? USDT0_MESH_PLACEHOLDER[dst.family] : "");
    if (!recipient) return refuse("a live quote needs a recipient");
    const encoded = meshRecipientBytes32(dst, recipient);
    if ("refusal" in encoded) return refuse(encoded.refusal);
    // Only the dry stand-in may be the zero account (that quote carries no send); a named one is a burn address.
    if (params.destAddress && encoded.to === ZERO_B32) return refuse(ZERO_RECIPIENT_REFUSAL);
    const refund = params.refundAddress || (dry ? EVM_PLACEHOLDER : "");
    if (!refund) return refuse("a live quote needs a refund address");
    if (!isAddress(refund)) return refuse("refund address must be an EVM address");
    const placeholder = dry ? placeholderIn(params) : null;
    const c = client(src.caip2);
    if (!c) return refuse(`no RPC configured for ${src.caip2}`);

    try {
      await Promise.all([verifyMeshSource(src), verifyMeshPeer(src, dst)]);
      const probe = meshSendParam(dst.eid, encoded.to, amount, 0n);
      const [limit, feeDetails, receipt] = await c.readContract({address: getAddress(src.oft), abi: MESH_ABI, functionName: "quoteOFT", args: [probe]});
      // maxAmountLD is the pool's credit toward the destination: what it can pay out there right now.
      if (amount < limit.minAmountLD) return refuse(`amount ${amount} is below the OFT minimum ${limit.minAmountLD}`);
      if (amount > limit.maxAmountLD) return refuse(`amount ${amount} exceeds the OFT maximum ${limit.maxAmountLD}`);
      const received = receipt.amountReceivedLD;
      if (received <= 0n) return refuse("amount is below the OFT dust threshold — nothing would arrive");
      if (received > amount) return refuse("OFT reports more received than sent — refusing");
      if (params.minAmountOut !== undefined && received < BigInt(params.minAmountOut)) return refuse(`received ${received} is below the caller's floor ${params.minAmountOut}`);
      const sp = meshSendParam(dst.eid, encoded.to, amount, received);
      const fee = await c.readContract({address: getAddress(src.oft), abi: MESH_ABI, functionName: "quoteSend", args: [sp, false]});
      if (fee.lzTokenFee !== 0n) return refuse("OFT asks for a fee in LZ token — unsupported");
      const nativeFee = fee.nativeFee + (fee.nativeFee * FEE_HEADROOM_BPS) / 10_000n;
      const data = encodeFunctionData({abi: MESH_ABI, functionName: "send", args: [sp, {nativeFee, lzTokenFee: 0n}, getAddress(refund)]});
      // The mesh fee (feeBps of the input, 3 bps today) is what quoteOFT keeps back; the OFT lists no fee rows for it.
      const meshFee = amount - received;
      const protocolFees = [
        ...(meshFee > 0n ? [{type: "protocol" as const, amount: meshFee.toString(), token: src.token, included: true, description: "USDT0 Legacy Mesh fee"}] : []),
        ...feeDetails.filter((f) => f.feeAmountLD > 0n).map((f) => ({type: "protocol" as const, amount: f.feeAmountLD.toString(), token: src.token, included: true, description: f.description || "OFT fee"})),
      ];
      const quote: Quote = {
        provider: "usdt0",
        intentId: `${USDT0_MESH_INTENT}:${src.eid}:${dst.eid}`,
        depositAddress: "",
        depositMemo: null,
        txRequest: {
          to: src.oft,
          data,
          value: nativeFee.toString(),
          chainId: src.chainId,
          gasLimit: GAS_SEND,
          approvalAddress: src.oft,
          ...(nativeFee > 0n ? {nativeFee: nativeFee.toString()} : {}),
        },
        sourceAmount: amount.toString(),
        destAmount: received.toString(),
        minDestAmount: received.toString(),
        feeUsd: protocolFees.reduce((a, f) => a + bigintToUnits(BigInt(f.amount), 6), 0),
        fees: protocolFees,
        etaSeconds: src.chainId === 1 ? MESH_ETA_ETHEREUM : MESH_ETA_L2,
        reliability: 0.97,
        validUntilMs: Date.now() + quoteTtlMs,
        providerData: {
          route: "legacy-mesh", srcEid: String(src.eid), dstEid: String(dst.eid), oft: src.oft, token: src.token,
          recipient, recipientBytes32: encoded.to, refundAddress: getAddress(refund),
          amountLD: amount.toString(), minAmountLD: received.toString(), nativeFee: nativeFee.toString(),
        },
      };
      // A send for a stand-in is not handed out: the price, held to the dry request (amount, floor, route, no deposit).
      if (placeholder) {
        const priced = priceOnly(quote, placeholder);
        const off = usdt0VerifyMeshSend(params, priced, src, dst);
        if (off) return refuse(`usdt0: the built Legacy Mesh send does not match the request — ${off}`);
        return priced;
      }
      // What was built, read back against the request: target, eid, recipient bytes, amounts, refund, fee, intent.
      const mismatch = usdt0VerifyMeshSend({...params, destAddress: recipient, refundAddress: refund, dry: false}, quote, src, dst);
      if (mismatch) return refuse(`usdt0: the built Legacy Mesh send does not match the request — ${mismatch}`);
      return quote;
    } catch (err) {
      return refuse(rpcSafeReason(err, src.name));
    }
  }

  /**
   * Right before signing a mesh send, with no network read until the calldata is the sealed send: the target is the
   * source chain's pinned mesh OFT (and the transaction is on that chain); the calldata is `send(SendParam, MessagingFee,
   * refund)` itself — every SendParam field exactly as built (dstEid, to, amountLD, minAmountLD, and the empty
   * extraOptions / composeMsg / oftCmd), `MessagingFee` = the sealed native fee and no LZ-token fee, the refund the
   * sealed trader. Then chain + peer, the current fee (and credits) must still fit, and `msg.value` = the sealed fee.
   */
  async function meshPreflight(quote: Quote, tx: UnsignedTx, src: Usdt0MeshSource, dst: Usdt0MeshDestination): Promise<void> {
    if (!same(tx.to, src.oft)) throw new Error(`usdt0: deposit target ${tx.to} is not the ${src.name} Legacy Mesh OFT`);
    const pd = quote.providerData ?? {};
    if (!/^\d+$/.test(pd.amountLD ?? "") || !/^\d+$/.test(pd.minAmountLD ?? "") || !/^\d+$/.test(pd.nativeFee ?? "") || !/^0x[0-9a-fA-F]{64}$/.test(pd.recipientBytes32 ?? "")
      || !meshRecipientMatches(dst, pd.recipientBytes32!, pd.recipient ?? "")) {
      throw new Error("usdt0: quote carries no sealed send parameters");
    }
    if (pd.recipientBytes32 === ZERO_B32) throw new Error(`usdt0: ${ZERO_RECIPIENT_REFUSAL}`);
    const sp = meshSendParam(dst.eid, pd.recipientBytes32 as Hex, BigInt(pd.amountLD!), BigInt(pd.minAmountLD!));
    const sealed = BigInt(pd.nativeFee!);
    let call: {functionName: string; args?: readonly unknown[]};
    let sent: typeof sp;
    try {
      call = decodeFunctionData({abi: MESH_ABI, data: (tx.data ?? "0x") as Hex});
      [sent] = call.args as unknown as [typeof sp];
    } catch {
      throw new Error("usdt0: the deposit is not the sealed Legacy Mesh send");
    }
    if (sent.dstEid !== sp.dstEid || !same(sent.to, sp.to) || sent.amountLD !== sp.amountLD || sent.minAmountLD !== sp.minAmountLD) {
      throw new Error("usdt0: the deposit is not the sealed Legacy Mesh send");
    }
    // The rest of the sealed send (review 2026-11-12): `quoteSend(sp, false)` / `quoteOFT(sp)` carry the same SendParam
    // and used to pass; so did options, a compose message, another fee or another refund address next to it.
    if (call.functionName !== "send") throw new Error(`usdt0: the deposit calls ${call.functionName}, not send(SendParam, MessagingFee, refund)`);
    for (const field of ["extraOptions", "composeMsg", "oftCmd"] as const) {
      if (String(sent[field]).toLowerCase() !== sp[field]) throw new Error(`usdt0: the deposit's SendParam.${field} ${String(sent[field])} is not the sealed ${sp[field]}`);
    }
    const [, sentFee, sentRefund] = call.args as unknown as [typeof sp, {nativeFee: bigint; lzTokenFee: bigint}, string];
    if (sentFee.nativeFee !== sealed) throw new Error(`usdt0: the deposit's MessagingFee.nativeFee ${sentFee.nativeFee} is not the sealed ${sealed}`);
    if (sentFee.lzTokenFee !== 0n) throw new Error(`usdt0: the deposit's MessagingFee.lzTokenFee ${sentFee.lzTokenFee} is not 0`);
    if (!isAddress(pd.refundAddress ?? "")) throw new Error("usdt0: quote carries no sealed refund address");
    if (getAddress(sentRefund) !== getAddress(pd.refundAddress!)) throw new Error(`usdt0: the deposit refunds ${sentRefund}, not the sealed refund address ${getAddress(pd.refundAddress!)}`);
    if ((tx.chain && tx.chain !== src.caip2) || (tx.chainId !== undefined && tx.chainId !== src.chainId)) {
      throw new Error(`usdt0: the deposit is for ${tx.chain || "?"} (chainId ${String(tx.chainId ?? "?")}), not ${src.name} (${src.caip2})`);
    }
    const c = client(src.caip2);
    if (!c) throw new Error(`usdt0: no RPC for ${src.caip2}`);
    let fee: {nativeFee: bigint};
    try {
      await Promise.all([verifyMeshSource(src), verifyMeshPeer(src, dst)]);
      // quoteSend reverts with InsufficientCredits when the pool can no longer pay this out on the destination.
      fee = await c.readContract({address: getAddress(src.oft), abi: MESH_ABI, functionName: "quoteSend", args: [sp, false]});
    } catch (err) {
      throw new Error(rpcSafeReason(err, src.name));
    }
    if (fee.nativeFee > sealed) throw new Error(`usdt0: LayerZero fee rose to ${fee.nativeFee} above the sealed ${sealed} (quote + ${FEE_HEADROOM_BPS / 100n} % headroom) — re-quote`);
    if (BigInt(tx.value) !== sealed) throw new Error(`usdt0: transaction value ${tx.value} is not the quoted fee ${sealed}`);
  }

  /**
   * A TON payout: the TON OFT's jetton transfer of the packet's amount to `0:<packet to>`, in the trace of the delivery
   * (tonapi event of the destination transaction). Completed when it is there and succeeded; failed when it is there and
   * did not; pending while the trace runs, tonapi does not answer, or no such transfer is listed yet.
   */
  async function tonPayout(dst: Usdt0MeshDestination, m: ScanMessage): Promise<IntentStatus> {
    const pending: IntentStatus = {state: "pending", depositReceived: true};
    const destHash = m.destination?.tx?.txHash;
    // SEND_OFT (msgType 2) | to (32) | amount in shared decimals (uint64; 6 = local decimals).
    const packet = /^0x0002([0-9a-fA-F]{64})([0-9a-fA-F]{16})$/.exec(m.source?.tx?.payload ?? "");
    if (!destHash || !/^(0x)?[0-9a-fA-F]{64}$/.test(destHash) || !packet) return pending;
    const recipient = `0:${packet[1]!.toLowerCase()}`;
    const amount = BigInt(`0x${packet[2]}`).toString();
    let body: {in_progress?: boolean; actions?: {type?: string; status?: string; JettonTransfer?: {sender?: {address?: string}; recipient?: {address?: string}; amount?: string; jetton?: {address?: string}}}[]};
    try {
      const res = await doFetch(`${tonApi}/v2/events/${meshDestTxHash(destHash)}`, {headers: {accept: "application/json"}, signal: timeoutSignal(TON_API_TIMEOUT_MS)});
      if (!res.ok) return pending;
      body = await res.json() as typeof body;
    } catch {
      return pending;
    }
    if (!body || body.in_progress !== false || !Array.isArray(body.actions)) return pending;
    const master = tonRawAddress(dst.token), oft = tonRawAddress(dst.oft);
    const payout = body.actions.find((a) => {
      const t = a?.type === "JettonTransfer" ? a.JettonTransfer : undefined;
      return !!t && tonRawAddress(t.jetton?.address) === master && tonRawAddress(t.sender?.address) === oft && tonRawAddress(t.recipient?.address) === recipient && t.amount === amount;
    });
    if (!payout) return pending;
    if (payout.status !== "ok") return {state: "failed", depositReceived: true};
    return {state: "completed", depositReceived: true, destTxHash: meshDestTxHash(destHash)};
  }

  async function meshTrack(ref: IntentRef, src: Usdt0MeshSource, dst: Usdt0MeshDestination): Promise<IntentStatus> {
    if (!ref.sourceTxHash) return {state: "pending"};
    try {
      const m = await scanMessage(src, dst, ref.sourceTxHash);
      if (m === null) return {state: "pending", depositReceived: false};
      if (m === "foreign") return {state: "failed"};
      const name = (m.status?.name ?? "").toUpperCase();
      if (name === "DELIVERED") {
        if (dst.family === "ton") return await tonPayout(dst, m);
        // Tron: the USDT transfer runs inside lzReceive, so a delivered packet is a paid recipient.
        const destHash = m.destination?.tx?.txHash;
        return {state: "completed", depositReceived: true, ...(destHash ? {destTxHash: meshDestTxHash(destHash)} : {})};
      }
      if (["FAILED", "APPLICATION_BURNED", "APPLICATION_SKIPPED", "UNRESOLVABLE_COMMAND", "MALFORMED_COMMAND"].includes(name)) return {state: "failed", depositReceived: true};
      // PAYLOAD_STORED: the retry is an lzReceive on Tron / TON, which nothing here signs — LayerZero / USDT0 retry it.
      return {state: "pending", depositReceived: true};
    } catch {
      return {state: "pending"};
    }
  }

  return {
    name: "usdt0",
    describeActivity: describeUsdt0Activity,
    claimTargets: usdt0ClaimTargets,
    enabled: () => config.enabled ?? true,
    // Tron / TON are destinations only (each when meshDestinations names it): supported while some mesh source has an RPC,
    // never as the source of a pair.
    supportsChain: (chain: string) => meshDestinationFor(chain)
      ? !!meshOn(chain) && Object.keys(USDT0_MESH_SOURCES).some((c) => client(c) !== null)
      : usdt0Cfg.supportsSourceChain(chain, meshFamilies) && client(chain) !== null,
    supportsChainPair: (from: string, to: string) => usdt0Cfg.supports(from, to, meshFamilies) && client(from) !== null,
    supportsRoute(from: Asset, to: Asset): boolean {
      const meshDst = meshOn(to.chain);
      if (meshDst) {
        const meshSrc = meshSourceFor(from.chain);
        return !!meshSrc && client(from.chain) !== null && tokenMatches(meshSrc, from.token) && meshDestTokenMatches(meshDst, to.token);
      }
      const src = USDT0_CHAINS[from.chain];
      const dst = USDT0_CHAINS[to.chain];
      if (!src || !dst || src === dst || client(from.chain) === null) return false;
      return tokenMatches(src, from.token) && tokenMatches(dst, to.token);
    },

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      const refuse = (reason: string) => { params.onRefusal?.(reason); return null; };
      if (params.flex) return refuse("the amount is sealed into the calldata (no flexible deposits)");
      // Tron / TON never send here (a send from them is signed on that chain); a source without a mesh OFT, or a mesh
      // destination this provider does not offer, is not a mesh route: all of them keep the answer they had before the mesh.
      if (meshDestinationFor(params.sourceChain)) return refuse("USDT0 is not deployed on this chain");
      const meshDst = meshOn(params.destChain);
      const meshSrc = meshSourceFor(params.sourceChain);
      if (meshDst && meshSrc) return meshQuote(params, meshSrc, meshDst, refuse);
      const src = USDT0_CHAINS[params.sourceChain];
      const dst = USDT0_CHAINS[params.destChain];
      if (!src || !dst) return refuse("USDT0 is not deployed on this chain");
      if (src === dst) return refuse("same-chain transfers are not a bridge");
      if (!tokenMatches(src, params.sourceToken)) return refuse(`source token ${params.sourceToken} is not USDT0 (${src.token}) on ${src.name}`);
      if (!tokenMatches(dst, params.destToken)) return refuse(`destination token ${params.destToken} is not USDT0 (${dst.token}) on ${dst.name}`);
      if (!/^\d+$/.test(params.amountIn)) return refuse("amount must be a base-unit integer");
      const amount = BigInt(params.amountIn);
      if (amount <= 0n) return refuse("amount must be positive");
      // The placeholder prices a dry quote; a live one without addresses would send there (round 3, H8).
      const dry = params.dry !== false;
      const recipient = params.destAddress || (dry ? EVM_PLACEHOLDER : "");
      if (!recipient) return refuse("a live quote needs a recipient");
      if (!isAddress(recipient)) return refuse("destination must be an EVM address");
      // Nothing paid to the zero address comes back: burned, or a packet stored for good.
      if (isZeroEvmAddress(recipient)) return refuse(ZERO_RECIPIENT_REFUSAL);
      const refund = params.refundAddress || (dry ? EVM_PLACEHOLDER : "");
      if (!refund) return refuse("a live quote needs a refund address");
      if (!isAddress(refund)) return refuse("refund address must be an EVM address");
      // vitalik.eth stands in for a missing address: its send would pay or refund vitalik.eth, so only the price is kept.
      const placeholder = dry ? placeholderIn(params) : null;
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
        // Sealed with headroom: OAppSender requires msg.value == MessagingFee.nativeFee, the
        // endpoint refunds whatever the current fee does not use to `refund`.
        const nativeFee = fee.nativeFee + (fee.nativeFee * FEE_HEADROOM_BPS) / 10_000n;
        const data = encodeFunctionData({abi: OFT_ABI, functionName: "send", args: [sp, {nativeFee, lzTokenFee: 0n}, getAddress(refund)]});
        const protocolFees = feeDetails
          .filter((f) => f.feeAmountLD > 0n)
          .map((f) => ({type: "protocol" as const, amount: f.feeAmountLD.toString(), token: src.token, included: true, description: f.description || "OFT fee"}));
        const feeUsd = protocolFees.reduce((a, f) => a + Number(f.amount) / 1e6, 0);
        // Ethereum sources wait for 60 confirmations before the DVNs attest (~15 min live); L2 sources land in a few minutes.
        const eta = src.chainId === 1 ? 1000 : 240;
        const quote: Quote = {
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
        return placeholder ? priceOnly(quote, placeholder) : quote;
      } catch (err) {
        return refuse(rpcSafeReason(err, src.name));
      }
    },

    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      // A dry quote priced for a stand-in recipient or refund address is never built, even with a transaction attached.
      const placeholder = quote.providerData?.placeholder;
      if (placeholder !== undefined) throw new Error(placeholderBuildRefusal(placeholder));
      const tx = quote.txRequest;
      const parsed = parseIntent(quote.intentId) ?? parseMeshIntent(quote.intentId);
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
     * `msg.value` (quote + headroom) — the endpoint reverts a send that
     * underpays, so a fee past the headroom means re-quote rather than a
     * wasted broadcast.
     */
    async preflightDeposit(quote: Quote, tx: UnsignedTx): Promise<void> {
      const placeholder = quote.providerData?.placeholder;
      if (placeholder !== undefined) throw new Error(placeholderPreflightRefusal(placeholder));
      const mesh = parseMeshIntent(quote.intentId);
      if (mesh) return meshPreflight(quote, tx, mesh.src, mesh.dst);
      const parsed = parseIntent(quote.intentId);
      if (!parsed) throw new Error("usdt0: malformed intent id");
      const {src, dst} = parsed;
      if (!same(tx.to, src.oft)) throw new Error(`usdt0: deposit target ${tx.to} is not the ${src.name} OFT`);
      const pd = quote.providerData ?? {};
      if (!/^\d+$/.test(pd.amountLD ?? "") || !/^\d+$/.test(pd.minAmountLD ?? "") || !/^\d+$/.test(pd.nativeFee ?? "") || !isAddress(pd.recipient ?? "")) {
        throw new Error("usdt0: quote carries no sealed send parameters");
      }
      if (isZeroEvmAddress(pd.recipient)) throw new Error(`usdt0: ${ZERO_RECIPIENT_REFUSAL}`);
      const c = client(src.caip2);
      if (!c) throw new Error(`usdt0: no RPC for ${src.caip2}`);
      const sp = sendParam(dst.eid, pd.recipient!, BigInt(pd.amountLD!), BigInt(pd.minAmountLD!));
      let fee: {nativeFee: bigint};
      try {
        await Promise.all([verifyChain(src), verifyPeer(src, dst)]);
        fee = await c.readContract({address: getAddress(src.oft), abi: OFT_ABI, functionName: "quoteSend", args: [sp, false]});
      } catch (err) {
        throw new Error(rpcSafeReason(err, src.name));
      }
      const sealed = BigInt(pd.nativeFee!);
      if (fee.nativeFee > sealed) throw new Error(`usdt0: LayerZero fee rose to ${fee.nativeFee} above the sealed ${sealed} (quote + ${FEE_HEADROOM_BPS / 100n} % headroom) — re-quote`);
      if (BigInt(tx.value) !== sealed) throw new Error(`usdt0: transaction value ${tx.value} is not the quoted fee ${sealed}`);
    },

    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      const mesh = parseMeshIntent(ref.intentId);
      if (mesh) return meshTrack(ref, mesh.src, mesh.dst);
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
      // A stored mesh payload is retried on Tron / TON, where nothing here signs: no claim.
      if (parseMeshIntent(ref.intentId)) return null;
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
