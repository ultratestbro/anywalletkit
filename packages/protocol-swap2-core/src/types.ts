/**
 * Cross-chain asset delivery types. The vault is single-chain; cross-chain is
 * delivery only, via a router over pluggable providers (NEAR Intents + others).
 * A provider can only delay/refund delivery — it can never affect vault safety.
 */
import type {ActivityItem, ChainTx, DescribeActivityContext} from "@anywalletkit/core";
import type {Swap2RefusalInfo} from "./errors.js";

/** A token on a chain, as providers see it. */
export interface Asset {
  chain: string; // CAIP-2, e.g. "tron:728126428"
  token: string; // native-format token id/address on that chain
}

/** What the engine asks a provider to quote. Amounts are base-unit strings; exact input only. */
export interface QuoteParams {
  /** Stable provider-scoped route selector (e.g. taxi/bus), never a quote/intent id. */
  routeId?: string;
  /** Local-only (never serialized): called with the reason when the provider
   *  refuses to quote — a shared-instance "last refusal" field raced under
   *  concurrent quotes, so the reason rides per-call. `info` classifies the
   *  refusal (`info.reason`, see Swap2RefusalReason) when the provider can. */
  onRefusal?: (reason: string, info?: Swap2RefusalInfo) => void;
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
  /**
   * The account that signs the source transaction, set by the engine on an execution quote (its own address); absent
   * on a dry quote. A provider whose deposit gives its sender more than refunds binds to this, never to
   * `refundAddress`: an Across depositor can sign a speed-up that pays the output to another recipient, so it must be
   * the signer, not an address the caller names for refunds.
   */
  sender?: string;
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
  /**
   * Permit2 signature-transfer execution (a 0x Settler swap): the JSON EIP-712 `PermitTransferFrom`
   * the account signs right before `data` is sent — see {@link UnsignedTx.permit2Transfer}.
   */
  permit2Transfer?: string;
}

/** Where a quote's {@link Quote.gasEstimate} comes from (see there). */
export type GasEstimateSource = "venue" | "simulated" | "model";

/** A normalized quote from one provider. */
export interface Quote {
  /** Provider name. */
  provider: string;
  /** Stable route selector, preserved when refreshing price/expiry. */
  routeId?: string;
  /** Provider's id for this swap; tracked with `trackIntent`. */
  intentId: string;
  depositAddress: string; // where the user sends source funds ("" on dry quotes)
  depositMemo: string | null; // MUST accompany the deposit when present (TON)
  /** Present instead of a usable depositAddress for calldata providers. */
  txRequest?: TxRequest;
  sourceAmount: string; // what the user pays on source (base units)
  destAmount: string; // what arrives on dest (base units)
  minDestAmount: string; // worst case at the quoted slippage (base units)
  /**
   * Decimals of the destination token as the provider reports them (LI.FI's `action.toToken.decimals`). They are the
   * provider's word, so the engine never uses them alone for the reviewed minimum it hands an account
   * (`bridgeOut.destDecimals`): that is the catalog's value, else the caller's `toTokenDecimals`, and a quote whose value
   * disagrees with the caller's is refused.
   */
  destDecimals?: number;
  feeUsd: number; // normalized fee for scoring
  /** Honest itemized fees when the provider exposes base-unit amounts. */
  fees?: {type: "network" | "protocol" | "affiliate" | "other"; amount: string; token: string; included: boolean; description?: string}[];
  /**
   * The user signs this route's source leg and a third party sends it and pays its gas (a CoW solver settles the
   * order, an Omniston resolver fills it). An approval may still be the user's. The router counts no swap gas for it
   * (`sourceGasUsd`); nothing in execution reads it.
   */
  gasless?: boolean;
  /**
   * The gas the route's main source transaction is expected to USE — gas used, not a limit — in gas units, as a
   * decimal string (EVM sources only). No execution headroom, and no approval: an ERC-20 approval is priced separately
   * by whoever prices the route. `txRequest.gasLimit` stays what the transaction is sent with and what the native-gas
   * check counts; this is the figure a router can compare routes on (`evmSourceGas({useGasEstimate: true})` in the
   * router package). A venue's figure is passed on as the venue states it (README, "Gas": some run above the gas used).
   *
   * Rules, enforced by `quoteRejection` (a quote that breaks one is refused as malformed, `upstream_unavailable`, and a
   * swap2 server refuses to seal it): canonical digits (`"0"` or no leading zero, at most 10 digits); set together with
   * {@link gasEstimateSource}; an EVM source chain only; `"0"` exactly when the quote is `gasless`, positive otherwise;
   * at most `txRequest.gasLimit` when the quote has one. Absent when the module has no defensible figure — never a
   * guess.
   */
  gasEstimate?: string;
  /**
   * Where {@link gasEstimate} comes from: `"venue"` — the venue's API answered it for this quote (a gas field of the
   * quote response); `"simulated"` — an `eth_estimateGas` / `eth_simulateV1` / gas-measuring `eth_call` of this quote's
   * transaction or route (a quoter contract's own gas figure counts here); `"model"` — the module's table (pool type,
   * hop count, a gasless route's structural zero), with the measurements behind it in the module's README. Present
   * exactly when `gasEstimate` is.
   */
  gasEstimateSource?: GasEstimateSource;
  /** Estimated time to delivery, or null when no defensible estimate is available. */
  etaSeconds: number | null;
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
  /**
   * `true` when the account that sent `destTxHash` saw it included and succeed (`claimSwap2` after
   * the account's `waitForTransaction` resolved). A provider that cannot read the destination may
   * take it as the delivery; a bare `destTxHash` proves only that a claim was sent.
   */
  destTxConfirmed?: boolean;
  /** A separately reviewed recovery transaction; never replaces the original source hash. */
  recoveryTxHash?: string;
  recoveryChain?: string;
  recoveryActionId?: string;
}

/** A fresh, explicitly priced recovery call. Calldata must be checked on the signing client. */
export interface RecoveryQuote {
  id: string;
  kind: "claim" | "retry-token" | "retry-message" | "drive-bus" | "compose";
  description: string;
  validUntilMs: number;
  tx: UnsignedTx;
}

/** The router's chosen quote, tagged with how it scored. */
export interface RoutedQuote extends Quote {
  routeScore: {
    score: number;
    weights: ScoreWeights;
    /** Every validated route: `score` is its value against the best (0..1). */
    candidates: {provider: string; routeId?: string; sourceAmount: string; etaSeconds: number | null; score: number; minDestAmount?: string; netValueUsd?: number | null}[];
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
   * Permit2 signature-transfer execution (a 0x Settler swap): the JSON EIP-712 `PermitTransferFrom`
   * the account signs right before the calldata is sent. NOT a typed order: there is a source
   * transaction, and the signature is only usable inside it (Permit2 takes the token from
   * `msg.sender` of the spender's call). The engine binds the payload to the swap before any
   * approval — Permit2 itself as the verifying contract and as `approvalAddress`, the source token,
   * exactly the input amount, `to` as the Permit2 spender, a near deadline — signs it as typed
   * data (never as a raw hash) and sends `data ++ uint256(signature length) ++ signature`.
   */
  permit2Transfer?: string;
  /**
   * Typed-order execution: the order extension (0x-hex) the order's salt commits to — a 1inch Limit Order Protocol
   * order's amount getters and post-interaction, where an HTLC order's escrow terms live. Carried so an app can open
   * a remote build on the client (`omnistonVerifyBuild`, scan 2026-10-28 F6); the signature covers it through the salt.
   */
  orderExtension?: string;
  /**
   * CoW Protocol typed orders only: the allowance the vault relayer needs once this order is added to the
   * account's other open orders of the same token — never less than the swap's input. The engine raises a lower
   * allowance to it and leaves a sufficient one alone (lowering it would starve the open orders).
   */
  approvalAmount?: string;
  /**
   * CoW Protocol typed orders only: the JSON EIP-712 `Permit` (EIP-2612) for `approvalAmount`, offered when the
   * token supports it. The engine signs it instead of sending an approval transaction and hands the signature to
   * `CrossChainProvider.applyPermit`, which returns the order with the permit as its pre-hook.
   */
  permit?: string;
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
  /** Paid recovery targets and independent client revalidation, when supported. */
  recoveryTargets?(chain: string): readonly string[];
  verifyRecovery?(ref: IntentRef, quote: RecoveryQuote, actor: string): Promise<string | null>;
  /** Independent client tracking, when completion must be proven locally from chain evidence. */
  trackIntent?(ref: IntentRef): Promise<IntentStatus>;
  /**
   * A client-side check of a remote quote's transaction against the user's own request — the
   * provider's local validator run again on this side (Fynd: `checkFyndTransaction`): the reason it
   * fails, or null.
   */
  verifyQuote?(params: QuoteParams, quote: Quote): string | null;
  /** Read-only client check of a remote build against its quote: reason or null.
   * May run repeatedly, including after preflight immediately before signing. */
  verifyBuild?(quote: Quote, tx: UnsignedTx, params?: QuoteParams): string | null | Promise<string | null>;
  /**
   * The classification of a text `verifyQuote` or `verifyBuild` returned (`reason`, see Swap2RefusalReason), so a
   * remote stub's refusal carries it; undefined for a text these pins did not produce.
   */
  reasonOf?(refusal: string): Swap2RefusalInfo | undefined;
  /**
   * The provider's routes pay an address the backend names — a deposit address, or a plain value send — instead of
   * calling a pinned contract (`thorchainPins` for a Tron vault, NEAR Intents' per-quote deposit addresses). Without
   * it a remote stub's deposit-address and plain-value routes are refused (scan 2026-10-28, F9).
   */
  depositAddressRoutes?: boolean;
  /** The provider's {@link CrossChainProvider.exactAllowanceOnly}, carried to the stub (`kyberPins`). */
  exactAllowanceOnly?(chain: string): boolean;
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
  /** Optional display-only candidates, at most 32, each with a unique routeId.
   * When present, getQuote must also return a routeId, including its default quote.
   * Execution uses getQuote with the selected routeId and must not substitute it. */
  getQuotes?(params: QuoteParams, signal?: AbortSignal): Promise<Quote[]>;
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
  registerSignedOrder?(intentId: string, signature: string): Promise<void | {intentId: string}>;
  /**
   * CoW Protocol: fold the account's EIP-2612 permit signature into the order (its appData pre-hook) and return
   * the build to sign — the same order with another `appData`. The engine re-checks it field by field.
   */
  applyPermit?(intentId: string, signature: string): Promise<UnsignedTx>;
  /**
   * Orders that rest before they settle (CoW Protocol): what cancels one, or `null` when nothing is left to
   * cancel. Off-chain (`onchain: false`): typed data for the orderbook, completed via `registerCancel` — free,
   * best effort. On-chain: plain calldata to a contract `cancelTargets` names (an order placed by an on-chain
   * transaction can only be cancelled this way). The engine executes it through `cancelSwap2`.
   */
  buildCancel?(ref: IntentRef, options: {owner: string; onchain: boolean}): Promise<UnsignedTx | null>;
  /** Off-chain cancellation: hand the signed cancellation to the provider's API. */
  registerCancel?(intentId: string, signature: string): Promise<void>;
  /** The contracts an on-chain cancellation may call on `chain` (CAIP-2). */
  cancelTargets?(chain: string): readonly string[];
  /**
   * Two-phase routes: the destination-chain transaction that completes the
   * delivery (CCTP `receiveMessage(message, attestation)`), or `null` while
   * the attestation is not available yet. The engine executes it through a
   * destination-chain account (`claimSwap2`); `tx.chain` names that chain.
   */
  buildClaim?(ref: IntentRef): Promise<UnsignedTx | null>;
  /** Fresh recovery offers, on the source or destination; no signing or side effects. */
  getRecoveryQuotes?(ref: IntentRef): Promise<RecoveryQuote[]>;
  /** Local/client pins, never addresses supplied by a backend response. */
  recoveryTargets?(chain: string): readonly string[];
  /** Required client validator: bind calldata/value/recipient to on-chain intent evidence,
   * and recheck current recoverability. Called again after review, before signature. */
  verifyRecovery?(ref: IntentRef, quote: RecoveryQuote, actor: string): Promise<string | null>;
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
  /**
   * The engine sends this provider's EVM calls (a native-coin sale, a token sale's call) with the account's own gas
   * estimate of exactly that call, dry-run from the account right before broadcast — never with the quoted gas limit,
   * which is the venue's (or a backend's) word: a limit below what the call needs would pass a fee check and then
   * revert on-chain out of gas, after the account paid for it. A dry run that reverts refuses the swap
   * (`simulation_failed`); an RPC that does not answer it is asked once more, then refuses it (`upstream_unavailable`).
   * A Permit2 signature transfer always goes out this way. Set by the 0x provider; the router's snapshot carries it.
   */
  readonly ownGasEstimate?: boolean;
  /** Remote stubs: the contracts this provider's EVM swaps may call on `chain` (the app's list, e.g. `lifiPins`). */
  callTargets?(chain: string): readonly string[];
  /** Remote stubs: the spenders this provider's EVM swaps may be approved for on `chain` (the app's list). */
  spenders?(chain: string): readonly string[];
  /**
   * True when, on `chain` (CAIP-2), an allowance to this provider's spender must not outlive the swap: a spender whose
   * owner could spend an allowance left on it (KyberSwap's generic-build router, whose single owner key manages the
   * `swapGeneric` executor whitelist). The engine then holds every execution through this provider on that chain to
   * the defaults — the allowance set to exactly the input, revoked when the swap does not spend it — whatever
   * `allowanceReuse` / `revokeUnspentApproval` say. A throw, or any answer but `false`, counts as true. Kept on the
   * client: for a remote stub it comes from the app's pins, never the server; the router's snapshot carries it.
   */
  exactAllowanceOnly?(chain: string): boolean;
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
