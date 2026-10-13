/**
 * Cross-chain asset delivery types. The vault is single-chain; cross-chain is
 * delivery only, via a router over pluggable providers (NEAR Intents + others).
 * A provider can only delay/refund delivery — it can never affect vault safety.
 */
export interface Asset {
  chain: string; // CAIP-2, e.g. "tron:728126428"
  token: string; // native-format token id/address on that chain
}

export interface QuoteParams {
  /** Local-only (never serialized): called with the reason when the provider
   *  refuses to quote — a shared-instance "last refusal" field raced under
   *  concurrent quotes, so the reason rides per-call. */
  onRefusal?: (reason: string) => void;
  sourceChain: string; // CAIP-2
  sourceToken: string; // token SYMBOL on source (resolved via the asset catalog)
  destChain: string; // CAIP-2 (the vault's chain)
  destToken: string; // ERC-20 address on dest (zero address = native ETH)
  amountIn: string; // what the user sends on source (base units, EXACT_INPUT)
  /** Caller-supplied output floor in destination base units. */
  minAmountOut?: string;
  /** Maximum slippage accepted by the caller, expressed in basis points. */
  slippageBps?: number;
  destAddress: string; // recipient on dest (the vault, or a payout address)
  /** Where a failed swap refunds on the source chain (the sender's address). */
  refundAddress?: string;
  /** Pricing preview only — no deposit address is created upstream. */
  dry?: boolean;
  /**
   * Amount-flexible deposit (exchange flow): `amountIn` is only a pricing
   * notional — the user may send any amount to the deposit address (1Click
   * FLEX_INPUT). Providers that can't do this return no quote.
   */
  flex?: boolean;
}

/**
 * Provider-built transaction for the CALLDATA execution model (LI.FI): the
 * user's wallet must execute this exact payload — a plain transfer to `to`
 * would LOSE funds. Either an EVM request or a pre-serialized Solana tx.
 */
export interface TxRequest {
  to?: string;
  data?: string; // EVM calldata
  value?: string; // wei, decimal string
  chainId?: number;
  gasLimit?: string;
  /** ERC-20 sources must approve this spender before executing. */
  approvalAddress?: string;
  /**
   * Native coin the route itself charges on top of the input (bridge
   * messaging fees — Stargate/LayerZero-style), base units. A token source
   * then sends exactly this as `value`; a native source sends input + this.
   * Declared by the provider from the quote, sealed with it, and capped by
   * the engine per chain.
   */
  nativeFee?: string;
  /** Solana: base64-serialized transaction to sign & broadcast as-is. */
  serializedTx?: string;
}

/** A normalized quote from one provider. */
export interface Quote {
  provider: string;
  intentId: string;
  depositAddress: string; // where the user sends source funds ("" on dry quotes)
  depositMemo: string | null; // MUST accompany the deposit when present (TON)
  /** Present instead of a usable depositAddress for calldata providers. */
  txRequest?: TxRequest;
  sourceAmount: string; // what the user pays on source (base units)
  destAmount: string; // what arrives on dest (base units)
  minDestAmount: string; // worst case at the quoted slippage (base units)
  feeUsd: number; // normalized fee for scoring
  /** Honest itemized fees when the provider exposes base-unit amounts. */
  fees?: {type: "network" | "protocol" | "affiliate" | "other"; amount: string; token: string; included: boolean; description?: string}[];
  etaSeconds: number; // estimated settlement time
  reliability: number; // 0..1 provider/route reliability hint
  validUntilMs: number;
  /** Provider-owned, JSON-safe facts required to revalidate execution. */
  providerData?: Record<string, string>;
}

/** What trackIntent gets to work with (LI.FI tracks by the source tx hash). */
export interface IntentRef {
  intentId: string;
  sourceTxHash?: string | null;
  /** Two-phase routes: the destination-chain claim transaction, once sent. */
  destTxHash?: string | null;
}

/** The router's chosen quote, tagged with how it scored. */
export interface RoutedQuote extends Quote {
  routeScore: {
    score: number;
    weights: ScoreWeights;
    /** Every validated route: `score` is its value against the best (0..1). */
    candidates: {provider: string; sourceAmount: string; etaSeconds: number; score: number; minDestAmount?: string; netValueUsd?: number | null}[];
  };
}

export interface ScoreWeights {
  price: number;
  speed: number;
  reliability: number;
}

export type IntentState =
  | "pending"
  | "action-required"
  | "refund-pending"
  | "partial"
  | "completed"
  | "failed"
  | "refunded"
  | "cancelled"
  | "expired";

export interface IntentStatus {
  state: IntentState;
  /** Still pending, but the source deposit has been observed (PROCESSING). */
  depositReceived?: boolean;
  destTxHash?: string;
  /**
   * Two-phase routes (CCTP-style burn-and-mint): the delivery needs a second,
   * user-signed transaction on the destination chain. `ready` means the
   * provider can build it now (`buildClaim`); `state` is then
   * "action-required". Before that the route is "pending" with `ready: false`.
   */
  claim?: {chain: string; ready: boolean};
}

export interface UnsignedTx {
  chain: string;
  to: string;
  value: string;
  data?: string;
  chainId?: number;
  gasLimit?: string;
  /** ERC-20 spender that must be approved before the calldata is sent. */
  approvalAddress?: string;
  /** Provider-native serialized transaction (for accounts that expose a hook). */
  serializedTx?: string;
  /** Native-chain memo/body required by the deposit protocol. */
  memo?: string;
  /**
   * TON: serialized message-body CELL (base64 BoC) — e.g. an Omniston escrow
   * payload. NOT interchangeable with `memo`: a memo is a text comment, while
   * sending a BoC as text strands the swap. Executors must decode it to a Cell.
   */
  bodyBoc?: string;
  /** TON: contract stateInit (base64 BoC) the message must carry, when present. */
  stateInitBoc?: string;
  /**
   * GASLESS typed-order execution (Omniston EVM-source): the JSON EIP-712
   * payload the account must sign — there is NO source transaction. After
   * signing, complete via `CrossChainProvider.registerSignedOrder`. When set,
   * `approvalAddress` names the settlement contract that needs allowance.
   */
  typedData?: string;
}

/**
 * Pluggable cross-chain provider. Adding a provider is "add a module"; the rest
 * of the app references only this interface (never a specific provider).
 */
export interface CrossChainProvider {
  readonly name: string;
  /** Master flag — providers ship "dark" (off) until validated with real funds. */
  enabled(): boolean;
  supportsRoute(from: Asset, to: Asset): boolean;
  getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null>;
  buildDeposit(quote: Quote): Promise<UnsignedTx>;
  /**
   * Last fail-closed check after any approval and immediately before the
   * wallet signs/broadcasts the source leg. Providers whose execution target
   * can rotate or halt (THORChain vaults/routers) must revalidate it here.
   */
  preflightDeposit?(quote: Quote, tx: UnsignedTx): Promise<void>;
  trackIntent(ref: IntentRef): Promise<IntentStatus>;
  /**
   * Tell the provider the source funds were sent (tx hash / BoC). Required for
   * NEAR Intents TON deposits — the HOT-bridge oracle can't observe SIMPLE-mode
   * deposits on uninitialized addresses without it. Best-effort elsewhere.
   */
  notifyDeposit?(intentId: string, txHash: string): Promise<void>;
  /** Gasless typed-order providers: register the wallet's EIP-712 signature. */
  registerSignedOrder?(intentId: string, signature: string): Promise<void>;
  /**
   * Two-phase routes: the destination-chain transaction that completes the
   * delivery (CCTP `receiveMessage(message, attestation)`), or `null` while
   * the attestation is not available yet. The engine executes it through a
   * destination-chain account (`claimSwap2`); `tx.chain` names that chain.
   */
  buildClaim?(ref: IntentRef): Promise<UnsignedTx | null>;
  close?(): void;
  /** Optional discovery hook for custom providers. */
  supportsChain?(caip2: string): boolean;
  /** Optional pair-level discovery for aggregators. */
  supportsChainPair?(fromChain: string, toChain: string): boolean;
  /** Explicit opt-in: provider can execute a same-chain swap. */
  supportsSameChain?: boolean;
}
