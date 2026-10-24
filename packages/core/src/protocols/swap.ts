// Base class: every method throws NotImplementedError so a module that forgets
// one fails loudly, never with `undefined is not a function`.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'

/** Fee ceiling for {@link ISwapProtocol.swap}. */
export interface SwapProtocolConfig {
  /** Maximum fee for swap operations, in native base units. */
  swapMaxFee?: bigint | number
}

/** Tokens of a same-chain swap and who receives. */
export interface SwapCommonOptions {
  tokenIn: string
  tokenOut: string
  /** Receiver of the output tokens. Defaults to the account itself. */
  to?: string
  /** Minimum acceptable output amount, base units. */
  minAmountOut?: bigint | number
}
/** Receive exactly `tokenOutAmount`. */
export interface SwapBuyOptions { tokenInAmount?: never; tokenOutAmount: bigint | number }
/** Sell exactly `tokenInAmount`. */
export interface SwapSellOptions { tokenInAmount: bigint | number; tokenOutAmount?: never }
/** A same-chain swap with an exact input or an exact output. */
export type SwapOptions = SwapCommonOptions & (SwapBuyOptions | SwapSellOptions)

/** The swap transaction, its fee and amounts. */
export interface SwapResult {
  hash: string
  /** Gas cost. */
  fee: bigint
  tokenInAmount: bigint
  tokenOutAmount: bigint
}
/** A swap price; nothing is signed. */
export type SwapQuote = Omit<SwapResult, 'hash'>

/**
 * The older same-chain swap interface. Every swap2 module implements it too; new code should use
 * {@link ISwap2Protocol}.
 */
export interface ISwapProtocol {
  /** Sign and broadcast a same-chain swap. */
  swap(options: SwapOptions): Promise<SwapResult>
  /** Price a same-chain swap; nothing is signed. */
  quoteSwap(options: SwapOptions): Promise<SwapQuote>
}

/** Base class for swap-only modules. */
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
