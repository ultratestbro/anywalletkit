// Base class: every method throws NotImplementedError so a module that forgets
// one fails loudly, never with `undefined is not a function`.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'
import type { BridgeOptions, BridgeQuote, BridgeResult, IBridgeProtocol } from './bridge.js'
import type { ISwapProtocol, SwapOptions, SwapQuote, SwapResult } from './swap.js'

export type Swap2Status =
  | 'pending' | 'action-required' | 'completed' | 'failed'
  | 'refund-pending' | 'refunded' | 'cancelled' | 'expired' | 'partial'
export type Swap2FeeType = 'network' | 'protocol' | 'affiliate' | 'other'

export interface Swap2ProtocolConfig {
  /** Maximum acceptable network fee, basis points of the input amount. */
  maxNetworkFeeBps?: bigint | number
  /** Maximum acceptable protocol fee, basis points of the input amount. */
  maxProtocolFeeBps?: bigint | number
}

export interface Swap2CommonOptions {
  fromToken: string
  toToken: string
  /** Destination chain. Omitted = same-chain swap. */
  toChain?: string | number
  recipient?: string
  refundAddress?: string
  /** Decimal, 0.01 = 1 %. */
  slippage?: number
  /** Minimum acceptable destination amount, base units (overrides slippage when set). */
  minAmountOut?: bigint | number
}
export interface Swap2ExactInOptions { fromTokenAmount: bigint | number; toTokenAmount?: never }
export interface Swap2ExactOutOptions { fromTokenAmount?: never; toTokenAmount: bigint | number }
export type Swap2Options = Swap2CommonOptions & (Swap2ExactInOptions | Swap2ExactOutOptions)

export interface Swap2Fee {
  type: Swap2FeeType
  amount: bigint
  token: string
  chain?: string | number
  /** Already included in the quoted amounts. */
  included?: boolean
  description?: string
}

export interface Swap2Transaction {
  hash: string
  chain?: string | number
  type?: 'source' | 'destination' | 'approval' | 'refund' | 'other'
}

export interface Swap2Quote {
  fromTokenAmount: bigint
  toTokenAmount: bigint
  toTokenAmountMin: bigint
  fees: Swap2Fee[]
  /** Seconds. */
  estimatedDuration?: number
  /** Unix seconds. */
  expiry?: number
  /** Decimal, 0.01 = 1 %. */
  priceImpact?: number
}

export interface Swap2Result {
  id: string
  hash?: string
  fees: Swap2Fee[]
  transactions?: Swap2Transaction[]
  fromTokenAmount: bigint
  toTokenAmount: bigint
  toTokenAmountMin?: bigint
}

export interface Swap2StatusOptions { fromChain?: string | number; toChain?: string | number }
export interface Swap2StatusResult { status: Swap2Status; transactions?: Swap2Transaction[] }

export interface Swap2SupportedChain { id: string | number; name: string; type: string; nativeToken: string }
export interface Swap2SupportedToken {
  token: string
  chain: string | number
  symbol: string
  decimals: number
  address?: string
  name?: string
}
export interface Swap2SupportedTokensOptions { fromChain?: string | number; fromToken?: string; toChain?: string | number }

export interface ISwap2Protocol {
  quoteSwap2(options: Swap2Options): Promise<Swap2Quote>
  swap2(options: Swap2Options, config?: Swap2ProtocolConfig): Promise<Swap2Result>
  getSwap2Status(id: string, options?: Swap2StatusOptions): Promise<Swap2StatusResult>
  getSupportedChains(): Promise<Swap2SupportedChain[]>
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

  async swap(options: SwapOptions): Promise<SwapResult> {
    const r = await this.swap2(toSwap2Options(options))
    return { hash: r.id, fee: sum(r.fees), tokenInAmount: r.fromTokenAmount, tokenOutAmount: r.toTokenAmount }
  }
  async quoteSwap(options: SwapOptions): Promise<SwapQuote> {
    const r = await this.quoteSwap2(toSwap2Options(options))
    return { fee: sum(r.fees), tokenInAmount: r.fromTokenAmount, tokenOutAmount: r.toTokenAmount }
  }
  async bridge(options: BridgeOptions): Promise<BridgeResult> {
    const { id: hash, fees } = await this.swap2(toBridgeSwap2Options(options))
    return { hash, fee: sum(fees, 'network'), bridgeFee: sum(fees, 'protocol') }
  }
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
