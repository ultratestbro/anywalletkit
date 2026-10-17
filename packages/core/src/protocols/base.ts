import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { canSign } from '../account.js'
import { ReadOnlyAccountError } from '../errors.js'
import type { ActivityItem, ChainTx, DescribeActivityContext } from '../history.js'

/** Shared plumbing for protocol base classes: holds the account and config, guards writes. */
export abstract class ProtocolBase<TConfig extends object = Record<string, never>> {
  protected readonly _account: IWalletAccountReadOnly | IWalletAccount
  protected readonly _config: TConfig

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: TConfig) {
    this._account = account
    this._config = config
  }

  /**
   * Recognize one of this protocol's own transactions in an address's history and
   * describe it for the wallet's activity feed ("Supplied 100 USDC · Aave v3").
   * Return `null` when the transaction is not this protocol's: the kit then asks the
   * next module and finally falls back to send / receive / approve / contract call.
   * Must be pure and synchronous: no network, no account state. The conformance
   * suite feeds every module its recorded fixtures through this method.
   */
  describeActivity(_tx: ChainTx, _ctx: DescribeActivityContext): ActivityItem | null {
    return null
  }

  /** The account, narrowed to a signing one, or a ReadOnlyAccountError naming the caller. */
  protected requireSigningAccount(methodName: string): IWalletAccount {
    if (!canSign(this._account)) throw new ReadOnlyAccountError(methodName)
    return this._account
  }
}
