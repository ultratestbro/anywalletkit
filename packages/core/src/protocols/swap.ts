// Base class: every method throws NotImplementedError so a module that forgets
// one fails loudly, never with `undefined is not a function`.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'

export interface SwapProtocolConfig {
  /** Maximum fee for swap operations, in native base units. */
  swapMaxFee?: bigint | number
}

export interface SwapCommonOptions {
  tokenIn: string
  tokenOut: string
  /** Receiver of the output tokens. Defaults to the account itself. */
  to?: string
  /** Minimum acceptable output amount, base units. */
  minAmountOut?: bigint | number
}
export interface SwapBuyOptions { tokenInAmount?: never; tokenOutAmount: bigint | number }
export interface SwapSellOptions { tokenInAmount: bigint | number; tokenOutAmount?: never }
export type SwapOptions = SwapCommonOptions & (SwapBuyOptions | SwapSellOptions)

export interface SwapResult {
  hash: string
  /** Gas cost. */
  fee: bigint
  tokenInAmount: bigint
  tokenOutAmount: bigint
}
export type SwapQuote = Omit<SwapResult, 'hash'>

export interface ISwapProtocol {
  swap(options: SwapOptions): Promise<SwapResult>
  quoteSwap(options: SwapOptions): Promise<SwapQuote>
}

export class SwapProtocol<TConfig extends SwapProtocolConfig = SwapProtocolConfig>
  extends ProtocolBase<TConfig>
  implements ISwapProtocol
{
  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: TConfig = {} as TConfig) {
    super(account, config)
  }
  async swap(_options: SwapOptions): Promise<SwapResult> { throw new NotImplementedError('swap(options)') }
  async quoteSwap(_options: SwapOptions): Promise<SwapQuote> { throw new NotImplementedError('quoteSwap(options)') }
}
