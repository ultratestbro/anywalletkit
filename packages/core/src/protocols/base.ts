import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { canSign } from '../account.js'
import { ReadOnlyAccountError } from '../errors.js'

/** Shared plumbing for protocol base classes: holds the account and config, guards writes. */
export abstract class ProtocolBase<TConfig extends object = Record<string, never>> {
  protected readonly _account: IWalletAccountReadOnly | IWalletAccount
  protected readonly _config: TConfig

  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: TConfig) {
    this._account = account
    this._config = config
  }

  /** The account, narrowed to a signing one, or a ReadOnlyAccountError naming the caller. */
  protected requireSigningAccount(methodName: string): IWalletAccount {
    if (!canSign(this._account)) throw new ReadOnlyAccountError(methodName)
    return this._account
  }
}
