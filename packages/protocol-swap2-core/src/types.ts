/**
 * Cross-chain asset delivery types. The vault is single-chain; cross-chain is
 * delivery only, via a router over pluggable providers (NEAR Intents + others).
 * A provider can only delay/refund delivery — it can never affect vault safety.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";

/** A token on a chain, as providers see it. */
export interface Asset {
  chain: string; // CAIP-2, e.g. "tron:728126428"
  token: string; // native-format token id/address on that chain
}

/** What the engine asks a provider to quote. Amounts are base-unit strings; exact input only. */
export interface QuoteParams {
  /** Local-only (never serialized): called with the reason when the provider
   *  refuses to quote — a shared-instance "last refusal" field raced under
   *  concurrent quotes, so the reason rides per-call. */
  onRefusal?: (reason: string) => void;
  sourceChain: string; // CAIP-2
  sourceToken: string; // token SYMBOL on source (resolved via the asset catalog), or an unlisted token's contract / mint
  /**
   * Set only for a source token the catalog does not list: `sourceToken` is then its contract
   * (EVM) or mint (Solana) and this its decimals. Providers that can trade any token resolve it with
   * `resolveAsset(chain, sourceToken, {allowUnlisted: true, decimals})`; the others refuse it.
   */
  sourceDecimals?: number;
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
  /** Provider name. */
  provider: string;
  /** Provider's id for this swap; tracked with `trackIntent`. */
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
  /** Estimated time to delivery. */
  etaSeconds: number; // estimated settlement time
  /** Provider's reliability hint, 0 to 1. */
  reliability: number; // 0..1 provider/route reliability hint
  /** Quote expiry, unix milliseconds. */
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

/** How the router weighs price, speed and reliability when it scores routes. */
export interface ScoreWeights {
  price: number;
  speed: number;
  reliability: number;
}

/** A swap's state as the engine reports it; maps to `Swap2Status`. */
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

/** A provider's answer to `trackIntent`. */
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

/** A provider's source-leg transaction, before the engine checks and signs it. */
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
  /** How `memo` becomes bytes on chains whose memo is a byte field (Tron `raw_data.data`): 'utf8' text (default) or
   *  'hex' — a binary payload given as 0x-hex (a Chainflip vault-swap note). */
  memoEncoding?: "utf8" | "hex";
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
  /**
   * Typed-order execution: the order extension (0x-hex) the order's salt commits to — a 1inch Limit Order Protocol
   * order's amount getters and post-interaction, where an HTLC order's escrow terms live. Carried so an app can open
   * a remote build on the client (`omnistonVerifyBuild`, scan 2026-10-28 F6); the signature covers it through the salt.
   */
  orderExtension?: string;
}

/**
 * The contracts a provider's EVM swaps call and approve on a chain, shipped by the provider package
 * (`lifiPins`, `fyndPins`, `uniswapPins`…) and handed to `remoteProvider({...pins})`: a backend's
 * build is checked against the app's addresses, never against its own (scan 2026-10-27 modules,
 * F8/F9/F16). An empty list means the provider has no EVM calldata route on that chain.
 */
export interface RemotePins {
  callTargets(chain: string): readonly string[];
  spenders(chain: string): readonly string[];
  /**
   * A client-side check of a remote quote's transaction against the user's own request — the
   * provider's local validator run again on this side (Fynd: `checkFyndTransaction`): the reason it
   * fails, or null.
   */
  verifyQuote?(params: QuoteParams, quote: Quote): string | null;
  /** A client-side check of a remote build (typed order, cell body) against its quote: the reason it fails, or null. */
  verifyBuild?(quote: Quote, tx: UnsignedTx, params?: QuoteParams): string | null | Promise<string | null>;
  /**
   * The provider's routes pay an address the backend names — a deposit address, or a plain value send — instead of
   * calling a pinned contract (`thorchainPins` for a Tron vault, NEAR Intents' per-quote deposit addresses). Without
   * it a remote stub's deposit-address and plain-value routes are refused (scan 2026-10-28, F9).
   */
  depositAddressRoutes?: boolean;
}

/**
 * Pluggable cross-chain provider. Adding a provider is "add a module"; the rest
 * of the app references only this interface (never a specific provider).
 */
export interface CrossChainProvider {
  /** Provider name, unique in a router. */
  readonly name: string;
  /** Master flag — providers ship "dark" (off) until validated with real funds. */
  enabled(): boolean;
  /** Cheap synchronous check: can this provider route `from` to `to`? No I/O. */
  supportsRoute(from: Asset, to: Asset): boolean;
  /** A quote, or `null` with the reason passed to `params.onRefusal`. */
  getQuote(params: QuoteParams, signal?: AbortSignal): Promise<Quote | null>;
  /** The source-leg transaction for a quote. */
  buildDeposit(quote: Quote): Promise<UnsignedTx>;
  /**
   * Last fail-closed check after any approval and immediately before the
   * wallet signs/broadcasts the source leg. Providers whose execution target
   * can rotate or halt (THORChain vaults/routers) must revalidate it here.
   */
  preflightDeposit?(quote: Quote, tx: UnsignedTx): Promise<void>;
  /** Current status of a swap. */
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
  /**
   * The contracts a claim from {@link buildClaim} may call on `chain` (CAIP-2) — CCTP's
   * MessageTransmitter. `claimSwap2` refuses a claim to anything else, and a provider with a claim
   * step must declare them (round 3, M24). Kept on the client: for a remote provider this is the
   * app's list, never the server's.
   */
  claimTargets?(chain: string): readonly string[];
  /**
   * Set by `remoteProvider`: the quotes and builds come from a backend, not from code the app
   * ships. The engine then takes the addresses an EVM transaction may call or approve only from
   * {@link callTargets} / {@link spenders} — the app's pins — and refuses a calldata route or an
   * approval it has no pin for (scan 2026-10-27 modules, F8/F9/F16).
   */
  readonly remote?: boolean;
  /** Set by `remoteProvider` when the app gave it `verifyBuild`: its builds are checked on the client. */
  readonly verifiesBuilds?: boolean;
  /**
   * Set by `remoteProvider` when the app gave it `verifyQuote`: its quotes' transactions are checked on the client.
   * A remote stub's EVM calldata route needs this or {@link verifiesBuilds} (scan 2026-10-30, F3).
   */
  readonly verifiesQuotes?: boolean;
  /**
   * Set by `remoteProvider` when the app opted in (`depositAddressRoutes`): this stub may send the input to an address
   * its backend names. Without it the engine refuses a remote stub's deposit-address and plain-value builds.
   */
  readonly depositAddressRoutes?: boolean;
  /** Remote stubs: the contracts this provider's EVM swaps may call on `chain` (the app's list, e.g. `lifiPins`). */
  callTargets?(chain: string): readonly string[];
  /** Remote stubs: the spenders this provider's EVM swaps may be approved for on `chain` (the app's list). */
  spenders?(chain: string): readonly string[];
  close?(): void;
  /** Optional discovery hook for custom providers. */
  supportsChain?(caip2: string): boolean;
  /** Optional pair-level discovery for aggregators. */
  supportsChainPair?(fromChain: string, toChain: string): boolean;
  /** Explicit opt-in: provider can execute a same-chain swap. */
  supportsSameChain?: boolean;
  /**
   * Recognize one of this provider's own transactions in an address's history
   * (contract + selector on EVM, settlement counterparty elsewhere) and
   * describe it for the activity feed; null when it is not this provider's.
   * Pure and synchronous. The single-provider protocol classes and the router
   * delegate `describeActivity` here.
   */
  describeActivity?(tx: ChainTx, ctx: DescribeActivityContext): ActivityItem | null;
}
