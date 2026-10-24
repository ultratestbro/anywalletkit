// Base class: every method throws NotImplementedError so a module that forgets
// one fails loudly, never with `undefined is not a function`.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'
import type { BridgeOptions, BridgeQuote, BridgeResult, IBridgeProtocol } from './bridge.js'
import type { ISwapProtocol, SwapOptions, SwapQuote, SwapResult } from './swap.js'

/**
 * Where a swap is. `action-required` means the user must act (a CCTP claim on the destination
 * chain); `partial` means only part of the amount was delivered; `refund-pending` and `refunded`
 * cover a failed cross-chain leg that sends the input back.
 */
export type Swap2Status =
  | 'pending' | 'action-required' | 'completed' | 'failed'
  | 'refund-pending' | 'refunded' | 'cancelled' | 'expired' | 'partial'
/** Who takes a fee: the network (gas), the protocol or bridge, an affiliate, or something else. */
export type Swap2FeeType = 'network' | 'protocol' | 'affiliate' | 'other'

/** Fee ceilings checked before a swap is signed. A quote above either ceiling is refused. */
export interface Swap2ProtocolConfig {
  /** Maximum acceptable network fee, basis points of the input amount. */
  maxNetworkFeeBps?: bigint | number
  /** Maximum acceptable protocol fee, basis points of the input amount. */
  maxProtocolFeeBps?: bigint | number
}

/** What every swap names: the tokens, the destination chain and who receives. */
export interface Swap2CommonOptions {
  /**
   * Token on the source chain: contract, mint or jetton address, or a catalog symbol such as
   * `'USDC'`.
   */
  fromToken: string
  /** Token on the destination chain, in the same forms. */
  toToken: string
  /** Destination chain. Omitted = same-chain swap. */
  toChain?: string | number
  /**
   * Who receives on the destination chain. Defaults to the swapping account's address on that chain
   * when the provider can derive it.
   */
  recipient?: string
  /** Where a failed cross-chain swap sends the input back. Defaults to the source address. */
  refundAddress?: string
  /** Decimal, 0.01 = 1 %. */
  slippage?: number
  /** Minimum acceptable destination amount, base units (overrides slippage when set). */
  minAmountOut?: bigint | number
}
/** Sell exactly `fromTokenAmount` (base units). */
export interface Swap2ExactInOptions { fromTokenAmount: bigint | number; toTokenAmount?: never }
/**
 * Receive exactly `toTokenAmount` (base units); only providers that quote exact output accept it.
 */
export interface Swap2ExactOutOptions { fromTokenAmount?: never; toTokenAmount: bigint | number }
/** One swap request: the common fields plus either an exact input or an exact output amount. */
export type Swap2Options = Swap2CommonOptions & (Swap2ExactInOptions | Swap2ExactOutOptions)

/** One fee in a quote or result. */
export interface Swap2Fee {
  /** Who takes it. */
  type: Swap2FeeType
  /** Amount in `token`'s base units. */
  amount: bigint
  /** Token the fee is paid in. */
  token: string
  /** Chain the fee is paid on, when it is not the source chain. */
  chain?: string | number
  /** Already included in the quoted amounts. */
  included?: boolean
  description?: string
}

/** One on-chain transaction that belongs to a swap. */
export interface Swap2Transaction {
  /** Transaction hash. */
  hash: string
  /** Chain it is on. */
  chain?: string | number
  /** Its role in the swap. */
  type?: 'source' | 'destination' | 'approval' | 'refund' | 'other'
}

/** A price for a swap, before anything is signed. Amounts in base units. */
export interface Swap2Quote {
  /** What leaves the wallet. */
  fromTokenAmount: bigint
  /** Expected delivery. */
  toTokenAmount: bigint
  /** Least the swap may deliver after slippage; below it the swap reverts or refunds. */
  toTokenAmountMin: bigint
  /** Every fee, network and protocol. */
  fees: Swap2Fee[]
  /** Seconds. */
  estimatedDuration?: number
  /** Unix seconds. */
  expiry?: number
  /** Decimal, 0.01 = 1 %. */
  priceImpact?: number
}

/**
 * What `swap2()` returns once the source transaction is broadcast. Delivery on another chain comes
 * later; poll {@link ISwap2Protocol.getSwap2Status}.
 */
export interface Swap2Result {
  /** Id to pass to `getSwap2Status`; for a same-chain swap, the transaction hash. */
  id: string
  /** Source transaction hash. */
  hash?: string
  /** Fees as quoted at execution. */
  fees: Swap2Fee[]
  /** Every transaction sent so far (approval, source). */
  transactions?: Swap2Transaction[]
  /** Input amount, base units. */
  fromTokenAmount: bigint
  /** Expected delivery, base units. */
  toTokenAmount: bigint
  /** Least delivery after slippage. */
  toTokenAmountMin?: bigint
}

/** Chains of the swap, for providers that need them to look a swap up. */
export interface Swap2StatusOptions { fromChain?: string | number; toChain?: string | number }
/** A swap's state and the transactions seen so far (source, destination, refund). */
export interface Swap2StatusResult { status: Swap2Status; transactions?: Swap2Transaction[] }

/** A chain a provider can swap on or to. */
export interface Swap2SupportedChain { id: string | number; name: string; type: string; nativeToken: string }
/** A token a provider can swap. */
export interface Swap2SupportedToken {
  /** Identifier to pass as `fromToken` / `toToken`. */
  token: string
  /** Chain it is on. */
  chain: string | number
  /** Ticker. */
  symbol: string
  /** Decimals of its base unit. */
  decimals: number
  address?: string
  name?: string
}
/** Narrow the token list: tokens reachable from `fromChain` / `fromToken`, or on `toChain`. */
export interface Swap2SupportedTokensOptions { fromChain?: string | number; fromToken?: string; toChain?: string | number }

/**
 * The swap-and-bridge interface every swap module implements, and the router too. One call shape
 * covers same-chain swaps and cross-chain transfers.
 */
export interface ISwap2Protocol {
  /**
   * Price a swap. Signs nothing and works on a read-only account.
   *
   * @throws `Swap2QuoteError` (from `protocol-swap2-core`) with a named reason when there is no
   * route.
   */
  quoteSwap2(options: Swap2Options): Promise<Swap2Quote>
  /**
   * Quote again, check the quote (amounts, recipient, refund address, fee ceilings in `config`),
   * then sign and broadcast the source transaction (and an approval when one is needed).
   */
  swap2(options: Swap2Options, config?: Swap2ProtocolConfig): Promise<Swap2Result>
  /** State of a swap by the `id` from {@link Swap2Result}. Poll it until a final status. */
  getSwap2Status(id: string, options?: Swap2StatusOptions): Promise<Swap2StatusResult>
  /** Chains this provider can swap on or to. */
  getSupportedChains(): Promise<Swap2SupportedChain[]>
  /** Tokens this provider can swap, optionally narrowed by {@link Swap2SupportedTokensOptions}. */
  getSupportedTokens(options?: Swap2SupportedTokensOptions): Promise<Swap2SupportedToken[]>
}

const sum = (fees: Swap2Fee[], type?: Swap2FeeType): bigint =>
  fees.filter((f) => type === undefined || f.type === type).reduce((acc, f) => acc + f.amount, 0n)

/**
 * Swap + bridge in one. `swap` and `bridge` are derived from `swap2`, so a
 * swap2 module is automatically a swap and a bridge module.
 */
export class Swap2Protocol<TConfig extends Swap2ProtocolConfig = Swap2ProtocolConfig>
  extends ProtocolBase<TConfig>
  implements ISwap2Protocol, ISwapProtocol, IBridgeProtocol
{
  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: TConfig = {} as TConfig) {
    super(account, config)
  }

  /** The older same-chain `swap`, run through {@link Swap2Protocol.swap2}. */
  async swap(options: SwapOptions): Promise<SwapResult> {
    const r = await this.swap2(toSwap2Options(options))
    return { hash: r.id, fee: sum(r.fees), tokenInAmount: r.fromTokenAmount, tokenOutAmount: r.toTokenAmount }
  }
  /** The older `quoteSwap`, run through `quoteSwap2`. */
  async quoteSwap(options: SwapOptions): Promise<SwapQuote> {
    const r = await this.quoteSwap2(toSwap2Options(options))
    return { fee: sum(r.fees), tokenInAmount: r.fromTokenAmount, tokenOutAmount: r.toTokenAmount }
  }
  /** The older `bridge`, run through `swap2` with the same token on both chains. */
  async bridge(options: BridgeOptions): Promise<BridgeResult> {
    const { id: hash, fees } = await this.swap2(toBridgeSwap2Options(options))
    return { hash, fee: sum(fees, 'network'), bridgeFee: sum(fees, 'protocol') }
  }
  /** The older `quoteBridge`, run through `quoteSwap2`. */
  async quoteBridge(options: BridgeOptions): Promise<BridgeQuote> {
    const { fees } = await this.quoteSwap2(toBridgeSwap2Options(options))
    return { fee: sum(fees, 'network'), bridgeFee: sum(fees, 'protocol') }
  }

  async quoteSwap2(_options: Swap2Options): Promise<Swap2Quote> { throw new NotImplementedError('quoteSwap2(options)') }
  async swap2(_options: Swap2Options, _config?: Swap2ProtocolConfig): Promise<Swap2Result> { throw new NotImplementedError('swap2(options, config)') }
  async getSwap2Status(_id: string, _options?: Swap2StatusOptions): Promise<Swap2StatusResult> { throw new NotImplementedError('getSwap2Status(id, options)') }
  async getSupportedChains(): Promise<Swap2SupportedChain[]> { throw new NotImplementedError('getSupportedChains()') }
  async getSupportedTokens(_options?: Swap2SupportedTokensOptions): Promise<Swap2SupportedToken[]> { throw new NotImplementedError('getSupportedTokens(options)') }
}

function toSwap2Options(o: SwapOptions): Swap2Options {
  const base: Swap2CommonOptions = { fromToken: o.tokenIn, toToken: o.tokenOut, ...(o.to !== undefined ? { recipient: o.to } : {}), ...(o.minAmountOut !== undefined ? { minAmountOut: o.minAmountOut } : {}) }
  return o.tokenInAmount !== undefined
    ? { ...base, fromTokenAmount: o.tokenInAmount }
    : { ...base, toTokenAmount: o.tokenOutAmount as bigint | number }
}
function toBridgeSwap2Options(o: BridgeOptions): Swap2Options {
  return { fromToken: o.token, toToken: o.token, toChain: o.targetChain, recipient: o.recipient, fromTokenAmount: o.amount }
}
