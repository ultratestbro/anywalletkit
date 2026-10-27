import type { IWalletAccount, IWalletAccountReadOnly } from '@anywalletkit/core'

/** A protocol module class the suites construct over a mock account (read-only or signing) and an optional config. */
export type ProtocolCtor<P> = new (account: IWalletAccountReadOnly | IWalletAccount, config?: any) => P
/** A protocol module class the behaviour suite drives through writes: constructed over a signing account. */
export type WriteProtocolCtor<P> = new (account: IWalletAccount, config?: any) => P
