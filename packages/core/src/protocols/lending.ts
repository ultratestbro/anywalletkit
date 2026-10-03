// Base class: every method throws NotImplementedError so a module that forgets
// one fails loudly, never with `undefined is not a function`.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'

export interface SupplyOptions { token: string; amount: bigint | number; onBehalfOf?: string }
export interface WithdrawOptions { token: string; amount: bigint | number; to?: string }
export interface BorrowOptions { token: string; amount: bigint | number; onBehalfOf?: string }
export interface RepayOptions { token: string; amount: bigint | number; onBehalfOf?: string }
/** Every lending write returns the hash and the gas cost. */
export interface LendingResult { hash: string; fee: bigint }
export type LendingQuote = Omit<LendingResult, 'hash'>

export interface ILendingProtocol {
  supply(options: SupplyOptions): Promise<LendingResult>
  quoteSupply(options: SupplyOptions): Promise<LendingQuote>
  withdraw(options: WithdrawOptions): Promise<LendingResult>
  quoteWithdraw(options: WithdrawOptions): Promise<LendingQuote>
  borrow(options: BorrowOptions): Promise<LendingResult>
  quoteBorrow(options: BorrowOptions): Promise<LendingQuote>
  repay(options: RepayOptions): Promise<LendingResult>
  quoteRepay(options: RepayOptions): Promise<LendingQuote>
}

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
