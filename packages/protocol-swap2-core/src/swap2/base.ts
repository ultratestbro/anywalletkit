/**
 * `Swap2Protocol` adapter over the cross-chain engine.
 *
 * The engine speaks in symbols + CAIP-2 chain ids and a deposit-address /
 * calldata execution model; core's `Swap2Protocol` speaks in provider token ids
 * bound to an account whose chain is the source. This base bridges the two:
 * it maps `Swap2Options` → the engine's `QuoteParams`, delegates quoting to a
 * provider (or the router, in the aggregator), and executes the source leg
 * through the bound account. Subclasses only supply "which provider(s)".
 */
import {Swap2Protocol} from "@anywalletkit/core";
import {encodeFunctionData, getAddress} from "viem";
import {decodeCall} from "@anywalletkit/tx-preview-evm";
import type {
  Swap2Options,
  Swap2Quote,
  Swap2Result,
  Swap2StatusOptions,
  Swap2StatusResult,
  Swap2Status,
  Swap2Fee,
  Swap2ProtocolConfig,
  Swap2SupportedChain,
  Swap2SupportedToken,
  Swap2SupportedTokensOptions,
  BridgeOptions,
  BridgeResult,
  SwapOptions,
  SwapResult,
} from "@anywalletkit/core";
import {
  CC_SOURCE_CHAINS,
  ccAsset,
  ccAssetByToken,
  isTokenAddress,
  isUnlisted,
  resolveAsset,
  type CcAsset,
  type CcChain,
} from "@anywalletkit/swap2-assets";
import type {CrossChainProvider, IntentStatus, QuoteParams, Quote, UnsignedTx} from "../types.js";
import {
  Swap2ConfigurationError,
  Swap2ExecutionError,
  Swap2FeeLimitError,
  Swap2InFlightError,
  Swap2InsufficientGasError,
  Swap2MaybeSentError,
  Swap2QuoteError,
  Swap2StatusError,
  Swap2UnsupportedOperationError,
  Swap2ValidationError,
} from "../errors.js";

const ZERO = "0x0000000000000000000000000000000000000000";

const ERC20_TRANSFER_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      {name: "to", type: "address"},
      {name: "amount", type: "uint256"},
    ],
    outputs: [{type: "bool"}],
  },
] as const;
const ERC20_APPROVE_ABI = [
  {type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{name: "spender", type: "address"}, {name: "amount", type: "uint256"}], outputs: [{type: "bool"}]},
] as const;
const approveData = (spender: string, amount: bigint) =>
  encodeFunctionData({abi: ERC20_APPROVE_ABI, functionName: "approve", args: [spender as `0x${string}`, amount]});

/** swap2() calls running per account object, keyed by their options: a double tap must not run two swaps. */
const IN_FLIGHT = new WeakMap<object, Set<string>>();
const inFlightKey = (fromChain: string, o: Swap2Options) =>
  JSON.stringify([fromChain, o.fromToken, o.toToken, o.toChain, o.recipient, o.refundAddress, o.fromTokenAmount, o.toTokenAmount, o.minAmountOut, o.slippage],
    (_k, v) => (typeof v === "bigint" ? v.toString() : v));

/** A lost transport answer, in a message, an error code or an error name (Node / undici / React Native / browsers). */
const LOST_ANSWER = /socket hang up|ECONNRESET|ECONNABORTED|ETIMEDOUT|EPIPE|ENETUNREACH|EHOSTUNREACH|EAI_AGAIN|UND_ERR_[A-Z_]+|timed? ?out|TimeoutError|request aborted|AbortError|connection (?:closed|reset)|fetch failed|failed to fetch|network request failed|other side closed/i;

/**
 * Did a failed broadcast possibly reach the node? Every chain package says so on its error
 * (`BroadcastUnknownError`: `maybeSent` + the locally computed `hash`), anywhere in the cause
 * chain. A node's explicit refusal (`answered: true`) is a clean failure. Otherwise a lost
 * transport answer — in the message, code or name of any error in the chain (`fetch failed` with
 * an `UND_ERR_*` cause, React Native's `Network request failed`, `ECONNRESET`, a `TimeoutError`) —
 * is treated as possibly sent (round 3, M12). A refusal before signing is a clean failure.
 */
function maybeSent(error: unknown): {hash?: string} | null {
  const chain: Array<{maybeSent?: unknown; hash?: unknown; answered?: unknown; message?: unknown; code?: unknown; name?: unknown}> = [];
  for (let e = error as {cause?: unknown} | undefined, i = 0; e && typeof e === "object" && i < 6; e = e.cause as typeof e, i++) chain.push(e as never);
  for (const e of chain) if (e.maybeSent === true) return typeof e.hash === "string" && e.hash ? {hash: e.hash} : {};
  if (chain.some((e) => e.answered === true)) return null;
  const texts = chain.length ? chain.map((e) => [e.message, e.code, e.name].filter((x) => typeof x === "string").join(" ")) : [String(error)];
  return texts.some((t) => LOST_ANSWER.test(t)) ? {} : null;
}

/** Our config adds the account's source chain (CAIP-2) the base type omits. */
/**
 * Where an execution is, for progress UIs. A source leg can spend a minute
 * before anything is signed (two awaited ERC-20 approvals for USDT), so
 * "signing" alone reads as hung. "requoting": the mined approvals outlived
 * the quote's TTL and the engine is fetching a fresh quote for the same
 * spender and amount (the allowance is kept, not revoked). Diagnostics only:
 * a throwing observer can never change the outcome.
 */
/**
 * Most native coin a route may charge on top of the input (bridge messaging
 * fees), base units per chain. Above this the quote is refused even though it
 * declared the fee — a provider bug or a hostile backend must not turn a
 * token swap into a native drain.
 */
/**
 * Base-unit precision of a chain's native coin — what `value`, `eth_getBalance`
 * and a declared `nativeFee` are counted in. Every EVM chain the engine knows
 * accounts for gas in 18-decimal units, Arc included: Arc's gas token is USDC,
 * but its native accounting is 18-decimal ("the native USDC gas token uses 18
 * decimals of precision, while the USDC ERC-20 interface uses 6" —
 * docs.arc.network, gas-and-fees / contract-addresses, 2026-10-14). Arc is
 * pinned here so the 6-decimal ERC-20 view can never leak into a ceiling:
 * 10 USDC of fee headroom is 10 × 10^18 base units, not 10 × 10^6. A chain
 * whose native accounting is genuinely not 18-decimal gets its own row and
 * every cap below, declared in whole coins, scales with it.
 */
export const NATIVE_DECIMALS: Readonly<Record<string, number>> = Object.freeze({
  "eip155:5042": 18, // Arc — USDC gas token, 18-decimal native accounting (ERC-20 view at 0x3600… is 6)
});
const DEFAULT_NATIVE_DECIMALS = 18;
/** Decimals of `chain`'s native coin in base units (18 unless the chain says otherwise). */
export function nativeDecimals(chain: string): number {
  return NATIVE_DECIMALS[chain] ?? DEFAULT_NATIVE_DECIMALS;
}
/** `whole` native coins (an integer, or a decimal string such as "0.005") in `chain`'s base units. */
export function nativeUnits(chain: string, whole: number | string): bigint {
  const text = String(whole);
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`swap2: malformed native amount '${text}'`);
  const [int, frac = ""] = text.split(".") as [string, string?];
  const decimals = nativeDecimals(chain);
  if (frac.length > decimals) throw new Error(`swap2: '${text}' has more than ${decimals} fractional digits for ${chain}`);
  return BigInt(int + frac.padEnd(decimals, "0"));
}
const NATIVE_FEE_CAP: Readonly<Record<string, bigint>> = Object.freeze({
  "eip155:1": 5_000_000_000_000_000n, // 0.005 ETH
  "eip155:137": 20_000_000_000_000_000_000n, // 20 POL
  "eip155:56": 5_000_000_000_000_000n, // 0.005 BNB
  "eip155:43114": 100_000_000_000_000_000n, // 0.1 AVAX
  "eip155:999": 100_000_000_000_000_000n, // 0.1 HYPE
  // Non-ETH natives, ~$10-12 each at 2026-10-13 prices (0.005 ETH ≈ $12.6).
  "eip155:100": 10_000_000_000_000_000_000n, // 10 xDAI
  "eip155:143": 400_000_000_000_000_000_000n, // 400 MON
  "eip155:146": 200_000_000_000_000_000_000n, // 200 S
  "eip155:9745": 150_000_000_000_000_000_000n, // 150 XPL
  "eip155:42220": 100_000_000_000_000_000_000n, // 100 CELO
  "eip155:80094": 50_000_000_000_000_000_000n, // 50 BERA
  "eip155:1329": 200_000_000_000_000_000_000n, // 200 SEI
  "eip155:98866": 500_000_000_000_000_000_000n, // 500 PLUME
  "eip155:196": 100_000_000_000_000_000n, // 0.1 OKB
  // 2026-10-14 batch, ~$10 each at 2026-10-14 prices; declared in whole coins so the chain's native decimals apply.
  "eip155:5000": nativeUnits("eip155:5000", 20), // 20 MNT (≈ $0.53 each)
  "eip155:14": nativeUnits("eip155:14", 1500), // 1500 FLR (≈ $0.0067 each)
  "eip155:5042": nativeUnits("eip155:5042", 10), // 10 USDC — Arc's gas token, in its 18-decimal native units
  // Katana and Morph are ETH-denominated: the 0.005 ETH default applies.
});
const DEFAULT_NATIVE_FEE_CAP = 5_000_000_000_000_000n; // 0.005 of an ETH-denominated L2

function declaredNativeFee(q: {txRequest?: {nativeFee?: string}}, chain: string): bigint {
  const raw = q.txRequest?.nativeFee;
  if (raw === undefined) return 0n;
  if (!/^\d+$/.test(raw)) throw new Error("swap2: quote declares a malformed native fee");
  const fee = BigInt(raw);
  const cap = NATIVE_FEE_CAP[chain] ?? DEFAULT_NATIVE_FEE_CAP;
  if (fee > cap) throw new Error(`swap2: quoted native fee ${fee} exceeds the cap ${cap} for ${chain}`);
  return fee;
}

export type Swap2ExecutionPhase = "approving" | "requoting" | "preflight" | "signing" | "broadcast";
export interface Swap2ExecutionPhaseDetail {
  /** approving: which approval of how many (USDT on Ethereum needs two). */
  index?: number;
  total?: number;
  /** broadcast: the source transaction hash. */
  hash?: string;
}

/** A bigint chain id as a number, or undefined outside the safe range (checked before converting: Hermes mis-converts above 2^63). */
const safeChainId = (v: bigint): number | undefined => (v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v.toString()) : undefined);

/** EIP-712 domain with `chainId` as a number whatever notation the provider used. */
export function normalizeTypedDomain(domain: unknown): unknown {
  if (!domain || typeof domain !== "object") return domain;
  const raw = (domain as {chainId?: unknown}).chainId;
  let chainId: number | undefined;
  if (typeof raw === "number") chainId = raw;
  else if (typeof raw === "bigint") chainId = safeChainId(raw);
  else if (typeof raw === "string" && /^\d+$/.test(raw)) chainId = Number(raw);
  else if (typeof raw === "string" && /^0x[0-9a-fA-F]+$/.test(raw)) chainId = safeChainId(BigInt(raw));
  return chainId === undefined || !Number.isSafeInteger(chainId) ? domain : {...(domain as object), chainId};
}

export interface Swap2EngineConfig extends Swap2ProtocolConfig {
  /** CAIP-2 of the chain the bound account lives on (the swap2 source). */
  fromChain: string;
  /** Progress observer, see {@link Swap2ExecutionPhase}. */
  onExecutionPhase?: (phase: Swap2ExecutionPhase, detail?: Swap2ExecutionPhaseDetail) => void;
  /** Explicit escape hatch for adapters that can prove chain binding elsewhere. */
  skipAccountChainCheck?: boolean;
  /** Optional account chain identity when the account does not expose a provider. */
  accountChain?: string;
  /**
   * Decodes a base64 BoC into a TON `Cell` for deposits that carry a cell body
   * (e.g. Omniston escrow payloads). The package deliberately does not depend on
   * `@ton/core`; the caller supplies e.g. `(b) => Cell.fromBase64(b)`. Without
   * it, cell-body deposits fail closed — a TON account treats a string body
   * as a TEXT COMMENT, which would strand the swap.
   */
  decodeTonBody?: (bocBase64: string) => unknown;
  /**
   * Provider-SERIALIZED legs (a swap aggregator's fully built Solana
   * transaction): how much native coin, in base units, the account may lose
   * on top of the swap input — rent for a destination token account, wrapped
   * SOL juggling, priority fees. Default 20 000 000 lamports (0.02 SOL).
   */
  serializedNativeAllowance?: bigint | number | string;
  /**
   * Review gate: called once the live quote is built and every payload/value
   * check has passed, BEFORE any approval or signature. It receives a copy of
   * exactly what will be signed; throwing (the user cancelled) aborts with
   * nothing sent. A quote that expires while the gate is open is refused
   * before the first approval. When the quote expires while the engine's own
   * approval is being mined, the engine re-quotes once; if the fresh quote
   * differs from the reviewed one (payload, gas, a worse output) the gate is
   * called again with `requoted: true`, and throwing then revokes the allowance.
   */
  reviewExecution?: (plan: Swap2ExecutionPlan) => Promise<void> | void;
  /**
   * Accept tokens the swap catalog does not list, named by their contract (EVM) or mint (Solana):
   * tokens the user added at their own risk. Off by default. The source token's decimals are read
   * with the account's `getTokenInfo` (a `fromTokenDecimals` that disagrees is refused); an account
   * without it must be given `fromTokenDecimals`. Only providers that trade any token (LI.FI,
   * Uniswap, Balancer, Fynd, Jupiter) quote them, and they have no USD value: the router cannot
   * judge their price, so show the user the amounts.
   */
  allowUnlistedTokens?: boolean;
}

/** What `swap2()` is about to sign, handed to {@link Swap2EngineConfig.reviewExecution}. */
export interface Swap2ExecutionPlan {
  provider: string;
  fromChain: string;
  destChain: string;
  destToken: string;
  recipient: string;
  refundAddress: string;
  sourceAmount: bigint;
  destAmount: bigint;
  minDestAmount: bigint;
  feeUsd: number;
  etaSeconds: number;
  validUntilMs: number;
  /** ERC-20 approvals sent first, in order (USDT on Ethereum resets to 0 first). */
  approvals: {token: string; spender: string; amount: bigint; chainId?: number}[];
  /**
   * `true` on a second review: the first quote expired while its approval was being mined, and
   * the fresh one differs from what was reviewed (another payload, a worse output). The allowance
   * is already in place, so `approvals` is empty; cancelling revokes it.
   */
  requoted?: true;
  /** The source leg exactly as the account will receive it. */
  source:
    | {kind: "call"; to: string; data?: string; value: bigint; chainId?: number; gasLimit?: bigint; memo?: string; memoEncoding?: "utf8" | "hex"; cellBody?: boolean}
    | {kind: "token-transfer"; token: string; recipient: string; amount: bigint; memo?: string; memoEncoding?: "utf8" | "hex"}
    | {kind: "serialized"; serializedTx: string}
    | {kind: "typed-order"; typedData: string};
}

/**
 * What a provider-serialized transaction is allowed to do with the bound
 * account's balances; derived from the validated quote and handed to the
 * account's `sendSerializedTransaction` hook, which must prove it (simulate
 * with post-state balances) before signing. Amounts are base-unit strings.
 */
export interface SerializedExecutionExpectation {
  /** Most native coin the account may lose, fee excluded: swap input (native source) + allowance. */
  maxValueOut: string;
  /** Same-chain swaps: the token the account must receive and the quoted minimum (zero address = native). */
  tokenIn?: {token: string; minAmount: string};
  /** Token sources: the token the account may send and the exact swap input. */
  source?: {token: string; maxAmount: string};
}

const DEFAULT_SERIALIZED_NATIVE_ALLOWANCE = 20_000_000n;

/**
 * A bound wallet account, accepted opaquely: the write surface we need is
 * reached through {@link Swap2Signer}. Passing `undefined` builds a quote-only
 * protocol (no `swap2()` execution).
 */
export type Swap2Account = unknown;

/** Minimal write surface we need off the bound account to send the leg. */
interface Swap2Signer {
  getAddress(): Promise<string> | string;
  sendTransaction(tx: {
    to?: string;
    data?: string;
    value?: bigint;
    chainId?: number;
    gasLimit?: bigint;
    /** TON message body: a text comment (string) or a decoded Cell. */
    body?: string | unknown;
    /** Tron: swap memo the account must place in `raw_data.data`. */
    memo?: string;
    /** Tron: 'hex' = `memo` is a binary payload in 0x-hex (default 'utf8'). */
    memoEncoding?: "utf8" | "hex";
  }): Promise<{hash?: string}>;
  /** The account's token-transfer surface, used by TON/Solana/Tron accounts. */
  transfer?: (options: {
    token: string;
    recipient: string;
    amount: bigint;
    /** Tron TRC-20: memo in `raw_data.data` next to the TriggerSmartContract. */
    memo?: string;
    /** Tron: 'hex' = `memo` is a binary payload in 0x-hex (default 'utf8'). */
    memoEncoding?: "utf8" | "hex";
  }) => Promise<{hash?: string}>;
  signTypedData?: (args: {domain: unknown; types: unknown; primaryType?: string; message: unknown}) => Promise<string>;
  /**
   * Execute a provider-built transaction the account cannot rebuild (a swap
   * aggregator's serialized Solana tx). The account owns the proof: it must
   * refuse anything beyond `expect` before signing.
   */
  sendSerializedTransaction?: (serializedTx: string, expect: SerializedExecutionExpectation) => Promise<{hash?: string}>;
  /**
   * Wait until a transaction this account sent is INCLUDED (and succeeded).
   * Used between an ERC-20 approval and the deposit that spends it: a signer
   * that returns on broadcast leaves the deposit's gas estimate looking at a
   * block where the allowance is still zero (or, for USDT's approve(0) →
   * approve(n) dance, still non-zero) — "execution reverted" before any
   * funds move. Accounts without it keep the fire-and-forget behaviour.
   */
  waitForTransaction?: (hash: string) => Promise<void>;
  /**
   * Current ERC-20 allowance of this account for `spender`. With it the
   * engine sends only the approvals the chain needs: none when the exact
   * allowance is already live, a single approve(n) for mainnet USDT when the
   * current allowance is 0 (its reset rule only bites non-zero → non-zero).
   * Without it (or when the read fails) the engine assumes the worst and
   * resets USDT every time.
   */
  getAllowance?: (token: string, spender: string) => Promise<bigint | number | string>;
  /** EVM gas pre-check before approvals: native balance and a fee upper bound per tx. */
  getBalance?: () => Promise<bigint | number | string>;
  quoteSendTransaction?: (tx: {to: string; data?: string; value?: bigint; chainId?: number; gasLimit?: bigint}) => Promise<{fee: bigint}>;
  /** CAIP-2 id of a @anywalletkit/core account. */
  chain?: string;
  getChainId?: () => Promise<number | bigint> | number | bigint;
  getNetwork?: () => Promise<{chainId?: number | bigint} | string> | {chainId?: number | bigint} | string;
  chainId?: number | bigint;
  _provider?: {getNetwork?: () => Promise<{chainId?: number | bigint}>};
  provider?: {getNetwork?: () => Promise<{chainId?: number | bigint}>};
}

/**
 * An exact allowance the first execution pass mined before its quote
 * expired, handed to the re-quote pass (SDK-128). The pass that adopts it
 * owns its cleanup; until then the first pass revokes on any failure.
 */
interface CarriedAllowance {
  token: string;
  spender: string;
  amount: bigint;
  revoke: () => Promise<void>;
  adopted: boolean;
  /** What the first pass's `reviewExecution` approved; the re-quote is reviewed again if it differs. */
  reviewed?: Swap2ExecutionPlan;
}

/**
 * What a reviewer committed to, minus what a re-quote may refresh without asking again: the
 * timing, fee estimate and ETA, the approvals (already mined), and the expected output, which is
 * compared separately (only a worse one asks again).
 */
function reviewedIdentity(plan: Swap2ExecutionPlan): string {
  const {feeUsd: _fee, etaSeconds: _eta, validUntilMs: _valid, approvals: _approvals, destAmount: _dest, requoted: _requoted, ...pinned} = plan;
  return JSON.stringify(pinned, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v));
}

/** Swap2 status ids are `awk1.<provider>.<intent>[.<sourceTxHash>]` (URI-encoded segments). */
export const SWAP2_ID_PREFIX = "awk1";

/** Versioned provider/intent/source-hash id for durable status tracking. */
function encodeId(provider: string, intentId: string, sourceTxHash?: string): string {
  // encodeURIComponent leaves "." unescaped, which would shift decodeId's
  // split — escape it explicitly so segments are dot-safe.
  const enc = (v: string) => encodeURIComponent(v).replace(/\./g, "%2E");
  return `${SWAP2_ID_PREFIX}.${[provider, intentId, sourceTxHash].filter((v): v is string => v != null).map(enc).join(".")}`;
}
function decodeId(id: string): {provider: string; intentId: string; sourceTxHash?: string} {
  try {
    if (!id.startsWith(`${SWAP2_ID_PREFIX}.`)) throw new Error("unsupported id version");
    const parts = id.slice(SWAP2_ID_PREFIX.length + 1).split(".");
    if (parts.length < 2 || parts.length > 3 || !parts[0] || !parts[1]) throw new Error("invalid id shape");
    const provider = decodeURIComponent(parts[0]);
    const intentId = decodeURIComponent(parts[1]);
    const sourceTxHash = parts[2] ? decodeURIComponent(parts[2]) : undefined;
    if (!/^[A-Za-z0-9_-]+$/.test(provider) || !intentId || (parts[2] !== undefined && !sourceTxHash)) {
      throw new Error("invalid id contents");
    }
    return {provider, intentId, ...(sourceTxHash ? {sourceTxHash} : {})};
  } catch {
    throw new Swap2ValidationError("swap2: malformed swap2 status id");
  }
}

async function readAccountChain(signer: Swap2Signer, configured?: string): Promise<string | number | bigint | undefined> {
  if (configured) return configured;
  // @anywalletkit/core accounts carry their CAIP-2 id directly.
  if (typeof signer.chain === "string" && signer.chain && !signer.chain.endsWith(":unknown")) return signer.chain;
  if (typeof signer.getChainId === "function") return await signer.getChainId();
  if (typeof signer.getNetwork === "function") {
    const network = await signer.getNetwork();
    return typeof network === "string" ? network : network?.chainId;
  }
  if (signer.chainId != null) return signer.chainId;
  for (const provider of [signer._provider, signer.provider]) {
    if (provider?.getNetwork) {
      const network = await provider.getNetwork();
      if (network?.chainId != null) return network.chainId;
    }
  }
  return undefined;
}

/** CAIP-2 → the coarse VM family Swap2SupportedChain.type expects. */
function chainType(caip2: string): string {
  const ns = caip2.split(":")[0] ?? "";
  if (ns === "eip155") return "evm";
  if (ns === "solana") return "svm";
  if (ns === "tron") return "tvm";
  if (["bitcoin", "litecoin", "doge", "bch", "zcash"].includes(ns)) return "utxo";
  return ns;
}

/**
 * The wallet packages name non-EVM chains by genesis hash (CAIP-2 proper:
 * `account.chain` of a Solana account is `solana:5eykt…`), while the swap2
 * catalog and every provider use the short ids. The engine takes either.
 */
export const SWAP2_CHAIN_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp": "solana:mainnet",
  "tron:0x2b6653dc": "tron:728126428",
  "bip122:000000000019d6689c085ae165831e93": "bitcoin:mainnet",
});
/** The swap2 id for `chain` (itself when it has no alias). */
export const swap2ChainId = (chain: string): string => SWAP2_CHAIN_ALIASES[chain] ?? chain;

/** Normalize a `toChain` (number chainId | CAIP-2 | numeric string) to CAIP-2. */
function toCaip2(chain: string | number | undefined, fallback: string): string {
  if (chain == null || chain === "") return fallback;
  if (typeof chain === "number") {
    if (!Number.isSafeInteger(chain) || chain <= 0) throw new Swap2ValidationError("swap2: chain id must be a positive safe integer");
    return `eip155:${chain}`;
  }
  if (/^\d+$/.test(chain)) {
    const id = Number(chain);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Swap2ValidationError("swap2: chain id must be a positive safe integer");
    return `eip155:${id}`;
  }
  if (!/^[a-z0-9]{3,8}:[-_A-Za-z0-9]{1,32}$/.test(chain)) {
    throw new Swap2ValidationError("swap2: chain must be a valid CAIP-2 identifier");
  }
  return swap2ChainId(chain);
}

/** Resolve a token ref (symbol OR on-chain address) to the engine's symbol. */
function toSymbol(caip2: string, ref: string): string {
  const byToken = ref.startsWith("0x") || ref.length > 20 ? ccAssetByToken(caip2, ref) : undefined;
  if (byToken) return byToken.symbol;
  if (ccAsset(caip2, ref)) return ref; // already a symbol we know
  return ref;
}

/** Resolve a dest token ref to the engine's dest address (zero = native). */
function toDestAddress(caip2: string, ref: string, allowUnlisted = false): string {
  if (ref.startsWith("0x")) return ref;
  const asset = ccAssetByToken(caip2, ref) ?? ccAsset(caip2, ref);
  if (!asset) {
    if (allowUnlisted && isTokenAddress(caip2, ref)) return ref;
    throw new Error(`swap2: unknown destination token '${ref}' on ${caip2}`);
  }
  return asset.contract ?? ZERO;
}

function snapshotOptions(options: Swap2Options): Swap2Options {
  return Object.freeze({...options});
}

function snapshotConfig(config?: Swap2ProtocolConfig): Swap2ProtocolConfig | undefined {
  return config ? Object.freeze({...config}) : undefined;
}

function snapshotQuote<T extends Quote>(quote: T): T {
  return Object.freeze({
    ...quote,
    ...(quote.txRequest ? {txRequest: Object.freeze({...quote.txRequest})} : {}),
    ...(quote.providerData ? {providerData: Object.freeze({...quote.providerData})} : {}),
    ...(quote.fees ? {fees: Object.freeze(quote.fees.map((fee) => Object.freeze({...fee})))} : {}),
  }) as T;
}

function exactPositiveAmount(value: number | bigint, name: string): bigint {
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Swap2ValidationError(`swap2: ${name} must be a positive safe integer or bigint`);
    }
    return BigInt(value);
  }
  if (value <= 0n) throw new Swap2ValidationError(`swap2: ${name} must be a positive safe integer or bigint`);
  return value;
}

/**
 * floor(x × scale) that forgives binary representation error: a caller's
 * 0.0029 is 29 bps, though 0.0029 × 10 000 is 28.999…96 in floating point
 * (573 of the 10 001 whole-bps decimals land one short with a plain floor).
 */
function floorScaled(x: number, scale: number): number {
  const v = x * scale;
  const nearest = Math.round(v);
  return Math.abs(v - nearest) < 1e-6 ? nearest : Math.floor(v);
}

function callerConstraints(options: Swap2Options): {minAmountOut?: bigint; slippageBps?: number} {
  let minAmountOut: bigint | undefined;
  if (options.minAmountOut !== undefined) {
    try {
      minAmountOut = BigInt(options.minAmountOut);
    } catch {
      throw new Error("swap2: minAmountOut must be a positive integer");
    }
    if (minAmountOut <= 0n) throw new Error("swap2: minAmountOut must be a positive integer");
  }
  let slippageBps: number | undefined;
  if (options.slippage !== undefined) {
    if (!Number.isFinite(options.slippage) || options.slippage < 0 || options.slippage >= 1) {
      throw new Error("swap2: slippage must be a finite decimal in [0, 1)");
    }
    // Providers accept whole bps. Round down so their on-chain/API tolerance
    // can never be wider than the caller requested; the exact decimal is also
    // checked against the returned quote below.
    slippageBps = floorScaled(options.slippage, 10_000);
  }
  return {
    ...(minAmountOut !== undefined ? {minAmountOut} : {}),
    ...(slippageBps !== undefined ? {slippageBps} : {}),
  };
}

function assertQuoteConstraints(q: Quote, options: Swap2Options): void {
  const {minAmountOut} = callerConstraints(options);
  const nominal = BigInt(q.destAmount);
  const guaranteed = BigInt(q.minDestAmount);
  if (minAmountOut !== undefined && guaranteed < minAmountOut) {
    throw new Error(`swap2: quoted minimum ${guaranteed} is below caller minAmountOut ${minAmountOut}`);
  }
  if (options.slippage !== undefined) {
    const scale = 1_000_000_000n;
    const permitted = BigInt(floorScaled(options.slippage, 1_000_000_000));
    // Floor, like the providers compute their minimum (see validQuote).
    const required = (nominal * (scale - permitted)) / scale;
    if (guaranteed < required) {
      throw new Error(`swap2: quote exceeds caller slippage (${options.slippage})`);
    }
  }
}

function requireExecutionFloor(options: Swap2Options): void {
  if (options.minAmountOut === undefined) {
    throw new Error("swap2: swap2() requires caller-supplied minAmountOut");
  }
  callerConstraints(options);
}

function mapStatus(s: IntentStatus): Swap2StatusResult {
  const status: Swap2Status =
    s.state === "completed"
      ? "completed"
      : s.state === "action-required"
        ? "action-required"
        : s.state === "refund-pending"
          ? "refund-pending"
          : s.state === "partial"
            ? "partial"
            : s.state === "failed"
              ? "failed"
              : s.state === "refunded"
                ? "refunded"
                : s.state === "cancelled"
                  ? "cancelled"
                  : s.state === "expired"
                    ? "expired"
                    : "pending";
  return s.destTxHash
    ? {status, transactions: [{hash: s.destTxHash, type: "destination"}]}
    : {status};
}

/** `""` / whitespace → undefined: an empty input field names no address. */
function blankToUndefined(v: string | undefined): string | undefined {
  return typeof v === "string" && v.trim() === "" ? undefined : v;
}

/** The options with blank `recipient` / `refundAddress` dropped (they default to the account). */
function withoutBlankAddresses(o: Swap2Options): Swap2Options {
  const {recipient, refundAddress, ...rest} = o;
  const r = blankToUndefined(recipient);
  const f = blankToUndefined(refundAddress);
  return {...rest, ...(r !== undefined ? {recipient: r} : {}), ...(f !== undefined ? {refundAddress: f} : {})} as Swap2Options;
}

/**
 * Abstract swap2 protocol backed by the engine. Concrete subclasses bind
 * either a single provider (contribution-shaped) or the router (aggregator).
 */
export abstract class BaseSwap2Protocol extends Swap2Protocol {
  protected readonly fromChain: string;

  constructor(account: Swap2Account | undefined, config: Swap2EngineConfig) {
    const fromChain = toCaip2(config.fromChain, "");
    if (!fromChain) throw new Swap2ValidationError("swap2: fromChain is required");
    const configSnapshot = Object.freeze({...config, fromChain});
    super(account as never, configSnapshot);
    this.fromChain = fromChain;
  }

  /** Quote the route (single provider, or best across the router). */
  protected abstract resolveQuote(params: QuoteParams): Promise<Quote | null>;

  /** Why the last resolveQuote came back empty (venue names + reasons), or "".
   *  Rides inside the no-route error so execution failures are diagnosable
   *  from the surface that shows them. */
  protected noRouteDetail(): string {
    return "";
  }
  /** Look up a provider by name to resume/track an in-flight swap2. */
  protected abstract providerFor(name: string): CrossChainProvider | undefined;
  /** Whether this protocol can route a chain at all (for support discovery). */
  protected abstract chainSupported(caip2: string): boolean;

  /** Report an execution phase; an observer that throws is ignored. */
  protected emitPhase(phase: Swap2ExecutionPhase, detail?: Swap2ExecutionPhaseDetail): void {
    const observer = (this._config as Swap2EngineConfig).onExecutionPhase;
    if (!observer) return;
    try {
      observer(phase, detail);
    } catch {
      /* diagnostics only */
    }
  }
  /** Runtime availability used by the public discovery methods. */
  protected protocolEnabled(): boolean { return true; }
  /** Pair-level capability used when discovery specifies both endpoints. */
  protected pairSupported(fromChain: string, toChain: string): boolean {
    return this.chainSupported(fromChain) && this.chainSupported(toChain);
  }

  private unlistedAllowed(): boolean {
    return (this._config as Swap2EngineConfig).allowUnlistedTokens === true;
  }

  /** The source asset the options name: the catalog's, or (allowUnlistedTokens) an unlisted one with its decimals. */
  protected sourceAsset(options: Swap2Options): CcAsset | undefined {
    const decimals = options.fromTokenDecimals;
    return resolveAsset(this.fromChain, toSymbol(this.fromChain, options.fromToken), {
      allowUnlisted: this.unlistedAllowed(),
      ...(decimals !== undefined ? {decimals} : {}),
    });
  }

  private readonly unlistedDecimals = new Map<string, number>();

  /**
   * Options ready to quote: with `allowUnlistedTokens`, an unlisted source token gets its decimals,
   * read from the chain through the account (cached per token) — a caller's `fromTokenDecimals` that
   * disagrees is refused. Listed tokens and every option otherwise pass through unchanged.
   */
  protected async prepareOptions(options: Swap2Options): Promise<Swap2Options> {
    if (!this.unlistedAllowed()) return options;
    const ref = toSymbol(this.fromChain, options.fromToken);
    if (resolveAsset(this.fromChain, ref) || !isTokenAddress(this.fromChain, ref)) return options;
    const key = ref.startsWith("0x") ? ref.toLowerCase() : ref;
    let decimals = this.unlistedDecimals.get(key);
    if (decimals === undefined) {
      const reader = this._account as {getTokenInfo?: (token: string) => Promise<{decimals: number}>} | undefined;
      if (typeof reader?.getTokenInfo !== "function") {
        if (options.fromTokenDecimals === undefined) {
          throw new Swap2ValidationError(`swap2: '${ref}' is not in the catalog — pass fromTokenDecimals, or use an account that can read token info`);
        }
        return options;
      }
      decimals = (await reader.getTokenInfo(ref)).decimals;
      this.unlistedDecimals.set(key, decimals);
    }
    if (options.fromTokenDecimals !== undefined && options.fromTokenDecimals !== decimals) {
      throw new Swap2ValidationError(`swap2: fromTokenDecimals ${options.fromTokenDecimals} does not match the token's ${decimals}`);
    }
    return snapshotOptions({...options, fromTokenDecimals: decimals});
  }

  /** Swap2Options → the engine's QuoteParams (exact-in only). */
  protected toParams(given: Swap2Options, dry: boolean): QuoteParams {
    const options = withoutBlankAddresses(given);
    if (options.fromTokenAmount == null) {
      throw new Swap2UnsupportedOperationError("swap2: exact-out swap2 is not supported by the engine");
    }
    const destChain = toCaip2(options.toChain, this.fromChain);
    const constraints = callerConstraints(options);
    const amountIn = exactPositiveAmount(options.fromTokenAmount, "fromTokenAmount");
    const source = this.sourceAsset(options);
    const params: QuoteParams = {
      sourceChain: this.fromChain,
      sourceToken: isUnlisted(source) ? source.contract : toSymbol(this.fromChain, options.fromToken),
      ...(isUnlisted(source) ? {sourceDecimals: source.decimals} : {}),
      destChain,
      destToken: toDestAddress(destChain, options.toToken, this.unlistedAllowed()),
      amountIn: amountIn.toString(),
      destAddress: options.recipient ?? "",
      dry,
      ...(constraints.minAmountOut !== undefined ? {minAmountOut: constraints.minAmountOut.toString()} : {}),
      ...(constraints.slippageBps !== undefined ? {slippageBps: constraints.slippageBps} : {}),
    };
    return options.refundAddress ? {...params, refundAddress: options.refundAddress} : params;
  }

  private async assertAccountChain(signer: Swap2Signer): Promise<void> {
    const config = this._config as Swap2EngineConfig;
    if (config.skipAccountChainCheck) return;
    const actual = await readAccountChain(signer, config.accountChain);
    if (actual == null) {
      throw new Error(`swap2: account chain identity is unavailable for ${this.fromChain}; set accountChain or explicitly opt out with skipAccountChainCheck`);
    }
    const expected = this.fromChain;
    const expectedId = expected.startsWith("eip155:") ? expected.slice("eip155:".length) : expected;
    const actualText = swap2ChainId(typeof actual === "string" ? actual : String(actual));
    const actualId = actualText.startsWith("eip155:") ? actualText.slice("eip155:".length) : actualText;
    if (actualId !== expectedId) {
      throw new Error(`swap2: account is bound to ${actualText}, but fromChain is ${expected}`);
    }
  }

  protected assertFeeConfig(config?: Swap2ProtocolConfig): void {
    const configured = {...(this._config as Swap2ProtocolConfig), ...(config ?? {})};
    for (const [name, value] of [["maxNetworkFeeBps", configured.maxNetworkFeeBps], ["maxProtocolFeeBps", configured.maxProtocolFeeBps]] as const) {
      if (value === undefined) continue;
      const bps = typeof value === "bigint" ? value : Number.isSafeInteger(value) ? BigInt(value) : -1n;
      if (bps < 0n || bps > 10_000n) throw new Swap2ConfigurationError(`swap2: ${name} must be an integer between 0 and 10000`);
    }
  }

  protected assertFeeCaps(
    fees: readonly Swap2Fee[] | undefined,
    sourceAmount: bigint,
    sourceToken: string,
    config?: Swap2ProtocolConfig,
  ): void {
    this.assertFeeConfig(config);
    const configured = {...(this._config as Swap2ProtocolConfig), ...(config ?? {})};
    const caps = [
      ["network", configured.maxNetworkFeeBps],
      ["protocol", configured.maxProtocolFeeBps],
    ] as const;
    if (!caps.some(([, cap]) => cap !== undefined)) return;
    if (!fees) throw new Swap2FeeLimitError("swap2: fee caps require an itemized provider fee breakdown");
    const normalizedSource = sourceToken.toLowerCase();
    for (const [type, cap] of caps) {
      if (cap === undefined) continue;
      const matching = fees.filter((fee) => fee.type === type);
      if (matching.some((fee) => fee.token.toLowerCase() !== normalizedSource)) {
        throw new Swap2FeeLimitError(`swap2: cannot apply ${type} fee cap across different fee tokens`);
      }
      const total = matching.reduce((sum, fee) => sum + fee.amount, 0n);
      const bps = typeof cap === "bigint" ? cap : BigInt(cap);
      if (total * 10_000n > sourceAmount * bps) {
        throw new Swap2FeeLimitError(`swap2: ${type} fee exceeds configured cap`);
      }
    }
  }

  protected assertQuoteFeeCaps(q: Quote, options: Swap2Options, config?: Swap2ProtocolConfig): void {
    const source = this.sourceAsset(options);
    if (!source) throw new Error(`swap2: unknown source token '${options.fromToken}' on ${this.fromChain}`);
    const token = source.contract ?? source.assetId;
    const fees = q.fees?.map((fee) => ({...fee, amount: BigInt(fee.amount)} as Swap2Fee));
    this.assertFeeCaps(fees, BigInt(q.sourceAmount), token, config);
  }

  protected toQuote(q: Quote, options: Swap2Options): Swap2Quote {
    // Never fabricate a zero-valued fee. Providers that expose base-unit fee
    // amounts map them precisely; otherwise the net guaranteed output remains
    // authoritative and the itemized list is honestly empty.
    const fees: Swap2Fee[] = (q.fees ?? []).map((fee) => ({
      type: fee.type,
      amount: BigInt(fee.amount),
      token: fee.token,
      included: fee.included,
      ...(fee.description ? {description: fee.description} : {}),
    }));
    return {
      fromTokenAmount: BigInt(q.sourceAmount),
      toTokenAmount: BigInt(q.destAmount),
      toTokenAmountMin: BigInt(q.minDestAmount),
      fees,
      ...(q.etaSeconds ? {estimatedDuration: q.etaSeconds} : {}),
      ...(q.validUntilMs ? {expiry: Math.floor(q.validUntilMs / 1000)} : {}),
    };
  }

  /** A frozen, validated copy of caller options (what every engine path works from). */
  protected snapshotOf(options: Swap2Options): Swap2Options {
    return snapshotOptions(options);
  }

  /** A dry route the auction already validated → the public quote, or null when the caller's floor / fee caps refuse it. */
  protected routeQuote(q: Quote, options: Swap2Options): Swap2Quote | null {
    try {
      assertQuoteConstraints(q, options);
      this.assertQuoteFeeCaps(q, options);
      return this.toQuote(q, options);
    } catch {
      return null;
    }
  }

  /**
   * Ask for a quote and check it against the request (amounts, slippage floor, fee ceilings in the
   * protocol config). Works on a read-only account.
   *
   * @throws {@link Swap2QuoteError} when no route answers, with the provider's own reason when it
   * gave one.
   */
  override async quoteSwap2(options: Swap2Options): Promise<Swap2Quote> {
    const snapshot = await this.prepareOptions(snapshotOptions(options));
    const q = await this.resolveQuote(this.toParams(snapshot, true));
    if (!q) {
      const detail = this.noRouteDetail();
      throw new Swap2QuoteError(`swap2: no route available for the requested pair${detail ? ` :: ${detail}` : ""}`);
    }
    assertQuoteConstraints(q, snapshot);
    this.assertQuoteFeeCaps(q, snapshot);
    return this.toQuote(q, snapshot);
  }

  /**
   * Re-quote, check the quote, show it to `reviewExecution` when configured, send any approvals,
   * then sign and broadcast the source leg. An identical call already in flight on the same account
   * is refused.
   *
   * @throws {@link Swap2ExecutionError} for a read-only account, {@link Swap2InFlightError} for a
   * double tap, {@link Swap2MaybeSentError} when the broadcast outcome is unknown (do not retry;
   * track `hash`).
   */
  override async swap2(options: Swap2Options, config?: Swap2ProtocolConfig): Promise<Swap2Result> {
    // Account first: a read-only or missing account is refused before any option is
    // validated or any network call is made (SDK protocol conformance).
    const signerCandidate = this._account as Partial<Swap2Signer> | undefined;
    if (!signerCandidate || typeof signerCandidate.sendTransaction !== "function") {
      throw new Swap2ExecutionError("swap2: swap2() requires a signing account (read-only accounts can only quote)");
    }
    const snapshot = snapshotOptions(options);
    requireExecutionFloor(snapshot);
    // A double tap re-quotes and would run a second complete swap: refuse it
    // while the identical call is still in flight on this account.
    const key = inFlightKey(this.fromChain, snapshot);
    const running = IN_FLIGHT.get(signerCandidate) ?? new Set<string>();
    if (running.has(key)) throw new Swap2InFlightError("swap2: an identical swap is already in progress on this account — wait for its result");
    running.add(key);
    IN_FLIGHT.set(signerCandidate, running);
    try {
      return await this.executeSwap2(signerCandidate as Swap2Signer, snapshot, config);
    } finally {
      running.delete(key);
    }
  }

  private async executeSwap2(signer: Swap2Signer, snapshot: Swap2Options, config?: Swap2ProtocolConfig, carried?: CarriedAllowance): Promise<Swap2Result> {
    const configSnapshot = snapshotConfig(config);
    this.assertFeeConfig(configSnapshot);
    await this.assertAccountChain(signer);
    // Refunds land on the SOURCE chain, so the only safe default is the bound
    // account's own address — never the recipient, which may be a dest-chain
    // address (a TON-source swap with an EVM recipient would otherwise hand the
    // provider an EVM string as the TON refund/trader wallet).
    const selfAddress = await signer.getAddress();
    // A blank field ("" from an empty input) is no address at all: this account, never a provider's placeholder (round 3, H8).
    const recipient = blankToUndefined(snapshot.recipient) ?? selfAddress;
    const refundAddress = blankToUndefined(snapshot.refundAddress) ?? selfAddress;
    const executionOptions = await this.prepareOptions(snapshotOptions({...snapshot, recipient, refundAddress}));
    const params = this.toParams(executionOptions, false);
    const resolved = await this.resolveQuote(params);
    if (!resolved) {
      const detail = this.noRouteDetail();
      throw new Swap2QuoteError(`swap2: no route available for the requested pair${detail ? ` :: ${detail}` : ""}`);
    }
    const q = snapshotQuote(resolved);
    assertQuoteConstraints(q, executionOptions);
    this.assertQuoteFeeCaps(q, executionOptions, configSnapshot);

    const provider = this.providerFor(q.provider);
    if (!provider) throw new Error(`swap2: provider '${q.provider}' is not registered`);
    let providerEnabled = false;
    try { providerEnabled = provider.enabled(); } catch { /* fail closed below */ }
    if (!providerEnabled) throw new Error(`swap2: provider '${q.provider}' is disabled`);
    let unsigned: UnsignedTx = Object.freeze({...await provider.buildDeposit(q)});

    const serialized = unsigned.serializedTx !== undefined;
    if (serialized) {
      if (!unsigned.serializedTx) throw new Error("swap2: provider returned an empty serialized transaction");
      if (unsigned.data !== undefined || unsigned.bodyBoc !== undefined || unsigned.typedData !== undefined || unsigned.memo !== undefined || unsigned.approvalAddress !== undefined) {
        throw new Error("swap2: provider returned ambiguous execution payloads");
      }
      if (typeof signer.sendSerializedTransaction !== "function") {
        throw new Swap2ExecutionError(`swap2: ${this.fromChain} serialized execution requires account.sendSerializedTransaction`);
      }
    }
    if (unsigned.chain && unsigned.chain !== this.fromChain) {
      throw new Error(`swap2: provider transaction chain ${unsigned.chain} does not match ${this.fromChain}`);
    }
    if (unsigned.stateInitBoc !== undefined) {
      throw new Error("swap2: deposit requires a stateInit the generic account cannot attach");
    }
    // A remote build response is not a new authority. For ordinary calldata and
    // deposit-address providers the validated quote already commits every
    // execution field; require buildDeposit to reproduce it exactly.
    if (q.txRequest) {
      const tx = q.txRequest;
      const sameAddress = (a: string | undefined, b: string | undefined) =>
        a === b || (!!a && !!b && a.startsWith("0x") && b.startsWith("0x") && a.toLowerCase() === b.toLowerCase());
      if (
        !sameAddress(unsigned.to, tx.to ?? "") ||
        unsigned.data !== tx.data ||
        unsigned.value !== (tx.value ?? "0") ||
        unsigned.chainId !== tx.chainId ||
        unsigned.gasLimit !== tx.gasLimit ||
        !sameAddress(unsigned.approvalAddress, tx.approvalAddress) ||
        unsigned.serializedTx !== tx.serializedTx
      ) {
        throw new Error("swap2: provider build does not match the validated quote transaction");
      }
    } else if (!unsigned.bodyBoc && !unsigned.typedData) {
      if (!q.depositAddress || unsigned.to !== q.depositAddress || (unsigned.memo ?? null) !== q.depositMemo) {
        throw new Error("swap2: provider build does not match the validated quote deposit");
      }
    }
    const executionModels = [unsigned.data !== undefined, unsigned.bodyBoc !== undefined, unsigned.typedData !== undefined]
      .filter(Boolean).length;
    if (executionModels > 1 || (unsigned.memo !== undefined && (unsigned.bodyBoc !== undefined || unsigned.typedData !== undefined))) {
      throw new Error("swap2: provider returned ambiguous execution payloads");
    }
    if (unsigned.approvalAddress && !unsigned.data && !unsigned.typedData) {
      throw new Error("swap2: approval is only valid for calldata or typed-order execution");
    }
    // Memo'd deposits: TON carries it as the message body, Tron in
    // raw_data.data (both TRX and TRC-20 — bifrost reads that field for
    // either contract type). Every other chain would silently drop it.
    const tronSource = this.fromChain.startsWith("tron:");
    // NEAR: a NEP-141 `ft_transfer` carries `memo`; a native transfer cannot
    // (the account refuses a memo it would otherwise drop).
    const nearSource = this.fromChain.startsWith("near:");
    if (unsigned.memo && !this.fromChain.startsWith("ton:") && !tronSource && !nearSource) {
      throw new Error(`swap2: deposit memo execution is not implemented for ${this.fromChain}`);
    }
    if (unsigned.data !== undefined && !this.fromChain.startsWith("eip155:")) {
      throw new Error(`swap2: calldata execution is not implemented for ${this.fromChain}`);
    }
    // Cell-body deposits (Omniston escrow): the body MUST be decoded to a Cell —
    // a TON account renders a string body as a text comment, stranding the
    // swap. Fail closed unless the caller supplied `decodeTonBody`.
    let cellBody: unknown;
    if (unsigned.bodyBoc !== undefined) {
      if (!unsigned.bodyBoc) throw new Error("swap2: cell-body deposit has an empty body");
      if (!this.fromChain.startsWith("ton:")) {
        throw new Error(`swap2: cell-body execution is not implemented for ${this.fromChain}`);
      }
      const decode = (this._config as Swap2EngineConfig).decodeTonBody;
      if (!decode) {
        throw new Error("swap2: cell-body deposit needs config.decodeTonBody (e.g. Cell.fromBase64)");
      }
      cellBody = decode(unsigned.bodyBoc);
      if (cellBody == null) {
        throw new Error("swap2: config.decodeTonBody returned no Cell");
      }
    }
    if (unsigned.chainId !== undefined && this.fromChain.startsWith("eip155:") && String(unsigned.chainId) !== this.fromChain.slice("eip155:".length)) {
      throw new Error(`swap2: provider transaction chain ${unsigned.chainId} does not match ${this.fromChain}`);
    }

    // TOKEN-asset sources on deposit-address routes need token-transfer
    // semantics: a bare {to, value} would move the NATIVE coin with the
    // token's base-unit amount (audit C1 — e.g. USDT source via a 1Click
    // deposit address would have sent ETH wei). EVM sources are rewritten
    // into an ERC-20 transfer(depositAddress, amount); supported non-EVM
    // sources use the account's transfer() token surface below.
    let tokenId: string | undefined;
    if (!unsigned.data && !unsigned.bodyBoc && !unsigned.typedData && !serialized) {
      const src = this.sourceAsset(executionOptions);
      if (src?.contract) {
        if (this.fromChain.startsWith("eip155:")) {
          unsigned = {
            ...unsigned,
            to: src.contract,
            data: encodeFunctionData({
              abi: ERC20_TRANSFER_ABI,
              functionName: "transfer",
              args: [unsigned.to as `0x${string}`, BigInt(q.sourceAmount)],
            }),
            value: "0",
          };
        } else if (
          this.fromChain.startsWith("solana:") ||
          this.fromChain.startsWith("ton:") ||
          this.fromChain.startsWith("tron:") ||
          nearSource
        ) {
          // Solana SPL / TON jetton / Tron TRC-20 / NEAR NEP-141 source. These
          // accounts expose token movement through `transfer()`; their
          // `sendTransaction({to,value})` surface is a NATIVE transfer and does
          // not recognize custom token metadata.
          tokenId = src.contract;
        } else {
          throw new Error(
            `swap2: token deposit-address execution is not implemented for ${this.fromChain} — only cell-body/calldata providers can move non-native assets here`,
          );
        }
      }
    }

    // A TON jetton transfer carries the memo as its forward-payload comment: the
    // account's `transfer({memo})` surface places it there (TEP-74), exactly as
    // Tron puts it in raw_data.data and NEAR in the ft_transfer memo.
    const tonSource = this.fromChain.startsWith("ton:");
    if (tokenId && (cellBody !== undefined || (unsigned.memo !== undefined && !tronSource && !nearSource && !tonSource))) {
      throw new Error("swap2: token deposit with memo/cell payload is not implemented");
    }

    // Bind the value presented to the signer to the already validated quote.
    // Native deposits and the amount handed to transfer() must carry the exact
    // input amount; EVM token execution must never attach native value.
    const source = this.sourceAsset(executionOptions);
    if (!source) throw new Error(`swap2: unknown source token '${executionOptions.fromToken}' on ${this.fromChain}`);
    const executionValue = BigInt(unsigned.value);
    if (serialized) {
      // The native coin leaves through the serialized tx itself; `value` only
      // declares what the account may let it take: the input for a native
      // source, nothing for a token source.
      if (executionValue !== (source.contract ? 0n : BigInt(q.sourceAmount))) {
        throw new Error("swap2: provider execution amount does not match the validated quote");
      }
    } else if (source.contract && this.fromChain.startsWith("eip155:")) {
      // Only a fee the sealed quote declared, and only up to the chain's cap.
      const declared = declaredNativeFee(q, this.fromChain);
      if (executionValue !== declared) {
        throw new Error(declared === 0n
          ? "swap2: token execution attempted to attach native value"
          : `swap2: token execution value ${executionValue} does not match the quoted native fee ${declared}`);
      }
    } else if (!unsigned.typedData && !unsigned.bodyBoc && executionValue !== BigInt(q.sourceAmount) + declaredNativeFee(q, this.fromChain)) {
      throw new Error("swap2: provider execution amount does not match the validated quote");
    }

    // The engine binds the build to the quote; also bind what the quote's own
    // calldata hands out. A plain ERC-20 transfer / approval / Permit2 /
    // operator approval may only name this account, the quoted deposit
    // address or the declared spender/target. Aggregator calldata (a LI.FI
    // diamond, a THORChain router) is not decoded here — the provider's
    // target allowlist and the review screen cover it.
    if (unsigned.data !== undefined && this.fromChain.startsWith("eip155:")) {
      const call = decodeCall({to: unsigned.to, data: unsigned.data, value: executionValue});
      const named = call.transfer?.to ?? call.approval?.spender;
      const allowed = [selfAddress, q.depositAddress, unsigned.approvalAddress, unsigned.to].filter((a): a is string => !!a).map((a) => a.toLowerCase());
      if (named && !allowed.includes(named.toLowerCase())) {
        throw new Swap2ValidationError(`swap2: quote calldata (${call.method}) names ${getAddress(named)}, which is not this account, the deposit address or the declared spender — refused`);
      }
    }

    // ERC-20 calldata/typed-order routes need an exact allowance. Decide the
    // approvals now (the reviewer sees exactly what will be sent) but send
    // them only after every local payload/value check, so a malformed build
    // cannot leave an allowance behind before failing validation.
    const needsApproval = !!unsigned.approvalAddress && !!source.contract;
    const approvalAmount = needsApproval ? BigInt(executionOptions.fromTokenAmount!) : 0n;
    const sameHex = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
    let approvalAmounts: bigint[] = [];
    let revokeApproval: (() => Promise<void>) | undefined;
    if (carried && !needsApproval) {
      // The fresh quote no longer spends through an allowance: the one the
      // first pass mined would outlive this swap with nobody to revoke it.
      carried.adopted = true;
      await carried.revoke().catch(() => {});
      throw new Swap2QuoteError("swap2: the fresh quote no longer spends through an allowance — aborted, the allowance was revoked");
    }
    if (needsApproval && carried) {
      // Re-quote pass: the allowance must fit the fresh quote exactly;
      // otherwise it is revoked and the swap aborts (the caller may retry).
      if (!sameHex(carried.token, source.contract!) || !sameHex(carried.spender, unsigned.approvalAddress!) || carried.amount !== approvalAmount) {
        carried.adopted = true;
        await carried.revoke().catch(() => {});
        throw new Swap2QuoteError(`swap2: the fresh quote moved the spender to ${unsigned.approvalAddress} — aborted, the allowance for ${carried.spender} was revoked`);
      }
      carried.adopted = true;
      revokeApproval = carried.revoke;
    } else if (needsApproval) {
      // Mainnet USDT refuses non-zero → non-zero; every other token
      // overwrites. The live allowance decides what is actually needed: the
      // reset only when USDT holds a non-zero value, nothing at all when the
      // exact amount is already in place (an allowance this engine did not
      // create is left alone on failure). A failed read assumes the worst.
      const usdtMainnet = this.fromChain === "eip155:1" && source.symbol.toUpperCase() === "USDT";
      let current: bigint | undefined;
      if (typeof signer.getAllowance === "function") {
        try {
          current = BigInt(await signer.getAllowance(source.contract!, unsigned.approvalAddress!));
        } catch {
          current = undefined;
        }
      }
      approvalAmounts = current === approvalAmount ? [] : [...(usdtMainnet && current !== 0n ? [0n] : []), approvalAmount];
    }

    // The re-quote pass is reviewed again only when it differs from what the
    // reviewer approved: source amount, spender and the caller's floor are
    // pinned by construction, but the payload (calldata, deposit, memo, gas)
    // and the output come fresh from the provider.
    const review = (this._config as Swap2EngineConfig).reviewExecution;
    let reviewed: Swap2ExecutionPlan | undefined;
    if (review && (!carried || carried.reviewed)) {
      const chainId = unsigned.chainId !== undefined ? {chainId: unsigned.chainId} : {};
      const approvals: Swap2ExecutionPlan["approvals"] = approvalAmounts.map((amount) =>
        ({token: source.contract!, spender: unsigned.approvalAddress!, amount, ...chainId}));
      const plan: Swap2ExecutionPlan = {
        provider: q.provider,
        fromChain: this.fromChain,
        destChain: params.destChain,
        destToken: params.destToken,
        recipient,
        refundAddress,
        sourceAmount: BigInt(q.sourceAmount),
        destAmount: BigInt(q.destAmount),
        minDestAmount: BigInt(q.minDestAmount),
        feeUsd: q.feeUsd,
        etaSeconds: q.etaSeconds,
        validUntilMs: q.validUntilMs,
        approvals,
        source: serialized
          ? {kind: "serialized", serializedTx: unsigned.serializedTx!}
          : unsigned.typedData
            ? {kind: "typed-order", typedData: unsigned.typedData}
            : tokenId
              ? {kind: "token-transfer", token: tokenId, recipient: unsigned.to, amount: BigInt(q.sourceAmount), ...(unsigned.memo ? {memo: unsigned.memo, ...(unsigned.memoEncoding ? {memoEncoding: unsigned.memoEncoding} : {})} : {})}
              : {
                  kind: "call",
                  to: unsigned.to,
                  ...(unsigned.data ? {data: unsigned.data} : {}),
                  value: BigInt(unsigned.value),
                  ...(unsigned.chainId !== undefined ? {chainId: unsigned.chainId} : {}),
                  ...(unsigned.gasLimit ? {gasLimit: BigInt(unsigned.gasLimit)} : {}),
                  ...(unsigned.memo ? {memo: unsigned.memo, ...(unsigned.memoEncoding ? {memoEncoding: unsigned.memoEncoding} : {})} : {}),
                  ...(cellBody !== undefined ? {cellBody: true} : {}),
                },
      };
      const previous = carried?.reviewed;
      if (!previous || reviewedIdentity(previous) !== reviewedIdentity(plan) || plan.destAmount < previous.destAmount) {
        try {
          // A frozen deep copy: nothing the reviewer does reaches the payload sent below.
          reviewed = deepFreeze(structuredCloneSafe(previous ? {...plan, requoted: true as const} : plan));
          await review(reviewed);
          if (q.validUntilMs > 0 && q.validUntilMs <= Date.now()) {
            throw new Swap2QuoteError(`swap2: quote expired during review — ${previous ? "the allowance was revoked" : "nothing was signed"}`);
          }
        } catch (error) {
          // Second review: the allowance is ours and already adopted by this pass.
          if (previous) await revokeApproval?.().catch(() => {});
          throw error;
        }
      }
    }

    try {
      await this.assertNativeGas(signer, unsigned, approvalAmounts, source.contract ?? undefined, !!unsigned.typedData || serialized || !!tokenId);
    } catch (error) {
      // Re-quote pass: the allowance is adopted here, nobody else revokes it.
      if (carried) await revokeApproval?.().catch(() => {});
      throw error;
    }

    if (approvalAmounts.length) {
      const approve = async (amount: bigint) => {
        const sent = await signer.sendTransaction({
          to: source.contract!,
          data: approveData(unsigned.approvalAddress!, amount),
          value: 0n,
          ...(unsigned.chainId !== undefined ? {chainId: unsigned.chainId} : {}),
        });
        // The next step (a second approve, or the deposit's gas estimate)
        // reads on-chain allowance: it must see this approval mined.
        if (sent.hash && typeof signer.waitForTransaction === "function") await signer.waitForTransaction(sent.hash);
        return sent;
      };
      // Install cleanup BEFORE broadcasting approval. An RPC can lose the
      // response after the transaction was accepted; treating that exception
      // as "nothing happened" would leave a live allowance with no callback.
      revokeApproval = async () => { await approve(0n); };
      try {
        for (const [i, amount] of approvalAmounts.entries()) {
          this.emitPhase("approving", {index: i + 1, total: approvalAmounts.length});
          await approve(amount);
        }
      } catch (error) {
        await revokeApproval().catch(() => {});
        throw error;
      }
    }

    // The quote/build step can be separated from the actual send by an ERC-20
    // approval. Recheck rotating/halt-sensitive provider state only now.
    if (q.validUntilMs > 0 && q.validUntilMs <= Date.now()) {
      // The mined approvals outlived the quote (mainnet USDT: 50–108 s of
      // approvals against a 55 s LI.FI / 45 s Omniston TTL, SDK-128). The
      // allowance is exact and ours: quote once more and spend it, instead of
      // revoking it (a third tx) and making the caller pay for the approvals
      // again. The second pass is bound to the same spender and amount, held
      // to the caller's floor like the first, and never re-quotes itself.
      if (!carried && approvalAmounts.length && revokeApproval) {
        this.emitPhase("requoting");
        const handoff: CarriedAllowance = {token: source.contract!, spender: unsigned.approvalAddress!, amount: approvalAmount, revoke: revokeApproval, adopted: false, ...(reviewed ? {reviewed} : {})};
        try {
          return await this.executeSwap2(signer, snapshot, config, handoff);
        } catch (error) {
          if (!handoff.adopted) await revokeApproval().catch(() => {});
          throw error;
        }
      }
      await revokeApproval?.().catch(() => {});
      throw new Swap2QuoteError("swap2: quote expired before source broadcast");
    }
    try {
      let providerStillEnabled = false;
      try { providerStillEnabled = provider.enabled(); } catch { /* fail closed below */ }
      if (!providerStillEnabled) throw new Error(`swap2: provider '${q.provider}' was disabled before source broadcast`);
      if (provider.preflightDeposit) this.emitPhase("preflight");
      await provider.preflightDeposit?.(q, unsigned);
    } catch (error) {
      await revokeApproval?.().catch(() => {});
      throw error;
    }

    // GASLESS typed-order execution (Omniston EVM-source): sign the EIP-712
    // payload and register it with the provider — there is no source tx.
    if (unsigned.typedData) {
      try {
        if (!signer.signTypedData) {
          throw new Error("swap2: typed-order execution needs an account with signTypedData");
        }
        if (!provider.registerSignedOrder) {
          throw new Error(`swap2: provider '${q.provider}' cannot register signed orders`);
        }
        const td = JSON.parse(unsigned.typedData) as {
          domain: unknown;
          types: Record<string, unknown>;
          primaryType?: string;
          message: unknown;
        };
        if (!td || typeof td !== "object" || !td.domain || !td.types || typeof td.types !== "object" || !td.message) {
          throw new Error("swap2: provider returned malformed typed data");
        }
        // ethers and the account infer the domain type and reject an explicit
        // EIP712Domain entry as an ambiguous primary type.
        const {EIP712Domain: _domain, ...types} = td.types;
        // Providers may send the domain chainId as a hex string ("0x89");
        // signers that build the EIP712Domain type from value types (viem)
        // would then drop chainId from the domain and produce a signature the
        // verifying contract rejects (Omniston order, 2026-10-16). Sign with a number.
        const signature = await signer.signTypedData({
          domain: normalizeTypedDomain(td.domain),
          types,
          ...(td.primaryType ? {primaryType: td.primaryType} : {}),
          message: td.message,
        });
        await provider.registerSignedOrder(q.intentId, signature);
        return {
          id: encodeId(q.provider, q.intentId),
          fees: this.toQuote(q, executionOptions).fees,
          fromTokenAmount: BigInt(q.sourceAmount),
          toTokenAmount: BigInt(q.destAmount),
          toTokenAmountMin: BigInt(q.minDestAmount),
        };
      } catch (error) {
        // Any failed validation/sign/registration must not leave a reusable
        // exact allowance behind. If the RPC response was lost after
        // registration, revocation safely prevents execution.
        await revokeApproval?.().catch(() => {});
        throw error;
      }
    }

    // Execute the source leg through the bound account. Non-EVM token deposits
    // MUST use the account's transfer({token,recipient,amount}); passing token metadata
    // to sendTransaction would be ignored and send native SOL/TON/TRX instead.
    let sent: {hash?: string};
    this.emitPhase("signing");
    try {
      if (serialized) {
        const allowanceRaw = (this._config as Swap2EngineConfig).serializedNativeAllowance;
        const allowance = allowanceRaw === undefined ? DEFAULT_SERIALIZED_NATIVE_ALLOWANCE : BigInt(allowanceRaw);
        if (allowance < 0n) throw new Swap2ConfigurationError("swap2: serializedNativeAllowance must be non-negative");
        const expect: SerializedExecutionExpectation = {
          maxValueOut: ((source.contract ? 0n : BigInt(q.sourceAmount)) + allowance).toString(),
          // Only a same-chain swap lands in this account; a bridge delivers elsewhere.
          ...(params.destChain === this.fromChain ? {tokenIn: {token: params.destToken, minAmount: q.minDestAmount}} : {}),
          ...(source.contract ? {source: {token: source.contract, maxAmount: q.sourceAmount}} : {}),
        };
        sent = await signer.sendSerializedTransaction!(unsigned.serializedTx!, expect);
      } else if (tokenId) {
        if (typeof signer.transfer !== "function") {
          throw new Swap2ExecutionError(
            `swap2: ${this.fromChain} token execution requires account.transfer({token, recipient, amount})`,
          );
        }
        sent = await signer.transfer({
          token: tokenId,
          recipient: unsigned.to,
          amount: BigInt(q.sourceAmount),
          ...((tronSource || nearSource || tonSource) && unsigned.memo ? {memo: unsigned.memo, ...(tronSource && unsigned.memoEncoding ? {memoEncoding: unsigned.memoEncoding} : {})} : {}),
        });
      } else {
        sent = await signer.sendTransaction({
          to: unsigned.to,
          ...(unsigned.data ? {data: unsigned.data} : {}),
          value: BigInt(unsigned.value),
          ...(unsigned.chainId !== undefined ? {chainId: unsigned.chainId} : {}),
          ...(unsigned.gasLimit ? {gasLimit: BigInt(unsigned.gasLimit)} : {}),
          ...(cellBody !== undefined
            ? {body: cellBody}
            : unsigned.memo
              ? (tronSource ? {memo: unsigned.memo, ...(unsigned.memoEncoding ? {memoEncoding: unsigned.memoEncoding} : {})} : nearSource ? {memo: unsigned.memo} : {body: unsigned.memo})
              : {}),
        });
      }
      if (!sent.hash) throw new Swap2ExecutionError("swap2: account did not return a source transaction hash");
      this.emitPhase("broadcast", {hash: sent.hash});
    } catch (error) {
      // The deposit may be in the mempool: revoking would race it, and a
      // "clean" error invites a retry that sends a second deposit.
      const unknown = maybeSent(error);
      if (unknown) {
        throw new Swap2MaybeSentError(
          `swap2: the source transaction may have been broadcast (${error instanceof Error ? error.message.slice(0, 160) : String(error).slice(0, 160)}) — do not retry; ${unknown.hash ? `poll the status of ${unknown.hash}` : "check the account's recent transactions"}`,
          unknown.hash,
          unknown.hash ? encodeId(q.provider, q.intentId, unknown.hash) : undefined,
          {cause: error},
        );
      }
      await revokeApproval?.().catch(() => {});
      throw error;
    }

    if (provider.notifyDeposit) {
      await provider.notifyDeposit(q.intentId, sent.hash).catch(() => {});
    }

    const fees = this.toQuote(q, executionOptions).fees;
    return {
      id: encodeId(q.provider, q.intentId, sent.hash),
      fees,
      fromTokenAmount: BigInt(q.sourceAmount),
      toTokenAmount: BigInt(q.destAmount),
      toTokenAmountMin: BigInt(q.minDestAmount),
      ...(sent.hash ? {hash: sent.hash, transactions: [{hash: sent.hash, type: "source"}]} : {}),
    };
  }

  /**
   * EVM: refuse before the first approval when the native balance cannot pay
   * every approval, the main call and its value. Fees are the account's own
   * upper bound (`quoteSendTransaction`: gas × max fee). The main call's gas
   * comes from the quote's gas limit; without one it is estimated, which a
   * not-yet-approved call cannot do — then only approvals + value count.
   * Accounts without `getBalance`/`quoteSendTransaction` (and non-EVM chains,
   * whose accounts check their own fee at send) are not checked here.
   */
  private async assertNativeGas(signer: Swap2Signer, unsigned: UnsignedTx, approvalAmounts: bigint[], token: string | undefined, noMainCall: boolean): Promise<void> {
    if (!this.fromChain.startsWith("eip155:") || typeof signer.getBalance !== "function" || typeof signer.quoteSendTransaction !== "function") return;
    const chainId = unsigned.chainId !== undefined ? {chainId: unsigned.chainId} : {};
    const fees = await Promise.all(approvalAmounts.map(async (amount) =>
      (await signer.quoteSendTransaction!({to: token!, data: approveData(unsigned.approvalAddress!, amount), value: 0n, ...chainId})).fee));
    const value = noMainCall ? 0n : BigInt(unsigned.value);
    if (!noMainCall) {
      const main = {to: unsigned.to, ...(unsigned.data ? {data: unsigned.data} : {}), value, ...chainId, ...(unsigned.gasLimit ? {gasLimit: BigInt(unsigned.gasLimit)} : {})};
      fees.push(await signer.quoteSendTransaction(main).then((r) => r.fee, (error) => {
        if (approvalAmounts.length) return 0n; // estimation needs the allowance the approval creates
        throw error;
      }));
    }
    const need = fees.reduce((a, b) => a + b, 0n) + value;
    const balance = BigInt(await signer.getBalance());
    if (balance < need) {
      throw new Swap2InsufficientGasError(`swap2: native balance ${balance} cannot pay this swap's gas: need ${need} (${fees.length} transaction${fees.length === 1 ? "" : "s"}${value ? ` + value ${value}` : ""}) — nothing was signed`);
    }
  }

  /** Status of a swap by the id `swap2()` returned, asked from the provider that executed it. */
  override async getSwap2Status(id: string, _options?: Swap2StatusOptions): Promise<Swap2StatusResult> {
    const {provider: name, intentId, sourceTxHash} = decodeId(id);
    const provider = this.providerFor(name);
    if (!provider) throw new Error(`swap2: no swap2 found for id '${id}'`);
    return mapStatus(await provider.trackIntent(sourceTxHash == null ? {intentId} : {intentId, sourceTxHash}));
  }

  /**
   * Two-phase routes (CCTP-style burn-and-mint): once `getSwap2Status` reports
   * "action-required", the delivery needs a second transaction on the
   * DESTINATION chain, signed there and paid in that chain's gas. `account` is
   * the destination-chain account (the bound source account is not reused:
   * the chains differ). The provider builds the claim from the attestation; it
   * is refused when not ready, when it names another chain than the account,
   * or when it is anything but plain EVM calldata. Returns the claim hash and
   * the status id to keep polling with.
   */
  async claimSwap2(id: string, account: Swap2Account): Promise<{hash: string; chain: string; id: string}> {
    const {provider: name, intentId, sourceTxHash} = decodeId(id);
    const provider = this.providerFor(name);
    if (!provider) throw new Error(`swap2: no swap2 found for id '${id}'`);
    if (typeof provider.buildClaim !== "function") {
      throw new Swap2UnsupportedOperationError(`swap2: provider '${name}' has no claim step`);
    }
    const signerCandidate = account as Partial<Swap2Signer> | undefined;
    if (!signerCandidate || typeof signerCandidate.sendTransaction !== "function") {
      throw new Swap2ExecutionError("swap2: claimSwap2() requires a signing account on the destination chain");
    }
    const signer = signerCandidate as Swap2Signer;
    let providerEnabled = false;
    try { providerEnabled = provider.enabled(); } catch { /* fail closed below */ }
    if (!providerEnabled) throw new Error(`swap2: provider '${name}' is disabled`);
    const unsigned = await provider.buildClaim(sourceTxHash == null ? {intentId} : {intentId, sourceTxHash});
    if (!unsigned) throw new Swap2StatusError("swap2: the claim is not ready yet (attestation pending) — poll the status and retry");
    if (!unsigned.chain || !unsigned.chain.startsWith("eip155:")) {
      throw new Swap2UnsupportedOperationError(`swap2: claim execution is only implemented for EVM destinations (got '${unsigned.chain || "?"}')`);
    }
    if (!unsigned.to || !unsigned.data || !/^0x(?:[0-9a-fA-F]{2})+$/.test(unsigned.data)) {
      throw new Error("swap2: provider returned a malformed claim transaction");
    }
    if (unsigned.serializedTx !== undefined || unsigned.bodyBoc !== undefined || unsigned.typedData !== undefined || unsigned.memo !== undefined || unsigned.approvalAddress !== undefined) {
      throw new Error("swap2: claim must be plain calldata");
    }
    if (unsigned.value !== undefined && unsigned.value !== "0") throw new Error("swap2: a claim must not carry native value");
    const expectedId = unsigned.chain.slice("eip155:".length);
    if (unsigned.chainId !== undefined && String(unsigned.chainId) !== expectedId) {
      throw new Error(`swap2: claim chainId ${unsigned.chainId} does not match ${unsigned.chain}`);
    }
    const actual = await readAccountChain(signer);
    if (actual == null) throw new Error(`swap2: destination account chain identity is unavailable for ${unsigned.chain}`);
    const actualText = typeof actual === "string" ? actual : String(actual);
    const actualId = actualText.startsWith("eip155:") ? actualText.slice("eip155:".length) : actualText;
    if (actualId !== expectedId) throw new Error(`swap2: claim is on ${unsigned.chain}, but the account is bound to ${actualText}`);
    this.emitPhase("signing");
    const sent = await signer.sendTransaction({
      to: unsigned.to,
      data: unsigned.data,
      value: 0n,
      chainId: Number(expectedId),
      ...(unsigned.gasLimit ? {gasLimit: BigInt(unsigned.gasLimit)} : {}),
    });
    if (!sent.hash) throw new Swap2ExecutionError("swap2: account did not return a claim transaction hash");
    this.emitPhase("broadcast", {hash: sent.hash});
    return {hash: sent.hash, chain: unsigned.chain, id};
  }

  /** The inherited bridge() has no floor field: quote first, then bind execution
   * to that quote's minimum so the inherited convenience API stays safe. */
  override async bridge(options: BridgeOptions): Promise<BridgeResult> {
    const amount = exactPositiveAmount(options.amount, "amount");
    const swap2Options: Swap2Options = {
      fromToken: options.token,
      toToken: options.token,
      toChain: options.targetChain,
      recipient: options.recipient,
      fromTokenAmount: amount,
    };
    const quote = await this.quoteSwap2(swap2Options);
    const result = await this.swap2({...swap2Options, minAmountOut: quote.toTokenAmountMin});
    const fee = result.fees.filter((f) => f.type === "network").reduce((sum, f) => sum + f.amount, 0n);
    const bridgeFee = result.fees.filter((f) => f.type === "protocol").reduce((sum, f) => sum + f.amount, 0n);
    return {hash: result.id, fee, bridgeFee};
  }

  /** Same protection for legacy exact-in swap() calls whose min is optional. */
  override async swap(options: SwapOptions): Promise<SwapResult> {
    if (options.tokenInAmount === undefined) {
      throw new Swap2UnsupportedOperationError("swap2: exact-out swap is not supported by the engine");
    }
    const amount = exactPositiveAmount(options.tokenInAmount, "tokenInAmount");
    const swap2Options: Swap2Options = {
      fromToken: options.tokenIn,
      toToken: options.tokenOut,
      fromTokenAmount: amount,
      // `to` is optional on the legacy API: omit the key rather than passing
      // undefined, so swap2() falls back to the bound account's own address.
      ...(options.to !== undefined ? {recipient: options.to} : {}),
      ...(options.minAmountOut !== undefined ? {minAmountOut: options.minAmountOut} : {}),
    };
    const floor = options.minAmountOut ?? (await this.quoteSwap2(swap2Options)).toTokenAmountMin;
    const result = await this.swap2({...swap2Options, minAmountOut: floor});
    const fee = result.fees.reduce((sum, item) => sum + item.amount, 0n);
    return {hash: result.id, fee, tokenInAmount: result.fromTokenAmount, tokenOutAmount: result.toTokenAmount};
  }

  /** Source chains this protocol can swap from. */
  override async getSupportedChains(): Promise<Swap2SupportedChain[]> {
    if (!this.protocolEnabled()) return [];
    return CC_SOURCE_CHAINS.filter((c: CcChain) => this.chainSupported(c.caip2)).map((c) => ({
      id: c.caip2,
      name: c.label,
      type: chainType(c.caip2),
      nativeToken: c.assets[0]?.symbol ?? "",
    }));
  }

  /** Tokens of the asset catalog on the supported chains, optionally narrowed. */
  override async getSupportedTokens(options?: Swap2SupportedTokensOptions): Promise<Swap2SupportedToken[]> {
    const wantFrom = options?.fromChain != null ? toCaip2(options.fromChain, "") : undefined;
    const wantTo = options?.toChain != null ? toCaip2(options.toChain, "") : undefined;
    if (!this.protocolEnabled() || (wantFrom && wantTo && !this.pairSupported(wantFrom, wantTo))) return [];
    const out: Swap2SupportedToken[] = [];
    for (const c of CC_SOURCE_CHAINS) {
      if (!this.chainSupported(c.caip2)) continue;
      if ((wantFrom || wantTo) && c.caip2 !== wantFrom && c.caip2 !== wantTo) continue;
      for (const a of c.assets) {
        out.push({
          token: a.assetId,
          chain: c.caip2,
          symbol: a.symbol,
          decimals: a.decimals,
          ...(a.contract ? {address: a.contract} : {}),
        });
      }
    }
    return out;
  }
}

function structuredCloneSafe<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => structuredCloneSafe(v)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = structuredCloneSafe(v);
  return out as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
