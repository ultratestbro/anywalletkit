import {Address as TonAddress, Cell as TonCell} from "@ton/core";
import {describeOmnistonActivity} from "./activity.js";
import "./buffer-global.js";
import {Buffer} from "buffer";
import {encodeAbiParameters, getAddress, hexToBytes as viemHexToBytes, keccak256, sha256} from "viem";
import {ccAsset, ccAssetByToken, type CcAsset} from "@anywalletkit/swap2-assets";
import {omniston as cfg} from "./config.js";
import {checkTonSwapPayload, TonSwapPayloadError, type TonSwapCheckResult, type TonSwapLeg} from "./ton-swap.js";
export {checkTonSwapPayload, TonSwapPayloadError, TON_SWAP_PROTOCOL_LAYOUTS} from "./ton-swap.js";
export type {TonSwapLeg, TonSwapCheckInput, TonSwapCheckResult} from "./ton-swap.js";
import type {Asset, CrossChainProvider, IntentRef, IntentStatus, Quote, QuoteParams, UnsignedTx} from "@anywalletkit/protocol-swap2-core/types";
import {bigintToNumber} from "@anywalletkit/core";

/**
 * Omniston (STON.fi) — TON ↔ EVM stable corridors over a WebSocket RFQ
 * (`@ston-fi/omniston-sdk`), settled through HTLC orders (resolver `Arbiter`,
 * ~$1000/swap cap). This is the audited server/module-side adaptation; the
 * legacy browser-direct execution path is disabled.
 *
 *  - getQuote: opens an RFQ stream, collects `quoteUpdated` for a short window,
 *    returns the latest quote normalized to the engine `Quote`.
 *  - buildDeposit (TON-source): generates the HTLC secret(s), persists them
 *    in the injectable {@link HtlcSecretStore}, asks the SDK for the escrow
 *    transfer and returns it as an `UnsignedTx` with a serialized cell body
 *    (`bodyBoc`) — NOT a text memo.
 *  - buildDeposit (EVM-source, EVM→TON): generates the secret, asks the SDK for
 *    the EIP-712 order (Omniston's 1inch-LOP fork), verifies every signed byte
 *    against the quote (order fields, extension, serialized order details) and
 *    returns a gasless typed-order `UnsignedTx`; `registerSignedOrder` hands
 *    the wallet's signature back to Omniston. Needs `trustedEvmOrderProtocols`
 *    plus the EVM input-position and TON output-position validators.
 *  - trackIntent: treats `orderTrack` only as a discovery hint and discloses a
 *    pending secret only after independent finalized validation of the
 *    counter-position (EVM escrow for TON→EVM; EVM source fill AND TON output
 *    position for EVM→TON).
 *
 * CONSUMER CONTRACT — closing an intent is the caller's job. `trackIntent`
 * never returns a terminal refunded/failed state, not even on a reported
 * cancellation, because a resolver-controlled feed is not proof that the
 * signed source order can no longer fill. An integration without its own
 * chain-backed backstop will therefore report an already-refunded escrow as
 * pending indefinitely: close such intents by observing the exact input amount
 * returning from an allowlisted settlement contract to the trader's wallet.
 *
 * CONSUMER CONTRACT — `validateEvmOutputPosition` decides whether the swap can
 * complete at all, so verify what a resolver actually does on chain. It does
 * NOT call the escrow factory directly: the destination escrow is deployed
 * through the resolver's own contract, so the transaction targets that
 * contract, carries a private selector and usually sends no value, while the
 * factory only emits `DstEscrowCreated`. A verifier that expects a direct
 * `createDstEscrow` call therefore rejects every legitimate escrow, the secret
 * is never disclosed, and both positions roll back — which looks exactly like a
 * venue that quotes and walks away. Anchor on evidence the wrapper cannot
 * forge: the factory's own event for your hashlock, the escrow's `FACTORY()`,
 * and the balances it actually holds.
 *
 * The HTLC secret is the difference between "swap completes" and "funds sit in
 * escrow until the refund timeout". The default store is in-memory — fine for a
 * long-lived process, NOT for serverless. Callers on serverless MUST inject a
 * durable store.
 */

/** CAIP-2 eip155 refs → the SDK's chain `$case` names. */
const EVM_CASE: Record<number, "ethereum" | "bnb" | "base" | "arbitrum" | "avalanche" | "polygon" | "robinhood" | "xlayer" | "hyperevm" | "plasma"> = {
  1: "ethereum",
  56: "bnb",
  137: "polygon",
  196: "xlayer",
  999: "hyperevm",
  4663: "robinhood",
  8453: "base",
  9745: "plasma",
  42161: "arbitrum",
  43114: "avalanche",
};

const TON_NS = "ton";
const INTENT_PREFIX = "omn1";
/** How long getQuote lets resolvers compete before taking the latest quote. */
const QUOTE_SETTLE_MS = 3_000;
/**
 * Execution quotes settle far sooner than display ones. A resolver's
 * `tradeStartDeadline` is only ~25-30s away, and it is measured to the escrow
 * being ON-CHAIN — not to the broadcast — so every second spent collecting
 * competing offers is a second the source leg no longer has to be built,
 * signed, broadcast and included. A late escrow is not filled and sits until
 * the HTLC refunds, which costs the trader far more than the price difference
 * between the first quote and the best of a 3s auction on a stable corridor.
 */
const EXECUTION_SETTLE_MS = 600;
/**
 * Refuse to build an escrow that cannot realistically reach the chain before
 * `tradeStartDeadline`: signing, broadcast and TON inclusion need roughly this
 * long, and funding a doomed escrow locks the trader's money until the HTLC
 * times out. Failing here is instant and costs nothing.
 */
const MIN_START_HEADROOM_MS = 12_000;
/** Hard ceiling on waiting for the FIRST quote (router timeout is 8s). */
const QUOTE_MAX_MS = 6_500;
/** One orderTrack snapshot per trackIntent call. */
const TRACK_SNAPSHOT_MS = 6_000;
// One execution: the live TON escrow commits a single hash and the EVM order is
// single-fill, so more secrets only make the TON payload validator refuse.
const DEFAULT_MAX_HTLC_EXECUTIONS = 1;
/** Normalized quote validity shown to the router/UI. */
const QUOTE_TTL_MS = 45_000;
/** Quote/security context must outlive delayed fills and cancellation signals. */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
/**
 * Context entries written before intent binding (scan F3/F15) carry no bound
 * trader/dest/srcChain/kind. They are honoured — with a `legacy-intent` trace —
 * only while younger than this (the store TTL), then disclosure is refused.
 */
const LEGACY_INTENT_WINDOW_MS = 6 * 60 * 60 * 1000;

// ── HTLC secret store (injectable) ───────────────────────────────────────────

/**
 * Persists HTLC secret preimages by quoteId between buildDeposit and the
 * trackIntent poll that discloses them. Losing a secret does NOT lose funds —
 * the escrow refunds after the HTLC timeout — but it does fail the swap.
 */
export interface HtlcSecretStore {
  save(quoteId: string, secretsHex: string[]): void | Promise<void>;
  load(quoteId: string): string[] | undefined | Promise<string[] | undefined>;
  clear(quoteId: string): void | Promise<void>;
}

/**
 * Persists the quote/build context between getQuote, buildDeposit and
 * registerSignedOrder. On SERVERLESS these run on different instances, so the
 * default in-memory map strands executions ("quote expired") — inject a
 * durable store there. Values are JSON-safe (byte fields base64-encoded).
 */
export interface OmnistonQuoteStore {
  save(quoteId: string, valueJson: string): void | Promise<void>;
  load(quoteId: string): string | undefined | Promise<string | undefined>;
  clear(quoteId: string): void | Promise<void>;
}

/** Default quote store — long-lived processes and tests only. */
export function inMemoryQuoteStore(): OmnistonQuoteStore {
  const map = new Map<string, string>();
  return {
    save: (id, v) => void map.set(id, v),
    load: (id) => map.get(id),
    clear: (id) => void map.delete(id),
  };
}

/** Default store — suitable for long-lived processes and tests only. */
export function inMemorySecretStore(): HtlcSecretStore {
  const map = new Map<string, string[]>();
  return {
    save: (id, secrets) => void map.set(id, secrets),
    load: (id) => map.get(id),
    clear: (id) => void map.delete(id),
  };
}

// ── Minimal structural view of the SDK client (injectable for tests) ─────────

interface ObservableLike<T> {
  subscribe(observer: {next?: (value: T) => void; error?: (err: unknown) => void; complete?: () => void}): {unsubscribe(): void};
}

/** Self-contained structural SDK types. Keeping these local prevents the
 * optional Omniston peer from leaking into every consumer's declaration graph. */
interface AssetId {
  chain: {
    $case: string;
    value: string | {kind?: {$case: string; value?: unknown}};
  };
}

interface ChainAddress {
  chain: {$case: string; value: string};
}

interface QuoteRequest {
  inputAsset: AssetId;
  outputAsset: AssetId;
  amount: {$case: string; value: string};
  settlementParams: {params: {$case: string; value: Record<string, unknown>}}[];
  integratorAddress?: ChainAddress;
  integratorFeePips?: number;
}

interface OmnistonQuote {
  rfqId: string;
  quoteId: string;
  inputAsset: AssetId;
  outputAsset: AssetId;
  inputUnits: string;
  outputUnits: string;
  protocolFeeUnits?: string;
  integratorFeeUnits?: string;
  integratorAddress?: ChainAddress;
  quoteTimestamp: number;
  /** Total TON the trade needs on top of the input (swap settlement); omitted for gasless quotes. */
  gasBudget?: string | undefined;
  /** Omniston's estimate of the gas the route actually burns (swap settlement); the rest of the budget returns. */
  estimatedGasConsumption?: string | undefined;
  settlementData: {$case: "order"; value: OrderSettlement} | {$case: "swap"; value: SwapSettlement};
}

/** Order settlement (HTLC / escrow) — the cross-chain branch. */
interface OrderSettlement {
  srcProtocolContractAddress: ChainAddress;
  dstProtocolContractAddress?: ChainAddress;
  srcInitialResolverAddress?: ChainAddress;
  resolverSendsUnits: string;
  srcHtlcSecurityDepositUnits?: string;
  dstSecurityDepositUnits?: string;
  tradeStartDeadline: number;
  /**
   * Seconds after the trader creates the position before a resolver must
   * reserve it; after that the position is withdrawable by the trader (SDK
   * docs). The TON escrow config carries it, so the payload validator binds
   * the built escrow to the quoted value.
   */
  exclusivityTimeout?: number;
  htlcHashingFunction?: string;
  /** Fee profile the EVM order extension must mirror (EVM-source orders). */
  protocolFeePips?: number;
  integratorFeePips?: number;
  /** Destination-chain wallet the protocol fee must be paid to (EVM-destination
   *  orders); the EVM output validator binds the escrow's fee split to it. */
  protocolFeeRecipientAddress?: ChainAddress;
}

/** Swap settlement — immediate DEX routes, the TON same-chain branch. */
interface SwapSettlement {
  routes: {steps: {inputAsset?: AssetId; outputAsset?: AssetId; chunks: {protocol: string; inputUnits: string; outputUnits: string}[]}[]}[];
  minOutputAmount: string;
  recommendedMinOutputAmount?: string;
  recommendedSlippagePips?: number;
  priceImpactPips?: number | undefined;
}

type RfqEvent =
  | {$case: "ack"; value: {rfqId: string}}
  | {$case: "quoteUpdated"; rfqId?: string; value: OmnistonQuote}
  | {$case: "noQuote"; rfqId?: string; value: unknown}
  | {$case: string; value?: unknown};

interface EscrowMessage {
  targetAddress: string;
  sendAmount: string;
  payload: string; // hex-encoded cell BoC
  jettonWalletStateInit?: string | undefined;
}

interface OrderExecution {
  index: number;
  inputUnits: string;
  outputUnits: string;
  resolverSendsUnits: string;
  secretHash?: Uint8Array | undefined;
  inputPositionPhase?: string | undefined;
  inputPositionAddress?: ChainAddress | undefined;
  outputPositionPhase?: string | undefined;
  outputPositionAddress?: ChainAddress | undefined;
}

interface OrderSnapshot {
  status: string;
  executions: OrderExecution[];
}

type OrderEvent = {$case: "order"; value: OrderSnapshot} | {$case: string; value?: unknown};

type SwapTrackEvent =
  | {$case: "awaitingTransfer"; value?: unknown}
  | {$case: "progress"; value: {status: string; outgoingTxHash?: string}}
  | {$case: string; value?: unknown};

/** The slice of `Omniston` this provider uses — a real instance satisfies it. */
export interface OmnistonClientLike {
  requestForQuote(request: QuoteRequest): ObservableLike<RfqEvent>;
  tonBuildEscrowTransfer(request: {
    quoteId: string;
    ownerSrcAddress: ChainAddress;
    transferSrcAddress: ChainAddress;
    refundSrcAddress: ChainAddress;
    gasExcessAddress: ChainAddress;
    traderDstAddress: ChainAddress;
    htlcSecrets: {secretMode: {$case: "provided"; value: {hashes: Uint8Array[]}}};
  }): Promise<{messages: EscrowMessage[]}>;
  evmBuildOrderPayload(request: {
    quoteId: string;
    ownerSrcAddress: ChainAddress;
    traderDstAddress?: ChainAddress;
    htlcSecrets?: {secretMode: {$case: "provided"; value: {hashes: Uint8Array[]}}};
  }): Promise<{typedData: string; orderExtension: Uint8Array; serializedOrderDetails?: Uint8Array | undefined}>;
  orderRegisterSignedOrder(request: {
    quoteId: string;
    ownerSrcAddress: ChainAddress;
    signedOrder: {order: {$case: "evmV1"; value: {encodedOrder: Uint8Array; signature: Uint8Array; orderExtension: Uint8Array}}};
    serializedOrderDetails?: Uint8Array | undefined;
  }): Promise<void>;
  /** Swap settlement (TON↔TON). Optional so older injected clients keep working; without them same-chain swaps fail closed. */
  tonBuildSwap?(request: {
    quoteId: string;
    transferSrcAddress: ChainAddress;
    refundSrcAddress: ChainAddress;
    gasExcessAddress: ChainAddress;
    traderDstAddress: ChainAddress;
    useRecommendedSlippage?: boolean;
  }): Promise<{messages: EscrowMessage[]}>;
  swapTrack?(request: {quoteId: string; traderAddress: ChainAddress; outgoingTxQuery: string}): ObservableLike<SwapTrackEvent>;
  orderTrack(request: {quoteId: string; traderAddress: ChainAddress}): ObservableLike<OrderEvent>;
  orderDiscloseHtlcSecret(request: {quoteId: string; executionIndex: number; secret: Uint8Array}): Promise<void>;
  close?: () => void;
  transport?: {close(): void};
}

export interface OmnistonProviderOptions {
  /** Injected SDK client (tests); defaults to a lazy `new Omniston({apiUrl})`. */
  client?: OmnistonClientLike;
  /** WebSocket API URL; defaults to the public ston.fi endpoint. */
  apiUrl?: string;
  /** HTLC preimage persistence; defaults to in-memory (NOT serverless-safe). */
  secretStore?: HtlcSecretStore;
  /** Quote/build context persistence; defaults to in-memory (NOT serverless-safe). */
  quoteStore?: OmnistonQuoteStore;
  /** Maximum number of HTLC execution attempts covered by generated secrets. */
  maxHtlcExecutions?: number;
  /** Hard cap for resolver-requested TON gas/forward value (default: 2 TON). */
  maxTonExecutionNano?: string;
  /** Resolver competition window; primarily useful for deterministic tests. */
  quoteSettleMs?: number;
  /** Explicit constructor configuration; no deployment environment is read. */
  enabled?: boolean;
  /** Exact decimal USD cap; string form avoids binary-float rounding. */
  maxUsd?: number | string;
  integratorAddress?: string;
  integratorFeePips?: number;
  /** Independently trusted settlement contracts, keyed by CAIP-2 chain. */
  trustedSettlementContracts?: Readonly<Record<string, readonly string[]>>;
  /**
   * Independently trusted EVM order protocols — the Omniston fork of the 1inch
   * Limit Order Protocol an EVM-source order is signed against and that moves
   * the input token on fill — keyed by CAIP-2 chain. Kept apart from
   * `trustedSettlementContracts` because one address plays different roles on
   * different chains (0xafCF… is the escrow factory on Ethereum and the order
   * protocol on Polygon). EVM→TON is advertised only for chains listed here.
   */
  trustedEvmOrderProtocols?: Readonly<Record<string, readonly string[]>>;
  /**
   * RPC-backed TON jetton-wallet verification. A TON-source order is rejected
   * when this hook is absent or does not prove that `walletAddress` belongs to
   * the quoted jetton master for `ownerAddress`.
   */
  validateTonJettonWallet?: (input: {
    ownerAddress: string;
    jettonMasterAddress: string;
    walletAddress: string;
  }) => boolean | Promise<boolean>;
  /**
   * Independent semantic verifier for the Omniston TON escrow forward cell.
   * The resolver-built BoC is never accepted through byte-search heuristics.
   * A TON-source route is disabled unless this hook parses the documented
   * contract schema and proves every expected field below in its exact slot.
   */
  /**
   * TON↔TON swap settlement: independently confirm that the contract a swap
   * message pays into — directly for native GRAM, as the jetton-transfer
   * destination for jettons — is a DEX contract of a protocol the quote named
   * (e.g. by its code interface on an indexer). Without it, same-chain TON
   * swaps are not advertised.
   */
  validateTonSwapTarget?: (input: {address: string; protocols: readonly string[]}) => Promise<boolean> | boolean;
  /**
   * TON↔TON swap settlement (scan F11): confirm one chain fact the decoded
   * swap body depends on — that a STON.fi hop's ask wallet is its router's
   * wallet of the quoted output (and, for native input, that the pTON wallet
   * the message pays belongs to that router), or that a DeDust pool trades the
   * quoted pair. `createOmnistonTonValidators` supplies it. When absent the
   * decoded-body rules still apply and each skipped leg is traced as
   * `ton-swap-payload legs-unverified`; STON.fi v1 native input (pTON v1) is
   * refused without it.
   */
  validateTonSwapLeg?: (leg: TonSwapLeg) => Promise<boolean> | boolean;
  /**
   * TON↔TON swap settlement (scan F11): what a built swap body that fails the
   * decoder (receiver ≠ destination, refund/excess ≠ trader, on-chain minimum
   * below the quote, unknown layout, unverifiable leg) does. "enforce"
   * (default) refuses the build; "report" traces `ton-swap-payload <reason>`
   * and still builds — a rollout escape hatch, not a steady state.
   */
  tonSwapPayloadCheck?: "report" | "enforce";
  validateTonEscrowPayload?: (input: {
    payloadBocHex: string;
    forwardPayloadBocHex: string;
    quoteId: string;
    inputUnits: string;
    resolverSendsUnits: string;
    srcHtlcSecurityDepositUnits: string;
    protocolAddress: string;
    ownerAddress: string;
    destinationChain: string;
    destinationAddress: string;
    outputTokenAddress: string;
    initialResolverAddress: string;
    secretHashes: readonly Uint8Array[];
    hashingFunction?: string;
    /** The quote's `exclusivityTimeout` (seconds) the escrow config must carry. */
    exclusivityTimeout: number;
  }) => boolean | Promise<boolean>;
  /**
   * RPC-backed proof of the destination EVM escrow. The tracking feed is only
   * a discovery hint: no HTLC preimage is disclosed until this hook proves the
   * independently finalized on-chain position matches the signed quote.
   */
  validateEvmOutputPosition?: (input: {
    chain: string;
    positionAddress: string;
    factoryAddress: string;
    quoteTimestamp: number;
    executionIndex: number;
    recipientAddress: string;
    outputTokenAddress: string;
    inputUnits: string;
    outputUnits: string;
    resolverSendsUnits: string;
    srcHtlcSecurityDepositUnits: string;
    dstSecurityDepositUnits: string;
    protocolFeeUnits: string;
    integratorFeeUnits: string;
    integratorAddress?: string;
    /** The quote's `settlementData.protocolFeeRecipientAddress` (destination chain). */
    protocolFeeRecipientAddress?: string;
    secretHash: Uint8Array;
  }) => boolean | Promise<boolean>;
  /**
   * RPC-backed proof of the finalized EVM source position (EVM→TON). The
   * tracking feed only hints at the address; no secret is disclosed until this
   * hook proves — from the trusted factory's own `SrcEscrowCreated` event, the
   * deterministic escrow address and the escrow's balances — that the
   * trader's FULL input is locked for this hashlock under the quoted terms
   * (owner, token, amount, resolver, deposit, timelocks, TON output amount).
   */
  validateEvmInputPosition?: (input: {
    chain: string;
    positionAddress: string;
    factoryAddress: string;
    orderProtocolAddress: string;
    ownerAddress: string;
    resolverAddress: string;
    inputTokenAddress: string;
    inputUnits: string;
    resolverSendsUnits: string;
    srcHtlcSecurityDepositUnits: string;
    quoteTimestamp: number;
    secretHash: Uint8Array;
    /** EVM destination only: the escrow event's destination complement must name this chain, token and deposit. */
    destinationChainId?: number;
    destinationTokenAddress?: string;
    dstSecurityDepositUnits?: string;
  }) => boolean | Promise<boolean>;
  /**
   * Indexer/RPC-backed proof of the TON output position (EVM→TON): deployed by
   * the trusted factory for THIS quote, pinned position/escrow code, hashlock,
   * recipient, amount, security deposit, and a cancellation boundary still far
   * enough away to complete. The tracking feed is only a discovery hint.
   */
  validateTonOutputPosition?: (input: {
    positionAddress: string;
    protocolAddress: string;
    outputJettonMasterAddress: string;
    recipientAddress: string;
    quoteId: string;
    quoteTimestamp: number;
    inputUnits: string;
    outputUnits: string;
    resolverSendsUnits: string;
    dstSecurityDepositUnits: string;
    secretHash: Uint8Array;
  }) => boolean | Promise<boolean>;
  /**
   * EVM destination: find the delivery transaction — the destination escrow's
   * payout to the recipient — so a completed order carries `destTxHash`.
   * Omniston's tracking feed names the escrow but not that transaction.
   */
  locateEvmDelivery?: (input: {
    chain: string;
    positionAddress: string;
    recipientAddress: string;
    tokenAddress: string;
    minUnits: string;
  }) => Promise<string | null>;
  /**
   * TON destination: find the delivery — the output position's jetton transfer
   * to the recipient — so a completed EVM → TON order carries `destTxHash` in
   * the form the TON history source uses (tonapi event id). Without it the
   * wallet's feed cannot pair the TON receive with the swap.
   */
  locateTonDelivery?: (input: {
    positionAddress: string;
    recipientAddress: string;
    jettonMasterAddress: string;
    minUnits: string;
  }) => Promise<string | null>;
  /** Close an injected client when the provider closes (default: caller owns it). */
  closeInjectedClient?: boolean;
  /**
   * Diagnostics: why a poll did not disclose (`disclosure-skipped` with the gate
   * and its fields, `validator-refused`, `validator-threw`) and when it did
   * (`secret-disclosed`). Never carries secrets. Wire it to your logger: a
   * silent "pending" cost a live order its 2-minute window (2026-10-20).
   */
  trace?: (event: string, details?: Record<string, unknown>) => void;
}

// ── Chain / asset mapping ────────────────────────────────────────────────────

function evmRef(caip2: string): number | null {
  if (!caip2.startsWith("eip155:")) return null;
  const n = Number(caip2.slice("eip155:".length));
  return Number.isInteger(n) ? n : null;
}

function isTon(caip2: string): boolean {
  return caip2.split(":")[0] === TON_NS;
}

function caipForChainCase($case: string): string | null {
  if ($case === "ton") return "ton:-239";
  const entry = Object.entries(EVM_CASE).find(([, value]) => value === $case);
  return entry ? `eip155:${entry[0]}` : null;
}

/** Catalog asset → SDK AssetId. Stable corridors only: a `contract` is REQUIRED
 *  (jetton master / ERC-20) — native assets have no Omniston order corridor. */
function toAssetId(caip2: string, asset: CcAsset, allowNative = false): AssetId | null {
  if (!asset.contract) {
    // Native GRAM only exists on the swap-settlement branch (same-chain DEX routes).
    return allowNative && isTon(caip2) ? {chain: {$case: "ton", value: {kind: {$case: "native", value: {}}}}} : null;
  }
  if (isTon(caip2)) {
    return {chain: {$case: "ton", value: {kind: {$case: "jetton", value: asset.contract}}}};
  }
  const ref = evmRef(caip2);
  const $case = ref === null ? undefined : EVM_CASE[ref];
  if (!$case) return null;
  return {chain: {$case, value: {kind: {$case: "erc20", value: getAddress(asset.contract)}}}};
}

function toChainAddress(caip2: string, address: string): ChainAddress | null {
  if (isTon(caip2)) return {chain: {$case: "ton", value: address}};
  const ref = evmRef(caip2);
  const $case = ref === null ? undefined : EVM_CASE[ref];
  if (!$case) return null;
  return {chain: {$case, value: getAddress(address)}};
}

// ── intentId: quoteId + the trader/dest context tracking and building need ───

function encodeIntent(quoteId: string, trader: string, dest: string, srcChain: string, kind: "order" | "swap" = "order"): string {
  // Swap-settlement intents carry a sixth segment so tracking can branch
  // without the (TTL-bound) quote cache; order intents keep the legacy shape.
  return [INTENT_PREFIX, quoteId, trader, dest, srcChain, ...(kind === "swap" ? ["swap"] : [])].map(encodeURIComponent).join("|");
}

/**
 * A quote id is a 256-bit value in hex WITHOUT leading-zero padding (live
 * 2026-10-12: 63-char ids, ~1 in 16 quotes) — requiring exactly 64 chars
 * refused those as "malformed quote id". Binary comparisons pad it to 32 bytes.
 */
const QUOTE_ID = /^[0-9a-fA-F]{48,64}$/;

function decodeIntent(
  intentId: string,
): {quoteId: string; trader: string; dest: string; srcChain: string; kind: "order" | "swap"} | null {
  try {
    const parts = intentId.split("|");
    if ((parts.length !== 5 && parts.length !== 6) || parts[0] !== INTENT_PREFIX) return null;
    const [, quoteId = "", trader = "", dest = "", srcChain = "", kindPart = ""] = parts.map(decodeURIComponent);
    if (!QUOTE_ID.test(quoteId) || !trader || !dest || !srcChain) return null;
    if (parts.length === 6 && kindPart !== "swap") return null;
    return {quoteId, trader, dest, srcChain, kind: parts.length === 6 ? "swap" : "order"};
  } catch {
    return null;
  }
}

/**
 * What an intentId was minted for, persisted with the quote at getQuote time
 * (scan F3/F15). The intentId itself is an unsigned caller-supplied string: the
 * stored copy — never the decoded one — names the trader and recipient the
 * secret-release validators, the builders and the delivery locators check.
 */
interface IntentBinding {
  trader: string;
  dest: string;
  srcChain: string;
  kind: "order" | "swap";
}

/** Same address in another spelling: EVM case-insensitive, TON any notation. */
function sameIntentAddress(a: string, b: string): boolean {
  if (a === b) return true;
  const evm = /^0x[0-9a-fA-F]{40}$/;
  if (evm.test(a) || evm.test(b)) return evm.test(a) && evm.test(b) && a.toLowerCase() === b.toLowerCase();
  try {
    return TonAddress.parse(a).equals(TonAddress.parse(b));
  } catch {
    return false;
  }
}

/** EIP-712 typed data → the ABI-encoded order struct `SignedOrderEvmV1` wants.
 *  Structs referenced in `types` become tuples, recursively. */
export function encodeTypedMessage(td: {
  types: Record<string, {name: string; type: string}[]>;
  primaryType: string;
  message: unknown;
}): Uint8Array {
  type AbiParam = {type: string; name?: string; components?: AbiParam[]};
  const paramFor = (typeName: string, name?: string): AbiParam => {
    const isArray = typeName.endsWith("[]");
    const base = isArray ? typeName.slice(0, -2) : typeName;
    const fields = td.types[base];
    if (!fields) return {type: typeName, ...(name ? {name} : {})};
    return {
      type: isArray ? "tuple[]" : "tuple",
      ...(name ? {name} : {}),
      components: fields.map((f) => paramFor(f.type, f.name)),
    };
  };
  return viemHexToBytes(
    encodeAbiParameters([paramFor(td.primaryType)] as never, [td.message] as never),
  );
}

// ── HTLC helpers (ported from app/lib/omniston/htlc.ts) ──────────────────────

function generateSecret(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

function hashlock(secret: Uint8Array, hashingFunction: string | undefined): Uint8Array {
  switch (hashingFunction) {
    case "HASHING_FUNCTION_KECCAK256":
      return keccak256(secret, "bytes");
    case "HASHING_FUNCTION_SHA256":
      return sha256(secret, "bytes");
    default:
      throw new Error(`omniston: unsupported HTLC hashing function ${String(hashingFunction)}`);
  }
}

function sameAsset(a: AssetId, b: AssetId): boolean {
  const key = (asset: AssetId): string => {
    const chain = asset.chain;
    const value = chain.value as {kind?: {$case: string; value?: unknown}} | string;
    const normalize = (text: string) => chain.$case === "ton" ? text : text.toLowerCase();
    if (typeof value === "string") return `${chain.$case}:${normalize(value)}`;
    const kind = value.kind;
    return `${chain.$case}:${kind?.$case ?? ""}:${typeof kind?.value === "string" ? normalize(kind.value) : JSON.stringify(kind?.value ?? null)}`;
  };
  return key(a) === key(b);
}

function sameChainAddress(a: ChainAddress | undefined, b: ChainAddress | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  if (a.chain.$case !== b.chain.$case) return false;
  if (a.chain.$case !== "ton") return a.chain.value.toLowerCase() === b.chain.value.toLowerCase();
  // The SDK may echo a TON address in another notation (EQ…/UQ…/raw).
  try {
    return TonAddress.parse(a.chain.value).equals(TonAddress.parse(b.chain.value));
  } catch {
    return a.chain.value === b.chain.value;
  }
}

function assetContract(asset: AssetId): string | null {
  const value = asset.chain.value;
  if (typeof value === "string") return null;
  const kind = value.kind;
  return kind && typeof kind.value === "string" ? kind.value : null;
}

/** A route step's asset as a jetton master (null = native GRAM, undefined = not stated). */
function stepJetton(asset: AssetId | undefined): string | null | undefined {
  if (!asset || asset.chain.$case !== "ton" || typeof asset.chain.value === "string") return undefined;
  const kind = asset.chain.value.kind;
  if (kind?.$case === "native") return null;
  return kind?.$case === "jetton" && typeof kind.value === "string" ? kind.value : undefined;
}

function readBigEndian(bytes: Uint8Array, offset: number, length: number): bigint {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || length < 1 || offset < 0 || offset + length > bytes.length) {
    throw new Error("omniston: truncated EVM order extension");
  }
  let value = 0n;
  for (let index = offset; index < offset + length; index++) value = (value << 8n) | BigInt(bytes[index]!);
  return value;
}

function sliceEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function zeroBytes(bytes: Uint8Array): boolean {
  return bytes.every((value) => value === 0);
}

/** `value` within [center - before, center + after] (seconds). */
function within(value: bigint, center: number, before: number, after: number): boolean {
  return value >= BigInt(center - before) && value <= BigInt(center + after);
}

const ORDER_FIELDS = [
  ["salt", "uint256"],
  ["maker", "address"],
  ["receiver", "address"],
  ["makerAsset", "address"],
  ["takerAsset", "address"],
  ["makingAmount", "uint256"],
  ["takingAmount", "uint256"],
  ["makerTraits", "uint256"],
] as const;

function validUint256(value: unknown): boolean {
  try {
    const n = BigInt(value as string | number | bigint);
    return n >= 0n && n < 1n << 256n;
  } catch {
    return false;
  }
}

function validEvmAddress(value: unknown): boolean {
  try {
    getAddress(String(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * The protocol-fee recipient Omniston names in the post-interaction of
 * EVM-destination orders (live 2026-10-20: the same EOA on Base→Arbitrum and
 * Plasma→Base; TON-destination orders still carry zero). It only receives the
 * quoted protocol fee — what the trader gives and gets is bound elsewhere — but
 * it is pinned so an unexpected recipient fails closed.
 */
const EVM_DEST_PROTOCOL_FEE_RECIPIENTS = new Set(["0x076268146b4ec6d21fc49c27586cfa91b9079a00"]);

/**
 * Strict decoder for the currently observed Omniston v1beta8 EVM→TON 1inch
 * extension profile. It deliberately rejects unknown auction/fee/timelock
 * profiles: signing a merely well-formed extension is not enough because the
 * resolver-controlled tail contains the actual on-chain HTLC terms.
 *
 * This binds what the wallet signs to the quote; it does not by itself make
 * the swap complete. Secret disclosure additionally needs the independently
 * finalized EVM source-fill and TON output-position proofs (trackIntent).
 * `dstSecurityDepositUnits` is the value the EVM deposits word carries — for a
 * TON destination that word is 0 (the TON deposit is bound in the TON position).
 */
export async function validateEvmToTonOrderExtension(
  extension: Uint8Array,
  expected: {
    quoteId: string;
    quoteTimestamp: number;
    tradeStartDeadline: number;
    protocolFeePips: number;
    integratorFeePips: number;
    initialResolverAddress: string;
    outputTokenAddress: string;
    traderDstAddress: string;
    takerAsset: string;
    srcSecurityDepositUnits: string;
    dstSecurityDepositUnits: string;
    secretHash: Uint8Array;
    trustedTarget: (address: string) => boolean;
    /** EVM destination (EIP-155 id): ExtraDataArgs carry it and the destination
     *  ERC-20 (`outputTokenAddress`, `traderDstAddress` are EVM then). Absent = TON. */
    dstChainId?: number;
  },
): Promise<void> {
  const evmDest = expected.dstChainId !== undefined;
  if (evmDest && (!Number.isSafeInteger(expected.dstChainId) || expected.dstChainId! <= 0)) throw new Error("omniston: invalid EVM destination chain id");
  if (extension.length < 32) throw new Error("omniston: malformed EVM order extension");
  const view = new DataView(extension.buffer, extension.byteOffset, extension.byteLength);
  const fields: Uint8Array[] = [];
  let begin = 0;
  const concatLength = extension.length - 32;
  for (let index = 0; index < 8; index++) {
    const end = view.getUint32(28 - index * 4, false);
    if (end < begin || end > concatLength) throw new Error("omniston: malformed EVM order extension offsets");
    fields.push(extension.slice(32 + begin, 32 + end));
    begin = end;
  }
  // Omniston's audited 1inch profile uses only amount getters (2/3) and a
  // post-interaction (7). Suffixes can alter token calls; permit/predicate/pre
  // interaction are separate programs and are not authorized by this adapter.
  for (const index of [0, 1, 4, 5, 6]) {
    if (fields[index]!.length !== 0) throw new Error("omniston: unsupported EVM order extension field");
  }
  if (!sliceEqual(fields[2]!, fields[3]!)) {
    throw new Error("omniston: making/taking amount getters use different programs");
  }
  let target: string | undefined;
  for (const index of [2, 3, 7]) {
    const field = fields[index]!;
    if (field.length <= 20) throw new Error("omniston: incomplete EVM order extension program");
    const address = getAddress(`0x${bytesToHex(field.slice(0, 20))}`);
    if (!expected.trustedTarget(address) || (target !== undefined && getAddress(target) !== address)) {
      throw new Error("omniston: EVM order extension target is not independently trusted");
    }
    target = address;
  }

  // SimpleSettlement auction + AmountGetterWithFee. The current trader quote
  // does not describe the curve, so only the audited live v1beta8 profile is
  // accepted. A contract/profile upgrade must add a new explicit decoder.
  const getter = fields[2]!;
  let cursor = 20;
  const gasBump = readBigEndian(getter, cursor, 3); cursor += 3;
  const gasPrice = readBigEndian(getter, cursor, 4); cursor += 4;
  const auctionStart = readBigEndian(getter, cursor, 4); cursor += 4;
  const duration = readBigEndian(getter, cursor, 3); cursor += 3;
  const initialRateBump = readBigEndian(getter, cursor, 3); cursor += 3;
  const pointCount = bigintToNumber(readBigEndian(getter, cursor, 1)); cursor += 1;
  if (pointCount !== 5) throw new Error("omniston: unsupported EVM auction profile");
  const points: [bigint, bigint][] = [];
  for (let index = 0; index < pointCount; index++) {
    points.push([readBigEndian(getter, cursor, 3), readBigEndian(getter, cursor + 3, 2)]);
    cursor += 5;
  }
  const integratorFee = readBigEndian(getter, cursor, 2); cursor += 2;
  const integratorShare = readBigEndian(getter, cursor, 1); cursor += 1;
  const resolverFee = readBigEndian(getter, cursor, 2); cursor += 2;
  const whitelistDiscount = readBigEndian(getter, cursor, 1); cursor += 1;
  const getterWhitelistCount = bigintToNumber(readBigEndian(getter, cursor, 1)); cursor += 1;
  if (getterWhitelistCount !== 1 || cursor + getterWhitelistCount * 10 !== getter.length) {
    throw new Error("omniston: malformed EVM amount-getter whitelist");
  }
  const getterResolver = readBigEndian(getter, cursor, 10);
  const expectedPoints = [[800000n, 100n], [700000n, 100n], [600000n, 100n], [500000n, 100n], [400000n, 100n]];
  const quoteResolverFee = expected.protocolFeePips % 10 === 0 ? BigInt(expected.protocolFeePips / 10) : -1n;
  const resolverLow80 = BigInt(getAddress(expected.initialResolverAddress)) & ((1n << 80n) - 1n);
  if (
    gasBump !== 0n || gasPrice !== 0n || !within(auctionStart, expected.quoteTimestamp, 5, 5) ||
    duration !== 1800n || initialRateBump !== 900000n ||
    points.some((point, index) => point[0] !== expectedPoints[index]![0] || point[1] !== expectedPoints[index]![1]) ||
    expected.integratorFeePips !== 0 || integratorFee !== 0n || integratorShare !== 100n ||
    quoteResolverFee < 0n || resolverFee !== quoteResolverFee || whitelistDiscount !== 50n ||
    getterResolver !== resolverLow80
  ) {
    throw new Error("omniston: EVM amount-getter terms do not match the pinned v1beta8 profile");
  }

  // BaseEscrowFactory postInteraction: exact fee/whitelist prefix followed by
  // five uint256 ExtraDataArgs words. Unknown recipients and trailing bytes are
  // rejected because the corresponding EVM→TON mapping is not public.
  // `allowedTime` is stamped by the resolver a few seconds BEFORE the quote
  // timestamp (live 2026-10-16: 14–18 s on every chain); the auction start is
  // the quote timestamp (±1 s on Polygon). Both windows are bounded.
  const post = fields[7]!;
  cursor = 20;
  const integratorRecipient = post.slice(cursor, cursor + 20); cursor += 20;
  const protocolRecipient = post.slice(cursor, cursor + 20); cursor += 20;
  const postIntegratorFee = readBigEndian(post, cursor, 2); cursor += 2;
  const postIntegratorShare = readBigEndian(post, cursor, 1); cursor += 1;
  const postResolverFee = readBigEndian(post, cursor, 2); cursor += 2;
  const postDiscount = readBigEndian(post, cursor, 1); cursor += 1;
  const allowedTime = readBigEndian(post, cursor, 4); cursor += 4;
  const whitelistCount = bigintToNumber(readBigEndian(post, cursor, 1)); cursor += 1;
  if (whitelistCount !== 1 || cursor + whitelistCount * 12 + 160 !== post.length) {
    throw new Error("omniston: malformed EVM post-interaction whitelist");
  }
  const postResolver = readBigEndian(post, cursor, 10); cursor += 10;
  const resolverTimeDelta = readBigEndian(post, cursor, 2); cursor += 2;
  if (
    !zeroBytes(integratorRecipient) || !(zeroBytes(protocolRecipient) || (evmDest && EVM_DEST_PROTOCOL_FEE_RECIPIENTS.has(`0x${bytesToHex(protocolRecipient)}`))) ||
    postIntegratorFee !== 0n || postIntegratorShare !== 100n || postResolverFee !== quoteResolverFee ||
    postDiscount !== 50n || !within(allowedTime, expected.quoteTimestamp, 60, 5) ||
    postResolver !== resolverLow80 || resolverTimeDelta !== 0n
  ) {
    throw new Error("omniston: EVM post-interaction terms do not match the pinned v1beta8 profile");
  }
  const extra = Array.from({length: 5}, () => {
    const value = readBigEndian(post, cursor, 32);
    cursor += 32;
    return value;
  });
  const hashlock = readBigEndian(expected.secretHash, 0, expected.secretHash.length);
  // ExtraDataArgs word 2 is the destination token: the real ERC-20 for an EVM
  // destination, the order's takerAsset placeholder for TON.
  const dstToken = evmDest ? BigInt(getAddress(expected.outputTokenAddress)) : BigInt(getAddress(expected.takerAsset));
  const deposits = (BigInt(expected.srcSecurityDepositUnits) << 128n) | BigInt(expected.dstSecurityDepositUnits);
  const timelocks = [1n, 120n, 240n, 300n, 1n, 120n, 180n, 0n]
    .reduce((packed, value, index) => packed | (value << BigInt(index * 32)), 0n);
  if (
    expected.secretHash.length !== 32 || extra[0] !== hashlock || extra[1] !== (evmDest ? BigInt(expected.dstChainId!) : 0n) ||
    extra[2] !== dstToken || extra[3] !== deposits || extra[4] !== timelocks
  ) {
    throw new Error("omniston: signed EVM HTLC terms do not match the validated order details");
  }

  const customData = extension.slice(32 + begin);
  if (customData.length !== 131) throw new Error("omniston: malformed EVM order extension custom data");
  if (evmDest) {
    // The TON jetton/recipient slots are empty for an EVM destination (live
    // 2026-10-20). The EVM recipient is NOT in anything the wallet signs: it
    // travels in the unsigned order details only, so the destination escrow's
    // maker is what the disclosure gate (validateEvmOutputPosition) must prove.
    if (!zeroBytes(customData.slice(0, 66))) throw new Error("omniston: unexpected TON addresses in an EVM-destination order");
  } else {
    const {Address} = await import("@ton/core");
    const expectedTon = [expected.outputTokenAddress, expected.traderDstAddress].map((value) => Address.parse(value));
    for (let index = 0; index < expectedTon.length; index++) {
      const offset = index * 33;
      const workchain = customData[offset] === 255 ? -1 : customData[offset]!;
      if (workchain !== expectedTon[index]!.workChain || !sliceEqual(customData.slice(offset + 1, offset + 33), expectedTon[index]!.hash)) {
        throw new Error("omniston: signed EVM→TON address does not match the validated request");
      }
    }
  }
  if (!zeroBytes(customData.slice(66, 99))) {
    throw new Error("omniston: unexpected private TON disclosure address");
  }
  const quoteId = expected.quoteId.replace(/^0x/, "");
  if (!QUOTE_ID.test(quoteId) || !sliceEqual(customData.slice(99), hexToBytes(quoteId.padStart(64, "0")))) {
    throw new Error("omniston: EVM order extension custom data is not bound to the quote id");
  }
  if (expected.tradeStartDeadline < expected.quoteTimestamp) {
    throw new Error("omniston: invalid EVM order quote deadline");
  }
}

function validateEvmTypedOrder(
  td: unknown,
  expected: {
    chainId: number;
    settlementContract: string;
    owner: string;
    receiver: string;
    makerAsset: string;
    makingAmount: string;
    takingAmount: string;
    orderExtension: Uint8Array;
    quoteTimestamp: number;
    tradeStartDeadline: number;
  },
): asserts td is {
  domain: {verifyingContract: string; chainId: string | number};
  types: Record<string, {name: string; type: string}[]>;
  primaryType: string;
  message: Record<string, unknown>;
} {
  const value = td as {
    domain?: {name?: unknown; version?: unknown; verifyingContract?: unknown; chainId?: unknown};
    types?: Record<string, {name?: unknown; type?: unknown}[]>;
    primaryType?: unknown;
    message?: Record<string, unknown>;
  };
  const order = value.types?.Order;
  const exactSchema = Array.isArray(order) && order.length === ORDER_FIELDS.length &&
    order.every((field, i) => field.name === ORDER_FIELDS[i]![0] && field.type === ORDER_FIELDS[i]![1]);
  const message = value.message;
  const salt = message?.salt;
  const traits = validUint256(message?.makerTraits) ? BigInt(message!.makerTraits as string) : -1n;
  const flagMask = ((1n << 56n) - 1n) << 200n;
  // POST_INTERACTION + HAS_EXTENSION are mandatory and ALLOW_MULTIPLE_FILLS
  // must be clear, so the order fills at most once; no permit2/unwrap/epoch/
  // pre-interaction programs. Live v1beta8 orders leave NO_PARTIAL_FILLS clear
  // (one partial fill is possible). Disclosure still requires the finalized
  // fill to lock the FULL input, so a partial fill is never completed — it
  // rolls back on its own timelocks.
  const baseFlags = (1n << 251n) | (1n << 249n);
  const flags = traits < 0n ? -1n : traits & flagMask;
  const flagsOk = flags === baseFlags || flags === (baseFlags | (1n << 255n));
  const allowedSender = traits & ((1n << 80n) - 1n);
  const expiration = (traits >> 80n) & ((1n << 40n) - 1n);
  const series = (traits >> 160n) & ((1n << 40n) - 1n);
  const extensionHash = BigInt(keccak256(expected.orderExtension));
  const exactMessage = !!message && Object.keys(message).length === ORDER_FIELDS.length &&
    ORDER_FIELDS.every(([name]) => Object.hasOwn(message, name));
  if (
    value.domain?.name !== "1inch Limit Order Protocol" || value.domain.version !== "4" ||
    typeof value.domain.verifyingContract !== "string" ||
    getAddress(value.domain.verifyingContract) !== getAddress(expected.settlementContract) ||
    Number(value.domain.chainId) !== expected.chainId || value.primaryType !== "Order" || !exactSchema || !message || !exactMessage ||
    getAddress(String(message.maker)) !== getAddress(expected.owner) ||
    getAddress(String(message.receiver)) !== getAddress(expected.receiver) ||
    getAddress(String(message.makerAsset)) !== getAddress(expected.makerAsset) ||
    !validUint256(salt) || (BigInt(salt as string) & ((1n << 160n) - 1n)) !== (extensionHash & ((1n << 160n) - 1n)) ||
    // The order expires at the quote's trade-start deadline (±15 s of clock
    // skew between the quote and the order builder), never later.
    traits < 0n || !flagsOk || allowedSender !== 0n || series !== 0n ||
    !within(expiration, expected.tradeStartDeadline, 15, 15) || expiration <= BigInt(expected.quoteTimestamp) ||
    !validEvmAddress(message.takerAsset) || getAddress(String(message.takerAsset)) === getAddress(expected.makerAsset) ||
    !validUint256(message.makingAmount) || BigInt(message.makingAmount as string) !== BigInt(expected.makingAmount) ||
    !validUint256(message.takingAmount) || BigInt(message.takingAmount as string) !== BigInt(expected.takingAmount)
  ) {
    throw new Error("omniston: EVM order fields do not match the validated quote/request");
  }
}

async function validateTonEscrowPayload(
  message: EscrowMessage,
  expected: {
    quoteId: string;
    inputUnits: string;
    resolverSendsUnits: string;
    srcHtlcSecurityDepositUnits: string;
    protocolAddress: string;
    ownerAddress: string;
    destinationChain: string;
    destinationAddress: string;
    outputTokenAddress: string;
    initialResolverAddress: string;
    hashes: Uint8Array[];
    hashingFunction?: string;
    exclusivityTimeout: number;
  },
  validateForwardPayload: NonNullable<OmnistonProviderOptions["validateTonEscrowPayload"]>,
): Promise<void> {
  const {Address, Cell} = await import("@ton/core");
  const boc = hexToBytes(message.payload);
  let roots: InstanceType<typeof Cell>[];
  try {
    roots = Cell.fromBoc(Buffer.from(boc));
  } catch {
    throw new Error("omniston: malformed TON escrow BoC");
  }
  if (roots.length !== 1) throw new Error("omniston: TON escrow must contain exactly one root cell");
  const slice = roots[0]!.beginParse();
  const op = slice.loadUint(32);
  slice.loadUintBig(64); // query id is resolver-chosen and not security-critical
  const amount = slice.loadCoins();
  const destination = slice.loadAddressAny();
  const response = slice.loadAddressAny();
  const customPayload = slice.loadMaybeRef();
  const forwardAmount = slice.loadCoins();
  const payloadByRef = slice.loadBit();
  if (
    op !== 0x0f8a7ea5 || amount !== BigInt(expected.inputUnits) || !(destination instanceof Address) ||
    !destination.equals(Address.parse(expected.protocolAddress)) ||
    (response !== null && (!(response instanceof Address) || !response.equals(Address.parse(expected.ownerAddress)))) || customPayload !== null ||
    forwardAmount <= 0n || forwardAmount > BigInt(message.sendAmount) || !payloadByRef ||
    slice.remainingBits !== 0 || slice.remainingRefs !== 1
  ) {
    throw new Error("omniston: TON jetton transfer does not match the validated quote/request");
  }
  const forwardPayload = slice.loadRef();
  const verified = await validateForwardPayload({
    payloadBocHex: message.payload,
    forwardPayloadBocHex: Buffer.from(forwardPayload.toBoc()).toString("hex"),
    quoteId: expected.quoteId,
    inputUnits: expected.inputUnits,
    resolverSendsUnits: expected.resolverSendsUnits,
    srcHtlcSecurityDepositUnits: expected.srcHtlcSecurityDepositUnits,
    protocolAddress: expected.protocolAddress,
    ownerAddress: expected.ownerAddress,
    destinationChain: expected.destinationChain,
    destinationAddress: expected.destinationAddress,
    outputTokenAddress: expected.outputTokenAddress,
    initialResolverAddress: expected.initialResolverAddress,
    secretHashes: expected.hashes.map((hash) => hash.slice()),
    ...(expected.hashingFunction ? {hashingFunction: expected.hashingFunction} : {}),
    exclusivityTimeout: expected.exclusivityTimeout,
  });
  if (!verified) throw new Error("omniston: TON escrow forward payload failed independent semantic validation");
}

/** Fee token id: the catalog's 1Click asset id, or the on-chain contract for
 *  assets 1Click does not list (BNB/Polygon USDC) — an empty id fails validQuote. */
function feeToken(asset: CcAsset): string {
  return asset.assetId || asset.contract || asset.symbol;
}

function chainCase(asset: AssetId): string {
  return asset.chain.$case;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/** Minimal, bounded protobuf reader for the exact v1beta8 HTLC-details schema.
 * The SDK deliberately exposes these bytes as opaque, so independently decode
 * the security-critical fields before asking the wallet to sign their hash. */
class ProtoReader {
  private pos = 0;
  constructor(private readonly bytes: Uint8Array) {}
  get done(): boolean { return this.pos === this.bytes.length; }
  varint(): number {
    let out = 0;
    let shift = 0;
    while (this.pos < this.bytes.length && shift <= 49) {
      const byte = this.bytes[this.pos++]!;
      out += (byte & 0x7f) * 2 ** shift;
      if ((byte & 0x80) === 0) {
        if (!Number.isSafeInteger(out)) throw new Error("omniston: unsafe protobuf varint");
        return out;
      }
      shift += 7;
    }
    throw new Error("omniston: malformed protobuf varint");
  }
  field(): {number: number; wire: number} {
    const tag = this.varint();
    const number = Math.floor(tag / 8);
    const wire = tag & 7;
    if (number < 1) throw new Error("omniston: malformed protobuf field");
    return {number, wire};
  }
  lengthDelimited(): Uint8Array {
    const length = this.varint();
    const end = this.pos + length;
    if (length < 0 || end > this.bytes.length) throw new Error("omniston: truncated protobuf payload");
    const value = this.bytes.slice(this.pos, end);
    this.pos = end;
    return value;
  }
  skip(wire: number): void {
    if (wire === 0) { this.varint(); return; }
    if (wire === 1) { this.advance(8); return; }
    if (wire === 2) { this.lengthDelimited(); return; }
    if (wire === 5) { this.advance(4); return; }
    throw new Error("omniston: unsupported protobuf wire type");
  }
  private advance(length: number): void {
    if (this.pos + length > this.bytes.length) throw new Error("omniston: truncated protobuf payload");
    this.pos += length;
  }
}

const utf8 = new TextDecoder("utf-8", {fatal: true});
// stonfi/common/v1/types/{chain_address,asset_id}.proto (omniston-sdk main, re-read 2026-10-20).
const PROTO_CASE_BY_FIELD: Record<number, string> = {
  1: "arbitrum", 2: "avalanche", 3: "base", 4: "bnb", 5: "ethereum",
  6: "polygon", 7: "robinhood", 8: "xlayer", 9: "arc", 10: "monad", 11: "plasma", 12: "hyperevm",
  50: "ton", 60: "tron",
};

function decodeChainAddress(bytes: Uint8Array): ChainAddress {
  const reader = new ProtoReader(bytes);
  let address: ChainAddress | undefined;
  while (!reader.done) {
    const {number, wire} = reader.field();
    const $case = PROTO_CASE_BY_FIELD[number];
    if (!$case || wire !== 2 || address) throw new Error("omniston: malformed chain address in order details");
    address = {chain: {$case, value: utf8.decode(reader.lengthDelimited())}};
  }
  if (!address?.chain.value) throw new Error("omniston: empty chain address in order details");
  return address;
}

function decodeAssetId(bytes: Uint8Array): AssetId {
  const reader = new ProtoReader(bytes);
  let asset: AssetId | undefined;
  while (!reader.done) {
    const {number, wire} = reader.field();
    const $case = PROTO_CASE_BY_FIELD[number];
    if (!$case || wire !== 2 || asset) throw new Error("omniston: malformed asset id in order details");
    const kindReader = new ProtoReader(reader.lengthDelimited());
    const kindField = kindReader.field();
    if (kindField.wire !== 2 || (kindField.number !== 1 && kindField.number !== 2)) {
      throw new Error("omniston: unsupported asset kind in order details");
    }
    const kindCase = kindField.number === 1 ? "native" : ($case === "ton" ? "jetton" : $case === "tron" ? "trc20" : "erc20");
    const value = kindField.number === 1 ? {} : utf8.decode(kindReader.lengthDelimited());
    if (!kindReader.done || (kindField.number === 2 && !value)) throw new Error("omniston: malformed asset kind in order details");
    asset = {chain: {$case, value: {kind: {$case: kindCase, value}}}};
  }
  if (!asset) throw new Error("omniston: empty asset id in order details");
  return asset;
}

function validateSerializedOrderDetails(
  bytes: Uint8Array | undefined,
  expected: {quoteId: string; outputAsset: AssetId; traderDstAddress: ChainAddress; secretHashes: Uint8Array[]},
): void {
  if (!bytes?.length) throw new Error("omniston: EVM HTLC order payload has no serialized details");
  const wrapper = new ProtoReader(bytes);
  const outer = wrapper.field();
  if (outer.number !== 1 || outer.wire !== 2) throw new Error("omniston: unsupported HTLC order-details version");
  const detailsBytes = wrapper.lengthDelimited();
  if (!wrapper.done) throw new Error("omniston: ambiguous HTLC order-details wrapper");
  const reader = new ProtoReader(detailsBytes);
  let quoteId: string | undefined;
  let outputAsset: AssetId | undefined;
  let traderDstAddress: ChainAddress | undefined;
  const hashes: Uint8Array[] = [];
  while (!reader.done) {
    const {number, wire} = reader.field();
    if (wire !== 2) throw new Error("omniston: malformed HTLC order details");
    const value = reader.lengthDelimited();
    if (number === 1 && quoteId === undefined) quoteId = utf8.decode(value);
    else if (number === 2 && outputAsset === undefined) outputAsset = decodeAssetId(value);
    else if (number === 3 && traderDstAddress === undefined) traderDstAddress = decodeChainAddress(value);
    else if (number === 5) hashes.push(value);
    else throw new Error("omniston: duplicate or unexpected HTLC order-details field");
  }
  if (
    quoteId !== expected.quoteId ||
    !outputAsset || !sameAsset(outputAsset, expected.outputAsset) ||
    !traderDstAddress || !sameChainAddress(traderDstAddress, expected.traderDstAddress) ||
    hashes.length !== expected.secretHashes.length ||
    hashes.some((hash, i) => !bytesEqual(hash, expected.secretHashes[i]!))
  ) {
    throw new Error("omniston: resolver order payload does not match the validated quote/request");
  }
}

function isPositiveInteger(value: string): boolean {
  try {
    return BigInt(value) > 0n;
  } catch {
    return false;
  }
}

function isNonNegativeInteger(value: string | undefined): boolean {
  if (value === undefined) return true;
  return /^[0-9]+$/.test(value);
}

function decimalToUnits(value: string, decimals: number): bigint | null {
  const match = value.match(/^(\d+)(?:\.(\d+))?$/);
  if (!match || !Number.isInteger(decimals) || decimals < 0) return null;
  const fraction = match[2] ?? "";
  if (fraction.length > decimals) return null;
  const units = BigInt(match[1]!) * 10n ** BigInt(decimals) +
    BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  return units > 0n ? units : null;
}

function validDisclosurePhase(phase: string | undefined): boolean {
  return phase === "EXECUTION_PHASE_READY_FOR_PRIVATE_COMPLETION" ||
    phase === "EXECUTION_PHASE_READY_FOR_PUBLIC_COMPLETION" ||
    phase === "OUTPUT_LOCKED"; // legacy client representation
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hex: string): Uint8Array {
  const clean = hex.replace(/^0x/, "");
  if (!clean || !/^(?:[0-9a-fA-F]{2})+$/.test(clean)) {
    throw new Error("omniston: malformed hex payload");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function hexToBase64(hex: string): string {
  const bytes = hexToBytes(hex);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin);
}

// ── RFQ stream → single quote ────────────────────────────────────────────────

/** Let resolvers compete for QUOTE_SETTLE_MS, then take the latest valid quote.
 * `noQuote` invalidates all previous updates because v1beta8 uses it to signal
 * that the previous quote expired. */
/** The order-settlement fields every cross-chain quote must bind. */
function validOrderSettlement(q: OmnistonQuote): boolean {
  if (q.settlementData?.$case !== "order") return false;
  const v = q.settlementData.value;
  return !!v.srcProtocolContractAddress &&
    v.srcProtocolContractAddress.chain.$case === chainCase(q.inputAsset) &&
    !!v.srcInitialResolverAddress &&
    v.srcInitialResolverAddress.chain.$case === chainCase(q.inputAsset) &&
    !!v.dstProtocolContractAddress &&
    v.dstProtocolContractAddress.chain.$case === chainCase(q.outputAsset) &&
    isPositiveInteger(v.srcHtlcSecurityDepositUnits ?? "") &&
    isPositiveInteger(v.dstSecurityDepositUnits ?? "") &&
    (v.htlcHashingFunction === "HASHING_FUNCTION_KECCAK256" || v.htlcHashingFunction === "HASHING_FUNCTION_SHA256") &&
    Number.isSafeInteger(v.exclusivityTimeout) && v.exclusivityTimeout! > 0 &&
    isPositiveInteger(v.resolverSendsUnits) &&
    BigInt(v.resolverSendsUnits) === BigInt(q.outputUnits) + BigInt(q.protocolFeeUnits || "0") + BigInt(q.integratorFeeUnits || "0");
}

/** The swap-settlement fields a same-chain quote must carry: at least one
 *  route of named-protocol chunks, and a minimum output within the quote. */
function validSwapSettlement(q: OmnistonQuote): boolean {
  if (q.settlementData?.$case !== "swap") return false;
  const v = q.settlementData.value;
  return Array.isArray(v.routes) && v.routes.length > 0 &&
    v.routes.every((route) => Array.isArray(route?.steps) && route.steps.length > 0 &&
      route.steps.every((step) => Array.isArray(step?.chunks) && step.chunks.length > 0 &&
        step.chunks.every((chunk) => typeof chunk?.protocol === "string" && chunk.protocol.length > 0 &&
          isPositiveInteger(chunk.inputUnits) && isPositiveInteger(chunk.outputUnits)))) &&
    isPositiveInteger(v.minOutputAmount) && BigInt(v.minOutputAmount) <= BigInt(q.outputUnits) &&
    (v.recommendedMinOutputAmount === undefined ||
      (isPositiveInteger(v.recommendedMinOutputAmount) && BigInt(v.recommendedMinOutputAmount) <= BigInt(q.outputUnits))) &&
    (q.gasBudget === undefined || isPositiveInteger(q.gasBudget));
}

/** Every DEX protocol name the quote's routes touch, deduplicated. */
function swapProtocols(v: SwapSettlement): string[] {
  const names = new Set<string>();
  for (const route of v.routes) for (const step of route.steps) for (const chunk of step.chunks) names.add(chunk.protocol);
  return [...names];
}

/** Why an RFQ produced no usable quote — the caller turns it into a refusal. */
interface RfqOutcome {
  /** Number of `quoteUpdated` events seen for this RFQ. */
  updates: number;
  /** The first check the latest rejected update failed, if any. */
  rejected?: string;
  /** The stream errored (socket/SDK) before a usable quote arrived. */
  error?: string;
}

/** The first failing check of a `quoteUpdated` event, or null when it is usable. */
function quoteRejection(
  q: OmnistonQuote | undefined,
  update: {rfqId?: string},
  acknowledgedRfqId: string | null,
  request: QuoteRequest,
  settlement: "order" | "swap",
): string | null {
  if (!q) return "empty quote";
  if (!acknowledgedRfqId || update.rfqId !== acknowledgedRfqId || q.rfqId !== acknowledgedRfqId) return "quote for another RFQ";
  if (!sameAsset(q.inputAsset, request.inputAsset) || !sameAsset(q.outputAsset, request.outputAsset)) return "quote assets differ from the request";
  const requestedAmount = request.amount.$case === "inputUnits" ? request.amount.value : "";
  if (q.inputUnits !== requestedAmount) return "quote input differs from the request";
  if (!QUOTE_ID.test(q.quoteId)) return "malformed quote id";
  if (!isPositiveInteger(q.inputUnits) || !isPositiveInteger(q.outputUnits)) return "non-positive quote amounts";
  if (!isNonNegativeInteger(q.protocolFeeUnits) || !isNonNegativeInteger(q.integratorFeeUnits) ||
    BigInt(q.protocolFeeUnits || "0") + BigInt(q.integratorFeeUnits || "0") > BigInt(q.outputUnits)) return "malformed quote fees";
  if (!Number.isInteger(q.quoteTimestamp) || Math.abs(Math.floor(Date.now() / 1000) - q.quoteTimestamp) > 120) return "quote timestamp out of range";
  if (settlement === "order" ? !validOrderSettlement(q) : !validSwapSettlement(q)) return `incomplete ${settlement} settlement data`;
  if (!sameChainAddress(q.integratorAddress, request.integratorAddress)) return "quote integrator differs from the request";
  return null;
}

function awaitQuote(
  stream: ObservableLike<RfqEvent>,
  request: QuoteRequest,
  signal?: AbortSignal,
  settleMs = QUOTE_SETTLE_MS,
  settlement: "order" | "swap" = "order",
  outcome: RfqOutcome = {updates: 0},
): Promise<OmnistonQuote | null> {
  return new Promise((resolve) => {
    let latest: OmnistonQuote | null = null;
    let done = false;
    let sub: {unsubscribe(): void} | null = null;
    let acknowledgedRfqId: string | null = null;
    const onAbort = () => finish(null);
    const finish = (value: OmnistonQuote | null) => {
      if (done) return;
      done = true;
      clearTimeout(settle);
      clearTimeout(max);
      signal?.removeEventListener("abort", onAbort);
      try {
        sub?.unsubscribe();
      } catch {
        /* socket already gone */
      }
      resolve(value);
    };
    const settle = setTimeout(() => {
      if (latest) finish(latest);
    }, settleMs);
    const max = setTimeout(() => finish(latest), QUOTE_MAX_MS);
    sub = stream.subscribe({
      next: (event) => {
        if (event.$case === "ack") {
          acknowledgedRfqId = (event as {$case: "ack"; value: {rfqId: string}}).value.rfqId || null;
        } else if (event.$case === "quoteUpdated") {
          const update = event as {rfqId?: string; value: OmnistonQuote};
          outcome.updates += 1;
          const rejection = quoteRejection(update.value, update, acknowledgedRfqId, request, settlement);
          if (rejection) {
            outcome.rejected = rejection;
            latest = null;
            return;
          }
          latest = update.value;
        } else if (event.$case === "noQuote") {
          // v1beta8 streams resolver state: null invalidates the previous
          // update, but another resolver may still publish a later quote.
          // Keep the RFQ alive until the normal settle/max window.
          const noQuote = event as {$case: "noQuote"; rfqId?: string};
          if (acknowledgedRfqId && noQuote.rfqId === acknowledgedRfqId) latest = null;
        }
      },
      error: (err) => {
        outcome.error = String((err as {message?: unknown})?.message ?? err).slice(0, 200);
        finish(null);
      },
      complete: () => finish(latest),
    });
    signal?.addEventListener("abort", onAbort, {once: true});
    if (done) sub.unsubscribe(); // finished synchronously before sub was set
  });
}

/** Collect the latest swap-progress event for the snapshot window. */
function awaitSwapProgress(stream: ObservableLike<SwapTrackEvent>): Promise<{status: string; outgoingTxHash?: string} | null | "awaiting"> {
  return new Promise((resolve) => {
    let done = false;
    let latest: {status: string; outgoingTxHash?: string} | null | "awaiting" = null;
    let sub: {unsubscribe(): void} | null = null;
    const finish = (value: typeof latest) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sub?.unsubscribe();
      } catch {
        /* socket already gone */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(latest), TRACK_SNAPSHOT_MS);
    sub = stream.subscribe({
      next: (event) => {
        if (event.$case === "progress") {
          latest = (event as {value: {status: string; outgoingTxHash?: string}}).value;
          if (["TRADE_STATUS_FULLY_FILLED", "TRADE_STATUS_PARTIALLY_FILLED", "TRADE_STATUS_CANCELLED", "TRADE_STATUS_FAILED"].includes(latest.status)) finish(latest);
        } else if (event.$case === "awaitingTransfer" && latest === null) {
          latest = "awaiting";
        }
      },
      error: () => finish(null),
      complete: () => finish(latest),
    });
    if (done) sub.unsubscribe();
  });
}

const JETTON_TRANSFER_OP = 0x0f8a7ea5;

/** A built TON swap message body: either a jetton transfer (jetton input,
 *  forwarding to the DEX) or a DEX-native call (native GRAM input). */
function parseSwapPayload(payloadHex: string): {
  op: number;
  jettonTransfer: null | {amount: bigint; destination: string; responseDestination: string | null; forwardTon: bigint};
} {
  if (!/^(?:[0-9a-fA-F]{2})+$/.test(payloadHex)) throw new Error("omniston: malformed swap payload hex");
  const roots = TonCell.fromBoc(Buffer.from(payloadHex, "hex"));
  if (roots.length !== 1) throw new Error("omniston: swap payload must have one root");
  const s = roots[0]!.beginParse();
  const op = s.loadUint(32);
  if (op !== JETTON_TRANSFER_OP) return {op, jettonTransfer: null};
  s.loadUintBig(64); // query id — wallet/resolver-selected
  const amount = s.loadCoins();
  const destination = s.loadAddress();
  const responseDestination = s.loadMaybeAddress();
  s.loadMaybeRef(); // custom payload
  const forwardTon = s.loadCoins();
  return {
    op,
    jettonTransfer: {
      amount,
      destination: destination.toString(),
      responseDestination: responseDestination ? responseDestination.toString() : null,
      forwardTon,
    },
  };
}

function sameTonAddress(a: string, b: string): boolean {
  try {
    return TonAddress.parse(a).equals(TonAddress.parse(b));
  } catch {
    return false;
  }
}

/** Collect the latest order event for the snapshot window. */
function awaitOrder(stream: ObservableLike<OrderEvent>): Promise<OrderSnapshot | null> {
  return new Promise((resolve) => {
    let done = false;
    let latest: OrderSnapshot | null = null;
    let sub: {unsubscribe(): void} | null = null;
    const finish = (value: OrderSnapshot | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        sub?.unsubscribe();
      } catch {
        /* socket already gone */
      }
      resolve(value);
    };
    const timer = setTimeout(() => finish(latest), TRACK_SNAPSHOT_MS);
    sub = stream.subscribe({
      next: (event) => {
        if (event.$case === "order") {
          latest = (event as {value: OrderSnapshot}).value;
          if (["TRADE_STATUS_FULLY_FILLED", "TRADE_STATUS_CANCELLED", "TRADE_STATUS_FAILED"].includes(latest.status)) finish(latest);
        }
      },
      error: () => finish(null),
      complete: () => finish(latest),
    });
    if (done) sub.unsubscribe();
  });
}

function mapOrderStatus(order: OrderSnapshot): IntentStatus {
  const depositReceived = order.executions.length > 0;
  switch (order.status) {
    case "TRADE_STATUS_FULLY_FILLED":
      return {state: "completed", depositReceived: true};
    case "TRADE_STATUS_PARTIALLY_FILLED":
      // NOT terminal: tranches still need their secrets disclosed — keep the
      // store and keep polling (audit H2). Only FULLY_FILLED clears it.
      return {state: "pending", depositReceived: true};
    case "TRADE_STATUS_CANCELLED":
    case "TRADE_STATUS_FAILED":
      // Resolver-controlled tracking is not proof that the signed source order
      // can no longer fill. Keep polling until completion or the caller's
      // independent HTLC/expiry refund backstop closes the intent.
      return {state: "pending", depositReceived};
    default:
      return {state: "pending", depositReceived};
  }
}

// ── Provider ─────────────────────────────────────────────────────────────────

export function omnistonProvider(opts: OmnistonProviderOptions = {}): CrossChainProvider {
  opts = Object.freeze({...opts});
  const apiUrl = opts.apiUrl ?? "wss://omni-ws.ston.fi";
  const parsedApiUrl = new URL(apiUrl);
  if (parsedApiUrl.protocol !== "wss:" && parsedApiUrl.protocol !== "ws:") {
    throw new Error("omniston: apiUrl must use ws or wss");
  }
  const maxUsdText = String(opts.maxUsd ?? 1000);
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(maxUsdText) || Number(maxUsdText) <= 0 || !Number.isFinite(Number(maxUsdText))) {
    throw new Error("omniston: maxUsd must be a positive plain decimal");
  }
  const hasIntegrator = opts.integratorAddress !== undefined;
  const hasIntegratorPips = opts.integratorFeePips !== undefined;
  if (hasIntegrator !== hasIntegratorPips) throw new Error("omniston: integratorAddress and integratorFeePips must be configured together");
  if (hasIntegrator && (!opts.integratorAddress!.trim() || !Number.isInteger(opts.integratorFeePips) || opts.integratorFeePips! < 0 || opts.integratorFeePips! > 1_000_000)) {
    throw new Error("omniston: integrator fee config is invalid");
  }
  const trustedContracts = new Map<string, Set<string>>();
  for (const [chain, addresses] of Object.entries(opts.trustedSettlementContracts ?? {})) {
    const normalized = new Set<string>();
    for (const address of addresses) {
      try {
        normalized.add(isTon(chain) ? address : getAddress(address).toLowerCase());
      } catch {
        throw new Error(`omniston: invalid trusted settlement contract for ${chain}`);
      }
    }
    if (normalized.size) trustedContracts.set(chain, normalized);
  }
  const isTrusted = (chain: string, address: string): boolean => {
    try {
      return trustedContracts.get(chain)?.has(isTon(chain) ? address : getAddress(address).toLowerCase()) ?? false;
    } catch {
      return false;
    }
  };
  const trustedOrderProtocols = new Map<string, Set<string>>();
  for (const [chain, addresses] of Object.entries(opts.trustedEvmOrderProtocols ?? {})) {
    const normalized = new Set<string>();
    for (const address of addresses) {
      try {
        if (evmRef(chain) === null) throw new Error("not an EVM chain");
        normalized.add(getAddress(address).toLowerCase());
      } catch {
        throw new Error(`omniston: invalid trusted EVM order protocol for ${chain}`);
      }
    }
    if (normalized.size) trustedOrderProtocols.set(chain, normalized);
  }
  const isTrustedOrderProtocol = (chain: string, address: string): boolean => {
    try {
      return trustedOrderProtocols.get(chain)?.has(getAddress(address).toLowerCase()) ?? false;
    } catch {
      return false;
    }
  };
  const store = opts.secretStore ?? inMemorySecretStore();
  const requestedMaxExecutions = opts.maxHtlcExecutions ?? DEFAULT_MAX_HTLC_EXECUTIONS;
  if (!Number.isFinite(requestedMaxExecutions) || !Number.isInteger(requestedMaxExecutions) || requestedMaxExecutions < 1) {
    throw new Error("omniston: maxHtlcExecutions must be a positive integer");
  }
  const maxExecutions = Math.min(16, requestedMaxExecutions);
  const maxTonExecutionNano = opts.maxTonExecutionNano ?? "2000000000";
  if (!isPositiveInteger(maxTonExecutionNano)) {
    throw new Error("omniston: maxTonExecutionNano must be a positive integer");
  }
  const quoteSettleMs = opts.quoteSettleMs ?? QUOTE_SETTLE_MS;
  if (!Number.isInteger(quoteSettleMs) || quoteSettleMs < 0 || quoteSettleMs >= QUOTE_MAX_MS) {
    throw new Error(`omniston: quoteSettleMs must be an integer in [0, ${QUOTE_MAX_MS})`);
  }
  const injectedClient = opts.client ?? null;
  let client: OmnistonClientLike | null = injectedClient;
  let clientPromise: Promise<OmnistonClientLike> | null = null;
  let clientGeneration = 0;
  /** Lazy: never open the WebSocket unless a quote is actually requested. */
  async function getClient(): Promise<OmnistonClientLike> {
    if (client) return client;
    if (clientPromise) return clientPromise;
    const generation = clientGeneration;
    clientPromise = (async () => {
      const sdk = await import("@ston-fi/omniston-sdk");
      // omniston-sdk 0.8.9's Node WebSocketTransport listens for open/message/
      // close but not the EventEmitter `error` event. A refused connection can
      // therefore terminate the whole process before AutoReconnectTransport
      // sees the following close. Attach a no-op error listener to each socket;
      // close remains the authoritative status/retry signal.
      const webSocketTransport = new sdk.WebSocketTransport(apiUrl);
      const connect = webSocketTransport.connect.bind(webSocketTransport);
      webSocketTransport.connect = () => {
        const pending = connect();
        const socket = (webSocketTransport as unknown as {webSocket?: {addEventListener(type: string, listener: () => void): void}}).webSocket;
        socket?.addEventListener("error", () => {});
        return pending;
      };
      webSocketTransport.reconnect = () => webSocketTransport.connect();
      // SDK race (0.8.11): a socket read can carry a Quote response AND its
      // subscription's `ack` notification; both are dispatched synchronously,
      // before the SDK registers the stream consumer, so the ack is dropped
      // and the next update errors with "quoteUpdated before ack" (live
      // 2026-10-12: 1–3 of 4 parallel RFQs, occasionally a single one).
      // Deliver each frame in its own macrotask so registration runs between.
      const messages = (webSocketTransport as unknown as {messagesSubject?: {next(m: string): void}}).messagesSubject;
      if (messages) {
        const deliver = messages.next.bind(messages);
        messages.next = (m: string) => { setTimeout(() => deliver(m), 0); };
      }
      const transport = new sdk.AutoReconnectTransport({transport: webSocketTransport});
      const created = new sdk.Omniston({apiUrl, transport}) as unknown as OmnistonClientLike;
      if (generation !== clientGeneration) {
        if (created.close) created.close(); else created.transport?.close();
        throw new Error("omniston: provider closed while client was being created");
      }
      client = created;
      return created;
    })();
    try {
      return await clientPromise;
    } finally {
      clientPromise = null;
    }
  }

  /** buildDeposit/registerSignedOrder need the context getQuote produced —
   *  persisted via quoteStore so serverless instances share it. */
  const quotes = opts.quoteStore ?? inMemoryQuoteStore();
  interface BuiltEntry {
    quote: OmnistonQuote;
    at: number;
    /** What the intentId was minted for (absent on entries written before scan F3/F15). */
    bound?: IntentBinding;
    /** EVM-source orders: what registration and tracking need after signing. */
    evmOrder?: {
      typedData: string;
      orderExtension: string;
      serializedOrderDetails: string;
      owner: string;
      chainCase: string;
      /** Escrow factory the signed extension targets (trusted for the source chain). */
      factory: string;
    };
  }
  async function saveBuilt(quoteId: string, entry: BuiltEntry): Promise<void> {
    await quotes.save(quoteId, JSON.stringify(entry));
  }
  async function loadBuilt(quoteId: string): Promise<BuiltEntry | undefined> {
    const raw = await quotes.load(quoteId);
    if (!raw) return undefined;
    try {
      const e = JSON.parse(raw) as BuiltEntry;
      if (!Number.isFinite(e.at) || Date.now() - e.at > CACHE_TTL_MS) {
        await quotes.clear(quoteId);
        return undefined;
      }
      return e;
    } catch {
      await quotes.clear(quoteId);
      return undefined;
    }
  }

  type Decoded = NonNullable<ReturnType<typeof decodeIntent>>;
  type BindResult =
    | {ok: true; ref: Decoded; legacy: boolean}
    | {ok: false; reason: "mismatch"; field: string}
    | {ok: false; reason: "legacy-expired"};
  /**
   * Resolve the caller's intentId against the context stored for its quote:
   * any field that differs from what getQuote bound is refused, and the
   * returned ref carries ONLY the stored values. Pre-binding (legacy) entries
   * fall back to the signed order's owner (EVM source) or the decoded values,
   * for at most LEGACY_INTENT_WINDOW_MS after they were written.
   */
  function bindIntent(decoded: Decoded, entry: BuiltEntry): BindResult {
    const owner = entry.evmOrder?.owner;
    const bound = entry.bound;
    if (bound) {
      if (bound.kind !== decoded.kind) return {ok: false, reason: "mismatch", field: "kind"};
      if (bound.srcChain !== decoded.srcChain) return {ok: false, reason: "mismatch", field: "srcChain"};
      if (!sameIntentAddress(bound.trader, decoded.trader)) return {ok: false, reason: "mismatch", field: "trader"};
      if (!sameIntentAddress(bound.dest, decoded.dest)) return {ok: false, reason: "mismatch", field: "dest"};
      if (owner !== undefined && !sameIntentAddress(owner, bound.trader)) return {ok: false, reason: "mismatch", field: "owner"};
      return {ok: true, legacy: false, ref: {quoteId: decoded.quoteId, trader: owner ?? bound.trader, dest: bound.dest, srcChain: bound.srcChain, kind: bound.kind}};
    }
    if (!Number.isFinite(entry.at) || Date.now() - entry.at > LEGACY_INTENT_WINDOW_MS) return {ok: false, reason: "legacy-expired"};
    if (owner !== undefined && !sameIntentAddress(owner, decoded.trader)) return {ok: false, reason: "mismatch", field: "owner"};
    return {ok: true, legacy: true, ref: {...decoded, trader: owner ?? decoded.trader}};
  }
  const traceFor = (quoteId: string) => (event: string, details?: Record<string, unknown>) => {
    try { opts.trace?.(event, {quoteId, ...details}); } catch { /* diagnostics never break the flow */ }
  };
  /** buildDeposit / registerSignedOrder: the bound ref, or a named refusal. */
  function requireBinding(decoded: Decoded, entry: BuiltEntry, where: string): Decoded {
    const trace = traceFor(decoded.quoteId);
    const bound = bindIntent(decoded, entry);
    if (!bound.ok) {
      if (bound.reason === "legacy-expired") {
        trace("legacy-intent-expired", {where});
        throw new Error("omniston: quote expired — request a fresh quote");
      }
      trace("intent-mismatch", {where, field: bound.field});
      throw new Error(`omniston: intent id does not match the quote it was issued for (${bound.field})`);
    }
    if (bound.legacy) trace("legacy-intent", {where});
    return bound.ref;
  }

  /**
   * HTLC secrets for a quote: a second build of the SAME order reuses the
   * stored secrets (same hashlock) instead of overwriting them, so a repeated
   * or concurrent build can never strand an order that was already signed.
   * `created` says whether THIS call wrote them (only then may it clear them).
   *
   * The quoteId is chosen by the platform, so it alone must never decide which
   * preimage an order locks to (scan 2026-10-23 F6): secrets are stored with a
   * hash of the order they were made for (trader, dest, chain, assets, units)
   * and reused only for that exact order, and a secret that was disclosed is
   * never handed to a new build.
   */
  const bindKey = (quoteId: string) => `${quoteId}#bind`;
  const disclosedKey = (quoteId: string) => `${quoteId}#disclosed`;
  function orderBinding(ref: Decoded, q: OmnistonQuote): string {
    return sha256(new TextEncoder().encode(JSON.stringify([
      ref.quoteId, ref.trader ?? null, ref.dest ?? null, ref.srcChain ?? null,
      q.inputUnits, q.outputUnits, JSON.stringify(q.inputAsset), JSON.stringify(q.outputAsset),
    ]))).slice(2);
  }
  async function clearSecrets(quoteId: string): Promise<void> {
    await store.clear(quoteId);
    await store.clear(bindKey(quoteId));
    await store.clear(disclosedKey(quoteId));
  }
  async function secretsFor(ref: Decoded, q: OmnistonQuote, count: number): Promise<{secrets: Uint8Array[]; created: boolean}> {
    const quoteId = ref.quoteId;
    const binding = orderBinding(ref, q);
    const existing = await store.load(quoteId);
    if (existing && existing.length > 0) {
      const [boundTo] = (await store.load(bindKey(quoteId))) ?? [];
      const disclosed = ((await store.load(disclosedKey(quoteId))) ?? []).length > 0;
      if (boundTo !== binding || disclosed) {
        traceFor(quoteId)("secret-reuse-refused", {disclosed, bound: boundTo !== undefined});
        throw new Error("omniston: this quote id already belongs to another order — request a fresh quote");
      }
      if (existing.length !== count || !existing.every((s) => /^[0-9a-fA-F]{64}$/.test(s))) {
        throw new Error("omniston: stored HTLC secrets for this quote do not fit the order — request a fresh quote");
      }
      traceFor(quoteId)("secret-reused", {count});
      return {secrets: existing.map(hexToBytes), created: false};
    }
    const secrets = Array.from({length: count}, generateSecret);
    // Persist BEFORE anything can be signed: if the process dies after the
    // lock, the poll path still has the preimage to disclose.
    await store.save(bindKey(quoteId), [binding]);
    await store.save(quoteId, secrets.map(bytesToHex));
    return {secrets, created: true};
  }

  /** A quote whose id already carries an order (secrets on file) is the platform reusing an id: refuse it. */
  async function quoteIdInUse(quoteId: string): Promise<boolean> {
    const existing = await store.load(quoteId);
    return !!existing && existing.length > 0;
  }

  // ── TON ↔ TON: swap settlement (immediate DEX routes, no escrow) ──────────
  const SWAP_SLIPPAGE_PIPS_DEFAULT = 5_000; // 0.5%
  /** Same-chain swaps need the jetton-wallet validator (jetton input goes
   *  through the trader's own wallet) and a swap-target validator (the DEX
   *  contract the funds land in is resolver-chosen per route). */
  const sameChainTonReady = (): boolean =>
    typeof opts.validateTonJettonWallet === "function" && typeof opts.validateTonSwapTarget === "function";
  /** TON→EVM: the TON factory and the EVM factory are allowlisted, and the
   *  jetton-wallet, escrow-payload and EVM output-position validators exist. */
  const tonSourceReady = (from: string, to: string): boolean =>
    cfg.supports(from, to) && trustedContracts.has(from) && trustedContracts.has(to) &&
    typeof opts.validateTonJettonWallet === "function" &&
    typeof opts.validateTonEscrowPayload === "function" &&
    typeof opts.validateEvmOutputPosition === "function";
  /** EVM→TON: the order protocol the wallet signs against AND the factory the
   *  signed extension targets are allowlisted for the source chain, the TON
   *  factory for the destination, and both finalized-position validators exist. */
  const evmSourceReady = (from: string, to: string): boolean =>
    cfg.supports(from, to) && trustedOrderProtocols.has(from) && trustedContracts.has(from) && trustedContracts.has(to) &&
    typeof opts.validateEvmInputPosition === "function" &&
    typeof opts.validateTonOutputPosition === "function";
  /** EVM→EVM: the source order protocol and factory, the destination factory,
   *  and both EVM position validators (source fill + destination escrow). */
  const evmToEvmReady = (from: string, to: string): boolean =>
    cfg.supports(from, to) && trustedOrderProtocols.has(from) && trustedContracts.has(from) && trustedContracts.has(to) &&
    typeof opts.validateEvmInputPosition === "function" &&
    typeof opts.validateEvmOutputPosition === "function";

  async function getSwapQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
    if (!cfg.supports(params.sourceChain, params.destChain) || !trustedContracts.has(params.sourceChain) || !sameChainTonReady()) return null;
    const source = ccAsset(params.sourceChain, params.sourceToken);
    const dest = ccAssetByToken(params.destChain, params.destToken);
    if (!source || !dest || source.symbol === dest.symbol) return null;
    const inputAsset = toAssetId(params.sourceChain, source, true);
    const outputAsset = toAssetId(params.destChain, dest, true);
    if (!inputAsset || !outputAsset || sameAsset(inputAsset, outputAsset) || !isPositiveInteger(params.amountIn)) return null;
    const trader = params.refundAddress ?? "";
    if (!trader && !params.dry) return null;
    const slippagePips = params.slippageBps !== undefined ? Math.round(params.slippageBps * 100) : SWAP_SLIPPAGE_PIPS_DEFAULT;
    if (!Number.isInteger(slippagePips) || slippagePips < 0 || slippagePips > 500_000) return null;

    const omni = await getClient();
    const settle = params.dry === false ? Math.min(quoteSettleMs, EXECUTION_SETTLE_MS) : quoteSettleMs;
    const outcome: RfqOutcome = {updates: 0};
    const rfq = async (pips: number): Promise<OmnistonQuote | null> => {
      const request: QuoteRequest = {
        inputAsset,
        outputAsset,
        amount: {$case: "inputUnits", value: params.amountIn},
        // One route → one outgoing message: a TON account sends exactly one.
        settlementParams: [{params: {$case: "swap", value: {maxPriceSlippagePips: pips, maxRoutes: 1}}}],
      };
      if (hasIntegrator) {
        const address = opts.integratorAddress ? toChainAddress(params.destChain, opts.integratorAddress) : null;
        if (!address) return null;
        request.integratorAddress = address;
        request.integratorFeePips = opts.integratorFeePips!;
      }
      // The SDK can still drop an ack (see getClient: frame delivery is now
      // deferred, which removed it in live runs) — give the socket a beat and
      // try once more.
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, 300));
        const quote = await awaitQuote(omni.requestForQuote(request), request, signal, settle, "swap", outcome);
        if (quote && quote.settlementData.$case === "swap") return quote;
        if (signal?.aborted) return null;
      }
      return null;
    };

    let q = await rfq(slippagePips);
    if (!q) {
      if (!signal?.aborted) {
        params.onRefusal?.(`omniston: ${outcome.error ? `RFQ failed: ${outcome.error}` : outcome.rejected ? `swap quote rejected: ${outcome.rejected}` : "no TON DEX route quoted this pair/amount"}`);
      }
      return null;
    }
    let swap = q.settlementData.$case === "swap" ? q.settlementData.value : null;
    if (!swap) return null;
    // Two floors the router holds a quote to, both of which a DEX quote can
    // miss by a rounding unit or a price tick: the absolute one the user saw
    // (`minAmountOut`, execution re-quotes) and the slippage one, computed by
    // the router as ceil(out × (1 − bps/10000)) where Omniston rounds its own
    // minimum down. The floor is what the trade must honour on-chain, so
    // re-quote (at most twice) with the slippage that puts the minimum on it —
    // the DEX then refunds below it.
    const absoluteFloor = params.minAmountOut !== undefined && isPositiveInteger(params.minAmountOut) ? BigInt(params.minAmountOut) : 0n;
    const requiredMin = (outputUnits: string): bigint => {
      const out = BigInt(outputUnits);
      const slippageFloor = params.slippageBps !== undefined
        ? (out * BigInt(10_000 - params.slippageBps) + 9_999n) / 10_000n
        : 0n;
      return absoluteFloor > slippageFloor ? absoluteFloor : slippageFloor;
    };
    for (let attempt = 0; attempt < 2 && BigInt(swap.minOutputAmount) < requiredMin(q.outputUnits); attempt++) {
      const out = BigInt(q.outputUnits);
      const floor = requiredMin(q.outputUnits);
      if (out < floor) return null;
      const tightened = bigintToNumber(((out - floor) * 1_000_000n) / out);
      const again = await rfq(Math.max(0, Math.min(tightened, slippagePips)));
      const againSwap = again?.settlementData.$case === "swap" ? again.settlementData.value : null;
      if (!again || !againSwap) return null;
      q = again;
      swap = againSwap;
    }
    if (BigInt(swap.minOutputAmount) < requiredMin(q.outputUnits)) return null;
    // The gas the route needs rides on the message; keep it under the same cap
    // that bounds escrow execution value.
    if (q.gasBudget !== undefined && BigInt(q.gasBudget) > BigInt(maxTonExecutionNano)) return null;
    // The on-chain minimum is the one at the REQUESTED slippage (the build
    // below asks for exactly that, never Omniston's "recommended" one, which
    // may be looser than what this quote promises).
    const minOut = swap.minOutputAmount;
    await saveBuilt(q.quoteId, {quote: q, at: Date.now(), bound: {trader, dest: params.destAddress, srcChain: params.sourceChain, kind: "swap"}});

    // Fees are charged in the OUTPUT asset; only a stable output approximates
    // USD. The TON gas budget is NOT a fee: it rides on the message and the
    // unused part returns, so it stays out of `fees` (the router's fee caps
    // would otherwise read 0.1 GRAM of gas on a 1 GRAM swap as a 10% fee).
    const feeUnits = Number(q.protocolFeeUnits || "0") + Number(q.integratorFeeUnits || "0");
    const stableOut = /^(USDT|USDC|USD₮|jUSDT)$/.test(dest.symbol);
    const feeUsd = stableOut ? feeUnits / 10 ** dest.decimals : 0;
    return {
      provider: "omniston",
      intentId: encodeIntent(q.quoteId, trader, params.destAddress, params.sourceChain, "swap"),
      depositAddress: "", // swap settlement — the built message pays the DEX directly
      depositMemo: null,
      sourceAmount: q.inputUnits,
      destAmount: q.outputUnits,
      minDestAmount: minOut,
      feeUsd: Number.isFinite(feeUsd) ? feeUsd : 0,
      fees: [
        ...(q.protocolFeeUnits && q.protocolFeeUnits !== "0" ? [{type: "protocol" as const, amount: q.protocolFeeUnits, token: feeToken(dest), included: true}] : []),
        ...(q.integratorFeeUnits && q.integratorFeeUnits !== "0" ? [{type: "affiliate" as const, amount: q.integratorFeeUnits, token: feeToken(dest), included: true}] : []),
      ],
      etaSeconds: 30,
      reliability: 0.9,
      validUntilMs: Date.now() + QUOTE_TTL_MS,
      // gasBudget = TON the message carries on top of the input; gasEstimate =
      // what the route is expected to burn. Consumers show both so the user
      // sees the 1.1 GRAM leaving for a 1 GRAM swap — and the refund.
      providerData: {
        settlement: "swap",
        protocols: swapProtocols(swap).join(","),
        ...(q.gasBudget ? {gasBudget: q.gasBudget} : {}),
        ...(q.estimatedGasConsumption ? {gasEstimate: q.estimatedGasConsumption} : {}),
      },
    };
  }

  async function buildSwapDeposit(
    ref: {quoteId: string; trader: string; dest: string; srcChain: string},
    q: OmnistonQuote,
    swap: SwapSettlement,
  ): Promise<UnsignedTx> {
    if (!ref.trader) throw new Error("omniston: quote was requested without a refund/source address");
    if (!isTon(ref.srcChain) || q.inputAsset.chain.$case !== "ton" || q.outputAsset.chain.$case !== "ton") {
      throw new Error("omniston: swap quote is not a TON same-chain swap");
    }
    if (!sameChainTonReady()) throw new Error("omniston: TON same-chain swaps need independent jetton-wallet and swap-target validators");
    const owner: ChainAddress = {chain: {$case: "ton", value: ref.trader}};
    const receiver: ChainAddress = {chain: {$case: "ton", value: ref.dest}};
    const omni = await getClient();
    if (typeof omni.tonBuildSwap !== "function") throw new Error("omniston: client does not support swap settlement (tonBuildSwap)");
    const tx = await omni.tonBuildSwap({
      quoteId: ref.quoteId,
      transferSrcAddress: owner,
      refundSrcAddress: owner,
      gasExcessAddress: owner,
      traderDstAddress: receiver,
      // Build at the slippage the quote was requested with: its
      // minOutputAmount is the minimum this module reported to the router.
      useRecommendedSlippage: false,
    });
    const [message, ...rest] = tx.messages;
    if (!message || rest.length > 0) throw new Error(`omniston: expected exactly one swap message, got ${tx.messages.length}`);
    if (message.jettonWalletStateInit) throw new Error("omniston: deploying a resolver-provided jetton wallet is not supported");
    if (!isPositiveInteger(message.sendAmount)) throw new Error("omniston: malformed swap message value");
    const sendAmount = BigInt(message.sendAmount);
    const gasCap = BigInt(maxTonExecutionNano);
    const gasBudget = q.gasBudget && isPositiveInteger(q.gasBudget) ? BigInt(q.gasBudget) : gasCap;
    const protocols = swapProtocols(swap);
    const inputJetton = assetContract(q.inputAsset);
    const payload = parseSwapPayload(message.payload);

    const routeSteps = swap.routes.length === 1 ? swap.routes[0]!.steps : [];
    const singleV1 = routeSteps.length === 1 && routeSteps[0]!.chunks.length === 1 && routeSteps[0]!.chunks[0]!.protocol === "StonFiV1";
    // STON.fi v1 native input (pTON v1): the message is a jetton transfer to the
    // ROUTER's pTON v1 wallet naming the router as destination (STON.fi SDK v1
    // shape; seen live 2026-10-22 for GRAM→USDT from ~100 GRAM up). Native
    // input, so the message carries input + gas.
    const ptonV1Native = !inputJetton && !!payload.jettonTransfer && singleV1;

    if (inputJetton) {
      // Jetton input: a transfer from the trader's OWN jetton wallet whose
      // forward lands in the DEX. The TON attached is gas only.
      const transfer = payload.jettonTransfer;
      if (!transfer) throw new Error("omniston: jetton-input swap message is not a jetton transfer");
      if (sendAmount > gasCap || sendAmount > gasBudget) throw new Error(`omniston: swap message attaches more TON than the quoted gas budget (${sendAmount} > ${gasBudget} nanoTON, cap ${gasCap}, ${protocols.join("+")})`);
      if (transfer.amount !== BigInt(q.inputUnits)) throw new Error("omniston: swap message moves a different amount than quoted");
      if (!transfer.responseDestination || !sameTonAddress(transfer.responseDestination, ref.trader)) {
        throw new Error("omniston: swap message returns excess to a wallet other than the trader");
      }
      if (transfer.forwardTon >= sendAmount) throw new Error("omniston: swap message forwards more TON than it carries");
      const walletValid = await opts.validateTonJettonWallet!({
        ownerAddress: ref.trader,
        jettonMasterAddress: inputJetton,
        walletAddress: message.targetAddress,
      });
      if (!walletValid) throw new Error("omniston: TON jetton wallet was not independently validated");
      const targetValid = await opts.validateTonSwapTarget!({address: transfer.destination, protocols});
      if (!targetValid) throw new Error("omniston: swap destination is not a recognized DEX contract for the quoted protocol");
    } else if (ptonV1Native) {
      const transfer = payload.jettonTransfer!;
      const input = BigInt(q.inputUnits);
      if (transfer.amount !== input) throw new Error("omniston: swap message moves a different amount than quoted");
      if (sendAmount < input) throw new Error("omniston: swap message carries less than the quoted input");
      const gas = sendAmount - input;
      if (gas > gasCap || gas > gasBudget) throw new Error(`omniston: swap message attaches more TON than the quoted gas budget (${gas} > ${gasBudget} nanoTON, cap ${gasCap}, ${protocols.join("+")})`);
      // pTON v1 forwards exactly the gas share of the value to the router (live: 0.1 of 0.1 GRAM).
      if (transfer.forwardTon > gas) throw new Error("omniston: swap message forwards more TON than its gas");
      if (!transfer.responseDestination || !sameTonAddress(transfer.responseDestination, ref.trader)) {
        throw new Error("omniston: swap message returns excess to a wallet other than the trader");
      }
      if (typeof opts.validateTonSwapLeg !== "function") throw new Error("omniston: STON.fi v1 native input needs the validateTonSwapLeg validator (pTON v1 wallet ownership)");
      // The pTON v1 wallet (a router-owned proxy-TON wallet) and the router it names.
      const targetValid = await opts.validateTonSwapTarget!({address: message.targetAddress, protocols});
      if (!targetValid) throw new Error("omniston: swap target is not a recognized DEX contract for the quoted protocol");
      const routerValid = await opts.validateTonSwapTarget!({address: transfer.destination, protocols});
      if (!routerValid) throw new Error("omniston: swap destination is not a recognized DEX contract for the quoted protocol");
    } else {
      // Native input: the message itself pays the DEX — value = input + gas.
      if (payload.jettonTransfer) {
        // Name what came back so the refusal can be triaged: which protocol route, where the message goes and what the jetton transfer targets.
        throw new Error(`omniston: native-input swap message must not be a jetton transfer (route ${protocols.join("+") || "?"}, target ${message.targetAddress}, transfer ${payload.jettonTransfer.amount} to ${payload.jettonTransfer.destination}, forwardTon ${payload.jettonTransfer.forwardTon}, value ${sendAmount})`);
      }
      const input = BigInt(q.inputUnits);
      if (sendAmount < input) throw new Error("omniston: swap message carries less than the quoted input");
      const gas = sendAmount - input;
      if (gas > gasCap || gas > gasBudget) throw new Error(`omniston: swap message attaches more TON than the quoted gas budget (${gas} > ${gasBudget} nanoTON, cap ${gasCap}, ${protocols.join("+")})`);
      const targetValid = await opts.validateTonSwapTarget!({address: message.targetAddress, protocols});
      if (!targetValid) throw new Error("omniston: swap target is not a recognized DEX contract for the quoted protocol");
    }

    // Scan F11: open the DEX call and bind receiver, refund/excess, minimum
    // output and the route's contracts to the quote. The pTON v1 path is new
    // and always enforced; elsewhere `tonSwapPayloadCheck` decides.
    const mode = ptonV1Native ? "enforce" : (opts.tonSwapPayloadCheck ?? "enforce");
    const trace = traceFor(ref.quoteId);
    const payloadRefusal = (reason: string, detail: string): void => {
      trace("ton-swap-payload", {reason, detail, mode, protocols: protocols.join("+")});
      if (mode === "enforce") throw new Error(`omniston: ton-swap-payload ${reason} — ${detail}`);
    };
    let checked: TonSwapCheckResult | null = null;
    try {
      checked = checkTonSwapPayload({
        payloadHex: message.payload,
        targetAddress: message.targetAddress,
        sendAmount,
        trader: ref.trader,
        dest: ref.dest,
        inputUnits: q.inputUnits,
        minOutputAmount: swap.minOutputAmount,
        inputJetton,
        outputJetton: assetContract(q.outputAsset),
        steps: swap.routes.length === 1
          ? routeSteps.map((step) => {
            if (step.chunks.length !== 1) return {protocol: `split(${step.chunks.map((c) => c.protocol).join("|")})`, inputJetton: undefined, outputJetton: undefined};
            return {protocol: step.chunks[0]!.protocol, inputJetton: stepJetton(step.inputAsset), outputJetton: stepJetton(step.outputAsset)};
          })
          : [{protocol: `${swap.routes.length}-routes`, inputJetton: undefined, outputJetton: undefined}],
        integratorAddress: q.integratorAddress?.chain.$case === "ton" ? q.integratorAddress.chain.value : null,
      });
    } catch (error) {
      if (error instanceof TonSwapPayloadError) payloadRefusal(error.reason, error.message);
      else payloadRefusal("malformed", error instanceof Error ? error.message : String(error));
    }
    if (checked) {
      if (typeof opts.validateTonSwapLeg !== "function") {
        trace("ton-swap-payload", {reason: "legs-unverified", detail: "no validateTonSwapLeg hook", mode, legs: checked.legs.length});
      } else {
        for (const leg of checked.legs) {
          let ok = false;
          try { ok = await opts.validateTonSwapLeg(leg); } catch { ok = false; }
          if (!ok) {
            payloadRefusal("leg-unverified", `${leg.kind} v${leg.version} ${leg.kind === "dedust-pool" ? `pool ${leg.pool}` : `ask wallet ${leg.askWallet}`}`);
            break;
          }
        }
      }
    }

    return {
      chain: ref.srcChain,
      to: message.targetAddress,
      value: message.sendAmount, // nanotons: gas only (jetton input) or input + gas (native)
      bodyBoc: hexToBase64(message.payload),
    };
  }

  async function trackSwap(decoded: {quoteId: string; trader: string}, sourceTxHash: string | null): Promise<IntentStatus> {
    // swapTrack needs a handle on the outgoing transaction; until the caller
    // knows it, the trade is simply pending.
    if (!sourceTxHash) return {state: "pending"};
    const omni = await getClient();
    if (typeof omni.swapTrack !== "function") return {state: "pending"};
    const progress = await awaitSwapProgress(
      omni.swapTrack({quoteId: decoded.quoteId, traderAddress: {chain: {$case: "ton", value: decoded.trader}}, outgoingTxQuery: sourceTxHash}),
    );
    if (!progress || progress === "awaiting") return {state: "pending"};
    switch (progress.status) {
      case "TRADE_STATUS_FULLY_FILLED":
        await quotes.clear(decoded.quoteId);
        return {state: "completed", depositReceived: true, ...(progress.outgoingTxHash ? {destTxHash: progress.outgoingTxHash} : {})};
      case "TRADE_STATUS_PARTIALLY_FILLED":
        // One route, so a partial fill means the DEX returned the rest to the
        // trader: the trade is over, and partial — not completed (round 3, L16).
        await quotes.clear(decoded.quoteId);
        return {state: "partial", depositReceived: true, ...(progress.outgoingTxHash ? {destTxHash: progress.outgoingTxHash} : {})};
      case "TRADE_STATUS_CANCELLED":
      case "TRADE_STATUS_FAILED":
        // A failed DEX swap bounces the input back to the trader on-chain: refunded (round 3, L16).
        await quotes.clear(decoded.quoteId);
        return {state: "refunded", depositReceived: true};
      default:
        return {state: "pending", depositReceived: true};
    }
  }

  /**
   * EVM→TON: generate the HTLC secret, ask Omniston for the EIP-712 order,
   * verify every byte the wallet is about to sign against the quote (order
   * fields, the 1inch extension the salt commits to, the serialized order
   * details), persist what registration needs, and hand the engine a gasless
   * typed-order `UnsignedTx` whose `approvalAddress` is the order protocol.
   */
  async function buildEvmOrder(
    ref: Decoded,
    q: OmnistonQuote,
    settlement: OrderSettlement,
    bound: IntentBinding | undefined,
  ): Promise<UnsignedTx> {
    const srcChain = ref.srcChain;
    const chainId = evmRef(srcChain);
    const srcCase = q.inputAsset.chain.$case;
    if (chainId === null || EVM_CASE[chainId] !== srcCase) throw new Error("omniston: source chain does not match the EVM quote");
    const destCase = q.outputAsset.chain.$case;
    const destChain = caipForChainCase(destCase);
    const tonDest = destCase === "ton";
    if (!destChain || destChain === srcChain) throw new Error("omniston: EVM-source order has no supported destination chain");
    if (
      !trustedOrderProtocols.has(srcChain) || typeof opts.validateEvmInputPosition !== "function" ||
      typeof (tonDest ? opts.validateTonOutputPosition : opts.validateEvmOutputPosition) !== "function"
    ) {
      throw new Error(`omniston: EVM→${tonDest ? "TON" : "EVM"} needs a trusted order protocol and both position validators`);
    }
    let owner: string;
    try {
      owner = getAddress(ref.trader);
    } catch {
      throw new Error("omniston: trader is not an EVM address");
    }
    let dest: string;
    if (tonDest) {
      try {
        TonAddress.parse(ref.dest);
      } catch {
        throw new Error("omniston: destination is not a TON address");
      }
      dest = ref.dest;
    } else {
      try {
        dest = getAddress(ref.dest);
      } catch {
        throw new Error("omniston: destination is not an EVM address");
      }
    }
    const traderDst = {chain: {$case: destCase, value: dest}} as ChainAddress;
    const protocol = settlement.srcProtocolContractAddress;
    const resolver = settlement.srcInitialResolverAddress;
    const factory = settlement.dstProtocolContractAddress;
    const inputToken = assetContract(q.inputAsset);
    const outputToken = assetContract(q.outputAsset);
    const destChainId = tonDest ? null : evmRef(destChain);
    if (
      protocol.chain.$case !== srcCase || !isTrustedOrderProtocol(srcChain, protocol.chain.value) ||
      resolver?.chain.$case !== srcCase || !validEvmAddress(resolver.chain.value) ||
      factory?.chain.$case !== destCase || !isTrusted(destChain, factory.chain.value) ||
      !inputToken || !outputToken || !Number.isSafeInteger(settlement.protocolFeePips) ||
      (!tonDest && (destChainId === null || !validEvmAddress(outputToken) || !isPositiveInteger(settlement.dstSecurityDepositUnits ?? "")))
    ) throw new Error("omniston: incomplete EVM order settlement binding in quote");

    // One execution: the signed order has ALLOW_MULTIPLE_FILLS clear and the
    // TON position commits a single hash. Persist BEFORE anything is signed.
    const {secrets, created} = await secretsFor(ref, q, 1);
    const hashes = secrets.map((secret) => hashlock(secret, settlement.htlcHashingFunction));
    // Clear only what this call created: a failed rebuild must not take the
    // secret of an order an earlier build already handed out for signing.
    const forget = async () => { if (created) await clearSecrets(ref.quoteId); };
    const omni = await getClient();
    let payload: Awaited<ReturnType<OmnistonClientLike["evmBuildOrderPayload"]>>;
    try {
      payload = await omni.evmBuildOrderPayload({
        quoteId: ref.quoteId,
        ownerSrcAddress: {chain: {$case: srcCase, value: owner}} as ChainAddress,
        traderDstAddress: traderDst,
        htlcSecrets: {secretMode: {$case: "provided", value: {hashes}}},
      });
    } catch (error) {
      await forget();
      throw error;
    }
    let td: unknown;
    try {
      try {
        td = JSON.parse(payload.typedData);
      } catch {
        throw new Error("omniston: malformed EVM order typed data");
      }
      validateSerializedOrderDetails(payload.serializedOrderDetails, {
        quoteId: ref.quoteId,
        outputAsset: q.outputAsset,
        traderDstAddress: traderDst,
        secretHashes: hashes,
      });
      validateEvmTypedOrder(td, {
        chainId,
        settlementContract: protocol.chain.value,
        owner,
        receiver: resolver.chain.value,
        makerAsset: inputToken,
        makingAmount: q.inputUnits,
        takingAmount: settlement.resolverSendsUnits,
        orderExtension: payload.orderExtension,
        quoteTimestamp: q.quoteTimestamp,
        tradeStartDeadline: settlement.tradeStartDeadline,
      });
      await validateEvmToTonOrderExtension(payload.orderExtension, {
        quoteId: ref.quoteId,
        quoteTimestamp: q.quoteTimestamp,
        tradeStartDeadline: settlement.tradeStartDeadline,
        protocolFeePips: settlement.protocolFeePips!,
        integratorFeePips: settlement.integratorFeePips ?? 0,
        initialResolverAddress: resolver.chain.value,
        outputTokenAddress: outputToken,
        traderDstAddress: dest,
        takerAsset: String(td.message.takerAsset),
        srcSecurityDepositUnits: settlement.srcHtlcSecurityDepositUnits ?? "",
        // TON destination: the TON deposit is bound in the TON position, not in
        // the EVM deposits word (live: 0 for every TON-destination order). EVM
        // destination: the word carries the quote's destination deposit and
        // ExtraDataArgs name the destination chain and token (live 2026-10-20).
        dstSecurityDepositUnits: tonDest ? "0" : settlement.dstSecurityDepositUnits!,
        ...(tonDest ? {} : {dstChainId: destChainId!}),
        secretHash: hashes[0]!,
        trustedTarget: (address) => isTrusted(srcChain, address),
      });
    } catch (error) {
      await forget();
      throw error;
    }
    // The validated extension targets one trusted factory on the source chain.
    const extensionTarget = getAddress(`0x${bytesToHex(payload.orderExtension.slice(32 + new DataView(payload.orderExtension.buffer, payload.orderExtension.byteOffset).getUint32(4, false), 32 + new DataView(payload.orderExtension.buffer, payload.orderExtension.byteOffset).getUint32(4, false) + 20))}`);
    // The SDK sends the domain chainId as a hex string ("0x2105"). Hand the
    // wallet a numeric chainId: signers that derive the EIP712Domain type from
    // the value types (viem) would otherwise sign a domain WITHOUT chainId and
    // the order protocol would reject the signature (live 2026-10-16).
    const typedData = JSON.stringify({...(td as object), domain: {...(td as {domain: object}).domain, chainId}});
    // Re-save the WHOLE entry: carry the binding forward, or every later
    // disclosure for this order would be refused as unbound.
    await saveBuilt(ref.quoteId, {
      quote: q,
      at: Date.now(),
      ...(bound ? {bound} : {}),
      evmOrder: {
        typedData,
        orderExtension: bytesToHex(payload.orderExtension),
        serializedOrderDetails: bytesToHex(payload.serializedOrderDetails ?? new Uint8Array()),
        owner,
        chainCase: srcCase,
        factory: extensionTarget,
      },
    });
    const orderProtocol = getAddress(protocol.chain.value);
    return {chain: srcChain, to: orderProtocol, value: "0", chainId, approvalAddress: orderProtocol, typedData};
  }

  return {
    name: "omniston",
    describeActivity: describeOmnistonActivity,
    enabled: () => (opts.enabled ?? true) && trustedContracts.size > 0,

    // Capability discovery comes from the provider itself, so it can run alone
    // or inside the optional aggregator without a central capability table.
    supportsChain: (chain: string) => cfg.supportsChain(chain),
    supportsChainPair: (fromChain: string, toChain: string) => cfg.supports(fromChain, toChain),    // TON↔TON swap settlement is same-chain by definition.
    supportsSameChain: true,

    supportsRoute(from: Asset, to: Asset): boolean {
      if (isTon(from.chain) && isTon(to.chain)) {
        return cfg.supports(from.chain, to.chain) && trustedContracts.has(from.chain) && sameChainTonReady();
      }
      if (isTon(from.chain) && !isTon(to.chain)) return tonSourceReady(from.chain, to.chain);
      if (!isTon(from.chain) && isTon(to.chain)) return evmSourceReady(from.chain, to.chain);
      return evmToEvmReady(from.chain, to.chain);
    },

    async getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null> {
      // Amount-flexible deposits need a static deposit address — orders don't have one.
      if (params.flex) return null;
      if (isTon(params.sourceChain) && isTon(params.destChain)) return await getSwapQuote(params, signal);
      const refuse = (reason: string): null => {
        params.onRefusal?.(`omniston: ${reason}`);
        return null;
      };
      const evmSource = !isTon(params.sourceChain);
      const tonDest = isTon(params.destChain);
      if (!cfg.supports(params.sourceChain, params.destChain)) return refuse("route is not an Omniston order corridor");
      if (!trustedContracts.has(params.sourceChain) || !trustedContracts.has(params.destChain)) {
        return refuse(`no trusted settlement contract configured for ${trustedContracts.has(params.sourceChain) ? params.destChain : params.sourceChain}`);
      }
      if (evmSource) {
        if (!trustedOrderProtocols.has(params.sourceChain)) return refuse(`no trusted EVM order protocol configured for ${params.sourceChain}`);
        if (typeof opts.validateEvmInputPosition !== "function" || typeof (tonDest ? opts.validateTonOutputPosition : opts.validateEvmOutputPosition) !== "function") {
          return refuse(tonDest
            ? "EVM→TON needs the EVM input-position and TON output-position validators"
            : "EVM→EVM needs the EVM input-position and EVM output-position validators");
        }
        if (params.dry === false) {
          if (tonDest) {
            try {
              TonAddress.parse(params.destAddress);
            } catch {
              return refuse("destination is not a TON address");
            }
          } else if (!validEvmAddress(params.destAddress)) return refuse("destination is not an EVM address");
        }
      } else if (
        typeof opts.validateTonJettonWallet !== "function" ||
        typeof opts.validateTonEscrowPayload !== "function" ||
        typeof opts.validateEvmOutputPosition !== "function"
      ) return refuse("TON→EVM needs the jetton-wallet, escrow-payload and EVM output-position validators");

      const source = ccAsset(params.sourceChain, params.sourceToken);
      const dest = ccAssetByToken(params.destChain, params.destToken);
      if (!source || !dest) return refuse("asset is not in the catalog");
      const inputAsset = toAssetId(params.sourceChain, source);
      const outputAsset = toAssetId(params.destChain, dest);
      if (!inputAsset || !outputAsset) {
        return refuse(`cross-chain orders are token corridors only (no ${!inputAsset ? source.symbol : dest.symbol} native leg)`);
      }

      // The resolver only fills the corridor up to ~$1000 a swap (stables 1:1).
      const maxUnits = decimalToUnits(maxUsdText, source.decimals);
      if (!maxUnits || !isPositiveInteger(params.amountIn)) return refuse("invalid amount");
      if (BigInt(params.amountIn) > maxUnits) return refuse(`amount above the ${maxUsdText} USD per-swap cap`);

      // Execution and tracking both need the trader's source-chain wallet.
      const trader = params.refundAddress ?? "";
      if (!trader && !params.dry) return refuse(`execution quote needs the trader's ${evmSource ? "EVM" : "TON"} address (refundAddress)`);
      if (evmSource && trader && !validEvmAddress(trader)) return refuse("refundAddress is not an EVM address");

      const request: QuoteRequest = {
        inputAsset,
        outputAsset,
        amount: {$case: "inputUnits", value: params.amountIn},
        settlementParams: [{params: {$case: "order", value: {}}}],
      } as QuoteRequest;
      const integrator = opts.integratorAddress ?? "";
      if (hasIntegrator) {
        const pips = opts.integratorFeePips!;
        const address = integrator ? toChainAddress(params.destChain, integrator) : null;
        if (!address) return refuse("integrator address is not valid on the destination chain");
        request.integratorAddress = address;
        request.integratorFeePips = pips;
      }

      const omni = await getClient();
      const rfq: RfqOutcome = {updates: 0};
      const q = await awaitQuote(
        omni.requestForQuote(request),
        request,
        signal,
        params.dry === false ? Math.min(quoteSettleMs, EXECUTION_SETTLE_MS) : quoteSettleMs,
        "order",
        rfq,
      );
      if (!q) {
        if (signal?.aborted) return null;
        return refuse(
          rfq.error ? `RFQ failed: ${rfq.error}`
            : rfq.rejected ? `resolver quote rejected: ${rfq.rejected}`
              : "no resolver quoted this route/amount",
        );
      }
      const orderData = q.settlementData.$case === "order" ? q.settlementData.value : null;
      if (!orderData) return refuse("resolver answered without order settlement");
      const srcContract = orderData.srcProtocolContractAddress.chain.value;
      if (evmSource ? !isTrustedOrderProtocol(params.sourceChain, srcContract) : !isTrusted(params.sourceChain, srcContract)) {
        return refuse(evmSource ? `untrusted ${params.sourceChain} order protocol ${srcContract}` : `untrusted TON settlement contract ${srcContract}`);
      }
      if (!orderData.dstProtocolContractAddress || !isTrusted(params.destChain, orderData.dstProtocolContractAddress.chain.value)) {
        return refuse(`untrusted ${params.destChain} settlement contract ${orderData.dstProtocolContractAddress?.chain.value ?? "(none)"}`);
      }
      const deadlineMs = orderData.tradeStartDeadline * 1000;
      if (!Number.isFinite(deadlineMs) || deadlineMs <= Date.now()) return refuse("quote trade-start deadline already passed");
      // An execution quote whose deadline cannot outlast signing + inclusion
      // would fund an escrow no resolver will fill.
      if (params.dry === false && deadlineMs - Date.now() < MIN_START_HEADROOM_MS) return refuse("quote trade-start deadline too close to execute");

      // The advertised corridors are stable-to-stable. Bound a resolver's
      // optimistic amount before it can dominate the router auction with an
      // impossible quote; settlement remains all-or-refund within this range.
      const inputScaled = BigInt(q.inputUnits) * 10n ** BigInt(dest.decimals);
      const outputScaled = BigInt(q.outputUnits) * 10n ** BigInt(source.decimals);
      if (outputScaled * 2n < inputScaled || outputScaled > inputScaled * 2n) return refuse("quoted output is outside 0.5x–2x of the input");

      if (await quoteIdInUse(q.quoteId)) return refuse("the platform reused a quote id that already belongs to an order");
      await saveBuilt(q.quoteId, {quote: q, at: Date.now(), bound: {trader, dest: params.destAddress, srcChain: params.sourceChain, kind: "order"}});

      // Fees are charged in the OUTPUT asset; the corridor is stables, so units
      // scaled by the dest decimals approximate USD.
      const feeUnits = Number(q.protocolFeeUnits || "0") + Number(q.integratorFeeUnits || "0");
      const feeUsd = feeUnits / 10 ** dest.decimals;

      return {
        provider: "omniston",
        intentId: encodeIntent(q.quoteId, trader, params.destAddress, params.sourceChain),
        depositAddress: "", // order settlement — no static deposit address
        depositMemo: null,
        sourceAmount: q.inputUnits,
        destAmount: q.outputUnits,
        minDestAmount: q.outputUnits, // HTLC fills at the quoted amount or refunds
        feeUsd: Number.isFinite(feeUsd) ? feeUsd : 0,
        fees: [
          ...(q.protocolFeeUnits && q.protocolFeeUnits !== "0" ? [{type: "protocol" as const, amount: q.protocolFeeUnits, token: feeToken(dest), included: true}] : []),
          ...(q.integratorFeeUnits && q.integratorFeeUnits !== "0" ? [{type: "affiliate" as const, amount: q.integratorFeeUnits, token: feeToken(dest), included: true}] : []),
        ],
        etaSeconds: 240,
        reliability: 0.9,
        validUntilMs: Math.min(Date.now() + QUOTE_TTL_MS, deadlineMs),
      };
    },

    /**
     * TON-source only: generate the HTLC secret, persist it, build the escrow
     * transfer. The returned tx carries the payload as a serialized CELL
     * (`bodyBoc`, base64) — sending it as a text comment would strand the swap.
     */
    async buildDeposit(quote: Quote): Promise<UnsignedTx> {
      if (!Number.isFinite(quote.validUntilMs) || quote.validUntilMs <= Date.now()) {
        throw new Error("omniston: quote expired — request a fresh quote");
      }
      const decoded = decodeIntent(quote.intentId);
      if (!decoded) throw new Error("omniston: malformed intent id");
      const cached = await loadBuilt(decoded.quoteId);
      if (!cached) throw new Error("omniston: quote expired — request a fresh quote");
      const ref = requireBinding(decoded, cached, "buildDeposit");
      const q = cached.quote;
      if (q.settlementData.$case === "swap") return await buildSwapDeposit(ref, q, q.settlementData.value);
      if (q.settlementData.$case !== "order" || q.settlementData.value.tradeStartDeadline * 1000 <= Date.now()) {
        throw new Error("omniston: quote trade deadline expired — request a fresh quote");
      }

      if (!ref.trader) throw new Error("omniston: quote was requested without a refund/source address");
      const srcCase = q.inputAsset.chain.$case;
      if (srcCase !== "ton") return await buildEvmOrder(ref, q, q.settlementData.value, cached.bound);
      const srcChain = ref.srcChain;
      if (!isTon(srcChain)) throw new Error("omniston: source chain does not match TON quote");
      const destCase = q.outputAsset.chain.$case;
      const traderDst = destCase === "ton" ? null : {chain: {$case: destCase, value: getAddress(ref.dest)}};
      if (!traderDst) throw new Error("omniston: TON-destination orders are not supported");

      const settlement = q.settlementData;
      const hashingFunction = settlement.$case === "order" ? settlement.value.htlcHashingFunction : undefined;
      const {secrets, created} = await secretsFor(ref, q, maxExecutions);
      const hashes = secrets.map((s) => hashlock(s, hashingFunction));
      // Clear only what this call created (see buildEvmOrder).
      const forget = async () => { if (created) await clearSecrets(ref.quoteId); };

      const owner: ChainAddress = {chain: {$case: "ton", value: ref.trader}};
      const omni = await getClient();
      let tx: {messages: EscrowMessage[]};
      try {
        tx = await omni.tonBuildEscrowTransfer({
          quoteId: ref.quoteId,
          ownerSrcAddress: owner,
          transferSrcAddress: owner,
          refundSrcAddress: owner,
          gasExcessAddress: owner,
          traderDstAddress: traderDst as ChainAddress,
          htlcSecrets: {secretMode: {$case: "provided", value: {hashes}}},
        });
      } catch (error) {
        await forget();
        throw error;
      }
      const [message, ...rest] = tx.messages;
      if (!message || rest.length > 0) {
        await forget();
        throw new Error(`omniston: expected exactly one escrow message, got ${tx.messages.length}`);
      }
      if (!isPositiveInteger(message.sendAmount) || BigInt(message.sendAmount) > BigInt(maxTonExecutionNano)) {
        await forget();
        throw new Error("omniston: resolver TON execution value exceeds the configured safety cap");
      }
      const expectedProtocol = q.settlementData.value.srcProtocolContractAddress;
      const initialResolver = q.settlementData.value.srcInitialResolverAddress;
      const jettonMaster = assetContract(q.inputAsset);
      if (expectedProtocol.chain.$case !== "ton" || initialResolver?.chain.$case !== "ton" || !jettonMaster) {
        await forget();
        throw new Error("omniston: incomplete TON settlement binding in quote");
      }
      if (message.jettonWalletStateInit) {
        await forget();
        throw new Error("omniston: deploying a resolver-provided jetton wallet is not supported");
      }
      let walletValid = false;
      try {
        walletValid = opts.validateTonJettonWallet
          ? await opts.validateTonJettonWallet({
            ownerAddress: ref.trader,
            jettonMasterAddress: jettonMaster,
            walletAddress: message.targetAddress,
          })
          : false;
      } catch (error) {
        await forget();
        throw error;
      }
      if (!walletValid) {
        await forget();
        throw new Error("omniston: TON jetton wallet was not independently validated");
      }
      try {
        if (!opts.validateTonEscrowPayload) {
          throw new Error("omniston: TON source requires an independent escrow-payload validator");
        }
        await validateTonEscrowPayload(message, {
          quoteId: ref.quoteId,
          inputUnits: q.inputUnits,
          resolverSendsUnits: q.settlementData.value.resolverSendsUnits,
          srcHtlcSecurityDepositUnits: q.settlementData.value.srcHtlcSecurityDepositUnits ?? "",
          protocolAddress: expectedProtocol.chain.value,
          ownerAddress: ref.trader,
          destinationChain: q.outputAsset.chain.$case,
          destinationAddress: ref.dest,
          outputTokenAddress: assetContract(q.outputAsset) ?? "",
          initialResolverAddress: initialResolver.chain.value,
          hashes,
          ...(hashingFunction ? {hashingFunction} : {}),
          exclusivityTimeout: q.settlementData.value.exclusivityTimeout ?? 0,
        }, opts.validateTonEscrowPayload);
      } catch (error) {
        await forget();
        throw error;
      }

      return {
        chain: srcChain,
        to: message.targetAddress,
        value: message.sendAmount, // nanotons (gas + forward), NOT the jetton amount
        bodyBoc: hexToBase64(message.payload),
      };
    },

    /**
     * Snapshot the order and use ready phases only to discover candidate EVM
     * escrows. Disclosure follows only after independent finalized on-chain
     * validation; transient failures are retried on the next poll.
     */
    async trackIntent(ref: IntentRef): Promise<IntentStatus> {
      const decoded = decodeIntent(ref.intentId);
      if (!decoded) throw new Error("omniston: malformed intent id");
      // Swap settlement never discloses anything: tracked from the feed alone.
      if (decoded.kind === "swap") return await trackSwap(decoded, ref.sourceTxHash ?? null);
      const trace = traceFor(decoded.quoteId);
      // The secret is released only against the context stored when the quote
      // was minted — never against trader/dest from the caller's intentId
      // (scan F3/F15). Without a cached context (completed, TTL) this is a plain
      // status read of the feed, exactly as before.
      const stored = await loadBuilt(decoded.quoteId);
      let cached: BuiltEntry | undefined;
      let bound: Decoded = decoded;
      if (stored) {
        const result = bindIntent(decoded, stored);
        if (!result.ok && result.reason === "mismatch") {
          trace("intent-mismatch", {where: "trackIntent", field: result.field});
          throw new Error(`omniston: intent id does not match the quote it was issued for (${result.field})`);
        }
        if (result.ok) {
          if (result.legacy) trace("legacy-intent", {where: "trackIntent"});
          cached = stored;
          bound = result.ref;
        } else {
          trace("legacy-intent-expired", {where: "trackIntent"});
        }
      }
      const omni = await getClient();
      const order = await awaitOrder(
        omni.orderTrack({
          quoteId: decoded.quoteId,
          traderAddress:
            toChainAddress(bound.srcChain, bound.trader) ??
            ({chain: {$case: "ton", value: bound.trader}} as ChainAddress),
        }),
      );
      if (!order) return {state: "pending"};

      const secretsHex = await store.load(decoded.quoteId);
      if (!secretsHex || cached?.quote.settlementData.$case !== "order") trace("disclosure-skipped", {gate: "context", secrets: !!secretsHex, cached: !!cached, feedStatus: order.status});
      if (secretsHex && cached?.quote.settlementData.$case === "order") {
        const q = cached.quote;
        const settlement = q.settlementData.value as OrderSettlement;
        const indices = order.executions.map((execution) => execution.index);
        const validIndices = indices.every((index) => Number.isSafeInteger(index) && index >= 0 && index < secretsHex.length) &&
          new Set(indices).size === indices.length;
        const outputTokenAddress = assetContract(q.outputAsset);
        const outputChain = q.outputAsset.chain.$case;
        const outputCaip = caipForChainCase(outputChain);
        const factory = settlement.dstProtocolContractAddress;
        const evmSource = q.inputAsset.chain.$case !== "ton";
        const tonDest = outputChain === "ton";
        const inputChain = q.inputAsset.chain.$case;
        const inputCaip = caipForChainCase(inputChain);
        const inputTokenAddress = assetContract(q.inputAsset);
        const evmOrder = cached.evmOrder;
        await Promise.all(
          order.executions.map(async (execution) => {
            const i = execution.index;
            const secret = validIndices ? secretsHex[i] : undefined;
            const phase = execution.outputPositionPhase;
            const position = execution.outputPositionAddress;
            const inputPosition = execution.inputPositionAddress;
            if (
              !secret || !validDisclosurePhase(phase) || !position || position.chain.$case !== outputChain ||
              !position.chain.value || !factory || factory.chain.$case !== outputChain || !outputTokenAddress || !outputCaip
            ) { trace("disclosure-skipped", {gate: "position", index: i, phase, positionChain: position?.chain.$case, outputChain}); return; }
            if (evmSource
              ? (!evmOrder || !inputCaip || !inputTokenAddress || !inputPosition || inputPosition.chain.$case !== inputChain || !inputPosition.chain.value ||
                !settlement.srcInitialResolverAddress || typeof opts.validateEvmInputPosition !== "function" ||
                typeof (tonDest ? opts.validateTonOutputPosition : opts.validateEvmOutputPosition) !== "function")
              : typeof opts.validateEvmOutputPosition !== "function"
            ) { trace("disclosure-skipped", {gate: "context-fields", index: i, evmSource, evmOrder: !!evmOrder, inputPositionChain: inputPosition?.chain.$case}); return; }
            const secretBytes = hexToBytes(secret);
            const expectedHash = hashlock(secretBytes, settlement.htlcHashingFunction);
            if (
              !execution.secretHash || !bytesEqual(execution.secretHash, expectedHash) ||
              execution.inputUnits !== q.inputUnits || execution.outputUnits !== q.outputUnits ||
              execution.resolverSendsUnits !== settlement.resolverSendsUnits
            ) { trace("disclosure-skipped", {gate: "terms", index: i, hashMatches: !!execution.secretHash && bytesEqual(execution.secretHash, expectedHash), inputUnits: [execution.inputUnits, q.inputUnits], outputUnits: [execution.outputUnits, q.outputUnits], resolverSendsUnits: [execution.resolverSendsUnits, settlement.resolverSendsUnits]}); return; }
            let verified = false;
            try {
              const evmOutput = () => opts.validateEvmOutputPosition!({
                chain: outputCaip,
                positionAddress: position.chain.value,
                factoryAddress: factory.chain.value,
                quoteTimestamp: q.quoteTimestamp,
                executionIndex: i,
                recipientAddress: bound.dest,
                outputTokenAddress,
                inputUnits: execution.inputUnits,
                outputUnits: execution.outputUnits,
                resolverSendsUnits: execution.resolverSendsUnits,
                srcHtlcSecurityDepositUnits: settlement.srcHtlcSecurityDepositUnits ?? "",
                dstSecurityDepositUnits: settlement.dstSecurityDepositUnits ?? "",
                protocolFeeUnits: q.protocolFeeUnits ?? "0",
                integratorFeeUnits: q.integratorFeeUnits ?? "0",
                ...(q.integratorAddress?.chain.value ? {integratorAddress: q.integratorAddress.chain.value} : {}),
                ...(settlement.protocolFeeRecipientAddress?.chain.value ? {protocolFeeRecipientAddress: settlement.protocolFeeRecipientAddress.chain.value} : {}),
                secretHash: expectedHash,
              });
              // EVM source: BOTH positions must be proven before the secret
              // leaves — the trader's full input locked on the source chain for
              // this hashlock, and the destination position (TON or EVM) the
              // trusted factory deployed for this quote, paying the recipient.
              verified = evmSource
                ? await opts.validateEvmInputPosition!({
                  chain: inputCaip!,
                  positionAddress: inputPosition!.chain.value,
                  factoryAddress: evmOrder!.factory,
                  orderProtocolAddress: settlement.srcProtocolContractAddress.chain.value,
                  ownerAddress: evmOrder!.owner,
                  resolverAddress: settlement.srcInitialResolverAddress!.chain.value,
                  inputTokenAddress: inputTokenAddress!,
                  inputUnits: execution.inputUnits,
                  resolverSendsUnits: execution.resolverSendsUnits,
                  srcHtlcSecurityDepositUnits: settlement.srcHtlcSecurityDepositUnits ?? "",
                  quoteTimestamp: q.quoteTimestamp,
                  secretHash: expectedHash,
                  ...(tonDest ? {} : {
                    destinationChainId: evmRef(outputCaip)!,
                    destinationTokenAddress: outputTokenAddress,
                    dstSecurityDepositUnits: settlement.dstSecurityDepositUnits ?? "",
                  }),
                }) && (tonDest
                  ? await opts.validateTonOutputPosition!({
                    positionAddress: position.chain.value,
                    protocolAddress: factory.chain.value,
                    outputJettonMasterAddress: outputTokenAddress,
                    recipientAddress: bound.dest,
                    quoteId: decoded.quoteId,
                    quoteTimestamp: q.quoteTimestamp,
                    inputUnits: execution.inputUnits,
                    outputUnits: execution.outputUnits,
                    resolverSendsUnits: execution.resolverSendsUnits,
                    dstSecurityDepositUnits: settlement.dstSecurityDepositUnits ?? "",
                    secretHash: expectedHash,
                  })
                  : await evmOutput())
                : await evmOutput();
            } catch (error) {
              verified = false;
              trace("validator-threw", {index: i, error: error instanceof Error ? error.message : String(error)});
            }
            if (!verified) { trace("validator-refused", {index: i, evmSource, tonDest}); return; }
            await omni
              .orderDiscloseHtlcSecret({quoteId: decoded.quoteId, executionIndex: i, secret: secretBytes})
              .then(async () => {
                trace("secret-disclosed", {index: i});
                // Disclosed = known to the counterparty: never lock a new order to it (scan F6).
                await store.save(disclosedKey(decoded.quoteId), ["1"]);
              }, (error) => trace("disclose-failed", {index: i, error: error instanceof Error ? error.message : String(error)})); // retried on the next poll
          }),
        );
      }

      const status = mapOrderStatus(order);
      const delivered = order.executions[0]?.outputPositionAddress;
      const outCase = cached?.quote.outputAsset.chain.$case;
      const outCaip = outCase ? caipForChainCase(outCase) : null;
      const outToken = cached ? assetContract(cached.quote.outputAsset) : null;
      if (
        status.state === "completed" && opts.locateEvmDelivery && outCase && outCase !== "ton" && outCaip && outToken &&
        order.executions.length === 1 && delivered?.chain.$case === outCase && delivered.chain.value
      ) {
        const hash = await opts.locateEvmDelivery({
          chain: outCaip, positionAddress: delivered.chain.value, recipientAddress: bound.dest,
          tokenAddress: outToken, minUnits: order.executions[0]!.outputUnits,
        }).catch(() => null);
        if (hash) status.destTxHash = hash;
      }
      if (
        status.state === "completed" && !status.destTxHash && opts.locateTonDelivery && outCase === "ton" && outToken &&
        order.executions.length === 1 && delivered?.chain.$case === "ton" && delivered.chain.value
      ) {
        const hash = await opts.locateTonDelivery({
          positionAddress: delivered.chain.value, recipientAddress: bound.dest,
          jettonMasterAddress: outToken, minUnits: order.executions[0]!.outputUnits,
        }).catch(() => null);
        if (hash) status.destTxHash = hash;
      }
      // A feed-only CANCELLED/FAILED signal is not on-chain invalidation of a
      // signed order. Retain secrets/context until proven completion or TTL so
      // a late valid output lock can still be completed safely.
      if (status.state === "completed") {
        await clearSecrets(decoded.quoteId);
        await quotes.clear(decoded.quoteId);
      }
      return status;
    },
    /** EVM→TON: hand the wallet's EIP-712 signature over the validated order to Omniston. */
    async registerSignedOrder(intentId: string, signature: string): Promise<void> {
      const ref = decodeIntent(intentId);
      if (!ref) throw new Error("omniston: malformed intent id");
      const cached = await loadBuilt(ref.quoteId);
      const order = cached?.evmOrder;
      if (!order) throw new Error("omniston: no signed-order context for this quote — build the order again");
      // Same binding as buildDeposit: the intentId must be the one this order was built for.
      requireBinding(ref, cached!, "registerSignedOrder");
      if (!/^0x[0-9a-fA-F]{130}$/.test(signature)) throw new Error("omniston: malformed order signature");
      const td = JSON.parse(order.typedData) as Parameters<typeof encodeTypedMessage>[0];
      const omni = await getClient();
      await omni.orderRegisterSignedOrder({
        quoteId: ref.quoteId,
        ownerSrcAddress: {chain: {$case: order.chainCase, value: order.owner}} as ChainAddress,
        signedOrder: {order: {$case: "evmV1", value: {
          encodedOrder: encodeTypedMessage(td),
          signature: hexToBytes(signature),
          orderExtension: hexToBytes(order.orderExtension),
        }}},
        ...(order.serializedOrderDetails ? {serializedOrderDetails: hexToBytes(order.serializedOrderDetails)} : {}),
      });
    },

    close(): void {
      clientGeneration += 1;
      if (client && (client !== injectedClient || opts.closeInjectedClient)) {
        if (client.close) client.close();
        else client.transport?.close();
      }
      client = null;
    },
  };
}
