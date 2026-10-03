// Base class: every method throws NotImplementedError so a module that forgets
// one fails loudly, never with `undefined is not a function`.
import type { IWalletAccount, IWalletAccountReadOnly } from '../account.js'
import { NotImplementedError } from '../errors.js'
import { ProtocolBase } from './base.js'

export interface BridgeProtocolConfig {
  /** Maximum fee for bridge operations, in native base units. */
  bridgeMaxFee?: bigint | number
}

export interface BridgeOptions {
  /** Destination chain identifier (provider specific, e.g. "arbitrum" or a CAIP-2 id). */
  targetChain: string
  recipient: string
  token: string
  amount: bigint | number
}

export interface BridgeResult {
  hash: string
  /** Gas cost. */
  fee: bigint
  /** Native tokens paid to the bridge protocol. */
  bridgeFee: bigint
}
export type BridgeQuote = Omit<BridgeResult, 'hash'>

export interface IBridgeProtocol {
  bridge(options: BridgeOptions): Promise<BridgeResult>
  quoteBridge(options: BridgeOptions): Promise<BridgeQuote>
}

export class BridgeProtocol<TConfig extends BridgeProtocolConfig = BridgeProtocolConfig>
  extends ProtocolBase<TConfig>
  implements IBridgeProtocol
{
  constructor(account: IWalletAccountReadOnly | IWalletAccount, config: TConfig = {} as TConfig) {
    super(account, config)
  }
  async bridge(_options: BridgeOptions): Promise<BridgeResult> { throw new NotImplementedError('bridge(options)') }
  async quoteBridge(_options: BridgeOptions): Promise<BridgeQuote> { throw new NotImplementedError('quoteBridge(options)') }
}
