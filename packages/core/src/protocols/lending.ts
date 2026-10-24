// Base class: every method throws NotImplementedError so a module that forgets
// one fails loudly, never with `undefined is not a function`.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'

/** Supply `amount` of `token` (base units) to the market; `onBehalfOf` credits another address. */
export interface SupplyOptions { token: string; amount: bigint | number; onBehalfOf?: string }
/** Withdraw `amount` of `token` (base units); `to` sends it to another address. */
export interface WithdrawOptions { token: string; amount: bigint | number; to?: string }
/** Borrow `amount` of `token` (base units) against supplied collateral. */
export interface BorrowOptions { token: string; amount: bigint | number; onBehalfOf?: string }
/** Repay `amount` of `token` (base units) of a borrow. */
export interface RepayOptions { token: string; amount: bigint | number; onBehalfOf?: string }
/** Every lending write returns the hash and the gas cost. */
export interface LendingResult { hash: string; fee: bigint }
/** The network fee a lending write would pay; nothing is signed. */
export type LendingQuote = Omit<LendingResult, 'hash'>

/**
 * The lending interface every lending and vault module implements. Vault modules (Morpho vaults,
 * Mellow, Kamino Earn) support `supply` and `withdraw`; borrowing exists where the market allows
 * it, otherwise it throws.
 */
export interface ILendingProtocol {
  /** Deposit into the market or vault. Sends an approval first when needed. */
  supply(options: SupplyOptions): Promise<LendingResult>
  /** Network fee of `supply`. */
  quoteSupply(options: SupplyOptions): Promise<LendingQuote>
  /** Withdraw a deposit. */
  withdraw(options: WithdrawOptions): Promise<LendingResult>
  /** Network fee of `withdraw`. */
  quoteWithdraw(options: WithdrawOptions): Promise<LendingQuote>
  /** Borrow against collateral. */
  borrow(options: BorrowOptions): Promise<LendingResult>
  /** Network fee of `borrow`. */
  quoteBorrow(options: BorrowOptions): Promise<LendingQuote>
  /** Repay a borrow. */
  repay(options: RepayOptions): Promise<LendingResult>
  /** Network fee of `repay`. */
  quoteRepay(options: RepayOptions): Promise<LendingQuote>
}

/**
 * Base class for lending modules: holds the account and config, and throws `NotImplementedError`
 * for every method a module leaves out.
 */
export class LendingProtocol<TConfig extends object = Record<string, never>>
  extends ProtocolBase<TConfig>
  implements ILendingProtocol
{
  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: TConfig = {} as TConfig) {
    super(account, config)
  }
  async supply(_o: SupplyOptions): Promise<LendingResult> { throw new NotImplementedError('supply(options)') }
  async quoteSupply(_o: SupplyOptions): Promise<LendingQuote> { throw new NotImplementedError('quoteSupply(options)') }
  async withdraw(_o: WithdrawOptions): Promise<LendingResult> { throw new NotImplementedError('withdraw(options)') }
  async quoteWithdraw(_o: WithdrawOptions): Promise<LendingQuote> { throw new NotImplementedError('quoteWithdraw(options)') }
  async borrow(_o: BorrowOptions): Promise<LendingResult> { throw new NotImplementedError('borrow(options)') }
  async quoteBorrow(_o: BorrowOptions): Promise<LendingQuote> { throw new NotImplementedError('quoteBorrow(options)') }
  async repay(_o: RepayOptions): Promise<LendingResult> { throw new NotImplementedError('repay(options)') }
  async quoteRepay(_o: RepayOptions): Promise<LendingQuote> { throw new NotImplementedError('quoteRepay(options)') }
}
