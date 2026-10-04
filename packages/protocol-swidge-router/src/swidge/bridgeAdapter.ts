/**
 * Adapts an `IBridgeProtocol` module (e.g. a USDT0 bridge
 * over LayerZero OFT) into
 * an {@link ExternalSwidgeModule} the aggregator can auction.
 *
 * A bridge is a same-token 1:1 transfer: output = input, and the cost is paid
 * in the SOURCE chain's native token (gas `fee` + protocol `bridgeFee`), not
 * out of the bridged amount. That makes it unbeatable on same-stable pairs by
 * `toTokenAmount` — which is usually correct (an OFT burn/mint beats any swap
 * venue's slippage), but note the auction does not normalize native-side fees
 * into the output token; callers moving dust should inspect `fees`.
 *
 * `IBridgeProtocol` has no status surface; the default status check resolves
 * delivery through the public LayerZero Scan API by source tx hash
 * (override via `status` for non-LZ bridges). Resolving that status away from
 * the wallet — a server cron, a worker — needs {@link statusOnlyModule}.
 *
 * CONSUMER CONTRACT — observed on the official USDT0 module, both of which cost
 * a live swap to find:
 *
 * - `bridge()` may demand a CONCRETE ACCOUNT CLASS. The USDT0 module admits
 *   only an instance of its own `WalletAccountEvm`/`WalletAccountEvmErc4337`,
 *   while `quoteBridge()` accepts any account-shaped object — so an integration
 *   whose key lives elsewhere (a worker, an HSM, a remote signer) quotes
 *   perfectly and then fails at execution, with the funds already committed in
 *   the user's mind. Faking the class does not help: `instanceof` fails anyway
 *   when the module resolves a duplicated copy of that package. What works is
 *   that the module hands its fully built transaction to the account for a fee
 *   estimate during `quoteBridge()` — capture it there and sign it yourself,
 *   which keeps the route the module's rather than reconstructing it.
 *
 * - The ERC-20 SPENDER can depend on the DESTINATION, not just the source
 *   chain. USDT0 deliberately skips its OFT contract for TON, Solana and Tron
 *   and bridges those through a legacy mesh contract (deployed only on some
 *   chains). An allowance granted to the wrong one is invisible: the module
 *   simply reverts its gas estimate again, exactly as it did with no allowance
 *   at all. Resolve the spender the way the module resolves its own contract
 *   and confirm it on-chain via `token()`.
 */
import type {
  SwidgeOptions,
  SwidgeQuote,
  SwidgeResult,
  SwidgeStatusResult,
  SwidgeSupportedChain,
  SwidgeSupportedToken,
  SwidgeSupportedTokensOptions,
} from "@forgewallet/core";
import type {ExternalSwidgeModule, ExternalSwidgeProtocol} from "./router.js";
import {timeoutSignal} from "@forgewallet/protocol-swidge-core/util";

/** Structural view of a bridge module (+ the optional discovery methods
 *  the official USDT0 module ships in canonical swidge shape). */
export interface BridgeProtocolLike {
  quoteBridge(options: {
    targetChain: string;
    recipient: string;
    token: string;
    amount: number | bigint;
  }): Promise<{fee: bigint; bridgeFee: bigint}>;
  bridge(options: {
    targetChain: string;
    recipient: string;
    token: string;
    amount: number | bigint;
  }): Promise<{hash: string; fee: bigint; bridgeFee: bigint}>;
  getSupportedChains?(): Promise<SwidgeSupportedChain[]>;
  getSupportedTokens?(options?: SwidgeSupportedTokensOptions): Promise<SwidgeSupportedToken[]>;
}

export interface BridgeModuleAdapterOptions {
  /** Stable name for ids/status routing (e.g. "usdt0"). No dots. */
  name: string;
  protocol: BridgeProtocolLike;
  /** Aggregator `toChain` (CAIP-2 string or number) → the module's chain key
   *  (e.g. "eip155:42161" → "arbitrum", "ton:-239" → "ton"); null = not bridgeable. */
  chainKey: (toChain: string | number) => string | null;
  /**
   * Same-token gate: given the aggregator options, return the SOURCE-chain
   * token address to bridge when this pair is a 1:1 bridge this module serves
   * (e.g. USDT → USDT), or null to sit the auction out.
   */
  bridgeableToken: (options: SwidgeOptions) => string | null;
  /**
   * The account this module's protocol was constructed for. Required: a bridge
   * always signs through a bound account, and the aggregator refuses to
   * register a module that cannot name one — a module without it quotes while
   * unbound and disappears the moment a wallet is attached.
   */
  accountAddress: string | (() => string | Promise<string>);
  /** Native-token symbol fees are denominated in (display only). */
  nativeSymbol?: string;
  /** Delivery ETA hint, seconds (default 180 — LayerZero cross-chain). */
  estimatedDuration?: number;
  /** Override delivery tracking (default: LayerZero Scan by source tx hash). */
  status?: (sourceTxHash: string) => Promise<SwidgeStatusResult>;
  /** Optional chain-pair capability gate for discovery and auction. */
  supportsRoute?: (fromChain: string, toChain?: string | number) => boolean;
}

/** Default delivery check: the public LayerZero Scan API, no key required. */
async function lzScanStatus(sourceTxHash: string): Promise<SwidgeStatusResult> {
  try {
    const res = await fetch(`https://scan.layerzero-api.com/v1/messages/tx/${encodeURIComponent(sourceTxHash)}`, {
      signal: timeoutSignal(8000),
    });
    if (!res.ok) return {status: "pending"};
    const j = (await res.json()) as {data?: {status?: {name?: string}; destination?: {tx?: {txHash?: string}}}[]};
    const msg = j.data?.[0];
    const name = msg?.status?.name?.toUpperCase() ?? "";
    const destTx = msg?.destination?.tx?.txHash;
    if (name === "DELIVERED")
      return destTx
        ? {status: "completed", transactions: [{hash: destTx, type: "destination"}]}
        : {status: "completed"};
    if (name === "FAILED" || name === "BLOCKED") return {status: "failed"};
    return {status: "pending"};
  } catch {
    return {status: "pending"};
  }
}

export function bridgeModuleAdapter(opts: BridgeModuleAdapterOptions): ExternalSwidgeModule {
  const eta = opts.estimatedDuration ?? 180;
  if (!Number.isFinite(eta) || eta < 0) throw new Error(`${opts.name}: estimatedDuration must be a non-negative finite number`);
  const native = opts.nativeSymbol ?? "native";
  const checkStatus = opts.status ?? lzScanStatus;

  function toBridgeOptions(options: SwidgeOptions): {
    targetChain: string;
    recipient: string;
    token: string;
    amount: bigint;
  } | null {
    const token = opts.bridgeableToken(options);
    if (!token) return null;
    const targetChain = options.toChain != null ? opts.chainKey(options.toChain) : null;
    if (!targetChain || !options.recipient || options.fromTokenAmount == null) return null;
    let amount: bigint;
    try { amount = BigInt(options.fromTokenAmount); } catch { return null; }
    if (amount <= 0n) return null;
    return {targetChain, recipient: options.recipient, token, amount};
  }

  const protocol: ExternalSwidgeProtocol = {
    async quoteSwidge(options: SwidgeOptions): Promise<SwidgeQuote> {
      const bridge = toBridgeOptions(options);
      if (!bridge) throw new Error(`${opts.name}: pair is not a same-token bridge route`);
      const q = await opts.protocol.quoteBridge(bridge);
      return {
        fromTokenAmount: bridge.amount,
        toTokenAmount: bridge.amount, // OFT burn/mint — 1:1
        toTokenAmountMin: bridge.amount,
        fees: [
          {type: "network", amount: q.fee, token: native, included: false, description: "source gas"},
          {type: "protocol", amount: q.bridgeFee, token: native, included: false, description: "bridge fee (native)"},
        ],
        estimatedDuration: eta,
      };
    },

    async swidge(options: SwidgeOptions): Promise<SwidgeResult> {
      const bridge = toBridgeOptions(options);
      if (!bridge) throw new Error(`${opts.name}: pair is not a same-token bridge route`);
      const r = await opts.protocol.bridge(bridge);
      return {
        id: r.hash, // the source tx hash IS the durable id (LZ scan keys on it)
        hash: r.hash,
        fees: [
          {type: "network", amount: r.fee, token: native, included: false},
          {type: "protocol", amount: r.bridgeFee, token: native, included: false},
        ],
        fromTokenAmount: bridge.amount,
        toTokenAmount: bridge.amount,
        toTokenAmountMin: bridge.amount,
        transactions: [{hash: r.hash, type: "source"}],
      };
    },

    getSwidgeStatus(id: string): Promise<SwidgeStatusResult> {
      return checkStatus(id);
    },

    async getSupportedChains(): Promise<SwidgeSupportedChain[]> {
      return opts.protocol.getSupportedChains?.() ?? [];
    },

    async getSupportedTokens(o?: SwidgeSupportedTokensOptions): Promise<SwidgeSupportedToken[]> {
      return opts.protocol.getSupportedTokens?.(o) ?? [];
    },
  };

  // Identity mapOptions: the adapter does its own chain-key mapping — the
  // aggregator's default eip155→number rewrite would fight `chainKey`.
  return {
    name: opts.name,
    protocol,
    mapOptions: (o) => o,
    accountAddress: opts.accountAddress,
    ...(opts.supportsRoute ? {supportsRoute: opts.supportsRoute} : {}),
  };
}

/**
 * A module registered for STATUS RESOLUTION ONLY — it declines every route.
 *
 * Module swaps carry a `awk1.mod~<name>.<id>` status id, and the aggregator
 * refuses to resolve one for a module it has no registration for. A consumer
 * that polls delivery away from the wallet — a server cron, a worker — cannot
 * build the real module there, because the real module is bound to the user's
 * account. Without a registration of some kind, a swap that has already been
 * delivered reads `pending` forever.
 *
 * Delivery tracking usually needs neither account nor key (LayerZero Scan and
 * LI.FI's `/status` both take a source transaction hash), so this registers
 * exactly that much: no account, no quoting, nothing that could win a route.
 * Put it on a router built WITHOUT an account — that is all status needs.
 */
export function statusOnlyModule(opts: {
  name: string;
  /** Delivery check by source transaction hash (default: LayerZero Scan). */
  status?: (sourceTxHash: string) => Promise<SwidgeStatusResult>;
}): ExternalSwidgeModule {
  const unroutable = (): never => {
    throw new Error(`${opts.name}: registered for status resolution only`);
  };
  const {accountAddress: _unbound, ...module} = bridgeModuleAdapter({
    name: opts.name,
    protocol: {quoteBridge: unroutable, bridge: unroutable},
    chainKey: () => null,
    bridgeableToken: () => null, // declines every pair — it can never be auctioned
    // Dropped again immediately below: this module signs nothing, and having no
    // account is what stops it being registered on an account-bound router.
    accountAddress: () => {
      throw new Error(`${opts.name}: registered for status resolution only`);
    },
    ...(opts.status ? {status: opts.status} : {}),
  });
  return module;
}
