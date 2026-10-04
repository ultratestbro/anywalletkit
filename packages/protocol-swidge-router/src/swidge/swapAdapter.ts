/**
 * Adapts an `ISwapProtocol` module (e.g. the Velora
 * aggregator on EVM) into
 * an {@link ExternalSwidgeModule} the aggregator can auction.
 *
 * A swap module is SAME-CHAIN by construction: `SwapOptions` has no
 * destination chain at all, so the adapter declines every pair whose `toChain`
 * is not the account's own chain rather than letting a cross-chain request
 * quote as if the tokens lived in one place.
 *
 * Two contract mismatches this bridges, both of which decide whether a route is
 * safe to execute:
 *
 * - **No guaranteed floor in the quote.** `quoteSwap` reports the expected
 *   output and nothing else, while `SwidgeQuote` must carry a
 *   `toTokenAmountMin` the caller can hold the execution to. The adapter
 *   derives it from what the CALLER asked for — `minAmountOut` when given,
 *   otherwise the quoted output less `slippage` (per call, else the adapter's
 *   `defaultSlippage`) — and passes that same floor into `swap()`, so the
 *   number quoted is the number the swap itself enforces on chain.
 *
 * - **No status surface.** `ISwapProtocol` has no `getSwapStatus`; the source
 *   transaction IS the swap. Supply `status` (a receipt lookup) — the default
 *   only ever answers `pending`, because a same-chain swap whose receipt was
 *   never read is exactly as likely to have reverted as to have filled.
 */
import type {
  SwidgeOptions,
  SwidgeProtocolConfig,
  SwidgeQuote,
  SwidgeResult,
  SwidgeStatusResult,
  SwidgeSupportedChain,
  SwidgeSupportedToken,
  SwidgeSupportedTokensOptions,
} from "@forgewallet/core";
import type {ExternalSwidgeModule, ExternalSwidgeProtocol} from "./router.js";

/** Structural view of an `ISwapProtocol` module. */
export interface SwapProtocolLike {
  quoteSwap(options: {
    tokenIn: string;
    tokenOut: string;
    tokenInAmount: number | bigint;
    minAmountOut?: number | bigint;
    to?: string;
  }): Promise<{fee: bigint; tokenInAmount: bigint; tokenOutAmount: bigint}>;
  swap(
    options: {
      tokenIn: string;
      tokenOut: string;
      tokenInAmount: number | bigint;
      minAmountOut?: number | bigint;
      to?: string;
    },
    config?: unknown,
  ): Promise<{hash: string; fee: bigint; tokenInAmount: bigint; tokenOutAmount: bigint}>;
  getSupportedChains?(): Promise<SwidgeSupportedChain[]>;
  getSupportedTokens?(options?: SwidgeSupportedTokensOptions): Promise<SwidgeSupportedToken[]>;
}

export interface SwapModuleAdapterOptions {
  /** Stable name for ids/status routing (e.g. "velora"). No dots. */
  name: string;
  protocol: SwapProtocolLike;
  /** CAIP-2 chain the module's account lives on — the only chain it can serve. */
  chain: string;
  /**
   * The account this module's protocol was constructed for. Required: a swap
   * signs through a bound account, and the aggregator refuses to register a
   * module that cannot name one.
   */
  accountAddress: string | (() => string | Promise<string>);
  /** Native-token symbol the gas fee is denominated in (display only). */
  nativeSymbol?: string;
  /** Floor to apply when the caller supplies neither `minAmountOut` nor `slippage`. */
  defaultSlippage?: number;
  /** ETA hint in seconds (default 30 — one same-chain transaction). */
  estimatedDuration?: number;
  /** Receipt lookup by source transaction hash. Without it, status is `pending`. */
  status?: (sourceTxHash: string) => Promise<SwidgeStatusResult>;
  /** Map the module's token identifiers (default: pass through). */
  mapToken?: (token: string) => string;
}

/** Same-chain gate: callers write `toChain` as CAIP-2 or as a numeric id. */
function sameChain(chain: string, toChain: string | number | undefined): boolean {
  if (toChain === undefined || toChain === null || toChain === "") return true;
  const want = String(toChain);
  if (want === chain) return true;
  return /^\d+$/.test(want) && `eip155:${want}` === chain;
}

export function swapModuleAdapter(opts: SwapModuleAdapterOptions): ExternalSwidgeModule {
  const eta = opts.estimatedDuration ?? 30;
  if (!Number.isFinite(eta) || eta < 0) {
    throw new Error(`${opts.name}: estimatedDuration must be a non-negative finite number`);
  }
  const defaultSlippage = opts.defaultSlippage ?? 0.005;
  if (!Number.isFinite(defaultSlippage) || defaultSlippage < 0 || defaultSlippage >= 1) {
    throw new Error(`${opts.name}: defaultSlippage must be a fraction in [0, 1)`);
  }
  const native = opts.nativeSymbol ?? "native";
  const mapToken = opts.mapToken ?? ((t: string) => t);

  function toSwapOptions(options: SwidgeOptions): {
    tokenIn: string;
    tokenOut: string;
    tokenInAmount: bigint;
    to?: string;
  } {
    if (!sameChain(opts.chain, options.toChain)) {
      throw new Error(`${opts.name}: swap modules are same-chain only (${opts.chain})`);
    }
    if (options.fromTokenAmount == null) {
      // `toTokenAmount` set instead: an exact-out request the engine cannot serve.
      throw new Error(`${opts.name}: exact-out is not supported`);
    }
    const tokenInAmount = BigInt(options.fromTokenAmount);
    if (tokenInAmount <= 0n) throw new Error(`${opts.name}: fromTokenAmount must be positive`);
    if (typeof options.fromToken !== "string" || typeof options.toToken !== "string") {
      throw new Error(`${opts.name}: both tokens must be given as identifiers`);
    }
    return {
      tokenIn: mapToken(options.fromToken),
      tokenOut: mapToken(options.toToken),
      tokenInAmount,
      ...(options.recipient ? {to: options.recipient} : {}),
    };
  }

  /** The floor the caller is entitled to — and the one `swap()` enforces. */
  function floorFor(options: SwidgeOptions, quotedOut: bigint): bigint {
    if (options.minAmountOut !== undefined) {
      const floor = BigInt(options.minAmountOut);
      if (floor <= 0n) throw new Error(`${opts.name}: minAmountOut must be a positive integer`);
      return floor;
    }
    const slippage = options.slippage ?? defaultSlippage;
    if (!Number.isFinite(slippage) || slippage < 0 || slippage >= 1) {
      throw new Error(`${opts.name}: slippage must be a fraction in [0, 1)`);
    }
    const scale = 1_000_000_000n;
    const permitted = BigInt(Math.floor(slippage * Number(scale)));
    // Round UP, so the derived floor never sits below what the caller's own
    // slippage bound would compute from the same quote.
    const floor = (quotedOut * (scale - permitted) + scale - 1n) / scale;
    return floor > 0n ? floor : 1n;
  }

  const protocol: ExternalSwidgeProtocol = {
    async quoteSwidge(options: SwidgeOptions): Promise<SwidgeQuote> {
      const swap = toSwapOptions(options);
      const q = await opts.protocol.quoteSwap(swap);
      if (q.tokenOutAmount <= 0n) throw new Error(`${opts.name}: quote returned no output`);
      const floor = floorFor(options, q.tokenOutAmount);
      if (floor > q.tokenOutAmount) throw new Error(`${opts.name}: quote is below the requested floor`);
      return {
        fromTokenAmount: swap.tokenInAmount,
        toTokenAmount: q.tokenOutAmount,
        toTokenAmountMin: floor,
        fees: [{type: "network", amount: q.fee, token: native, included: false, description: "source gas"}],
        estimatedDuration: eta,
      };
    },

    async swidge(options: SwidgeOptions, config?: SwidgeProtocolConfig): Promise<SwidgeResult> {
      const swap = toSwapOptions(options);
      // Re-quote to price the floor the swap will carry on chain. The
      // aggregator re-checks the result against the auction quote afterwards,
      // so a market that moved between the two cannot slip past the floor.
      const q = await opts.protocol.quoteSwap(swap);
      const floor = floorFor(options, q.tokenOutAmount);
      const r = await opts.protocol.swap({...swap, minAmountOut: floor}, config);
      if (!r.hash) throw new Error(`${opts.name}: swap returned no transaction hash`);
      return {
        id: r.hash, // the source tx IS the swap — its hash is the durable id
        hash: r.hash,
        fees: [{type: "network", amount: r.fee, token: native, included: false}],
        fromTokenAmount: r.tokenInAmount,
        toTokenAmount: r.tokenOutAmount,
        toTokenAmountMin: floor,
        transactions: [{hash: r.hash, chain: opts.chain, type: "source"}],
      };
    },

    async getSwidgeStatus(id: string): Promise<SwidgeStatusResult> {
      if (opts.status) return opts.status(id);
      return {status: "pending", transactions: [{hash: id, chain: opts.chain, type: "source"}]};
    },

    async getSupportedChains(): Promise<SwidgeSupportedChain[]> {
      return opts.protocol.getSupportedChains?.() ?? [];
    },

    async getSupportedTokens(o?: SwidgeSupportedTokensOptions): Promise<SwidgeSupportedToken[]> {
      return opts.protocol.getSupportedTokens?.(o) ?? [];
    },
  };

  return {
    name: opts.name,
    protocol,
    // Identity: the adapter reads `toChain` itself for the same-chain gate, and
    // the aggregator's default eip155→number rewrite would only hide it.
    mapOptions: (o) => o,
    accountAddress: opts.accountAddress,
    supportsRoute: (fromChain, toChain) => fromChain === opts.chain && sameChain(opts.chain, toChain),
  };
}
