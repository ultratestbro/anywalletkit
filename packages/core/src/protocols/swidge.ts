// Base class: every method throws NotImplementedError so a module that forgets
// one fails loudly, never with `undefined is not a function`.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'
import type { BridgeOptions, BridgeQuote, BridgeResult, IBridgeProtocol } from './bridge.js'
import type { ISwapProtocol, SwapOptions, SwapQuote, SwapResult } from './swap.js'

export type SwidgeStatus =
  | 'pending' | 'action-required' | 'completed' | 'failed'
  | 'refund-pending' | 'refunded' | 'cancelled' | 'expired' | 'partial'
export type SwidgeFeeType = 'network' | 'protocol' | 'affiliate' | 'other'

export interface SwidgeProtocolConfig {
  /** Maximum acceptable network fee, basis points of the input amount. */
  maxNetworkFeeBps?: bigint | number
  /** Maximum acceptable protocol fee, basis points of the input amount. */
  maxProtocolFeeBps?: bigint | number
}

export interface SwidgeCommonOptions {
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
export interface SwidgeExactInOptions { fromTokenAmount: bigint | number; toTokenAmount?: never }
export interface SwidgeExactOutOptions { fromTokenAmount?: never; toTokenAmount: bigint | number }
export type SwidgeOptions = SwidgeCommonOptions & (SwidgeExactInOptions | SwidgeExactOutOptions)

export interface SwidgeFee {
  type: SwidgeFeeType
  amount: bigint
  token: string
  chain?: string | number
  /** Already included in the quoted amounts. */
  included?: boolean
  description?: string
}

export interface SwidgeTransaction {
  hash: string
  chain?: string | number
  type?: 'source' | 'destination' | 'approval' | 'refund' | 'other'
}

export interface SwidgeQuote {
  fromTokenAmount: bigint
  toTokenAmount: bigint
  toTokenAmountMin: bigint
  fees: SwidgeFee[]
  /** Seconds. */
  estimatedDuration?: number
  /** Unix seconds. */
  expiry?: number
  /** Decimal, 0.01 = 1 %. */
  priceImpact?: number
}

export interface SwidgeResult {
  id: string
  hash?: string
  fees: SwidgeFee[]
  transactions?: SwidgeTransaction[]
  fromTokenAmount: bigint
  toTokenAmount: bigint
  toTokenAmountMin?: bigint
}

export interface SwidgeStatusOptions { fromChain?: string | number; toChain?: string | number }
export interface SwidgeStatusResult { status: SwidgeStatus; transactions?: SwidgeTransaction[] }

export interface SwidgeSupportedChain { id: string | number; name: string; type: string; nativeToken: string }
export interface SwidgeSupportedToken {
  token: string
  chain: string | number
  symbol: string
  decimals: number
  address?: string
  name?: string
}
export interface SwidgeSupportedTokensOptions { fromChain?: string | number; fromToken?: string; toChain?: string | number }

export interface ISwidgeProtocol {
  quoteSwidge(options: SwidgeOptions): Promise<SwidgeQuote>
  swidge(options: SwidgeOptions, config?: SwidgeProtocolConfig): Promise<SwidgeResult>
  getSwidgeStatus(id: string, options?: SwidgeStatusOptions): Promise<SwidgeStatusResult>
  getSupportedChains(): Promise<SwidgeSupportedChain[]>
  getSupportedTokens(options?: SwidgeSupportedTokensOptions): Promise<SwidgeSupportedToken[]>
}

const sum = (fees: SwidgeFee[], type?: SwidgeFeeType): bigint =>
  fees.filter((f) => type === undefined || f.type === type).reduce((acc, f) => acc + f.amount, 0n)

/**
 * Swap + bridge in one. `swap` and `bridge` are derived from `swidge` exactly
 * so a swidge module is automatically a swap and a bridge module.
 */
export class SwidgeProtocol<TConfig extends SwidgeProtocolConfig = SwidgeProtocolConfig>
  extends ProtocolBase<TConfig>
  implements ISwidgeProtocol, ISwapProtocol, IBridgeProtocol
{
  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: TConfig = {} as TConfig) {
    super(account, config)
  }

  async swap(options: SwapOptions): Promise<SwapResult> {
    const r = await this.swidge(toSwidgeOptions(options))
    return { hash: r.id, fee: sum(r.fees), tokenInAmount: r.fromTokenAmount, tokenOutAmount: r.toTokenAmount }
  }
  async quoteSwap(options: SwapOptions): Promise<SwapQuote> {
    const r = await this.quoteSwidge(toSwidgeOptions(options))
    return { fee: sum(r.fees), tokenInAmount: r.fromTokenAmount, tokenOutAmount: r.toTokenAmount }
  }
  async bridge(options: BridgeOptions): Promise<BridgeResult> {
    const { id: hash, fees } = await this.swidge(toBridgeSwidgeOptions(options))
    return { hash, fee: sum(fees, 'network'), bridgeFee: sum(fees, 'protocol') }
  }
  async quoteBridge(options: BridgeOptions): Promise<BridgeQuote> {
    const { fees } = await this.quoteSwidge(toBridgeSwidgeOptions(options))
    return { fee: sum(fees, 'network'), bridgeFee: sum(fees, 'protocol') }
  }

  async quoteSwidge(_options: SwidgeOptions): Promise<SwidgeQuote> { throw new NotImplementedError('quoteSwidge(options)') }
  async swidge(_options: SwidgeOptions, _config?: SwidgeProtocolConfig): Promise<SwidgeResult> { throw new NotImplementedError('swidge(options, config)') }
  async getSwidgeStatus(_id: string, _options?: SwidgeStatusOptions): Promise<SwidgeStatusResult> { throw new NotImplementedError('getSwidgeStatus(id, options)') }
  async getSupportedChains(): Promise<SwidgeSupportedChain[]> { throw new NotImplementedError('getSupportedChains()') }
  async getSupportedTokens(_options?: SwidgeSupportedTokensOptions): Promise<SwidgeSupportedToken[]> { throw new NotImplementedError('getSupportedTokens(options)') }
}

function toSwidgeOptions(o: SwapOptions): SwidgeOptions {
  const base: SwidgeCommonOptions = { fromToken: o.tokenIn, toToken: o.tokenOut, ...(o.to !== undefined ? { recipient: o.to } : {}), ...(o.minAmountOut !== undefined ? { minAmountOut: o.minAmountOut } : {}) }
  return o.tokenInAmount !== undefined
    ? { ...base, fromTokenAmount: o.tokenInAmount }
    : { ...base, toTokenAmount: o.tokenOutAmount as bigint | number }
}
function toBridgeSwidgeOptions(o: BridgeOptions): SwidgeOptions {
  return { fromToken: o.token, toToken: o.token, toChain: o.targetChain, recipient: o.recipient, fromTokenAmount: o.amount }
}
