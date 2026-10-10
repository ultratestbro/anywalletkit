/**
 * `Swap2Protocol` adapter over the cross-chain engine.
 *
 * The engine speaks in symbols + CAIP-2 chain ids and a deposit-address /
 * calldata execution model; `Swap2Protocol` speaks in provider token ids
 * bound to an account whose chain is the source. This base bridges the two:
 * it maps `Swap2Options` → the engine's `QuoteParams`, delegates quoting to a
 * provider (or the router, in the aggregator), and executes the source leg
 * through the bound account. Subclasses only supply "which provider(s)".
 */
import {Swap2Protocol} from "@forgewallet/core";
import {encodeFunctionData} from "viem";
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
} from "@forgewallet/core";
import {
  CC_SOURCE_CHAINS,
  ccAsset,
  ccAssetByToken,
  type CcChain,
} from "@forgewallet/swap2-assets";
import type {CrossChainProvider, IntentStatus, QuoteParams, Quote, UnsignedTx} from "../types.js";
import {
  Swap2ConfigurationError,
  Swap2ExecutionError,
  Swap2FeeLimitError,
  Swap2QuoteError,
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

/** Our config adds the account's source chain (CAIP-2) the type omits. */
/**
 * Where an execution is, for progress UIs. A source leg can spend a minute
 * before anything is signed (two awaited ERC-20 approvals for USDT), so
 * "signing" alone reads as hung. Diagnostics only: a throwing observer can
 * never change the outcome.
 */
/**
 * Most native coin a route may charge on top of the input (bridge messaging
 * fees), base units per chain. Above this the quote is refused even though it
 * declared the fee — a provider bug or a hostile backend must not turn a
 * token swap into a native drain.
 */
const NATIVE_FEE_CAP: Readonly<Record<string, bigint>> = Object.freeze({
  "eip155:1": 5_000_000_000_000_000n, // 0.005 ETH
  "eip155:137": 20_000_000_000_000_000_000n, // 20 POL
  "eip155:56": 5_000_000_000_000_000n, // 0.005 BNB
  "eip155:43114": 100_000_000_000_000_000n, // 0.1 AVAX
  "eip155:999": 100_000_000_000_000_000n, // 0.1 HYPE
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

export type Swap2ExecutionPhase = "approving" | "preflight" | "signing" | "broadcast";
export interface Swap2ExecutionPhaseDetail {
  /** approving: which approval of how many (USDT on Ethereum needs two). */
  index?: number;
  total?: number;
  /** broadcast: the source transaction hash. */
  hash?: string;
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
 * A bound wallet account. `@forgewallet/core` does not re-export
 * its account interfaces, so we accept it opaquely and reach the write surface
 * we need through {@link Swap2Signer}. Passing `undefined` builds a quote-only
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
  }): Promise<{hash?: string}>;
  /** Official token-transfer surface used by TON/Solana/Tron accounts. */
  transfer?: (options: {
    token: string;
    recipient: string;
    amount: bigint;
    /** Tron TRC-20: memo in `raw_data.data` next to the TriggerSmartContract. */
    memo?: string;
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
  getChainId?: () => Promise<number | bigint> | number | bigint;
  getNetwork?: () => Promise<{chainId?: number | bigint} | string> | {chainId?: number | bigint} | string;
  chainId?: number | bigint;
  _provider?: {getNetwork?: () => Promise<{chainId?: number | bigint}>};
  provider?: {getNetwork?: () => Promise<{chainId?: number | bigint}>};
}

/** Versioned provider/intent/source-hash id for durable status tracking. */
function encodeId(provider: string, intentId: string, sourceTxHash?: string): string {
  // encodeURIComponent leaves "." unescaped, which would shift decodeId's
  // split — escape it explicitly so segments are dot-safe.
  const enc = (v: string) => encodeURIComponent(v).replace(/\./g, "%2E");
  return `awk1.${[provider, intentId, sourceTxHash].filter((v): v is string => v != null).map(enc).join(".")}`;
}
function decodeId(id: string): {provider: string; intentId: string; sourceTxHash?: string} {
  try {
    if (!id.startsWith("awk1.")) throw new Error("unsupported id version");
    const parts = id.slice("awk1.".length).split(".");
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
  return chain;
}

/** Resolve a token ref (symbol OR on-chain address) to the engine's symbol. */
function toSymbol(caip2: string, ref: string): string {
  const byToken = ref.startsWith("0x") || ref.length > 20 ? ccAssetByToken(caip2, ref) : undefined;
  if (byToken) return byToken.symbol;
  if (ccAsset(caip2, ref)) return ref; // already a symbol we know
  return ref;
}

/** Resolve a dest token ref to the engine's dest address (zero = native). */
function toDestAddress(caip2: string, ref: string): string {
  if (ref.startsWith("0x")) return ref;
  const asset = ccAssetByToken(caip2, ref) ?? ccAsset(caip2, ref);
  if (!asset) {
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
    slippageBps = Math.floor(options.slippage * 10_000);
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
    const permitted = BigInt(Math.floor(options.slippage * Number(scale)));
    const required = (nominal * (scale - permitted) + scale - 1n) / scale;
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

  /** Swap2Options → the engine's QuoteParams (exact-in only). */
  protected toParams(options: Swap2Options, dry: boolean): QuoteParams {
    if (options.fromTokenAmount == null) {
      throw new Swap2UnsupportedOperationError("swap2: exact-out swap2 is not supported by the engine");
    }
    const destChain = toCaip2(options.toChain, this.fromChain);
    const constraints = callerConstraints(options);
    const amountIn = exactPositiveAmount(options.fromTokenAmount, "fromTokenAmount");
    const params: QuoteParams = {
      sourceChain: this.fromChain,
      sourceToken: toSymbol(this.fromChain, options.fromToken),
      destChain,
      destToken: toDestAddress(destChain, options.toToken),
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
    const actualText = typeof actual === "string" ? actual : String(actual);
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
    const source = ccAsset(this.fromChain, toSymbol(this.fromChain, options.fromToken));
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

  override async quoteSwap2(options: Swap2Options): Promise<Swap2Quote> {
    const snapshot = snapshotOptions(options);
    const q = await this.resolveQuote(this.toParams(snapshot, true));
    if (!q) {
      const detail = this.noRouteDetail();
      throw new Swap2QuoteError(`swap2: no route available for the requested pair${detail ? ` :: ${detail}` : ""}`);
    }
    assertQuoteConstraints(q, snapshot);
    this.assertQuoteFeeCaps(q, snapshot);
    return this.toQuote(q, snapshot);
  }

  override async swap2(options: Swap2Options, config?: Swap2ProtocolConfig): Promise<Swap2Result> {
    // Account first: a read-only or missing account is refused before any option is
    // validated or any network call is made (SDK protocol conformance).
    const signerCandidate = this._account as Partial<Swap2Signer> | undefined;
    if (!signerCandidate || typeof signerCandidate.sendTransaction !== "function") {
      throw new Swap2ExecutionError("swap2: swap2() requires a signing account (read-only accounts can only quote)");
    }
    const snapshot = snapshotOptions(options);
    requireExecutionFloor(snapshot);
    const configSnapshot = snapshotConfig(config);
    this.assertFeeConfig(configSnapshot);
    const signer = signerCandidate as Swap2Signer;
    await this.assertAccountChain(signer);
    // Refunds land on the SOURCE chain, so the only safe default is the bound
    // account's own address — never the recipient, which may be a dest-chain
    // address (a TON-source swap with an EVM recipient would otherwise hand the
    // provider an EVM string as the TON refund/trader wallet).
    const selfAddress = await signer.getAddress();
    const recipient = snapshot.recipient ?? selfAddress;
    const refundAddress = snapshot.refundAddress ?? selfAddress;
    const executionOptions = snapshotOptions({...snapshot, recipient, refundAddress});
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
    // sources use the official account.transfer() token surface below.
    let tokenId: string | undefined;
    if (!unsigned.data && !unsigned.bodyBoc && !unsigned.typedData && !serialized) {
      const src = ccAsset(this.fromChain, toSymbol(this.fromChain, executionOptions.fromToken));
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

    // A TON jetton transfer needs its memo as a forward payload. Our generic
    // signer cannot encode that yet, and would otherwise silently drop it. A
    // Tron TRC-20 memo is a transaction-level field the transfer surface
    // carries explicitly (`memo`), so it is allowed through below.
    if (tokenId && (cellBody !== undefined || (unsigned.memo !== undefined && !tronSource && !nearSource))) {
      throw new Error("swap2: token deposit with memo/cell payload is not implemented");
    }

    // Bind the value presented to the signer to the already validated quote.
    // Native deposits and the amount handed to transfer() must carry the exact
    // input amount; EVM token execution must never attach native value.
    const source = ccAsset(this.fromChain, toSymbol(this.fromChain, executionOptions.fromToken));
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

    // ERC-20 calldata/typed-order routes need an exact allowance. Do this only
    // after every local payload/value check so a malformed build cannot leave an
    // allowance behind before failing validation.
    let revokeApproval: (() => Promise<void>) | undefined;
    if (unsigned.approvalAddress && source.contract) {
      const approve = async (amount: bigint) => {
        const sent = await signer.sendTransaction({
          to: source.contract!,
          data: encodeFunctionData({
            abi: [{type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{name: "spender", type: "address"}, {name: "amount", type: "uint256"}], outputs: [{type: "bool"}]}] as const,
            functionName: "approve",
            args: [unsigned.approvalAddress as `0x${string}`, amount],
          }),
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
        const zeroFirst = this.fromChain === "eip155:1" && source.symbol.toUpperCase() === "USDT";
        const total = zeroFirst ? 2 : 1;
        if (zeroFirst) {
          this.emitPhase("approving", {index: 1, total});
          await approve(0n);
        }
        this.emitPhase("approving", {index: total, total});
        await approve(BigInt(executionOptions.fromTokenAmount!));
      } catch (error) {
        await revokeApproval().catch(() => {});
        throw error;
      }
    }

    // The quote/build step can be separated from the actual send by an ERC-20
    // approval. Recheck rotating/halt-sensitive provider state only now.
    try {
      if (q.validUntilMs > 0 && q.validUntilMs <= Date.now()) {
        throw new Error("swap2: quote expired before source broadcast");
      }
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
        // ethers infers the domain type and reject an explicit
        // EIP712Domain entry as an ambiguous primary type.
        const {EIP712Domain: _domain, ...types} = td.types;
        const signature = await signer.signTypedData({
          domain: td.domain,
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
    // MUST use transfer({token,recipient,amount}); passing token metadata
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
          ...((tronSource || nearSource) && unsigned.memo ? {memo: unsigned.memo} : {}),
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
              ? (tronSource || nearSource ? {memo: unsigned.memo} : {body: unsigned.memo})
              : {}),
        });
      }
      if (!sent.hash) throw new Swap2ExecutionError("swap2: account did not return a source transaction hash");
      this.emitPhase("broadcast", {hash: sent.hash});
    } catch (error) {
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

  override async getSwap2Status(id: string, _options?: Swap2StatusOptions): Promise<Swap2StatusResult> {
    const {provider: name, intentId, sourceTxHash} = decodeId(id);
    const provider = this.providerFor(name);
    if (!provider) throw new Error(`swap2: no swap2 found for id '${id}'`);
    return mapStatus(await provider.trackIntent(sourceTxHash == null ? {intentId} : {intentId, sourceTxHash}));
  }

  /** bridge() has no floor field: quote first, then bind execution
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

  override async getSupportedChains(): Promise<Swap2SupportedChain[]> {
    if (!this.protocolEnabled()) return [];
    return CC_SOURCE_CHAINS.filter((c: CcChain) => this.chainSupported(c.caip2)).map((c) => ({
      id: c.caip2,
      name: c.label,
      type: chainType(c.caip2),
      nativeToken: c.assets[0]?.symbol ?? "",
    }));
  }

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
